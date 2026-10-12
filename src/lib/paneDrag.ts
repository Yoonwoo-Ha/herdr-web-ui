import type { SplitTarget } from "./split.ts";

/**
 * A tab dragged out of its strip (useTabReorder): the strip holds the pointer, so the pane area
 * never sees the drag. The strip reports it here and App draws the split guide from it, as it
 * does for a sidebar row's native drag (lib/split.ts).
 */
export interface PaneDrag {
  target: SplitTarget;
  /** where the pointer is, once it has left the strip; null while it is still over the strip */
  point: { x: number; y: number } | null;
}

let current: PaneDrag | null = null;
const listeners = new Set<() => void>();
let dropHandler: ((target: SplitTarget, x: number, y: number) => void) | null = null;

const set = (next: PaneDrag | null): void => {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
};

export const paneDrag = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): PaneDrag | null => current,
  start(target: SplitTarget): void {
    set({ target, point: null });
  },
  move(x: number, y: number): void {
    if (current) set({ target: current.target, point: { x, y } });
  },
  /** over the strip again: no half is the target */
  back(): void {
    if (current?.point) set({ target: current.target, point: null });
  },
  drop(x: number, y: number): void {
    const held = current;
    set(null);
    if (held) dropHandler?.(held.target, x, y);
  },
  cancel(): void {
    set(null);
  },
  /** App's: what a drop does */
  onDrop(handler: ((target: SplitTarget, x: number, y: number) => void) | null): void {
    dropHandler = handler;
  },
};
