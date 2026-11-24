import { describe, expect, it } from "bun:test";
import { cachedPaneCells, orderedPaneCells, visitPaneTab } from "./paneTabCache.ts";

describe("pane tab cache", () => {
  const liveTabs = new Set(["a", "b", "c", "d", "e"]);
  it("keeps three previous tabs and promotes a return without duplicates", () => {
    const visits = ["d", "c", "b", "a"];
    expect(visitPaneTab(visits, "e", liveTabs)).toEqual(["e", "d", "c", "b"]);
    expect(visitPaneTab(visits, "b", liveTabs)).toEqual(["b", "d", "c", "a"]);
    expect(visitPaneTab(visits, "d", liveTabs)).toEqual(visits);
  });
  it("drops closed tabs and leaves unvisited tabs cold", () => {
    expect(visitPaneTab(["c", "b", "a"], "b", new Set(["a", "b", "d"]))).toEqual(["b", "a"]);
    expect(visitPaneTab([], "a", liveTabs)).toEqual(["a"]);
    expect(visitPaneTab(["a"], null, new Set())).toEqual([]);
  });
  it("preserves last geometry but drops closed, moved and never mounted panes", () => {
    const cell = { paneId: "a1", left: 0, top: 0, width: 100, height: 100, focused: true };
    const last = new Map([["a1", cell], ["closed", { ...cell, paneId: "closed" }], ["moved", { ...cell, paneId: "moved" }]]);
    const panes = [{ pane_id: "a1", tab_id: "a" }, { pane_id: "new", tab_id: "a" }, { pane_id: "moved", tab_id: "e" }];
    expect(cachedPaneCells(["b", "a"], "b", panes, last, new Set())).toEqual([cell]);
    expect(cachedPaneCells(["b", "a"], "b", panes, last, new Set(["a1"]))).toEqual([]);
    expect(cachedPaneCells(["a", "b"], "a", panes, last, new Set())).toEqual([]);
  });
  it("keeps PC canvas histories independent", () => {
    const first = visitPaneTab(["b"], "a", liveTabs);
    const second = visitPaneTab([], "c", liveTabs);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["c"]);
  });
  it("keeps a mounted pane's place on a tab switch, and follows the layout among the drawn frames", () => {
    const cell = (paneId: string) => ({ paneId });
    const ids = (cells: { paneId: string }[]) => cells.map((item) => item.paneId);
    // t2 presented after t1: t2 is drawn and t1 is cached, so t2 goes last instead of moving t1
    expect(ids(orderedPaneCells(["t1"], [cell("t2"), cell("t1")], new Set(["t2"])))).toEqual(["t1", "t2"]);
    // coming back: t1 is drawn in its own place and the cached t2 stays where it was
    expect(ids(orderedPaneCells(["t1", "t2"], [cell("t1"), cell("t2")], new Set(["t1"])))).toEqual(["t1", "t2"]);
    // a first render keeps the mount list's own order
    expect(ids(orderedPaneCells([], [cell("t2"), cell("t1")], new Set(["t2", "t1"])))).toEqual(["t2", "t1"]);
    // a split adds its pane last, moving nothing that is already mounted
    expect(ids(orderedPaneCells(["t1"], [cell("t1"), cell("t4")], new Set(["t1", "t4"])))).toEqual(["t1", "t4"]);
    // a split beside the first of two panes inserts the new frame between them, and moves neither
    expect(ids(orderedPaneCells(["t1", "t2"], [cell("t1"), cell("t4"), cell("t2")], new Set(["t1", "t4", "t2"])))).toEqual(["t1", "t4", "t2"]);
    // a swap exchanges the two drawn frames, so the Tab order follows the new left-to-right order
    expect(ids(orderedPaneCells(["t1", "t2"], [cell("t2"), cell("t1")], new Set(["t1", "t2"])))).toEqual(["t2", "t1"]);
  });
  it("moves no frame of another tab when the tab on the screen reorders its own", () => {
    const cell = (paneId: string) => ({ paneId });
    // React's rule for a keyed list (placeChild): a child is moved when one placed before it came later before
    const moved = (previous: readonly string[], next: readonly string[]): string[] => {
      const old = new Map(previous.map((id, index) => [id, index]));
      let last = 0;
      return next.filter((id) => {
        const at = old.get(id);
        if (at === undefined) return false;
        if (at < last) return true;
        last = at;
        return false;
      });
    };
    const order = (previous: string[], layout: string[], cached: string[]) =>
      orderedPaneCells(previous, [...layout, ...cached].map(cell), new Set(layout)).map((item) => item.paneId);
    // a swap of a and s while tab b's frame sits between them
    const swapped = order(["a", "b", "s"], ["s", "a"], ["b"]);
    expect(swapped.filter((id) => id !== "b")).toEqual(["s", "a"]);
    expect(moved(["a", "b", "s"], swapped)).not.toContain("b");
    // a layout edit that turns three drawn frames around, with a cached frame among them
    const turned = order(["a", "b", "c", "d"], ["d", "a", "c"], ["b"]);
    expect(turned.filter((id) => id !== "b")).toEqual(["d", "a", "c"]);
    expect(moved(["a", "b", "c", "d"], turned)).not.toContain("b");
  });
});
