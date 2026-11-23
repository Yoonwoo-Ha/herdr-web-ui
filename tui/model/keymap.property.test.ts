import { describe, expect, it } from "bun:test";
import { type HerdrChord, parseHerdrBinding, resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import { decodeControl, decodeCsi, decodeSs3, type InputEvent, type Mods, typedKey } from "../input/decode.ts";
import { Framer } from "../input/framer.ts";
import type { Effect } from "./effects.ts";
import type { World } from "./focus.ts";
import { helpRows, modeBar } from "./hints.ts";
import { buildKeymap, charChords, chordId, type KeyAction, type Keymap, keyChords, type Mode } from "./keymap.ts";
import { initialState, type ModelState, reduce } from "./reduce.ts";

// The key table over random configs: what the help and the mode bar show fires, what fires is shown, and every binding
// the resolver keeps that the table leaves out has one note. MODEL_SEED picks the run; OVIS_TUI_MODEL_SEQUENCES sets
// how many configs (default 300; the evidence runs use 3000).
const SEED = Number(process.env["MODEL_SEED"] ?? "1");
const CONFIGS = Number(process.env["OVIS_TUI_MODEL_SEQUENCES"] ?? "300");
const AT = 1_000;

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

// Every key name the host input decoder can deliver, asked of the decoder itself: control bytes, CSI ~ / u / letter
// forms and SS3. A chord on a name outside this set has no event.
const DELIVERED = new Set<string>();
const keep = (event: ReturnType<typeof decodeSs3>) => { if (event?.type === "key") DELIVERED.add(event.key); };
for (const byte of [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f]) if (byte !== 0x1b) keep(decodeControl(byte, false));
for (let n = 1; n <= 40; n++) keep(decodeCsi(String(n), "~", false, false));
for (const n of [9, 13, 27, 127, ...Array.from({ length: 120 }, (_, i) => 57344 + i)]) keep(decodeCsi(String(n), "u", false, true));
for (const final of "ABCDEFGHPQRSZ") keep(decodeCsi("", final, false, false));
for (let c = 0x40; c < 0x7f; c++) keep(decodeSs3(String.fromCharCode(c)));
const NAME_OF: Readonly<Record<string, string>> = {
  Enter: "ENTER", Tab: "TAB", Escape: "ESCAPE", Backspace: "BACKSPACE", ArrowLeft: "ARROW_LEFT", ArrowRight: "ARROW_RIGHT", ArrowUp: "ARROW_UP", ArrowDown: "ARROW_DOWN",
};

/** The input events the decoder could deliver for `chord`: none for hyper (the decoder drops such a sequence) or an undeliverable key. */
function eventsFor(chord: HerdrChord): InputEvent[] {
  if (chord.hyper) return [];
  const mods: Mods = { ...(chord.ctrl ? { ctrl: true } : {}), ...(chord.alt ? { alt: true } : {}), ...(chord.shift ? { shift: true } : {}), ...(chord.meta ? { super: true } : {}) };
  if ([...chord.key].length === 1) {
    const typed: InputEvent = { ...typedKey(chord.key, mods), at: AT };
    // a plain typed character also arrives as a text run
    return typed.type === "key" && typed.text !== undefined && !chord.alt ? [typed, { type: "text", text: typed.text, at: AT }] : [typed];
  }
  const name = NAME_OF[chord.key] ?? chord.key;
  return DELIVERED.has(name) ? [{ type: "key", key: name, mods, action: "press", at: AT }] : [];
}

/** The chords the matching reads from an event (a text run: its one character). */
function matched(event: InputEvent): HerdrChord[] {
  if (event.type === "key") return event.action === "press" ? keyChords(event) : [];
  return event.type === "text" && [...event.text].length === 1 ? charChords(event.text, false) : [];
}

const bytesOf = (read: string) => Uint8Array.from(read, (c) => c.charCodeAt(0));

// One host read per chord the matching can see, found by feeding byte sequences through the framer and decoder: every
// single byte and ESC with it (legacy, preferred), then the kitty flag's CSI u forms and the CSI letter and ~ forms with
// every modifier of shift, alt, ctrl and super.
const BYTES = new Map<string, string>();
for (const read of [
  ...Array.from({ length: 0x80 }, (_, b) => String.fromCharCode(b)),
  ...Array.from({ length: 0x80 }, (_, b) => `\x1b${String.fromCharCode(b)}`),
  ...[9, 13, 27, 127, ...Array.from({ length: 0x5f }, (_, i) => 0x20 + i), ...Array.from({ length: 120 }, (_, i) => 57344 + i)]
    .flatMap((code) => Array.from({ length: 16 }, (_, m) => `\x1b[${code};${m + 1}u`)),
  ...[..."ABCDEFHPQRS"].flatMap((final) => Array.from({ length: 16 }, (_, m) => `\x1b[1;${m + 1}${final}`)),
  ...Array.from({ length: 40 }, (_, n) => Array.from({ length: 16 }, (_, m) => `\x1b[${n + 1};${m + 1}~`)).flat(),
]) {
  const framer = new Framer();
  const events = [...framer.feed(bytesOf(read), 0), ...framer.tick(10_000)];
  if (events.length !== 1) continue;
  for (const chord of matched(events[0]!)) if (!BYTES.has(chordId(chord))) BYTES.set(chordId(chord), read);
}

/** The ids the matching looks up for what a host sends for `chord`. */
const matchIds = (chord: HerdrChord) => eventsFor(chord).flatMap((event) => matched(event).map(chordId));

const INDEXED = new Set(["switch_tab", "switch_workspace", "focus_agent", "navigate_index", "copy_label"]);

/** The chords a shown key text stands for, each with its index. */
function chordsOf(text: string, action: string): { chord: HerdrChord; index: number | null; prefixed: boolean }[] {
  const binding = parseHerdrBinding(text);
  if (binding === null) return [];
  const chords = binding.range ? Array.from({ length: 9 }, (_, i) => ({ ...binding.chord, key: String(i + 1) })) : [binding.chord];
  return chords.map((chord) => ({ chord, prefixed: binding.prefixed, index: INDEXED.has(action) && /^[1-9]$/.test(chord.key) ? Number(chord.key) : null }));
}

/** Whether one of the events for `chord` does in `state` exactly what the action itself does there. */
function fires(state: ModelState, action: KeyAction, chord: HerdrChord, index: number | null): boolean {
  const ref = reduce(state, { type: "action", action, index: index ?? undefined, at: AT });
  return eventsFor(chord).some((event) => {
    const step = reduce(state, event);
    return Bun.deepEquals(step.state, ref.state) && Bun.deepEquals(step.effects, ref.effects);
  });
}

const MODIFIERS = ["ctrl", "alt", "shift", "cmd", "super", "hyper", "meta", "control", "option"];
const KEYS = [
  ..."abcghjklnqvxz", "A", "N", ..."0159", ..."-=[];',./`\\", ..."!?$%^&*()_+{}:<>~\"|@#",
  "space", "enter", "tab", "esc", "escape", "left", "right", "up", "down", "backspace", "minus", "comma", "plus",
  "f1", "f5", "f12", "f13", "f20", "f25", "f26", "f30", "\u314a", "\u00e9", "\u{1f600}", "\u{d55c}",
];
const SPECIAL = ["ctrl+alt+g", "esc", "ctrl+[", "left", "right", "shift+tab", "prefix+esc", "prefix+ctrl+[", "", " ", "prefix+1..9", "prefix+shift+1..9", "ctrl+b", "prefix+ctrl+b", "prefix+hyper+v", "prefix+\u314a", "nonsense+x", "prefix+shift+/"];
const ACTIONS = resolveAllHerdrKeys(undefined).actions.map((action) => action.action);
const NAVIGATE = ["navigate_workspace_up", "navigate_workspace_down", "navigate_pane_left", "navigate_pane_down", "navigate_pane_up", "navigate_pane_right"];

function config(rnd: () => number): Record<string, unknown> {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const binding = (prefixed: number): string => {
    if (rnd() < 0.12) return pick(SPECIAL);
    const mods = MODIFIERS.filter(() => rnd() < 0.15);
    return [...(rnd() < prefixed ? ["prefix"] : []), ...mods, rnd() < 0.05 ? "1..9" : pick(KEYS)].join("+");
  };
  const value = (prefixed: number) => rnd() < 0.7 ? binding(prefixed) : [binding(prefixed), binding(prefixed)];
  const keys: Record<string, unknown> = {};
  for (const action of ACTIONS) if (rnd() < 0.3) keys[action] = value(0.65);
  for (const name of NAVIGATE) if (rnd() < 0.3) keys[name] = value(0.05);
  // the arrows the screen fixes in navigate mode, written for the same action or another
  if (rnd() < 0.05) keys[pick(["navigate_pane_left", "navigate_pane_right", "navigate_pane_up"])] = pick(["left", "right"]);
  if (rnd() < 0.3) keys["prefix"] = binding(0);
  if (rnd() < 0.1) keys["extra_prefixes"] = [binding(0)];
  if (rnd() < 0.1) keys["command"] = [{ key: binding(0.5), command: "x" }];
  if (rnd() < 0.05) keys["bogus_action"] = binding(0.5);
  // the fallback lists used up: the detach keys bound after the prefix, the prefix keys bound directly with an untypable
  // prefix, the prefixes on the detach keys
  if (rnd() < 0.06) for (const key of ["prefix+q", "prefix+ctrl+q", "prefix+alt+q"]) if (rnd() < 0.8) keys[pick(ACTIONS)] = key;
  if (rnd() < 0.06) {
    keys["prefix"] = pick(["hyper+b", "f30", "ctrl+!"]);
    for (const key of ["ctrl+b", "ctrl+a", "ctrl+]", "ctrl+\\", "prefix+ctrl+b"]) if (rnd() < 0.8) keys[pick(ACTIONS)] = key;
    if (rnd() < 0.5) keys["command"] = [{ key: pick(["ctrl+b", "prefix+ctrl+b", "ctrl+a"]), command: "x" }];
  }
  if (rnd() < 0.03) {
    keys["prefix"] = "q";
    keys["extra_prefixes"] = ["ctrl+q", "alt+q"];
  }
  return keys;
}

const pane = (id: string) => ({ id, name: "" });
const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [pane("p1"), pane("p2")] }, { id: "t2", name: "b", panes: [pane("p3"), pane("p4")] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [pane("p5"), pane("p6")] }, { id: "t4", name: "d", panes: [pane("p7")] }] },
  ],
};

class PropertyError extends Error {}
function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new PropertyError(what);
}

/** The states the table's rows are shown in: Idle, Armed, each mode and locked (null when the screen cannot get there). */
function states(keymap: Keymap, keys: unknown): Record<"idle" | "armed" | Exclude<Mode, "terminal"> | "locked", ModelState | null> {
  let idle = reduce(initialState(keys), { type: "world", world: WORLD, at: 0 }).state;
  idle = reduce(idle, { type: "select", target: { kind: "pane", id: "p2" }, at: 0 }).state;
  const arming = keymap.prefixes.flatMap(({ chord }) => eventsFor(chord)).map((event) => reduce(idle, event).state).find((state) => state.armed) ?? null;
  const mode = (action: KeyAction) => reduce(idle, { type: "action", action, at: AT }).state;
  const locked = mode("lock");
  return { idle, armed: arming, navigate: mode("workspace_picker"), resize: mode("resize_mode"), copy: mode("copy_mode"), locked: locked.locked ? locked : null };
}

function checkConfig(keys: Record<string, unknown>): void {
  const keymap = buildKeymap(keys);
  const resolved = resolveAllHerdrKeys(keys);
  const at = states(keymap, keys);
  const notes = keymap.notes as readonly { code: string; action?: string; binding?: string; holder?: string }[];
  const notesFor = (action: string, binding: string) => notes.filter((note) => note.action === action && note.binding === binding);

  // (a) every key text the help shows fires its action in the state it is shown in
  const shown = new Set<string>();
  for (const row of helpRows(keymap)) {
    for (const text of row.keys) {
      for (const { chord, index, prefixed } of chordsOf(text, row.action)) {
        const level = row.mode === "terminal" ? (row.action === "lock" ? "direct" : prefixed ? "after" : "direct") : row.mode;
        for (const id of matchIds(chord)) shown.add(`${level}|${row.action}|${id}`);
        let state = level === "after" ? at.armed : level === "direct" ? at.idle : at[row.mode as Exclude<Mode, "terminal">];
        if (state !== null && row.action === "copy_label") state = reduce(state, { type: "action", action: "copy_hints", at: AT }).state;
        check(state !== null, `${row.action} "${text}" is shown in a state the screen cannot reach`);
        check(fires(state, row.action, chord, index), `${row.mode} ${row.action} "${text}" is shown but no input event fires it`);
      }
    }
  }
  if (at.locked !== null) for (const text of helpRows(keymap).find((row) => row.action === "lock")!.keys) {
    for (const { chord } of chordsOf(text, "lock")) check(fires(at.locked, "lock", chord, null), `the unlock chord "${text}" does not unlock`);
  }
  for (const { text, chord } of keymap.prefixes) check(eventsFor(chord).some((event) => reduce(at.idle!, event).state.armed), `the prefix "${text}" is shown but no input event arms it`);

  // (e) some key sequence quits, found in the table (a direct detach key, else a prefix then detach's key after it) and
  // typed as bytes; or, when the config's own bindings leave no key for it, exactly one note says so and no binding of
  // the config lost its key to a fallback
  const detachIn = (lookup: Readonly<Record<string, { action: KeyAction }>>) => Object.entries(lookup).find(([, bound]) => bound.action === "detach")?.[0];
  const direct = detachIn(keymap.direct);
  const after = detachIn(keymap.afterPrefix);
  const prefixId = Object.keys(keymap.prefixIds)[0];
  const route = direct !== undefined ? [direct] : after !== undefined && prefixId !== undefined ? [prefixId, after] : null;
  const unreachable = notes.filter((note) => note.code === "prefix_unreachable" || note.code === "detach_unreachable");
  const takenByFallback = notes.filter((note) => note.code === "taken" && (note.holder === "detach" || note.holder === "prefix"));
  check(unreachable.length <= 1, "more than one note that a fallback is used up");
  if (route === null) {
    check(unreachable.length === 1, "no key sequence quits, and no note says so");
    check(takenByFallback.length === 0, `no key quits and a fallback took a binding: ${JSON.stringify(takenByFallback)}`);
  } else {
    const reads = route.map((id) => BYTES.get(id));
    check(reads.every((read) => read !== undefined), `no host bytes for ${route.join(" then ")}`);
    const framer = new Framer();
    let typing = at.idle!;
    const effects: Effect[] = [];
    reads.forEach((read, i) => {
      for (const event of [...framer.feed(bytesOf(read!), AT + i * 1_000), ...framer.tick(AT + i * 1_000 + 999)]) {
        const step = reduce(typing, event);
        typing = step.state;
        effects.push(...step.effects);
      }
    });
    check(effects.some((effect) => effect.type === "quit"), `the bytes ${JSON.stringify(reads)} of ${route.join(" then ")} do not quit`);
  }

  // no fallback sits on a key a binding of the config holds: the prefix on none at any level (a binding after the
  // prefix on it would send the prefix), detach on none after the prefix and on no prefix
  const held = new Map<string, string>();
  const hold = (level: string, chord: HerdrChord, holder: string) => { for (const id of matchIds(chord)) held.set(`${level}|${id}`, holder); };
  for (const { action, bindings } of resolved.actions) for (const binding of bindings) for (const { chord } of binding.chords) hold(binding.prefixed ? "after" : "direct", chord, action);
  for (const { name, chord } of resolved.navigate) if (chord !== null) hold("navigate", chord, name);
  if (resolved.configRead && Array.isArray(keys["command"])) {
    for (const entry of keys["command"] as { key?: unknown }[]) {
      for (const text of [entry.key].flat()) {
        const binding = typeof text === "string" ? parseHerdrBinding(text) : null;
        if (binding !== null && !binding.range) hold(binding.prefixed ? "after" : "direct", binding.chord, "command");
      }
    }
  }
  for (const note of notes.filter((n) => n.code === "prefix_fallback") as unknown as { fallback: string }[]) {
    for (const id of matchIds(parseHerdrBinding(note.fallback)!.chord)) {
      for (const level of ["direct", "after", "navigate"]) check(!held.has(`${level}|${id}`), `the fallback prefix ${note.fallback} sits on a ${level} key of ${held.get(`${level}|${id}`)}`);
    }
  }
  for (const note of notes.filter((n) => n.code === "detach_fallback") as unknown as { fallback: string }[]) {
    for (const id of matchIds(parseHerdrBinding(note.fallback)!.chord)) {
      const holder = held.get(`after|${id}`);
      check(holder === undefined || holder === "detach", `the detach fallback ${note.fallback} sits on a key of ${holder}`);
      check(!Object.hasOwn(keymap.prefixIds, id), `the detach fallback ${note.fallback} sits on a prefix`);
    }
  }

  // (f) a binding that fires carries no note: every key shown (each fires, by (a)) and every prefix
  for (const row of helpRows(keymap)) for (const text of row.keys) check(notesFor(row.action, text).length === 0, `${row.mode} ${row.action} "${text}" fires and has a note`);
  for (const { text } of keymap.prefixes) check(notesFor("prefix", text).length === 0, `the prefix "${text}" arms and has a note`);
  // Escape and ctrl+[ end an armed prefix and run nothing, whatever the config binds, unless the key is a prefix itself
  if (at.armed !== null) {
    for (const text of ["esc", "ctrl+["]) {
      const chord = parseHerdrBinding(text)!.chord;
      const literal = keymap.prefixes.some((prefix) => chordId(prefix.chord) === chordId(chord));
      for (const event of eventsFor(chord)) {
        const step = reduce(at.armed, event);
        check(!step.state.armed && step.state.overlays.length === 0 && step.state.mode.name === "terminal", `${text} after the prefix did more than end it`);
        check(step.effects.every((effect) => literal && effect.type === "pane"), `${text} after the prefix ran something`);
      }
    }
  }

  // the mode bar shows what the help shows for that state
  const helpKeys = (filter: (mode: Mode, text: string, action: KeyAction) => boolean, strip: boolean) => helpRows(keymap).flatMap((row) => {
    const keysShown = row.keys.filter((text) => filter(row.mode, text, row.action)).map((text) => strip ? text.replace(/^prefix\+/, "") : text);
    return keysShown.length === 0 ? [] : [{ action: row.action, keys: keysShown }];
  });
  if (at.armed !== null) check(Bun.deepEquals(modeBar(at.armed).hints, helpKeys((mode, text) => mode === "terminal" && text.startsWith("prefix+"), true)), "the armed mode bar differs from the help");
  for (const mode of ["navigate", "resize", "copy"] as const) check(Bun.deepEquals(modeBar(at[mode]!).hints, helpKeys((m, _key, action) => m === mode && action !== "copy_label", false)), `the ${mode} mode bar differs from the help`);
  const hintMode = at.copy && reduce(at.copy, { type: "action", action: "copy_hints", at: AT }).state;
  check(hintMode !== null && Bun.deepEquals(modeBar(hintMode).hints,
    helpKeys((m, _key, action) => m === "copy" && ["copy_label", "copy_leave", "copy_hints"].includes(action), false)), "the copy hint mode bar differs from the help");
  check(Bun.deepEquals(modeBar(at.idle!).hints[0]!.keys, keymap.prefixes.map((prefix) => prefix.text)), "the idle mode bar's prefixes differ from the table's");

  // (b) and (d): the table is the resolver's minus the bindings it drops, and each drop has exactly one note; with no
  // prefix left, the one fallback its note names
  const typable = resolved.prefixes.filter(({ text }) => notesFor("prefix", text).length === 0);
  const fallbacks = notes.filter((note) => note.code === "prefix_fallback") as unknown as { action: string; binding: string; fallback: string }[];
  const prefixUnreachable = notes.filter((note) => note.code === "prefix_unreachable");
  check(fallbacks.length + prefixUnreachable.length === (typable.length === 0 ? 1 : 0) && [...fallbacks, ...prefixUnreachable].every((note) => note.binding === resolved.prefixes[0]!.text), "one fallback or unreachable note, on the configured prefix, exactly when no prefix can be typed");
  check(Bun.deepEquals(keymap.prefixes.map(({ text }) => text), typable.length > 0 ? typable.map(({ text }) => text) : fallbacks.map((note) => note.fallback)), "the prefixes are the resolver's minus the noted ones, else the fallback, else none");
  // herdr's resolver lets a default that loses its key stand down silently: a key that arrives as another (shift+/ as ?) too
  const written = (action: string) => resolved.configRead && (Object.hasOwn(keys, action) || (action === "zoom" && Object.hasOwn(keys, "fullscreen")));
  for (const note of notes.filter((n) => n.code === "taken")) check(written(note.action!), `${note.action} is a default and its lost key "${note.binding}" is noted`);
  for (const { text } of resolved.prefixes) check(notesFor("prefix", text).length <= 1, `prefix "${text}" has more than one note`);
  // a chord dropped for shift in the text is one shift does not change: it arrives as its key alone (shift+space as space)
  for (const note of notes.filter((n) => n.code === "shift_in_text")) {
    for (const { chord } of chordsOf(note.binding!, note.action!)) {
      check(matchIds(chord).every((id) => id === chordId({ ...chord, shift: false })), `${note.action} "${note.binding}" is dropped for shift, but shift changes what it types`);
    }
  }
  const detachFallback = notes.find((note) => note.code === "detach_fallback") as unknown as { fallback: string } | undefined;
  for (const { action, bindings } of resolved.actions) {
    const row = keymap.rows.find((r) => r.action === action && r.mode === "terminal")!;
    // a binding noted whole is gone, and with no prefix every one after the prefix (its note is the prefix's); a range
    // keeps the digits not noted one by one; a default loses, silently, a key another action holds
    const heldByOther = (prefixed: boolean, chord: HerdrChord) => {
      const lookup = prefixed ? keymap.afterPrefix : keymap.direct;
      return matchIds(chord).some((id) => Object.hasOwn(lookup, id) && lookup[id]!.action !== action);
    };
    const expected = bindings.flatMap((binding) => {
      if (notesFor(action, binding.text).length > 0 || (binding.prefixed && prefixUnreachable.length > 0)) return [];
      const chords = binding.chords.filter(({ chord }) => (!binding.range || notesFor(action, binding.text.replace("1..9", chord.key)).length === 0) && (written(action) || !heldByOther(binding.prefixed, chord)));
      return chords.length === 0 ? [] : [{ ...binding, chords }];
    });
    if (action === "detach" && detachFallback !== undefined) expected.push({ text: detachFallback.fallback, prefixed: true, range: false, chords: [{ chord: parseHerdrBinding(detachFallback.fallback)!.chord, index: null }] });
    check(Bun.deepEquals(row.bindings, expected), `${action}: the table is the resolver's minus the noted bindings`);
    for (const binding of bindings) check(notesFor(action, binding.text).length <= 1, `${action} "${binding.text}" has more than one note`);
  }
  const detachUnreachable = notes.some((note) => note.code === "detach_unreachable");
  const detachNoneKept = resolved.actions.find((a) => a.action === "detach")!.bindings.every((binding) => notesFor("detach", binding.text).length > 0);
  check(prefixUnreachable.length > 0
    ? detachFallback === undefined && !detachUnreachable
    : [detachFallback !== undefined, detachUnreachable].filter(Boolean).length === (detachNoneKept ? 1 : 0), "detach falls back, or says it cannot, exactly when none of its bindings is kept and a prefix exists");
  for (const { name, text, chord } of resolved.navigate) {
    if (chord === null) continue;
    const row = keymap.rows.find((r) => r.action === name && r.mode === "navigate")!;
    const noted = notesFor(name, text).length;
    check(noted <= 1, `${name} "${text}" has more than one note`);
    check(noted === 1 || row.bindings.some((binding) => binding.chords.some((c) => chordId(c.chord) === chordId(chord))), `${name} "${text}" is kept by the resolver, not shown and has no note`);
  }

  // (c) nothing fires that is not shown: every chord the matching looks up is a shown key of that level
  const lookups: [string, Readonly<Record<string, { action: KeyAction }>>][] = [["after", keymap.afterPrefix], ["direct", keymap.direct], ...(["navigate", "resize", "copy"] as const).map((mode): [string, Readonly<Record<string, { action: KeyAction }>>] => [mode, keymap.modeKeys[mode]])];
  for (const [level, lookup] of lookups) {
    for (const [id, bound] of Object.entries(lookup)) check(shown.has(`${level}|${bound.action}|${id}`), `${level} ${bound.action} on ${id} fires but is not shown`);
  }
  const shownPrefixes = new Set(keymap.prefixes.flatMap(({ chord }) => matchIds(chord)));
  for (const id of Object.keys(keymap.prefixIds)) check(shownPrefixes.has(id), `the prefix ${id} arms but is not shown`);
}

describe("the key table over random configs", () => {
  it(`shows only what fires, notes every drop and follows the resolver over ${CONFIGS} configs (seed ${SEED})`, () => {
    let bindings = 0;
    let notes = 0;
    const fallbackCodes = new Map<string, number>([["prefix_fallback", 0], ["prefix_unreachable", 0], ["detach_fallback", 0], ["detach_unreachable", 0]]);
    for (let n = 0; n < CONFIGS; n++) {
      const keys = config(random(SEED * 1_000_003 + n));
      try {
        checkConfig(keys);
      } catch (error) {
        if (error instanceof PropertyError) throw new Error(`seed ${SEED} config ${n}: ${error.message}\n${JSON.stringify(keys)}`);
        throw error;
      }
      const keymap = buildKeymap(keys);
      bindings += keymap.rows.reduce((sum, row) => sum + row.bindings.length, 0);
      notes += keymap.notes.length;
      for (const note of keymap.notes) if (fallbackCodes.has(note.code)) fallbackCodes.set(note.code, fallbackCodes.get(note.code)! + 1);
    }
    // the generator reached both sides: many bindings shown and many dropped with a note, and every fallback outcome
    expect(bindings).toBeGreaterThan(CONFIGS * 10);
    expect(notes).toBeGreaterThan(CONFIGS / 10);
    for (const [code, count] of fallbackCodes) expect({ code, reached: count > 0 }).toEqual({ code, reached: true });
  });
});
