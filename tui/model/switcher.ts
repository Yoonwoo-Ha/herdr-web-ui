/**
 * herdr's switcher, the narrow screen's way to every place: a full-screen list of the agents (when there are any), the
 * workspaces with a new-workspace entry, the shown workspace's tabs with a new-tab entry, and herdr's menu. On a narrow
 * screen it is what prefix+w and the menu open. The arrows move a cursor over its entries (it starts on the shown
 * workspace), Enter or a click chooses one, Escape closes it.
 */
import type { OverlayChoice } from "./effects.ts";
import { type Focus, focused, type World } from "./focus.ts";
import { MENU_ENTRIES } from "./menu.ts";

/** One entry of the switcher: a place to go, or an action to run. */
export type SwitcherEntry =
  | { readonly kind: "agent" | "workspace" | "tab"; readonly id: string }
  | { readonly kind: "action"; readonly action: "new_workspace" | "new_tab" | (typeof MENU_ENTRIES)[number] };

/** The switcher's entries, in its order: agents, the new-workspace entry and the workspaces, the new-tab entry and the shown workspace's tabs, the menu. */
export function switcherEntries(world: World, focus: Focus): SwitcherEntry[] {
  const shown = focused(world, focus);
  return [
    ...(world.agents ?? []).map((id): SwitcherEntry => ({ kind: "agent", id })),
    { kind: "action", action: "new_workspace" },
    ...world.workspaces.map(({ id }): SwitcherEntry => ({ kind: "workspace", id })),
    { kind: "action", action: "new_tab" },
    ...(shown.workspace?.tabs ?? []).map(({ id }): SwitcherEntry => ({ kind: "tab", id })),
    ...MENU_ENTRIES.map((action): SwitcherEntry => ({ kind: "action", action })),
  ];
}

/** Where the switcher's cursor starts: on the shown workspace. */
export function switcherStart(world: World, focus: Focus): number {
  return Math.max(0, switcherEntries(world, focus).findIndex((entry) => entry.kind === "workspace" && entry.id === focus.workspace));
}

/** What choosing an entry does: go to its place, or run its action. */
export function switcherChoice(entry: SwitcherEntry): OverlayChoice {
  return entry.kind === "action" ? { kind: "action", action: entry.action } : { kind: "select", target: { kind: entry.kind === "agent" ? "pane" : entry.kind, id: entry.id } };
}
