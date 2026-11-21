/**
 * The host-free core of the wrapper over libghostty-vt compiled to WebAssembly (ghostty-vt.wasm beside
 * this file, MIT; built by scripts/ghostty-vt/build.sh with the Kitty graphics protocol turned on). A
 * loader instantiates the module and hands it over as a GhosttyModule: the browser's is src/lib/ghostty/vt.ts.
 *
 * A GhosttyEngine owns one terminal and one render state. Each frame hands every changed row to the caller as
 * runs of text that share one style, and lists the Kitty images on screen with their pixels.
 * Raw cells are read a row at a time and decoded with the bit layout the module reports in
 * ghostty_type_json(), so a row costs one wasm call plus a few per style change. Every enum value and struct
 * field the core uses is read from there by name as well (ENGINE_ENUMS, ENGINE_FIELDS).
 */

interface Bits { lsb: number; width: number; arms?: Record<string, { bits: Record<string, Bits> } | null> }
export interface TypeLayout {
  types: Record<string, { values?: Record<string, number>; fields?: Record<string, { offset: number }>; bits?: Record<string, Bits> }>;
}

// every wasm function the core calls is declared here: the compiler and ENGINE_FUNCTIONS are the guard
export interface GhosttyExports {
  memory: WebAssembly.Memory;
  ghostty_type_json(): number;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_terminal_new(allocator: number, slot: number, cols: number, rows: number): number;
  ghostty_terminal_free(terminal: number): void;
  ghostty_terminal_reset(terminal: number): void;
  ghostty_terminal_resize(terminal: number, cols: number, rows: number, cellW: number, cellH: number): number;
  ghostty_terminal_set(terminal: number, option: number, value: number): number;
  ghostty_terminal_get(terminal: number, key: number, out: number): number;
  ghostty_terminal_vt_write(terminal: number, ptr: number, len: number): void;
  ghostty_terminal_scroll_viewport(terminal: number, behavior: number): void;
  ghostty_render_state_new(allocator: number, slot: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, terminal: number): number;
  ghostty_render_state_get(state: number, key: number, out: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_row_iterator_new(allocator: number, slot: number): number;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_get(iterator: number, key: number, out: number): number;
  ghostty_render_state_row_cells_new(allocator: number, slot: number): number;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, key: number, out: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_image_iterator_new(allocator: number, slot: number): number;
  ghostty_render_state_image_iterator_next(iterator: number): number;
  ghostty_render_state_image_get(iterator: number, key: number, out: number): number;
  ghostty_render_state_image_iterator_free(iterator: number): void;
  ghostty_kitty_graphics_image(graphics: number, id: number): number;
  ghostty_kitty_graphics_image_get(image: number, key: number, out: number): number;
}

/** every module function the core calls; the type turns one missing here into a compile error */
export const ENGINE_FUNCTIONS: Record<Exclude<keyof GhosttyExports, "memory">, true> = {
  ghostty_type_json: true, ghostty_wasm_alloc: true, ghostty_wasm_free: true, ghostty_wasm_alloc_opaque: true,
  ghostty_wasm_take_opaque: true, ghostty_terminal_new: true, ghostty_terminal_free: true, ghostty_terminal_reset: true,
  ghostty_terminal_resize: true, ghostty_terminal_set: true, ghostty_terminal_get: true, ghostty_terminal_vt_write: true,
  ghostty_terminal_scroll_viewport: true, ghostty_render_state_new: true, ghostty_render_state_free: true,
  ghostty_render_state_update: true, ghostty_render_state_get: true, ghostty_render_state_clean: true,
  ghostty_render_state_row_iterator_new: true, ghostty_render_state_row_iterator_next_dirty: true,
  ghostty_render_state_row_iterator_free: true, ghostty_render_state_row_get: true, ghostty_render_state_row_cells_new: true,
  ghostty_render_state_row_cells_select: true, ghostty_render_state_row_cells_get: true, ghostty_render_state_row_cells_free: true,
  ghostty_render_state_image_iterator_new: true, ghostty_render_state_image_iterator_next: true,
  ghostty_render_state_image_get: true, ghostty_render_state_image_iterator_free: true, ghostty_kitty_graphics_image: true,
  ghostty_kitty_graphics_image_get: true,
};

/** the enum values the core uses, by type and name in ghostty_type_json() */
export const ENGINE_ENUMS = {
  GhosttyTerminalOption: ["COLOR_FOREGROUND", "COLOR_BACKGROUND", "COLOR_CURSOR", "COLOR_PALETTE", "KITTY_IMAGE_STORAGE_LIMIT", "SCROLLBACK_MAX_LINES", "MODE"],
  GhosttyTerminalData: ["KITTY_GRAPHICS"],
  GhosttyTerminalScrollViewportTag: ["BOTTOM", "DELTA"],
  GhosttyRenderStateData: ["DIRTY", "ROW_ITERATOR", "CURSOR_VISUAL_STYLE", "CURSOR_VISIBLE", "CURSOR_VIEWPORT_HAS_VALUE",
    "CURSOR_VIEWPORT_X", "CURSOR_VIEWPORT_Y", "IMAGE_ITERATOR", "IMAGE_PLACEMENTS_GENERATION"],
  GhosttyRenderStateRowData: ["CELLS", "CELLS_RAW"],
  GhosttyRenderStateRowCellsData: ["STYLE", "BG_COLOR", "FG_COLOR", "GRAPHEMES_UTF8"],
  GhosttyRenderStateImageData: ["IMAGE_ID", "IMAGE_GENERATION", "LAYER", "Z", "VIEWPORT_COL", "VIEWPORT_ROW", "CELL_OFFSET_X",
    "CELL_OFFSET_Y", "PIXEL_WIDTH", "PIXEL_HEIGHT", "SOURCE_X", "SOURCE_Y", "SOURCE_WIDTH", "SOURCE_HEIGHT"],
  GhosttyKittyGraphicsImageData: ["WIDTH", "HEIGHT", "FORMAT", "DATA_PTR", "DATA_LEN"],
  GhosttyKittyImageFormat: ["RGB", "RGBA", "GRAY_ALPHA", "GRAY"],
  GhosttyCellWide: ["WIDE", "SPACER_TAIL", "SPACER_HEAD"],
  GhosttyCellContentTag: ["CODEPOINT_GRAPHEME", "BG_COLOR_PALETTE", "BG_COLOR_RGB"],
} as const;

/** the struct fields the core reads or writes, by type and name in ghostty_type_json() */
export const ENGINE_FIELDS = {
  GhosttyStyle: ["flags"],
  GhosttyCellsView: ["ptr", "len"],
  GhosttyBuffer: ["ptr", "cap", "len"],
  GhosttyTerminalModeConfig: ["mode", "value"],
  GhosttyTerminalScrollViewport: ["tag", "value"],
} as const;

type Resolved<T extends Record<string, readonly string[]>> = { readonly [K in keyof T]: { readonly [N in T[K][number]]: number } };

/** One run of cells in a row that share a style. */
export interface GhosttyRun {
  x: number;
  /** each cell's grapheme, and whether it fills two columns (Hangul, CJK, most emoji) */
  cells: { text: string; wide: boolean }[];
  fg: string | null;
  bg: string | null;
  flags: number;
}

export interface GhosttyCursor { visible: boolean; x: number; y: number; style: number }

/** A Kitty image on screen, in viewport cells and CSS pixels, as the render state places it. */
export interface GhosttyImage {
  id: number;
  /** changes whenever the image's pixels do: part of a decoded image's cache key */
  generation: number;
  /** 0 below the cell backgrounds, 1 below the text, 2 above it */
  layer: number;
  z: number;
  col: number;
  row: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  source: { x: number; y: number; width: number; height: number };
}

/** A stored Kitty image's pixels as RGBA, copied out of the module. */
export interface GhosttyPixels { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> }

export type Rgb = readonly [number, number, number];

/** The terminal's colours; a null one is left as it is. */
export interface EngineColors { foreground: Rgb | null; background: Rgb | null; cursor: Rgb | null; palette: readonly Rgb[] }

export interface EngineOptions {
  /** bytes of decoded Kitty pictures the terminal keeps; 0 keeps none */
  imageStorageBytes: bigint;
}

export const STYLE_BOLD = 1 << 0;
export const STYLE_ITALIC = 1 << 1;
export const STYLE_FAINT = 1 << 2;
export const STYLE_INVERSE = 1 << 4;
export const STYLE_INVISIBLE = 1 << 5;
export const STYLE_STRIKE = 1 << 6;
export const STYLE_UNDERLINE_MASK = 0x7 << 8;

/** The type layout the module reports, as ghostty_type_json() returns it. */
export function readTypeLayout(exports: Pick<GhosttyExports, "memory" | "ghostty_type_json">): TypeLayout {
  const ptr = exports.ghostty_type_json();
  const bytes = new Uint8Array(exports.memory.buffer, ptr);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)))) as TypeLayout;
}

function resolve<T extends Record<string, readonly string[]>>(table: T, read: (type: string, name: string) => number | undefined): Resolved<T> {
  return Object.fromEntries(Object.entries(table).map(([type, names]) => [type, Object.fromEntries(names.map((name) => {
    const value = read(type, name);
    if (value === undefined) throw new Error(`ghostty-vt: no ${type}.${name} in ghostty_type_json`);
    return [name, value];
  }))])) as Resolved<T>;
}

/** An instantiated libghostty-vt module, with the numbers the core uses read from it by name. */
export class GhosttyModule {
  readonly exports: GhosttyExports;
  readonly enums: Resolved<typeof ENGINE_ENUMS>;
  readonly fields: Resolved<typeof ENGINE_FIELDS>;
  readonly bit: Record<"codepoint" | "content_tag" | "wide" | "style_id", Bits>;

  constructor(instance: WebAssembly.Instance | WebAssembly.Instance["exports"]) {
    // the one place untyped exports are taken as GhosttyExports; the `engine exports` test checks them against the module
    this.exports = (instance instanceof WebAssembly.Instance ? instance.exports : instance) as unknown as GhosttyExports;
    const layout = readTypeLayout(this.exports);
    this.enums = resolve(ENGINE_ENUMS, (type, name) => layout.types[type]?.values?.[name]);
    this.fields = resolve(ENGINE_FIELDS, (type, name) => layout.types[type]?.fields?.[name]?.offset);
    const cell = layout.types["GhosttyCell"]?.bits;
    if (!cell) throw new Error("ghostty-vt: no GhosttyCell layout in ghostty_type_json");
    const pick = (name: string): Bits => {
      const found = cell[name];
      if (!found) throw new Error(`ghostty-vt: GhosttyCell has no ${name}`);
      return found;
    };
    const content = pick("content");
    const inner = content.arms?.["CODEPOINT"]?.bits["codepoint"];
    if (!inner) throw new Error("ghostty-vt: GhosttyCell content has no CODEPOINT arm");
    this.bit = { codepoint: { lsb: content.lsb + inner.lsb, width: inner.width }, content_tag: pick("content_tag"), wide: pick("wide"), style_id: pick("style_id") };
  }
}

const hex = (r: number, g: number, b: number): string => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;

export class GhosttyEngine {
  private readonly x: GhosttyExports;
  private readonly e: GhosttyModule["enums"];
  private readonly f: GhosttyModule["fields"];
  private readonly bit: GhosttyModule["bit"];
  private readonly terminal: number;
  private readonly state: number;
  private readonly iterator: number;
  private readonly cells: number;
  private readonly images: number;
  private readonly slot: number;
  private readonly scratch: number;
  private input = 0;
  private inputCap = 0;
  private placementsGeneration = -1;
  /** the cursor the last frame() saw: libghostty marks no row dirty when only the cursor moves */
  private lastCursor = "";

  constructor(module: GhosttyModule, cols: number, rows: number, options: EngineOptions) {
    const exports = module.exports;
    this.x = exports;
    this.e = module.enums;
    this.f = module.fields;
    this.bit = module.bit;

    this.slot = exports.ghostty_wasm_alloc_opaque();
    this.scratch = exports.ghostty_wasm_alloc(1024);
    const take = (result: number, what: string): number => {
      this.check(result, what);
      return exports.ghostty_wasm_take_opaque(this.slot);
    };
    this.terminal = take(exports.ghostty_terminal_new(0, this.slot, cols, rows), "terminal_new");
    this.state = take(exports.ghostty_render_state_new(0, this.slot), "render_state_new");
    this.iterator = take(exports.ghostty_render_state_row_iterator_new(0, this.slot), "row_iterator_new");
    this.cells = take(exports.ghostty_render_state_row_cells_new(0, this.slot), "row_cells_new");
    this.images = take(exports.ghostty_render_state_image_iterator_new(0, this.slot), "image_iterator_new");
    this.view().setBigUint64(this.scratch, options.imageStorageBytes, true);
    this.check(exports.ghostty_terminal_set(this.terminal, this.e.GhosttyTerminalOption.KITTY_IMAGE_STORAGE_LIMIT, this.scratch), "image storage limit");
  }

  private check(result: number, what: string): void {
    if (result !== 0) throw new Error(`ghostty-vt: ${what} failed (${result})`);
  }

  private view(): DataView {
    return new DataView(this.x.memory.buffer);
  }

  /** feeds bytes to the terminal as they are */
  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (bytes.length > this.inputCap) {
      if (this.input) this.x.ghostty_wasm_free(this.input, this.inputCap);
      this.inputCap = Math.max(bytes.length, 64 * 1024);
      this.input = this.x.ghostty_wasm_alloc(this.inputCap);
    }
    new Uint8Array(this.x.memory.buffer, this.input, bytes.length).set(bytes);
    this.x.ghostty_terminal_vt_write(this.terminal, this.input, bytes.length);
  }

  /** sets a terminal mode as ghostty_mode_new() encodes it (a DEC private mode is its own number) */
  setMode(mode: number, on: boolean): void {
    const dv = this.view();
    const config = this.scratch + 1000;
    dv.setUint16(config + this.f.GhosttyTerminalModeConfig.mode, mode, true);
    dv.setUint8(config + this.f.GhosttyTerminalModeConfig.value, on ? 1 : 0);
    this.check(this.x.ghostty_terminal_set(this.terminal, this.e.GhosttyTerminalOption.MODE, config), `mode ${mode}`);
  }

  reset(): void {
    this.x.ghostty_terminal_reset(this.terminal);
    this.placementsGeneration = -1;
  }

  resize(cols: number, rows: number, cellW: number, cellH: number): void {
    this.check(this.x.ghostty_terminal_resize(this.terminal, cols, rows, Math.max(1, Math.round(cellW)), Math.max(1, Math.round(cellH))), "resize");
  }

  /** lines of history above the screen; 0 keeps none */
  setScrollback(lines: number): void {
    this.view().setUint32(this.scratch, lines, true);
    this.check(this.x.ghostty_terminal_set(this.terminal, this.e.GhosttyTerminalOption.SCROLLBACK_MAX_LINES, this.scratch), "scrollback");
  }

  /** shows the screen `rowsAboveBottom` rows up in the history (0: the newest rows) */
  scrollFromBottom(rowsAboveBottom: number): void {
    const dv = this.view();
    const behavior = this.scratch + 512;
    const { tag, value } = this.f.GhosttyTerminalScrollViewport;
    dv.setUint32(behavior + tag, this.e.GhosttyTerminalScrollViewportTag.BOTTOM, true);
    this.x.ghostty_terminal_scroll_viewport(this.terminal, behavior);
    if (rowsAboveBottom <= 0) return;
    dv.setUint32(behavior + tag, this.e.GhosttyTerminalScrollViewportTag.DELTA, true);
    dv.setInt32(behavior + value, -rowsAboveBottom, true);
    this.x.ghostty_terminal_scroll_viewport(this.terminal, behavior);
  }

  setColors(colors: EngineColors): void {
    const dv = this.view();
    const option = this.e.GhosttyTerminalOption;
    const setColor = (key: number, value: Rgb | null): void => {
      if (!value) return;
      dv.setUint8(this.scratch, value[0]);
      dv.setUint8(this.scratch + 1, value[1]);
      dv.setUint8(this.scratch + 2, value[2]);
      this.check(this.x.ghostty_terminal_set(this.terminal, key, this.scratch), `color ${key}`);
    };
    setColor(option.COLOR_FOREGROUND, colors.foreground);
    setColor(option.COLOR_BACKGROUND, colors.background);
    setColor(option.COLOR_CURSOR, colors.cursor);
    const palette = this.scratch + 128;
    colors.palette.forEach((value, index) => {
      dv.setUint8(palette + index * 3, value[0]);
      dv.setUint8(palette + index * 3 + 1, value[1]);
      dv.setUint8(palette + index * 3 + 2, value[2]);
    });
    this.check(this.x.ghostty_terminal_set(this.terminal, option.COLOR_PALETTE, palette), "palette");
  }

  /**
   * Snapshot the terminal and call `draw` for each row that changed since the last frame.
   * Returns false when nothing changed, the cursor included (an arrow key moves only the cursor, #3266).
   */
  frame(draw: (y: number, runs: GhosttyRun[]) => void): boolean {
    const x = this.x;
    const rs = this.e.GhosttyRenderStateData, rowData = this.e.GhosttyRenderStateRowData, cellsData = this.e.GhosttyRenderStateRowCellsData;
    const wides = this.e.GhosttyCellWide, tags = this.e.GhosttyCellContentTag;
    this.check(x.ghostty_render_state_update(this.state, this.terminal), "render_state_update");
    const c = this.cursor();
    const cursor = `${c.visible} ${c.x} ${c.y} ${c.style}`;
    const cursorMoved = cursor !== this.lastCursor;
    this.lastCursor = cursor;
    this.check(x.ghostty_render_state_get(this.state, rs.DIRTY, this.scratch), "dirty");
    if (this.view().getInt32(this.scratch, true) === 0) return cursorMoved;

    const iterSlot = this.scratch + 16;
    const cellsSlot = this.scratch + 24;
    const outY = this.scratch + 32;
    const viewOut = this.scratch + 40;
    const colorOut = this.scratch + 64;
    const styleOut = this.scratch + 96;
    const flagsOffset = this.f.GhosttyStyle.flags;
    let dv = this.view();
    dv.setUint32(iterSlot, this.iterator, true);
    this.check(x.ghostty_render_state_get(this.state, rs.ROW_ITERATOR, iterSlot), "row iterator");
    dv.setUint32(cellsSlot, this.cells, true);
    const { codepoint: cpB, content_tag: tagB, wide: wideB, style_id: styleB } = this.bit;
    const field = (lo: number, hi: number, b: Bits): number => {
      // a 64-bit cell read as two 32-bit halves; a field may straddle them (style_id does)
      const mask = b.width >= 32 ? 0xffffffff : (1 << b.width) - 1;
      if (b.lsb >= 32) return (hi >>> (b.lsb - 32)) & mask;
      if (b.lsb + b.width <= 32) return (lo >>> b.lsb) & mask;
      return ((lo >>> b.lsb) | (hi << (32 - b.lsb))) & mask;
    };

    while (x.ghostty_render_state_row_iterator_next_dirty(this.iterator, outY)) {
      dv = this.view();
      const y = dv.getUint16(outY, true);
      this.check(x.ghostty_render_state_row_get(this.iterator, rowData.CELLS_RAW, viewOut), "cells raw");
      this.check(x.ghostty_render_state_row_get(this.iterator, rowData.CELLS, cellsSlot), "cells");
      dv = this.view();
      const ptr = dv.getUint32(viewOut + this.f.GhosttyCellsView.ptr, true);
      const len = dv.getUint32(viewOut + this.f.GhosttyCellsView.len, true);
      const runs: GhosttyRun[] = [];
      let run: GhosttyRun | null = null;
      let runKey = -1;
      for (let col = 0; col < len; col++) {
        const lo = dv.getUint32(ptr + col * 8, true);
        const hi = dv.getUint32(ptr + col * 8 + 4, true);
        const wide = field(lo, hi, wideB);
        if (wide === wides.SPACER_TAIL || wide === wides.SPACER_HEAD) continue;
        const tag = field(lo, hi, tagB);
        const styleId = field(lo, hi, styleB);
        const bgOnly = tag === tags.BG_COLOR_PALETTE || tag === tags.BG_COLOR_RGB;
        // the style id changes whenever the style does; bg-only cells carry their colour in the cell itself
        const key = bgOnly ? -2 - lo : styleId;
        if (!run || key !== runKey) {
          run = { x: col, cells: [], fg: null, bg: null, flags: 0 };
          runKey = key;
          runs.push(run);
          if (styleId !== 0 || bgOnly) {
            x.ghostty_render_state_row_cells_select(this.cells, col);
            if (x.ghostty_render_state_row_cells_get(this.cells, cellsData.FG_COLOR, colorOut) === 0) {
              dv = this.view();
              run.fg = hex(dv.getUint8(colorOut), dv.getUint8(colorOut + 1), dv.getUint8(colorOut + 2));
            }
            if (x.ghostty_render_state_row_cells_get(this.cells, cellsData.BG_COLOR, colorOut) === 0) {
              dv = this.view();
              run.bg = hex(dv.getUint8(colorOut), dv.getUint8(colorOut + 1), dv.getUint8(colorOut + 2));
            }
            if (!bgOnly && x.ghostty_render_state_row_cells_get(this.cells, cellsData.STYLE, styleOut) === 0) {
              dv = this.view();
              run.flags = dv.getUint16(styleOut + flagsOffset, true);
            }
            dv = this.view();
          }
        }
        let text: string;
        if (tag === tags.CODEPOINT_GRAPHEME) {
          text = this.grapheme(col);
          dv = this.view();
        } else {
          const cp = bgOnly ? 0 : field(lo, hi, cpB);
          text = cp === 0 ? " " : String.fromCodePoint(cp);
        }
        run.cells.push({ text, wide: wide === wides.WIDE });
      }
      draw(y, runs);
    }
    this.check(x.ghostty_render_state_clean(this.state), "clean");
    return true;
  }

  private grapheme(col: number): string {
    const x = this.x;
    const graphemes = this.e.GhosttyRenderStateRowCellsData.GRAPHEMES_UTF8;
    x.ghostty_render_state_row_cells_select(this.cells, col);
    const buf = this.scratch + 256;
    const cap = 120;
    const out = this.scratch + 240;
    const { ptr: ptrAt, cap: capAt, len: lenAt } = this.f.GhosttyBuffer;
    let dv = this.view();
    dv.setUint32(out + ptrAt, buf, true);
    dv.setUint32(out + capAt, cap, true);
    dv.setUint32(out + lenAt, 0, true);
    if (x.ghostty_render_state_row_cells_get(this.cells, graphemes, out) !== 0) {
      // a long ZWJ sequence: the call names the room it needs
      const need = this.view().getUint32(out + lenAt, true);
      if (need <= cap) return " ";
      const big = x.ghostty_wasm_alloc(need);
      try {
        dv = this.view();
        dv.setUint32(out + ptrAt, big, true);
        dv.setUint32(out + capAt, need, true);
        dv.setUint32(out + lenAt, 0, true);
        if (x.ghostty_render_state_row_cells_get(this.cells, graphemes, out) !== 0) return " ";
        const n = this.view().getUint32(out + lenAt, true);
        return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, big, n).slice()) || " ";
      } finally {
        x.ghostty_wasm_free(big, need);
      }
    }
    dv = this.view();
    const n = dv.getUint32(out + lenAt, true);
    return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, buf, n)) || " ";
  }

  private getU8(key: number): number {
    this.check(this.x.ghostty_render_state_get(this.state, key, this.scratch), `render_state_get ${key}`);
    return this.view().getUint8(this.scratch);
  }

  private getU16(key: number): number {
    this.check(this.x.ghostty_render_state_get(this.state, key, this.scratch), `render_state_get ${key}`);
    return this.view().getUint16(this.scratch, true);
  }

  cursor(): GhosttyCursor {
    const rs = this.e.GhosttyRenderStateData;
    const visible = this.getU8(rs.CURSOR_VISIBLE) !== 0 && this.getU8(rs.CURSOR_VIEWPORT_HAS_VALUE) !== 0;
    if (!visible) return { visible: false, x: 0, y: 0, style: 1 };
    return { visible, x: this.getU16(rs.CURSOR_VIEWPORT_X), y: this.getU16(rs.CURSOR_VIEWPORT_Y), style: this.getU8(rs.CURSOR_VISUAL_STYLE) };
  }

  /** the Kitty images on screen after the last frame(), or null when the list has not changed since the last call */
  placedImages(): GhosttyImage[] | null {
    const x = this.x;
    const rs = this.e.GhosttyRenderStateData, image = this.e.GhosttyRenderStateImageData;
    const dv0 = this.view();
    dv0.setBigUint64(this.scratch, 0n, true);
    this.check(x.ghostty_render_state_get(this.state, rs.IMAGE_PLACEMENTS_GENERATION, this.scratch), "placements generation");
    const generation = Number(this.view().getBigUint64(this.scratch, true));
    if (generation === this.placementsGeneration) return null;
    this.placementsGeneration = generation;
    this.view().setUint32(this.scratch, this.images, true);
    this.check(x.ghostty_render_state_get(this.state, rs.IMAGE_ITERATOR, this.scratch), "image iterator");
    const out = this.scratch + 64;
    const read = (key: number, signed = false): number => {
      const dv = this.view();
      dv.setBigUint64(out, 0n, true);
      if (x.ghostty_render_state_image_get(this.images, key, out) !== 0) return 0;
      const fresh = this.view();
      return signed ? fresh.getInt32(out, true) : fresh.getUint32(out, true);
    };
    const list: GhosttyImage[] = [];
    while (x.ghostty_render_state_image_iterator_next(this.images)) {
      const dv = this.view();
      dv.setBigUint64(out, 0n, true);
      x.ghostty_render_state_image_get(this.images, image.IMAGE_GENERATION, out);
      const imageGeneration = Number(this.view().getBigUint64(out, true));
      list.push({
        id: read(image.IMAGE_ID), generation: imageGeneration, layer: read(image.LAYER), z: read(image.Z, true),
        col: read(image.VIEWPORT_COL, true), row: read(image.VIEWPORT_ROW, true), offsetX: read(image.CELL_OFFSET_X), offsetY: read(image.CELL_OFFSET_Y),
        width: read(image.PIXEL_WIDTH), height: read(image.PIXEL_HEIGHT),
        source: { x: read(image.SOURCE_X), y: read(image.SOURCE_Y), width: read(image.SOURCE_WIDTH), height: read(image.SOURCE_HEIGHT) },
      });
    }
    return list;
  }

  /** a stored Kitty image's pixels as RGBA, copied out of the module; null once the program deleted it */
  imagePixels(id: number): GhosttyPixels | null {
    const x = this.x;
    const data = this.e.GhosttyKittyGraphicsImageData, format = this.e.GhosttyKittyImageFormat;
    this.view().setUint32(this.scratch, 0, true);
    if (x.ghostty_terminal_get(this.terminal, this.e.GhosttyTerminalData.KITTY_GRAPHICS, this.scratch) !== 0) return null;
    const graphics = this.view().getUint32(this.scratch, true);
    const image = x.ghostty_kitty_graphics_image(graphics, id);
    if (!image) return null;
    const u32 = (key: number): number => {
      this.check(x.ghostty_kitty_graphics_image_get(image, key, this.scratch + 64), `image ${key}`);
      return this.view().getUint32(this.scratch + 64, true);
    };
    const width = u32(data.WIDTH), height = u32(data.HEIGHT), kind = u32(data.FORMAT);
    const ptr = u32(data.DATA_PTR), len = u32(data.DATA_LEN);
    if (width === 0 || height === 0) return null;
    const source = new Uint8Array(this.x.memory.buffer, ptr, len);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const pixels = width * height;
    if (kind === format.RGBA) rgba.set(source.subarray(0, rgba.length));
    else {
      const channels = kind === format.RGB ? 3 : kind === format.GRAY_ALPHA ? 2 : kind === format.GRAY ? 1 : 0;
      if (channels === 0) return null;
      for (let p = 0; p < pixels; p++) {
        const s = p * channels, d = p * 4;
        if (channels >= 3) { rgba[d] = source[s]!; rgba[d + 1] = source[s + 1]!; rgba[d + 2] = source[s + 2]!; rgba[d + 3] = 255; }
        else { rgba[d] = rgba[d + 1] = rgba[d + 2] = source[s]!; rgba[d + 3] = channels === 2 ? source[s + 1]! : 255; }
      }
    }
    return { width, height, rgba };
  }

  dispose(): void {
    const x = this.x;
    x.ghostty_render_state_image_iterator_free(this.images);
    x.ghostty_render_state_row_cells_free(this.cells);
    x.ghostty_render_state_row_iterator_free(this.iterator);
    x.ghostty_render_state_free(this.state);
    x.ghostty_terminal_free(this.terminal);
    x.ghostty_wasm_free(this.scratch, 1024);
    if (this.input) x.ghostty_wasm_free(this.input, this.inputCap);
  }
}
