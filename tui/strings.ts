/**
 * Every user-facing English string of the terminal screen, kept in one module so translations can
 * follow later and the wording conventions scan (src/conventions.test.ts) checks them in one place.
 */

/** A fallback key the config's own bindings hold, and what holds it. */
interface HeldKey { readonly key: string; readonly holder: string }

const heldKeys = (skipped: readonly HeldKey[]): string => skipped.map(({ key, holder }) => `${key}->${holder}`).join(", ");

export const STRINGS = {
  // Sidebar & header
  sessionHeader: (session: string): string => `hc:${session}`,
  workspacesSection: "Workspaces",
  agentsSection: "Agents",
  noSpaces: "No workspaces",
  noAgents: "No agents",
  sidebarToggleCollapse: "<<",
  worktreeMark: "|-",
  /** before an agent row that another agent row started */
  helperMark: "+",
  /** a section of an agent list: its state word and how many agents stand in it */
  agentSection: (word: string, count: number): string => `${word} (${count})`,

  // Tab bar
  zoomMark: "ZOOM",
  tabZoomSuffix: " Z",
  noTabs: "No tabs",

  // State words (matching src/lib/inboxRow.ts and DESIGN.md)
  stateBlocked: "Needs you",
  stateWorking: "Working",
  stateDone: "Done",
  stateIdle: "Ready",

  // State glyphs (never colour alone)
  glyphBlocked: "!",
  glyphDone: "*",
  glyphWorking: "~",
  glyphIdle: "-",
  glyphUnknown: "·",

  // Mode bar labels
  modeTerminal: "TERMINAL",
  modePrefix: "PREFIX",
  modeNavigate: "NAVIGATE",
  modeResize: "RESIZE",
  modeCopy: "COPY",
  modeLocked: "LOCKED",
  errorBadge: "ERROR",

  // Visible states & banners
  offlineTitle: "herdr-core is not answering",
  offlineCommand: "hc server start",
  offlineDetail: (code: string | null): string => `${STRINGS.offlineTitle}: ${STRINGS.offlineCommand}${code ? ` (${code})` : ""}`,
  offlinePaneBanner: (): string => `${STRINGS.offlineTitle} · ${STRINGS.offlineCommand}`,
  appOwnedCore: "the Herdr app arranges this core",
  emptyCoreTitle: "No workspaces yet",
  emptyCoreOffer: (folder: string, key: string | null): string => `New workspace in ${folder}${key === null ? "" : ` (${key})`}`,

  // Pane states & border notices
  endedCode: (code: number | null): string => `ended (${code ?? "none"})`,
  waitingNewShell: "waiting for its new shell",
  sizedByViewer: (cols: number, rows: number): string => `sized by another viewer (${cols}x${rows})`,
  waitingOffline: "waiting for herdr-core",
  waitingClosed: "stream closed",
  openingPane: "opening terminal",
  paintingPane: "loading screen",
  closingPane: "closing stream",
  failedPane: (reason: string): string => `failed: ${reason}`,
  idlePane: "not attached",

  // Overlays
  helpTitle: "Keyboard Shortcuts",
  helpUnset: "unset",
  helpCloseLabel: (keys: readonly string[]): string => `close: ${keys.join(" / ")}`,
  helpParityPrefix: "not built",
  helpRefusalsTitle: "Config Diagnostics",
  helpMoreRefusals: (more: number): string => `+${more} more config diagnostics`,
  textRenameWorkspace: "Rename workspace",
  textRenameTab: "Rename tab",
  textRenamePane: "Rename pane",
  textNewTab: "New tab name",
  textPromptHint: "Enter to save · Ctrl+U to clear",
  confirmCloseTitle: "Close workspace",
  confirmCloseWorkspace: (name: string): string => `Close workspace ${name}? [y/N]`,
  gotoTitle: "Go to",
  gotoPromptHint: "Type to filter · Enter to jump",
  pickerNoMatch: "No matches",
  menuTitle: "Menu",
  agentListTitle: "Agents",
  agentListHint: "1-9 or Enter: go to · u: mark unread",
  /** at the right of the narrow screen's header, which opens the menu */
  menuMark: "[menu]",
  /** what kind of place a menu entry goes to */
  menuPlaces: { workspace: "workspace", tab: "tab", pane: "pane", agent: "agent" } as const,

  // Keymap notes in help & mode bar
  notePrefixFallback: (binding: string, fallback: string): string =>
    `prefix_fallback: ${binding} cannot be typed; using ${fallback}`,
  notePrefixUnreachable: (binding: string, skipped: readonly HeldKey[]): string =>
    `prefix_unreachable: ${binding} cannot be typed and all fallbacks are held (${heldKeys(skipped)}); use menu or close terminal`,
  noteDetachFallback: (fallback: string): string =>
    `detach_fallback: detach uses ${fallback}`,
  noteDetachUnreachable: (skipped: readonly HeldKey[]): string =>
    `detach_unreachable: no key can detach (${heldKeys(skipped)}); use action detach or close terminal`,
  noteLockTaken: (holder: string): string => `lock_taken: lock key held by ${holder}`,
  noteTaken: (action: string, binding: string, holder: string): string =>
    `taken: ${action} (${binding}) held by ${holder}`,
  noteDropped: (code: string, action: string, binding: string): string =>
    `${code}: ${action} (${binding}) cannot fire`,
  noteIndexedLegacy: (entry: string): string => `indexed_legacy: [keys.indexed].${entry} is ignored`,
  noteBlankBinding: (action: string): string => `blank_binding: ${action} unbound by blank entry`,
  refusalLine: (code: string, action: string, binding: string, holder: string | null): string =>
    `${code}: ${action} = ${binding}${holder === null ? "" : ` (held by ${holder})`}`,

  /** the help's and the mode bar's name for each action of the key table */
  actions: {
    prefix: "prefix",
    help: "help",
    settings: "settings",
    new_workspace: "new workspace",
    new_worktree: "new worktree",
    open_worktree: "open worktree",
    remove_worktree: "remove worktree",
    rename_workspace: "rename workspace",
    close_workspace: "close workspace",
    workspace_picker: "navigate",
    goto: "go to",
    detach: "detach",
    reload_config: "reload",
    open_notification_target: "jump alert",
    previous_workspace: "prev workspace",
    next_workspace: "next workspace",
    previous_agent: "prev agent",
    next_agent: "next agent",
    focus_agent: "agent",
    new_tab: "new tab",
    rename_tab: "rename tab",
    previous_tab: "prev tab",
    next_tab: "next tab",
    move_tab_previous: "move tab <",
    move_tab_next: "move tab >",
    switch_tab: "tab",
    switch_workspace: "workspace",
    close_tab: "close tab",
    rename_pane: "rename pane",
    edit_scrollback: "edit scrollback",
    clear_pane: "clear pane",
    copy_mode: "copy",
    focus_pane_left: "left",
    focus_pane_down: "down",
    focus_pane_up: "up",
    focus_pane_right: "right",
    swap_pane_left: "swap <",
    swap_pane_down: "swap v",
    swap_pane_up: "swap ^",
    swap_pane_right: "swap >",
    last_pane: "last pane",
    cycle_pane_next: "next pane",
    cycle_pane_previous: "prev pane",
    split_vertical: "split |",
    split_horizontal: "split -",
    close_pane: "close pane",
    zoom: "zoom",
    resize_mode: "resize",
    resize_pane_left: "grow <",
    resize_pane_down: "grow v",
    resize_pane_up: "grow ^",
    resize_pane_right: "grow >",
    toggle_sidebar: "sidebar",
    lock: "lock",
    menu: "menu",
    agents: "agents",
    navigate_workspace_up: "workspace ^",
    navigate_workspace_down: "workspace v",
    navigate_pane_left: "pane <",
    navigate_pane_down: "pane v",
    navigate_pane_up: "pane ^",
    navigate_pane_right: "pane >",
    navigate_focus: "select",
    navigate_cancel: "cancel",
    navigate_index: "workspace 1..9",
    navigate_cycle_next: "next pane",
    navigate_cycle_previous: "prev pane",
    navigate_move_up: "move workspace ^",
    navigate_move_down: "move workspace v",
    navigate_move_pane: "move pane here",
    resize_leave: "done",
    copy_leave: "done",
  } as Readonly<Record<string, string>>,

  // Notice messages by code
  noticeText: (code: string, data: Readonly<Record<string, string | number>>): string => {
    switch (code) {
      case "ime_prefix":
        return "ime_prefix: switch to the English keyboard for prefix keys";
      case "not_built":
        return `not_built: ${data["action"] ?? "action"} is not built in this screen`;
      case "input_refused":
        return `input_refused: pane is ${data["reason"] ?? "not ready"}`;
      case "paste_refused":
        return `paste_refused: paste over limit (${data["length"] ?? 0} bytes)`;
      case "keys_unread":
        return "keys_unread: herdr config could not be read; using defaults";
      case "keys_refused":
        return `keys_refused: ${data["count"] ?? 0} key bindings refused or dropped`;
      case "unlocked":
        return "unlocked: lock key was unbound on reload";
      case "lock_unbound":
        return "lock_unbound: lock key is not bound";
      case "locked":
        return `locked: screen is locked (${data["action"] ?? ""})`;
      case "nothing_focused":
        return `nothing_focused: no target for ${data["action"] ?? "action"}`;
      case "agent_blocked":
        return `${STRINGS.stateBlocked}: ${data["agent"] ?? "agent"}`;
      case "agent_done":
        return `${STRINGS.stateDone}: ${data["agent"] ?? "agent"}`;
      case "nothing_waiting":
        return "nothing_waiting: no agent needs you";
      case "view_moved":
        return "view_moved: the place this core was left at is gone; showing the nearest one";
      case "view_unread":
        return `view_unread: the view kept for this core could not be read (${data["reason"] ?? "unknown"})`;
      case "view_unsaved":
        return `view_unsaved: the view could not be kept for the next run (${data["reason"] ?? "unknown"})`;
      case "target_gone": {
        const detail = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ");
        return `target_gone: ${detail || "target closed"}`;
      }
      default: {
        const detail = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ");
        return detail ? `${code}: ${detail}` : code;
      }
    }
  },
} as const;
