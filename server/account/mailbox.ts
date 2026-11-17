/**
 * The PC's mailbox at the account service (docs/account.md, "Account service API"): records left for
 * this PC while it was off. The PC signs in with nothing but its relay key, answering a server proof
 * for the `account` role, which the relay itself never accepts. The service can hold records back,
 * never forge one: each is checked and applied like a record a client hands over directly.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { writePrivateState } from "../private-state.ts";
import { accountServiceOff, DEFAULT_ACCOUNT_SERVICE } from "../../shared/web-policy.ts";
import { ACCOUNT_RECORDS_MAX, isAccountKeyEncoding } from "../../shared/account-records.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { AccountHolds } from "./holds.ts";
import { applyAccountRecords, type AddGates, type RecordOutcome } from "./records.ts";

export const MAILBOX_PULL_MS = 5 * 60_000;
export const ADMISSION_TTL_MS = 10 * 60_000;
const ASKED_PULL_MS = 10_000;
export const SIGN_IN_PULL_MS = 60_000;
export const SIGN_IN_PULL_RETRY_MS = ASKED_PULL_MS;
export const SIGN_IN_WAIT_MS = 5_000;

function scope(account: string, serverId: string, key: string): string {
  return `${account}\0${serverId}\0${key}`;
}
const MAX_PAGES = 20;

export class AccountServiceOff extends Error {
  constructor() {
    super("The account service is turned off (OVIS_ACCOUNT_SERVICE_URL=off)");
    this.name = "AccountServiceOff";
  }
}

export function passAccountService(value?: string): string | Error | undefined {
  try { return accountServiceUrl(value); } catch (error) {
    if (error instanceof AccountServiceOff) return undefined;
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function accountServiceUrl(value = process.env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE): string {
  if (accountServiceOff(value)) throw new AccountServiceOff();
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The account service must be https");
  return url.origin;
}

export const PENDING_MAX = 1000;

const WAITING = new Set(["signer_not_member", "enrolling", "removal_pending"]);

const waits = (outcome: RecordOutcome | undefined): boolean => outcome?.outcome === "refused" && WAITING.has(outcome.code);

function readPending(path: string | undefined): unknown[] | null {
  if (!path) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  return Array.isArray(value) ? value : null;
}

function removedKey(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const { kind, key } = record as { kind?: unknown; key?: unknown };
  return kind === "remove" && typeof key === "string" ? key : null;
}

export interface AccountMailboxOptions {
  readonly pendingPath?: string;
  readonly devices: DeviceStore;
  readonly identity: () => RelayIdentity | undefined;
  readonly service: string | Error;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly holds?: AccountHolds;
}

export class AccountMailbox {
  lastPullAt: string | null = null;
  private admissions = new Map<string, number>();
  private lastAskedPull = Number.NEGATIVE_INFINITY;
  private nextSignInPull = Number.NEGATIVE_INFINITY;
  private drainedAt: number | null = null;
  private drainedScope: string | null = null;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pulling: Promise<number> | undefined;

  private pending: unknown[];
  private draining: unknown[] = [];
  private readonly pendingError: string | null;

  constructor(private readonly options: AccountMailboxOptions) {
    const pending = readPending(options.pendingPath);
    this.pending = pending ?? [];
    this.pendingError = pending === null ? `Cannot read ${options.pendingPath}: account adds wait until it is restored or fixed.` : null;
  }

  gates(): AddGates {
    return {
      enrolling: () => this.options.holds?.enrolling() ?? false,
      held: (key) => this.pendingError !== null || this.waiting().some((record) => removedKey(record) === key) || (this.options.holds?.holds(key) ?? false),
      removing: (key) => this.pendingError !== null || this.waiting().some((record) => removedKey(record) === key),
    };
  }

  holdsEveryAdd(): boolean { return this.pendingError !== null || (this.options.holds?.full() ?? false); }

  waitingRemoveKeys(): string[] {
    return [...new Set(this.waiting().flatMap((record) => removedKey(record) ?? []))];
  }

  private waiting(): unknown[] { return [...this.draining, ...this.pending]; }

  pull(): Promise<number> {
    this.pulling ??= this.exclusively(() => this.drain()).finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  private turn: Promise<unknown> = Promise.resolve();

  private exclusively<T>(run: () => Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  start(): void {
    if (this.timer) return;
    void this.pull();
    this.timer = setInterval(() => { void this.pull(); }, MAILBOX_PULL_MS);
    this.timer.unref?.();
  }

  async admitted(key: string): Promise<boolean> {
    const fresh = () => {
      const account = this.options.devices.account();
      const identity = this.options.identity();
      if (account === null || !identity) return false;
      const at = this.admissions.get(scope(account, identity.server_id, key));
      const now = Date.now();
      return at !== undefined && now - at < ADMISSION_TTL_MS && at <= now + 60_000;
    };
    if (fresh()) return true;
    if (this.pulling) await this.pulling;
    else if (Date.now() - this.lastAskedPull >= ASKED_PULL_MS) {
      this.lastAskedPull = Date.now();
      await this.pull();
    }
    return fresh();
  }

  async pullForRefusedSignIn(waitMs = SIGN_IN_WAIT_MS, now = Date.now()): Promise<void> {
    if (this.options.devices.account() === null) return;
    let pull = this.pulling;
    if (!pull) {
      if (now < this.nextSignInPull) return;
      this.nextSignInPull = now + SIGN_IN_PULL_MS;
      pull = this.pull();
      void pull.then(() => {
        if (this.error !== null) this.nextSignInPull = Math.min(this.nextSignInPull, now + SIGN_IN_PULL_RETRY_MS);
      }, () => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
    try { await Promise.race([pull.then(() => undefined, () => undefined), late]); }
    finally { clearTimeout(timer); }
  }

  async freshen(): Promise<boolean> {
    if (this.options.service instanceof AccountServiceOff) return this.pendingError === null;
    const asked = Date.now();
    if (this.pulling) await this.pulling;
    await this.pull();
    if (this.drainedAt === null || this.drainedAt < asked) return false;
    const account = this.options.devices.account();
    const identity = this.options.identity();
    const current = account === null || !identity ? null : scope(account, identity.server_id, "");
    return this.error === null && current !== null && this.drainedScope === current;
  }

  settle(): Promise<number> {
    return this.exclusively(() => this.settleNow());
  }

  private async settleNow(): Promise<number> {
    const identity = this.options.identity();
    if (!identity || this.pendingError !== null || this.pending.length === 0) return 0;
    const early = this.pending.splice(0);
    this.draining = early;
    try {
      const applied = await this.retry(early, identity.server_id);
      return applied;
    } finally {
      this.pending = [...early, ...this.pending];
      this.draining = [];
      if (this.options.pendingPath) writePrivateState(this.options.pendingPath, this.pending);
    }
  }

  private async retry(early: unknown[], serverId: string): Promise<number> {
    let applied = 0;
    for (let progress = true; progress && early.length;) {
      progress = false;
      for (let start = 0; start < early.length;) {
        const batch = early.slice(start, start + ACCOUNT_RECORDS_MAX);
        const outcomes = await applyAccountRecords(this.options.devices, batch, serverId, Date.now(), this.gates());
        const keep = batch.filter((_record, index) => waits(outcomes[index]));
        applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
        if (keep.length !== batch.length) progress = true;
        early.splice(start, batch.length, ...keep);
        start += keep.length;
      }
    }
    return applied;
  }

  wait(record: unknown): boolean {
    const waiting = this.waiting();
    const text = JSON.stringify(record);
    if (waiting.some((kept) => JSON.stringify(kept) === text)) return true;
    if (this.pendingError !== null) return false;
    const next = [...this.pending, record];
    if (waiting.length >= PENDING_MAX) {
      const add = next.findIndex((kept) => removedKey(kept) === null);
      if (add === -1) {
        const key = removedKey(record);
        if (key !== null) this.options.holds?.hold([key]);
        return false;
      }
      next.splice(add, 1);
    }
    if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...this.draining, ...next]);
    this.pending = next;
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<number> {
    const account = this.options.devices.account();
    let identity: RelayIdentity | undefined;
    try { identity = this.options.identity(); } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return 0;
    }
    if (account === null || !identity) return 0;
    if (this.options.service instanceof Error) { this.error = this.options.service.message; return 0; }
    if (this.options.devices.accountError !== null) { this.error = this.options.devices.accountError; return 0; }
    if (this.pendingError !== null) { this.error = this.pendingError; return 0; }
    let applied = 0;
    let ack: number | null = null;
    const early: unknown[] = this.pending.splice(0);
    this.draining = early;
    const retry = async () => { applied += await this.retry(early, identity.server_id); };
    const save = () => {
      this.trim(early);
      if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...early, ...this.pending]);
    };
    let complete = false;
    this.drainedAt = null;
    try {
      const admissions = new Map<string, number>();
      await retry();
      for (let page = 0; ; page++) {
        const { entries, waiting } = await this.page(identity, account, ack);
        for (const admission of waiting) admissions.set(scope(account, identity.server_id, admission.key), Date.parse(admission.at));
        if (entries.length === 0) { complete = true; break; }
        if (page === MAX_PAGES) break;
        for (let start = 0; start < entries.length; start += ACCOUNT_RECORDS_MAX) {
          const batch = entries.slice(start, start + ACCOUNT_RECORDS_MAX).map(({ record }) => record);
          const keep = (record: unknown) => {
            const text = JSON.stringify(record);
            if (!early.some((kept) => JSON.stringify(kept) === text)) early.push(record);
            return true;
          };
          const outcomes = await applyAccountRecords(this.options.devices, batch, identity.server_id, Date.now(), this.gates(), keep);
          applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
          outcomes.forEach((outcome, index) => { if (waits(outcome)) keep(batch[index]); });
        }
        await retry();
        save();
        ack = Math.max(...entries.map(({ seq }) => seq));
      }
      save();
      this.pending = [...early, ...this.pending];
      this.draining = [];
      this.admissions = admissions;
      this.lastPullAt = new Date().toISOString();
      this.error = null;
      if (complete) { this.drainedAt = Date.now(); this.drainedScope = scope(account, identity.server_id, ""); }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      try { save(); } catch {}
      this.pending = [...early, ...this.pending];
      this.draining = [];
    }
    return applied;
  }

  private trim(early: unknown[]): void {
    let over = early.length + this.pending.length - PENDING_MAX;
    for (let index = 0; over > 0 && index < early.length;) {
      if (removedKey(early[index]) === null) { early.splice(index, 1); over--; } else index++;
    }
    if (over <= 0) return;
    this.options.holds?.overflow();
    early.splice(0, over);
  }

  private async page(identity: RelayIdentity, account: string, ack: number | null): Promise<{ entries: { seq: number; record: unknown }[]; waiting: { key: string; at: string }[] }> {
    const call = async (path: string, body: unknown) => {
      const response = await (this.options.fetch ?? fetch)(new Request(String(this.options.service) + path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      }));
      if (!response.ok) throw new Error(`The account service answered ${response.status} to ${path}`);
      return await response.json() as Record<string, unknown>;
    };
    const publicKey = bytesToHex(importPublicKey(identity.public_key));
    const challenge = await call("/v1/pc/challenge", { server_id: identity.server_id, public_key: publicKey });
    if (typeof challenge.challenge_id !== "string") throw new Error("The account service sent no challenge");
    const proof = answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key),
      { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id });
    if (!proof) throw new Error("The account service sent a malformed challenge");
    const mailbox = await call("/v1/pc/mailbox", { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof, account, ack });
    const records = mailbox.records;
    if (!Array.isArray(records) || !records.every((entry) => typeof entry === "object" && entry !== null && Number.isSafeInteger((entry as { seq?: unknown }).seq))) {
      throw new Error("The account service sent a malformed mailbox");
    }
    const admissions = Array.isArray(mailbox.admissions) ? mailbox.admissions : [];
    const waiting = admissions.filter((a): a is { key: string; at: string } => typeof a === "object" && a !== null
      && isAccountKeyEncoding((a as { key?: unknown }).key) && typeof (a as { at?: unknown }).at === "string" && !Number.isNaN(Date.parse((a as { at: string }).at)));
    return { entries: records as { seq: number; record: unknown }[], waiting };
  }
}
