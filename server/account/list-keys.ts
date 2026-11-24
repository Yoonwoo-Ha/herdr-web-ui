/**
 * This PC's own keys in its account's signed list (docs/account-list.md): a signing key, which the list knows the PC
 * by, and an encryption key, which the keys to the names are wrapped to. They live in `account-list-keys.json` in the
 * state folder (0600, written through private-state.ts) and belong to one relay identity: a reset relay identity is a
 * new PC, so keys made for another identity are replaced, never used. Neither secret is logged, and neither leaves
 * this module but as a CryptoKey that cannot be exported.
 *
 * A file that will not read is never replaced by itself: a list that knows this PC's key would then hold a key nobody
 * has, with no word of it. The PC follows its list all the same and says so (`ListKeysError`); a reset relay identity
 * makes new keys.
 */
import { closeSync, linkSync, openSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifySignature } from "../../shared/account-list-entry.ts";
import { generateStoredEncryptionKey, ListSealError, LIST_STORED_KEY_TEXT_LENGTH, readStoredEncryptionKey } from "../../shared/account-list-seal.ts";
import { SERVER_ID_PATTERN } from "../../shared/relay-offer.ts";
import { fromBase64Url } from "../../shared/relay-pair-sas.ts";
import { preparePrivateState, syncDirectory, writePrivateState } from "../private-state.ts";

export const ACCOUNT_LIST_KEYS_FILE = "account-list-keys.json";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const PROBE = new TextEncoder().encode("ovis-list-keys-check/1");

/** The file: both secrets are the 138-byte PKCS8 of a P-256 private key, as base64url (the form of a join line's secret). */
interface KeysFile {
  readonly v: 1;
  readonly server_id: string;
  readonly signing: string;
  readonly encryption: string;
}

export interface PcListKeys {
  /** The relay identity these keys were made for. */
  readonly serverId: string;
  /** The PC's signing key, as the list spells a key. */
  readonly key: string;
  /** Signs entries and the PC's card; it cannot be exported. */
  readonly privateKey: CryptoKey;
  /** The PC's encryption key, as the list spells a key. */
  readonly enc: string;
  /** Opens the wraps made to `enc`; it cannot be exported. */
  readonly encPrivateKey: CryptoKey;
}

/** `account-list-keys.json` is there and cannot be used. The message names the file, never anything in it. */
export class ListKeysError extends Error {
  readonly code = "list_keys_unreadable";
  constructor(detail: string) {
    super(`${ACCOUNT_LIST_KEYS_FILE} cannot be used: ${detail}`);
    this.name = "ListKeysError";
  }
}

export const listKeysPath = (stateDir: string): string => join(stateDir, ACCOUNT_LIST_KEYS_FILE);

/**
 * The reset relay identity's own step: the keys of the PC this was are gone from the disk at once, whatever the file
 * holds, and the new identity makes its own at its first use. Never throws: a file that stays names another identity,
 * and is replaced then.
 */
export function forgetListKeys(stateDir: string): void {
  const path = listKeysPath(stateDir);
  // keys whose making began before this reset are the old PC's: they are not written after it (writeKeys)
  RESETS.set(path, (RESETS.get(path) ?? 0) + 1);
  try { rmSync(path, { force: true }); }
  catch (error) {
    // tried again at the next use of the keys; until then the file names the old identity, and is never used
    LEFTOVER.add(path);
    console.error(`[account] ${ACCOUNT_LIST_KEYS_FILE} could not be removed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  sweepLeftovers();
}

function parseFile(text: string): KeysFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ListKeysError("it is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ListKeysError("it does not hold this PC's list keys");
  const { v, server_id, signing, encryption, ...rest } = value as Record<string, unknown>;
  const secret = (text: unknown): text is string => typeof text === "string" && text.length === LIST_STORED_KEY_TEXT_LENGTH;
  if (v !== 1 || Object.keys(rest).length > 0 || typeof server_id !== "string" || !SERVER_ID_PATTERN.test(server_id) || !secret(signing) || !secret(encryption)) {
    throw new ListKeysError("it does not hold this PC's list keys");
  }
  return { v: 1, server_id, signing, encryption };
}

/** The keys a file's two secrets are. The one PKCS8 form is the same for a key that signs and one that agrees on a secret. */
async function importKeys(file: KeysFile): Promise<PcListKeys> {
  try {
    const signing = await readStoredEncryptionKey(file.signing);
    const encryption = await readStoredEncryptionKey(file.encryption);
    const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(file.signing)), ECDSA, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, PROBE));
    if (!await verifySignature(PROBE, signature, signing.key)) throw new ListKeysError("its signing key does not sign for its own public key");
    return { serverId: file.server_id, key: signing.key, privateKey, enc: encryption.key, encPrivateKey: encryption.privateKey };
  } catch (error) {
    if (error instanceof ListKeysError) throw error;
    if (error instanceof ListSealError || error instanceof DOMException) throw new ListKeysError("a key in it is not a P-256 private key");
    throw error;
  }
}

/** How often one call looks again at the file after it wrote it. */
const CREATE_TRIES = 4;
/** A lock older than this was left by an Ovis that stopped while it made keys: it is taken over. */
const LOCK_STALE_MS = 15_000;
/** How long a call waits for another Ovis on the same state folder to finish making this PC's keys. */
export const LIST_KEYS_LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

/** How often each keys file was forgotten in this process (forgetListKeys): keys whose making began before a reset are never written after it. */
const RESETS = new Map<string, number>();
/** Names of a keys file that could not be removed when they should have been (a spare name of a pair, a forgotten file): tried again at every use. */
const LEFTOVER = new Set<string>();

function sweepLeftovers(): void {
  for (const path of [...LEFTOVER]) {
    try { rmSync(path, { force: true }); LEFTOVER.delete(path); } catch { /* tried again at the next use */ }
  }
}

/**
 * One maker of keys per state folder, among every Ovis that runs on it: a lock file beside the keys file, created
 * exclusively. Whoever holds it reads the keys file, writes it when it holds no keys of this identity, and reads it
 * back; everybody else waits and then reads what it wrote.
 */
async function locked<T>(path: string, waitMs: number, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ListKeysError("its folder cannot be written");
      let age: number;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { unlinkSync(lock); } catch { /* another call took it over */ } continue; }
      if (Date.now() > deadline) throw new ListKeysError("another Ovis on this state folder is making this PC's keys");
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try { return await work(); } finally { try { unlinkSync(lock); } catch { /* a stale lock is taken over */ } }
}

/**
 * Writes a new pair for `serverId`, under the lock. Where no file is there it is created exclusively (a hard link of
 * the finished, flushed temporary file); another identity's file is replaced. Nothing is written when the relay
 * identity was reset since `resets` was read: those keys would be the old PC's.
 */
async function writeKeys(path: string, serverId: string, replace: boolean, resets: number): Promise<void> {
  const signing = await generateStoredEncryptionKey();
  const encryption = await generateStoredEncryptionKey();
  const file: KeysFile = { v: 1, server_id: serverId, signing: signing.secret, encryption: encryption.secret };
  // a pair that does not import is never written
  await importKeys(file);
  if ((RESETS.get(path) ?? 0) !== resets) throw new ListKeysError("this PC's relay identity was reset while its keys were being made");
  if (replace) { writePrivateState(path, file); return; }
  const temporary = preparePrivateState(path, file);
  try {
    linkSync(temporary, path);
    syncDirectory(dirname(path), process.platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    // the spare name of the pair: when it cannot be removed now, it is removed at a later use and at a reset
    try { unlinkSync(temporary); } catch { LEFTOVER.add(temporary); }
  }
}

export class ListKeyStore {
  private readonly path: string;
  private held: PcListKeys | null = null;
  private turn: Promise<unknown> = Promise.resolve();

  /** `lockWaitMs`: how long a call waits for another Ovis on the folder to finish making keys (LIST_KEYS_LOCK_WAIT_MS). */
  constructor(stateDir: string, private readonly lockWaitMs = LIST_KEYS_LOCK_WAIT_MS) { this.path = listKeysPath(stateDir); }

  /**
   * The keys of the relay identity `serverId`: read from the file, made when there is none, and made anew when the
   * file holds another identity's (the old ones go). Throws ListKeysError for a file that will not read. One caller
   * at a time in this process, and one maker per state folder among processes (a lock file beside the keys file):
   * every caller answers with the pair it then reads from disk.
   */
  keysFor(serverId: string): Promise<PcListKeys> {
    // read now, as the keys are asked for: a reset that comes before they are written makes them the old PC's
    const resets = RESETS.get(this.path) ?? 0;
    const next = this.turn.then(() => this.load(serverId, resets), () => this.load(serverId, resets));
    this.turn = next.catch(() => undefined);
    return next;
  }

  private async load(serverId: string, resets: number): Promise<PcListKeys> {
    if (this.held?.serverId === serverId) return this.held;
    sweepLeftovers();
    const read = async (): Promise<{ readonly keys: PcListKeys } | { readonly other: boolean }> => {
      let text: string | null;
      try { text = readFileSync(this.path, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ListKeysError("the file cannot be read");
        text = null;
      }
      const file = text === null ? null : parseFile(text);
      return file !== null && file.server_id === serverId ? { keys: await importKeys(file) } : { other: file !== null };
    };
    // the usual case takes no lock: the file holds this identity's keys
    const first = await read();
    if ("keys" in first) return this.held = first.keys;
    // Whatever this call makes, the keys it answers with are the ones on disk, read back under the lock: every Ovis on
    // this state folder ends with one pair for one PC
    return this.held = await locked(this.path, this.lockWaitMs, async () => {
      for (let tries = 0; tries < CREATE_TRIES; tries++) {
        const now = await read();
        if ("keys" in now) return now.keys;
        // another identity's keys are no PC's any more: replaced by a pair for this one
        await writeKeys(this.path, serverId, now.other, resets);
      }
      throw new ListKeysError("it changed while this PC's keys were being made");
    });
  }
}
