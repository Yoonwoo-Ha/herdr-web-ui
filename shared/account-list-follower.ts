/**
 * Following a list: how one member (a device or a PC) gets from the copy it has saved, and what the account
 * service or another member has just handed it, to what it now holds as true. The entry, the signers and the
 * kinds are under it (shared/account-list-entry.ts, -signers.ts, shared/account-list.ts; docs/account-list.md,
 * "Following a list"), and it changes none of their rules: every entry is taken by shownList and replayList.
 *
 * The account service stores the log and may lie, withhold, replay or show two members two histories. So
 * nothing here takes its word for who is in: a page is entries that verify themselves and a head that is held
 * against the member's own copy. What a member lets in is read from its copy alone (admitsSession, pcOfKey,
 * shownPcs), which a service that is away, slow or lying never shortens.
 *
 * No I/O, no storage, no clock and nothing random: the caller hands over the saved text, the page, the hour
 * (seconds since 1970) and what happened, and gets back the new copy, what changed and what to do next.
 *
 * A caller's loop: followStep says when to read. A read is startRead, then for each answer takePage, whose
 * copy is saved (writeSave) before anything acts on it and whose `read` is the next request, until it is null.
 * Two members that are connected exchange gossipHead, and each does what compareHeads says with the other's:
 * the one asked answers with servePage, and the answer is taken by takePage like any page.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ListEntryError, entryFromText, entryHash, isListHash, readBody, verifySignature, type Entry, type EntryBody, type ListRefusalCode } from "./account-list-entry.ts";
import { signerPower, type ListPlace } from "./account-list-signers.ts";
import {
  LIST_LEVEL, admitsDevice, isListKey, listClock, listView, replayList, shownList,
  type DeviceView, type ListCopy, type ListRole, type ListState, type PcView,
} from "./account-list.ts";

/**
 * The save's version, which counts the forms of the save itself: its members and what each means. A build
 * reads its own version and every earlier one, each by replaying its entries, and no later one. What the state
 * in a save holds is the kinds' own and is no part of the version: a state is read back by replay whatever a
 * build saved in it (readSave).
 */
export const FOLLOWER_SAVE_VERSION = 1;
/** A save's sum is SHA-256 over these bytes and the save's text without the sum. */
export const LIST_SAVE_PREFIX = "ovis-list-save/1";
/** The most entries a copy holds: the account service places none from this place on, so a log shown past it is not an honest one. */
export const LIST_ENTRIES_MAX = 20480;
/** A PC reads this often by the clock, in seconds, and this often while a session is open. */
export const PC_READ_SECONDS = 300;
export const PC_BUSY_READ_SECONDS = 30;
/** A device reads this often while its app is in front. Behind, it reads only when it is rung. */
export const DEVICE_READ_SECONDS = 30;
/** A PC lets a new session in on its copy as it is when its last full read is no older than this. */
export const FRESH_SECONDS = 30;
/** How long a new session waits for a read that was due, before the PC decides on its copy as it is. */
export const SESSION_WAIT_SECONDS = 5;
/** The most entries of one page that are read: the account service shows no more, and a longer page is read up to here. */
export const PAGE_ENTRIES_MAX = 256;
/** The most pages one read asks for: what is left is asked at the member's next read, from where this one came to. */
export const READ_PAGES_MAX = 128;
/** The most entries a copy keeps past its footing. An honest log has none there: each is one that no signer signed. */
export const LOOSE_ENTRIES_MAX = 16;

/** Who follows: its signing key, and for a PC its relay key (`endpoint`), null for a device. */
export interface FollowerSelf {
  readonly key: string;
  readonly endpoint: string | null;
}

/**
 * Why a member follows this list id and no other: where the id came from, and what the list must show before
 * the member acts on it. The id never comes from the account service's word.
 *
 * - `genesis`: a device that made entry 0 itself. The list must show its key as the first signer.
 * - `allowed`: a device that a member allowed, which handed it its own head `(seq, hash)` with the list id. The
 *   log must reach that very entry, and the list must show the device's key as a device.
 * - `carried`: a device that was in the account before it had a list. The list must show its key as carried
 *   in. Nothing in the list proves this id to such a device: its caller pins when a PC the device had paired
 *   with itself names the same list id (compareHeads), or at once where the account has no PC to ask.
 * - `added`: a PC that a person's `pc` or an invite's `join` adds. The list must show its relay key with its
 *   own signing key.
 * - `migrated`: a PC that was in the account before it had a list. `admitted` is the device keys it let in on
 *   that account then, by its own state: entry 0's signer must be one of them, and so must every device that
 *   was carried in, all or none. A carried key is a signer of power `full`, so one the PC never let in could
 *   add whom it likes: a list that carries one in is not a list this PC follows.
 */
export type ListPin =
  | { readonly how: "genesis" }
  | { readonly how: "allowed"; readonly seq: number; readonly hash: string }
  | { readonly how: "carried" }
  | { readonly how: "added" }
  | { readonly how: "migrated"; readonly admitted: readonly string[] };

export type ListSource = "service" | "peer";

/**
 * Two histories from one place, each signed by a member: proven, never taken on a word. `seq` is the place
 * where they part, and `by` the key that signed the other history from there: a key that the member's own
 * history had made a signer before that place, whatever became of it since. `devices` and `pcs` are whom the
 * member held when it rose: from then on it lets in only those of them that are still in. It is never cleared
 * but by a person's reset at the member, which then pins again.
 */
export interface ListAlarm {
  readonly code: "fork";
  readonly source: ListSource;
  readonly seq: number;
  readonly by: string;
  readonly at: number;
  readonly devices: readonly string[];
  readonly pcs: readonly string[];
}

/**
 * What a member saves, whole. `list` is its pin: no function here gives a copy of another list. `entries` and
 * `state` are the kinds' own copy (ListCopy), both empty until entry 0 is read. `stop` is the text of the entry
 * a member that is behind stopped at, kept for the replay after an update. `read_at` is when it last held
 * everything the account service showed, in seconds, or null. `seen_at` is the latest hour its own clock showed
 * when it took a page or a hint, or null: its clock never counts for less than that (memberClock).
 */
export interface FollowerCopy {
  readonly account: string;
  readonly list: string;
  readonly me: FollowerSelf;
  readonly pin: ListPin;
  readonly entries: readonly string[];
  readonly state: ListState | null;
  readonly stop: string | null;
  readonly read_at: number | null;
  readonly seen_at: number | null;
  readonly alarm: ListAlarm | null;
}

/**
 * - `waiting`: nothing is read yet, or the list does not show yet what the pin asks for.
 * - `in`: the member follows and is in.
 * - `out`: an entry put this member out. A PC drops what it let in by the list; nothing here lets it in again.
 * - `stopped`: it stopped at an entry this build cannot place, and answers for nobody until an update replays.
 */
export type Standing = "waiting" | "in" | "out" | "stopped";

/** A request for a part of the log: what to ask, and what one read has done so far. Made by startRead and by each page; never saved. */
export interface FollowRead {
  readonly source: ListSource;
  readonly list: string;
  /** The place the next page follows, the caller's own number; null for a page from entry 0. */
  readonly after: number | null;
  /** This read went back to the footing once: a second other continuation waits for the next read. */
  readonly back: boolean;
  /** How many more requests this read may make after this one (READ_PAGES_MAX in all), whatever its pages say. */
  readonly left: number;
}

/** What a peer is asked: the wire form of a read. */
export type PeerAsk = Pick<FollowRead, "list" | "after">;

/** One answer: the entries after a place, and the head of whoever answers. `list` and `after` are the answer's own word and are only held against what was asked. */
export interface ListPage {
  readonly list?: string;
  readonly after?: number | null;
  readonly entries: readonly string[];
  readonly head: ListPlace;
}

/**
 * What came of one page.
 *
 * - `caught_up`: the member holds every entry up to the head it was shown.
 * - `more`: it took what it was shown and the head lies further: ask `read` at once.
 * - `asks_after`: another continuation above its footing: ask `read`, from the footing, at once; a second time
 *   in one read `read` is null and it waits for its next read.
 * - `withheld`: the head lies past what was shown and nothing new was shown. Nothing to ask now.
 * - `older`: the head is an earlier place of the member's own history, under what a member signed: an old
 *   part of the log. Nothing changes.
 * - `refused`: an entry does not hold (the entry's own codes), the page has not its form (`page_form`), the log
 *   goes on past what any list holds (`log_full`), or it goes on with entries that no signer signed, past what
 *   a copy keeps (`loose`). What held before it is taken.
 * - `stuck`: another history at or under its footing, which nothing shown proves a member signed. Nothing of
 *   it is taken, and nothing ever will be while the source shows it. `read`, when there is one, asks from an
 *   earlier place, to see where the two part.
 * - `fork`: the same, and a member signed it: the alarm is set.
 * - `needs_newer_client`: it stopped at an entry this build cannot place.
 * - `not_my_list`: the page names another list than the member follows, or its entry 0 is not that list's, is
 *   of another account, or is not signed by whom the pin asks for.
 *
 * Only `caught_up` from the account service counts as a full read. Whatever the verdict, `read` is null once
 * a read has made READ_PAGES_MAX requests: the member goes on at its next read.
 */
export type FollowVerdict = "caught_up" | "more" | "asks_after" | "withheld" | "older" | "refused" | "stuck" | "fork" | "needs_newer_client" | "not_my_list";

export type PageRefusal = ListRefusalCode | "page_form" | "log_full" | "loose";

/** Who came in and who went out by what a page showed, as the kinds list them. One that came and went inside the page is in neither. */
export interface ListChanges {
  readonly devices: { readonly added: readonly DeviceView[]; readonly removed: readonly DeviceView[] };
  readonly pcs: { readonly added: readonly PcView[]; readonly removed: readonly PcView[] };
}

export interface PageResult {
  readonly copy: FollowerCopy;
  readonly verdict: FollowVerdict;
  /** Why, for `refused`; null otherwise. */
  readonly code: PageRefusal | null;
  /** The place a `refused`, `stuck` or `fork` is about, or null. */
  readonly at: number | null;
  readonly changes: ListChanges;
  /** The request to make at once, or null: this read is over. */
  readonly read: FollowRead | null;
}

/** A member's word on where it stands, for another member: its list id and the last entry a member signed in its copy, null while it holds none. */
export interface ListHead {
  readonly list: string;
  readonly place: ListPlace | null;
}

export type HeadsVerdict = "same" | "behind" | "ahead" | "differs" | "not_my_list";

export type SessionRefusal = "waiting" | "stopped" | "out" | "never_added" | "removed" | "expired" | "frozen";

/** A device that a PC lets in now: its key, as what, and the second its `until` ends that, or null. */
export interface AdmittedDevice {
  readonly key: string;
  readonly role: ListRole;
  readonly until: number | null;
}

/** What happened, for followStep. `asked_at` is when the member's last read began, `since` when this session began to wait; both in seconds, null for never. */
export type FollowEvent =
  | { readonly event: "tick"; readonly asked_at: number | null; readonly busy: boolean }
  | { readonly event: "doorbell" }
  | { readonly event: "session"; readonly since: number | null };

export type FollowStep =
  | { readonly do: "read" }
  | { readonly do: "wait"; readonly until: number | null }
  | { readonly do: "read_and_wait"; readonly until: number }
  | { readonly do: "decide" };

export type SaveRefusal = "form" | "version" | "sum" | "broken";

/** An account's id, as a `genesis` names it. */
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const ENDPOINT = /^[0-9a-f]{64}$/;
const NO_CHANGES: ListChanges = Object.freeze({ devices: Object.freeze({ added: [], removed: [] }), pcs: Object.freeze({ added: [], removed: [] }) });

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isPlace = (value: unknown): value is ListPlace => isRecord(value) && isCount(value["seq"]) && typeof value["hash"] === "string" && isListHash(value["hash"]);

/** A row of its own, or null: what every object answers to is no row. */
function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

/** The hash of an entry's text, or null for a text that is no entry. */
function hashOf(text: string | undefined): string | null {
  if (text === undefined) return null;
  try {
    return entryHash(entryFromText(text).body);
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
}

/** The member's own entry at a place, by its hash. */
function hashAt(copy: FollowerCopy, seq: number): string | null {
  return seq === 0 && copy.entries.length > 0 ? copy.list : hashOf(copy.entries[seq]);
}

const firstSigner = (state: ListState): string | null => Object.entries(state.signers).find(([, row]) => row.seq === 0)?.[0] ?? null;

function isSelf(value: unknown): value is FollowerSelf {
  if (!isRecord(value)) return false;
  const { key, endpoint } = value;
  return typeof key === "string" && isListKey(key) && (endpoint === null || (typeof endpoint === "string" && ENDPOINT.test(endpoint)));
}

/** A pin in its form, for this member: a device's is `genesis`, `allowed` or `carried`, a PC's `added` or `migrated`. */
function readPin(value: unknown, me: FollowerSelf): ListPin | null {
  if (!isRecord(value)) return null;
  const names = Object.keys(value).sort().join(" ");
  const pc = me.endpoint !== null;
  switch (value["how"]) {
    case "genesis": return names === "how" && !pc ? { how: "genesis" } : null;
    case "carried": return names === "how" && !pc ? { how: "carried" } : null;
    case "added": return names === "how" && pc ? { how: "added" } : null;
    case "allowed": {
      const { seq, hash } = value;
      return names === "hash how seq" && !pc && isCount(seq) && seq >= 1 && typeof hash === "string" && isListHash(hash) ? { how: "allowed", seq, hash } : null;
    }
    case "migrated": {
      const { admitted } = value;
      if (names !== "admitted how" || !pc || !Array.isArray(admitted)) return null;
      const keys = (admitted as readonly unknown[]).filter((key): key is string => typeof key === "string" && isListKey(key));
      return keys.length === admitted.length && new Set(keys).size === keys.length ? { how: "migrated", admitted: [...keys].sort() } : null;
    }
    default: return null;
  }
}

/**
 * A first pin: the copy of a member that follows `list` for `account` and has read nothing yet. `held` is what
 * the member has saved, or null for a member that has saved nothing: it is not optional, so that no caller
 * forgets it. A member that holds a copy is pinned and stays so (`pinned`), also when the list id is the same:
 * a pin is one-way, and only a person's reset at the member, which deletes its save, takes it off. A save that
 * does not read (readSave) is not null: such a member is still pinned.
 *
 * The caller says where the list id came from (ListPin) and takes it from nowhere else: a device from its own
 * genesis once the account service took it, or with the head of the member that allowed it; a PC from the
 * entry a person compared, scanned or sent over SSH, or from a join line; and for an account that was in use
 * before it had a list, with the evidence the pin names.
 */
export function pinList(held: FollowerCopy | null, given: { readonly account: string; readonly list: string; readonly me: FollowerSelf; readonly pin: ListPin }): { readonly pinned: true; readonly copy: FollowerCopy } | { readonly pinned: false; readonly why: "pinned" | "form" } {
  if (held !== null) return { pinned: false, why: "pinned" };
  const { account, list, me, pin } = given;
  if (typeof account !== "string" || !ACCOUNT.test(account) || typeof list !== "string" || !isListHash(list) || !isSelf(me)) return { pinned: false, why: "form" };
  const self: FollowerSelf = { key: me.key, endpoint: me.endpoint };
  const read = readPin(pin, self);
  if (read === null) return { pinned: false, why: "form" };
  return { pinned: true, copy: { account, list, me: self, pin: read, entries: [], state: null, stop: null, read_at: null, seen_at: null, alarm: null } };
}

/** Whether the list shows what the member's pin asks for (ListPin). */
function pinMet(copy: FollowerCopy): boolean {
  const { state, pin, me } = copy;
  if (state === null) return false;
  const row = rowOf(state.signers, me.key);
  switch (pin.how) {
    case "genesis": return row !== null && row.seq === 0;
    case "allowed": return row !== null && row.as === "device" && hashAt(copy, pin.seq) === pin.hash;
    case "carried": return row !== null && row.as === "device" && rowOf(state.devices, me.key)?.carried === true;
    case "added": return me.endpoint !== null && rowOf(state.pcs, me.endpoint)?.key === me.key;
    case "migrated": return pin.admitted.includes(firstSigner(state) ?? "") && Object.entries(state.devices).every(([key, device]) => !device.carried || pin.admitted.includes(key));
  }
}

/** Where the member stands in the list it follows (Standing). A member that stopped is `stopped` whether or not the list shows yet what its pin asks for: it reads no further until an update. */
export function standing(copy: FollowerCopy): Standing {
  const { state, me, pin } = copy;
  if (state === null) return "waiting";
  if (state.needs_replay !== undefined) return "stopped";
  if (!pinMet(copy)) return "waiting";
  if (me.endpoint === null) return signerPower(state, me.key) === null ? "out" : "in";
  const row = rowOf(state.pcs, me.endpoint);
  // A PC that was in the account before the list follows it whether the list names it or not, until an entry puts it out.
  if (pin.how === "migrated") return row !== null && row.removed !== null ? "out" : "in";
  return row !== null && row.key === me.key && row.removed === null ? "in" : "out";
}

/** The kinds' own copy of a member that has read entry 0, for the functions of the kinds and the signers (signingPlace, listView, wrapKeys); null before. */
export function listCopy(copy: FollowerCopy): ListCopy | null {
  return copy.state === null ? null : { entries: copy.entries, state: copy.state };
}

const inDevices = (state: ListState): string[] => listView(state).devices.filter((row) => row.ended === null).map((row) => row.key);
const inPcs = (state: ListState): string[] => listView(state).pcs.filter((row) => row.removed === null).map((row) => row.endpoint);

/** The rows of a state as the kinds list them, also for a member that stopped: who came and went before it stopped is still what happened. */
function rowsOf(state: ListState): Pick<ReturnType<typeof listView>, "devices" | "pcs"> {
  return listView(Object.fromEntries(Object.entries(state).filter(([name]) => name !== "needs_replay")) as unknown as ListState);
}

function changesBetween(before: ListState | null, after: ListState | null): ListChanges {
  if (after === null || after === before) return NO_CHANGES;
  const was = before === null ? { devices: [], pcs: [] } : rowsOf(before);
  const now = rowsOf(after);
  const wasDevices = new Map(was.devices.map((row) => [row.key, row.ended === null]));
  const wasPcs = new Map(was.pcs.map((row) => [row.endpoint, row.removed === null]));
  return {
    devices: {
      added: now.devices.filter((row) => row.ended === null && !wasDevices.has(row.key)),
      removed: now.devices.filter((row) => row.ended !== null && wasDevices.get(row.key) === true),
    },
    pcs: {
      added: now.pcs.filter((row) => row.removed === null && !wasPcs.has(row.endpoint)),
      removed: now.pcs.filter((row) => row.removed !== null && wasPcs.get(row.endpoint) === true),
    },
  };
}

/**
 * The hour a member judges by, the kinds' listClock: its own clock, never less than the latest hour that clock
 * showed before (`seen_at`, saved with the copy), and never less than the list's own time, the latest hour a
 * signer of power `full` wrote into an entry that counted. So a clock that was set back lets no device in past
 * its `until`.
 */
export function memberClock(copy: FollowerCopy, now: number): number {
  return copy.state === null ? Math.max(now, copy.seen_at ?? 0) : listClock(copy.state, now, copy.seen_at);
}

/**
 * The copy with the hour its clock shows now, when that is later than any it showed before: the very copy
 * otherwise. Every page and every hint does this by itself. A member calls it as well whenever it reads its
 * clock to decide (each tick, each session it lets in or refuses, each look at who is past its `until`) and
 * saves the copy now and then: with the account service away no page comes, and without this a clock that was
 * set back would count again for less than it once showed.
 */
export function withClock(copy: FollowerCopy, now: number): FollowerCopy {
  if (!isCount(now)) throw new RangeError("The hour is seconds since 1970, a whole number");
  return copy.seen_at !== null && copy.seen_at >= now ? copy : { ...copy, seen_at: now };
}

/** The request that begins a read, from the account service or from a peer: the entries after the member's head, or from entry 0 for a member that holds none. */
export function startRead(copy: FollowerCopy, source: ListSource): FollowRead {
  return { source, list: copy.list, after: copy.entries.length === 0 ? null : copy.entries.length - 1, back: false, left: READ_PAGES_MAX - 1 };
}

/**
 * What a page showed of another history than the member's own, when the kinds' taking stopped on one.
 *
 * `parts` is the place of the first shown entry that is not the member's entry there, or null where every
 * shown entry is the member's own. `proven` says that a member signed the other history from there: the place
 * lies at or under the footing, the entry continues the member's own entry before it, and the member's own
 * history up to it, with the shown entries from it on, replayed as a list of its own, has its footing at or
 * past that place. So a key that was a signer where the two part signed on the other history: `by` is that
 * key, the signer of the first entry from that place on that is not loose. A loose entry never moves a footing,
 * so what the account service or a stranger signs proves nothing. `deeper` says that the
 * first shown entry follows an entry the member does not hold: the two part before the page, and a page from
 * an earlier place shows where.
 *
 * Before the member's own history is replayed, what costs little is checked: one of the shown entries from
 * that place on is by a key the member's history made a signer, where no row is ever deleted, and the first of
 * them is signed by its signer.
 */
async function otherHistory(list: string, mine: ListCopy, after: number, shown: readonly string[]): Promise<{ readonly parts: number | null; readonly by: string | null; readonly deeper: boolean }> {
  let parts: number | null = null;
  for (const [index, text] of shown.entries()) {
    const seq = after + 1 + index;
    const hash = hashOf(text);
    if (hash === null) return { parts: seq, by: null, deeper: false };
    if (seq < mine.entries.length && hash === hashOf(mine.entries[seq])) continue;
    parts = seq;
    break;
  }
  if (parts === null) return { parts, by: null, deeper: false };
  const no = (deeper: boolean) => ({ parts, by: null, deeper });
  // The shown entries from that place on, up to the first that is no entry: what stands before it proves what it proves.
  const rest: string[] = [];
  const entries: Entry[] = [];
  const bodies: EntryBody[] = [];
  for (const text of shown.slice(parts - after - 1)) {
    try {
      const entry = entryFromText(text);
      bodies.push(readBody(entry.body));
      entries.push(entry);
      rest.push(text);
    } catch (error) {
      if (!(error instanceof ListEntryError)) throw error;
      break;
    }
  }
  try {
    const [entry, body] = [entries[0], bodies[0]];
    if (entry === undefined || body === undefined || body.list !== list || body.seq !== parts) return no(false);
    if (body.prev !== hashOf(mine.entries[parts - 1])) return no(parts === after + 1);
    if (parts > mine.state.footing.seq || !bodies.some((item) => rowOf(mine.state.signers, item.signer) !== null)) return no(false);
    if (!(await verifySignature(entry.body, entry.signature, body.signer))) return no(false);
  } catch (error) {
    if (!(error instanceof ListEntryError)) throw error;
    return no(false);
  }
  const replayed = await replayList([...mine.entries.slice(0, parts), ...rest], LIST_LEVEL, { saved: null, given: list });
  if (replayed.member === null) return no(false);
  // The footing lies at or past that place exactly when one of the entries from it on is not loose.
  const signed = replayed.took.slice(parts).find(({ outcome }) => !(outcome.outcome === "passed_over" && outcome.loose));
  return { parts, by: signed?.held.body.signer ?? null, deeper: false };
}

/**
 * What a member does with one page of the log, from the account service or from a peer: the same taking for
 * both, since entries verify themselves. `read` is the request the page answers (startRead, or the `read` of
 * the page before), and `now` the member's clock in seconds. One read at a time: each page is taken on the
 * copy the page before gave.
 *
 * The entries are taken by the kinds' shownList, and for a member that has read nothing by replayList from an
 * entry 0 with the list id of its pin, the account its pin names, and the first signer its pin asks for. Then
 * the head the page claims is held against the copy: the member is caught up only when it holds the entry at
 * that place and it has that hash. So a head that the entries do not reach is never caught up, and the result
 * of a read is the same wherever its pages were cut: a page says nothing that a longer page would not, and
 * each next page follows the place where the one before ended.
 *
 * A device that was allowed takes no entry at the place of the head it was handed but that very entry: a log
 * that shows another there is another history than the one it was let into (`stuck`), and one that ends before
 * that place is `older`.
 *
 * Another history at or under the footing is `stuck`. It is a `fork` when what was shown proves that a member
 * signed it (otherHistory): the alarm is set, once. Where the page does not show the place at which the two
 * part, the read looks under the footing for it: from the place of a head that is not the member's entry
 * there, and from an entry that follows one the member does not hold twice as far back each time, to entry 0
 * at the furthest. A member with an alarm goes on taking what continues its own history, so a removal still
 * reaches it, and lets in nobody it did not hold when the alarm rose.
 *
 * Nothing a page says makes a copy shorter under its footing, changes its list id or its pin, or takes out
 * anybody that no entry of a signer put out. A read ends, whatever its pages say: it makes at most
 * READ_PAGES_MAX requests, and what is left is the next read's. Nor does a copy grow without end: it holds at
 * most LIST_ENTRIES_MAX entries, and at most LOOSE_ENTRIES_MAX of them past its footing.
 */
export async function takePage(copy: FollowerCopy, read: FollowRead, page: ListPage, now: number): Promise<PageResult> {
  if (read.list !== copy.list) throw new RangeError("The read is of another list than the copy");
  if (!isCount(now)) throw new RangeError("The hour is seconds since 1970, a whole number");
  const { source } = read;
  if (!isCount(read.left)) throw new RangeError("A read says how many requests it may still make");
  // The next request of this read, where it may still make one.
  const asks = (after: number, back: boolean): FollowRead | null => (read.left > 0 ? { source, list: copy.list, after, back, left: read.left - 1 } : null);
  const result = (verdict: FollowVerdict, next: FollowerCopy = copy, rest: Partial<Pick<PageResult, "code" | "at" | "read">> = {}): PageResult =>
    ({ copy: withClock(next, now), verdict, code: null, at: null, changes: changesBetween(copy.state, next.state), read: null, ...rest });
  const refused = (code: PageRefusal, at: number | null = null, next: FollowerCopy = copy) => result("refused", next, { code, at });

  if (!isRecord(page)) return refused("page_form");
  const { list: said, after: echoed, entries: given, head } = page;
  if (said !== undefined && said !== copy.list) return result("not_my_list");
  if (!Array.isArray(given) || !given.every((text) => typeof text === "string") || !isPlace(head)) return refused("page_form");
  let shown: readonly string[] = given.slice(0, PAGE_ENTRIES_MAX);
  // Whether the page showed an entry at all: only then is there a next part to ask for.
  const showed = shown.length > 0;
  // The place a page follows is the member's own number: an answer that names another is not the one that was asked for.
  if (echoed !== undefined && echoed !== read.after) return refused("page_form");
  let after = read.after;
  if (!(after === null || isCount(after))) throw new RangeError("A read follows a place, or begins at entry 0");
  const top = copy.entries.length - 1;
  // A page for a place the member no longer holds shows it nothing.
  if (after !== null && after > top) return result("withheld");

  let member: ListCopy;
  if (copy.state === null) {
    const [first, ...rest] = shown;
    if (first === undefined) return result("withheld");
    const started = await replayList([first], LIST_LEVEL, { saved: null, given: copy.list });
    const body = started.took[0]?.held.body;
    if (started.member === null || body === undefined) {
      const code = started.stopped?.code ?? "entry_malformed";
      if (code === "list_mismatch") return result("not_my_list");
      if (code !== "entry_invalid" && code !== "needs_replay") return refused(code, 0);
      // An entry 0 with the list id of the pin that this build cannot read as a genesis: a later level's, or no list a member follows.
      let v = 0;
      try {
        v = readBody(entryFromText(first).body).v;
      } catch (error) {
        if (!(error instanceof ListEntryError)) throw error;
      }
      return result(v > LIST_LEVEL ? "needs_newer_client" : "not_my_list");
    }
    if (started.member.state.account !== copy.account) return result("not_my_list");
    if (copy.pin.how === "genesis" && body.signer !== copy.me.key) return result("not_my_list");
    if (copy.pin.how === "migrated" && !copy.pin.admitted.includes(body.signer)) return result("not_my_list");
    member = started.member;
    after = 0;
    shown = rest;
  } else {
    member = { entries: copy.entries, state: copy.state };
    if (after === null) {
      // A page from entry 0 for a member that holds it: only its own entry 0 stands there.
      const [first, ...rest] = shown;
      if (first !== undefined && hashOf(first) === null) return refused("entry_malformed", 0);
      if (first !== undefined && hashOf(first) !== copy.list) return result("not_my_list");
      if (first === undefined) return result("withheld");
      after = 0;
      shown = rest;
    }
  }

  // A device that was allowed takes at the place of the head it was handed only that very entry.
  let parted: number | null = null;
  const { pin } = copy;
  if (pin.how === "allowed" && hashAt(copy, pin.seq) !== pin.hash) {
    const index = pin.seq - after - 1;
    if (index >= 0 && index < shown.length && hashOf(shown[index]) !== pin.hash) {
      shown = shown.slice(0, index);
      parted = pin.seq;
    }
  }
  let full = false;
  const room = LIST_ENTRIES_MAX - 1 - after;
  if (shown.length > room) {
    shown = shown.slice(0, Math.max(0, room));
    full = true;
  }

  const took = await shownList(member, { after, entries: shown, head });
  const { state } = took.member;
  const footing = state.footing.seq;
  // Past its footing a copy keeps only so many entries: each is one that no signer signed, and none of them changed the state.
  // Not on the page it stops in: the entry it stopped at follows them, and is replayed after them when the save is read. It takes none after that.
  const loose = state.needs_replay === undefined && took.member.entries.length - 1 - footing > LOOSE_ENTRIES_MAX;
  const entries = loose ? took.member.entries.slice(0, footing + 1 + LOOSE_ENTRIES_MAX) : took.member.entries;
  const reached = entries.length - 1;
  // The entry it stopped at, kept as text for the replay after an update: the one the state names, and no other.
  const halted = state.needs_replay === undefined ? undefined : shown[state.needs_replay.seq - after - 1];
  const stop = state.needs_replay === undefined ? null : halted !== undefined && hashOf(halted) === state.needs_replay.hash ? halted : copy.stop;
  let next: FollowerCopy = { ...copy, entries, state, stop };

  if (took.stopped?.code === "needs_replay") return result("needs_newer_client", next);
  const cursor = after + shown.length;
  const onward = asks(Math.min(cursor, reached), read.back);
  if (took.stuck) {
    const other = await otherHistory(copy.list, took.member, after, shown);
    if (other.by !== null && other.parts !== null) {
      if (next.alarm === null) next = { ...next, alarm: { code: "fork", source, seq: other.parts, by: other.by, at: now, devices: inDevices(state).sort(), pcs: inPcs(state).sort() } };
      return result("fork", next, { at: other.parts });
    }
    // Every entry shown is the member's own and the head is not: the place where the two part lies further on.
    if (other.parts === null && showed && cursor < head.seq) return result("more", next, { read: onward });
    // Or it lies before this page. Look under the footing: at the place of a head that is not the member's entry there, or twice as far back as this page began.
    let under: number | null = null;
    if (other.parts === null && head.seq >= 1 && head.seq <= footing && head.seq - 1 < after) under = head.seq - 1;
    if (other.deeper && after > 0) under = after > footing ? footing : Math.max(0, 2 * after - footing - 1);
    return result("stuck", next, { at: took.stopped?.seq ?? null, read: under === null ? null : asks(under, read.back) });
  }
  if (took.stopped !== null) return refused(took.stopped.code as PageRefusal, took.stopped.seq, next);
  if (parted !== null) return result("stuck", next, { at: parted });
  if (took.asks_after !== null) {
    return result("asks_after", next, { read: read.back ? null : asks(took.asks_after, true) });
  }
  if (loose) return refused("loose", reached + 1, next);
  if (full) return refused("log_full", LIST_ENTRIES_MAX, next);

  if (head.seq > reached) return showed ? result("more", next, { read: onward }) : result("withheld", next);
  if (hashAt(next, head.seq) !== head.hash) return showed && cursor < head.seq ? result("more", next, { read: onward }) : result("withheld", next);
  // It holds the entry at the head. A head under its footing is an old part of its own history, and so is a log that ends before the head a device was handed.
  if (head.seq < footing || (pin.how === "allowed" && reached < pin.seq)) return result("older", next);
  if (source === "service") next = { ...next, read_at: now };
  return result("caught_up", next);
}

/**
 * What a member does with the head the account service names beside something else (a PC's mailbox pull): a
 * hint that only says whether to read. The copy it gives back differs from the one handed over only in its
 * times. `same`: the head is the member's own, which counts as a full read, so a quiet list costs no request
 * for the log. `read`: begin a read (startRead). `older`: an earlier place of the
 * member's own history; a late or lying service, and nothing changes. `not_my_list`: another list id than the
 * member follows; nothing changes, and the member does not take it for its list being gone. `none`: the
 * service named no list (null: an account it serves no list for, or a service that knows of none); that is no
 * hint, never the word that the list is gone, and the member reads at its own pace.
 */
export function heardHead(copy: FollowerCopy, hint: ListHead | null, now: number): { readonly copy: FollowerCopy; readonly verdict: "same" | "read" | "older" | "not_my_list" | "none" } {
  if (!isCount(now)) throw new RangeError("The hour is seconds since 1970, a whole number");
  const held = withClock(copy, now);
  if (hint === null || hint === undefined) return { copy: held, verdict: "none" };
  if (!isRecord(hint) || hint.list !== copy.list) return { copy: held, verdict: "not_my_list" };
  const { place } = hint;
  const { state } = copy;
  if (state === null || !isPlace(place) || place.seq > copy.entries.length - 1 || hashAt(copy, place.seq) !== place.hash) return { copy: held, verdict: "read" };
  if (place.seq < state.footing.seq || (copy.pin.how === "allowed" && copy.entries.length - 1 < copy.pin.seq)) return { copy: held, verdict: "older" };
  return { copy: { ...held, read_at: now }, verdict: "same" };
}

/** What a member tells another member of where it stands: its list id and its footing, the last entry a member signed in its copy. Never a loose entry: nobody passes on what no member signed. */
export function gossipHead(copy: FollowerCopy): ListHead {
  return { list: copy.list, place: copy.state === null ? null : { seq: copy.state.footing.seq, hash: copy.state.footing.hash } };
}

/**
 * Two members compare where they stand, each with the other's head (gossipHead).
 *
 * - `same`: both stand at one entry.
 * - `behind`: the other stands further: ask it for `read`, and take what it answers (takePage).
 * - `ahead`: the other stands at an earlier place of this member's own history. It asks.
 * - `differs`: the other stands at a place this member holds with another entry: ask it for `read`, which is
 *   for that very entry. What it answers shows whether a member signed another history (`fork`). A head that
 *   names no place a list has is `differs` with nothing to ask.
 * - `not_my_list`: the other follows another list id. Nothing is asked and nothing changes: a device whose PC
 *   follows another list than it does says so and adds nothing.
 *
 * Two members whose histories parted both come to `differs` or `behind`, both ask, and both prove the fork from
 * what the other answers: both get the alarm.
 */
export function compareHeads(copy: FollowerCopy, theirs: ListHead): { readonly verdict: HeadsVerdict; readonly read: FollowRead | null } {
  if (!isRecord(theirs) || theirs.list !== copy.list) return { verdict: "not_my_list", read: null };
  const { place } = theirs;
  const { state } = copy;
  if (place === null) return state === null ? { verdict: "same", read: null } : { verdict: "ahead", read: null };
  if (!isPlace(place)) return { verdict: "differs", read: null };
  if (state === null || place.seq > state.footing.seq) return { verdict: "behind", read: startRead(copy, "peer") };
  if (hashAt(copy, place.seq) !== place.hash) return { verdict: "differs", read: place.seq === 0 ? null : { ...startRead(copy, "peer"), after: place.seq - 1 } };
  return place.seq === state.footing.seq ? { verdict: "same", read: null } : { verdict: "ahead", read: null };
}

/**
 * The page a member answers another member's request with: its own entries after the place asked, up to its
 * footing and at most `limit`, and its footing as the head. Null for a request of another list, one out of
 * form, or a member that has read nothing. It never serves a loose entry, and it serves whether or not it has
 * an alarm: the other side proves a fork from this page.
 */
export function servePage(copy: FollowerCopy, ask: PeerAsk, limit: number): ListPage | null {
  const { state } = copy;
  if (!isRecord(ask) || ask.list !== copy.list || state === null || !isCount(limit) || limit < 1) return null;
  const { after } = ask;
  if (!(after === null || isCount(after))) return null;
  const from = after === null ? 0 : after + 1;
  return { list: copy.list, after, entries: copy.entries.slice(from, Math.min(state.footing.seq + 1, from + limit)), head: { seq: state.footing.seq, hash: state.footing.hash } };
}

/** Whether a member with an alarm holds this device or PC back: it lets in only whom it held when the alarm rose. */
const heldBack = (alarm: ListAlarm | null, part: "devices" | "pcs", name: string): boolean => alarm !== null && !alarm[part].includes(name);

/**
 * Whether a PC lets the device with this key open a session at `now` (seconds, by the PC's own clock, which
 * counts for no less than it showed before: memberClock), and as what. It reads the PC's copy and nothing
 * else: no answer of the account service, no time of a last read. So a service that is away or withholds
 * never takes out a device the PC holds.
 *
 * The refusals, the first that applies: the PC itself is `waiting`, `stopped` or `out` (standing); the list
 * never made the key a device (`never_added`); an entry ended it (`removed`); the PC has an alarm and did not
 * hold the device when it rose (`frozen`); its `until` has passed (`expired`).
 */
export function admitsSession(copy: FollowerCopy, key: string, now: number): { readonly role: ListRole; readonly why: null } | { readonly role: null; readonly why: SessionRefusal } {
  const no = (why: SessionRefusal) => ({ role: null, why }) as const;
  const { state, alarm } = copy;
  const stands = standing(copy);
  if (state === null || stands !== "in") return no(stands === "in" ? "waiting" : stands);
  const row = rowOf(state.signers, key);
  if (row === null || row.as !== "device" || rowOf(state.devices, key) === null) return no("never_added");
  if (row.ended !== null) return no("removed");
  if (heldBack(alarm, "devices", key)) return no("frozen");
  const role = admitsDevice(state, key, memberClock(copy, now));
  return role === null ? no("expired") : { role, why: null };
}

/** Every device a PC lets in at `now`, in the order they came in: what admitsSession says for each key the list made a device. */
export function admittedDevices(copy: FollowerCopy, now: number): AdmittedDevice[] {
  const { state } = copy;
  if (state === null) return [];
  return listView(state).devices.flatMap((row) => {
    const { role } = admitsSession(copy, row.key, now);
    return role === null ? [] : [{ key: row.key, role, until: row.until }];
  });
}

/** The next second at which a device that is let in at `now` stops being so by its `until`, or null: when a PC looks at its open sessions again. */
export function nextUntil(copy: FollowerCopy, now: number): number | null {
  const { state } = copy;
  if (state === null) return null;
  const untils = admittedDevices(copy, now).flatMap((row) => (row.until === null ? [] : [row.until]));
  return untils.length === 0 ? null : Math.min(...untils);
}

/**
 * The relay key of the PC whose signing key this is, when that PC is in the list as this member holds it, or
 * null: whether a PC that shows this key is a member. A PC that joined by an invite is one too, though its key
 * signs nothing.
 */
export function pcOfKey(copy: FollowerCopy, key: string): string | null {
  const { state } = copy;
  if (state === null || standing(copy) !== "in") return null;
  const endpoint = rowOf(state.pc_keys, key);
  const row = endpoint === null ? null : rowOf(state.pcs, endpoint);
  return endpoint !== null && row !== null && row.key === key && row.removed === null && !heldBack(copy.alarm, "pcs", endpoint) ? endpoint : null;
}

/** The devices of the account as a member shows them: those that are in, in the order they came in, without those an alarm holds back. None while the member is not in itself. */
export function shownDevices(copy: FollowerCopy): DeviceView[] {
  const { state } = copy;
  if (state === null || standing(copy) !== "in") return [];
  return listView(state).devices.filter((row) => row.ended === null && !heldBack(copy.alarm, "devices", row.key));
}

/** The PCs of the account as a member shows them: those that are in, in the order they came in. None while the member is not in itself. A PC is known by its relay key; the account service's directory only says how to reach it. */
export function shownPcs(copy: FollowerCopy): PcView[] {
  const { state } = copy;
  if (state === null || standing(copy) !== "in") return [];
  return listView(state).pcs.filter((row) => row.removed === null && !heldBack(copy.alarm, "pcs", row.endpoint));
}

/**
 * When a member reads, as a function of its copy, its clock (`now`, seconds) and what happened.
 *
 * - `tick`: the clock. A PC reads every PC_READ_SECONDS, and every PC_BUSY_READ_SECONDS while a session is
 *   open (`busy`); a device every DEVICE_READ_SECONDS while its app is in front (`busy`), and not by the clock
 *   otherwise. The time runs from when its last read began (`asked_at`), also one that failed: a service that
 *   is away is not asked faster.
 * - `doorbell`: the account service rang (a device's push, a head a PC was shown that is not its own): read.
 * - `session`: a new session asks a PC to be let in. It decides at once on a copy whose last full read is at
 *   most FRESH_SECONDS old. Otherwise it reads and the session waits (`read_and_wait`), up to
 *   SESSION_WAIT_SECONDS from when it began to wait (`since`); then the PC decides on its copy as it is.
 *
 * `decide` is admitsSession, which never asks how old the copy is. A member that is out, or that stopped at an
 * entry its build cannot place, reads no more. A clock that went back never makes a session wait longer or a
 * read later than its interval.
 */
export function followStep(copy: FollowerCopy, now: number, event: FollowEvent): FollowStep {
  const stands = standing(copy);
  // A member that is out has nothing more to read, and one that stopped reads on only after an update.
  const out = stands === "out" || stands === "stopped";
  switch (event.event) {
    case "doorbell": return out ? { do: "wait", until: null } : { do: "read" };
    case "tick": {
      if (out) return { do: "wait", until: null };
      const pc = copy.me.endpoint !== null;
      if (!pc && !event.busy) return { do: "wait", until: null };
      const every = pc ? (event.busy ? PC_BUSY_READ_SECONDS : PC_READ_SECONDS) : DEVICE_READ_SECONDS;
      const past = event.asked_at === null ? every : now - event.asked_at;
      return past < 0 || past >= every ? { do: "read" } : { do: "wait", until: (event.asked_at ?? now) + every };
    }
    case "session": {
      const age = copy.read_at === null ? -1 : now - copy.read_at;
      if (out || (age >= 0 && age <= FRESH_SECONDS)) return { do: "decide" };
      if (event.since === null) return { do: "read_and_wait", until: now + SESSION_WAIT_SECONDS };
      const waited = now - event.since;
      return waited < 0 || waited >= SESSION_WAIT_SECONDS ? { do: "decide" } : { do: "wait", until: event.since + SESSION_WAIT_SECONDS };
    }
  }
}

/** JSON in one form: every object's members in ascending order of name, no white space, numbers as whole numbers. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!isCount(value)) throw new RangeError("A save holds only whole numbers from 0");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().filter((name) => value[name] !== undefined).map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`).join(",")}}`;
  throw new RangeError("A save holds only what JSON holds");
}

const saveSum = (body: string): string => bytesToHex(sha256(concatBytes(utf8ToBytes(LIST_SAVE_PREFIX), utf8ToBytes(body))));

/**
 * A copy as the one text a member saves: JSON in one form (each object's members in ascending order of name,
 * no white space) with the members `account`, `alarm`, `entries`, `footing`, `level`, `list`, `me`, `pin`,
 * `read_at`, `seen_at`, `state`, `stop`, `sum` and `v`. `footing` is the place of the last entry a member
 * signed and `level` the level of the build that saved. `sum` is SHA-256 over LIST_SAVE_PREFIX and the text of
 * the same object without `sum`. It holds nothing secret: no private key and no key to the names.
 */
export function writeSave(copy: FollowerCopy): string {
  const { account, alarm, entries, list, me, pin, read_at, seen_at, state, stop } = copy;
  const footing = state === null ? null : { hash: state.footing.hash, seq: state.footing.seq };
  const body = { account, alarm, entries, footing, level: state?.level ?? LIST_LEVEL, list, me: { endpoint: me.endpoint, key: me.key }, pin, read_at, seen_at, state, stop, v: FOLLOWER_SAVE_VERSION };
  return canonical({ ...body, sum: saveSum(canonical(body)) });
}

/** An alarm in its form, null, or undefined for anything else. Whom it names is not held against the state: an alarm is kept, whatever the state has become. */
function readAlarm(value: unknown): ListAlarm | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).sort().join(" ") !== "at by code devices pcs seq source") return undefined;
  const { at, by, code, devices, pcs, seq, source } = value;
  if (code !== "fork" || (source !== "service" && source !== "peer") || !isCount(at) || !isCount(seq) || seq < 1 || typeof by !== "string" || !isListKey(by)) return undefined;
  if (!Array.isArray(devices) || !Array.isArray(pcs)) return undefined;
  const sorted = (names: readonly unknown[], named: (name: string) => boolean): names is readonly string[] =>
    names.every((name, at) => typeof name === "string" && named(name) && (at === 0 || (names[at - 1] as string) < name));
  if (!sorted(devices, isListKey) || !sorted(pcs, (name) => ENDPOINT.test(name))) return undefined;
  return { code, source, seq, by, at, devices: [...devices], pcs: [...pcs] };
}

/**
 * A saved copy, read again: the copy, or why it does not read. Nothing is half read: a save gives a whole copy
 * or none.
 *
 * The entries are what a save holds as true, and its state is only what they gave the build that saved. So the
 * entries are replayed from entry 0, each checked as when it was first taken, and the copy holds the state the
 * replay gives. Where that is not what was saved, `rebuilt` says so: a later build holds other things in a
 * state or judges an entry by a later rule, or the saved state was changed. It says exactly that this build
 * writes the copy as another text than the one it read (also where only the footing or the level it names is
 * another): that is no refusal, and a caller notes it once and saves the copy again. So no update of the app or of a PC makes a save unreadable, and no state reads that the
 * entries do not give.
 *
 * - `form`: no JSON, not the members of a save each in its form, or not in its one form.
 * - `version`: a later build's save, which this build does not read: a later `v`, or entries that only a
 *   later level can place.
 * - `sum`: the text is not the one that was written: a byte of it changed.
 * - `broken`: the entries themselves do not hold: one does not verify or does not continue the one before it,
 *   they end before the saved footing or show another entry there, entry 0 is not the pinned list's, is of
 *   another account or is not signed by whom the pin asks for, or the stopped entry is not the next one.
 *
 * The replay never gives a shorter history than the saved one: it reaches the saved footing, with the very
 * entry there. The stopped entry is replayed with the others, so a build that can place it goes on, and one
 * that cannot stays stopped at it.
 *
 * The sum finds a damaged file, not a forged one: whoever can write a member's store can write its sum, and
 * holds its private key too. A save that does not read is not a member with no list: it is still pinned, and
 * only a person's reset starts it over.
 */
export async function readSave(text: string): Promise<{ readonly read: true; readonly copy: FollowerCopy; readonly rebuilt: boolean } | { readonly read: false; readonly why: SaveRefusal }> {
  const no = (why: SaveRefusal) => ({ read: false, why }) as const;
  let value: unknown;
  try {
    value = typeof text === "string" ? JSON.parse(text) : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return no("form");
  }
  if (!isRecord(value)) return no("form");
  const { account, alarm: savedAlarm, entries, footing, level, list, me, pin: savedPin, read_at, seen_at, state: savedState, stop, sum, v, ...rest } = value;
  if (isCount(v) && v > FOLLOWER_SAVE_VERSION) return no("version");
  if (v !== FOLLOWER_SAVE_VERSION || Object.keys(rest).length > 0 || Object.keys(value).length !== 14) return no("form");
  let again: string;
  try {
    again = canonical(value);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return no("form");
  }
  if (again !== text || typeof sum !== "string") return no("form");
  if (saveSum(canonical({ account, alarm: savedAlarm, entries, footing, level, list, me, pin: savedPin, read_at, seen_at, state: savedState, stop, v })) !== sum) return no("sum");

  if (typeof account !== "string" || !ACCOUNT.test(account) || typeof list !== "string" || !isListHash(list) || !isSelf(me) || Object.keys(me).length !== 2) return no("form");
  const pin = readPin(savedPin, me);
  if (pin === null || canonical(pin) !== canonical(savedPin)) return no("form");
  if (!Array.isArray(entries) || entries.length > LIST_ENTRIES_MAX || !entries.every((entry) => typeof entry === "string")) return no("form");
  if (!(stop === null || typeof stop === "string") || !(read_at === null || isCount(read_at)) || !(seen_at === null || isCount(seen_at)) || !(savedState === null || isRecord(savedState))) return no("form");
  if (!isCount(level) || level < 1 || !(footing === null || (isPlace(footing) && Object.keys(footing).length === 2))) return no("form");
  const alarm = readAlarm(savedAlarm);
  if (alarm === undefined) return no("form");
  const texts = entries as readonly string[];
  const self: FollowerSelf = { key: me.key, endpoint: me.endpoint };
  const held = { account, list, me: self, pin, read_at, seen_at, alarm };
  if (texts.length === 0) {
    // A member that has read nothing holds no footing and stopped nowhere.
    if (footing !== null || stop !== null) return no("broken");
    const empty: FollowerCopy = { ...held, entries: [], state: null, stop: null };
    return { read: true, copy: empty, rebuilt: writeSave(empty) !== text };
  }
  if (footing === null || footing.seq >= texts.length) return no("broken");
  /** What only a later level can place is a later build's save; anything else that does not hold is a save whose entries are not what was saved. */
  const refused = no(level > LIST_LEVEL ? "version" : "broken");
  const replayed = await replayList(stop === null ? texts : [...texts, stop], LIST_LEVEL, { saved: null, given: list });
  const member = replayed.member;
  const first = replayed.took[0]?.held.body;
  if (member === null || first === undefined) return replayed.stopped?.code === "entry_invalid" ? refused : no("broken");
  // Every entry was taken, but for the stopped one where this build cannot place it either.
  const { state } = member;
  const at = replayed.stopped;
  if (at !== null && at.code !== "needs_replay") return no("broken");
  if (member.entries.length < texts.length || (at !== null && stop === null)) return refused;
  // Never a shorter history than the saved one: the very entry at the saved footing, and a footing no earlier.
  if (hashOf(member.entries[footing.seq]) !== footing.hash) return no("broken");
  if (state.footing.seq < footing.seq) return refused;
  if (state.account !== account) return no("broken");
  if ((pin.how === "genesis" && first.signer !== self.key) || (pin.how === "migrated" && !pin.admitted.includes(first.signer))) return no("broken");
  const copy: FollowerCopy = { ...held, entries: member.entries, state, stop: state.needs_replay === undefined ? null : stop };
  return { read: true, copy, rebuilt: writeSave(copy) !== text };
}
