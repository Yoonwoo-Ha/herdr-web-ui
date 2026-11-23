/**
 * The view file of tui/model/view-file.ts on disk: one small file per core id in the screen's state folder (0700, the
 * file 0600), written whole to a new file and renamed over the old one, so a reader never sees half of it. It is
 * written when what it would hold changed, never once per frame; two screens on one core share the file and the last
 * writer wins.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./crash.ts";
import type { ModelState } from "./model/reduce.ts";
import { readView, refusedView, type SavedView, VIEW_FILE_MAX_BYTES, type ViewProblem, viewText } from "./model/view-file.ts";

/** The file's name for a core id: the id itself when it is a plain word, else its hash (an id never names a path). */
function viewFileName(core: string): string {
  const plain = /^[A-Za-z0-9_-]{1,64}$/.test(core) ? core : createHash("sha256").update(core).digest("hex").slice(0, 32);
  return `view-${plain}.json`;
}

/** The calls of a write that can fail part-way: what a test hands in to make them fail; the disk's own by default. */
export interface ViewFiles {
  /** writes `bytes` from `offset` on; answers how many were written */
  write(fd: number, bytes: Uint8Array, offset: number): number;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const DISK: ViewFiles = {
  write: (fd, bytes, offset) => writeSync(fd, bytes, offset),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

export class ViewStore {
  private path: string | null = null;
  private last: string | null = null;
  /** the last text the reader would refuse: not checked again until the view changes */
  private refused: string | null = null;
  private failed = false;
  /** The displayed snapshot is being replaced; its complete layout and owner are not both known yet. */
  private suspended = false;

  constructor(private readonly folder: string, private readonly files: ViewFiles = DISK) {}

  /**
   * A replacement snapshot arrived. Losing the line alone does not suspend writes to the displayed snapshot's file.
   */
  suspend(): void {
    this.suspended = true;
  }

  /**
   * The view kept for core `core`, or why its file could not be used; from now on `keep` writes that core's file. The
   * core already open (a line back to the same core) reads nothing again.
   */
  open(core: string): { view: SavedView | null; problem: ViewProblem | null } {
    this.suspended = false;
    const path = join(this.folder, viewFileName(core));
    if (path === this.path) return { view: null, problem: null };
    this.path = path;
    this.last = null;
    let text: string;
    try {
      // without waiting: a FIFO (or a link to one, or to a device) in the file's place must not hold the screen at start
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) return { view: null, problem: "not_a_file" };
        if (stat.size > VIEW_FILE_MAX_BYTES) return { view: null, problem: "too_large" };
        const bytes = Buffer.alloc(stat.size);
        text = bytes.subarray(0, readSync(fd, bytes, 0, stat.size, 0)).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return { view: null, problem: errorCode(error) === "ENOENT" ? null : "unreadable" };
    }
    const read = readView(text);
    if ("problem" in read) return { view: null, problem: read.problem };
    this.last = text;
    return { view: read.view, problem: null };
  }

  /**
   * Writes the view of `state` when it differs from what the file holds; not before its owner is known, not
   * while a kept view waits to be applied, and never a view the next run would refuse to read (the file it replaces
   * stays). Answers the error's code, or the reader's problem with the view, the first time a write fails (later
   * failures say nothing), else null.
   */
  keep(state: ModelState): string | null {
    if (this.path === null || this.suspended || state.restoring !== null) return null;
    const text = viewText(state.world, state.focus);
    if (text === null || text === this.last || text === this.refused) return null;
    const problem = refusedView(text);
    if (problem !== null) {
      this.refused = text;
      return this.failure(problem);
    }
    const bytes = Buffer.from(text, "utf8");
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let made = false;
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      chmodSync(this.folder, 0o700);
      const fd = openSync(temp, "wx", 0o600);
      made = true;
      try {
        // a write may take only part of the bytes: the rest follows until all are written, never a half file renamed
        for (let at = 0; at < bytes.length;) {
          const wrote = this.files.write(fd, bytes, at);
          if (wrote <= 0) throw Object.assign(new Error("the view file took no more bytes"), { code: "short_write" });
          at += wrote;
        }
      } finally {
        closeSync(fd);
      }
      this.files.rename(temp, this.path);
      // only a file in place is what the file holds: after a failed write the same view is tried again
      this.last = text;
      return null;
    } catch (error) {
      if (made) {
        try {
          this.files.remove(temp);
        } catch {
          // the write's own failure is what is said; a temp file left beside the view file is never read
        }
      }
      return this.failure(errorCode(error));
    }
  }

  /** `code` the first time a write fails, null after. */
  private failure(code: string): string | null {
    if (this.failed) return null;
    this.failed = true;
    return code;
  }
}
