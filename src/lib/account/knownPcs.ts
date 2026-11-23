/**
 * The account's PCs that My PCs listed from the account at its last read that answered, by id and name alone, kept on
 * this device for the account signed in then: a page that cannot read the account (no internet) still lists them, with no
 * word of their state. Nothing here opens or admits a PC: its row leads to its own page, which decides as it always does.
 */
import type { MyPc } from "./myPcs.ts";

export interface KnownPc { readonly server_id: string; readonly name: string }

const KEY = "ovis-account-pcs";
const SERVER_ID = /^[0-9a-f]{32}$/;

/** The rows My PCs adds from the account (ConnectStart relayTabPcs): a PC this device is not paired with that it can open. */
export function keepKnownPcs(account: string, pcs: readonly MyPc[]): void {
  const listed = pcs.filter((pc) => !pc.paired && pc.join !== undefined).map((pc): KnownPc => ({ server_id: pc.server_id, name: pc.name }));
  try { localStorage.setItem(KEY, JSON.stringify({ account, pcs: listed })); } catch { /* a page without storage lists them only while it reads them */ }
}

export function knownPcs(account: string): KnownPc[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof kept !== "object" || kept === null || !("account" in kept) || kept.account !== account || !("pcs" in kept) || !Array.isArray(kept.pcs)) return [];
    return (kept.pcs as unknown[]).flatMap((pc) => typeof pc === "object" && pc !== null && "server_id" in pc && typeof pc.server_id === "string" && SERVER_ID.test(pc.server_id) && "name" in pc && typeof pc.name === "string"
      ? [{ server_id: pc.server_id, name: pc.name }] : []);
  } catch { return []; }
}

/** Signed out, or the account left or deleted: its PCs' names stay on this device no longer. */
export function dropKnownPcs(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing was kept */ }
}
