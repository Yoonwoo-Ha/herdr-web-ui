import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import {
  LIST_LEVEL, admitsDevice, holdsPc, listView, namesFields, readNames, replayList, sealEpoch, signCard, signListEntry,
  type ListNames, type ListSigner, type ListState,
} from "./account-list.ts";
import { epochKeyCommitment, newEpochKey, nextEpoch, openSealed, sealFields, type EpochKey } from "./account-list-seal.ts";
import {
  LIST_LINK_PREFIX, LIST_NAMING_PREFIX, MIGRATION_ANSWER_SECONDS, MIGRATION_CARRIED_MAX, MIGRATION_KNOWN_SECONDS, MIGRATION_RUNNING_SECONDS, MIGRATION_WITNESS_SECONDS, MigrationError, addedItself, devicePlace,
  heirOf, heldNaming, heldOut, heldVouches, joinVerdict, migrationPlan, namingBytes, ownEvidence, pinVerdict, rekeys, signMigration, signNaming, signRotation, signVouch, standsFor, standsFor as heldBy, linkBytes,
  type JoinRefusal, type JoinVerdict, type KnownDevice, type KnownPc, type LetIn, type MigratingDevice, type MigrationKnown, type MigrationPlan, type MigrationSeals, type MigrationStart, type Naming,
  type PcAnswer, type PcHow, type PcWitness, type PinRefusal, type PinVerdict, type SignedNaming, type SignedVouch,
} from "./account-list-migrate.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const DAY = MIGRATION_WITNESS_SECONDS;
const RUN = MIGRATION_RUNNING_SECONDS;
const T0 = 1767225600;
const ACCOUNT = "TEST-ONLY-account";

const spki = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
async function signer(): Promise<ListSigner> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  return { key: await spki(pair.publicKey), privateKey: pair.privateKey };
}
/** A device as it is signed in: the key its sign-in registered, its account key, its encryption key and its name. */
interface Device extends MigratingDevice { readonly label: string }
async function device(label: string): Promise<Device> {
  const enc = await spki((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])).publicKey);
  return { label, signIn: await signer(), member: await signer(), enc, names: { label, os: "ios" } };
}
const phone = await device("Phone");
const tablet = await device("Tablet");
const laptop = await device("Laptop");
/** A key the account service made up, or one it registered for somebody who is not the person. */
const stranger = await device("Stranger");
/** A PC's relay key. */
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const names = (label: string): ListNames => ({ label, os: "linux" });
/** A key in its one spelling whose point is not on the curve. */
const offCurve = (() => {
  const bytes = fromBase64Url(tablet.signIn.key);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  return toBase64Url(bytes);
})();
/** The same device after it signed in again: another sign-in key, the same account key. */
const signedInAgain = async (one: Device): Promise<Device> => ({ ...one, signIn: await signer() });

/** The caller's side of sealing, with the real keys. */
function sealer(): { readonly seals: MigrationSeals; readonly keys: Map<number, EpochKey>; readonly wrapped: string[][] } {
  const keys = new Map<number, EpochKey>();
  const wrapped: string[][] = [];
  const current = (epoch: number): EpochKey => {
    const key = keys.get(epoch);
    if (key === undefined) throw new Error(`no key of epoch ${epoch}`);
    return key;
  };
  return {
    keys, wrapped,
    seals: {
      async genesis(given) {
        const epoch = newEpochKey(0);
        keys.set(0, epoch);
        const opens = epochKeyCommitment({ list: "", epoch });
        return { opens, sealed: given === null ? null : { epoch: 0, bytes: await sealFields({ place: { list: "", seq: 0 }, epoch, commitment: opens, fields: namesFields(given) }) } };
      },
      async names(place, epoch, given) {
        return { epoch: epoch.epoch, bytes: await sealFields({ place, epoch: current(epoch.epoch), commitment: epoch.opens, fields: namesFields(given) }) };
      },
      async next(list, epoch, members) {
        const made = await nextEpoch({ list, current: current(epoch), members });
        keys.set(made.epoch.epoch, made.epoch);
        wrapped.push(made.wraps.map((wrap) => wrap.member));
        return { opens: made.commitment, link: made.link };
      },
    },
  };
}

const plan = (devices: readonly Device[], pcs: readonly number[] = []): Pick<MigrationPlan, "devices" | "pcs"> => ({
  devices: devices.map((one) => ({ key: one.signIn.key, names: one.names })),
  pcs: pcs.map((n) => ({ endpoint: E(n), names: names(`PC ${n}`) })),
});
async function replay(texts: readonly string[]): Promise<ListState> {
  const replayed = await replayList(texts, LIST_LEVEL, { saved: null });
  if (replayed.member === null || replayed.stopped !== null) throw new Error("the list does not replay");
  return replayed.member.state;
}
/** A list as the first device makes it: entry 0 and the whole run, one request. */
async function migrated(first: Device, carried: Pick<MigrationPlan, "devices" | "pcs">, at = T0) {
  const sealed = sealer();
  const made = await signMigration(ACCOUNT, carried, first, at, sealed.seals);
  return { texts: made.entries.map((entry) => entry.text), state: made.state, sealed, list: made.list };
}

/** A key somebody has let in: for a month and with the PC running all that time, unless a test says otherwise. */
const OLD = { wall: 30 * DAY, ran: 30 * DAY };
type Row = Device | readonly [Device, Partial<Pick<LetIn, "wall" | "ran" | "idle">>] | LetIn;
const rows = (given: readonly Row[]): LetIn[] => given.map((one) => ("key" in one ? one : "signIn" in one ? { key: one.signIn.key, ...OLD } : { key: one[0].signIn.key, ...OLD, ...one[1] }));
const witness = (given: readonly Row[], rest: Partial<Pick<PcWitness, "removed" | "account" | "vouched">> = {}): PcWitness =>
  ({ account: rest.account ?? ACCOUNT, rows: rows(given), removed: rest.removed ?? [], vouched: rest.vouched ?? [] });
const listed = (one: Device, eligible = true): KnownDevice => ({ key: one.signIn.key, eligible, names: one.names });
const says = (given: readonly Row[], rest: Partial<PcAnswer> = {}): PcAnswer => ({ account: ACCOUNT, pinned: null, admits: rows(given), removed: [], ...rest });
const pc = (n: number, answer: PcAnswer | null, rest: Partial<Pick<KnownPc, "how" | "known">> = {}): KnownPc =>
  ({ endpoint: E(n), how: rest.how ?? "none", known: rest.known === undefined ? 30 * DAY : rest.known, says: answer, names: names(`PC ${n}`) });
/** Three days after a device's first try: it goes by the PCs that answered. */
const LATE = MIGRATION_ANSWER_SECONDS;
const known = (devices: readonly KnownDevice[], pcs: readonly KnownPc[], removed: readonly string[] = []): MigrationKnown =>
  ({ account: ACCOUNT, self: phone.signIn.key, member: phone.member.key, devices, removed, pcs });
const started = (start: MigrationStart): MigrationPlan => {
  if (!start.start) throw new Error(`no start: ${start.why}`);
  return start.plan;
};
const pinWord = (verdict: PinVerdict): PinRefusal | "pin" => (verdict.pin ? "pin" : verdict.why);
const joinWord = (verdict: JoinVerdict): JoinRefusal | "pin" => (verdict.pin ? "pin" : verdict.why);
/** What a device says to a PC in its session, as the PC holds it once it checked the signature: the session's own key is the PC's to say. */
async function named(state: ListState, who: Device, session: string, endpoint = E(1)): Promise<Naming> {
  const signed = await signNaming(state, { member: who.member, session, endpoint });
  if (signed === null) throw new Error("nothing to name");
  const held = await heldNaming(ACCOUNT, endpoint, session, signed);
  if (held === null) throw new Error("the naming does not hold");
  return held;
}
const code = async (run: () => Promise<unknown>) => await run().then(() => null, (error: unknown) => (error instanceof MigrationError ? error.code : String(error)));

describe("a day, by a PC's own two clocks", () => {
  test("a key counts when it has been let in for a day by the wall clock AND the PC has run six hours with it let in", async () => {
    const made = await migrated(phone, plan([tablet]));
    const naming = await named(made.state, phone, phone.signIn.key);
    const word = (wall: number, ran: number) => pinVerdict(made.state, naming, witness([[phone, { wall, ran }]]));
    expect([DAY, RUN]).toEqual([86400, 21600]);
    expect(pinWord(word(DAY, RUN))).toBe("pin");
    // A PC with no battery clock whose time jumped at boot: a day by the wall clock, and it has run ten minutes.
    expect(word(3 * DAY, 600)).toEqual({ pin: false, why: "session_new", waits: true, wait: RUN - 600 });
    // A PC that never sleeps: six hours of running are no day.
    expect(word(RUN, RUN)).toEqual({ pin: false, why: "session_new", waits: true, wait: DAY - RUN });
    expect([pinWord(word(DAY - 1, RUN)), pinWord(word(DAY, RUN - 1))]).toEqual(["session_new", "session_new"]);
    // What is no duration is no record.
    for (const odd of [-1, Number.NaN, 1.5, "86400" as unknown as number]) expect([pinWord(word(odd, RUN)), pinWord(word(DAY, odd))]).toEqual(["session_unknown", "session_unknown"]);
    // A key named twice counts by its shorter stretch.
    expect(pinWord(pinVerdict(made.state, naming, witness([phone, [phone, { wall: 60, ran: 60 }]])))).toBe("session_new");
  });
});

describe("whom the first device carries in", () => {
  test("a device that EVERY PC it knows, and that answered, has let in for a day; and the PCs it knows by its own record", () => {
    const start = migrationPlan(known([listed(phone), listed(tablet), listed(laptop)], [pc(1, says([phone, tablet, laptop])), pc(2, says([phone, tablet]))]), 0);
    expect(started(start)).toEqual({
      devices: [{ key: tablet.signIn.key, names: tablet.names }],
      pcs: [{ endpoint: E(1), names: names("PC 1") }, { endpoint: E(2), names: names("PC 2") }],
      left: { devices: [{ key: laptop.signIn.key, why: "unwitnessed" }], pcs: [] },
    });
  });

  test("no single PC adds a key: one the service planted on one PC, or put into the directory itself, carries nothing", () => {
    // The service adds a key to what it tells the first device, and plants it on one PC for a month.
    const one = migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, stranger])), pc(2, says([phone]))]), 0);
    expect([started(one).devices, started(one).left.devices]).toEqual([[], [{ key: stranger.signIn.key, why: "unwitnessed" }]]);
    // A PC only the directory names, or one this device first opened an hour ago, is no witness whatever it answers.
    const fake = migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone])), pc(8, says([phone, stranger]), { known: null }), pc(9, says([phone, stranger]), { known: 3600 })]), 0);
    expect(started(fake).left).toEqual({ devices: [{ key: stranger.signIn.key, why: "unwitnessed" }], pcs: [{ endpoint: E(8), why: "unknown_pc" }, { endpoint: E(9), why: "unknown_pc" }] });
    expect(migrationPlan(known([listed(phone)], [pc(8, says([phone]), { known: null }), pc(9, says([phone]), { known: 6 * DAY }), pc(3, null)]), LATE)).toEqual({ start: false, why: "no_witness", wait: null });
    // A PC the person paired this device with at the PC is known at once.
    expect(started(migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, tablet]), { known: null, how: "paired" })]), 0)).devices).toHaveLength(1);
    // A PC it was never paired with is one it knows after seven days of sessions, not one.
    expect([MIGRATION_KNOWN_SECONDS, ownEvidence({ how: "none", known: 7 * DAY }), ownEvidence({ how: "none", known: 7 * DAY - 1 }), ownEvidence({ how: "none", known: null }), ownEvidence({ how: "paired", known: null }),
      ownEvidence({ how: "none", known: Number.NaN })]).toEqual([604800, true, false, false, true, false]);
    // What lets a member sign a PC's `pc` entry with no question is narrower: its own act for that PC, never how long it has opened it.
    const hows: PcHow[] = ["paired", "added", "ssh", "window", "none"];
    expect([hows.map((how) => addedItself({ how })), hows.map((how) => ownEvidence({ how, known: null })), addedItself({ how: "other" as PcHow })]).toEqual([[true, true, true, true, false], [true, true, true, true, false], false]);
  });

  test("a key the PCs have let in for less than a day holds the start back; what is left, said plainly: after a day it is carried in, whoever put it there", () => {
    const young = { wall: 3600, ran: 3600 };
    expect(migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, [stranger, young]])), pc(2, says([phone, stranger]))]), 0)).toEqual({ start: false, why: "too_new", wait: DAY - 3600 });
    // The longest wait among the PCs decides, by each PC's own two clocks.
    expect(migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, [tablet, { wall: DAY, ran: 60 }]])), pc(2, says([phone, [tablet, { wall: DAY - 60, ran: RUN }]]))]), 0)).toEqual({ start: false, why: "too_new", wait: RUN - 60 });
    expect(started(migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, [stranger, { wall: DAY, ran: RUN }]]))]), 0)).devices.map((row) => row.key)).toEqual([stranger.signIn.key]);
  });

  test("a PC that does not answer is no yes: the start waits until every PC the device knows has answered, three days at most", () => {
    // The service planted a key on PC 1 only, for a month. PC 2, which does not let it in, is asleep, or the relay drops its session.
    const silent = (tried: number) => migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, stranger])), pc(2, null)]), tried);
    expect([MIGRATION_ANSWER_SECONDS, silent(0), silent(LATE - 60)]).toEqual([259200, { start: false, why: "pcs_silent", wait: LATE }, { start: false, why: "pcs_silent", wait: 60 }]);
    // Had PC 2 answered, the key had no place.
    expect(started(migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, stranger])), pc(2, says([phone]))]), 0)).left.devices).toEqual([{ key: stranger.signIn.key, why: "unwitnessed" }]);
    // What is left, said plainly: after three days of one PC's silence, a key that stood for a day on the PC that answered is carried in.
    expect(started(silent(LATE)).devices.map((row) => row.key)).toEqual([stranger.signIn.key]);
    // A PC that is of another account, or that the device does not know, is not waited for.
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, says([], { account: "TEST-ONLY-other" })), pc(3, null, { known: null })]), 0).start).toBe(true);
  });

  test("a device the service hides is not carried in, and nothing else changes", () => {
    const start = started(migrationPlan(known([listed(phone), listed(laptop)], [pc(1, says([phone, tablet, laptop]))]), 0));
    expect([start.devices.map((row) => row.key), start.left.devices]).toEqual([[laptop.signIn.key], []]);
  });

  test("a device that was removed the day before stays out: where the service says so, where this device blocked it, and where the service lists it again", () => {
    const removed = migrationPlan(known([listed(phone), listed(tablet, false)], [pc(1, says([phone]))], [tablet.signIn.key]), 0);
    expect(started(removed).left.devices).toEqual([{ key: tablet.signIn.key, why: "removed" }]);
    // This device signed the block itself and has not sent it yet; the service and the PC still name the tablet.
    const own = migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, tablet]))], [tablet.signIn.key]), 0);
    expect(started(own).left.devices).toEqual([{ key: tablet.signIn.key, why: "removed" }]);
    // The service lists it as in again; one PC holds the removal.
    const relisted = migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, tablet])), pc(2, says([phone], { removed: [tablet.signIn.key] }))]), 0);
    expect([started(relisted).devices, started(relisted).left.devices]).toEqual([[], [{ key: tablet.signIn.key, why: "removed_at_pc" }]]);
  });

  test("a key the service says no PC lets in, a key that is no key, and this device's own account key", () => {
    const start = started(migrationPlan(known([listed(phone), listed(tablet, false), { key: "no-key", eligible: true, names: null }, { key: offCurve, eligible: true, names: null }, { key: phone.member.key, eligible: true, names: null }],
      [pc(1, says([phone, tablet, { key: offCurve, ...OLD }, { key: phone.member.key, ...OLD }]))]), DAY));
    expect([start.devices, start.left.devices]).toEqual([[], [{ key: tablet.signIn.key, why: "not_eligible" }, { key: "no-key", why: "form" }, { key: offCurve, why: "form" }]]);
    // A device that signed in this morning is in the service's wait: the start waits a day for it before it leaves it out.
    const waiting = (tried: number) => migrationPlan(known([listed(phone), listed(tablet, false)], [pc(1, says([phone]))]), tried);
    expect([waiting(0), waiting(DAY - 60), waiting(DAY).start]).toEqual([{ start: false, why: "too_new", wait: DAY }, { start: false, why: "too_new", wait: 60 }, true]);
  });

  test("the device's own key is held to the same, and an answer for another account is no answer", () => {
    const no = (why: string, wait: number | null = null) => ({ start: false, why, wait });
    expect(migrationPlan(known([listed(tablet)], [pc(1, says([phone, tablet]))]), 0)).toEqual(no("self_unlisted") as MigrationStart);
    expect(migrationPlan(known([listed(phone, false)], [pc(1, says([phone]))]), 0)).toEqual(no("self_unlisted") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone]))], [phone.signIn.key]), 0)).toEqual(no("self_removed") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, says([phone], { removed: [phone.signIn.key] }))]), 0)).toEqual(no("self_removed") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, says([tablet]))]), 0)).toEqual(no("self_unwitnessed") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([[phone, { wall: 60, ran: 60 }]]))]), 0)).toEqual(no("too_new", DAY - 60) as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone], { account: "TEST-ONLY-other" }))]), 0)).toEqual(no("no_witness") as MigrationStart);
  });

  test("a PC is carried in by this device's own record of it, answered or not, and one named twice once", () => {
    const start = started(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, null), pc(2, null), pc(3, null, { known: null, how: "ssh" }), pc(5, says([phone]), { known: null }), { ...pc(6, says([phone])), endpoint: "not-a-relay-key" }]), LATE));
    expect([start.pcs.map((row) => row.endpoint), start.left.pcs]).toEqual([[E(1), E(2), E(3)], [{ endpoint: E(5), why: "unknown_pc" }, { endpoint: "not-a-relay-key", why: "form" }]]);
  });

  test("an account with more than a list carries in: the devices a PC saw in use last are kept", async () => {
    const many = await Promise.all(Array.from({ length: MIGRATION_CARRIED_MAX + 3 }, (_, index) => device(`Device ${index}`)));
    const keyOf = (index: number): string => many[index]?.signIn.key ?? "";
    // Device 0 was last used a year ago, Device 1 never as far as the PC knows, Device 2 a month ago; the others this week.
    const idle = (index: number): number | null => (index === 0 ? 365 * DAY : index === 1 ? null : index === 2 ? 31 * DAY : index);
    const answer = says([phone, ...many.map((one, index): LetIn => ({ key: one.signIn.key, ...OLD, idle: idle(index) }))]);
    const start = started(migrationPlan(known([listed(phone), ...many.map((one) => listed(one))], [pc(1, answer), pc(2, null)]), LATE));
    expect([start.devices.length, start.devices[0]?.key, start.pcs, start.left.devices.map((row) => row.key), start.left.pcs.map((row) => row.why)]).toEqual([
      MIGRATION_CARRIED_MAX, keyOf(3), [], [keyOf(0), keyOf(1), keyOf(2)], ["over_limit", "over_limit"],
    ]);
    // Where all fit, nothing is reordered.
    const few = started(migrationPlan(known([listed(phone), listed(many[0] ?? phone), listed(many[5] ?? phone)], [pc(1, answer)]), 0));
    expect(few.devices.map((row) => row.key)).toEqual([keyOf(0), keyOf(5)]);
    // The whole birth is one request: entry 0, 64 carried, the hand-over and the epoch.
    const made = await migrated(phone, start);
    expect([made.texts.length, made.state.carrying, listView(made.state).devices.filter((row) => row.carried).length]).toEqual([MIGRATION_CARRIED_MAX + 3, false, MIGRATION_CARRIED_MAX]);
    expect(await code(() => signMigration(ACCOUNT, { devices: [...start.devices, { key: keyOf(0), names: null }], pcs: [] }, phone, T0, sealer().seals))).toBe("too_many");
  });
});

describe("the entries of a list that carries an account in", () => {
  test("one request: entry 0 by the sign-in key, the run, the hand-over to the member key, the next epoch; every entry counts", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1, 2]));
    const replayed = await replayList(made.texts, LIST_LEVEL, { saved: null });
    expect(replayed.took.map((item) => item.outcome.outcome)).toEqual(["counts", "counts", "counts", "counts", "counts", "counts", "counts"]);
    const state = await replay(made.texts);
    expect([state, state.list]).toEqual([made.state, made.list]);
    const view = listView(state);
    expect(view.devices.map((row) => [row.key, row.carried, row.ended, row.enc])).toEqual([
      [phone.signIn.key, false, 5, phone.enc], [tablet.signIn.key, true, null, null], [laptop.signIn.key, true, null, null], [phone.member.key, false, null, phone.enc],
    ]);
    expect(view.pcs.map((row) => [row.endpoint, row.how, row.key])).toEqual([[E(1), "carried", null], [E(2), "carried", null]]);
    expect([state.account, state.carrying, state.epoch, view.signers]).toEqual([ACCOUNT, false, 1, []]);
    // A pinned PC lets in whatever key the list holds: the old apps by the keys they have, the first device by the key it goes on with.
    expect([phone.signIn, tablet.signIn, laptop.signIn, phone.member, stranger.signIn].map((one) => admitsDevice(state, one.key, T0))).toEqual([null, "drive", "drive", "drive", null]);
    expect([holdsPc(state, E(1)), holdsPc(state, E(3))]).toEqual([true, false]);
    expect([sealEpoch(state, T0)?.epoch, made.sealed.wrapped]).toEqual([1, [[phone.enc]]]);
  });

  test("each entry seals the name of the member it lets in, under the epoch that was current", async () => {
    const made = await migrated(phone, plan([tablet], [1]));
    const key = made.sealed.keys.get(0);
    if (key === undefined) throw new Error("no key of epoch 0");
    const replayed = await replayList(made.texts, LIST_LEVEL, { saved: null });
    const labels: (string | null)[] = [];
    for (const { held } of replayed.took.slice(0, 4)) {
      const sealed = held.body.own.find((item) => item.name === "sealed")?.value;
      const opened = sealed === undefined ? null : await openSealed({ place: { list: held.body.seq === 0 ? "" : held.list, seq: held.body.seq }, epoch: key, sealed });
      labels.push(opened !== null && opened.open ? (readNames(opened.value)?.label ?? null) : null);
    }
    expect(labels).toEqual(["Phone", "Tablet", "PC 1", "Phone"]);
  });

  test("nothing is signed, entry 0 included, for a key off the curve, one of the device's own, a relay key out of form, or a device's own key that is none", async () => {
    const bad: ListSigner = { key: offCurve, privateKey: tablet.member.privateKey };
    const refused: [Pick<MigrationPlan, "devices" | "pcs">, Device][] = [
      [{ devices: [{ key: tablet.signIn.key, names: null }, { key: offCurve, names: null }], pcs: [] }, phone], [{ devices: [], pcs: [{ endpoint: "not-a-relay-key", names: null }] }, phone],
      [{ devices: [{ key: phone.member.key, names: null }], pcs: [] }, phone], [{ devices: [{ key: phone.signIn.key, names: null }], pcs: [] }, phone],
      [plan([]), { ...phone, member: bad }], [plan([]), { ...phone, enc: offCurve }], [plan([]), { ...phone, signIn: bad }],
    ];
    for (const [carried, first] of refused) {
      const sealed = sealer();
      expect(await code(() => signMigration(ACCOUNT, carried, first, T0, sealed.seals))).toBe("key_invalid");
      expect(sealed.keys.size).toBe(0);
    }
  });
});

describe("a device that was signed in before the list", () => {
  const keys = (one: Device) => ({ signIn: one.signIn.key, member: one.member.key });

  test("it learns from the list that it was carried in, and hands its place to its member key", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    expect([devicePlace(made.state, keys(tablet)), devicePlace(made.state, keys(phone)), devicePlace(made.state, keys(stranger))]).toEqual([{ at: "carried", wait: false }, { at: "member" }, { at: "absent", wait: false }]);
    const rotated = await signRotation(made.state, tablet, T0 + 30, null);
    const state = await replay([...made.texts, rotated.text]);
    expect(state).toEqual(rotated.state);
    expect([devicePlace(state, keys(tablet)), admitsDevice(state, tablet.signIn.key, T0 + 60), admitsDevice(state, tablet.member.key, T0 + 60)]).toEqual([{ at: "member" }, null, "drive"]);
    expect(listView(state).devices.find((row) => row.key === tablet.member.key)).toMatchObject({ by: tablet.signIn.key, carried: false, enc: tablet.enc, power: "full" });
    // A PC moves the row; it is the same device. The laptop, which has not run the new app, stays where it was.
    expect(rekeys(made.state, state)).toEqual([{ from: tablet.signIn.key, to: tablet.member.key }]);
    expect([heirOf(state, tablet.signIn.key), heirOf(state, laptop.signIn.key), standsFor(state, phone.signIn.key), standsFor(state, laptop.signIn.key), standsFor(state, stranger.signIn.key)])
      .toEqual([tablet.member.key, null, phone.member.key, laptop.signIn.key, null]);
    expect([rekeys(null, state), rekeys({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, state)]).toEqual([[], []]);
    expect([await code(() => signRotation(state, tablet, T0 + 90, null)), await code(() => signRotation(made.state, { ...tablet, member: phone.member }, T0 + 60, null))]).toEqual(["not_in", "has_member"]);
    for (const broken of [{ ...tablet, member: { key: offCurve, privateKey: tablet.member.privateKey } }, { ...tablet, enc: offCurve }]) expect(await code(() => signRotation(made.state, broken, T0 + 60, null))).toBe("key_invalid");
    expect(await code(() => signRotation({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, tablet, T0 + 60, null))).toBe("stopped");
  });

  test("shown only the beginning of a birth, it waits and signs nothing, however old the beginning is", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    // An honest log never holds a part of the one request. A service that shows entry 0 and the tablet's entry is lying.
    const shown = await replay(made.texts.slice(0, 2));
    expect([devicePlace(shown, keys(tablet)), devicePlace(shown, keys(laptop)), devicePlace(shown, keys(phone))]).toEqual([{ at: "carried", wait: true }, { at: "absent", wait: true }, { at: "first" }]);
    expect([await code(() => signRotation(shown, tablet, T0 + 3600, null)), await code(() => signRotation(shown, tablet, T0 + 30 * DAY, null))]).toEqual(["run_open", "run_open"]);
    expect(joinWord(joinVerdict(shown, keys(tablet), [pc(1, says([phone, tablet]))], 0))).toBe("run_open");
  });

  test("a device that was removed is out, whichever of its keys the removal named; a device a member let in is a member", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    const removed = await signListEntry(made.state, { kind: "remove", ends: laptop.signIn.key }, phone.member, T0 + 60);
    expect(devicePlace(removed.state, keys(laptop))).toEqual({ at: "out" });
    const rotated = await signRotation(made.state, tablet, T0 + 60, null);
    const out = await signListEntry(rotated.state, { kind: "remove", ends: tablet.member.key }, phone.member, T0 + 90);
    expect([devicePlace(out.state, keys(tablet)), standsFor(out.state, tablet.signIn.key), rekeys(rotated.state, out.state)]).toEqual([{ at: "out" }, null, []]);
    const added = await device("Added");
    const allowed = await signListEntry(made.state, {
      kind: "device", key: added.member.key, power: "full", role: "drive", until: null, enc: added.enc, sealed: null, rotates: false,
      card: await signCard({ key: added.member.key, enc: added.enc, list: made.list, endpoint: null, invite: null }, added.member.privateKey),
    }, phone.member, T0 + 60);
    expect(devicePlace(allowed.state, keys(added))).toEqual({ at: "member" });
  });
});

describe("a carried device follows a list it did not make only when the PCs it knows say who started it", () => {
  const keys = (one: Device) => ({ signIn: one.signIn.key, member: one.member.key });
  const no = (why: JoinRefusal, rest: Partial<{ waits: boolean; wait: number | null; pcs: string[] }> = {}): JoinVerdict => ({ pin: false, why, waits: rest.waits ?? false, wait: rest.wait ?? null, pcs: rest.pcs ?? [] });

  test("every PC it knows has let the first signer in for a day or is pinned to that very list; all must have answered, or three days passed", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    const ask = (pcs: readonly KnownPc[], tried = 0) => joinVerdict(made.state, keys(tablet), pcs, tried);
    expect(ask([pc(1, says([phone, tablet])), pc(2, says([], { pinned: made.list }))])).toEqual({ pin: true });
    expect(ask([pc(1, says([phone]), { known: null, how: "paired" })])).toEqual({ pin: true });
    // Nobody answers yet, or only PCs the directory names: it waits, and goes on as before the list.
    expect(ask([pc(1, null), pc(8, says([phone]), { known: null }), pc(9, says([phone]), { known: 60 }), pc(7, says([phone], { account: "TEST-ONLY-other" }))], LATE)).toEqual(no("no_answer", { waits: true }));
    expect(ask([pc(1, says([[phone, { wall: 3600, ran: 3600 }]])), pc(2, says([[phone, { wall: DAY, ran: 60 }]]))])).toEqual(no("first_signer_new", { waits: true, wait: DAY - 3600 }));
    // While every PC it knows is silent it waits for them; after three days there is still nobody to go by.
    expect(ask([pc(1, null), pc(2, null)], 60)).toEqual(no("pcs_silent", { waits: true, wait: LATE - 60, pcs: [E(1), E(2)] }));
    // One PC it knows is silent: its silence is no yes. After three days the device goes by those that answered.
    expect([ask([pc(1, says([phone])), pc(2, null)], 0), ask([pc(1, says([phone])), pc(2, null)], LATE - 60), ask([pc(1, says([phone])), pc(2, null)], LATE)])
      .toEqual([no("pcs_silent", { waits: true, wait: LATE, pcs: [E(2)] }), no("pcs_silent", { waits: true, wait: 60, pcs: [E(2)] }), { pin: true }]);
  });

  test("a list the account service started itself is refused by every device it shows it to, and said so", async () => {
    // Its own key, carrying the person's real devices so that everything looks as before.
    const forged = await migrated(stranger, plan([phone, tablet]));
    const ask = (pcs: readonly KnownPc[], tried = 0) => joinVerdict(forged.state, keys(tablet), pcs, tried);
    expect(ask([pc(1, says([phone, tablet]))])).toEqual(no("first_signer_unknown", { pcs: [E(1)] }));
    // One PC it planted its key on a month ago says yes; another PC of the person's does not know that key: every PC must agree.
    expect(ask([pc(1, says([phone, tablet, stranger])), pc(2, says([phone, tablet]))])).toEqual(no("first_signer_unknown", { pcs: [E(2)] }));
    // One PC says "pinned to it" (a PC the service made, opened for seven days, or one it captured); the PC that would say no is silent.
    expect(joinWord(ask([pc(1, says([], { pinned: forged.list })), pc(2, null)]))).toBe("pcs_silent");
    // Planted everywhere an hour ago: the device waits. What is left: planted everywhere for a day, it follows.
    expect(joinWord(ask([pc(1, says([phone, tablet, [stranger, { wall: 3600, ran: 3600 }]]))]))).toBe("first_signer_new");
    expect(joinWord(ask([pc(1, says([phone, tablet, stranger]))]))).toBe("pin");
    // A PC that is pinned to another list, or holds a removal against whoever started this one: the device says which PC.
    const real = await migrated(phone, plan([tablet]));
    expect(joinVerdict(real.state, keys(tablet), [pc(1, says([phone])), pc(2, says([], { pinned: forged.list }))], 0)).toEqual(no("other_list", { pcs: [E(2)] }));
    expect(joinVerdict(real.state, keys(tablet), [pc(1, says([phone], { removed: [phone.signIn.key] }))], 0)).toEqual(no("first_signer_removed", { pcs: [E(1)] }));
    expect(joinWord(joinVerdict(real.state, keys(tablet), [pc(1, says([phone], { removed: [phone.member.key] }))], 0))).toBe("first_signer_removed");
    expect(joinWord(joinVerdict(real.state, keys(tablet), [pc(1, says([phone])), pc(2, says([phone], { removed: [phone.signIn.key] }))], 0))).toBe("first_signer_removed");
  });

  test("it is asked only of a device that was carried in, of a list this build can place, and never of one that carries a key off the curve", async () => {
    const made = await migrated(phone, plan([tablet]));
    const pcs = [pc(1, says([phone, tablet]))];
    expect([joinWord(joinVerdict(made.state, keys(laptop), pcs, 0)), joinWord(joinVerdict(made.state, keys(phone), pcs, 0)), joinWord(joinVerdict({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, keys(tablet), pcs, 0))])
      .toEqual(["not_carried", "not_carried", "stopped"]);
    // The first signer's sign-in has changed since and the PC is not pinned yet: the PC no longer holds that key, and the device asks to be let in instead.
    expect(joinWord(joinVerdict(made.state, keys(tablet), [pc(1, says([await signedInAgain(phone), tablet]))], 0))).toBe("first_signer_unknown");
    const born = await signMigration(ACCOUNT, plan([]), phone, T0, sealer().seals);
    const entry0 = born.entries[0];
    if (entry0 === undefined) throw new Error("no entry 0");
    const good = await signListEntry(entry0.state, { kind: "carried", key: tablet.signIn.key, role: "drive", sealed: null }, phone.signIn, T0);
    const bad = await signListEntry(good.state, { kind: "carried", key: offCurve, role: "drive", sealed: null }, phone.signIn, T0);
    const run = await signRotation(bad.state, phone, T0, null);
    expect(joinVerdict(run.state, keys(tablet), pcs, 0)).toEqual(no("carried_off_curve"));
  });
});

describe("a device names its list to a PC inside its session", () => {
  test("what it says is its member key's word, bound to that PC and to the key the session is signed in with", async () => {
    const made = await migrated(phone, plan([tablet]));
    const signed = await signNaming(made.state, { member: phone.member, session: phone.signIn.key, endpoint: E(1) });
    if (signed === null) throw new Error("nothing to name");
    expect(signed).toMatchObject({ list: made.list, key: phone.member.key });
    expect(new TextDecoder().decode(namingBytes({ account: ACCOUNT, list: made.list, key: phone.member.key, session: phone.signIn.key, endpoint: E(1) })).startsWith(LIST_NAMING_PREFIX)).toBe(true);
    expect(await heldNaming(ACCOUNT, E(1), phone.signIn.key, signed)).toEqual({ list: made.list, key: phone.member.key, session: phone.signIn.key });
    // It is bound to the key the session is signed in with, so it holds in every session of that key at that PC, and for nobody else.
    // Said to another PC, under another key, for another account, with a changed signature or list: it does not hold.
    const changed = { ...signed, signature: `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}` };
    expect([await heldNaming(ACCOUNT, E(2), phone.signIn.key, signed), await heldNaming(ACCOUNT, E(1), tablet.signIn.key, signed), await heldNaming("TEST-ONLY-other", E(1), phone.signIn.key, signed),
      await heldNaming(ACCOUNT, E(1), phone.signIn.key, changed), await heldNaming(ACCOUNT, E(1), phone.signIn.key, { ...signed, list: "00".repeat(32) })]).toEqual([null, null, null, null, null]);
    // Whatever is handed over is read without a throw.
    const junk = [null, "naming", 5, { ...signed, signature: 5 }, { ...signed, signature: signed.signature.slice(1) }, { ...signed, key: offCurve }, { ...signed, key: 7 }, { ...signed, list: 3 }] as unknown as SignedNaming[];
    for (const odd of junk) expect(await heldNaming(ACCOUNT, E(1), phone.signIn.key, odd)).toBeNull();
    expect([await heldNaming(ACCOUNT, "not-a-relay-key", phone.signIn.key, signed), await heldNaming(ACCOUNT, E(1), offCurve, signed), await heldNaming("a b", E(1), phone.signIn.key, signed)]).toEqual([null, null, null]);
    for (const change of [{ account: "" }, { account: 5 }, { list: "00" }, { key: offCurve }, { session: "x" }, { session: null }, { endpoint: "E" }, { endpoint: 1 }]) {
      expect(() => namingBytes({ account: ACCOUNT, list: made.list, key: phone.member.key, session: phone.signIn.key, endpoint: E(1), ...change } as Parameters<typeof namingBytes>[0])).toThrow();
    }
    // A device names only the list it is a full member of: not one it was carried into and has not handed over in, not one it is out of.
    const out = await signListEntry(made.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect([await signNaming(made.state, { member: tablet.member, session: tablet.signIn.key, endpoint: E(1) }), await signNaming(out.state, { member: phone.member, session: phone.signIn.key, endpoint: E(1) }),
      await signNaming({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, { member: phone.member, session: phone.signIn.key, endpoint: E(1) })]).toEqual([null, null, null]);
    // A carried device that has not handed over names the list by the key it is in by, which is the session's own.
    const own = await signNaming(made.state, { member: tablet.signIn, session: tablet.signIn.key, endpoint: E(1) });
    expect(own === null ? null : await heldNaming(ACCOUNT, E(1), tablet.signIn.key, own)).toEqual({ list: made.list, key: tablet.signIn.key, session: tablet.signIn.key });
  });

  test("a vouch is the word of a sign-in key that a member key is its own device's", async () => {
    const made = await migrated(phone, plan([tablet]));
    const now = await signedInAgain(phone);
    const vouch = await signVouch(made.state, now);
    if (vouch === null) throw new Error("no vouch");
    expect(vouch).toMatchObject({ key: phone.member.key, device: now.signIn.key });
    // The statement is the account's link, byte for byte: its tag, then each value after its length in four bytes.
    const part = (text: string) => [0, 0, 0, text.length, ...new TextEncoder().encode(text)];
    expect([...linkBytes({ account: ACCOUNT, list: made.list, key: vouch.key, device: vouch.device })])
      .toEqual([...new TextEncoder().encode(LIST_LINK_PREFIX), ...part(ACCOUNT), ...part(made.list), ...part(vouch.key), ...part(vouch.device)]);
    expect([LIST_LINK_PREFIX, Object.keys(vouch).sort(), Object.keys(vouch.link).sort()]).toEqual(["ovis-list-link/1", ["device", "key", "link"], ["device", "member"]]);
    expect(await heldVouches(ACCOUNT, made.list, [vouch])).toEqual([{ key: phone.member.key, device: now.signIn.key }]);
    // Of another list or account, with a changed signature, out of form, or a key vouching for itself: none holds, and nothing throws.
    const other = await migrated(tablet, plan([phone]));
    const flip = (text: string) => `${text.startsWith("A") ? "B" : "A"}${text.slice(1)}`;
    const changed = { ...vouch, link: { ...vouch.link, device: flip(vouch.link.device) } };
    const self = toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, now.signIn.privateKey, new Uint8Array(linkBytes({ account: ACCOUNT, list: made.list, key: now.signIn.key, device: tablet.signIn.key }).slice()))));
    const junk = [null, "vouch", 5, changed, { ...vouch, link: { ...vouch.link, member: flip(vouch.link.member) } }, { ...vouch, link: { ...vouch.link, device: vouch.link.device.slice(1) } }, { ...vouch, link: { ...vouch.link, device: 5 } },
      { ...vouch, link: null }, { ...vouch, link: vouch.link.device }, { ...vouch, key: "no-key" }, { ...vouch, key: 5 }, { ...vouch, device: offCurve }, { ...vouch, device: {} },
      { key: now.signIn.key, device: now.signIn.key, link: { member: self, device: self } }] as unknown as SignedVouch[];
    expect([await heldVouches(ACCOUNT, other.list, [vouch]), await heldVouches("TEST-ONLY-other", made.list, [vouch]), await heldVouches(ACCOUNT, made.list, junk), await heldVouches(ACCOUNT, made.list, [...junk, vouch])])
      .toEqual([[], [], [], [{ key: phone.member.key, device: now.signIn.key }]]);
    for (const change of [{ account: "" }, { account: 5 }, { list: "00" }, { list: 7 }, { key: offCurve }, { key: 1 }, { device: offCurve }, { device: null }]) {
      expect(() => linkBytes({ account: ACCOUNT, list: made.list, key: vouch.key, device: vouch.device, ...change } as Parameters<typeof linkBytes>[0])).toThrow();
    }
    // The other way round is no vouch: a member key that names a sign-in key says nothing about that sign-in.
    const forged = await signVouch(made.state, { signIn: { key: tablet.signIn.key, privateKey: phone.member.privateKey }, member: phone.member });
    expect(await heldVouches(ACCOUNT, made.list, forged === null ? [] : [forged])).toEqual([]);
    // A device vouches only for its own member key while that key is in, and never for the key it signs in with.
    const out = await signListEntry(made.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect([await signVouch(made.state, tablet), await signVouch(out.state, now), await signVouch(made.state, { signIn: phone.member, member: phone.member }),
      await signVouch({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, now)]).toEqual([null, null, null, null]);
  });
});

describe("what a PC checks before it follows the list a device named", () => {
  const no = (why: PinRefusal, waits = false, wait: number | null = null): PinVerdict => ({ pin: false, why, waits, wait });
  /** The vouches of these devices for their member keys, as a PC holds them once it checked them. */
  async function vouches(state: ListState, ...who: Device[]): Promise<PcWitness["vouched"]> {
    const signed = await Promise.all(who.map((one) => signVouch(state, one)));
    return await heldVouches(ACCOUNT, state.list, signed.flatMap((one) => (one === null ? [] : [one])));
  }

  test("it follows when the session's key is the naming device's own, let in through the account for a day, and it knows who started the list", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    // The first device, signed in with the key it handed over from: the list itself ties the two.
    expect(pinVerdict(made.state, await named(made.state, phone, phone.signIn.key), witness([phone]))).toEqual({ pin: true, admitted: [phone.signIn.key, tablet.signIn.key, laptop.signIn.key].sort() });
    // A carried device that has not handed over names the list by its sign-in key, which is the session's own; the PC must know the phone too.
    const byTablet = await named(made.state, { ...tablet, member: tablet.signIn }, tablet.signIn.key);
    expect([pinVerdict(made.state, byTablet, witness([phone, tablet])).pin, pinVerdict(made.state, byTablet, witness([tablet]))]).toEqual([true, no("first_signer_unknown")]);
    // No carried key is asked of the PC: the laptop, which this PC never let in, changes nothing.
    expect(pinWord(pinVerdict(made.state, byTablet, witness([phone, tablet, stranger])))).toBe("pin");
  });

  test("a PC that was off, or took the release weeks after the move, follows the next time a device it knows opens it: no person, no record of what it dropped", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    // A month on: the tablet handed over, the laptop was removed, and both the phone and the tablet have signed in again since.
    const rotated = await signRotation(made.state, tablet, T0 + DAY, null);
    const state = (await signListEntry(rotated.state, { kind: "remove", ends: laptop.signIn.key }, tablet.member, T0 + 2 * DAY)).state;
    const [phoneNow, tabletNow] = [await signedInAgain(phone), await signedInAgain(tablet)];
    // The PC's rows are today's sign-ins: it never held any key the list was born with. Each device says which member key is its own.
    const naming = await named(state, tabletNow, tabletNow.signIn.key);
    const held = witness([phoneNow, tabletNow], { vouched: await vouches(state, phoneNow, tabletNow) });
    expect(pinVerdict(state, naming, held)).toMatchObject({ pin: true });
    expect([phone, tablet, laptop].map((one) => heldBy(state, one.signIn.key))).toEqual([phone.member.key, tablet.member.key, null]);
    // Without the tablet's vouch its session carries a naming of a key the PC cannot tie to it; without the phone's, the PC does not know who started the list.
    expect(pinVerdict(state, naming, witness([phoneNow, tabletNow], { vouched: await vouches(state, phoneNow) }))).toEqual(no("session_other_device"));
    expect(pinVerdict(state, naming, witness([phoneNow, tabletNow], { vouched: await vouches(state, tabletNow) }))).toEqual(no("first_signer_unknown"));
    // A vouch counts only from a key the PC has let in for a day: the phone signed in again this morning.
    expect(pinVerdict(state, naming, witness([[phoneNow, { wall: 3600, ran: 3600 }], tabletNow], { vouched: await vouches(state, phoneNow, tabletNow) }))).toEqual(no("first_signer_new", true, DAY - 3600));
    // A device is known by any one of its keys: the phone's new sign-in is an hour old here, and its old one is still a row.
    expect(pinWord(pinVerdict(state, naming, witness([phone, [phoneNow, { wall: 3600, ran: 3600 }], tabletNow], { vouched: await vouches(state, phoneNow, tabletNow) })))).toBe("pin");
    expect(pinVerdict(state, naming, witness([[phone, { wall: 7200, ran: 7200 }], [phoneNow, { wall: 3600, ran: 3600 }], tabletNow], { vouched: await vouches(state, phoneNow, tabletNow) }))).toEqual(no("first_signer_new", true, DAY - 7200));
    // The device that started the list has left the account since, and this PC never held its key: it follows all the same, since
    // everybody who is in is a device it knows.
    const gone = await signListEntry(state, { kind: "remove", ends: phone.member.key }, tablet.member, T0 + 3 * DAY);
    expect(pinVerdict(gone.state, await named(gone.state, tabletNow, tabletNow.signIn.key), witness([tabletNow], { vouched: await vouches(gone.state, tabletNow) }))).toMatchObject({ pin: true });
  });

  test("a list whose first signer is out is followed only when the PC can place every signer that is in", async () => {
    const added = await device("Added");
    const allow = async (state: ListState, who: Device, by: ListSigner, at: number) => await signListEntry(state, {
      kind: "device", key: who.member.key, power: "full", role: "drive", until: null, enc: who.enc, sealed: null, rotates: false,
      card: await signCard({ key: who.member.key, enc: who.enc, list: state.list, endpoint: null, invite: null }, who.member.privateKey),
    }, by, at);
    const desk = await device("Desk");
    const addPc = async (state: ListState, by: ListSigner, at: number) => await signListEntry(state, {
      kind: "pc", key: desk.member.key, endpoint: E(9), enc: desk.enc, sealed: null,
      card: await signCard({ key: desk.member.key, enc: desk.enc, list: state.list, endpoint: E(9), invite: null }, desk.member.privateKey),
    }, by, at);
    const byTablet = async (state: ListState) => await named(state, { ...tablet, member: tablet.signIn }, tablet.signIn.key);

    // The person's own list: the phone started it and has left. The laptop, carried in, is in and is none this PC lets in.
    const made = await migrated(phone, plan([tablet, laptop]));
    const left = await signListEntry(made.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect([pinWord(pinVerdict(left.state, await byTablet(left.state), witness([tablet, laptop]))), pinVerdict(left.state, await byTablet(left.state), witness([tablet]))]).toEqual(["pin", no("first_signer_unknown")]);
    // A device that somebody this PC knows let in is placed by that: the tablet handed over and allowed a new phone.
    const rotated = await signRotation(made.state, tablet, T0 + 30, null);
    const allowed = await allow(rotated.state, added, tablet.member, T0 + 40);
    const gone = await signListEntry(allowed.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect(pinWord(pinVerdict(gone.state, await named(gone.state, tablet, tablet.signIn.key), witness([tablet, laptop])))).toBe("pin");
    // One the first device itself let in before it left is not: nobody this PC knows stands behind it.
    const byPhone = await allow(made.state, added, phone.member, T0 + 40);
    const then = await signListEntry(byPhone.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect(pinVerdict(then.state, await byTablet(then.state), witness([tablet, laptop]))).toEqual(no("first_signer_unknown"));
    // Unless this PC knows that device itself.
    expect(pinWord(pinVerdict(then.state, await byTablet(then.state), witness([tablet, laptop, added], { vouched: await vouches(then.state, added) })))).toBe("pin");

    // The service's own birth: its key carries the real devices, adds a PC with keys, and removes itself.
    const forged = await migrated(stranger, plan([phone, tablet]));
    const withPc = await addPc(forged.state, stranger.member, T0 + 30);
    const out = await signListEntry(withPc.state, { kind: "remove", ends: stranger.member.key }, stranger.member, T0 + 60);
    expect(pinVerdict(out.state, await byTablet(out.state), witness([phone, tablet]))).toEqual(no("first_signer_unknown"));
    // The same with only real, known devices left: the PC follows. What that cost is names: the service held the first epoch's key.
    const bare = await signListEntry(forged.state, { kind: "remove", ends: stranger.member.key }, stranger.member, T0 + 60);
    expect(pinWord(pinVerdict(bare.state, await byTablet(bare.state), witness([phone, tablet])))).toBe("pin");
    // While its key is in, nothing changes: it is a first signer this PC does not know.
    expect(pinVerdict(forged.state, await byTablet(forged.state), witness([phone, tablet]))).toEqual(no("first_signer_unknown"));
    // A PC with keys that a device this PC knows added is placed by that device.
    const tabletOver = await signRotation(forged.state, tablet, T0 + 30, null);
    const pcByTablet = await addPc(tabletOver.state, tablet.member, T0 + 40);
    const clean = await signListEntry(pcByTablet.state, { kind: "remove", ends: stranger.member.key }, stranger.member, T0 + 60);
    expect(pinWord(pinVerdict(clean.state, await named(clean.state, tablet, tablet.signIn.key), witness([phone, tablet])))).toBe("pin");
    // A device this PC put out itself is no reason not to follow: it stays out here. But it places nobody it let in.
    expect(pinWord(pinVerdict(left.state, await byTablet(left.state), witness([tablet], { removed: [laptop.signIn.key] })))).toBe("pin");
    const laptopOver = await signRotation(made.state, laptop, T0 + 30, null);
    const byLaptop = await allow(laptopOver.state, added, laptop.member, T0 + 40);
    const after = await signListEntry(byLaptop.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect(pinVerdict(after.state, await byTablet(after.state), witness([tablet], { removed: [laptop.signIn.key] }))).toEqual(no("first_signer_unknown"));
    // The laptop it put out has handed over since: it is the same device by whichever key, and still no obstacle.
    const laptopOnly = await signListEntry(laptopOver.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect(pinWord(pinVerdict(laptopOnly.state, await byTablet(laptopOnly.state), witness([tablet], { removed: [laptop.signIn.key] })))).toBe("pin");
    // An invite the first device placed before it left lets no PC in, and holds nothing back; one a device this PC knows placed is that device's.
    const line = await signer();
    const invited = await signListEntry(made.state, { kind: "invite", key: line.key, exp: T0 + 900, uses: 1, auto: true, sealed: null }, phone.member, T0 + 30);
    const voided = await signListEntry(invited.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    const open = await signListEntry(gone.state, { kind: "invite", key: line.key, exp: T0 + 900, uses: 1, auto: true, sealed: null }, tablet.member, T0 + 90);
    expect([listView(voided.state).invites.map((row) => row.refusal), pinWord(pinVerdict(voided.state, await byTablet(voided.state), witness([tablet, laptop]))),
      listView(open.state).invites.map((row) => row.refusal), pinWord(pinVerdict(open.state, await named(open.state, tablet, tablet.signIn.key), witness([tablet, laptop])))])
      .toEqual([["invite_void"], "pin", [null], "pin"]);
    // A removal this PC holds against the first device stands, in or out.
    expect(pinVerdict(left.state, await byTablet(left.state), witness([tablet, laptop], { removed: [phone.signIn.key] }))).toEqual(no("first_signer_removed"));
  });

  test("a session never carries another device's naming: a guest's pairing, a borrowed browser, any row of the PC", async () => {
    // The service's own birth: its key, nobody carried.
    const forged = await migrated(stranger, plan([]));
    const guest = await device("Guest");
    // A guest's browser was paired at the PC a month ago to share one terminal. A pairing is no row of the account: the PC cannot
    // tell an owner's pairing from a guest's, so the guest's session names nothing, whatever it carries.
    const carried = await named(forged.state, stranger, guest.signIn.key);
    expect(pinVerdict(forged.state, carried, witness([phone, tablet]))).toEqual(no("session_unknown"));
    // A key the PC does let in through the account (a borrowed browser, say) carries the same naming: it is not that key's device.
    expect(pinVerdict(forged.state, carried, witness([guest]))).toEqual(no("session_other_device"));
    // In the person's own list too: the laptop's session carries a naming signed by the phone's key.
    const made = await migrated(phone, plan([tablet, laptop]));
    expect(pinVerdict(made.state, await named(made.state, phone, laptop.signIn.key), witness([phone, tablet, laptop]))).toEqual(no("session_other_device"));
    // What is left, said plainly: a key this PC has let in through the account for a day that says "the service's key is mine" names
    // that list to this PC. Such a key is a terminal on this PC already.
    const lie = await heldVouches(ACCOUNT, forged.list, [await signVouch(forged.state, { signIn: guest.signIn, member: stranger.member })].flatMap((one) => (one === null ? [] : [one])));
    expect([lie.length, pinWord(pinVerdict(forged.state, carried, witness([guest], { vouched: lie }))), pinWord(pinVerdict(forged.state, carried, witness([[guest, { wall: 3600, ran: 3600 }]], { vouched: lie })))])
      .toEqual([1, "pin", "session_new"]);
  });

  test("a device that was fooled into a list names it in vain: the PC does not know who started it", async () => {
    // The service's own birth carries the person's tablet; the tablet followed it on the word of the one PC that answered.
    const forged = await migrated(stranger, plan([tablet]));
    const byTablet = await named(forged.state, { ...tablet, member: tablet.signIn }, tablet.signIn.key);
    expect(pinVerdict(forged.state, byTablet, witness([phone, tablet]))).toEqual(no("first_signer_unknown"));
    // After its hand-over there too.
    const rotated = await signRotation(forged.state, tablet, T0 + 60, null);
    expect(pinVerdict(rotated.state, await named(rotated.state, tablet, tablet.signIn.key), witness([phone, tablet]))).toEqual(no("first_signer_unknown"));
  });

  test("the breached service: its own genesis, a planted key under a day, a planted key over a day", async () => {
    const forged = await migrated(stranger, plan([phone, tablet]));
    const naming = await named(forged.state, stranger, stranger.signIn.key);
    // Its own key is none the PC lets in: there is no session to say it in.
    expect(pinVerdict(forged.state, naming, witness([phone, tablet]))).toEqual(no("session_unknown"));
    // It plants its key in this PC's snapshot: for an hour, the PC waits out the day and says nothing.
    expect(pinVerdict(forged.state, naming, witness([phone, tablet, [stranger, { wall: 3600, ran: 3600 }]]))).toEqual(no("session_new", true, DAY - 3600));
    // What is left, said plainly: a key THIS PC has let in for a day names a list to it. On a PC where it never stood, it names nothing.
    expect(pinWord(pinVerdict(forged.state, naming, witness([phone, tablet, stranger])))).toBe("pin");
    // It cannot borrow a session: a naming made for the phone's session does not hold in its own.
    const borrowed = await signNaming(forged.state, { member: stranger.member, session: phone.signIn.key, endpoint: E(1) });
    expect(borrowed === null ? null : await heldNaming(ACCOUNT, E(1), stranger.signIn.key, borrowed)).toBeNull();
  });

  test("a key the PC let in once and dropped names nothing: it opens no session", async () => {
    const forged = await migrated(tablet, plan([phone]));
    expect(pinWord(pinVerdict(forged.state, await named(forged.state, tablet, tablet.signIn.key), witness([phone, laptop])))).toBe("session_unknown");
  });

  test("a removal this PC holds follows the device to the key it handed over to, and to the key it signs in with now", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    const rotated = await signRotation(made.state, tablet, T0 + 60, null);
    const tabletNow = await signedInAgain(tablet);
    // A block of the tablet reached this PC before the move. The tablet hands over, signs in again and vouches for its new key.
    const blocked = witness([phone, tabletNow], { removed: [tablet.signIn.key], vouched: await vouches(rotated.state, tabletNow) });
    expect(pinVerdict(rotated.state, await named(rotated.state, tabletNow, tabletNow.signIn.key), blocked)).toEqual(no("removed"));
    expect([heldOut(rotated.state, blocked, tablet.member.key), heldOut(rotated.state, blocked, tablet.signIn.key), heldOut(rotated.state, blocked, phone.member.key), heldOut(rotated.state, { removed: [], vouched: [] }, tablet.member.key)])
      .toEqual([true, true, false, false]);
    // A removal against the key the session is signed in with, or against the member key itself, is the same.
    for (const key of [tabletNow.signIn.key, tablet.member.key]) {
      expect(pinWord(pinVerdict(rotated.state, await named(rotated.state, tabletNow, tabletNow.signIn.key), witness([phone, tabletNow], { removed: [key], vouched: blocked.vouched })))).toBe("removed");
    }
    // The PC put the first device out: nobody names it a list that device started. The phone's heir stays out there after any pin too.
    const byLaptop = await named(rotated.state, { ...laptop, member: laptop.signIn }, laptop.signIn.key);
    expect(pinVerdict(rotated.state, byLaptop, witness([phone, laptop], { removed: [phone.signIn.key] }))).toEqual(no("first_signer_removed"));
    expect(pinVerdict(rotated.state, byLaptop, witness([phone, laptop], { removed: [phone.member.key] }))).toEqual(no("first_signer_removed"));
    expect(heldOut(rotated.state, { removed: [phone.signIn.key], vouched: [] }, phone.member.key)).toBe(true);
    // A removal against some other device is no reason not to follow: that device stays out at this PC, and the list is followed.
    expect(pinWord(pinVerdict(rotated.state, byLaptop, witness([phone, laptop], { removed: [tablet.signIn.key] })))).toBe("pin");
  });

  test("the refusals, the first that applies", async () => {
    const made = await migrated(phone, plan([tablet]));
    const naming = await named(made.state, phone, phone.signIn.key);
    expect(pinVerdict({ ...made.state, needs_replay: { seq: 2, hash: "00".repeat(32) } }, naming, witness([phone]))).toEqual(no("stopped"));
    expect(pinVerdict(made.state, naming, witness([phone], { account: "TEST-ONLY-other" }))).toEqual(no("other_account"));
    expect(pinVerdict(made.state, { ...naming, list: "00".repeat(32) }, witness([phone]))).toEqual(no("other_list"));
    expect(pinVerdict(made.state, naming, witness([phone], { removed: [phone.signIn.key] }))).toEqual(no("removed"));
    expect(pinVerdict(made.state, naming, witness([tablet]))).toEqual(no("session_unknown"));
    // A device that is out, or a key the list never held, names nothing.
    const out = await signListEntry(made.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect(pinVerdict(out.state, naming, witness([phone]))).toEqual(no("not_member"));
    expect(pinVerdict(made.state, { ...naming, key: stranger.member.key }, witness([phone]))).toEqual(no("not_member"));
    // The first signer's own row is too new while the naming device's is not.
    const byTablet = await named(made.state, { ...tablet, member: tablet.signIn }, tablet.signIn.key);
    expect(pinVerdict(made.state, byTablet, witness([[phone, { wall: DAY, ran: 60 }], tablet]))).toEqual(no("first_signer_new", true, RUN - 60));
    // The beginning of a birth is no list yet.
    const shown = await replay(made.texts.slice(0, 2));
    expect(pinVerdict(shown, { list: made.list, key: phone.signIn.key, session: phone.signIn.key }, witness([phone]))).toEqual(no("run_open", true));
  });

  test("a list that carries in a key that is no point of the curve is followed by no PC", async () => {
    const born = await signMigration(ACCOUNT, plan([]), phone, T0, sealer().seals);
    const entry0 = born.entries[0];
    if (entry0 === undefined) throw new Error("no entry 0");
    // The kinds read only the spelling of a carried key: built here with the kinds' writer alone, on entry 0.
    const good = await signListEntry(entry0.state, { kind: "carried", key: tablet.signIn.key, role: "drive", sealed: null }, phone.signIn, T0);
    const carried = await signListEntry(good.state, { kind: "carried", key: offCurve, role: "drive", sealed: null }, phone.signIn, T0);
    const run = await signRotation(carried.state, phone, T0, null);
    expect(listView(run.state).devices.some((row) => row.key === offCurve && row.carried)).toBe(true);
    expect(pinVerdict(run.state, await named(run.state, phone, phone.signIn.key), witness([phone, { key: offCurve, ...OLD }]))).toEqual(no("carried_off_curve"));
    expect(standsFor(run.state, offCurve)).toBeNull();
  });

  test("two devices that start at once: the service keeps one list, and each PC follows the list its devices name", async () => {
    const [a, b] = [await migrated(phone, plan([tablet])), await migrated(tablet, plan([phone]))];
    expect(a.list === b.list).toBe(false);
    const asked = { signIn: tablet.signIn.key, member: tablet.member.key };
    // The tablet, told that the account has the phone's list, finds itself carried in there, asks its PCs and drops its own.
    expect([devicePlace(a.state, asked), joinWord(joinVerdict(a.state, asked, [pc(1, says([phone, tablet]))], 0))]).toEqual([{ at: "carried", wait: false }, "pin"]);
    // A service that keeps both can have each named to a PC by its maker: both are the person's own devices' work.
    expect([pinWord(pinVerdict(a.state, await named(a.state, phone, phone.signIn.key), witness([phone, tablet]))), pinWord(pinVerdict(b.state, await named(b.state, tablet, tablet.signIn.key), witness([phone, tablet])))]).toEqual(["pin", "pin"]);
    // A device that asks a PC pinned to the other one refuses, and says which PC.
    expect(joinVerdict(a.state, asked, [pc(1, says([], { pinned: b.list }))], 0)).toMatchObject({ why: "other_list", pcs: [E(1)] });
  });
});

describe("what a second reader found", () => {
  const keys = (one: Device) => ({ signIn: one.signIn.key, member: one.member.key });

  test("a birth is whole only with its epoch entry: without it everybody waits, and nobody signs at the place kept for it", async () => {
    const made = await migrated(phone, plan([tablet]));
    const prefix = await replay(made.texts.slice(0, -1));
    expect([prefix.carrying, prefix.epoch]).toEqual([false, 0]);
    expect([devicePlace(prefix, keys(tablet)), devicePlace(prefix, keys(laptop)), devicePlace(made.state, keys(tablet))]).toEqual([{ at: "carried", wait: true }, { at: "absent", wait: true }, { at: "carried", wait: false }]);
    expect(await code(() => signRotation(prefix, tablet, T0 + 60, null))).toBe("run_open");
    expect(joinWord(joinVerdict(prefix, keys(tablet), [pc(1, says([phone, tablet]))], 0))).toBe("run_open");
    const naming = { list: made.list, key: phone.member.key, session: phone.signIn.key };
    expect([pinWord(pinVerdict(prefix, naming, witness([phone]))), pinWord(pinVerdict(made.state, naming, witness([phone])))]).toEqual(["run_open", "pin"]);
  });

  test("only a key that was carried in is a carried device: one that an ordinary entry let in is in, and asks nothing", async () => {
    const made = await migrated(phone, plan([tablet]));
    // The laptop's sign-in key came in by an Allow, with its own card: no `carried` entry names it.
    const allowed = await signListEntry(made.state, {
      kind: "device", key: laptop.signIn.key, power: "bound", role: "drive", until: null, enc: laptop.enc, sealed: null, rotates: false,
      card: await signCard({ key: laptop.signIn.key, enc: laptop.enc, list: made.list, endpoint: null, invite: null }, laptop.signIn.privateKey),
    }, phone.member, T0 + 60);
    expect([listView(allowed.state).devices.find((row) => row.key === laptop.signIn.key)?.carried, devicePlace(allowed.state, keys(laptop)), joinWord(joinVerdict(allowed.state, keys(laptop), [pc(1, says([phone, laptop]))], 0))])
      .toEqual([false, { at: "member" }, "not_carried"]);
  });

  test("a removal against a sign-in key that vouched for a member key keeps that member out after the pin as before it", async () => {
    const made = await migrated(phone, plan([tablet]));
    const rotated = await signRotation(made.state, tablet, T0 + 60, null);
    const tabletNow = await signedInAgain(tablet);
    const word = await signVouch(rotated.state, tabletNow);
    const vouched = await heldVouches(ACCOUNT, made.list, word === null ? [] : [word]);
    // The PC revoked the tablet's new sign-in. Before the pin the tablet names nothing; after it, its member key stays out here.
    const held = { removed: [tabletNow.signIn.key], vouched };
    expect(pinWord(pinVerdict(rotated.state, await named(rotated.state, tabletNow, tabletNow.signIn.key), witness([phone, tabletNow], held)))).toBe("removed");
    expect([heldOut(rotated.state, held, tablet.member.key), heldOut(rotated.state, held, tablet.signIn.key), heldOut(rotated.state, held, phone.member.key), heldOut(rotated.state, { removed: held.removed, vouched: [] }, tablet.member.key)])
      .toEqual([true, true, false, false]);
  });

  test("a device asks about every key the first device has been in by, as a PC does", async () => {
    const made = await migrated(phone, plan([tablet]));
    // The phone hands its place on a second time, to a new account key.
    const next = await signer();
    const again = await signListEntry(made.state, {
      kind: "device", key: next.key, power: "full", role: "drive", until: null, enc: phone.enc, sealed: null, rotates: true,
      card: await signCard({ key: next.key, enc: phone.enc, list: made.list, endpoint: null, invite: null }, next.privateKey),
    }, phone.member, T0 + 60);
    const asked = [pc(1, says([phone, tablet], { removed: [next.key] }))];
    expect(joinVerdict(again.state, keys(tablet), asked, 0)).toMatchObject({ why: "first_signer_removed", pcs: [E(1)] });
    expect(pinWord(pinVerdict(again.state, await named(again.state, { ...tablet, member: tablet.signIn }, tablet.signIn.key), witness([phone, tablet], { removed: [next.key] })))).toBe("first_signer_removed");
  });

  test("a PC that answers for another account is no PC of this one: it is carried nowhere", () => {
    const start = started(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, says([], { account: "TEST-ONLY-other" }), { how: "paired" })]), 0));
    expect([start.pcs.map((row) => row.endpoint), start.left.pcs]).toEqual([[E(1)], [{ endpoint: E(2), why: "other_account" }]]);
  });

  test("the device's own encryption key is its own too: it is carried in as nobody", async () => {
    const sealed = sealer();
    expect(await code(() => signMigration(ACCOUNT, { devices: [{ key: phone.enc, names: null }], pcs: [] }, phone, T0, sealed.seals))).toBe("key_invalid");
    expect(sealed.keys.size).toBe(0);
  });
});

describe("a vouch is the word of both keys", () => {
  test("a sign-in key this PC put out cannot hang its removal on somebody else's member key", async () => {
    const made = await migrated(phone, plan([tablet]));
    // The stranger's sign-in key is one this PC holds a removal against. Alone, it signs that the phone's member key is its own.
    const bytes = linkBytes({ account: ACCOUNT, list: made.list, key: phone.member.key, device: stranger.signIn.key });
    const alone = toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, stranger.signIn.privateKey, new Uint8Array(bytes))));
    const forged = [
      { key: phone.member.key, device: stranger.signIn.key, link: { device: alone } },
      { key: phone.member.key, device: stranger.signIn.key, link: { device: alone, member: alone } },
      { key: phone.member.key, device: stranger.signIn.key, link: { device: alone, member: 5 } },
      { key: phone.member.key, device: stranger.signIn.key, link: alone },
    ] as unknown as SignedVouch[];
    const vouched = await heldVouches(ACCOUNT, made.list, forged);
    expect(vouched).toEqual([]);
    // So the phone still names its list there, it is still the first signer the PC knows, and it is not held out after the pin.
    const held = witness([phone, tablet], { removed: [stranger.signIn.key], vouched });
    expect(pinWord(pinVerdict(made.state, await named(made.state, phone, phone.signIn.key), held))).toBe("pin");
    expect(pinWord(pinVerdict(made.state, await named(made.state, { ...tablet, member: tablet.signIn }, tablet.signIn.key), held))).toBe("pin");
    expect(heldOut(made.state, held, phone.member.key)).toBe(false);
    // A device's own vouch carries the member key's signature too, over the same bytes.
    const now = await signedInAgain(phone);
    const own = await signVouch(made.state, now);
    if (own === null) throw new Error("no vouch");
    const [both, onlyDevice, onlyMember] = [own, { ...own, link: { device: own.link.device, member: own.link.device } }, { ...own, link: { device: own.link.member, member: own.link.member } }];
    expect([own.link.device === own.link.member, (await heldVouches(ACCOUNT, made.list, [both])).length, (await heldVouches(ACCOUNT, made.list, [onlyDevice])).length, (await heldVouches(ACCOUNT, made.list, [onlyMember])).length])
      .toEqual([false, 1, 0, 0]);
  });
});

describe("the vectors of migrate/", () => {
  const DIR = joinPath(import.meta.dir, "account-list-vectors", "migrate");
  interface Vector {
    readonly name: string;
    readonly keys: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
    readonly pc?: { readonly entries: readonly string[]; readonly endpoint: string; readonly session: string; readonly naming: SignedNaming; readonly vouches: readonly SignedVouch[]; readonly witness: Omit<PcWitness, "vouched">; readonly expect: PinVerdict };
    readonly device?: { readonly known: MigrationKnown; readonly tried: number; readonly expect: MigrationStart };
    readonly join?: { readonly entries: readonly string[]; readonly keys: { readonly signIn: string; readonly member: string }; readonly pcs: readonly KnownPc[]; readonly tried: number; readonly expect: JoinVerdict };
  }
  const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(joinPath(DIR, file), "utf8")) as Vector);
  const state = async (entries: readonly string[]) => {
    const replayed = await replayList(entries, LIST_LEVEL, { saved: null });
    if (replayed.member === null) throw new Error("the vector's list does not replay");
    return replayed.member.state;
  };

  test("there is a vector for each answer a PC, a first device and a carried device can give", () => {
    const of = (words: readonly string[]) => new Set(words);
    const pcs = of(vectors.flatMap((vector) => (vector.pc === undefined ? [] : [pinWord(vector.pc.expect)])));
    expect(["pin", "other_account", "other_list", "carried_off_curve", "removed", "session_unknown", "session_new", "not_member", "session_other_device", "first_signer_removed", "first_signer_unknown", "first_signer_new", "run_open"]
      .filter((word) => !pcs.has(word))).toEqual([]);
    const starts = of(vectors.flatMap((vector) => (vector.device === undefined ? [] : [vector.device.expect.start ? "start" : vector.device.expect.why])));
    expect(["start", "self_unlisted", "self_removed", "no_witness", "pcs_silent", "self_unwitnessed", "too_new"].filter((word) => !starts.has(word))).toEqual([]);
    const joins = of(vectors.flatMap((vector) => (vector.join === undefined ? [] : [joinWord(vector.join.expect)])));
    expect(["pin", "run_open", "carried_off_curve", "not_carried", "no_answer", "pcs_silent", "other_list", "first_signer_removed", "first_signer_unknown", "first_signer_new"].filter((word) => !joins.has(word))).toEqual([]);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(`migrate/${vector.name}`, async () => {
      if (vector.pc !== undefined) {
        const held = await heldNaming(vector.pc.witness.account, vector.pc.endpoint, vector.pc.session, vector.pc.naming);
        if (held === null) throw new Error("the vector's naming does not hold");
        const listed = await state(vector.pc.entries);
        const vouched = await heldVouches(vector.pc.witness.account, listed.list, vector.pc.vouches);
        expect(vouched.length).toBe(vector.pc.vouches.length);
        expect(pinVerdict(listed, held, { ...vector.pc.witness, vouched })).toEqual(vector.pc.expect);
      }
      if (vector.device !== undefined) expect(migrationPlan(vector.device.known, vector.device.tried)).toEqual(vector.device.expect);
      if (vector.join !== undefined) expect(joinVerdict(await state(vector.join.entries), vector.join.keys, vector.join.pcs, vector.join.tried)).toEqual(vector.join.expect);
    });
  }
});
