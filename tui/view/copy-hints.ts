import { fileUriPath } from "../../shared/fileUri.ts";
import { addressSpans, isWebLink, terminalPathMatches } from "../../shared/terminal-links.ts";
import type { Emulator, ScreenRange } from "../emulator/index.ts";
import type { Grid } from "./grid.ts";
import type { PaneScene } from "./paint.ts";

type Token = { readonly index: number; readonly text: string };
const HASH = /(?:^|[^-\p{L}\p{N}_])([0-9a-f]{7,64})(?![-\p{L}\p{N}_])/giu;
// Explicit paths also name extensionless files and directories, which the browser's opener does not detect.
const EXPLICIT = /(?:^|[\s("'`])((?:~\/|\.\.?\/|\/)[\p{L}\p{N}\p{M}_@+-]+(?:\/[\p{L}\p{N}\p{M}_@+.-]+)*\/?)(?![\p{L}\p{N}\p{M}_@+./:-])/gu;
const ADDRESS_TRAILER = /[),.;:!?'"`>]+$/;

function tokens(text: string): Token[] {
  const spans = addressSpans(text);
  const addresses = spans.flatMap(([start, end]) => {
    const token = text.slice(start, end);
    const scheme = /[a-z][a-z0-9+.-]*:\/\//i.exec(token);
    if (!scheme) return [];
    const candidate = token.slice(scheme.index);
    const trailer = ADDRESS_TRAILER.exec(candidate);
    let uriEnd = trailer?.index ?? candidate.length;
    if (trailer?.[0].includes(")")) {
      let open = 0;
      for (let i = 0; i < candidate.length; i++) {
        if (candidate[i] === "(") open++;
        if (candidate[i] === ")" && open > 0) {
          open--;
          if (i >= uriEnd) uriEnd = i + 1;
        }
      }
    }
    const uri = candidate.slice(0, uriEnd);
    return (isWebLink(uri) && uri.length > scheme[0].length) || fileUriPath(uri) !== null
      ? [{ index: start + scheme.index, text: uri }] : [];
  });
  const paths = [...terminalPathMatches(text, false)].map(({ index, link }) => ({ index, text: link }));
  const other = [EXPLICIT, HASH].flatMap((pattern) => Array.from(text.matchAll(pattern), (match) => {
    const value = match[1] ?? "";
    return { index: match.index + match[0].length - value.length, text: value };
  })).filter(({ index }) => !spans.some(([start, end]) => index >= start && index < end)
    && !paths.some((path) => index >= path.index && index < path.index + path.text.length));
  return [...addresses, ...paths, ...other].sort((a, b) => a.index - b.index || b.text.length - a.text.length);
}

export interface CopyHint {
  readonly col: number;
  readonly row: number;
  readonly width: 1 | 2;
  readonly digit: number;
  readonly text: string;
}

/** Map the engine's unwrapped text back onto the painted cells. */
function lineCells(grid: Grid, line: ScreenRange, top: number, text: string): number[] {
  const cells: number[] = [];
  for (let y = line.start.y; y <= line.end.y; y++) {
    const left = y === line.start.y ? line.start.x : 0;
    const right = y === line.end.y ? line.end.x + 1 : grid.cols;
    for (let x = left; x < right; x++) {
      const i = (y - top) * grid.cols + x;
      if (grid.width[i] === 0) continue;
      const cell = grid.text[i] ?? " ";
      if (!text.startsWith(cell, cells.length)) {
        // The formatter omits the empty last cell before a wide glyph that wraps early.
        if (cell === " " && x === grid.cols - 1 && y < line.end.y) continue;
        return [];
      }
      for (let at = 0; at < cell.length; at++) cells.push(i);
    }
  }
  return cells.length === text.length ? cells : [];
}

/** Number only whole tokens in the drawn clip, using Ghostty's logical line bounds and text. */
export function visibleCopyHints(scene: PaneScene, emulator: Emulator, top: number): CopyHint[] {
  const { grid } = scene.grid;
  const { col, row } = scene.view ?? { col: 0, row: 0 };
  const bottom = Math.min(grid.rows, row + scene.rect.height);
  const right = col + scene.rect.width;
  const hints: CopyHint[] = [];
  for (let y = top + row; y < top + bottom;) {
    const bounds = emulator.lineAt({ x: 0, y });
    const line = bounds.ok ? bounds.value : null;
    y = Math.max(y, line?.end.y ?? y) + 1;
    // A vertically cut logical line cannot be mapped completely to the drawn cells.
    if (!line || line.start.y < top + row || line.end.y >= top + bottom) continue;
    const oldest = line.start.y === 0;
    if (oldest) {
      // The first kept row can be a continuation even though lineAt has no earlier row to return.
      const continues = emulator.rowContinues(0);
      if (!continues.ok || continues.value !== false) continue;
    }
    const formatted = emulator.textOf(line);
    if (!formatted.ok) continue;
    const text = formatted.value;
    const cells = lineCells(grid, line, top, text);
    const found = tokens(text);
    // hc serializes wraps as hard breaks. The oldest row has no preceding row
    // to disprove a cut. Ghostty excludes leading blanks from lineAt, so a
    // line starting past column zero already has a separator.
    let possibleCut = oldest && line.start.x === 0;
    if (!oldest && line.start.x === 0 && found.length > 0) {
      const edge = { x: grid.cols - 1, y: line.start.y - 1 };
      // A wide first glyph can also have wrapped one cell before the right margin.
      const early = grid.cols > 1 && grid.width[cells[0] ?? -1] === 2;
      const previous = emulator.textOf({ start: { ...edge, x: edge.x - Number(early) }, end: edge });
      possibleCut = previous.ok && previous.value.trim() !== "";
    }
    const space = possibleCut ? text.search(/\s/) : 0;
    const head = space < 0 ? text.length : space;
    let end = -1;
    for (const token of found) {
      const next = token.index + token.text.length;
      const first = cells[token.index], last = cells[next - 1];
      if (first === undefined || last === undefined || token.index < end) continue;
      if (token.index < head) {
        // At the oldest left margin, require a scheme or a spelled-out path
        // root. A bare slash could still be a separator within a cut token.
        if (!oldest || token.index !== 0 || !(isWebLink(token.text) || fileUriPath(token.text) !== null || /^(?:~|\.\.?)\//.test(token.text))) continue;
      }
      // At a logical line's right edge there is no visible delimiter after the token.
      if (Math.floor(last / grid.cols) === line.end.y - top) {
        const after = (last % grid.cols) + (grid.width[last] ?? 0);
        const early = after === grid.cols - 1 && grid.text[Math.floor(last / grid.cols) * grid.cols + after] === " "
          && grid.width[(line.end.y + 1 - top) * grid.cols] === 2;
        if (after === grid.cols || early) continue;
      }
      if (cells.slice(token.index, next).some((i) => i % grid.cols < col || i % grid.cols + (grid.width[i] ?? 0) > right)) continue;
      end = next;
      hints.push({
        col: scene.rect.x + first % grid.cols - col,
        row: scene.rect.y + Math.floor(first / grid.cols) - row,
        digit: hints.length + 1,
        text: token.text,
        width: grid.width[first] === 2 ? 2 : 1,
      });
      if (hints.length === 9) return hints;
    }
  }
  return hints;
}
