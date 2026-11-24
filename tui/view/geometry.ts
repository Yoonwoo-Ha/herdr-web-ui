import { place, type LayoutNode, type SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { NARROW_COLUMNS } from "../model/screen-size.ts";

/** A rectangle of screen cells; x and y count from the screen's top-left cell, 0-based. */
export interface Rect { x: number; y: number; width: number; height: number }

export const NO_CELLS: Rect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : NO_CELLS;
}

export const holds = (rect: Rect, col: number, row: number): boolean =>
  col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height;

/** What the chrome asks for: the sidebar's width in columns, separator included (a collapsed sidebar's rail is narrower). */
export interface ChromeShape { sidebar: number }

/** The narrow screen's header: two rows over the whole width, in place of the sidebar and the tab bar, as herdr's. */
export const NARROW_HEADER_ROWS = 2;

/**
 * Where each part of the screen goes. The panes always keep at least one cell while the screen has one: a part of the chrome
 * that would take the last row or column from them is left out (its rectangle is empty).
 */
export interface Regions {
  screen: Rect;
  narrow: boolean;
  /** the left column of workspaces and agents, the whole height; none on a narrow screen */
  sidebar: Rect;
  /** one row above the panes, right of the sidebar; on a narrow screen the header over the whole width */
  tabBar: Rect;
  panes: Rect;
  /** the panes' last row: the mode bar is drawn over it outside terminal mode, and nothing is reserved for it */
  modeBar: Rect;
}

export function regions(width: number, height: number, chrome: ChromeShape): Regions {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const narrow = w <= NARROW_COLUMNS;
  const tabRows = narrow ? Math.max(0, Math.min(NARROW_HEADER_ROWS, h - 1)) : h >= 2 ? 1 : 0;
  const side = narrow ? 0 : Math.max(0, Math.min(Math.floor(chrome.sidebar), w - 1));
  const panes = w - side > 0 && h - tabRows > 0 ? { x: side, y: tabRows, width: w - side, height: h - tabRows } : NO_CELLS;
  return {
    screen: { x: 0, y: 0, width: w, height: h },
    narrow,
    sidebar: side > 0 && h > 0 ? { x: 0, y: 0, width: side, height: h } : NO_CELLS,
    tabBar: tabRows > 0 && w - side > 0 ? { x: side, y: 0, width: w - side, height: tabRows } : NO_CELLS,
    panes,
    modeBar: panes.height > 0 ? { x: panes.x, y: panes.y + panes.height - 1, width: panes.width, height: 1 } : NO_CELLS,
  };
}

/**
 * One pane's cells: `outer` is its share of the area, `inner` what its terminal shows in (inside the border, or the whole
 * share when it is too small for one, less the gutter), `gutter` the column kept at the right of the inside for its
 * scrollbar (none in a pane of four columns or fewer inside, or when the caller asks for none). `cols` and `rows` are the
 * size the terminal is asked for: at least 1x1 even when the share has no cell on screen, as an emulator is never smaller.
 */
export interface PaneCells { pane: string; outer: Rect; inner: Rect; gutter: Rect; cols: number; rows: number }

/** A pane inside of at most this many columns keeps no scrollbar gutter. */
const GUTTERLESS = 4;

/** `inside` split into the terminal's cells and the gutter column at its right. */
function withGutter(inside: Rect, gutter: boolean): { inner: Rect; gutter: Rect } {
  if (!gutter || inside.width <= GUTTERLESS) return { inner: inside, gutter: NO_CELLS };
  return { inner: { ...inside, width: inside.width - 1 }, gutter: { x: inside.x + inside.width - 1, y: inside.y, width: 1, height: inside.height } };
}
/**
 * One split's cells: `rect` is the whole split, `divider` the seam between its two sides: the last line of cells of its
 * first side and the first line of its second, across the split. Where an enclosing split's divider already runs, the
 * cells are that one's, so no cell belongs to two dividers.
 */
export interface SplitCells { id: string; direction: SplitDirection; rect: Rect; divider: Rect }

/** The smallest share that has room for a border around one cell. */
const BORDERED = 3;

/**
 * A tab's tree cut into `area`'s cells by the layout document's own `place()` (each split's first side gets its ratio of the
 * extent, at least one cell to every pane while the area has room). A tree with more panes than the area has cells along an
 * axis leaves the last ones without cells on screen.
 */
export function cellsOf(tree: LayoutNode | null, area: Rect, options: { borders: boolean; gutter?: (pane: string) => boolean } = { borders: true }): { panes: PaneCells[]; splits: SplitCells[] } {
  if (!tree) return { panes: [], splits: [] };
  const placed = place(tree, area);
  const panes = placed.panes.filter(({ pane_id }) => pane_id !== "").map(({ pane_id, rect }): PaneCells => {
    const outer = intersect(rect, area);
    const bordered = options.borders && outer.width >= BORDERED && outer.height >= BORDERED;
    const inside = bordered ? { x: outer.x + 1, y: outer.y + 1, width: outer.width - 2, height: outer.height - 2 } : outer;
    const { inner, gutter } = withGutter(inside, options.gutter?.(pane_id) ?? false);
    return { pane: pane_id, outer, inner, gutter, cols: Math.max(1, inner.width), rows: Math.max(1, inner.height) };
  });
  const splits: SplitCells[] = [];
  let leaf = 0;
  // place() lists splits and leaves in the order this walk meets them
  const walk = (node: LayoutNode): Rect => {
    if ("leaf" in node) return intersect(placed.panes[leaf++]!.rect, area);
    const at = splits.length;
    const { id, direction, rect } = placed.splits[at]!;
    const split: SplitCells = { id, direction: direction as SplitDirection, rect: intersect(rect, area), divider: NO_CELLS };
    splits.push(split);
    const first = walk(node.first);
    const second = walk(node.second);
    split.divider = seam(split, first, second);
    // the splits inside its sides were walked first: they give up the cells this divider takes
    for (const inner of splits.slice(at + 1)) inner.divider = outside(inner.divider, split.divider);
    return split.rect;
  };
  walk(tree);
  return { panes, splits };
}

/** The seam between a split's two sides: the first side's last line of cells and the second side's first. */
function seam(split: SplitCells, first: Rect, second: Rect): Rect {
  if (first.width === 0 || second.width === 0 || first.height === 0 || second.height === 0) return NO_CELLS;
  const band = split.direction === "down"
    ? { x: split.rect.x, y: first.y + first.height - 1, width: split.rect.width, height: second.y - (first.y + first.height - 1) + 1 }
    : { x: first.x + first.width - 1, y: split.rect.y, width: second.x - (first.x + first.width - 1) + 1, height: split.rect.height };
  return intersect(band, split.rect);
}

/**
 * `rect` without the cells of `taken`. An enclosing divider runs across a nested one's whole width or height and lies at
 * its end, so what is left is one rectangle; the larger side is kept should both be left.
 */
function outside(rect: Rect, taken: Rect): Rect {
  const cut = intersect(rect, taken);
  if (cut.width === 0) return rect;
  const pieces: Rect[] = cut.width === rect.width
    ? [{ ...rect, height: cut.y - rect.y }, { ...rect, y: cut.y + cut.height, height: rect.y + rect.height - (cut.y + cut.height) }]
    : cut.height === rect.height
      ? [{ ...rect, width: cut.x - rect.x }, { ...rect, x: cut.x + cut.width, width: rect.x + rect.width - (cut.x + cut.width) }]
      : [rect];
  const kept = pieces.filter((piece) => piece.width > 0 && piece.height > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return kept ?? NO_CELLS;
}
