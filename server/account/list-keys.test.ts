import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isListKeyEncoding, isListPoint, verifySignature } from "../../shared/account-list-entry.ts";
import { cardHolds, signCard } from "../../shared/account-list.ts";
import { ACCOUNT_LIST_KEYS_FILE, forgetListKeys, ListKeysError, ListKeyStore, listKeysPath } from "./list-keys.ts";

const PC_A = "5f1d0c2e9ab34c7781e6f0a2b3c4d5e6";
const PC_B = "00112233445566778899aabbccddeeff";
const LIST = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
const ENDPOINT = "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = () => { const dir = mkdtempSync(join(tmpdir(), "list-keys-")); dirs.push(dir); return dir; };

describe("the PC's list keys (account-list-keys.json)", () => {
  test("the first use makes a signing key and an encryption key, in a file only this user reads", async () => {
    const dir = stateDir();
    const keys = await new ListKeyStore(dir).keysFor(PC_A);
    expect(isListKeyEncoding(keys.key) && isListPoint(keys.key)).toBe(true);
    expect(isListKeyEncoding(keys.enc) && isListPoint(keys.enc)).toBe(true);
    expect(keys.key).not.toBe(keys.enc);
    expect(keys.privateKey.extractable).toBe(false);
    expect(keys.encPrivateKey.extractable).toBe(false);
    if (process.platform !== "win32") expect(statSync(listKeysPath(dir)).mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(listKeysPath(dir), "utf8")) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(["encryption", "server_id", "signing", "v"]);
    expect(file.server_id).toBe(PC_A);
  });

  test("two servers on one state folder that both find no file end with one pair: the one on disk", async () => {
    const dir = stateDir();
    const [a, b] = await Promise.all([new ListKeyStore(dir).keysFor(PC_A), new ListKeyStore(dir).keysFor(PC_A)]);
    expect(a.key).toBe(b.key);
    expect(a.enc).toBe(b.enc);
    const reopened = await new ListKeyStore(dir).keysFor(PC_A);
    expect([reopened.key, reopened.enc]).toEqual([a.key, a.enc]);
    // and no temporary file of the loser stays
    expect(readdirSync(dir).filter((name) => name !== ACCOUNT_LIST_KEYS_FILE)).toEqual([]);
  });

  test("two servers that both find another identity's file end with one pair for the new identity", async () => {
    const dir = stateDir();
    const old = await new ListKeyStore(dir).keysFor(PC_A);
    const [a, b] = await Promise.all([new ListKeyStore(dir).keysFor(PC_B), new ListKeyStore(dir).keysFor(PC_B)]);
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(old.key);
    expect((await new ListKeyStore(dir).keysFor(PC_B)).key).toBe(a.key);
    expect(readdirSync(dir).filter((name) => name !== ACCOUNT_LIST_KEYS_FILE)).toEqual([]);
  });

  test("three servers that find another identity's file at once end with one pair, and no lock stays", async () => {
    const dir = stateDir();
    await new ListKeyStore(dir).keysFor(PC_A);
    const made = await Promise.all([1, 2, 3].map(() => new ListKeyStore(dir).keysFor(PC_B)));
    expect(new Set(made.map((keys) => keys.key)).size).toBe(1);
    expect((await new ListKeyStore(dir).keysFor(PC_B)).key).toBe(made[0]!.key);
    expect(readdirSync(dir)).toEqual([ACCOUNT_LIST_KEYS_FILE]);
  });

  test("keys whose making began before the relay identity was reset are not written after it", async () => {
    const dir = stateDir();
    const making = new ListKeyStore(dir).keysFor(PC_A);
    // the reset comes while the pair is being generated: there is no file to remove yet
    forgetListKeys(dir);
    await expect(making).rejects.toBeInstanceOf(ListKeysError);
    expect(readdirSync(dir)).toEqual([]);
    // the PC it became makes its own
    const next = await new ListKeyStore(dir).keysFor(PC_B);
    expect(JSON.parse(readFileSync(listKeysPath(dir), "utf8")).server_id).toBe(PC_B);
    expect(next.serverId).toBe(PC_B);
  });

  test("a lock an Ovis left behind is taken over, and one that is held makes the call wait and then say so", async () => {
    const dir = stateDir();
    const lock = `${listKeysPath(dir)}.lock`;
    writeFileSync(lock, "");
    // held right now by another Ovis: the call gives up after its wait, and writes nothing
    await expect(new ListKeyStore(dir, 100).keysFor(PC_A)).rejects.toThrow("another Ovis on this state folder");
    expect(readdirSync(dir)).toEqual([`${ACCOUNT_LIST_KEYS_FILE}.lock`]);
    // left behind long ago
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const keys = await new ListKeyStore(dir, 100).keysFor(PC_A);
    expect(keys.serverId).toBe(PC_A);
    expect(readdirSync(dir)).toEqual([ACCOUNT_LIST_KEYS_FILE]);
  });

  test("the signing key signs the PC's card, and what it signs verifies under the public key it names", async () => {
    const keys = await new ListKeyStore(stateDir()).keysFor(PC_A);
    const card = { key: keys.key, enc: keys.enc, list: LIST, endpoint: ENDPOINT, invite: null };
    expect(await cardHolds(card, await signCard(card, keys.privateKey))).toBe(true);
    const bytes = new TextEncoder().encode("a body");
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, bytes));
    expect(await verifySignature(bytes, signature, keys.key)).toBe(true);
  });

  test("a restart reads the same keys back", async () => {
    const dir = stateDir();
    const first = await new ListKeyStore(dir).keysFor(PC_A);
    const again = await new ListKeyStore(dir).keysFor(PC_A);
    expect([again.key, again.enc]).toEqual([first.key, first.enc]);
  });

  test("two callers at once get one pair", async () => {
    const store = new ListKeyStore(stateDir());
    const [one, two] = await Promise.all([store.keysFor(PC_A), store.keysFor(PC_A)]);
    expect(two.key).toBe(one.key);
  });

  test("another relay identity is a new PC: its keys replace the old ones, which are gone from the file", async () => {
    const dir = stateDir();
    const store = new ListKeyStore(dir);
    const old = await store.keysFor(PC_A);
    const before = readFileSync(listKeysPath(dir), "utf8");
    const next = await store.keysFor(PC_B);
    expect(next.key).not.toBe(old.key);
    expect(next.enc).not.toBe(old.enc);
    const after = JSON.parse(readFileSync(listKeysPath(dir), "utf8")) as { server_id: string; signing: string; encryption: string };
    expect(after.server_id).toBe(PC_B);
    const was = JSON.parse(before) as { signing: string; encryption: string };
    expect(after.signing).not.toBe(was.signing);
    expect(after.encryption).not.toBe(was.encryption);
    // the old identity does not come back with its old keys either
    expect((await store.keysFor(PC_A)).key).not.toBe(old.key);
  });

  test("a reset relay identity removes the file at once, also one that will not read", async () => {
    const dir = stateDir();
    writeFileSync(listKeysPath(dir), "{ not json");
    await expect(new ListKeyStore(dir).keysFor(PC_A)).rejects.toBeInstanceOf(ListKeysError);
    forgetListKeys(dir);
    expect(() => readFileSync(listKeysPath(dir))).toThrow();
    expect(isListKeyEncoding((await new ListKeyStore(dir).keysFor(PC_B)).key)).toBe(true);
  });

  test.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 2, server_id: PC_A, signing: "a".repeat(184), encryption: "a".repeat(184) })],
    ["a member too many", JSON.stringify({ v: 1, server_id: PC_A, signing: "a".repeat(184), encryption: "a".repeat(184), extra: 1 })],
    ["a secret that is no key", JSON.stringify({ v: 1, server_id: PC_A, signing: "a".repeat(184), encryption: "a".repeat(184) })],
  ])("a file that will not read (%s) is never replaced, and the refusal names nothing in it", async (_name, text) => {
    const dir = stateDir();
    writeFileSync(listKeysPath(dir), text);
    const error = await new ListKeyStore(dir).keysFor(PC_A).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ListKeysError);
    expect((error as Error).message).toStartWith(`${ACCOUNT_LIST_KEYS_FILE} cannot be used`);
    expect((error as Error).message).not.toContain("aaaa");
    expect(readFileSync(listKeysPath(dir), "utf8")).toBe(text);
  });

  test("a file whose signing secret was swapped for another key's still reads only as a whole key", async () => {
    const dir = stateDir();
    await new ListKeyStore(dir).keysFor(PC_A);
    const file = JSON.parse(readFileSync(listKeysPath(dir), "utf8")) as { signing: string };
    // one character of the private value changed: the public point in the secret is no longer its own
    const at = 60;
    const swapped = file.signing.slice(0, at) + (file.signing[at] === "A" ? "B" : "A") + file.signing.slice(at + 1);
    writeFileSync(listKeysPath(dir), JSON.stringify({ ...file, signing: swapped }));
    await expect(new ListKeyStore(dir).keysFor(PC_A)).rejects.toBeInstanceOf(ListKeysError);
  });
});
