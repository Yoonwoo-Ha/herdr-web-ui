/**
 * Settings > Terminal > Draw with libghostty: libghostty-vt draws an xterm terminal's screen, Kitty
 * graphics pictures included, while xterm stays the engine under it.
 *
 * xterm still takes every key, IME syllable, paste, click, selection, link, search and scroll, and
 * still answers the program's queries: everything Ovis built on it keeps working. Its text layer
 * is hidden (PaneTerminal.css `[data-renderer="ghostty"]`), and a layer of plain DOM text, one div per
 * row, is drawn over its screen at its cell size from the same bytes, in the same order. libghostty
 * answers nothing: a reply it made to a replayed stream would reach the program as typing.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";
import { GhosttyVt, STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE_MASK, type GhosttyColors, type GhosttyImage, type GhosttyRun } from "./vt.ts";

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

export interface GhosttyOverlay { dispose(): void }

/**
 * The lines a frame added: when the screen scrolled up by some rows, the rows that moved are not new, only
 * the ones that came in at the bottom and any row that changed in place.
 */
export function newLines(before: readonly string[], after: readonly string[]): string[] {
  const rows = after.length;
  let best = 0;
  let bestMatches = -1;
  for (let shift = 0; shift < rows; shift++) {
    let matches = 0;
    for (let y = 0; y + shift < rows; y++) if (after[y] && before[y + shift] === after[y]) matches++;
    if (matches > bestMatches) { best = shift; bestMatches = matches; }
  }
  return after.filter((line, y) => line && (y >= rows - best || before[y + best] !== line));
}

/** lines of one frame read out, so a flood does not drown the reader */
const ANNOUNCED_LINES = 20;

interface XtermRowRenderer { renderRows(start: number, end: number): void }

/** xterm's DOM renderer, which writes its rows; xterm.js has no public way to stop it drawing */
function xtermRowRenderer(term: Terminal): XtermRowRenderer | null {
  const core = (term as unknown as { _core?: { _renderService?: { _renderer?: { value?: XtermRowRenderer } } } })._core;
  const renderer = core?._renderService?._renderer?.value;
  return renderer && typeof renderer.renderRows === "function" ? renderer : null;
}

/** xterm.js 6's own ANSI colours, which it draws with wherever the theme names none (the dark palettes name none) */
const XTERM_ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

function themeColors(term: Terminal): GhosttyColors {
  const theme = term.options.theme ?? {};
  const ansi = [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite]
    .map((color, index) => color || XTERM_ANSI[index]!);
  return { foreground: theme.foreground ?? "#d4d4d4", background: theme.background ?? "#1e1e1e", cursor: theme.cursor ?? theme.foreground ?? "#d4d4d4", ansi };
}

/**
 * Draws `term` with libghostty from now on, until disposed; resolves once the module is loaded, or
 * null when `takeBacklog` (the bytes xterm was given so far, called once the module is ready) has none
 * to give.
 */
export async function attachGhosttyOverlay(term: Terminal, host: HTMLElement, takeBacklog: () => (string | Uint8Array)[] | null): Promise<GhosttyOverlay | null> {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) throw new Error("ghostty overlay: the terminal is not open");
  const vt = await GhosttyVt.create(term.cols, term.rows);
  const backlog = takeBacklog();
  if (!backlog) {
    vt.dispose();
    return null;
  }
  let disposed = false;
  const layer = document.createElement("div");
  layer.className = "ghostty-layer";
  const below = document.createElement("div");
  below.className = "ghostty-images";
  const text = document.createElement("div");
  text.className = "ghostty-text";
  const above = document.createElement("div");
  above.className = "ghostty-images is-above";
  const cursor = document.createElement("div");
  cursor.className = "ghostty-cursor";
  // xterm's rows are hidden, and with them what a screen reader read: these rows are read instead, and
  // lines the program writes are announced (as xterm's screen reader mode does), never the pictures
  for (const decoration of [below, above, cursor]) decoration.setAttribute("aria-hidden", "true");
  const announcer = document.createElement("div");
  announcer.className = "visually-hidden";
  announcer.setAttribute("aria-live", "polite");
  layer.append(below, text, above, cursor, announcer);
  screen.append(layer);

  let rowEls: HTMLDivElement[] = [];
  let rowText: string[] = [];
  // the screen a pane opens on, or is rebuilt to, is what is there already: read, not announced
  let primed = false;
  // what each row shows: libghostty hands over only the rows that changed, so fresh row elements are refilled from it
  let rowHtml: string[] = [];
  let cellW = 0;
  let cellH = 0;
  let frameQueued = false;
  const decoded = new Map<string, HTMLCanvasElement>();

  const metrics = (): void => {
    const box = screen.getBoundingClientRect();
    cellW = box.width / term.cols;
    cellH = box.height / term.rows;
    const font = term.options.fontFamily ?? "monospace";
    const size = term.options.fontSize ?? 13;
    Object.assign(layer.style, { fontFamily: font, fontSize: `${size}px`, width: `${box.width}px`, height: `${box.height}px` });
    layer.style.setProperty("--ghostty-cw", `${cellW}px`);
    layer.style.setProperty("--ghostty-ch", `${cellH}px`);
    // each cell is xterm's width: a font whose advance differs is spaced to it
    const probe = document.createElement("span");
    probe.textContent = "W".repeat(50);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    text.append(probe);
    const advance = probe.getBoundingClientRect().width / 50;
    probe.remove();
    layer.style.letterSpacing = `${cellW - advance}px`;
  };

  /** what a screen reader hears: the frame's new lines, the newest kept when a program floods. Only the latest
   *  message stays in the region: NVDA read a growing log whole, every earlier message again */
  const announce = (lines: string[]): void => {
    if (lines.length === 0) return;
    announcer.textContent = lines.slice(-ANNOUNCED_LINES).join("\n");
  };

  const rebuildRows = (): void => {
    text.textContent = "";
    rowText = [];
    primed = false;
    rowEls = [];
    for (let y = 0; y < term.rows; y++) {
      const row = document.createElement("div");
      row.className = "ghostty-row";
      row.innerHTML = rowHtml[y] ?? "";
      text.append(row);
      rowEls.push(row);
    }
  };

  let grid = "";
  const fit = (): void => {
    metrics();
    // a new grid redraws every row; a cell-size change alone redraws none, so the rebuilt rows refill from rowHtml
    const now = `${term.cols}x${term.rows}@${cellW}x${cellH}`;
    if (now === grid) return;
    grid = now;
    vt.resize(term.cols, term.rows, cellW, cellH);
    rebuildRows();
    schedule();
  };

  const colors = (): void => {
    const palette = themeColors(term);
    vt.setColors(palette);
    layer.style.color = palette.foreground;
    cursor.style.background = palette.cursor;
  };

  const runHtml = (run: GhosttyRun): string => {
    let fg = run.fg, bg = run.bg;
    if (run.flags & STYLE_INVERSE) [fg, bg] = [bg ?? themeColors(term).background, fg ?? themeColors(term).foreground];
    const css: string[] = [];
    if (fg) css.push(`color:${fg}`);
    if (bg) css.push(`background:${bg}`);
    if (run.flags & STYLE_BOLD) css.push("font-weight:bold");
    if (run.flags & STYLE_ITALIC) css.push("font-style:italic");
    if (run.flags & STYLE_FAINT) css.push("opacity:.6");
    if (run.flags & STYLE_INVISIBLE) css.push("color:transparent");
    const lines = [run.flags & STYLE_UNDERLINE_MASK ? "underline" : "", run.flags & STYLE_STRIKE ? "line-through" : ""].filter(Boolean);
    if (lines.length) css.push(`text-decoration:${lines.join(" ")}`);
    let body = "";
    let plain = "";
    for (const cell of run.cells) {
      if (cell.wide) {
        if (plain) { body += escapeHtml(plain); plain = ""; }
        body += `<span class="ghostty-wide">${escapeHtml(cell.text)}</span>`;
      } else plain += cell.text;
    }
    if (plain) body += escapeHtml(plain);
    return `<span style="left:calc(var(--ghostty-cw)*${run.x})${css.length ? `;${css.join(";")}` : ""}">${body}</span>`;
  };

  const picture = (image: GhosttyImage): HTMLCanvasElement | null => {
    const key = `${image.id}:${image.generation}`;
    let source = decoded.get(key);
    if (!source) {
      const pixels = vt.imagePixels(image.id);
      if (!pixels) return null;
      for (const old of decoded.keys()) if (old.startsWith(`${image.id}:`)) decoded.delete(old);
      source = document.createElement("canvas");
      source.width = pixels.width;
      source.height = pixels.height;
      source.getContext("2d")?.putImageData(pixels, 0, 0);
      decoded.set(key, source);
    }
    return source;
  };

  const drawImages = (images: GhosttyImage[]): void => {
    below.textContent = "";
    above.textContent = "";
    const live = new Set(images.map((image) => `${image.id}:${image.generation}`));
    for (const key of decoded.keys()) if (!live.has(key)) decoded.delete(key);
    for (const image of [...images].sort((a, b) => a.z - b.z)) {
      const source = picture(image);
      if (!source || image.width === 0 || image.height === 0) continue;
      const scale = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.className = "ghostty-image";
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      // the grid is xterm's, in CSS pixels; libghostty placed the picture in the cell size it was given
      Object.assign(canvas.style, {
        left: `${image.col * cellW + image.offsetX}px`, top: `${image.row * cellH + image.offsetY}px`,
        width: `${image.width}px`, height: `${image.height}px`,
      });
      const { x, y, width, height } = image.source;
      canvas.getContext("2d")?.drawImage(source, x, y, width || source.width, height || source.height, 0, 0, canvas.width, canvas.height);
      (image.layer === 2 ? above : below).append(canvas);
    }
  };

  // font, theme and history follow xterm's options, which the font and theme effects set in place
  let options: unknown[] = [];
  const optionsChanged = (): boolean => {
    const now = [term.options.fontFamily, term.options.fontSize, term.options.theme, term.options.scrollback];
    if (now.every((value, index) => value === options[index])) return false;
    options = now;
    return true;
  };

  const draw = (): void => {
    if (disposed) return;
    try {
      drawFrame();
    } catch (error) {
      // the module failed (a trap, out of memory): xterm draws from here on
      console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
      overlay.dispose();
    }
  };

  const drawFrame = (): void => {
    if (optionsChanged()) {
      colors();
      vt.setScrollback(term.options.scrollback ?? 0);
      fit();
    }
    // xterm's own history (a herdr-core server's `terminal-history`): the layer shows the rows xterm shows
    const buffer = term.buffer.active;
    vt.scrollFromBottom(buffer.baseY - buffer.viewportY);
    const before = [...rowText];
    const changed = vt.frame((y, runs) => {
      const row = rowEls[y];
      if (!row) return;
      let html = "";
      for (const run of runs) html += runHtml(run);
      // a row libghostty marks dirty can come out the same (a cursor that moved past it): no DOM write
      if (rowHtml[y] === html) return;
      row.innerHTML = html;
      rowHtml[y] = html;
      rowText[y] = runs.map((run) => run.cells.map((cell) => cell.text).join("")).join("").trimEnd();
    });
    if (primed) announce(newLines(before, rowText));
    primed = true;
    if (changed) {
      const c = vt.cursor();
      Object.assign(cursor.style, c.visible
        ? { display: "block", left: `${c.x * cellW}px`, top: `${c.y * cellH + (c.style === 2 ? cellH - 2 : 0)}px`, width: `${c.style === 0 ? 2 : cellW}px`, height: `${c.style === 2 ? 2 : cellH}px` }
        : { display: "none" });
    }
    const images = vt.placedImages();
    if (images) drawImages(images);
    // xterm may make a new renderer (a font or theme change): that one draws nothing either. A folded mirror
    // (lib/terminalFold.ts) hides this layer and reads xterm's rows and cursor, so xterm draws while folded
    if (host.hasAttribute("data-folded")) {
      if (muted) { unmuteXtermRows(); term.refresh(0, term.rows - 1); }
    } else muteXtermRows();
  };

  const schedule = (): void => {
    if (frameQueued || disposed) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      draw();
    });
  };

  // every byte xterm is given, libghostty is given first, in the same order
  const write = term.write.bind(term);
  term.write = ((data: string | Uint8Array, callback?: () => void) => {
    if (!disposed) {
      try {
        vt.write(data);
      } catch (error) {
        // the module failed (a trap, out of memory): xterm draws from here on, and its write still runs
        console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
        overlay.dispose();
      }
    }
    write(data, callback);
  }) as Terminal["write"];
  const reset = term.reset.bind(term);
  term.reset = () => {
    if (!disposed) {
      vt.reset();
      decoded.clear();
    }
    reset();
  };

  optionsChanged();
  colors();
  vt.setScrollback(term.options.scrollback ?? 0);
  fit();
  // at xterm's grid and cell size, so a picture in the backlog is placed as xterm's cells are
  try {
    for (const chunk of backlog) vt.write(chunk);
  } catch (error) {
    // the caller falls back to xterm: it gets its own write and reset back, so nothing reaches the freed module
    disposed = true;
    term.write = write;
    term.reset = reset;
    layer.remove();
    vt.dispose();
    throw error;
  }
  const subscriptions: IDisposable[] = [
    term.onResize(() => fit()),
    term.onRender(() => schedule()),
    term.onScroll(() => schedule()),
  ];
  const screenResize = new ResizeObserver(() => fit());
  screenResize.observe(screen);

  // xterm still parses every byte (its buffer serves input, selection, search and the input row), but its
  // own rows are hidden under this layer: redrawing them was a third of the cost of a busy pane
  let muted: { renderer: XtermRowRenderer; renderRows: XtermRowRenderer["renderRows"] } | null = null;
  const muteXtermRows = (): void => {
    const renderer = xtermRowRenderer(term);
    if (!renderer || muted?.renderer === renderer) return;
    unmuteXtermRows();
    muted = { renderer, renderRows: renderer.renderRows };
    renderer.renderRows = () => {};
  };
  const unmuteXtermRows = (): void => {
    if (!muted) return;
    muted.renderer.renderRows = muted.renderRows;
    muted = null;
  };
  muteXtermRows();

  host.dataset["renderer"] = "ghostty";
  const overlay: GhosttyOverlay = {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      delete host.dataset["renderer"];
      unmuteXtermRows();
      term.refresh(0, term.rows - 1);
      term.write = write;
      term.reset = reset;
      for (const subscription of subscriptions) subscription.dispose();
      screenResize.disconnect();
      layer.remove();
      decoded.clear();
      vt.dispose();
    },
  };
  return overlay;
}
