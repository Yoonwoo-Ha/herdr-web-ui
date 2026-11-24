import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { IsolatedCore, stoppedCleanly } from "../scripts/test-hc.ts";
import { AUTOMATIC_INPUT_FEATURE, FRAME_AUTOMATIC_INPUT, FRAME_DATA, FRAME_FOCUS, FRAME_RESIZE } from "../server/herdr-core/connection.ts";
import { MAX_OSC52_BYTES } from "../shared/osc52.ts";
import { fresh, HOST_ANSWERS, RESTORE, visibleGrid } from "./testing/entry-pty.ts";
import { detach, fidelityScene, livePane } from "./testing/fidelity-scene.ts";
import { keyBytes } from "./testing/keys.ts";
import { gridText, hostCursorReport, screenOutput, stopAllPtyRuns, type SupervisedRun } from "./testing/pty.ts";

const bin = process.env["OVIS_TEST_HC_BIN"];
const grids = process.env["OVIS_TEST_ENTRY_GRIDS"] === "1";
const TIMEOUT = 60_000;
const CSI = "\x1b[";
const BEGIN_FRAME = `${CSI}?2026h`;
const END_FRAME = `${CSI}?2026l`;
const CD = `${CSI}97;6u`;
const PASTE = `${CSI}200~one\ntwo\nthree${CSI}201~`;
const DISPLAY_ANSWERS = [
  ...HOST_ANSWERS,
  ["\x1b]10;?\x1b\\", "\x1b]10;rgb:1212/3434/5656\x1b\\"],
  ["\x1b]11;?\x1b\\", "\x1b]11;rgb:abab/cdcd/efef\x1b\\"],
  ["\x1b[16t", "\x1b[6;20;9t"],
] as const;
const asText = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");
const click = (col: number, row: number) => keyBytes(`click@${col}:${row}`);

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const value = await read();
    if (matches(value) || performance.now() >= deadline) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function action(run: SupervisedRun, bytes: string): Promise<void> {
  const before = run.output().length;
  run.type(bytes);
  await fresh(run, before, END_FRAME);
}

/** A paint of the requested state, after this action, followed by that paint's closing marker. */
async function painted(run: SupervisedRun, from: number, marker: string): Promise<void> {
  await fresh(run, from, marker);
  await fresh(run, run.output().indexOf(marker, from) + marker.length, END_FRAME);
}

async function changeView(run: SupervisedRun, bytes: string, marker: string): Promise<void> {
  const before = run.output().length;
  run.type(bytes);
  await painted(run, before, marker);
}

/** Replay only complete new frames: a paint can change just one digit of a history label. */
async function gridAfter(run: SupervisedRun, from: number, cols: number, rows: number, matches: (grid: string) => boolean): Promise<string> {
  for (;;) {
    await fresh(run, from, BEGIN_FRAME);
    const start = run.output().indexOf(BEGIN_FRAME, from) + BEGIN_FRAME.length;
    await fresh(run, start, END_FRAME);
    const output = run.output();
    from = output.indexOf(END_FRAME, start) + END_FRAME.length;
    const grid = await gridText(screenOutput(output.slice(0, from)), cols, rows);
    if (matches(grid)) return grid;
  }
}

async function dump(run: SupervisedRun, name: string, cols = 100, rows = 30): Promise<string> {
  const grid = await visibleGrid(run, cols, rows);
  if (grids) console.log(`\n${name} (${cols}x${rows})\n${grid}`);
  return grid;
}

describe.skipIf(!bin || process.platform === "win32")("terminal fidelity through the real Ovis launcher", () => {
  let scene: Awaited<ReturnType<typeof fidelityScene>>;
  let core: IsolatedCore | undefined;
  let returnedCore: IsolatedCore | undefined;
  let closeScene: (() => Promise<void>) | undefined;
  let ending: Promise<void> | undefined;
  const stop = () => (ending ??= (async () => {
    await stopAllPtyRuns();
    await closeScene?.();
    for (const started of [returnedCore, core]) if (started) {
      const report = await started.stop();
      if (grids) console.log(`cleanup ${JSON.stringify(report)}`);
      expect(stoppedCleanly(report)).toBe(true);
    }
  })());
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) =>
    [signal, () => { void stop().finally(() => process.exit(128 + constants.signals[signal])); }] as const);
  for (const [signal, handler] of handlers) process.once(signal, handler);
  beforeEach(async () => {
    if (!bin) throw new Error("requires an isolated hc binary");
    ending = undefined;
    closeScene = undefined;
    returnedCore = undefined;
    core = new IsolatedCore(bin);
    await core.start();
    scene = await fidelityScene(core);
    closeScene = scene.close;
  }, TIMEOUT);
  afterEach(stop, TIMEOUT);
  afterAll(() => { for (const [signal, handler] of handlers) process.off(signal, handler); });

  it("K1: kitty flags and ctrl+shift+a encoding stay per pane across switches and a flag pop", async () => {
    const left = await scene.seed("LEFT", `${CSI}>1u`);
    const right = await scene.seed("RIGHT");
    const run = scene.screen();
    await livePane(run, left.name);
    await run.until("RIGHT-READY");
    run.type(CD);
    expect(asText(await left.received(CD.length))).toBe(CD);
    await action(run, "\x02l");
    run.type(CD);
    expect(asText(await right.received(1))).toBe("\x01");
    await action(run, "\x02h");
    run.type(CD);
    expect(asText(await left.received(CD.length * 2))).toBe(CD + CD);
    const before = run.output().length;
    left.emit(`${CSI}<u`, "FLAGS-POPPED");
    await fresh(run, before, "FLAGS-POPPED");
    run.type(CD);
    expect(asText(await left.received(CD.length * 2 + 1))).toBe(`${CD}${CD}\x01`);
    left.emit(`${CSI}>1u`, "FLAGS-PUSHED-AGAIN");
    await run.until("FLAGS-PUSHED-AGAIN");
    left.finish();
    // the ended pane closes at once, as herdr's: the right pane is the tab's only one, drawn with no border
    for (let grid = await gridText(run.output(), 100, 30); grid.includes("┌ LEFT "); grid = await gridText(run.output(), 100, 30)) {
      await run.until(new RegExp(`^[\\s\\S]{${run.output().length + 1}}`), "the left pane gone");
    }
    // the right pane grew: the prefix is the user's first key there, so the screen takes the terminal's new size
    // (docs/tui/parity.md, P6) and attaches again; a key is the pane's again once it is live
    await action(run, "\x02l");
    const reattaching = /sized by another viewer|closing stream|opening terminal|loading screen/;
    for (let grid = await gridText(run.output(), 100, 30); reattaching.test(grid.split("\n")[0]!); grid = await gridText(run.output(), 100, 30)) {
      await run.until(new RegExp(`^[\\s\\S]{${run.output().length + 1}}`), "the right pane live at its new size");
    }
    run.type(CD);
    expect(asText(await right.received(2))).toBe("\x01\x01");
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("K2: the legacy program receives ctrl+a, Alt+a and each lone Escape", async () => {
    const pane = await scene.seed("LEGACY");
    const run = scene.screen();
    await livePane(run, pane.name);
    run.type(CD + "\x1ba\x1b");
    expect(asText(await pane.received(4))).toBe("\x01\x1ba\x1b");
    run.type("\x1b\x1b");
    expect(asText(await pane.received(6))).toBe("\x01\x1ba\x1b\x1b\x1b");
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("K4: prefix actions, doubled prefix, cancellation, unbound key and lock stay on their side of the input ladder", async () => {
    const pane = await scene.seed("KEYS");
    const run = scene.screen();
    await livePane(run, pane.name);
    await changeView(run, "\x02?", "Keyboard Shortcuts");
    expect(await dump(run, "K4 help at 100x30")).toContain("esc close");
    await changeView(run, "\x1b", `${CSI}?25h`);
    run.type("\x02\x02");
    expect(asText(await pane.received(1))).toBe("\x02");
    await changeView(run, "\x02", "PREFIX");
    // terminal mode has no bar: the frame that takes the PREFIX bar away shows the host's cursor again
    await changeView(run, "\x1b", `${CSI}?25h`);
    run.type("\x02~z");
    expect(asText(await pane.received(2))).toBe("\x02z");
    // Kitty keyboard encoding for Ctrl+Alt+g (5 = Ctrl, 3 = Alt, 7 = both).
    await changeView(run, `${CSI}103;7u`, "LOCKED");
    run.type("\x02q");
    expect(asText(await pane.received(4))).toBe("\x02z\x02q");
    await changeView(run, `${CSI}103;7u`, `${CSI}?25h`);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("P1: the bracketed program gets one three-line paste, without early delivery", async () => {
    const pane = await scene.seed("BRACKETED", `${CSI}?2004h`);
    const run = scene.screen();
    await livePane(run, pane.name);
    const end = PASTE.lastIndexOf("\x1b");
    run.type(PASTE.slice(0, end));
    // A fresh frame from the same pane while the paste is incomplete fences the check.
    pane.emit("", "INCOMPLETE");
    await run.until("INCOMPLETE");
    expect(pane.input()).toHaveLength(0);
    run.type(PASTE.slice(end));
    expect(asText(await pane.received(PASTE.length))).toBe(PASTE);
    expect(scene.wire.frames.filter((frame) => frame.kind === FRAME_DATA).map(({ payload }) => asText(payload))).toEqual([PASTE]);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("P2: legacy paste gets CR line endings and a partial end marker cannot finish the paste", async () => {
    const pane = await scene.seed("PLAIN");
    const run = scene.screen();
    await livePane(run, pane.name);
    const expected = "one\rtwo [201x\rthree";
    run.type(`${CSI}200~one\ntwo${CSI}201`);
    pane.emit("", "FALSE-END");
    await run.until("FALSE-END");
    expect(pane.input()).toHaveLength(0);
    run.type(`x\nthree${CSI}201~`);
    expect(asText(await pane.received(expected.length))).toBe(expected);
    expect(scene.wire.frames.filter(({ kind }) => kind === FRAME_DATA).map(({ payload }) => asText(payload))).toEqual([expected]);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("M1: mouse-mode clicks use pane cells; shift drag and mouse-off selection and scroll stay local", async () => {
    const pane = await scene.seed("SELECT", `${CSI}?1000h${CSI}?1006h`);
    const run = scene.screen();
    await livePane(run, pane.name);
    // a tab's only pane has no border: the program's cell (5, 3) is screen cell (31, 4)
    run.type(click(31, 4));
    const expected = "\x1b[<0;6;4M\x1b[<0;6;4m";
    expect(asText(await pane.received(expected.length))).toBe(expected);
    // Menu at the foot of the sidebar's workspaces (their half of 30 rows ends at row 14)
    await changeView(run, click(22, 14), " reload config ");
    expect(pane.input()).toHaveLength(expected.length);
    await changeView(run, "\x1b", `${CSI}?25h`);
    run.type(["shift+press@26:1", "shift+drag@37:1", "shift+release@37:1"].map(keyBytes).join(""));
    await run.until(`\x1b]52;c;${Buffer.from("SELECT-READY").toString("base64")}\x1b\\`);
    expect(asText(pane.input())).toBe(expected);
    const history = run.output().length;
    pane.emit(`${CSI}?1000l${CSI}?1006l\r\n${Array.from({ length: 65 }, (_, i) => `HISTORY-${i}\r\n`).join("")}LOCAL-SELECT`);
    await painted(run, history, "LOCAL-SELECT");
    const grid = await dump(run, "M1 local mouse");
    const row = grid.split("\n").findIndex((line) => line.includes("LOCAL-SELECT"));
    expect(row).toBeGreaterThan(2);
    const col = grid.split("\n")[row]?.indexOf("LOCAL-SELECT") ?? -1;
    expect(col).toBeGreaterThan(0);
    const before = run.output().length;
    run.type([`press@${col}:${row}`, `drag@${col + 11}:${row}`, `release@${col + 11}:${row}`].map(keyBytes).join(""));
    await fresh(run, before, `\x1b]52;c;${Buffer.from("LOCAL-SELECT").toString("base64")}\x1b\\`);
    const wheel = run.output().length;
    run.type(keyBytes(`wheelup@${col}:${row}`));
    // Scrolling replaces the tail marker with earlier history in the same row. A copy redraw
    // can end between the wheel write and that paint and still show LOCAL-SELECT.
    const scrolled = await gridAfter(run, wheel, 100, 30, (grid) => grid.split("\n")[row]?.includes("HISTORY-62") === true);
    expect(scrolled).not.toContain("LOCAL-SELECT");
    run.type("x");
    expect(asText(await pane.received(expected.length + 1))).toBe(expected + "x");
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("M2: 0.1.18 switches send automatic focus; 0.1.17 delays focus-in to a key and sends FOCUS 0 on tab hide", async () => {
    const modern = (await scene.hc.hello()).features.includes(AUTOMATIC_INPUT_FEATURE);
    const left = await scene.seed("FOCUS", `${CSI}?1004h`);
    const right = await scene.seed("NEIGHBOR");
    await scene.seed("OTHER", "", "two");
    const run = scene.screen();
    await livePane(run, left.name);
    await run.until(`${right.name}-READY`);
    const size = await left.nextSize();
    if (modern) {
      expect(asText(await left.received(3))).toBe(`${CSI}I`);
      await action(run, "\x02l");
      await action(run, "\x02h");
      expect(asText(await left.received(9))).toBe(`${CSI}I${CSI}O${CSI}I`);
      expect(scene.wire.frames.filter(({ kind }) => kind === FRAME_AUTOMATIC_INPUT).map(({ payload }) => asText(payload))).toEqual([`${CSI}I`, `${CSI}O`, `${CSI}I`]);
    } else {
      await action(run, "\x02l");
      await action(run, "\x02h");
      expect(left.input()).toHaveLength(0);
      run.type("x");
      expect(asText(await left.received(4))).toBe(`${CSI}Ix`);
      run.type("\x022");
      await run.until("OTHER-READY");
      expect(asText(await left.received(7))).toBe(`${CSI}Ix${CSI}O`);
      expect(scene.wire.frames.filter(({ kind }) => kind === FRAME_FOCUS).map(({ payload }) => [...payload])).toEqual([[1], [0]]);
    }
    if (modern) expect(await left.nextSize()).toEqual(size);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("M3: a background pane cannot ring, change the cursor or paint terminal notifications; the cursor applies on focus", async () => {
    const left = await scene.seed("FOREGROUND");
    const right = await scene.seed("BACKGROUND");
    const run = scene.screen();
    await livePane(run, left.name);
    await run.until("BACKGROUND-READY");
    const before = run.output().length;
    right.emit("\x1b]2;BACKGROUND-TITLE\x1b\\\x07\x1b[6 q\x1b]9;TOAST9\x1b\\\x1b]99;i=probe;TOAST99\x1b\\\x1b]777;notify;PROBE;TOAST777\x1b\\", "BACKGROUND-CHANGED");
    await fresh(run, before, "BACKGROUND-CHANGED");
    await fresh(run, before, END_FRAME);
    expect(run.output().slice(before)).not.toMatch(/BACKGROUND-TITLE|TOAST(?:9|99|777)|\x07|\x1b\[6 q/);
    const focus = run.output().length;
    await action(run, "\x02l");
    expect(run.output().slice(focus)).toContain(`${CSI}6 q`);
    await action(run, "\x02h");
    left.emit("\x07", "FOREGROUND-BELL");
    await fresh(run, before, "\x07");
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("O1: clipboard writes below the cap reach the host; oversized writes and reads do not", async () => {
    const pane = await scene.seed("COPY");
    const run = scene.screen();
    await livePane(run, pane.name);
    const copy = "\x1b]52;c;cGFuZS1jb3B5\x1b\\";
    const from = run.output().length;
    pane.emit(copy, "COPY-OK");
    pane.emit(`\x1b]52;c;${Buffer.alloc(MAX_OSC52_BYTES + 1, "x").toString("base64")}\x1b\\\x1b]52;c;?\x1b\\`, "COPY-END");
    await fresh(run, from, "COPY-END");
    run.type("z");
    expect(asText(await pane.received(1))).toBe("z");
    expect(run.output().slice(from).match(/\x1b\]52;[^\x1b]*\x1b\\/g)).toEqual([copy]);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("C1: host COLORTERM controls paint depth; new panes receive the shared terminal environment", async () => {
    const pane = await scene.seed("RGB", `${CSI}38;2;73;109;141m`);
    for (const color of ["truecolor", ""] as const) {
      const run = scene.screen({}, 100, 30, undefined, { COLORTERM: color });
      await livePane(run, pane.name);
      expect(run.output().includes("38;2;73;109;141")).toBe(color === "truecolor");
      if (!color) expect(run.output()).toMatch(/38;5;\d+mRGB-READY/);
      await dump(run, `C1 COLORTERM=${color || "(empty)"}`);
      if (!color) {
        await action(run, "\x02c");
        run.type("color-check\r");
        const request = await until(async () => scene.wire.requests.find(({ method }) => method === "terminal.run"), Boolean);
        // The pane's emulator is truecolor even when its outside display is not.
        expect(request?.params["env"]).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor" });
      }
      expect(await detach(run)).toBe(0);
    }
  }, TIMEOUT);

  // C2 and C3 run in display.live.test.ts, which traces attach facts and graphics replies.
  it("W1: Korean, ZWJ and combining characters give the same pane-relative DSR column on the host and core", async () => {
    const pane = await scene.seed("WIDTH");
    const run = scene.screen({}, 60, 30);
    await livePane(run, pane.name);
    const value = "한글👩‍💻e\u0301";
    run.type(value);
    const count = Buffer.byteLength(value);
    expect((await pane.received(count)).toString("utf8")).toBe(value);
    const mode = `${CSI}?2027;1$y`;
    pane.emit(`${CSI}?2027$p`);
    expect(asText((await pane.received(count + mode.length)).subarray(count))).toBe(mode);
    const received = count + mode.length;
    const before = run.output().length;
    pane.emit(`\r\n${value}${CSI}6n`);
    const reply = (await pane.received(received + 6)).subarray(received).toString("latin1");
    const lastGlyph = "e\u0301";
    await fresh(run, before, lastGlyph);
    await fresh(run, run.output().indexOf(lastGlyph, before) + lastGlyph.length, `${CSI}?25h${END_FRAME}`);
    const host = await hostCursorReport(screenOutput(run.output()), 60, 30);
    const paneColumn = Number(reply.match(/\x1b\[\d+;(\d+)R/)?.[1]);
    const hostColumn = Number(host.match(/\x1b\[\d+;(\d+)R/)?.[1]);
    expect(paneColumn, `pane DSR=${JSON.stringify(reply)}`).toBe(8);
    expect(hostColumn, `host DSR=${JSON.stringify(host)}`).toBe(paneColumn); // a tab's only pane has no border
    await dump(run, "W1 cursor after Korean, ZWJ and combining input", 60, 30);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("R1: a window resize advertises the new rectangle once, without a RESIZE frame", async () => {
    const pane = await scene.seed("RESIZE");
    const run = scene.screen({}, 80, 24);
    await livePane(run, pane.name);
    const initial = await pane.nextSize();
    // a tab's only pane: no border, its last column kept for its scrollbar, no row kept for a mode line
    expect(initial).toEqual({ cols: 53, rows: 23 });
    // one column wider than the pane: the line wraps before its last five letters at 80x24 and fits at 100x30
    pane.emit("\r\n" + "A".repeat(57) + "ZZ");
    await run.until("ZZ");
    expect(await visibleGrid(run, 80, 24)).not.toContain("AAAAAZZ");
    const before = run.output().length;
    run.resize(100, 30);
    await fresh(run, before, "AAAAAZZ");
    expect(await until(pane.nextSize, ({ cols, rows }) => cols === 73 && rows === 29)).toEqual({ cols: 73, rows: 29 });
    expect(scene.wire.requests.filter(({ method }) => method === "terminal.attach").map(({ params }) => [params["cols"], params["rows"]]))
      .toEqual([[53, 23], [73, 29]]);
    expect(scene.wire.frames.filter(({ kind }) => kind === FRAME_RESIZE)).toEqual([]);
    expect(await dump(run, "R1 reflow after resize")).toContain("AAAAAZZ");
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("R2: detach restores host modes and reattach replays application mouse and paste modes", async () => {
    const pane = await scene.seed("REPLAY", `${CSI}?1000h${CSI}?1006h${CSI}?2004h`);
    const run = scene.screen();
    await livePane(run, pane.name);
    expect(await detach(run)).toBe(0);
    expect(run.output().split(RESTORE)).toHaveLength(2);
    const again = scene.screen();
    await livePane(again, pane.name);
    for (const mode of [1004, 1002, 1006, 2004]) expect(again.output()).toContain(`${CSI}?${mode}h`);
    expect(again.output()).toContain(`${CSI}>1u`);
    again.type(PASTE + click(31, 4));
    const expected = PASTE + "\x1b[<0;6;4M\x1b[<0;6;4m";
    expect(asText(await pane.received(expected.length))).toBe(expected);
    expect(await detach(again)).toBe(0);
  }, TIMEOUT);

  it("E1: 0.1.18 sends emulator replies as AUTOMATIC_INPUT and 0.1.17 as DATA once driving; neither duplicates DA1", async () => {
    const modern = (await scene.hc.hello()).features.includes(AUTOMATIC_INPUT_FEATURE);
    const pane = await scene.seed("REPLIES");
    const run = scene.screen();
    await livePane(run, pane.name);
    run.type("X");
    expect(asText(await pane.received(1))).toBe("X");
    const from = scene.wire.frames.length;
    pane.emit(`${CSI}c`, "ASKED");
    await run.until("ASKED");
    const da = asText(await pane.received(1 + 6));
    expect(da).toMatch(/^X\x1b\[\?[\d;]+c$/);
    expect(scene.wire.frames.slice(from).filter(({ kind }) => kind === FRAME_DATA || kind === FRAME_AUTOMATIC_INPUT)).toEqual([]);
    // Both tested cores intercept terminal queries (including mode and palette queries). Put
    // one query on the real viewer channel, downstream of the core, to test the viewer answer.
    const paint = scene.wire.received.find(({ kind, payload }) => kind === FRAME_DATA && payload[0] === 0x18);
    if (!paint) throw new Error("did not observe the initial attach paint");
    scene.wire.viewerData(paint, `${CSI}?2004$p`);
    const received = asText(await pane.received(da.length + 11));
    expect(received).toMatch(/\x1b\[\?[\d;]+c/);
    expect(received.match(/\x1b\[\?[\d;]+c/g)).toHaveLength(1);
    expect(received).toBe(`${da}${CSI}?2004;2$y`);
    expect(scene.wire.frames.slice(from).filter(({ kind }) => kind === FRAME_DATA || kind === FRAME_AUTOMATIC_INPUT)
      .map(({ kind, payload }) => [kind, asText(payload)])).toEqual([[modern ? FRAME_AUTOMATIC_INPUT : FRAME_DATA, `${CSI}?2004;2$y`]]);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("E2: a CAN repaint replaces an interrupted control string without delaying the other pane", async () => {
    const left = await scene.seed("INTERRUPTED");
    const right = await scene.seed("RESPONSIVE");
    const run = scene.screen();
    await livePane(run, left.name);
    await run.until("RESPONSIVE-READY");
    left.emit(`\r\nREPAINT-MARK\x1b]2;unfinished`);
    await run.until("REPAINT-MARK");
    await action(run, "\x02l");
    run.type("y");
    expect(asText(await right.received(1))).toBe("y");
    const from = run.output().length;
    const onWire = scene.wire.received.length;
    run.resize(120, 40);
    await fresh(run, from, "REPAINT-MARK");
    await fresh(run, from, END_FRAME);
    const grid = await dump(run, "E2 repaint after interrupted title", 120, 40);
    expect(grid).toContain("REPAINT-MARK");
    expect(grid).not.toContain("unfinished");
    expect(await until(async () => scene.wire.received.slice(onWire)
      .some(({ kind, payload }) => kind === FRAME_DATA && payload[0] === 0x18), Boolean)).toBe(true);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("E3: a cut reattaches the pane; a stopped core clears the view and never replays offline input", async () => {
    if (!bin || !core) throw new Error("requires an isolated hc binary");
    const pane = await scene.seed("BEFORE");
    const run = scene.screen();
    await livePane(run, pane.name);
    let from = run.output().length;
    scene.wire.cut();
    await fresh(run, from, "herdr-core is not answering");
    expect(await visibleGrid(run, 100, 30)).toContain("BEFORE-READY");
    await changeView(run, "during-cut", "input_refused");
    const requests = scene.wire.requests.length;
    from = run.output().length;
    scene.wire.resume();
    await fresh(run, from, "BEFORE-READY");
    await painted(run, run.output().indexOf("BEFORE-READY", from), `${CSI}?25h`);
    run.type("X");
    expect(asText(await pane.received(1))).toBe("X");
    const reopened = scene.wire.requests.slice(requests);
    expect(reopened.filter(({ method }) => method === "doc.get").map(({ params }) => params["name"])).toEqual(["herdr-app", "ovis-layout"]);
    expect(reopened.filter(({ method, params }) => method === "terminal.attach" && params["terminal"] === pane.id)).toHaveLength(1);
    from = run.output().length;
    expect(await scene.wire.stopCore()).toMatchObject({ result: { stopped: true } });
    await painted(run, from, "herdr-core is not answering");
    const cleared = await until(() => visibleGrid(run, 100, 30), (grid) => !grid.includes("BEFORE-READY"));
    expect(cleared).toContain("herdr-core is not answering");
    expect(cleared).not.toContain("BEFORE-READY");
    await dump(run, "E3 core stopped");
    // Fence the offline keys and paste on later input from the same PTY, before reconnecting.
    await changeView(run, `lost${CSI}200~discard${CSI}201~\x02?`, "Keyboard Shortcuts");
    const closeHelp = run.output().length;
    run.type("\r");
    await gridAfter(run, closeHelp, 100, 30, (grid) => grid.includes("herdr-core is not answering") && !grid.includes("Keyboard Shortcuts"));
    expect(await run.stty()).toMatchObject({ canonical: false, echo: false });
    returnedCore = new IsolatedCore(bin);
    await returnedCore.start();
    const returned = await fidelityScene(returnedCore);
    const closeOriginal = closeScene;
    closeScene = async () => { await returned.close(); await closeOriginal?.(); };
    const replacement = await returned.seed("AFTER");
    scene.wire.resume(returnedCore.socket);
    await livePane(run, replacement.name);
    run.type("z");
    expect(asText(await replacement.received(1))).toBe("z");
    await dump(run, "E3 new core with a new pane");
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("E4: exit, SIGTERM and unexpected screen errors restore the terminal once", async () => {
    const pane = await scene.seed("COOKED");
    for (const signal of [false, true]) {
      const run = scene.screen();
      await livePane(run, pane.name);
      if (signal) run.signal("SIGTERM");
      else run.type("\x02q");
      const end = await run.ended;
      expect(end.code).toBe(signal ? 143 : 0);
      expect(end.after).toMatchObject({ canonical: true, echo: true, signals: true });
      expect(run.output().split(RESTORE)).toHaveLength(2);
    }
    const preload = join(scene.core.root, "panic.ts");
    writeFileSync(preload, `process.stdin.on("data", (bytes) => {
      if (bytes.includes(0x21)) throw new Error("fidelity panic");
    });\n`);
    const states = join(scene.core.root, "panic-state");
    const run = scene.screen({}, 100, 30, [process.execPath, "--preload", preload, join(import.meta.dir, "main.ts")], { OVIS_TUI_STATE_DIR: states });
    await livePane(run, pane.name);
    run.type("!");
    const end = await run.ended;
    expect(end.code).toBe(70);
    expect(end.stderr).toContain("crashed");
    expect(end.after).toMatchObject({ canonical: true, echo: true, signals: true });
    expect(run.output().endsWith(RESTORE)).toBe(true);
    expect(run.output().split(RESTORE)).toHaveLength(2);
    expect(readdirSync(states).filter((file) => file.startsWith("crash-"))).toHaveLength(1);
  }, TIMEOUT);

  it("E5: probe replies do not reach a pane, and a host without DA1 reaches its first frame anyway", async () => {
    const pane = await scene.seed("PROBE");
    const before = performance.now();
    const run = scene.screen({ answers: DISPLAY_ANSWERS.filter(([question]) => question !== "\x1b[c") });
    await run.until("\x1b[c");
    const queried = performance.now();
    await livePane(run, pane.name);
    const elapsed = performance.now() - queried;
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(3_000);
    run.type("X");
    expect(asText(await pane.received(1))).toBe("X");
    if (grids) console.log(`E5 first paint: ${Math.round(performance.now() - before)} ms; after unanswered DA1: ${Math.round(elapsed)} ms`);
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);

  it("K17 and K26: on a narrow screen herdr's switcher can select another tab's agent reported by the live core", async () => {
    const pane = await scene.seed("SOLO");
    const agent = await scene.seed("AGENT-MENU", "\x1b]7501;state=blocked:app=claude-code\x1b\\", "two");
    const status = await until(async () => (await scene.hc.call("terminal.get", { terminal: agent.id })).status,
      (reported) => reported?.state === "blocked");
    expect(status?.state).toBe("blocked");
    const run = scene.screen({}, 60, 30);
    await livePane(run, pane.name);
    // the switch button at the right of the header's two rows
    await action(run, click(56, 1));
    const switcher = (await dump(run, "K17/K26: herdr's switcher with a real agent", 60, 30)).split("\n");
    const heading = switcher.findIndex((line) => line.startsWith("  Agents") || line.slice(1).startsWith(" Agents"));
    if (heading < 0) throw new Error(`no agents in the live switcher:\n${switcher.join("\n")}`);
    // the agent's entry is the two rows under the heading
    run.type(click(10, heading + 1));
    await livePane(run, "AGENT-MENU");
    expect(await detach(run)).toBe(0);
  }, TIMEOUT);
});
