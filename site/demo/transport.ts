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
import type { AgentStatus, ConversationTurn, Machine, MachineEvent, PendingMessage, ServerMessage, SessionSnapshot, UsageReport, WorkspaceCreated, WorkspaceInfo, WorktreeEntry, WorktreeListing, WorktreeOpened, WorktreeRemoved } from "../../shared/protocol.ts";
import { VOICE_DEFAULTS, type VoiceStatus } from "../../shared/voice.ts";
import { rollupStatus } from "../../src/lib/status.ts";
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
let nextPending = 1;
const replying = new Set(snapshot().panes.filter((pane) => pane.agent && pane.agent_status === "working").map((pane) => pane.pane_id));
/** herdr's state_change_seq: one counter per session, bumped on every agent state change */
let stateSeq = Math.max(0, ...(local.snapshot?.agents ?? []).map((agent) => agent.state_change_seq ?? 0));
const nextStateSeq = (): number => ++stateSeq;
/** herdr lists an agent pane under `agents` too, with the counter the sidebar's Activity order reads */
function addAgent(pane: Pane): void {
  const snap = snapshot();
  const template = snap.agents[0];
  if (!pane.agent || !template || snap.agents.some((agent) => agent.pane_id === pane.pane_id)) return;
  snap.agents.push({ ...structuredClone(template), pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id,
    agent: pane.agent, agent_status: pane.agent_status, cwd: pane.cwd, foreground_cwd: pane.foreground_cwd, state_change_seq: nextStateSeq() });
}

/** The OmO pane's background tasks (the composer's "2 background tasks"), timed from now. */
const OMO_TASKS_PANE = "docs";
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const omoTasks = () => [
  { id: "st_demo1", title: "Check every link in the guide", category: "quick", model: "Claude Haiku 4.5", status: "running", started_at: ago(3), ended_at: null, turns: 6, tool_calls: 41, tokens: 52_300 },
  { id: "st_demo2", title: "Rewrite the install section for Windows", category: "writing", model: "Claude Opus 5.5", status: "running", started_at: ago(1), ended_at: null, turns: 2, tool_calls: 7, tokens: 18_900 },
  { id: "st_demo3", title: "Find pages that still say v0.2", category: "quick", model: "Claude Haiku 4.5", status: "completed", started_at: ago(26), ended_at: ago(22), turns: 9, tool_calls: 33, tokens: 61_200 },
  { id: "st_demo4", title: "Translate the FAQ to Korean", category: "writing", model: "GPT-6.1", status: "failed", started_at: ago(48), ended_at: ago(44), turns: 3, tool_calls: 5, tokens: 12_000 },
];
const step = (id: string, state: string, error: string | null = null) => ({ id, label: id, state, error });
const omoRuns = () => [
  { id: "dag_demo1", name: "Guide release check", status: "running", started_at: ago(6), ended_at: null, waves: [
    [step("find stale pages", "completed"), step("check links", "running"), step("rewrite install", "running")],
    [step("proofread", "pending")],
    [step("open PR", "pending")],
  ] },
  { id: "dag_demo2", name: "FAQ translations", status: "failed", started_at: ago(50), ended_at: ago(43), waves: [
    [step("ko", "failed", "the glossary file was missing"), step("ja", "completed")],
    [step("review", "skipped")],
  ] },
];

/**
 * A pane the fixtures predate. `fixtures/panes.json` and `fixtures/machines.json` are recorded
 * together by `bun scripts/demo-fixtures.ts`, which drives a live herdr and renumbers every pane,
 * so a fixture is rarely re-cut for one pane's sake. A SPECS entry with no recorded pane gets one
 * here instead, which keeps adding an agent to the demo to a change in `fixtures.ts` alone. Panes
 * the fixtures do record are left exactly as they were recorded.
 */
function backfillPanes(): void {
  const snap = snapshot();
  const recorded = new Set<string>(keyOfPane.values());
  const template = snap.workspaces[0];
  const paneTemplate = snap.panes[0];
  if (!template || !paneTemplate) return;
  for (const spec of SPECS) {
    if (recorded.has(spec.key)) continue;
    const id = `w${(nextWorkspace++).toString(36)}`;
    const pane: Pane = { ...structuredClone(paneTemplate), pane_id: `${id}:p1`, tab_id: `${id}:t1`, terminal_id: `${id}:term`, workspace_id: id, label: spec.title, title: spec.title, agent: spec.agent, agent_status: spec.agent ? spec.state ?? "idle" : "unknown", cwd: `/home/demo/${spec.label}`, foreground_cwd: `/home/demo/${spec.label}` };
    snap.panes.push(pane);
    addAgent(pane);
    snap.tabs.push({ ...structuredClone(snap.tabs[0]!), tab_id: `${id}:t1`, workspace_id: id, label: spec.label, number: 1, agent_status: pane.agent_status, focused: false, pane_count: 1 });
    snap.workspaces.push({ ...structuredClone(template), workspace_id: id, label: spec.label, number: snap.workspaces.length + 1, active_tab_id: `${id}:t1`, agent_status: pane.agent_status, focused: false, pane_count: 1, tab_count: 1 });
    keyOfPane.set(pane.pane_id, spec.key);
  }
  // the fixture's own order is kept; a backfilled pane joins at the end of the list
  snap.workspaces.forEach((workspace, index) => { workspace.number = index + 1; });
}
backfillPanes();
for (const pane of snapshot().panes) if (keyOfPane.get(pane.pane_id) === OMO_TASKS_PANE) Object.assign(pane, { background_tasks: 2 });

// Fictional repositories keep their checkout catalog after a workspace closes. The list joins
// each checkout to the current snapshot, so closed checkouts can be opened again without git.
interface DemoRepository {
  repoKey: string;
  repoName: string;
  repoRoot: string;
  branches: Set<string>;
  checkouts: Array<Omit<WorktreeEntry, "open_workspace_id">>;
}
const repositories = new Map<string, DemoRepository>();
function repositoryAt(path: string): DemoRepository {
  const repoKey = `demo:${path}`;
  let repo = repositories.get(repoKey);
  if (!repo) {
    repo = { repoKey, repoName: path.split("/").filter(Boolean).pop() ?? "project", repoRoot: path, branches: new Set(["main"]), checkouts: [{ path, branch: "main", label: "main", is_linked_worktree: false, is_bare: false, is_detached: false, is_prunable: false }] };
    repositories.set(repoKey, repo);
  }
  return repo;
}
function worktreeMetadata(repo: DemoRepository, path = repo.repoRoot): NonNullable<WorkspaceInfo["worktree"]> {
  return { repo_key: repo.repoKey, repo_name: repo.repoName, repo_root: repo.repoRoot, checkout_path: path, is_linked_worktree: path !== repo.repoRoot };
}
for (const workspace of snapshot().workspaces) {
  const cwd = snapshot().panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd;
  if (cwd) workspace.worktree = worktreeMetadata(repositoryAt(cwd));
}
// The last workspace can be closed in a demo, so creation keeps templates independent of it.
const newPaneTemplate = structuredClone(snapshot().panes[0]!);
const newTabTemplate = structuredClone(snapshot().tabs[0]!);
const newWorkspaceTemplate = structuredClone(snapshot().workspaces[0]!);

function createDemoWorkspace(cwd: string, label: string, agent: string | null, worktree?: NonNullable<WorkspaceInfo["worktree"]>): WorkspaceCreated {
  const id = `w${(nextWorkspace++).toString(36)}`;
  const snap = snapshot();
  const pane: Pane = { ...structuredClone(newPaneTemplate), pane_id: `${id}:p1`, tab_id: `${id}:t1`, terminal_id: `${id}:term`, workspace_id: id, label: null, title: null, agent, agent_session: null, agent_status: agent ? "working" : "unknown", cwd, foreground_cwd: cwd, focused: false, terminal_title: null, terminal_title_stripped: null, revision: 1 };
  snap.panes.push(pane);
  addAgent(pane);
  snap.tabs.push({ ...structuredClone(newTabTemplate), tab_id: `${id}:t1`, workspace_id: id, label, number: 1, agent_status: pane.agent_status, focused: false, pane_count: 1 });
  snap.workspaces.push({ ...structuredClone(newWorkspaceTemplate), workspace_id: id, label, number: snap.workspaces.length + 1, active_tab_id: `${id}:t1`, agent_status: pane.agent_status, focused: false, pane_count: 1, tab_count: 1, worktree: worktree ?? worktreeMetadata(repositoryAt(cwd)) });
  if (agent) {
    keyOfPane.set(pane.pane_id, pane.pane_id);
    chats.set(pane.pane_id, { turns: [], metadata: { model: agent === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", reasoning_effort: "medium" } });
    setTimeout(() => { if (!replying.has(pane.pane_id)) finishDemoTurn(pane.pane_id, "idle"); }, 1500);
  }
  return { workspace_id: id, pane_id: pane.pane_id, agent_started: agent !== null };
}

function closeDemoWorkspaces(ids: Set<string>): void {
  const snap = snapshot();
  for (const removed of snap.panes.filter((pane) => ids.has(pane.workspace_id))) {
    for (const socket of sockets) socket.holdPending(removed.pane_id, "pane_not_found", "This demo pane closed. Copy the message before discarding it.");
    replying.delete(removed.pane_id);
  }
  snap.panes = snap.panes.filter((pane) => !ids.has(pane.workspace_id));
  snap.tabs = snap.tabs.filter((tab) => !ids.has(tab.workspace_id));
  snap.workspaces = snap.workspaces.filter((workspace) => !ids.has(workspace.workspace_id));
  const paneIds = new Set(snap.panes.map((pane) => pane.pane_id));
  snap.agents = snap.agents.filter((agent) => paneIds.has(agent.pane_id));
  snap.layouts = snap.layouts.filter((layout) => !ids.has(layout.workspace_id));
  const focused = snap.panes.find((pane) => pane.pane_id === snap.focused_pane_id) ?? snap.panes[0];
  snap.focused_pane_id = focused?.pane_id ?? null;
  snap.focused_tab_id = focused?.tab_id ?? null;
  snap.focused_workspace_id = focused?.workspace_id ?? null;
  for (const pane of snap.panes) pane.focused = pane.pane_id === snap.focused_pane_id;
  for (const tab of snap.tabs) tab.focused = tab.tab_id === snap.focused_tab_id;
  snap.workspaces.forEach((workspace, index) => { workspace.number = index + 1; workspace.focused = workspace.workspace_id === snap.focused_workspace_id; });
}

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
  // as herdr does, every state change bumps the session's counter on the pane's agent
  const agent = snapshot().agents.find((entry) => entry.pane_id === paneId);
  if (agent) Object.assign(agent, { agent_status: status, state_change_seq: nextStateSeq() });
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

/** The bridge takes one accepted pending message when the current mock turn finishes. */
function finishDemoTurn(paneId: string, status: "idle" | "done" = "done"): void {
  replying.delete(paneId);
  if (!paneOf(paneId)) return;
  setStatus(paneId, status);
  for (const socket of [...sockets].sort((a, b) => a.pendingOrder(paneId) - b.pendingOrder(paneId))) {
    if (socket.drainPending(paneId)) break;
  }
}

/** A sent Enter joins the conversation now; another Enter steers the current mock turn. */
function submitToChat(paneId: string, text: string): void {
  const key = keyOfPane.get(paneId);
  const chat = key ? chats.get(key) : undefined;
  if (!chat) return;
  chat.turns.push({ role: "user", ts: now(), parts: [{ kind: "text", text }] });
  const agent = agentOf(paneId);
  if (replying.has(paneId)) return;
  replying.add(paneId);
  setStatus(paneId, "working");
  setTimeout(() => {
    chat.turns.push({ role: "assistant", ts: now(), end_ts: now(), parts: [{ kind: "text", text: `This is the demo, so nothing ran. In the real app that message went to ${agent} in this pane, and its answer would be written here as it arrives, with its commands and edits folded above it.` }] });
    finishDemoTurn(paneId);
  }, CHAT_ANSWER_MS);
}

function answerPrompt(paneId: string, optionIndex: number | undefined): void {
  promptOpen = false;
  replying.add(paneId);
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
    finishDemoTurn(paneId);
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

/** Settings → Subscription usage on the demo: plans as the workstation's CLIs might report them, resets counted from now. */
function usageReport(): UsageReport {
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const checked = new Date(now).toISOString();
  return { providers: [
    { id: "claude", key: "claude:demo-claude", account: "sam@example.com", plan: "max", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 38, resets_at: at(2.4) },
      { kind: "week", scope: null, used_percent: 61, resets_at: at(78) },
      { kind: "week", scope: "Sonnet", used_percent: 12, resets_at: at(78) },
    ] },
    { id: "codex", key: "codex:demo-codex-work", account: "sam@work.example", plan: "pro", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 22, resets_at: at(1.2) },
      { kind: "week", scope: null, used_percent: 84, resets_at: at(97) },
    ] },
    { id: "codex", key: "codex:demo-codex-home", account: "sam@example.com", plan: "plus", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 5, resets_at: at(3.1) },
      { kind: "week", scope: null, used_percent: 31, resets_at: at(140) },
    ] },
    { id: "cursor", key: "cursor:demo-cursor", account: "sam@example.com", plan: "pro", problem: null, checked_at: checked, windows: [
      { kind: "month", scope: null, used_percent: 27, resets_at: at(290) },
      { kind: "month", scope: "Cursor models", used_percent: 19, resets_at: at(290) },
      { kind: "month", scope: "Other models", used_percent: 8, resets_at: at(290) },
    ] },
    { id: "opencode", key: "opencode:demo-opencode", account: null, plan: "Go", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 10, resets_at: at(3.2) },
      { kind: "week", scope: null, used_percent: 28, resets_at: at(18) },
      { kind: "month", scope: null, used_percent: 15, resets_at: at(520) },
    ] },
  ] };
}

async function route(url: URL, method: string, init: RequestInit | undefined, input: RequestInfo | URL): Promise<Response> {
  const path = url.pathname;
  const query = url.searchParams;
  const paneId = query.get("pane_id") ?? "";

  if (path === "/api/health") {
    const auth = { required: false, authenticated: true };
    if (query.get("scope") === "bridge") return json({ ok: true, auth, bridge_protocol: 1 });
    return json({ ok: true, herdr: { version: "0.9.0", protocol: 22, terminal_attach: true }, auth, web_ui: { boot_id: DEMO_VERSION, revision: null } });
  }
  if (path === "/api/machines") return json({ machines });
  if (path === "/api/session") return json({ snapshot: snapshot() });
  if (path === "/api/agents") return json(agentsFixture);
  if (path === "/api/updates") return json({ managed: false, auto_update: false, phase: "idle", current_revision: null, latest_revision: null, current_version: __APP_VERSION__, latest_version: null, available: false, checked_at: null, blocked_reason: null, error: null }, 200, { "cache-control": "no-store" });
  if (path === "/api/updates/notes") return json({ revision: null, releases: [], omitted: 0 }, 200, { "cache-control": "no-store" });
  if (path === "/api/updates/installed") return json({ revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 }, 200, { "cache-control": "no-store" });
  // the demo has no herdr to update: the controls stay hidden
  // the demo sends no counts: a server without telemetry answers 404, and the app shows neither its notice nor its switch
  if (path === "/api/telemetry") return json({ error: { code: "not_found", message: "This server sends no telemetry" } }, 404, { "cache-control": "no-store" });
  if (path === "/api/herdr/update") return json({ supported: false, phase: "idle", server_version: null, binary_version: null, stale: false, output: null, finished_at: null }, 200, { "cache-control": "no-store" });
  if (path === "/api/access") return json({ port: 7317, tailscale: { state: "running", dns_name: "workstation.example.ts.net", serving_url: "https://workstation.example.ts.net", serve_command: null, serve_url: null } });
  if (path === "/api/usage") return json(usageReport(), 200, { "cache-control": "no-store" });
  if (path === "/api/push" || path.startsWith("/api/push/")) return error("push_unavailable", "the demo sends no alerts", 404);
  if (path === "/api/machines/settings") return json({ auto_update_bridges: true });
  if (path.startsWith("/api/machines/")) return error("demo", "remote PCs need a real machine", 404);

  if (path === "/api/worktree/list" || path === "/api/worktree/create" || path === "/api/worktree/open" || path === "/api/worktree/remove") {
    const listing = path === "/api/worktree/list";
    if (method !== (listing ? "GET" : "POST")) return error("method_not_allowed", listing ? "use GET" : "use POST", 400);
    const body = listing ? {} : await bodyOf(init, input);
    const workspaceId = listing ? query.get("workspace_id") : body["workspace_id"];
    if (typeof workspaceId !== "string" || !workspaceId) return error("missing_workspace_id", "workspace_id is required", 400);
    const workspace = snapshot().workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!workspace) return error("workspace_not_found", "no such workspace", 404);
    const info = workspace.worktree;
    const repo = info ? repositories.get(info.repo_key) : undefined;
    if (!info || !repo) return error("not_git_repository", "the workspace is not in a repository", 404);
    if (listing) {
      const worktrees = repo.checkouts.map((checkout) => ({ ...checkout, open_workspace_id: snapshot().workspaces.find((candidate) => candidate.worktree?.repo_key === repo.repoKey && candidate.worktree.checkout_path === checkout.path)?.workspace_id ?? null }));
      return json({ source: { repo_key: repo.repoKey, repo_name: repo.repoName, repo_root: repo.repoRoot, source_checkout_path: info.checkout_path, source_workspace_id: workspaceId }, worktrees } satisfies WorktreeListing);
    }
    if (path === "/api/worktree/remove") {
      if (body["force"] !== undefined && typeof body["force"] !== "boolean") return error("invalid_force", "force must be a boolean", 400);
      if (!info.is_linked_worktree) return error("not_linked_worktree", "the repository's main checkout cannot be removed", 404);
      const checkoutPath = info.checkout_path;
      repo.checkouts = repo.checkouts.filter((checkout) => checkout.path !== checkoutPath);
      // Removing a checkout leaves its branch available for a later create, as git does.
      closeDemoWorkspaces(new Set([workspaceId]));
      structureChanged();
      return json({ ok: true, path: checkoutPath, forced: body["force"] === true } satisfies WorktreeRemoved);
    }
    for (const field of ["branch", "base", "label", "path"] as const) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") return error(`invalid_${field}`, `${field} must be a string`, 400);
    }
    const branch = typeof body["branch"] === "string" ? body["branch"].trim() || undefined : undefined;
    const label = typeof body["label"] === "string" ? body["label"].trim() || undefined : undefined;
    const checkoutPath = typeof body["path"] === "string" ? body["path"] || undefined : undefined;
    if (checkoutPath && !checkoutPath.startsWith("/")) return error("invalid_path", "path must be absolute", 400);
    const creating = path === "/api/worktree/create";
    if (creating && !branch) return error("missing_branch", "branch is required", 400);
    if (!creating && !branch && !checkoutPath) return error("missing_target", "path or branch is required", 400);
    const agent = creating ? body["agent"] as { kind?: unknown; name?: unknown; args?: unknown } | null | undefined : null;
    if (agent !== undefined && agent !== null && (typeof agent !== "object" || typeof agent.kind !== "string" || agent.kind.length === 0
      || (agent.name !== undefined && typeof agent.name !== "string")
      || (agent.args !== undefined && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string"))))) {
      return error("invalid_agent", "agent.kind is required; agent.name must be a string and agent.args must be an array of strings", 400);
    }
    let checkout: Omit<WorktreeEntry, "open_workspace_id"> | undefined;
    if (creating) {
      const targetPath = checkoutPath ?? `/home/demo/.herdr/worktrees/${repo.repoName}/${branch}`;
      if (repo.checkouts.some((candidate) => candidate.path === targetPath || candidate.branch === branch)) return error("worktree_exists", "that branch or path already has a checkout; open it instead", 404);
      checkout = { path: targetPath, branch: branch!, label: label ?? branch!, is_linked_worktree: true, is_bare: false, is_detached: false, is_prunable: false };
      repo.branches.add(branch!);
      repo.checkouts.push(checkout);
    } else {
      checkout = repo.checkouts.find((candidate) => checkoutPath ? candidate.path === checkoutPath : candidate.branch === branch);
      if (!checkout) return error("worktree_not_found", "no such checkout", 404);
    }
    const openWorkspace = snapshot().workspaces.find((candidate) => candidate.worktree?.repo_key === repo.repoKey && candidate.worktree.checkout_path === checkout.path);
    const openPane = openWorkspace && snapshot().panes.find((pane) => pane.workspace_id === openWorkspace.workspace_id);
    if (openWorkspace && openPane) {
      return json({ workspace_id: openWorkspace.workspace_id, pane_id: openPane.pane_id, already_open: true, path: checkout.path, branch: checkout.branch } satisfies WorktreeOpened);
    }
    const made = createDemoWorkspace(checkout.path, label ?? checkout.label, typeof agent?.kind === "string" ? agent.kind : null, worktreeMetadata(repo, checkout.path));
    structureChanged();
    return json({ workspace_id: made.workspace_id, pane_id: made.pane_id, already_open: false, path: checkout.path, branch: checkout.branch, ...(agent ? { agent_started: made.agent_started } : {}) } satisfies WorktreeOpened);
  }

  if (path === "/api/pane/conversation") {
    const key = keyOfPane.get(paneId);
    const chat = key ? chats.get(key) : undefined;
    const agent = agentOf(paneId);
    if (!chat) return json({ source: "scrollback", turns: [] });
    const source = agent === "claude" ? "claude-transcript" : agent === "codex" ? "codex-transcript" : agent === "gjc" ? "gjc-transcript" : agent === "omo" ? "omo-transcript" : agent === "pi" ? "pi-transcript" : "omp-transcript";
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
  if (path === "/api/pane/omo-tasks") return json(keyOfPane.get(paneId) === OMO_TASKS_PANE ? { tasks: omoTasks(), runs: omoRuns() } : { tasks: [], runs: [] });
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
  if (path === "/api/workspace/close") {
    const body = await bodyOf(init, input);
    const workspace = snapshot().workspaces.find((candidate) => candidate.workspace_id === body["workspace_id"]);
    if (!workspace) return error("not_found", "no such workspace", 404);
    if (body["close_group"] !== undefined && typeof body["close_group"] !== "boolean") return error("invalid_close_group", "close_group must be a boolean", 400);
    const info = workspace.worktree;
    const children = info && !info.is_linked_worktree ? snapshot().workspaces.filter((candidate) => candidate.worktree?.repo_key === info.repo_key && candidate.worktree.is_linked_worktree) : [];
    if (children.length > 0 && body["close_group"] !== true) return error("workspace_group_close_required", "close_group is required to close the workspace with its worktrees", 404);
    closeDemoWorkspaces(new Set([workspace.workspace_id, ...children.map((child) => child.workspace_id)]));
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/pane/close") {
    const body = await bodyOf(init, input);
    const pane = paneOf(String(body["pane_id"] ?? ""));
    if (!pane) return error("not_found", "no such pane", 404);
    const snap = snapshot();
    for (const socket of sockets) socket.holdPending(pane.pane_id, "pane_not_found", "This demo pane closed. Copy the message before discarding it.");
    replying.delete(pane.pane_id);
    snap.panes = snap.panes.filter((candidate) => candidate.pane_id !== pane.pane_id);
    const survivingPanes = snap.panes.filter((candidate) => candidate.workspace_id === pane.workspace_id);
    snap.tabs = snap.tabs.filter((tab) => tab.workspace_id !== pane.workspace_id || survivingPanes.some((candidate) => candidate.tab_id === tab.tab_id));
    const survivingTabs = snap.tabs.filter((tab) => tab.workspace_id === pane.workspace_id);
    snap.workspaces = snap.workspaces.filter((workspace) => workspace.workspace_id !== pane.workspace_id || survivingPanes.length > 0);
    const focused = snap.panes.find((candidate) => candidate.pane_id === snap.focused_pane_id)
      ?? survivingPanes.find((candidate) => candidate.tab_id === pane.tab_id)
      ?? survivingPanes[0]
      ?? snap.panes.find((candidate) => candidate.focused)
      ?? snap.panes[0];
    snap.focused_pane_id = focused?.pane_id ?? null;
    snap.focused_tab_id = focused?.tab_id ?? null;
    snap.focused_workspace_id = focused?.workspace_id ?? null;
    for (const candidate of snap.panes) candidate.focused = candidate.pane_id === snap.focused_pane_id;
    for (const tab of snap.tabs) {
      tab.focused = tab.tab_id === snap.focused_tab_id;
      if (tab.workspace_id !== pane.workspace_id) continue;
      const own = survivingPanes.filter((candidate) => candidate.tab_id === tab.tab_id);
      tab.pane_count = own.length;
      tab.agent_status = rollupStatus(own.map((candidate) => candidate.agent_status));
    }
    for (const [index, workspace] of snap.workspaces.entries()) {
      workspace.number = index + 1;
      workspace.focused = workspace.workspace_id === snap.focused_workspace_id;
      if (workspace.workspace_id !== pane.workspace_id) continue;
      workspace.pane_count = survivingPanes.length;
      workspace.tab_count = survivingTabs.length;
      workspace.agent_status = rollupStatus(survivingPanes.map((candidate) => candidate.agent_status));
      if (!survivingTabs.some((tab) => tab.tab_id === workspace.active_tab_id)) {
        workspace.active_tab_id = survivingTabs.find((tab) => tab.tab_id === snap.focused_tab_id)?.tab_id ?? survivingTabs[0]!.tab_id;
      }
    }
    const tabIds = new Set(snap.tabs.map((tab) => tab.tab_id));
    snap.layouts = snap.layouts.filter((layout) => tabIds.has(layout.tab_id));
    for (const layout of snap.layouts) {
      if (layout.workspace_id !== pane.workspace_id) continue;
      const own = survivingPanes.filter((candidate) => candidate.tab_id === layout.tab_id);
      layout.panes = layout.panes.filter((candidate) => own.some((survivor) => survivor.pane_id === candidate.pane_id));
      if (!own.some((candidate) => candidate.pane_id === layout.focused_pane_id)) {
        layout.focused_pane_id = own.find((candidate) => candidate.focused)?.pane_id ?? own[0]!.pane_id;
      }
      for (const candidate of layout.panes) candidate.focused = candidate.pane_id === layout.focused_pane_id;
    }
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/tab/rename") {
    const body = await bodyOf(init, input);
    const tab = snapshot().tabs.find((t) => t.tab_id === body["tab_id"]);
    if (!tab) return error("tab_not_found", "no such tab", 404);
    const label = String(body["label"] ?? "").trim();
    if (label === "") return error("missing_label", "label is required", 400);
    tab.label = label;
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/tab/close") {
    const body = await bodyOf(init, input);
    const snap = snapshot();
    const tab = snap.tabs.find((t) => t.tab_id === body["tab_id"]);
    if (!tab) return error("tab_not_found", "no such tab", 404);
    for (const removed of snap.panes.filter((p) => p.tab_id === tab.tab_id)) {
      for (const socket of sockets) socket.holdPending(removed.pane_id, "pane_not_found", "This demo pane closed. Copy the message before discarding it.");
      replying.delete(removed.pane_id);
    }
    snap.panes = snap.panes.filter((p) => p.tab_id !== tab.tab_id);
    snap.tabs = snap.tabs.filter((t) => t.tab_id !== tab.tab_id);
    snap.layouts = snap.layouts.filter((l) => l.tab_id !== tab.tab_id);
    // a workspace's last tab takes the workspace with it
    if (!snap.tabs.some((t) => t.workspace_id === tab.workspace_id)) snap.workspaces = snap.workspaces.filter((w) => w.workspace_id !== tab.workspace_id);
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
    const label = String(body["label"] ?? "") || cwd.split("/").pop() || "new";
    const made = createDemoWorkspace(cwd, label, agent);
    structureChanged();
    return json(made);
  }
  if (path === "/api/tab/create") {
    const body = await bodyOf(init, input);
    const snap = snapshot();
    const workspace = snap.workspaces.find((w) => w.workspace_id === body["workspace_id"]);
    if (!workspace) return error("not_found", "no such workspace", 404);
    const agent = (body["agent"] as { kind?: string } | null | undefined)?.kind ?? null;
    const id = workspace.workspace_id;
    const siblings = snap.panes.filter((p) => p.workspace_id === id);
    const cwd = String(body["cwd"] ?? siblings[0]?.cwd ?? "/home/demo");
    const tabs = snap.tabs.filter((tab) => tab.workspace_id === id);
    const number = Math.max(0, ...tabs.map((tab) => tab.number)) + 1;
    const tabId = `${id}:t${number}`;
    const template = snap.panes[0]!;
    const pane: Pane = { ...structuredClone(template), pane_id: `${id}:p${(nextWorkspace++).toString(36)}`, tab_id: tabId, terminal_id: `${id}:term${number}`, workspace_id: id, label: null, title: null, agent, agent_session: null, agent_status: agent ? "working" : "unknown", cwd, foreground_cwd: cwd, focused: false, terminal_title: null, terminal_title_stripped: null, revision: 1 };
    snap.panes.push(pane);
    addAgent(pane);
    snap.tabs.push({ ...structuredClone(snap.tabs[0]!), tab_id: tabId, workspace_id: id, label: String(body["label"] ?? "") || String(number), number, agent_status: pane.agent_status, focused: false, pane_count: 1 });
    workspace.tab_count = tabs.length + 1;
    workspace.pane_count = siblings.length + 1;
    if (agent) {
      keyOfPane.set(pane.pane_id, pane.pane_id);
      chats.set(pane.pane_id, { turns: [], metadata: { model: agent === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", reasoning_effort: "medium" } });
      setTimeout(() => { if (!replying.has(pane.pane_id)) finishDemoTurn(pane.pane_id, "idle"); }, 1500);
    }
    structureChanged();
    return json({ workspace_id: id, pane_id: pane.pane_id, agent_started: agent !== null } satisfies WorkspaceCreated);
  }
  // no key in the demo: the app falls back to the browser's own speech recognition
  if (path === "/api/voice") return json({ configured: false, source: null, ...VOICE_DEFAULTS } satisfies VoiceStatus, 200, { "cache-control": "no-store" });
  if (path === "/api/voice/config") return error("demo", "the demo saves no OpenAI key", 409);
  if (path === "/api/voice/transcribe") return error("voice_not_configured", "transcription is unavailable in the demo", 409);
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
/**
 * What a `keys` chord types into the demo's shell. The server hands the chord to herdr, which
 * encodes it for the pane's program; the demo has only this shell, so it takes what a plain
 * terminal would send and the shell can use: Enter, Backspace, a character, Shift's capital
 * and Ctrl's control code (^C). Alt, the arrows and the F keys have nothing to do here.
 */
const CHORD_KEYS = new Map([["enter", "\r"], ["backspace", "\x7f"], ["tab", "\t"], ["esc", "\x1b"], ["space", " "], ["plus", "+"]]);
function chordText(chord: string): string {
  const parts = chord.split("+");
  const name = parts.pop() ?? "";
  const held = new Set(parts.map((part) => part.toLowerCase()));
  const key = CHORD_KEYS.get(name.toLowerCase()) ?? ([...name].length === 1 ? name : "");
  if (key === "" || held.has("alt")) return "";
  if (held.has("ctrl") && /^[a-z]$/i.test(key)) return String.fromCharCode(key.toUpperCase().charCodeAt(0) & 0x1f);
  return held.has("shift") ? key.toUpperCase() : key;
}

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
  private mode: "interact" | "observe" = "interact";
  /** Accepted messages belong to this live connection, never to a reconnect's empty queue. */
  private readonly pending = new Map<string, PendingMessage[]>();
  private readonly outcomes = new Map<string, { paneId: string; outcome: "sent" | "discarded" }>();
  private readonly requests = new Map<number, { signature: string; reply?: ServerMessage }>();
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
      this.push({ type: "snapshot", snapshot: snapshot(), features: ["submit", "pending-input", "secret-input", "input-ready"] });
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
    if (this.readyState !== 1) return;
    let message: { type: string; pane_id?: string; text?: string; payload?: string; keys?: string[]; id?: number; mode?: string; typed?: unknown; delivery?: unknown; pending_id?: string; action?: unknown };
    try { message = JSON.parse(raw); } catch { return; }
    if ((message.type === "submit" || message.type === "pending-action") && Number.isSafeInteger(message.id)) {
      const signature = JSON.stringify({ type: message.type, pane_id: message.pane_id, text: message.text, payload: message.payload, typed: message.typed, delivery: message.delivery, pending_id: message.pending_id, action: message.action });
      const previous = this.requests.get(message.id!);
      if (previous) {
        if (previous.signature !== signature) {
          if (message.type === "submit") this.push({ type: "submit-result", id: message.id!, pane_id: message.pane_id ?? "", ok: false, code: "invalid_submit_id", message: "This submit ID already belongs to another message." });
          else this.push({ type: "pending-result", id: message.id!, pane_id: message.pane_id ?? "", pending_id: message.pending_id ?? "", ok: false, code: "invalid_pending_action", message: "This request ID already belongs to another action." });
        }
        else if (previous.reply) {
          const reply = previous.reply;
          if (reply.type === "submit-result" && reply.pending) {
            const pendingId = reply.pending.id;
            const pending = this.pending.get(reply.pane_id)?.find((item) => item.id === pendingId);
            if (pending) this.push({ ...reply, pending: structuredClone(pending) });
            else this.push({ type: "submit-result", id: reply.id, pane_id: reply.pane_id, ok: true });
          } else {
            if (reply.type === "pending-result" && reply.ok) {
              const receipt = this.outcomes.get(reply.pending_id);
              if (receipt?.paneId === reply.pane_id) this.publishPending(receipt.paneId, [{ id: reply.pending_id, outcome: receipt.outcome }]);
            }
            this.push(reply);
          }
        }
        return;
      }
      this.requests.set(message.id!, { signature });
      if (this.requests.size > 128) this.requests.delete(this.requests.keys().next().value!);
    }
    switch (message.type) {
      case "role":
        this.mode = message.mode === "observe" ? "observe" : "interact";
        if (this.mode === "observe") this.holdPending(undefined, "read_only", "This connection now only watches. Pending messages will not be sent automatically.");
        this.push({ type: "role-ack", mode: this.mode });
        break;
      case "attach": if (message.pane_id) this.attach(message.pane_id); break;
      // The demo has no competing attach slots and does not advertise this capability.
      case "take-over":
        this.push({ type: "error", code: "unsupported", message: "The demo has no competing terminal attachments.", pane_id: message.pane_id });
        break;
      case "detach":
        if (message.pane_id) {
          this.attached.delete(message.pane_id);
          this.holdPending(message.pane_id, "not_attached", "This pane was detached. Pending messages will not be sent automatically.");
        }
        break;
      case "input": if (message.pane_id && message.text !== undefined) this.typed(message.pane_id, message.text); break;
      case "keys": if (message.pane_id) for (const key of message.keys ?? []) this.typed(message.pane_id, chordText(key)); break;
      case "secret":
        if (message.id !== undefined && message.pane_id) this.push({ type: "secret-result", id: message.id, pane_id: message.pane_id, ok: false, code: "prompt_changed" });
        break;
      case "submit":
        if (!Number.isSafeInteger(message.id) || !message.pane_id || typeof message.text !== "string" || typeof message.payload !== "string") {
          this.push({ type: "error", code: "invalid_submit", message: "id, pane_id, text and payload are required." });
          break;
        }
        if (message.pane_id && message.text !== undefined && message.id !== undefined) {
          const queued = message.delivery === "queue";
          const text = queued ? message.text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n") : message.text;
          let code: string | null = null;
          if ((message.delivery !== undefined && message.delivery !== "immediate" && !queued) || (queued && message.typed !== undefined && message.typed !== false)) code = "invalid_delivery";
          else if (this.mode === "observe") code = "read_only";
          else if (queued && (text.trim().length === 0 || text.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))) code = "invalid_submit_text";
          else if (queued) code = this.pendingTargetError(message.pane_id);
          if (code) {
            this.completeRequest({ type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code, message: "The demo agent cannot take this submission." });
            break;
          }
          if (queued && paneOf(message.pane_id)?.agent_status === "working") {
            const pending: PendingMessage = { id: `demo-pending-${nextPending++}`, request_id: message.id, text, state: "queued", created_at: now() };
            this.pending.set(message.pane_id, [...(this.pending.get(message.pane_id) ?? []), pending]);
            const reply: ServerMessage = { type: "submit-result", id: message.id, pane_id: message.pane_id, ok: true, pending: structuredClone(pending) };
            this.rememberRequest(reply);
            this.publishPending(message.pane_id);
            this.push(reply);
          } else {
            submitToChat(message.pane_id, text);
            this.completeRequest({ type: "submit-result", id: message.id, pane_id: message.pane_id, ok: true });
          }
        }
        break;
      case "pending-action":
        if (message.id !== undefined && message.pane_id && message.pending_id) {
          const result = (ok: boolean, code?: string) => this.completeRequest({ type: "pending-result", id: message.id!, pane_id: message.pane_id!, pending_id: message.pending_id!, ok, ...(code ? { code, message: "The demo pending message was not changed." } : {}) });
          if (message.action !== "steer" && message.action !== "discard") { result(false, "invalid_pending_action"); break; }
          if (this.mode === "observe") { result(false, "read_only"); break; }
          const pending = this.pending.get(message.pane_id)?.find((item) => item.id === message.pending_id);
          if (!pending) {
            const receipt = this.outcomes.get(message.pending_id);
            if (receipt?.paneId === message.pane_id) {
              this.publishPending(message.pane_id, [{ id: message.pending_id, outcome: receipt.outcome }]);
              result(true);
            } else result(false, "pending_not_found");
            break;
          }
          if (pending.state === "sending") { result(false, "pending_busy"); break; }
          if (message.action === "discard") {
            this.removePending(message.pane_id, pending.id, "discarded");
            result(true);
          } else {
            const code = this.pendingTargetError(message.pane_id);
            if (code) { result(false, code); break; }
            if (pending.state === "uncertain") { result(false, "pending_uncertain"); break; }
            const sent = this.deliverPending(message.pane_id, pending);
            result(sent, sent ? undefined : pending.error?.code ?? "pending_changed");
          }
        }
        break;
      default: /* resize, pty-ack: nothing to do in the demo */
    }
  }

  private rememberRequest(message: Extract<ServerMessage, { type: "submit-result" | "pending-result" }>): void {
    const request = this.requests.get(message.id);
    if (request) request.reply = structuredClone(message);
  }

  private completeRequest(message: Extract<ServerMessage, { type: "submit-result" | "pending-result" }>): void {
    this.rememberRequest(message);
    this.push(message);
  }

  private publishPending(paneId: string, removed?: { id: string; outcome: "sent" | "discarded" }[]): void {
    this.push({ type: "pending-messages", pane_id: paneId, messages: this.pending.get(paneId) ?? [], ...(removed ? { removed } : {}) });
  }

  /** A lost claim never becomes input merely because this pane becomes ready again. */
  holdPending(paneId?: string, code = "disconnected", message = "The connection closed. Pending messages will not be sent automatically."): void {
    for (const [pane, pending] of this.pending) {
      if (paneId !== undefined && pane !== paneId) continue;
      for (const item of pending) if (item.state === "queued" || item.state === "sending") {
        item.state = "held";
        item.error = { code, message };
      }
      this.publishPending(pane);
    }
  }

  private pendingTargetError(paneId: string): string | null {
    if (this.readyState !== 1) return "disconnected";
    if (this.mode === "observe") return "read_only";
    if (!this.attached.has(paneId)) return "not_attached";
    const pane = paneOf(paneId);
    if (!pane) return "pane_not_found";
    if (!(pane.agent ?? pane.agent_session?.agent)) return "agent_not_ready";
    if (keyOfPane.get(paneId) === "web" && promptOpen) return "agent_blocked";
    if (pane.agent_status === "blocked") return "agent_blocked";
    if (!["working", "idle", "done"].includes(pane.agent_status)) return "agent_not_ready";
    return null;
  }

  private removePending(paneId: string, pendingId: string, outcome: "sent" | "discarded"): void {
    this.pending.set(paneId, (this.pending.get(paneId) ?? []).filter((item) => item.id !== pendingId));
    this.outcomes.set(pendingId, { paneId, outcome });
    if (this.outcomes.size > 1024) this.outcomes.delete(this.outcomes.keys().next().value!);
    this.publishPending(paneId, [{ id: pendingId, outcome }]);
  }

  private deliverPending(paneId: string, pending: PendingMessage): boolean {
    pending.state = "sending";
    delete pending.error;
    this.publishPending(paneId);
    // A close, detach or role change can land in the sending notification itself.
    // Revalidate the same claim before the mock turn receives any of its text.
    if (pending.state !== "sending") return false;
    const code = this.pendingTargetError(paneId);
    if (code !== null) {
      pending.state = "held";
      pending.error = { code, message: "The pane changed before delivery. This message will not be sent automatically." };
      this.publishPending(paneId);
      return false;
    }
    submitToChat(paneId, pending.text);
    this.removePending(paneId, pending.id, "sent");
    return true;
  }

  pendingOrder(paneId: string): number {
    const first = this.pending.get(paneId)?.find((item) => item.state === "queued");
    return first ? Number(first.id.split("-").at(-1)) : Infinity;
  }

  /** Only a live owner can drain one queued item at a real completion edge. */
  drainPending(paneId: string): boolean {
    if (this.pendingTargetError(paneId) !== null || !["idle", "done"].includes(paneOf(paneId)?.agent_status ?? "")) return false;
    const pending = this.pending.get(paneId)?.find((item) => item.state === "queued");
    return pending !== undefined && this.deliverPending(paneId, pending);
  }

  private attach(paneId: string): void {
    this.attached.add(paneId);
    this.publishPending(paneId);
    this.push({ type: "input-ready", pane_id: paneId });
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
    this.holdPending();
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
  const turn = chat?.turns.findLast((turn) => turn.role === "assistant" && !turn.end_ts);
  if (!chat || !turn || turn.role !== "assistant") return;
  turn.parts.push(
    { kind: "tool", name: "Bash", summary: "bun test metrics", input: JSON.stringify({ command: "bun test metrics" }, null, 2), output: " 6 pass\n 0 fail\nRan 6 tests across 1 file. [201ms]" },
    { kind: "text", text: "Added `payments_idempotent_replays_total`, incremented where a stored response is replayed, and exposed with the other counters on `/metrics`. 6 tests pass." },
  );
  turn.end_ts = now();
  finishDemoTurn(paneId);
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
