import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  entryFromText, entryHash, entryToText, readBody, readFields, signEntry, writeFieldsUnder,
  type EntryBody, type HeldEntry, type SignerPower,
} from "./account-list-entry.ts";
import {
  CARD_SIGNATURE_CHARS, EPOCH_LINK_BYTES, INVITE_SECONDS_MAX, INVITE_USES_MAX, LIST_CARD_PREFIX, LIST_LEVEL, LIST_LEVEL_TABLE, LIST_READ_PREFIX, ListKindError, ListWriteError, ReadProofError,
  SEALED_MIN_BYTES, admitsDevice, cardBinding, cardBytes, cardHolds, checkReadProof, firstListState, holdsPc, inviteRefusal, isListKey, isListLabel, joinEntry, kindBody, listView, namesFields, readKind,
  lapsedRemovals, listClock, pcRemoval, readListState, readNames, readProofRefusal, replayList, rowsNamed, sealEpoch, shownList, signCard, signGenesis, signListEntries, signListEntry, signReadProof, takeEntry,
  wrapKeys,
  type EntryPlace, type ListCard, type ListCopy, type ListKind, type ListOutcome, type ListRole, type ListState, type ReadProof, type Sealed,
} from "./account-list.ts";
import { JoinLineSignError, readJoinLine, writeJoinLine, type JoinLine } from "./account-list-join.ts";
import { judgeEntry, listHead, readSignersState, signerPower, signingPlace } from "./account-list-signers.ts";
import { commitmentHolds, fromBase64Url, pairCommitment, pairDigits, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const T0 = 1767225600;
/** Four hours after the first entry: at most 7 days after any entry of a test list. */
const EXP = T0 + 14400;
/** A sealed value as this file sees one: bytes it never opens, no shorter than a sealed value can be. */
const SEALED = Uint8Array.from({ length: 60 }, (_, index) => index);
/** The commitment to an epoch's key, and the key of the epoch before under it: values this file never opens either. */
const OPENS = (epoch: number) => (epoch + 10).toString(16).padStart(2, "0").repeat(32);
const LINK = (epoch: number) => new Uint8Array(EPOCH_LINK_BYTES).fill(epoch);
/** The epoch whose key the entries a test writes are sealed under: 0 until a test moves it. */
let sealedUnder = 0;
const sealed = (): Own => ({ epoch: String(sealedUnder), sealed: SEALED });
const SEAL: Sealed = { epoch: 0, bytes: SEALED };

interface Key { readonly name: string; readonly key: string; readonly enc: string; readonly pair: CryptoKeyPair }
const names = new Map<string, string>();
const spki = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
async function newKey(name: string): Promise<Key> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const key = await spki(pair.publicKey);
  const enc = await spki((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])).publicKey);
  names.set(key, name);
  return { name, key, enc, pair };
}
/** The first device; two more devices; a PC that a person adds and another; an invite that needs no person, a second, and one that needs a person; a device added late; a key no entry adds; another key. */
const owner = await newKey("owner");
const phone = await newKey("phone");
const tablet = await newKey("tablet");
const desk = await newKey("desk");
const tower = await newKey("tower");
const pool = await newKey("pool");
const pool2 = await newKey("pool2");
const plain = await newKey("plain");
const late = await newKey("late");
const stranger = await newKey("stranger");
const other = await newKey("other");
/** A PC's relay key. */
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
/** The keys of the PC at relay key n: made once. */
const machines = new Map<number, Key>();
async function machine(n: number): Promise<Key> {
  const made = machines.get(n) ?? await newKey(`machine${n}`);
  machines.set(n, made);
  return made;
}

type Own = Readonly<Record<string, string | Uint8Array>>;
/** An entry as a test writes it: any kind, any fields. */
interface Raw {
  readonly kind: string;
  readonly v?: number;
  readonly adds?: readonly [Key, SignerPower];
  readonly ends?: Key;
  readonly own?: Own;
  /** Signed with this key while `signer` names another. */
  readonly signedWith?: Key;
}

function bodyOf(raw: Raw, by: Key, place: { readonly seq: number; readonly list: string; readonly prev: string }): EntryBody {
  return {
    issued_at: T0 + 60 * place.seq, kind: raw.kind, list: place.list, prev: place.prev, seq: place.seq, signer: by.key, v: raw.v ?? 1,
    ...(raw.adds ? { adds: { key: raw.adds[0].key, power: raw.adds[1] } } : {}),
    ...(raw.ends ? { ends: raw.ends.key } : {}),
    own: Object.entries(raw.own ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => ({ name, value: typeof value === "string" ? utf8ToBytes(value) : value })),
  };
}
/** An entry of a test list: its text, and the entry as it holds. */
interface Link { readonly text: string; readonly held: HeldEntry }
async function link(body: EntryBody, signedWith: Key, list: string | null): Promise<Link> {
  const entry = await signEntry(body, signedWith.pair.privateKey);
  const hash = entryHash(entry.body);
  return { text: entryToText(entry), held: { entry, body: readBody(entry.body), hash, list: list ?? hash } };
}
const genesis = (by: Key = owner, account = "TEST-ONLY-account"): Raw => ({ kind: "genesis", own: { account, enc: by.enc, epoch: "0", epoch_opens: OPENS(0), sealed: SEALED } });
/** Entry 0: the owner's genesis unless the test says otherwise. */
const first = (raw: Raw = genesis(), by: Key = owner) => link(bodyOf(raw, by, { seq: 0, list: "", prev: "" }), raw.signedWith ?? by, null);
const next = (before: Link, by: Key, raw: Raw) =>
  link(bodyOf(raw, by, { seq: before.held.body.seq + 1, list: before.held.list, prev: before.held.hash }), raw.signedWith ?? by, before.held.list);
const LIST_OF = { id: "" };
/** An entry from a body a test wrote itself (another time than its place gives, say), signed by a key. */
const link2 = (body: EntryBody, by: Key) => link(body, by, LIST_OF.id);
/** The id of every test list that starts with the owner's genesis: an entry's hash is of its body, which has nothing random in it. */
const LIST = (await first()).held.hash;
LIST_OF.id = LIST;

const card = (key: Key, endpoint: string | null = null, more: Partial<ListCard> = {}) => signCard({ key: key.key, enc: key.enc, list: LIST, endpoint, invite: null, ...more }, key.pair.privateKey);
const device = async (key: Key, power: SignerPower = "full", role: ListRole = "drive", more: Own = {}): Promise<Raw> =>
  ({ kind: "device", adds: [key, power], own: { card: await card(key), enc: key.enc, role, ...sealed(), ...more } });
const pc = async (key: Key, n: number): Promise<Raw> => ({ kind: "pc", adds: [key, "full"], own: { card: await card(key, E(n)), enc: key.enc, endpoint: E(n), ...sealed() } });
const invite = (key: Key, uses: number | string = 5, auto: boolean | string = true, exp: number | string = EXP): Raw =>
  ({ kind: "invite", adds: [key, "bound"], own: { auto: typeof auto === "string" ? auto : auto ? "1" : "0", exp: String(exp), ...sealed(), uses: String(uses) } });
/** The join of the PC at relay key n, with the invite `by`: the PC's card names the invite it joins with. */
const join = async (n: number, as?: Key, by: Key = pool): Promise<Raw> => {
  const key = as ?? await machine(n);
  return { kind: "join", own: { card: await card(key, E(n), { invite: by.key }), enc: key.enc, endpoint: E(n), pc: key.key, ...sealed() } };
};
const remove = (key: Key): Raw => ({ kind: "remove", ends: key });
const removePc = (n: number): Raw => ({ kind: "remove", own: { endpoint: E(n) } });
const carried = (key: Key, role: string = "drive"): Raw => ({ kind: "carried", adds: [key, "full"], own: { role, ...sealed() } });
const carriedPc = (n: number): Raw => ({ kind: "carried", own: { endpoint: E(n), ...sealed() } });
const cardOf = (key: Key): Raw => ({ kind: "card", own: { enc: key.enc } });
/** The entry that opens the epoch after `current`. */
const opening = (current: number): Raw => ({ kind: "epoch", own: { epoch: String(current), epoch_link: LINK(current + 1), epoch_opens: OPENS(current + 1) } });
/** The same entry with no names: what a member writes that holds no key to seal them with. */
const bare = (raw: Raw): Raw => less(less(raw, "sealed"), "epoch");
const later = (v = 2, more: Partial<Raw> = {}): Raw => ({ kind: "later_kind", v, ...more });
/** The same entry with one more own field, with one own field less, and with one own field's value changed. */
const plus = (raw: Raw, own: Own = { note: "x" }): Raw => ({ ...raw, own: { ...raw.own, ...own } });
const less = (raw: Raw, name: string): Raw => ({ ...raw, own: Object.fromEntries(Object.entries(raw.own ?? {}).filter(([field]) => field !== name)) });

const who = (key: string | null): string => (key === null ? "a proof" : names.get(key) ?? "?");
const pcName = (endpoint: string): string => `e${Number.parseInt(endpoint.slice(0, 2), 16)}`;
/** What became of an entry, in a word or two. */
const said = (outcome: ListOutcome): string => ("code" in outcome ? `${outcome.outcome} ${outcome.code}` : outcome.outcome);
/** A state in a few words: each key that was made a signer, each device, each PC, each invite's joins of its uses. */
function seen(state: ListState) {
  return {
    signers: Object.fromEntries(Object.entries(state.signers).map(([key, row]) =>
      [who(key), `${row.power} ${row.as ?? "no name"} @${row.seq} by ${who(row.by)}${row.ended === null ? "" : ` ended@${row.ended}`}`])),
    devices: Object.fromEntries(Object.entries(state.devices).map(([key, row]) =>
      [who(key), `${row.role}${row.until === null ? "" : ` until ${row.until - T0}`}${row.enc === null ? " no enc" : ""}${row.carried ? " carried" : ""}`])),
    pcs: Object.fromEntries(Object.entries(state.pcs).map(([endpoint, row]) =>
      [pcName(endpoint), `${row.how}${row.key === null ? "" : ` ${who(row.key)}`} @${row.seq}${row.invite === null ? "" : ` with ${who(row.invite)}`}${row.removed === null ? "" : ` removed@${row.removed}`}`])),
    invites: Object.fromEntries(Object.entries(state.invites).map(([key, row]) => [who(key), `${row.joins} of ${row.uses}${row.auto ? " auto" : ""}`])),
  };
}
const OWNER = "full device @0 by owner";
/** Whether an entry's signature is that of a key over its body. */
const verifyBody = async (entry: { readonly body: Uint8Array; readonly signature: Uint8Array }, key: string) =>
  await crypto.subtle.verify(SIGN, await crypto.subtle.importKey("spki", fromBase64Url(key) as Uint8Array<ArrayBuffer>, P256, false, ["verify"]), entry.signature as Uint8Array<ArrayBuffer>, entry.body as Uint8Array<ArrayBuffer>);

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}
const only = <Row>(rows: { readonly [name: string]: Row }, wanted: readonly (string | null | undefined)[]): { [name: string]: Row } =>
  Object.fromEntries(Object.entries(rows).filter(([name]) => wanted.includes(name)));
const ownText = (body: EntryBody, name: string): string | null => {
  const field = body.own.find((item) => item.name === name);
  return field === undefined ? null : Buffer.from(field.value).toString("latin1");
};
/**
 * The rows one entry names, written here from the text and not taken from the library: its `signer`, its `adds`, its `ends` and the key
 * in its `pc`, among the signers, the devices, the invites and the PCs' keys; the PC of its `endpoint`, with the signer's row of that PC's key, and the PC whose key it ends;
 * and, for an entry that an invite signed, whoever placed it.
 */
function cutDown(state: ListState, body: EntryBody): ListState {
  const keys = [body.signer, body.adds?.key, body.ends, ownText(body, "pc")];
  const signer = state.signers[body.signer];
  return {
    ...state,
    signers: only(state.signers, [...keys, signer?.as === "invite" ? signer.by : null, state.pcs[ownText(body, "endpoint") ?? ""]?.key]),
    devices: only(state.devices, keys),
    invites: only(state.invites, keys),
    pc_keys: only(state.pc_keys, keys),
    pcs: only(state.pcs, [ownText(body, "endpoint"), body.ends === undefined ? null : state.pc_keys[body.ends]]),
  };
}
const withoutNames = (state: ListState) => Object.fromEntries(Object.entries(state.signers).map(([key, { power, seq, by, ended }]) => [key, { power, seq, by, ended }]));
const PARTS = ["signers", "devices", "pcs", "pc_keys", "invites"] as const;
/**
 * takeEntry, with what holds for every entry checked beside it: it changes nothing it was given; on the rows the entry names it gives
 * the same outcome and the same rows; the rows it gives back, put into the whole state, are the whole new state; the new state reads
 * again from its JSON; and its signers are the signers' own.
 */
async function taken(state: ListState, held: HeldEntry) {
  const given = JSON.stringify(state);
  const whole = await takeEntry(deepFreeze(state), held);
  expect(JSON.stringify(state)).toBe(given);
  const cut = cutDown(state, held.body);
  expect(rowsNamed(state, held.body)).toEqual(cut);
  const onCut = await takeEntry(deepFreeze(cut), held);
  expect(onCut.outcome).toEqual(whole.outcome);
  expect(onCut.state).toEqual(cutDown(whole.state, held.body));
  const merged = { ...onCut.state, ...Object.fromEntries(PARTS.map((part) => [part, { ...state[part], ...onCut.state[part] }])) };
  expect(merged as ListState).toEqual(whole.state);
  expect(readListState(JSON.parse(JSON.stringify(whole.state)), whole.state.level)).toEqual(whole.state);
  const signers = judgeEntry(state, held).state;
  expect([whole.state.footing, whole.state.needs, whole.state.behind, withoutNames(whole.state)])
    .toEqual([signers.footing, signers.needs, signers.behind, { ...(readSignersState(JSON.parse(JSON.stringify(signers)), signers.level)?.signers ?? {}) }]);
  return whole;
}

type Step = readonly [by: Key, what: Raw | Promise<Raw>];
interface Played {
  readonly links: readonly Link[];
  readonly texts: readonly string[];
  /** The state after each entry, entry 0 first. */
  readonly states: readonly ListState[];
  /** What became of each entry after entry 0. */
  readonly said: readonly string[];
  readonly state: ListState;
}
/** A list from the owner's genesis, each step signed on the one before and taken on the state before it. */
async function play(steps: readonly Step[], level = 1): Promise<Played> {
  let head = await first();
  let state = firstListState(head.held, level);
  const links = [head];
  const states = [state];
  const told: string[] = [];
  for (const [by, raw] of steps) {
    head = await next(head, by, await raw);
    const result = await taken(state, head.held);
    state = result.state;
    links.push(head);
    states.push(state);
    told.push(said(result.outcome));
  }
  const texts = links.map((item) => item.text);
  // The replay of a member from entry 0 is that function for every entry, and nothing else.
  const replayed = await replayList(texts, level, { saved: null });
  expect([replayed.stopped, replayed.member?.state, replayed.took.slice(1).map((item) => said(item.outcome))]).toEqual([null, state, told]);
  return { links, texts, states, said: told, state };
}
/** What became of the last entry of a list. */
const last = async (steps: readonly Step[], level = 1) => (await play(steps, level)).said.at(-1) ?? "";
const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};

describe("the names an entry seals", () => {
  test("a name is 1 to 48 UTF-16 units, with no control character, no unpaired surrogate, and of white space only single spaces inside it", () => {
    for (const label of ["a", "Home laptop", "x".repeat(48), "집 노트북", "a b c", "😀".repeat(24)]) expect({ label, name: isListLabel(label) }).toEqual({ label, name: true });
    for (const label of ["", "x".repeat(49), "😀".repeat(25), " a", "a ", "a  b", "a\tb", "a\nb", "a\u0000b", "a\u007fb", "a\u00a0b", "a\u3000b", "\ufeffa", "a\u2028b", "\ud800", "a\udc00b"]) {
      expect({ label, name: isListLabel(label) }).toEqual({ label, name: false });
    }
  });

  test("names are the fields label and, when the OS is known, os, and read back as they were", () => {
    const fields = namesFields({ label: "Home laptop", os: "macos" });
    expect(fields).toEqual([{ name: "label", value: utf8ToBytes("Home laptop") }, { name: "os", value: utf8ToBytes("macos") }]);
    expect(readNames(fields)).toEqual({ label: "Home laptop", os: "macos" });
    expect(namesFields({ label: "집 노트북", os: null }).map((item) => item.name)).toEqual(["label"]);
    expect(readNames(namesFields({ label: "집 노트북", os: null }))).toEqual({ label: "집 노트북", os: null });
    // They are fields in the form of an entry's: what seals them writes them under its own prefix.
    expect(readFields(writeFieldsUnder("ovis-list/1", fields)).map((item) => item.name)).toEqual(["label", "os"]);
  });

  test("a writer refuses a label that is no name and an OS word nobody knows, and checks the label before it encodes it", () => {
    for (const names of [{ label: "", os: null }, { label: " a", os: null }, { label: "\ud800", os: null }, { label: "a", os: "beos" }] as const) {
      expect(() => namesFields(names as { label: string; os: null })).toThrow(ListKindError);
    }
  });

  test("a reader gives no names where no label is a name; an OS word or a field it does not know costs nothing else", () => {
    const fields = (values: Record<string, string | Uint8Array>) => Object.entries(values).map(([name, value]) => ({ name, value: typeof value === "string" ? utf8ToBytes(value) : value }));
    expect(readNames(fields({ label: "Desk", os: "beos" }))).toEqual({ label: "Desk", os: null });
    expect(readNames(fields({ label: "Desk", os: "linux", room: "attic" }))).toEqual({ label: "Desk", os: "linux" });
    // What pads a sealed text to a fixed size is a field named `pad`: it is no name, and a writer of names writes none.
    expect(readNames(fields({ label: "Desk", os: "linux", pad: new Uint8Array(200) }))).toEqual({ label: "Desk", os: "linux" });
    expect(readNames(fields({ pad: new Uint8Array(200) }))).toBeNull();
    expect(namesFields({ label: "Desk", os: "linux" }).some((item) => item.name === "pad")).toBe(false);
    expect(readNames(fields({ os: "linux" }))).toBeNull();
    expect(readNames(fields({ label: " Desk" }))).toBeNull();
    expect(readNames(fields({ label: Uint8Array.from([0xff, 0xfe]) }))).toBeNull();
    expect(readNames(fields({ label: Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]) }))).toBeNull();
    expect(readNames([])).toBeNull();
  });
});

describe("a card: the newcomer's own word for its encryption key", () => {
  const good: ListCard = { key: phone.key, enc: phone.enc, list: LIST, endpoint: null, invite: null };

  test("its bytes are the fields enc, key and list under ovis-list-card/1, for a PC endpoint too, and for a PC that joins by an invite that invite's key", () => {
    const text = (value: string) => ({ value: utf8ToBytes(value) });
    expect(cardBytes(good)).toEqual(writeFieldsUnder(LIST_CARD_PREFIX, [{ name: "enc", ...text(phone.enc) }, { name: "key", ...text(phone.key) }, { name: "list", ...text(LIST) }]));
    expect(cardBytes({ ...good, endpoint: E(1) })).toEqual(writeFieldsUnder("ovis-list-card/1", [
      { name: "enc", ...text(phone.enc) }, { name: "endpoint", ...text(E(1)) }, { name: "key", ...text(phone.key) }, { name: "list", ...text(LIST) },
    ]));
    expect(cardBytes({ ...good, endpoint: E(1), invite: pool.key })).toEqual(writeFieldsUnder("ovis-list-card/1", [
      { name: "enc", ...text(phone.enc) }, { name: "endpoint", ...text(E(1)) }, { name: "invite", ...text(pool.key) }, { name: "key", ...text(phone.key) }, { name: "list", ...text(LIST) },
    ]));
    // Only a PC joins by an invite.
    expect(() => cardBytes({ ...good, invite: pool.key })).toThrow(ListKindError);
  });

  test("the key signs it, and it holds for exactly what was signed", async () => {
    const signature = await signCard(good, phone.pair.privateKey);
    expect(signature.length).toBe(CARD_SIGNATURE_CHARS);
    expect(await cardHolds(good, signature)).toBe(true);
    for (const changed of [{ enc: tablet.enc }, { key: tablet.key }, { list: "0".repeat(64) }, { endpoint: E(1) }]) expect(await cardHolds({ ...good, ...changed }, signature)).toBe(false);
    expect(await cardHolds(good, await signCard(good, tablet.pair.privateKey))).toBe(false);
    // A PC's card is no device's, and the other way round.
    const ofPc = await signCard({ ...good, endpoint: E(1) }, phone.pair.privateKey);
    expect([await cardHolds({ ...good, endpoint: E(1) }, ofPc), await cardHolds(good, ofPc), await cardHolds({ ...good, endpoint: E(2) }, ofPc)]).toEqual([true, false, false]);
    // The card a PC made for a person to add it is not one an invite joins it with, nor is a card for one invite another's.
    const ofJoin = await signCard({ ...good, endpoint: E(1), invite: pool.key }, phone.pair.privateKey);
    expect([await cardHolds({ ...good, endpoint: E(1), invite: pool.key }, ofJoin), await cardHolds({ ...good, endpoint: E(1) }, ofJoin), await cardHolds({ ...good, endpoint: E(1), invite: pool2.key }, ofJoin),
      await cardHolds({ ...good, endpoint: E(1), invite: pool.key }, ofPc)]).toEqual([true, false, false, false]);
  });

  test("a card or a signature out of its form holds nothing, and a writer refuses such a card", async () => {
    const signature = await signCard(good, phone.pair.privateKey);
    for (const text of ["", signature.slice(1), `${signature}A`, `${signature.slice(0, -1)}=`]) expect(await cardHolds(good, text)).toBe(false);
    for (const bad of [{ key: "x" }, { enc: "x" }, { list: "x" }, { endpoint: "x" }, { endpoint: E(171).toUpperCase() }, { endpoint: E(1), invite: "x" }]) {
      expect(await cardHolds({ ...good, ...bad }, signature)).toBe(false);
      expect(() => cardBytes({ ...good, ...bad })).toThrow(ListKindError);
    }
  });

  test("the numbers a person compares when adding a PC are bound to the card: another card, another binding, and digits that need both ends' nonces", () => {
    const ofPc: ListCard = { ...good, key: desk.key, enc: desk.enc, endpoint: E(1) };
    const binding = cardBinding(ofPc);
    expect(binding.length).toBe(32);
    expect(Buffer.from(binding).toString("hex")).toBe(new Bun.CryptoHasher("sha256").update(cardBytes(ofPc)).digest("hex"));
    const others = [{ key: tower.key }, { enc: tower.enc }, { endpoint: E(2) }, { list: "0".repeat(64) }, { endpoint: null }, { invite: pool.key }].map((change) => Buffer.from(cardBinding({ ...ofPc, ...change })).toString("hex"));
    expect([new Set(others).size, others.includes(Buffer.from(binding).toString("hex"))]).toEqual([6, false]);
    // The flow of shared/relay-pair-sas.ts over it: the adder commits to its nonce, the PC answers with its own, the adder reveals.
    const [np, nc] = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(9)];
    const commitment = pairCommitment(binding, owner.key, np);
    expect([commitmentHolds(commitment, binding, owner.key, np), commitmentHolds(commitment, cardBinding({ ...ofPc, key: tower.key }), owner.key, np)]).toEqual([true, false]);
    expect(pairDigits(binding, owner.key, np, nc)).toMatch(/^[0-9]{6}$/);
    expect(pairDigits(binding, owner.key, np, nc)).not.toBe(pairDigits(cardBinding({ ...ofPc, key: tower.key }), owner.key, np, nc));
    expect(() => cardBinding({ ...ofPc, enc: "x" })).toThrow(ListKindError);
  });

  test("an encryption key is a key whose point is on the curve", () => {
    const bytes = fromBase64Url(phone.enc);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect([isListKey(phone.enc), isListKey(toBase64Url(bytes)), isListKey(phone.enc.slice(1))]).toEqual([true, false, false]);
  });
});

describe("the kinds of level 1 and the state they build", () => {
  test("the level table: nine kinds, each at v 1", () => {
    expect(LIST_LEVEL).toBe(1);
    expect(LIST_LEVEL_TABLE).toEqual({ genesis: { 1: 1 }, device: { 1: 1 }, pc: { 1: 1 }, invite: { 1: 1 }, join: { 1: 1 }, remove: { 1: 1 }, carried: { 1: 1 }, card: { 1: 1 }, epoch: { 1: 1 } });
  });

  test("genesis: the list starts, and its signer is the first device, which drives and has its encryption key", async () => {
    const { state, links } = await play([]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER }, devices: { owner: "drive" }, pcs: {}, invites: {} });
    expect([state.list, state.footing, state.needs, state.behind, state.level]).toEqual([LIST, { seq: 0, hash: LIST }, 1, null, 1]);
    expect(state.devices[owner.key]?.enc).toBe(owner.enc);
    expect(readKind(at(links, 0).held.body)).toEqual({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL });
    expect([state.epoch, state.epochs]).toEqual([0, [{ opens: OPENS(0), link: null, seq: 0 }]]);
  });

  test("device: the key in adds is a device with its power, its role, its until and its encryption key", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [phone, device(tablet, "bound", "watch", { until: String(T0 + 86400) })], [owner, device(late, "bound", "watch")]]);
    expect(told).toEqual(["counts", "counts", "counts"]);
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", tablet: "bound device @2 by phone", late: "bound device @3 by owner" },
      devices: { owner: "drive", phone: "drive", tablet: "watch until 86400", late: "watch" }, pcs: {}, invites: {},
    });
    expect(state.devices[tablet.key]).toEqual({ role: "watch", until: T0 + 86400, enc: tablet.enc, carried: false });
  });

  test("pc: the key in adds is a PC at that relay key, a full signer, with its encryption key", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)]]);
    expect(told).toEqual(["counts"]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER, desk: "full pc @1 by owner" }, devices: { owner: "drive" }, pcs: { e1: "added desk @1" }, invites: {} });
    expect([state.pcs[E(1)], state.pc_keys]).toEqual([{ how: "added", key: desk.key, enc: desk.enc, seq: 1, invite: null, removed: null }, { [desk.key]: E(1) }]);
  });

  test("a PC that a person added signs as a device does: it allows a device, adds a PC, places an invite and removes", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)], [desk, device(phone)], [desk, pc(tower, 2)], [desk, invite(pool)], [desk, remove(owner)]]);
    expect(told).toEqual(["counts", "counts", "counts", "counts", "counts"]);
    expect(seen(state).signers).toEqual({ owner: `${OWNER} ended@5`, desk: "full pc @1 by owner", phone: "full device @2 by desk", tower: "full pc @3 by desk", pool: "bound invite @4 by desk" });
  });

  test("invite: the key in adds is an invite, with its exp, its uses, whether it needs a person, who placed it and no join yet", async () => {
    const { said: told, state } = await play([[owner, invite(pool, 3)], [owner, invite(plain, 1, false)]]);
    expect(told).toEqual(["counts", "counts"]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER, pool: "bound invite @1 by owner", plain: "bound invite @2 by owner" }, devices: { owner: "drive" }, pcs: {}, invites: { pool: "0 of 3 auto", plain: "0 of 1" } });
    expect(state.invites[pool.key]).toEqual({ exp: EXP, uses: 3, joins: 0, auto: true });
  });

  test("join: the PC at that relay key is in with its key, which is no signer, and one use is taken", async () => {
    const { said: told, state } = await play([[owner, invite(pool)], [pool, join(1)]]);
    const m1 = await machine(1);
    expect(told).toEqual(["counts", "counts"]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER, pool: "bound invite @1 by owner" }, devices: { owner: "drive" }, pcs: { e1: "joined machine1 @2 with pool" }, invites: { pool: "1 of 5 auto" } });
    expect([state.pcs[E(1)], state.pc_keys, signerPower(state, m1.key)]).toEqual([{ how: "joined", key: m1.key, enc: m1.enc, seq: 2, invite: pool.key, removed: null }, { [m1.key]: E(1) }, null]);
  });

  test("remove: with ends the device, the PC or the invite with that key is out; with endpoint a PC whose key is no signer is out; nothing is ever deleted", async () => {
    const { said: told, state } = await play([
      [owner, carriedPc(3)], [owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool)], [pool, join(2)],
      [owner, remove(phone)], [owner, remove(desk)], [owner, remove(pool)], [owner, removePc(2)], [owner, removePc(3)],
    ]);
    expect(told).toEqual(new Array<string>(10).fill("counts"));
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @2 by owner ended@6", desk: "full pc @3 by owner ended@7", pool: "bound invite @4 by owner ended@8" },
      devices: { owner: "drive", phone: "drive" },
      pcs: { e1: "added desk @3 removed@7", e2: "joined machine2 @5 with pool removed@9", e3: "carried @1 removed@10" },
      invites: { pool: "1 of 5 auto" },
    });
  });

  test("carried: the first signer carries in a device, which has no encryption key yet, and a PC, which has no key yet", async () => {
    const { said: told, state, states } = await play([[owner, carried(phone)], [owner, carried(tablet)], [owner, carriedPc(1)]]);
    expect(told).toEqual(["counts", "counts", "counts"]);
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", tablet: "full device @2 by owner" },
      devices: { owner: "drive", phone: "drive no enc carried", tablet: "drive no enc carried" }, pcs: { e1: "carried @3" }, invites: {},
    });
    expect(states.map((item) => item.carrying)).toEqual([true, true, true, true]);
  });

  test("card: a device that was carried in names its encryption key, once", async () => {
    const { said: told, state } = await play([[owner, carried(phone)], [phone, cardOf(phone)], [phone, cardOf(tablet)], [owner, cardOf(owner)], [owner, pc(desk, 1)], [desk, cardOf(desk)], [stranger, cardOf(stranger)]]);
    expect(told).toEqual(["counts", "counts", "no_effect enc_set", "no_effect enc_set", "counts", "no_effect signer_not_allowed", "passed_over signer_unknown"]);
    expect([seen(state).devices, state.devices[phone.key]?.enc]).toEqual([{ owner: "drive", phone: "drive carried" }, phone.enc]);
  });

  test("a key that is a signer without being a device signs a device that counts", async () => {
    const nameless = { ...(await device(phone)), own: { note: "x" } };
    const { said: told, state } = await play([[owner, nameless], [phone, device(tablet)]]);
    expect(told).toEqual(["no_effect entry_invalid", "counts"]);
    expect(seen(state).signers).toEqual({ owner: OWNER, phone: "full no name @1 by owner", tablet: "full device @2 by phone" });
  });

  test("the level table says which kinds a level reads: a kind it does not hold, and a form of a kind it does not hold, have no effect", async () => {
    expect(await last([[owner, { kind: "later_kind" }]])).toBe("no_effect entry_invalid");
    expect(await last([[owner, { ...(await device(phone)), v: 2 }]], 2)).toBe("no_effect entry_invalid");
    expect(await last([[owner, genesis()]])).toBe("no_effect entry_invalid");
  });
});

describe("a missing or an extra field, a value out of form: the kind has no effect (`entry_invalid`), and adds and ends have still applied", () => {
  const offCurve = (() => {
    const bytes = fromBase64Url(phone.enc);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    return toBase64Url(bytes);
  })();
  const cases: [string, () => Promise<Step>][] = [
    ["device: no card", async () => [owner, less(await device(phone), "card")]],
    ["device: no enc", async () => [owner, less(await device(phone), "enc")]],
    ["device: no role", async () => [owner, less(await device(phone), "role")]],
    ["device: an epoch with nothing sealed", async () => [owner, less(await device(phone), "sealed")]],
    ["device: names sealed under no epoch", async () => [owner, less(await device(phone), "epoch")]],
    ["device: an epoch that is no number", async () => [owner, plus(await device(phone), { epoch: "00" })]],
    ["device: one more field", async () => [owner, plus(await device(phone))]],
    ["device: a role nobody has", async () => [owner, plus(await device(phone), { role: "admin" })]],
    ["device: an until that is no number", async () => [owner, plus(await device(phone), { until: "01" })]],
    ["device: an empty until", async () => [owner, plus(await device(phone), { until: "" })]],
    ["device: an enc that is no key", async () => [owner, plus(await device(phone), { enc: phone.enc.slice(1) })]],
    ["device: an enc whose point is off the curve", async () => [owner, plus(await device(phone), { enc: offCurve })]],
    ["device: a card of 85 characters", async () => [owner, plus(await device(phone), { card: (await card(phone)).slice(1) })]],
    ["device: a card in a second spelling", async () => [owner, plus(await device(phone), { card: `${(await card(phone)).slice(0, -1)}B` })]],
    ["device: a sealed value of 46 bytes", async () => [owner, plus(await device(phone), { sealed: new Uint8Array(46) })]],
    ["device: ends of another key", async () => [owner, { ...(await device(late)), ends: tablet }]],
    ["device: an until with power full", async () => [owner, plus(await device(phone), { until: String(T0 + 86400) })]],
    ["device: a watch role with power full", async () => [owner, plus(await device(phone), { role: "watch" })]],
    ["carried: a device that watches", async () => [owner, carried(late, "watch")]],
    ["pc: no endpoint", async () => [owner, less(await pc(desk, 1), "endpoint")]],
    ["pc: an endpoint in upper case", async () => [owner, plus(await pc(desk, 1), { endpoint: E(171).toUpperCase() })]],
    ["pc: an endpoint of 63 characters", async () => [owner, plus(await pc(desk, 1), { endpoint: E(1).slice(1) })]],
    ["pc: power bound", async () => [owner, { ...(await pc(desk, 1)), adds: [desk, "bound"] }]],
    ["pc: a role", async () => [owner, plus(await pc(desk, 1), { role: "drive" })]],
    ["pc: ends", async () => [owner, { ...(await pc(desk, 1)), ends: tablet }]],
    ["invite: no auto", async () => [owner, less(invite(pool2), "auto")]],
    ["invite: an auto that is neither 0 nor 1", async () => [owner, invite(pool2, 5, "true")]],
    ["invite: an epoch with nothing sealed", async () => [owner, less(invite(pool2), "sealed")]],
    ["invite: one more field", async () => [owner, plus(invite(pool2))]],
    ["invite: ends", async () => [owner, { ...invite(pool2), ends: tablet }]],
    ["join: no pc", async () => [pool, less(await join(1), "pc")]],
    ["join: a pc that is no key", async () => [pool, plus(await join(1), { pc: "x" })]],
    ["join: no card", async () => [pool, less(await join(1), "card")]],
    ["join: no enc", async () => [pool, less(await join(1), "enc")]],
    ["join: one more field", async () => [pool, plus(await join(1))]],
    ["remove: neither ends nor endpoint", async () => [owner, { kind: "remove" }]],
    ["remove: ends and endpoint", async () => [owner, { ...removePc(1), ends: tablet }]],
    ["remove: one more field", async () => [owner, plus(removePc(1))]],
    ["remove: ends and a field", async () => [owner, { ...remove(tablet), own: { note: "x" } }]],
    ["carried: a device with no role", async () => [owner, less(carried(late), "role")]],
    ["carried: a device of power bound", async () => [owner, { ...carried(late), adds: [late, "bound"] }]],
    ["carried: a device with an encryption key", async () => [owner, plus(carried(late), { enc: late.enc })]],
    ["carried: a PC with an epoch and nothing sealed", async () => [owner, less(carriedPc(4), "sealed")]],
    ["carried: neither a device nor a PC", async () => [owner, { kind: "carried", own: sealed() }]],
    ["carried: both a device and a PC", async () => [owner, plus(carried(late), { endpoint: E(4) })]],
    ["card: no enc", async () => [owner, { kind: "card" }]],
    ["card: one more field", async () => [owner, plus(cardOf(owner))]],
    ["card: adds", async () => [owner, { ...cardOf(owner), adds: [late, "full"] }]],
    ["card: names", async () => [owner, plus(cardOf(owner), sealed())]],
    ["remove: names", async () => [owner, plus(removePc(1), sealed())]],
    ["epoch: no link", async () => [owner, less(opening(0), "epoch_link")]],
    ["epoch: a link of 60 bytes", async () => [owner, plus(opening(0), { epoch_link: new Uint8Array(60) })]],
    ["epoch: a link of 62 bytes", async () => [owner, plus(opening(0), { epoch_link: new Uint8Array(62) })]],
    ["epoch: an opening that is no hash", async () => [owner, plus(opening(0), { epoch_opens: OPENS(1).toUpperCase() })]],
    ["epoch: no epoch", async () => [owner, less(opening(0), "epoch")]],
    ["epoch: names", async () => [owner, plus(opening(0), { sealed: SEALED })]],
    ["epoch: adds", async () => [owner, { ...opening(0), adds: [late, "full"] }]],
    ["epoch: ends", async () => [owner, { ...opening(0), ends: tablet }]],
  ];
  const before = async (): Promise<Step[]> => [[owner, await device(tablet)], [owner, invite(pool)]];

  for (const [name, step] of cases) {
    test(name, async () => {
      const made = await step();
      const { said: told, state, links } = await play([...(await before()), made]);
      expect(told.at(-1)).toBe("no_effect entry_invalid");
      const body = at(links, 3).held.body;
      expect(readKind(body)).toBeNull();
      // What the entry adds is a signer with no name, and what it ends is out: neither waits for the kind.
      if (body.adds !== undefined) expect(seen(state).signers[who(body.adds.key)]).toBe(`${body.adds.power} no name @3 by ${made[0].name}`);
      if (body.ends !== undefined) expect(state.signers[body.ends]?.ended).toBe(3);
      expect([Object.keys(state.devices).length, Object.keys(state.pcs).length, Object.keys(state.invites).length, state.epoch]).toEqual([2, 0, 1, 0]);
    });
  }

  test("readKind reads exactly the fields of a kind, whatever order a caller holds them in", async () => {
    const body = at((await play([[owner, device(phone)]])).links, 1).held.body;
    expect(readKind(body)?.kind).toBe("device");
    expect(readKind({ ...body, own: [...body.own].reverse() })?.kind).toBe("device");
    expect(readKind({ ...body, own: [...body.own, at([...body.own], 0)] })).toBeNull();
  });
});

describe("a card that is not its key's: the kind has no effect (`card_invalid`), and the key is a signer with no name", () => {
  test("a device's card: by another key, for another encryption key, for another list, or a PC's", async () => {
    const wrong: Promise<string>[] = [
      signCard({ key: phone.key, enc: phone.enc, list: LIST, endpoint: null, invite: null }, tablet.pair.privateKey),
      card(phone, null, { enc: tablet.enc }), card(phone, null, { list: "0".repeat(64) }), card(phone, E(1)),
    ];
    for (const signature of wrong) {
      const { said: told, state } = await play([[owner, plus(await device(phone), { card: await signature })]]);
      expect([told, seen(state).signers.phone, seen(state).devices]).toEqual([["no_effect card_invalid"], "full no name @1 by owner", { owner: "drive" }]);
    }
  });

  test("a PC's card: a device's, for another relay key, or one made to join by an invite; and a join's the same, or one made for a person or another invite", async () => {
    for (const signature of [card(desk), card(desk, E(2)), card(desk, E(1), { invite: pool.key })]) {
      const { said: told, state } = await play([[owner, plus(await pc(desk, 1), { card: await signature })]]);
      expect([told, seen(state).signers.desk, seen(state).pcs, state.pc_keys]).toEqual([["no_effect card_invalid"], "full no name @1 by owner", {}, {}]);
    }
    const m1 = await machine(1);
    for (const signature of [card(m1), card(m1, E(2), { invite: pool.key }), card(other, E(1), { invite: pool.key }), card(m1, E(1)), card(m1, E(1), { invite: pool2.key })]) {
      const { said: told, state } = await play([[owner, invite(pool)], [pool, plus(await join(1), { card: await signature })]]);
      expect([told.at(-1), seen(state).pcs, seen(state).invites]).toEqual(["no_effect card_invalid", {}, { pool: "0 of 5 auto" }]);
    }
  });

  test("a card made for one list lets nobody into another", async () => {
    const elsewhere = await first(genesis(owner, "TEST-ONLY-other-account"));
    expect(elsewhere.held.hash).not.toBe(LIST);
    const entry = await next(elsewhere, owner, await device(phone));
    const result = await takeEntry(firstListState(elsewhere.held, 1), entry.held);
    expect(said(result.outcome)).toBe("no_effect card_invalid");
  });
});

describe("an invite", () => {
  test("uses is a number from 1 to 256", async () => {
    for (const [uses, word] of [[0, "no_effect entry_invalid"], [1, "counts"], [256, "counts"], [257, "no_effect entry_invalid"], ["01", "no_effect entry_invalid"], ["", "no_effect entry_invalid"]] as const) {
      expect({ uses, word: await last([[owner, invite(pool, uses)]]) }).toEqual({ uses, word });
    }
    expect(INVITE_USES_MAX).toBe(256);
  });

  test("exp is at most issued_at and 7 days; no member judges it against a clock of its own", async () => {
    const issued = T0 + 60;
    expect(await last([[owner, invite(pool, 5, true, issued + INVITE_SECONDS_MAX)]])).toBe("counts");
    expect(await last([[owner, invite(pool, 5, true, issued + INVITE_SECONDS_MAX + 1)]])).toBe("no_effect entry_invalid");
    // An exp that lies before its own entry's time: the invite counts, and lets nobody in.
    expect((await play([[owner, invite(pool, 5, true, 1)], [pool, join(1)]])).said).toEqual(["counts", "no_effect invite_expired"]);
  });

  test("power is bound: the key of an invite whose power is full stays a full signer with no name", async () => {
    const { said: told, state } = await play([[owner, { ...invite(pool), adds: [pool, "full"] }], [pool, join(1)]]);
    expect([told, seen(state).signers.pool, seen(state).invites]).toEqual([["no_effect entry_invalid", "no_effect invite_unknown"], "full no name @1 by owner", {}]);
  });

  test("an invite that needs a person lets no PC in by itself: its join has no effect, and the person's pc does", async () => {
    const m1 = await machine(1);
    const { said: told, state } = await play([[owner, invite(plain, 1, false)], [plain, join(1)], [owner, pc(m1, 1)]]);
    expect(told).toEqual(["counts", "no_effect invite_not_auto", "counts"]);
    expect([seen(state).pcs, seen(state).invites]).toEqual([{ e1: "added machine1 @3" }, { plain: "0 of 1" }]);
  });
});

describe("a join", () => {
  test("invite_unknown: the list holds no invite of its signer's key, whatever else that key is or was", async () => {
    expect(await last([[owner, device(phone)], [phone, join(1)]])).toBe("no_effect invite_unknown");
    expect(await last([[owner, device(tablet, "bound")], [tablet, join(1)]])).toBe("no_effect invite_unknown");
    expect(await last([[owner, pc(desk, 2)], [desk, join(1)]])).toBe("no_effect invite_unknown");
    expect(await last([[stranger, join(1)]])).toBe("passed_over invite_unknown");
  });

  test("invite_revoked: after the invite's remove, by a full signer or by the holder of the line itself; the PCs that had joined stay", async () => {
    for (const by of [owner, pool]) {
      const { said: told, state } = await play([[owner, invite(pool)], [pool, join(1)], [by, remove(pool)], [pool, join(2)]]);
      expect([told, seen(state).pcs]).toEqual([["counts", "counts", "counts", "passed_over invite_revoked"], { e1: "joined machine1 @2 with pool" }]);
    }
  });

  test("invite_void: an invite dies with whoever placed it; the PCs already in stay", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [phone, invite(pool)], [pool, join(1)], [owner, remove(phone)], [pool, join(2)]]);
    expect([told.slice(2), seen(state).pcs]).toEqual([["counts", "counts", "no_effect invite_void"], { e1: "joined machine1 @3 with pool" }]);
    expect(inviteRefusal(state, pool.key)).toBe("invite_void");
  });

  test("invite_spent: a join past uses; twelve joins on uses 5, of which exactly five count", async () => {
    const steps: Step[] = [[owner, invite(pool, 5)]];
    for (let n = 1; n <= 12; n++) steps.push([pool, join(n)]);
    const { said: told, state } = await play(steps);
    expect(told.slice(1)).toEqual([...new Array<string>(5).fill("counts"), ...new Array<string>(7).fill("no_effect invite_spent")]);
    expect([Object.keys(state.pcs).length, seen(state).invites]).toEqual([5, { pool: "5 of 5 auto" }]);
  });

  test("endpoint_reused: a relay key comes in once, also after its PC was removed, with another invite, or as a person's PC", async () => {
    const m1 = await machine(1);
    const again = await newKey("again");
    const before: Step[] = [[owner, invite(pool)], [owner, invite(pool2)], [pool, join(1)]];
    expect(await last([...before, [pool, join(1, again)]])).toBe("no_effect endpoint_reused");
    expect(await last([...before, [pool2, join(1, again)]])).toBe("no_effect endpoint_reused");
    expect(await last([...before, [owner, removePc(1)], [pool, join(1, again)]])).toBe("no_effect endpoint_reused");
    expect(await last([...before, [owner, pc(again, 1)]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, pc(desk, 1)], [owner, pc(again, 1)]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, pc(desk, 1)], [owner, remove(desk)], [owner, pc(again, 1)]])).toBe("no_effect endpoint_reused");
    expect(names.get(m1.key)).toBe("machine1");
  });

  test("key_reused: a PC's key comes in once, at one relay key, and a key that is or was a signer is no PC's", async () => {
    const m1 = await machine(1);
    const before: Step[] = [[owner, invite(pool)], [pool, join(1)]];
    expect(await last([...before, [pool, join(2, m1)]])).toBe("no_effect key_reused");
    expect(await last([...before, [owner, removePc(1)], [pool, join(2, m1)]])).toBe("no_effect key_reused");
    expect(await last([[owner, invite(pool)], [owner, device(phone)], [pool, join(1, phone)]])).toBe("no_effect key_reused");
    expect(await last([[owner, invite(pool)], [owner, device(phone)], [owner, remove(phone)], [pool, join(1, phone)]])).toBe("no_effect key_reused");
    expect(await last([[owner, invite(pool)], [pool, join(1, pool)]])).toBe("no_effect key_reused");
    // The key of a PC that joined is made a signer by a full signer's adds, as any key is: it has no name, opens nothing and is no PC.
    for (const entry of [device(m1), pc(m1, 2), Promise.resolve(invite(m1))]) {
      const { said: told, state } = await play([...before, [owner, entry]]);
      expect([told.at(-1), seen(state).signers.machine1, seen(state).pcs, Object.keys(state.devices).length, Object.keys(state.invites).length])
        .toEqual(["no_effect key_reused", "full no name @3 by owner".replace("full", (await entry).adds?.[1] ?? "full"), { e1: "joined machine1 @2 with pool" }, 1, 1]);
    }
  });

  test("the names keep their order: the invite's unknown, revoked, void, spent, then invite_not_auto, endpoint_reused, key_reused, card_invalid", async () => {
    const m1 = await machine(1);
    const spent: Step[] = [[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)]];
    const reusedBadCard = plus(await join(1, m1), { card: await card(other, E(1)) });
    expect(await last([...spent, [pool, reusedBadCard]])).toBe("no_effect invite_spent");
    expect(await last([...spent, [owner, remove(phone)], [pool, reusedBadCard]])).toBe("no_effect invite_void");
    expect(await last([...spent, [owner, remove(phone)], [owner, remove(pool)], [pool, reusedBadCard]])).toBe("passed_over invite_revoked");
    expect(await last([[owner, invite(plain, 5, false)], [owner, pc(desk, 1)], [plain, plus(await join(1, desk), { card: await card(other, E(1)) })]])).toBe("no_effect invite_not_auto");
    expect(await last([[owner, invite(pool)], [pool, join(1)], [pool, reusedBadCard]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, invite(pool)], [pool, join(1)], [pool, plus(await join(2, m1), { card: await card(other, E(2)) })]])).toBe("no_effect key_reused");
  });

  test("the entry's form stands before what the list holds, and who may sign before both", async () => {
    expect(await last([[owner, invite(pool, 1)], [pool, join(1)], [pool, plus(await join(2))]])).toBe("no_effect entry_invalid");
    expect(await last([[stranger, plus(await join(2))]])).toBe("passed_over invite_unknown");
    // At a v no level defines it keeps the name the signers give it.
    expect(await last([[stranger, { ...(await join(2)), v: 2 }]])).toBe("passed_over signer_unknown");
  });
});

describe("the removals", () => {
  test("a full signer removes any device, itself and the first one too: the key is out for good, and keeps what it was", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [phone, remove(owner)], [phone, remove(phone)]]);
    expect([told, seen(state).signers]).toEqual([["counts", "counts", "counts"], { owner: `${OWNER} ended@2`, phone: "full device @1 by owner ended@3" }]);
  });

  test("a bound device ends only itself, and an invite ends only itself", async () => {
    const before: Step[] = [[owner, device(phone)], [owner, device(tablet, "bound")], [owner, invite(pool)], [pool, join(1)], [owner, pc(desk, 2)]];
    for (const by of [tablet, pool]) {
      for (const what of [remove(phone), remove(owner), remove(desk), removePc(1), removePc(2)]) {
        const { said: told, state, states } = await play([...before, [by, what]]);
        expect(told.at(-1)).toBe("ends" in what ? "passed_over signer_not_allowed" : "no_effect signer_not_allowed");
        expect(seen(state)).toEqual(seen(at(states, 5)));
      }
      expect(await last([...before, [by, remove(by)]])).toBe("counts");
    }
  });

  test("out is out: a removed key is never made a signer again, and the remove of a key that is no signer is passed over", async () => {
    const before: Step[] = [[owner, device(phone)], [owner, remove(phone)]];
    expect(await last([...before, [owner, device(phone)]])).toBe("passed_over key_reused");
    expect(await last([...before, [owner, carried(phone)]])).toBe("passed_over key_reused");
    expect(await last([...before, [owner, pc(phone, 1)]])).toBe("passed_over key_reused");
    expect(await last([...before, [owner, remove(phone)]])).toBe("passed_over already_out");
    expect(await last([...before, [owner, remove(stranger)]])).toBe("passed_over already_out");
    expect(await last([...before, [phone, remove(owner)]])).toBe("passed_over signer_unknown");
  });

  test("a PC that a person added goes with its key: ends puts it out, and its relay key alone does not", async () => {
    const before: Step[] = [[owner, pc(desk, 1)]];
    expect(await last([...before, [owner, removePc(1)]])).toBe("no_effect ends_needed");
    const { said: told, state } = await play([...before, [owner, remove(desk)], [owner, removePc(1)], [desk, device(phone)]]);
    expect([told, seen(state).pcs, signerPower(state, desk.key), holdsPc(state, E(1))]).toEqual([["counts", "counts", "no_effect already_out", "passed_over signer_unknown"], { e1: "added desk @1 removed@2" }, null, false]);
    // It ends itself the same way: a person at that PC takes it out of the account.
    expect(seen((await play([...before, [desk, remove(desk)]])).state).pcs).toEqual({ e1: "added desk @1 removed@2" });
  });

  test("a PC that was put out keeps its signer's row as a PC's, whatever is placed afterwards, and no PC that is in has its key", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)], [owner, remove(desk)], [owner, invite(pool)]]);
    expect(told).toEqual(["counts", "counts", "counts"]);
    expect([state.signers[desk.key]?.as, state.signers[desk.key]?.ended, signerPower(state, desk.key), holdsPc(state, E(1)), Object.values(state.pcs).filter((row) => row.key === desk.key && row.removed === null).length])
      .toEqual(["pc", 2, null, false, 0]);
    expect(readListState(JSON.parse(JSON.stringify(state)), 1)).toEqual(state);
  });

  test("a PC is put out by any entry that ends its key, also one a member cannot read", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)], [owner, later(2, { ends: desk })]]);
    expect([told, seen(state).pcs, seen(state).signers.desk]).toEqual([["counts", "cannot_read"], { e1: "added desk @1 removed@2" }, "full pc @1 by owner ended@2"]);
    const unknown = await play([[owner, pc(desk, 1)], [owner, later(1, { ends: desk })]]);
    expect([unknown.said, seen(unknown.state).pcs]).toEqual([["counts", "no_effect entry_invalid"], { e1: "added desk @1 removed@2" }]);
  });

  test("a PC that joined or was carried is put out by its relay key, by a full signer, once", async () => {
    const before: Step[] = [[owner, carriedPc(2)], [owner, invite(pool)], [pool, join(1)], [owner, device(phone)]];
    const { said: told, state } = await play([...before, [phone, removePc(1)], [phone, removePc(2)], [owner, removePc(1)], [owner, removePc(9)]]);
    expect([told.slice(4), seen(state).pcs]).toEqual([["counts", "counts", "no_effect already_out", "no_effect already_out"], { e1: "joined machine1 @3 with pool removed@5", e2: "carried @1 removed@6" }]);
  });

  test("the ends of the last full signer is lawful, and the list then takes no change but a bound key's end of itself", async () => {
    const { said: told, state } = await play([[owner, device(tablet, "bound")], [owner, invite(pool)], [owner, remove(owner)], [tablet, device(phone)], [pool, join(1)], [tablet, remove(tablet)], [pool, remove(pool)]]);
    expect(told).toEqual(["counts", "counts", "counts", "passed_over signer_not_allowed", "no_effect invite_void", "counts", "counts"]);
    expect(Object.values(state.signers).every((row) => row.ended !== null)).toBe(true);
  });
});

describe("those that were in before the list (carried)", () => {
  test("only the first signer carries anybody in", async () => {
    const before: Step[] = [[owner, device(phone)], [owner, pc(desk, 1)]];
    for (const by of [phone, desk]) {
      const { said: told, state } = await play([...before, [by, carried(late)], [by, carriedPc(2)]]);
      expect([told.slice(2), seen(state).signers.late, seen(state).devices.late, seen(state).pcs.e2]).toEqual([["no_effect signer_not_allowed", "no_effect signer_not_allowed"], "full no name @3 by " + by.name, undefined, undefined]);
    }
    expect((await play([[owner, device(tablet, "bound")], [tablet, carriedPc(2)]])).said.at(-1)).toBe("no_effect signer_not_allowed");
  });

  test("a relay key is carried in once", async () => {
    expect(await last([[owner, carriedPc(1)], [owner, carriedPc(1)]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, carried(phone)], [owner, carried(phone)]])).toBe("passed_over key_reused");
  });

  test("only right after entry 0: once a signer has signed anything that is no carried that counted, nobody is carried in", async () => {
    // A `carried` has no card and gives full power: it is how a list starts for an account in use, and no way in afterwards.
    const closes: Step[] = [[owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool)], [owner, opening(0)], [owner, remove(stranger)], [owner, cardOf(owner)], [owner, later()],
      [owner, carriedPc(1)], [owner, plus(carried(tablet), { note: "x" })]];
    for (const step of closes) {
      const start: Step[] = step[1] === at(closes, 7)[1] ? [[owner, carriedPc(1)]] : [];
      const { said: told, state, states } = await play([...start, step, [owner, bare(carried(late))], [owner, bare(carriedPc(5))]]);
      expect({ kind: (await step[1]).kind, told: told.slice(-2), late: seen(state).devices.late, pc: seen(state).pcs.e5, was: at(states, states.length - 3).carrying })
        .toEqual({ kind: (await step[1]).kind, told: ["no_effect carried_late", "no_effect carried_late"], late: undefined, pc: undefined, was: false });
      // What the late entry adds is a signer with no name, as with any entry that has no effect of its kind.
      expect(seen(state).signers.late).toBe("full no name @" + String(states.length - 2) + " by owner");
    }
    // A stranger's entry on top is as if it had never been shown: it closes nothing.
    const padded = await play([[owner, carried(phone)], [stranger, device(stranger)], [owner, carried(late)]]);
    expect([padded.said, padded.state.carrying]).toEqual([["counts", "passed_over signer_unknown", "counts"], true]);
    // The carried device's own entry closes it too: the run is the first signer's alone.
    expect((await play([[owner, carried(phone)], [phone, cardOf(phone)], [owner, carried(late)]])).said.at(-1)).toBe("no_effect carried_late");
    // Who may sign stands before when: a carried by anybody else is refused for that.
    expect((await play([[owner, carried(phone)], [phone, carried(late)]])).said.at(-1)).toBe("no_effect signer_not_allowed");
  });

  test("a carried PC that is in gets its keys from a person's pc at its relay key, never from an invite's join; one that is out gets none", async () => {
    const added = await play([[owner, carriedPc(1)], [owner, pc(desk, 1)]]);
    expect([added.said, seen(added.state).pcs, added.state.pc_keys]).toEqual([["counts", "counts"], { e1: "added desk @2" }, { [desk.key]: E(1) }]);
    const joined = await play([[owner, carriedPc(1)], [owner, invite(pool)], [pool, join(1)]]);
    expect([joined.said.at(-1), seen(joined.state).pcs, seen(joined.state).invites]).toEqual(["no_effect endpoint_reused", { e1: "carried @1" }, { pool: "0 of 5 auto" }]);
    expect(await last([[owner, carriedPc(1)], [owner, removePc(1)], [owner, pc(desk, 1)]])).toBe("no_effect endpoint_reused");
  });

  test("a device hands its place to a new key in one entry: the new key is in and the old one out", async () => {
    const rotation = { ...(await device(late)), ends: phone };
    const { said: told, state } = await play([[owner, carried(phone)], [phone, rotation], [phone, device(tablet)], [late, device(tablet)]]);
    expect(told).toEqual(["counts", "counts", "passed_over signer_unknown", "counts"]);
    expect(seen(state).signers).toEqual({ owner: OWNER, phone: "full device @1 by owner ended@2", late: "full device @2 by phone", tablet: "full device @4 by late" });
    expect(readKind(bodyOf(rotation, phone, { seq: 2, list: LIST, prev: LIST }))).toMatchObject({ kind: "device", rotates: true });
  });
});

describe("the names an entry carries, and the epochs they are sealed under", () => {
  test("an entry with no names counts as one with names does: a member that holds no key to seal them with still adds and removes", async () => {
    const { said: told, state } = await play([[owner, bare(carried(late))], [owner, bare(carriedPc(3))], [owner, bare(await device(phone))], [phone, bare(await pc(desk, 1))], [desk, bare(invite(pool))], [pool, bare(await join(2))]]);
    expect(told).toEqual(new Array<string>(6).fill("counts"));
    expect([Object.keys(state.devices).length, Object.keys(state.pcs).length, Object.keys(state.invites).length]).toEqual([3, 3, 1]);
    const head = await first(bare(genesis()));
    expect(readKind(head.held.body)).toEqual({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: null });
    expect(firstListState(head.held, 1).epoch).toBe(0);
  });

  test("epoch: a full signer opens the epoch after the current one, with the commitment to its key and the link to the key before", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)], [owner, opening(0)], [desk, opening(1)]]);
    expect(told).toEqual(["counts", "counts", "counts"]);
    expect([state.epoch, state.epochs]).toEqual([2, [
      { opens: OPENS(0), link: null, seq: 0 }, { opens: OPENS(1), link: toBase64Url(LINK(1)), seq: 2 }, { opens: OPENS(2), link: toBase64Url(LINK(2)), seq: 3 },
    ]]);
  });

  test("an epoch entry that names another epoch than the current one has no effect: of two members that open the next at once, one does", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [owner, opening(0)], [phone, opening(0)], [phone, opening(2)], [phone, opening(1)]]);
    expect([told.slice(1), state.epoch]).toEqual([["counts", "no_effect epoch_other", "no_effect epoch_other", "counts"], 2]);
  });

  test("only a full signer opens an epoch: a bound device, an invite and a key nobody added do not", async () => {
    const { said: told, state } = await play([[owner, device(tablet, "bound")], [owner, invite(pool)], [tablet, opening(0)], [pool, opening(0)], [stranger, opening(0)]]);
    expect([told.slice(2), state.epoch]).toEqual([["no_effect signer_not_allowed", "no_effect signer_not_allowed", "passed_over signer_unknown"], 0]);
  });

  test("names sealed under another epoch than the current one: the entry has no effect, and what it adds is a signer with no name", async () => {
    const stale = await device(phone);
    const ahead = plus(await pc(desk, 1), { epoch: "2" });
    sealedUnder = 1;
    const current = await device(late).finally(() => { sealedUnder = 0; });
    const { said: told, state } = await play([[owner, opening(0)], [owner, stale], [owner, ahead], [owner, current], [owner, bare(invite(pool))]]);
    expect(told).toEqual(["counts", "no_effect epoch_other", "no_effect epoch_other", "counts", "counts"]);
    expect(seen(state).signers).toEqual({ owner: OWNER, phone: "full no name @2 by owner", desk: "full no name @3 by owner", late: "full device @4 by owner", pool: "bound invite @5 by owner" });
    // The form stands before the epoch, and the epoch before what the list holds.
    expect(await last([[owner, opening(0)], [owner, plus(await device(phone), { role: "admin" })]])).toBe("no_effect entry_invalid");
    // A relay key that is taken, named again under names of the epoch before: the epoch is asked first.
    const taken1 = await pc(desk, 1);
    const stale1 = await pc(tower, 1);
    const reused = await play([[owner, taken1], [owner, opening(0)], [owner, stale1], [owner, bare(await pc(late, 1))]]);
    expect([reused.said, seen(reused.state).pcs]).toEqual([["counts", "counts", "no_effect epoch_other", "no_effect endpoint_reused"], { e1: "added desk @1" }]);
  });

  test("a removal moves no epoch by itself, and an epoch is opened whether or not anybody was put out", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [owner, remove(phone)], [owner, opening(0)], [owner, opening(1)]]);
    expect([told, state.epoch, state.epochs.map((row) => row.seq)]).toEqual([["counts", "counts", "counts", "counts"], 2, [0, 3, 4]]);
  });

  test("a member that is behind still follows the epochs", async () => {
    const { said: told, state } = await play([[owner, later()], [owner, opening(0)]]);
    expect([told, state.behind, state.epoch]).toEqual([["cannot_read", "counts"], 1, 1]);
  });

  test("the keys an epoch's key is wrapped to: the encryption key of each device and PC that is in, and the own key of each open invite a PC joins with by itself", async () => {
    const m2 = await machine(2);
    const { state } = await play([
      [owner, carried(late)], [owner, carriedPc(3)], [owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool, 2)], [pool, join(2)], [owner, invite(plain, 1, false)],
      [owner, device(tablet, "bound")], [tablet, remove(tablet)], [owner, invite(pool2, 1)], [owner, remove(pool2)],
    ]);
    expect(wrapKeys(state, T0)).toEqual([owner.enc, phone.enc, desk.enc, pool.key, m2.enc]);
    const after = await play([[owner, carried(late)], [late, cardOf(late)], [owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool, 1)], [pool, join(2)], [owner, remove(phone)], [owner, remove(desk)], [owner, removePc(2)]]);
    expect(wrapKeys(after.state, T0)).toEqual([owner.enc, late.enc]);
  });

  test("an invite past its exp and a device past its until get no key, by the clock of whoever wraps; nobody is put out by that clock", async () => {
    const { state } = await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 86400) })], [owner, invite(pool, 2, true, T0 + 900)], [owner, invite(pool2, 2, true, T0 + 7200)]]);
    expect(wrapKeys(state, T0)).toEqual([owner.enc, tablet.enc, pool.key, pool2.key]);
    expect(wrapKeys(state, T0 + 900)).toEqual([owner.enc, tablet.enc, pool.key, pool2.key]);
    expect(wrapKeys(state, T0 + 901)).toEqual([owner.enc, tablet.enc, pool2.key]);
    expect(wrapKeys(state, T0 + 86399)).toEqual([owner.enc, tablet.enc]);
    expect(wrapKeys(state, T0 + 86400)).toEqual([owner.enc]);
    // The caller's clock chooses only whom a key is wrapped to: by the list the invite is open, and the device is still a signer.
    expect([inviteRefusal(state, pool.key), signerPower(state, tablet.key)]).toEqual([null, "bound"]);
    // No clock that reads before the list's own time is believed: the last entry here was signed at T0 + 180.
    expect([state.full_at, wrapKeys(state, 0)]).toEqual([T0 + 180, [owner.enc, tablet.enc, pool.key, pool2.key]]);
  });

  test("a member that is behind wraps to no invite: it cannot tell whether one was spent since, and a wrap to a key that is out refuses its whole request", async () => {
    const m2 = await machine(2);
    // The sequence: an invite for one PC is open when the member falls behind, and a PC joins with it afterwards.
    const steps: Step[] = [[owner, device(phone)], [owner, invite(pool, 1)], [owner, invite(pool2, 1)], [owner, later()], [pool, join(2)]];
    const behind = (await play(steps)).state;
    const reads = (await play(steps, 2)).state;
    // The member that is behind took nothing in: for it the invite still has its use.
    expect([behind.behind, inviteRefusal(behind, pool.key), inviteRefusal(reads, pool.key)]).toEqual([4, null, "invite_spent"]);
    expect(wrapKeys(reads, T0)).toEqual([owner.enc, phone.enc, pool2.key, m2.enc]);
    expect(wrapKeys(behind, T0)).toEqual([owner.enc, phone.enc]);
    // Every key it wraps to is one that a member reading everything wraps to, so the removal it sends with them is not refused for a wrap.
    for (const key of wrapKeys(behind, T0)) expect(wrapKeys(reads, T0)).toContain(key);
    // What that costs: an invite that is still open gets no key from it either. Before it fell behind it wrapped to both.
    expect(wrapKeys(at((await play(steps)).states, 3), T0)).toEqual([owner.enc, phone.enc, pool.key, pool2.key]);
  });

  test("the epoch a writer seals under: the current one, and only when it was opened after the last entry that put a key out", async () => {
    const at0 = { epoch: 0, opens: OPENS(0) };
    const sealing = async (steps: readonly Step[], now = T0) => sealEpoch((await play(steps)).state, now);
    expect(await sealing([])).toEqual(at0);
    expect(await sealing([[owner, carriedPc(3)], [owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool)], [pool, join(2)]])).toEqual(at0);
    // Whoever is put out holds the key of the epoch it was put out in: nothing more is sealed under it.
    const before: Step[] = [[owner, carriedPc(3)], [owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool)], [pool, join(2)], [owner, device(tablet, "bound")]];
    for (const out of [[owner, remove(phone)], [owner, remove(desk)], [owner, remove(pool)], [pool, remove(pool)], [owner, removePc(2)], [owner, removePc(3)], [tablet, remove(tablet)]] as Step[]) {
      expect(await sealing([...before, out])).toBeNull();
      expect(await sealing([...before, out, [owner, device(late)]])).toBeNull();
      expect(await sealing([...before, out, [owner, opening(0)]])).toEqual({ epoch: 1, opens: OPENS(1) });
    }
    // A device that hands its place to a new key puts the old key out; so does an entry a member cannot read.
    expect(await sealing([[owner, carried(phone)], [phone, { ...(await device(late)), ends: phone }]])).toBeNull();
    expect(await sealing([[owner, device(phone)], [owner, later(2, { ends: phone })]])).toBeNull();
    // An epoch opened before the removal does not count, and one opened by the member that is then put out is used by nobody.
    expect(await sealing([[owner, device(phone)], [owner, opening(0)], [owner, remove(phone)]])).toBeNull();
    expect(await sealing([[owner, device(phone)], [phone, opening(0)], [owner, remove(phone)]])).toBeNull();
    expect(await sealing([[owner, device(phone)], [phone, opening(0)], [owner, remove(phone)], [owner, opening(1)]])).toEqual({ epoch: 2, opens: OPENS(2) });
    // What put nobody out changes nothing: a refused removal, a key that was no member's, a signer with no name.
    expect(await sealing([[owner, device(phone)], [owner, remove(stranger)], [owner, removePc(9)]])).toEqual(at0);
    expect(await sealing([[owner, plus(await device(phone), { role: "admin" })], [owner, remove(phone)]])).toEqual(at0);
    // An invite that needs a person is given no key, so putting it out puts no key out.
    expect(await sealing([[owner, invite(plain, 1, false)], [owner, remove(plain)]])).toEqual(at0);
  });

  test("the holder of a line held the key too: nothing is sealed after the join that took an invite's last use, or past an invite's exp or a device's until, until the next epoch", async () => {
    const at0 = { epoch: 0, opens: OPENS(0) };
    const spent = await play([[owner, invite(pool, 2)], [pool, join(1)], [pool, join(2)], [owner, opening(0)]]);
    expect([sealEpoch(at(spent.states, 2), T0), sealEpoch(at(spent.states, 3), T0), sealEpoch(spent.state, T0)]).toEqual([at0, null, { epoch: 1, opens: OPENS(1) }]);
    // Past its exp by the writer's clock an unused invite is first put out; the same for a borrowed browser past its until.
    const timed = await play([[owner, invite(pool, 2, true, T0 + 900)], [owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })]]);
    expect([sealEpoch(timed.state, T0 + 900), sealEpoch(timed.state, T0 + 901), sealEpoch(at(timed.states, 1), T0 + 901)]).toEqual([at0, null, null]);
    const revoked = await play([[owner, invite(pool, 2, true, T0 + 900)], [owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })], [owner, remove(pool)], [owner, opening(0)]]);
    expect([sealEpoch(revoked.state, T0 + 901), sealEpoch(revoked.state, T0 + 3599), sealEpoch(revoked.state, T0 + 3600)]).toEqual([{ epoch: 1, opens: OPENS(1) }, { epoch: 1, opens: OPENS(1) }, null]);
    const both = await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })], [owner, remove(tablet)], [owner, opening(0)]]);
    expect(sealEpoch(both.state, T0 + 99999)).toEqual({ epoch: 1, opens: OPENS(1) });
    // The list's own time counts as a clock: an invite that the list has seen expire is not sealed to, whatever the writer's clock reads.
    const seen2 = await play([[owner, invite(pool, 2, true, T0 + 100)], [owner, device(phone)]]);
    expect([seen2.state.full_at, inviteRefusal(seen2.state, pool.key), sealEpoch(seen2.state, 0)]).toEqual([T0 + 120, "invite_expired", null]);
  });

  test("an invite that is void went out with whoever placed it: its exp holds nothing back once an epoch was opened after that end", async () => {
    // The review's sequence: a device places an invite a PC joins with by itself, and is put out; the next epoch is opened, and the invite got no key of it.
    const voided = await play([[owner, device(phone)], [phone, invite(pool, 2, true, T0 + 900)], [owner, remove(phone)], [owner, opening(0)]]);
    const at1 = { epoch: 1, opens: OPENS(1) };
    expect([inviteRefusal(voided.state, pool.key), wrapKeys(voided.state, T0)]).toEqual(["invite_void", [owner.enc]]);
    expect([sealEpoch(voided.state, T0 + 900), sealEpoch(voided.state, T0 + 901), sealEpoch(voided.state, T0 + 99999)]).toEqual([at1, at1, at1]);
    expect(lapsedRemovals(voided.state, T0 + 901)).toEqual([]);
    // Before that epoch nothing is sealed, at any time: the end of whoever placed it put the invite's key out.
    expect([sealEpoch(at(voided.states, 3), T0), sealEpoch(at(voided.states, 3), T0 + 901)]).toEqual([null, null]);
    // The same where whoever placed it is a signer with no name, which is neither a device nor a PC.
    const nameless = await play([[owner, plus(await device(phone), { role: "admin" })], [phone, invite(pool, 2, true, T0 + 900)], [owner, remove(phone)], [owner, opening(0)]]);
    expect([nameless.said, inviteRefusal(nameless.state, pool.key)]).toEqual([["no_effect entry_invalid", "counts", "counts", "counts"], "invite_void"]);
    expect([sealEpoch(at(nameless.states, 2), T0), sealEpoch(at(nameless.states, 3), T0), sealEpoch(nameless.state, T0 + 901)]).toEqual([{ epoch: 0, opens: OPENS(0) }, null, at1]);
    // A spent invite and a revoked one are not asked for their exp either; one that is only past its exp still is.
    const spent = await play([[owner, invite(pool, 1, true, T0 + 900)], [pool, join(1)], [owner, opening(0)]]);
    const revoked = await play([[owner, invite(pool, 1, true, T0 + 900)], [owner, remove(pool)], [owner, opening(0)]]);
    const open = await play([[owner, invite(pool, 1, true, T0 + 900)], [owner, device(phone)], [owner, remove(phone)], [owner, opening(0)]]);
    expect([sealEpoch(spent.state, T0 + 901), sealEpoch(revoked.state, T0 + 901), sealEpoch(open.state, T0 + 900), sealEpoch(open.state, T0 + 901)]).toEqual([at1, at1, at1, null]);
  });

  test("a member that is stopped for a replay seals nothing", async () => {
    const { links, state } = await play([[owner, later()]]);
    const entry = await next(at(links, 1), stranger, later());
    const stopped = (await takeEntry(state, entry.held)).state;
    expect([sealEpoch(state, T0), stopped.needs_replay?.seq, sealEpoch(stopped, T0)]).toEqual([{ epoch: 0, opens: OPENS(0) }, 2, null]);
  });
});

describe("an invite's time is over by the list's own time, with no reader's clock", () => {
  test("a year later and several entries on, the holder of an old line joins nobody: a full signer has signed after its exp", async () => {
    const YEAR = 31536000;
    const head = await first();
    let link = await next(head, owner, invite(pool, 1, true, T0 + 3600));
    let state = (await takeEntry(firstListState(head.held, 1), link.held)).state;
    expect([state.full_at, inviteRefusal(state, pool.key), wrapKeys(state, T0 + 60)]).toEqual([T0 + 60, null, [owner.enc, pool.key]]);
    // An honest entry a year on: the list's time moves, and the invite is over for every member, whatever a service places after it.
    const honest = bodyOf(await device(phone), owner, { seq: 2, list: LIST, prev: link.held.hash });
    link = await link2({ ...honest, issued_at: T0 + YEAR }, owner);
    state = (await takeEntry(state, link.held)).state;
    expect([state.full_at, inviteRefusal(state, pool.key), listView(state).invites.map((row) => row.refusal), wrapKeys(state, T0)]).toEqual([T0 + YEAR, "invite_expired", ["invite_expired"], [owner.enc, phone.enc]]);
    const late = await next(link, pool, await join(1));
    const taken2 = await takeEntry(state, late.held);
    expect([said(taken2.outcome), holdsPc(taken2.state, E(1)), seen(taken2.state).invites]).toEqual(["no_effect invite_expired", false, { pool: "0 of 1 auto" }]);
    expect(readProofRefusal(state, { key: pool.key, list: LIST, after: null, at: T0 })).toBe("invite_expired");
  });

  test("the join's own time proves nothing: only what a signer of power full signed moves the list's time", async () => {
    const head = await first();
    const placed = await next(head, owner, invite(pool, 3, true, T0 + 3600));
    const state = (await takeEntry(firstListState(head.held, 1), placed.held)).state;
    // The holder of the line writes any time it likes: before the exp or long after, its join counts while no full signer has signed past the exp.
    for (const issued_at of [0, T0 + 61, T0 + 99999999]) {
      const joined = await link2({ ...bodyOf(await join(1), pool, { seq: 2, list: LIST, prev: placed.held.hash }), issued_at }, pool);
      const result = await takeEntry(state, joined.held);
      expect([said(result.outcome), result.state.full_at]).toEqual(["counts", T0 + 60]);
    }
    // Nor does a bound device's, a stranger's, or an entry that is passed over.
    const others = await play([[owner, device(tablet, "bound")], [owner, invite(pool, 3, true, T0 + 3600)]]);
    for (const [by, raw] of [[tablet, remove(tablet)], [stranger, await device(stranger)], [owner, remove(stranger)]] as const) {
      const entry = await link2({ ...bodyOf(raw, by, { seq: 3, list: LIST, prev: at(others.links, 2).held.hash }), issued_at: T0 + 99999999 }, by);
      expect((await takeEntry(others.state, entry.held)).state.full_at).toBe(T0 + 120);
    }
    // An entry a member cannot read moves it all the same: its time is in the part every level reads.
    const unread = await link2({ ...bodyOf(later(), owner, { seq: 3, list: LIST, prev: at(others.links, 2).held.hash }), issued_at: T0 + 7200 }, owner);
    const after = (await takeEntry(others.state, unread.held)).state;
    expect([after.full_at, inviteRefusal(after, pool.key)]).toEqual([T0 + 7200, "invite_expired"]);
  });

  test("exp itself is in time: a full signer's entry at exactly exp leaves the invite open, one second later ends it", async () => {
    const { links, state } = await play([[owner, invite(pool, 3, true, T0 + 3600)]]);
    for (const [issued_at, refusal] of [[T0 + 3600, null], [T0 + 3601, "invite_expired"]] as const) {
      const entry = await link2({ ...bodyOf(opening(0), owner, { seq: 2, list: LIST, prev: at(links, 1).held.hash }), issued_at }, owner);
      expect(inviteRefusal((await takeEntry(state, entry.held)).state, pool.key)).toBe(refusal);
    }
    // The list's time never goes back: an earlier entry after a later one changes nothing.
    const ahead = await link2({ ...bodyOf(opening(0), owner, { seq: 2, list: LIST, prev: at(links, 1).held.hash }), issued_at: T0 + 5000 }, owner);
    const back = await link2({ ...bodyOf(opening(1), owner, { seq: 3, list: LIST, prev: ahead.held.hash }), issued_at: T0 + 100 }, owner);
    expect((await takeEntry((await takeEntry(state, ahead.held)).state, back.held)).state.full_at).toBe(T0 + 5000);
  });
});

describe("a signer with no name: seen, and put out with its key", () => {
  /** An open invite's PC joins; then a full signer's own entry adds that PC's key. The kind has no effect, and the signers' rule has made the key a signer. */
  const nameless = async (power: SignerPower = "full") => await play([[owner, invite(pool)], [pool, join(2)], [owner, device(await machine(2), power)]]);

  test("the key of a PC that joined, added by a full signer's own entry, is a signer with no name: it is listed as one, and what it signs counts", async () => {
    const m2 = await machine(2);
    const { said: told, state, links } = await nameless();
    expect([told, seen(state).signers.machine2, seen(state).pcs]).toEqual([["counts", "counts", "no_effect key_reused"], "full no name @3 by owner", { e2: "joined machine2 @2 with pool" }]);
    const view = listView(state);
    expect([view.signers, view.pcs.map((row) => row.allows), view.devices.length]).toEqual([[{ key: m2.key, power: "full", seq: 3, by: owner.key }], [false], 1]);
    // It is no device and opens nothing; and the frozen signers' rule lets it sign: its entry counts.
    expect(admitsDevice(state, m2.key, T0)).toBeNull();
    const by = await next(at(links, 3), m2, await device(stranger));
    expect(said((await takeEntry(state, by.held)).outcome)).toBe("counts");
    // Once it is ended it is listed no more.
    const ended = (await takeEntry(state, (await next(at(links, 3), owner, remove(m2))).held)).state;
    expect(listView(ended).signers).toEqual([]);
  });

  test("such a PC is put out with its key: its relay key alone would leave the key a signer, and the end of the key puts the PC out", async () => {
    const { state, links } = await nameless();
    const head = at(links, 3);
    expect(said((await takeEntry(state, (await next(head, owner, removePc(2))).held)).outcome)).toBe("no_effect ends_needed");
    for (const by of [owner, await machine(2)]) {
      const out = await takeEntry(state, (await next(head, by, remove(await machine(2)))).held);
      expect([said(out.outcome), seen(out.state).pcs, holdsPc(out.state, E(2)), signerPower(out.state, (await machine(2)).key)]).toEqual(["counts", { e2: "joined machine2 @2 with pool removed@4" }, false, null]);
      expect(readListState(JSON.parse(JSON.stringify(out.state)), 1)).toEqual(out.state);
    }
    // A bound one ends itself, and its PC goes with it.
    const bound = await nameless("bound");
    const self = await takeEntry(bound.state, (await next(at(bound.links, 3), await machine(2), remove(await machine(2)))).held);
    expect([said(self.outcome), holdsPc(self.state, E(2))]).toEqual(["counts", false]);
    // A PC that was put out by its relay key before its key was made a signer stays out as it was.
    const earlier = await play([[owner, invite(pool)], [pool, join(2)], [owner, removePc(2)], [owner, device(await machine(2))], [owner, remove(await machine(2))]]);
    expect([earlier.said.slice(2), seen(earlier.state).pcs]).toEqual([["counts", "no_effect key_reused", "counts"], { e2: "joined machine2 @2 with pool removed@3" }]);
    // What puts it out, as a caller is told.
    expect(pcRemoval(state, E(2))).toEqual([{ kind: "remove", ends: (await machine(2)).key }, { kind: "remove", ends: pool.key }]);
  });

  test("a saved state that says such a PC is in while its key is ended, or that the key has a name, is no state", async () => {
    const m2 = await machine(2);
    const { state } = await play([[owner, invite(pool)], [pool, join(2)], [owner, device(m2)], [owner, remove(m2)]]);
    const loose = () => JSON.parse(JSON.stringify(state)) as { pcs: Record<string, { removed: number | null }>; signers: Record<string, { as: string | null; seq: number }> };
    expect(readListState(loose(), 1)).toEqual(state);
    const stillIn = loose();
    (stillIn.pcs[E(2)] ?? { removed: 0 }).removed = null;
    expect(readListState(stillIn, 1)).toBeNull();
    const namedKey = loose();
    (namedKey.signers[m2.key] ?? { as: null }).as = "device";
    expect(readListState(namedKey, 1)).toBeNull();
  });
});

describe("how a member writes: an entry is signed only when it counts on the writer's own state", () => {
  const signer = (key: Key) => ({ key: key.key, privateKey: key.pair.privateKey });
  const refusal = async (state: ListState, kind: ListKind, by: Key = owner) =>
    await signListEntry(state, kind, signer(by), T0 + 600).then(() => "signed", (error: unknown) => (error instanceof ListWriteError ? (error.outcome === null ? "not written" : said(error.outcome)) : String(error)));
  const deviceKind = async (key: Key, more: Partial<Extract<ListKind, { kind: "device" }>> = {}): Promise<ListKind> =>
    ({ kind: "device", key: key.key, power: "full", role: "drive", until: null, enc: key.enc, card: await card(key), sealed: SEAL, rotates: false, ...more });
  /** Why a writer is refused, in a word: the helper's own reason, or what would have become of the entry. */
  const whyNot = (error: unknown): string => (error instanceof ListWriteError ? error.reason ?? (error.outcome === null ? "not written" : said(error.outcome)) : String(error));
  const written = async (state: ListState, kind: ListKind, by: Key = owner, issued = T0 + 600) => await signListEntry(state, kind, signer(by), issued).then(() => "signed", whyNot);
  const epochKind = (state: ListState): ListKind => ({ kind: "epoch", epoch: state.epoch, opens: OPENS(state.epoch + 1), link: LINK(state.epoch + 1) });

  test("entry 0 is signed by its first device, and the list starts as every member reads it", async () => {
    const written = await signGenesis({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL }, signer(owner), T0);
    expect([written.state.list, written.state.account, written.state.full_at, written.state.carrying, entryHash(written.entry.body)]).toEqual([LIST, "TEST-ONLY-account", T0, true, LIST]);
    expect((await replayList([written.text], 1, { saved: null })).member?.state).toEqual(written.state);
    await expect(signGenesis({ kind: "genesis", account: "", enc: owner.enc, opens: OPENS(0), sealed: SEAL }, signer(owner), T0)).rejects.toThrow(ListKindError);
    await expect(signGenesis({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL }, { key: owner.key, privateKey: other.pair.privateKey }, T0)).rejects.toThrow(ListWriteError);
  });

  test("an entry that counts is signed on the writer's footing, and is the entry every member takes as counting", async () => {
    const { links, state } = await play([[owner, invite(pool)], [stranger, device(stranger)]]);
    const written = await signListEntry(state, await deviceKind(phone), signer(owner), T0 + 600);
    const body = readBody(written.entry.body);
    // On the footing, not on a stranger's entry on top of it.
    expect([body.seq, body.prev, body.list, body.signer, body.issued_at]).toEqual([2, at(links, 1).held.hash, LIST, owner.key, T0 + 600]);
    const shown = await shownList({ entries: links.map((item) => item.text), state }, { after: 1, entries: [written.text], head: { seq: 2, hash: entryHash(written.entry.body) } });
    expect([shown.took.map((item) => said(item.outcome)), shown.dropped_from, shown.member.state]).toEqual([["counts"], 2, written.state]);
  });

  test("the entry that would leave a signer with no name is never signed", async () => {
    const m2 = await machine(2);
    const { state } = await play([[owner, invite(pool)], [pool, join(2)], [owner, device(tablet, "bound")], [owner, pc(desk, 1)]]);
    // The review's sequence: a full signer's device entry for the key of a PC that joined.
    expect(await refusal(state, await deviceKind(m2))).toBe("no_effect key_reused");
    expect(await refusal(state, { kind: "pc", key: m2.key, endpoint: E(5), enc: m2.enc, card: await card(m2, E(5)), sealed: SEAL })).toBe("no_effect key_reused");
    expect(await refusal(state, { kind: "invite", key: m2.key, exp: EXP, uses: 1, auto: true, sealed: SEAL })).toBe("no_effect key_reused");
    // A card that is not the key's own; a relay key that is taken; names under another epoch; a carried once the list is in use.
    expect(await refusal(state, await deviceKind(phone, { card: await card(other) }))).toBe("no_effect card_invalid");
    expect(await refusal(state, { kind: "pc", key: tower.key, endpoint: E(1), enc: tower.enc, card: await card(tower, E(1)), sealed: SEAL })).toBe("no_effect endpoint_reused");
    expect(await refusal(state, await deviceKind(phone, { sealed: { epoch: 1, bytes: SEALED } }))).toBe("no_effect epoch_other");
    expect(await refusal(state, { kind: "carried", key: late.key, role: "drive", sealed: SEAL })).toBe("no_effect carried_late");
    // What the signers' rule passes over: a key that is out, a bound key that adds, a key that is no signer.
    expect(await refusal(state, await deviceKind(owner))).toBe("passed_over key_reused");
    expect(await refusal(state, await deviceKind(phone), tablet)).toBe("passed_over signer_not_allowed");
    expect(await refusal(state, await deviceKind(phone), stranger)).toBe("passed_over signer_unknown");
    expect(await refusal(state, { kind: "remove", endpoint: E(1) })).toBe("no_effect ends_needed");
    // And what counts is signed.
    expect(await refusal(state, await deviceKind(phone))).toBe("signed");
    expect(await refusal(state, { kind: "remove", ends: tablet.key }, tablet)).toBe("signed");
  });

  test("nobody opens an epoch at will: an epoch is written only after an entry that put a key out, or took an invite's last use, since the current one opened", async () => {
    const why = async (state: ListState, at = T0 + 600) => await written(state, epochKind(state), owner, at);
    // Nobody is out: no epoch, also right after an add, and after an add that lost its place and is signed again.
    expect(await why((await play([])).state)).toBe("epoch_not_needed");
    expect(await why((await play([[owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool, 2)], [pool, join(2)]])).state)).toBe("epoch_not_needed");
    // After a removal, or the join that took an invite's last use: the next epoch is called for.
    expect(await why((await play([[owner, device(phone)], [owner, remove(phone)]])).state)).toBe("signed");
    expect(await why((await play([[owner, invite(pool, 1)], [pool, join(2)]])).state)).toBe("signed");
    // Once it is open, no second one: of two members that open it at once, one does, and the other finds nothing left to do.
    const opened = (await play([[owner, device(phone)], [owner, remove(phone)], [owner, opening(0)]])).state;
    expect(await why(opened)).toBe("epoch_not_needed");
    // Members count an epoch that somebody placed all the same: this is what a writer does, not what an entry is.
    expect((await play([[owner, opening(0)]])).said).toEqual(["counts"]);
  });

  test("a time that is over calls for no epoch by itself: whoever is past its until or its exp is put out first, and the epoch follows that remove", async () => {
    const timed = (await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })], [owner, invite(pool, 2, true, T0 + 7200)], [owner, invite(plain, 2, false, T0 + 900)]])).state;
    const why = async (state: ListState, at: number) => await written(state, epochKind(state), owner, at);
    // Before its until nothing calls for an epoch. At it nothing is sealed any more, and still no epoch is signed: the device is in.
    expect([sealEpoch(timed, T0 + 3599), await why(timed, T0 + 3599), lapsedRemovals(timed, T0 + 3599)]).toEqual([{ epoch: 0, opens: OPENS(0) }, "epoch_not_needed", []]);
    expect([sealEpoch(timed, T0 + 3600), await why(timed, T0 + 3600)]).toEqual([null, "epoch_no_use"]);
    // The review's sequence: with the device still in, an epoch signed at its until would be followed by another, and another.
    const again = await signListEntries(timed, [epochKind, epochKind], signer(owner), T0 + 3600).then(() => "signed", whyNot);
    expect(again).toBe("epoch_no_use");
    // What the clock calls for is the remove of whoever is over its time: the device at its until, an invite a PC joins with by itself past its exp.
    expect(lapsedRemovals(timed, T0 + 3600)).toEqual([{ kind: "remove", ends: tablet.key }]);
    expect(lapsedRemovals(timed, T0 + 7200)).toEqual([{ kind: "remove", ends: tablet.key }]);
    expect(lapsedRemovals(timed, T0 + 7201)).toEqual([{ kind: "remove", ends: tablet.key }, { kind: "remove", ends: pool.key }]);
    // One batch: those removes, then one epoch, and names are sealed again; no second epoch after it.
    const batch = await signListEntries(timed, [...lapsedRemovals(timed, T0 + 7201), epochKind], signer(owner), T0 + 7201);
    expect(batch.entries.map((item) => readBody(item.entry.body).kind)).toEqual(["remove", "remove", "epoch"]);
    expect([sealEpoch(batch.state, T0 + 7201), lapsedRemovals(batch.state, T0 + 7201), await why(batch.state, T0 + 7201)]).toEqual([{ epoch: 1, opens: OPENS(1) }, [], "epoch_not_needed"]);
    // With one of the two still in, the epoch after the other's remove is signed (a remove calls for it), and nothing is sealed until the second is out too.
    const half = await signListEntries(timed, [{ kind: "remove", ends: tablet.key }, epochKind], signer(owner), T0 + 7201);
    expect([half.state.epoch, sealEpoch(half.state, T0 + 7201), await why(half.state, T0 + 7201), lapsedRemovals(half.state, T0 + 7201)]).toEqual([1, null, "epoch_no_use", [{ kind: "remove", ends: pool.key }]]);
    // The list's own time is a clock too, and a member that is stopped for a replay is told of nobody.
    const seen2 = (await play([[owner, invite(pool, 2, true, T0 + 100)], [owner, device(phone)]])).state;
    expect([inviteRefusal(seen2, pool.key), lapsedRemovals(seen2, 0), await why(seen2, 0)]).toEqual(["invite_expired", [{ kind: "remove", ends: pool.key }], "epoch_no_use"]);
    const { links, state } = await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })], [owner, later()]]);
    const stopped = (await takeEntry(state, (await next(at(links, 2), stranger, later())).held)).state;
    expect([lapsedRemovals(state, T0 + 3600), lapsedRemovals(stopped, T0 + 3600)]).toEqual([[{ kind: "remove", ends: tablet.key }], []]);
  });

  test("the returned footing hashes the entry that was signed, whatever the caller does to its bytes meanwhile", async () => {
    const { state } = await play([]);
    const bytes = new Uint8Array(SEALED_MIN_BYTES);
    const pending = signListEntry(state, { kind: "invite", key: pool.key, exp: EXP, uses: 1, auto: false, sealed: { epoch: 0, bytes } }, signer(owner), T0 + 60);
    bytes[0] = 1;
    const entry = await pending;
    expect(entry.state.footing.hash).toBe(entryHash(entry.entry.body));
    expect((await replayList([(await first()).text, entry.text], 1, { saved: null })).member?.state).toEqual(entry.state);
    // Entry 0 and a PC's own join the same.
    const names = new Uint8Array(SEALED_MIN_BYTES);
    const pendingFirst = signGenesis({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: { epoch: 0, bytes: names } }, signer(owner), T0);
    names[0] = 1;
    const genesisWritten = await pendingFirst;
    expect([genesisWritten.state.list, genesisWritten.state.footing.hash]).toEqual([entryHash(genesisWritten.entry.body), entryHash(genesisWritten.entry.body)]);
    const invited = (await play([[owner, invite(pool, 2)]])).state;
    const m1 = await machine(1);
    const own = new Uint8Array(SEALED_MIN_BYTES);
    const pendingJoin = joinEntry(await lineOf(pool), { key: m1.key, privateKey: m1.pair.privateKey, enc: m1.enc, endpoint: E(1) }, invited, T0 + 120, { epoch: 0, bytes: own });
    own[0] = 1;
    const joined = await pendingJoin;
    expect(joined.state.footing.hash).toBe(entryHash(joined.entry.body));
    // A line that signs another body than the one that was judged gives no entry.
    const line = await lineOf(pool);
    const shifty = { key: line.key, list: line.list, signJoin: async (body: EntryBody) => await line.signJoin({ ...body, issued_at: body.issued_at + 1 }) };
    expect(await joinEntry(shifty, { key: m1.key, privateKey: m1.pair.privateKey, enc: m1.enc, endpoint: E(1) }, invited, T0 + 120, null).then(() => "signed", whyNot)).toBe("not written");
  });

  test("a member that is behind signs nobody in: it writes a removal and the epoch after it, and nothing else (`behind`)", async () => {
    // The review's sequence: a PC joined after the member fell behind, so the member does not know its key, and would give it to a carried PC.
    const m2 = await machine(2);
    const steps: Step[] = [[owner, carriedPc(1)], [owner, carried(late)], [owner, device(phone)], [owner, invite(pool, 3)], [owner, later()], [pool, join(2)]];
    const played = await play(steps);
    const behind = played.state;
    const reads = (await play(steps, 2)).state;
    const reused: ListKind = { kind: "pc", key: m2.key, endpoint: E(1), enc: m2.enc, card: await card(m2, E(1)), sealed: SEAL };
    expect([behind.behind, reads.behind]).toEqual([5, null]);
    // On its own state that pc would count, which is why it is refused before the state is asked.
    const held = await next(at(played.links, 6), owner, await pc(m2, 1));
    expect(said((await takeEntry(behind, held.held)).outcome)).toBe("counts");
    expect([await written(reads, reused), await written(behind, reused)]).toEqual(["no_effect key_reused", "behind"]);
    // Nobody is written in while behind, by any kind: a device, a PC, an invite, a carried, a device's own card.
    const kinds: ListKind[] = [
      await deviceKind(tablet),
      { kind: "pc", key: desk.key, endpoint: E(1), enc: desk.enc, card: await card(desk, E(1)), sealed: SEAL },
      { kind: "pc", key: desk.key, endpoint: E(7), enc: desk.enc, card: await card(desk, E(7)), sealed: SEAL },
      { kind: "invite", key: pool2.key, exp: EXP, uses: 1, auto: true, sealed: SEAL },
      { kind: "carried", key: tablet.key, role: "drive", sealed: SEAL },
      { kind: "carried", endpoint: E(8), sealed: SEAL },
    ];
    for (const kind of kinds) expect({ kind: kind.kind, why: await written(behind, kind) }).toEqual({ kind: kind.kind, why: "behind" });
    expect(await written(behind, { kind: "card", enc: late.enc }, late)).toBe("behind");
    // Nothing is out yet, so no epoch either; that is the same answer as for everybody.
    expect(await written(behind, epochKind(behind))).toBe("epoch_not_needed");
    // A removal is signed, and the epoch it calls for after it: by a key, by a relay key, in one batch.
    expect(await written(behind, { kind: "remove", ends: phone.key })).toBe("signed");
    expect(await written(behind, { kind: "remove", endpoint: E(1) })).toBe("signed");
    const batch = await signListEntries(behind, [{ kind: "remove", ends: phone.key }, epochKind], signer(owner), T0 + 600);
    expect([batch.entries.map((item) => readBody(item.entry.body).kind), batch.state.epoch, batch.state.behind]).toEqual([["remove", "epoch"], 1, 5]);
    // One step that lets somebody in refuses the whole batch.
    expect(await signListEntries(behind, [{ kind: "remove", ends: phone.key }, await deviceKind(tablet)], signer(owner), T0 + 600).then(() => "signed", whyNot)).toBe("behind");
    // A PC that reads the list behind does not join it by itself.
    const m3 = await machine(3);
    const joining = { key: m3.key, privateKey: m3.pair.privateKey, enc: m3.enc, endpoint: E(3) };
    expect(await joinEntry(await lineOf(pool), joining, behind, T0 + 600, null).then(() => "signed", whyNot)).toBe("behind");
    expect(await joinEntry(await lineOf(pool), joining, reads, T0 + 600, null).then(() => "signed", whyNot)).toBe("signed");
    // What is judged is what is written: an object that says `remove` for a while and `pc` afterwards gets no pc signed, whenever it turns.
    const turned: string[] = [];
    for (const turnsAfter of [0, 1, 2, 3]) {
      let asked = 0;
      const shifty = { ...reused, get kind() { asked++; return asked <= turnsAfter ? "remove" : "pc"; } } as unknown as ListKind;
      turned.push(await signListEntry(behind, shifty, signer(owner), T0 + 600).then((entry) => `signed a ${readBody(entry.entry.body).kind}`, (error: unknown) => (error instanceof ListKindError ? error.code : whyNot(error))));
    }
    expect(turned).toEqual(["behind", "entry_invalid", "signed a remove", "signed a remove"]);
    // A member that is stopped for a replay is told that first: it writes nothing at all.
    const stopped = (await takeEntry(behind, (await next(at(played.links, 6), stranger, later())).held)).state;
    expect([stopped.needs_replay === undefined, await written(stopped, { kind: "remove", ends: phone.key })]).toEqual([false, "not written"]);
  });

  test("a writer that is stopped for a replay writes nothing, and a private key that is not the signer's signs nothing that leaves", async () => {
    const { links, state } = await play([[owner, later()]]);
    const stopped = (await takeEntry(state, (await next(at(links, 1), stranger, later())).held)).state;
    expect(await refusal(stopped, await deviceKind(phone))).toBe("not written");
    const { state: fresh } = await play([]);
    await expect(signListEntry(fresh, await deviceKind(phone), { key: owner.key, privateKey: other.pair.privateKey }, T0 + 60)).rejects.toThrow(ListWriteError);
  });

  test("a PC that joined is put out in one batch: its relay key, the invite it joined with while that still lets a PC in, and the next epoch", async () => {
    const { links, state } = await play([[owner, invite(pool, 3)], [pool, join(1)], [owner, pc(desk, 2)]]);
    expect(pcRemoval(state, E(1))).toEqual([{ kind: "remove", endpoint: E(1) }, { kind: "remove", ends: pool.key }]);
    expect(pcRemoval(state, E(2))).toEqual([{ kind: "remove", ends: desk.key }]);
    expect(pcRemoval(state, E(9))).toEqual([]);
    const batch = await signListEntries(state, [
      ...pcRemoval(state, E(1)),
      // The next epoch is made from who stays: the state so far says who.
      (after) => { expect(wrapKeys(after, T0)).toEqual([owner.enc, desk.enc]); return { kind: "epoch", epoch: after.epoch, opens: OPENS(1), link: LINK(1) }; },
    ], signer(owner), T0 + 600);
    expect(batch.entries.map((item) => readBody(item.entry.body).seq)).toEqual([4, 5, 6]);
    const shown = await shownList({ entries: links.map((item) => item.text), state }, { after: 3, entries: batch.entries.map((item) => item.text), head: { seq: 6, hash: entryHash(at(batch.entries, 2).entry.body) } });
    expect([shown.took.map((item) => said(item.outcome)), shown.member.state]).toEqual([["counts", "counts", "counts"], batch.state]);
    expect([holdsPc(batch.state, E(1)), inviteRefusal(batch.state, pool.key), batch.state.epoch, sealEpoch(batch.state, T0)]).toEqual([false, "invite_revoked", 1, { epoch: 1, opens: OPENS(1) }]);
    // A spent invite needs no end; and one step that would not count refuses the whole batch.
    const spent = await play([[owner, invite(pool, 1)], [pool, join(1)]]);
    expect(pcRemoval(spent.state, E(1))).toEqual([{ kind: "remove", endpoint: E(1) }]);
    await expect(signListEntries(state, [{ kind: "remove", endpoint: E(1) }, { kind: "remove", endpoint: E(1) }], signer(owner), T0 + 600)).rejects.toThrow(ListWriteError);
  });

  test("over generated histories of honest writers, of whom one is behind, a member that is behind holds exactly the PCs it held that a member reading everything still holds", async () => {
    let promoted = 0;
    let removals = 0;
    let byBehind = 0;
    let refusedBehind = 0;
    let spentUnseen = 0;
    for (let seed = 61; seed <= 84; seed++) {
      const random = seeded(seed);
      const pick = <Item>(items: readonly Item[]): Item => at(items, Math.floor(random() * items.length));
      const all = [owner, phone, tablet, desk, tower, pool, pool2, plain, late, stranger, other];
      // A member that reads everything (level 2) and a member of level 1 take the same entries, and both write.
      const genesis2 = await signGenesis({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL }, signer(owner), T0, 2);
      const held = (entry: { readonly body: Uint8Array; readonly signature: Uint8Array }): HeldEntry => ({ entry, body: readBody(entry.body), hash: entryHash(entry.body), list: genesis2.state.list });
      let full = genesis2.state;
      let behind = firstListState(held(genesis2.entry), 1);
      const place = async (entry: { readonly body: Uint8Array; readonly signature: Uint8Array }) => {
        const outcome = (await takeEntry(full, held(entry)));
        full = outcome.state;
        behind = (await takeEntry(behind, held(entry))).state;
        return said(outcome.outcome);
      };
      // Whoever was in the account before: three PCs and a device, carried in. Then an invite for one PC, open when the member falls behind.
      for (const kind of [{ kind: "carried", endpoint: E(1), sealed: SEAL }, { kind: "carried", endpoint: E(2), sealed: SEAL }, { kind: "carried", endpoint: E(3), sealed: SEAL }, { kind: "carried", key: phone.key, role: "drive", sealed: SEAL },
        { kind: "invite", key: pool.key, exp: EXP, uses: 1, auto: true, sealed: SEAL }] as ListKind[]) {
        await place((await signListEntry(full, kind, signer(owner), T0 + 30)).entry);
      }
      const fallsBehindAt = Math.floor(random() * 6);
      for (let step = 0; step < 70; step++) {
        const issued = T0 + 60 * (step + 1);
        const signers = all.filter((key) => signerPower(full, key.key) !== null);
        if (signers.length === 0) break;
        if (step === fallsBehindAt) {
          // One entry of a later level, by a signer of power full: the member of level 1 is behind from here.
          const by = signers.find((key) => signerPower(full, key.key) === "full");
          if (by === undefined) break;
          await place(await signEntry({ ...bodyOf(later(), by, { seq: full.footing.seq + 1, list: full.list, prev: full.footing.hash }), issued_at: issued }, by.pair.privateKey));
          continue;
        }
        const by = pick(signers);
        const about = pick(all);
        const n = 1 + Math.floor(random() * 6);
        // Who writes this entry: the member that reads everything, or the one of level 1, each on its own state.
        const writer = random() < 0.4 ? behind : full;
        const names: Sealed | null = sealEpoch(writer, issued) === null ? null : { epoch: writer.epoch, bytes: SEALED };
        const power: SignerPower = random() < 0.3 ? "bound" : "full";
        const kinds: (() => Promise<ListKind> | ListKind)[] = [
          async () => ({ kind: "device", key: about.key, power, role: "drive", until: null, enc: about.enc, card: await card(about, null, { list: full.list }), sealed: names, rotates: false }),
          async () => ({ kind: "pc", key: about.key, endpoint: E(n), enc: about.enc, card: await card(about, E(n), { list: full.list }), sealed: names }),
          async () => ({ kind: "pc", key: about.key, endpoint: E(n), enc: about.enc, card: await card(about, E(n), { list: full.list }), sealed: names }),
          () => ({ kind: "invite", key: about.key, exp: EXP, uses: 1 + Math.floor(random() * 2), auto: true, sealed: names }),
          async () => ({ kind: "join", endpoint: E(n), pc: about.key, enc: about.enc, card: await card(about, E(n), { list: full.list, invite: by.key }), sealed: names }),
          () => ({ kind: "remove", ends: about.key }),
          () => ({ kind: "remove", endpoint: E(n) }),
          () => ({ kind: "remove", endpoint: E(n) }),
          () => ({ kind: "epoch", epoch: writer.epoch, opens: OPENS(writer.epoch + 1), link: LINK(writer.epoch + 1) }),
        ];
        const kind = await pick(kinds)();
        const written = await signListEntry(writer, kind, signer(by), issued).catch((error: unknown) => {
          if (error instanceof ListWriteError && error.reason === "behind") refusedBehind++;
          if (error instanceof ListWriteError || error instanceof ListKindError) return null;
          throw error;
        });
        if (written === null) continue;
        const before = behind;
        const where = `seed ${seed} step ${step} ${by.name} ${kind.kind}${writer === behind ? " by the member of level 1" : ""}`;
        const wasBehind = writer === behind && behind.behind !== null;
        // What a member signs counts for the member that reads everything, whichever of the two wrote it.
        expect({ where, told: await place(written.entry) }).toEqual({ where, told: "counts" });
        expect({ where, same: JSON.stringify(writer === before ? behind : full) === JSON.stringify(written.state) }).toEqual({ where, same: true });
        if (wasBehind) {
          byBehind++;
          // While it is behind a member writes a removal and the epoch after one, and nothing else.
          expect({ where, kind: kind.kind === "remove" || kind.kind === "epoch" }).toEqual({ where, kind: true });
        }
        if (kind.kind === "remove") removals++;
        // Every key the member that is behind wraps an epoch's key to is one the member that reads everything wraps to.
        for (const key of wrapKeys(behind, issued)) expect({ where, key: key.slice(-8), wrapped: wrapKeys(full, issued).includes(key) }).toEqual({ where, key: key.slice(-8), wrapped: true });
        if (Object.keys(behind.invites).some((key) => inviteRefusal(behind, key) === null && inviteRefusal(full, key) === "invite_spent")) spentUnseen++;
        if (behind.behind !== null && kind.kind === "pc" && before.pcs[kind.endpoint] !== undefined && behind.pcs[kind.endpoint]?.how === "added") promoted++;
        // Every PC the member that is behind has a row for is in for it exactly when it is in for the member that reads everything; it never holds one that the other put out.
        for (const endpoint of Object.keys(behind.pcs)) expect({ where, endpoint: pcName(endpoint), held: holdsPc(behind, endpoint) }).toEqual({ where, endpoint: pcName(endpoint), held: holdsPc(full, endpoint) });
        for (const endpoint of Object.keys(full.pcs)) if (holdsPc(behind, endpoint)) expect({ where, endpoint: pcName(endpoint), held: holdsPc(full, endpoint) }).toEqual({ where, endpoint: pcName(endpoint), held: true });
        // And it holds no relay key that came in after it fell behind.
        if (behind.behind !== null) for (const [endpoint, row] of Object.entries(full.pcs)) if (before.pcs[endpoint] === undefined && behind.pcs[endpoint] === undefined) expect({ where, endpoint: pcName(endpoint), since: row.seq >= behind.behind }).toEqual({ where, endpoint: pcName(endpoint), since: true });
      }
    }
    // The histories gave carried PCs their keys while the member was behind, put PCs out, had the member that is behind write and be refused, and spent an invite it still took for open, often enough to mean something.
    expect([promoted > 5, removals > 30, byBehind > 20, refusedBehind > 50, spentUnseen > 3]).toEqual([true, true, true, true, true]);
  }, 120_000);

  test("over generated histories of honest writers, no key is ever a signer with no name", async () => {
    let total = 0;
    for (let seed = 41; seed <= 50; seed++) {
      const random = seeded(seed);
      const pick = <Item>(items: readonly Item[]): Item => at(items, Math.floor(random() * items.length));
      const all = [owner, phone, tablet, desk, tower, pool, pool2, plain, late, stranger, other];
      let state = (await signGenesis({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL }, signer(owner), T0)).state;
      let written = 0;
      for (let step = 0; step < 150; step++) {
        const signers = all.filter((key) => signerPower(state, key.key) !== null);
        // Whoever acts first wins: a list may end with everybody out.
        if (signers.length === 0) break;
        const by = pick(signers);
        const about = pick(all);
        const n = 1 + Math.floor(random() * 6);
        // An honest writer seals where the writer's rule lets it, and writes no names where it does not.
        const names: Sealed | null = sealEpoch(state, T0 + 60 * (step + 1)) === null ? null : { epoch: state.epoch, bytes: SEALED };
        const power: SignerPower = random() < 0.3 ? "bound" : "full";
        const kinds: (() => Promise<ListKind> | ListKind)[] = [
          async () => ({ kind: "device", key: about.key, power, role: power === "bound" && random() < 0.5 ? "watch" : "drive", until: power === "bound" && random() < 0.5 ? T0 + 86400 : null, enc: about.enc, card: await card(about), sealed: names, rotates: random() < 0.1 }),
          async () => ({ kind: "pc", key: about.key, endpoint: E(n), enc: about.enc, card: await card(about, E(n)), sealed: names }),
          () => ({ kind: "invite", key: about.key, exp: EXP, uses: 1 + Math.floor(random() * 2), auto: random() < 0.7, sealed: names }),
          async () => ({ kind: "join", endpoint: E(n), pc: about.key, enc: about.enc, card: await card(about, E(n), { invite: by.key }), sealed: names }),
          () => ({ kind: "remove", ends: about.key }),
          () => ({ kind: "remove", endpoint: E(n) }),
          () => ({ kind: "carried", key: about.key, role: "drive", sealed: names }),
          () => ({ kind: "carried", endpoint: E(n), sealed: names }),
          () => ({ kind: "card", enc: by.enc }),
          () => ({ kind: "epoch", epoch: state.epoch, opens: OPENS(state.epoch + 1), link: LINK(state.epoch + 1) }),
        ];
        const result = await signListEntry(state, await pick(kinds)(), signer(by), T0 + 60 * (step + 1)).catch((error: unknown) => {
          if (error instanceof ListWriteError || error instanceof ListKindError) return null;
          throw error;
        });
        if (result === null) continue;
        written++;
        state = result.state;
        expect({ seed, step, nameless: Object.values(state.signers).filter((row) => row.as === null).length, listed: listView(state).signers }).toEqual({ seed, step, nameless: 0, listed: [] });
      }
      total += written;
    }
    // Some lists end early, with everybody out; over all of them enough was written to mean something.
    expect(total).toBeGreaterThan(100);
  }, 120_000);
});

describe("what a caller reads from a state", () => {
  test("the time a caller judges by is the latest of its own clock, the time it last saved and the list's own time", async () => {
    const { state } = await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })]]);
    expect([listClock(state, T0 + 500, null), listClock(state, T0 + 500, T0 + 900), listClock(state, 0, null), listClock(state, 0, T0 + 10)]).toEqual([T0 + 500, T0 + 900, T0 + 60, T0 + 60]);
    // A PC whose clock reads early lets no borrowed browser in past its until: it passes the helper's time.
    expect([admitsDevice(state, tablet.key, listClock(state, 0, T0 + 3599)), admitsDevice(state, tablet.key, listClock(state, 0, T0 + 3600))]).toEqual(["drive", null]);
    // And by itself admitsDevice believes no clock that reads before the list's own time.
    const head = (await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })]])).links;
    const entry = await link2({ ...bodyOf(opening(0), owner, { seq: 2, list: LIST, prev: at(head, 1).held.hash }), issued_at: T0 + 4000 }, owner);
    const after = (await takeEntry((await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 3600) })]])).state, entry.held)).state;
    expect([after.full_at, admitsDevice(after, tablet.key, 0)]).toEqual([T0 + 4000, null]);
    // The same for whom a key is wrapped to, and for whether anything is sealed.
    expect([wrapKeys(after, 0), sealEpoch(after, 0)]).toEqual([[owner.enc], null]);
  });

  test("a member that is stopped for a replay answers for nobody: no invite is open to it, and it lists nothing", async () => {
    const { links, state } = await play([[owner, invite(pool)], [owner, later()]]);
    const stopped = (await takeEntry(state, (await next(at(links, 2), stranger, later())).held)).state;
    expect([inviteRefusal(state, pool.key), inviteRefusal(stopped, pool.key), readProofRefusal(stopped, { key: pool.key, list: LIST, after: null, at: T0 }), pcRemoval(stopped, E(1))])
      .toEqual([null, "invite_unknown", "invite_unknown", []]);
  });

  test("a PC lets a device in while its key is a signer and before its until, as what its role says", async () => {
    const { state } = await play([[owner, device(phone, "bound", "watch")], [owner, device(tablet, "bound", "drive", { until: String(T0 + 86400) })], [owner, pc(desk, 1)], [owner, invite(pool)], [owner, device(late)], [owner, remove(late)]]);
    expect([admitsDevice(state, owner.key, T0), admitsDevice(state, phone.key, T0)]).toEqual(["drive", "watch"]);
    expect([admitsDevice(state, tablet.key, T0 + 86399), admitsDevice(state, tablet.key, T0 + 86400), admitsDevice(state, tablet.key, T0 + 90000)]).toEqual(["drive", null, null]);
    // A PC, an invite, a key that is out and a key nobody added are no devices.
    for (const key of [desk, pool, late, stranger]) expect(admitsDevice(state, key.key, T0)).toBeNull();
    // Past its until a bound device is still a signer, and still ends itself.
    expect(signerPower(state, tablet.key)).toBe("bound");
  });

  test("the devices, the PCs and the invites, each in the order it came in, those that are out among them", async () => {
    const { state } = await play([[owner, carriedPc(3)], [owner, pc(desk, 1)], [owner, device(phone)], [owner, invite(pool, 1)], [pool, join(2)], [owner, remove(phone)], [owner, invite(plain, 1, false)]]);
    const view = listView(state);
    expect([view.stopped, view.signers]).toEqual([false, []]);
    expect(view.devices.map((row) => [who(row.key), row.power, row.role, row.seq, who(row.by), row.ended])).toEqual([["owner", "full", "drive", 0, "owner", null], ["phone", "full", "drive", 3, "owner", 6]]);
    expect(view.pcs.map((row) => [pcName(row.endpoint), row.how, row.allows, row.seq])).toEqual([["e3", "carried", false, 1], ["e1", "added", true, 2], ["e2", "joined", false, 5]]);
    expect(view.invites.map((row) => [who(row.key), row.joins, row.uses, row.auto, row.refusal])).toEqual([["pool", 1, 1, true, "invite_spent"], ["plain", 0, 1, false, null]]);
    expect([holdsPc(state, E(1)), holdsPc(state, E(2)), holdsPc(state, E(3)), holdsPc(state, E(4))]).toEqual([true, true, true, false]);
  });

  test("a PC that was put out allows nobody and is not in", async () => {
    const { state } = await play([[owner, pc(desk, 1)], [owner, remove(desk)]]);
    expect([listView(state).pcs.map((row) => [row.allows, row.removed]), holdsPc(state, E(1))]).toEqual([[[false, 2]], false]);
  });
});

describe("a member that is behind", () => {
  const before = async (): Promise<Step[]> => [[owner, await device(phone)], [owner, invite(pool)], [pool, await join(1)], [owner, later()]];

  test("an entry that its kind's rule counts still counts, and the state takes nothing in: nobody new is let in", async () => {
    const { said: told, state } = await play([...(await before()), [owner, device(late)], [late, invite(pool2)], [pool, join(2)], [owner, pc(desk, 3)]]);
    expect(told.slice(3)).toEqual(["cannot_read", "counts", "counts", "counts", "counts"]);
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", pool: "bound invite @2 by owner", late: "full no name @5 by owner", pool2: "bound no name @6 by late", desk: "full no name @8 by owner" },
      devices: { owner: "drive", phone: "drive" }, pcs: { e1: "joined machine1 @3 with pool" }, invites: { pool: "1 of 5 auto" },
    });
    expect([state.level, state.needs, state.behind]).toEqual([1, 2, 4]);
  });

  test("it keeps its devices and applies every removal, also one signed by a device added after it fell behind", async () => {
    const { said: told, state } = await play([...(await before()), [owner, device(late)], [late, removePc(1)], [late, remove(pool)], [phone, remove(owner)], [late, remove(phone)]]);
    expect(told.slice(4)).toEqual(new Array<string>(5).fill("counts"));
    expect(seen(state)).toEqual({
      signers: { owner: `${OWNER} ended@8`, phone: "full device @1 by owner ended@9", pool: "bound invite @2 by owner ended@7", late: "full no name @5 by owner" },
      devices: { owner: "drive", phone: "drive" }, pcs: { e1: "joined machine1 @3 with pool removed@6" }, invites: { pool: "1 of 5 auto" },
    });
  });

  test("a carried PC that is in gets its keys from a member that is behind too, so both put it out by the same entry", async () => {
    const promoted: Step[] = [[owner, carriedPc(1)], [owner, later()], [owner, pc(desk, 1)]];
    const behind = await play(promoted);
    const reads = await play(promoted, 2);
    // Nobody new came in: the PC was in. Its key has its name, and the member knows which PC the key is.
    expect([behind.said, behind.state.behind, seen(behind.state).pcs, seen(behind.state).signers.desk, behind.state.pc_keys]).toEqual([["counts", "cannot_read", "counts"], 2, { e1: "added desk @3" }, "full pc @3 by owner", { [desk.key]: E(1) }]);
    expect(seen(reads.state).pcs).toEqual(seen(behind.state).pcs);
    for (const level of [1, 2]) {
      // The end of the key puts the PC out, and its relay key alone does not, for both.
      const byKey = await play([...promoted, [owner, remove(desk)]], level);
      expect({ level, told: byKey.said.at(-1), pcs: seen(byKey.state).pcs, held: holdsPc(byKey.state, E(1)) }).toEqual({ level, told: "counts", pcs: { e1: "added desk @3 removed@4" }, held: false });
      const byRelayKey = await play([...promoted, [owner, removePc(1)]], level);
      expect({ level, told: byRelayKey.said.at(-1), held: holdsPc(byRelayKey.state, E(1)) }).toEqual({ level, told: "no_effect ends_needed", held: true });
      // A carried PC that got no keys is still put out by its relay key.
      const plainCarried = await play([[owner, carriedPc(1)], [owner, later()], [owner, removePc(1)]], level);
      expect({ level, told: plainCarried.said.at(-1), held: holdsPc(plainCarried.state, E(1)) }).toEqual({ level, told: "counts", held: false });
    }
    // A PC that was not in before the member fell behind is still not let in, and neither is anybody else.
    const fresh = await play([[owner, carriedPc(1)], [owner, later()], [owner, pc(desk, 2)], [owner, device(phone)]]);
    expect([seen(fresh.state).pcs, seen(fresh.state).signers.desk, seen(fresh.state).signers.phone]).toEqual([{ e1: "carried @1" }, "full no name @3 by owner", "full no name @4 by owner"]);
    // The saved state of the member that is behind reads again; one that claims a new PC behind is no state.
    expect(readListState(JSON.parse(JSON.stringify(behind.state)), 1)).toEqual(behind.state);
    const claims = JSON.parse(JSON.stringify(fresh.state)) as { signers: Record<string, { as: string | null }>; pcs: Record<string, unknown>; pc_keys: Record<string, string> };
    (claims.signers[phone.key] ?? { as: null }).as = "device";
    expect(readListState(claims, 1)).toBeNull();
    // Nor is one that claims a PC that joined, or one that was carried in, at a place after the member fell behind.
    const m1 = await machine(1);
    const joins = await play([[owner, invite(pool)], [owner, later()], [pool, join(1)]]);
    expect([joins.said.at(-1), seen(joins.state).pcs]).toEqual(["counts", {}]);
    const joined = JSON.parse(JSON.stringify(joins.state)) as { pcs: Record<string, unknown>; pc_keys: Record<string, string>; invites: Record<string, { joins: number }> };
    joined.pcs[E(1)] = { how: "joined", key: m1.key, enc: m1.enc, seq: 3, invite: pool.key, removed: null };
    joined.pc_keys[m1.key] = E(1);
    (joined.invites[pool.key] ?? { joins: 0 }).joins = 1;
    expect(readListState(joined, 1)).toBeNull();
    const carriedLate = JSON.parse(JSON.stringify(joins.state)) as { pcs: Record<string, unknown> };
    carriedLate.pcs[E(4)] = { how: "carried", key: null, enc: null, seq: 3, invite: null, removed: null };
    expect(readListState(carriedLate, 1)).toBeNull();
    // The same rows before it fell behind are a state.
    const before = await play([[owner, invite(pool)], [pool, join(1)], [owner, later()]]);
    expect(readListState(JSON.parse(JSON.stringify(before.state)), 1)).toEqual(before.state);
    // The one shape it takes behind is a PC a person added, at a relay key, whose key's row is a PC's and names that same relay key. Each neighbour is refused.
    type Saved = { signers: Record<string, { as: string | null; seq: number }>; pcs: Record<string, { how: string; key: string | null; seq: number }>; pc_keys: Record<string, string>; invites: Record<string, unknown> };
    const shape = () => JSON.parse(JSON.stringify(behind.state)) as Saved;
    const refused: [string, (value: Saved) => void][] = [
      ["the key's row has no name", (value) => { (value.signers[desk.key] ?? { as: "" }).as = null; }],
      ["the key's row is a device's", (value) => { (value.signers[desk.key] ?? { as: "" }).as = "device"; }],
      ["the key's row is a PC's and no PC has the key", (value) => { delete value.pcs[E(1)]; delete value.pc_keys[desk.key]; }],
      ["the key names another relay key", (value) => { value.pc_keys[desk.key] = E(2); }],
      ["the key names no relay key", (value) => { delete value.pc_keys[desk.key]; }],
      ["the PC's row says it joined", (value) => { (value.pcs[E(1)] ?? { how: "" }).how = "joined"; }],
      ["the PC's row says it was carried in there", (value) => { const row = value.pcs[E(1)]; if (row) { row.how = "carried"; row.key = null; (row as unknown as { enc: null }).enc = null; } }],
      ["the PC's row stands at another place than its key's", (value) => { (value.pcs[E(1)] ?? { seq: 0 }).seq = 2; }],
    ];
    for (const [name, change] of refused) {
      const value = shape();
      change(value);
      expect({ name, state: readListState(value, 1) }).toEqual({ name, state: null });
    }
    expect(readListState(shape(), 1)).toEqual(behind.state);
    // An invite placed after the member fell behind has no name for it either.
    const invited = await play([[owner, carriedPc(1)], [owner, later()], [owner, invite(pool)]]);
    expect(seen(invited.state).signers.pool).toBe("bound no name @3 by owner");
    const withInvite = JSON.parse(JSON.stringify(invited.state)) as Saved;
    (withInvite.signers[pool.key] ?? { as: "" }).as = "invite";
    withInvite.invites[pool.key] = { exp: EXP, uses: 5, joins: 0, auto: true };
    expect(readListState(withInvite, 1)).toBeNull();
  });

  test("known limit: a member that is behind does not know the keys of PCs that joined after it fell behind", async () => {
    // A pc that names such a key for a carried PC is written by nobody who signs only what counts. Where somebody writes it all the same:
    const m2 = await machine(2);
    const steps: Step[] = [[owner, carriedPc(1)], [owner, invite(pool)], [owner, later()], [pool, join(2)], [owner, pc(m2, 1)], [owner, removePc(1)]];
    const reads = await play(steps, 2);
    const behind = await play(steps);
    // The member that reads everything knows the key and gives the carried PC none: its relay key puts it out.
    expect([reads.said.slice(3), holdsPc(reads.state, E(1))]).toEqual([["counts", "no_effect key_reused", "counts"], false]);
    // The member that is behind took the keys, so the relay key alone does not put the PC out for it: it holds it until it replays.
    expect([behind.said.slice(3), holdsPc(behind.state, E(1))]).toEqual([["counts", "counts", "no_effect ends_needed"], true]);
    // Once it reads everything it holds what the others hold.
    expect(holdsPc((await replayList(behind.texts, 2, { saved: behind.state })).member?.state ?? behind.state, E(1))).toBe(false);
  });

  test("the keys of a carried PC are the one thing a member that is behind takes in: every check of a pc still decides it", async () => {
    const start: Step[] = [[owner, carriedPc(1)], [owner, device(tablet, "bound")], [owner, later()]];
    const told = async (step: Step, more: readonly Step[] = []) => {
      const played = await play([...start, ...more, step]);
      return [played.said.at(-1), seen(played.state).pcs.e1];
    };
    expect(await told([owner, pc(desk, 1)])).toEqual(["counts", "added desk @4"]);
    // Who may sign, the form, the card, the epoch, the key: each as for a member that reads everything, and the PC stays as it was.
    expect(await told([tablet, pc(desk, 1)])).toEqual(["passed_over signer_not_allowed", "carried @1"]);
    expect(await told([stranger, pc(desk, 1)])).toEqual(["passed_over signer_unknown", "carried @1"]);
    expect(await told([owner, plus(await pc(desk, 1), { note: "x" })])).toEqual(["no_effect entry_invalid", "carried @1"]);
    expect(await told([owner, plus(await pc(desk, 1), { card: await card(desk, E(2)) })])).toEqual(["no_effect card_invalid", "carried @1"]);
    expect(await told([owner, plus(await pc(desk, 1), { epoch: "1" })])).toEqual(["no_effect epoch_other", "carried @1"]);
    expect(await told([owner, pc(tablet, 1)])).toEqual(["passed_over key_reused", "carried @1"]);
    // A carried PC that is out gets no keys, and a relay key that was not in is not let in.
    expect(await told([owner, pc(desk, 1)], [[owner, removePc(1)]])).toEqual(["no_effect endpoint_reused", "carried @1 removed@4"]);
    const fresh = await play([...start, [owner, pc(desk, 2)]]);
    expect([fresh.said.at(-1), seen(fresh.state).pcs, holdsPc(fresh.state, E(2))]).toEqual(["counts", { e1: "carried @1" }, false]);
    // It never moves a PC to another relay key: a second pc at the same one changes nothing.
    expect(await told([owner, pc(tower, 1)], [[owner, pc(desk, 1)]])).toEqual(["no_effect endpoint_reused", "added desk @4"]);
  });

  test("a state that a higher level wrote is stopped only until this level's replay reaches its footing: the member is then behind, and lets nobody new in", async () => {
    // The footing of the higher level's state is an entry this level cannot read.
    const steps: Step[] = [[owner, device(phone)], [owner, later()]];
    const higher = await play(steps, 2);
    const read = readListState(JSON.parse(JSON.stringify(higher.state)), 1);
    if (read === null) throw new Error("the higher level's state does not read");
    expect([read.needs_replay, admitsDevice(read, phone.key, T0), listView(read).stopped]).toEqual([higher.state.footing, null, true]);
    // Told that state, this level's replay takes the footing entry as one it cannot read: the stop is done with, and the member is behind from there.
    const replayed = await replayList(higher.texts, 1, { saved: read });
    const state = replayed.member?.state;
    if (state === undefined) throw new Error("no member");
    expect([replayed.stopped, replayed.stuck, state.needs_replay, state.level, state.behind, state.needs, replayed.took.map((item) => said(item.outcome))]).toEqual([null, false, undefined, 1, 2, 2, ["counts", "counts", "cannot_read"]]);
    // It answers again for whom it held, and behind it lets nobody new in: what a later entry adds is a signer with no name.
    expect(admitsDevice(state, phone.key, T0)).toBe("drive");
    const added = await takeEntry(state, (await next(at(higher.links, 2), owner, await device(late))).held);
    expect([said(added.outcome), seen(added.state).signers.late, admitsDevice(added.state, late.key, T0)]).toEqual(["counts", "full no name @3 by owner", null]);
    // An entry it cannot place stops it, and that stop is never replayed away: the entry is not taken.
    const unplaced = await next(at(higher.links, 2), stranger, later());
    const stopped = await replayList([...higher.texts, unplaced.text], 1, { saved: read });
    expect([stopped.stopped, stopped.stuck, stopped.member?.state.needs_replay, stopped.member?.entries.length]).toEqual([{ seq: 3, code: "needs_replay" }, true, { seq: 3, hash: unplaced.held.hash }, 3]);
    const again = await replayList([...higher.texts, unplaced.text], 1, { saved: stopped.member?.state ?? null });
    expect([again.stuck, again.member?.state.needs_replay]).toEqual([true, { seq: 3, hash: unplaced.held.hash }]);
  });

  test("a carried device's card counts while the member is behind, and the member takes no encryption key from it", async () => {
    const { said: told, state } = await play([[owner, carried(phone)], [owner, later()], [phone, cardOf(phone)]]);
    expect([told, state.behind, state.devices[phone.key]]).toEqual([["counts", "cannot_read", "counts"], 2, { role: "drive", until: null, enc: null, carried: true }]);
    expect(wrapKeys(state, T0)).toEqual([owner.enc]);
    // Not behind, the same entry gives the device its key.
    expect((await play([[owner, carried(phone)], [phone, cardOf(phone)]])).state.devices[phone.key]?.enc).toBe(phone.enc);
  });

  test("with its level raised it replays to the full state", async () => {
    const steps: Step[] = [...(await before()), [owner, device(late)], [late, invite(pool2)], [pool2, join(3, undefined, pool2)], [pool, join(2)], [late, removePc(1)]];
    const lower = await play(steps);
    const raised = await replayList(lower.texts, 2, { saved: lower.state });
    expect(lower.said.slice(3)).toEqual(["cannot_read", "counts", "counts", "no_effect invite_unknown", "counts", "counts"]);
    expect(raised.took.slice(4).map((item) => said(item.outcome))).toEqual(["no_effect entry_invalid", "counts", "counts", "counts", "counts", "counts"]);
    expect(raised.member === null ? null : seen(raised.member.state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", pool: "bound invite @2 by owner", late: "full device @5 by owner", pool2: "bound invite @6 by late" },
      devices: { owner: "drive", phone: "drive", late: "drive" },
      pcs: { e1: "joined machine1 @3 with pool removed@9", e3: "joined machine3 @7 with pool2", e2: "joined machine2 @8 with pool" },
      invites: { pool: "2 of 5 auto", pool2: "1 of 5 auto" },
    });
    expect([raised.member?.state.level, raised.member?.state.needs, raised.member?.state.behind]).toEqual([2, 2, null]);
  });

  test("an entry it cannot read does nothing of its kind, and adds and ends have applied; only a full signer's makes it behind", async () => {
    const higher = await play([[owner, { ...(await device(phone)), v: 2 }]]);
    expect([higher.said, seen(higher.state).signers.phone, higher.state.behind, higher.state.needs]).toEqual([["cannot_read"], "full no name @1 by owner", 1, 2]);
    const ending = await play([[owner, device(phone)], [owner, invite(pool)], [pool, later(2, { ends: pool })], [stranger, later()], [owner, device(tablet, "bound")]]);
    expect(ending.said).toEqual(["counts", "counts", "cannot_read", "passed_over signer_unknown", "counts"]);
    expect([seen(ending.state).signers.pool, seen(ending.state).signers.tablet, ending.state.behind]).toEqual(["bound invite @2 by owner ended@3", "bound device @5 by owner", null]);
  });
});

describe("a member from entry 0", () => {
  test("no entry, an entry 0 that does not hold, and one that is not the list it was given", async () => {
    expect(await replayList([], 1, { saved: null })).toEqual({ member: null, took: [], stopped: null, stuck: false });
    const forged = await first({ ...genesis(), signedWith: other });
    expect(await replayList([forged.text], 1, { saved: null })).toEqual({ member: null, took: [], stopped: { seq: 0, code: "signature_invalid" }, stuck: false });
    const head = await first();
    expect((await replayList([head.text], 1, { saved: null, given: "0".repeat(64) })).stopped).toEqual({ seq: 0, code: "list_mismatch" });
    expect((await replayList([head.text], 1, { saved: null, given: LIST })).member?.state.list).toBe(LIST);
  });

  test("a member follows a list only when its entry 0 is a genesis it can read: anything else stops it at entry 0 with entry_invalid", async () => {
    const stops = async (raw: Raw) => {
      const head = await first(raw);
      expect(() => firstListState(head.held, 1)).toThrow(ListKindError);
      return await replayList([head.text, (await next(head, owner, await device(phone))).text], 1, { saved: null });
    };
    for (const raw of [{ kind: "device", own: {} }, less(genesis(), "enc"), less(genesis(), "sealed"), less(genesis(), "epoch"), less(genesis(), "epoch_opens"), plus(genesis()),
      plus(genesis(), { account: "a".repeat(65) }), plus(genesis(), { account: "" }), plus(genesis(), { epoch: "1" }), plus(genesis(), { epoch_opens: "x" }),
      { ...genesis(), v: 2 }, { kind: "later_kind" }, plus(genesis(), { sealed: new Uint8Array(SEALED_MIN_BYTES - 1) })]) {
      expect(await stops(raw)).toEqual({ member: null, took: [], stopped: { seq: 0, code: "entry_invalid" }, stuck: false });
    }
  });

  test("it takes each entry it is given, entry 0 first, and stops at one that does not hold with what it took before", async () => {
    const { links, states } = await play([[owner, device(phone)], [phone, invite(pool)]]);
    const forged = await next(at(links, 2), pool, { ...(await join(1)), signedWith: other });
    const after = await next(forged, pool, await join(2));
    const replayed = await replayList([...links.map((item) => item.text), forged.text, after.text], 1, { saved: null });
    expect([replayed.stopped, replayed.member?.state, replayed.member?.entries.length, replayed.took.length]).toEqual([{ seq: 3, code: "signature_invalid" }, at(states, 2), 3, 3]);
  });

  test("a loose entry has no effect of its kind either, and is no footing", async () => {
    const { state, links, said: told } = await play([[owner, invite(pool)], [stranger, device(stranger)], [stranger, pc(other, 7)], [stranger, carriedPc(8)]]);
    expect(told.slice(1)).toEqual(["passed_over signer_unknown", "passed_over signer_unknown", "passed_over signer_unknown"]);
    expect([seen(state).signers, seen(state).pcs, state.footing]).toEqual([{ owner: OWNER, pool: "bound invite @1 by owner" }, {}, { seq: 1, hash: at(links, 1).held.hash }]);
    // The member signs its next entry on its footing, not on what a stranger put on top.
    expect(signingPlace({ entries: links.map((item) => item.text), state }, listHead({ entries: links.map((item) => item.text).slice(0, 2), state }))).toEqual({ list: LIST, prev: at(links, 1).held.hash, seq: 2 });
  });

  test("a replay is told the member's saved state and never gives a shorter history than that", async () => {
    const { texts, state } = await play([[owner, device(phone)], [phone, invite(pool)]]);
    expect((await replayList(texts, 1, { saved: state })).member?.state).toEqual(state);
    await expect(replayList(texts.slice(0, 2), 1, { saved: state })).rejects.toThrow(RangeError);
  });
});

describe("going back, on the signers' shownEntries", () => {
  test("padding of kinds that would let somebody in, and then the true list: its state is as if it had never seen the padding", async () => {
    const { links, state } = await play([[owner, invite(pool)]]);
    const head = at(links, 1);
    const padding = [await next(head, stranger, await device(stranger))];
    padding.push(await next(at(padding, 0), stranger, await join(9, stranger)));
    padding.push(await next(at(padding, 1), stranger, await pc(other, 8)));
    const truth = [await next(head, pool, await join(1))];
    truth.push(await next(at(truth, 0), owner, await device(phone)));
    const member = { entries: links.map((item) => item.text), state };

    const padded = await shownList(member, { after: 1, entries: padding.map((item) => item.text), head: { seq: 4, hash: at(padding, 2).held.hash } });
    expect(padded.took.map((item) => said(item.outcome))).toEqual(["passed_over signer_unknown", "passed_over invite_unknown", "passed_over signer_unknown"]);
    expect([padded.member.state, padded.member.entries.length, padded.stopped, padded.asks_after]).toEqual([state, 5, null, null]);
    const back = await shownList(padded.member, { after: 1, entries: truth.map((item) => item.text), head: { seq: 3, hash: at(truth, 1).held.hash } });
    expect([back.dropped_from, back.took.map((item) => said(item.outcome)), back.stopped, back.stuck]).toEqual([2, ["counts", "counts"], null, false]);
    const clean = await replayList([...member.entries, ...truth.map((item) => item.text)], 1, { saved: null });
    if (clean.member === null) throw new Error("the true list does not replay");
    expect([back.member.state, back.member.entries, listHead(back.member)]).toEqual([clean.member.state, clean.member.entries, { seq: 3, hash: at(truth, 1).held.hash }]);
    expect(seen(back.member.state)).toEqual({ signers: { owner: OWNER, pool: "bound invite @1 by owner", phone: "full device @3 by owner" }, devices: { owner: "drive", phone: "drive" }, pcs: { e1: "joined machine1 @2 with pool" }, invites: { pool: "1 of 5 auto" } });
  });

  test("another history under its footing stops it, and it keeps its state; an entry that does not hold stops it there", async () => {
    const { links, state } = await play([[owner, invite(pool)], [pool, join(1)]]);
    const member = { entries: links.map((item) => item.text), state };
    const otherTwo = await next(at(links, 1), pool, await join(2));
    const otherThree = await next(otherTwo, pool, await join(3));
    const stuck = await shownList(member, { after: 2, entries: [otherThree.text], head: { seq: 3, hash: otherThree.held.hash } });
    expect([stuck.stopped, stuck.stuck, stuck.member.state, stuck.took]).toEqual([{ seq: 3, code: "chain_broken" }, true, state, []]);
    const forged = await next(at(links, 2), pool, { ...(await join(2)), signedWith: other });
    const stopped = await shownList(member, { after: 2, entries: [forged.text], head: { seq: 3, hash: forged.held.hash } });
    expect([stopped.stopped, stopped.stuck, stopped.member.state]).toEqual([{ seq: 3, code: "signature_invalid" }, false, state]);
    const good = await next(at(links, 2), pool, await join(2));
    const went = await shownList(member, { after: 2, entries: [good.text], head: { seq: 3, hash: good.held.hash } });
    expect([went.took.map((item) => said(item.outcome)), seen(went.member.state).pcs]).toEqual([["counts"], { e1: "joined machine1 @2 with pool", e2: "joined machine2 @3 with pool" }]);
  });

  test("a member that is behind stops at an entry it cannot place, keeps the stop, and answers for nobody until it replays", async () => {
    // A level above 1 that the list needs, then an entry of that level by a key that has no row: a later kind may have let that key in.
    const { links, state } = await play([[owner, device(phone)], [owner, pc(desk, 1)], [owner, later()]]);
    const entry = await next(at(links, 3), stranger, later());
    const member = { entries: links.map((item) => item.text), state };
    const shown = await shownList(member, { after: 3, entries: [entry.text], head: { seq: 4, hash: entry.held.hash } });
    expect([shown.stopped, shown.stuck, shown.took, shown.member.state.needs_replay]).toEqual([{ seq: 4, code: "needs_replay" }, true, [], { seq: 4, hash: entry.held.hash }]);
    expect([admitsDevice(state, owner.key, T0), holdsPc(state, E(1)), listView(state).pcs.map((row) => row.allows)]).toEqual(["drive", true, [true]]);
    const stopped = shown.member.state;
    expect([admitsDevice(stopped, owner.key, T0), holdsPc(stopped, E(1)), listView(stopped), wrapKeys(stopped, T0), sealEpoch(stopped, T0)])
      .toEqual([null, false, { stopped: true, devices: [], pcs: [], invites: [], signers: [] }, [], null]);
    expect(said((await takeEntry(state, entry.held)).outcome)).toBe("stops needs_replay");
    // The stop is saved and read again with the state.
    expect(readListState(JSON.parse(JSON.stringify(shown.member.state)), 1)).toEqual(shown.member.state);
    const replayed = await replayList(shown.member.entries, 1, { saved: shown.member.state });
    expect([replayed.stuck, replayed.stopped, replayed.member?.state]).toEqual([true, { seq: 4, code: "needs_replay" }, shown.member.state]);
  });
});

describe("a saved state: plain data that can be stored and loaded", () => {
  /** Played once: a card is a signature, so the same steps played again give other bodies and other hashes. */
  let played: Promise<ListState> | null = null;
  const saved = (): Promise<ListState> => (played ??= play([
    [owner, carried(late)], [owner, carriedPc(3)],
    [owner, device(phone)], [owner, device(tablet, "bound", "watch", { until: String(T0 + 86400) })], [owner, pc(desk, 1)], [owner, invite(pool, 2)], [pool, join(2)],
    [owner, invite(plain, 1, false)], [owner, remove(tablet)], [owner, opening(0)],
  ]).then((result) => result.state));
  type Loose = Record<string, Record<string, Record<string, unknown>>> & Record<string, unknown>;
  const changed = async (change: (state: Loose) => void): Promise<ListState | null> => {
    const value = JSON.parse(JSON.stringify(await saved())) as Loose;
    change(value);
    return readListState(value, 1);
  };
  const row = (state: Loose, part: string, key: string): Record<string, unknown> => {
    const found = state[part]?.[key];
    if (found === undefined) throw new Error(`no ${part} row`);
    return found;
  };
  const put = (state: Loose, part: string, value: unknown): void => { (state as Record<string, unknown>)[part] = value; };
  const epochRow = (state: Loose, epoch: number): Record<string, unknown> => {
    const found = (state.epochs as unknown as Record<string, unknown>[])[epoch];
    if (found === undefined) throw new Error(`no epoch ${epoch}`);
    return found;
  };

  test("is JSON values only, and reads again as it was saved", async () => {
    const state = await saved();
    const text = JSON.stringify(state);
    expect(readListState(JSON.parse(text), 1)).toEqual(state);
    expect(JSON.stringify(readListState(JSON.parse(text), 1))).toBe(text);
    expect(Object.keys(state).sort()).toEqual(["account", "behind", "carrying", "devices", "epoch", "epochs", "footing", "full_at", "invites", "level", "list", "needs", "pc_keys", "pcs", "signers"]);
    expect([state.account, state.carrying, state.full_at]).toEqual(["TEST-ONLY-account", false, T0 + 600]);
  });

  test("anything that is no state of the signers, or lacks a part, is null", async () => {
    for (const value of [null, 1, "x", [], {}]) expect(readListState(value, 1)).toBeNull();
    for (const part of ["signers", "devices", "pcs", "pc_keys", "invites", "footing", "list", "epoch", "epochs", "account", "full_at", "carrying"]) expect(await changed((state) => { delete state[part]; })).toBeNull();
    for (const part of ["devices", "pcs", "pc_keys", "invites"]) expect(await changed((state) => { put(state, part, []); })).toBeNull();
    expect(await changed((state) => { put(state, "epochs", {}); })).toBeNull();
  });

  test("a state that does not agree with itself is null", async () => {
    const m2 = await machine(2);
    const changes: [string, (state: Loose) => void][] = [
      ["a signer's row with no as", (state) => { delete row(state, "signers", phone.key).as; }],
      ["an as nobody is", (state) => { row(state, "signers", phone.key).as = "machine"; }],
      ["a first signer that is no device", (state) => { row(state, "signers", owner.key).as = null; }],
      ["a PC that is no full signer", (state) => { row(state, "signers", tablet.key).as = "pc"; }],
      ["an invite that is no bound signer", (state) => { row(state, "signers", phone.key).as = "invite"; }],
      ["a device with no row among the devices", (state) => { delete state.devices?.[phone.key]; }],
      ["a device's row for a key that is no device", (state) => { (state.devices ?? {})[pool.key] = { role: "drive", until: null, enc: phone.enc, carried: false }; }],
      ["a role nobody has", (state) => { row(state, "devices", phone.key).role = "admin"; }],
      ["an until that is no number", (state) => { row(state, "devices", tablet.key).until = "soon"; }],
      ["no encryption key on a device that was not carried", (state) => { row(state, "devices", phone.key).enc = null; }],
      ["an encryption key that is no key", (state) => { row(state, "devices", phone.key).enc = "x"; }],
      ["a relay key out of form", (state) => { (state.pcs ?? {}).e = row(state, "pcs", E(1)); }],
      ["a how nobody is", (state) => { row(state, "pcs", E(1)).how = "found"; }],
      ["a PC a person added whose key is no PC", (state) => { row(state, "signers", desk.key).as = null; }],
      ["a PC a person added that is out while its key is not", (state) => { row(state, "pcs", E(1)).removed = 7; }],
      ["a PC a person added at another place than its key's", (state) => { row(state, "pcs", E(1)).seq = 4; }],
      ["a PC that joined with no invite", (state) => { row(state, "pcs", E(2)).invite = null; }],
      ["a PC that joined with a key that is no invite", (state) => { row(state, "pcs", E(2)).invite = phone.key; }],
      ["a PC that joined before its invite was placed", (state) => { row(state, "pcs", E(2)).seq = 4; }],
      ["a PC that joined with no key", (state) => { row(state, "pcs", E(2)).key = null; }],
      ["a carried PC with a key", (state) => { row(state, "pcs", E(3)).key = m2.key; }],
      ["a PC removed before it came in", (state) => { row(state, "pcs", E(3)).removed = 2; }],
      ["a PC past the footing", (state) => { row(state, "pcs", E(3)).seq = 99; }],
      ["two PCs with one key", (state) => { (state.pcs ?? {})[E(9)] = { ...row(state, "pcs", E(2)) }; }],
      ["a PC's key missing from pc_keys", (state) => { delete state.pc_keys?.[m2.key]; }],
      ["a pc_keys member for no PC", (state) => { (state.pc_keys as unknown as Record<string, string>)[phone.key] = E(1); }],
      ["a pc_keys member at another relay key", (state) => { (state.pc_keys as unknown as Record<string, string>)[m2.key] = E(1); }],
      ["an invite with no row among the invites", (state) => { delete state.invites?.[pool.key]; }],
      ["an invite's row for a key that is no invite", (state) => { (state.invites ?? {})[phone.key] = { exp: EXP, uses: 1, joins: 0, auto: true }; }],
      ["joins that are not the PCs that joined", (state) => { row(state, "invites", pool.key).joins = 2; }],
      ["uses below its joins", (state) => { row(state, "invites", pool.key).uses = 0; }],
      ["uses past 256", (state) => { row(state, "invites", pool.key).uses = 257; }],
      ["an auto that is no boolean", (state) => { row(state, "invites", pool.key).auto = "1"; }],
      ["a join on an invite that needs a person", (state) => { row(state, "invites", pool.key).auto = false; }],
      ["no account", (state) => { delete (state as Record<string, unknown>).account; }],
      ["an account that is no account's id", (state) => { put(state, "account", "a b"); }],
      ["a time that is no number", (state) => { put(state, "full_at", "now"); }],
      ["no word on whether anybody may still be carried in", (state) => { delete (state as Record<string, unknown>).carrying; }],
      ["carrying still, in a list that holds more than what was carried in", (state) => { put(state, "carrying", true); }],
      ["a device of power full that watches", (state) => { row(state, "devices", phone.key).role = "watch"; }],
      ["a device of power full with an until", (state) => { row(state, "devices", phone.key).until = T0 + 9; }],
      ["a device's row moved onto an invite's key", (state) => { (state.devices ?? {})[pool.key] = row(state, "devices", phone.key); delete state.devices?.[phone.key]; }],
      ["an epoch that is not the last one opened", (state) => { put(state, "epoch", 0); }],
      ["no epoch at all", (state) => { put(state, "epochs", []); }],
      ["an epoch 0 that entry 0 did not open", (state) => { epochRow(state, 0).seq = 1; }],
      ["an epoch 0 with a link", (state) => { epochRow(state, 0).link = toBase64Url(LINK(1)); }],
      ["a later epoch with no link", (state) => { epochRow(state, 1).link = null; }],
      ["a link of another length", (state) => { epochRow(state, 1).link = toBase64Url(new Uint8Array(60)); }],
      ["an opening that is no hash", (state) => { epochRow(state, 1).opens = "x"; }],
      ["an epoch opened past the footing", (state) => { epochRow(state, 1).seq = 99; }],
      ["an epoch opened before the one before it", (state) => { epochRow(state, 1).seq = 0; }],
    ];
    for (const [name, change] of changes) expect({ name, state: await changed(change) }).toEqual({ name, state: null });
    expect(await changed(() => undefined)).toEqual(await saved());
  });

  test("an invite's uses cover the PCs that joined with it, and no two PCs stand at one place", async () => {
    const m1 = await machine(1);
    const { state } = await play([[owner, invite(pool, 2)], [pool, join(1)], [pool, join(2)]]);
    const fresh = () => JSON.parse(JSON.stringify(state)) as Loose;
    expect(readListState(fresh(), 1)).toEqual(state);
    // Uses that are a number an invite may have, and fewer than the PCs that joined.
    const fewer = fresh();
    row(fewer, "invites", pool.key).uses = 1;
    expect(readListState(fewer, 1)).toBeNull();
    // Two joined PCs at one place: one entry would have taken two of the invite's uses.
    const shared = fresh();
    row(shared, "pcs", E(2)).seq = row(shared, "pcs", E(1)).seq;
    expect(readListState(shared, 1)).toBeNull();
    // A carried PC and a joined one at one place are no state either.
    const mixed = (await play([[owner, carriedPc(3)], [owner, invite(pool, 2)], [pool, join(1)]])).state;
    const both = JSON.parse(JSON.stringify(mixed)) as Loose;
    expect(readListState(JSON.parse(JSON.stringify(mixed)), 1)).toEqual(mixed);
    row(both, "pcs", E(1)).seq = 1;
    expect(readListState(both, 1)).toBeNull();
    // A PC's key whose point is not on the curve: in its spelling, and no key any entry could have let in.
    const bytes = fromBase64Url(m1.key);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const off = toBase64Url(bytes);
    const curve = fresh();
    row(curve, "pcs", E(1)).key = off;
    (curve.pc_keys as unknown as Record<string, string>)[off] = E(1);
    delete (curve.pc_keys as unknown as Record<string, string>)[m1.key];
    expect(readListState(curve, 1)).toBeNull();
  });

  test("the first device is entry 0's signer: it drives, has no until, was carried in by nobody and has its encryption key", async () => {
    const { state } = await play([[owner, device(tablet, "bound", "watch", { until: String(T0 + 86400) })]]);
    const changes: [string, (device: Record<string, unknown>) => void][] = [
      ["it watches", (device) => { device.role = "watch"; }],
      ["it has an until", (device) => { device.until = T0 + 9; }],
      ["it was carried in", (device) => { device.carried = true; }],
      ["it was carried in and has no encryption key", (device) => { device.carried = true; device.enc = null; }],
    ];
    for (const [name, change] of changes) {
      const value = JSON.parse(JSON.stringify(state)) as Loose;
      change(row(value, "devices", owner.key));
      expect({ name, state: readListState(value, 1) }).toEqual({ name, state: null });
    }
    // Both roles and an until stay those of a later, bound device.
    expect(readListState(JSON.parse(JSON.stringify(state)), 1)?.devices[tablet.key]).toEqual({ role: "watch", until: T0 + 86400, enc: tablet.enc, carried: false });
  });

  test("a PC joined while whoever placed its invite was a signer: a row that says it joined after that is no state", async () => {
    const { state } = await play([[owner, device(phone)], [phone, invite(pool)], [pool, join(1)], [owner, remove(phone)]]);
    const value = JSON.parse(JSON.stringify(state)) as Loose;
    expect(readListState(value, 1)).toEqual(state);
    row(value, "pcs", E(1)).seq = 4;
    expect(readListState(value, 1)).toBeNull();
  });

  test("a PC that a person added is a signer of power full: a bound signer with no name that a saved state calls a PC is no state", async () => {
    // A bound signer with no name: an entry added it and had no effect of its kind.
    const { state } = await play([[owner, plus(await device(phone, "bound"), { role: "admin" })]]);
    expect(seen(state).signers.phone).toBe("bound no name @1 by owner");
    const value = JSON.parse(JSON.stringify(state)) as Loose;
    row(value, "signers", phone.key).as = "pc";
    (value.pcs ?? {})[E(9)] = { how: "added", key: phone.key, enc: phone.enc, seq: 1, invite: null, removed: null };
    (value.pc_keys as unknown as Record<string, string>)[phone.key] = E(9);
    expect(readListState(value, 1)).toBeNull();
    // The same rows for a key of power full are a state: only the power was wrong.
    const full = (await play([[owner, plus(await device(phone), { role: "admin" })]])).state;
    const fine = JSON.parse(JSON.stringify(full)) as Loose;
    row(fine, "signers", phone.key).as = "pc";
    (fine.pcs ?? {})[E(9)] = { how: "added", key: phone.key, enc: phone.enc, seq: 1, invite: null, removed: null };
    (fine.pc_keys as unknown as Record<string, string>)[phone.key] = E(9);
    expect(readListState(fine, 1)).not.toBeNull();
  });

  test("while somebody may still be carried in, a saved state holds nothing but what the first signer carried in", async () => {
    const { state } = await play([[owner, carried(phone)], [owner, carriedPc(1)]]);
    expect([state.carrying, readListState(JSON.parse(JSON.stringify(state)), 1)]).toEqual([true, state]);
    const closed = (await play([[owner, carried(phone)], [owner, device(late)]])).state;
    const value = JSON.parse(JSON.stringify(closed)) as Loose;
    expect([closed.carrying, readListState(value, 1)]).toEqual([false, closed]);
    (value as Record<string, unknown>).carrying = true;
    expect(readListState(value, 1)).toBeNull();
  });

  test("carrying cannot already be closed at footing zero: no entry has closed it", async () => {
    const { state } = await play([]);
    expect(readListState(JSON.parse(JSON.stringify(state)), 1)).toEqual(state);
    expect(readListState({ ...(JSON.parse(JSON.stringify(state)) as Record<string, unknown>), carrying: false }, 1)).toBeNull();
    // Such a state would refuse the first carried, which a replay of the same two entries counts.
    const closed = { ...state, carrying: false };
    const one = await next(await first(), owner, carried(phone));
    expect([said((await takeEntry(closed, one.held)).outcome), said((await takeEntry(state, one.held)).outcome)]).toEqual(["no_effect carried_late", "counts"]);
    // A loose entry is no footing and closes nothing; the first entry of a signer that is no carried closes it, and that state reads.
    const loose = await play([[stranger, device(late)]]);
    expect([loose.state.footing.seq, loose.state.carrying, readListState(JSON.parse(JSON.stringify(loose.state)), 1)]).toEqual([0, true, loose.state]);
    const used = await play([[owner, device(phone)]]);
    expect([used.state.footing.seq, used.state.carrying, readListState(JSON.parse(JSON.stringify(used.state)), 1)]).toEqual([1, false, used.state]);
  });

  test("behind: while it is behind it lets nobody new in, so no named row stands at or past that place", async () => {
    const { state } = await play([[owner, device(phone)], [owner, later()], [owner, device(late)]]);
    expect([state.behind, seen(state).signers.late]).toEqual([2, "full no name @3 by owner"]);
    const value = JSON.parse(JSON.stringify(state)) as Loose;
    expect(readListState(value, 1)).toEqual(state);
    row(value, "signers", late.key).as = "device";
    (value.devices ?? {})[late.key] = { role: "drive", until: null, enc: late.enc, carried: false };
    expect(readListState(value, 1)).toBeNull();
  });

  test("a state that a higher level wrote is read back stopped at its footing", async () => {
    const { texts } = await play([[owner, device(phone)]]);
    const higher = (await replayList(texts, 2, { saved: null })).member?.state;
    if (!higher) throw new Error("no member");
    const read = readListState(JSON.parse(JSON.stringify(higher)), 1);
    expect([read?.needs_replay, read === null ? null : admitsDevice(read, phone.key, T0)]).toEqual([higher.footing, null]);
  });
});

describe("writing an entry of one of the kinds (kindBody)", () => {
  const place: EntryPlace = { issued_at: T0 + 60, list: LIST, prev: LIST, seq: 1, signer: owner.key };

  test("each kind is written at v 1 with exactly its fields, and reads again as it was given", async () => {
    const m1 = await machine(1);
    const kinds: ListKind[] = [
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: await card(phone), sealed: SEAL, rotates: false },
      { kind: "device", key: tablet.key, power: "bound", role: "watch", until: T0 + 86400, enc: tablet.enc, card: await card(tablet), sealed: { epoch: 3, bytes: SEALED }, rotates: false },
      { kind: "device", key: late.key, power: "full", role: "drive", until: null, enc: late.enc, card: await card(late), sealed: null, rotates: true },
      { kind: "pc", key: desk.key, endpoint: E(1), enc: desk.enc, card: await card(desk, E(1)), sealed: SEAL },
      { kind: "pc", key: desk.key, endpoint: E(1), enc: desk.enc, card: await card(desk, E(1)), sealed: null },
      { kind: "invite", key: pool.key, exp: EXP, uses: 5, auto: true, sealed: SEAL },
      { kind: "invite", key: plain.key, exp: EXP, uses: 1, auto: false, sealed: null },
      { kind: "join", endpoint: E(1), pc: m1.key, enc: m1.enc, card: await card(m1, E(1)), sealed: SEAL },
      { kind: "join", endpoint: E(1), pc: m1.key, enc: m1.enc, card: await card(m1, E(1)), sealed: null },
      { kind: "remove", ends: phone.key },
      { kind: "remove", endpoint: E(1) },
      { kind: "carried", key: phone.key, role: "drive", sealed: SEAL },
      { kind: "carried", endpoint: E(1), sealed: null },
      { kind: "card", enc: owner.enc },
      { kind: "epoch", epoch: 0, opens: OPENS(1), link: LINK(1) },
    ];
    for (const kind of kinds) {
      const body = kindBody(place, kind);
      expect([body.kind, body.v, body.seq, body.signer]).toEqual([kind.kind, 1, 1, owner.key]);
      expect(readKind(body)).toEqual(kind);
      // It is what a signer signs: the entry reads back to the same kind from its bytes.
      const entry = await signEntry(body, owner.pair.privateKey);
      expect(readKind(readBody(entry.body))).toEqual(kind);
    }
    const first0 = kindBody({ issued_at: T0, list: "", prev: "", seq: 0, signer: owner.key }, { kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL });
    expect(entryHash((await signEntry(first0, owner.pair.privateKey)).body)).toBe(LIST);
    // A rotation ends the place's own signer, and nobody else.
    expect(kindBody(place, at(kinds, 2)).ends).toBe(owner.key);
  });

  test("the fields of an entry as it is signed, in their order", async () => {
    const entry = await signEntry(kindBody(place, { kind: "pc", key: desk.key, endpoint: E(1), enc: desk.enc, card: await card(desk, E(1)), sealed: SEAL }), owner.pair.privateKey);
    expect(readFields(entry.body).map((item) => item.name)).toEqual(["adds", "card", "enc", "endpoint", "epoch", "issued_at", "kind", "list", "power", "prev", "sealed", "seq", "signer", "v"]);
  });

  test("what no member would read as that kind is refused as entry_invalid", async () => {
    const good = await card(phone);
    const refused: ListKind[] = [
      { kind: "genesis", account: "", enc: owner.enc, opens: OPENS(0), sealed: SEAL },
      { kind: "genesis", account: "TEST-ONLY-account", enc: "x", opens: OPENS(0), sealed: SEAL },
      { kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: "x", sealed: SEAL },
      { kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: { epoch: 1, bytes: SEALED } },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: good.slice(1), sealed: SEAL, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "admin" as ListRole, until: null, enc: phone.enc, card: good, sealed: SEAL, rotates: false },
      { kind: "device", key: phone.key, power: "bound", role: "drive", until: -1, enc: phone.enc, card: good, sealed: SEAL, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: T0 + 9, enc: phone.enc, card: good, sealed: SEAL, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "watch", until: null, enc: phone.enc, card: good, sealed: SEAL, rotates: false },
      { kind: "carried", key: phone.key, role: "watch" as "drive", sealed: SEAL },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: good, sealed: { epoch: 0, bytes: new Uint8Array(46) }, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: good, sealed: { epoch: -1, bytes: SEALED }, rotates: false },
      { kind: "pc", key: desk.key, endpoint: "x", enc: desk.enc, card: good, sealed: SEAL },
      { kind: "invite", key: pool.key, exp: EXP, uses: 0, auto: true, sealed: SEAL },
      { kind: "invite", key: pool.key, exp: T0 + 60 + INVITE_SECONDS_MAX + 1, uses: 1, auto: true, sealed: SEAL },
      { kind: "join", endpoint: E(1), pc: "x", enc: desk.enc, card: good, sealed: SEAL },
      { kind: "remove", endpoint: E(171).toUpperCase() },
      { kind: "carried", endpoint: "x", sealed: SEAL },
      { kind: "card", enc: "x" },
      { kind: "epoch", epoch: 0, opens: "x", link: LINK(1) },
      { kind: "epoch", epoch: 0, opens: OPENS(1), link: new Uint8Array(60) },
    ];
    for (const kind of refused) expect(() => kindBody(place, kind)).toThrow(ListKindError);
  });
});

describe("the invite's proof for reading", () => {
  const proofOf = (more: Partial<ReadProof> = {}): ReadProof => ({ key: pool.key, list: LIST, after: null, at: T0 + 600, ...more });
  const refusal = async (text: string) => {
    try {
      await checkReadProof(text);
    } catch (error) {
      if (error instanceof ReadProofError) return error.code;
      throw error;
    }
    return null;
  };
  const signed = async (fields: Record<string, string>, by: Key = pool, prefix = LIST_READ_PREFIX) => {
    const body = writeFieldsUnder(prefix, Object.entries(fields).map(([name, value]) => ({ name, value: utf8ToBytes(value) })));
    return entryToText({ body, signature: new Uint8Array(await crypto.subtle.sign(SIGN, by.pair.privateKey, body as Uint8Array<ArrayBuffer>)) });
  };
  const fields = { after: "", at: String(T0 + 600), key: pool.key, list: LIST };

  test("the holder of the line makes it with the invite's key: one text as an entry is, a body ovis-list-read/1 with the fields after, at, key and list", async () => {
    const line = await lineOf(pool);
    for (const proof of [proofOf(), proofOf({ after: 7 }), proofOf({ after: 0 })]) {
      const text = await signReadProof(line, { after: proof.after, at: proof.at });
      expect(await checkReadProof(text)).toEqual(proof);
      expect(Buffer.from(entryFromText(text).body.subarray(0, 16)).toString()).toBe("ovis-list-read/1");
    }
    expect(await refusal(await signed(fields))).toBeNull();
  });

  test("a proof whose form fails is proof_malformed, and one whose signature fails is signature_invalid, its form asked first", async () => {
    const { after: _after, ...noAfter } = fields;
    for (const text of [await signed(noAfter), await signed({ ...fields, note: "x" }), await signed({ ...fields, at: "" }), await signed({ ...fields, at: "01" }), await signed({ ...fields, after: "x" }),
      await signed({ ...fields, key: "x" }), await signed({ ...fields, list: "" }), await signed(fields, pool, "ovis-list/1"), "x", `${await signed(fields)}=`]) {
      expect(await refusal(text)).toBe("proof_malformed");
    }
    expect(await refusal(await signed(fields, other))).toBe("signature_invalid");
    expect(await refusal(await signed({ ...fields, at: "" }, other))).toBe("proof_malformed");
    // The key and the list are the line's: a caller names only the place and the time, and a line with no list reads no log.
    await expect(signReadProof(await lineOf(pool), { after: -1, at: T0 })).rejects.toThrow(ReadProofError);
    await expect(signReadProof(await lineOf(pool, null), { after: null, at: T0 })).rejects.toThrow(ReadProofError);
  });

  test("what the list holds of its invite, after its form and its signature: the first of invite_unknown, invite_revoked, invite_void, invite_spent", async () => {
    const open = (await play([[owner, device(phone)], [phone, invite(pool, 1)]])).state;
    expect(readProofRefusal(open, proofOf())).toBeNull();
    expect(readProofRefusal(open, proofOf({ list: "0".repeat(64) }))).toBe("invite_unknown");
    expect(readProofRefusal(open, proofOf({ key: phone.key }))).toBe("invite_unknown");
    const spent = (await play([[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)]])).state;
    expect(readProofRefusal(spent, proofOf())).toBe("invite_spent");
    const voided = (await play([[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)], [owner, remove(phone)]])).state;
    expect(readProofRefusal(voided, proofOf())).toBe("invite_void");
    const revoked = (await play([[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)], [owner, remove(phone)], [pool, remove(pool)]])).state;
    expect(readProofRefusal(revoked, proofOf())).toBe("invite_revoked");
  });
});

/** The line of an invite whose key a test holds, as a PC reads it: for the list of the test lists, or for an account with none. */
const SERVICE = "https://accounts.ovis.test";
const lineOf = async (invite: Key, list: string | null = LIST): Promise<JoinLine> =>
  await readJoinLine(await writeJoinLine(SERVICE, "TEST-ONLY-account", list, invite.pair.privateKey), { service: SERVICE, followsLists: true });

describe("a PC joins with the line it was given", () => {
  const joining = async (n: number) => {
    const key = await machine(n);
    return { key: key.key, privateKey: key.pair.privateKey, enc: key.enc, endpoint: E(n) };
  };

  test("the PC hands over its own keys: the join is built here on the state the PC read, signed by the line, and it counts", async () => {
    const { links, state } = await play([[owner, invite(pool, 2)]]);
    const line = await lineOf(pool);
    const pc1 = await joining(1);
    const written = await joinEntry(line, pc1, state, T0 + 120, SEAL);
    const { entry } = written;
    const shown = await shownList({ entries: links.map((item) => item.text), state }, { after: 1, entries: [written.text], head: { seq: 2, hash: entryHash(entry.body) } });
    expect([shown.took.map((item) => said(item.outcome)), seen(shown.member.state).pcs, shown.stopped]).toEqual([["counts"], { e1: "joined machine1 @2 with pool" }, null]);
    // The state it gives is the one every member comes to.
    expect(written.state).toEqual(shown.member.state);
    const body = readBody(entry.body);
    expect([body.kind, body.signer, body.list, body.prev, body.seq, body.adds, body.ends]).toEqual(["join", pool.key, LIST, state.footing.hash, 2, undefined, undefined]);
    expect(readKind(body)).toMatchObject({ kind: "join", endpoint: E(1), pc: pc1.key, enc: pc1.enc, sealed: SEAL });
    // With no key to seal its names with, it joins with none.
    const bare2 = await joinEntry(line, await joining(2), written.state, T0 + 180, null);
    expect(readKind(readBody(bare2.entry.body))).toMatchObject({ kind: "join", sealed: null });
  });

  test("the card in it is the PC's own, for this list, this relay key and this invite: no card comes from outside", async () => {
    const { state } = await play([[owner, invite(pool, 2)]]);
    const line = await lineOf(pool);
    const pc1 = await joining(1);
    const kind = readKind(readBody((await joinEntry(line, pc1, state, T0 + 120, null)).entry.body));
    if (kind === null || kind.kind !== "join") throw new Error("no join");
    expect(await cardHolds({ key: pc1.key, enc: pc1.enc, list: LIST, endpoint: E(1), invite: pool.key }, kind.card)).toBe(true);
    // A private key that is not the PC's own gives a card that does not hold: the join would not count, so it is not signed.
    const refused = await joinEntry(line, { ...pc1, privateKey: other.pair.privateKey }, state, T0 + 120, null).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(ListWriteError);
    expect((refused as ListWriteError).outcome).toEqual({ outcome: "no_effect", code: "card_invalid" });
  });

  test("a join that would not count on the list as the PC read it is not signed: the invite is not open, or the relay key is taken", async () => {
    const line = await lineOf(pool);
    const outcome = async (steps: readonly Step[], n = 1, issued = T0 + 600) =>
      await joinEntry(line, await joining(n), (await play(steps)).state, issued, null).then(() => "signed", (error: unknown) => (error instanceof ListWriteError && error.outcome !== null ? said(error.outcome) : String(error)));
    expect(await outcome([[owner, invite(pool, 1)]])).toBe("signed");
    expect(await outcome([])).toBe("passed_over invite_unknown");
    expect(await outcome([[owner, invite(pool, 1)], [pool, join(2)]])).toBe("no_effect invite_spent");
    expect(await outcome([[owner, invite(pool, 1)], [owner, remove(pool)]])).toBe("passed_over invite_revoked");
    expect(await outcome([[owner, invite(pool, 2, false)]])).toBe("no_effect invite_not_auto");
    expect(await outcome([[owner, invite(pool, 2)], [pool, join(1)]])).toBe("no_effect endpoint_reused");
    expect(await outcome([[owner, invite(pool, 2, true, T0 + 100)], [owner, device(phone)]])).toBe("no_effect invite_expired");
  });

  test("a line that names no list or another list joins by no entry, and values out of their form are refused", async () => {
    const { state } = await play([[owner, invite(pool, 2)]]);
    const pc1 = await joining(1);
    await expect(joinEntry(await lineOf(pool, null), pc1, state, T0, null)).rejects.toThrow(ListKindError);
    await expect(joinEntry(await lineOf(pool, "0".repeat(64)), pc1, state, T0, null)).rejects.toThrow(ListKindError);
    await expect(joinEntry(await lineOf(pool), { ...pc1, endpoint: "x" }, state, T0, null)).rejects.toThrow(ListKindError);
    await expect(joinEntry(await lineOf(pool), { ...pc1, enc: "x" }, state, T0, null)).rejects.toThrow(ListKindError);
  });

  test("the line signs no body but the join of its own key on its own list, which adds no key and ends none", async () => {
    const line = await lineOf(pool);
    const good = bodyOf(await join(1), pool, { seq: 1, list: LIST, prev: LIST });
    expect(await verifyBody(await line.signJoin(good), pool.key)).toBe(true);
    const refused: EntryBody[] = [
      { ...good, adds: { key: stranger.key, power: "full" } },
      { ...good, adds: { key: stranger.key, power: "bound" } },
      { ...good, ends: owner.key },
      { ...good, signer: owner.key },
      { ...good, list: "0".repeat(64) },
      { ...good, list: "", prev: "", seq: 0 },
      bodyOf(await device(stranger), pool, { seq: 1, list: LIST, prev: LIST }),
      bodyOf(invite(stranger), pool, { seq: 1, list: LIST, prev: LIST }),
      bodyOf(remove(owner), pool, { seq: 1, list: LIST, prev: LIST }),
      bodyOf(opening(0), pool, { seq: 1, list: LIST, prev: LIST }),
      bodyOf({ kind: "later_kind" }, pool, { seq: 1, list: LIST, prev: LIST }),
      { ...good, kind: "JOIN" },
    ];
    for (const body of refused) await expect(line.signJoin(body)).rejects.toThrow(JoinLineSignError);
    // What is judged is what is signed: an object that says `join` once and something else the next time gets no signature for the second.
    let reads = 0;
    const shifty = { ...good, get kind() { reads++; return reads === 1 ? "join" : "device"; } };
    const entry = await line.signJoin(shifty).catch((error: unknown) => error);
    if (!(entry instanceof Error)) expect(readBody((entry as { body: Uint8Array }).body).kind).toBe("join");
    await expect((await lineOf(pool, null)).signJoin({ ...good, list: "" })).rejects.toThrow(JoinLineSignError);
  });

  test("the line signs no proof for reading but that of its own key and its own list", async () => {
    const line = await lineOf(pool);
    const proof = (values: Record<string, string>, prefix = LIST_READ_PREFIX) => writeFieldsUnder(prefix, Object.entries(values).map(([name, value]) => ({ name, value: utf8ToBytes(value) })));
    const own = { after: "", at: String(T0), key: pool.key, list: LIST };
    expect((await line.signRead(proof(own))).length).toBe(64);
    for (const bytes of [proof({ ...own, key: owner.key }), proof({ ...own, list: "0".repeat(64) }), proof(own, "ovis-list/1"), proof(own, "ovis-invite-redeem/1"), utf8ToBytes("ovis-list-read/1x"), new Uint8Array()]) {
      await expect(line.signRead(bytes)).rejects.toThrow(JoinLineSignError);
    }
    await expect((await lineOf(pool, null)).signRead(proof({ ...own, list: "" }))).rejects.toThrow(JoinLineSignError);
  });

  test("the line signs only a proof for reading that its own checker reads: the four fields, each in its form", async () => {
    const line = await lineOf(pool);
    const proof = (values: Record<string, string>) => writeFieldsUnder(LIST_READ_PREFIX, Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => ({ name, value: utf8ToBytes(value) })));
    const own = { after: "", at: String(T0), key: pool.key, list: LIST };
    const { after: _after, ...noAfter } = own;
    const { at: _at, ...noAt } = own;
    const refused: Record<string, string>[] = [
      // The review's sequence: the line's own key and list, and nothing else.
      { key: pool.key, list: LIST },
      noAfter, noAt, { ...own, note: "x" },
      { ...own, at: "" }, { ...own, at: "01" }, { ...own, at: "x" }, { ...own, at: "-1" }, { ...own, at: "1".repeat(16) },
      { ...own, after: "x" }, { ...own, after: "01" }, { ...own, after: "-1" },
      // A value is its bytes: a byte order mark before it is no part of a number, a key or a list id, for the line as for the checker.
      { ...own, at: `\uFEFF${T0}` }, { ...own, after: "\uFEFF" }, { ...own, after: "\uFEFF7" }, { ...own, key: `\uFEFF${pool.key}` }, { ...own, list: `\uFEFF${LIST}` },
    ];
    for (const values of refused) {
      const bytes = proof(values);
      const signed = await line.signRead(bytes).then((signature) => entryToText({ body: bytes, signature }), (error: unknown) => error);
      expect({ values, refused: signed instanceof JoinLineSignError }).toEqual({ values, refused: true });
      expect({ values, code: (signed as JoinLineSignError).code }).toEqual({ values, code: "not_signed" });
      // And the checker reads none of them, whoever signs.
      const forged = entryToText({ body: bytes, signature: new Uint8Array(await crypto.subtle.sign(SIGN, pool.pair.privateKey, bytes as Uint8Array<ArrayBuffer>)) });
      expect({ values, code: await checkReadProof(forged).then(() => null, (error: unknown) => (error instanceof ReadProofError ? error.code : String(error))) }).toEqual({ values, code: "proof_malformed" });
    }
    // Bytes that are no text at all are no value either.
    const raw = writeFieldsUnder(LIST_READ_PREFIX, [{ name: "after", value: Uint8Array.of(0xff) }, { name: "at", value: utf8ToBytes(String(T0)) }, { name: "key", value: utf8ToBytes(pool.key) }, { name: "list", value: utf8ToBytes(LIST) }]);
    await expect(line.signRead(raw)).rejects.toThrow(JoinLineSignError);
    // Whatever the line signs, its checker reads.
    for (const values of [own, { ...own, after: "0" }, { ...own, after: "7" }, { ...own, at: "0" }, { ...own, at: "9".repeat(15) }]) {
      const bytes = proof(values);
      const text = entryToText({ body: bytes, signature: await line.signRead(bytes) });
      expect((await checkReadProof(text)).key).toBe(pool.key);
    }
  });
});

/** A small generator with a seed, so a failing history can be played again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("over generated histories", () => {
  /** The keys a history draws from: members to be, and keys that no entry of a member ever adds (a lying service's own). */
  const actors = [owner, phone, tablet, desk, tower, pool, pool2, plain, late];
  const outsiders = [stranger, other];
  /** Who is in, as a caller would ask: the keys that may sign, the devices a PC lets in, the PCs, the open invites. */
  const membership = (state: ListState) => ({
    signers: Object.entries(state.signers).filter(([key]) => signerPower(state, key) !== null).map(([key, row]) => `${who(key)} ${row.power} ${row.as}`).sort(),
    devices: Object.keys(state.devices).filter((key) => admitsDevice(state, key, T0) !== null).map((key) => `${who(key)} ${admitsDevice(state, key, T0)}`).sort(),
    pcs: Object.keys(state.pcs).filter((endpoint) => holdsPc(state, endpoint)).map((endpoint) => `${pcName(endpoint)} ${state.pcs[endpoint]?.how} ${who(state.pcs[endpoint]?.key ?? null)}`).sort(),
    invites: Object.keys(state.invites).filter((key) => inviteRefusal(state, key) === null).map(who).sort(),
  });
  /** One entry of any kind, lawful or not, by anybody, about anybody. */
  async function anyEntry(random: () => number, state: ListState): Promise<Step> {
    const pick = <Item>(items: readonly Item[]): Item => at(items, Math.floor(random() * items.length));
    const everyone = [...actors, ...outsiders];
    // Now and then a key that the list holds signs: histories with only strangers in them show little.
    const insiders = everyone.filter((key) => signerPower(state, key.key) !== null);
    const by = insiders.length > 0 && random() < 0.6 ? pick(insiders) : pick(random() < 0.15 ? outsiders : everyone);
    const about = pick(everyone);
    const n = 1 + Math.floor(random() * 12);
    const power: SignerPower = random() < 0.25 ? "bound" : "full";
    // Names are sealed under the epoch that is current, most of the time.
    sealedUnder = random() < 0.9 ? state.epoch : state.epoch + 1;
    // Right after entry 0 the first signer carries in whoever was in the account before.
    if (state.carrying && random() < 0.6) {
      const made = random() < 0.5 ? carried(about) : carriedPc(n);
      sealedUnder = 0;
      return [owner, made];
    }
    const makers: (() => Promise<Raw> | Raw)[] = [
      () => opening(random() < 0.8 ? state.epoch : state.epoch + 1),
      async () => bare(await device(about, power)),
      // Mostly a bound device watches or has an until; now and then a full one is written so, which is no device.
      () => device(about, power, (power === "bound" || random() < 0.1) && random() < 0.5 ? "watch" : "drive", (power === "bound" || random() < 0.1) && random() < 0.5 ? { until: String(T0 + 86400) } : {}),
      () => pc(about, n),
      // Some invites are over within the history: their exp lies a few entries ahead.
      () => invite(about, 1 + Math.floor(random() * 3), random() < 0.7, random() < 0.3 ? T0 + 60 * (state.footing.seq + 4) : EXP),
      async () => join(n, random() < 0.5 ? await machine(n) : about, random() < 0.8 ? by : about),
      () => remove(about),
      () => removePc(n),
      () => carried(about),
      () => carriedPc(n),
      () => cardOf(about),
      async () => ({ ...(await device(about)), ends: by }),
      async () => plus(await device(about), { card: await card(other) }),
      () => ({ kind: "later_kind", adds: [about, power] }),
      () => ({ kind: "later_kind", ends: about }),
    ];
    // An invite mostly does what an invite is for: it lets the PC at a relay key in. And now and then somebody signs itself out.
    const made = state.signers[by.key]?.as === "invite" && random() < 0.6 ? join(n, undefined, by) : random() < 0.05 ? remove(by) : pick(makers)();
    return [by, await Promise.resolve(made).finally(() => { sealedUnder = 0; })];
  }

  test("nobody comes in but by a full signer's entry, or by the join of an open invite that a full signer placed; a bound key changes nothing but its own end; out is out", async () => {
    const happened = new Map<string, number>();
    for (let seed = 1; seed <= 30; seed++) {
      const random = seeded(seed);
      let head = await first();
      let state = firstListState(head.held, 1);
      const out = { keys: new Set<string>(), endpoints: new Set<string>(), pcKeys: new Set<string>() };
      for (let step = 0; step < 70; step++) {
        const [by, raw] = await anyEntry(random, state);
        const before = state;
        const power = signerPower(before, by.key);
        const was = membership(before);
        head = await next(head, by, await raw);
        const result = await taken(before, head.held);
        state = result.state;
        const now = membership(state);
        const where = `seed ${seed} step ${step} ${by.name} ${(await raw).kind} ${said(result.outcome)}`;
        const word = `${power ?? "nobody"}: ${(await raw).kind} ${said(result.outcome)}`;
        happened.set(word, (happened.get(word) ?? 0) + 1);
        const body = head.held.body;
        const came = (part: keyof typeof now) => now[part].filter((item) => !was[part].includes(item));
        const left = (part: keyof typeof now) => was[part].filter((item) => !now[part].includes(item));
        if (power === null) {
          // No signer for this member: a lying service's entry, or one by a key that is out. Nothing moves.
          expect({ where, now, epoch: state.epoch }).toEqual({ where, now: was, epoch: before.epoch });
          expect(state.footing).toEqual(before.footing);
        } else if (power === "bound") {
          // A browser on a borrowed computer, or an invite: nobody else comes in or goes out, but for the PC an open invite lets in.
          const joined = body.kind === "join" && result.outcome.outcome === "counts";
          expect({ where, came: [came("signers"), came("devices"), came("invites")] }).toEqual({ where, came: [[], [], []] });
          expect({ where, pcs: came("pcs").length }).toEqual({ where, pcs: joined ? 1 : 0 });
          // The one PC that goes with a bound key's own end is the PC whose key it is.
          expect({ where, left: left("pcs").filter((item) => item.split(" ")[2] !== by.name) }).toEqual({ where, left: [] });
          for (const item of [...left("signers"), ...left("devices")]) expect({ where, item: item.split(" ")[0] }).toEqual({ where, item: by.name });
          expect({ where, epoch: state.epoch }).toEqual({ where, epoch: before.epoch });
          // What its own end takes with it: an invite that is void without it. No such invite was placed by a bound key, so none goes.
          expect({ where, left: left("invites").filter((name) => name !== by.name) }).toEqual({ where, left: [] });
          if (joined) {
            const placer = before.signers[by.key]?.by ?? "";
            expect({ where, placed: before.signers[placer]?.power, auto: before.invites[by.key]?.auto, signer: signerPower(state, ownText(body, "pc") ?? "") }).toEqual({ where, placed: "full", auto: true, signer: null });
            // No full signer had signed past the invite's exp.
            expect({ where, inTime: before.full_at <= (before.invites[by.key]?.exp ?? -1) }).toEqual({ where, inTime: true });
          }
        }
        // Somebody is carried in only by the first signer, and only while nothing but that has happened since entry 0.
        if (body.kind === "carried" && result.outcome.outcome === "counts") expect({ where, by: by.name, carrying: before.carrying }).toEqual({ where, by: "owner", carrying: true });
        if (!(body.kind === "carried" && result.outcome.outcome === "counts") && power !== null) expect({ where, carrying: state.carrying }).toEqual({ where, carrying: false });
        // A device of power full neither watches nor has an until; the list's own time never goes back.
        for (const [key, row] of Object.entries(state.devices)) if (state.signers[key]?.power === "full") expect({ where, role: row.role, until: row.until }).toEqual({ where, role: "drive", until: null });
        expect({ where, time: state.full_at >= before.full_at }).toEqual({ where, time: true });
        // Out is out, whoever signs what: a key that was ended never signs or opens again, a PC that was put out is never in again, and its key is never a PC's again.
        for (const key of out.keys) expect({ where, key: who(key), power: signerPower(state, key), admitted: admitsDevice(state, key, T0) }).toEqual({ where, key: who(key), power: null, admitted: null });
        for (const endpoint of out.endpoints) expect({ where, endpoint: pcName(endpoint), held: holdsPc(state, endpoint) }).toEqual({ where, endpoint: pcName(endpoint), held: false });
        for (const key of out.pcKeys) {
          const row = state.signers[key];
          // No PC that is in has that key again. Its signer's row keeps what it was: a PC's, where a person had added it, and then it signs no more; a key that joined has no name.
          expect({ where, key: who(key), pcs: Object.values(state.pcs).filter((item) => item.key === key && item.removed === null).length, named: row !== undefined && row.as !== null && row.as !== "pc" })
            .toEqual({ where, key: who(key), pcs: 0, named: false });
          if (row?.as === "pc") expect({ where, key: who(key), power: signerPower(state, key) }).toEqual({ where, key: who(key), power: null });
        }
        for (const [key, row] of Object.entries(state.signers)) if (row.ended !== null) out.keys.add(key);
        for (const [endpoint, row] of Object.entries(state.pcs)) {
          if (row.removed === null) continue;
          out.endpoints.add(endpoint);
          if (row.key !== null) out.pcKeys.add(row.key);
        }
        // A PC that joined by an invite is a signer only when a full signer's own entry added its key afterwards: never by its join.
        for (const row of Object.values(state.pcs)) {
          if (row.how !== "joined" || row.key === null) continue;
          const signer = state.signers[row.key];
          if (signer !== undefined) expect({ where, as: signer.as, after: signer.seq > row.seq, by: state.signers[signer.by ?? ""]?.power }).toEqual({ where, as: null, after: true, by: "full" });
        }
      }
    }
    // The histories are no walk through refusals alone: each kind counted, by each kind of signer that may place it, and each was refused.
    if (process.env["LIST_HISTORIES"]) console.log([...happened].sort().map(([word, count]) => `${count} ${word}`).join("\n"));
    for (const word of ["full: device counts", "full: pc counts", "full: invite counts", "bound: join counts", "full: remove counts", "bound: remove counts", "full: carried counts", "full: epoch counts",
      "bound: device passed_over signer_not_allowed", "bound: remove passed_over signer_not_allowed", "bound: epoch no_effect signer_not_allowed", "nobody: device passed_over signer_unknown",
      "nobody: join passed_over invite_unknown", "full: device passed_over key_reused", "full: device no_effect card_invalid", "full: device no_effect epoch_other", "full: epoch no_effect epoch_other"]) {
      expect({ word, times: (happened.get(word) ?? 0) > 0 }).toEqual({ word, times: true });
    }
  }, 120_000);

  test("a lying service's entries on top of a member's list never add anybody, and the member's state is as if it had never been shown them", async () => {
    for (let seed = 21; seed <= 26; seed++) {
      const random = seeded(seed);
      const { links, state } = await play([[owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool, 3)], [pool, join(2)], [phone, device(tablet, "bound")]]);
      const member = { entries: links.map((item) => item.text), state };
      // The service holds no member's key: it signs with its own, and with the key of a device it makes up a card for.
      const padding: Link[] = [];
      for (let index = 0; index < 8; index++) {
        const by = at(outsiders, Math.floor(random() * outsiders.length));
        const makers: (() => Promise<Raw> | Raw)[] = [
          () => device(by), () => device(stranger, "full", "drive"), () => pc(other, 6), () => invite(by), () => join(5, by), () => remove(phone), () => removePc(2), () => carried(by), () => carriedPc(4), () => cardOf(by),
        ];
        padding.push(await next(padding.at(-1) ?? at(links, 5), by, await at(makers, Math.floor(random() * makers.length))()));
      }
      const head = at(padding, padding.length - 1);
      const shown = await shownList(member, { after: 5, entries: padding.map((item) => item.text), head: { seq: head.held.body.seq, hash: head.held.hash } });
      expect(shown.took.every((item) => item.outcome.outcome === "passed_over" && item.outcome.loose)).toBe(true);
      expect([shown.member.state, shown.stopped]).toEqual([state, null]);
      // The member still signs on its footing, and what an honest member then places takes the padding's place.
      expect(signingPlace(shown.member, { seq: 5, hash: at(links, 5).held.hash })).toEqual({ list: LIST, prev: at(links, 5).held.hash, seq: 6 });
      const honest = await next(at(links, 5), owner, await device(late));
      const back = await shownList(shown.member, { after: 5, entries: [honest.text], head: { seq: 6, hash: honest.held.hash } });
      const clean = await replayList([...member.entries, honest.text], 1, { saved: null });
      expect([back.dropped_from, back.member.state, back.member.entries]).toEqual([6, clean.member?.state ?? null, clean.member?.entries ?? []]);
    }
  }, 120_000);

  test("whatever an entry carries, it reads as no kind or as one that is written back to the same fields", async () => {
    const random = seeded(99);
    const pick = <Item>(items: readonly Item[]): Item => at(items, Math.floor(random() * items.length));
    const m1 = await machine(1);
    const bases: Raw[] = [genesis(), await device(phone), await device(tablet, "bound", "watch", { until: String(T0 + 9) }), { ...(await device(late)), ends: owner }, await pc(desk, 1), invite(pool), invite(plain, 1, false),
      await join(1), remove(phone), removePc(1), carried(phone), carriedPc(1), cardOf(owner), opening(0)];
    const values: (string | Uint8Array)[] = ["", "0", "1", "01", "drive", "x", E(1), E(171).toUpperCase(), phone.key, phone.enc, m1.key, OPENS(1), SEALED, new Uint8Array(46), LINK(1), new Uint8Array(60), await card(phone)];
    const names = ["account", "auto", "card", "enc", "endpoint", "epoch", "epoch_link", "epoch_opens", "exp", "pc", "role", "sealed", "until", "uses", "note"];
    let read = 0;
    for (let round = 0; round < 3000; round++) {
      let raw = pick(bases);
      for (let change = Math.floor(random() * 3); change > 0; change--) {
        const way = random();
        if (way < 0.4) raw = less(raw, pick(names));
        else if (way < 0.8) raw = plus(raw, { [pick(names)]: pick(values) });
        else if (way < 0.9) raw = { ...raw, adds: [pick([phone, late]), pick(["full", "bound"] as const)] };
        else raw = { ...raw, ends: pick([owner, phone]) };
      }
      const body = bodyOf(raw, owner, { seq: 1, list: LIST, prev: LIST });
      const kind = readKind(body);
      if (kind === null) continue;
      read++;
      const { issued_at, list, prev, seq, signer } = body;
      const again = kindBody({ issued_at, list, prev, seq, signer }, kind);
      expect(again).toEqual(body);
      expect(readKind(again)).toEqual(kind);
    }
    // Most of what such changes make is of no kind; enough of it is.
    expect(read).toBeGreaterThan(300);
  });

  test("what a member holds never depends on where an honest answer was cut", async () => {
    const steps: Step[] = [[owner, carriedPc(3)], [owner, device(phone)], [owner, pc(desk, 1)], [desk, invite(pool, 2)], [pool, join(2)], [phone, device(tablet, "bound", "watch")], [desk, remove(phone)], [tablet, remove(tablet)]];
    const { links, state } = await play(steps);
    const texts = links.map((item) => item.text);
    const head = { seq: links.length - 1, hash: at(links, links.length - 1).held.hash };
    const start = { entries: [at(texts, 0)], state: firstListState(at(links, 0).held, 1) };
    for (let size = 1; size <= texts.length; size++) {
      let member: ListCopy = start;
      for (let after = 0; after < texts.length - 1; after += size) {
        const shown = await shownList(member, { after, entries: texts.slice(after + 1, after + 1 + size), head });
        expect([shown.stopped, shown.stuck]).toEqual([null, false]);
        member = shown.member;
      }
      expect({ size, state: member.state, entries: member.entries }).toEqual({ size, state, entries: texts });
    }
  });
});

describe("the vectors of kinds/, card/ and names/", () => {
  const DIR = joinPath(import.meta.dir, "account-list-vectors");
  const load = <Vector>(folder: string): Vector[] => readdirSync(joinPath(DIR, folder)).filter((file) => file.endsWith(".json")).sort()
    .map((file) => JSON.parse(readFileSync(joinPath(DIR, folder, file), "utf8")) as Vector);
  interface KindsVector {
    readonly name: string;
    readonly level: number;
    readonly keys: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
    readonly entries: readonly { readonly fields: Readonly<Record<string, string>>; readonly text: string; readonly hash: string }[];
    /** `stops` alone for a list no member follows; with `outcomes` and `state`, a member that stopped after the entries it took. */
    readonly expect: { readonly outcomes: readonly string[]; readonly state: ListState } | { readonly stops: { readonly seq: number; readonly code: string }; readonly outcomes?: readonly string[]; readonly state?: ListState };
  }
  const kinds = load<KindsVector>("kinds");

  test("kinds/: there is a vector for each kind, each refusal's name and each way a member stops", () => {
    const outcomes = new Set(kinds.flatMap((vector) => [...(vector.expect.outcomes ?? []), ...("stops" in vector.expect ? [`stops ${vector.expect.stops.code}`] : [])]));
    // A member that stops after entries it took keeps them: one vector for an entry that does not hold, one for an entry it cannot place.
    const kept = kinds.filter((vector) => "stops" in vector.expect && vector.expect.state !== undefined).map((vector) => ("stops" in vector.expect ? vector.expect.stops.code : ""));
    expect(kept.sort()).toEqual(["needs_replay", "signature_invalid"]);
    for (const word of ["counts", "cannot_read", "no_effect entry_invalid", "no_effect invite_unknown", "no_effect invite_void", "no_effect invite_spent", "no_effect invite_not_auto",
      "no_effect invite_expired", "no_effect carried_late",
      "no_effect signer_not_allowed", "no_effect already_out", "no_effect ends_needed", "no_effect endpoint_reused", "no_effect key_reused", "no_effect card_invalid", "no_effect enc_set",
      "no_effect epoch_other",
      "passed_over signer_unknown", "passed_over signer_not_allowed", "passed_over key_reused", "passed_over already_out", "passed_over invite_unknown", "passed_over invite_revoked", "stops entry_invalid", "stops needs_replay", "stops signature_invalid"]) {
      expect({ word, there: outcomes.has(word) }).toEqual({ word, there: true });
    }
    const written = new Set(kinds.flatMap((vector) => vector.entries.map((entry) => entry.fields.kind)));
    expect([...written].sort()).toEqual(expect.arrayContaining(Object.keys(LIST_LEVEL_TABLE).sort()));
    expect(kinds.length).toBeGreaterThanOrEqual(30);
    for (const vector of kinds) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of kinds) {
    test(`kinds/${vector.name}`, async () => {
      for (const entry of vector.entries) {
        const read = entryFromText(entry.text);
        expect(entryHash(read.body)).toBe(entry.hash);
        const shown = Object.fromEntries(readFields(read.body).map((item) => [item.name, item.name === "sealed" ? toBase64Url(item.value) : Buffer.from(item.value).toString("latin1")]));
        expect(shown).toEqual({ ...entry.fields });
      }
      const replayed = await replayList(vector.entries.map((entry) => entry.text), vector.level, { saved: null });
      const { outcomes: wanted, state: wantedState } = vector.expect;
      expect(replayed.stopped).toEqual(("stops" in vector.expect ? vector.expect.stops : null) as typeof replayed.stopped);
      if (wanted === undefined || wantedState === undefined) {
        // No member follows this list.
        expect([replayed.member, replayed.took]).toEqual([null, []]);
        return;
      }
      expect(replayed.took.slice(1).map((item) => said(item.outcome))).toEqual([...wanted]);
      expect(replayed.member?.state).toEqual(wantedState);
      expect(replayed.member?.entries).toEqual(vector.entries.slice(0, wanted.length + 1).map((entry) => entry.text));
      expect(readListState(JSON.parse(JSON.stringify(wantedState)), vector.level)).toEqual(wantedState);
    });
  }

  test("kinds/: the same entries, taken by a member that is behind and by one that reads everything, put a carried PC that got its keys out alike", async () => {
    const pair = ["behind-carried-pc-gets-its-keys", "behind-carried-pc-gets-its-keys-read"].map((name) => kinds.find((vector) => vector.name === name));
    const [behind, reads] = pair;
    if (behind === undefined || reads === undefined || "stops" in behind.expect || "stops" in reads.expect) throw new Error("the pair is missing");
    expect([behind.level, reads.level, behind.entries.map((entry) => entry.text)]).toEqual([1, 2, reads.entries.map((entry) => entry.text)]);
    // The pc counts for both; its relay key alone does not put it out for either; the end of its key puts it out for both.
    expect([behind.expect.outcomes, reads.expect.outcomes]).toEqual([["counts", "cannot_read", "counts", "no_effect ends_needed", "counts"], ["counts", "no_effect entry_invalid", "counts", "no_effect ends_needed", "counts"]]);
    expect([behind.expect.state.behind, reads.expect.state.behind, behind.expect.state.pcs]).toEqual([2, null, reads.expect.state.pcs]);
    const endpoint = Object.keys(reads.expect.state.pcs)[0] ?? "";
    expect([holdsPc(behind.expect.state, endpoint), holdsPc(reads.expect.state, endpoint), reads.expect.state.pcs[endpoint]?.removed]).toEqual([false, false, 5]);
    // One entry earlier both hold it.
    for (const vector of [behind, reads]) {
      const earlier = await replayList(vector.entries.slice(0, 5).map((entry) => entry.text), vector.level, { saved: null });
      expect(earlier.member === null ? null : holdsPc(earlier.member.state, endpoint)).toBe(true);
    }
  });

  interface CardVector { readonly name: string; readonly card: ListCard; readonly bytes?: string; readonly binding?: string; readonly signature: string; readonly expect: { readonly holds: boolean } }
  for (const vector of load<CardVector>("card")) {
    test(`card/${vector.name}`, async () => {
      if (vector.bytes !== undefined) expect([toBase64Url(cardBytes(vector.card)), Buffer.from(cardBinding(vector.card)).toString("hex")]).toEqual([vector.bytes, vector.binding ?? ""]);
      expect(await cardHolds(vector.card, vector.signature)).toBe(vector.expect.holds);
    });
  }

  interface NamesVector { readonly name: string; readonly fields: readonly { readonly name: string; readonly value: string }[]; readonly expect: { readonly names: { readonly label: string; readonly os: string | null } | null; readonly written: boolean } }
  for (const vector of load<NamesVector>("names")) {
    test(`names/${vector.name}`, () => {
      const fields = vector.fields.map(({ name, value }) => ({ name, value: fromBase64Url(value) }));
      const names = readNames(fields);
      expect(names).toEqual(vector.expect.names as typeof names);
      // `written` says that these fields are the ones a writer writes for those names.
      // Fields that give no names are none a writer writes.
      expect(names !== null && JSON.stringify(namesFields(names).map(({ name, value }) => ({ name, value: toBase64Url(value) }))) === JSON.stringify(vector.fields)).toBe(vector.expect.written);
    });
  }
});
