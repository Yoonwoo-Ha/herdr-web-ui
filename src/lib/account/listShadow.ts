/**
 * What this device's verified list and the account service's directory differ in (docs/account-list.md, "On a
 * device"). The app still lists and opens the account's PCs by the directory; this records, on the device, where
 * the list would have said otherwise, so that the change which makes the app go by the list has something to go on.
 * Nothing is decided by it, and what is logged holds counts only: no name, no id, no key.
 */
import type { AccountListView } from "./accountList.ts";
import type { ListStore } from "./listStore.ts";
import type { DirectoryPc } from "./service.ts";

/** A PC the directory lists and the list does not hold. */
export interface UnlistedPc {
  readonly server_id: string;
  /** The PC itself has pulled this account's mailbox: its listing is more than somebody's word. */
  readonly seen: boolean;
  /** The app would open it by itself today. */
  readonly opens: boolean;
}

/** One comparison. `head` is the place of the copy's last entry, `at` this device's clock in ms. */
export interface ListShadow {
  readonly at: number;
  readonly head: number;
  /** How many PCs both name. */
  readonly both: number;
  readonly service_only: readonly UnlistedPc[];
  /** The ids of PCs the list holds and the directory does not list. */
  readonly list_only: readonly string[];
}

/** What a device keeps of its comparisons: how many it made, how many differed, and the last one. */
export interface ShadowRecord {
  readonly compared: number;
  readonly differed: number;
  readonly last: ListShadow;
}

const RECORD_VERSION = 1;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/**
 * The comparison of a view with the directory read for the same account, or null where there is nothing to compare:
 * the device follows no list, or is not in it. `opens`: the ids of the PCs the app would open by itself.
 */
export function shadowOf(view: AccountListView, directory: readonly DirectoryPc[], at: number, opens: ReadonlySet<string> = new Set()): ListShadow | null {
  const { status } = view;
  if (status.at !== "following" || status.standing !== "in") return null;
  const listed = new Set(view.pcs.map((pc) => pc.server_id));
  const named = new Set(directory.map((pc) => pc.server_id));
  return {
    at,
    head: status.head,
    both: directory.filter((pc) => listed.has(pc.server_id)).length,
    service_only: directory.filter((pc) => !listed.has(pc.server_id)).map((pc) => ({ server_id: pc.server_id, seen: pc.last_seen_at !== null, opens: opens.has(pc.server_id) })),
    list_only: view.pcs.filter((pc) => !named.has(pc.server_id)).map((pc) => pc.server_id),
  };
}

export const differs = (shadow: ListShadow): boolean => shadow.service_only.length > 0 || shadow.list_only.length > 0;

function readShadow(value: unknown): ListShadow | null {
  if (!isRecord(value) || !isCount(value.at) || !isCount(value.head) || !isCount(value.both) || !Array.isArray(value.service_only) || !Array.isArray(value.list_only)) return null;
  const service_only: UnlistedPc[] = [];
  for (const pc of value.service_only as readonly unknown[]) {
    if (!isRecord(pc) || !isId(pc.server_id) || typeof pc.seen !== "boolean" || typeof pc.opens !== "boolean") return null;
    service_only.push({ server_id: pc.server_id, seen: pc.seen, opens: pc.opens });
  }
  const list_only = (value.list_only as readonly unknown[]).filter(isId);
  return list_only.length === value.list_only.length ? { at: value.at, head: value.head, both: value.both, service_only, list_only } : null;
}

export function readShadowRecord(value: unknown): ShadowRecord | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION || !isCount(value.compared) || !isCount(value.differed) || value.differed > value.compared) return null;
  const last = readShadow(value.last);
  return last === null ? null : { compared: value.compared, differed: value.differed, last };
}

/** What two comparisons have in common when nothing changed between them: who is where, whatever the hour. */
const pictureOf = (shadow: ListShadow): string => JSON.stringify([shadow.both, [...shadow.service_only].sort((a, b) => a.server_id.localeCompare(b.server_id)), [...shadow.list_only].sort()]);

/** Keeps a comparison, and says so once each time the difference is another than before: counts, and nothing that names a PC. */
export async function keepShadow(store: ListStore, account: string, shadow: ListShadow): Promise<ShadowRecord> {
  const before = readShadowRecord(await store.get("shadow", account));
  const record: ShadowRecord = { compared: (before?.compared ?? 0) + 1, differed: (before?.differed ?? 0) + (differs(shadow) ? 1 : 0), last: shadow };
  await store.set("shadow", account, { v: RECORD_VERSION, ...record });
  if ((before === null ? differs(shadow) : pictureOf(before.last) !== pictureOf(shadow))) {
    console.info("Ovis: the account's list and the account service's directory", differs(shadow) ? "differ" : "agree again", {
      both: shadow.both,
      service_only: shadow.service_only.length,
      service_only_opening: shadow.service_only.filter((pc) => pc.opens).length,
      list_only: shadow.list_only.length,
    });
  }
  return record;
}
