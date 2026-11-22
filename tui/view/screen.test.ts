import { describe, expect, it } from "bun:test";
import { PaneGrid, Styles } from "./grid.ts";
import { layOut, paneScene, SIDEBAR_COLUMNS } from "./screen.ts";

const split = { root: { split: "right" as const, ratio: 0.5, first: { leaf: "a" }, second: { leaf: "b" } }, zoomed: null };

describe("the shown tab laid out on the screen", () => {
  it("cuts the panes' region by the tab's tree, right of the sidebar and between the tab bar and the mode bar", () => {
    const shape = layOut(120, 40, split, { sidebarCollapsed: false });
    expect(shape.regions.panes).toEqual({ x: SIDEBAR_COLUMNS, y: 1, width: 120 - SIDEBAR_COLUMNS, height: 38 });
    expect(shape.spots.map(({ pane, covered, cells }) => [pane, covered, cells.outer.x, cells.outer.width])).toEqual([
      ["a", false, SIDEBAR_COLUMNS, 48], ["b", false, SIDEBAR_COLUMNS + 48, 48],
    ]);
  });

  it("gives the panes the sidebar's columns when it is collapsed, and at 64 columns or fewer", () => {
    expect(layOut(120, 40, split, { sidebarCollapsed: true }).regions.panes.x).toBe(0);
    expect(layOut(64, 20, split, { sidebarCollapsed: false }).regions.panes.x).toBe(0);
  });

  it("gives a zoomed pane the whole region and keeps the others at their cells, covered", () => {
    const shape = layOut(120, 40, { ...split, zoomed: "b" }, { sidebarCollapsed: false });
    expect(shape.spots.map(({ pane, covered, cells }) => [pane, covered, cells.outer.width])).toEqual([["a", true, 48], ["b", false, 96]]);
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
