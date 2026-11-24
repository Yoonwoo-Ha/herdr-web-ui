/**
 * Moving an account that was in use onto its signed list (docs/account-list.md, "An account that was in use"):
 * what the first device carries in, the entries it signs for that, how a device names its list to a PC and what
 * the PC checks before it follows, what a carried device asks before it follows a list it did not make, and how
 * a row that a PC keeps by a device's sign-in key moves to the key the device goes on with. The kinds are under
 * it (shared/account-list.ts) and it changes none of their rules: every entry here is signed by signListEntry or
 * signGenesis, so none is written that would not count.
 *
 * This is the one moment a list is made from what the account service says, so nothing here takes the service's
 * word. A list is named to a PC only by a device inside its own session with that PC, signed in with a key the
 * PC has let in for a day; a device follows a list it did not make only when the PCs it knows say that they let
 * the key that started it in; and the first device carries a key in only where every PC it knows does so.
 *
 * In a list that was made this way, the keys it is born with are the keys the devices' sign-ins registered with
 * the account service, since those are the keys the PCs let in before the list. Entry 0 is signed by the first
 * device's sign-in key, the run of `carried` entries follows, and the first device ends the run with a `device`
 * entry that hands its place to its account key. Every carried device does the same when it next runs.
 *
 * No I/O, no storage, nothing random and NO CLOCK: every time here is a duration that the one who measured it
 * hands over, so no two machines' clocks are ever compared, and the list's own time (listClock) is never asked.
 * Sealing, which needs a random key, is the caller's (MigrationSeals).
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalBase64Url, isListHash, verifySignature, writeFieldsUnder } from "./account-list-entry.ts";
import {
  CARD_SIGNATURE_CHARS, ListKindError, inviteRefusal, isListKey, listView, sealEpoch, signCard, signGenesis, signListEntry, wrapKeys,
  type ListNames, type ListSigner, type ListState, type Sealed, type WrittenEntry,
} from "./account-list.ts";
import { toBase64Url } from "./relay-pair-sas.ts";

/** How long a PC must have let a key in, by its wall clock, before the key counts: a day, in seconds. */
export const MIGRATION_WITNESS_SECONDS = 86400;
/**
 * How long the PC itself must have been running with the key let in, by its own count of the time it ran: six
 * hours, in seconds. A clock that jumps when a PC with no battery clock starts makes nothing a day old, and a PC
 * that is used two hours a day gets there in three days.
 */
export const MIGRATION_RUNNING_SECONDS = 21600;
/** How long a device must have opened a PC it was never paired with, before that PC is one it knows: seven days, in seconds. */
export const MIGRATION_KNOWN_SECONDS = 604800;
/** The most devices and PCs one list carries in: with entry 0, the hand-over and the `epoch` entry they are the one request of its birth. */
export const MIGRATION_CARRIED_MAX = 64;
/**
 * How long a device waits for every PC it knows to answer before it goes by those that did: three days, in
 * seconds. A PC that is asleep, or whose session the network drops, is no yes meanwhile.
 */
export const MIGRATION_ANSWER_SECONDS = 259200;
/** A naming's signature is over these bytes and the naming's fields. */
export const LIST_NAMING_PREFIX = "ovis-list-name/1";
/** A link's two signatures are over these bytes and the link's four values. */
export const LIST_LINK_PREFIX = "ovis-list-link/1";

const ENDPOINT = /^[0-9a-f]{64}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** A row of its own, or null: what every object answers to is no row. */
function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

const isSpan = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * A key that a PC lets in to drive, and for how long, as that PC measured it: `wall` seconds by its wall clock
 * since it let the key in without a break (held against the latest time it ever saved, so it never runs back),
 * and `ran` seconds that the PC itself was running with the key let in. `idle` is how long ago the key was last
 * used there, or null: it only says which keys are in use when an account has more than a list carries in.
 */
export interface LetIn {
  readonly key: string;
  readonly wall: number;
  readonly ran: number;
  readonly idle?: number | null;
}

/** How much longer a PC must let a key in before it counts, in seconds: 0 for a key that counts, null for what is no record. */
function waitOf(row: Pick<LetIn, "wall" | "ran">): number | null {
  if (!isSpan(row.wall) || !isSpan(row.ran)) return null;
  return Math.max(0, MIGRATION_WITNESS_SECONDS - row.wall, MIGRATION_RUNNING_SECONDS - row.ran);
}

/** The longest wait among the rows of a key, null where none is a record: a key named twice counts by its shorter stretch. */
function waitFor(rows: readonly LetIn[], key: string): number | null {
  const waits = rows.flatMap((row) => (row.key === key ? [waitOf(row)] : [])).flatMap((wait) => (wait === null ? [] : [wait]));
  return waits.length === 0 ? null : Math.max(...waits);
}

/** A device as the account service lists it for the account: the key its sign-in registered, whether the service says a PC lets it in, and its name. */
export interface KnownDevice {
  readonly key: string;
  readonly eligible: boolean;
  readonly names: ListNames | null;
}

/**
 * What a PC answers a device of its account over a session to its own relay key: the account it is in, the list
 * it follows (`pinned`, its id, or null for a PC that follows none), the device keys it lets in to drive on that
 * account with how long it has (LetIn), and the keys it holds a removal against (a signed removal or block it
 * applied, or a person's Revoke at that PC).
 */
export interface PcAnswer {
  readonly account: string;
  readonly pinned: string | null;
  readonly admits: readonly LetIn[];
  readonly removed: readonly string[];
}

/**
 * What a device did itself for a PC, by its own record: it `paired` with it at the PC (a QR, a code or digits),
 * it pressed Add for it (`added`), it added it over `ssh`, or it is that PC's own `window`. `none`: it only
 * opened a PC the account service's directory named.
 */
export type PcHow = "paired" | "added" | "ssh" | "window" | "none";

/**
 * A PC as a device knows it. `how`: what the device did itself for it (PcHow). `known`: for how many seconds
 * this device has held end-to-end sessions with that relay key, by its own record, or null for a relay key it has
 * only the service's word for. `says`: the PC's answer in this run of the app, or null for a PC that was not
 * reached or runs an Ovis that cannot answer; an answer kept from an earlier run is none.
 */
export interface KnownPc {
  readonly endpoint: string;
  readonly how: PcHow;
  readonly known: number | null;
  readonly says: PcAnswer | null;
  readonly names: ListNames | null;
}

/** What the first device knows as it moves its account onto a list. */
export interface MigrationKnown {
  readonly account: string;
  /** The key this device's own sign-in registered: it signs entry 0. */
  readonly self: string;
  /** This device's member key (its account key): it is this device wherever it is named. */
  readonly member: string;
  /** The account's devices as the account service lists them now, in its order. */
  readonly devices: readonly KnownDevice[];
  /** The keys the account service lists as removed, and every key this device itself holds a block or a removal against, sent or not. */
  readonly removed: readonly string[];
  readonly pcs: readonly KnownPc[];
}

/**
 * Why a device starts no list now.
 *
 * - `self_unlisted`: the account service does not list this device's own key as one a PC lets in.
 * - `self_removed`: the service, this device, or a PC this device knows holds a removal against its own key.
 * - `pcs_silent`: a PC this device knows by its own record has not answered yet; `wait` is how many seconds it
 *   still waits for it (MIGRATION_ANSWER_SECONDS from its first try) before it goes by those that answered.
 * - `no_witness`: no PC that this device knows by its own record has answered for this account.
 * - `self_unwitnessed`: a PC it knows, and that answered, does not let this device's own key in.
 * - `too_new`: this device's key, or one it would carry in, has been let in for less than a day by a PC that
 *   answered, or the service lists a device as one no PC lets in yet and a day has not passed since this
 *   device's first try; `wait` is how many seconds are left.
 */
export type NoMigration = "self_unlisted" | "self_removed" | "pcs_silent" | "no_witness" | "self_unwitnessed" | "too_new";

/**
 * Why a device or a PC is not carried in.
 *
 * - `form`: its key is no key of a list, or its relay key no relay key.
 * - `removed`: the account service lists the key as removed, or this device holds a removal against it.
 * - `not_eligible`: the service lists the key as one no PC lets in, and still did a day after this device's first try.
 * - `removed_at_pc`: a PC this device knows holds a removal against the key, whatever the service says.
 * - `unwitnessed`: a PC this device knows, and that answered, does not let the key in.
 * - `unknown_pc`: this device does not know the relay key by its own record.
 * - `other_account`: the PC answered that it is in another account.
 * - `over_limit`: the list carries MIGRATION_CARRIED_MAX in, and these were in use least lately.
 */
export type LeftOut = "form" | "removed" | "not_eligible" | "removed_at_pc" | "unwitnessed" | "unknown_pc" | "other_account" | "over_limit";

/** Whom the first device carries in, in the order of the entries, and whom it leaves out and why. */
export interface MigrationPlan {
  readonly devices: readonly { readonly key: string; readonly names: ListNames | null }[];
  readonly pcs: readonly { readonly endpoint: string; readonly names: ListNames | null }[];
  readonly left: {
    readonly devices: readonly { readonly key: string; readonly why: LeftOut }[];
    readonly pcs: readonly { readonly endpoint: string; readonly why: LeftOut }[];
  };
}

export type MigrationStart =
  | { readonly start: true; readonly plan: MigrationPlan }
  | { readonly start: false; readonly why: NoMigration; readonly wait: number | null };

/**
 * Whether a device did something itself for a PC (PcHow). Only such a device signs that PC's `pc` entry, which
 * makes the PC a signer of power `full`, with no question: never because the directory names the PC, however
 * long, and never because the PC says which list it follows. A PC nobody has such a record of stays an endpoint
 * with no key until a person compares the number at it.
 */
export function addedItself(pc: Pick<KnownPc, "how">): boolean {
  return pc.how === "paired" || pc.how === "added" || pc.how === "ssh" || pc.how === "window";
}

/**
 * Whether a device knows a relay key as a PC of the person's by its own record: it did something itself for it
 * (addedItself), or it has held sessions with that relay key for MIGRATION_KNOWN_SECONDS. The account service's
 * directory alone is no such record. This is what a PC must be to be asked who is let in, and to be carried in
 * as an endpoint with no key, which signs nothing.
 */
export function ownEvidence(pc: Pick<KnownPc, "how" | "known">): boolean {
  return addedItself(pc) || (isSpan(pc.known) && pc.known >= MIGRATION_KNOWN_SECONDS);
}

/** The PCs a device knows by its own record that are of this account or have not answered: those that answered for it, and those that are silent. */
function witnessesOf(pcs: readonly KnownPc[], account: string): { readonly answered: readonly { readonly endpoint: string; readonly says: PcAnswer }[]; readonly silent: readonly string[] } {
  const answered: { endpoint: string; says: PcAnswer }[] = [];
  const silent: string[] = [];
  for (const pc of pcs) {
    if (!ENDPOINT.test(pc.endpoint) || !ownEvidence(pc)) continue;
    if (pc.says === null) silent.push(pc.endpoint);
    else if (pc.says.account === account) answered.push({ endpoint: pc.endpoint, says: pc.says });
  }
  return { answered, silent };
}

/**
 * Whom a device carries into the list it starts for an account that was in use, or why it starts none now.
 *
 * A device key is carried in only when all hold: the account service lists it as one a PC lets in, and neither
 * the service nor this device holds a removal against it; EVERY PC that this device knows by its own record
 * (ownEvidence), and that answered for this account, has let that key in for a day by its own two clocks; and
 * none of them holds a removal against it. So no single PC adds a key: one that only the service names, or that
 * it planted on one PC, gets no place (`unwitnessed`), and neither does one that a PC put out and the service
 * lists again (`removed_at_pc`). A key that every such PC lets in, one of them for less than a day, holds the
 * start back (`too_new`): the device asks again later, and nobody presses anything. The device's own key is
 * held to the same.
 *
 * A PC that does not answer is no yes. While a PC the device knows by its own record is silent, the device starts
 * nothing (`pcs_silent`); MIGRATION_ANSWER_SECONDS after its first try (`tried`, the seconds since then by its own
 * record) it goes by those that answered, at least one. A device the service lists as one no PC lets in yet (it
 * signed in this morning) holds the start back for a day from the first try, and is then left out.
 *
 * A PC is carried in when the device knows it by its own record, answered or not. Devices come first, in the
 * service's order, then PCs. Where an account has more than MIGRATION_CARRIED_MAX, the devices that a PC saw in
 * use last are kept, and the rest is left out (`over_limit`): a sign-in nobody uses any more is the first to go.
 * A device that was left out asks to be let in as a new device does, and a PC that was left out is added by a
 * `pc` entry.
 */
export function migrationPlan(known: MigrationKnown, tried: number): MigrationStart {
  const no = (why: NoMigration, wait: number | null = null): MigrationStart => ({ start: false, why, wait });
  const since = isSpan(tried) ? tried : 0;
  const removed = new Set(known.removed);
  const asked = witnessesOf(known.pcs, known.account);
  const witnesses = asked.answered.map(({ says }) => says);
  const removedAtPc = (key: string): boolean => witnesses.some((says) => says.removed.includes(key));
  /** How long until every witness has let the key in for a day: null when one of them does not let it in at all. */
  const waitAtAll = (key: string): number | null => {
    const waits = witnesses.map((says) => waitFor(says.admits, key));
    return waits.some((wait) => wait === null) ? null : Math.max(0, ...waits.map((wait) => wait ?? 0));
  };

  const self = known.devices.find((device) => device.key === known.self);
  if (!isListKey(known.self) || self === undefined || !self.eligible) return no("self_unlisted");
  if (removed.has(known.self) || removedAtPc(known.self)) return no("self_removed");
  if (asked.silent.length > 0 && since < MIGRATION_ANSWER_SECONDS) return no("pcs_silent", MIGRATION_ANSWER_SECONDS - since);
  if (witnesses.length === 0) return no("no_witness");
  const selfWait = waitAtAll(known.self);
  if (selfWait === null) return no("self_unwitnessed");

  const carried: { key: string; names: ListNames | null }[] = [];
  const leftDevices: { key: string; why: LeftOut }[] = [];
  let wait = selfWait;
  const named = new Set<string>([known.self, known.member]);
  for (const device of known.devices) {
    const { key } = device;
    if (named.has(key)) continue;
    named.add(key);
    const left = waitAtAll(key);
    const why: LeftOut | null = !isListKey(key) ? "form" : removed.has(key) ? "removed" : !device.eligible ? "not_eligible" : removedAtPc(key) ? "removed_at_pc" : left === null ? "unwitnessed" : null;
    // In the service's own wait: it may be let in tomorrow. The start waits for it, a day from the first try at most.
    if (why === "not_eligible" && since < MIGRATION_WITNESS_SECONDS) { wait = Math.max(wait, MIGRATION_WITNESS_SECONDS - since); continue; }
    if (why !== null) { leftDevices.push({ key, why }); continue; }
    wait = Math.max(wait, left ?? 0);
    carried.push({ key, names: device.names });
  }
  if (wait > 0) return no("too_new", wait);

  const pcs: { endpoint: string; names: ListNames | null }[] = [];
  const leftPcs: { endpoint: string; why: LeftOut }[] = [];
  const places = new Set<string>();
  for (const pc of known.pcs) {
    const { endpoint } = pc;
    if (places.has(endpoint)) continue;
    places.add(endpoint);
    if (!ENDPOINT.test(endpoint)) leftPcs.push({ endpoint, why: "form" });
    else if (pc.says !== null && pc.says.account !== known.account) leftPcs.push({ endpoint, why: "other_account" });
    else if (ownEvidence(pc)) pcs.push({ endpoint, names: pc.names });
    else leftPcs.push({ endpoint, why: "unknown_pc" });
  }

  /** How long ago any witness last saw the key in use; a key no witness has seen in use comes last. */
  const idle = (key: string): number => Math.min(Number.MAX_SAFE_INTEGER, ...witnesses.flatMap((says) => says.admits.flatMap((row) => (row.key === key && isSpan(row.idle) ? [row.idle] : []))));
  const kept = new Set(carried.length <= MIGRATION_CARRIED_MAX ? carried.map(({ key }) => key)
    : carried.map(({ key }, index) => ({ key, index, idle: idle(key) })).sort((a, b) => a.idle - b.idle || a.index - b.index).slice(0, MIGRATION_CARRIED_MAX).map(({ key }) => key));
  const devices = carried.filter(({ key }) => kept.has(key));
  const room = MIGRATION_CARRIED_MAX - devices.length;
  return {
    start: true,
    plan: {
      devices,
      pcs: pcs.slice(0, room),
      left: {
        devices: [...leftDevices, ...carried.filter(({ key }) => !kept.has(key)).map(({ key }) => ({ key, why: "over_limit" as const }))],
        pcs: [...leftPcs, ...pcs.slice(room).map(({ endpoint }) => ({ endpoint, why: "over_limit" as const }))],
      },
    },
  };
}

/** What is not written of a migration, and why. */
export type MigrationRefusalCode = "stopped" | "key_invalid" | "too_many" | "not_in" | "run_open" | "has_member";

export class MigrationError extends Error {
  constructor(readonly code: MigrationRefusalCode, message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Sealing, which is the caller's (shared/account-list-seal.ts): it holds the epoch keys, and making one needs
 * random bytes. Each answer may be null where the caller seals nothing.
 */
export interface MigrationSeals {
  /** For entry 0: the commitment to the key of epoch 0 that the caller has just made, and the first device's names sealed under it. */
  genesis(names: ListNames | null): Promise<{ readonly opens: string; readonly sealed: Sealed | null }>;
  /** One member's names for the entry at `place`, under the epoch that sealEpoch named. */
  names(place: { readonly list: string; readonly seq: number }, epoch: { readonly epoch: number; readonly opens: string }, names: ListNames): Promise<Sealed | null>;
  /**
   * The next epoch, for the `epoch` entry at the end of the run: its commitment and its link. `members` are the
   * encryption keys its key is wrapped to (wrapKeys of the state the entry stands on); the caller keeps the wraps
   * and sends them with the entries.
   */
  next(list: string, epoch: number, members: readonly string[]): Promise<{ readonly opens: string; readonly link: Uint8Array }>;
}

/** A device's keys: its sign-in key, which the PCs let in and which signs the list's birth, and the member key it goes on with (its account key) with its encryption key. */
export interface MigratingDevice {
  readonly signIn: ListSigner;
  readonly member: ListSigner;
  readonly enc: string;
  readonly names: ListNames | null;
}

/** Whether a device's own keys are keys of a list: each in its one spelling, with its point on the curve. */
const ownKeys = (device: Pick<MigratingDevice, "signIn" | "member" | "enc">): boolean => isListKey(device.signIn.key) && isListKey(device.member.key) && isListKey(device.enc);

const firstSigner = (state: ListState): string | null => Object.entries(state.signers).find(([, row]) => row.seq === 0)?.[0] ?? null;

/**
 * Whether what a member holds is only the beginning of a list's birth: the run of `carried` entries is not over,
 * or the first signer has handed its place on and the `epoch` entry that ends its birth is not there yet. An
 * honest log holds a birth whole or not at all, so nobody signs on such a state or follows it.
 */
function birthOpen(state: ListState): boolean {
  const first = firstSigner(state);
  return state.carrying || (first !== null && heirOf(state, first) !== null && state.epochs.length < 2);
}

/** Whether the key is a device that is in. */
function deviceIn(state: ListState, key: string): boolean {
  const row = rowOf(state.signers, key);
  return row !== null && row.ended === null && row.as === "device" && rowOf(state.devices, key) !== null;
}

/**
 * The whole birth of the list of an account that was in use, signed once, as the ONE request the account service
 * places whole or not at all: entry 0 by the first device's sign-in key (the key the account's PCs let in
 * already), a `carried` for each device and PC of the plan, the `device` entry by which the sign-in key hands
 * its place to the member key (which ends the run: nobody is carried in after it), and the `epoch` entry, since
 * names are no longer sealed under an epoch whose key a key that is out held. All but the last are signed by the
 * sign-in key, which the service holds as that sign-in's registered key: its signature is the proof of that key,
 * so no other proof is signed for a migration. `issued_at` is the device's clock in seconds, no later than the
 * account service's where it said one.
 *
 * The device keeps what this gives before it sends it, and sends those very entries until the service has taken
 * them: it never signs a second birth while one of its own may have been placed, and it follows the list only
 * once the service has placed the request. Until then the account has no list in any sense.
 *
 * Refuses (MigrationError), before anything is signed or sealed: `key_invalid` when a key the plan names is no
 * key whose point is on the curve, is one of the device's own, a relay key is out of form, or one of the
 * device's own keys is no key of a list; `too_many` for a plan of more than MIGRATION_CARRIED_MAX. The kinds read
 * only the spelling of a carried key, so the point is checked here: nobody holds the private half of a key off
 * the curve, and a member that later saves it among its keys cannot read its own copy back.
 */
export async function signMigration(
  account: string, plan: Pick<MigrationPlan, "devices" | "pcs">, device: MigratingDevice, issued_at: number, seals: MigrationSeals,
): Promise<{ readonly list: string; readonly entries: readonly WrittenEntry[]; readonly state: ListState }> {
  const own = [device.signIn.key, device.member.key, device.enc];
  if (plan.devices.some(({ key }) => !isListKey(key) || own.includes(key)) || plan.pcs.some(({ endpoint }) => !ENDPOINT.test(endpoint)) || !ownKeys(device)) {
    throw new MigrationError("key_invalid", "A key of this list's birth is no key whose point is on the curve, is this device's own, or a relay key is out of form");
  }
  if (plan.devices.length + plan.pcs.length > MIGRATION_CARRIED_MAX) throw new MigrationError("too_many", `A list carries at most ${MIGRATION_CARRIED_MAX} in`);
  const born = await seals.genesis(device.names);
  const genesis = await signGenesis({ kind: "genesis", account, enc: device.enc, opens: born.opens, sealed: born.sealed }, device.signIn, issued_at);
  const entries: WrittenEntry[] = [genesis];
  let after = genesis.state;
  const write = (written: WrittenEntry): void => {
    entries.push(written);
    after = written.state;
  };
  const sealedNames = async (names: ListNames | null): Promise<Sealed | null> => {
    const epoch = names === null ? null : sealEpoch(after, issued_at);
    return names === null || epoch === null ? null : await seals.names({ list: after.list, seq: after.footing.seq + 1 }, epoch, names);
  };
  for (const { key, names } of plan.devices) {
    write(await signListEntry(after, { kind: "carried", key, role: "drive", sealed: await sealedNames(names) }, device.signIn, issued_at));
  }
  for (const { endpoint, names } of plan.pcs) {
    write(await signListEntry(after, { kind: "carried", endpoint, sealed: await sealedNames(names) }, device.signIn, issued_at));
  }
  write(await signRotation(after, device, issued_at, await sealedNames(device.names)));
  // Its sign-in key held the key of the epoch, and is out: the next epoch is opened by the member key, which stays.
  const next = await seals.next(after.list, after.epoch, wrapKeys(after, issued_at));
  write(await signListEntry(after, { kind: "epoch", epoch: after.epoch, opens: next.opens, link: next.link }, device.member, issued_at));
  return { list: genesis.state.list, entries, state: after };
}

/**
 * The `device` entry by which a device that is in the list under its sign-in key (the first device, or one that
 * was carried in) hands its place to its member key: signed by the sign-in key, it adds the member key with the
 * device's own card and encryption key and ends the sign-in key. From then on the device is in by a key that
 * outlives its sign-in. `sealed` is the device's names under sealEpoch's epoch, or null for a device that holds
 * no key to the names yet.
 *
 * A device that was carried in writes nothing on a list whose run is open, however old what it is shown: an
 * honest log holds a birth whole or not at all, so an open run is the beginning of one that the account service
 * shows it, and an entry of its own there would be a second history under a member's signature. Only the first
 * device ends its run, in the request that holds all of it (signMigration).
 *
 * Refuses `stopped`, `key_invalid` for a key of the device's own that is no key of a list, `not_in` for a
 * sign-in key that is no device of power `full` that is in, `has_member` for a member key the list has held
 * before, and `run_open`.
 */
export async function signRotation(state: ListState, device: Pick<MigratingDevice, "signIn" | "member" | "enc">, issued_at: number, sealed: Sealed | null): Promise<WrittenEntry> {
  if (state.needs_replay !== undefined) throw new MigrationError("stopped", "A member that is stopped for a replay writes nothing");
  if (!ownKeys(device)) throw new MigrationError("key_invalid", "A key of this device is no key whose point is on the curve");
  const row = rowOf(state.signers, device.signIn.key);
  if (row === null || !deviceIn(state, device.signIn.key) || row.power !== "full") throw new MigrationError("not_in", "This sign-in key is no device of this list that may hand its place on");
  if (rowOf(state.signers, device.member.key) !== null) throw new MigrationError("has_member", "The list has held this member key before");
  if (birthOpen(state) && row.seq !== 0) throw new MigrationError("run_open", "This is the beginning of a list's birth, not a list");
  const card = await signCard({ key: device.member.key, enc: device.enc, list: state.list, endpoint: null, invite: null }, device.member.privateKey);
  return await signListEntry(state, { kind: "device", key: device.member.key, power: "full", role: "drive", until: null, enc: device.enc, card, sealed, rotates: true }, device.signIn, issued_at);
}

/**
 * The key that a key handed its place to by its own entry: the `device` entry it signed that ended it and let
 * the other key in as a device. Null for a key that is in, for one that was put out, and for one the list never
 * held.
 */
export function heirOf(state: ListState, key: string): string | null {
  const row = rowOf(state.signers, key);
  if (row === null || row.ended === null) return null;
  for (const [other, heir] of Object.entries(state.signers)) {
    if (heir.by === key && heir.seq === row.ended && heir.as === "device" && rowOf(state.devices, other) !== null) return other;
  }
  return null;
}

/**
 * The key that stands now where `key` came in: `key` itself while it is a device that is in, otherwise the last
 * of the keys it handed its place on to, when that one is in. Null for a device that is out, for a key that was
 * never a device here, and for a key that is no point of the curve, whatever the list holds of it. A PC that
 * follows a list asks this for each row it kept by a sign-in key.
 */
export function standsFor(state: ListState, key: string): string | null {
  if (state.needs_replay !== undefined) return null;
  let at = key;
  for (let steps = 0; steps <= state.footing.seq; steps += 1) {
    if (deviceIn(state, at)) return isListKey(at) ? at : null;
    const heir = heirOf(state, at);
    if (heir === null) return null;
    at = heir;
  }
  return null;
}

/** A row that moves: the key a PC held a device by, and the key the same device is in by now. */
export interface Rekey {
  readonly from: string;
  readonly to: string;
}

/**
 * The devices that were in by one key in `before` and are in by another in `after`, each having handed its
 * place on itself. A PC moves such a device's row to the new key: it is the same device, so it is not announced
 * as a new one, waits no hold, and keeps its name and its age on that PC. A device that is new in `after`, and
 * one that went out with no heir, is not among them. `before` null gives none.
 */
export function rekeys(before: ListState | null, after: ListState): Rekey[] {
  if (before === null || before.needs_replay !== undefined) return [];
  const moved: Rekey[] = [];
  for (const key of Object.keys(before.devices)) {
    if (!deviceIn(before, key)) continue;
    const to = standsFor(after, key);
    if (to !== null && to !== key) moved.push({ from: key, to });
  }
  return moved.sort((a, b) => (a.from < b.from ? -1 : 1));
}

/**
 * Where a device stands in a list of its account that it did not come into by an Allow.
 *
 * - `first`: entry 0 is its sign-in key's, which is still in: it is shown the beginning of its own list's birth.
 * - `carried`: its sign-in key was carried in and is still in: it asks its PCs (joinVerdict), and then hands its
 *   place to its member key (signRotation).
 * - `member`: its member key is in, or its sign-in key is in by an ordinary entry. Nothing is left to do.
 * - `out`: one of its keys was in and none is: it was removed.
 * - `absent`: the list holds no key of its own: it asks to be let in as a new device does.
 *
 * `wait` is true for the beginning of a birth, which is no list: the device does nothing with it, and says that
 * the account service shows a part of a list.
 */
export type DevicePlace =
  | { readonly at: "first" }
  | { readonly at: "carried"; readonly wait: boolean }
  | { readonly at: "member" }
  | { readonly at: "out" }
  | { readonly at: "absent"; readonly wait: boolean };

/** How a device that was signed in before its account had a list learns what became of it: from the list alone, whenever it next reads it. */
export function devicePlace(state: ListState, keys: { readonly signIn: string; readonly member: string }): DevicePlace {
  if (deviceIn(state, keys.member)) return { at: "member" };
  const row = rowOf(state.signers, keys.signIn);
  if (row !== null && deviceIn(state, keys.signIn)) {
    if (row.seq === 0) return { at: "first" };
    // Only a key that a `carried` entry named has a hand-over to make; one an ordinary entry let in is simply in.
    return rowOf(state.devices, keys.signIn)?.carried === true ? { at: "carried", wait: birthOpen(state) } : { at: "member" };
  }
  return row !== null || rowOf(state.signers, keys.member) !== null ? { at: "out" } : { at: "absent", wait: birthOpen(state) };
}

/**
 * Why a device that was carried in does not follow the list yet, the first that applies, in this order.
 *
 * - `stopped`: this build cannot place an entry of the list.
 * - `carried_off_curve`: the list carries in a key that is no point of the curve; no PC follows such a list.
 * - `run_open`: what it was shown is the beginning of a birth, not a list: the run is not over, or its `epoch`
 *   entry is missing.
 * - `not_carried`: the list did not carry this device in (devicePlace says where it stands).
 * - `no_answer`: no PC it knows by its own record has answered for this account. It waits, and goes on as
 *   before the list.
 * - `other_list`: a PC it knows follows another list of the account (`pcs` names it). The way out is that PC's:
 *   it is removed from the account, or reset at the PC; the refusal clears when the PC is gone or agrees.
 * - `first_signer_removed`: a PC it knows holds a removal against the key that started the list, or against a
 *   key that one handed its place on to, however often.
 * - `first_signer_unknown`: a PC it knows, that follows no list yet, does not let the key that started the list
 *   in. The device does not follow the list and says so; it asks to be let in as a new device does.
 * - `pcs_silent`: every PC that answered agrees, and a PC it knows has not answered yet (`pcs`); `wait` is how
 *   many seconds it still waits for it.
 * - `first_signer_new`: every PC that answered lets that key in, one of them for less than a day; `wait` is how
 *   many seconds are left.
 */
export type JoinRefusal =
  | "stopped" | "carried_off_curve" | "run_open" | "not_carried" | "no_answer" | "other_list" | "first_signer_removed" | "first_signer_unknown" | "pcs_silent" | "first_signer_new";

export type JoinVerdict =
  | { readonly pin: true }
  /** `waits`: nothing is wrong so far, and the device only asks again. Otherwise it says so, and never names this list to anybody. `pcs`: the relay keys of the PCs the refusal is about. */
  | { readonly pin: false; readonly why: JoinRefusal; readonly waits: boolean; readonly wait: number | null; readonly pcs: readonly string[] };

/**
 * Whether a device follows a list that carried it in and that it did not make. The account service's word that
 * this is the account's list is no reason: the device asks the PCs it knows by its own record, each over a
 * session to that PC's own relay key, in this run of the app. EVERY one that answers for this account must
 * agree: a PC that follows a list agrees when it is this very list, and a PC that follows none agrees when it
 * has let the key that signed entry 0 in for a day and holds no removal against it. A PC that does not answer is
 * no yes: the device waits for every PC it knows, and goes by those that answered (at least one) only
 * MIGRATION_ANSWER_SECONDS after its first try (`tried`, the seconds since then by its own record).
 *
 * A list the service started with a key of its own, carrying the person's real keys, is so refused by every
 * device it shows it to, though the PCs let every carried key in. A device that follows a list on the word of a
 * PC that lied still names it to no other PC with effect: each PC asks who started the list itself (pinVerdict).
 */
export function joinVerdict(state: ListState, keys: { readonly signIn: string; readonly member: string }, pcs: readonly KnownPc[], tried: number): JoinVerdict {
  const no = (why: JoinRefusal, waits = false, wait: number | null = null, about: readonly string[] = []): JoinVerdict => ({ pin: false, why, waits, wait, pcs: [...about] });
  if (state.needs_replay !== undefined) return no("stopped");
  if (listView(state).devices.some((row) => row.carried && !isListKey(row.key))) return no("carried_off_curve");
  if (birthOpen(state)) return no("run_open", true);
  const place = devicePlace(state, keys);
  const first = firstSigner(state);
  if (place.at !== "carried" || first === null) return no("not_carried");
  const since = isSpan(tried) ? tried : 0;
  const { answered, silent } = witnessesOf(pcs, state.account);
  const waiting = silent.length > 0 && since < MIGRATION_ANSWER_SECONDS;
  if (answered.length === 0) return waiting ? no("pcs_silent", true, MIGRATION_ANSWER_SECONDS - since, silent) : no("no_answer", true);
  const other = answered.filter(({ says }) => says.pinned !== null && says.pinned !== state.list);
  if (other.length > 0) return no("other_list", false, null, other.map((pc) => pc.endpoint));
  const asked = answered.filter(({ says }) => says.pinned === null);
  const starter = deviceKeys(state, first);
  const removed = asked.filter(({ says }) => starter.some((key) => says.removed.includes(key)));
  if (removed.length > 0) return no("first_signer_removed", false, null, removed.map((pc) => pc.endpoint));
  const waits = asked.map((pc) => ({ endpoint: pc.endpoint, wait: waitFor(pc.says.admits, first) }));
  const unknown = waits.filter((one) => one.wait === null);
  if (unknown.length > 0) return no("first_signer_unknown", false, null, unknown.map((one) => one.endpoint));
  if (waiting) return no("pcs_silent", true, MIGRATION_ANSWER_SECONDS - since, silent);
  const wait = Math.max(0, ...waits.map((one) => one.wait ?? 0));
  return wait > 0 ? no("first_signer_new", true, wait) : { pin: true };
}

/**
 * What a device says to a PC inside its session to name its list: the list's id and the key the list holds the
 * device by. It is that member key's own word, bound to the PC it is said to (`endpoint`, the PC's relay key)
 * and to the key the session is signed in with (`session`), so it holds in no other session and at no other PC.
 */
export interface ListNaming {
  readonly account: string;
  readonly list: string;
  readonly key: string;
  readonly session: string;
  readonly endpoint: string;
}

/** A naming as it travels inside the session: the list, the member key and that key's signature, 86 characters of base64url. The account, the PC and the session's key are the PC's own to say. */
export interface SignedNaming {
  readonly list: string;
  readonly key: string;
  readonly signature: string;
}

/** A naming that a PC checked: the list, the member key that signed it, and the key of the session it was said in. */
export interface Naming {
  readonly list: string;
  readonly key: string;
  readonly session: string;
}

/** A naming's bytes: `ovis-list-name/1` and the fields `account`, `endpoint`, `key`, `list` and `session`, in the entry's field form. Refuses `entry_invalid` for a value out of its form. */
export function namingBytes(naming: ListNaming): Uint8Array {
  const { account, list, key, session, endpoint } = naming;
  const text = (value: unknown): value is string => typeof value === "string";
  if (!text(account) || !ACCOUNT.test(account) || !text(list) || !isListHash(list) || !text(key) || !isListKey(key) || !text(session) || !isListKey(session) || !text(endpoint) || !ENDPOINT.test(endpoint)) {
    throw new ListKindError("A naming names an account, a list, the member key that signs it, the key of the session and the PC's relay key");
  }
  return writeFieldsUnder(LIST_NAMING_PREFIX, [
    { name: "account", value: utf8ToBytes(account) }, { name: "endpoint", value: utf8ToBytes(endpoint) }, { name: "key", value: utf8ToBytes(key) },
    { name: "list", value: utf8ToBytes(list) }, { name: "session", value: utf8ToBytes(session) },
  ]);
}

/**
 * What a device says to a PC to name the list it follows, or null where it has nothing to say: a device names a
 * list only while the key it holds is a device of that list that is in, with power `full`. `member` is the key
 * the list holds it by (its account key, or its sign-in key before its hand-over), `session` the key its session
 * with that PC is signed in with, `endpoint` that PC's relay key. A device names only a list it follows: one it
 * made and the service placed, one a member let it into, or one that carried it in and passed joinVerdict.
 */
export async function signNaming(state: ListState, given: { readonly member: ListSigner; readonly session: string; readonly endpoint: string }): Promise<SignedNaming | null> {
  const { member, session, endpoint } = given;
  if (state.needs_replay !== undefined || !deviceIn(state, member.key) || rowOf(state.signers, member.key)?.power !== "full") return null;
  const bytes = namingBytes({ account: state.account, list: state.list, key: member.key, session, endpoint });
  return { list: state.list, key: member.key, signature: toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, member.privateKey, new Uint8Array(bytes)))) };
}

/**
 * A naming a PC was handed in a session, checked: the member key's own signature over this PC's account, this
 * PC's relay key and the key this very session is signed in with. Null for anything else, without a throw: one
 * out of form, one said to another PC or in another session, one whose signature is another key's.
 */
export async function heldNaming(account: string, endpoint: string, session: string, naming: SignedNaming): Promise<Naming | null> {
  if (typeof naming !== "object" || naming === null) return null;
  const { list, key, signature } = naming;
  const signed = typeof signature === "string" && signature.length === CARD_SIGNATURE_CHARS ? canonicalBase64Url(signature) : null;
  if (signed === null) return null;
  let bytes: Uint8Array;
  try {
    bytes = namingBytes({ account, list, key, session, endpoint });
  } catch (error) {
    if (error instanceof ListKindError) return null;
    throw error;
  }
  return (await verifySignature(bytes, signed, key)) ? { list, key, session } : null;
}

/**
 * A link: the statement that a member key of a list and a key that a sign-in registered with the account service
 * are one device's. `key` is the member key the device is in the list by, `device` the registered sign-in key.
 * It is ONE statement with TWO signatures, the member key's and the sign-in key's, over the same bytes, and it
 * serves two readers:
 *
 * - the account service, which so learns which sign-in is which member (and that the caller holds the sign-in
 *   key itself, which a copied token does not);
 * - a PC, to which it is a **vouch**: a PC that lets `device` in through the account, and has for a day, learns
 *   that the member `key` is a device it knows, though it never held the sign-in key the member key came from.
 *
 * Either signature alone proves nothing. A member key that names a sign-in key says nothing about that sign-in.
 * And a sign-in key that names a member key says nothing about that member: a PC also holds a removal against a
 * device by the sign-in key that vouches for it (heldOut), so a sign-in key the PC put out could otherwise hang
 * its removal on anybody's member key, the device that started the list among them. Anyone may carry a link,
 * and the account service keeps it: it says nothing but what its signatures say.
 */
export interface ListLink {
  readonly account: string;
  readonly list: string;
  readonly key: string;
  readonly device: string;
}

/** A link's two signatures as they travel: `member` by the member key and `device` by the registered sign-in key, each 86 characters of base64url. */
export interface LinkSignatures {
  readonly member: string;
  readonly device: string;
}

/** A link as it is handed to a PC: its two keys and its two signatures. The account and the list are the reader's own. */
export interface SignedVouch {
  readonly key: string;
  readonly device: string;
  readonly link: LinkSignatures;
}

/**
 * A link's bytes: `ovis-list-link/1`, then the account, the list id, the member key and the registered sign-in
 * key, each as UTF-8 after its byte length in four bytes, big-endian. It is the account service's own form for
 * this statement, which both signatures are over. Refuses `entry_invalid` for a value out of its form.
 */
export function linkBytes(link: ListLink): Uint8Array {
  const { account, list, key, device } = link;
  if (typeof account !== "string" || !ACCOUNT.test(account) || typeof list !== "string" || !isListHash(list) || typeof key !== "string" || !isListKey(key) || typeof device !== "string" || !isListKey(device)) {
    throw new ListKindError("A link names an account, a list, a member key and the key a sign-in registered");
  }
  const parts = [account, list, key, device].map((text) => utf8ToBytes(text));
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + 4 + part.length, LIST_LINK_PREFIX.length));
  bytes.set(utf8ToBytes(LIST_LINK_PREFIX), 0);
  let at = LIST_LINK_PREFIX.length;
  for (const part of parts) {
    new DataView(bytes.buffer).setUint32(at, part.length);
    bytes.set(part, at + 4);
    at += 4 + part.length;
  }
  return bytes;
}

/**
 * The link of a device's present sign-in key to its own member key, signed with both, or null where there is
 * nothing to say: a device signs one only for the list it follows, and only while its member key is a device of
 * that list that is in. It signs none for anybody else's key, none for a list it was only shown, and none where
 * the two keys are one (a key that has not handed over is in the list by itself).
 */
export async function signVouch(state: ListState, device: Pick<MigratingDevice, "signIn" | "member">): Promise<SignedVouch | null> {
  if (state.needs_replay !== undefined || !deviceIn(state, device.member.key) || device.signIn.key === device.member.key) return null;
  const bytes = linkBytes({ account: state.account, list: state.list, key: device.member.key, device: device.signIn.key });
  const by = async (key: CryptoKey): Promise<string> => toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, key, new Uint8Array(bytes))));
  return { key: device.member.key, device: device.signIn.key, link: { member: await by(device.member.privateKey), device: await by(device.signIn.privateKey) } };
}

/**
 * The links among those handed to a PC that hold for this account and list: each signed by its own `device` key
 * and by its own member `key`, over its bytes. One that is out of form, of another list or account, or that
 * lacks either signature is dropped. What a PC makes of them is pinVerdict's to say (`vouched`).
 */
export async function heldVouches(account: string, list: string, vouches: readonly SignedVouch[]): Promise<{ readonly key: string; readonly device: string }[]> {
  const held: { key: string; device: string }[] = [];
  const read = (text: unknown): Uint8Array | null => (typeof text === "string" && text.length === CARD_SIGNATURE_CHARS ? canonicalBase64Url(text) : null);
  for (const vouch of [...vouches]) {
    if (typeof vouch !== "object" || vouch === null || typeof vouch.link !== "object" || vouch.link === null) continue;
    const { key, device } = vouch;
    const [member, signIn] = [read(vouch.link.member), read(vouch.link.device)];
    // A key that vouches for itself says nothing; what is no key is refused with the bytes.
    if (member === null || signIn === null || key === device) continue;
    let bytes: Uint8Array;
    try {
      bytes = linkBytes({ account, list, key, device });
    } catch (error) {
      if (error instanceof ListKindError) continue;
      throw error;
    }
    if ((await verifySignature(bytes, signIn, device)) && (await verifySignature(bytes, member, key))) held.push({ key, device });
  }
  return held;
}

/**
 * What a PC holds of the devices of its account.
 *
 * - `rows`: the device keys it lets in to drive THROUGH THE ACCOUNT now, each with how long it has by its own
 *   two clocks (LetIn), read after a whole read of the account service's snapshot since the PC last started. A
 *   row that is held back, waits or only watches is not among them, and neither is a key the PC let in once and
 *   has dropped. **A pairing made at the PC is no such row**: the PC cannot tell an owner's pairing from a
 *   guest's.
 * - `removed`: the keys it holds a removal against (a member's signed removal or block that it applied, or a
 *   person's Revoke at this PC).
 * - `vouched`: the vouches it was handed that hold (heldVouches).
 */
export interface PcWitness {
  readonly account: string;
  readonly rows: readonly LetIn[];
  readonly removed: readonly string[];
  readonly vouched: readonly { readonly key: string; readonly device: string }[];
}

/** The keys one device has been in a list by: every key that handed its place on down to `key`, `key` itself, and every key it handed its place on to. */
function deviceKeys(state: ListState, key: string): string[] {
  const chain = (from: string): string[] => {
    const keys = [from];
    for (let heir = heirOf(state, from); heir !== null && !keys.includes(heir); heir = heirOf(state, heir)) keys.push(heir);
    return keys;
  };
  const all = new Set(chain(key));
  for (const other of Object.keys(state.signers)) {
    const keys = chain(other);
    if (keys.includes(key)) for (const one of keys) all.add(one);
  }
  return [...all];
}

/**
 * Whether a PC keeps a device out by a removal of its own: it holds one against a key the device has been in the
 * list by, whichever of them the device is in by now, or against a sign-in key that vouches for one of them. A
 * PC that follows a list asks this of every key the list would let in, so a removal it holds is undone neither by
 * a hand-over nor by the pin: it means after the pin what it meant before it (pinVerdict's `removed`).
 */
export function heldOut(state: ListState, held: Pick<PcWitness, "removed" | "vouched">, key: string): boolean {
  const keys = deviceKeys(state, key);
  const vouching = held.vouched.filter((vouch) => keys.includes(vouch.key)).map((vouch) => vouch.device);
  return [...keys, ...vouching].some((one) => held.removed.includes(one));
}

/**
 * Why a PC does not follow the list a device named to it, the first that applies, in this order.
 *
 * - `stopped`: the PC cannot place an entry of the list (it needs a newer Ovis).
 * - `other_account`: the list is of another account than the PC's.
 * - `other_list`: the log the PC read is not of the list that was named.
 * - `carried_off_curve`: the list carries in a key that is no point of the curve. No honest device signs one
 *   (signMigration), and a member that saves it among its keys cannot read its own copy back.
 * - `removed`: the PC holds a removal against the key of the session, against a key the naming device has been in
 *   the list by, or against a sign-in key that vouches for it. What it put out names nothing to it.
 * - `session_unknown`: the session is signed in with a key the PC does not let in through the account.
 * - `session_new`: the PC lets that key in, for less than a day by its two clocks; `wait` is how many seconds
 *   are left. It says nothing meanwhile.
 * - `not_member`: the list does not hold the naming key as a device of power `full` that is in.
 * - `session_other_device`: the session's key is not the naming device's own: the list does not show it as that
 *   device's key or as one handed over to it, and it has not vouched for it. A session carries no other device's
 *   naming.
 * - `first_signer_removed`, `first_signer_unknown`, `first_signer_new`: the PC holds a removal against the device
 *   that started the list; or it does not know that device (it lets in none of its keys, and no key it lets in
 *   vouches for it); or it has for less than a day (`wait`). A list made by a key this PC never let in is never
 *   followed here while that key is in, whoever names it. Once that device is out of the list, the PC follows
 *   when it can place every signer that is in: it knows the signer's own device, or somebody it knows let the
 *   signer in, through however many hands, without the first signer among them. A device that was carried in and
 *   that this PC does not know, a PC whose keys the first device added, and an open invite it placed cannot be
 *   placed.
 * - `run_open`: what the PC read is the beginning of a birth, not a list.
 */
export type PinRefusal =
  | "stopped" | "other_account" | "other_list" | "carried_off_curve" | "removed" | "session_unknown" | "session_new" | "not_member" | "session_other_device"
  | "first_signer_removed" | "first_signer_unknown" | "first_signer_new" | "run_open";

export type PinVerdict =
  /** The PC follows the list: `admitted` is what its pin names (the follower's `migrated` pin), entry 0's signer and every key that was carried in, in ascending order. */
  | { readonly pin: true; readonly admitted: readonly string[] }
  /** `waits`: nothing is wrong so far, and the PC is asked again; otherwise it goes on as before the list. */
  | { readonly pin: false; readonly why: PinRefusal; readonly waits: boolean; readonly wait: number | null };

/**
 * Whether a PC that is in an account, and follows no list, follows the list a device named to it inside its
 * session. `state` is what the PC replayed of that list's log, read with its own proof, with nothing pinned yet;
 * `naming` is what heldNaming gave for this very session.
 *
 * A device is KNOWN AT THIS PC when a key the PC has let in through the account for a day, by its own two
 * clocks, is one the list holds that device by, or one the list shows handed over to its key, or one that
 * vouches for its key. The PC follows only when both hold:
 *
 * 1. the session is signed in with such a key of the naming device itself, and the list holds the naming key as
 *    a device of power `full` that is in. A session carries no other device's naming;
 * 2. the device that started the list (entry 0's signer) is known at this PC too; or it is out of the list by
 *    now, and the PC can place every signer that is in (a device it knows, or one let in by somebody it knows
 *    without the first signer's hand in it). The phone that started a list may be replaced; what it let in must
 *    not outlast it unseen.
 *
 * So a list made by a key this PC never let in is never followed here, whoever names it: not on the word of a
 * device that was fooled into it, and not on the word of the account service. And a PC that was off, or took
 * this release long after its account moved, follows the next time a device it knows opens it, with nobody at it
 * and no record of what it once let in: devices whose sign-in has changed since vouch for their keys.
 *
 * The PC asks nothing of the other keys the list was born with: that was asked by the first device of the PCs it
 * knows (migrationPlan). A removal this PC holds against a device that is neither the naming one nor the one
 * that started the list is no reason not to follow: that device stays out at this PC after the pin (heldOut).
 * Nothing here is one-way: a PC that does not follow goes on as before the list and is asked again at the next
 * naming. Only the pin that follows a yes is.
 */
export function pinVerdict(state: ListState, naming: Naming, witness: PcWitness): PinVerdict {
  const no = (why: PinRefusal, waits = false, wait: number | null = null): PinVerdict => ({ pin: false, why, waits, wait });
  if (state.needs_replay !== undefined) return no("stopped");
  if (state.account !== witness.account) return no("other_account");
  const first = firstSigner(state);
  if (first === null || naming.list !== state.list) return no("other_list");
  const carried = listView(state).devices.filter((row) => row.carried).map((row) => row.key);
  if (carried.some((key) => !isListKey(key))) return no("carried_off_curve");
  const removed = (key: string): boolean => witness.removed.includes(key);
  /** The sign-in keys that vouch for one of these keys. */
  const vouchers = (keys: readonly string[]): string[] => witness.vouched.filter((vouch) => keys.includes(vouch.key)).map((vouch) => vouch.device);
  const own = deviceKeys(state, naming.key);
  if (removed(naming.session) || own.some(removed) || vouchers(own).some(removed)) return no("removed");
  const wait = waitFor(witness.rows, naming.session);
  if (wait === null) return no("session_unknown");
  if (wait > 0) return no("session_new", true, wait);
  if (!deviceIn(state, naming.key) || rowOf(state.signers, naming.key)?.power !== "full") return no("not_member");
  if (!own.includes(naming.session) && !vouchers(own).includes(naming.session)) return no("session_other_device");
  /** How long until this PC knows the device of these keys: 0 for one it knows, null for one it does not let in by any key, its own or a vouching one. */
  const knownIn = (keys: readonly string[]): number | null => {
    const waits = [...keys, ...vouchers(keys)].flatMap((key) => { const one = waitFor(witness.rows, key); return one === null ? [] : [one]; });
    return waits.length === 0 ? null : Math.min(...waits);
  };
  const starter = deviceKeys(state, first);
  if (starter.some(removed) || vouchers(starter).some(removed)) return no("first_signer_removed");
  /**
   * Whether this PC can place a signer: it knows the signer's own device, or somebody it knows let the signer in,
   * through however many hands, without the first signer among them.
   */
  const placed = (key: string): boolean => {
    let at = key;
    for (let steps = 0; steps <= state.footing.seq; steps += 1) {
      const keys = deviceKeys(state, at);
      if (keys.some((one) => starter.includes(one))) return false;
      // A device this PC put out itself stays out here, which is no reason not to follow; it stands behind nobody it let in.
      if (keys.some(removed) || vouchers(keys).some(removed)) return at === key;
      if (rowOf(state.signers, at)?.as === "device" && knownIn(keys) === 0) return true;
      // Who let this device, PC or invite in: the signer of the entry that added the first of its keys.
      const by = keys.map((one) => rowOf(state.signers, one)?.by ?? null).find((one) => one !== null && !keys.includes(one)) ?? null;
      if (by === null) return false;
      at = by;
    }
    return false;
  };
  const known = knownIn(starter);
  if (known !== 0) {
    // The device that started the list is out of it: the list is still this PC's when everybody who is in is somebody it can place.
    const stays = Object.entries(state.signers).filter(([key, row]) => row.ended === null && (row.as !== "invite" || inviteRefusal(state, key) === null)).map(([key]) => key);
    const gone = !starter.some((key) => rowOf(state.signers, key)?.ended === null);
    if (!(gone && stays.every(placed))) return known === null ? no("first_signer_unknown") : no("first_signer_new", true, known);
  }
  if (birthOpen(state)) return no("run_open", true);
  return { pin: true, admitted: [...new Set([first, ...carried])].sort() };
}
