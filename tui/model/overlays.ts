/**
 * The overlay registry: each kind says how it is closed, what it points at, and what it does with the
 * input it owns. The reducer keeps one stack and gives every key, text, paste and click to its top.
 * A new overlay is one entry here and one variant of `Overlay`.
 */
import { parseHerdrBinding } from "../../shared/herdr-keys.ts";
import { TEXT_FIELD_MAX_CODE_POINTS, TEXT_FIELD_MAX_GRAPHEMES } from "./deadlines.ts";
import type { KeyInput, OverlayChoice, PasteInput, RunEffect, Seen, TextInput } from "./effects.ts";
import type { Target } from "./focus.ts";
import { charChords, chordId, keyChords } from "./keymap.ts";
import { chooseEntry, entryKey, indexOfEntry, labelled, type MenuEntry, movedCursor } from "./menu.ts";

interface MenuList { readonly entries: readonly MenuEntry[]; readonly cursor: number }

/** `fresh`: typing replaces the suggestion. Moving the cursor clears `fresh` without editing the name. */
export interface Field { readonly graphemes: readonly string[]; readonly cursor: number; readonly fresh: boolean; readonly edited: boolean; readonly original: string }

export type TextPurpose = "rename_workspace" | "rename_tab" | "rename_pane" | "new_tab";

export type Overlay =
  | { readonly kind: "help" }
  | { readonly kind: "text"; readonly purpose: TextPurpose; readonly target: Target; readonly field: Field }
  /** `seen`: the terminals the close ends, as the screen showed them when the dialog opened */
  | { readonly kind: "confirm"; readonly purpose: "close_workspace"; readonly target: Target; readonly seen: readonly Seen[] }
  | { readonly kind: "goto"; readonly field: Field }
  /** `presented` is null after a stale choice: input waits for an accepted menu frame, never queued. */
  | ({ readonly kind: "menu"; readonly presented: MenuList | null } & MenuList);

export type OverlayInput = { readonly kind: "key"; readonly event: KeyInput } | { readonly kind: "text"; readonly event: TextInput } | { readonly kind: "paste"; readonly event: PasteInput };

/** The overlay after the input (null: closed), what it asks of the caller, and what the reducer does once it closed. */
export interface OverlayAnswer { readonly overlay: Overlay | null; readonly effects: readonly RunEffect[]; readonly choice?: OverlayChoice }

interface OverlayEntry<O extends Overlay> {
  /** the keys that close it, in herdr's syntax, shown in its frame; never empty */
  readonly closeKeys: readonly [string, ...string[]];
  readonly target: (overlay: O) => Target | null;
  readonly input: (overlay: O, input: OverlayInput) => OverlayAnswer;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map(({ segment }) => segment);
}

/** How many code points `text` holds. */
function codePoints(text: string): number {
  let count = 0;
  for (let at = 0; at < text.length; at += text.codePointAt(at)! > 0xffff ? 2 : 1) count++;
  return count;
}

/** The first `count` code points of `text`. */
function firstCodePoints(text: string, count: number): string {
  let at = 0;
  for (let n = 0; n < count && at < text.length; n++) at += text.codePointAt(at)! > 0xffff ? 2 : 1;
  return text.slice(0, at);
}

export function field(text: string): Field {
  const all = graphemes(firstCodePoints(text, TEXT_FIELD_MAX_CODE_POINTS)).slice(0, TEXT_FIELD_MAX_GRAPHEMES);
  return { graphemes: all, cursor: all.length, fresh: all.length > 0, edited: false, original: text };
}

/** `text` typed or pasted at the cursor: line breaks, tabs and other control characters become spaces. */
function insert(current: Field, text: string): Field {
  const base = current.fresh ? { ...current, graphemes: [], cursor: 0 } : current;
  // segmented together with the grapheme before the cursor, so a mark or joiner that comes in a later read than its
  // base joins it, as when both came in one read
  const before = base.cursor > 0 ? base.graphemes[base.cursor - 1]! : "";
  const head = base.graphemes.slice(0, base.cursor - (before === "" ? 0 : 1));
  const tail = base.graphemes.slice(base.cursor);
  const room = TEXT_FIELD_MAX_GRAPHEMES - head.length - tail.length;
  // cut to the code-point budget before it is segmented: a grapheme that never ends (a letter and endless marks, read
  // apart or at once) costs no more than the budget, and the graphemes the field holds already stay whole; the code
  // points past it are refused, as when they are read one at a time (a text run reaches a field one code point at a time)
  const points = TEXT_FIELD_MAX_CODE_POINTS - codePoints(head.join("")) - codePoints(before) - codePoints(tail.join(""));
  const added = graphemes(before + firstCodePoints(text, Math.max(0, points)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")).slice(0, Math.max(0, room));
  if (!current.fresh && added.join("") === before) return current; // nothing fit
  return { ...base, graphemes: [...head, ...added, ...tail], cursor: head.length + added.length, fresh: false, edited: true };
}

function wordStart(chars: readonly string[], from: number): number {
  let at = from;
  while (at > 0 && /\s/.test(chars[at - 1]!)) at--;
  while (at > 0 && !/\s/.test(chars[at - 1]!)) at--;
  return at;
}

function wordEnd(chars: readonly string[], from: number): number {
  let at = from;
  while (at < chars.length && /\s/.test(chars[at]!)) at++;
  while (at < chars.length && !/\s/.test(chars[at]!)) at++;
  return at;
}

/** The single-line editor's keys (herdr's set): the field after the key, or null when the key is not one of them. */
function edit(current: Field, event: KeyInput): Field | null {
  const { mods } = event;
  const ctrl = Boolean(mods.ctrl) && !mods.alt && !mods.super;
  const alt = Boolean(mods.alt) && !mods.ctrl && !mods.super;
  const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
  const chars = current.graphemes;
  const at = current.cursor;
  const moved = (cursor: number): Field => ({ ...current, cursor: Math.max(0, Math.min(chars.length, cursor)), fresh: false });
  const cut = (from: number, to: number, cursor: number): Field => from >= Math.min(to, chars.length) ? moved(cursor)
    : { ...current, graphemes: [...chars.slice(0, from), ...chars.slice(to)], cursor, fresh: false, edited: true };
  if (event.key === "ARROW_LEFT" || (ctrl && letter === "b")) return moved(at - 1);
  if (event.key === "ARROW_RIGHT" || (ctrl && letter === "f")) return moved(at + 1);
  if (event.key === "HOME" || (ctrl && letter === "a")) return moved(0);
  if (event.key === "END" || (ctrl && letter === "e")) return moved(chars.length);
  if (alt && letter === "b") return moved(wordStart(chars, at));
  if (alt && letter === "f") return moved(wordEnd(chars, at));
  if (event.key === "BACKSPACE" || (ctrl && letter === "h")) return at === 0 ? moved(at) : cut(at - 1, at, at - 1);
  if (event.key === "DELETE" || (ctrl && letter === "d")) return cut(at, at + 1, at);
  if (ctrl && letter === "u") return cut(0, at, 0);
  if (ctrl && letter === "k") return cut(at, chars.length, at);
  if (ctrl && letter === "w") return cut(wordStart(chars, at), at, wordStart(chars, at));
  if (alt && letter === "d") return cut(at, wordEnd(chars, at), at);
  if (ctrl && letter === "c") return cut(0, chars.length, 0);
  return null;
}

const closeIds = (keys: readonly string[]) => new Set(keys.map((key) => chordId(parseHerdrBinding(key)!.chord)));

/** The chords of a key, or of a text's first character; a paste has none. */
function inputChords(input: OverlayInput) {
  if (input.kind === "paste") return [];
  return input.kind === "key" ? keyChords(input.event) : charChords([...input.event.text][0] ?? "", false);
}

function closes(ids: ReadonlySet<string>, input: OverlayInput): boolean {
  return inputChords(input).some((chord) => ids.has(chordId(chord)));
}

export const isEnter = (input: OverlayInput) => input.kind === "key" && (input.event.key === "ENTER" || input.event.key === "NUMPAD_ENTER") && Object.keys(input.event.mods).length === 0;

export function editField(current: Field, input: OverlayInput): Field {
  if (input.kind !== "key") return insert(current, input.event.text);
  const next = edit(current, input.event);
  if (next !== null) return next;
  const typed = input.event.text;
  return typed !== undefined && !input.event.mods.alt ? insert(current, typed) : current;
}

/** A field's answer to one input: accept with Enter, else edit. */
function fieldInput<O extends Extract<Overlay, { field: Field }>>(overlay: O, input: OverlayInput, accept: (text: string) => OverlayAnswer): OverlayAnswer {
  if (isEnter(input)) return accept(overlay.field.graphemes.join(""));
  const next = editField(overlay.field, input);
  return { overlay: next === overlay.field ? overlay : { ...overlay, field: next }, effects: [] };
}

const run = (action: RunEffect["action"], target: Target | null, name: string | null): RunEffect => ({ type: "run", action, target, index: null, name });

/** Choose a presented identity: move the cursor, close with its choice, or refuse it without retargeting. */
export function menuChoice(overlay: Extract<Overlay, { kind: "menu" }>, entry: string | null): OverlayAnswer & { readonly accepted: boolean } {
  const at = overlay.entries.findIndex((candidate) => entryKey(candidate) === entry);
  const chosen = overlay.presented === null ? null : chooseEntry(overlay.entries, at);
  if (chosen === null || overlay.presented === null) return { overlay: { ...overlay, presented: null }, effects: [], accepted: false };
  if (!("cursor" in chosen)) return { overlay: null, effects: [], choice: chosen.choice, accepted: true };
  const cursor = indexOfEntry(overlay.presented.entries, overlay.entries[chosen.cursor]!);
  return { overlay: { ...overlay, cursor: chosen.cursor, presented: { ...overlay.presented, cursor } }, effects: [], accepted: true };
}

export const OVERLAYS: { readonly [K in Overlay["kind"]]: OverlayEntry<Extract<Overlay, { kind: K }>> } = {
  help: {
    closeKeys: ["esc", "q", "?"],
    target: () => null,
    input: (overlay) => ({ overlay, effects: [] }),
  },
  text: {
    closeKeys: ["esc"],
    target: (overlay) => overlay.target,
    input: (overlay, input) => fieldInput(overlay, input, (name) => {
      if (overlay.purpose === "new_tab") return { overlay: null, effects: [run("new_tab", overlay.target, name)] };
      // herdr sends a rename only when the name changed; a name past the field's bounds shows cut, and that cut value
      // accepted as shown is no change either: Enter never shortens a name nobody edited
      const unchanged = !overlay.field.edited || name === overlay.field.original;
      return { overlay: null, effects: unchanged ? [] : [run(overlay.purpose, overlay.target, name)] };
    }),
  },
  confirm: {
    closeKeys: ["esc", "n"],
    target: (overlay) => overlay.target,
    input: (overlay, input) => {
      const yes = isEnter(input) || inputChords(input).some((chord) => chord.key === "y" && !chord.ctrl && !chord.alt && !chord.meta);
      return yes ? { overlay: null, effects: [{ ...run(overlay.purpose, overlay.target, null), seen: overlay.seen }] } : { overlay, effects: [] };
    },
  },
  goto: {
    closeKeys: ["esc"],
    target: () => null,
    input: (overlay, input) => fieldInput(overlay, input, (query) => ({ overlay: null, effects: [run("goto", null, query)] })),
  },
  menu: {
    closeKeys: ["esc"],
    target: () => null,
    input: (overlay, input) => {
      const presented = overlay.presented;
      if (presented === null) return { overlay, effects: [] };
      const current = (at: number) => {
        const shown = presented.entries[at];
        return shown === undefined ? -1 : indexOfEntry(overlay.entries, shown);
      };
      const choose = (at: number) => {
        const entry = presented.entries[at];
        return menuChoice(overlay, entry === undefined ? null : entryKey(entry));
      };
      if (isEnter(input)) return choose(presented.cursor);
      if (input.kind === "key") {
        const cursor = movedCursor(presented.entries, presented.cursor, input.event);
        if (cursor !== null) {
          const next = current(cursor);
          return { overlay: { ...overlay, cursor: next < 0 ? overlay.cursor : next, presented: { ...presented, cursor } }, effects: [] };
        }
      }
      // a label is one character typed as it is: under an input method a letter arrives composed and chooses nothing
      const typed = input.kind === "paste" || (input.kind === "key" && (input.event.mods.alt || input.event.mods.ctrl)) ? "" : input.event.text ?? "";
      const at = labelled(presented.entries, [...typed][0] ?? "");
      return at < 0 ? { overlay, effects: [] } : choose(at);
    },
  },
};

/** Each kind's declared close keys: the one way a key or a typed character closes an overlay. */
const CLOSE_IDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries(OVERLAYS).map(([kind, entry]) => [kind, closeIds(entry.closeKeys)]));

export function overlayTarget(overlay: Overlay): Target | null {
  return (OVERLAYS[overlay.kind] as OverlayEntry<Overlay>).target(overlay);
}

export function overlayInput(overlay: Overlay, input: OverlayInput): OverlayAnswer {
  if (closes(CLOSE_IDS.get(overlay.kind)!, input)) return { overlay: null, effects: [] };
  return (OVERLAYS[overlay.kind] as OverlayEntry<Overlay>).input(overlay, input);
}
