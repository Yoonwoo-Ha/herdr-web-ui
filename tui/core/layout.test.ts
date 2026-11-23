import { afterEach, describe, expect, it } from "bun:test";
import { HcConnection, HcError } from "../../server/herdr-core/connection.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { leaves, type LayoutNode, OVIS_LAYOUT_DOC, place as placeTree } from "../../server/herdr-core/layout-doc.ts";
import { editLayout, zoomEdit } from "../../server/herdr-core/layout-ops.ts";
import { buildSnapshot, LAYOUT_DOC, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import type { HelloInfo } from "../../server/herdr-core/connection.ts";
import type { RunEffect } from "../model/effects.ts";
import type { Target } from "../model/focus.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";
import { type LayoutAnswer, LayoutWrites } from "./layout.ts";
import { CoreWorld } from "./world.ts";

/** every test drives the loop on the injected clock or awaits the write itself; only the socket's own turns are real */
const TEST_MS = 120_000;

/** Workspace `w` (tab `t`: t1 beside t2, a second tab `s`: t3) and workspace `v` (tab `u`: t4). */
function twoWorkspaces(): FakeHcCore {
  const core = new FakeHcCore();
  place(core, { space: "w", spaceName: "work", tab: "t", tabName: "main" }, "one\r\n");
  place(core, { space: "w", spaceName: "work", tab: "t", tabName: "main" }, "two\r\n");
  place(core, { space: "w", spaceName: "work", tab: "s", tabName: "side" }, "three\r\n");
  place(core, { space: "v", spaceName: "docs", tab: "u", tabName: "notes" }, "four\r\n");
  return core;
}

/** The screen's layout writes on a line of its own to `core`, and what they answered. */
function screen(core: FakeHcCore, folder?: string, hc: Pick<HcConnection, "call" | "hello"> = new HcConnection(() => core.transport())) {
  const answers: LayoutAnswer[] = [];
  const writes = new LayoutWrites({ hc, model: new CoreWorld().model, folder, answer: (answer) => answers.push(answer) });
  const run = (action: RunEffect["action"], target: Target | null = null, more: Partial<RunEffect> = {}) => writes.run({ type: "run", action, target, index: null, name: null, ...more });
  const notices = (): Record<string, unknown>[] => answers.flatMap((answer) => answer.type === "notice" ? [{ code: answer.code, ...answer.data, ...(answer.calm ? { calm: true } : {}) }] : []);
  return { answers, writes, run, notices };
}

const pane = (id: string): Target => ({ kind: "pane", id });
const calls = (core: FakeHcCore, ...methods: string[]) => core.calls().filter((call) => methods.includes(call.method));
const docSets = (core: FakeHcCore) => calls(core, "doc.set");
const conflicts = (core: FakeHcCore) => core.log.filter((entry) => entry.what === "reply" && entry.method === "doc.set" && entry.error?.kind === "conflict").length;
const layoutDoc = (core: FakeHcCore) => core.docs.get(OVIS_LAYOUT_DOC)?.value as { workspaces: { id: string; tabs: { id: string; root: LayoutNode; zoomed: string | null }[] }[] } | undefined;
const tabOf = (core: FakeHcCore, id: string) => layoutDoc(core)!.workspaces.flatMap((workspace) => workspace.tabs).find((tab) => tab.id === id)!;
const created = (core: FakeHcCore, address: string) => core.terminal(address).created_ms;
/** The core as the browser's snapshot shows it. */
async function snapshotOf(core: FakeHcCore) {
  const hc = new HcConnection(() => core.transport());
  const list = await hc.call("terminal.list", {});
  return buildSnapshot(list.terminals, core.docs.get(LAYOUT_DOC)?.value ?? null, "0.1.18", () => 0, core.docs.get(OVIS_LAYOUT_DOC)?.value ?? null);
}

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});
async function start(core: FakeHcCore, cols = 120, rows = 40): Promise<Run> {
  const run = await Run.start({ core, cols, rows });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

describe("the screen's layout writes", () => {
  it("second writer", async () => {
    // a browser zooms t2 and is held between its read and its write while the screen splits t1
    const core = twoWorkspaces();
    const browserLine = new HcConnection(() => core.transport());
    let readDone!: () => void;
    const browserRead = new Promise<void>((resolve) => { readDone = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = true;
    const browser: Pick<HcConnection, "call" | "hello"> = {
      hello: () => browserLine.hello() as Promise<HelloInfo>,
      call: (async (method: string, params: Record<string, unknown>) => {
        if (method === "doc.set" && holding) {
          holding = false;
          readDone();
          await held;
        }
        return browserLine.call(method as "doc.set", params as never);
      }) as HcConnection["call"],
    };
    const browserZoom = editLayout(browser, zoomEdit("t2", "on"));
    await browserRead;
    const ours = screen(core);
    await ours.run("split_vertical", pane("t1"));
    release();
    expect(await browserZoom).toEqual({ reason: null, changed: true });
    const made = core.calls().find((call) => call.method === "terminal.run")!;
    const added = leaves(tabOf(core, "t").root).find((leaf) => !["t1", "t2"].includes(leaf));
    expect({ conflicts: conflicts(core), sets: docSets(core).length, leaves: leaves(tabOf(core, "t").root), zoomed: tabOf(core, "t").zoomed, answers: ours.answers })
      .toEqual({ conflicts: 1, sets: 3, leaves: ["t1", added!, "t2"], zoomed: "t2", answers: [{ type: "follow", target: pane(added!), away: null }] });
    expect(made.params["labels"]).toMatchObject({ "herdr.space": "w", "herdr.tab": "t" });

    // the screen's own edit replays once when another writer came first, silently
    const silent = twoWorkspaces();
    const once = screen(silent);
    silent.conflictNext(1);
    await once.run("zoom", pane("t1"));
    expect({ sets: docSets(silent).length, conflicts: conflicts(silent), zoomed: tabOf(silent, "t").zoomed, notices: once.notices() }).toEqual({ sets: 2, conflicts: 1, zoomed: "t1", notices: [] });

    // two conflicts: a calm notice, and nothing of ours written
    const twice = twoWorkspaces();
    const lost = screen(twice);
    twice.conflictNext(2);
    await lost.run("zoom", pane("t1"));
    expect({ conflicts: conflicts(twice), value: twice.docs.get(OVIS_LAYOUT_DOC)?.value ?? null, notices: lost.notices() })
      .toEqual({ conflicts: 2, value: null, notices: [{ code: "layout_conflict", action: "zoom", calm: true }] });
  }, TEST_MS);

  it("split half done", async () => {
    const core = twoWorkspaces();
    const ours = screen(core);
    core.conflictNext(2);
    await ours.run("split_horizontal", pane("t1"));
    const made = calls(core, "terminal.run");
    const address = core.log.flatMap((entry) => entry.what === "reply" && entry.method === "terminal.run" ? [(entry.result as { address: string }).address] : [])[0]!;
    const shown = await snapshotOf(core);
    const tab = shown.layouts.find((layout) => layout.tab_id === "t")!;
    const right = tab.panes.reduce((best, one) => one.rect.x > best.rect.x ? one : best);
    expect({ runs: made.length, kills: calls(core, "terminal.kill", "terminal.rm").length, state: core.terminal(address).state, right: right.pane_id, notices: ours.notices() })
      .toEqual({ runs: 1, kills: 0, state: "live", right: address, notices: [{ code: "layout_not_saved", action: "split_horizontal" }] });
  }, TEST_MS);

  it("same picture", async () => {
    const core = twoWorkspaces();
    const ours = screen(core, "/home/u/project");
    await ours.run("split_horizontal", pane("t2"));
    await ours.run("swap_pane_left", pane("t2"));
    await ours.run("move_tab_previous", { kind: "tab", id: "s" });
    await ours.run("navigate_move_up", { kind: "workspace", id: "v" });
    const hc = new HcConnection(() => core.transport());
    const terminals = (await hc.call("terminal.list", { all: true })).terminals;
    const world = new CoreWorld();
    world.notice({ type: "snapshot", epoch: 1, cause: "connect", seq: 1, terminals });
    world.notice({ type: "doc", epoch: 1, name: OVIS_LAYOUT_DOC, doc: core.docs.get(OVIS_LAYOUT_DOC)! });
    const view = world.view();
    const shown = await snapshotOf(core);
    const picture = view.world.workspaces.map((workspace) => ({ id: workspace.id, tabs: workspace.tabs.map((tab) => ({ id: tab.id, panes: tab.panes.map((one) => one.id), rects: placeTree(view.tabs.get(tab.id)!.root).panes })) }));
    const browser = shown.workspaces.map((workspace) => ({ id: workspace.workspace_id, tabs: shown.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).map((tab) => {
      const layout = shown.layouts.find((one) => one.tab_id === tab.tab_id)!;
      return { id: tab.tab_id, panes: layout.panes.map((one) => one.pane_id), rects: layout.panes.map((one) => ({ pane_id: one.pane_id, rect: one.rect })) };
    }) }));
    expect(picture).toEqual(browser);
    // the writes landed: v first, s before t
    expect([picture.map((workspace) => workspace.id), picture[1]!.tabs.map((tab) => tab.id), ours.notices()]).toEqual([["v", "w"], ["s", "t"], []]);
  }, TEST_MS);

  it("focus is local", async () => {
    const core = twoWorkspaces();
    const one = await start(core);
    const two = await start(core);
    const before = core.calls().length;
    one.loop.dispatch({ type: "select", target: pane("t2"), at: one.clock.current });
    two.loop.dispatch({ type: "select", target: { kind: "workspace", id: "v" }, at: two.clock.current });
    await one.keys("ctrl+b,l");
    await two.keys("ctrl+b,n");
    await one.advance(20);
    await two.advance(20);
    const focusOf = (run: Run) => { const state = run.loop.model(); return state.focus.panes[state.focus.tabs[state.focus.workspace!]!]; };
    const sent = core.calls().slice(before).filter((call) => !["terminal.list", "terminal.attach", "machine.list", "terminal.get", "doc.get"].includes(call.method));
    expect({ one: focusOf(one), two: focusOf(two), sent }).toEqual({ one: "t2", two: "t4", sent: [] });
  }, TEST_MS);

  it("zoom is the document's", async () => {
    const core = twoWorkspaces();
    const one = await start(core);
    const two = await start(core);
    await one.keys("ctrl+b,z");
    await one.advance(20);
    await two.advance(20);
    expect([tabOf(core, "t").zoomed, two.loop.panes.view("t1")?.covered, two.loop.panes.view("t2")?.covered]).toEqual(["t1", false, true]);
    // the other screen draws t1 alone over the whole pane area: its top border runs from the sidebar's edge to the right edge
    expect(two.grid()[1]!.slice(24).startsWith("+")).toBe(true);
    expect(two.grid()[1]!.endsWith("+")).toBe(true);
    expect(two.grid()[1]!.slice(25, -1).includes("+")).toBe(false);
    // a narrow screen writes nothing of its own
    const narrow = twoWorkspaces();
    const small = await start(narrow, 64, 24);
    small.host.resize(60, 24);
    await small.advance(1_000);
    expect(docSets(narrow)).toEqual([]);
  }, TEST_MS);

  it("close reads again at accept", async () => {
    const shown = (core: FakeHcCore, ...ids: string[]) => ids.map((id) => ({ id, created: created(core, id) }));
    // as seen: w's three terminals end, v's stays
    const core = twoWorkspaces();
    const ours = screen(core);
    await ours.run("close_workspace", { kind: "workspace", id: "w" }, { seen: shown(core, "t1", "t2", "t3") });
    expect([calls(core, "terminal.kill").map((call) => call.params["terminal"]).sort(), core.terminal("t4").state, ours.notices()]).toEqual([["t1", "t2", "t3"], "live", []]);
    // a terminal made at another time than the one shown: nothing ends
    const other = twoWorkspaces();
    const stale = screen(other);
    await stale.run("close_pane", pane("t1"), { seen: [{ id: "t1", created: created(other, "t1") - 1 }] });
    // a terminal joined the workspace after the dialog opened: nothing ends
    const grown = twoWorkspaces();
    const asked = screen(grown);
    const seen = shown(grown, "t1", "t2", "t3");
    place(grown, { space: "w", spaceName: "work", tab: "s", tabName: "side" }, "late\r\n");
    await asked.run("close_workspace", { kind: "workspace", id: "w" }, { seen });
    expect([calls(other, "terminal.kill").length, stale.notices(), calls(grown, "terminal.kill").length, asked.notices()])
      .toEqual([0, [{ code: "target_changed", action: "close_pane" }], 0, [{ code: "target_changed", action: "close_workspace" }]]);
  }, TEST_MS);

  it("close reads again at accept: the screen's dialog, with a terminal added before yes, ends nothing; yes as shown ends the workspace", async () => {
    const core = twoWorkspaces();
    const run = await start(core);
    await run.keys("ctrl+b,D");
    expect(run.loop.report().mode.overlays).toEqual(["confirm"]);
    place(core, { space: "w", spaceName: "work", tab: "s", tabName: "side" }, "late\r\n");
    await run.advance(20);
    await run.keys("y");
    await run.advance(20);
    expect([calls(core, "terminal.kill").length, run.loop.model().notices.map((notice) => notice.code)]).toEqual([0, ["target_changed"]]);
    await run.keys("ctrl+b,D");
    await run.keys("y");
    await run.advance(20);
    expect(calls(core, "terminal.kill").map((call) => call.params["terminal"]).sort()).toEqual(["t1", "t2", "t3", "t5"]);
    expect(core.terminal("t4").state).toBe("live");
  }, TEST_MS);

  it("never herdr-app", async () => {
    const core = twoWorkspaces();
    const ours = screen(core, "/home/u/project");
    const every: [RunEffect["action"], Target | null, Partial<RunEffect>?][] = [
      ["new_workspace", null], ["new_tab", { kind: "workspace", id: "w" }, { name: "fresh" }], ["split_vertical", pane("t1")], ["split_horizontal", pane("t2")],
      ["rename_workspace", { kind: "workspace", id: "w" }, { name: "renamed" }], ["rename_tab", { kind: "tab", id: "t" }, { name: "tab" }], ["rename_pane", pane("t1"), { name: "p" }],
      ["zoom", pane("t1")], ["zoom", pane("t1")], ["resize_pane_right", pane("t1")], ["resize_pane_left", pane("t2")], ["resize_pane_up", pane("t2")], ["resize_pane_down", pane("t1")],
      ["swap_pane_right", pane("t1")], ["swap_pane_left", pane("t1")], ["swap_pane_up", pane("t1")], ["swap_pane_down", pane("t1")],
      ["move_tab_next", { kind: "tab", id: "t" }], ["move_tab_previous", { kind: "tab", id: "t" }],
      ["navigate_move_down", { kind: "workspace", id: "w" }], ["navigate_move_up", { kind: "workspace", id: "w" }],
      ["navigate_move_pane", pane("t3"), { name: "moved", to: "v" }],
      ["close_pane", pane("t2"), { seen: [{ id: "t2", created: null }] }], ["close_tab", { kind: "tab", id: "u" }, { seen: [{ id: "t4", created: null }] }],
    ];
    for (const [action, target, more] of every) await ours.run(action, target, more ?? {});
    const named = docSets(core).map((call) => call.params["name"]);
    expect({ appWrites: core.herdrAppWrites, named: [...new Set(named)], refused: ours.notices().filter((notice) => notice.code !== "layout_unchanged") }).toEqual({ appWrites: [], named: [OVIS_LAYOUT_DOC], refused: [] });
    // a new terminal runs in the core's environment plus exactly TERM and COLORTERM; a new workspace in the screen's folder
    const started = calls(core, "terminal.run");
    expect([started.length, started.every((call) => JSON.stringify(call.params["env"]) === JSON.stringify({ TERM: "xterm-256color", COLORTERM: "truecolor" })), started[0]!.params["cwd"]]).toEqual([4, true, "/home/u/project"]);
    expect(started[1]!.params["labels"]).toMatchObject({ [TAB_NAME_LABEL]: "fresh", [WORKSPACE_NAME_LABEL]: "work" });
  }, TEST_MS);

  it("app-owned: every arranging action answers app_owned and writes nothing; closing still works", async () => {
    const core = twoWorkspaces();
    core.docs.set(LAYOUT_DOC, { value: { schema: 1, spaces: [] }, version: 1 });
    const ours = screen(core);
    const arranging: [RunEffect["action"], Target, Partial<RunEffect>?][] = [
      ["split_vertical", pane("t1")], ["rename_pane", pane("t1"), { name: "p" }], ["rename_tab", { kind: "tab", id: "t" }, { name: "x" }], ["zoom", pane("t1")],
      ["swap_pane_right", pane("t1")], ["resize_pane_right", pane("t1")], ["move_tab_next", { kind: "tab", id: "t" }], ["navigate_move_down", { kind: "workspace", id: "w" }],
      ["navigate_move_pane", pane("t1"), { name: "m", to: "v" }],
    ];
    for (const [action, target, more] of arranging) await ours.run(action, target, more ?? {});
    expect({ notices: ours.notices().map((notice) => notice.code), sets: docSets(core).length, labels: calls(core, "terminal.label", "terminal.run").length })
      .toEqual({ notices: arranging.map(() => "app_owned"), sets: 0, labels: 0 });
    await ours.run("close_pane", pane("t2"), { seen: [{ id: "t2", created: created(core, "t2") }] });
    expect([calls(core, "terminal.kill", "terminal.rm").map((call) => `${call.method} ${String(call.params["terminal"])}`), ours.notices().length, docSets(core).length])
      .toEqual([["terminal.kill t2", "terminal.rm t2"], arranging.length, 0]);
  }, TEST_MS);

  it("one write in flight; an answer that never came is not sent again; a precondition gone is calm", async () => {
    const core = twoWorkspaces();
    const ours = screen(core);
    const first = ours.run("split_vertical", pane("t1"));
    await ours.run("split_vertical", pane("t2"));
    await first;
    expect([calls(core, "terminal.run").length, ours.notices()]).toEqual([1, [{ code: "layout_busy", action: "split_vertical" }]]);

    const cut = twoWorkspaces();
    const line = new HcConnection(() => cut.transport());
    let runs = 0;
    const dropping: Pick<HcConnection, "call" | "hello"> = {
      hello: () => line.hello() as Promise<HelloInfo>,
      call: (async (method: string, params: Record<string, unknown>) => {
        if (method === "terminal.run") {
          runs++;
          throw new HcError("closed", "the line ended before the answer came");
        }
        return line.call(method as "doc.get", params as never);
      }) as HcConnection["call"],
    };
    const lost = screen(cut, undefined, dropping);
    expect(await lost.run("new_workspace")).toEqual({ ended: [], dropInput: "layout_unknown" });
    await lost.run("zoom", pane("t9"));
    expect([runs, lost.notices()]).toEqual([1, [{ code: "layout_unknown", action: "new_workspace" }, { code: "layout_refused", action: "zoom", reason: "unsupported" }]]);

    const edge = twoWorkspaces();
    const calm = screen(edge);
    await calm.run("swap_pane_left", pane("t1"));
    await calm.run("move_tab_previous", { kind: "tab", id: "t" });
    expect([docSets(edge).length, calm.notices()]).toEqual([0, [{ code: "layout_unchanged", action: "swap_pane_left", reason: "no_neighbor", calm: true }, { code: "layout_unchanged", action: "move_tab_previous", reason: "first", calm: true }]]);
  }, TEST_MS);

  it("the whole screen: a new tab asks for its name, a split shows the new pane focused, a rename edits in place", async () => {
    const core = twoWorkspaces();
    const run = await start(core);
    await run.keys("ctrl+b,c");
    expect(run.loop.report().mode.overlays).toEqual(["text"]);
    await run.keys("logs,enter");
    await run.advance(20);
    const tabs = () => run.loop.model().world.workspaces.find((workspace) => workspace.id === "w")!.tabs.map((tab) => tab.name);
    const focusOf = () => { const state = run.loop.model(); return state.focus.panes[state.focus.tabs[state.focus.workspace!]!]; };
    expect([tabs(), focusOf()]).toEqual([["main", "side", "logs"], "t5"]);
    expect(run.grid()[0]!.includes("3:logs")).toBe(true);
    // a key in the millisecond a pane goes live is refused by the pane machine: wait for the new pane first
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,v");
    await run.advance(20);
    expect([run.loop.model().world.workspaces[0]!.tabs[2]!.panes.map((one) => one.id), focusOf()]).toEqual([["t5", "t6"], "t6"]);
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,T,ctrl+u,build,enter");
    await run.advance(20);
    expect(tabs()).toEqual(["main", "side", "build"]);
    expect(run.grid()[0]!.includes("3:build")).toBe(true);
  }, TEST_MS);
});

describe("the screen's closes and steps, pinned", () => {
  const ended = (core: FakeHcCore, address: string) => core.program(address).exit(0);
  const ends = (core: FakeHcCore) => calls(core, "terminal.kill", "terminal.rm").map((call) => `${call.method} ${String(call.params["terminal"])}`).sort();
  const seenOf = (core: FakeHcCore, ...ids: string[]) => ids.map((id) => ({ id, created: created(core, id) }));

  it("an ended pane closes: its record is removed, and its tab and workspace close with it", async () => {
    const pane2 = twoWorkspaces();
    ended(pane2, "t2");
    const one = screen(pane2);
    await one.run("close_pane", pane("t2"), { seen: seenOf(pane2, "t2") });
    const tab = twoWorkspaces();
    ended(tab, "t2");
    const two = screen(tab);
    await two.run("close_tab", { kind: "tab", id: "t" }, { seen: seenOf(tab, "t1", "t2") });
    const workspace = twoWorkspaces();
    ended(workspace, "t2");
    const three = screen(workspace);
    await three.run("close_workspace", { kind: "workspace", id: "w" }, { seen: seenOf(workspace, "t1", "t2", "t3") });
    const left = async (core: FakeHcCore) => (await new HcConnection(() => core.transport()).call("terminal.list", { all: true })).terminals.map((terminal) => terminal.address);
    expect([ends(pane2), ends(tab), ends(workspace), one.notices(), two.notices(), three.notices()]).toEqual([
      ["terminal.rm t2"],
      ["terminal.kill t1", "terminal.rm t1", "terminal.rm t2"],
      ["terminal.kill t1", "terminal.kill t3", "terminal.rm t1", "terminal.rm t2", "terminal.rm t3"],
      [], [], [],
    ]);
    expect([await left(pane2), await left(tab), await left(workspace)]).toEqual([["t1", "t3", "t4"], ["t3", "t4"], ["t4"]]);
  }, TEST_MS);

  it("a close ends exactly what it checked: a terminal that joins after the check is left running", async () => {
    const core = twoWorkspaces();
    const line = new HcConnection(() => core.transport());
    let lists = 0;
    const joining: Pick<HcConnection, "call" | "hello"> = {
      hello: () => line.hello() as Promise<HelloInfo>,
      call: (async (method: string, params: Record<string, unknown>) => {
        const answer = await line.call(method as "terminal.list", params as never);
        // the terminal joins workspace w right after the close's own read of the core
        if (method === "terminal.list" && ++lists === 1) place(core, { space: "w", spaceName: "work", tab: "s", tabName: "side" }, "late\r\n");
        return answer;
      }) as HcConnection["call"],
    };
    const ours = screen(core, undefined, joining);
    await ours.run("close_workspace", { kind: "workspace", id: "w" }, { seen: seenOf(core, "t1", "t2", "t3") });
    expect([calls(core, "terminal.kill").map((call) => call.params["terminal"]).sort(), core.terminal("t5").state, ours.notices()]).toEqual([["t1", "t2", "t3"], "live", []]);
  }, TEST_MS);

  it("one step down moves a tab or a workspace past the next one", async () => {
    const core = twoWorkspaces();
    const ours = screen(core);
    await ours.run("move_tab_next", { kind: "tab", id: "t" });
    await ours.run("navigate_move_down", { kind: "workspace", id: "w" });
    await ours.run("move_tab_next", { kind: "tab", id: "t" });
    const shown = await snapshotOf(core);
    expect([shown.workspaces.map((workspace) => workspace.workspace_id), shown.tabs.filter((tab) => tab.workspace_id === "w").map((tab) => tab.tab_id), ours.notices()])
      .toEqual([["v", "w"], ["s", "t"], [{ code: "layout_unchanged", action: "move_tab_next", reason: "last", calm: true }]]);
  }, TEST_MS);

  it("resize by keys moves the border by the browser's step, 0.05 of its split", async () => {
    const core = twoWorkspaces();
    const ours = screen(core);
    await ours.run("resize_pane_right", pane("t1"));
    const root = tabOf(core, "t").root as { ratio: number };
    expect(root.ratio).toBe(0.55);
  }, TEST_MS);

  it("the dialog keeps the created_ms the world showed for each terminal", async () => {
    const core = twoWorkspaces();
    const run = await start(core);
    await run.keys("ctrl+b,D");
    const overlay = run.loop.model().overlays[0];
    expect(overlay?.kind === "confirm" ? overlay.seen : null).toEqual(seenOf(core, "t1", "t2", "t3"));
  }, TEST_MS);

  it("the screen closes an ended pane with its key", async () => {
    const core = twoWorkspaces();
    const run = await start(core);
    ended(core, "t2");
    await run.advance(20);
    expect(run.loop.panes.view("t2")?.state.kind).toBe("Ended");
    run.loop.dispatch({ type: "select", target: pane("t2"), at: run.clock.current });
    await run.keys("ctrl+b,x");
    await run.advance(20);
    expect([ends(core), run.loop.model().world.workspaces[0]!.tabs[0]!.panes.map((one) => one.id), run.loop.model().notices.map((notice) => notice.code)]).toEqual([["terminal.rm t2"], ["t1"], []]);
  }, TEST_MS);
});
