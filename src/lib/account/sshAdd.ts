/**
 * Adding another PC to this PC's account over SSH (docs/account.md, "Adding a PC over SSH"), as this PC's own window does
 * it once the setup job reached that PC's own Ovis: the window lists that PC and admits it with its own sign-in, then
 * asks this PC to hand that PC only the account (POST /api/account/ssh-add); that PC takes the admission itself.
 * "added" only once that PC is bound: a listing or an admission alone adds nobody.
 */
import type { AccountAddTarget } from "../../../shared/machines.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { apiFetch } from "../api-request-id.ts";
import { AccountServiceError, sameSignIn, type AccountService } from "./service.ts";

/**
 * - `added`: that PC took the admission and is in the account.
 * - `already`: that PC is in this account already; nothing was listed or admitted.
 * - `other-account`: that PC is in another account; nothing was listed.
 * - `number`: the service refused the admission for want of two-step sign-in: that PC adds itself with its number.
 * - `sign-in-again`: the service refused this sign-in (not fresh, or not this device's own).
 * - `refused`: anything else, the attempt given up or the sign-in changed included.
 */
export type SshAddOutcome = "added" | "already" | "other-account" | "number" | "sign-in-again" | "refused";

/** Whether this window may offer it: this PC's own window, signed in to the very account this PC is bound to. */
export function sshAddOffered(here: { ownWindow: boolean; signedInAccount: string | null; pcAccount: string | null }): boolean {
  return here.ownWindow && here.pcAccount !== null && here.signedInAccount === here.pcAccount;
}

const hex = (key: string): string => Array.from(importPublicKey(key), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function takeHere(jobId: string, serverId: string): Promise<boolean> {
  const answer = await apiFetch("/api/account/ssh-add", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ job_id: jobId, server_id: serverId }) });
  return answer.ok;
}

export async function addOverSsh(service: AccountService, job: { readonly id: string; readonly account_add: AccountAddTarget }, options: {
  readonly account: string;
  /** false once the dialog closed or the attempt was replaced: nothing more is written */
  readonly running: () => boolean;
  readonly take?: (jobId: string, serverId: string) => Promise<boolean>;
}): Promise<SshAddOutcome> {
  const target = job.account_add;
  if (target.account === options.account) return "already";
  if (target.account !== null) return "other-account";
  // pinned to the sign-in read now: one stored meanwhile (another tab signed out and in) is never written with
  const session = await service.session();
  if (session?.account !== options.account || !options.running()) return "refused";
  const directory = service.forSignIn(session);
  try {
    const listed = (await directory.listPcs()).some((pc) => pc.server_id === target.server_id);
    if (!options.running()) return "refused";
    if (!listed) await directory.putPc(target.server_id, { label: target.label, public_key: hex(target.public_key), relay: target.relay });
    if (!options.running()) return "refused";
    await directory.admitPc(target.server_id);
  } catch (error) {
    if (error instanceof AccountServiceError && error.code === "two_step_required") return "number";
    if (error instanceof AccountServiceError && (error.code === "session_not_fresh" || error.code === "own_sign_in_required")) return "sign-in-again";
    console.warn("Ovis: the account service did not admit that PC", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
    return "refused";
  }
  const still = await service.session();
  if (still === undefined || !sameSignIn(still, session) || !options.running()) return "refused";
  try { return await (options.take ?? takeHere)(job.id, target.server_id) ? "added" : "refused"; }
  catch (error) {
    console.warn("Ovis: this PC could not hand that PC the account", error instanceof Error ? error.name : error);
    return "refused";
  }
}
