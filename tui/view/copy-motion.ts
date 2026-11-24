import type { ScreenPoint, ScreenRange } from "../emulator/index.ts";
import type { CopyMotion } from "../model/copy.ts";
import { hostLayout } from "./host-layout.ts";

interface CopyPosition {
  readonly point: ScreenPoint;
  readonly cols: number;
  readonly total: number;
  readonly height: number;
  readonly wordAt: (point: ScreenPoint) => ScreenRange | null;
  readonly rowText: (y: number) => string;
}

export const clamp = (value: number, size: number): number => Math.max(0, Math.min(value, size - 1));

export function movedCopyPoint(motion: CopyMotion, p: CopyPosition): ScreenPoint {
  const { x, y } = p.point;
  const half = Math.max(1, Math.floor(p.height / 2));
  switch (motion) {
    case "copy_left": return { x: horizontal(p, -1), y };
    case "copy_right": return { x: horizontal(p, 1), y };
    case "copy_down": return { x, y: clamp(y + 1, p.total) };
    case "copy_up": return { x, y: clamp(y - 1, p.total) };
    case "copy_half_up": return { x, y: clamp(y - half, p.total) };
    case "copy_half_down": return { x, y: clamp(y + half, p.total) };
    case "copy_start": return { x: 0, y };
    case "copy_end": return { x: clamp(hostLayout.layout(p.rowText(y)).end - 1, p.cols), y };
    case "copy_oldest": return { x: 0, y: 0 };
    case "copy_newest": return { x: 0, y: p.total - 1 };
    case "copy_word": return word(p, 1);
    case "copy_back": return word(p, -1);
  }
}

function horizontal(p: CopyPosition, direction: -1 | 1): number {
  const { x, y } = p.point;
  const next = clamp(x + direction, p.cols);
  const tail = hostLayout.layout(p.rowText(y)).cells.some((cell) => cell.width === 2 && cell.col + 1 === next);
  return tail ? (direction === -1 ? next - 1 : next + 1 < p.cols ? next + 1 : x) : next;
}

function word(p: CopyPosition, direction: 1 | -1): ScreenPoint {
  const offset = (point: ScreenPoint) => point.y * p.cols + point.x;
  const limit = p.total * p.cols;
  const under = p.wordAt(p.point);
  const start = direction === 1 && under ? offset(under.end) : offset(p.point);
  // Read one row at a time so jumping across long runs of blank cells does not ask wasm about each cell.
  for (let at = start + direction; at >= 0 && at < limit;) {
    const y = Math.floor(at / p.cols);
    const x = at % p.cols;
    const cells = hostLayout.layout(p.rowText(y)).cells;
    const candidates = direction === 1 ? cells : cells.slice().reverse();
    for (const cell of candidates) {
      if (!cell.text.trim() || (direction === 1 ? cell.col < x : cell.col > x)) continue;
      const found = p.wordAt({ x: cell.col, y });
      if (found && offset(found.start) !== offset(p.point)) return found.start;
    }
    at = direction === 1 ? (y + 1) * p.cols : y * p.cols - 1;
  }
  return p.point;
}
