/**
 * The herdr-br contract: shared between the Bun server and the React client.
 * Field shapes mirror the herdr 0.9.0 socket API (protocol 22) verbatim.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface PaneScroll {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status?: AgentStatus;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status?: AgentStatus;
}

export interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd?: string;
  agent?: string | null;
  agent_status?: AgentStatus;
  terminal_title?: string;
  terminal_title_stripped?: string;
  scroll?: PaneScroll;
  revision: number;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
}

export type ReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";
export type ReadFormat = "text" | "ansi";

export interface PaneReadResult {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  source: ReadSource;
  format: ReadFormat;
  text: string;
  revision?: number;
  truncated?: boolean;
}

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
  | { type: "watch"; pane_id: string }
  | { type: "unwatch"; pane_id: string }
  | { type: "input"; pane_id: string; text: string }
  | { type: "keys"; pane_id: string; keys: string[] };

export type ServerMessage =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "pane-output"; pane_id: string; text: string; revision: number }
  | { type: "pane-status"; pane_id: string; agent_status: AgentStatus }
  | { type: "error"; code: string; message: string };

export const HERDR_SOCKET_PATH = `${process.env.HOME ?? ""}/.config/herdr/herdr.sock`;
export const DEFAULT_PORT = 7317;
