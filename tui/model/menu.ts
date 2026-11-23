/**
 * The screen's menu: one list that reaches every place to go (workspaces, the shown workspace's tabs, the shown tab's
 * panes, the agents) and every built action of the catalogue. Every entry is chosen with the arrows and Enter, or by
 * its key: a digit for the first ten places, a letter for each action. Neither needs Escape, Ctrl or a key an input
 * method composes before it is sent, so a phone keyboard or a Korean input method reaches every action once the menu
 * is open (it opens by a click on the header as well as by its key after the prefix).
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";
import { neighbour, type PaneDirection } from "../../server/herdr-core/layout-doc.ts";
import { CATALOGUE } from "./catalogue.ts";
import type { KeyInput, OverlayChoice } from "./effects.ts";
import { type Focus, focused, type PaneNode, type TabNode, type World } from "./focus.ts";

/** The actual directional target, shared by menu identity and the effect applied after selection. */
export function directionalNeighbour(tab: TabNode | null, pane: PaneNode | null, action: HerdrAction): string | null | undefined {
  let direction: PaneDirection;
  switch (action) {
    case "focus_pane_left": case "swap_pane_left": direction = "left"; break;
    case "focus_pane_right": case "swap_pane_right": direction = "right"; break;
    case "focus_pane_up": case "swap_pane_up": direction = "up"; break;
    case "focus_pane_down": case "swap_pane_down": direction = "down"; break;
    default: return undefined;
  }
  return tab?.root && pane ? neighbour(tab.root, pane.id, direction) : undefined;
}

type PlaceKind = "workspace" | "tab" | "pane" | "agent";

/** One line of the menu: a place (its id; an agent's and a pane's is the pane's) or an action; `label` the key that chooses it. */
export type MenuEntry = { readonly epoch: number } & (
  | { readonly kind: PlaceKind; readonly id: string; readonly label: string | null; readonly created?: number }
  | { readonly kind: "action"; readonly action: HerdrAction; readonly label: string; readonly targets: string });

/** The keys of the first places, in order: digits, which every keyboard types and no input method composes. */
const PLACE_LABELS = [..."1234567890"];
/** The keys of the actions, in the catalogue's order: as many letters as herdr has actions. */
const ACTION_LABELS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** The menu's entries for what exists now and where the screen looks. */
export function menuEntries(world: World, focus: Focus, epoch: number): MenuEntry[] {
  const shown = focused(world, focus);
  const created = new Map(world.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => [p.id, p.created] as const))));
  const places: { kind: PlaceKind; id: string }[] = [
    ...world.workspaces.map(({ id }) => ({ kind: "workspace" as const, id })),
    ...(shown.workspace?.tabs ?? []).map(({ id }) => ({ kind: "tab" as const, id })),
    // one terminal shows at a time on a narrow screen: the others of its tab are reached here
    ...((shown.tab?.panes.length ?? 0) > 1 ? shown.tab!.panes.map(({ id }) => ({ kind: "pane" as const, id })) : []),
    ...(world.agents ?? []).map((id) => ({ kind: "agent" as const, id })),
  ];
  const actions = CATALOGUE.filter((entry) => entry.status === "built");
  const { workspace, tab, pane } = shown;
  const paneId = (id: string) => [id, created.get(id) ?? null];
  const here = [workspace?.id, tab?.id, pane && paneId(pane.id)];
  // Include the scope of relative choices and the complete seen set of a close. An unrelated workspace
  // appearing does not invalidate a pane action; a new terminal reusing the same address does.
  const targets = (action: HerdrAction): string => {
    switch (action) {
      case "help": case "goto": case "detach": case "reload_config": case "toggle_sidebar": case "new_workspace":
        return "";
      case "workspace_picker": case "rename_workspace": case "new_tab":
        return JSON.stringify(workspace?.id ?? null);
      case "rename_tab":
        return JSON.stringify([workspace?.id, tab?.id]);
      case "previous_workspace": case "next_workspace": case "switch_workspace":
        return JSON.stringify([workspace?.id, world.workspaces.map((w) => w.id)]);
      case "previous_tab": case "next_tab": case "move_tab_previous": case "move_tab_next": case "switch_tab":
        return JSON.stringify([workspace?.id, tab?.id, workspace?.tabs.map((t) => t.id)]);
      case "close_workspace":
        return JSON.stringify([workspace?.id, workspace?.tabs.flatMap((t) => t.panes.map((p) => paneId(p.id)))]);
      case "close_tab": case "close_pane": {
        const ends = action === "close_tab" ? tab?.panes : pane && [pane];
        const all = workspace?.tabs.reduce((n, t) => n + t.panes.length, 0);
        return JSON.stringify([workspace?.id, tab?.id, ends?.map((p) => paneId(p.id)), ends?.length === all]);
      }
      case "last_pane":
        return JSON.stringify([here, focus.previous && paneId(focus.previous)]);
      case "previous_agent": case "next_agent": case "focus_agent": case "open_notification_target":
        return JSON.stringify([here, world.agents?.map(paneId)]);
      case "cycle_pane_previous": case "cycle_pane_next":
        return JSON.stringify([here, tab?.panes.map((p) => paneId(p.id))]);
      case "focus_pane_left": case "focus_pane_right": case "focus_pane_up": case "focus_pane_down":
      case "swap_pane_left": case "swap_pane_right": case "swap_pane_up": case "swap_pane_down": {
        const other = directionalNeighbour(tab, pane, action);
        return JSON.stringify([here, other == null ? null : paneId(other)]);
      }
      default:
        return JSON.stringify(here);
    }
  };
  return [
    ...places.map((place, at): MenuEntry => ({
      ...place, epoch, label: PLACE_LABELS[at] ?? null,
      ...(place.kind === "pane" || place.kind === "agent" ? { created: created.get(place.id) } : {}),
    })),
    ...actions.map(({ id }, at): MenuEntry => ({ kind: "action", action: id, epoch, label: ACTION_LABELS[at]!, targets: targets(id) })),
  ];
}

/** An entry's identity, the same across world updates: what a click on its painted line names (never its index, which a world update shifts). */
export const entryKey = (entry: MenuEntry): string => entry.kind === "action"
  ? `${entry.epoch}:action:${entry.action}:${entry.targets}` : JSON.stringify([entry.epoch, entry.kind, entry.id, entry.created]);

/** The cursor's place among `next` for the entry it was on in `before`: the same entry, else the same index, kept in range. */
export function keptCursor(before: readonly MenuEntry[], cursor: number, next: readonly MenuEntry[]): number {
  const was = before[cursor];
  const same = was === undefined ? -1 : indexOfEntry(next, was);
  return same >= 0 ? same : Math.max(0, Math.min(cursor, next.length - 1));
}

export function indexOfEntry(entries: readonly MenuEntry[], wanted: MenuEntry): number {
  const key = entryKey(wanted);
  return entries.findIndex((entry) => entryKey(entry) === key);
}

/** The actions that need a number say which place: the menu moves its cursor to the first place of that kind instead. */
const NUMBERED: Readonly<Partial<Record<HerdrAction, PlaceKind>>> = { switch_workspace: "workspace", switch_tab: "tab", focus_agent: "agent" };

/** What choosing entry `at` does: the cursor moves (the menu stays open), or the menu closes with its choice. */
export function chooseEntry(entries: readonly MenuEntry[], at: number): { cursor: number } | { choice: OverlayChoice } | null {
  const entry = entries[at];
  if (entry === undefined) return null;
  if (entry.kind !== "action") return { choice: { kind: "select", target: { kind: entry.kind === "agent" ? "pane" : entry.kind, id: entry.id } } };
  const kind = NUMBERED[entry.action];
  const first = kind === undefined ? -1 : entries.findIndex((candidate) => candidate.kind === kind);
  return first >= 0 ? { cursor: first } : { choice: { kind: "action", action: entry.action } };
}

/** The entry a typed character chooses, by its label; -1 for none. */
export function labelled(entries: readonly MenuEntry[], char: string): number {
  return char === "" ? -1 : entries.findIndex((entry) => entry.label === char);
}

/** The cursor after an arrow key (wrapping round), or null for any other key. */
export function movedCursor(entries: readonly MenuEntry[], cursor: number, event: KeyInput): number | null {
  if (Object.keys(event.mods).length > 0 || entries.length === 0) return null;
  const step = event.key === "ARROW_DOWN" ? 1 : event.key === "ARROW_UP" ? -1 : 0;
  return step === 0 ? null : ((cursor + step) % entries.length + entries.length) % entries.length;
}
