import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA, FRAME_RESIZE, HcConnection } from "../server/herdr-core/connection.ts";
import { CREDIT_WINDOW, FakeHcCore } from "../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../server/herdr-core/layout-doc.ts";
import { type LoopEnd, startLoop } from "./loop.ts";
import { ending, EXIT_FAILED } from "./start.ts";
import { FRAME_PASS_MS, HOLD_RELEASE_MS, NOTICE_SHOW_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, PASTE_LIMIT_BYTES, QUIT_BOUND_MS, RECONNECT_MOST_MS } from "./model/deadlines.ts";
import { demo } from "./testing/fixtures/demo.ts";
import { place } from "./testing/fixtures/fixture.ts";
import { SCALE_LARGEST_TAB, SCALE_TERMINALS, SCALE_WORKSPACES, scale } from "./testing/fixtures/scale.ts";
import { HeadlessHost } from "./testing/headless-host.ts";
import { ManualClock, Run, type RunOptions } from "./testing/run.ts";

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
        return { focus: model.focus, mode: model.mode.name, received: ["t1", "t2", "t3", "t4"].map((terminal) => run.core.program(terminal).receivedHex()) };
      } finally {
        await run.close();
      }
    };
    // a directional focus, two of them, the workspace picker and a key of its mode, resize mode, a zoom and a close,
    // each followed by text in the same read
    for (const bytes of ["\x02lzy\r", "\x02l\x02hab", "\x02wlab", "\x02rhab", "\x02zab", "\x02xab"]) {
      const joined = await outcome([bytes]);
      expect({ bytes, outcome: await outcome([...bytes]) }).toEqual({ bytes, outcome: joined });
      for (let cut = 1; cut < bytes.length; cut++) {
        expect({ bytes, cut, outcome: await outcome([bytes.slice(0, cut), bytes.slice(cut)]) }).toEqual({ bytes, cut, outcome: joined });
      }
    }
    // the gate's case: the text after the move reaches the pane moved to, and nothing reaches the one left
    const moved = await outcome(["\x02lzy\r"]);
    expect([moved.focus.panes["t-main"], moved.received[0], moved.received[1]]).toEqual(["t2", "", Buffer.from("zy\r").toString("hex")]);
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
