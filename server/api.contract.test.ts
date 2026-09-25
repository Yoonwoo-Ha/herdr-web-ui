import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "./index.ts";
import type { AgentKind, AgentStatus, ApiError, HealthAuth, PushKey, SessionSnapshot, PaneReadResult, WorkspaceCreated } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";

/**
 * Contract test for herdr-web-ui's HTTP + WS surface.
 * Runs against the REAL herdr server on the developer's machine: these are the
 * integration seams the browser UI depends on, so a mock here would prove nothing.
 * Tests never mutate a user's pane; mutation cases create labeled workspaces and close them in afterAll.
 * Every server here keeps its push state (VAPID key, subscriptions) in a temp dir: the
 * user's ~/.config/herdr-web-ui holds their real devices, which a test must never page.
 */
let server: { port: number; stop: () => void };
const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-contract-"));

beforeAll(() => {
  server = createServer({ port: 0, stateDir });
});

afterAll(() => {
  server?.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

const base = () => `http://localhost:${server.port}`;

describe("update API", () => {
  it("reports unmanaged servers without performing network discovery", async () => {
    const response = await fetch(`${base()}/api/updates`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as { managed: boolean }).managed).toBe(false);
  });

  it("refuses cross-site/form update requests and unmanaged installs", async () => {
    for (const headers of [{}, { "x-herdr-update": "1", origin: "https://untrusted.invalid" },
      { "x-herdr-update": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers });
      expect(response.status).toBe(403);
    }
    const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(response.status).toBe(409);
    expect((await response.json() as ApiError).error.code).toBe("updates_unmanaged");
  });

  it("keeps status and update actions behind the token gate", async () => {
    const protectedState = mkdtempSync(join(tmpdir(), "herdr-update-auth-"));
    const protectedServer = createServer({ port: 0, stateDir: protectedState, token: "test-update-token" });
    try {
      for (const path of ["/api/updates", "/api/updates/check", "/api/updates/install"]) {
        const response = await fetch(`http://localhost:${protectedServer.port}${path}`, {
          method: path === "/api/updates" ? "GET" : "POST", headers: { "x-herdr-update": "1" },
        });
        expect(response.status).toBe(401);
      }
    } finally { protectedServer.stop(); rmSync(protectedState, { recursive: true, force: true }); }
  });
});

describe("mutation body validation", () => {
  it("rejects non-object JSON without touching herdr or losing the error envelope", async () => {
    for (const path of [
      "/api/workspace/create", "/api/workspace/rename", "/api/workspace/move", "/api/workspace/close",
      "/api/pane/rename", "/api/pane/input", "/api/pane/keys", "/api/pane/close", "/api/pane/image",
    ]) {
      for (const body of [null, [], "text", 42, true]) {
        const response = await fetch(`${base()}${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error.code).toBe("invalid_body");
      }
    }
  });

  it("rejects invalid pane identifiers and key/image fields before RPCs", async () => {
    for (const [path, body, code] of [
      ["/api/pane/input", { pane_id: true, text: "echo bad" }, "missing_pane_id"],
      ["/api/pane/close", { pane_id: 5 }, "missing_pane_id"],
      ["/api/pane/keys", { pane_id: "unknown", keys: [null] }, "missing_keys"],
      ["/api/pane/image", { pane_id: "unknown", content_type: "image/png", data_base64: {} }, "invalid_image"],
      ["/api/workspace/create", { agent: { kind: "claude", args: "--help" } }, "invalid_agent"],
    ] as const) {
      const response = await fetch(`${base()}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
  });
});

describe("workspace and discovery endpoints", () => {
  let workspaceId: string | null = null;
  let paneId: string | null = null;
  const label = `herdr-web-ui-test-${Math.random().toString(36).slice(2)}`;
  const fileName = `${label}-mention.txt`;
  const filePath = join(tmpdir(), fileName);

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    rmSync(filePath, { force: true });
  });

  it("lists agent kinds with required fallbacks sorted by display label", async () => {
    const res = await fetch(`${base()}/api/agents`);
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: AgentKind[] };
    expect(agents.some((agent) => agent.kind === "claude")).toBeTrue();
    expect(agents.some((agent) => agent.kind === "omp")).toBeTrue();
    expect(agents.map((agent) => agent.label)).toEqual([...agents.map((agent) => agent.label)].sort((a, b) => a.localeCompare(b)));
  });

  it("rejects a workspace cwd that is not an existing directory", async () => {
    const res = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: join(tmpdir(), `does-not-exist-${crypto.randomUUID()}`) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.code).toBe("invalid_cwd");
  });

  it("creates, edits, searches, inspects, and closes an owned workspace", async () => {
    writeFileSync(filePath, "mention fixture");
    // the dialog sends null for "not given" (agent: null = shell only): nulls must read as absent
    const create = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmpdir(), label, agent: null }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as WorkspaceCreated;
    workspaceId = created.workspace_id;
    paneId = created.pane_id;
    expect(created.agent_started).toBeFalse();

    const commands = await fetch(`${base()}/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`);
    expect(commands.status).toBe(200);
    expect(await commands.json()).toEqual({ commands: [] });

    const files = await fetch(`${base()}/api/pane/files?pane_id=${encodeURIComponent(paneId)}&q=${encodeURIComponent(fileName)}&limit=5`);
    expect(files.status).toBe(200);
    expect(((await files.json()) as { files: string[] }).files).toContain(fileName);

    const prompt = await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toEqual({ prompt: null });

    for (const [path, body] of [
      ["/api/workspace/rename", { workspace_id: workspaceId, label: `${label}-renamed` }],
      ["/api/workspace/move", { workspace_id: workspaceId, insert_index: 0 }],
      ["/api/pane/rename", { pane_id: paneId, label: "renamed pane" }],
    ] as const) {
      const changed = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({ ok: true });
    }

    const close = await fetch(`${base()}/api/workspace/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    expect(close.status).toBe(200);
    expect(await close.json()).toEqual({ ok: true });
    workspaceId = null;
  }, 20_000);

  it("uses the shared error envelope for malformed mutation bodies", async () => {
    for (const [path, body, code] of [
      ["/api/workspace/rename", {}, "missing_workspace_id"],
      ["/api/workspace/move", { workspace_id: "x", insert_index: -1 }, "invalid_index"],
      ["/api/workspace/close", {}, "missing_workspace_id"],
      ["/api/pane/rename", {}, "missing_pane_id"],
    ] as const) {
      const res = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe(code);
    }
  });
});

describe("GET /api/session", () => {
  it("returns the live herdr snapshot with at least one real workspace", async () => {
    const res = await fetch(`${base()}/api/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: SessionSnapshot };
    expect(Array.isArray(body.snapshot.workspaces)).toBe(true);
    expect(body.snapshot.workspaces.length).toBeGreaterThan(0);
    // Every workspace carries the identity fields the sidebar renders.
    for (const ws of body.snapshot.workspaces) {
      expect(typeof ws.workspace_id).toBe("string");
      expect(ws.workspace_id.length).toBeGreaterThan(0);
      expect(typeof ws.label).toBe("string");
    }
    expect(body.snapshot.panes.length).toBeGreaterThan(0);
  });
});

describe("GET /api/pane/read", () => {
  it("returns terminal text for a real live pane", async () => {
    const snapRes = await fetch(`${base()}/api/session`);
    const { snapshot } = (await snapRes.json()) as { snapshot: SessionSnapshot };
    const pane = snapshot.panes[0];
    expect(pane).toBeDefined();

    const res = await fetch(`${base()}/api/pane/read?pane_id=${encodeURIComponent(pane!.pane_id)}&source=visible&format=text`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { read: PaneReadResult };
    expect(body.read.pane_id).toBe(pane!.pane_id);
    expect(typeof body.read.text).toBe("string");
  });

  it("rejects an unknown pane id with a clean JSON error and keeps serving", async () => {
    const res = await fetch(`${base()}/api/pane/read?pane_id=w9999:p9999&source=visible&format=text`);
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(typeof body.error.code).toBe("string");
    // the server survives a bad request
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });

  it("rejects a missing pane_id parameter", async () => {
    const res = await fetch(`${base()}/api/pane/read?source=visible`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/pane/close", () => {
  /** Own workspace again: this test really kills its root pane, never a user pane. */
  let workspaceId: string | null = null;
  let paneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-close", cwd: "/tmp", focus: false },
    );
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
  });

  it("closes the named pane and it leaves the snapshot", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // real cross-process state: fake timers cannot see herdr's snapshot, so this is
    // one of the rare genuine-delay polls (same shape as the exit test's retries)
    let gone = false;
    for (let attempt = 0; attempt < 10 && !gone; attempt += 1) {
      const session = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
      gone = !session.snapshot.panes.some((pane) => pane.pane_id === paneId);
      if (!gone) await Bun.sleep(500);
    }
    expect(gone).toBeTrue();
  }, 20000);

  it("answers the error envelope for an unknown pane", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "no-such-pane" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBeTruthy();
    expect(typeof body.error.message).toBe("string");
  });

  it("rejects a missing pane_id with 400 missing_pane_id", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("missing_pane_id");
  });
});

describe("POST /api/pane/image", () => {
  /** Own workspace with its own cwd: the upload writes a real file into it. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let qaCwd: string | null = null;

  // a real 1x1 png
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  const post = (body: unknown) =>
    fetch(`${base()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    qaCwd = mkdtempSync(join(tmpdir(), "herdr-web-ui-image-"));
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-image", cwd: qaCwd, focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
    if (qaCwd) rmSync(qaCwd, { recursive: true, force: true });
  });

  it("stores a pasted image under the pane cwd and returns its absolute path", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    // the prompt must reference a file the agent can read without leaving its project
    expect(body.path.startsWith(qaCwd!)).toBe(true);
    expect(body.path.includes(".herdr-web-ui")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);
    const stored = statSync(body.path);
    expect(stored.size).toBeGreaterThan(0);
    expect(stored.isFile()).toBe(true);
  });

  it("rejects an unknown pane with the shared error envelope", async () => {
    const res = await post({ pane_id: "w9999:p9999", content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("pane_not_found");
  });

  it("stores any other file under its own sanitised name", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/svg+xml", data_base64: svg, name: "../omo icon.SVG" });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path.startsWith(join(qaCwd!, ".herdr-web-ui") + "/")).toBe(true);
    expect(basename(path)).toMatch(/^omo_icon-\d{8}-\d{6}-[0-9a-f]{8}\.svg$/);
    expect(readFileSync(path, "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    // no name, or one without a usable extension: still stored, as .bin
    const bare = (await (await post({ pane_id: qaPaneId, content_type: "", data_base64: svg })).json()) as { path: string };
    expect(basename(bare.path)).toMatch(/^file-.*\.bin$/);
  });

  it("rejects an image above the size ceiling with 413", async () => {
    const oversized = Buffer.alloc(9 * 1024 * 1024, 1).toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: oversized });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("image_too_large");
  });

  it("rejects empty image data with 400", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_image");
  });

  it("rejects a missing pane_id with 400 and keeps serving", async () => {
    const res = await post({ content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(400);
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });
});

describe("WebSocket /ws", () => {
  /**
   * Uses a workspace this test creates and closes, never one of the user's:
   * attaching starts a real `herdr terminal attach` against a live terminal.
   */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
  });

  it("pushes a snapshot on connect and streams real pty bytes for an attached pane", async () => {
    const paneId = qaPaneId!;
    expect(paneId).toBeTruthy();

    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    const seen: any[] = [];
    const waitFor = (predicate: (msg: any) => boolean, label: string, ms: number) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} not received within ${ms}ms`)), ms);
        const listener = (event: MessageEvent) => {
          const msg = JSON.parse(String(event.data));
          seen.push(msg);
          if (predicate(msg)) {
            clearTimeout(timer);
            ws.removeEventListener("message", listener as EventListener);
            resolve(msg);
          }
        };
        ws.addEventListener("message", listener as EventListener);
      });

    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const snapshot = await waitFor((m) => m.type === "snapshot", "snapshot", 5000);
    expect(snapshot.snapshot.workspaces.length).toBeGreaterThan(0);

    const streamed = waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "pty-data", 15000);
    ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 }));
    const frame = await streamed;
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "detach", pane_id: paneId }));
    ws.close();
  }, 30000);

  it("rejects a malformed websocket frame without dropping the connection", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const errored = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error frame within 5s")), 5000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data));
        if (msg.type === "error") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    ws.send("this is not json");
    const error = await errored;
    expect(error.code).toBe("invalid_json");
    ws.close();
  }, 15000);
});

type CookieWebSocketCtor = new (url: string, options: { headers: { cookie: string } }) => WebSocket;
/** A WS frame as tests read it: the discriminator plus whatever fields they assert on. */
type RecordedFrame = { type: string; [key: string]: unknown };

/** A WS client that records every frame it receives, with a bounded wait for one that matches. */
class RecordingSocket {
  readonly seen: RecordedFrame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      this.seen.push(JSON.parse(String((event as MessageEvent).data)));
    });
  }

  static async connect(url: string): Promise<RecordingSocket> {
    const socket = new RecordingSocket(url);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    // drain the initial snapshot so callers wait only for what they named
    await socket.waitFor((message) => message.type === "snapshot", "snapshot", 10_000);
    return socket;
  }

  waitFor(predicate: (message: RecordedFrame) => boolean, label: string, ms: number): Promise<RecordedFrame> {
    const already = this.seen.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise<RecordedFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} not received within ${ms}ms`)), ms);
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as RecordedFrame;
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.ws.removeEventListener("message", listener as EventListener);
        resolve(message);
      };
      this.ws.addEventListener("message", listener as EventListener);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}

describe("WebSocket roles and status push", () => {
  /** Own workspace again: the role tests resize a real pty, the exit test kills a real shell. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let exitWorkspaceId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-roles", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (exitWorkspaceId) await herdrRpc("workspace.close", { workspace_id: exitWorkspaceId }).catch(() => undefined);
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId }).catch(() => undefined);
  });

  it("never resizes the shared pty for an observe connection, and read-only frames answer input, keys and resize", async () => {
    const paneId = qaPaneId!;
    const operator = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);

    try {
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await operator.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "operator pty-data", 15_000);

      observer.send({ type: "role", mode: "observe" });
      const ack = await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      expect(ack.mode).toBe("observe");

      // an observer attaching a smaller screen must NOT resize the shared pty:
      // the attach answers with the grid to adopt (the operator's 100x30), not its own
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const adopted = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 100,
        "observer adopts geometry",
        5000,
      );
      expect(adopted.rows).toBe(30);
      expect(operator.seen.some((m) => m.type === "pane-geometry")).toBe(false);

      observer.send({ type: "resize", pane_id: paneId, cols: 40, rows: 20 });
      const resizeError = await observer.waitFor((m) => m.type === "error", "resize read_only error", 5000);
      expect(resizeError.code).toBe("read_only");

      observer.send({ type: "input", pane_id: paneId, text: "echo nope" });
      const inputError = await observer.waitFor((m) => m.type === "error", "input read_only error", 5000);
      expect(inputError.code).toBe("read_only");

      observer.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
      const keysError = await observer.waitFor((m) => m.type === "error", "keys read_only error", 5000);
      expect(keysError.code).toBe("read_only");

      // the operator keeps driving the shared grid, and everyone attached hears it
      operator.send({ type: "resize", pane_id: paneId, cols: 120, rows: 40 });
      const geometry = await operator.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "geometry broadcast", 5000);
      expect(geometry.cols).toBe(120);
      expect(geometry.rows).toBe(40);
      await observer.waitFor((m) => m.type === "pane-geometry" && m.cols === 120, "observer hears geometry", 5000);
    } finally {
      operator.close();
      observer.close();
    }
  }, 40_000);

  it("rejects an unknown role mode with an in-band error", async () => {
    const client = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      client.send({ type: "role", mode: "wat" });
      const error = await client.waitFor((m) => m.type === "error", "invalid_role error", 5000);
      expect(error.code).toBe("invalid_role");
    } finally {
      client.close();
    }
  }, 15_000);

  it("pushes pane-status and pane-exited for a pane nobody is attached to", async () => {
    const paneId = qaPaneId!;
    const watcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // the collector subscribed to this pane when it was created; prove it by pushing
      // status changes through herdr itself and seeing the frames. herdr tears down a
      // subscription batch that references a pane which vanished mid-reconcile, so the
      // collector may briefly re-subscribe - retry the report (alternating states, so
      // each is a real change) until the frame arrives instead of trusting the clock
      let seen = false;
      for (let attempt = 0; attempt < 8 && !seen; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: paneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        seen = await watcher
          .waitFor(
            (m) => m.type === "pane-status" && m.pane_id === paneId && m.agent_status === (attempt % 2 === 0 ? "blocked" : "working"),
            "unattached pane-status",
            2_500,
          )
          .then(() => true)
          .catch(() => false);
      }
      expect(seen).toBeTrue();

      // a pane ending while unattached pushes pane-exited
      const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
        "workspace.create",
        { label: "herdr-web-ui-test-exit", cwd: "/tmp", focus: false },
      );
      exitWorkspaceId = created.workspace.workspace_id;
      const exitPaneId = created.root_pane.pane_id;
      // the collector picks a brand-new pane up via pane.created -> reconcile, which is
      // debounced: retry the status report (alternating states, so each is a real
      // change) until the frame proves the subscription is live - no clock-waiting
      let subscribed = false;
      for (let attempt = 0; attempt < 8 && !subscribed; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: exitPaneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        subscribed = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === exitPaneId, "exit pane subscribed", 1_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(subscribed).toBeTrue();
      await herdrRpc("pane.send_text", { pane_id: exitPaneId, text: "exit\r" });
      const exited = await watcher.waitFor(
        (m) => m.type === "pane-exited" && m.pane_id === exitPaneId,
        "unattached pane-exited",
        10_000,
      );
      expect(exited.type).toBe("pane-exited");
    } finally {
      watcher.close();
    }
  }, 40_000);
});

describe("WebSocket observer-first attach", () => {
  /** Own pane: the observer must be the one that creates the attachment. */
  let observeWorkspaceId: string | null = null;
  let observePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-observe", cwd: "/tmp", focus: false },
    );
    observeWorkspaceId = created.workspace.workspace_id;
    observePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (observeWorkspaceId) await herdrRpc("workspace.close", { workspace_id: observeWorkspaceId }).catch(() => undefined);
  });

  it("sizes a PTY an observe connection creates from the pane, never from the observer's grid", async () => {
    // observer-FIRST attach: nobody holds the attachment, so the observer's connect
    // spawns the shared pty. The user's named scenario (a phone opens the pane first)
    // must not seed the pty with the phone's viewport.
    const paneId = observePaneId!;
    const rectOf = async (): Promise<{ width: number; height: number } | null> => {
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      return snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    };
    const rectBefore = await rectOf();
    expect(rectBefore).not.toBeNull();

    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const geometry = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId,
        "observer geometry",
        15_000,
      );
      // the spawned pty carries the pane's grid, not the observer's 40x20
      expect(geometry.cols).toBe(rectBefore!.width);
      expect(geometry.rows).toBe(rectBefore!.height);
      // herdr's layout is untouched either way
      expect(await rectOf()).toEqual(rectBefore);
    } finally {
      observer.close();
    }
  }, 30_000);
});

describe("WebSocket concurrent attach", () => {
  /** A pane nobody holds yet: the race is in CREATING the attachment. */
  let raceWorkspaceId: string | null = null;
  let racePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-race", cwd: "/tmp", focus: false },
    );
    raceWorkspaceId = created.workspace.workspace_id;
    racePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (raceWorkspaceId) await herdrRpc("workspace.close", { workspace_id: raceWorkspaceId }).catch(() => undefined);
  });

  it("shares one pty between clients whose attaches to the same pane race", async () => {
    const paneId = racePaneId!;
    const first = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const second = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: both attaches are in flight before either resolves the terminal
      first.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      second.send({ type: "attach", pane_id: paneId, cols: 120, rows: 40 });
      await first.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "first pty-data", 15_000);
      await second.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "second pty-data", 15_000);

      // one attachment means one client set: a resize reaches both. Two attachments
      // would leave one client on an orphaned record that never hears it.
      first.send({ type: "resize", pane_id: paneId, cols: 90, rows: 25 });
      await first.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "first hears resize", 5000);
      await second.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "second hears resize", 5000);
    } finally {
      first.close();
      second.close();
    }
  }, 40_000);
});

describe("WebSocket client leaving mid-attach", () => {
  /** One pane per trigger, so neither test inherits the other's attachment. */
  const leaveWorkspaceIds: string[] = [];

  async function createLeavePane(label: string): Promise<{ paneId: string; terminalId: string }> {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label, cwd: "/tmp", focus: false },
    );
    leaveWorkspaceIds.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as { terminal_id?: string } | undefined;
    expect(pane?.terminal_id).toBeTruthy();
    return { paneId, terminalId: pane!.terminal_id! };
  }

  /** The leaked resource itself: a live `herdr terminal attach` (or its sidecar) on this terminal. */
  function attachProcessCount(terminalId: string): number {
    const found = Bun.spawnSync(["pgrep", "-f", `terminal attach ${terminalId}`]);
    return found.stdout.toString().split("\n").filter(Boolean).length;
  }

  async function waitForAttachGone(terminalId: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (attachProcessCount(terminalId) > 0) {
      if (Date.now() > deadline) throw new Error(`attach on ${terminalId} still running ${ms}ms after its last client left`);
      await Bun.sleep(50);
    }
  }

  afterAll(async () => {
    for (const workspaceId of leaveWorkspaceIds) {
      await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    }
  });

  it("never pins the pty for a client that disconnects before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("herdr-web-ui-test-leave-close");
    expect(attachProcessCount(terminalId)).toBe(0);
    const leaver = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: the close lands while the attach is still looking up the terminal
      leaver.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      leaver.close();
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
    } finally {
      stayer.close();
    }
    // the last live client left, so nothing may keep the attach running
    await waitForAttachGone(terminalId, 5000);
  }, 40_000);

  it("never pins the pty for a client that detaches before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("herdr-web-ui-test-leave-detach");
    expect(attachProcessCount(terminalId)).toBe(0);
    const switcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // switching panes fast: the detach lands while the attach is still looking up the terminal
      switcher.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      switcher.send({ type: "detach", pane_id: paneId });
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
      stayer.close();
      // the switcher is still connected but detached: it must not keep the attach running
      await waitForAttachGone(terminalId, 5000);
      expect(switcher.seen.some((m) => m.type === "pty-data" && m.pane_id === paneId)).toBe(false);
    } finally {
      switcher.close();
      stayer.close();
    }
  }, 40_000);
});

/**
 * Bun's WebSocket client sends request headers, but this project compiles with lib.dom,
 * whose WebSocket type only knows subprotocols (bun-types steps aside via
 * UseLibDomIfAvailable). Reaching the real capability through a guard keeps the test
 * honest: if Bun ever stopped sending the header, the server refuses the upgrade and
 * the test fails instead of silently passing.
 */
function takesCookieHeader(value: unknown): value is CookieWebSocketCtor {
  return typeof value === "function";
}

function connectWithCookie(url: string, cookie: string): WebSocket {
  const ctor: unknown = globalThis.WebSocket;
  if (!takesCookieHeader(ctor)) throw new Error("no WebSocket constructor in this runtime");
  return new ctor(url, { headers: { cookie } });
}

describe("web push", () => {
  /** A fake push service that decrypts like a device: see push.fake.ts. */
  let fake: FakePushService;
  let pushWorkspaceId: string | null = null;
  let pushPaneId: string | null = null;

  const postJson = (path: string, body: unknown, method = "POST") =>
    fetch(`${base()}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    fake = await startFakePushService();
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-push", cwd: "/tmp", focus: false },
    );
    pushWorkspaceId = created.workspace.workspace_id;
    pushPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE").catch(() => undefined);
    fake.stop();
    if (pushWorkspaceId) await herdrRpc("workspace.close", { workspace_id: pushWorkspaceId }).catch(() => undefined);
  });

  it("hands out its VAPID key and refuses what is not a subscription", async () => {
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(Buffer.from(key.public_key, "base64url").length).toBe(65);

    const malformed = await postJson("/api/push/subscribe", { subscription: { endpoint: fake.subscription.endpoint, keys: {} } });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ApiError).error.code).toBe("invalid_subscription");

    const wrongMethod = await fetch(`${base()}/api/push/subscribe`);
    expect(wrongMethod.status).toBe(400);
    expect(((await wrongMethod.json()) as ApiError).error.code).toBe("method_not_allowed");
  });

  it("confirms a new device with a push it can decrypt, and forgets it on request", async () => {
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    expect((await postJson("/api/push/test", { endpoint: fake.subscription.endpoint })).status).toBe(204);
    const confirmation = await fake.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    expect(confirmation.payload.pane_id).toBeNull();
    expect(confirmation.vapidValid).toBe(true);
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(confirmation.vapidKey).toBe(key.public_key);

    expect((await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE")).status).toBe(204);
    const gone = await postJson("/api/push/test", { endpoint: fake.subscription.endpoint });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as ApiError).error.code).toBe("subscription_not_found");
  });

  it("pushes a live pane's status change to a subscribed device", async () => {
    const paneId = pushPaneId!;
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    // same retry as the pane-status test: the collector may still be re-subscribing to
    // the new pane, so alternate real changes until one lands as a push
    let pushed = null;
    for (let attempt = 0; attempt < 8 && !pushed; attempt += 1) {
      const state = attempt % 2 === 0 ? "blocked" : "working";
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state });
      if (state !== "blocked") continue;
      pushed = await fake
        .waitFor((push) => push.payload.pane_id === paneId, "status push", 2_500)
        .catch(() => null);
    }
    expect(pushed).not.toBeNull();
    expect(pushed!.payload.body).toBe("waiting for your input");
    expect(pushed!.payload.tag).toBe(`herdr-pane-${paneId}`);
    expect(pushed!.urgency).toBe("high");
    expect(pushed!.vapidValid).toBe(true);
  }, 40_000);

  it("alerts on the very first change after a restart, measured against herdr's snapshot", async () => {
    // A server restart must not cost the first alert: the collector seeds each pane's
    // status from its startup snapshot. Pane `watched` is already working when the new
    // server starts; pane `probe` shares the status subscription and proves it is live
    // before `watched` changes exactly once.
    const createPane = async (label: string) =>
      herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", {
        label,
        cwd: "/tmp",
        focus: false,
      });
    const watched = await createPane("herdr-web-ui-test-push-restart");
    const probe = await createPane("herdr-web-ui-test-push-probe");
    const watchedId = watched.root_pane.pane_id;
    const probeId = probe.root_pane.pane_id;
    const restartDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-restart-"));
    const device = await startFakePushService();
    let restarted: { port: number; stop: () => void } | null = null;
    let watcher: RecordingSocket | null = null;
    try {
      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "working" });
      const before = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(before.panes.find((pane) => pane.pane_id === watchedId)?.agent_status).toBe("working");

      restarted = createServer({ port: 0, stateDir: restartDir });
      const subscribe = await fetch(`http://localhost:${restarted.port}/api/push/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: device.subscription }),
      });
      expect(subscribe.status).toBe(204);
      watcher = await RecordingSocket.connect(`ws://localhost:${restarted.port}/ws`);

      let live = false;
      for (let attempt = 0; attempt < 8 && !live; attempt += 1) {
        const state = attempt % 2 === 0 ? "working" : "idle";
        await herdrRpc("pane.report_agent", { pane_id: probeId, source: "manual", agent: "claude", state });
        live = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === probeId && m.agent_status === state, "probe status", 2_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(live).toBeTrue();

      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "blocked" });
      await watcher.waitFor((m) => m.type === "pane-status" && m.pane_id === watchedId, "watched status", 5_000);
      const pushed = await device.waitFor((push) => push.payload.pane_id === watchedId, "first push after restart", 5_000);
      expect(pushed.payload.body).toBe("waiting for your input");
    } finally {
      watcher?.close();
      restarted?.stop();
      device.stop();
      rmSync(restartDir, { recursive: true, force: true });
      for (const created of [watched, probe]) {
        await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id }).catch(() => undefined);
      }
    }
  }, 60_000);
});

describe("token auth", () => {
  /**
   * A second server with the gate ON: the default instance above stays open so the
   * rest of the suite keeps proving that an empty token changes nothing.
   */
  const TOKEN = "s3cret";
  let secured: { port: number; stop: () => void };

  beforeAll(() => {
    secured = createServer({ port: 0, token: TOKEN, stateDir });
  });

  afterAll(() => {
    secured?.stop();
  });

  const securedBase = () => `http://127.0.0.1:${secured.port}`;
  const wsUrl = () => `ws://127.0.0.1:${secured.port}/ws`;

  it("rejects an unauthenticated API call with 401 unauthorized", async () => {
    const res = await fetch(`${securedBase()}/api/session`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps web push behind the gate: a subscription receives pane titles", async () => {
    for (const [method, path] of [["GET", "/api/push"], ["POST", "/api/push/subscribe"], ["POST", "/api/push/test"]] as const) {
      const res = await fetch(`${securedBase()}${path}`, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(401);
    }
  });

  it("keeps the image upload behind the gate", async () => {
    const res = await fetch(`${securedBase()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "w1:p1", content_type: "image/png", data_base64: "aaaa" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps /api/health public and advertises the gate state", async () => {
    const res = await fetch(`${securedBase()}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; auth: HealthAuth };
    expect(body.auth).toEqual({ required: true, authenticated: false });
  });

  it("refuses a token that does not match", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("invalid_token");
  });

  it("hands back a hardened session cookie for the right token", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`herdr_web_token=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=31536000");
  });

  it("accepts the session cookie", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { cookie: `herdr_web_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a bearer token", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("expires the cookie on logout", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("never upgrades a websocket without a token", async () => {
    const ws = new WebSocket(wsUrl());
    const outcome = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error/close within 5000ms")), 5000);
      const settle = (result: string) => {
        clearTimeout(timer);
        resolve(result);
      };
      ws.addEventListener("error", () => settle("error"));
      ws.addEventListener("close", () => settle("close"));
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error("the upgrade succeeded without a token"));
      });
    });
    expect(["error", "close"]).toContain(outcome);
  }, 10000);

  it("upgrades a websocket that carries the cookie", async () => {
    const ws = connectWithCookie(wsUrl(), `herdr_web_token=${TOKEN}`);
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message within 5000ms")), 5000);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the upgrade was refused despite a valid cookie"));
      });
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String((event as MessageEvent).data)) as { type: string });
      });
    });
    expect(first.type).toBe("snapshot");
    ws.close();
  }, 10000);
});

describe("bind address", () => {
  let loopback: { port: number; stop: () => void };

  beforeAll(() => {
    loopback = createServer({ port: 0, hostname: "127.0.0.1", stateDir });
  });

  afterAll(() => {
    loopback?.stop();
  });

  it("serves the API on the requested hostname", async () => {
    const res = await fetch(`http://127.0.0.1:${loopback.port}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe("generated wire types", () => {
  it("carries an unknown agent_status through instead of dropping or throwing", async () => {
    // herdr gives no stability guarantee: a status this build has never heard of
    // must still reach the UI so it can render something honest.
    const res = await fetch(`${base()}/api/session`);
    const { snapshot } = (await res.json()) as { snapshot: SessionSnapshot };
    const mutated: SessionSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        agent_status: "teleporting" as AgentStatus,
      })),
    };
    const roundTripped = JSON.parse(JSON.stringify(mutated)) as SessionSnapshot;
    for (const workspace of roundTripped.workspaces) {
      expect(workspace.agent_status).toBe("teleporting");
    }
    expect(roundTripped.workspaces.length).toBe(snapshot.workspaces.length);
  });
});


describe("PC management API", () => {
  it("reports bridge auth independently of herdr and exposes the local PC", async () => {
    const health = await fetch(`${base()}/api/health?scope=bridge`);
    expect(health.status).toBe(200);
    const body = await health.json() as { auth: HealthAuth; bridge_protocol: number };
    expect(body.bridge_protocol).toBe(1);
    expect(body.auth.authenticated).toBe(true);
    const list = await fetch(`${base()}/api/machines`);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const data = await list.json() as { machines: { id: string; kind: string }[] };
    expect(data.machines[0]).toMatchObject({ id: "local", kind: "local" });
    const local = await fetch(`${base()}/api/machines/local/session`);
    expect(local.status).toBe(200);
  });
  it("rejects CSRF, malformed targets and remote forwarding outside the allowlist", async () => {
    for (const headers of [{}, { "x-herdr-machine": "1", origin: "https://evil.invalid" }, { "x-herdr-machine": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers, body: JSON.stringify({ destination: "host" }) });
      expect(response.status).toBe(403);
    }
    const bad = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers: { "x-herdr-machine": "1" }, body: JSON.stringify({ destination: "-oProxyCommand=bad" }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base()}/api/machines/missing/pane/read?pane_id=p1`)).status).toBe(503);
    expect((await fetch(`${base()}/api/machines/missing/auth`)).status).toBe(404);
  });
  it("gates PC metadata, setup and SSE behind the existing token", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "herdr-machine-auth-"));
    const gated = createServer({ port: 0, token: "machine-test-secret", stateDir });
    try {
      for (const path of ["/api/machines", "/api/machines/events", "/api/machines/setup", "/api/bridge"]) expect((await fetch(`http://localhost:${gated.port}${path}`)).status).toBe(401);
      const health = await fetch(`http://localhost:${gated.port}/api/health?scope=bridge`).then((r) => r.json()) as { auth: HealthAuth };
      expect(health.auth).toEqual({ required: true, authenticated: false });
    } finally { gated.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});
