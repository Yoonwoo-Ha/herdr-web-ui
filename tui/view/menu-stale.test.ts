import { afterEach, expect, it } from "bun:test";
import { FRAME_PASS_MS } from "../model/deadlines.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

const click = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`;
const panes = (run: Run) => run.loop.model().world.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.id)));
const closes = (run: Run) => run.core.calls().filter((call) => call.method === "terminal.kill" || call.method === "terminal.rm");

it.each(["before Escape", "after Escape", "after repaint"])("a rejected left menu click preserves the physical right release: %s", async (ordering) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  const program = run.core.program("t1");
  program.output("\x1b[?1002h\x1b[?1006h");
  await run.advance(200);
  run.type("\x1b[<2;31;6M");
  await run.settle();
  expect(program.receivedHex()).toBe(Buffer.from("\x1b[<2;6;4M").toString("hex"));
  run.type("\x02\r");
  await run.advance(FRAME_PASS_MS);
  run.type("\x1b[B");
  await run.settle();
  const painted = run.grid();
  const row = painted.findIndex((line) => line.includes("4 · tab") && line.includes("logs"));
  expect(row).toBeGreaterThan(0);
  const col = painted[row]!.indexOf("4 · tab");
  run.core.remove("t3");
  await run.settle();
  expect(run.grid()).toEqual(painted);
  run.type(click(col, row));
  await run.settle();
  expect(program.receivedHex()).toBe(Buffer.from("\x1b[<2;6;4M").toString("hex"));
  expect(run.loop.report().mode.overlays).toEqual(["menu"]);
  expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
  expect(closes(run)).toEqual([]);
  if (ordering !== "before Escape") run.type("\x1b[27u");
  if (ordering === "after repaint") await run.advance(FRAME_PASS_MS);
  run.type("\x1b[<2;32;6m");
  await run.settle();
  const balanced = Buffer.from("\x1b[<2;6;4M\x1b[<2;7;4m").toString("hex");
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual([balanced, ""]);
  run.type("\x1b[<2;33;6m");
  await run.settle();
  expect(program.receivedHex()).toBe(balanced);
}, 60_000);

// Once a presented choice is stale, no later input chooses anything until a fresh menu is presented.
it.each(["joined digit", "split digit", "Enter", "click"])("a stale choice refuses trailing Close pane before repaint: %s", async (input) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  run.type("\x02\r");
  if (input === "Enter") run.type("\x1b[B".repeat(5));
  await run.advance(FRAME_PASS_MS);
  const painted = run.grid();
  const row = painted.findIndex((line) => line.includes("6 · pane"));
  const line = painted[row];
  if (line === undefined) throw new Error("Files menu row was not painted");
  expect(line).toContain("files");

  run.core.remove("t2");
  await run.settle();
  expect(run.grid()).toEqual(painted);
  if (input === "joined digit") run.type("6M");
  else {
    run.type(input === "Enter" ? "\r" : input === "click" ? click(line.indexOf("6 · pane"), row) : "6");
    await run.settle();
    run.type("M");
  }
  await run.settle();
  expect(run.grid()).toEqual(painted);
  expect(panes(run)).toEqual(["t1", "t3", "t4"]);
  expect(closes(run)).toEqual([]);
  expect(run.loop.report().actions.filter((action) => action === "run:close_pane")).toEqual([]);
  expect(run.core.program("t1").receivedHex()).toBe("");

  // A rejected choice is not replayed. Only a new key after the accepted paint can close shell.
  await run.advance(FRAME_PASS_MS);
  expect(panes(run)).toEqual(["t1", "t3", "t4"]);
  expect(closes(run)).toEqual([]);
  run.type("M");
  await run.advance(200);
  expect(panes(run)).toEqual(["t3", "t4"]);
  expect(closes(run).map((call) => [call.method, call.params])).toEqual([
    ["terminal.kill", { terminal: "t1" }], ["terminal.rm", { terminal: "t1" }],
  ]);
}, 60_000);

it("an unrecognized menu character does not block the next recognized choice", async () => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  // One read before the first menu paint still works, including an unrecognized character.
  run.type("\x02\r한6z");
  await run.advance(200);
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["", "7a"]);
  expect(run.loop.report().mode.overlays).toEqual([]);
}, 60_000);

it("a long ignored menu span stays iterative and runs its following choice once", async () => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  run.type("\x02\r" + "7".repeat(100_000) + "6z");
  await run.advance(200);
  expect(run.loop.report().mode.overlays).toEqual([]);
  expect(run.loop.model().focus.panes["t-main"]).toBe("t2");
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["", "7a"]);
  run.type("y");
  await run.settle();
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["", "7a79"]);
  expect(run.loop.report().actions).not.toContain("close_all");
}, 60_000);

it("a stale choice during a frame write waits for the next accepted menu frame", async () => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  run.type("\x02\r");
  await run.advance(FRAME_PASS_MS);
  run.core.remove("t2");
  await run.settle();
  // The host has not yet accepted this refresh when it delivers the old screen's choice.
  run.host.duringNextWrite(() => run.type("6"));
  await run.advance(FRAME_PASS_MS);
  run.type("M");
  await run.settle();
  expect(panes(run)).toEqual(["t1", "t3", "t4"]);
  expect(closes(run)).toEqual([]);
  await run.advance(FRAME_PASS_MS);
  run.type("M");
  await run.advance(200);
  expect(panes(run)).toEqual(["t3", "t4"]);
}, 60_000);

it.each(["joined", "split"])("Escape dismisses a stale menu without leaking trailing input before paint: %s", async (ordering) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  run.type("\x02\r");
  await run.advance(FRAME_PASS_MS);
  run.core.remove("t2");
  await run.settle();
  if (ordering === "joined") run.type("6\x1b[27uM");
  else {
    run.type("6");
    run.type("\x1b[27u");
    await run.settle();
    run.type("M");
  }
  await run.settle();
  expect(run.loop.report().mode.overlays).toEqual([]);
  expect(panes(run)).toEqual(["t1", "t3", "t4"]);
  expect(closes(run)).toEqual([]);
  expect(run.core.program("t1").receivedHex()).toBe("");
  await run.advance(FRAME_PASS_MS);
  run.type("z");
  await run.settle();
  expect(run.core.program("t1").receivedHex()).toBe("7a");
}, 60_000);

it.each(["before repaint", "after repaint", "split before repaint", "right before Escape"])("a stale menu dismissal preserves a program's matching mouse release: %s", async (ordering) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  const program = run.core.program("t1");
  program.output("\x1b[?1002h\x1b[?1006h");
  await run.advance(200);
  run.type("\x1b[<0;31;6M");
  await run.settle();
  const press = "\x1b[<0;6;4M";
  expect(program.receivedHex()).toBe(Buffer.from(press).toString("hex"));
  run.type("\x02\r");
  await run.advance(FRAME_PASS_MS);
  run.type("\x1b[B");
  await run.settle();
  const painted = run.grid();
  expect(painted.some((row) => row.includes("4 · tab") && row.includes("logs"))).toBe(true);
  // Removing a background tab leaves the pressed program's size and attach unchanged.
  run.core.remove("t3");
  await run.settle();
  expect(run.grid()).toEqual(painted);
  run.type("4");
  if (ordering === "right before Escape") run.type("\x1b[<2;31;6M\x1b[<2;31;6m");
  run.type("\x1b[27u");
  await run.settle();
  expect(run.loop.report().mode.overlays).toEqual([]);
  // Motion, wheel and a new press must neither reach the program nor replace its existing grab.
  run.type("\x1b[<32;32;6M\x1b[<64;31;6M\x1b[<2;31;6M");
  if (ordering === "after repaint") await run.advance(FRAME_PASS_MS);
  // The refused right press has no release to forward and cannot end the held left button's grab.
  if (ordering === "split before repaint") {
    run.type("\x1b[<2;32;6m");
    await run.settle();
    run.type("\x1b[<0;32;6m");
  } else run.type("\x1b[<2;32;6m\x1b[<0;32;6m");
  await run.settle();
  const gesture = Buffer.from(press + "\x1b[<0;7;4m").toString("hex");
  expect(program.receivedHex()).toBe(gesture);
  // The matching release ended the grab. Neither an orphan drag nor another release may continue it.
  await run.advance(FRAME_PASS_MS);
  run.type("\x1b[<32;33;6M\x1b[<0;33;6m");
  await run.settle();
  expect(program.receivedHex()).toBe(gesture);
}, 60_000);
