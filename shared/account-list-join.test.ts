import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JOIN_LINE_PREFIX, JOIN_SECRET_BYTES, JoinLineError, isServiceOrigin, readJoinLine, writeJoinLine, type JoinLineReason } from "./account-list-join.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const SERVICE = "https://accounts.ovis.test";
const LIST = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
const DIR = join(import.meta.dir, "account-list-vectors", "join");

interface KeyPair { readonly pkcs8: string; readonly spki: string }
interface JoinVector {
  readonly name: string;
  readonly keys: Readonly<Record<string, KeyPair>>;
  readonly line: string;
  readonly expect: { readonly service: string; readonly list: string; readonly key: string } | { readonly stops: { readonly code: "line_malformed"; readonly reason: JoinLineReason } };
}
const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as JoinVector);
const good = vectors.find((vector) => vector.name === "join-line");
if (!good) throw new Error("join/join-line.json is missing");
const inviteKeys = good.keys["TEST-ONLY-invite"];
if (!inviteKeys) throw new Error("join-line has no TEST-ONLY-invite key");

async function refusal(line: string): Promise<JoinLineError | null> {
  try {
    await readJoinLine(line);
  } catch (error) {
    if (error instanceof JoinLineError) return error;
    throw error;
  }
  return null;
}
const importInvite = (extractable: boolean) => crypto.subtle.importKey("pkcs8", fromBase64Url(inviteKeys.pkcs8) as Uint8Array<ArrayBuffer>, P256, extractable, ["sign"]);
const encode = (json: string) => `${JOIN_LINE_PREFIX}${toBase64Url(new TextEncoder().encode(json))}`;

describe("the vectors of join/", () => {
  test("names: one good line and the refusals the line format defines", () => {
    const names = vectors.map((vector) => vector.name);
    for (const name of ["join-line", "line-no-prefix", "line-prefix-version-2", "v-2", "line-padded", "line-outside-alphabet", "line-second-spelling",
      "member-missing", "member-extra", "member-twice", "members-other-order", "json-white-space", "v-1-0", "v-string", "service-http", "service-path",
      "service-trailing-slash", "service-default-port", "service-uppercase-host", "list-not-a-hash", "secret-not-base64url", "secret-139-bytes",
      "secret-other-curve", "secret-no-public-key", "secret-other-point"]) expect(names).toContain(name);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      const { expect: want } = vector;
      if ("stops" in want) {
        const error = await refusal(vector.line);
        expect(error?.code).toBe(want.stops.code);
        expect(error?.reason).toBe(want.stops.reason);
        return;
      }
      const read = await readJoinLine(vector.line);
      expect({ service: read.service, list: read.list, key: read.key }).toEqual(want);
    });
  }

  test("the good line is written again, byte for byte, from its key; its secret is Bun's own PKCS8 export of that key", async () => {
    expect(await writeJoinLine(SERVICE, LIST, await importInvite(true))).toBe(good.line);
    const exported = new Uint8Array(await crypto.subtle.exportKey("pkcs8", await importInvite(true)));
    const json = JSON.parse(new TextDecoder().decode(fromBase64Url(good.line.slice(JOIN_LINE_PREFIX.length)))) as { secret: string };
    expect(json.secret).toBe(toBase64Url(exported));
  });
});

describe("writing a line", () => {
  test("a fresh key: the line reads back to its service, its list and its public key, and its secret signs for that key", async () => {
    const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
    const line = await writeJoinLine(SERVICE, LIST, pair.privateKey);
    const read = await readJoinLine(line);
    expect(read.service).toBe(SERVICE);
    expect(read.list).toBe(LIST);
    expect(read.key).toBe(toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))));
    const signature = await crypto.subtle.sign(SIGN, read.privateKey, new Uint8Array([1, 2, 3]));
    expect(await crypto.subtle.verify(SIGN, pair.publicKey, signature, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(read.privateKey.extractable).toBe(false);
  });

  test("the secret is the 138 bytes built from d, x and y, equal to Bun's PKCS8 export, for many keys", async () => {
    for (let index = 0; index < 20; index++) {
      const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
      const line = await writeJoinLine(SERVICE, LIST, pair.privateKey);
      const json = JSON.parse(new TextDecoder().decode(fromBase64Url(line.slice(JOIN_LINE_PREFIX.length)))) as { secret: string };
      const exported = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      expect(exported.length).toBe(JOIN_SECRET_BYTES);
      expect(json.secret).toBe(toBase64Url(exported));
    }
  });

  test("the writer refuses what no line may hold", async () => {
    const key = await importInvite(true);
    const reasonOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        if (error instanceof JoinLineError) return error.reason;
        throw error;
      }
      return "none";
    };
    expect(await reasonOf(() => writeJoinLine("http://accounts.ovis.test", LIST, key))).toBe("service");
    expect(await reasonOf(() => writeJoinLine(`${SERVICE}/`, LIST, key))).toBe("service");
    expect(await reasonOf(() => writeJoinLine(SERVICE, LIST.slice(1), key))).toBe("list");
    expect(await reasonOf(async () => writeJoinLine(SERVICE, LIST, await importInvite(false)))).toBe("secret");
    const p384 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign"]);
    expect(await reasonOf(() => writeJoinLine(SERVICE, LIST, p384.privateKey))).toBe("secret");
  });
});

describe("reading a line: each way it can be wrong, with the smallest input", () => {
  const cases: [string, string, JoinLineReason][] = [
    ["empty", "", "prefix"],
    ["the prefix alone", JOIN_LINE_PREFIX, "base64url"],
    ["a trailing newline", `${good.line}\n`, "base64url"],
    ["white space before", ` ${good.line}`, "prefix"],
    ["an empty object", encode("{}"), "members"],
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
      const fixedByteChanged = encode(`{"v":1,"service":"${SERVICE}","list":"${LIST}","secret":"${toBase64Url(secret)}"}`);
      importKey.mockClear();
      expect((await refusal(fixedByteChanged))?.reason).toBe("secret");
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
      const alone = Uint8Array.from([0x30, 0x41, 0x02, 0x01, 0x00, ...data.subarray(6, 27), 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20, ...data.subarray(36, 68)]);
      return original("pkcs8", alone, algorithm, extractable, usages);
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

describe("a runtime without WebCrypto", () => {
  test("is a fault: the reader and the writer throw, and neither blames the line", async () => {
    const key = await importInvite(true);
    const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    if (!real) throw new Error("no crypto here to take away");
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: crypto.getRandomValues.bind(crypto) }, configurable: true, writable: true });
    let readError: unknown = null;
    let writeError: unknown = null;
    try {
      await readJoinLine(good.line).catch((error: unknown) => { readError = error; });
      await writeJoinLine(SERVICE, LIST, key).catch((error: unknown) => { writeError = error; });
    } finally {
      Object.defineProperty(globalThis, "crypto", real);
    }
    for (const error of [readError, writeError]) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(JoinLineError);
    }
    expect(globalThis.crypto.subtle).toBeDefined();
    expect((await readJoinLine(good.line)).key).toBe(inviteKeys.spki);
  });
});

describe("the secret never shows in a refusal", () => {
  test("no refusal's message or fields hold the secret or any 12 characters of the line after its prefix", async () => {
    for (const vector of vectors) {
      if (!("stops" in vector.expect)) continue;
      const error = await refusal(vector.line);
      if (!error) throw new Error(`${vector.name} was not refused`);
      const shown = `${error.message} ${JSON.stringify({ ...error })} ${String(error.stack ?? "").split("\n")[0]}`;
      const payload = vector.line.startsWith(JOIN_LINE_PREFIX) ? vector.line.slice(JOIN_LINE_PREFIX.length) : vector.line;
      for (const secretText of Object.values(vector.keys).map((pair) => pair.pkcs8)) expect(shown.includes(secretText.slice(0, 24))).toBe(false);
      for (let index = 0; index + 12 <= payload.length; index += 6) expect(shown.includes(payload.slice(index, index + 12))).toBe(false);
      expect(Object.keys(error).sort()).toEqual(["code", "name", "reason"]);
      expect(error.cause).toBeUndefined();
    }
  });
});
