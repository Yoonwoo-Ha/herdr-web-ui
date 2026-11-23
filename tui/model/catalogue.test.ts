import { describe, expect, it } from "bun:test";
import { resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import { CATALOGUE } from "./catalogue.ts";
import type { World } from "./focus.ts";
import { initialState, reduce } from "./reduce.ts";

const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{
      id: "t1", name: "a", panes: ["p6", "p1", "p2", "p5", "p7"].map((id) => ({ id, name: "" })),
      root: { split: "down", ratio: 0.25, first: { leaf: "p6" }, second: {
        split: "down", ratio: 0.66, first: {
          split: "right", ratio: 0.33, first: { leaf: "p1" }, second: {
            split: "right", ratio: 0.5, first: { leaf: "p2" }, second: { leaf: "p5" },
          },
        }, second: { leaf: "p7" },
      } },
    }, { id: "t2", name: "b", panes: [{ id: "p3", name: "" }] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "" }] }] },
  ],
  agents: ["p1", "p3", "p4"],
  waiting: ["p4"],
};

describe("the action catalogue", () => {
  it("catalogue", () => {
    const ids = resolveAllHerdrKeys(undefined).actions.map((action) => action.action);
    expect(ids).toHaveLength(52);
    const listed = CATALOGUE.map((entry) => entry.id);
    expect(listed.filter((id, i) => listed.indexOf(id) !== i)).toEqual([]);
    expect([...listed].sort()).toEqual([...ids].sort());
    expect(CATALOGUE.filter((entry) => entry.status === "parity" && entry.reason.trim() === "").map((entry) => entry.id)).toEqual([]);
  });

  it("a bound action that is not built shows one notice naming it, and a built one does something", () => {
    // p2 has neighbours on all four sides; p1 is previous, and index 2 names another tab and workspace
    const shown = reduce(initialState(undefined), { type: "world", world: WORLD, at: 0 }).state;
    const left = reduce(shown, { type: "select", target: { kind: "pane", id: "p1" }, at: 0 }).state;
    const state = reduce(left, { type: "select", target: { kind: "pane", id: "p2" }, at: 0 }).state;
    for (const entry of CATALOGUE) {
      const step = reduce(state, { type: "action", action: entry.id, index: 2, at: 10 });
      const notBuilt = step.state.notices.filter((notice) => notice.code === "not_built");
      if (entry.status === "parity") {
        expect({ id: entry.id, notices: notBuilt.map((notice) => notice.data) }).toEqual({ id: entry.id, notices: [{ action: entry.id }] });
        expect({ id: entry.id, effects: step.effects }).toEqual({ id: entry.id, effects: [] });
      } else {
        expect({ id: entry.id, notices: notBuilt }).toEqual({ id: entry.id, notices: [] });
        const changed = step.effects.length > 0 || JSON.stringify({ ...step.state, deadlines: [...step.state.deadlines] }) !== JSON.stringify({ ...state, deadlines: [...state.deadlines] });
        expect({ id: entry.id, changed }).toEqual({ id: entry.id, changed: true });
      }
    }
  });
});
