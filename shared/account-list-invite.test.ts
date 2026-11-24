import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INVITE_MAKE_PREFIX, INVITE_REDEEM_PREFIX, INVITE_SIGNATURE_CHARS, InviteRedeemError, LINE_CHALLENGE_PREFIX, LINE_PROOF_PREFIX, inviteMakeBytes, inviteRedeemBytes, isAccountId, lineChallenge, lineProofBytes,
  signInviteRedeem, verifyInviteRedeem, verifyLineProof, type InviteMake, type InviteRedeem,
} from "./account-list-invite.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { cardBinding } from "./account-list.ts";
import { isListKeyEncoding, isListPoint, verifySignature } from "./account-list-entry.ts";
import { newInvite, readJoinLine } from "./account-list-join.ts";
import { pcAddSigningBytes, type PcAddPurpose } from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const SERVICE = "https://accounts.ovis.test";
const DIR = join(import.meta.dir, "account-list-vectors", "invite");
const READER = { service: SERVICE, followsLists: true };

interface KeyPair { readonly pkcs8: string; readonly spki: string }
interface InviteVector {
  readonly name: string;
  readonly keys: Readonly<Record<string, KeyPair>>;
  readonly line: string;
  readonly key: string;
  readonly redeem: InviteRedeem;
  readonly bytes?: string;
  readonly bytes_hex?: string;
  readonly signature: string;
  readonly expect: { readonly verifies: boolean };
}
interface MakeVector {
  readonly name: string;
  readonly keys: Readonly<Record<string, KeyPair>>;
  readonly make: InviteMake;
  readonly device_key: string;
  readonly bytes: string;
  readonly bytes_hex: string;
  readonly signature: string;
  readonly expect: { readonly verifies: boolean };
}
interface LineChallengeVector {
  readonly name: string;
  readonly list: string;
  readonly card: { readonly key: string; readonly enc: string; readonly endpoint: string };
  readonly binding_hex: string;
  readonly challenge: string;
}
interface LineProofVector extends LineChallengeVector {
  readonly keys: Readonly<Record<string, KeyPair>>;
  readonly key: string;
  readonly account: string;
  readonly server_id: string;
  readonly bytes_hex: string;
  readonly signature: string;
  readonly expect: { readonly verifies: boolean };
}
const files = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as InviteVector | MakeVector | LineChallengeVector | LineProofVector);
const proofs = files.filter((vector): vector is LineProofVector => "card" in vector && "account" in vector);
const challenges = files.filter((vector): vector is LineChallengeVector => "challenge" in vector && "card" in vector && !("account" in vector));
const vectors = files.filter((vector): vector is InviteVector => "redeem" in vector);
const makes = files.filter((vector): vector is MakeVector => "make" in vector);
const good = vectors.find((vector) => vector.name === "redeem");
if (!good) throw new Error("invite/redeem.json is missing");
const REDEEM = good.redeem;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
/** The bytes as this test writes them, with no part of the file under test: the tag, then each value after its length. */
function written(values: readonly string[]): Uint8Array {
  const parts: number[] = [...Buffer.from("ovis-invite-redeem/1", "ascii")];
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    parts.push((bytes.length >>> 24) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff, ...bytes);
  }
  return Uint8Array.from(parts);
}
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const malformed = (run: () => unknown): string | null => {
  try {
    run();
  } catch (error) {
    if (error instanceof InviteRedeemError) return error.code;
    throw error;
  }
  return null;
};

describe("the vectors of invite/", () => {
  test("names: one redeem proof that verifies, its high-s twin, and each way one does not, none missing", () => {
    expect(vectors.map((vector) => vector.name)).toEqual(["redeem-high-s", "redeem-key-off-curve", "redeem-key-second-spelling", "redeem-other-account", "redeem-other-challenge",
      "redeem-other-key", "redeem-other-relay-key", "redeem-other-server", "redeem-r-n", "redeem-r-zero", "redeem-s-n", "redeem-s-zero", "redeem-server-id-uppercase", "redeem-signature-85",
      "redeem-signature-padded", "redeem-signature-second-spelling", "redeem"]);
    expect(makes.map((vector) => vector.name)).toEqual(["make-proof-auto", "make-proof"]);
    // Every vector whose values are in form carries the bytes they give, and the accounts among them are of more than one length.
    expect(vectors.filter((vector) => vector.bytes === undefined).map((vector) => vector.name)).toEqual(["redeem-server-id-uppercase"]);
    expect([...new Set(vectors.map((vector) => vector.redeem.account.length))].sort()).toEqual([17, 23]);
    expect(vectors.filter((vector) => vector.expect.verifies).map((vector) => vector.name)).toEqual(["redeem-high-s", "redeem"]);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      // The key is the one the line reads to: a machine sends what it derived, and the service looks the invite up by it.
      expect((await readJoinLine(vector.line, READER)).key).toBe((vector as { key_of_line?: string }).key_of_line ?? vector.key);
      if (vector.bytes !== undefined) {
        const bytes = inviteRedeemBytes(vector.redeem);
        expect(toBase64Url(bytes)).toBe(vector.bytes);
        expect(hex(bytes)).toBe(vector.bytes_hex ?? "");
      }
      expect(await verifyInviteRedeem(vector.redeem, vector.signature, vector.key)).toBe(vector.expect.verifies);
    });
  }

  test("the high-s vector is the good one with s replaced by n-s: one proof has two signatures, and both count", () => {
    const high = vectors.find((vector) => vector.name === "redeem-high-s");
    if (!high) throw new Error("no redeem-high-s");
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const [low, other] = [fromBase64Url(good.signature), fromBase64Url(high.signature)];
    expect(hex(other.subarray(0, 32))).toBe(hex(low.subarray(0, 32)));
    expect(BigInt(`0x${hex(other.subarray(32))}`)).toBe(N - BigInt(`0x${hex(low.subarray(32))}`));
    expect(BigInt(`0x${hex(other.subarray(32))}`) > N / 2n).toBe(true);
  });
});

describe("the bytes a redeem signature is over", () => {
  test("the tag, then account, server_id, public_key and challenge_id, each after its length in 4 bytes", () => {
    expect(INVITE_REDEEM_PREFIX).toBe("ovis-invite-redeem/1");
    expect(hex(inviteRedeemBytes(REDEEM))).toBe(hex(written([REDEEM.account, REDEEM.server_id, REDEEM.public_key, REDEEM.challenge_id])));
    for (let index = 0; index < 50; index++) {
      const redeem = { account: `a${randomHex(index % 32)}`.slice(0, 1 + (index % 64)), server_id: randomHex(16), public_key: randomHex(32), challenge_id: randomHex(16) };
      const bytes = inviteRedeemBytes(redeem);
      expect(hex(bytes)).toBe(hex(written([redeem.account, redeem.server_id, redeem.public_key, redeem.challenge_id])));
      expect(bytes.length).toBe(20 + 4 * 4 + redeem.account.length + 32 + 64 + 32);
    }
  });

  test("the caller's object is read once: a getter that answers otherwise the second time changes nothing", () => {
    let reads = 0;
    const redeem = { ...REDEEM, get account() { reads++; return reads === 1 ? REDEEM.account : "other"; } };
    expect(hex(inviteRedeemBytes(redeem))).toBe(good.bytes_hex ?? "");
    expect(reads).toBe(1);
  });

  test("a value out of its form is refused, so no other bytes are ever signed or checked", () => {
    const cases: Partial<Record<keyof InviteRedeem, readonly unknown[]>> = {
      account: ["", "a".repeat(65), "a.b", "a b", "계정", 1, null, undefined],
      server_id: ["", REDEEM.server_id.slice(1), `${REDEEM.server_id}0`, REDEEM.server_id.toUpperCase(), `${REDEEM.server_id.slice(1)}g`, 1, null],
      public_key: ["", REDEEM.public_key.slice(1), `${REDEEM.public_key}0`, REDEEM.public_key.toUpperCase(), REDEEM.server_id, 1, null],
      challenge_id: ["", REDEEM.challenge_id.slice(1), `${REDEEM.challenge_id}0`, REDEEM.challenge_id.toUpperCase(), `${REDEEM.challenge_id}\n`, 1, null],
    };
    for (const [name, values] of Object.entries(cases)) {
      for (const value of values) {
        expect({ name, value, code: malformed(() => inviteRedeemBytes({ ...REDEEM, [name]: value } as InviteRedeem)) }).toEqual({ name, value, code: "redeem_malformed" });
      }
    }
    expect(malformed(() => inviteRedeemBytes(REDEEM))).toBeNull();
  });
});

describe("signing and checking a redeem", () => {
  test("the key a line carries signs, and only its public key verifies, for exactly the values it signed", async () => {
    const invite = await newInvite(SERVICE, REDEEM.account, null);
    const line = await readJoinLine(invite.line, READER);
    const { account: _account, ...machine } = REDEEM;
    const signature = await signInviteRedeem(line, machine);
    expect(signature.length).toBe(INVITE_SIGNATURE_CHARS);
    expect(await verifyInviteRedeem(REDEEM, signature, invite.key)).toBe(true);
    // Another invite's key, and each value changed by one character.
    expect(await verifyInviteRedeem(REDEEM, signature, good.key)).toBe(false);
    const flip = (text: string) => `${text.slice(0, -1)}${text.endsWith("0") ? "1" : "0"}`;
    for (const name of ["account", "server_id", "public_key", "challenge_id"] as const) {
      expect({ name, verifies: await verifyInviteRedeem({ ...REDEEM, [name]: flip(REDEEM[name]) }, signature, invite.key) }).toEqual({ name, verifies: false });
    }
    // Two values swapped where their forms allow it: the place of a value is signed too.
    expect(await verifyInviteRedeem({ ...REDEEM, server_id: REDEEM.challenge_id, challenge_id: REDEEM.server_id }, signature, invite.key)).toBe(false);
  });

  test("a signature made over other bytes with the same key is no redeem signature", async () => {
    // No line that was read signs what a caller composes: this is the fixture's private key, which only a test holds.
    const privateKey = await crypto.subtle.importKey("pkcs8", fromBase64Url(good.keys["TEST-ONLY-invite"]?.pkcs8 ?? "") as Uint8Array<ArrayBuffer>, P256, false, ["sign"]);
    const sign = async (bytes: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, new Uint8Array(bytes))));
    const bytes = inviteRedeemBytes(REDEEM);
    expect(await verifyInviteRedeem(REDEEM, await sign(bytes), good.key)).toBe(true);
    // The values with no tag, with another tag, and with a tag that only starts the same.
    expect(await verifyInviteRedeem(REDEEM, await sign(bytes.subarray(INVITE_REDEEM_PREFIX.length)), good.key)).toBe(false);
    for (const tag of ["ovis-pc-add/1", "ovis-list/1", "ovis-invite-redeem/2", "ovis-invite-redeem/10"]) {
      const other = Uint8Array.from([...Buffer.from(tag, "ascii"), ...bytes.subarray(INVITE_REDEEM_PREFIX.length)]);
      expect({ tag, verifies: await verifyInviteRedeem(REDEEM, await sign(other), good.key) }).toEqual({ tag, verifies: false });
    }
  });

  test("checking never throws for what a request may hold: it is false", async () => {
    const signature = good.signature;
    for (const other of [undefined, null, 1, "", signature.slice(1), `${signature}A`, `${signature.slice(0, -1)}=`, `${signature.slice(0, -1)}+`, ` ${signature.slice(1)}`, [signature]]) {
      expect({ other, verifies: await verifyInviteRedeem(REDEEM, other, good.key) }).toEqual({ other, verifies: false });
    }
    for (const key of [undefined, null, 1, "", good.key.slice(1), `${good.key}A`, good.keys["TEST-ONLY-invite"]?.pkcs8, [good.key]]) {
      expect({ key, verifies: await verifyInviteRedeem(REDEEM, signature, key) }).toEqual({ key, verifies: false });
    }
    for (const redeem of [{ ...REDEEM, account: "" }, { ...REDEEM, server_id: "x" }, { ...REDEEM, public_key: REDEEM.server_id }, { ...REDEEM, challenge_id: undefined }, null, undefined, 1, "x", []]) {
      expect(await verifyInviteRedeem(redeem as InviteRedeem, signature, good.key)).toBe(false);
    }
    for (const redeem of [null, undefined, 1]) expect(malformed(() => inviteRedeemBytes(redeem as unknown as InviteRedeem))).toBe("redeem_malformed");
  });

  test("a key whose point is not on the curve verifies nothing, and is told apart from a key before any invite is stored", async () => {
    // The good key with its Y changed: a key in its one spelling that names no point.
    const bytes = fromBase64Url(good.key);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const offCurve = toBase64Url(bytes);
    expect(isListKeyEncoding(offCurve)).toBe(true);
    expect(isListPoint(offCurve)).toBe(false);
    expect(await verifyInviteRedeem(REDEEM, good.signature, offCurve)).toBe(false);
    expect(isListKeyEncoding(good.key) && isListPoint(good.key)).toBe(true);
  });

  test("signing refuses values out of their form before it asks the key for anything", async () => {
    const line = await readJoinLine(good.line, READER);
    for (const bad of [{ server_id: "nope" }, { public_key: "nope" }, { challenge_id: "nope" }, { challenge_id: REDEEM.challenge_id.toUpperCase() }]) {
      const refused = await signInviteRedeem(line, { ...REDEEM, ...bad }).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(InviteRedeemError);
    }
  });

  test("the account a redeem is signed for is the line's: a caller names only the machine and the challenge", async () => {
    const line = await readJoinLine(good.line, READER);
    const signature = await signInviteRedeem(line, { ...REDEEM, account: "TEST-ONLY-other-account" } as Omit<InviteRedeem, "account">);
    expect([await verifyInviteRedeem(REDEEM, signature, good.key), await verifyInviteRedeem({ ...REDEEM, account: "TEST-ONLY-other-account" }, signature, good.key)]).toEqual([true, false]);
  });
});

describe("what a device signs to make an invite", () => {
  const MAKE = makes.find((vector) => vector.name === "make-proof")?.make;
  if (!MAKE) throw new Error("invite/make-proof.json is missing");

  for (const vector of makes) {
    test(vector.name, async () => {
      const bytes = inviteMakeBytes(vector.make);
      expect([toBase64Url(bytes), hex(bytes)]).toEqual([vector.bytes, vector.bytes_hex]);
      expect(await verifySignature(bytes, fromBase64Url(vector.signature), vector.device_key)).toBe(vector.expect.verifies);
      // The invite's key in it is the key the vector's line reads to.
      expect((await readJoinLine(good.line, READER)).key).toBe(vector.make.invite_key);
    });
  }

  test("it is the key proof for adding a PC, with the invite's public key where a listing id stands otherwise", () => {
    expect(INVITE_MAKE_PREFIX).toBe("ovis-pc-add/1");
    for (const auto of [false, true]) {
      const purpose = (auto ? "invite-auto" : "invite") as PcAddPurpose;
      expect(hex(inviteMakeBytes({ ...MAKE, auto }))).toBe(hex(pcAddSigningBytes(purpose, MAKE.account, "", MAKE.invite_key, MAKE.challenge_id, MAKE.challenge)));
    }
    expect(hex(inviteMakeBytes({ ...MAKE, auto: true }))).not.toBe(hex(inviteMakeBytes(MAKE)));
  });

  test("a proof made for one invite is none for another key, account or challenge", () => {
    const other = good.keys["TEST-ONLY-invite"]?.spki === MAKE.invite_key ? (makes[0]?.device_key ?? "") : "";
    const changed: Partial<InviteMake>[] = [{ invite_key: other }, { account: "TEST-ONLY-other-account" }, { challenge_id: "0".repeat(32) }, { challenge: `${MAKE.challenge}x` }, { auto: !MAKE.auto }];
    const bytes = new Set(changed.map((change) => hex(inviteMakeBytes({ ...MAKE, ...change }))));
    expect([bytes.size, bytes.has(hex(inviteMakeBytes(MAKE)))]).toEqual([5, false]);
  });

  test("a value out of its form is refused, an invite key off the curve among them", () => {
    const bytes = fromBase64Url(MAKE.invite_key);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    for (const bad of [{ account: "" }, { invite_key: "x" }, { invite_key: toBase64Url(bytes) }, { invite_key: REDEEM.public_key }, { auto: "true" }, { challenge_id: "x" }, { challenge: "" }, { challenge: "x".repeat(257) }, { challenge: 1 }]) {
      expect({ bad, code: malformed(() => inviteMakeBytes({ ...MAKE, ...bad } as InviteMake)) }).toEqual({ bad, code: "redeem_malformed" });
    }
    expect(malformed(() => inviteMakeBytes(null as unknown as InviteMake))).toBe("redeem_malformed");
  });

  test("a challenge is text in its one encoding: half of a pair alone is refused, since it would be signed as the bytes of another text", () => {
    // The review's sequence: both of these would give the bytes ef bf bd.
    const replaced = hex(inviteMakeBytes({ ...MAKE, challenge: "\uFFFD" }));
    expect(replaced.endsWith("00000003efbfbd")).toBe(true);
    for (const challenge of ["\uD800", "\uDC00", "a\uD83D", "\uDE00a", "\uDE00\uD83D", `${MAKE.challenge}\uDBFF`]) {
      expect({ challenge: JSON.stringify(challenge), code: malformed(() => inviteMakeBytes({ ...MAKE, challenge })) }).toEqual({ challenge: JSON.stringify(challenge), code: "redeem_malformed" });
    }
    // A whole pair, and any other text, is signed as its UTF-8 bytes.
    expect(hex(inviteMakeBytes({ ...MAKE, challenge: "\uD83D\uDE00" })).endsWith("00000004f09f9880")).toBe(true);
    expect(hex(inviteMakeBytes({ ...MAKE, challenge: "\u00e9\u4e2d" })).endsWith("00000005c3a9e4b8ad")).toBe(true);
    expect([isAccountId("a"), isAccountId("a".repeat(64)), isAccountId(""), isAccountId("a".repeat(65)), isAccountId("a.b")]).toEqual([true, true, false, false, false]);
  });
});

describe("the challenge an invite's line signs for a PC's card", () => {
  const [vector] = challenges;
  if (!vector) throw new Error("invite/line-challenge.json is missing");
  const { list, card } = vector;

  test("is the vector's: every reader of it (the PC, the app, the account service) is held to these bytes", () => {
    expect(challenges.map((each) => each.name)).toEqual(["line-challenge"]);
    expect(bytesToHex(cardBinding({ ...card, list, invite: null }))).toBe(vector.binding_hex);
    expect(lineChallenge(list, card)).toBe(vector.challenge);
  });

  test("is the first 32 hex digits of SHA-256 over the prefix, the list's id and the binding of the PC's card for that list, with no invite named", () => {
    expect(LINE_CHALLENGE_PREFIX).toBe("ovis-list-join/1");
    const built = bytesToHex(sha256(concatBytes(utf8ToBytes("ovis-list-join/1"), utf8ToBytes(list), cardBinding({ ...card, list, invite: null })))).slice(0, 32);
    expect(lineChallenge(list, card)).toBe(built);
    expect(lineChallenge(list, card)).toMatch(/^[0-9a-f]{32}$/);
    // a card given whole, as the kinds hold one, gives the same
    expect(lineChallenge(list, { ...card, list, invite: null })).toBe(built);
  });

  test("is another for another list, another key of the PC's, or another relay key", () => {
    const other = "2f".repeat(32);
    const all = [
      lineChallenge(list, card), lineChallenge(other, card), lineChallenge(list, { ...card, endpoint: "cd".repeat(32) }),
      lineChallenge(list, { ...card, key: card.enc }), lineChallenge(list, { ...card, enc: card.key }),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test("refuses a card that is for another list, that names an invite, or that is no PC's", () => {
    const refused = (work: () => unknown): boolean => { try { work(); return false; } catch (error) { return error instanceof InviteRedeemError; } };
    expect(refused(() => lineChallenge(list, { ...card, list: "2f".repeat(32), invite: null }))).toBe(true);
    expect(refused(() => lineChallenge(list, { ...card, list, invite: card.enc } as never))).toBe(true);
    expect(refused(() => lineChallenge(list, { ...card, endpoint: null } as never))).toBe(true);
    expect(refused(() => lineChallenge("not a list", card))).toBe(true);
    expect(refused(() => lineChallenge(list, { ...card, key: "not a key" }))).toBe(true);
    expect(refused(() => lineChallenge(list, { ...card, endpoint: "AB".repeat(32) }))).toBe(true);
  });

});

describe("the proof an invite's line signs for a PC's card", () => {
  const [vector] = proofs;
  if (!vector) throw new Error("invite/line-proof.json is missing");
  const { account, server_id, list, card } = vector;
  const named = { account, server_id, list, card };
  /** The bytes as this test writes them, with no part of the file under test. */
  const written = (values: readonly string[]): string => {
    const parts: Buffer[] = [Buffer.from("ovis-list-line/1", "utf8")];
    for (const value of values) { const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(value)); parts.push(length, Buffer.from(value, "utf8")); }
    return Buffer.concat(parts).toString("hex");
  };

  test("is over the vector's bytes: a tag of its own, then the account, the PC's id, its relay key and the challenge of its card for the list", async () => {
    expect(proofs.map((each) => each.name)).toEqual(["line-proof"]);
    expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
    expect(LINE_PROOF_PREFIX).toBe("ovis-list-line/1");
    expect(vector.challenge).toBe(lineChallenge(list, card));
    expect(hex(lineProofBytes(named))).toBe(vector.bytes_hex);
    expect(vector.bytes_hex).toBe(written([account, server_id, card.endpoint, vector.challenge]));
    expect(await verifyLineProof(named, vector.signature, vector.key)).toBe(vector.expect.verifies);
  });

  test("is what a line signs for the card it is given, and holds for that account, PC, list and card alone", async () => {
    const invite = await newInvite(SERVICE, account, list);
    const line = await readJoinLine(invite.line, READER);
    const proof = await line.signLineProof({ server_id, card });
    expect(proof).toHaveLength(INVITE_SIGNATURE_CHARS);
    expect(await verifyLineProof(named, proof, invite.key)).toBe(true);
    const others = [
      { ...named, card: { ...card, key: card.enc } }, { ...named, card: { ...card, enc: card.key } }, { ...named, card: { ...card, endpoint: "cd".repeat(32) } },
      { ...named, list: "2f".repeat(32) }, { ...named, account: "TEST-ONLY-other" }, { ...named, server_id: "f".repeat(32) },
    ];
    for (const other of others) expect(await verifyLineProof(other, proof, invite.key)).toBe(false);
    // another invite's key did not sign it
    expect(await verifyLineProof(named, proof, vector.key)).toBe(false);
  });

  test("is no redeem signature, and no redeem signature is one: a challenge the account service chooses makes no proof for a card", async () => {
    const invite = await newInvite(SERVICE, account, list);
    const line = await readJoinLine(invite.line, READER);
    // an account service that lies hands the PC, as the challenge to redeem with, the challenge of a card of its own
    const theirs = { ...card, key: card.enc, enc: card.key };
    const asked = lineChallenge(list, theirs);
    const redeemed = await line.signRedeem({ server_id, public_key: card.endpoint, challenge_id: asked });
    expect(await verifyInviteRedeem({ account, server_id, public_key: card.endpoint, challenge_id: asked }, redeemed, invite.key)).toBe(true);
    expect(await verifyLineProof({ ...named, card: theirs }, redeemed, invite.key)).toBe(false);
    expect(await verifyLineProof(named, await line.signRedeem({ server_id, public_key: card.endpoint, challenge_id: lineChallenge(list, card) }), invite.key)).toBe(false);
    // and the proof redeems nothing
    const proof = await line.signLineProof({ server_id, card });
    expect(await verifyInviteRedeem({ account, server_id, public_key: card.endpoint, challenge_id: lineChallenge(list, card) }, proof, invite.key)).toBe(false);
    // no other message the invite's key signs starts with the proof's tag, nor the proof with theirs
    const tags = [LINE_PROOF_PREFIX, INVITE_REDEEM_PREFIX, "ovis-list-entry/1", "ovis-list-read/1", "ovis-join-secret-check/1"];
    for (const one of tags) for (const other of tags) expect(one !== other && one.startsWith(other)).toBe(false);
  });

  test("refuses what is out of form, and a line that names no list signs none", async () => {
    const refused = (work: () => unknown): boolean => { try { work(); return false; } catch (error) { return error instanceof InviteRedeemError; } };
    expect(refused(() => lineProofBytes({ ...named, account: "" }))).toBe(true);
    expect(refused(() => lineProofBytes({ ...named, server_id: server_id.toUpperCase() }))).toBe(true);
    expect(refused(() => lineProofBytes({ ...named, list: "not a list" }))).toBe(true);
    expect(refused(() => lineProofBytes({ ...named, card: { ...card, list: "2f".repeat(32), invite: null } }))).toBe(true);
    expect(refused(() => lineProofBytes({ ...named, card: { ...card, key: "not a key" } }))).toBe(true);
    expect(refused(() => lineProofBytes(null as never))).toBe(true);
    // a check answers false for anything a request may hold, and never throws
    for (const junk of [null, 7, "", "A".repeat(85), vector.signature.replace(/.$/, "=")]) expect(await verifyLineProof(named, junk, vector.key)).toBe(false);
    for (const junk of [null, 7, "", "not a key"]) expect(await verifyLineProof(named, vector.signature, junk)).toBe(false);
    expect(await verifyLineProof({ ...named, card: null } as never, vector.signature, vector.key)).toBe(false);
    const bare = await readJoinLine((await newInvite(SERVICE, account, null)).line, READER);
    const error = await bare.signLineProof({ server_id, card }).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe("not_signed");
    const line = await readJoinLine((await newInvite(SERVICE, account, list)).line, READER);
    expect(await line.signLineProof({ server_id, card: { ...card, list: "2f".repeat(32), invite: null } }).catch((caught: unknown) => (caught as { code?: string }).code)).toBe("redeem_malformed");
  });
});
