import { afterEach, describe, expect, it } from "bun:test";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";
import type { World } from "./focus.ts";
import { pickerMatches, pickerPlaces } from "./picker.ts";
import { FRAME_PASS_MS } from "./deadlines.ts";
import { initialState, type ModelEvent, type ModelState, pickerShown, reduce } from "./reduce.ts";

const TEST_MS = 120_000;
const AT = 1;

const key = (name: string, mods: Record<string, boolean> = {}): ModelEvent => ({ type: "key", key: name, mods, action: "press", at: AT });
const text = (typed: string): ModelEvent => ({ type: "text", text: typed, at: AT });
const after = (state: ModelState, ...events: ModelEvent[]): ModelState => events.reduce((s, event) => reduce(s, event).state, state);

const world: World = {
  workspaces: [
    { id: "w1", name: "ovis", tabs: [{ id: "t1", name: "main", panes: [{ id: "p1", name: "lead", agent: "claude" }, { id: "p2", name: "shell" }] }, { id: "t2", name: "logs", panes: [{ id: "p3", name: "tail" }] }] },
    { id: "w2", name: "docs", tabs: [{ id: "t3", name: "notes", panes: [{ id: "p4", name: "문서" }] }] },
  ],
};

describe("the picker's terminals", () => {
  it("are every terminal in the world's order, grouped by workspace; a search keeps those whose words hold its characters in order", () => {
    const places = pickerPlaces(world);
    expect(places.map((place) => [place.id, place.workspace])).toEqual([["p1", "w1"], ["p2", "w1"], ["p3", "w1"], ["p4", "w2"]]);
    const found = (query: string) => pickerMatches(places, query).map((place) => place.id);
    expect(found("")).toEqual(["p1", "p2", "p3", "p4"]);
    expect(found("logs")).toEqual(["p3"]);
    expect(found("CLAUDE")).toEqual(["p1"]);
    expect(found("o s")).toEqual(["p1", "p2", "p3", "p4"]);
    expect(found("\u1106\u116e\u11ab")).toEqual(["p4"]);
    expect(found("zz")).toEqual([]);
  });
});

describe("the picker overlay", () => {
  const open = after(reduce(initialState(undefined), { type: "world", world, at: AT }).state, key("B", { ctrl: true }), text("g"));
  const chosen = (state: ModelState) => (state.overlays.at(-1) as { chosen: string | null }).chosen;

  it("opens on the terminal in front; the keys move as herdr 0.9.5's measured (rows 79, attempt 3: its world work LEFT RIGHT SOLO, docs NOTES, here p1 p2 p3, p4)", () => {
    expect([open.overlays.map((overlay) => overlay.kind), chosen(open)]).toEqual([["goto"], "p1"]);
    const down = (n: number) => Array.from({ length: n }, () => key("ARROW_DOWN"));
    const up = (n: number) => Array.from({ length: n }, () => key("ARROW_UP"));
    // up and down (and j, k) walk headings and terminals and stop at both ends: ↓x10 -> NOTES, ↑x10 -> the work heading
    expect(chosen(after(open, ...down(10)))).toBe("p4");
    expect(chosen(after(open, ...up(10)))).toBe("heading:w1");
    expect(chosen(after(open, ...Array.from({ length: 10 }, () => text("j"))))).toBe("p4");
    expect(chosen(after(open, ...Array.from({ length: 10 }, () => text("k"))))).toBe("heading:w1");
    expect(chosen(after(open, text("j"), key("ARROW_DOWN")))).toBe("p3");
    expect(chosen(after(open, ...down(3)))).toBe("heading:w2");
    expect(chosen(after(open, ...down(3), key("ARROW_UP")))).toBe("p3");
    // left and right: the previous or next workspace's first terminal, from a heading as from a terminal; at the ends they stay
    expect(chosen(after(open, ...down(3), key("ARROW_LEFT")))).toBe("p1");
    expect(chosen(after(open, ...down(3), key("ARROW_RIGHT")))).toBe("heading:w2");
    expect(chosen(after(open, ...up(1), key("ARROW_LEFT")))).toBe("heading:w1");
    expect(chosen(after(open, ...up(1), key("ARROW_RIGHT")))).toBe("p4");
    expect(chosen(after(open, ...down(2), key("ARROW_LEFT")))).toBe("p3");
    expect(chosen(after(open, ...down(2), key("ARROW_RIGHT")))).toBe("p4");
    expect(chosen(after(open, ...down(4), key("ARROW_LEFT")))).toBe("p1");
    expect(chosen(after(open, ...down(4), key("ARROW_RIGHT")))).toBe("p4");
    const step = reduce(after(open, key("ARROW_DOWN")), key("ENTER"));
    expect([step.state.overlays, step.state.focus.tabs["w1"], step.state.focus.panes["t1"]]).toEqual([[], "t1", "p2"]);
  });

  it("/ starts a search that takes every key until Enter keeps it or Escape drops it; Escape then closes the picker", () => {
    const searched = after(open, text("/logs"));
    expect(searched.overlays.at(-1)).toMatchObject({ searching: true, field: { graphemes: [..."logs"] } });
    // j is a letter of the search, not a row
    expect(after(searched, text("j")).overlays.at(-1)).toMatchObject({ field: { graphemes: [..."logsj"] } });
    const kept = after(searched, key("ENTER"));
    expect(kept.overlays.at(-1)).toMatchObject({ searching: false });
    const jumped = reduce(kept, key("ENTER")).state;
    expect([jumped.overlays, jumped.focus.tabs["w1"]]).toEqual([[], "t2"]);
    const dropped = after(searched, key("ESCAPE"));
    expect(dropped.overlays.at(-1)).toMatchObject({ searching: false, field: { graphemes: [] } });
    expect(after(dropped, key("ESCAPE")).overlays).toEqual([]);
  });

  it("an open picker follows the world and keeps a surviving choice", () => {
    const onTail = after(open, key("ARROW_DOWN"), key("ARROW_DOWN"));
    const grown: World = { workspaces: [{ id: "w0", name: "new", tabs: [{ id: "t0", name: "a", panes: [{ id: "p0", name: "x" }] }] }, ...world.workspaces] };
    expect(chosen(after(onTail, { type: "world", world: grown, at: AT }))).toBe("p3");
  });

  it("keeps a chosen workspace heading through a change elsewhere, and Enter goes to that workspace", () => {
    const onDocs = after(open, ...Array.from({ length: 3 }, () => key("ARROW_DOWN")));
    expect(chosen(onDocs)).toBe("heading:w2");
    // a pane of the other workspace renamed: every row is where it was
    const renamed: World = { workspaces: world.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, panes: tab.panes.map((pane) => pane.id === "p2" ? { ...pane, name: "renamed" } : pane) })) })) };
    const kept = after(onDocs, { type: "world", world: renamed, at: AT });
    expect([chosen(kept), (kept.overlays.at(-1) as { unshown?: true }).unshown]).toEqual(["heading:w2", undefined]);
    const entered = reduce(kept, key("ENTER")).state;
    expect([entered.overlays, entered.focus.workspace]).toEqual([[], "w2"]);
    // the first terminal, chosen by default after a search, is kept as that terminal when another comes before it
    const searched = after(open, text("/sh"), key("ENTER"));
    expect(chosen(searched)).toBeNull();
    const before: World = { workspaces: [{ id: "w0", name: "shells", tabs: [{ id: "t0", name: "a", panes: [{ id: "p0", name: "sh" }] }] }, ...world.workspaces] };
    expect(chosen(after(searched, { type: "world", world: before, at: AT }))).toBe("p2");
  });

  it("when the world takes the chosen row, the first terminal stands in and nothing acts on it until a frame showed it", () => {
    const onTail = after(open, key("ARROW_DOWN"), key("ARROW_DOWN"));
    const gone: World = { workspaces: world.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.filter((tab) => tab.id !== "t2") })) };
    const stoodIn = after(onTail, { type: "world", world: gone, at: AT });
    expect(stoodIn.overlays.at(-1)).toMatchObject({ kind: "goto", chosen: null, unshown: true });
    // Enter, a row down and a workspace across leave it as it is: the row a person saw chosen is gone, and no other was shown
    for (const event of [key("ENTER"), key("ARROW_DOWN"), text("j"), key("ARROW_RIGHT")]) {
      const step = reduce(stoodIn, event);
      expect([step.state.overlays, step.state.focus, step.effects]).toEqual([stoodIn.overlays, stoodIn.focus, []]);
    }
    // a heading whose workspace left is the same
    const onDocs = after(open, ...Array.from({ length: 3 }, () => key("ARROW_DOWN")));
    expect(after(onDocs, { type: "world", world: { workspaces: [world.workspaces[0]!] }, at: AT }).overlays.at(-1)).toMatchObject({ chosen: null, unshown: true });
    // a search is the user's own choice of rows, and a frame that showed the stand-in makes it the chosen row
    expect((after(stoodIn, text("/s")).overlays.at(-1) as { unshown?: true }).unshown).toBeUndefined();
    expect(pickerShown(stoodIn, onTail.overlays.at(-1))).toBe(stoodIn);
    const shown = pickerShown(stoodIn, stoodIn.overlays.at(-1));
    expect((shown.overlays.at(-1) as { unshown?: true }).unshown).toBeUndefined();
    const entered = reduce(shown, key("ENTER")).state;
    expect([entered.overlays, entered.focus.panes["t1"]]).toEqual([[], "p1"]);
  });
});

describe("the picker on screen", () => {
  const runs: Run[] = [];
  afterEach(async () => {
    for (const run of runs.splice(0)) await run.close();
  });

  it("a click on a terminal's row jumps to it", async () => {
    const run = await Run.start({ fixture: demo, cols: 80, rows: 24 });
    runs.push(run);
    await run.live();
    await run.keys("ctrl+b,g");
    await run.advance(10);
    const row = run.grid().findIndex((line) => line.includes("└─ · logs"));
    expect(row).toBeGreaterThan(3);
    await run.keys(`click@10:${row}`);
    await run.advance(10);
    expect([run.loop.model().overlays, run.loop.model().focus.tabs["w-ovis"]]).toEqual([[], "t-logs"]);
  }, TEST_MS);

  const received = (run: Run) => Object.fromEntries(["t1", "t2", "t4"].map((id) => [id, run.core.program(id).receivedHex()]).filter(([, hex]) => hex !== ""));
  const picker = (run: Run) => run.loop.model().overlays.at(-1) as { kind: string; chosen: string | null } | undefined;

  it("a workspace heading the pointer chose stays chosen when a pane elsewhere is renamed: Enter goes to that workspace, and what is typed next to its pane", async () => {
    const run = await Run.start({ fixture: demo, cols: 120, rows: 40 });
    runs.push(run);
    await run.live();
    run.type("\x02g");
    await run.advance(FRAME_PASS_MS);
    const grid = run.grid();
    const terminal = grid.findIndex((line) => line.includes("└─") && line.includes("notes"));
    expect(terminal).toBeGreaterThan(1);
    // the heading is the row above its first terminal
    run.type(`\x1b[<35;${grid[terminal - 1]!.search(/\S/u) + 4};${terminal}M`);
    await run.advance(FRAME_PASS_MS);
    expect(picker(run)?.chosen).toBe("heading:w-docs");
    const shownGrid = run.grid();
    await run.loop.link.call("terminal.label", { terminal: "t2", labels: { "herdr.pane_name": "renamed elsewhere" } });
    await run.settle();
    expect([run.grid(), picker(run)?.chosen]).toEqual([shownGrid, "heading:w-docs"]);
    run.type("\r");
    await run.settle();
    expect([run.loop.report().mode.overlays, run.loop.model().focus.workspace]).toEqual([[], "w-docs"]);
    // the pane that came to the front takes input once its picture is drawn
    await run.live();
    await run.advance(FRAME_PASS_MS);
    run.type("S");
    await run.settle();
    expect(received(run)).toEqual({ t4: "53" });
  }, TEST_MS);

  it("Enter read before a frame shows the row standing in for an ended terminal chooses nothing; after that frame it chooses the row shown", async () => {
    const run = await Run.start({ fixture: demo, cols: 120, rows: 40 });
    runs.push(run);
    await run.live();
    run.type("\x02g");
    await run.advance(FRAME_PASS_MS);
    run.type("\x1b[B\x1b[B");
    await run.advance(FRAME_PASS_MS);
    expect(picker(run)?.chosen).toBe("t3");
    const shownGrid = run.grid();
    run.core.remove("t3");
    await run.settle();
    expect(run.grid()).toEqual(shownGrid);
    run.type("\rS");
    await run.settle();
    expect([run.loop.report().mode.overlays, run.loop.model().focus.panes["t-main"], received(run)]).toEqual([["goto"], "t1", {}]);
    await run.advance(FRAME_PASS_MS);
    run.type("\rS");
    await run.settle();
    expect([run.loop.report().mode.overlays, run.loop.model().focus.panes["t-main"], received(run)]).toEqual([[], "t1", { t1: "53" }]);
  }, TEST_MS);
});
