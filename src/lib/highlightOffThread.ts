import { highlightNow, linesFromRuns, plainLines, SYNC_HIGHLIGHT_LIMIT, type Lines, type Runs } from "./highlight.ts";
import { createOffThreadQueue, type OffThreadJob, type WorkerLike } from "./offThread.ts";

/**
 * How long a worker may take to highlight one text. Ordinary code of a megabyte takes well under a
 * second even on a phone; past this the text is shown plain and said to be too long to highlight.
 */
export const HIGHLIGHT_BUDGET_MS = 2_000;

/** The colored texts kept, by the characters of their sources: a chat's code blocks and an open file. */
const CACHE_CHARACTERS = 4 * 1024 * 1024;

/**
 * Highlighted texts by language and source, least recently used first. `null` is a text the worker
 * gave up on, so it is not tried again each time its view mounts.
 */
export class LinesCache {
  private readonly entries = new Map<string, { lines: Lines | null; size: number }>();
  private size = 0;

  constructor(private readonly capacity: number) {}

  get(source: string, language: string): Lines | null | undefined {
    const key = `${language}\u0000${source}`;
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // the most recently used goes last
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.lines;
  }

  set(source: string, language: string, lines: Lines | null): void {
    if (source.length > this.capacity) return;
    const key = `${language}\u0000${source}`;
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.entries.delete(key);
      this.size -= old.size;
    }
    this.entries.set(key, { lines, size: source.length });
    this.size += source.length;
    for (const [oldest, entry] of this.entries) {
      if (this.size <= this.capacity) break;
      this.entries.delete(oldest);
      this.size -= entry.size;
    }
  }
}

const cache = new LinesCache(CACHE_CHARACTERS);

const queue = createOffThreadQueue<{ source: string; language: string }, Runs>(
  () => new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" }) as WorkerLike,
  HIGHLIGHT_BUDGET_MS,
);

/** Lines to show for a text, and whether they were left plain because highlighting it took too long. */
export interface Highlighted {
  lines: Lines;
  tooLong: boolean;
}

/** `null` from the worker (it gave up, or failed) as what is shown: the text plain, said to be too long. */
export function highlightedFrom(source: string, lines: Lines | null): Highlighted {
  return lines === null ? { lines: plainLines(source), tooLong: true } : { lines, tooLong: false };
}

/**
 * `source` (normalized, `language` registered) highlighted without waiting, where that can be: short
 * code at once (`SYNC_HIGHLIGHT_LIMIT`), longer code as the worker answered it before and the cache
 * still holds it. `null`: ask `highlightOffThread`.
 */
export function highlightKnown(source: string, language: string): Highlighted | null {
  if (source.length <= SYNC_HIGHLIGHT_LIMIT) return { lines: highlightNow(source, language), tooLong: false };
  const cached = cache.get(source, language);
  return cached === undefined ? null : highlightedFrom(source, cached);
}

/**
 * `source` (normalized, `language` registered) highlighted in a worker. `null` when it took longer
 * than `HIGHLIGHT_BUDGET_MS`, failed or was cancelled before it started. A result is kept for
 * `highlightKnown`, also when its caller has moved on.
 */
export function highlightOffThread(source: string, language: string): OffThreadJob<Lines> {
  const job = queue({ source, language });
  let dropped = false;
  return {
    cancel: () => {
      if (job.cancel()) dropped = true;
      return dropped;
    },
    promise: job.promise.then((runs) => {
      const lines = runs === null ? null : linesFromRuns(source, runs);
      // a job dropped before it ran says nothing about its text; one that ran is kept either way
      if (!dropped) cache.set(source, language, lines);
      return lines;
    }),
  };
}
