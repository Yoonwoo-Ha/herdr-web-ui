/**
 * What scripts/account-list-device-browser-qa.ts runs inside a real browser: a device's own copy of its account's
 * signed list, with the stores, the keys and the locks the app uses there (IndexedDB, WebCrypto, Web Locks).
 */
import { LIST_LEVEL, kindBody, namesFields, replayList, sealEpoch, signListEntry } from "../shared/account-list.ts";
import { entryToText, signEntry } from "../shared/account-list-entry.ts";
import { openWrap, sealFields, wrapEpochKey, wrapFromText, wrapToText } from "../shared/account-list-seal.ts";
import { accountList, type AccountListView, type ListOffer } from "../src/lib/account/accountList.ts";
import { allowDevice, type AllowOutcome, type Newcomer } from "../src/lib/account/listAllow.ts";
import { deviceListKeys } from "../src/lib/account/listKeys.ts";
import { readWraps } from "../src/lib/account/listNames.ts";
import { LIST_RECORDS, indexedListStore } from "../src/lib/account/listStore.ts";
import { AccountService } from "../src/lib/account/service.ts";
import { indexedAccountStore, newKey, type AccountSession } from "../src/lib/account/store.ts";

const service = new AccountService({ store: indexedAccountStore });
const list = accountList({ service, accountStore: indexedAccountStore, names: () => ({ label: "QA phone", os: "android" }), genesis: () => "first-device", durable: async () => true });

/** Stores a sign-in as the app does after one, with the key that sign-in registers with the account service; answers that key. */
export async function signIn(session: AccountSession): Promise<string> {
  const key = await newKey();
  await indexedAccountStore.set("session", session);
  await indexedAccountStore.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id ?? "", key, no: null });
  return key.public_spki;
}

/** The account service took the sign-in's key at this place in the account's order. */
export async function registered(no: number): Promise<void> {
  await indexedAccountStore.update("signin_key", (kept) => kept === undefined ? kept : { ...kept, no });
}

export function sync(): Promise<AccountListView> {
  return list.sync();
}

function read(database: string, store: string, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(database);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const request = opening.result.transaction(store).objectStore(store).get(name);
      request.onsuccess = () => { opening.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
    };
  });
}

async function keyFacts(key: unknown): Promise<{ stored: string; extractable: boolean | null; algorithm: string | null; usages: readonly string[]; exported: readonly string[] }> {
  if (!(key instanceof CryptoKey)) return { stored: typeof key, extractable: null, algorithm: null, usages: [], exported: [] };
  const exported: string[] = [];
  for (const format of ["pkcs8", "jwk", "raw"] as const) {
    exported.push(await crypto.subtle.exportKey(format, key).then(() => "exported", (error: unknown) => (error instanceof DOMException ? error.name : "threw")));
  }
  return { stored: "CryptoKey", extractable: key.extractable, algorithm: key.algorithm.name, usages: key.usages, exported };
}

/** The device's two keys as IndexedDB holds them, read with no code of the app in between. */
export async function storedKeys() {
  const member = await read("ovis-account", "account", "key") as { public_spki?: unknown; private_key?: unknown } | undefined;
  const enc = await read("ovis-account", "account", "enc_key") as { key?: unknown; privateKey?: unknown } | undefined;
  return { member: { key: member?.public_spki ?? null, ...await keyFacts(member?.private_key) }, enc: { key: enc?.key ?? null, ...await keyFacts(enc?.privateKey) } };
}

/** Whether a stored value is text, numbers, yes or no, nothing, and lists and records of those: no key, no bytes, nothing else IndexedDB can hold and JSON cannot. */
function isPlain(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlain);
  if (typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.values(value).every(isPlain);
}

/** What the device keeps of the account's list, as text. The stored value itself is looked at first: turned into text, bytes and keys would pass for records. */
export async function kept(account: string): Promise<Record<string, string | null>> {
  const records: Record<string, string | null> = {};
  for (const record of LIST_RECORDS) {
    const value = await indexedListStore.get(record, account);
    if (value !== undefined && !isPlain(value)) throw new Error(`The ${record} record is not plain data`);
    records[record] = value === undefined ? null : JSON.stringify(value);
  }
  return records;
}

/**
 * The device adds a PC that posted its keys and its card, under a name it seals with the current epoch's key. That
 * key comes out of the wrap the device keeps, opened with the encryption key IndexedDB holds; the entry is signed
 * with the member key IndexedDB holds.
 */
export async function addPc(pc: { readonly endpoint: string; readonly key: string; readonly enc: string; readonly card: string }, label: string): Promise<number> {
  const session = await service.session();
  const view = list.view();
  if (session === undefined || view.status.at !== "following") throw new Error("The device follows no list");
  const keys = await deviceListKeys(indexedAccountStore);
  const { list: id } = view.status;
  const log = await service.listLog(id, null);
  const replayed = await replayList(log.entries, LIST_LEVEL, { saved: null, given: id });
  if (replayed.member === null) throw new Error("The log does not replay");
  const { state } = replayed.member;
  const at = Math.floor(Date.now() / 1000);
  // the kinds say whether a writer may seal, and under which epoch: no writer decides it
  const where = sealEpoch(state, at);
  if (where === null) throw new Error("No name may be sealed where the list stands");
  const wrap = readWraps(await indexedListStore.get("wraps", session.account), id, keys.enc.key).wraps.get(where.epoch);
  const opened = await openWrap({ list: id, epoch: where.epoch, commitment: where.opens, wrap: wrap === undefined ? null : wrapFromText(wrap), member: keys.enc });
  if (!opened.open) throw new Error(`The device's wrap does not open: ${opened.why}`);
  const place = { list: id, seq: state.footing.seq + 1 };
  const sealed = { epoch: where.epoch, bytes: await sealFields({ place, epoch: opened.value, commitment: where.opens, fields: namesFields({ label, os: "linux" }) }) };
  // and a member signs only through the kinds' writer, which signs nothing that would not count
  const written = await signListEntry(state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card: pc.card, sealed }, { key: keys.key, privateKey: keys.signs }, at);
  const forPc = await wrapEpochKey({ list: id, epoch: opened.value, member: pc.enc });
  if (forPc === null) throw new Error("The PC's encryption key is no key of the list");
  const response = await fetch(`/v2/lists/${id}/entries`, {
    method: "POST", headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ entries: [written.text], wraps: [{ epoch: where.epoch, member: pc.enc, wrap: wrapToText(forPc) }] }),
  });
  return response.status;
}

/** An entry this device signs at a place of any list: what a key that is no member of that list can write there. */
export async function entryAt(at: { readonly list: string; readonly seq: number; readonly prev: string }, endpoint: string): Promise<string> {
  const keys = await deviceListKeys(indexedAccountStore);
  const body = kindBody({ issued_at: Math.floor(Date.now() / 1000), list: at.list, prev: at.prev, seq: at.seq, signer: keys.key }, { kind: "carried", endpoint, sealed: null });
  return entryToText(await signEntry(body, keys.signs));
}

/** This device's member key, as a device that lets it in is given it by the comparing of digits. */
export async function memberKey(): Promise<string> {
  return (await deviceListKeys(indexedAccountStore)).key;
}

/** This device lets another in: the `device` entry is signed with the member key IndexedDB holds, through the kinds' writer. */
export function allow(newcomer: Newcomer): Promise<AllowOutcome> {
  return allowDevice(list, newcomer);
}

/** This device takes the place a member handed it. */
export function adopt(offer: ListOffer): Promise<AccountListView> {
  return list.adopt(offer);
}
