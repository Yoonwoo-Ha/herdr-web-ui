/**
 * An invite is a key (docs/account-list.md, "An invite is a key"). The device that makes one makes a P-256 key pair,
 * gives the account service the public key alone and writes the join line, which carries the private key
 * (shared/account-list-join.ts: newInvite). The machine that joins proves it holds the line by signing the bytes
 * below with that key. So the account service never holds anything that redeems an invite or signs for one. This
 * file is the two messages and their checks, which the account service reads too: it reads no line. No I/O;
 * WebCrypto only.
 */
import { canonicalBase64Url, isListKeyEncoding, isListPoint, verifySignature } from "./account-list-entry.ts";

/** What a machine signs to redeem an invite starts with these bytes. */
export const INVITE_REDEEM_PREFIX = "ovis-invite-redeem/1";
/** What a device signs to add a PC starts with these bytes (shared/account-records.ts, PC_ADD_PREFIX): making an invite is one such act. */
export const INVITE_MAKE_PREFIX = "ovis-pc-add/1";
/** A redeem signature as text: the base64url of `r || s`, 64 bytes, in its one spelling. */
export const INVITE_SIGNATURE_CHARS = 86;

/** What a redeem signature covers: the account the invite is for, the machine that joins, and the challenge it answers. */
export interface InviteRedeem {
  /** The account's id, as the join line names it. */
  readonly account: string;
  /** The machine's id: 32 of `0-9a-f`. */
  readonly server_id: string;
  /** The machine's relay key: 64 of `0-9a-f`. */
  readonly public_key: string;
  /** The id of the account service's challenge that the machine's own proof answers in the same request: 32 of `0-9a-f`. */
  readonly challenge_id: string;
}

/** What a device's key proof covers when it makes an invite with a sign-in that is no longer fresh. */
export interface InviteMake {
  readonly account: string;
  /** The invite's public key, as an entry spells a key. */
  readonly invite_key: string;
  /** Whether a machine joins with the invite by itself. */
  readonly auto: boolean;
  /** The id of the account service's challenge to the device: 32 of `0-9a-f`. */
  readonly challenge_id: string;
  /** That challenge's text, as the account service gave it. */
  readonly challenge: string;
}

export class InviteRedeemError extends Error {
  readonly code = "redeem_malformed";
  constructor(message: string) {
    super(message);
    this.name = "InviteRedeemError";
  }
}

const ACCOUNT_FORM = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const CHALLENGE_MAX_CHARS = 256;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** An account's id as the account service writes it: 1 to 64 of `A-Z a-z 0-9 _ -`. */
export function isAccountId(text: string): boolean {
  return ACCOUNT_FORM.test(text);
}

/** A tag, then each value as its length (4 bytes, big-endian) and its UTF-8 bytes: the form of every proof a device or a machine signs for the account service. */
function tagged(tag: string, values: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts = values.map((value) => encoder.encode(value));
  const prefix = encoder.encode(tag);
  const bytes = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  bytes.set(prefix);
  const view = new DataView(bytes.buffer);
  let offset = prefix.length;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}

/**
 * The bytes a redeem signature is over: `ovis-invite-redeem/1`, then `account`, `server_id`, `public_key` and
 * `challenge_id` in that order, each as its length (4 bytes, big-endian) and its bytes. Every value is ASCII by its
 * form. Refuses `redeem_malformed` for a value out of its form, so two parties never sign or check other bytes than
 * these.
 */
export function inviteRedeemBytes(redeem: InviteRedeem): Uint8Array<ArrayBuffer> {
  if (!isRecord(redeem)) throw new InviteRedeemError("A redeem names an account, a machine, its relay key and a challenge");
  const { account, server_id, public_key, challenge_id } = redeem;
  if (typeof account !== "string" || !isAccountId(account)) throw new InviteRedeemError("account is an account's id: 1 to 64 of A-Z a-z 0-9 _ -");
  if (typeof server_id !== "string" || !HEX_32.test(server_id)) throw new InviteRedeemError("server_id is 32 of 0-9a-f");
  if (typeof public_key !== "string" || !HEX_64.test(public_key)) throw new InviteRedeemError("public_key is 64 of 0-9a-f");
  if (typeof challenge_id !== "string" || !HEX_32.test(challenge_id)) throw new InviteRedeemError("challenge_id is 32 of 0-9a-f");
  return tagged(INVITE_REDEEM_PREFIX, [account, server_id, public_key, challenge_id]);
}

/**
 * The redeem signature for the line that was read (readJoinLine): the account is the line's, so a caller names
 * only the machine and the challenge. It is the line that signs: no caller holds its key. Refuses
 * `redeem_malformed` for a value out of its form; whatever WebCrypto throws is a fault and goes up as it came.
 */
export async function signInviteRedeem(
  line: { readonly signRedeem: (redeem: Omit<InviteRedeem, "account">) => Promise<string> }, redeem: Omit<InviteRedeem, "account">,
): Promise<string> {
  return await line.signRedeem(redeem);
}

/**
 * Whether `signature` is the redeem signature of the invite whose public key is `key` (a key as an entry spells one)
 * over these values. False, and never a throw, for anything a request may hold: values that are no redeem or are
 * out of their form, a signature that is not 86 characters in their one spelling, an `r` or `s` outside 1 to n-1, a
 * key that is no key or whose point is not on the curve, and a signature that does not verify; a high `s` counts,
 * as in an entry. Nothing here says whether the invite is open: the account service looks it up by `key`. A
 * redeem signature counts for nothing else: no entry and no other proof starts with its bytes.
 */
export async function verifyInviteRedeem(redeem: InviteRedeem, signature: unknown, key: unknown): Promise<boolean> {
  if (typeof signature !== "string" || signature.length !== INVITE_SIGNATURE_CHARS || typeof key !== "string") return false;
  const signed = canonicalBase64Url(signature);
  if (signed === null) return false;
  let bytes: Uint8Array;
  try {
    bytes = inviteRedeemBytes(redeem);
  } catch (error) {
    if (error instanceof InviteRedeemError) return false;
    throw error;
  }
  return await verifySignature(bytes, signed, key);
}

/**
 * What a device's registered key signs to make an invite once its sign-in is older than ten minutes: the bytes of
 * a key proof for adding a PC (shared/account-records.ts, pcAddSigningBytes), with the purpose `invite`, or
 * `invite-auto` for an invite a machine joins with by itself, no `server_id`, and the invite's public key where a
 * listing id stands otherwise. So a proof made for one invite registers no other key. Refuses `redeem_malformed`
 * for a value out of its form, and for an invite key whose point is not on the curve.
 */
export function inviteMakeBytes(make: InviteMake): Uint8Array<ArrayBuffer> {
  if (!isRecord(make)) throw new InviteRedeemError("Making an invite names an account, the invite's key and a challenge");
  const { account, invite_key, auto, challenge_id, challenge } = make;
  if (typeof account !== "string" || !isAccountId(account)) throw new InviteRedeemError("account is an account's id: 1 to 64 of A-Z a-z 0-9 _ -");
  if (typeof invite_key !== "string" || !isListKeyEncoding(invite_key) || !isListPoint(invite_key)) throw new InviteRedeemError("invite_key is a key whose point is on the curve");
  if (typeof auto !== "boolean") throw new InviteRedeemError("auto is true or false");
  if (typeof challenge_id !== "string" || !HEX_32.test(challenge_id)) throw new InviteRedeemError("challenge_id is 32 of 0-9a-f");
  if (typeof challenge !== "string" || challenge.length < 1 || challenge.length > CHALLENGE_MAX_CHARS) throw new InviteRedeemError("challenge is the text the account service gave");
  return tagged(INVITE_MAKE_PREFIX, [auto ? "invite-auto" : "invite", account, "", invite_key, challenge_id, challenge]);
}
