import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Keyboard, Plus, QrCode } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { callNative, hasNativeMethod, hasNativePlugin } from "../lib/nativeApp.ts";
import { isLoopbackHost, tailnetHost } from "../lib/phone.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { markRemovedPc, removedPcs, type RemovedPcMark } from "../lib/relay/shellState.ts";
import { AddressForm, canScanQr, scanQr, sshHandoff, useAddressOpen, Way, type AddressOpen, type SavedPc } from "./RelayAddPc.tsx";
import { SheepMascot } from "./SheepMascot.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

type ConnectWay = "relay" | "tailscale" | "ssh";
const CONNECT_WAYS: readonly ConnectWay[] = ["relay", "tailscale", "ssh"];

/** The phone app's shell plugin (app/android HerdrShellPlugin): the PCs this phone opened, and whether Tailscale is on. */
export const SHELL = "HerdrShell";

/** A PC the phone app saved, by the way it connects: at a Tailscale address, added over SSH (a loopback address on the phone), or at any other address. */
export interface PhoneSavedPc { readonly origin: string; readonly host: string; readonly name: string; readonly way: "tailscale" | "ssh" | "address" }

/**
 * The PCs the phone app opened (app/web/shell.js `tabPcs`, the app's own lists), each by the way it connects, for My
 * PCs: a phone has no list of its tailnet's machines, only the ones opened here. A page of the app's origin
 * (`appOrigin`: the relay's, listed by the relay) and an unreadable entry are on neither. `saved` and `names` as
 * HerdrShell's getState gives them; a MagicDNS name goes by its first label, an address by itself.
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

/** what this device's own check last found of a PC, where it settled it: it answered, or the relay found it off */
export type CheckedPc = "online" | "off";

/** A relay PC of My PCs: this phone's own pairing (`saved`, by a QR or a code), or one of the account's. */
export interface RelayTabPc { readonly server_id: string; readonly name?: string | undefined; readonly status?: "online" | "off" | "update" | "removed" | undefined; readonly saved: boolean }

/**
 * The relay PCs this phone is on: its own pairings, then, signed in, the account's PCs it can open (one its own page can
 * join) that are not among them, so a PC both paired here and in the account is listed once, as this phone's. What this
 * device knows itself comes before the account's word: a pairing's saved Ovis too old, or what its last check found
 * (`status`, RelayShell); an account PC's check that settled (`checked`). Then the account: too old needs an update, off
 * is off, and any other account PC is on, whether or not this phone is let into it yet (its own page asks for that). One
 * that turned this phone away as removed (`removed`, shellState removedPcs) says so, never on, until this phone opens it
 * again, and is left out once forgotten from the list.
 */
export function relayTabPcs(devices: readonly SavedPc[], account: readonly MyPc[] | null, removed: Readonly<Record<string, RemovedPcMark>> = {}, checked: ReadonlyMap<string, CheckedPc> = new Map()): RelayTabPc[] {
  const listed = new Map((account ?? []).map((pc) => [pc.server_id, pc]));
  const own = devices.map((device): RelayTabPc => {
    const row = listed.get(device.server_id);
    return { server_id: device.server_id, name: device.name, status: device.status ?? (row?.state === "needs-update" ? "update" : row?.state === "offline" ? "off" : undefined), saved: true };
  });
  const more = (account ?? []).filter((pc) => !pc.paired && pc.join !== undefined && !own.some((row) => row.server_id === pc.server_id) && removed[pc.server_id] !== "hidden")
    .map((pc): RelayTabPc => ({ server_id: pc.server_id, name: pc.name, status: removed[pc.server_id] === "removed" ? "removed" : pc.state === "needs-update" ? "update" : checked.get(pc.server_id) ?? (pc.state === "offline" ? "off" : "online"), saved: false }));
  return [...own, ...more];
}

/** What a row of My PCs says of its PC after its name: the account's word for it, or that this is the PC in use now. */
type PcWord = "online" | "off" | "update" | "removed" | "in-use";

const WORD_DOT: Partial<Record<PcWord, StatusDotState>> = { online: "ready", off: "offline", update: "needs-you" };

/** One row of My PCs: one row component fed by the relay's PCs and the phone app's. */
interface PhonePc {
  readonly key: string;
  readonly name: string;
  readonly way: "relay" | "tailscale" | "ssh" | "address";
  readonly word?: PcWord | undefined;
  readonly address?: string | undefined;
  /** a relay PC's own page, or what opening it does */
  readonly href?: string;
  readonly open?: () => void;
  readonly forget?: (() => void) | undefined;
  readonly data?: Readonly<Record<string, string>>;
}

function PcRow({ pc }: { readonly pc: PhonePc }) {
  const t = useT();
  const tag = { relay: t("Relay"), tailscale: "Tailscale", ssh: "SSH", address: t("Address") }[pc.way];
  const word = pc.word === undefined ? null : { online: t("On|pc state"), off: t("Off|pc state"), update: t("Update needed|pc state"), removed: t("Removed|pc state"), "in-use": t("In use now|pc state") }[pc.word];
  const dot = pc.word === undefined ? undefined : WORD_DOT[pc.word];
  const inside = (
    <>
      <span className="my-pc-text">
        <span className="relay-add-saved-name">{pc.name}</span>
        <span className="phone-pc-meta">
          <span className="phone-pc-tag">{tag}</span>
          {pc.address !== undefined && pc.address !== pc.name && <span className="my-pc-address">{pc.address}</span>}
        </span>
      </span>
      {word !== null && <span className="relay-add-saved-note my-pc-state" data-pc-state={pc.word}>{dot && <StatusDot state={dot} size="inline" />}{word}</span>}
      <ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" />
    </>
  );
  return (
    <li className="my-pc" data-pc-way={pc.way} {...pc.data}>
      {pc.href !== undefined
        ? <a className="relay-add-saved-pc" href={pc.href}>{inside}</a>
        : <button type="button" className="relay-add-saved-pc" onClick={pc.open}>{inside}</button>}
      {pc.forget && <button type="button" className="btn btn-ghost phone-pc-forget" aria-label={t("Forget {name}", { name: pc.name })} onClick={pc.forget}>{t("Forget|this phone's PC")}</button>}
    </li>
  );
}

/** how long a front page that waits on what the phone app saved holds its controls back for an answer */
const READ_WAIT_MS = 1_500;

/**
 * The PCs the phone app saved, read once, with a way to read them again (after a Forget); none outside the app, nor from
 * an app with no getState. `read`: the app answered, or `READ_WAIT_MS` went by (a call to a method an app lacks never
 * settles on iOS), so a screen chosen by whether any PC is saved neither flashes the other nor stays blank; a late answer
 * still lists its PCs.
 */
export function usePhoneSaved(native: boolean): { readonly pcs: PhoneSavedPc[]; readonly read: boolean; readonly reread: () => void } {
  const asks = native && hasNativeMethod(SHELL, "getState");
  const [pcs, setPcs] = useState<PhoneSavedPc[]>([]);
  const [read, setRead] = useState(!asks);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!asks) return;
    let live = true;
    // fixed wait: an app that does not answer holds the front page's controls back no longer than this
    const waited = setTimeout(() => { if (live) setRead(true); }, READ_WAIT_MS);
    callNative<{ saved?: string[]; names?: Record<string, string> }>(SHELL, "getState").then((state) => {
      if (!live) return;
      setPcs(phoneSavedPcs(state.saved ?? [], state.names ?? {}, window.location.origin));
      setRead(true);
    }, () => { if (live) setRead(true); }).finally(() => clearTimeout(waited));
    return () => { live = false; clearTimeout(waited); };
  }, [asks, round]);
  return { pcs, read, reread: () => setRound((n) => n + 1) };
}

function OpenError({ open }: { readonly open: AddressOpen }) {
  return open.error === null ? null : <p className="account-error" role="alert">{open.error}</p>;
}

/** The round Back of a connect screen, at its top start. */
function BackButton({ onBack }: { readonly onBack: () => void }) {
  const t = useT();
  return <button type="button" className="relay-add-back" aria-label={t("Back")} onClick={onBack}><ChevronLeft aria-hidden="true" /></button>;
}

/**
 * A connect screen's sheep and title, Back at its start and the account's menu at its end where they apply; `focused`: the
 * screen replaced the control that had the focus (Add PC opened it), so its title takes it and a keyboard keeps its place.
 */
function ConnectHead({ title, onBack, menu, focused = false }: { readonly title: string; readonly onBack?: (() => void) | undefined; readonly menu?: ReactNode; readonly focused?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focused) heading.current?.focus(); }, [focused]);
  return (
    <>
      <SheepMascot screen="header" size={56} />
      <div className="connect-start-head">
        {onBack && <BackButton onBack={onBack} />}
        <h1 className="relay-shell-title connect-start-title" ref={heading} tabIndex={-1}>{title}</h1>
        {menu}
      </div>
    </>
  );
}

/**
 * My PCs: every PC this phone can open in one list, the relay's (this phone's pairings, then the account's) and the ones
 * the phone app saved by a Tailscale address, over SSH or at another address, each with the way it connects and, for a
 * relay PC, the word the account or its last check has for it; `inUse`: the PC whose More opened this (`/#add`), marked
 * In use now instead. A row opens its PC; Forget at its end where this phone can forget it here (an SSH PC goes with its
 * keys, from the app's own connect screen). `top`: what the screen says above the list (notices, a PC not answering);
 * `empty`: what it says with nothing listed. Add PC stays at the bottom of the screen while the list scrolls.
 */
export function MyPcs({ devices, accountPcs = null, checked, phone, onForget, inUse = null, onBack, onAdd, addFocused = false, menu, top, empty }: {
  readonly devices: readonly SavedPc[];
  /** signed in, the account's PCs, which the list adds to this phone's own pairings (relayTabPcs) */
  readonly accountPcs?: readonly MyPc[] | null;
  /** what this device's own checks settled of the account's PCs (relayTabPcs) */
  readonly checked?: ReadonlyMap<string, CheckedPc>;
  /** back from Add a PC, whose Back was the control with the focus: Add PC takes it again */
  readonly addFocused?: boolean;
  readonly phone: ReturnType<typeof usePhoneSaved>;
  /** forgets one of this phone's pairings */
  readonly onForget?: ((serverId: string) => void) | undefined;
  readonly inUse?: string | null;
  readonly onBack?: (() => void) | undefined;
  readonly onAdd: () => void;
  readonly menu?: ReactNode;
  readonly top?: ReactNode;
  readonly empty?: ReactNode;
}) {
  const t = useT();
  const open = useAddressOpen();
  // the PCs that turned this phone away as removed (relayTabPcs), read again once one is forgotten from the list
  const [removed, setRemoved] = useState(removedPcs);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (addFocused) addButton.current?.focus(); }, [addFocused]);
  const forgetSaved = (pc: PhoneSavedPc) => () => { open.setError(null); callNative(SHELL, "forget", { url: pc.origin }).then(phone.reread, open.failed); };
  const fromPhone = (pc: PhoneSavedPc): PhonePc => ({
    key: pc.origin, name: pc.name, way: pc.way, address: pc.host, ...(pc.way === "tailscale" ? { data: { "data-tailnet-pc": pc.origin } } : {}),
    open: () => open.take(new URL(pc.origin)),
    forget: pc.way === "ssh" ? undefined : forgetSaved(pc),
  });
  const rows: PhonePc[] = [
    ...relayTabPcs(devices, accountPcs, removed, checked).map((pc): PhonePc => ({
      key: pc.server_id, name: pc.name ?? t("Unnamed PC"), way: "relay", word: pc.server_id === inUse ? "in-use" : pc.status, href: serverScopePath(pc.server_id),
      forget: pc.status === "removed" ? () => { markRemovedPc(pc.server_id, "hidden"); setRemoved(removedPcs()); }
        : pc.saved && onForget ? () => onForget(pc.server_id) : undefined,
    })),
    ...phone.pcs.filter((pc) => pc.way === "tailscale").map(fromPhone),
    ...phone.pcs.filter((pc) => pc.way !== "tailscale").map(fromPhone),
  ];
  return (
    <div className="my-pcs" data-view="my-pcs">
      <ConnectHead title={t("Your PCs")} onBack={onBack} menu={menu} />
      {top}
      {rows.length > 0 ? <ul className="my-pcs-list">{rows.map((pc) => <PcRow key={pc.key} pc={pc} />)}</ul> : empty}
      <OpenError open={open} />
      <div className="my-pcs-add"><button ref={addButton} type="button" className="btn btn-primary" data-action="add-pc" onClick={onAdd}><Plus aria-hidden="true" />{t("Add PC")}</button></div>
    </div>
  );
}

/** Scan a QR code, where the phone app can scan: what it read opens as a typed address would (`open`). */
function ScanWay({ open, failed, disabled = false }: { readonly open: AddressOpen; readonly failed: (cause: unknown) => void; readonly disabled?: boolean }) {
  const t = useT();
  return <Way icon={QrCode} title={t("Scan a QR code")} sub={t("The QR on the PC's screen")} action="scan-qr" disabled={disabled} onClick={() => { open.setError(null); scanQr(t, open.take, failed); }} />;
}

/**
 * The relay tab's way in to a PC: its QR code where the phone app can scan, else its code typed in (a browser); a scanner
 * that cannot run (the camera refused) leads to the code too. `disabled` while a sign-in is under way.
 */
function QrOrCode({ onCodeStart, disabled = false }: { readonly onCodeStart: () => void; readonly disabled?: boolean }) {
  const t = useT();
  const open = useAddressOpen();
  return (
    <>
      {canScanQr()
        ? <ScanWay open={open} failed={onCodeStart} disabled={disabled} />
        : <Way icon={Keyboard} title={t("Pair with a code")} sub={t("Code from the PC")} action="add-code" disabled={disabled} onClick={onCodeStart} />}
      <OpenError open={open} />
    </>
  );
}

/** The relay tab signed out: the sign-in (`signIn`, AccountSignIn), then the PC's QR code or its code, for a PC in no account. */
export function SignedOutRelayPanel({ signIn, signingIn, onCodeStart }: { readonly signIn: ReactNode; readonly signingIn: boolean; readonly onCodeStart: () => void }) {
  const t = useT();
  return (
    <>
      {signIn}
      <p className="relay-shell-first-time">{t("First time? Your account is made right away.")}</p>
      <QrOrCode onCodeStart={onCodeStart} disabled={signingIn} />
    </>
  );
}

/**
 * The relay tab signed in: a PC joins the account from its own Ovis, signed in with the same account, so this says so; a
 * PC in no account pairs by its QR code where the phone app can scan, or by its code in a browser.
 */
export function AccountRelayPanel({ onCodeStart }: { readonly onCodeStart: () => void }) {
  const t = useT();
  return (
    <>
      <p className="relay-shell-copy">{t("Turn on Ovis on the PC and sign in with the same account.")}</p>
      <QrOrCode onCodeStart={onCodeStart} />
    </>
  );
}

/** The relay tab of a relay with no accounts: where the PC shows its QR code, then that QR code or its code. */
export function AccountlessRelayPanel({ onCodeStart }: { readonly onCodeStart: () => void }) {
  const t = useT();
  return (
    <>
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay and scan the QR code.")}</p>
      <QrOrCode onCodeStart={onCodeStart} />
    </>
  );
}

/**
 * The Tailscale tab: a PC's Tailscale address in one field, and in the phone app its QR scan; with Tailscale off on the
 * phone nothing here would open, so one line and Open Tailscale alone, checked again when the app comes back (from
 * Tailscale). An app that cannot tell draws it as on.
 */
function TailscalePanel() {
  const t = useT();
  const open = useAddressOpen();
  const native = hasNativePlugin(SHELL);
  const [on, setOn] = useState(true);
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
  return (
    <div className="connect-start-panel" data-tab-panel="ssh">
      {ssh && <AddressForm open={open} labelShown ssh label="SSH" placeholder="user@host" submit={t("Connect")} />}
      <button type="button" className="connect-address-link" aria-expanded={byAddress} onClick={() => { open.setError(null); setByAddress((shown) => !shown); }}>{t("Add by address")}</button>
      {byAddress && <AddressForm open={open} labelShown label={t("PC address")} placeholder="https://my-pc.example.com" submit={t("Connect")} autoFocus />}
      <OpenError open={open} />
    </div>
  );
}

/**
 * Add a PC: the desktop's Add a connection tabs in its order, the Ovis relay chosen, holding only the ways to add or
 * open a PC, no list. `relay`: that tab's way in (signed out its sign-in, signed in what to do on the PC); `title`:
 * Connect a PC where this is the front page, Add PC behind My PCs (`onBack`). A browser cannot see the tailnet or reach
 * SSH, so Tailscale and SSH each take a PC's address (RelayAddPc's AddressForm, which opens that PC's own Ovis); the
 * phone app adds what it knows.
 */
export function AddPcTabs({ title, relay, onBack, focused = false }: { readonly title: string; readonly relay: ReactNode; readonly onBack?: (() => void) | undefined; readonly focused?: boolean }) {
  const t = useT();
  const [way, setWay] = useState<ConnectWay>("relay");
  const label: Record<ConnectWay, string> = { relay: t("Ovis relay"), tailscale: "Tailscale", ssh: "SSH" };
  return (
    <div className="connect-add" data-view="add-pc">
      <ConnectHead title={title} onBack={onBack} focused={focused} />
      <div className="segmented connect-start-tabs" role="group" aria-label={t("How to connect")}>
        {CONNECT_WAYS.map((each) => <button key={each} type="button" aria-pressed={way === each} data-tab={each} onClick={() => setWay(each)}>{label[each]}</button>)}
      </div>
      {way === "relay" && <div className="connect-start-panel" data-tab-panel="relay">{relay}</div>}
      {way === "tailscale" && <TailscalePanel />}
      {way === "ssh" && <SshPanel />}
    </div>
  );
}
