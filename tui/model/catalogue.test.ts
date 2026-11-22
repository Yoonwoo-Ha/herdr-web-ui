import { describe, expect, it } from "bun:test";
import { resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import { CATALOGUE } from "./catalogue.ts";
import type { World } from "./focus.ts";
import { initialState, reduce } from "./reduce.ts";

const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }, { id: "p2", name: "" }] }, { id: "t2", name: "b", panes: [{ id: "p3", name: "" }] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "" }] }] },
  ],
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
    // focus on p2, so p1 is the previous pane and index 2 names another tab and workspace
    const shown = reduce(initialState(undefined), { type: "world", world: WORLD, at: 0 }).state;
    const state = reduce(shown, { type: "select", target: { kind: "pane", id: "p2" }, at: 0 }).state;
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
