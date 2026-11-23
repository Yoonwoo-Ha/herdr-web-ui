import type { MemoryDraft, MemoryEdit, MemoryItem, MemoryView } from "../../shared/memory.ts";
import { memoryRequest } from "./api.ts";

export const memoryActions = {
  add: (draft: MemoryDraft) => memoryRequest<MemoryItem>("add", draft),
  edit: (edit: MemoryEdit) => memoryRequest<MemoryItem>("edit", edit),
  confirm: (item: Pick<MemoryItem, "id" | "digest">, notSecret = false) => memoryRequest<MemoryItem>("confirm", { id: item.id, digest: item.digest, ...(notSecret ? { notSecret } : {}) }),
  remove: (id: string) => memoryRequest<{ ok: true }>("remove", { id }),
  discard: (id: string) => memoryRequest<{ ok: true }>("discard", { id }),
  discardRun: (run: string) => memoryRequest<{ discarded: number }>("discard-run", { run }),
};

/** what waits for a person: notes in the inbox and confirmed ones whose file changed */
export function waitingNotes(view: MemoryView | null): MemoryItem[] {
  return view?.items.filter((item) => item.state === "unconfirmed" || item.state === "changed") ?? [];
}
