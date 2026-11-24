/**
 * An approval tells this PC first, which lets the device in here; then this device signs the `add`
 * for the account's other PCs and leaves the PCs it checked itself with this PC as the new device's
 * introduction (lib/account/join.ts). For an account whose signed list this device is in, it signs the
 * device into the list before that; where the list does not take it, the card says so and offers to try again.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { accountLabel, type AccountAsker } from "../../shared/account-asker.ts";
import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { AdmissionChangedError, admitWithList, approveJoin, ListAllowError, UnverifiedJoinError, vouchedAdmission } from "../lib/account/join.ts";
import type { AllowRefusal } from "../lib/account/listAllow.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { accountServiceOf, AccountService, type Admission } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { AccountApprovalPrompt } from "./AccountApprovalPrompt.tsx";
import { VouchedPcApproval } from "./VouchedPcApproval.tsx";

/**
 * Whether a request rests on an admission, so its card says who is asking and its approval checks that admission
 * (approveJoin): an account join, or another PC of the account vouched for. Any other request is answered on the PC only.
 */
export const restsOnAdmission = (request: RemotePairingRequest | undefined): boolean => request?.intent === "account" || request?.vouched === true;

export function AccountApprovals({ pairings }: { pairings: readonly RemotePairingRequest[] }) {
  // The devices this PC let in that the account's list did not take, each kept until it is let in or closed. They are
  // held here, above whichever card the next request draws, so a request for another PC (VouchedPcApproval) takes none
  // of them away; each is shown once no request is on screen.
  const [stalled, setStalled] = useState<readonly Stalled[]>([]);
  const keep = useCallback((key: string, next: Stalled | null): void => setStalled((kept) => keepStalled(kept, key, next)), []);
  const request = pairings[0];
  const through = serverIdOfPath(window.location.pathname);
  if (request?.vouched && through) return <VouchedPcApproval key={JSON.stringify([through, request.id, request.key, request.proven_server_id])} request={request} through={through} />;
  const waiting = stalled[0];
  if (request === undefined && waiting !== undefined) return createPortal(<ListAllowNotice key={waiting.key} stalled={waiting} onClose={() => keep(waiting.key, null)} />, document.body);
  return <DeviceApprovals pairings={pairings} onStalled={keep} />;
}

/** A device this PC let in that the account's signed list did not take: who it is (`key`, its account key), why, and what trying again does. */
interface Stalled { readonly key: string; readonly device: string; readonly pc: string; readonly why: AllowRefusal; readonly retryAfterMs?: number | null; readonly retry: () => Promise<void> }

/** `kept` with what is said of the device `key` now: its card where it stood, a new one after the others, or none (`next` null: let in, or closed). */
export function keepStalled(kept: readonly Stalled[], key: string, next: Stalled | null): readonly Stalled[] {
  const at = kept.findIndex((each) => each.key === key);
  if (next === null) return at < 0 ? kept : kept.filter((each) => each.key !== key);
  return at < 0 ? [...kept, next] : kept.map((each) => (each.key === key ? next : each));
}

/** What the person is told, by why the list did not take the device. */
function stalledReason(t: ReturnType<typeof useT>, why: AllowRefusal, retryAfterMs: number | null = null): string {
  switch (why) {
    // the request went out and no answer came: whether the list took the device is read from the list, by Try again
    case "unknown": return t("The account service did not answer. Try again to check.");
    case "clock": return t("This device's clock looks wrong. Check its date and time, then try again.");
    case "blocked": return t("This device cannot change your account's list right now.");
    case "behind": return t("Update Ovis on this device, then try again.");
    case "changed": return t("The sign-in on this device changed since you approved it. Sign in to that account again, then try again.");
    case "not_claimed": return t("Update Ovis on that device and sign in there, then try again.");
    case "removed": return t("That device was removed from your account. Sign in again on it first.");
    case "stopped": return t("The account service cannot change the list right now.");
    // the wait the account service named: a budget that opens again within the hour, or one that takes longer
    case "budget": return retryAfterMs !== null && retryAfterMs > 60 * 60_000 ? t("Too many devices were added. Try again tomorrow.") : t("Too many devices were added just now. Try again in a few minutes.");
    default: return t("It could not be added to your account. Try again.");
  }
}

/** The card for a device that was let in at this PC and not into the account: Try again signs it into the list again; Close leaves it paired with this PC alone. */
export function ListAllowNotice({ stalled, onClose }: { stalled: Stalled; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Back closes it, as Close does, unless a try is under way
  usePhoneSheetBack(() => { if (busy) return false; onClose(); });
  const retry = async (): Promise<void> => {
    setBusy(true);
    // what the list answers is drawn by whoever owns this card; anything else leaves the card as it is, to try again
    try { await stalled.retry(); }
    catch (error) { console.warn("Ovis: the device was not added to the account", error instanceof Error ? error.name : error); }
    finally { setBusy(false); }
  };
  // "added to this PC only" is said only when it is known: after an answer that never came, it is not
  const title = stalled.why === "unknown" ? t("Not known yet: is {device} in your account?", { device: stalled.device }) : t("{device} was added to {pc} only", { device: stalled.device, pc: stalled.pc });
  return (
    <div className="modal-scrim">
      <div className="modal account-approval" role="alertdialog" aria-modal="true" aria-label={title} data-testid="list-allow-notice" data-why={stalled.why}>
        <h2 className="account-approval-title">{title}</h2>
        <p className="account-approval-error" role="alert">{stalledReason(t, stalled.why, stalled.retryAfterMs ?? null)}</p>
        <div className="account-approval-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("Close")}</button>
          {stalled.why !== "removed" && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void retry()}>{t("Try again")}</button>}
        </div>
      </div>
    </div>
  );
}

function DeviceApprovals({ pairings, onStalled }: { pairings: readonly RemotePairingRequest[]; onStalled: (key: string, stalled: Stalled | null) => void }) {
  const t = useT();
  const request = pairings[0];
  const serverId = serverIdOfPath(window.location.pathname);
  const [where, setWhere] = useState<{ pcName: string; pcCount: number }>({ pcName: "", pcCount: 1 });
  // who is asking, as the account service saw the device ring at this PC (never as the PC says);
  // until it is known an account join cannot be approved (AccountApprovalPrompt `asker` undefined)
  const [asker, setAsker] = useState<{ id: string; asker: AccountAsker; admission: Admission | null } | null>(null);
  // read again when the device asked anew with other details after the card was drawn
  const [reads, setReads] = useState(0);
  const checked = restsOnAdmission(request);
  const joiningId = checked ? request!.id : null;
  const joiningKey = request?.key;
  useEffect(() => {
    if (joiningId === null || joiningKey === undefined || serverId === null) return;
    let live = true;
    void (async () => {
      // nothing found, signed out or no answer: the card says the place is unknown rather than leave the line out
      let found: { asker: AccountAsker; admission: Admission | null } = { asker: { os: null, country: null, city: null }, admission: null };
      try {
        const service = new AccountService({ store: indexedAccountStore });
        if (accountServiceOf(document) !== null && await service.session() !== undefined) {
          const rang = vouchedAdmission(await service.recentAdmissions(), serverId, joiningKey, Date.now());
          if (rang !== undefined) found = { asker: { os: rang.os, country: rang.country, city: rang.city }, admission: rang };
        }
      } catch (error) { console.warn("Ovis: who is asking could not be read", error instanceof Error ? error.name : error); }
      if (live) setAsker({ id: joiningId, ...found });
    })();
    return () => { live = false; };
  }, [joiningId, joiningKey, serverId, reads]);

  const asking = request !== undefined;
  useEffect(() => {
    // only while a request is on screen: this card is mounted with none, too
    if (serverId === null || !asking) return;
    let live = true;
    void (async () => {
      // a store that does not read leaves the card with the PC's id for a name and one PC: nothing here throws into nothing
      const paired = await indexedDeviceStore.list().catch((error: unknown) => { console.warn("Ovis: this device's pairings could not be read for the approval", error instanceof Error ? error.name : error); return []; });
      const here = paired.find((device) => device.server_id === serverId);
      const service = accountServiceOf(document);
      let count = paired.filter((device) => device.device_id !== null).length;
      if (service !== null) {
        try { count = Math.max(count, (await new AccountService({ store: indexedAccountStore }).listPcs()).length); }
        catch (error) { console.warn("Ovis: the account's PCs could not be counted", error instanceof Error ? error.name : error); }
      }
      if (live) setWhere({ pcName: here?.name ?? serverId.slice(0, 8), pcCount: Math.max(count, 1) });
    })();
    return () => { live = false; };
  }, [serverId, asking]);

  if (request === undefined || serverId === null) return null;

  const decide = async (decision: "approve" | "decline", digits?: string): Promise<void> => {
    if (decision === "decline" || digits === undefined) { await decideRelayPairing(request.id, "decline"); return; }
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    // signed out here, an account join is answered on this PC only, never added to the account. A PC vouched for is
    // never approved unchecked: approveJoin cannot read the admission without a sign-in, and approves nothing
    if (!checked || (session === undefined && request.intent === "account")) { await decideRelayPairing(request.id, "approve", digits); return; }
    const transport = getTransport();
    try {
      // what the card showed, or null when it showed no admission: approveJoin takes no other
      const shown = asker?.id === request.id ? asker.admission : null;
      await approveJoin({
        request, digits, through: serverId, service, shown,
        decide: (answer, picked) => decideRelayPairing(request.id, answer, picked),
        admit: async (admission) => {
          const admitted = async (): Promise<void> => {
            await admitWithList(pageAccountList(), {
              fetch: (path, init) => transport.fetch(path, init), service, key: await indexedAccountStore.key(), account: session!.account,
              joining: { key: request.key, label: admission.label, os: admission.os }, through: serverId, paired: await indexedDeviceStore.list(),
              directory: (await service.listPcs()).map((pc) => pc.server_id), store: indexedAccountStore,
            });
          };
          // This PC let the device in already, and its request is gone from here: where the account's list did not take
          // it, that is said on a card of its own, which can try again.
          const attempt = async (): Promise<void> => {
            try {
              await admitted();
              onStalled(request.key, null);
            } catch (error) {
              // anything else failed after the list took the device (the introduction, the account's other PCs): the
              // card, which says that the list did not take it, goes, and the failure is the caller's to say
              if (!(error instanceof ListAllowError)) { onStalled(request.key, null); throw error; }
              onStalled(request.key, { key: request.key, device: admission.label, pc: where.pcName, why: error.why, retryAfterMs: error.retryAfterMs, retry: attempt });
            }
          };
          await attempt();
        },
      });
    } catch (error) {
      if (error instanceof UnverifiedJoinError) throw new Error(t("Could not verify this device. It was declined: approve only a device you are signing in yourself."));
      if (error instanceof AdmissionChangedError) {
        // Approve waits again until the new details are read (and the card's pick is cleared with them)
        setAsker(null);
        setReads((count) => count + 1);
        throw new Error(t("This device asked again with other details. Check them, then pick the number again."));
      }
      throw error;
    }
  };

  const known = asker?.id === request.id ? asker : null;
  // an account join shows the name the device gave the account service; a request for this PC only has no admission
  const shown = { ...request, label: known?.admission?.label ?? (accountLabel(request.label) || t("Device")) };
  return <AccountApprovalPrompt key={request.id} request={shown} pcName={where.pcName} pcCount={where.pcCount}
    asker={checked ? known?.asker : null} onDecide={decide} />;
}
