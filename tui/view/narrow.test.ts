import { afterEach, describe, expect, it } from "bun:test";
import type { InputEvent } from "../input/decode.ts";
import { CATALOGUE } from "../model/catalogue.ts";
import { FRAME_PASS_MS, NOTICE_SHOW_MS } from "../model/deadlines.ts";
import type { World } from "../model/focus.ts";
import type { MenuEntry } from "../model/menu.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { agents } from "../testing/fixtures/agents.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";

const TEST_MS = 120_000;
const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function shown(cols: number, rows = 30): Promise<Run> {
  const run = await Run.start({ fixture: demo, cols, rows });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

/** A left click's press and release at 0-based `col`, `row`, as one read (SGR mouse reports). */
const click = (col: number, row: number): string => `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`;
const attached = (run: Run) => run.loop.panes.views().map((view) => view.terminal).sort();
const docSets = (run: Run) => run.core.calls().filter((call) => call.method === "doc.set").length;

describe("the screen at widths 45, 60, 64 and 65: one terminal at 64 columns or fewer, the splits from 65", () => {
  it("at 45 columns: a header, one terminal, and a hint line of at most 45 cells that names the menu key", async () => {
    const run = await shown(45);
    const grid = run.grid();
    expect(grid[0]).toBe("·1:ovis 1/2:main hc:default            [menu]");
    expect(grid[1]).toBe(`+- shell / ${"-".repeat(33)}+`);
    expect(grid[2]).toBe(`|$ echo 안녕${" ".repeat(32)}|`);
    expect(grid[28]).toBe(`+${"-".repeat(43)}+`);
    expect(grid[29]).toBe(" TERMINAL  ctrl+b prefix prefix+enter menu");
    expect(run.loop.screen()!.cols).toBe(45);
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("a notice takes the hint line's right end: every hint left of it is whole or gone, and they come back when it goes", async () => {
    const badge = " TERMINAL";
    const prefix = " TERMINAL  ctrl+b prefix";
    const menu = " TERMINAL  ctrl+b prefix prefix+enter menu";
    const all = " TERMINAL  ctrl+b prefix prefix+enter menu prefix+? help";
    // Notice length, first notice cell (the leading space), and the whole hints to its left.
    for (const [cols, plain, cases] of [
      [45, menu, [[3, 40, prefix], [10, 33, prefix], [14, 29, prefix], [20, 23, badge], [27, 16, badge], [40, 16, badge], [70, 16, badge], [100, 16, badge]]],
      [64, all, [[3, 59, all], [10, 52, menu], [14, 48, menu], [20, 42, menu], [27, 35, prefix], [40, 23, badge], [70, 23, badge], [100, 23, badge]]],
      [120, all, [[3, 115, all], [10, 108, all], [14, 104, all], [20, 98, all], [27, 91, all], [40, 78, all], [70, 48, menu], [100, 42, menu]]],
    ] as const) {
      const run = await shown(cols);
      expect(run.grid()[29]).toBe(plain);
      for (const [length, start, hints] of cases) {
        run.loop.dispatch({ type: "notice", code: "x".repeat(length), calm: true, at: run.clock.current });
        await run.advance(FRAME_PASS_MS);
        const row = run.grid()[29]!;
        expect({ cols, length, cells: row.slice(0, start + 2) }).toEqual({ cols, length, cells: `${hints.padEnd(start)} x` });
      }
      await run.advance(NOTICE_SHOW_MS);
      expect({ cols, row: run.grid()[29] }).toEqual({ cols, row: plain });
    }
  }, TEST_MS);

  it("at 60 columns: the same one terminal across the whole width", async () => {
    const run = await shown(60);
    const grid = run.grid();
    expect(grid[0]).toBe(`·1:ovis 1/2:main hc:default${" ".repeat(27)}[menu]`);
    expect(grid[1]).toBe(`+- shell / ${"-".repeat(48)}+`);
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 64 columns: one pane, the other pane of its tab not attached", async () => {
    const run = await shown(64);
    const grid = run.grid();
    expect(grid[0]).toBe(`·1:ovis 1/2:main hc:default${" ".repeat(31)}[menu]`);
    expect(grid[1]).toBe(`+- shell / ${"-".repeat(52)}+`);
    expect(grid[29]).toBe(" TERMINAL  ctrl+b prefix prefix+enter menu prefix+? help");
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 65 columns: the sidebar and the tab's two panes side by side, both attached", async () => {
    const run = await shown(65);
    const grid = run.grid();
    expect(grid[0]).toBe("hc:default           <<| 1:main  2:logs");
    expect(grid[1]).toBe("Workspaces             |+- shell / ---------++- files / --------+");
    expect(attached(run)).toEqual(["t1", "t2"]);
  }, TEST_MS);

  it("at 45 columns the focused pane is the one shown: the other pane, once focused, replaces it", async () => {
    const run = await shown(45);
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.live();
    await run.advance(10);
    expect(run.grid()[1]).toBe(`+- files / ${"-".repeat(33)}+`);
    expect(attached(run)).toEqual(["t2"]);
  }, TEST_MS);

  it("the narrow view sends zero doc.set: switching panes, tabs and workspaces at 45 columns writes no layout", async () => {
    const run = await shown(45);
    const steps: [keys: string, shown: string][] = [["ctrl+b,enter,6", "t2"], ["ctrl+b,enter,4", "t3"], ["ctrl+b,enter,2", "t4"], ["ctrl+b,enter,1", "t3"], ["click@3:0", "t3"], ["esc", "t3"]];
    for (const [keys, pane] of steps) {
      await run.keys(keys);
      await run.live();
      await run.advance(200);
      expect({ keys, attached: attached(run) }).toEqual({ keys, attached: [pane] });
    }
    expect(run.loop.report().mode.overlays).toEqual([]);
    expect(docSets(run)).toBe(0);
    expect(run.core.herdrAppWrites).toEqual([]);
  }, TEST_MS);

  it("a click on the header opens the menu; a click on an entry chooses it", async () => {
    const run = await shown(45);
    await run.keys("click@20:0");
    await run.advance(10);
    expect(run.loop.report().mode.overlays).toEqual(["menu"]);
    expect(run.grid()[0]).toBe("+ Menu ----------------------- [close: esc] +");
    expect(run.grid()[4]).toBe("| 4 · tab 2:logs                            |");
    await run.keys("click@10:4");
    await run.live();
    await run.advance(10);
    expect(run.loop.report().mode.overlays).toEqual([]);
    expect(run.grid()[0]).toBe("·1:ovis 2/2:logs hc:default            [menu]");
    expect(attached(run)).toEqual(["t3"]);
  }, TEST_MS);
  it("a click chooses the entry its line showed, though the world changed the menu before the next paint", async () => {
    const run = await shown(45, 80);
    // Test the menu action alone: without a look, no independent herdr.seen label RPC is expected.
    run.type("\x1b[O");
    await run.keys("ctrl+b,enter");
    await run.advance(FRAME_PASS_MS);
    const menu = () => run.loop.model().overlays.at(-1) as { kind: string; entries: readonly MenuEntry[] };
    const zoom = menu().entries.find((entry) => entry.kind === "action" && entry.action === "zoom")!;
    const painted = run.grid();
    // a menu line starts with the frame, the cursor's mark and the entry's key
    const row = painted.findIndex((line) => line.startsWith(`| ${zoom.label} `));
    expect(row).toBeGreaterThan(0);
    // a workspace made elsewhere: every entry below the workspaces moves down one, and zoom's index now holds close_pane
    place(run.core, { space: "w-new", spaceName: "new", tab: "t-new", tabName: "new" }, "$ ");
    await run.settle();
    expect(menu().entries.some((entry) => entry.kind === "workspace" && entry.id === "w-new")).toBe(true);
    expect(run.grid()).toEqual(painted);
    run.type(click(10, row));
    await run.settle();
    await run.advance(200);
    expect(run.loop.report().actions.filter((code) => code.startsWith("run:"))).toEqual(["run:zoom"]);
    expect([run.loop.report().mode.overlays, run.core.calls().filter((call) => call.method.startsWith("terminal.") && !call.method.startsWith("terminal.attach") && call.method !== "terminal.list")]).toEqual([[], []]);
  }, TEST_MS);

  it("a click on the line of a place gone since the paint chooses nothing, and the menu stays open", async () => {
    const run = await shown(45, 80);
    await run.keys("ctrl+b,enter");
    await run.advance(FRAME_PASS_MS);
    const painted = run.grid();
    const row = painted.findIndex((line) => line.startsWith("| 4 "));
    expect(painted[row]).toContain("2:logs");
    const where = () => {
      const { focus } = run.loop.model();
      const tab = focus.tabs[focus.workspace!]!;
      return [focus.workspace, tab, focus.panes[tab]];
    };
    const before = where();
    // the tab 2:logs ends: its index now holds the first pane of the shown tab
    run.core.remove("t3");
    await run.settle();
    expect(run.grid()).toEqual(painted);
    run.type(click(10, row));
    await run.settle();
    await run.advance(200);
    expect([run.loop.report().mode.overlays, where()]).toEqual([["menu"], before]);
  }, TEST_MS);

  it.each(["before update", "before repaint", "after repaint"])("a painted Close pane acts only on the pane shown: click %s", async (when) => {
    const run = await shown(45, 80);
    await run.keys("ctrl+b,enter");
    await run.advance(FRAME_PASS_MS);
    if (when !== "before update") {
      run.core.remove("t1");
      await run.settle();
      if (when === "after repaint") await run.advance(FRAME_PASS_MS);
    }
    const row = run.grid().findIndex((line) => line.includes("close pane"));
    expect(row).toBeGreaterThan(0);
    run.type(click(10, row));
    await run.advance(200);
    const main = run.loop.model().world.workspaces.flatMap((w) => w.tabs).find((tab) => tab.id === "t-main");
    expect(main?.panes.map(({ id }) => id) ?? []).toEqual(when === "after repaint" ? [] : ["t2"]);
    expect(run.loop.report().mode.overlays).toEqual(when === "before repaint" ? ["menu"] : []);
  }, TEST_MS);

  it.each([
    ["before repaint", 0, "6z", "w-ovis"],
    ["after repaint", 0, "6z", "w-ovis"],
    ["Down during repaint", 1, "6z", "w-ovis"],
    ["Enter after Down during repaint", 1, "\r", "w-docs"],
    ["Enter on a shifted tab during repaint", 3, "\r", "w-ovis"],
  ] as const)("menu choices use accepted labels and the latest cursor: %s", async (ordering, downs, keys, workspace) => {
    const run = await shown(120, 80);
    run.type("\x02\r");
    await run.advance(FRAME_PASS_MS);
    place(run.core, { space: "w-new", spaceName: "new", tab: "t-new", tabName: "new" }, "$ ");
    await run.settle();
    const repaint = ordering !== "before repaint";
    if (downs > 0) run.host.duringNextWrite(() => run.type("\x1b[B".repeat(downs)));
    if (repaint) await run.advance(FRAME_PASS_MS);
    const line = run.grid().find((row) => row.includes("6 · pane"));
    expect(line).toContain(repaint ? "shell" : "files");
    run.type(keys);
    await run.advance(200);
    expect(run.loop.model().focus.workspace).toBe(workspace);
    if (ordering === "Enter on a shifted tab during repaint") expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-logs");
    expect(run.loop.report().mode.overlays).toEqual([]);
    expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(keys === "\r" ? ["", ""] : repaint ? ["7a", ""] : ["", "7a"]);
  }, TEST_MS);

  it("Enter refuses a cursor moved during the write to an entry absent from the accepted frame", async () => {
    const run = await shown(120, 80);
    run.type("\x02\r");
    await run.advance(FRAME_PASS_MS);
    run.core.remove("t3");
    await run.settle();
    // The old list still has Logs at index 3; the accepted list has a pane at that index.
    run.host.duringNextWrite(() => run.type("\x1b[B".repeat(3)));
    await run.advance(FRAME_PASS_MS);
    run.type("\r");
    await run.settle();
    expect(run.loop.report().mode.overlays).toEqual(["menu"]);
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-main");
  }, TEST_MS);

  it("the narrow header counts the agents that need the user elsewhere, and not the one it shows", async () => {
    const run = await Run.start({ fixture: agents, cols: 45, rows: 30 });
    runs.push(run);
    await run.live();
    await run.advance(10);
    expect(run.grid()[0]).toBe("!1:agents 1/1:agents hc:default     !1 [menu]");
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.live();
    await run.advance(10);
    expect(run.grid()[0]).toBe("!1:agents 1/1:agents hc:default        [menu]");
  }, TEST_MS);

  it("at 120 columns the sidebar's header opens the menu, and its << still collapses the sidebar", async () => {
    const run = await shown(120, 40);
    await run.keys("click@3:0");
    await run.advance(10);
    expect(run.loop.report().mode.overlays).toEqual(["menu"]);
    await run.keys("esc");
    await run.advance(200);
    await run.keys("click@21:0");
    await run.advance(10);
    expect([run.loop.report().mode.overlays, run.loop.model().sidebarCollapsed]).toEqual([[], true]);
  }, TEST_MS);

  it("the menu's window follows its cursor: the up arrow from the first entry shows the last one", async () => {
    const run = await shown(45);
    await run.keys("ctrl+b,enter,up");
    await run.advance(10);
    const grid = run.grid();
    expect(grid[28]).toBe("|>U agents                          prefix+a|");
    expect(grid.some((line) => line.includes("workspace 1:ovis"))).toBe(false);
  }, TEST_MS);
});

describe("plain route: every built action of the catalogue is an entry of the menu", () => {
  const AT = 1_000;
  const WORLD: World = {
    workspaces: [
      { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }, { id: "p2", name: "" }] }, { id: "t2", name: "b", panes: [{ id: "p3", name: "" }] }] },
      { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "" }] }] },
    ],
    agents: ["p4"],
  };
  const named = (name: string): InputEvent => ({ type: "key", key: name, mods: {}, action: "press", at: AT });
  const text = (value: string): InputEvent => ({ type: "text", text: value, at: AT });
  const after = (state: ModelState, ...events: ModelEvent[]) => events.reduce((current, event) => reduce(current, event).state, state);
  const focusedPane = (state: ModelState) => state.focus.panes[state.focus.tabs[state.focus.workspace!]!];
  const base = reduce(initialState(undefined), { type: "world", world: WORLD, at: 0 }).state;
  const open = after(base, { type: "action", action: "menu", at: AT });
  const entries = (open.overlays.at(-1) as { entries: readonly MenuEntry[] }).entries;
  const built = CATALOGUE.filter((entry) => entry.status === "built").map((entry) => entry.id);

  it("each built id is an entry, in the catalogue's order, then the agent list, each with a digit or letter of its own", () => {
    const actions = entries.flatMap((entry) => (entry.kind === "action" ? [entry] : []));
    expect(actions.map((entry) => entry.action)).toEqual([...built, "agents"]);
    for (const entry of actions) expect({ action: entry.action, label: /^[0-9A-Za-z]$/.test(entry.label) }).toEqual({ action: entry.action, label: true });
    const labels = entries.flatMap((entry) => (entry.label === null ? [] : [entry.label]));
    expect(new Set(labels).size).toBe(labels.length);
    expect(entries.slice(0, 7).map((entry) => [entry.kind, entry.kind === "action" ? entry.action : entry.id, entry.label])).toEqual([
      ["workspace", "w1", "1"], ["workspace", "w2", "2"], ["tab", "t1", "3"], ["tab", "t2", "4"], ["pane", "p1", "5"], ["pane", "p2", "6"], ["agent", "p4", "7"],
    ]);
  });

  it("each entry's letter, and the arrows then Enter, do what the action itself does: no Escape, no Ctrl, no composed key", () => {
    const numbered: Record<string, string> = { switch_workspace: "workspace", switch_tab: "tab", focus_agent: "agent" };
    entries.forEach((entry, at) => {
      if (entry.kind !== "action") return;
      const byLabel = reduce(open, text(entry.label));
      const byArrows = after(open, ...Array.from({ length: at }, () => named("ARROW_DOWN")));
      const chosen = reduce(byArrows, named("ENTER"));
      if (numbered[entry.action]) {
        const first = entries.findIndex((candidate) => candidate.kind === numbered[entry.action]);
        expect({ action: entry.action, cursor: (byLabel.state.overlays.at(-1) as { cursor: number }).cursor }).toEqual({ action: entry.action, cursor: first });
        expect({ action: entry.action, cursor: (chosen.state.overlays.at(-1) as { cursor: number }).cursor }).toEqual({ action: entry.action, cursor: first });
        return;
      }
      const direct = reduce(base, { type: "action", action: entry.action, at: AT });
      expect({ action: entry.action, state: byLabel.state, effects: byLabel.effects }).toEqual({ action: entry.action, state: direct.state, effects: direct.effects });
      expect({ action: entry.action, state: chosen.state, effects: chosen.effects }).toEqual({ action: entry.action, state: direct.state, effects: direct.effects });
    });
  });

  it.each(["reused address", "new connection"])("a menu letter cannot close or rename a new terminal at the painted address: %s", (change) => {
    const born = (created: number): World => ({
      workspaces: [{ id: "w", name: "", tabs: [{ id: "tab", name: "", panes: [
        { id: "p", name: "shell", created }, { id: "other", name: "", created: 2 },
      ] }] }],
    });
    const menu = after(base, { type: "world", epoch: 1, world: born(1), at: AT }, { type: "action", action: "menu", at: AT });
    const top = menu.overlays.at(-1);
    if (top?.kind !== "menu") throw new Error("menu did not open");
    const changed = after(menu, { type: "world", epoch: change === "new connection" ? 2 : 1, world: born(change === "new connection" ? 1 : 3), at: AT });
    for (const action of ["close_pane", "rename_pane"]) {
      const row = top.entries.find((entry) => entry.kind === "action" && entry.action === action);
      if (!row?.label) throw new Error(`no label for ${action}`);
      const chosen = reduce(changed, text(row.label));
      expect([chosen.state.overlays.at(-1)?.kind, chosen.effects]).toEqual(["menu", []]);
    }
  });

  it("a digit goes to its place; Hangul typed under a Korean input method chooses nothing; the up arrow wraps to the last entry", () => {
    const tab = reduce(open, text("4")).state;
    expect([tab.overlays, tab.focus.workspace, tab.focus.tabs["w1"]]).toEqual([[], "w1", "t2"]);
    // the agent's pane is in the other workspace: its digit moves the focus there
    expect([open.focus.workspace, focusedPane(open)]).toEqual(["w1", "p1"]);
    const agent = reduce(open, text("7")).state;
    expect([agent.overlays, agent.focus.workspace, focusedPane(agent), agent.notices]).toEqual([[], "w2", "p4", []]);
    for (const typed of ["\u3141", "\ud55c", "\u3131\u314f"]) expect(reduce(open, text(typed)).state).toEqual(open);
    expect((reduce(open, named("ARROW_UP")).state.overlays.at(-1) as { cursor: number }).cursor).toBe(entries.length - 1);
  });
  it("an open menu follows the world: a new workspace is listed, and the cursor stays on the entry it was on", () => {
    const onTab = after(open, named("ARROW_DOWN"), named("ARROW_DOWN"), named("ARROW_DOWN"));
    const grown: World = { ...WORLD, workspaces: [...WORLD.workspaces, { id: "w3", name: "three", tabs: [{ id: "t9", name: "z", panes: [{ id: "p9", name: "" }] }] }] };
    const menu = after(onTab, { type: "world", world: grown, at: AT }).overlays.at(-1) as { entries: readonly MenuEntry[]; cursor: number };
    expect(menu.entries.slice(0, 4).map((entry) => [entry.kind, entry.kind === "action" ? entry.action : entry.id, entry.label])).toEqual([
      ["workspace", "w1", "1"], ["workspace", "w2", "2"], ["workspace", "w3", "3"], ["tab", "t1", "4"],
    ]);
    expect(menu.entries[menu.cursor]).toMatchObject({ kind: "tab", id: "t2" });
  });
});
