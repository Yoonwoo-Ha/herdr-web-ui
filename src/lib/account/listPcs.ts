/**
 * The PCs of an account whose devices and PCs come in by its signed list (docs/account-list.md, "PCs of a list
 * account"), for a device that follows that list and is in it. They are what the list holds, by relay key, under the
 * names the list seals. The account service's directory only says how to reach one: its relay, and whether the PC was
 * lately there. A route the directory gives for another key than the one the list holds is no route.
 *
 * A PC that the directory alone names stays on the screen, after the list's own and marked `not_in_list`: a person
 * never loses a PC from view (a PC on an Ovis from before lists cannot be in one). Such a row is the directory's as it
 * is; nothing opens it by itself and nothing is told of it, and a tap opens it the way from before.
 *
 * The rows have the directory's form (DirectoryPc), a list's marked `by_list`, so that everything that draws or opens
 * the account's PCs goes on as it does. What the account service says of a list PC being new, or added before this
 * device joined, is dropped: a PC is new to this device for a day from when it first held the entry that brought the
 * PC in, unless it signed that entry itself or the PC was in before it.
 *
 * A device that cannot read its list (its copy is damaged, a later build saved it, or it stopped at an entry this
 * build cannot place) lists the directory's PCs, every one marked, and says so (listReading).
 */
import type { AccountList, AccountListView } from "./accountList.ts";
import { pageAccountList } from "./pageList.ts";
import type { DirectoryPc } from "./service.ts";

/** How long a PC that another member added is new to this device: it opens only by hand meanwhile, and its notice stays. */
export const NEW_LIST_PC_MS = 24 * 60 * 60_000;

/**
 * How this device reads the list of `account`: `in`, it follows the list and is in it; `newer`, only a newer app
 * reads its list (a later build saved the copy, or the list holds an entry this build cannot place); `damaged`, what
 * it saved does not read. Null where it goes by the directory alone: the account has no list, or the device is in none.
 */
export type ListReading = "in" | "newer" | "damaged";

/**
 * Whether this device holds a copy of `account`'s list that `list`, this page's, has not read: no read ended yet, or
 * the read failed. It is a state of its own and never "no list": until a read ends, every row is the directory's and
 * marked, nothing opens or asks by itself, and nothing leaves the account by the account service's directory. A
 * store that cannot even be asked counts as holding a copy.
 */
export async function unreadCopy(list: AccountList, account: string): Promise<boolean> {
  if (list.view().account === account) return false;
  try { return await list.follows(account); } catch { return true; }
}

/** The account whose saved copy this page found unread (readPageList), until a view of that account is there. */
let unreadFor: string | null = null;

/**
 * Has this page read its list for `account`, where the device holds a copy: waits for a round, the first or one
 * more, and remembers where none ended. After it, the page's rows and acts go by the list or by "not read"
 * (pageListUnread), never by the directory alone for a device that holds a copy.
 */
export async function readPageList(account: string): Promise<void> {
  const list = pageAccountList();
  if (list === null || !await unreadCopy(list, account)) { if (unreadFor === account) unreadFor = null; return; }
  unreadFor = account;
  await list.sync().catch((error: unknown) => { console.warn("Ovis: the account's list could not be read on this page", error instanceof Error ? error.name : error); });
  if (list.view().account === account) unreadFor = null;
}

/** Whether this page holds a copy of `account`'s list that it has not read (readPageList found so, and no view of the account came since). */
export function pageListUnread(account: string): boolean {
  if (unreadFor !== account) return false;
  if (pageAccountList()?.view().account === account) { unreadFor = null; return false; }
  return pageAccountList() !== null;
}

export function listReading(view: AccountListView | null | undefined, account: string): ListReading | null {
  if (view == null || view.account !== account) return null;
  const { status } = view;
  if (status.at === "damaged") return "damaged";
  if (status.at === "newer_save") return "newer";
  if (status.at !== "following") return null;
  return status.standing === "in" ? "in" : status.standing === "stopped" ? "newer" : null;
}

/** The directory's rows, every one marked: what a device draws that cannot read its list, or has not read it yet. */
export const allOutside = (directory: readonly DirectoryPc[]): DirectoryPc[] => directory.map((pc) => ({ ...pc, not_in_list: true as const }));

/** The account's PCs as `view` gives them, or null where the directory stands as it is: this device is in no list of `account`. */
export function pcsByList(view: AccountListView | null | undefined, account: string, directory: readonly DirectoryPc[], now: number): DirectoryPc[] | null {
  const reading = listReading(view, account);
  if (view == null || reading === null) return null;
  const outside = (pc: DirectoryPc): DirectoryPc => ({ ...pc, not_in_list: true });
  if (reading !== "in") return directory.map(outside);
  const listed = new Map(directory.map((pc) => [pc.server_id, pc]));
  const held = new Set(view.pcs.map((pc) => pc.server_id));
  return [...view.pcs.map((pc): DirectoryPc => {
    const named = listed.get(pc.server_id);
    const route = named !== undefined && named.public_key === pc.endpoint && named.relay !== null ? named : undefined;
    const newUntil = pc.new_at === null ? null : pc.new_at * 1000 + NEW_LIST_PC_MS;
    const isNew = newUntil !== null && now < newUntil;
    const addedBy = isNew && pc.by !== null ? view.devices.find((device) => device.key === pc.by)?.name?.label : undefined;
    return {
      server_id: pc.server_id, label: pc.name?.label ?? pc.server_id.slice(0, 8), added_at: route?.added_at ?? "",
      last_seen_at: route?.last_seen_at ?? null, public_key: route === undefined ? null : pc.endpoint, relay: route?.relay ?? null,
      new_until: isNew ? new Date(newUntil).toISOString() : null, admitted_at: null, admitted_before_you: false, by_list: true as const,
      ...(addedBy === undefined ? {} : { added_by: addedBy }),
    };
  }), ...directory.filter((pc) => !held.has(pc.server_id)).map(outside)];
}

/** How this page reads the list of `account` (listReading), by the page's own list. */
export function pageListReading(account: string): ListReading | null {
  return listReading(pageAccountList()?.view(), account);
}

/** The account's PCs as this page lists them: by its list where this device is in one, by the account service's directory otherwise. */
export function pagePcs(account: string, directory: readonly DirectoryPc[], now = Date.now()): readonly DirectoryPc[] {
  if (pageListUnread(account)) return allOutside(directory);
  return pcsByList(pageAccountList()?.view(), account, directory, now) ?? directory;
}

/** The relay key of a PC that the page's list holds for `account`, or null: such a PC leaves the account by an entry of the list. */
export function pageListPc(account: string, serverId: string): string | null {
  const view = pageAccountList()?.view();
  return view == null || listReading(view, account) !== "in" ? null : view.pcs.find((pc) => pc.server_id === serverId)?.endpoint ?? null;
}
