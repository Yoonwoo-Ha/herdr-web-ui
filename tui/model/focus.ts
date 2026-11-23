/**
 * What exists (workspaces, their tabs, each tab's panes in tree order) and where this screen looks.
 * Focus is the screen's own: herdr-core has none, and it is never written anywhere shared.
 */
import type { LayoutNode } from "../../server/herdr-core/layout-doc.ts";

/** `created`: when the core made the pane's terminal (its `created_ms`), so a later terminal at the same address is told apart */
export interface PaneNode { readonly id: string; readonly name: string; readonly created?: number }
/** `zoomed`: the pane a zoom shows alone; while it lasts it is the tab's shown pane, whatever pane the focus remembers */
export interface TabNode { readonly id: string; readonly name: string; readonly panes: readonly PaneNode[]; readonly zoomed?: string; readonly root?: LayoutNode }
export interface WorkspaceNode { readonly id: string; readonly name: string; readonly tabs: readonly TabNode[] }
/** `agents`: the panes that run an agent, in the sidebar's order (shared/attention.ts); none when not told */
export interface World { readonly workspaces: readonly WorkspaceNode[]; readonly agents?: readonly string[] }

export const EMPTY_WORLD: World = { workspaces: [] };

/** The focused workspace, the tab each workspace shows, the pane each tab shows, and the pane looked at before. */
export interface Focus {
  readonly workspace: string | null;
  readonly tabs: Readonly<Record<string, string>>;
  readonly panes: Readonly<Record<string, string>>;
  readonly previous: string | null;
}

export const NO_FOCUS: Focus = { workspace: null, tabs: {}, panes: {}, previous: null };

export interface Target { readonly kind: "workspace" | "tab" | "pane"; readonly id: string }

export interface Focused { readonly workspace: WorkspaceNode | null; readonly tab: TabNode | null; readonly pane: PaneNode | null }

function own(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function find<T extends { readonly id: string }>(list: readonly T[], id: string | null | undefined): T | undefined {
  return id === null || id === undefined ? undefined : list.find((node) => node.id === id);
}

/**
 * What the screen shows: the focused workspace, its tab and that tab's pane (the first of each when none is remembered). A
 * zoomed tab shows its zoomed pane, so what is typed reaches the pane on the screen; the remembered pane comes back when the
 * zoom ends.
 */
export function focused(world: World, focus: Focus): Focused {
  const workspace = find(world.workspaces, focus.workspace) ?? world.workspaces[0] ?? null;
  const tab = workspace === null ? null : find(workspace.tabs, own(focus.tabs, workspace.id)) ?? workspace.tabs[0] ?? null;
  const pane = tab === null ? null : find(tab.panes, tab.zoomed) ?? find(tab.panes, own(focus.panes, tab.id)) ?? tab.panes[0] ?? null;
  return { workspace, tab, pane };
}

interface Path { readonly workspace: WorkspaceNode; readonly tab: TabNode | null; readonly pane: PaneNode | null }

function pathOf(world: World, target: Target): Path | null {
  for (const workspace of world.workspaces) {
    if (target.kind === "workspace" && workspace.id === target.id) return { workspace, tab: null, pane: null };
    for (const tab of workspace.tabs) {
      if (target.kind === "tab" && tab.id === target.id) return { workspace, tab, pane: null };
      const pane = target.kind === "pane" ? find(tab.panes, target.id) : undefined;
      if (pane !== undefined) return { workspace, tab, pane };
    }
  }
  return null;
}

export function exists(world: World, target: Target): boolean {
  return pathOf(world, target) !== null;
}

/**
 * Focus moved to `target` (a workspace shows its remembered tab and pane), or null when it does not exist.
 * When the shown pane changes, the one left becomes `previous`; a pane a zoom keeps covered is remembered, never shown, so
 * selecting it changes nothing there.
 */
export function focusOn(world: World, focus: Focus, target: Target): Focus | null {
  const path = pathOf(world, target);
  if (path === null) return null;
  const { workspace } = path;
  const tab = path.tab ?? find(workspace.tabs, own(focus.tabs, workspace.id)) ?? workspace.tabs[0] ?? null;
  const pane = path.pane ?? (tab === null ? null : find(tab.panes, own(focus.panes, tab.id)) ?? tab.panes[0] ?? null);
  const next: Focus = {
    workspace: workspace.id,
    tabs: tab === null ? focus.tabs : { ...focus.tabs, [workspace.id]: tab.id },
    panes: tab === null || pane === null ? focus.panes : { ...focus.panes, [tab.id]: pane.id },
    previous: focus.previous,
  };
  const before = focused(world, focus).pane?.id ?? null;
  const shown = focused(world, next).pane?.id ?? null;
  return before !== null && shown !== null && shown !== before ? { ...next, previous: before } : next;
}

/** One of `after` for a focus that was `current`: it if it is still there, else `preferred`, else the next one in `before` that is still there, else the first. */
function pick<T extends { readonly id: string }>(before: readonly T[] | undefined, after: readonly T[], current: string | undefined, preferred: string | undefined): string | undefined {
  if (find(after, current) !== undefined) return current;
  if (find(after, preferred) !== undefined) return preferred;
  const at = before?.findIndex((node) => node.id === current) ?? -1;
  if (before !== undefined && at >= 0) {
    for (const node of before.slice(at + 1)) if (find(after, node.id) !== undefined) return node.id;
  }
  return after[0]?.id;
}

/**
 * The focus after the world changed from `before` to `after`: what is still there stays; a closed pane
 * gives way to the previous pane when it is alive in that tab, else the next pane in tree order, else the
 * tab's first; the same for a closed tab (the tab holding the previous pane) and a closed workspace. Every
 * remembered tab and pane exists in `after`.
 */
export function nextFocus(before: World, after: World, focus: Focus): Focus {
  const previousPath = focus.previous === null ? null : pathOf(after, { kind: "pane", id: focus.previous });
  const oldWorkspaces = new Map(before.workspaces.map((workspace) => [workspace.id, workspace]));
  const oldTabs = new Map(before.workspaces.flatMap((workspace) => workspace.tabs).map((tab) => [tab.id, tab]));
  const tabs: [string, string][] = [];
  const panes: [string, string][] = [];
  for (const workspace of after.workspaces) {
    const tab = pick(oldWorkspaces.get(workspace.id)?.tabs, workspace.tabs, own(focus.tabs, workspace.id), previousPath?.workspace.id === workspace.id ? previousPath.tab?.id : undefined);
    if (tab !== undefined) tabs.push([workspace.id, tab]);
    for (const node of workspace.tabs) {
      const pane = pick(oldTabs.get(node.id)?.panes, node.panes, own(focus.panes, node.id), previousPath?.tab?.id === node.id ? previousPath.pane?.id : undefined);
      if (pane !== undefined) panes.push([node.id, pane]);
    }
  }
  const workspace = pick(before.workspaces, after.workspaces, focus.workspace ?? undefined, previousPath?.workspace.id) ?? null;
  const next: Focus = { workspace, tabs: Object.fromEntries(tabs), panes: Object.fromEntries(panes), previous: previousPath === null ? null : focus.previous };
  return next.previous !== null && focused(after, next).pane?.id === next.previous ? { ...next, previous: null } : next;
}
