import type { ServerWebSocket } from "bun";

import type { ClientMessage, ClientRole, HealthAuth, HerdrPane, ServerMessage } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { handleAuthRequest, isAuthenticated, requiresAuth, unauthorizedJson } from "./auth.ts";
import { badRequest, errorResponse, jsonResponse } from "./http.ts";
import { serveStatic } from "./static.ts";
import { startStatusCollector } from "./collector.ts";
import { HerdrError, herdrSocketPath, paneRead, paneSendKeys, paneSendText, ping, sessionSnapshot } from "./herdr/client.ts";
import { PtySession } from "./pty/session.ts";

const MAX_REPLAY_BYTES = 256 * 1024;

/** Bind addresses only this machine can reach, so an unset token is nobody else's business. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

interface SocketData {
  attached: Set<string>;
  /** the connection's authority: observe connections cannot type or resize */
  mode: ClientRole;
}

type Client = ServerWebSocket<SocketData>;

/**
 * One live PTY per pane, shared by every client watching that pane.
 *
 * The terminal is a real `herdr terminal attach` on a PTY rather than repeated
 * `pane.read` snapshots, so the browser receives an actual byte stream: xterm.js
 * keeps its own scrollback and selection, and herdr's 1000-line per-read cap
 * stops being the ceiling on what the user can see.
 */
interface PaneAttachment {
  pty: PtySession;
  clients: Set<Client>;
  /** the pty's current grid: interact clients set it, observe clients adopt it */
  cols: number;
  rows: number;
  /** bounded tail so a client joining late still sees the current screen */
  replay: string;
}

function send(client: Client, message: ServerMessage): void {
  try {
    client.send(JSON.stringify(message));
  } catch {
    /* client vanished mid-send */
  }
}

export function createServer(
  options: { port?: number; hostname?: string; token?: string } = {},
): { port: number; hostname: string; stop: () => void } {
  const attachments = new Map<string, PaneAttachment>();
  /** attachments still resolving their terminal, so concurrent attaches share one pty */
  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  const clients = new Set<Client>();
  const hostname = options.hostname ?? process.env["HOST"] ?? "0.0.0.0";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["HERDR_WEB_TOKEN"] ?? "";

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
  }

  function broadcastAll(message: ServerMessage): void {
    for (const client of clients) send(client, message);
  }

  async function terminalInfoFor(paneId: string): Promise<{ terminalId: string; rect: { width: number; height: number } | null }> {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    const terminalId = (pane as HerdrPane & { terminal_id?: string }).terminal_id;
    if (!terminalId) throw new HerdrError("no_terminal", `pane ${paneId} has no terminal`);
    // the pane's grid as the operator's layout holds it: an observe connection must
    // create the pty at THIS size, never at the observer's own viewport
    const rect = snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    return { terminalId, rect: rect ? { width: rect.width, height: rect.height } : null };
  }

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachments.delete(paneId);
    attachment.pty.kill();
  }

  /** Clamp surface for the shared pty, mirroring the sidecar's own limits. */
  function validGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
    if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
      return null;
    }
    if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null;
    return { cols, rows };
  }

  function resizePty(paneId: string, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    if (!attachment || (attachment.cols === cols && attachment.rows === rows)) return;
    attachment.cols = cols;
    attachment.rows = rows;
    attachment.pty.resize(cols, rows);
    broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows });
  }

  function ensureAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    // a second attach arriving while the first is still resolving the terminal joins
    // that creation: two creations would spawn two ptys, and the orphaned one keeps
    // streaming into the surviving attachment and kills it when it exits
    const pending = pendingAttachments.get(paneId);
    if (pending) return pending;

    const created = spawnAttachment(paneId, cols, rows, forObserver).finally(() => pendingAttachments.delete(paneId));
    pendingAttachments.set(paneId, created);
    return created;
  }

  async function spawnAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    const { terminalId, rect } = await terminalInfoFor(paneId);
    // an observer-first attachment spawns at the pane's own grid (fallback 80x24 when
    // the layout has no rect for it): the attach must not seed the shared pty with a
    // watching phone's viewport
    const spawnCols = forObserver ? (rect?.width ?? 80) : cols;
    const spawnRows = forObserver ? (rect?.height ?? 24) : rows;
    const attachment: PaneAttachment = {
      pty: undefined as unknown as PtySession,
      clients: new Set<Client>(),
      cols: spawnCols,
      rows: spawnRows,
      replay: "",
    };
    attachments.set(paneId, attachment);

    // No --takeover: herdr 0.9.0 lets attaches coexist, so herdr-web-ui never displaces
    // whoever is already looking at this terminal - including the user's own TUI.
    attachment.pty = new PtySession({
      command: "herdr",
      args: ["terminal", "attach", terminalId],
      // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET: the stream must reach
      // the same session the RPCs talk to, or a named session's terminals are
      // looked up on the default socket and the attach dies.
      env: { HERDR_SOCKET_PATH: herdrSocketPath() },
      cols: spawnCols,
      rows: spawnRows,
      onData: (data) => {
        const current = attachments.get(paneId);
        if (!current) return;
        current.replay = (current.replay + data).slice(-MAX_REPLAY_BYTES);
        broadcast(paneId, { type: "pty-data", pane_id: paneId, data });
      },
      onExit: (code) => {
        broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
        closeAttachment(paneId);
      },
    });

    return attachment;
  }

  function detach(paneId: string, client: Client): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    if (attachment.clients.size === 0) closeAttachment(paneId);
  }

  /**
   * Closes an attachment whose creating client detached or disconnected before it was
   * ready, unless a client still wants it: every attach records its pane in
   * `attached` before awaiting, so a joiner of the same creation that has not resumed
   * yet still counts and is not left holding a dead record.
   */
  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  /** Status of EVERY pane, attached or not: one collector feeds all connected clients. */
  const collector = startStatusCollector({
    onStatus: (paneId, status) => broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: status }),
    onPaneEnded: (paneId) => broadcastAll({ type: "pane-exited", pane_id: paneId }),
    onStructureChange: () => broadcastAll({ type: "session-changed" }),
  });

  const envPort = process.env["PORT"];
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    hostname,

    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const { pathname } = url;
      const authenticated = isAuthenticated(request, token);

      if (requiresAuth(pathname) && !authenticated) {
        // The WS client never parses a body, so the upgrade refusal stays plain text.
        return pathname === "/ws" ? new Response("unauthorized", { status: 401 }) : unauthorizedJson();
      }

      if (pathname === "/ws") {
        const upgraded = bunServer.upgrade(request, { data: { attached: new Set<string>(), mode: "interact" } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("websocket upgrade required", { status: 426 });
      }

      if (pathname === "/api/auth") return handleAuthRequest(request, token);

      if (pathname === "/api/health") {
        const auth: HealthAuth = { required: token !== "", authenticated };
        try {
          const info = await ping();
          return jsonResponse({ ok: true, herdr: { version: info.version, protocol: info.protocol }, auth });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/session") {
        try {
          return jsonResponse({ snapshot: await sessionSnapshot() });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/read") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const linesRaw = url.searchParams.get("lines");
        const lines = linesRaw === null ? undefined : Number(linesRaw);
        if (lines !== undefined && !Number.isFinite(lines)) {
          return badRequest("invalid_lines", "lines must be a number");
        }
        try {
          const read = await paneRead({
            paneId,
            source: (url.searchParams.get("source") ?? "visible") as never,
            format: (url.searchParams.get("format") ?? "text") as never,
            ...(lines === undefined ? {} : { lines }),
          });
          return jsonResponse({ read });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/input" || pathname === "/api/pane/keys") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; text?: string; keys?: string[] };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!payload.pane_id) return badRequest("missing_pane_id", "pane_id is required");
        try {
          if (pathname === "/api/pane/input") {
            if (typeof payload.text !== "string") return badRequest("missing_text", "text is required");
            await paneSendText(payload.pane_id, payload.text);
          } else {
            if (!Array.isArray(payload.keys)) return badRequest("missing_keys", "keys must be an array");
            await paneSendKeys(payload.pane_id, payload.keys);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
      }

      // static client - public even when the API is gated, so the login UI can load
      return serveStatic(pathname);
    },

    websocket: {
      async open(client) {
        clients.add(client);
        try {
          send(client, { type: "snapshot", snapshot: await sessionSnapshot() });
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "snapshot_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      async message(client, raw) {
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          send(client, { type: "error", code: "invalid_json", message: "message must be JSON" });
          return;
        }
        try {
          switch (message.type) {
            case "attach": {
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              // record the pane before the await: a detach (switching panes) or a close
              // that lands while the terminal is looked up must cancel this attach, and
              // neither can see a client that only joins the attachment afterwards
              client.data.attached.add(message.pane_id);
              let attachment: PaneAttachment;
              try {
                attachment = await ensureAttachment(message.pane_id, geometry.cols, geometry.rows, client.data.mode === "observe");
              } catch (error) {
                client.data.attached.delete(message.pane_id);
                throw error;
              }
              if (!client.data.attached.has(message.pane_id)) {
                releaseUnclaimed(message.pane_id, attachment);
                break;
              }
              attachment.clients.add(client);
              // hand the newcomer the current screen it would otherwise have missed
              if (attachment.replay) {
                send(client, { type: "pty-data", pane_id: message.pane_id, data: attachment.replay });
              }
              if (client.data.mode === "interact") {
                // an operator's viewport owns the shared grid
                resizePty(message.pane_id, geometry.cols, geometry.rows);
              } else {
                // an observer adopts whatever grid the operators left behind
                send(client, {
                  type: "pane-geometry",
                  pane_id: message.pane_id,
                  cols: attachment.cols,
                  rows: attachment.rows,
                });
              }
              break;
            }
            case "detach": {
              client.data.attached.delete(message.pane_id);
              detach(message.pane_id, client);
              break;
            }
            case "input": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              const attachment = attachments.get(message.pane_id);
              if (attachment) attachment.pty.write(message.text);
              break;
            }
            case "resize": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              resizePty(message.pane_id, geometry.cols, geometry.rows);
              break;
            }
            case "keys": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              await paneSendKeys(message.pane_id, message.keys);
              break;
            }
            case "role": {
              if (message.mode !== "interact" && message.mode !== "observe") {
                send(client, { type: "error", code: "invalid_role", message: "mode must be interact or observe" });
                break;
              }
              client.data.mode = message.mode;
              send(client, { type: "role-ack", mode: message.mode });
              if (message.mode === "observe") {
                // the fresh observer needs the grid it must adopt
                for (const paneId of client.data.attached) {
                  const attachment = attachments.get(paneId);
                  if (attachment) {
                    send(client, { type: "pane-geometry", pane_id: paneId, cols: attachment.cols, rows: attachment.rows });
                  }
                }
              }
              break;
            }
          }
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "command_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      close(client) {
        clients.delete(client);
        for (const paneId of client.data.attached) detach(paneId, client);
        client.data.attached.clear();
      },
    },
  });

  return {
    port: server.port ?? 0,
    hostname,
    stop: () => {
      collector.stop();
      for (const paneId of [...attachments.keys()]) closeAttachment(paneId);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const instance = createServer();
  console.log(`herdr-web-ui listening on http://${instance.hostname}:${instance.port}`);
  if ((process.env["HERDR_WEB_TOKEN"] ?? "") === "" && !LOOPBACK_HOSTNAMES.has(instance.hostname)) {
    console.error(
      `WARNING: listening on all interfaces (${instance.hostname}) without HERDR_WEB_TOKEN - anyone who can reach this port can type into your terminals; set HERDR_WEB_TOKEN=<token> or HOST=127.0.0.1 to stop that.`,
    );
  }
}
