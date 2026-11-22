/**
 * Every one of herdr's 52 actions (shared/herdr-keys.ts), built or left as a parity difference with
 * its reason. `built`: the reducer gives its effect as data. A bound action that is not built shows
 * one notice naming it.
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";

export type CatalogueEntry =
  | { readonly id: HerdrAction; readonly status: "built" }
  | { readonly id: HerdrAction; readonly status: "parity"; readonly reason: string };

const built = (id: HerdrAction): CatalogueEntry => ({ id, status: "built" });
const parity = (id: HerdrAction, reason: string): CatalogueEntry => ({ id, status: "parity", reason });

const WORKTREES = "worktree dialogs run git and stay with the server's adapter; the screen shows worktree workspaces as the shared snapshot groups them";

export const CATALOGUE: readonly CatalogueEntry[] = [
  built("help"),
  parity("settings", "a settings overlay that writes configuration back is left out on purpose"),
  built("new_workspace"),
  parity("new_worktree", WORKTREES),
  parity("open_worktree", WORKTREES),
  parity("remove_worktree", WORKTREES),
  built("rename_workspace"),
  built("close_workspace"),
  built("workspace_picker"),
  built("goto"),
  built("detach"),
  built("reload_config"),
  built("open_notification_target"),
  built("previous_workspace"),
  built("next_workspace"),
  built("previous_agent"),
  built("next_agent"),
  built("focus_agent"),
  built("new_tab"),
  built("rename_tab"),
  built("previous_tab"),
  built("next_tab"),
  built("move_tab_previous"),
  built("move_tab_next"),
  built("switch_tab"),
  built("switch_workspace"),
  built("close_tab"),
  built("rename_pane"),
  parity("edit_scrollback", "it opens the scrollback in an editor program, and the screen starts no process"),
  parity("clear_pane", "herdr clears a pane through its own server; herdr-core has no call for it, and typing a clear into the program is not the same"),
  built("copy_mode"),
  built("focus_pane_left"),
  built("focus_pane_down"),
  built("focus_pane_up"),
  built("focus_pane_right"),
  built("swap_pane_left"),
  built("swap_pane_down"),
  built("swap_pane_up"),
  built("swap_pane_right"),
  built("last_pane"),
  built("cycle_pane_next"),
  built("cycle_pane_previous"),
  built("split_vertical"),
  built("split_horizontal"),
  built("close_pane"),
  built("zoom"),
  built("resize_mode"),
  built("resize_pane_left"),
  built("resize_pane_down"),
  built("resize_pane_up"),
  built("resize_pane_right"),
  built("toggle_sidebar"),
];

export const CATALOGUE_BY_ID: Readonly<Record<HerdrAction, CatalogueEntry>> = Object.fromEntries(CATALOGUE.map((entry) => [entry.id, entry])) as Record<HerdrAction, CatalogueEntry>;
