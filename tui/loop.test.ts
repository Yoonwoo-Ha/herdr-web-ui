import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_AUTOMATIC_INPUT, FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA, FRAME_RESIZE, HcConnection, HcError, HcReplyError } from "../server/herdr-core/connection.ts";
import { CREDIT_WINDOW, FakeHcCore } from "../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../server/herdr-core/layout-doc.ts";
import { type LoopEnd, startLoop } from "./loop.ts";
import { ending, EXIT_FAILED } from "./start.ts";
import { BEHIND_WRITE_BYTES, BEHIND_WRITE_EVENTS, FRAME_PASS_MS, HOLD_RELEASE_MS, LAYOUT_SHOWN_WAIT_MS, NOTICE_SHOW_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, PASTE_LIMIT_BYTES, QUIT_BOUND_MS, RECONNECT_MOST_MS } from "./model/deadlines.ts";
import { demo } from "./testing/fixtures/demo.ts";
import { place } from "./testing/fixtures/fixture.ts";
import { SCALE_LARGEST_TAB, SCALE_TERMINALS, SCALE_WORKSPACES, scale } from "./testing/fixtures/scale.ts";
import { HeadlessHost } from "./testing/headless-host.ts";
import { ManualClock, Run, type RunOptions } from "./testing/run.ts";
import { ViewStore } from "./view-store.ts";

/** every test drives the loop on the injected clock; only the socket's own turns are real */
const TEST_MS = 120_000;
const SOAK_MS = 600_000;
/** the most the screen's own heap may grow over the soak's last 480 simulated seconds (measured: well under 1 MB) */
const OWN_HEAP_GROWTH_BYTES = 2 * 1024 * 1024;
/** the link's code once its line was cut and a retry found no core listening (tui/core/link.ts) */
const OFFLINE_CODE = "no_core";
/** the most event-loop turns a test waits for the socket's own work, as tui/testing/run.ts settles */
const SETTLE_TURNS = 2_000;

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function start(options: RunOptions): Promise<Run> {
  const run = await Run.start(options);
  runs.push(run);
  return run;
}

/** A core with `count` terminals in one tab (split side by side), the first zoomed when `zoomed`. */
function oneTab(count: number, zoomed = false): FakeHcCore {
  const core = new FakeHcCore();
  const panes: string[] = [];
  for (let n = 0; n < count; n++) panes.push(place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, `pane ${n}\r\n`));
  if (zoomed) {
    const root = panes.slice(1).reduce<unknown>((tree, leaf) => ({ split: "right", ratio: 0.5, first: tree, second: { leaf } }), { leaf: panes[0] });
    core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: panes[0] }] }] }, version: 1 });
  }
  return core;
}

const channelOf = (run: Run, terminal: string): number => run.core.viewers(terminal).at(-1)!.channel;
/** every byte the screen sent a terminal's program, as hex, read from the fake's log: kept after the terminal is removed */
const sentTo = (run: Run, terminal: string): string => Buffer.concat(run.core.log.flatMap((entry) =>
  entry.what === "frame" && entry.from === "viewer" && entry.terminal === terminal && (entry.kind === FRAME_DATA || entry.kind === FRAME_AUTOMATIC_INPUT) ? [entry.payload] : [])).toString("hex");
/** what the screen sent each terminal's program, by terminal, for every terminal it sent anything (one a split or a new
 * tab made too), so a destination outside the fixture's own terminals is seen */
const received = (run: Run): Record<string, string> => Object.fromEntries([...new Set(run.core.log.flatMap((entry) =>
  entry.what === "frame" && entry.from === "viewer" && (entry.kind === FRAME_DATA || entry.kind === FRAME_AUTOMATIC_INPUT) && entry.terminal !== null ? [entry.terminal] : []))].sort().map((terminal) => [terminal, sentTo(run, terminal)]));
/** each read once the screen settled from the one before: the core answers a write, then tells of what it did, and the
 * screen draws it over its own clock; a read after the instant a pane went live */
async function settled(run: Run): Promise<void> {
  await run.advance(200);
  await run.settle();
  await run.advance(FRAME_PASS_MS);
  await run.settle();
  await run.advance(1);
}
const framesOf = (run: Run, kind: number, from = 0) => run.sent.slice(from).filter((frame) => frame.kind === kind && frame.channel !== 0);
const megabyte = (fill: string) => fill.repeat(1024 * 1024 / fill.length);

describe("the loop", () => {
  it("nothing in, nothing out: an idle screen writes nothing and keeps only the line's silence watch", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1_000);
    const written = run.host.bytes().length;
    // the event stream credits hc's heartbeats back (the link's flow control): the panes' channels carry nothing
    const panes = new Set(run.core.viewers().map((viewer) => viewer.channel));
    const frames = run.sent.filter((frame) => panes.has(frame.channel)).length;
    await run.advance(10 * 60_000);
    expect(run.host.bytes().length).toBe(written);
    expect(run.sent.filter((frame) => panes.has(frame.channel)).length).toBe(frames);
    expect(run.clock.armed()).toBe(1);
    expect(run.loop.report().due).toEqual(["link:silence"]);
    expect(run.clock.maxArmed).toBe(1);
  }, TEST_MS);

  it("nothing in, nothing out: with no core it ends at once, with no timer and nothing written", async () => {
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "loop-"));
    try {
      const host = new HeadlessHost();
      const clock = new ManualClock();
      const loop = startLoop({ host, clock, socket: join(folder, "none.sock"), keys: undefined });
      const end = await loop.done;
      expect(end).toMatchObject({ kind: "no_core", code: "no_core" });
      expect(clock.armed()).toBe(0);
      expect(clock.maxArmed).toBe(0);
      expect(host.log()).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, TEST_MS);

  it("rate: a pane that never stops writing gets a frame pass at most every 8 ms", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const from = run.writeTimes.length;
    const passes = run.loop.report().passes;
    for (let n = 0; n < 200; n++) {
      run.core.program("t1").output(`line ${n}\r\n`);
      await run.advance(1);
    }
    const times = run.writeTimes.slice(from);
    expect(times.length).toBeGreaterThan(10);
    for (let at = 1; at < times.length; at++) expect(times[at]! - times[at - 1]!).toBeGreaterThanOrEqual(FRAME_PASS_MS);
    expect(run.loop.report().passes - passes).toBeLessThanOrEqual(Math.ceil(200 / FRAME_PASS_MS) + 1);
    expect(run.clock.maxArmed).toBe(1);
    // the row's numbers: a pass at most every 8 ms, 512 KiB of credit a pass, quit within 2 s
    expect([FRAME_PASS_MS, PASS_CREDIT_BYTES, QUIT_BOUND_MS]).toEqual([8, 512 * 1024, 2_000]);
  }, TEST_MS);

  it("credit follows passes: none between passes, none past the window, then at most 512 KiB a pass", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const credited = run.core.credited("t1");
    const received = run.core.dataTo("t1").join("").length;
    run.core.program("t1").output(megabyte("abcdefgh\r\n"));
    await run.settle();
    expect(run.core.credited("t1")).toBe(credited);
    expect(run.core.dataTo("t1").join("").length - received).toBeLessThanOrEqual(CREDIT_WINDOW);
    for (let pass = 0; pass < 8; pass++) {
      const before = run.core.credited("t1");
      const sent = run.sent.length;
      await run.advance(FRAME_PASS_MS);
      expect(framesOf(run, FRAME_CREDIT, sent).length).toBeLessThanOrEqual(1);
      expect(run.core.credited("t1") - before).toBeLessThanOrEqual(PASS_CREDIT_BYTES);
    }
    expect(run.core.credited("t1")).toBeGreaterThan(credited);
  }, TEST_MS);

  it("credit follows passes: the focused pane first, and no pass hands out more than 512 KiB", async () => {
    const run = await start({ core: oneTab(3) });
    await run.live();
    // the LAST pane in tree order has focus, so tree order alone would credit another first
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t3" }, at: run.clock.current });
    await run.advance(1);
    for (const terminal of ["t1", "t2", "t3"]) run.core.program(terminal).output(megabyte("0123456789abcde\n"));
    await run.settle();
    const focused = channelOf(run, "t3");
    const sent = run.sent.length;
    await run.advance(FRAME_PASS_MS);
    const credits = framesOf(run, FRAME_CREDIT, sent);
    expect(credits[0]?.channel).toBe(focused);
    expect(credits.reduce((sum, frame) => sum + Buffer.from(frame.payload).readUInt32LE(0), 0)).toBeLessThanOrEqual(PASS_CREDIT_BYTES);
    expect(credits.length).toBeLessThan(3);
  }, TEST_MS);

  it("credit follows passes: a pane covered by a zoom gets none, and none leaves while the frame's write is in progress", async () => {
    const run = await start({ core: oneTab(2, true) });
    await run.live();
    expect(run.loop.panes.view("t2")?.covered).toBe(true);
    run.core.program("t2").output(megabyte("covered!\r\n"));
    run.core.program("t1").output("shown\r\n");
    await run.advance(100);
    expect(run.core.credited("t2")).toBe(0);
    let during = -1;
    const before = run.core.credited("t1");
    run.host.duringNextWrite(() => { during = framesOf(run, FRAME_CREDIT).length; });
    const credits = framesOf(run, FRAME_CREDIT).length;
    run.core.program("t1").output("more\r\n");
    await run.advance(FRAME_PASS_MS * 2);
    expect(during).toBe(credits);
    expect(run.core.credited("t1")).toBeGreaterThan(before);
  }, TEST_MS);

  it("hold: a pane inside its program's synchronized update keeps its picture until the hold ends or 1 s passed; others draw; credit flows", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const credited = run.core.credited("t1");
    run.core.program("t1").output("\x1b[?2026hHELD-A");
    run.core.program("t2").output("FREE-B");
    await run.advance(50);
    expect(run.grid().join("\n")).toContain("FREE-B");
    expect(run.grid().join("\n")).not.toContain("HELD-A");
    expect(run.core.credited("t1")).toBeGreaterThan(credited);
    await run.advance(HOLD_RELEASE_MS);
    expect(run.grid().join("\n")).toContain("HELD-A");
    run.core.program("t2").output("\x1b[?2026hHELD-B");
    await run.advance(50);
    expect(run.grid().join("\n")).not.toContain("HELD-B");
    run.core.program("t2").output("\x1b[?2026l");
    await run.advance(50);
    expect(run.grid().join("\n")).toContain("HELD-B");
  }, TEST_MS);

  it("a paste over the limit is refused; the input layer is reset only once no read brought an event for the named wait", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    run.type(`\x1b[200~${"a".repeat(PASTE_LIMIT_BYTES + 10)}`);
    await run.settle();
    expect(run.loop.model().notices.map((notice) => notice.code)).toContain("paste_refused");
    // a slow paste keeps arriving, each piece within the wait: none of it is typed as keys
    for (let piece = 0; piece < 3; piece++) {
      await run.advance(PASTE_ABANDON_MS - 500);
      run.type("bbbb");
      await run.settle();
    }
    await run.advance(PASTE_ABANDON_MS - 1);
    expect(run.loop.report().actions).not.toContain("paste_reset");
    expect(run.core.program("t1").receivedHex()).toBe("");
    await run.advance(1);
    expect(run.loop.report().actions).toContain("paste_reset");
    await run.keys("k");
    await run.advance(20);
    expect(run.core.program("t1").receivedHex()).toBe(Buffer.from("k").toString("hex"));
  }, TEST_MS);

  it("a paste begun in the read that ends a refused paste is framed whole, however long it pauses", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    run.type(`\x1b[200~${"a".repeat(PASTE_LIMIT_BYTES + 10)}`);
    await run.settle();
    expect(run.loop.model().notices.map((notice) => notice.code)).toContain("paste_refused");
    // one read: the refused paste's last bytes and end mark, then a new paste that pauses past the wait
    run.type("aaa\x1b[201~\x1b[200~first ");
    await run.advance(PASTE_ABANDON_MS * 2);
    run.type("second\x1b[201~");
    await run.advance(20);
    expect([run.loop.report().actions.includes("paste_reset"), Buffer.from(run.core.program("t1").receivedHex(), "hex").toString()]).toEqual([false, "first second"]);
  }, TEST_MS);

  it("the loop draws for the host's colour depth: an RGB cell leaves as RGB on a truecolour host, as a palette colour on a 256-colour one", async () => {
    for (const [colorTerm, written, never] of [["truecolor", "38;2;95;135;175", "38;5;67"], ["", "38;5;67", "38;2;"]] as const) {
      const run = await start({ fixture: demo, colorTerm });
      await run.live();
      const from = run.host.output().length;
      run.core.program("t1").output("\x1b[38;2;95;135;175mRGB-CELL\x1b[0m\r\n");
      await run.advance(50);
      const frame = run.host.output().slice(from);
      expect([colorTerm, frame.includes("RGB-CELL"), frame.includes(written), frame.includes(never)]).toEqual([colorTerm, true, true, false]);
      // a host resize makes the painter anew: it still draws for the host's depth
      run.host.resize(100, 30);
      await run.advance(1_000);
      await run.live();
      const resized = run.host.output().length;
      run.core.program("t1").output("\x1b[38;2;95;135;175mRGB-AGAIN\x1b[0m\r\n");
      await run.advance(50);
      const after = run.host.output().slice(resized);
      expect([colorTerm, "after a resize", after.includes("RGB-AGAIN"), after.includes(written), after.includes(never)]).toEqual([colorTerm, "after a resize", true, true, false]);
    }
  }, TEST_MS);

  it("quit detaches: CLOSE on every channel, no terminal killed or removed, the terminal given back", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,q");
    await run.advance(100);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    const closes = run.core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_CLOSE);
    // both panes of the shown tab and the event stream
    expect(closes.length).toBe(3);
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
    for (const terminal of ["t1", "t2", "t3", "t4"]) expect(run.core.terminal(terminal).state).toBe("live");
    expect(run.host.log().at(-1)).toBe("raw off");
  }, TEST_MS);

  it("a refused clipboard write ends the screen as gone without recording or drawing a copied notice", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("press@27:2,drag@30:2");
    await run.advance(FRAME_PASS_MS);
    const writes = run.host.writeAttempts();
    const drawn = run.host.output();
    run.host.failWrites("EIO");
    await run.keys("release@30:2");
    await run.advance(QUIT_BOUND_MS);

    expect(await run.loop.done).toEqual({ kind: "gone", why: "write-failed" });
    expect(run.host.writeAttempts()).toBe(writes + 1);
    expect(run.host.output()).toBe(drawn);
    expect(run.loop.model().notices.map(({ code }) => code)).not.toContain("copied");
  }, TEST_MS);

  it("quit detaches when giving the terminal back fails: done settles within the bound, a quit with the write's code", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const ended: { how: Awaited<typeof run.loop.done> | null } = { how: null };
    void run.loop.done.then((how) => { ended.how = how; });
    run.host.failWrites("EBADF");
    // the prefix and the detach key in one read: the quit starts before any frame could be written
    run.type("\x02q");
    await run.advance(QUIT_BOUND_MS);
    expect(ended.how).toEqual({ kind: "quit", leaveError: "EBADF" });
    expect(run.loop.report().leaveError).toBe("EBADF");
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBe(3);
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
    for (const terminal of ["t1", "t2", "t3", "t4"]) expect(run.core.terminal(terminal).state).toBe("live");
  }, TEST_MS);

  it("a detach never waits behind a layout write: with the core silent mid-close, the prefix and q leave within the quit bound", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    run.muted = true;
    let ended = false;
    void run.loop.done.then(() => { ended = true; });
    // a close: its write waits on a core that answers nothing, and typing waits behind it
    run.type("\x02x");
    await run.advance(20);
    run.type("\x02q");
    await run.advance(QUIT_BOUND_MS + 100);
    expect(ended).toBe(true);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
  }, TEST_MS);

  it("a detach behind an action in the same read never waits behind a layout write either", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    // a printable prefix: a zoom and the detach after it are one text run, so the detach is the rest of that run
    run.loop.dispatch({ type: "keys", keys: { prefix: "-" }, at: run.clock.current });
    await run.advance(1);
    run.muted = true;
    let ended = false;
    void run.loop.done.then(() => { ended = true; });
    run.type("-x");
    await run.advance(20);
    run.type("-z-q");
    await run.advance(QUIT_BOUND_MS + 100);
    expect(ended).toBe(true);
    expect(await run.loop.done).toEqual({ kind: "quit" });
  }, TEST_MS);

  it("a menu choice passes the rest of its read on: a place chosen by digit, then text and Enter, alike read whole, split and a byte at a time", async () => {
    const outcome = async (reads: string[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        await run.advance(1);
        for (const read of reads) {
          run.type(read);
          await run.advance(200);
          await run.settle();
          await run.advance(FRAME_PASS_MS);
          await run.settle();
          await run.advance(1);
        }
        const model = run.loop.model();
        return { focus: model.focus, overlays: model.overlays.map((overlay) => overlay.kind), received: ["t1", "t2", "t3", "t4"].map((terminal) => run.core.program(terminal).receivedHex()) };
      } finally {
        await run.close();
      }
    };
    // the prefix and Enter open the menu; 6 is the shown tab's second pane (t2, not the focused t1); z and Enter go to it
    const bytes = "\x02\r6z\r";
    const joined = await outcome([bytes]);
    expect(joined.received).toEqual(["", Buffer.from("z\r").toString("hex"), "", ""]);
    expect({ outcome: await outcome([...bytes]) }).toEqual({ outcome: joined });
    for (let cut = 1; cut < bytes.length; cut++) expect({ cut, outcome: await outcome([bytes.slice(0, cut), bytes.slice(cut)]) }).toEqual({ cut, outcome: joined });
  }, TEST_MS);

  it("a second layout action read while one is under way is refused as busy: a close pressed twice ends only the pane it was pressed on", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    // two reads before the first close's write could be answered: the second meets the layout the user saw too
    run.type("\x02x");
    run.type("\x02x");
    await settled(run);
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill").map(({ params }) => params["terminal"])).toEqual(["t1"]);
    expect(run.core.terminal("t2").state).toBe("live");
    expect(run.loop.model().notices.map(({ code, data }) => [code, data["action"]])).toEqual([["layout_busy", "close_pane"]]);
  }, TEST_MS);

  it("a refused layout action's keys are taken, not replayed: with two panes, close twice, then Enter reaches the survivor", async () => {
    // the second press in the same read as the first, and in a read of its own; the core telling of the close before
    // it answers, or answering first
    for (const [reads, answerFirst] of [[["\x02x\x02x"], false], [["\x02x", "\x02x"], false], [["\x02x\x02x"], true], [["\x02x", "\x02x"], true]] as const) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      run.core.holdingEvents = answerFirst;
      for (const read of reads) run.type(read);
      await settled(run);
      run.core.releaseEvents();
      await settled(run);
      // once t1 is gone, the same keys replayed would open the close-workspace dialog, and Enter would end t2
      run.type("\r");
      await settled(run);
      expect([reads, run.core.calls().filter(({ method }) => method === "terminal.kill").map(({ params }) => params["terminal"]), run.loop.report().mode.overlays, sentTo(run, "t2")])
        .toEqual([reads, ["t1"], [], Buffer.from("\r").toString("hex")]);
      expect(run.loop.model().notices.map(({ code }) => code)).toContain("layout_busy");
    }
  }, TEST_MS);

  it("refusing a dialog or mode opener leaves its plain tail for the survivor", async () => {
    // No dialog or navigate mode opens during the hold, so y and m remain plain pane input.
    for (const [keys, tail] of [[["\x02Dy"], "y"], [["\x02D", "y"], "y"], [["\x02wm"], "m"], [["\x02w", "m"], "m"]] as const) {
      for (const answerFirst of [false, true]) {
        const label = { keys, answerFirst };
        const run = await start({ core: oneTab(2) });
        await run.live();
        await run.advance(1);
        run.core.holdingEvents = answerFirst;
        run.type("\x02x");
        for (const key of keys) run.type(key);
        await settled(run);
        run.core.releaseEvents();
        await settled(run);
        expect([label, run.loop.report().mode.overlays, run.loop.model().mode.name]).toEqual([label, [], "terminal"]);
        run.type("\r");
        await settled(run);
        expect([label, run.core.calls().filter(({ method }) => method === "terminal.kill").map(({ params }) => params["terminal"]), sentTo(run, "t2")])
          .toEqual([label, ["t1"], Buffer.from(tail + "\r").toString("hex")]);
        await run.close();
      }
    }
  }, TEST_MS);

  it("input behind a close goes to the pane focus moves to once the closed pane left the world, whichever came first", async () => {
    // two and three panes; the core tells of the close before it answers, or answers first; the text in the close's
    // own read or in a read of its own
    for (const panes of [2, 3]) {
      for (const answerFirst of [false, true]) {
        for (const reads of [["\x02xabc"], ["\x02x", "abc"]]) {
          const run = await start({ core: oneTab(panes) });
          await run.live();
          await run.advance(1);
          const label = { panes, answerFirst, reads };
          run.core.holdingEvents = answerFirst;
          for (const read of reads) run.type(read);
          await settled(run);
          expect([label, run.core.calls().filter(({ method }) => method === "terminal.rm").length, sentTo(run, "t1")]).toEqual([label, 1, ""]);
          run.core.releaseEvents();
          await settled(run);
          const state = run.loop.model();
          expect([label, state.focus.panes["t"], sentTo(run, "t1"), sentTo(run, "t2"), state.notices.map(({ code }) => code)])
            .toEqual([label, "t2", "", Buffer.from("abc").toString("hex"), []]);
          await run.close();
        }
      }
    }
  }, TEST_MS);

  it("input behind a close whose pane never leaves the world is refused once the wait ends, and reaches no pane", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    await run.advance(1);
    run.core.holdingEvents = true;
    run.type("\x02xabc");
    await settled(run);
    await run.advance(LAYOUT_SHOWN_WAIT_MS);
    expect([sentTo(run, "t1"), sentTo(run, "t2"), run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])]).toEqual(["", "", [["input_dropped", "not_closed"]]]);
    run.core.releaseEvents();
    await settled(run);
    // the screen catches up, and what comes after goes to the survivor as usual
    run.type("d");
    await settled(run);
    expect([sentTo(run, "t1"), sentTo(run, "t2")]).toEqual(["", Buffer.from("d").toString("hex")]);
  }, TEST_MS);

  it("a close preflight timeout releases held text to the original pane without ending any terminal", async () => {
    for (const reads of [["\x02xabc"], ["\x02x", "abc"]]) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      const call = run.loop.link.call.bind(run.loop.link);
      run.loop.link.call = async (method, params, timeout) => {
        if (method === "terminal.list") {
          run.loop.link.call = call;
          throw new HcError("timeout", "no answer to the preflight read");
        }
        return call(method, params, timeout);
      };
      for (const read of reads) run.type(read);
      await settled(run);
      expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
      expect(received(run)).toEqual({ t1: Buffer.from("abc").toString("hex") });
      expect(run.loop.link.state.kind).toBe("Online");
      expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])).toEqual([["layout_refused", "timeout"]]);
      await run.close();
    }
  }, TEST_MS);

  it.each(["removed", "already gone", "rm refused", "answer lost", "remote timeout"] as const)("a partial close with a sibling %s routes held input independently of event order", async (third) => {
    for (const answerFirst of [false, true]) {
      const run = await start({ core: oneTab(3) });
      await run.live();
      await run.advance(1);
      run.core.holdingEvents = answerFirst;
      const call = run.loop.link.call.bind(run.loop.link);
      run.loop.link.call = async (method, params, timeout) => {
        if ("terminal" in params) {
          if (method === "terminal.kill" && params.terminal === "t2") throw new HcReplyError("blocked", "kill refused");
          if (method === "terminal.kill" && params.terminal === "t3" && third === "remote timeout") throw new HcReplyError("timeout", "machine did not answer");
          if (method === "terminal.rm" && params.terminal === "t3") {
            if (third === "rm refused") throw new HcReplyError("blocked", "remove refused");
            if (third === "already gone") await call(method, params, timeout); // the record is gone when our call arrives
            if (third === "answer lost") {
              await call(method, params, timeout); // it ran, but this client cannot know that
              throw new HcError("timeout", "no answer");
            }
          }
        }
        return call(method, params, timeout);
      };
      run.type("\x02Dyabc");
      await settled(run);
      if (answerFirst) expect(received(run)).toEqual({});
      run.core.releaseEvents();
      await settled(run);
      const reason = third === "answer lost" || third === "remote timeout" ? "layout_unknown" : third === "rm refused" ? "not_closed" : null;
      expect(received(run)).toEqual(reason ? {} : { t2: Buffer.from("abc").toString("hex") });
      expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])).toEqual([
        reason === "layout_unknown" ? ["layout_unknown", undefined] : ["layout_refused", "blocked"],
        ...(reason ? [["input_dropped", reason]] : []),
      ]);
      await run.close();
    }
  }, TEST_MS);

  it("input behind a write that makes a pane waits until the screen shows that pane, and never reaches the pane before", async () => {
    const focusOf = (run: Run) => { const state = run.loop.model(); return state.focus.panes[state.focus.tabs[state.focus.workspace!]!]; };
    const notices = (run: Run) => run.loop.model().notices.map(({ code, data }) => [code, data["reason"]]);
    for (const shown of [true, false]) {
      const run = await start({ fixture: demo });
      await run.live();
      await run.advance(1);
      run.type("\x02c");
      await settled(run);
      // the core answers the new tab's write before it tells of the new pane
      run.core.holdingEvents = true;
      // the name, Enter and text in one read: the text waits behind the new tab's write
      run.type("logs\rabc");
      await settled(run);
      expect([shown, "answered", run.core.calls().some(({ method }) => method === "terminal.run"), focusOf(run), sentTo(run, "t1")]).toEqual([shown, "answered", true, "t1", ""]);
      // never shown in time: the text is refused; shown in time: it goes to the new pane (which refuses it while it opens)
      if (!shown) await run.advance(LAYOUT_SHOWN_WAIT_MS);
      run.core.releaseEvents();
      await settled(run);
      expect([shown, focusOf(run), sentTo(run, "t1"), sentTo(run, "t5"), notices(run)])
        .toEqual([shown, "t5", "", "", [shown ? ["input_refused", "opening"] : ["input_dropped", "not_shown"]]]);
    }
  }, TEST_MS);

  it.each([[true, "joined"], [true, "split"], [false, "joined"], [false, "split"]] as const)(
    "empty-core creation classifies pane input before any pane exists: shown=%s, %s", async (shown, ordering) => {
      const run = await start({ core: new FakeHcCore() });
      await run.advance(1);
      expect(run.loop.model().world.workspaces).toEqual([]);
      run.type("\x02\r");
      await run.advance(FRAME_PASS_MS);
      const menu = run.loop.model().overlays.at(-1);
      if (menu?.kind !== "menu") throw new Error("menu did not open");
      const create = menu.entries.find((entry) => entry.kind === "action" && entry.action === "new_workspace");
      if (!create?.label) throw new Error("New workspace has no label");
      run.core.holdingEvents = true;
      if (ordering === "joined") run.type(create.label + "abc");
      else { run.type(create.label); run.type("abc"); }
      await settled(run);
      expect(run.core.calls().some((call) => call.method === "terminal.run")).toBe(true);
      expect(run.loop.model().focus.workspace).toBeNull();
      expect(received(run)).toEqual({});
      if (!shown) await run.advance(LAYOUT_SHOWN_WAIT_MS);
      run.core.releaseEvents();
      await settled(run);
      expect(received(run)).toEqual({});
      expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]]))
        .toEqual([[shown ? "input_refused" : "input_dropped", shown ? "opening" : "not_shown"]]);
      await run.live();
      run.type("z");
      await settled(run);
      expect(received(run)).toEqual({ t1: "7a" });
    }, TEST_MS);

  it.each([
    ["refused", "joined"], ["refused", "split"], ["unknown", "joined"], ["unknown", "split"],
    ["success", "joined"], ["success", "split"],
  ] as const)("empty-core input belongs to its creation when another client arrives first: %s, %s", async (outcome, ordering) => {
    const run = await start({ core: new FakeHcCore() });
    await run.advance(1);
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const call = run.loop.link.call.bind(run.loop.link);
    let requests = 0;
    let created: string | null = null;
    // Observe the real pane-input boundary without bypassing its opening/attachment checks.
    const focusPane = run.loop.panes.focus.bind(run.loop.panes);
    const inputPane = run.loop.panes.input.bind(run.loop.panes);
    let destination: string | null = null;
    const attempts: (string | null)[] = [];
    run.loop.panes.focus = (pane) => { destination = pane; focusPane(pane); };
    run.loop.panes.input = (input) => {
      if (input.type === "text" && input.text === "abc") attempts.push(destination);
      return inputPane(input);
    };
    run.loop.link.call = async (method, params, timeout) => {
      if (method === "terminal.run") {
        run.loop.link.call = call;
        requests++;
        entered.resolve();
        await answer.promise;
        if (outcome === "refused") throw new HcReplyError("blocked", "create refused");
        if (outcome === "unknown") throw new HcError("timeout", "create answer lost");
        const result = await call(method, params, timeout);
        if (!("address" in result) || typeof result.address !== "string") throw new Error("creation returned no address");
        created = result.address;
        return result;
      }
      return call(method, params, timeout);
    };
    try {
      run.type("\x02\r");
      await run.advance(FRAME_PASS_MS);
      const menu = run.loop.model().overlays.at(-1);
      if (menu?.kind !== "menu") throw new Error("menu did not open");
      const create = menu.entries.find((entry) => entry.kind === "action" && entry.action === "new_workspace");
      if (!create?.label) throw new Error("New workspace has no label");
      if (ordering === "joined") run.type(create.label + "abc");
      else { run.type(create.label); run.type("abc"); }
      await entered.promise;
      expect(run.loop.model().focus.workspace).toBeNull();
      const rival = place(run.core, { space: "rival", spaceName: "rival", tab: "rival-tab", tabName: "rival" }, "$ ");
      await run.live();
      await settled(run);
      expect(run.loop.model().focus.panes["rival-tab"]).toBe(rival);
      expect(run.core.program(rival).receivedHex()).toBe("");
      answer.resolve();
      await settled(run);
      expect(requests).toBe(1);
      expect(run.core.program(rival).receivedHex()).toBe("");
      expect(attempts).toEqual(outcome === "success" ? [created] : []);
      const notices = run.loop.model().notices.map(({ code, data }) => [code, data["reason"]]);
      if (outcome === "success") {
        expect(created).not.toBeNull();
        expect(created).not.toBe(rival);
        expect(notices).toEqual([["input_refused", "opening"]]);
      } else {
        expect(notices).toEqual(outcome === "unknown"
          ? [["layout_unknown", undefined], ["input_dropped", "layout_unknown"]]
          : [["layout_refused", "blocked"], ["input_dropped", "not_shown"]]);
      }
      await run.live();
      run.type("z");
      await settled(run);
      expect(received(run)).toEqual({ [outcome === "success" ? created! : rival]: "7a" });
    } finally {
      answer.resolve();
    }
  }, TEST_MS);

  it("what waits behind a layout write is bounded: past its bytes or events nothing more waits, no paste is cut, and a detach still leaves", async () => {
    const hex = (text: string) => Buffer.from(text).toString("hex");
    const dropped = (run: Run) => run.loop.model().notices.filter(({ code }) => code === "input_dropped").map(({ data }) => data["reason"]);
    // bytes: a paste that would pass the bound is refused whole, and what follows it waits no more
    const bytes = await start({ fixture: demo });
    await bytes.live();
    await bytes.advance(1);
    // every read before the close's write could be answered
    bytes.type("\x02x");
    bytes.type("xyz");
    bytes.type(`\x1b[200~${"a".repeat(BEHIND_WRITE_BYTES - 2)}\x1b[201~`);
    bytes.type("b");
    await settled(bytes);
    expect([sentTo(bytes, "t1"), sentTo(bytes, "t2"), dropped(bytes)]).toEqual(["", hex("xyz"), ["full"]]);
    // events: the one past the bound and all after it go nowhere
    const events = await start({ fixture: demo });
    await events.live();
    await events.advance(1);
    events.type("\x02x");
    for (let n = 0; n < BEHIND_WRITE_EVENTS; n++) events.type("a");
    events.type("c");
    await settled(events);
    expect([sentTo(events, "t1"), sentTo(events, "t2") === hex("a".repeat(BEHIND_WRITE_EVENTS)), dropped(events)]).toEqual(["", true, ["full"]]);
    // full, with a core that never answers: the prefix and q still leave at once
    for (const overflow of ["events", "first text"]) {
      const full = await start({ fixture: demo });
      await full.live();
      await full.advance(1);
      full.muted = true;
      let ended = false;
      void full.loop.done.then(() => { ended = true; });
      full.type("\x02x");
      if (overflow === "events") for (let n = 0; n <= BEHIND_WRITE_EVENTS; n++) full.type("a");
      else full.type("a".repeat(BEHIND_WRITE_BYTES + 1));
      full.type("\x02");
      full.type("q");
      await full.advance(QUIT_BOUND_MS + 100);
      expect([overflow, dropped(full), ended]).toEqual([overflow, ["full"], true]);
    }
  }, TEST_MS);

  it("a key's own text counts against the bytes that wait: a paste at the bound fits, a kitty key with text after it does not", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    // every read before the close's write could be answered; the kitty key reports the text it typed (CSI code;mods;text u)
    run.type("\x02x");
    run.type(`\x1b[200~${"a".repeat(BEHIND_WRITE_BYTES)}\x1b[201~`);
    run.type("\x1b[98;1;98u");
    await settled(run);
    const sent = sentTo(run, "t2");
    expect([sent.length / 2, sent.endsWith(Buffer.from("b").toString("hex")), run.loop.model().notices.filter(({ code }) => code === "input_dropped").map(({ data }) => data["reason"])])
      .toEqual([BEHIND_WRITE_BYTES, false, ["full"]]);
  }, TEST_MS);

  it("a prefix read once the queue is full leaves no prefix armed: alone, before a focus loss or before a refused key, and q after the release is typed", async () => {
    // the prefix takes no place in what waits; what waits is past its bound, so the key it waited for may be gone
    for (const after of ["", "\x1b[O", "z"]) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      let ended = false;
      void run.loop.done.then(() => { ended = true; });
      // every read before the close's write could be answered: the last a goes past the bound
      run.type("\x02x");
      for (let n = 0; n <= BEHIND_WRITE_EVENTS; n++) run.type("a");
      run.type("\x02");
      if (after !== "") run.type(after);
      await settled(run);
      expect([after, run.loop.model().armed, run.loop.model().notices.filter(({ code }) => code === "input_dropped").map(({ data }) => data["reason"])]).toEqual([after, false, ["full"]]);
      // after the release: q is typed into the survivor, not a detach
      run.type("q");
      await settled(run);
      expect([after, ended, sentTo(run, "t2") === Buffer.from(`${"a".repeat(BEHIND_WRITE_EVENTS)}q`).toString("hex")]).toEqual([after, false, true]);
    }
  }, TEST_MS);

  it("a focus loss behind a layout write disarms the prefix in order: q after it is typed, not a detach; without it, q detaches", async () => {
    for (const focus of [true, false]) {
      const run = await start({ fixture: demo });
      await run.live();
      await run.advance(1);
      let ended = false;
      void run.loop.done.then(() => { ended = true; });
      // every read before the close's write could be answered
      run.type("\x02x");
      run.type("\x02");
      if (focus) {
        run.type("\x1b[O");
        run.type("\x1b[I");
      }
      run.type("q");
      await settled(run);
      expect([focus, ended]).toEqual([focus, !focus]);
      if (focus) expect([sentTo(run, "t1"), sentTo(run, "t2")]).toEqual(["", Buffer.from("q").toString("hex")]);
    }
  }, TEST_MS);

  it("random key sequences route alike read whole, split at every byte, and a byte at a time", async () => {
    // prefix actions (moves, zoom, close, help, the workspace picker, resize mode, rename, a new tab's name, detach), text
    // with combining marks, a ZWJ emoji, CJK and wide characters, and Enter; with the default prefix (a key of its own)
    // and with a printable one (one text run holds the actions and what follows them)
    const ACTIONS = ["l", "h", "z", "x", "?", "q", "w", "r", "P", "c"];
    const TEXT = ["a", "q", "e\u0301", "\u0301", "\u{1F469}\u200D\u{1F4BB}", "한", "中", "\uFF21", "\r"];
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const outcome = async (prefix: string, reads: Uint8Array[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        if (prefix !== "\x02") run.loop.dispatch({ type: "keys", keys: { prefix }, at: run.clock.current });
        await run.advance(1);
        let ended = false;
        void run.loop.done.then(() => { ended = true; });
        for (const [at, read] of reads.entries()) {
          run.host.feed(read);
          // a read cut inside a character is followed at once by the rest of it, as a terminal writes whole characters:
          // the framer stamps a character with the time of its first byte, and a pane refuses what was read before its
          // picture, so a character's halves read 200 ms apart would meet a newer picture; any other read comes once the
          // screen settled
          const inside = (reads[at + 1]?.[0] ?? 0) >> 6 === 0b10;
          if (inside) await run.advance(1);
          else await settled(run);
        }
        const model = run.loop.model();
        return {
          ended, busy: model.notices.some((notice) => notice.code === "layout_busy"), focus: model.focus, mode: model.mode.name,
          overlays: model.overlays.map((overlay) => ("field" in overlay ? `${overlay.kind}:${overlay.field.graphemes.join("|")}` : overlay.kind)),
          received: received(run),
        };
      } finally {
        await run.close();
      }
    };
    // A detach never waits for a layout write (it leaves at once), so a write still under way when the screen left may
    // or may not have landed: for a run that detached, only that it left and what each program was sent are compared.
    type Outcome = Awaited<ReturnType<typeof outcome>>;
    const compared = (seen: Outcome) => (seen.ended ? { ended: true, received: seen.received } : seen);
    // A hold refuses every action except detach, and every overlay or mode input, so a read with one after a possible
    // layout write differs by design from split reads, where the write may finish first. Such a sequence is marked
    // generously from tokens: any possible write followed by a non-detach action. Any other must never be refused.
    const refusesInHold = (picked: readonly string[], prefix: string) => {
      let resize = false;
      let wrote = false;
      return picked.some((token) => {
        if (wrote && token.startsWith(prefix) && token !== `${prefix}q`) return true;
        if (token === `${prefix}r`) resize = true;
        wrote ||= token === `${prefix}z` || token === `${prefix}x` || token === "\r" || (resize && (token === `${prefix}h` || token === `${prefix}l`));
        return false;
      });
    };
    for (const prefix of ["\x02", "-"]) {
      const tokens = [...ACTIONS.map((action) => prefix + action), ...TEXT];
      for (let n = 0; n < 10; n++) {
        const picked = Array.from({ length: 3 + Math.floor(random() * 3) }, () => tokens[Math.floor(random() * tokens.length)]!);
        const text = picked.join("");
        const bytes = new TextEncoder().encode(text);
        const whole = await outcome(prefix, [bytes]);
        if (refusesInHold(picked, prefix)) continue;
        expect({ text, busy: whole.busy }).toEqual({ text, busy: false });
        const joined = compared(whole);
        expect({ text, outcome: compared(await outcome(prefix, [...bytes].map((byte) => Uint8Array.of(byte)))) }).toEqual({ text, outcome: joined });
        for (let cut = 1; cut < bytes.length; cut++) {
          expect({ text, cut, outcome: compared(await outcome(prefix, [bytes.slice(0, cut), bytes.slice(cut)])) }).toEqual({ text, cut, outcome: joined });
        }
      }
    }
  }, SOAK_MS);

  it("a text field keeps whole graphemes however the reads split them: 129 decomposed letters, a mark read apart, a ZWJ emoji", async () => {
    const field = async (reads: (string | Uint8Array)[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        await run.advance(1);
        // rename the focused pane: a one-line field
        run.type("\x02P");
        await settled(run);
        for (const read of reads) {
          run.host.feed(read);
          await settled(run);
        }
        const top = run.loop.model().overlays.at(-1);
        return top && "field" in top ? top.field.graphemes : null;
      } finally {
        await run.close();
      }
    };
    const accented = "e\u0301".repeat(129);
    expect((await field([accented]))?.length).toBe(129);
    expect((await field([...accented]))?.length).toBe(129);
    // the mark in a read of its own joins its letter, and one Backspace takes both
    expect(await field(["e", "\u0301"])).toEqual(["e\u0301"]);
    expect(await field(["e", "\u0301", "\x7f"])).toEqual([]);
    const emoji = new TextEncoder().encode("\u{1F469}\u200D\u{1F4BB}");
    expect(await field([...emoji].map((byte) => Uint8Array.of(byte)))).toEqual(["\u{1F469}\u200D\u{1F4BB}"]);
  }, TEST_MS);

  it("quit detaches within its bound when the core never answers", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.muted = true;
    let ended = false;
    void run.loop.done.then(() => { ended = true; });
    await run.keys("ctrl+b,q");
    await run.advance(QUIT_BOUND_MS - 100);
    expect(ended).toBe(false);
    await run.advance(200);
    expect(ended).toBe(true);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBeGreaterThanOrEqual(3);
  }, TEST_MS);

  it("hang-up exits: CLOSE on every channel, the process ends within its bound, nothing is written after", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    // a frame pass is owed at the hang-up, and the core answers no CLOSE: the end comes by the bound, still drawing nothing
    run.core.program("t1").output("drawn\r\n");
    await run.settle();
    run.core.program("t1").output("owed\r\n");
    await run.settle();
    run.muted = true;
    run.host.hangUp();
    const attempts = run.host.writeAttempts();
    const writes = run.loop.report().writes;
    await run.advance(3_000);
    expect(await run.loop.done).toEqual({ kind: "gone", why: "hangup" });
    expect(run.host.exitCode).toBe(129);
    expect(run.host.writeAttempts()).toBe(attempts);
    expect(run.loop.report().writes).toBe(writes);
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBe(3);
  }, TEST_MS);

  it("a terminal gone at the entry's first write: the screen goes no further, ends as gone, and the entry gives the terminal back", async () => {
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "loop-"));
    const socket = join(folder, "hc.sock");
    const listener = await oneTab(1).listen(socket);
    try {
      const host = new HeadlessHost();
      host.failWrites("EIO");
      const clock = new ManualClock();
      const loop = startLoop({ host, clock, socket, keys: undefined });
      const ended: { how: LoopEnd | null } = { how: null };
      void loop.done.then((how) => { ended.how = how; });
      /** turns of the event loop (the socket's own) until `done` holds, at most SETTLE_TURNS */
      const turns = async (done: () => boolean) => {
        for (let turn = 0; turn < SETTLE_TURNS && !done(); turn++) await new Promise<void>((resolve) => setImmediate(resolve));
      };
      await turns(() => host.writeAttempts() > 0);
      expect(host.log()).toEqual(["raw on"]);
      // the closing is bounded on the loop's clock
      clock.current = QUIT_BOUND_MS;
      clock.fireDue();
      await turns(() => ended.how !== null);
      const how = ended.how;
      expect(how).toEqual({ kind: "gone", why: "write-failed" });
      if (how?.kind !== "gone") return;
      const said = ending(how, { path: socket, session: "test" });
      expect([said.leave, said.exit]).toEqual([true, EXIT_FAILED]);
      host.leave();
      expect([host.log(), host.writeAttempts(), loop.report().passes, clock.armed()]).toEqual([["raw on", "raw off"], 1, 0, 0]);
    } finally {
      await listener.close();
      rmSync(folder, { recursive: true, force: true });
    }
  }, TEST_MS);

  it("another pane's first paint delays nothing typed: a key read while that pane drains reaches the focused live pane at once, and stays there", async () => {
    const core = oneTab(2);
    const run = await start({ core });
    await run.live();
    await run.advance(1);
    // a third pane joins the shown tab: once its first paint is drawn, the loop reads stdin before that pane goes live
    place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, "pane 2\r\n");
    for (let waited = 0; run.host.timers() === 0 && waited < 1_000; waited++) await run.advance(1);
    expect(run.host.timers()).toBe(1);
    run.type("k");
    await run.settle();
    expect(run.core.program("t1").receivedHex()).toBe("6b");
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(100);
    await run.live();
    expect(["t1", "t2", "t3"].map((terminal) => run.core.program(terminal).receivedHex())).toEqual(["6b", "", ""]);
  }, TEST_MS);

  it("flood does not delay input: a key typed into one pane leaves in its read's turn while another pane floods", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    run.core.program("t1").output(megabyte("flooding\r\n"));
    await run.advance(1);
    const passes = run.loop.report().passes;
    const sent = run.sent.length;
    run.type("k");
    const data = framesOf(run, FRAME_DATA, sent);
    expect(data.map((frame) => [frame.channel, Buffer.from(frame.payload).toString()])).toEqual([[channelOf(run, "t2"), "k"]]);
    expect(run.loop.report().passes).toBe(passes);
  }, TEST_MS);

  it("directional focus: the prefix and l move to the pane on that side of the drawn tree, and the next key goes there", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,l");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t2");
    await run.keys("ctrl+b,l");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t2");
    await run.keys("z");
    await run.advance(20);
    expect([run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()]).toEqual(["", Buffer.from("z").toString("hex")]);
    await run.keys("ctrl+b,h");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
  }, TEST_MS);

  it("zoom: a zoom of a pane without the focus moves the focus to it, and what is typed reaches only that pane", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    expect(run.loop.model().focus.panes["t"] ?? "t1").toBe("t1");
    const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };
    await run.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: "t2" }] }] }, version: 0 });
    await run.advance(1_000);
    expect([run.loop.panes.view("t1")?.covered, run.loop.panes.view("t2")?.covered]).toEqual([true, false]);
    await run.live();
    await run.advance(1);
    await run.keys("k");
    await run.advance(20);
    expect([run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()]).toEqual(["", Buffer.from("k").toString("hex")]);
    expect(run.loop.model().notices.map((notice) => notice.code)).not.toContain("input_refused");
  }, TEST_MS);

  it("zoom: text after a focus move under a zoom reaches the zoomed pane, in one read as in two", async () => {
    /** what each program received after `reads`, with t2 zoomed and cycle_pane_next on prefix+y */
    const outcome = async (reads: string[]) => {
      const core = oneTab(2);
      const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };
      core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: "t2" }] }] }, version: 1 });
      const run = await Run.start({ core });
      try {
        await run.live();
        run.loop.dispatch({ type: "keys", keys: { cycle_pane_next: "prefix+y" }, at: run.clock.current });
        await run.advance(1);
        for (const read of reads) {
          run.type(read);
          await run.advance(20);
        }
        return { reads, received: [run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()] };
      } finally {
        await run.close();
      }
    };
    const received = ["", Buffer.from("k").toString("hex")];
    expect(await outcome(["\x02yk"])).toEqual({ reads: ["\x02yk"], received });
    expect(await outcome(["\x02y", "k"])).toEqual({ reads: ["\x02y", "k"], received });
  }, TEST_MS);

  it("zoom: a program that asked for focus reports hears the focus leave when a zoom covers its pane and come back when it ends, and keeps its size", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    for (const terminal of ["t1", "t2"]) run.core.program(terminal).output("\x1b[?1004h");
    await run.advance(50);
    const heard = { t1: run.core.program("t1").receivedHex().length, t2: run.core.program("t2").receivedHex().length };
    const since = (terminal: "t1" | "t2") => run.core.program(terminal).receivedHex().slice(heard[terminal]);
    const channel = channelOf(run, "t1");
    const size = run.core.size("t1");
    const sent = run.sent.length;
    const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };
    const zoom = async (zoomed: string | null, version: number) => {
      await run.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed }] }] }, version });
      await run.advance(1_000);
      await run.live();
    };
    await zoom("t2", 0);
    expect([since("t1"), since("t2")]).toEqual(["1b5b4f", "1b5b49"]);
    // t2 attached again at the zoom's rectangle, and the fake's first paint does not replay its mode 1004: only t1 is followed
    await zoom(null, 1);
    expect(since("t1")).toBe("1b5b4f1b5b49");
    expect([channelOf(run, "t1"), run.core.size("t1"), framesOf(run, FRAME_RESIZE, sent).filter((frame) => frame.channel === channel)]).toEqual([channel, size, []]);
  }, TEST_MS);

  it("zoom and unzoom route held bytes against the confirmed document, whichever comes first: doc event or write reply", async () => {
    for (const unzoom of [false, true]) for (const eventFirst of [false, true]) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      if (unzoom) {
        // Remember t1, but show t2. Both terminals already have live attachments.
        const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };
        await run.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: "t2" }] }] }, version: 0 });
        await run.settle();
        expect(run.loop.panes.view("t1")?.covered).toBe(true);
      } else await run.keys("ctrl+b,l"); // zoom t2
      const answer = Promise.withResolvers<void>();
      const call = run.loop.link.call.bind(run.loop.link);
      run.loop.link.call = async (method, params, timeout) => {
        const result = await call(method, params, timeout);
        if (method === "doc.set") await answer.promise;
        return result;
      };
      run.core.holdingEvents = !eventFirst;
      run.type("\x02zabc");
      await run.settle();
      expect(run.loop.panes.view("t1")?.covered).toBe(eventFirst ? !unzoom : unzoom);
      expect(received(run)).toEqual({});
      answer.resolve();
      await run.settle();
      expect(run.loop.panes.view("t1")?.covered).toBe(!unzoom);
      expect(received(run)).toEqual({});
      await run.advance(FRAME_PASS_MS);
      expect(received(run)).toEqual({ [unzoom ? "t1" : "t2"]: "616263" });
      run.core.releaseEvents();
      await settled(run);
      expect(received(run)).toEqual({ [unzoom ? "t1" : "t2"]: "616263" });
      await run.close();
    }
  }, TEST_MS);

  it("a late zoom confirmation cannot replay expired bytes or release the next zoom's input", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    await run.advance(1);
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const refresh = run.loop.link.refreshLayout.bind(run.loop.link);
    run.loop.link.refreshLayout = () => first.promise;
    run.type("\x02za");
    await settled(run);
    await run.advance(LAYOUT_SHOWN_WAIT_MS);
    expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])).toContainEqual(["input_dropped", "not_shown"]);
    run.loop.link.refreshLayout = () => second.promise;
    run.type("\x02zb");
    await run.settle();
    first.resolve(true);
    await run.settle();
    expect(received(run)).toEqual({});
    second.resolve(await refresh());
    await settled(run);
    expect(received(run)).toEqual({ t1: "62" });
  }, TEST_MS);

  it("a size no emulator takes fails that pane alone: drawn as failed, no grid at the refused size, the other pane still typed into", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    const drawn = run.loop.report().grids.find((grid) => grid.pane === "t1");
    expect(drawn).toBeDefined();
    // another viewer sizes t1 past what an emulator takes (1000 columns)
    const rival = new HcConnection(() => run.core.transport());
    await rival.open("terminal.attach", { terminal: "t1", cols: 1200, rows: 50 }, { onData: () => {}, onClose: () => {} });
    await run.advance(1_000);
    expect(run.loop.panes.view("t1")?.state).toMatchObject({ kind: "Failed", code: "size" });
    expect(run.loop.report().grids.find((grid) => grid.pane === "t1")).toEqual(drawn);
    expect(run.grid().join("\n")).toContain("failed: size");
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    await run.keys("k");
    await run.advance(20);
    expect([run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()]).toEqual(["", Buffer.from("k").toString("hex")]);
    rival.close();
  }, TEST_MS);

  it("one read routes as the same bytes split across reads: an action and the text after it in one read", async () => {
    /** the focus, the mode and what every program received after `reads`, each read followed by a turn */
    const outcome = async (reads: string[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        // a read after the panes went live: what was read at the instant they did is refused as early, by design
        await run.advance(1);
        for (const read of reads) {
          run.type(read);
          await run.advance(20);
        }
        const model = run.loop.model();
        return { focus: model.focus, mode: model.mode.name, received: received(run) };
      } finally {
        await run.close();
      }
    };
    // a directional focus, two of them, the workspace picker and a key of its mode, resize mode, a zoom and a close,
    // each followed by text in the same read
    // the help's close key with a combining mark after it: read apart, q closes the help and the mark goes on to the pane,
    // so one read must give the overlay code points too (a text field joins a mark to its letter itself)
    // each with where its text lands: the pane moved to, the zoomed one, the one a close focuses, none in a mode
    const hex = (text: string) => Buffer.from(text).toString("hex");
    const lands: [string, Record<string, string>][] = [
      ["\x02lzy\r", { t2: hex("zy\r") }], ["\x02l\x02hab", { t1: hex("ab") }], ["\x02wlab", {}], ["\x02rhab", {}], ["\x02zab", { t1: hex("ab") }],
      ["\x02xab", { t2: hex("ab") }], ["\x02?qab", { t1: hex("ab") }], ["\x02?q\u0301ab", { t1: hex("\u0301ab") }],
    ];
    for (const [bytes, destination] of lands) {
      const joined = await outcome([bytes]);
      expect({ bytes, received: joined.received }).toEqual({ bytes, received: destination });
      expect({ bytes, outcome: await outcome([...bytes]) }).toEqual({ bytes, outcome: joined });
      for (let cut = 1; cut < bytes.length; cut++) {
        expect({ bytes, cut, outcome: await outcome([bytes.slice(0, cut), bytes.slice(cut)]) }).toEqual({ bytes, cut, outcome: joined });
      }
    }
    // the gate's case: the text after the move reaches the pane moved to, and nothing reaches the one left
    const moved = await outcome(["\x02lzy\r"]);
    expect([moved.focus.panes["t-main"], moved.received]).toEqual(["t2", { t2: hex("zy\r") }]);
  }, TEST_MS);

  it("bounded memory: tabs visited at one host size leave no grid behind, only the shown tab's panes have one", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const visits: [tab: string, panes: string[]][] = [["t-logs", ["t3"]], ["t-notes", ["t4"]], ["t-main", ["t1", "t2"]], ["t-notes", ["t4"]]];
    for (const [tab, panes] of visits) {
      run.loop.dispatch({ type: "select", target: { kind: "tab", id: tab }, at: run.clock.current });
      await run.advance(100);
      await run.live();
      await run.advance(FRAME_PASS_MS);
      expect([tab, run.loop.report().grids.map((grid) => grid.pane).sort()]).toEqual([tab, panes]);
    }
    expect(run.loop.report().actions).not.toContain("painter_rebuilt");
  }, TEST_MS);

  it("scale: 200 terminals in 50 workspaces draw a frame, and only the shown tab's 16 panes are attached", async () => {
    const run = await start({ fixture: scale });
    await run.live(20_000);
    expect(run.loop.model().world.workspaces.length).toBe(SCALE_WORKSPACES);
    expect(run.loop.model().world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).length).toBe(SCALE_TERMINALS);
    const viewers = run.core.viewers();
    expect(viewers.length).toBe(SCALE_LARGEST_TAB);
    expect(new Set(viewers.map((viewer) => viewer.terminal)).size).toBe(SCALE_LARGEST_TAB);
    expect(run.loop.report().writes).toBeGreaterThan(0);
    expect(run.grid().join("\n")).toContain("|pane 0 ");
  }, TEST_MS);
});

/** A screen brought to a state it can rest in: the run, and what arrives each simulated second while it rests. */
interface Resting { run: Run; each?: () => void }

/** One terminal a viewer of its own already sized past what an emulator takes (1000 columns): the screen's pane fails with `size`. */
async function failedPane(): Promise<Resting> {
  const core = oneTab(1);
  const rival = new HcConnection(() => core.transport());
  await rival.open("terminal.attach", { terminal: "t1", cols: 1200, rows: 50 }, { onData: () => {}, onClose: () => {} });
  const run = await start({ core });
  await run.advance(1_000);
  expect(run.loop.panes.view("t1")?.state).toMatchObject({ kind: "Failed", code: "size" });
  // it never showed a picture: its grid is its rectangle, never the refused size
  expect(run.loop.report().grids.filter((grid) => grid.cols > 1_000)).toEqual([]);
  return { run };
}

/** Every state the screen can rest in, each brought about through the screen's own inputs or the core. */
const RESTING: [state: string, enter: () => Promise<Resting>][] = [
  ["a plain tab", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    return { run };
  }],
  ["a zoomed tab with bytes owed behind its zoom", async () => {
    const run = await start({ core: oneTab(2, true) });
    await run.live();
    run.core.program("t2").output(megabyte("covered!\r\n"));
    await run.advance(1_000);
    expect(run.loop.panes.view("t2")?.owed).toBeGreaterThan(0);
    return { run };
  }],
  ["a hidden tab's panes with output arriving", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    return { run, each: () => { for (const terminal of ["t3", "t4"]) run.core.program(terminal).output("hidden\r\n"); } };
  }],
  ["an overlay open", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "action", action: "help", at: run.clock.current });
    expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["help"]);
    return { run };
  }],
  ["the lock on", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "action", action: "lock", at: run.clock.current });
    expect(run.loop.model().locked).toBe(true);
    return { run };
  }],
  ["a pane waiting for its lost terminal's new shell", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.core.lose("t1");
    await run.advance(1_000);
    expect(run.loop.panes.view("t1")?.state).toEqual({ kind: "Waiting", why: "lost" });
    return { run };
  }],
  ["a pane failed", failedPane],
  ["a refused paste abandoned", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.type(`\x1b[200~${"a".repeat(PASTE_LIMIT_BYTES + 10)}`);
    await run.advance(PASTE_ABANDON_MS + 1);
    expect(run.loop.report().actions).toContain("paste_reset");
    return { run };
  }],
  ["after a notice expired", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "notice", code: "test_notice", at: run.clock.current });
    await run.advance(NOTICE_SHOW_MS + 1);
    expect(run.loop.model().notices).toEqual([]);
    return { run };
  }],
  ["an armed prefix", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b");
    expect(run.loop.model().armed).toBe(true);
    return { run };
  }],
  ["navigate mode", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,w");
    expect(run.loop.model().mode.name).toBe("navigate");
    return { run };
  }],
  ["resize mode", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,r");
    expect(run.loop.model().mode.name).toBe("resize");
    return { run };
  }],
  ["copy mode", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,[");
    expect(run.loop.model().mode.name).toBe("copy");
    return { run };
  }],
  ["the sidebar collapsed", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,b");
    expect(run.loop.model().sidebarCollapsed).toBe(true);
    return { run };
  }],
  ["a selection held after its copy", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("press@27:2,drag@30:2,release@30:2");
    expect(run.host.output()).toContain(`\x1b]52;c;${Buffer.from("echo").toString("base64")}\x1b\\`);
    return { run };
  }],
  ["a pane scrolled back with the wheel", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.core.program("t1").output(Array.from({ length: 60 }, (_, n) => `row-${n}`).join("\r\n"));
    await run.advance(20);
    await run.keys("wheelup@40:20");
    // t1's grid has 36 rows: its screen shows the rows three above its newest
    const history = run.loop.panes.view("t1")?.emulator?.history();
    expect(history?.ok && history.value.total - 36 - history.value.viewportTop).toBe(3);
    return { run };
  }],
  ["a divider drag ended", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("press@71:10,drag@60:10,release@60:10");
    await run.advance(20);
    expect(run.loop.report().actions).toContain("divider:done");
    return { run };
  }],
  ["the close-workspace dialog open", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,D");
    expect(run.loop.report().mode.overlays).toEqual(["confirm"]);
    return { run };
  }],
  ["a rename field open", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,T,x");
    expect(run.loop.report().mode.overlays).toEqual(["text"]);
    return { run };
  }],
  ["after a split, the new pane focused", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,v");
    await run.live();
    const state = run.loop.model();
    expect([run.loop.panes.views().map((view) => view.terminal).sort(), state.focus.panes[state.focus.tabs[state.focus.workspace!]!]]).toEqual([["t1", "t2", "t5"], "t5"]);
    return { run };
  }],
  ["after a layout write that changed nothing", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,H");
    await run.advance(20);
    expect(run.loop.model().notices.map((notice) => [notice.code, notice.calm])).toEqual([["layout_unchanged", true]]);
    return { run };
  }],
  ["the narrow one-pane view, another pane of its tab chosen in the menu", async () => {
    const run = await start({ fixture: demo, cols: 45, rows: 30 });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,enter,6");
    await run.live();
    expect(run.loop.panes.views().map((view) => view.terminal)).toEqual(["t2"]);
    return { run };
  }],
  ["the menu open on a narrow screen", async () => {
    const run = await start({ fixture: demo, cols: 45, rows: 30 });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,enter,down,down");
    expect([run.loop.report().mode.overlays, run.loop.model().overlays.at(-1)]).toEqual([["menu"], expect.objectContaining({ cursor: 2 })]);
    return { run };
  }],
  ["a view kept by an earlier run restored", async () => {
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "loop-view-"));
    const core = new FakeHcCore();
    demo.build(core);
    const first = await start({ core, views: new ViewStore(folder) });
    await first.live();
    await first.advance(1);
    await first.keys("ctrl+b,n");
    await first.close();
    runs.splice(runs.indexOf(first), 1);
    const run = await start({ core, views: new ViewStore(folder) });
    await run.live();
    rmSync(folder, { recursive: true, force: true });
    expect(run.loop.panes.views().map((view) => view.terminal)).toEqual(["t3"]);
    return { run };
  }],
];

describe("nothing in, nothing out, in every state the screen rests in", () => {
  for (const [state, enter] of RESTING) {
    it(`nothing in, nothing out: ${state}`, async () => {
      const { run, each } = await enter();
      // past the last deadline any of these states names: the notice (5 s), the paste (3 s), a reattach, a paint's quiet
      await run.advance(NOTICE_SHOW_MS + 1_000);
      const passes = run.loop.report().passes;
      const written = run.host.bytes().length;
      for (let second = 0; second < 10; second++) {
        each?.();
        await run.advance(1_000);
      }
      expect([state, run.loop.report().passes - passes, run.host.bytes().length - written, run.loop.report().due, run.clock.maxArmed])
        .toEqual([state, 0, 0, ["link:silence"], 1]);
    }, TEST_MS);
  }

  it("nothing in, nothing out: with the core's line gone, only the link's retry wakes the screen, and nothing is written", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.cutLine();
    await run.advance(30_000);
    expect(run.loop.panes.views().map((view) => view.state)).toEqual([{ kind: "Waiting", why: "offline" }, { kind: "Waiting", why: "offline" }]);
    const passes = run.loop.report().passes;
    const written = run.host.bytes().length;
    await run.advance(10 * RECONNECT_MOST_MS);
    expect(run.host.bytes().length - written).toBe(0);
    expect(run.loop.report().due).toEqual(["link:reconnect"]);
    // a retry changes the link's state twice (Connecting, then Offline again): at most a pass each, writing nothing
    expect(run.loop.report().passes - passes).toBeLessThanOrEqual(2 * 10);
  }, TEST_MS);
});

describe("the whole screen", () => {
  it("shows the demo's panes with their Korean text, and typed keys reach the focused pane once and in order while another floods", async () => {
    const run = await start({ fixture: demo, cols: 120, rows: 40 });
    await run.live();
    const grid = run.grid();
    expect(grid.some((row) => row.includes("안녕하세요, 헤르더 세계"))).toBe(true);
    expect(grid.some((row) => row.includes("README.md  한글.txt"))).toBe(true);
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    const typed = "echo 한글 ok\r";
    for (const char of typed) {
      run.core.program("t1").output(`flood ${char}\r\n`.repeat(200));
      await run.keys(char);
    }
    await run.advance(50);
    expect(Buffer.from(run.core.program("t2").receivedHex(), "hex").toString("utf8")).toBe(typed);
    expect(run.core.program("t1").receivedHex()).toBe("");
  }, TEST_MS);

  it("after the core's line is cut: offline, nothing typed is sent, and it recovers by itself with nothing replayed", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("a");
    await run.advance(20);
    const before = run.core.program("t1").receivedHex();
    await run.cutLine();
    await run.advance(1_000);
    expect(run.loop.link.state.kind).toBe("Offline");
    // the offline state as data and drawn on the screen
    expect(run.loop.report().link).toEqual({ kind: "Offline", code: OFFLINE_CODE });
    expect(run.grid().join("\n")).toContain("herdr-core is not answering");
    expect(run.grid().join("\n")).toContain("hc server start");
    expect(run.loop.panes.views().map((view) => view.state.kind)).toEqual(["Waiting", "Waiting"]);
    await run.keys("l,o,s,t,enter");
    const lines = run.core.viewers().length;
    expect(lines).toBe(0);
    await run.listen();
    await run.advance(10_000);
    expect(run.loop.link.state).toMatchObject({ kind: "Online", epoch: 2 });
    await run.live();
    expect(run.core.program("t1").receivedHex()).toBe(before);
    const viewers = run.core.viewers();
    expect(viewers.map((viewer) => viewer.terminal).sort()).toEqual(["t1", "t2"]);
    expect(new Set(viewers.map((viewer) => viewer.line)).size).toBe(1);
    expect(run.clock.armed()).toBeLessThanOrEqual(1);
    expect(run.clock.maxArmed).toBe(1);
  }, TEST_MS);

  it("soak: 10 simulated minutes of output, input, resizes, tab switches and two reconnects", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    /** the heap after GC with the test tooling's kept lists emptied: what the screen itself holds */
    const ownHeap = () => {
      run.forget();
      Bun.gc(true);
      return process.memoryUsage().heapUsed;
    };
    /** what the loop itself keeps, as it exposes it: these counts must not grow with time */
    const kept = () => ({ actions: run.loop.report().actions.length, notices: run.loop.model().notices.length, deadlines: run.loop.model().deadlines.size });
    let keptMiddle = kept();
    const memory = { start: process.memoryUsage().rss, middle: 0, end: 0, heapMiddle: 0, heapEnd: 0 };
    const sizes = [[120, 40], [100, 30], [80, 24], [140, 45]] as const;
    for (let second = 0; second < 600; second++) {
      for (const terminal of ["t1", "t2", "t3", "t4"]) run.core.program(terminal).output(`s${second} ${terminal} 안녕 ${"x".repeat(second % 50)}\r\n`);
      if (second % 7 === 0) await run.keys(`k${second % 10}`);
      if (second % 50 === 25) {
        const [cols, rows] = sizes[(second / 50 | 0) % sizes.length]!;
        run.host.resize(cols, rows);
      }
      if (second % 30 === 15) run.loop.dispatch({ type: "action", action: "next_tab", at: run.clock.current });
      if (second % 90 === 45) run.loop.dispatch({ type: "action", action: "next_workspace", at: run.clock.current });
      if (second === 200 || second === 400) {
        await run.cutLine();
        await run.advance(2_000);
        await run.listen();
      }
      await run.advance(1_000);
      if (second === 120) {
        keptMiddle = kept();
        memory.heapMiddle = ownHeap();
        memory.middle = process.memoryUsage().rss;
      }
    }
    const keptEnd = kept();
    memory.heapEnd = ownHeap();
    memory.end = process.memoryUsage().rss;
    // the same place a fresh screen opens: the first workspace's first tab, at the first size
    run.loop.dispatch({ type: "select", target: { kind: "tab", id: "t-main" }, at: run.clock.current });
    run.host.resize(120, 40);
    await run.advance(5_000);
    await run.live();
    await run.advance(60_000);
    process.stderr.write(`soak memory: ${JSON.stringify(memory)} passes=${run.loop.report().passes} maxArmed=${run.clock.maxArmed}\n`);
    expect(run.clock.maxArmed).toBe(1);
    expect(run.clock.armed()).toBe(1);
    expect(run.loop.report().due).toEqual(["link:silence"]);
    expect(run.loop.report().actions.some((code) => code.startsWith("end:") || code === "crash")).toBe(false);
    // what the loop keeps at second 600 is what it kept at second 120, and its panes are the shown tab's at most
    expect(keptEnd).toEqual(keptMiddle);
    expect(run.loop.panes.views().length).toBeLessThanOrEqual(2);
    // the screen's own heap over the last 480 simulated seconds of output, input, resizes and a reconnect
    expect(memory.heapEnd - memory.heapMiddle).toBeLessThan(OWN_HEAP_GROWTH_BYTES);
    const fresh = await start({ core: run.core, cols: 120, rows: 40 });
    await fresh.live();
    expect(run.grid()).toEqual(fresh.grid());
  }, SOAK_MS);
});
