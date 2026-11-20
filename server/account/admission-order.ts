/**
 * One admission order per PC (rows P21 and P22 of the account-opens-all design). Every row this PC admits carries an
 * `origin`: where it came from, by which path, and `admit_no`, its place in this PC's own order, taken from
 * `next_admit` in `account-pc.json` and never used twice. Age in any decision on this PC is that order: no account
 * registration number, no journal sequence and no clock stands in for it. Rows from before the upgrade are stamped
 * `legacy` once (T50) and keep their creation order among themselves; a row with no origin, or a tie, has no age and
 * so no authority over another row (T19). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { AccountSnapshotError, parseAdmissionOrigin, type AdmissionFrom, type AdmissionHow, type AdmissionOrigin } from "../../shared/account-snapshot.ts";

/** This PC's account state (P12, server/account/pc-binding.ts), which holds `next_admit`. */
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


/** The stamp of a row that existed before the upgrade (T50): older than every later admission here. */
export function legacyOrigin(createdAt: string): RowOrigin {
  return { from: "legacy", how: "legacy", by: null, admit_no: 0, at: createdAt };
}
