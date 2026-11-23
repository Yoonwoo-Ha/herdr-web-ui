import { describe, expect, it } from "bun:test";
import { type InputEvent, type Mods, typedKey } from "../input/decode.ts";
import { Framer } from "../input/framer.ts";
import type { Effect } from "./effects.ts";
import { focused, type World } from "./focus.ts";
import { modeBar } from "./hints.ts";
import { TEXT_FIELD_MAX_CODE_POINTS, TEXT_FIELD_MAX_GRAPHEMES } from "./deadlines.ts";
import { OVERLAYS } from "./overlays.ts";
import { initialState, type Level, type ModelEvent, type ModelState, reduce, type Step } from "./reduce.ts";

const AT = 1_000;
const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }, { id: "p2", name: "" }] }, { id: "t2", name: "b", panes: [{ id: "p3", name: "" }] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "" }] }] },
  ],
};

const key = (char: string, mods: Mods = {}): InputEvent => ({ ...typedKey(char, mods), at: AT });
const named = (name: string, mods: Mods = {}): InputEvent => ({ type: "key", key: name, mods, action: "press", at: AT });
const text = (value: string): InputEvent => ({ type: "text", text: value, at: AT });
const paste = (value: string, complete = true): InputEvent => ({ type: "paste", text: value, complete, at: AT });
const mouse = (button: "left" | "wheelUp" = "left"): InputEvent => ({ type: "mouse", action: "press", button, mods: {}, col: 40, row: 10, at: AT });
// each call is a new object, so "the pane got exactly this event" is an identity check
const prefix = (): InputEvent => key("b", { ctrl: true });
const unlock = (): InputEvent => key("g", { ctrl: true, alt: true });

function start(keys?: unknown): ModelState {
  return reduce(initialState(keys), { type: "world", world: WORLD, at: 0 }).state;
}
function after(state: ModelState, ...events: ModelEvent[]): ModelState {
  return events.reduce((current, event) => reduce(current, event).state, state);
}
const paneInputs = (effects: readonly Effect[]) => effects.flatMap((effect) => effect.type === "pane" ? [effect.input] : []);
const focusedPane = (state: ModelState) => state.focus.panes[state.focus.tabs[state.focus.workspace!]!];

const idle = start();
const armed = after(idle, prefix());
const locked = after(idle, unlock());
const withHelp = after(idle, prefix(), text("?"));
const navigating = after(idle, prefix(), text("w"));
const copying = after(idle, prefix(), text("["));
const resizing = after(idle, prefix(), text("r"));
const directAlt = start({ new_tab: ["prefix+c", "alt+t"] });

describe("the ladder", () => {
  interface Row { level: Level; takes: boolean; name: string; state: ModelState; event: ModelEvent; levels: Level[]; pane: boolean; check?: (step: Step) => void }
  const rows: Row[] = [
    { level: 0, takes: true, name: "a host reply", state: idle, event: { type: "reply", kind: "color", data: "11;rgb:0000/0000/0000", at: AT }, levels: [0], pane: false,
      check: (step) => expect(step.effects).toEqual([{ type: "host_reply", kind: "color", data: "11;rgb:0000/0000/0000" }]) },
    { level: 0, takes: true, name: "an unknown sequence", state: armed, event: { type: "unknown", raw: "\x1b[999z", at: AT }, levels: [0], pane: false,
      check: (step) => expect(step.state.armed).toBe(true) },
    { level: 0, takes: true, name: "host focus", state: idle, event: { type: "focus", focused: true, at: AT }, levels: [0], pane: false },
    { level: 0, takes: true, name: "a host resize", state: idle, event: { type: "resize", cols: 100, rows: 30, at: AT }, levels: [0], pane: false },
    { level: 0, takes: true, name: "a host resize to no usable size is ignored", state: idle, event: { type: "resize", cols: Infinity, rows: -3, at: AT }, levels: [0], pane: false,
      check: (step) => expect(step.state.host).toEqual(idle.host) },
    { level: 0, takes: true, name: "a key release", state: idle, event: { ...key("x"), action: "release" } as InputEvent, levels: [0], pane: false },
    { level: 0, takes: true, name: "a paste refused at the limit", state: idle, event: paste("x".repeat(64), false), levels: [0], pane: false,
      check: (step) => expect(step.state.notices.map((notice) => notice.code)).toEqual(["paste_refused"]) },
    { level: 0, takes: false, name: "a key", state: idle, event: key("x"), levels: [6], pane: true },
    { level: 1, takes: true, name: "the unlock chord while locked", state: locked, event: unlock(), levels: [1], pane: false,
      check: (step) => expect(step.state.locked).toBe(false) },
    { level: 1, takes: true, name: "the prefix while locked goes straight to the pane", state: locked, event: prefix(), levels: [6], pane: true,
      check: (step) => expect(step.state.armed).toBe(false) },
    { level: 1, takes: true, name: "a bound key after nothing while locked", state: locked, event: text("?"), levels: [6], pane: true },
    { level: 1, takes: false, name: "text when not locked", state: idle, event: text("x"), levels: [6], pane: true },
    { level: 2, takes: true, name: "the prefix under an overlay", state: withHelp, event: prefix(), levels: [2], pane: false,
      check: (step) => { expect(step.state.armed).toBe(false); expect(step.state.overlays.map((overlay) => overlay.kind)).toEqual(["help"]); } },
    { level: 2, takes: true, name: "text under an overlay", state: withHelp, event: text("x"), levels: [2], pane: false },
    { level: 2, takes: true, name: "a paste under an overlay", state: withHelp, event: paste("hello"), levels: [2], pane: false },
    { level: 2, takes: true, name: "a click under an overlay", state: withHelp, event: mouse(), levels: [2], pane: false,
      check: (step) => expect(step.effects.map((effect) => effect.type === "mouse" ? effect.over : effect.type)).toEqual(["overlay"]) },
    { level: 2, takes: false, name: "a click with no overlay", state: idle, event: mouse(), levels: [6], pane: false,
      check: (step) => expect(step.effects.map((effect) => effect.type === "mouse" ? effect.over : effect.type)).toEqual(["screen"]) },
    { level: 3, takes: true, name: "an unbound key in Navigate", state: navigating, event: key("x"), levels: [3], pane: false,
      check: (step) => expect(step.effects).toEqual([]) },
    { level: 3, takes: true, name: "a navigate key", state: navigating, event: key("j"), levels: [3], pane: false,
      check: (step) => expect(step.effects).toEqual([{ type: "run", action: "focus_pane_down", target: { kind: "pane", id: "p1" }, index: null, name: null }]) },
    { level: 3, takes: true, name: "Escape leaves Resize mode", state: resizing, event: named("ESCAPE"), levels: [3], pane: false,
      check: (step) => expect(step.state.mode).toEqual({ name: "terminal" }) },
    { level: 3, takes: true, name: "a non-ASCII navigate key never fires", state: after(start({ navigate_pane_down: "\u{3153}" }), prefix(), text("w")), event: text("\u{3153}"), levels: [3], pane: false,
      check: (step) => { expect(step.effects).toEqual([]); expect(step.state.mode.name).toBe("navigate"); } },
    { level: 3, takes: true, name: "a text run in Copy, one code point at a time", state: copying, event: text("abc"), levels: [3, 3, 3], pane: false },
    { level: 3, takes: true, name: "a paste in Copy", state: copying, event: paste("abc"), levels: [3], pane: false },
    { level: 3, takes: false, name: "a navigate key in Terminal", state: idle, event: key("j"), levels: [6], pane: true },
    { level: 4, takes: true, name: "a direct binding on an Alt chord", state: directAlt, event: key("t", { alt: true }), levels: [4], pane: false,
      check: (step) => expect(step.state.overlays.map((overlay) => overlay.kind)).toEqual(["text"]) },
    { level: 4, takes: false, name: "text never matches a direct binding (the letter of alt+t)", state: directAlt, event: text("t"), levels: [6], pane: true },
    { level: 4, takes: false, name: "an unbound Alt chord", state: directAlt, event: key("y", { alt: true }), levels: [6], pane: true },
    { level: 4, takes: false, name: "a direct chord while the prefix is armed", state: after(directAlt, prefix()), event: key("t", { alt: true }), levels: [5], pane: false },
    { level: 5, takes: true, name: "the prefix chord", state: idle, event: prefix(), levels: [5], pane: false, check: (step) => expect(step.state.armed).toBe(true) },
    { level: 5, takes: true, name: "a key bound after the prefix", state: armed, event: text("c"), levels: [5], pane: false },
    { level: 5, takes: false, name: "the prefix twice", state: armed, event: prefix(), levels: [6], pane: true },
    { level: 5, takes: false, name: "a bound key without the prefix", state: idle, event: text("c"), levels: [6], pane: true },
    { level: 6, takes: true, name: "a key", state: idle, event: key("x"), levels: [6], pane: true },
    { level: 6, takes: true, name: "an unidentified key is never sent", state: idle, event: { type: "key", key: "UNIDENTIFIED", mods: {}, text: "\u{e000}", action: "press", at: AT }, levels: [6], pane: false },
  ];

  it("ladder table", () => {
    for (const row of rows) {
      const step = reduce(row.state, row.event);
      const label = `${row.level} ${row.takes ? "takes" : "passes"} ${row.name}`;
      expect({ label, levels: step.levels }).toEqual({ label, levels: row.levels });
      // a taken event reaches no lower level: nothing goes to a pane unless level 6 took it
      const inputs = paneInputs(step.effects);
      expect({ label, pane: inputs.length > 0 }).toEqual({ label, pane: row.pane });
      if (row.pane) expect({ label, inputs }).toEqual({ label, inputs: [row.event as never] });
      if (row.pane) expect(inputs[0]).toBe(row.event as never);
      row.check?.(step);
    }
    // every level has a row it takes and (above the pane) a row it passes on
    for (const level of [0, 1, 2, 3, 4, 5, 6] as Level[]) {
      expect({ level, takes: rows.some((row) => row.level === level && row.takes) }).toEqual({ level, takes: true });
      if (level < 6) expect({ level, passes: rows.some((row) => row.level === level && !row.takes) }).toEqual({ level, passes: true });
    }
  });
});

describe("the prefix machine", () => {
  interface Row { row: number; name: string; from: ModelState; events: ModelEvent[]; armed: boolean; pane: number[]; check?: (state: ModelState, steps: Step[]) => void }
  const unboundKey = named("F5");
  const rows: Row[] = [
    { row: 1, name: "Idle, a prefix chord: Armed, the mode bar shows the keys after the prefix", from: idle, events: [prefix()], armed: true, pane: [],
      check: (state) => { expect(modeBar(state).mode).toBe("prefix"); expect(modeBar(state).hints.map((hint) => hint.action)).toContain("new_tab"); } },
    { row: 1, name: "Idle, a prefix chord: Armed with no deadline, and still Armed however late a deadline event comes", from: idle,
      events: [prefix(), { type: "deadline", name: "prefix", at: AT + 86_400_000 }], armed: true, pane: [],
      check: (state) => expect([...state.deadlines.keys()]).toEqual([]) },
    { row: 2, name: "Armed, the prefix chord again: one literal prefix to the pane", from: idle, events: [prefix(), prefix()], armed: false, pane: [1] },
    { row: 3, name: "Armed, a text bound after the prefix: its action runs", from: armed, events: [text("c")], armed: false, pane: [],
      check: (state) => expect(state.overlays).toEqual([expect.objectContaining({ kind: "text", purpose: "new_tab", target: { kind: "workspace", id: "w1" } })]) },
    { row: 3, name: "Armed, a key bound after the prefix: its mode is entered", from: armed, events: [key("[")], armed: false, pane: [],
      check: (state) => expect(state.mode).toEqual({ name: "copy" }) },
    { row: 3, name: "Armed, 2 as text: 1..9 gives the index (tab 2)", from: armed, events: [text("2")], armed: false, pane: [],
      check: (state) => expect(state.focus.tabs["w1"]).toBe("t2") },
    { row: 3, name: "Armed, 2 then 1 as keys: tab 2 then tab 1", from: idle, events: [prefix(), named("DIGIT_2"), prefix(), named("DIGIT_1")], armed: false, pane: [],
      check: (state) => expect(state.focus.tabs["w1"]).toBe("t1") },
    { row: 4, name: "Armed, Escape: Idle, nothing sent", from: armed, events: [named("ESCAPE")], armed: false, pane: [],
      check: (state) => expect(state.overlays).toEqual([]) },
    { row: 4, name: "Armed, Escape: Idle even when a binding after the prefix names Escape", from: after(start({ help: ["prefix+?", "prefix+esc"] }), prefix()), events: [named("ESCAPE")], armed: false, pane: [],
      check: (state) => expect(state.overlays).toEqual([]) },
    { row: 4, name: "Armed, ctrl+[: Idle, nothing sent", from: armed, events: [key("[", { ctrl: true })], armed: false, pane: [],
      check: (state) => expect(state.mode).toEqual({ name: "terminal" }) },
    { row: 5, name: "Armed, a non-ASCII key bound after the prefix never fires: dropped, the Hangul rule applies", from: after(start({ new_tab: "prefix+\u{d55c}" }), prefix()),
      events: [text("\u{d55c}")], armed: false, pane: [],
      check: (state) => { expect(state.overlays).toEqual([]); expect(state.notices.map((notice) => notice.code)).toEqual(["ime_prefix"]); } },
    { row: 5, name: "Armed, an unbound text: dropped, Idle", from: armed, events: [text("y")], armed: false, pane: [] },
    { row: 5, name: "Armed, an unbound key: zero bytes to the pane, Idle", from: armed, events: [unboundKey], armed: false, pane: [],
      check: (state, steps) => expect(steps.flatMap((step) => step.effects)).toEqual([]) },
    { row: 5, name: "Armed, an unbound key, then the same key again reaches the pane", from: armed, events: [named("F5"), named("F5")], armed: false, pane: [1] },
    { row: 6, name: "Armed, a paste: Idle first, then the paste reaches the pane", from: armed, events: [paste("pasted")], armed: false, pane: [0] },
    { row: 6, name: "Armed, a mouse press: Idle first, then the screen gets it", from: armed, events: [mouse()], armed: false, pane: [],
      check: (_, steps) => expect(steps[0]!.effects.map((effect) => effect.type)).toEqual(["mouse"]) },
    { row: 6, name: "Armed, a wheel turn: Idle first", from: armed, events: [mouse("wheelUp")], armed: false, pane: [] },
    { row: 7, name: "Armed, host focus lost: Idle", from: armed, events: [{ type: "focus", focused: false, at: AT }], armed: false, pane: [] },
    { row: 7, name: "Armed, the keymap loaded again: Idle", from: armed, events: [{ type: "keys", keys: {}, at: AT }], armed: false, pane: [] },
  ];

  it("prefix table", () => {
    for (const row of rows) {
      const steps: Step[] = [];
      let state = row.from;
      for (const event of row.events) {
        const step = reduce(state, event);
        steps.push(step);
        state = step.state;
      }
      const label = `row ${row.row}: ${row.name}`;
      expect({ label, armed: state.armed }).toEqual({ label, armed: row.armed });
      // exactly these events reached the pane, each whole and once
      const sent = steps.flatMap((step) => paneInputs(step.effects));
      expect({ label, sent: sent.length }).toEqual({ label, sent: row.pane.length });
      row.pane.forEach((index, i) => expect(sent[i]).toBe(row.events[index] as never));
      row.check?.(state, steps);
    }
    expect(new Set(rows.map((row) => row.row))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
  });

  it("hangul after prefix gives a notice", () => {
    const step = reduce(armed, text("\u{d55c}"));
    expect(paneInputs(step.effects)).toEqual([]);
    expect(step.state.armed).toBe(false);
    expect(step.state.notices.map((notice) => notice.code)).toEqual(["ime_prefix"]);
    // a second time replaces the notice instead of stacking it
    const again = after(step.state, prefix(), text("\u{d55c}"));
    expect(again.notices.map((notice) => notice.code)).toEqual(["ime_prefix"]);
    // an unbound ASCII key after the prefix is dropped without that notice
    expect(after(armed, text("y")).notices).toEqual([]);
  });
});

describe("hangul once", () => {
  const word = "\u{d55c}\u{ae00}";

  it("reaches the pane exactly once, whole or cut at every offset", () => {
    const whole = reduce(idle, text(word));
    expect(paneInputs(whole.effects).map((input) => input.type === "text" && input.text)).toEqual([word]);
    const bytes = new TextEncoder().encode(word);
    for (let cut = 1; cut < bytes.length; cut++) {
      const framer = new Framer();
      const events = [...framer.feed(bytes.slice(0, cut), AT), ...framer.feed(bytes.slice(cut), AT + 1)];
      let state = idle;
      const sent: string[] = [];
      for (const event of events) {
        const step = reduce(state, event);
        const inputs = paneInputs(step.effects);
        expect(inputs.length).toBeLessThanOrEqual(1);
        for (const input of inputs) sent.push(input.type === "text" ? input.text : "?");
        state = step.state;
      }
      expect({ cut, sent: sent.join("") }).toEqual({ cut, sent: word });
    }
  });

  it("when Armed, the first is dropped as the key after the prefix and the second reaches the pane once", () => {
    const step = reduce(armed, text(word));
    expect(paneInputs(step.effects).map((input) => input.type === "text" && input.text)).toEqual(["\u{ae00}"]);
    expect(step.state.armed).toBe(false);
  });

  it("in a rename field inserts two graphemes", () => {
    const renaming = after(idle, prefix(), key("P"));
    expect(renaming.overlays).toEqual([expect.objectContaining({ kind: "text", purpose: "rename_pane" })]);
    const step = reduce(renaming, text(word));
    expect(paneInputs(step.effects)).toEqual([]);
    const top = step.state.overlays.at(-1)!;
    expect(top.kind === "text" && top.field.graphemes).toEqual(["\u{d55c}", "\u{ae00}"]);
  });

  it("in a rename field, a grapheme grown by marks in reads of their own stops at the code-point budget, and what the field held stays whole", () => {
    const renaming = after(idle, prefix(), key("P"));
    const shown = (state: ModelState) => { const top = state.overlays.at(-1)!; return top.kind === "text" ? top.field.graphemes : []; };
    // a letter, then a mark at a time, each joining the grapheme before the cursor: it grows only to the budget
    let state = after(renaming, text("ab"));
    for (let n = 0; n < TEXT_FIELD_MAX_CODE_POINTS; n++) state = reduce(state, text("\u0301")).state;
    expect([shown(state).length, shown(state)[0], shown(state)[1]![0], [...shown(state).join("")].length]).toEqual([2, "a", "b", TEXT_FIELD_MAX_CODE_POINTS]);
    // one read of endless marks stops at the same budget
    expect([...shown(after(renaming, text("ab"), text("\u0301".repeat(4 * TEXT_FIELD_MAX_CODE_POINTS)))).join("")]).toEqual([...shown(state).join("")]);
    // one code point of room: a letter is taken and its mark refused, typed or pasted alike; then nothing more fits
    const nearly = after(renaming, text(`x${"\u0301".repeat(TEXT_FIELD_MAX_CODE_POINTS - 2)}`));
    const typed = after(nearly, text("e\u0301"));
    expect([shown(nearly).length, shown(typed), shown(after(nearly, paste("e\u0301")))]).toEqual([1, [...shown(nearly), "e"], [...shown(nearly), "e"]]);
    expect(shown(after(typed, text("z")))).toEqual(shown(typed));
  });

  it("in a rename field, Enter on a name past the field's bound left as shown renames nothing; an edit renames", () => {
    // one grapheme longer than the code-point budget: the field shows it cut
    const long = `e${"\u0301".repeat(2 * TEXT_FIELD_MAX_CODE_POINTS)}`;
    const named = reduce(initialState(undefined), { type: "world", world: { workspaces: [{ id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: long }] }] }] }, at: 0 }).state;
    const renaming = after(named, prefix(), key("P"));
    const enter = (state: ModelState) => reduce(state, { type: "key", key: "ENTER", mods: {}, action: "press", at: AT });
    const kept = enter(renaming);
    expect([kept.effects, kept.state.overlays]).toEqual([[], []]);
    const edited = enter(after(renaming, text("x")));
    expect(edited.effects).toEqual([{ type: "run", action: "rename_pane", target: { kind: "pane", id: "p1" }, index: null, name: "x" }]);
  });

  it("renames to the displayed prefix only when the user edits the field", () => {
    const prefixName = "x".repeat(TEXT_FIELD_MAX_GRAPHEMES);
    const rename = (name: string, ...events: ModelEvent[]) => {
      const workspace = { ...WORLD.workspaces[0]!, name };
      const state = after(idle, { type: "world", world: { workspaces: [workspace] }, at: 0 });
      const open = after(state, { type: "action", action: "rename_workspace", at: AT });
      return reduce(after(open, ...events), named("ENTER")).effects;
    };
    const long = `${prefixName}y`;
    const expected: Effect[] = [{ type: "run", action: "rename_workspace", target: { kind: "workspace", id: "w1" }, index: null, name: prefixName }];
    expect(rename(long)).toEqual([]);
    expect(rename(long, named("HOME"), named("END"))).toEqual([]);
    expect(rename(long, named("END"), named("DELETE"), text("z"))).toEqual([]); // no deletion and no room
    expect(rename(long, paste(prefixName))).toEqual(expected);
    expect(rename(long, named("END"), named("BACKSPACE"), text("x"))).toEqual(expected);
    expect(rename(prefixName, paste(prefixName))).toEqual([]); // explicitly replaced, but identical to the stored name
  });
});

describe("overlay close keys", () => {
  it("every key an overlay declares closes it, and is the one way a key closes it", () => {
    const open: Record<keyof typeof OVERLAYS, ModelState> = {
      help: after(idle, prefix(), text("?")),
      text: after(idle, prefix(), key("P")),
      confirm: after(idle, prefix(), key("D")),
      goto: after(idle, prefix(), text("g")),
      menu: after(idle, prefix(), named("ENTER")),
    };
    for (const [kind, entry] of Object.entries(OVERLAYS)) {
      const state = open[kind as keyof typeof OVERLAYS];
      expect(state.overlays.map((overlay): string => overlay.kind)).toEqual([kind]);
      for (const closeKey of entry.closeKeys) {
        const event = closeKey === "esc" ? named("ESCAPE") : key(closeKey);
        expect({ kind, closeKey, open: reduce(state, event).state.overlays.length }).toEqual({ kind, closeKey, open: 0 });
      }
    }
    // a key that is not declared does not close help
    expect(reduce(open.help, key("x")).state.overlays.length).toBe(1);
  });

  it("a click on an overlay's close control closes it as its first close key does; with none open it changes nothing", () => {
    const close: ModelEvent = { type: "close_overlay", at: AT };
    for (const state of [after(idle, prefix(), text("?")), after(idle, prefix(), key("P")), after(idle, prefix(), key("D")), after(idle, prefix(), text("g")), after(idle, prefix(), named("ENTER"))]) {
      const kind = state.overlays.at(-1)!.kind;
      const [clicked, escaped] = [reduce(state, close), reduce(state, named("ESCAPE"))];
      expect({ kind, state: clicked.state, effects: clicked.effects }).toEqual({ kind, state: escaped.state, effects: escaped.effects });
      expect({ kind, open: reduce(state, close).state.overlays.length }).toEqual({ kind, open: 0 });
    }
    expect(reduce(idle, close).state).toBe(idle);
  });
});

describe("focus moves by key stay local", () => {
  it("cycles panes and keeps the previous pane", () => {
    const moved = after(idle, prefix(), named("TAB"));
    expect(focusedPane(moved)).toBe("p2");
    expect(moved.focus.previous).toBe("p1");
    expect(focusedPane(after(moved, prefix(), named("TAB", { shift: true })))).toBe("p1");
  });
});

describe("layout actions as data", () => {
  // created_ms of each terminal as the world shows it: what a close carries so a terminal made later at the same address is not ended
  const SEEN_WORLD: World = {
    workspaces: [
      { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "", created: 11 }, { id: "p2", name: "", created: 12 }] }, { id: "t2", name: "b", panes: [{ id: "p3", name: "", created: 13 }] }] },
      { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "", created: 14 }] }] },
    ],
  };
  const seen = reduce(initialState(undefined), { type: "world", world: SEEN_WORLD, at: 0 }).state;
  const runs = (step: Step) => step.effects.filter((effect) => effect.type === "run");
  const onW2 = after(seen, { type: "select", target: { kind: "workspace", id: "w2" }, at: AT });
  const onT2 = after(seen, { type: "select", target: { kind: "tab", id: "t2" }, at: AT });

  it("close pane and close tab end at once with what the screen showed; a close that ends a whole workspace asks first", () => {
    const rows: [string, ModelState, string, { run: unknown[]; overlays: unknown[] }][] = [
      ["close pane of a split tab", seen, "close_pane", { run: [{ type: "run", action: "close_pane", target: { kind: "pane", id: "p1" }, index: null, name: null, seen: [{ id: "p1", created: 11 }] }], overlays: [] }],
      ["close tab of two", seen, "close_tab", { run: [{ type: "run", action: "close_tab", target: { kind: "tab", id: "t1" }, index: null, name: null, seen: [{ id: "p1", created: 11 }, { id: "p2", created: 12 }] }], overlays: [] }],
      ["close pane of a one-pane workspace", onW2, "close_pane", { run: [], overlays: [{ kind: "confirm", purpose: "close_workspace", target: { kind: "workspace", id: "w2" }, seen: [{ id: "p4", created: 14 }] }] }],
      ["close tab of a one-tab workspace", onW2, "close_tab", { run: [], overlays: [{ kind: "confirm", purpose: "close_workspace", target: { kind: "workspace", id: "w2" }, seen: [{ id: "p4", created: 14 }] }] }],
      ["close pane of a one-pane tab beside others", onT2, "close_pane", { run: [{ type: "run", action: "close_pane", target: { kind: "pane", id: "p3" }, index: null, name: null, seen: [{ id: "p3", created: 13 }] }], overlays: [] }],
      ["close workspace", seen, "close_workspace", { run: [], overlays: [{ kind: "confirm", purpose: "close_workspace", target: { kind: "workspace", id: "w1" }, seen: [{ id: "p1", created: 11 }, { id: "p2", created: 12 }, { id: "p3", created: 13 }] }] }],
    ];
    for (const [name, state, action, want] of rows) {
      const step = reduce(state, { type: "action", action: action as "close_pane", at: AT });
      expect({ name, run: runs(step), overlays: step.state.overlays } as unknown).toEqual({ name, run: want.run, overlays: want.overlays });
    }
  });

  it("the confirm dialog's yes carries the terminals it kept; its no ends nothing", () => {
    const asking = after(seen, { type: "action", action: "close_workspace", at: AT });
    const yes = reduce(asking, key("y"));
    expect(runs(yes)).toEqual([{ type: "run", action: "close_workspace", target: { kind: "workspace", id: "w1" }, index: null, name: null, seen: [{ id: "p1", created: 11 }, { id: "p2", created: 12 }, { id: "p3", created: 13 }] }]);
    const no = reduce(asking, key("n"));
    expect([runs(no), no.state.overlays]).toEqual([[], []]);
  });

  it("follow: focus moves to a new pane once the world shows it, to a moved one once it left its tab, and not after another focus move", () => {
    const grown: World = { workspaces: [...SEEN_WORLD.workspaces, { id: "w3", name: "new", tabs: [{ id: "t9", name: "n", panes: [{ id: "p9", name: "" }] }] }] };
    const waiting = after(seen, { type: "follow", target: { kind: "pane", id: "p9" }, away: null, at: AT });
    expect([waiting.focus.workspace, waiting.following]).toEqual(["w1", { target: { kind: "pane", id: "p9" }, away: null }]);
    const shown = after(waiting, { type: "world", world: grown, at: AT });
    expect([shown.focus.workspace, focusedPane(shown), shown.following]).toEqual(["w3", "p9", null]);
    const dropped = after(waiting, { type: "select", target: { kind: "tab", id: "t2" }, at: AT }, { type: "world", world: grown, at: AT });
    expect([dropped.focus.workspace, focusedPane(dropped), dropped.following]).toEqual(["w1", "p3", null]);
    const moving = after(seen, { type: "follow", target: { kind: "pane", id: "p2" }, away: "t1", at: AT });
    expect([focusedPane(moving), moving.following?.target.id]).toEqual(["p1", "p2"]);
    const moved: World = { workspaces: [SEEN_WORLD.workspaces[0]!, { ...SEEN_WORLD.workspaces[1]!, tabs: [...SEEN_WORLD.workspaces[1]!.tabs, { id: "t8", name: "x", panes: [{ id: "p2", name: "" }] }] }].map((workspace) => workspace.id === "w1" ? { ...workspace, tabs: [{ ...workspace.tabs[0]!, panes: [workspace.tabs[0]!.panes[0]!] }, workspace.tabs[1]!] } : workspace) };
    const there = after(moving, { type: "world", world: moved, at: AT });
    expect([there.focus.workspace, focusedPane(there), there.following]).toEqual(["w2", "p2", null]);
  });

  it("navigate mode moves the workspace it points at with shift+up and shift+down, and the focused pane into it with m", () => {
    const pointing = after(seen, prefix(), text("w"), named("ARROW_DOWN"));
    expect(pointing.mode).toEqual({ name: "navigate", preview: "w2" });
    const up = reduce(pointing, named("ARROW_UP", { shift: true }));
    expect([runs(up), up.state.mode.name]).toEqual([[{ type: "run", action: "navigate_move_up", target: { kind: "workspace", id: "w2" }, index: null, name: null }], "navigate"]);
    const down = reduce(pointing, named("ARROW_DOWN", { shift: true }));
    expect(runs(down)).toEqual([{ type: "run", action: "navigate_move_down", target: { kind: "workspace", id: "w2" }, index: null, name: null }]);
    const move = reduce(pointing, text("m"));
    expect([runs(move), move.state.mode.name]).toEqual([[{ type: "run", action: "navigate_move_pane", target: { kind: "pane", id: "p1" }, index: null, name: "a", to: "w2" }], "terminal"]);
    expect(modeBar(pointing).hints.filter((hint) => hint.action.startsWith("navigate_move")).map((hint) => hint.keys)).toEqual([["shift+up"], ["shift+down"], ["m"]]);
  });

  it("a calm notice is marked calm; any other is not", () => {
    const calm = after(seen, { type: "notice", code: "layout_unchanged", data: { action: "zoom", reason: "single_pane" }, calm: true, at: AT });
    const plain = after(seen, { type: "notice", code: "layout_refused", data: { action: "zoom", reason: "x" }, at: AT });
    expect([calm.notices.map((notice) => notice.calm), plain.notices.map((notice) => notice.calm)]).toEqual([[true], [undefined]]);
  });
});

describe("the pane looked at before", () => {
  it("is the pane last shown: selecting a pane a zoom keeps covered leaves it, so last_pane goes back to the pane left", () => {
    const world: World = { workspaces: [{ id: "w", name: "w", tabs: [
      { id: "ta", name: "a", panes: [{ id: "A", name: "" }] },
      { id: "tb", name: "b", panes: [{ id: "B", name: "" }, { id: "C", name: "" }], zoomed: "B" },
    ] }] };
    const seen = reduce(initialState(undefined), { type: "world", world, at: 0 }).state;
    const shown = (state: ModelState) => focused(state.world, state.focus).pane?.id;
    const zoomed = after(seen, { type: "select", target: { kind: "tab", id: "tb" }, at: AT });
    const cycled = after(zoomed, { type: "action", action: "cycle_pane_next", at: AT });
    const back = after(cycled, { type: "action", action: "last_pane", at: AT });
    expect([shown(seen), shown(zoomed), shown(cycled), cycled.focus.previous, shown(back)]).toEqual(["A", "B", "B", "A", "A"]);
  });
});
