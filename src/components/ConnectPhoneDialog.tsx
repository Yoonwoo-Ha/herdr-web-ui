import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { Check, RefreshCw, X } from "lucide-react";

import "./ConnectPhoneDialog.css";
import "./DevicesPanel.css";

import { ADDRESS_PC_FAILURES, type AddressPcFailure, type Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { pcAccountStatus } from "../lib/account/join.ts";
import { listOfferedPc } from "../lib/account/addThisPc.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { AccountService } from "../lib/account/service.ts";
import { ACCOUNT_QR_ALONE_MS, ACCOUNT_QR_POLL_MS, ACCOUNT_QR_WATCH_EVENT, accountQrFindings, accountQrNoticeWaiting, accountQrPending, addedBy, holdAccountQrNotice, resetAccountQrWatch, stopAccountQrWatch, takeAccountQrNotice, watchEndedAccountQr, type AccountQrBaseline, type AccountQrStray } from "../lib/accountQrWatch.ts";
import { addAddressPc, ApiError, endPairing, fetchDevices, findSshCandidates, findTailnetPcs, requestRelayOffer, revokeAllDevices, revokeDevice, startPairing, type RelayOffer, type SshCandidate } from "../lib/api.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { announcePairingCode, announceQrCodeEnded, DEVICES_CHANGED_EVENT, inRelayShell, PAIRING_CODE_EVENT, tellOtherWindowsQrCodeEnded, type AnnouncedCode, type RelayState } from "../lib/useRelay.ts";
import type { PairedDevice, PairingCode } from "../../shared/protocol.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { PhonePanel, QrReveal, ShareLink } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, openOwnOffer, RelayPairing, statusText } from "./RelayPanel.tsx";
import { RelaySignIn } from "./RelaySignIn.tsx";
import { RelayAccountPcs } from "./RelayAccountPcs.tsx";
import { SettingsQuery, Toggle } from "./SettingsControls.tsx";
import { PortalPanel } from "./PortalPanel.tsx";
import { usePortal } from "../lib/portal.ts";
import { CompactPair } from "./CompactPair.tsx";
import { ExternalLink } from "../lib/externalLink.ts";

/** The ways to add a PC are the tabs (the relay, Tailscale, a typed address); pairing a phone sits apart, after them. */
export type ConnectTab = "relay" | "tailscale" | "direct" | "devices";

/** the guide's way to open a PC from outside: Portal, Cloudflare Tunnel or a reverse proxy */
const OUTSIDE_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#behind-a-reverse-proxy";

/** an address the direct tab takes for another PC's Ovis rather than SSH: any http(s) scheme, as a browser reads `https:host` too */
const OVIS_ADDRESS = /^https?:/i;

const PHONE_QUERY = "(pointer: coarse), (max-width: 768px)";

/**
 * The label of a device paired through the relay under this phone's own name, for a quiet hint.
 * A name is no proof (two iPhones share one, and any device can be renamed), so it never stands in
 * for the phone's pairing: the relay key is the hosted shell's, out of this page's reach.
 */
export function sameNameRelayDevice(devices: readonly PairedDevice[], label: string): string | null {
  return devices.find((device) => device.via_relay === true && !device.current && device.label === label)?.label ?? null;
}

export const relayOffered = (relay: RelayState): boolean => !relay.unsupported && relay.status !== null && !inRelayShell();

const relayOn = (relay: RelayState): boolean => relay.status !== null && relay.status.blocked === null && relay.status.phase !== "off";

/**
 * The relay's tab is the owner's on a direct page of a PC that has the relay; Tailscale and a typed address go over
 * SSH, the owner's on a page of this PC (not the hosted shell, not a device that only watches).
 */
export function connectTabs({ sshOffered, relay, readOnly }: { sshOffered: boolean; relay: RelayState; readOnly: boolean }): ConnectTab[] {
  return [...(relayOffered(relay) && !readOnly ? ["relay" as const] : []), ...(sshOffered ? ["tailscale" as const, "direct" as const] : []), "devices"];
}

/**
 * The tab the dialog shows until one is picked: a phone mostly pairs itself; a PC's window the relay, but only where the
 * page has the Ovis account. Without it the relay tab is the relay's own pairing, which makes a code as it opens and
 * would replace one another window shows, so the window opens on the first way that asks nothing of the PC.
 */
export function openingTab({ tabs, phone, noticeWaiting, hasAccount }: { tabs: readonly ConnectTab[]; phone: boolean; noticeWaiting: boolean; hasAccount: boolean }): ConnectTab {
  if (noticeWaiting && hasAccount && tabs.includes("relay")) return "relay";
  if (phone && tabs.includes("devices")) return "devices";
  return tabs.find((way) => way !== "relay" || hasAccount) ?? tabs[0]!;
}

export interface RelayAccount {
  service: string;
  onOpen: () => void;
  onSignedIn: () => void;
}

export interface ConnectPhoneDialogProps {
  plan: PhonePlan;
  pairUrl: string | null;
  relay: RelayState;
  /** a watching device or a Portal visitor: it reads, and starts nothing */
  readOnly: boolean;
  /** turning the relay on closes the open device gate */
  closesGate: boolean;
  /** a Portal visitor may not start pairing codes (the server refuses it) */
  canPair: boolean;
  signedIn: boolean;
  accountId?: string | null;
  /**
   * Signed in, with this PC in that account and its relay on: a new device joins by signing in to the
   * same account, and a device already in it approves it once by picking the matching number
   * (AccountApprovals, docs/account.md "Who may admit a device").
   */
  joinBySignIn: boolean;
  account: RelayAccount | null;
  onAddPc: ((preset?: AddPcPreset) => void) | null;
  machines: readonly Machine[];
  onConnectMachine: (machine: Machine) => void;
  /**
   * The relay tab's QR code may put this PC in an account, and the dialog then says which and by which device, and asks
   * about a device nobody vouched for: while that can still come, or is on screen, a device that pairs does not close
   * the dialog (`held`).
   */
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
  onClose: () => void;
}

export function ConnectPhoneDialog({ plan, pairUrl, relay, readOnly, closesGate, canPair, signedIn, accountId = null, joinBySignIn, account, onAddPc, machines, onConnectMachine, onPairingHeld, onRevokedAll, onClose }: ConnectPhoneDialogProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); }, true, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (surface.current === null) return;
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      if (document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const phone = useMediaQuery(PHONE_QUERY);
  const tabs = connectTabs({ sshOffered: onAddPc !== null && !readOnly && !inRelayShell(), relay, readOnly });
  const hasAccount = account !== null;
  // until a tab is picked, the opening one follows the tabs as they arrive (the relay's state comes a moment later)
  const [chosen, setChosen] = useState<ConnectTab | null>(() => accountQrNoticeWaiting() && hasAccount ? "relay" : null);
  const found = useFoundPcs(machines, tabs.includes("tailscale"));
  useEffect(() => {
    if (!hasAccount) return;
    const onWatch = (event: Event) => { if ((event as CustomEvent<{ notice: boolean }>).detail.notice) setChosen("relay"); };
    window.addEventListener(ACCOUNT_QR_WATCH_EVENT, onWatch);
    return () => window.removeEventListener(ACCOUNT_QR_WATCH_EVENT, onWatch);
  }, [hasAccount]);
  const tab = chosen !== null && tabs.includes(chosen) ? chosen : openingTab({ tabs, phone, noticeWaiting: false, hasAccount });
  const opened = useRef(new Set<ConnectTab>());
  opened.current.add(tab);
  const label: Record<ConnectTab, string> = { relay: t("Ovis relay"), tailscale: "Tailscale", direct: t("Direct"), devices: t("Phones and devices") };
  const ways = tabs.filter((way) => way !== "devices");

  return createPortal(
    <SettingsQuery.Provider value={[]}>
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h1 className="modal-title" id={`${id}-title`} tabIndex={-1}>{t("Add a connection")}</h1>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body connect-phone-body">
          {ways.length > 0 && (
            <div className="connect-ways">
              <div className="segmented connect-tabs" role="group" aria-label={t("How to connect")}>
                {ways.map((way) => <button key={way} type="button" aria-pressed={tab === way} data-tab={way} onClick={() => setChosen(way)}>{label[way]}</button>)}
              </div>
              <button type="button" className="btn btn-ghost connect-phone-way" aria-pressed={tab === "devices"} data-tab="devices" onClick={() => setChosen("devices")}>{label.devices}</button>
            </div>
          )}
          {opened.current.has("tailscale") && tabs.includes("tailscale") && (
            <div className="connect-tab" data-tab-panel="tailscale" hidden={tab !== "tailscale"}>
              <TailscaleTab found={found} onAddPc={onAddPc!} />
            </div>
          )}
          {opened.current.has("direct") && tabs.includes("direct") && (
            <div className="connect-tab" data-tab-panel="direct" hidden={tab !== "direct"}>
              <DirectTab found={found} machines={machines} onAddPc={onAddPc!} onConnectMachine={onConnectMachine} />
            </div>
          )}
          {opened.current.has("devices") && (
            <div className="connect-tab" data-tab-panel="devices" hidden={tab !== "devices"}>
              <DevicesTab plan={plan} pairUrl={pairUrl} readOnly={readOnly} canPair={canPair} phone={phone} />
            </div>
          )}
          {opened.current.has("relay") && tabs.includes("relay") && (
            <div className="connect-tab" data-tab-panel="relay" hidden={tab !== "relay"}>
              <RelayTab relay={relay} closesGate={closesGate} signedIn={signedIn} accountId={accountId} joinBySignIn={joinBySignIn} account={account} phone={phone} active={tab === "relay"} onPairingHeld={onPairingHeld} onRevokedAll={onRevokedAll} machines={machines} onConnectMachine={onConnectMachine} />
            </div>
          )}
        </div>
      </div>
    </div>
    </SettingsQuery.Provider>,
    document.body,
  );
}

/** What the PCs this PC could reach over SSH say for one of them: added already, its Ovis too old, still being asked, or open to add. */
type FoundPcState = "added" | "outdated" | "waiting" | "open";

/**
 * The PCs this PC's server could reach over SSH (its ssh config, its Tailscale login), for the Tailscale and direct
 * tabs. A window the server will not tell (owner_only, read_only) gets an empty list that says nothing of the PC
 * (`unread`); one refused as owner_only is told where the list can be seen, so an empty tab is not taken for a PC that
 * knows none.
 */
export type FoundPcs = ReturnType<typeof useFoundPcs>;

/** read once per dialog, for both tabs, so their lists, version rules and retry agree; `enabled` false reads nothing */
export function useFoundPcs(machines: readonly Machine[], enabled = true) {
  const [found, setFound] = useState<SshCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  // refused or failed: the empty list is not the PC's answer
  const [unread, setUnread] = useState(false);
  // the server keeps its list from this window (owner_only): one line above the field says where it can be seen
  const [withheld, setWithheld] = useState(false);
  const [reads, setReads] = useState(0);
  const [outdated, setOutdated] = useState<ReadonlySet<string>>(new Set());
  const [tailnetRead, setTailnetRead] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setTailnetRead(false);
    findTailnetPcs().then(({ pcs }) => {
      if (live) setOutdated(new Set(pcs.filter((pc) => pc.outdated).map((pc) => new URL(pc.url).hostname.toLowerCase())));
    }, () => undefined).finally(() => { if (live) setTailnetRead(true); });
    return () => { live = false; };
  }, [reads, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setFailed(false);
    setUnread(false);
    setWithheld(false);
    findSshCandidates().then(({ pcs }) => { if (live) setFound(pcs); }, (error: unknown) => {
      const refused = error instanceof ApiError && (error.code === "owner_only" || error.code === "read_only");
      if (!refused) console.warn("Ovis: the PCs to add over SSH could not be read", error instanceof Error ? error.name : error);
      if (!live) return;
      setFound([]);
      setUnread(true);
      setFailed(!refused);
      // a watching device (read_only) adds no PC: it is told nothing new
      setWithheld(error instanceof ApiError && error.code === "owner_only");
    });
    return () => { live = false; };
  }, [reads, enabled]);
  // a found PC is Added only as Add would add it: its own address, on ssh's default port and herdr's default session
  const stateOf = (pc: SshCandidate): FoundPcState =>
    machines.some(({ target }) => target?.destination === pc.destination && (target.port ?? 22) === 22 && target.session === undefined) ? "added"
    : pc.tailnet !== undefined && outdated.has(pc.tailnet.toLowerCase()) ? "outdated"
    // until the Tailscale PCs' Ovis is known (it asks each PC, a few seconds), one of them waits, so an older one is not added
    : pc.tailnet !== undefined && !tailnetRead ? "waiting"
    : "open";
  const retry = () => { setFound(null); setReads((count) => count + 1); };
  return { found, unread, failed, withheld, stateOf, retry };
}

/** The found list's failure with Try again, or where a list this window is refused can be seen. */
function FoundPcsTrouble({ failed, withheld, retry }: { failed: boolean; withheld: boolean; retry: () => void }) {
  const t = useT();
  return (
    <>
      {failed && (
        <div className="connect-found-failed" role="alert">
          <p className="settings-hint">{t("The PCs this PC knows could not be read.")}</p>
          <button type="button" className="btn" onClick={retry}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      {withheld && <p className="settings-hint" role="status">{t("See the PCs this PC knows on this PC itself, or from a device paired with it directly.")}</p>}
    </>
  );
}

/**
 * Tailscale: the other PCs of this PC's Tailscale login (a config host that reaches one stands for it). Connect opens
 * Add PC with its address, which goes over SSH with nothing to install there first; never through the relay.
 */
export function TailscaleTab({ found: { found, unread, failed, withheld, stateOf, retry }, onAddPc }: { found: FoundPcs; onAddPc: (preset?: AddPcPreset) => void }) {
  const t = useT();
  const pcs = found?.filter((pc) => pc.source === "tailscale" || pc.tailnet !== undefined) ?? null;
  return (
    <>
      <p className="settings-description">{t("The PCs of this Tailscale login. Connect goes over SSH, with nothing to install there.")}</p>
      {pcs === null ? <p className="settings-hint" role="status">{t("Looking for PCs…")}</p>
        : pcs.length > 0 ? (
          <div className="connect-found">
            <ul className="connect-found-list">
              {pcs.map((pc) => {
                const state = stateOf(pc);
                return (
                  <li key={`${pc.source}:${pc.destination}`} className="connect-found-row">
                    <span className="connect-found-name">{pc.name}</span>
                    <span className="connect-found-detail">{pc.tailnet ?? pc.detail ?? pc.destination}</span>
                    {state === "added" ? <span className="connect-found-added"><Check aria-hidden="true" />{t("Added")}</span>
                      : state === "outdated" ? <span className="settings-hint">{t("Update Ovis on that PC to 0.5 first.")}</span>
                      : <button type="button" className="btn" disabled={state === "waiting"} aria-label={`${t("Connect")} ${pc.name}`} onClick={() => onAddPc({ destination: pc.destination, name: pc.name })}>{t("Connect")}</button>}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : !unread && <p className="settings-hint" role="status">{t("No other PC of this Tailscale login was found.")}</p>}
      <FoundPcsTrouble failed={failed} withheld={withheld} retry={retry} />
    </>
  );
}

function addressFailureText(t: ReturnType<typeof useT>, error: unknown): string {
  const code = error instanceof ApiError && typeof error.code === "string" && error.code.startsWith("address_pc_") ? error.code.slice("address_pc_".length) : null;
  const failure: AddressPcFailure | undefined = ADDRESS_PC_FAILURES.find((known) => known === code);
  switch (failure) {
    case "address": return t("Enter only that PC's Ovis address, starting with https://");
    case "target": return t("That address cannot be another PC's Ovis.");
    case "code": return t("Type the six-digit code that PC shows.");
    case "wrong_code": return t("That code is wrong, spent or expired. Show a new code on that PC and type it.");
    case "waiting": return t("That PC refuses codes for a while after wrong ones. Wait a minute, then try again.");
    case "unreachable": return t("No PC answered at that address. Check it, and that Ovis runs there.");
    case "not_ovis": return t("No Ovis that pairs devices answered at that address. Update Ovis there, or check the address.");
    case "added": return t("That PC is already added.");
    case "self": return t("That address is this PC's own Ovis.");
    default: return t("That PC could not be added. Try again.");
  }
}

/**
 * Direct: one field for an address. An SSH alias, user@host or a tailnet name opens Add PC with it (the host's
 * fingerprint first); an https:// address, another PC's Ovis, takes the six-digit code that PC shows and opens it in this
 * window once this PC's server paired with it (server/address-pc.ts); the code stays in its input alone. Under it
 * the hosts of this PC's ssh config and the PCs saved in herdr, one press each, and the guide's way to open a PC from
 * outside.
 */
export function DirectTab({ found: { found, failed, withheld, stateOf, retry }, machines, onAddPc, onConnectMachine }: { found: FoundPcs; machines: readonly Machine[]; onAddPc: (preset?: AddPcPreset) => void; onConnectMachine: (machine: Machine) => void }) {
  const t = useT();
  const id = useId();
  const [typed, setTyped] = useState("");
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // a second press before the first one's render would spend the same code twice
  const pairing = useRef(false);
  // what the pairing in flight was asked for: its answer is dropped once the address changes or the tab closes
  const asked = useRef<string | null>(null);
  useEffect(() => () => { asked.current = null; }, []);
  // the code admits whoever holds it: it is typed only where it cannot cross the network in clear (as an SSH password)
  const secretAllowed = window.isSecureContext;
  const address = typed.trim();
  const ovis = OVIS_ADDRESS.test(address);
  const saved = machines.filter((machine) => machine.herdr_profile_id !== undefined && machine.action_required === "connect");
  const hosts = (found?.filter((pc) => pc.source === "ssh_config") ?? []).map((pc) => ({ pc, state: stateOf(pc) }));
  const outdated = hosts.filter(({ state }) => state === "outdated").map(({ pc }) => pc.name);
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (address === "") return;
    if (!ovis) { onAddPc({ destination: address }); return; }
    const code = codeRef.current;
    if (code === null || pairing.current || !secretAllowed) return;
    pairing.current = true;
    asked.current = address;
    setAdding(true);
    setFailure(null);
    const current = () => asked.current === address;
    void addAddressPc(address, code.value.replace(/\s/g, "")).then(({ machine }) => {
      if (!current()) return;
      code.value = "";
      if (machine && typeof machine.id === "string") onConnectMachine(machine); else setFailure(t("That PC could not be added. Try again."));
    }, (error: unknown) => { if (current()) setFailure(addressFailureText(t, error)); })
      .finally(() => { pairing.current = false; setAdding(false); });
  };
  return (
    <>
      <form className="connect-ssh-form" onSubmit={add}>
        <label className="settings-label" htmlFor={`${id}-address`}>{t("Address or SSH")}</label>
        <div className="connect-ssh-field">
          <input id={`${id}-address`} className="input" type="text" value={typed} placeholder="user@host, desk.tailnet.ts.net, https://…" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby={address === "" ? undefined : `${id}-kind`} onChange={(event) => {
            // a code typed for one PC is never sent to another
            if (codeRef.current) codeRef.current.value = "";
            asked.current = null;
            setFailure(null);
            setTyped(event.target.value);
          }} />
          <button type="submit" className="btn" disabled={address === "" || adding || (ovis && !secretAllowed)}>{t("Connect")}</button>
        </div>
        {address !== "" && <p className="settings-hint" id={`${id}-kind`} role="status" data-address-kind={ovis ? "ovis" : "ssh"}>{ovis
          ? t("Opens that PC's Ovis here. On that PC, open Settings → Devices and PCs → Add a connection → Phones and devices, and type the six-digit pairing code it shows. This PC can then drive that PC.")
          : t("An SSH address: Connect checks that PC's fingerprint first.")}</p>}
        {ovis && <>
          <label className="settings-label" htmlFor={`${id}-code`}>{t("Pairing code")}</label>
          <input ref={codeRef} id={`${id}-code`} className="input connect-address-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000000" required pattern="\d{3} ?\d{3}" spellCheck={false} disabled={adding || !secretAllowed} />
          {!secretAllowed && <p className="settings-hint">{t("Needs HTTPS or localhost.")}</p>}
        </>}
        {failure !== null && <p className="settings-hint" role="alert">{failure}</p>}
      </form>
      {(saved.length > 0 || hosts.length > 0) && (
        <section className="connect-picks" aria-label="ssh config">
          <p className="settings-label">ssh config</p>
          <div className="connect-picks-list">
            {saved.map((machine) => <button key={`herdr:${machine.id}`} type="button" className="btn" title={machine.target?.destination} onClick={() => onConnectMachine(machine)}>{machine.name}</button>)}
            {hosts.map(({ pc, state }) => state === "added"
              ? <span key={pc.destination} className="connect-found-added" data-pick-state={state}><Check aria-hidden="true" />{pc.name} · {t("Added")}</span>
              : <button key={pc.destination} type="button" className="btn" disabled={state !== "open"} data-pick-state={state} title={pc.detail ?? undefined}
                  onClick={() => onAddPc({ destination: pc.destination, name: pc.name })}>{pc.name}</button>)}
          </div>
          {outdated.length > 0 && <p className="settings-hint">{outdated.join(", ")}: {t("Update Ovis on that PC to 0.5 first.")}</p>}
        </section>
      )}
      {found === null && <p className="settings-hint" role="status">{t("Looking for PCs…")}</p>}
      <FoundPcsTrouble failed={failed} withheld={withheld} retry={retry} />
      <ExternalLink kind="link" className="settings-hint connect-outside-help" href={OUTSIDE_HELP}>{t("Open a PC from outside with Portal or Cloudflare (guide)")}</ExternalLink>
    </>
  );
}

function DevicesTab({ plan, pairUrl, readOnly, canPair, phone }: { plan: PhonePlan; pairUrl: string | null; readOnly: boolean; canPair: boolean; phone: boolean }) {
  const t = useT();
  const { status: portal } = usePortal();
  const address = plan.kind === "here" || plan.kind === "served";
  const pairs = canPair && !readOnly;
  const portalShown = portal?.supported === true && (portal.phase !== "idle" || (portal.usable && portal.blocked === null));
  if (!address && !pairs && !portalShown) return <p className="settings-description">{t("Open Ovis on the PC itself to add a connection.")}</p>;
  return (
    <>
      {address && (
        <section className="connect-section" aria-label="Tailscale">
          <p className="settings-label">Tailscale</p>
          <PhonePanel url={plan.url} phone={phone} />
        </section>
      )}
      {pairs && (
        <section className="connect-section" aria-label={t("Pairing code")}>
          <p className="settings-label">{t("Pairing code")}</p>
          <CodeRoute pairUrl={inRelayShell() ? null : pairUrl} startAtOnce phone={phone} compact />
        </section>
      )}
      {portalShown && (
        <section className="connect-section" aria-label="Portal">
          <PortalPanel readOnly={readOnly} />
        </section>
      )}
    </>
  );
}

/**
 * The Ovis relay, the owner's on a direct page. With an account, either state ends in AccountQr: the relay's QR code
 * behind a press for a PC in no account, and for a PC that is in one how a device is added instead, with no QR code.
 */
export function RelayTab({ relay, closesGate, signedIn, accountId = null, joinBySignIn, account, phone, active = true, onPairingHeld, onRevokedAll, machines = [], onConnectMachine }: {
  relay: RelayState; closesGate: boolean; signedIn: boolean; joinBySignIn: boolean; account: RelayAccount | null; phone: boolean;
  accountId?: string | null;
  active?: boolean;
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
  machines?: readonly Machine[]; onConnectMachine?: (machine: Machine) => void;
}) {
  const t = useT();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [signedInProvider, setSignedInProvider] = useState<AccountSession["provider"] | null>(null);
  const [pcAccount, setPcAccount] = useState<string | null | undefined>(undefined);
  const signInView = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = signInView.current;
    if (!signedIn || signedInProvider === null || view === null || view.closest("[hidden]") !== null) return;
    const next = view.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?? view.closest('[role="dialog"]')?.querySelector<HTMLElement>("h2");
    next?.focus();
  }, [signedIn, signedInProvider, joinBySignIn]);
  const signInStatus = <p key="sign-in-status" className="visually-hidden" role="status" aria-live="polite">{signedInProvider === null ? null : t("Signed in with {provider}", { provider: PROVIDER_NAMES[signedInProvider] })}</p>;
  const on = relayOn(relay);
  useEffect(() => { if (on) setSwitchError(null); }, [on]);
  const switchable = relay.status?.blocked === null;
  const startError = relay.status !== null && relay.status.blocked === null && relay.status.phase === "off" ? relay.status.error : null;
  const switchRelay = async (next: boolean) => {
    setSwitchError(null);
    try { await relay.request(next ? "start" : "stop"); } catch (reason) { setSwitchError(failureText(reason)); }
  };
  const connecting = on && relay.status?.phase !== "online";
  const relaySwitch = switchable && (
    <div className="connect-relay-switch" aria-busy={connecting || undefined} title={closesGate && !on ? t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.") : undefined}>
      <span className="settings-label">{t("Let this PC be reached from anywhere")}{connecting && <span className="connect-relay-state" role="status"> · {statusText(t, relay.status!)}</span>}</span>
      <Toggle label={t("Ovis relay")} checked={on} onChange={(next) => { if (!relay.pending) void switchRelay(next); }} />
    </div>
  );
  const switchFailure = switchError !== null && <p className="settings-hint relay-error" role="alert">{switchError}</p>;
  if (account === null) return (
    <>
      {relaySwitch}
      {switchFailure}
      <RelayRoute relay={relay} readOnly={false} phone={phone} compact />
    </>
  );
  const startFailure = switchError === null && startError !== null && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: startError })}</p>;
  const mine = signedIn ? accountId : null;
  const pcIn = pcAccount !== undefined ? pcAccount : joinBySignIn ? mine : null;
  const bare = signedIn && pcIn !== null && relay.status?.phase === "online";
  const qr = (ownSwitch: boolean) => (
    <AccountQr relay={relay} phone={phone} active={active} signedIn={signedIn} accountId={mine} pcAccount={pcIn} onPcAccount={setPcAccount} onPairingHeld={onPairingHeld} onRevokedAll={onRevokedAll}
      first={bare} relayControls={ownSwitch ? <>{relaySwitch}{switchFailure}{startFailure}</> : null} />
  );
  if (!signedIn) return (
    <>
      <div ref={signInView} className="connect-signin" data-testid="connect-signin">
        {signInStatus}
        <RelaySignIn service={account.service} onOpenAccount={account.onOpen} onSignedIn={(session) => { setSignedInProvider(session.provider); account.onSignedIn(); }} />
      </div>
      {qr(true)}
    </>
  );
  return (
    <>
      <div ref={signInView} className="connect-signin" data-testid="connect-signin" data-bare={bare || undefined}>
        {signInStatus}
        {joinBySignIn && onConnectMachine && <RelayAccountPcs machines={machines} onConnectMachine={onConnectMachine} />}
        {joinBySignIn && <p className="settings-hint">{t("On another PC, sign in with the same account.")}</p>}
        {pcIn !== null ? (
          !bare && <>{relaySwitch}{switchFailure}{startFailure}</>
        ) : (
          <>
            {switchable && <p className="settings-description">{t("Turn on the relay, then add this PC to your account.")}</p>}
            {relaySwitch}
            {switchFailure}
            {startFailure}
            <button type="button" className="btn connect-signin-button" onClick={account.onOpen}>{t("Open the account")}</button>
          </>
        )}
      </div>
      {qr(false)}
    </>
  );
}

export const ACCOUNT_QR_MAX_MS = 30 * 60_000;
export const ACCOUNT_QR_HIDDEN_MS = 60_000;

/**
 * Takes a QR code that is no longer shown out of use: the six-digit code it carried (`code`, when its offer came) is
 * ended on the PC, only if it is still the one pending, and the typed code bound to it goes with it (server/devices.ts
 * `endPairing`). A code that was not pending any more (used up, or replaced by another window's) ends nothing: the
 * typed code showing on the PC then is not this QR code's.
 * Before the offer came there is nothing to end: this QR code makes no typed code, and the typed code the PC may hold
 * is another place's (the setup guide's), which stays. True when the PC answered: from then on nothing this QR code
 * showed pairs.
 */
async function endShownCode(code: string | null): Promise<boolean> {
  if (code === null) return true;
  try {
    if ((await endPairing(code)).cancelled) announceQrCodeEnded(code);
    return true;
  } catch {
    // the six-digit code runs out by itself within ten minutes
    return false;
  }
}

type AccountQrView =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "shown" }
  | { kind: "alone"; strays: readonly AccountQrStray[]; checking: readonly AccountQrStray[] }
  | { kind: "joined"; account: string; device: string | null; strays: readonly AccountQrStray[]; checking: readonly AccountQrStray[] };

const sameView = (a: AccountQrView, b: AccountQrView): boolean => JSON.stringify(a) === JSON.stringify(b);
const names = (strays: readonly AccountQrStray[]): string => strays.map((stray) => stray.label).join(", ");

/**
 * The relay tab's part under the sign-in, where the page has an Ovis account.
 *
 * On a PC in no account, the relay's QR code behind a press: a signed-in device that scans it is paired with its
 * account key and then links itself and adds the PC (lib/relay/accountController.ts), so the PC joins the scanning
 * device's account with nothing typed and no approval here (docs/account.md, "Adding a PC"). A code admits whoever
 * holds it, so:
 * - nothing is asked of the PC until Show the QR code is pressed, and the code is ended when the QR code comes down:
 *   as the dialog closes or another tab opens, as the page goes (a reload, a closed tab), once the page was hidden
 *   for a minute, and 30 minutes after the press;
 * - the QR code is shown alone: no code to type is made, which could be read off the screen and typed elsewhere;
 * - when the PC goes from no account to one, the QR code gives way to which account, told apart as the one this
 *   browser is signed in to, another one, or one it cannot tell (`accountId`), and to the device that added it: only a
 *   member of that account is named. "Not me: revoke every device" undoes it, and comes first unless the account is
 *   this browser's own;
 * - every device that came since the press and is no member of the PC's account is named and asked about, "Not me:
 *   remove it" first, whether or not the PC joined an account. Which code let it in the page cannot know;
 * - a notice goes only by one of its buttons, and only once nobody is left unanswered, a device still in its ten
 *   seconds included: Done reads the PC once more first. One the dialog closed over waits for the next opening;
 * - a device that took the code just before it was ended links only afterwards: the PC is watched on after the QR
 *   code came down, outside this component (lib/accountQrWatch.ts), and what that finds is shown here.
 *
 * On a PC that is in an account there is no QR code, and no code is asked of the PC for one: whoever scanned it
 * would be paired with a PC that has members, with nobody approving. In its place the part says which account the
 * PC is in and that a device is added by signing in to that account on it. The PC refuses the code too (409
 * `in_account`), and takes back one that is out when it joins an account, so a page that read the PC a moment too
 * early shows none either.
 *
 * On a PC that no account was named for there is no QR code yet either, and no button for one: the PC takes the
 * device that scans it into the account named for it alone, and makes no code before one is named (409
 * `no_account_named`). It says so in its relay state (`account_named`), and in the button's place the part says what
 * names one: a sign-in above for a browser that is signed out, adding the PC to the account for one that is signed in.
 * A press made while the page's relay state said otherwise (it is read every 15 seconds) is refused by the PC: the QR
 * code comes down with no failure to read, and the relay's state is read again, which brings that sentence.
 */
export function AccountQr({ relay, phone, active, signedIn, accountId = null, pcAccount, onPcAccount, first = false, relayControls, onPairingHeld, onRevokedAll }: {
  relay: RelayState; phone: boolean; active: boolean; signedIn: boolean;
  first?: boolean;
  accountId?: string | null;
  pcAccount: string | null;
  onPcAccount: Dispatch<SetStateAction<string | null | undefined>>;
  relayControls: ReactNode;
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
}) {
  const t = useT();
  const id = useId();
  const [view, setView] = useState<AccountQrView>({ kind: "idle" });
  const drawn = useRef(view);
  drawn.current = view;
  const [again, setAgain] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [settling, setSettling] = useState(false);
  const [late, setLate] = useState(accountQrPending);
  const before = useRef<AccountQrBaseline | null>(null);
  const run = useRef(0);
  /** the account this tab showed when Show the QR code was pressed: its codes' PC is listed there or nowhere */
  const pressedAs = useRef<string | null>(null);
  /** the last take-down's requests: the next press waits for them, so it never ends the code it is about to get */
  const ending = useRef<Promise<boolean>>(Promise.resolve(true));
  const showButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const [refocus, setRefocus] = useState(0);
  useLayoutEffect(() => { if (refocus > 0) (showButton.current ?? heading.current)?.focus(); }, [refocus]);

  useEffect(() => {
    let live = true;
    pcAccountStatus(apiFetch).then((status) => { if (live) onPcAccount((known) => known === undefined ? status.account : known); }, () => undefined);
    return () => {
      live = false;
      run.current++;
      const left = drawn.current;
      const known = before.current;
      if (known === null) return;
      if (left.kind === "alone") holdAccountQrNotice({ kind: "alone", strays: left.strays, checking: left.checking, known });
      else if (left.kind === "joined") holdAccountQrNotice({ kind: "joined", account: left.account, device: left.device, strays: left.strays, checking: left.checking, known });
    };
  }, [onPcAccount]);

  useEffect(() => {
    const adopt = () => {
      setLate(accountQrPending());
      const kind = drawn.current.kind;
      if (kind === "shown" || kind === "starting") return;
      const found = takeAccountQrNotice();
      if (found === null) return;
      run.current++;
      setNote(null);
      setError(null);
      setAgain(true);
      stopAccountQrWatch();
      before.current = found.known;
      if (found.kind === "joined") {
        onPcAccount(found.account);
        setView({ kind: "joined", account: found.account, device: found.device, strays: found.strays, checking: found.checking });
        return;
      }
      setView({ kind: "alone", strays: found.strays, checking: found.checking });
    };
    adopt();
    window.addEventListener(ACCOUNT_QR_WATCH_EVENT, adopt);
    return () => window.removeEventListener(ACCOUNT_QR_WATCH_EVENT, adopt);
  }, [onPcAccount]);

  const takeDown = useCallback(() => {
    run.current++;
    setView({ kind: "idle" });
    setAgain(true);
  }, []);

  const show = async () => {
    const mine = ++run.current;
    pressedAs.current = signedIn ? accountId : null;
    setError(null);
    setNote(null);
    setView({ kind: "starting" });
    try {
      await ending.current;
      const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
      if (mine !== run.current) return;
      const found = takeAccountQrNotice();
      const earlier = found?.known ?? stopAccountQrWatch();
      stopAccountQrWatch();
      onPcAccount(status.account);
      if (earlier !== null) {
        const { due, checking } = accountQrFindings(devices, status.account, earlier, Date.now());
        // a device got in, or the PC joined an account: that is told, and no new code is made over it
        if (status.account !== null || due.length + checking.length > 0) {
          run.current++;
          before.current = earlier;
          setAgain(true);
          setView(status.account !== null
            ? { kind: "joined", account: status.account, device: addedBy(devices, earlier.ids, status.account)?.label ?? null, strays: due, checking }
            : { kind: "alone", strays: due, checking });
          return;
        }
      }
      // in an account by now, however it got there: no QR code, and no code is asked of the PC, which would make none
      if (status.account !== null) { setView({ kind: "idle" }); return; }
      before.current = earlier ?? { ids: new Set(devices.map((device) => device.id)), seen: new Map() };
      setView({ kind: "shown" });
    } catch (reason) {
      if (mine !== run.current) return;
      setError(failureText(reason));
      setView({ kind: "idle" });
    }
  };

  const look = useCallback(async (mine: number): Promise<{ account: string | null; unanswered: number } | null> => {
    const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
    const known = before.current;
    if (mine !== run.current || known === null) return null;
    onPcAccount(status.account);
    const { due, checking } = accountQrFindings(devices, status.account, known, Date.now());
    const up = drawn.current.kind === "shown";
    const next: AccountQrView | null = status.account !== null ? { kind: "joined", account: status.account, device: addedBy(devices, known.ids, status.account)?.label ?? null, strays: due, checking }
      // under a QR code that is up, a device in its ten seconds leaves it up: it may be the owner's, about to add the PC
      : due.length > 0 || (!up && checking.length > 0) ? { kind: "alone", strays: due, checking }
      : null;
    if (next !== null) setView((current) => sameView(current, next) ? current : next);
    else if (!up) takeDown();
    return { account: status.account, unanswered: due.length + checking.length };
  }, [onPcAccount, takeDown]);

  const online = relay.status?.phase === "online" && relay.status.blocked === null;
  const shown = view.kind === "shown";
  useEffect(() => {
    if ((view.kind === "shown" || view.kind === "starting") && (!active || !online)) takeDown();
  }, [active, online, view.kind, takeDown]);

  // the six-digit code the QR code carries, as its offers announce it; ended when the QR code goes, however it goes
  useEffect(() => {
    if (!shown) return;
    let code: string | null = null;
    let ended = false;
    const onCode = (event: Event) => { code = (event as CustomEvent<PairingCode | undefined>).detail?.code ?? code; };
    // the page goes (a reload, a closed tab or window, another address): no cleanup runs then, and nothing after an
    // answer would, so the one request that ends this QR code's own code is sent to outlive the page
    const onPageHide = () => {
      if (ended) return;
      ended = true;
      ending.current = code === null ? Promise.resolve(true) : endPairing(code, true).then(() => true, () => false);
      if (code !== null) tellOtherWindowsQrCodeEnded(code);
      // a page kept for Back comes back without its QR code
      takeDown();
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener(PAIRING_CODE_EVENT, onCode);
      window.removeEventListener("pagehide", onPageHide);
      if (!ended) ending.current = endShownCode(code);
      // a device may have taken the code a moment ago and link only now: unless this already says who came (a notice
      // took the QR code's place), the PC is watched on, also once this component is gone
      const next = drawn.current.kind;
      const known = before.current;
      if (known !== null && next !== "joined" && next !== "alone") watchEndedAccountQr(known, ending.current);
    };
  }, [shown, takeDown]);

  const watching = shown || view.kind === "alone" || view.kind === "joined";
  useEffect(() => {
    if (!watching) return;
    const mine = run.current;
    let asking = false;
    let hidden: number | undefined;
    let hiddenAt = 0;
    const waited = new Set<string>();
    const waits: number[] = [];
    const until = Date.now() + ACCOUNT_QR_MAX_MS;
    const up = () => drawn.current.kind === "shown";
    /** either limit passed by the clock: a device that slept ran no timer, and may wake with the page still in sight */
    const overdue = () => Date.now() >= until || (hidden !== undefined && Date.now() - hiddenAt >= ACCOUNT_QR_HIDDEN_MS);
    const ask = async () => {
      if (up() && overdue()) { takeDown(); return; }
      if (asking) return;
      asking = true;
      try {
        await look(mine);
        for (const [device, at] of before.current?.seen ?? []) {
          const left = at + ACCOUNT_QR_ALONE_MS - Date.now();
          if (left <= 0 || waited.has(device)) continue;
          waited.add(device);
          waits.push(window.setTimeout(() => void ask(), left));
        }
      } catch {  } finally { asking = false; }
    };
    const poll = window.setInterval(() => void ask(), ACCOUNT_QR_POLL_MS);
    const cap = window.setTimeout(() => { if (up()) takeDown(); }, ACCOUNT_QR_MAX_MS);
    const onVisibility = () => {
      if (document.hidden) {
        if (hidden === undefined) { hiddenAt = Date.now(); hidden = window.setTimeout(() => { if (up()) takeDown(); }, ACCOUNT_QR_HIDDEN_MS); }
        return;
      }
      if (up() && overdue()) takeDown();
      window.clearTimeout(hidden);
      hidden = undefined;
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(cap);
      for (const wait of waits) window.clearTimeout(wait);
      window.clearTimeout(hidden);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [watching, takeDown, look]);

  const { reread } = relay;
  /**
   * Signed in, the PC a QR code names is listed in the account this view shows, beside the code and never before it:
   * the code is a plain one (no mark), which a scanning device pairs with whether the PC is
   * listed or not, so an account service that is slow or down holds no pairing up. Best-effort, and only a PC the
   * account does not list yet is written (listOfferedPc). The account is the one the tab showed at the press, and only
   * when the PC says, in the very answer that carries this code, that it made the code for that account: a PC named
   * for another account by now, or a server that does not say, is listed nowhere. When the stored sign-in is another
   * one by the time the offer comes (another tab switched), nothing is listed anywhere either.
   */
  const listBeside = useCallback((offer: RelayOffer): void => {
    const named = decodeOffer(offer.url);
    const as = pressedAs.current;
    if (as === null || named === null || offer.account !== as) return;
    listOfferedPc(new AccountService({ store: indexedAccountStore }), named, as).catch((reason: unknown) => {
      console.warn("Ovis: this PC was not listed in the account", reason instanceof Error ? reason.name : reason);
    });
  }, []);

  const refusedForAccount = useCallback(() => {
    const mine = run.current;
    const down = () => { if (mine === run.current) takeDown(); };
    reread();
    void look(mine).then((left) => { if (left !== null && left.account === null) down(); }, down);
  }, [look, takeDown, reread]);

  // a device that pairs normally closes the dialog (Settings' device list); not while this may still have to say
  // which account the PC joined, or says it
  const held = shown || late || view.kind === "alone" || view.kind === "joined" || confirming;
  useEffect(() => { onPairingHeld?.(held); }, [held, onPairingHeld]);
  useEffect(() => () => onPairingHeld?.(false), [onPairingHeld]);

  const dismiss = () => {
    takeDown();
    setRefocus((count) => count + 1);
  };
  const told = view.kind === "alone" || view.kind === "joined";
  const strays = told ? view.strays : [];
  const checking = told ? view.checking : [];
  /** Keep: the person vouches for those devices, which count as known from here on. */
  const keepStrays = () => {
    const known = before.current;
    if (known === null || !told) return;
    setError(null);
    before.current = { ids: new Set([...known.ids, ...strays.map((stray) => stray.id)]), seen: known.seen };
    if (view.kind === "joined" || checking.length > 0) { setView({ ...view, strays: [] }); return; }
    watchEndedAccountQr(before.current, Promise.resolve(true), true);
    dismiss();
  };
  /** Not me: each device asked about is revoked on the PC; one that is gone already was. */
  const removeStrays = async () => {
    const known = before.current;
    const alone = view.kind === "alone";
    setError(null);
    setRemoving(true);
    try {
      try {
        for (const stray of strays) {
          try { await revokeDevice(stray.id); } catch (reason) { if (!(reason instanceof ApiError && reason.status === 404)) throw reason; }
        }
      } catch (reason) {
        setError(t("Could not remove it: {message} Revoke it in the device list.", { message: failureText(reason) }));
        return;
      }
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      // whoever else the code let in since the last look is asked about before this notice goes
      let left: Awaited<ReturnType<typeof look>>;
      try { left = await look(run.current); } catch {
        if (!alone || known === null) return;
        watchEndedAccountQr(known, Promise.resolve(true));
        left = { account: null, unanswered: 0 };
      }
      if (!alone || left === null || left.account !== null || left.unanswered > 0) return;
      if (!accountQrPending()) before.current = null;
      setNote(t("Removed: {devices}.", { devices: names(strays) }));
      dismiss();
    } finally { setRemoving(false); }
  };
  /** Done, or Keep it on an account: the notice goes once nobody the code let in is unanswered, as the PC says now. */
  const finish = async () => {
    if (before.current === null) { dismiss(); return; }
    setError(null);
    setSettling(true);
    try {
      // the QR code's code was ended as it came down: a read begun after that answer sees everyone it let in
      await ending.current;
      const left = await look(run.current);
      if (left === null || left.unanswered > 0) return;
    } catch (reason) {
      setError(t("This PC's devices could not be read: {message}", { message: failureText(reason) }));
      return;
    } finally { setSettling(false); }
    dismiss();
  };
  const revokeAll = async () => {
    await revokeAllDevices();
    before.current = null;
    resetAccountQrWatch();
    setConfirming(false);
    onPcAccount(null);
    setNote(t("Every paired device was revoked. The access token, this PC and its Tailscale login get in as before."));
    dismiss();
    onRevokedAll?.();
  };

  const pass = relay.status?.pass;
  // Ovis's relay refused this PC for its pass: it gets one through an account (docs/relay.md, "Relay pass")
  const needsAccount = !signedIn && relay.status?.phase === "error" && pass?.refused === true && pass.state !== "ok";
  // no account was named for this PC, as it says itself (an older PC says nothing, and is offered the button as
  // before): it makes no code for this QR code until one is named, by adding the PC to an account here or by `ovis add`
  const unnamed = relay.status?.account_named === false;
  const connecting = relay.status !== null && relay.status.blocked === null && relay.status.phase === "connecting";
  const whoseIs = (account: string) => accountId === null ? "unknown" : accountId === account ? "mine" : "other";
  const whose = view.kind === "joined" ? whoseIs(view.account) : null;
  const standing = pcAccount !== null && !told && !shown;
  const here = standing ? whoseIs(pcAccount) : null;
  const one = strays.length === 1;
  const relayStrays = strays.filter((stray) => stray.relay);
  const addressStrays = strays.filter((stray) => !stray.relay);
  const strayButtons = strays.length > 0 && (
    <>
      <button type="button" className="btn btn-danger" disabled={removing} aria-busy={removing || undefined} onClick={() => void removeStrays()}>{one ? t("Not me: remove it") : t("Not me: remove them")}</button>
      <button type="button" className="btn" disabled={removing} onClick={keepStrays}>{one ? t("Keep it") : t("Keep them")}</button>
    </>
  );
  const checkingLine = checking.length > 0 && <p className="settings-description" data-testid="connect-account-checking">{t("Checking a device that just paired: {devices}.", { devices: names(checking) })}</p>;
  const revokeEvery = <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>{t("Not me: revoke every device")}</button>;
  const relayState = relay.status !== null && !(connecting && relayControls !== null) && <p className="settings-hint" role="status">{statusText(t, relay.status)}</p>;
  return (
    <section className="connect-account-qr" aria-labelledby={id} data-testid="connect-account-qr" data-account={here ?? undefined} data-first={first || undefined}>
      {standing ? (
        <>
          <p ref={heading} className="settings-label" id={id} title={pcAccount} tabIndex={-1}>{here === "mine" ? t("This PC is in your Ovis account ({id}).", { id: pcAccount.slice(0, 12) })
            : here === "other" ? t("This PC is in another Ovis account ({id}), not the one this browser is signed in to ({mine}).", { id: pcAccount.slice(0, 12), mine: accountId!.slice(0, 12) })
            : t("This PC is in an Ovis account ({id}).", { id: pcAccount.slice(0, 12) })}</p>
          <p className="settings-description">{t("To add a device, sign in to this PC's account on it and open this PC there. A device this PC does not know yet is approved once, by picking the matching number on a device that is already a member of this PC.")}</p>
          {here === "unknown" && !signedIn && <p className="settings-description connect-account-qr-warning">{t("This browser is not signed in, so it cannot tell whether that account is yours: sign in above to check.")}</p>}
          {here === "other" && <p className="settings-description connect-account-qr-warning">{t("If that account is not yours, revoke every device (More settings → Devices and access): this PC then leaves it.")}</p>}
          <p className="settings-hint">{t("This PC shows a QR code only while it is in no account.")}</p>
          {!online && <>{relayControls}{relayState}</>}
        </>
      ) : (
        <>
          <p className="settings-label" id={id}>{t("Add with a QR code")}</p>
          {!told && <p className="settings-description">{t("Scan it with a device that is signed in to your Ovis account: this PC joins that account, with no number to type. A device that is not signed in is paired with this PC alone.")}</p>}
        </>
      )}
      {standing ? null : view.kind === "joined" ? (
        <div className="connect-account-qr-notice" role="status" data-testid="connect-account-joined" data-account={whose}>
          <p className="settings-label" title={view.account}>{whose === "mine" ? t("This PC is in your account ({id}).", { id: view.account.slice(0, 12) })
            : whose === "other" ? t("This PC joined another Ovis account ({id}), not the one this browser is signed in to ({mine}).", { id: view.account.slice(0, 12), mine: accountId!.slice(0, 12) })
            : t("This PC joined an Ovis account ({id}).", { id: view.account.slice(0, 12) })}</p>
          {view.device !== null && <p className="settings-description">{t("Added by {device}.", { device: view.device })}</p>}
          {whose === "other" && <p className="settings-description connect-account-qr-warning">{t("If that was not you, revoke every device: this PC then leaves that account.")}</p>}
          {whose === "unknown" && !signedIn && <p className="settings-description connect-account-qr-warning">{t("This browser is not signed in, so it cannot tell whether that account is yours: sign in above to check.")}</p>}
          {whose === "unknown" && <p className="settings-description connect-account-qr-warning">{t("If your own device did not just say that it added this PC, this was not you: revoke every device, and this PC leaves that account.")}</p>}
          {strays.length > 0 && <p className="settings-description connect-account-qr-warning" data-testid="connect-account-strays">{t("Paired with this PC while its QR code was up, and not in that account: {devices}.", { devices: names(strays) })}</p>}
          {checkingLine}
          <div className="phone-actions">
            {strayButtons}
            {/* Not me comes first unless the account is this browser's own: whoever scanned may be a stranger */}
            {whose !== "mine" && revokeEvery}
            {/* the notice goes only once every device that came is answered, one still in its ten seconds included */}
            {strays.length === 0 && checking.length === 0 && <button type="button" className={whose === "mine" ? "btn btn-primary" : "btn"} disabled={settling} aria-busy={settling || undefined} onClick={() => void finish()}>{whose === "mine" ? t("Done") : t("Keep it")}</button>}
            {whose === "mine" && revokeEvery}
          </div>
        </div>
      ) : view.kind === "alone" ? (
        <div className="connect-account-qr-notice" role="status" data-testid="connect-account-alone">
          {relayStrays.length > 0 && (
            <>
              <p className="settings-description connect-account-qr-warning">{t("Paired with this PC but not signed in to an Ovis account, so this PC is in no account yet: {devices}.", { devices: names(relayStrays) })}</p>
              <p className="settings-description">{relayStrays.length === 1 ? t("If that is your device, keep it and sign in on it to add this PC to your account.") : t("If those are your devices, keep them and sign in on one to add this PC to your account.")}</p>
            </>
          )}
          {addressStrays.length > 0 && <p className="settings-description connect-account-qr-warning">{t("Paired with this PC at its own address while its QR code was up, not through the relay: {devices}.", { devices: names(addressStrays) })}</p>}
          {checkingLine}
          {strays.length > 0 && <div className="phone-actions">{strayButtons}</div>}
        </div>
      ) : !online ? (
        <>
          {relayControls}
          {needsAccount ? <p className="settings-hint">{t("Sign in above first; then this PC can show its QR code.")}</p> : relayState}
        </>
      ) : shown ? <RelayRoute relay={relay} readOnly={false} phone={phone} compact qrOnly onInAccount={refusedForAccount} onOffer={listBeside} /> : unnamed ? (
        <p className="settings-hint">{signedIn ? t("Add this PC to your account first; then it can show its QR code.") : t("Sign in above first; then this PC can show its QR code.")}</p>
      ) : (
        <div className="phone-actions">
          <button ref={showButton} type="button" className="btn" disabled={view.kind === "starting"} aria-busy={view.kind === "starting" || undefined} onClick={() => void show()}>{again ? t("Show a new code") : t("Show the QR code")}</button>
        </div>
      )}
      {note !== null && view.kind === "idle" && <p className="settings-hint" role="status">{note}</p>}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {confirming && (
        <ConfirmDialog title={t("Revoke every paired device?")}
          body={t("Every paired device loses its access to this PC, and this PC leaves that account. The access token, this PC and its Tailscale login still get in.")}
          confirmLabel={t("Revoke all")} onClose={() => setConfirming(false)} onConfirm={revokeAll} />
      )}
    </section>
  );
}

export function RelayRoute({ relay, readOnly, phone = false, pairHere = false, sameName = null, compact = false, qrOnly = false, onInAccount, onOffer }: {
  relay: RelayState;
  qrOnly?: boolean;
  onInAccount?: () => void;
  /** told of each QR code's offer as it is drawn (RelayPairing `onOffer`) */
  onOffer?: (offer: RelayOffer) => void;
  compact?: boolean;
  readOnly: boolean;
  phone?: boolean;
  pairHere?: boolean;
  /** a relay device under this phone's name: a hint, never proof that this phone is paired */
  sameName?: string | null;
}) {
  const t = useT();
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [opening, setOpening] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (status === null) return null;
  const pairThisPhone = async () => {
    setError(null);
    setOpening(true);
    try { await openOwnOffer((await requestRelayOffer()).url); } catch (reason) { setError(failureText(reason)); } finally { setOpening(false); }
  };
  const notStarted = status.blocked === null && status.phase === "off" && status.error !== null;
  const start = async () => {
    setError(null);
    try { await request("start"); } catch (reason) { setError(failureText(reason)); }
  };
  return (
    <div className="connect-phone-relay">
      {!compact && <p className="relay-status" role="status">{statusText(t, status)}</p>}
      {readOnly && <p className="settings-condition" data-testid="relay-owner-help">{t("Only the PC's owner can control the relay, using a direct connection. Open Ovis on the PC or at its direct address.")}</p>}
      {notStarted && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: status.error })}</p>}
      {notStarted && !readOnly && (
        <div className="phone-actions">
          <button type="button" className="btn" disabled={pending} onClick={() => void start()}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      {pairHere && !readOnly && status.blocked === null && status.phase === "off" && !notStarted && <p className="settings-description">{t("Turn it on with the switch above, then this phone can use it in one tap.")}</p>}
      {pairHere && status.phase === "online" && !readOnly && (
        <div className="connect-phone-self">
          <p className="settings-description">{t("Pairs this phone through the relay, so Ovis keeps working away from home.")}</p>
          {sameName !== null && <p className="settings-hint">{t("A device with this phone's name ({name}) is already paired through the relay.", { name: sameName })}</p>}
          <div className="phone-actions"><button type="button" className="btn btn-primary" disabled={opening} onClick={pairThisPhone}>{t("Use the relay on this phone")}</button></div>
        </div>
      )}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {status.phase === "online" && !readOnly && <RelayPairing phone={phone} compact={compact} qrOnly={qrOnly} onInAccount={onInAccount} {...(onOffer ? { onOffer } : {})} />}
      {!compact && !readOnly && status.blocked !== "serve_only" && (
        <div className="phone-actions connect-phone-reset">
          <button ref={resetButton} type="button" className="btn btn-ghost" disabled={pending} onClick={() => setConfirmingReset(true)}>{t("Reset relay identity")}</button>
        </div>
      )}
      {confirmingReset && (
        <ConfirmDialog title={t("Reset the relay identity?")} body={t("Phones paired through the relay will need to scan a new code.")}
          confirmLabel={t("Reset")} onClose={() => setConfirmingReset(false)} onConfirm={async () => {
            await request("reset-identity");
            setConfirmingReset(false);
            window.requestAnimationFrame(() => resetButton.current?.focus());
          }} />
      )}
    </div>
  );
}

/** the newest code request of any opening: the server keeps one pending code, so an older answer is a dead code */
let latestPairRequest = 0;

export function CodeRoute({ pairUrl, startAtOnce, phone = false, compact = false }: { pairUrl: string | null; startAtOnce: boolean; phone?: boolean; compact?: boolean }) {
  const t = useT();
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const requesting = useRef(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const announcing = useRef(false);

  useEffect(() => {
    const onCode = (event: Event) => {
      if (announcing.current) return;
      const detail = (event as CustomEvent<AnnouncedCode>).detail;
      // a QR code shown alone (the relay tab's) is never shown here as digits; the PC's one pending code is now that
      // one, so the code this showed is gone
      setCode(detail.qrOnly === true ? null : detail);
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  const pair = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    setError(null);
    const request = ++latestPairRequest;
    try {
      const fresh = await startPairing();
      // a dialog closed and opened again asked after this one: its answer is the code that pairs, not this one
      if (request !== latestPairRequest) return;
      setCode(fresh);
      announcing.current = true;
      try { announcePairingCode(fresh); } finally { announcing.current = false; }
    } catch (reason) { setError(failureText(reason)); }
    finally {
      requesting.current = false;
      setBusy(false);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (!startAtOnce || started.current) return;
    started.current = true;
    void pair();
  }, [startAtOnce]);

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;
  const newCode = <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  if (compact) return (
    <div className="connect-phone-code" role="status">
      <CompactPair qr={qrValue} qrLabel={code === null ? t("Pairing code") : t("QR code that pairs a phone with code {code}", { code: code.code })}
        code={code?.code ?? null} shown={code === null ? null : spaced} codeLabel={t("Pairing code")} busy={busy}
        qrNote={busy ? undefined : code === null ? t("This code expired.") : pairUrl === null ? t("No address a phone can open: type the code instead.") : undefined}
        onRefresh={() => void pair()} />
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
  return (
    <div className="connect-phone-code">
      {code === null ? (
        <>
          <p className="settings-description">{t("For a phone that can already open this address: on the same Wi-Fi, or through a tunnel or proxy.")}</p>
          <div className="phone-actions"><button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void pair()}>{t("Get a pairing code")}</button></div>
        </>
      ) : phone ? (
        <div className="devices-pairing devices-pairing-phone" role="status">
          <p className="settings-label">{t("On the other device, enter this code")}</p>
          <p className="devices-code devices-code-large">{spaced}</p>
          <p className="settings-description">{t("Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}</p>
          {qrValue !== null ? <ShareLink url={qrValue} copyLabel={t("Copy link")}>{newCode}</ShareLink> : <div className="phone-actions">{newCode}</div>}
          {qrValue !== null && <QrReveal value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} hint={t("Scan it with the other device's camera.")} />}
        </div>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} />}
          <div>
            <p className="settings-label">{t("On the other device, enter this code")}</p>
            <p className="devices-code">{spaced}</p>
            <p className="settings-description">
              {t(qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in." : "Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}
            </p>
            {qrValue !== null && (
              <p className="devices-link">
                <span className="settings-description">{t("Or send this link to it:")}</span>
                <a ref={linkRef} href={qrValue}>{qrValue}</a>
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(qrValue, linkRef.current).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } })}>{t(copied ? "Copied" : "Copy")}</button>
              </p>
            )}
            <div className="phone-actions">{newCode}</div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
