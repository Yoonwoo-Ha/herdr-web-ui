import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createServer } from "./index.ts";
import type { SessionSnapshot, PaneReadResult } from "../shared/protocol.ts";

/**
 * Contract test for herdr-br's HTTP + WS surface.
 * Runs against the REAL herdr server on the developer's machine: these are the
 * integration seams the browser UI depends on, so a mock here would prove nothing.
 * READ-ONLY: never creates, closes, or writes to a pane the user owns.
 */
let server: { port: number; stop: () => void };

beforeAll(() => {
  server = createServer({ port: 0 });
});

afterAll(() => {
  server?.stop();
});

const base = () => `http://localhost:${server.port}`;

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

describe("WebSocket /ws", () => {
  it("pushes a snapshot message on connect and streams pane output for a watched pane", async () => {
    const snapRes = await fetch(`${base()}/api/session`);
    const { snapshot } = (await snapRes.json()) as { snapshot: SessionSnapshot };
    const paneId = snapshot.panes[0]!.pane_id;

    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    const messages: any[] = [];
    const gotSnapshot = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no snapshot message within 5s")), 5000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data));
        messages.push(msg);
        if (msg.type === "snapshot") {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); });
    });
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    await gotSnapshot;

    const snapshotMsg = messages.find((m) => m.type === "snapshot");
    expect(snapshotMsg.snapshot.workspaces.length).toBeGreaterThan(0);

    // watching a pane yields its current output without a reload
    const gotOutput = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no pane-output within 8s")), 8000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data));
        if (msg.type === "pane-output" && msg.pane_id === paneId) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    ws.send(JSON.stringify({ type: "watch", pane_id: paneId }));
    const output = await gotOutput;
    expect(typeof output.text).toBe("string");
    ws.close();
  });
});
