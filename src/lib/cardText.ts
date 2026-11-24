import { CARD_TEXT_PREFIX, paneLifetimes } from "./paneLifetime.ts";

export interface CardText {
  machineId: string;
  paneId: string;
  session: string | null;
  promptId: string;
  text: string;
}

type CardStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const cardTexts = new Map<string, CardText>();
/** keys whose newest text this page could not store: only for these is memory newer than storage, whose
 * copy is otherwise the newest, another tab's included */
const unsaved = new Set<string>();

function parseCardText(raw: string | null): CardText | undefined {
  if (raw == null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { machineId, paneId, session, promptId, text } = value as Partial<CardText>;
    if (typeof machineId !== "string" || typeof paneId !== "string" || (session !== null && session !== undefined && typeof session !== "string") || typeof promptId !== "string" || typeof text !== "string") return undefined;
    return { machineId, paneId, session: session ?? null, promptId, text };
  } catch {
    return undefined;
  }
}

export function getMemoryCardText(key: string): CardText | undefined {
  return cardTexts.get(key);
}

export function setCardText(key: string, typed: CardText | null, storage: () => CardStorage = () => paneLifetimes.paneStorage): void {
  if (typed === null) cardTexts.delete(key);
  else cardTexts.set(key, typed);
  try {
    if (typed === null) storage().removeItem(CARD_TEXT_PREFIX + key);
    else storage().setItem(CARD_TEXT_PREFIX + key, JSON.stringify(typed));
    unsaved.delete(key);
  } catch {
    // storage refused: this page's memory keeps it
    if (typed === null) unsaved.delete(key);
    else unsaved.add(key);
  }
}

export function heldCardTextFor(key: string, storage: () => CardStorage = () => paneLifetimes.paneStorage): CardText | undefined {
  const held = cardTexts.get(key);
  if (held !== undefined) return held;
  try {
    const typed = parseCardText(storage().getItem(CARD_TEXT_PREFIX + key));
    if (typed === undefined) return undefined;
    cardTexts.set(key, typed);
    return typed;
  } catch {
    return undefined;
  }
}

/**
 * Moves unsent prompt-card text when herdr moves a pane under a new ID: keep-on-conflict if the
 * destination already holds card text, and write-first so a failed destination write leaves the
 * source intact.
 */
export function moveCardText(before: string, after: string, toPaneId: string, storage: () => CardStorage = () => paneLifetimes.paneStorage): void {
  if (before === after) return;
  if (cardTexts.has(after)) return;
  const memBefore = cardTexts.get(before);
  const ownNewest = memBefore !== undefined && unsaved.has(before);
  let storedBefore: string | null = null;
  try {
    storedBefore = storage().getItem(CARD_TEXT_PREFIX + before);
    if (storage().getItem(CARD_TEXT_PREFIX + after) !== null) {
      // carried already (another tab heard of the move first): a cached copy left under the old ID would
      // be offered again, beside the carried one, once herdr is replaced
      if (storedBefore === null && !ownNewest) cardTexts.delete(before);
      return;
    }
  } catch {
    return;
  }
  if (storedBefore !== null) {
    const parsed = (ownNewest ? memBefore : undefined) ?? parseCardText(storedBefore) ?? memBefore;
    const updated = parsed ? { ...parsed, paneId: toPaneId } : null;
    const serialized = updated ? JSON.stringify(updated) : storedBefore;
    try {
      storage().setItem(CARD_TEXT_PREFIX + after, serialized);
    } catch {
      return;
    }
    try {
      if (storage().getItem(CARD_TEXT_PREFIX + before) === storedBefore) {
        storage().removeItem(CARD_TEXT_PREFIX + before);
      }
    } catch {}
    cardTexts.delete(before);
    unsaved.delete(before);
    if (updated) cardTexts.set(after, updated);
    return;
  }
  // nothing stored under the old ID: only this page's own unstored text moves; a copy it merely cached
  // was cleared by another tab (its prompt answered), so it goes rather than being written back or
  // offered for recovery once herdr is replaced
  if (!ownNewest) {
    cardTexts.delete(before);
    return;
  }
  const next = { ...memBefore, paneId: toPaneId };
  cardTexts.delete(before);
  unsaved.delete(before);
  cardTexts.set(after, next);
  try {
    storage().setItem(CARD_TEXT_PREFIX + after, JSON.stringify(next));
  } catch {
    unsaved.add(after);
  }
}

paneLifetimes.onRetire((machineId) => {
  for (const [key, typed] of cardTexts) {
    if (typed.machineId !== machineId) continue;
    cardTexts.delete(key);
    unsaved.delete(key);
    if (typed.text.trim() !== "") paneLifetimes.keep(machineId, typed.paneId, "message", typed.text);
  }
});
