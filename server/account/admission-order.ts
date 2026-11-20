/**
 * One admission order per PC (rows P21 and P22 of the account-opens-all design). Every row this PC admits carries an
 * `origin`: where it came from, by which path, and `admit_no`, its place in this PC's own order, taken from
 * `next_admit` in `account-pc.json` and never used twice. Age in any decision on this PC is that order: no account
 * registration number, no journal sequence and no clock stands in for it. Rows from before the upgrade are stamped
 * `legacy` once (T50) and keep their creation order among themselves; a row with no origin, or a tie, has no age and
 * so no authority over another row (T19). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { AccountSnapshotError, parseAdmissionOrigin, type AdmissionFrom, type AdmissionHow, type AdmissionOrigin } from "../../shared/account-snapshot.ts";
import { DEVICE_JOURNAL_FILE } from "./safety-log.ts";

/** This PC's account state (P12); S2-03 keeps only `next_admit` in it, and the binding joins it later under the same `v`. */
export const ADMISSION_FILE = "account-pc.json";

export type OriginFrom = AdmissionFrom;
export type OriginHow = AdmissionHow;
/** A row's origin is the shared contract's (shared/account-snapshot.ts); `by` is the approving member's account key. */
export type RowOrigin = AdmissionOrigin;

/** Whether a stored origin is one the shared contract accepts: a legacy one only with admit_no 0, every other from 1. */
export function isRowOrigin(value: unknown): value is RowOrigin {
  try { parseAdmissionOrigin(value); return true; } catch (error) {
    if (error instanceof AccountSnapshotError) return false;
    throw error;
  }
}

interface AdmissionRow { readonly id: string; readonly created_at: string; readonly origin?: RowOrigin | undefined }

/**
 * Which of two rows joined this PC first: `older` when `a` did, `newer` when `b` did, null when they cannot be placed
 * against each other (a missing origin, or two legacy rows made at the same time). Null gives no authority either way.
 */
export function compareAdmission(a: AdmissionRow, b: AdmissionRow): "older" | "newer" | null {
  if (a.origin === undefined || b.origin === undefined || a.id === b.id) return null;
  if (a.origin.from === "legacy" && b.origin.from === "legacy") {
    const [left, right] = [Date.parse(a.created_at), Date.parse(b.created_at)];
    if (Number.isNaN(left) || Number.isNaN(right) || left === right) return null;
    return left < right ? "older" : "newer";
  }
  if (a.origin.admit_no === b.origin.admit_no) return null;
  return a.origin.admit_no < b.origin.admit_no ? "older" : "newer";
}

/** What a remote caller may act on: its own row, and the rows that joined this PC after it (T19 in 2d). */
export function remoteReach(caller: AdmissionRow, target: AdmissionRow): boolean {
  if (caller.id === target.id) return true;
  return compareAdmission(caller, target) === "older";
}


/** A folder by what it is on disk, so a link to it and its real path are one folder (P21). */
function realFolder(stateDir: string): string {
  try { return realpathSync(stateDir); } catch { return resolve(stateDir); }
}

/** The one handle of each folder's order in this process (P21). */
const HANDLES = new Map<string, AdmissionOrder>();

export class AdmissionOrder {
  private nextAdmit = 1;
  private problem: string | null = null;
  /** no order file and no journal: this folder's rows predate the release and are stamped `legacy` once (T50) */
  readonly fresh: boolean = false;

  private constructor(private readonly path: string) {}

  /**
   * The one handle of `stateDir`'s order in this process, read again from disk: no two handles of one folder give
   * numbers (P21), whatever path names it. A missing file makes the order fresh.
   */
  static open(stateDir: string): AdmissionOrder {
    const path = join(realFolder(stateDir), ADMISSION_FILE);
    const order = HANDLES.get(path) ?? new AdmissionOrder(path);
    HANDLES.set(path, order);
    order.problem = null;
    (order as { fresh: boolean }).fresh = false;
    let text: string;
    try { text = readFileSync(order.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") order.problem = `Cannot read ${order.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(stateDir, DEVICE_JOURNAL_FILE))) order.problem = `${order.path} is missing beside the device journal`;
      else { (order as { fresh: boolean }).fresh = true; order.nextAdmit = 1; }
      return order;
    }
    try {
      const value = JSON.parse(text) as { v?: unknown; next_admit?: unknown };
      if (value.v !== 1 || !Number.isSafeInteger(value.next_admit) || (value.next_admit as number) < 1) order.problem = `${order.path} is not this PC's account state`;
      else order.nextAdmit = value.next_admit as number;
    } catch { order.problem = `${order.path} is not JSON`; }
    return order;
  }

  /**
   * This folder's own rows as they are on disk before a sibling merge can remove any (P21, S29): a missing order file
   * beside a row it numbered, or one at or behind such a number, is damage. Run before the merge.
   */
  checkRows(rows: readonly { readonly origin?: RowOrigin | undefined }[]): void {
    const numbers = rows.flatMap((row) => row.origin === undefined || row.origin.from === "legacy" ? [] : [row.origin.admit_no]);
    if (numbers.length === 0) return;
    if (this.fresh) this.missingBeside();
    else this.checkAbove(numbers);
  }

  /** A row numbered at or past the next number: the order file is behind its rows, which is damage (P21). */
  checkAbove(numbers: readonly number[]): void {
    const highest = Math.max(0, ...numbers);
    if (this.problem === null && highest >= this.nextAdmit) this.problem = `${this.path} is behind the number ${highest} a row here carries`;
  }

  /** Why this PC fails closed, or null: no row is admitted while its order cannot be known. */
  get strict(): string | null {
    return this.problem === null ? null : `${this.problem}: only this PC itself gets in until the account state is restored.`;
  }

  static legacy(createdAt: string): RowOrigin {
    return { from: "legacy", how: "legacy", by: null, admit_no: 0, at: createdAt };
  }

  /** A folder whose rows already carry numbers lost its order file: damage, not a fresh count (P21, S19). */
  missingBeside(): void {
    (this as { fresh: boolean }).fresh = false;
    this.problem = `${this.path} is missing beside rows this PC numbered`;
  }

  /** The one-time legacy pass could not be written: this PC's order is unknown, so it fails closed (S19). */
  unwritten(error: unknown): void {
    (this as { fresh: boolean }).fresh = false;
    this.problem = `The rows from before the upgrade could not be stamped in ${this.path} (${error instanceof Error ? error.message : String(error)})`;
  }

  /** Ends the one-time legacy stamping: the rows went to disk first, so a stop in between stamps them again, not twice. */
  settleFresh(): void {
    if (!this.fresh || this.problem !== null) return;
    writePrivateState(this.path, { v: 1, next_admit: this.nextAdmit });
    (this as { fresh: boolean }).fresh = false;
  }

  /** The origin of a row being admitted now; its number is on disk before the row is, so none is ever used twice. */
  admit(from: OriginFrom, how: OriginHow, by: string | null, now: number): RowOrigin {
    if (this.problem !== null) throw new Error(this.strict!);
    // nothing is numbered before the one-time legacy pass has run (T50): it decides where the count starts
    if (this.fresh) throw new Error(`${this.path}: the rows from before the upgrade are not stamped yet`);
    const admitNo = this.nextAdmit;
    writePrivateState(this.path, { v: 1, next_admit: admitNo + 1 });
    this.nextAdmit = admitNo + 1;
    (this as { fresh: boolean }).fresh = false;
    return { from, how, by, admit_no: admitNo, at: new Date(now).toISOString() };
  }
}
