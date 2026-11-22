import { useEffect, useState } from "react";
import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { approveJoin, vouchedAdmission } from "../lib/account/join.ts";
import { AccountService, accountServiceOf, sameSignIn, type Admission } from "../lib/account/service.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { vouchedPcName, type MemberPcEvidence } from "../lib/account/vouched-pc.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { AccountApprovalPrompt } from "./AccountApprovalPrompt.tsx";

interface VerifiedPc { readonly name: string; readonly admission: Admission; readonly service: AccountService; readonly session: AccountSession; readonly pc: MemberPcEvidence }

export function VouchedPcApproval({ request, through }: { request: RemotePairingRequest; through: string }) {
  const t = useT();
  const [verified, setVerified] = useState<VerifiedPc | null>(null);
  // a failed Allow drops what was verified and verifies the PC anew: Allow is back only once that holds again
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      const origin = accountServiceOf(document);
      if (!request.proven_server_id || origin === null) return;
      const account = new AccountService({ store: indexedAccountStore });
      const session = await account.session();
      if (!session || session.service !== origin) return;
      const service = account.forSignIn(session);
      const pc = { account: session.account, accountKey: (await indexedAccountStore.key()).public_spki, paired: indexedDeviceStore };
      const [name, admissions] = await Promise.all([vouchedPcName(service, { ...request, through }, pc), service.recentAdmissions()]);
      const admission = vouchedAdmission(admissions, through, request.key, Date.now());
      if (live && name && admission) setVerified({ name, admission, service, session, pc });
    })().catch(() => { if (live) setVerified(null); });
    return () => { live = false; };
  }, [request.id, request.key, request.proven_server_id, through, checks]);
  const decide = async (decision: "approve" | "decline") => {
    const id = request.proven_server_id;
    if (decision === "decline" || !verified || !id) { await decideRelayPairing(request.id, "decline"); return; }
    try {
      await approveJoin({ request, through, service: verified.service, pc: verified.pc, shownPc: verified.name, shown: verified.admission,
        decide: async answer => {
          if (answer === "approve") {
            const current = await verified.service.session();
            if (!current || !sameSignIn(current, verified.session)) { await decideRelayPairing(request.id, "decline"); return; }
          }
          await decideRelayPairing(request.id, answer, { proven_server_id: id, pc_label: verified.name });
        },
        admit: async () => { throw new TypeError("A vouched PC cannot join the account"); } });
    } catch (error) {
      setVerified(null);
      setChecks((count) => count + 1);
      throw new Error(t("This PC could not be verified."), { cause: error });
    }
  };
  return <AccountApprovalPrompt request={request} pcName="" pcCount={1} asker={null} vouchedName={verified?.name} onDecide={decide} />;
}
