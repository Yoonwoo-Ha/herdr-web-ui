import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { entryFromText, entryHash, entryToText, signEntry, type EntryBody, type SignerPower } from "./account-list-entry.ts";
import {
  ATTEMPT_ENTRIES_MAX, DEVICE_READ_SECONDS, FRESH_SECONDS, LIST_ENTRIES_MAX, LIST_SAVE_PREFIX, LOOSE_ENTRIES_MAX, READ_PAGES_MAX, PAGE_ENTRIES_MAX, PC_BUSY_READ_SECONDS, PC_READ_SECONDS, SESSION_WAIT_SECONDS,
  admitsSession, admittedDevices, compareHeads, followStep, gossipHead, heardHead, listCopy, memberClock, nextUntil, pcOfKey, pinList, readSave, servePage, shownDevices, shownPcs, standing, startRead, takePage, withClock, writeSave,
  type FollowRead, type FollowVerdict, type FollowerCopy, type FollowerSelf, type ListChanges, type ListHint, type ListPage, type ListPin, type PageResult,
} from "./account-list-follower.ts";
import { signingPlace, type ListPlace } from "./account-list-signers.ts";
import { kindBody, replayList, signCard, type EntryPlace, type ListKind, type ListRole, type ListState } from "./account-list.ts";
import { toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const T0 = 1767225600;
/** The members' clock in these tests: a day after the first entry. */
const NOW = T0 + 86400;
const ACCOUNT = "TEST-ONLY-account";

interface Key { readonly name: string; readonly key: string; readonly enc: string; readonly pair: CryptoKeyPair }
const spki = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
const named = new Map<string, string>();
async function newKey(name: string): Promise<Key> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const key = await spki(pair.publicKey);
  named.set(key, name);
  return { name, key, enc: await spki((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])).publicKey), pair };
}
/** The first device, two more, a browser on a borrowed computer, two PCs that a person adds, an invite and the PC that joins with it, and two keys that no member ever adds: a lying service's own. */
const owner = await newKey("owner");
const phone = await newKey("phone");
const tablet = await newKey("tablet");
const browser = await newKey("browser");
const desk = await newKey("desk");
const tower = await newKey("tower");
const pool = await newKey("pool");
const box = await newKey("box");
const mallory = await newKey("mallory");
const eve = await newKey("eve");
/** Keys made as a test asks for them: devices that come and go. */
const spare: Key[] = [];
const spareKey = async (index: number): Promise<Key> => {
  while (spare.length <= index) spare.push(await newKey(`spare${spare.length}`));
  return at(spare, index);
};
/** A PC's relay key. */
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};
const who = (key: string): string => named.get(key) ?? "?";

/** A log: the texts of its entries from entry 0. Never changed: an entry added gives another log, so two logs may share a start and part. */
interface Log { readonly list: string; readonly texts: readonly string[]; readonly hashes: readonly string[] }
type Maker = (place: EntryPlace) => ListKind | Promise<ListKind>;
async function signed(log: Log | null, by: Key, body: EntryBody): Promise<Log> {
  const entry = await signEntry(body, by.pair.privateKey);
  const hash = entryHash(entry.body);
  return { list: log?.list ?? hash, texts: [...(log?.texts ?? []), entryToText(entry)], hashes: [...(log?.hashes ?? []), hash] };
}
const placeOf = (log: Log | null, by: Key): EntryPlace =>
  ({ issued_at: T0 + 60 * (log?.texts.length ?? 0), list: log?.list ?? "", prev: log?.hashes.at(-1) ?? "", seq: log?.texts.length ?? 0, signer: by.key });
async function start(by: Key = owner, account = ACCOUNT): Promise<Log> {
  const place = placeOf(null, by);
  return signed(null, by, kindBody(place, { kind: "genesis", account, enc: by.enc, opens: "0a".repeat(32), sealed: null }));
}
/** The log with one more entry, signed by `by` on its last one; `issued_at` is the hour its signer writes into it, where a test says one. */
async function add(log: Log, by: Key, maker: Maker, issued_at?: number): Promise<Log> {
  const place = { ...placeOf(log, by), ...(issued_at === undefined ? {} : { issued_at }) };
  return signed(log, by, kindBody(place, await maker(place)));
}
/** The same with any body: an entry of no kind a build of level 1 reads. */
async function addRaw(log: Log, by: Key, raw: Pick<EntryBody, "kind" | "v"> & Partial<Pick<EntryBody, "adds" | "ends">>): Promise<Log> {
  return signed(log, by, { ...placeOf(log, by), own: [], ...raw });
}
async function grow(log: Log, steps: readonly (readonly [Key, Maker])[]): Promise<Log> {
  let grown = log;
  for (const [by, maker] of steps) grown = await add(grown, by, maker);
  return grown;
}

const deviceOf = (key: Key, power: SignerPower = "full", role: ListRole = "drive", until: number | null = null): Maker => async (place) => ({
  kind: "device", key: key.key, power, role, until, enc: key.enc, sealed: null, rotates: false,
  card: await signCard({ key: key.key, enc: key.enc, list: place.list, endpoint: null, invite: null }, key.pair.privateKey),
});
const pcOf = (key: Key, n: number): Maker => async (place) => ({
  kind: "pc", key: key.key, endpoint: E(n), enc: key.enc, sealed: null,
  card: await signCard({ key: key.key, enc: key.enc, list: place.list, endpoint: E(n), invite: null }, key.pair.privateKey),
});
const inviteOf = (key: Key, uses = 3): Maker => (place) => ({ kind: "invite", key: key.key, exp: place.issued_at + 3600, uses, auto: true, sealed: null });
const joinOf = (key: Key, n: number, invite: Key): Maker => async (place) => ({
  kind: "join", endpoint: E(n), pc: key.key, enc: key.enc, sealed: null,
  card: await signCard({ key: key.key, enc: key.enc, list: place.list, endpoint: E(n), invite: invite.key }, key.pair.privateKey),
});
const removeOf = (key: Key): Maker => () => ({ kind: "remove", ends: key.key });
const removePcOf = (n: number): Maker => () => ({ kind: "remove", endpoint: E(n) });
const carriedOf = (key: Key): Maker => () => ({ kind: "carried", key: key.key, role: "drive", sealed: null });
const carriedPcOf = (n: number): Maker => () => ({ kind: "carried", endpoint: E(n), sealed: null });
const epochOf = (current: number): Maker => () => ({ kind: "epoch", epoch: current, opens: "0b".repeat(32), link: new Uint8Array(61) });

const headOf = (log: Log): ListPlace => ({ seq: log.texts.length - 1, hash: at(log.hashes, log.texts.length - 1) });
/** The log cut after entry `seq`. */
const upTo = (log: Log, seq: number): Log => ({ list: log.list, texts: log.texts.slice(0, seq + 1), hashes: log.hashes.slice(0, seq + 1) });
/** An honest answer of a service that holds `log`: the entries after the place asked, at most `limit`, and its head. */
const pageOf = (log: Log, after: number | null, limit = PAGE_ENTRIES_MAX): ListPage => {
  const from = after === null ? 0 : after + 1;
  return { list: log.list, after, entries: log.texts.slice(from, from + limit), head: headOf(log) };
};
const serves = (log: Log, limit = PAGE_ENTRIES_MAX) => (read: FollowRead): ListPage => pageOf(log, read.after, limit);

const DEVICE = (key: Key): FollowerSelf => ({ key: key.key, endpoint: null });
const PC = (key: Key, n: number): FollowerSelf => ({ key: key.key, endpoint: E(n) });
function pinned(log: Pick<Log, "list">, me: FollowerSelf, pin: ListPin, account = ACCOUNT): FollowerCopy {
  const made = pinList(null, { account, list: log.list, me, pin });
  if (!made.pinned) throw new Error(`not pinned: ${made.why}`);
  return made.copy;
}
/** The pin of a device that the member holding `log` allowed: that member's head. */
const allowedAt = (log: Log, seq = log.texts.length - 1): ListPin => ({ how: "allowed", seq, hash: at(log.hashes, seq) });

interface Read { readonly copy: FollowerCopy; readonly verdicts: readonly FollowVerdict[]; readonly last: PageResult; readonly changes: readonly ListChanges[]; readonly pages: number }
/** One read, to its end: each request is the one the page before asked for, from `first` or from the member's head. A read that does not end fails the test. */
async function reads(copy: FollowerCopy, answer: (read: FollowRead) => ListPage | null, source: "service" | "peer" = "service", now = NOW, first: FollowRead = startRead(copy, source)): Promise<Read> {
  let held = copy;
  let read: FollowRead | null = first;
  const verdicts: FollowVerdict[] = [];
  const changes: ListChanges[] = [];
  let last: PageResult | null = null;
  let pages = 0;
  while (read !== null) {
    if (++pages > READ_PAGES_MAX) throw new Error("the read does not end");
    const page = answer(read);
    if (page === null) throw new Error("no page");
    last = await takePage(held, read, page, now);
    // Nothing a page says changes what the member is pinned to.
    expect([last.copy.list, last.copy.account, last.copy.me, last.copy.pin]).toEqual([copy.list, copy.account, copy.me, copy.pin]);
    // Whatever copy a page gives, the member can save it and read it again as it is.
    const again = await readSave(writeSave(last.copy));
    expect(again.read ? { read: true, rebuilt: again.rebuilt, same: writeSave(again.copy) === writeSave(last.copy) } : again).toEqual({ read: true, rebuilt: false, same: true });
    held = last.copy;
    verdicts.push(last.verdict);
    changes.push(last.changes);
    read = last.read;
  }
  if (last === null) throw new Error("no page was read");
  return { copy: held, verdicts, last, changes, pages };
}
const lastOf = (read: Read): FollowVerdict => at(read.verdicts, read.verdicts.length - 1);
/** A member that has read the whole of an honest log. */
async function followed(log: Log, me: FollowerSelf, pin: ListPin, now = NOW): Promise<FollowerCopy> {
  const read = await reads(pinned(log, me, pin), serves(log), "service", now);
  expect(lastOf(read)).toBe("caught_up");
  return read.copy;
}
/** Two members meet: each compares the other's head, asks what the verdict says, and takes the answer; again until neither asks. */
async function gossip(a: FollowerCopy, b: FollowerCopy, limit = PAGE_ENTRIES_MAX): Promise<{ readonly a: FollowerCopy; readonly b: FollowerCopy; readonly said: readonly string[] }> {
  let [left, right] = [a, b];
  const said: string[] = [];
  for (let round = 0; round < 4; round++) {
    const before = [writeSave(left), writeSave(right)];
    const mine = compareHeads(left, gossipHead(right));
    if (mine.read !== null) {
      const from = right;
      const read = await reads(left, (ask) => servePage(from, ask, limit), "peer", NOW, mine.read);
      left = read.copy;
      said.push(`a ${mine.verdict} ${lastOf(read)}`);
    }
    const theirs = compareHeads(right, gossipHead(left));
    if (theirs.read !== null) {
      const from = left;
      const read = await reads(right, (ask) => servePage(from, ask, limit), "peer", NOW, theirs.read);
      right = read.copy;
      said.push(`b ${theirs.verdict} ${lastOf(read)}`);
    }
    if (writeSave(left) === before[0] && writeSave(right) === before[1]) break;
  }
  return { a: left, b: right, said };
}
const stateOf = (copy: FollowerCopy): ListState => {
  if (copy.state === null) throw new Error("the copy holds no entry");
  return copy.state;
};
const footingOf = (copy: FollowerCopy): ListPlace => stateOf(copy).footing;
/** A copy as its save reads it again: every test that saves goes on with what was read. */
async function saved(copy: FollowerCopy): Promise<FollowerCopy> {
  const read = await readSave(writeSave(copy));
  if (!read.read) throw new Error(`the save does not read: ${read.why}`);
  expect([read.copy, read.rebuilt]).toEqual([copy, false]);
  return read.copy;
}
const opens = (copy: FollowerCopy, key: Key, now = NOW): string => {
  const said = admitsSession(copy, key.key, now);
  return said.role ?? said.why;
};
/** The same text with one character of it changed to another of the alphabet. */
const flipped = (text: string, index: number): string => `${text.slice(0, index)}${text[index] === "A" ? "B" : "A"}${text.slice(index + 1)}`;

/** The account's list as most tests begin: the owner, a phone, the desk PC, an invite and the box that joined with it. */
const BASE = await grow(await start(), [[owner, deviceOf(phone)], [owner, pcOf(desk, 1)], [phone, inviteOf(pool)], [pool, joinOf(box, 2, pool)]]);
/** Another account's list, by a service's own key. */
const OTHER = await grow(await start(mallory, "TEST-ONLY-other"), [[mallory, deviceOf(eve)]]);

describe("a pin", () => {
  test("is made once, for one list id, by a member that says where the id came from", () => {
    const given = { account: ACCOUNT, list: BASE.list, me: DEVICE(phone), pin: { how: "carried" } as ListPin };
    const made = pinList(null, given);
    expect(made).toEqual({ pinned: true, copy: { account: ACCOUNT, list: BASE.list, me: DEVICE(phone), pin: { how: "carried" }, entries: [], state: null, stop: null, read_at: null, seen_at: null, alarm: null } });
    // A member that holds a copy is pinned, to the same list or to another, read or not.
    if (!made.pinned) throw new Error("not pinned");
    expect(pinList(made.copy, given)).toEqual({ pinned: false, why: "pinned" });
    expect(pinList(made.copy, { ...given, list: OTHER.list })).toEqual({ pinned: false, why: "pinned" });
  });

  test("a device's is genesis, allowed or carried, and a PC's added or migrated; anything out of form is refused", () => {
    const base = { account: ACCOUNT, list: BASE.list };
    const takes = (me: FollowerSelf, pin: unknown, more: object = {}) => pinList(null, { ...base, me, pin: pin as ListPin, ...more }).pinned;
    for (const pin of [{ how: "genesis" }, { how: "carried" }, { how: "allowed", seq: 3, hash: BASE.list }]) {
      expect({ pin, device: takes(DEVICE(phone), pin), pc: takes(PC(desk, 1), pin) }).toEqual({ pin, device: true, pc: false });
    }
    for (const pin of [{ how: "added" }, { how: "migrated", admitted: [owner.key] }, { how: "migrated", admitted: [] }]) {
      expect({ pin, device: takes(DEVICE(phone), pin), pc: takes(PC(desk, 1), pin) }).toEqual({ pin, device: false, pc: true });
    }
    for (const pin of [null, {}, { how: "other" }, { how: "genesis", seq: 1 }, { how: "allowed", seq: 0, hash: BASE.list }, { how: "allowed", seq: 1, hash: "x" }, { how: "allowed", seq: 1.5, hash: BASE.list }]) {
      expect({ pin, takes: takes(DEVICE(phone), pin) }).toEqual({ pin, takes: false });
    }
    for (const pin of [{ how: "migrated" }, { how: "migrated", admitted: ["x"] }, { how: "migrated", admitted: [owner.key, owner.key] }, { how: "added", admitted: [] }]) {
      expect({ pin, takes: takes(PC(desk, 1), pin) }).toEqual({ pin, takes: false });
    }
    expect(takes(DEVICE(phone), { how: "carried" }, { account: "" })).toBe(false);
    expect(takes(DEVICE(phone), { how: "carried" }, { list: "0".repeat(63) })).toBe(false);
    expect(takes({ key: "x", endpoint: null }, { how: "carried" })).toBe(false);
    expect(takes({ key: desk.key, endpoint: "X".repeat(64) }, { how: "added" })).toBe(false);
    // The keys a PC let in before are kept in one order.
    const made = pinList(null, { ...base, me: PC(desk, 1), pin: { how: "migrated", admitted: [phone.key, owner.key].sort().reverse() } });
    expect(made.pinned && made.copy.pin).toEqual({ how: "migrated", admitted: [phone.key, owner.key].sort() });
  });

  test("the device that made entry 0 is in once the log shows its own genesis, and takes no other list's entry 0 for it", async () => {
    const log = await start();
    const copy = await followed(log, DEVICE(owner), { how: "genesis" });
    expect([standing(copy), copy.entries, opens(copy, owner)]).toEqual(["in", log.texts, "drive"]);
    // Entry 0 of the list it is pinned to, made by another key than its own: not the list it started.
    const others = await reads(pinned(log, DEVICE(phone), { how: "genesis" }), serves(log));
    expect([lastOf(others), standing(others.copy), others.copy.entries]).toEqual(["not_my_list", "waiting", []]);
  });

  test("a device that was allowed is in only when the log reaches the head it was handed and shows its own entry", async () => {
    const log = await add(BASE, owner, deviceOf(tablet));
    const longer = await add(log, owner, epochOf(0));
    const copy = pinned(log, DEVICE(tablet), allowedAt(log));
    expect(standing(copy)).toBe("waiting");
    // A service that shows the log without the entry that lets it in: an old part, and not a full read.
    const early = await reads(copy, serves(BASE));
    expect([lastOf(early), standing(early.copy), early.copy.read_at, shownPcs(early.copy)]).toEqual(["older", "waiting", null, []]);
    const there = await reads(early.copy, serves(longer));
    expect([lastOf(there), standing(there.copy), there.copy.read_at, shownPcs(there.copy).map((row) => row.endpoint)]).toEqual(["caught_up", "in", NOW, [E(1), E(2)]]);
  });

  test("a device that was allowed takes at the place of that head no other entry: it stays before it, and takes the right one later", async () => {
    const log = await add(BASE, owner, deviceOf(tablet));
    // The service shows another entry in that place, signed by a member all the same.
    const other = await add(BASE, phone, deviceOf(tablet, "bound", "watch"));
    const copy = pinned(log, DEVICE(tablet), allowedAt(log));
    for (const limit of [1, 2, PAGE_ENTRIES_MAX]) {
      const wrong = await reads(copy, serves(await add(other, phone, epochOf(0)), limit));
      expect({ limit, verdict: lastOf(wrong), at: wrong.last.at, entries: wrong.copy.entries, standing: standing(wrong.copy) }).toEqual({ limit, verdict: "stuck", at: 5, entries: BASE.texts, standing: "waiting" });
      const right = await reads(wrong.copy, serves(log));
      expect({ limit, verdict: lastOf(right), standing: standing(right.copy), role: opens(right.copy, tablet) }).toEqual({ limit, verdict: "caught_up", standing: "in", role: "drive" });
    }
  });

  test("a PC that a person or an invite adds is in when the list shows its relay key with its own key, and out when an entry puts it out", async () => {
    const before = upTo(BASE, 1);
    const waiting = await followed(before, PC(desk, 1), { how: "added" });
    // The list id is the one a person confirmed at the PC, and still it lets nobody in before it is in itself.
    expect([standing(waiting), opens(waiting, owner), pcOfKey(waiting, desk.key)]).toEqual(["waiting", "waiting", null]);
    const added = await reads(waiting, serves(BASE));
    expect([standing(added.copy), opens(added.copy, owner), opens(added.copy, phone)]).toEqual(["in", "drive", "drive"]);
    // From then on it lets in everybody the list holds: all of them are told, not only who came on that page.
    expect(added.changes.map((item) => [item.devices.added.map((row) => who(row.key)), item.pcs.added.map((row) => row.endpoint)])).toEqual([[["owner", "phone"], [E(1), E(2)]]]);
    // The same relay key with another PC's key is not this PC.
    const taken = await followed(await add(before, owner, pcOf(tower, 1)), PC(desk, 1), { how: "added" });
    expect([standing(taken), opens(taken, owner)]).toEqual(["waiting", "waiting"]);
    const joined = await followed(BASE, PC(box, 2), { how: "added" });
    expect([standing(joined), opens(joined, phone)]).toEqual(["in", "drive"]);
    const removed = await reads(joined, serves(await add(BASE, owner, removePcOf(2))));
    expect([lastOf(removed), standing(removed.copy), opens(removed.copy, phone), shownPcs(removed.copy)]).toEqual(["caught_up", "out", "out", []]);
    // A PC that is out lets nobody in and shows no PC: everybody it held is told as gone, each as the list holds it now.
    expect([removed.last.changes.pcs.removed.map((row) => [row.endpoint, row.removed]), removed.last.changes.devices.removed.map((row) => who(row.key))]).toEqual([[[E(1), null], [E(2), 5]], ["owner", "phone"]]);
    const gone = await reads(added.copy, serves(await add(BASE, phone, removeOf(desk))));
    expect([standing(gone.copy), opens(gone.copy, owner)]).toEqual(["out", "out"]);
  });

  test("a PC that was in the account before the list follows a list only when it had let in the first signer and every device the list carries in, all or none", async () => {
    const log = await grow(await start(), [[owner, carriedOf(phone)], [owner, carriedOf(tablet)], [owner, carriedPcOf(1)], [owner, deviceOf(browser)]]);
    const me = PC(desk, 1);
    // A list started by a key the PC never let in: a breached service's own genesis.
    const forged = await grow(await start(mallory), [[mallory, carriedOf(phone)], [mallory, carriedPcOf(1)]]);
    const refused = await reads(pinned(forged, me, { how: "migrated", admitted: [owner.key, phone.key] }), serves(forged));
    expect([lastOf(refused), standing(refused.copy), refused.copy.entries, opens(refused.copy, phone)]).toEqual(["not_my_list", "waiting", [], "waiting"]);
    const copy = await followed(log, me, { how: "migrated", admitted: [owner.key, phone.key, tablet.key].sort() });
    // It lets in whom it held, and a device that a member added since: the browser was never carried.
    expect([standing(copy), opens(copy, owner), opens(copy, phone), opens(copy, tablet), opens(copy, browser)]).toEqual(["in", "drive", "drive", "drive", "drive"]);
    // The tablet was carried in and this PC never let it in. A carried key is a full signer: the PC follows none of that list, wherever the pages were cut.
    for (const limit of [1, 2, PAGE_ENTRIES_MAX]) {
      const strange = await reads(pinned(log, me, { how: "migrated", admitted: [owner.key, phone.key].sort() }), serves(log, limit));
      expect({ limit, last: lastOf(strange), standing: standing(strange.copy), opens: [opens(strange.copy, owner), opens(strange.copy, phone), opens(strange.copy, tablet)], rows: admittedDevices(strange.copy, NOW) })
        .toEqual({ limit, last: "caught_up", standing: "waiting", opens: ["waiting", "waiting", "waiting"], rows: [] });
    }
    // It follows before the list names it, and is out once an entry puts its relay key out.
    const unnamed = await followed(upTo(log, 2), me, { how: "migrated", admitted: [owner.key, phone.key, tablet.key].sort() });
    expect([standing(unnamed), opens(unnamed, owner)]).toEqual(["in", "drive"]);
    const out = await reads(copy, serves(await add(log, owner, removePcOf(1))));
    expect([standing(out.copy), opens(out.copy, owner)]).toEqual(["out", "out"]);
    // A device that was carried in is in when the list shows it so.
    const carried = await followed(log, DEVICE(phone), { how: "carried" });
    expect(standing(carried)).toBe("in");
    expect(standing(await followed(log, DEVICE(browser), { how: "carried" }))).toBe("waiting");
  });

  test("another account's list, another list's entry 0, and a page that names another list are not the member's list", async () => {
    const mine = await followed(BASE, DEVICE(phone), { how: "carried" });
    const cases: readonly (readonly [string, FollowerCopy, ListPage])[] = [
      ["a page that names another list", mine, pageOf(OTHER, 4)],
      ["another list's entry 0 under this list's id", pinned(BASE, DEVICE(phone), { how: "carried" }), { ...pageOf(OTHER, null), list: BASE.list }],
      ["another list's entry 0 for a member that holds its own", mine, { ...pageOf(OTHER, null), list: BASE.list }],
      ["the list of another account", pinned(BASE, DEVICE(phone), { how: "carried" }, "TEST-ONLY-third"), pageOf(BASE, null)],
    ];
    for (const [name, copy, page] of cases) {
      const read = startRead(copy, "service");
      const taken = await takePage(copy, { ...read, after: page.after ?? null }, page, NOW);
      expect({ name, verdict: taken.verdict, copy: taken.copy }).toEqual({ name, verdict: "not_my_list", copy: { ...copy, seen_at: NOW } });
    }
    // Another list's entry after the member's own does not continue it: refused like any entry that does not hold.
    const foreign = await takePage(mine, startRead(mine, "service"), { ...pageOf(BASE, 4), entries: OTHER.texts.slice(1), head: { seq: 5, hash: at(OTHER.hashes, 1) } }, NOW);
    expect([foreign.verdict, foreign.code, foreign.at, foreign.copy]).toEqual(["refused", "chain_broken", 5, mine]);
  });
});

describe("taking pages", () => {
  const LONG = (async () => grow(BASE, [[owner, deviceOf(tablet, "bound", "watch")], [desk, deviceOf(browser, "bound", "drive", NOW + 3600)], [phone, removeOf(tablet)], [owner, epochOf(0)], [desk, removePcOf(2)], [browser, removeOf(browser)]]))();

  test("what a member holds never depends on where the pages were cut, and neither does who came and went in the end", async () => {
    const log = await LONG;
    const whole = await followed(log, PC(desk, 1), { how: "added" });
    expect(listCopy(whole)?.state).toEqual((await replayList(log.texts, 1, { saved: null })).member?.state as ListState);
    for (let limit = 1; limit <= log.texts.length; limit++) {
      const read = await reads(pinned(log, PC(desk, 1), { how: "added" }), serves(log, limit));
      expect({ limit, verdicts: [...new Set(read.verdicts.slice(0, -1))], last: lastOf(read), pages: read.pages }).toEqual({ limit, verdicts: limit < log.texts.length ? ["more"] : [], last: "caught_up", pages: Math.ceil(log.texts.length / limit) });
      expect({ limit, copy: read.copy }).toEqual({ limit, copy: whole });
      // Whoever is in at the end came in once, and whoever is out went out at most once.
      const came = read.changes.flatMap((item) => item.devices.added.map((row) => who(row.key)));
      const went = read.changes.flatMap((item) => item.devices.removed.map((row) => who(row.key)));
      expect({ limit, in: came.filter((name) => !went.includes(name)).sort() }).toEqual({ limit, in: ["owner", "phone"] });
      expect({ limit, twice: went.length !== new Set(went).size || came.length !== new Set(came).size }).toEqual({ limit, twice: false });
    }
    // The same for a member that already holds a part, asked from any place it holds.
    for (let held = 0; held < log.texts.length; held++) {
      const part = await followed(upTo(log, held), DEVICE(owner), { how: "genesis" });
      for (let after = 0; after <= held; after++) {
        const taken = await takePage(part, { ...startRead(part, "service"), after }, pageOf(log, after), NOW);
        expect({ held, after, verdict: taken.verdict, entries: taken.copy.entries, state: taken.copy.state }).toEqual({ held, after, verdict: "caught_up", entries: log.texts, state: whole.state });
      }
    }
  });

  test("a page that claims a head it does not reach is not caught up, whatever the head says", async () => {
    const log = await LONG;
    const part = upTo(log, 6);
    const fresh = pinned(log, DEVICE(owner), { how: "genesis" });
    // A head past the entries: the member asks on while it is shown something, and then waits. A head that the entries reach and that is not the entry there: another history.
    const heads: readonly (readonly [ListPlace, FollowVerdict])[] = [[{ seq: 10, hash: at(log.hashes, 10) }, "withheld"], [{ seq: 400, hash: "ab".repeat(32) }, "withheld"], [{ seq: 8, hash: at(log.hashes, 6) }, "withheld"],
      [{ seq: 6, hash: "ab".repeat(32) }, "stuck"], [{ seq: 6, hash: at(log.hashes, 5) }, "stuck"], [{ seq: 2, hash: at(log.hashes, 5) }, "stuck"]];
    for (const [head, last] of heads) {
      for (const limit of [1, 3, PAGE_ENTRIES_MAX]) {
        const read = await reads(fresh, (ask) => ({ ...pageOf(part, ask.after, limit), head }));
        expect({ head, limit, caught: read.verdicts.includes("caught_up"), last: lastOf(read), read_at: read.copy.read_at, alarm: read.copy.alarm }).toEqual({ head, limit, caught: false, last, read_at: null, alarm: null });
        // It took every entry it was shown before the head said otherwise.
        expect({ head, limit, entries: read.copy.entries }).toEqual({ head, limit, entries: part.texts.slice(0, read.copy.entries.length) });
        expect({ head, limit, held: read.copy.entries.length > Math.min(head.seq, 6) - (last === "stuck" ? 1 : 0) }).toEqual({ head, limit, held: true });
      }
    }
    // An empty answer for a member that holds nothing, and one for a member that holds a part.
    expect((await reads(fresh, () => ({ entries: [], head: headOf(log) }))).verdicts).toEqual(["withheld"]);
    const held = await followed(part, DEVICE(owner), { how: "genesis" });
    expect((await reads(held, () => ({ entries: [], head: headOf(log) }))).verdicts).toEqual(["withheld"]);
  });

  test("an old part of the log served again changes nothing: a removal that was seen is not undone, and the read is not a full one", async () => {
    const log = await LONG;
    const copy = await followed(log, PC(desk, 1), { how: "added" }, NOW - 500);
    expect([opens(copy, tablet), opens(copy, browser), copy.read_at]).toEqual(["removed", "removed", NOW - 500]);
    for (let seq = 0; seq < log.texts.length - 1; seq++) {
      // The service answers as if the log ended at an earlier place: from the place asked, and from entry 0.
      const old = upTo(log, seq);
      for (const after of [log.texts.length - 1, null]) {
        const taken = await takePage(copy, { ...startRead(copy, "service"), after }, pageOf(old, after), NOW);
        // Nothing of the copy moves but the hour its clock showed.
        expect({ seq, after, verdict: taken.verdict, copy: taken.copy, read: taken.read }).toEqual({ seq, after, verdict: "older", copy: { ...copy, seen_at: NOW }, read: null });
      }
      expect({ seq, heard: heardHead(copy, { list: log.list, head: headOf(old) }, NOW) }).toEqual({ seq, heard: { copy: { ...copy, seen_at: NOW }, verdict: "older" } });
    }
    const again = await reads(copy, serves(log));
    expect([lastOf(again), again.copy.read_at]).toEqual(["caught_up", NOW]);
  });

  test("an entry that a key which is no signer signed adds nobody, and gives way to what a member signs", async () => {
    const copy = await followed(BASE, PC(desk, 1), { how: "added" });
    // The service signs with its own key: a device, a PC, a removal, an invite and a join with it.
    const junk = await grow(BASE, [[mallory, deviceOf(mallory)], [mallory, pcOf(eve, 7)], [mallory, removeOf(phone)], [mallory, inviteOf(eve)], [eve, joinOf(mallory, 8, eve)]]);
    const shown = await reads(copy, serves(junk));
    expect([lastOf(shown), shown.copy.entries.length, shown.copy.state, footingOf(shown.copy)]).toEqual(["caught_up", junk.texts.length, copy.state, headOf(BASE)]);
    expect([opens(shown.copy, mallory), opens(shown.copy, phone), pcOfKey(shown.copy, eve.key), shownPcs(shown.copy).map((row) => row.endpoint)]).toEqual(["never_added", "drive", null, [E(1), E(2)]]);
    expect(shown.last.changes).toEqual({ devices: { added: [], removed: [] }, pcs: { added: [], removed: [] } });
    // It tells a peer nothing of them, and signs on its footing as before.
    expect(gossipHead(shown.copy)).toEqual({ list: BASE.list, place: headOf(BASE) });
    expect(servePage(shown.copy, { list: BASE.list, after: 4 }, 10)?.entries).toEqual([]);
    expect(signingPlace(listCopy(shown.copy) ?? { entries: [], state: stateOf(copy) }, headOf(BASE))).toEqual({ list: BASE.list, prev: headOf(BASE).hash, seq: 5 });
    // What a member then places takes their place: the read goes back to the footing once.
    const honest = await add(BASE, owner, deviceOf(tablet));
    const back = await reads(shown.copy, serves(honest));
    expect([back.verdicts, back.copy.entries, opens(back.copy, tablet)]).toEqual([["asks_after", "caught_up"], honest.texts, "drive"]);
    expect(back.copy).toEqual(await followed(honest, PC(desk, 1), { how: "added" }));
  });

  test("a copy keeps only so many entries that no signer signed, however many it is shown and however the pages are cut", async () => {
    const copy = await followed(BASE, PC(desk, 1), { how: "added" });
    let junk = BASE;
    for (let index = 0; index < LOOSE_ENTRIES_MAX + 9; index++) junk = await add(junk, mallory, epochOf(0));
    for (const limit of [5, PAGE_ENTRIES_MAX]) {
      const shown = await reads(copy, serves(junk, limit));
      expect({ limit, last: lastOf(shown), code: shown.last.code, kept: shown.copy.entries.length - BASE.texts.length, state: shown.copy.state }).toEqual({ limit, last: "refused", code: "loose", kept: LOOSE_ENTRIES_MAX, state: copy.state });
      // Asked again it takes no more of them, and a member's entry still takes their place.
      const again = await reads(shown.copy, serves(junk, limit));
      expect({ limit, last: lastOf(again), copy: again.copy, pages: again.pages }).toEqual({ limit, last: "refused", copy: shown.copy, pages: 1 });
      const honest = await add(BASE, owner, deviceOf(tablet));
      expect((await reads(shown.copy, serves(honest))).copy.entries).toEqual(honest.texts);
    }
  });

  test("a read ends, whatever its pages say: a source that sends it back and forth is seen through, and a read makes a set number of requests at most", async () => {
    const log = await grow(BASE, [[owner, deviceOf(tablet)], [owner, epochOf(0)]]);
    const copy = await followed(upTo(log, 5), PC(desk, 1), { how: "added" });
    // Asked after an entry before its head, the source shows the next entry and says more follows; asked after its head, it says its head is another entry.
    let asked = 0;
    const liar = (read: FollowRead): ListPage => {
      asked++;
      const last = read.after ?? 0;
      return last < 6 ? { entries: [at(log.texts, last + 1)], head: { seq: 60, hash: "ab".repeat(32) } } : { entries: [], head: { seq: 6, hash: "ab".repeat(32) } };
    };
    let held = copy;
    let read: FollowRead | null = startRead(copy, "service");
    const verdicts: FollowVerdict[] = [];
    while (read !== null && asked < 4 * READ_PAGES_MAX) {
      const taken: PageResult = await takePage(held, read, liar(read), NOW);
      [held, read] = [taken.copy, taken.read];
      verdicts.push(taken.verdict);
    }
    // It is seen through after a few requests: what the source said of where the two part came to contradict itself, and a page that narrows nothing ends the search.
    expect([asked <= 6, read, at(verdicts, verdicts.length - 1), held.entries, held.alarm, held.read_at]).toEqual([true, null, "stuck", log.texts.slice(0, 7), null, copy.read_at]);
    // A read that needs more requests than one read makes ends with a verdict of its own, which is no full read, and goes on at the next read from where it came to.
    let long = BASE;
    for (let index = 0; index < READ_PAGES_MAX + 6; index++) long = await add(long, owner, deviceOf(await spareKey(index)));
    const first = await reads(await followed(BASE, PC(desk, 1), { how: "added" }), serves(long, 1));
    expect([first.pages, lastOf(first), first.last.read, first.copy.entries.length, first.copy.read_at]).toEqual([READ_PAGES_MAX, "spent", null, BASE.texts.length + READ_PAGES_MAX, NOW]);
    expect(first.verdicts.slice(0, -1).every((verdict) => verdict === "more")).toBe(true);
    const second = await reads(first.copy, serves(long, 1), "service", NOW + 30);
    expect([second.pages, lastOf(second), second.copy.entries, second.copy.read_at]).toEqual([6, "caught_up", long.texts, NOW + 30]);
    expect(takePage(copy, { ...startRead(copy, "service"), left: -1 }, pageOf(log, 5), NOW)).rejects.toThrow(RangeError);
  });

  test("a page that shows the member's own entries up to a head that is another entry asks nothing more", async () => {
    const copy = await followed(BASE, PC(desk, 1), { how: "added" });
    const junk = await grow(BASE, [[mallory, epochOf(0)], [mallory, epochOf(0)]]);
    const loose = (await reads(copy, serves(junk))).copy;
    // Asked from its footing, the source shows the two loose entries the member holds and names a head at the last of them with another hash.
    const taken = await takePage(loose, { ...startRead(loose, "service"), after: 4 }, { ...pageOf(junk, 4), head: { seq: 6, hash: "ab".repeat(32) } }, NOW + 7);
    expect([taken.verdict, taken.read, taken.copy]).toEqual(["withheld", null, { ...loose, seen_at: NOW + 7 }]);
  });

  test("a second other continuation in one read waits for the next read", async () => {
    const copy = await followed(BASE, PC(desk, 1), { how: "added" });
    const junk = (seed: Key) => grow(BASE, [[seed, epochOf(0)], [seed, epochOf(0)]]);
    const first = await reads(copy, serves(await junk(mallory)));
    const [a, b] = [await junk(eve), await junk(tablet)];
    let asked = 0;
    // The service says its head is another continuation, shows one entry of it, and then an entry of a third.
    const read = await reads(first.copy, (ask) => at([{ ...pageOf(a, ask.after), entries: [] }, pageOf(a, ask.after, 1), pageOf(b, ask.after, 1)], asked++));
    expect([read.verdicts, read.pages, read.copy.entries, read.copy.state]).toEqual([["asks_after", "more", "asks_after"], 3, a.texts.slice(0, 6), copy.state]);
  });

  test("one changed character anywhere in a page lets nobody in whom the log does not, and leaves a copy that an honest answer completes", async () => {
    const log = await LONG;
    const whole = await followed(log, PC(desk, 1), { how: "added" });
    const said = new Map<string, number>();
    for (let held = 0; held < log.texts.length - 1; held += 3) {
      const part = held === 0 ? pinned(log, PC(desk, 1), { how: "added" }) : await followed(upTo(log, held), PC(desk, 1), { how: "added" });
      const page = pageOf(log, part.entries.length === 0 ? null : held);
      for (const [index, text] of page.entries.entries()) {
        for (const place of [0, 30, Math.floor(text.length / 2), text.length - 90, text.length - 40, text.length - 1]) {
          const entries = page.entries.map((entry, other) => (other === index ? flipped(entry, place) : entry));
          const taken = await takePage(part, startRead(part, "service"), { ...page, entries }, NOW);
          const word = `${taken.verdict} ${taken.code ?? ""}`.trim();
          said.set(word, (said.get(word) ?? 0) + 1);
          // It took the entries before the changed one, and nothing from it on.
          const before = (page.after ?? -1) + 1 + index;
          expect({ held, index, place, word, entries: taken.copy.entries, read_at: taken.copy.read_at }).toEqual({ held, index, place, word, entries: log.texts.slice(0, Math.max(before, part.entries.length)), read_at: part.read_at });
          expect({ held, index, place, verdict: word.split(" ")[0] }).toEqual({ held, index, place, verdict: "refused" });
          const healed = await reads(taken.copy, serves(log));
          expect({ held, index, place, copy: healed.copy }).toEqual({ held, index, place, copy: whole });
        }
      }
    }
    expect([...said.keys()].sort()).toEqual(["refused entry_malformed", "refused signature_invalid"]);
  });

  test("a page out of form is refused whole, and a page for a place the member no longer holds shows it nothing", async () => {
    const copy = await followed(BASE, DEVICE(owner), { how: "genesis" });
    const read = startRead(copy, "service");
    const good = pageOf(BASE, 4);
    const bad: readonly unknown[] = [null, [], "page", { ...good, entries: "x" }, { ...good, entries: [1] }, { ...good, head: null }, { ...good, head: { seq: -1, hash: BASE.list } }, { ...good, head: { seq: 1, hash: "x" } },
      { ...good, after: 3 }, { ...good, after: null }, { ...good, after: "4" }, { ...good, after: 1.5 }];
    for (const page of bad) expect({ page, taken: await takePage(copy, read, page as ListPage, NOW) }).toMatchObject({ taken: { verdict: "refused", code: "page_form", copy, read: null } });
    expect(await takePage(copy, { ...read, after: 9 }, pageOf(BASE, 9), NOW)).toMatchObject({ verdict: "withheld", copy, read: null });
    expect(takePage(copy, { ...read, list: OTHER.list }, good, NOW)).rejects.toThrow(RangeError);
    // A page longer than any the account service shows is read up to that length, and the rest is asked for.
    let long = BASE;
    for (let index = 0; index < PAGE_ENTRIES_MAX + 8; index++) long = await add(long, owner, epochOf(index));
    const all = await takePage(copy, read, { list: long.list, after: 4, entries: long.texts.slice(5), head: headOf(long) }, NOW);
    expect([all.verdict, all.copy.entries.length, all.read?.after]).toEqual(["more", 5 + PAGE_ENTRIES_MAX, 4 + PAGE_ENTRIES_MAX]);
  });

  test("a log shown past the most entries any list holds is refused there", async () => {
    // A copy that stands one entry before the last place, made by hand: only its first entry, its footing and its head are ever read.
    const base = await followed(await start(), DEVICE(owner), { how: "genesis" });
    const last = await signed({ list: base.list, texts: Array.from({ length: LIST_ENTRIES_MAX - 2 }, () => ""), hashes: Array.from({ length: LIST_ENTRIES_MAX - 2 }, () => "ef".repeat(32)) }, owner,
      kindBody({ issued_at: T0, list: base.list, prev: "ef".repeat(32), seq: LIST_ENTRIES_MAX - 2, signer: owner.key }, { kind: "epoch", epoch: 0, opens: "0b".repeat(32), link: new Uint8Array(61) }));
    const filler = at(base.entries, 0);
    const texts = [filler, ...Array.from({ length: LIST_ENTRIES_MAX - 3 }, () => filler), at(last.texts, LIST_ENTRIES_MAX - 2)];
    const copy: FollowerCopy = { ...base, entries: texts, state: { ...stateOf(base), footing: headOf(last) } };
    const more = await grow(last, [[owner, epochOf(0)], [owner, epochOf(1)], [owner, epochOf(2)]]);
    const taken = await takePage(copy, startRead(copy, "service"), pageOf(more, LIST_ENTRIES_MAX - 2), NOW);
    expect([taken.verdict, taken.code, taken.at, taken.copy.entries.length, taken.read, taken.copy.read_at]).toEqual(["refused", "log_full", LIST_ENTRIES_MAX, LIST_ENTRIES_MAX, null, copy.read_at]);
    expect(stateOf(taken.copy).epoch).toBe(1);
    const again = await takePage(taken.copy, startRead(taken.copy, "service"), pageOf(more, LIST_ENTRIES_MAX - 1), NOW);
    expect([again.verdict, again.code, again.copy]).toEqual(["refused", "log_full", taken.copy]);
  });

  test("a member that is behind stops at an entry its build cannot place, answers for nobody, and keeps that entry for the replay after an update", async () => {
    // A full signer wrote a kind of a later level, so the list needs that level; then a key that is no signer wrote one for which that level may ask a proof.
    const behind = await addRaw(BASE, owner, { kind: "later_kind", v: 2 });
    const stopping = await addRaw(behind, mallory, { kind: "later_kind", v: 2 });
    const after = await add(stopping, owner, removeOf(phone));
    const copy = await followed(behind, PC(desk, 1), { how: "added" });
    expect([standing(copy), stateOf(copy).behind, opens(copy, phone)]).toEqual(["in", 5, "drive"]);
    const stopped = await reads(copy, serves(after));
    expect([lastOf(stopped), standing(stopped.copy), stopped.copy.entries, stopped.copy.stop, stateOf(stopped.copy).needs_replay]).toEqual(["needs_newer_client", "stopped", behind.texts, at(stopping.texts, 6), { seq: 6, hash: at(stopping.hashes, 6) }]);
    expect([opens(stopped.copy, phone), opens(stopped.copy, owner), shownPcs(stopped.copy), pcOfKey(stopped.copy, desk.key)]).toEqual(["stopped", "stopped", [], null]);
    // It stays stopped whatever it is shown, keeps the entry it stopped at, and reads no more by the clock.
    const kept = await saved(stopped.copy);
    for (const log of [after, behind, await add(behind, owner, deviceOf(tablet))]) {
      const again = await reads(kept, serves(log));
      expect([lastOf(again), again.copy]).toEqual(["needs_newer_client", kept]);
    }
    expect(followStep(kept, NOW, { event: "tick", asked_at: null, busy: true })).toEqual({ do: "wait", until: null });
    expect(followStep(kept, NOW, { event: "session", since: null })).toEqual({ do: "decide" });
    // A member that stops lets nobody in any more: everybody it held is told as gone, the device an entry removed on that page among them.
    const removing = await addRaw(await add(behind, owner, removeOf(phone)), mallory, { kind: "later_kind", v: 2 });
    const went = await reads(copy, serves(removing));
    expect([lastOf(went), standing(went.copy), went.last.changes.devices.removed.map((row) => who(row.key)), went.last.changes.devices.added]).toEqual(["needs_newer_client", "stopped", ["owner", "phone"], []]);
    // Each as the list holds it now: the phone with the place of its removal, the owner still in the list and refused all the same.
    expect(went.last.changes.devices.removed.map((row) => row.ended)).toEqual([null, 6]);
    expect(went.last.changes.pcs.removed.map((row) => row.endpoint)).toEqual([E(1), E(2)]);
    // A member that stopped before the list showed what its pin asks for is stopped, not waiting: it reads no more by the clock either.
    const unmet = (await reads(pinned(stopping, PC(tower, 3), { how: "added" }), serves(stopping))).copy;
    expect([standing(unmet), followStep(unmet, NOW, { event: "tick", asked_at: null, busy: true }), followStep(unmet, NOW, { event: "doorbell" })]).toEqual(["stopped", { do: "wait", until: null }, { do: "wait", until: null }]);
  });
});

describe("two members and a service that shows them two things", () => {
  test("compareHeads says who asks: the one behind, and both when they stand at different entries", async () => {
    const short = await followed(upTo(BASE, 2), DEVICE(owner), { how: "genesis" });
    const long = await followed(BASE, PC(desk, 1), { how: "added" });
    const none = pinned(BASE, DEVICE(phone), { how: "carried" });
    const verdict = (copy: FollowerCopy, theirs: unknown) => compareHeads(copy, theirs as ReturnType<typeof gossipHead>).verdict;
    expect([verdict(short, gossipHead(long)), verdict(long, gossipHead(short)), verdict(long, gossipHead(long))]).toEqual(["behind", "ahead", "same"]);
    expect([verdict(none, gossipHead(long)), verdict(long, gossipHead(none)), verdict(none, gossipHead(none))]).toEqual(["behind", "ahead", "same"]);
    expect([verdict(long, { list: BASE.list, place: { seq: 2, hash: "ab".repeat(32) } }), verdict(long, { list: BASE.list, place: { seq: 4, hash: at(BASE.hashes, 3) } }), verdict(long, { list: BASE.list, place: "x" })]).toEqual(["differs", "differs", "differs"]);
    expect([verdict(long, { list: OTHER.list, place: null }), verdict(long, null), verdict(long, { list: OTHER.list, place: gossipHead(long).place })]).toEqual(["not_my_list", "not_my_list", "not_my_list"]);
    // Only a verdict that asks carries a request: for what follows the member's head, or for the very entry the other stands at.
    expect(compareHeads(long, gossipHead(short)).read).toBeNull();
    expect(compareHeads(short, gossipHead(long)).read).toEqual({ source: "peer", list: BASE.list, after: 2, back: false, left: READ_PAGES_MAX - 1, carry: null, common: 0, parted: null });
    expect(compareHeads(long, { list: BASE.list, place: { seq: 3, hash: "ab".repeat(32) } }).read).toEqual({ source: "peer", list: BASE.list, after: 2, back: false, left: READ_PAGES_MAX - 1, carry: null, common: 0, parted: null });
    expect([compareHeads(long, { list: BASE.list, place: { seq: 0, hash: "ab".repeat(32) } }).read, compareHeads(long, { list: BASE.list, place: "x" } as unknown as ReturnType<typeof gossipHead>).read]).toEqual([null, null]);
  });

  test("a removal that the service withholds from one member reaches it from the other, whatever the page size", async () => {
    const removed = await add(BASE, owner, removeOf(phone));
    for (const limit of [1, 2, PAGE_ENTRIES_MAX]) {
      // The service shows the PC the log without the removal, as its whole log: nothing tells the PC.
      const pc = await followed(BASE, PC(desk, 1), { how: "added" }, NOW - 500);
      expect(opens(pc, phone)).toBe("drive");
      const device = await followed(removed, DEVICE(owner), { how: "genesis" });
      const met = await gossip(pc, device, limit);
      expect({ limit, said: met.said, opens: opens(met.a, phone), heads: [gossipHead(met.a), gossipHead(met.b)] }).toEqual({ limit, said: ["a behind caught_up"], opens: "removed", heads: [gossipHead(device), gossipHead(device)] });
      // Taken from a peer, it is no full read of the account service.
      expect([met.a.read_at, met.a.alarm, met.b]).toEqual([NOW - 500, null, device]);
      // The service goes on withholding: the removal stays.
      const still = await reads(met.a, serves(BASE));
      expect([lastOf(still), opens(still.copy, phone), still.copy.read_at]).toEqual(["older", "removed", NOW - 500]);
    }
  });

  test("two continuations that members signed are a fork: both members get the alarm, each from what the other shows", async () => {
    // The service shows the PC a device that the phone added, and the owner's device its removal of the phone, in the same place.
    const one = await grow(BASE, [[phone, deviceOf(tablet)], [tablet, epochOf(0)]]);
    const two = await grow(BASE, [[owner, removeOf(phone)]]);
    for (const limit of [1, 2, PAGE_ENTRIES_MAX]) {
      const pc = await followed(one, PC(desk, 1), { how: "added" });
      const device = await followed(two, DEVICE(owner), { how: "genesis" });
      const met = await gossip(pc, device, limit);
      expect({ limit, said: met.said.slice(0, 2) }).toEqual({ limit, said: ["a differs fork", "b behind fork"] });
      expect({ limit, a: met.a.alarm, b: met.b.alarm }).toEqual({
        limit,
        // Each names the key that signed the history it does not hold.
        a: { code: "fork", source: "peer", seq: 5, by: owner.key, at: NOW, devices: [owner.key, phone.key, tablet.key].sort(), pcs: [E(1), E(2)] },
        b: { code: "fork", source: "peer", seq: 5, by: phone.key, at: NOW, devices: [owner.key], pcs: [E(1), E(2)] },
      });
      // Neither took anything of the other's history, and each keeps the alarm over a save.
      expect([met.a.entries, met.b.entries, (await saved(met.a)).alarm?.seq, (await saved(met.b)).alarm?.seq]).toEqual([one.texts, two.texts, 5, 5]);
      // Met again, nothing moves; the alarm is the first one.
      const again = await gossip(met.a, met.b, limit);
      expect([again.a, again.b]).toEqual([met.a, met.b]);
    }
  });

  test("with an alarm a member lets in nobody it did not hold then, and still takes a removal on its own history", async () => {
    const one = await grow(BASE, [[phone, deviceOf(tablet)]]);
    const two = await grow(BASE, [[owner, removeOf(phone)]]);
    const met = await gossip(await followed(one, PC(desk, 1), { how: "added" }), await followed(two, DEVICE(owner), { how: "genesis" }));
    const alarmed = met.a;
    expect([opens(alarmed, owner), opens(alarmed, phone), opens(alarmed, tablet)]).toEqual(["drive", "drive", "drive"]);
    const later = await grow(one, [[owner, deviceOf(browser)], [owner, pcOf(tower, 3)], [owner, removeOf(tablet)]]);
    const read = await reads(alarmed, serves(later));
    expect([lastOf(read), read.copy.entries, read.copy.alarm]).toEqual(["caught_up", later.texts, alarmed.alarm]);
    expect([opens(read.copy, browser), opens(read.copy, tablet), opens(read.copy, phone), pcOfKey(read.copy, tower.key), pcOfKey(read.copy, desk.key)]).toEqual(["frozen", "removed", "drive", null, E(1)]);
    expect(shownPcs(read.copy).map((row) => row.endpoint)).toEqual([E(1), E(2)]);
    expect(shownDevices(read.copy).map((row) => who(row.key))).toEqual(["owner", "phone"]);
    // Without the alarm the same copy lets the new device and the new PC in.
    const calm = { ...read.copy, alarm: null };
    expect([opens(calm, browser), pcOfKey(calm, tower.key)]).toEqual(["drive", E(3)]);
  });

  test("a key that was removed can still sign another history from the place of its removal: that is a fork too", async () => {
    const real = await grow(BASE, [[owner, removeOf(phone)], [owner, deviceOf(tablet)]]);
    const copy = await followed(real, PC(desk, 1), { how: "added" });
    // The phone, removed at entry 5, signs its own entry 5: it removes the owner.
    const other = await grow(BASE, [[phone, removeOf(owner)]]);
    const shown = await takePage(copy, { ...startRead(copy, "service"), after: 4 }, pageOf(other, 4), NOW);
    expect([shown.verdict, shown.at, shown.copy.alarm?.source, shown.copy.alarm?.by, shown.copy.entries, opens(shown.copy, owner), opens(shown.copy, phone)]).toEqual(["fork", 5, "service", phone.key, real.texts, "drive", "removed"]);
    // What stands before an entry that is no entry proves what it proves; a page that begins with one proves nothing.
    const cut = await takePage(copy, { ...startRead(copy, "service"), after: 4 }, { ...pageOf(other, 4), entries: [at(other.texts, 5), "junk"] }, NOW);
    expect([cut.verdict, cut.at, cut.copy.alarm?.by]).toEqual(["fork", 5, phone.key]);
    const none = await takePage(copy, { ...startRead(copy, "service"), after: 4 }, { ...pageOf(other, 4), entries: ["junk", at(other.texts, 5)] }, NOW);
    expect([none.verdict, none.copy.alarm, none.copy.entries]).toEqual(["stuck", null, real.texts]);
    // The other history may begin with entries that no signer signed: the key named is the first signer's, not theirs.
    const padded = await grow(BASE, [[mallory, epochOf(0)], [phone, removeOf(owner)]]);
    const led = await takePage(copy, { ...startRead(copy, "service"), after: 4 }, pageOf(padded, 4), NOW);
    expect([led.verdict, led.at, led.copy.alarm?.by]).toEqual(["fork", 5, phone.key]);
  });

  test("the account service alone shows a member another history that a member signed: it looks under its footing for the place, and gets the alarm", async () => {
    const real = await grow(BASE, [[owner, removeOf(phone)], [owner, deviceOf(tablet)], [tablet, epochOf(0)], [owner, epochOf(1)]]);
    // The other history parts at entry 4, 5, 6 and 7, and goes on for a while; the member asks after its head and is shown none of its own.
    for (let parts = 4; parts <= 7; parts++) {
      let other = await add(upTo(real, parts - 1), owner, deviceOf(browser));
      for (let more = 0; more < 6; more++) {
        other = await add(other, browser, more === 0 ? deviceOf(eve) : epochOf(parts > 7 ? more + 1 : more - 1));
        for (const limit of [1, 3, PAGE_ENTRIES_MAX]) {
          const copy = await followed(real, PC(desk, 1), { how: "added" });
          const read = await reads(copy, serves(other, limit));
          const where = { parts, length: other.texts.length, limit };
          expect({ where, last: lastOf(read), at: read.last.at, alarm: read.copy.alarm?.seq, by: who(read.copy.alarm?.by ?? ""), entries: read.copy.entries, opens: [opens(read.copy, browser), opens(read.copy, eve), opens(read.copy, tablet)] })
            .toEqual({ where, last: "fork", at: parts, alarm: parts, by: "owner", entries: real.texts, opens: ["never_added", "never_added", "drive"] });
          expect({ where, pages: read.pages <= 12 + Math.ceil(8 / limit) }).toEqual({ where, pages: true });
        }
      }
    }
  });

  test("another history that no member signed is stuck, never an alarm: a bare head, a stranger's entries, a key that was no signer there, an entry that follows nothing", async () => {
    const real = await grow(BASE, [[owner, removeOf(phone)], [owner, deviceOf(tablet)]]);
    const copy = await followed(real, PC(desk, 1), { how: "added" });
    const strangers = await grow(BASE, [[mallory, removeOf(owner)], [mallory, deviceOf(mallory)], [mallory, epochOf(0)]]);
    // An entry by the owner's key that the owner did not sign: the key's name is no signature.
    const forged = { ...strangers, texts: [...BASE.texts, at((await add(BASE, owner, removeOf(desk))).texts, 5).replace(/\.[^.]*$/, `.${at(strangers.texts, 5).split(".")[1]}`)] };
    const answers: readonly (readonly [string, (read: FollowRead) => ListPage])[] = [
      ["a head under the footing with another hash", () => ({ entries: [], head: { seq: 3, hash: "ab".repeat(32) } })],
      ["a head at the footing with another hash", () => ({ entries: [], head: { seq: 6, hash: "ab".repeat(32) } })],
      ["a head under the footing with another hash, and the member's own entries", (read) => ({ ...pageOf(real, read.after), head: { seq: 3, hash: "ab".repeat(32) } })],
      ["a stranger's entries from under the footing", serves(strangers)],
      ["a stranger's entries, one at a time", serves(strangers, 1)],
      ["an entry with a member's key and no signature of it", (read) => ({ ...pageOf(forged, read.after), head: { seq: 5, hash: "ab".repeat(32) } })],
      // A key signs where the member's history does not hold it for a signer: before an entry added it, and after an entry ended it.
      ["an entry by a key that was added later, in an earlier place", serves(await add(BASE, tablet, epochOf(0)))],
      ["an entry by a key that was removed, in a later place", serves(await add(upTo(real, 5), phone, epochOf(0)))],
      ["an entry after the head that follows an entry nobody shows", (read) => ({ entries: read.after === 6 ? [at(strangers.texts, 7)] : [], head: { seq: 99, hash: "ab".repeat(32) } })],
    ];
    for (const [name, answer] of answers) {
      for (const source of ["service", "peer"] as const) {
        const read = await reads(copy, answer, source);
        // It is stuck at once, may ask on, forward or under its footing, and ends with what it had and no alarm.
        expect({ name, source, first: at(read.verdicts, 0), rest: read.verdicts.every((verdict) => ["stuck", "more", "withheld"].includes(verdict)), copy: read.copy, pages: read.pages <= 6 })
          .toEqual({ name, source, first: "stuck", rest: true, copy, pages: true });
      }
    }
    // The member is as it was: an honest answer is taken as ever.
    const more = await add(real, owner, epochOf(0));
    expect((await reads(copy, serves(more))).copy.entries).toEqual(more.texts);
  });

  test("a member whose copy ends in entries that no signer signed and one that holds the log meet: they come to the same list, with no alarm", async () => {
    const real = await grow(BASE, [[owner, deviceOf(tablet)], [tablet, removeOf(phone)]]);
    const junk = await grow(BASE, [[mallory, deviceOf(mallory)], [mallory, removeOf(owner)], [mallory, epochOf(0)]]);
    for (const limit of [1, PAGE_ENTRIES_MAX]) {
      const fooled = (await reads(await followed(BASE, PC(desk, 1), { how: "added" }), serves(junk))).copy;
      const honest = await followed(real, DEVICE(owner), { how: "genesis" });
      const met = await gossip(fooled, honest, limit);
      expect({ limit, a: met.a.entries, b: met.b.entries, alarms: [met.a.alarm, met.b.alarm], state: met.a.state }).toEqual({ limit, a: real.texts, b: real.texts, alarms: [null, null], state: honest.state });
    }
  });

  test("a member serves a peer only its own history up to its footing, from the place asked", async () => {
    const real = await grow(BASE, [[owner, deviceOf(tablet)], [tablet, removeOf(phone)]]);
    const long = (await reads(await followed(real, PC(desk, 1), { how: "added" }), serves(await grow(real, [[mallory, deviceOf(mallory)], [mallory, epochOf(0)]])))).copy;
    expect(long.entries.length).toBe(9);
    const head = headOf(real);
    expect(servePage(long, { list: real.list, after: 3 }, 2)).toEqual({ list: real.list, after: 3, entries: real.texts.slice(4, 6), head });
    expect(servePage(long, { list: real.list, after: null }, 3)).toEqual({ list: real.list, after: null, entries: real.texts.slice(0, 3), head });
    // What no signer signed is served to nobody, and a place past the footing gets nothing.
    expect(servePage(long, { list: real.list, after: 5 }, 50)).toEqual({ list: real.list, after: 5, entries: [at(real.texts, 6)], head });
    expect([servePage(long, { list: real.list, after: 6 }, 50)?.entries, servePage(long, { list: real.list, after: 60 }, 50)?.entries]).toEqual([[], []]);
    const refused: readonly unknown[] = [null, { list: OTHER.list, after: 3 }, { list: real.list, after: -1 }, { list: real.list, after: "3" }, { list: real.list }];
    for (const bad of refused) expect({ bad, page: servePage(long, bad as FollowRead, 5) }).toEqual({ bad, page: null });
    expect([servePage(long, { list: real.list, after: 3 }, 0), servePage(pinned(real, DEVICE(phone), { how: "carried" }), { list: real.list, after: null }, 5)]).toEqual([null, null]);
    // The answer says which place it follows: another than the one asked is refused.
    const short = await followed(upTo(BASE, 3), DEVICE(owner), { how: "genesis" });
    const ask = startRead(short, "peer");
    const page = servePage(long, ask, 5);
    if (page === null) throw new Error("no page");
    expect(await takePage(short, ask, { ...page, after: 2 }, NOW)).toMatchObject({ verdict: "refused", code: "page_form", copy: short });
    expect(await takePage(short, ask, page, NOW)).toMatchObject({ verdict: "caught_up", copy: { entries: real.texts, read_at: short.read_at } });
  });
});

describe("entries that a member signed and left behind", () => {
  /** The phone and the owner sign at place 5 at once; the phone's gets the place, and the owner signs again on the new head. */
  const raced = (async () => {
    const placed = await add(BASE, phone, deviceOf(tablet));
    return { lost: await add(BASE, owner, epochOf(0)), log: await add(placed, owner, epochOf(0)) };
  })();
  /** A service that names `other`'s head as its own and shows `other` from wherever it is asked under that head. */
  const shows = (other: Log, limit = PAGE_ENTRIES_MAX) => (ask: FollowRead): ListPage =>
    ((ask.after ?? -1) < other.texts.length - 1 ? pageOf(other, ask.after, limit) : { list: other.list, after: ask.after, entries: [], head: headOf(other) });

  test("an entry that lost its place is no fork: shown later by the account service alone, it is refused and nothing changes", async () => {
    const { lost, log } = await raced;
    const pc = await followed(log, PC(desk, 1), { how: "added" });
    for (const limit of [1, 2, PAGE_ENTRIES_MAX]) {
      const read = await reads(pc, shows(lost, limit));
      expect({ limit, last: lastOf(read), code: read.last.code, at: read.last.at, copy: read.copy, changes: read.last.changes })
        .toEqual({ limit, last: "refused", code: "chain_broken", at: 5, copy: pc, changes: { devices: { added: [], removed: [] }, pcs: { added: [], removed: [] } } });
    }
    // A device the owner adds afterwards is let in: nothing is held back.
    const later = await reads(pc, serves(await add(log, owner, deviceOf(browser))));
    expect([lastOf(later), later.copy.alarm, opens(later.copy, browser)]).toEqual(["caught_up", null, "drive"]);
  });

  test("so is a whole post that lost its place: a removal with the epoch after it, both by the member that signed them again", async () => {
    const lost = await grow(BASE, [[owner, removeOf(phone)], [owner, epochOf(0)]]);
    const log = await grow(BASE, [[phone, deviceOf(tablet)], [owner, removeOf(phone)], [owner, epochOf(0)]]);
    const pc = await followed(log, PC(desk, 1), { how: "added" });
    for (const limit of [1, 2, PAGE_ENTRIES_MAX]) {
      const read = await reads(pc, shows(lost, limit));
      expect({ limit, last: lastOf(read), code: read.last.code, at: read.last.at, copy: read.copy }).toEqual({ limit, last: "refused", code: "chain_broken", at: 5, copy: pc });
    }
    // As many entries as one post holds, and no more: one more is not what a member posts at once.
    let post = upTo(log, 4);
    for (let index = 0; index < ATTEMPT_ENTRIES_MAX; index++) post = await add(post, owner, epochOf(index));
    const whole = await takePage(pc, { ...startRead(pc, "service"), after: 4 }, pageOf(post, 4), NOW);
    expect([whole.verdict, whole.code, whole.copy.alarm]).toEqual(["refused", "chain_broken", null]);
    const longer = await add(post, owner, epochOf(ATTEMPT_ENTRIES_MAX));
    const more = await takePage(pc, { ...startRead(pc, "service"), after: 4 }, pageOf(longer, 4), NOW);
    expect([more.verdict, more.at, more.copy.alarm?.by]).toEqual(["fork", 5, owner.key]);
  });

  test("an entry by any other member after it makes it a fork, wherever the pages were cut, and whenever it is shown", async () => {
    const { lost, log } = await raced;
    const pc = await followed(log, PC(desk, 1), { how: "added" });
    // Somebody lives on the other history: the tower signed on the owner's entry.
    const other = await add(await add(lost, owner, pcOf(tower, 3)), tower, deviceOf(browser, "bound"));
    for (const limit of [1, 2, 3, PAGE_ENTRIES_MAX]) {
      const read = await reads(pc, shows(other, limit));
      expect({ limit, last: lastOf(read), at: read.last.at, alarm: [read.copy.alarm?.seq, who(read.copy.alarm?.by ?? "")], entries: read.copy.entries }).toEqual({ limit, last: "fork", at: 5, alarm: [5, "owner"], entries: log.texts });
    }
    // The service shows the one entry alone, and later the entry with what follows it: a fork at the second.
    const alone = await reads(pc, shows(lost));
    expect([lastOf(alone), alone.copy.alarm]).toEqual(["refused", null]);
    const then = await reads(alone.copy, shows(other));
    expect([lastOf(then), then.copy.alarm?.seq]).toEqual(["fork", 5]);
    // From a peer that lives on it: the same.
    const peer = await followed(other, DEVICE(owner), { how: "genesis" });
    for (const limit of [1, PAGE_ENTRIES_MAX]) {
      const met = await gossip(pc, peer, limit);
      expect({ limit, alarms: [met.a.alarm?.seq, met.b.alarm?.seq] }).toEqual({ limit, alarms: [5, 5] });
    }
  });

  test("what is no attempt stays a fork: a writer that never signed again in the member's history, an entry that stands on a loose one", async () => {
    const { lost } = await raced;
    // The member holds the phone's entry at 5 and nothing by the owner after it.
    const short = await followed(await add(BASE, phone, deviceOf(tablet)), PC(desk, 1), { how: "added" });
    const never = await takePage(short, { ...startRead(short, "service"), after: 4 }, pageOf(lost, 4), NOW);
    expect([never.verdict, never.copy.alarm?.by]).toEqual(["fork", owner.key]);
    // The owner's entry on top of an entry that no signer signed: no member signs there.
    const { log } = await raced;
    const pc = await followed(log, PC(desk, 1), { how: "added" });
    const onLoose = await grow(BASE, [[mallory, epochOf(0)], [owner, epochOf(0)]]);
    const stood = await takePage(pc, { ...startRead(pc, "service"), after: 4 }, pageOf(onLoose, 4), NOW);
    expect([stood.verdict, stood.at, stood.copy.alarm?.by]).toEqual(["fork", 5, owner.key]);
    // A writer whose only later entry in the member's history it signed when it was a signer no more: it did not go on there.
    const removed = await grow(BASE, [[owner, removeOf(phone)], [phone, epochOf(0)], [owner, epochOf(0)]]);
    const held = await followed(removed, PC(desk, 1), { how: "added" });
    expect(footingOf(held).seq).toBe(7);
    const gone = await takePage(held, { ...startRead(held, "service"), after: 4 }, pageOf(await add(BASE, phone, deviceOf(tablet)), 4), NOW);
    expect([gone.verdict, gone.at, gone.copy.alarm?.by]).toEqual(["fork", 5, phone.key]);
  });

  test("what no member signed changes nothing either way: a stranger's entries after it make no fork, and a signer's name with no signature of it proves nothing", async () => {
    const { lost, log } = await raced;
    const pc = await followed(log, PC(desk, 1), { how: "added" });
    // The service adds its own entries to the one it kept, and names a head past them.
    const padded = await grow(lost, [[mallory, deviceOf(mallory)], [mallory, epochOf(1)]]);
    for (const limit of [1, PAGE_ENTRIES_MAX]) {
      const read = await reads(pc, shows(padded, limit));
      expect({ limit, last: lastOf(read), code: read.last.code, copy: read.copy }).toEqual({ limit, last: "refused", code: "chain_broken", copy: pc });
    }
    // It shows the entry with a head far past it: the member asks for what follows, is shown nothing, and that is the end of it.
    const far = { seq: 90, hash: "ab".repeat(32) };
    const asked = await takePage(pc, { ...startRead(pc, "service"), after: 4 }, { ...pageOf(lost, 4), head: far }, NOW);
    expect([asked.verdict, asked.read?.after, asked.read?.carry?.texts, asked.copy]).toEqual(["stuck", 5, [at(lost.texts, 5)], pc]);
    const nothing = await takePage(asked.copy, asked.read ?? startRead(pc, "service"), { entries: [], head: far }, NOW);
    expect([nothing.verdict, nothing.code, nothing.read, nothing.copy]).toEqual(["refused", "chain_broken", null, pc]);
    // The tower's name on an entry after it, signed by the service's own key.
    const real = await add(lost, owner, pcOf(tower, 3));
    const forged = `${at((await add(real, tower, epochOf(0))).texts, 7).split(".")[0]}.${at((await add(real, mallory, epochOf(0))).texts, 7).split(".")[1]}`;
    const taken = await takePage(pc, { ...startRead(pc, "service"), after: 4 }, { list: log.list, after: 4, entries: [at(lost.texts, 5), at(real.texts, 6), forged], head: { seq: 7, hash: "ab".repeat(32) } }, NOW);
    expect([taken.verdict, taken.code, taken.copy]).toEqual(["refused", "chain_broken", pc]);
  });

  test("entries that no signer signed, before or between, change nothing of this, wherever the pages were cut", async () => {
    const { lost, log } = await raced;
    const pc = await followed(log, PC(desk, 1), { how: "added" });
    const cases: readonly (readonly [string, Log, FollowVerdict, string | null])[] = [
      // The owner's entry that lost its place, a stranger's on it, and then another member's: somebody lives there.
      ["a member's entry after a stranger's after it", await grow(lost, [[mallory, epochOf(1)], [phone, epochOf(1)]]), "fork", "owner"],
      // A stranger's entry at the place, and a member's on it: no member signs on what no signer signed.
      ["a member's entry on a stranger's", await grow(BASE, [[mallory, epochOf(0)], [owner, epochOf(0)]]), "fork", "owner"],
      ["a member's entry on three of a stranger's", await grow(BASE, [[mallory, epochOf(0)], [eve, epochOf(0)], [mallory, epochOf(0)], [phone, epochOf(0)]]), "fork", "phone"],
      // Nothing but the owner's entry and strangers' after it, to the head: what the owner left behind.
      ["strangers' entries after it and nothing else", await grow(lost, [[mallory, epochOf(1)], [eve, epochOf(1)], [mallory, epochOf(1)]]), "refused", null],
      // Strangers' entries alone: nothing a member signed.
      ["strangers' entries alone", await grow(BASE, [[mallory, epochOf(0)], [eve, epochOf(0)], [mallory, epochOf(0)]]), "stuck", null],
    ];
    for (const [name, other, verdict, by] of cases) {
      for (const limit of [1, 2, 3, PAGE_ENTRIES_MAX]) {
        const read = await reads(pc, shows(other, limit));
        expect({ name, limit, last: lastOf(read), by: read.copy.alarm === null ? null : who(read.copy.alarm.by), at: read.copy.alarm?.seq ?? null, entries: read.copy.entries })
          .toEqual({ name, limit, last: verdict, by, at: by === null ? null : 5, entries: log.texts });
      }
    }
  });

  test("the member that was shown such an entry as the list is the one with the alarm, when it meets one that holds the list", async () => {
    const { lost, log } = await raced;
    const pc = await followed(log, PC(desk, 1), { how: "added" });
    // The service showed this device the owner's entry at 5 as placed: it lives on what nobody signed on.
    const fooled = await followed(lost, DEVICE(phone), allowedAt(lost, 1));
    for (const limit of [1, PAGE_ENTRIES_MAX]) {
      const met = await gossip(pc, fooled, limit);
      expect({ limit, a: [met.a.alarm, met.a.entries], b: [met.b.alarm?.seq, who(met.b.alarm?.by ?? ""), met.b.entries] }).toEqual({ limit, a: [null, log.texts], b: [5, "phone", lost.texts] });
    }
  });

  test("a later proof leaves the first alarm as it was, and what came in since stays held back", async () => {
    const one = await grow(BASE, [[phone, deviceOf(tablet)]]);
    const two = await grow(BASE, [[owner, removeOf(phone)]]);
    const pc = await followed(one, PC(desk, 1), { how: "added" });
    const first = await takePage(pc, { ...startRead(pc, "service"), after: 4 }, pageOf(two, 4), NOW);
    expect(first.verdict).toBe("fork");
    const alarm = first.copy.alarm;
    const later = await grow(one, [[owner, deviceOf(browser)], [owner, epochOf(0)]]);
    const taken = await reads(first.copy, serves(later), "service", NOW + 100);
    expect([lastOf(taken), opens(taken.copy, browser, NOW + 100)]).toEqual(["caught_up", "frozen"]);
    // A second one, at another place and a later hour, signed on by two members.
    const other = await grow(upTo(later, 5), [[owner, removeOf(phone)], [tablet, epochOf(0)]]);
    const second = await takePage(taken.copy, { ...startRead(taken.copy, "service"), after: 5 }, pageOf(other, 5), NOW + 200);
    expect([second.verdict, second.at, second.copy.alarm, opens(second.copy, browser, NOW + 200)]).toEqual(["fork", 6, alarm, "frozen"]);
  });
});

describe("what a page costs, and what a read costs", () => {
  /** The signatures a call checks: the count of what the runtime was asked to verify. */
  async function verifies<Result>(call: () => Promise<Result>): Promise<{ readonly result: Result; readonly count: number }> {
    const spy = spyOn(crypto.subtle, "verify");
    try {
      const result = await call();
      return { result, count: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  }

  test("a page checks each entry it shows once; only a history a member signed makes the member replay its own, once, and that ends the read", async () => {
    let real = BASE;
    for (let index = 0; index < 120; index++) real = await add(real, owner, epochOf(index));
    const copy = await followed(real, PC(desk, 1), { how: "added" });
    const top = real.texts.length - 1;
    const under = { ...startRead(copy, "service"), after: top - 1 };
    // An entry at the footing's place by the service's own key, then one that names the owner and is signed by the service.
    const alt = await add(upTo(real, top - 1), mallory, epochOf(0));
    const claimed = `${at((await add(alt, owner, epochOf(0))).texts, top + 1).split(".")[0]}.${at((await add(alt, mallory, epochOf(0))).texts, top + 1).split(".")[1]}`;
    const crafted = await verifies(() => takePage(copy, under, { list: real.list, after: top - 1, entries: [at(alt.texts, top), claimed], head: { seq: top + 1, hash: "ab".repeat(32) } }, NOW));
    expect([crafted.result.verdict, crafted.result.copy.alarm, crafted.count <= 2]).toEqual(["stuck", null, true]);
    // An entry the owner signed and left behind: told without a replay.
    const lost = await add(upTo(real, top - 1), owner, epochOf(500));
    const left = await verifies(() => takePage(copy, under, pageOf(lost, top - 1), NOW));
    expect([left.result.verdict, left.result.code, left.count <= 2]).toEqual(["refused", "chain_broken", true]);
    // A history two members signed: the member replays its own history once, with the entries shown, and the read is over.
    const forked = await grow(upTo(real, top - 1), [[owner, epochOf(500)], [phone, epochOf(501)]]);
    const proven = await verifies(() => takePage(copy, under, pageOf(forked, top - 1), NOW));
    // One check for each entry of its history and of the page, one for each card among them, and the two the page cost before.
    expect([proven.result.verdict, proven.result.read, proven.count > top, proven.count <= top + 2 + 3 + 2]).toEqual(["fork", null, true, true]);
    // An ordinary page: one check for each entry.
    const next = await add(real, owner, epochOf(120));
    const plain = await verifies(() => takePage(copy, startRead(copy, "service"), pageOf(next, top), NOW));
    expect([plain.result.verdict, plain.count]).toEqual(["caught_up", 1]);
  });

  test("a source that sends a read under its footing and forward again does not keep it going", async () => {
    const real = await grow(BASE, [[owner, deviceOf(tablet)], [owner, epochOf(0)], [owner, epochOf(1)], [owner, epochOf(2)]]);
    const copy = await followed(real, PC(desk, 1), { how: "added" });
    const top = real.texts.length - 1;
    const alt = await grow(upTo(real, top - 1), [[mallory, epochOf(0)], [mallory, epochOf(0)]]);
    const fake = { seq: 99, hash: "ab".repeat(32) };
    const liars: readonly (readonly [string, (ask: FollowRead) => ListPage])[] = [
      // At the head an entry that follows another entry than the member's; under it the member's own, and more to come.
      ["an entry that follows nothing, then the member's own", (ask) => (ask.after === top ? { list: real.list, after: ask.after, entries: [at(alt.texts, top + 1)], head: fake } : { list: real.list, after: ask.after, entries: real.texts.slice((ask.after ?? -1) + 1), head: fake })],
      // At the head nothing and a head that is another entry; under it one entry of the member's own and a head that is high or low.
      ["a bare head, then one entry at a time", (ask) => {
        const after = ask.after ?? -1;
        if (after === top) return { entries: [], head: { seq: top, hash: "ab".repeat(32) } };
        return { entries: real.texts.slice(after + 1, after + 2), head: after + 1 >= top ? { seq: 3, hash: "ab".repeat(32) } : { seq: top, hash: "ab".repeat(32) } };
      }],
    ];
    for (const [name, liar] of liars) {
      let held = copy;
      let ask: FollowRead | null = startRead(copy, "service");
      let last: PageResult | null = null;
      let pages = 0;
      while (ask !== null && pages < 4 * READ_PAGES_MAX) {
        last = await takePage(held, ask, liar(ask), NOW + 9);
        [held, ask] = [last.copy, last.read];
        pages++;
      }
      // Each is seen through after a few requests: a page that narrows nothing of where the two part ends the search.
      expect({ name, pages: pages <= 6, ask, verdict: last?.verdict, entries: held.entries, read_at: held.read_at, alarm: held.alarm })
        .toEqual({ name, pages: true, ask: null, verdict: "stuck", entries: real.texts, read_at: copy.read_at, alarm: null });
    }
  });

  test("a source that answers every request with an entry that follows nothing the member holds gets a short read", async () => {
    const real = await grow(BASE, [[owner, deviceOf(tablet)], [owner, epochOf(0)]]);
    const copy = await followed(real, PC(desk, 1), { how: "added" });
    const alt: Log[] = [];
    for (let seq = 1; seq < real.texts.length + 1; seq++) {
      const base: Log = { list: real.list, texts: Array.from({ length: seq }, () => ""), hashes: Array.from({ length: seq }, () => "ef".repeat(32)) };
      alt.push(await signed(base, mallory, { ...placeOf(base, mallory), kind: "epoch", v: 1, own: [] }));
    }
    let held = copy;
    let ask: FollowRead | null = startRead(copy, "service");
    let pages = 0;
    while (ask !== null && pages < 50) {
      const next = at(at(alt, ask.after ?? 0).texts, (ask.after ?? 0) + 1);
      const taken: PageResult = await takePage(held, ask, { list: real.list, after: ask.after, entries: [next], head: { seq: 99, hash: "ab".repeat(32) } }, NOW);
      [held, ask] = [taken.copy, taken.read];
      pages++;
    }
    expect([ask, pages < 10, held]).toEqual([null, true, { ...copy, seen_at: NOW }]);
  });

  test("looking under the footing for where two histories part takes about as many pages as the history has doublings, not one for each entry", async () => {
    let real = BASE;
    for (let index = 0; index < 60; index++) real = await add(real, owner, epochOf(index));
    const copy = await followed(real, PC(desk, 1), { how: "added" });
    let deep = await add(BASE, owner, deviceOf(browser));
    while (deep.texts.length < real.texts.length) deep = await add(deep, browser, epochOf(0));
    const read = await reads(copy, serves(deep));
    expect([lastOf(read), read.copy.alarm?.seq, read.pages <= 10]).toEqual(["fork", 5, true]);
  });
});

describe("verdicts that say what happened", () => {
  test("a page whose head lies before the entries it shows is out of form: what held is taken, and it is no word on where the source stands", async () => {
    const log = await grow(BASE, [[owner, deviceOf(tablet)], [owner, epochOf(0)]]);
    const copy = await followed(BASE, PC(desk, 1), { how: "added" }, NOW - 50);
    const taken = await takePage(copy, startRead(copy, "service"), { ...pageOf(log, 4), head: headOf(upTo(log, 2)) }, NOW);
    expect([taken.verdict, taken.code, taken.at, taken.copy.entries, taken.changes.devices.added.map((row) => who(row.key)), opens(taken.copy, tablet), taken.copy.read_at, taken.read])
      .toEqual(["refused", "page_form", 2, log.texts, ["tablet"], "drive", NOW - 50, null]);
    // The same head with no entry shown is an old part of the member's own history, and nothing changes.
    const old = await takePage(copy, startRead(copy, "service"), { entries: [], head: headOf(upTo(log, 2)) }, NOW);
    expect([old.verdict, old.copy]).toEqual(["older", { ...copy, seen_at: NOW }]);
  });

  test("when the member itself stops, or no longer holds what its pin asks for, everybody it let in is told as gone", async () => {
    const behind = await addRaw(BASE, owner, { kind: "later_kind", v: 2 });
    const copy = await followed(behind, PC(desk, 1), { how: "added" });
    const stopping = await addRaw(behind, mallory, { kind: "later_kind", v: 2 });
    const stopped = await takePage(copy, startRead(copy, "service"), pageOf(stopping, 5), NOW);
    expect([stopped.verdict, opens(stopped.copy, phone), stopped.changes.devices.removed.map((row) => who(row.key)), stopped.changes.pcs.removed.map((row) => row.endpoint)]).toEqual(["needs_newer_client", "stopped", ["owner", "phone"], [E(1), E(2)]]);
    // A PC that was in the account before the list is shown a carried device it never let in: it follows none of the list from then on.
    const log0 = await start();
    const migrated = await followed(log0, PC(desk, 1), { how: "migrated", admitted: [owner.key] });
    expect([standing(migrated), opens(migrated, owner)]).toEqual(["in", "drive"]);
    const carried = await takePage(migrated, startRead(migrated, "service"), pageOf(await add(log0, owner, carriedOf(tablet)), 0), NOW);
    expect([carried.verdict, standing(carried.copy), opens(carried.copy, owner), carried.changes.devices.removed.map((row) => who(row.key)), carried.changes.devices.added]).toEqual(["caught_up", "waiting", "waiting", ["owner"], []]);
    // And everybody is told as come when the member comes to be in.
    const waiting = await followed(upTo(BASE, 1), PC(desk, 1), { how: "added" });
    const came = await takePage(waiting, startRead(waiting, "service"), pageOf(BASE, 1), NOW);
    expect([came.changes.devices.added.map((row) => who(row.key)), came.changes.pcs.added.map((row) => row.endpoint), came.changes.devices.removed]).toEqual([["owner", "phone"], [E(1), E(2)], []]);
  });

  test("an entry 0 with the pinned list id that only a later level reads is needs_newer_client, and a device allowed at a later head waits for it", async () => {
    const first = await signed(null, owner, { ...placeOf(null, owner), kind: "genesis", v: 2, own: [] });
    const fresh = pinned(first, DEVICE(owner), { how: "genesis" });
    const taken = await takePage(fresh, startRead(fresh, "service"), pageOf(first, null), NOW);
    expect([taken.verdict, taken.copy.entries]).toEqual(["needs_newer_client", []]);
    const log = await grow(BASE, [[owner, deviceOf(tablet)], [owner, epochOf(0)], [owner, deviceOf(browser)]]);
    // The member that allowed the tablet stood at entry 7; the tablet's own entry is 5.
    const copy = pinned(log, DEVICE(tablet), allowedAt(log, 7));
    const early = await reads(copy, serves(upTo(log, 5)));
    expect([lastOf(early), standing(early.copy), shownPcs(early.copy)]).toEqual(["older", "waiting", []]);
    // A history that never reaches that head: its key is a device there, and it is not the list it was let into.
    const other = await reads(copy, serves(await grow(upTo(log, 6), [[mallory, epochOf(1)]])));
    expect([standing(other.copy), shownPcs(other.copy)]).toEqual(["waiting", []]);
  });

  test("exactly as many entries that no signer signed as a copy keeps are kept, and the member is caught up; one more is refused", async () => {
    const copy = await followed(BASE, PC(desk, 1), { how: "added" });
    let junk = BASE;
    for (let index = 0; index < LOOSE_ENTRIES_MAX; index++) junk = await add(junk, mallory, epochOf(0));
    const exact = await reads(copy, serves(junk));
    expect([lastOf(exact), exact.copy.entries.length]).toEqual(["caught_up", BASE.texts.length + LOOSE_ENTRIES_MAX]);
    const over = await reads(copy, serves(await add(junk, mallory, epochOf(0))));
    expect([lastOf(over), over.last.code, over.copy.entries.length]).toEqual(["refused", "loose", BASE.texts.length + LOOSE_ENTRIES_MAX]);
  });
});

describe("from the second read of the follower", () => {
  /** A list that needs a later level (the owner's entry at 5), `loose` entries no signer signed, and one that a member that is behind cannot place. */
  async function behindLog(loose: number): Promise<{ readonly behind: Log; readonly stopping: Log }> {
    const behind = await addRaw(BASE, owner, { kind: "later_kind", v: 2 });
    let padded = behind;
    for (let index = 0; index < loose; index++) padded = await add(padded, mallory, epochOf(0));
    return { behind, stopping: await addRaw(padded, eve, { kind: "later_kind", v: 2 }) };
  }

  test("a member that stopped keeps the very text it stopped at, whatever a later page shows in that place", async () => {
    const { behind, stopping } = await behindLog(0);
    const stopped = (await reads(await followed(behind, PC(desk, 1), { how: "added" }), serves(stopping))).copy;
    const text = at(stopping.texts, 6);
    expect(stopped.stop).toBe(text);
    // The same body under a signature that is not its signer's: the hash is the same, since it covers the body alone.
    const damaged = `${text.split(".")[0]}.${at(BASE.texts, 1).split(".")[1]}`;
    const again = await takePage(stopped, { ...startRead(stopped, "service"), after: 5 }, { ...pageOf(stopping, 5), entries: [damaged] }, NOW);
    expect([again.verdict, again.copy.stop === text, again.copy]).toEqual(["needs_newer_client", true, stopped]);
    expect(await readSave(writeSave(again.copy))).toEqual({ read: true, copy: stopped, rebuilt: false });
  });

  test("whether a member that is behind stops does not depend on where the pages were cut", async () => {
    // As many loose entries before the stop as a copy keeps: it reaches the stop and keeps them all. One more: it never reaches it.
    for (const [loose, verdict, stands, kept] of [[LOOSE_ENTRIES_MAX, "needs_newer_client", "stopped", LOOSE_ENTRIES_MAX], [LOOSE_ENTRIES_MAX + 1, "refused", "in", LOOSE_ENTRIES_MAX], [LOOSE_ENTRIES_MAX + 4, "refused", "in", LOOSE_ENTRIES_MAX]] as const) {
      const { behind, stopping } = await behindLog(loose);
      const copy = await followed(behind, PC(desk, 1), { how: "added" });
      const whole = await reads(copy, serves(stopping));
      for (const limit of [1, 2, 3, 5, 16, 17, PAGE_ENTRIES_MAX]) {
        const read = await reads(copy, serves(stopping, limit));
        expect({ loose, limit, last: lastOf(read), standing: standing(read.copy), kept: read.copy.entries.length - behind.texts.length, copy: read.copy })
          .toEqual({ loose, limit, last: verdict, standing: stands, kept, copy: whole.copy });
        // Asked again, the same; and its save reads.
        const again = await reads(read.copy, serves(stopping, limit));
        expect({ loose, limit, last: lastOf(again), copy: again.copy }).toEqual({ loose, limit, last: verdict, copy: read.copy });
      }
    }
  });

  test("two members whose histories part far under their footings both get the alarm in one read, whatever the page size", async () => {
    let common = BASE;
    for (let index = 0; common.texts.length < 200; index++) common = await add(common, owner, epochOf(index));
    // From place 200 on: one history by the owner and the phone, the other by the owner and the desk PC, each 150 entries more.
    let [one, two] = [common, common];
    for (let index = 0; index < 150; index++) {
      one = await add(one, index === 1 ? phone : owner, epochOf(1000 + index));
      two = await add(two, index === 1 ? desk : owner, epochOf(2000 + index));
    }
    const a = await followed(one, PC(desk, 1), { how: "added" });
    const b = await followed(two, DEVICE(owner), { how: "genesis" });
    for (const limit of [1, 3, PAGE_ENTRIES_MAX]) {
      const mine = compareHeads(a, gossipHead(b));
      const first = await reads(a, (ask) => servePage(b, ask, limit), "peer", NOW, mine.read ?? startRead(a, "peer"));
      const theirs = compareHeads(b, gossipHead(a));
      const second = await reads(b, (ask) => servePage(a, ask, limit), "peer", NOW, theirs.read ?? startRead(b, "peer"));
      // No more requests than twice the doublings of the history, and a few.
      const bound = 2 * Math.ceil(Math.log2(one.texts.length)) + 4;
      expect({ limit, a: [lastOf(first), first.copy.alarm?.seq, first.pages <= bound], b: [lastOf(second), second.copy.alarm?.seq, second.pages <= bound] })
        .toEqual({ limit, a: ["fork", 200, true], b: ["fork", 200, true] });
    }
    // The same from the account service, which shows the other history to the first of them: as long as its own, and longer.
    const bound = 2 * Math.ceil(Math.log2(one.texts.length)) + 4;
    for (const other of [two, await grow(two, [[owner, epochOf(3000)], [owner, epochOf(3001)], [owner, epochOf(3002)]])]) {
      const served = await reads(a, serves(other, 1));
      expect({ length: other.texts.length, last: lastOf(served), alarm: served.copy.alarm?.seq, pages: served.pages <= bound }).toEqual({ length: other.texts.length, last: "fork", alarm: 200, pages: true });
    }
    // Where the two part at the very place the service's head names, the member looks there first: two requests.
    const near = await add(upTo(one, one.texts.length - 2), desk, epochOf(4000));
    const looked = await reads(a, serves(near, 1));
    expect([lastOf(looked), looked.copy.alarm?.seq, looked.pages]).toEqual(["fork", one.texts.length - 1, 2]);
  }, 120_000);

  test("a save reads only with the entry its allowed pin names at that place, as a page is taken only with it", async () => {
    const log = await add(BASE, owner, deviceOf(tablet));
    const copy = await followed(log, DEVICE(tablet), allowedAt(log));
    const text = writeSave(copy);
    const sum = (body: string) => bytesToHex(sha256(utf8ToBytes(`${LIST_SAVE_PREFIX}${body}`)));
    const save = JSON.parse(text) as Record<string, unknown>;
    // The pin's hash made that of entry 4, its place left at 5, and the sum made again.
    save["pin"] = { hash: at(log.hashes, 4), how: "allowed", seq: 5 };
    delete save["sum"];
    const ordered = (value: unknown): string => (Array.isArray(value) ? `[${value.map(ordered).join(",")}]` : typeof value === "object" && value !== null
      ? `{${Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1)).map(([name, member]) => `${JSON.stringify(name)}:${ordered(member)}`).join(",")}}` : JSON.stringify(value));
    const edited = ordered({ ...save, sum: sum(ordered(save)) });
    expect(await readSave(edited)).toEqual({ read: false, why: "broken" });
    // A member with that pin, shown the same entries, takes none at that place.
    const live = await reads(pinned(log, DEVICE(tablet), { how: "allowed", seq: 5, hash: at(log.hashes, 4) }), serves(log));
    expect([lastOf(live), live.copy.entries]).toEqual(["stuck", BASE.texts]);
    expect(await readSave(text)).toEqual({ read: true, copy, rebuilt: false });
  });

  test("a hint inside the loose tail does not refresh the last full read", async () => {
    const one = await add(BASE, mallory, epochOf(0));
    const two = await add(one, mallory, epochOf(0));
    const copy = await followed(two, PC(desk, 1), { how: "added" }, NOW);
    const heard = heardHead(copy, { list: two.list, head: headOf(one) }, NOW + 31);
    expect([heard.verdict, heard.copy.read_at]).toEqual(["older", NOW]);
    expect(followStep(heard.copy, NOW + 31, { event: "session", since: null })).toEqual({ do: "read_and_wait", until: NOW + 36 });
    // So is the footing itself while the copy holds entries past it; only the member's own head is the same.
    expect([heardHead(copy, { list: two.list, head: headOf(BASE) }, NOW + 31).verdict, heardHead(copy, { list: two.list, head: headOf(two) }, NOW + 31)]).toEqual(["older", { copy: { ...copy, read_at: NOW + 31, seen_at: NOW + 31 }, verdict: "same" }]);
  });

  test("a member whose entry 0 only a later level reads stops there: it reads no more, also after a restart, and goes on once its build reads it", async () => {
    const first = await signed(null, owner, { ...placeOf(null, owner), kind: "genesis", v: 2, own: [] });
    const fresh = pinned(first, DEVICE(owner), { how: "genesis" });
    const taken = await takePage(fresh, startRead(fresh, "service"), pageOf(first, null), NOW);
    expect([taken.verdict, taken.copy.entries, taken.copy.state, taken.copy.stop, standing(taken.copy)]).toEqual(["needs_newer_client", [], null, at(first.texts, 0), "stopped"]);
    const restarted = await saved(taken.copy);
    for (const copy of [taken.copy, restarted]) {
      expect([standing(copy), followStep(copy, NOW, { event: "doorbell" }), followStep(copy, NOW, { event: "tick", asked_at: null, busy: true }), shownPcs(copy), opens(copy, owner)])
        .toEqual(["stopped", { do: "wait", until: null }, { do: "wait", until: null }, [], "stopped"]);
      // Whatever it is shown, it stays as it is.
      const again = await takePage(copy, startRead(copy, "service"), pageOf(first, null), NOW);
      expect([again.verdict, again.copy]).toEqual(["needs_newer_client", copy]);
    }
    // Signed by another key than the pin asks for, it is not this member's list: nothing is kept, and it goes on asking.
    const others = pinned(first, DEVICE(phone), { how: "genesis" });
    const notMine = await takePage(others, startRead(others, "service"), pageOf(first, null), NOW);
    expect([notMine.verdict, notMine.copy.stop, standing(notMine.copy), followStep(notMine.copy, NOW, { event: "doorbell" })]).toEqual(["not_my_list", null, "waiting", { do: "read" }]);
    const migrated = pinned(first, PC(desk, 1), { how: "migrated", admitted: [phone.key] });
    expect((await takePage(migrated, startRead(migrated, "service"), pageOf(first, null), NOW)).verdict).toBe("not_my_list");
    // An entry that is not the pinned list's entry 0 is no stop a save may hold, and a member that holds entries has none before them.
    const sum = (body: string) => bytesToHex(sha256(utf8ToBytes(`${LIST_SAVE_PREFIX}${body}`)));
    const ordered = (value: unknown): string => (Array.isArray(value) ? `[${value.map(ordered).join(",")}]` : typeof value === "object" && value !== null
      ? `{${Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1)).map(([name, member]) => `${JSON.stringify(name)}:${ordered(member)}`).join(",")}}` : JSON.stringify(value));
    const withStop = (text: string, stop: string): string => {
      const save = JSON.parse(text) as Record<string, unknown>;
      save["stop"] = stop;
      delete save["sum"];
      return ordered({ ...save, sum: sum(ordered(save)) });
    };
    expect(await readSave(withStop(writeSave(taken.copy), at(BASE.texts, 0)))).toEqual({ read: false, why: "broken" });
    // Nor one that another key signed than the pin asks for.
    expect(await readSave(withStop(writeSave(others), at(first.texts, 0)))).toEqual({ read: false, why: "broken" });
    // A build that reads the entry: here a pin for a list whose entry 0 this build reads, saved as stopped at it by a build that did not.
    const readable = pinned(BASE, DEVICE(owner), { how: "genesis" });
    const on = await readSave(withStop(writeSave(readable), at(BASE.texts, 0)));
    expect(on).toMatchObject({ read: true, rebuilt: true, copy: { entries: [at(BASE.texts, 0)], stop: null } });
    expect(on.read && standing(on.copy)).toBe("in");
  });
});

describe("what a PC decides from its copy", () => {
  test("whether a device opens a session: its role, and for each refusal why", async () => {
    const log = await grow(BASE, [[owner, deviceOf(tablet, "bound", "watch")], [desk, deviceOf(browser, "bound", "drive", NOW + 60)], [owner, removeOf(tablet)]]);
    const copy = await followed(log, PC(desk, 1), { how: "added" });
    expect([opens(copy, owner), opens(copy, phone), opens(copy, tablet), opens(copy, browser), opens(copy, browser, NOW + 59), opens(copy, browser, NOW + 60)]).toEqual(["drive", "drive", "removed", "drive", "drive", "expired"]);
    // A PC's key, an invite's key, a key no entry names and no key at all are no devices.
    expect([opens(copy, desk), opens(copy, pool), opens(copy, box), opens(copy, mallory), admitsSession(copy, "constructor", NOW).why]).toEqual(["never_added", "never_added", "never_added", "never_added", "never_added"]);
    expect(admitsSession(copy, owner.key, NOW)).toEqual({ role: "drive", why: null });
    expect([nextUntil(copy, NOW), nextUntil(copy, NOW + 60), nextUntil(await followed(BASE, PC(desk, 1), { how: "added" }), NOW)]).toEqual([NOW + 60, null, null]);
    const watched = await followed(upTo(log, 5), PC(desk, 1), { how: "added" });
    expect(opens(watched, tablet)).toBe("watch");
    // Everyone it lets in now, in the order they came in, each as what and until when.
    expect(admittedDevices(copy, NOW).map((row) => [who(row.key), row.role, row.until])).toEqual([["owner", "drive", null], ["phone", "drive", null], ["browser", "drive", NOW + 60]]);
    expect(admittedDevices(copy, NOW + 60).map((row) => who(row.key))).toEqual(["owner", "phone"]);
    expect(admittedDevices(pinned(log, PC(desk, 1), { how: "added" }), NOW)).toEqual([]);
  });

  test("its clock never counts for less than it showed before: a clock set back lets no device in past its until", async () => {
    const log = await grow(BASE, [[desk, deviceOf(browser, "bound", "drive", NOW + 60)]]);
    const copy = await followed(log, PC(desk, 1), { how: "added" });
    expect([copy.seen_at, memberClock(copy, NOW - 500), memberClock(copy, NOW + 5), opens(copy, browser, NOW - 500)]).toEqual([NOW, NOW, NOW + 5, "drive"]);
    // A page, a hint, an answer that is refused: each is taken at the hour the clock shows, and the copy keeps the latest.
    const later = await takePage(copy, startRead(copy, "service"), { entries: ["junk"], head: headOf(log) }, NOW + 100);
    expect([later.verdict, later.copy.seen_at, later.copy.read_at]).toEqual(["refused", NOW + 100, NOW]);
    expect([opens(later.copy, browser, NOW + 100), opens(later.copy, browser, NOW - 500), opens(later.copy, browser, 0), nextUntil(later.copy, 0)]).toEqual(["expired", "expired", "expired", null]);
    expect(heardHead(copy, { list: OTHER.list, head: headOf(OTHER) }, NOW + 200).copy.seen_at).toBe(NOW + 200);
    // An earlier hour moves nothing.
    expect((await takePage(later.copy, startRead(later.copy, "service"), { entries: ["junk"], head: headOf(log) }, NOW - 9)).copy).toEqual(later.copy);
    expect(heardHead(later.copy, { list: OTHER.list, head: headOf(OTHER) }, NOW - 9).copy).toBe(later.copy);
    expect((await saved(later.copy)).seen_at).toBe(NOW + 100);
    expect(takePage(copy, startRead(copy, "service"), pageOf(log, 5), 1.5)).rejects.toThrow(RangeError);
    // With the account service away no page comes: the PC notes the hour itself whenever it reads its clock, and a clock set back after that lets nobody in again.
    expect([opens(copy, browser, NOW + 61), opens(copy, browser, NOW + 59)]).toEqual(["expired", "drive"]);
    const noted = withClock(copy, NOW + 61);
    expect([noted.seen_at, opens(noted, browser, NOW + 59), withClock(noted, NOW + 5), { ...noted, seen_at: NOW }]).toEqual([NOW + 61, "expired", noted, copy]);
    expect(withClock(noted, NOW + 5)).toBe(noted);
    expect(() => withClock(copy, -1)).toThrow(RangeError);
    // Over a restart it holds the hour it saved: the PC saves what it noted before it answers, and reads its clock again when it starts.
    const restarted = withClock(await saved(noted), NOW + 30);
    expect([restarted.seen_at, opens(restarted, browser, NOW + 30), admittedDevices(restarted, NOW + 30).map((row) => who(row.key))]).toEqual([NOW + 61, "expired", ["owner", "phone"]]);
    // A decision never counts the clock for less than the copy holds, whatever hour it is handed.
    expect([memberClock(noted, 0), memberClock(noted, NOW + 59), nextUntil(noted, NOW + 59)]).toEqual([NOW + 61, NOW + 61, null]);
    // Nor for less than the list's own time: the hour a full signer wrote into an entry that counted. A stranger's hour moves nothing.
    const strange = await reads(copy, serves(await add(log, mallory, epochOf(0), NOW + 900)));
    expect([memberClock(strange.copy, NOW), opens(strange.copy, browser, NOW)]).toEqual([NOW, "drive"]);
    const ahead = await reads(copy, serves(await add(log, owner, epochOf(0), NOW + 900)));
    expect([memberClock(ahead.copy, NOW), opens(ahead.copy, browser, NOW), admittedDevices(ahead.copy, NOW).map((row) => who(row.key))]).toEqual([NOW + 900, "expired", ["owner", "phone"]]);
  });

  test("nothing it lets in depends on when it last read, on what the service last answered, or on the service at all", async () => {
    const log = await grow(BASE, [[owner, deviceOf(tablet)], [owner, removeOf(phone)]]);
    const copy = await followed(log, PC(desk, 1), { how: "added" });
    const keys = [owner, phone, tablet, mallory];
    const held = keys.map((key) => opens(copy, key));
    expect(held).toEqual(["drive", "removed", "drive", "never_added"]);
    for (const read_at of [null, 0, NOW - 86400 * 365, NOW + 86400]) expect({ read_at, opens: keys.map((key) => opens({ ...copy, read_at }, key)) }).toEqual({ read_at, opens: held });
    // The service is away (nothing is taken), answers nothing, an old part, junk, or another list: the PC holds whom it held.
    const answers: readonly ListPage[] = [{ entries: [], head: { seq: 99, hash: "ab".repeat(32) } }, pageOf(upTo(log, 2), 6), pageOf(upTo(log, 2), null), pageOf(OTHER, 6), { entries: ["junk"], head: headOf(log) },
      { entries: [], head: { seq: 2, hash: "ab".repeat(32) } }, pageOf(await add(log, mallory, removeOf(owner)), 6)];
    for (const page of answers) {
      const taken = await takePage(copy, startRead(copy, "service"), page, NOW + 5000);
      expect({ page: page.head, opens: keys.map((key) => opens(taken.copy, key, NOW + 5000)), read_at: taken.copy.read_at === copy.read_at || taken.verdict === "caught_up" }).toEqual({ page: page.head, opens: held, read_at: true });
    }
    // And a session that has waited its time is decided on the copy as it is, however old.
    expect(followStep({ ...copy, read_at: 0 }, NOW, { event: "session", since: NOW - SESSION_WAIT_SECONDS })).toEqual({ do: "decide" });
  });

  test("which PC a key is, and which PCs a device shows", async () => {
    // A PC that was in the account before the list, then the phone, two PCs a person added, and one that joined and was put out.
    const log = await grow(await start(), [[owner, carriedPcOf(4)], [owner, deviceOf(phone)], [owner, pcOf(desk, 1)], [phone, inviteOf(pool)], [pool, joinOf(box, 2, pool)], [owner, pcOf(tower, 3)], [owner, removePcOf(2)]]);
    const device = await followed(log, DEVICE(phone), { how: "carried" });
    // The phone was not carried in: a device pinned that way waits. One that was allowed shows the PCs.
    expect([standing(device), shownPcs(device)]).toEqual(["waiting", []]);
    const allowed = await followed(log, DEVICE(phone), allowedAt(log, 2));
    expect(shownPcs(allowed).map((row) => [row.endpoint, row.how, row.allows])).toEqual([[E(4), "carried", false], [E(1), "added", true], [E(3), "added", true]]);
    expect([pcOfKey(allowed, desk.key), pcOfKey(allowed, tower.key), pcOfKey(allowed, box.key), pcOfKey(allowed, phone.key), pcOfKey(allowed, mallory.key), pcOfKey(allowed, "constructor")]).toEqual([E(1), E(3), null, null, null, null]);
    expect(pcOfKey(await followed(BASE, DEVICE(phone), allowedAt(BASE, 1)), box.key)).toBe(E(2));
    // The devices it shows are those that are in.
    const removed = await followed(await grow(log, [[owner, deviceOf(tablet)], [owner, removeOf(tablet)], [owner, deviceOf(browser, "bound", "watch", NOW + 5)]]), DEVICE(phone), allowedAt(log, 2));
    expect(shownDevices(removed).map((row) => [who(row.key), row.role, row.power])).toEqual([["owner", "drive", "full"], ["phone", "drive", "full"], ["browser", "watch", "bound"]]);
    expect(shownDevices(device)).toEqual([]);
    // A device that signed itself out shows nothing more.
    const out = await followed(await add(log, phone, removeOf(phone)), DEVICE(phone), allowedAt(log, 2));
    expect([standing(out), shownPcs(out), shownDevices(out), pcOfKey(out, desk.key)]).toEqual(["out", [], [], null]);
  });
});

describe("when a member reads", () => {
  test("a PC every 300 seconds and every 30 with a session open, a device every 30 while in front, and both when rung", async () => {
    const pc = await followed(BASE, PC(desk, 1), { how: "added" });
    const device = await followed(BASE, DEVICE(owner), { how: "genesis" });
    const tick = (copy: FollowerCopy, asked_at: number | null, busy: boolean, now = NOW) => followStep(copy, now, { event: "tick", asked_at, busy });
    expect([PC_READ_SECONDS, PC_BUSY_READ_SECONDS, DEVICE_READ_SECONDS, FRESH_SECONDS, SESSION_WAIT_SECONDS]).toEqual([300, 30, 30, 30, 5]);
    expect([tick(pc, null, false), tick(pc, NOW - 300, false), tick(pc, NOW - 299, false), tick(pc, NOW - 30, true), tick(pc, NOW - 29, true)])
      .toEqual([{ do: "read" }, { do: "read" }, { do: "wait", until: NOW + 1 }, { do: "read" }, { do: "wait", until: NOW + 1 }]);
    expect([tick(device, null, true), tick(device, NOW - 30, true), tick(device, NOW - 29, true), tick(device, null, false), tick(device, NOW - 3000, false)])
      .toEqual([{ do: "read" }, { do: "read" }, { do: "wait", until: NOW + 1 }, { do: "wait", until: null }, { do: "wait", until: null }]);
    // A clock that went back: read, and count from there.
    expect(tick(pc, NOW + 50, false)).toEqual({ do: "read" });
    expect([followStep(pc, NOW, { event: "doorbell" }), followStep(device, NOW, { event: "doorbell" }), followStep(pinned(BASE, DEVICE(phone), { how: "carried" }), NOW, { event: "doorbell" })]).toEqual([{ do: "read" }, { do: "read" }, { do: "read" }]);
    // The time runs from when the last read began, whether it was a full read or not.
    expect(tick({ ...pc, read_at: null }, NOW - 10, true)).toEqual({ do: "wait", until: NOW + 20 });
    // A member that is out reads no more.
    const out = (await reads(pc, serves(await add(BASE, owner, removeOf(desk))))).copy;
    expect([tick(out, null, true), followStep(out, NOW, { event: "doorbell" }), followStep(out, NOW, { event: "session", since: null })]).toEqual([{ do: "wait", until: null }, { do: "wait", until: null }, { do: "decide" }]);
  });

  test("a new session is decided at once on a copy read in the last 30 seconds; otherwise the PC reads and the session waits at most 5", async () => {
    const pc = await followed(BASE, PC(desk, 1), { how: "added" });
    const session = (read_at: number | null, since: number | null, now = NOW) => followStep({ ...pc, read_at }, now, { event: "session", since });
    expect([session(NOW, null), session(NOW - 30, null), session(NOW - 31, null), session(null, null), session(NOW + 9, null)])
      .toEqual([{ do: "decide" }, { do: "decide" }, { do: "read_and_wait", until: NOW + 5 }, { do: "read_and_wait", until: NOW + 5 }, { do: "read_and_wait", until: NOW + 5 }]);
    expect([session(NOW - 31, NOW - 1), session(NOW - 31, NOW - 4), session(NOW - 31, NOW - 5), session(NOW - 31, NOW - 500), session(NOW - 31, NOW + 3)])
      .toEqual([{ do: "wait", until: NOW + 4 }, { do: "wait", until: NOW + 1 }, { do: "decide" }, { do: "decide" }, { do: "decide" }]);
    // The read came back in time: the copy is fresh, and the session is decided.
    expect(session(NOW, NOW - 2)).toEqual({ do: "decide" });
  });

  test("the head the service names beside something else only says whether to read, and one that is the member's own counts as a full read", async () => {
    const log = await add(BASE, owner, deviceOf(tablet));
    const copy = await followed(BASE, PC(desk, 1), { how: "added" }, NOW - 400);
    const heard = (hint: unknown, held = copy) => heardHead(held, hint as ListHint, NOW);
    // Whatever it hears, nothing of the copy moves but its times.
    const seen = { ...copy, seen_at: NOW };
    expect(heard({ list: BASE.list, head: headOf(BASE) })).toEqual({ copy: { ...seen, read_at: NOW }, verdict: "same" });
    for (const hint of [{ list: BASE.list, head: headOf(log) }, { list: BASE.list, head: { seq: 4, hash: "ab".repeat(32) } }, { list: BASE.list, head: null }, { list: BASE.list, head: { seq: "4" } }]) {
      expect({ hint, heard: heard(hint) }).toEqual({ hint, heard: { copy: seen, verdict: "read" } });
    }
    expect(heard({ list: BASE.list, head: { seq: 2, hash: at(BASE.hashes, 2) } })).toEqual({ copy: seen, verdict: "older" });
    for (const hint of ["x", { list: OTHER.list, head: headOf(BASE) }, { list: null }]) expect({ hint, heard: heard(hint) }).toEqual({ hint, heard: { copy: seen, verdict: "not_my_list" } });
    // A service that names no list gives no hint: it is not the word that the list is gone, and not another list.
    for (const hint of [null, undefined]) expect({ hint, heard: heard(hint) }).toEqual({ hint, heard: { copy: seen, verdict: "none" } });
    // A member's own word on where it stands is another form: what a peer says is never taken for the service's, so it is never a full read.
    const peer = heard(gossipHead(copy));
    expect([peer.verdict, peer.copy.read_at]).toEqual(["read", copy.read_at]);
    expect(heard({ list: BASE.list, head: headOf(BASE) }, pinned(BASE, PC(desk, 1), { how: "added" })).verdict).toBe("read");
    // A device that was allowed is not told it is caught up by a head before the one it was handed.
    const waiting = (await reads(pinned(log, DEVICE(tablet), allowedAt(log)), serves(BASE))).copy;
    expect(heard({ list: BASE.list, head: headOf(BASE) }, waiting)).toEqual({ copy: waiting, verdict: "older" });
  });
});

/** A small generator with a seed, so a failing run can be played again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("over generated histories, with a service that lies", () => {
  /** What the test itself knows of a history it wrote, kept beside the log and never read from the library: who is in after each entry. */
  interface World { readonly log: Log; readonly devices: readonly Key[]; readonly out: readonly Key[]; readonly pcs: number; readonly epoch: number }
  /** A history that members wrote: the owner, a phone and the desk PC, then devices and PCs that come and go. `used` counts the keys it took. */
  async function history(random: () => number, length: number, first = 0): Promise<{ readonly worlds: readonly World[]; readonly used: number }> {
    let world: World = { log: await grow(await start(), [[owner, deviceOf(phone)], [owner, pcOf(desk, 1)]]), devices: [owner, phone], out: [], pcs: 1, epoch: 0 };
    const worlds: World[] = [world];
    let used = first;
    while (world.log.texts.length < length) {
      const by = at(world.devices, Math.floor(random() * world.devices.length));
      const way = random();
      const others = world.devices.filter((key) => key !== owner);
      if (way < 0.45) {
        const key = await spareKey(used++);
        world = { ...world, log: await add(world.log, by, deviceOf(key)), devices: [...world.devices, key] };
      } else if (way < 0.7 && others.length > 0) {
        const key = at(others, Math.floor(random() * others.length));
        world = { ...world, log: await add(world.log, by === key ? owner : by, removeOf(key)), devices: world.devices.filter((item) => item !== key), out: [...world.out, key] };
      } else if (way < 0.85) {
        const key = await spareKey(used++);
        world = { ...world, log: await add(world.log, by, pcOf(key, 10 + world.pcs)), pcs: world.pcs + 1 };
      } else {
        world = { ...world, log: await add(world.log, by, epochOf(world.epoch)), epoch: world.epoch + 1 };
      }
      worlds.push(world);
    }
    return { worlds, used };
  }
  const worldAt = (worlds: readonly World[], seq: number): World => at(worlds, Math.max(0, seq - 2));

  test("no member lets in a key that no member added, a removal once seen is never undone, a footing never goes back, and a restart from the save holds the same", async () => {
    const said = new Map<string, number>();
    for (let seed = 1; seed <= 6; seed++) {
      const random = seeded(seed);
      const pick = (most: number) => Math.floor(random() * most);
      const { worlds, used } = await history(random, 26);
      const real = at(worlds, worlds.length - 1).log;
      // Another history from the middle, by a member that the service got to sign: who it adds, a member added.
      const forkAt = 6 + pick(8);
      // Two members signed on it: the owner, and the device it added there.
      const forked = await grow(upTo(real, forkAt), [[owner, deviceOf(await spareKey(used))], [await spareKey(used), epochOf(worldAt(worlds, forkAt).epoch)]]);
      const everAdded = new Set([...worlds.flatMap((world) => world.devices), await spareKey(used)].map((key) => key.key));
      const outsiders = [mallory, eve];
      let junk = upTo(real, 3 + pick(real.texts.length - 4));
      for (const maker of [deviceOf(mallory), removeOf(owner), pcOf(eve, 9), inviteOf(eve)]) junk = await add(junk, mallory, maker);

      const members: FollowerCopy[] = [pinned(real, PC(desk, 1), { how: "added" }), pinned(real, DEVICE(phone), allowedAt(real, 1)), pinned(real, DEVICE(owner), { how: "genesis" })];
      const gone: Set<string>[] = members.map(() => new Set());
      const everyKey = [...new Set([...everAdded, ...outsiders.map((key) => key.key), desk.key])];
      const check = async (index: number, where: string) => {
        const copy = at(members, index);
        const before = copy.state?.footing;
        for (const key of everyKey) {
          const verdict = admitsSession(copy, key, NOW);
          if (verdict.role !== null) expect({ where, key: who(key), added: everAdded.has(key) }).toEqual({ where, key: who(key), added: true });
          if (verdict.why === "removed") at(gone, index).add(key);
          if (at(gone, index).has(key)) expect({ where, key: who(key), role: verdict.role }).toEqual({ where, key: who(key), role: null });
        }
        for (const key of outsiders) expect({ where, key: key.name, pc: pcOfKey(copy, key.key), shown: shownPcs(copy).some((row) => row.key === key.key) }).toEqual({ where, key: key.name, pc: null, shown: false });
        members[index] = await saved(copy);
        return before;
      };

      for (let step = 0; step < 36; step++) {
        const index = pick(members.length);
        const copy = at(members, index);
        const footing = copy.state?.footing ?? null;
        const way = pick(8);
        const limit = 1 + pick(6);
        const part = upTo(real, 2 + pick(real.texts.length - 2));
        const lies: readonly [string, (read: FollowRead) => ListPage][] = [
          ["honest", serves(real, limit)],
          ["a part as the whole", serves(part, limit)],
          ["a false head", (read) => ({ ...pageOf(part, read.after, limit), head: random() < 0.5 ? { seq: pick(60), hash: "ab".repeat(32) } : { seq: pick(real.texts.length), hash: at(real.hashes, pick(real.texts.length)) } })],
          ["its own entries", serves(junk, limit)],
          ["a changed character", (read) => {
            const page = pageOf(real, read.after, limit);
            const hit = pick(Math.max(1, page.entries.length));
            return { ...page, entries: page.entries.map((text, other) => (other === hit ? flipped(text, pick(text.length)) : text)) };
          }],
          ["another list", (read) => (random() < 0.5 ? pageOf(OTHER, read.after) : { ...pageOf(OTHER, read.after), list: real.list })],
          ["another history a member signed", serves(forked, limit)],
          ["the head of another history and nothing else", (read) => ({ ...pageOf(forked, read.after, limit), entries: [] })],
        ];
        const [name, answer] = at(lies, way);
        const where = `seed ${seed} step ${step} member ${index}: ${name}`;
        const read = await reads(copy, answer);
        members[index] = read.copy;
        const word = `${name}: ${lastOf(read)}`;
        said.set(word, (said.get(word) ?? 0) + 1);
        await check(index, where);
        const after = at(members, index).state?.footing ?? null;
        // The footing never goes back, and the entry there stays the member's own.
        if (footing !== null) {
          expect({ where, on: (after?.seq ?? -1) >= footing.seq, same: at(at(members, index).entries, footing.seq) === at(copy.entries, footing.seq) }).toEqual({ where, on: true, same: true });
        }
        // Whatever it holds is a history that members signed: the log's, or the other one, up to its footing.
        if (after !== null) {
          const mine = at(members, index).entries.slice(0, after.seq + 1);
          expect({ where, of: [real, forked].some((log) => log.texts.slice(0, mine.length).join() === mine.join()) }).toEqual({ where, of: true });
        }
        // Now and then two of them meet.
        if (random() < 0.3) {
          const other = (index + 1 + pick(members.length - 1)) % members.length;
          const met = await gossip(at(members, index), at(members, other), limit);
          members[index] = met.a;
          members[other] = met.b;
          for (const word of met.said) said.set(`met: ${word.split(" ")[2]}`, (said.get(`met: ${word.split(" ")[2]}`) ?? 0) + 1);
          await check(index, `${where}, then met ${other}`);
          await check(other, `${where}, then met by ${index}`);
          const [a, b] = [gossipHead(met.a), gossipHead(met.b)];
          // Two members that met stand at one entry, or both have the alarm: never two histories and no alarm.
          expect({ where, agree: JSON.stringify(a) === JSON.stringify(b) || (met.a.alarm !== null && met.b.alarm !== null), said: met.said }).toEqual({ where, agree: true, said: met.said });
        }
      }
      // At the end every member reads the honest log and meets every other: all on one history, or the alarm.
      for (const index of members.keys()) members[index] = (await reads(at(members, index), serves(real))).copy;
      for (const index of members.keys()) {
        for (const other of members.keys()) {
          if (other <= index) continue;
          const met = await gossip(at(members, index), at(members, other));
          members[index] = met.a;
          members[other] = met.b;
        }
      }
      const world = at(worlds, worlds.length - 1);
      for (const [index, copy] of members.entries()) {
        const where = `seed ${seed} at the end, member ${index}`;
        await check(index, where);
        if (copy.alarm !== null) continue;
        // With no alarm it holds the log, and lets in exactly whom the members that wrote it left in.
        expect({ where, entries: copy.entries.slice(0, real.texts.length) }).toEqual({ where, entries: [...real.texts] });
        if (index === 0) expect({ where, in: [...everAdded].filter((key) => admitsSession(copy, key, NOW).role !== null).map(who).sort() }).toEqual({ where, in: world.devices.map((key) => key.name).sort() });
      }
    }
    if (process.env["LIST_HISTORIES"]) console.log([...said].sort().map(([word, count]) => `${count} ${word}`).join("\n"));
    // The runs are no walk through one verdict: each lie was told, and each verdict was reached.
    const verdicts = new Set([...said.keys()].filter((word) => !word.startsWith("met: ")).map((word) => word.split(": ")[1]));
    expect([...verdicts].sort()).toEqual(expect.arrayContaining(["caught_up", "fork", "not_my_list", "older", "refused", "stuck", "withheld"]));
    expect([...said.keys()].filter((word) => word.startsWith("met: ")).sort()).toEqual(expect.arrayContaining(["met: caught_up", "met: fork"]));
  }, 240_000);

  test("two members that the service shows different parts and different lies come to one list when they meet, whatever the page size", async () => {
    for (let seed = 11; seed <= 16; seed++) {
      const random = seeded(seed);
      const pick = (most: number) => Math.floor(random() * most);
      const { worlds } = await history(random, 22, 40);
      const real = at(worlds, worlds.length - 1).log;
      let junk = upTo(real, 4 + pick(10));
      for (let index = 0; index < 1 + pick(5); index++) junk = await add(junk, mallory, index % 2 === 0 ? deviceOf(mallory) : removeOf(owner));
      const a = (await reads(pinned(real, PC(desk, 1), { how: "added" }), serves(random() < 0.5 ? junk : upTo(real, 3 + pick(18)), 1 + pick(5)))).copy;
      const b = (await reads(pinned(real, DEVICE(owner), { how: "genesis" }), serves(upTo(real, 3 + pick(19)), 1 + pick(5)))).copy;
      const limit = 1 + pick(7);
      const met = await gossip(a, b, limit);
      const where = `seed ${seed} limit ${limit}: ${met.said.join(", ")}`;
      expect({ where, heads: gossipHead(met.a), alarms: [met.a.alarm, met.b.alarm] }).toEqual({ where, heads: gossipHead(met.b), alarms: [null, null] });
      // Both stand where the one that was further stood, and what they hold up to there is the log.
      const further = Math.max(footingOf(a).seq, footingOf(b).seq);
      expect({ where, footing: footingOf(met.a).seq, entries: met.a.entries.slice(0, further + 1) }).toEqual({ where, footing: further, entries: real.texts.slice(0, further + 1) });
      expect({ where, state: stateOf(met.a) }).toEqual({ where, state: stateOf(met.b) });
    }
  }, 120_000);
});

describe("the save", () => {
  const sum = (body: string) => bytesToHex(sha256(utf8ToBytes(`${LIST_SAVE_PREFIX}${body}`)));
  /** A save's text with one member changed and the sum made again: what a careful hand at the member's store, or another build, would write. */
  const rewritten = (text: string, change: (save: Record<string, unknown>) => void): string => {
    const save = JSON.parse(text) as Record<string, unknown>;
    change(save);
    delete save["sum"];
    const body = canonicalOf(save);
    return canonicalOf({ ...save, sum: sum(body) });
  };
  /** JSON with each object's members in ascending order of name: written here, not taken from the library. */
  const canonicalOf = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalOf).join(",")}]`;
    if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, member]) => `${JSON.stringify(name)}:${canonicalOf(member)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  type SavedState = { signers: Record<string, { ended: number | null }>; devices: Record<string, unknown>; footing: ListPlace } & Record<string, unknown>;
  const stateIn = (save: Record<string, unknown>) => save["state"] as SavedState;

  test("is one text in one form, with a sum over the rest of it, and reads back to the very copy", async () => {
    const copy = await followed(BASE, PC(desk, 1), { how: "added" });
    const text = writeSave(copy);
    const save = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(save)).toEqual(["account", "alarm", "entries", "footing", "level", "list", "me", "pin", "read_at", "seen_at", "state", "stop", "sum", "v"]);
    expect([save["v"], save["level"], save["list"], save["entries"], save["footing"], save["read_at"], text === canonicalOf(save)]).toEqual([1, 1, BASE.list, [...BASE.texts], { hash: headOf(BASE).hash, seq: 4 }, NOW, true]);
    const { sum: written, ...rest } = save;
    expect(written).toBe(sum(canonicalOf(rest)));
    expect(await readSave(text)).toEqual({ read: true, copy, rebuilt: false });
    // A member that has read nothing saves its pin alone.
    const empty = pinned(BASE, DEVICE(tablet), allowedAt(BASE));
    expect(await readSave(writeSave(empty))).toEqual({ read: true, copy: empty, rebuilt: false });
    expect(writeSave(empty)).toContain(`"entries":[],"footing":null,"level":1,"list":"${BASE.list}"`);
  });

  test("a save that is not the text that was written does not read: no part of it is taken", async () => {
    const copy = await followed(BASE, PC(desk, 1), { how: "added" });
    const text = writeSave(copy);
    const why = async (changed: string) => {
      const read = await readSave(changed);
      return read.read ? "read" : read.why;
    };
    expect([await why(""), await why("{"), await why("null"), await why("[]"), await why(text.slice(0, -1)), await why(` ${text}`), await why(text.replace(`"v":1`, `"v":1,"w":1`)), await why(text.replace(`"account"`, `"Account"`))])
      .toEqual(["form", "form", "form", "form", "form", "form", "form", "form"]);
    // A later build's save is not read, and is not taken for a damaged one.
    expect([await why(text.replace(`"v":1`, `"v":2`)), await why(rewritten(text, (save) => { save["v"] = 2; save["later"] = true; })), await why(text.replace(`"v":1`, `"v":0`))]).toEqual(["version", "version", "form"]);
    // One character changed, anywhere: it reads as nothing, whatever the character was part of.
    const whys = new Set<string>();
    for (let index = 0; index < text.length; index += Math.max(1, Math.floor(text.length / 400))) {
      const changed = flipped(text, index);
      const read = await readSave(changed);
      expect({ index, read: read.read }).toEqual({ index, read: false });
      if (!read.read) whys.add(read.why);
    }
    expect([...whys].sort()).toEqual(["form", "sum"]);
    // The members in another order, or with white space: not the one form.
    expect(await why(JSON.stringify(JSON.parse(text), null, 1))).toBe("form");
    expect(await why(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text) as object).reverse())))).toBe("form");
  });

  test("the entries are what a save holds as true: a state that is not the one they give is rebuilt from them, and nobody needs a reset for it", async () => {
    const log = await grow(BASE, [[owner, deviceOf(tablet)], [owner, removeOf(phone)]]);
    const copy = await followed(log, PC(desk, 1), { how: "added" });
    const text = writeSave(copy);
    const changes: readonly (readonly [string, (save: Record<string, unknown>) => void])[] = [
      // What a hand at the store may try: the state says more than the entries do.
      ["a removed device made a member again", (save) => { at(Object.values(stateIn(save).signers).filter((row) => row.ended !== null), 0).ended = null; }],
      ["a device put into the state that no entry adds", (save) => { stateIn(save).devices[mallory.key] = { role: "drive", until: null, enc: mallory.enc, carried: false }; }],
      ["a stranger made the first signer's equal", (save) => { (stateIn(save).signers as Record<string, unknown>)[mallory.key] = { power: "full", seq: 1, by: owner.key, ended: null, as: "device" }; }],
      // What another build may have saved: a state with a member less, one more, another form of one, another level, or none.
      ["a state without a member this build holds", (save) => { delete stateIn(save)["full_at"]; }],
      ["a state with a member this build does not know", (save) => { stateIn(save)["later"] = { 1: "x" }; }],
      ["a state whose rows have another form", (save) => { stateIn(save)["pcs"] = []; }],
      ["a state of no form at all", (save) => { save["state"] = { v: 7 }; }],
      ["no state", (save) => { save["state"] = null; }],
    ];
    for (const [name, change] of changes) {
      const read = await readSave(rewritten(text, change));
      expect({ name, read }).toEqual({ name, read: { read: true, copy, rebuilt: true } });
      if (read.read) expect({ name, opens: [opens(read.copy, phone), opens(read.copy, tablet), opens(read.copy, mallory)] }).toEqual({ name, opens: ["removed", "drive", "never_added"] });
    }
    // What was rebuilt is saved as this build saves it, and reads as it is from then on.
    const rebuilt = await readSave(rewritten(text, (save) => { save["state"] = { v: 7 }; }));
    expect(rebuilt.read && writeSave(rebuilt.copy)).toBe(text);
    // The same hand changing nothing: nothing is rebuilt.
    expect(await readSave(rewritten(text, () => undefined))).toEqual({ read: true, copy, rebuilt: false });
    // A save of a later level whose entries this build can place reads too, as this build's own.
    expect(await readSave(rewritten(text, (save) => { save["level"] = 3; stateIn(save)["level"] = 3; }))).toEqual({ read: true, copy, rebuilt: true });
  });

  test("a save whose entries do not hold is broken: nothing is rebuilt from entries that are not what was saved", async () => {
    const log = await grow(BASE, [[owner, deviceOf(tablet)], [owner, removeOf(phone)]]);
    const copy = await followed(log, PC(desk, 1), { how: "added" });
    const text = writeSave(copy);
    const changes: readonly (readonly [string, string, (save: Record<string, unknown>) => void])[] = [
      ["the last entry left out: the entries end before the saved footing", "broken", (save) => { (save["entries"] as string[]).pop(); }],
      ["every entry from the removal on left out", "broken", (save) => { (save["entries"] as string[]).length = 6; }],
      ["another entry at the saved footing", "broken", (save) => { save["footing"] = { hash: "ab".repeat(32), seq: 6 }; }],
      ["a footing past the entries", "broken", (save) => { save["footing"] = { hash: at(log.hashes, 6), seq: 7 }; }],
      ["no footing for a member that holds entries", "broken", (save) => { save["footing"] = null; }],
      ["an entry of another list among them", "broken", (save) => { (save["entries"] as string[])[3] = at(OTHER.texts, 1); }],
      ["an entry changed", "broken", (save) => { (save["entries"] as string[])[2] = flipped(at(log.texts, 2), 40); }],
      ["an entry's signature changed", "broken", (save) => { (save["entries"] as string[])[2] = flipped(at(log.texts, 2), at(log.texts, 2).length - 40); }],
      ["two entries in each other's place", "broken", (save) => { const entries = save["entries"] as string[]; [entries[3], entries[4]] = [at(entries, 4), at(entries, 3)]; }],
      ["no text on top", "broken", (save) => { (save["entries"] as string[]).push("junk"); }],
      ["another list id", "broken", (save) => { save["list"] = OTHER.list; }],
      ["another account", "broken", (save) => { save["account"] = "TEST-ONLY-other"; }],
      ["a stopped entry for a member that did not stop", "broken", (save) => { save["stop"] = at(log.texts, 1); }],
      ["a footing with nothing read", "broken", (save) => { save["entries"] = []; }],
      ["a pin of a device for a PC", "form", (save) => { save["pin"] = { how: "genesis" }; }],
      ["a pin with a member too many", "form", (save) => { save["pin"] = { how: "added", seq: 1 }; }],
      ["a read time that is no number", "form", (save) => { save["read_at"] = "now"; }],
      ["a member that names no key", "form", (save) => { save["me"] = { endpoint: E(1), key: "x" }; }],
      ["a member with something more to it", "form", (save) => { save["me"] = { endpoint: E(1), key: desk.key, name: "desk" }; }],
      ["a footing with a member too many", "form", (save) => { save["footing"] = { hash: at(log.hashes, 6), seq: 6, v: 1 }; }],
      ["a level that is none", "form", (save) => { save["level"] = 0; }],
      ["an alarm out of form", "form", (save) => { save["alarm"] = { at: NOW, code: "fork", devices: [], pcs: [], seq: 3, source: "peer" }; }],
      ["an alarm whose devices are in no order", "form", (save) => { save["alarm"] = { at: NOW, by: owner.key, code: "fork", devices: [owner.key, owner.key], pcs: [], seq: 3, source: "peer" }; }],
    ];
    for (const [name, expected, change] of changes) {
      const read = await readSave(rewritten(text, change));
      expect({ name, why: read.read ? "read" : read.why }).toEqual({ name, why: expected });
    }
    // A footing named at an entry that no signer signed: the entries are all there and hold, and the history a member signed ends before it.
    const junk = await grow(log, [[mallory, deviceOf(mallory)], [mallory, removeOf(owner)]]);
    const loose = (await reads(copy, serves(junk))).copy;
    expect([loose.entries.length, footingOf(loose).seq]).toEqual([9, 6]);
    expect(await readSave(rewritten(writeSave(loose), (save) => { save["footing"] = { hash: at(junk.hashes, 8), seq: 8 }; }))).toEqual({ read: false, why: "broken" });
    expect(await readSave(rewritten(writeSave(loose), (save) => { save["footing"] = { hash: at(junk.hashes, 8), seq: 8 }; save["level"] = 2; }))).toEqual({ read: false, why: "version" });
    // A footing named before the true one costs nothing: the replay holds the whole history the entries give.
    // The save is written again with the true one, which is what `rebuilt` says.
    expect(await readSave(rewritten(writeSave(loose), (save) => { save["footing"] = { hash: at(junk.hashes, 3), seq: 3 }; }))).toEqual({ read: true, copy: loose, rebuilt: true });
    // An alarm in its form is kept, whatever it names: nothing about it makes a save unreadable.
    const alarm = { at: NOW, by: mallory.key, code: "fork", devices: [mallory.key], pcs: [E(9)], seq: 30, source: "peer" };
    expect(await readSave(rewritten(text, (save) => { save["alarm"] = alarm; }))).toEqual({ read: true, copy: { ...copy, alarm } as FollowerCopy, rebuilt: false });
    // A genesis pin whose entry 0 another key signed, and a migrated PC whose first signer it never let in.
    const asOwner = writeSave(await followed(log, DEVICE(owner), { how: "genesis" }));
    expect(await readSave(rewritten(asOwner, (save) => { save["me"] = { endpoint: null, key: phone.key }; }))).toEqual({ read: false, why: "broken" });
    const migrated = writeSave(await followed(log, PC(desk, 1), { how: "migrated", admitted: [owner.key] }));
    expect(await readSave(rewritten(migrated, (save) => { save["pin"] = { admitted: [phone.key], how: "migrated" }; }))).toEqual({ read: false, why: "broken" });
  });

  test("an alarm holds whatever key the list holds as a device, also one that is no point of the curve: its save reads", async () => {
    // A key in its one spelling whose point is off the curve: the owner's own with the last byte changed. A carried entry has no card, so the list takes it.
    const bytes = Uint8Array.from(atob(owner.key.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const offCurve = toBase64Url(bytes);
    const head = await grow(await start(), [[owner, () => ({ kind: "carried", key: offCurve, role: "drive", sealed: null })], [owner, pcOf(desk, 1)]]);
    const pc = await followed(await add(head, owner, deviceOf(phone)), PC(desk, 1), { how: "added" });
    expect(shownDevices(pc).map((row) => row.key)).toContain(offCurve);
    // Another history from place 3 that the owner and the desk PC signed.
    const fork = await takePage(pc, { ...startRead(pc, "service"), after: 2 }, pageOf(await grow(head, [[owner, epochOf(0)], [desk, epochOf(1)]]), 2), NOW);
    expect([fork.verdict, fork.copy.alarm?.devices.includes(offCurve)]).toEqual(["fork", true]);
    expect(await readSave(writeSave(fork.copy))).toEqual({ read: true, copy: fork.copy, rebuilt: false });
  });

  test("a member that stopped keeps its stop over a restart, goes on when its build can place the entry, and a later build's entries are a later build's save", async () => {
    const behind = await addRaw(BASE, owner, { kind: "later_kind", v: 2 });
    const stopping = await addRaw(behind, mallory, { kind: "later_kind", v: 2 });
    const stopped = (await reads(await followed(behind, PC(desk, 1), { how: "added" }), serves(stopping))).copy;
    const text = writeSave(stopped);
    expect(await readSave(text)).toEqual({ read: true, copy: stopped, rebuilt: false });
    // Its state lost: it is rebuilt stopped at the same entry, and answers for nobody as before.
    const again = await readSave(rewritten(text, (save) => { save["state"] = null; }));
    expect(again).toEqual({ read: true, copy: stopped, rebuilt: true });
    expect(again.read && [standing(again.copy), opens(again.copy, owner)]).toEqual(["stopped", "stopped"]);
    // A build that can place the entry a save names as stopped takes it and goes on: here an entry that every build places.
    const next = await add(BASE, owner, deviceOf(tablet));
    const before = await followed(BASE, PC(desk, 1), { how: "added" });
    const on = await readSave(rewritten(writeSave(before), (save) => { save["stop"] = at(next.texts, 5); }));
    expect(on).toMatchObject({ read: true, rebuilt: true, copy: { entries: next.texts, stop: null } });
    expect(on.read && [standing(on.copy), opens(on.copy, tablet), footingOf(on.copy)]).toEqual(["in", "drive", headOf(next)]);
    // Another entry than the next one as the stopped entry: the entries do not hold.
    expect(await readSave(rewritten(text, (save) => { save["stop"] = at(BASE.texts, 2); }))).toEqual({ read: false, why: "broken" });
    // The stopped entry among the entries: this build cannot place it there. From a later level's save that is a later build's; from this level's, not what was saved.
    const among = (level: number) => rewritten(text, (save) => { (save["entries"] as string[]).push(save["stop"] as string); save["stop"] = null; save["level"] = level; });
    expect([await readSave(among(2)), await readSave(among(1))]).toEqual([{ read: false, why: "version" }, { read: false, why: "broken" }]);
  });

  test("a restart at any place of a read holds what a member that never restarted holds", async () => {
    const log = await grow(BASE, [[owner, deviceOf(tablet)], [mallory, deviceOf(mallory)], [mallory, epochOf(0)]]);
    const real = await grow(upTo(log, 5), [[tablet, removeOf(phone)], [owner, epochOf(0)], [owner, pcOf(tower, 3)]]);
    const straight = await reads((await reads(pinned(log, PC(desk, 1), { how: "added" }), serves(log, 2))).copy, serves(real, 2));
    let copy = pinned(log, PC(desk, 1), { how: "added" });
    for (const served of [log, real]) {
      let read: FollowRead | null = startRead(copy, "service");
      while (read !== null) {
        const taken: PageResult = await takePage(await saved(copy), read, pageOf(served, read.after, 2), NOW);
        copy = await saved(taken.copy);
        read = taken.read;
      }
    }
    expect(copy).toEqual(straight.copy);
    expect([copy.entries, opens(copy, phone), pcOfKey(copy, tower.key)]).toEqual([real.texts, "removed", E(3)]);
  });
});

describe("the vectors of save/", () => {
  const DIR = joinPath(import.meta.dir, "account-list-vectors", "save");
  interface SaveVector {
    readonly name: string;
    readonly keys: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
    readonly save: string;
    readonly now: number;
    readonly expect:
      | { readonly reads: { readonly rebuilt: boolean; readonly account: string; readonly list: string; readonly me: FollowerSelf; readonly pin: ListPin; readonly head: ListPlace | null; readonly footing: ListPlace | null; readonly standing: string; readonly stop: boolean; readonly alarm: { readonly seq: number; readonly by: string } | null; readonly read_at: number | null; readonly seen_at: number | null; readonly opens: Readonly<Record<string, string>> } }
      | { readonly refused: string };
  }
  const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(joinPath(DIR, file), "utf8")) as SaveVector);

  test("there is a vector for each pin, each standing, each refusal and a save that is rebuilt", () => {
    const pins = new Set(vectors.flatMap((vector) => ("reads" in vector.expect ? [vector.expect.reads.pin.how] : [])));
    const standings = new Set(vectors.flatMap((vector) => ("reads" in vector.expect ? [vector.expect.reads.standing] : [])));
    const refusals = new Set(vectors.flatMap((vector) => ("refused" in vector.expect ? [vector.expect.refused] : [])));
    expect([[...pins].sort(), [...standings].sort(), [...refusals].sort()]).toEqual([["added", "allowed", "carried", "genesis", "migrated"], ["in", "out", "stopped", "waiting"], ["broken", "form", "sum", "version"]]);
    expect(vectors.filter((vector) => "reads" in vector.expect && vector.expect.reads.rebuilt).length).toBeGreaterThanOrEqual(2);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(`save/${vector.name}`, async () => {
      const read = await readSave(vector.save);
      if ("refused" in vector.expect) {
        expect(read).toEqual({ read: false, why: vector.expect.refused as "form" });
        return;
      }
      if (!read.read) throw new Error(`the save does not read: ${read.why}`);
      const { copy } = read;
      const expected = vector.expect.reads;
      const last = copy.entries.at(-1);
      const head = last === undefined ? null : { seq: copy.entries.length - 1, hash: entryHash(entryFromText(last).body) };
      expect<unknown>({ rebuilt: read.rebuilt, account: copy.account, list: copy.list, me: copy.me, pin: copy.pin, head, footing: copy.state?.footing ?? null, standing: standing(copy), stop: copy.stop !== null, alarm: copy.alarm === null ? null : { seq: copy.alarm.seq, by: copy.alarm.by }, read_at: copy.read_at, seen_at: copy.seen_at })
        .toEqual({ rebuilt: expected.rebuilt, account: expected.account, list: expected.list, me: expected.me, pin: expected.pin, head: expected.head, footing: expected.footing, standing: expected.standing, stop: expected.stop, alarm: expected.alarm, read_at: expected.read_at, seen_at: expected.seen_at });
      for (const [name, word] of Object.entries(expected.opens)) {
        const said = admitsSession(copy, at(Object.entries(vector.keys).filter(([key]) => key === name), 0)[1].spki, vector.now);
        expect<unknown>({ name, opens: said.role ?? said.why }).toEqual({ name, opens: word });
      }
      // Written again it is the same text: a save has one form. One that was rebuilt is written as this build writes it, and reads as it is from then on.
      const again = writeSave(copy);
      expect(again !== vector.save).toBe(read.rebuilt);
      expect(await readSave(again)).toEqual({ read: true, copy, rebuilt: false });
    });
  }
});
