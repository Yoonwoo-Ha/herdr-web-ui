import { afterEach, describe, expect, it } from "bun:test";
import { agents } from "../testing/fixtures/agents.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";
import type { World } from "./focus.ts";
import { type Place, pickerMatches, pickerPlaces } from "./picker.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./reduce.ts";

const TEST_MS = 120_000;
const AT = 1;

const places = (...texts: string[]): Place[] => texts.map((text, at) => ({ kind: "workspace", id: `w${at}`, text }));
const ranked = (query: string, texts: string[]): string[] => pickerMatches(places(...texts), query).map((place) => place.text);

describe("the picker's filter", () => {
  it("ranks by a table: a prefix, a word's prefix, then any subsequence by fewer runs and an earlier start; then a shorter text, then the place's order", () => {
    const table: [query: string, texts: string[], best: string[]][] = [
      // nothing typed: every place in its own order
      ["", ["b", "a", "c"], ["b", "a", "c"]],
      // the whole text (the shortest prefix), a prefix, a word's prefix, a subsequence; a text that does not match is left out
      ["ovis", ["o-v-i-s", "docs/ovis", "ovis/main", "ovis", "oasis"], ["ovis", "ovis/main", "docs/ovis", "o-v-i-s"]],
      // a word's prefix (after a character that is no letter or digit) before a substring inside a word
      ["ain", ["ovis/main", "x/ain"], ["x/ain", "ovis/main"]],
      // a substring (a subsequence in one run) before a subsequence in two
      ["ma", ["m-a", "xmax"], ["xmax", "m-a"]],
      // subsequences: fewer runs of adjacent letters first; the fewest runs are found, not the first letters met
      ["abd", ["axbxd", "axbabxd", "abxxxxd"], ["abxxxxd", "axbabxd", "axbxd"]],
      // the same runs: the earlier first matched character
      ["ac", ["xxaxc", "axc"], ["axc", "xxaxc"]],
      // the same tier, runs and start: the shorter text
      ["ma", ["mainline", "main"], ["main", "mainline"]],
      // all equal: the places' own order
      ["no", ["notes", "notes"], ["notes", "notes"]],
      // letters of any case; Hangul as typed
      ["OV", ["Ovis", "xov"], ["Ovis", "xov"]],
      ["문", ["설명문", "문서"], ["문서", "설명문"]],
      // Hangul is a letter: inside a word it is a substring, after a space a word's prefix
      ["서", ["문서", "x 서"], ["x 서", "문서"]],
      // blanks in the query are dropped
      ["ovis main", ["ovis/main", "ovis"], ["ovis/main"]],
      // nothing matches
      ["zz", ["ovis", "main"], []],
    ];
    for (const [query, texts, best] of table) expect({ query, texts, ranked: ranked(query, texts) }).toEqual({ query, texts, ranked: best });
  });

  it("lists every workspace, then every tab of every workspace, then the agents in the world's order", () => {
    const world: World = {
      workspaces: [
        { id: "w1", name: "ovis", tabs: [{ id: "t1", name: "main", panes: [{ id: "p1", name: "", agent: "claude" }, { id: "p2", name: "shell" }] }, { id: "t2", name: "", panes: [{ id: "p3", name: "build" }] }] },
        { id: "w2", name: "docs", tabs: [{ id: "t3", name: "notes", panes: [{ id: "p4", name: "" }] }] },
      ],
      agents: ["p3", "p1", "gone"],
    };
    expect(pickerPlaces(world)).toEqual([
      { kind: "workspace", id: "w1", text: "ovis" },
      { kind: "workspace", id: "w2", text: "docs" },
      { kind: "tab", id: "t1", text: "ovis/main" },
      { kind: "tab", id: "t2", text: "ovis/2" },
      { kind: "tab", id: "t3", text: "docs/notes" },
      { kind: "agent", id: "p3", text: "build ovis/2" },
      { kind: "agent", id: "p1", text: "claude ovis/main" },
    ]);
  });

  it("matches canonically equivalent Hangul in the query and the place name", () => {
    expect(ranked("\u1112\u1161\u11ab", ["한글", "\u1112\u1161\u11ab글", "글말"])).toEqual(["한글", "\u1112\u1161\u11ab글"]);
    expect(ranked("한", ["\u1112\u1161\u11ab글"])).toEqual(["\u1112\u1161\u11ab글"]);
  });

  it("keeps the earliest start when two equally compact subsequences end together", () => {
    expect(ranked("ab", ["xayb", "axayb"])).toEqual(["axayb", "xayb"]);
  });
});

const key = (name: string, mods: Record<string, boolean> = {}): ModelEvent => ({ type: "key", key: name, mods, action: "press", at: AT });
const text = (typed: string): ModelEvent => ({ type: "text", text: typed, at: AT });
const after = (state: ModelState, ...events: ModelEvent[]): ModelState => events.reduce((s, event) => reduce(s, event).state, state);

describe("the picker overlay", () => {
  const world: World = {
    workspaces: [
      { id: "w1", name: "ovis", tabs: [{ id: "t1", name: "main", panes: [{ id: "p1", name: "" }] }, { id: "t2", name: "logs", panes: [{ id: "p2", name: "" }] }] },
      { id: "w2", name: "docs", tabs: [{ id: "t3", name: "notes", panes: [{ id: "p3", name: "" }] }] },
    ],
  };
  const open = after(reduce(initialState(undefined), { type: "world", world, at: AT }).state, key("B", { ctrl: true }), text("g"));

  it("opens from the prefix and g, filters as typed, and Enter jumps to the best match", () => {
    expect(open.overlays.map((overlay) => overlay.kind)).toEqual(["goto"]);
    const step = reduce(after(open, text("lo")), key("ENTER"));
    expect([step.state.overlays.length, step.state.focus.workspace, step.state.focus.tabs["w1"], step.effects]).toEqual([0, "w1", "t2", []]);
  });

  it("keeps the chosen place by identity: the arrows choose, typing chooses the best again, Enter with no match stays open", () => {
    // "o" ranks ovis, ovis/main, ovis/logs, docs, docs/notes
    const down = after(open, text("o"), key("ARROW_DOWN"));
    const top = down.overlays.at(-1)!;
    expect(top.kind === "goto" && top.chosen).toBe("tab:t1");
    const jumped = reduce(down, key("ENTER")).state;
    expect([jumped.focus.workspace, jumped.focus.tabs["w1"]]).toEqual(["w1", "t1"]);
    expect(after(down, key("P", { ctrl: true })).overlays.at(-1)).toMatchObject({ chosen: "workspace:w1" });
    expect(after(down, text("t")).overlays.at(-1)).toMatchObject({ chosen: null });
    const none = reduce(after(open, text("zz")), key("ENTER"));
    expect([none.state.overlays.length, none.effects]).toEqual([1, []]);
  });

  it("Esc closes it and nothing else happens", () => {
    const step = reduce(after(open, text("lo")), key("ESCAPE"));
    expect([step.state.overlays, step.state.focus, step.effects]).toEqual([[], open.focus, []]);
  });

  it("refreshes an open picker when places arrive or leave without losing a surviving choice", () => {
    const chosen = after(open, text("o"), key("ARROW_DOWN"), key("ARROW_DOWN"));
    const added = { ...world, workspaces: [{ id: "w0", name: "o", tabs: [] }, ...world.workspaces] };
    const refreshed = after(chosen, { type: "world", world: added, at: AT });
    expect(after(refreshed, key("ENTER")).focus.tabs["w1"]).toBe("t2");
    const gone = { ...added, workspaces: added.workspaces.map((workspace) => ({
      ...workspace, tabs: workspace.tabs.filter((tab) => tab.id !== "t2"),
    })) };
    expect(after(refreshed, { type: "world", world: gone, at: AT }, key("ENTER")).focus.workspace).toBe("w0");
  });

  it("arrows wrap from first to last and last to first", () => {
    const last = after(open, key("ARROW_UP"));
    expect(after(last, key("ENTER")).focus.workspace).toBe("w2");
    expect(after(last, key("ARROW_DOWN"), key("ENTER")).focus.workspace).toBe("w1");
  });
});

describe("the picker on screen", () => {
  const runs: Run[] = [];
  afterEach(async () => {
    for (const run of runs.splice(0)) await run.close();
  });

  it("the picker's frame at width 45: title, close key, field, hint and the matches best first, inside 45 columns", async () => {
    const run = await Run.start({ fixture: demo, cols: 45, rows: 20 });
    runs.push(run);
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,g,o");
    await run.advance(10);
    const grid = run.grid();
    expect(grid.slice(3, 17)).toEqual([
      "+ Go to ---------------------- [close: esc] +",
      "| o                                         |",
      "| Type to filter · Enter to jump            |",
      "|>· workspace ovis                          |",
      "| · tab ovis/main                           |",
      "| · tab ovis/logs                           |",
      "| · tab 문서/notes                          |",
      "|                                           |",
      "|                                           |",
      "|                                           |",
      "|                                           |",
      "|                                           |",
      "|                                           |",
      "+-------------------------------------------+",
    ]);
    expect(run.loop.screen()!.cols).toBe(45);
    await run.keys("down,enter");
    await run.advance(10);
    expect([run.loop.model().overlays, run.loop.model().focus.tabs["w-ovis"]]).toEqual([[], "t-main"]);
    await run.keys("ctrl+b,g,z,q");
    await run.advance(10);
    expect(run.grid().slice(4, 8)).toEqual([
      "| zq                                        |",
      "| Type to filter · Enter to jump            |",
      "| No matches                                |",
      "|                                           |",
    ]);
    // a lone Escape is a key once the host's wait for a sequence after it has passed
    await run.keys("esc");
    await run.advance(200);
    expect(run.loop.model().overlays).toEqual([]);
  }, TEST_MS);

  it("clicking a matching picker row jumps to the pane it names", async () => {
    const run = await Run.start({ fixture: demo, cols: 45, rows: 20 });
    runs.push(run);
    await run.live();
    await run.keys("ctrl+b,g,o");
    await run.advance(10);
    expect(run.grid()[8]).toBe("| · tab ovis/logs                           |");
    run.type("\x1b[<0;12;9M");
    await run.settle();
    expect([run.loop.model().overlays, run.loop.model().focus.tabs["w-ovis"]]).toEqual([[], "t-logs"]);
  }, TEST_MS);

  it("the picker scrolls the chosen row into the visible window", async () => {
    const run = await Run.start({
      cols: 45, rows: 20,
      fixture: { build(core) {
        for (const id of ["0", "1", "2", "3", "4", "5"]) {
          place(core, { space: `ws${id}`, spaceName: `place${id}`, tab: `t${id}`, tabName: "shell" }, "ready\r\n");
        }
      } },
    });
    runs.push(run);
    await run.live();
    await run.keys("ctrl+b,g,up");
    await run.advance(10);
    expect(run.grid()[15]).toBe("|>· tab place5/shell                        |");
    await run.keys("enter");
    expect(run.loop.model().focus.workspace).toBe("ws5");
  }, TEST_MS);

  it("picker agent text comes from the core's agent name rather than its pane label", async () => {
    const run = await Run.start({ fixture: agents, cols: 45, rows: 20 });
    runs.push(run);
    await run.live();
    await run.keys("ctrl+b,g,c,l");
    await run.advance(10);
    expect(run.grid()[6]).toBe("|>! agent claude agents/agents              |");
  }, TEST_MS);
});
