/**
 * pi's session file is an append-only entry tree, not a linear log: entries link to
 * their predecessor by id/parentId, and /tree moves the leaf back to an earlier entry
 * without rewriting the file, so a later append grows a branch beside the abandoned
 * one. The conversation pi shows — and the chat must show — is the path from the last
 * entry written back to its root; entries on a side branch stay in the file, unread.
 * Parents always precede their children (verified against every session in a real
 * store), so the last line is the leaf and one forward pass indexes the tree.
 */
import { closeSync, readSync, statSync } from "node:fs";
import { ConversationReadPending, openBound } from "./conversation-shared.ts";

export const MAX_PI_INDEX_ENTRIES = 100_000;
export const MAX_PI_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_PI_INDEX_METADATA_BYTES = 32 * 1024 * 1024;
export const PI_INDEX_CACHE_BYTES = MAX_PI_INDEX_METADATA_BYTES;
const PI_INDEX_CACHE_FILES = 4;

export interface TranscriptSegment { start: number; end: number }

interface PiEntry { id: string; parent: string | null; start: number; end: number; type: string; role: string; summary: string | null }
interface PiIndex {
  file: string;
  retainedBytes: number;
  entries: PiEntry[];
  children: Map<string, PiEntry[]>;
  scanned: number;
  tail: string;
}

const piIndexes = new Map<string, PiIndex>();

function indexEntry(line: string, start: number, end: number): PiEntry | null {
  if (!line.includes('"id"')) return null;
  let entry: { id?: unknown; parentId?: unknown; type?: unknown; summary?: unknown; message?: { role?: unknown } };
  try { entry = JSON.parse(line); } catch { return null; }
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  const message = entry.message;
  if (entry.id.length > 256 || (typeof entry.parentId === "string" && entry.parentId.length > 256)) throw new Error("Pi entry identity exceeds limit");
  const role = message !== null && typeof message === "object" && typeof message.role === "string" ? message.role : "";
  if ((typeof entry.type === "string" && entry.type.length > 64) || role.length > 64) throw new Error("Pi entry metadata exceeds limit");
  return {
    id: entry.id,
    parent: typeof entry.parentId === "string" && entry.parentId.length > 0 ? entry.parentId : null,
    start,
    end,
    type: typeof entry.type === "string" ? entry.type : "",
    role,
    summary: entry.type === "branch_summary" && typeof entry.summary === "string" ? entry.summary : null,
  };
}

function buildIndex(path: string, size: number, file: string): PiIndex {
  const index: PiIndex = { file, retainedBytes: 0, entries: [], children: new Map(), scanned: 0, tail: "" };
  extendIndex(index, path, size);
  return index;
}

const INDEX_CHUNK_BYTES = 4 * 1024 * 1024;

function extendIndex(index: PiIndex, path: string, size: number): void {
  if (index.scanned >= size) return;
  const fd = openBound(path);
  try {
    let end = index.scanned;
    let carry = Buffer.alloc(0);
    let open: Buffer[] = [];
    while (end < size) {
      const want = Math.min(INDEX_CHUNK_BYTES, size - end);
      const chunk = Buffer.alloc(want);
      const got = readSync(fd, chunk, 0, want, end);
      if (got <= 0) break;
      const read = chunk.subarray(0, got);
      if (!read.includes(0x0a)) {
        open.push(read);
        if (carry.length + open.reduce((sum, part) => sum + part.length, 0) > MAX_PI_ENTRY_BYTES) throw new Error("Pi record exceeds read limit");
        end += got;
        continue;
      }
      const held = open.reduce((sum, part) => sum + part.length, 0);
      const bytes = Buffer.concat([carry, ...open, read]);
      open = [];
      const base = end - held - carry.length;
      let offset = 0;
      for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
        if (newline - offset > MAX_PI_ENTRY_BYTES) throw new Error("Pi record exceeds read limit");
        const entry = indexEntry(bytes.subarray(offset, newline).toString("utf8"), base + offset, base + newline + 1);
        if (entry) addEntry(index, entry);
        offset = newline + 1;
      }
      carry = bytes.subarray(offset);
      if (carry.length > MAX_PI_ENTRY_BYTES) throw new Error("Pi record exceeds read limit");
      end += got;
    }
    index.scanned = end - carry.length - open.reduce((sum, part) => sum + part.length, 0);
  } finally { closeSync(fd); }
  index.tail = readBefore(path, index.scanned, 64);
}

function readBefore(path: string, offset: number, bytes: number): string {
  const from = Math.max(0, offset - bytes);
  if (from >= offset) return "";
  const fd = openBound(path);
  try {
    const buffer = Buffer.alloc(offset - from);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, from)).toString("latin1");
  } finally { closeSync(fd); }
}

function addEntry(index: PiIndex, entry: PiEntry): void {
  if (index.entries.length >= MAX_PI_INDEX_ENTRIES) throw new Error("Pi index entry limit reached");
  index.retainedBytes += 192 + 2 * (entry.id.length + (entry.parent?.length ?? 0) + entry.type.length + entry.role.length + (entry.summary?.length ?? 0));
  if (index.retainedBytes > MAX_PI_INDEX_METADATA_BYTES) throw new Error("Pi index metadata budget reached");
  index.entries.push(entry);
  if (entry.parent === null) return;
  const siblings = index.children.get(entry.parent);
  if (siblings) siblings.push(entry);
  else index.children.set(entry.parent, [entry]);
}

export function piEntryIndex(path: string): PiIndex | null {
  let size: number;
  let file: string;
  try { const stat = statSync(path); size = stat.size; file = `${stat.dev}:${stat.ino}`; } catch { return null; }
  const cached = piIndexes.get(path);
  piIndexes.delete(path);
  try {
    const reusable = cached && cached.file === file && cached.scanned <= size && readBefore(path, cached.scanned, 64) === cached.tail;
    const fresh = reusable ? cached : buildIndex(path, size, file);
    if (reusable) extendIndex(fresh, path, size);
    piIndexes.set(path, fresh);
    let total = 0;
    for (const item of piIndexes.values()) total += item.retainedBytes;
    for (const [other, item] of piIndexes) {
      if (piIndexes.size <= PI_INDEX_CACHE_FILES && total <= PI_INDEX_CACHE_BYTES) break;
      if (other === path) break;
      piIndexes.delete(other);
      total -= item.retainedBytes;
    }
    return fresh;
  } catch (error) {
    if (error instanceof ConversationReadPending) throw error;
    return null;
  }
}

export function forgetPiIndex(path: string): void {
  piIndexes.delete(path);
}

export function forgetAllPiIndexes(): void {
  piIndexes.clear();
}

export function piBranchSegments(path: string, size: number): TranscriptSegment[] | null {
  const index = piEntryIndex(path);
  if (index === null || index.entries.length === 0) return null;
  if (index.entries[index.entries.length - 1]!.end > size) return null;
  const byId = new Map<string, PiEntry>();
  for (const entry of index.entries) byId.set(entry.id, entry);
  const leaf = index.entries[index.entries.length - 1]!;
  const chain: PiEntry[] = [];
  const seen = new Set<string>();
  let next: PiEntry | undefined = leaf;
  while (next !== undefined && !seen.has(next.id)) {
    seen.add(next.id);
    chain.push(next);
    const parent: PiEntry | undefined = next.parent === null ? undefined : byId.get(next.parent);
    next = parent;
  }
  const segments: TranscriptSegment[] = [];
  for (const entry of chain.reverse()) {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.end === entry.start) last.end = entry.end;
    else segments.push({ start: entry.start, end: entry.end });
  }
  return segments;
}

export function* piBranchRecordRanges(path: string, size: number): Generator<{ line: string; start: number; end: number }> {
  let branch: TranscriptSegment[] | null, index: PiIndex | null;
  try { branch = piBranchSegments(path, size); index = piEntryIndex(path); } catch { return; }
  if (!branch || !index || (index.entries.at(-1)?.end ?? 0) > size) return;
  let fd: number;
  try { fd = openBound(path); } catch { return; }
  try {
    for (const segment of branch) {
      let low = 0, high = index.entries.length;
      while (low < high) { const mid = (low + high) >>> 1; if (index.entries[mid]!.start < segment.start) low = mid + 1; else high = mid; }
      for (let at = low; at < index.entries.length; at++) {
        const entry = index.entries[at]!;
        if (entry.end > segment.end) break;
        const length = entry.end - entry.start;
        if (length > MAX_PI_ENTRY_BYTES + 1) return;
        const bytes = Buffer.alloc(length);
        if (readSync(fd, bytes, 0, length, entry.start) !== length) return;
        yield { line: bytes.toString("utf8"), start: entry.start, end: entry.end };
      }
    }
  } finally { closeSync(fd); }
}

export function* piBranchRecords(path: string, size: number): Generator<string> {
  for (const item of piBranchRecordRanges(path, size)) yield item.line;
}

export function piIndexCacheUsage(): { files: number; estimatedBytes: number } {
  return { files: piIndexes.size, estimatedBytes: [...piIndexes.values()].reduce((sum, item) => sum + item.retainedBytes, 0) };
}

export function piAbandonedTurns(path: string, size: number): { count: number; branches: number; summary: string | null } | null {
  const index = piEntryIndex(path);
  if (index === null || index.entries.length === 0) return null;
  if (index.entries[index.entries.length - 1]!.end > size) return null;
  const byId = new Map<string, PiEntry>();
  for (const entry of index.entries) byId.set(entry.id, entry);
  const live = new Set<string>();
  let next: PiEntry | undefined = index.entries[index.entries.length - 1]!;
  while (next !== undefined && !live.has(next.id)) {
    live.add(next.id);
    next = next.parent === null ? undefined : byId.get(next.parent);
  }
  let summary: string | null = null;
  const heads: PiEntry[] = [];
  const isHead = (entry: PiEntry) => {
    if (entry.parent !== null || entry.type === "session" || live.has(entry.id)) return false;
    return (index.children.get(entry.id) ?? []).some((child) => !live.has(child.id));
  };
  for (const id of live) {
    const left = new Map<string, PiEntry>();
    for (const child of index.children.get(id) ?? []) if (!live.has(child.id) && !left.has(child.id)) left.set(child.id, child);
    heads.push(...left.values());
  }
  for (const entry of index.entries) if (isHead(entry) && !heads.some((head) => head.id === entry.id)) heads.push(entry);
  const branches = heads.length;
  let count = 0;
  if (branches > 0) {
    const owned = new Set<string>();
    const counted = new Set<string>();
    for (const entry of index.entries) {
      if (heads.some((head) => head.id === entry.id) || (entry.parent !== null && owned.has(entry.parent))) owned.add(entry.id);
      else continue;
      if (entry.type !== "message" || counted.has(entry.id)) continue;
      if (entry.role !== "user" && entry.role !== "assistant") continue;
      counted.add(entry.id);
      count += 1;
    }
  }
  for (const entry of index.entries) {
    // pi's summary of an abandoned path sits on the branch that replaced it, so only one on the
    // live path describes what the chat is hiding here; the newest wins, as a later /tree
    // supersedes an earlier answer. The turns themselves are counted above, inside the branches
    if (entry.type !== "branch_summary" || !live.has(entry.id)) continue;
    if (entry.summary !== null && entry.summary.trim().length > 0) summary = entry.summary;
  }
  return { count, branches, summary };
}
