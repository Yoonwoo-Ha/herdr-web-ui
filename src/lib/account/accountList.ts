/**
 * This device and its account's signed list (docs/account-list.md, "On a device"): it keeps its own verified copy,
 * starts the list for an account that has nobody in it yet, and catches up on what the account service stores.
 *
 * The account service's answers are entries this device checks itself, or hints that only say what to read. Which
 * list is the account's is never the service's to say: this device follows a list only when entry 0 of that id is
 * a genesis of its account under its own account key, which nobody else can sign. A device that another member
 * lets in is given the list by that member, not here.
 *
 * Nothing in the app decides by this copy yet: My PCs and what opens by itself still go by the account service.
 * What the two differ in is recorded (listShadow.ts).
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import type { ListNames, ListRole, ListState } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, isListHash, ListEntryError, type SignerPower } from "../../../shared/account-list-entry.ts";
import {
  followStep, heardHead, pcOfKey, pinList, READ_PAGES_MAX, readSave, shownDevices, shownPcs, standing, startRead, takePage, writeSave,
  type FollowerCopy, type FollowerSelf, type FollowRead, type FollowVerdict, type SaveRefusal, type Standing,
} from "../../../shared/account-list-follower.ts";
import { LIST_WRAP_TEXT_LENGTH } from "../../../shared/account-list-seal.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { makeGenesis, type Genesis } from "./listGenesis.ts";
import { deviceListKeys, type DeviceListKeys } from "./listKeys.ts";
import { namesAt, openEpochs, readWraps, wrapsRecord, type OpenedEpochs } from "./listNames.ts";
import type { ListHint, ListWrap } from "./listAnswers.ts";
import { indexedListStore, listLock, type ListLock, type ListStore } from "./listStore.ts";
import { keepShadow, shadowOf, type ShadowRecord } from "./listShadow.ts";
import { inMacApp, inNativeApp } from "../nativeApp.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, PC_ADD_FRESH_MS, sameSignIn, SignedOutError, type AccountService, type DirectoryPc } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

/**
 * What stands between this device's copy and an honest log, the worst first. Each is a state a screen can show; none
 * of them takes anybody out of the copy.
 *
 * - `fork`: two histories of the list, each signed by a member. It stays until a person resets this device's copy.
 * - `stuck`: the account service shows another history under what this device already holds.
 * - `other_list`: the account service names another list for the account than the one this device follows.
 * - `refused`: the log holds an entry that no member would take.
 * - `unsigned`: the log holds an entry that no member signed. The account service places none, so it wrote this one.
 * - `wrong_key`: the account service handed this device a key to the names that is not the list's.
 * - `needs_newer_client`: the list holds an entry this build cannot place.
 */
export type ListTrouble = "fork" | "stuck" | "other_list" | "refused" | "unsigned" | "wrong_key" | "needs_newer_client";

/**
 * Why this device does not start a list for an account that may have one and has none.
 *
 * - `not_new`: this sign-in was made more than nine minutes ago: an account that was in use is not given a list this way.
 * - `not_first_device`: the account service numbered this sign-in's key other than first, or not yet at all.
 * - `has_pcs`: the account lists a PC, or this device holds a pairing linked to the account.
 * - `not_own_sign_in`, `frozen`, `session_not_fresh`: the account service takes no list from this sign-in.
 * - `refused`: the account service refused the entry itself.
 * - `clock`: it refused the entry for its time: this device's clock looks wrong.
 * - `storage`: what this page stores may be cleared by the browser at any time, and a list whose one member lost
 *   its keys lets nobody in: another device starts it.
 * - `switched_off`: this page was told to start none.
 */
export type NoGenesis = "not_new" | "not_first_device" | "has_pcs" | "not_own_sign_in" | "frozen" | "session_not_fresh" | "refused" | "clock" | "storage" | "switched_off";

/** What a device that holds no copy is at. */
type Without =
  /** Not signed in, the account service keeps no list for this account, or it has not been reached yet. */
  | { readonly at: "off" }
  /** The account may have a list, has none, and this device starts none. */
  | { readonly at: "none"; readonly why: NoGenesis }
  /**
   * The account service names a list that this device does not follow, and it reads no more of it than entry 0.
   * - `not_mine`: entry 0 is that list's and is not this device's own: it is in no list until a member lets it in.
   * - `unread`: the account service did not show the entry 0 of the list it names. It is asked again.
   * - `needs_newer_client`: entry 0 is in a form this build cannot read.
   */
  | { readonly at: "not_in"; readonly list: string; readonly why: "not_mine" | "unread" | "needs_newer_client" };

export type AccountListStatus =
  | Without
  /** What this device saved does not read. It is kept as it is, and nothing takes its place by itself. */
  | { readonly at: "damaged"; readonly why: Exclude<SaveRefusal, "version"> }
  /** What this device saved was written by a later build of the app, which this one cannot read: it needs a newer app. Kept as it is. */
  | { readonly at: "newer_save" }
  /** `head`: the place of the last entry of the copy. `read_at`: when it last held all the account service showed, in seconds. */
  | { readonly at: "following"; readonly list: string; readonly standing: Standing; readonly head: number; readonly read_at: number | null; readonly trouble: ListTrouble | null };

/** A device of the account, as the verified list says. `name` is null where this device cannot open it. */
export interface ListedDevice {
  readonly key: string;
  readonly self: boolean;
  readonly power: SignerPower;
  readonly role: ListRole;
  readonly until: number | null;
  readonly carried: boolean;
  readonly name: ListNames | null;
}

/** A PC of the account, as the verified list says, by its relay key; `server_id` is the id that key gives. */
export interface ListedPc {
  readonly endpoint: string;
  readonly server_id: string;
  readonly how: "added" | "joined" | "carried";
  /** A person at it can allow a device. */
  readonly allows: boolean;
  readonly name: ListNames | null;
}

/**
 * The devices and PCs that are in, in the order they came in: none unless this device follows the list and is in it.
 * `reached`: the last round got the account service's answers; without them the view is what this device saved.
 */
export interface AccountListView {
  readonly account: string | null;
  readonly status: AccountListStatus;
  readonly reached: boolean;
  readonly devices: readonly ListedDevice[];
  readonly pcs: readonly ListedPc[];
}

export type GenesisMode = "first-device" | "always" | "never";

/**
 * The developer's switch: `localStorage["ovis-account-list-genesis"]` set to `always` starts a list for an account
 * that already has PCs or other devices (they are not carried into it), and `never` starts none.
 */
export const GENESIS_SWITCH = "ovis-account-list-genesis";

export function genesisSwitch(): GenesisMode {
  try {
    const set = globalThis.localStorage?.getItem(GENESIS_SWITCH);
    return set === "always" || set === "never" ? set : "first-device";
  } catch { return "first-device"; }
}

export interface AccountListOptions {
  readonly service: AccountService;
  readonly accountStore: AccountStore;
  readonly listStore?: ListStore;
  readonly lock?: ListLock;
  /** This device's clock, in ms. */
  readonly now?: () => number;
  /** This device's name and OS, which a genesis seals; null seals none. */
  readonly names?: () => ListNames | null;
  /** How many of the PCs this device saved are linked to the account. */
  readonly linkedPcs?: (account: string) => Promise<number>;
  readonly genesis?: () => GenesisMode;
  /** Whether what this page stores lasts (storageLasts): a device starts a list by itself only where it does. */
  readonly durable?: () => Promise<boolean>;
}

/**
 * Whether what this page stores lasts: inside the app, or where the browser already says that it keeps this site's
 * data. The browser is never asked to keep it (that prompts in some): a tab whose data may go waits for another device.
 */
export async function storageLasts(): Promise<boolean> {
  if (inNativeApp() || inMacApp()) return true;
  try { return await globalThis.navigator?.storage?.persisted?.() === true; } catch { return false; }
}

/** A device asks again this often, in seconds, while the account has no list or it is in none. */
export const NO_LIST_SECONDS = 300;
/**
 * How long the account service's word that it keeps no list for an account stands, in seconds: the device asks no
 * more often than this, whatever page asks and however often the app starts.
 */
export const OFF_SECONDS = 24 * 60 * 60;
/**
 * How long a device waits, in seconds, after one, two, three and more rounds in a row that did not reach the account
 * service: a service that is away or has no such routes is not asked every five minutes for good.
 */
export const UNREACHED_SECONDS: readonly number[] = [300, 900, 3600, 6 * 3600];
/** A request of a round ends after this long. Each page of the log has this long of its own. */
const ROUND_MS = 30_000;
/**
 * A round asks for no further page of the log once it has read for this long: it holds the lock that another tab's
 * round waits for. Every page it took by then is saved, and the next round goes on from there.
 */
const READ_MS = 30_000;
/** How often one round loads the copy again after another page saved one under it. */
const SAVE_TRIES = 3;

/** Another page saved the account's copy while this one worked on the copy it had read: this one's is not written. */
class StaleCopyError extends Error {
  constructor() {
    super("Another page saved the list meanwhile");
    this.name = "StaleCopyError";
  }
}

const RECORD_VERSION = 1;
const OFF: AccountListView = { account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A genesis this device signed and has not seen in its saved copy, with the key it was signed with. */
type PendingGenesis = Genesis & { readonly key: string };

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

/** When the account service said that it keeps no list for the account, in seconds, as this device kept it; null for no such record. */
function readOff(value: unknown): number | null {
  return isRecord(value) && value.v === RECORD_VERSION && typeof value.off_at === "number" && Number.isSafeInteger(value.off_at) && value.off_at >= 0 ? value.off_at : null;
}

/** The ids of the entries 0 this device signed and gave up for good: the account has another list, or the account service refused them. */
function readDropped(value: unknown): string[] {
  return isRecord(value) && value.v === RECORD_VERSION && Array.isArray(value.lists) ? value.lists.filter((list): list is string => typeof list === "string" && isListHash(list)) : [];
}

function readPending(value: unknown, keys: DeviceListKeys): PendingGenesis | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION) return null;
  const { key, enc, list, entry, wrap } = value;
  if (key !== keys.key || enc !== keys.enc.key || typeof list !== "string" || !isListHash(list) || typeof entry !== "string" || typeof wrap !== "string" || wrap.length !== LIST_WRAP_TEXT_LENGTH) return null;
  return hashOf(entry) === list ? { key, enc, list, entry, wrap } : null;
}

/** The account service's own refusal of a request, as against no answer or a refresh that failed. */
const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);

/**
 * The account service gave no answer this round can use: it is away, slow, refused, or sent something out of form,
 * a body that is no JSON (cut off on the way) included. What the device saved stands then.
 */
function unreached(error: unknown): boolean {
  return error instanceof AccountServiceError || error instanceof AccountServiceUnreachableError || error instanceof SyntaxError
    || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));
}

function troubleOf(verdict: FollowVerdict): ListTrouble | null {
  switch (verdict) {
    case "fork": return "fork";
    case "stuck": return "stuck";
    case "not_my_list": return "other_list";
    case "refused": return "refused";
    case "needs_newer_client": return "needs_newer_client";
    default: return null;
  }
}

const WORST: readonly ListTrouble[] = ["fork", "stuck", "other_list", "refused", "unsigned", "wrong_key", "needs_newer_client"];
const worst = (troubles: readonly (ListTrouble | null)[]): ListTrouble | null => WORST.find((trouble) => troubles.includes(trouble)) ?? null;

/**
 * Whether two copies of one list are the same save: the same entries, stop and alarm, last read in full at the same
 * time, under the same floor of the clock. Each entry names the one before it by its hash, so the same last entry at
 * the same place is the same history, and the state is what the entries give.
 */
function sameSave(a: FollowerCopy, b: FollowerCopy): boolean {
  return a.list === b.list && a.entries.length === b.entries.length && a.entries.at(-1) === b.entries.at(-1) && a.stop === b.stop
    && (a.state === null) === (b.state === null) && JSON.stringify(a.alarm) === JSON.stringify(b.alarm) && a.read_at === b.read_at && a.seen_at === b.seen_at;
}

/** One account's list in this page's memory. */
interface Held {
  readonly account: string;
  readonly copy: FollowerCopy | null;
  /** The text the copy was saved as, by which this page sees that another page wrote since. */
  readonly saved: string | null;
  /** What the last read said is wrong: it stands until a read ends otherwise. */
  readonly trouble: ListTrouble | null;
  /** Where the device is while it holds no copy. */
  readonly without: Without;
  /** The round that gave this did not get the device's own log read: it counts as one that did not reach the account service. */
  readonly unread?: true;
  /** The round that gave this took pages of the log and left some: the next one goes on at once. */
  readonly behind?: true;
}

/**
 * What a copy holds, whatever the hour it was saved at: its list, how many entries, the last one, its stop and its
 * alarm. The names and the wraps go by this, not by the saved text, which changes with every round's times.
 */
const historyOf = (copy: FollowerCopy): string => JSON.stringify([copy.list, copy.entries.length, copy.entries.at(-1) ?? null, copy.stop, copy.alarm]);

/** The members of one history (historyOf) with their names as far as they opened: they change only with the entries or with the wraps this device holds. */
interface Named {
  readonly history: string;
  /** The current epoch's key opened: there is no wrap left to ask for. */
  readonly complete: boolean;
  readonly devices: readonly ListedDevice[];
  readonly pcs: readonly ListedPc[];
}

/** A round that reached the account service: what it may still ask with. */
interface Asking { readonly bound: AccountService; readonly signal: AbortSignal }

export interface AccountList {
  /**
   * One round for the sign-in stored now: reads what is saved, asks the account service, takes what it shows, saves,
   * and resolves to the view after it. Asked while a round is under way, it waits for that one and runs one more,
   * since the sign-in may have changed under it. An account service that is away, slow or lying is a state of the
   * view; only a sign-in that ended throws (SignedOutError).
   */
  sync(): Promise<AccountListView>;
  view(): AccountListView;
  /** Hears each view that differs from the one before. */
  subscribe(listener: (view: AccountListView) => void): () => void;
  /** Whether the PC with this relay key (64 hex) is in the list as this device holds it. */
  holdsPc(endpoint: string): boolean;
  /** The relay key of the PC that signs with this key, when that PC is in the list as this device holds it; null otherwise. */
  pcOfKey(key: string): string | null;
  /** When the next round is due, in ms by this device's clock, given whether the app is in front; null for not by the clock. */
  due(inFront: boolean): number | null;
  /**
   * Holds the view against the account service's directory, read for `account`, and keeps what they differ in
   * (listShadow.ts); null where there is nothing to compare. `opens`: the ids of the PCs the app would open by itself.
   */
  shadow(account: string, directory: readonly DirectoryPc[], opens?: ReadonlySet<string>): Promise<ShadowRecord | null>;
  /**
   * The sign-in ended, and the device is still a member with the key it has: forgets what opens the account's names
   * (the wraps, and a genesis that was not seen placed). The copy stays, so that a later sign-in takes up where this
   * one stood and no older log passes for the list. The wraps are asked for again then.
   */
  dropNames(account: string): Promise<void>;
  /** A person's reset, or the device left the account: forgets everything kept for the account. */
  forget(account: string): Promise<void>;
}

export function accountList(options: AccountListOptions): AccountList {
  const { service, accountStore } = options;
  const store = options.listStore ?? indexedListStore;
  const lock = options.lock ?? listLock;
  const now = options.now ?? Date.now;
  const seconds = (): number => Math.floor(now() / 1000);
  const listeners = new Set<(view: AccountListView) => void>();
  let held: Held | null = null;
  let named: Named | null = null;
  /** The account whose wraps, at the last time they were asked for, held a key that is not the list's. */
  let wrongKey: string | null = null;
  /** The copy the wraps were last asked for, and when: they are asked for again for another copy, or after NO_LIST_SECONDS. */
  let wrapsAsked: { readonly history: string; readonly at: number } | null = null;
  let shown: AccountListView = OFF;
  let askedAt: number | null = null;
  /** The account the pacing below is counted for. */
  let pacedFor: string | null = null;
  /** The last round took pages of the log and left some: the next one is due at once. */
  let behind = false;
  /** The round under way and what ends it. */
  let roundStop: { readonly account: string; readonly stop: AbortController } | null = null;
  /** Rounds in a row that did not reach the account service. */
  let misses = 0;
  /** When the account service last said that it keeps no list for the account in view, in seconds; null otherwise. */
  let offAt: number | null = null;
  let running: Promise<AccountListView> | null = null;
  /** The one round that follows the round under way, for whoever asked meanwhile: the sign-in may have changed under it. */
  let queued: Promise<AccountListView> | null = null;

  const publish = (view: AccountListView): AccountListView => {
    const same = JSON.stringify(view) === JSON.stringify(shown);
    shown = view;
    if (!same) for (const listener of listeners) listener(view);
    return view;
  };

  /** The saved copy as this page holds it: read again only when another page wrote since. */
  const load = async (account: string, keys: DeviceListKeys, saved: unknown): Promise<Held | SaveRefusal> => {
    const fresh: Held = { account, copy: null, saved: null, trouble: null, without: held?.account === account ? held.without : { at: "off" } };
    if (saved === undefined) return fresh;
    if (typeof saved !== "string") return "form";
    // the copy this page holds, while it is the one saved and this device's key is the one it was pinned under
    if (held !== null && held.account === account && held.saved === saved && held.copy !== null && held.copy.me.key === keys.key) return held;
    const read = await readSave(saved);
    if (!read.read) return read.why;
    // saved under another account key: this device has a new one since, and is another member
    if (read.copy.me.key !== keys.key || read.copy.me.endpoint !== null) {
      // what goes is the very copy that was read: one another page saved since, under the key of now, stays
      if (!await store.drop(account, saved)) throw new StaleCopyError();
      return fresh;
    }
    if (read.copy.account !== account) return "broken";
    // the entries gave another state than the one saved with them (another build's, as after an update): the copy is
    // written again as this build writes it, once
    const text = read.rebuilt ? writeSave(read.copy) : saved;
    if (read.rebuilt) {
      if (!await store.swap("copy", account, saved, text)) throw new StaleCopyError();
      console.info("Ovis: the account's list was read again from its entries, and saved as this build saves it");
    }
    return { ...fresh, copy: read.copy, saved: text };
  };

  /**
   * Saves a copy that differs from the one this page read: in its entries, its stop or its alarm, or in the time of
   * its last full read and the floor of its clock, which move with every round that reached the account service. It
   * is written only over the very text this page read (`before`): where another page saved meanwhile, nothing is
   * written and the round reads again (StaleCopyError), so no page's save goes over a newer one, or over an alarm.
   */
  const save = async (before: { readonly copy: FollowerCopy | null; readonly saved: string | null }, copy: FollowerCopy): Promise<string> => {
    if (before.copy !== null && before.saved !== null && sameSave(before.copy, copy)) return before.saved;
    const text = writeSave(copy);
    if (text === before.saved) return text;
    if (!await store.swap("copy", copy.account, before.saved ?? undefined, text)) throw new StaleCopyError();
    return text;
  };

  /** `signed`: this device signed an entry 0 that it has not seen placed, while its sign-in was new: it is sent again however old the sign-in is by then. */
  const mayStart = async (bound: AccountService, session: AccountSession, signed: boolean, signal: AbortSignal): Promise<NoGenesis | null> => {
    const mode = (options.genesis ?? genesisSwitch)();
    if (mode === "never") return "switched_off";
    if (mode === "first-device") {
      const age = session.signed_in_at === undefined ? Number.NaN : now() - session.signed_in_at;
      if (!signed && !(age >= 0 && age <= PC_ADD_FRESH_MS)) return "not_new";
      if (!signed && !await (options.durable ?? storageLasts)()) return "storage";
      const kept = await accountStore.get("signin_key");
      if (kept === undefined || kept.account !== session.account || kept.sign_in_id !== session.sign_in_id || kept.no !== 1) return "not_first_device";
      if (await (options.linkedPcs?.(session.account) ?? Promise.resolve(0)) > 0) return "has_pcs";
    }
    if (!await bound.ownSignIn(signal)) return "not_own_sign_in";
    if (mode === "first-device" && (await bound.listPcs(signal)).length + (await bound.listUnconfirmedPcs(signal)).length > 0) return "has_pcs";
    return null;
  };

  /**
   * Gives up an entry 0 this device signed, for good: it is kept no more to send, and its id is written down, so the
   * device never follows that list, whoever names it later and whatever page of the app is asked.
   */
  const giveUp = async (account: string, list: string): Promise<void> => {
    const dropped = readDropped(await store.get("dropped", account));
    if (!dropped.includes(list)) await store.set("dropped", account, { v: RECORD_VERSION, lists: [...dropped, list] });
    await store.set("genesis", account, undefined);
  };

  /**
   * Starts the account's list. The genesis is kept before it is sent, and sent again as it is until this device's
   * saved copy holds it or the account turns out to have another list: a lost answer or a closed page makes no
   * second one.
   */
  const start = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, signal: AbortSignal): Promise<"placed" | "exists" | NoGenesis> => {
    let pending = readPending(await store.get("genesis", session.account), keys);
    const refused = await mayStart(bound, session, pending !== null, signal);
    if (refused !== null) return refused;
    if (pending === null) {
      // Entry 0 is dated by this device's own clock, whatever the account service says the time is: a member signs
      // no time on the service's word. A service that refuses the entry for its time says so (`clock`).
      pending = { key: keys.key, ...await makeGenesis({ account: session.account, keys, names: options.names?.() ?? null, now: now() }) };
      await store.set("genesis", session.account, { v: RECORD_VERSION, ...pending });
    }
    try {
      return await bound.startList(pending.list, pending.entry, { member: pending.enc, wrap: pending.wrap }, signal);
    } catch (error) {
      const said = refusalOf(error);
      if (said === null || said.status === 429 || said.status >= 500) throw error;
      if (said.status === 403 && said.code === "own_sign_in_required") return "not_own_sign_in";
      if (said.status === 403 && (said.code === "frozen" || said.code === "session_not_fresh")) return said.code;
      // the entry itself was refused, so it was not placed and never will be as it is: the device gives it up for
      // good, and the next try signs another
      if (said.status === 400) await giveUp(session.account, pending.list);
      return said.status === 400 && said.reason === "issued_at_ahead" ? "clock" : "refused";
    }
  };

  /**
   * The epoch keys this device holds for the copy: from the wraps it kept, and while the current epoch's key is not
   * among them, from the wraps the account service holds for it. A wrap is kept only when it opens to the key the list
   * commits to; one that opens to another key is the account service's doing, and is said (`wrong_key`).
   */
  const epochsOf = async (copy: FollowerCopy, state: ListState, history: string, keys: DeviceListKeys, ask: Asking | null): Promise<OpenedEpochs> => {
    const kept = readWraps(await store.get("wraps", copy.account), copy.list, keys.enc.key);
    const opened = await openEpochs(state, kept, keys.enc);
    if (opened.keys.has(state.epoch)) {
      if (wrongKey === copy.account) wrongKey = null;
      return opened;
    }
    const at = seconds();
    const due = wrapsAsked === null || wrapsAsked.history !== history || at < wrapsAsked.at || at - wrapsAsked.at >= NO_LIST_SECONDS;
    if (ask === null || !due) return opened;
    wrapsAsked = { history, at };
    let shown: readonly ListWrap[];
    try {
      shown = await ask.bound.listWraps(copy.list, keys.enc.key, ask.signal);
    } catch (error) {
      // names wait for another round; who is in never waited for them
      if (!unreached(error)) throw error;
      return opened;
    }
    const tried = new Map(opened.good.map((epoch) => [epoch, kept.wraps.get(epoch) ?? ""]));
    for (const wrap of shown) if (!tried.has(wrap.epoch)) tried.set(wrap.epoch, wrap.wrap);
    const again = await openEpochs(state, { ...kept, wraps: tried }, keys.enc);
    wrongKey = again.wrong.length > 0 ? copy.account : wrongKey === copy.account ? null : wrongKey;
    if (again.good.length !== kept.wraps.size || again.good.some((epoch) => kept.wraps.get(epoch) !== tried.get(epoch))) {
      await store.set("wraps", copy.account, wrapsRecord({ ...kept, wraps: new Map(again.good.map((epoch) => [epoch, tried.get(epoch) ?? ""])) }));
    }
    return again;
  };

  const viewOf = async (next: Held, keys: DeviceListKeys, ask: Asking | null): Promise<AccountListView> => {
    const { copy, account } = next;
    const reached = ask !== null;
    if (copy === null || copy.state === null) return { account, status: next.without, reached, devices: [], pcs: [] };
    const { state } = copy;
    const stands = standing(copy);
    // the account service places only what a signer signed: an entry past the last one a signer signed is its own writing
    const unsigned = copy.entries.length - 1 > state.footing.seq && state.needs_replay === undefined;
    const follows = (): AccountListStatus => ({
      at: "following", list: copy.list, standing: stands, head: copy.entries.length - 1, read_at: copy.read_at,
      trouble: worst([copy.alarm === null ? null : "fork", next.trouble, unsigned ? "unsigned" : null, wrongKey === account ? "wrong_key" : null]),
    });
    if (stands !== "in") return { account, status: follows(), reached, devices: [], pcs: [] };
    const history = historyOf(copy);
    if (named === null || named.history !== history || (!named.complete && ask !== null)) {
      const opened = await epochsOf(copy, state, history, keys, ask);
      const nameAt = (seq: number): Promise<ListNames | null> => namesAt(copy.list, copy.entries, seq, opened.keys);
      const devices: ListedDevice[] = [];
      for (const row of shownDevices(copy)) {
        devices.push({ key: row.key, self: row.key === keys.key, power: row.power, role: row.role, until: row.until, carried: row.carried, name: await nameAt(row.seq) });
      }
      const pcs: ListedPc[] = [];
      for (const row of shownPcs(copy)) {
        pcs.push({ endpoint: row.endpoint, server_id: deriveServerId(hexToBytes(row.endpoint)), how: row.how, allows: row.allows, name: await nameAt(row.seq) });
      }
      named = { history, complete: opened.keys.has(state.epoch), devices, pcs };
    }
    return { account, status: follows(), reached, devices: named.devices, pcs: named.pcs };
  };

  /**
   * Reads the log after the copy's own head. Every page is saved as it is taken, before the next is asked for, and has
   * its own time to answer. The read ends when the log is read, after READ_PAGES_MAX pages (the follower's bound),
   * after READ_MS, or at a page that did not come (`cut`): what was taken until then is kept, and the next round goes
   * on from there. So a device that is n entries behind gets there in at most n / 256 rounds that each got one page.
   */
  const read = async (bound: AccountService, from: FollowerCopy, before: { readonly copy: FollowerCopy | null; readonly saved: string | null }, stopped: AbortSignal): Promise<{ copy: FollowerCopy; saved: string; verdict: FollowVerdict; cut: boolean; more: boolean }> => {
    let copy = from;
    // a new copy is saved before its first page is asked for: that is the pin. One that was saved before is written
    // with the first page that comes
    let at: { copy: FollowerCopy | null; saved: string | null } = before.saved === null ? { copy, saved: await save(before, copy) } : before;
    let verdict: FollowVerdict = "withheld";
    let next: FollowRead | null = startRead(copy, "service");
    const began = performance.now();
    for (let pages = 0; next !== null && pages < READ_PAGES_MAX && performance.now() - began < READ_MS; pages += 1) {
      let page: Awaited<ReturnType<AccountService["listLog"]>>;
      try {
        page = await bound.listLog(copy.list, next.after, AbortSignal.any([stopped, AbortSignal.timeout(ROUND_MS)]));
      } catch (error) {
        if (stopped.aborted || !unreached(error)) throw error;
        return { copy, saved: at.saved ?? await save(at, copy), verdict, cut: true, more: true };
      }
      const took = await takePage(copy, next, { list: page.list, after: page.after, entries: page.entries, head: page.head }, seconds());
      stopped.throwIfAborted();
      at = { copy: took.copy, saved: await save(at, took.copy) };
      ({ copy, verdict } = took);
      next = took.read;
    }
    return { copy, saved: at.saved ?? await save(at, copy), verdict, cut: false, more: next !== null };
  };

  /** What a round does with the list the account service names (`named`: null for none); `loaded` is what this device saved. */
  const follow = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, loaded: Held, told: ListHint | null, signal: AbortSignal, stopped: AbortSignal): Promise<Held> => {
    const { account } = session;
    let hint = told;
    let copy = loaded.copy;
    const fresh = copy === null;
    if (copy === null) {
      if (hint === null) {
        const started = await start(bound, session, keys, signal);
        if (started !== "placed" && started !== "exists") return { ...loaded, without: { at: "none", why: started } };
        const after = await bound.accountList(signal);
        const named = after === "off" ? null : after.hint;
        if (named === null) throw new AccountServiceError(502, "invalid_answer", "The account service took a list and names none");
        hint = named;
      }
      // a list that is not this device's own is not read again while the account service names it
      if (loaded.without.at === "not_in" && loaded.without.why === "not_mine" && loaded.without.list === hint.list) return loaded;
      // nor is a list whose entry 0 this device signed and gave up: it follows that one never, whoever names it
      if (readDropped(await store.get("dropped", account)).includes(hint.list)) return { ...loaded, without: { at: "not_in", list: hint.list, why: "not_mine" } };
      const me: FollowerSelf = { key: keys.key, endpoint: null };
      const pinned = pinList(null, { account, list: hint.list, me, pin: { how: "genesis" } });
      if (!pinned.pinned) throw new RangeError("This account or this device's key cannot follow a list");
      // only entry 0 says whether this device started the list; nothing else of it is asked for before that
      const first = startRead(pinned.copy, "service");
      const page = await bound.listLog(hint.list, first.after, signal, 1);
      const began = await takePage(pinned.copy, first, { list: page.list, after: page.after, entries: page.entries, head: page.head }, seconds());
      const pending = readPending(await store.get("genesis", account), keys);
      if (began.copy.state === null) {
        // not this device's own only when what was shown is that list's entry 0: anything else is the account service not showing it
        const shown = page.list === hint.list && hashOf(page.entries[0]) === hint.list;
        const why = !shown ? "unread" : began.verdict === "needs_newer_client" ? "needs_newer_client" : began.verdict === "not_my_list" ? "not_mine" : "unread";
        // the account has a list that is not the one this device signed: its own will never be the account's
        if (why === "not_mine" && pending !== null && pending.list !== hint.list) await giveUp(account, pending.list);
        return { ...loaded, without: { at: "not_in", list: hint.list, why } };
      }
      ({ copy } = began);
      if (pending !== null && pending.list === copy.list) await store.set("wraps", account, wrapsRecord({ list: copy.list, member: keys.enc.key, wraps: new Map([[0, pending.wrap]]) }));
    }

    // a device that follows a list starts no other over it, whatever the account service names
    const heard = heardHead(copy, hint === null ? null : { list: hint.list, head: hint.head }, seconds());
    ({ copy } = heard);
    let verdict: FollowVerdict = heard.verdict === "same" ? "caught_up" : "older";
    // The account service names another list, which the device says, or none, which is no hint at all (the follower's
    // rule). Either way the device reads its own list at its own pace: a removal must still reach it.
    const other = heard.verdict === "not_my_list";
    let unread = false;
    let behind = false;
    let saved: string;
    if (heard.verdict === "read" || other || heard.verdict === "none") {
      const had = copy.entries.length;
      const got = await read(bound, copy, loaded, stopped);
      ({ copy, saved } = got);
      // a page that did not come: what was said before stands. With pages taken before it, the next round goes on
      // at once; with none, the round counts as one that did not reach the account service
      behind = got.more && copy.entries.length > had;
      unread = got.cut && !behind;
      if (!got.cut || behind) ({ verdict } = got);
    } else saved = await save(loaded, copy);
    // the genesis is in the saved copy now, and its wrap with the others: what was kept to send it again goes
    if (fresh) await store.set("genesis", account, undefined);
    return { account, copy, saved, trouble: worst([troubleOf(verdict), other ? "other_list" : null]), without: { at: "off" }, ...(unread ? { unread: true as const } : {}), ...(behind ? { behind: true as const } : {}) };
  };

  const round = async (): Promise<AccountListView> => {
    const session = await service.session();
    // from here on a round counts as asked, whatever becomes of it: one that fails early is not begun again at once
    askedAt = seconds();
    if (session === undefined) {
      held = null;
      offAt = null;
      misses = 0;
      return publish(OFF);
    }
    const bound = service.forSignIn(session);
    const { account } = session;
    // how often the account service is asked is counted for one account: another one's sign-in starts anew
    if (pacedFor !== account) {
      pacedFor = account;
      misses = 0;
      offAt = null;
      behind = false;
    }
    // a leave or a deletion of the account ends the round under way (forget): nothing of it is written or shown after
    const stop = new AbortController();
    roundStop = { account, stop };
    try {
      return await lock(account, async () => {
        for (let tries = 1; ; tries += 1) {
          try {
            stop.signal.throwIfAborted();
            return await once(session, bound, stop.signal);
          } catch (error) {
            if (stop.signal.aborted) return shown;
            // another page saved the copy under this round: it loads what is saved now and takes its pages again
            if (!(error instanceof StaleCopyError)) throw error;
            if (tries >= SAVE_TRIES) {
              misses += 1;
              return shown;
            }
          }
        }
      });
    } finally {
      if (roundStop?.stop === stop) roundStop = null;
    }
  };

  /** One round's work on the copy as it is saved now, under the account's lock. */
  const once = async (session: AccountSession, bound: AccountService, stopped: AbortSignal): Promise<AccountListView> => {
    const { account } = session;
    {
      const signal = AbortSignal.any([stopped, AbortSignal.timeout(ROUND_MS)]);
      const saved = await store.get("copy", account);
      const off = (at: number): AccountListView => {
        held = null;
        offAt = at;
        misses = 0;
        return publish({ account, status: { at: "off" }, reached: true, devices: [], pcs: [] });
      };
      // The account service said, less than a day ago, that it keeps no list for this account: it is not asked again
      // by this page or any other, however often the app starts. A device that follows a list asks all the same.
      const told = saved === undefined ? readOff(await store.get("asked", account)) : null;
      const at = seconds();
      if (told !== null && told <= at && at - told < OFF_SECONDS) return off(told);
      offAt = null;
      let hint: ListHint | null | "off" | undefined;
      try {
        const answer = await bound.accountList(signal);
        hint = answer === "off" ? "off" : answer.hint;
      } catch (error) {
        if (stopped.aborted || !unreached(error)) throw error;
      }
      // an account the service keeps no list for, on a device that follows none: no key is made, and one record is
      // kept, the time of that answer
      if (saved === undefined && hint === "off") {
        // the day runs from when the answer came, in whole seconds and never a part of one early
        const answered = Math.ceil(now() / 1000);
        await store.set("asked", account, { v: RECORD_VERSION, off_at: answered });
        return off(answered);
      }
      if (saved === undefined && hint === undefined) {
        misses += 1;
        if (held?.account !== account) held = null;
        return publish({ account, status: held?.without ?? { at: "off" }, reached: false, devices: [], pcs: [] });
      }
      const keys = await deviceListKeys(accountStore);
      const loaded = await load(account, keys, saved);
      if (typeof loaded === "string") {
        held = null;
        return publish({ account, status: loaded === "version" ? { at: "newer_save" } : { at: "damaged", why: loaded }, reached: hint !== undefined, devices: [], pcs: [] });
      }
      let next = loaded;
      // for a device that follows a list, an account off the service's switch is the service being away, never "the list is gone"
      let reached = hint !== undefined && hint !== "off";
      if (hint !== undefined && hint !== "off") {
        try {
          next = await follow(bound, session, keys, loaded, hint, signal, stopped);
          if (next.unread === true) reached = false;
        } catch (error) {
          if (stopped.aborted || !unreached(error)) throw error;
          // what this device saved stands as it is
          reached = false;
        }
      }
      stopped.throwIfAborted();
      // the wraps are asked for with a time of their own: the pages before them may have used up the round's
      const view = await viewOf(next, keys, reached ? { bound, signal: AbortSignal.any([stopped, AbortSignal.timeout(ROUND_MS)]) } : null);
      stopped.throwIfAborted();
      // another page stored another sign-in, or none, while this round ran: nothing of the account it began with is shown
      const still = await service.session();
      if (still === undefined || !sameSignIn(still, session)) {
        held = null;
        misses = 0;
        return publish(OFF);
      }
      misses = reached ? 0 : misses + 1;
      behind = next.behind === true;
      held = next;
      return publish(view);
    }
  };

  const sync = (): Promise<AccountListView> => {
    if (running !== null) {
      queued ??= running.then(() => undefined, () => undefined).then(() => {
        queued = null;
        return sync();
      });
      return queued;
    }
    running = round().catch((error: unknown) => {
      // the sign-in ended under the round: what it showed was that sign-in's
      if (error instanceof SignedOutError) {
        held = null;
        publish(OFF);
      }
      throw error;
    }).finally(() => { running = null; });
    return running;
  };

  return {
    sync,
    view: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    holdsPc(endpoint) {
      return shown.pcs.some((pc) => pc.endpoint === endpoint);
    },
    pcOfKey(key) {
      const endpoint = held?.copy == null || held.account !== shown.account ? null : pcOfKey(held.copy, key);
      return endpoint !== null && shown.pcs.some((pc) => pc.endpoint === endpoint) ? endpoint : null;
    },
    due(inFront) {
      const { status } = shown;
      if (!inFront || shown.account === null || status.at === "damaged" || status.at === "newer_save") return null;
      // the account service keeps no list for the account: once a day
      if (offAt !== null) return (offAt + OFF_SECONDS) * 1000;
      // it was not reached: a longer wait after each round in a row that was not
      if (misses > 0) return ((askedAt ?? seconds()) + (UNREACHED_SECONDS[Math.min(misses, UNREACHED_SECONDS.length) - 1] ?? NO_LIST_SECONDS)) * 1000;
      // pages of the log are left to take: at once (the follower of the timer keeps rounds five seconds apart)
      if (behind) return now();
      if (status.at !== "following" || held?.copy == null) return ((askedAt ?? seconds()) + NO_LIST_SECONDS) * 1000;
      const step = followStep(held.copy, seconds(), { event: "tick", asked_at: askedAt, busy: true });
      return step.do === "read" ? now() : step.do === "wait" && step.until !== null ? step.until * 1000 : null;
    },
    async shadow(account, directory, opens) {
      const compared = shown.account === account ? shadowOf(shown, directory, now(), opens) : null;
      // one at a time for an account, among this page's comparisons and the other pages': each reads the count and writes it back
      return compared === null ? null : lock(account, () => keepShadow(store, account, compared));
    },
    async dropNames(account) {
      await lock(account, async () => {
        await store.set("wraps", account, undefined);
        await store.set("genesis", account, undefined);
      });
      if (wrongKey === account) wrongKey = null;
      named = null;
      wrapsAsked = null;
      // the names this page had open go too: who is in stays, and whoever listens is told
      if (shown.account === account && [...shown.devices, ...shown.pcs].some((row) => row.name !== null)) {
        publish({ ...shown, devices: shown.devices.map((row) => ({ ...row, name: null })), pcs: shown.pcs.map((row) => ({ ...row, name: null })) });
      }
    },
    async forget(account) {
      // the round under way for the account ends here, rather than be waited for: it holds the account's lock
      if (roundStop?.account === account) roundStop.stop.abort(new DOMException("The account's list is forgotten", "AbortError"));
      await lock(account, () => store.drop(account));
      if (held?.account === account) held = null;
      if (wrongKey === account) wrongKey = null;
      named = null;
      wrapsAsked = null;
      if (shown.account === account) { offAt = null; misses = 0; publish(OFF); }
    },
  };
}
