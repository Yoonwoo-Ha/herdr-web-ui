import { afterEach, expect, it } from "bun:test";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { FRAME_PASS_MS } from "../model/deadlines.ts";
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

it.each([
  ["focus_pane_right", "unchanged"], ["focus_pane_right", "before selection"], ["focus_pane_right", "after repaint"],
  ["swap_pane_right", "unchanged"], ["swap_pane_right", "before selection"], ["swap_pane_right", "after repaint"],
  ["swap_pane_right", "during apply"],
] as const)("a presented %s keeps its resolved neighbour across a ratio change: %s", async (action, ordering) => {
  const core = new FakeHcCore();
  for (const pane of ["A", "B", "C"]) place(core, { space: "w", spaceName: "w", tab: "tab", tabName: "tab", pane }, "$ ");
  core.docs.set(OVIS_LAYOUT_DOC, { value: layout(0.75), version: 1 });
  const run = await Run.start({ core, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  run.type("\x02\r");
  await run.advance(FRAME_PASS_MS);
  const menu = run.loop.model().overlays.at(-1);
  if (menu?.kind !== "menu") throw new Error("menu did not open");
  const entry = menu.entries.find((candidate) => candidate.kind === "action" && candidate.action === action);
  if (!entry?.label) throw new Error("directional action has no label");
  const call = run.loop.link.call.bind(run.loop.link);
  const change = () => call("doc.set", { name: OVIS_LAYOUT_DOC, value: layout(0.25), version: 1 });
  if (ordering === "before selection" || ordering === "after repaint") {
    await change();
    await run.settle();
    if (ordering === "after repaint") await run.advance(FRAME_PASS_MS);
  } else if (ordering === "during apply") {
    run.loop.link.call = async (method, params, timeout) => {
      if (method === "doc.get" && "name" in params && params.name === OVIS_LAYOUT_DOC) {
        run.loop.link.call = call;
        await change();
      }
      return call(method, params, timeout);
    };
  }
  run.type(entry.label);
  await run.advance(200);
  const refused = ordering === "before selection" || ordering === "during apply";
  const writes = core.calls().filter((request) => request.method === "doc.set").length;
  expect(writes).toBe(Number(ordering !== "unchanged") + Number(action === "swap_pane_right" && !refused));
  if (action === "focus_pane_right") {
    expect(run.loop.model().focus.panes["tab"]).toBe(refused ? "t1" : ordering === "after repaint" ? "t3" : "t2");
  } else {
    expect(run.loop.model().world.workspaces[0]?.tabs[0]?.panes.map((pane) => pane.id))
      .toEqual(refused ? ["t1", "t2", "t3"] : ordering === "after repaint" ? ["t3", "t2", "t1"] : ["t2", "t1", "t3"]);
  }
}, 60_000);
