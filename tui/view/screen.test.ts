import { describe, expect, it } from "bun:test";
import { PaneGrid, Styles } from "./grid.ts";
import { layOut, paneScene, RAIL_COLUMNS, SIDEBAR_COLUMNS } from "./screen.ts";

const split = { root: { split: "right" as const, ratio: 0.5, first: { leaf: "a" }, second: { leaf: "b" } }, zoomed: null };

describe("the shown tab laid out on the screen", () => {
  it("cuts the panes' region by the tab's tree, right of the sidebar and under the tab bar, down to the last row", () => {
    const shape = layOut(120, 40, split, { sidebarCollapsed: false });
    expect(shape.regions.panes).toEqual({ x: SIDEBAR_COLUMNS, y: 1, width: 120 - SIDEBAR_COLUMNS, height: 39 });
    expect(shape.spots.map(({ pane, covered, cells }) => [pane, covered, cells.outer.x, cells.outer.width])).toEqual([
      ["a", false, SIDEBAR_COLUMNS, 47], ["b", false, SIDEBAR_COLUMNS + 47, 47],
    ]);
  });

  it("borders a split tab's panes, not a tab's only pane", () => {
    const alone = layOut(120, 40, { root: { leaf: "a" }, zoomed: null }, { sidebarCollapsed: false }).spots[0]!.cells;
    expect(alone.outer).toEqual({ x: SIDEBAR_COLUMNS, y: 1, width: 94, height: 39 });
    expect(alone.inner).toEqual({ x: SIDEBAR_COLUMNS, y: 1, width: 93, height: 39 });
    const zoomed = layOut(120, 40, { ...split, zoomed: "b" }, { sidebarCollapsed: false }).spots[1]!.cells;
    expect(zoomed.inner).toEqual({ x: SIDEBAR_COLUMNS + 1, y: 2, width: 91, height: 37 });
  });

  it("gives the panes all but the rail's columns when the sidebar is collapsed, and all at 64 columns or fewer", () => {
    expect(layOut(120, 40, split, { sidebarCollapsed: true }).regions.panes.x).toBe(RAIL_COLUMNS);
    expect(layOut(64, 20, split, { sidebarCollapsed: false }).regions.panes.x).toBe(0);
  });

  it("gives a zoomed pane the whole region and keeps the others at their cells, covered", () => {
    const shape = layOut(120, 40, { ...split, zoomed: "b" }, { sidebarCollapsed: false });
    expect(shape.spots.map(({ pane, covered, cells }) => [pane, covered, cells.outer.width])).toEqual([["a", true, 47], ["b", false, 94]]);
  });

  it("has no panes without a tab, and keeps every pane at least 1x1 on a tiny screen", () => {
    expect(layOut(120, 40, null, { sidebarCollapsed: false }).spots).toEqual([]);
    const tiny = layOut(1, 1, split, { sidebarCollapsed: false });
    for (const spot of tiny.spots) expect([spot.cells.cols, spot.cells.rows]).toEqual([1, 1]);
  });
});

describe("a pane as the frame draws it", () => {
  it("draws a terminal taller than its cells from the rows that hold the cursor (size.ts clipTop)", () => {
    const [spot] = layOut(120, 12, { root: { leaf: "a" }, zoomed: null }, { sidebarCollapsed: true }).spots;
    const grid = new PaneGrid(new Styles(), 118, 40);
    grid.cursor = { x: 0, y: 30, visible: true, style: "block", blinking: false } as PaneGrid["cursor"];
    const scene = paneScene(spot!, grid, { cols: 118, rows: 40 }, { live: true, hold: false });
    expect(scene.rect).toEqual(spot!.cells.inner);
    expect(scene.view).toEqual({ col: 0, row: 30 - spot!.cells.inner.height + 1 });
    expect(paneScene(spot!, grid, { cols: 118, rows: 5 }, { live: true, hold: false }).view).toEqual({ col: 0, row: 0 });
  });
});
