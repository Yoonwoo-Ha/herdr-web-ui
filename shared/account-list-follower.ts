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
import { ListEntryError, entryFromText, entryHash, isListHash, isListKeyEncoding, readBody, verifySignature, type Entry, type EntryBody, type ListRefusalCode } from "./account-list-entry.ts";
import { standsFor } from "./account-list-migrate.ts";
import { type ListPlace } from "./account-list-signers.ts";
import {
  LIST_LEVEL, admitsDevice, isListKey, listClock, listView, replayList, shownList,
  type DeviceView, type ListCopy, type ListRole, type ListState, type PcView, type TakenListEntry,
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
/** The most entries one member posts at once: the account service places a post whole or not at all, and takes no longer one. */
export const ATTEMPT_ENTRIES_MAX = 16;
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
 * - `migrated`: a PC that was in the account before it had a list. `admitted` is the device keys its caller
 *   has checked for it before the pin (shared/account-list-migrate.ts): entry 0's signer and every key the
 *   list carries in, once it carries in no more. Entry 0's signer must be one of them, and so must every device
 *   that was carried in, all or none. A carried key is a signer of power `full`, so one that is not among them
 *   could add whom it likes: a list that carries one in is not a list this PC follows.
 */
export type ListPin =
  | { readonly how: "genesis" }
  | { readonly how: "allowed"; readonly seq: number; readonly hash: string }
  | { readonly how: "carried" }
  | { readonly how: "added" }
  | { readonly how: "migrated"; readonly admitted: readonly string[] };

export type ListSource = "service" | "peer";

/**
 * This member was shown two versions of the list: two histories from one place, each signed by a member,
 * proven and never taken on a word. `seq` is the place where they part, and `by` the key that signed the entry
 * of the other one that was shown: a key that the member's own history had made a signer before that place,
 * whatever became of it since. It names what was shown and accuses nobody: a member signs twice at one place
 * honestly, and whoever holds both entries, the account service first of all, chooses whom to show which.
 * `devices` and `pcs` are whom the member held when it rose: from then on it lets in only those of them that
 * are still in. It is never cleared but by a person's reset at the member, which then pins again.
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
 * a member that is behind stopped at, kept for the replay after an update: the next entry after those it holds,
 * and entry 0 itself for a member that holds none. `read_at` is when it last held
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

/**
 * Another history than the member's own, as far as a read has been shown it: the place where the two part
 * (`parts`), its entries from there on (`texts`), the signer of each of them that a member signed (`signed`),
 * and, once it had to be replayed, the other history as a list of its own up to the last of them (`alt`). A
 * read holds it between two pages; it is never saved.
 */
export interface OtherSoFar {
  readonly parts: number;
  readonly texts: readonly string[];
  readonly signed: readonly { readonly seq: number; readonly signer: string }[];
  readonly alt: ListCopy | null;
}

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
  /** Another history than the member's own that the page before ended inside: the next page is judged with it (takePage). Null otherwise. */
  readonly carry: OtherSoFar | null;
  /**
   * What this read has learnt of where the source's history parts from the member's own: every entry up to
   * `common` is the same in both, and by `parted` they have parted (null while nothing says they have). The read
   * looks for the place between the two (takePage).
   */
  readonly common: number;
  readonly parted: number | null;
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
 * - `spent`: the read has made READ_PAGES_MAX requests and there was more to ask. What it took is taken; the
 *   member goes on at its next read, from where this one came to, and may ask a peer meanwhile.
 * - `withheld`: the head lies past what was shown and nothing new was shown. Nothing to ask now.
 * - `older`: the head is an earlier place of the member's own history, under what a member signed: an old
 *   part of the log. Nothing changes.
 * - `refused`: an entry does not hold (the entry's own codes), the page has not its form (`page_form`: also a
 *   head that lies before the entries the page shows), the log goes on past what any list holds (`log_full`),
 *   or it goes on with entries that no signer signed, past what a copy keeps (`loose`). What held before it is
 *   taken. An entry that a member signed and left behind, in a place the member holds another, is refused so
 *   too (`chain_broken`): it is no fork.
 * - `stuck`: another history at or under its footing, which nothing shown proves a member signed. Nothing of
 *   it is taken, and nothing ever will be while the source shows it. `read`, when there is one, asks from an
 *   earlier place, to see where the two part, or for what follows the entries shown.
 * - `fork`: the same, and a member signed it, and it is no attempt its writer left behind: the alarm is set.
 * - `needs_newer_client`: it stopped at an entry this build cannot place.
 * - `not_my_list`: the page names another list than the member follows, or its entry 0 is not that list's, is
 *   of another account, or is not signed by whom the pin asks for.
 *
 * Only `caught_up` from the account service counts as a full read.
 */
export type FollowVerdict = "caught_up" | "more" | "asks_after" | "spent" | "withheld" | "older" | "refused" | "stuck" | "fork" | "needs_newer_client" | "not_my_list";

export type PageRefusal = ListRefusalCode | "page_form" | "log_full" | "loose";

/**
 * Whom the member lets in or shows after a page and did not before (`added`), and whom it did before and does
 * not now (`removed`): the devices and the PCs of shownDevices and shownPcs. So when the member itself stops, is
 * put out or no longer holds what its pin asks for, everybody it held is `removed`, and when it comes to be in,
 * everybody is `added`. One that came and went inside the page is in neither. A device whose `until` passes is
 * not told here: nextUntil says when to look.
 */
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

/** The account service's word on where a list stands, beside something else it answers: the list id and its head. Another form than a member's own word (ListHead), so that a peer's head is never taken for it. */
export interface ListHint {
  readonly list: string;
  readonly head: ListPlace;
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

/** Whether entry 0's signer is one the member's pin takes: its own key for a list it started, a key it had let in for a PC that was in the account before the list, anybody's otherwise. */
function pinSigner(copy: Pick<FollowerCopy, "pin" | "me">, signer: string): boolean {
  const { pin, me } = copy;
  return pin.how === "genesis" ? signer === me.key : pin.how !== "migrated" || pin.admitted.includes(signer);
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

/**
 * Where the member stands in the list it follows (Standing). A member that stopped is `stopped` whether or not
 * the list shows yet what its pin asks for: it reads no further until an update. What the pin asks for is read
 * at the member's own key (`me.key`), the key it came in by; whether a device is in is read at the key that
 * stands in its place now (standsFor): itself, or the last key it handed its place on to.
 */
export function standing(copy: FollowerCopy): Standing {
  const { state, me, pin } = copy;
  // A member that holds no entry stopped where it keeps entry 0's text: one that only a later level reads.
  if (state === null) return copy.stop === null ? "waiting" : "stopped";
  if (state.needs_replay !== undefined) return "stopped";
  if (!pinMet(copy)) return "waiting";
  // A device may have handed its place on to another key of its own (a `device` entry that ends its signer): it is in while the key that stands in its place is.
  if (me.endpoint === null) return standsFor(state, me.key) === null ? "out" : "in";
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

function changesBetween(before: FollowerCopy, after: FollowerCopy): ListChanges {
  if (after.state === before.state && after.alarm === before.alarm) return NO_CHANGES;
  const was = { devices: shownDevices(before), pcs: shownPcs(before) };
  const now = { devices: shownDevices(after), pcs: shownPcs(after) };
  const rows = after.state === null ? { devices: [], pcs: [] } : rowsOf(after.state);
  const [devicesNow, pcsNow] = [new Set(now.devices.map((row) => row.key)), new Set(now.pcs.map((row) => row.endpoint))];
  const [devicesWas, pcsWas] = [new Set(was.devices.map((row) => row.key)), new Set(was.pcs.map((row) => row.endpoint))];
  return {
    devices: {
      added: now.devices.filter((row) => !devicesWas.has(row.key)),
      // Each as the list holds it now: with the place of the entry that ended it, where one did.
      removed: was.devices.filter((row) => !devicesNow.has(row.key)).map((row) => rows.devices.find((item) => item.key === row.key) ?? row),
    },
    pcs: {
      added: now.pcs.filter((row) => !pcsWas.has(row.endpoint)),
      removed: was.pcs.filter((row) => !pcsNow.has(row.endpoint)).map((row) => rows.pcs.find((item) => item.endpoint === row.endpoint) ?? row),
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
 * otherwise. Every page and every hint does this by itself. A member calls it as well when it starts, and
 * whenever it reads its clock to decide (each tick, each session it lets in or refuses, each look at who is
 * past its `until`), and decides on the copy this gives: with the account service away no page comes, and
 * without this a clock that was set back would count again for less than it once showed. Over a restart the
 * member holds the hour of its last save and no later one, so it saves the copy this gives before it acts on
 * a decision that turned on the clock. A decision never counts the clock for less than the copy it is handed
 * holds (memberClock), and no more than that: an hour that was read and not noted here, or noted and the copy
 * not kept, is lost, and a clock set back after it lets a device in again past its `until`.
 */
export function withClock(copy: FollowerCopy, now: number): FollowerCopy {
  if (!isCount(now)) throw new RangeError("The hour is seconds since 1970, a whole number");
  return copy.seen_at !== null && copy.seen_at >= now ? copy : { ...copy, seen_at: now };
}

/** The request that begins a read, from the account service or from a peer: the entries after the member's head, or from entry 0 for a member that holds none. */
export function startRead(copy: FollowerCopy, source: ListSource): FollowRead {
  return { source, list: copy.list, after: copy.entries.length === 0 ? null : copy.entries.length - 1, back: false, left: READ_PAGES_MAX - 1, carry: null, common: 0, parted: null };
}

/** What was shown of another history than the member's own: nothing (`none`), an entry that follows one the member does not hold (`deeper`: the two part before the page), or the other history so far (`so`) with what it comes to. */
type OtherJudged =
  | { readonly found: "none" | "deeper" }
  /** `whole`: every entry of the page was taken into it, so the page may have ended inside it. */
  | { readonly found: "unproven" | "attempt" | "fork"; readonly so: OtherSoFar; readonly whole: boolean };

/** Whether `key` was a signer where the entry at `seq` stands in the member's own history: its row came in before that place and was not ended before it. No row is ever deleted. */
function signerAt(state: ListState, key: string, seq: number): boolean {
  const row = rowOf(state.signers, key);
  return row !== null && row.seq < seq && (row.ended === null || row.ended >= seq);
}

/** Whether `key` signed an entry of the member's own history at or after `from`, as a signer: it went on over what the member holds. */
function wentOn(mine: ListCopy, key: string, from: number): boolean {
  for (let seq = from; seq <= mine.state.footing.seq; seq++) {
    const text = mine.entries[seq];
    if (text !== undefined && readBody(entryFromText(text).body).signer === key && signerAt(mine.state, key, seq)) return true;
  }
  return false;
}

/**
 * What a page showed of another history than the member's own, when the kinds' taking stopped on one; and, for
 * a read that is in the middle of one (`so`), what the next page adds to it.
 *
 * The two part at the first shown entry that is not the member's entry at its place. From there the other
 * history is its entries as far as each is an entry and continues the one before it: what stands before the
 * first that does not proves what it proves. A member signed the other history when one of them is by a key
 * that was a signer there and its signature is its signer's. A loose entry counts for nothing, so what the
 * account service or a stranger signs proves nothing, and neither does a key's name on an entry it did not
 * sign.
 *
 * Not every such history is a fork. A member signs twice at one place honestly: its entries did not get their
 * place (another member's got it first, or the answer was lost), and it signed them again on the new head. The
 * account service holds every post it did not place and can show it later. So an **attempt** is no fork: from
 * the place where the two part, the entries a member signed are at most ATTEMPT_ENTRIES_MAX, all by one
 * signer, the first of them at that very place, and that signer has an entry of its own, as a signer, in the
 * member's own history at or after that place. It went on over what the member holds, and nobody else signed
 * on what it left behind. Anything else is a fork: an entry there by any other member, more entries by that
 * signer than one post holds, a signer that never signed again in the member's history, or entries that stand
 * on a loose one.
 *
 * What costs little is done first. Until a member's entry is found, each entry that names a key which was a
 * signer where the two part has its signature checked, and no other: loose entries change nothing, so that key
 * is a signer there in the other history too. Entries after it that name the same signer are taken by that
 * name: at most they make an attempt of what is none worth an alarm. Only when another key is named after it,
 * or more of its entries than one post holds, is the other history replayed as a list of its own, the member's
 * own history up to the place and the other one's entries from it (replayList), which says exactly which of
 * them a member signed. That is done once: the read keeps the replayed list (`so.alt`) and takes each further
 * page into it as into any list (shownList). So a read checks the member's own history again at most once.
 */
async function otherHistory(list: string, mine: ListCopy, so: OtherSoFar | null, after: number, shown: readonly string[]): Promise<OtherJudged> {
  let from = shown;
  let parts = so?.parts ?? 0;
  if (so === null) {
    let found: number | null = null;
    for (const [index, text] of shown.entries()) {
      const seq = after + 1 + index;
      const hash = hashOf(text);
      if (hash !== null && seq < mine.entries.length && hash === hashOf(mine.entries[seq])) continue;
      found = seq;
      break;
    }
    if (found === null) return { found: "none" };
    parts = found;
    from = shown.slice(parts - after - 1);
  }
  const begun: OtherSoFar = so ?? { parts, texts: [], signed: [], alt: null };
  // The entries that go on from where the other history stands, each continuing the one before it.
  const fresh: { readonly text: string; readonly entry: Entry; readonly body: EntryBody }[] = [];
  let before = begun.texts.length === 0 ? hashOf(mine.entries[parts - 1]) : hashOf(begun.texts[begun.texts.length - 1]);
  for (const text of from) {
    let entry: Entry;
    let body: EntryBody;
    try {
      entry = entryFromText(text);
      body = readBody(entry.body);
    } catch (error) {
      if (!(error instanceof ListEntryError)) throw error;
      break;
    }
    if (body.list !== list || body.seq !== parts + begun.texts.length + fresh.length || body.prev !== before) {
      // The very first one follows an entry the member does not hold: the two part before this page.
      if (so === null && fresh.length === 0 && body.list === list && body.seq === parts && parts === after + 1 && parts > 1) return { found: "deeper" };
      break;
    }
    fresh.push({ text, entry, body });
    before = entryHash(entry.body);
  }
  // Above the footing nothing is another history: what stands there is loose, and gives way.
  if (parts < 1 || parts > mine.state.footing.seq) return { found: "unproven", so: begun, whole: false };

  let texts = [...begun.texts, ...fresh.map((item) => item.text)];
  let signed = [...begun.signed];
  let { alt } = begun;
  let whole = fresh.length === from.length && fresh.length > 0;
  let replay = false;
  if (alt === null) {
    for (const { entry, body } of fresh) {
      const [led] = signed;
      if (led === undefined) {
        if (signerAt(mine.state, body.signer, parts) && (await verifySignature(entry.body, entry.signature, body.signer))) signed.push({ seq: body.seq, signer: body.signer });
      } else if (led.seq === parts && body.signer === led.signer && signed.length < ATTEMPT_ENTRIES_MAX) {
        signed.push({ seq: body.seq, signer: body.signer });
      } else if (led.seq === parts) {
        replay = true;
        break;
      }
    }
  }
  const taken = (took: readonly TakenListEntry[]): { readonly seq: number; readonly signer: string }[] =>
    took.filter(({ outcome }) => !(outcome.outcome === "passed_over" && outcome.loose)).map(({ held }) => ({ seq: held.body.seq, signer: held.body.signer }));
  if (replay) {
    const replayed = await replayList([...mine.entries.slice(0, parts), ...texts], LIST_LEVEL, { saved: null, given: list });
    if (replayed.member === null || replayed.member.entries.length < parts) return { found: "unproven", so: begun, whole: false };
    alt = replayed.member;
    whole = whole && alt.entries.length === parts + texts.length;
    texts = alt.entries.slice(parts);
    signed = taken(replayed.took.slice(parts));
  } else if (alt !== null && fresh.length > 0) {
    const top = alt.entries.length - 1;
    const more = await shownList(alt, { after: top, entries: fresh.map((item) => item.text), head: { seq: top + fresh.length, hash: before ?? "" } });
    alt = more.member;
    whole = whole && alt.entries.length === parts + texts.length;
    texts = alt.entries.slice(parts);
    signed = [...signed, ...taken(more.took)];
  }
  const next: OtherSoFar = { parts, texts, signed, alt };
  const [led] = signed;
  if (led === undefined) return { found: "unproven", so: next, whole };
  const attempt = led.seq === parts && signed.length <= ATTEMPT_ENTRIES_MAX && signed.every((item) => item.signer === led.signer) && wentOn(mine, led.signer, parts);
  return { found: attempt ? "attempt" : "fork", so: next, whole };
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
 * signed it and it is no attempt that its writer left behind (otherHistory): the alarm is set, once. Entries
 * that one member signed and that did not get their place are refused (`chain_broken`), and nothing changes.
 * Where the page does not show the place at which the two part, the read looks under the footing for it: at
 * the place of a head that is not the member's entry there; from an entry that follows one the member does not
 * hold, twice as far back each time; and once a page has shown entries both hold, half way between those and
 * where they are known to have parted (`common`, `parted`). So it comes to the place in about twice as many
 * requests as the history has doublings, whatever the size of the pages, and a page that narrows nothing ends
 * the search. Where a page ends inside what one member
 * posted, the read asks for what follows and judges both together (`carry`), so that the cut of a page never
 * decides between a fork and none. A member with an alarm goes on taking what continues its own history, so a
 * removal still reaches it, and lets in nobody it did not hold when the alarm rose.
 *
 * Nothing a page says makes a copy shorter under its footing, changes its list id or its pin, or takes out
 * anybody that no entry of a signer put out. A read ends, whatever its pages say: it makes at most
 * READ_PAGES_MAX requests (`spent` where more was to ask), and what is left is the next read's. Nor does a
 * copy grow without end: it holds at most LIST_ENTRIES_MAX entries, and at most LOOSE_ENTRIES_MAX of them past
 * its footing.
 *
 * What one page costs: each entry it shows is checked once, at most PAGE_ENTRIES_MAX of them. Beyond that only
 * a history that a member did sign, shown under the footing, makes the member replay its own history, and that
 * ends the read: so at most once in a read. What bounds the reads is the caller's: followStep spaces those by
 * the clock, and the caller spaces by itself those that anybody else can start, which are a read on the
 * doorbell and a page that a peer sends unasked.
 */
export async function takePage(copy: FollowerCopy, read: FollowRead, page: ListPage, now: number): Promise<PageResult> {
  if (read.list !== copy.list) throw new RangeError("The read is of another list than the copy");
  if (!isCount(now)) throw new RangeError("The hour is seconds since 1970, a whole number");
  const { source } = read;
  if (!isCount(read.left) || !(read.carry === null || isRecord(read.carry)) || !isCount(read.common) || !(read.parted === null || isCount(read.parted))) {
    throw new RangeError("A read is one that startRead or a page gave");
  }
  const asks = (after: number, back: boolean, carry: OtherSoFar | null = null, common: number = read.common, parted: number | null = read.parted): FollowRead =>
    ({ source, list: copy.list, after, back, left: read.left - 1, carry, common, parted });
  const result = (verdict: FollowVerdict, next: FollowerCopy = copy, rest: Partial<Pick<PageResult, "code" | "at" | "read">> = {}): PageResult => {
    const held = withClock(next, now);
    const told = { copy: held, code: null, at: null, changes: changesBetween(copy, held), ...rest };
    // A read that has made its share of requests asks no more, whatever this page called for.
    return rest.read != null && read.left <= 0 ? { ...told, verdict: "spent", read: null } : { ...told, verdict, read: rest.read ?? null };
  };
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
  /** What another history comes to once it is judged: an alarm, a post its writer left behind, or nothing proven; and the request for what follows it, where the page ended inside it and the source says more follows. */
  const settled = (judged: Extract<OtherJudged, { readonly so: OtherSoFar }>, held: FollowerCopy, state: ListState): PageResult | null => {
    const { so, found } = judged;
    if (found === "fork") {
      const alarm: ListAlarm = held.alarm ?? { code: "fork", source, seq: so.parts, by: so.signed[0]?.signer ?? "", at: now, devices: inDevices(state).sort(), pcs: inPcs(state).sort() };
      return result("fork", { ...held, alarm }, { at: so.parts });
    }
    const last = so.parts + so.texts.length - 1;
    if (judged.whole && head.seq > last) return result("stuck", held, { at: so.parts, read: asks(last, read.back, so) });
    return found === "attempt" ? refused("chain_broken", so.parts, held) : null;
  };
  // A page that goes on with another history the page before ended inside: it is judged with what was shown of it, and nothing of it is the member's.
  if (read.carry !== null && copy.state !== null && after !== null) {
    const judged = await otherHistory(copy.list, { entries: copy.entries, state: copy.state }, read.carry, after, shown);
    return ("so" in judged ? settled(judged, copy, copy.state) : null) ?? result("stuck", copy, { at: read.carry.parts });
  }
  // A page for a place the member no longer holds shows it nothing.
  if (after !== null && after > top) return result("withheld");

  let member: ListCopy;
  if (copy.state === null) {
    // It stopped at an entry 0 that only a later level reads: whatever it is shown, it stays so until an update.
    if (copy.stop !== null) return result("needs_newer_client");
    const [first, ...rest] = shown;
    if (first === undefined) return result("withheld");
    const started = await replayList([first], LIST_LEVEL, { saved: null, given: copy.list });
    const body = started.took[0]?.held.body;
    if (started.member === null || body === undefined) {
      const code = started.stopped?.code ?? "entry_malformed";
      if (code === "list_mismatch") return result("not_my_list");
      if (code !== "entry_invalid" && code !== "needs_replay") return refused(code, 0);
      // An entry 0 with the list id of the pin that this build cannot read as a genesis: a later level's, or no list a member follows.
      // It holds as entry 0 of the pinned list (its form, its hash, its signature). Signed by whom the pin asks for, the member keeps its text and stops there, as at any entry its build cannot place.
      const unread = readBody(entryFromText(first).body);
      return unread.v > LIST_LEVEL && pinSigner(copy, unread.signer) ? result("needs_newer_client", { ...copy, stop: first }) : result("not_my_list");
    }
    if (started.member.state.account !== copy.account || !pinSigner(copy, body.signer)) return result("not_my_list");
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
  const footing = took.member.state.footing.seq;
  // Past its footing a copy keeps only so many entries: each is one that no signer signed, and none of them changed the state.
  const loose = took.member.entries.length - 1 - footing > LOOSE_ENTRIES_MAX;
  const entries = loose ? took.member.entries.slice(0, footing + 1 + LOOSE_ENTRIES_MAX) : took.member.entries;
  const reached = entries.length - 1;
  const was = copy.state?.needs_replay;
  // An entry it would stop at that stands past what a copy keeps is one it never comes to: it stops only where it holds every entry before the stop, so that
  // a page cut anywhere gives the same copy, and its save reads. The state is as it was before that entry, but for the stop.
  const beyond = loose && was === undefined && took.member.state.needs_replay !== undefined;
  const state = beyond ? Object.fromEntries(Object.entries(took.member.state).filter(([name]) => name !== "needs_replay")) as unknown as ListState : took.member.state;
  // The entry it stopped at, kept as text for the replay after an update: the one the kinds checked when it stopped there. A member that is stopped keeps the text it has, whatever is shown in that place later.
  const halted = state.needs_replay === undefined || was !== undefined ? undefined : shown[state.needs_replay.seq - after - 1];
  const stop = state.needs_replay === undefined ? null : halted !== undefined && hashOf(halted) === state.needs_replay.hash ? halted : copy.stop;
  let next: FollowerCopy = { ...copy, entries, state, stop };

  if (beyond) return refused("loose", reached + 1, next);
  if (took.stopped?.code === "needs_replay") return result("needs_newer_client", next);
  const cursor = after + shown.length;
  const onward = asks(Math.min(cursor, reached), read.back);
  if (took.stuck) {
    const other = await otherHistory(copy.list, took.member, null, after, shown);
    if ("so" in other) {
      // Where the page ended inside the other history and the source says more follows, what follows decides: it is asked for and judged with this.
      const done = settled(other, next, state);
      if (done !== null) return done;
    }
    // The page does not show the place where the two part. What it does say narrows it: every entry it showed is the member's own, so they part after those;
    // its head is not the member's entry at that place, so they have parted by there; its first entry follows one the member does not hold, so they parted before it.
    let [common, parted] = [read.common, read.parted];
    const first = parted === null;
    if (other.found === "none") {
      if (showed) common = Math.max(common, cursor);
      if (head.seq >= 1 && head.seq <= footing && hashAt(next, head.seq) !== head.hash) parted = Math.min(parted ?? head.seq, head.seq);
    }
    if (other.found === "deeper") parted = Math.min(parted ?? after, after);
    let under: number | null = null;
    // A page that narrowed nothing says no more than the one before it: the search ends there.
    if (parted !== null && common < parted && other.found !== "unproven" && (common !== read.common || parted !== read.parted)) {
      // First the very place the source's head names. Then, while nothing is known to be common, twice as far back as this page began; and once something is, half way between.
      if (other.found === "none" && first) under = parted - 1;
      else if (other.found === "deeper" && common === 0) under = after > footing ? footing : Math.max(0, 2 * after - footing - 1);
      else under = Math.floor((common + parted - 1) / 2);
    }
    // Every entry shown is the member's own, the head is not, and nothing says yet by where they parted: the place lies further on.
    if (under === null && parted === null && other.found === "none" && showed && cursor < head.seq) return result("more", next, { read: onward });
    return result("stuck", next, { at: took.stopped?.seq ?? null, read: under === null ? null : asks(under, read.back, null, common, parted) });
  }
  if (took.stopped !== null) return refused(took.stopped.code as PageRefusal, took.stopped.seq, next);
  if (parted !== null) return result("stuck", next, { at: parted });
  if (took.asks_after !== null) {
    return result("asks_after", next, { read: read.back ? null : asks(took.asks_after, true) });
  }
  if (loose) return refused("loose", reached + 1, next);
  if (full) return refused("log_full", LIST_ENTRIES_MAX, next);
  // A read that looks for where two histories part, shown only the member's own entries: they part after those, and it looks half way on.
  if (read.parted !== null && showed && Math.max(read.common, cursor) < read.parted) {
    const common = Math.max(read.common, cursor);
    return result("more", next, { read: asks(Math.floor((common + read.parted - 1) / 2), read.back, null, common, read.parted) });
  }
  // A head that lies before the entries the page shows is no head of theirs: what held is taken, and the page says nothing of where the source stands.
  if (shown.length > 0 && head.seq < cursor) return refused("page_form", head.seq, next);

  if (head.seq > reached) return showed ? result("more", next, { read: onward }) : result("withheld", next);
  if (hashAt(next, head.seq) !== head.hash) return showed && cursor < head.seq ? result("more", next, { read: onward }) : result("withheld", next);
  // It holds the entry at the head. A head under its footing is an old part of its own history, and so is a log that ends before the head a device was handed.
  if (head.seq < footing || (pin.how === "allowed" && reached < pin.seq)) return result("older", next);
  if (source === "service") next = { ...next, read_at: now };
  return result("caught_up", next);
}

/**
 * What a member does with the head the account service names beside something else (a PC's mailbox pull, a
 * device's question which list is its account's): a hint that only says whether to read. It takes the
 * service's own form (ListHint), never a member's word on where it stands (ListHead): what a peer says is no
 * full read. The copy it gives back differs from the one handed over only in its times. `same`: the head is the
 * member's own, which counts as a full read, so a quiet list costs no request for the log. `read`: begin a read
 * (startRead). `older`: an earlier place of the member's own history; a late or lying service, and nothing
 * changes. `not_my_list`: another list id than the member follows; nothing changes, and the member does not
 * take it for its list being gone. `none`: the service named no list (null: an account it serves no list for,
 * or a service that knows of none); that is no hint, never the word that the list is gone, and the member reads
 * at its own pace.
 */
export function heardHead(copy: FollowerCopy, hint: ListHint | null, now: number): { readonly copy: FollowerCopy; readonly verdict: "same" | "read" | "older" | "not_my_list" | "none" } {
  const held = withClock(copy, now);
  if (hint === null || hint === undefined) return { copy: held, verdict: "none" };
  if (!isRecord(hint) || hint.list !== copy.list) return { copy: held, verdict: "not_my_list" };
  const { head } = hint;
  const { state } = copy;
  if (state === null || !isPlace(head) || head.seq > copy.entries.length - 1 || hashAt(copy, head.seq) !== head.hash) return { copy: held, verdict: "read" };
  // Only the member's own head is the same: a place before it, also one past its footing, is an earlier place of what it holds.
  if (head.seq < copy.entries.length - 1 || (copy.pin.how === "allowed" && copy.entries.length - 1 < copy.pin.seq)) return { copy: held, verdict: "older" };
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
 * Two members whose histories parted both come to `differs` or `behind`, both ask, and each judges what the
 * other answers (takePage): where members signed on both histories both get the alarm, and where one of them
 * holds only what its writer left behind, that one does.
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
  if (code !== "fork" || (source !== "service" && source !== "peer") || !isCount(at) || !isCount(seq) || seq < 1 || typeof by !== "string" || !isListKeyEncoding(by)) return undefined;
  if (!Array.isArray(devices) || !Array.isArray(pcs)) return undefined;
  const sorted = (names: readonly unknown[], named: (name: string) => boolean): names is readonly string[] =>
    names.every((name, at) => typeof name === "string" && named(name) && (at === 0 || (names[at - 1] as string) < name));
  // Whatever key the list may hold as a device, the alarm may hold: a key in its one spelling, also one that signs nothing.
  if (!sorted(devices, isListKeyEncoding) || !sorted(pcs, (name) => ENDPOINT.test(name))) return undefined;
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
 *   another account or is not signed by whom the pin asks for, the entry at the place an `allowed` pin names is
 *   another, or the stopped entry is not the next one.
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
  if (texts.length === 0 && stop === null) {
    // A member that has read nothing holds no footing.
    if (footing !== null) return no("broken");
    const empty: FollowerCopy = { ...held, entries: [], state: null, stop: null };
    return { read: true, copy: empty, rebuilt: writeSave(empty) !== text };
  }
  if (texts.length === 0) {
    // A member that stopped at entry 0: nothing else was read, and the replay takes its text only as the pinned list's entry 0.
    if (footing !== null) return no("broken");
  } else if (footing === null || footing.seq >= texts.length) {
    return no("broken");
  }
  /** What only a later level can place is a later build's save; anything else that does not hold is a save whose entries are not what was saved. */
  const refused = no(level > LIST_LEVEL ? "version" : "broken");
  const replayed = await replayList(stop === null ? texts : [...texts, stop], LIST_LEVEL, { saved: null, given: list });
  const member = replayed.member;
  const first = replayed.took[0]?.held.body;
  if (member === null || first === undefined) {
    // Entry 0 holds and this build reads it as no genesis: a member that stopped there stays stopped, and for any other it is a later build's save.
    if (replayed.stopped?.code !== "entry_invalid") return no("broken");
    if (texts.length > 0 || stop === null) return refused;
    if (!pinSigner({ pin, me: self }, readBody(entryFromText(stop).body).signer)) return no("broken");
    const stopped: FollowerCopy = { ...held, entries: [], state: null, stop };
    return { read: true, copy: stopped, rebuilt: writeSave(stopped) !== text };
  }
  // Every entry was taken, but for the stopped one where this build cannot place it either.
  const { state } = member;
  const at = replayed.stopped;
  if (at !== null && at.code !== "needs_replay") return no("broken");
  if (member.entries.length < texts.length || (at !== null && stop === null)) return refused;
  // Never a shorter history than the saved one: the very entry at the saved footing, and a footing no earlier.
  if (footing !== null && hashOf(member.entries[footing.seq]) !== footing.hash) return no("broken");
  if (footing !== null && state.footing.seq < footing.seq) return refused;
  // A device that was allowed holds at the place of the head it was handed only that very entry, as when it took its pages.
  if (pin.how === "allowed" && member.entries.length > pin.seq && hashOf(member.entries[pin.seq]) !== pin.hash) return no("broken");
  if (state.account !== account) return no("broken");
  if (!pinSigner({ pin, me: self }, first.signer)) return no("broken");
  const copy: FollowerCopy = { ...held, entries: member.entries, state, stop: state.needs_replay === undefined ? null : stop };
  return { read: true, copy, rebuilt: writeSave(copy) !== text };
}
