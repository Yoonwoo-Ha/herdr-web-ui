import { afterEach, expect, it } from "bun:test";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

const layout = (ratio: number) => ({
  schema: 1, workspaces: [{ id: "w", tabs: [{
    id: "tab", zoomed: null,
    root: { split: "right", ratio: 0.5, first: { leaf: "t1" },
      second: { split: "down", ratio, first: { leaf: "t2" }, second: { leaf: "t3" } } },
  }] }],
});

// t1 beside t2 over t3: the pane right of t1 is t2 while the lower split's ratio is 0.75, and t3 once it is 0.25
it.each([
  ["focus_pane_right", "\x02l", "unchanged"], ["focus_pane_right", "\x02l", "changed before the key"],
  ["swap_pane_right", "\x02L", "unchanged"], ["swap_pane_right", "\x02L", "changed before the key"],
  ["swap_pane_right", "\x02L", "changed during the write"],
] as const)("%s acts on the neighbour its key found, across a ratio change: %s", async (action, key, ordering) => {
  const core = new FakeHcCore();
  for (const pane of ["A", "B", "C"]) place(core, { space: "w", spaceName: "w", tab: "tab", tabName: "tab", pane }, "$ ");
  core.docs.set(OVIS_LAYOUT_DOC, { value: layout(0.75), version: 1 });
  const run = await Run.start({ core, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  const call = run.loop.link.call.bind(run.loop.link);
  const change = () => call("doc.set", { name: OVIS_LAYOUT_DOC, value: layout(0.25), version: 1 });
  if (ordering === "changed before the key") {
    await change();
    await run.settle();
  } else if (ordering === "changed during the write") {
    run.loop.link.call = async (method, params, timeout) => {
      if (method === "doc.get" && "name" in params && params.name === OVIS_LAYOUT_DOC) {
        run.loop.link.call = call;
        await change();
      }
      return call(method, params, timeout);
    };
  }
  run.type(key);
  await run.advance(200);
  // the swap carries the neighbour the key found: on a document that names another one by then, it swaps nothing
  const refused = ordering === "changed during the write";
  const writes = core.calls().filter((request) => request.method === "doc.set").length;
  expect(writes).toBe(Number(ordering !== "unchanged") + Number(action === "swap_pane_right" && !refused));
  if (action === "focus_pane_right") {
    expect(run.loop.model().focus.panes["tab"]).toBe(ordering === "unchanged" ? "t2" : "t3");
  } else {
    expect(run.loop.model().world.workspaces[0]?.tabs[0]?.panes.map((pane) => pane.id))
      .toEqual(refused ? ["t1", "t2", "t3"] : ordering === "unchanged" ? ["t2", "t1", "t3"] : ["t3", "t2", "t1"]);
  }
}, 60_000);
