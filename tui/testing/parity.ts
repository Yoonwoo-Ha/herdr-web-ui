/**
 * The parity comparison (docs/tui/visual-parity.md): the screen's picture of a scene, drawn by the real loop over the
 * headless host and the fake core and read back through the same emulator herdr's captures were read through, against
 * herdr's stored capture of that scene, size and host palette (tui/testing/herdr-captures/, written only by
 * tui/testing/herdr-capture.ts).
 *
 * herdr's picture is first carried through the lines the owner keeps or settles later and the forced one, each by name
 * (`decisionsFor`): C1 maps herdr's palette onto the screen's theme roles, C2 puts the screen's own words where herdr
 * has its words, and the others leave out the cells their difference covers. Every other cell must then be the same:
 * its text, its attributes, its background, its foreground where a glyph shows it; and the host cursor (`compare`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { STRINGS } from "../strings.ts";
import { TUI_THEMES, type TuiColorRole } from "../theme.generated.ts";
import { place } from "./fixtures/fixture.ts";
import { backgroundAnswer, type Cell, type Cells, decodeGrid, gridText, LOOK_BOLD, LOOK_REVERSE, LOOK_STRIKE, LOOK_UNDERLINE, type PaletteName, Screen, type StoredGrid, type Written } from "./herdr-grid.ts";
import { CAPTURE_FOLDER, type PaneSpec, type Scene, type SceneKeys, WORLDS, type WorldName } from "./parity-scenes.ts";
import { Run } from "./run.ts";

/** herdr's stored picture of a scene, or null when the capture script has not written it. */
export function herdrPicture(scene: string, cols: number, rows: number, palette: PaletteName): Cells | null {
  const file = join(CAPTURE_FOLDER, `${scene}.${cols}x${rows}.json`);
  if (!existsSync(file)) return null;
  const stored = JSON.parse(readFileSync(file, "utf8")) as { dark: StoredGrid; light: StoredGrid | "dark" };
  const grid = palette === "light" && stored.light !== "dark" ? stored.light : stored.dark;
  return decodeGrid(grid);
}

/** A pane's first paint: the same lines herdr's capture program prints. */
const paintOf = (name: string): string => `${name}-READY\r\n${[1, 2, 3].map((n) => `line ${n} of ${name}\r\n`).join("")}$ `;

const SGR = (col: number, row: number, code: number, end: "M" | "m") => `\x1b[<${code};${col + 1};${row + 1}${end}`;

function find(rows: readonly string[], needle: string): { col: number; row: number } | null {
  for (let row = 0; row < rows.length; row++) {
    const col = rows[row]!.indexOf(needle);
    if (col >= 0) return { col, row };
  }
  return null;
}

/** The screen's picture of a scene: a fresh run of the world, the scene's keys, the frames it then draws. */
export async function ovisPicture(world: WorldName, scene: Scene, cols: number, rows: number, palette: PaletteName): Promise<Cells> {
  await Screen.load();
  const core = new FakeHcCore();
  const addresses = new Map<string, string>();
  // the world's checkouts as git leaves them on disk, as far as the screen reads them: a `.git` folder with its HEAD
  const home = WORLDS[world].checkouts ? mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "parity-")) : null;
  for (const checkout of WORLDS[world].checkouts ?? []) {
    if (checkout.linkedTo) {
      // a linked worktree: its `.git` file names its git folder in the repository's, which names it back (git worktree add)
      const own = join(home!, checkout.linkedTo, ".git", "worktrees", checkout.folder);
      mkdirSync(own, { recursive: true });
      mkdirSync(join(home!, checkout.folder), { recursive: true });
      writeFileSync(join(home!, checkout.folder, ".git"), `gitdir: ${own}\n`);
      writeFileSync(join(own, "HEAD"), `ref: refs/heads/${checkout.branch}\n`);
      writeFileSync(join(own, "gitdir"), `${join(home!, checkout.folder, ".git")}\n`);
      writeFileSync(join(own, "commondir"), "../..\n");
      continue;
    }
    mkdirSync(join(home!, checkout.folder, ".git"), { recursive: true });
    writeFileSync(join(home!, checkout.folder, ".git", "HEAD"), `ref: refs/heads/${checkout.branch}\n`);
  }
  for (const pane of WORLDS[world].panes) {
    const cwd = home && pane.folder ? join(home, pane.folder) : undefined;
    // the capture's mouse program: its name, then the mouse modes it asks for
    const paint = pane.mouse ? `${pane.name}-READY\r\n\x1b[?1000h\x1b[?1002h\x1b[?1006h` : paintOf(pane.name);
    const address = place(core, { space: pane.workspace, spaceName: pane.workspace, tab: `${pane.workspace}-${pane.tab}`, tabName: pane.tab, pane: pane.name, ...(cwd ? { cwd } : {}) }, paint);
    addresses.set(pane.name, address);
    if (pane.agent && pane.state) core.reportStatus(address, { state: pane.state, app: pane.agent });
  }
  const run = await Run.start({ core, cols, rows, answerFirst: backgroundAnswer(palette) });
  try {
    if (WORLDS[world].panes.length > 0) await run.live();
    else {
      // the screen opens a workspace of its own on an empty core: its shell shows a prompt, as herdr's does
      await run.advance(200);
      for (const view of run.loop.panes.views()) core.program(view.terminal).output("$ ");
      await run.live();
    }
    if (world === "ended") {
      core.program(addresses.get("RIGHT")!).exit(0);
      await run.advance(200);
    }
    if (scene.ovis) await apply(run, scene.ovis, addresses, WORLDS[world].panes);
    // the mouse program prints what it read as the capture's does: `GOT`, then od's characters
    for (const pane of WORLDS[world].panes.filter((one) => one.mouse)) {
      const read = Buffer.from(core.program(addresses.get(pane.name)!).receivedHex(), "hex").toString("latin1");
      if (read !== "") core.program(addresses.get(pane.name)!).output(`GOT ${[...read].map((ch) => (ch === "\x1b" ? "033" : ch)).join(" ")} \r\n`);
    }
    await run.advance(300);
    const screen = new Screen(cols, rows);
    try {
      screen.write(run.host.output());
      return screen.cells();
    } finally {
      screen.dispose();
    }
  } finally {
    await run.close();
    if (home) rmSync(home, { recursive: true, force: true });
  }
}

async function apply(run: Run, keys: SceneKeys, addresses: ReadonlyMap<string, string>, panes: readonly PaneSpec[]): Promise<void> {
  switch (keys.kind) {
    case "type":
      run.type(keys.text);
      await run.settle();
      return;
    case "click":
    case "drag": {
      const rows = run.grid();
      const at = keys.kind === "click" ? keys.labels.map((label) => find(rows, label)).find((one) => one !== null) ?? null : find(rows, keys.over);
      if (!at) throw new Error(`nothing to point at on the screen:\n${rows.join("\n")}`);
      const to = keys.kind === "drag" ? at.col + keys.over.length - 1 : at.col + 1;
      const from = keys.kind === "drag" ? at.col : at.col + 1;
      run.type(SGR(from, at.row, 0, "M"));
      await run.settle();
      if (keys.kind === "drag") {
        run.type(SGR(to, at.row, 32, "M"));
        await run.settle();
      }
      run.type(SGR(to, at.row, 0, "m"));
      await run.settle();
      return;
    }
    case "report": {
      const agent = panes.find((pane) => pane.name === keys.pane)?.agent ?? "claude";
      run.core.reportStatus(addresses.get(keys.pane)!, { state: keys.state, app: agent });
      await run.settle();
      return;
    }
    case "viewer":
      // P6 (forced): no case draws a second viewer (LEFT_OUT)
      throw new Error("the viewers scene is not drawn on the screen's side: it is left out of the comparison (P6)");
    case "rclick":
    case "rclickAt": {
      const rows = run.grid();
      const found = keys.kind === "rclick" ? findOn(rows, keys.label, keys.row) : null;
      if (keys.kind === "rclick" && !found) throw new Error(`no ${keys.label} to right-click on the screen:\n${rows.join("\n")}`);
      const [col, row] = keys.kind === "rclick" ? [found!.col + (keys.dx ?? 0), found!.row] : keys.at(run.host.size().cols, run.host.size().rows);
      run.type(SGR(col, row, 2, "M"));
      await run.settle();
      run.type(SGR(col, row, 2, "m"));
      await run.settle();
      return;
    }
    case "steps":
      for (const step of keys.steps) {
        await apply(run, step, addresses, panes);
        await run.advance(50);
      }
      return;
  }
}

/** The first `needle` on row `only` (any row when absent). */
function findOn(rows: readonly string[], needle: string, only?: number): { col: number; row: number } | null {
  return only === undefined ? find(rows, needle) : rows[only]?.includes(needle) ? { col: rows[only]!.indexOf(needle), row: only } : null;
}

/**
 * C1: herdr's palette (its default theme) mapped onto the screen's theme roles, one table for foregrounds and one for
 * backgrounds. A colour neither table names is a difference.
 */
const HERDR_FG: Readonly<Record<string, TuiColorRole>> = {
  "#cdd6f4": "text",
  "#a6adc8": "textDim",
  "#bac2de": "textDim",
  "#6c7086": "textDim",
  "#7f849c": "textDim",
  "#9399b2": "textDim",
  "#89b4fa": "accent",
  "#181825": "primaryText",
  "#11111b": "primaryText",
  "#1e1e2e": "border",
  "#313244": "border",
  "#45475a": "border",
  "#f38ba8": "statusBlocked",
  "#f9e2af": "statusWorking",
  "#94e2d5": "statusDone",
  "#a6e3a1": "statusDone",
  "#cba6f7": "statusWorking",
};
const HERDR_BG: Readonly<Record<string, TuiColorRole>> = {
  "#181825": "bgPanel",
  "#11111b": "bgPanel",
  "#1e1e2e": "bgElevated",
  "#313244": "bgHover",
  "#45475a": "bgHover",
  "#89b4fa": "accent",
  "#f38ba8": "statusBlocked",
  "#cba6f7": "statusWorking",
};

const hexOf = (color: Written): string | null => {
  if (color === null || typeof color === "number") return null;
  return `#${color.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};
const sameColor = (a: Written, b: Written): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * C2: herdr's words and the screen's own for the same thing (the screen keeps its words). With `shift`, what follows the
 * word on its row moves by the difference, as on the mode bar, and the cells left with no known text are holes.
 */
export interface Word { readonly herdr: string; readonly ovis: string; readonly align?: "right"; readonly shift?: true; readonly row?: number; readonly col?: number }

/**
 * A rectangle of cells a kept, owner's, part-2 or forced line covers, with that line's id, in the coordinates of the
 * picture it names. `glyph`: only the text and the foreground are left out (a state's own glyph and colour, S8); the
 * background and attributes still count. `bold`: only the bold attribute is left out.
 */
export interface Hole { readonly line: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly glyph?: true; readonly bold?: true }

/** How herdr's picture is carried over before its cells are compared: C2's words, and holes in herdr's picture and in the screen's. */
export interface Decisions {
  readonly words: readonly Word[];
  readonly holes: readonly Hole[];
  readonly ovisHoles?: readonly Hole[];
  /**
   * Where herdr's colours are compared as values, not by role (the sidebar: the screen draws herdr's own colours there):
   * no background where herdr writes none, and each colour herdr writes, exactly.
   */
  readonly exact?: readonly Omit<Hole, "line">[];
}

export interface Difference { readonly x: number; readonly y: number; readonly what: string; readonly herdr: string; readonly ovis: string }

const describe = (cell: Cell): string => `${JSON.stringify(cell.ch)} fg=${JSON.stringify(cell.look.fg)} bg=${JSON.stringify(cell.look.bg)} flags=${cell.look.flags}`;

/** herdr's picture with C2's words in: each word of a row put in the screen's word, in the look herdr gave the word. */
function withWords(grid: Cells, words: readonly Word[]): { cells: Cell[]; holes: Hole[] } {
  const cells = [...grid.cells];
  const holes: Hole[] = [];
  /** how much of a row is known after shifted words: past it, herdr's picture says nothing of the screen's */
  const known = new Map<number, number>();
  for (let y = 0; y < grid.rows; y++) {
    for (const word of words) {
      if (word.row !== undefined && word.row !== y) continue;
      if (word.col !== undefined) {
        // a word at its place: each of its cells herdr still shows (an overlay may cover some) takes the screen's word
        const herdrChars = [...word.herdr];
        const ovisChars = [...word.ovis];
        const start = word.align === "right" ? word.col - ovisChars.length + 1 : word.col;
        const herdrStart = word.align === "right" ? word.col - herdrChars.length + 1 : word.col;
        if (herdrChars.findIndex((ch, i) => cells[y * grid.cols + herdrStart + i]?.ch === ch) < 0) continue;
        const look = cells[y * grid.cols + herdrStart + (word.herdr.startsWith(" ") ? 1 : 0)]!.look;
        const blankLook = cells[y * grid.cols + (word.align === "right" ? herdrStart - 1 : herdrStart + herdrChars.length)]?.look ?? look;
        for (let x = Math.min(start, herdrStart); x < Math.max(start + ovisChars.length, herdrStart + herdrChars.length); x++) {
          const at = y * grid.cols + x;
          const was = herdrChars[x - herdrStart] ?? " ";
          if (x < 0 || x >= grid.cols || cells[at]!.ch !== was) continue;
          // the same letter of an overlay drawn over the word (its own look) is the overlay's, not the word's
          if (was !== " " && JSON.stringify(cells[at]!.look) !== JSON.stringify(look)) continue;
          const ch = ovisChars[x - start];
          cells[at] = ch === undefined ? { ch: " ", look: blankLook } : { ch, look: ch === " " ? cells[at]!.look : look };
        }
        continue;
      }
      if (word.shift) {
        const row = cells.slice(y * grid.cols, (y + 1) * grid.cols);
        const end = known.get(y) ?? grid.cols;
        const text = row.slice(0, end).map((cell) => cell.ch || "\u0000").join("");
        let at = text.indexOf(word.herdr);
        let cut = false;
        // a word herdr cut at the end of what is known of the row (the screen's edge): what follows it is not known
        for (let kept = word.herdr.length - 1; at < 0 && kept >= 1; kept--) {
          if (text.endsWith(` ${word.herdr.slice(0, kept)}`)) {
            at = end - kept;
            cut = true;
          }
        }
        if (at < 0) continue;
        const look = row[at]!.look;
        const next = [...row.slice(0, at), ...[...word.ovis].map((ch) => ({ ch, look })), ...(cut ? [] : row.slice(at + word.herdr.length, end))];
        known.set(y, Math.min(grid.cols, next.length));
        while (next.length < grid.cols) next.push({ ch: " ", look: row[grid.cols - 1]!.look });
        for (let x = 0; x < grid.cols; x++) cells[y * grid.cols + x] = next[x]!;
        continue;
      }
      const text = cells.slice(y * grid.cols, (y + 1) * grid.cols).map((cell) => cell.ch || "\u0000").join("");
      const at = text.indexOf(word.herdr);
      if (at < 0) continue;
      const look = cells[y * grid.cols + at]!.look;
      const after = cells[y * grid.cols + at + word.herdr.length]?.look ?? look;
      const start = word.align === "right" ? at + word.herdr.length - word.ovis.length : at;
      const span = [...word.ovis];
      for (let x = Math.min(start, at); x < Math.max(start + span.length, at + word.herdr.length); x++) {
        if (x < 0 || x >= grid.cols) continue;
        const inWord = x >= start && x < start + span.length;
        cells[y * grid.cols + x] = inWord ? { ch: span[x - start]!, look } : { ch: " ", look: word.align === "right" ? cells[y * grid.cols + x]!.look : after };
      }
    }
  }
  for (const [y, end] of known) if (end < grid.cols) holes.push({ line: "C2", x: end, y, width: grid.cols - end, height: 1 });
  return { cells, holes };
}

/** The cells of `holes` in a picture `cols` wide, with how much of each cell is left out. */
function held(holes: readonly Hole[], cols: number, rows: number): Map<number, "all" | "glyph" | "bold"> {
  const out = new Map<number, "all" | "glyph" | "bold">();
  for (const hole of holes) {
    for (let y = Math.max(0, hole.y); y < Math.min(rows, hole.y + hole.height); y++) {
      for (let x = Math.max(0, hole.x); x < Math.min(cols, hole.x + hole.width); x++) {
        const at = y * cols + x;
        const how = hole.glyph ? "glyph" : hole.bold ? "bold" : "all";
        const was = out.get(at);
        if (was !== "all" && !(was === "glyph" && how === "bold")) out.set(at, how);
      }
    }
  }
  return out;
}

/** What a comparison found: every cell (and the host cursor) that differs, and how many cells it compared. */
export interface Comparison { readonly differences: Difference[]; readonly compared: number }

/**
 * Every cell where the screen's picture differs from herdr's carried through the decisions, and the host cursor:
 * shown or hidden always, and where when herdr's cursor stands on a compared cell.
 */
export function compare(herdr: Cells, ovis: Cells, palette: PaletteName, decisions: Decisions): Comparison {
  const theme = TUI_THEMES[palette];
  const { cells: expected, holes: shifted } = withWords(herdr, decisions.words);
  const herdrHeld = held([...decisions.holes, ...shifted], herdr.cols, herdr.rows);
  const exact = held((decisions.exact ?? []).map((rect) => ({ ...rect, line: "C1" })), herdr.cols, herdr.rows);
  const ovisHeld = held(decisions.ovisHoles ?? [], ovis.cols, ovis.rows);
  const placeOf = (x: number, y: number): readonly [number, number] | null => {
    const hold = herdrHeld.get(y * herdr.cols + x);
    if (hold === "all") return null;
    return x >= ovis.cols || y >= ovis.rows || ovisHeld.get(y * ovis.cols + x) === "all" ? null : [x, y] as const;
  };
  const out: Difference[] = [];
  let compared = 0;
  for (let i = 0; i < expected.length; i++) {
    const x = i % herdr.cols;
    const y = Math.floor(i / herdr.cols);
    const at = placeOf(x, y);
    if (!at) continue;
    compared++;
    const j = at[1] * ovis.cols + at[0];
    const hold = herdrHeld.get(i) ?? ovisHeld.get(j);
    const want = expected[i]!;
    const got = ovis.cells[j]!;
    const differ = (what: string) => out.push({ x, y, what, herdr: describe(want), ovis: `(${at[0]},${at[1]}) ${describe(got)}` });
    if (hold !== "glyph" && want.ch !== got.ch) { differ("text"); continue; }
    const blank = (want.ch === " " || want.ch === "") && (want.look.flags & (LOOK_UNDERLINE | LOOK_REVERSE | LOOK_STRIKE)) === 0;
    // on a blank cell only underline, reverse and strikethrough show: bold, dim and italic change nothing there
    const seen = (flags: number) => (blank ? flags & (LOOK_UNDERLINE | LOOK_REVERSE | LOOK_STRIKE) : flags) & (hold === "bold" ? ~LOOK_BOLD : ~0);
    if (seen(want.look.flags) !== seen(got.look.flags)) { differ("attributes"); continue; }
    const shown = (want.ch !== " " && want.ch !== "") || (want.look.flags & (LOOK_UNDERLINE | LOOK_REVERSE)) !== 0;
    if (exact.has(i)) {
      if (!sameColor(got.look.bg, want.look.bg)) { differ("background"); continue; }
      if (shown && hold !== "glyph" && !sameColor(got.look.fg, want.look.fg)) differ("foreground");
      continue;
    }
    const wantBg = hexOf(want.look.bg);
    if (want.look.bg === null) {
      if (got.look.bg !== null && !sameColor(got.look.bg, theme.bg)) { differ("background"); continue; }
    } else if (!(wantBg && HERDR_BG[wantBg] && sameColor(got.look.bg, theme[HERDR_BG[wantBg]!]))) { differ("background"); continue; }
    if (!shown || hold === "glyph") continue;
    const wantFg = hexOf(want.look.fg);
    if (want.look.fg === null) {
      if (got.look.fg !== null) differ("foreground");
    } else if (!(wantFg && HERDR_FG[wantFg] && sameColor(got.look.fg, theme[HERDR_FG[wantFg]!]))) differ("foreground");
  }
  const cursor = herdr.cursor;
  const where = cursor.visible ? placeOf(cursor.x, cursor.y) : null;
  if (cursor.visible !== ovis.cursor.visible || (where && (ovis.cursor.x !== where[0] || ovis.cursor.y !== where[1]))) {
    out.push({ x: cursor.x, y: cursor.y, what: "cursor", herdr: JSON.stringify(cursor), ovis: JSON.stringify(ovis.cursor) });
  }
  return { differences: out, compared };
}

const SIDEBAR = 26;
/** The backgrounds herdr's sidebar writes: none, the row in front and the row a navigate points at. */
const SIDEBAR_BACKGROUNDS = new Set([null, "#1e1e2e", "#313244"]);

/** The sidebar's cells of herdr's picture that no overlay covers: one rectangle a cell, `width` columns from the left. */
function sidebarCells(herdr: Cells, width: number, dialogRect: Omit<Hole, "line"> | null): Omit<Hole, "line">[] {
  const out: Omit<Hole, "line">[] = [];
  const inDialog = (x: number, y: number) => dialogRect !== null && x >= dialogRect.x && x < dialogRect.x + dialogRect.width && y >= dialogRect.y && y < dialogRect.y + dialogRect.height;
  for (let y = 0; y < herdr.rows; y++) {
    for (let x = 0; x < width; x++) {
      if (!inDialog(x, y) && SIDEBAR_BACKGROUNDS.has(hexOf(herdr.cells[y * herdr.cols + x]!.look.bg))) out.push({ x, y, width: 1, height: 1 });
    }
  }
  return out;
}
/** the collapsed sidebar's rail, with its divider */
const RAIL = 4;
const NARROW = 64;


/** A dialog's cells: the size it asks for, centred, with two columns at each side and one row above and below kept free. */
function dialog(cols: number, rows: number, width: number, height: number): Omit<Hole, "line"> {
  const fitted = { width: Math.min(width, cols - 4), height: Math.min(height, rows - 2) };
  return { x: Math.floor((cols - fitted.width) / 2), y: Math.floor((rows - fitted.height) / 2), ...fitted };
}

const BAR_SCENES = new Set(["prefix", "navigate", "copy", "resize", "empty-prefix"]);
/** herdr's dialog size per scene (the picker: the screen less its margins); the screen draws the same */
const DIALOGS: Readonly<Record<string, readonly [number, number]>> = {
  help: [76, 22], rename: [56, 7], newtab: [56, 7], confirm: [64, 6], picker: [999, 999], "agents-picker": [999, 999],
  "rc-rename-pane": [56, 7], "rc-rename-workspace": [56, 7], "rc-close-workspace": [64, 6], "rc-close-group": [64, 6], "rc-open-worktree": [96, 12],
  "rc-new-worktree": [68, 12], "rc-delete-worktree": [72, 10],
};

/**
 * The scenes no case compares, by the line that covers them: every cell of them, or every cell another case compares
 * already. `narrow`: only at 64 columns or fewer.
 */
export const LEFT_OUT: readonly { readonly scene: string; readonly line: string; readonly why: string; readonly narrow?: true }[] = [
  { scene: "settings", line: "O10", why: "herdr's settings screen; the screen has none yet" },
  { scene: "viewers", line: "P6", why: "forced; this harness draws no second viewer, so the screen's side is the main scene" },
  { scene: "collapsed", line: "L6", why: "no sidebar at 64 columns or fewer on either side: the main scene again", narrow: true },
  { scene: "agents-collapsed", line: "L6", why: "no sidebar at 64 columns or fewer on either side: the agents scene again", narrow: true },
];

/** Whether a case compares a scene at a width. */
export function comparedScene(scene: string, cols: number): boolean {
  return !LEFT_OUT.some((one) => one.scene === scene && (!one.narrow || cols <= NARROW));
}

/**
 * What a scene's comparison leaves out or carries over, each by its line in docs/tui/visual-parity.md: C2's words (the
 * screen keeps its own: `Workspaces`, `Agents`, `Menu`, `Rename tab`, `New tab name`, `Copied`, and on the mode bar
 * `navigate` and `help`), S8's state glyphs, S7's agent rows, the picker's (`pickerHoles`) and herdr's opt-in toast card
 * (N2). C1's colours are carried by `compare` itself, which also takes
 * the theme's background where herdr writes none (C1 wins over S9 and P2 there). `base`: the world's first picture
 * on each side.
 */
export function decisionsFor(world: WorldName, scene: string, cols: number, rows: number, herdr: Cells, ovis: Cells, base: { herdr: Cells; ovis: Cells } | null): Decisions {
  const words: Word[] = [{ herdr: "copied to clipboard", ovis: STRINGS.noticeText("copied", {}) }];
  const holes: Hole[] = [];
  const ovisHoles: Hole[] = [];
  const narrow = cols <= NARROW;
  const collapsed = scene === "collapsed" || scene === "agents-collapsed";
  const agents = world === "agents";
  // the help's scrolled and filtered scenes are the help's dialog too
  const box = DIALOGS[scene.startsWith("help") ? "help" : scene];
  const rect = box ? dialog(cols, rows, box[0], box[1]) : null;
  if (narrow) {
    // herdr's narrow header (L6): the shown workspace's state mark is the screen's (S8), so are its words for no agents
    // and for each state with its mark in the agents' summary (C2, S8)
    holes.push({ line: "S8", x: 1, y: 0, width: 1, height: 1, glyph: true });
    words.push({ herdr: " no agents", ovis: ` ${STRINGS.noAgents}`, row: 1, col: 0 });
    if (agents) holes.push({ line: "C2", x: 0, y: 1, width: cols - 10, height: 1 });
    // herdr's switcher (L8): each workspace's state mark is the screen's, and the help's name in its menu (C2)
    if (scene === "navigate" || scene === "menu" || scene === "agents-menu") {
      holes.push({ line: "S8", x: 3, y: 3, width: 1, height: rows - 3, glyph: true });
      words.push({ herdr: "keybinds", ovis: STRINGS.menuEntries.help.padEnd("keybinds".length) }, { herdr: " agents ", ovis: ` ${STRINGS.agentsSection} `, row: 3, col: 1 });
      const text = gridText(herdr);
      // S7: the agents' entries keep the screen's order and words; each is two rows under the agents' heading
      const agentRows = text.slice(4).findIndex((line) => !/^.  (\S \S|\S.* · )/.test(line) || line.slice(1).startsWith(" spaces"));
      if (text[3]?.slice(1).startsWith(" agents") && agentRows > 0) holes.push({ line: "S7", x: 1, y: 4, width: cols - 1, height: agentRows });
      // what runs in a workspace's shown pane: herdr names its program (a shell, for the agents' stand-in programs), the
      // screen the agent the pane reports; with no agent both say shell, and those rows are compared
      text.forEach((line, y) => {
        const found = /^.  (\S+) · tab /.exec(line);
        // the rest of the row moves with the name's length, so the row is left out from it on
        if (y > 2 && found && agents) holes.push({ line: "C2", x: 3, y, width: cols - 3, height: 1 });
      });
    }
  }
  // the sidebar (the rail when collapsed) is compared whole, with its divider: herdr's words, dots, agents, branch row,
  // and herdr's own colour values; an overlay lying over it (a dialog, the menu, the picker) keeps the screen's look and
  // is compared by role: its cells are those with a background herdr's sidebar never writes, and a dialog's rectangle
  const exact = narrow ? [] : sidebarCells(herdr, collapsed ? RAIL : SIDEBAR, rect);
  if (BAR_SCENES.has(scene)) {
    words.push({ herdr: "workspace nav", ovis: STRINGS.modeHints.workspaceNav, shift: true, row: rows - 1 }, { herdr: "keybinds", ovis: STRINGS.modeHints.keybinds, shift: true, row: rows - 1 });
  }
  if (rect) {
    // herdr's dialogs keep the bold of the cell they were drawn over (a panel sets colours on the old cell's style, as its
    // toolkit merges styles): that is how herdr's toolkit paints, not a look of herdr's, so a dialog cell's bold does not
    // count where the picture under the dialog was bold there
    if (base) {
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) if (base.herdr.cells[y * cols + x]!.look.flags & LOOK_BOLD) holes.push({ line: "O2", x, y, width: 1, height: 1, bold: true });
      // the same toolkit keeps a whole cell's look where the dialog wrote only its character: such a cell inside the dialog
      // has exactly the look of the cell it was drawn over (no panel background), so its look is not herdr's dialog's
      for (let y = rect.y + 1; y < rect.y + rect.height - 1; y++) {
        for (let x = rect.x + 1; x < rect.x + rect.width - 1; x++) {
          const at = y * cols + x;
          if (herdr.cells[at]!.ch !== base.herdr.cells[at]!.ch && JSON.stringify(herdr.cells[at]!.look) === JSON.stringify(base.herdr.cells[at]!.look)) holes.push({ line: "O2", x, y, width: 1, height: 1 });
        }
      }
    }
    if (scene.startsWith("help")) {
      // C2: the help's title, and its own row's words, are the screen's (herdr says `keybinds` for both)
      words.push({ herdr: "keybinds", ovis: STRINGS.helpTitle, row: rect.y + 1 }, { herdr: "keybinds", ovis: STRINGS.helpWords.help.padEnd("keybinds".length) });
    }
    if (scene === "rename") words.push({ herdr: "rename tab", ovis: STRINGS.textRenameTab, row: rect.y + 1 });
    if (scene === "newtab") words.push({ herdr: "new tab", ovis: STRINGS.textNewTab, row: rect.y + 1 });
  }
  if (scene === "toast") {
    // C2: the copy toast says the screen's `Copied`, so its box is narrower than herdr's: each box's cells are left out
    // in its own picture, and the toast's place, shape and colour roles are checked on their own (copyToastShape)
    const span = (grid: Cells): Hole | null => {
      const row = gridText(grid).findIndex((text) => text.includes("●"));
      if (row < 0) return null;
      const text = gridText(grid)[row]!;
      const at = text.indexOf("●") - 1;
      return { line: "C2", x: at, width: text.indexOf("│", at + 1) - at + 1, y: row - 1, height: 3 };
    };
    const herdrSpan = span(herdr);
    const ovisSpan = span(ovis);
    if (herdrSpan) holes.push(herdrSpan);
    if (ovisSpan) ovisHoles.push(ovisSpan);
  }
  if (scene === "picker" || scene === "agents-picker") holes.push(...pickerHoles(herdr, ovisHoles, cols, rows));
  // R4: herdr's name dialogs say `rename pane` and `rename workspace`; the screen keeps its words (C2)
  if (scene === "rc-rename-pane") words.push({ herdr: "rename pane", ovis: STRINGS.textRenamePane });
  if (scene === "rc-rename-workspace") words.push({ herdr: "rename workspace", ovis: STRINGS.textRenameWorkspace });
  // R7: each checkout's folder in Open worktree..., New worktree and Delete worktree checkout... is the scratch folder of
  // the run that made it, and New worktree's branch is drawn at random (herdr's words, the web's helper)
  if (scene === "rc-open-worktree" || scene === "rc-new-worktree" || scene === "rc-delete-worktree") {
    for (const grid of [herdr, ovis]) {
      gridText(grid).forEach((text, y) => {
        const at = Math.max(text.indexOf("│ /"), text.indexOf("│ worktree/"));
        if (at >= 0) (grid === herdr ? holes : ovisHoles).push({ line: "R7", x: at + 1, y, width: text.lastIndexOf("│") - at - 1, height: 1 });
      });
    }
  }
  // R7: herdr's question names its own product; the screen says "The workspace will close." (C2)
  if (scene === "rc-delete-worktree") words.push({ herdr: "The Herdr workspace will close.", ovis: STRINGS.removeWorktreeKept.slice(STRINGS.removeWorktreeKept.indexOf("The workspace")) });
  if (scene === "menu" || scene === "agents-menu") words.push({ herdr: "keybinds", ovis: STRINGS.menuEntries.help.padEnd("keybinds".length) });
  if (scene === "toast-agent") {
    // N2: the agent scenes were captured with herdr's toasts switched on (`ui.toast.delivery = "herdr"`); the screen
    // follows herdr's default, off, and shows none, so herdr's card is left out and every other cell is compared
    const text = gridText(herdr);
    const row = text.findIndex((line) => line.includes("● claude"));
    if (row >= 0) {
      const line = text[row]!;
      const boxed = (text[row - 1] ?? "").includes("┌");
      const left = boxed ? line.lastIndexOf("│", line.indexOf("● claude")) : 0;
      holes.push(boxed ? { line: "N2", x: left, y: row - 1, width: line.indexOf("│", left + 1) - left + 1, height: 4 } : { line: "N2", x: 0, y: row, width: cols, height: 1 });
    }
  }
  return { words, holes, ovisHoles, exact };
}

/**
 * The picker's cells left out: S8's state marks (the screen keeps its own), the state column (C2: each side its own word
 * for a state), the foot's path and folder (herdr's pane ids and its scratch folder are not the screen's), and its keys
 * row from where herdr lists its state filters (a/b/w/i/d), which the screen has not.
 */
function pickerHoles(herdr: Cells, ovisHoles: Hole[], cols: number, rows: number): Hole[] {
  const box = dialog(cols, rows, cols, rows);
  const holes: Hole[] = [];
  const text = gridText(herdr);
  for (let y = box.y + 1; y < box.y + box.height - 1; y++) {
    for (let x = box.x + 3; x < box.x + box.width - 1; x++) if ("●○·".includes(text[y]![x]!) && /─ |◆ /.test(text[y]!.slice(x - 2, x))) holes.push({ line: "S8", x, y, width: 1, height: 1, glyph: true });
  }
  if (box.width - 2 >= 70) {
    const state = { line: "C2", x: box.x + box.width - 1 - 11, y: box.y + 3, width: 11, height: Math.max(0, box.height - 7) };
    holes.push(state);
    ovisHoles.push(state);
  }
  const foot = box.y + box.height - 4;
  holes.push({ line: "O7", x: box.x + 1, y: foot, width: box.width - 2, height: 2 });
  ovisHoles.push({ line: "O7", x: box.x + 1, y: foot, width: box.width - 2, height: 2 });
  const keys = (text[foot + 2] ?? "").indexOf(" · a/b/w/i/d");
  if (keys >= 0) {
    const cut = { line: "O7", x: keys, y: foot + 2, width: box.x + box.width - 1 - keys, height: 1 };
    holes.push(cut);
    ovisHoles.push(cut);
  }
  return holes;
}

/**
 * N1 on the toast scene, where C2 makes the box narrower: the screen's copy toast is a box of three rows at the bottom
 * centre of the panes, framed in the done colour on the panel background, its mark in the done colour and its text
 * bold. Answers what is wrong, or null.
 */
export function copyToastShape(ovis: Cells, palette: PaletteName, panes: { x: number; width: number }): string | null {
  const theme = TUI_THEMES[palette];
  const rows = gridText(ovis);
  const y = rows.findIndex((text) => text.includes(`● ${STRINGS.noticeText("copied", {})}`));
  if (y !== ovis.rows - 2) return `the toast's text is on row ${y}, not on row ${ovis.rows - 2}`;
  const x = rows[y]!.indexOf("●") - 1;
  const width = `● ${STRINGS.noticeText("copied", {})}`.length + 2;
  if (x !== panes.x + Math.floor((panes.width - width) / 2)) return `the toast starts at column ${x}, not in the middle of the panes`;
  const at = (dx: number, dy: number) => ovis.cells[(y + dy) * ovis.cols + x + dx]!;
  const frame = [at(0, -1), at(width - 1, -1), at(0, 1), at(width - 1, 1), at(0, 0), at(width - 1, 0)];
  if (frame.map((cell) => cell.ch).join("") !== "┌┐└┘││") return "the toast is not framed in box lines";
  if (!frame.every((cell) => sameColor(cell.look.fg, theme.statusDone) && sameColor(cell.look.bg, theme.bgPanel))) return "the toast's frame is not the done colour on the panel";
  if (!sameColor(at(1, 0).look.fg, theme.statusDone)) return "the toast's mark is not the done colour";
  if ((at(3, 0).look.flags & 1) === 0) return "the toast's text is not bold";
  return null;
}

/** A short report of the first differences, with both pictures' text, for a failing case. */
export function report(herdr: Cells, ovis: Cells, differences: readonly Difference[], limit = 12): string {
  const lines = differences.slice(0, limit).map((d) => `(${d.x},${d.y}) ${d.what}: herdr ${d.herdr} | ovis ${d.ovis}`);
  return [`${differences.length} cells differ`, ...lines, "--- herdr", ...gridText(herdr), "--- ovis", ...gridText(ovis)].join("\n");
}
