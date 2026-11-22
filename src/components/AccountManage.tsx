import { useCallback, useEffect, useMemo, useState } from "react";

import type { PairedDevice } from "../../shared/protocol.ts";
import { removeFromAccount } from "../lib/account/leave.ts";
import { ACCOUNT_PCS_CHANGED_EVENT, OFFLINE_AFTER_MS } from "../lib/account/myPcs.ts";
import { AccountService, type DirectoryPc } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fetchDevices } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { loadRelayShell } from "../lib/relay.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { DEVICES_CHANGED_EVENT, inRelayShell } from "../lib/useRelay.ts";
import { signInOfAccount } from "./AccountPcs.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { usePcRemoval } from "./usePcRemoval.tsx";

/**
 * Whether `row` can be disconnected from every PC from here: another device of the account, and a
 * `remove` signed with this client's account key would be applied, as the PC takes one only from a
 * drive member of the account (server/account/records.ts). A browser signed in on the PC's own address,
 * paired by cookie, holds a key no row has, and every PC would refuse it (`signer_not_member`).
 */
export function offersAccountRemove(devices: readonly PairedDevice[], row: PairedDevice, account: string, key: string | null): boolean {
  return key !== null && !row.current && row.account === account && row.account_key !== undefined && row.account_key !== key
    && devices.some((d) => d.account === account && d.account_key === key && d.role === "drive");
}

/** A PC the account has not heard from for this long (three missed mailbox pulls) is off, and Manage account may remove it. */
export function offlinePc(pc: { readonly last_seen_at: string | null; readonly added_at: string | null }, now: number): boolean {
  const heard = Date.parse(pc.last_seen_at ?? pc.added_at ?? "");
  return Number.isFinite(heard) && now - heard > OFFLINE_AFTER_MS;
}

/**
 * Manage account's lists, for when a phone is lost or a PC is gone: the account's other devices on the PC this page
 * is on, each disconnected from every PC of the account, and the account's PCs, an offline one removed from it. One
 * line a row: a dot says how it is, a press asks once. `onLeave`: this device leaves the account (the hosted app); a
 * throw keeps its confirm up with the error. `pcHere` false: no PC is open on this page (the hosted app's start screen),
 * so no other device is read or offered, only this one's own row.
 */
export function AccountManageLists({ account, watching, pcHere = true, onLeave }: { readonly account: string; readonly watching: boolean; readonly pcHere?: boolean; readonly onLeave?: () => Promise<void> }) {
  return (
    <>
      <AccountDevices account={account} pcHere={pcHere} {...(onLeave ? { onLeave } : {})} />
      <AccountPcs account={account} watching={watching} />
    </>
  );
}

function AccountDevices({ account, pcHere, onLeave }: { readonly account: string; readonly pcHere: boolean; readonly onLeave?: () => Promise<void> }) {
  const t = useT();
  // "failed": the PC did not answer, which says nothing of the account's devices
  const [devices, setDevices] = useState<PairedDevice[] | "failed" | null>(pcHere ? null : []);
  const [key, setKey] = useState<string | null>(null);
  const [asked, setAsked] = useState<PairedDevice | "self" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const read = useCallback(() => fetchDevices().then(setDevices, () => setDevices("failed")), []);
  useEffect(() => {
    if (!pcHere) return;
    void read();
    let live = true;
    indexedAccountStore.key().then((own) => { if (live) setKey(own.public_spki); }, () => undefined);
    return () => { live = false; };
  }, [read, pcHere]);
  const others = devices === null || devices === "failed" ? devices : devices.filter((device) => offersAccountRemove(devices, device, account, key));

  /** A device of the account, gone from every PC of it: at once on this PC, from the mailbox on the others. */
  const disconnect = async (device: PairedDevice): Promise<void> => {
    const transport = getTransport();
    const service = new AccountService({ store: indexedAccountStore });
    const hereId = serverIdOfPath(window.location.pathname);
    const { unconfirmed, queued = [] } = await removeFromAccount({ service, accountStore: indexedAccountStore, relayStore: indexedDeviceStore, key: device.account_key!, account,
      here: (path, init) => transport.fetch(path, init), ...(hereId !== null ? { hereId } : {}) });
    window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
    await read();
    if (unconfirmed.length === 0 && queued.length === 0) { setNote(null); return; }
    // only this PC answered: the others are named, rather than claimed (one may have revoked this device and refuse it)
    const names = new Map((await service.listPcs().catch(() => [])).map((pc) => [pc.server_id, pc.label]));
    const named = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ");
    setNote([
      unconfirmed.length > 0 ? t("Not removed yet on: {pcs}. Disconnect it from a device that is in the account there.", { pcs: named(unconfirmed) }) : "",
      queued.length > 0 ? t("Sent to {pcs}: each removes it when it next comes online. If it still shows there, disconnect it from another device in the account.", { pcs: named(queued) }) : "",
    ].filter(Boolean).join(" "));
  };

  return (
    <section className="account-manage-part" aria-label={t("Devices")}>
      <h3 className="account-manage-h">{t("Devices")}</h3>
      <ul className="account-manage-list" data-testid="account-devices">
        {onLeave && (
          <li className="account-manage-row">
            <StatusDot state="ready" />
            <span className="account-manage-name">{t("This device")}</span>
            <button type="button" className="btn account-head-btn" data-action="leave-account" onClick={() => setAsked("self")}>{t("Disconnect")}</button>
          </li>
        )}
        {others === null ? <li className="account-manage-row account-manage-dim" role="status">{t("Loading…")}</li>
          : others === "failed" ? <li className="account-manage-row account-manage-dim" role="alert">{t("Devices could not be loaded.")}</li>
          : others.map((device) => (
            <li key={device.id} className="account-manage-row" data-device-id={device.id}>
              <StatusDot state={device.connection ? "ready" : "offline"} />
              <span className="visually-hidden">{device.connection ? t("Online") : t("Offline")}</span>
              <span className="account-manage-name">{device.label}</span>
              <button type="button" className="btn account-head-btn" data-action="disconnect-device" onClick={() => setAsked(device)}>{t("Disconnect")}</button>
            </li>
          ))}
      </ul>
      {note !== null && <p className="settings-condition" role="alert">{note}</p>}
      {asked === "self" && onLeave && (
        <ConfirmDialog title={t("Remove this device?")} body={t("Every PC of the account removes this device. QR pairings outside the account stay.")}
          confirmLabel={t("Disconnect")} onClose={() => setAsked(null)} onConfirm={async () => { await onLeave(); setAsked(null); }} />
      )}
      {asked !== null && asked !== "self" && (
        <ConfirmDialog title={t("Disconnect {name}?", { name: asked.label })} body={t("{name} loses access to every PC of your account. Pairings it made outside the account stay.", { name: asked.label })}
          confirmLabel={t("Disconnect")} onClose={() => setAsked(null)}
          onConfirm={async () => {
            try { await disconnect(asked); } catch (error) {
              console.warn("Ovis: the device was not disconnected", error instanceof Error ? error.name : error);
              throw new Error(t("{name} could not be disconnected. Try again.", { name: asked.label }));
            }
            setAsked(null);
          }} />
      )}
    </section>
  );
}

function AccountPcs({ account, watching }: { readonly account: string; readonly watching: boolean }) {
  const t = useT();
  const service = useMemo(() => new AccountService({ store: indexedAccountStore }), []);
  const [pcs, setPcs] = useState<readonly DirectoryPc[] | "failed" | null>(null);
  const [asked, setAsked] = useState<DirectoryPc | null>(null);
  const removal = usePcRemoval(service, async (serverId) => {
    // this device's own pairing with the gone PC goes too, so no list here offers it again
    if (inRelayShell()) await (await loadRelayShell()).forgetSavedPc(serverId).catch(() => undefined);
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
  });
  const read = useCallback(() => service.listPcs().then(setPcs, () => setPcs("failed")), [service]);
  useEffect(() => {
    void read();
    const changed = () => { void read(); };
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
  }, [read]);
  const now = Date.now();
  return (
    <section className="account-manage-part" aria-label={t("PCs")}>
      <h3 className="account-manage-h">{t("PCs")}</h3>
      <ul className="account-manage-list" data-testid="account-pcs">
        {pcs === null ? <li className="account-manage-row account-manage-dim" role="status">{t("Loading…")}</li>
          : pcs === "failed" ? <li className="account-manage-row account-manage-dim" role="alert">{t("PCs could not be loaded.")}</li>
          : pcs.map((pc) => {
            const off = offlinePc(pc, now);
            return (
              <li key={pc.server_id} className="account-manage-row" data-pc-id={pc.server_id}>
                <StatusDot state={off ? "offline" : "ready"} />
                <span className="visually-hidden">{off ? t("Offline") : t("Online")}</span>
                <span className="account-manage-name">{pc.label}</span>
                {/* a PC in use lists itself again on its next pull: only an offline one is offered, whatever its age */}
                {off && !watching && <button type="button" className="btn account-head-btn" data-action="remove-pc" onClick={() => setAsked(pc)}>{t("Remove")}</button>}
              </li>
            );
          })}
      </ul>
      {removal.prompt !== null && <p className="settings-condition">{removal.prompt}</p>}
      {asked !== null && (
        <ConfirmDialog title={t("Remove {name} from your account?", { name: asked.label })}
          body={t("{name} leaves your account's PCs on every device. Once {name} is online again it leaves your account too: your account's devices no longer open it, and a device paired with {name} itself still does. To use it with your account again, add it on {name}.", { name: asked.label })}
          confirmLabel={t("Remove")} onClose={() => setAsked(null)}
          onConfirm={async () => {
            // a removal that wants a fresh sign-in first closes the question: its Sign in again, below the list, removes it
            try { await removal.remove(await signInOfAccount(service, account), asked.server_id); } catch (error) {
              console.warn("Ovis: the PC was not removed from the account", error instanceof Error ? error.name : error);
              throw new Error(t("{name} could not be removed. Try again.", { name: asked.label }));
            }
            setAsked(null);
          }} />
      )}
    </section>
  );
}
