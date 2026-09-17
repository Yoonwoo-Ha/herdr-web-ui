import type { ServerWebSocket } from "bun";

import type { AgentStatus, ClientMessage, HealthAuth, HerdrPane, ServerMessage } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { handleAuthRequest, isAuthenticated, requiresAuth, unauthorizedJson } from "./auth.ts";
import { badRequest, errorResponse, jsonResponse } from "./http.ts";
import { serveStatic } from "./static.ts";
import {
  HerdrError,
  paneRead,
  paneSendKeys,
  paneSendText,
  ping,
  sessionSnapshot,
  subscribeEvents,
  type Subscription,
} from "./herdr/client.ts";
import { PtySession } from "./pty/session.ts";

const MAX_REPLAY_BYTES = 256 * 1024;

/** Bind addresses only this machine can reach, so an unset token is nobody else's business. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

interface SocketData {
  attached: Set<string>;
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
  statusSubscription: Subscription;
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
  const hostname = options.hostname ?? process.env["HOST"] ?? "0.0.0.0";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["HERDR_WEB_TOKEN"] ?? "";

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
  }

  async function terminalIdFor(paneId: string): Promise<string> {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    const terminalId = (pane as HerdrPane & { terminal_id?: string }).terminal_id;
    if (!terminalId) throw new HerdrError("no_terminal", `pane ${paneId} has no terminal`);
    return terminalId;
  }

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachments.delete(paneId);
    attachment.statusSubscription.close();
    attachment.pty.kill();
  }

  async function ensureAttachment(paneId: string, cols: number, rows: number): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return existing;

    const terminalId = await terminalIdFor(paneId);
    const attachment: PaneAttachment = {
      pty: undefined as unknown as PtySession,
      clients: new Set<Client>(),
      statusSubscription: { close: () => {} },
      replay: "",
    };
    attachments.set(paneId, attachment);

    // No --takeover: herdr 0.9.0 lets attaches coexist, so herdr-web-ui never displaces
    // whoever is already looking at this terminal - including the user's own TUI.
    attachment.pty = new PtySession({
      command: "herdr",
      args: ["terminal", "attach", terminalId],
      cols,
      rows,
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

    attachment.statusSubscription = subscribeEvents(
      [{ type: "pane.agent_status_changed", pane_id: paneId }],
      {
        onEvent: (frame) => {
          const pane = (frame.data as { pane?: HerdrPane } | undefined)?.pane;
          if (!pane || pane.pane_id !== paneId || !pane.agent_status) return;
          broadcast(paneId, {
            type: "pane-status",
            pane_id: paneId,
            agent_status: pane.agent_status as AgentStatus,
          });
        },
      },
    );

    return attachment;
  }

  function detach(paneId: string, client: Client): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    if (attachment.clients.size === 0) closeAttachment(paneId);
  }

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
        const upgraded = bunServer.upgrade(request, { data: { attached: new Set<string>() } });
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
              const attachment = await ensureAttachment(message.pane_id, message.cols, message.rows);
              attachment.clients.add(client);
              client.data.attached.add(message.pane_id);
              // hand the newcomer the current screen it would otherwise have missed
              if (attachment.replay) {
                send(client, { type: "pty-data", pane_id: message.pane_id, data: attachment.replay });
              }
              attachment.pty.resize(message.cols, message.rows);
              break;
            }
            case "detach": {
              client.data.attached.delete(message.pane_id);
              detach(message.pane_id, client);
              break;
            }
            case "input": {
              const attachment = attachments.get(message.pane_id);
              if (attachment) attachment.pty.write(message.text);
              break;
            }
            case "resize": {
              const attachment = attachments.get(message.pane_id);
              if (attachment) attachment.pty.resize(message.cols, message.rows);
              break;
            }
            case "keys": {
              await paneSendKeys(message.pane_id, message.keys);
              break;
            }
          }
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "command_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      close(client) {
        for (const paneId of client.data.attached) detach(paneId, client);
        client.data.attached.clear();
      },
    },
  });

  return {
    port: server.port ?? 0,
    hostname,
    stop: () => {
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
