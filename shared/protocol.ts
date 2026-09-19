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

/** HTTP API
 *  GET    /api/health                    -> { ok: true, herdr: { version, protocol }, auth: HealthAuth }
 *  GET    /api/session                   -> { snapshot: SessionSnapshot }
 *  GET    /api/pane/read?pane_id=&source=&format=&lines=  -> { read: PaneReadResult }
 *  POST   /api/pane/input  { pane_id, text }   -> { ok: true }
 *  POST   /api/pane/keys   { pane_id, keys }   -> { ok: true }
 *  POST   /api/pane/image  { pane_id, content_type, data_base64 } -> { ok: true, path }
 *         pasted image -> file under <pane cwd>/.herdr-web-ui/, path for the prompt
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

/**
 * The JSON inside every web push, decrypted by the device's service worker (public/sw.js)
 * and shown as a notification. `pane_id` is null for the enable-confirmation push; `tag`
 * is shared with the in-tab notification of the same pane, so one replaces the other.
 */
export interface PushPayload {
  pane_id: string | null;
  title: string;
  body: string;
  tag: string;
}

/** WebSocket at /ws
 *
 *  Client -> server frames: attach {pane_id, cols, rows} | detach {pane_id} | input {pane_id, text}
 *    | keys {pane_id, keys} | resize {pane_id, cols, rows} | role {mode}
 *  Server -> client frames: snapshot | pty-data | pty-exit | pane-geometry | role-ack
 *    | pane-status | pane-exited | session-changed | error
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
  | { type: "attach"; pane_id: string; cols: number; rows: number }
  | { type: "detach"; pane_id: string }
  | { type: "input"; pane_id: string; text: string }
  | { type: "keys"; pane_id: string; keys: string[] }
  | { type: "resize"; pane_id: string; cols: number; rows: number }
  | { type: "role"; mode: ClientRole };

export type ServerMessage =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  /** raw PTY bytes: append to the terminal, never repaint over it */
  | { type: "pty-data"; pane_id: string; data: string }
  | { type: "pty-exit"; pane_id: string; code: number | null }
  /** the shared pty's grid changed: observe clients adopt it, interact clients drive it */
  | { type: "pane-geometry"; pane_id: string; cols: number; rows: number }
  | { type: "role-ack"; mode: ClientRole }
  /** agent-status push for ANY pane, attached or not (server-side status collector) */
  | { type: "pane-status"; pane_id: string; agent_status: AgentStatus }
  /** a pane's process exited (pushed even when nobody is attached to it) */
  | { type: "pane-exited"; pane_id: string }
  /** session structure changed (pane created/closed): refetch /api/session */
  | { type: "session-changed" }
  | { type: "error"; code: string; message: string };

export const HERDR_SOCKET_PATH = `${process.env["HOME"] ?? ""}/.config/herdr/herdr.sock`;
export const DEFAULT_PORT = 7317;
