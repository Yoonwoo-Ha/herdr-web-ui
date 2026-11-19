/**
 * The PC's safety log (rule R2, row P24 of the account-opens-all design): blocks, freezes, lifts, locks, unlocks and
 * forgettings in one append-only, numbered file of this PC's own state, `account-log.json`. Entries are only ever
 * appended: none is edited or deleted, and an ending is a record of the same log that names what it ends. What is in
 * force (locked, the blocks, the freezes, the markers of blocks) is worked out from the log alone, at every open, and
 * is never kept anywhere as a second truth.
 *
 * Fails closed (S19 in its strict form): a log that cannot be read, that is missing from a state folder that keeps a
 * device journal, or that holds one id with two records, makes `strict` say why; a strict log appends nothing, so the
 * file it could not read is never written over. Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 *
 * One writer: the server process, through the one handle open() gives per folder. `ovis recover` and every other tool
 * change the log through the server's recovery socket (S2-15), never by writing this file.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AccountRecordError, parseSafetyRecord, type PcLiftRecord, type SafetyRecord, type SafetyRecordKind } from "../../shared/account-records.ts";
import { privateStateRefusal, writePrivateState } from "../private-state.ts";

export const SAFETY_LOG_FILE = "account-log.json";
/** The device journal (P15, S2-07). A state folder that has one has had a log since, so a missing log there is damage. */
export const DEVICE_JOURNAL_FILE = "device-journal.json";

/** How the record reached this PC; noted once and never compared (P24). */
export type SafetyGot = "handed" | "mailbox" | "snapshot" | "pc" | "session" | "merge";

/** What this PC's own table said when a block arrived (P21), kept with the entry and never changed. */
export interface BlockAsOf {
  readonly signer_no: number | null;
  readonly target_no: number | null;
  readonly after: number | null;
  readonly joined: number | null;
  readonly signer_removed: boolean;
}

/**
 * An entry: the record whole as shared/account-records.ts parses it (a device-signed one with its signature, so its
 * signed bytes are those of the record and its id is their hash), and what this PC added once and never changes.
 */
export interface SafetyEntry {
  readonly n: number;
  readonly got: SafetyGot;
  readonly record: SafetyRecord;
  readonly asof?: BlockAsOf;
}

export type SafetyReceipt =
  | { outcome: "applied"; id: string; n: number }
  | { outcome: "already_applied"; id: string }
  | { outcome: "refused"; id: string; code: "record_invalid" | "conflict" | "log_unavailable" };

export interface SafetyState {
  readonly locked: boolean;
  readonly locks: readonly SafetyEntry[];
  readonly blocks: readonly SafetyEntry[];
  /** service freezes and blocks in force: each closes this PC to the keys newer than its target (P23) */
  readonly freezes: readonly SafetyEntry[];
  /** blocks whose marker stands: no lift that says `forget` names them, whether or not they are in force */
  readonly markers: readonly SafetyEntry[];
}

interface LogFile {
  v: 1;
  next: number;
  /** folded records, one line each with no number: an id in it is known and ended (P24) */
  base: { id: string }[];
  entries: SafetyEntry[];
  /** P19's waiting blocks (S2-10) */
  waiting: unknown[];
}

const GOTS: ReadonlySet<string> = new Set(["handed", "mailbox", "snapshot", "pc", "session", "merge"]);

/** The id of a record this PC writes: random, made then, in the form shared/account-records.ts accepts. */
export function pcRecordId(): string {
  return randomBytes(16).toString("hex");
}

const isNo = (value: unknown): boolean => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

/** Why `record` is no record of the log, or null: the shared parser decides, and a block keeps what this PC knew. */
function recordProblem(record: unknown, asof: BlockAsOf | undefined): string | null {
  let parsed: SafetyRecord;
  try { parsed = parseSafetyRecord(record); } catch (error) {
    if (error instanceof AccountRecordError) return error.message;
    throw error;
  }
  if (parsed.kind === "block") {
    if (asof === undefined) return "a block keeps what this PC knew when it arrived";
    const a = asof as unknown as Record<string, unknown>;
    if (typeof a !== "object" || a === null || Object.keys(a).length !== 5 || !isNo(a.signer_no) || !isNo(a.target_no) || !isNo(a.after) || !isNo(a.joined) || typeof a.signer_removed !== "boolean") return "invalid asof";
  } else if (asof !== undefined) return "only a block keeps asof";
  return null;
}

/** Two copies of one record: the same fields with the same values, whatever order JSON kept them in. */
function sameRecord(a: SafetyRecord, b: SafetyRecord): boolean {
  const canonical = (record: SafetyRecord) => JSON.stringify(Object.entries(record).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
  return canonical(a) === canonical(b);
}

function parseLog(value: unknown): LogFile | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not a log";
  const file = value as Partial<LogFile>;
  if (file.v !== 1) return "unknown version";
  if (!Number.isSafeInteger(file.next) || file.next! < 1) return "invalid next";
  if (!Array.isArray(file.base) || !file.base.every((line) => typeof line === "object" && line !== null && typeof line.id === "string")) return "invalid base";
  if (!Array.isArray(file.entries) || !Array.isArray(file.waiting)) return "invalid entries";
  const seen = new Map<string, SafetyRecord>();
  const numbers = new Set<number>();
  for (const id of file.base.map((line) => line.id)) {
    if (seen.has(id)) return `the folded id ${id} is held twice`;
    seen.set(id, { id } as SafetyRecord);
  }
  // every number this log gave is a whole entry or a folded line: a history with numbers that account for nothing
  // is none this writer made (P24)
  if (file.next! - 1 > file.entries.length + file.base.length) return `next ${String(file.next)} accounts for more records than the log holds`;
  for (const entry of file.entries as SafetyEntry[]) {
    if (typeof entry !== "object" || entry === null) return "an entry is an object";
    if (!Number.isSafeInteger(entry.n) || entry.n < 1 || entry.n >= file.next! || numbers.has(entry.n)) return `entry number ${String(entry.n)} is taken twice or past next`;
    numbers.add(entry.n);
    if (!GOTS.has(entry.got)) return "invalid got";
    const problem = recordProblem(entry.record, entry.asof);
    if (problem !== null) return `entry ${entry.n}: ${problem}`;
    const known = seen.get(entry.record.id);
    // one id with two records is a damaged log; the same record twice is one record that was written twice
    if (known !== undefined) return `the id ${entry.record.id} is held ${sameRecord(known, entry.record) ? "twice" : "by two different records"}`;
    seen.set(entry.record.id, entry.record);
  }
  return file as LogFile;
}

/**
 * Why another account may have written the log, or null: owned by another uid, or group- or other-writable. Such a
 * file is refused as it is, never repaired, since what it holds may already be someone else's (S19).
 */
function writableByOthers(path: string): string | null {
  if (process.platform === "win32") return null;
  let stats: Stats;
  try { stats = statSync(path); } catch { return null; }
  if (stats.uid !== process.getuid?.()) return `it is owned by uid ${stats.uid}`;
  return (stats.mode & 0o022) !== 0 ? "another account can write it" : null;
}

/** What a strict log reads as: locked, so nothing that reads it before checking `strict` takes it as open. */
const STRICT_STATE: SafetyState = { locked: true, locks: [], blocks: [], freezes: [], markers: [] };

/** The one handle of each folder's log in this process (P24: one writer, one numbering). */
const HANDLES = new Map<string, SafetyLog>();

export class SafetyLog {
  private file: LogFile = { v: 1, next: 1, base: [], entries: [], waiting: [] };
  private readError: string | null = null;
  private writeError: string | null = null;

  /** What is in force, worked out at open and after every append: the replay runs before anything is served (T41). */
  inForce: SafetyState = { locked: false, locks: [], blocks: [], freezes: [], markers: [] };

  private constructor(private readonly path: string, private readonly stateDir: string) {}

  /**
   * The one handle of `stateDir`'s log in this process, read and replayed again from disk: a second open is the same
   * handle, so no two handles of one folder ever give numbers. Never throws: a log that cannot be trusted makes
   * `strict` say why.
   */
  static open(stateDir: string): SafetyLog {
    const path = resolve(stateDir, SAFETY_LOG_FILE);
    const log = HANDLES.get(path) ?? new SafetyLog(path, stateDir);
    HANDLES.set(path, log);
    log.readError = null;
    log.writeError = null;
    log.load();
    return log;
  }

  /** The server that held this folder's handle stopped: the next open starts a fresh one. */
  close(): void {
    if (HANDLES.get(this.path) === this) HANDLES.delete(this.path);
  }

  /** Reads the file as open() does; false, with the log strict, when it is missing where it must exist or untrusted. */
  private load(): boolean {
    this.inForce = STRICT_STATE;
    // PC-written endings carry no signature: a log another account could write ends blocks and locks with one line
    const refused = writableByOthers(this.path) ?? privateStateRefusal(this.path);
    if (refused !== null) { this.readError = `${this.path} cannot be trusted: ${refused}`; return false; }
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.readError = `Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(this.stateDir, DEVICE_JOURNAL_FILE))) this.readError = `${this.path} is missing beside the device journal`;
      else if (this.file.next !== 1) this.readError = `${this.path} is missing after this PC wrote it`;
      else { this.inForce = this.state(); return true; }
      return false;
    }
    let parsed: LogFile | string;
    try { parsed = parseLog(JSON.parse(text)); } catch { parsed = "it is not JSON"; }
    if (typeof parsed === "string") { this.readError = `${this.path} cannot be trusted: ${parsed}`; return false; }
    this.file = parsed;
    this.inForce = this.state();
    return true;
  }

  /**
   * Why this PC fails closed, or null: nothing but this PC itself signs in until the log is put right. A failed append
   * counts until a reload finds the log whole (S19): nothing else is appended on this handle meanwhile.
   */
  get strict(): string | null {
    const why = this.readError ?? this.writeError;
    return why === null ? null : `${why}: only this PC itself gets in until the account safety log is restored.`;
  }

  entries(): readonly SafetyEntry[] { return this.file.entries; }

  /** The receipt of a record this log holds (T51): the same `applied` as often as it is asked, until it is folded. */
  receipt(id: string): SafetyReceipt | null {
    const entry = this.file.entries.find((candidate) => candidate.record.id === id);
    if (entry !== undefined) return { outcome: "applied", id, n: entry.n };
    return this.file.base.some((line) => line.id === id) ? { outcome: "already_applied", id } : null;
  }

  /**
   * Appends one record with the next number, on disk before it counts. A record this log already holds answers its
   * receipt and appends nothing; another record under a known id is refused, and the log keeps what it holds.
   */
  append(input: { record: SafetyRecord; got: SafetyGot; asof?: BlockAsOf }): SafetyReceipt {
    const { record, got, asof } = input;
    const id = typeof record?.id === "string" ? record.id : "";
    if (this.readError !== null || this.writeError !== null) return { outcome: "refused", id, code: "log_unavailable" };
    if (!GOTS.has(got) || recordProblem(record, asof) !== null) return { outcome: "refused", id, code: "record_invalid" };
    // what another handle of this folder appended is read first, so no number is given twice and none is lost (P24)
    if (!this.load()) return { outcome: "refused", id, code: "log_unavailable" };
    const held = this.file.entries.find((entry) => entry.record.id === id);
    if (held !== undefined) return sameRecord(held.record, record) ? { outcome: "applied", id, n: held.n } : { outcome: "refused", id, code: "conflict" };
    if (this.file.base.some((line) => line.id === id)) return { outcome: "already_applied", id };
    const entry: SafetyEntry = { n: this.file.next, got, record: { ...record }, ...(asof === undefined ? {} : { asof: { ...asof } }) };
    const next: LogFile = { ...this.file, next: this.file.next + 1, entries: [...this.file.entries, entry] };
    try { writePrivateState(this.path, next); } catch (error) {
      this.writeError = `Cannot write ${this.path} (${error instanceof Error ? error.message : String(error)})`;
      this.inForce = STRICT_STATE;
      return { outcome: "refused", id, code: "log_unavailable" };
    }
    this.file = next;
    this.inForce = this.state();
    return { outcome: "applied", id, n: entry.n };
  }


  /** What is in force, worked out from the log alone. Each ending ends only the record it names, and only of its kind. */
  state(): SafetyState {
    const lifted = new Set<string>();
    const forgotten = new Set<string>();
    const unlocked = new Set<string>();
    for (const { record } of this.file.entries) {
      if (record.kind === "lift") {
        lifted.add(record.target);
        if (record.signer === "pc" && (record as PcLiftRecord).forget) forgotten.add(record.target);
      } else if (record.kind === "unlock") unlocked.add(record.target);
    }
    const byN = [...this.file.entries].sort((a, b) => a.n - b.n);
    const of = (kind: SafetyRecordKind) => byN.filter((entry) => entry.record.kind === kind);
    const locks = of("lock").filter((entry) => !unlocked.has(entry.record.id));
    const blocks = of("block").filter((entry) => !lifted.has(entry.record.id));
    const serviceFreezes = of("freeze").filter((entry) => !lifted.has(entry.record.id.slice(2)));
    return {
      locked: locks.length > 0,
      locks,
      blocks,
      freezes: [...blocks, ...serviceFreezes].sort((a, b) => a.n - b.n),
      markers: of("block").filter((entry) => !forgotten.has(entry.record.id)),
    };
  }
}
