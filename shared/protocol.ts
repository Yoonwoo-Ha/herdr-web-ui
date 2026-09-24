/**
 * herdr-web-ui's own HTTP/WebSocket contract, shared by the Bun server and the React client.
 *
 * The herdr WIRE types are NOT hand-written here: they are generated from herdr's
 * published API schema into ./herdr-api.generated.ts and re-exported below, so a
 * herdr upgrade shows up as a failing `bun run generate:types --check` instead of
 * types that quietly disagree with the server.
 */

export type {
  AgentInfo,
  AgentSessionInfo,
  AgentStatus,
  PaneInfo,
  PaneReadResult,
  PaneScrollInfo,
  ReadFormat,
  ReadSource,
  SessionSnapshot,
  Subscription as HerdrSubscriptionSpec,
  TabInfo,
  WorkspaceInfo,
} from "./herdr-api.generated.ts";

import type { AgentStatus, PaneInfo, SessionSnapshot, TabInfo, WorkspaceInfo } from "./herdr-api.generated.ts";

/** Friendly aliases used across the UI. */
export type HerdrWorkspace = WorkspaceInfo;
export type HerdrTab = TabInfo;
export type HerdrPane = PaneInfo;

export type { Machine, MachineEvent, PaneTarget, SetupJob, SetupRequest, SetupAction, BridgeIdentity, BridgeHealth } from "./machines.ts";

/** Machine API (same token gate; mutations require X-Herdr-Machine: 1 + same origin)
 * GET /api/health?scope=bridge -> BridgeHealth, never waits for herdr
 * GET /api/bridge -> authenticated BridgeIdentity (socket + runtime compatibility)
 * GET /api/machines -> { machines: Machine[] }; GET /api/machines/events -> MachineEvent SSE
 * POST /api/machines/setup -> SetupJob; GET/POST/DELETE /api/machines/setup/:job_id
 * PATCH /api/machines/:id { name?, enabled? }; DELETE /api/machines/:id
 * /api/machines/:id/{session,agents,pane/*,workspace/*} -> existing target-local API
 * /ws?machine_id=:id -> immutable target, unchanged role + output ACK protocol
 * Legacy paths and missing machine IDs continue to mean local.
 */

/** HTTP API
 *  GET    /api/health                    -> { ok: true, herdr: { version, protocol }, auth: HealthAuth,
 *                                          web_ui: { boot_id: string | null, revision: string | null } }
 *  GET    /api/session                   -> { snapshot: SessionSnapshot }
 *  GET    /api/updates                   -> UpdateStatus (shared/update.ts), no-store
 *  POST   /api/updates/check             -> 202 { accepted: true }
 *  POST   /api/updates/install           -> 202 { accepted: true }
 *         Update POSTs require X-Herdr-Update: 1, same-origin browser requests,
 *         and the usual token gate. Managed starts only; status is polled during restart.
 *  GET    /api/agents                    -> { agents: AgentKind[] } (herdr's agent manifests: the
 *         kinds `agent.start` accepts, for the new-session dialog)
 *  GET    /api/pane/read?pane_id=&source=&format=&lines=  -> { read: PaneReadResult }
 *  POST   /api/pane/input  { pane_id, text }   -> { ok: true }
 *  GET    /api/pane/conversation?pane_id=    -> ConversationResponse (structured agent
 *         transcript turns - claude, codex, omp or omo; source:"scrollback" when the pane has no
 *         recognized store)
 *  POST   /api/pane/close { pane_id }         -> { ok: true } (pane.close RPC; the collector's
 *         session-changed broadcast removes it from every client's sidebar)
 *  POST   /api/pane/rename { pane_id, label } -> { ok: true } (pane.rename; empty label clears it)
 *  POST   /api/pane/image  { pane_id, content_type, data_base64 } -> { ok: true, path }
 *         pasted image -> file under <pane cwd>/.herdr-web-ui/, path for the prompt
 *  GET    /api/pane/commands?pane_id=   -> { commands: SlashCommand[] } (the agent's slash
 *         commands: built-ins per agent kind + the user's and the project's custom commands)
 *  GET    /api/pane/files?pane_id=&q=&limit=  -> { files: string[] } (paths relative to the pane
 *         cwd matching q, for @-mentions; git ls-files when the cwd is a repo, bounded walk otherwise)
 *  GET    /api/pane/prompt?pane_id=     -> { prompt: InteractivePrompt | null } (the agent's TUI
 *         question/approval menu currently on screen, parsed from the visible pane text)
 *  POST   /api/pane/prompt/answer { pane_id, prompt_id, option_index?, option_indices?, custom_text? }
 *         -> { ok: true } | 409 prompt_changed (the screen no longer shows that prompt)
 *  POST   /api/workspace/create { cwd?, label?, agent?: { kind, name?, args? } }
 *         -> WorkspaceCreated (workspace.create, then agent.start in the root pane when `agent` is given)
 *  POST   /api/workspace/rename { workspace_id, label } -> { ok: true }
 *  POST   /api/workspace/move   { workspace_id, insert_index } -> { ok: true } (sidebar reorder)
 *  POST   /api/workspace/close  { workspace_id } -> { ok: true }
 *  POST   /api/auth        { token }     -> 204 + Set-Cookie herdr_web_token (401 invalid_token on mismatch)
 *  DELETE /api/auth                      -> 204 + Set-Cookie herdr_web_token=; Max-Age=0
 *  GET    /api/push                      -> PushKey (the VAPID application server key)
 *  POST   /api/push/subscribe { subscription }  -> 204 (a browser PushSubscription JSON; upsert by endpoint)
 *  DELETE /api/push/subscribe { endpoint }      -> 204
 *  POST   /api/push/test      { endpoint }      -> 204 | 404 subscription_not_found | 502 push_failed
 *  Errors: non-2xx with { error: { code, message } }
 *
 *  Auth (only when the server was started with HERDR_WEB_TOKEN / token): every route
 *  above except /api/health and /api/auth, plus the /ws upgrade, needs the cookie or
 *  an `Authorization: Bearer <token>` header; without it HTTP answers 401
 *  `unauthorized` and the upgrade is refused. Static files are always public.
 */
export interface ApiError {
  error: { code: string; message: string };
}

/** GET /api/health `auth`: `required` is false when no token is configured, and then `authenticated` is true. */
export interface HealthAuth {
  readonly required: boolean;
  readonly authenticated: boolean;
}

/** GET /api/push: base64url VAPID public key, the `applicationServerKey` a browser subscribes with. */
export interface PushKey {
  readonly public_key: string;
}

/** One turn of a structured agent conversation (the chat lens source). */
export interface ConversationTurn {
  role: "user" | "assistant";
  ts: string | null;
  /** Last recorded assistant activity, never the next user's timestamp. */
  end_ts?: string;
  parts: ConversationPart[];
}

export type ConversationPart =
  | { kind: "text"; text: string; phase?: "commentary" | "final_answer" }
  /** the agent's reasoning block; the client folds it and shows it only on request */
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary: string; input: string; output: string };

/** Latest model settings actually recorded by this agent. */
export interface ConversationMetadata {
  model: string | null;
  /** Recorded reasoning effort / thinking level; null means not reported. */
  reasoning_effort: string | null;
}

/** GET /api/pane/conversation: native conversation with settings, or scrollback fallback. */
export interface ConversationResponse {
  source: "claude-transcript" | "omp-transcript" | "omo-transcript" | "codex-transcript" | "scrollback";
  turns: ConversationTurn[];
  metadata?: ConversationMetadata;
  /**
   * Where the first turn sits in the transcript: pass it as `before` for the page
   * of turns before these (with `since`, never reaching back past that cursor), or
   * as `from` to keep polling from it. A `from` answer starts later than `from` when
   * the newest page has moved past it: the turns in between come from `before` +
   * `since`. null at the conversation's beginning; absent for scrollback and from
   * bridges without pages. A cursor the transcript no longer knows answers 409
   * `history_changed`.
   */
  cursor?: string | null;
}

/** GET /api/agents: one agent kind herdr can start (`agent.start` kind), with a display label. */
export interface AgentKind {
  kind: string;
  label: string;
}

/** POST /api/workspace/create: the workspace herdr made and the pane the agent (if any) runs in. */
export interface WorkspaceCreated {
  workspace_id: string;
  pane_id: string;
  /** true when `agent` was requested and herdr reported it ready in the root pane */
  agent_started: boolean;
  /** The workspace still exists when its requested agent could not start. */
  error?: { code: string; message: string };
}

/** GET /api/pane/commands: one slash command the pane's agent understands. */
export interface SlashCommand {
  /** without the leading slash */
  name: string;
  description: string;
  source: "builtin" | "user" | "project";
}

/**
 * GET /api/pane/prompt: an agent's interactive TUI menu currently on the pane's screen
 * (Claude/omp/codex question, approval or plan prompts), parsed server-side from the
 * visible text. `id` is a content hash: an answer names it, so a prompt that changed
 * between the read and the click is refused (409 prompt_changed) instead of misfired.
 */
export interface InteractivePrompt {
  id: string;
  agent: string;
  kind: "question" | "approval" | "plan" | "menu";
  title: string;
  question: string;
  body: string | null;
  options: InteractivePromptOption[];
  multi_select: boolean;
  /** index of the "type your own answer" option, when the menu has one */
  custom_option_index: number | null;
}

export interface InteractivePromptOption {
  label: string;
  description: string | null;
}

/** POST /api/pane/prompt/answer body. Exactly one of option_index / option_indices / custom_text. */
export interface PromptAnswer {
  pane_id: string;
  prompt_id: string;
  option_index?: number;
  option_indices?: number[];
  custom_text?: string;
}

/**
 * The JSON inside every web push, decrypted by the device's service worker (public/sw.js)
 * and shown as a notification. `pane_id` is null for the enable-confirmation push; `tag`
 * is shared with the in-tab notification of the same pane, so one replaces the other.
 */
export interface PushPayload {
  /** Absent in legacy payloads means local. */
  machine_id?: string;
  pane_id: string | null;
  title: string;
  body: string;
  tag: string;
}

/** WebSocket at /ws
 *
 *  Client -> server frames: attach {pane_id, cols, rows} | detach {pane_id} | input {pane_id, text}
 *    | keys {pane_id, keys} | resize {pane_id, cols, rows} | role {mode}
 *    | pty-ack {pane_id, stream_id, offset}
 *  Server -> client frames: snapshot | pty-data | pty-exit | pane-geometry | role-ack
 *    | pane-status | pane-exited | session-changed | error
 *
 *  attach {flow_control:"ack"} opts into per-subscription output credit.
 *  pty-data.flow carries a stream_id and cumulative UTF-8 payload offset;
 *  pty-ack is sent AFTER xterm's write callback, never on receipt or reconnect.
 *  Slow consumers close with code 4008; the UI requires an explicit pane reopen.
 *
 *  Roles: a connection starts as `interact`. `role {mode:"observe"}` demotes it server-side:
 *  input/keys/resize then answer a `read_only` error frame and attaching never resizes the
 *  shared pty - the observer instead receives `pane-geometry` and adopts the pty's grid, so
 *  a phone watching a pane can never change the size the operator's PC sees. The client
 *  re-sends its role before the attach replay on reconnect.
 */

/** A connection's authority over the shared ptys: `interact` types and resizes, `observe` only watches. */
export type ClientRole = "interact" | "observe";

export type ClientMessage =
  | { type: "attach"; pane_id: string; cols: number; rows: number; flow_control?: "ack" }
  | { type: "detach"; pane_id: string }
  | { type: "input"; pane_id: string; text: string }
  | { type: "keys"; pane_id: string; keys: string[] }
  /** a composer message, sent to servers whose snapshot lists "submit": the server types it and
   * its own Enter after a short gap, and answers with a submit-result of the same id. `text` is
   * the message as written (agent.prompt pastes it itself), `payload` the same shaped for the
   * pane's bracketed-paste mode, typed when no agent is in front */
  | { type: "submit"; id: number; pane_id: string; text: string; payload: string }
  | { type: "resize"; pane_id: string; cols: number; rows: number }
  /** Cumulative UTF-8 payload bytes processed by xterm, only for this subscription. */
  | { type: "pty-ack"; pane_id: string; stream_id: string; offset: number }
  | { type: "role"; mode: ClientRole };

/** What a server supports beyond the base protocol, listed in its first snapshot; older bridges list nothing. */
export type ServerFeature = "submit";

export type ServerMessage =
  | { type: "snapshot"; snapshot: SessionSnapshot; features?: ServerFeature[] }
  /** raw PTY bytes: append to the terminal, never repaint over it */
  | { type: "pty-data"; pane_id: string; data: string; flow?: { stream_id: string; offset: number } }
  | { type: "pty-exit"; pane_id: string; code: number | null }
  /** the shared pty's grid changed: observe clients adopt it, interact clients drive it */
  | { type: "pane-geometry"; pane_id: string; cols: number; rows: number }
  | { type: "role-ack"; mode: ClientRole }
  /** how a submit ended: ok once its Enter was sent; otherwise nothing, or only the text, reached the pane */
  | { type: "submit-result"; id: number; pane_id: string; ok: boolean; code?: string; message?: string }
  /** agent-status push for ANY pane, attached or not (server-side status collector) */
  | { type: "pane-status"; pane_id: string; agent_status: AgentStatus }
  /** a pane's process exited (pushed even when nobody is attached to it) */
  | { type: "pane-exited"; pane_id: string }
  /** session structure changed (pane created/closed): refetch /api/session */
  | { type: "session-changed" }
  | { type: "error"; code: string; message: string };

/** herdr's default socket, under XDG_CONFIG_HOME when set, as herdr itself resolves it. */
export const HERDR_SOCKET_PATH = `${process.env["XDG_CONFIG_HOME"] || `${process.env["HOME"] ?? ""}/.config`}/herdr/herdr.sock`;
export const DEFAULT_PORT = 7317;
