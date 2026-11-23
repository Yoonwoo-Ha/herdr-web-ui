import { describe, expect, it } from "bun:test";
import { type Mods, typedKey } from "../input/decode.ts";
import { Framer } from "../input/framer.ts";
import { resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import type { World } from "./focus.ts";
import { cleanConfigText, helpRows, modeBar, shownRefusals } from "./hints.ts";
import { buildKeymap, type DropCode } from "./keymap.ts";
import { initialState, type ModelEvent, type ModelState, reduce, type Step } from "./reduce.ts";

const AT = 1_000;
const WORLD: World = { workspaces: [{ id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }] }] }] };
const key = (char: string, mods: Mods = {}): ModelEvent => ({ ...typedKey(char, mods), at: AT });
const start = (keys?: unknown): ModelState => reduce(initialState(keys), { type: "world", world: WORLD, at: 0 }).state;
const sentToPane = (state: ModelState, event: ModelEvent) => reduce(state, event).effects.filter((effect) => effect.type === "pane").length;

/** `reads` typed by a host, each read waited out (so a lone ESC is Escape), through the framer and decoder into the reducer. */
function typed(state: ModelState, ...reads: string[]): Pick<Step, "state" | "effects"> {
  const framer = new Framer();
  const effects: Step["effects"][number][] = [];
  reads.forEach((read, i) => {
    for (const event of [...framer.feed(Uint8Array.from(read, (c) => c.charCodeAt(0)), AT + i * 1_000), ...framer.tick(AT + i * 1_000 + 999)]) {
      const step = reduce(state, event);
      state = step.state;
      effects.push(...step.effects);
    }
  });
  return { state, effects };
}
/** What running `action` itself does in `state`. */
const asAction = (state: ModelState, action: string, index?: number) => {
  const step = reduce(state, { type: "action", action, index, at: AT } as ModelEvent);
  return { state: step.state, effects: step.effects };
};
const noteFor = (state: ModelState | ReturnType<typeof buildKeymap>, action: string) => ("keymap" in state ? state.keymap : state).notes.filter((note) => "action" in note && note.action === action);

describe("the menu's key", () => {
  it("Enter after the prefix opens the menu; a config binding on prefix+enter is dropped with a fixed_key note", () => {
    const keymap = buildKeymap({ new_tab: "prefix+enter" });
    expect(keymap.notes).toEqual([{ code: "fixed_key", action: "new_tab", binding: "prefix+enter" }]);
    expect(keymap.rows.find((row) => row.action === "menu")!.bindings.map((binding) => binding.text)).toEqual(["prefix+enter"]);
    expect(keymap.rows.find((row) => row.action === "new_tab")!.bindings).toEqual([]);
    const opened = typed(start({ new_tab: "prefix+enter" }), "\x02", "\r").state;
    expect(opened.overlays.map((overlay) => overlay.kind)).toEqual(["menu"]);
  });
});

describe("prefix+i", () => {
  it("is no key of the screen's, as in herdr: a binding of the config on it is kept with no note", () => {
    const keymap = buildKeymap({ new_tab: "prefix+i" });
    expect(keymap.notes).toEqual([]);
    expect(keymap.rows.find((row) => row.action === "new_tab")!.bindings.map((binding) => binding.text)).toEqual(["prefix+i"]);
  });
});

describe("the keymap table", () => {
  it("has one row per herdr action, with the resolver's default and bindings, in Terminal mode", () => {
    for (const keys of [undefined, { prefix: "ctrl+a" }, { new_tab: "alt+t" }, { zoom: "" }]) {
      const resolved = resolveAllHerdrKeys(keys);
      const rows = buildKeymap(keys).rows.filter((row) => row.source === "herdr" && row.mode === "terminal");
      expect(rows.map(({ action, default: d, bindings }) => ({ action, default: d, bindings })))
        .toEqual(resolved.actions.map(({ action, default: d, bindings }) => ({ action, default: d, bindings })));
    }
  });

  it("holds herdr's six navigate keys in Navigate mode, the arrows fixed first, then the tab and workspace moves without the prefix", () => {
    const rows = buildKeymap(undefined).rows.filter((row) => row.mode === "navigate" && row.source === "herdr");
    expect(rows.map((row) => [row.action, row.bindings.map((binding) => binding.text)])).toEqual([
      ["navigate_workspace_up", ["up"]], ["navigate_workspace_down", ["down"]], ["navigate_pane_left", ["left", "h"]],
      ["navigate_pane_down", ["j"]], ["navigate_pane_up", ["k"]], ["navigate_pane_right", ["right", "l"]],
      ["next_tab", ["n"]], ["previous_tab", ["p"]], ["next_workspace", []], ["previous_workspace", []],
    ]);
  });

  it("follows a changed prefix, a direct Alt binding and an unbound action", () => {
    const changed = buildKeymap({ prefix: "ctrl+a" });
    expect(changed.prefixes.map((prefix) => prefix.text)).toEqual(["ctrl+a"]);
    const alt = buildKeymap({ split_vertical: ["prefix+v", "alt+v"] });
    expect(Object.values(alt.direct)).toContainEqual({ action: "split_vertical", index: null });
    const unbound = buildKeymap({ zoom: "" });
    expect(unbound.rows.find((row) => row.action === "zoom")!.bindings).toEqual([]);
    expect(Object.values(unbound.afterPrefix).some((bound) => bound.action === "zoom")).toBe(false);
  });

  it("gives the lock its chord only while nothing of herdr's holds it", () => {
    expect(buildKeymap(undefined).rows.find((row) => row.action === "lock")!.bindings.map((binding) => binding.text)).toEqual(["ctrl+alt+g"]);
    const taken = buildKeymap({ new_tab: "ctrl+alt+g" });
    expect(taken.rows.find((row) => row.action === "lock")!.bindings).toEqual([]);
    expect(taken.notes).toContainEqual({ code: "lock_taken", holder: "new_tab" });
    expect(buildKeymap({ prefix: "ctrl+alt+g" }).notes).toContainEqual({ code: "lock_taken", holder: "prefix" });
  });

  it("names what holds no key and no refusal", () => {
    expect(buildKeymap({ indexed: { tabs: "ctrl" }, zoom: " " }).notes).toEqual([{ code: "indexed_legacy", entry: "tabs" }, { code: "blank_binding", action: "zoom" }]);
  });

  it("keymap reload", () => {
    const armed = reduce(start(), key("b", { ctrl: true })).state;
    expect(armed.armed).toBe(true);
    const reloaded = reduce(armed, { type: "keys", keys: { prefix: "ctrl+a", new_tab: "prefix+t" }, at: AT });
    expect(reloaded.effects).toEqual([]);
    const state = reloaded.state;
    // an armed prefix returns to Idle
    expect(state.armed).toBe(false);
    // the old prefix is typed into the pane, the new one arms
    expect(sentToPane(state, key("b", { ctrl: true }))).toBe(1);
    const rearmed = reduce(state, key("a", { ctrl: true })).state;
    expect(rearmed.armed).toBe(true);
    // the mode bar and the help follow the new table
    expect(modeBar(rearmed)!.hints.find((hint) => hint.label === "sendPrefix")!.key).toBe("ctrl+a");
    expect(helpRows(state.keymap).find((row) => row.action === "new_tab")!.keys).toEqual(["prefix+t"]);
    // a config with refusals answers one notice with their count
    const refused = reduce(state, { type: "keys", keys: { new_tab: "prefix+nonsense+x", zoom: "q", bogus: "x" }, at: AT }).state;
    expect(refused.notices.map((notice) => [notice.code, notice.data])).toEqual([["keys_refused", { count: 3 }]]);
    // a config of the wrong type is not read at all: herdr's defaults stand
    const unread = reduce(state, { type: "keys", keys: { prefix: 5 }, at: AT }).state;
    expect(unread.keymap.prefixes.map((prefix) => prefix.text)).toEqual(["ctrl+b"]);
    expect(unread.notices.map((notice) => notice.code)).toEqual(["keys_unread"]);
  });

  it("unlocks on a reload that takes the unlock chord away", () => {
    const locked = reduce(start(), key("g", { ctrl: true, alt: true })).state;
    expect(locked.locked).toBe(true);
    const step = reduce(locked, { type: "keys", keys: { new_tab: "ctrl+alt+g" }, at: AT });
    expect(step.state.locked).toBe(false);
    // the lost chord is also one of the config's notes
    expect(step.state.notices.map((notice) => notice.code)).toEqual(["unlocked", "keys_refused"]);
  });

  it("drops a binding after the prefix that Escape's cancel always wins over, so matching, mode bar and help agree", () => {
    const keymap = buildKeymap({ help: ["prefix+?", "prefix+esc"], zoom: "prefix+ctrl+[" });
    expect(keymap.notes).toEqual([{ code: "cancel_key", action: "help", binding: "prefix+esc" }, { code: "cancel_key", action: "zoom", binding: "prefix+ctrl+[" }]);
    expect(helpRows(keymap).find((row) => row.action === "help")!.keys).toEqual(["prefix+?"]);
    expect(helpRows(keymap).find((row) => row.action === "zoom")!.keys).toEqual([]);
    expect(Object.values(keymap.afterPrefix).some((bound) => bound.action === "zoom")).toBe(false);
    const armed = reduce(reduce(initialState({ help: ["prefix+?", "prefix+esc"] }), { type: "world", world: WORLD, at: 0 }).state, key("b", { ctrl: true })).state;
    expect(modeBar(armed)!.hints.find((hint) => hint.label === "keybinds")!.key).toBe("?");
    const escaped = reduce(armed, { type: "key", key: "ESCAPE", mods: {}, action: "press", at: AT }).state;
    expect({ armed: escaped.armed, overlays: escaped.overlays }).toEqual({ armed: false, overlays: [] });
  });

  it("drops every binding no input event can fire, with one note naming why, and the action shows no key for it", () => {
    const rows: { keys: Record<string, unknown>; action: string; note: Record<string, string> }[] = [
      { keys: { new_tab: "prefix+\u314a" }, action: "new_tab", note: { code: "not_typable", action: "new_tab", binding: "prefix+\u314a" } },
      { keys: { split_vertical: "prefix+hyper+v" }, action: "split_vertical", note: { code: "no_such_modifier", action: "split_vertical", binding: "prefix+hyper+v" } },
      { keys: { navigate_pane_down: "left" }, action: "navigate_pane_down", note: { code: "fixed_key", action: "navigate_pane_down", binding: "left" } },
      { keys: { navigate_pane_up: "shift+tab" }, action: "navigate_pane_up", note: { code: "fixed_key", action: "navigate_pane_up", binding: "shift+tab" } },
      { keys: { zoom: "prefix+shift+space" }, action: "zoom", note: { code: "shift_in_text", action: "zoom", binding: "prefix+shift+space" } },
      { keys: { zoom: "ctrl+!" }, action: "zoom", note: { code: "shifted_character", action: "zoom", binding: "ctrl+!" } },
      { keys: { zoom: "prefix+f30" }, action: "zoom", note: { code: "not_typable", action: "zoom", binding: "prefix+f30" } },
      { keys: { zoom: "prefix+esc" }, action: "zoom", note: { code: "cancel_key", action: "zoom", binding: "prefix+esc" } },
    ];
    for (const row of rows) {
      const keymap = buildKeymap(row.keys);
      const label = JSON.stringify(row.keys);
      const notes: unknown[] = keymap.notes.filter((note) => "action" in note && note.action === row.action);
      expect({ label, notes }).toEqual({ label, notes: [row.note] });
      const shown = helpRows(keymap).filter((help) => help.action === row.action && help.mode === (row.action.startsWith("navigate") ? "navigate" : "terminal"));
      expect({ label, keys: shown.flatMap((help) => help.keys).filter((text) => text === row.note.binding) }).toEqual({ label, keys: [] });
      expect({ label, notice: reduce(start(), { type: "keys", keys: row.keys, at: AT }).state.notices.map((notice) => notice.code) }).toEqual({ label, notice: ["keys_refused"] });
    }
    // the verifier's two repros: nothing shown for those keys, and the action has no key
    const repro = buildKeymap({ new_tab: "prefix+\u314a", split_vertical: "prefix+hyper+v" });
    const armed = reduce(reduce(initialState({ new_tab: "prefix+\u314a", split_vertical: "prefix+hyper+v" }), { type: "world", world: WORLD, at: 0 }).state, key("b", { ctrl: true })).state;
    expect(modeBar(armed)!.hints.filter((hint) => hint.key.includes("\u314a") || hint.key.includes("hyper"))).toEqual([]);
    expect(helpRows(repro).filter((help) => help.action === "new_tab" || help.action === "split_vertical").map((help) => help.keys)).toEqual([[], []]);
    const navigate = buildKeymap({ navigate_pane_down: "left", navigate_pane_up: "shift+tab" });
    expect(navigate.notes).toEqual([{ code: "fixed_key", action: "navigate_pane_down", binding: "left" }, { code: "fixed_key", action: "navigate_pane_up", binding: "shift+tab" }]);
  });

  it("gives the lock's chord to a custom command that binds it, with a note", () => {
    const keymap = buildKeymap({ command: [{ key: "ctrl+alt+g", command: "x" }] });
    expect(keymap.rows.find((row) => row.action === "lock")!.bindings).toEqual([]);
    expect(keymap.notes).toEqual([{ code: "lock_taken", holder: "command" }]);
  });

  it("shows a range that lost a digit as the digits it still holds", () => {
    const keymap = buildKeymap({ copy_mode: "prefix+9" });
    expect(helpRows(keymap).find((row) => row.action === "switch_tab")!.keys).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((digit) => `prefix+${digit}`));
  });

  it("shifted digit binding by bytes", () => {
    const twoWorkspaces: World = { workspaces: [WORLD.workspaces[0]!, { id: "w2", name: "two", tabs: [{ id: "t2", name: "b", panes: [{ id: "p2", name: "" }] }] }] };
    const keys = { switch_workspace: "prefix+shift+1..9" };
    const state = reduce(initialState(keys), { type: "world", world: twoWorkspaces, at: 0 }).state;
    // shift+2 is "@" in legacy bytes and CSI 50;2u with the kitty flag
    for (const shift2 of ["@", "\x1b[50;2u"]) {
      expect({ shift2, workspace: typed(state, "\x02", shift2).state.focus.workspace }).toEqual({ shift2, workspace: "w2" });
    }
    expect(noteFor(state, "switch_workspace")).toEqual([]);
    expect(helpRows(state.keymap).find((row) => row.action === "switch_workspace")!.keys).toEqual(["prefix+shift+1..9"]);

    // one shifted punctuation after the prefix, and alt with a shifted digit as a direct binding
    const single = start({ toggle_sidebar: "prefix+shift+;", zoom: "alt+shift+1" });
    expect(single.keymap.notes).toEqual([]);
    const armed = typed(single, "\x02").state;
    for (const colon of [":", "\x1b[59;2u"]) expect({ colon, step: typed(armed, colon) }).toEqual({ colon, step: asAction(armed, "toggle_sidebar") });
    for (const bang of ["\x1b!", "\x1b[49;4u"]) expect({ bang, step: typed(single, bang) }).toEqual({ bang, step: asAction(single, "zoom") });
    expect(["toggle_sidebar", "zoom"].map((action) => helpRows(single.keymap).find((row) => row.action === action)!.keys)).toEqual([["prefix+shift+;"], ["alt+shift+1"]]);

    // "@" and shift+2 are one key here: herdr's duplicate rule picks (the earlier field), the other is noted
    const both = start({ new_tab: "prefix+@", split_vertical: "prefix+shift+2" });
    expect(both.keymap.notes).toEqual([{ code: "taken", action: "split_vertical", binding: "prefix+shift+2", holder: "new_tab" }]);
    expect(typed(both, "\x02", "@").state.overlays).toEqual([expect.objectContaining({ kind: "text", purpose: "new_tab" })]);
    expect(helpRows(both.keymap).find((row) => row.action === "split_vertical")!.keys).toEqual([]);
    // a binding the config writes beats a default on that key, written shifted or as the character: the default
    // stands down silently either way, as herdr's resolver does for the character
    for (const zoom of ["prefix+shift+/", "prefix+?"]) {
      const over = start({ zoom });
      expect({ zoom, notes: over.keymap.notes, notices: reduce(start(), { type: "keys", keys: { zoom }, at: AT }).state.notices }).toEqual({ zoom, notes: [], notices: [] });
      expect({ zoom, help: helpRows(over.keymap).find((row) => row.action === "help")!.keys }).toEqual({ zoom, help: [] });
      expect(typed(over, "\x02", "?")).toEqual(asAction(typed(over, "\x02").state, "zoom"));
    }
    // a range that loses one digit keeps the other eight
    const range = buildKeymap({ switch_workspace: "prefix+shift+1..9", new_tab: "prefix+#" });
    expect(range.notes).toEqual([{ code: "taken", action: "switch_workspace", binding: "prefix+shift+3", holder: "new_tab" }]);
    expect(helpRows(range).find((row) => row.action === "switch_workspace")!.keys).toEqual([1, 2, 4, 5, 6, 7, 8, 9].map((digit) => `prefix+shift+${digit}`));
  });

  it("untypable prefix falls back by bytes", () => {
    const reasons: Record<string, DropCode> = { "hyper+b": "no_such_modifier", f30: "not_typable", "ctrl+!": "shifted_character", "\u314a": "not_typable" };
    for (const [prefix, reason] of Object.entries(reasons)) {
      const state = start({ prefix });
      // ctrl+b as a legacy byte and as the kitty report, then q: herdr's detach
      for (const ctrlB of ["\x02", "\x1b[98;5u"]) {
        expect({ prefix, ctrlB, effects: typed(state, ctrlB, "q").effects }).toEqual({ prefix, ctrlB, effects: [{ type: "quit" }] });
      }
      expect({ prefix, notes: state.keymap.notes }).toEqual({ prefix, notes: [{ code: "prefix_fallback", action: "prefix", binding: prefix, reason, fallback: "ctrl+b", skipped: [] }] });
      expect(modeBar(typed(state, "\x02").state)!.hints.find((hint) => hint.label === "sendPrefix")!.key).toBe("ctrl+b");
    }
    // ctrl+b held by a direct binding of the config: the next free key of the list
    const held = start({ prefix: "hyper+b", zoom: "ctrl+b" });
    expect(noteFor(held, "prefix")).toEqual([{ code: "prefix_fallback", action: "prefix", binding: "hyper+b", reason: "no_such_modifier", fallback: "ctrl+a", skipped: [{ key: "ctrl+b", holder: "zoom" }] }]);
    expect(typed(held, "\x01", "q").effects).toEqual([{ type: "quit" }]);
    expect(typed(held, "\x02")).toEqual(asAction(held, "zoom"));
    // held by a custom command, or by a binding after the prefix (the prefix twice would send it): skipped as well
    const byCommand = start({ prefix: "hyper+b", command: [{ key: "ctrl+b", command: "x" }] });
    expect(noteFor(byCommand, "prefix")).toEqual([{ code: "prefix_fallback", action: "prefix", binding: "hyper+b", reason: "no_such_modifier", fallback: "ctrl+a", skipped: [{ key: "ctrl+b", holder: "command" }] }]);
    expect(typed(byCommand, "\x01", "q").effects).toEqual([{ type: "quit" }]);
    const afterHeld = start({ prefix: "hyper+b", zoom: "prefix+ctrl+b" });
    expect(afterHeld.keymap.notes).toEqual([{ code: "prefix_fallback", action: "prefix", binding: "hyper+b", reason: "no_such_modifier", fallback: "ctrl+a", skipped: [{ key: "ctrl+b", holder: "zoom" }] }]);
    expect(typed(afterHeld, "\x01", "\x02")).toEqual(asAction(typed(afterHeld, "\x01").state, "zoom"));

    // a reload to a typable prefix and back: the fallback and its note come and go, an armed prefix returns to Idle
    const armed = typed(start({ prefix: "hyper+b" }), "\x02").state;
    expect(armed.armed).toBe(true);
    const typable = reduce(armed, { type: "keys", keys: { prefix: "ctrl+a" }, at: AT }).state;
    expect({ armed: typable.armed, notes: typable.keymap.notes, prefixes: typable.keymap.prefixes.map((p) => p.text) }).toEqual({ armed: false, notes: [], prefixes: ["ctrl+a"] });
    expect(typed(typable, "\x02").effects.map((effect) => effect.type)).toEqual(["pane"]);
    const back = reduce(typed(typable, "\x01").state, { type: "keys", keys: { prefix: "hyper+b" }, at: AT }).state;
    expect({ armed: back.armed, notes: back.keymap.notes.map((note) => note.code), prefixes: back.keymap.prefixes.map((p) => p.text) }).toEqual({ armed: false, notes: ["prefix_fallback"], prefixes: ["ctrl+b"] });

    // no key of detach can fire: herdr's prefix+q quits, or the next free key after the prefix
    for (const detach of ["", "prefix+hyper+q", "ctrl+!"]) {
      const state = start({ detach });
      expect({ detach, effects: typed(state, "\x02", "q").effects }).toEqual({ detach, effects: [{ type: "quit" }] });
      expect({ detach, note: state.keymap.notes.filter((note) => note.code === "detach_fallback") }).toEqual({ detach, note: [{ code: "detach_fallback", fallback: "prefix+q", skipped: [] }] });
    }
    const qHeld = start({ detach: "", zoom: "prefix+q" });
    expect(qHeld.keymap.notes).toEqual([{ code: "detach_fallback", fallback: "prefix+ctrl+q", skipped: [{ key: "prefix+q", holder: "zoom" }] }]);
    expect(typed(qHeld, "\x02", "\x11").effects).toEqual([{ type: "quit" }]);
    // the prefix on herdr's detach key: herdr refuses the detach binding, the fallback quits
    const same = start({ prefix: "ctrl+q", detach: "ctrl+q" });
    expect(typed(same, "\x11", "q").effects).toEqual([{ type: "quit" }]);
  });

  it("a fallback never takes a bound key", () => {
    // every detach fallback held by the user's bindings: each keeps its key, detach has none, one note says so
    const keys = { close_pane: "prefix+q", zoom: "prefix+ctrl+q", new_tab: "prefix+alt+q" };
    const state = start(keys);
    const armed = typed(state, "\x02").state;
    expect(typed(state, "\x02", "q")).toEqual(asAction(armed, "close_pane"));
    expect(typed(state, "\x02", "\x11")).toEqual(asAction(armed, "zoom"));
    expect(typed(state, "\x02", "\x1bq").state.overlays).toEqual([expect.objectContaining({ kind: "text", purpose: "new_tab" })]);
    expect(helpRows(state.keymap).find((row) => row.action === "detach")!.keys).toEqual([]);
    expect(state.keymap.notes).toEqual([{ code: "detach_unreachable", skipped: [{ key: "prefix+q", holder: "close_pane" }, { key: "prefix+ctrl+q", holder: "zoom" }, { key: "prefix+alt+q", holder: "new_tab" }] }]);
    expect(reduce(state, { type: "action", action: "detach", at: AT }).effects).toEqual([{ type: "quit" }]);

    // every prefix fallback held by a direct binding and the configured prefix untypable: each binding keeps its key,
    // nothing arms, one note says so
    const direct = { prefix: "hyper+b", zoom: "ctrl+b", new_tab: "ctrl+a", split_vertical: "ctrl+]", split_horizontal: "ctrl+\\" };
    const noPrefix = start(direct);
    for (const [read, action] of [["\x02", "zoom"], ["\x1c", "split_horizontal"], ["\x1d", "split_vertical"]] as const) {
      expect({ read, step: typed(noPrefix, read) }).toEqual({ read, step: asAction(noPrefix, action) });
    }
    expect(typed(noPrefix, "\x01").state.overlays).toEqual([expect.objectContaining({ kind: "text", purpose: "new_tab" })]);
    expect(noPrefix.keymap.prefixes).toEqual([]);
    expect(noPrefix.keymap.notes).toEqual([{
      code: "prefix_unreachable", action: "prefix", binding: "hyper+b", reason: "no_such_modifier",
      skipped: [{ key: "ctrl+b", holder: "zoom" }, { key: "ctrl+a", holder: "new_tab" }, { key: "ctrl+]", holder: "split_vertical" }, { key: "ctrl+\\", holder: "split_horizontal" }],
    }]);
    expect(helpRows(noPrefix.keymap).filter((row) => row.keys.some((text) => text.startsWith("prefix+")))).toEqual([]);
    expect(reduce(noPrefix, { type: "action", action: "detach", at: AT }).effects).toEqual([{ type: "quit" }]);

    // all three detach fallbacks are prefixes themselves: no key quits, and one note says so
    const qPrefixes = start({ prefix: "q", extra_prefixes: ["ctrl+q", "alt+q"] });
    expect(qPrefixes.keymap.notes).toEqual([{ code: "detach_unreachable", skipped: [{ key: "prefix+q", holder: "prefix" }, { key: "prefix+ctrl+q", holder: "prefix" }, { key: "prefix+alt+q", holder: "prefix" }] }]);
  });

  it("working navigate key has no note", () => {
    const keys = { navigate_pane_right: "right" };
    expect(buildKeymap(keys).notes).toEqual([]);
    expect(reduce(start(), { type: "keys", keys, at: AT }).state.notices).toEqual([]);
    const navigating = typed(start(keys), "\x02", "w").state;
    expect(navigating.mode.name).toBe("navigate");
    for (const right of ["\x1b[C", "\x1b[1;1C"]) expect({ right, step: typed(navigating, right) }).toEqual({ right, step: asAction(navigating, "navigate_pane_right") });
    expect(helpRows(buildKeymap(keys)).find((row) => row.action === "navigate_pane_right" && row.mode === "navigate")!.keys).toEqual(["right"]);
  });

  it("cleans, clamps and caps the config text it shows", () => {
    expect(cleanConfigText("a\u0007b\u202ec\u200bd\n")).toBe("abcd");
    expect([...cleanConfigText("x".repeat(500))]).toHaveLength(80);
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`bogus_${i}`, "x"]));
    const shown = shownRefusals(buildKeymap(many));
    expect(shown.shown).toHaveLength(20);
    expect(shown.more).toBe(10);
  });
});
