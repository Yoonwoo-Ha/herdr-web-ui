import type { SeenRecord } from "./sidebarOrder.ts";

export const SEEN_PREFIX = "herdr-web-ui:finish:";
const OLD_PREFIX = "herdr-web-ui:seen:";
export const SEEN_LIMIT = 2000;
const scope = (pc: string, epoch: string) => `${SEEN_PREFIX}${encodeURIComponent(pc)}:${encodeURIComponent(epoch)}:`;
export const seenKey = (pc: string, epoch: string, pane: string): string => scope(pc, epoch) + encodeURIComponent(pane);

interface StoredFinish { id: number; at: number; answer?: string }
function parse(raw: string | null): StoredFinish | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (value && typeof value === "object" && "id" in value && "at" in value
      && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0
      && typeof value.at === "number" && Number.isFinite(value.at)) return { id: value.id, at: value.at,
        ...("answer" in value && typeof value.answer === "string" ? { answer: value.answer } : {}) };
  } catch { /* corrupt storage is not an acknowledgement */ }
  return null;
}

export function readSeenFinish(key: string): StoredFinish | null {
  try { return parse(localStorage.getItem(key)); } catch { return null; }
}

export function seenEvent(key: string, raw: string | null): { pc: string; epoch: string; pane: string; id: number } | null {
  if (!key.startsWith(SEEN_PREFIX)) return null;
  const value = parse(raw);
  const parts = key.slice(SEEN_PREFIX.length).split(":");
  if (!value || parts.length !== 3) return null;
  try {
    const [pc, epoch, pane] = parts.map(decodeURIComponent);
    return pc && epoch && pane ? { pc, epoch, pane, id: value.id } : null;
  } catch { return null; }
}

export function loadSeen(pc: string, epoch: string): SeenRecord {
  const record: Record<string, number> = {};
  try {
    const prefix = scope(pc, epoch);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const value = parse(localStorage.getItem(key));
      if (value) record[decodeURIComponent(key.slice(prefix.length))] = value.id;
    }
  } catch { /* blocked storage: the mounted page still remembers its views */ }
  return record;
}

/** One pane per key: concurrent writes of different panes cannot overwrite one another. */
export function saveSeen(pc: string, epoch: string, pane: string, id: number, answer?: string): number {
  try {
    const key = seenKey(pc, epoch, pane);
    const before = parse(localStorage.getItem(key));
    if (before && before.id >= id) {
      if (before.id === id && before.answer === undefined && answer !== undefined) {
        localStorage.setItem(key, JSON.stringify({ ...before, answer }));
        cleanSeen();
      }
      return before.id;
    }
    localStorage.setItem(key, JSON.stringify({ id, at: Date.now(), ...(answer === undefined ? {} : { answer }) }));
    cleanSeen();
  } catch { /* blocked storage: this view lasts for the mounted page only */ }
  return id;
}

/**
 * Only an epoch this tab actually left is known to be obsolete. An arbitrary other epoch might
 * belong to a newer tab than this tab's initial roster, so it is capped, not guessed to be old.
 * Never prune from a pane/PC roster. Old-format records cannot identify finishes and are removed.
 */
export function cleanSeen(retired: readonly { pc: string; epoch: string }[] = []): void {
  try {
    const remove: string[] = [];
    const entries: { key: string; at: number }[] = [];
    const obsolete = retired.map(({ pc, epoch }) => scope(pc, epoch));
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(OLD_PREFIX) || obsolete.some((prefix) => key.startsWith(prefix))) remove.push(key);
      else if (key.startsWith(SEEN_PREFIX)) entries.push({ key, at: parse(localStorage.getItem(key))?.at ?? 0 });
    }
    entries.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    remove.push(...entries.slice(0, Math.max(0, entries.length - SEEN_LIMIT)).map(({ key }) => key));
    for (const key of remove) localStorage.removeItem(key);
  } catch { /* storage blocked */ }
}
