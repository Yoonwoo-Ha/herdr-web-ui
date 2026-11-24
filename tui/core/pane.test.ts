import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA } from "../../server/herdr-core/connection.ts";
import { CREDIT_WINDOW, type FakeCoreOptions, FakeHcCore, FEATURES_0_1_17 } from "../../server/herdr-core/core.fake.ts";
import { createEmulator } from "../emulator/ghostty.ts";
import { PAINT_QUIET_MS, PANE_REOPEN_LIMIT, REATTACH_SETTLE_MS } from "../model/deadlines.ts";
import { PASS_BUDGET, picture, type Screen, Stage } from "../testing/pane-harness.ts";
import type { InputResult } from "./pane.ts";

// The pane attach machine on the fake core, with the real link and real emulators. The first block
// holds the twelve pane cases of the design (UB Q2) and the drain rule; the second what a hostile
// stream, a stale answer or a broken emulator must not be able to do.

const stages: Stage[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const stage of stages.splice(0)) await stage.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A fake core with `terminals` shells, and one screen on it whose focus is on the first. */
async function scene(options: FakeCoreOptions & { terminals?: number } = {}) {
  const core = new FakeHcCore(options);
  const stage = new Stage(core);
  stages.push(stage);
  const terminals = Array.from({ length: options.terminals ?? 1 }, () => core.spawn().address);
  const screen = await stage.screen();
  screen.panes.focus(terminals[0]!);
  return { core, stage, screen, t: terminals[0]!, terminals };
}

const OLD = { version: "0.1.17", features: FEATURES_0_1_17 } as const;
const sentOf = (results: InputResult[]) => results.map((result) => result.sent);
const noticesOf = (results: InputResult[]) => results.filter((result) => !result.sent && result.notice).length;
const attachesOf = (core: FakeHcCore, terminal: string) => core.calls().filter((call) => call.method === "terminal.attach" && call.params["terminal"] === terminal).map((call) => call.params);
const dataBytes = (core: FakeHcCore, terminal: string) => core.log.reduce((sum, entry) => sum + (entry.what === "frame" && entry.from === "core" && entry.kind === FRAME_DATA && entry.terminal === terminal ? entry.payload.length : 0), 0);
/** moves the clock to the link's next retry and lets the new line come up */
async function reconnect(stage: Stage, screen: Screen): Promise<void> {
  const state = screen.link.state;
  if (state.kind !== "Offline" || state.retryAt === null) throw new Error(`the link is ${state.kind}, not waiting to retry`);
  await stage.advance(state.retryAt - stage.clock.now);
}
function modes(screen: Screen, terminal: string) {
  const read = screen.view(terminal).emulator!.modes();
  if (!read.ok) throw new Error(read.error.kind);
  return read.value;
}

describe("the pane attach machine", () => {
  it("attach params", async () => {
    const { core, stage, screen, terminals: [a, b] } = await scene({ terminals: 2 });
    await stage.live(screen, [a!, 80, 24], [b!, 100, 30]);
    // a host resize: one new attach that carries the new rectangle
    screen.show([a!, 90, 28], [b!, 100, 30]);
    await stage.advance(REATTACH_SETTLE_MS);
    // another viewer's resize: one new attach that advertises the terminal's own size, a repaint
    const rival = stage.rival();
    await rival.attach(b!, 120, 40);
    await stage.settle();
    await stage.advance(REATTACH_SETTLE_MS);
    expect(attachesOf(core, a!)).toEqual([
      { terminal: a, cols: 80, rows: 24, history: 2000, resumed: true },
      { terminal: a, cols: 90, rows: 28, history: 2000, resumed: true },
    ]);
    expect(attachesOf(core, b!).filter((params) => params["resumed"] === true)).toEqual([
      { terminal: b, cols: 100, rows: 30, history: 2000, resumed: true },
      { terminal: b, cols: 120, rows: 40, history: 2000, resumed: true },
    ]);
  });

  it("paint by position", async () => {
    const { core, stage, screen, terminals: [t, cut] } = await scene({ terminals: 2 });
    // a paint longer than the credit window: its mark comes only after the pane credited the first part
    core.setPaint(t!, { body: "x".repeat(CREDIT_WINDOW + 5000), after: "$ " });
    screen.show([t!, 80, 24]);
    await stage.settle();
    expect([screen.state(t!), screen.view(t!).ready]).toEqual(["Painting", false]);
    expect(screen.type("a")).toEqual([{ sent: false, code: "painting", notice: true }]);
    await stage.pass();
    // the mark came, inside a frame that also holds the shell's prompt: complete, and live only after the frame that draws it
    expect([screen.state(t!), screen.view(t!).ready]).toEqual(["Painting", true]);
    expect(screen.type("b")).toEqual([{ sent: false, code: "painting", notice: false }]);
    await stage.pass();
    expect(screen.state(t!)).toBe("Live");
    expect(screen.type("c")).toEqual([{ sent: true }]);
    expect(screen.sent(t!)).toEqual(["DATA 63"]);

    // the mark cut by a frame boundary: CAN, the body and `CSI 0m` fill a 16 KiB frame up to the mark's third byte
    core.setPaint(cut!, { body: "y".repeat(16 * 1024 - 1 - 4 - 3) });
    screen.show([t!, 80, 24], [cut!, 80, 24]);
    await stage.settle();
    expect(core.dataTo(cut!).map((frame) => frame.slice(-3))).toEqual(["\x1b[?", "01l"]);
    expect([screen.state(cut!), screen.view(cut!).ready]).toEqual(["Painting", true]);
  });

  it("paint quiet fallback", async () => {
    const { stage, screen, t } = await scene();
    screen.faults.stripMark = true;
    screen.show([t, 80, 24]);
    await stage.settle();
    // bytes still owed to the core: however long the stream stays quiet, the paint is not complete
    await stage.advance(PAINT_QUIET_MS * 5);
    expect([screen.state(t), screen.view(t).ready, screen.panes.deadlines().has("paint")]).toEqual(["Painting", false, false]);
    await stage.pass();
    await stage.advance(PAINT_QUIET_MS - 1);
    expect([screen.state(t), screen.view(t).ready]).toEqual(["Painting", false]);
    expect(screen.panes.deadlines().get("paint")).toBe(stage.clock.now + 1);
    await stage.advance(1);
    expect([screen.state(t), screen.view(t).ready]).toEqual(["Painting", true]);
    await stage.pass();
    expect(screen.state(t)).toBe("Live");
    expect(screen.type("a")).toEqual([{ sent: true }]);
  });

  it("read before live, handled after", async () => {
    const { stage, screen, t } = await scene();
    screen.show([t, 80, 24]);
    await stage.settle();
    // an ESC read while the pane still paints, held for its wait and handed over once the pane is live
    const read = screen.stamp();
    await stage.advance(1);
    await stage.pass();
    expect(screen.state(t)).toBe("Live");
    expect(screen.key("ESCAPE", {}, read)).toEqual({ sent: false, code: "early", notice: true });
    expect(screen.type("a", read)).toEqual([{ sent: false, code: "early", notice: false }]);
    expect(screen.sent(t)).toEqual([]);
    expect(screen.type("b")).toEqual([{ sent: true }]);
    expect(screen.sent(t)).toEqual(["DATA 62"]);
  });

  it("failed open then retry", async () => {
    const { core, stage, screen, t } = await scene();
    screen.faults.attach = { reject: "unavailable" };
    screen.show([t, 80, 24]);
    expect(screen.state(t)).toBe("Opening");
    expect(screen.type("a")).toEqual([{ sent: false, code: "opening", notice: true }]);
    await stage.settle();
    expect(screen.state(t)).toBe("Waiting(lost)");
    expect(screen.type("b")).toEqual([{ sent: false, code: "lost", notice: true }]);
    core.lose(t);
    core.restartTerminal(t);
    await stage.settle();
    await stage.pass();
    expect(screen.state(t)).toBe("Live");
    // nothing typed before the failed open was sent by the retry
    expect(screen.sent(t)).toEqual([]);
    expect(core.program(t).receivedHex()).toBe("");
    expect(screen.type("c")).toEqual([{ sent: true }]);
    expect(core.program(t).receivedHex()).toBe("63");
  });

  it("down means refused", async () => {
    // through the real socket transport: an EOF as the screen meets it
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "ovis-pn-"));
    folders.push(folder);
    const core = new FakeHcCore();
    const stage = new Stage(core);
    stages.push(stage);
    const t = core.spawn().address;
    const server = await core.listen(join(folder, "c.sock"));
    try {
      const screen = await stage.screen({ socket: join(folder, "c.sock") });
      screen.panes.focus(t);
      await stage.live(screen, [t, 80, 24]);
      // the program asks for the mouse, so a click would be bytes for it
      core.program(t).output("\x1b[?1000h\x1b[?1006h");
      await stage.settle();
      core.restart();
      await stage.settle();
      expect([screen.link.state.kind, screen.state(t)]).toEqual(["Offline", "Waiting(offline)"]);
      const refused = [...screen.type("ls"), screen.key("ENTER"), screen.paste("rm -rf scratch\n"), screen.mouse("press", 3, 3)];
      expect([sentOf(refused), refused.map((result) => !result.sent && result.code), noticesOf(refused)]).toEqual([[false, false, false, false, false], Array(5).fill("offline"), 1]);
      await reconnect(stage, screen);
      expect(screen.link.state).toEqual({ kind: "Online", epoch: 2 });
      await stage.pass();
      expect(screen.state(t)).toBe("Live");
      // zero DATA frames on any channel of any line, and the program read nothing
      expect(core.sentOn(t, { kinds: [FRAME_DATA] })).toEqual([]);
      expect(core.program(t).receivedHex()).toBe("");
      expect(screen.type("k")).toEqual([{ sent: true }]);
      await stage.settle();
      expect(core.sentOn(t, { kinds: [FRAME_DATA] })).toEqual(["DATA 6b"]);
    } finally {
      await server.close();
    }

    // the core is stopped, and another core comes up where it was: its terminals are not this pane's
    const old = await scene();
    await old.stage.live(old.screen, [old.t, 80, 24]);
    old.core.stop();
    await old.stage.settle();
    expect([old.screen.link.state.kind, old.screen.state(old.t)]).toEqual(["Offline", "Waiting(offline)"]);
    expect(sentOf([...old.screen.type("make deploy"), old.screen.key("ENTER")])).toEqual(Array(12).fill(false));
    const next = new FakeHcCore();
    const reused = next.spawn().address;
    old.stage.core = next;
    await reconnect(old.stage, old.screen);
    await old.stage.pass();
    expect(reused).toBe(old.t);
    expect(old.screen.link.state).toEqual({ kind: "Online", epoch: 2 });
    expect(old.screen.state(old.t)).toBe("Live");
    expect([old.core.program(old.t).receivedHex(), next.program(reused).receivedHex(), next.sentOn(reused)]).toEqual(["", "", []]);
  });

  it("stale generation", async () => {
    const { stage, screen, t } = await scene();
    screen.faults.holdReplies = true;
    screen.show([t, 80, 24]);
    await stage.settle();
    // the core answered and its first paint is on the stream; the reply has not reached the pane
    expect([screen.state(t), screen.attaches[0]!.receivedBytes > 0]).toEqual(["Opening", true]);
    screen.show();
    screen.show([t, 80, 24]);
    expect([screen.state(t), screen.attaches.length]).toEqual(["Closing", 1]);
    screen.release();
    await stage.settle();
    await stage.pass();
    expect(screen.state(t)).toBe("Live");
    const [first, second] = screen.attaches;
    // the late reply's channel was closed, and that is all that was done with it
    expect(screen.calls.filter((call) => call.attach === first).map((call) => call.text)).toEqual(["CLOSE"]);
    // none of its bytes reached an emulator: the one made for it was dropped unwritten
    expect(screen.emulators.map((record) => [record.writtenBytes > 0, record.disposed])).toEqual([[false, true], [true, false]]);
    expect(Buffer.concat(screen.emulators[1]!.written).equals(Buffer.concat(second!.received))).toBe(true);
  });

  it("close before attach", async () => {
    const { stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const heardWhenAsked: boolean[] = [];
    // whether the pane had been told of the end of the attach before, at the moment it asked for the next
    screen.hooks.attach = () => heardWhenAsked.push(screen.attaches.at(-2)!.closeHeard);
    screen.show();
    screen.show([t, 80, 24]);
    // our CLOSE is out and the core's has not been heard: no attach leaves
    expect([screen.state(t), screen.attaches.length]).toEqual(["Closing", 1]);
    await stage.settle();
    expect(heardWhenAsked).toEqual([true]);
    expect(screen.did(t)).toEqual(["CLOSE"]);
    await stage.pass();
    expect(screen.state(t)).toBe("Live");

    // the same on every way to a new attach, however late the core's CLOSE comes: here after a host resize, and after a hide and show
    screen.faults.holdCloses = true;
    screen.show([t, 90, 28]);
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.advance(10_000);
    expect([screen.state(t), screen.attaches.length]).toEqual(["Closing", 2]);
    screen.release();
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), screen.attaches.length, screen.asked(t).at(-1)]).toEqual(["Live", 3, { terminal: t, cols: 90, rows: 28, history: 2000, resumed: true }]);
    screen.faults.holdCloses = true;
    screen.show();
    screen.show([t, 90, 28]);
    await stage.advance(10_000);
    expect([screen.state(t), screen.attaches.length]).toEqual(["Closing", 3]);
    screen.release();
    await stage.settle();
    expect(screen.attaches.length).toBe(4);
    expect(heardWhenAsked).toEqual([true, true, true]);
  });

  it("credit", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    core.program(t).output("a line of output\r\n".repeat(70_000));
    await stage.settle();
    const within: boolean[] = [];
    for (let before = -1; before !== core.credited(t);) {
      before = core.credited(t);
      await stage.pass({ budget: 100_000 });
      within.push(core.credited(t) <= dataBytes(core, t) && screen.view(t).owed === screen.attaches[0]!.receivedBytes - core.credited(t));
    }
    // drained: every byte the core sent was credited back, and never more than it had sent
    expect(dataBytes(core, t)).toBeGreaterThan(1_190_000);
    expect([core.credited(t), screen.view(t).owed]).toEqual([dataBytes(core, t), 0]);
    expect(within.length).toBeGreaterThan(5);
    expect(within.every(Boolean)).toBe(true);
    // nothing is credited after our CLOSE
    core.program(t).output("z".repeat(50_000));
    await stage.settle();
    expect(screen.view(t).owed).toBe(50_000);
    // while the core's answer to it is still out, a frame pass asks the closed channel for nothing (the connection would drop it before the wire)
    screen.faults.holdCloses = true;
    screen.show();
    expect(screen.panes.credit(t, PASS_BUDGET)).toBe(0);
    await stage.pass();
    expect(screen.calls.slice(screen.calls.findIndex((call) => call.op === "close")).map((call) => call.text)).toEqual(["CLOSE"]);
    screen.release();
    await stage.settle();
    const frames = core.log.flatMap((entry) => entry.what === "frame" && entry.from === "viewer" ? [entry] : []);
    const closed = frames.findIndex((entry) => entry.kind === FRAME_CLOSE && entry.terminal === t);
    expect(closed).toBeGreaterThan(-1);
    // on the attach's own channel (the link's event stream credits itself)
    expect(frames.slice(closed + 1).filter((entry) => entry.channel === frames[closed]!.channel && entry.kind === FRAME_CREDIT)).toEqual([]);
    expect(core.credited(t)).toBeLessThan(dataBytes(core, t));
  });

  it("replies", async () => {
    // a query (DSR 5) the pane's emulator answers: inside the first paint, then from the live program
    const confirmed = await scene();
    confirmed.core.setPaint(confirmed.t, { body: "\x1b[5n" });
    confirmed.screen.show([confirmed.t, 80, 24]);
    await confirmed.stage.settle();
    expect(confirmed.screen.emulators[0]!.replies.map((reply) => Buffer.from(reply).toString("latin1"))).toEqual(["\x1b[0n"]);
    await confirmed.stage.pass();
    expect([confirmed.screen.state(confirmed.t), confirmed.screen.sent(confirmed.t)]).toEqual(["Live", []]);
    confirmed.core.program(confirmed.t).output("\x1b[5n");
    await confirmed.stage.settle();
    expect(confirmed.screen.sent(confirmed.t)).toEqual(["AUTOMATIC_INPUT 1b5b306e"]);

    // a core without automatic input: a reply is DATA, which is typing to the core, so only the pane the user drives sends it
    const { core, stage, screen, terminals: [driven, other] } = await scene({ ...OLD, terminals: 2 });
    await stage.live(screen, [driven!, 80, 24], [other!, 80, 24]);
    core.program(driven!).output("\x1b[5n");
    core.program(other!).output("\x1b[5n");
    await stage.settle();
    expect([screen.sent(driven!), screen.sent(other!)]).toEqual([[], []]);
    screen.type("x");
    core.program(driven!).output("\x1b[5n");
    core.program(other!).output("\x1b[5n");
    await stage.settle();
    expect([screen.sent(driven!), screen.sent(other!)]).toEqual([["FOCUS 1", "DATA 78", "DATA 1b5b306e"], []]);
  });

  it("lost then restarted", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    core.program(t).output("\x1b[?2004h");
    await stage.settle();
    expect(modes(screen, t).bracketedPaste).toBe(true);
    // the event alone: the core has not closed the stream yet
    core.emit("lost", t, { exit_code: null, finished_ms: null, reason: "signaled", signal: 9 });
    await stage.settle();
    expect([screen.state(t), screen.attaches[0]!.closeHeard]).toEqual(["Waiting(lost)", false]);
    expect(screen.type("a")).toEqual([{ sent: false, code: "lost", notice: true }]);
    core.lose(t);
    await stage.settle();
    expect([screen.state(t), screen.attaches.length, screen.attaches[0]!.closeHeard]).toEqual(["Waiting(lost)", 1, true]);
    // Resyncing the documents and the terminal snapshot cannot reopen a still-lost shell.
    const docs = core.calls().filter(({ method }) => method === "doc.get").length;
    core.missed();
    await stage.settle();
    expect(core.calls().filter(({ method }) => method === "doc.get").slice(docs).map(({ params }) => params["name"]))
      .toEqual(["herdr-app", "ovis-layout"]);
    expect([screen.state(t), screen.attaches.length]).toEqual(["Waiting(lost)", 1]);
    expect(screen.type("b")).toMatchObject([{ sent: false, code: "lost" }]);
    core.restartTerminal(t);
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), screen.attaches.length]).toEqual(["Live", 2]);
    // the new shell's pane starts from a new emulator: the old program's mode is gone
    expect(modes(screen, t).bracketedPaste).toBe(false);
    expect([screen.emulators.length, screen.emulators[0]!.disposed]).toEqual([2, true]);
    expect(screen.sent(t)).toEqual([]);
  });

  it("finished drains", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    core.emit("finished", t, { exit_code: 3, finished_ms: 1, reason: "exited", signal: null });
    await stage.settle();
    expect(screen.state(t)).toBe("Ended(exited 3)");
    expect(screen.type("a")).toEqual([{ sent: false, code: "ended", notice: true }]);
    // what the program still had to say is drawn, however much it is
    core.program(t).output(`${"more\r\n".repeat(60_000)}last words`);
    await stage.settle();
    for (let before = -1; before !== core.credited(t);) {
      before = core.credited(t);
      await stage.pass();
    }
    expect(picture(screen.view(t).emulator!).join("\n")).toContain("last words");
    expect(core.credited(t)).toBe(dataBytes(core, t));
    core.program(t).exit(3);
    await stage.settle();
    expect([screen.state(t), screen.attaches[0]!.closeHeard, screen.did(t)]).toEqual(["Ended(exited 3)", true, []]);
    expect(picture(screen.view(t).emulator!).join("\n")).toContain("last words");
  });

  it("typed before live, read after", async () => {
    const { stage, screen, t } = await scene();
    screen.show([t, 80, 24]);
    await stage.settle();
    expect([screen.state(t), screen.view(t).ready]).toEqual(["Painting", true]);
    // typed before the paint and still unread in stdin: the loop reads it at the moment the pane goes live
    let read = 0;
    const drained: InputResult[] = [];
    screen.pass({ drain: () => { read = screen.stamp(); drained.push(...screen.type("ls", read), screen.key("ENTER", {}, read)); } });
    expect([screen.state(t), sentOf(drained), noticesOf(drained)]).toEqual(["Live", [false, false, false], 1]);
    // what that same read held and the framer hands over later is refused as well
    expect(screen.key("ESCAPE", {}, read)).toMatchObject({ sent: false, code: "early" });
    expect(screen.sent(t)).toEqual([]);
    expect(screen.type("x")).toEqual([{ sent: true }]);
    expect(screen.sent(t)).toEqual(["DATA 78"]);
  });
});

describe("the pane attach machine under hostile conditions", () => {
  it("every other answer to an attach is a state with a code", async () => {
    const { stage, screen, terminals } = await scene({ terminals: 5 });
    const shown: [string, number, number][] = [];
    const states: string[] = [];
    for (const [at, kind] of ["finished", "timeout", "closed", "blocked", "not_found"].entries()) {
      screen.faults.attach = { reject: kind };
      shown.push([terminals[at]!, 80, 24]);
      screen.show(...shown);
      await stage.settle();
      states.push(screen.state(terminals[at]!));
    }
    expect(states).toEqual(["Ended(finished null)", "Waiting(offline)", "Waiting(offline)", "Failed(attach)", "gone"]);
    expect(screen.notices.filter((notice) => notice.type === "gone").map((notice) => notice.terminal)).toEqual([terminals[4]!]);
    expect(screen.calls).toEqual([]);
    // the retry key: a pane that failed or waits attaches again only when asked
    for (const terminal of terminals.slice(1, 4)) screen.panes.retry(terminal);
    await stage.settle();
    await stage.pass();
    expect(terminals.slice(0, 4).map((terminal) => screen.state(terminal))).toEqual(["Ended(finished null)", "Live", "Live", "Live"]);
  });

  it("the snapshot of a new line decides what a waiting pane is", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 4 });
    const [finished, missing, slow, broken] = terminals as [string, string, string, string];
    // the line ends while the panes are live; while it is down one program ends, one terminal goes, one loses its shell
    await stage.live(screen, [finished, 80, 24], [missing, 80, 24], [slow, 80, 24], [broken, 80, 24]);
    core.restart();
    await stage.settle();
    expect([finished, missing, slow, broken].map((terminal) => screen.state(terminal))).toEqual(Array(4).fill("Waiting(offline)"));
    core.program(finished).exit(7);
    core.remove(missing);
    core.lose(slow);
    await reconnect(stage, screen);
    await stage.pass();
    expect([finished, missing, slow, broken].map((terminal) => screen.state(terminal))).toEqual(["Ended(exited 7)", "gone", "Waiting(lost)", "Live"]);
    expect(screen.attaches.filter((record) => record.terminal === broken).length).toBe(2);
  });

  it("an attach answer of the wrong shape fails the pane and closes the channel it came with", async () => {
    const { stage, screen, t } = await scene();
    screen.faults.attach = { reply: () => ({ channel: 1, terminal: { cols: "wide", rows: 24 } }) };
    screen.show([t, 80, 24]);
    await stage.settle();
    expect([screen.state(t), screen.did(t), screen.emulators[0]!.writtenBytes, screen.emulators[0]!.disposed]).toEqual(["Failed(bad_reply)", ["CLOSE"], 0, true]);
    screen.panes.retry(t);
    await stage.settle();
    await stage.pass();
    expect(screen.state(t)).toBe("Live");
  });

  it("a stream cut inside a character or a sequence, a megabyte in one frame and a megabyte pasted", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const text = Buffer.from("\x1b[31mred \x1b[0m한글 and \x1b]0;a title\x07done\r\n");
    // every cut of the same bytes draws the same picture as the bytes in one piece
    const whole = await createEmulator({ cols: 80, rows: 24, events: {} });
    if (!whole.ok) throw new Error(whole.error.kind);
    whole.value.write(Buffer.concat(screen.emulators[0]!.written));
    for (let cut = 1; cut < text.length; cut++) {
      core.program(t).output(text.subarray(0, cut));
      core.program(t).output(text.subarray(cut));
      whole.value.write(text);
    }
    await stage.pass();
    expect(picture(screen.view(t).emulator!)).toEqual(picture(whole.value));
    whole.value.dispose();

    // a megabyte in one frame (the core cuts at 16 KiB; the protocol allows it): consumed, then credited over the passes
    const owed = screen.view(t).owed;
    screen.attaches[0]!.handlers.onData(new Uint8Array(1024 * 1024).fill(0x61));
    expect(screen.view(t).owed).toBe(owed + 1024 * 1024);
    screen.pass();
    expect(screen.view(t).owed).toBe(owed + 1024 * 1024 - 512 * 1024);
    // a megabyte pasted: one frame, at once, and the program reads all of it once
    expect(screen.paste("p".repeat(1024 * 1024))).toEqual({ sent: true });
    expect(core.program(t).receivedHex().length).toBe(2 * 1024 * 1024);
    // a paste the input layer cut at its limit is refused whole
    expect(screen.paste("cut", { complete: false })).toEqual({ sent: false, code: "paste_cut", notice: true });
    expect(screen.sent(t).length).toBe(1);
  });

  it("an old line's channel, an old reply and a dead emulator's answer change nothing", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const old = screen.attaches[0]!;
    const dead = screen.emulators[0]!;
    core.restart();
    await stage.settle();
    await reconnect(stage, screen);
    await stage.pass();
    expect([screen.state(t), screen.view(t).gen]).toEqual(["Live", 2]);
    const before = { written: screen.emulators[1]!.writtenBytes, notices: screen.notices.length, calls: screen.calls.length };
    // the old epoch's channel delivers after the reconnect
    old.handlers.onData(Buffer.from("stale bytes \x1b[5n"));
    old.handlers.onClose({ reason: "connection_lost" });
    old.handlers.onClose({ exit_code: 0, finished_ms: 1, reason: "exited", signal: null });
    // the emulator of the old generation answers a query after it was dropped
    dead.events.onReply?.(Buffer.from("\x1b[0n"));
    await stage.settle();
    expect([screen.state(t), dead.disposed, dead.writtenBytes === Buffer.concat(old.received).length]).toEqual(["Live", true, true]);
    expect({ written: screen.emulators[1]!.writtenBytes, notices: screen.notices.length, calls: screen.calls.length }).toEqual(before);
  });

  it("a line lost at every step of an attach, twice in a row", async () => {
    type Step = "opening" | "painting" | "painted" | "live";
    for (const step of ["opening", "painting", "painted", "live"] as Step[]) {
      const { core, stage, screen, t } = await scene();
      core.setPaint(t, { body: "x".repeat(step === "painting" ? CREDIT_WINDOW + 100 : 10) });
      const reach = async () => {
        screen.faults.holdReplies = step === "opening";
        screen.show([t, 80, 24]);
        await stage.settle();
        if (step === "live") await stage.pass();
        expect(screen.state(t)).toBe(step === "opening" ? "Opening" : step === "live" ? "Live" : "Painting");
        expect(screen.view(t).ready).toBe(step === "painted");
      };
      for (let round = 0; round < 2; round++) {
        await reach();
        core.restart();
        screen.release();
        await stage.settle();
        expect([step, round, screen.state(t)]).toEqual([step, round, "Waiting(offline)"]);
        expect(screen.type("typed while down")[0]).toMatchObject({ sent: false, code: "offline" });
        screen.faults.holdReplies = step === "opening";
        await reconnect(stage, screen);
      }
      screen.release();
      await stage.settle();
      await stage.pass();
      await stage.pass();
      expect([step, screen.state(t), screen.view(t).gen]).toEqual([step, "Live", 3]);
      // nothing but credit was ever sent on a stream; a reply that came back after its line ended had its channel closed
      expect([step, screen.calls.filter((call) => call.op !== "credit").map((call) => call.text)]).toEqual([step, step === "opening" ? ["CLOSE", "CLOSE"] : []]);
      expect(screen.emulators.map((record) => record.disposed)).toEqual([true, true, false]);
      expect(core.program(t).receivedHex()).toBe("");
    }
  });

  it("leaving and coming back in the middle of a replay, and a terminal removed in the middle of an attach", async () => {
    const { core, stage, screen, terminals: [t, removed] } = await scene({ terminals: 2 });
    core.setPaint(t!, { body: "x".repeat(CREDIT_WINDOW + 100) });
    screen.show([t!, 80, 24]);
    await stage.settle();
    expect([screen.state(t!), screen.view(t!).ready]).toEqual(["Painting", false]);
    // the user leaves the tab and returns before the paint is through
    screen.show();
    screen.show([t!, 80, 24]);
    await stage.settle();
    await stage.pass();
    await stage.pass();
    expect([screen.state(t!), screen.attaches.length, screen.did(t!)]).toEqual(["Live", 2, ["CLOSE"]]);
    expect(screen.emulators.map((record) => record.disposed)).toEqual([true, false]);
    expect(Buffer.concat(screen.emulators[1]!.written).equals(Buffer.concat(screen.attaches[1]!.received))).toBe(true);

    screen.faults.holdReplies = true;
    screen.show([t!, 80, 24], [removed!, 80, 24]);
    await stage.settle();
    core.remove(removed!);
    await stage.settle();
    expect(screen.state(removed!)).toBe("gone");
    screen.release();
    await stage.settle();
    expect([screen.state(removed!), screen.did(removed!), screen.emulators[2]!.disposed, screen.emulators[2]!.writtenBytes]).toEqual(["gone", ["CLOSE"], true, 0]);
  });

  it("a pane hidden from inside its own draw, and a set closed from inside a notice", async () => {
    const { core, stage, screen, terminals: [a, b] } = await scene({ terminals: 2 });
    await stage.live(screen, [a!, 80, 24], [b!, 80, 24]);
    core.program(a!).output("draw me\r\n");
    await stage.settle();
    let drawn = 0;
    const framed = screen.view(a!).emulator!.frame(() => { if (drawn++ === 0) screen.show([b!, 80, 24]); });
    expect([framed.ok, drawn > 0, screen.state(a!)]).toEqual([true, true, "Closing"]);
    await stage.settle();
    expect([screen.state(a!), screen.emulators[0]!.disposed, screen.did(a!)]).toEqual(["gone", true, ["CLOSE"]]);
    // the owner closes everything when it hears of new output
    let closing: Promise<void> | null = null;
    screen.hooks.notice = (notice) => { if (notice.type === "output") closing ??= screen.panes.close(); };
    core.program(b!).output("the last output\r\n");
    await stage.settle();
    await closing;
    expect([screen.panes.views(), screen.did(b!), screen.emulators[1]!.disposed]).toEqual([[], ["CLOSE"], true]);
    expect(screen.emulators.flatMap((record) => record.reentered)).toEqual([]);
  });

  it("only a trapped emulator is rebuilt, a bounded number of times; a failed write was applied; a busy one loses nothing", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    // failed: the bytes went in, so they count as consumed and are not written again
    screen.faults.write = "failed";
    core.program(t).output("applied\r\n");
    await stage.settle();
    // busy: the emulator was not entered, the bytes wait and go in at the next chance
    screen.faults.write = "busy";
    core.program(t).output("waited\r\n");
    await stage.settle();
    expect([screen.emulators.length, screen.attaches.length, screen.state(t)]).toEqual([1, 1, "Live"]);
    expect(screen.view(t).owed).toBe(screen.attaches[0]!.receivedBytes - core.credited(t) - "waited\r\n".length);
    // credit is asked for while the emulator is still busy: what it has not consumed is not credited
    screen.faults.write = "busy";
    screen.pass();
    await stage.settle();
    expect([core.credited(t), screen.view(t).owed]).toEqual([dataBytes(core, t) - "waited\r\n".length, 0]);
    await stage.pass();
    expect(Buffer.concat(screen.emulators[0]!.written).equals(Buffer.concat(screen.attaches[0]!.received))).toBe(true);
    expect(picture(screen.view(t).emulator!).filter((row) => row.trim() !== "")).toEqual(["applied", "waited"]);
    expect(core.credited(t)).toBe(dataBytes(core, t));

    // trapped: that emulator is dead, the pane attaches again with a new one
    screen.faults.write = "trapped";
    core.program(t).output("boom");
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), screen.emulators.length, screen.attaches.length, screen.emulators[0]!.disposed]).toEqual(["Live", 2, 2, true]);
    // an emulator that dies on every paint: the pane gives up after the limit and waits for the retry key
    for (let round = 0; round <= PANE_REOPEN_LIMIT; round++) {
      screen.faults.write = "trapped";
      core.program(t).output("boom");
      await stage.settle();
    }
    expect([screen.state(t), screen.attaches.length]).toEqual(["Failed(emulator)", 2 + PANE_REOPEN_LIMIT]);
    expect(screen.emulators.every((record) => record.disposed)).toBe(true);
    expect(screen.type("a")).toEqual([{ sent: false, code: "failed", notice: true }]);
    screen.panes.retry(t);
    await stage.settle();
    await stage.pass();
    expect(screen.state(t)).toBe("Live");
  });

  it("a terminal sized beyond what an emulator takes fails the pane until its size comes back", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const rival = stage.rival();
    await rival.attach(t, 1200, 50);
    await stage.settle();
    expect([core.size(t), screen.state(t), screen.did(t)]).toEqual(["1200x50", "Failed(size)", ["CLOSE"]]);
    rival.resize(120, 40);
    await stage.settle();
    await stage.pass();
    expect([core.size(t), screen.state(t)]).toEqual(["120x40", "Live"]);
    expect([screen.view(t).actual, screen.emulators.at(-1)!.cols]).toEqual([{ cols: 120, rows: 40 }, 120]);
    // a rectangle no emulator can be made for: no attach leaves
    const flat = core.spawn().address;
    await stage.settle();
    screen.show([t, 80, 24], [flat, 0, 24]);
    await stage.settle();
    expect([screen.state(flat), screen.asked(flat)]).toEqual(["Failed(emulator)", []]);
  });

  it("a new attach told a larger size before its first paint is complete: the picture drawn keeps its own grid", async () => {
    const { stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    screen.faults.stripMark = true;
    screen.show([t, 120, 40]);
    await stage.advance(REATTACH_SETTLE_MS);
    const view = screen.view(t);
    expect([screen.state(t), screen.attaches.at(-1)!.reply, view.actual, view.emulator === screen.emulators[0]!.emulator, view.grid]).toEqual(["Painting", "120x40", { cols: 120, rows: 40 }, true, { cols: 80, rows: 24 }]);
  });

  it("a size refused before a new attach's first paint keeps the grid of the picture still shown", async () => {
    const { stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    // the next attach's first paint never completes: the first attach's picture stays shown
    screen.faults.stripMark = true;
    screen.show([t, 100, 30]);
    await stage.advance(REATTACH_SETTLE_MS);
    expect([screen.state(t), screen.attaches.length, screen.view(t).emulator === screen.emulators[0]!.emulator, screen.emulators[1]!.cols]).toEqual(["Painting", 2, true, 100]);
    await stage.rival().attach(t, 1200, 50);
    await stage.settle();
    expect([screen.state(t), screen.view(t).emulator === screen.emulators[0]!.emulator, screen.view(t).actual]).toEqual(["Failed(size)", true, { cols: 80, rows: 24 }]);
  });

  it("a stream the core closes without a reason is asked about once, attached again a bounded number of times, then failed", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    for (let round = 1; round <= PANE_REOPEN_LIMIT; round++) {
      // a relay dropped the stream: a CLOSE with no reason while the terminal lives
      screen.attaches.at(-1)!.handlers.onClose(null);
      expect(screen.state(t)).toBe("Waiting(closed)");
      await stage.settle();
      expect([round, screen.state(t), screen.attaches.length]).toEqual([round, "Painting", round + 1]);
    }
    screen.attaches.at(-1)!.handlers.onClose(null);
    await stage.settle();
    expect([screen.state(t), screen.attaches.length]).toEqual(["Failed(closed)", PANE_REOPEN_LIMIT + 1]);
    expect(core.calls().filter((call) => call.method === "terminal.get").length).toBe(PANE_REOPEN_LIMIT + 1);
    // a pane that reached live starts the count again
    screen.panes.retry(t);
    await stage.settle();
    await stage.pass();
    screen.attaches.at(-1)!.handlers.onClose(null);
    await stage.settle();
    expect(screen.state(t)).toBe("Painting");
  });

  it("an answer about a dropped stream that comes after the program ended is not used", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    // a relay drops the stream; the core's answer to the question about it is slow, and the program ends meanwhile
    screen.faults.holdCalls = true;
    screen.attaches[0]!.handlers.onClose(null);
    await stage.settle();
    expect(screen.state(t)).toBe("Waiting(closed)");
    core.program(t).exit(3);
    await stage.settle();
    expect(screen.state(t)).toBe("Ended(exited 3)");
    screen.release();
    await stage.settle();
    // the old answer said "it lives": it is not used to attach a finished terminal again
    expect([screen.state(t), screen.attaches.length]).toEqual(["Ended(exited 3)", 1]);
  });

  it("a pane shown again counts its re-attaches anew", async () => {
    const { stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    for (let round = 1; round <= PANE_REOPEN_LIMIT; round++) {
      screen.attaches.at(-1)!.handlers.onClose(null);
      await stage.settle();
    }
    expect([screen.state(t), screen.attaches.length]).toEqual(["Painting", PANE_REOPEN_LIMIT + 1]);
    // the user leaves the tab and comes back before the core answered the CLOSE: the same pane, asked for anew
    screen.show();
    screen.show([t, 80, 24]);
    await stage.settle();
    screen.attaches.at(-1)!.handlers.onClose(null);
    await stage.settle();
    expect([screen.state(t), screen.attaches.length]).toEqual(["Painting", PANE_REOPEN_LIMIT + 3]);
  });

  it("the gate asks the link as well: a live pane takes no input while the link is not online", async () => {
    const { stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    // the link says it is down before any channel of the pane heard of it
    screen.faults.linkState = { kind: "Offline", code: "closed", retryAt: null, reason: "said by the test" };
    expect([screen.state(t), screen.type("a")]).toEqual(["Live", [{ sent: false, code: "offline", notice: true }]]);
    expect(screen.sent(t)).toEqual([]);
    screen.faults.linkState = null;
    expect(screen.type("b")).toEqual([{ sent: true }]);
    expect(screen.sent(t)).toEqual(["DATA 62"]);
  });

  it("what the owner's notify throws is kept and thrown by the next fire, once", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    screen.hooks.notice = (notice) => { if (notice.type === "output") throw new Error("the owner failed"); };
    core.program(t).output("x");
    await stage.settle();
    expect(screen.panes.deadlines().get("failure")).toBe(stage.clock.now);
    expect(() => screen.panes.fire()).toThrow("the owner failed");
    expect(screen.panes.deadlines().has("failure")).toBe(false);
    screen.hooks.notice = undefined;
    expect(() => screen.panes.fire()).not.toThrow();
    expect(screen.state(t)).toBe("Live");
  });
});
