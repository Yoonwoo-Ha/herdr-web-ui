import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneSendText, paneSendKeys } from "./herdr/client.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-output-contract-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  server.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function pane(): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-web-ui-test-output", cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function connect(paneId: string, ack = true, observer = false) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(ws);
  const state = {
    bytes: 0, frames: 0, ack, code: 0, exits: 0,
    latest: undefined as Extract<ServerMessage, { type: "pty-data" }> | undefined,
    errors: [] as string[], tail: "",
  };
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const acknowledge = (frame = state.latest) => {
    if (frame?.flow && ws.readyState === WebSocket.OPEN) send({ type: "pty-ack", pane_id: paneId, ...frame.flow });
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type !== "pty-data" || frame.pane_id !== paneId) return;
    state.bytes += Buffer.byteLength(frame.data);
    state.frames++;
    state.latest = frame;
    state.tail = (state.tail + frame.data).slice(-8192);
    if (state.ack) acknowledge(frame);
  });
  ws.addEventListener("close", (event) => { state.code = event.code; });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  if (observer) send({ type: "role", mode: "observe" });
  send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
  await until(() => state.frames > 0, "initial terminal paint");
  return { ws, state, send, acknowledge };
}

async function flood(paneId: string): Promise<void> {
  // Redraws reach the attach stream; raw shell byte rate alone is not its workload.
  await Bun.sleep(150); // herdr's attach consumes very early keystrokes
  await paneSendText(paneId, `python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23),sys.stdout.flush(),time.sleep(.01)) for i in range(1500)]'`);
  await paneSendKeys(paneId, ["Enter"]);
}

describe("real terminal output flow control", () => {
  it("waits for the old attach to retire when a pane is reopened immediately", async () => {
    const paneId = await pane();
    const client = await connect(paneId);
    try {
      const old = client.state.latest!.flow!;
      client.send({ type: "detach", pane_id: paneId });
      client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      await until(() => !!client.state.latest?.flow && client.state.latest.flow.stream_id !== old.stream_id, "fresh attach after retirement");
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: old.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await Bun.sleep(100);
      expect(client.state.errors).toEqual([]);
      expect(client.state.exits).toBe(0);
      expect(client.state.code).toBe(0);
    } finally { client.ws.close(); }
  }, 20_000);

  it("bounds a stalled observer, releases the operator, and leaves the pane alive", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    const observer = await connect(paneId, false, true);
    try {
      await flood(paneId);
      await until(() => observer.state.bytes >= OUTPUT_HIGH_BYTES, "observer high watermark", 15_000);
      const started = Date.now();
      await until(() => observer.state.code !== 0, "stalled observer closed", OUTPUT_STALL_MS + 3000);
      expect(observer.state.code).toBe(OUTPUT_STALLED_CLOSE_CODE);
      expect(observer.state.bytes).toBeLessThanOrEqual(OUTPUT_HARD_BYTES);
      expect(Date.now() - started).toBeLessThan(OUTPUT_STALL_MS + 2000);
      const received = operator.state.bytes;
      await until(() => operator.state.bytes > received + 4096, "operator output resumes");
      // Ctrl+C takes the actual WS input path while output is running.
      operator.send({ type: "input", pane_id: paneId, text: "\x03" });
      await Bun.sleep(200);
      operator.send({ type: "input", pane_id: paneId, text: "printf 'FLOW_%s\\n' ALIVE\r" });
      await until(() => operator.state.tail.includes("FLOW_ALIVE"), "pane survives observer eviction");
      expect(operator.state.code).toBe(0);
      expect(operator.state.errors).toEqual([]);
    } finally { operator.ws.close(); observer.ws.close(); }
  }, 35_000);

  it("resumes on valid ACKs and rejects future credit without accepting stale subscriptions", async () => {
    const paneId = await pane();
    const client = await connect(paneId, false);
    try {
      const initial = client.state.latest!;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: initial.flow!.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await until(() => client.state.errors.includes("invalid_ack"), "future ACK refused");
      await flood(paneId);
      await until(() => client.state.bytes >= OUTPUT_HIGH_BYTES, "pause at high watermark", 15_000);
      await Bun.sleep(200);
      const paused = client.state.bytes;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: "previous-subscription", offset: paused });
      await Bun.sleep(200);
      expect(client.state.bytes).toBe(paused);
      client.state.ack = true;
      client.acknowledge();
      await until(() => client.state.bytes > paused + 4096, "valid credit resumes output");
      expect(client.state.code).toBe(0);
      client.send({ type: "input", pane_id: paneId, text: "\x03" });
    } finally { client.ws.close(); }
  }, 30_000);
});
