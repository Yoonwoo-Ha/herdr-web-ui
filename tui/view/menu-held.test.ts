import { afterEach, expect, it } from "bun:test";
import { editLayout, passthroughEdit } from "../../server/herdr-core/layout-ops.ts";
import { PANE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { BEHIND_WRITE_EVENTS, FRAME_PASS_MS, QUIT_BOUND_MS } from "../model/deadlines.ts";
import { STRINGS } from "../strings.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
const replies: (() => void)[] = [];
afterEach(async () => {
  for (const reply of replies.splice(0)) reply();
  for (const run of runs.splice(0)) await run.close();
});

const hex = (text: string) => Buffer.from(text).toString("hex");

/**
 * The demo with a rename of its first pane written and not yet answered: every read from here meets the hold. `mouse`:
 * the pane's program asked for the mouse and got a middle press at its cell (5, 3), still held (a right press would open
 * the pane's menu instead). `prepare`: what the test sets up before the rename is written.
 */
async function heldRename(mouse = false, cols = 120, prepare?: (run: Run) => Promise<void>) {
  const run = await Run.start({ fixture: demo, cols, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  await prepare?.(run);
  if (mouse) {
    run.core.program("t1").output("\x1b[?1002h\x1b[?1006h");
    await run.advance(20);
    run.type("\x1b[<1;33;6M");
    await run.settle();
  }
  const written = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  replies.push(answer.resolve);
  const call = run.loop.link.call.bind(run.loop.link);
  run.loop.link.call = async (method, params, timeout) => {
    if (method === "terminal.label" && "labels" in params && params.labels && Object.hasOwn(params.labels, PANE_NAME_LABEL)) {
      run.loop.link.call = call;
      const result = await call(method, params, timeout);
      written.resolve();
      await answer.promise;
      return result;
    }
    return call(method, params, timeout);
  };
  run.type("\x02Prenamed\r");
  await written.promise;
  await run.advance(20);
  return { run, answer: answer.resolve };
}

function click(run: Run, text: string): string {
  const grid = run.grid();
  const row = grid.findIndex((line) => line.includes(text));
  expect(row).toBeGreaterThan(0);
  const col = grid[row]!.indexOf(text);
  return `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`;
}

const bytes = (run: Run) => ["t1", "t2"].map((id) => run.core.program(id).receivedHex());
const busy = (run: Run) => run.loop.model().notices.filter((notice) => notice.code === "layout_busy");
const PRESS = "\x1b[<1;6;4M";

it.each(["a letter", "arrows and Enter", "Reload key", "Reload click", "Escape", "row click", "wheel"])(
  "held menu input is refused once and never replayed: %s", async (input) => {
    const { run, answer } = await heldRename();
    run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
    await run.advance(FRAME_PASS_MS);
    const menu = run.loop.model().overlays.at(-1);
    if (menu?.kind !== "menu") throw new Error("menu did not open");
    const typed = input === "a letter" ? "x" : input === "arrows and Enter" ? "\x1b[B\x1b[B\r" : input === "Reload key" ? "\x02R"
      : input === "Reload click" ? click(run, STRINGS.menuEntries.reload_config) : input === "Escape" ? "\x1b[27u"
      : input === "row click" ? click(run, STRINGS.menuEntries.settings) : "\x1b[<64;40;20M";
    run.type(typed);
    await run.settle();
    const once = busy(run);
    expect(once).toHaveLength(1);
    run.type(typed);
    await run.settle();
    expect(run.loop.model().overlays.at(-1)).toEqual(menu);
    expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
    expect(bytes(run)).toEqual(["", ""]);
    expect(busy(run)).toEqual(once);
    expect(run.loop.report().actions).not.toContain("reload_keys");
    answer();
    await run.settle();
    // Settling the write alone does not unlock the overlay, including input during frame acceptance.
    run.type("\r");
    let during = false;
    run.host.duringNextWrite(() => { during = true; run.type("\r"); });
    run.core.program("t1").output("frame");
    await run.advance(200);
    expect(during).toBe(true);
    expect(run.loop.model().overlays.at(-1)).toEqual(menu);
    expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
    expect(bytes(run)).toEqual(["", ""]);
    expect(busy(run)).toEqual(once);
    // the frame after the write was taken: Enter chooses the menu's first entry (settings, not built), and text goes on to the pane
    run.type("\rz");
    await run.settle();
    expect(run.loop.report().mode.overlays).toEqual([]);
    expect(run.loop.model().notices.map((notice) => notice.code)).toContain("not_built");
    expect(bytes(run)).toEqual(["7a", ""]);
  }, 60_000);

it.each(["confirm", "navigate", "help", "text"] as const)("a held %s keeps its state and resumes after an accepted frame", async (kind) => {
  const { run, answer } = await heldRename();
  const action = kind === "confirm" ? "close_workspace" : kind === "navigate" ? "workspace_picker" : kind === "help" ? "help" : "rename_pane";
  run.loop.dispatch({ type: "action", action, at: run.clock.current });
  await run.advance(FRAME_PASS_MS);
  const { overlays, mode, focus } = run.loop.model();
  run.type("1jy\r\x1b[27u\x1b[B");
  run.type("1jy\r\x1b[27u\x1b[B");
  await run.settle();
  expect({ overlays: run.loop.model().overlays, mode: run.loop.model().mode, focus: run.loop.model().focus }).toEqual({ overlays, mode, focus });
  expect(busy(run)).toHaveLength(1);
  expect(bytes(run)).toEqual(["", ""]);
  answer();
  await run.advance(200);
  expect({ overlays: run.loop.model().overlays, mode: run.loop.model().mode }).toEqual({ overlays, mode });
  run.type("\x1b[27u");
  await run.settle();
  expect(run.loop.report().mode.overlays).toEqual([]);
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(run.core.calls().filter((call) => call.method === "terminal.kill" || call.method === "terminal.rm")).toEqual([]);
}, 60_000);

it.each(["~R", "~\r", "~w", "~D", "~P", "~x"])("a refused shortcut preserves plain text in the same read: %s", async (shortcut) => {
  const { run, answer } = await heldRename();
  run.loop.dispatch({ type: "keys", keys: { prefix: "~" }, at: run.clock.current });
  run.type(`a${shortcut}b`);
  await run.settle();
  expect(bytes(run)).toEqual(["", ""]);
  expect(run.loop.report().mode.overlays).toEqual([]);
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(busy(run)).toHaveLength(1);
  expect(run.loop.report().actions).not.toContain("reload_keys");
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual(["6162", ""]);
  expect(run.loop.report().actions).not.toContain("reload_keys");
  run.type("c");
  await run.settle();
  expect(bytes(run)).toEqual(["616263", ""]);
}, 60_000);

it.each([120, 60])("a refusal is on the screen once, in the notices' box, however often it is asked again: %s columns", async (cols) => {
  const { run } = await heldRename(false, cols);
  run.type("\x02w");
  run.type("\x02?");
  await run.advance(FRAME_PASS_MS);
  expect(busy(run)).toHaveLength(1);
  expect(run.grid().join("\n").split("layout_busy").length - 1).toBe(1);
  expect(run.loop.report().mode.overlays).toEqual([]);
}, 60_000);

/** a right press and its release in the first pane's text, where its box's menu opens */
const RIGHT_CLICK = "\x1b[<2;33;6M\x1b[<2;33;6m";

it("a right-click that opens a menu, read during a write, is refused once and opens nothing after it", async () => {
  const { run, answer } = await heldRename();
  run.type(RIGHT_CLICK);
  await run.settle();
  expect([run.loop.report().mode.overlays, busy(run).map((notice) => notice.data)]).toEqual([[], [{ action: "context" }]]);
  // a tab's and a workspace's row are the same, and say nothing more
  const grid = run.grid();
  const row = grid.findIndex((line) => line.includes("문서"));
  expect(row).toBeGreaterThan(0);
  run.type(`\x1b[<2;${grid[row]!.indexOf("문서") + 1};${row + 1}M\x1b[<2;${grid[row]!.indexOf("문서") + 1};${row + 1}m`);
  run.type(RIGHT_CLICK);
  await run.settle();
  expect([run.loop.report().mode.overlays, busy(run)]).toEqual([[], busy(run).slice(0, 1)]);
  answer();
  await run.advance(200);
  expect([run.loop.report().mode.overlays, run.loop.report().actions.filter((action) => action.startsWith("context:")), bytes(run)]).toEqual([[], [], ["", ""]]);
  // the write is done and its frame taken: the same press opens the pane's menu
  run.type(RIGHT_CLICK);
  await run.settle();
  expect(run.loop.report().mode.overlays).toEqual(["context"]);
}, 60_000);

it("a refused right-click takes no place among what waits: all the text read around it arrives", async () => {
  const { run, answer } = await heldRename();
  for (let index = 0; index < BEHIND_WRITE_EVENTS - 2; index++) run.type("x");
  run.type(RIGHT_CLICK);
  run.type("Y");
  await run.settle();
  expect(run.loop.model().notices.map((notice) => notice.code)).toEqual(["layout_busy"]);
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual([hex("x".repeat(BEHIND_WRITE_EVENTS - 2) + "Y"), ""]);
  expect(run.loop.report().mode.overlays).toEqual([]);
}, 60_000);

it("a right-click for a program that takes right presses still waits behind the write and reaches it, with no notice", async () => {
  const { run, answer } = await heldRename(false, 120, async (run) => {
    run.core.program("t1").output("\x1b[?1002h\x1b[?1006h");
    await editLayout(run.loop.link, passthroughEdit("t1", true));
    await run.advance(20);
  });
  run.type(RIGHT_CLICK);
  await run.settle();
  expect([run.loop.report().mode.overlays, busy(run), bytes(run)]).toEqual([[], [], ["", ""]]);
  answer();
  await run.advance(200);
  expect([run.loop.report().mode.overlays, busy(run), bytes(run)]).toEqual([[], [], [hex("\x1b[<2;6;4M\x1b[<2;6;4m"), ""]]);
}, 60_000);

it("refused overlay input never occupies the bounded pane-input queue", async () => {
  const { run, answer } = await heldRename();
  run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
  await run.advance(FRAME_PASS_MS);
  for (let index = 0; index <= BEHIND_WRITE_EVENTS; index++) run.type("x");
  await run.settle();
  expect(run.loop.model().notices.map((notice) => notice.code)).toEqual(["layout_busy"]);
  answer();
  await run.advance(200);
  expect(run.loop.report().mode.overlays).toEqual(["menu"]);
  expect(bytes(run)).toEqual(["", ""]);
  run.type("\rz");
  await run.settle();
  expect(bytes(run)).toEqual(["7a", ""]);
}, 60_000);

it("the pointer passing with no button held takes no place in what waits: text typed after it still arrives", async () => {
  const { run, answer } = await heldRename();
  for (let index = 0; index <= BEHIND_WRITE_EVENTS; index++) run.type(`\x1b[<35;${30 + (index % 40)};20M`);
  run.type("a");
  await run.settle();
  expect(run.loop.model().notices).toEqual([]);
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual(["61", ""]);
}, 60_000);

it("plain text paste and keys still wait exactly once behind a rename", async () => {
  const { run, answer } = await heldRename();
  run.type("text\x1b[200~paste\x1b[201~\r");
  await run.settle();
  expect(bytes(run)).toEqual(["", ""]);
  expect(busy(run)).toEqual([]);
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual([hex("textpaste\r"), ""]);
}, 60_000);

it.each(["joined", "split"])("detach crosses a held overlay without waiting: %s", async (ordering) => {
  const { run } = await heldRename();
  run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
  await run.advance(FRAME_PASS_MS);
  if (ordering === "joined") run.type("\x02q");
  else {
    run.type("\x02");
    run.type("q");
  }
  await run.advance(QUIT_BOUND_MS + 100);
  expect(await run.loop.done).toMatchObject({ kind: "quit" });
  expect(bytes(run)).toEqual(["", ""]);
}, 60_000);

it.each(["after the menu's first paint", "before the menu's first paint"])("a program's held button survives a held menu and keeps its queued physical coordinates: %s", async (ordering) => {
  const { run, answer } = await heldRename(true);
  run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
  if (ordering === "before the menu's first paint") {
    // the drag and release are read against the grab, not against the overlay that paints next
    run.type("\x1b[<33;34;6M\x1b[<1;35;6m");
    await run.settle();
    await run.advance(FRAME_PASS_MS);
    expect(busy(run)).toEqual([]);
  } else {
    await run.advance(FRAME_PASS_MS);
    run.type(click(run, STRINGS.menuEntries.settings));
    await run.settle();
    expect(bytes(run)).toEqual([hex(PRESS), ""]);
    run.type("\x1b[<33;34;6M\x1b[<1;35;6m");
    await run.settle();
    expect(busy(run)).toHaveLength(1);
  }
  expect(bytes(run)).toEqual([hex(PRESS), ""]);
  answer();
  await run.advance(200);
  expect(run.loop.report().mode.overlays).toEqual(["menu"]);
  const gesture = hex(PRESS + "\x1b[<33;7;4M\x1b[<1;8;4m");
  expect(bytes(run)).toEqual([gesture, ""]);
  run.type("\x1b[<1;36;6m");
  await run.settle();
  expect(bytes(run)).toEqual([gesture, ""]);
}, 60_000);

it.each(["joined", "split"])("pane input read before a menu opened replays to the pane, never through the menu: %s", async (ordering) => {
  const { run, answer } = await heldRename();
  if (ordering === "joined") run.type("\rz");
  else {
    run.type("\r");
    run.type("z");
  }
  await run.settle();
  // the menu opens before the write settles: Enter chooses in it now, but it was pane input when it was read
  run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
  await run.advance(FRAME_PASS_MS);
  expect(run.loop.report().mode.overlays).toEqual(["menu"]);
  expect(bytes(run)).toEqual(["", ""]);
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual([hex("\rz"), ""]);
  expect(run.loop.report().mode.overlays).toEqual(["menu"]);
  expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
}, 60_000);

it("a click on a menu row the accepted frame still shows is refused, and a program's held button ends only at its own release", async () => {
  const { run, answer } = await heldRename(true);
  run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
  await run.advance(FRAME_PASS_MS);
  const row = click(run, STRINGS.menuEntries.settings);
  // the model closes the menu; no frame since, so the screen still shows its rows
  run.loop.dispatch({ type: "close_overlay", at: run.clock.current });
  expect(run.loop.report().mode.overlays).toEqual([]);
  run.type(row);
  await run.settle();
  expect(bytes(run)).toEqual([hex(PRESS), ""]);
  expect(busy(run)).toHaveLength(1);
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual([hex(PRESS), ""]);
  run.type("\x1b[<1;36;6m");
  await run.settle();
  expect(bytes(run)).toEqual([hex(PRESS + "\x1b[<1;9;4m"), ""]);
}, 60_000);

it("refused prefix chords take no place in what waits: ordinary text after a burst still arrives", async () => {
  const { run, answer } = await heldRename();
  run.loop.dispatch({ type: "keys", keys: { prefix: "~" }, at: run.clock.current });
  for (let index = 0; index <= BEHIND_WRITE_EVENTS; index++) run.type("~R");
  run.type("a");
  await run.settle();
  expect(run.loop.model().notices.map((notice) => notice.code)).toEqual(["layout_busy"]);
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual(["61", ""]);
  expect(run.loop.report().actions).not.toContain("reload_keys");
}, 60_000);

it("a prefix still pending when the hold ends stays armed for the next key", async () => {
  const { run, answer } = await heldRename();
  run.loop.dispatch({ type: "keys", keys: { prefix: "~" }, at: run.clock.current });
  run.type("a~");
  await run.settle();
  answer();
  await run.advance(200);
  expect(bytes(run)).toEqual(["61", ""]);
  expect(run.loop.model().armed).toBe(true);
  run.type("q");
  await run.advance(QUIT_BOUND_MS + 100);
  expect(await run.loop.done).toMatchObject({ kind: "quit" });
  expect(bytes(run)).toEqual(["61", ""]);
}, 60_000);

it.each(["joined", "split"])("two same-button gestures in one hold retain their own physical cells: %s", async (ordering) => {
  const { run, answer } = await heldRename(true);
  const reports = ["\x1b[<33;34;6M", "\x1b[<1;35;6m", "\x1b[<1;36;6M", "\x1b[<33;37;6M", "\x1b[<1;38;6m"];
  if (ordering === "joined") run.type(reports.join(""));
  else for (const report of reports) { run.type(report); await run.settle(); }
  expect(bytes(run)).toEqual([hex(PRESS), ""]);
  answer();
  await run.advance(200);
  const gestures = PRESS + "\x1b[<33;7;4M\x1b[<1;8;4m\x1b[<1;9;4M\x1b[<33;10;4M\x1b[<1;11;4m";
  expect(bytes(run)).toEqual([hex(gestures), ""]);
  run.type("\x1b[<1;39;6m");
  await run.settle();
  expect(bytes(run)).toEqual([hex(gestures), ""]);
}, 60_000);

it.each(["menu stays open", "menu closes before release"])("an overlay-owned prefix cannot survive its hold: %s", async (ordering) => {
  const { run, answer } = await heldRename();
  run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
  await run.advance(FRAME_PASS_MS);
  run.type("\x02");
  if (ordering === "menu closes before release") {
    run.loop.dispatch({ type: "close_overlay", at: run.clock.current });
    // A focus-gain report must not turn a temporary detach prefix into a terminal prefix.
    run.type("\x1b[I");
  }
  answer();
  await run.advance(200);
  expect(run.loop.model().armed).toBe(false);
  if (ordering === "menu stays open") run.type("\x1b[27u");
  run.type("q");
  await run.settle();
  expect(bytes(run)).toEqual(["71", ""]);
  expect(run.loop.report().actions).not.toContain("quit");
}, 60_000);
