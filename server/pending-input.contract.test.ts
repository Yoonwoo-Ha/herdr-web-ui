import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneRead, sessionSnapshot } from "./herdr/client.ts";
import { parseInteractivePrompt } from "./prompt.ts";
import type { PendingMessage } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pending-"));
const active: Array<{ stop: () => void; sockets: Socket[]; workspace: string }> = [];
let next = 0;
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
const approval = "Would you like to run the following command?\n\n$ rm -rf junk\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n";

class Socket {
  readonly seen: any[] = [];
  private readonly ws: WebSocket;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.addEventListener("message", (event) => this.seen.push(JSON.parse(String((event as MessageEvent).data))));
  }
  async wait(predicate: (frame: any) => boolean, from = 0): Promise<any> {
    const deadline = Date.now() + 15_000;
    while (true) {
      const value = this.seen.slice(from).find(predicate);
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`pending frame timeout: ${JSON.stringify(this.seen.slice(-5))}`);
      await Bun.sleep(25);
    }
  }
  send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }
  result(id: number) { return this.wait((frame) => frame.type === "submit-result" && frame.id === id); }
  action(id: number) { return this.wait((frame) => frame.type === "pending-result" && frame.id === id); }
  async attach(pane: string) {
    await this.wait((frame) => frame.type === "snapshot");
    this.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
    await this.wait((frame) => frame.type === "input-ready" && frame.pane_id === pane && frame.ready !== false);
  }
  close() { this.ws.close(); }
  async disconnect() { await new Promise<void>((resolve) => { this.ws.addEventListener("close", () => resolve(), { once: true }); this.close(); }); }
}

beforeAll(() => {
  writeFileSync(join(root, "record.cjs"), `const fs=require("node:fs");const out=process.argv[2];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h"+(process.argv[3]||""),()=>fs.writeFileSync(out,""));process.stdin.on("data",c=>fs.appendFileSync(out,JSON.stringify(c.toString("utf8"))+"\\n"));const watch=fs.watch(process.argv[4],()=>process.stdout.write("\\x1b[2J\\x1b[H"+fs.readFileSync(process.argv[4],"utf8")));process.on("exit",()=>watch.close());`);
  for (const name of ["claude", "codex", "plain"]) { copyFileSync(process.execPath, join(root, name)); chmodSync(join(root, name), 0o755); }
});
afterEach(async () => {
  for (const item of active.splice(0)) { for (const socket of item.sockets) socket.close(); item.stop(); await herdrRpc("workspace.close", { workspace_id: item.workspace }).catch(() => undefined); }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function setup(label: string, agent = "claude", screen = "› Message\n", options: Parameters<typeof createServer>[0] = {}) {
  const id = ++next;
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { label: `herdr-web-ui-test-pending-${label}`, cwd: root, focus: false });
  // registered before anything below can throw, so afterEach closes the workspace of a setup that failed
  const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
  const pane = created.root_pane.pane_id;
  const log = join(root, `${id}.jsonl`);
  const screenFile = join(root, `${id}.screen`);
  writeFileSync(screenFile, "");
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${join(root, agent)}' '${join(root, "record.cjs")}' '${log}' '${screen.replace(/\n/g, "\r\n")}' '${screenFile}'\n` });
  const deadline = Date.now() + 10_000;
  while (!existsSync(log)) { if (Date.now() > deadline) throw new Error("recorder did not start"); await Bun.sleep(25); }
  // "plain" is a program herdr knows as no agent
  if (agent !== "plain") await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent, state: "working" });
  const server = createServer({ ...options, port: 0, stateDir: join(root, `state-${id}`) });
  entry.stop = server.stop;
  const socket = new Socket(server.port); entry.sockets.push(socket);
  await socket.attach(pane);
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  const waitBytes = async (ending: string) => {
    const deadline = Date.now() + 8_000;
    while (!bytes().endsWith(ending)) { if (Date.now() >= deadline) throw new Error(`input timeout: ${JSON.stringify(bytes())}`); await Bun.sleep(25); }
  };
  const state = async (value: string, reader = socket) => {
    const from = reader.seen.length;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent, state: value });
    await reader.wait((frame) => frame.type === "pane-status" && frame.pane_id === pane && (value === "idle" || value === "unknown" ? ["idle", "done"].includes(frame.agent_status) : frame.agent_status === value), from);
  };
  // `ending`: what the screen ends with once drawn, for a text taller than the pane
  const showScreen = async (text: string, ending = text) => {
    writeFileSync(screenFile, text);
    const deadline = Date.now() + 5_000;
    while (!(await paneRead({ paneId: pane, source: "visible", format: "text" })).text.trimEnd().endsWith(ending.trimEnd())) {
      if (Date.now() >= deadline) throw new Error("recorder screen did not update");
      await Bun.sleep(25);
    }
  };
  const queue = async (id: number, text: string): Promise<PendingMessage> => {
    socket.send({ type: "submit", id, pane_id: pane, text, payload: "unused\r", delivery: "queue" });
    const answer = await socket.result(id); expect(answer.ok).toBe(true); expect(answer.pending?.request_id).toBe(id); return answer.pending;
  };
  const removed = (id: string, outcome = "sent", reader = socket) => reader.wait((frame) => frame.type === "pending-messages" && frame.pane_id === pane && frame.removed?.some((entry: any) => entry.id === id && entry.outcome === outcome));
  const another = async (attach = true) => { const reader = new Socket(server.port); entry.sockets.push(reader); if (attach) await reader.attach(pane); else await reader.wait((frame) => frame.type === "snapshot"); return reader; };
  return { pane, socket, bytes, waitBytes, state, showScreen, queue, removed, another };
}

describe("connection-owned pending input", () => {
  it("queues any working agent and advances one message per confirmed turn", async () => {
    const f = await setup("automatic");
    const first = await f.queue(1, "한글 👩🏽‍💻\nnext"); const second = await f.queue(2, "second");
    expect(f.bytes()).toBe("");
    await f.state("idle"); await f.removed(first.id); await f.waitBytes("\r");
    expect(f.bytes()).toBe(`${paste(first.text)}\r`);
    const receipt = f.socket.seen.filter((frame) => frame.type === "pending-messages").at(-1);
    expect(receipt.messages.find((message: PendingMessage) => message.id === second.id)?.state).toBe("queued");
    await f.state("working"); await f.state("idle"); await f.removed(second.id); await f.waitBytes(`${paste("second")}\r`);
    expect(f.bytes()).toBe(`${paste(first.text)}\r${paste("second")}\r`);
  }, 30_000);

  it("promotes a pending message only once and does not send it again after completion", async () => {
    const f = await setup("promote"); const message = await f.queue(1, "steer once");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true }); await f.removed(message.id); await f.waitBytes("\r");
    const late = f.socket.seen.length;
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true });
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.removed?.some((entry: any) => entry.id === message.id && entry.outcome === "sent"), late);
    await f.state("idle");
    f.socket.send({ type: "submit", id: 12, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await f.socket.result(12)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe(`${paste("steer once")}\rbarrier\r`);
  }, 30_000);

  it("arbitrates completion racing with a click without duplicate input", async () => {
    const f = await setup("race"); const message = await f.queue(1, "race once");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.state("idle"); expect(await f.socket.action(10)).toMatchObject({ ok: true });
    await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("race once")}\r`);
  }, 30_000);

  it("discards pending input without typing and keeps owner receipts private", async () => {
    const f = await setup("discard"); const intruder = await f.another(); const message = await f.queue(1, "discard me");
    intruder.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await intruder.action(10)).toMatchObject({ ok: false, code: "pending_not_found" });
    expect(intruder.seen.filter((frame) => frame.type === "pending-messages")).toEqual([]);
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "discard" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true }); await f.removed(message.id, "discarded");
    await f.state("idle"); expect(f.bytes()).toBe("");
  }, 30_000);

  it("deduplicates accepted submit ids and rejects different text on the same id", async () => {
    const f = await setup("dedupe"); const message = await f.queue(1, "once");
    const from = f.socket.seen.length;
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "once", payload: "unused\r", delivery: "queue" });
    expect((await f.socket.wait((frame) => frame.type === "submit-result" && frame.id === 1, from)).pending.id).toBe(message.id);
    const changed = f.socket.seen.length;
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "different", payload: "unused\r", delivery: "queue" });
    expect(await f.socket.wait((frame) => frame.type === "submit-result" && frame.id === 1, changed)).toMatchObject({ ok: false, code: "invalid_submit_id" });
    await f.state("idle"); await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("once")}\r`);
    const completed = f.socket.seen.length;
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "once", payload: "unused\r", delivery: "queue" });
    expect((await f.socket.wait((frame) => frame.type === "submit-result" && frame.id === 1, completed)).pending).toBeUndefined();
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.removed?.some((entry: any) => entry.id === message.id && entry.outcome === "sent"), completed);
  }, 30_000);

  it("holds on observe mode and requires a fresh explicit steer after interact resumes", async () => {
    const f = await setup("observe"); const message = await f.queue(1, "held");
    f.socket.send({ type: "role", mode: "observe" });
    await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe");
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "held"));
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "read_only" });
    await f.state("idle"); expect(f.bytes()).toBe("");
    f.socket.send({ type: "role", mode: "interact" }); await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact");
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true }); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("held")}\r`);
  }, 30_000);

  it("does not auto-send or replay a closed connection's pending input", async () => {
    const f = await setup("disconnect"); const keeper = await f.another(); const message = await f.queue(1, "never replay");
    await f.socket.disconnect(); await f.state("idle", keeper);
    keeper.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await keeper.result(20)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r"); expect(f.bytes()).toBe("barrier\r");
    keeper.send({ type: "pending-action", id: 21, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await keeper.action(21)).toMatchObject({ ok: false, code: "pending_not_found" });
  }, 30_000);

  it("cancels the committing key when a sender closes after its paste", async () => {
    const f = await setup("partial", "claude", "› Message\n", { submitDelayMs: 750 }); const keeper = await f.another(); const message = await f.queue(1, "partial");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.waitBytes("\u001b[201~"); await f.socket.disconnect();
    keeper.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await keeper.result(20)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r"); expect(f.bytes()).toBe(`${paste("partial")}barrier\r`);
  }, 30_000);

  it("rejects a real menu, malformed delivery and terminal-mode queue before typing", async () => {
    const f = await setup("menu", "codex", approval);
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "no", payload: "no", delivery: "queue" });
    expect(await f.socket.result(1)).toMatchObject({ ok: false, code: "agent_blocked" });
    for (const [id, delivery, typed] of [[2, "bad", false], [3, "queue", true]] as const) {
      f.socket.send({ type: "submit", id, pane_id: f.pane, text: "no", payload: "no", delivery, typed });
      expect(await f.socket.result(id)).toMatchObject({ ok: false, code: "invalid_delivery" });
    }
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("uses a collector-confirmed Codex finish even when its raw status is unknown", async () => {
    const f = await setup("codex-finish", "codex"); const message = await f.queue(1, "after finish");
    await f.state("unknown"); await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("after finish")}\r`);
  }, 30_000);

  it("falls back to immediate Enter when a queued request arrives after the agent became ready", async () => {
    const f = await setup("ready-race"); await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "ready now", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(1)).toMatchObject({ ok: true }); expect((await f.socket.result(1)).pending).toBeUndefined();
    await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("ready now")}\r`);
    expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
  }, 30_000);

  it("refuses a queue request when no agent is in front, and types nothing into the program there", async () => {
    const f = await setup("no-agent", "plain");
    expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === f.pane)?.agent ?? null).toBeNull();
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "for the agent", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(1)).toMatchObject({ ok: false, code: "agent_not_ready" });
    expect(f.bytes()).toBe("");
    expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
  }, 30_000);

  it("keeps a request that finds the agent ready behind the messages already waiting", async () => {
    const f = await setup("ready-behind", "claude", "› Message\n", { pendingStartTimeoutMs: 20_000 });
    const first = await f.queue(1, "first"); const second = await f.queue(2, "second");
    await f.state("idle"); await f.removed(first.id); await f.waitBytes("\r");
    // the first one's turn has not been seen starting, so the second still waits while the pane reads ready
    const third = await f.queue(3, "third");
    expect(f.bytes()).toBe(`${paste("first")}\r`);
    await f.state("working"); await f.state("idle"); await f.removed(second.id);
    await f.state("working"); await f.state("idle"); await f.removed(third.id); await f.waitBytes(`${paste("third")}\r`);
    expect(f.bytes()).toBe(`${paste("first")}\r${paste("second")}\r${paste("third")}\r`);
  }, 30_000);

  it("waits behind a message Claude Code holds for its invisible characters, with no hint left on screen", async () => {
    const f = await setup("held");
    // the first queued message, with a zero-width space, goes at the next turn as usual
    await f.queue(1, "first\u200bmessage");
    await f.state("idle");
    await f.waitBytes(`${paste("first\u200bmessage")}\r`);
    // Claude took the character out and kept the message in its box; its hint has gone
    const rule = "\u2500".repeat(60);
    await f.state("working");
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f firstmessage\n${rule}\n  [Haiku 4.5] \u2502 project\n`, "[Haiku 4.5] \u2502 project");
    const before = f.bytes();
    // the held message is a card to answer first, as a menu is: nothing is queued or pasted over it
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "second", payload: "unused\r", delivery: "queue" });
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    await f.state("idle");
    await Bun.sleep(500);
    expect(f.bytes()).toBe(before);
  }, 30_000);

  it("sends the same words again after a held message was dealt with: its own paste is no held message", async () => {
    // a long pause between paste and Enter, so the screen below is drawn before the check ahead of the Enter
    const f = await setup("held-again", "claude", "› Message\n", { submitDelayMs: 3_000 });
    const first = await f.queue(1, "same\u200bmessage");
    await f.state("idle"); await f.removed(first.id);
    await f.waitBytes(`${paste("same\u200bmessage")}\r`);
    // dealt with in the terminal; the message goes out once more, the character taken out by hand
    await f.state("working");
    const second = await f.queue(2, "samemessage");
    await f.state("idle");
    await f.waitBytes(paste("samemessage"));
    // Claude's box holds the paste, as it does for any message between its paste and its Enter
    const rule = "\u2500".repeat(60);
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f samemessage\n${rule}\n  [Haiku 4.5] \u2502 project\n`, "[Haiku 4.5] \u2502 project");
    await f.removed(second.id);
    await f.waitBytes(`${paste("samemessage")}\r`);
  }, 30_000);

  it("reads the pane's live screen: a menu drawn below a scrolled viewport still stops Send now", async () => {
    const f = await setup("scrolled", "codex"); const message = await f.queue(1, "after the menu");
    const history = Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join("\n");
    await f.showScreen(`${history}\n${approval}`, approval);
    const { pane: { scroll } } = await herdrRpc<{ pane: { scroll: { offset_from_bottom: number; viewport_rows: number } } }>("pane.scroll", { pane_id: f.pane, offset_from_bottom: 60 });
    expect(scroll.offset_from_bottom).toBeGreaterThanOrEqual(scroll.viewport_rows);
    expect((await paneRead({ paneId: f.pane, source: "visible", format: "text" })).text).not.toContain("Would you like");
    f.socket.send({ type: "pending-action", id: 2, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("leaves a model list no reader could read alone, where Enter would save a default", async () => {
    const f = await setup("model-list"); const message = await f.queue(1, "after the list");
    // a name the pane cut in two: no card is read from it, and herdr does not report the pane blocked
    const list = ["❯ /model", "", "  Select model", "  Switch between Claude models. Your pick becomes the default for new sessions.", "",
      "    1.  Default (recommended)  Opus 5.5 with 1M context", "  ❯ 2.  Opus", "        4.7                    Best for everyday, complex tasks", "",
      "  ◐ Medium effort (default) ←/→ to adjust", "", "  Enter to set as default · s to use this session only · Esc to cancel", ""].join("\n");
    expect(parseInteractivePrompt("claude", list)).toBeNull();
    await f.showScreen(list);
    f.socket.send({ type: "pending-action", id: 2, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    // a narrow pane wraps the hint, and Claude draws the session's rule under the open list
    await f.showScreen(list.replace("  Enter to set as default · s to use this session only · Esc to cancel\n", "  Enter to set as default · s to use this session only · Esc to\n  cancel\n──────────── Session name ─\n"));
    f.socket.send({ type: "pending-action", id: 3, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(3)).toMatchObject({ ok: false, code: "agent_blocked" });
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("does not take a model list's hint above later output for an open list", async () => {
    const f = await setup("stale-list"); const message = await f.queue(1, "after the old list");
    await f.showScreen("  Enter to set as default · s to use this session only · Esc to cancel\nSome later output\n› Message\n");
    f.socket.send({ type: "pending-action", id: 2, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(2)).toMatchObject({ ok: true });
    await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("after the old list")}\r`);
  }, 30_000);

  it("supports pending input on a mirrored attachment without a PTY sidecar", async () => {
    const f = await setup("mirror", "claude", "› Message\n", { terminalAttach: false });
    const message = await f.queue(1, "mirror 한글\nnext"); expect(f.bytes()).toBe("");
    // A mirror can connect before the collector's initial subscription. Its ready
    // baseline still advances the queue, without requiring an event the startup gap missed.
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "claude", state: "idle" });
    await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste(message.text)}\r`);
  }, 30_000);

  it("rejects unattached owners and paste-control injection without accepting input", async () => {
    const f = await setup("input-guard"); const other = await f.another(false);
    other.send({ type: "submit", id: 1, pane_id: f.pane, text: "not attached", payload: "not attached", delivery: "queue" });
    expect(await other.result(1)).toMatchObject({ ok: false, code: "input_not_ready" });
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "escape\u001b[201~\r", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "invalid_submit_text" });
    expect(f.bytes()).toBe(""); expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
  }, 30_000);

  it("checks a new blocked state after the Stop key's settling gap, before pasting", async () => {
    const f = await setup("stop-gap"); const message = await f.queue(1, "must not paste");
    f.socket.send({ type: "input", pane_id: f.pane, text: "\u001b" });
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "sending"));
    await f.state("blocked");
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "agent_blocked" });
    await f.waitBytes("\u001b"); expect(f.bytes()).toBe("\u001b");
  }, 30_000);

  it("does not turn an automatic next turn into a steer if new work begins after paste", async () => {
    const f = await setup("new-work-gap", "claude", "› Message\n", { submitDelayMs: 750 }); const message = await f.queue(1, "must not steer");
    await f.state("idle"); await f.waitBytes("\u001b[201~"); await f.state("working");
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "uncertain"));
    expect(f.bytes()).toBe(paste("must not steer"));
  }, 30_000);

  it("holds rather than flushing when a newly sent turn never starts", async () => {
    const f = await setup("timeout", "claude", "› Message\n", { pendingStartTimeoutMs: 150 });
    const first = await f.queue(1, "first"); const second = await f.queue(2, "held second");
    await f.state("idle"); await f.removed(first.id);
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === second.id && item.state === "held" && item.error?.code === "pending_turn_unconfirmed"));
    expect(f.bytes()).toBe(`${paste("first")}\r`);
  }, 30_000);

  it("rejects ordinary queue input and Send now at a visible password prompt despite a working state", async () => {
    const f = await setup("password-before-input"); const message = await f.queue(1, "ordinary message");
    await f.showScreen("Password:");
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "claude", state: "working" });
    expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === f.pane)?.agent_status).toBe("working");
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "another ordinary message", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "agent_blocked" });
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("cancels Enter when a passphrase prompt appears after the pending message was pasted", async () => {
    const f = await setup("passphrase-gap", "claude", "› Message\n", { submitDelayMs: 750 });
    const message = await f.queue(1, "ordinary message");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.waitBytes("\u001b[201~"); await f.showScreen("Enter passphrase:");
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "claude", state: "working" });
    expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === f.pane)?.agent_status).toBe("working");
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "submit_changed" });
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "uncertain"));
    expect(f.bytes()).toBe(paste("ordinary message"));
  }, 30_000);

  for (const automatic of [false, true]) for (const transition of ["observe", "detach"] as const) {
    it(`permanently cancels ${automatic ? "automatic" : "explicit"} delivery after ${transition} and recovery`, async () => {
      const f = await setup(`cancel-${automatic}-${transition}`, "claude", "› Message\n", { submitDelayMs: 750 });
      await f.another(); // Keep the same shared attachment alive through detach/reattach.
      const message = await f.queue(1, "cancel this commit");
      if (automatic) await f.state("idle");
      else f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
      await f.waitBytes("\u001b[201~");
      const from = f.socket.seen.length;
      if (transition === "observe") {
        f.socket.send({ type: "role", mode: "observe" });
        await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe", from);
        f.socket.send({ type: "role", mode: "interact" });
        await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact", from);
      } else {
        f.socket.send({ type: "detach", pane_id: f.pane });
        f.socket.send({ type: "attach", pane_id: f.pane, cols: 100, rows: 30 });
        await f.socket.wait((frame) => frame.type === "input-ready" && frame.pane_id === f.pane && frame.ready !== false, from);
      }
      if (!automatic) expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "submit_changed" });
      // A later serialized request proves the cancelled dispatch has finished, not
      // merely that hold() published an uncertain state during the paste gap.
      f.socket.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
      expect(await f.socket.result(20)).toMatchObject({ ok: true });
      await f.waitBytes("barrier\r");
      expect(f.bytes()).toBe(`${paste(message.text)}barrier\r`);
      expect(f.socket.seen.some((frame) => frame.type === "pending-messages" && frame.removed?.some((item: any) => item.id === message.id && item.outcome === "sent"))).toBe(false);
      expect(f.socket.seen.filter((frame) => frame.type === "pending-messages").at(-1)?.messages).toContainEqual(expect.objectContaining({ id: message.id, state: "uncertain" }));
    }, 30_000);
  }

  it("cancels a captured lease while acceptance waits behind earlier input", async () => {
    const f = await setup("acceptance-lease", "claude", "› Message\n", { submitDelayMs: 750 });
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    await f.waitBytes("barrier");
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "must not enqueue", payload: "unused", delivery: "queue" });
    f.socket.send({ type: "role", mode: "observe" });
    await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe");
    f.socket.send({ type: "role", mode: "interact" });
    await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact");
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "pending_lease_lost" });
    expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
    expect(f.bytes()).toBe("barrier\r");
  }, 30_000);

  it("cancels ready-at-arrival queue input when its owner disconnects after paste", async () => {
    const f = await setup("ready-close", "claude", "› Message\n", { submitDelayMs: 750 });
    const keeper = await f.another();
    await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "ready close", payload: "unused", delivery: "queue" });
    await f.waitBytes("\u001b[201~");
    await f.socket.disconnect();
    keeper.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await keeper.result(20)).toMatchObject({ ok: true });
    await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe(`${paste("ready close")}barrier\r`);
  }, 30_000);

  it("rechecks a new secret prompt before committing ready-at-arrival queue input", async () => {
    const f = await setup("ready-secret", "claude", "› Message\n", { submitDelayMs: 750 });
    await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "ordinary text", payload: "unused", delivery: "queue" });
    await f.waitBytes("\u001b[201~");
    await f.showScreen("Enter passphrase:");
    expect(await f.socket.result(1)).toMatchObject({ ok: false, code: "submit_changed" });
    expect(f.bytes()).toBe(paste("ordinary text"));
  }, 30_000);
});
