/**
 * What the mode bar and the help show, read from the one key table. Config text (a binding or a reason as
 * the user wrote it) is cleaned and clamped here, so the view draws it as given.
 */
import type { HerdrKeyRefusal } from "../../shared/herdr-keys.ts";
import { CATALOGUE_BY_ID } from "./catalogue.ts";
import { CONFIG_TEXT_MAX_CHARS, REFUSALS_SHOWN } from "./deadlines.ts";
import type { KeyAction, Keymap, KeyRow, Mode } from "./keymap.ts";
import type { ModelState } from "./reduce.ts";

export interface Hint { readonly action: KeyAction | "prefix"; readonly keys: readonly string[] }
export interface ModeBar { readonly mode: Mode | "prefix" | "locked"; readonly hints: readonly Hint[] }

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

function hints(rows: readonly KeyRow[], prefixed: boolean | null): Hint[] {
  return rows.flatMap((row) => {
    const keys = keysOf(row, prefixed);
    return keys.length === 0 ? [] : [{ action: row.action, keys }];
  });
}

/**
 * The keys of the current mode: after the prefix while it is armed, the unlock chord while locked, the mode's own keys
 * otherwise. In Terminal mode: the prefix, the menu (which reaches every action), then the help.
 */
export function modeBar(state: ModelState): ModeBar {
  const { rows } = state.keymap;
  if (state.locked) return { mode: "locked", hints: hints(rows.filter((row) => row.action === "lock"), null) };
  if (state.armed) return { mode: "prefix", hints: hints(rows.filter((row) => row.mode === "terminal"), true) };
  if (state.mode.name !== "terminal") {
    const mode = state.mode.name;
    return { mode, hints: hints(rows.filter((row) => row.mode === mode), null) };
  }
  return {
    mode: "terminal",
    hints: [
      { action: "prefix", keys: state.keymap.prefixes.map((prefix) => cleanConfigText(prefix.text)) },
      ...hints(rows.filter((row) => row.action === "menu"), null),
      ...hints(rows.filter((row) => row.action === "help"), null),
    ],
  };
}

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
