import { describe, expect, spyOn, test } from "bun:test";
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isListKeyEncoding, isListPoint, LIST_BODY_MAX, type ListField, writeFieldsUnder } from "./account-list-entry.ts";
import {
  type CannotOpen, type EpochKey, type EpochOpening, epochKeyCommitment, generateDeviceEncryptionKey, generateStoredEncryptionKey, linkEpochs,
  LIST_EPOCH_LINK_BYTES, LIST_EPOCH_WALK_MAX, LIST_SEALED_OVERHEAD, LIST_SEALED_PAD_BYTES, LIST_SEALED_PREFIX, LIST_STORED_KEY_BYTES, LIST_WRAP_BYTES, LIST_WRAP_TEXT_LENGTH,
  ListSealError, type MemberEncryptionKey, newEpochKey, nextEpoch, openLink, openSealed, openWrap, readStoredEncryptionKey, sealFields, walkBack,
  wrapEpochKey, wrapEpochKeyFor, wrapFromText, wrapToText,
} from "./account-list-seal.ts";
import { type SealVector, type SealVectorResult, sealVectorResult } from "./account-list-seal-vectors.ts";
import { newInvite, readJoinLine } from "./account-list-join.ts";
import { SPKI_PREFIX } from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const LIST = "5c".repeat(32);
const OTHER_LIST = "a7".repeat(32);
const text = (name: string, value: string): ListField => ({ name, value: utf8ToBytes(value) });
const NAMES = [text("endpoint", "pc.example:17420"), text("label", "Home laptop"), text("os", "linux")];
const shown = (fields: readonly ListField[]) => fields.map((field) => [field.name, new TextDecoder().decode(field.value)]);
const flipped = (bytes: Uint8Array, bit: number): Uint8Array => {
  const copy = new Uint8Array(bytes);
  copy[bit >> 3] = (copy[bit >> 3] ?? 0) ^ (1 << (bit & 7));
  return copy;
};
const u64 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
};
function why(result: { open: boolean; why?: CannotOpen }): CannotOpen | "open" {
  return result.open ? "open" : (result.why ?? "open");
}
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

/** sealFields with the commitment the key gives, as a member that holds the list's own commitment would call it. */
function seal(given: { place: { list: string; seq: number }; epoch: EpochKey; fields: readonly ListField[] }): Promise<Uint8Array> {
  return sealFields({ ...given, commitment: epochKeyCommitment({ list: LIST, epoch: given.epoch }) });
}

const alice = await generateDeviceEncryptionKey();
const bob = await generateDeviceEncryptionKey();
const carol = await generateDeviceEncryptionKey();

const REF_SPKI = hexToBytes("3059301306072a8648ce3d020106082a8648ce3d03010703420004");
function ref64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
function refWrapText(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{151}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? new Uint8Array(bytes) : null;
}
/** The fields of a sealed plaintext, read with nothing of account-list-entry.ts; throws for any that has not the form. */
function refFields(plaintext: Uint8Array): (readonly [string, string])[] {
  const prefix = "ovis-list-sealed/1";
  if (plaintext.length > 8192 || Buffer.from(plaintext.subarray(0, prefix.length)).toString("latin1") !== prefix) throw new Error("prefix");
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const fields: (readonly [string, string])[] = [];
  let at = prefix.length;
  const take = (): Uint8Array => {
    if (at + 4 > plaintext.length) throw new Error("length");
    const length = view.getUint32(at);
    if (at + 4 + length > plaintext.length) throw new Error("value");
    at += 4 + length;
    return plaintext.subarray(at - length, at);
  };
  let before = "";
  while (at < plaintext.length) {
    const name = Buffer.from(take()).toString("latin1");
    if (!/^[a-z][a-z_]{0,31}$/.test(name) || (fields.length > 0 && !(before < name))) throw new Error("name");
    fields.push([name, new TextDecoder().decode(take())]);
    before = name;
  }
  return fields;
}

/**
 * The formats of docs/account-list.md written a second time, with nothing of WebCrypto, of
 * account-list-seal.ts or of the list's own readers (its base64url, its field form, its key
 * prefix): what one side writes the other must read, and both must give every vector's `expect`.
 */
const reference = {
  sub(epochKey: Uint8Array, tag: string): Uint8Array {
    return hkdf(sha256, epochKey, new Uint8Array(32), utf8ToBytes(tag), 32);
  },
  commitment(list: string, epoch: number, key: Uint8Array): string {
    return bytesToHex(sha256(concatBytes(utf8ToBytes("ovis-list-epoch-key/1"), epoch === 0 ? new Uint8Array(32) : hexToBytes(list), u64(epoch), key)));
  },
  onCurve(point: Uint8Array): boolean {
    try {
      p256.Point.fromBytes(concatBytes(Uint8Array.of(4), point)).assertValidity();
      return true;
    } catch {
      return false;
    }
  },
  wrapCipher(secret: Uint8Array, point: Uint8Array, list: string, epoch: number, member: string, ephemeral: Uint8Array) {
    const shared = p256.getSharedSecret(secret, concatBytes(Uint8Array.of(4), point), true).subarray(1);
    const info = concatBytes(utf8ToBytes("ovis-list-wrap/1"), hexToBytes(list), u64(epoch), ref64(member), REF_SPKI, ephemeral);
    const derived = hkdf(sha256, shared, new Uint8Array(32), info, 44);
    return gcm(derived.subarray(0, 32), derived.subarray(32));
  },
  wrap(list: string, epoch: EpochKey, member: string): Uint8Array {
    const secret = p256.utils.randomSecretKey();
    const ephemeral = p256.getPublicKey(secret, false).subarray(1);
    const cipher = reference.wrapCipher(secret, ref64(member).subarray(REF_SPKI.length), list, epoch.epoch, member, ephemeral);
    return concatBytes(Uint8Array.of(1), ephemeral, cipher.encrypt(epoch.key));
  },
  openWrap(list: string, epoch: number, commitment: string, wrap: Uint8Array, member: string, pkcs8: Uint8Array): SealVectorResult {
    if (wrap.length !== 113 || wrap[0] !== 1 || !reference.onCurve(wrap.subarray(1, 65))) return { why: "form" };
    let key: Uint8Array;
    try {
      key = reference.wrapCipher(pkcs8.subarray(36, 68), wrap.subarray(1, 65), list, epoch, member, wrap.subarray(1, 65)).decrypt(wrap.subarray(65));
    } catch {
      return { why: "refused" };
    }
    return reference.commitment(list, epoch, key) === commitment ? { key: bytesToHex(key) } : { why: "other_key" };
  },
  linkData(list: string, epoch: number): Uint8Array {
    return concatBytes(utf8ToBytes("ovis-list-epoch-link/1"), hexToBytes(list), u64(epoch));
  },
  link(list: string, opened: EpochKey, previous: Uint8Array): Uint8Array {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    return concatBytes(Uint8Array.of(1), nonce, gcm(reference.sub(opened.key, "ovis-list-epoch-link/1"), nonce, reference.linkData(list, opened.epoch)).encrypt(previous));
  },
  openLink(list: string, from: EpochKey, commitment: string, link: Uint8Array): SealVectorResult {
    if (link.length !== 61 || link[0] !== 1 || from.epoch < 1) return { why: "form" };
    let key: Uint8Array;
    try {
      key = gcm(reference.sub(from.key, "ovis-list-epoch-link/1"), link.subarray(1, 13), reference.linkData(list, from.epoch)).decrypt(link.subarray(13));
    } catch {
      return { why: "refused" };
    }
    // An epoch's key is never the key of the epoch before: a link that opens to the key it was opened with gives no key.
    if (bytesToHex(key) === bytesToHex(from.key)) return { why: "other_key" };
    return reference.commitment(list, from.epoch - 1, key) === commitment ? { key: bytesToHex(key) } : { why: "other_key" };
  },
  sealedData(list: string, seq: number, epoch: number): Uint8Array {
    return concatBytes(utf8ToBytes("ovis-list-seal/1"), list === "" ? new Uint8Array(32) : hexToBytes(list), u64(seq), u64(epoch));
  },
  seal(list: string, seq: number, epoch: EpochKey, plaintext: Uint8Array): Uint8Array {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    return concatBytes(Uint8Array.of(1), nonce, gcm(reference.sub(epoch.key, "ovis-list-seal/1"), nonce, reference.sealedData(list, seq, epoch.epoch)).encrypt(plaintext));
  },
  openSealed(list: string, seq: number, epoch: EpochKey, sealed: Uint8Array): SealVectorResult {
    if ((seq === 0) !== (list === "") || (seq === 0 && epoch.epoch !== 0) || sealed.length < 47 || sealed.length > 8192 || sealed[0] !== 1) return { why: "form" };
    let plaintext: Uint8Array;
    try {
      plaintext = gcm(reference.sub(epoch.key, "ovis-list-seal/1"), sealed.subarray(1, 13), reference.sealedData(list, seq, epoch.epoch)).decrypt(sealed.subarray(13));
    } catch {
      return { why: "refused" };
    }
    try {
      return { fields: refFields(plaintext).filter(([name]) => name !== "pad") };
    } catch {
      return { why: "form" };
    }
  },
  result(vector: SealVector): SealVectorResult {
    if (vector.wrap) {
      const { list, epoch, commitment, member, text: wire } = vector.wrap;
      const pair = vector.keys?.[member];
      const wrap = refWrapText(wire);
      if (!pair) throw new Error("no key");
      return wrap === null ? { why: "form" } : reference.openWrap(list, epoch, commitment, wrap, pair.spki, ref64(pair.pkcs8));
    }
    if (vector.link) return reference.openLink(vector.link.list, { epoch: vector.link.from.epoch, key: hexToBytes(vector.link.from.key) }, vector.link.commitment, ref64(vector.link.bytes));
    if (vector.sealed) return reference.openSealed(vector.sealed.list, vector.sealed.seq, { epoch: vector.sealed.epoch.epoch, key: hexToBytes(vector.sealed.epoch.key) }, ref64(vector.sealed.bytes));
    throw new Error("no case");
  },
};

describe("the vectors of seal/", () => {
  const dir = join(import.meta.dir, "account-list-vectors", "seal");
  const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  const WRAPS = [
    "wrap", "wrap-epoch-15-digits", "wrap-made-elsewhere", "wrap-other-member", "wrap-other-list", "wrap-other-epoch", "wrap-byte-changed", "wrap-tag-changed",
    "wrap-other-point", "wrap-point-off-curve", "wrap-version-2", "wrap-version-0", "wrap-short", "wrap-trailing-byte", "wrap-text-padded",
    "wrap-text-second-spelling", "wrap-text-empty", "wrap-of-another-key", "wrap-epoch-0", "wrap-epoch-0-commitment-with-list", "wrap-commitment-other-list",
    "wrap-commitment-other-epoch", "wrap-point-x-is-p", "wrap-point-x-above-p", "wrap-made-in-python",
    "wrap-epoch-0-made-in-python",
  ];
  const LINKS = [
    "link", "link-made-elsewhere", "link-to-epoch-0", "link-other-list", "link-other-epoch", "link-other-from-key", "link-byte-changed", "link-nonce-changed",
    "link-version-2", "link-short", "link-trailing-byte", "link-of-another-key", "link-commitment-other-list", "link-from-epoch-0", "link-made-in-python",
    "link-same-key",
  ];
  const SEALED = [
    "sealed", "sealed-made-elsewhere", "sealed-entry-0", "sealed-no-fields", "sealed-utf8", "sealed-seq-15-digits", "sealed-other-seq", "sealed-other-list",
    "sealed-other-epoch", "sealed-other-epoch-key", "sealed-as-entry-0", "sealed-byte-changed", "sealed-nonce-changed", "sealed-tag-changed",
    "sealed-trailing-byte", "sealed-version-2", "sealed-short", "sealed-entry-0-with-list", "sealed-list-missing", "sealed-names-not-ascending",
    "sealed-plaintext-other-prefix", "sealed-plaintext-cut", "sealed-filled", "sealed-filled-512", "sealed-filled-no-fields", "sealed-pad-other-bytes", "sealed-made-in-python",
    "sealed-entry-0-epoch-1",
  ];
  const vectors = files.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as SealVector);

  test("there is one file for every vector named, and no other", () => {
    expect(files).toEqual([...WRAPS, ...LINKS, ...SEALED].map((name) => `${name}.json`).sort());
    for (const [index, vector] of vectors.entries()) expect(`${vector.name}.json`).toBe(files[index] ?? "");
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      expect(await sealVectorResult(vector)).toEqual(vector.expect);
      expect(reference.result(vector)).toEqual(vector.expect);
    });
  }

  test("every verdict has a vector, and every test key says what it is", () => {
    const verdicts = new Set(vectors.map((vector) => ("why" in vector.expect ? vector.expect.why : "open")));
    expect([...verdicts].sort()).toEqual(["form", "open", "other_key", "refused"]);
    for (const vector of vectors) {
      for (const [name, pair] of Object.entries(vector.keys ?? {})) {
        expect(name).toContain("TEST-ONLY");
        expect(isListPoint(pair.spki)).toBe(true);
      }
    }
  });
});

describe("a member's encryption key", () => {
  test("a device's key is a key of the list in its one spelling, and its private half cannot be exported", async () => {
    expect(isListKeyEncoding(alice.key)).toBe(true);
    expect(isListPoint(alice.key)).toBe(true);
    expect(alice.privateKey.extractable).toBe(false);
    expect(alice.privateKey.usages).toEqual(["deriveBits"]);
    for (const format of ["pkcs8", "jwk"] as const) expect(await refusal(() => crypto.subtle.exportKey(format, alice.privateKey))).toBeInstanceOf(Error);
  });

  test("a runtime that exports a public key otherwise than as a key of the list makes no key", async () => {
    const spki = crypto.subtle.exportKey.bind(crypto.subtle);
    const offCurve = spyOn(crypto.subtle, "exportKey").mockImplementation((async (format: KeyFormat, key: CryptoKey) => {
      const exported = await spki(format as "spki", key);
      return format === "spki" ? flipped(new Uint8Array(exported), 8 * 90).buffer : exported;
    }) as typeof crypto.subtle.exportKey);
    try {
      for (const make of [generateDeviceEncryptionKey, generateStoredEncryptionKey]) {
        const error = await refusal(make);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ListSealError);
      }
    } finally {
      offCurve.mockRestore();
    }
    expect(isListPoint((await generateDeviceEncryptionKey()).key)).toBe(true);
  });

  test("a stored key reads back to the same public key, cannot be exported once read, and opens what is wrapped to it", async () => {
    const made = await generateStoredEncryptionKey();
    const bytes = fromBase64Url(made.secret);
    expect(bytes.length).toBe(LIST_STORED_KEY_BYTES);
    expect(isListPoint(made.key)).toBe(true);
    const pc = await readStoredEncryptionKey(made.secret);
    expect(pc.key).toBe(made.key);
    expect(pc.privateKey.extractable).toBe(false);
    const epoch = newEpochKey(0);
    const opened = await openWrap({ list: LIST, epoch: 0, commitment: epochKeyCommitment({ list: LIST, epoch }), wrap: await wrapEpochKey({ list: LIST, epoch, member: made.key }), member: pc });
    expect(opened).toEqual({ open: true, value: epoch });
  });

  test("the stored form is the join line's PKCS8 form, whatever the runtime exports", async () => {
    const made = await generateStoredEncryptionKey();
    const pair = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(made.secret)), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair);
    expect(toBase64Url(concatBytes(SPKI_PREFIX, fromBase64Url(jwk.x ?? ""), fromBase64Url(jwk.y ?? "")))).toBe(made.key);
  });

  test("a key in the PKCS8 form of the list's other vectors reads as a stored key: an invite's line can carry the key its wraps open with", async () => {
    const vector = JSON.parse(readFileSync(join(import.meta.dir, "account-list-vectors", "envelope", "genesis-entry.json"), "utf8")) as { keys: Record<string, { pkcs8: string; spki: string }> };
    const pair = vector.keys["TEST-ONLY-owner"];
    if (!pair) throw new Error("no test key");
    const member = await readStoredEncryptionKey(pair.pkcs8);
    expect(member.key).toBe(pair.spki);
    const epoch = newEpochKey(2);
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: pair.spki });
    expect(await openWrap({ list: LIST, epoch: 2, commitment: epochKeyCommitment({ list: LIST, epoch }), wrap, member })).toEqual({ open: true, value: epoch });
  });

  test("a stored key that is not in its one form, or whose point is not its own, is refused without a byte of it in the message", async () => {
    const made = await generateStoredEncryptionKey();
    const bytes = fromBase64Url(made.secret);
    const otherPoint = fromBase64Url((await generateStoredEncryptionKey()).secret).subarray(74);
    const order = hexToBytes("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    const withScalar = (scalar: Uint8Array) => toBase64Url(concatBytes(bytes.subarray(0, 36), scalar, bytes.subarray(68)));
    const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(made.secret.at(-1) ?? "");
    const bad: [string, string][] = [
      ["a byte short", toBase64Url(bytes.subarray(0, 137))],
      ["a byte long", toBase64Url(concatBytes(bytes, Uint8Array.of(0)))],
      ["padded", `${made.secret.slice(0, -1)}=`],
      ["outside the alphabet", `${made.secret.slice(0, -1)}+`],
      ["another head", toBase64Url(flipped(bytes, 8 * 5))],
      ["another middle", toBase64Url(flipped(bytes, 8 * 70))],
      ["a zero private value", withScalar(new Uint8Array(32))],
      ["a private value of n", withScalar(order)],
      ["another key's point", toBase64Url(concatBytes(bytes.subarray(0, 74), otherPoint))],
      ["a point off the curve", toBase64Url(flipped(bytes, 8 * 137))],
      ["empty", ""],
    ];
    expect(last).toBeGreaterThanOrEqual(0);
    for (const [what, secret] of bad) {
      const error = await refusal(() => readStoredEncryptionKey(secret));
      expect(error, what).toBeInstanceOf(ListSealError);
      if (!(error instanceof ListSealError)) continue;
      expect(error.reason).toBe("secret");
      if (secret.length > 8) expect(error.message.includes(secret.slice(40, 60))).toBe(false);
    }
    expect(await refusal(() => readStoredEncryptionKey(undefined as never))).toBeInstanceOf(ListSealError);
  });
});

describe("a wrap", () => {
  const epoch = newEpochKey(4);
  const commitment = epochKeyCommitment({ list: LIST, epoch });

  test("opens for the member it was made for, to the key the list commits to", async () => {
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    expect(wrap?.length).toBe(LIST_WRAP_BYTES);
    expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap, member: alice })).toEqual({ open: true, value: epoch });
  });

  test("a wrap for one member does not open with another's key", async () => {
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap, member: bob })).toEqual({ open: false, why: "refused" });
    expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap, member: { key: alice.key, privateKey: bob.privateKey } })).toEqual({ open: false, why: "refused" });
    expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap, member: { key: bob.key, privateKey: alice.privateKey } })).toEqual({ open: false, why: "refused" });
  });

  test("it does not open for another list or another epoch", async () => {
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    expect(await openWrap({ list: OTHER_LIST, epoch: 4, commitment, wrap, member: alice })).toEqual({ open: false, why: "refused" });
    expect(await openWrap({ list: LIST, epoch: 5, commitment: epochKeyCommitment({ list: LIST, epoch: { epoch: 5, key: epoch.key } }), wrap, member: alice })).toEqual({ open: false, why: "refused" });
  });

  test("no single changed bit opens", async () => {
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    if (wrap === null) throw new Error("no wrap");
    const verdicts = new Set<string>();
    for (let bit = 0; bit < wrap.length * 8; bit += 1) verdicts.add(why(await openWrap({ list: LIST, epoch: 4, commitment, wrap: flipped(wrap, bit), member: alice })));
    expect([...verdicts].sort()).toEqual(["form", "refused"]);
  }, 60_000);

  test("another length is not a wrap", async () => {
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    if (wrap === null) throw new Error("no wrap");
    for (const bytes of [wrap.subarray(0, 112), concatBytes(wrap, Uint8Array.of(0)), new Uint8Array(0), concatBytes(wrap, wrap)]) {
      expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap: bytes, member: alice })).toEqual({ open: false, why: "form" });
    }
  });

  test("a key the list does not commit to is not taken: the service can wrap a key of its own to anyone", async () => {
    const services = newEpochKey(4);
    const wrap = await wrapEpochKey({ list: LIST, epoch: services, member: alice.key });
    expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap, member: alice })).toEqual({ open: false, why: "other_key" });
    expect(await openWrap({ list: LIST, epoch: 4, commitment: epochKeyCommitment({ list: LIST, epoch: services }), wrap, member: alice })).toEqual({ open: true, value: services });
  });

  test("the commitment is of the list, the epoch and the key: the same key in another list or epoch commits otherwise", () => {
    expect(epochKeyCommitment({ list: LIST, epoch })).toBe(reference.commitment(LIST, 4, epoch.key));
    expect(epochKeyCommitment({ list: LIST, epoch })).toBe(bytesToHex(sha256(concatBytes(utf8ToBytes("ovis-list-epoch-key/1"), hexToBytes(LIST), u64(4), epoch.key))));
    expect(epochKeyCommitment({ list: LIST, epoch: { epoch: 5, key: epoch.key } })).not.toBe(commitment);
    expect(epochKeyCommitment({ list: OTHER_LIST, epoch })).not.toBe(commitment);
    expect(epochKeyCommitment({ list: LIST, epoch: newEpochKey(4) })).not.toBe(commitment);
    for (const list of ["", "5C".repeat(32), "5c".repeat(31), undefined as never]) expect(() => epochKeyCommitment({ list, epoch })).toThrow(ListSealError);
    expect(() => epochKeyCommitment({ list: LIST, epoch: { epoch: 4, key: new Uint8Array(31) } })).toThrow(ListSealError);
  });

  test("a wrap of the right key does not pass a commitment made for another list or another epoch", async () => {
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    expect(await openWrap({ list: LIST, epoch: 4, commitment: epochKeyCommitment({ list: OTHER_LIST, epoch }), wrap, member: alice })).toEqual({ open: false, why: "other_key" });
    expect(await openWrap({ list: LIST, epoch: 4, commitment: epochKeyCommitment({ list: LIST, epoch: { epoch: 5, key: epoch.key } }), wrap, member: alice })).toEqual({ open: false, why: "other_key" });
  });

  test("epoch 0 is committed to before the list has an id: 32 zero bytes stand for it, whatever list is named", async () => {
    const first = newEpochKey(0);
    const atGenesis = epochKeyCommitment({ list: "", epoch: first });
    expect(atGenesis).toBe(bytesToHex(sha256(concatBytes(utf8ToBytes("ovis-list-epoch-key/1"), new Uint8Array(32), u64(0), first.key))));
    expect(epochKeyCommitment({ list: LIST, epoch: first })).toBe(atGenesis);
    expect(epochKeyCommitment({ list: OTHER_LIST, epoch: first })).toBe(atGenesis);
    const wrap = await wrapEpochKey({ list: LIST, epoch: first, member: alice.key });
    expect(await openWrap({ list: LIST, epoch: 0, commitment: atGenesis, wrap, member: alice })).toEqual({ open: true, value: first });
    const withList = bytesToHex(sha256(concatBytes(utf8ToBytes("ovis-list-epoch-key/1"), hexToBytes(LIST), u64(0), first.key)));
    expect(await openWrap({ list: LIST, epoch: 0, commitment: withList, wrap, member: alice })).toEqual({ open: false, why: "other_key" });
    const next = await nextEpoch({ list: LIST, current: first, members: [] });
    expect(next.commitment).toBe(epochKeyCommitment({ list: LIST, epoch: next.epoch }));
    expect(next.commitment).toBe(reference.commitment(LIST, 1, next.epoch.key));
    expect(await openLink({ list: LIST, from: next.epoch, link: next.link, commitment: atGenesis })).toEqual({ open: true, value: first });
  });

  test("two wraps of one key for one member share no ephemeral point and no ciphertext", async () => {
    const wraps = await Promise.all(Array.from({ length: 16 }, () => wrapEpochKey({ list: LIST, epoch, member: alice.key })));
    expect(new Set(wraps.map((wrap) => bytesToHex(wrap?.subarray(1, 65) ?? new Uint8Array(0)))).size).toBe(16);
    expect(new Set(wraps.map((wrap) => bytesToHex(wrap?.subarray(65) ?? new Uint8Array(0)))).size).toBe(16);
  });

  test("what another implementation wraps opens here, and what is wrapped here opens there", async () => {
    const stored = await generateStoredEncryptionKey();
    const member = await readStoredEncryptionKey(stored.secret);
    expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap: reference.wrap(LIST, epoch, member.key), member })).toEqual({ open: true, value: epoch });
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: member.key });
    if (wrap === null) throw new Error("no wrap");
    expect(reference.openWrap(LIST, 4, commitment, wrap, member.key, fromBase64Url(stored.secret))).toEqual({ key: bytesToHex(epoch.key) });
  });

  test("a member whose key is no point gets no wrap, and stops nobody else's", async () => {
    const offCurve = toBase64Url(flipped(fromBase64Url(alice.key), 8 * 90));
    expect(isListKeyEncoding(offCurve)).toBe(true);
    expect(await wrapEpochKey({ list: LIST, epoch, member: offCurve })).toBeNull();
    expect(await wrapEpochKey({ list: LIST, epoch, member: "not a key" })).toBeNull();
    const all = await wrapEpochKeyFor({ list: LIST, epoch, members: [alice.key, offCurve, bob.key, alice.key, ""] });
    expect(all.wraps.map((wrap) => wrap.member)).toEqual([alice.key, bob.key]);
    expect(all.unwrapped).toEqual([offCurve, ""]);
    for (const [index, member] of [alice, bob].entries()) {
      expect(await openWrap({ list: LIST, epoch: 4, commitment, wrap: all.wraps[index]?.wrap, member })).toEqual({ open: true, value: epoch });
    }
  });

  test("its text is 151 characters in their one spelling", async () => {
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    if (wrap === null) throw new Error("no wrap");
    const wire = wrapToText(wrap);
    expect(wire.length).toBe(LIST_WRAP_TEXT_LENGTH);
    expect(wrapFromText(wire)).toEqual(wrap);
    for (const bad of [`${wire}=`, wire.slice(0, -1), `${wire}A`, ` ${wire.slice(1)}`, `${wire.slice(0, -1)}\n`, wire.replace(/[-_A-Za-z0-9]$/, "+"), ""]) expect(wrapFromText(bad)).toBeNull();
    expect(wrapFromText(undefined as never)).toBeNull();
    expect(() => wrapToText(wrap.subarray(1))).toThrow(ListSealError);
  });

  test("making one refuses a list id or an epoch key that is not in form", async () => {
    for (const given of [
      { list: "5C".repeat(32), epoch, member: alice.key },
      { list: "", epoch, member: alice.key },
      { list: LIST, epoch: { epoch: 4, key: new Uint8Array(31) }, member: alice.key },
      { list: LIST, epoch: { epoch: -1, key: epoch.key }, member: alice.key },
      { list: LIST, epoch: { epoch: 1.5, key: epoch.key }, member: alice.key },
      { list: LIST, epoch: { epoch: 10 ** 15, key: epoch.key }, member: alice.key },
    ]) {
      const error = await refusal(() => wrapEpochKey(given));
      expect(error).toBeInstanceOf(ListSealError);
      expect(error instanceof ListSealError && error.reason).toBe("argument");
    }
  });
});

describe("the chain of epochs", () => {
  async function chain(length: number): Promise<{ keys: EpochKey[]; openings: Map<number, EpochOpening> }> {
    const keys = [newEpochKey(0)];
    const openings = new Map<number, EpochOpening>([[0, { commitment: epochKeyCommitment({ list: LIST, epoch: keys[0] as EpochKey }) }]]);
    for (let epoch = 1; epoch < length; epoch += 1) {
      const next = await nextEpoch({ list: LIST, current: keys[epoch - 1] as EpochKey, members: [] });
      keys.push(next.epoch);
      openings.set(epoch, { commitment: next.commitment, link: next.link });
    }
    return { keys, openings };
  }

  test("a link is 61 bytes and opens, with the key of its epoch, to the key before", async () => {
    const before = newEpochKey(6);
    const opened = newEpochKey(7);
    const link = await linkEpochs({ list: LIST, opened, previous: before });
    expect(link.length).toBe(LIST_EPOCH_LINK_BYTES);
    expect(await openLink({ list: LIST, from: opened, link, commitment: epochKeyCommitment({ list: LIST, epoch: before }) })).toEqual({ open: true, value: before });
    expect(reference.openLink(LIST, opened, epochKeyCommitment({ list: LIST, epoch: before }), link)).toEqual({ key: bytesToHex(before.key) });
    expect(await openLink({ list: LIST, from: opened, link: reference.link(LIST, opened, before.key), commitment: epochKeyCommitment({ list: LIST, epoch: before }) })).toEqual({ open: true, value: before });
  });

  test("a link does not open for another list, another epoch or another key, and no single changed bit opens", async () => {
    const before = newEpochKey(6);
    const opened = newEpochKey(7);
    const commitment = epochKeyCommitment({ list: LIST, epoch: before });
    const link = await linkEpochs({ list: LIST, opened, previous: before });
    expect(await openLink({ list: OTHER_LIST, from: opened, link, commitment })).toEqual({ open: false, why: "refused" });
    expect(await openLink({ list: LIST, from: { epoch: 8, key: opened.key }, link, commitment: epochKeyCommitment({ list: LIST, epoch: { epoch: 7, key: before.key } }) })).toEqual({ open: false, why: "refused" });
    expect(await openLink({ list: LIST, from: newEpochKey(7), link, commitment })).toEqual({ open: false, why: "refused" });
    expect(await openLink({ list: LIST, from: opened, link, commitment: epochKeyCommitment({ list: LIST, epoch: newEpochKey(6) }) })).toEqual({ open: false, why: "other_key" });
    const verdicts = new Set<string>();
    for (let bit = 0; bit < link.length * 8; bit += 1) verdicts.add(why(await openLink({ list: LIST, from: opened, link: flipped(link, bit), commitment })));
    expect([...verdicts].sort()).toEqual(["form", "refused"]);
    for (const bytes of [link.subarray(0, 60), concatBytes(link, Uint8Array.of(0))]) expect(await openLink({ list: LIST, from: opened, link: bytes, commitment })).toEqual({ open: false, why: "form" });
  });

  test("an epoch's key is never the key of the epoch before: no link is made between two epochs of one key, and none opens to the key it was opened with", async () => {
    const before = newEpochKey(6);
    const same: EpochKey = { epoch: 7, key: new Uint8Array(before.key) };
    const commitment = epochKeyCommitment({ list: LIST, epoch: before });
    // The writer: whoever was put out holds the key before, so the same key under the next number would let it read on.
    const refused = await refusal(() => linkEpochs({ list: LIST, opened: same, previous: before }));
    expect([refused instanceof ListSealError, (refused as ListSealError | null)?.reason]).toEqual([true, "argument"]);
    expect((await linkEpochs({ list: LIST, opened: newEpochKey(7), previous: before })).length).toBe(LIST_EPOCH_LINK_BYTES);
    // The reader: such a link, made by somebody else, opens and names the committed key; it is taken for no key all the same.
    const link = reference.link(LIST, same, before.key);
    expect(epochKeyCommitment({ list: LIST, epoch: same })).not.toBe(commitment);
    expect(await openLink({ list: LIST, from: same, link, commitment })).toEqual({ open: false, why: "other_key" });
    expect(reference.openLink(LIST, same, commitment, link)).toEqual({ why: "other_key" });
    // A walk stops there with what it reached.
    const { keys, openings } = await chain(4);
    const [k1, k3] = [keys[1] as EpochKey, keys[3] as EpochKey];
    const twin: EpochKey = { epoch: 2, key: new Uint8Array(k1.key) };
    openings.set(2, { commitment: epochKeyCommitment({ list: LIST, epoch: twin }), link: reference.link(LIST, twin, k1.key) });
    openings.set(3, { commitment: (openings.get(3) as EpochOpening).commitment, link: reference.link(LIST, k3, twin.key) });
    expect(await walkBack({ list: LIST, from: k3, openings })).toEqual({ keys: [k3, twin], stopped: { epoch: 1, why: "other_key" } });
    // nextEpoch never makes one: its key is new.
    const next = await nextEpoch({ list: LIST, current: before, members: [] });
    expect(bytesToHex(next.epoch.key)).not.toBe(bytesToHex(before.key));
  });

  test("a link goes one epoch back, and only from an epoch that has one before it", async () => {
    const bad = [
      { list: LIST, opened: newEpochKey(3), previous: newEpochKey(3) },
      { list: LIST, opened: newEpochKey(3), previous: newEpochKey(1) },
      { list: LIST, opened: newEpochKey(2), previous: newEpochKey(3) },
      { list: "", opened: newEpochKey(1), previous: newEpochKey(0) },
    ];
    for (const given of bad) expect(await refusal(() => linkEpochs(given))).toBeInstanceOf(ListSealError);
    const key = newEpochKey(0);
    expect(await openLink({ list: LIST, from: key, link: new Uint8Array(61), commitment: epochKeyCommitment({ list: LIST, epoch: key }) })).toEqual({ open: false, why: "form" });
  });

  test("walking back from the current key yields every earlier key", async () => {
    const { keys, openings } = await chain(12);
    const walk = await walkBack({ list: LIST, from: keys[11] as EpochKey, openings });
    expect(walk.stopped).toBeNull();
    expect(walk.keys).toEqual([...keys].reverse());
    const part = await walkBack({ list: LIST, from: keys[11] as EpochKey, to: 9, openings });
    expect(part).toEqual({ keys: [keys[11], keys[10], keys[9]] as EpochKey[], stopped: null });
    expect(await walkBack({ list: LIST, from: keys[0] as EpochKey, openings })).toEqual({ keys: [keys[0] as EpochKey], stopped: null });
  });

  test("the walk stops at the bound it was given, and walks on from the last key it reached", async () => {
    const { keys, openings } = await chain(12);
    const walk = await walkBack({ list: LIST, from: keys[11] as EpochKey, openings, max: 4 });
    expect(walk.keys).toEqual([keys[11], keys[10], keys[9], keys[8], keys[7]] as EpochKey[]);
    expect(walk.stopped).toEqual({ epoch: 6, why: "bound" });
    const on = await walkBack({ list: LIST, from: walk.keys.at(-1) as EpochKey, openings });
    expect(on).toEqual({ keys: [...keys.slice(0, 8)].reverse(), stopped: null });
    expect(await walkBack({ list: LIST, from: keys[11] as EpochKey, openings, max: 0 })).toEqual({ keys: [keys[11] as EpochKey], stopped: { epoch: 10, why: "bound" } });
  });

  test("no walk opens more than LIST_EPOCH_WALK_MAX links, whatever it is asked", async () => {
    const { keys, openings } = await chain(LIST_EPOCH_WALK_MAX + 3);
    const from = keys.at(-1) as EpochKey;
    for (const max of [undefined, LIST_EPOCH_WALK_MAX + 100, Number.MAX_SAFE_INTEGER, -1, Number.NaN]) {
      const walk = await walkBack({ list: LIST, from, openings, ...(max === undefined ? {} : { max }) });
      expect(walk.keys.length).toBe(LIST_EPOCH_WALK_MAX + 1);
      expect(walk.stopped).toEqual({ epoch: 1, why: "bound" });
    }
  }, 120_000);

  test("the walk stops where the list says nothing, where a link is missing and where one does not open, and keeps what it reached", async () => {
    const { keys, openings } = await chain(6);
    const from = keys[5] as EpochKey;
    const without = (epoch: number, opening?: EpochOpening) => {
      const changed = new Map(openings);
      if (opening) changed.set(epoch, opening);
      else changed.delete(epoch);
      return changed;
    };
    const reached = [keys[5], keys[4], keys[3]] as EpochKey[];
    const three = openings.get(3) as EpochOpening;
    const two = openings.get(2) as EpochOpening;
    expect(await walkBack({ list: LIST, from, openings: without(2) })).toEqual({ keys: reached, stopped: { epoch: 2, why: "missing" } });
    expect(await walkBack({ list: LIST, from, openings: without(3, { commitment: three.commitment }) })).toEqual({ keys: reached, stopped: { epoch: 2, why: "missing" } });
    expect(await walkBack({ list: LIST, from, openings: without(3, { commitment: three.commitment, link: null }) })).toEqual({ keys: reached, stopped: { epoch: 2, why: "missing" } });
    expect(await walkBack({ list: LIST, from, openings: without(3, { commitment: three.commitment, link: flipped(three.link as Uint8Array, 200) }) })).toEqual({ keys: reached, stopped: { epoch: 2, why: "refused" } });
    expect(await walkBack({ list: LIST, from, openings: without(3, { commitment: three.commitment, link: openings.get(4)?.link ?? null }) })).toEqual({ keys: reached, stopped: { epoch: 2, why: "refused" } });
    expect(await walkBack({ list: LIST, from, openings: without(2, { commitment: epochKeyCommitment({ list: LIST, epoch: newEpochKey(2) }), link: two.link ?? null }) })).toEqual({ keys: reached, stopped: { epoch: 2, why: "other_key" } });
    expect(await walkBack({ list: OTHER_LIST, from, openings })).toEqual({ keys: [], stopped: { epoch: 5, why: "other_key" } });
    expect(await walkBack({ list: LIST, from, to: 9, openings })).toEqual({ keys: [from], stopped: { epoch: 9, why: "missing" } });
    expect(await walkBack({ list: LIST, from: { epoch: 5, key: new Uint8Array(3) }, openings })).toEqual({ keys: [], stopped: { epoch: 0, why: "form" } });
  });

  test("every key a walk gives is one the list commits to, the key it starts from included", async () => {
    const { keys, openings } = await chain(4);
    const from = keys[3] as EpochKey;
    const notCommitted: EpochKey = { epoch: 3, key: newEpochKey(3).key };
    expect(await walkBack({ list: LIST, from: notCommitted, openings })).toEqual({ keys: [], stopped: { epoch: 3, why: "other_key" } });
    expect(await walkBack({ list: LIST, from: { epoch: 2, key: from.key }, openings })).toEqual({ keys: [], stopped: { epoch: 2, why: "other_key" } });
    const silent = new Map(openings);
    silent.delete(3);
    expect(await walkBack({ list: LIST, from, openings: silent })).toEqual({ keys: [], stopped: { epoch: 3, why: "missing" } });
    expect(await walkBack({ list: LIST, from, to: 3, openings: silent })).toEqual({ keys: [], stopped: { epoch: 3, why: "missing" } });
    expect(await walkBack({ list: LIST, from, openings: new Map(openings).set(3, { commitment: "not a hash", link: null }) })).toEqual({ keys: [], stopped: { epoch: 3, why: "form" } });
    expect(await walkBack({ list: "5C".repeat(32), from, openings })).toEqual({ keys: [], stopped: { epoch: 3, why: "form" } });
    expect((await walkBack({ list: LIST, from, to: 3, openings })).keys).toEqual([from]);
  });

  test("a walk never throws, whatever it is handed", async () => {
    const { keys, openings } = await chain(4);
    const from = keys[3] as EpochKey;
    const throwing = new Map(openings).set(1, { get commitment(): string { throw new Error("a getter that throws"); } });
    expect(await walkBack({ list: LIST, from, openings: throwing })).toEqual({ keys: [keys[3], keys[2]] as EpochKey[], stopped: { epoch: 1, why: "unavailable" } });
    const throwingFirst = new Map(openings).set(3, { get commitment(): string { throw new Error("a getter that throws"); } });
    expect(await walkBack({ list: LIST, from, openings: throwingFirst })).toEqual({ keys: [], stopped: { epoch: 3, why: "unavailable" } });
    for (const junk of [null, undefined, {}, 7, "text", [[0, null]]]) {
      const walk = await walkBack({ list: LIST, from, openings: junk as never });
      expect(walk.keys).toEqual([]);
      expect(walk.stopped?.why === "unavailable" || walk.stopped?.why === "missing").toBe(true);
    }
    expect(await walkBack(null as never)).toEqual({ keys: [], stopped: { epoch: 0, why: "unavailable" } });
    expect(await walkBack(undefined as never)).toEqual({ keys: [], stopped: { epoch: 0, why: "unavailable" } });
    expect(await walkBack({ list: LIST, from: null as never, openings })).toEqual({ keys: [], stopped: { epoch: 0, why: "form" } });
  });
});

describe("a sealed field", () => {
  const epoch = newEpochKey(2);
  const place = { list: LIST, seq: 7 };

  test("opens to its fields, in the order of their names, for its place and epoch", async () => {
    const sealed = await seal({ place, epoch, fields: [...NAMES].reverse() });
    const opened = await openSealed({ place, epoch, sealed });
    expect(opened.open && shown(opened.value)).toEqual(shown(NAMES));
    expect(sealed.length).toBe(LIST_SEALED_PAD_BYTES + LIST_SEALED_OVERHEAD);
    expect(sealed[0]).toBe(1);
  });

  test("does not open under another list, another seq or another epoch", async () => {
    const sealed = await seal({ place, epoch, fields: NAMES });
    expect(await openSealed({ place: { list: OTHER_LIST, seq: 7 }, epoch, sealed })).toEqual({ open: false, why: "refused" });
    expect(await openSealed({ place: { list: LIST, seq: 6 }, epoch, sealed })).toEqual({ open: false, why: "refused" });
    expect(await openSealed({ place: { list: LIST, seq: 8 }, epoch, sealed })).toEqual({ open: false, why: "refused" });
    expect(await openSealed({ place: { list: "", seq: 0 }, epoch: { epoch: 0, key: epoch.key }, sealed })).toEqual({ open: false, why: "refused" });
    expect(await openSealed({ place, epoch: { epoch: 3, key: epoch.key }, sealed })).toEqual({ open: false, why: "refused" });
    expect(await openSealed({ place, epoch: { epoch: 1, key: epoch.key }, sealed })).toEqual({ open: false, why: "refused" });
    expect(await openSealed({ place, epoch: newEpochKey(2), sealed })).toEqual({ open: false, why: "refused" });
  });

  test("entry 0 is sealed with no list id, and only entry 0", async () => {
    const first = newEpochKey(0);
    const sealed = await seal({ place: { list: "", seq: 0 }, epoch: first, fields: NAMES });
    const opened = await openSealed({ place: { list: "", seq: 0 }, epoch: first, sealed });
    expect(opened.open && shown(opened.value)).toEqual(shown(NAMES));
    expect(await openSealed({ place: { list: "00".repeat(32), seq: 1 }, epoch: first, sealed })).toEqual({ open: false, why: "refused" });
    for (const bad of [{ list: LIST, seq: 0 }, { list: "", seq: 1 }, { list: "5C".repeat(32), seq: 1 }, { list: LIST, seq: -1 }, { list: LIST, seq: 1.5 }, { list: LIST, seq: 10 ** 15 }]) {
      expect(await openSealed({ place: bad, epoch: first, sealed })).toEqual({ open: false, why: "form" });
      expect(await refusal(() => seal({ place: bad, epoch: first, fields: NAMES }))).toBeInstanceOf(ListSealError);
    }
  });

  test("entry 0 opens names from epoch 0 alone: the reader holds the writer's rule", async () => {
    const place0 = { list: "", seq: 0 };
    for (const number of [1, 2, 7]) {
      const key = newEpochKey(number);
      // What no writer here makes, made by somebody else: its tag holds for this place and this epoch.
      for (const plaintext of [utf8ToBytes(LIST_SEALED_PREFIX), writeFieldsUnder(LIST_SEALED_PREFIX, NAMES)]) {
        const sealed = reference.seal("", 0, key, plaintext);
        expect(await openSealed({ place: place0, epoch: key, sealed })).toEqual({ open: false, why: "form" });
        expect(reference.openSealed("", 0, key, sealed)).toEqual({ why: "form" });
      }
      const written = await refusal(() => seal({ place: place0, epoch: key, fields: NAMES }));
      expect(written instanceof ListSealError && written.reason).toBe("argument");
    }
    // The same bytes under epoch 0 are entry 0's names.
    const first = newEpochKey(0);
    const opened = await openSealed({ place: place0, epoch: first, sealed: reference.seal("", 0, first, writeFieldsUnder(LIST_SEALED_PREFIX, NAMES)) });
    expect(opened.open && shown(opened.value)).toEqual(shown(NAMES));
    expect(await openSealed({ place: place0, epoch: first, sealed: reference.seal("", 0, first, utf8ToBytes(LIST_SEALED_PREFIX)) })).toEqual({ open: true, value: [] });
  });

  test("no single changed bit opens", async () => {
    const sealed = await seal({ place, epoch, fields: [text("label", "Phone")] });
    const verdicts = new Set<string>();
    for (let bit = 0; bit < sealed.length * 8; bit += 1) verdicts.add(why(await openSealed({ place, epoch, sealed: flipped(sealed, bit) })));
    expect([...verdicts].sort()).toEqual(["form", "refused"]);
    for (const bytes of [sealed.subarray(0, sealed.length - 1), concatBytes(sealed, Uint8Array.of(0)), sealed.subarray(1)]) expect((await openSealed({ place, epoch, sealed: bytes })).open).toBe(false);
  });

  test("the nonce is random: sealing the same fields for the same place never gives the same bytes", async () => {
    const sealed = await Promise.all(Array.from({ length: 256 }, () => seal({ place, epoch, fields: NAMES })));
    expect(new Set(sealed.map((bytes) => bytesToHex(bytes.subarray(1, 13)))).size).toBe(256);
    expect(new Set(sealed.map((bytes) => bytesToHex(bytes.subarray(13)))).size).toBe(256);
  });

  test("what another implementation seals opens here, and what is sealed here opens there", async () => {
    const plaintext = writeFieldsUnder(LIST_SEALED_PREFIX, NAMES);
    const opened = await openSealed({ place, epoch, sealed: reference.seal(LIST, 7, epoch, plaintext) });
    expect(opened.open && shown(opened.value)).toEqual(shown(NAMES));
    expect(reference.openSealed(LIST, 7, epoch, await seal({ place, epoch, fields: NAMES }))).toEqual({ fields: shown(NAMES) as never });
  });

  test("a plaintext that is not fields under the sealed prefix opens to nothing", async () => {
    const cases = [
      writeFieldsUnder("ovis-list/1", NAMES),
      writeFieldsUnder(LIST_SEALED_PREFIX, NAMES).subarray(0, 40),
      concatBytes(writeFieldsUnder(LIST_SEALED_PREFIX, [text("os", "linux")]), writeFieldsUnder("", [text("label", "Phone")])),
      concatBytes(writeFieldsUnder(LIST_SEALED_PREFIX, NAMES), Uint8Array.of(0)),
      utf8ToBytes("ovis-list-sealed/2"),
    ];
    for (const plaintext of cases) expect(await openSealed({ place, epoch, sealed: reference.seal(LIST, 7, epoch, plaintext) })).toEqual({ open: false, why: "form" });
    const none = await openSealed({ place, epoch, sealed: reference.seal(LIST, 7, epoch, utf8ToBytes(LIST_SEALED_PREFIX)) });
    expect(none).toEqual({ open: true, value: [] });
  });

  test("sealing refuses fields that are not in form, are named pad or do not fit, and seals what just fits", async () => {
    const largest = Math.floor((LIST_BODY_MAX - LIST_SEALED_OVERHEAD) / LIST_SEALED_PAD_BYTES) * LIST_SEALED_PAD_BYTES;
    const room = largest - LIST_SEALED_PREFIX.length - (8 + "label".length) - (8 + "pad".length);
    const fits = await seal({ place, epoch, fields: [{ name: "label", value: new Uint8Array(room) }] });
    expect(fits.length).toBe(largest + LIST_SEALED_OVERHEAD);
    const opened = await openSealed({ place, epoch, sealed: fits });
    expect(opened.open && opened.value.map((field) => [field.name, field.value.length])).toEqual([["label", room]]);
    for (const fields of [
      [{ name: "label", value: new Uint8Array(room + 1) }],
      [text("Label", "Phone")],
      [text("label", "Phone"), text("label", "Laptop")],
      [text("", "Phone")],
      [text("label", "Phone"), text("pad", "")],
      [{ name: "pad", value: new Uint8Array(40) }],
    ]) {
      const error = await refusal(() => seal({ place, epoch, fields }));
      expect(error).toBeInstanceOf(ListSealError);
      expect(error instanceof ListSealError && error.reason).toBe("fields");
    }
    expect(await openSealed({ place, epoch, sealed: new Uint8Array(LIST_BODY_MAX + 1).fill(1) })).toEqual({ open: false, why: "form" });
  });

  test("every sealed plaintext is a multiple of 256 bytes, so its length says little of the names in it", async () => {
    const prefix = LIST_SEALED_PREFIX.length;
    const lengths = new Map<number, number>();
    for (const size of [0, 1, 5, 48, 200, 256 - prefix - 2 * 8 - "label".length - "pad".length, 256 - prefix - 2 * 8 - "label".length - "pad".length + 1, 300, 700]) {
      const sealed = await seal({ place, epoch, fields: [{ name: "label", value: new Uint8Array(size).fill(0x41) }] });
      lengths.set(size, sealed.length - LIST_SEALED_OVERHEAD);
      expect((sealed.length - LIST_SEALED_OVERHEAD) % LIST_SEALED_PAD_BYTES).toBe(0);
      const opened = await openSealed({ place, epoch, sealed });
      expect(opened.open && opened.value.map((field) => [field.name, field.value.length])).toEqual([["label", size]]);
    }
    expect([...lengths.values()]).toEqual([256, 256, 256, 256, 256, 256, 512, 512, 768]);
    expect((await seal({ place, epoch, fields: [] })).length).toBe(256 + LIST_SEALED_OVERHEAD);
    expect((await seal({ place, epoch, fields: NAMES })).length).toBe((await seal({ place, epoch, fields: [text("label", "A")] })).length);
  });

  test("the field that fills it is written in its place among the names, holds zero bytes, and no reader gives it back", async () => {
    const sealed = await seal({ place, epoch, fields: [text("zone", "home"), text("label", "Phone")] });
    const key = hkdf(sha256, epoch.key, new Uint8Array(32), utf8ToBytes("ovis-list-seal/1"), 32);
    const plaintext = gcm(key, sealed.subarray(1, 13), reference.sealedData(LIST, 7, 2)).decrypt(sealed.subarray(13));
    const fields = refFields(plaintext);
    expect(fields.map(([name]) => name)).toEqual(["label", "pad", "zone"]);
    expect(plaintext.length).toBe(256);
    expect(fields[1]?.[1]).toBe("\0".repeat(256 - 18 - (8 + 5 + 5) - (8 + 3) - (8 + 4 + 4)));
    const opened = await openSealed({ place, epoch, sealed });
    expect(opened.open && shown(opened.value)).toEqual([["label", "Phone"], ["zone", "home"]]);
    const filledOtherwise = writeFieldsUnder(LIST_SEALED_PREFIX, [text("label", "Phone"), text("pad", "not zero bytes")]);
    const other = await openSealed({ place, epoch, sealed: reference.seal(LIST, 7, epoch, filledOtherwise) });
    expect(other.open && shown(other.value)).toEqual([["label", "Phone"]]);
    const unfilled = await openSealed({ place, epoch, sealed: reference.seal(LIST, 7, epoch, writeFieldsUnder(LIST_SEALED_PREFIX, [text("label", "Phone")])) });
    expect(unfilled.open && shown(unfilled.value)).toEqual([["label", "Phone"]]);
  });

  test("nothing is sealed under a key the list does not commit to", async () => {
    const commitment = epochKeyCommitment({ list: LIST, epoch });
    expect((await sealFields({ place, epoch, commitment, fields: NAMES })).length).toBe(256 + LIST_SEALED_OVERHEAD);
    const others: [string, unknown][] = [
      ["another key's", epochKeyCommitment({ list: LIST, epoch: newEpochKey(2) })],
      ["another epoch's", epochKeyCommitment({ list: LIST, epoch: { epoch: 3, key: epoch.key } })],
      ["another list's", epochKeyCommitment({ list: OTHER_LIST, epoch })],
    ];
    for (const [what, other] of others) {
      const error = await refusal(() => sealFields({ place, epoch, commitment: other as string, fields: NAMES }));
      expect(error instanceof ListSealError && error.reason, what).toBe("other_key");
    }
    for (const junk of [undefined, null, "", "5C".repeat(32), commitment.slice(1), 7]) {
      const error = await refusal(() => sealFields({ place, epoch, commitment: junk as string, fields: NAMES }));
      expect(error instanceof ListSealError && error.reason).toBe("argument");
    }
    const first = newEpochKey(0);
    const atGenesis = epochKeyCommitment({ list: "", epoch: first });
    expect((await openSealed({ place: { list: "", seq: 0 }, epoch: first, sealed: await sealFields({ place: { list: "", seq: 0 }, epoch: first, commitment: atGenesis, fields: NAMES }) })).open).toBe(true);
    expect((await openSealed({ place, epoch: first, sealed: await sealFields({ place, epoch: first, commitment: atGenesis, fields: NAMES }) })).open).toBe(true);
    const later = await refusal(() => sealFields({ place: { list: "", seq: 0 }, epoch, commitment, fields: NAMES }));
    expect(later instanceof ListSealError && later.reason).toBe("argument");
  });
});

describe("a removal and an addition", () => {
  test("after a removal the member that left reads its removal and nothing sealed after it, and the others read on", async () => {
    const first = newEpochKey(0);
    const members = [alice, bob, carol];
    const before = await wrapEpochKeyFor({ list: LIST, epoch: first, members: members.map((member) => member.key) });
    const removal = await seal({ place: { list: LIST, seq: 5 }, epoch: first, fields: [text("label", "Carol's phone")] });
    const next = await nextEpoch({ list: LIST, current: first, members: [alice.key, bob.key] });
    const after = await seal({ place: { list: LIST, seq: 6 }, epoch: next.epoch, fields: [text("label", "New laptop")] });
    expect(next.epoch.epoch).toBe(1);
    expect(next.commitment).toBe(epochKeyCommitment({ list: LIST, epoch: next.epoch }));
    expect(next.wraps.map((wrap) => wrap.member)).toEqual([alice.key, bob.key]);
    expect(next.unwrapped).toEqual([]);

    const carolsWrap = before.wraps.find((wrap) => wrap.member === carol.key)?.wrap;
    const carolsKey = await openWrap({ list: LIST, epoch: 0, commitment: epochKeyCommitment({ list: LIST, epoch: first }), wrap: carolsWrap, member: carol });
    if (!carolsKey.open) throw new Error("Carol's wrap did not open");
    expect((await openSealed({ place: { list: LIST, seq: 5 }, epoch: carolsKey.value, sealed: removal })).open).toBe(true);
    expect(await openSealed({ place: { list: LIST, seq: 6 }, epoch: carolsKey.value, sealed: after })).toEqual({ open: false, why: "refused" });
    expect(await openSealed({ place: { list: LIST, seq: 6 }, epoch: { epoch: 1, key: carolsKey.value.key }, sealed: after })).toEqual({ open: false, why: "refused" });
    for (const { wrap } of next.wraps) expect(await openWrap({ list: LIST, epoch: 1, commitment: next.commitment, wrap, member: carol })).toEqual({ open: false, why: "refused" });
    expect(await openWrap({ list: LIST, epoch: 1, commitment: next.commitment, wrap: carolsWrap, member: carol })).toEqual({ open: false, why: "refused" });
    expect(await openLink({ list: LIST, from: { epoch: 1, key: carolsKey.value.key }, link: next.link, commitment: epochKeyCommitment({ list: LIST, epoch: first }) })).toEqual({ open: false, why: "refused" });

    for (const [index, member] of [alice, bob].entries()) {
      const opened = await openWrap({ list: LIST, epoch: 1, commitment: next.commitment, wrap: next.wraps[index]?.wrap, member });
      if (!opened.open) throw new Error("a member that stayed has no key");
      expect((await openSealed({ place: { list: LIST, seq: 6 }, epoch: opened.value, sealed: after })).open).toBe(true);
      const walk = await walkBack({ list: LIST, from: opened.value, openings: new Map([[0, { commitment: epochKeyCommitment({ list: LIST, epoch: first }) }], [1, { commitment: next.commitment, link: next.link }]]) });
      expect(walk).toEqual({ keys: [next.epoch, first], stopped: null });
    }
  });

  test("a member added later is given the current key and reads the whole history", async () => {
    const keys = [newEpochKey(0)];
    const openings = new Map<number, EpochOpening>([[0, { commitment: epochKeyCommitment({ list: LIST, epoch: keys[0] as EpochKey }) }]]);
    const sealed: Uint8Array[] = [await seal({ place: { list: "", seq: 0 }, epoch: keys[0] as EpochKey, fields: [text("label", "entry 0")] })];
    for (let seq = 1; seq <= 6; seq += 1) {
      const current = keys.at(-1) as EpochKey;
      sealed.push(await seal({ place: { list: LIST, seq }, epoch: current, fields: [text("label", `entry ${seq}`)] }));
      if (seq % 2 === 0) {
        const next = await nextEpoch({ list: LIST, current, members: [alice.key] });
        keys.push(next.epoch);
        openings.set(next.epoch.epoch, { commitment: next.commitment, link: next.link });
      }
    }
    const current = keys.at(-1) as EpochKey;
    const wrap = await wrapEpochKey({ list: LIST, epoch: current, member: bob.key });
    const given = await openWrap({ list: LIST, epoch: current.epoch, commitment: openings.get(current.epoch)?.commitment ?? "", wrap, member: bob });
    if (!given.open) throw new Error("the new member has no key");
    const walk = await walkBack({ list: LIST, from: given.value, openings });
    expect(walk.stopped).toBeNull();
    const byEpoch = new Map(walk.keys.map((key) => [key.epoch, key]));
    const labels: string[] = [];
    for (const [seq, bytes] of sealed.entries()) {
      const epoch = seq === 0 ? 0 : Math.floor((seq - 1) / 2);
      const opened = await openSealed({ place: { list: seq === 0 ? "" : LIST, seq }, epoch: byEpoch.get(epoch), sealed: bytes });
      labels.push(opened.open ? (shown(opened.value)[0]?.[1] ?? "") : opened.why);
    }
    expect(labels).toEqual(["entry 0", "entry 1", "entry 2", "entry 3", "entry 4", "entry 5", "entry 6"]);
  });
});

describe("what cannot be opened is a result, never a throw", () => {
  test("nothing given is `missing`", async () => {
    const epoch = newEpochKey(1);
    const commitment = epochKeyCommitment({ list: LIST, epoch });
    for (const nothing of [null, undefined]) {
      expect(await openWrap({ list: LIST, epoch: 1, commitment, wrap: nothing, member: alice })).toEqual({ open: false, why: "missing" });
      expect(await openLink({ list: LIST, from: epoch, link: nothing, commitment })).toEqual({ open: false, why: "missing" });
      expect(await openSealed({ place: { list: LIST, seq: 1 }, epoch, sealed: nothing })).toEqual({ open: false, why: "missing" });
      expect(await openSealed({ place: { list: LIST, seq: 1 }, epoch: nothing, sealed: new Uint8Array(64) })).toEqual({ open: false, why: "missing" });
    }
  });

  test("junk of every kind is closed, whatever is handed over", async () => {
    const epoch = newEpochKey(1);
    const commitment = epochKeyCommitment({ list: LIST, epoch });
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    const junk: unknown[] = [new Uint8Array(0), new Uint8Array(113), new Uint8Array(61), crypto.getRandomValues(new Uint8Array(113)), crypto.getRandomValues(new Uint8Array(300)), "text", 7, {}, [], Number.NaN];
    for (const value of junk) {
      const bytes = value as Uint8Array;
      expect((await openWrap({ list: LIST, epoch: 1, commitment, wrap: bytes, member: alice })).open).toBe(false);
      expect((await openLink({ list: LIST, from: epoch, link: bytes, commitment })).open).toBe(false);
      expect((await openSealed({ place: { list: LIST, seq: 1 }, epoch, sealed: bytes })).open).toBe(false);
      expect((await openSealed({ place: { list: LIST, seq: 1 }, epoch: value as EpochKey, sealed: new Uint8Array(64) })).open).toBe(false);
      expect((await openWrap({ list: value as string, epoch: 1, commitment, wrap, member: alice })).open).toBe(false);
      expect((await openWrap({ list: LIST, epoch: value as number, commitment, wrap, member: alice })).open).toBe(false);
      expect((await openWrap({ list: LIST, epoch: 1, commitment: value as string, wrap, member: alice })).open).toBe(false);
      expect((await openWrap({ list: LIST, epoch: 1, commitment, wrap, member: value as MemberEncryptionKey })).open).toBe(false);
      expect((await openWrap({ list: LIST, epoch: 1, commitment, wrap, member: { key: alice.key, privateKey: value as CryptoKey } })).open).toBe(false);
      expect((await openSealed({ place: value as { list: string; seq: number }, epoch, sealed: new Uint8Array(64) })).open).toBe(false);
    }
    expect((await openWrap(null as never)).open).toBe(false);
    expect((await openLink(null as never)).open).toBe(false);
    expect((await openSealed(null as never)).open).toBe(false);
  });

  test("only bytes of a length that can be the thing are read: an array of the right length is no bytes", async () => {
    const epoch = newEpochKey(1);
    const commitment = epochKeyCommitment({ list: LIST, epoch });
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    const sealed = await seal({ place: { list: LIST, seq: 1 }, epoch, fields: NAMES });
    expect(await openWrap({ list: LIST, epoch: 1, commitment, wrap: Array.from(wrap ?? []) as never, member: alice })).toEqual({ open: false, why: "form" });
    expect(await openSealed({ place: { list: LIST, seq: 1 }, epoch, sealed: Array.from(sealed) as never })).toEqual({ open: false, why: "form" });
    expect(await openLink({ list: LIST, from: epoch, link: Array.from(new Uint8Array(61)) as never, commitment })).toEqual({ open: false, why: "form" });
    let copied = 0;
    class Watched extends Uint8Array {
      override get length(): number {
        copied += 1;
        return super.length;
      }
    }
    const huge = new Watched(LIST_BODY_MAX + 1);
    copied = 0;
    expect(await openSealed({ place: { list: LIST, seq: 1 }, epoch, sealed: huge })).toEqual({ open: false, why: "form" });
    expect(copied).toBeLessThanOrEqual(2);
  });

  test("a key that signs instead of deriving opens nothing", async () => {
    const epoch = newEpochKey(1);
    const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const key = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", signing.publicKey)));
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: key });
    expect(await openWrap({ list: LIST, epoch: 1, commitment: epochKeyCommitment({ list: LIST, epoch }), wrap, member: { key, privateKey: signing.privateKey } })).toEqual({ open: false, why: "unavailable" });
  });

  test("a runtime whose WebCrypto fails says `unavailable` when opening, and throws when making", async () => {
    const epoch = newEpochKey(1);
    const commitment = epochKeyCommitment({ list: LIST, epoch });
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: alice.key });
    const sealed = await seal({ place: { list: LIST, seq: 1 }, epoch, fields: NAMES });
    const before = newEpochKey(0);
    const link = await linkEpochs({ list: LIST, opened: epoch, previous: before });
    const fault = new DOMException("The runtime failed", "NotSupportedError");
    const broken = spyOn(crypto.subtle, "importKey").mockRejectedValue(fault);
    try {
      expect(await openWrap({ list: LIST, epoch: 1, commitment, wrap, member: alice })).toEqual({ open: false, why: "unavailable" });
      expect(await openSealed({ place: { list: LIST, seq: 1 }, epoch, sealed })).toEqual({ open: false, why: "unavailable" });
      expect(await openLink({ list: LIST, from: epoch, link, commitment: epochKeyCommitment({ list: LIST, epoch: before }) })).toEqual({ open: false, why: "unavailable" });
      expect(await walkBack({ list: LIST, from: epoch, openings: new Map([[0, { commitment: epochKeyCommitment({ list: LIST, epoch: before }) }], [1, { commitment, link }]]) })).toEqual({ keys: [epoch], stopped: { epoch: 0, why: "unavailable" } });
      expect(await refusal(() => seal({ place: { list: LIST, seq: 1 }, epoch, fields: NAMES }))).toBe(fault);
      expect(await refusal(() => wrapEpochKey({ list: LIST, epoch, member: alice.key }))).toBe(fault);
    } finally {
      broken.mockRestore();
    }
    expect(await openWrap({ list: LIST, epoch: 1, commitment, wrap, member: alice })).toEqual({ open: true, value: epoch });
  });

  test("a failed tag is `refused`, and any other failure of the runtime's decrypt is not", async () => {
    const epoch = newEpochKey(1);
    const sealed = await seal({ place: { list: LIST, seq: 1 }, epoch, fields: NAMES });
    const broken = spyOn(crypto.subtle, "decrypt").mockRejectedValue(new DOMException("The runtime failed", "NotSupportedError"));
    try {
      expect(await openSealed({ place: { list: LIST, seq: 1 }, epoch, sealed })).toEqual({ open: false, why: "unavailable" });
    } finally {
      broken.mockRestore();
    }
    expect(await openSealed({ place: { list: LIST, seq: 2 }, epoch, sealed })).toEqual({ open: false, why: "refused" });
  });
});

describe("what is handed over is read once", () => {
  test("a key or bytes changed while the call runs change nothing of its result", async () => {
    const epoch = newEpochKey(3);
    const kept: EpochKey = { epoch: 3, key: new Uint8Array(epoch.key) };
    const place = { list: LIST, seq: 9 };
    const sealing = seal({ place, epoch, fields: NAMES });
    epoch.key.fill(0);
    const sealed = await sealing;
    expect((await openSealed({ place, epoch: kept, sealed })).open).toBe(true);

    const handed = new Uint8Array(sealed);
    const key: EpochKey = { epoch: 3, key: new Uint8Array(kept.key) };
    const reading = openSealed({ place, epoch: key, sealed: handed });
    handed.fill(0);
    key.key.fill(0);
    expect((await reading).open).toBe(true);

    const wrapKey: EpochKey = { epoch: 3, key: new Uint8Array(kept.key) };
    const wrapping = wrapEpochKey({ list: LIST, epoch: wrapKey, member: alice.key });
    wrapKey.key.fill(0);
    const wrap = await wrapping;
    if (wrap === null) throw new Error("no wrap");
    const wrapHanded = new Uint8Array(wrap);
    const opening = openWrap({ list: LIST, epoch: 3, commitment: epochKeyCommitment({ list: LIST, epoch: kept }), wrap: wrapHanded, member: alice });
    wrapHanded.fill(0);
    expect(await opening).toEqual({ open: true, value: kept });
  });

  test("a batch of wraps is of one key, one list and one set of members, whatever the caller does while it is made", async () => {
    const epoch: { epoch: number; key: Uint8Array } = { epoch: 3, key: newEpochKey(3).key };
    const kept: EpochKey = { epoch: 3, key: new Uint8Array(epoch.key) };
    const commitment = epochKeyCommitment({ list: LIST, epoch: kept });
    const members = [alice.key, bob.key];
    const given: { list: string; epoch: EpochKey; members: string[] } = { list: LIST, epoch, members };
    const wrapping = wrapEpochKeyFor(given);
    epoch.key.fill(0);
    epoch.epoch = 9;
    members.push(carol.key);
    given.list = OTHER_LIST;
    given.epoch = newEpochKey(3);
    given.members = [carol.key];
    const made = await wrapping;
    expect(made.wraps.map((wrap) => wrap.member)).toEqual([alice.key, bob.key]);
    for (const [index, member] of [alice, bob].entries()) {
      expect(await openWrap({ list: LIST, epoch: 3, commitment, wrap: made.wraps[index]?.wrap, member })).toEqual({ open: true, value: kept });
    }
  });

  test("a batch for nobody still refuses a list or a key that is not in form", async () => {
    expect(await wrapEpochKeyFor({ list: LIST, epoch: newEpochKey(1), members: [] })).toEqual({ wraps: [], unwrapped: [] });
    for (const given of [{ list: "", epoch: newEpochKey(1), members: [] }, { list: LIST, epoch: { epoch: 1, key: new Uint8Array(31) }, members: [] }, { list: LIST, epoch: newEpochKey(1), members: null as never }]) {
      const error = await refusal(() => wrapEpochKeyFor(given));
      expect(error instanceof ListSealError && error.reason).toBe("argument");
    }
  });

  test("the next epoch is wrapped to the members that stayed when it was asked for: a member put back into the array meanwhile gets nothing", async () => {
    const current = newEpochKey(0);
    const kept: EpochKey = { epoch: 0, key: new Uint8Array(current.key) };
    const staying = [alice.key, bob.key];
    const given = { list: LIST, current, members: staying };
    const making = nextEpoch(given);
    staying.push(carol.key);
    current.key.fill(0);
    given.members = [carol.key];
    given.list = OTHER_LIST;
    const next = await making;
    expect(next.wraps.map((wrap) => wrap.member)).toEqual([alice.key, bob.key]);
    expect(next.unwrapped).toEqual([]);
    expect(next.commitment).toBe(epochKeyCommitment({ list: LIST, epoch: next.epoch }));
    for (const { wrap } of next.wraps) expect(await openWrap({ list: LIST, epoch: 1, commitment: next.commitment, wrap, member: carol })).toEqual({ open: false, why: "refused" });
    for (const [index, member] of [alice, bob].entries()) {
      expect(await openWrap({ list: LIST, epoch: 1, commitment: next.commitment, wrap: next.wraps[index]?.wrap, member })).toEqual({ open: true, value: next.epoch });
    }
    expect(await openLink({ list: LIST, from: next.epoch, link: next.link, commitment: epochKeyCommitment({ list: LIST, epoch: kept }) })).toEqual({ open: true, value: kept });
  });

  test("a link and the fields of a sealed field are of what was handed over, not of what the caller made of it meanwhile", async () => {
    const opened = newEpochKey(2);
    const previous = newEpochKey(1);
    const keptOpened: EpochKey = { epoch: 2, key: new Uint8Array(opened.key) };
    const keptPrevious: EpochKey = { epoch: 1, key: new Uint8Array(previous.key) };
    const linkGiven = { list: LIST, opened, previous };
    const linking = linkEpochs(linkGiven);
    opened.key.fill(0);
    previous.key.fill(0);
    linkGiven.list = OTHER_LIST;
    const link = await linking;
    const commitment = epochKeyCommitment({ list: LIST, epoch: keptPrevious });
    const handed = new Uint8Array(link);
    const from: EpochKey = { epoch: 2, key: new Uint8Array(keptOpened.key) };
    const openGiven = { list: LIST, from, link: handed, commitment };
    const reading = openLink(openGiven);
    handed.fill(0);
    from.key.fill(0);
    openGiven.list = OTHER_LIST;
    expect(await reading).toEqual({ open: true, value: keptPrevious });

    const value = utf8ToBytes("Home laptop");
    const fields: ListField[] = [{ name: "label", value }];
    const place = { list: LIST, seq: 4 };
    const sealGiven = { place, epoch: keptOpened, commitment: epochKeyCommitment({ list: LIST, epoch: keptOpened }), fields };
    const sealing = sealFields(sealGiven);
    value.fill(0x58);
    fields.push(text("os", "linux"));
    place.seq = 5;
    sealGiven.fields = [];
    const sealed = await sealing;
    const read = await openSealed({ place: { list: LIST, seq: 4 }, epoch: keptOpened, sealed });
    expect(read.open && shown(read.value)).toEqual([["label", "Home laptop"]]);
    const notBytes = await refusal(() => sealFields({ place: { list: LIST, seq: 4 }, epoch: keptOpened, commitment: epochKeyCommitment({ list: LIST, epoch: keptOpened }), fields: [{ name: "label", value: 4096 as never }] }));
    expect(notBytes instanceof ListSealError && notBytes.reason).toBe("fields");
  });

  test("a walk reads what the list says once, before it opens anything: a map emptied or changed meanwhile changes nothing", async () => {
    const keys = [newEpochKey(0)];
    const openings = new Map<number, { commitment: string; link?: Uint8Array | null }>([[0, { commitment: epochKeyCommitment({ list: LIST, epoch: keys[0] as EpochKey }) }]]);
    for (let epoch = 1; epoch < 5; epoch += 1) {
      const next = await nextEpoch({ list: LIST, current: keys[epoch - 1] as EpochKey, members: [] });
      keys.push(next.epoch);
      openings.set(epoch, { commitment: next.commitment, link: next.link });
    }
    const from: EpochKey = { epoch: 4, key: new Uint8Array((keys[4] as EpochKey).key) };
    const given = { list: LIST, from, openings };
    const walking = walkBack(given);
    for (const opening of openings.values()) {
      opening.link?.fill(0);
      opening.commitment = "00".repeat(32);
    }
    openings.clear();
    from.key.fill(0);
    given.list = OTHER_LIST;
    expect(await walking).toEqual({ keys: [...keys].reverse(), stopped: null });
  });

  test("a walk takes anything that answers as a ReadonlyMap does, and asks it only for the epochs it walks", async () => {
    const keys = [newEpochKey(0)];
    const inner = new Map<number, EpochOpening>([[0, { commitment: epochKeyCommitment({ list: LIST, epoch: keys[0] as EpochKey }) }]]);
    for (let epoch = 1; epoch < 6; epoch += 1) {
      const next = await nextEpoch({ list: LIST, current: keys[epoch - 1] as EpochKey, members: [] });
      keys.push(next.epoch);
      inner.set(epoch, { commitment: next.commitment, link: next.link });
    }
    const asked: number[] = [];
    /** A read-only view that is no Map: it has no way to be written, and nothing of Map.prototype works on it. */
    class ReadOnly implements ReadonlyMap<number, EpochOpening> {
      get size(): number { return inner.size; }
      get(epoch: number): EpochOpening | undefined { asked.push(epoch); return inner.get(epoch); }
      has(epoch: number): boolean { return inner.has(epoch); }
      forEach(run: (value: EpochOpening, key: number, map: ReadonlyMap<number, EpochOpening>) => void): void { inner.forEach((value, key) => run(value, key, this)); }
      entries() { return inner.entries(); }
      keys() { return inner.keys(); }
      values() { return inner.values(); }
      [Symbol.iterator]() { return inner[Symbol.iterator](); }
    }
    const view = new ReadOnly();
    expect(view instanceof Map).toBe(false);
    expect(await walkBack({ list: LIST, from: keys[5] as EpochKey, openings: view })).toEqual({ keys: [...keys].reverse(), stopped: null });
    asked.length = 0;
    expect(await walkBack({ list: LIST, from: keys[5] as EpochKey, to: 3, openings: view })).toEqual({ keys: [keys[5], keys[4], keys[3]] as EpochKey[], stopped: null });
    expect([...new Set(asked)].sort()).toEqual([3, 4, 5]);
    const onlyGet = { get: (epoch: number) => inner.get(epoch) } as unknown as ReadonlyMap<number, EpochOpening>;
    expect(await walkBack({ list: LIST, from: keys[5] as EpochKey, openings: onlyGet })).toEqual({ keys: [...keys].reverse(), stopped: null });
    const frozen = Object.freeze(new Map(inner));
    expect(await walkBack({ list: LIST, from: keys[5] as EpochKey, openings: frozen })).toEqual({ keys: [...keys].reverse(), stopped: null });
  });

  test("the key a join line gives opens a wrap made to the invite's key, and signs nothing", async () => {
    const service = "https://accounts.ovis.test";
    const invite = await newInvite(service, "TEST-ONLY-account", LIST);
    const line = await readJoinLine(invite.line, { service, followsLists: true });
    expect(line.key).toBe(invite.key);
    expect(line.encryptionKey.extractable).toBe(false);
    expect(line.encryptionKey.usages).toEqual(["deriveBits"]);
    const epoch = newEpochKey(2);
    const commitment = epochKeyCommitment({ list: LIST, epoch });
    const wrap = await wrapEpochKey({ list: LIST, epoch, member: invite.key });
    expect(await openWrap({ list: LIST, epoch: 2, commitment, wrap, member: { key: line.key, privateKey: line.encryptionKey } })).toEqual({ open: true, value: epoch });
    expect(await openWrap({ list: LIST, epoch: 2, commitment, wrap, member: { key: alice.key, privateKey: line.encryptionKey } })).toEqual({ open: false, why: "refused" });
  });
});
