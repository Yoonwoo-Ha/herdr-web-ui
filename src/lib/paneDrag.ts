import type { SplitTarget } from "./split.ts";

export interface WorkspaceDropTarget {
  machineId: string;
  workspaceId: string;
}

export interface TabWorkspaceMove {
  targets: ReadonlySet<string> | (() => ReadonlySet<string>);
  move: (workspaceId: string) => void;
}

export type ElementAtPoint = (x: number, y: number) => Element | null;

const defaultElementAt: ElementAtPoint = (x, y) =>
  typeof document === "undefined" || typeof document.elementFromPoint !== "function" ? null : document.elementFromPoint(x, y);

/**
 * Resolves a valid sidebar workspace row on `machineId` under `(x, y)` while dragging a single-pane
 * tab out of its strip, ignoring offline or inert containers and non-target rows.
 */
export function workspaceDropAt(
  x: number,
  y: number,
  machineId: string,
  targets: ReadonlySet<string>,
  elementAt: ElementAtPoint = defaultElementAt,
): WorkspaceDropTarget | null {
  if (targets.size === 0) return null;
  const hit = elementAt(x, y);
  const header = hit?.closest<HTMLElement>(".workspace-header") ?? null;
  if (!header || header.closest(".machine-offline, [inert], [hidden]") !== null) return null;
  const group = header.closest<HTMLElement>(".workspace-group[data-workspace]");
  const workspaceId = group?.dataset["workspace"];
  const machine = group?.closest<HTMLElement>(".machine-workspaces[data-machine]")?.dataset["machine"];
  if (!workspaceId || machine !== machineId || !targets.has(workspaceId)) return null;
  return { machineId, workspaceId };
}

/**
 * A tab dragged out of its strip (useTabReorder): the strip holds the pointer, so the pane area
 * never sees the drag.
 */
export interface PaneDrag {
  target: SplitTarget;
  point: { x: number; y: number } | null;
  workspaceTarget?: WorkspaceDropTarget;
}

let current: PaneDrag | null = null;
const listeners = new Set<() => void>();
let dropHandler: ((target: SplitTarget, x: number, y: number) => void) | null = null;
let workspaceMove: TabWorkspaceMove | null = null;
let scrollCleanup: (() => void) | null = null;

const set = (next: PaneDrag | null): void => {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
};

const attachScroll = (): void => {
  if (scrollCleanup || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  const onScroll = (): void => { paneDrag.refresh(); };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  scrollCleanup = () => { document.removeEventListener("scroll", onScroll, { capture: true }); };
};

const detachScroll = (): void => {
  scrollCleanup?.();
  scrollCleanup = null;
};

const workspaceTargets = (move: TabWorkspaceMove | null): ReadonlySet<string> | null =>
  move === null ? null : typeof move.targets === "function" ? move.targets() : move.targets;

const workspaceTargetAt = (
  x: number,
  y: number,
  machineId: string,
  move: TabWorkspaceMove | null,
  prior?: WorkspaceDropTarget,
): WorkspaceDropTarget | undefined => {
  const targets = workspaceTargets(move);
  const hit = targets ? workspaceDropAt(x, y, machineId, targets) : null;
  if (hit === null) return undefined;
  return prior?.machineId === hit.machineId && prior.workspaceId === hit.workspaceId ? prior : hit;
};

export const paneDrag = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): PaneDrag | null => current,
  start(target: SplitTarget, moveToWorkspace?: TabWorkspaceMove): void {
    workspaceMove = moveToWorkspace ?? null;
    if (workspaceMove) attachScroll(); else detachScroll();
    set({ target, point: null });
  },
  move(x: number, y: number): void {
    if (!current) return;
    const workspaceTarget = workspaceTargetAt(x, y, current.target.machineId, workspaceMove, current.workspaceTarget);
    set(workspaceTarget === undefined ? { target: current.target, point: { x, y } } : { target: current.target, point: { x, y }, workspaceTarget });
  },
  refresh(): void {
    if (!current?.point) return;
    const workspaceTarget = workspaceTargetAt(current.point.x, current.point.y, current.target.machineId, workspaceMove, current.workspaceTarget);
    if (workspaceTarget === current.workspaceTarget) return;
    set(workspaceTarget === undefined
      ? { target: current.target, point: current.point }
      : { target: current.target, point: current.point, workspaceTarget });
  },
  back(): void {
    if (current?.point || current?.workspaceTarget) set({ target: current.target, point: null });
  },
  drop(x: number, y: number): void {
    const held = current;
    const heldMove = workspaceMove;
    const hit = held ? workspaceTargetAt(x, y, held.target.machineId, heldMove) : undefined;
    workspaceMove = null;
    detachScroll();
    set(null);
    if (hit !== undefined) {
      heldMove?.move(hit.workspaceId);
      return;
    }
    if (held) dropHandler?.(held.target, x, y);
  },
  cancel(): void {
    workspaceMove = null;
    detachScroll();
    set(null);
  },
  onDrop(handler: ((target: SplitTarget, x: number, y: number) => void) | null): void {
    dropHandler = handler;
  },
};
