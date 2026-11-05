/**
 * Two panes side by side on a desktop, as a window snapped to half the screen: a tab, a sidebar or
 * Agents row, or a pane's title dragged to the left or right half of the pane area opens its pane
 * there, beside the one already open (a title over its own tab's panes arranges that tab instead:
 * useSplitLayout). The selected pane (App's) is the active half's; the other half
 * keeps its own. The halves are independent: both may show the same tab (the other half draws it on a
 * connection of its own), and a pick from the sidebar changes the active half alone.
 *
 * The halves are two slots, `a` and `b`, that keep their panes when the active one changes or the
 * halves trade sides, so neither terminal attaches again for a click. A single pane is shown in
 * one of them (App's solo slot, `a` at first); split, `b` is on `bSide` and `a` on the other side.
 * The half left when a split ends stays in its slot, so its terminal keeps its connection.
 */
import type { PaneDirection } from "../../shared/protocol.ts";

export type SplitSide = "left" | "right";
export type SplitSlot = "a" | "b";

export interface SplitTarget {
  machineId: string;
  paneId: string;
}

export interface SplitState {
  /** the pane of the half that is not active */
  other: SplitTarget;
  /** the side slot `b` is on */
  bSide: SplitSide;
  /** the slot of the selected pane */
  active: SplitSlot;
}

/** what a dragged tab or sidebar row carries: the pane it opens, and the PC it is on */
export const PANE_DRAG_TYPE = "application/x-herdr-pane";

const STORAGE_KEY = "ovis:split";

export function otherSide(side: SplitSide): SplitSide {
  return side === "left" ? "right" : "left";
}

export function otherSlot(slot: SplitSlot): SplitSlot {
  return slot === "a" ? "b" : "a";
}

export function sameTarget(a: SplitTarget | null, b: SplitTarget | null): boolean {
  return a !== null && b !== null && a.machineId === b.machineId && a.paneId === b.paneId;
}

/** The side a slot is drawn on. */
export function slotSide(state: SplitState, slot: SplitSlot): SplitSide {
  return slot === "b" ? state.bSide : otherSide(state.bSide);
}

/** Keep the preview's side near the midpoint; a first entry uses the exact half. */
export function dropSide(x: number, left: number, width: number, previous: SplitSide | null = null): SplitSide {
  const middle = left + width / 2;
  const margin = Math.min(12, width / 4);
  if (previous === "left" && x <= middle + margin) return "left";
  if (previous === "right" && x >= middle - margin) return "right";
  return x < middle ? "left" : "right";
}

/** The amount another side's share must be nearer before it replaces the side shown. */
const BESIDE_MARGIN = 0.05;

/**
 * The side of a pane a pane dropped at the pointer goes to (herdr's pane.move within the tab): the
 * nearest edge, its distance counted as a share of the pane's width or height so each side takes a
 * quarter of a pane of any shape. Where shares meet, the side shown stays, as a half does near the middle.
 */
export function besideSide(x: number, y: number, box: { left: number; top: number; width: number; height: number }, previous: PaneDirection | null = null): PaneDirection {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const shares: Record<PaneDirection, number> = {
    left: (x - box.left) / width, right: (box.left + width - x) / width,
    up: (y - box.top) / height, down: (box.top + height - y) / height,
  };
  const nearest = (["left", "right", "up", "down"] as const).reduce((best, side) => (shares[side] < shares[best] ? side : best));
  return previous !== null && shares[previous] - shares[nearest] < BESIDE_MARGIN ? previous : nearest;
}

/**
 * A pane dropped on one half: the split after it, and the pane to select (the dropped one, which
 * becomes the active half). Null when nothing changes: a pane dropped onto the active half that
 * already shows it. Nothing trades sides: the half under the drop shows the pane, the other half
 * keeps what it shows, and a pane may be shown in both.
 * - Single pane: it stays in its slot (`solo`), on the other side, and the dropped pane opens beside it.
 * - Onto the active half: the dropped pane opens there.
 * - Onto the other half: the dropped pane opens there and that half becomes active.
 */
export function dockPane(
  state: SplitState | null,
  active: SplitTarget | null,
  dragged: SplitTarget,
  side: SplitSide,
  solo: SplitSlot = "a",
): { split: SplitState; select: SplitTarget } | null {
  if (active === null) return null;
  if (state === null) {
    const opened = otherSlot(solo);
    return { split: { other: active, bSide: opened === "b" ? side : otherSide(side), active: opened }, select: dragged };
  }
  const slot: SplitSlot = side === state.bSide ? "b" : "a";
  if (slot === state.active) return sameTarget(dragged, active) ? null : { split: state, select: dragged };
  return { split: { other: active, bSide: state.bSide, active: slot }, select: dragged };
}

/** The other half made active: a click in it. */
export function activateOther(state: SplitState, active: SplitTarget): { split: SplitState; select: SplitTarget } {
  return { split: { other: active, bSide: state.bSide, active: otherSlot(state.active) }, select: state.other };
}

/** A pane dragged in, if the drag carries one. */
export function draggedPane(data: string): SplitTarget | null {
  try {
    const value = JSON.parse(data) as { machine_id?: unknown; pane_id?: unknown };
    return typeof value.machine_id === "string" && typeof value.pane_id === "string" ? { machineId: value.machine_id, paneId: value.pane_id } : null;
  } catch {
    return null;
  }
}

export function paneDragData(target: SplitTarget): string {
  return JSON.stringify({ machine_id: target.machineId, pane_id: target.paneId });
}

/** The split this device left, if any: a reload opens it again while both panes are still there. */
export function storedSplit(): SplitState | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as Partial<SplitState> | null;
    const other = value?.other;
    if (!value || !other || typeof other.machineId !== "string" || typeof other.paneId !== "string") return null;
    if (value.bSide !== "left" && value.bSide !== "right") return null;
    if (value.active !== "a" && value.active !== "b") return null;
    return { other: { machineId: other.machineId, paneId: other.paneId }, bSide: value.bSide, active: value.active };
  } catch {
    return null;
  }
}

export function storeSplit(state: SplitState | null): void {
  try {
    if (state === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode: the split just is not kept across a reload */
  }
}
