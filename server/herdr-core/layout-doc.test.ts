import { describe, expect, it } from "bun:test";
import { type LayoutNode, parseOvisLayout, place, reconcile, resizeLeaf } from "./layout-doc.ts";

const leaf = (address: string): LayoutNode => ({ leaf: address });
const split = (direction: "right" | "down", ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: direction, ratio, first, second });

describe("place", () => {
  it("keeps every pane of a deep split at least one unit wide", () => {
    let root = leaf("p6");
    for (const address of ["p5", "p4", "p3", "p2", "p1"]) root = split("right", 0.1, root, leaf(address));
    const widths = place(root, { x: 0, y: 0, width: 6, height: 1 }).panes.map((pane) => pane.rect.width);
    expect(widths).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("reconcile", () => {
  it("places a pane the document names twice once, drops a gone one and adds a new one to the right", () => {
    const doc = { schema: 1 as const, workspaces: [{ id: "S", tabs: [{ id: "T", zoomed: "gone", root: split("down", 0.5, split("right", 0.5, leaf("a"), leaf("a")), leaf("gone")) }] }] };
    const [tab] = reconcile(doc, [{ id: "S", tabs: [{ id: "T", panes: ["a", "b"] }] }]).workspaces[0]!.tabs;
    expect(tab).toEqual({ id: "T", zoomed: null, root: split("right", 0.5, leaf("a"), leaf("b")) });
  });
});

describe("the terminal screen's own keys", () => {
  it("keeps a tab's passthrough panes and a folded group through a read and a reconcile, and drops a pane gone from the tab", () => {
    const doc = parseOvisLayout({ schema: 1, workspaces: [{ id: "S", collapsed: true, tabs: [{ id: "T", zoomed: null, root: split("right", 0.5, leaf("a"), leaf("b")), passthrough: ["a", "gone", 7] }] }, { id: "U", tabs: [{ id: "V", zoomed: null, root: leaf("c") }] }] });
    expect(doc?.workspaces.map((workspace) => [workspace.collapsed, workspace.tabs[0]!.passthrough])).toEqual([[true, ["a", "gone"]], [undefined, undefined]]);
    const kept = reconcile(doc, [{ id: "S", tabs: [{ id: "T", panes: ["a", "b"] }] }, { id: "U", tabs: [{ id: "V", panes: ["c"] }] }]);
    expect(kept.workspaces[0]).toEqual({ id: "S", collapsed: true, tabs: [{ id: "T", zoomed: null, root: split("right", 0.5, leaf("a"), leaf("b")), passthrough: ["a"] }] });
    // a document without them stays as it was written: no key is added
    expect(kept.workspaces[1]).toEqual({ id: "U", tabs: [{ id: "V", zoomed: null, root: leaf("c") }] });
  });
});

describe("a pane's own setting", () => {
  it("follows the pane to the tab that holds it now, and stays there when the document is read again", () => {
    const doc = parseOvisLayout({ schema: 1, workspaces: [
      { id: "S", tabs: [{ id: "T", zoomed: null, root: split("right", 0.5, leaf("a"), leaf("b")), passthrough: ["b"] }] },
      { id: "U", tabs: [{ id: "V", zoomed: null, root: leaf("c"), passthrough: ["c"] }] },
    ] });
    // b's labels place it in a new tab of U now: the document was not written for that
    const shown = [{ id: "S", tabs: [{ id: "T", panes: ["a"] }] }, { id: "U", tabs: [{ id: "V", panes: ["c"] }, { id: "M", panes: ["b"] }] }];
    const moved = reconcile(doc, shown);
    expect(moved.workspaces.map((workspace) => workspace.tabs.map((tab) => [tab.id, tab.passthrough]))).toEqual([[["T", undefined]], [["V", ["c"]], ["M", ["b"]]]]);
    expect(reconcile(parseOvisLayout(JSON.parse(JSON.stringify(moved))), shown)).toEqual(moved);
    // a pane that left every tab Ovis lays out takes its setting with it: nothing is kept for a pane the document cannot hold
    expect(reconcile(doc, [{ id: "S", tabs: [{ id: "T", panes: ["a"] }] }, { id: "U", tabs: [{ id: "V", panes: ["c"] }] }]).workspaces[0]!.tabs[0]).toEqual({ id: "T", zoomed: null, root: leaf("a") });
  });
});

describe("resizeLeaf", () => {
  it("moves the nearest split whose cut is the pane's edge, else the one on its other side", () => {
    const root = split("right", 0.5, leaf("a"), split("down", 0.5, leaf("b"), leaf("c")));
    expect(resizeLeaf(root, "b", "right", 0.1)).toEqual(split("right", 0.6, leaf("a"), split("down", 0.5, leaf("b"), leaf("c"))));
    expect(resizeLeaf(root, "b", "down", 0.1)).toEqual(split("right", 0.5, leaf("a"), split("down", 0.6, leaf("b"), leaf("c"))));
    expect(resizeLeaf(split("right", 0.9, leaf("a"), leaf("b")), "a", "right", 0.1)).toBeNull();
  });
});
