/**
 * The device journal (P10, P15): every admission, drop, removal and promotion on this PC, numbered by `seq`, which
 * orders the journal and nothing else (a row's age is its admission order, P21/P22). An admission is on disk before
 * its row is (G14); each row is told what it has not seen at its next connect, before anything else on its stream
 * (T57). An acknowledgement only moves that row's `seen`. An `admit` nobody decided stays in `open`, which is never
 * trimmed, until "It's me", "Not me", PC-local or a marker decides it; at OPEN_NOTICES_MAX the list admits nobody
 * new (G15). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceNotice, NoticeKind, NoticeReplay } from "../../shared/account-devices-api.ts";
import { writePrivateState } from "../private-state.ts";
import { DEVICE_JOURNAL_FILE } from "./safety-log.ts";

export const JOURNAL_FILE = DEVICE_JOURNAL_FILE;
export const JOURNAL_MAX = 1_000;
export const OPEN_NOTICES_MAX = 64;

export interface JournalEntry {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly kind: NoticeKind;
  readonly how: string;
  readonly key: string | null;
  /** the subject row's admission number on this PC, which places it against the row told */
  readonly no: number | null;
  readonly row: string | null;
  readonly label: string;
  readonly by: string | null;
  readonly account: string | null;
  /** a recovery's undo names the release it ends (kind `release`) */
  readonly undo?: string;
}
export type JournalInput = Omit<JournalEntry, "seq" | "id" | "at">;

interface Doc {
  v: 1;
  next_seq: number;
  entries: JournalEntry[];
  seen: Record<string, number>;
  open: JournalEntry[];
  /** the highest seq trimmed so far: a row that had not seen up to it is told how many it missed */
  trimmed: number;
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

function isEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return isCount(e.seq) && (e.seq as number) >= 1 && typeof e.id === "string" && typeof e.at === "string" && typeof e.kind === "string"
    && typeof e.how === "string" && isTextOrNull(e.key) && (e.no === null || isCount(e.no)) && isTextOrNull(e.row)
    && typeof e.label === "string" && isTextOrNull(e.by) && isTextOrNull(e.account) && (e.undo === undefined || typeof e.undo === "string");
}

/** The journal as this PC writes it, whole: every entry, open notice and seen value, below the next number (S19). */
function isDoc(value: unknown): value is Doc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Partial<Doc>;
  if (doc.v !== 1 || !isCount(doc.next_seq) || doc.next_seq < 1 || !isCount(doc.trimmed) || doc.trimmed >= doc.next_seq) return false;
  if (!Array.isArray(doc.entries) || !Array.isArray(doc.open) || typeof doc.seen !== "object" || doc.seen === null || Array.isArray(doc.seen)) return false;
  const below = (entry: JournalEntry) => entry.seq < doc.next_seq!;
  if (!doc.entries.every((entry) => isEntry(entry) && below(entry)) || !doc.open.every((entry) => isEntry(entry) && below(entry))) return false;
  return Object.values(doc.seen).every((seq) => isCount(seq) && seq < doc.next_seq!);
}

export class DeviceJournal {
  private doc: Doc = { v: 1, next_seq: 1, entries: [], seen: {}, open: [], trimmed: 0 };
  private problem: string | null = null;
  private exists = false;

  /** `companions`: called once before the journal's first write, to make the files a journal implies (P13, P24). */
  private constructor(private readonly path: string, private readonly companions: () => void) {}

  static open(stateDir: string, companions: () => void = () => {}): DeviceJournal {
    const journal = new DeviceJournal(join(stateDir, JOURNAL_FILE), companions);
    let text: string;
    try { text = readFileSync(journal.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") journal.problem = `Cannot read ${journal.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      return journal;
    }
    try {
      const doc = JSON.parse(text) as Partial<Doc>;
      if (!isDoc(doc)) journal.problem = `${journal.path} is not this PC's device journal`;
      else { journal.doc = doc; journal.exists = true; }
    } catch { journal.problem = `${journal.path} is not JSON`; }
    return journal;
  }

  get strict(): string | null {
    return this.problem === null ? null : `${this.problem}: only this PC itself gets in until the device journal is restored.`;
  }

  entries(): readonly JournalEntry[] { return this.doc.entries; }

  openNotices(): readonly JournalEntry[] { return this.doc.open; }

  /** Whether the list may admit anybody new: fewer than OPEN_NOTICES_MAX join notices wait for an answer (G15). */
  admitsFromList(): boolean { return this.problem === null && this.doc.open.length < OPEN_NOTICES_MAX; }

  /** Appends one entry, on disk when this returns; throws when it cannot be written, so what it records does not happen. */
  append(input: JournalInput): JournalEntry {
    if (this.problem !== null) throw new Error(this.strict!);
    const entry: JournalEntry = { ...input, seq: this.doc.next_seq, id: randomBytes(16).toString("hex"), at: new Date().toISOString() };
    let entries = [...this.doc.entries, entry];
    let trimmed = this.doc.trimmed;
    if (entries.length > JOURNAL_MAX) {
      const cut = entries.slice(0, entries.length - JOURNAL_MAX);
      trimmed = cut.at(-1)!.seq;
      entries = entries.slice(cut.length);
    }
    const open = entry.kind === "admit" ? [...this.doc.open, entry] : this.doc.open;
    if (!this.exists) this.companions();
    this.write({ ...this.doc, next_seq: entry.seq + 1, entries, open, trimmed });
    this.exists = true;
    return entry;
  }

  /**
   * What `row` is told at its connect: every entry it has not seen and every undecided admission, of the ones `tells`
   * lets it hear (the entries about rows newer than it), with how many trimmed entries it missed.
   */
  replay(row: string, tells: (entry: JournalEntry) => boolean): NoticeReplay {
    const seen = this.doc.seen[row] ?? 0;
    const unseen = this.doc.entries.filter((entry) => entry.seq > seen && tells(entry));
    const undecided = this.doc.open.filter((entry) => tells(entry) && !unseen.some((other) => other.id === entry.id));
    const missedOpen = this.doc.open.filter((entry) => entry.seq > seen && entry.seq <= this.doc.trimmed).length;
    return {
      notices: [...undecided, ...unseen].sort((a, b) => a.seq - b.seq).map((entry) => this.notice(entry)),
      cut: Math.max(0, this.doc.trimmed - seen - missedOpen),
    };
  }

  notice(entry: JournalEntry): DeviceNotice {
    const { undo: _undo, ...fields } = entry;
    return { ...fields, open: this.doc.open.some((open) => open.id === entry.id), method: null, two_step: null };
  }

  /** `row` saw everything up to `seq` (T57). Decides nothing. */
  ack(row: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= (this.doc.seen[row] ?? 0) || seq >= this.doc.next_seq) return;
    this.write({ ...this.doc, seen: { ...this.doc.seen, [row]: seq } });
  }

  /** An admission was decided ("It's me", "Not me", PC-local or a marker): it leaves `open`. */
  decide(id: string): boolean {
    if (!this.doc.open.some((entry) => entry.id === id)) return false;
    try {
      this.write({ ...this.doc, open: this.doc.open.filter((entry) => entry.id !== id) });
    } catch (error) {
      this.problem = `Cannot record a notice decision in ${this.path} (${error instanceof Error ? error.message : String(error)})`;
      throw error;
    }
    return true;
  }

  private write(doc: Doc): void {
    writePrivateState(this.path, doc);
    this.doc = doc;
  }
}
