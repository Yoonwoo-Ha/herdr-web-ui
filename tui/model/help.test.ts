import { describe, expect, it } from "bun:test";
import { helpLines, helpNotes, helpWindow } from "./help.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./reduce.ts";

const keymap = initialState(undefined).keymap;
const at = (cols: number, rows: number): ModelState => reduce(initialState(undefined), { type: "resize", cols, rows, at: 0 } as ModelEvent).state;
const key = (name: string, text?: string): ModelEvent => ({ type: "key", key: name, mods: {}, action: "press", at: 1, ...(text === undefined ? {} : { text }) } as ModelEvent);
const after = (state: ModelState, ...events: ModelEvent[]) => events.reduce((current, event) => reduce(current, event).state, state);
const scroll = (state: ModelState) => (state.overlays.at(-1) as { scroll: number }).scroll;

describe("the help's lines", () => {
  it("are herdr's four sections, 63 lines with their blank rows; at 45 columns words go on in the rows below", () => {
    const wide = helpLines(keymap, [], "", 76);
    expect(wide.length).toBe(63);
    expect(wide.filter((line) => line.kind === "heading").map((line) => line.kind === "heading" && line.text)).toEqual(["global", "navigation", "workspaces / tabs", "panes"]);
    expect(wide.find((line) => line.kind === "command" && line.text === "split horizontal")).toEqual({ kind: "command", keys: "prefix+-", text: "split horizontal" });
    expect(wide.find((line) => line.kind === "command" && line.text === "move focus")).toMatchObject({ keys: "h / j / k / l / left / right" });
    const narrow = helpLines(keymap, [], "", 41);
    expect(narrow.slice(1, 3)).toEqual([{ kind: "command", keys: "ctrl+b", text: "prefix" }, { kind: "more", text: "mode" }]);
    expect(narrow.find((line) => line.kind === "command" && line.keys === "up / down")).toEqual({ kind: "command", keys: "up / down", text: "" });
  });

  it("a filter keeps the commands whose keys or words hold it, under their headings", () => {
    expect(helpLines(keymap, [], "zoom", 76)).toEqual([{ kind: "heading", text: "panes" }, { kind: "command", keys: "prefix+z", text: "zoom pane" }, { kind: "blank" }]);
    expect(helpNotes(keymap)).toEqual([]);
  });

  it("j, k and the arrows move a line, page down and up eight lines, kept within the lines; / types a filter until Enter", () => {
    const open = after(at(80, 24), { type: "action", action: "help", at: 1 } as ModelEvent);
    expect(helpWindow(24)).toBe(15);
    expect(scroll(after(open, key("J", "j"), key("ARROW_DOWN")))).toBe(2);
    expect(scroll(after(open, key("PAGE_DOWN")))).toBe(8);
    expect(scroll(after(open, ...Array.from({ length: 9 }, () => key("PAGE_DOWN"))))).toBe(63 - 15);
    expect(scroll(after(open, key("PAGE_DOWN"), key("PAGE_UP"), key("K", "k")))).toBe(0);
    const filtered = after(open, { type: "text", text: "/", at: 1 } as ModelEvent, { type: "text", text: "zoom", at: 1 } as ModelEvent, key("ENTER"));
    expect(filtered.overlays.at(-1)).toMatchObject({ kind: "help", filtering: false, filter: { graphemes: [..."zoom"] } });
  });
});
