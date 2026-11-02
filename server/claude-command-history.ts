import { basename } from "node:path";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { commandTerminals } from "./claude-subagents.ts";
import { finishAsync, type Steps } from "./codex-images.ts";

/** Terminal metadata only: historical reads never replay prompt/turn evidence. */
export interface CommandEnd { id: string; at: number; status: "completed" | "failed" | "cancelled"; /** the Bash call the notice names (`<tool-use-id>`), when it names one */ call: string | null }
export interface HistoryVersion { id: string; size: number; mtimeMs: number }
/**
 * How the commands told of in a transcript's first `through` bytes ended. `complete`: nothing more
 * is to come below the limit asked for: every byte up to it was read, and found unchanged by one
 * check of them all since (or the read gave up after failing again and again). An end is told only
 * when the line it came from is as it was read in the transcript as it is now: a check of every byte
 * read at this very version says so, or else that line read again (after a rewrite that also grew
 * the transcript, an end no longer written there is not told, and its command stays running). A record too large
 * to read or not JSON is passed over: it proves nothing, and a command it may have ended stays as
 * the window alone tells it.
 */
export interface HistoryEvidence { version: HistoryVersion; through: number; complete: boolean; ends: HistoryEnd[] }
/** An end, and the line it was read from: where it starts and ends (past its newline) in the transcript, and a digest of it. */
export type HistoryEnd = CommandEnd & { from: number; to: number; digest: bigint };

interface Entry {
  path: string;
  /** the session the transcript is (its name): a row naming another session ends none of its commands */
  session: string;
  /** the transcript as last seen */
  version: HistoryVersion;
  limit: number;
  /** read up to here, in a record too large to read (`skipping`), or waiting for the record there to be written whole (`cutAt`: the size it was cut at) */
  offset: number;
  skipping: boolean;
  cutAt: number | null;
  /** a digest of each run of bytes read, in order: each ends at `end` and starts where the one before ended */
  spans: { end: number; digest: bigint }[];
  /** every span was found unchanged at this version, up to `checkedThrough` */
  checked: HistoryVersion | null;
  checkedThrough: number;
  /** a check of every span under way: the next span to check, at the version it began at */
  check: { next: number; version: HistoryVersion } | null;
  /** when the last check began, how many began, and the most a waiter wants begun (one begun after it came) */
  checkedAt: number;
  checks: number;
  wanted: number;
  waiters: number;
  ends: HistoryEnd[];
  queued: boolean;
  listeners: Set<() => void>;
  failures: number;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX_SESSIONS = 16;
const MAX_ENDS = 5000;
/** A read takes at most this much of a file at once, so a record longer than it is passed over. */
const CHUNK = 1024 * 1024;
/** The event loop gets its turn after about this much work (finishAsync). */
const SLICE_MS = 4;
/** A transcript that changed after a check is checked again this long after, at the soonest, unless a request waits for it. */
const CHECK_INTERVAL_MS = 5000;
/** A read that fails is tried again after a second, then twice as long each time up to this, and given up after MAX_FAILURES in a row. */
const RETRY_MAX_MS = 30_000;
const MAX_FAILURES = 5;
/** Only a line holding one of these can end a command (commandTerminals): every other line is passed over unread. */
const NEWLINE = Buffer.from("\n");
const MARKERS = ["<task-notification>", '"task_id"', '"shell_id"'].map((marker) => Buffer.from(marker));

const entries = new Map<string, Entry>();
const queue: Entry[] = [];
let draining = false;
/** Moved on by every reset: a request waiting from before it gives up. */
let generation = 0;
let holders = 0;
let buffer: Buffer | null = null;

export function historyVersion(path: string): HistoryVersion | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch { return null; }
}
export function sameHistory(older: HistoryVersion, newer: HistoryVersion): boolean {
  return older.id === newer.id && newer.size >= older.size && (newer.size !== older.size || newer.mtimeMs === older.mtimeMs);
}
const sameVersion = (a: HistoryVersion, b: HistoryVersion): boolean => a.id === b.id && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * What the history read of `path` knows so far, read on (when `schedule`) on the main thread a slice
 * at a time. `needed`: the ids whose ends are wanted (all when left out); only theirs are told.
 */
export function commandHistory(path: string, limit: number, schedule = true, needed?: ReadonlySet<string>): HistoryEvidence | null {
  const version = historyVersion(path);
  if (version === null) return null;
  let entry = entries.get(path);
  if (entry && !sameHistory(entry.version, version)) { discard(entry); entry = undefined; }
  if (entry) entries.delete(path);
  else {
    if (entries.size >= MAX_SESSIONS) {
      // the least recently used one nobody watches or waits for; none such: this one is not read
      const old = [...entries.values()].find((value) => value.listeners.size === 0);
      if (!old) return null;
      discard(old);
    }
    entry = {
      path, session: basename(path, ".jsonl"), version, limit, offset: 0, skipping: false, cutAt: null, spans: [], checked: null, checkedThrough: 0, check: null,
      checkedAt: -Infinity, checks: 0, wanted: 0, waiters: 0, ends: [], queued: false, listeners: new Set(), failures: 0, retryAt: 0, timer: null,
    };
  }
  entries.set(path, entry);
  entry.version = version;
  entry.limit = Math.max(entry.limit, limit);
  if (schedule) enqueue(entry);
  return evidence(entry, limit, needed);
}

function evidence(entry: Entry, limit: number, needed?: ReadonlySet<string>): HistoryEvidence {
  const wanted = needed === undefined ? entry.ends : entry.ends.filter((end) => needed.has(end.id));
  const checked = entry.checked !== null && entry.checkedThrough >= entry.offset;
  // a rewrite that also grew the transcript passes sameHistory: only a check of the bytes as they are
  // now vouches for an end, of them all at this version or of the end's own line
  const ends = checked && sameVersion(entry.checked!, entry.version) ? wanted : vouchedEnds(entry.path, entry.version.id, wanted);
  const complete = entry.failures >= MAX_FAILURES || (entry.offset >= limit && checked && ends !== null);
  return { version: entry.version, through: entry.offset, complete, ends: ends ?? [] };
}

/** The most bytes of lines one call reads again (vouchedEnds): past it, what they told is unknown. */
const VOUCH_BYTES = 4 * 1024 * 1024;

/**
 * `ends` when every line they came from (newline and all) reads as it did in the transcript `id` as
 * it is now, and nothing changed it while they were read; else null: a command they end may still run.
 */
export function vouchedEnds(path: string, id: string, ends: HistoryEnd[]): HistoryEnd[] | null {
  if (ends.length === 0) return ends;
  const lines = new Map<number, HistoryEnd>();
  for (const end of ends) lines.set(end.from, end);
  let bytes = 0;
  for (const line of lines.values()) bytes += line.to - line.from;
  if (bytes > VOUCH_BYTES) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    if (`${before.dev}:${before.ino}` !== id) return null;
    buffer ??= Buffer.allocUnsafe(CHUNK);
    for (const line of lines.values()) {
      const got = readSync(fd, buffer, 0, line.to - line.from, line.from);
      if (got !== line.to - line.from || BigInt(Bun.hash.xxHash3(buffer.subarray(0, got))) !== line.digest) return null;
    }
    // written to while it read, or replaced: what it read may be gone already
    const after = fstatSync(fd);
    const now = historyVersion(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || now === null || now.id !== id || now.size !== before.size || now.mtimeMs !== before.mtimeMs) return null;
    return ends;
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** Calls `changed` when the read of `path` learns something, starts over, ends or stops; null when `path` has no read. */
export function watchCommandHistory(path: string, changed: () => void): (() => void) | null {
  const entry = entries.get(path);
  if (!entry) return null;
  entry.listeners.add(changed);
  return () => unlisten(entry, changed);
}

function unlisten(entry: Entry, listener: () => void): void {
  entry.listeners.delete(listener);
  if (entry.listeners.size > 0) return;
  // nobody wants it read on: it waits for the next call
  if (entry.queued) { queue.splice(queue.indexOf(entry), 1); entry.queued = false; }
  if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
}

/**
 * The history of `path` read through `limit` and checked, as far as it gets in `ms`. It answers as
 * soon as the read stops: it is done, it waits for a record to be written whole, or it failed. A
 * transcript replaced meanwhile is read anew within the same time.
 */
export async function waitCommandHistory(path: string, limit: number, ms = 10_000, signal?: AbortSignal): Promise<HistoryEvidence | null> {
  const deadline = Date.now() + ms;
  const epoch = generation;
  for (;;) {
    if (signal?.aborted || Date.now() >= deadline) return commandHistory(path, limit, false);
    const found = commandHistory(path, limit, false);
    const entry = entries.get(path);
    if (found === null || entry === undefined) return found;
    // a check begun before this request may have read the bytes before a rewrite: it waits for one begun after
    entry.wanted = entry.checks + 1;
    entry.waiters++;
    enqueue(entry);
    const again = !entry.queued ? false : await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
      const abort = () => finish(false);
      const changed = () => {
        if (generation !== epoch) finish(false);
        else if (entries.get(path) !== entry) finish(true);
        else if (!entry.queued) finish(false);
      };
      function finish(replaced: boolean) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        unlisten(entry!, changed);
        resolve(replaced);
      }
      signal?.addEventListener("abort", abort, { once: true });
      entry.listeners.add(changed);
    });
    entry.waiters--;
    if (generation !== epoch) return null;
    if (!again) return commandHistory(path, limit, false);
    // the replacement is read as far as it goes now, not to the length its predecessor had
    limit = Math.min(limit, historyVersion(path)?.size ?? limit);
  }
}

function discard(entry: Entry): void {
  if (entries.get(entry.path) === entry) entries.delete(entry.path);
  if (entry.queued) { queue.splice(queue.indexOf(entry), 1); entry.queued = false; }
  if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
  notify(entry);
}

/** What `entry` has to do next: read on, check what it read, nothing until a time, or nothing. */
function due(entry: Entry, now: number): "scan" | "check" | number | null {
  if (entry.failures >= MAX_FAILURES) return null;
  if (now < entry.retryAt) return entry.retryAt;
  if (entry.check !== null) return "check";
  if (entry.offset < entry.limit) return entry.cutAt !== null && entry.version.size <= entry.cutAt ? null : "scan";
  if (entry.checked !== null && entry.checkedThrough >= entry.offset && sameVersion(entry.checked, entry.version)) return null;
  // read through but never checked whole, or a request waits: now; else not more often than the interval
  if (entry.checkedThrough < entry.offset || (entry.waiters > 0 && entry.checks < entry.wanted)) return "check";
  return now >= entry.checkedAt + CHECK_INTERVAL_MS ? "check" : entry.checkedAt + CHECK_INTERVAL_MS;
}

function enqueue(entry: Entry): void {
  if (entry.queued) return;
  const work = due(entry, Date.now());
  if (typeof work === "number") later(entry, work);
  if (work !== "scan" && work !== "check") return;
  entry.queued = true;
  queue.push(entry);
  pump();
}

/** Work held back to `at` is taken up then, for as long as somebody watches. */
function later(entry: Entry, at: number): void {
  if (entry.timer !== null || entry.listeners.size === 0) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entries.get(entry.path) === entry) enqueue(entry);
  }, Math.max(0, at - Date.now()));
  entry.timer.unref?.();
}

function pump(): void {
  if (draining || queue.length === 0) return;
  draining = true;
  // the first slice waits for the event loop too: whoever asked (a status poll) never runs one
  setImmediate(() => void finishAsync(drain()).finally(() => { draining = false; pump(); }));
}

/** One slice of one session at a time, each behind every other session waiting. */
function* drain(): Steps<void> {
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    entry.queued = false;
    step(entry);
    yield;
  }
}

function step(entry: Entry): void {
  if (entries.get(entry.path) !== entry) return;
  const stop = performance.now() + SLICE_MS;
  const before = entry.ends.length;
  let restarted = false;
  let fd: number | null = null;
  try {
    fd = openSync(entry.path, "r");
    for (;;) {
      const stat = fstatSync(fd);
      const now: HistoryVersion = { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs };
      if (!sameHistory(entry.version, now)) { discard(entry); return; }
      entry.version = now;
      const work = due(entry, Date.now());
      if (work === "scan") {
        if (entry.offset === 0 && entry.spans.length === 0) { entry.checked = now; entry.checkedThrough = 0; }
        const extends_ = entry.checked !== null && sameVersion(entry.checked, now) && entry.checkedThrough === entry.offset;
        scan(entry, fd, stop);
        const after = fstatSync(fd);
        // nothing was written while it read: what it read is as checked as what came before
        if (extends_ && `${after.dev}:${after.ino}` === now.id && after.size === now.size && after.mtimeMs === now.mtimeMs) entry.checkedThrough = entry.offset;
      } else if (work === "check") {
        if (!check(entry, fd, now, stop)) { restart(entry); restarted = true; }
      } else break;
      if (performance.now() >= stop) break;
    }
    entry.failures = 0;
    entry.retryAt = 0;
  } catch {
    entry.failures++;
    entry.retryAt = Date.now() + Math.min(RETRY_MAX_MS, 1000 * 2 ** (entry.failures - 1));
  } finally { if (fd !== null) closeSync(fd); }
  if (entries.get(entry.path) !== entry) return;
  const work = due(entry, Date.now());
  if ((work === "scan" || work === "check") && entry.listeners.size > 0) { entry.queued = true; queue.push(entry); }
  else if (typeof work === "number") later(entry, work);
  // a waiter hears when the read stops; a watcher when it learns an end or starts over too
  if (restarted || entry.ends.length !== before || !entry.queued) notify(entry);
}

function notify(entry: Entry): void {
  // a listener let go of before its turn comes (a tracker stopped) hears nothing
  for (const listener of [...entry.listeners]) queueMicrotask(() => { if (entry.listeners.has(listener)) listener(); });
}

/** The bytes read were changed: everything learnt from them goes, and the read starts again. */
function restart(entry: Entry): void {
  entry.offset = 0;
  entry.skipping = false;
  entry.cutAt = null;
  entry.spans = [];
  entry.checked = null;
  entry.checkedThrough = 0;
  entry.check = null;
  entry.ends = [];
}

/** Reads on from `entry.offset`, a chunk at most, and keeps the ends of the whole lines it read. */
function scan(entry: Entry, fd: number, stop: number): void {
  buffer ??= Buffer.allocUnsafe(CHUNK);
  entry.cutAt = null;
  // a record cut at the limit is read whole: past the limit, as far as the transcript goes
  const end = Math.max(entry.limit, entry.version.size);
  const bytes = buffer.subarray(0, readSync(fd, buffer, 0, Math.min(CHUNK, end - entry.offset), entry.offset));
  let from = 0;
  if (entry.skipping) {
    const newline = bytes.indexOf(10);
    from = newline < 0 ? bytes.length : newline + 1;
    entry.skipping = newline < 0;
  }
  let to = from;
  if (!entry.skipping) {
    const last = bytes.lastIndexOf(10);
    if (last >= from) to = last + 1;
    // a record longer than a chunk is passed over: it proves nothing
    else if (from === 0 && bytes.length === CHUNK) { to = CHUNK; entry.skipping = true; }
  }
  const read = terminals(entry, bytes, from, to, stop);
  // the newest are kept: a command still unresolved more likely ended late than early
  if (entry.ends.length > MAX_ENDS) entry.ends.splice(0, entry.ends.length - MAX_ENDS);
  // read to the transcript's end (a record not written whole, or a limit past it): read on once it grows
  if (read === to && entry.offset + bytes.length >= entry.version.size) entry.cutAt = entry.version.size;
  to = read;
  if (to === 0) return;
  entry.spans.push({ end: entry.offset + to, digest: BigInt(Bun.hash.xxHash3(bytes.subarray(0, to))) });
  entry.offset += to;
}

/** The ends told by the lines from `from` to `to` (whole lines), as far as the slice lasts: where it stopped. */
function terminals(entry: Entry, bytes: Buffer, from: number, to: number, stop: number): number {
  const next = MARKERS.map((marker) => bytes.indexOf(marker, from));
  for (;;) {
    let hit = -1;
    for (const at of next) if (at >= 0 && at < to && (hit < 0 || at < hit)) hit = at;
    if (hit < 0) return to;
    const start = bytes.lastIndexOf(10, hit) + 1;
    const end = bytes.indexOf(10, hit);
    // the newlines on both sides too: they keep the record whole (a line begun at a chunk's start
    // follows the newline the last read stopped after)
    const lead = entry.offset + start > 0 ? 1 : 0;
    const line = start >= lead ? bytes.subarray(start - lead, end + 1) : Buffer.concat([NEWLINE, bytes.subarray(start, end + 1)]);
    const digest = BigInt(Bun.hash.xxHash3(line));
    for (const terminal of commandTerminals(bytes.toString("utf8", start, end), entry.session)) entry.ends.push({ ...terminal, from: entry.offset + start - lead, to: entry.offset + end + 1, digest });
    for (let index = 0; index < next.length; index++) if (next[index]! >= 0 && next[index]! <= end) next[index] = bytes.indexOf(MARKERS[index]!, end + 1);
    if (performance.now() >= stop) return end + 1;
  }
}

/** Checks the spans read against their digests, as far as the slice lasts; false when one changed. */
function check(entry: Entry, fd: number, now: HistoryVersion, stop: number): boolean {
  buffer ??= Buffer.allocUnsafe(CHUNK);
  if (entry.check === null) { entry.check = { next: 0, version: now }; entry.checks++; entry.checkedAt = Date.now(); }
  const pass = entry.check;
  while (pass.next < entry.spans.length) {
    const start = pass.next === 0 ? 0 : entry.spans[pass.next - 1]!.end;
    const span = entry.spans[pass.next]!;
    const got = readSync(fd, buffer, 0, span.end - start, start);
    if (got !== span.end - start || BigInt(Bun.hash.xxHash3(buffer.subarray(0, got))) !== span.digest) return false;
    pass.next++;
    if (performance.now() >= stop) break;
  }
  if (pass.next >= entry.spans.length) {
    entry.check = null;
    entry.checked = pass.version;
    entry.checkedThrough = entry.offset;
  }
  return true;
}

export function resetCommandHistory(): void {
  generation++;
  for (const entry of [...entries.values()]) discard(entry);
  queue.length = 0;
}
export function holdCommandHistory(): () => void {
  holders++;
  let released = false;
  return () => { if (!released) { released = true; if (--holders === 0) resetCommandHistory(); } };
}
export function commandHistorySize(): { waiting: number; sessions: number; draining: boolean; timers: number } {
  return { waiting: queue.length, sessions: entries.size, draining, timers: [...entries.values()].filter((entry) => entry.timer !== null).length };
}
