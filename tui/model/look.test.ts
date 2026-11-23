import { afterEach, describe, expect, it } from "bun:test";
import { tuiEnv } from "../../scripts/plugin-tui.ts";
import { HcConnection } from "../../server/herdr-core/connection.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { gridText, Screen } from "../testing/herdr-grid.ts";
import { Run } from "../testing/run.ts";
import { focused } from "./focus.ts";
import { look, type LookState } from "./look.ts";

/** the injected clock moves; only the socket's own turns are real */
const TEST_MS = 120_000;
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
/** the label every Herdr client reads as the last turn a person looked at */
const SEEN = "herdr.seen";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

/** An agent's terminal in the one tab these cores have, named `name` and reporting `state`, with `seen` as its `herdr.seen` (null: no label); answers its address. */
function agent(core: FakeHcCore, name: string, state: string, seen: string | null): string {
  const labels: Record<string, string> = { [SPACE_LABEL]: "w", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: "t", [TAB_NAME_LABEL]: "tab", [PANE_NAME_LABEL]: name };
  if (seen !== null) labels[SEEN] = seen;
  const { address } = core.spawn({ labels });
  core.setPaint(address, { body: `${name}\r\n` });
  core.reportStatus(address, { state, app: "claude" });
  return address;
}

/**
 * A core with one tab split in two agents, `t1` (named one) and `t2` (named two), each reporting idle at turn 0. `seen`
 * gives each a `herdr.seen` label to start with (none: no label); `first` the state t1 reports before the screen comes.
 */
function twoAgents(seen: string | null = "0", first = "idle"): FakeHcCore {
  const core = new FakeHcCore();
  agent(core, "one", first, seen);
  agent(core, "two", "idle", seen);
  return core;
}

/** The dot of the sidebar's second agent (pane `two`: each agent takes two rows, `● work · tab` then its agent), and its colour. */
async function secondAgentDot(run: Run): Promise<{ ch: string; fg: unknown }> {
  await Screen.load();
  const screen = new Screen(120, 40);
  try {
    screen.write(run.host.output());
    const cells = screen.cells();
    const rows = gridText(cells).flatMap((text, y) => /^ [●○·] work · tab/.test(text) ? [y] : []);
    const cell = cells.cells[rows[1]! * cells.cols + 1]!;
    return { ch: cell.ch, fg: cell.look.fg };
  } finally {
    screen.dispose();
  }
}

async function started(core: FakeHcCore, live = true): Promise<Run> {
  const run = await Run.start({ core, cols: 120, rows: 40 });
  runs.push(run);
  if (live) {
    await run.live();
    await run.advance(1);
  }
  return run;
}

/** Every `herdr.seen` write the core was asked for, in order: the terminal and the value. */
function seenWrites(run: Run, line?: number): { terminal: unknown; seen: unknown }[] {
  return run.core.calls()
    .filter((call) => call.method === "terminal.label" && (line === undefined || call.line === line))
    .map((call) => ({ terminal: call.params["terminal"], seen: (call.params["labels"] as Record<string, unknown>)[SEEN] }));
}

/** The agent in `terminal` works, then rests: its turn ends (the core raises the turn and tells it). */
async function endTurn(run: Run, terminal: string): Promise<void> {
  run.core.reportStatus(terminal, { state: "working", app: "claude" });
  run.core.reportStatus(terminal, { state: "idle", app: "claude" });
  await run.advance(20);
}

async function hostFocus(run: Run, focus: string): Promise<void> {
  run.type(focus);
  await run.advance(20);
}

const select = async (run: Run, id: string) => {
  run.loop.dispatch({ type: "select", target: { kind: "pane", id }, at: run.clock.current });
  await run.advance(20);
};


const shownPane = (run: Run) => focused(run.loop.model().world, run.loop.model().focus).pane?.id;

/** A turn of t1 ends while the screen's line is down: the snapshot of the next line shows it, no event told it. */
async function endsWhileDown(run: Run): Promise<void> {
  await run.cutLine();
  await run.advance(1_000);
  expect(run.loop.link.state.kind).toBe("Offline");
  run.core.reportStatus("t1", { state: "working", app: "claude" });
  run.core.reportStatus("t1", { state: "idle", app: "claude" });
  await run.listen();
  await run.advance(6_000);
  await run.live();
  await run.advance(20);
}

/**
 * A turn of t1 ends in events the screen misses, on a line that stays up: the core's `missed` snapshot shows it, and
 * the events themselves, sent after that snapshot, are dropped as older than it.
 */
async function endsInMissedEvents(run: Run): Promise<void> {
  run.core.holdingEvents = true;
  run.core.reportStatus("t1", { state: "working", app: "claude" });
  run.core.reportStatus("t1", { state: "idle", app: "claude" });
  run.core.missed();
  await run.settle();
  run.core.releaseEvents();
  await run.advance(20);
}

describe("the look rule", () => {
  const LOOKING: LookState = { hostFocused: true, inputAfterTurn: false, pane: "t1", live: true, drawn: true, overlay: false, online: true };
  const table: [name: string, change: Partial<LookState>, looked: string | null][] = [
    ["a focused host, the focused pane live, drawn, nothing over it, online", {}, "t1"],
    ["the host unfocused", { hostFocused: false }, null],
    ["the host unfocused, input after the turn notwithstanding", { hostFocused: false, inputAfterTurn: true }, null],
    ["no focus reports and no input after the turn", { hostFocused: null }, null],
    ["no focus reports and input after the turn", { hostFocused: null, inputAfterTurn: true }, "t1"],
    ["no pane", { pane: null }, null],
    ["the first paint not complete", { live: false }, null],
    ["not drawn in the last frame", { drawn: false }, null],
    ["an overlay open", { overlay: true }, null],
    ["the link offline", { online: false }, null],
  ];
  for (const [name, change, looked] of table) it(name, () => expect(look({ ...LOOKING, ...change })).toBe(looked));
});

describe("read state through herdr.seen (UB Q7)", () => {
  it("seen when looked at", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    // the look began on t1, whose label already holds its turn 0
    expect(seenWrites(run)).toEqual([]);
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    expect(run.core.terminal("t1").labels[SEEN]).toBe("1");
    // the other pane of the split is shown too, but not looked at: its turn is not marked
    await endTurn(run, "t2");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("seen not otherwise", async () => {
    // the host unfocused: nothing; its focus back: one write
    const unfocused = await started(twoAgents());
    await hostFocus(unfocused, FOCUS_IN);
    await hostFocus(unfocused, FOCUS_OUT);
    await endTurn(unfocused, "t1");
    expect(seenWrites(unfocused)).toEqual([]);
    await hostFocus(unfocused, FOCUS_IN);
    expect(seenWrites(unfocused)).toEqual([{ terminal: "t1", seen: "1" }]);

    // another pane focused
    const other = await started(twoAgents());
    await hostFocus(other, FOCUS_IN);
    await select(other, "t2");
    await endTurn(other, "t1");
    expect(seenWrites(other)).toEqual([]);

    // an overlay open over the panes
    const covered = await started(twoAgents());
    await hostFocus(covered, FOCUS_IN);
    await covered.keys("ctrl+b,?");
    expect(covered.loop.report().mode.overlays).toEqual(["help"]);
    await endTurn(covered, "t1");
    expect(seenWrites(covered)).toEqual([]);

    // the first paint not complete: the pane is not Live yet, so nothing; once it is drawn Live, it comes into view
    const painting = await started(twoAgents(), false);
    painting.type(FOCUS_IN);
    painting.core.reportStatus("t1", { state: "working", app: "claude" });
    painting.core.reportStatus("t1", { state: "idle", app: "claude" });
    await painting.settle();
    expect(painting.loop.panes.view("t1")?.state.kind).not.toBe("Live");
    expect(seenWrites(painting)).toEqual([]);
    await painting.live();
    await painting.advance(20);
    expect(seenWrites(painting)).toEqual([{ terminal: "t1", seen: "1" }]);

    // the link offline: a turn ends meanwhile and nothing is written; the line back, the pane comes into view again
    const offline = await started(twoAgents());
    await hostFocus(offline, FOCUS_IN);
    await offline.cutLine();
    await offline.advance(1_000);
    expect(offline.loop.link.state.kind).toBe("Offline");
    offline.core.reportStatus("t1", { state: "working", app: "claude" });
    offline.core.reportStatus("t1", { state: "idle", app: "claude" });
    await offline.advance(1_000);
    expect(seenWrites(offline)).toEqual([]);
    await offline.listen();
    await offline.advance(6_000);
    await offline.live();
    await offline.advance(20);
    expect(seenWrites(offline)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("seen once per turn", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    run.core.reportStatus("t1", { state: "working", app: "claude" });
    for (const progress of [10, 20, 30, 40]) run.core.reportStatus("t1", { state: "working", app: "claude", progress });
    await run.advance(20);
    expect(seenWrites(run)).toEqual([]);
    run.core.reportStatus("t1", { state: "idle", app: "claude" });
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }, { terminal: "t1", seen: "2" }]);
  }, TEST_MS);

  it("unread stands", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t1");
    const line = run.core.calls().find((call) => call.method === "terminal.label")!.line;
    // another client marks it unread while the pane stays in front: the screen writes nothing
    const otherClient = new HcConnection(() => run.core.transport());
    await otherClient.call("terminal.label", { terminal: "t1", labels: { [SEEN]: "0" } });
    otherClient.close();
    await run.advance(1_000);
    expect(seenWrites(run, line)).toEqual([{ terminal: "t1", seen: "1" }]);
    expect(run.core.terminal("t1").labels[SEEN]).toBe("0");
    // focus away and back: the pane comes into view again, one write
    await select(run, "t2");
    await select(run, "t1");
    expect(seenWrites(run, line)).toEqual([{ terminal: "t1", seen: "1" }, { terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("seen only raises", async () => {
    const run = await started(twoAgents("5"));
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t1");
    await select(run, "t2");
    await select(run, "t1");
    expect(seenWrites(run)).toEqual([]);
    expect(run.core.terminal("t1").labels[SEEN]).toBe("5");
  }, TEST_MS);

  it("seen joins", async () => {
    const run = await started(twoAgents(null));
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([]);
    await hostFocus(run, FOCUS_IN);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("no focus reports", async () => {
    const run = await started(twoAgents());
    await endTurn(run, "t1");
    await run.advance(1_000);
    expect(run.loop.model().host.focused).toBe(null);
    expect(seenWrites(run)).toEqual([]);
    await run.keys("x");
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    // the next turn: no input after it yet, so nothing until the next key
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    await run.keys("y");
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }, { terminal: "t1", seen: "2" }]);
  }, TEST_MS);

  it("core only", async () => {
    // the launcher hands the screen no Ovis server token or address (scripts/plugin-tui.ts tuiEnv)
    expect(tuiEnv({ TERM: "xterm", OVIS_TOKEN: "exported", OVIS_URL: "http://127.0.0.1:9", HC_SOCKET: "/s/hc.sock" })).toEqual({ TERM: "xterm", HC_SOCKET: "/s/hc.sock" });
    // with no Ovis server at all, the read state reaches every client through the core alone, on the screen's own line
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t1");
    const lines = new Set(run.core.calls().map((call) => call.line));
    expect(lines.size).toBe(1);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("an agent that finishes or turns blocked gives no notice and no toast, as herdr's default; its mark in the sidebar changes", async () => {
    const run = await started(twoAgents("0", "blocked"));
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t2");
    // herdr's own colours in the sidebar: done teal, blocked red
    expect(await secondAgentDot(run)).toEqual({ ch: "●", fg: [148, 226, 213] });
    run.core.reportStatus("t2", { state: "blocked", app: "claude" });
    await run.advance(20);
    expect(await secondAgentDot(run)).toEqual({ ch: "●", fg: [243, 139, 168] });
    expect(run.loop.model().notices).toEqual([]);
    expect(run.loop.report().mode.overlays).toEqual([]);
  }, TEST_MS);

  it("a host's own replies are not a person: on a host that never reports focus they write nothing, a key does", async () => {
    const run = await started(twoAgents());
    await endTurn(run, "t1");
    // the host's own sequences read after the turn: a colour reply and a sequence nobody knows
    run.type("\x1b]11;rgb:1111/2222/3333\x1b\\");
    run.type("\x1b[99;99~");
    await run.advance(20);
    expect(run.loop.report().actions.filter((action) => action.startsWith("read:")).slice(-2)).toEqual(["read:reply", "read:unknown"]);
    expect(seenWrites(run)).toEqual([]);
    await run.keys("x");
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("another client's zoom: the look follows the focus to the zoomed pane, and the covered pane's turn is not marked", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await select(run, "t2");
    await endTurn(run, "t2");
    expect(seenWrites(run)).toEqual([{ terminal: "t2", seen: "1" }]);
    // another client zooms t1: the focus follows the shared zoom (row 35), t2 stays attached and covered
    const otherClient = new HcConnection(() => run.core.transport());
    const doc = (zoomed: string | null) => ({ schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root: { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } }, zoomed }] }] });
    await otherClient.call("doc.set", { name: OVIS_LAYOUT_DOC, value: doc("t1"), version: run.core.docs.get(OVIS_LAYOUT_DOC)?.version ?? 0 });
    otherClient.close();
    await run.advance(1_000);
    expect([run.loop.panes.view("t2")?.covered, focused(run.loop.model().world, run.loop.model().focus).pane?.id]).toEqual([true, "t1"]);
    await endTurn(run, "t2");
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t2", seen: "1" }, { terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("a pane the focus passed over between two frames was never shown: its turn stays unread; shown focused, it is read", async () => {
    // navigate mode, l then h as two reads with no frame between them: the host never showed t2 focused
    const passed = await started(twoAgents());
    await hostFocus(passed, FOCUS_IN);
    await endTurn(passed, "t2");
    await passed.keys("ctrl+b,w");
    passed.type("l");
    passed.type("h");
    await passed.advance(20);
    expect([shownPane(passed), seenWrites(passed), passed.core.terminal("t2").labels[SEEN]]).toEqual(["t1", [], "0"]);

    // the same keys with a frame between them: the host showed t2 focused, so its turn is read
    const shown = await started(twoAgents());
    await hostFocus(shown, FOCUS_IN);
    await endTurn(shown, "t2");
    await shown.keys("ctrl+b,w");
    shown.type("l");
    await shown.advance(20);
    shown.type("h");
    await shown.advance(20);
    expect([shownPane(shown), seenWrites(shown), shown.core.terminal("t2").labels[SEEN]]).toEqual(["t1", [{ terminal: "t2", seen: "1" }], "1"]);
  }, TEST_MS);

  it("the help closed and opened again between two frames uncovered nothing: the turn under it stays unread; a close the host was shown reads it", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await run.keys("ctrl+b,?");
    await endTurn(run, "t1");
    const written = run.host.bytes().length;
    run.type("\r\x02?");
    await run.advance(20);
    // the help is back before any frame: the host was sent nothing, so nothing showed the pane
    expect([run.loop.report().mode.overlays, run.host.bytes().length - written, seenWrites(run), run.core.terminal("t1").labels[SEEN]]).toEqual([["help"], 0, [], "0"]);
    await run.keys("enter");
    await run.advance(20);
    expect([run.loop.report().mode.overlays, seenWrites(run)]).toEqual([[], [{ terminal: "t1", seen: "1" }]]);
  }, TEST_MS);

  it("a seen write marks the turn that was looked at: a turn that ends after the person left stays unread, however late the write runs", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    // the core is slow to answer the read every seen write starts with
    const answer = Promise.withResolvers<void>();
    const call = run.loop.link.call.bind(run.loop.link);
    run.loop.link.call = async (method, params, timeout) => {
      if (method === "terminal.get") await answer.promise;
      return call(method, params, timeout);
    };
    // turn 1 ends in front of the person; they leave, and turn 2 ends behind them before the write for turn 1 ran
    await endTurn(run, "t1");
    await select(run, "t2");
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([]);
    answer.resolve();
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    expect([run.core.terminal("t1").turn, run.core.terminal("t1").labels[SEEN]]).toEqual([2, "1"]);
  }, TEST_MS);
});

describe("a turn the screen did not watch end", () => {
  for (const [how, ends] of [["while the line was down", endsWhileDown], ["in events the screen missed", endsInMissedEvents]] as const) {
    it(`no focus reports: a turn that ended ${how} stays unread until a key is read after it`, async () => {
      const run = await started(twoAgents());
      await run.keys("A");
      await run.advance(20);
      await ends(run);
      // the pane leaves the view and comes back, with nothing typed since that turn ended
      await select(run, "t2");
      await select(run, "t1");
      expect([run.core.terminal("t1").turn, run.core.terminal("t1").labels[SEEN], seenWrites(run)]).toEqual([1, "0", []]);
      await run.keys("B");
      await run.advance(20);
      expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    }, TEST_MS);
  }

  it("no focus reports: a terminal the snapshot first shows past its first turn stays unread until a key is read", async () => {
    const run = await started(twoAgents());
    await run.keys("A");
    await run.advance(20);
    await run.cutLine();
    await run.advance(1_000);
    // made while the line was down, and its first turn ended there too
    const made = agent(run.core, "three", "working", "0");
    run.core.reportStatus(made, { state: "idle", app: "claude" });
    await run.listen();
    await run.advance(6_000);
    await select(run, made);
    await run.live();
    await run.advance(20);
    expect([shownPane(run), run.core.terminal(made).turn, seenWrites(run)]).toEqual([made, 1, []]);
    await run.keys("B");
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: made, seen: "1" }]);
  }, TEST_MS);

  it("a host that reports its focus: the pane in front is read once the snapshot shows the turn the events missed", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await endsInMissedEvents(run);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("no focus reports: a key read before a turn ended does not read that turn, and no turn's end gives a notice", async () => {
    const run = await started(twoAgents());
    await run.keys("x");
    await run.advance(20);
    await endTurn(run, "t1");
    // nobody was looking at the other pane either
    await endTurn(run, "t2");
    expect([run.loop.model().notices, seenWrites(run)]).toEqual([[], []]);
  }, TEST_MS);
});

describe("a look's write only raises herdr.seen", () => {
  /**
   * The look's write for t1's turn 1, with the core's answer to the read it starts with on its way: `meanwhile` happens
   * (another client's writes among it), then the answer comes. `begins`: the turn ended with nobody there and a look
   * that begins writes for it; else it ended under a look that went on. Answers t1's turn and label as the core holds
   * them, and the labels the screen itself wrote.
   */
  async function lateAnswer(begins: boolean, meanwhile: (run: Run, other: HcConnection) => Promise<void>) {
    const run = await started(twoAgents());
    const answer = Promise.withResolvers<void>();
    let waiting = false;
    const call = run.loop.link.call.bind(run.loop.link);
    run.loop.link.call = async (method, params, timeout) => {
      const result = await call(method, params, timeout);
      if (waiting && method === "terminal.get") await answer.promise;
      return result;
    };
    if (begins) {
      await endTurn(run, "t1");
      waiting = true;
      await hostFocus(run, FOCUS_IN);
    } else {
      await hostFocus(run, FOCUS_IN);
      waiting = true;
      await endTurn(run, "t1");
    }
    await hostFocus(run, FOCUS_OUT);
    const other = new HcConnection(() => run.core.transport());
    await meanwhile(run, other);
    other.close();
    answer.resolve();
    await run.advance(20);
    const own = run.core.calls().find((made) => made.method === "events.subscribe")!.line;
    return { turn: run.core.terminal("t1").turn, seen: run.core.terminal("t1").labels[SEEN], wrote: seenWrites(run, own) };
  }

  const read = (other: HcConnection, turn: string) => other.call("terminal.label", { terminal: "t1", labels: { [SEEN]: turn } });
  /** t1's next turn ends, and another client reads it; the screen is told of both as they happen. */
  const newerRead = async (run: Run, other: HcConnection) => {
    await endTurn(run, "t1");
    await read(other, "2");
    await run.advance(20);
  };
  /** The same, and one more turn of t1 ends: the screen is told of it all only in the snapshot of events it missed. */
  const newerReadInSnapshot = async (run: Run, other: HcConnection) => {
    run.core.holdingEvents = true;
    for (const state of ["working", "idle"]) run.core.reportStatus("t1", { state, app: "claude" });
    await read(other, "2");
    for (const state of ["working", "idle"]) run.core.reportStatus("t1", { state, app: "claude" });
    run.core.missed();
    await run.settle();
    run.core.releaseEvents();
    await run.advance(20);
  };
  /** Another client reads the very turn the write is for, then marks it unread. */
  const readThenUnread = async (run: Run, other: HcConnection) => {
    await read(other, "1");
    await read(other, "0");
    await run.advance(20);
  };

  const cases: [name: string, begins: boolean, meanwhile: (run: Run, other: HcConnection) => Promise<void>, leaves: Awaited<ReturnType<typeof lateAnswer>>][] = [
    ["a look that begins: a newer read another client made meanwhile stands", true, newerRead, { turn: 2, seen: "2", wrote: [] }],
    ["a look that goes on: a newer read another client made meanwhile stands", false, newerRead, { turn: 2, seen: "2", wrote: [] }],
    ["a look that begins: a newer read told by a snapshot, at a turn past it, stands", true, newerReadInSnapshot, { turn: 3, seen: "2", wrote: [] }],
    ["a look that begins: a read of the same turn, marked unread again, is no newer read and the write goes through", true, readThenUnread, { turn: 1, seen: "1", wrote: [{ terminal: "t1", seen: "1" }] }],
  ];
  for (const [name, begins, meanwhile, leaves] of cases) {
    it(name, async () => expect(await lateAnswer(begins, meanwhile)).toEqual(leaves), TEST_MS);
  }

  it("a core that started again with the same addresses: the reads its terminals had before stop no read of the turns it has now", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    for (let turn = 1; turn <= 3; turn++) await endTurn(run, "t1");
    expect(run.core.terminal("t1").labels[SEEN]).toBe("3");
    // another core at the same socket: its t1 is another terminal, one turn in and unread
    const next = twoAgents();
    for (const state of ["working", "idle"]) next.reportStatus("t1", { state, app: "claude" });
    await run.cutLine();
    const listening = await next.listen(run.socket);
    try {
      await run.advance(6_000);
      await run.live();
      await run.advance(20);
      expect([next.terminal("t1").turn, next.terminal("t1").labels[SEEN]]).toEqual([1, "1"]);
    } finally {
      await listening.close();
    }
  }, TEST_MS);
});
