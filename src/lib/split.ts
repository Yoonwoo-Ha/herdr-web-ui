/**
 * Two panes side by side on a desktop, as a window snapped to half the screen: a tab or a
 * sidebar row dragged to the left or right half of the pane area opens its pane there, beside the
 * one already open. The selected pane (App's) is the active half's; the other half keeps its own.
 *
 * The halves are two slots, `a` and `b`, that keep their panes when the active one changes or the
 * halves trade sides, so neither terminal attaches again for a click. Slot `a` is the one a single
 * pane is shown in; `b` exists only while split, on `bSide`, and `a` takes the other side.
 */

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

const STORAGE_KEY = "herdr-web-ui:split";

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

/** The half of the pane area a point is over. */
export function dropSide(x: number, left: number, width: number): SplitSide {
  return x < left + width / 2 ? "left" : "right";
}

/**
 * A pane dropped on one half: the split after it, and the pane to select (the dropped one, which
 * becomes the active half). Null when nothing changes: a pane dropped where it already is, or
 * onto a single pane that is itself.
 * - Single pane: it stays in its slot, on the other side, and the dropped pane opens beside it.
 * - Onto the active half: the dropped pane opens there. The other half's own pane, dropped there,
 *   trades sides with it.
 * - Onto the other half: the dropped pane opens there and that half becomes active. The active
 *   pane dropped there trades sides with the other.
 */
export function dockPane(
  state: SplitState | null,
  active: SplitTarget | null,
  dragged: SplitTarget,
  side: SplitSide,
): { split: SplitState; select: SplitTarget } | null {
  if (active === null) return null;
  if (state === null) {
    if (sameTarget(dragged, active)) return null;
    return { split: { other: active, bSide: side, active: "b" }, select: dragged };
  }
  const slot: SplitSlot = side === state.bSide ? "b" : "a";
  if (slot === state.active) {
    if (sameTarget(dragged, active)) return null;
    if (sameTarget(dragged, state.other)) {
      return { split: { other: active, bSide: otherSide(state.bSide), active: otherSlot(state.active) }, select: dragged };
    }
    return { split: state, select: dragged };
  }
  if (sameTarget(dragged, active)) return { split: { ...state, bSide: otherSide(state.bSide) }, select: active };
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
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<SplitState> | null;
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
    if (state === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode: the split just is not kept across a reload */
  }
}
