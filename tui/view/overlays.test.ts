import { afterEach, describe, expect, it } from "bun:test";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVERLAYS } from "../model/overlays.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";
import { SIDEBAR_COLUMNS } from "./screen.ts";

const TEST_MS = 120_000;

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function start(core?: FakeHcCore, cols = 120, rows = 40): Promise<Run> {
  if (core) demo.build(core);
  const run = await Run.start({ fixture: demo, ...(core ? { core } : {}), cols, rows });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

/**
 * Each overlay kind, the action that opens it, the control a tap closes it with and the keys that close it: written out
 * here. A dialog drawn as herdr's (the text field, the confirm) closes by its cancel button, the help by its close
 * button; herdr's menu and picker have no close control.
 */
const KINDS = [
  { kind: "help", action: "help", control: "  esc close  ", keys: ["esc", "enter"] },
  { kind: "text", action: "rename_tab", control: " esc cancel ", keys: ["esc"] },
  { kind: "confirm", action: "close_workspace", control: " esc cancel ", keys: ["esc", "n"] },
  { kind: "goto", action: "goto", control: null, keys: ["esc"] },
  { kind: "menu", action: "menu", control: null, keys: ["esc"] },
  // herdr's switcher: what the menu's key opens on a narrow screen
  { kind: "switcher", action: "menu", control: "close", keys: ["esc"], narrow: true },
  // herdr's right-click menu, and Open worktree... with the checkouts the loop read: no close control, as herdr's
  { kind: "context", event: "context", control: null, keys: ["esc"] },
  { kind: "worktrees", event: "worktrees", control: " esc cancel ", keys: ["esc"] },
] as const;

/** Opens a row's overlay: by its action, or by the event that opens it (a right press, the checkouts read). */
function open(run: Run, row: (typeof KINDS)[number]): void {
  const at = run.clock.current;
  const target = { kind: "workspace" as const, id: run.loop.model().world.workspaces[0]!.id };
  if (!("event" in row)) run.loop.dispatch({ type: "action", action: row.action, at });
  else if (row.event === "context") run.loop.dispatch({ type: "context", target, cell: { x: 2, y: 2 }, at });
  else run.loop.dispatch({ type: "worktrees", target, checkouts: [{ path: "/repo", label: "main", open: null }], at });
}

describe("the overlays' close keys", () => {
  it("every overlay registry entry shows its close control, and each of its close keys closes it", async () => {
    // a kind added to the registry without a row here fails this line
    expect(Object.keys(OVERLAYS).sort()).toEqual(KINDS.map(({ kind }) => kind).sort());
    const wide = await start();
    const narrow = await start(undefined, 45, 30);
    for (const row of KINDS) {
      const { kind, control, keys } = row;
      const run = "narrow" in row ? narrow : wide;
      for (const key of keys) {
        open(run, row);
        await run.advance(20);
        expect({ kind, open: run.loop.model().overlays.map((overlay) => overlay.kind) }).toEqual({ kind, open: [kind] });
        if (control !== null) expect({ kind, drawn: run.grid().some((line) => line.includes(control)) }).toEqual({ kind, drawn: true });
        await run.keys(key);
        await run.advance(200);
        expect({ kind, key, open: run.loop.model().overlays.length }).toEqual({ kind, key, open: 0 });
      }
    }
  }, TEST_MS);

  it("a tap on the close control closes every overlay kind at 45 columns, with no call to the core and no focus change", async () => {
    const run = await start(undefined, 45, 30);
    // the seen marker reads a terminal after any input (terminal.get); nothing else may be asked
    const calls = () => run.core.calls().map((call) => call.method).filter((method) => method !== "machine.list" && method !== "terminal.get");
    await run.keys("x");
    await run.advance(200);
    const focus = JSON.stringify(run.loop.model().focus);
    for (const kindRow of KINDS) {
      const { kind, control } = kindRow;
      if (control === null) continue;
      open(run, kindRow);
      await run.advance(20);
      const before = calls();
      const row = run.grid().findIndex((line) => line.includes(control));
      expect({ kind, drawn: row >= 0 }).toEqual({ kind, drawn: true });
      await run.keys(`click@${run.grid()[row]!.indexOf(control) + 1}:${row}`);
      await run.advance(20);
      expect({ kind, open: run.loop.model().overlays.length, calls: calls(), focus: JSON.stringify(run.loop.model().focus) }).toEqual({ kind, open: 0, calls: before, focus });
    }
  }, TEST_MS);

  it("a dialog's buttons do what their keys do: clear empties the field, save renames, cancel closes with nothing written", async () => {
    const run = await start();
    const field = () => (run.loop.model().overlays.at(-1) as { field?: { graphemes: readonly string[] } } | undefined)?.field?.graphemes.join("") ?? null;
    const button = (text: string) => {
      const row = run.grid().findIndex((line) => line.includes(text));
      return `click@${run.grid()[row]!.indexOf(text) + 2}:${row}`;
    };
    await run.keys("ctrl+b,T");
    await run.advance(20);
    // the tab's name in the field, the cursor after it, nothing selected
    expect(field()).toBe("main");
    await run.keys(button("^c clear"));
    await run.advance(20);
    expect(field()).toBe("");
    await run.keys("x,y");
    await run.keys(button("↵ save"));
    await run.advance(50);
    expect(run.loop.model().overlays).toEqual([]);
    expect(run.loop.model().world.workspaces[0]!.tabs[0]!.name).toBe("xy");
    const before = run.core.calls().length;
    await run.keys("ctrl+b,T");
    await run.advance(20);
    await run.keys(button("esc cancel"));
    await run.advance(20);
    expect({ open: run.loop.model().overlays.length, name: run.loop.model().world.workspaces[0]!.tabs[0]!.name }).toEqual({ open: 0, name: "xy" });
    expect(run.core.calls().slice(before).filter((call) => call.method !== "machine.list" && call.method !== "terminal.get")).toEqual([]);
  }, TEST_MS);

  it("a new tab's field holds the number it will have; the tab bar's + opens it too", async () => {
    const run = await start();
    const row = run.grid()[0]!;
    await run.keys(`click@${row.indexOf("+")}:0`);
    await run.advance(20);
    expect(run.loop.model().overlays.at(-1)).toMatchObject({ kind: "text", purpose: "new_tab", field: { graphemes: ["3"], cursor: 1 } });
  }, TEST_MS);

  it("the tab bar's scroll buttons step to the tab before and after the one in front", async () => {
    const core = new FakeHcCore();
    for (let n = 0; n < 9; n++) place(core, { space: "w", spaceName: "work", tab: `tab${n}`, tabName: `tab-${n}` }, "ready\r\n");
    const run = await Run.start({ core, cols: 70, rows: 20 });
    runs.push(run);
    await run.live();
    const tab = () => run.loop.model().focus.tabs["w"];
    expect(tab()).toBe("tab0");
    const row = run.grid()[0]!;
    await run.keys(`click@${row.indexOf(" > ") + 1}:0`);
    await run.live();
    expect(tab()).toBe("tab1");
    await run.keys(`click@${row.indexOf(" < ") + 1}:0`);
    await run.live();
    expect(tab()).toBe("tab0");
  }, TEST_MS);

  it("a locked screen unlocks by a tap on its LOCKED badge when the chord cannot be typed", async () => {
    const run = await start();
    run.loop.dispatch({ type: "action", action: "lock", at: run.clock.current });
    await run.advance(20);
    expect(run.loop.model().locked).toBe(true);
    // the mode bar lies over the panes' last row, right of the sidebar
    await run.keys(`click@${SIDEBAR_COLUMNS + 1}:${run.grid().length - 1}`);
    await run.advance(20);
    expect(run.loop.model().locked).toBe(false);
  }, TEST_MS);

});
