import { useEffect, useState, type ReactNode } from "react";
import { QrCode } from "lucide-react";

import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { callNative, hasNativePlugin } from "../lib/nativeApp.ts";
import { isLoopbackHost, tailnetHost } from "../lib/phone.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { markRemovedPc, removedPcs, type RemovedPcMark } from "../lib/relay/shellState.ts";
import { AccountJoinRequests } from "./AccountJoinRequests.tsx";
import { NewPcNotices } from "./NewPcNotices.tsx";
import { UnconfirmedPcNotices } from "./UnconfirmedPcNotices.tsx";
import { AddressForm, canScanQr, scanQr, sshHandoff, useAddressOpen, Way, type AddressOpen, type SavedPc } from "./RelayAddPc.tsx";

type ConnectWay = "relay" | "tailscale" | "ssh";
const CONNECT_WAYS: readonly ConnectWay[] = ["relay", "tailscale", "ssh"];

/** The phone app's shell plugin (app/android HerdrShellPlugin): the PCs this phone opened, and whether Tailscale is on. */
const SHELL = "HerdrShell";

/** A PC the phone app saved, by the way it connects: at a Tailscale address, added over SSH (a loopback address on the phone), or at any other address. */
export interface PhoneSavedPc { readonly origin: string; readonly host: string; readonly name: string; readonly way: "tailscale" | "ssh" | "address" }

/**
 * The PCs the phone app opened (app/web/shell.js `tabPcs`, the app's own lists), each by the way it connects, for the
 * Tailscale and SSH tabs: a phone has no list of its tailnet's machines, only the ones opened here. A page of the app's
 * origin (`appOrigin`: the relay's, listed on the relay tab) and an unreadable entry are on neither. `saved` and
 * `names` as HerdrShell's getState gives them; a MagicDNS name goes by its first label, an address by itself.
 */
export function phoneSavedPcs(saved: readonly string[], names: Readonly<Record<string, string>>, appOrigin: string): PhoneSavedPc[] {
  return saved.flatMap((origin) => {
    let url: URL;
    try { url = new URL(origin); } catch { return []; }
    if (url.origin === appOrigin) return [];
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const way = tailnetHost(host) ? "tailscale" : isLoopbackHost(host) ? "ssh" : "address";
    const short = host.toLowerCase().endsWith(".ts.net") ? host.split(".")[0]! : url.host;
    return [{ origin, host: url.host, name: names[origin] || short, way }];
  });
}

/** A relay PC of the relay tab's list: this phone's own pairing (`saved`, by a QR or a code), or one of the account's. */
export interface RelayTabPc { readonly server_id: string; readonly name?: string | undefined; readonly status?: "online" | "off" | "removed" | undefined; readonly saved: boolean }

/**
 * The relay tab's PCs this phone is on: its own pairings, then, signed in, the account's PCs it can open (one its own
 * page can join) that are not among them, so a PC both paired here and in the account is listed once, as this phone's.
 * An account PC is online unless the directory says it is off; a pairing as its last check found it. One that turned
 * this phone away as removed (`removed`, shellState removedPcs) says so, never on, until this phone opens it again, and
 * is left out once forgotten from the list.
 */
export function relayTabPcs(devices: readonly SavedPc[], account: readonly MyPc[] | null, removed: Readonly<Record<string, RemovedPcMark>> = {}): RelayTabPc[] {
  const own = devices.map((device): RelayTabPc => ({ server_id: device.server_id, name: device.name, status: device.status, saved: true }));
  const more = (account ?? []).filter((pc) => !pc.paired && pc.join !== undefined && !own.some((row) => row.server_id === pc.server_id) && removed[pc.server_id] !== "hidden")
    .map((pc): RelayTabPc => ({ server_id: pc.server_id, name: pc.name, status: removed[pc.server_id] === "removed" ? "removed" : pc.state === "offline" ? "off" : "online", saved: false }));
  return [...own, ...more];
}

/** One row of a tab's list of the PCs this phone is on: one row component fed by each tab's list. */
interface PhonePc {
  readonly key: string;
  readonly name: string;
  readonly tag: string;
  readonly status?: "online" | "off" | "removed" | undefined;
  readonly address?: string | undefined;
  /** a relay PC's own page, or what opening it does */
  readonly href?: string;
  readonly open?: () => void;
  readonly forget?: (() => void) | undefined;
  readonly data?: Readonly<Record<string, string>>;
}

/** A tab's list of the PCs this phone is on, under its controls: name, the way it connects and an online dot or Off; a tap opens it, Forget at its end. */
function PhonePcs({ pcs }: { readonly pcs: readonly PhonePc[] }) {
  const t = useT();
  if (pcs.length === 0) return null;
  return (
    <section className="relay-add-saved phone-pcs">
      <h2 className="relay-add-saved-title">{t("PCs this phone is on")}</h2>
      <ul>
        {pcs.map((pc) => {
          const inside = (
            <>
              <span className="relay-add-saved-name">{pc.name}</span>
              <span className="phone-pc-meta">
                <span className="phone-pc-tag">{pc.tag}</span>
                {pc.status === "online" && <span className="phone-pc-dot" role="img" aria-label={t("Online")} />}
                {pc.status === "off" && <span className="relay-add-saved-note">{t("Off|pc state")}</span>}
                {pc.status === "removed" && <span className="relay-add-saved-note">{t("Removed|pc state")}</span>}
                {pc.address !== undefined && pc.address !== pc.name && <span className="relay-add-saved-note">{pc.address}</span>}
              </span>
            </>
          );
          return (
            <li key={pc.key} className="phone-pc" {...pc.data}>
              {pc.href !== undefined
                ? <a className="relay-add-saved-pc" href={pc.href}>{inside}</a>
                : <button type="button" className="relay-add-saved-pc" onClick={pc.open}>{inside}</button>}
              {pc.forget && <button type="button" className="btn btn-ghost phone-pc-forget" aria-label={t("Forget {name}", { name: pc.name })} onClick={pc.forget}>{t("Forget|this phone's PC")}</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The PCs the phone app saved, read once, with a way to read them again (after a Forget); none outside the app. */
function usePhoneSaved(native: boolean): [PhoneSavedPc[], () => void] {
  const [pcs, setPcs] = useState<PhoneSavedPc[]>([]);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!native) return;
    let live = true;
    callNative<{ saved?: string[]; names?: Record<string, string> }>(SHELL, "getState").then((state) => { if (live) setPcs(phoneSavedPcs(state.saved ?? [], state.names ?? {}, window.location.origin)); }, () => undefined);
    return () => { live = false; };
  }, [native, round]);
  return [pcs, () => setRound((n) => n + 1)];
}

/** Scan a QR code, where the phone app can scan: what it read opens as a typed address would (`open`). */
function ScanWay({ open, failed }: { readonly open: AddressOpen; readonly failed: (cause: unknown) => void }) {
  const t = useT();
  return <Way icon={QrCode} title={t("Scan a QR code")} sub={t("The QR on the PC's screen")} action="scan-qr" onClick={() => { open.setError(null); scanQr(t, open.take, failed); }} />;
}

function OpenError({ open }: { readonly open: AddressOpen }) {
  return open.error === null ? null : <p className="account-error" role="alert">{open.error}</p>;
}

/**
 * The Ovis relay tab signed in: a PC joins the account from its own Ovis, signed in with the same account, so this
 * says so; a PC in no account pairs by its QR code where the phone app can scan, or by its code in a browser.
 */
export function AccountRelayPanel({ onCodeStart, onSignInAgain }: { readonly onCodeStart: () => void; readonly onSignInAgain?: ((provider: AccountProvider) => void) | undefined }) {
  const t = useT();
  const open = useAddressOpen();
  return (
    <>
      <NewPcNotices />
      <AccountJoinRequests />
      <UnconfirmedPcNotices tellConfirmed={false} onSignInAgain={onSignInAgain} />
      <p className="relay-shell-copy">{t("Turn on Ovis on the PC and sign in with the same account.")}</p>
      {canScanQr()
        ? <ScanWay open={open} failed={onCodeStart} />
        : <button type="button" className="btn btn-ghost account-link connect-start-code" data-action="add-code" onClick={onCodeStart}>{t("Pair with a code")}</button>}
      <OpenError open={open} />
    </>
  );
}

/**
 * The Tailscale tab: a PC's Tailscale address in one field. In the phone app also the PCs this phone opened on the
 * tailnet, each with Connect, and its QR scan; with Tailscale off on the phone nothing here would open, so one line and
 * Open Tailscale alone, checked again when the app comes back (from Tailscale). An app that cannot tell draws it as on.
 */
function TailscalePanel() {
  const t = useT();
  const open = useAddressOpen();
  const native = hasNativePlugin(SHELL);
  const [on, setOn] = useState(true);
  const [saved, reread] = usePhoneSaved(native);
  useEffect(() => {
    if (!native) return;
    let live = true;
    const check = (): void => {
      // an Android build without the check: as on
      callNative<{ on?: boolean }>(SHELL, "tailscale").then((answer) => { if (live) setOn(answer.on !== false); }, () => undefined);
    };
    check();
    const visible = (): void => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; document.removeEventListener("visibilitychange", visible); };
  }, [native]);
  if (!on) {
    return (
      <div className="connect-start-panel" data-tab-panel="tailscale">
        <p className="relay-shell-copy">{t("Turn on Tailscale to connect")}</p>
        <button type="button" className="btn btn-primary" onClick={() => { open.setError(null); callNative(SHELL, "openTailscale").catch(open.failed); }}>{t("Open Tailscale")}</button>
        <OpenError open={open} />
      </div>
    );
  }
  return (
    <div className="connect-start-panel" data-tab-panel="tailscale">
      <AddressForm open={open} labelShown label={t("Tailscale address")} placeholder="my-pc.tailnet.ts.net" submit={t("Connect")} />
      <p className="relay-shell-detail">{t("The phone needs the Tailscale app turned on too.")}</p>
      {canScanQr() && <ScanWay open={open} failed={open.failed} />}
      <OpenError open={open} />
      <PhonePcs pcs={saved.filter((pc) => pc.way === "tailscale").map((pc) => ({
        key: pc.origin, name: pc.name, tag: "Tailscale", address: pc.host, data: { "data-tailnet-pc": pc.origin },
        open: () => open.take(new URL(pc.origin)),
        forget: () => { callNative(SHELL, "forget", { url: pc.origin }).then(reread, open.failed); },
      }))} />
    </div>
  );
}

/**
 * The SSH tab: in the phone app SSH's user@host first, which opens the app's own SSH screen with it filled in
 * (sshHandoff); then Add by address, a text link that opens a field for a PC's https address.
 */
function SshPanel() {
  const t = useT();
  const open = useAddressOpen();
  const ssh = sshHandoff();
  const [byAddress, setByAddress] = useState(false);
  const [saved, reread] = usePhoneSaved(hasNativePlugin(SHELL));
  return (
    <div className="connect-start-panel" data-tab-panel="ssh">
      {ssh && <AddressForm open={open} labelShown ssh label="SSH" placeholder="user@host" submit={t("Connect")} />}
      <button type="button" className="connect-address-link" aria-expanded={byAddress} onClick={() => { open.setError(null); setByAddress((shown) => !shown); }}>{t("Add by address")}</button>
      {byAddress && <AddressForm open={open} labelShown label={t("PC address")} placeholder="https://my-pc.example.com" submit={t("Connect")} autoFocus />}
      <OpenError open={open} />
      {/* an SSH PC is forgotten with its keys, from the app's own connect screen (Manage) */}
      <PhonePcs pcs={saved.filter((pc) => pc.way !== "tailscale").map((pc) => ({
        key: pc.origin, name: pc.name, tag: pc.way === "ssh" ? "SSH" : t("Address"), address: pc.host,
        open: () => open.take(new URL(pc.origin)),
        forget: pc.way === "ssh" ? undefined : () => { callNative(SHELL, "forget", { url: pc.origin }).then(reread, open.failed); },
      }))} />
    </div>
  );
}

/**
 * The hosted front page: the desktop's Add a connection tabs in its order, the Ovis relay chosen, so nothing asks for a
 * sign-in first. `relay`: that tab's way in (signed out its sign-in, signed in what to do on the PC); `menu`: the
 * account's menu at the top, signed in. A browser cannot see the tailnet or reach SSH, so Tailscale and SSH each take
 * a PC's address (RelayAddPc's AddressForm, which opens that PC's own Ovis); the phone app adds what it knows.
 */
export function ConnectStart({ relay, devices, accountPcs = null, onForget, menu }: {
  readonly relay: ReactNode;
  readonly devices: readonly SavedPc[];
  /** signed in, the account's PCs, which the relay tab's list adds to this phone's own pairings (relayTabPcs) */
  readonly accountPcs?: readonly MyPc[] | null;
  /** forgets one of this phone's pairings */
  readonly onForget?: ((serverId: string) => void) | undefined;
  readonly menu?: ReactNode;
}) {
  const t = useT();
  const [way, setWay] = useState<ConnectWay>("relay");
  const label: Record<ConnectWay, string> = { relay: t("Ovis relay"), tailscale: "Tailscale", ssh: "SSH" };
  // the PCs that turned this phone away as removed (relayTabPcs), read again once one is forgotten from the list
  const [removed, setRemoved] = useState(removedPcs);
  const title = <h1 className="relay-shell-title connect-start-title">{t("Connect a PC")}</h1>;
  return (
    <>
      {menu === undefined ? title : <div className="connect-start-head">{title}{menu}</div>}
      <div className="segmented connect-start-tabs" role="group" aria-label={t("How to connect")}>
        {CONNECT_WAYS.map((each) => <button key={each} type="button" aria-pressed={way === each} data-tab={each} onClick={() => setWay(each)}>{label[each]}</button>)}
      </div>
      {way === "relay" && (
        <div className="connect-start-panel" data-tab-panel="relay">
          {relay}
          <PhonePcs pcs={relayTabPcs(devices, accountPcs, removed).map((pc) => ({
            key: pc.server_id, name: pc.name ?? t("Unnamed PC"), tag: t("Relay"), status: pc.status, href: serverScopePath(pc.server_id),
            forget: pc.status === "removed" ? () => { markRemovedPc(pc.server_id, "hidden"); setRemoved(removedPcs()); }
              : pc.saved && onForget ? () => onForget(pc.server_id) : undefined,
          }))} />
        </div>
      )}
      {way === "tailscale" && <TailscalePanel />}
      {way === "ssh" && <SshPanel />}
    </>
  );
}
