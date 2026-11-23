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
import { type ContextAction, contextCursor } from "./context.ts";
import { MENU_ENTRIES, movedCursor } from "./menu.ts";
import { type SwitcherEntry, switcherChoice } from "./switcher.ts";
import { chosenAt, chosenHeading, type Place, pickerMatches, pickerRows, placeTarget, workspaceStep } from "./picker.ts";

/** A one-line text field of graphemes, the cursor after the text it opened with; `original` that text; `edited`: a key changed the text since. */
export interface Field { readonly graphemes: readonly string[]; readonly cursor: number; readonly edited: boolean; readonly original: string }

export type TextPurpose = "rename_workspace" | "rename_tab" | "rename_pane" | "new_tab";

export type Overlay =
  /**
   * the help (help.ts): the first line it shows, the page keys not yet turned into lines (the reducer knows the window's
   * height and keeps `scroll` in range), its filter, and whether keys go to the filter now
   */
  | { readonly kind: "help"; readonly scroll: number; readonly paged: number; readonly filter: Field; readonly filtering: boolean }
  | { readonly kind: "text"; readonly purpose: TextPurpose; readonly target: Target; readonly field: Field }
  /**
   * `seen`: the terminals the close ends, as the screen showed them when the dialog opened; `close_group` closes a
   * repository's workspace and the worktree workspaces under it (`spaces`: how many)
   */
  | { readonly kind: "confirm"; readonly purpose: "close_workspace" | "close_group"; readonly target: Target; readonly seen: readonly Seen[]; readonly spaces?: number }
  /**
   * a right-click menu (context.ts): what it is for, its entries, the chosen one, and the cell it was opened at; `epoch`
   * the core line it was opened on and `created` when the core made its pane's terminal, so another terminal at that
   * address later is told apart
   */
  | { readonly kind: "context"; readonly target: Target; readonly entries: readonly ContextAction[]; readonly cursor: number; readonly at: { readonly x: number; readonly y: number }; readonly epoch: number; readonly created?: number }
  /** herdr's Open worktree...: a repository's checkouts (its workspace is `target`), a filter, the chosen one */
  | { readonly kind: "worktrees"; readonly target: Target; readonly checkouts: readonly CheckoutRow[]; readonly field: Field; readonly searching: boolean; readonly cursor: number }
  /**
   * the picker: the terminals it lists, its search, whether keys go to the search now, and the chosen row (picker.ts
   * `pickerRows`; null: the first terminal). `unshown`: the world took the chosen row, and the row standing in for it has
   * been in no frame yet: Enter and the keys that move from it wait until one shows it (reduce.ts `pickerShown`)
   */
  | { readonly kind: "goto"; readonly field: Field; readonly searching: boolean; readonly places: readonly Place[]; readonly chosen: string | null; readonly unshown?: true }
  /** herdr's menu (menu.ts `MENU_ENTRIES`); `cursor`: the index of the entry Enter chooses */
  | { readonly kind: "menu"; readonly cursor: number }
  /** herdr's switcher on a narrow screen (switcher.ts): the cursor over its entries, the world's places when it was last given them */
  | { readonly kind: "switcher"; readonly cursor: number; readonly entries: readonly SwitcherEntry[] };

/** A checkout of a repository as Open worktree... lists it: its folder, its name (the branch's) and the workspace showing it. */
export interface CheckoutRow { readonly path: string; readonly label: string; readonly open: string | null }

export type OverlayInput = { readonly kind: "key"; readonly event: KeyInput } | { readonly kind: "text"; readonly event: TextInput } | { readonly kind: "paste"; readonly event: PasteInput };

/** The overlay after the input (null: closed), what it asks of the caller, and what the reducer does once it closed. */
export interface OverlayAnswer {
  readonly overlay: Overlay | null;
  readonly effects: readonly RunEffect[];
  readonly choice?: OverlayChoice;
  /** an overlay opened on top of this one */
  readonly open?: Overlay;
}

interface OverlayEntry<O extends Overlay> {
  /** the keys that close it, in herdr's syntax, shown in its frame; never empty */
  readonly closeKeys: readonly [string, ...string[]];
  /** while true every key is the overlay's own, its close keys too (a field being typed in) */
  readonly typing?: (overlay: O) => boolean;
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
  return { graphemes: all, cursor: all.length, edited: false, original: text };
}

/** `text` typed or pasted at the cursor: line breaks, tabs and other control characters become spaces. */
function insert(current: Field, text: string): Field {
  // segmented together with the grapheme before the cursor, so a mark or joiner that comes in a later read than its
  // base joins it, as when both came in one read
  const before = current.cursor > 0 ? current.graphemes[current.cursor - 1]! : "";
  const head = current.graphemes.slice(0, current.cursor - (before === "" ? 0 : 1));
  const tail = current.graphemes.slice(current.cursor);
  const room = TEXT_FIELD_MAX_GRAPHEMES - head.length - tail.length;
  // cut to the code-point budget before it is segmented: a grapheme that never ends (a letter and endless marks, read
  // apart or at once) costs no more than the budget, and the graphemes the field holds already stay whole; the code
  // points past it are refused, as when they are read one at a time (a text run reaches a field one code point at a time)
  const points = TEXT_FIELD_MAX_CODE_POINTS - codePoints(head.join("")) - codePoints(before) - codePoints(tail.join(""));
  const added = graphemes(before + firstCodePoints(text, Math.max(0, points)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")).slice(0, Math.max(0, room));
  if (added.join("") === before) return current; // nothing fit
  return { ...current, graphemes: [...head, ...added, ...tail], cursor: head.length + added.length, edited: true };
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
  const moved = (cursor: number): Field => ({ ...current, cursor: Math.max(0, Math.min(chars.length, cursor)) });
  const cut = (from: number, to: number, cursor: number): Field => from >= Math.min(to, chars.length) ? moved(cursor)
    : { ...current, graphemes: [...chars.slice(0, from), ...chars.slice(to)], cursor, edited: true };
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

type Picker = Extract<Overlay, { kind: "goto" }>;

/** The picker's matches for what is searched now, in their order. */
export function pickerList(overlay: Picker): Place[] {
  return pickerMatches(overlay.places, overlay.field.graphemes.join(""));
}

/** The picker with `chosen` as the user's own choice (a key, the pointer, a search): that row is theirs, whatever stood in before. */
export function pickerChosen({ unshown: _stoodIn, ...picker }: Picker, chosen: string | null): Picker {
  return { ...picker, chosen };
}

/** The row the picker shows chosen: the kept one, else the first terminal; null when nothing matches. */
export function pickerShownChoice(overlay: Picker): string | null {
  return overlay.chosen ?? pickerList(overlay)[0]?.id ?? null;
}

/** The picker's answer to choosing its match `at`: closed, with focus moving there; kept open when there is no such match. */
export function pickerChoice(overlay: Picker, at: number): OverlayAnswer {
  const place = pickerList(overlay)[at];
  return place === undefined ? { overlay, effects: [] } : { overlay: null, effects: [], choice: { kind: "select", target: placeTarget(place) } };
}

/**
 * The picker's answer to one input: Enter opens the chosen terminal; the arrows, j and k move the choice a row, left and
 * right to the next workspace's first terminal; `/` starts the search, which takes the typing until Enter keeps it or
 * Escape drops it.
 */
function pickerInput(overlay: Picker, input: OverlayInput): OverlayAnswer {
  const matches = pickerList(overlay);
  const at = chosenAt(matches, overlay.chosen);
  if (overlay.searching) {
    if (isEnter(input)) return { overlay: { ...overlay, searching: false }, effects: [] };
    if (input.kind === "key" && input.event.key === "ESCAPE" && Object.keys(input.event.mods).length === 0) return { overlay: { ...pickerChosen(overlay, null), searching: false, field: field("") }, effects: [] };
    const next = editField(overlay.field, input);
    return { overlay: next === overlay.field ? overlay : { ...pickerChosen(overlay, null), field: next }, effects: [] };
  }
  const chord = inputChords(input).find((one) => !one.ctrl && !one.alt && !one.meta);
  if (chord?.key === "/") {
    const rest = input.kind === "text" ? input.event.text.slice(1) : "";
    return { overlay: { ...(rest === "" ? overlay : { ...pickerChosen(overlay, null), field: editField(overlay.field, { kind: "text", event: { ...input.event, text: rest } as TextInput }) }), searching: true }, effects: [] };
  }
  // the row shown chosen is not the one in the frame a person last saw: nothing acts on it until a frame shows it
  if (overlay.unshown) return { overlay, effects: [] };
  const heading = chosenHeading(overlay.chosen);
  // a heading the pointer chose: Enter goes to that workspace, a key moves on from its first terminal
  if (heading !== null && isEnter(input)) return { overlay: null, effects: [], choice: { kind: "select", target: { kind: "workspace", id: heading } } };
  if (isEnter(input)) return pickerChoice(overlay, at);
  const key = input.kind === "key" && Object.keys(input.event.mods).length === 0 ? input.event.key : "";
  const row = key === "ARROW_DOWN" || chord?.key === "j" ? 1 : key === "ARROW_UP" || chord?.key === "k" ? -1 : 0;
  const side = key === "ARROW_RIGHT" ? 1 : key === "ARROW_LEFT" ? -1 : 0;
  if (row !== 0) {
    // as herdr's: the rows are each workspace's heading then its terminals, and the arrows visit every one of them
    const rows = pickerRows(matches);
    const here = rows.indexOf(heading !== null ? `heading:${heading}` : matches[at]?.id ?? "");
    // herdr's stop at both ends
    const next = here + row;
    if (here < 0 || next < 0 || next >= rows.length) return { overlay, effects: [] };
    return { overlay: pickerChosen(overlay, rows[next]!), effects: [] };
  }
  // left and right: the previous or next workspace's first terminal, from its heading as from its terminals; none past the ends
  const from = heading !== null ? matches.findIndex((place) => place.workspace === heading) : at;
  if (from < 0 || side === 0) return { overlay, effects: [] };
  const next = workspaceStep(matches, from, side);
  return next < 0 ? { overlay, effects: [] } : { overlay: pickerChosen(overlay, matches[next]!.id), effects: [] };
}

/** The switcher's answer to choosing entry `at`: closed, going there or running it. */
export function switcherPick(overlay: Extract<Overlay, { kind: "switcher" }>, at: number): OverlayAnswer {
  const entry = overlay.entries[at];
  return entry === undefined ? { overlay, effects: [] } : { overlay: null, effects: [], choice: switcherChoice(entry) };
}

type Help = Extract<Overlay, { kind: "help" }>;

/** The help as it opens: its first line, no filter. */
export const HELP_OPEN: Help = { kind: "help", scroll: 0, paged: 0, filter: field(""), filtering: false };

/**
 * The help's keys: `/` starts its filter, which takes every key until Enter keeps it or Escape drops it; otherwise the
 * arrows and j and k move it a row, page up and down a page each.
 */
function helpInput(overlay: Help, input: OverlayInput): OverlayAnswer {
  if (overlay.filtering) {
    if (isEnter(input)) return { overlay: { ...overlay, filtering: false }, effects: [] };
    if (input.kind === "key" && input.event.key === "ESCAPE" && Object.keys(input.event.mods).length === 0) return { overlay: { ...HELP_OPEN }, effects: [] };
    const filter = editField(overlay.filter, input);
    return { overlay: filter === overlay.filter ? overlay : { ...overlay, filter, scroll: 0 }, effects: [] };
  }
  const chord = inputChords(input).find((one) => !one.ctrl && !one.alt && !one.meta);
  if (chord?.key === "/") {
    // text read with the slash in one go is the filter's
    const rest = input.kind === "text" ? input.event.text.slice(1) : "";
    return { overlay: { ...overlay, filtering: true, ...(rest === "" ? {} : { filter: editField(overlay.filter, { kind: "text", event: { ...input.event, text: rest } as TextInput }), scroll: 0 }) }, effects: [] };
  }
  const key = input.kind === "key" && Object.keys(input.event.mods).length === 0 ? input.event.key : "";
  const step = key === "ARROW_DOWN" || chord?.key === "j" ? 1 : key === "ARROW_UP" || chord?.key === "k" ? -1 : 0;
  const page = key === "PAGE_DOWN" ? 1 : key === "PAGE_UP" ? -1 : 0;
  return { overlay: step === 0 && page === 0 ? overlay : { ...overlay, scroll: overlay.scroll + step, paged: overlay.paged + page }, effects: [] };
}

/** A right-click menu's answer to choosing entry `at`: closed, with that entry to do on its target. */
export function contextChoice(overlay: Extract<Overlay, { kind: "context" }>, at: number): OverlayAnswer {
  const action = overlay.entries[at];
  return action === undefined ? { overlay, effects: [] } : { overlay: null, effects: [], choice: { kind: "context", action, target: overlay.target } };
}

type Worktrees = Extract<Overlay, { kind: "worktrees" }>;

/** Open worktree...'s checkouts matching its filter (by name or folder, any case), in their order. */
export function worktreeList(overlay: Worktrees): CheckoutRow[] {
  const filter = overlay.field.graphemes.join("").toLowerCase();
  return filter === "" ? [...overlay.checkouts] : overlay.checkouts.filter((row) => row.label.toLowerCase().includes(filter) || row.path.toLowerCase().includes(filter));
}

/** Open worktree...'s answer to choosing its row `at`: closed, opening that checkout (or going to the workspace showing it). */
export function worktreeChoice(overlay: Worktrees, at: number): OverlayAnswer {
  const row = worktreeList(overlay)[at];
  return row === undefined ? { overlay, effects: [] } : { overlay: null, effects: [], choice: { kind: "checkout", target: overlay.target, path: row.path, open: row.open } };
}

/** Open worktree...'s keys: the arrows move the choice, Enter opens it, `/` starts the filter (Enter keeps it, Escape drops it). */
function worktreesInput(overlay: Worktrees, input: OverlayInput): OverlayAnswer {
  if (overlay.searching) {
    if (isEnter(input)) return { overlay: { ...overlay, searching: false }, effects: [] };
    if (input.kind === "key" && input.event.key === "ESCAPE" && Object.keys(input.event.mods).length === 0) return { overlay: { ...overlay, searching: false, field: field(""), cursor: 0 }, effects: [] };
    const next = editField(overlay.field, input);
    return { overlay: next === overlay.field ? overlay : { ...overlay, field: next, cursor: 0 }, effects: [] };
  }
  if (isEnter(input)) return worktreeChoice(overlay, overlay.cursor);
  const chord = inputChords(input).find((one) => !one.ctrl && !one.alt && !one.meta);
  if (chord?.key === "/") return { overlay: { ...overlay, searching: true }, effects: [] };
  const key = input.kind === "key" && Object.keys(input.event.mods).length === 0 ? input.event.key : "";
  const cursor = contextCursor(worktreeList(overlay).length, overlay.cursor, key);
  return { overlay: cursor === null || cursor < 0 ? overlay : { ...overlay, cursor }, effects: [] };
}

/** The menu's answer to choosing entry `at`: closed, with that entry's action to run. */
export function menuChoice(overlay: Extract<Overlay, { kind: "menu" }>, at: number): OverlayAnswer {
  const action = MENU_ENTRIES[at];
  return action === undefined ? { overlay, effects: [] } : { overlay: null, effects: [], choice: { kind: "action", action } };
}

export const OVERLAYS: { readonly [K in Overlay["kind"]]: OverlayEntry<Extract<Overlay, { kind: K }>> } = {
  help: {
    closeKeys: ["esc", "enter"],
    typing: (overlay) => overlay.filtering,
    target: () => null,
    input: helpInput,
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
  context: {
    closeKeys: ["esc"],
    target: (overlay) => overlay.target,
    input: (overlay, input) => {
      if (isEnter(input)) return contextChoice(overlay, overlay.cursor);
      const cursor = input.kind === "key" && Object.keys(input.event.mods).length === 0 ? contextCursor(overlay.entries.length, overlay.cursor, input.event.key) : null;
      return { overlay: cursor === null ? overlay : { ...overlay, cursor }, effects: [] };
    },
  },
  worktrees: {
    closeKeys: ["esc"],
    typing: (overlay) => overlay.searching,
    target: (overlay) => overlay.target,
    input: worktreesInput,
  },
  goto: {
    closeKeys: ["esc"],
    typing: (overlay) => overlay.searching,
    target: () => null,
    input: pickerInput,
  },
  menu: {
    closeKeys: ["esc"],
    target: () => null,
    input: (overlay, input) => {
      if (isEnter(input)) return menuChoice(overlay, overlay.cursor);
      const cursor = input.kind === "key" ? movedCursor(MENU_ENTRIES, overlay.cursor, input.event) : null;
      return { overlay: cursor === null ? overlay : { ...overlay, cursor }, effects: [] };
    },
  },
  switcher: {
    closeKeys: ["esc"],
    target: () => null,
    input: (overlay, input) => {
      if (isEnter(input)) return switcherPick(overlay, overlay.cursor);
      const cursor = input.kind === "key" ? movedCursor(overlay.entries, overlay.cursor, input.event) : null;
      return { overlay: cursor === null ? overlay : { ...overlay, cursor }, effects: [] };
    },
  },
};

/** Each kind's declared close keys: the one way a key or a typed character closes an overlay. */
const CLOSE_IDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries(OVERLAYS).map(([kind, entry]) => [kind, closeIds(entry.closeKeys)]));

export function overlayTarget(overlay: Overlay): Target | null {
  return (OVERLAYS[overlay.kind] as OverlayEntry<Overlay>).target(overlay);
}

export function overlayInput(overlay: Overlay, input: OverlayInput): OverlayAnswer {
  const entry = OVERLAYS[overlay.kind] as OverlayEntry<Overlay>;
  if (!entry.typing?.(overlay) && closes(CLOSE_IDS.get(overlay.kind)!, input)) return { overlay: null, effects: [] };
  return (OVERLAYS[overlay.kind] as OverlayEntry<Overlay>).input(overlay, input);
}
