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
import type { AllowScope } from "../lib/account/listAllow.ts";
import { resendWaiting } from "../lib/account/listWrite.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import { accountServiceOf, AccountService, type Admission } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { AccountApprovalPrompt } from "./AccountApprovalPrompt.tsx";
import { keepStalled, ListAllowNotice, NotReadError, useWaitingChange, type Stalled } from "./ListChangeNotice.tsx";
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
  // Another change was refused because a request signed for an earlier one still waits (listWrite.ts): where this page
  // holds no card of that earlier change (it was made before a reload), one is put up, to try it again or to cancel it.
  const earlier = useWaitingChange();
  const request = pairings[0];
  const through = serverIdOfPath(window.location.pathname);
  if (request?.vouched && through) return <VouchedPcApproval key={JSON.stringify([through, request.id, request.key, request.proven_server_id])} request={request} through={through} />;
  const waiting = stalled[0];
  if (request === undefined && waiting !== undefined) return createPortal(<ListAllowNotice key={waiting.key} stalled={waiting} onClose={() => keep(waiting.key, null)} />, document.body);
  if (request === undefined && earlier.stalled !== null) return createPortal(<ListAllowNotice key={earlier.stalled.key} stalled={earlier.stalled} onClose={earlier.close} />, document.body);
  return <DeviceApprovals pairings={pairings} onStalled={keep} />;
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
          // what this approval is bound to, for the first try and every Try again: the account it began under, and the
          // list and the member key of its first read
          const scope: AllowScope = { account: session!.account };
          const admitted = async (): Promise<void> => {
            await admitWithList(pageAccountList(), {
              fetch: (path, init) => transport.fetch(path, init), service, key: await indexedAccountStore.key(), account: session!.account, scope,
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
              // A signed request may wait at this device's head: this approval's own, or an earlier change's that holds
              // it back (`waiting`). The card is the card of that very request: Cancel lets it go and no other, and where
              // it is the earlier change's, Try again sends that one first.
              const list = pageAccountList();
              const waits = error.why === "busy" || error.why === "unknown" || error.why === "stopped" || error.why === "waiting";
              const kept = waits && list !== null ? await list.waiting().catch(() => null) : null;
              const retry = error.why === "waiting" && kept !== null && list !== null ? async (): Promise<void> => { await resendWaiting(list, kept); await attempt(); } : attempt;
              onStalled(request.key, { key: request.key, device: admission.label, pc: where.pcName, why: error.why, retryAfterMs: error.retryAfterMs, retry,
                // Cancel reads the log first: a request that was placed after all is this approval going through, which
                // is then finished; one whose outcome cannot be read is not let go, and the card stays
                ...(kept !== null && list !== null ? { cancel: async () => {
                  const said = await list.cancel(kept);
                  if (said === "unread") throw new NotReadError();
                  if (said === "placed" && kept.for === `allow:${request.key}`) await attempt();
                } } : {}) });
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
