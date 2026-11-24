import { describe, expect, it } from "bun:test";
import { cardHolds } from "../../../shared/account-list.ts";
import { deviceCard, deviceListKeys } from "./listKeys.ts";
import { memoryAccountStore } from "./store.ts";

const LIST = "5c".repeat(32);

describe("the keys a device is a member of its account's list with", () => {
  it("signs with its account key, and makes one encryption key that it keeps", async () => {
    const store = memoryAccountStore();
    const [first, second] = await Promise.all([deviceListKeys(store), deviceListKeys(store)]);
    const again = await deviceListKeys(store);
    expect(first.key).toBe((await store.key()).public_spki);
    expect(first.signs).toBe((await store.key()).private_key);
    expect(second.enc.key).toBe(first.enc.key);
    expect(again.enc.key).toBe(first.enc.key);
    expect(again.enc.key).not.toBe(first.key);
  });

  it("holds neither private key in a form that can leave the device", async () => {
    const keys = await deviceListKeys(memoryAccountStore());
    expect([keys.signs.extractable, keys.signs.algorithm.name, keys.signs.usages]).toEqual([false, "ECDSA", ["sign"]]);
    expect([keys.enc.privateKey.extractable, keys.enc.privateKey.algorithm.name, keys.enc.privateKey.usages]).toEqual([false, "ECDH", ["deriveBits"]]);
    for (const key of [keys.signs, keys.enc.privateKey]) {
      for (const format of ["pkcs8", "jwk"] as const) expect(crypto.subtle.exportKey(format, key)).rejects.toThrow();
    }
  });

  it("forgets the encryption key with the account key: a device with a new account key names a new one", async () => {
    const store = memoryAccountStore();
    const before = await deviceListKeys(store);
    await store.clear();
    const after = await deviceListKeys(store);
    expect(after.key).not.toBe(before.key);
    expect(after.enc.key).not.toBe(before.enc.key);
  });

  it("replaces a stored value that is no encryption key of its own", async () => {
    const store = memoryAccountStore();
    const other = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const before = await deviceListKeys(store);
    // a private half that can be exported is not one this device made
    await store.set("enc_key", { key: before.enc.key, privateKey: other.privateKey });
    const after = await deviceListKeys(store);
    expect(after.enc.privateKey.extractable).toBe(false);
    expect(after.enc.key).not.toBe(before.enc.key);
  });

  it("makes a card that holds for its two keys and one list, and for no other list or encryption key", async () => {
    const keys = await deviceListKeys(memoryAccountStore());
    const other = await deviceListKeys(memoryAccountStore());
    const card = await deviceCard(keys, LIST);
    expect(card).toEqual({ key: keys.key, enc: keys.enc.key, card: expect.any(String) });
    const holds = (list: string, enc: string, key = keys.key) => cardHolds({ key, enc, list, endpoint: null, invite: null }, card.card);
    expect(await holds(LIST, keys.enc.key)).toBe(true);
    expect(await holds("6d".repeat(32), keys.enc.key)).toBe(false);
    expect(await holds(LIST, other.enc.key)).toBe(false);
    expect(await holds(LIST, keys.enc.key, other.key)).toBe(false);
    // a device's card is no PC's
    expect(await cardHolds({ key: keys.key, enc: keys.enc.key, list: LIST, endpoint: "ab".repeat(32), invite: null }, card.card)).toBe(false);
  });
});
