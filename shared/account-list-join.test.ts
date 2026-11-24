import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inviteRedeemBytes, verifyInviteRedeem } from "./account-list-invite.ts";
import { JOIN_LINE_MAX_CHARS, JOIN_LINE_PREFIX, JoinLineError, isServiceOrigin, newInvite, readJoinLine, writeJoinLine, type JoinLine, type JoinLineReader, type JoinLineReason } from "./account-list-join.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const SERVICE = "https://accounts.ovis.test";
const ACCOUNT = "TEST-ONLY-account";
const LIST = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
const DIR = join(import.meta.dir, "account-list-vectors", "join");
/** The caller of most tests: it uses the service the test lines name, and follows lists. */
const READER: JoinLineReader = { service: SERVICE, followsLists: true };
/** A machine and a challenge to redeem with. */
const MACHINE = { server_id: "5f1d0c2e9ab34c7781e6f0a2b3c4d5e6", public_key: "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f", challenge_id: "00112233445566778899aabbccddeeff" };
/** Whether a line that was read signs for the key it names: its redeem signature verifies under that key, for its own account. */
const signsForItsKey = async (read: JoinLine) => await verifyInviteRedeem({ account: read.account, ...MACHINE }, await read.signRedeem(MACHINE), read.key);

interface KeyPair { readonly pkcs8: string; readonly spki: string }
interface JoinVector {
  readonly name: string;
  readonly keys: Readonly<Record<string, KeyPair>>;
  readonly line: string;
  /** What the reader is told of its caller, where that is not the test service and a caller that follows lists. */
  readonly reader?: { readonly service: string; readonly follows_lists: boolean };
  readonly expect: { readonly service: string; readonly account: string; readonly list: string | null; readonly key: string } | { readonly stops: { readonly code: "line_malformed"; readonly reason: JoinLineReason } };
}
const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as JoinVector);
const good = vectors.find((vector) => vector.name === "join-line");
if (!good) throw new Error("join/join-line.json is missing");
const inviteKeys = good.keys["TEST-ONLY-invite"];
if (!inviteKeys) throw new Error("join-line has no TEST-ONLY-invite key");

/** A refusal shows no 12 characters of any private text, and carries only its code, its name and its reason. */
function expectNothingShown(error: JoinLineError, texts: readonly [string, string][]): void {
  expect(leaksOf(error, texts)).toEqual([]);
  expect(Object.keys(error).sort()).toEqual(["code", "name", "reason"]);
  expect(error.cause).toBeUndefined();
}
/** The reader's refusal of a line, checked to show nothing of the line, its secret or the fixture keys; null when it reads. */
async function refusal(line: string, keys: Readonly<Record<string, KeyPair>> = good?.keys ?? {}, reader: JoinLineReader = READER): Promise<JoinLineError | null> {
  try {
    await readJoinLine(line, reader);
  } catch (error) {
    if (!(error instanceof JoinLineError)) throw error;
    expectNothingShown(error, privateTexts(line, keys));
    return error;
  }
  return null;
}
const importInvite = (extractable: boolean) => crypto.subtle.importKey("pkcs8", fromBase64Url(inviteKeys.pkcs8) as Uint8Array<ArrayBuffer>, P256, extractable, ["sign"]);
const encode = (json: string) => `${JOIN_LINE_PREFIX}${toBase64Url(new TextEncoder().encode(json))}`;
const lineWith = (secret: string, service = SERVICE, account = ACCOUNT, list = LIST) => encode(`{"v":1,"service":"${service}","account":"${account}","list":"${list}","secret":"${secret}"}`);
const secretOf = (line: string) => (JSON.parse(new TextDecoder().decode(fromBase64Url(line.slice(JOIN_LINE_PREFIX.length)))) as { secret: string }).secret;
/**
 * The writer's refusal reason, or "none", once the refusal is checked to show nothing of the service and list it was
 * given (the account too), the good line, the fixture keys or the private value `d` the key exports (as the runtime answers at that
 * moment). `settled` runs as soon as the writer is done, before this exports anything itself.
 */
async function writerReason(service: string, list: string | null, key: CryptoKey, settled?: () => void, account = ACCOUNT): Promise<JoinLineReason | "none"> {
  try {
    await writeJoinLine(service, account, list, key).finally(settled);
  } catch (error) {
    if (!(error instanceof JoinLineError)) throw error;
    const d = key.extractable ? ((await crypto.subtle.exportKey("jwk", key)).d ?? "") : "";
    expectNothingShown(error, [...privateTexts(good?.line ?? "", good?.keys), ["d", d], ["service", service], ["account", account], ["list", list ?? ""]]);
    return error.reason;
  }
  return "none";
}
/** A P-256 private value in another legal PKCS8 form: RFC 5915 without the optional public point (67 bytes). */
const withoutPoint = (d: Uint8Array) => Uint8Array.from([0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20, ...d]);
/** A runtime whose PKCS8 export is that other form, built from the key's own `d`: the writer's line may not change with it. */
function otherPkcs8Export() {
  const original = crypto.subtle.exportKey.bind(crypto.subtle) as (format: KeyFormat, key: CryptoKey) => Promise<ArrayBuffer | JsonWebKey>;
  return spyOn(crypto.subtle, "exportKey").mockImplementation((async (format: KeyFormat, key: CryptoKey) => {
    if (format !== "pkcs8") return original(format, key);
    const jwk = await original("jwk", key) as JsonWebKey;
    return withoutPoint(fromBase64Url(jwk.d ?? "")).buffer;
  }) as typeof crypto.subtle.exportKey);
}

/** All an error can show: its name, message, whole stack, cause, and every own field, enumerable or not. */
function shownBy(error: Error): string {
  const fields = Object.getOwnPropertyNames(error).map((name) => String((error as unknown as Record<string, unknown>)[name]));
  return [error.name, error.message, String(error.stack ?? ""), String(error.cause ?? ""), JSON.stringify({ ...error }), ...fields].join("\n");
}
/** JSON.parse as it was when this file loaded: a test that spies on JSON.parse does not count the leak check's own calls. */
const parseJson = JSON.parse.bind(JSON) as (text: string) => unknown;
/** A JSON string token's value, unescaped; its text after the opening quote (and before a closing one) when it is malformed. */
function unescaped(token: string): string {
  try {
    const value = parseJson(token);
    if (typeof value === "string") return value;
  } catch {
    // A malformed fixture: scan the text as it stands.
  }
  return token.length > 1 && token.endsWith('"') ? token.slice(1, -1) : token.slice(1);
}
/**
 * The line after its prefix, each secret, service, account and list the line holds (whole JSON strings, decoded from it and
 * unescaped) and each fixture key: an error may show no 12 characters of any.
 */
function privateTexts(line: string, keys: Readonly<Record<string, KeyPair>> = {}): [string, string][] {
  const prefixAt = line.indexOf(JOIN_LINE_PREFIX);
  const payload = prefixAt >= 0 ? line.slice(prefixAt + JOIN_LINE_PREFIX.length) : line;
  const decoded = Buffer.from(payload.slice(payload.lastIndexOf(":") + 1), "base64url").toString("utf8");
  const members = [...decoded.matchAll(/"(secret|service|account|list)"\s*:\s*("(?:[^"\\]|\\.)*"?)/g)]
    .map((match, index): [string, string] => [`${match[1]} ${index}`, unescaped(match[2] ?? "")]);
  return [["payload", payload], ...members, ...Object.entries(keys).map(([name, pair]): [string, string] => [name, pair.pkcs8])];
}
/** Where an error shows 12 characters of a private text, every window tried one character apart (each distinct one once); empty when it shows none. */
function leaksOf(error: Error, texts: readonly [string, string][]): string[] {
  const shown = shownBy(error);
  const leaks: string[] = [];
  for (const [name, text] of texts) {
    const tried = new Set<string>();
    for (let index = 0; index + 12 <= text.length; index++) {
      const window = text.slice(index, index + 12);
      if (tried.has(window)) continue;
      tried.add(window);
      if (shown.includes(window)) leaks.push(`${name} at ${index}`);
    }
  }
  return leaks;
}

describe("the vectors of join/", () => {
  test("names: the good lines (with a list, with none, with the longest account) and the refusals the line format defines, none missing", () => {
    expect(vectors.map((vector) => vector.name)).toEqual(["account-64", "account-65", "account-empty", "account-missing", "account-number",
      "account-outside-alphabet", "join-line-no-list", "join-line", "json-escape", "json-not-an-object", "json-not-utf8", "json-white-space",
      "line-1026", "line-no-prefix", "line-outside-alphabet", "line-padded", "line-prefix-version-2", "line-second-spelling", "list-63", "list-not-a-hash", "list-null",
      "member-extra", "member-missing", "member-twice", "members-other-order", "reader-no-lists-no-list", "reader-no-lists", "reader-other-port", "reader-other-service",
      "reader-service-with-path", "secret-139-bytes", "secret-no-public-key", "secret-not-base64url", "secret-other-curve", "secret-other-point", "secret-scalar-0",
      "secret-scalar-n", "service-default-port", "service-http", "service-path", "service-trailing-slash", "service-uppercase-host", "v-1-0", "v-2", "v-string"]);
    expect(vectors.filter((vector) => !("stops" in vector.expect)).map((vector) => vector.name))
      .toEqual(["account-64", "join-line-no-list", "join-line", "reader-no-lists-no-list", "reader-service-with-path"]);
    // Every reason a reader gives has a vector; `not_extractable` is the writer's alone.
    const reasons = new Set(vectors.flatMap((vector) => ("stops" in vector.expect ? [vector.expect.stops.reason] : [])));
    expect([...reasons].sort()).toEqual(["account", "base64url", "json", "length", "list", "members", "needs_lists", "not_one_form", "other_service", "prefix", "scalar", "secret", "service", "version"]);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      const { expect: want } = vector;
      const reader = vector.reader === undefined ? READER : { service: vector.reader.service, followsLists: vector.reader.follows_lists };
      if ("stops" in want) {
        const error = await refusal(vector.line, vector.keys, reader);
        expect(error?.code).toBe(want.stops.code);
        expect(error?.reason).toBe(want.stops.reason);
        return;
      }
      const read = await readJoinLine(vector.line, reader);
      expect({ service: read.service, account: read.account, list: read.list, key: read.key }).toEqual(want);
      expect(await signsForItsKey(read)).toBe(true);
    });
  }

  test("the good line is written again, byte for byte, from its key, whatever form the runtime exports PKCS8 in", async () => {
    const key = await importInvite(true);
    expect(await writeJoinLine(SERVICE, ACCOUNT, LIST, key)).toBe(good.line);
    const exportKey = otherPkcs8Export();
    try {
      expect(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)).length).toBe(67);
      expect(await writeJoinLine(SERVICE, ACCOUNT, LIST, key)).toBe(good.line);
    } finally {
      exportKey.mockRestore();
    }
  });
});

describe("writing a line", () => {
  test("a fresh key: the line reads back to its service, its list and its public key, and its secret signs for that key", async () => {
    const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
    const line = await writeJoinLine(SERVICE, ACCOUNT, LIST, pair.privateKey);
    const read = await readJoinLine(line, READER);
    expect(read.service).toBe(SERVICE);
    expect(read.account).toBe(ACCOUNT);
    expect(read.list).toBe(LIST);
    expect(read.key).toBe(toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))));
    const signature = fromBase64Url(await read.signRedeem(MACHINE));
    expect(await crypto.subtle.verify(SIGN, pair.publicKey, signature as Uint8Array<ArrayBuffer>, inviteRedeemBytes({ account: ACCOUNT, ...MACHINE }))).toBe(true);
  });

  test("the secret is the good line's fixed bytes around d, x and y, for many keys, whatever form the runtime exports PKCS8 in", async () => {
    const fixed = fromBase64Url(inviteKeys.pkcs8);
    const exportKey = otherPkcs8Export();
    try {
      for (let index = 0; index < 20; index++) {
        const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
        const line = await writeJoinLine(SERVICE, ACCOUNT, LIST, pair.privateKey);
        const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
        const part = (value: string | undefined) => [...fromBase64Url(value ?? "")];
        const want = Uint8Array.from([...fixed.subarray(0, 36), ...part(jwk.d), ...fixed.subarray(68, 74), ...part(jwk.x), ...part(jwk.y)]);
        expect(secretOf(line)).toBe(toBase64Url(want));
      }
    } finally {
      exportKey.mockRestore();
    }
  });

  test("an account with no list yet: the line is the vector's, holds an empty list, and reads back with no list", async () => {
    const vector = vectors.find((candidate) => candidate.name === "join-line-no-list");
    if (!vector) throw new Error("no join-line-no-list");
    const line = await writeJoinLine(SERVICE, ACCOUNT, null, await importInvite(true));
    expect(line).toBe(vector.line);
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(line.slice(JOIN_LINE_PREFIX.length))))).toEqual({ v: 1, service: SERVICE, account: ACCOUNT, list: "", secret: inviteKeys.pkcs8 });
    const read = await readJoinLine(line, READER);
    expect({ service: read.service, account: read.account, list: read.list, key: read.key }).toEqual({ service: SERVICE, account: ACCOUNT, list: null, key: inviteKeys.spki });
  });

  test("the writer refuses an account that is no account's id, and a list that is neither a list id nor none", async () => {
    const key = await importInvite(true);
    for (const account of ["", "a".repeat(65), "TEST-ONLY.account", "TEST ONLY", "계정", `${ACCOUNT}\n`]) {
      expect({ account, reason: await writerReason(SERVICE, LIST, key, undefined, account) }).toEqual({ account, reason: "account" });
    }
    for (const account of ["a", "a".repeat(64), "A-Z_a-z_0-9"]) expect(await writerReason(SERVICE, LIST, key, undefined, account)).toBe("none");
    // The writer's "none" is null: an empty text is no list id.
    for (const list of ["", LIST.toUpperCase(), `${LIST}0`]) expect({ list, reason: await writerReason(SERVICE, list, key) }).toEqual({ list, reason: "list" });
    // The account is judged first: nothing of a line is built for an account that no line names.
    expect(await writerReason("http://accounts.ovis.test", "", key, undefined, "")).toBe("account");
  });

  test("the writer refuses what no line may hold", async () => {
    const key = await importInvite(true);
    expect(await writerReason("http://accounts.ovis.test", LIST, key)).toBe("service");
    expect(await writerReason(`${SERVICE}/`, LIST, key)).toBe("service");
    expect(await writerReason(SERVICE, LIST.slice(1), key)).toBe("list");
    const sealed = await importInvite(false);
    expect(await writerReason(SERVICE, LIST, sealed)).toBe("not_extractable");
    const p384 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign"]);
    expect(await writerReason(SERVICE, LIST, p384.privateKey)).toBe("secret");
  });

  test("the writer refuses a key whose JWK parts are not 32 bytes each in their one spelling", async () => {
    const key = await importInvite(true);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    const d = fromBase64Url(jwk.d ?? "");
    // x with a padding bit set in its last character: the same 32 bytes, in a second spelling.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const x = jwk.x ?? "";
    const nonCanonical = `${x.slice(0, -1)}${alphabet[alphabet.indexOf(x.slice(-1)) ^ 1]}`;
    for (const other of [{ d: toBase64Url(d.subarray(1)) }, { d: toBase64Url(Uint8Array.from([1, ...d])) }, { x: nonCanonical }, { y: undefined }]) {
      const exportKey = spyOn(crypto.subtle, "exportKey").mockImplementation((async (): Promise<JsonWebKey | ArrayBuffer> => ({ ...jwk, ...other })) as typeof crypto.subtle.exportKey);
      try {
        expect({ other, reason: await writerReason(SERVICE, LIST, key) }).toEqual({ other, reason: "secret" });
      } finally {
        exportKey.mockRestore();
      }
    }
    // A public key: its JWK has no d.
    const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
    expect(await writerReason(SERVICE, LIST, pair.publicKey)).toBe("secret");
  });

  test("the writer refuses a key of another type or curve even when its parts are 32 bytes each", async () => {
    const key = await importInvite(true);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    for (const other of [{ crv: "P-384" }, { crv: "secp256k1" }, { kty: "OKP" }]) {
      const exportKey = spyOn(crypto.subtle, "exportKey").mockImplementation((async (): Promise<JsonWebKey | ArrayBuffer> => ({ ...jwk, ...other })) as typeof crypto.subtle.exportKey);
      try {
        expect({ other, reason: await writerReason(SERVICE, LIST, key) }).toEqual({ other, reason: "secret" });
      } finally {
        exportKey.mockRestore();
      }
    }
  });
});

describe("reading a line: each way it can be wrong, with the smallest input", () => {
  const cases: [string, string, JoinLineReason][] = [
    ["empty", "", "prefix"],
    ["the prefix alone", JOIN_LINE_PREFIX, "base64url"],
    ["one character, which no base64url spelling has", `${JOIN_LINE_PREFIX}A`, "base64url"],
    ["a trailing newline", `${good.line}\n`, "base64url"],
    ["white space before", ` ${good.line}`, "prefix"],
    ["an empty object", encode("{}"), "members"],
    ["the form before the account was in it: four members", encode(`{"v":1,"service":"${SERVICE}","list":"${LIST}","secret":"${inviteKeys.pkcs8}"}`), "members"],
    ["an account in another member's place", encode(`{"v":1,"account":"${ACCOUNT}","service":"${SERVICE}","list":"${LIST}","secret":"${inviteKeys.pkcs8}"}`), "not_one_form"],
    ["null", encode("null"), "json"],
    ["not JSON", encode("v=1"), "json"],
    ["a string", encode('"x"'), "json"],
  ];
  for (const [name, line, reason] of cases) {
    test(name, async () => {
      expect((await refusal(line))?.reason).toBe(reason);
    });
  }

  test("an https origin in its one serialization", () => {
    expect(isServiceOrigin(SERVICE)).toBe(true);
    expect(isServiceOrigin("https://accounts.ovis.test:8443")).toBe(true);
    for (const text of ["", "accounts.ovis.test", "http://accounts.ovis.test", `${SERVICE}/`, `${SERVICE}:443`, "https://Accounts.ovis.test",
      `${SERVICE}/v2`, `${SERVICE}?a`, `${SERVICE}#a`, "https://user@accounts.ovis.test", " https://accounts.ovis.test"]) expect(isServiceOrigin(text)).toBe(false);
  });
});

describe("what the reader's caller may act on", () => {
  const noList = () => {
    const vector = vectors.find((candidate) => candidate.name === "join-line-no-list");
    if (!vector) throw new Error("no join-line-no-list");
    return vector.line;
  };

  test("a line for another account service is refused, whatever else it holds: the origin is compared as text", async () => {
    for (const service of ["https://other.ovis.test", "https://accounts.ovis.test:8443", "https://accounts.ovis.test.evil.example", "https://account.ovis.test", "http://accounts.ovis.test",
      "accounts.ovis.test", "", "off"]) {
      expect({ service, reason: (await refusal(good.line, good.keys, { service, followsLists: true }))?.reason }).toEqual({ service, reason: "other_service" });
    }
    // What a caller gives is read as a URL, and its origin counts: a path, a default port or an upper-case host is the same service.
    for (const service of [SERVICE, `${SERVICE}/`, `${SERVICE}/v1?x#y`, `${SERVICE}:443`, "https://Accounts.Ovis.Test"]) {
      expect({ service, read: (await readJoinLine(good.line, { service, followsLists: true })).service }).toEqual({ service, read: SERVICE });
    }
    // A caller's own mistake is no way in either.
    for (const service of [undefined, null, 1, {}]) expect((await refusal(good.line, good.keys, { service: service as unknown as string, followsLists: true }))?.reason).toBe("other_service");
  });

  test("a line that names a list is refused for a caller that does not follow lists; a line with no list is read by both", async () => {
    expect((await refusal(good.line, good.keys, { service: SERVICE, followsLists: false }))?.reason).toBe("needs_lists");
    for (const followsLists of [undefined, null, 1, "true"]) expect((await refusal(good.line, good.keys, { service: SERVICE, followsLists: followsLists as unknown as boolean }))?.reason).toBe("needs_lists");
    for (const followsLists of [true, false]) expect((await readJoinLine(noList(), { service: SERVICE, followsLists })).list).toBeNull();
    // The service is asked first: a caller is told that a line is not for it before anything of what the line is for.
    expect((await refusal(good.line, good.keys, { service: "https://other.ovis.test", followsLists: false }))?.reason).toBe("other_service");
  });

  test("the line's form is judged first, and both refusals come before the secret is given to the runtime", async () => {
    expect((await refusal(`${good.line}=`, good.keys, { service: "https://other.ovis.test", followsLists: false }))?.reason).toBe("base64url");
    const importKey = spyOn(crypto.subtle, "importKey");
    try {
      expect((await refusal(good.line, good.keys, { service: "https://other.ovis.test", followsLists: true }))?.reason).toBe("other_service");
      expect((await refusal(good.line, good.keys, { service: SERVICE, followsLists: false }))?.reason).toBe("needs_lists");
      expect(importKey).not.toHaveBeenCalled();
    } finally {
      importKey.mockRestore();
    }
  });

  test("what a line gives back holds no key that signs what a caller hands it", async () => {
    const read = await readJoinLine(good.line, READER);
    expect(Object.keys(read).sort()).toEqual(["account", "encryptionKey", "key", "list", "service", "signRedeem"]);
    expect(Object.isFrozen(read)).toBe(true);
    // The one key it shows agrees on a secret and signs nothing; it cannot be exported.
    expect([read.encryptionKey.type, read.encryptionKey.algorithm.name, read.encryptionKey.extractable, read.encryptionKey.usages]).toEqual(["private", "ECDH", false, ["deriveBits"]]);
    await expect(crypto.subtle.sign(SIGN, read.encryptionKey, new Uint8Array([1]))).rejects.toThrow();
    await expect(crypto.subtle.exportKey("pkcs8", read.encryptionKey)).rejects.toThrow();
    // signRedeem signs the redeem message of the line's own account: a caller names the machine and the challenge, and nothing else.
    const signature = await read.signRedeem({ ...MACHINE, account: "TEST-ONLY-other-account" } as typeof MACHINE);
    expect(await verifyInviteRedeem({ account: ACCOUNT, ...MACHINE }, signature, read.key)).toBe(true);
    expect(await verifyInviteRedeem({ account: "TEST-ONLY-other-account", ...MACHINE }, signature, read.key)).toBe(false);
    await expect(read.signRedeem({ ...MACHINE, challenge_id: "x" })).rejects.toMatchObject({ code: "redeem_malformed" });
  });

  test("the encryption key is the line's own secret: it agrees with another key on what that key agrees on with the line's public key", async () => {
    const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
    const read = await readJoinLine(good.line, READER);
    const other = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
    const linePublic = await crypto.subtle.importKey("spki", fromBase64Url(read.key) as Uint8Array<ArrayBuffer>, ECDH, false, []);
    const mine = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: other.publicKey }, read.encryptionKey, 256));
    const theirs = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: linePublic }, other.privateKey, 256));
    expect(toBase64Url(mine)).toBe(toBase64Url(theirs));
  });
});

describe("making an invite", () => {
  test("a new invite is a line and its public key: the line reads to that key, names what it was made for, and signs for it", async () => {
    for (const given of [null, LIST]) {
      const invite = await newInvite(SERVICE, ACCOUNT, given);
      expect(Object.keys(invite).sort()).toEqual(["key", "line"]);
      const read = await readJoinLine(invite.line, READER);
      expect({ service: read.service, account: read.account, list: read.list, key: read.key }).toEqual({ service: SERVICE, account: ACCOUNT, list: given, key: invite.key });
      expect(await signsForItsKey(read)).toBe(true);
    }
  });

  test("every invite is another key, and what no line may hold is refused as the line's writer refuses it", async () => {
    const keys = new Set<string>();
    for (let index = 0; index < 20; index++) keys.add((await newInvite(SERVICE, ACCOUNT, null)).key);
    expect(keys.size).toBe(20);
    const reason = async (service: string, account: string, list: string | null) => {
      try {
        await newInvite(service, account, list);
      } catch (error) {
        if (error instanceof JoinLineError) return error.reason;
        throw error;
      }
      return "none";
    };
    expect([await reason("http://accounts.ovis.test", ACCOUNT, null), await reason(SERVICE, "", null), await reason(SERVICE, ACCOUNT, "")]).toEqual(["service", "account", "list"]);
  });
});

describe("the secret's one form", () => {
  test("a secret out of the 138-byte form is refused by its form alone, before any runtime is asked to import it", async () => {
    const importKey = spyOn(crypto.subtle, "importKey");
    try {
      for (const name of ["secret-139-bytes", "secret-other-curve", "secret-no-public-key"]) {
        const vector = vectors.find((candidate) => candidate.name === name);
        if (!vector) throw new Error(`no ${name}`);
        importKey.mockClear();
        expect((await refusal(vector.line))?.reason).toBe("secret");
        expect(importKey).not.toHaveBeenCalled();
      }
      // One of the fixed bytes around the private value changed: the length of the public key's [1].
      const secret = fromBase64Url(inviteKeys.pkcs8);
      secret[69] = 0x45;
      const fixedByteChanged = encode(`{"v":1,"service":"${SERVICE}","account":"${ACCOUNT}","list":"${LIST}","secret":"${toBase64Url(secret)}"}`);
      importKey.mockClear();
      expect((await refusal(fixedByteChanged))?.reason).toBe("secret");
      expect(importKey).not.toHaveBeenCalled();
      // The same 138 bytes with another leading DER tag: a SET where the SEQUENCE is.
      const tagChanged = fromBase64Url(inviteKeys.pkcs8);
      tagChanged[0] = 0x31;
      importKey.mockClear();
      expect((await refusal(encode(`{"v":1,"service":"${SERVICE}","account":"${ACCOUNT}","list":"${LIST}","secret":"${toBase64Url(tagChanged)}"}`)))?.reason).toBe("secret");
      expect(importKey).not.toHaveBeenCalled();
    } finally {
      importKey.mockRestore();
    }
  });

  test("a point that is not the secret's own is refused also by a runtime that imports it without a look at the point", async () => {
    const vector = vectors.find((candidate) => candidate.name === "secret-other-point");
    if (!vector) throw new Error("no secret-other-point");
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    // Such a runtime imports the private value alone: the same 32 bytes in RFC 5915 form, without the public point.
    const importKey = spyOn(crypto.subtle, "importKey").mockImplementation(((format: KeyFormat, data: BufferSource | JsonWebKey, algorithm: EcKeyImportParams, extractable: boolean, usages: KeyUsage[]) => {
      if (format !== "pkcs8" || !(data instanceof Uint8Array)) return original(format as "spki", data as BufferSource, algorithm, extractable, usages);
      return original("pkcs8", withoutPoint(data.subarray(36, 68)), algorithm, extractable, usages);
    }) as typeof crypto.subtle.importKey);
    try {
      expect((await refusal(good.line))).toBeNull();
      expect((await refusal(vector.line))?.reason).toBe("secret");
      expect(importKey).toHaveBeenCalled();
    } finally {
      importKey.mockRestore();
    }
  });
});

describe("a line's bounded length", () => {
  // The longest service whose line fits beside this account and list: 12 + ceil(4 * (320 + 439) / 3) = 1024 characters.
  const longest = `https://${"a".repeat(426)}.test`;

  test("a multi-megabyte line is refused by its length, before any of it is decoded or parsed", async () => {
    const json = `{"v":1,"service":"${SERVICE}","account":"${ACCOUNT}","list":"${LIST}","secret":"${"A".repeat(4 * 1024 * 1024)}"}`;
    const huge = `${JOIN_LINE_PREFIX}${Buffer.from(json).toString("base64url")}`;
    const atob = spyOn(globalThis, "atob");
    const parse = spyOn(JSON, "parse");
    try {
      expect((await refusal(huge))?.reason).toBe("length");
      expect(atob).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      atob.mockRestore();
      parse.mockRestore();
    }
  });

  test("the longest line is written and read; one character more is refused by the writer and by the reader", async () => {
    const key = await importInvite(true);
    const line = await writeJoinLine(longest, ACCOUNT, LIST, key);
    expect(line.length).toBe(JOIN_LINE_MAX_CHARS);
    expect((await readJoinLine(line, { service: longest, followsLists: true })).service).toBe(longest);
    const longer = `https://${"a".repeat(427)}.test`;
    expect(await writerReason(longer, LIST, key)).toBe("length");
    expect(lineWith(secretOf(good.line), longer).length).toBeGreaterThan(JOIN_LINE_MAX_CHARS);
    expect((await refusal(lineWith(secretOf(good.line), longer)))?.reason).toBe("length");
  });

  test("the room for a service is what the account and the list leave: the longest account, and no list", async () => {
    const key = await importInvite(true);
    const service = (length: number) => `https://${"a".repeat(length - 13)}.test`;
    for (const [account, list, room] of [["a".repeat(64), LIST, 392], ["a", null, 519], [ACCOUNT, null, 503]] as const) {
      const line = await writeJoinLine(service(room), account, list, key);
      expect(line.length).toBeLessThanOrEqual(JOIN_LINE_MAX_CHARS);
      expect(line.length).toBeGreaterThan(JOIN_LINE_MAX_CHARS - 4);
      const read = await readJoinLine(line, { service: service(room), followsLists: true });
      expect({ service: read.service, account: read.account, list: read.list }).toEqual({ service: service(room), account, list });
      expect(await writerReason(service(room + 1), list, key, undefined, account)).toBe("length");
      expect((await refusal(lineWith(secretOf(good.line), service(room + 1), account, list ?? "")))?.reason).toBe("length");
    }
  });

  test("an origin that fits the early bound but not once JSON escapes it is refused by the writer, as the reader would", async () => {
    const key = await importInvite(true);
    const quoted = `https://${"a".repeat(425)}".test`;
    expect(isServiceOrigin(quoted)).toBe(true);
    expect(quoted.length).toBe(439);
    const escaped = encode(`{"v":1,"service":${JSON.stringify(quoted)},"account":"${ACCOUNT}","list":"${LIST}","secret":"${secretOf(good.line)}"}`);
    expect(escaped.length).toBeGreaterThan(JOIN_LINE_MAX_CHARS);
    expect((await refusal(escaped))?.reason).toBe("length");
    expect(await writerReason(quoted, LIST, key)).toBe("length");
  });

  test("a service too long for any line is refused by the writer before it is parsed, the key exported or anything encoded", async () => {
    const key = await importInvite(true);
    const exportKey = spyOn(crypto.subtle, "exportKey");
    const btoa = spyOn(globalThis, "btoa");
    // Every URL the writer builds: it parses a service only with `new URL`.
    const RealURL = globalThis.URL;
    let parsed = 0;
    globalThis.URL = class extends RealURL {
      constructor(...args: ConstructorParameters<typeof URL>) {
        parsed++;
        super(...args);
      }
    };
    const run = async (service: string) => {
      exportKey.mockClear();
      btoa.mockClear();
      parsed = 0;
      let calls = { exportKey: -1, btoa: -1, parsed: -1 };
      const reason = await writerReason(service, LIST, key, () => {
        calls = { exportKey: exportKey.mock.calls.length, btoa: btoa.mock.calls.length, parsed };
      });
      return { service: service.slice(0, 12), reason, calls };
    };
    try {
      // The control: a service of a usual length is parsed, so the count sees parsing.
      const control = await run(SERVICE);
      expect(control.reason).toBe("none");
      expect(control.calls.parsed).toBeGreaterThan(0);
      // The second is no https origin either: a writer that parsed it first would refuse it as `service`.
      for (const service of [`https://${"a".repeat(2048)}.test`, `http://${"a".repeat(2048)}.test`]) {
        expect(await run(service)).toEqual({ service: service.slice(0, 12), reason: "length", calls: { exportKey: 0, btoa: 0, parsed: 0 } });
      }
    } finally {
      globalThis.URL = RealURL;
      exportKey.mockRestore();
      btoa.mockRestore();
    }
  });

  test("a secret that is not 184 characters is refused before it is decoded", async () => {
    const atob = spyOn(globalThis, "atob");
    try {
      const error = await refusal(lineWith(`${inviteKeys.pkcs8}AAAA`));
      expect(error?.reason).toBe("secret");
      expect(atob).toHaveBeenCalledTimes(1);
    } finally {
      atob.mockRestore();
    }
  });
});

describe("the secret's private value", () => {
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const withScalar = (d: bigint) => {
    const secret = fromBase64Url(inviteKeys.pkcs8);
    secret.set(Buffer.from(d.toString(16).padStart(64, "0"), "hex"), 36);
    return toBase64Url(secret);
  };

  for (const [name, d] of [["0", 0n], ["n", N], ["n+1", N + 1n]] as const) {
    test(`${name} is refused as out of range, before any runtime is asked to import it`, async () => {
      const importKey = spyOn(crypto.subtle, "importKey");
      try {
        const line = lineWith(withScalar(d));
        const error = await refusal(line);
        expect(error?.reason).toBe("scalar");
        expect(importKey).not.toHaveBeenCalled();
      } finally {
        importKey.mockRestore();
      }
    });
  }

  for (const [name, d] of [["1", 1n], ["n-1", N - 1n]] as const) {
    test(`${name} is in range: a key with it is written, read back to its own public key, and signs`, async () => {
      const value = Uint8Array.from(Buffer.from(d.toString(16).padStart(64, "0"), "hex"));
      const key = await crypto.subtle.importKey("pkcs8", withoutPoint(value), P256, true, ["sign"]);
      const line = await writeJoinLine(SERVICE, ACCOUNT, LIST, key);
      expect(fromBase64Url(secretOf(line)).subarray(36, 68)).toEqual(value);
      const read = await readJoinLine(line, READER);
      const { x, y } = await crypto.subtle.exportKey("jwk", key);
      const publicKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y }, P256, true, ["verify"]);
      expect({ service: read.service, account: read.account, list: read.list, key: read.key })
        .toEqual({ service: SERVICE, account: ACCOUNT, list: LIST, key: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", publicKey))) });
      expect(await signsForItsKey(read)).toBe(true);
    });
  }

  test("n-1 is in range: it reaches the runtime, and is refused only because the point is not its own", async () => {
    const importKey = spyOn(crypto.subtle, "importKey");
    try {
      expect((await refusal(lineWith(withScalar(N - 1n))))?.reason).toBe("secret");
      expect(importKey).toHaveBeenCalled();
    } finally {
      importKey.mockRestore();
    }
  });

  test("the writer refuses a key whose private value is out of range", async () => {
    const key = await importInvite(true);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    const exportKey = spyOn(crypto.subtle, "exportKey").mockImplementation((async (): Promise<JsonWebKey | ArrayBuffer> => ({ ...jwk, d: toBase64Url(new Uint8Array(32)) })) as typeof crypto.subtle.exportKey);
    try {
      expect(await writerReason(SERVICE, LIST, key)).toBe("scalar");
    } finally {
      exportKey.mockRestore();
    }
  });
});

describe("a runtime without WebCrypto", () => {
  test("is a fault: the reader and the writer throw, and neither blames the line", async () => {
    const key = await importInvite(true);
    const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    if (!real) throw new Error("no crypto here to take away");
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: crypto.getRandomValues.bind(crypto) }, configurable: true, writable: true });
    let readError: unknown = null;
    let writeError: unknown = null;
    try {
      await readJoinLine(good.line, READER).catch((error: unknown) => { readError = error; });
      await writeJoinLine(SERVICE, ACCOUNT, LIST, key).catch((error: unknown) => { writeError = error; });
    } finally {
      Object.defineProperty(globalThis, "crypto", real);
    }
    for (const error of [readError, writeError]) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(JoinLineError);
    }
    expect(globalThis.crypto.subtle).toBeDefined();
    expect((await readJoinLine(good.line, READER)).key).toBe(inviteKeys.spki);
  });
});

describe("WebCrypto's own faults are not refusals", () => {
  const fault = (name: string) => new DOMException("injected by the test", name);
  const caught = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);

  test("an OperationError from signing goes up as it came, with nothing of the line", async () => {
    const thrown = fault("OperationError");
    const sign = spyOn(crypto.subtle, "sign").mockImplementation(() => Promise.reject(thrown));
    try {
      expect(await caught(() => readJoinLine(good.line, READER))).toBe(thrown);
    } finally {
      sign.mockRestore();
    }
    expect(leaksOf(thrown, privateTexts(good.line, good.keys))).toEqual([]);
  });

  test("a NotSupportedError from importing goes up as it came, with nothing of the line", async () => {
    const thrown = fault("NotSupportedError");
    const importKey = spyOn(crypto.subtle, "importKey").mockImplementation((() => Promise.reject(thrown)) as typeof crypto.subtle.importKey);
    try {
      expect(await caught(() => readJoinLine(good.line, READER))).toBe(thrown);
    } finally {
      importKey.mockRestore();
    }
    expect(leaksOf(thrown, privateTexts(good.line, good.keys))).toEqual([]);
  });

  test("an OperationError from exporting goes up as it came, with nothing of the key", async () => {
    const key = await importInvite(true);
    const thrown = fault("OperationError");
    const exportKey = spyOn(crypto.subtle, "exportKey").mockImplementation((() => Promise.reject(thrown)) as typeof crypto.subtle.exportKey);
    try {
      expect(await caught(() => writeJoinLine(SERVICE, ACCOUNT, LIST, key))).toBe(thrown);
    } finally {
      exportKey.mockRestore();
    }
    expect(leaksOf(thrown, privateTexts(good.line, good.keys))).toEqual([]);
  });
});

