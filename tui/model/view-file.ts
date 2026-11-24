/**
 * The view the screen keeps between runs, per core: where it looked (the focused workspace, the tab each workspace
 * shows, the pane each tab shows, the pane looked at before) and the ids of what existed then, so that a rerun after a
 * dropped line opens the same place, and a place that is gone gives way by the same rule a close does (`nextFocus`).
 * Ids only: workspace and tab ids, terminal addresses and when the core made each terminal. Never a name, a pane's
 * text or anything typed. Pure: tui/view-store.ts reads and writes the file.
 */
import { type Focus, focused, nextFocus, type World } from "./focus.ts";

const VIEW_FILE_VERSION = 1;
/** A larger file is not read (tui/view-store.ts checks its size before reading): this screen never writes one (a few dozen bytes per terminal). */
export const VIEW_FILE_MAX_BYTES = 1024 * 1024;
/** The longest id kept: hc's ids are far shorter. */
const ID_MAX_CHARS = 256;

/** What a view file holds: the focus, and the workspaces, tabs and panes it was taken among (names left empty). */
export interface SavedView { readonly focus: Focus; readonly world: World }

interface FileShape {
  v: number;
  focus: { workspace: string | null; tabs: Record<string, string>; panes: Record<string, string>; previous: string | null };
  world: { id: string; tabs: { id: string; panes: { id: string; created?: number }[] }[] }[];
}

/** The file's text for `world` and `focus`; null when no pane shows (nothing worth keeping, and an older file stays). */
export function viewText(world: World, focus: Focus): string | null {
  if (focused(world, focus).pane === null) return null;
  const shape: FileShape = {
    v: VIEW_FILE_VERSION,
    focus: { workspace: focus.workspace, tabs: { ...focus.tabs }, panes: { ...focus.panes }, previous: focus.previous },
    world: world.workspaces.map((workspace) => ({
      id: workspace.id,
      tabs: workspace.tabs.map((tab) => ({ id: tab.id, panes: tab.panes.map((pane) => (pane.created === undefined ? { id: pane.id } : { id: pane.id, created: pane.created })) })),
    })),
  };
  return `${JSON.stringify(shape)}\n`;
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= ID_MAX_CHARS;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idMap = (value: unknown): value is Record<string, string> => isRecord(value) && Object.entries(value).every(([key, id]) => isId(key) && isId(id));
const listOf = <T>(value: unknown, item: (entry: unknown) => entry is T): value is T[] => Array.isArray(value) && value.every(item);

const isPane = (value: unknown): value is { id: string; created?: number } =>
  isRecord(value) && isId(value["id"]) && (value["created"] === undefined || Number.isFinite(value["created"]));
const isTab = (value: unknown): value is { id: string; panes: { id: string; created?: number }[] } => isRecord(value) && isId(value["id"]) && listOf(value["panes"], isPane);
const isWorkspace = (value: unknown): value is FileShape["world"][number] => isRecord(value) && isId(value["id"]) && listOf(value["tabs"], isTab);

/**
 * Why a file holds no view this screen can use: `unreadable`, `not_a_file` (a FIFO, a device, a folder), `too_large`,
 * `not_json`, `version` (another version's) or `shape`.
 */
export type ViewProblem = "unreadable" | "not_a_file" | "too_large" | "not_json" | "version" | "shape";

/** The view in a file's text, or the problem that makes it none. */
export function readView(text: string): { view: SavedView } | { problem: ViewProblem } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { problem: "not_json" };
  }
  if (!isRecord(data)) return { problem: "shape" };
  if (data["v"] !== VIEW_FILE_VERSION) return { problem: "version" };
  const focus = data["focus"];
  if (!isRecord(focus) || !(focus["workspace"] === null || isId(focus["workspace"])) || !idMap(focus["tabs"]) || !idMap(focus["panes"])) return { problem: "shape" };
  if (!(focus["previous"] === null || isId(focus["previous"])) || !listOf(data["world"], isWorkspace)) return { problem: "shape" };
  return {
    view: {
      focus: { workspace: focus["workspace"], tabs: { ...focus["tabs"] }, panes: { ...focus["panes"] }, previous: focus["previous"] },
      world: {
        workspaces: data["world"].map((workspace) => ({
          id: workspace.id, name: "",
          tabs: workspace.tabs.map((tab) => ({ id: tab.id, name: "", panes: tab.panes.map((pane) => ({ id: pane.id, name: "", ...(pane.created === undefined ? {} : { created: pane.created }) })) })),
        })),
      },
    },
  };
}

/**
 * Why the next run would refuse a file holding `text`, by the reader's own checks (its size, then `readView`), or null:
 * the writer asks before it replaces a good file, so it never leaves one the next launch rejects.
 */
export function refusedView(text: string): ViewProblem | null {
  if (new TextEncoder().encode(text).byteLength > VIEW_FILE_MAX_BYTES) return "too_large";
  const read = readView(text);
  return "problem" in read ? read.problem : null;
}

/** A pane id no live terminal has, for a saved pane whose address the core now gives another terminal. */
const gone = (id: string): string => `${id}\u0000gone`;

/**
 * The focus the saved view gives on `world`: what is still there is shown again, and a place that is gone gives way
 * by `nextFocus`, as if it had been closed since. A saved pane whose address a newer terminal took (another `created`)
 * counts as gone. `moved`: the remembered pane changed, independently of the core's current zoom.
 */
export function restoredFocus(saved: SavedView, world: World): { focus: Focus; moved: boolean } {
  const created = new Map(world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane) => [pane.id, pane.created] as const))));
  const reused = new Set<string>();
  for (const workspace of saved.world.workspaces) for (const tab of workspace.tabs) for (const pane of tab.panes) {
    const now = created.get(pane.id);
    if (pane.created !== undefined && now !== undefined && now !== pane.created) reused.add(pane.id);
  }
  const rename = (id: string): string => (reused.has(id) ? gone(id) : id);
  const before: World = {
    workspaces: saved.world.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, panes: tab.panes.map((pane) => ({ ...pane, id: rename(pane.id) })) })) })),
  };
  const focus: Focus = {
    ...saved.focus,
    panes: Object.fromEntries(Object.entries(saved.focus.panes).map(([tab, pane]) => [tab, rename(pane)])),
    previous: saved.focus.previous === null ? null : rename(saved.focus.previous),
  };
  const wanted = focused(before, focus).pane?.id ?? null;
  const next = nextFocus(before, world, focus);
  const tab = next.workspace === null ? undefined : next.tabs[next.workspace];
  const remembered = tab === undefined ? null : next.panes[tab] ?? null;
  return { focus: next, moved: wanted !== remembered };
}
