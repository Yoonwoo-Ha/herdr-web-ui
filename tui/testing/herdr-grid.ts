/**
 * A screen as a cell grid with style, the form herdr's stored captures (tui/testing/herdr-captures/) and the screen's
 * own frames are compared in: every cell's text and its look (colours as the program wrote them, null for the host's
 * default, and the attributes). Also the emulated host the capture script (tui/testing/herdr-capture.ts) shows herdr
 * through: its two palettes and the answers it gives to a program's questions.
 */
import { join } from "node:path";
import { GhosttyEngine, GhosttyModule } from "../../shared/ghostty/engine.ts";

export type Rgb = readonly [number, number, number];
/** a colour as written: a palette index, an RGB value, or null for the host's default */
export type Written = number | Rgb | null;

/** the attributes a comparison looks at, one bit each */
export const LOOK_BOLD = 1;
export const LOOK_DIM = 2;
export const LOOK_ITALIC = 4;
export const LOOK_UNDERLINE = 8;
export const LOOK_REVERSE = 16;
export const LOOK_STRIKE = 32;
export const LOOK_INVISIBLE = 64;

export interface Look { readonly fg: Written; readonly bg: Written; readonly flags: number }
/** One cell: its text (" " for a blank, "" for the column a wide cell covers) and its look. */
export interface Cell { readonly ch: string; readonly look: Look }
export interface Cells {
  readonly cols: number;
  readonly rows: number;
  readonly cursor: { readonly visible: boolean; readonly x: number; readonly y: number };
  /** row by row, `cols` a row */
  readonly cells: readonly Cell[];
}

/** One run of cells of one look: from column `x`, its text one grapheme a cell, and which of them are wide. */
interface StoredRun { readonly x: number; readonly s: number; readonly t: string; readonly w?: readonly number[] }
/** A grid as stored: its looks once each, and its rows as runs (blank default cells at a row's end left out). */
export interface StoredGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cursor: Cells["cursor"];
  readonly looks: readonly Look[];
  readonly lines: readonly (readonly StoredRun[])[];
}

const BLANK: Look = Object.freeze({ fg: null, bg: null, flags: 0 });
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const lookKey = (look: Look): string => JSON.stringify([look.fg, look.bg, look.flags]);

export function encodeGrid(grid: Cells): StoredGrid {
  const looks: Look[] = [];
  const known = new Map<string, number>();
  const index = (look: Look): number => {
    const key = lookKey(look);
    let at = known.get(key);
    if (at === undefined) {
      at = looks.push(look) - 1;
      known.set(key, at);
    }
    return at;
  };
  const lines: StoredRun[][] = [];
  for (let y = 0; y < grid.rows; y++) {
    const row = grid.cells.slice(y * grid.cols, (y + 1) * grid.cols);
    let end = row.length;
    while (end > 0 && row[end - 1]!.ch === " " && lookKey(row[end - 1]!.look) === lookKey(BLANK)) end--;
    const runs: { x: number; s: number; t: string[]; w: number[] }[] = [];
    for (let x = 0; x < end; x++) {
      const cell = row[x]!;
      if (cell.ch === "") continue;
      const s = index(cell.look);
      const last = runs.at(-1);
      const wide = x + 1 < row.length && row[x + 1]!.ch === "";
      const reach = last ? last.x + last.t.length + last.w.length : -1;
      if (last && last.s === s && reach === x) {
        if (wide) last.w.push(last.t.length);
        last.t.push(cell.ch);
      } else runs.push({ x, s, t: [cell.ch], w: wide ? [0] : [] });
    }
    lines.push(runs.map((run) => ({ x: run.x, s: run.s, t: run.t.join(""), ...(run.w.length > 0 ? { w: run.w } : {}) })));
  }
  return { cols: grid.cols, rows: grid.rows, cursor: grid.cursor, looks, lines };
}

export function decodeGrid(stored: StoredGrid): Cells {
  const cells: Cell[] = Array.from({ length: stored.cols * stored.rows }, () => ({ ch: " ", look: BLANK }));
  stored.lines.forEach((runs, y) => {
    for (const run of runs) {
      const look = stored.looks[run.s]!;
      let x = run.x;
      [...segmenter.segment(run.t)].forEach(({ segment }, at) => {
        if (x < stored.cols) cells[y * stored.cols + x] = { ch: segment, look };
        x++;
        if (run.w?.includes(at)) {
          if (x < stored.cols) cells[y * stored.cols + x] = { ch: "", look };
          x++;
        }
      });
    }
  });
  return { cols: stored.cols, rows: stored.rows, cursor: stored.cursor, cells };
}

/** The grid's text, one string a row, blanks at a row's end dropped. */
export function gridText(grid: Cells): string[] {
  const rows: string[] = [];
  for (let y = 0; y < grid.rows; y++) rows.push(grid.cells.slice(y * grid.cols, (y + 1) * grid.cols).map((cell) => cell.ch).join("").trimEnd());
  return rows;
}

/** The host terminal a capture pretends to be: its default colours and its 16 ANSI colours. */
export interface HostPalette { readonly fg: Rgb; readonly bg: Rgb; readonly cursor: Rgb; readonly ansi: readonly Rgb[] }
export type PaletteName = "dark" | "light";

const hex = (value: string): Rgb => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];

/** A dark and a light host: the default terminal colours of a common editor's dark and light themes. */
export const PALETTES: Readonly<Record<PaletteName, HostPalette>> = {
  dark: {
    fg: hex("#cccccc"), bg: hex("#1e1e1e"), cursor: hex("#cccccc"),
    ansi: ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"].map(hex),
  },
  light: {
    fg: hex("#333333"), bg: hex("#ffffff"), cursor: hex("#333333"),
    ansi: ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"].map(hex),
  },
};

/** xterm's 256 colours: the host's 16, the 6x6x6 cube, the grey ramp. */
function color256(index: number, palette: HostPalette): Rgb {
  if (index < 16) return palette.ansi[index]!;
  if (index < 232) {
    const n = index - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return [level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6)];
  }
  const grey = 8 + (index - 232) * 10;
  return [grey, grey, grey];
}

const oscColor = (rgb: Rgb): string => `rgb:${rgb.map((v) => v.toString(16).padStart(2, "0").repeat(2)).join("/")}`;

/** The answer to a background colour question (OSC 11), as the palette's host gives it. */
export const backgroundAnswer = (name: PaletteName): string => `\x1b]11;${oscColor(PALETTES[name].bg)}\x1b\\`;

/**
 * Answers what a terminal answers, in arrival order, a question cut across reads included: DA1, DECRQM 2026, the
 * default colours (OSC 10, 11, 12), a palette entry (OSC 4) and the colour scheme (CSI ? 996 n).
 */
export function hostResponder(send: (bytes: string) => void, name: PaletteName): (text: string) => void {
  const palette = PALETTES[name];
  const question = /\x1b\[c|\x1b\[\?2026\$p|\x1b\[\?996n|\x1b\](1[012]);\?(?:\x1b\\|\x07)|\x1b\]4;(\d+);\?(?:\x1b\\|\x07)/g;
  let tail = "";
  return (text) => {
    const window = tail + text;
    let consumed = 0;
    question.lastIndex = 0;
    for (let match = question.exec(window); match; match = question.exec(window)) {
      consumed = question.lastIndex;
      const [whole, fixed, index] = match;
      if (whole === "\x1b[c") send("\x1b[?62;22c");
      else if (whole === "\x1b[?2026$p") send("\x1b[?2026;2$y");
      else if (whole === "\x1b[?996n") send(`\x1b[?997;${name === "dark" ? 1 : 2}n`);
      else if (fixed) send(`\x1b]${fixed};${oscColor(fixed === "10" ? palette.fg : fixed === "11" ? palette.bg : palette.cursor)}\x1b\\`);
      else if (index) send(`\x1b]4;${index};${oscColor(color256(Number(index), palette))}\x1b\\`);
    }
    tail = window.slice(Math.max(consumed, window.length - 24));
  };
}

// ghostty's style flags (tui/emulator/index.ts names the same bits)
const G_BOLD = 1, G_ITALIC = 2, G_FAINT = 4, G_INVERSE = 16, G_INVISIBLE = 32, G_STRIKE = 64, G_UNDERLINE = 0x700;

/** A look from ghostty's flags and colours as written. */
export function lookOf(fg: Written, bg: Written, flags: number): Look {
  return {
    fg, bg,
    flags: (flags & G_BOLD ? LOOK_BOLD : 0) | (flags & G_FAINT ? LOOK_DIM : 0) | (flags & G_ITALIC ? LOOK_ITALIC : 0)
      | (flags & G_UNDERLINE ? LOOK_UNDERLINE : 0) | (flags & G_INVERSE ? LOOK_REVERSE : 0) | (flags & G_STRIKE ? LOOK_STRIKE : 0)
      | (flags & G_INVISIBLE ? LOOK_INVISIBLE : 0),
  };
}

const WASM = join(import.meta.dir, "..", "..", "shared", "ghostty", "ghostty-vt.wasm");
let wasm: WebAssembly.Module | null = null;
const encoder = new TextEncoder();

/** A terminal emulator fed with what a program wrote; reads its cells back. `Screen.load()` comes first. */
export class Screen {
  private readonly engine: GhosttyEngine;

  constructor(readonly cols: number, readonly rows: number) {
    if (!wasm) throw new Error("Screen.load() must finish before a Screen is made");
    this.engine = new GhosttyEngine(new GhosttyModule(new WebAssembly.Instance(wasm, {})), cols, rows, { widths: "core", images: false });
  }

  static async load(): Promise<void> {
    wasm ??= new WebAssembly.Module(await Bun.file(WASM).arrayBuffer());
  }

  write(text: string): void {
    this.engine.write(encoder.encode(text));
  }

  text(): string {
    const lines: string[] = Array.from({ length: this.rows }, () => "");
    this.engine.frameAll((y, runs) => { lines[y] = runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd(); });
    return lines.join("\n");
  }

  cells(): Cells {
    const cells: Cell[] = Array.from({ length: this.cols * this.rows }, () => ({ ch: " ", look: BLANK }));
    this.engine.frameAll((y, runs) => {
      for (const run of runs) {
        const look = lookOf(run.fg as Written, run.bg as Written, run.flags);
        let x = run.x;
        for (const cell of run.cells) {
          if (x < this.cols) cells[y * this.cols + x] = { ch: cell.text === "" ? " " : cell.text, look };
          x++;
          if (cell.wide) {
            if (x < this.cols) cells[y * this.cols + x] = { ch: "", look };
            x++;
          }
        }
      }
    }, "written");
    const cursor = this.engine.cursor();
    return { cols: this.cols, rows: this.rows, cursor: { visible: cursor.visible, x: cursor.x, y: cursor.y }, cells };
  }

  dispose(): void {
    this.engine.dispose();
  }
}
