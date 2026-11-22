import type { DirectoryPc } from "./service.ts";

/** Where this device keeps that it closed the notice of one PC new in the account (NewPcNotices.tsx), per admission. */
export const newPcNoticeKey = (account: string, pc: Pick<DirectoryPc, "server_id" | "admitted_at" | "new_until">): string =>
  `ovis:new-pc:${JSON.stringify([account, pc.server_id, pc.admitted_at ?? pc.new_until])}`;

export function newPcNoticeClosed(key: string): boolean {
  try { return localStorage.getItem(key) !== null; }
  catch (error) { if (error instanceof DOMException) return false; throw error; }
}
