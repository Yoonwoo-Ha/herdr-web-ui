import { stripVTControlCharacters } from "node:util";
import { ConnectionDiagnostics, transportFailureCode } from "../connection-diagnostics.ts";
import type {
  AgentIntegration,
  PaneDirection,
  PaneReadResult,
  ReadFormat,
  ReadSource,
  SessionSnapshot,
  SplitPaneDirection,
  PaneFindRequest,
  PaneFindResponse,
  PaneFindMatch,
} from "../../shared/protocol.ts";
import type { AgentInfo, AgentManifestInfo, AgentStartParams, PaneInfo, PaneLayoutSnapshot, PaneProcessInfo, PaneScrollInfo, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";
import type { HerdrMethod, HerdrMethods, SingleHerdrMethod, UntypedHerdrMethod } from "./methods.ts";
import type { HerdrIdentity } from "../../shared/machines.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const diagnostics = new ConnectionDiagnostics("herdr.rpc");
let pendingRpcs = 0;

/** herdr's default socket: ~/.config/herdr on Unix, %APPDATA%\herdr on Windows. */
export function herdrSocketPath(): string {
  if (process.env.HERDR_SOCKET) return process.env.HERDR_SOCKET;
  if (process.platform === "win32") return `${process.env.APPDATA ?? ""}\\herdr\\herdr.sock`;
  return `${process.env.HOME ?? ""}/.config/herdr/herdr.sock`;
}

/**
 * On Windows herdr.sock is a marker file (`pid:start`), and the server listens on a named
 * pipe of the same name: `\\.\pipe\C:\Users\…\herdr.sock` (live-verified, herdr 0.9.3).
 */
export function socketAddress(socketPath: string): string {
  return process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** herdr's `terminal attach` exists on Unix only (herdrdev/herdr#4821); its ping does not say so yet. */
export function terminalAttachSupported(capabilities?: Record<string, unknown>): boolean {
  const declared = capabilities?.["direct_terminal_attach"];
  return typeof declared === "boolean" ? declared : process.platform !== "win32";
}

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

let requestCounter = 0;
function nextId(): string {
  requestCounter += 1;
  return `br-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * Splits a growing buffer into complete newline-terminated frames.
 * herdr frames arrive split across reads, so partial tails must be retained.
 */
function makeLineReader(onLine: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

/**
 * One request, one connection.
 * The herdr server closes the connection after a single response, so a pooled
 * or reused socket would never see a second reply.
 *
 * `guard`, when given, is asked once more right before the request is written: the
 * connect is awaited, and a caller's right to send can lapse meanwhile. A guard that
 * answers false sends nothing and rejects with `cancelled`.
 */
export function herdrRpc<M extends HerdrMethod>(
  method: SingleHerdrMethod<M>,
  params: HerdrMethods[M]["params"],
  socketPath?: string,
  timeoutMs?: number,
  guard?: () => boolean,
): Promise<HerdrMethods[M]["result"]>;
/**
 * Untyped fallback for a method `HerdrMethods` does not list yet. Outside server/herdr/ only
 * tests, scripts and the files in HERDR_RPC_ALLOWED (server/conventions.test.ts) may call it;
 * server code adds a typed wrapper here instead. It rejects a typed method only when `M` is
 * inferred from a literal: with an explicit result type (`herdrRpc<T>("pane.process_info", …)`)
 * or a method typed as plain `string`, `M` is `string` and any params compile. Closing that
 * needs this fallback under its own name, left to the follow-up PR that moves the
 * HERDR_RPC_ALLOWED files to the wrappers once their open PRs land.
 */
export function herdrRpc<T = unknown, M extends string = string>(
  method: UntypedHerdrMethod<M>,
  params: Record<string, unknown>,
  socketPath?: string,
  timeoutMs?: number,
  guard?: () => boolean,
): Promise<T>;
export async function herdrRpc(
  method: string,
  params: object,
  socketPath: string = herdrSocketPath(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  guard?: () => boolean,
): Promise<unknown> {
  const id = nextId();
  const started = performance.now();
  const key = JSON.stringify([socketPath, method]); // private bookkeeping only; never logged
  let connectedAt: number | undefined;
  pendingRpcs++;
  const fields = () => ({
    operation: method, request_id: id, elapsed_ms: performance.now() - started,
    connect_ms: connectedAt === undefined ? undefined : connectedAt - started,
    timeout_ms: timeoutMs, pending: Math.max(0, pendingRpcs - 1),
    phase: connectedAt === undefined ? "connect" as const : "response" as const,
  });
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let socket: { end: () => void } | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          socket?.end();
        } catch {
          /* the server may already have closed it */
        }
        fn();
      };

      timer = setTimeout(
        () => finish(() => reject(new HerdrError("timeout", `herdr ${method} timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );

      const handleLine = (line: string) => {
        let frame: { id?: string; result?: unknown; error?: { code?: string; message?: string } };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          finish(() => reject(new HerdrError("bad_frame", `herdr sent unparseable frame: ${line.slice(0, 200)}`)));
          return;
        }
        if (frame.error) {
          const { code = "herdr_error", message = "herdr request failed" } = frame.error;
          finish(() => reject(new HerdrError(code, message)));
          return;
        }
        finish(() => resolve(frame.result));
      };

      const onData = makeLineReader(handleLine);

      Bun.connect({
        unix: socketAddress(socketPath),
        socket: {
          data(_sock, chunk) {
            onData(chunk);
          },
          error(_sock, err) {
            finish(() => reject(new HerdrError("socket_error", err?.message ?? "herdr socket error")));
          },
          close() {
            finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
          },
        },
      })
        .then((sock) => {
          connectedAt = performance.now();
          socket = sock;
          if (settled) {
            try {
              sock.end();
            } catch {
              /* already gone */
            }
            return;
          }
          if (guard && !guard()) {
            finish(() => reject(new HerdrError("cancelled", `herdr ${method} was not sent: the sender may no longer send`)));
            return;
          }
          sock.write(`${JSON.stringify({ id, method, params })}\n`);
        })
        .catch((err: Error) => {
          finish(() =>
            reject(new HerdrError("connect_failed", `cannot reach herdr at ${socketPath}: ${err.message}`)),
          );
        });
    });
    diagnostics.recovered(key, fields());
    return result;
  } catch (error) {
    const code = error instanceof HerdrError ? transportFailureCode(error.code) : null;
    if (code !== null) diagnostics.failed(key, code, fields());
    throw error;
  } finally {
    pendingRpcs--;
  }
}

export async function ping(socketPath?: string): Promise<HerdrIdentity> {
  const result = await herdrRpc<{ version: string; protocol: number; capabilities?: Record<string, unknown> }>("ping", {}, socketPath);
  const attach = terminalAttachSupported(result.capabilities);
  // without attach the web server repaints the pane's screen instead (server/mirror.ts)
  return { version: result.version, protocol: result.protocol, terminal_attach: attach, ...(attach ? {} : { terminal_mirror: true }) };
}

export async function sessionSnapshot(socketPath?: string, timeoutMs?: number): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {}, socketPath, timeoutMs);
  return result.snapshot;
}

/** One pane's metadata; an unknown pane rejects with herdr's `pane_not_found`. */
export async function paneGet(paneId: string, socketPath?: string): Promise<PaneInfo> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.get", { pane_id: paneId }, socketPath);
  return result.pane;
}

export async function agentManifests(socketPath?: string): Promise<{ manifests: AgentManifestInfo[] }> {
  return herdrRpc("server.agent_manifests", {}, socketPath);
}

/** herdr's `InstalledPluginInfo`, the fields the bridge reads. */
export interface InstalledPluginInfo {
  plugin_id: string;
  name: string;
  version: string;
  description?: string | null;
  enabled: boolean;
}

/** herdr's `PluginActionInfo`. `platforms` null or absent: every platform. */
export interface PluginActionInfo {
  plugin_id: string;
  action_id: string;
  title: string;
  description?: string | null;
  contexts?: string[];
  command: string[];
  platforms?: string[] | null;
}

/**
 * herdr's `PluginInvocationContext`. herdr takes each field as given and fills a missing one
 * from its own focus, never from the pane or workspace another field names (measured on 0.9.3:
 * `focused_pane_id` alone came back with the focused workspace's ID and label).
 */
export interface PluginInvocationContext {
  workspace_id?: string;
  workspace_label?: string;
  workspace_cwd?: string;
  worktree?: unknown;
  tab_id?: string;
  tab_label?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  focused_pane_agent?: string;
  focused_pane_status?: string;
  invocation_source?: string;
}

/** herdr's `PluginCommandLogInfo`. */
export interface PluginCommandLog {
  log_id: string;
  plugin_id: string;
  action_id?: string | null;
  status: "running" | "succeeded" | "failed" | (string & {});
  exit_code?: number | null;
  error?: string | null;
  stdout?: string | null;
  stderr?: string | null;
}

export async function pluginList(socketPath?: string): Promise<InstalledPluginInfo[]> {
  return (await herdrRpc<{ plugins: InstalledPluginInfo[] }>("plugin.list", {}, socketPath)).plugins;
}

/** Every plugin's manifest actions, a disabled plugin's and another platform's included. */
export async function pluginActionList(socketPath?: string): Promise<PluginActionInfo[]> {
  return (await herdrRpc<{ actions: PluginActionInfo[] }>("plugin.action.list", {}, socketPath)).actions;
}

/** Starts the action's command and answers at once: its log entry is still `running`. */
export async function pluginActionInvoke(
  pluginId: string,
  actionId: string,
  context?: PluginInvocationContext,
  socketPath?: string,
): Promise<{ log: PluginCommandLog }> {
  return herdrRpc("plugin.action.invoke", { plugin_id: pluginId, action_id: actionId, ...(context === undefined ? {} : { context }) }, socketPath);
}

export async function pluginLogList(pluginId: string, limit: number, socketPath?: string, timeoutMs?: number): Promise<PluginCommandLog[]> {
  return (await herdrRpc<{ logs: PluginCommandLog[] }>("plugin.log.list", { plugin_id: pluginId, limit }, socketPath, timeoutMs)).logs;
}

/** herdr's built-in agent integrations and whether each is installed. Read only: this bridge never installs one. */
export async function integrationList(socketPath?: string): Promise<AgentIntegration[]> {
  return (await herdrRpc<{ integrations: AgentIntegration[] }>("integration.list", {}, socketPath)).integrations;
}

export interface WorkspaceCreateResult {
  type: "workspace_created";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
}

export async function workspaceCreate(
  options: { cwd?: string; label?: string; env?: Record<string, string> },
  socketPath?: string,
): Promise<WorkspaceCreateResult> {
  return herdrRpc(
    "workspace.create",
    { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.label === undefined ? {} : { label: options.label }), ...(options.env === undefined ? {} : { env: options.env }), focus: false },
    socketPath,
  );
}

export interface TabCreateResult {
  type: "tab_created";
  tab: TabInfo;
  root_pane: PaneInfo;
}

/** Another tab in an existing workspace. Without `cwd` herdr uses the workspace's folder. */
export async function tabCreate(
  options: { workspaceId: string; cwd?: string; label?: string; env?: Record<string, string> },
  socketPath?: string,
): Promise<TabCreateResult> {
  return herdrRpc(
    "tab.create",
    { workspace_id: options.workspaceId, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.label === undefined ? {} : { label: options.label }), ...(options.env === undefined ? {} : { env: options.env }), focus: false },
    socketPath,
  );
}

/** herdr keeps the label as given: an empty one leaves the tab without a name, so callers refuse it. */
export async function tabRename(tabId: string, label: string, socketPath?: string): Promise<void> {
  await herdrRpc("tab.rename", { tab_id: tabId, label }, socketPath);
}

/** Native insertion boundary (before removal), within this tab's workspace; focus is unchanged. */
export async function tabMove(tabId: string, insertIndex: number, socketPath?: string): Promise<{
  type: "tab_list"; tabs: TabInfo[];
}> {
  return herdrRpc("tab.move", { tab_id: tabId, insert_index: insertIndex }, socketPath);
}

/** Closes the tab and every pane in it; a workspace's last tab takes the workspace with it. */
export async function tabClose(tabId: string, socketPath?: string): Promise<void> {
  await herdrRpc("tab.close", { tab_id: tabId }, socketPath);
}

export async function agentStart(
  options: { name: string; kind: string; paneId: string; args?: string[]; timeoutMs?: number },
  socketPath?: string,
): Promise<unknown> {
  return herdrRpc(
    "agent.start",
    {
      name: options.name,
      kind: options.kind,
      pane_id: options.paneId,
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
    } satisfies AgentStartParams,
    socketPath,
    options.timeoutMs,
  );
}

export async function paneRename(paneId: string, label: string | null, socketPath?: string): Promise<void> {
  await herdrRpc("pane.rename", { pane_id: paneId, label }, socketPath);
}

/**
 * The live name other tools address the agent in the pane by (`herdr agent prompt <name>`); null
 * clears it. herdr keeps the rule: invalid_agent_name for a name outside it, agent_name_taken for
 * one another live agent holds, agent_not_found for a pane without a live agent.
 */
export async function agentRename(paneId: string, name: string | null, socketPath?: string): Promise<AgentInfo> {
  const answer = await herdrRpc<{ type: "agent_info"; agent: AgentInfo }>("agent.rename", { target: paneId, name }, socketPath);
  return answer.agent;
}

export async function workspaceRename(workspaceId: string, label: string, socketPath?: string): Promise<void> {
  await herdrRpc("workspace.rename", { workspace_id: workspaceId, label }, socketPath);
}

export async function workspaceMove(workspaceId: string, insertIndex: number, socketPath?: string): Promise<void> {
  await herdrRpc("workspace.move", { workspace_id: workspaceId, insert_index: insertIndex }, socketPath);
}

/** closeGroup takes a repository workspace's open worktree workspaces with it; herdr refuses otherwise. */
export async function workspaceClose(workspaceId: string, socketPath?: string, closeGroup = false): Promise<void> {
  await herdrRpc("workspace.close", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) }, socketPath);
}

/** `git worktree add` or `remove` on a large checkout can take well over the default 10 s. */
const WORKTREE_GIT_TIMEOUT_MS = 60_000;

/** `git worktree remove` of the workspace's checkout; herdr closes the workspace with it and keeps the branch. */
export async function worktreeRemove(workspaceId: string, force: boolean, socketPath?: string): Promise<{ type: "worktree_removed"; workspace_id: string; path: string; forced: boolean }> {
  return herdrRpc("worktree.remove", { workspace_id: workspaceId, force }, socketPath, WORKTREE_GIT_TIMEOUT_MS);
}

/** herdr's view of one git checkout: `worktree.list` entries, and what create/open hand back. */
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  label: string;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  open_workspace_id: string | null;
}

export interface WorktreeSourceInfo {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  source_checkout_path: string;
  source_workspace_id: string | null;
}

export interface WorktreeOpenResult {
  type: "worktree_created" | "worktree_opened";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
  worktree: WorktreeInfo;
  /** worktree_opened only: the checkout was a workspace before the call */
  already_open?: boolean;
}

/** A git worktree of the workspace's repository, opened as a new workspace grouped with it. */
export async function worktreeCreate(
  options: { workspaceId: string; branch: string; base?: string; label?: string; path?: string },
  socketPath?: string,
): Promise<WorktreeOpenResult> {
  return herdrRpc("worktree.create", {
    workspace_id: options.workspaceId,
    branch: options.branch,
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.path === undefined ? {} : { path: options.path }),
    focus: false,
  }, socketPath, WORKTREE_GIT_TIMEOUT_MS);
}

export async function worktreeList(workspaceId: string, socketPath?: string): Promise<{ source: WorktreeSourceInfo; worktrees: WorktreeInfo[] }> {
  return herdrRpc("worktree.list", { workspace_id: workspaceId }, socketPath);
}

export async function worktreeOpen(
  options: { workspaceId: string; path?: string; branch?: string; label?: string },
  socketPath?: string,
): Promise<WorktreeOpenResult> {
  return herdrRpc("worktree.open", {
    workspace_id: options.workspaceId,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.label === undefined ? {} : { label: options.label }),
    focus: false,
  }, socketPath);
}

export interface PaneReadOptions {
  paneId: string;
  source?: ReadSource;
  format?: ReadFormat;
  lines?: number;
  stripAnsi?: boolean;
  /** how long the answer is waited for; herdrRpc's default otherwise */
  timeoutMs?: number;
}

export async function paneRead(options: PaneReadOptions, socketPath?: string): Promise<PaneReadResult> {
  const { paneId, source = "visible", format = "text", lines, stripAnsi, timeoutMs } = options;
  // Escape sequences must survive for xterm.js, so an ansi read defaults to strip_ansi:false.
  const strip = stripAnsi ?? format !== "ansi";
  // Recent text reads can scroll an idle agent's TUI to harvest history. ANSI reads
  // only snapshot stored rows, so automatic polling must convert those to text locally.
  const passiveText = format === "text" && (source === "recent" || source === "recent_unwrapped");
  const params: Record<string, unknown> = { pane_id: paneId, source, format: passiveText ? "ansi" : format, strip_ansi: strip };
  if (lines !== undefined) params["lines"] = lines;
  const result = await herdrRpc<{ read: PaneReadResult }>("pane.read", params, socketPath, timeoutMs);
  return passiveText ? { ...result.read, format, text: strip ? stripVTControlCharacters(result.read.text) : result.read.text } : result.read;
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** Where the pane's viewport sits in its scrollback; null when herdr reports none. */
export async function paneScrollInfo(paneId: string, socketPath?: string): Promise<PaneScrollInfo | null> {
  const pane = await paneGet(paneId, socketPath);
  return pane.scroll ?? null;
}

/** Scrolls the pane's viewport; herdr redraws every attached terminal. */
export async function paneScroll(paneId: string, offsetFromBottom: number, socketPath?: string): Promise<PaneScrollInfo | null> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.scroll", { pane_id: paneId, offset_from_bottom: offsetFromBottom }, socketPath);
  return result.pane.scroll ?? null;
}

/** Copy search is stateless; scrolling is the same shared viewport used by herdr's TUI. */
export async function paneFind(request: PaneFindRequest, socketPath?: string): Promise<PaneFindResponse> {
  const scroll = await paneScrollInfo(request.pane_id, socketPath);
  const row = scroll ? scroll.max_offset_from_bottom - scroll.offset_from_bottom : 0;
  // pane.read.revision is NOT copy_search's content_revision. copy_motion supplies the latter
  // without entering copy mode or changing any client's cursor.
  const motion = await herdrRpc<{ cursor: PaneTextPoint; content_revision: number }>("pane.copy_motion", {
    pane_id: request.pane_id, cursor: { row, col: 0 }, motion: "line_end",
  }, socketPath);
  if (request.previous && request.content_revision !== motion.content_revision) {
    throw new HerdrError("stale_content", "Pane changed. Search again.");
  }
  const previous = request.previous;
  const result = await herdrRpc<{
    matches: PaneFindMatch[]; total: number; current?: number | null; current_global?: number | null; content_revision: number;
  }>("pane.copy_search", {
    pane_id: request.pane_id, query: request.query, direction: request.direction,
    cursor: previous?.start ?? (request.direction === "backward" ? motion.cursor : { row, col: 0 }),
    content_revision: motion.content_revision, ...(previous ? { previous } : {}),
  }, socketPath);
  const match = result.current == null ? null : result.matches[result.current] ?? null;
  let finalScroll: PaneScrollInfo | null;
  if (match && request.jump !== false) {
    // A browser resize can reflow history while searching. Use the viewport herdr has now,
    // not the one read to choose the search's starting cursor.
    const currentScroll = await paneScrollInfo(request.pane_id, socketPath);
    // Let herdr reject a reflow or history eviction after copy_search before moving the view.
    await herdrRpc("pane.copy_motion", {
      pane_id: request.pane_id, cursor: match.start, motion: "line_end", content_revision: result.content_revision,
    }, socketPath);
    finalScroll = currentScroll;
    if (currentScroll) {
      finalScroll = await paneScroll(request.pane_id, Math.max(0, currentScroll.max_offset_from_bottom - match.start.row), socketPath);
      // herdr 0.9.3 cannot guard pane.scroll atomically. Refuse success if output or reflow
      // arrived after the pre-scroll check; the shared view may already have moved.
      await herdrRpc("pane.copy_motion", {
        pane_id: request.pane_id, cursor: match.start, motion: "line_end", content_revision: result.content_revision,
      }, socketPath);
    }
  } else {
    finalScroll = await paneScrollInfo(request.pane_id, socketPath);
    // Scrolling does not change content_revision. A no-jump refresh must still refuse
    // coordinates whose viewport moved while the native match window was being read.
    if (request.jump === false && (
      scroll?.offset_from_bottom !== finalScroll?.offset_from_bottom
      || scroll?.max_offset_from_bottom !== finalScroll?.max_offset_from_bottom
      || scroll?.viewport_rows !== finalScroll?.viewport_rows
    )) throw new HerdrError("stale_content", "Pane changed. Search again.");
    // No match is an answer about one revision too: output since copy_search may hold the text.
    await herdrRpc("pane.copy_motion", {
      pane_id: request.pane_id, cursor: { row, col: 0 }, motion: "line_end", content_revision: result.content_revision,
    }, socketPath);
  }
  return {
    total: result.total, current: result.current_global == null ? null : result.current_global + 1,
    match, content_revision: result.content_revision, matches: result.matches, scroll: finalScroll,
  };
}

/**
 * The text between two cells of the pane's whole history, both inclusive, in either
 * order. Rows count from the top of the scrollback; soft-wrapped lines come back joined.
 */
export async function paneSelectionRead(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, socketPath?: string): Promise<string> {
  const result = await herdrRpc<{ text: string }>("pane.selection.read", { pane_id: paneId, anchor, cursor }, socketPath);
  return result.text;
}

/** What herdr knows of the processes in a pane's terminal (`pane.process_info`). */
export type ProcessInfo = PaneProcessInfo;

/**
 * The pane's shell and foreground processes, or undefined when herdr names none. Always by
 * `pane_id`: given `target`, herdr silently answers for the focused pane. Rejects as herdrRpc does.
 */
export async function paneProcessInfo(paneId: string, socketPath?: string): Promise<ProcessInfo | undefined> {
  return (await herdrRpc("pane.process_info", { pane_id: paneId }, socketPath)).process_info;
}

/** The agent herdr tracks in a pane (`agent.get`), including the session it reported. */
export async function agentGet(paneId: string, socketPath?: string): Promise<AgentInfo> {
  return (await herdrRpc("agent.get", { target: paneId }, socketPath)).agent;
}

export async function paneSendText(paneId: string, text: string, socketPath?: string, guard?: () => boolean): Promise<void> {
  await herdrRpc("pane.send_text", { pane_id: paneId, text }, socketPath, undefined, guard);
}

/**
 * herdr's own agent.prompt: pastes `text` into the pane's agent (bracketed), then its
 * Enter 300ms later, and returns after the Enter. Refuses with agent_blocked while the
 * agent waits for an answer, agent_not_found / agent_not_ready without an agent in front.
 */
export async function agentPrompt(target: string, text: string, socketPath?: string): Promise<void> {
  await herdrRpc("agent.prompt", { target, text }, socketPath);
}

export async function paneSendKeys(paneId: string, keys: string[], socketPath?: string, guard?: () => boolean): Promise<void> {
  await herdrRpc("pane.send_keys", { pane_id: paneId, keys }, socketPath, undefined, guard);
}

export async function paneClose(paneId: string, socketPath?: string): Promise<void> {
  await herdrRpc("pane.close", { pane_id: paneId }, socketPath);
}

/** Focuses this exact pane, its tab and workspace, as a click in herdr's TUI does. */
export async function paneFocus(paneId: string, socketPath?: string): Promise<void> {
  await herdrRpc("pane.focus", { pane_id: paneId }, socketPath);
}

/**
 * A new pane beside `paneId` (herdr's prefix+v / prefix+-), answered as herdr's snapshot lists it.
 * herdr's focus stays where it is unless `focus` asks for the new pane, as its --focus does.
 */
export async function paneSplit(paneId: string, direction: SplitPaneDirection, focus: boolean, socketPath?: string): Promise<PaneInfo> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.split", { target_pane_id: paneId, direction, focus }, socketPath);
  return result.pane;
}

/** How herdr answers a layout change: whether anything moved, why not, and the tab's layout after it. */
export interface PaneLayoutOutcome {
  changed: boolean;
  reason: string | null;
  focused_pane_id: string;
  layout: PaneLayoutSnapshot;
}

/** herdr's prefix+z: the tab shows the pane alone (and focuses it), or every pane again. */
export async function paneZoom(paneId: string, mode: "toggle" | "on" | "off", socketPath?: string): Promise<PaneLayoutOutcome & { zoomed: boolean }> {
  const result = await herdrRpc<{ zoom: PaneLayoutOutcome & { zoomed: boolean; reason?: string | null } }>("pane.zoom", { pane_id: paneId, mode }, socketPath);
  return { ...result.zoom, reason: result.zoom.reason ?? null };
}

/** herdr's prefix+shift+hjkl: the pane and its neighbour on that side change places; no_neighbor when it has none. */
export async function paneSwap(paneId: string, direction: PaneDirection, socketPath?: string): Promise<PaneLayoutOutcome & { target_pane_id: string | null }> {
  const result = await herdrRpc<{ swap: PaneLayoutOutcome & { target_pane_id?: string | null; reason?: string | null } }>("pane.swap", { pane_id: paneId, direction }, socketPath);
  return { ...result.swap, reason: result.swap.reason ?? null, target_pane_id: result.swap.target_pane_id ?? null };
}

/** Explicit swaps use source_pane_id, not the directional form's pane_id (herdr's PaneSwapParams). */
export async function paneSwapWith(paneId: string, targetPaneId: string, socketPath?: string): Promise<PaneLayoutOutcome & { target_pane_id: string | null }> {
  const result = await herdrRpc<{ swap: PaneLayoutOutcome & { target_pane_id?: string | null; reason?: string | null } }>("pane.swap", { source_pane_id: paneId, target_pane_id: targetPaneId }, socketPath);
  return { ...result.swap, reason: result.swap.reason ?? null, target_pane_id: result.swap.target_pane_id ?? null };
}

/** A split's absolute ratio: [] is the root, false descends first, true descends second. */
export async function layoutSetSplitRatio(tabId: string, path: boolean[], ratio: number, socketPath?: string): Promise<void> {
  await herdrRpc("layout.set_split_ratio", { tab_id: tabId, path, ratio }, socketPath);
}

/**
 * herdr's resize mode: the border the pane shares with a neighbour moves `direction`-wards by
 * `amount` of the split that border belongs to, measured on the split's own extent rather than
 * the tab's (herdr's own 0.05 when undefined; herdr caps it at 0.5 and holds the ratio to
 * 0.1..0.9). Measured on 0.9.3: the direction is the border's, so the left pane of a split
 * shrinks on `left` and the right one grows.
 */
export async function paneResize(paneId: string, direction: PaneDirection, amount: number | undefined, socketPath?: string): Promise<PaneLayoutOutcome> {
  const result = await herdrRpc<{ resize: PaneLayoutOutcome & { reason?: string | null } }>("pane.resize", { pane_id: paneId, direction, ...(amount === undefined ? {} : { amount }) }, socketPath);
  return { ...result.resize, reason: result.resize.reason ?? null };
}

/** Clears the pane's terminal screen, as herdr's own `pane clear` does. */
export async function paneClear(paneId: string, socketPath?: string): Promise<void> {
  await herdrRpc("pane.clear", { pane_id: paneId }, socketPath);
}

export interface HerdrSubscription {
  type: string;
  pane_id?: string;
  [key: string]: unknown;
}

export interface EventFrame {
  event?: string;
  data?: Record<string, unknown>;
}

export interface SubscribeHandlers {
  onEvent: (frame: EventFrame) => void;
  onStarted?: () => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface Subscription {
  close: () => void;
}

/**
 * Long-lived connection. Unlike ordinary RPC, events.subscribe keeps the socket
 * open and streams frames until the caller closes it.
 */
export function subscribeEvents(
  subscriptions: HerdrSubscription[],
  handlers: SubscribeHandlers,
  socketPath: string = herdrSocketPath(),
): Subscription {
  let closed = false;
  let socket: { end: () => void } | null = null;
  let started = false;

  const onData = makeLineReader((line) => {
    // closed by the caller: frames still buffered belong to a subscription it replaced
    if (closed) return;
    let frame: { id?: string; result?: { type?: string }; error?: { code?: string; message?: string } } & EventFrame;
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return;
    }
    if (frame.error) {
      handlers.onError?.(new HerdrError(frame.error.code ?? "herdr_error", frame.error.message ?? "subscription failed"));
      return;
    }
    if (!started && frame.result?.type === "subscription_started") {
      started = true;
      handlers.onStarted?.();
      return;
    }
    handlers.onEvent(frame);
  });

  Bun.connect({
    unix: socketAddress(socketPath),
    socket: {
      data(_sock, chunk) {
        onData(chunk);
      },
      error(_sock, err) {
        if (!closed) handlers.onError?.(new HerdrError("socket_error", err?.message ?? "herdr socket error"));
      },
      close() {
        if (!closed) {
          closed = true;
          handlers.onClose?.();
        }
      },
    },
  })
    .then((sock) => {
      socket = sock;
      if (closed) {
        try {
          sock.end();
        } catch {
          /* already gone */
        }
        return;
      }
      sock.write(`${JSON.stringify({ id: nextId(), method: "events.subscribe", params: { subscriptions } })}\n`);
    })
    .catch((err: Error) => {
      handlers.onError?.(new HerdrError("connect_failed", err.message));
      // a connect that never opened never closes either: report it as closed, or a
      // subscriber that retries on close (the status collector) waits forever after
      // one failed reconnect, e.g. while herdr restarts
      if (!closed) {
        closed = true;
        handlers.onClose?.();
      }
    });

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        socket?.end();
      } catch {
        /* already gone */
      }
    },
  };
}
