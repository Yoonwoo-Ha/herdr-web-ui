/**
 * The account service's answers about a signed list, as a device reads them (docs/account-list.md, "On a device"):
 * parsed here, at the edge, and for their form only. Nothing in them says who is in the account: an entry is checked
 * by the list's own rules, a wrap against the list's commitment, and a list id or a head only says what to read.
 */
import { isListHash, isListKeyEncoding } from "../../../shared/account-list-entry.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import { LIST_WRAP_TEXT_LENGTH } from "../../../shared/account-list-seal.ts";

/** The list the account service names for an account, and the head it says that list has. */
export interface ListHint {
  readonly list: string;
  readonly head: ListPlace;
}

/** One answer of the log: the entries after `after` (null: from entry 0), each as its text, never read here. */
export interface ListPage {
  readonly list: string;
  readonly after: number | null;
  readonly entries: readonly string[];
  readonly head: ListPlace;
  readonly more: boolean;
}

/** An epoch key wrapped to one member, as its text. */
export interface ListWrap {
  readonly epoch: number;
  readonly wrap: string;
}

/** The most entries one page holds, and the most this device asks for. */
export const LIST_PAGE_MAX = 256;
/** The most wraps one answer may hold: one for each epoch of a list at its largest. */
const LIST_WRAPS_MAX = 20480;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function placeOf(value: unknown): ListPlace | null {
  return isRecord(value) && isCount(value.seq) && typeof value.hash === "string" && isListHash(value.hash) ? { seq: value.seq, hash: value.hash } : null;
}

/**
 * The account service's clock as an answer carries it (`now`, seconds), or null. It is a hint like the rest: a device
 * uses it only to date an entry no later than the service will take, never to judge anything.
 */
export function nowOf(body: unknown): number | null {
  return isRecord(body) && isCount(body.now) ? body.now : null;
}

/** `{ list, head }`, or `{ list: null }` as null; undefined for anything else. */
export function hintOf(body: unknown): ListHint | null | undefined {
  if (!isRecord(body)) return undefined;
  if (body.list === null) return null;
  const head = placeOf(body.head);
  return typeof body.list === "string" && isListHash(body.list) && head !== null ? { list: body.list, head } : undefined;
}

/**
 * A page of a log; null for an answer out of form or with more entries than a page holds. Which list it says it is
 * of, and which place it says it follows, are the answer's own word: the reader holds them against what it asked.
 */
export function pageOf(body: unknown): ListPage | null {
  if (!isRecord(body) || typeof body.list !== "string" || !isListHash(body.list) || typeof body.more !== "boolean") return null;
  const head = placeOf(body.head);
  const { after, entries } = body;
  if (head === null || !(after === null || isCount(after)) || !Array.isArray(entries) || entries.length > LIST_PAGE_MAX) return null;
  if (!entries.every((entry): entry is string => typeof entry === "string")) return null;
  return { list: body.list, after, entries, head, more: body.more };
}

/** The wraps an answer holds, each epoch once; null for an answer out of form. What a wrap holds is openWrap's to say. */
export function wrapsOf(body: unknown): ListWrap[] | null {
  if (!isRecord(body) || !Array.isArray(body.wraps) || body.wraps.length > LIST_WRAPS_MAX) return null;
  const wraps = new Map<number, ListWrap>();
  for (const wrap of body.wraps as readonly unknown[]) {
    if (!isRecord(wrap) || !isCount(wrap.epoch) || typeof wrap.wrap !== "string" || wrap.wrap.length !== LIST_WRAP_TEXT_LENGTH || wraps.has(wrap.epoch)) return null;
    wraps.set(wrap.epoch, { epoch: wrap.epoch, wrap: wrap.wrap });
  }
  return [...wraps.values()];
}

/** The body of the genesis: entry 0 and the first epoch key's wrap for the device that signed it. */
export function genesisBody(entry: string, wrap: { readonly member: string; readonly wrap: string }): { entry: string; wraps: { epoch: number; member: string; wrap: string }[] } {
  if (!isListKeyEncoding(wrap.member) || wrap.wrap.length !== LIST_WRAP_TEXT_LENGTH) throw new RangeError("A genesis carries the wrap of epoch 0 for its own encryption key");
  return { entry, wraps: [{ epoch: 0, member: wrap.member, wrap: wrap.wrap }] };
}
