/**
 * One press (docs/account.md, "One press"): this PC, in no account, takes the account service's word that `account` admitted
 * it, and binds itself to that account. Shared by the PC's own window (POST /api/account/one-press) and by another PC of
 * its owner that adds it over SSH, through this PC's recovery socket (docs/account.md, "Adding a PC over SSH").
 */
import type { DeviceStore } from "../devices.ts";
import type { RelayService } from "../relay/service.ts";
import type { AccountMailbox } from "./mailbox.ts";

export interface PressServices {
  readonly devices: DeviceStore;
  readonly relay: RelayService;
  readonly accountMailbox: AccountMailbox;
}

export interface PressRefusal { readonly code: string; readonly message: string; readonly status: number }

export type PressOutcome = { readonly account: string } | { readonly refused: PressRefusal };

const refuse = (code: string, message: string, status: number): PressOutcome => ({ refused: { code, message, status } });
const SET_UP_FOR_ANOTHER = "This PC was set up for another account. Sign in to that one, or add this PC again.";

export async function pressOnce(services: PressServices, account: string): Promise<PressOutcome> {
  const { devices, relay, accountMailbox } = services;
  // the account the owner's browser is signed in to must be the one named for this PC, which a press never sets
  if (relay.savedRelayAccount() !== account) return refuse("account_mismatch", SET_UP_FOR_ANOTHER, 409);
  if (devices.account() !== null) return refuse("in_account", "This PC is already in an account", 409);
  // a Revoke all, a reset or a denial while the service answers raises this: the press then binds nothing (PADD-1)
  const generation = devices.gen();
  // a relay identity reset meanwhile makes this another PC to the account service: its answer was for the old one
  const identity = relay.currentIdentity()?.server_id ?? null;
  let admitted: Awaited<ReturnType<AccountMailbox["admission"]>>;
  try { admitted = await accountMailbox.admission(account); }
  catch (error) { return refuse("account_unavailable", error instanceof Error ? error.message : String(error), 503); }
  if (admitted === null) return refuse("no_admission", "The account service did not admit this PC in one press", 404);
  // the service's word counts only for the account named here (G1)
  if (admitted.account !== account) return refuse("account_mismatch", "The account service answered for another account", 502);
  // the listing is what this PC's place in the account is checked by from now on: an add that names none gives it no standing
  const listing = admitted.listing_id;
  if (listing === undefined) return refuse("listing_unnamed", "The account service named no listing for this add", 502);
  // what the PC was named for, or its account, may have changed while the service answered: decided again now
  if (relay.savedRelayAccount() !== account) return refuse("account_mismatch", SET_UP_FOR_ANOTHER, 409);
  if (devices.account() !== null) return refuse("in_account", "This PC is already in an account", 409);
  if ((relay.currentIdentity()?.server_id ?? null) !== identity) return refuse("identity_changed", "This PC's relay identity was reset while it was being added. Add it again.", 409);
  if (devices.gen() !== generation) return refuse("revoked", "Every device was revoked on this PC while it was being added. Add it again.", 409);
  devices.bindByService(account, listing);
  const binding = devices.serviceBinding();
  await accountMailbox.readSnapshot();
  // the account may have stopped listing this PC during that first read: then it is in no account, and says so
  if (devices.serviceBinding() !== binding) return refuse("not_listed", "The account removed this PC while it was being added", 409);
  // bound: the add is complete, on this PC's own scoped word (account#57), so the account never shows it only listed
  await accountMailbox.complete(account, listing);
  if (devices.serviceBinding() !== binding) return refuse("not_listed", "The account removed this PC while it was being added", 409);
  return { account };
}

/**
 * Over SSH, another PC of the owner names only the account (its own binding's) and this PC's ID as it read it a moment
 * before: this PC names itself for that account and presses, on its own proof to the service. A PC already in that
 * account answers as added (a lost answer asked again); one in another account binds nothing.
 */
export async function takeForAccount(services: PressServices, account: string, serverId: string): Promise<PressOutcome> {
  if ((services.relay.currentIdentity()?.server_id ?? null) !== serverId) return refuse("identity_changed", "This PC's relay identity changed since it was read. Add it again.", 409);
  const bound = services.devices.account();
  if (bound === account) return { account };
  if (bound !== null) return refuse("other_account", "This PC is in another account", 409);
  if (!services.relay.setRelayAccount(account)) return refuse("invalid_account", "Name the account", 400);
  return await pressOnce(services, account);
}
