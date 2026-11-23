/**
 * The screen's one state value and `reduce(state, event)`, which answers the next state and the effects
 * as data. It performs nothing and reads no clock: time is the `at` of each event.
 *
 * Input goes down a ladder of seven levels; the first that takes an event ends it:
 * 0 host (replies, unknown sequences, host focus, resize), 1 lock, 2 overlay, 3 mode (Navigate, Resize,
 * Copy), 4 direct bindings, 5 prefix, 6 the focused pane. Text and keys reach a pane only at level 6.
 * At levels 3 to 5 a text run is taken one code point at a time and the rest runs the ladder again.
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";
import type { InputEvent } from "../input/decode.ts";
import { CATALOGUE_BY_ID } from "./catalogue.ts";
import { clearDeadline, type Deadlines, NO_DEADLINES, NOTICE_SHOW_MS, NOTICES_KEPT, setDeadline } from "./deadlines.ts";
import type { Effect, KeyInput, MouseInput, PaneInput, PasteInput, Seen, TextInput } from "./effects.ts";
import { EMPTY_WORLD, exists, type Focus, focused, focusOn, NO_FOCUS, nextFocus, type PaneNode, type Target, type World } from "./focus.ts";
import { boundIn, buildKeymap, charChords, isPrefix, type KeyAction, type Keymap, keyChords, unlockChords } from "./keymap.ts";
import { field, type Overlay, overlayInput, type OverlayInput, overlayTarget } from "./overlays.ts";

export type ModeState =
  | { readonly name: "terminal" }
  /** `preview`: the workspace navigate mode points at, moved locally until Enter */
  | { readonly name: "navigate"; readonly preview: string | null }
  | { readonly name: "resize" }
  | { readonly name: "copy" };

/**
 * A notice on screen: `code` is the stable value tests and code read; `data` its details; it leaves at `until`.
 * `calm`: it reports how things are (nothing changed, someone else changed it first), not a failure.
 */
export interface Notice { readonly id: number; readonly code: string; readonly data: Readonly<Record<string, string | number>>; readonly until: number; readonly calm?: true }

/** What focus waits to move to once the world shows it: a new pane, or a moved one once it is no longer in tab `away`. */
export interface Following { readonly target: Target; readonly away: string | null }

export interface ModelState {
  readonly mode: ModeState;
  readonly locked: boolean;
  /** the prefix machine: Armed (true) or Idle; it waits without a deadline until a row of its table ends it */
  readonly armed: boolean;
  readonly overlays: readonly Overlay[];
  readonly world: World;
  readonly focus: Focus;
  readonly keymap: Keymap;
  readonly notices: readonly Notice[];
  readonly nextNotice: number;
  /** `notice` while a notice shows */
  readonly deadlines: Deadlines;
  readonly host: { readonly cols: number; readonly rows: number; readonly focused: boolean | null };
  readonly sidebarCollapsed: boolean;
  readonly following: Following | null;
}

/** Events that do not come from host input: the loop and the other modules send them. */
export type ScreenEvent =
  | { readonly type: "resize"; readonly cols: number; readonly rows: number; readonly at: number }
  /** what exists now; focus, overlays and the navigate preview follow */
  | { readonly type: "world"; readonly world: World; readonly at: number }
  /** herdr's `[keys]` table as parsed (anything else: the defaults), read again by main.ts */
  | { readonly type: "keys"; readonly keys: unknown; readonly at: number }
  /** a deadline the state named came due */
  | { readonly type: "deadline"; readonly name: string; readonly at: number }
  /** an action chosen without a key (a menu entry, a click) */
  | { readonly type: "action"; readonly action: KeyAction; readonly index?: number; readonly at: number }
  /** focus a workspace, tab or pane (a click, or the neighbour a directional focus found) */
  | { readonly type: "select"; readonly target: Target; readonly at: number }
  /** the top overlay's close control was clicked: it closes as its close keys close it */
  | { readonly type: "close_overlay"; readonly at: number }
  /** a notice from elsewhere (a failed layout write); `calm` for one that reports no failure */
  | { readonly type: "notice"; readonly code: string; readonly data?: Readonly<Record<string, string | number>>; readonly calm?: boolean; readonly at: number }
  /** focus the target once the world shows it (outside tab `away`): what a layout write made or moved; any other focus move drops it */
  | { readonly type: "follow"; readonly target: Target; readonly away: string | null; readonly at: number }
  /**
   * Input taken without running what it chose (a layout action refused as busy when it was read) or that went nowhere
   * (input dropped behind a write): an armed prefix returns to Idle, and, as that input left them, the top overlay
   * closes (`overlay`) and the mode returns to Terminal (`mode`). Nothing else happens: those keys meet no other layout.
   */
  | { readonly type: "consumed"; readonly overlay: boolean; readonly mode: boolean; readonly at: number };

export type ModelEvent = InputEvent | ScreenEvent;

export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The next state, the effects in order, and the ladder levels that took the event (a split text run: one per part). */
export interface Step {
  readonly state: ModelState;
  readonly effects: readonly Effect[];
  readonly levels: readonly Level[];
  /** Where the character that chose an external action began, in the read and in the input ladder. */
  readonly textAction?: { readonly offset: number; readonly before: ModelState };
}

export function initialState(keys: unknown): ModelState {
  return {
    mode: { name: "terminal" }, locked: false, armed: false, overlays: [], world: EMPTY_WORLD, focus: NO_FOCUS, keymap: buildKeymap(keys),
    notices: [], nextNotice: 0, deadlines: NO_DEADLINES, host: { cols: 0, rows: 0, focused: null }, sidebarCollapsed: false, following: null,
  };
}

/** The work in progress of one `reduce` call; only this call's own arrays are changed. */
interface Acc { s: ModelState; readonly effects: Effect[]; readonly levels: Level[] }

export function reduce(state: ModelState, event: ModelEvent): Step {
  const acc: Acc = { s: state, effects: [], levels: [] };
  switch (event.type) {
    case "reply":
      acc.levels.push(0);
      acc.effects.push({ type: "host_reply", kind: event.kind, data: event.data });
      break;
    case "unknown":
      acc.levels.push(0);
      break;
    case "focus":
      acc.levels.push(0);
      acc.s = { ...acc.s, host: { ...acc.s.host, focused: event.focused } };
      if (!event.focused) disarm(acc);
      break;
    case "resize": {
      acc.levels.push(0);
      const cols = Math.trunc(event.cols);
      const rows = Math.trunc(event.rows);
      // a size that is not a whole number of cells above zero (infinite, NaN, negative) is no size: it is ignored
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) acc.s = { ...acc.s, host: { ...acc.s.host, cols, rows } };
      break;
    }
    case "key":
      if (event.action === "release") acc.levels.push(0);
      else ladder(acc, { kind: "key", event });
      break;
    case "paste":
      if (event.complete) ladder(acc, { kind: "paste", event });
      else {
        acc.levels.push(0);
        notice(acc, "paste_refused", { length: event.text.length }, event.at);
      }
      break;
    case "text": {
      const textAction = ladderText(acc, event);
      if (textAction) return { textAction, state: acc.s, effects: acc.effects, levels: acc.levels };
      break;
    }
    case "mouse":
      mouse(acc, event);
      break;
    case "world":
      applyWorld(acc, event.world, event.at);
      break;
    case "keys":
      reload(acc, event.keys, event.at);
      break;
    case "deadline":
      fire(acc, event.name, event.at);
      break;
    case "action":
      if (acc.s.locked && event.action !== "lock") notice(acc, "locked", { action: event.action }, event.at);
      else runAction(acc, event.action, event.index ?? null, event.at);
      break;
    case "select":
      select(acc, event.target, event.at);
      break;
    case "close_overlay":
      if (acc.s.overlays.length > 0) acc.s = { ...acc.s, overlays: acc.s.overlays.slice(0, -1) };
      break;
    case "notice":
      notice(acc, event.code, event.data ?? {}, event.at, event.calm === true);
      break;
    case "follow":
      acc.s = { ...acc.s, following: { target: event.target, away: event.away } };
      follow(acc);
      break;
    case "consumed":
      disarm(acc);
      if (event.overlay && acc.s.overlays.length > 0) acc.s = { ...acc.s, overlays: acc.s.overlays.slice(0, -1) };
      if (event.mode && acc.s.mode.name !== "terminal") setMode(acc, { name: "terminal" });
      break;
    default:
      // an event of a kind the model does not know changes nothing
      break;
  }
  return { state: acc.s, effects: acc.effects, levels: acc.levels };
}

type Unit = { readonly kind: "key"; readonly event: KeyInput } | { readonly kind: "paste"; readonly event: PasteInput };


/** A key or a paste down the ladder. */
function ladder(acc: Acc, unit: Unit): void {
  const s = acc.s;
  const at = unit.event.at;
  const chords = unit.kind === "key" ? keyChords(unit.event) : [];
  if (s.locked) {
    if (unit.kind === "key" && boundIn(s.keymap.direct, chords)?.action === "lock") {
      acc.levels.push(1);
      acc.s = { ...s, locked: false };
      return;
    }
    toPane(acc, unit.event);
    return;
  }
  if (s.overlays.length > 0) {
    acc.levels.push(2);
    toOverlay(acc, unit);
    return;
  }
  if (s.mode.name !== "terminal") {
    acc.levels.push(3);
    const bound = boundIn(s.keymap.modeKeys[s.mode.name], chords);
    if (bound !== undefined) runAction(acc, bound.action, bound.index, at);
    return;
  }
  if (unit.kind === "paste") {
    // an armed prefix returns to Idle first; the paste then goes to the pane
    disarm(acc);
    toPane(acc, unit.event);
    return;
  }
  if (!s.armed) {
    const bound = boundIn(s.keymap.direct, chords);
    if (bound !== undefined) {
      acc.levels.push(4);
      runAction(acc, bound.action, bound.index, at);
      return;
    }
    if (isPrefix(s.keymap, chords)) {
      acc.levels.push(5);
      arm(acc);
      return;
    }
    toPane(acc, unit.event);
    return;
  }
  disarm(acc);
  if (isPrefix(s.keymap, chords)) {
    toPane(acc, unit.event);
    return;
  }
  acc.levels.push(5);
  // Escape and ctrl+[ hold no binding after the prefix (the key table drops one): they only return to Idle
  const bound = boundIn(s.keymap.afterPrefix, chords);
  if (bound !== undefined) runAction(acc, bound.action, bound.index, at);
  else if (unit.event.text !== undefined && HANGUL.test(unit.event.text)) notice(acc, "ime_prefix", {}, at);
}

const HANGUL = /\p{Script=Hangul}/u;

/** The first code point of `text` and the rest. */
function splitFirst(text: string): [string, string] {
  const first = String.fromCodePoint(text.codePointAt(0)!);
  return [first, text.slice(first.length)];
}

/** Where the first code point that is a prefix chord starts (only a printable prefix can be one), or -1. */
function prefixIndex(text: string, keymap: Keymap): number {
  let at = 0;
  for (const char of text) {
    if (isPrefix(keymap, charChords(char, false))) return at;
    at += char.length;
  }
  return -1;
}

/** A text run down the ladder: whole to the pane where nothing above takes a code point, else one code point at a time. */
function ladderText(acc: Acc, event: TextInput): Step["textAction"] {
  let rest = event.text;
  while (rest.length > 0) {
    const s = acc.s;
    const run: TextInput = rest === event.text ? event : { type: "text", text: rest, at: event.at };
    if (s.locked) {
      toPane(acc, run);
      return;
    }
    const [first, after] = splitFirst(rest);
    if (s.overlays.length > 0) {
      // one code point at a time, as reads that split the run would give them: a choice the overlay makes from one
      // (a digit, a letter) leaves the rest of the run to whatever is below once it closed, never dropped
      acc.levels.push(2);
      const from = acc.effects.length;
      toOverlay(acc, { kind: "text", event: { type: "text", text: first, at: event.at } });
      if (handBack(acc, from, after, event.at)) return { offset: event.text.length - rest.length, before: s };
      rest = after;
      continue;
    }
    if (s.mode.name !== "terminal") {
      acc.levels.push(3);
      const bound = boundIn(s.keymap.modeKeys[s.mode.name], charChords(first, false));
      const from = acc.effects.length;
      if (bound !== undefined) runAction(acc, bound.action, bound.index, event.at);
      if (handBack(acc, from, after, event.at)) return { offset: event.text.length - rest.length, before: s };
      rest = after;
      continue;
    }
    if (s.armed) {
      disarm(acc);
      const chords = charChords(first, false);
      if (isPrefix(s.keymap, chords)) toPane(acc, { type: "text", text: first, at: event.at });
      else {
        acc.levels.push(5);
        const bound = boundIn(s.keymap.afterPrefix, chords);
        const from = acc.effects.length;
        if (bound !== undefined) runAction(acc, bound.action, bound.index, event.at);
        else if (HANGUL.test(first)) notice(acc, "ime_prefix", {}, event.at);
        if (handBack(acc, from, after, event.at)) return { offset: event.text.length - rest.length, before: s };
      }
      rest = after;
      continue;
    }
    const at = prefixIndex(rest, s.keymap);
    if (at < 0) {
      toPane(acc, run);
      return;
    }
    if (at > 0) toPane(acc, { type: "text", text: rest.slice(0, at), at: event.at });
    acc.levels.push(5);
    arm(acc);
    rest = rest.slice(at + 1);
  }
}

/**
 * After an action the caller performs (a run effect, such as a directional focus), the rest of the text run waits
 * for it: it goes back to the caller as an `input` effect behind the run, and the caller dispatches it once the run
 * is performed, so it meets the focus the action left. One read then routes as the same bytes split across reads do.
 * After a detach the rest is dropped. True when the run handed the rest back or dropped it.
 */
function handBack(acc: Acc, from: number, rest: string, at: number): boolean {
  // nothing typed after a detach goes anywhere: the rest of the run ends with it, as a later read would
  if (acc.effects.slice(from).some((effect) => effect.type === "quit")) return true;
  if (!acc.effects.slice(from).some((effect) => effect.type === "run")) return false;
  if (rest.length > 0) acc.effects.push({ type: "input", event: { type: "text", text: rest, at } });
  return true;
}

/** Level 6: the focused pane gets this input, unless there is none or the key has no identity. */
function toPane(acc: Acc, input: PaneInput): void {
  acc.levels.push(6);
  const pane = focused(acc.s.world, acc.s.focus).pane;
  if (pane === null || (input.type === "key" && input.key === "UNIDENTIFIED")) return;
  acc.effects.push({ type: "pane", pane: pane.id, input });
}

function toOverlay(acc: Acc, input: OverlayInput): void {
  const { overlays } = acc.s;
  const answer = overlayInput(overlays[overlays.length - 1]!, input);
  acc.s = { ...acc.s, overlays: answer.overlay === null ? overlays.slice(0, -1) : [...overlays.slice(0, -1), answer.overlay] };
  acc.effects.push(...answer.effects);
}

function mouse(acc: Acc, event: MouseInput): void {
  if (event.action === "press") disarm(acc);
  const over = acc.s.overlays.length > 0 ? "overlay" : "screen";
  acc.levels.push(over === "overlay" ? 2 : 6);
  acc.effects.push({ type: "mouse", over, event });
}

function arm(acc: Acc): void {
  acc.s = { ...acc.s, armed: true };
}

function disarm(acc: Acc): void {
  if (acc.s.armed) acc.s = { ...acc.s, armed: false };
}

function sameData(a: Readonly<Record<string, string | number>>, b: Readonly<Record<string, string | number>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function noticeDeadline(deadlines: Deadlines, notices: readonly Notice[]): Deadlines {
  return notices.length === 0 ? clearDeadline(deadlines, "notice") : setDeadline(deadlines, "notice", Math.min(...notices.map((n) => n.until)));
}

/** Shows a notice; the same code with the same data replaces the older one instead of stacking. */
function notice(acc: Acc, code: string, data: Readonly<Record<string, string | number>>, at: number, calm = false): void {
  const s = acc.s;
  const shown: Notice = { id: s.nextNotice, code, data, until: at + NOTICE_SHOW_MS, ...(calm ? { calm: true } : {}) };
  const notices = [...s.notices.filter((n) => !(n.code === code && sameData(n.data, data))), shown].slice(-NOTICES_KEPT);
  acc.s = { ...s, notices, nextNotice: s.nextNotice + 1, deadlines: noticeDeadline(s.deadlines, notices) };
}

function fire(acc: Acc, name: string, at: number): void {
  const s = acc.s;
  const due = s.deadlines.get(name);
  if (due === undefined || due > at) return;
  if (name === "notice") {
    const notices = s.notices.filter((n) => n.until > at);
    acc.s = { ...s, notices, deadlines: noticeDeadline(s.deadlines, notices) };
  }
}

function reload(acc: Acc, keys: unknown, at: number): void {
  disarm(acc);
  const keymap = buildKeymap(keys);
  const unlocked = acc.s.locked && unlockChords(keymap).length === 0;
  acc.s = { ...acc.s, keymap, locked: acc.s.locked && !unlocked };
  if (unlocked) notice(acc, "unlocked", {}, at);
  if (!keymap.configRead) notice(acc, "keys_unread", {}, at);
  const count = keymap.refusals.length + keymap.notes.length;
  if (count > 0) notice(acc, "keys_refused", { count }, at);
}

function applyWorld(acc: Acc, world: World, at: number): void {
  const s = acc.s;
  const focus = nextFocus(s.world, world, s.focus);
  const gone = s.overlays.filter((overlay) => {
    const target = overlayTarget(overlay);
    return target !== null && !exists(world, target);
  });
  const mode: ModeState = s.mode.name === "navigate" && (s.mode.preview === null || !exists(world, { kind: "workspace", id: s.mode.preview }))
    ? { name: "navigate", preview: focus.workspace }
    : s.mode;
  acc.s = { ...s, world, focus, mode, overlays: s.overlays.filter((overlay) => !gone.includes(overlay)) };
  for (const overlay of gone) notice(acc, "target_gone", { overlay: overlay.kind }, at);
  follow(acc);
}

/** The id of the tab holding pane `id`, or null. */
function tabOfPane(world: World, id: string): string | null {
  for (const workspace of world.workspaces) for (const tab of workspace.tabs) if (tab.panes.some((pane) => pane.id === id)) return tab.id;
  return null;
}

/** Focus moves to what it follows once the world shows it there. */
function follow(acc: Acc): void {
  const { following, world } = acc.s;
  if (following === null || !exists(world, following.target)) return;
  if (following.away !== null && following.target.kind === "pane" && tabOfPane(world, following.target.id) === following.away) return;
  const focus = focusOn(world, acc.s.focus, following.target);
  acc.s = { ...acc.s, following: null, ...(focus === null ? {} : { focus }) };
}

function select(acc: Acc, target: Target, at: number): void {
  const focus = focusOn(acc.s.world, acc.s.focus, target);
  if (focus === null) notice(acc, "target_gone", { [target.kind]: target.id }, at);
  else acc.s = { ...acc.s, focus, following: null };
}

function setMode(acc: Acc, mode: ModeState): void {
  acc.s = { ...acc.s, mode };
}

function moveFocus(acc: Acc, target: Target | undefined): void {
  if (target === undefined) return;
  const focus = focusOn(acc.s.world, acc.s.focus, target);
  if (focus !== null) acc.s = { ...acc.s, focus, following: null };
}

/** The item `step` places from `id` in `list`, wrapping round. */
function around<T extends { readonly id: string }>(list: readonly T[], id: string | undefined, step: number): T | undefined {
  if (list.length === 0) return undefined;
  const at = list.findIndex((item) => item.id === id);
  return list[(((at < 0 ? 0 : at) + step) % list.length + list.length) % list.length];
}

const NAVIGATE_FOCUS: Readonly<Record<string, HerdrAction>> = {
  navigate_pane_left: "focus_pane_left", navigate_pane_down: "focus_pane_down", navigate_pane_up: "focus_pane_up", navigate_pane_right: "focus_pane_right",
};

/** The actions of the screen's own modes and its lock. */
function runLocal(acc: Acc, action: Exclude<KeyAction, HerdrAction>, index: number | null, at: number): void {
  const s = acc.s;
  const shown = focused(s.world, s.focus);
  switch (action) {
    case "lock":
      if (s.locked) acc.s = { ...s, locked: false };
      else if (unlockChords(s.keymap).length === 0) notice(acc, "lock_unbound", {}, at);
      else acc.s = { ...s, locked: true, overlays: [], mode: { name: "terminal" } };
      return;
    case "navigate_workspace_up":
    case "navigate_workspace_down": {
      if (s.mode.name !== "navigate") return;
      const next = around(s.world.workspaces, s.mode.preview ?? undefined, action === "navigate_workspace_up" ? -1 : 1);
      setMode(acc, { name: "navigate", preview: next?.id ?? null });
      return;
    }
    case "navigate_pane_left":
    case "navigate_pane_down":
    case "navigate_pane_up":
    case "navigate_pane_right":
      runHerdr(acc, NAVIGATE_FOCUS[action]!, null, at);
      return;
    case "navigate_focus":
      if (s.mode.name === "navigate" && s.mode.preview !== null) moveFocus(acc, { kind: "workspace", id: s.mode.preview });
      setMode(acc, { name: "terminal" });
      return;
    case "navigate_index": {
      const workspace = index === null ? undefined : s.world.workspaces[index - 1];
      if (workspace !== undefined) {
        moveFocus(acc, { kind: "workspace", id: workspace.id });
        setMode(acc, { name: "terminal" });
      }
      return;
    }
    case "navigate_cycle_next":
    case "navigate_cycle_previous":
      moveFocus(acc, target(around(shown.tab?.panes ?? [], shown.pane?.id, action === "navigate_cycle_next" ? 1 : -1), "pane"));
      return;
    case "navigate_move_up":
    case "navigate_move_down":
      if (s.mode.name === "navigate" && s.mode.preview !== null) acc.effects.push({ type: "run", action, target: { kind: "workspace", id: s.mode.preview }, index: null, name: null });
      return;
    case "navigate_move_pane": {
      if (s.mode.name !== "navigate" || s.mode.preview === null) return;
      if (shown.pane === null || shown.tab === null) {
        notice(acc, "nothing_focused", { action }, at);
        return;
      }
      // the new tab there takes the pane's name, else its tab's
      acc.effects.push({ type: "run", action, target: { kind: "pane", id: shown.pane.id }, index: null, name: shown.pane.name || shown.tab.name, to: s.mode.preview });
      setMode(acc, { name: "terminal" });
      return;
    }
    case "navigate_cancel":
    case "resize_leave":
    case "copy_leave":
      setMode(acc, { name: "terminal" });
      return;
    default: {
      const never: never = action;
      return never;
    }
  }
}

/** The terminals of `panes` as the screen shows them. */
function seenOf(panes: readonly PaneNode[]): Seen[] {
  return panes.map((pane) => ({ id: pane.id, created: pane.created ?? null }));
}

function target<T extends { readonly id: string }>(node: T | undefined | null, kind: Target["kind"]): Target | undefined {
  return node === undefined || node === null ? undefined : { kind, id: node.id };
}

function runAction(acc: Acc, action: KeyAction, index: number | null, at: number): void {
  disarm(acc);
  if (Object.hasOwn(CATALOGUE_BY_ID, action)) runHerdr(acc, action as HerdrAction, index, at);
  else runLocal(acc, action as Exclude<KeyAction, HerdrAction>, index, at);
}

/** One of herdr's actions: a parity one shows a notice naming it; a built one gives its effect. */
function runHerdr(acc: Acc, action: HerdrAction, index: number | null, at: number): void {
  const entry = CATALOGUE_BY_ID[action];
  if (entry.status === "parity") {
    notice(acc, "not_built", { action }, at);
    return;
  }
  const s = acc.s;
  const shown = focused(s.world, s.focus);
  const pushOverlay = (overlay: Overlay) => { acc.s = { ...acc.s, overlays: [...acc.s.overlays, overlay] }; };
  const runOn = (on: Target | undefined | null, name: string | null = null) => {
    if (on === undefined || on === null) notice(acc, "nothing_focused", { action }, at);
    else acc.effects.push({ type: "run", action, target: on, index, name });
  };
  switch (action) {
    case "help":
      pushOverlay({ kind: "help" });
      return;
    case "goto":
      pushOverlay({ kind: "goto", field: field("") });
      return;
    case "workspace_picker":
      setMode(acc, { name: "navigate", preview: shown.workspace?.id ?? null });
      return;
    case "copy_mode":
      if (shown.pane === null) notice(acc, "nothing_focused", { action }, at);
      else setMode(acc, { name: "copy" });
      return;
    case "resize_mode":
      if (shown.pane === null) notice(acc, "nothing_focused", { action }, at);
      else setMode(acc, { name: "resize" });
      return;
    case "detach":
      acc.effects.push({ type: "quit" });
      return;
    case "reload_config":
      acc.effects.push({ type: "reload_keys" });
      return;
    case "toggle_sidebar":
      acc.s = { ...s, sidebarCollapsed: !s.sidebarCollapsed };
      return;
    case "rename_workspace":
    case "rename_tab":
    case "rename_pane": {
      const node = action === "rename_workspace" ? shown.workspace : action === "rename_tab" ? shown.tab : shown.pane;
      const kind = action === "rename_workspace" ? "workspace" : action === "rename_tab" ? "tab" : "pane";
      if (node === null) notice(acc, "nothing_focused", { action }, at);
      else pushOverlay({ kind: "text", purpose: action, target: { kind, id: node.id }, field: field(node.name) });
      return;
    }
    case "new_tab":
      if (shown.workspace === null) notice(acc, "nothing_focused", { action }, at);
      else pushOverlay({ kind: "text", purpose: "new_tab", target: { kind: "workspace", id: shown.workspace.id }, field: field("") });
      return;
    case "close_workspace":
    case "close_tab":
    case "close_pane": {
      const workspace = shown.workspace;
      const node = action === "close_workspace" ? workspace : action === "close_tab" ? shown.tab : shown.pane;
      if (workspace === null || node === null) {
        notice(acc, "nothing_focused", { action }, at);
        return;
      }
      const all = workspace.tabs.flatMap((tab) => tab.panes);
      const ends = action === "close_pane" ? [shown.pane!] : action === "close_tab" ? shown.tab!.panes : all;
      // as herdr: only a close that ends the whole workspace asks first
      if (ends.length >= all.length) pushOverlay({ kind: "confirm", purpose: "close_workspace", target: { kind: "workspace", id: workspace.id }, seen: seenOf(all) });
      else acc.effects.push({ type: "run", action, target: { kind: action === "close_tab" ? "tab" : "pane", id: node.id }, index, name: null, seen: seenOf(ends) });
      return;
    }
    case "previous_workspace":
    case "next_workspace":
      moveFocus(acc, target(around(s.world.workspaces, shown.workspace?.id, action === "next_workspace" ? 1 : -1), "workspace"));
      return;
    case "previous_tab":
    case "next_tab":
      moveFocus(acc, target(around(shown.workspace?.tabs ?? [], shown.tab?.id, action === "next_tab" ? 1 : -1), "tab"));
      return;
    case "switch_tab":
      moveFocus(acc, target(index === null ? undefined : shown.workspace?.tabs[index - 1], "tab"));
      return;
    case "switch_workspace":
      moveFocus(acc, target(index === null ? undefined : s.world.workspaces[index - 1], "workspace"));
      return;
    case "cycle_pane_next":
    case "cycle_pane_previous":
      moveFocus(acc, target(around(shown.tab?.panes ?? [], shown.pane?.id, action === "cycle_pane_next" ? 1 : -1), "pane"));
      return;
    case "last_pane":
      moveFocus(acc, s.focus.previous === null ? undefined : { kind: "pane", id: s.focus.previous });
      return;
    case "new_workspace":
    case "open_notification_target":
    case "previous_agent":
    case "next_agent":
    case "focus_agent":
      acc.effects.push({ type: "run", action, target: null, index, name: null });
      return;
    case "move_tab_previous":
    case "move_tab_next":
      runOn(target(shown.tab, "tab"));
      return;
    case "focus_pane_left":
    case "focus_pane_down":
    case "focus_pane_up":
    case "focus_pane_right":
    case "swap_pane_left":
    case "swap_pane_down":
    case "swap_pane_up":
    case "swap_pane_right":
    case "split_vertical":
    case "split_horizontal":
    case "zoom":
    case "resize_pane_left":
    case "resize_pane_down":
    case "resize_pane_up":
    case "resize_pane_right":
      runOn(target(shown.pane, "pane"));
      return;
    case "settings":
    case "new_worktree":
    case "open_worktree":
    case "remove_worktree":
    case "edit_scrollback":
    case "clear_pane":
      // parity entries: answered above
      return;
    default: {
      const never: never = action;
      return never;
    }
  }
}

