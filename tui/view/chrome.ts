/**
 * The terminal screen's chrome, following herdr's own client screen (src/AGENTS.md): the sidebar (the session header
 * with its collapse toggle, workspaces with roll-up state marks and their linked worktrees, agents in shared/attention.ts
 * order), the tab bar, pane borders with titles and state banners, the mode bar and hint line from the one key table,
 * and the overlays (help from the same table, the text field, the confirm dialog, the goto picker, notice toasts).
 *
 * Each part is built in two steps: its builder works out everything the part shows as plain data, and `draw` paints
 * only that data. A part's `version` is that data, so a part is drawn again exactly when something it shows changed.
 */

import { knownStatus, type KnownStatus } from "../../shared/attention.ts";
import { folderName } from "../../shared/pane-title.ts";
import type { PaneView } from "../core/pane.ts";
import type { CoreView } from "../core/world.ts";
import { STYLE_BOLD, STYLE_INVERSE, type WrittenColor } from "../emulator/index.ts";
import type { ColorDepth } from "../host/index.ts";
import { focused } from "../model/focus.ts";
import { helpRows, modeBar, shownRefusals } from "../model/hints.ts";
import type { KeymapNote } from "../model/keymap.ts";
import { entryKey, type MenuEntry } from "../model/menu.ts";
import { type Field, type Overlay, OVERLAYS } from "../model/overlays.ts";
import type { ModelState } from "../model/reduce.ts";
import { STRINGS } from "../strings.ts";
import { TUI_THEMES, type TuiColorRole, type TuiThemeMode } from "../theme.generated.ts";
import type { Rect, Regions, SplitCells } from "./geometry.ts";
import { hostLayout, type LaidCell } from "./host-layout.ts";
import type { ShownLink } from "./link-view.ts";
import { nearest256, type Canvas, type Part, type Scene } from "./paint.ts";
import type { PaneSpot } from "./screen.ts";

type Colors = Readonly<Record<TuiColorRole, WrittenColor>>;

const palettes = new Map<string, Colors>();

/** The theme's colours for the host: RGB on a truecolor host, the nearest xterm-256 index on a 256-colour one. */
function themeColors(mode: TuiThemeMode, depth: ColorDepth): Colors {
  const look = `${mode}/${depth}`;
  const known = palettes.get(look);
  if (known) return known;
  const palette = TUI_THEMES[mode];
  const colors = Object.fromEntries((Object.keys(palette) as TuiColorRole[]).map((role) => [role, depth === "256" ? nearest256(palette[role]) : palette[role]])) as Colors;
  palettes.set(look, colors);
  return colors;
}

/** The hc session named by a socket path, for the header when the entry was handed no session name. */
export function sessionFromSocket(socket: string): string {
  const base = socket.split(/[\\/]/).at(-1) ?? "default";
  const stripped = base.replace(/\.sock$/, "");
  if (stripped === "hc" || stripped === "") return "default";
  return stripped.replace(/^herdr-core-[^-]*-/, "") || "default";
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
const PRINTABLE_ASCII = /^[\u0020-\u007e]*$/;

/**
 * `text` as the host lays it out (host-layout.ts, never Bun.stringWidth). Printable ASCII takes one cell a character on
 * every host, so it skips the engine: a cold first frame lays out hundreds of such labels.
 */
function measure(text: string): { cells: readonly LaidCell[]; width: number } {
  if (text === "") return { cells: [], width: 0 };
  if (PRINTABLE_ASCII.test(text)) return { cells: [...text].map((char, col): LaidCell => ({ col, text: char, width: 1 })), width: text.length };
  const laid = hostLayout.layout(text.replace(CONTROL, "\ufffd"));
  return { cells: laid.cells, width: laid.end };
}

/**
 * Prints `text` from `col` in at most `room` columns, each cell at the width the host gives it; a wide cell that would
 * cross the edge is left out whole. With `ellipsis`, a cut text ends in `…`. Answers the column after the last cell.
 */
function printFit(canvas: Canvas, col: number, row: number, text: string, room: number, style: number, ellipsis = false): number {
  if (room <= 0 || text === "") return col;
  const { cells, width } = measure(text);
  const cut = width > room;
  const limit = cut && ellipsis && room >= 2 ? room - 1 : room;
  let end = 0;
  for (const cell of cells) {
    if (cell.col + cell.width > limit) break;
    canvas.put(col + cell.col, row, cell.text, cell.width, style);
    end = cell.col + cell.width;
  }
  if (cut && ellipsis && room >= 2) {
    canvas.put(col + end, row, "…", 1, style);
    end += 1;
  }
  return col + end;
}

function fillSpan(canvas: Canvas, col: number, row: number, width: number, style: number): void {
  for (let c = col; c < col + width; c++) canvas.put(c, row, " ", 1, style);
}

function box(canvas: Canvas, rect: Rect, style: number): void {
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  for (let col = rect.x; col <= right; col++) {
    const edge = col === rect.x || col === right ? "+" : "-";
    canvas.put(col, rect.y, edge, 1, style);
    canvas.put(col, bottom, edge, 1, style);
  }
  for (let row = rect.y + 1; row < bottom; row++) {
    canvas.put(rect.x, row, "|", 1, style);
    canvas.put(right, row, "|", 1, style);
  }
}

/** Each state's own glyph and word, so a state never shows by colour alone. */
const STATE_LOOK: Readonly<Record<KnownStatus, { glyph: string; word: string; role: TuiColorRole }>> = {
  blocked: { glyph: STRINGS.glyphBlocked, word: STRINGS.stateBlocked, role: "statusBlocked" },
  done: { glyph: STRINGS.glyphDone, word: STRINGS.stateDone, role: "statusDone" },
  working: { glyph: STRINGS.glyphWorking, word: STRINGS.stateWorking, role: "statusWorking" },
  waiting: { glyph: STRINGS.glyphWorking, word: STRINGS.stateWorking, role: "statusWorking" },
  idle: { glyph: STRINGS.glyphIdle, word: STRINGS.stateIdle, role: "statusIdle" },
  unknown: { glyph: STRINGS.glyphUnknown, word: "", role: "indicatorUnknown" },
};

const stateLook = (status: string | undefined) => STATE_LOOK[knownStatus(status)];

const actionLabel = (action: string): string => STRINGS.actions[action] ?? action.replaceAll("_", " ");

interface ChromeInput {
  readonly regions: Regions;
  readonly spots: readonly PaneSpot[];
  readonly splits: readonly SplitCells[];
  readonly state: ModelState;
  readonly world: CoreView;
  readonly panes: ReadonlyMap<string, PaneView>;
  readonly link: ShownLink;
  readonly session: string;
  /** the folder `ovis` was typed in, offered for a first workspace on an empty core */
  readonly cwd: string;
  readonly theme?: TuiThemeMode;
  readonly colors?: ColorDepth;
}

interface BuiltChrome {
  readonly parts: Part[];
  readonly overlays: Part[];
  readonly input: Scene["input"];
}

/** A part whose version is exactly the data it draws (and the colours it draws them in). */
function part<T>(key: string, rect: Rect, look: string, data: T, draw: (canvas: Canvas, data: T) => void): Part {
  return { key, rect, version: JSON.stringify([look, data]), draw: (canvas) => draw(canvas, data) };
}

interface WorkspaceLine { readonly id: string; readonly label: string; readonly status: KnownStatus; readonly name: string; readonly selected: boolean }
interface AgentLine { readonly id: string; readonly helper: boolean; readonly status: KnownStatus; readonly text: string; readonly selected: boolean }

/** The first index of a window of `size` items over `count` that keeps `focus` in its middle. */
function windowStart(count: number, size: number, focus: number): number {
  return count <= size ? 0 : Math.min(Math.max(0, focus - Math.floor(size / 2)), count - size);
}

function sidebarPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, world, session } = input;
  const rect = regions.sidebar;
  const shown = focused(state.world, state.focus);
  const activeWorkspace = state.mode.name === "navigate" && state.mode.preview !== null ? state.mode.preview : shown.workspace?.id ?? null;
  const focusedPane = shown.pane?.id ?? null;
  const fixedRows = 1 + (world.ownsLayout ? 0 : 1) + 1;
  const left = Math.max(0, rect.height - fixedRows);
  const workspaces = world.workspaceGroups.flatMap((group) => [
    { ...group, label: `${group.number}:` },
    ...group.children.map((child) => ({ ...child, label: `${STRINGS.worktreeMark}${child.number}:` })),
  ]).map((row): WorkspaceLine => ({ id: row.id, label: row.label, status: row.status, name: row.name, selected: row.id === activeWorkspace }));
  const agentRows = world.agents.length > 0 ? Math.min(world.agents.length + 1, Math.max(2, Math.floor(left / 2))) : 2;
  const workspaceRows = Math.max(1, left - agentRows);
  const wsStart = windowStart(workspaces.length, workspaceRows, Math.max(0, workspaces.findIndex((line) => line.selected)));
  const shownWorkspaces = workspaces.slice(wsStart, wsStart + workspaceRows);
  const agentsLeft = Math.max(0, left - Math.max(1, shownWorkspaces.length) - 1);
  const agents = world.agents.map((agent): AgentLine => {
    const where = agent.folder ? ` ${agent.folder === "/" ? "/" : `/${agent.folder}`}` : "";
    const what = agent.agent && agent.agent !== agent.name ? ` ${agent.agent}` : "";
    return { id: agent.paneId, helper: agent.helper, status: knownStatus(agent.status), text: `${agent.name}${where}${what}`, selected: agent.paneId === focusedPane };
  });
  const agentStart = windowStart(agents.length, agentsLeft, Math.max(0, agents.findIndex((line) => line.selected)));
  const data = {
    header: STRINGS.sessionHeader(session),
    appOwned: !world.ownsLayout,
    workspaces: shownWorkspaces,
    agents: agents.slice(agentStart, agentStart + agentsLeft),
  };
  return part("sidebar", rect, look, data, (canvas, { header, appOwned, workspaces: lines, agents: agentLines }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const base = canvas.style({ fg: colors.text, bg: colors.bgPanel });
    const dim = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
    const section = canvas.style({ fg: colors.textDim, bg: colors.bgPanel, flags: STYLE_BOLD });
    const rule = canvas.style({ fg: colors.border, bg: colors.bgPanel });
    canvas.fill(base);
    const width = Math.max(1, rect.width - 1);
    const bottom = rect.y + rect.height;
    for (let r = rect.y; r < bottom; r++) canvas.put(rect.x + rect.width - 1, r, "|", 1, rule);

    let row = rect.y;
    const head = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD });
    fillSpan(canvas, rect.x, row, width, head);
    const toggle = STRINGS.sidebarToggleCollapse;
    printFit(canvas, rect.x, row, header, Math.max(0, width - toggle.length - 1), head, true);
    if (width > toggle.length) canvas.hit({ x: rect.x, y: row, width: width - toggle.length, height: 1 }, "menu");
    if (width >= toggle.length) {
      const at = rect.x + width - toggle.length;
      printFit(canvas, at, row, toggle, toggle.length, canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD }));
      canvas.hit({ x: at, y: row, width: toggle.length, height: 1 }, "toggle_sidebar");
    }
    row++;
    if (appOwned && row < bottom) printFit(canvas, rect.x, row++, STRINGS.appOwnedCore, width, canvas.style({ fg: colors.notice, bg: colors.bgPanel }), true);
    if (row >= bottom) return;
    printFit(canvas, rect.x, row++, STRINGS.workspacesSection, width, section);
    if (lines.length === 0 && row < bottom) printFit(canvas, rect.x, row++, ` ${STRINGS.noSpaces}`, width, dim, true);
    for (const line of lines) {
      if (row >= bottom) return;
      const bg = line.selected ? colors.bgHover : colors.bgPanel;
      const style = canvas.style({ fg: line.selected ? colors.textStrong : colors.text, bg, flags: line.selected ? STYLE_BOLD : 0 });
      fillSpan(canvas, rect.x, row, width, style);
      const state = STATE_LOOK[line.status];
      const end = rect.x + width;
      let col = printFit(canvas, rect.x, row, line.selected ? ">" : " ", 1, canvas.style({ fg: colors.accent, bg, flags: STYLE_BOLD }));
      col = printFit(canvas, col, row, state.glyph, 1, canvas.style({ fg: colors[state.role], bg, flags: STYLE_BOLD }));
      col = printFit(canvas, col, row, line.label, end - col, style);
      const word = state.word ? ` ${state.word}` : "";
      const wordWidth = measure(word).width;
      col = printFit(canvas, col, row, line.name, Math.max(1, end - col - (end - col > wordWidth + 3 ? wordWidth : 0)), style, true);
      if (word && end - col >= wordWidth) printFit(canvas, end - wordWidth, row, word, wordWidth, canvas.style({ fg: colors[state.role], bg }));
      canvas.hit({ x: rect.x, y: row, width, height: 1 }, `workspace:${line.id}`);
      row++;
    }
    if (row >= bottom) return;
    printFit(canvas, rect.x, row++, STRINGS.agentsSection, width, section);
    if (agentLines.length === 0 && row < bottom) printFit(canvas, rect.x, row, ` ${STRINGS.noAgents}`, width, dim, true);
    for (const line of agentLines) {
      if (row >= bottom) return;
      const bg = line.selected ? colors.bgHover : colors.bgPanel;
      const style = canvas.style({ fg: line.selected ? colors.textStrong : colors.text, bg, flags: line.selected ? STYLE_BOLD : 0 });
      fillSpan(canvas, rect.x, row, width, style);
      const state = STATE_LOOK[line.status];
      const mark = canvas.style({ fg: colors[state.role], bg, flags: STYLE_BOLD });
      const end = rect.x + width;
      let col = printFit(canvas, rect.x, row, line.helper ? ` ${STRINGS.helperMark}` : " ", 2, canvas.style({ fg: colors.textDim, bg }));
      col = printFit(canvas, col, row, `${state.glyph} `, 2, mark);
      const word = state.word ? ` ${state.word}` : "";
      const wordWidth = measure(word).width;
      const room = Math.max(0, end - col);
      col = printFit(canvas, col, row, line.text, room > wordWidth + 4 ? room - wordWidth : room, style, true);
      if (word && end - col >= wordWidth) printFit(canvas, end - wordWidth, row, word, wordWidth, mark);
      canvas.hit({ x: rect.x, y: row, width, height: 1 }, `agent:${line.id}`);
      row++;
    }
  });
}

interface TabEntry { readonly id: string; readonly label: string; readonly active: boolean; readonly named: boolean }

/** The range of tabs that fits in `room` columns around the active one, leaving two columns for each arrow that marks tabs left out. */
function tabWindow(entries: readonly { width: number; active: boolean }[], room: number): { start: number; end: number } {
  const total = entries.reduce((sum, entry) => sum + entry.width, 0);
  if (total <= room) return { start: 0, end: entries.length };
  const active = Math.max(0, entries.findIndex((entry) => entry.active));
  let start = active;
  let end = active + 1;
  let used = entries[active]!.width;
  for (;;) {
    let grew = false;
    if (end < entries.length && used + entries[end]!.width <= room - (start > 0 ? 2 : 0)) {
      used += entries[end++]!.width;
      grew = true;
    }
    if (start > 0 && used + entries[start - 1]!.width <= room - (end < entries.length ? 2 : 0)) {
      used += entries[--start]!.width;
      grew = true;
    }
    if (!grew) return { start, end };
  }
}

/**
 * The narrow screen's header, in the tab bar's row: the shown workspace with its state mark, the shown tab of how many,
 * the hc session, how many agents elsewhere need the user, and the menu's mark. A click anywhere on it opens the menu.
 */
function headerPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, world, session } = input;
  const rect = regions.tabBar;
  const shown = focused(state.world, state.focus);
  const row = world.workspaceGroups.flatMap((group) => [group, ...group.children]).find((one) => one.id === shown.workspace?.id);
  const tabs = shown.workspace?.tabs ?? [];
  const tabAt = tabs.findIndex((tab) => tab.id === shown.tab?.id);
  const tab = tabAt < 0 ? "" : ` ${tabAt + 1}/${tabs.length}:${tabs[tabAt]!.name || tabAt + 1}`;
  const waiting = world.agents.filter((agent) => knownStatus(agent.status) === "blocked" && agent.paneId !== shown.pane?.id).length;
  const data = {
    status: row?.status ?? "unknown",
    place: row ? `${row.number}:${row.name}${tab} ${STRINGS.sessionHeader(session)}` : `${STRINGS.noSpaces} ${STRINGS.sessionHeader(session)}`,
    waiting: waiting > 0 ? ` ${STRINGS.glyphBlocked}${waiting}` : "",
  };
  return part("header", rect, look, data, (canvas, { status, place, waiting: others }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const head = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD });
    canvas.fill(head);
    const right = rect.x + rect.width;
    const mark = ` ${STRINGS.menuMark}`;
    const markAt = Math.max(rect.x, right - measure(mark).width);
    const othersAt = Math.max(rect.x, markAt - measure(others).width);
    const state = STATE_LOOK[status];
    const col = printFit(canvas, rect.x, rect.y, state.glyph, Math.min(1, othersAt - rect.x), canvas.style({ fg: colors[state.role], bg: colors.bgElevated, flags: STYLE_BOLD }));
    printFit(canvas, col, rect.y, place, othersAt - col, head, true);
    printFit(canvas, othersAt, rect.y, others, markAt - othersAt, canvas.style({ fg: colors.statusBlocked, bg: colors.bgElevated, flags: STYLE_BOLD }));
    printFit(canvas, markAt, rect.y, mark, right - markAt, canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD }));
    canvas.hit(rect, "menu");
  });
}

function tabBarPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, world, session } = input;
  const rect = regions.tabBar;
  if (regions.narrow) return headerPart(input, colors, look);
  const shown = focused(state.world, state.focus);
  const activeTab = shown.tab?.id ?? null;
  const zoomed = activeTab !== null && (world.tabs.get(activeTab)?.zoomed ?? null) !== null;
  const header = regions.sidebar.width === 0 ? `${STRINGS.sessionHeader(session)} ` : null;
  const entries = (shown.workspace?.tabs ?? []).map((tab, at): TabEntry => {
    const number = String(at + 1);
    const status = knownStatus(world.tabStatuses.get(tab.id));
    const mark = status !== "unknown" && status !== "idle" ? ` ${STATE_LOOK[status].glyph}` : "";
    const zoom = (world.tabs.get(tab.id)?.zoomed ?? null) !== null ? STRINGS.tabZoomSuffix : "";
    return { id: tab.id, label: ` ${number}:${tab.name || number}${zoom}${mark} `, active: tab.id === activeTab, named: tab.name !== "" && tab.name !== number };
  });
  let left = rect.x + (header === null ? 0 : Math.min(measure(header).width, rect.width));
  let right = rect.x + rect.width;
  const zoomBadge = ` ${STRINGS.zoomMark} `;
  const showZoom = zoomed && right - left >= measure(zoomBadge).width;
  if (showZoom) right -= measure(zoomBadge).width;
  const ownedBadge = ` ${STRINGS.appOwnedCore} `;
  const showOwned = !world.ownsLayout && right - left >= measure(ownedBadge).width + 12;
  if (showOwned) right -= measure(ownedBadge).width;
  const widths = entries.map((entry) => ({ width: measure(entry.label).width, active: entry.active }));
  const { start, end } = tabWindow(widths, Math.max(0, right - left));
  const data = { header, showZoom, showOwned, empty: entries.length === 0, tabs: entries.slice(start, end), before: start > 0, after: end < entries.length };
  return part("tabs", rect, look, data, (canvas, { header: head, showZoom: zoom, showOwned: owned, empty, tabs, before, after }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const bar = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
    const arrow = canvas.style({ fg: colors.accent, bg: colors.bgPanel, flags: STYLE_BOLD });
    canvas.fill(bar);
    const row = rect.y;
    let col = rect.x;
    let edge = rect.x + rect.width;
    if (head !== null) {
      col = printFit(canvas, col, row, head, rect.width, canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD }));
      canvas.hit({ x: rect.x, y: row, width: col - rect.x, height: 1 }, "toggle_sidebar");
    }
    if (zoom) {
      edge -= measure(zoomBadge).width;
      printFit(canvas, edge, row, zoomBadge, measure(zoomBadge).width, canvas.style({ fg: colors.primaryText, bg: colors.accent, flags: STYLE_BOLD }));
    }
    if (owned) {
      edge -= measure(ownedBadge).width;
      printFit(canvas, edge, row, ownedBadge, measure(ownedBadge).width, canvas.style({ fg: colors.notice, bg: colors.bgPanel }));
    }
    if (empty) {
      printFit(canvas, col, row, ` ${STRINGS.noTabs}`, edge - col, bar, true);
      return;
    }
    if (before) col = printFit(canvas, col, row, "< ", Math.min(2, edge - col), arrow);
    for (const tab of tabs) {
      const room = edge - col - (after ? 2 : 0);
      if (room <= 0) break;
      const style = canvas.style({ fg: tab.active ? colors.accent : colors.text, bg: tab.active ? colors.bgElevated : colors.bgPanel, flags: tab.active || tab.named ? STYLE_BOLD : 0 });
      const from = col;
      col = printFit(canvas, col, row, tab.label, room, style, true);
      canvas.hit({ x: from, y: row, width: col - from, height: 1 }, `tab:${tab.id}`);
    }
    if (after && col < edge) printFit(canvas, Math.max(col, edge - 2), row, " >", Math.min(2, edge - col), arrow);
  });
}

type Tone = "error" | "warn" | "info";

/** What a pane's bottom border says of it: why its picture is not live, or who sizes it; null for a plain live pane. */
function paneBanner(view: PaneView | undefined, link: ShownLink): { text: string; tone: Tone } | null {
  if (!link.online) return { text: STRINGS.offlinePaneBanner(), tone: "warn" };
  if (!view) return null;
  const { state, sizedBy } = view;
  switch (state.kind) {
    case "Ended":
      return { text: STRINGS.endedCode(state.code), tone: "info" };
    case "Waiting":
      return { text: state.why === "lost" ? STRINGS.waitingNewShell : state.why === "offline" ? STRINGS.waitingOffline : STRINGS.waitingClosed, tone: "warn" };
    case "Failed":
      return { text: STRINGS.failedPane(state.reason), tone: "error" };
    case "Opening":
      return { text: STRINGS.openingPane, tone: "info" };
    case "Painting":
      return { text: STRINGS.paintingPane, tone: "info" };
    case "Closing":
      return { text: STRINGS.closingPane, tone: "info" };
    case "Idle":
      return { text: STRINGS.idlePane, tone: "info" };
    case "Live":
      return sizedBy === null ? null : { text: STRINGS.sizedByViewer(sizedBy.cols, sizedBy.rows), tone: "warn" };
  }
}

/** The text a key-table action is typed with, as the help shows it; null when nothing is bound to it. */
function keyText(state: ModelState, action: string): string | null {
  return helpRows(state.keymap).find((row) => row.action === action)?.keys[0] ?? null;
}

function bordersPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, spots, splits, state, world, panes, link, cwd } = input;
  const rect = regions.panes;
  const shown = focused(state.world, state.focus);
  const zoomed = shown.tab ? world.tabs.get(shown.tab.id)?.zoomed ?? null : null;
  const visible = spots.filter((spot) => !spot.covered);
  const empty = visible.length === 0
    ? link.online
      ? { offline: null, offer: STRINGS.emptyCoreOffer(folderName(cwd), keyText(state, "new_workspace")), appOwned: !world.ownsLayout }
      : { offline: STRINGS.offlineDetail(link.code), offer: null, appOwned: false }
    : null;
  const boxes = visible.map((spot) => {
    const summary = world.panes.get(spot.pane);
    const name = summary?.label || summary?.title || spot.pane;
    const folder = summary?.folder && summary.folder !== name ? ` ${summary.folder}` : "";
    const agent = summary?.agent ? ` [${summary.agent}]` : "";
    const zoom = zoomed === spot.pane ? ` [${STRINGS.zoomMark}]` : "";
    const status = stateLook(summary?.status);
    const word = status.word ? ` ${status.glyph} ${status.word}` : "";
    const { outer, inner } = spot.cells;
    return {
      outer,
      bordered: outer.width !== inner.width && outer.height !== inner.height,
      focused: spot.pane === shown.pane?.id && link.online,
      title: ` ${name}${folder}${agent}${zoom}${word} `,
      banner: paneBanner(panes.get(spot.pane), link),
    };
  });
  const dividers = splits.filter((split) => split.divider.width > 0).map(({ id, divider }) => ({ id, divider }));
  const data = { empty, offline: !link.online, boxes, dividers };
  return part("borders", rect, look, data, (canvas, { empty: none, offline, boxes: drawn, dividers: seams }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    if (none) {
      canvas.fill(canvas.style({ fg: colors.text, bg: colors.bg }));
      const middle = rect.y + Math.floor(rect.height / 2);
      const room = Math.max(0, rect.width - 4);
      if (none.offline !== null) {
        printFit(canvas, rect.x + 2, Math.max(rect.y, middle - 1), none.offline, room, canvas.style({ fg: colors.notice, bg: colors.bgElevated, flags: STYLE_BOLD }), true);
        return;
      }
      if (middle - 1 >= rect.y) printFit(canvas, rect.x + 2, middle - 1, STRINGS.emptyCoreTitle, room, canvas.style({ fg: colors.textStrong, bg: colors.bg, flags: STYLE_BOLD }), true);
      printFit(canvas, rect.x + 2, middle, none.offer ?? "", room, canvas.style({ fg: colors.accent, bg: colors.bg }), true);
      if (none.appOwned && middle + 1 < rect.y + rect.height) printFit(canvas, rect.x + 2, middle + 1, STRINGS.appOwnedCore, room, canvas.style({ fg: colors.notice, bg: colors.bg }), true);
      canvas.hit(rect, "new_workspace");
      return;
    }
    for (const pane of drawn) {
      if (!pane.bordered) continue;
      const { outer } = pane;
      box(canvas, outer, canvas.style({ fg: offline ? colors.notice : pane.focused ? colors.accent : colors.borderStrong, bg: colors.bg, flags: pane.focused ? STYLE_BOLD : 0 }));
      const room = Math.max(0, outer.width - 4);
      printFit(canvas, outer.x + 2, outer.y, pane.title, room, canvas.style({ fg: pane.focused ? colors.textStrong : colors.text, bg: colors.bg, flags: pane.focused ? STYLE_BOLD : 0 }), true);
      if (pane.banner && room > 0) {
        const fg = pane.banner.tone === "error" ? colors.dangerText : pane.banner.tone === "warn" ? colors.notice : colors.textDim;
        printFit(canvas, outer.x + 2, outer.y + outer.height - 1, ` ${pane.banner.text} `, room, canvas.style({ fg, bg: colors.bgElevated, flags: STYLE_BOLD }), true);
      }
    }
    for (const { id, divider } of seams) canvas.hit(divider, id);
  });
}

function noteText(note: KeymapNote): string {
  switch (note.code) {
    case "prefix_fallback":
      return STRINGS.notePrefixFallback(note.binding, note.fallback);
    case "prefix_unreachable":
      return STRINGS.notePrefixUnreachable(note.binding, note.skipped);
    case "detach_fallback":
      return STRINGS.noteDetachFallback(note.fallback);
    case "detach_unreachable":
      return STRINGS.noteDetachUnreachable(note.skipped);
    case "lock_taken":
      return STRINGS.noteLockTaken(note.holder);
    case "taken":
      return STRINGS.noteTaken(note.action, note.binding, note.holder);
    case "indexed_legacy":
      return STRINGS.noteIndexedLegacy(note.entry);
    case "blank_binding":
      return STRINGS.noteBlankBinding(note.action);
    case "no_such_modifier":
    case "not_typable":
    case "shift_in_text":
    case "shifted_character":
    case "cancel_key":
    case "fixed_key":
      return STRINGS.noteDropped(note.code, note.action, note.binding);
  }
}

const MODE_LABELS = {
  prefix: STRINGS.modePrefix,
  locked: STRINGS.modeLocked,
  navigate: STRINGS.modeNavigate,
  resize: STRINGS.modeResize,
  copy: STRINGS.modeCopy,
  terminal: STRINGS.modeTerminal,
} as const;

function modeBarPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, link } = input;
  const rect = regions.modeBar;
  const bar = modeBar(state);
  const latest = state.notices.at(-1);
  const data = {
    mode: bar.mode,
    offline: link.online ? null : STRINGS.offlineDetail(link.code),
    unreachable: state.keymap.notes.filter((note) => note.code === "prefix_unreachable" || note.code === "detach_unreachable").map((note) => note.code),
    hints: bar.hints.map((hint) => ({ keys: hint.keys.join("/"), label: actionLabel(hint.action) })),
    notice: latest && link.online ? ` ${latest.calm ? "" : `${STRINGS.errorBadge}: `}${STRINGS.noticeText(latest.code, latest.data)} ` : null,
  };
  return part("mode", rect, look, data, (canvas, { mode, offline, unreachable, hints, notice }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    canvas.fill(canvas.style({ fg: colors.text, bg: colors.bgPanel }));
    const row = rect.y;
    const right = rect.x + rect.width;
    // the notice takes the row's right end; what is left of it is fitted into the cells before it, never painted over
    const noticeWidth = notice === null ? 0 : Math.min(measure(notice).width, Math.floor(rect.width * 0.65));
    const end = right - noticeWidth;
    const badge = ` ${MODE_LABELS[mode]} `;
    const terminal = mode === "terminal";
    const badgeBg = mode === "prefix" ? colors.accent : mode === "locked" ? colors.statusBlocked : terminal ? colors.bgElevated : colors.statusWorking;
    let col = printFit(canvas, rect.x, row, badge, rect.width, canvas.style({ fg: terminal ? colors.textStrong : colors.primaryText, bg: badgeBg, flags: STYLE_BOLD }));
    if (offline !== null) col = printFit(canvas, col, row, ` ${offline} `, end - col, canvas.style({ fg: colors.notice, bg: colors.bgPanel, flags: STYLE_BOLD }), true);
    for (const code of unreachable) col = printFit(canvas, col, row, ` [${code}] `, end - col, canvas.style({ fg: colors.dangerText, bg: colors.bgPanel, flags: STYLE_BOLD }), true);
    const keyStyle = canvas.style({ fg: colors.accent, bg: colors.bgPanel, flags: STYLE_BOLD });
    const labelStyle = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
    // a hint is drawn whole or not at all, so the keys shown are never a cut-off key
    for (const hint of hints) {
      if (col + measure(` ${hint.keys} ${hint.label}`).width > end) break;
      col = printFit(canvas, col, row, ` ${hint.keys}`, end - col, keyStyle);
      col = printFit(canvas, col, row, ` ${hint.label}`, end - col, labelStyle);
    }
    if (notice !== null && noticeWidth > 0) {
      const style = canvas.style({ fg: colors.dangerText, bg: colors.bgElevated, flags: STYLE_BOLD });
      fillSpan(canvas, end, row, noticeWidth, style);
      printFit(canvas, end, row, notice, noticeWidth, style, true);
    }
  });
}

/** A dialog of `width` x `height` in the middle of the screen, never larger than it. */
function centred(screenWidth: number, screenHeight: number, width: number, height: number): Rect {
  const w = Math.max(1, Math.min(screenWidth, width));
  const h = Math.max(1, Math.min(screenHeight, height));
  return { x: Math.floor((screenWidth - w) / 2), y: Math.floor((screenHeight - h) / 2), width: w, height: h };
}

/** An overlay's frame: its box, its title, and its close keys at the top right; answers the cells inside. */
function overlayFrame(canvas: Canvas, rect: Rect, title: string, closeKeys: readonly string[], colors: Colors): Rect {
  canvas.fill(canvas.style({ fg: colors.text, bg: colors.bgElevated }));
  if (rect.width < 2 || rect.height < 2) return rect;
  box(canvas, rect, canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD }));
  const close = ` [${STRINGS.helpCloseLabel(closeKeys)}] `;
  const closeWidth = measure(close).width;
  const right = rect.x + rect.width - 1;
  printFit(canvas, rect.x + 1, rect.y, ` ${title} `, Math.max(0, rect.width - 2 - closeWidth), canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD }), true);
  const at = Math.max(rect.x + 1, right - closeWidth);
  printFit(canvas, at, rect.y, close, right - at, canvas.style({ fg: colors.accent, bg: colors.bgElevated }));
  canvas.hit({ x: at, y: rect.y, width: right - at, height: 1 }, "close");
  return { x: rect.x + 1, y: rect.y + 1, width: Math.max(0, rect.width - 2), height: Math.max(0, rect.height - 2) };
}

/** The part of a text field shown in `width` columns, scrolled so the cursor stays in view, and the cursor's column in it. */
function fieldView(field: Field, width: number): { text: string; cursor: number } {
  const before = measure(field.graphemes.slice(0, field.cursor).join("")).width;
  let skip = 0;
  let skipped = 0;
  while (skip < field.graphemes.length && before - skipped > width - 1) skipped += measure(field.graphemes[skip++]!).width;
  return { text: field.graphemes.slice(skip).join(""), cursor: before - skipped };
}

/** A dialog with one text field on its first row inside and a hint under it; the field's cell takes typing. */
function fieldOverlay(key: string, rect: Rect, title: string, hint: string, field: Field, closeKeys: readonly string[], colors: Colors): { overlay: Part; input: Scene["input"] } {
  const width = Math.max(1, rect.width - 4);
  const view = fieldView(field, width);
  const overlay: Part = {
    key, rect, version: 0,
    draw(canvas) {
      const inner = overlayFrame(canvas, rect, title, closeKeys, colors);
      if (inner.width <= 0 || inner.height <= 0) return;
      const style = canvas.style({ fg: colors.textStrong, bg: colors.bgInput, flags: field.fresh ? STYLE_INVERSE : 0 });
      fillSpan(canvas, inner.x + 1, inner.y, width, style);
      printFit(canvas, inner.x + 1, inner.y, view.text, width, style);
      if (inner.height >= 2) printFit(canvas, inner.x + 1, inner.y + 1, hint, Math.max(0, inner.width - 2), canvas.style({ fg: colors.textDim, bg: colors.bgElevated }), true);
    },
  };
  return { overlay, input: { col: rect.x + 2 + view.cursor, row: rect.y + 1 } };
}

function toastPart(width: number, height: number, state: ModelState, colors: Colors): Part | null {
  if (state.notices.length === 0 || width < 16 || height < 3) return null;
  const lines = state.notices.slice(-3).map((notice) => `${notice.calm ? STRINGS.glyphIdle : STRINGS.glyphBlocked} ${STRINGS.noticeText(notice.code, notice.data)}`);
  const toastWidth = Math.min(width, Math.max(20, Math.max(...lines.map((line) => measure(line).width)) + 4));
  const toastHeight = Math.min(height, lines.length + 2);
  const rect: Rect = { x: width - toastWidth, y: Math.min(1, height - toastHeight), width: toastWidth, height: toastHeight };
  return {
    key: "toast", rect, version: 0,
    draw(canvas) {
      const text = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated });
      canvas.fill(text);
      box(canvas, rect, canvas.style({ fg: colors.notice, bg: colors.bgElevated, flags: STYLE_BOLD }));
      lines.forEach((line, at) => {
        if (rect.y + 1 + at < rect.y + rect.height - 1) printFit(canvas, rect.x + 2, rect.y + 1 + at, line, Math.max(0, rect.width - 4), text, true);
      });
    },
  };
}

function helpPart(width: number, height: number, state: ModelState, world: CoreView, colors: Colors): Part {
  const rect = centred(width, height, Math.max(44, width - 8), Math.max(12, height - 4));
  const refusals = shownRefusals(state.keymap);
  const notes = state.keymap.notes.map((note) => ({ text: noteText(note), unreachable: note.code === "prefix_unreachable" || note.code === "detach_unreachable" }));
  const rows = helpRows(state.keymap).map((row) => ({
    keys: row.keys.length > 0 ? row.keys.join(", ") : null,
    text: `${actionLabel(row.action)}${row.status === "parity" ? ` (${STRINGS.helpParityPrefix})` : row.mode !== "terminal" ? ` [${row.mode}]` : ""}`,
    parity: row.status === "parity",
  }));
  return {
    key: "overlay:help", rect, version: 0,
    draw(canvas) {
      const inner = overlayFrame(canvas, rect, STRINGS.helpTitle, OVERLAYS.help.closeKeys, colors);
      if (inner.width <= 0 || inner.height <= 0) return;
      const bottom = inner.y + inner.height;
      const room = Math.max(0, inner.width - 2);
      const warn = canvas.style({ fg: colors.dangerText, bg: colors.bgElevated, flags: STYLE_BOLD });
      const note = canvas.style({ fg: colors.notice, bg: colors.bgElevated });
      const dim = canvas.style({ fg: colors.textDim, bg: colors.bgElevated });
      let r = inner.y;
      if (!world.ownsLayout && r < bottom) printFit(canvas, inner.x + 1, r++, STRINGS.appOwnedCore, room, note, true);
      for (const line of notes) if (r < bottom) printFit(canvas, inner.x + 1, r++, line.text, room, line.unreachable ? warn : note, true);
      if (refusals.shown.length > 0 && r < bottom) {
        printFit(canvas, inner.x + 1, r++, STRINGS.helpRefusalsTitle, room, warn, true);
        for (const refusal of refusals.shown) if (r < bottom) printFit(canvas, inner.x + 1, r++, STRINGS.refusalLine(refusal.code, refusal.action, refusal.binding, refusal.holder), room, note, true);
        if (refusals.more > 0 && r < bottom) printFit(canvas, inner.x + 1, r++, STRINGS.helpMoreRefusals(refusals.more), room, dim, true);
      }
      const space = bottom - r;
      if (space <= 0) return;
      const two = inner.width >= 76 && rows.length > space;
      const columnWidth = two ? Math.floor((inner.width - 3) / 2) : Math.max(1, inner.width - 2);
      const keyWidth = Math.min(18, Math.max(8, Math.floor(columnWidth * 0.42)));
      const keyStyle = canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD });
      const textStyle = canvas.style({ fg: colors.text, bg: colors.bgElevated });
      rows.forEach((row, at) => {
        const column = two ? Math.floor(at / space) : 0;
        const y = r + (two ? at % space : at);
        if (column > 1 || y >= bottom) return;
        const x = inner.x + 1 + column * (columnWidth + 1);
        printFit(canvas, x, y, row.keys ?? STRINGS.helpUnset, keyWidth, row.keys === null ? dim : keyStyle, true);
        printFit(canvas, x + keyWidth + 1, y, row.text, Math.max(0, x + columnWidth - (x + keyWidth + 1)), row.parity ? dim : textStyle, true);
      });
    },
  };
}

/** The overlays of one frame: the notice toast in the top right corner, and the overlay on top of the stack. */
function buildOverlays(width: number, height: number, state: ModelState, world: CoreView, colors: Colors): { overlays: Part[]; input: Scene["input"] } {
  const toast = toastPart(width, height, state, colors);
  const overlays: Part[] = toast ? [toast] : [];
  const top: Overlay | undefined = state.overlays.at(-1);
  if (!top) return { overlays, input: null };
  const closeKeys = OVERLAYS[top.kind].closeKeys;
  switch (top.kind) {
    case "help":
      return { overlays: [...overlays, helpPart(width, height, state, world, colors)], input: "overlay" };
    case "text": {
      const title = top.purpose === "rename_workspace" ? STRINGS.textRenameWorkspace
        : top.purpose === "rename_tab" ? STRINGS.textRenameTab
          : top.purpose === "rename_pane" ? STRINGS.textRenamePane
            : STRINGS.textNewTab;
      const field = fieldOverlay("overlay:text", centred(width, height, 52, 5), title, STRINGS.textPromptHint, top.field, closeKeys, colors);
      return { overlays: [...overlays, field.overlay], input: field.input };
    }
    case "confirm": {
      const rect = centred(width, height, 54, 5);
      const name = state.world.workspaces.find((workspace) => workspace.id === top.target.id)?.name || top.target.id;
      const confirm: Part = {
        key: "overlay:confirm", rect, version: 0,
        draw(canvas) {
          const inner = overlayFrame(canvas, rect, STRINGS.confirmCloseTitle, closeKeys, colors);
          if (inner.width > 0 && inner.height > 0) printFit(canvas, inner.x + 1, inner.y, STRINGS.confirmCloseWorkspace(name), Math.max(0, inner.width - 2), canvas.style({ fg: colors.dangerText, bg: colors.bgElevated, flags: STYLE_BOLD }), true);
        },
      };
      return { overlays: [...overlays, confirm], input: "overlay" };
    }
    case "goto": {
      const field = fieldOverlay("overlay:goto", centred(width, height, 64, 14), STRINGS.gotoTitle, STRINGS.gotoPromptHint, top.field, closeKeys, colors);
      return { overlays: [...overlays, field.overlay], input: field.input };
    }
    case "menu":
      return { overlays: [...overlays, menuPart(width, height, top, state, world, colors)], input: "overlay" };
  }
}

/** One menu entry as drawn: its key (blank for none), what it is, and its state mark for a place that has one. */
function menuLine(entry: MenuEntry, state: ModelState, world: CoreView): { label: string; text: string; status: KnownStatus | null; keys: string } {
  const label = entry.label ?? " ";
  if (entry.kind === "action") return { label, text: actionLabel(entry.action), status: null, keys: keyText(state, entry.action) ?? "" };
  const kind = STRINGS.menuPlaces[entry.kind];
  if (entry.kind === "workspace") {
    const row = world.workspaceGroups.flatMap((group) => [group, ...group.children]).find((one) => one.id === entry.id);
    return { label, text: `${kind} ${row ? `${row.number}:${row.name}` : entry.id}`, status: row?.status ?? null, keys: "" };
  }
  if (entry.kind === "tab") {
    const tabs = state.world.workspaces.flatMap((workspace) => workspace.tabs.map((tab, at) => ({ tab, number: at + 1 })));
    const found = tabs.find(({ tab }) => tab.id === entry.id);
    return { label, text: `${kind} ${found ? `${found.number}:${found.tab.name || found.number}` : entry.id}`, status: knownStatus(world.tabStatuses.get(entry.id)), keys: "" };
  }
  const pane = world.panes.get(entry.id);
  const agent = entry.kind === "agent" ? world.agents.find((row) => row.paneId === entry.id) : undefined;
  const name = agent?.name || pane?.label || pane?.title || entry.id;
  const folder = pane?.folder && pane.folder !== name ? ` ${pane.folder}` : "";
  return { label, text: `${kind} ${name}${folder}`, status: pane ? knownStatus(pane.status) : null, keys: "" };
}

/** The menu: a window of its entries around the cursor, each a click target that chooses it. */
function menuPart(width: number, height: number, menu: Extract<Overlay, { kind: "menu" }>, state: ModelState, world: CoreView, colors: Colors): Part {
  const rect = centred(width, height, 56, menu.entries.length + 2);
  const lines = menu.entries.map((entry) => menuLine(entry, state, world));
  return {
    key: "overlay:menu", rect, version: 0,
    draw(canvas) {
      const inner = overlayFrame(canvas, rect, STRINGS.menuTitle, OVERLAYS.menu.closeKeys, colors);
      if (inner.width <= 0 || inner.height <= 0) return;
      const start = windowStart(lines.length, inner.height, menu.cursor);
      lines.slice(start, start + inner.height).forEach((line, at) => {
        const index = start + at;
        const y = inner.y + at;
        const chosen = index === menu.cursor;
        const bg = chosen ? colors.bgHover : colors.bgElevated;
        const text = canvas.style({ fg: chosen ? colors.textStrong : colors.text, bg, flags: chosen ? STYLE_BOLD : 0 });
        fillSpan(canvas, inner.x, y, inner.width, text);
        const end = inner.x + inner.width;
        let col = printFit(canvas, inner.x, y, chosen ? ">" : " ", 1, canvas.style({ fg: colors.accent, bg, flags: STYLE_BOLD }));
        col = printFit(canvas, col, y, `${line.label} `, end - col, canvas.style({ fg: colors.accent, bg, flags: STYLE_BOLD }));
        if (line.status !== null) {
          const look = STATE_LOOK[line.status];
          col = printFit(canvas, col, y, `${look.glyph} `, end - col, canvas.style({ fg: colors[look.role], bg, flags: STYLE_BOLD }));
        }
        const keys = line.keys === "" ? "" : ` ${line.keys}`;
        const keysWidth = measure(keys).width;
        const room = end - col > keysWidth + 8 ? end - col - keysWidth : end - col;
        col = printFit(canvas, col, y, line.text, room, text, true);
        if (keys && end - col >= keysWidth) printFit(canvas, end - keysWidth, y, keys, keysWidth, canvas.style({ fg: colors.textDim, bg }));
        // the entry's key, not its index: a world update before the next paint shifts the indices under the click
        canvas.hit({ x: inner.x, y, width: inner.width, height: 1 }, `menu:${entryKey(menu.entries[index]!)}`);
      });
    },
  };
}

/** Every chrome part and overlay of one frame pass. */
export function buildChrome(input: ChromeInput): BuiltChrome {
  const theme = input.theme ?? "dark";
  const depth = input.colors ?? "truecolor";
  const colors = themeColors(theme, depth);
  const look = `${theme}/${depth}`;
  const parts = [sidebarPart(input, colors, look), tabBarPart(input, colors, look), bordersPart(input, colors, look), modeBarPart(input, colors, look)];
  const { overlays, input: sceneInput } = buildOverlays(input.regions.screen.width, input.regions.screen.height, input.state, input.world, colors);
  return { parts, overlays, input: sceneInput };
}
