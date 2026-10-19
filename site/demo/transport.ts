/**
 * The browser demo's stand-in for the server. Loaded before the app on the demo page, it answers
 * `fetch("/api/…")`, `new EventSource("/api/machines/events")` and `new WebSocket("…/ws")` from
 * fixtures (site/demo/fixtures/, captured by scripts/demo-fixtures.ts from the staged fictional
 * session) instead of the network. The app's own code is unchanged: it believes it talks to a
 * herdr web ui server on a PC called "workstation".
 *
 * What works: the sidebar (two repositories, each with two agent worktrees) and its live statuses,
 * every chat, the Codex approval card (answering it sets Codex to work and ends the turn), the
 * command palette, settings, and the terminal: the release shell tab replays a recording of `git log` and `bun test`, then a small pretend shell answers what you
 * type. `demo logs` loads fictional retained history for scrolling and search; agent panes show
 * one notice instead of a TUI. A message sent from a chat gets a demo answer.
 * What does not: files, images, push and remote PCs, which need a real machine.
 */
import type { AgentIntegration, AgentStatus, ConversationTurn, IntegrationsResponse, Machine, MachineEvent, PaneDirection, PaneFindMatch, PaneFindRequest, PanePlan, PaneResized, PaneSplit, PaneSwapped, PaneZoomed, PendingMessage, PlanStep, PluginActionResult, PluginActions, PluginActionsResponse, PortalStatus, ServerMessage, SessionSnapshot, TabMoved, UsageReport, WorkspaceCreated, WorkspaceInfo, WorktreeEntry, WorktreeListing, WorktreeOpened, WorktreeRemoved } from "../../shared/protocol.ts";
import type { RepoDiffFile, RepoDiffFileList, RepoDiffFilePatch, RepoDiffRepository, RepoDiffScope } from "../../shared/protocol.ts";
import { VOICE_DEFAULTS, type VoiceStatus } from "../../shared/voice.ts";
import { isAgentName } from "../../shared/agent-name.ts";
import { neighborPane } from "../../src/lib/layoutMap.ts";
import { closeLayoutPane, resizeLayout, setLayoutSplitRatio, splitLayout, swapLayoutPanes } from "../../src/lib/layoutTree.ts";
import { rollupStatus } from "../../src/lib/status.ts";
import { movedTabOrder } from "../../src/lib/tabOrder.ts";
import { CHATS, PROMPT, SPECS, type DemoSpec } from "./fixtures.ts";
import { DemoHistory } from "./history.ts";
import machinesFixture from "./fixtures/machines.json";
import agentsFixture from "./fixtures/agents.json";
import commandsFixture from "./fixtures/commands.json";
import panesFixture from "./fixtures/panes.json";
import terminalFixture from "./fixtures/terminal.json";

const DEMO_VERSION = "demo";
/** Only an explicit `demo logs` command starts this fictional retained history. */
const histories = new Map<string, DemoHistory>();
const terminalGrids = new Map<string, { cols: number; rows: number }>();
const heldCopyResends = new Map<string, { text: string; reply: Extract<ServerMessage, { type: "submit-result" }>; at: number }>();
const demoGrid = (paneId: string) => terminalGrids.get(paneId) ?? { cols: 80, rows: 24 };
function redrawHistory(paneId: string): void {
  for (const socket of sockets) socket.renderHistory(paneId);
}
const PROMPT_ANSWER_TURN_MS = 2600;
const CHAT_ANSWER_MS = 2400;
/** the recording's gaps, capped so the replay stays brisk */
const MAX_FRAME_GAP_MS = 500;
/** Settings → Agent integrations: one of each state, in herdr's order */
const integrationsFixture: AgentIntegration[] = [
  ["pi", "pi", true, "not_installed"], ["omp", "omp", false, "not_installed"], ["claude", "claude", true, "current"],
  ["codex", "codex", true, "outdated"], ["copilot", "copilot", false, "not_installed"], ["opencode", "opencode", true, "not_installed"],
  ["cursor", "cursor-agent", false, "not_installed"], ["antigravity_cli", "agy", false, "not_installed"],
].map(([target, command, available, state]) => ({ target: target as string, label: (target as string).replace("_", "-"), command: command as string, available: available as boolean, state: state as string }));

type Pane = SessionSnapshot["panes"][number];
type SseListener = (event: MessageEvent) => void;

// ---- state -----------------------------------------------------------------------------------

const machines: Machine[] = structuredClone(machinesFixture.machines as Machine[]);
const local = machines[0]!;
const snapshot = (): SessionSnapshot => local.snapshot!;
// Reloading the demo starts its in-memory server over, so IDs from the previous page cannot match.
for (const machine of machines) if (machine.snapshot) {
  machine.snapshot.finish_epoch = crypto.randomUUID();
  for (const pane of machine.snapshot.panes) pane.finish_id = pane.agent_status === "done" ? 1 : 0;
}
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
    const last = turn.parts.at(-1);
    if (turn.role === "assistant" && turn.end_ts && last?.kind === "text") last.phase = "final_answer";
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
// taken once, as the pane, tab and workspace templates are: the last agent can be closed in a demo
const agentTemplate = local.snapshot?.agents[0] ? structuredClone(local.snapshot.agents[0]) : null;
function addAgent(pane: Pane): void {
  pane.finish_id = pane.agent_status === "done" ? 1 : 0;
  const snap = snapshot();
  if (!pane.agent || !agentTemplate || snap.agents.some((agent) => agent.pane_id === pane.pane_id)) return;
  snap.agents.push({ ...structuredClone(agentTemplate), pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id,
    agent: pane.agent, agent_status: pane.agent_status, cwd: pane.cwd, foreground_cwd: pane.foreground_cwd, state_change_seq: nextStateSeq() });
}

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const planSteps: PlanStep[] = [
  { id: "1", label: "Trace replayed requests", active: null, status: "completed", blocked_by: [], owner: null, started_at: ago(8), ended_at: ago(6) },
  { id: "2", label: "Count idempotent replays", active: "Adding the replay metric", status: "in_progress", blocked_by: ["1"], owner: null, started_at: ago(5), ended_at: null },
  { id: "3", label: "Cover the metric with tests", active: null, status: "pending", blocked_by: ["2"], owner: null, started_at: null, ended_at: null },
];
/** herdr lays a new tab out as its one pane over the whole area: the demo's layout for it, so the layout operations find the pane. */
function addDemoLayout(workspaceId: string, tabId: string, paneId: string): void {
  const area = { x: 0, y: 0, width: 120, height: 40 };
  snapshot().layouts.push({ workspace_id: workspaceId, tab_id: tabId, zoomed: false, area, focused_pane_id: paneId, panes: [{ pane_id: paneId, focused: true, rect: { ...area } }], splits: [] });
}

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

/**
 * The demo's roster, laid out from SPECS over what the fixtures recorded. `fixtures/machines.json`
 * is recorded by `bun scripts/demo-fixtures.ts`, which drives a live herdr, so it is rarely re-cut
 * for the roster's sake: `fixtures/panes.json` names the pane each spec has, a recorded pane no spec
 * names is dropped, a spec the recording lacks gets a pane cloned from a recorded one (with the ID
 * panes.json gives it, so the browser checks can name it), a `tabOf` spec moves into its parent's
 * workspace as a second tab, and a `worktreeOf` spec becomes a linked checkout of its parent's
 * repository. Each workspace takes its spec's label and folder; the recorded panes keep their own
 * terminals and state counters.
 */
function layOutRoster(): void {
  const snap = snapshot();
  const paneTemplate = snap.panes.find((pane) => pane.agent) ?? snap.panes[0];
  const tabTemplate = snap.tabs[0];
  const workspaceTemplate = snap.workspaces[0];
  if (!paneTemplate || !tabTemplate || !workspaceTemplate) return;
  const named = new Set(SPECS.map((spec) => spec.key));
  const dropped = new Set(snap.panes.filter((pane) => !named.has(keyOfPane.get(pane.pane_id) ?? "")).map((pane) => pane.workspace_id));
  if (dropped.size > 0) {
    snap.panes = snap.panes.filter((pane) => !dropped.has(pane.workspace_id));
    snap.tabs = snap.tabs.filter((tab) => !dropped.has(tab.workspace_id));
    snap.workspaces = snap.workspaces.filter((workspace) => !dropped.has(workspace.workspace_id));
    snap.layouts = snap.layouts.filter((layout) => !dropped.has(layout.workspace_id));
    snap.agents = snap.agents.filter((agent) => !dropped.has(agent.workspace_id));
  }
  const paneOfKey = (key: string) => snap.panes.find((pane) => keyOfPane.get(pane.pane_id) === key);
  const pathOf = (spec: DemoSpec): string => {
    const parent = spec.worktreeOf ? SPECS.find((candidate) => candidate.key === spec.worktreeOf) : undefined;
    return parent ? `/home/demo/.herdr/worktrees/${parent.label}/${spec.label}` : `/home/demo/${spec.label}`;
  };
  // a pane for every spec, in a workspace of its own for now
  for (const spec of SPECS) {
    if (paneOfKey(spec.key)) continue;
    const recordedId = (panesFixture as Record<string, string>)[spec.key];
    const id = recordedId?.split(":")[0] ?? `w${(nextWorkspace++).toString(36)}`;
    const paneId = recordedId ?? `${id}:p1`;
    const pane: Pane = { ...structuredClone(paneTemplate), pane_id: paneId, tab_id: `${id}:t1`, terminal_id: `${id}:term`, workspace_id: id, focused: false, agent: spec.agent, agent_status: spec.agent ? spec.state ?? "idle" : "unknown", revision: 1 };
    snap.panes.push(pane);
    addAgent(pane);
    snap.tabs.push({ ...structuredClone(tabTemplate), tab_id: pane.tab_id, workspace_id: id, number: 1, label: "1", agent_status: pane.agent_status, focused: false, pane_count: 1 });
    snap.workspaces.push({ ...structuredClone(workspaceTemplate), workspace_id: id, active_tab_id: pane.tab_id, agent_status: pane.agent_status, focused: false, pane_count: 1, tab_count: 1 });
    addDemoLayout(id, pane.tab_id, paneId);
    keyOfPane.set(paneId, spec.key);
  }
  for (const spec of SPECS) {
    const pane = paneOfKey(spec.key)!;
    const parent = spec.tabOf ? paneOfKey(spec.tabOf) : undefined;
    const cwd = pathOf(parent ? SPECS.find((candidate) => candidate.key === spec.tabOf)! : spec);
    Object.assign(pane, { label: spec.title, cwd, foreground_cwd: cwd });
    const agent = snap.agents.find((entry) => entry.pane_id === pane.pane_id);
    if (agent) Object.assign(agent, { cwd, foreground_cwd: cwd });
    const workspace = snap.workspaces.find((candidate) => candidate.workspace_id === pane.workspace_id)!;
    if (!parent) {
      workspace.label = spec.label;
      continue;
    }
    const tab = snap.tabs.find((candidate) => candidate.tab_id === pane.tab_id)!;
    // a recording staged with the tab already in its parent's workspace only takes the spec's label
    if (pane.workspace_id === parent.workspace_id) {
      tab.label = spec.label;
      continue;
    }
    // the spec's own workspace folds into its parent's as the next tab
    const own = pane.workspace_id;
    const into = parent.workspace_id;
    const number = snap.tabs.filter((tab) => tab.workspace_id === into).length + 1;
    const tabId = `${into}:t${number}`;
    const layout = snap.layouts.find((candidate) => candidate.tab_id === pane.tab_id);
    Object.assign(tab, { tab_id: tabId, workspace_id: into, number, label: spec.label, focused: false });
    if (layout) Object.assign(layout, { tab_id: tabId, workspace_id: into });
    Object.assign(pane, { tab_id: tabId, workspace_id: into, focused: false });
    if (agent) Object.assign(agent, { tab_id: tabId, workspace_id: into });
    snap.workspaces = snap.workspaces.filter((candidate) => candidate.workspace_id !== own);
    const host = snap.workspaces.find((candidate) => candidate.workspace_id === into)!;
    host.tab_count = number;
    host.pane_count = snap.panes.filter((candidate) => candidate.workspace_id === into).length;
  }
  // herdr's order is the specs' order: each repository, then its worktrees
  const rank = (workspaceId: string) => SPECS.findIndex((spec) => paneOfKey(spec.key)?.workspace_id === workspaceId && !spec.tabOf);
  snap.workspaces.sort((a, b) => rank(a.workspace_id) - rank(b.workspace_id));
  snap.workspaces.forEach((workspace, index) => { workspace.number = index + 1; });
  // a repository's checkouts: its own, then each linked worktree on its branch
  for (const spec of SPECS) {
    if (spec.tabOf) continue;
    const workspace = snap.workspaces.find((candidate) => candidate.workspace_id === paneOfKey(spec.key)!.workspace_id)!;
    const parent = spec.worktreeOf ? SPECS.find((candidate) => candidate.key === spec.worktreeOf) : undefined;
    const repo = repositoryAt(pathOf(parent ?? spec));
    if (spec.worktreeOf && spec.branch) {
      const path = pathOf(spec);
      repo.branches.add(spec.branch);
      repo.checkouts.push({ path, branch: spec.branch, label: spec.label, is_linked_worktree: true, is_bare: false, is_detached: false, is_prunable: false });
      workspace.worktree = worktreeMetadata(repo, path);
    } else workspace.worktree = worktreeMetadata(repo);
  }
}
layOutRoster();
for (const pane of snapshot().panes) if (keyOfPane.get(pane.pane_id) === "api") Object.assign(pane, { plan: { done: 1, total: planSteps.length, current: "Adding the replay metric" } });

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
  addDemoLayout(id, `${id}:t1`, pane.pane_id);
  if (agent) {
    keyOfPane.set(pane.pane_id, pane.pane_id);
    chats.set(pane.pane_id, { turns: [], metadata: { model: agent === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", reasoning_effort: "medium" } });
    conversationChanged(pane.pane_id);
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
const conversationVersions = new Map<string, number>();

// herdr names an unnamed tab by its place in the row and moves that name up when an earlier tab
// closes; a renamed tab keeps its name. The demo tracks which tabs still carry the automatic name.
const autoTabs = new Set<string>();
function relabelAutoTabs(workspaceId: string): void {
  // a tab that is gone is forgotten, so a later tab given its ID keeps the name it was created with
  const live = new Set(snapshot().tabs.map((tab) => tab.tab_id));
  for (const id of autoTabs) if (!live.has(id)) autoTabs.delete(id);
  let place = 0;
  for (const tab of snapshot().tabs) {
    if (tab.workspace_id !== workspaceId) continue;
    place += 1;
    if (autoTabs.has(tab.tab_id)) tab.label = String(place);
  }
}

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
  if (status === "done" && pane.agent_status !== "done") pane.finish_id = (pane.finish_id ?? 0) + 1;
  pane.agent_status = status;
  // as herdr does, every state change bumps the session's counter on the pane's agent
  const agent = snapshot().agents.find((entry) => entry.pane_id === paneId);
  if (agent) Object.assign(agent, { agent_status: status, state_change_seq: nextStateSeq() });
  for (const workspace of snapshot().workspaces) if (workspace.workspace_id === pane.workspace_id) workspace.agent_status = status;
  for (const tab of snapshot().tabs) if (tab.tab_id === pane.tab_id) tab.agent_status = status;
  const message: ServerMessage = { type: "pane-status", pane_id: paneId, agent_status: status, finish_id: pane.finish_id, finish_epoch: snapshot().finish_epoch };
  emitSse({ type: "machine-message", machine_id: local.id, message });
  for (const socket of sockets) socket.push(message);
}

function conversationChanged(paneId: string): void {
  const revision = (conversationVersions.get(paneId) ?? 0) + 1;
  conversationVersions.set(paneId, revision);
  for (const socket of sockets) socket.push({ type: "conversation-changed", pane_id: paneId, signature: `demo:${revision}` });
}

function structureChanged(): void {
  emitSse({ type: "machines", machines });
  emitSse({ type: "machine-message", machine_id: local.id, message: { type: "session-changed" } });
  for (const socket of sockets) socket.push({ type: "session-changed" });
}

/** A click in herdr focuses the pane, its tab and its workspace while preserving other tabs' own focus. */
function focusDemoPane(pane: Pane): void {
  const snap = snapshot();
  snap.focused_pane_id = pane.pane_id;
  snap.focused_tab_id = pane.tab_id;
  snap.focused_workspace_id = pane.workspace_id;
  const layout = snap.layouts.find((candidate) => candidate.tab_id === pane.tab_id);
  if (layout) {
    layout.focused_pane_id = pane.pane_id;
    for (const candidate of layout.panes) candidate.focused = candidate.pane_id === pane.pane_id;
  }
  for (const candidate of snap.panes) candidate.focused = candidate.pane_id === pane.pane_id;
  for (const tab of snap.tabs) tab.focused = tab.tab_id === pane.tab_id;
  for (const workspace of snap.workspaces) {
    workspace.focused = workspace.workspace_id === pane.workspace_id;
    if (workspace.focused) workspace.active_tab_id = pane.tab_id;
  }
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
  conversationChanged(paneId);
  const agent = agentOf(paneId);
  if (replying.has(paneId)) return;
  replying.add(paneId);
  setStatus(paneId, "working");
  setTimeout(() => {
    chat.turns.push({ role: "assistant", ts: now(), end_ts: now(), parts: [{ kind: "text", phase: "final_answer", text: `This is the demo, so nothing ran. In the real app that message went to ${agent} in this pane, and its answer would be written here as it arrives, with its commands and edits folded above it.` }] });
    conversationChanged(paneId);
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
        ? [{ kind: "text", phase: "final_answer", text: "Understood, I won't push. The changes stay on `feat/export-guard` locally; tell me what to do differently." }]
        : [{ kind: "tool", name: "exec", summary: "git push origin feat/export-guard", input: JSON.stringify({ cmd: "git push origin feat/export-guard" }, null, 2), output: "To github.com:acme/checkout-api.git\n * [new branch]      feat/export-guard -> feat/export-guard" },
          { kind: "text", phase: "final_answer", text: "Pushed `feat/export-guard`. The export button is guarded and the branch is ready for a pull request." }],
    });
    if (chat) conversationChanged(paneId);
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

async function layoutBodyOf(method: string, init: RequestInit | undefined, input: RequestInfo | URL): Promise<Record<string, unknown> | Response> {
  if (method !== "POST") return error("method_not_allowed", "use POST", 400);
  let body: unknown;
  try { body = init?.body ? JSON.parse(String(init.body)) : input instanceof Request ? await input.clone().json() : undefined; }
  catch { return error("invalid_json", "request body must be JSON", 400); }
  if (body === undefined) return error("invalid_json", "request body must be JSON", 400);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return error("invalid_body", "request body must be a JSON object", 400);
  return body as Record<string, unknown>;
}

const DEMO_FILES = ["src/routes/payments.ts", "src/lib/idempotency.ts", "src/metrics.ts", "src/pages/Reports.tsx", "src/money.ts", "src/money.test.ts", "package.json", "README.md"];

/**
 * The demo repository's uncommitted work, as GET /api/workspace/diff/* answers it: one file of
 * each kind a diff view has to draw. The patches are what git would print, hunk counts included.
 */
const DEMO_DIFF_LIMITS = { max_files: 2000, max_list_bytes: 2 * 1024 * 1024, max_patch_bytes: 1024 * 1024, context_lines: 3 };
const DEMO_DIFF: { file: RepoDiffFile; patch: string | null }[] = [
  { file: { path: "docs/checkout-flow.png", old_path: null, status: "modified", additions: null, deletions: null, binary: true }, patch: null },
  { file: { path: "src/lib/idempotency.ts", old_path: "src/idempotency.ts", status: "renamed", additions: 0, deletions: 0, binary: false }, patch: [
    "diff --git a/src/idempotency.ts b/src/lib/idempotency.ts",
    "similarity index 100%",
    "rename from src/idempotency.ts",
    "rename to src/lib/idempotency.ts",
    "",
  ].join("\n") },
  { file: { path: "src/money.test.ts", old_path: null, status: "untracked", additions: null, deletions: null, binary: false }, patch: [
    "diff --git a/src/money.test.ts b/src/money.test.ts",
    "new file mode 100644",
    "index 0000000..5d2e8c1",
    "--- /dev/null",
    "+++ b/src/money.test.ts",
    "@@ -0,0 +1,6 @@",
    "+import { expect, it } from \"bun:test\";",
    "+import { toCents } from \"./money.ts\";",
    "+",
    "+it(\"rounds half a cent away from zero\", () => {",
    "+  expect(toCents(10.075)).toBe(1008);",
    "+});",
    "",
  ].join("\n") },
  { file: { path: "src/money.ts", old_path: null, status: "modified", additions: 4, deletions: 1, binary: false }, patch: [
    "diff --git a/src/money.ts b/src/money.ts",
    "index 3f1c2aa..9b7d410 100644",
    "--- a/src/money.ts",
    "+++ b/src/money.ts",
    "@@ -1,5 +1,8 @@",
    " export type Cents = number;",
    " ",
    "+/** Rounds half away from zero, so 10.075 is 1008 cents and not 1007. */",
    " export function toCents(amount: number): Cents {",
    "-  return amount * 100;",
    "+  const scaled = Math.abs(amount) * 100;",
    "+  const rounded = Math.round(scaled + Number.EPSILON * scaled);",
    "+  return Math.sign(amount) * rounded;",
    " }",
    "",
  ].join("\n") },
];

/** Settings → Subscription usage on the demo: plans as the workstation's CLIs might report them, resets counted from now. */
function usageReport(): UsageReport {
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  // Claude and Codex state a window's length (5 h, 7 days), so the server knows when it began; the others do not
  const session = (hours: number) => ({ resets_at: at(hours), starts_at: at(hours - 5) });
  const week = (hours: number) => ({ resets_at: at(hours), starts_at: at(hours - 168) });
  const checked = new Date(now).toISOString();
  return { providers: [
    { id: "claude", key: "claude:demo-claude", account: "sam@example.com", plan: "max", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 38, ...session(2.4) },
      { kind: "week", scope: null, used_percent: 61, ...week(78) },
      { kind: "week", scope: "Sonnet", used_percent: 12, ...week(78) },
    ] },
    { id: "codex", key: "codex:demo-codex-work", account: "sam@work.example", plan: "pro", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 22, ...session(1.2) },
      { kind: "week", scope: null, used_percent: 84, ...week(97) },
    ] },
    { id: "codex", key: "codex:demo-codex-home", account: "sam@example.com", plan: "plus", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 5, ...session(3.1) },
      { kind: "week", scope: null, used_percent: 31, ...week(140) },
    ] },
    { id: "cursor", key: "cursor:demo-cursor", account: "sam@example.com", plan: "pro", problem: null, checked_at: checked, windows: [
      { kind: "month", scope: null, used_percent: 27, resets_at: at(290), starts_at: null },
      { kind: "month", scope: "Cursor models", used_percent: 19, resets_at: at(290), starts_at: null },
      { kind: "month", scope: "Other models", used_percent: 8, resets_at: at(290), starts_at: null },
    ] },
    { id: "opencode", key: "opencode:demo-opencode", account: null, plan: "Go", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 10, resets_at: at(3.2), starts_at: null },
      { kind: "week", scope: null, used_percent: 28, resets_at: at(18), starts_at: null },
      { kind: "month", scope: null, used_percent: 15, resets_at: at(520), starts_at: null },
    ] },
  ] };
}

/** One fictional plugin, so the palette's Plugin actions group and Settings have something to show. */
const PLUGINS: PluginActions[] = [
  { plugin_id: "example.layout", name: "Layout", version: "0.1.0", description: "Apply project layouts", enabled: true, actions: [
    { action_id: "apply", title: "Apply layout", description: "Arrange this workspace's panes", contexts: ["workspace"] },
    { action_id: "save", title: "Save layout", description: null, contexts: ["workspace"] },
  ] },
];

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
  if (path === "/api/integrations") return json({ integrations: integrationsFixture } satisfies IntegrationsResponse);
  if (path === "/api/updates") return json({ managed: false, auto_update: false, phase: "idle", current_revision: null, latest_revision: null, current_version: __APP_VERSION__, latest_version: null, available: false, checked_at: null, blocked_reason: null, error: null }, 200, { "cache-control": "no-store" });
  if (path === "/api/updates/notes") return json({ revision: null, releases: [], omitted: 0 }, 200, { "cache-control": "no-store" });
  if (path === "/api/updates/installed") return json({ revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 }, 200, { "cache-control": "no-store" });
  // the demo has no herdr to update: the controls stay hidden
  // the demo sends no counts: a server without telemetry answers 404, and the app shows neither its notice nor its switch
  // Connection breadcrumbs stay inside the fictional demo; never send them to a real endpoint.
  if (path === "/api/connection-diagnostics") return new Response(null, { status: 204 });
  if (path === "/api/telemetry") return json({ error: { code: "not_found", message: "This server sends no telemetry" } }, 404, { "cache-control": "no-store" });
  if (path === "/api/herdr/update") return json({ supported: false, phase: "idle", server_version: null, binary_version: null, stale: false, output: null, finished_at: null }, 200, { "cache-control": "no-store" });
  // the demo opens no public address: the Portal section stays hidden
  if (path === "/api/portal") return json({ supported: false, version: null, min_version: "v2.6.1", usable: false, phase: "idle", relay: null, url: null, blocked: null, error: null, output: null } satisfies PortalStatus, 200, { "cache-control": "no-store" });
  if (path === "/api/portal/start" || path === "/api/portal/stop") return error("portal_unsupported", "The demo opens no public address.", 409);
  if (path === "/api/access") return json({ port: 7317, tailscale: { state: "running", dns_name: "workstation.example.ts.net", serving_url: "https://workstation.example.ts.net", serve_command: null, serve_url: null } });
  if (path === "/api/usage") return json(usageReport(), 200, { "cache-control": "no-store" });
  if (path === "/api/usage/login") {
    if (method === "GET") {
      if (url.searchParams.has("provider")) return json({ accounts: url.searchParams.get("provider") === "cursor" ? ["cursor@example.test"] : [] });
      return json({ providers: [
        { id: "claude", cli: "claude", installed: true, local: true, separate_home: true },
        { id: "codex", cli: "codex", installed: true, local: true, separate_home: true },
        { id: "cursor", cli: "Cursor CLI (agent)", installed: true, local: true, separate_home: false },
        { id: "copilot", cli: "GitHub CLI (gh)", installed: true, local: true, separate_home: false },
        { id: "grok", cli: "grok", installed: false, local: true, separate_home: false },
        { id: "antigravity", cli: "Antigravity CLI (agy)", installed: true, local: false, separate_home: false },
        { id: "opencode", cli: "opencode", installed: true, local: true, separate_home: false },
      ] });
    }
    return error("demo", "This demo cannot run a local CLI. Sign in on an installed server.", 409);
  }
  // Public demo never saves management credentials or starts a real OAuth login.
  if (path === "/api/cliproxy") {
    if (method === "GET") return json({ configured: false, url: "http://localhost:8317", ok: false, problem: null });
    return error("demo", "Connect CLIProxyAPI from an installed server, not the public demo.", 409);
  }
  if (path === "/api/cliproxy/login" || path === "/api/cliproxy/callback") return error("demo", "Sign in from an installed server, not the public demo.", 409);
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
    const source = agent === "claude" ? "claude-transcript" : agent === "codex" ? "codex-transcript" : agent === "gjc" ? "gjc-transcript" : agent === "omo" ? "omo-transcript" : agent === "pi" ? "pi-transcript" : agent === "devin" ? "devin-transcript" : agent === "hermes" ? "hermes-transcript" : "omp-transcript";
    // These demo fixtures have no native Grok/Agy lifecycle: omit optional activity.
    return json({ source, turns: chat.turns, metadata: chat.metadata, cursor: null });
  }
  if (path === "/api/pane/plan") {
    if (method !== "GET") return error("method_not_allowed", "use GET", 400);
    if (!paneId) return error("missing_pane_id", "pane_id query parameter is required", 400);
    return json({ plan: keyOfPane.get(paneId) === "api" ? { steps: planSteps } : null, server_time: new Date().toISOString() } satisfies PanePlan);
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
  if (path === "/api/pane/scroll") {
    const body = method === "POST" ? await bodyOf(init, input) : {};
    const target = method === "POST" ? String(body["pane_id"] ?? "") : paneId;
    if (!target) return error("missing_pane_id", "pane_id is required", 400);
    if (!paneOf(target)) return error("pane_not_found", "pane not found", 404);
    const history = histories.get(target);
    if (method === "POST") {
      const offset = body["offset_from_bottom"];
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return error("invalid_offset", "offset_from_bottom must be a non-negative integer", 400);
      history?.setOffset(offset);
      if (history) redrawHistory(target);
    } else if (method !== "GET") return error("method_not_allowed", "use GET or POST", 400);
    return json({ scroll: history?.scroll() ?? { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: demoGrid(target).rows } });
  }
  if (path === "/api/pane/find") {
    if (method !== "POST") return error("method_not_allowed", "use POST", 400);
    const body = await bodyOf(init, input);
    const target = body["pane_id"];
    if (typeof target !== "string" || target.length === 0) return error("missing_pane_id", "pane_id is required", 400);
    if (typeof body["query"] !== "string" || body["query"].length === 0 || body["query"].length > 1024) return error("invalid_query", "query must contain 1 to 1024 characters", 400);
    if (body["direction"] !== "forward" && body["direction"] !== "backward") return error("invalid_direction", "direction must be forward or backward", 400);
    if (body["jump"] !== undefined && typeof body["jump"] !== "boolean") return error("invalid_jump", "jump must be a boolean", 400);
    const point = (value: unknown): value is { row: number; col: number } => {
      if (!value || typeof value !== "object") return false;
      const { row, col } = value as { row: unknown; col: unknown };
      return typeof row === "number" && Number.isSafeInteger(row) && row >= 0 && row <= 0xffffffff
        && typeof col === "number" && Number.isSafeInteger(col) && col >= 0 && col <= 0xffff;
    };
    const previous = body["previous"] as Partial<PaneFindMatch> | undefined;
    const revision = body["content_revision"];
    if (previous !== undefined && (!previous || !point(previous.start) || !point(previous.end) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) return error("invalid_previous", "previous requires two history cells and content_revision", 400);
    if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) return error("invalid_revision", "content_revision must be a non-negative integer", 400);
    if (!paneOf(target)) return error("pane_not_found", "pane not found", 404);
    const history = histories.get(target);
    if (!history) return error("find_unavailable", "Type demo logs in a demo shell to browse and search fictional log history.", 404);
    if (previous && revision !== history.revision) return error("stale_content", "Pane changed. Search again.", 409);
    const request: PaneFindRequest = {
      pane_id: target, query: body["query"], direction: body["direction"],
      ...(typeof body["jump"] === "boolean" ? { jump: body["jump"] } : {}),
      ...(previous && point(previous.start) && point(previous.end) ? { previous: { start: previous.start, end: previous.end }, content_revision: revision as number } : {}),
    };
    const result = history.find(request);
    if (request.jump !== false && result.match) redrawHistory(target);
    return json(result);
  }
  if (path === "/api/pane/omo-tasks") return json({ tasks: [], runs: [] });
  if (path === "/api/pane/files") {
    const q = (query.get("q") ?? "").toLowerCase();
    return json({ files: DEMO_FILES.filter((file) => file.toLowerCase().includes(q)).slice(0, Number(query.get("limit") ?? 20)) });
  }
  if (path === "/api/pane/input" || path === "/api/pane/keys") return json({ ok: true });
  if (path === "/api/plugins/actions") return json({ plugins: PLUGINS } satisfies PluginActionsResponse);
  if (path === "/api/plugin/action") {
    // nothing here is ever left running, so no run is asked about again
    if (method === "GET") return error("plugin_log_not_found", "plugin log not found", 404);
    const body = await bodyOf(init, input);
    const known = PLUGINS.some((plugin) => plugin.plugin_id === body["plugin_id"] && plugin.actions.some((action) => action.action_id === body["action_id"]));
    if (!known) return error("plugin_action_not_found", "plugin action not found", 404);
    // the demo runs nothing: the action reads as done
    return json({ log_id: "demo", status: "succeeded", exit_code: 0, output: null, opened_pane_id: null } satisfies PluginActionResult);
  }
  if (path === "/api/pane/rename") {
    const body = await bodyOf(init, input);
    const pane = paneOf(String(body["pane_id"] ?? ""));
    if (!pane) return error("not_found", "no such pane", 404);
    pane.label = String(body["label"] ?? "") || null;
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/agent/rename") {
    const body = await bodyOf(init, input);
    const paneId = String(body["pane_id"] ?? "");
    const name = body["name"];
    if (name !== null && typeof name !== "string") return error("invalid_name", "name must be a string, or null to clear it", 400);
    const agent = snapshot().agents.find((entry) => entry.pane_id === paneId);
    if (!agent) return error("agent_not_found", `agent target ${paneId} not found`, 404);
    // herdr's refusals, in its words and with the status the server gives them
    if (name !== null && !isAgentName(name)) return error("invalid_agent_name", "agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)", 404);
    const holder = name === null ? undefined : snapshot().agents.find((entry) => entry.name === name && entry.pane_id !== paneId);
    if (holder) return error("agent_name_taken", `agent name ${name} is already used; candidates: pane_id=${holder.pane_id} workspace_id=${holder.workspace_id}`, 404);
    agent.name = name;
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
    const closedLayout = snap.layouts.find((layout) => layout.tab_id === pane.tab_id);
    if (closedLayout) closeLayoutPane(closedLayout, pane.pane_id);
    for (const socket of sockets) socket.holdPending(pane.pane_id, "pane_not_found", "This demo pane closed. Copy the message before discarding it.");
    replying.delete(pane.pane_id);
    snap.panes = snap.panes.filter((candidate) => candidate.pane_id !== pane.pane_id);
    const survivingPanes = snap.panes.filter((candidate) => candidate.workspace_id === pane.workspace_id);
    snap.tabs = snap.tabs.filter((tab) => tab.workspace_id !== pane.workspace_id || survivingPanes.some((candidate) => candidate.tab_id === tab.tab_id));
    relabelAutoTabs(pane.workspace_id);
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
  if (path === "/api/layout/ratio") {
    const body = await layoutBodyOf(method, init, input);
    if (body instanceof Response) return body;
    if (typeof body["tab_id"] !== "string" || !body["tab_id"].trim()) return error("missing_tab_id", "tab_id is required", 400);
    const steps = body["path"];
    if (!Array.isArray(steps) || !steps.every((step) => typeof step === "boolean")) return error("invalid_path", "path must be an array of booleans", 400);
    const ratio = body["ratio"];
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) return error("invalid_ratio", "ratio must be a number from 0.1 to 0.9", 400);
    const layout = snapshot().layouts.find((candidate) => candidate.tab_id === body["tab_id"]);
    if (!layout) return error("layout_not_found", "layout target not found", 404);
    if (!setLayoutSplitRatio(layout, steps, ratio)) return error("split_not_found", "split path not found", 404);
    structureChanged();
    return json({ ok: true });
  }
  // herdr's layout operations on the demo's own layouts: a split halves the pane's rect for a new
  // shell pane, a zoom flips the tab's flag (after focusing the pane, as herdr does), a swap
  // exchanges two rects, a resize moves the ratio of the split the border belongs to and lays its
  // panes out again (src/lib/layoutTree.ts), and a clear blanks the pane's screen on every socket attached to it
  if (path === "/api/pane/split" || path === "/api/pane/zoom" || path === "/api/pane/swap" || path === "/api/pane/resize" || path === "/api/pane/clear" || path === "/api/pane/focus") {
    const body = await layoutBodyOf(method, init, input);
    if (body instanceof Response) return body;
    if (typeof body["pane_id"] !== "string" || !body["pane_id"].trim()) return error("missing_pane_id", "pane_id is required", 400);
    const pane = paneOf(body["pane_id"]);
    const snap = snapshot();
    const layout = pane ? snap.layouts.find((candidate) => candidate.tab_id === pane.tab_id) : undefined;
    const cell = layout?.panes.find((candidate) => candidate.pane_id === pane?.pane_id);
    if (!pane || !layout || !cell) return error("pane_not_found", "pane not found", 404);
    if (path === "/api/pane/focus") {
      focusDemoPane(pane);
      structureChanged();
      return json({ ok: true });
    }
    if (path === "/api/pane/clear") {
      histories.get(pane.pane_id)?.clear();
      for (const socket of sockets) socket.clearScreen(pane.pane_id);
      return json({ ok: true });
    }
    if (path === "/api/pane/split") {
      const direction = body["direction"];
      if (direction !== "right" && direction !== "down") return error("invalid_direction", "direction must be right or down", 400);
      const focus = body["focus"] === true;
      const serial = (nextWorkspace++).toString(36);
      const made: Pane = { ...structuredClone(pane), pane_id: `${pane.workspace_id}:p${serial}`, terminal_id: `${pane.workspace_id}:term${serial}`, label: null, title: null, agent: null, agent_session: null, agent_status: "unknown", focused: focus, terminal_title: null, terminal_title_stripped: null, revision: 1 };
      if (!splitLayout(layout, pane.pane_id, { pane_id: made.pane_id, focused: focus, rect: cell.rect }, direction)) {
        return error("split_failed", "The demo pane is too small to split.", 400);
      }
      snap.panes.push(made);
      if (focus) focusDemoPane(made);
      const tab = snap.tabs.find((candidate) => candidate.tab_id === pane.tab_id);
      if (tab) tab.pane_count += 1;
      const workspace = snap.workspaces.find((candidate) => candidate.workspace_id === pane.workspace_id);
      if (workspace) workspace.pane_count += 1;
      structureChanged();
      return json({ ok: true, pane: made } satisfies PaneSplit);
    }
    if (path === "/api/pane/zoom") {
      const mode = body["mode"] ?? "toggle";
      if (mode !== "toggle" && mode !== "on" && mode !== "off") return error("invalid_mode", "mode must be toggle, on or off", 400);
      // herdr focuses the pane before it reads the mode, or counts the panes: a zoomed tab then
      // shows this pane alone even when the flag's answer is already_zoomed
      const moved = layout.focused_pane_id !== pane.pane_id;
      focusDemoPane(pane);
      const answer = (zoomed: boolean, changed: boolean, reason: string | null) => {
        if (moved || changed) structureChanged();
        return json({ ok: true, zoomed, changed: moved || changed, reason } satisfies PaneZoomed);
      };
      if (layout.panes.length < 2) return answer(layout.zoomed, false, "single_pane");
      const zoomed = mode === "toggle" ? !layout.zoomed : mode === "on";
      if (zoomed === layout.zoomed) return answer(zoomed, false, zoomed ? "already_zoomed" : "already_unzoomed");
      layout.zoomed = zoomed;
      return answer(zoomed, true, null);
    }
    const direction = body["direction"];
    const beside = (side: PaneDirection) => { const id = neighborPane(layout, pane.pane_id, side); return id === null ? undefined : layout.panes.find((candidate) => candidate.pane_id === id); };
    if (path === "/api/pane/swap") {
      const target = body["target_pane_id"];
      if (target !== undefined && direction !== undefined) return error("invalid_pane_swap", "provide exactly one of direction or target_pane_id", 400);
      if (target !== undefined) {
        if (typeof target !== "string" || !target.trim()) return error("invalid_target_pane_id", "target_pane_id must be a non-empty string", 400);
        const other = paneOf(target);
        const reason = !other ? "not_found" : other.pane_id === pane.pane_id ? "same_pane" : other.tab_id !== pane.tab_id ? "cross_tab" : null;
        if (reason) return json({ ok: true, changed: false, reason, target_pane_id: target } satisfies PaneSwapped);
        swapLayoutPanes(layout, pane.pane_id, target);
        focusDemoPane(pane);
        structureChanged();
        return json({ ok: true, changed: true, reason: null, target_pane_id: target } satisfies PaneSwapped);
      }
      if (direction !== "left" && direction !== "right" && direction !== "up" && direction !== "down") return error("invalid_direction", "direction must be left, right, up or down", 400);
      const other = beside(direction);
      if (!other) return json({ ok: true, changed: false, reason: "no_neighbor", target_pane_id: null } satisfies PaneSwapped);
      swapLayoutPanes(layout, pane.pane_id, other.pane_id);
      focusDemoPane(pane);
      structureChanged();
      return json({ ok: true, changed: true, reason: null, target_pane_id: other.pane_id } satisfies PaneSwapped);
    }
    if (direction !== "left" && direction !== "right" && direction !== "up" && direction !== "down") return error("invalid_direction", "direction must be left, right, up or down", 400);
    const amount = body["amount"];
    if (amount !== undefined && (typeof amount !== "number" || !(amount > 0) || amount > 0.5)) return error("invalid_amount", "amount must be a number above 0 and at most 0.5", 400);
    const resized = resizeLayout(layout, pane.pane_id, direction, amount ?? 0.05);
    if (!resized) return json({ ok: true, changed: false, reason: "unchanged" } satisfies PaneResized);
    layout.panes = resized;
    structureChanged();
    return json({ ok: true, changed: true, reason: null } satisfies PaneResized);
  }
  if (path === "/api/tab/rename") {
    const body = await bodyOf(init, input);
    const tab = snapshot().tabs.find((t) => t.tab_id === body["tab_id"]);
    if (!tab) return error("tab_not_found", "no such tab", 404);
    const label = String(body["label"] ?? "").trim();
    if (label === "") return error("missing_label", "label is required", 400);
    tab.label = label;
    autoTabs.delete(tab.tab_id);
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/tab/move") {
    const body = await bodyOf(init, input);
    if (typeof body["tab_id"] !== "string" || !body["tab_id"]) return error("missing_tab_id", "tab_id is required", 400);
    const insertIndex = body["insert_index"];
    if (typeof insertIndex !== "number" || !Number.isSafeInteger(insertIndex) || insertIndex < 0) return error("invalid_index", "insert_index must be a non-negative safe integer", 400);
    const snap = snapshot();
    const tab = snap.tabs.find((entry) => entry.tab_id === body["tab_id"]);
    if (!tab) return error("tab_not_found", "no such tab", 404);
    const tabs = snap.tabs.filter((entry) => entry.workspace_id === tab.workspace_id);
    if (insertIndex > tabs.length) return error("tab_move_failed", "insert_index exceeds the tab count", 404);
    const source = tabs.indexOf(tab);
    const target = source < insertIndex ? insertIndex - 1 : insertIndex;
    tabs.splice(source, 1);
    tabs.splice(target, 0, tab);
    let place = 0;
    snap.tabs = snap.tabs.map((entry) => entry.workspace_id === tab.workspace_id ? tabs[place++]! : entry);
    relabelAutoTabs(tab.workspace_id);
    structureChanged();
    return json({ ok: true, tabs } satisfies TabMoved);
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
    autoTabs.delete(tab.tab_id);
    relabelAutoTabs(tab.workspace_id);
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
    const workspace = snap.workspaces.find((w) => w.workspace_id === body["workspace_id"]);
    if (!workspace) return error("not_found", "no such workspace", 404);
    const ids = snap.workspaces.map((workspace) => workspace.workspace_id);
    const order = movedTabOrder(ids, workspace.workspace_id, Number(body["insert_index"] ?? 0));
    if (order) snap.workspaces.sort((a, b) => order.indexOf(a.workspace_id) - order.indexOf(b.workspace_id));
    snap.workspaces.forEach((w, i) => { w.number = i + 1; });
    structureChanged();
    return json({ ok: true });
  }
  if (path === "/api/workspace/directories" && method === "POST") {
    // New folder: the demo has no disk, so the folder opens empty and is not listed again
    const body = await bodyOf(init, input);
    const name = String(body["name"] ?? "").trim();
    if (name === "" || name === "." || name === ".." || /[/\\]/.test(name)) return error("invalid_name", "name must be one folder name", 400);
    const parent = String(body["path"] ?? "/home/demo");
    return json({ path: `${parent.replace(/\/$/, "")}/${name}` }, 201);
  }
  if (path === "/api/workspace/directories") {
    const dir = query.get("path") || "/home/demo";
    return json({ path: dir, parent: dir === "/" ? null : dir.replace(/\/[^/]*$/, "") || "/", home: "/home/demo", directories: dir === "/home/demo" ? ["checkout-api", "cli-tools"] : [], truncated: false, files: [] });
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
    const label = String(body["label"] ?? "");
    snap.tabs.push({ ...structuredClone(snap.tabs[0]!), tab_id: tabId, workspace_id: id, label, number, agent_status: pane.agent_status, focused: false, pane_count: 1 });
    addDemoLayout(id, tabId, pane.pane_id);
    if (label === "") autoTabs.add(tabId);
    else autoTabs.delete(tabId);
    relabelAutoTabs(id);
    workspace.tab_count = tabs.length + 1;
    workspace.pane_count = siblings.length + 1;
    if (agent) {
      keyOfPane.set(pane.pane_id, pane.pane_id);
      chats.set(pane.pane_id, { turns: [], metadata: { model: agent === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", reasoning_effort: "medium" } });
      conversationChanged(pane.pane_id);
      setTimeout(() => { if (!replying.has(pane.pane_id)) finishDemoTurn(pane.pane_id, "idle"); }, 1500);
    }
    structureChanged();
    return json({ workspace_id: id, pane_id: pane.pane_id, agent_started: agent !== null } satisfies WorkspaceCreated);
  }
  // no key in the demo: the app falls back to the browser's own speech recognition
  if (path === "/api/voice") return json({ configured: false, source: null, ...VOICE_DEFAULTS } satisfies VoiceStatus, 200, { "cache-control": "no-store" });
  if (path === "/api/voice/config") return error("demo", "the demo saves no OpenAI key", 409);
  if (path === "/api/voice/transcribe") return error("voice_not_configured", "transcription is unavailable in the demo", 409);
  if (path === "/api/workspace/diff/files" || path === "/api/workspace/diff/file") {
    const scope = query.get("scope") || "workspace";
    if (scope !== "workspace" && scope !== "staged" && scope !== "commit") return error("invalid_scope", "scope must be workspace, staged or commit", 400);
    // the demo keeps no history to name commits in
    if (scope === "commit") return error("revision_not_found", "the demo repository has no commits to compare", 404);
    const root = snapshot().panes.find((pane) => pane.pane_id === paneId)?.cwd ?? query.get("directory") ?? "/home/demo/checkout-api";
    // a worktree's checkout is on its own branch, as the sidebar and the footer say
    const branch = [...repositories.values()].flatMap((repo) => repo.checkouts).find((checkout) => checkout.path === root)?.branch ?? "main";
    const repository: RepoDiffRepository = { root, branch, head: "4f2a9c1d7e3b5a8c6d0e1f2a3b4c5d6e7f8a9b0c", detached: false, unborn: false };
    // everything in the demo is unstaged work
    const changed = scope === "workspace" ? DEMO_DIFF : [];
    const compared: RepoDiffScope = scope;
    const shared = { repository, scope: compared, base: null, head: null };
    if (path === "/api/workspace/diff/files") {
      return json({ ...shared, files: changed.map((entry) => entry.file), total: changed.length, truncated: false, limits: { max_files: DEMO_DIFF_LIMITS.max_files, max_list_bytes: DEMO_DIFF_LIMITS.max_list_bytes } } satisfies RepoDiffFileList);
    }
    const entry = changed.find((candidate) => candidate.file.path === query.get("path"));
    if (!entry) return error("not_found", "nothing changed at that path in this comparison", 404);
    return json({ ...shared, file: entry.file, patch: entry.patch, unavailable: entry.patch === null ? "binary" : null, truncated: false, limits: { max_patch_bytes: DEMO_DIFF_LIMITS.max_patch_bytes, context_lines: DEMO_DIFF_LIMITS.context_lines } } satisfies RepoDiffFilePatch);
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
  private readonly conversationInterests = new Set<string>();
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
      this.push({ type: "snapshot", snapshot: snapshot(), features: ["submit", "pending-input", "pending-hold", "secret-input", "input-ready", "conversation-watch", "ping"] });
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
    if (message.type === "conversation-changed" && (!this.attached.has(message.pane_id) || !this.conversationInterests.has(message.pane_id))) return;
    if (message.type === "pty-exit") {
      this.attached.delete(message.pane_id);
      this.conversationInterests.delete(message.pane_id);
    }
    if (message.type === "session-changed") {
      for (const paneId of this.attached) {
        if (!paneOf(paneId)) {
          this.attached.delete(paneId);
          this.conversationInterests.delete(paneId);
        }
      }
    }
    const event = new MessageEvent("message", { data: JSON.stringify(message) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  send(raw: string): void {
    if (this.readyState !== 1) return;
    let message: { type: string; pane_id?: string; cols?: number; rows?: number; text?: string; payload?: string; keys?: string[]; id?: number; mode?: string; typed?: unknown; delivery?: unknown; clear_draft?: unknown; send_anyway?: unknown; resend_id?: unknown; resend_generation?: unknown; pending_id?: string; action?: unknown; enabled?: boolean; stop?: unknown; keep_size?: boolean };
    try { message = JSON.parse(raw); } catch { return; }
    if ((message.type === "submit" || message.type === "pending-action") && Number.isSafeInteger(message.id)) {
      const signature = JSON.stringify({ type: message.type, pane_id: message.pane_id, text: message.text, payload: message.payload, typed: message.typed, delivery: message.delivery, clear_draft: message.clear_draft, send_anyway: message.send_anyway, resend_id: message.resend_id, resend_generation: message.resend_generation, pending_id: message.pending_id, action: message.action });
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
      case "presence":
        // the demo sends no alerts, so whether the page is in use holds nothing back
        break;
      // the demo socket never goes half-open, but it answers the liveness probe as the server does
      case "ping":
        if (Number.isSafeInteger(message.id)) this.push({ type: "pong", id: message.id! });
        break;
      case "attach":
        if (message.pane_id) {
          // keep_size (the chat lens) and an observer leave the shared grid alone and learn it instead
          const keepsSize = message.keep_size === true || this.mode === "observe";
          if (!keepsSize) this.resizeGrid(message.pane_id, message.cols, message.rows);
          this.attach(message.pane_id);
          const grid = demoGrid(message.pane_id);
          if (keepsSize && this.attached.has(message.pane_id)) this.push({ type: "pane-geometry", pane_id: message.pane_id, ...grid });
        }
        break;
      case "resize":
        if (message.pane_id && this.attached.has(message.pane_id) && this.mode === "interact") this.resizeGrid(message.pane_id, message.cols, message.rows);
        break;
      // the demo page is its pane's only terminal: no other grid to hand the pty to, and the server answers nothing
      case "release-size":
        break;
      // The demo has no competing attach slots and does not advertise this capability.
      case "take-over":
        this.push({ type: "error", code: "unsupported", message: "The demo has no competing terminal attachments.", pane_id: message.pane_id });
        break;
      // Nor a read-only view: the site's page never lets go of its pane, and a watch ends at once.
      case "watch": if (message.pane_id) this.push({ type: "watch-end", pane_id: message.pane_id }); break;
      case "unwatch": break;
      case "detach":
        if (message.pane_id) {
          this.attached.delete(message.pane_id);
          this.holdPending(message.pane_id, "not_attached", "This pane was detached. Pending messages will not be sent automatically.");
          this.conversationInterests.delete(message.pane_id);
        }
        break;
      case "conversation-watch":
        if (typeof message.pane_id !== "string" || message.pane_id.trim() === "" || typeof message.enabled !== "boolean") {
          this.push({ type: "error", code: "invalid_conversation_watch", message: "pane_id must be a nonempty string and enabled must be a boolean" });
        } else if (message.enabled) {
          if (!this.attached.has(message.pane_id)) {
            this.push({ type: "error", code: "not_attached", message: "conversation interest requires an attached pane", pane_id: message.pane_id });
          } else {
            this.conversationInterests.add(message.pane_id);
          }
        } else {
          this.conversationInterests.delete(message.pane_id);
        }
        break;
      // a Stop (`stop`) is typed like any key: the demo has no pty for a following message to overtake
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
          if (message.resend_id !== undefined && message.send_anyway !== undefined) {
            this.completeRequest({ type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code: "invalid_delivery", message: "Use a held-copy resend id only for an immediate chat message" });
            break;
          }
          const queued = message.delivery === "queue" || message.delivery === "hold";
          for (const [key, receipt] of heldCopyResends) if (Date.now() - receipt.at >= 60_000) heldCopyResends.delete(key);
          const resendKey = message.resend_id === undefined ? null : JSON.stringify([message.pane_id, message.resend_id, message.resend_generation ?? 0]);
          const previous = resendKey === null ? undefined : heldCopyResends.get(resendKey);
          if (previous && this.mode !== "observe" && message.clear_draft === undefined) {
            this.push(previous.text === message.text ? { ...previous.reply, id: message.id }
              : { type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code: "invalid_submit_id", message: "This resend id already belongs to another message." });
            break;
          }
          const text = queued ? message.text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n") : message.text;
          let code: string | null = null;
          if ((message.delivery !== undefined && message.delivery !== "immediate" && !queued) || (queued && message.typed !== undefined && message.typed !== false)) code = "invalid_delivery";
          else if (message.clear_draft !== undefined && (typeof message.clear_draft !== "string" || !message.clear_draft
            || queued || (message.typed !== undefined && message.typed !== false))) code = "invalid_delivery";
          else if (message.send_anyway !== undefined && (message.send_anyway !== true || queued || message.clear_draft !== undefined
            || (message.typed !== undefined && message.typed !== false))) code = "invalid_delivery";
          else if (this.mode === "observe") code = "read_only";
          // the demo agent never refuses over its input box, so there is nothing to clear or send over
          else if (message.clear_draft !== undefined || message.send_anyway !== undefined) code = "unsupported";
          else if (message.resend_id !== undefined && (typeof message.resend_id !== "string" || !message.resend_id || message.resend_id.length > 128 || queued || message.typed === true)) code = "invalid_delivery";
          else if (message.resend_generation !== undefined && (typeof message.resend_generation !== "number" || !Number.isSafeInteger(message.resend_generation) || message.resend_generation < 0 || message.resend_id === undefined)) code = "invalid_delivery";
          else if (resendKey !== null && heldCopyResends.size >= 256) code = "pending_limit";
          else if (queued && (text.trim().length === 0 || text.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))) code = "invalid_submit_text";
          else if (queued) code = this.pendingTargetError(message.pane_id);
          if (code) {
            const reply: Extract<ServerMessage, { type: "submit-result" }> = { type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code, message: "The demo agent cannot take this submission." };
            if (resendKey !== null && this.mode !== "observe" && code !== "pending_limit" && !previous) heldCopyResends.set(resendKey, { text: message.text, reply, at: Date.now() });
            this.completeRequest(reply);
            break;
          }
          if (queued && (message.delivery === "hold" || paneOf(message.pane_id)?.agent_status === "working")) {
            const pending: PendingMessage = { id: `demo-pending-${nextPending++}`, request_id: message.id, text, state: message.delivery === "hold" ? "held" : "queued", created_at: now() };
            this.pending.set(message.pane_id, [...(this.pending.get(message.pane_id) ?? []), pending]);
            const reply: ServerMessage = { type: "submit-result", id: message.id, pane_id: message.pane_id, ok: true, pending: structuredClone(pending) };
            this.rememberRequest(reply);
            this.publishPending(message.pane_id);
            this.push(reply);
          } else {
            submitToChat(message.pane_id, text);
            const reply: Extract<ServerMessage, { type: "submit-result" }> = { type: "submit-result", id: message.id, pane_id: message.pane_id, ok: true };
            if (resendKey !== null) heldCopyResends.set(resendKey, { text: message.text, reply, at: Date.now() });
            this.completeRequest(reply);
          }
        }
        break;
      case "pending-action":
        if (message.id !== undefined && message.pane_id && message.pending_id) {
          const result = (ok: boolean, code?: string) => this.completeRequest({ type: "pending-result", id: message.id!, pane_id: message.pane_id!, pending_id: message.pending_id!, ok, ...(code ? { code, message: "The demo pending message was not changed." } : {}) });
          if (message.action !== "steer" && message.action !== "discard") { result(false, "invalid_pending_action"); break; }
          if (message.resend_generation !== undefined && (typeof message.resend_generation !== "number" || !Number.isSafeInteger(message.resend_generation) || message.resend_generation < 0)) {
            result(false, "invalid_pending_action"); break;
          }
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
            const key = JSON.stringify([message.pane_id, pending.id, message.resend_generation ?? 0]);
            for (const [id, receipt] of heldCopyResends) if (Date.now() - receipt.at >= 60_000) heldCopyResends.delete(id);
            const previous = heldCopyResends.get(key);
            if (previous) {
              if (previous.text !== pending.text) { result(false, "invalid_submit_id"); break; }
              if (previous.reply.ok) this.removePending(message.pane_id, pending.id, "sent");
              result(previous.reply.ok, previous.reply.code);
              break;
            }
            if (heldCopyResends.size >= 256) { result(false, "pending_limit"); break; }
            const resendResult = (ok: boolean, code?: string) => {
              heldCopyResends.set(key, { text: pending.text, at: Date.now(), reply: {
                type: "submit-result", id: message.id!, pane_id: message.pane_id!, ok, ...(code ? { code } : {}),
              } });
              result(ok, code);
            };
            const code = this.pendingTargetError(message.pane_id);
            if (code) { resendResult(false, code); break; }
            if (pending.state === "uncertain") { result(false, "pending_uncertain"); break; }
            const sent = this.deliverPending(message.pane_id, pending);
            resendResult(sent, sent ? undefined : pending.error?.code ?? "pending_changed");
          }
        }
        break;
      default: /* pty-ack: nothing to do in the demo */
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

  /** herdr's pane.clear: the screen goes blank with the cursor at home; what the program writes next shows again */
  clearScreen(paneId: string): void {
    if (this.attached.has(paneId)) this.push({ type: "pty-data", pane_id: paneId, data: "\x1b[2J\x1b[H" });
  }

  private resizeGrid(paneId: string, cols: number | undefined, rows: number | undefined): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols! < 2 || rows! < 1 || cols! > 1000 || rows! > 1000) return;
    const before = terminalGrids.get(paneId);
    terminalGrids.set(paneId, { cols: cols!, rows: rows! });
    // like the server: a changed grid reaches every client of the pane, this one included even if it is still attaching
    if (before?.cols !== cols || before?.rows !== rows) {
      for (const socket of sockets) if (socket === this || socket.attached.has(paneId)) socket.push({ type: "pane-geometry", pane_id: paneId, cols: cols!, rows: rows! });
    }
    if (histories.get(paneId)?.resize(cols!, rows!)) redrawHistory(paneId);
  }

  renderHistory(paneId: string): void {
    const history = histories.get(paneId);
    if (history && this.attached.has(paneId)) this.push({ type: "pty-data", pane_id: paneId, data: history.render() });
  }

  private attach(paneId: string): void {
    const pane = paneOf(paneId);
    if (!pane) {
      this.attached.delete(paneId);
      this.conversationInterests.delete(paneId);
      this.push({ type: "error", code: "pane_not_found", message: "no such pane", pane_id: paneId });
      return;
    }
    this.attached.add(paneId);
    this.publishPending(paneId);
    this.push({ type: "input-ready", pane_id: paneId });
    const key = keyOfPane.get(paneId);
    if (histories.has(paneId)) { this.renderHistory(paneId); return; }
    if (key === "shell") {
      let at = 0;
      let previous = 0;
      for (const frame of terminalFixture.frames) {
        at += Math.min(MAX_FRAME_GAP_MS, frame.at - previous);
        previous = frame.at;
        this.later(() => { if (this.attached.has(paneId) && !histories.has(paneId)) this.push({ type: "pty-data", pane_id: paneId, data: frame.data }); }, at);
      }
      return;
    }
    if (pane && !pane.agent && !chats.has(paneId)) {
      // a shell the demo user started: an empty prompt
      this.later(() => { if (this.attached.has(paneId) && !histories.has(paneId)) this.push({ type: "pty-data", pane_id: paneId, data: "\x1b[2J\x1b[H" + PROMPT_TEXT }); }, 60);
      return;
    }
    this.later(() => this.push({ type: "pty-data", pane_id: paneId, data: NOTICE }), 60);
  }

  /** the pretend shell: echo, backspace, and a few commands it knows */
  private typed(paneId: string, text: string): void {
    const pane = paneOf(paneId);
    if (!pane || pane.agent || chats.has(paneId) || this.mode === "observe") return;
    let history = histories.get(paneId);
    // xterm sends SGR wheel reports once demo history has enabled mouse reporting.
    text = text.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_report, value: string) => {
      const button = Number(value);
      if (history && (button & 64) !== 0) history.setOffset(history.offset + ((button & 1) === 0 ? 3 : -3));
      return "";
    });
    let line = this.lines.get(paneId) ?? "";
    let out = "";
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        const command = line.trim();
        line = "";
        if (command === "demo logs") {
          const grid = demoGrid(paneId);
          const revision = (history?.revision ?? 0) + 2;
          history = new DemoHistory(grid.cols, grid.rows);
          history.revision = revision;
          histories.set(paneId, history);
          out = "";
          continue;
        }
        const answer = command ? (SHELL_COMMANDS[command] ?? SHELL_COMMANDS[command.replace(/\s+--.*$/, "")] ?? (command.startsWith("git log") ? SHELL_COMMANDS["git log"] : `bash: ${command.split(" ")[0]}: command not found`)) : "";
        if (history) {
          history.append([...(answer ? answer.replace(/\x1b\[[0-9;]*m/g, "").split("\r\n") : []), "release $ "]);
        } else out += "\r\n" + (answer ? answer + "\r\n" : "") + PROMPT_TEXT;
      } else if (ch === "\x7f" || ch === "\b") {
        if (line.length > 0) { line = line.slice(0, -1); out += "\b \b"; history?.setPrompt("release $ " + line); }
      } else if (ch === "\x03") {
        line = ""; out += "^C\r\n" + PROMPT_TEXT;
        if (history) { history.setPrompt("release $ ^C"); history.append(["release $ "]); }
      } else if (ch >= " ") {
        line += ch; out += ch;
        history?.setPrompt("release $ " + line);
      }
    }
    this.lines.set(paneId, line);
    if (history) redrawHistory(paneId);
    else if (out) this.push({ type: "pty-data", pane_id: paneId, data: out });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.holdPending();
    for (const timer of this.timers) clearTimeout(timer);
    sockets.delete(this);
    this.attached.clear();
    this.conversationInterests.clear();
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
  const turn = chat?.turns.filter((turn) => turn.role === "assistant" && !turn.end_ts).at(-1);
  if (!chat || !turn || turn.role !== "assistant") return;
  turn.parts.push(
    { kind: "tool", name: "Bash", summary: "bun test metrics", input: JSON.stringify({ command: "bun test metrics" }, null, 2), output: " 6 pass\n 0 fail\nRan 6 tests across 1 file. [201ms]" },
    { kind: "text", phase: "final_answer", text: "Added `payments_idempotent_replays_total`, incremented where a stored response is replayed, and exposed with the other counters on `/metrics`. 6 tests pass." },
  );
  turn.end_ts = now();
  conversationChanged(paneId);
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
