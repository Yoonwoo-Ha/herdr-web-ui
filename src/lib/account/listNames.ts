/**
 * The names in a signed list, as far as this device can open them (docs/account-list.md, "On a device"). A name is
 * sealed under the key of an epoch; this device is handed each epoch's key as a wrap for its own encryption key, and
 * the list links every key to the one before. A key is taken only when it gives the commitment that the device's
 * own verified copy holds for that epoch, so a wrap the account service made up opens nothing here.
 *
 * Nothing here decides who is in the list: a name that does not open is a row without a name.
 */
import { readKind, readNames, type ListNames, type ListState } from "../../../shared/account-list.ts";
import { ListEntryError, entryFromText, isListHash, readBody } from "../../../shared/account-list-entry.ts";
import { LIST_WRAP_TEXT_LENGTH, openSealed, openWrap, walkBack, wrapFromText, type EpochKey, type EpochOpening, type MemberEncryptionKey } from "../../../shared/account-list-seal.ts";
import { fromBase64Url } from "../../../shared/relay-pair-sas.ts";

/** The wraps this device was given for one list, by epoch, each as its text: what it keeps of the epoch keys. */
export interface SavedWraps {
  readonly list: string;
  /** The encryption key they were made for: this device's own. */
  readonly member: string;
  readonly wraps: ReadonlyMap<number, string>;
}

const RECORD_VERSION = 1;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function wrapsRecord(saved: SavedWraps): unknown {
  return { v: RECORD_VERSION, list: saved.list, member: saved.member, wraps: Object.fromEntries([...saved.wraps].map(([epoch, wrap]) => [String(epoch), wrap])) };
}

/** The stored wraps for `list` and `member`, or none: a record of another list, another key or another form holds nothing this device can use. */
export function readWraps(value: unknown, list: string, member: string): SavedWraps {
  const none: SavedWraps = { list, member, wraps: new Map() };
  if (!isRecord(value) || value.v !== RECORD_VERSION || value.list !== list || value.member !== member || !isRecord(value.wraps)) return none;
  const wraps = new Map<number, string>();
  for (const [name, wrap] of Object.entries(value.wraps)) {
    if (!/^(?:0|[1-9][0-9]{0,14})$/.test(name) || typeof wrap !== "string" || wrap.length !== LIST_WRAP_TEXT_LENGTH) return none;
    wraps.set(Number(name), wrap);
  }
  return { list, member, wraps };
}

export interface OpenedEpochs {
  /** The keys this device holds, by epoch. They live in memory only, for as long as the page does. */
  readonly keys: ReadonlyMap<number, EpochKey>;
  /** Epochs whose wrap opened to the key the list commits to: the wraps worth keeping. */
  readonly good: readonly number[];
  /** Epochs whose wrap opened to another key than the list commits to: the wraps come from the account service. */
  readonly wrong: readonly number[];
}

/**
 * The epoch keys that `wraps` and the list's own links give this device. From the newest wrap that opens it walks
 * back through the links, and where a link does not open it goes on with the next older wrap.
 */
export async function openEpochs(state: ListState, saved: SavedWraps, member: MemberEncryptionKey): Promise<OpenedEpochs> {
  const openings = new Map<number, EpochOpening>(state.epochs.map((row, epoch) => [epoch, { commitment: row.opens, link: row.link === null ? null : fromBase64Url(row.link) }]));
  const keys = new Map<number, EpochKey>();
  const good: number[] = [];
  const wrong: number[] = [];
  for (let epoch = state.epoch; epoch >= 0; epoch -= 1) {
    const text = saved.wraps.get(epoch);
    const commitment = openings.get(epoch)?.commitment;
    if (text === undefined || commitment === undefined) continue;
    const opened = await openWrap({ list: state.list, epoch, commitment, wrap: wrapFromText(text), member });
    if (!opened.open) {
      if (opened.why === "other_key") wrong.push(epoch);
      continue;
    }
    good.push(epoch);
    // every wrap that opens is walked from, also one whose epoch an earlier walk reached: a walk ends after its
    // bound of links, and this one goes on below where that one stopped
    const walk = await walkBack({ list: state.list, from: opened.value, openings });
    for (const key of walk.keys) if (!keys.has(key.epoch)) keys.set(key.epoch, key);
  }
  return { keys, good, wrong };
}

/** The names the entry at `seq` seals, or null: no names in it, no key for its epoch, or nothing that opens. */
export async function namesAt(list: string, entries: readonly string[], seq: number, keys: ReadonlyMap<number, EpochKey>): Promise<ListNames | null> {
  const text = entries[seq];
  if (text === undefined || !isListHash(list)) return null;
  let kind: ReturnType<typeof readKind>;
  try {
    kind = readKind(readBody(entryFromText(text).body));
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
  if (kind === null || !("sealed" in kind) || kind.sealed === null) return null;
  const opened = await openSealed({ place: { list: seq === 0 ? "" : list, seq }, epoch: keys.get(kind.sealed.epoch), sealed: kind.sealed.bytes });
  return opened.open ? readNames(opened.value) : null;
}
