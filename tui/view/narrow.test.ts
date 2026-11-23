import { afterEach, describe, expect, it } from "bun:test";
import type { InputEvent } from "../input/decode.ts";
import type { World } from "../model/focus.ts";
import { MENU_ENTRIES } from "../model/menu.ts";

import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { agents } from "../testing/fixtures/agents.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";

const TEST_MS = 120_000;
const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function shown(cols: number, rows = 30): Promise<Run> {
  const run = await Run.start({ fixture: demo, cols, rows });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

const attached = (run: Run) => run.loop.panes.views().map((view) => view.terminal).sort();

describe("the screen at widths 45, 64 and 65: herdr's narrow layout at 64 columns or fewer, the sidebar from 65", () => {
  it("at 45 and 64 columns: herdr's two-row header with the switch button, and the tab's panes laid out as on a wide screen, all attached", async () => {
    for (const cols of [45, 64]) {
      const run = await shown(cols);
      const grid = run.grid();
      const box = cols - 10;
      expect(grid[0]!.slice(0, box + 1)).toBe(` · ovis${" ".repeat(box - 22)}tab main · 1/2 │`);
      expect(grid[1]!.slice(0, box + 8)).toBe(` No agents${" ".repeat(box - 10)}│ switch`);
      expect(grid[2]!.startsWith("┌ shell ")).toBe(true);
      expect(grid[2]!.includes("┐┌ files ")).toBe(true);
      expect(attached(run)).toEqual(["t1", "t2"]);
      expect(run.loop.screen()!.cols).toBe(cols);
    }
  }, TEST_MS);

  it("at 65 columns: the sidebar and the tab's two panes side by side, both attached", async () => {
    const run = await shown(65);
    const grid = run.grid();
    expect(grid[0]).toBe(" spaces                  │  main     logs    +");
    expect(grid[1]).toBe("                         │┌ shell ───────────┐┌ files ──────────┐");
    expect(attached(run)).toEqual(["t1", "t2"]);
  }, TEST_MS);

  it("the header counts the agents in each state and marks the switch button while one is blocked", async () => {
    const run = await Run.start({ fixture: agents, cols: 45, rows: 30 });
    runs.push(run);
    await run.live();
    await run.advance(10);
    expect(run.grid()[0]!.endsWith("│        ●")).toBe(true);
    expect(run.grid()[1]!.startsWith(" ! 1 Needs you · ")).toBe(true);
  }, TEST_MS);

  it("prefix+w, the menu's key and a tap on switch open herdr's switcher; the arrows and Enter, or a tap, go to a workspace or tab", async () => {
    const run = await shown(45);
    for (const open of ["ctrl+b,w", "ctrl+b,enter", "click@40:1"]) {
      await run.keys(open);
      await run.advance(10);
      expect({ open, overlays: run.loop.report().mode.overlays, title: run.grid()[0]!.startsWith(" switch") }).toEqual({ open, overlays: ["switcher"], title: true });
      await run.keys("esc");
      await run.advance(200);
    }
    // the cursor starts on the shown workspace; down goes to the next one, and Enter shows it
    await run.keys("ctrl+b,w,down,enter");
    await run.live();
    await run.advance(10);
    expect([run.loop.report().mode.overlays, run.loop.model().focus.workspace]).toEqual([[], "w-docs"]);
    await run.keys("ctrl+b,w");
    await run.advance(10);
    const row = run.grid().findIndex((line) => line.includes("+ new workspace"));
    // the second workspace's first row is two rows under its entry for a new workspace and one workspace's two rows
    await run.keys(`click@10:${row + 1}`);
    await run.live();
    await run.advance(10);
    expect([run.loop.report().mode.overlays, run.loop.model().focus.workspace]).toEqual([[], "w-ovis"]);
  }, TEST_MS);

  it("at 120 columns the sidebar's Menu button opens the menu, and its « collapses the sidebar", async () => {
    const run = await shown(120, 40);
    // the workspaces' footer, the last row of the sidebar's upper half, holds the menu button at its right
    await run.keys("click@22:19");
    await run.advance(10);
    expect(run.loop.report().mode.overlays).toEqual(["menu"]);
    await run.keys("esc");
    await run.advance(200);
    await run.keys("click@24:39");
    await run.advance(10);
    expect([run.loop.report().mode.overlays, run.loop.model().sidebarCollapsed]).toEqual([[], true]);
  }, TEST_MS);
});

describe("herdr's menu", () => {
  const AT = 1_000;
  const WORLD: World = { workspaces: [{ id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }] }] }] };
  const named = (name: string): InputEvent => ({ type: "key", key: name, mods: {}, action: "press", at: AT });
  const after = (state: ModelState, ...events: ModelEvent[]) => events.reduce((current, event) => reduce(current, event).state, state);
  const base = reduce(initialState(undefined), { type: "world", world: WORLD, at: 0 }).state;
  const open = after(base, { type: "action", action: "menu", at: AT });

  it("holds herdr's four entries; the arrows then Enter, or a click, do what the action itself does, and the up arrow wraps", () => {
    expect(MENU_ENTRIES).toEqual(["settings", "help", "reload_config", "detach"]);
    MENU_ENTRIES.forEach((action, at) => {
      const direct = reduce(base, { type: "action", action, at: AT });
      const chosen = reduce(after(open, ...Array.from({ length: at }, () => named("ARROW_DOWN"))), named("ENTER"));
      const clicked = reduce(open, { type: "choose", entry: at, at: AT });
      for (const [how, step] of [["keys", chosen], ["click", clicked]] as const) {
        expect({ action, how, state: step.state, effects: step.effects }).toEqual({ action, how, state: direct.state, effects: direct.effects });
      }
    });
    expect((reduce(open, named("ARROW_UP")).state.overlays.at(-1) as { cursor: number }).cursor).toBe(MENU_ENTRIES.length - 1);
  });
});
