import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, SUBMIT_DELAY_MS } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * Contract test for the composer's "submit" frame, against the real herdr server.
 * Each pane runs a raw-mode recorder that logs every chunk of input it reads with its
 * arrival time, so the test sees what the agent's TUI would: the text, then its Enter
 * as a separate keypress. One recorder is a plain program (the send_text path), the
 * other runs under the name `claude` and is reported as that agent (herdr's
 * agent.prompt path).
 */
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-submit-"));
let server: { port: number; stop: () => void };
const workspaces: string[] = [];

const RECORDER = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
// bracketed paste on, as agent TUIs have it: herdr passes the paste markers through;
// then what the TUI would show, when asked to (argv[3])
process.stdout.write("\\u001b[?2004h" + (process.argv[3] ?? ""), () => writeFileSync(out, ""));
process.stdin.on("data", (chunk) => appendFileSync(out, JSON.stringify({ at: Date.now(), data: chunk.toString("utf8") }) + "\\n"));
`;

interface Chunk { at: number; data: string }
interface Recorder { pane: string; log: string }
let shell: Recorder;
let agent: Recorder;
let codex: Recorder;
let codexApproval: Recorder;
let claudeQueue: Recorder;

const chunks = (recorder: Recorder): Chunk[] =>
  readFileSync(recorder.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Chunk);
const typed = (recorder: Recorder, from: number) => chunks(recorder).slice(from).map((chunk) => chunk.data).join("");

/** the chunks read since `from`, once their bytes hold `count` Enters */
async function received(recorder: Recorder, from: number, count: number): Promise<Chunk[]> {
  for (let i = 0; i < 100; i++) {
    if (typed(recorder, from).split("\r").length > count) return chunks(recorder).slice(from);
    await Bun.sleep(50);
  }
  throw new Error(`no ${count} Enter(s) within 5s: ${JSON.stringify(chunks(recorder).slice(from))}`);
}

async function recorder(label: string, program: string, screen = ""): Promise<Recorder> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-submit-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.jsonl`);
  const shown = screen ? ` '${screen.replace(/\n/g, "\r\n")}'` : "";
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${program}' '${join(root, "record.js")}' '${log}'${shown}\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  return { pane: created.root_pane.pane_id, log };
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
  result(id: number): Promise<any> {
    return this.waitFor((message) => message.type === "submit-result" && message.id === id);
  }
  close(): void {
    this.ws.close();
  }
}

const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "record.js"), RECORDER);
  // herdr's agent.prompt checks that the pane's foreground process is the agent
  copyFileSync(process.execPath, join(root, "claude"));
  chmodSync(join(root, "claude"), 0o755);
  copyFileSync(process.execPath, join(root, "codex"));
  chmodSync(join(root, "codex"), 0o755);
  shell = await recorder("shell", process.execPath);
  agent = await recorder("agent", join(root, "claude"));
  await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
  // Codex with a question waiting collapsed in its queue: herdr calls it blocked
  const queue = "\n• Queued follow-up inputs\n  ? 1 question\n    alt+↑ to answer\n";
  codex = await recorder("codex", join(root, "codex"), `${queue}› Ask Codex to do anything\n`);
  await herdrRpc("pane.report_agent", { pane_id: codex.pane, source: "manual", agent: "codex", state: "blocked" });
  // the queue above an approval: the approval holds the input, and y / Enter would answer it
  codexApproval = await recorder("codex-approval", join(root, "codex"), `${queue}\nWould you like to run the following command?\n\n$ rm -rf junk\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n`);
  await herdrRpc("pane.report_agent", { pane_id: codexApproval.pane, source: "manual", agent: "codex", state: "blocked" });
  // the same text in a pane whose agent is not Codex
  claudeQueue = await recorder("claude-queue", join(root, "claude"), `${queue}› Ask Codex to do anything\n`);
  await herdrRpc("pane.report_agent", { pane_id: claudeQueue.pane, source: "manual", agent: "claude", state: "blocked" });
}, 30_000);

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("WebSocket submit", () => {
  it("lists the submit feature in the first snapshot", async () => {
    const socket = await Socket.connect();
    try {
      // a pane-status can arrive first: the snapshot is found by its type
      expect(socket.seen.find((message) => message.type === "snapshot")?.features).toContain("submit");
    } finally {
      socket.close();
    }
  });

  it("types the payload into a pane without an agent, then its own Enter SUBMIT_DELAY_MS later, and says so", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 1, pane_id: shell.pane, text: "hello", payload: paste("hello") });
      expect(await socket.result(1)).toMatchObject({ ok: true, pane_id: shell.pane });
      const read = await received(shell, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("hello"));
      expect(read[enter]!.data).toBe("\r");
      expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS - 20);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("hands an agent the message through herdr's agent.prompt: the paste, then Enter apart", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 2, pane_id: agent.pane, text: "line one\nline two", payload: "unused" });
      expect(await socket.result(2)).toMatchObject({ ok: true });
      const read = await received(agent, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("line one\nline two"));
      expect(read[enter]!.data).toBe("\r");
      expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("refuses a message while the agent waits for an answer, typing nothing", async () => {
    const socket = await Socket.connect();
    await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "blocked" });
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 3, pane_id: agent.pane, text: "yes", payload: "yes" });
      expect(await socket.result(3)).toMatchObject({ ok: false, code: "agent_blocked" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(chunks(agent).slice(from)).toEqual([]);
    } finally {
      await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
      socket.close();
    }
  }, 30_000);

  it("still hands a message to a Codex blocked only by questions waiting collapsed in its queue", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(codex).length;
      socket.send({ type: "submit", id: 9, pane_id: codex.pane, text: "stop, do not touch prod", payload: paste("stop, do not touch prod") });
      expect(await socket.result(9)).toMatchObject({ ok: true });
      await received(codex, from, 1);
      expect(typed(codex, from)).toBe(`${paste("stop, do not touch prod")}\r`);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("never types a message into an approval under the queue, nor for an agent other than Codex", async () => {
    const socket = await Socket.connect();
    try {
      for (const [id, recorder] of [[10, codexApproval], [11, claudeQueue]] as const) {
        const from = chunks(recorder).length;
        socket.send({ type: "submit", id, pane_id: recorder.pane, text: "y", payload: "y" });
        expect(await socket.result(id)).toMatchObject({ ok: false, code: "agent_blocked" });
        await Bun.sleep(SUBMIT_DELAY_MS * 3);
        expect(chunks(recorder).slice(from)).toEqual([]);
      }
    } finally {
      socket.close();
    }
  }, 30_000);

  it("keeps other input behind a message in flight: a Stop right after Send lands after its Enter", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 4, pane_id: shell.pane, text: "one", payload: "one" });
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 5, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(5);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\r\u001btwo\r");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("sends a message typed right after a Stop only once the Stop reached the pane", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      await Bun.sleep(300);
      const from = chunks(shell).length;
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 8, pane_id: shell.pane, text: "after", payload: "after" });
      await socket.result(8);
      await received(shell, from, 1);
      expect(typed(shell, from)).toBe("\u001bafter\r");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("types nothing of a message that waited past its deadline behind another", async () => {
    // a deadline of 50ms: the second message waits longer than that behind the first one's gap
    const hurried = createServer({ port: 0, stateDir: join(root, "push-hurried"), submitDeadlineMs: 50 });
    const ws = new WebSocket(`ws://localhost:${hurried.port}/ws`);
    const seen: any[] = [];
    ws.addEventListener("message", (event) => seen.push(JSON.parse(String((event as MessageEvent).data))));
    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
      for (let i = 0; i < 100 && !seen.some((message) => message.type === "snapshot"); i++) await Bun.sleep(50);
      const from = chunks(shell).length;
      ws.send(JSON.stringify({ type: "submit", id: 1, pane_id: shell.pane, text: "first", payload: "first" }));
      ws.send(JSON.stringify({ type: "submit", id: 2, pane_id: shell.pane, text: "late", payload: "late" }));
      let late: any;
      for (let i = 0; i < 100 && !(late = seen.find((message) => message.type === "submit-result" && message.id === 2)); i++) await Bun.sleep(50);
      expect(seen.find((message) => message.type === "submit-result" && message.id === 1)).toMatchObject({ ok: true });
      expect(late).toMatchObject({ ok: false, code: "submit_timeout" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(typed(shell, from)).toBe("first\r");
    } finally {
      ws.close();
      hurried.stop();
    }
  }, 30_000);

  it("still sends the Enter after the sender is gone", async () => {
    const socket = await Socket.connect();
    const from = chunks(shell).length;
    // closed right after the tap, as a phone that locks: the server finishes the send
    socket.send({ type: "submit", id: 6, pane_id: shell.pane, text: "gone", payload: "gone" });
    await Bun.sleep(20);
    socket.close();
    await received(shell, from, 1);
    expect(typed(shell, from)).toBe("gone\r");
  }, 30_000);

  it("answers a submit from an observe connection with read_only, typing nothing", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(shell).length;
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack");
      socket.send({ type: "submit", id: 7, pane_id: shell.pane, text: "nope", payload: "nope" });
      expect(await socket.result(7)).toMatchObject({ ok: false, code: "read_only" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(chunks(shell).slice(from)).toEqual([]);
    } finally {
      socket.close();
    }
  }, 30_000);
});
