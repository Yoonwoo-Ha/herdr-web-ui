import { afterEach, expect, it } from "bun:test";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { FRAME_PASS_MS } from "../model/deadlines.ts";
import type { World } from "../model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { agents } from "../testing/fixtures/agents.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

const hex = (text: string) => Buffer.from(text).toString("hex");

/**
 * Waits for the next frame pass and answers how many there were. The pass after it is FRAME_PASS_MS on, so whatever is
 * read before the clock moves again is in no frame: a test checks the count is the same right before it clicks.
 */
async function framePassed(run: Run, terminal: string): Promise<number> {
  const before = run.loop.report().passes;
  run.core.program(terminal).output(".");
  for (let waited = 0; run.loop.report().passes === before && waited < 10 * FRAME_PASS_MS; waited++) await run.advance(1);
  expect(run.loop.report().passes).toBeGreaterThan(before);
  return run.loop.report().passes;
}

const click = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`;

it.each(["before Escape", "after Escape", "after repaint"])("a click on a picker row the world moved since its frame chooses nothing, and a program's held button keeps its own release: %s", async (ordering) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  const program = run.core.program("t1");
  program.output("\x1b[?1002h\x1b[?1006h");
  await run.advance(200);
  // the middle button, held in the program (a right press would open the pane's menu)
  const press = "\x1b[<1;6;4M";
  run.type("\x1b[<1;33;6M");
  await run.settle();
  expect(program.receivedHex()).toBe(hex(press));
  run.type("\x02g");
  await run.advance(FRAME_PASS_MS);
  const painted = run.grid();
  const row = painted.findIndex((line) => line.includes("└─ · logs"));
  expect(row).toBeGreaterThan(0);
  const col = painted[row]!.indexOf("logs");
  // the logs terminal ends: the row the frame still shows it on is the next workspace's terminal in the list now
  run.core.remove("t3");
  await run.settle();
  expect(run.grid()).toEqual(painted);
  run.type(click(col, row));
  await run.settle();
  expect(program.receivedHex()).toBe(hex(press));
  expect(run.loop.report().mode.overlays).toEqual(["goto"]);
  expect([run.loop.model().focus.workspace, run.loop.model().focus.panes["t-main"]]).toEqual(["w-ovis", "t1"]);
  if (ordering !== "before Escape") run.type("\x1b[27u");
  if (ordering === "after repaint") await run.advance(FRAME_PASS_MS);
  run.type("\x1b[<1;34;6m");
  await run.settle();
  const balanced = hex(`${press}\x1b[<1;7;4m`);
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual([balanced, ""]);
  run.type("\x1b[<1;35;6m");
  await run.settle();
  expect(program.receivedHex()).toBe(balanced);
}, 60_000);

it.each(["the pointer moved onto the row before its terminal ended", "a key moved the choice after its terminal ended"])(
  "a click on a picker row whose terminal ended since the frame chooses nothing, though the user's own input changed the picker in between: %s", async (ordering) => {
    const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
    runs.push(run);
    await run.live();
    run.type("\x02g");
    await run.advance(FRAME_PASS_MS);
    const passes = await framePassed(run, "t1");
    const painted = run.grid();
    const row = painted.findIndex((line) => line.includes("└─ · logs"));
    expect(row).toBeGreaterThan(0);
    const col = painted[row]!.indexOf("logs");
    const chosen = () => (run.loop.model().overlays.at(-1) as { chosen?: string | null } | undefined)?.chosen;
    // no frame is taken from here to the click: the screen shows logs on that row throughout
    if (ordering.startsWith("the pointer")) {
      run.type(`\x1b[<35;${col + 1};${row + 1}M`);
      await run.settle();
      expect(chosen()).toBe("t3");
      run.core.remove("t3");
      await run.settle();
    } else {
      run.core.remove("t3");
      await run.settle();
      // the picker's own key: read, and without effect on a choice no frame showed
      run.type("\x1b[A");
      await run.settle();
    }
    expect([run.grid(), run.loop.report().passes]).toEqual([painted, passes]);
    // the row under the pointer is the next workspace's terminal in the list now
    run.type(click(col, row));
    await run.settle();
    expect([run.loop.report().mode.overlays, run.loop.model().focus.workspace, run.loop.model().focus.panes["t-main"]]).toEqual([["goto"], "w-ovis", "t1"]);
    // the next frame shows the list as it is, without logs: a click on a row it shows goes there
    await run.advance(FRAME_PASS_MS);
    const shown = run.grid();
    expect(shown.some((line) => line.includes("└─ · logs"))).toBe(false);
    const notes = shown.findIndex((line) => line.includes("└─") && line.includes("notes"));
    expect(notes).toBeGreaterThan(0);
    run.type(click(shown[notes]!.indexOf("notes"), notes));
    await run.settle();
    expect([run.loop.report().mode.overlays, run.loop.model().focus.workspace]).toEqual([[], "w-docs"]);
    expect(["t1", "t2", "t4"].map((id) => run.core.program(id).receivedHex())).toEqual(["", "", ""]);
  }, 60_000);

it("a click on a workspace's row goes to the workspace a person saw there, though the user's own key came between the core's word that the one above it ended and the list read again", async () => {
  const core = new FakeHcCore();
  place(core, { space: "wa", spaceName: "alpha", tab: "a1", tabName: "one" }, "A\r\n");
  const middle = place(core, { space: "wb", spaceName: "bravo", tab: "b1", tabName: "one" }, "B\r\n");
  place(core, { space: "wc", spaceName: "charlie", tab: "c1", tabName: "one" }, "C\r\n");
  const run = await Run.start({ core, cols: 120, rows: 40 });
  runs.push(run);
  await run.live();
  const passes = await framePassed(run, "t1");
  const painted = run.grid();
  const row = painted.findIndex((line) => line.includes("charlie"));
  expect(row).toBeGreaterThan(0);
  // the screen's read of the terminals, asked for by the core's word, is answered only after the key
  const answer = Promise.withResolvers<void>();
  const call = run.loop.link.call.bind(run.loop.link);
  let asked = false;
  run.loop.link.call = (async (method, params, timeout) => {
    if (method === "terminal.list" && !asked) {
      asked = true;
      await answer.promise;
    }
    return call(method, params, timeout);
  }) as typeof call;
  try {
    core.remove(middle);
    await run.settle();
    expect([asked, run.loop.model().world.workspaces.length]).toEqual([true, 3]);
    // the user's own key, the prefix: it changes the model and asks the core nothing. No frame is taken from here to the click
    run.type("\x02");
  } finally {
    answer.resolve();
  }
  await run.settle();
  expect([run.loop.model().armed, run.grid(), run.loop.report().passes, run.loop.model().world.workspaces.map((workspace) => workspace.name)]).toEqual([true, painted, passes, ["alpha", "charlie"]]);
  // in the list as it is now charlie is a row higher, and the row it was painted on is no workspace's
  run.type(click(painted[row]!.indexOf("charlie"), row));
  await run.settle();
  expect(run.loop.model().focus.workspace).toBe("wc");
}, 60_000);

it("a click on an agent's row goes to the agent a person saw there, though the user's own key and then a status that took the row above it away came since the frame", async () => {
  const run = await Run.start({ fixture: agents, cols: 120, rows: 40 });
  runs.push(run);
  await run.live();
  const passes = await framePassed(run, "t1");
  const painted = run.grid();
  // the four agents' rows in the sidebar, in the tab's order: t1 to t4
  const rows = painted.flatMap((line, at) => line.slice(0, 24).includes("claude") ? [at] : []);
  expect(rows).toHaveLength(4);
  // the user's own key, then the core's word before anything else it says: the first terminal's program reports as no
  // agent any more, so its row leaves at once and the rows under it move up. No frame is taken from here to the click
  run.type("\x02");
  run.core.reportStatus("t1", { state: "idle" });
  await run.settle();
  expect([run.loop.model().armed, run.grid(), run.loop.report().passes, run.loop.model().world.agents]).toEqual([true, painted, passes, ["t2", "t3", "t4"]]);
  run.type(click(painted[rows[2]!]!.indexOf("claude"), rows[2]!));
  await run.settle();
  expect(run.loop.model().focus.panes["t-agents"]).toBe("t3");
}, 60_000);

it("a character the menu does not know does not block the next choice", async () => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  // one read before the menu's first paint: the letter is ignored, Enter chooses its first entry, the text goes on to the pane
  run.type("\x02\r한\rz");
  await run.advance(200);
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["7a", ""]);
  expect(run.loop.report().mode.overlays).toEqual([]);
}, 60_000);

it("a long run of characters the menu ignores stays iterative, and the choice after it runs once", async () => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  run.type("\x02\r" + "7".repeat(100_000) + "\rz");
  await run.advance(200);
  expect(run.loop.report().mode.overlays).toEqual([]);
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["7a", ""]);
  run.type("y");
  await run.settle();
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["7a79", ""]);
  expect(run.loop.report().actions).not.toContain("close_all");
}, 60_000);

it.each(["reused address", "new connection"])("a right-click menu opened on a terminal acts on no other terminal at its address: %s", (change) => {
  const AT = 1_000;
  const after = (state: ModelState, ...events: ModelEvent[]) => events.reduce((now, event) => reduce(now, event).state, state);
  const born = (created: number): World => ({
    workspaces: [{ id: "w", name: "", tabs: [{ id: "tab", name: "", panes: [
      { id: "p", name: "shell", created }, { id: "other", name: "", created: 2 },
    ] }] }],
  });
  const menu = after(initialState(undefined), { type: "resize", cols: 120, rows: 40, at: AT }, { type: "world", epoch: 1, world: born(1), at: AT },
    { type: "context", target: { kind: "pane", id: "p" }, cell: { x: 3, y: 3 }, at: AT });
  expect(menu.overlays.map((overlay) => overlay.kind)).toEqual(["context"]);
  const changed = after(menu, { type: "world", epoch: change === "new connection" ? 2 : 1, world: born(change === "new connection" ? 1 : 3), at: AT });
  expect([changed.overlays, changed.notices.map((notice) => notice.code)]).toEqual([[], ["target_gone"]]);
  // Enter was Rename on the terminal the menu showed: here it opens no field and writes nothing
  const enter = reduce(changed, { type: "key", key: "ENTER", mods: {}, action: "press", at: AT });
  expect([enter.state.overlays, enter.effects.filter((effect) => effect.type === "run")]).toEqual([[], []]);
});
