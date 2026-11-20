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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isRowOrigin, legacyOrigin, type RowOrigin } from "./account/admission-order.ts";
import { type ClearReason, PcAccountState } from "./account/pc-binding.ts";
import type { RemovalEvidence } from "./account/removal-evidence.ts";
import type { DeviceJournal, JournalEntry } from "./account/device-journal.ts";
import type { DeviceNotice, NoticeReplay } from "../shared/account-devices-api.ts";
import { AccountRecordError, isIsoTime, parseAccountRecord, type AddRecord, type RemoveRecord } from "../shared/account-records.ts";
import { type AccountPairing, type AccountPairingEnd, type AccountPairingState, type AccountPairingTurnedAway, type DevicePairedEvent, type DeviceRemovedEvent, type DevicePairToken, type DeviceRole, type DevicesRevokedAll, type PairedDevice, type DeviceConnection, STREAM_COOKIE_PREFIX } from "../shared/protocol.ts";
import type { MuxClock } from "../shared/relay-mux-engine.ts";
import type { Access } from "./access.ts";
import { CLEAR_LEGACY_DEVICE_COOKIE, COOKIE_MAX_AGE_SECONDS, DEVICE_COOKIE_CLEARED, deviceCookie, isSecureRequest, noContent, parseCookies } from "./auth.ts";
import { badRequest, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import { privateStateRefusal, writePrivateState } from "./private-state.ts";

/** How long a pairing code pairs new devices. */
export const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const LAST_SEEN_WRITE_MS = 60_000;
const UNCONFIRMED_FIRST_PAIR_LIMIT = 8;
const LABEL_MAX = 48;
const PAIRING_WINDOW_MS = 10 * 60_000;
/** A device that paired with a code made for a PC in no account has this long to link itself into an account. */
export const PAIRING_LINK_MS = 30_000;
/** The pairings one such code takes: each makes a row that waits to link, and nothing gives one back. */
export const PAIRING_USES = 5;
/** The links one waiting row may send; the next turns it away. */
const WAITING_LINKS = 5;
/** Codes made for an account that ended, kept for a read of how they ended (accountPairingState): the latest ones. */
const ENDED_ACCOUNT_CODES = 8;

/** A clock that only moves forward, never the PC's wall clock: what a waiting row's time is counted on (DeviceStore.useClock). */
const MONOTONIC: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    // a bound that is still running never keeps a stopping server alive
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export class PairingRateLimitedError extends Error {
  readonly code = "pairing_rate_limited";
  constructor(readonly retryAfter: number) {
    super("Too many pairing attempts; try again later");
  }
}

/**
 * The paired device a request came from is paired no more: it was revoked while the request was on its way (a relay
 * round trip, a look-up of who asks). It gets no pairing code: a code held by a device that is already gone is one
 * no revoke ends.
 */
export class DeviceGoneError extends Error {
  readonly code = "unauthorized";
  constructor() {
    super("this device is no longer paired");
  }
}

/**
 * The paired device a request came from may only watch by now: it was made one while the request was on its way (a
 * relay round trip). It gets no pairing code either: holding one is a driver's right.
 */
export class DeviceReadOnlyError extends Error {
  readonly code = "read_only";
  constructor() {
    super("this device can only watch");
  }
}

/**
 * This PC is in an account, so no code is made that would put it in one (DeviceStore.pairingForNoAccount): a device
 * joins a PC that has members by signing in to their account, with a member's approval (docs/account.md).
 */
export class PcInAccountError extends Error {
  readonly code = "in_account";
  constructor() {
    super("This PC is already in an Ovis account. Sign in to that account on the device to add it.");
  }
}

/**
 * An offer named the code it is to carry by its id (`x-ovis-pairing`), and that code is no longer the one pending, or
 * not one the offer can carry: no code is started, and the one pending stays as it was (pairingForAccount).
 */
export class PairingGoneError extends Error {
  readonly code = "pairing_gone";
  constructor() {
    super("The code this offer names is no longer the one pending on this PC; no new code was made.");
  }
}

/**
 * The relay tab's code is past its ten minutes while a device that paired with it in time may still link: no new code
 * is made, since one would end that device's pairing. `retryAfter`: the seconds until the last such device's time to
 * link is over.
 */
export class PairingFinishingError extends Error {
  readonly code = "pairing_finishing";
  constructor(readonly retryAfter: number) {
    super("A device that paired with this PC's code is still linking; a new code follows once it is done.");
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
  /** the account member on this PC that approved it from another device; absent when this PC or a code admitted it */
  added_by?: string;
  linked_at?: string;
  /**
   * whether a `link` gave the row a key other than the one it was paired with here; false when every link kept
   * the paired key (the usual link, which only joins the account). Absent on a row never linked, and on one linked
   * before this was recorded: that one counts as kept, as it did then.
   */
  link_moved_key?: boolean;
  /** the signed `add` that let this row in, as received: /api/account/status lists it for a client to hand on */
  account_add?: unknown;
  /**
   * the account whose member approved the pairing that made the row, as it stood then: a remote approval, or a code a
   * member started (and still was a member of that account when the code was used); `added_by` names that member.
   * Absent when `added_by` names a starter that was no member then, and on every other row. Only a link into this same
   * account counts as the member's (linkAccountKey): any other is on the device's own word.
   */
  member_approved_in?: string;
  /**
   * how a `link` made the row a member (docs/account.md, "How a device joined"): set once, by the link that took it from
   * no account into one, and kept by every later link. Absent on a row that became a member before this was recorded,
   * and on one an account member's signature (`add`) or approval (`member_approved_in`, for that account) stands behind. A value this PC does
   * not know is kept as it is and counts as `word`.
   */
  joined_by?: JoinedBy;
  /** where this PC admitted the row from, and its place in this PC's own order (server/account/admission-order.ts) */
  origin?: RowOrigin;
  /** a copy a sibling merge brought into this dir with the release flag on: no row of this dir's own, never legacy (T50) */
  imported?: true;
  /** the account removals of its key that its pairing on this PC knew, and stands over (P13) */
  paired_over?: string[];
}

/**
 * `code`: the row paired with a code made for a PC in no account and linked into the account that code held it to, on
 * a PC from before such a link needed the account's word; `service`: such a code was alive and the account service
 * vouched for the key the row took (records.ts applyLink);
 * `word`: any other link, on the device's own word.
 */
export type JoinedBy = "code" | "service" | "word";
/** The marks of a member something other than the device itself vouched for: every other mark is its own word. */
export const VOUCHED: ReadonlySet<unknown> = new Set<JoinedBy>(["code", "service"]);

/**
 * The three ways relay pairing failures are counted (docs/account.md, "Who may admit a device"): codes
 * and comparisons for this PC alone, comparisons asking to join the account, and another PC of the
 * account vouched for, so a flood of one kind cannot pause the others.
 */
export type PairingPath = "code" | "account" | "vouched";
/** The relay's paths, and codes typed on the LAN HTTPS listener (server/lan-https.ts), counted apart so LAN guessing cannot pause relay pairing. */
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

/** Malformed names or values are ignored, never refused. */
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
  /**
   * Set by the relay session on one request, never kept: the row waited to link when that request began
   * (server/relay/session.ts), so the request is one of its two calls.
   */
  provisional?: true;
}

/** What stood when a link arrived (DeviceStore.linkArrived): its checks are held to it. */
export interface LinkArrival {
  /** whether the row had paired with a code made for a PC in no account and not linked */
  readonly provisional: boolean;
  /**
   * the code made for a PC in no account that was alive (DeviceStore.pinnedCode), or null: while one is, every link
   * is held to its account and needs the account service's word. Compared only with what is alive later
   */
  readonly pinned: object | null;
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

/**
 * `placeholder`: written only to close the gate where there was no registry (state-merge.ts); it says
 * nothing about which devices were revoked. The store's next save drops the mark.
 */
export type DeviceRegistry = { kind: "missing" } | { kind: "ok"; gateClosedAt: string | null; devices: StoredDevice[]; placeholder: boolean } | { kind: "bad" };

export function readDeviceRegistry(path: string): DeviceRegistry {
  // one another account could write is as unreadable as a damaged one: the gate stays closed
  const refused = privateStateRefusal(path);
  if (refused !== null) {
    console.error(`devices.json is not trusted: ${refused}`);
    return { kind: "bad" };
  }
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
      && (d.imported === undefined || d.imported === true)
      && (d.account_add === undefined || isJsonObject(d.account_add))
      && (d.paired_over === undefined || (Array.isArray(d.paired_over) && d.paired_over.every((id) => typeof id === "string")))
      )) return { kind: "bad" };
  // an origin that cannot be read is no age (P22): the row stays, without it
  const devices = (parsed.devices as StoredDevice[]).map((d) => d.origin === undefined || isRowOrigin(d.origin) ? d : (({ origin: _unreadable, ...rest }) => rest)(d));
  return { kind: "ok", gateClosedAt: parsed.gate_closed_at, devices, placeholder: parsed.placeholder === true && parsed.devices.length === 0 };
}

/**
 * A key removed through the account, kept in `account-tombstones.json` beside devices.json; `records`
 * are the signed `remove`s that removed it, as received, one per signer (at most
 * TOMBSTONE_RECORDS_MAX), which a client relays to a PC it enrolls (#2956).
 */
export interface AccountTombstone { key: string; account: string; record_id: string; removed_at: string; records?: unknown[] }

/** Signed removals kept per tombstone: one per signer, so a PC where only a later signer is a member can still apply one. */
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

/** Every tombstone a folder holds, its pending file's included, as read before any merge coalesces them (T48). */
export function folderTombstones(dir: string): AccountTombstone[] {
  return ["account-tombstones.json", "account-tombstones.pending.json"].flatMap((file) => readTombstones(join(dir, file)) ?? []);
}

/** Null for a file that exists and will not parse; an absent file holds no tombstones. */
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

/**
 * The tombstones of two state dirs that share one device registry (state-merge.ts), written to both:
 * a key removed in either stays removed in both. Per key the later removal is kept. A file that will
 * not parse is left as it is, and the store then refuses account records there.
 */
export function mergeAccountTombstones(active: string, sibling: string, opensAll = false): string | null {
  // with the flag on every local time met isIsoTime; with it off, main's own string order
  const after = (a: string, b: string) => opensAll ? Date.parse(a) > Date.parse(b) : a > b;
  const paths = [join(active, "account-tombstones.json"), join(sibling, "account-tombstones.json")];
  const read = paths.map(readTombstones);
  // the active dir's own unreadable file stops its store anyway; a sibling's must too, or its removals are lost
  if (read[1] === null) return `Cannot read ${paths[1]}: account records are refused until it is restored or fixed.`;
  if (read[0] === null) return null;
  const pending = [active, sibling].flatMap((dir) => readTombstones(join(dir, "account-tombstones.pending.json")) ?? []);
  const merged = new Map<string, AccountTombstone>();
  for (const tombstone of [...read.flatMap((list) => list ?? []), ...pending]) {
    const kept = merged.get(tombstone.key);
    if (!kept) { merged.set(tombstone.key, tombstone); continue; }
    // the account's removal outranks a revoke on the PC (only it keeps a relay code out), with the later of the two times
    const local = (t: AccountTombstone) => t.record_id === "local";
    const winner = local(kept) && !local(tombstone) ? tombstone : !local(kept) && local(tombstone) ? kept : after(tombstone.removed_at, kept.removed_at) ? tombstone : kept;
    const removedAt = after(tombstone.removed_at, kept.removed_at) ? tombstone.removed_at : kept.removed_at;
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

/**
 * A device that paired with a code made for a PC in no account and has not linked: in memory only, never in
 * devices.json, and shown to its own relay session alone (DeviceStore.sessionRow).
 */
interface ProvisionalRow {
  readonly id: string;
  readonly label: string;
  /** the key its PAIR named; only an AUTH proves it */
  readonly key: string;
  /** on the store's clock */
  readonly pairedAt: number;
  /** the links it sent */
  links: number;
  /** what its last link is waiting for, or got: the account service's word, or no answer from it */
  link?: "asked" | "service_unreachable";
  readonly cancel: () => void;
}

/** What a code made for a PC in no account holds besides its six digits: the pairings it still takes, and the rows that wait to link. */
interface WaitingRows {
  usesLeft: number;
  readonly rows: Map<string, ProvisionalRow>;
  /** set while the link of one of its rows is written (promote): the device the code's end names */
  joined?: { readonly device_id: string; readonly label: string };
  /** every row of this code that went without becoming a member, oldest first */
  readonly turnedAway: AccountPairingTurnedAway[];
}

/**
 * Whether the row is a pairing of its current key made on this PC (a code, or a comparison approved here): not a
 * row an account record or a remote approval made (`added_by`), and not one a `link` moved onto the key from the
 * key it was paired with, which never paired this key here. A link that kept the paired key changes nothing.
 */
function pairedHere(device: StoredDevice): boolean {
  return device.added_by === undefined && device.link_moved_key !== true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a thrown value says, for a log line; a value that cannot be told says so. */
function describe(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); } catch { return "an error that cannot be described"; }
}

export class DeviceStore {
  private devices: StoredDevice[] = [];
  /** when the first device was paired: from then on, only this PC, the owner's login, a device or the token get in */
  private gateClosedAt: string | null = null;
  /**
   * `remote`: started through the relay, so it never lets a removed key back in; `startedBy`: the account
   * member that started it there, whose addition the new device then is; `holders`: the paired devices that
   * started it or were handed it, on any transport. It ends when one of them is revoked (`revoke`)
   */
  /**
   * `open`: started by a request the open LAN alone let in (access.ts `via: "open"`), so it ends when the gate closes;
   * `noAccountOnly`: made to put this PC in an account (pairingForNoAccount), so it ends when the PC is in one;
   * `waiting`: what such a code holds, the devices that paired with it through the relay and have not linked;
   * `id`: names the code to a caller that ends or reads it (endPairing, accountPairingState);
   * `named`: such a code made for one account (startAccountPairing), whose waiting devices are taken into it alone;
   * `expires`: the wall-clock end of its ten minutes, which its `expires_at` shows; `deadline`: the same end on the
   * store's clock, which only moves forward; `over`: set the first time either says its ten minutes are over (codeOver)
   */
  private pending: { code: string; id: string; expires: number; deadline: number; over?: true; attempts: number; lanAttempts?: number; remote: boolean; startedBy: string | null; approvedIn?: string; memberRequired: boolean; open?: boolean; noAccountOnly?: boolean; holders: Set<string>; waiting?: WaitingRows; named?: { readonly account: string }; issuedUnder?: string } | null = null;
  /** How the latest codes made for an account ended, newest last: ENDED_ACCOUNT_CODES at most, in memory only. */
  private endedAccountCodes: Extract<AccountPairingState, { state: "ended" }>[] = [];
  /** What a row that waits to link, and the redemption of a code, is bounded on (useClock). */
  private clock: MuxClock = MONOTONIC;
  private codeIssues: number[] = [];
  private readonly relayFailures: Record<PairingFailurePath, { at: number[]; blockedUntil: number }> = {
    code: { at: [], blockedUntil: 0 }, account: { at: [], blockedUntil: 0 }, vouched: { at: [], blockedUntil: 0 }, lan: { at: [], blockedUntil: 0 },
  };
  /** First-pair cookies are not devices, and do not close the gate, until one returns. */
  private unconfirmedFirstPairs: UnconfirmedFirstPair[] = [];
  private readonly path: string;
  private readonly revocations = new Map<string, Set<(waiting?: true) => void>>();
  private readonly relinks = new Map<string, Set<(sessionId: string) => void>>();
  private readonly revokeAllListeners = new Set<() => void>();
  private readonly gateListeners = new Set<() => void>();
  private readonly pairings = new Set<(event: DevicePairedEvent, origin: readonly string[]) => void>();
  private readonly codeStarts = new Set<() => void>();
  private readonly removals = new Set<(event: DeviceRemovedEvent) => void>();
  private readonly tombstonePath: string;
  private readonly pendingTombstonePath: string;
  /** Keys removed through the account (docs/account.md, rule 5); only a pairing on this PC clears one. */
  private tombstones: AccountTombstone[] = [];
  /** Why account records cannot be applied: a tombstone file that will not parse is not an empty one. */
  private accountProblem: string | null = null;
  readonly error: string | null = null;

  /**
   * `blocked`: why the registry may lack devices that must stay paired (state-merge.ts could not
   * take over the other state dir's): the store then stays gated and changes nothing, as for a
   * damaged registry, while the devices it holds still get in.
   */
  /** `accountBlocked`: why account records cannot be trusted here (a sibling dir's tombstones that could not be merged). */
  /**
   * `account`: the account-opens-all state, with OVIS_ACCOUNT_OPENS_ALL on. `safety`, the safety log
   * (server/account/safety-log.ts), and `pc`, this PC's account state (server/account/pc-binding.ts): while either
   * fails closed no device signs in or pairs and account records are refused, so only this PC itself gets in. With
   * `pc`, every row admitted gets its origin and the PC's account is its binding, not its rows.
   */
  private readonly safety: { readonly strict: string | null } | null;
  private readonly pc: PcAccountState | null;
  private readonly evidence: RemovalEvidence | null;
  /** every tombstone of this folder and its sibling as read before any coalescing merge (T48): each is evidence */
  private readonly carried: readonly AccountTombstone[];
  private readonly journal: DeviceJournal | null;
  private readonly noticeListeners = new Set<(entry: JournalEntry) => void>();
  /** A deny that could not reach the disk (P8 step 1): only this PC itself gets in until one is written. */
  private denyProblem: string | null = null;
  private readonly revokeAllPath: string;
  private readonly stateDirPath: string;

  constructor(stateDir: string, blocked: string | null = null, accountBlocked: string | null = null, account: { safety?: { readonly strict: string | null } | null; pc?: PcAccountState | null; removals?: RemovalEvidence | null; journal?: DeviceJournal | null; carried?: readonly AccountTombstone[] } = {}) {
    this.safety = account.safety ?? null;
    this.pc = account.pc ?? null;
    this.stateDirPath = stateDir;
    this.evidence = account.removals ?? null;
    // removal evidence this PC wrote once and that is gone now is damage, never a fresh start (S19)
    if (this.evidence !== null && this.pc?.evidenceWritten() === true) this.evidence.missingAfterWritten();
    this.carried = account.carried ?? [];
    this.journal = account.journal ?? null;
    this.path = join(stateDir, "devices.json");
    this.tombstonePath = join(stateDir, "account-tombstones.json");
    this.pendingTombstonePath = join(stateDir, "account-tombstones.pending.json");
    this.revokeAllPath = join(stateDir, "revoke-all.json");
    const tombstones = readTombstones(this.tombstonePath);
    const pendingRead = readTombstones(this.pendingTombstonePath);
    const pending = pendingRead ?? [];
    if (accountBlocked !== null) this.accountProblem = accountBlocked;
    // a pending tombstone file that cannot be read holds Revokes nobody can tell: kept, and the PC refuses (S19)
    if (pendingRead === null && this.evidence !== null) this.accountProblem = `Cannot read ${this.pendingTombstonePath}: account records are refused until it is restored or fixed.`;
    if (tombstones === null) {
      this.accountProblem = `Cannot read ${this.tombstonePath}: account records are refused until it is restored or fixed.`;
      this.tombstones = pending;
    } else this.tombstones = [...tombstones, ...pending.filter((t) => !tombstones.some((own) => own.key === t.key))];
    const read = readDeviceRegistry(this.path);
    if (read.kind === "ok") {
      this.gateClosedAt = read.gateClosedAt;
      this.devices = read.devices;
    } else if (read.kind === "bad") {
      // A damaged registry is not a first installation. Keep it intact for recovery and
      // let the existing local/token/Tailscale routes provide access to the owner.
      this.error = `Cannot read ${this.path}. Restore a valid devices.json or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
      console.error(this.error);
    }
    if (blocked !== null && this.error === null) {
      this.error = blocked;
      console.error(this.error);
    }
    // the tombstone files' own repair asks only whether they could be read: a strict safety log is a separate refusal
    // a Revoke all that stopped half way is finished before anything is served, whatever else could not be read (P8, T41)
    if (this.error === null && this.evidence !== null && existsSync(this.revokeAllPath)) {
      const gate = this.gateClosedAt ?? new Date().toISOString();
      // a deny recovered at start raises the generation, as the live path does (P8, T41)
      try { this.pc?.raiseGen(); this.finishRevokeAll(this.revokeAllRows(), gate); } catch (error) {
        // what could not be finished on disk is finished in memory, and the PC fails closed until a start finishes it
        this.devices = [];
        this.gateClosedAt = gate;
        this.denyProblem = `Revoke all could not be finished (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until it is.`;
      }
    }
    // a strict order changes nothing else on disk, not even a repair: its damage stays visible (S29)
    // a damaged pending file beside a readable tombstone file: the Revokes the readable one holds are evidence at once,
    // and neither file is touched until the damaged one is repaired (T26, S19)
    if (this.error === null && this.evidence !== null && this.evidence.strict === null && this.safety?.strict == null && this.pc?.strict == null && pendingRead === null && tombstones !== null) {
      this.evidence.takeIn([...this.carried, ...tombstones], this.devices.map((d) => ({ relay_public_key: d.relay_public_key, created_at: d.created_at, pairedHere: pairedHere(d) })), Date.now());
    }
    // a time this PC wrote that lies more than a day ahead is no time it wrote: it would push every later stamp past it,
    // so the PC fails closed until it is repaired (S19, P13)
    if (this.evidence !== null) {
      const ahead = [...this.ownTimes(), ...this.carried.filter((t) => t.record_id === "local").map((t) => t.removed_at)].find((t) => !isIsoTime(t) || Date.parse(t) > Date.now() + DAY_MS);
      if (ahead !== undefined) this.accountProblem = `A time this PC wrote lies in the future (${ahead}): account records are refused until it is repaired.`;
    }
    if (this.error === null && this.accountProblem === null && this.pc?.strict == null) {
      if (this.evidence !== null) {
        this.takeInEvidence([...tombstones ?? [], ...pending]);
      } else {
        if (pending.length) {
          this.writeTombstones(this.tombstones);
          rmSync(this.pendingTombstonePath, { force: true });
        }
        this.finishInterruptedWrites();
      }
    }
    // the one-time legacy pass asks only whether the registry could be read: nothing is admitted before it (T50)
    if (this.error === null) this.migrate();
    // evidence on disk at start counts as written, also for a PC that wrote it before this mark existed (S19)
    if (this.error === null && this.evidence?.onDisk === true && this.evidence.strict === null) this.pc?.noteEvidenceWritten();
  }

  /**
   * At load (T26, P13): every tombstone of both files, the pending one's included, is taken in as evidence before
   * anything is coalesced; the tombstone file is written again from the evidence; the pending file goes; and every row
   * the evidence covers goes. Nothing of it is told to anyone: no session is open yet.
   */
  private takeInEvidence(found: readonly AccountTombstone[]): void {
    // evidence that cannot be trusted is never written over, and nothing is taken in while the safety log cannot be
    // read: a removal would record no forgettings it outranks, and an old forget redelivered later would end it (S19, T61)
    if (this.evidence!.strict !== null || this.safety?.strict != null) return;
    this.evidence!.takeIn([...this.carried, ...found], this.devices.map((d) => ({ relay_public_key: d.relay_public_key, created_at: d.created_at, pairedHere: pairedHere(d) })), Date.now());
    // the tombstone file is written from the evidence before the pending file goes, so nothing pending is lost (T26)
    this.writeTombstones(this.evidence!.tombstones());
    rmSync(this.pendingTombstonePath, { force: true });
    const kept = this.devices.filter((d) => !this.coveredByEvidence(d));
    if (kept.length !== this.devices.length) {
      // a deny recovered at start raises the generation, as the live path does (P8, T41)
      this.pc?.raiseGen();
      const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
      this.save(kept, gate);
      this.devices = kept;
      this.gateClosedAt = gate;
    }
  }

  /**
   * The store's one sequence of times (T26, P13): never before `now`, and always after every time this store has
   * ordered (a row's making, a Revoke, an unrevoke, a tombstone), so what is made after something is always later.
   */
  /**
   * Whether time `a` is after (or with `orSame`, not before) time `b`. With the flag on both are parsed, as every time
   * met isIsoTime at open; with it off, main's own string order, whatever the files hold.
   */
  private later(a: string, b: string, orSame = false): boolean {
    if (this.evidence === null) return orSame ? a >= b : a > b;
    return orSame ? Date.parse(a) >= Date.parse(b) : Date.parse(a) > Date.parse(b);
  }

  /** The times this PC wrote itself: rows' making, its own tombstones and Revokes; never a time a record carries (P13). */
  private ownTimes(): string[] {
    return [...this.devices.map((d) => d.created_at), ...this.tombstones.filter((t) => t.record_id === "local").map((t) => t.removed_at), ...this.evidence?.times() ?? []];
  }

  private nextStamp(now: number): string {
    const times = this.ownTimes();
    const last = Math.max(Number.NEGATIVE_INFINITY, ...times.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t)));
    return new Date(Math.max(now, last + 1)).toISOString();
  }

  /** The tombstone file as the evidence writes it (P13), written only when it changed. */
  private refreshTombstones(): void {
    const next = this.evidence!.tombstones();
    if (JSON.stringify(next) !== JSON.stringify(this.tombstones)) this.writeTombstones(next);
  }

  /**
   * Whether the evidence keeps this row out (P13): a Revoke of its key stands, or a standing marker of its key covers
   * it. A marker covers a row of its account, or one that names no account while this PC is in that account, unless
   * that row names no account and was paired here knowing every standing removal of the marker (`paired_over`).
   */
  private coveredByEvidence(device: StoredDevice): boolean {
    const key = device.relay_public_key;
    if (key === undefined || this.evidence === null) return false;
    if (this.evidence.standingRevokes(key).length > 0) return true;
    return this.evidence.standingMarkers(key).some(({ marker, standing }) => {
      const ofAccount = device.account === marker.account || (device.account === undefined && this.account() === marker.account);
      if (!ofAccount) return false;
      return !(device.account === undefined && standing.every((removal) => device.paired_over?.includes(removal.id)));
    });
  }

  /**
   * A stop between the two writes of a removal leaves a row and the tombstone of its key; one between
   * the two writes of a pairing on this PC does too. Their times tell them apart: a row made after the
   * key's removal is the pairing's, and the tombstone goes; one made before it is the removal's, and
   * the row goes (`stale`, which nothing admits meanwhile).
   */
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

  /** A row whose key was removed at or after the row was made: revoked, whether or not its own write happened yet. */
  private stale(device: StoredDevice): boolean {
    if (this.failedRows.has(device.id) || (device.relay_public_key !== undefined && this.failedDenies.has(device.relay_public_key))) return true;
    // main's own rule stays the floor under the evidence: a tombstone of this PC keeps its key out, whatever path took
    // the evidence in or skipped it (P13, rule 1)
    const tombstoned = device.relay_public_key !== undefined
      && this.tombstones.some((t) => t.key === device.relay_public_key && (!pairedHere(device) || this.later(t.removed_at, device.created_at, true)));
    return tombstoned || (this.evidence !== null && this.coveredByEvidence(device));
  }

  get accountError(): string | null {
    return this.safety?.strict ?? this.pc?.strict ?? this.evidence?.strict ?? this.journal?.strict ?? this.denyProblem ?? this.accountProblem;
  }

  /** The safety log or the admission order fails closed: no device gets in by a row or a code. */
  get failsClosed(): boolean {
    // with the flag on, an account tombstone file that cannot be read is a key out nobody can tell: only this PC gets in (S19)
    if (this.evidence !== null && this.accountProblem !== null) return true;
    return (this.safety?.strict ?? this.pc?.strict ?? this.evidence?.strict ?? this.denyProblem) !== null;
  }

  /**
   * The one-time migration of a PC from before the upgrade (T50): the rows' one account becomes the binding, and every
   * row gets `legacy`. The rows go to disk before the account file that ends the migration, so a stop between the two
   * runs it again on the next start and never stamps a row admitted since. Rows of two accounts fail closed first.
   */
  private migrate(): void {
    if (this.pc === null || this.error !== null) return;
    const numbered = this.devices.flatMap((d) => d.origin === undefined || d.origin.from === "legacy" ? [] : [d.origin.admit_no]);
    try { this.pc.settlePending((binding, key) => this.devices.some((d) => d.account === binding.account && d.relay_public_key === key)); }
    catch (error) { this.pc.unwritten(error); return; }
    const members = [...new Set(this.devices.flatMap((d) => d.account === undefined ? [] : [d.account]))];
    if (!this.pc.migrating) { this.pc.checkAbove(numbered); this.pc.checkMembers(members); return; }
    // a PC that ever had a device, its rows revoked since, is no first-device PC (T67): its gate stayed closed
    const hadDevices = this.devices.length > 0 || this.gateClosedAt !== null;
    // S2-03's counter file: the rows are numbered already, and only the binding is migrated (T50)
    if (this.pc.upgrading) {
      this.pc.checkAbove(numbered);
      const account = this.pc.migrationAccount(this.devices);
      if (this.pc.strict !== null) return;
      try { this.pc.migrate(account, hadDevices); } catch (error) { this.pc.unwritten(error); }
      return;
    }
    // a row numbered here means this folder had an account file: its loss is damage, and nothing is stamped (P21)
    if (numbered.length > 0) { this.pc.missingBeside(); return; }
    const account = this.pc.migrationAccount(this.devices);
    if (this.pc.strict !== null) return;
    const own = (d: StoredDevice) => d.origin === undefined && d.imported !== true;
    if (this.devices.some(own)) {
      const next = this.devices.map((d) => own(d) ? { ...d, origin: legacyOrigin(d.created_at) } : d);
      // a pass that cannot be written leaves the account state unknown: strict, never a failed start (S19)
      try { this.save(next); } catch (error) { this.pc.unwritten(error); return; }
      this.devices = next;
    }
    try { this.pc.migrate(account, hadDevices); } catch (error) { this.pc.unwritten(error); }
  }

  /** The PC leaves its account, for one of the three named reasons (P12); nothing else clears the binding. */
  clearAccountBinding(reason: ClearReason, by: string): boolean {
    if (this.pc !== null) return this.pc.clear(reason, by);
    // with the flag off nothing of the account is read, but a binding a flag-on run left is still cleared, so the next
    // flag-on start is in no account (P12); a folder that never had one is not touched
    return existsSync(join(this.stateDirPath, "account-pc.json")) ? PcAccountState.open(this.stateDirPath).clear(reason, by) : false;
  }

  /**
   * Writes `write` (the row of a link) with the binding of a PC in no account in the same turn, binding first: a row
   * that is not written takes its binding back (T13, T59).
   */
  private bindingWith<T>(account: string, key: string, write: () => T): T {
    if (this.pc === null) return write();
    if (this.pc.account() !== null) {
      const result = write();
      // a key other than the one that bound the PC joined it: the PC has had other devices, for good (T67, H2)
      if (this.pc.first()?.key !== key) this.pc.setOthersEver();
      return result;
    }
    const { commit, takeBack } = this.pc.bind(account, key);
    const onDisk = () => this.devices.some((d) => d.relay_public_key === key && d.account === account);
    let result: T;
    try { result = write(); } catch (error) {
      // a failure after the row reached the disk takes nothing back: the admission is durable (T13)
      if (!onDisk()) {
        try { takeBack(); } catch (left) { console.error(`[devices] the binding of a link that was not written could not be taken back: ${left instanceof Error ? left.message : String(left)}`); }
        throw error;
      }
      this.commitBinding(commit);
      throw error;
    }
    this.commitBinding(commit);
    return result;
  }

  /** The binding of a first link whose row is on disk stands; one that cannot be marked so leaves the PC strict (S19). */
  private commitBinding(commit: () => void): void {
    // the row is on disk but its binding cannot be made to stand: the PC fails closed and the link is no success; the
    // next start finds the binding pending beside its row and makes it stand (settlePending)
    try { commit(); } catch (error) { this.pc?.unwritten(error); throw error; }
  }

  /** The origin a row admitted now carries; none while the release flag is off. Every path is `remote` until a key confirm on this PC's screen exists (P22). */
  private admitted(device: StoredDevice, now: number, path: { startedBy?: string | null; digits?: boolean } = {}): StoredDevice {
    if (this.pc === null) return device;
    // `by` is the account member who approved it, by its account key, and only a member (P22): the member named on the
    // row, or the one that started the code this pairing redeemed; a link approves nothing
    // a link that moves the key admits a key nobody approved (P22)
    const approverId = device.linked_at !== undefined ? undefined : device.added_by ?? path.startedBy ?? undefined;
    const approver = approverId !== undefined && this.isAccountApprover(approverId) ? this.devices.find((d) => d.id === approverId) : undefined;
    const how = device.linked_at !== undefined ? "link" : device.account_add !== undefined ? "add" : approver !== undefined ? "member" : path.digits === true ? "digits" : "code";
    const by = approver?.relay_public_key ?? null;
    // a key this folder numbers is its own here, whatever copy the row came in as (P21)
    const { imported: _copied, ...own } = device;
    return { ...own, origin: this.pc.admit("remote", how, by, now) };
  }

  /**
   * Whether the gate is closed to strangers: it is from the first pairing on, and stays so when
   * every device is revoked (revoking must never reopen the LAN); this PC itself always gets in.
   */
  get gated(): boolean {
    // what access reads: a PC that fails closed is closed to strangers, paired or not (S19)
    return this.failsClosed || this.rawGated;
  }

  /** The gate as the registry holds it, for what is persisted and announced (closeGate, save); access reads gated. */
  private get rawGated(): boolean {
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

  /** The end of what the open LAN alone let in: `close` when the gate closes, at once when it is closed already. */
  endWithGate(close: () => void): () => void {
    if (this.rawGated) { close(); return () => {}; }
    return this.onGateClosed(close);
  }

  /** Relay opt-in closes open LAN access before any outbound connection is made. */
  /** Closes the registry's own gate, whatever the safety log says; closing a closed gate does nothing. */
  closeGate(): void {
    // a registry that could not be read is closed already (rawGated): nothing to write, and nothing to throw
    if (this.rawGated) return;
    this.assertWritable();
    const gate = new Date().toISOString();
    this.save(this.devices, gate);
    this.gateClosedAt = gate;
    this.voidPending();
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

  /**
   * Ends stale authority on revocation or role changes, never a label-only update. Called immediately for an already-revoked identity.
   * `waiting`: the row that went had paired with a code made for a PC in no account and not linked (dropProvisional).
   */
  onRevoke(id: string, close: (waiting?: true) => void): () => void {
    // a row that waits to link has sessions too: they end when it goes, as a device's do when it is revoked
    if (!this.devices.some((device) => device.id === id) && this.pending?.waiting?.rows.has(id) !== true) { close(); return () => {}; }
    const listeners = this.revocations.get(id) ?? new Set<(waiting?: true) => void>();
    listeners.add(close);
    this.revocations.set(id, listeners);
    return () => {
      listeners.delete(close);
      if (listeners.size === 0) this.revocations.delete(id);
    };
  }

  /**
   * Hears of every durable enrollment: a gated pairing, or a first-pair cookie confirmed. Never an
   * unconfirmed credential, a last-seen write or a failed one.
   */
  onPaired(listener: (event: DevicePairedEvent, origin: readonly string[]) => void): () => void {
    this.pairings.add(listener);
    return () => { this.pairings.delete(listener); };
  }

  /**
   * After the registry write that made `device` durable, and only then. `enrolledAt` is that write's
   * moment, not the credential's issue: a first-pair cookie confirmed later is enrolled when it returns.
   */
  private announce(device: StoredDevice, enrolledAt: number, origin: readonly string[]): void {
    const approver = device.added_by === undefined ? undefined : this.devices.find((d) => d.id === device.added_by);
    const event: DevicePairedEvent = {
      type: "device-paired", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, enrolled_at: new Date(enrolledAt).toISOString(),
      ...(approver ? { approved_by: { device_id: approver.id, label: approver.label } } : {}),
    };
    // with the flag off, main's own order: a listener that throws fails the pairing
    if (this.safety === null) { for (const listener of this.pairings) listener(event, origin); return; }
    // each on its own: one that throws skips nobody else (G14)
    for (const listener of [...this.pairings]) {
      try { listener(event, origin); } catch (error) { console.warn(`[devices] a pairing listener failed: ${describe(error)}`); }
    }
  }

  private assertWritable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  /** `withAccounts`: add the account fields of member rows, for a caller that may drive (GET /api/devices). */
  list(currentId: string | null, withAccounts = false): PairedDevice[] {
    return this.devices.map((d) => ({
      id: d.id, label: d.label, role: d.role, created_at: d.created_at, last_seen_at: d.last_seen_at, current: d.id === currentId,
      ...(d.relay_public_key === undefined ? {} : { via_relay: true as const }),
      ...(withAccounts && d.account !== undefined && d.relay_public_key !== undefined
        ? { account: d.account, account_key: d.relay_public_key, ...(d.added_by === undefined ? {} : { added_by: d.added_by }) } : {}),
    }));
  }

  /**
   * Hears of every new six-digit code, which replaces the one pending, and of a code ended (endPairing):
   * either way a typed relay code bound to the old one goes (server/relay/pair-code.ts).
   */
  onPairingStarted(listener: () => void): () => void {
    this.codeStarts.add(listener);
    return () => { this.codeStarts.delete(listener); };
  }

  activePairing(now = Date.now()): PairingCode | null {
    const pending = this.pending;
    if (pending === null || this.codeOver(pending, now) || pending.attempts >= CODE_ATTEMPTS) return null;
    return { code: pending.code, expires_at: new Date(pending.expires).toISOString() };
  }

  /**
   * A fresh six-digit code, replacing any code still pending. `by`: the paired device whose request started it
   * (null for this PC itself), which holds it from then on. One that is paired no more by now, or may only watch by
   * now, starts nothing (assertHolder), and the code pending stays as it was.
   */
  startPairing(now = Date.now(), from: { remote: boolean; startedBy: string | null; memberRequired: boolean; open?: boolean; noAccountOnly?: boolean; by?: string | null; account?: string; issuedUnder?: string } = { remote: false, startedBy: null, memberRequired: false }): PairingCode {
    this.assertWritable();
    const { by = null, account, issuedUnder, ...how } = from;
    if (by !== null) this.assertHolder(by);
    if (how.startedBy !== null && !this.has(how.startedBy)) throw new DeviceGoneError();
    this.pruneUnconfirmedFirstPairs(now);
    this.codeIssues = this.codeIssues.filter((at) => now - at < PAIRING_WINDOW_MS);
    if (this.codeIssues.length >= 10) throw new PairingRateLimitedError(Math.ceil(((this.codeIssues[0] ?? now) + PAIRING_WINDOW_MS - now) / 1000));
    this.codeIssues.push(now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    // the code this one replaces takes the rows that waited under it along
    this.voidPending("replaced");
    this.pending = {
      code, id: randomBytes(16).toString("hex"), expires: now + CODE_TTL_MS, deadline: this.clock.now() + CODE_TTL_MS, attempts: 0, ...how,
      // the account its starter approves the pairing for, judged as the code is made: a starter that joins later approved nothing
      ...(how.startedBy !== null && this.approverAccount(how.startedBy) !== null ? { approvedIn: this.approverAccount(how.startedBy)! } : {}),
      holders: new Set([by, how.startedBy].filter((id): id is string => id !== null)),
      ...(how.noAccountOnly === true ? { waiting: { usesLeft: PAIRING_USES, rows: new Map<string, ProvisionalRow>(), turnedAway: [] } } : {}),
      ...(how.noAccountOnly === true && account !== undefined ? { named: { account } } : {}),
      ...(how.noAccountOnly === true && issuedUnder !== undefined ? { issuedUnder } : {}),
    };
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
   * A device that pairs with it through the relay is no device yet: it waits to link (pairProvisional), and the
   * code takes PAIRING_USES such pairings. No other offer carries it (pairingForOffer), and it is redeemed through
   * the relay only (pair). `by` as in startPairing. `issuedUnder`: the account named for this PC as the code is made
   * (RelayService.offer); a device that waits under the code is taken into that account only (issuedUnder), and a code
   * pending that was made under another is not carried on: a fresh one replaces it.
   */
  pairingForNoAccount(by: string | null = null, now = Date.now(), issuedUnder?: string): PairingCode {
    if (by !== null) this.assertHolder(by);
    if (this.account() !== null) throw new PcInAccountError();
    const active = this.activePairing(now);
    const pending = this.pending;
    // never a code made for one account: the device that pairs with this one is taken into the account named for the PC
    const carried = pending?.noAccountOnly === true && pending.named === undefined && pending.issuedUnder === issuedUnder;
    if (active !== null && carried) {
      if (by !== null) pending.holders.add(by);
      return active;
    }
    // past its ten minutes, the code stays while a device that paired with it in time may still link (expirePending)
    if (carried && this.codeOver(pending, now)) {
      this.expirePending();
      const rows = [...this.pending === pending ? pending.waiting?.rows.values() ?? [] : []];
      if (rows.length > 0) throw new PairingFinishingError(Math.max(1, Math.ceil(Math.max(...rows.map((row) => row.pairedAt + PAIRING_LINK_MS - this.clock.now())) / 1000)));
    }
    return this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, noAccountOnly: true, by, ...(issuedUnder === undefined ? {} : { issuedUnder }) });
  }

  /**
   * The account named for this PC when the relay tab's code that the row `id` waits under was made (pairingForNoAccount),
   * whatever is named now: its link is taken into that account only. Null for a row that does not wait under such a code.
   */
  issuedUnder(id: string): string | null {
    return this.pending?.waiting?.rows.has(id) === true && this.pending.named === undefined ? this.pending.issuedUnder ?? null : null;
  }

  /**
   * The code of an offer asked for with `x-ovis-expect-account: <account>` (docs/account.md, "A code made for an
   * account"): the code pending when that was made for the same account, else a fresh one (startAccountPairing).
   * `want`: the id of the code pending to carry; `new` asks for a fresh one. An id that names no code this offer can
   * carry starts none (PairingGoneError): a fresh code would replace the one pending, which another run may have made
   * since, with the devices that wait under it. `by` as in startPairing.
   */
  pairingForAccount(account: string, by: string | null = null, now = Date.now(), want?: string): PairingCode & AccountPairing {
    if (by !== null) this.assertHolder(by);
    // a code made for an account ends when the PC joins one (endNoAccountCode): one still pending is for a PC in none
    const active = this.activePairing(now);
    const pending = this.pending;
    if (active !== null && pending?.named?.account === account && (want === undefined || want === pending.id)) {
      if (by !== null) pending.holders.add(by);
      return { ...active, expect_account: account, pairing: { id: pending.id } };
    }
    // a PC in an account says so first (startAccountPairing)
    if (want !== undefined && want !== "new" && this.account() === null) throw new PairingGoneError();
    return this.startAccountPairing(account, by, now);
  }

  /**
   * A fresh code made for `account`, replacing any code pending. It is the code of the QR code that puts this PC in
   * an account (pairingForNoAccount), with one difference: a device that pairs with it and waits to link is taken
   * into `account` alone, whatever account was named for this PC (server/account/records.ts applyLink). So it is made
   * only while the PC is in no account (PcInAccountError otherwise, and the code pending stays as it was). Its id
   * names it for a read of its state (accountPairingState). `by` as in startPairing.
   */
  startAccountPairing(account: string, by: string | null = null, now = Date.now()): PairingCode & AccountPairing {
    if (this.account() !== null) throw new PcInAccountError();
    const started = this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, noAccountOnly: true, by, account });
    return { ...started, expect_account: account, pairing: { id: this.pending!.id } };
  }

  /**
   * Ends the relay tab's code (pairingForNoAccount) and the rows that wait to link under it, as endPairing does; a code
   * made for an account, or another code, stays. False when that code is not the one pending.
   */
  endNoAccountPairing(): boolean {
    if (this.pending?.noAccountOnly !== true || this.pending.named !== undefined) return false;
    return this.endPairing();
  }

  /**
   * The account that the code a waiting row paired with was made for (startAccountPairing), also once that code's ten
   * minutes are over: the row is held to it until it links or goes. Null for the relay tab's code, and for a row that
   * does not wait to link.
   */
  waitingFor(id: string): string | null {
    return this.pending?.waiting?.rows.has(id) === true ? this.pending.named?.account ?? null : null;
  }

  /**
   * The code made for a PC in no account that is alive now (pairingForNoAccount, startAccountPairing): the code pending
   * and the PC still in no account, within its ten minutes or, past them, while a device that paired with it in time
   * still waits to link (expirePending; it pairs no new device then). Null for none. What it returns names that code
   * and no later one, so a link holds it from its arrival to its write (LinkArrival).
   */
  pinnedCode(now = Date.now()): object | null {
    if (this.pending?.noAccountOnly === true && this.codeOver(this.pending, now)) this.expirePending();
    const pending = this.pending;
    return pending?.noAccountOnly === true && this.account() === null && (!this.codeOver(pending, now) || (pending.waiting?.rows.size ?? 0) > 0) ? pending : null;
  }

  /** The account a code from pinnedCode was made for (startAccountPairing); null for the relay tab's code, or a code no longer pending. */
  pinnedFor(pinned: object): string | null {
    return this.pending === pinned ? this.pending.named?.account ?? null : null;
  }

  /** Whether `code` is the six digits of a code that pinnedCode names now: its offer carries the mark (shared/relay-offer.ts `admission`). */
  isPinnedCode(code: string): boolean {
    return this.pinnedCode() !== null && this.pending !== null && same(code, this.pending.code);
  }

  /** What the last link of the row `id` that waits to link waits for or got (records.ts applyLink); the keep shows it. */
  noteLink(id: string, link: "asked" | "service_unreachable"): void {
    const row = this.pending?.waiting?.rows.get(id);
    if (row) row.link = link;
  }

  /** The clock a row that waits to link is bounded on (useClock): the wait of its link for the account service is too. */
  waitClock(): MuxClock {
    return this.clock;
  }

  /**
   * Whether the code made for an account that `id` names is still the pending one, and how it ended. A code whose ten
   * minutes are over pairs no new device, and stays the pending one only while a device that paired with it in time
   * may still link (expirePending): with none, it has ended at this read, whether or not anything used it since. While
   * it lives, the rows that wait under it, and every row of it that went without becoming a member.
   */
  accountPairingState(id: string, now = Date.now()): AccountPairingState {
    const pending = this.pending;
    if (pending?.named !== undefined && pending.id === id) {
      if (this.codeOver(pending, now)) this.expirePending();
      if (this.pending === pending) {
        const waiting = [...pending.waiting?.rows.values() ?? []].map((row) => ({ id: row.id, label: row.label, link: row.link ?? "not_sent" as const }));
        return { state: "live", id, expect_account: pending.named.account, expires_at: new Date(pending.expires).toISOString(), waiting, turned_away: [...pending.waiting?.turnedAway ?? []] };
      }
    }
    return this.endedAccountCodes.find((ended) => ended.id === id) ?? { state: "unknown" };
  }

  /**
   * The code of every other relay offer (POST /api/relay/offer without `x-ovis-no-account-only`): the code pending,
   * else a fresh one. Never the code made for a PC in no account (pairingForNoAccount): the device that pairs with
   * that one waits to link, and this offer is for a device that is paired at once. With that code pending a fresh
   * one is started, which replaces it as every new code does. `want` as in pairingForAccount, `by` as in startPairing.
   */
  pairingForOffer(by: string | null = null, now = Date.now(), want?: string): PairingCode {
    const active = this.activePairing(now);
    if (active !== null && this.pending?.noAccountOnly !== true && (want === undefined || want === this.pending?.id)) return active;
    if (want !== undefined && want !== "new") throw new PairingGoneError();
    return this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, by });
  }

  /**
   * A row just became an account member. A code made only for a PC in no account goes: left pending, whoever scans it
   * next would be paired with a PC that has members, with nobody approving and nobody asked.
   */
  private endNoAccountCode(): void {
    if (this.pending?.noAccountOnly === true && this.account() !== null) this.endPairing(undefined, "joined");
  }

  /**
   * The paired device `id` is handed the code pending (a relay offer it asked for carries it): it holds it too.
   * Called before the code leaves this PC: a device that is paired no more, or may only watch, by now is handed
   * nothing (assertHolder).
   */
  holdPairing(id: string): void {
    this.assertHolder(id);
    this.pending?.holders.add(id);
  }

  /**
   * The paired device `id` may still hold a pairing code: checked right before one is started or handed to it, since
   * its request may have waited (on the relay, say) while it was removed (DeviceGoneError) or made one that only
   * watches (DeviceReadOnlyError).
   */
  private assertHolder(id: string): void {
    if (!this.has(id)) throw new DeviceGoneError();
    if (!this.canDrive(id)) throw new DeviceReadOnlyError();
  }

  /**
   * Whether the code pending is past its ten minutes: from the first time the wall clock `now`, or the store's clock,
   * which only moves forward, said so. A clock set back or forward and back again gives no time back, so a code kept
   * past its ten minutes for the devices that paired with it in time (expirePending) never pairs a new one. Those
   * devices keep their own time to link, on the store's clock.
   */
  private codeOver(pending: { expires: number; deadline: number; over?: true }, now: number): boolean {
    if (now > pending.expires || this.clock.now() > pending.deadline) pending.over = true;
    return pending.over === true;
  }

  /** The id of the code pending (endPairing, accountPairingState); null when none is. */
  pairingId(): string | null {
    return this.pending?.id ?? null;
  }

  /**
   * Takes the pending six-digit code back, and the typed relay code bound to it: nothing it was shown as pairs any more.
   * With `match`, only when its `code` and its `id`, each that is given, are the pending code's, so a caller never ends
   * a pairing started after its own; false when it did not. `why`: what a code made for an account is remembered to
   * have ended by.
   */
  endPairing(match?: { readonly code?: string; readonly id?: string }, why: AccountPairingEnd = "cancelled"): boolean {
    const pending = this.pending;
    if (match !== undefined && (pending === null || (match.code !== undefined && !same(match.code, pending.code)) || (match.id !== undefined && match.id !== pending.id))) return false;
    this.voidPending(why);
    for (const listener of this.codeStarts) listener();
    return true;
  }

  /**
   * The clock a row that waits to link is bounded on, and a code's redemption with it (codeOver). It only moves
   * forward (performance.now by default), so a PC's wall clock set back extends none of those bounds. A test hands in
   * one it moves by hand.
   */
  useClock(clock: MuxClock): void {
    this.clock = clock;
  }

  /**
   * Drops the code pending, with nobody told; the rows that waited to link under it go with it. A code made for an
   * account is remembered as ended by `why` (accountPairingState).
   */
  private voidPending(why: AccountPairingEnd = "cancelled"): void {
    const waiting = this.pending?.waiting;
    const id = this.pending?.id;
    const named = this.pending?.named;
    this.pending = null;
    if (waiting) for (const row of [...waiting.rows.values()]) this.dropProvisional(waiting, row, "code_ended");
    if (named && id !== undefined) {
      const joined = why === "joined" ? waiting?.joined : undefined;
      this.endedAccountCodes = [...this.endedAccountCodes, { state: "ended" as const, id, expect_account: named.account, ended: { why, at: new Date().toISOString() }, ...(joined ? { joined } : {}), turned_away: [...waiting?.turnedAway ?? []] }]
        .slice(-ENDED_ACCOUNT_CODES);
    }
  }

  /**
   * The code pending is past its ten minutes: it pairs no new device. It goes now, unless devices that paired with it
   * in time still wait to link: each keeps its own PAIRING_LINK_MS, and the code goes with the last of them
   * (dropProvisional), or when one links.
   */
  private expirePending(): void {
    const waiting = this.pending?.waiting;
    // a row whose time is over goes at this look (provisional)
    if (waiting) for (const id of [...waiting.rows.keys()]) this.provisional(id);
    if (this.pending !== null && (this.pending.waiting?.rows.size ?? 0) === 0) this.voidPending("expired");
  }

  /**
   * A row that waits to link goes: its sessions end `auth_revoked`, and a later sign-in with its id fails. Nothing
   * was written for it, so nothing is unwritten and no tombstone is left. Its use stays spent; a code with no use
   * left, or past its ten minutes (expirePending), ends as the last row that waited under it goes. `why`, with the
   * account its link named when that was the reason, goes into the code's history (accountPairingState).
   */
  private dropProvisional(waiting: WaitingRows, row: ProvisionalRow, why: AccountPairingTurnedAway["why"], account?: string): void {
    if (!waiting.rows.delete(row.id)) return;
    row.cancel();
    waiting.turnedAway.push({ n: waiting.turnedAway.length + 1, id: row.id, label: row.label, why, link: row.link ?? (row.links > 0 ? "sent" : "not_sent"), ...(account === undefined ? {} : { account }) });
    const listeners = this.revocations.get(row.id);
    this.revocations.delete(row.id);
    for (const close of listeners ?? []) close(true);
    if (this.pending?.waiting !== waiting || waiting.rows.size > 0) return;
    if (waiting.usesLeft === 0) this.endPairing(undefined, "overused");
    else if (this.codeOver(this.pending, Date.now())) this.endPairing(undefined, "expired");
  }

  /**
   * `keys` were removed on this PC in this turn (a revoke, a revoke of all, an account's removal): every row that
   * waits to link with one of them goes with it, once the removal is written and before anything else is. Such a
   * row paired before the removal, and its link would take it back (promote clears the tombstone of a key its row
   * kept). So a tombstone that stands when a waiting row links stood when that row paired.
   */
  private dropWaiting(keys: readonly string[]): void {
    const waiting = this.pending?.waiting;
    if (!waiting) return;
    for (const row of [...waiting.rows.values()]) if (keys.includes(row.key)) this.dropProvisional(waiting, row, "removed");
  }

  /**
   * The row `id` that waits to link, by the clock read now: one whose PAIRING_LINK_MS are over is gone at the first
   * look, whether or not its timer has run.
   */
  private provisional(id: string): ProvisionalRow | undefined {
    const waiting = this.pending?.waiting;
    const row = waiting?.rows.get(id);
    if (!waiting || !row) return undefined;
    if (this.clock.now() - row.pairedAt < PAIRING_LINK_MS) return row;
    this.dropProvisional(waiting, row, "link_timeout");
    return undefined;
  }

  /**
   * The row `id` as its own relay session may see it: a device, or one that waits to link (`provisional`). Nothing
   * else is shown a waiting row: no list, no route and no holder of a code knows it, and its role is the one with
   * the fewest rights. This look reads no clock: the two calls such a row may make do (provisionalStands,
   * linkArrived), so a row whose time is over is gone at the first of them, and can make no other call meanwhile.
   */
  sessionRow(id: string): { role: DeviceRole; key: string | undefined; provisional: boolean } | null {
    const device = this.devices.find((d) => d.id === id);
    // a row its evidence covers serves no request, whatever session it holds (S14); while the PC fails closed no
    // session opens another stream either: only this PC itself gets in (S19, P8)
    if (this.evidence !== null && (this.failsClosed || (device !== undefined && this.stale(device)))) return null;
    if (device) return { role: device.role, key: device.relay_public_key, provisional: false };
    const waiting = this.pending?.waiting?.rows.get(id);
    return waiting ? { role: "watch", key: waiting.key, provisional: true } : null;
  }

  /** Whether the row `id` still waits to link: its code is the one pending, and its PAIRING_LINK_MS are not over by the clock read now. */
  provisionalStands(id: string): boolean {
    return this.provisional(id) !== undefined;
  }

  /**
   * A row that waits to link is turned away: its link named another account than the one this PC is for
   * (`account_mismatch`, with the account it named), or the account service did not vouch for its key (`unverified`).
   * It goes at once, as when its time runs out. Its use of the code stays spent, and the code stays.
   */
  turnAway(id: string, why: "account_mismatch" | "unverified", account?: string): void {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (row && waiting) this.dropProvisional(waiting, row, why, account);
  }

  /**
   * A link came from the row `id` (POST /api/account/link), before its signature is checked: whether the row is one
   * that waits to link. `wasProvisional`: its relay session said so when the request began, so a row that went
   * since is never taken for a device. A waiting row sends WAITING_LINKS links; the next turns it away, and null
   * says so.
   */
  linkArrived(id: string, wasProvisional = false): LinkArrival | null {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (row && waiting) {
      row.links += 1;
      if (row.links > WAITING_LINKS) { this.dropProvisional(waiting, row, "link_refused"); return null; }
    }
    return { provisional: wasProvisional || row !== undefined, pinned: this.pinnedCode() };
  }

  /**
   * The link of a row that waits (linkAccountKey): the row becomes a device and a member of `link.account` in one
   * write of devices.json. First the check again, right before anything is written: the row still waits and still
   * names the key the link starts from, the PC is still in no account, and no account removed the key the row would
   * hold. Null when one of them fails, and nothing is written; a write that throws leaves the row waiting. Once the
   * row is written the code it paired with has done what it was for: it ends, every other row that waited goes, the
   * row's other sessions end (`auth_changed`), and the device is announced. Last, the tombstone of a key the row
   * kept is cleared. It is this PC's own removal of that key (Revoke, Revoke all), and it stood when the row paired:
   * one made since would have taken the row (dropWaiting). That write's failure is logged and changes nothing of the
   * above; the next start clears it.
   */
  private promote(id: string, link: { oldKey: string; key: string; account: string }, sessionId: string, vouched: boolean): PairedDevice | null {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (!row || !waiting || row.key !== link.oldKey || this.account() !== null || this.removedByAccount(link.key)) return null;
    const now = Date.now();
    const at = new Date(now).toISOString();
    // the removal of a key the row keeps, by this PC (removedByAccount refused the account's above)
    const removedAt = link.key === link.oldKey ? this.tombstones.find((t) => t.key === link.key)?.removed_at : undefined;
    const device: StoredDevice = {
      id: row.id, label: row.label, role: "drive", token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: link.key,
      // made at this write, not at its pairing, and after that removal even on a wall clock set back since: the row
      // is newer than the removal, so a stop before the tombstone is cleared leaves a row that the next start keeps
      // (finishInterruptedWrites, or with the flag on RemovalEvidence.takeIn)
      created_at: removedAt !== undefined && removedAt >= at ? new Date(Date.parse(removedAt) + 1).toISOString() : at, last_seen_at: at, account: link.account, linked_at: at, link_moved_key: link.key !== link.oldKey, joined_by: vouched ? "service" : "code",
    };
    // no waiting row from here on: the end of its code, which this write brings, takes the rows that still wait
    waiting.rows.delete(row.id);
    // the end of its code, which this write brings, names the device it brought in
    waiting.joined = { device_id: row.id, label: row.label };
    try { this.bindingWith(link.account, link.key, () => this.enroll(device, now, [], false)); }
    catch (error) {
      waiting.rows.set(row.id, row);
      delete waiting.joined;
      throw error;
    }
    row.cancel();
    for (const listener of [...this.relinks.get(id) ?? []]) listener(sessionId);
    if (link.key === link.oldKey) {
      try { this.clearTombstone(link.key); }
      catch (error) { console.error(`[devices] the tombstone of a key that paired again could not be cleared; the next start clears it: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return this.list(null).find((d) => d.id === id) ?? null;
  }

  pair(code: string, label: string, role: DeviceRole, now = Date.now(), origin: readonly string[] = [], localCodeOnly = false): { token: string; device: DeviceMatch } | null {
    if (this.failsClosed) return null;
    this.assertWritable();
    this.pruneUnconfirmedFirstPairs(now);
    // a code started through the relay is never redeemed on the LAN listener, nor are its guesses spent there:
    // it would make a credential no relay key or account removal reaches
    if (localCodeOnly && this.pending?.remote === true) return null;
    // a code made for a PC in no account is redeemed through the relay only, and no try is spent on it here: the
    // device it is for links itself into an account with the key it paired with (pairProvisional), and a device
    // paired here holds a cookie and no key
    if (this.pending?.waiting) return null;
    if (!this.checkPairingCode(code, now, localCodeOnly)) return null;
    // a member's code goes with the member here too (pairRelay)
    const startedBy = this.pending?.startedBy ?? null;
    if (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy))) return null;
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = { id: randomBytes(8).toString("hex"), label, role, token_hash: hash(token), created_at: new Date(now).toISOString(), last_seen_at: null };
    if (!this.gated) {
      this.voidPending();
      this.unconfirmedFirstPairs.push({ device, expires: now + CODE_TTL_MS, origin });
      if (this.unconfirmedFirstPairs.length > UNCONFIRMED_FIRST_PAIR_LIMIT) this.unconfirmedFirstPairs.shift();
      return { token, device: { id: device.id, label: device.label, role: device.role } };
    }
    this.enroll(device, now, origin, true, { startedBy });
    return { token, device: { id: device.id, label: device.label, role: device.role } };
  }

  /**
   * Both transports spend the same pending code's five guesses. The LAN HTTPS listener has five of its
   * own instead (`lan`), so a stranger there cannot spend a code a phone is about to type in elsewhere.
   */
  private checkPairingCode(code: string, now: number, lan = false): boolean {
    const pending = this.pending;
    if (pending === null) return false;
    // the devices that paired with it in time still have their own time to link (expirePending)
    if (this.codeOver(pending, now)) { this.expirePending(); return false; }
    // made for a PC in no account, and the PC is in one: it ended as the PC joined (endNoAccountCode), and pairs nobody
    if (pending.noAccountOnly === true && this.account() !== null) { this.endPairing(undefined, "joined"); return false; }
    if (lan) {
      if ((pending.lanAttempts ?? 0) >= CODE_ATTEMPTS) return false;
      if (same(code.replace(/\D/g, ""), pending.code)) return true;
      pending.lanAttempts = (pending.lanAttempts ?? 0) + 1;
      return false;
    }
    if (!same(code.replace(/\D/g, ""), pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= CODE_ATTEMPTS) this.voidPending("guessed");
      return false;
    }
    return true;
  }

  /** One authorization write precedes every state change and enrollment announcement. */
  private enroll(admitting: StoredDevice, now: number, origin: readonly string[], codeSpent = true, path: { startedBy?: string | null; digits?: boolean } = {}): void {
    const admitted = this.knowingRemovals(this.admitted(admitting, now, path));
    // with the flag on a row is stamped after everything this store ordered before it (T26, P13)
    const device = this.evidence === null ? admitted : { ...admitted, created_at: this.nextStamp(Date.parse(admitted.created_at)) };
    this.journalAdmission(device);
    const next = [...this.devices, device];
    const gate = this.gateClosedAt ?? device.created_at;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    if (codeSpent) this.voidPending();
    if (device.account !== undefined) this.endNoAccountCode();
    // A relay enrollment closes the gate immediately, invalidating every first-cookie candidate.
    if (device.relay_public_key !== undefined) this.unconfirmedFirstPairs = [];
    this.announce(device, now, origin);
  }

  /**
   * No cookie is issued: even the first relay pairing is durable and closes the gate at once. `admit` is asked once
   * the code holds and nothing else refuses the key, before any device is made: false makes none, spends no code and
   * counts no failure (server/relay/session.ts, a relay pass that allows no new sessions). It is asked only for a
   * key new to this PC (isNewKey).
   */
  pairRelay(code: string, label: string, publicKey: string, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    if (this.failsClosed) return null;
    this.assertRelayPairing("code", now);
    // a code made for a PC in no account makes no device: the one that pairs with it waits to link
    const waiting = this.pending?.waiting;
    if (waiting) return this.pairProvisional(waiting, code, label, publicKey, now, admit);
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.noteRelayFailure("code", now);
      return null;
    }
    // a code started through the relay is not a pairing made on this PC (docs/account.md, rule 5)
    const remote = this.pending?.remote ?? false;
    const startedBy = this.pending?.startedBy ?? null;
    // a code started through the relay is not a pairing made on this PC; a member's code goes with the member.
    // On a PC in no account such a code may bring back a key this PC revoked itself, as before account linking;
    // never one the account removed
    const accountless = this.account() === null;
    const refusedKey = accountless ? this.removedByAccount(publicKey) : this.isTombstoned(publicKey);
    if ((remote && (this.accountError !== null || refusedKey)) || (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy)))) {
      this.noteRelayFailure("code", now);
      return null;
    }
    // a device let in by a code started through the relay is its starter's addition, not a pairing made on this PC (removeAccountKey);
    // one that brings back a key this PC revoked itself (on a PC in no account) undoes that revoke, and is the PC's own
    // pairing, so a tombstone that comes back (a sibling dir, a stop before it is cleared) takes it only if newer
    const undoesRevoke = remote && accountless && this.isTombstoned(publicKey);
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    // the starter's approval stands only while it is still a member of the account it approved for
    const approvedIn = startedBy !== null && this.pending?.approvedIn !== undefined && this.approverAccount(startedBy) === this.pending.approvedIn ? this.pending.approvedIn : undefined;
    const paired = this.enrollRelay(label, publicKey, now, true, undoesRevoke ? {} : { addedBy: startedBy ?? undefined, approvedIn });
    if (!remote || accountless) this.clearTombstone(publicKey);
    return paired;
  }

  /**
   * PAIR with a code made for a PC in no account: no device yet. The row it makes is in memory and in no list, and
   * has PAIRING_LINK_MS to link itself into an account (promote); until then its answer names the role with the
   * fewest rights. It spends one of the code's uses and does not end the code. A right code with no use left makes
   * nothing and counts neither as a wrong try nor as a failed pairing; a wrong one counts as ever. Nothing is
   * written, and a removed key is not judged here: the link is (records.ts applyLink, promote).
   */
  private pairProvisional(waiting: WaitingRows, code: string, label: string, publicKey: string, now: number, admit?: () => boolean): { device: DeviceMatch } | null {
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.noteRelayFailure("code", now);
      return null;
    }
    if (waiting.usesLeft === 0) return null;
    // asked last, as for any pairing: a relay pass that takes no new device makes no row and spends no use
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    let id = randomBytes(8).toString("hex");
    while (this.has(id) || waiting.rows.has(id)) id = randomBytes(8).toString("hex");
    const row: ProvisionalRow = {
      id, label: normalizeLabel(label, "Device"), key: publicKey, pairedAt: this.clock.now(), links: 0,
      cancel: this.clock.setTimeout(() => this.dropProvisional(waiting, row, "link_timeout"), PAIRING_LINK_MS),
    };
    waiting.usesLeft -= 1;
    waiting.rows.set(id, row);
    return { device: { id, label: row.label, role: "watch" } };
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

  /**
   * A pairing by comparing digits that was approved (server/relay/session.ts): on this PC, or by the
   * account member `addedBy` through the relay. No code is spent. `admit` as in pairRelay: asked last and only for
   * a key new to this PC, false makes no device and counts no failure.
   */
  pairRelayApproved(label: string, publicKey: string, approval: { path: PairingPath; addedBy?: string; id?: string }, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    if (this.failsClosed) return null;
    this.assertRelayPairing(approval.path, now);
    if (!isRelayPublicKey(publicKey)) { this.noteRelayFailure(approval.path, now); return null; }
    // an approver revoked or demoted while the device waited approves nothing
    if (approval.addedBy !== undefined && !this.isAccountApprover(approval.addedBy)) { this.noteRelayFailure(approval.path, now); return null; }
    // only this PC lets a key removed through the account back in
    if (approval.addedBy !== undefined && (this.accountError !== null || this.isTombstoned(publicKey))) { this.noteRelayFailure(approval.path, now); return null; }
    if (approval.id !== undefined && this.has(approval.id)) { this.noteRelayFailure(approval.path, now); return null; }
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    const paired = this.enrollRelay(label, publicKey, now, false, { addedBy: approval.addedBy, approvedIn: approval.addedBy === undefined ? undefined : this.approverAccount(approval.addedBy) ?? undefined, digits: true }, approval.id);
    // written after the row, so a stop between the two leaves a row newer than its tombstone: the next start ends that
    // Revoke (finishInterruptedWrites, or with the flag on RemovalEvidence.takeIn)
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
    if (this.pc !== null) return this.pc.account();
    return this.devices.find((d) => d.account !== undefined)?.account ?? null;
  }

  /** Whether the row `id`, or another row of its key that a revoke of it would take too (revoke), is a member of `account`. */
  isMemberOf(id: string, account: string): boolean {
    const key = this.relayKeyOf(id);
    return this.devices.some((d) => (d.id === id || (key !== undefined && d.relay_public_key === key)) && d.account === account && d.relay_public_key !== undefined);
  }

  /** A drive account member whose session signed in with the row's current key: a session left from an older key acts as no member. */
  isAccountApproverSession(id: string, sessionKey: string): boolean {
    return sessionKey !== "" && this.relayKeyOf(id) === sessionKey && this.isAccountApprover(id);
  }

  hasAccountApprover(): boolean { return this.devices.some((d) => this.isAccountApprover(d.id)); }

  /** A drive account member: the only device that may approve a pairing or start a code through the relay (docs/account.md). */
  isAccountApprover(id: string): boolean {
    const device = this.devices.find((d) => d.id === id);
    return device !== undefined && device.role === "drive" && device.account !== undefined && device.relay_public_key !== undefined && !this.stale(device);
  }

  /** The account `id` may approve a pairing for (isAccountApprover), or null. */
  private approverAccount(id: string): string | null {
    return this.isAccountApprover(id) ? this.devices.find((d) => d.id === id)?.account ?? null : null;
  }

  private enrollRelay(label: string, publicKey: string, now: number, codeSpent: boolean, { addedBy, approvedIn, digits }: { addedBy?: string | undefined; approvedIn?: string | undefined; digits?: boolean }, id = randomBytes(8).toString("hex")): { device: DeviceMatch } {
    const device: StoredDevice = {
      id, label: normalizeLabel(label, "Device"), role: "drive",
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: publicKey,
      // PAIR authenticates this relay session too, so the device is seen as it pairs.
      created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
      ...(addedBy === undefined ? {} : { added_by: addedBy }),
      // what a later link reads to tell a member's approval from a code a device outside the account started
      ...(addedBy !== undefined && approvedIn !== undefined ? { member_approved_in: approvedIn } : {}),
    };
    this.enroll(device, now, [], codeSpent, { ...(digits === undefined ? {} : { digits }) });
    return { device: { id: device.id, label: device.label, role: device.role } };
  }

  /** The transport owns a fresh 32-byte nonce per session and consumes AUTH only once. */
  async matchRelay(deviceId: string, nonce: Uint8Array, signature: string, serverId: string, now = Date.now()): Promise<DeviceMatch | null> {
    if (this.failsClosed || nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const signed = Buffer.from(signature, "base64url");
    if (signed.length !== 64 || signed.toString("base64url") !== signature) return null;
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key !== undefined);
    // a row that waits to link signs in as any row does, by the key its PAIR named, while it stands; only that
    // sign-in proves the key
    const waiting = device === undefined ? this.provisional(deviceId) : undefined;
    const publicKey = device?.relay_public_key ?? waiting?.key;
    if (publicKey === undefined || (device !== undefined && this.stale(device))) return null;
    const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
    try {
      const key = await crypto.subtle.importKey("spki", Buffer.from(publicKey, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signed, message);
      // a log that turned strict while the proof was checked refuses it too (S19)
      if (this.failsClosed) return null;
      // the row went, or linked, while its signature was checked: the proof was for a row that is no more
      if (waiting !== undefined) return verified && this.provisional(deviceId) === waiting ? { id: waiting.id, label: waiting.label, role: "watch" } : null;
      // Authorization changes during WebCrypto invalidate the proof; a rename does not.
      const current = this.devices.find((d) => d.id === deviceId);
      if (!verified || !current || device === undefined || current.role !== device.role || current.relay_public_key !== device.relay_public_key) return null;
      this.noteSeen(current, now);
      return { id: current.id, label: current.label, role: current.role };
    } catch (error) {
      if (error instanceof DOMException) return null;
      throw error;
    }
  }

  match(token: string | undefined, now = Date.now()): DeviceMatch | null {
    this.pruneUnconfirmedFirstPairs(now);
    if (!token || this.failsClosed) return null;
    const digest = hash(token);
    const candidateIndex = this.unconfirmedFirstPairs.findIndex(({ device }) => same(digest, device.token_hash));
    if (candidateIndex !== -1) {
      const { device: candidate, origin } = this.unconfirmedFirstPairs[candidateIndex]!;
      const confirmed = this.admitted({ ...candidate, last_seen_at: new Date(now).toISOString() }, now);
      this.journalAdmission(confirmed);
      const next = [...this.devices, confirmed];
      const gate = this.gateClosedAt ?? confirmed.created_at;
      // This is an authorization write, not last-seen telemetry: do not match the cookie
      // unless the device and closed gate reached disk together.
      this.save(next, gate);
      this.devices = next;
      this.gateClosedAt = gate;
      // Once one first-pair cookie closes the gate, every sibling candidate is stale:
      // subsequent devices must be issued through the gated pairing flow.
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
    } catch { /* last-seen telemetry must not deny an otherwise valid credential */ }
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

  /** Hears of every device that lost its access, after the write that took it (DeviceRemovedEvent). */
  onRemoved(listener: (event: DeviceRemovedEvent) => void): () => void {
    this.removals.add(listener);
    return () => { this.removals.delete(listener); };
  }

  private announceRemoval(device: StoredDevice, by: DeviceRemovedEvent["by"]): void {
    const event: DeviceRemovedEvent = { type: "device-removed", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, removed_at: new Date().toISOString(), ...(by === undefined ? {} : { by }) };
    if (this.safety === null) { for (const listener of [...this.removals]) listener(event); return; }
    for (const listener of [...this.removals]) {
      try { listener(event); } catch (error) { console.warn(`[devices] a removal listener failed: ${describe(error)}`); }
    }
  }

  /**
   * An admission's journal entry, on disk before its row (G14): a journal that cannot be written throws, and nobody
   * is admitted. Then every listener hears it, each on its own.
   */
  private journalAdmission(device: StoredDevice): void {
    if (this.journal === null) return;
    this.publish(this.journal.append({ kind: "admit", how: device.origin?.how ?? "code", key: device.relay_public_key ?? null, no: device.origin?.admit_no ?? null, row: device.id, label: device.label, by: device.added_by ?? null, account: device.account ?? null }));
  }

  /** A removal's journal entry, after its deny (P8 step 4). A journal that cannot be written stops no removal. */
  private journalRemoval(device: StoredDevice, by: DeviceRemovedEvent["by"]): void {
    if (this.journal === null) return;
    try {
      this.publish(this.journal.append({ kind: "remove", how: typeof by === "object" ? "member" : "pc", key: device.relay_public_key ?? null, no: device.origin?.admit_no ?? null, row: device.id, label: device.label, by: typeof by === "object" ? by.device_id : null, account: device.account ?? null }));
    } catch (error) { console.error(`[devices] the removal of ${device.id} could not be journalled: ${describe(error)}`); }
  }

  private publish(entry: JournalEntry): void {
    for (const listener of [...this.noticeListeners]) {
      try { listener(entry); } catch (error) { console.warn(`[devices] a notice listener failed: ${describe(error)}`); }
    }
  }

  /** Hears every journal entry once it is on disk, to send it to the rows connected now (P10). */
  onNotice(listener: (entry: JournalEntry) => void): () => void {
    this.noticeListeners.add(listener);
    return () => { this.noticeListeners.delete(listener); };
  }

  /** Whether the row `id` is told of `entry`: entries about rows that joined this PC after it (T57); a row with no age hears none. */
  private tells(id: string, entry: JournalEntry): boolean {
    const row = this.devices.find((d) => d.id === id);
    if (row?.origin === undefined || entry.row === id) return false;
    if (row.origin.from === "legacy") return true;
    return entry.no !== null && row.origin.admit_no < entry.no;
  }

  /** The notice of `entry` for the row `id`, or null when that row is not told of it. */
  noticeFor(id: string, entry: JournalEntry): DeviceNotice | null {
    return this.journal !== null && this.tells(id, entry) ? this.journal.notice(entry) : null;
  }

  /** What the row `id` is told at its connect, before anything else on its stream (T57); null with no journal. */
  noticeReplay(id: string): NoticeReplay | null {
    return this.journal === null || !this.has(id) ? null : this.journal.replay(id, (entry) => this.tells(id, entry));
  }

  /** The row `id` saw up to `seq`: it decides nothing (T57). */
  noticeSeen(id: string, seq: number): void {
    if (this.journal !== null && this.has(id)) this.journal.ack(id, seq);
  }

  openNotices(): readonly JournalEntry[] { return this.journal?.openNotices() ?? []; }

  revoke(id: string, by: DeviceRemovedEvent["by"] = "pc"): boolean {
    this.assertWritable();
    const target = this.devices.find((d) => d.id === id);
    if (!target) return false;
    if (this.evidence !== null) {
      const key = target.relay_public_key;
      const rows = this.devices.filter((d) => d === target || (key !== undefined && d.relay_public_key === key));
      const denied = this.deny(key === undefined ? [] : [key], () => this.tombstone([target], Date.now()));
      if (key !== undefined) this.dropWaiting([key]);
      // a deny not on disk writes nothing else: the row stays where a restart still shows the Revoke failed (P8)
      if (denied !== null) { this.keepOut(rows); throw denied; }
      this.drop(rows, by);
      return true;
    }
    // a revoke on this PC wins over the account: its key cannot come back by a record (docs/account.md, rule 1)
    this.tombstone([target], Date.now());
    // the key's other rows that tombstone takes go with it now, as the next start would take them (finishInterruptedWrites)
    const key = target.relay_public_key;
    this.drop(this.devices.filter((d) => d === target || (key !== undefined && d.relay_public_key === key && this.stale(d))), by);
    return true;
  }

  /** The rows `gone` lose their access in one write; their sessions close and each removal is announced. */
  private drop(gone: readonly StoredDevice[], by: DeviceRemovedEvent["by"]): void {
    if (this.evidence !== null) { this.dropBeforeWrite(gone, by); return; }
    const next = this.devices.filter((d) => !gone.includes(d));
    // A valid older/manual registry can have devices without a gate timestamp. Removing its
    // last device must still leave durable evidence that this store was once gated.
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    // A code the device started or was handed goes with it. Whoever it passed the code to would otherwise pair after
    // it was removed, on a PC in no account with nobody approving (a member's code already needs its member)
    if (gone.some((d) => this.pending?.holders.has(d.id))) this.endPairing(undefined, "revoked");
    for (const device of gone) {
      const listeners = this.revocations.get(device.id);
      this.revocations.delete(device.id);
      for (const close of listeners ?? []) close();
    }
    for (const device of gone) this.announceRemoval(device, by);
  }

  /**
   * Told on every revokeAll, after the empty registry is saved: a relay pairing by comparing digits
   * that is still under way (server/relay/session.ts) ends there, approved or not, so no device is
   * made from a comparison the owner's "revoke all" came after.
   */
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
    if (this.evidence !== null) return this.revokeAllInOrder();
    this.tombstone(this.devices, Date.now());
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.save([], gate);
    const gone = this.devices;
    const revoked = this.devices.map((device) => device.id);
    this.devices = [];
    this.gateClosedAt = gate;
    this.voidPending("revoked");
    this.unconfirmedFirstPairs = [];
    // the PC leaves its account with every row (P8, P12); one that could not be written keeps the PC bound, never less
    let unbound: unknown = null;
    try { this.clearAccountBinding("revoke_all", "pc"); }
    catch (error) {
      // the PC fails closed until its account state is written: Revoke all is not reported done (S19)
      unbound = error;
      this.pc?.unwritten(error);
      console.error(`[devices] Revoke all could not clear this PC's account: ${error instanceof Error ? error.message : String(error)}`);
    }
    const listeners = [...this.revocations.values()];
    this.revocations.clear();
    for (const closes of listeners) for (const close of closes) close();
    for (const listener of [...this.revokeAllListeners]) listener();
    for (const device of gone) this.announceRemoval(device, "pc");
    if (unbound !== null) throw unbound;
    return revoked;
  }

  has(id: string): boolean { return this.devices.some((device) => device.id === id); }

  /** Whether the device may answer a pane's prompt: paired to drive, not to watch. */
  canDrive(id: string): boolean { return this.devices.some((device) => device.id === id && device.role === "drive"); }

  private pruneUnconfirmedFirstPairs(now: number): void {
    this.unconfirmedFirstPairs = this.unconfirmedFirstPairs.filter(({ expires }) => now <= expires);
  }

  /**
   * P8 step 1, the deny on disk with `gen` raised. One that cannot be written still lets the caller close what it
   * removes, and makes this PC fail closed until a later deny is written; returned, never acknowledged.
   */
  private deny(keys: readonly string[], write: () => void): Error | null {
    try {
      write();
      this.pc?.raiseGen();
      if (this.evidence?.onDisk === true) this.pc?.noteEvidenceWritten();
      // only the deny of the very key that failed ends its closing, and never while a Revoke all is unfinished on disk
      for (const key of keys) this.failedDenies.delete(key);
      this.settleDenies();
      return null;
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      for (const key of keys) this.failedDenies.add(key);
      this.denyProblem = `A removal could not be written (${failed.message}): only this PC itself gets in until one is.`;
      return failed;
    }
  }

  /** Keys whose deny could not be written this run: their rows stay on disk, out of every session here (P8). */
  private readonly failedDenies = new Set<string>();

  /** Rows, keyed or not (cookie rows), whose removal was not written this run: out until their own removal lands (P8). */
  private readonly failedRows = new Set<string>();

  /** The PC opens again only when no failed key, no failed row and no unfinished Revoke all is left (P8, S19). */
  private settleDenies(): void {
    if (this.failedDenies.size === 0 && this.failedRows.size === 0 && !existsSync(this.revokeAllPath)) this.denyProblem = null;
  }

  /**
   * A deny that did not land: its rows' sessions end and the rows are out for this run; nothing is written (P8). An
   * account removal's rows are kept out by their key (failedDenies) alone, since which rows it covers is not known.
   */
  private keepOut(rows: readonly StoredDevice[], byRow = true): void {
    for (const device of rows) {
      if (byRow) this.failedRows.add(device.id);
      const listeners = this.revocations.get(device.id);
      this.revocations.delete(device.id);
      for (const close of listeners ?? []) close();
    }
  }

  /**
   * P8 steps 2 to 5 for rows the deny already covers: the gate in memory, the rows out of memory, their sessions and
   * codes ended, each removal told; then the registry write, whose failure is thrown only after all of that.
   */
  private dropBeforeWrite(gone: readonly StoredDevice[], by: DeviceRemovedEvent["by"]): void {
    if (gone.length === 0) return;
    const next = this.devices.filter((d) => !gone.includes(d));
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.devices = next;
    this.gateClosedAt = gate;
    if (gone.some((d) => this.pending?.holders.has(d.id))) this.endPairing(undefined, "revoked");
    for (const device of gone) {
      const listeners = this.revocations.get(device.id);
      this.revocations.delete(device.id);
      for (const close of listeners ?? []) close();
    }
    for (const device of gone) this.journalRemoval(device, by);
    // the registry write is these rows' own deny when they hold no key (cookie rows): one that fails keeps them out for
    // this run and the PC closed until a write lands (P8, S19); a removal is told once the write is tried (P8 step 5)
    try { this.save(next, gate); } catch (error) {
      for (const device of gone) this.failedRows.add(device.id);
      this.denyProblem = `A removal could not be written (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until one is.`;
      throw error;
    }
    // the removal is on disk: those rows' own failures end, and only now is it told (P8 step 5)
    for (const device of gone) this.failedRows.delete(device.id);
    this.settleDenies();
    for (const device of gone) this.announceRemoval(device, by);
  }

  /**
   * Revoke all in P8's order: `revoke-all.json` first, then the gate, the codes, the candidates and every row out of
   * memory with its sessions, then the evidence, the empty registry and the PC's account. A write that fails is thrown
   * after the closing; the file stays, and the next start finishes the work before serving (T20).
   */
  private revokeAllInOrder(): string[] {
    const now = new Date().toISOString();
    // the file names every row it covers, a pending one's too, so it is finished from itself and never from less (T20)
    const gone = this.revokeAllRows();
    const gateWasOpen = !this.rawGated;
    const denied = this.deny(gone.flatMap((d) => d.relay_public_key ?? []), () => writePrivateState(this.revokeAllPath, { id: randomBytes(16).toString("hex"), by: "pc", at: now, rows: gone }));
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? now;
    // a file that could not be written holds nothing: the rows stay where the next Revoke all finds them, out of every
    // session meanwhile, and the PC closed (P8, T20)
    if (denied !== null) {
      this.keepOut(gone);
      this.gateClosedAt = gate;
      this.voidPending("revoked");
      this.unconfirmedFirstPairs = [];
      if (gateWasOpen) this.tellGateClosed();
      throw denied;
    }
    this.devices = [];
    this.gateClosedAt = gate;
    this.voidPending("revoked");
    this.unconfirmedFirstPairs = [];
    const listeners = [...this.revocations.values()];
    this.revocations.clear();
    for (const closes of listeners) for (const close of closes) close();
    for (const listener of [...this.revokeAllListeners]) listener();
    // a gate that was open closes here, whatever the writes below do: what the open LAN let in ends (T3)
    if (gateWasOpen) this.tellGateClosed();
    if (denied !== null) throw denied;
    for (const device of gone) this.announceRemoval(device, "pc");
    for (const device of gone) this.journalRemoval(device, "pc");
    // its intent is on disk: any write after it that fails leaves the PC closed until a start finishes it (P8, T20)
    try { this.finishRevokeAll(gone, gate); } catch (error) {
      this.denyProblem = `Revoke all could not be finished (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until it is.`;
      this.pc?.unwritten(error, "Revoke all could not clear this PC's account");
      throw error;
    }
    return gone.map((device) => device.id);
  }

  /** The writes of a Revoke all whose file is on disk: its Revokes, the empty registry, the PC's account; then the file goes. */
  private finishRevokeAll(rows: readonly StoredDevice[], gate: string): void {
    this.tombstone(rows, Date.now());
    this.save([], gate);
    this.devices = [];
    this.gateClosedAt = gate;
    // the file goes only once the PC has left its account: a binding that cannot be read keeps it (P12)
    if (this.pc?.strict != null) throw new Error(this.pc.strict);
    this.clearAccountBinding("revoke_all", "pc");
    rmSync(this.revokeAllPath, { force: true });
    // every row and key it covered is revoked on disk now: their earlier failures end
    for (const row of rows) {
      this.failedRows.delete(row.id);
      if (row.relay_public_key !== undefined) this.failedDenies.delete(row.relay_public_key);
    }
    this.settleDenies();
    // the tombstone file follows the evidence once nothing keeps account records refused any more (P13)
    if (this.evidence?.strict === null && this.accountError === null) this.refreshTombstones();
  }

  /** The rows a Revoke all covers: those its pending file names, and every row this store holds now (T20). */
  private revokeAllRows(): StoredDevice[] {
    let named: StoredDevice[] = [];
    try {
      const doc = JSON.parse(readFileSync(this.revokeAllPath, "utf8")) as { rows?: unknown };
      if (Array.isArray(doc.rows)) named = doc.rows.filter((row): row is StoredDevice => typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string");
    } catch { /* no pending file, or one that names no rows: the rows held now */ }
    return [...named.filter((row) => !this.devices.some((d) => d.id === row.id)), ...this.devices];
  }

  private save(devices = this.devices, gateClosedAt = this.gateClosedAt): void {
    const closes = !this.rawGated && (gateClosedAt !== null || devices.length > 0);
    writePrivateState(this.path, { gate_closed_at: gateClosedAt, devices });
    // The write that closes the gate: onGateClosed. Told once the caller has set the store's own fields, which each
    // does right after this returns, and before anything else of this process runs (no frame of a connection is
    // read in between). Each on its own: one that throws ends neither the others nor the pairing that closed the gate.
    if (closes) this.tellGateClosed();
  }

  private tellGateClosed(): void {
    queueMicrotask(() => {
      for (const listener of [...this.gateListeners]) {
        try { listener(); } catch (error) { console.warn(`[devices] ending what the open LAN let in failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }

  /** The drive member of `account` whose key is `key`, the only signer whose `add` or `remove` applies. */
  /** The member of `account` holding `key`: a drive one, unless `anyRole` (a device signing its own leave). */
  accountSigner(key: string, account: string, anyRole = false): DeviceMatch | null {
    const device = this.devices.find((d) => d.relay_public_key === key && d.account === account && (anyRole || d.role === "drive") && !this.stale(d));
    return device ? { id: device.id, label: device.label, role: device.role } : null;
  }

  accountRows(): { members: number; unlinked: string[]; own_word: string[] } {
    const groups = this.accountGroups();
    return {
      members: this.devices.filter((d) => d.account !== undefined).length,
      unlinked: groups.unlinked.map((d) => d.id), own_word: groups.own_word.map((d) => d.id),
    };
  }

  /**
   * The rows the owner is shown apart (/api/account/status, the owner's /api/health, `ovis status`): relay rows in no
   * account, and members whose link was on their own word (`joined_by`). A row is in one of them at most.
   */
  accountGroups(): { unlinked: { id: string; label: string }[]; own_word: { id: string; label: string }[] } {
    const shown = (d: StoredDevice) => ({ id: d.id, label: d.label });
    return {
      unlinked: this.devices.filter((d) => d.account === undefined && d.relay_public_key !== undefined).map(shown),
      own_word: this.devices.filter((d) => d.account !== undefined && d.joined_by !== undefined && !VOUCHED.has(d.joined_by)).map(shown),
    };
  }

  isTombstoned(key: string): boolean { return this.tombstones.some((t) => t.key === key); }

  /** Whether an account's removal keeps `key` out (the tombstone of a `remove`), not only a revoke made on this PC. */
  removedByAccount(key: string): boolean { return this.tombstones.some((t) => t.key === key && t.record_id !== "local"); }

  /** Every key this PC keeps out, signed removal or not (a Revoke here, a record that no longer parses): /api/account/status `blocked`. */
  tombstoneKeys(): string[] { return [...new Set(this.tombstones.map((t) => t.key))]; }

  /** The signed `add`s behind this PC's account rows, as received: what /api/account/status lists. One that no longer parses or names another key is left out. */
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

  /**
   * Keeps `record` on the row it is for when that row's approver signed it and none is kept yet: the
   * approver of a remote approval hands its add to this PC too (an `unchanged` add), so the PC can
   * list it for a client to pass on.
   */
  keepAccountAdd(record: AddRecord, signerId: string): void {
    const device = this.devices.find((d) => d.relay_public_key === record.key && d.added_by === signerId && (d.account_add === undefined || (d.account_add as { key?: unknown }).key !== d.relay_public_key) && !this.stale(d));
    if (!device) return;
    const next = this.devices.map((d) => d === device ? { ...d, account_add: record } : d);
    this.save(next);
    this.devices = next;
  }

  /** The signed `remove`s behind this PC's tombstones for its account, as received: what /api/account/status lists. One that no longer parses is left out. */
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

  /** An `add` that verified: a new member row, announced like any other enrollment. Never for a tombstoned key. */
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
    // another key joined the account: the PC has had other devices, for good (T67, H2)
    if (this.pc !== null && this.pc.first()?.key !== entry.key) this.pc.setOthersEver();
    return { id: device.id, label: device.label, role: device.role };
  }

  /**
   * A `remove` that verified: the tombstone is written first, so a crash between the two writes
   * leaves the key refused; then the rows that wait to link with the key go (dropWaiting), and every
   * row holding the key is revoked, closing its sessions.
   */
  removeAccountKey(key: string, account: string, record: { id: string; issuedAt: string; by?: { device_id: string; label: string }; signed?: RemoveRecord }, now = Date.now()): boolean {
    // a deny that failed earlier does not keep a removal from trying again: its landing is what ends the closing (P8)
    if (this.evidence !== null) {
      this.assertWritable();
      const refused = this.safety?.strict ?? this.pc?.strict ?? this.evidence.strict ?? this.accountProblem;
      if (refused !== null) throw new Error(refused);
    } else this.assertAccountWritable();
    if (this.evidence !== null) {
      // account-scoped evidence first, whatever rows this PC holds and with no time compared (T16 in 2d); every row
      // it covers goes, row by row, and a Revoke this PC made is never coalesced into it (T22)
      let added = false;
      const denied = this.deny([key], () => {
        added = this.evidence!.addRemoval(key, account, { id: record.id, at: new Date(now).toISOString(), ...(record.signed ? { records: [record.signed] } : {}) });
        this.refreshTombstones();
      });
      this.dropWaiting([key]);
      // with no deny on disk the evidence cannot say which rows it covers: every row of the key goes for this run
      if (denied !== null) { this.keepOut(this.devices.filter((d) => d.relay_public_key === key), false); throw denied; }
      const gone = this.devices.filter((d) => d.relay_public_key === key && this.coveredByEvidence(d));
      this.drop(gone, record.by);
      return added || gone.length > 0;
    }
    // a pairing of this key made on this PC after the removal was signed wins: a replayed or late remove
    // leaves it and its key be, and takes only the key's other rows. Any other row goes, however late the remove
    // arrives (pairedHere).
    const newer = (d: StoredDevice) => d.relay_public_key === key && pairedHere(d) && this.later(d.created_at, record.issuedAt);
    if (this.devices.some(newer)) {
      const gone = this.devices.filter((d) => d.relay_public_key === key && !newer(d));
      if (gone.length) this.drop(gone, record.by);
      return gone.length > 0;
    }
    const recordId = record.id;
    const fresh = !this.isTombstoned(key);
    const removal: AccountTombstone = { key, account, record_id: recordId, removed_at: new Date(now).toISOString(), ...(record.signed ? { records: [record.signed] } : {}) };
    const kept = this.tombstones.find((t) => t.key === key);
    if (fresh) this.writeTombstones([...this.tombstones, removal]);
    // a key this PC revoked first becomes the account's removal, so a code started through the relay cannot bring it back
    else if (kept?.record_id === "local") this.writeTombstones(this.tombstones.map((t) => t.key === key ? removal : t));
    // another signer's removal of a removed key is kept beside the first, for a PC where only that signer is a member (#2956)
    else if (kept && record.signed && kept.account === account) {
      const records = withRecords(kept.records, [record.signed]);
      if ((records?.length ?? 0) !== (kept.records?.length ?? 0)) this.writeTombstones(this.tombstones.map((t) => t === kept ? { ...t, ...(records ? { records } : {}) } : t));
    }
    this.dropWaiting([key]);
    const ids = this.devices.filter((d) => d.relay_public_key === key).map((d) => d.id);
    for (const id of ids) this.revoke(id, record.by);
    return fresh || ids.length > 0;
  }

  /**
   * A `link` the device `deviceId` sent over its own session `sessionId`: its row takes `key` and joins
   * `account` in one write. The row's other sessions signed in with a key it no longer has, so they end
   * (`auth_changed`); the linking one goes on until it signs in again with the new key. A row that waits to link
   * is no device yet: its link makes it one (promote).
   */
  linkAccountKey(deviceId: string, oldKey: string, key: string, account: string, sessionId = "", vouched = false): PairedDevice | null {
    this.assertAccountWritable();
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key === oldKey);
    if (!device) return this.promote(deviceId, { oldKey, key, account }, sessionId, vouched);
    const moved = key !== oldKey || device.link_moved_key === true;
    // the link that takes a row from no account into one is on the device's own word unless a member of that same
    // account approved its pairing: a code started by a device outside the account names its starter in `added_by` and
    // approves nothing, and an approval for another account does not carry over
    const ownWord = device.account === undefined && device.member_approved_in !== account;
    const linked: StoredDevice = { ...device, relay_public_key: key, account, linked_at: new Date().toISOString(), link_moved_key: moved, ...(ownWord ? { joined_by: vouched ? "service" as const : "word" as const } : {}) };
    // a link that moves the key admits a key: a new place in this PC's order, never the old row's (P22, T11 in 2d)
    // the new key has no age of the key before it, flag on or off, until this PC numbers it (P22)
    const { origin: _oldKeys, ...movedKey } = linked;
    const updated = key !== oldKey ? this.admitted(movedKey, Date.now()) : linked;
    const next = this.devices.map((d) => d === device ? updated : d);
    this.bindingWith(account, key, () => this.save(next));
    this.devices = next;
    this.endNoAccountCode();
    for (const listener of [...this.relinks.get(deviceId) ?? []]) listener(sessionId);
    return this.list(null).find((d) => d.id === deviceId) ?? null;
  }

  /** A pairing of a key on this PC names the account removals it knew (`paired_over`), and stands over them (P13, T23). */
  private knowingRemovals(device: StoredDevice): StoredDevice {
    if (this.evidence === null || device.relay_public_key === undefined || !pairedHere(device)) return device;
    const over = this.evidence.pairedOver(device.relay_public_key);
    return over.length ? { ...device, paired_over: over } : device;
  }

  /**
   * A pairing made on this PC (a code, or a comparison approved here) lets a removed key back in. With removal
   * evidence it ends the Revokes of the key by name and leaves the account's markers standing (T21, T23).
   */
  private clearTombstone(key: string): void {
    if (this.evidence !== null) {
      if (this.accountError !== null) return;
      this.evidence.unrevoke(key, "pc", Date.now());
      this.refreshTombstones();
      return;
    }
    if (this.accountError !== null || !this.isTombstoned(key)) return;
    this.writeTombstones(this.tombstones.filter((t) => t.key !== key));
  }

  /**
   * Tombstones for the relay keys of rows this PC revokes, written before the revoke itself. The rows that wait to
   * link with one of those keys go next, before the revoke as well (dropWaiting).
   */
  private tombstone(rows: readonly StoredDevice[], now: number): void {
    // each Revoke is its own evidence, also of a key that already has a tombstone, and also while the tombstone files
    // cannot be read, so it outlives their repair (P13)
    // a Revoke is stamped after every row this store holds, whatever the wall clock says (P13)
    if (this.evidence !== null) now = Date.parse(this.nextStamp(now));
    if (this.evidence !== null && this.evidence.strict === null) {
      for (const key of new Set(rows.flatMap((d) => d.relay_public_key ?? []))) this.evidence.addRevoke(key, rows.find((d) => d.relay_public_key === key)?.account ?? null, now);
    }
    // the evidence holds the Revoke when it is sound; a tombstone file that cannot be read is left as it is (S19)
    if (this.evidence !== null && this.evidence.strict === null) {
      if (this.accountError === null) this.refreshTombstones();
      this.dropWaiting(rows.flatMap((d) => d.relay_public_key ?? []));
      return;
    }
    // evidence that cannot be trusted holds nothing: the Revoke leaves main's tombstone, which keeps the key out at once
    // (stale) and becomes a Revoke at the first start that takes the evidence in (P13, rule 1)
    const keys = [...new Set(rows.flatMap((d) => d.relay_public_key === undefined || this.isTombstoned(d.relay_public_key) ? [] : [d.relay_public_key]))];
    const removedAt = new Date(now).toISOString();
    const next = [...this.tombstones,
      ...keys.map((key) => ({ key, account: rows.find((d) => d.relay_public_key === key)?.account ?? "", record_id: "local", removed_at: removedAt }))];
    if (keys.length) {
      // with the main file unreadable the revoke still wins: its tombstone waits beside it
      if (this.accountProblem !== null) {
        writePrivateState(this.pendingTombstonePath, { v: 1, tombstones: next });
        this.tombstones = next;
      } else this.writeTombstones(next);
    }
    this.dropWaiting(rows.flatMap((d) => d.relay_public_key ?? []));
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
    // the LAN HTTPS listener counts its wrong codes like the relay does, apart from it
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
    // how the other devices are connected, and pinging them all, is for a caller that may manage them:
    // not a watching device, nor a Portal visitor, who see the list as before
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
    // a code admits whoever holds it, so through the relay to a PC in an account only those who may approve a pairing
    // may start one; a PC in no account keeps letting any driving relay device start one, as before
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "Start a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    try {
      const remote = access.level === "full" && access.via === "relay";
      // its starter is recorded as the new device's adder; on a PC in an account that starter must stay a member
      const startedBy = remote ? access.device?.id ?? null : null;
      // the paired device that asks, through the relay or at this PC's own address: the code goes when it is revoked
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
    // whoever may start a code may take it back (the same rule as /pair/start)
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "End a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    const text = await request.text();
    let body: unknown = {};
    try { if (text.trim() !== "") body = JSON.parse(text); } catch { return badRequest("invalid_json", "request body must be JSON"); }
    if (!isJsonObject(body)) return badRequest("invalid_body", "code must be the six-digit pairing code");
    const { code, id } = body;
    if (code !== undefined && (typeof code !== "string" || !/^\d{6}$/.test(code))) return badRequest("invalid_body", "code must be the six-digit pairing code");
    if (id !== undefined && (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))) return badRequest("invalid_body", "id must be the pairing's id");
    const match = code === undefined && id === undefined ? undefined : { ...code !== undefined ? { code } : {}, ...id !== undefined ? { id } : {} };
    return jsonResponse({ ok: true, cancelled: store.endPairing(match) }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/api/devices/revoke-all") {
    setRequestRoute("/api/devices/revoke-all");
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const revoked = store.revokeAll();
    onRevoked?.(revoked);
    // the caller's own device cookie, if it holds one, names a device that is gone, under either name
    const answer = jsonResponse({ revoked: revoked.length } satisfies DevicesRevokedAll, 200, { "cache-control": "no-store" });
    answer.headers.append("set-cookie", DEVICE_COOKIE_CLEARED);
    answer.headers.append("set-cookie", CLEAR_LEGACY_DEVICE_COOKIE);
    return answer;
  }
  const id = pathname.slice("/api/devices/".length);
  setRequestRoute("/api/devices/:device_id");
  if (!/^[0-9a-f]{16}$/.test(id)) return badRequest("invalid_device", "no such device");
  if (request.method === "DELETE") {
    // `x-ovis-unless-account`: the caller removes the device because it is no member of that account (`ovis add`,
    // of a device its code let in). One that became a member of it since the caller read the list stays. The check
    // and the revoke are one step here, so no link comes between them. Membership is what the row says: a first
    // member linked itself and named its account, which nothing here proves (docs/account.md, rule 4)
    const unless = request.headers.get("x-ovis-unless-account");
    if (unless !== null && store.isMemberOf(id, unless)) return jsonResponse({ error: { code: "account_member", message: "that device is a member of the account by now" } }, 409);
    // a revoke takes the key's other rows too (DeviceStore.revoke): each one's cleanup runs, not the named row's alone
    const removed: string[] = [];
    const unlisten = store.onRemoved((event) => removed.push(event.device_id));
    let revoked: boolean;
    try { revoked = store.revoke(id, access.level === "full" && access.device ? { device_id: access.device.id, label: access.device.label } : "pc"); }
    finally { unlisten(); }
    if (!revoked) return jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
    onRevoked?.(removed);
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
