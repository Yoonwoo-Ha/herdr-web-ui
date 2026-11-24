/**
 * What the mode bar and the help show, read from the one key table. Config text (a binding or a reason as
 * the user wrote it) is cleaned and clamped here, so the view draws it as given.
 */
import type { HerdrKeyRefusal } from "../../shared/herdr-keys.ts";
import { CATALOGUE_BY_ID } from "./catalogue.ts";
import { CONFIG_TEXT_MAX_CHARS, REFUSALS_SHOWN } from "./deadlines.ts";
import type { KeyAction, Keymap, KeyRow, Mode } from "./keymap.ts";
import type { ModelState } from "./reduce.ts";

/** One hint of the mode bar: its key (drawn as a key; "" for a hint drawn all as its label) and what it does. */
export interface Hint { readonly key: string; readonly label: ModeHintId }
/**
 * The mode bar outside terminal mode: the mode, what follows its badge before the first hint, and one short fixed set of
 * hints (herdr's), two spaces apart. Terminal mode has no bar.
 */
export interface ModeBar { readonly mode: Exclude<Mode, "terminal"> | "prefix" | "locked"; readonly lead: string; readonly hints: readonly Hint[] }

/** What the copy mode's hints read from the copy session: whether a selection or a search is under way. */
export interface CopyLook { readonly selecting: boolean; readonly searched: boolean }

// control characters, bidi controls and zero-width characters: they could move or hide what is drawn
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** Config text made safe to draw: no control, bidi or zero-width characters, at most CONFIG_TEXT_MAX_CHARS code points. */
export function cleanConfigText(text: string): string {
  const chars = [...text.replace(UNSAFE, "")];
  return chars.length <= CONFIG_TEXT_MAX_CHARS ? chars.join("") : `${chars.slice(0, CONFIG_TEXT_MAX_CHARS - 1).join("")}\u2026`;
}

/** The texts of a row's keys: a range as written while it holds all nine digits, else one text per digit it still holds. */
function keysOf(row: KeyRow, prefixed: boolean | null): string[] {
  return row.bindings.filter((binding) => prefixed === null || binding.prefixed === prefixed)
    .flatMap((binding) => binding.range && binding.chords.length < 9 ? binding.chords.map(({ chord }) => binding.text.replace("1..9", chord.key)) : [binding.text])
    .map((text) => cleanConfigText(prefixed === true ? text.replace(/^prefix\+/, "") : text));
}

/** The key an action of terminal mode is typed with after the prefix, as the mode bar shows it; "unset" when it has none. */
function afterPrefix(rows: readonly KeyRow[], action: KeyAction): string {
  const row = rows.find((one) => one.mode === "terminal" && one.action === action);
  return (row ? keysOf(row, true)[0] : undefined) ?? HELP_UNSET;
}

/** The texts of one row's keys in any mode, every binding as written. */
function rowKeys(rows: readonly KeyRow[], mode: Mode, action: KeyAction): string[] {
  const row = rows.find((one) => one.mode === mode && one.action === action);
  return row ? keysOf(row, null) : [];
}

/**
 * The mode bar: none in Terminal mode (null); otherwise the mode and its own short set of hints. The prefix shows how to
 * cancel it, send it on, navigate and open the help; navigate and resize their few keys; copy mode its motions, search,
 * selection, copy and exit (`copy` says whether a selection or a search is under way). Locked shows its unlock chord.
 */
export function modeBar(state: ModelState, copy: CopyLook = { selecting: false, searched: false }): ModeBar | null {
  const { rows } = state.keymap;
  if (state.locked) return { mode: "locked", lead: " ", hints: rowKeys(rows, "terminal", "lock").slice(0, 1).map((key) => ({ key, label: "unlock" })) };
  if (state.armed) {
    return {
      mode: "prefix", lead: " ", hints: [
        { key: "esc", label: "cancel" },
        { key: cleanConfigText(state.keymap.prefixes[0]?.text ?? HELP_UNSET), label: "sendPrefix" },
        { key: afterPrefix(rows, "workspace_picker"), label: "workspaceNav" },
        { key: afterPrefix(rows, "help"), label: "keybinds" },
      ],
    };
  }
  switch (state.mode.name) {
    case "terminal":
      return null;
    case "navigate":
      return {
        mode: "navigate", lead: " ", hints: [
          { key: "", label: "escBack" },
          { key: "↑/↓", label: "workspace" },
          { key: "tab", label: "pane" },
          { key: afterPrefix(rows, "help"), label: "keybinds" },
        ],
      };
    case "resize":
      return {
        mode: "resize", lead: "  ", hints: [
          { key: "h/l", label: "width" },
          { key: "j/k", label: "height" },
          { key: "esc", label: "done" },
        ],
      };
    case "copy": {
      const quiet = !copy.selecting && !copy.searched;
      return {
        mode: "copy", lead: " ", hints: [
          { key: "h/j/k/l w/b/e { }", label: "move" },
          { key: "/ ?", label: "search" },
          { key: "n/N", label: "repeat" },
          { key: "v/space", label: copy.selecting ? "selecting" : "select" },
          { key: "y/enter", label: "copy" },
          { key: quiet ? "q/esc" : "esc", label: quiet ? "exit" : "clearExit" },
        ],
      };
    }
  }
}

/** The ids of the mode bar's words (tui/strings.ts `modeHints` holds them). */
export type ModeHintId = "cancel" | "sendPrefix" | "workspaceNav" | "keybinds" | "escBack" | "workspace" | "pane" | "width" | "height" | "done"
  | "move" | "search" | "repeat" | "select" | "selecting" | "copy" | "exit" | "clearExit" | "unlock";

const HELP_UNSET = "unset";

export interface HelpRow {
  readonly mode: Mode;
  readonly action: KeyAction;
  /** as written ("prefix+1..9" for the nine digits); empty: unset */
  readonly keys: readonly string[];
  /** herdr's actions: built or parity (with its reason); the screen's own mode keys and lock: "screen" */
  readonly status: "built" | "parity" | "screen";
  readonly reason: string | null;
}

/** Every row of the key table for the help overlay, in table order. */
export function helpRows(keymap: Keymap): HelpRow[] {
  return keymap.rows.map((row) => {
    const entry = Object.hasOwn(CATALOGUE_BY_ID, row.action) ? CATALOGUE_BY_ID[row.action as keyof typeof CATALOGUE_BY_ID] : undefined;
    return {
      mode: row.mode, action: row.action, keys: keysOf(row, null),
      status: entry?.status ?? "screen", reason: entry?.status === "parity" ? entry.reason : null,
    };
  });
}

/** The first REFUSALS_SHOWN refusals of the key config, their text cleaned, and how many more there are. */
export function shownRefusals(keymap: Keymap): { readonly shown: readonly HerdrKeyRefusal[]; readonly more: number } {
  const shown = keymap.refusals.slice(0, REFUSALS_SHOWN).map((refusal) => ({
    ...refusal, action: cleanConfigText(refusal.action), binding: cleanConfigText(refusal.binding), reason: cleanConfigText(refusal.reason),
    holder: refusal.holder === null ? null : cleanConfigText(refusal.holder),
  }));
  return { shown, more: keymap.refusals.length - shown.length };
}
