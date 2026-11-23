import { describe, expect, it } from "bun:test";
import type { LayoutNode } from "../../server/herdr-core/layout-doc.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { LAYOUT_DOC, PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import type { PaneState, PaneView } from "../core/pane.ts";
import { CoreWorld } from "../core/world.ts";
import { STYLE_BOLD } from "../emulator/index.ts";
import { focused } from "../model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { agents } from "../testing/fixtures/agents.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { machines } from "../testing/fixtures/machines.ts";
import { Run } from "../testing/run.ts";
import { buildChrome, sessionFromSocket } from "./chrome.ts";
import { cellsOf } from "./geometry.ts";
import { PaneGrid } from "./grid.ts";
import type { ShownLink } from "./link-view.ts";
import { Painter, type Part, type Scene } from "./paint.ts";
import { layOut, paneScene, type ScreenShape } from "./screen.ts";

// The dark theme's colours as tui/theme.generated.ts holds them (src/styles.css), written out here.
const rgb = (r: number, g: number, b: number): [number, number, number] => [r, g, b];
const ACCENT = rgb(58, 131, 247);
const TEXT_STRONG = rgb(255, 255, 255);
const BORDER_STRONG = rgb(64, 64, 64);
const NOTICE = rgb(217, 178, 106);
const BLOCKED = rgb(252, 141, 139);
const DONE = rgb(64, 201, 119);
const WORKING = rgb(129, 176, 250);
const BG_ELEVATED = rgb(38, 38, 38);

const ONLINE: ShownLink = { online: true, code: null };

const term = (address: string, space: string, spaceName: string, tab: string, tabName: string, extra: Record<string, unknown> = {}, pane?: string) => ({
  address, state: "live", cols: 80, rows: 24, cwd: "/home/u/proj", turn: 0, reason: null,
  labels: { [SPACE_LABEL]: space, [WORKSPACE_NAME_LABEL]: spaceName, [TAB_LABEL]: tab, [TAB_NAME_LABEL]: tabName, ...(pane ? { [PANE_NAME_LABEL]: pane } : {}) },
  ...extra,
});

/** Two workspaces (the second Korean), a split tab of two agents and a second tab. */
const WORK = [
  term("t1", "w-ovis", "ovis", "t-main", "main", { status: { state: "blocked", app: "claude" }, reported: true, cwd: "/home/u/ovis" }, "shell"),
  term("t2", "w-ovis", "ovis", "t-main", "main", { status: { state: "working", app: "codex" }, reported: true, cwd: "/home/u/ovis/tui" }, "files"),
  term("t3", "w-ovis", "ovis", "t-logs", "logs"),
  term("t4", "w-docs", "문서", "t-notes", "노트", { status: { state: "done", app: "claude" }, reported: true, turn: 2 }),
];

function worldOf(terminals: unknown[], docs: Record<string, unknown> = {}): CoreWorld {
  const world = new CoreWorld();
  world.notice({ type: "snapshot", epoch: 1, cause: "connect", seq: 1, terminals });
  for (const [name, value] of Object.entries(docs)) world.notice({ type: "doc", epoch: 1, name, doc: { value, version: 1 } });
  return world;
}

const pane = (terminal: string, state: PaneState = { kind: "Live" }, sizedBy: { cols: number; rows: number } | null = null): PaneView => ({
  terminal, state, gen: 1, wanted: { cols: 46, rows: 36 }, actual: { cols: 46, rows: 36 }, advertised: null, sizedBy, emulator: null, grid: null, ready: false, covered: false, owed: 0,
});

interface Setup {
  cols: number;
  rows: number;
  terminals?: unknown[];
  docs?: Record<string, unknown>;
  keys?: unknown;
  events?: ModelEvent[];
  panes?: Record<string, PaneView>;
  link?: ShownLink;
  cwd?: string;
  session?: string;
}

function setup(options: Setup): { state: ModelState; shape: ScreenShape; input: Parameters<typeof buildChrome>[0] } {
  const view = worldOf(options.terminals ?? WORK, options.docs).view();
  let state = reduce(initialState(options.keys), { type: "world", world: view.world, at: 0 }).state;
  for (const event of options.events ?? []) state = reduce(state, event).state;
  const tab = state.world.workspaces.flatMap((workspace) => workspace.tabs).find((one) => one.id === (state.focus.tabs[state.focus.workspace ?? ""] ?? state.world.workspaces[0]?.tabs[0]?.id));
  const shape = layOut(options.cols, options.rows, tab ? view.tabs.get(tab.id) ?? null : null, { sidebarCollapsed: state.sidebarCollapsed, pane: focused(state.world, state.focus).pane?.id ?? null });
  const panes = new Map(Object.entries(options.panes ?? Object.fromEntries(shape.spots.map((spot) => [spot.pane, pane(spot.pane)]))));
  return {
    state, shape,
    input: { regions: shape.regions, spots: shape.spots, splits: shape.splits, state, world: view, panes, link: options.link ?? ONLINE, session: options.session ?? "work", cwd: options.cwd ?? "/home/u/my-project", theme: "dark", colors: "truecolor" },
  };
}

interface Picture { painter: Painter; frame: ReturnType<Painter["paint"]>; rows: string[] }

function picture(width: number, height: number, parts: readonly Part[], overlays: readonly Part[] = [], panes: Scene["panes"] = [], input: Scene["input"] = null, painter = new Painter({ sync: false })): Picture {
  const frame = painter.paint({ width, height, parts, panes, overlays, focus: null, input });
  painter.taken(true);
  return { painter, frame, rows: rowsOf(painter) };
}

function rowsOf(painter: Painter): string[] {
  const screen = painter.screen;
  return Array.from({ length: screen.rows }, (_, row) => {
    let line = "";
    for (let col = 0; col < screen.cols; col++) if (screen.width[row * screen.cols + col] !== 0) line += screen.text[row * screen.cols + col];
    return line;
  });
}

function draw(options: Setup): Picture {
  const { input } = setup(options);
  const chrome = buildChrome(input);
  return picture(options.cols, options.rows, chrome.parts, chrome.overlays, [], chrome.input);
}

function cell({ painter }: Picture, col: number, row: number) {
  const at = row * painter.screen.cols + col;
  const style = painter.styles.get(painter.screen.style[at]!)!;
  return { text: painter.screen.text[at], fg: style.fg, bg: style.bg, bold: (style.flags & STYLE_BOLD) !== 0 };
}

/** The cells' text and attributes without colour, to tell two pictures apart as a colour-blind user would. */
const noColour = ({ painter }: Picture): string => {
  const screen = painter.screen;
  return Array.from(screen.text, (text, at) => `${text}${screen.width[at]}${painter.styles.get(screen.style[at]!)!.flags}`).join("");
};

describe("chrome frames as rows of cells", () => {
  it("at 120x40: header and toggle, workspaces with roll-up marks, agents, tabs, bordered panes with titles, and the hint line", () => {
    const shot = draw({ cols: 120, rows: 40 });
    expect(shot.rows.slice(0, 9)).toEqual([
      `hc:work              <<| 1:main !  2:logs${" ".repeat(79)}`,
      "Workspaces             |+- shell ovis [claude] ! Needs you ------------++- files tui [codex] ~ Working ----------------+",
      ">!1:ovis      Needs you||                                              ||                                              |",
      " *2:문서           Done||                                              ||                                              |",
      "Agents                 ||                                              ||                                              |",
      " ! shell /ov… Needs you||                                              ||                                              |",
      " ~ files /tui … Working||                                              ||                                              |",
      " * claude /proj    Done||                                              ||                                              |",
      "                       ||                                              ||                                              |",
    ]);
    expect(shot.rows[38]).toBe(`                       |+${"-".repeat(46)}++${"-".repeat(46)}+`);
    expect(shot.rows[39]).toBe(` TERMINAL  ctrl+b prefix prefix+enter menu prefix+? help${" ".repeat(64)}`);
    expect(cell(shot, 0, 0)).toEqual({ text: "h", fg: TEXT_STRONG, bg: BG_ELEVATED, bold: true });
    expect(cell(shot, 21, 0)).toMatchObject({ text: "<", fg: ACCENT, bold: true });
    expect(cell(shot, 0, 2)).toMatchObject({ text: ">", fg: ACCENT, bold: true });
    expect(cell(shot, 1, 2)).toMatchObject({ text: "!", fg: BLOCKED, bold: true });
    expect(cell(shot, 1, 3)).toMatchObject({ text: "*", fg: DONE, bold: true });
    expect(cell(shot, 1, 6)).toMatchObject({ text: "~", fg: WORKING, bold: true });
    expect(cell(shot, 25, 0)).toMatchObject({ text: "1", fg: ACCENT, bg: BG_ELEVATED, bold: true });
    expect(cell(shot, 24, 1)).toMatchObject({ text: "+", fg: ACCENT, bold: true });
    expect(cell(shot, 72, 1)).toMatchObject({ text: "+", fg: BORDER_STRONG, bold: false });
    expect(cell(shot, 1, 39)).toMatchObject({ text: "T", fg: TEXT_STRONG, bg: BG_ELEVATED, bold: true });
  });

  it("at 80x24: the same chrome narrower, every label cut with … where it does not fit", () => {
    const shot = draw({ cols: 80, rows: 24 });
    expect(shot.rows.slice(0, 8)).toEqual([
      `hc:work              <<| 1:main !  2:logs${" ".repeat(39)}`,
      "Workspaces             |+- shell ovis [claude] ! …-++- files tui [codex] ~ Wo…-+",
      ">!1:ovis      Needs you||                          ||                          |",
      " *2:문서           Done||                          ||                          |",
      "Agents                 ||                          ||                          |",
      " ! shell /ov… Needs you||                          ||                          |",
      " ~ files /tui … Working||                          ||                          |",
      " * claude /proj    Done||                          ||                          |",
    ]);
    expect(shot.rows[23]).toBe(` TERMINAL  ctrl+b prefix prefix+enter menu prefix+? help${" ".repeat(24)}`);
  });
});

describe("each visible state has its own mark, told apart without colour", () => {
  const TWO = [term("t1", "w1", "work", "tab1", "tab", {}, "one"), term("t2", "w1", "work", "tab1", "tab", {}, "two")];
  // the first pane's bottom border at 120x40: row 38, its banner from column 26
  const states: [name: string, setup: Partial<Setup>, mark: string, col: number, row: number][] = [
    ["live", {}, `+${"-".repeat(46)}+`, 24, 38],
    ["sized by another viewer", { panes: { t1: pane("t1", { kind: "Live" }, { cols: 150, rows: 50 }), t2: pane("t2") } }, " sized by another viewer (150x50) ", 26, 38],
    ["not attached", { panes: { t1: pane("t1", { kind: "Idle" }), t2: pane("t2") } }, " not attached ", 26, 38],
    ["opening", { panes: { t1: pane("t1", { kind: "Opening" }), t2: pane("t2") } }, " opening terminal ", 26, 38],
    ["painting", { panes: { t1: pane("t1", { kind: "Painting" }), t2: pane("t2") } }, " loading screen ", 26, 38],
    ["closing", { panes: { t1: pane("t1", { kind: "Closing" }), t2: pane("t2") } }, " closing stream ", 26, 38],
    ["waiting for its new shell", { panes: { t1: pane("t1", { kind: "Waiting", why: "lost" }), t2: pane("t2") } }, " waiting for its new shell ", 26, 38],
    ["waiting for herdr-core", { panes: { t1: pane("t1", { kind: "Waiting", why: "offline" }), t2: pane("t2") } }, " waiting for herdr-core ", 26, 38],
    ["stream closed", { panes: { t1: pane("t1", { kind: "Waiting", why: "closed" }), t2: pane("t2") } }, " stream closed ", 26, 38],
    ["ended (3)", { panes: { t1: pane("t1", { kind: "Ended", reason: "exited", code: 3 }), t2: pane("t2") } }, " ended (3) ", 26, 38],
    ["ended (none)", { panes: { t1: pane("t1", { kind: "Ended", reason: "killed", code: null }), t2: pane("t2") } }, " ended (none) ", 26, 38],
    ["failed", { panes: { t1: pane("t1", { kind: "Failed", code: "size", reason: "too big" } as PaneState), t2: pane("t2") } }, " failed: too big ", 26, 38],
    ["offline", { link: { online: false, code: "closed" } }, " herdr-core is not answering: hc server start (closed) ", 10, 39],
    ["focus on the second pane", { events: [{ type: "select", target: { kind: "pane", id: "t2" }, at: 1 }] }, "+- two proj", 72, 1],
    ["zoomed", { docs: { [OVIS_LAYOUT_DOC]: { schema: 1, workspaces: [{ id: "w1", tabs: [{ id: "tab1", root: { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } }, zoomed: "t1" }] }] } } }, " ZOOM ", 114, 0],
    ["the Herdr app arranges this core", { docs: { [LAYOUT_DOC]: { spaces: [{ id: "w1", name: "work", tabs: [{ id: "tab1", name: "tab", root: { type: "row", children: [{ content: { terminal: "t1" } }, { content: { terminal: "t2" } }] } }] }] } } }, "the Herdr app arranges…", 0, 1],
    ["empty core", { terminals: [] }, "New workspace in my-project (prefix+shift+n)", 26, 20],
    ["empty core, offline", { terminals: [], link: { online: false, code: "no_core" } }, "herdr-core is not answering: hc server start (no_core)", 26, 19],
  ];
  const shots = states.map(([name, extra]) => [name, draw({ cols: 120, rows: 40, terminals: TWO, ...extra })] as const);

  for (const [index, [name, , mark, col, row]] of states.entries()) {
    it(name, () => {
      const shot = shots[index]![1];
      expect([...shot.rows[row]!].slice(col, col + [...mark].length).join("")).toBe(mark);
      for (const [other, picture] of shots) if (other !== name) expect({ name, other, same: noColour(picture) === noColour(shot) }).toEqual({ name, other, same: false });
    });
  }

  it("no state draws a retry control: nothing in this screen performs one yet", () => {
    for (const [name, shot] of shots) {
      expect({ name, retry: shot.rows.some((line) => line.includes("retry")), hits: shot.frame.hits.hits.filter((hit) => "part" in hit.target && hit.target.id.startsWith("retry")).length }).toEqual({ name, retry: false, hits: 0 });
    }
  });

  it("offline: every border in the notice colour, the focused pane no longer bold, no kill offered", () => {
    const shot = shots.find(([name]) => name === "offline")![1];
    expect(cell(shot, 24, 1)).toMatchObject({ text: "+", fg: NOTICE, bold: false });
    expect(shot.rows.join("\n").toLowerCase()).not.toContain("kill");
  });
});

describe("every control's cells resolve to it in the hit map, and the cells beside it do not", () => {
  const owner = (shot: Picture, col: number, row: number) => {
    const target = shot.frame.hits.at(col, row);
    return target && "part" in target ? `${target.part}/${target.id}` : target ? `pane/${target.pane}` : null;
  };
  const table: [name: string, setup: Setup, id: string, rect: { x: number; y: number; width: number; height: number }][] = [
    ["the sidebar's toggle", { cols: 120, rows: 40 }, "sidebar/toggle_sidebar", { x: 21, y: 0, width: 2, height: 1 }],
    ["a workspace row", { cols: 120, rows: 40 }, "sidebar/workspace:w-docs", { x: 0, y: 3, width: 23, height: 1 }],
    ["an agent row", { cols: 120, rows: 40 }, "sidebar/agent:t2", { x: 0, y: 6, width: 23, height: 1 }],
    ["a tab", { cols: 120, rows: 40 }, "tabs/tab:t-logs", { x: 34, y: 0, width: 8, height: 1 }],
    ["the header that brings a collapsed sidebar back", { cols: 120, rows: 40, events: [{ type: "action", action: "toggle_sidebar", at: 1 }] }, "tabs/toggle_sidebar", { x: 0, y: 0, width: 8, height: 1 }],
    ["a split's divider", { cols: 120, rows: 40 }, "borders/split_0_root", { x: 71, y: 1, width: 2, height: 38 }],
    ["the empty core's offer", { cols: 120, rows: 40, terminals: [] }, "borders/new_workspace", { x: 24, y: 1, width: 96, height: 38 }],
    ["an overlay's close keys", { cols: 120, rows: 40, events: [{ type: "action", action: "help", at: 1 }] }, "overlay:help/close", { x: 93, y: 2, width: 22, height: 1 }],
  ];
  for (const [name, options, id, rect] of table) {
    it(name, () => {
      const shot = draw(options);
      for (let row = rect.y; row < rect.y + rect.height; row++) for (let col = rect.x; col < rect.x + rect.width; col++) expect({ col, row, at: owner(shot, col, row) }).toEqual({ col, row, at: id });
      const beside = [[rect.x - 1, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y - 1], [rect.x, rect.y + rect.height]].filter(([col, row]) => col! >= 0 && row! >= 0 && col! < options.cols && row! < options.rows);
      for (const [col, row] of beside) expect({ col, row, at: owner(shot, col!, row!) === id }).toEqual({ col, row, at: false });
    });
  }
});

describe("a split's divider in the hit map", () => {
  const owner = (shot: Picture, col: number, row: number) => {
    const target = shot.frame.hits.at(col, row);
    return target === null ? null : "part" in target ? target.id : `pane:${target.pane}`;
  };
  /** every cell of each divider resolves to its split, unless a pane too small for a border shows there; no other cell does */
  const check = (label: string, tree: LayoutNode, cols: number, rows: number) => {
    const { input, shape } = setup({ cols, rows, terminals: [] });
    const cut = cellsOf(tree, shape.regions.panes);
    const spots = cut.panes.map((cells) => ({ pane: cells.pane, cells, covered: false }));
    const painter = new Painter({ sync: false });
    const scenes = spots.map((spot) => paneScene(spot, new PaneGrid(painter.styles, spot.cells.cols, spot.cells.rows), { cols: spot.cells.cols, rows: spot.cells.rows }, { live: true, hold: false }));
    const chrome = buildChrome({ ...input, spots, splits: cut.splits, panes: new Map(spots.map((spot) => [spot.pane, pane(spot.pane)])) });
    const shot = picture(cols, rows, chrome.parts, [], scenes, null, painter);
    const ids = new Map(cut.splits.map((split) => [split.id, split.divider]));
    const inPane = (col: number, row: number) => spots.some(({ cells: { inner } }) => col >= inner.x && col < inner.x + inner.width && row >= inner.y && row < inner.y + inner.height);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const at = owner(shot, col, row);
        const divider = cut.splits.find(({ divider: d }) => col >= d.x && col < d.x + d.width && row >= d.y && row < d.y + d.height);
        const want = divider ? (inPane(col, row) ? at : divider.id) : at !== null && ids.has(at) ? "not a divider cell" : at;
        if (at !== want) expect({ label, col, row, at }).toEqual({ label, col, row, at: want });
      }
    }
  };

  it("in every fixture's tabs at three sizes", () => {
    const right = (ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: "right", ratio, first, second });
    const down = (ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: "down", ratio, first, second });
    const leaf = (id: string): LayoutNode => ({ leaf: id });
    const trees: [string, LayoutNode][] = [
      ["demo main", right(0.5, leaf("t1"), leaf("t2"))],
      ["agents", right(0.5, right(0.5, leaf("t1"), leaf("t2")), right(0.5, leaf("t3"), leaf("t4")))],
      ["nested", right(0.25, leaf("a"), down(0.5, leaf("b"), right(0.75, leaf("c"), down(0.1, leaf("d"), leaf("e")))))],
    ];
    for (const [name, tree] of trees) for (const [cols, rows] of [[120, 40], [80, 24], [200, 60]] as const) check(`${name} ${cols}x${rows}`, tree, cols, rows);
  });

  it("in 500 random trees at random sizes", () => {
    let seed = 26;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let leaves = 0;
    const grow = (depth: number): LayoutNode => depth === 0 || random() < 0.3
      ? { leaf: `p${leaves++}` }
      : { split: random() < 0.5 ? "right" : "down", ratio: 0.1 + Math.floor(random() * 9) / 10, first: grow(depth - 1), second: grow(depth - 1) };
    for (let round = 0; round < 500; round++) {
      leaves = 0;
      const cols = 66 + Math.floor(random() * 140);
      const rows = 4 + Math.floor(random() * 50);
      check(`tree ${round} ${cols}x${rows}`, grow(4), cols, rows);
    }
  });
});

describe("each part is drawn again exactly when what it shows changed", () => {
  const versions = (options: Setup) => Object.fromEntries(buildChrome(setup(options).input).parts.map((one) => [one.key, one.version]));
  const base: Setup = { cols: 120, rows: 40 };
  const table: [change: string, after: Setup, changed: string[]][] = [
    ["the shown workspace", { ...base, events: [{ type: "select", target: { kind: "workspace", id: "w-docs" }, at: 1 }] }, ["sidebar", "tabs", "borders"]],
    ["the focused pane", { ...base, events: [{ type: "select", target: { kind: "pane", id: "t2" }, at: 1 }] }, ["sidebar", "borders"]],
    ["the shown tab", { ...base, events: [{ type: "select", target: { kind: "tab", id: "t-logs" }, at: 1 }] }, ["sidebar", "tabs", "borders"]],
    ["an agent's state", { ...base, terminals: [{ ...WORK[0]!, status: { state: "idle", app: "claude" } }, ...WORK.slice(1)] }, ["sidebar", "tabs", "borders"]],
    ["a pane's attach state", { ...base, panes: { t1: pane("t1", { kind: "Waiting", why: "lost" }), t2: pane("t2") } }, ["borders"]],
    ["an armed prefix", { ...base, events: [{ type: "key", key: "B", mods: { ctrl: true, shift: false, alt: false, super: false }, action: "press", at: 1 } as unknown as ModelEvent] }, ["mode"]],
    ["a notice", { ...base, events: [{ type: "notice", code: "not_built", data: { action: "settings" }, at: 1 }] }, ["mode"]],
    ["the link going offline", { ...base, link: { online: false, code: "closed" } }, ["borders", "mode"]],
    ["the key table: the help key moved", { ...base, keys: { help: "prefix+h" } }, ["mode"]],
    ["the session's name", { ...base, session: "other" }, ["sidebar"]],
    ["the folder typed in, on a core with workspaces", { ...base, cwd: "/elsewhere" }, []],
  ];
  const before = versions(base);
  for (const [change, after, changed] of table) {
    it(change, () => {
      const now = versions(after);
      expect(Object.keys(now).filter((key) => now[key] !== before[key])).toEqual(changed);
      const { input } = setup(after);
      const fresh = picture(120, 40, buildChrome(input).parts);
      const painter = new Painter({ sync: false });
      picture(120, 40, buildChrome(setup(base).input).parts, [], [], null, painter);
      const again = picture(120, 40, buildChrome(input).parts, [], [], null, painter);
      expect(noColour(again)).toBe(noColour(fresh));
      expect(again.rows).toEqual(fresh.rows);
    });
  }

  it("the empty core's offer follows a reload of the keys (the key it shows is part of what the borders draw)", () => {
    const empty: Setup = { cols: 120, rows: 40, terminals: [] };
    const reloaded: Setup = { ...empty, events: [{ type: "keys", keys: { new_workspace: "prefix+m" }, at: 1 }] };
    expect(versions(reloaded)["borders"]).not.toBe(versions(empty)["borders"]);
    const painter = new Painter({ sync: false });
    picture(120, 40, buildChrome(setup(empty).input).parts, [], [], null, painter);
    expect(picture(120, 40, buildChrome(setup(reloaded).input).parts, [], [], null, painter).rows[20]).toBe(`${" ".repeat(23)}|  New workspace in my-project (prefix+m)${" ".repeat(56)}`);
    expect(draw({ ...empty, keys: { new_workspace: "" } }).rows[20]).toBe(`${" ".repeat(23)}|  New workspace in my-project${" ".repeat(67)}`);
  });
});

describe("the help draws every keymap note code", () => {
  const help = (keys: unknown, cols = 120, rows = 40) => draw({ cols, rows, keys, events: [{ type: "action", action: "help", at: 1 }] });
  const table: [code: string, keys: unknown, line: string][] = [
    ["no_such_modifier", { split_vertical: "prefix+hyper+v" }, "no_such_modifier: split_vertical (prefix+hyper+v) cannot fire"],
    ["not_typable", { new_tab: "prefix+\u314a" }, "not_typable: new_tab (prefix+\u314a) cannot fire"],
    ["shift_in_text", { zoom: "prefix+shift+space" }, "shift_in_text: zoom (prefix+shift+space) cannot fire"],
    ["shifted_character", { zoom: "ctrl+!" }, "shifted_character: zoom (ctrl+!) cannot fire"],
    ["cancel_key", { zoom: "prefix+esc" }, "cancel_key: zoom (prefix+esc) cannot fire"],
    ["fixed_key", { navigate_pane_down: "left" }, "fixed_key: navigate_pane_down (left) cannot fire"],
    ["taken", { new_tab: "prefix+@", split_vertical: "prefix+shift+2" }, "taken: split_vertical (prefix+shift+2) held by new_tab"],
    ["prefix_fallback", { prefix: "hyper+b" }, "prefix_fallback: hyper+b cannot be typed; using ctrl+b"],
    ["prefix_unreachable", { prefix: "hyper+b", zoom: "ctrl+b", new_tab: "ctrl+a", split_vertical: "ctrl+]", split_horizontal: "ctrl+\\" }, "prefix_unreachable: hyper+b cannot be typed and all fallbacks are held (ctrl+b->zoom, ctrl+a->new_tab, ctrl+]->split_vertical, ctrl+\\->split_horizontal); use menu or close terminal"],
    ["detach_fallback", { detach: "" }, "detach_fallback: detach uses prefix+q"],
    ["detach_unreachable", { close_pane: "prefix+q", zoom: "prefix+ctrl+q", new_tab: "prefix+alt+q" }, "detach_unreachable: no key can detach (prefix+q->close_pane, prefix+ctrl+q->zoom, prefix+alt+q->new_tab); use action detach or close terminal"],
    ["indexed_legacy", { indexed: { tabs: "ctrl" } }, "indexed_legacy: [keys.indexed].tabs is ignored"],
    ["blank_binding", { zoom: " " }, "blank_binding: zoom unbound by blank entry"],
    ["lock_taken", { new_tab: "ctrl+alt+g" }, "lock_taken: lock key held by new_tab"],
  ];
  for (const [code, keys, line] of table) {
    it(code, () => {
      for (const [cols, rows] of [[200, 60], [120, 40], [80, 24]] as const) {
        const shot = help(keys, cols, rows);
        const room = cols - 8 - 4;
        const at = shot.rows.findIndex((text) => text.includes(line.slice(0, Math.min(line.length, room - 1))));
        expect({ code, cols, drawn: at > 1 }).toEqual({ code, cols, drawn: true });
      }
    });
  }

  it("an unreachable prefix or detach is also named on the mode bar", () => {
    expect(draw({ cols: 120, rows: 40, keys: table[8]![1] }).rows[39]).toContain(" [prefix_unreachable] ");
    expect(draw({ cols: 120, rows: 40, keys: table[10]![1] }).rows[39]).toContain(" [detach_unreachable] ");
  });
});

describe("names cut at a wide character keep every cell whole", () => {
  const wideNames = [
    term("t1", "w1", "x한글이름이아주긴작업공간입니다", "tab1", "🚀로켓😀👨‍👩‍👧‍👦🇰🇷끝까지가는탭이름", {}, "가나다라마바사아자차카타파하가나다라마바사아자차카타파하"),
    term("t2", "w2", "e\u0301a\u0308o\u0302-한가-กำx", "tab2", "short"),
    term("t3", "w3", "ctl\u001bname-abcdef", "tab3", "x", { status: { state: "done", app: "claude" }, reported: true, turn: 2 }),
  ];
  for (const [cols, rows] of [[120, 40], [80, 24], [66, 12]] as const) {
    it(`at ${cols}x${rows}: no half wide cell, and the cell before each … is a whole grapheme`, () => {
      const shot = draw({ cols, rows, terminals: wideNames });
      const screen = shot.painter.screen;
      for (let at = 0; at < screen.text.length; at++) {
        const col = at % cols;
        if (screen.width[at] === 2) expect({ at, next: screen.width[at + 1], last: col === cols - 1 }).toEqual({ at, next: 0, last: false });
        if (screen.width[at] === 0) expect({ at, before: col > 0 ? screen.width[at - 1] : null }).toEqual({ at, before: 2 });
        if (screen.text[at] === "…" && col > 0) expect({ at, before: screen.width[at - 1] === 0 ? screen.width[at - 2] : screen.width[at - 1] }).toEqual({ at, before: screen.width[at - 1] === 0 ? 2 : 1 });
      }
    });
  }

  it("at 120x40: the cut Korean names, as cells", () => {
    const shot = draw({ cols: 120, rows: 40, terminals: wideNames });
    expect(shot.rows.slice(2, 5).map((line) => line.slice(0, line.indexOf("||") + 2))).toEqual([
      ">·1:x한글이름이아주긴… ||",
      " ·2:e\u0301a\u0308o\u0302-한가-กำx       ||",
      " *3:ctl\ufffdname-abcd… Done||",
    ]);
    expect(shot.rows[0]!.startsWith("hc:work              <<| 1:🚀로켓😀👨‍👩‍👧‍👦🇰🇷끝까지가는탭이름 ")).toBe(true);
    expect(shot.rows[1]!.startsWith("Workspaces             |+- 가나다라마바사아자차카타파하가나다라마바사아자차카타파하 proj -")).toBe(true);
    const narrow = draw({ cols: 80, rows: 24, terminals: wideNames }).rows[1]!;
    expect(narrow.slice(0, narrow.indexOf("…") + 3)).toBe("Workspaces             |+- 가나다라마바사아자차카타파하가나다라마바사아자차카…-+");
  });
});

describe("whole-screen proofs on the runner", () => {
  it("demo, agents and machines fixtures at 120x40, 80x24 and 200x60", async () => {
    const expected: Record<string, [row: number, text: string][]> = {
      "120x40": [[0, "hc:default           <<| 1:main  2:logs"], [2, ">·1:ovis               ||$ echo 안녕"], [3, " ·2:문서               ||안녕하세요, 헤르더 세계"]],
      "80x24": [[0, "hc:default           <<| 1:main  2:logs"], [3, " ·2:문서               ||안녕하세요, 헤르더 세계"]],
      "200x60": [[0, "hc:default           <<| 1:main  2:logs"], [3, " ·2:문서               ||안녕하세요, 헤르더 세계"]],
    };
    for (const [cols, rows] of [[120, 40], [80, 24], [200, 60]] as const) {
      const run = await Run.start({ fixture: demo, cols, rows });
      try {
        await run.live();
        await run.advance(10);
        const grid = run.grid();
        for (const [row, text] of expected[`${cols}x${rows}`]!) expect({ cols, row, text: grid[row]!.slice(0, [...text].length) }).toEqual({ cols, row, text });
        expect(grid[rows - 1]!.startsWith(" TERMINAL  ctrl+b prefix prefix+enter menu prefix+? help")).toBe(true);
      } finally {
        await run.close();
      }
    }
    const agentRun = await Run.start({ fixture: agents, cols: 120, rows: 40 });
    try {
      await agentRun.live();
      await agentRun.advance(20);
      expect(agentRun.grid().slice(3, 8).map((line) => line.slice(0, 24))).toEqual([
        "Agents                 |",
        " ! blocked /… Needs you|",
        " ~ working / c… Working|",
        " * done / claude   Done|",
        " - idle / claude  Ready|",
      ]);
    } finally {
      await agentRun.close();
    }
    const machineRun = await Run.start({ fixture: machines, cols: 120, rows: 40 });
    try {
      await machineRun.live();
      await machineRun.advance(20);
      expect(machineRun.grid()[2]!.slice(0, 24)).toBe(">·1:home               |");
    } finally {
      await machineRun.close();
    }
  }, 120_000);

  it("the mode bar in each mode, the help and its close key, a notice, and the offline line after the line is cut", async () => {
    const run = await Run.start({ fixture: demo, cols: 120, rows: 40 });
    const bar = () => run.grid()[39]!;
    try {
      await run.live();
      await run.advance(1);
      await run.keys("ctrl+b");
      await run.advance(20);
      expect(bar().startsWith(" PREFIX  ? help s settings")).toBe(true);
      await run.keys("?");
      await run.advance(20);
      expect(run.grid()[2]!.slice(4, 116)).toBe(`+ Keyboard Shortcuts ${"-".repeat(68)} [close: esc / q / ?] +`);
      await run.keys("q");
      await run.advance(200);
      expect(run.grid()[2]!.slice(0, 24)).toBe(">·1:ovis               |");
      for (const [keys, mode] of [["ctrl+b,w", " NAVIGATE "], ["ctrl+b,r", " RESIZE "], ["ctrl+b,[", " COPY "]] as const) {
        await run.keys(keys);
        await run.advance(20);
        expect({ keys, bar: bar().slice(0, mode.length) }).toEqual({ keys, bar: mode });
        await run.keys("esc");
        await run.advance(200);
      }
      await run.keys("ctrl+b,s");
      await run.advance(20);
      expect(bar().endsWith("ERROR: not_built: settings is not built in this screen")).toBe(true);
      expect(run.grid()[2]!.includes("! not_built: settings is not built in this screen")).toBe(true);
      await run.cutLine();
      await run.advance(1_000);
      expect(bar().startsWith(" TERMINAL  herdr-core is not answering: hc server start (")).toBe(true);
      expect(run.grid()[38]!.slice(24, 62)).toBe("+- herdr-core is not answering · hc se");
    } finally {
      await run.close();
    }
  }, 120_000);

  it("a pane whose program exits shows ended (code) in its place until the core removes it", async () => {
    const run = await Run.start({ fixture: demo, cols: 120, rows: 40 });
    try {
      await run.live();
      await run.advance(1);
      run.core.program("t1").exit(3);
      await run.settle();
      await run.advance(20);
      expect(run.grid()[38]!.slice(24, 40)).toBe("+- ended (3) ---");
      expect(run.grid()[1]!.slice(24, 34)).toBe("+- shell /");
      run.core.remove("t1");
      await run.settle();
      await run.advance(20);
      expect(run.grid()[1]!.slice(24, 34)).toBe("+- files /");
      expect(run.grid().some((line) => line.includes("ended ("))).toBe(false);
    } finally {
      await run.close();
    }
  }, 120_000);
});

it("names the hc session from its socket path", () => {
  expect(sessionFromSocket("/run/user/1000/herdr-core/default.sock")).toBe("default");
  expect(sessionFromSocket("/run/user/1000/herdr-core/work.2.sock")).toBe("work.2");
  expect(sessionFromSocket("/run/user/1000/herdr-core/hc.sock")).toBe("default");
});

describe("calm notices", () => {
  it("a calm notice is drawn without the error badge and with the plain glyph; another keeps both", () => {
    const calm = draw({ cols: 120, rows: 40, events: [{ type: "notice", code: "layout_unchanged", data: { action: "zoom", reason: "single_pane" }, calm: true, at: 1 }] });
    const error = draw({ cols: 120, rows: 40, events: [{ type: "notice", code: "layout_refused", data: { action: "zoom", reason: "pane_not_found" }, at: 1 }] });
    expect(calm.rows[39]!.endsWith(" layout_unchanged: action=zoom reason=single_pane ")).toBe(true);
    expect(calm.rows[39]!.includes("ERROR")).toBe(false);
    expect(calm.rows.some((row) => row.includes("- layout_unchanged: action=zoom reason=single_pane"))).toBe(true);
    expect(error.rows[39]!.endsWith(" ERROR: layout_refused: action=zoom reason=pane_not_found ")).toBe(true);
    expect(error.rows.some((row) => row.includes("! layout_refused: action=zoom reason=pane_not_found"))).toBe(true);
  });
});
