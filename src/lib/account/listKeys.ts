/**
 * The keys this device is a member of its account's signed list with (docs/account-list.md, "On a device"). Its
 * member key is its account key (store.ts), which signs entries and cards as it signs everything else. Its
 * encryption key is a second key, ECDH P-256, made on first need: epoch keys are wrapped to it. Both are made by
 * WebCrypto so that they cannot be exported, and kept in `ovis-account` as the CryptoKeys they are.
 */
import { signCard } from "../../../shared/account-list.ts";
import { isListKeyEncoding, isListPoint } from "../../../shared/account-list-entry.ts";
import { generateDeviceEncryptionKey, type MemberEncryptionKey } from "../../../shared/account-list-seal.ts";
import type { AccountKey, AccountStore } from "./store.ts";

export interface DeviceListKeys {
  /** The member key: the account key's public half, in the spelling of an entry's `signer`. */
  readonly key: string;
  /** The account key's private half: it signs entries and cards. */
  readonly signs: CryptoKey;
  readonly enc: MemberEncryptionKey;
}

/** What a device gives whoever lets it in: its two public keys and its card for one list. */
export interface DeviceCard {
  readonly key: string;
  readonly enc: string;
  readonly card: string;
}

/** A stored encryption key in its form: a key on the curve, and a private half that derives and cannot be exported. */
function isEncryptionKey(value: unknown): value is MemberEncryptionKey {
  if (typeof value !== "object" || value === null) return false;
  const { key, privateKey } = value as { key?: unknown; privateKey?: unknown };
  if (typeof key !== "string" || !isListKeyEncoding(key) || !isListPoint(key)) return false;
  return privateKey instanceof CryptoKey && privateKey.type === "private" && privateKey.algorithm.name === "ECDH" && !privateKey.extractable && privateKey.usages.includes("deriveBits");
}

/** This device's encryption key, made at most once, between tabs too. A stored value that is no such key is replaced: nothing opens with it. */
async function encryptionKey(store: AccountStore): Promise<MemberEncryptionKey> {
  const kept = await store.get("enc_key");
  if (isEncryptionKey(kept)) return kept;
  // made outside the transaction, which would commit while WebCrypto works; another tab's key, saved first, wins
  const made = await generateDeviceEncryptionKey();
  let ours = made;
  await store.update("enc_key", (current) => {
    ours = isEncryptionKey(current) ? current : made;
    return ours;
  });
  return ours;
}

/** An account key whose public half is a list key: any other signs nothing a member would take. */
function memberKey(account: AccountKey): boolean {
  return isListKeyEncoding(account.public_spki) && isListPoint(account.public_spki);
}

export async function deviceListKeys(store: AccountStore): Promise<DeviceListKeys> {
  const account = await store.key();
  if (!memberKey(account)) throw new RangeError("This device's account key is no key of a list");
  return { key: account.public_spki, signs: account.private_key, enc: await encryptionKey(store) };
}

/**
 * This device's card for `list`: its own signature over its two keys and the list id, made before anybody lets it
 * in. The entry that adds the device carries it, so nobody can name a key that never asked, or give this device an
 * encryption key that is not its own.
 */
export async function deviceCard(keys: DeviceListKeys, list: string): Promise<DeviceCard> {
  return { key: keys.key, enc: keys.enc.key, card: await signCard({ key: keys.key, enc: keys.enc.key, list, endpoint: null, invite: null }, keys.signs) };
}
