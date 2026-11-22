import { describe, expect, it } from "bun:test";
import { type HerdrAction, type HerdrChord, resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import { type InputEvent, type Mods, typedKey } from "../input/decode.ts";
import { earliest, NOTICES_KEPT } from "./deadlines.ts";
import type { Target, World } from "./focus.ts";
import { charChords, chordId, keyChords, type Keymap } from "./keymap.ts";
import { OVERLAYS, overlayTarget } from "./overlays.ts";
import { initialState, type ModelEvent, type ModelState, reduce, type Step } from "./reduce.ts";

// The ladder over random event sequences. MODEL_SEED picks the run; OVIS_TUI_MODEL_SEQUENCES raises the count
// from its default of 500, which keeps the file well inside the unit lane's 60 s per file (evidence runs use 3000).
const SEED = Number(process.env["MODEL_SEED"] ?? "1");
const SEQUENCES = Number(process.env["OVIS_TUI_MODEL_SEQUENCES"] ?? "500");
const EVENTS_PER_SEQUENCE = 40;

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTIONS = resolveAllHerdrKeys(undefined).actions.map((action) => action.action);
const CONFIGS: unknown[] = [
  undefined, {}, { prefix: "ctrl+a" }, { prefix: "-" }, { prefix: "ctrl+b", extra_prefixes: ["f12", "alt+space"] }, { new_tab: "alt+t" },
  { zoom: "" }, { new_tab: "ctrl+alt+g" }, { navigate_pane_left: "a", navigate_workspace_up: "esc" }, { prefix: "" },
  { split_vertical: ["prefix+v", "alt+v"], close_pane: "prefix+x" }, { resize_mode: "prefix+h" }, { prefix: 5 }, { indexed: { tabs: "ctrl" } },
  { help: "q" }, { copy_mode: "prefix+c", new_tab: "prefix+c" }, { prefix: "ctrl+b", new_tab: "prefix+c", bogus: "x" }, { workspace_picker: "f2", goto: "ctrl+g" },
];
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-=[];',./`?!\\ ";
const NAMED = ["ESCAPE", "ENTER", "TAB", "BACKSPACE", "ARROW_LEFT", "ARROW_RIGHT", "ARROW_UP", "ARROW_DOWN", "F1", "F5", "F12", "HOME", "END", "DELETE", "DIGIT_1", "DIGIT_9", "UNIDENTIFIED"];
const TEXTS = ["a", "hello", "-", "a-b", "--", "q", "?", "[", "jjk", "\u{d55c}", "\u{d55c}\u{ae00}", "\u{1f600}", "a\u{d55c}b", "y", "n", "1", "9", "\u{3131}", "x".repeat(1024)];

const named = (name: string, mods: Mods, at: number): InputEvent => ({ type: "key", key: name, mods, action: "press", at });
const NAME_OF: Readonly<Record<string, string>> = { Escape: "ESCAPE", Enter: "ENTER", Tab: "TAB", Backspace: "BACKSPACE", ArrowLeft: "ARROW_LEFT", ArrowRight: "ARROW_RIGHT", ArrowUp: "ARROW_UP", ArrowDown: "ARROW_DOWN" };

/** A key event that matches `chord`. */
function chordEvent(chord: HerdrChord, at: number): InputEvent {
  const mods: Mods = { ...(chord.ctrl ? { ctrl: true } : {}), ...(chord.alt ? { alt: true } : {}), ...(chord.shift ? { shift: true } : {}), ...(chord.meta ? { super: true } : {}) };
  if (/^F\d+$/.test(chord.key)) return named(chord.key, mods, at);
  const name = NAME_OF[chord.key];
  if (name !== undefined) return named(name, mods, at);
  return { ...typedKey(chord.shift && /^[a-z]$/.test(chord.key) ? chord.key.toUpperCase() : chord.key, { ...mods, shift: false }), at };
}

function lockChord(keymap: Keymap): HerdrChord | null {
  return keymap.rows.find((row) => row.action === "lock")?.bindings[0]?.chords[0]?.chord ?? null;
}

const printablePrefix = (keymap: Keymap) => keymap.prefixes.some(({ chord }) => !chord.ctrl && !chord.alt && !chord.meta && [...chord.key].length === 1);

function worldFrom(rnd: () => number, ids: { next: number }): World {
  const id = (kind: string) => `${kind}${ids.next++}`;
  const count = (most: number) => Math.floor(rnd() * most) + 1;
  return {
    workspaces: Array.from({ length: Math.floor(rnd() * 4) }, () => ({
      id: id("w"), name: id("name "), tabs: Array.from({ length: count(3) }, () => ({ id: id("t"), name: "", panes: Array.from({ length: count(3) }, () => ({ id: id("p"), name: "" })) })),
    })),
  };
}

/** The world with some of its nodes gone and some new ones. */
function changed(world: World, rnd: () => number, ids: { next: number }): World {
  const keep = () => rnd() > 0.25;
  const kept: World = {
    workspaces: world.workspaces.filter(keep).map((workspace) => ({
      ...workspace, tabs: workspace.tabs.filter(keep).map((tab) => ({ ...tab, panes: tab.panes.filter(keep) })).filter((tab) => tab.panes.length > 0),
    })).filter((workspace) => workspace.tabs.length > 0),
  };
  return { workspaces: [...kept.workspaces, ...(rnd() < 0.5 ? worldFrom(rnd, ids).workspaces : [])] };
}

function targets(world: World): Target[] {
  return world.workspaces.flatMap((workspace) => [{ kind: "workspace" as const, id: workspace.id }, ...workspace.tabs.flatMap((tab) => [{ kind: "tab" as const, id: tab.id }, ...tab.panes.map((pane) => ({ kind: "pane" as const, id: pane.id }))])]);
}

function nextEvent(state: ModelState, rnd: () => number, at: number, ids: { next: number }): ModelEvent {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const mods = (): Mods => ({ ...(rnd() < 0.2 ? { ctrl: true } : {}), ...(rnd() < 0.2 ? { alt: true } : {}), ...(rnd() < 0.15 ? { shift: true } : {}), ...(rnd() < 0.05 ? { super: true } : {}) });
  const roll = rnd();
  if (roll < 0.14) return { ...typedKey(pick([...LETTERS]), mods()), at };
  if (roll < 0.22) return named(pick(NAMED), rnd() < 0.3 ? mods() : {}, at);
  if (roll < 0.32) return chordEvent(pick(state.keymap.prefixes).chord, at);
  if (roll < 0.35) { const chord = lockChord(state.keymap); return chord === null ? named("ESCAPE", {}, at) : chordEvent(chord, at); }
  if (roll < 0.37) return { ...typedKey(pick([..."abc"]), {}), action: pick(["release", "repeat"] as const), at };
  if (roll < 0.52) return { type: "text", text: pick(TEXTS), at };
  if (roll < 0.56) return { type: "paste", text: pick(TEXTS), complete: rnd() < 0.8, at };
  if (roll < 0.60) return { type: "mouse", action: pick(["press", "release", "motion"] as const), button: pick(["left", "right", "wheelUp", "wheelDown"] as const), mods: {}, col: 3, row: 4, at };
  if (roll < 0.62) return { type: "focus", focused: rnd() < 0.5, at };
  if (roll < 0.63) return { type: "resize", cols: Math.floor(rnd() * 300), rows: Math.floor(rnd() * 100), at };
  if (roll < 0.64) return { type: "reply", kind: "color", data: "11;rgb:ffff/ffff/ffff", at };
  if (roll < 0.65) return { type: "unknown", raw: "\x1b[?1;2c", at };
  if (roll < 0.71) return { type: "world", world: changed(state.world, rnd, ids), at };
  if (roll < 0.74) return { type: "keys", keys: pick(CONFIGS), at };
  if (roll < 0.83) return { type: "action", action: rnd() < 0.08 ? "lock" : pick(ACTIONS) as HerdrAction, index: Math.floor(rnd() * 10), at };
  if (roll < 0.87) {
    const all = targets(state.world);
    return { type: "select", target: all.length > 0 && rnd() < 0.85 ? pick(all) : { kind: "pane", id: "gone" }, at };
  }
  if (roll < 0.93) {
    const due = earliest(state.deadlines);
    return { type: "deadline", name: due?.name ?? "prefix", at: due !== undefined && rnd() < 0.8 ? Math.max(at, due.at) : at };
  }
  if (roll < 0.95) return { type: "notice", code: "action_failed", data: { action: "split_vertical" }, at };
  return { type: "bogus", at } as unknown as ModelEvent;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
    if (value instanceof Map) for (const inner of value.values()) deepFreeze(inner);
  }
  return value;
}

class PropertyError extends Error {}
function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new PropertyError(what);
}

function exists(world: World, target: Target): boolean {
  return targets(world).some((t) => t.kind === target.kind && t.id === target.id);
}

/** (d) the state is valid. */
function checkValid(state: ModelState): void {
  check(["terminal", "navigate", "resize", "copy"].includes(state.mode.name), `mode ${state.mode.name}`);
  if (state.mode.name === "navigate") check(state.mode.preview === null || exists(state.world, { kind: "workspace", id: state.mode.preview }), "navigate preview exists");
  for (const overlay of state.overlays) {
    check(Object.hasOwn(OVERLAYS, overlay.kind), `overlay kind ${overlay.kind}`);
    const target = overlayTarget(overlay);
    check(target === null || exists(state.world, target), `overlay ${overlay.kind} target exists`);
  }
  const { focus, world } = state;
  check((focus.workspace === null) === (world.workspaces.length === 0), "a workspace is focused exactly when one exists");
  if (focus.workspace !== null) check(exists(world, { kind: "workspace", id: focus.workspace }), "focused workspace exists");
  for (const [workspace, tab] of Object.entries(focus.tabs)) check(world.workspaces.find((w) => w.id === workspace)?.tabs.some((t) => t.id === tab) === true, "remembered tab exists");
  for (const [tab, pane] of Object.entries(focus.panes)) check(world.workspaces.flatMap((w) => w.tabs).find((t) => t.id === tab)?.panes.some((p) => p.id === pane) === true, "remembered pane exists");
  check(focus.previous === null || exists(world, { kind: "pane", id: focus.previous }), "previous pane exists");
  if (state.armed) check(state.mode.name === "terminal" && state.overlays.length === 0 && !state.locked, "only Terminal mode with no overlay and no lock arms");
  if (state.locked) check(lockChord(state.keymap) !== null, "locked only with an unlock chord");
  check(state.notices.length <= NOTICES_KEPT, "notices capped");
  check((state.notices.length > 0) === state.deadlines.has("notice"), "notices name their expiry");
}

/** (e) the keys that bring any state back to Terminal mode with no overlay, no lock and no armed prefix. */
function escapeRoute(state: ModelState, at: number): ModelEvent[] {
  const route: ModelEvent[] = [];
  if (state.locked) route.push(chordEvent(lockChord(state.keymap)!, at));
  for (let i = 0; i < state.overlays.length; i++) route.push(named("ESCAPE", {}, at));
  if (state.mode.name !== "terminal") route.push(named("ESCAPE", {}, at));
  if (state.armed) route.push(named("ESCAPE", {}, at));
  return route;
}

/** (a) and (b) for one event and the step it gave. */
function checkPane(before: ModelState, event: ModelEvent, step: Step): void {
  const sent = step.effects.flatMap((effect) => effect.type === "pane" ? [effect] : []);
  if (sent.length > 0) check(step.levels.includes(6), "a pane effect only from level 6");
  for (const effect of sent) check(exists(before.world, { kind: "pane", id: effect.pane }), "a pane effect names a live pane");
  if (event.type !== "key" && event.type !== "text" && event.type !== "paste") {
    check(sent.length === 0, `no pane effect from a ${event.type} event`);
    return;
  }
  const lockedTakes = before.locked;
  const overlayTakes = !lockedTakes && before.overlays.length > 0;
  const modeTakes = !lockedTakes && !overlayTakes && before.mode.name !== "terminal";
  if (event.type === "key" || event.type === "paste") {
    check(sent.length <= 1, "at most one pane effect per key or paste");
    if (sent.length === 1) check(sent[0]!.input === event, "the pane effect carries exactly that event");
    if (overlayTakes || modeTakes) check(sent.length === 0, "an overlay or a mode took the event");
    if (event.type === "paste" && sent.length === 1) check(event.complete, "a refused paste never reaches a pane");
    if (event.type === "key" && before.armed && sent.length === 1) {
      check(keyChords(event).some((chord) => Object.hasOwn(before.keymap.prefixIds, chordId(chord))), "an armed prefix lets only the prefix itself through");
    }
    return;
  }
  const pieces = sent.map((effect) => effect.input);
  check(pieces.every((input) => input.type === "text"), "a text run reaches a pane as text");
  if (!printablePrefix(before.keymap)) check(pieces.length <= 1, "at most one pane effect per text run");
  if (lockedTakes && pieces.length === 1) check(pieces[0] === event, "a locked screen sends the run whole");
  if (overlayTakes) check(pieces.length === 0, "an overlay took the run");
  // the code point a mode or an armed prefix takes never reaches the pane: the pane's text starts after it,
  // unless it was the prefix itself, sent once as the literal prefix
  const first = [...event.text][0] ?? "";
  const literal = before.armed && charChords(first, false).some((chord) => Object.hasOwn(before.keymap.prefixIds, chordId(chord)));
  let from = (modeTakes || before.armed) && !literal ? first.length : 0;
  for (const piece of pieces) {
    const at = event.text.indexOf((piece as { text: string }).text, from);
    check(at >= from, "pane text is the run's own text, in order, each part once, never the code point a mode or the prefix took");
    from = at + (piece as { text: string }).text.length;
  }
}

describe("the ladder over random sequences", () => {
  it(`keeps its properties over ${SEQUENCES} sequences (seed ${SEED})`, () => {
    let events = 0;
    let paneEffects = 0;
    const levelsSeen = new Set<number>();
    for (let sequence = 0; sequence < SEQUENCES; sequence++) {
      const rnd = random(SEED * 1_000_003 + sequence);
      const ids = { next: 0 };
      let at = 0;
      let state = deepFreeze(initialState(CONFIGS[Math.floor(rnd() * CONFIGS.length)]));
      const history: ModelEvent[] = [];
      try {
        state = deepFreeze(reduce(state, { type: "world", world: worldFrom(rnd, ids), at }).state);
        for (let i = 0; i < EVENTS_PER_SEQUENCE; i++) {
          at += Math.floor(rnd() * 3000);
          const event = deepFreeze(nextEvent(state, rnd, at, ids));
          history.push(event);
          const snapshot = structuredClone({ state, event });
          const step = reduce(state, event);
          // (c) pure: the same answer again, and neither input changed
          check(Bun.deepEquals(reduce(state, event), step), "the same state and event give the same step");
          check(Bun.deepEquals({ state, event }, snapshot), "the inputs are unchanged");
          checkPane(state, event, step);
          checkValid(step.state);
          for (const level of step.levels) levelsSeen.add(level);
          paneEffects += step.effects.filter((effect) => effect.type === "pane").length;
          state = deepFreeze(step.state);
          // (e) never stuck
          let escaped = state;
          for (const key of escapeRoute(state, at)) escaped = reduce(escaped, key).state;
          check(escaped.mode.name === "terminal" && escaped.overlays.length === 0 && !escaped.locked && !escaped.armed, "the escape route returns to Terminal mode with no overlay");
          events++;
        }
      } catch (error) {
        if (error instanceof PropertyError) throw new Error(`seed ${SEED} sequence ${sequence} event ${history.length}: ${error.message}\n${JSON.stringify(history.slice(-6))}`);
        throw error;
      }
    }
    expect(events).toBe(SEQUENCES * EVENTS_PER_SEQUENCE);
    // the generator reached every level and sent bytes to panes, so the checks above had something to check
    expect([...levelsSeen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(paneEffects).toBeGreaterThan(1000);
  });
});
