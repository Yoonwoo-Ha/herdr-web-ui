import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";

import type { AgentStatus, ClientMessage, HerdrPane, ServerMessage } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
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

const DIST_DIR = new URL("../dist", import.meta.url).pathname;

interface SocketData {
  watching: Set<string>;
}

type Client = ServerWebSocket<SocketData>;

/** One herdr subscription per watched pane, fanned out to every client watching it. */
interface PaneWatch {
  subscription: Subscription;
  clients: Set<Client>;
  lastRevision: number;
  reading: boolean;
  /** drop-to-latest: a busy pane emits far more events than we should re-read for */
  pendingRevision: number | null;
}

function send(client: Client, message: ServerMessage): void {
  try {
    client.send(JSON.stringify(message));
  } catch {
    /* client vanished mid-send */
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HerdrError) {
    const status = error.code === "connect_failed" || error.code === "timeout" ? 502 : 404;
    return jsonResponse({ error: { code: error.code, message: error.message } }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: { code: "internal_error", message } }, 500);
}

function badRequest(code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, 400);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

export function createServer(options: { port?: number } = {}): { port: number; stop: () => void } {
  const watches = new Map<string, PaneWatch>();

  async function pushPaneOutput(paneId: string, revision: number): Promise<void> {
    const watch = watches.get(paneId);
    if (!watch) return;
    if (watch.reading) {
      watch.pendingRevision = revision;
      return;
    }
    watch.reading = true;
    try {
      const read = await paneRead({ paneId, source: "visible", format: "ansi" });
      const current = watches.get(paneId);
      if (current) {
        current.lastRevision = revision;
        const message: ServerMessage = {
          type: "pane-output",
          pane_id: paneId,
          text: read.text,
          revision,
        };
        for (const client of current.clients) send(client, message);
      }
    } catch (error) {
      const current = watches.get(paneId);
      const code = error instanceof HerdrError ? error.code : "read_failed";
      const message = error instanceof Error ? error.message : String(error);
      if (current) for (const client of current.clients) send(client, { type: "error", code, message });
    } finally {
      const current = watches.get(paneId);
      if (current) {
        current.reading = false;
        const pending = current.pendingRevision;
        current.pendingRevision = null;
        if (pending !== null && pending > current.lastRevision) void pushPaneOutput(paneId, pending);
      }
    }
  }

  function ensureWatch(paneId: string): PaneWatch {
    const existing = watches.get(paneId);
    if (existing) return existing;

    const watch: PaneWatch = {
      subscription: { close: () => {} },
      clients: new Set<Client>(),
      lastRevision: -1,
      reading: false,
      pendingRevision: null,
    };
    watches.set(paneId, watch);

    watch.subscription = subscribeEvents(
      [
        { type: "pane.updated", pane_id: paneId },
        { type: "pane.agent_status_changed", pane_id: paneId },
      ],
      {
        onEvent: (frame) => {
          const pane = (frame.data as { pane?: HerdrPane } | undefined)?.pane;
          if (!pane || pane.pane_id !== paneId) return;
          const current = watches.get(paneId);
          if (!current) return;
          if (pane.agent_status) {
            const statusMessage: ServerMessage = {
              type: "pane-status",
              pane_id: paneId,
              agent_status: pane.agent_status as AgentStatus,
            };
            for (const client of current.clients) send(client, statusMessage);
          }
          if (typeof pane.revision === "number" && pane.revision > current.lastRevision) {
            void pushPaneOutput(paneId, pane.revision);
          }
        },
      },
    );
    return watch;
  }

  function releaseWatch(paneId: string, client: Client): void {
    const watch = watches.get(paneId);
    if (!watch) return;
    watch.clients.delete(client);
    if (watch.clients.size === 0) {
      watch.subscription.close();
      watches.delete(paneId);
    }
  }

  const envPort = process.env["PORT"];
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),

    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        const upgraded = bunServer.upgrade(request, { data: { watching: new Set<string>() } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("websocket upgrade required", { status: 426 });
      }

      if (pathname === "/api/health") {
        try {
          const info = await ping();
          return jsonResponse({ ok: true, herdr: { version: info.version, protocol: info.protocol } });
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

      // static client
      const indexPath = join(DIST_DIR, "index.html");
      if (!existsSync(indexPath)) {
        return new Response(
          "herdr-br server is running, but the browser client has not been built yet.\nRun: bun run build\n",
          { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }
      const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      const candidate = join(DIST_DIR, relative);
      if (candidate.startsWith(DIST_DIR) && relative !== "/" && existsSync(candidate)) {
        const file = Bun.file(candidate);
        if ((await file.exists()) && !(await file.stat()).isDirectory()) {
          return new Response(file, { headers: { "content-type": contentTypeFor(candidate) } });
        }
      }
      return new Response(Bun.file(indexPath), { headers: { "content-type": "text/html; charset=utf-8" } });
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
            case "watch": {
              const watch = ensureWatch(message.pane_id);
              watch.clients.add(client);
              client.data.watching.add(message.pane_id);
              const read = await paneRead({ paneId: message.pane_id, source: "visible", format: "ansi" });
              const revision = read.revision ?? 0;
              if (revision > watch.lastRevision) watch.lastRevision = revision;
              send(client, { type: "pane-output", pane_id: message.pane_id, text: read.text, revision });
              break;
            }
            case "unwatch": {
              client.data.watching.delete(message.pane_id);
              releaseWatch(message.pane_id, client);
              break;
            }
            case "input": {
              await paneSendText(message.pane_id, message.text);
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
        for (const paneId of client.data.watching) releaseWatch(paneId, client);
        client.data.watching.clear();
      },
    },
  });

  return {
    port: server.port ?? 0,
    stop: () => {
      for (const [, watch] of watches) watch.subscription.close();
      watches.clear();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const instance = createServer();
  console.log(`herdr-br listening on http://localhost:${instance.port}`);
}
