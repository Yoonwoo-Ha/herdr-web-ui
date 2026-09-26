/**
 * The browser demo's stand-in for the server. Loaded before the app on the demo page, it answers
 * `fetch("/api/…")`, `new EventSource("/api/machines/events")` and `new WebSocket("…/ws")` from
 * fixtures (site/demo/fixtures/, captured by scripts/demo-fixtures.ts from the staged fictional
 * session) instead of the network. The app's own code is unchanged: it believes it talks to a
 * herdr web ui server on a PC called "workstation".
 *
 * What works: the sidebar and its live statuses, every chat, the Codex approval card (answering it
 * sets Codex to work and ends the turn), the command palette, settings, and the terminal: the shell
 * pane replays a recording of `git log` and `bun test`, then a small pretend shell answers what you
 * type; agent panes show one notice instead of a TUI. A message sent from a chat gets a demo answer.
 * What does not: files, images, push and remote PCs, which need a real machine.
 */
import type { AgentStatus, ConversationTurn, Machine, MachineEvent, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import { CHATS, PROMPT, SPECS } from "./fixtures.ts";
import machinesFixture from "./fixtures/machines.json";
import agentsFixture from "./fixtures/agents.json";
import commandsFixture from "./fixtures/commands.json";
import panesFixture from "./fixtures/panes.json";
import terminalFixture from "./fixtures/terminal.json";

const DEMO_VERSION = "demo";
const PROMPT_ANSWER_TURN_MS = 2600;
const CHAT_ANSWER_MS = 2400;
/** the recording's gaps, capped so the replay stays brisk */
const MAX_FRAME_GAP_MS = 500;

type Pane = SessionSnapshot["panes"][number];
type SseListener = (event: MessageEvent) => void;

// ---- state -----------------------------------------------------------------------------------

const machines: Machine[] = structuredClone(machinesFixture.machines as Machine[]);
const local = machines[0]!;
const snapshot = (): SessionSnapshot => local.snapshot!;
/** pane id -> fixture key ("api", "web", …) */
const keyOfPane = new Map<string, string>(Object.entries(panesFixture as Record<string, string>).map(([key, paneId]) => [paneId, key]));
const chats = new Map<string, { turns: ConversationTurn[]; metadata: { model: string; reasoning_effort: string } }>(
  Object.entries(CHATS).map(([key, chat]) => [key, structuredClone(chat)]),
);
// The fixtures' clocks say September 25th; the demo happens now. Every timestamp moves by the same
// amount, so "Worked for" stays what it was and the newest turn ended three minutes ago.
{
  const stamps = [...chats.values()].flatMap((chat) => chat.turns.flatMap((turn) => [turn.ts, turn.end_ts].filter((v): v is string => typeof v === "string")));
  const newest = Math.max(...stamps.map((v) => Date.parse(v)));
  const shift = Date.now() - 3 * 60_000 - newest;
  for (const chat of chats.values()) for (const turn of chat.turns) {
    if (turn.ts) turn.ts = new Date(Date.parse(turn.ts) + shift).toISOString();
    if (turn.end_ts) turn.end_ts = new Date(Date.parse(turn.end_ts) + shift).toISOString();
  }
}
let promptOpen = true;
let promptId = PROMPT.id;
let nextWorkspace = 100;

const sseListeners = new Set<SseListener>();
const sockets = new Set<DemoSocket>();

function emitSse(event: MachineEvent): void {
  const message = new MessageEvent("message", { data: JSON.stringify(event) });
  for (const listener of sseListeners) listener(message);
}

function paneOf(paneId: string): Pane | undefined {
  return snapshot().panes.find((pane) => pane.pane_id === paneId);
}

function setStatus(paneId: string, status: AgentStatus): void {
  const pane = paneOf(paneId);
  if (!pane) return;
  pane.agent_status = status;
  for (const workspace of snapshot().workspaces) if (workspace.workspace_id === pane.workspace_id) workspace.agent_status = status;
  for (const tab of snapshot().tabs) if (tab.tab_id === pane.tab_id) tab.agent_status = status;
  emitSse({ type: "machine-message", machine_id: local.id, message: { type: "pane-status", pane_id: paneId, agent_status: status } });
  for (const socket of sockets) socket.push({ type: "pane-status", pane_id: paneId, agent_status: status });
}

function structureChanged(): void {
  emitSse({ type: "machines", machines });
  emitSse({ type: "machine-message", machine_id: local.id, message: { type: "session-changed" } });
  for (const socket of sockets) socket.push({ type: "session-changed" });
}

function agentOf(paneId: string): string {
  const key = keyOfPane.get(paneId);
  return SPECS.find((spec) => spec.key === key)?.agent ?? paneOf(paneId)?.agent ?? "the agent";
}

const now = () => new Date().toISOString();

/** A message sent from a chat: the user's turn now, the demo's answer a moment later. */
function submitToChat(paneId: string, text: string): void {
  const key = keyOfPane.get(paneId);
  const chat = key ? chats.get(key) : undefined;
  if (!chat) return;
  chat.turns.push({ role: "user", ts: now(), parts: [{ kind: "text", text }] });
  setStatus(paneId, "working");
  const agent = agentOf(paneId);
  setTimeout(() => {
    chat.turns.push({ role: "assistant", ts: now(), end_ts: now(), parts: [{ kind: "text", text: `This is the demo, so nothing ran. In the real app that message went to ${agent} in this pane, and its answer would be written here as it arrives, with its commands and edits folded above it.` }] });
    setStatus(paneId, "done");
  }, CHAT_ANSWER_MS);
}

function answerPrompt(paneId: string, optionIndex: number | undefined): void {
  promptOpen = false;
  setStatus(paneId, "working");
  const chat = chats.get("web");
  const declined = optionIndex === 2;
  setTimeout(() => {
    chat?.turns.push({
      role: "assistant", ts: now(), end_ts: now(),
      parts: declined
        ? [{ kind: "text", text: "Understood, I won't push. The changes stay on `feat/export-guard` locally; tell me what to do differently." }]
        : [{ kind: "tool", name: "exec", summary: "git push origin feat/export-guard", input: JSON.stringify({ cmd: "git push origin feat/export-guard" }, null, 2), output: "To github.com:acme/web-dashboard.git\n * [new branch]      feat/export-guard -> feat/export-guard" },
          { kind: "text", text: "Pushed `feat/export-guard`. The export button is guarded and the branch is ready for a pull request." }],
    });
    setStatus(paneId, "done");
  }, PROMPT_ANSWER_TURN_MS);
}

// ---- HTTP -------------------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const error = (code: string, message: string, status: number) => json({ error: { code, message } }, status);

async function bodyOf(init: RequestInit | undefined, input: RequestInfo | URL): Promise<Record<string, unknown>> {
  try {
    if (init?.body) return JSON.parse(String(init.body)) as Record<string, unknown>;
    if (input instanceof Request) return (await input.clone().json()) as Record<string, unknown>;
  } catch { /* not JSON */ }
  return {};
}

const DEMO_FILES = ["src/routes/payments.ts", "src/lib/idempotency.ts", "src/metrics.ts", "src/pages/Reports.tsx", "src/money.ts", "src/money.test.ts", "package.json", "README.md"];

async function route(url: URL, method: string, init: RequestInit | undefined, input: RequestInfo | URL): Promise<Response> {
  const path = url.pathname;
  const query = url.searchParams;
  const paneId = query.get("pane_id") ?? "";

  if (path === "/api/health") {
    const auth = { required: false, authenticated: true };
    if (query.get("scope") === "bridge") return json({ ok: true, auth, bridge_protocol: 1 });
    return json({ ok: true, herdr: { version: "0.9.0", protocol: 22 }, auth, web_ui: { boot_id: DEMO_VERSION, revision: null } });
  }
  if (path === "/api/machines") return json({ machines });
  if (path === "/api/session") return json({ snapshot: snapshot() });
  if (path === "/api/agents") return json(agentsFixture);
  if (path === "/api/updates") return json({ managed: false, auto_update: false, phase: "idle", current_revision: null, latest_revision: null, current_version: __APP_VERSION__, latest_version: null, available: false, checked_at: null, blocked_reason: null, error: null }, 200, { "cache-control": "no-store" });
  if (path === "/api/access") return json({ port: 7317, tailscale: { state: "running", dns_name: "workstation.example.ts.net", serving_url: "https://workstation.example.ts.net", serve_command: null, serve_url: null } });
  if (path === "/api/push" || path.startsWith("/api/push/")) return error("push_unavailable", "the demo sends no alerts", 404);
  if (path === "/api/machines/settings") return json({ auto_update_bridges: true });
  if (path.startsWith("/api/machines/")) return error("demo", "remote PCs need a real machine", 404);

  if (path === "/api/pane/conversation") {
    const key = keyOfPane.get(paneId);
    const chat = key ? chats.get(key) : undefined;
    const agent = agentOf(paneId);
    if (!chat) return json({ source: "scrollback", turns: [] });
    const source = agent === "claude" ? "claude-transcript" : agent === "codex" ? "codex-transcript" : agent === "gjc" ? "gjc-transcript" : agent === "omo" ? "omo-transcript" : "omp-transcript";
    return json({ source, turns: chat.turns, metadata: chat.metadata, cursor: null });
  }
  if (path === "/api/pane/prompt") return json({ prompt: keyOfPane.get(paneId) === "web" && promptOpen ? { ...PROMPT, id: promptId } : null });
  if (path === "/api/pane/prompt/answer") {
    const body = await bodyOf(init, input);
    const target = String(body["pane_id"] ?? "");
    if (keyOfPane.get(target) !== "web" || !promptOpen || body["prompt_id"] !== promptId) return error("prompt_changed", "the screen no longer shows that prompt", 409);
    answerPrompt(target, typeof body["option_index"] === "number" ? body["option_index"] : undefined);
    return json({ ok: true });
  }
  if (path === "/api/pane/commands") return json(commandsFixture);
  if (path === "/api/pane/files") {
    const q = (query.get("q") ?? "").toLowerCase();
    return json({ files: DEMO_FILES.filter((file) => file.toLowerCase().includes(q)).slice(0, Number(query.get("limit") ?? 20)) });
  }
  if (path === "/api/pane/input" || path === "/api/pane/keys") return json({ ok: true });
  if (path === "/api/pane/rename") {
    const body = await bodyOf(init, input);
    const pane = paneOf(String(body["pane_id"] ?? ""));
    if (!pane) return error("not_found", "no such pane", 404);
    pane.label = String(body["label"] ?? "") || null;
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/pane/close" || path === "/api/workspace/close") {
    const body = await bodyOf(init, input);
    const pane = path === "/api/pane/close" ? paneOf(String(body["pane_id"] ?? "")) : snapshot().panes.find((p) => p.workspace_id === body["workspace_id"]);
    if (!pane) return error("not_found", "no such pane", 404);
    const snap = snapshot();
    snap.panes = snap.panes.filter((p) => p.workspace_id !== pane.workspace_id);
    snap.tabs = snap.tabs.filter((t) => t.workspace_id !== pane.workspace_id);
    snap.workspaces = snap.workspaces.filter((w) => w.workspace_id !== pane.workspace_id);
    snap.layouts = snap.layouts.filter((l) => (l as { workspace_id?: string }).workspace_id !== pane.workspace_id);
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/workspace/rename") {
    const body = await bodyOf(init, input);
    const workspace = snapshot().workspaces.find((w) => w.workspace_id === body["workspace_id"]);
    if (!workspace) return error("not_found", "no such workspace", 404);
    workspace.label = String(body["label"] ?? "");
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/workspace/move") {
    const body = await bodyOf(init, input);
    const snap = snapshot();
    const index = snap.workspaces.findIndex((w) => w.workspace_id === body["workspace_id"]);
    if (index < 0) return error("not_found", "no such workspace", 404);
    const [workspace] = snap.workspaces.splice(index, 1);
    snap.workspaces.splice(Math.max(0, Math.min(snap.workspaces.length, Number(body["insert_index"] ?? 0))), 0, workspace!);
    snap.workspaces.forEach((w, i) => { w.number = i + 1; });
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/workspace/directories") {
    const dir = query.get("path") || "/home/demo";
    return json({ path: dir, parent: dir === "/" ? null : dir.replace(/\/[^/]*$/, "") || "/", home: "/home/demo", directories: dir === "/home/demo" ? ["checkout-api", "docs-site", "infra", "release", "web-dashboard"] : [], truncated: false, files: [] });
  }
  if (path === "/api/workspace/create") {
    const body = await bodyOf(init, input);
    const agent = (body["agent"] as { kind?: string } | null | undefined)?.kind ?? null;
    const cwd = String(body["cwd"] ?? "/home/demo/new-project");
    const id = `w${(nextWorkspace++).toString(36)}`;
    const snap = snapshot();
    const template = snap.panes[0]!;
    const label = String(body["label"] ?? "") || cwd.split("/").pop() || "new";
    const pane: Pane = { ...structuredClone(template), pane_id: `${id}:p1`, tab_id: `${id}:t1`, terminal_id: `${id}:term`, workspace_id: id, label: null, title: null, agent, agent_session: null, agent_status: agent ? "working" : "unknown", cwd, foreground_cwd: cwd, focused: false, terminal_title: null, terminal_title_stripped: null, revision: 1 };
    snap.panes.push(pane);
    snap.tabs.push({ ...structuredClone(snap.tabs[0]!), tab_id: `${id}:t1`, workspace_id: id, label, number: 1, agent_status: pane.agent_status, focused: false, pane_count: 1 });
    snap.workspaces.push({ ...structuredClone(snap.workspaces[0]!), workspace_id: id, label, number: snap.workspaces.length + 1, active_tab_id: `${id}:t1`, agent_status: pane.agent_status, focused: false, pane_count: 1, tab_count: 1 });
    if (agent) {
      keyOfPane.set(pane.pane_id, pane.pane_id);
      chats.set(pane.pane_id, { turns: [], metadata: { model: agent === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", reasoning_effort: "medium" } });
      setTimeout(() => setStatus(pane.pane_id, "idle"), 1500);
    }
    structureChanged();
    return json({ workspace: snap.workspaces[snap.workspaces.length - 1], root_pane: pane, tab: snap.tabs[snap.tabs.length - 1] });
  }
  if (path.startsWith("/api/fs/")) return error("not_found", "the demo has no files to open", 404);
  return error("demo", `${method} ${path} is not part of the demo`, 404);
}

const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return route(url, method.toUpperCase(), init, input);
}) as typeof window.fetch;

// ---- SSE --------------------------------------------------------------------------------------

const RealEventSource = window.EventSource;
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly url: string;
  readyState = 1;
  onmessage: SseListener | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listener: SseListener = (event) => { this.onmessage?.(event); this.dispatchEvent(new MessageEvent("message", { data: event.data })); };
  constructor(url: string) {
    super();
    this.url = url;
    sseListeners.add(this.listener);
    setTimeout(() => { this.onopen?.(new Event("open")); this.listener(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines } satisfies MachineEvent) })); }, 30);
  }
  close(): void { this.readyState = 2; sseListeners.delete(this.listener); }
}
window.EventSource = function (url: string | URL, init?: EventSourceInit) {
  const target = new URL(String(url), location.href);
  return target.pathname === "/api/machines/events" ? (new DemoEventSource(target.href) as unknown as EventSource) : new RealEventSource(url, init);
} as unknown as typeof EventSource;

// ---- WebSocket: terminals ----------------------------------------------------------------------

const PROMPT_TEXT = "\x1b[38;5;214mrelease\x1b[0m $ ";
const NOTICE_LINES = [
  "This is the demo.",
  "",
  "In the real app this view is the agent's own TUI,",
  "live through herdr terminal attach and shared with",
  "the herdr TUI on the PC. Switch back to Chat above.",
];
const NOTICE = (() => {
  const width = Math.max(...NOTICE_LINES.map((line) => line.length)) + 4;
  const amber = (text: string) => `\x1b[38;5;214m${text}\x1b[0m`;
  const rows = NOTICE_LINES.map((line) => `${amber("│")}  ${line.padEnd(width - 4)}  ${amber("│")}`);
  return ["\x1b[2J\x1b[H", amber(`┌${"─".repeat(width)}┐`), ...rows, amber(`└${"─".repeat(width)}┘`)].join("\r\n") + "\r\n";
})();

/** what the pretend shell answers; anything else is "command not found" */
const SHELL_COMMANDS: Record<string, string> = {
  "git status": "On branch main\r\nnothing to commit, working tree clean",
  "git log": "\x1b[33m*\x1b[0m \x1b[33mchore(release): 1.4.0 (HEAD -> main, tag: v1.4.0)\x1b[0m\r\n*   Merge branch feat/idempotency\r\n|\\  \r\n| * test(payments): concurrent retries\r\n| * feat(payments): replay the first response for a repeated key\r\n|/  \r\n* test: cover money helpers\r\n* feat: money helpers",
  "ls": "src  package.json",
  "ls src": "money.ts  money.test.ts",
  "bun test": "\x1b[1mbun test\x1b[0m v1.4.2\r\n\r\nsrc/money.test.ts:\r\n\x1b[32m✓\x1b[0m parses amounts to cents\r\n\x1b[32m✓\x1b[0m rounds half a cent\r\n\x1b[32m✓\x1b[0m formats cents\r\n\x1b[32m✓\x1b[0m formats zero\r\n\r\n\x1b[32m 4 pass\x1b[0m\r\n 0 fail\r\nRan 4 tests across 1 file. [28.00ms]",
  "pwd": "/tmp/herdr-demo/release",
  "whoami": "demo",
  "cat src/money.ts": "export const cents = (amount: string): number => Math.round(Number(amount) * 100);\r\nexport const format = (cents: number): string => (cents / 100).toFixed(2);",
};

class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly url: string;
  readyState = 0;
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly attached = new Set<string>();
  /** the pretend shell's current line, per shell pane */
  private readonly lines = new Map<string, string>();

  constructor(url: string) {
    super();
    this.url = url;
    sockets.add(this);
    // opens on its own tick, like a real socket; `later` guards on OPEN, so not through it
    const opening = setTimeout(() => {
      this.timers.delete(opening);
      if (this.readyState !== 0) return;
      this.readyState = 1;
      const open = new Event("open");
      this.onopen?.(open);
      this.dispatchEvent(open);
      this.push({ type: "snapshot", snapshot: snapshot(), features: ["submit"] });
    }, 20);
    this.timers.add(opening);
  }

  /** runs `fn` unless the socket closed first */
  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.readyState === 1) fn(); }, ms);
    this.timers.add(timer);
  }

  push(message: ServerMessage): void {
    if (this.readyState !== 1) return;
    const event = new MessageEvent("message", { data: JSON.stringify(message) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  send(raw: string): void {
    let message: { type: string; pane_id?: string; text?: string; keys?: string[]; id?: number; mode?: string };
    try { message = JSON.parse(raw); } catch { return; }
    switch (message.type) {
      case "role": this.push({ type: "role-ack", mode: message.mode === "observe" ? "observe" : "interact" }); break;
      case "attach": if (message.pane_id) this.attach(message.pane_id); break;
      case "detach": if (message.pane_id) this.attached.delete(message.pane_id); break;
      case "input": if (message.pane_id && message.text !== undefined) this.typed(message.pane_id, message.text); break;
      case "keys": if (message.pane_id) for (const key of message.keys ?? []) this.typed(message.pane_id, key === "Enter" ? "\r" : key === "Backspace" ? "\x7f" : key.length === 1 ? key : ""); break;
      case "submit":
        if (message.pane_id && message.text !== undefined && message.id !== undefined) {
          submitToChat(message.pane_id, message.text);
          this.push({ type: "submit-result", id: message.id, pane_id: message.pane_id, ok: true });
        }
        break;
      default: /* resize, pty-ack: nothing to do in the demo */
    }
  }

  private attach(paneId: string): void {
    this.attached.add(paneId);
    const key = keyOfPane.get(paneId);
    const pane = paneOf(paneId);
    if (key === "shell") {
      let at = 0;
      let previous = 0;
      for (const frame of terminalFixture.frames) {
        at += Math.min(MAX_FRAME_GAP_MS, frame.at - previous);
        previous = frame.at;
        this.later(() => { if (this.attached.has(paneId)) this.push({ type: "pty-data", pane_id: paneId, data: frame.data }); }, at);
      }
      return;
    }
    if (pane && !pane.agent && !chats.has(paneId)) {
      // a shell the demo user started: an empty prompt
      this.later(() => this.push({ type: "pty-data", pane_id: paneId, data: "\x1b[2J\x1b[H" + PROMPT_TEXT }), 60);
      return;
    }
    this.later(() => this.push({ type: "pty-data", pane_id: paneId, data: NOTICE }), 60);
  }

  /** the pretend shell: echo, backspace, and a few commands it knows */
  private typed(paneId: string, text: string): void {
    const pane = paneOf(paneId);
    if (!pane || pane.agent || chats.has(paneId)) return;
    let line = this.lines.get(paneId) ?? "";
    let out = "";
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        const command = line.trim();
        line = "";
        out += "\r\n";
        if (command) out += (SHELL_COMMANDS[command] ?? SHELL_COMMANDS[command.replace(/\s+--.*$/, "")] ?? (command.startsWith("git log") ? SHELL_COMMANDS["git log"] : `bash: ${command.split(" ")[0]}: command not found`)) + "\r\n";
        out += PROMPT_TEXT;
      } else if (ch === "\x7f" || ch === "\b") {
        if (line.length > 0) { line = line.slice(0, -1); out += "\b \b"; }
      } else if (ch === "\x03") {
        line = ""; out += "^C\r\n" + PROMPT_TEXT;
      } else if (ch >= " ") {
        line += ch; out += ch;
      }
    }
    this.lines.set(paneId, line);
    if (out) this.push({ type: "pty-data", pane_id: paneId, data: out });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    for (const timer of this.timers) clearTimeout(timer);
    sockets.delete(this);
    const event = new CloseEvent("close", { code, reason, wasClean: true });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }
}

const RealWebSocket = window.WebSocket;
window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
  const target = new URL(String(url), location.href);
  return target.pathname === "/ws" ? (new DemoSocket(target.href) as unknown as WebSocket) : new RealWebSocket(url, protocols);
} as unknown as typeof WebSocket;
for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(window.WebSocket, name, { value: RealWebSocket[name] });

// ---- the turn in progress ----------------------------------------------------------------------

// The Claude pane is mid-turn when the demo opens (RUN); a few seconds later the metric lands and
// the turn ends, so the first thing a visitor sees move is a status, the way it does for real.
setTimeout(() => {
  const chat = chats.get("api");
  const paneId = panesFixture.api;
  const turn = chat?.turns[chat.turns.length - 1];
  if (!chat || !turn || turn.role !== "assistant") return;
  turn.parts.push(
    { kind: "tool", name: "Bash", summary: "bun test metrics", input: JSON.stringify({ command: "bun test metrics" }, null, 2), output: " 6 pass\n 0 fail\nRan 6 tests across 1 file. [201ms]" },
    { kind: "text", text: "Added `payments_idempotent_replays_total`, incremented where a stored response is replayed, and exposed with the other counters on `/metrics`. 6 tests pass." },
  );
  turn.end_ts = now();
  setStatus(paneId, "done");
}, 4500);

// ---- what the demo opens first ------------------------------------------------------------------

// On a desktop the app opens a pane in its terminal, where the demo has only a notice: agent
// panes open in the chat here unless this browser already chose (the same key the app writes).
for (const pane of snapshot().panes) {
  if (!pane.agent) continue;
  const key = `herdr-web-ui:view:${pane.pane_id}`;
  try { if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, "chat"); } catch { /* storage blocked: the app falls back to its default */ }
}

// ---- browser features the demo cannot honour --------------------------------------------------

// no service worker: the page would otherwise register /sw.js of the site's origin, which is not there
if ("serviceWorker" in navigator) {
  Object.defineProperty(navigator.serviceWorker, "register", { value: () => new Promise(() => {}) });
}
// no push: the bell then says alerts are unsupported here instead of failing to subscribe
Object.defineProperty(globalThis, "PushManager", { value: undefined, configurable: true });

declare const __APP_VERSION__: string;
