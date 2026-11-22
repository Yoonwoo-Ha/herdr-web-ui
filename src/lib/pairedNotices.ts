import type { DevicePairedEvent } from "../../shared/protocol.ts";

export const PAIRED_NOTICE_LIMIT = 3;
/** The joins a watching window hid for itself: it may not mark one seen on the PC (POST /api/devices/joins/seen). */
export const HIDDEN_JOINS_KEY = "ovis.hiddenJoins";
const HIDDEN_JOIN_LIMIT = 20;

type JoinStorage = Pick<Storage, "getItem" | "setItem">;

export function hiddenJoins(storage: JoinStorage | null): ReadonlySet<string> {
  try {
    const ids = JSON.parse(storage?.getItem(HIDDEN_JOINS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

/** Hidden in this browser for good, the newest few kept: the PC keeps a join a week at most. */
export function hideJoin(storage: JoinStorage | null, eventId: string): ReadonlySet<string> {
  const ids = [...hiddenJoins(storage), eventId].filter((id, index, all) => all.indexOf(id) === index).slice(-HIDDEN_JOIN_LIMIT);
  try { storage?.setItem(HIDDEN_JOINS_KEY, JSON.stringify(ids)); } catch { /* blocked storage: hidden for this page only */ }
  return new Set(ids);
}

export function withPairedNotice<T extends Pick<DevicePairedEvent, "event_id">>(list: readonly T[], event: T): readonly T[] {
  if (list.some((item) => item.event_id === event.event_id)) return list;
  return [...list, event].slice(-PAIRED_NOTICE_LIMIT);
}
