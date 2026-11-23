import type { TabShape } from "../core/world.ts";
import { clipTop, type Size } from "../core/size.ts";
import { cellsOf, type PaneCells, type Rect, regions, type Regions, type SplitCells } from "./geometry.ts";
import type { PaneGrid } from "./grid.ts";
import type { PaneScene } from "./paint.ts";

/** The sidebar's width in columns while it shows, its separator included. */
export const SIDEBAR_COLUMNS = 26;
/** The collapsed sidebar's rail: a number, a state mark and the separator. */
export const RAIL_COLUMNS = 4;

/** A pane of the shown tab: its cells, and whether a zoom covers it (then it is attached, silent and not drawn). */
export interface PaneSpot { pane: string; cells: PaneCells; covered: boolean }

export interface ScreenShape { regions: Regions; spots: PaneSpot[]; splits: SplitCells[] }

/**
 * Where the shown tab's panes go on a screen of `width` x `height`: the regions, and each pane's cells cut from the panes'
 * region by the tab's tree. A zoomed tab gives its zoomed pane the whole region and keeps the others at their cells,
 * covered. Panes have borders only while the tab is split (a zoomed pane of a split tab keeps its border), and each keeps
 * a gutter column for its scrollbar unless `gutter` says no (a program on the alternate screen has none). No tab: no
 * panes. A narrow screen lays the panes out the same way, under its header (herdr's narrow layout changes the chrome only).
 */
export function layOut(width: number, height: number, tab: TabShape | null, options: { sidebarCollapsed: boolean; gutter?: (pane: string) => boolean }): ScreenShape {
  const shape = regions(width, height, { sidebar: options.sidebarCollapsed ? RAIL_COLUMNS : SIDEBAR_COLUMNS });
  if (!tab) return { regions: shape, spots: [], splits: [] };
  const gutter = options.gutter ?? (() => true);
  const leaves = cellsOf(tab.root, shape.panes, { borders: false }).panes.map((cells) => cells.pane);
  const look = { borders: leaves.length > 1, gutter };
  const cut = cellsOf(tab.root, shape.panes, look);
  const all = cut.panes;
  const zoomed = tab.zoomed !== null && all.some(({ pane }) => pane === tab.zoomed) ? tab.zoomed : null;
  if (zoomed === null) return { regions: shape, spots: all.map((cells) => ({ pane: cells.pane, cells, covered: false })), splits: cut.splits };
  const alone = cellsOf({ leaf: zoomed }, shape.panes, look).panes[0]!;
  return { regions: shape, spots: all.map((cells) => cells.pane === zoomed ? { pane: zoomed, cells: alone, covered: false } : { pane: cells.pane, cells, covered: true }), splits: [] };
}

/**
 * A pane as the frame draws it: its terminal's grid in its inner cells. A terminal taller than its cells (sized by
 * another viewer) is drawn from the row size.ts `clipTop` names, so the cursor's part shows.
 */
export function paneScene(spot: PaneSpot, grid: PaneGrid, actual: Size, state: { live: boolean; hold: boolean; dim?: boolean }): PaneScene {
  const rect: Rect = spot.cells.inner;
  const row = actual.rows > rect.height ? clipTop(grid.cursor?.y ?? grid.lastSeen?.y ?? 0, actual.rows, rect.height) : 0;
  return { id: spot.pane, rect, grid, view: { col: 0, row }, live: state.live, hold: state.hold, scrolledBack: false, ...(state.dim ? { dim: true } : {}) };
}
