import { afterEach, describe, expect, it } from "bun:test";
import { FRAME_DATA, HcConnection } from "../../server/herdr-core/connection.ts";
import type { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { MAX_OSC52_BYTES } from "../../shared/osc52.ts";
import type { MouseInput } from "../model/effects.ts";
import { createEmulator } from "../emulator/ghostty.ts";
import { STYLE_INVERSE } from "../emulator/index.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { keyBytes } from "../testing/keys.ts";
import { Run } from "../testing/run.ts";
import { type PaneLook, Pointer, type PointerAct, type PointerScene } from "./mouse.ts";
import { HitMap } from "./paint.ts";

/** the whole-screen cases drive the real loop on the injected clock; only the socket's own turns are real */
const TEST_MS = 120_000;

// ---- the pointer's rules, on a scene written here ----

const EMULATOR = {};
/** pane a: screen cells x 0-8, y 1-5, drawn from grid row 2 of its 9x8 grid; 20 rows of history above, at the bottom */
const lookA = (programMouse: boolean, history = { scrollback: 20, total: 28, viewportTop: 20 }): PaneLook & { contentVersion: number } => ({
  rect: { x: 0, y: 1, width: 9, height: 5 }, top: 2, grid: { cols: 9, rows: 8 }, programMouse, altScreen: false, screen: 0, emulator: EMULATOR, history, contentVersion: 0,
});
const HITS = new HitMap([
  { rect: { x: 0, y: 0, width: 20, height: 1 }, target: { part: "tabs", id: "" } },
  { rect: { x: 0, y: 0, width: 3, height: 1 }, target: { part: "tabs", id: "tab:T2" } },
  { rect: { x: 4, y: 0, width: 2, height: 1 }, target: { part: "tabs", id: "toggle_sidebar" } },
  { rect: { x: 7, y: 0, width: 3, height: 1 }, target: { part: "side", id: "workspace:W2" } },
  { rect: { x: 11, y: 0, width: 3, height: 1 }, target: { part: "side", id: "agent:b" } },
  { rect: { x: 0, y: 1, width: 9, height: 5 }, target: { pane: "a" } },
  { rect: { x: 9, y: 1, width: 2, height: 5 }, target: { part: "borders", id: "split_0_root" } },
  { rect: { x: 11, y: 1, width: 9, height: 5 }, target: { pane: "b" } },
]);

function sceneOf(focus: string, look: PaneLook | null): PointerScene {
  return {
    hits: HITS,
    focus,
    tab: { id: "T1", root: { split: "right", ratio: 0.5, first: { leaf: "a" }, second: { leaf: "b" } } },
    splits: [{ id: "split_0_root", direction: "right", rect: { x: 0, y: 1, width: 20, height: 5 }, divider: { x: 9, y: 1, width: 2, height: 5 } }],
    look: (pane) => (pane === "a" ? look : null),
    painted: (pane) => (pane === "a" && look ? { ...look, contentVersion: 0 } : null),
  };
}

type Ev = [action: MouseInput["action"], button: MouseInput["button"] | null, col: number, row: number, shift?: boolean];
const ev = ([action, button, col, row, shift]: Ev): MouseInput => ({ type: "mouse", action, ...(button === null ? {} : { button }), mods: shift ? { shift: true } : {}, col, row, at: 1 });

/** rows of (case, focused pane, the program's mouse mode, events in order, the acts each one answers) */
const RULES: [name: string, focus: string, programMouse: boolean, events: Ev[], acts: PointerAct[][]][] = [
  ["a press on a pane with a mouse mode goes to it in its grid's cells, the drag and the release too",
    "a", true, [["press", "left", 3, 2], ["motion", "left", 4, 4], ["release", "left", 4, 4]], [
      [{ kind: "forward", pane: "a", event: ev(["press", "left", 3, 3]) }],
      [{ kind: "forward", pane: "a", event: ev(["motion", "left", 4, 5]) }],
      [{ kind: "forward", pane: "a", event: ev(["release", "left", 4, 5]) }],
    ]],
  ["a drag out of the pane is clamped to its cells", "a", true, [["press", "left", 3, 2], ["motion", "left", 15, 9]], [
    [{ kind: "forward", pane: "a", event: ev(["press", "left", 3, 3]) }],
    [{ kind: "forward", pane: "a", event: ev(["motion", "left", 8, 6]) }],
  ]],
  ["a forwarded release ends the grab, so a later drag without a new press goes nowhere",
    "a", true, [["press", "left", 3, 2], ["release", "left", 4, 2], ["motion", "left", 5, 2]], [
      [{ kind: "forward", pane: "a", event: ev(["press", "left", 3, 3]) }],
      [{ kind: "forward", pane: "a", event: ev(["release", "left", 4, 3]) }],
      [],
    ]],
  ["a new press on empty chrome replaces the old forward grab",
    "a", true, [["press", "left", 3, 2], ["press", "left", 16, 0], ["motion", "left", 4, 2], ["release", "left", 4, 2]], [
      [{ kind: "forward", pane: "a", event: ev(["press", "left", 3, 3]) }], [], [], [],
    ]],
  ["a press on a pane that is not focused only focuses it: its drag and release go nowhere", "b", true,
    [["press", "left", 3, 2], ["motion", "left", 4, 2], ["release", "left", 4, 2]], [[{ kind: "select", target: { kind: "pane", id: "a" } }], [], []]],
  ["with shift held a drag selects, and the release copies the range from its first cell", "a", true,
    [["press", "left", 5, 3, true], ["motion", "left", 2, 2, true], ["release", "left", 2, 2, true]], [
      [],
      [{ kind: "redraw" }],
      [{ kind: "redraw" }, { kind: "copy", pane: "a", range: { start: { x: 2, y: 23 }, end: { x: 5, y: 24 } }, contentVersion: 0 }],
    ]],
  ["with no mouse mode a drag selects", "a", false, [["press", "left", 1, 1], ["motion", "left", 3, 1], ["release", "left", 3, 1]], [
    [], [{ kind: "redraw" }], [{ kind: "redraw" }, { kind: "copy", pane: "a", range: { start: { x: 1, y: 22 }, end: { x: 3, y: 22 } }, contentVersion: 0 }],
  ]],
  ["a click with no drag selects nothing and copies nothing", "a", false, [["press", "left", 1, 1], ["release", "left", 1, 1]], [[], []]],
  ["the next press drops the selection", "a", false, [["press", "left", 1, 1], ["motion", "left", 3, 1], ["release", "left", 3, 1], ["press", "left", 1, 1]], [
    [], [{ kind: "redraw" }], [{ kind: "redraw" }, { kind: "copy", pane: "a", range: { start: { x: 1, y: 22 }, end: { x: 3, y: 22 } }, contentVersion: 0 }], [{ kind: "redraw" }],
  ]],
  ["the wheel scrolls three rows, never past the history, and back", "a", false, [["press", "wheelUp", 1, 1], ["press", "wheelDown", 1, 1]], [
    [{ kind: "scroll", pane: "a", fromBottom: 3 }], [],
  ]],
  ["with a mouse mode the wheel goes to the program", "a", true, [["press", "wheelUp", 1, 1]], [[{ kind: "forward", pane: "a", event: ev(["press", "wheelUp", 1, 2]) }]]],
  ["with a mouse mode and shift the wheel scrolls here", "a", true, [["press", "wheelUp", 1, 1, true]], [[{ kind: "scroll", pane: "a", fromBottom: 3 }]]],
  ["the wheel over a pane that is not focused neither scrolls nor focuses", "b", false, [["press", "wheelUp", 1, 1]], [[]]],
  ["a move with no button goes to a program that asked for the mouse, and nowhere else", "a", true, [["motion", null, 2, 2]], [[{ kind: "forward", pane: "a", event: ev(["motion", null, 2, 3]) }]]],
  ["a move with no button over a program without a mouse mode goes nowhere", "a", false, [["motion", null, 2, 2]], [[]]],
  ["a click on a tab selects it", "a", false, [["press", "left", 1, 0], ["release", "left", 1, 0]], [[{ kind: "select", target: { kind: "tab", id: "T2" } }], []]],
  ["a click on a workspace row selects it", "a", false, [["press", "left", 8, 0]], [[{ kind: "select", target: { kind: "workspace", id: "W2" } }]]],
  ["a click on an agent row selects its pane", "a", false, [["press", "left", 12, 0]], [[{ kind: "select", target: { kind: "pane", id: "b" } }]]],
  ["a click on the sidebar toggle runs it", "a", false, [["press", "left", 4, 0]], [[{ kind: "action", action: "toggle_sidebar" }]]],
  ["a click on the chrome's empty cells does nothing", "a", true, [["press", "left", 16, 0]], [[]]],
  ["a right click on a tab does nothing", "a", false, [["press", "right", 1, 0]], [[]]],
  ["a divider follows the pointer from where it was grabbed, and the release writes the last ratio", "a", false,
    [["press", "left", 10, 3], ["motion", "left", 4, 3], ["motion", "left", 6, 3], ["release", "left", 6, 3]], [
      [],
      [{ kind: "divider", grab: 1, tab: "T1", name: { first: "a", second: "b", direction: "right" }, ratio: 0.2, done: false }],
      [{ kind: "divider", grab: 1, tab: "T1", name: { first: "a", second: "b", direction: "right" }, ratio: 0.3, done: false }],
      [{ kind: "divider", grab: 1, tab: "T1", name: { first: "a", second: "b", direction: "right" }, ratio: 0.3, done: true }],
    ]],
  ["a divider pressed and released without a move writes nothing", "a", false, [["press", "left", 9, 3], ["release", "left", 9, 3]], [[], []]],
  ["a new press while a divider is held ends its drag at the last ratio it moved to", "a", false,
    [["press", "left", 10, 3], ["motion", "left", 4, 3], ["press", "right", 16, 0], ["release", "left", 6, 3]], [
      [],
      [{ kind: "divider", grab: 1, tab: "T1", name: { first: "a", second: "b", direction: "right" }, ratio: 0.2, done: false }],
      [{ kind: "divider", grab: 1, tab: "T1", name: { first: "a", second: "b", direction: "right" }, ratio: 0.2, done: true }],
      [],
    ]],
];

describe("the pointer", () => {
  for (const [name, focus, programMouse, events, acts] of RULES) {
    it(name, () => {
      const pointer = new Pointer();
      const look = lookA(programMouse);
      expect(events.map((event) => pointer.mouse("screen", ev(event), sceneOf(focus, look)))).toEqual(acts);
    });
  }

  it("a gesture begun in a pane before an overlay opened ends at its release over the overlay, and nothing of it goes on after", () => {
    // a program with a mouse mode: it gets its release, in its grid's cells
    const forward = new Pointer();
    const program = sceneOf("a", lookA(true));
    expect(forward.mouse("screen", ev(["press", "left", 3, 2]), program)).toEqual([{ kind: "forward", pane: "a", event: ev(["press", "left", 3, 3]) }]);
    // the help opens from the keyboard while the button is held; a wheel notch over it neither reaches the program
    // nor ends the gesture: the program gets exactly its press and its release
    expect(forward.mouse("overlay", ev(["motion", "left", 4, 2]), program)).toEqual([]);
    expect(forward.mouse("overlay", ev(["press", "wheelUp", 4, 2]), program)).toEqual([]);
    expect(forward.mouse("overlay", ev(["release", "left", 4, 2]), program)).toEqual([{ kind: "forward", pane: "a", event: ev(["release", "left", 4, 3]) }]);
    // the help closed again: a drag with no new press goes nowhere
    expect(forward.mouse("screen", ev(["motion", "left", 5, 2]), program)).toEqual([]);
    // a selection begun before the overlay is dropped at that release: no copy, and no later drag extends it
    const select = new Pointer();
    const plain = sceneOf("a", lookA(false));
    expect(select.mouse("screen", ev(["press", "left", 1, 1]), plain)).toEqual([]);
    expect(select.mouse("overlay", ev(["release", "left", 3, 1]), plain)).toEqual([]);
    expect(select.mouse("screen", ev(["motion", "left", 4, 1]), plain)).toEqual([]);
    // a divider drag ends at the last ratio it moved to, so its ratio is not drawn over later layouts
    const divider = new Pointer();
    expect(divider.mouse("screen", ev(["press", "left", 10, 3]), plain)).toEqual([]);
    const move = { kind: "divider", grab: 1, tab: "T1", name: { first: "a", second: "b", direction: "right" }, ratio: 0.2 } as const;
    expect(divider.mouse("screen", ev(["motion", "left", 4, 3]), plain)).toEqual([{ ...move, done: false }]);
    expect(divider.mouse("overlay", ev(["release", "left", 8, 3]), plain)).toEqual([{ ...move, done: true }]);
    expect(divider.mouse("screen", ev(["motion", "left", 6, 3]), plain)).toEqual([]);
  });

  it("an open overlay takes the mouse: nothing reaches a pane or the chrome; a left press on its close control closes it", () => {
    const pointer = new Pointer();
    for (const event of [ev(["press", "left", 3, 2]), ev(["press", "left", 1, 0]), ev(["press", "wheelUp", 3, 2])]) {
      expect(pointer.mouse("overlay", event, sceneOf("a", lookA(true)))).toEqual([]);
    }
    const withClose: PointerScene = { ...sceneOf("a", lookA(true)), hits: new HitMap([{ rect: { x: 0, y: 1, width: 9, height: 5 }, target: { pane: "a" } }, { rect: { x: 2, y: 2, width: 4, height: 1 }, target: { part: "overlay:help", id: "close" } }]) };
    expect(pointer.mouse("overlay", ev(["press", "left", 3, 2]), withClose)).toEqual([{ kind: "close_overlay" }]);
    expect(pointer.mouse("overlay", ev(["press", "right", 3, 2]), withClose)).toEqual([]);
    expect(pointer.mouse("overlay", ev(["release", "left", 3, 2]), withClose)).toEqual([]);
    expect(pointer.mouse("overlay", ev(["press", "left", 1, 3]), withClose)).toEqual([]);
  });

  it("a drag whose press went to no program reaches none, also over the pane the press focused or over the focused one", () => {
    // the press focuses a (focus b at the press); a is focused from then on
    let pointer = new Pointer();
    expect(pointer.mouse("screen", ev(["press", "left", 3, 2]), sceneOf("b", lookA(true)))).toEqual([{ kind: "select", target: { kind: "pane", id: "a" } }]);
    expect([ev(["motion", "left", 4, 2]), ev(["release", "left", 4, 2])].map((event) => pointer.mouse("screen", event, sceneOf("a", lookA(true))))).toEqual([[], []]);
    // a press on the chrome's empty cells, dragged over the focused a
    pointer = new Pointer();
    expect([ev(["press", "left", 16, 0]), ev(["motion", "left", 3, 2]), ev(["release", "left", 3, 2])].map((event) => pointer.mouse("screen", event, sceneOf("a", lookA(true))))).toEqual([[], [], []]);
    // a move with no button held still goes to a, once the drag is over
    expect(pointer.mouse("screen", ev(["motion", null, 3, 2]), sceneOf("a", lookA(true)))).toEqual([{ kind: "forward", pane: "a", event: ev(["motion", null, 3, 3]) }]);
  });

  it("a drag report with a new focus drops the old forward grab even without a focus notification", () => {
    const pointer = new Pointer();
    const look = lookA(true);
    expect(pointer.mouse("screen", ev(["press", "left", 3, 2]), sceneOf("a", look))).toEqual([
      { kind: "forward", pane: "a", event: ev(["press", "left", 3, 3]) },
    ]);
    expect(pointer.mouse("screen", ev(["motion", "left", 4, 2]), sceneOf("b", look))).toEqual([]);
    // With focus back on a, the original release still belongs to the canceled gesture.
    expect(pointer.mouse("screen", ev(["release", "left", 4, 2]), sceneOf("a", look))).toEqual([]);
  });

  it("moving focus away and back mid-selection keeps the drag's original anchor", () => {
    const pointer = new Pointer();
    const scene = sceneOf("a", lookA(false));
    pointer.mouse("screen", ev(["press", "left", 1, 1]), scene);
    pointer.focusChanged("b");
    pointer.focusChanged("a");
    expect(pointer.mouse("screen", ev(["release", "left", 4, 2]), scene)).toEqual([
      { kind: "redraw" },
      { kind: "copy", pane: "a", range: { start: { x: 1, y: 22 }, end: { x: 4, y: 23 } }, contentVersion: 0 },
    ]);
  });

  it("returning focus before a paint cannot revive a selection from an earlier screen", () => {
    const pointer = new Pointer();
    const look = lookA(false);
    const scene = sceneOf("a", look);
    pointer.mouse("screen", ev(["press", "left", 1, 1]), scene);
    pointer.mouse("screen", ev(["motion", "left", 3, 2]), scene);
    pointer.focusChanged("b");
    pointer.focusChanged("a");
    const replacement = { ...look, screen: look.screen + 2 };
    expect(pointer.mouse("screen", ev(["release", "left", 4, 2]), sceneOf("a", replacement))).toEqual([{ kind: "redraw" }]);
    expect(pointer.shown("a", "a", replacement)).toBeNull();
  });

  it("changing pane focus does not end a divider drag in the same tab", () => {
    const pointer = new Pointer();
    const look = lookA(false);
    pointer.mouse("screen", ev(["press", "left", 10, 3]), sceneOf("a", look));
    pointer.focusChanged("b");
    const scene = sceneOf("b", look);
    const move = { kind: "divider", grab: 1, tab: "T1", name: { first: "a", second: "b", direction: "right" }, ratio: 0.2 } as const;
    expect(pointer.mouse("screen", ev(["motion", "left", 4, 3]), scene)).toEqual([{ ...move, done: false }]);
    expect(pointer.mouse("screen", ev(["release", "left", 4, 3]), scene)).toEqual([{ ...move, done: true }]);
  });

  it("the wheel stops at the oldest kept row and at the newest; a key brings a scrolled pane back to the newest", () => {
    const pointer = new Pointer();
    const near = lookA(false, { scrollback: 20, total: 28, viewportTop: 1 });
    expect(pointer.mouse("screen", ev(["press", "wheelUp", 1, 1]), sceneOf("a", near))).toEqual([{ kind: "scroll", pane: "a", fromBottom: 20 }]);
    const top = lookA(false, { scrollback: 20, total: 28, viewportTop: 0 });
    expect(pointer.mouse("screen", ev(["press", "wheelUp", 1, 1]), sceneOf("a", top))).toEqual([]);
    expect(pointer.mouse("screen", ev(["press", "wheelDown", 1, 1]), sceneOf("a", top))).toEqual([{ kind: "scroll", pane: "a", fromBottom: 17 }]);
    expect(pointer.typed("a", top)).toEqual([{ kind: "scroll", pane: "a", fromBottom: 0 }]);
    expect(pointer.typed("a", lookA(false))).toEqual([]);
  });

  it("a drag whose pane got a new emulator or switched screens before its release selects and copies nothing", () => {
    for (const changed of [{ ...lookA(false), emulator: {} }, { ...lookA(false), altScreen: true }, { ...lookA(false), screen: 1 }]) {
      const pointer = new Pointer();
      expect(pointer.mouse("screen", ev(["press", "left", 1, 1]), sceneOf("a", lookA(false)))).toEqual([]);
      expect(pointer.mouse("screen", ev(["motion", "left", 3, 2]), sceneOf("a", lookA(false)))).toEqual([{ kind: "redraw" }]);
      expect(pointer.mouse("screen", ev(["release", "left", 4, 2]), sceneOf("a", changed))).toEqual([{ kind: "redraw" }]);
      expect(pointer.shown("a", "a", changed)).toBeNull();
      // the grab is gone with it: a later drag extends nothing
      expect(pointer.mouse("screen", ev(["motion", "left", 5, 2]), sceneOf("a", changed))).toEqual([]);
    }
  });

  it("the selection is drawn in the grid's rows, and dropped when its pane loses the focus, gets a new emulator or switches screens", () => {
    const select = () => {
      const pointer = new Pointer();
      for (const event of [ev(["press", "left", 1, 1]), ev(["motion", "left", 3, 2])]) pointer.mouse("screen", event, sceneOf("a", lookA(false)));
      return pointer;
    };
    let pointer = select();
    // screen rows 22 and 23, with the screen's top at row 20 of the kept rows: grid rows 2 and 3
    expect(pointer.shown("a", "a", lookA(false))).toEqual({ start: { x: 1, y: 2 }, end: { x: 3, y: 3 } });
    expect(pointer.shown("b", "a", lookA(false))).toBeNull();
    // output scrolled the screen by one row: the selection stays on its text
    expect(pointer.shown("a", "a", lookA(false, { scrollback: 21, total: 29, viewportTop: 21 }))).toEqual({ start: { x: 1, y: 1 }, end: { x: 3, y: 2 } });
    expect(pointer.shown("a", "b", lookA(false))).toBeNull();
    expect(pointer.shown("a", "a", lookA(false))).toBeNull();
    pointer = select();
    expect(pointer.shown("a", "a", { ...lookA(false), emulator: {} })).toBeNull();
    pointer = select();
    expect(pointer.shown("a", "a", { ...lookA(false), altScreen: true })).toBeNull();
    pointer = select();
    expect(pointer.shown("a", "a", { ...lookA(false), screen: 1 })).toBeNull();
  });
});

// ---- the whole screen: SGR reports typed into the host, through the framer, the loop and the fake core ----

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

/** The demo at 120x40: pane t1 shows in cells x 25-70, y 2-37, pane t2 in x 73-118, the divider between them at x 71-72. */
async function demo120(): Promise<Run> {
  const run = await Run.start({ fixture: demo });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

const channelOf = (run: Run, terminal: string): number => run.core.viewers(terminal).at(-1)!.channel;
/** DATA frames the screen sent on `terminal`'s channel since frame `from` */
const dataTo = (run: Run, terminal: string, from: number) => run.sent.slice(from).filter((frame) => frame.kind === FRAME_DATA && frame.channel === channelOf(run, terminal));
const hexOf = (text: string): string => Buffer.from(text, "latin1").toString("hex");
const osc52Of = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x1b\\`;
/**
 * The host's screen as the bytes written to it draw it: every write replayed into an emulator standing in for the host
 * terminal. `text` of row `row` from column `from` to `to`; `inverted` only the cells drawn with inverse video.
 */
async function hostScreen(run: Run) {
  const made = await createEmulator({ cols: 120, rows: 40, events: {} });
  if (!made.ok) throw new Error(made.error.message);
  const host = made.value;
  try {
    host.write(new TextEncoder().encode("\x1b[?1049h"));
    host.write(run.host.bytes());
    const cells: { text: string; flags: number }[][] = Array.from({ length: 40 }, () => []);
    host.frameAll((y, runs) => {
      for (const one of runs) {
        let x = one.x;
        for (const cell of one.cells) {
          cells[y]![x] = { text: cell.text, flags: one.flags };
          x += cell.wide ? 2 : 1;
        }
      }
    });
    const pick = (row: number, from: number, to: number, only: boolean) => {
      let text = "";
      for (let col = from; col <= to; col++) {
        const cell = cells[row]![col];
        if (cell && (!only || cell.flags & STYLE_INVERSE)) text += cell.text;
      }
      return text;
    };
    const cursor = host.cursorState();
    if (!cursor.ok) throw new Error(cursor.error.message);
    return {
      text: (row: number, from: number, to: number) => pick(row, from, to, false),
      inverted: (row: number, from: number, to: number) => pick(row, from, to, true),
      cursor: cursor.value,
    };
  } finally {
    host.dispose();
  }
}
const notices = (run: Run) => run.loop.model().notices.map((notice) => notice.code);
const focusedPane = (run: Run): string | undefined => {
  const focus = run.loop.model().focus;
  return focus.panes[focus.tabs[focus.workspace ?? ""] ?? ""];
};
/** the screen's own `doc.set` calls (another writer's are not on its line) */
const docSets = (run: Run) => run.sent.filter((frame) => frame.channel === 0 && new TextDecoder().decode(frame.payload).includes("\"doc.set\""));

describe("mouse on the whole screen", () => {
  for (const [move, keys, focus, left] of [
    ["a directional key", "ctrl+b,l", "t2", 73],
    ["a press on the sidebar", "press@3:3", "t4", 25],
    ["a press on another tab", "press@34:0", "t3", 25],
    ["a tab switch key", "ctrl+b,n", "t3", 25],
    ["a workspace switch key", "ctrl+b,w,2", "t4", 25],
  ] as const) {
    it(`a held drag ends when ${move} moves focus; a new press starts a new grab`, async () => {
      const run = await demo120();
      const old = run.core.program("t1");
      old.output("\x1b[?1002h\x1b[?1006h\x1b[?1004h");
      run.core.program("t2").output("\x1b[?1004h");
      await run.advance(20);
      const start = old.receivedHex().length;
      await run.keys("press@30:5");
      expect(old.receivedHex().slice(start)).toBe(hexOf("\x1b[<0;6;4M"));

      await run.keys(keys);
      expect(focusedPane(run)).toBe(focus);
      await run.live();
      const next = run.core.program(focus);
      if (focus === "t2") {
        expect(old.receivedHex().slice(start)).toBe(hexOf("\x1b[<0;6;4M\x1b[O"));
        expect(next.receivedHex()).toBe(hexOf("\x1b[I"));
      }
      const oldBefore = old.receivedHex();
      const newBefore = next.receivedHex();
      await run.keys("drag@31:5");
      // Repaint without sending another key that could change the loop's focus.
      next.output("\x1b[?1002h\x1b[?1006h\x1b[4;3H@");
      await run.advance(20);
      expect({ old: old.receivedHex(), next: next.receivedHex(), focus: focusedPane(run), cursor: (await hostScreen(run)).cursor }).toMatchObject({
        old: oldBefore, next: newBefore, focus, cursor: { x: left + 3, y: 5, visible: true },
      });

      await run.keys("release@31:5");
      expect([old.receivedHex(), next.receivedHex()]).toEqual([oldBefore, newBefore]);
      await run.keys(`press@${left + 5}:5,drag@${left + 6}:5,release@${left + 6}:5`);
      expect(next.receivedHex().slice(newBefore.length)).toBe(hexOf("\x1b[<0;6;4M\x1b[<32;7;4M\x1b[<0;7;4m"));
    }, TEST_MS);
  }

  it("a held drag stays canceled when focus returns after a key read together with text", async () => {
    const run = await demo120();
    run.loop.dispatch({ type: "keys", keys: { cycle_pane_next: "prefix+a" }, at: run.clock.current });
    const [t1, t2] = [run.core.program("t1"), run.core.program("t2")];
    t1.output("\x1b[?1002h\x1b[?1006h");
    await run.advance(20);

    await run.keys("press@30:5,ctrl+b,ax"); // The binding and x are one host read.
    expect([focusedPane(run), t1.receivedHex(), t2.receivedHex()]).toEqual([
      "t2", hexOf("\x1b[<0;6;4M"), hexOf("x"),
    ]);
    await run.keys("ctrl+b,h");
    expect(focusedPane(run)).toBe("t1");
    await run.keys("drag@31:5,release@31:5");
    expect(t1.receivedHex()).toBe(hexOf("\x1b[<0;6;4M"));
  }, TEST_MS);

  for (const [move, movesWith] of [
    ["ctrl+b,ax", "a key read together with text"],
    ["ctrl+b,l", "a directional key"],
  ] as const) {
    it(`a wheel over the new pane reaches it after focus moves with ${movesWith}`, async () => {
      const run = await demo120();
      run.loop.dispatch({ type: "keys", keys: { cycle_pane_next: "prefix+a" }, at: run.clock.current });
      const [t1, t2] = [run.core.program("t1"), run.core.program("t2")];
      t1.output("\x1b[?1002h\x1b[?1006h");
      t2.output("\x1b[?1002h\x1b[?1006h");
      await run.advance(20);
      await run.keys(`press@30:5,${move}`);
      expect([focusedPane(run), t1.receivedHex()]).toEqual(["t2", hexOf("\x1b[<0;6;4M")]);
      const before = t2.receivedHex();
      await run.keys("wheelup@80:5");
      expect(t2.receivedHex().slice(before.length)).toBe(hexOf("\x1b[<64;8;4M"));
    }, TEST_MS);
  }

  for (const [binding, keys, typed] of [
    ["next pane on prefix+a", { cycle_pane_next: "prefix+a" }, "ax"],
    ["last pane on prefix+;", { last_pane: "prefix+;" }, ";x"],
  ] as const) {
    it(`the ${binding} routes text and cancels the held drag in one read`, async () => {
      const run = await demo120();
      run.loop.dispatch({ type: "keys", keys, at: run.clock.current });
      if (typed === ";x") await run.keys("ctrl+b,l,ctrl+b,h"); // make t2 the last pane
      const [t1, t2] = [run.core.program("t1"), run.core.program("t2")];
      t1.output("\x1b[?1002h\x1b[?1006h\x1b[?1004h");
      t2.output("\x1b[?1004h");
      await run.advance(20);
      await run.keys("press@30:5,ctrl+b");
      expect(t1.receivedHex()).toBe(hexOf("\x1b[<0;6;4M"));

      // The bound key and x form one text event; the mouse reports follow it in the same host read.
      run.type(typed + keyBytes("drag@31:5") + keyBytes("release@31:5"));
      t2.output("\x1b[4;3H@");
      await run.advance(20);
      expect({
        t1: t1.receivedHex(),
        t2: t2.receivedHex(),
        focus: focusedPane(run),
        cursor: (await hostScreen(run)).cursor,
      }).toMatchObject({
        t1: hexOf("\x1b[<0;6;4M\x1b[O"),
        t2: hexOf("\x1b[Ix"),
        focus: "t2",
        cursor: { x: 76, y: 5, visible: true },
      });
    }, TEST_MS);
  }

  it("mouse: a press over a pane with 1002 and 1006 arrives in pane-local cells; over chrome nothing is forwarded; with shift, or with no mouse mode, nothing is forwarded and a selection starts", async () => {
    const run = await demo120();
    expect(focusedPane(run)).toBe("t1");
    run.core.program("t1").output("\x1b[?1002h\x1b[?1006h");
    await run.advance(20);
    let from = run.sent.length;
    let heard = run.core.program("t1").receivedHex().length;
    // screen cell (30, 5) is cell (5, 3) of t1's grid: SGR counts from 1
    await run.keys("press@30:5,drag@31:6,release@31:6");
    expect(run.core.program("t1").receivedHex().slice(heard)).toBe(hexOf("\x1b[<0;6;4M\x1b[<32;7;5M\x1b[<0;7;5m"));
    // the tab bar's empty cells and the mode bar: nothing reaches a pane
    from = run.sent.length;
    await run.keys("click@100:0,click@60:39");
    expect(dataTo(run, "t1", from)).toEqual([]);
    expect(dataTo(run, "t2", from)).toEqual([]);
    // shift with the mouse mode on: no DATA, and the drag selects "echo" (t1's row 0, cells 2 to 5), copied at the release
    heard = run.core.program("t1").receivedHex().length;
    const written = run.host.output().length;
    await run.keys("shift+press@27:2,shift+drag@30:2");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("echo");
    await run.keys("shift+release@30:2");
    expect(dataTo(run, "t1", from)).toEqual([]);
    expect(run.core.program("t1").receivedHex().slice(heard)).toBe("");
    expect(run.host.output().slice(written)).toContain(osc52Of("echo"));
    expect(notices(run)).toContain("copied");
    // t2's program asked for no mouse: focused by one click (sent nowhere), then a drag over "README" selects it
    await run.keys("click@80:3");
    expect(focusedPane(run)).toBe("t2");
    from = run.sent.length;
    const written2 = run.host.output().length;
    await run.keys("press@73:3,drag@78:3,release@78:3");
    expect(dataTo(run, "t2", from)).toEqual([]);
    expect(run.host.output().slice(written2)).toContain(osc52Of("README"));
    await run.advance(20);
    expect((await hostScreen(run)).inverted(3, 73, 90)).toBe("README");
  }, TEST_MS);

  it("M1: a program with 1000 and 1006 gets a click inside its pane in its own cells, none on the chrome; with its mouse off the screen selects and scrolls; shift forces the screen's selection", async () => {
    const run = await demo120();
    run.core.program("t1").output("\x1b[?1000h\x1b[?1006h");
    await run.advance(20);
    const heard = run.core.program("t1").receivedHex().length;
    await run.keys("click@25:2,click@70:37");
    expect(run.core.program("t1").receivedHex().slice(heard)).toBe(hexOf("\x1b[<0;1;1M\x1b[<0;1;1m\x1b[<0;46;36M\x1b[<0;46;36m"));
    const from = run.sent.length;
    await run.keys("click@100:0,click@3:39");
    expect(dataTo(run, "t1", from)).toEqual([]);
    await run.keys("shift+press@25:3,shift+drag@26:3,shift+release@26:3");
    expect(dataTo(run, "t1", from)).toEqual([]);
    await run.advance(20);
    expect((await hostScreen(run)).inverted(3, 25, 40)).toBe("안");
    // the program turns its mouse off and prints 60 numbered lines: the wheel shows older rows, the newest again, with no DATA
    run.core.program("t1").output("\x1b[?1000l");
    run.core.program("t1").output(Array.from({ length: 60 }, (_, n) => `row-${n}`).join("\r\n"));
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-59");
    const scrolled = run.sent.length;
    await run.keys("wheelup@40:20");
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-56");
    await run.keys("wheelup@40:20,wheeldown@40:20");
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-56");
    expect(dataTo(run, "t1", scrolled)).toEqual([]);
    // a key typed into the scrolled pane shows the newest rows again before it is sent
    await run.keys("x");
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-59");
    expect(dataTo(run, "t1", scrolled).map((frame) => new TextDecoder().decode(frame.payload))).toEqual(["x"]);
  }, TEST_MS);

  it("M3: a title, a cursor shape and a bell from a pane without focus leave the host alone; the focused pane's bell reaches it", async () => {
    const run = await demo120();
    const before = run.host.bytes().length;
    run.core.program("t2").output("\x1b]2;TITLE-B\x07\x1b]0;ICON-B\x07\x1b[5 q\x07");
    await run.advance(50);
    const after = Buffer.from(run.host.bytes().subarray(before)).toString("latin1");
    expect(after).not.toContain("\x07");
    expect(after).not.toContain("TITLE-B");
    expect(after).not.toContain("ICON-B");
    expect(after).not.toContain("\x1b[5 q");
    expect(after).not.toContain("\x1b[6 q");
    // focused, the pane's bell is the host's one BEL
    await run.keys("click@80:10");
    expect(focusedPane(run)).toBe("t2");
    const focusedFrom = run.host.bytes().length;
    run.core.program("t2").output("\x07");
    await run.advance(50);
    expect([...run.host.bytes().subarray(focusedFrom)].filter((byte) => byte === 0x07).length).toBe(1);
  }, TEST_MS);

  it("O1: an OSC 52 write from the focused pane reaches the host under the size cap; a read request is never answered; an unfocused pane's write never reaches it", async () => {
    expect(MAX_OSC52_BYTES).toBe(100 * 1024);
    const run = await demo120();
    let from = run.host.output().length;
    run.core.program("t1").output(`\x1b]52;c;${Buffer.from("hello 한글").toString("base64")}\x07`);
    await run.advance(50);
    expect(run.host.output().slice(from)).toContain(osc52Of("hello 한글"));
    // a read request: nothing to the host, nothing back to the program
    from = run.host.output().length;
    const heard = run.core.program("t1").receivedHex().length;
    run.core.program("t1").output("\x1b]52;c;?\x07");
    await run.advance(50);
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(run.core.program("t1").receivedHex().slice(heard)).toBe("");
    // the cap: exactly 100 KiB passes, one byte more does not
    from = run.host.output().length;
    run.core.program("t1").output(`\x1b]52;c;${Buffer.alloc(100 * 1024, 0x61).toString("base64")}\x07`);
    await run.advance(50);
    expect(run.host.output().slice(from)).toContain(osc52Of("a".repeat(100 * 1024)));
    from = run.host.output().length;
    run.core.program("t1").output(`\x1b]52;c;${Buffer.alloc(100 * 1024 + 1, 0x62).toString("base64")}\x07`);
    await run.advance(50);
    expect(run.host.output().slice(from)).not.toContain("]52;");
    // the pane without focus
    from = run.host.output().length;
    run.core.program("t2").output(`\x1b]52;c;${Buffer.from("not-mine").toString("base64")}\x07`);
    await run.advance(50);
    expect(run.host.output().slice(from)).not.toContain("]52;");
  }, TEST_MS);

  it("a copy over the cap writes nothing and says so", async () => {
    const run = await demo120();
    // 2,100 rows of 46 cells of an e with three acute accents (7 bytes a cell): the kept rows hold far more than 100 KiB
    run.core.program("t1").output(Buffer.from(`${"e\u0301\u0301\u0301".repeat(46)}\r\n`.repeat(2_100), "utf8"));
    await run.advance(50);
    const from = run.host.output().length;
    // the press at the oldest row, the wheel down to the newest while the button is held, the release at the bottom right
    run.type("\x1b[<64;41;21M".repeat(800));
    // Endpoints belong to the displayed viewport: show each scroll destination before pointing at its rows.
    await run.advance(20);
    run.type(`\x1b[<0;26;3M${"\x1b[<65;41;21M".repeat(800)}`);
    await run.advance(20);
    run.type("\x1b[<32;71;38M\x1b[<0;71;38m");
    await run.settle();
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(run.loop.model().notices.find((notice) => notice.code === "copy_refused")?.data).toMatchObject({ reason: "too_large" });
  }, TEST_MS);

  for (const held of [false, true]) for (const beforePress of [false, true]) {
    it(`same-screen scroll ${beforePress ? "before" : "after"} press ${held ? "during a hold" : "after a hold, before repaint"} selects displayed cells and refuses stale text`, async () => {
      const run = await demo120();
      await run.advance(20);
      const program = run.core.program("t1");
      if (!held) {
        program.output("\x1b[?2026h\x1b[?2026l");
        await run.advance(20);
      }
      program.output(`\x1b[H\x1b[2J${"line\r\n".repeat(35)}AAAA`);
      await run.settle();
      expect((await hostScreen(run)).text(37, 25, 28)).toBe("AAAA");
      const from = run.host.output().length;
      if (!beforePress) await run.keys("press@25:37");
      program.output(`${held ? "\x1b[?2026h" : ""}\r\nBBBB`);
      await run.settle();
      // Still A on the host, even though the live viewport has advanced.
      expect((await hostScreen(run)).text(37, 25, 28)).toBe("AAAA");
      if (beforePress) await run.keys("press@25:37");
      await run.keys("drag@28:37");
      await run.advance(20);
      const row = held ? 37 : 36;
      const marked = await hostScreen(run);
      expect([marked.inverted(36, 25, 70), marked.inverted(37, 25, 70)]).toEqual(held ? ["", "AAAA"] : ["AAAA", ""]);
      await run.keys(`release@28:${row}`);
      if (held) {
        expect(run.host.output().slice(from)).not.toContain("]52;");
        expect(notices(run)).not.toContain("copied");
      } else {
        expect(run.host.output().slice(from)).toContain(osc52Of("AAAA"));
        expect(run.host.output().slice(from)).not.toContain(osc52Of("BBBB"));
      }
      if (held) program.output("\x1b[?2026l");
      await run.advance(20);
      // After the hold and its paint, B is displayed and a new gesture can copy B.
      expect((await hostScreen(run)).text(37, 25, 28)).toBe("BBBB");
      const fresh = run.host.output().length;
      await run.keys("press@25:37,drag@28:37,release@28:37");
      await run.advance(20);
      expect((await hostScreen(run)).inverted(37, 25, 70)).toBe("BBBB");
      expect(run.host.output().slice(fresh)).toContain(osc52Of("BBBB"));
    }, TEST_MS);
  }

  it("a wheel during a drag uses the newly displayed viewport and copies the unchanged history", async () => {
    const run = await demo120();
    run.core.program("t1").output(`\x1b[H\x1b[2J${Array.from({ length: 60 }, (_, n) => `row-${n.toString().padStart(2, "0")}`).join("\r\n")}`);
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-59");
    await run.keys("press@30:37,wheelup@40:20");
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-56");
    await run.keys("drag@25:37");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(37, 25, 30)).toBe("row-56");
    const from = run.host.output().length;
    await run.keys("release@25:37");
    expect(run.host.output().slice(from)).toContain(osc52Of("row-56\nrow-57\nrow-58\nrow-59"));
  }, TEST_MS);

  it("a wheel during a held drag never maps the endpoint into an unseen viewport", async () => {
    const run = await demo120();
    const program = run.core.program("t1");
    program.output(`\x1b[H\x1b[2J${Array.from({ length: 60 }, (_, n) => `row-${n}`).join("\r\n")}`);
    await run.advance(20);
    program.output("\x1b[?2026h\r\nrow-60");
    await run.advance(20);
    const from = run.host.output().length;
    await run.keys("press@30:37,wheelup@40:20");
    await run.advance(20);
    await run.keys("drag@25:37");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(37, 25, 70)).toBe("row-59");
    await run.keys("release@25:37");
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(notices(run)).not.toContain("copied");
  }, TEST_MS);

  it("a wheel drag refuses a changed anchor outside the displayed viewport", async () => {
    const run = await demo120();
    const program = run.core.program("t1");
    program.output(`\x1b[H\x1b[2J${Array.from({ length: 60 }, (_, n) => `row-${n}`).join("\r\n")}`);
    await run.advance(20);
    await run.keys("press@30:37,wheelup@40:20");
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-56");
    // The program overwrites the active bottom row (the anchor), outside the scrolled viewport.
    program.output("\x1b[36;1HCHANGED\r\nrow-60");
    await run.advance(20);
    expect((await hostScreen(run)).text(37, 25, 30)).toBe("row-56");
    await run.keys("drag@25:37");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(37, 25, 30)).toBe("row-56");
    const from = run.host.output().length;
    await run.keys("release@25:37");
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(notices(run)).not.toContain("copied");
  }, TEST_MS);

  for (const held of [false, true]) for (const beforePress of [false, true]) {
    it(`selection uses the displayed screen when it switches ${beforePress ? "before" : "after"} press, ${held ? "during a hold" : "before repaint"}`, async () => {
      const run = await demo120();
      await run.advance(20);
      const program = run.core.program("t1");
      program.output("\x1b[H\x1b[2JVISIBLE-A");
      await run.settle();
      const passes = run.loop.report().passes;
      const from = run.host.output().length;
      if (!beforePress) await run.keys("press@25:2");
      program.output(`${held ? "\x1b[?2026h" : ""}\x1b[?1049h\x1b[H\x1b[2JREPLACED-B`);
      await run.settle();
      expect(run.loop.report().passes).toBe(passes);
      if (held) await run.advance(20);
      expect((await hostScreen(run)).text(2, 25, 33)).toBe("VISIBLE-A");
      if (beforePress) await run.keys("press@25:2");
      await run.keys("drag@28:2,release@28:2");
      expect(run.host.output().slice(from)).not.toContain("]52;");
      expect(notices(run)).not.toContain("copied");
      program.output("\x1b[?2026l");
      await run.advance(20);
      expect((await hostScreen(run)).text(2, 25, 34)).toBe("REPLACED-B");
      // Once B is actually displayed, a new selection belongs to B and can copy it.
      const after = run.host.output().length;
      await run.keys("press@25:2,drag@28:2,release@28:2");
      expect(run.host.output().slice(after)).toContain(osc52Of("REPL"));
    }, TEST_MS);
  }

  it("a drag whose pane switches to its alternate screen before the release copies nothing", async () => {
    const run = await demo120();
    const from = run.host.output().length;
    await run.keys("press@27:2,drag@30:2");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("echo");
    // the program switches to its alternate screen, with text where the selection's cells were
    run.core.program("t1").output("\x1b[?1049h\x1b[H\x1b[2JALTSCREEN-TEXT");
    await run.advance(20);
    expect((await hostScreen(run)).text(2, 25, 38)).toBe("ALTSCREEN-TEXT");
    await run.keys("release@30:2");
    await run.advance(20);
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(notices(run)).not.toContain("copied");
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("");
  }, TEST_MS);

  it("a drag on the alternate screen, drawn on the main screen and then on a new alternate screen before the release, copies nothing", async () => {
    const run = await demo120();
    const program = run.core.program("t1");
    program.output("\x1b[?1049h\x1b[H\x1b[2JALT-ONE-TEXT");
    await run.advance(20);
    const from = run.host.output().length;
    await run.keys("press@27:2,drag@30:2");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("T-ON");
    // back on the main screen, drawn; then a new alternate screen with other text where the selection was
    program.output("\x1b[?1049l");
    await run.advance(20);
    expect((await hostScreen(run)).text(2, 25, 30)).toBe("$ echo");
    program.output("\x1b[?1049h\x1b[H\x1b[2JALT-TWO-TEXT");
    await run.advance(20);
    expect((await hostScreen(run)).text(2, 25, 36)).toBe("ALT-TWO-TEXT");
    await run.keys("release@30:2");
    await run.advance(20);
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(notices(run)).not.toContain("copied");
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("");
  }, TEST_MS);

  for (const [ordering, transition] of [
    ["two mode changes", "\x1b[?1049l\x1b[?1049h"],
    ["a compound restore", "\x1b[?47;1049r"],
    ["a NUL in CSI entry", "\x1b[\x00?47l\x1b[?1049h"],
  ]) it(`an alternate screen replaced by ${ordering} in one output copies nothing at release`, async () => {
    const run = await demo120();
    const program = run.core.program("t1");
    program.output("\x1b[?47s\x1b[?1049h\x1b[?1049s\x1b[H\x1b[2JALT-ONE-TEXT");
    await run.advance(20);
    const from = run.host.output().length;
    await run.keys("press@27:2,drag@30:2");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("T-ON");
    // one write: the main screen is never drawn, and the pane is on its alternate screen before and after it
    program.output(`${transition}\x1b[H\x1b[2JALT-TWO-TEXT`);
    await run.advance(20);
    expect((await hostScreen(run)).text(2, 25, 36)).toBe("ALT-TWO-TEXT");
    await run.keys("release@30:2");
    await run.advance(20);
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(notices(run)).not.toContain("copied");
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("");
  }, TEST_MS);

  it("a drag on an alternate screen that a restored mode leaves before the release copies nothing", async () => {
    const run = await demo120();
    const program = run.core.program("t1");
    // mode 47 saved off on the main screen, then set
    program.output("\x1b[?47s\x1b[?47h\x1b[H\x1b[2JALT-ONE-TEXT");
    await run.advance(20);
    const from = run.host.output().length;
    await run.keys("press@27:2,drag@30:2");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("T-ON");
    // restored: back on the main screen, whose text lies under the selection's cells
    program.output("\x1b[?47r");
    await run.advance(20);
    expect((await hostScreen(run)).text(2, 25, 30)).toBe("$ echo");
    await run.keys("release@30:2");
    await run.advance(20);
    expect(run.host.output().slice(from)).not.toContain("]52;");
    expect(notices(run)).not.toContain("copied");
  }, TEST_MS);

  it("a switch to the screen a pane already shows keeps its selection, which the release copies", async () => {
    const run = await demo120();
    const program = run.core.program("t1");
    await run.keys("press@27:2,drag@30:2");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("echo");
    // already on the main screen: the reset changes nothing
    program.output("\x1b[?47l");
    await run.advance(20);
    expect((await hostScreen(run)).inverted(2, 25, 40)).toBe("echo");
    const from = run.host.output().length;
    await run.keys("release@30:2");
    await run.advance(20);
    expect(run.host.output().slice(from)).toContain(osc52Of("echo"));
  }, TEST_MS);

  it("a click on a pane without focus focuses it and is not forwarded; a click on a tab or a sidebar row selects it", async () => {
    const run = await demo120();
    run.core.program("t2").output("\x1b[?1002h\x1b[?1006h");
    await run.advance(20);
    const from = run.sent.length;
    await run.keys("click@80:5");
    expect(focusedPane(run)).toBe("t2");
    expect(dataTo(run, "t2", from)).toEqual([]);
    expect(run.core.program("t2").receivedHex()).toBe("");
    await run.keys("click@80:5");
    expect(run.core.program("t2").receivedHex()).toBe(hexOf("\x1b[<0;8;4M\x1b[<0;8;4m"));
    // "2:logs" in the tab bar
    expect((await hostScreen(run)).text(0, 33, 38)).toBe("2:logs");
    await run.keys("click@34:0");
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-logs");
    // the second workspace's row in the sidebar
    expect((await hostScreen(run)).text(3, 2, 7)).toBe("2:문서");
    await run.keys("click@3:3");
    expect(run.loop.model().focus.workspace).toBe("w-docs");
  }, TEST_MS);

  it("a divider drag draws ahead, keeps one layout write in flight and the newest ratio for the next", async () => {
    const run = await demo120();
    // the divider: t1's right border at x 71, t2's left one at x 72
    expect((await hostScreen(run)).text(10, 70, 73)).toBe(" || ");
    await run.keys("press@71:10");
    // three moves in one read: the first is written, the newest waits for its answer, the middle one is never written
    run.type("\x1b[<32;66;11M\x1b[<32;61;11M\x1b[<32;56;11M");
    await run.settle();
    const ratios = docSets(run).map((frame) => JSON.parse(new TextDecoder().decode(frame.payload)).params.value.workspaces[0].tabs[0].root.ratio);
    expect(ratios).toEqual([42 / 96, 32 / 96]);
    await run.advance(20);
    // drawn at the newest ratio: t1's box ends at x 55, t2's starts at x 56
    expect((await hostScreen(run)).text(1, 55, 56)).toBe("++");
    await run.keys("release@55:10");
    await run.advance(20);
    expect(docSets(run).length).toBe(2);
    expect((await hostScreen(run)).text(1, 55, 56)).toBe("++");
    expect((run.core.docs.get(OVIS_LAYOUT_DOC)!.value as { workspaces: { tabs: { root: { ratio: number } }[] }[] }).workspaces[0]!.tabs[0]!.root.ratio).toBe(32 / 96);
  }, TEST_MS);

  it("a drag that began with the press that only focused a pane reaches no program, even after an earlier click reached it", async () => {
    const run = await demo120();
    run.core.program("t2").output("\x1b[?1002h\x1b[?1006h");
    await run.advance(20);
    // focus t2, then one click it really gets, then focus t1 again
    await run.keys("click@80:5,click@80:5");
    expect(run.core.program("t2").receivedHex()).toBe(hexOf("\x1b[<0;8;4M\x1b[<0;8;4m"));
    await run.keys("click@30:5");
    expect(focusedPane(run)).toBe("t1");
    const heard = run.core.program("t2").receivedHex().length;
    const from = run.sent.length;
    // a click on t2 whose pointer moved: the focus moves at the press, and nothing of the gesture is sent
    await run.keys("press@80:5,drag@81:5,drag@82:6,release@82:6");
    expect(focusedPane(run)).toBe("t2");
    expect(run.core.program("t2").receivedHex().slice(heard)).toBe("");
    expect(dataTo(run, "t2", from)).toEqual([]);
    // the next click on the focused pane reaches it whole
    await run.keys("click@80:5");
    expect(run.core.program("t2").receivedHex().slice(heard)).toBe(hexOf("\x1b[<0;8;4M\x1b[<0;8;4m"));
  }, TEST_MS);

  it("a drag begun on the tab bar reaches no program when it moves over the focused pane", async () => {
    const run = await demo120();
    run.core.program("t2").output("\x1b[?1002h\x1b[?1006h");
    await run.advance(20);
    await run.keys("click@80:5,click@80:5");
    expect(focusedPane(run)).toBe("t2");
    const heard = run.core.program("t2").receivedHex().length;
    const from = run.sent.length;
    await run.keys("press@100:0,drag@80:5,drag@81:5,release@81:5");
    expect(focusedPane(run)).toBe("t2");
    expect(run.core.program("t2").receivedHex().slice(heard)).toBe("");
    expect(dataTo(run, "t2", from)).toEqual([]);
  }, TEST_MS);

  it("with 1003 a focusing click whose pointer moves one cell sends nothing; a move with no button then reaches the focused program", async () => {
    const run = await demo120();
    run.core.program("t2").output("\x1b[?1003h\x1b[?1006h");
    await run.advance(20);
    await run.keys("click@80:5,click@80:5,click@30:5");
    expect(focusedPane(run)).toBe("t1");
    const heard = run.core.program("t2").receivedHex().length;
    await run.keys("press@80:5,drag@81:5,release@81:5");
    expect(focusedPane(run)).toBe("t2");
    expect(run.core.program("t2").receivedHex().slice(heard)).toBe("");
    // a move with no button held over the focused t2: screen cell (82, 5) is its cell (9, 3)
    run.type("\x1b[<35;83;6M");
    await run.settle();
    expect(run.core.program("t2").receivedHex().slice(heard)).toBe(hexOf("\x1b[<35;10;4M"));
  }, TEST_MS);

  it("a selection over wide letters draws inverted exactly what it copies, from either column of a letter", async () => {
    const run = await demo120();
    // t1's row 1 (screen row 3) starts with 안녕하세요: 안 in cells 25-26, 녕 in 27-28
    expect((await hostScreen(run)).text(3, 25, 29)).toBe("안녕하");
    for (const [keys, text] of [
      ["press@26:3,drag@28:3,release@28:3", "안녕"],
      ["press@28:3,drag@26:3,release@26:3", "안녕"],
      ["press@26:3,drag@27:3,release@27:3", "안녕"],
      ["press@25:3,drag@26:3,release@26:3", "안"],
    ] as const) {
      const written = run.host.output().length;
      await run.keys(keys);
      await run.advance(20);
      expect({ keys, copied: run.host.output().slice(written).includes(osc52Of(text)), drawn: (await hostScreen(run)).inverted(3, 25, 45) }).toEqual({ keys, copied: true, drawn: text });
    }
  }, TEST_MS);

  it("a divider drag with each move in its own read writes each move once the write before it is answered, the newest last", async () => {
    const run = await demo120();
    await run.keys("press@71:10");
    for (let n = 1; n <= 10; n++) {
      run.type(`\x1b[<32;${72 - n};11M`);
      await run.settle();
    }
    const ratios = docSets(run).map((frame) => JSON.parse(new TextDecoder().decode(frame.payload)).params.value.workspaces[0].tabs[0].root.ratio as number);
    expect(ratios.length).toBe(10);
    expect(ratios.every((ratio, n) => n === 0 || ratio < ratios[n - 1]!)).toBe(true);
    await run.keys("release@61:10");
    await run.advance(20);
    expect(docSets(run).length).toBe(10);
    expect((run.core.docs.get(OVIS_LAYOUT_DOC)!.value as { workspaces: { tabs: { root: { ratio: number } }[] }[] }).workspaces[0]!.tabs[0]!.root.ratio).toBe(ratios.at(-1)!);
  }, TEST_MS);

  it("a click on an overlay's close control closes it; a click elsewhere in it does nothing", async () => {
    const run = await demo120();
    await run.keys("ctrl+b,?");
    await run.advance(20);
    expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["help"]);
    // the close keys sit at the top right of the help, cells 93-114 of row 2
    await run.keys("click@60:10");
    expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["help"]);
    await run.keys("click@100:2");
    expect(run.loop.model().overlays).toEqual([]);
  }, TEST_MS);

  it("the wheel draws every row of the pane at its new place", async () => {
    const run = await demo120();
    run.core.program("t1").output(Array.from({ length: 60 }, (_, n) => `row-${n}`).join("\r\n"));
    await run.advance(20);
    const rows = async () => {
      const screen = await hostScreen(run);
      return Array.from({ length: 36 }, (_, y) => screen.text(2 + y, 25, 30));
    };
    const shown = (bottom: number) => Array.from({ length: 36 }, (_, y) => `row-${bottom - 35 + y}`);
    expect(await rows()).toEqual(shown(59));
    for (const [keys, bottom] of [["wheelup@40:20", 56], ["wheelup@40:20,wheelup@40:20", 50], ["wheeldown@40:20", 53], ["wheeldown@40:20,wheeldown@40:20", 59]] as const) {
      await run.keys(keys);
      await run.advance(20);
      expect({ keys, rows: await rows() }).toEqual({ keys, rows: shown(bottom) });
    }
  }, TEST_MS);

  it("a divider drag released over the help draws the core's ratio once another writer changes it", async () => {
    const run = await demo120();
    await run.keys("press@71:10,drag@60:10");
    await run.advance(20);
    // drawn ahead: t1's box ends at x 60, t2's starts at x 61
    expect((await hostScreen(run)).text(10, 59, 62)).toBe(" || ");
    await run.keys("ctrl+b,?");
    expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["help"]);
    await run.keys("release@60:10");
    await run.advance(20);
    await run.keys("click@100:2");
    expect(run.loop.model().overlays).toEqual([]);
    await rivalWrites(run.core, (value) => ({ ...value, workspaces: value.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => tab.id === "t-main" ? { ...tab, root: { ...(tab.root as object), ratio: 0.75 } } : tab) })) }));
    await run.advance(20);
    // the core's 72 of 96 columns: t1's box ends at x 95, t2's starts at x 96
    expect((await hostScreen(run)).text(10, 94, 97)).toBe(" || ");
  }, TEST_MS);

  it("a divider released on another tab draws the core's ratio once another writer changed it while its tab was not shown", async () => {
    const run = await demo120();
    await run.keys("press@71:10,drag@60:10");
    await run.advance(20);
    expect((await hostScreen(run)).text(10, 59, 62)).toBe(" || ");
    await run.keys("ctrl+b,n");
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-logs");
    await run.live();
    await run.keys("release@60:10");
    await run.advance(20);
    await rivalWrites(run.core, (value) => ({ ...value, workspaces: value.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => tab.id === "t-main" ? { ...tab, root: { ...(tab.root as object), ratio: 0.75 } } : tab) })) }));
    await run.advance(20);
    // back by a click on "1:main" in the tab bar
    expect((await hostScreen(run)).text(0, 25, 30)).toBe("1:main");
    await run.keys("click@26:0");
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-main");
    await run.live();
    // the core's 72 of 96 columns: t1's box ends at x 95, t2's starts at x 96
    expect((await hostScreen(run)).text(10, 94, 97)).toBe(" || ");
  }, TEST_MS);

  for (const editBeforePress of [true, false]) it(`divider drag is stale after a foreign edit ${editBeforePress ? "before" : "after"} the press, before repaint`, async () => {
    const run = await demo120();
    await run.advance(20);
    run.core.program("t1").output("paint");
    await run.settle();
    const passes = run.loop.report().passes;
    if (!editBeforePress) await run.keys("press@71:10");
    const rival = await rivalWrites(run.core, (value) => ({ ...value, workspaces: value.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => tab.id === "t-main" ? { ...tab, root: { split: "down", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } } } : tab) })) }));
    await run.settle();
    expect(run.loop.report().passes).toBe(passes);
    expect((await hostScreen(run)).text(10, 70, 73)).toBe(" || ");
    if (editBeforePress) await run.keys("press@71:10");
    await run.keys("drag@60:10,release@60:10");
    await run.advance(20);
    expect(docSets(run)).toEqual([]);
    expect(notices(run)).toContain("stale");
    expect(run.core.docs.get(OVIS_LAYOUT_DOC)!.value).toEqual(rival);
  }, TEST_MS);

  it("divider drag is stale after a foreign edit", async () => {
    const run = await demo120();
    await run.keys("press@71:10");
    // another writer turns the split: t2 now lies under t1, so the grabbed divider is gone
    const rival = await rivalWrites(run.core, (value) => ({ ...value, workspaces: value.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => tab.id === "t-main" ? { ...tab, root: { split: "down", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } } } : tab) })) }));
    await run.advance(20);
    await run.keys("drag@60:10,drag@50:10,release@50:10");
    await run.advance(20);
    expect(notices(run)).toContain("stale");
    expect(docSets(run)).toEqual([]);
    expect(run.core.docs.get(OVIS_LAYOUT_DOC)!.value).toEqual(rival);
  }, TEST_MS);
});

interface LayoutValue { workspaces: { id: string; tabs: { id: string; root: unknown; zoomed: string | null }[] }[] }

/** Another client writes the layout document: it reads it (or the labels' layout when none is kept), changes it, writes it. */
async function rivalWrites(core: FakeHcCore, change: (value: LayoutValue) => LayoutValue): Promise<LayoutValue> {
  const rival = new HcConnection(() => core.transport());
  try {
    const doc = await rival.call("doc.get", { name: OVIS_LAYOUT_DOC });
    const base: LayoutValue = (doc.value as LayoutValue | null) ?? { workspaces: [
      { id: "w-ovis", tabs: [{ id: "t-main", root: { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } }, zoomed: null }, { id: "t-logs", root: { leaf: "t3" }, zoomed: null }] },
      { id: "w-docs", tabs: [{ id: "t-notes", root: { leaf: "t4" }, zoomed: null }] },
    ] };
    const value = { schema: 1, ...change(base) };
    await rival.call("doc.set", { name: OVIS_LAYOUT_DOC, value, version: doc.version });
    return value as LayoutValue;
  } finally {
    rival.close();
  }
}
