import { readFileSync, rmSync } from "node:fs";
import { isAccountKeyEncoding } from "../../shared/account-records.ts";
import { writePrivateState } from "../private-state.ts";

export const ACCOUNT_HELD_MAX = 4096;

function readJson(path: string | undefined): { value: unknown } | null | "missing" {
  if (!path) return "missing";
  try { return { value: JSON.parse(readFileSync(path, "utf8")) as unknown }; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
}

export class AccountHolds {
  readonly error: string | null = null;
  private enrollingBy: string | null = null;
  private confirmed = false;
  private keys = new Set<string>();
  private overflowed = false;

  constructor(private readonly options: { enrollingPath?: string; heldPath?: string } = {}) {
    const enrolling = readJson(options.enrollingPath);
    const held = readJson(options.heldPath);
    const problems: string[] = [];
    if (held === null) problems.push(`${options.heldPath} cannot be read`);
    else if (held !== "missing") {
      const value = held.value as { keys?: unknown; full?: unknown } | null;
      if (!Array.isArray(value?.keys) || !value.keys.every(isAccountKeyEncoding) || typeof value.full !== "boolean") problems.push(`${options.heldPath} is not a list of held keys`);
      else { this.keys = new Set(value.keys); this.overflowed = value.full; }
    }
    if (enrolling === null) problems.push(`${options.enrollingPath} cannot be read`);
    else if (enrolling !== "missing") {
      const by = (enrolling.value as { by?: unknown } | null)?.by;
      if (typeof by !== "string") problems.push(`${options.enrollingPath} is not an enrollment barrier`);
      else { this.enrollingBy = by; this.confirmed = (enrolling.value as { confirmed?: unknown }).confirmed === true; }
    }
    if (problems.length > 0) this.error = `${problems.join("; ")}: account adds wait until it is restored or removed.`;
  }

  startEnrolling(by: string, options: { stale?: boolean } = {}): void {
    this.assertReadable();
    if (options.stale) this.confirmed = false;
    if (this.confirmed) return;
    if (this.options.enrollingPath) writePrivateState(this.options.enrollingPath, { by });
    this.enrollingBy = by;
  }

  confirmEnrolling(by: string): void {
    this.assertReadable();
    if (this.confirmed) return;
    if (this.options.enrollingPath) writePrivateState(this.options.enrollingPath, { by, confirmed: true });
    this.enrollingBy = by;
    this.confirmed = true;
  }

  /** A file that cannot be read is never written over: what it held would be lost. */
  private assertReadable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  endEnrolling(): void {
    this.assertReadable();
    if (this.options.enrollingPath) rmSync(this.options.enrollingPath, { force: true });
    this.enrollingBy = null;
    this.confirmed = false;
  }

  enrolling(): boolean { return this.enrollingBy !== null; }

  enrollingMember(): string | null { return this.enrollingBy; }

  hold(keys: readonly string[]): void {
    this.assertReadable();
    const next = new Set(this.keys);
    for (const key of keys) next.add(key);
    const full = this.overflowed || next.size > ACCOUNT_HELD_MAX;
    const kept = full ? [...next].slice(0, ACCOUNT_HELD_MAX) : [...next];
    if (this.options.heldPath) writePrivateState(this.options.heldPath, { keys: kept, full });
    this.keys = new Set(kept);
    this.overflowed = full;
  }

  overflow(): void {
    this.assertReadable();
    if (this.options.heldPath) writePrivateState(this.options.heldPath, { keys: [...this.keys], full: true });
    this.overflowed = true;
  }

  holds(key: string): boolean { return this.error !== null || this.overflowed || this.keys.has(key); }

  list(): string[] { return [...this.keys]; }

  full(): boolean { return this.error !== null || this.overflowed; }
}
