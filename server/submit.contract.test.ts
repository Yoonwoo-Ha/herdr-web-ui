import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, SUBMIT_DELAY_MS } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * Contract test for the composer's "submit" frame, against the real herdr server.
 * The pane runs a raw-mode recorder that logs every chunk of input it reads with its
 * arrival time, so the test sees what the agent's TUI would: the text, then its Enter
 * as a separate keypress SUBMIT_DELAY_MS later.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-submit-"));
let server: { port: number; stop: () => void };
let workspaceId: string | null = null;
let paneId = "";
let log = "";

const RECORDER = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
// bracketed paste on, as agent TUIs have it: herdr passes the paste markers through
process.stdout.write("\u001b[?2004h", () => writeFileSync(out, ""));
process.stdin.on("data", (chunk) => appendFileSync(out, JSON.stringify({ at: Date.now(), data: chunk.toString("utf8") }) + "\\n"));
`;

interface Chunk { at: number; data: string }

function chunks(): Chunk[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Chunk);
}

/** the chunks read since `from`, once their bytes end with the `count`-th Enter */
async function received(from: number, count: number): Promise<Chunk[]> {
  for (let i = 0; i < 100; i++) {
    const read = chunks().slice(from);
    if (read.map((chunk) => chunk.data).join("").split("\r").length > count) return read;
    await Bun.sleep(50);
  }
  throw new Error(`no ${count} Enter(s) within 5s: ${JSON.stringify(chunks().slice(from))}`);
}

class Socket {
  readonly seen: any[] = [];
  private readonly ws: WebSocket;
  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => this.seen.push(JSON.parse(String((event as MessageEvent).data))));
  }
  static async connect(): Promise<Socket> {
    const socket = new Socket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    await socket.waitFor((message) => message.type === "snapshot");
    return socket;
  }
  async waitFor(predicate: (message: any) => boolean, ms = 15_000): Promise<any> {
    for (let waited = 0; waited < ms; waited += 25) {
      const found = this.seen.find(predicate);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`frame not received within ${ms}ms`);
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create",
    { label: "herdr-web-ui-test-submit", cwd: root, focus: false },
  );
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  const script = join(root, "record.js");
  log = join(root, "input.jsonl");
  writeFileSync(script, RECORDER);
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `exec '${process.execPath}' '${script}' '${log}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
}, 20_000);

afterAll(async () => {
  server?.stop();
  if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("WebSocket submit", () => {
  it("lists the submit feature in the first snapshot", async () => {
    const socket = await Socket.connect();
    try {
      expect(socket.seen[0].type).toBe("snapshot");
      expect(socket.seen[0].features).toContain("submit");
    } finally {
      socket.close();
    }
  });

  it("types the text, then its own Enter SUBMIT_DELAY_MS later", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === paneId);
      const from = chunks().length;
      socket.send({ type: "submit", pane_id: paneId, text: "\u001b[200~hello\u001b[201~" });
      const read = await received(from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe("\u001b[200~hello\u001b[201~");
      expect(read[enter]!.data).toBe("\r");
      expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS - 20);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("keeps a quick second message behind the first one's Enter", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === paneId);
      const from = chunks().length;
      socket.send({ type: "submit", pane_id: paneId, text: "one" });
      socket.send({ type: "submit", pane_id: paneId, text: "two" });
      const read = await received(from, 2);
      expect(read.map((chunk) => chunk.data).join("")).toBe("one\rtwo\r");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("still sends the Enter after the sender is gone", async () => {
    const socket = await Socket.connect();
    const from = chunks().length;
    // closed right after the tap, as a phone that locks: the server finishes the send
    socket.send({ type: "submit", pane_id: paneId, text: "gone" });
    await Bun.sleep(20);
    socket.close();
    const read = await received(from, 1);
    expect(read.map((chunk) => chunk.data).join("")).toBe("gone\r");
  }, 30_000);

  it("refuses a submit from an observe connection", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks().length;
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack");
      socket.send({ type: "submit", pane_id: paneId, text: "nope" });
      const refused = await socket.waitFor((message) => message.type === "error");
      expect(refused.code).toBe("read_only");
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(chunks().slice(from)).toEqual([]);
    } finally {
      socket.close();
    }
  }, 30_000);
});
