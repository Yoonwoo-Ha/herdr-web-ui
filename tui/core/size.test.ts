import { afterEach, describe, expect, it } from "bun:test";
import { FRAME_CLOSE, FRAME_DATA, FRAME_FACTS, FRAME_FOCUS, FRAME_RESIZE } from "../../server/herdr-core/connection.ts";
import { type FakeCoreOptions, FakeHcCore, FEATURES_0_1_17, HEADLESS } from "../../server/herdr-core/core.fake.ts";
import { REATTACH_SETTLE_MS } from "../model/deadlines.ts";
import { type Screen, Stage } from "../testing/pane-harness.ts";
import type { PaneView } from "./pane.ts";
import { attachSent, attachSize, clipTop, detached, newPaneSize, overtaken, type PaneSize, reattachDue, reattaching, rectangleChanged, replied, sizedBy, sizeHeard, sizeTold, took } from "./size.ts";

// The size rules of the pane machine on the fake core, which carries herdr-core's own size rule as
// probe c measured it: the eleven cases of the design (UB Q3) as row 23 narrows them (only the
// user's input in a pane sends a RESIZE or a FOCUS), and the cases row 23 adds.

const stages: Stage[] = [];
afterEach(async () => {
  for (const stage of stages.splice(0)) await stage.close();
});

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
const SIZE_FRAMES = [FRAME_RESIZE, FRAME_FOCUS, FRAME_FACTS, FRAME_DATA];
/** the attaches, CLOSE frames, RESIZE frames and `size` events the core has seen so far */
const traffic = (core: FakeHcCore) => ({
  attaches: core.calls().filter((call) => call.method === "terminal.attach").length,
  closes: core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_CLOSE).length,
  resizes: core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_RESIZE).length,
  sizes: core.log.filter((entry) => entry.what === "event" && entry.type === "size").length,
});
/** the sizes a screen's attaches of `terminal` advertised, in order */
const asked = (screen: Screen, terminal: string) => screen.asked(terminal).map((params) => `${String(params["cols"])}x${String(params["rows"])}`);
/** ten deadline steps with a frame pass each: what a screen does when it is left alone */
const rest = async (stage: Stage, seen?: () => void) => {
  for (let step = 0; step < 10; step++) {
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    seen?.();
  }
};

describe("the size rules of a pane", () => {
  it("attach never stamps", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 3 });
    await stage.live(screen, [terminals[0]!, 80, 24], [terminals[1]!, 60, 20], [terminals[2]!, 40, 10]);
    screen.show([terminals[0]!, 90, 30], [terminals[1]!, 60, 20], [terminals[2]!, 40, 10]);
    await stage.advance(REATTACH_SETTLE_MS);
    const attaches = core.calls().filter((call) => call.method === "terminal.attach").map((call) => call.params);
    expect(attaches.length).toBe(4);
    expect(attaches.map((params) => [params["resumed"], "observe" in params, "resize_notifications" in params])).toEqual(Array(4).fill([true, false, false]));
    expect(core.viewers().map((viewer) => [viewer.stamped, viewer.observe])).toEqual(Array(3).fill([false, false]));
  });

  it("alone fits", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 3 });
    await stage.live(screen, [terminals[0]!, 100, 50], [terminals[1]!, 50, 25], [terminals[2]!, 49, 24]);
    expect(terminals.map((terminal) => core.size(terminal))).toEqual(["100x50", "50x25", "49x24"]);
    expect(terminals.map((terminal) => screen.sent(terminal))).toEqual([[], [], []]);
    expect(terminals.map((terminal) => screen.view(terminal).sizedBy)).toEqual([null, null, null]);
  });

  it("beside an active viewer", async () => {
    const { core, stage, screen, terminals: [, t2] } = await scene({ terminals: 3 });
    const browser = stage.rival();
    await browser.attach(t2!, 120, 40);
    browser.type("x");
    await stage.live(screen, [t2!, 80, 24]);
    core.program(t2!).output("\x1b[?1004h");
    await stage.settle();
    // the screen is resized and the focus passes over the pane: the terminal is still the browser's
    screen.show([t2!, 70, 20]);
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    screen.panes.focus(t2!);
    screen.panes.focus(null);
    await stage.advance(10_000);
    expect(core.size(t2!)).toBe("120x40");
    expect(screen.sent(t2!, SIZE_FRAMES)).toEqual([]);
    // drawn clipped, from the real grid, with the notice
    expect([screen.state(t2!), screen.view(t2!).sizedBy, screen.view(t2!).actual]).toEqual(["Live", { cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);
    expect([screen.emulators.at(-1)!.cols, screen.emulators.at(-1)!.rows]).toEqual([120, 40]);
    expect(core.program(t2!).sizes).toEqual(["200x120", "120x40"]);
  });

  it("host resize of a pane", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    // the window is dragged: five rectangles in 100 ms
    for (let step = 1; step <= 5; step++) {
      screen.show([t, 80 + step, 24]);
      await stage.advance(25);
    }
    expect([screen.attaches.length, screen.sent(t), core.size(t)]).toEqual([1, [], "80x24"]);
    await stage.advance(REATTACH_SETTLE_MS - 26);
    expect(screen.attaches.length).toBe(1);
    await stage.advance(1);
    await stage.pass();
    // zero RESIZE and one reattach, with the last rectangle
    expect([screen.state(t), screen.did(t), screen.sent(t), core.size(t)]).toEqual(["Live", ["CLOSE"], [], "85x24"]);
    expect(screen.asked(t).map((params) => `${String(params["cols"])}x${String(params["rows"])}`)).toEqual(["80x24", "85x24"]);
    await stage.advance(10_000);
    expect(screen.attaches.length).toBe(2);
  });

  it("take order", async () => {
    // a core without automatic input: the focus-in travels with the user's first input
    const old = await scene({ ...OLD, terminals: 2 });
    const [, p2] = old.terminals;
    await old.stage.live(old.screen, [old.t, 80, 24], [p2!, 80, 24]);
    // another viewer takes the terminal; the pane repaints at that size and advertises it
    const browser = old.stage.rival();
    await browser.attach(p2!, 120, 40);
    browser.type("x");
    await old.stage.advance(REATTACH_SETTLE_MS);
    await old.stage.pass();
    expect([old.core.size(p2!), old.screen.view(p2!).advertised]).toEqual(["120x40", { cols: 120, rows: 40 }]);
    old.screen.panes.focus(p2!);
    expect(old.screen.type("a")).toEqual([{ sent: true }]);
    await old.stage.settle();
    expect([old.screen.sent(p2!), old.core.size(p2!)]).toEqual([["RESIZE 80x24", "FOCUS 1", "DATA 61"], "80x24"]);
    expect(old.screen.type("b")).toEqual([{ sent: true }]);
    expect(old.screen.sent(p2!)).toEqual(["RESIZE 80x24", "FOCUS 1", "DATA 61", "DATA 62"]);

    // automatic input confirmed: no FOCUS frame at all
    const { core, stage, screen, terminals: [, q2] } = await scene({ terminals: 2 });
    await stage.live(screen, [q2!, 80, 24]);
    const other = stage.rival();
    await other.attach(q2!, 120, 40);
    other.type("x");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    screen.panes.focus(q2!);
    expect(screen.type("a")).toEqual([{ sent: true }]);
    await stage.settle();
    expect([screen.sent(q2!), core.size(q2!)]).toEqual([["RESIZE 80x24", "DATA 61"], "80x24"]);
  });

  it("no idle RESIZE", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 2 });
    await stage.live(screen, [terminals[0]!, 80, 24], [terminals[1]!, 60, 20]);
    const before = traffic(core);
    for (let pass = 0; pass < 100; pass++) {
      screen.show([terminals[0]!, 80, 24], [terminals[1]!, 60, 20]);
      screen.pass();
      await stage.advance(REATTACH_SETTLE_MS);
    }
    expect(traffic(core)).toEqual(before);
    expect(terminals.map((terminal) => screen.sent(terminal))).toEqual([[], []]);
  });

  it("focus reports on a pane switch", async () => {
    const { core, stage, screen, terminals: [p1, p2] } = await scene({ terminals: 2 });
    await stage.live(screen, [p1!, 80, 24], [p2!, 80, 24]);
    core.program(p1!).output("\x1b[?1004h");
    core.program(p2!).output("\x1b[?1004h");
    await stage.settle();
    const before = traffic(core);
    screen.panes.focus(p2!);
    screen.panes.focus(p2!);
    // the old pane's program hears focus-out and the new one's focus-in, once each, as automatic input
    expect([screen.sent(p1!), screen.sent(p2!)]).toEqual([["AUTOMATIC_INPUT 1b5b4f"], ["AUTOMATIC_INPUT 1b5b49"]]);
    expect([core.program(p1!).receivedHex(), core.program(p2!).receivedHex()]).toEqual(["1b5b4f", "1b5b49"]);
    await stage.advance(10_000);
    expect(traffic(core)).toEqual(before);
    expect([core.size(p1!), core.size(p2!)]).toEqual(["80x24", "80x24"]);
    // a program that did not ask for focus reports gets none
    core.program(p1!).output("\x1b[?1004l");
    await stage.settle();
    screen.panes.focus(p1!);
    expect([screen.sent(p1!), screen.sent(p2!)]).toEqual([["AUTOMATIC_INPUT 1b5b4f"], ["AUTOMATIC_INPUT 1b5b49", "AUTOMATIC_INPUT 1b5b4f"]]);

    // a core without automatic input: the switch sends no bytes, and the focus-in comes with the first key, once
    const old = await scene({ ...OLD, terminals: 2 });
    const [o1, o2] = old.terminals;
    await old.stage.live(old.screen, [o1!, 80, 24], [o2!, 80, 24]);
    old.core.program(o1!).output("\x1b[?1004h");
    old.core.program(o2!).output("\x1b[?1004h");
    await old.stage.settle();
    old.screen.panes.focus(o2!);
    old.screen.panes.focus(o1!);
    old.screen.panes.focus(o2!);
    await old.stage.advance(10_000);
    expect([old.screen.sent(o1!), old.screen.sent(o2!)]).toEqual([[], []]);
    old.screen.type("ab");
    expect([old.screen.sent(o1!), old.screen.sent(o2!)]).toEqual([[], ["FOCUS 1", "DATA 61", "DATA 62"]]);
    expect(old.core.program(o2!).receivedHex()).toBe("1b5b496162");
    // FOCUS 0 goes only to a channel that got FOCUS 1, when its pane leaves the screen
    old.screen.show();
    await old.stage.settle();
    expect([old.screen.sent(o1!), old.screen.sent(o2!)]).toEqual([[], ["FOCUS 1", "DATA 61", "DATA 62", "FOCUS 0"]]);
  });

  it("foreign resize resyncs once", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const browser = stage.rival();
    await browser.attach(t, 120, 40);
    // five `size` events in 100 ms that this screen did not cause
    for (let step = 1; step <= 4; step++) {
      await stage.advance(25);
      browser.resize(120 + step, 40);
      await stage.settle();
    }
    expect([core.events(t, "size").length, screen.attaches.length]).toEqual([6, 1]);
    await stage.advance(REATTACH_SETTLE_MS - 1);
    expect(screen.attaches.length).toBe(1);
    await stage.advance(1);
    await stage.pass();
    // one CLOSE and one attach, 150 ms after the last, advertising the terminal's own size: nothing changes for the other viewer
    expect([screen.state(t), screen.did(t), core.size(t), core.events(t, "size").length]).toEqual(["Live", ["CLOSE"], "124x40", 6]);
    expect(screen.asked(t).at(-1)).toMatchObject({ cols: 124, rows: 40, resumed: true });
    expect([screen.view(t).advertised, screen.view(t).sizedBy]).toEqual([{ cols: 124, rows: 40 }, { cols: 124, rows: 40 }]);
    await stage.advance(10_000);
    expect(screen.attaches.length).toBe(2);
    // the pane's own take: its `size` event is confirmed, and no attach follows
    expect(screen.type("a")).toEqual([{ sent: true }]);
    await stage.advance(10_000);
    expect([core.size(t), screen.attaches.length, screen.view(t).sizedBy]).toEqual(["80x24", 2, null]);
  });

  it("shown tab only", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 5 });
    const [a, b, c, d, e] = terminals as [string, string, string, string, string];
    await stage.live(screen, [a, 80, 24], [b, 40, 12], [c, 40, 12]);
    // only what the shown tab gives a rectangle is attached
    expect(core.viewers().map((viewer) => viewer.terminal)).toEqual([a, b, c]);
    // a zoom covers two panes: none is closed, and neither sends a frame, not even credit
    screen.show([a, 80, 24], [b, 40, 12, true], [c, 40, 12, true]);
    const covered = screen.calls.length;
    core.program(b).output("\x1b[5n hidden output\r\n");
    await stage.advance(10_000);
    await stage.pass();
    expect(screen.calls.slice(covered).filter((call) => call.attach.terminal !== a)).toEqual([]);
    expect(core.viewers().length).toBe(3);
    expect(screen.type("x")).toEqual([{ sent: true }]);
    // uncovered, the pane takes up where it stopped
    screen.show([a, 80, 24], [b, 40, 12], [c, 40, 12]);
    await stage.pass();
    expect(screen.calls.slice(covered).filter((call) => call.attach.terminal === b).map((call) => call.op)).toEqual(["credit"]);
    // a tab change closes the three channels and attaches the other tab's panes
    screen.show([d, 80, 24], [e, 80, 24]);
    await stage.settle();
    await stage.pass();
    expect([screen.did(a), screen.did(b), screen.did(c)]).toEqual([["DATA 78", "CLOSE"], ["CLOSE"], ["CLOSE"]]);
    expect(core.viewers().map((viewer) => viewer.terminal)).toEqual([d, e]);
    expect([a, b, c, d, e].map((terminal) => screen.state(terminal))).toEqual(["gone", "gone", "gone", "Live", "Live"]);
    expect(screen.emulators.map((record) => record.disposed)).toEqual([true, true, true, false, false]);
    expect([core.size(a), core.size(d)]).toEqual([`${HEADLESS.cols}x${HEADLESS.rows}`, "80x24"]);
  });

  it("two screens", async () => {
    const { core, stage, screen, t } = await scene();
    const second = await stage.screen();
    second.panes.focus(t);
    await stage.live(screen, [t, 80, 24]);
    await stage.live(second, [t, 120, 40]);
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    const before = traffic(core);
    // both idle for ten simulated seconds: zero frames from either
    for (let elapsed = 0; elapsed < 10; elapsed++) {
      await stage.advance(1_000);
      await stage.pass();
    }
    expect(traffic(core)).toEqual(before);
    expect([screen.sent(t), second.sent(t)]).toEqual([[], []]);
    // the one typed into last holds the size
    screen.type("a");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    expect(core.size(t)).toBe("80x24");
    second.type("b");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    expect(core.size(t)).toBe("120x40");
    expect([screen.view(t).sizedBy, second.view(t).sizedBy]).toEqual([{ cols: 120, rows: 40 }, null]);
  });

  it("grid follows the record", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 2 });
    const [a, b] = terminals as [string, string];
    await stage.live(screen, [a, 80, 24], [b, 60, 20]);
    const browser = stage.rival();
    await browser.attach(a, 100, 30);
    const follows = async () => {
      await stage.settle();
      return terminals.every((terminal) => {
        const record = screen.emulators.filter((made) => !made.disposed).find((made) => made.emulator === screen.view(terminal).emulator)!;
        return `${record.cols}x${record.rows}` === core.size(terminal) && `${screen.view(terminal).actual!.cols}x${screen.view(terminal).actual!.rows}` === core.size(terminal);
      });
    };
    const held: boolean[] = [await follows()];
    for (const [cols, rows] of [[101, 30], [90, 31], [132, 43], [20, 5], [100, 30]] as const) {
      browser.resize(cols, rows);
      // the emulator has the new size at once, before the next bytes are fed
      core.program(a).output(`after ${cols}x${rows}\r\n`);
      held.push(await follows());
    }
    await browser.detach();
    held.push(await follows());
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    held.push(await follows());
    expect(held).toEqual(Array(8).fill(true));
    expect([screen.state(a), screen.state(b)]).toEqual(["Live", "Live"]);
  });

  it("two idle screens settle", async () => {
    const { core, stage, screen: first, t } = await scene();
    const second = await stage.screen();
    second.panes.focus(t);
    await stage.live(first, [t, 80, 24]);
    await stage.live(second, [t, 120, 40]);
    const after: ReturnType<typeof traffic>[] = [];
    for (let step = 0; step < 10; step++) {
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      after.push(traffic(core));
    }
    // after the first step nothing more happens: no attach, CLOSE, RESIZE or size change
    expect(after.slice(1)).toEqual(Array(9).fill(after[0]));
    expect(after[0]).toEqual({ attaches: 3, closes: 1, resizes: 0, sizes: 2 });
    expect(core.size(t)).toBe("120x40");
    expect([first.view(t).advertised, first.view(t).sizedBy, first.state(t)]).toEqual([{ cols: 120, rows: 40 }, { cols: 120, rows: 40 }, "Live"]);
    expect([second.view(t).advertised, second.view(t).sizedBy]).toEqual([{ cols: 120, rows: 40 }, null]);
    // a key in the first screen takes the terminal for its rectangle; the second repaints once, asking for nothing
    expect(first.type("k")).toEqual([{ sent: true }]);
    expect(first.sent(t)).toEqual(["RESIZE 80x24", "DATA 6b"]);
    for (let step = 0; step < 10; step++) {
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
    }
    expect(second.asked(t).map((params) => `${String(params["cols"])}x${String(params["rows"])}`)).toEqual(["120x40", "80x24"]);
    expect([core.size(t), traffic(core).attaches, first.attaches.length, second.sent(t)]).toEqual(["80x24", 4, 2, []]);
  });

  it("take during a waiting reattach advertises first", async () => {
    const { core, stage, screen, t } = await scene(OLD);
    await stage.live(screen, [t, 80, 24]);
    const driver = stage.rival();
    await driver.attach(t, 120, 40);
    driver.type("x");
    await stage.settle();
    // the pane's rectangle becomes 120x40, and a key arrives inside the 150 ms, on the channel that still advertises 80x24
    screen.show([t, 120, 40]);
    await stage.advance(REATTACH_SETTLE_MS - 50);
    expect([screen.view(t).advertised, screen.panes.deadlines().has("reattach")]).toEqual([{ cols: 80, rows: 24 }, true]);
    expect(screen.type("k")).toEqual([{ sent: true }]);
    await stage.settle();
    expect(screen.sent(t)).toEqual(["RESIZE 120x40", "FOCUS 1", "DATA 6b"]);
    // the terminal was never 80x24 again after the driver took it, and the waiting reattach is off
    expect(core.program(t).sizes).toEqual(["200x120", "80x24", "120x40"]);
    expect(screen.panes.deadlines().has("reattach")).toBe(false);
    await stage.advance(10_000);
    expect([screen.attaches.length, core.size(t), screen.view(t).sizedBy]).toEqual([1, "120x40", null]);
  });

  it("same size is not ownership", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, terminals: [t, elsewhere] } = await scene({ ...options, terminals: 2 });
      // a second viewer drives the terminal at exactly the pane's rectangle
      const browser = stage.rival();
      await browser.attach(t!, 80, 24);
      browser.type("x");
      await stage.live(screen, [t!, 80, 24], [elsewhere!, 40, 10]);
      core.program(t!).output("\x1b[?1004h");
      await stage.settle();
      // the host is resized twice, and focus moves away and back
      screen.show([t!, 100, 30], [elsewhere!, 40, 10]);
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      screen.show([t!, 90, 28], [elsewhere!, 40, 10]);
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      screen.panes.focus(elsewhere!);
      screen.panes.focus(t!);
      await stage.advance(10_000);
      expect(screen.sent(t!, [FRAME_RESIZE, FRAME_FOCUS])).toEqual([]);
      expect([core.size(t!), core.program(t!).sizes]).toEqual(["80x24", ["200x120", "80x24"]]);
      expect([screen.state(t!), screen.view(t!).sizedBy]).toEqual(["Live", { cols: 80, rows: 24 }]);
    }
  });

  it("focus pass-through takes nothing", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, terminals } = await scene({ ...options, terminals: 3 });
      // another viewer drives the middle terminal
      const browser = stage.rival();
      await browser.attach(terminals[1]!, 120, 40);
      browser.type("x");
      await stage.live(screen, [terminals[0]!, 60, 20], [terminals[1]!, 60, 20], [terminals[2]!, 60, 20]);
      for (const terminal of terminals) core.program(terminal).output("\x1b[?1004h");
      await stage.settle();
      const before = terminals.map((terminal) => core.size(terminal));
      // the focus keys carry the focus through every pane and back, with nothing typed
      for (const terminal of [...terminals, ...[...terminals].reverse(), null]) screen.panes.focus(terminal);
      await stage.advance(10_000);
      expect(terminals.map((terminal) => screen.sent(terminal, SIZE_FRAMES))).toEqual([[], [], []]);
      expect(terminals.map((terminal) => core.size(terminal))).toEqual(before);
      expect(before[1]).toBe("120x40");
    }
  });

  it("host focus-in takes nothing", async () => {
    const { core, stage, screen, t } = await scene();
    const browser = stage.rival();
    await browser.attach(t, 120, 40);
    browser.type("x");
    await stage.live(screen, [t, 80, 24]);
    core.program(t).output("\x1b[?1004h");
    await stage.settle();
    // the host terminal loses and gains focus (the user comes back to the window)
    screen.panes.hostFocus(false);
    screen.panes.hostFocus(false);
    screen.panes.hostFocus(true);
    await stage.advance(10_000);
    // the focused pane's program hears it, as automatic input; nothing else leaves and the size is the browser's
    expect(screen.sent(t)).toEqual(["AUTOMATIC_INPUT 1b5b4f", "AUTOMATIC_INPUT 1b5b49"]);
    expect([core.size(t), screen.attaches.length]).toEqual(["120x40", 1]);

    const old = await scene(OLD);
    const other = old.stage.rival();
    await other.attach(old.t, 120, 40);
    other.type("x");
    await old.stage.live(old.screen, [old.t, 80, 24]);
    old.core.program(old.t).output("\x1b[?1004h");
    await old.stage.settle();
    old.screen.panes.hostFocus(false);
    old.screen.panes.hostFocus(true);
    await old.stage.advance(10_000);
    expect([old.screen.sent(old.t), old.core.size(old.t)]).toEqual([[], "120x40"]);
  });

  it("sends changed FACTS without another key or a size take on both cores", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      screen.panes.setDisplay({ fg: "#123456", bg: "#abcdef", cell: [9, 20] });
      await stage.live(screen, [t, 80, 24]);
      screen.panes.setDisplay({ fg: "#123456", bg: "#234567", cell: [9, 20] });
      screen.panes.setDisplay({ fg: "#123456", bg: "#234567", cell: [9, 20] });
      await stage.settle();
      expect(screen.sent(t)).toEqual(['FACTS {"fg":"#123456","bg":"#234567","cell":[9,20]}']);
      expect(core.size(t)).toBe("80x24");
      expect(screen.attaches).toHaveLength(1);
    }
  });

  it("FACTS beside an active viewer leaves its size alone", async () => {
    const { core, stage, screen, t } = await scene();
    screen.panes.setDisplay({ fg: "#ffffff", bg: "#000000" });
    await stage.live(screen, [t, 80, 24]);
    expect(screen.asked(t)[0]).toMatchObject({ display: { fg: "#ffffff", bg: "#000000" }, resumed: true });
    const browser = stage.rival();
    await browser.attach(t, 120, 40);
    browser.type("x");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    // the host's colours change while the other viewer drives the terminal
    screen.panes.setDisplay({ fg: "#000000", bg: "#ffffff" });
    await stage.advance(10_000);
    await stage.pass();
    const update = `FACTS ${JSON.stringify({ fg: "#000000", bg: "#ffffff" })}`;
    expect([screen.sent(t), core.size(t)]).toEqual([[update], "120x40"]);
    // the user's own input makes this screen the active viewer; it need not repeat the facts
    screen.type("ab");
    expect(screen.sent(t)).toEqual([update, "RESIZE 80x24", "DATA 61", "DATA 62"]);
  });
});

describe("a pane forgets what no longer waits", () => {
  it("a rectangle that came back inside the wait leaves nothing behind", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      screen.show([t, 90, 24]);
      await stage.advance(50);
      screen.show([t, 80, 24]);
      await stage.advance(5_000);
      expect(asked(screen, t)).toEqual(["80x24"]);
      // five seconds later another viewer takes the terminal: one repaint at its size, and that is all
      const rival = stage.rival();
      await rival.attach(t, 120, 40);
      rival.type("x");
      await stage.settle();
      await rest(stage);
      expect([asked(screen, t), screen.view(t).advertised, core.size(t)]).toEqual([["80x24", "120x40"], { cols: 120, rows: 40 }, "120x40"]);
    }
  });

  it("two idle screens settle after a rectangle flickered", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen: first, t } = await scene(options);
      const second = await stage.screen();
      second.panes.focus(t);
      await stage.live(first, [t, 80, 24]);
      first.show([t, 81, 24]);
      await stage.advance(50);
      first.show([t, 80, 24]);
      await stage.advance(5_000);
      await stage.live(second, [t, 120, 40]);
      const seen: string[] = [];
      await rest(stage, () => seen.push(`${traffic(core).attaches}/${core.size(t)}`));
      // nobody typed: the terminal keeps the size of the screen that attached last, and no attach follows the one repaint
      expect(seen).toEqual(Array(10).fill("3/120x40"));
      expect([asked(first, t), asked(second, t), core.events(t, "size")]).toEqual([["80x24", "120x40"], ["120x40"], ["size 80x24", "size 120x40"]]);
      expect([first.view(t).sizedBy, second.view(t).sizedBy]).toEqual([{ cols: 120, rows: 40 }, null]);
    }
  });

  it("a take inside the wait leaves nothing behind", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      screen.show([t, 100, 30]);
      await stage.advance(50);
      expect(screen.type("k")).toEqual([{ sent: true }]);
      await stage.advance(5_000);
      expect([asked(screen, t), core.size(t)]).toEqual([["80x24"], "100x30"]);
      const rival = stage.rival();
      await rival.attach(t, 120, 40);
      rival.type("x");
      await stage.settle();
      await rest(stage);
      // one attach more, the repaint, not two
      expect([asked(screen, t), screen.view(t).advertised, core.size(t)]).toEqual([["80x24", "120x40"], { cols: 120, rows: 40 }, "120x40"]);
    }
  });

  it("a size event that was undone inside the wait leaves nothing behind", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const rival = stage.rival();
    await rival.attach(t, 120, 40);
    rival.type("x");
    await stage.settle();
    await rest(stage);
    expect([asked(screen, t), screen.view(t).advertised]).toEqual([["80x24", "120x40"], { cols: 120, rows: 40 }]);
    // the other viewer resizes, and 50 ms later it is back at the pane's own rectangle
    rival.resize(100, 30);
    await stage.settle();
    await stage.advance(50);
    rival.resize(80, 24);
    await stage.settle();
    await stage.advance(5_000);
    await stage.pass();
    expect([asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual([["80x24", "120x40"], "80x24", null]);
    // the host is resized to what the channel already advertises: no repaint is owed for a size event long undone
    screen.show([t, 120, 40]);
    await rest(stage);
    expect([asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual([["80x24", "120x40"], "80x24", { cols: 80, rows: 24 }]);
  });

  it("a repaint that waits is not owed to a new shell", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const rival = stage.rival();
    await rival.attach(t, 120, 40);
    rival.type("x");
    await stage.settle();
    // the repaint begins, and the core's answer to its CLOSE is still out when the shell dies and a new one starts
    screen.faults.holdCloses = true;
    await stage.advance(REATTACH_SETTLE_MS);
    expect([screen.state(t), asked(screen, t)]).toEqual(["Closing", ["80x24"]]);
    core.lose(t);
    core.restartTerminal(t);
    await stage.settle();
    screen.release();
    await stage.settle();
    await stage.pass();
    // the new shell's pane is attached with its rectangle, as any first attach, and alone it fits
    expect([screen.state(t), asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual(["Live", ["80x24", "80x24"], "80x24", null]);
  });

  it("a repaint that waits is not owed to a new line, to a pane shown again or to a new shell", async () => {
    const line = await scene();
    await line.stage.live(line.screen, [line.t, 80, 24]);
    const rival = line.stage.rival();
    await rival.attach(line.t, 120, 40);
    rival.type("x");
    await line.stage.settle();
    expect(line.screen.panes.deadlines().has("reattach")).toBe(true);
    // the line ends before the repaint is due: on the next line the pane attaches with its rectangle, as any first attach
    line.core.restart();
    await line.stage.settle();
    expect(line.screen.view(line.t).advertised).toBeNull();
    const waiting = line.screen.link.state;
    if (waiting.kind !== "Offline" || waiting.retryAt === null) throw new Error(`the link is ${waiting.kind}`);
    await line.stage.advance(waiting.retryAt - line.stage.clock.now);
    await line.stage.pass();
    expect([line.screen.state(line.t), asked(line.screen, line.t), line.core.size(line.t)]).toEqual(["Live", ["80x24", "80x24"], "80x24"]);

    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const other = stage.rival();
    await other.attach(t, 120, 40);
    other.type("x");
    await stage.settle();
    // the pane leaves the tab and is back before the core answered its CLOSE
    screen.show();
    screen.show([t, 80, 24]);
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual(["Live", ["80x24", "80x24"], "120x40", { cols: 120, rows: 40 }]);
    await rest(stage);
    expect(asked(screen, t)).toEqual(["80x24", "80x24"]);

    // a new shell is announced with no loss before it: an order the core does not send today, and still a first attach
    const shell = await scene();
    await shell.stage.live(shell.screen, [shell.t, 80, 24]);
    const third = shell.stage.rival();
    await third.attach(shell.t, 120, 40);
    third.type("x");
    await shell.stage.settle();
    shell.core.emit("restarted", shell.t, shell.core.terminal(shell.t));
    await shell.stage.settle();
    await shell.stage.pass();
    expect([shell.screen.state(shell.t), asked(shell.screen, shell.t)]).toEqual(["Live", ["80x24", "80x24"]]);
  });

  it("the program of a new core is told the focus anew", async () => {
    const { core, stage, screen, t } = await scene();
    core.setPaint(t, { body: "\x1b[?1004h" });
    await stage.live(screen, [t, 80, 24]);
    expect(screen.sent(t)).toEqual(["AUTOMATIC_INPUT 1b5b49"]);
    // the core is stopped; another comes up with a terminal at the same address, whose program asks for focus reports too
    core.stop();
    await stage.settle();
    const next = new FakeHcCore();
    const again = next.spawn().address;
    next.setPaint(again, { body: "\x1b[?1004h" });
    stage.core = next;
    const waiting = screen.link.state;
    if (waiting.kind !== "Offline" || waiting.retryAt === null) throw new Error(`the link is ${waiting.kind}`);
    await stage.advance(waiting.retryAt - stage.clock.now);
    await stage.pass();
    expect([again, screen.state(again), screen.sent(again), next.program(again).receivedHex()]).toEqual([t, "Live", ["AUTOMATIC_INPUT 1b5b49"], "1b5b49"]);
  });
});

// A repaint never changes the terminal's size, and one that has nothing to repaint is not made. The size of a terminal nobody
// views (HEADLESS, 200x120) is what the pane's own CLOSE leaves behind when this screen is the only viewer: nobody chose it, so a
// pane never advertises it, keeps it or shows it.
describe("a repaint changes no terminal's size", () => {
  const headless = `${HEADLESS.cols}x${HEADLESS.rows}`;
  const big = { cols: 120, rows: 40 };
  /** what a screen left alone does over ten deadline steps: the attaches the core saw, the terminal's size and its viewers, per step */
  const alone = async (stage: Stage, core: FakeHcCore, terminal: string) => {
    const seen: string[] = [];
    await rest(stage, () => seen.push(`${traffic(core).attaches}/${core.size(terminal)}/${core.viewers(terminal).length}`));
    return seen;
  };
  const sizes = (view: PaneView) => [view.actual, view.advertised, view.sizedBy];
  /** the user's next input is where a pane left alone gets its rectangle back: RESIZE first, no attach */
  const takesBack = async (stage: Stage, core: FakeHcCore, screen: Screen, terminal: string, focusFirst: boolean) => {
    const attaches = screen.attaches.length;
    expect(screen.type("k")).toEqual([{ sent: true }]);
    await stage.settle();
    await rest(stage);
    expect(screen.sent(terminal, SIZE_FRAMES)).toEqual(["RESIZE 80x24", ...(focusFirst ? ["FOCUS 1"] : []), "DATA 6b"]);
    expect([core.size(terminal), screen.view(terminal).sizedBy, screen.attaches.length - attaches]).toEqual(["80x24", null, 0]);
  };

  it("the other viewer took the pane's own size and left: nothing is repainted, and the terminal keeps what this attach advertises", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      // another client drives the terminal at 120x40: the pane repaints once and advertises that size
      const rival = stage.rival();
      await rival.attach(t, 120, 40);
      await stage.settle();
      await rest(stage);
      expect(asked(screen, t)).toEqual(["80x24", "120x40"]);
      // it takes the pane's own size: nothing to repaint
      rival.resize(80, 24);
      await stage.settle();
      await rest(stage);
      // it leaves: the core hands the terminal to the one viewer left, at the 120x40 its attach advertises
      await rival.detach();
      await stage.settle();
      expect(await alone(stage, core, t)).toEqual(Array(10).fill("3/120x40/1"));
      expect([asked(screen, t), core.events(t, "size")]).toEqual([["80x24", "120x40"], ["size 80x24", "size 120x40", "size 80x24", "size 120x40"]]);
      expect([core.events(t, "size").includes(`size ${headless}`), screen.sent(t, SIZE_FRAMES)]).toEqual([false, []]);
      // drawn clipped at the size the other viewer chose, until the user types here
      expect([screen.state(t), ...sizes(screen.view(t))]).toEqual(["Live", big, big, big]);
      await takesBack(stage, core, screen, t, "version" in options);
    }
  });

  it("two idle screens, one takes the other's size and leaves: the one left repaints nothing", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen: a, t } = await scene(options);
      const b = await stage.screen();
      b.panes.focus(t);
      await stage.live(a, [t, 80, 24]);
      await stage.live(b, [t, 120, 40]);
      await rest(stage);
      // the second screen's window becomes 80x24, then it leaves the tab
      b.show([t, 80, 24]);
      await rest(stage);
      expect([asked(a, t), asked(b, t), core.size(t)]).toEqual([["80x24", "120x40"], ["120x40", "80x24"], "80x24"]);
      b.show();
      await stage.settle();
      expect(await alone(stage, core, t)).toEqual(Array(10).fill("4/120x40/1"));
      expect([asked(a, t), core.events(t, "size")]).toEqual([["80x24", "120x40"], ["size 80x24", "size 120x40", "size 80x24", "size 120x40"]]);
      expect([a.state(t), ...sizes(a.view(t))]).toEqual(["Live", big, big, big]);
      await takesBack(stage, core, a, t, "version" in options);
    }
  });

  it("the other viewer resized and left while the pane was under a zoom: nothing waits when the zoom ends", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      const rival = stage.rival();
      await rival.attach(t, 120, 40);
      await stage.settle();
      await rest(stage);
      expect(asked(screen, t)).toEqual(["80x24", "120x40"]);
      screen.show([t, 80, 24, true]);
      rival.resize(100, 30);
      await stage.settle();
      await stage.advance(2 * REATTACH_SETTLE_MS);
      await rival.detach();
      await stage.settle();
      await stage.advance(2 * REATTACH_SETTLE_MS);
      screen.show([t, 80, 24]);
      expect(await alone(stage, core, t)).toEqual(Array(10).fill("3/120x40/1"));
      expect([asked(screen, t), core.events(t, "size")]).toEqual([["80x24", "120x40"], ["size 80x24", "size 120x40", "size 100x30", "size 120x40"]]);
      expect([screen.state(t), ...sizes(screen.view(t))]).toEqual(["Live", big, big, big]);
      await takesBack(stage, core, screen, t, "version" in options);
    }
  });

  it("a repaint by the only viewer left puts the terminal back where it was when the repaint was decided", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      const rival = stage.rival();
      await rival.attach(t, 120, 40);
      await stage.settle();
      // the repaint is decided at 120x40; the other viewer leaves before the core's answer to the pane's CLOSE is in
      screen.faults.holdCloses = true;
      await stage.advance(REATTACH_SETTLE_MS);
      expect([screen.state(t), core.size(t)]).toEqual(["Closing", "120x40"]);
      await rival.detach();
      await stage.settle();
      // nobody views the terminal: that size is neither kept nor shown
      expect([core.size(t), core.viewers(t).length, ...sizes(screen.view(t))]).toEqual([headless, 0, big, { cols: 80, rows: 24 }, big]);
      screen.release();
      await stage.settle();
      await stage.pass();
      expect(await alone(stage, core, t)).toEqual(Array(10).fill("3/120x40/1"));
      expect([asked(screen, t), core.events(t, "size")]).toEqual([["80x24", "120x40"], ["size 80x24", "size 120x40", `size ${headless}`, "size 120x40"]]);
      expect([screen.state(t), ...sizes(screen.view(t)), screen.sent(t, SIZE_FRAMES)]).toEqual(["Live", big, big, big, []]);
      await takesBack(stage, core, screen, t, "version" in options);
    }
  });

  it("a window resize by the only viewer passes the terminal through the size nobody chose, and the pane never shows it", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    screen.faults.holdCloses = true;
    screen.show([t, 90, 30]);
    await stage.advance(REATTACH_SETTLE_MS);
    // between the pane's CLOSE and its attach nobody views the terminal; the pane keeps the size of the picture it still shows
    expect([screen.state(t), core.size(t), screen.view(t).actual, screen.view(t).sizedBy]).toEqual(["Closing", headless, { cols: 80, rows: 24 }, { cols: 80, rows: 24 }]);
    screen.release();
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual(["Live", ["80x24", "90x30"], "90x30", null]);
    // what it costs: the program is resized twice for the one window resize
    expect(core.program(t).sizes.slice(-3)).toEqual(["80x24", headless, "90x30"]);
    await rest(stage);
    expect(asked(screen, t)).toEqual(["80x24", "90x30"]);
  });

  it("a size event behind the first bytes of an attach is newer than its reply, and the pane takes it", async () => {
    const { core, stage, screen, t } = await scene();
    const rival = stage.rival();
    await rival.attach(t, 120, 40);
    screen.faults.holdReplies = true;
    screen.show([t, 80, 24]);
    await stage.settle();
    // the reply, which says 120x40, is still out and the first paint is in when the other viewer resizes
    expect([screen.state(t), screen.attaches[0]!.reply, screen.attaches[0]!.received.length > 0]).toEqual(["Opening", "120x40", true]);
    rival.resize(100, 30);
    await stage.settle();
    screen.release();
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), screen.view(t).actual, core.size(t)]).toEqual(["Live", { cols: 100, rows: 30 }, "100x30"]);
    // the first paint was drawn for 120x40: one repaint at the size the terminal has now
    await rest(stage);
    expect([asked(screen, t), screen.emulators.at(-1)!.cols, core.size(t)]).toEqual([["80x24", "100x30"], 100, "100x30"]);
  });

  it("the size a pane's own CLOSE left behind is not advertised when it is heard after the core's answer either", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const rival = stage.rival();
    await rival.attach(t, 120, 40);
    await stage.settle();
    // the repaint's attach is on its way (its emulator is being made) when a `size` event names the size of a terminal nobody views
    let told = 0;
    screen.hooks.notice = () => {
      if (screen.state(t) !== "Opening" || screen.attaches.length !== 1 || told++ > 0) return;
      screen.panes.notice({ type: "event", epoch: 1, seq: null, event: { type: "size", terminal: t, data: { ...HEADLESS } }, changes: [] });
    };
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    expect(told).toBeGreaterThan(0);
    expect([screen.state(t), asked(screen, t), core.size(t), ...sizes(screen.view(t))]).toEqual(["Live", ["80x24", "120x40"], "120x40", big, big, big]);
  });
});

// What a repaint advertises is the size the last viewer chose, also when that choice fell between the pane's CLOSE and its next
// attach (the gap) or while that attach was on its way. herdr-core tells a line every change of a terminal's size in the order it
// made them, and the event for the size an attach itself set never ahead of that attach's reply (core.fake.live.test.ts "k2").
describe("a repaint advertises the size the last viewer chose", () => {
  const headless = `${HEADLESS.cols}x${HEADLESS.rows}`;
  /** a `size` event as the link hands one over, made by hand: one the core would not send that way */
  const told = (screen: Screen, terminal: string, data: Record<string, unknown>) => screen.panes.notice({ type: "event", epoch: 1, seq: null, event: { type: "size", terminal, data }, changes: [] });
  /** ten deadline steps: the attaches the core saw and the terminal's size at each */
  const steady = async (stage: Stage, core: FakeHcCore, terminal: string) => {
    const seen: string[] = [];
    await rest(stage, () => seen.push(`${traffic(core).attaches}/${core.size(terminal)}`));
    return seen;
  };
  /** a pane live at 80x24 beside another viewer at 120x40, its repaint begun: the CLOSE is out and the core's answer held */
  const inGap = async (options: FakeCoreOptions, resumed: boolean) => {
    const made = await scene(options);
    await made.stage.live(made.screen, [made.t, 80, 24]);
    const rival = made.stage.rival();
    await rival.attach(made.t, 120, 40, resumed);
    await made.stage.settle();
    made.screen.faults.holdCloses = true;
    await made.stage.advance(REATTACH_SETTLE_MS);
    expect([made.screen.state(made.t), asked(made.screen, made.t), made.core.size(made.t)]).toEqual(["Closing", ["80x24"], "120x40"]);
    return { ...made, rival };
  };

  it("two idle screens, one window changes twice 150 ms apart: the terminal rests at its last rectangle, whichever screen acts first", async () => {
    for (const options of [{}, OLD]) {
      for (const order of ["the changing screen fires first", "the repainting screen fires first"]) {
        const core = new FakeHcCore(options);
        const stage = new Stage(core);
        stages.push(stage);
        const t = core.spawn().address;
        // the stage fires its screens in the order they were made
        const made = [await stage.screen(), await stage.screen()] as const;
        const [b, a] = order === "the changing screen fires first" ? made : [made[1], made[0]];
        a.panes.focus(t);
        b.panes.focus(t);
        await stage.live(a, [t, 80, 24]);
        await stage.live(b, [t, 120, 40]);
        await rest(stage);
        expect([asked(a, t), core.size(t)]).toEqual([["80x24", "120x40"], "120x40"]);
        // b's window changes; 150 ms later b attaches with 100x30, a hears of it, and b's window changes once more
        b.show([t, 100, 30]);
        await stage.advance(REATTACH_SETTLE_MS);
        b.show([t, 110, 35]);
        // both are due in one turn of the clock: a's repaint for 100x30 and b's attach with 110x35
        await stage.advance(REATTACH_SETTLE_MS);
        await stage.pass();
        const seen = await steady(stage, core, t);
        // b attached with its own rectangle last: the terminal keeps it, a draws it clipped with the notice, and no attach follows
        expect(seen).toEqual(Array(10).fill(`${traffic(core).attaches}/110x35`));
        expect([core.size(t), core.viewers(t).length, b.view(t).sizedBy, a.view(t).sizedBy, a.view(t).advertised]).toEqual(["110x35", 2, null, { cols: 110, rows: 35 }, { cols: 110, rows: 35 }]);
        expect([asked(b, t), asked(a, t).at(-1), a.state(t), b.state(t)]).toEqual([["120x40", "100x30", "110x35"], "110x35", "Live", "Live"]);
        expect([a.sent(t, SIZE_FRAMES), b.sent(t, SIZE_FRAMES), core.events(t, "size").at(-1)]).toEqual([[], [], "size 110x35"]);
      }
    }
  });

  it("an idle viewer attaches again with a new size inside the pane's gap: that size stays", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, true);
      await rival.detach();
      await rival.attach(t, 100, 30, true);
      await stage.settle();
      // the pane still shows the picture it had: what it heard in the gap is neither its grid nor its notice
      expect([core.size(t), screen.view(t).actual, screen.view(t).sizedBy]).toEqual(["100x30", { cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);
      screen.release();
      await stage.settle();
      await stage.pass();
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("4/100x30"));
      expect([asked(screen, t), core.events(t, "size")]).toEqual([["80x24", "100x30"], ["size 80x24", "size 120x40", `size ${headless}`, "size 100x30"]]);
      expect([screen.state(t), screen.view(t).sizedBy, screen.view(t).advertised, screen.sent(t, SIZE_FRAMES)]).toEqual(["Live", { cols: 100, rows: 30 }, { cols: 100, rows: 30 }, []]);
    }
  });

  it("a viewed size heard inside the gap is not awaited as the repaint's own event: the other viewer taking another size and leaving makes nothing attach again", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, true);
      // the other viewer chooses 110x35 inside the gap, and the pane's repaint advertises it: an attach that changes nothing
      await rival.detach();
      await rival.attach(t, 110, 35, true);
      await stage.settle();
      screen.release();
      await stage.settle();
      expect([asked(screen, t), core.size(t)]).toEqual([["80x24", "110x35"], "110x35"]);
      // no frame pass: the repaint is in use and not shown yet when the other viewer takes another size and leaves. The core hands
      // the terminal to the pane at the 110x35 its attach advertises: that event is no sign that the repaint took the terminal
      // from a choice, so the 100x30 the viewer left behind is not attached for
      await rival.detach();
      await rival.attach(t, 100, 30, true);
      await stage.settle();
      await rival.detach();
      await stage.settle();
      await stage.pass();
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("5/110x35"));
      expect([asked(screen, t), core.viewers(t).length, screen.state(t), screen.sent(t, SIZE_FRAMES)]).toEqual([["80x24", "110x35"], 1, "Live", []]);
      expect(core.events(t, "size").slice(-3)).toEqual(["size 110x35", "size 100x30", "size 110x35"]);
    }
  });

  it("a driving viewer's resize inside the gap stays, and the repaint advertises it", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, false);
      rival.resize(100, 30);
      await stage.settle();
      screen.release();
      await stage.settle();
      await stage.pass();
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("3/100x30"));
      expect([asked(screen, t), screen.attaches.at(-1)!.reply, screen.view(t).sizedBy, core.events(t, "size").at(-1)]).toEqual([["80x24", "100x30"], "100x30", { cols: 100, rows: 30 }, "size 100x30"]);
    }
  });

  it("a viewer that resizes and leaves inside the gap: the terminal ends at the size it chose last", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, false);
      rival.resize(100, 30);
      await rival.detach();
      await stage.settle();
      expect([core.size(t), core.viewers(t).length]).toEqual([headless, 0]);
      screen.release();
      await stage.settle();
      await stage.pass();
      // alone, the repaint puts the terminal at the last size a viewer chose, not at the one before it and never at 200x120
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("3/100x30"));
      expect([asked(screen, t), core.viewers(t).length, screen.view(t).sizedBy, core.events(t, "size").slice(-3)]).toEqual([["80x24", "100x30"], 1, { cols: 100, rows: 30 }, ["size 100x30", `size ${headless}`, "size 100x30"]]);
      // the user's next input takes the rectangle back
      expect(screen.type("k")).toEqual([{ sent: true }]);
      await stage.settle();
      expect([core.size(t), screen.sent(t, [FRAME_RESIZE])]).toEqual(["80x24", ["RESIZE 80x24"]]);
    }
  });

  it("a size chosen while the repaint was on its way is heard before its reply: the repaint is made again at once, with that size", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      const rival = stage.rival();
      await rival.attach(t, 120, 40, true);
      await stage.settle();
      // the other idle viewer attaches again at 100x30, and the events of it are still on their way when the repaint leaves
      screen.faults.holdSizes = true;
      await rival.detach();
      await rival.attach(t, 100, 30, true);
      await stage.settle();
      screen.hooks.attach = () => {
        screen.hooks.attach = undefined;
        screen.sizes();
      };
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      // it advertised 120x40 and took the terminal; the core's event for that told it so, and it gave the terminal back at once
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("5/100x30"));
      expect([asked(screen, t), core.events(t, "size").slice(-3), screen.view(t).sizedBy]).toEqual([["80x24", "120x40", "100x30"], ["size 100x30", "size 120x40", "size 100x30"], { cols: 100, rows: 30 }]);
      expect([screen.state(t), screen.sent(t, SIZE_FRAMES), screen.did(t)]).toEqual(["Live", [], ["CLOSE", "CLOSE"]]);
    }
  });

  it("another screen that repainted at the size a repaint is taking back does not make that repaint copy it", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      const rival = stage.rival();
      await rival.attach(t, 120, 40, true);
      await stage.settle();
      screen.faults.holdSizes = true;
      await rival.detach();
      await rival.attach(t, 100, 30, true);
      await stage.settle();
      // the repaint leaves with 120x40 as the choice of 100x30 reaches it; the core's answer to the CLOSE that takes it back is held
      screen.hooks.attach = () => {
        screen.hooks.attach = undefined;
        screen.sizes();
        screen.faults.holdCloses = true;
      };
      await stage.advance(REATTACH_SETTLE_MS);
      expect([screen.state(t), asked(screen, t), core.size(t)]).toEqual(["Closing", ["80x24", "120x40"], "100x30"]);
      // a third viewer that only views repaints meanwhile at the 120x40 it had heard, as a second screen would 150 ms later
      const copy = stage.rival();
      await copy.attach(t, 120, 40, true);
      await stage.settle();
      expect(core.size(t)).toBe("120x40");
      screen.release();
      await stage.settle();
      await stage.pass();
      // the pane takes the terminal back for the viewer whose choice it was
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("6/100x30"));
      expect([asked(screen, t), screen.view(t).sizedBy, core.events(t, "size").slice(-2)]).toEqual([["80x24", "120x40", "100x30"], { cols: 100, rows: 30 }, ["size 120x40", "size 100x30"]]);
    }
  });

  it("a repaint that left a terminal nobody viewed hears a newer choice only behind its reply: made again at once", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, true);
      // the other idle viewer leaves inside the gap, which the pane hears, and attaches again at 100x30, which it hears late
      await rival.detach();
      await stage.settle();
      screen.faults.holdSizes = true;
      await rival.attach(t, 100, 30, true);
      await stage.settle();
      screen.release();
      await stage.settle();
      expect([asked(screen, t), core.size(t), screen.state(t)]).toEqual([["80x24", "120x40"], "120x40", "Painting"]);
      // behind the reply and ahead of the repaint's own event: what the core said before it applied the repaint
      screen.sizes();
      await stage.settle();
      await stage.pass();
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("5/100x30"));
      expect([asked(screen, t), screen.view(t).sizedBy, core.events(t, "size").slice(-3)]).toEqual([["80x24", "120x40", "100x30"], { cols: 100, rows: 30 }, ["size 100x30", "size 120x40", "size 100x30"]]);
    }
  });

  it("a choice newer still, heard behind the repaint's own event before its reply was handed over, is the one the repaint is made again with", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, true);
      await rival.detach();
      await stage.settle();
      screen.faults.holdSizes = true;
      await rival.attach(t, 100, 30, true);
      await stage.settle();
      // the CLOSE answer is let through and the repaint leaves with 120x40; its reply is held, with the stream's first bytes in
      screen.release();
      screen.faults.holdReplies = true;
      await stage.settle();
      expect([screen.state(t), asked(screen, t), core.size(t), screen.attaches.at(-1)!.received.length > 0]).toEqual(["Opening", ["80x24", "120x40"], "120x40", true]);
      // behind those bytes: the choice of 100x30, the repaint's own event, and then the other viewer's next choice, 110x35
      screen.sizes();
      await rival.detach();
      await rival.attach(t, 110, 35, true);
      await stage.settle();
      expect(core.size(t)).toBe("110x35");
      screen.release();
      await stage.settle();
      await stage.pass();
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("6/110x35"));
      expect([asked(screen, t), screen.view(t).sizedBy, screen.state(t)]).toEqual([["80x24", "120x40", "110x35"], { cols: 110, rows: 35 }, "Live"]);
    }
  });

  it("another viewer that comes and goes while a repaint is not shown yet makes nothing happen again", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, true);
      screen.release();
      await stage.settle();
      // the repaint advertised 120x40 beside the idle viewer and changed nothing; no frame pass has drawn it yet
      expect([screen.state(t), asked(screen, t), core.size(t)]).toEqual(["Painting", ["80x24", "120x40"], "120x40"]);
      await rival.detach();
      await rival.attach(t, 100, 30, true);
      await stage.settle();
      await rival.detach();
      await stage.settle();
      // the core handed the terminal back at what this attach advertises: that is no sign of this repaint's doing
      expect([core.size(t), core.events(t, "size").slice(-2), asked(screen, t)]).toEqual(["120x40", ["size 100x30", "size 120x40"], ["80x24", "120x40"]]);
      await stage.pass();
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("4/120x40"));
      expect([asked(screen, t), screen.state(t), core.viewers(t).length]).toEqual([["80x24", "120x40"], "Live", 1]);
    }
  });

  it("the one order left open: a choice overtaken by the reply of a repaint that left beside another viewer is not seen", async () => {
    // herdr-core lets an attach's reply overtake the event of a change made just before it: beside an idle viewer that stays, in 683
    // of 1,197 (hc 0.1.18) and 695 of 1,195 (hc 0.1.17) races where two attaches were written in one turn and the other was applied
    // first, and in 245 of 1,197 and 594 of 1,199 in an independent run (docs/tui/parity.md has the other rates). Such an event
    // behind the reply reads like that viewer coming and going (the case above), so the repaint is not made again: the terminal
    // keeps the older size until the next input
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const rival = stage.rival();
    await rival.attach(t, 120, 40, true);
    await stage.settle();
    screen.faults.holdSizes = true;
    await rival.detach();
    await rival.attach(t, 100, 30, true);
    await stage.settle();
    await stage.advance(REATTACH_SETTLE_MS);
    screen.sizes();
    await stage.settle();
    await stage.pass();
    expect(await steady(stage, core, t)).toEqual(Array(10).fill("4/120x40"));
    expect([asked(screen, t), core.viewers(t).map((viewer) => `${viewer.cols}x${viewer.rows}`)]).toEqual([["80x24", "120x40"], ["100x30", "120x40"]]);
    // it ends with the next input or the next change of a window, as before
    rival.type("x");
    await stage.settle();
    await rest(stage);
    expect([core.size(t), asked(screen, t).at(-1)]).toEqual(["100x30", "100x30"]);
  });

  it("the size of a terminal nobody views is not chosen when it is heard behind a lone repaint's reply", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t, rival } = await inGap(options, false);
      // the other viewer leaves in the gap, and the event of it reaches the pane only after its repaint's reply
      screen.faults.holdSizes = true;
      await rival.detach();
      await stage.settle();
      screen.release();
      await stage.settle();
      expect([asked(screen, t), core.size(t), screen.state(t)]).toEqual([["80x24", "120x40"], "120x40", "Painting"]);
      screen.sizes();
      await stage.settle();
      await stage.pass();
      expect(await steady(stage, core, t)).toEqual(Array(10).fill("3/120x40"));
      expect([asked(screen, t), screen.view(t).actual, screen.view(t).sizedBy, core.viewers(t).length]).toEqual([["80x24", "120x40"], { cols: 120, rows: 40 }, { cols: 120, rows: 40 }, 1]);
    }
  });

  it("a viewer that really chose 200x120 is followed on a shown attach and beside a driver; an idle one inside the gap cannot be told from nobody", async () => {
    // on a shown attach the pane itself views the terminal: 200x120 is that viewer's size, repainted and named like any other
    const shown = await scene();
    await shown.stage.live(shown.screen, [shown.t, 80, 24]);
    const driver = shown.stage.rival();
    await driver.attach(shown.t, HEADLESS.cols, HEADLESS.rows);
    await shown.stage.settle();
    await rest(shown.stage);
    expect([asked(shown.screen, shown.t), shown.core.size(shown.t), shown.screen.view(shown.t).sizedBy, shown.screen.state(shown.t)]).toEqual([["80x24", headless], headless, { ...HEADLESS }, "Live"]);

    // inside the gap a driving viewer takes 200x120: the repaint does not advertise it, the reply names it, and the pane shows it
    const driven = await inGap({}, false);
    driven.rival.resize(HEADLESS.cols, HEADLESS.rows);
    await driven.stage.settle();
    driven.screen.release();
    await driven.stage.settle();
    await driven.stage.pass();
    expect(await steady(driven.stage, driven.core, driven.t)).toEqual(Array(10).fill(`3/${headless}`));
    expect([asked(driven.screen, driven.t), driven.screen.attaches.at(-1)!.reply, driven.screen.view(driven.t).sizedBy]).toEqual([["80x24", "120x40"], headless, { ...HEADLESS }]);

    // inside the gap an idle viewer attaches at exactly 200x120: the core's record is the one of a terminal nobody views, field for
    // field, so the repaint advertises the size before it and that viewer loses its size until someone types or resizes
    const idle = await inGap({}, true);
    await idle.rival.detach();
    await idle.rival.attach(idle.t, HEADLESS.cols, HEADLESS.rows, true);
    await idle.stage.settle();
    expect([idle.core.size(idle.t), idle.core.viewers(idle.t).length]).toEqual([headless, 1]);
    idle.screen.release();
    await idle.stage.settle();
    await idle.stage.pass();
    expect(await steady(idle.stage, idle.core, idle.t)).toEqual(Array(10).fill("4/120x40"));
    expect([asked(idle.screen, idle.t), idle.core.viewers(idle.t).map((viewer) => `${viewer.cols}x${viewer.rows}`)]).toEqual([["80x24", "120x40"], [headless, "120x40"]]);
  });

  it("a size event that names no size is ignored inside the gap, and a size no emulator takes fails the pane until the size comes back", async () => {
    const { core, stage, screen, t, rival } = await inGap({}, false);
    for (const data of [{ cols: 0, rows: 0 }, { cols: 100.5, rows: 30 }, { cols: "100", rows: "30" }, { cols: -5, rows: 30 }, { rows: 30 }, {}]) told(screen, t, data);
    screen.release();
    await stage.settle();
    await stage.pass();
    expect([asked(screen, t), core.size(t), screen.state(t)]).toEqual([["80x24", "120x40"], "120x40", "Live"]);
    // the driving viewer takes a size no emulator can be made for while the pane is in its next gap
    rival.resize(110, 35);
    await stage.settle();
    screen.faults.holdCloses = true;
    await stage.advance(REATTACH_SETTLE_MS);
    rival.resize(1200, 50);
    await stage.settle();
    screen.release();
    await stage.settle();
    expect([screen.state(t), asked(screen, t), core.size(t)]).toEqual(["Failed(size)", ["80x24", "120x40"], "1200x50"]);
    rival.resize(120, 40);
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual(["Live", ["80x24", "120x40", "80x24"], "120x40", { cols: 120, rows: 40 }]);
  });

  it("a size heard inside the gap is not owed to a pane shown again, to a new line or to a new core", async () => {
    // the pane leaves the tab and is back before its repaint's attach left: it attaches with its rectangle, as any pane shown
    const again = await inGap({}, true);
    await again.rival.detach();
    await again.rival.attach(again.t, 100, 30, true);
    await again.stage.settle();
    again.screen.show();
    again.screen.show([again.t, 80, 24]);
    again.screen.release();
    await again.stage.settle();
    await again.stage.pass();
    expect([asked(again.screen, again.t), again.core.size(again.t), again.screen.view(again.t).sizedBy]).toEqual([["80x24", "80x24"], "80x24", null]);

    // the line is lost inside the gap, twice: each new line's attach carries the rectangle, and nothing of the gap is left
    const lost = await inGap({}, false);
    const reconnect = async () => {
      const waiting = lost.screen.link.state;
      if (waiting.kind !== "Offline" || waiting.retryAt === null) throw new Error(`the link is ${waiting.kind}`);
      await lost.stage.advance(waiting.retryAt - lost.stage.clock.now);
      await lost.stage.pass();
    };
    lost.rival.resize(100, 30);
    lost.core.restart();
    await lost.stage.settle();
    await reconnect();
    expect([lost.screen.state(lost.t), asked(lost.screen, lost.t), lost.core.size(lost.t)]).toEqual(["Live", ["80x24", "80x24"], "80x24"]);
    const other = lost.stage.rival();
    await other.attach(lost.t, 120, 40);
    await lost.stage.settle();
    lost.screen.faults.holdCloses = true;
    await lost.stage.advance(REATTACH_SETTLE_MS);
    other.resize(100, 30);
    await lost.stage.settle();
    lost.core.restart();
    await lost.stage.settle();
    await reconnect();
    expect([lost.screen.state(lost.t), asked(lost.screen, lost.t), lost.core.size(lost.t), lost.screen.sent(lost.t, SIZE_FRAMES)]).toEqual(["Live", ["80x24", "80x24", "80x24"], "80x24", []]);

    // the core is stopped inside the gap, and another has a terminal at the same address
    const stopped = await inGap({}, false);
    stopped.rival.resize(100, 30);
    await stopped.stage.settle();
    stopped.core.stop();
    await stopped.stage.settle();
    const next = new FakeHcCore();
    expect(next.spawn().address).toBe(stopped.t);
    stopped.stage.core = next;
    const waiting = stopped.screen.link.state;
    if (waiting.kind !== "Offline" || waiting.retryAt === null) throw new Error(`the link is ${waiting.kind}`);
    await stopped.stage.advance(waiting.retryAt - stopped.stage.clock.now);
    await stopped.stage.pass();
    expect([stopped.screen.state(stopped.t), asked(stopped.screen, stopped.t).at(-1), next.size(stopped.t), stopped.screen.view(stopped.t).sizedBy]).toEqual(["Live", "80x24", "80x24", null]);
  });
});

describe("three screens on one terminal: what holds when two of them repaint in one turn", () => {
  // On the wire another screen's repaint and a viewer's choice are the same resumed attach, so a repaint that hears one ahead of its
  // reply cannot tell which it was: with three screens the terminal can end at an older size (docs/tui/parity.md). What holds is
  // pinned here, in three firing orders of the same sequence: the user types in A (80x24) beside B (110x35) and C (90x28), A's window
  // becomes 100x30, and 150 ms later all three are due in one turn
  const three = async (options: FakeCoreOptions, order: string) => {
    const core = new FakeHcCore(options);
    const stage = new Stage(core);
    stages.push(stage);
    const t = core.spawn().address;
    // the stage fires its screens in the order they were made
    const made = new Map<string, Screen>();
    for (const name of order) made.set(name, await stage.screen());
    const [a, b, c] = ["A", "B", "C"].map((name) => made.get(name)!) as [Screen, Screen, Screen];
    for (const screen of [a, b, c]) screen.panes.focus(t);
    await stage.live(a, [t, 80, 24]);
    await stage.live(b, [t, 110, 35]);
    await stage.live(c, [t, 90, 28]);
    await stage.advance(1);
    a.type("f");
    a.show([t, 100, 30]);
    await stage.settle();
    await stage.advance(REATTACH_SETTLE_MS);
    // the repaints and their corrections come to rest within twelve steps
    for (let step = 0; step < 12; step++) {
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
    }
    return { core, stage, t, a, b, c };
  };
  const rectangles = { A: "100x30", B: "110x35", C: "90x28" } as const;
  const owner = (size: string) => Object.entries(rectangles).find(([, rect]) => rect === size)?.[0] ?? "nobody";

  for (const [order, rests] of [["ACB", "110x35"], ["CAB", "100x30"], ["CBA", "100x30"]] as const) {
    it(`fired ${order}: the terminal rests at ${owner(rests)}'s rectangle ${rests}, never at the size of a terminal nobody views; the wire stays as it is; each screen's next key gives its rectangle back`, async () => {
      for (const options of [{}, OLD]) {
        const { core, stage, t, a, b, c } = await three(options, order);
        // the row's sentence holds in the orders where A fires after another screen: A attached with its rectangle last, 100x30.
        // Where A fires first, B takes C's repaint at B's older 110x35 for a choice and is made again with it: the limit pinned here
        expect([core.size(t), core.viewers(t).length]).toEqual([rests, 3]);
        // and no attach of any screen advertised the size of a terminal nobody views, which all three heard between their CLOSEs
        expect([a, b, c].flatMap((screen) => asked(screen, t))).not.toContain(`${HEADLESS.cols}x${HEADLESS.rows}`);
        expect(core.events(t, "size")).toContain(`size ${HEADLESS.cols}x${HEADLESS.rows}`);
        // nothing attaches again and nothing else is sent for fifty steps
        const wire = () => `${traffic(core).attaches} attaches, ${traffic(core).closes} CLOSE, ${traffic(core).sizes} size events, the terminal ${core.size(t)}`;
        const still = wire();
        for (let step = 0; step < 50; step++) {
          await stage.advance(REATTACH_SETTLE_MS);
          await stage.pass();
          expect(wire()).toBe(still);
        }
        // no RESIZE, FOCUS or FACTS outside the user's input: A sent its key, the others nothing
        expect([a.sent(t, SIZE_FRAMES).filter((frame) => frame !== "FOCUS 1"), b.sent(t, SIZE_FRAMES), c.sent(t, SIZE_FRAMES)]).toEqual([["DATA 66"], [], []]);
        expect([a, b, c].map((screen) => screen.state(t))).toEqual(["Live", "Live", "Live"]);
        // the next key in each screen: RESIZE with its rectangle where its channel advertises another size, then the key; the
        // terminal takes that rectangle
        for (const [name, screen] of [["C", c], ["B", b], ["A", a]] as const) {
          const before = screen.sent(t, SIZE_FRAMES).length;
          const view = screen.view(t);
          const resize = view.advertised && view.advertised.cols === view.wanted.cols && view.advertised.rows === view.wanted.rows ? [] : [`RESIZE ${rectangles[name]}`];
          expect(screen.type("k")).toEqual([{ sent: true }]);
          await stage.settle();
          expect(screen.sent(t, SIZE_FRAMES).slice(before).filter((frame) => frame !== "FOCUS 1")).toEqual([...resize, "DATA 6b"]);
          expect(core.size(t)).toBe(rectangles[name]);
        }
      }
    });
  }
});

describe("the size rules as values", () => {
  /** where herdr-core runs a terminal nobody views */
  const UNVIEWED = HEADLESS;
  const at = (size: PaneSize) => reattachDue(size);
  const attached = (wanted: { cols: number; rows: number }, actual = wanted) => replied(attachSent(newPaneSize(wanted), wanted), actual);
  const A = { cols: 80, rows: 24 };
  const B = { cols: 120, rows: 40 };
  const C = { cols: 100, rows: 30 };

  it("an attach reply alone makes nothing wait, whatever size it reports", () => {
    expect([at(attached(A)), at(attached(A, B))]).toEqual([null, null]);
    expect(sizedBy(attached(A, B))).toEqual(B);
  });

  it("a changed rectangle waits from its last change and attaches with the rectangle", () => {
    const first = rectangleChanged(attached(A), C, 1000);
    const last = rectangleChanged(first, B, 1100);
    expect([at(first), at(last), attachSize(last)]).toEqual([1150, 1250, B]);
    // back to what the channel advertises: nothing waits
    expect(at(rectangleChanged(last, A, 1200))).toBeNull();
    expect(rectangleChanged(last, B, 5000)).toBe(last);
  });

  it("another viewer's size event waits from the last one and repaints at the terminal's own size", () => {
    const one = sizeTold(attached(A), B, 2000);
    const two = sizeTold(one, C, 2100);
    expect([at(one), at(two), attachSize(two), attachSize(attached(A, B))]).toEqual([2150, 2250, C, A]);
    // an event that brings the size back makes nothing wait
    expect(at(sizeTold(two, A, 2200))).toBeNull();
    const repainted = replied(attachSent(two, C), C);
    expect([at(repainted), repainted.advertised, sizedBy(repainted)]).toEqual([null, C, C]);
  });

  it("nothing is repainted when the terminal comes to the size this attach advertises", () => {
    // the pane repainted at B for another viewer, which then took the pane's own size and left: the core fell back to B
    const repainted = replied(attachSent(sizeTold(attached(A), B, 1000), B), B);
    const back = sizeTold(sizeTold(repainted, A, 2000), B, 3000);
    expect([at(back), back.foreignAt, back.actual, sizedBy(back)]).toEqual([null, null, B, B]);
    // any other size still waits, and coming back to the advertised one inside the wait undoes it
    const away = sizeTold(repainted, C, 4000);
    expect([at(away), attachSize(away), at(sizeTold(away, B, 4050))]).toEqual([4150, C, null]);
  });

  it("both causes at once make one attach, with the rectangle; the take ends the wait", () => {
    const both = rectangleChanged(sizeTold(attached(A), B, 3000), C, 3050);
    expect([at(both), attachSize(both)]).toEqual([3200, C]);
    // the user's input ends both waits at once; a later size event of another viewer starts a new one
    const taken = took(both);
    expect([taken.advertised, at(taken), at(sizeTold(taken, C, 3060))]).toEqual([C, null, null]);
    expect(at(sizeTold(taken, B, 3070))).toEqual(3220);
  });

  it("what was told, cancelled or ended no longer waits", () => {
    // the rectangle changed and came back inside the wait; later another viewer resized, and the pane repainted
    const flickered = rectangleChanged(rectangleChanged(attached(A), C, 1000), A, 1050);
    const repainted = replied(attachSent(sizeTold(flickered, B, 2000), B), B);
    expect([at(flickered), flickered.ownAt, at(repainted), repainted.ownAt]).toEqual([null, null, null, null]);
    // the take told the core the rectangle: the same later resize makes one repaint, and nothing after it
    const taken = took(rectangleChanged(attached(A), C, 1000));
    const afterTake = replied(attachSent(sizeTold(taken, B, 6000), B), B);
    expect([taken.ownAt, at(sizeTold(taken, B, 6000)), at(afterTake)]).toEqual([null, 6150, null]);
    // a size event that a later one undid, then a rectangle the channel already advertises
    const undone = sizeTold(sizeTold(repainted, C, 7000), A, 7050);
    expect([undone.foreignAt, at(undone), at(rectangleChanged(undone, B, 9000))]).toEqual([null, null, null]);
    // a rectangle that becomes the terminal's own size owes no repaint any more
    expect(at(rectangleChanged(sizeTold(attached(A), B, 1000), B, 1020))).toEqual(1170);
    expect(rectangleChanged(sizeTold(attached(A), B, 1000), B, 1020).foreignAt).toBeNull();
    // an attach that ended takes its waits with it: the next one starts from the rectangle
    const ended = detached(rectangleChanged(sizeTold(attached(A), B, 1000), C, 1010));
    expect([ended.ownAt, ended.foreignAt, ended.advertised, at(ended), attachSize(ended), at(rectangleChanged(ended, A, 2000))]).toEqual([null, null, null, null, C, null]);
  });

  it("a repaint advertises the last size heard while somebody viewed the terminal, never the size of a terminal nobody views", () => {
    // a repaint is decided at B; inside the gap the pane's own CLOSE leaves the terminal with nobody, then another viewer attaches with C
    const decided = sizeTold(attached(A), B, 1000);
    const alone = sizeHeard(decided, UNVIEWED, 1100, "none");
    const gap = sizeHeard(alone, C, 1110, "none");
    expect([attachSize(decided), attachSize(alone), attachSize(gap)]).toEqual([B, B, C]);
    // what is heard with no attach in use is neither the grid of the picture still shown nor its notice
    expect([gap.actual, sizedBy(gap), alone.chosen]).toEqual([B, B, B]);
    // on a shown attach the pane itself views the terminal: 200x120 is a viewer's size like any other
    expect(attachSize(sizeTold(attached(A), UNVIEWED, 1000))).toEqual(UNVIEWED);
    // an attach with the rectangle is a choice of its own: what was heard on its way is replaced by what its reply names
    const own = replied(sizeHeard(attachSent(rectangleChanged(attached(A), C, 1000), C), B, 1100, "sent"), C);
    expect([own.chosen, overtaken(own, C), at(own)]).toEqual([C, false, null]);
    // what was heard ends with the attach
    expect([detached(gap).chosen, attachSize(detached(gap))]).toEqual([null, A]);
  });

  it("a repaint whose own size took the terminal from a newer choice is owed again at once, with that choice", () => {
    // the repaint left advertising B beside another viewer; C is heard ahead of its reply, so the attach changed the terminal's size
    const sent = attachSent(sizeTold(attached(A), B, 1000), B);
    const answered = replied(sizeHeard(sent, C, 1200, "sent"), B);
    expect([at(answered), answered.chosen, sizedBy(answered), overtaken(answered, B), overtaken(answered, C)]).toEqual([null, C, B, true, false]);
    // the core's event for the size the repaint set says so, on an attach not shown yet or shown: a repaint is owed, advertising C
    for (const told of [sizeHeard(answered, B, 1210, "unshown"), sizeTold(answered, B, 1210)]) expect([told.actual, attachSize(told), at(told), overtaken(told, B)]).toEqual([B, C, 1360, false]);
    // while it is made again, the size it is taking back is not a choice when another screen repaints at it; any other size is
    const back = sizeHeard(sizeHeard(sizeTold(answered, B, 1210), UNVIEWED, 1215, "none"), B, 1220, "none");
    expect([attachSize(back), attachSize(sizeHeard(back, A, 1230, "none")), attachSent(back, C).again]).toEqual([C, A, false]);
    // the repaint's size heard ahead of its reply is not its own event, which the core never sends there: another viewer chose
    // that very size after C, and the repaint changes nothing
    const same = sizeHeard(sizeHeard(sent, C, 1200, "sent"), B, 1201, "sent");
    expect([same.chosen, same.echo, at(same), overtaken(replied(same, B), B)]).toEqual([B, false, null, false]);
    // nobody viewed the terminal when the repaint left: its own event is still to come, and what is heard ahead of it, also behind
    // the reply, was chosen before the repaint was applied
    const lone = attachSent(sizeHeard(sizeTold(attached(A), B, 1000), UNVIEWED, 1100, "none"), B);
    const late = sizeHeard(replied(lone, B), C, 1205, "unshown");
    expect([late.actual, overtaken(late, B), attachSize(sizeHeard(late, B, 1210, "unshown"))]).toEqual([C, true, C]);
    // its own event alone: it took the terminal from nobody, and the event is not awaited twice
    const echoed = sizeHeard(replied(lone, B), B, 1210, "unshown");
    expect([overtaken(replied(lone, B), B), at(echoed), echoed.echo, overtaken(sizeHeard(echoed, C, 1300, "unshown"), B)]).toEqual([false, null, false, false]);
    // a repaint that changed nothing (somebody viewed the terminal at B, nothing was heard ahead of the reply): a size heard behind
    // its reply is another viewer's later doing, and the terminal coming back to B is the core handing it back
    const beside = sizeHeard(replied(sent, B), C, 1205, "unshown");
    expect([overtaken(beside, B), attachSize(beside), at(sizeHeard(beside, B, 1210, "unshown"))]).toEqual([false, C, null]);
    // the size of a terminal nobody views, heard behind the reply, was so before the attach: never chosen, and the repaint's own event follows
    const unviewed = sizeHeard(replied(sent, B), UNVIEWED, 1205, "unshown");
    expect([unviewed.actual, attachSize(unviewed), unviewed.echo, at(sizeHeard(unviewed, B, 1210, "unshown"))]).toEqual([UNVIEWED, B, true, null]);
    // a reply that names another size: a viewer that drives the terminal leads, and the repaint changed nothing
    const led = replied(sizeHeard(sent, C, 1200, "sent"), C);
    expect([led.chosen, led.echo, overtaken(led, B)]).toEqual([C, false, false]);
    // a repaint that advertises the very size of a terminal nobody views sets nothing alone, so no event of its own is awaited
    expect(attachSent(sizeHeard(sizeTold(attached(A), UNVIEWED, 1000), UNVIEWED, 1100, "none"), UNVIEWED).echo).toBe(false);
    // before the repaint's attach has left, the size its attach before advertised is a size like any other: the core falls back to it
    expect([overtaken(sizeTold(attached(A), B, 1000), A), attachSize(sizeHeard(sizeTold(replied(attachSent(sizeTold(attached(A), B, 1000), B), B), C, 2000), B, 2100, "none"))]).toEqual([false, B]);
    // the take, the end of the attach and the pane's own next attach end what was awaited: beside a viewer that stays, a size heard
    // behind the next repaint's reply is again that viewer's later doing
    expect([took(lone).echo, took(lone).repaint, detached(lone).echo, detached(lone).repaint, reattaching(replied(lone, B)).echo]).toEqual([false, false, false, false, false]);
    const next = replied(attachSent(reattaching(sizeTold(replied(lone, B), C, 2000)), C), C);
    expect([next.echo, overtaken(sizeHeard(next, A, 2300, "unshown"), C)]).toEqual([false, false]);
  });

  it("a clipped pane shows the part of the real grid that holds the cursor", () => {
    expect([clipTop(0, 40, 24), clipTop(23, 40, 24), clipTop(24, 40, 24), clipTop(39, 40, 24), clipTop(5, 10, 24)]).toEqual([0, 0, 1, 16, 0]);
  });
});
