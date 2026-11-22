import { useState } from "react";

import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { indexedAccountService } from "../lib/account/service.ts";
import { useT } from "../lib/i18n.ts";
import { usePcNewness } from "../lib/relay/newPcHere.ts";
import { usePcRemoval } from "./usePcRemoval.tsx";

/**
 * C3 pin 2 (#16): on the hosted app's own PC row, while that PC is inside its 24 hours in the account, the New PC tag and
 * the one-tap removal from the account, until the window passes or the PC is removed (newPcHere.ts). A PC added before this
 * device joined gets no row here (#29): its one notice is the main area's card (NewPcNotices).
 */
export function NewPcRowTag({ serverId }: { readonly serverId: string | undefined }) {
  const t = useT();
  const { isNew } = usePcNewness();
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const removal = usePcRemoval(indexedAccountService, () => {
    setRemoved(true);
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
  });
  if (!isNew || removed || serverId === undefined) return null;
  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const session = await indexedAccountService.session();
      if (session === undefined) { setFailed(true); return; }
      await removal.remove(session, serverId);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setFailed(true);
    } finally { setBusy(false); }
  };
  return (
    <div className="new-pc-row" data-new-pc={serverId}>
      <span className="machine-state-word new-pc-row-tag">{t("New PC")}</span>
      <button type="button" className="btn btn-ghost new-pc-row-remove" disabled={busy} onClick={() => void remove()}>{t("I didn't add this")}</button>
      {failed && <span className="account-error" role="alert">{t("The PC could not be removed. Try again.")}</span>}
      {removal.prompt}
    </div>
  );
}
