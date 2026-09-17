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
 *  GET  /api/health                      -> { ok: true, herdr: { version, protocol } }
 *  GET  /api/session                     -> { snapshot: SessionSnapshot }
 *  GET  /api/pane/read?pane_id=&source=&format=&lines=  -> { read: PaneReadResult }
 *  POST /api/pane/input  { pane_id, text }   -> { ok: true }
 *  POST /api/pane/keys   { pane_id, keys }   -> { ok: true }
 *  Errors: non-2xx with { error: { code, message } }
 */
export interface ApiError {
  error: { code: string; message: string };
}

/** WebSocket at /ws */
export type ClientMessage =
  | { type: "attach"; pane_id: string; cols: number; rows: number }
  | { type: "detach"; pane_id: string }
  | { type: "input"; pane_id: string; text: string }
  | { type: "keys"; pane_id: string; keys: string[] }
  | { type: "resize"; pane_id: string; cols: number; rows: number };

export type ServerMessage =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  /** raw PTY bytes: append to the terminal, never repaint over it */
  | { type: "pty-data"; pane_id: string; data: string }
  | { type: "pty-exit"; pane_id: string; code: number | null }
  | { type: "pane-status"; pane_id: string; agent_status: AgentStatus }
  | { type: "error"; code: string; message: string };

export const HERDR_SOCKET_PATH = `${process.env["HOME"] ?? ""}/.config/herdr/herdr.sock`;
export const DEFAULT_PORT = 7317;
