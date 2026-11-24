/**
 * The names of a signed list, kept from the account service that stores it (docs/account-list.md,
 * "Names the service cannot read"): the epoch key, its wrap for each member, the link from an epoch
 * to the one before, and the `sealed` field of an entry. Nothing here says who is a member. What
 * cannot be opened is a result (`open: false`), never a throw, so a wrong or missing wrap can only
 * hide a name. No I/O; every use of a key goes through WebCrypto, where a device's key cannot be
 * exported.
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { isListHash, isListPoint, LIST_BODY_MAX, type ListField, readFieldsUnder, writeFieldsUnder } from "./account-list-entry.ts";
import { SPKI_PREFIX } from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

/** Starts the HKDF info of a wrap. */
export const LIST_WRAP_TAG = "ovis-list-wrap/1";
/** The HKDF info of the key that seals fields, and the start of a sealed field's additional data. */
export const LIST_SEAL_TAG = "ovis-list-seal/1";
/** Every sealed plaintext starts with these bytes; its fields follow in the form of an entry's. */
export const LIST_SEALED_PREFIX = "ovis-list-sealed/1";
/** The HKDF info of the key that encrypts the epoch key before, and the start of a link's additional data. */
export const LIST_EPOCH_LINK_TAG = "ovis-list-epoch-link/1";
/** The commitment to an epoch key is SHA-256 over these bytes, the list id, the epoch and the key. */
export const LIST_EPOCH_KEY_TAG = "ovis-list-epoch-key/1";
export const LIST_SEAL_VERSION = 1;
export const LIST_EPOCH_KEY_BYTES = 32;
/** A wrap: the version, the ephemeral point's X and Y, the encrypted key and its tag. */
export const LIST_WRAP_BYTES = 113;
export const LIST_WRAP_TEXT_LENGTH = 151;
/** A link: the version, the nonce, the encrypted key and its tag. */
export const LIST_EPOCH_LINK_BYTES = 61;
/** What a sealed field adds to its plaintext: the version, the nonce and the tag. */
export const LIST_SEALED_OVERHEAD = 29;
/** A writer fills every sealed plaintext up to a multiple of this many bytes, so its length says little of the names in it. */
export const LIST_SEALED_PAD_BYTES = 256;
/** The field that fills it; no name of a kind's own, and a reader drops it. */
export const LIST_SEALED_PAD_NAME = "pad";
/** The most links one walkBack opens; a list with more epochs is walked on from the last key it reached. */
export const LIST_EPOCH_WALK_MAX = 1024;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const POINT_BYTES = 64;
const NUMBER_END = 10 ** 15;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
/** HKDF with no salt is HKDF with a salt of 32 zero bytes (RFC 5869); written out, so every runtime is asked the same. */
const NO_SALT = new Uint8Array(32);
const ENTRY_0_LIST = new Uint8Array(32);
const WRAP_TAG = utf8ToBytes(LIST_WRAP_TAG);
const SEAL_TAG = utf8ToBytes(LIST_SEAL_TAG);
const LINK_TAG = utf8ToBytes(LIST_EPOCH_LINK_TAG);
const EPOCH_KEY_TAG = utf8ToBytes(LIST_EPOCH_KEY_TAG);
const SEALED_MIN = LIST_SEALED_OVERHEAD + LIST_SEALED_PREFIX.length;
const PAD_FIELD_BYTES = 8 + LIST_SEALED_PAD_NAME.length;
/** PKCS8 up to the private value: SEQUENCE(135) { INTEGER 0, AlgorithmIdentifier { id-ecPublicKey, prime256v1 }, OCTET STRING(109) { SEQUENCE(107) { INTEGER 1, OCTET STRING(32) } } }. */
const SECRET_HEAD = Uint8Array.from([
  0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20,
]);
/** After the private value: [1] { BIT STRING { 0 unused bits, 0x04 } }, then X and Y. */
const SECRET_MIDDLE = Uint8Array.from([0xa1, 0x44, 0x03, 0x42, 0x00, 0x04]);
const SECRET_POINT_AT = SECRET_HEAD.length + 32 + SECRET_MIDDLE.length;
export const LIST_STORED_KEY_BYTES = 138;
export const LIST_STORED_KEY_TEXT_LENGTH = 184;

/**
 * Why something does not open. Callers show the device or PC without its name; none of these says
 * anything about who is a member.
 * - `missing`: nothing was given (no wrap, no link, no key, no sealed field);
 * - `form`: the bytes, or what they are opened for, have not the form (a length, a version, a point off the curve, a plaintext that is no fields);
 * - `refused`: in form, but it does not open with this key for this place (another member's wrap, another list, seq or epoch, a changed byte);
 * - `other_key`: it opens, to a key that is not the one the list commits to for that epoch, or a link opens to the very key
 *   it was opened with (no epoch has the key of the epoch before). Callers say so besides hiding the name: a wrap comes from
 *   the account service, so a wrong key in one is a sign of tampering;
 * - `bound`: the walk back opened as many links as it may;
 * - `unavailable`: the runtime could not do it (no WebCrypto on a page on plain http); a fault of the place, not of the bytes.
 */
export type CannotOpen = "missing" | "form" | "refused" | "other_key" | "bound" | "unavailable";

export type Opened<T> = { readonly open: true; readonly value: T } | { readonly open: false; readonly why: CannotOpen };

/** `other_key`: the key handed over to seal with is not the one the list commits to for its epoch. */
export type ListSealReason = "argument" | "fields" | "secret" | "other_key";

/** Thrown only where something is made (sealed, wrapped, linked, a stored key read); opening never throws. */
export class ListSealError extends Error {
  constructor(readonly reason: ListSealReason, message: string) {
    super(message);
    this.name = "ListSealError";
  }
}

function refuse(reason: ListSealReason, message: string): never {
  throw new ListSealError(reason, message);
}

/** An epoch and its key: 32 random bytes. */
export interface EpochKey {
  readonly epoch: number;
  readonly key: Uint8Array;
}

/** A member's encryption key: the public half in the one spelling of a key, and the private half, which only derives. */
export interface MemberEncryptionKey {
  readonly key: string;
  readonly privateKey: CryptoKey;
}

/** Where an entry stands: its own clear `list` (empty in entry 0) and `seq`. */
export interface SealedPlace {
  readonly list: string;
  readonly seq: number;
}

/** What the entry that opened an epoch says in clear: the commitment to that epoch's key, and the link to the key before (none for epoch 0). */
export interface EpochOpening {
  readonly commitment: string;
  readonly link?: Uint8Array | null;
}

export interface MemberWrap {
  readonly member: string;
  readonly wrap: Uint8Array;
}

export interface MemberWraps {
  readonly wraps: readonly MemberWrap[];
  /** Members whose key is no point of the curve: nothing can be wrapped to them, and nothing else waits for them. */
  readonly unwrapped: readonly string[];
}

export interface NextEpoch extends MemberWraps {
  readonly epoch: EpochKey;
  readonly commitment: string;
  readonly link: Uint8Array;
}

export interface EpochWalk {
  /** The keys reached, from the given one down. */
  readonly keys: readonly EpochKey[];
  /** Null when the walk reached the epoch asked for; else the first epoch whose key it did not reach, and why. */
  readonly stopped: { readonly epoch: number; readonly why: CannotOpen } | null;
}

function closed(why: CannotOpen): { readonly open: false; readonly why: CannotOpen } {
  return { open: false, why };
}

/** The caller's bytes, copied only once their length can be the thing's: nothing of any other size is read. */
function bytesOf(value: unknown, min: number, max: number): Uint8Array | null {
  return value instanceof Uint8Array && value.length >= min && value.length <= max ? new Uint8Array(value) : null;
}

function isListCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < NUMBER_END;
}

function isEpochKey(value: EpochKey | null | undefined): value is EpochKey {
  return value !== null && value !== undefined && isListCount(value.epoch) && value.key instanceof Uint8Array && value.key.length === LIST_EPOCH_KEY_BYTES;
}

/**
 * A caller's epoch key, read once and copied; null when it is none. Every function here takes what
 * it is handed before its first await, so nothing a caller does to its own objects while a call
 * is pending changes what the call makes or opens.
 */
function epochKeyOf(value: EpochKey | null | undefined): EpochKey | null {
  if (value === null || value === undefined) return null;
  const { epoch, key } = value;
  return isListCount(epoch) && key instanceof Uint8Array && key.length === LIST_EPOCH_KEY_BYTES ? { epoch, key: new Uint8Array(key) } : null;
}

function isPlace(place: SealedPlace): boolean {
  return isListCount(place.seq) && (place.seq === 0 ? place.list === "" : isListHash(place.list));
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function spkiOf(point: Uint8Array): Uint8Array {
  return concatBytes(SPKI_PREFIX, point);
}

function wrapInfo(list: string, epoch: number, member: string, ephemeral: Uint8Array): Uint8Array {
  return concatBytes(WRAP_TAG, hexToBytes(list), u64(epoch), fromBase64Url(member), spkiOf(ephemeral));
}

function sealedData(place: SealedPlace, epoch: number): Uint8Array {
  return concatBytes(SEAL_TAG, place.seq === 0 ? ENTRY_0_LIST : hexToBytes(place.list), u64(place.seq), u64(epoch));
}

function linkData(list: string, epoch: number): Uint8Array {
  return concatBytes(LINK_TAG, hexToBytes(list), u64(epoch));
}

/** The key and nonce of one wrap. Its ephemeral key is used once, so the pair never comes twice. */
async function wrapCipher(subtle: SubtleCrypto, privateKey: CryptoKey, publicPoint: Uint8Array, info: Uint8Array): Promise<{ key: CryptoKey; iv: Uint8Array }> {
  const publicKey = await subtle.importKey("spki", new Uint8Array(spkiOf(publicPoint)), ECDH, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const derived = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: NO_SALT, info: new Uint8Array(info) }, material, (32 + NONCE_BYTES) * 8));
  return { key: await subtle.importKey("raw", derived.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]), iv: derived.slice(32) };
}

/** One of the two keys an epoch key gives: fields are sealed under one, the key before under the other. */
async function epochCipher(subtle: SubtleCrypto, epochKey: Uint8Array, tag: Uint8Array): Promise<CryptoKey> {
  const material = await subtle.importKey("raw", new Uint8Array(epochKey), "HKDF", false, ["deriveKey"]);
  return await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: NO_SALT, info: new Uint8Array(tag) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encrypt(subtle: SubtleCrypto, key: CryptoKey, iv: Uint8Array, data: Uint8Array | null, plaintext: Uint8Array): Promise<Uint8Array> {
  const params = { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: TAG_BYTES * 8, ...(data ? { additionalData: new Uint8Array(data) } : {}) };
  return new Uint8Array(await subtle.encrypt(params, key, new Uint8Array(plaintext)));
}

/** Null when the tag does not hold: a verdict on the bytes, which a fault of the runtime is not. */
async function decrypt(subtle: SubtleCrypto, key: CryptoKey, iv: Uint8Array, data: Uint8Array | null, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  const params = { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: TAG_BYTES * 8, ...(data ? { additionalData: new Uint8Array(data) } : {}) };
  try {
    return new Uint8Array(await subtle.decrypt(params, key, new Uint8Array(ciphertext)));
  } catch (error) {
    if (error instanceof DOMException && error.name === "OperationError") return null;
    throw error;
  }
}

function webCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available here (crypto.subtle is missing), so nothing of a list can be sealed or wrapped");
  return subtle;
}

/** Opening is total: whatever the runtime throws is `unavailable`, so no caller needs a try around a name. */
async function opening<T>(open: (subtle: SubtleCrypto) => Promise<Opened<T>>): Promise<Opened<T>> {
  try {
    return await open(webCrypto());
  } catch {
    return closed("unavailable");
  }
}

/** A fault, no refusal, when the runtime exports a public key otherwise than as a key of the list: nothing may be wrapped to it. */
async function publicKeyOf(subtle: SubtleCrypto, key: CryptoKey): Promise<string> {
  const text = toBase64Url(new Uint8Array(await subtle.exportKey("spki", key)));
  if (!isListPoint(text)) throw new Error("The runtime made a public key that is not a P-256 key in the list's one spelling");
  return text;
}

/** A device's encryption key. The private half cannot be exported: it is stored as the CryptoKey it is (IndexedDB), beside the public half. */
export async function generateDeviceEncryptionKey(): Promise<MemberEncryptionKey> {
  const subtle = webCrypto();
  const pair = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  return { key: await publicKeyOf(subtle, pair.publicKey), privateKey: pair.privateKey };
}

function jwkPart(value: string | undefined): Uint8Array {
  const bytes = value === undefined || !/^[A-Za-z0-9_-]{43}$/.test(value) ? null : fromBase64Url(value);
  if (bytes === null || bytes.length !== 32) refuse("secret", "The runtime made a key that is not a P-256 private key");
  return bytes;
}

/**
 * An encryption key a PC keeps in a file: the public half, and `secret`, the private key as the
 * base64url of its one PKCS8 form (the join line's). The bytes are built here from the key's
 * values, never taken from an engine's PKCS8 export, so every runtime writes the same form.
 */
export async function generateStoredEncryptionKey(): Promise<{ readonly key: string; readonly secret: string }> {
  const subtle = webCrypto();
  const pair = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const point = concatBytes(jwkPart(jwk.x), jwkPart(jwk.y));
  const key = await publicKeyOf(subtle, pair.publicKey);
  if (key !== toBase64Url(spkiOf(point))) throw new Error("The runtime exported a private key whose public point is not its public key's");
  return { key, secret: toBase64Url(concatBytes(SECRET_HEAD, jwkPart(jwk.d), SECRET_MIDDLE, point)) };
}

/**
 * A stored key, read strictly: the one PKCS8 form in its one spelling, a private value from 1 to
 * n-1, and the public point that value gives (judged here, whatever the runtime's import checks).
 * Refuses `secret`, never with any part of the secret in the message.
 */
export async function readStoredEncryptionKey(secret: string): Promise<MemberEncryptionKey> {
  const subtle = webCrypto();
  const bytes = typeof secret === "string" && secret.length === LIST_STORED_KEY_TEXT_LENGTH && /^[A-Za-z0-9_-]+$/.test(secret) ? fromBase64Url(secret) : null;
  const inForm = bytes !== null && bytes.length === LIST_STORED_KEY_BYTES && toBase64Url(bytes) === secret
    && SECRET_HEAD.every((byte, index) => bytes[index] === byte) && SECRET_MIDDLE.every((byte, index) => bytes[SECRET_HEAD.length + 32 + index] === byte);
  if (bytes === null || !inForm) refuse("secret", "The stored key is not a P-256 private key in its one PKCS8 form");
  const d = bytes.subarray(SECRET_HEAD.length, SECRET_HEAD.length + 32);
  const point = bytes.subarray(SECRET_POINT_AT);
  if (!p256.utils.isValidSecretKey(d)) refuse("secret", "The stored key's private value is not from 1 to n-1 of P-256");
  const own = p256.getPublicKey(d, false).subarray(1);
  if (!own.every((byte, index) => point[index] === byte)) refuse("secret", "The stored key's public point is not its private value's");
  const privateKey = await subtle.importKey("pkcs8", new Uint8Array(bytes), ECDH, false, ["deriveBits"]);
  return { key: toBase64Url(spkiOf(point)), privateKey };
}

/** A new key for an epoch: epoch 0 with the list, the next one after each removal. */
export function newEpochKey(epoch: number): EpochKey {
  if (!isListCount(epoch)) refuse("argument", "An epoch is a number of the list: 0 or more, at most 15 digits");
  return { epoch, key: randomBytes(LIST_EPOCH_KEY_BYTES) };
}

/**
 * The commitment to an epoch's key, as a hash: SHA-256 over its own tag, the list id, the epoch and
 * the key. The entry that opens the epoch carries it in clear, under a member's signature; a key
 * from a wrap or a link is taken only when it gives this hash. Without it the service, which can
 * wrap any key to a member, could hand a new member a key of its own and read what that member
 * seals. Epoch 0 is committed to in entry 0, whose hash is the list id: no list id exists yet, so
 * 32 zero bytes stand for it, and what binds that commitment to its list is the entry it stands
 * in. `list` is not read for epoch 0.
 */
export function epochKeyCommitment(given: { readonly list: string; readonly epoch: EpochKey }): string {
  const { list, epoch } = given;
  if (!isEpochKey(epoch)) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  if (epoch.epoch !== 0 && !isListHash(list)) refuse("argument", "list is a list id: 64 of 0-9a-f");
  return bytesToHex(sha256(concatBytes(EPOCH_KEY_TAG, epoch.epoch === 0 ? ENTRY_0_LIST : hexToBytes(list), u64(epoch.epoch), epoch.key)));
}

/**
 * An epoch key wrapped to one member; null when the member's key is no point of the curve, so that
 * one member's bad key never stops an addition or a removal. Anyone can wrap, so a wrap proves
 * nothing: the reader checks the key against the list's commitment.
 */
export async function wrapEpochKey(given: { readonly list: string; readonly epoch: EpochKey; readonly member: string }): Promise<Uint8Array | null> {
  const subtle = webCrypto();
  const { list, member } = given;
  const epoch = epochKeyOf(given.epoch);
  if (!isListHash(list)) refuse("argument", "list is a list id: 64 of 0-9a-f");
  if (epoch === null) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  return await wrapTo(subtle, list, epoch, member);
}

/** One wrap, of a key and for a list that were already read and judged. */
async function wrapTo(subtle: SubtleCrypto, list: string, epoch: EpochKey, member: string): Promise<Uint8Array | null> {
  if (typeof member !== "string" || !isListPoint(member)) return null;
  const ephemeral = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  const point = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey)).subarray(1);
  const cipher = await wrapCipher(subtle, ephemeral.privateKey, fromBase64Url(member).subarray(SPKI_PREFIX.length), wrapInfo(list, epoch.epoch, member, point));
  return concatBytes(Uint8Array.of(LIST_SEAL_VERSION), point, await encrypt(subtle, cipher.key, cipher.iv, null, epoch.key));
}

/**
 * An epoch key wrapped to each member of a set, each once. The list, the key and the members are
 * read once, before the first wrap is made: every wrap of the batch is of that one key, for the
 * members as they were handed over.
 */
export async function wrapEpochKeyFor(given: { readonly list: string; readonly epoch: EpochKey; readonly members: readonly string[] }): Promise<MemberWraps> {
  const subtle = webCrypto();
  const { list } = given;
  const epoch = epochKeyOf(given.epoch);
  if (!isListHash(list)) refuse("argument", "list is a list id: 64 of 0-9a-f");
  if (epoch === null) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  if (!Array.isArray(given.members)) refuse("argument", "members is the list of the members' encryption keys");
  const members = [...new Set<string>(given.members)];
  const wraps: MemberWrap[] = [];
  const unwrapped: string[] = [];
  for (const member of members) {
    const wrap = await wrapTo(subtle, list, epoch, member);
    if (wrap === null) unwrapped.push(member);
    else wraps.push({ member, wrap });
  }
  return { wraps, unwrapped };
}

/**
 * The epoch key a wrap holds for this member, when it is the one the list commits to for that
 * epoch. `commitment` comes from the entry that opened the epoch, never from the service's word.
 */
export async function openWrap(given: {
  readonly list: string; readonly epoch: number; readonly commitment: string; readonly wrap: Uint8Array | null | undefined; readonly member: MemberEncryptionKey;
}): Promise<Opened<EpochKey>> {
  return await opening<EpochKey>(async (subtle) => {
    const { list, epoch, commitment, wrap: handed, member } = given;
    if (handed === null || handed === undefined) return closed("missing");
    const wrap = bytesOf(handed, LIST_WRAP_BYTES, LIST_WRAP_BYTES);
    const memberKey = member?.key;
    const privateKey = member?.privateKey;
    if (!isListHash(list) || !isListCount(epoch) || !isListHash(commitment) || typeof memberKey !== "string" || !isListPoint(memberKey)) return closed("form");
    if (wrap === null || wrap[0] !== LIST_SEAL_VERSION) return closed("form");
    const point = wrap.subarray(1, 1 + POINT_BYTES);
    if (!isListPoint(toBase64Url(spkiOf(point)))) return closed("form");
    const cipher = await wrapCipher(subtle, privateKey, point, wrapInfo(list, epoch, memberKey, point));
    const key = await decrypt(subtle, cipher.key, cipher.iv, null, wrap.subarray(1 + POINT_BYTES));
    if (key === null) return closed("refused");
    const opened: EpochKey = { epoch, key };
    return epochKeyCommitment({ list, epoch: opened }) === commitment ? { open: true, value: opened } : closed("other_key");
  });
}

export function wrapToText(wrap: Uint8Array): string {
  if (wrap.length !== LIST_WRAP_BYTES) refuse("argument", `A wrap is ${LIST_WRAP_BYTES} bytes`);
  return toBase64Url(wrap);
}

/** A wrap's text, read strictly: 151 characters of base64url in their one spelling; null for anything else. What the bytes hold is openWrap's to say. */
export function wrapFromText(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length !== LIST_WRAP_TEXT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = fromBase64Url(text);
  return bytes.length === LIST_WRAP_BYTES && toBase64Url(bytes) === text ? bytes : null;
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The link an epoch's opening entry carries: the key of the epoch before, under the opened one. Refuses `argument`
 * for two epochs of one key: whoever was put out holds the key before, and would read on under the next number.
 */
export async function linkEpochs(given: { readonly list: string; readonly opened: EpochKey; readonly previous: EpochKey }): Promise<Uint8Array> {
  const subtle = webCrypto();
  const { list } = given;
  const opened = epochKeyOf(given.opened);
  const previous = epochKeyOf(given.previous);
  if (!isListHash(list)) refuse("argument", "list is a list id: 64 of 0-9a-f");
  if (opened === null || previous === null) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  return await linkOf(subtle, list, opened, previous);
}

/** One link, of keys and for a list that were already read and judged. */
async function linkOf(subtle: SubtleCrypto, list: string, opened: EpochKey, previous: EpochKey): Promise<Uint8Array> {
  if (opened.epoch !== previous.epoch + 1) refuse("argument", "A link goes from an epoch to the one before it");
  if (sameKey(opened.key, previous.key)) refuse("argument", "An epoch's key is never the key of the epoch before");
  const nonce = randomBytes(NONCE_BYTES);
  const key = await epochCipher(subtle, opened.key, LINK_TAG);
  return concatBytes(Uint8Array.of(LIST_SEAL_VERSION), nonce, await encrypt(subtle, key, nonce, linkData(list, opened.epoch), previous.key));
}

/**
 * The key of the epoch before `from`, out of the link `from`'s opening entry carries, when it is the one the list
 * commits to and another key than `from`'s own: the writer makes no link between two epochs of one key
 * (linkEpochs), and a reader takes none (`other_key`).
 */
export async function openLink(given: {
  readonly list: string; readonly from: EpochKey; readonly link: Uint8Array | null | undefined; readonly commitment: string;
}): Promise<Opened<EpochKey>> {
  return await opening<EpochKey>(async (subtle) => {
    const { list, commitment, link: handed } = given;
    if (handed === null || handed === undefined) return closed("missing");
    const link = bytesOf(handed, LIST_EPOCH_LINK_BYTES, LIST_EPOCH_LINK_BYTES);
    const from = epochKeyOf(given.from);
    if (!isListHash(list) || !isListHash(commitment) || from === null || from.epoch < 1) return closed("form");
    if (link === null || link[0] !== LIST_SEAL_VERSION) return closed("form");
    const cipher = await epochCipher(subtle, from.key, LINK_TAG);
    const key = await decrypt(subtle, cipher, link.subarray(1, 1 + NONCE_BYTES), linkData(list, from.epoch), link.subarray(1 + NONCE_BYTES));
    if (key === null) return closed("refused");
    if (sameKey(key, from.key)) return closed("other_key");
    const before: EpochKey = { epoch: from.epoch - 1, key };
    return epochKeyCommitment({ list, epoch: before }) === commitment ? { open: true, value: before } : closed("other_key");
  });
}

/** What the list says of one epoch as a walk reads it: nothing, or a commitment and a link, each still to be judged. */
type Said = { readonly commitment: unknown; readonly link: Uint8Array | null | undefined } | "nothing" | "unreadable";

/** One epoch of a caller's openings, read once through `get` alone (all a ReadonlyMap must answer), its link copied. */
function saidOf(openings: ReadonlyMap<number, EpochOpening> | null | undefined, epoch: number): Said {
  if (openings === null || openings === undefined) return "nothing";
  try {
    const opening = openings.get(epoch);
    if (opening === null || opening === undefined) return "nothing";
    const { commitment, link } = opening;
    return { commitment, link: link instanceof Uint8Array ? new Uint8Array(link) : link };
  } catch {
    return "unreadable";
  }
}

/**
 * From one epoch key down to epoch `to` (0 when not given), through the links: `openings` holds
 * what the list says of each epoch, by its number. The key it starts from is checked against its
 * own epoch's commitment like every key after it, so each key it gives is one the list commits
 * to. It stops where the list says nothing of an epoch, where a link is missing or does not open,
 * and after `max` links (LIST_EPOCH_WALK_MAX at most); what it reached stays good, and a caller
 * walks on from the last key. Like every opening it never throws. It reads the epochs it may walk
 * out of `openings` before it opens anything, through `get` alone, so any read-only view of a map
 * will do and nothing the caller does to it meanwhile changes the walk.
 */
export async function walkBack(given: {
  readonly list: string; readonly from: EpochKey; readonly to?: number; readonly openings: ReadonlyMap<number, EpochOpening>; readonly max?: number;
}): Promise<EpochWalk> {
  const keys: EpochKey[] = [];
  let epoch = 0;
  try {
    const { list, openings } = given;
    const first = epochKeyOf(given.from);
    if (first === null) return { keys, stopped: { epoch, why: "form" } };
    let from = first;
    epoch = from.epoch;
    const to = given.to ?? 0;
    const max = Math.min(isListCount(given.max) ? given.max : LIST_EPOCH_WALK_MAX, LIST_EPOCH_WALK_MAX);
    if (!isListHash(list) || !isListCount(to)) return { keys, stopped: { epoch, why: "form" } };
    const lowest = Math.max(Math.min(to, epoch), epoch - max);
    const said = new Map<number, Said>();
    for (let at = epoch; at >= lowest; at -= 1) said.set(at, saidOf(openings, at));

    const own = said.get(epoch) ?? "nothing";
    if (own === "unreadable") return { keys, stopped: { epoch, why: "unavailable" } };
    if (own === "nothing" || own.commitment === undefined) return { keys, stopped: { epoch, why: "missing" } };
    if (typeof own.commitment !== "string" || !isListHash(own.commitment)) return { keys, stopped: { epoch, why: "form" } };
    if (epochKeyCommitment({ list, epoch: from }) !== own.commitment) return { keys, stopped: { epoch, why: "other_key" } };
    keys.push(from);
    if (to > epoch) return { keys, stopped: { epoch: to, why: "missing" } };
    for (let steps = 0; from.epoch > to; steps += 1) {
      epoch = from.epoch - 1;
      if (steps >= max) return { keys, stopped: { epoch, why: "bound" } };
      const before = said.get(epoch) ?? "nothing";
      const here = said.get(from.epoch) ?? "nothing";
      if (before === "unreadable" || here === "unreadable") return { keys, stopped: { epoch, why: "unavailable" } };
      if (before === "nothing" || before.commitment === undefined) return { keys, stopped: { epoch, why: "missing" } };
      const opened = await openLink({ list, from, link: here === "nothing" ? null : here.link, commitment: before.commitment as string });
      if (!opened.open) return { keys, stopped: { epoch, why: opened.why } };
      from = opened.value;
      keys.push(from);
    }
    return { keys, stopped: null };
  } catch {
    return { keys, stopped: { epoch, why: "unavailable" } };
  }
}

/** The plaintext of the fields and the field that fills it up to a multiple of LIST_SEALED_PAD_BYTES. */
function paddedPlaintext(given: readonly ListField[]): Uint8Array {
  if (!Array.isArray(given)) refuse("fields", "The fields are not in the form of an entry's fields, or do not fit a sealed field");
  const fields: ListField[] = [];
  for (const field of given) {
    const name = field?.name;
    const value = field?.value;
    if (typeof name !== "string" || !(value instanceof Uint8Array)) refuse("fields", "The fields are not in the form of an entry's fields, or do not fit a sealed field");
    fields.push({ name, value: new Uint8Array(value) });
  }
  if (fields.some((field) => field.name === LIST_SEALED_PAD_NAME)) refuse("fields", `${LIST_SEALED_PAD_NAME} is the field that fills a sealed field: no caller writes it`);
  try {
    const bare = writeFieldsUnder(LIST_SEALED_PREFIX, fields).length;
    const size = Math.ceil((bare + PAD_FIELD_BYTES) / LIST_SEALED_PAD_BYTES) * LIST_SEALED_PAD_BYTES;
    if (size + LIST_SEALED_OVERHEAD > LIST_BODY_MAX) refuse("fields", `A sealed field is at most ${LIST_BODY_MAX} bytes`);
    return writeFieldsUnder(LIST_SEALED_PREFIX, [...fields, { name: LIST_SEALED_PAD_NAME, value: new Uint8Array(size - bare - PAD_FIELD_BYTES) }]);
  } catch (error) {
    if (error instanceof ListSealError) throw error;
    return refuse("fields", "The fields are not in the form of an entry's fields, or do not fit a sealed field");
  }
}

/**
 * The value of an entry's `sealed` field: the named fields, under the epoch's key, for one place.
 * `commitment` is what the list holds for that epoch: a key that does not give it seals nothing
 * (`other_key`), so nothing is ever sealed under a key the list does not commit to. Entry 0 is
 * sealed under epoch 0. The plaintext is filled up with `pad` to a multiple of 256 bytes, by
 * every writer alike. The nonce is 96 random bits, never made from `seq`: a member that signs
 * entry n again after its first try lost the place seals other fields for the same seq, and a
 * nonce made from seq would come twice under one key. Refuses `fields` for fields that are not
 * in form, are named `pad` or do not fit.
 *
 * Which epoch a member may seal under is the caller's to know, since nothing here sees the list
 * (docs/account-list.md, "Who seals, and when"): the current epoch, and only when its opening
 * entry comes after the last entry that took a wrapped key out. Otherwise the caller seals
 * nothing: under any other key a member already removed would read the names.
 */
export async function sealFields(given: {
  readonly place: SealedPlace; readonly epoch: EpochKey; readonly commitment: string; readonly fields: readonly ListField[];
}): Promise<Uint8Array> {
  const subtle = webCrypto();
  const place: SealedPlace = { list: given.place.list, seq: given.place.seq };
  const { commitment } = given;
  const epoch = epochKeyOf(given.epoch);
  if (!isPlace(place)) refuse("argument", "A place is a seq and the list id, which is empty for entry 0 and for no other");
  if (epoch === null) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  if (place.seq === 0 && epoch.epoch !== 0) refuse("argument", "Entry 0 is sealed under epoch 0");
  if (typeof commitment !== "string" || !isListHash(commitment)) refuse("argument", "commitment is the hash the list holds for the epoch");
  if (epochKeyCommitment({ list: place.list, epoch }) !== commitment) refuse("other_key", "The key is not the one the list commits to for its epoch");
  const plaintext = paddedPlaintext(given.fields);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await epochCipher(subtle, epoch.key, SEAL_TAG);
  return concatBytes(Uint8Array.of(LIST_SEAL_VERSION), nonce, await encrypt(subtle, key, nonce, sealedData(place, epoch.epoch), plaintext));
}

/**
 * The fields a `sealed` value holds, for the place and the epoch its entry names in clear, without the field that
 * fills it. Entry 0 is sealed under epoch 0 and no other, for the reader as for the writer (sealFields): under
 * another epoch it has not the form, whatever the bytes are.
 */
export async function openSealed(given: {
  readonly place: SealedPlace; readonly epoch: EpochKey | null | undefined; readonly sealed: Uint8Array | null | undefined;
}): Promise<Opened<readonly ListField[]>> {
  return await opening<readonly ListField[]>(async (subtle) => {
    const { sealed: handed, epoch: handedKey } = given;
    if (handed === null || handed === undefined || handedKey === null || handedKey === undefined) return closed("missing");
    const sealed = bytesOf(handed, SEALED_MIN, LIST_BODY_MAX);
    const place: SealedPlace = { list: given.place.list, seq: given.place.seq };
    const epoch = epochKeyOf(handedKey);
    if (!isPlace(place) || epoch === null || (place.seq === 0 && epoch.epoch !== 0)) return closed("form");
    if (sealed === null || sealed[0] !== LIST_SEAL_VERSION) return closed("form");
    const key = await epochCipher(subtle, epoch.key, SEAL_TAG);
    const plaintext = await decrypt(subtle, key, sealed.subarray(1, 1 + NONCE_BYTES), sealedData(place, epoch.epoch), sealed.subarray(1 + NONCE_BYTES));
    if (plaintext === null) return closed("refused");
    try {
      return { open: true, value: readFieldsUnder(LIST_SEALED_PREFIX, plaintext).filter((field) => field.name !== LIST_SEALED_PAD_NAME) };
    } catch {
      return closed("form");
    }
  });
}

/**
 * What follows a removal, given the members that stay: the next epoch's key, its commitment and
 * its link (both for the entry that opens the epoch) and its wrap for each member that stays. What
 * was sealed under the epoch before stays readable to the member that left; nothing under the new
 * key is. Called afresh for every attempt: a key whose wraps went out in a request that did not
 * place is never used again, since the members it was wrapped to may no longer be the ones that
 * stay. The members are read once, before anything is made: the key is wrapped to the set as it
 * was handed over, whatever the caller does to its array meanwhile.
 */
export async function nextEpoch(given: { readonly list: string; readonly current: EpochKey; readonly members: readonly string[] }): Promise<NextEpoch> {
  const subtle = webCrypto();
  const { list } = given;
  const current = epochKeyOf(given.current);
  if (!isListHash(list)) refuse("argument", "list is a list id: 64 of 0-9a-f");
  if (current === null) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  if (!Array.isArray(given.members)) refuse("argument", "members is the list of the members' encryption keys");
  const members = [...new Set<string>(given.members)];
  const epoch = newEpochKey(current.epoch + 1);
  const link = await linkOf(subtle, list, epoch, current);
  const wraps: MemberWrap[] = [];
  const unwrapped: string[] = [];
  for (const member of members) {
    const wrap = await wrapTo(subtle, list, epoch, member);
    if (wrap === null) unwrapped.push(member);
    else wraps.push({ member, wrap });
  }
  return { epoch, commitment: epochKeyCommitment({ list, epoch }), link, wraps, unwrapped };
}
