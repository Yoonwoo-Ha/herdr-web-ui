/**
 * The help's content, as herdr's help lays it out: four sections (global keys, navigate mode, workspaces and tabs,
 * panes), each a heading and one row per command, the command's keys from the user's key table in a field of their
 * own and its words beside them, a blank row after each section. A row whose words do not fit the room beside the keys
 * goes on in the rows below, from the dialog's left edge, broken between words. Typing a filter keeps the rows whose
 * keys or words hold it, each on one row, its words right after its keys. The help shows a window of these lines; the
 * arrows, j and k move it a row, page up and down eight rows. Pure: the dialog's size comes from the screen's size alone.
 */
import { STRINGS } from "../strings.ts";
import { helpRows, shownRefusals } from "./hints.ts";
import type { KeyAction, Keymap, KeymapNote, Mode } from "./keymap.ts";

/** One command of a section: the actions whose keys it shows, in that mode, and only its first key when `first`. */
interface Command { readonly actions: readonly KeyAction[]; readonly mode?: Mode; readonly first?: true }

const run = (...actions: KeyAction[]): Command => ({ actions });
const navigate = (first: boolean, ...actions: KeyAction[]): Command => ({ actions, mode: "navigate", ...(first ? { first: true } : {}) });

/** The prefix key's own row; it is no action of the key table. */
const PREFIX = "prefix";

/** The sections in herdr's order; their words are tui/strings.ts `helpWords`. */
const SECTIONS: readonly { readonly heading: keyof typeof STRINGS.helpHeadings; readonly commands: readonly (Command | typeof PREFIX)[] }[] = [
  { heading: "global", commands: [PREFIX, run("help"), run("settings"), run("detach"), run("reload_config"), run("open_notification_target")] },
  {
    heading: "navigation", commands: [
      navigate(true, "navigate_cancel"), navigate(false, "navigate_workspace_up", "navigate_workspace_down"),
      navigate(false, "navigate_pane_left", "navigate_pane_down", "navigate_pane_up", "navigate_pane_right"),
      navigate(false, "navigate_cycle_next", "navigate_cycle_previous"), navigate(false, "navigate_focus"), navigate(false, "navigate_index"),
    ],
  },
  {
    heading: "workspaces", commands: [
      run("workspace_picker"), run("goto"), run("new_workspace"), run("new_worktree"), run("open_worktree"), run("remove_worktree"),
      run("rename_workspace"), run("close_workspace"), run("previous_workspace"), run("next_workspace"), run("switch_workspace"),
      run("previous_agent"), run("next_agent"), run("focus_agent"), run("new_tab"), run("rename_tab"), run("previous_tab"), run("next_tab"),
      run("move_tab_previous"), run("move_tab_next"), run("switch_tab"), run("close_tab"),
    ],
  },
  {
    heading: "panes", commands: [
      run("split_vertical"), run("split_horizontal"), run("close_pane"), run("rename_pane"), run("edit_scrollback"), run("clear_pane"),
      run("copy_mode"), run("zoom"), run("resize_mode"), run("resize_pane_left"), run("resize_pane_down"), run("resize_pane_up"),
      run("resize_pane_right"), run("toggle_sidebar"), run("focus_pane_left"), run("focus_pane_down"), run("focus_pane_up"),
      run("focus_pane_right"), run("cycle_pane_next"), run("cycle_pane_previous"), run("last_pane"),
    ],
  },
];

/** The help's lines: a heading, a command's first row (its keys and the first part of its words), a row its words go on in, a note, a blank. */
export type HelpLine =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "command"; readonly keys: string; readonly text: string }
  | { readonly kind: "more"; readonly text: string }
  | { readonly kind: "note"; readonly text: string; readonly warn: boolean }
  | { readonly kind: "blank" };

/** The columns of a command's first row the keys take: a blank, then the keys. */
export const HELP_KEY_COLUMNS = 30;
/** The rows of the dialog that are not its window of lines: the borders, the title, the filter, a blank above the lines and one below, the foot. */
const HELP_FRAME_ROWS = 7;
/** How far page up and down move the help: eight rows, as herdr's did with a window of 15 rows and of 11. */
export const HELP_PAGE_ROWS = 8;
/** herdr's help dialog at most; the screen keeps two columns at each side and a row above and below free. */
const HELP_SIZE = { width: 76, height: 22 } as const;

/** The help dialog's size on a screen `cols` x `rows`. */
export function helpSize(cols: number, rows: number): { width: number; height: number } {
  return { width: Math.min(HELP_SIZE.width, cols - 4), height: Math.min(HELP_SIZE.height, rows - 2) };
}

/** How many lines the help shows at once on a screen of `rows`. */
export function helpWindow(rows: number): number {
  return Math.max(0, helpSize(0, rows).height - HELP_FRAME_ROWS);
}

/** A key as the help writes it: herdr's name for the minus key is the sign. */
const shownKey = (key: string): string => key.replace(/(^|\+)minus$/, "$1-");

/** The keys a command shows: one-character keys first, then named ones, each in the order of its actions. */
function commandKeys(keymap: Keymap, rows: ReturnType<typeof helpRows>, command: Command | typeof PREFIX): string {
  if (command === PREFIX) return keymap.prefixes.map((prefix) => prefix.text).join(" / ") || STRINGS.helpUnset;
  const keys = command.actions.flatMap((action) => rows.find((row) => row.action === action && row.mode === (command.mode ?? "terminal"))?.keys ?? []);
  const shown = command.first ? keys.slice(0, 1) : [...keys.filter((key) => [...key].length === 1), ...keys.filter((key) => [...key].length !== 1)];
  return shown.length === 0 ? STRINGS.helpUnset : shown.map(shownKey).join(" / ");
}

/** `text` broken between words into a first part of `first` columns and further parts of `rest` columns. */
function wrap(text: string, first: number, rest: number): string[] {
  const parts: string[] = [];
  let line = "";
  let room = first;
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if ([...next].length <= room || (line === "" && room === rest)) {
      line = next;
      continue;
    }
    parts.push(line);
    line = word;
    room = rest;
  }
  parts.push(line);
  return parts;
}

/**
 * The help's lines for a dialog `width` wide: `notes` first (what the screen says of the user's key config, warnings
 * marked), then herdr's sections; with a `filter`, only the commands whose keys or words hold it, and the headings of
 * their sections.
 */
export function helpLines(keymap: Keymap, notes: readonly { readonly text: string; readonly warn: boolean }[], filter: string, width: number): HelpLine[] {
  const inner = Math.max(1, width - 2);
  const first = Math.max(0, inner - HELP_KEY_COLUMNS - 1);
  const rest = Math.max(1, inner - 1);
  const rows = helpRows(keymap);
  const wanted = filter.toLowerCase();
  const lines: HelpLine[] = wanted === "" ? notes.map((note) => ({ kind: "note", ...note })) : [];
  if (lines.length > 0) lines.push({ kind: "blank" });
  for (const section of SECTIONS) {
    const commands = section.commands.map((command) => ({
      keys: commandKeys(keymap, rows, command),
      text: command === PREFIX ? STRINGS.helpWords.prefix : STRINGS.helpWords[command.actions[0] as keyof typeof STRINGS.helpWords],
    })).filter((command) => wanted === "" || command.keys.toLowerCase().includes(wanted) || command.text.toLowerCase().includes(wanted));
    if (commands.length === 0) continue;
    lines.push({ kind: "heading", text: STRINGS.helpHeadings[section.heading] });
    for (const command of commands) {
      // filtered, a command is one row, its words right after its keys
      if (wanted !== "") {
        lines.push({ kind: "command", keys: command.keys, text: command.text });
        continue;
      }
      const [head = "", ...tail] = [...command.keys].length < HELP_KEY_COLUMNS - 1 ? wrap(command.text, first, rest) : ["", ...wrap(command.text, rest, rest)];
      lines.push({ kind: "command", keys: command.keys, text: head });
      for (const part of tail) lines.push({ kind: "more", text: part });
    }
    lines.push({ kind: "blank" });
  }
  return lines;
}

/** The first line the help shows: `scroll` kept within the lines it has. */
export function helpTop(lines: number, view: number, scroll: number): number {
  return Math.max(0, Math.min(scroll, lines - view));
}

function noteText(note: KeymapNote): string {
  switch (note.code) {
    case "prefix_fallback":
      return STRINGS.notePrefixFallback(note.binding, note.fallback);
    case "prefix_unreachable":
      return STRINGS.notePrefixUnreachable(note.binding, note.skipped);
    case "detach_fallback":
      return STRINGS.noteDetachFallback(note.fallback);
    case "detach_unreachable":
      return STRINGS.noteDetachUnreachable(note.skipped);
    case "lock_taken":
      return STRINGS.noteLockTaken(note.holder);
    case "taken":
      return STRINGS.noteTaken(note.action, note.binding, note.holder);
    case "indexed_legacy":
      return STRINGS.noteIndexedLegacy(note.entry);
    case "blank_binding":
      return STRINGS.noteBlankBinding(note.action);
    case "no_such_modifier":
    case "not_typable":
    case "shift_in_text":
    case "shifted_character":
    case "cancel_key":
    case "fixed_key":
      return STRINGS.noteDropped(note.code, note.action, note.binding);
  }
}

/** What the help says of the user's key config before its sections: each note (a prefix or detach no key reaches is a warning), then the refused bindings. */
export function helpNotes(keymap: Keymap): { readonly text: string; readonly warn: boolean }[] {
  const notes = keymap.notes.map((note) => ({ text: noteText(note), warn: note.code === "prefix_unreachable" || note.code === "detach_unreachable" }));
  const refusals = shownRefusals(keymap);
  if (refusals.shown.length === 0) return notes;
  return [
    ...notes,
    { text: STRINGS.helpRefusalsTitle, warn: true },
    ...refusals.shown.map((refusal) => ({ text: STRINGS.refusalLine(refusal.code, refusal.action, refusal.binding, refusal.holder), warn: false })),
    ...(refusals.more > 0 ? [{ text: STRINGS.helpMoreRefusals(refusals.more), warn: false }] : []),
  ];
}
