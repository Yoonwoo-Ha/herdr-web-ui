/**
 * herdr's right-click menus (docs/tui/visual-parity.md R1-R8): a pane's, a tab's and a workspace's, each with herdr's
 * entries in herdr's order. A workspace in a git checkout adds herdr's worktree entries: `New worktree` and `Delete worktree
 * checkout...` (on a worktree grouped under its repository) are done by the Ovis server, which runs git (ovis-server.ts);
 * `Open worktree...` reads the checkouts from git's own files; a repository's workspace with worktrees under it adds
 * `Close group` and `Collapse`/`Expand`.
 */
import type { Target, World } from "./focus.ts";

export type ContextAction =
  | "rename_pane" | "clear_pane_name" | "swap_with_focused" | "split_vertical" | "split_horizontal" | "zoom" | "passthrough_on" | "passthrough_off" | "close_pane"
  | "new_tab" | "rename_tab" | "close_tab"
  | "rename_workspace" | "close_workspace" | "new_worktree" | "open_worktree" | "delete_checkout" | "close_group" | "collapse_group" | "expand_group";

/** A menu's entries for what was right-clicked, as the world is now; `focusedPane`: the pane input goes to. */
export function contextEntries(world: World, target: Target, focusedPane: string | null): ContextAction[] {
  for (const workspace of world.workspaces) {
    if (target.kind === "workspace" && workspace.id === target.id) {
      if (workspace.group) return ["rename_workspace", "close_group", "new_worktree", "open_worktree", workspace.group.collapsed ? "expand_group" : "collapse_group"];
      if (workspace.parent !== undefined) return ["rename_workspace", "close_workspace", "delete_checkout"];
      return workspace.branch !== undefined ? ["rename_workspace", "close_workspace", "new_worktree", "open_worktree"] : ["rename_workspace", "close_workspace"];
    }
    for (const tab of workspace.tabs) {
      if (target.kind === "tab" && tab.id === target.id) return ["new_tab", "rename_tab", "close_tab"];
      const pane = target.kind === "pane" ? tab.panes.find((one) => one.id === target.id) : undefined;
      if (!pane) continue;
      return [
        "rename_pane",
        ...(pane.name !== "" ? ["clear_pane_name" as const] : []),
        ...(pane.id !== focusedPane ? ["swap_with_focused" as const] : []),
        "split_vertical",
        "split_horizontal",
        "zoom",
        tab.passthrough?.includes(pane.id) ? "passthrough_off" : "passthrough_on",
        "close_pane",
      ];
    }
  }
  return [];
}

/** The cursor after an up or down arrow, stopping at the ends as herdr's menu does; null for any other key. */
export function contextCursor(count: number, cursor: number, key: string): number | null {
  if (key === "ARROW_DOWN") return Math.min(count - 1, cursor + 1);
  if (key === "ARROW_UP") return Math.max(0, cursor - 1);
  return null;
}
