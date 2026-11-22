import { describe, expect, it } from "bun:test";
import { type Focus, focused, nextFocus, type World } from "./focus.ts";

const pane = (id: string) => ({ id, name: "" });
const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [
      { id: "t1", name: "a", panes: [pane("p1"), pane("p2"), pane("p3")] },
      { id: "t2", name: "b", panes: [pane("p4")] },
      { id: "t3", name: "c", panes: [pane("p5")] },
    ] },
    { id: "w2", name: "two", tabs: [{ id: "t4", name: "d", panes: [pane("p6"), pane("p7")] }] },
    { id: "w3", name: "three", tabs: [{ id: "t5", name: "e", panes: [pane("p8")] }] },
  ],
};

/** The world without the workspace, tab or pane `id`. */
function without(world: World, id: string): World {
  return {
    workspaces: world.workspaces.filter((workspace) => workspace.id !== id).map((workspace) => ({
      ...workspace,
      tabs: workspace.tabs.filter((tab) => tab.id !== id).map((tab) => ({ ...tab, panes: tab.panes.filter((p) => p.id !== id) })),
    })),
  };
}

const at = (workspace: string, tab: string, paneId: string, previous: string | null = null): Focus =>
  ({ workspace, tabs: { [workspace]: tab }, panes: { [tab]: paneId }, previous });

describe("next focus", () => {
  const rows: { name: string; focus: Focus; closed: string[]; next: [string, string, string] | null; previous?: string | null }[] = [
    { name: "the previous pane when it is alive", focus: at("w1", "t1", "p3", "p1"), closed: ["p3"], next: ["w1", "t1", "p1"], previous: null },
    { name: "else the next pane in tree order", focus: at("w1", "t1", "p1"), closed: ["p1"], next: ["w1", "t1", "p2"] },
    { name: "else the tab's first pane", focus: at("w1", "t1", "p3"), closed: ["p3"], next: ["w1", "t1", "p1"] },
    { name: "a previous pane closed with it is not used", focus: at("w1", "t1", "p2", "p1"), closed: ["p2", "p1"], next: ["w1", "t1", "p3"], previous: null },
    { name: "a previous pane in another tab does not pull the pane focus there", focus: at("w1", "t1", "p1", "p4"), closed: ["p1"], next: ["w1", "t1", "p2"], previous: "p4" },
    { name: "a closed tab: the tab holding the previous pane", focus: at("w1", "t1", "p1", "p5"), closed: ["t1"], next: ["w1", "t3", "p5"], previous: null },
    { name: "a closed tab: else the next tab in order", focus: at("w1", "t1", "p1"), closed: ["t1"], next: ["w1", "t2", "p4"] },
    { name: "a closed last tab: the workspace's first", focus: at("w1", "t3", "p5"), closed: ["t3"], next: ["w1", "t1", "p1"] },
    { name: "a closed workspace: the workspace holding the previous pane", focus: at("w1", "t1", "p1", "p8"), closed: ["w1"], next: ["w3", "t5", "p8"], previous: null },
    { name: "a closed workspace: else the next in order", focus: at("w1", "t1", "p1"), closed: ["w1"], next: ["w2", "t4", "p6"] },
    { name: "a closed last workspace: the first", focus: at("w3", "t5", "p8"), closed: ["w3"], next: ["w1", "t1", "p1"] },
    { name: "a pane that is still there keeps focus", focus: at("w2", "t4", "p7", "p6"), closed: ["p1"], next: ["w2", "t4", "p7"], previous: "p6" },
    { name: "nothing left", focus: at("w1", "t1", "p1"), closed: ["w1", "w2", "w3"], next: null, previous: null },
  ];

  it("next focus", () => {
    for (const row of rows) {
      const after = row.closed.reduce(without, WORLD);
      const next = nextFocus(WORLD, after, row.focus);
      const shown = focused(after, next);
      const got = shown.pane === null ? null : [shown.workspace!.id, shown.tab!.id, shown.pane.id];
      expect({ name: row.name, got }).toEqual({ name: row.name, got: row.next });
      if (row.previous !== undefined) expect({ name: row.name, previous: next.previous }).toEqual({ name: row.name, previous: row.previous });
      // every remembered tab and pane exists in the new world
      for (const [workspace, tab] of Object.entries(next.tabs)) expect(after.workspaces.find((w) => w.id === workspace)?.tabs.some((t) => t.id === tab)).toBe(true);
      for (const [tab, paneId] of Object.entries(next.panes)) expect(after.workspaces.flatMap((w) => w.tabs).find((t) => t.id === tab)?.panes.some((p) => p.id === paneId)).toBe(true);
    }
  });

  it("is pure: the same answer twice, and its inputs unchanged", () => {
    const focus = Object.freeze(at("w1", "t1", "p2", "p1"));
    const after = without(WORLD, "p2");
    const copy = structuredClone({ WORLD, after, focus });
    expect(nextFocus(WORLD, after, focus)).toEqual(nextFocus(WORLD, after, focus));
    expect({ WORLD, after, focus }).toEqual(copy);
  });
});
