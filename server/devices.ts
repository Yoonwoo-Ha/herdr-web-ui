/**
 * Paired devices: the per-device credential a phone (or anyone the owner lets in) uses
 * instead of the shared token. The owner starts a pairing on the PC and gets a short code
 * that lives ten minutes; the device sends the code once and receives a token of its own
 * in an HttpOnly cookie. Only a hash of that token is stored, so devices.json in the state
 * dir (0600, written whole, and flushed before it replaces the old list whenever access
 * changes: private-state.ts) reveals nothing if read. Revocation also closes that device's
 * active streams; revoking all is one write of an empty, gated registry, after which every
 * credential (paired, pending or unconfirmed) is void. A device is either allowed to drive
 * (type, answer, manage) or only to watch. A durable enrollment is announced (`onPaired`) once
 * its write succeeded, so every other session can hear of a device it did not pair.
 */
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AccountRecordError, parseAccountRecord, type AddRecord, type RemoveRecord } from "../shared/account-records.ts";
import { type DevicePairedEvent, type DeviceRemovedEvent, type DevicePairToken, type DeviceRole, type DevicesRevokedAll, type PairedDevice, type DeviceConnection, STREAM_COOKIE_PREFIX } from "../shared/protocol.ts";
import type { Access } from "./access.ts";
import { CLEAR_LEGACY_DEVICE_COOKIE, COOKIE_MAX_AGE_SECONDS, DEVICE_COOKIE_CLEARED, deviceCookie, isSecureRequest, noContent, parseCookies } from "./auth.ts";
import { badRequest, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import { writePrivateState } from "./private-state.ts";

const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const LAST_SEEN_WRITE_MS = 60_000;
const UNCONFIRMED_FIRST_PAIR_LIMIT = 8;
const LABEL_MAX = 48;
const PAIRING_WINDOW_MS = 10 * 60_000;

export class PairingRateLimitedError extends Error {
  readonly code = "pairing_rate_limited";
  constructor(readonly retryAfter: number) {
    super("Too many pairing attempts; try again later");
  }
}

export class DeviceGoneError extends Error {
  readonly code = "unauthorized";
  constructor() {
    super("this device is no longer paired");
  }
}

export class PcInAccountError extends Error {
  readonly code = "in_account";
  constructor() {
    super("This PC is already in an Ovis account. Sign in to that account on the device to add it.");
  }
}

/** Canonical base64url SPKI containing a public P-256 key, never private key material. */
function isRelayPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return false;
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && key.export({ format: "der", type: "spki" }).equals(bytes);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export interface StoredDevice {
  id: string;
  label: string;
  role: DeviceRole;
  token_hash: string;
  relay_public_key?: string;
  created_at: string;
  last_seen_at: string | null;
  account?: string;
  added_by?: string;
  linked_at?: string;
  link_moved_key?: boolean;
  account_add?: unknown;
}

export type PairingPath = "code" | "account" | "vouched";
export type PairingFailurePath = PairingPath | "lan";

interface UnconfirmedFirstPair {
  device: StoredDevice;
  expires: number;
  origin: readonly string[];
}

/**
 * A browser's stream keys (shared/protocol.ts, "Browser stream keys"): HttpOnly cookies named
 * `ovis_stream_<32 hex>` with the value `1`. They grant nothing. The key is in the NAME, so
 * two answers that each issue one (two tabs opening at once, before either had a key) add two
 * cookies instead of the second overwriting the first: every later request of that browser,
 * the pairing included, carries every key any of its streams was opened with.
 */
const STREAM_KEYS_MAX = 8;
const STREAM_KEY = /^[0-9a-f]{32}$/;

export function streamKeys(request: Request): string[] {
  const keys: string[] = [];
  for (const [name, value] of parseCookies(request.headers.get("cookie"))) {
    if (!name.startsWith(STREAM_COOKIE_PREFIX) || value !== "1") continue;
    const key = name.slice(STREAM_COOKIE_PREFIX.length);
    if (STREAM_KEY.test(key) && !keys.includes(key)) keys.push(key);
    if (keys.length === STREAM_KEYS_MAX) break;
  }
  return keys;
}

/** The request names `application/json` among the types it accepts: a browser's fetch sends `*\/*` and never asks. */
function acceptsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((type) => type.split(";")[0]!.trim().toLowerCase() === "application/json");
}

export function newStreamKey(): string {
  return randomBytes(16).toString("hex");
}

export function streamCookie(key: string, secure: boolean): string {
  return `${STREAM_COOKIE_PREFIX}${key}=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function sameBrowser(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

export interface PairingCode {
  code: string;
  expires_at: string;
}

export interface DeviceMatch {
  id: string;
  label: string;
  role: DeviceRole;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function normalizeLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return label || fallback;
}

export function isDeviceRole(value: unknown): value is DeviceRole {
  return value === "drive" || value === "watch";
}

export type DeviceRegistry = { kind: "missing" } | { kind: "ok"; gateClosedAt: string | null; devices: StoredDevice[]; placeholder: boolean } | { kind: "bad" };

export function readDeviceRegistry(path: string): DeviceRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "bad" };
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.devices)
    || !(parsed.gate_closed_at === null || typeof parsed.gate_closed_at === "string")
    || !parsed.devices.every((d) => isJsonObject(d) && typeof d.id === "string"
      && typeof d.token_hash === "string" && isDeviceRole(d.role)
      && (d.relay_public_key === undefined || isRelayPublicKey(d.relay_public_key))
      && typeof d.label === "string" && typeof d.created_at === "string"
      && (d.last_seen_at === null || typeof d.last_seen_at === "string")
      && (d.account === undefined || typeof d.account === "string")
      && (d.added_by === undefined || typeof d.added_by === "string")
      && (d.linked_at === undefined || typeof d.linked_at === "string")
      && (d.link_moved_key === undefined || typeof d.link_moved_key === "boolean")
      && (d.account_add === undefined || isJsonObject(d.account_add)))) return { kind: "bad" };
  return { kind: "ok", gateClosedAt: parsed.gate_closed_at, devices: parsed.devices as StoredDevice[], placeholder: parsed.placeholder === true && parsed.devices.length === 0 };
}

export interface AccountTombstone { key: string; account: string; record_id: string; removed_at: string; records?: unknown[] }

export const TOMBSTONE_RECORDS_MAX = 8;

function withRecords(records: readonly unknown[] | undefined, more: readonly unknown[]): unknown[] | undefined {
  const signer = (record: unknown) => isJsonObject(record) ? record.signer : undefined;
  const kept = [...records ?? []];
  for (const record of more) {
    if (kept.length >= TOMBSTONE_RECORDS_MAX || kept.some((own) => signer(own) === signer(record))) continue;
    kept.push(record);
  }
  return kept.length ? kept : undefined;
}

function readTombstones(path: string): AccountTombstone[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  if (!isJsonObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.tombstones)
    || !parsed.tombstones.every((t) => isJsonObject(t) && typeof t.key === "string" && typeof t.account === "string"
      && typeof t.record_id === "string" && typeof t.removed_at === "string" && (t.records === undefined || Array.isArray(t.records)))) return null;
  return parsed.tombstones as AccountTombstone[];
}

export function mergeAccountTombstones(active: string, sibling: string): string | null {
  const paths = [join(active, "account-tombstones.json"), join(sibling, "account-tombstones.json")];
  const read = paths.map(readTombstones);
  if (read[1] === null) return `Cannot read ${paths[1]}: account records are refused until it is restored or fixed.`;
  if (read[0] === null) return null;
  const pending = [active, sibling].flatMap((dir) => readTombstones(join(dir, "account-tombstones.pending.json")) ?? []);
  const merged = new Map<string, AccountTombstone>();
  for (const tombstone of [...read.flatMap((list) => list ?? []), ...pending]) {
    const kept = merged.get(tombstone.key);
    if (!kept) { merged.set(tombstone.key, tombstone); continue; }
    const local = (t: AccountTombstone) => t.record_id === "local";
    const winner = local(kept) && !local(tombstone) ? tombstone : !local(kept) && local(tombstone) ? kept : tombstone.removed_at > kept.removed_at ? tombstone : kept;
    const removedAt = tombstone.removed_at > kept.removed_at ? tombstone.removed_at : kept.removed_at;
    const records = local(winner) ? undefined : withRecords(winner.records, [...kept.records ?? [], ...tombstone.records ?? []]);
    const { records: _records, ...rest } = winner;
    merged.set(tombstone.key, { ...rest, removed_at: removedAt, ...(records ? { records } : {}) });
  }
  const tombstones = [...merged.values()];
  for (const [index, path] of paths.entries()) {
    if ((read[index] ?? []).length !== tombstones.length || tombstones.some((t) => !read[index]?.some((own) => own.key === t.key && own.removed_at === t.removed_at && own.record_id === t.record_id && JSON.stringify(own.records ?? []) === JSON.stringify(t.records ?? [])))) {
      writePrivateState(path, { v: 1, tombstones });
    }
  }
  return null;
}

function pairedHere(device: StoredDevice): boolean {
  return device.added_by === undefined && device.link_moved_key !== true;
}

export class DeviceStore {
  private devices: StoredDevice[] = [];
  private gateClosedAt: string | null = null;
  /**
   * `remote`: started through the relay, so it never lets a removed key back in; `startedBy`: the account
   * member that started it there, whose addition the new device then is; `holders`: the paired devices that
   * started it or were handed it, on any transport. It ends when one of them is revoked (`revoke`)
   */
  private pending: { code: string; expires: number; attempts: number; lanAttempts?: number; remote: boolean; startedBy: string | null; memberRequired: boolean; open?: boolean; noAccountOnly?: boolean; holders: Set<string> } | null = null;
  private codeIssues: number[] = [];
  private readonly relayFailures: Record<PairingFailurePath, { at: number[]; blockedUntil: number }> = {
    code: { at: [], blockedUntil: 0 }, account: { at: [], blockedUntil: 0 }, vouched: { at: [], blockedUntil: 0 }, lan: { at: [], blockedUntil: 0 },
  };
  private unconfirmedFirstPairs: UnconfirmedFirstPair[] = [];
  private readonly path: string;
  private readonly revocations = new Map<string, Set<() => void>>();
  private readonly relinks = new Map<string, Set<(sessionId: string) => void>>();
  private readonly revokeAllListeners = new Set<() => void>();
  private readonly gateListeners = new Set<() => void>();
  private readonly pairings = new Set<(event: DevicePairedEvent, origin: readonly string[]) => void>();
  private readonly codeStarts = new Set<() => void>();
  private readonly removals = new Set<(event: DeviceRemovedEvent) => void>();
  private readonly tombstonePath: string;
  private readonly pendingTombstonePath: string;
  private tombstones: AccountTombstone[] = [];
  readonly accountError: string | null = null;
  readonly error: string | null = null;

  constructor(stateDir: string, blocked: string | null = null, accountBlocked: string | null = null) {
    this.path = join(stateDir, "devices.json");
    this.tombstonePath = join(stateDir, "account-tombstones.json");
    this.pendingTombstonePath = join(stateDir, "account-tombstones.pending.json");
    const tombstones = readTombstones(this.tombstonePath);
    const pending = readTombstones(this.pendingTombstonePath) ?? [];
    if (accountBlocked !== null) this.accountError = accountBlocked;
    if (tombstones === null) {
      this.accountError = `Cannot read ${this.tombstonePath}: account records are refused until it is restored or fixed.`;
      this.tombstones = pending;
    } else this.tombstones = [...tombstones, ...pending.filter((t) => !tombstones.some((own) => own.key === t.key))];
    const read = readDeviceRegistry(this.path);
    if (read.kind === "ok") {
      this.gateClosedAt = read.gateClosedAt;
      this.devices = read.devices;
    } else if (read.kind === "bad") {
      this.error = `Cannot read ${this.path}. Restore a valid devices.json or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
      console.error(this.error);
    }
    if (blocked !== null && this.error === null) {
      this.error = blocked;
      console.error(this.error);
    }
    if (this.error === null && this.accountError === null) {
      if (pending.length) {
        this.writeTombstones(this.tombstones);
        rmSync(this.pendingTombstonePath, { force: true });
      }
      this.finishInterruptedWrites();
    }
  }

  private finishInterruptedWrites(): void {
    const tombstones = this.tombstones.filter((t) => !this.devices.some((d) => d.relay_public_key === t.key && !this.stale(d)));
    if (tombstones.length !== this.tombstones.length) {
      writePrivateState(this.tombstonePath, { v: 1, tombstones });
      this.tombstones = tombstones;
    }
    const devices = this.devices.filter((d) => !this.stale(d));
    if (devices.length !== this.devices.length) {
      const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
      this.save(devices, gate);
      this.devices = devices;
      this.gateClosedAt = gate;
    }
  }

  private stale(device: StoredDevice): boolean {
    return device.relay_public_key !== undefined
      && this.tombstones.some((t) => t.key === device.relay_public_key && (!pairedHere(device) || t.removed_at >= device.created_at));
  }

  /**
   * Whether the gate is closed to strangers: it is from the first pairing on, and stays so when
   * every device is revoked (revoking must never reopen the LAN); this PC itself always gets in.
   */
  get gated(): boolean {
    return this.error !== null || this.gateClosedAt !== null || this.devices.length > 0;
  }

  /**
   * Hears of the gate closing to strangers (`gated` turning true): the first device's cookie came back, or the
   * relay was turned on. Told once, right after the call that closed it (save). Whoever the open LAN let in has
   * no access from then on, and neither a later device nor a revoke opens the gate again. Never told of a gate
   * that is closed already: endWithGate.
   */
  onGateClosed(listener: () => void): () => void {
    this.gateListeners.add(listener);
    return () => { this.gateListeners.delete(listener); };
  }

  endWithGate(close: () => void): () => void {
    if (this.gated) { close(); return () => {}; }
    return this.onGateClosed(close);
  }

  closeGate(): void {
    this.assertWritable();
    if (this.gated) return;
    const gate = new Date().toISOString();
    this.save(this.devices, gate);
    this.gateClosedAt = gate;
    this.pending = null;
    this.unconfirmedFirstPairs = [];
  }

  onLinked(id: string, listener: (sessionId: string) => void): () => void {
    const listeners = this.relinks.get(id) ?? new Set<(sessionId: string) => void>();
    listeners.add(listener);
    this.relinks.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.relinks.delete(id);
    };
  }

  onRevoke(id: string, close: () => void): () => void {
    if (!this.devices.some((device) => device.id === id)) { close(); return () => {}; }
    const listeners = this.revocations.get(id) ?? new Set<() => void>();
    listeners.add(close);
    this.revocations.set(id, listeners);
    return () => {
      listeners.delete(close);
      if (listeners.size === 0) this.revocations.delete(id);
    };
  }

  onPaired(listener: (event: DevicePairedEvent, origin: readonly string[]) => void): () => void {
    this.pairings.add(listener);
    return () => { this.pairings.delete(listener); };
  }

  private announce(device: StoredDevice, enrolledAt: number, origin: readonly string[]): void {
    const approver = device.added_by === undefined ? undefined : this.devices.find((d) => d.id === device.added_by);
    const event: DevicePairedEvent = {
      type: "device-paired", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, enrolled_at: new Date(enrolledAt).toISOString(),
      ...(approver ? { approved_by: { device_id: approver.id, label: approver.label } } : {}),
    };
    for (const listener of this.pairings) listener(event, origin);
  }

  private assertWritable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  list(currentId: string | null, withAccounts = false): PairedDevice[] {
    return this.devices.map((d) => ({
      id: d.id, label: d.label, role: d.role, created_at: d.created_at, last_seen_at: d.last_seen_at, current: d.id === currentId,
      ...(d.relay_public_key === undefined ? {} : { via_relay: true as const }),
      ...(withAccounts && d.account !== undefined && d.relay_public_key !== undefined
        ? { account: d.account, account_key: d.relay_public_key, ...(d.added_by === undefined ? {} : { added_by: d.added_by }) } : {}),
    }));
  }

  onPairingStarted(listener: () => void): () => void {
    this.codeStarts.add(listener);
    return () => { this.codeStarts.delete(listener); };
  }

  activePairing(now = Date.now()): PairingCode | null {
    const pending = this.pending;
    if (pending === null || now > pending.expires || pending.attempts >= CODE_ATTEMPTS) return null;
    return { code: pending.code, expires_at: new Date(pending.expires).toISOString() };
  }

  startPairing(now = Date.now(), from: { remote: boolean; startedBy: string | null; memberRequired: boolean; open?: boolean; noAccountOnly?: boolean; by?: string | null } = { remote: false, startedBy: null, memberRequired: false }): PairingCode {
    this.assertWritable();
    const { by = null, ...how } = from;
    for (const id of [by, how.startedBy]) if (id !== null && !this.has(id)) throw new DeviceGoneError();
    this.pruneUnconfirmedFirstPairs(now);
    this.codeIssues = this.codeIssues.filter((at) => now - at < PAIRING_WINDOW_MS);
    if (this.codeIssues.length >= 10) throw new PairingRateLimitedError(Math.ceil(((this.codeIssues[0] ?? now) + PAIRING_WINDOW_MS - now) / 1000));
    this.codeIssues.push(now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending = { code, expires: now + CODE_TTL_MS, attempts: 0, ...how, holders: new Set([by, how.startedBy].filter((id): id is string => id !== null)) };
    const started = { code, expires_at: new Date(this.pending.expires).toISOString() };
    for (const listener of this.codeStarts) listener();
    return started;
  }

  /**
   * The code of the QR code that puts this PC in an account: a signed-in device that scans it links itself as the
   * PC's first member, with no approval here (the relay tab's QR code, POST /api/relay/offer with
   * `x-ovis-no-account-only`). So it is made only while the PC is in no account (PcInAccountError otherwise, and the
   * code pending stays as it was), and it ends when the PC joins one (endNoAccountCode). The code pending when that
   * was made the same way, else a fresh one: never a code another place started, which may be on a screen as digits.
   * `by` as in startPairing.
   */
  pairingForNoAccount(by: string | null = null, now = Date.now()): PairingCode {
    if (by !== null && !this.has(by)) throw new DeviceGoneError();
    if (this.account() !== null) throw new PcInAccountError();
    const active = this.activePairing(now);
    if (active !== null && this.pending?.noAccountOnly === true) {
      if (by !== null) this.pending.holders.add(by);
      return active;
    }
    return this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, noAccountOnly: true, by });
  }

  private endNoAccountCode(): void {
    if (this.pending?.noAccountOnly === true && this.account() !== null) this.endPairing();
  }

  holdPairing(id: string): void {
    if (!this.has(id)) throw new DeviceGoneError();
    this.pending?.holders.add(id);
  }

  endPairing(code?: string): boolean {
    if (code !== undefined && (this.pending === null || !same(code, this.pending.code))) return false;
    this.pending = null;
    for (const listener of this.codeStarts) listener();
    return true;
  }

  pair(code: string, label: string, role: DeviceRole, now = Date.now(), origin: readonly string[] = [], localCodeOnly = false): { token: string; device: DeviceMatch } | null {
    this.assertWritable();
    this.pruneUnconfirmedFirstPairs(now);
    // a code started through the relay is never redeemed on the LAN listener, nor are its guesses spent there:
    // it would make a credential no relay key or account removal reaches
    if (localCodeOnly && this.pending?.remote === true) return null;
    if (!this.checkPairingCode(code, now, localCodeOnly)) return null;
    const startedBy = this.pending?.startedBy ?? null;
    if (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy))) return null;
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = { id: randomBytes(8).toString("hex"), label, role, token_hash: hash(token), created_at: new Date(now).toISOString(), last_seen_at: null };
    if (!this.gated) {
      this.pending = null;
      this.unconfirmedFirstPairs.push({ device, expires: now + CODE_TTL_MS, origin });
      if (this.unconfirmedFirstPairs.length > UNCONFIRMED_FIRST_PAIR_LIMIT) this.unconfirmedFirstPairs.shift();
      return { token, device: { id: device.id, label: device.label, role: device.role } };
    }
    this.enroll(device, now, origin);
    return { token, device: { id: device.id, label: device.label, role: device.role } };
  }

  private checkPairingCode(code: string, now: number, lan = false): boolean {
    const pending = this.pending;
    if (pending === null || now > pending.expires) { this.pending = null; return false; }
    if (pending.noAccountOnly === true && this.account() !== null) { this.endPairing(); return false; }
    if (lan) {
      if ((pending.lanAttempts ?? 0) >= CODE_ATTEMPTS) return false;
      if (same(code.replace(/\D/g, ""), pending.code)) return true;
      pending.lanAttempts = (pending.lanAttempts ?? 0) + 1;
      return false;
    }
    if (!same(code.replace(/\D/g, ""), pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= CODE_ATTEMPTS) this.pending = null;
      return false;
    }
    return true;
  }

  private enroll(device: StoredDevice, now: number, origin: readonly string[], codeSpent = true): void {
    const next = [...this.devices, device];
    const gate = this.gateClosedAt ?? device.created_at;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    if (codeSpent) this.pending = null;
    if (device.account !== undefined) this.endNoAccountCode();
    if (device.relay_public_key !== undefined) this.unconfirmedFirstPairs = [];
    this.announce(device, now, origin);
  }

  pairRelay(code: string, label: string, publicKey: string, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    this.assertRelayPairing("code", now);
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.noteRelayFailure("code", now);
      return null;
    }
    const remote = this.pending?.remote ?? false;
    const startedBy = this.pending?.startedBy ?? null;
    // a code started through the relay is not a pairing made on this PC; a member's code goes with the member.
    // On a PC in no account such a code may bring back a key this PC revoked itself, as before account linking;
    // never one the account removed
    const accountless = this.account() === null;
    const refusedKey = accountless ? this.tombstones.some((t) => t.key === publicKey && t.record_id !== "local") : this.isTombstoned(publicKey);
    if ((remote && (this.accountError !== null || refusedKey)) || (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy)))) {
      this.noteRelayFailure("code", now);
      return null;
    }
    const undoesRevoke = remote && accountless && this.isTombstoned(publicKey);
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    const paired = this.enrollRelay(label, publicKey, now, true, undoesRevoke ? undefined : startedBy ?? undefined);
    if (!remote || accountless) this.clearTombstone(publicKey);
    return paired;
  }

  assertRelayPairing(path: PairingFailurePath = "code", now = Date.now()): void {
    this.assertWritable();
    const { blockedUntil } = this.relayFailures[path];
    if (now < blockedUntil) throw new PairingRateLimitedError(Math.ceil((blockedUntil - now) / 1000));
  }

  noteRelayFailure(path: PairingFailurePath = "code", now = Date.now()): void {
    const count = this.relayFailures[path];
    count.at = count.at.filter((at) => now - at < PAIRING_WINDOW_MS);
    count.at.push(now);
    if (count.at.length >= 20) count.blockedUntil = now + PAIRING_WINDOW_MS;
  }

  pairRelayApproved(label: string, publicKey: string, approval: { path: PairingPath; addedBy?: string; id?: string }, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    this.assertRelayPairing(approval.path, now);
    if (!isRelayPublicKey(publicKey)) { this.noteRelayFailure(approval.path, now); return null; }
    if (approval.addedBy !== undefined && !this.isAccountApprover(approval.addedBy)) { this.noteRelayFailure(approval.path, now); return null; }
    // only this PC lets a key removed through the account back in
    if (approval.addedBy !== undefined && (this.accountError !== null || this.isTombstoned(publicKey))) { this.noteRelayFailure(approval.path, now); return null; }
    if (approval.id !== undefined && this.has(approval.id)) { this.noteRelayFailure(approval.path, now); return null; }
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    const paired = this.enrollRelay(label, publicKey, now, false, approval.addedBy, approval.id);
    if (approval.addedBy === undefined) this.clearTombstone(publicKey);
    return paired;
  }

  /**
   * Whether a pairing with `key` makes a device new to this PC, which `admit` may refuse (pairRelay). A key a row
   * here already holds does not: a paired phone that opens the pairing QR again, or one that forgot this PC and pairs
   * again with the key its account gave it, is the device this PC knows, and refusing it would cut off someone the
   * limit never meant. The trade-off: PAIR does not prove the key, so someone holding a pairing that would succeed
   * (the owner's code, or digits the owner confirmed) who also names a paired device's public key gets the session
   * that pairing opens past the limit. They cannot sign in with it afterwards (AUTH needs the private key), so each
   * further session takes another pairing that succeeds; on a PC in no account a driving session may start that code
   * itself (devices routes, pair/start). It takes a client changed to name another device's key, on a limit a
   * changed PC could skip anyway.
   */
  private isNewKey(key: string): boolean { return !this.hasKey(key); }

  account(): string | null {
    return this.devices.find((d) => d.account !== undefined)?.account ?? null;
  }

  isMemberOf(id: string, account: string): boolean {
    return this.devices.some((d) => d.id === id && d.account === account && d.relay_public_key !== undefined);
  }

  /** A drive account member whose session signed in with the row's current key: a session left from an older key acts as no member. */
  isAccountApproverSession(id: string, sessionKey: string): boolean {
    return sessionKey !== "" && this.relayKeyOf(id) === sessionKey && this.isAccountApprover(id);
  }

  hasAccountApprover(): boolean { return this.devices.some((d) => this.isAccountApprover(d.id)); }

  isAccountApprover(id: string): boolean {
    const device = this.devices.find((d) => d.id === id);
    return device !== undefined && device.role === "drive" && device.account !== undefined && device.relay_public_key !== undefined && !this.stale(device);
  }

  private enrollRelay(label: string, publicKey: string, now: number, codeSpent: boolean, addedBy?: string, id = randomBytes(8).toString("hex")): { device: DeviceMatch } {
    const device: StoredDevice = {
      id, label: normalizeLabel(label, "Device"), role: "drive",
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: publicKey,
      created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
      ...(addedBy === undefined ? {} : { added_by: addedBy }),
    };
    this.enroll(device, now, [], codeSpent);
    return { device: { id: device.id, label: device.label, role: device.role } };
  }

  /** The transport owns a fresh 32-byte nonce per session and consumes AUTH only once. */
  async matchRelay(deviceId: string, nonce: Uint8Array, signature: string, serverId: string, now = Date.now()): Promise<DeviceMatch | null> {
    if (nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const signed = Buffer.from(signature, "base64url");
    if (signed.length !== 64 || signed.toString("base64url") !== signature) return null;
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key !== undefined);
    if (device?.relay_public_key === undefined || this.stale(device)) return null;
    const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
    try {
      const key = await crypto.subtle.importKey("spki", Buffer.from(device.relay_public_key, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signed, message);
      // Authorization changes during WebCrypto invalidate the proof; a rename does not.
      const current = this.devices.find((d) => d.id === deviceId);
      if (!verified || !current || current.role !== device.role || current.relay_public_key !== device.relay_public_key) return null;
      this.noteSeen(current, now);
      return { id: current.id, label: current.label, role: current.role };
    } catch (error) {
      if (error instanceof DOMException) return null;
      throw error;
    }
  }

  match(token: string | undefined, now = Date.now()): DeviceMatch | null {
    this.pruneUnconfirmedFirstPairs(now);
    if (!token) return null;
    const digest = hash(token);
    const candidateIndex = this.unconfirmedFirstPairs.findIndex(({ device }) => same(digest, device.token_hash));
    if (candidateIndex !== -1) {
      const { device: candidate, origin } = this.unconfirmedFirstPairs[candidateIndex]!;
      const confirmed = { ...candidate, last_seen_at: new Date(now).toISOString() };
      const next = [...this.devices, confirmed];
      const gate = this.gateClosedAt ?? confirmed.created_at;
      // This is an authorization write, not last-seen telemetry: do not match the cookie
      // unless the device and closed gate reached disk together.
      this.save(next, gate);
      this.devices = next;
      this.gateClosedAt = gate;
      this.unconfirmedFirstPairs = [];
      // So is a code the open LAN started: it admits whoever holds it, and until now anyone on the LAN could start
      // one. It ends with the gate, and whoever shows it is told (endPairing). A code this PC, its token or its owner's
      // login started stays: the request that brings the first cookie back may be the one that redeems it.
      if (this.pending?.open) this.endPairing();
      this.announce(confirmed, now, origin);
      return { id: confirmed.id, label: confirmed.label, role: confirmed.role };
    }
    for (const device of this.devices) {
      if (!same(digest, device.token_hash)) continue;
      this.noteSeen(device, now);
      return { id: device.id, label: device.label, role: device.role };
    }
    return null;
  }

  private noteSeen(device: StoredDevice, now: number): void {
    const seen = device.last_seen_at === null ? 0 : Date.parse(device.last_seen_at);
    if (this.error !== null || now - seen < LAST_SEEN_WRITE_MS) return;
    try {
      const next = this.devices.map((d) => d === device ? { ...d, last_seen_at: new Date(now).toISOString() } : d);
      // devices.json is also the authorization registry: a torn write here would lock every device out
      this.save(next);
      this.devices = next;
    } catch {}
  }

  update(id: string, patch: { label?: string; role?: DeviceRole }): PairedDevice | null {
    this.assertWritable();
    const device = this.devices.find((d) => d.id === id);
    if (!device) return null;
    const updated = { ...device, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.role === undefined ? {} : { role: patch.role }) };
    const next = this.devices.map((d) => d === device ? updated : d);
    this.save(next);
    this.devices = next;
    if (updated.role !== device.role) {
      const listeners = this.revocations.get(id);
      this.revocations.delete(id);
      for (const close of listeners ?? []) close();
    }
    return { id: updated.id, label: updated.label, role: updated.role, created_at: updated.created_at, last_seen_at: updated.last_seen_at, current: false, ...(updated.relay_public_key === undefined ? {} : { via_relay: true as const }) };
  }

  onRemoved(listener: (event: DeviceRemovedEvent) => void): () => void {
    this.removals.add(listener);
    return () => { this.removals.delete(listener); };
  }

  private announceRemoval(device: StoredDevice, by: DeviceRemovedEvent["by"]): void {
    const event: DeviceRemovedEvent = { type: "device-removed", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, removed_at: new Date().toISOString(), ...(by === undefined ? {} : { by }) };
    for (const listener of [...this.removals]) listener(event);
  }

  revoke(id: string, by: DeviceRemovedEvent["by"] = "pc"): boolean {
    this.assertWritable();
    const next = this.devices.filter((d) => d.id !== id);
    if (next.length === this.devices.length) return false;
    const gone = this.devices.find((d) => d.id === id);
    // a revoke on this PC wins over the account: its key cannot come back by a record (docs/account.md, rule 1)
    this.tombstone(this.devices.filter((d) => d.id === id), Date.now());
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    // A code the device started or was handed goes with it. Whoever it passed the code to would otherwise pair after
    // it was removed, on a PC in no account with nobody approving (a member's code already needs its member)
    if (this.pending?.holders.has(id)) this.endPairing();
    const listeners = this.revocations.get(id);
    this.revocations.delete(id);
    for (const close of listeners ?? []) close();
    if (gone) this.announceRemoval(gone, by);
    return true;
  }

  onRevokeAll(listener: () => void): () => void {
    this.revokeAllListeners.add(listener);
    return () => { this.revokeAllListeners.delete(listener); };
  }

  /**
   * Every paired device loses its access in one durable write, the caller's own included; the
   * ids it returns are for the cleanup that follows (push subscriptions, page media). The write
   * comes first and alone: until it succeeds nothing changes, and if it throws, the registry,
   * every credential and every listener stay as they were. After it, the pending code and every
   * unconfirmed first-pair credential are void as well, and every revoked device's streams close.
   * The gate stays closed, with a timestamp even when nothing was ever confirmed (only first-pair
   * candidates existed): revoking must never reopen the LAN, not even after a restart.
   */
  revokeAll(): string[] {
    this.assertWritable();
    this.tombstone(this.devices, Date.now());
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.save([], gate);
    const gone = this.devices;
    const revoked = this.devices.map((device) => device.id);
    this.devices = [];
    this.gateClosedAt = gate;
    this.pending = null;
    this.unconfirmedFirstPairs = [];
    const listeners = [...this.revocations.values()];
    this.revocations.clear();
    for (const closes of listeners) for (const close of closes) close();
    for (const listener of [...this.revokeAllListeners]) listener();
    for (const device of gone) this.announceRemoval(device, "pc");
    return revoked;
  }

  has(id: string): boolean { return this.devices.some((device) => device.id === id); }

  canDrive(id: string): boolean { return this.devices.some((device) => device.id === id && device.role === "drive"); }

  private pruneUnconfirmedFirstPairs(now: number): void {
    this.unconfirmedFirstPairs = this.unconfirmedFirstPairs.filter(({ expires }) => now <= expires);
  }

  private save(devices = this.devices, gateClosedAt = this.gateClosedAt): void {
    const closes = !this.gated && (gateClosedAt !== null || devices.length > 0);
    writePrivateState(this.path, { gate_closed_at: gateClosedAt, devices });
    if (closes) queueMicrotask(() => {
      for (const listener of [...this.gateListeners]) {
        try { listener(); } catch (error) { console.warn(`[devices] ending what the open LAN let in failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }

  accountSigner(key: string, account: string, anyRole = false): DeviceMatch | null {
    const device = this.devices.find((d) => d.relay_public_key === key && d.account === account && (anyRole || d.role === "drive") && !this.stale(d));
    return device ? { id: device.id, label: device.label, role: device.role } : null;
  }

  accountRows(): { members: number; unlinked: string[] } {
    return {
      members: this.devices.filter((d) => d.account !== undefined).length,
      unlinked: this.devices.filter((d) => d.account === undefined && d.relay_public_key !== undefined).map((d) => d.id),
    };
  }

  isTombstoned(key: string): boolean { return this.tombstones.some((t) => t.key === key); }

  tombstoneKeys(): string[] { return [...new Set(this.tombstones.map((t) => t.key))]; }

  accountAdds(): AddRecord[] {
    const account = this.account();
    return this.devices.flatMap((d) => {
      if (account === null || d.account_add === undefined || this.stale(d)) return [];
      try {
        const record = parseAccountRecord(d.account_add);
        return record.kind === "add" && record.key === d.relay_public_key && record.account === account ? [record] : [];
      } catch (error) {
        if (error instanceof AccountRecordError) return [];
        throw error;
      }
    });
  }

  keepAccountAdd(record: AddRecord, signerId: string): void {
    const device = this.devices.find((d) => d.relay_public_key === record.key && d.added_by === signerId && (d.account_add === undefined || (d.account_add as { key?: unknown }).key !== d.relay_public_key) && !this.stale(d));
    if (!device) return;
    const next = this.devices.map((d) => d === device ? { ...d, account_add: record } : d);
    this.save(next);
    this.devices = next;
  }

  accountRemovals(): RemoveRecord[] {
    const account = this.account();
    return this.tombstones.flatMap((t) => t.account !== account ? [] : (t.records ?? []).flatMap((value) => {
      try {
        const record = parseAccountRecord(value);
        return record.kind === "remove" && record.key === t.key && record.account === t.account ? [record] : [];
      } catch (error) {
        if (error instanceof AccountRecordError) return [];
        throw error;
      }
    }));
  }

  hasKey(key: string): boolean { return this.devices.some((d) => d.relay_public_key === key && !this.stale(d)); }

  acceptsRelayKey(key: string): boolean { return isRelayPublicKey(key); }

  wasAddedByMember(key: string): boolean { return this.devices.some((d) => d.relay_public_key === key && d.added_by !== undefined && !this.stale(d)); }

  keyHeldByOther(key: string, id: string): boolean { return this.devices.some((d) => d.relay_public_key === key && d.id !== id); }

  relayKeyOf(id: string): string | undefined { return this.devices.find((d) => d.id === id)?.relay_public_key; }

  addAccountDevice(entry: { id: string; key: string; label: string; role: DeviceRole; account: string; addedBy: string; record?: AddRecord }, now = Date.now()): DeviceMatch {
    this.assertAccountWritable();
    if (this.isTombstoned(entry.key)) throw new Error("tombstoned key");
    // an id another row holds would merge two devices' authority; a derived id collides only for the same key
    if (this.has(entry.id)) throw new Error("device id in use");
    const device: StoredDevice = {
      id: entry.id, label: normalizeLabel(entry.label, "Device"), role: entry.role,
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: entry.key,
      created_at: new Date(now).toISOString(), last_seen_at: null, account: entry.account, added_by: entry.addedBy,
      ...(entry.record === undefined ? {} : { account_add: entry.record }),
    };
    this.enroll(device, now, [], false);
    return { id: device.id, label: device.label, role: device.role };
  }

  removeAccountKey(key: string, account: string, record: { id: string; issuedAt: string; by?: { device_id: string; label: string }; signed?: RemoveRecord }, now = Date.now()): boolean {
    this.assertAccountWritable();
    // a pairing of this key made on this PC after the removal was signed wins: a replayed or late remove
    // leaves it be. Any other row goes, however late the remove arrives (pairedHere).
    if (this.devices.some((d) => d.relay_public_key === key && pairedHere(d) && d.created_at > record.issuedAt)) return false;
    const recordId = record.id;
    const fresh = !this.isTombstoned(key);
    const removal: AccountTombstone = { key, account, record_id: recordId, removed_at: new Date(now).toISOString(), ...(record.signed ? { records: [record.signed] } : {}) };
    const kept = this.tombstones.find((t) => t.key === key);
    if (fresh) this.writeTombstones([...this.tombstones, removal]);
    // a key this PC revoked first becomes the account's removal, so a code started through the relay cannot bring it back
    else if (kept?.record_id === "local") this.writeTombstones(this.tombstones.map((t) => t.key === key ? removal : t));
    else if (kept && record.signed && kept.account === account) {
      const records = withRecords(kept.records, [record.signed]);
      if ((records?.length ?? 0) !== (kept.records?.length ?? 0)) this.writeTombstones(this.tombstones.map((t) => t === kept ? { ...t, ...(records ? { records } : {}) } : t));
    }
    const ids = this.devices.filter((d) => d.relay_public_key === key).map((d) => d.id);
    for (const id of ids) this.revoke(id, record.by);
    return fresh || ids.length > 0;
  }

  linkAccountKey(deviceId: string, oldKey: string, key: string, account: string, sessionId = ""): PairedDevice | null {
    this.assertAccountWritable();
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key === oldKey);
    if (!device) return null;
    const moved = key !== oldKey || device.link_moved_key === true;
    const updated: StoredDevice = { ...device, relay_public_key: key, account, linked_at: new Date().toISOString(), link_moved_key: moved };
    const next = this.devices.map((d) => d === device ? updated : d);
    this.save(next);
    this.devices = next;
    this.endNoAccountCode();
    for (const listener of [...this.relinks.get(deviceId) ?? []]) listener(sessionId);
    return this.list(null).find((d) => d.id === deviceId) ?? null;
  }

  private clearTombstone(key: string): void {
    if (this.accountError !== null || !this.isTombstoned(key)) return;
    this.writeTombstones(this.tombstones.filter((t) => t.key !== key));
  }

  private tombstone(rows: readonly StoredDevice[], now: number): void {
    const keys = [...new Set(rows.flatMap((d) => d.relay_public_key === undefined || this.isTombstoned(d.relay_public_key) ? [] : [d.relay_public_key]))];
    const removedAt = new Date(now).toISOString();
    const next = [...this.tombstones,
      ...keys.map((key) => ({ key, account: rows.find((d) => d.relay_public_key === key)?.account ?? "", record_id: "local", removed_at: removedAt }))];
    if (!keys.length) return;
    if (this.accountError !== null) {
      writePrivateState(this.pendingTombstonePath, { v: 1, tombstones: next });
      this.tombstones = next;
    } else this.writeTombstones(next);
  }

  private writeTombstones(next: AccountTombstone[]): void {
    writePrivateState(this.tombstonePath, { v: 1, tombstones: next });
    this.tombstones = next;
  }

  private assertAccountWritable(): void {
    this.assertWritable();
    if (this.accountError !== null) throw new Error(this.accountError);
  }
}

export interface DeviceConnections {
  list(): Map<string, DeviceConnection>;
  check(timeoutMs: number): Promise<void>;
}

const CHECK_MS = 3_000;

/**
 * /api/devices*. Pairing itself is public, like /api/auth: it is how a device gets in. The
 * rest reaches here only through the gate in index.ts, and anything that changes the list
 * needs the app's own mutation guard (same origin + X-Herdr-Machine), like the other mutations.
 * `onRevoked` is told the id of every device a request revoked, once the registry says so: the
 * cleanup that follows (push subscriptions, page media) works from those ids, never from the path.
 */
export async function handleDeviceRequest(request: Request, pathname: string, store: DeviceStore, access: Access, relayKey: string | null, onRevoked?: (ids: string[]) => void, lanHttps = false, connections?: DeviceConnections): Promise<Response> {
  if (store.error !== null) return jsonResponse({ error: { code: "device_store_unavailable", message: access.level === "full" ? store.error : "Device pairing is unavailable; ask the owner to check Settings → Devices on the host." } }, 503);
  const json = async (): Promise<Record<string, unknown> | Response> => {
    try {
      const body = (await request.json()) as unknown;
      return isJsonObject(body) ? body : badRequest("invalid_body", "request body must be a JSON object");
    } catch { return badRequest("invalid_json", "request body must be JSON"); }
  };
  if (pathname === "/api/devices/pair") {
    setRequestRoute(pathname);
    if (access.level === "full" && access.via === "relay") return jsonResponse({ error: { code: "device_key_required", message: "Pair relay devices through the encrypted channel" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await json();
    if (body instanceof Response) return body;
    if (typeof body["code"] !== "string") return badRequest("missing_code", "code is required");
    if (lanHttps) {
      try { store.assertRelayPairing("lan"); } catch (error) {
        if (error instanceof PairingRateLimitedError) return jsonResponse({ error: { code: error.code, message: error.message } }, 429, { "retry-after": String(error.retryAfter), "cache-control": "no-store" });
        throw error;
      }
    }
    const firstPair = !store.gated;
    const paired = store.pair(body["code"], normalizeLabel(body["label"], "Device"), "drive", Date.now(), streamKeys(request), lanHttps);
    if (paired === null) {
      if (lanHttps) store.noteRelayFailure("lan");
      return jsonResponse({ error: { code: "invalid_code", message: "the code is wrong, spent or expired; start a new pairing on the PC" } }, 401);
    }
    const cookies = [deviceCookie(paired.token, isSecureRequest(request)), CLEAR_LEGACY_DEVICE_COOKIE];
    if (!acceptsJson(request)) return noContent(...cookies);
    // a script asked for the token itself, to send as `Authorization: Device <token>` (#2744); a
    // browser never asks, so its page never reads the credential its HttpOnly cookie keeps. A first
    // pairing waits in memory for its cookie to come back; a script may store the token and use it
    // after a restart, so its pairing is confirmed (written, gate closed) before the answer
    if (firstPair) store.match(paired.token);
    const answer = jsonResponse({ token: paired.token } satisfies DevicePairToken, 200, { "cache-control": "no-store" });
    for (const cookie of cookies) answer.headers.append("set-cookie", cookie);
    return answer;
  }
  if (pathname === "/api/devices") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const drive = access.level === "full" && access.role === "drive";
    const manager = drive && access.via !== "portal";
    if (manager && connections && new URL(request.url).searchParams.get("check") === "1") await connections.check(CHECK_MS);
    const live = manager ? connections?.list() ?? new Map<string, DeviceConnection>() : new Map<string, DeviceConnection>();
    const devices = store.list(access.level === "full" ? access.device?.id ?? null : null, drive)
      .map((device) => { const connection = live.get(device.id); return connection ? { ...device, connection } : device; });
    return jsonResponse({ devices }, 200, { "cache-control": "no-store" });
  }
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_origin", message: "Manage devices from this app" } }, 403);
  if (access.level === "full" && access.role === "watch") return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  if (pathname === "/api/devices/pair/start") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "Start a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    try {
      const remote = access.level === "full" && access.via === "relay";
      const startedBy = remote ? access.device?.id ?? null : null;
      const by = access.level === "full" ? access.device?.id ?? null : null;
      const open = access.level === "full" && access.via === "open";
      return jsonResponse(store.startPairing(Date.now(), { remote, startedBy, memberRequired: remote && store.account() !== null, by, ...(open ? { open } : {}) }), 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof PairingRateLimitedError) return jsonResponse({ error: { code: error.code, message: error.message } }, 429, { "retry-after": String(error.retryAfter), "cache-control": "no-store" });
      if (error instanceof DeviceGoneError) return jsonResponse({ error: { code: error.code, message: error.message } }, 401, { "cache-control": "no-store" });
      throw error;
    }
  }
  if (pathname === "/api/devices/pair/cancel") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "End a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    const text = await request.text();
    let body: unknown = {};
    try { if (text.trim() !== "") body = JSON.parse(text); } catch { return badRequest("invalid_json", "request body must be JSON"); }
    const code = isJsonObject(body) ? body["code"] : undefined;
    if (!isJsonObject(body) || (code !== undefined && (typeof code !== "string" || !/^\d{6}$/.test(code)))) return badRequest("invalid_body", "code must be the six-digit pairing code");
    return jsonResponse({ ok: true, cancelled: store.endPairing(code) }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/api/devices/revoke-all") {
    setRequestRoute("/api/devices/revoke-all");
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const revoked = store.revokeAll();
    onRevoked?.(revoked);
    const answer = jsonResponse({ revoked: revoked.length } satisfies DevicesRevokedAll, 200, { "cache-control": "no-store" });
    answer.headers.append("set-cookie", DEVICE_COOKIE_CLEARED);
    answer.headers.append("set-cookie", CLEAR_LEGACY_DEVICE_COOKIE);
    return answer;
  }
  const id = pathname.slice("/api/devices/".length);
  setRequestRoute("/api/devices/:device_id");
  if (!/^[0-9a-f]{16}$/.test(id)) return badRequest("invalid_device", "no such device");
  if (request.method === "DELETE") {
    const unless = request.headers.get("x-ovis-unless-account");
    if (unless !== null && store.isMemberOf(id, unless)) return jsonResponse({ error: { code: "account_member", message: "that device is a member of the account by now" } }, 409);
    if (!store.revoke(id, access.level === "full" && access.device ? { device_id: access.device.id, label: access.device.label } : "pc")) return jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
    onRevoked?.([id]);
    return noContent();
  }
  if (request.method === "PATCH") {
    const body = await json();
    if (body instanceof Response) return body;
    const updated = store.update(id, { label: normalizeLabel(body["label"], "Device") });
    return updated ? jsonResponse(updated) : jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
  }
  return badRequest("method_not_allowed", "use PATCH or DELETE");
}
