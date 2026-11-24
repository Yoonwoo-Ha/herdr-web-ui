/**
 * Entry 0 of an account's signed list, made and signed by the device that starts it (docs/account-list.md, "On a
 * device"): a `genesis` under its account key that names the account and the device's encryption key, opens epoch 0
 * by a commitment to that epoch's key, and seals the device's own name under it. The epoch key is wrapped to the
 * device itself and then forgotten: the wrap is all that is kept of it, here and at the account service.
 */
import { accountLabel, type AccountOs } from "../../../shared/account-asker.ts";
import { isListLabel, namesFields, signGenesis, type ListNames } from "../../../shared/account-list.ts";
import { epochKeyCommitment, newEpochKey, sealFields, wrapEpochKey, wrapToText } from "../../../shared/account-list-seal.ts";
import type { DeviceListKeys } from "./listKeys.ts";

export interface Genesis {
  /** The list id: entry 0's hash. */
  readonly list: string;
  /** Entry 0 as its one text. */
  readonly entry: string;
  /** The encryption key the wrap is for: the device's own. */
  readonly enc: string;
  /** The key of epoch 0, wrapped to that key, as its text. */
  readonly wrap: string;
}

/** A device's name as an entry seals it; null for a name with nothing in it, which is then not sealed at all. */
export function listNames(label: string, os: AccountOs | null): ListNames | null {
  const name = accountLabel(label);
  return isListLabel(name) ? { label: name, os } : null;
}

/** `now` is this device's clock in ms; an entry says it in seconds, and no member judges it. */
export async function makeGenesis(given: { readonly account: string; readonly keys: DeviceListKeys; readonly names: ListNames | null; readonly now: number }): Promise<Genesis> {
  const { account, keys, names } = given;
  const epoch = newEpochKey(0);
  // entry 0 has no list id yet: its place is the empty list id, and so is its commitment's (shared/account-list-seal.ts)
  const opens = epochKeyCommitment({ list: "", epoch });
  const sealed = names === null ? null : { epoch: 0, bytes: await sealFields({ place: { list: "", seq: 0 }, epoch, commitment: opens, fields: namesFields(names) }) };
  // signed through the kinds' own writer, which signs entry 0 only when it starts a list a member follows
  const written = await signGenesis({ kind: "genesis", account, enc: keys.enc.key, opens, sealed }, { key: keys.key, privateKey: keys.signs }, Math.floor(given.now / 1000));
  const { list } = written.state;
  const wrap = await wrapEpochKey({ list, epoch, member: keys.enc.key });
  if (wrap === null) throw new RangeError("This device's encryption key is no point of the curve");
  return { list, entry: written.text, enc: keys.enc.key, wrap: wrapToText(wrap) };
}
