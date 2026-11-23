import type { TabShape } from "../core/world.ts";
import { clipTop, type Size } from "../core/size.ts";
import { cellsOf, type PaneCells, type Rect, regions, type Regions, type SplitCells } from "./geometry.ts";
import type { PaneGrid } from "./grid.ts";
import type { PaneScene } from "./paint.ts";

/** The sidebar's width in columns while it shows. */
export const SIDEBAR_COLUMNS = 24;

/** A pane of the shown tab: its cells, and whether a zoom covers it (then it is attached, silent and not drawn). */
export interface PaneSpot { pane: string; cells: PaneCells; covered: boolean }

export interface ScreenShape { regions: Regions; spots: PaneSpot[]; splits: SplitCells[] }

/**
 * Where the shown tab's panes go on a screen of `width` x `height`: the regions, and each pane's cells cut from the panes'
 * region by the tab's tree. A zoomed tab gives its zoomed pane the whole region and keeps the others at their cells,
 * covered. No tab: no panes. A narrow screen shows the tab's pane `pane` alone in the whole region (its first when that
 * one is not in it) and none of the others: they are not attached. That one-pane view is the screen's own and changes
 * nothing in the tab's layout.
 */
export function layOut(width: number, height: number, tab: TabShape | null, options: { sidebarCollapsed: boolean; pane: string | null }): ScreenShape {
  const shape = regions(width, height, { sidebar: options.sidebarCollapsed ? 0 : SIDEBAR_COLUMNS, tabBar: true, modeBar: true });
  if (!tab) return { regions: shape, spots: [], splits: [] };
  if (shape.narrow) {
    const leaves = cellsOf(tab.root, shape.panes).panes.map((cells) => cells.pane);
    const shown = options.pane !== null && leaves.includes(options.pane) ? options.pane : leaves[0];
    return { regions: shape, spots: shown === undefined ? [] : [{ pane: shown, cells: cellsOf({ leaf: shown }, shape.panes).panes[0]!, covered: false }], splits: [] };
  }
  const cut = cellsOf(tab.root, shape.panes);
  const all = cut.panes;
  const zoomed = tab.zoomed !== null && all.some(({ pane }) => pane === tab.zoomed) ? tab.zoomed : null;
  if (zoomed === null) return { regions: shape, spots: all.map((cells) => ({ pane: cells.pane, cells, covered: false })), splits: cut.splits };
  const alone = cellsOf({ leaf: zoomed }, shape.panes).panes[0]!;
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
