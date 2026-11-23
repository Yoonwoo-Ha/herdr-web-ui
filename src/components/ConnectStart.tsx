import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Plus, QrCode } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { callNative, hasNativeMethod, hasNativePlugin } from "../lib/nativeApp.ts";
import { isLoopbackHost, tailnetHost } from "../lib/phone.ts";
import type { KnownPc } from "../lib/account/knownPcs.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { serverIdOfPath, serverScopePath } from "../lib/shellMode.ts";
import { markRemovedPc, removedPcs, type RemovedPcMark } from "../lib/relay/shellState.ts";
import { StartScreenAccountMenu } from "./AccountHead.tsx";
import { deviceOffline, useOffline } from "../lib/useOffline.ts";
import { AddressForm, canScanQr, clearOutcome, offlineOpenText, OpenError, OpenStatus, scanQr, sshHandoff, tailscaleOn, useAddressOpen, Way, type AddressOpen, type SavedPc } from "./RelayAddPc.tsx";
import { codeFailureText, type TypedCodeFailure } from "./codeFailureText.ts";
import { SheepMascot } from "./SheepMascot.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

export type ConnectWay = "relay" | "tailscale" | "ssh";
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
 * is off, and any other account PC is on, whether or not this phone is let into it yet (its own page asks for that), as
 * is a pairing of this phone's that the directory lists (one it does not list, it says nothing of). One
 * that turned this phone away as removed (`removed`, shellState removedPcs) says so, never on, until this phone opens it
 * again, and is left out once forgotten from the list. `known`: with the account unread now (no internet), the account's
 * PCs it listed last (knownPcs), by name with no state word, each that is not listed already.
 */
export function relayTabPcs(devices: readonly SavedPc[], account: readonly MyPc[] | null, removed: Readonly<Record<string, RemovedPcMark>> = {}, checked: ReadonlyMap<string, CheckedPc> = new Map(), known: readonly KnownPc[] = []): RelayTabPc[] {
  const listed = new Map((account ?? []).map((pc) => [pc.server_id, pc]));
  const own = devices.map((device): RelayTabPc => {
    const row = listed.get(device.server_id);
    return { server_id: device.server_id, name: device.name, status: device.status ?? (row?.state === "needs-update" ? "update" : row?.state === "offline" ? "off" : row?.listed ? "online" : undefined), saved: true };
  });
  const more = (account ?? []).filter((pc) => !pc.paired && pc.join !== undefined && !own.some((row) => row.server_id === pc.server_id) && removed[pc.server_id] !== "hidden")
    .map((pc): RelayTabPc => ({ server_id: pc.server_id, name: pc.name, status: removed[pc.server_id] === "removed" ? "removed" : pc.state === "needs-update" ? "update" : checked.get(pc.server_id) ?? (pc.state === "offline" ? "off" : "online"), saved: false }));
  const rows = [...own, ...more];
  const kept = known.filter((pc) => !rows.some((row) => row.server_id === pc.server_id) && removed[pc.server_id] !== "hidden")
    .map((pc): RelayTabPc => ({ server_id: pc.server_id, name: pc.name, status: removed[pc.server_id] === "removed" ? "removed" : undefined, saved: false }));
  return [...rows, ...kept];
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
  /** a tap on `href`, which may keep the page from going there */
  readonly onLink?: (event: { preventDefault(): void }) => void;
  readonly open?: () => void;
  readonly forget?: (() => void) | undefined;
  readonly data?: Readonly<Record<string, string>>;
}

/**
 * One row of My PCs: it opens its PC, the whole row; `editing`, the list's Forget PCs: it opens nothing, and a row this
 * phone can forget has Forget in its chevron's place, which on the PC in use asks once more in the row first (`asking`).
 */
function PcRow({ pc, editing = false, asking = false, onAsk, onKeep }: { readonly pc: PhonePc; readonly editing?: boolean; readonly asking?: boolean; readonly onAsk: () => void; readonly onKeep: () => void }) {
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
      {!editing && <ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" />}
    </>
  );
  const forget = editing ? pc.forget : undefined;
  return (
    <li className="my-pc" data-pc-way={pc.way} {...pc.data}>
      {editing ? <div className="relay-add-saved-pc is-editing">{inside}</div>
        : pc.href !== undefined ? <a className="relay-add-saved-pc" href={pc.href} onClick={pc.onLink}>{inside}</a>
        : <button type="button" className="relay-add-saved-pc" onClick={pc.open}>{inside}</button>}
      {forget && <button type="button" className="btn btn-ghost phone-pc-forget" data-action="forget-pc" aria-label={t("Forget {name}", { name: pc.name })} aria-expanded={pc.word === "in-use" ? asking : undefined} onClick={pc.word === "in-use" ? onAsk : forget}>{t("Forget|this phone's PC")}</button>}
      {forget && asking && (
        <div className="my-pc-ask" role="group" aria-label={pc.name} data-forget-ask="">
          <p className="relay-shell-copy">{t("This is the PC in use now. Forget it?")}</p>
          <button type="button" className="btn btn-danger" onClick={forget}>{t("Forget|this phone's PC")}</button>
          <button type="button" className="btn" onClick={onKeep}>{t("Cancel")}</button>
        </div>
      )}
    </li>
  );
}

/** HerdrShell getState as the phone app answers it (app/android HerdrShellPlugin, app/ios HerdrShellPlugin.swift). */
interface ShellAnswer { readonly saved?: string[]; readonly names?: Record<string, string>; readonly choosing?: boolean; readonly current?: string; readonly kind?: string; readonly failure?: string }

/**
 * The PC the phone app still has open while the person chooses another: a relay PC of this app by its id, any other by
 * its origin and, for a relay PC of another origin (a self-hosted relay), its scope there.
 */
export type CurrentPc = { readonly serverId: string } | { readonly origin: string; readonly scope: string | null };

/** how long a front page that waits on what the phone app saved holds its controls back for an answer */
const READ_WAIT_MS = 1_500;

/**
 * What the phone app says it has: the PCs it saved (phoneSavedPcs); `current`, the PC it keeps open while the person
 * chooses another (HerdrShell chooseAnother: `choosing` with `current`, app/web/connect.js showBackToPc), a relay PC by
 * its page on this app's origin and any other by its address; and `sshPort`, the address an SSH PC opens on that another
 * app on the phone took first, so the app did not open it (OvisSshPlugin.listen, getState `kind` "ssh-port").
 */
export function phoneShellState(state: ShellAnswer, appOrigin: string): { readonly pcs: PhoneSavedPc[]; readonly current: CurrentPc | null; readonly sshPort: string | null } {
  let current: CurrentPc | null = null;
  if (state.choosing === true && state.current) {
    try {
      const url = new URL(state.current);
      const serverId = url.origin === appOrigin ? serverIdOfPath(url.pathname) : null;
      current = url.origin !== appOrigin ? { origin: url.origin, scope: serverIdOfPath(url.pathname) } : serverId === null ? null : { serverId };
    } catch { current = null; }
  }
  return { pcs: phoneSavedPcs(state.saved ?? [], state.names ?? {}, appOrigin), current, sshPort: state.kind === "ssh-port" && state.failure ? state.failure : null };
}

/**
 * What the phone app says it has (phoneShellState), read once, with a way to read it again (after a Forget); nothing
 * outside the app, nor from an app with no getState. `read`: the app answered, or `READ_WAIT_MS` went by (a call to a
 * method an app lacks never settles on iOS), so a screen chosen by whether any PC is saved neither flashes the other nor
 * stays blank; a late answer still lists its PCs.
 */
export function usePhoneSaved(native: boolean): ReturnType<typeof phoneShellState> & { readonly read: boolean; readonly reread: () => void } {
  const asks = native && hasNativeMethod(SHELL, "getState");
  const [shell, setShell] = useState<ReturnType<typeof phoneShellState>>({ pcs: [], current: null, sshPort: null });
  const [read, setRead] = useState(!asks);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!asks) return;
    let live = true;
    // fixed wait: an app that does not answer holds the front page's controls back no longer than this
    const waited = setTimeout(() => { if (live) setRead(true); }, READ_WAIT_MS);
    callNative<ShellAnswer>(SHELL, "getState").then((state) => {
      if (!live) return;
      setShell(phoneShellState(state, window.location.origin));
      setRead(true);
    }, () => { if (live) setRead(true); }).finally(() => clearTimeout(waited));
    return () => { live = false; clearTimeout(waited); };
  }, [asks, round]);
  return { ...shell, read, reread: () => setRound((n) => n + 1) };
}

/** Which of a long My PCs are shown: every one, the ones on (the PC in use is on) or the ones off. */
export type PcShow = "all" | "on" | "off";

/** My PCs past this many PCs offers a search by name (and on a wide screen the On and Off chips) */
const SEARCH_PAST = 8;

/** The rows of My PCs whose name holds `query`, in any case, and that `show` keeps; a row with no state word only under All. */
export function pcsShown<T extends { readonly name: string; readonly word?: string | undefined }>(rows: readonly T[], query: string, show: PcShow): T[] {
  const wanted = query.trim().toLowerCase();
  const kept = (word: string | undefined): boolean => show === "all" || (show === "on" ? word === "online" || word === "in-use" : word === "off");
  return rows.filter((row) => (wanted === "" || row.name.toLowerCase().includes(wanted)) && kept(row.word));
}

/** The round Back of a connect screen, at its top start; `label` names where it goes when that is not the screen before. */
function BackButton({ onBack, label }: { readonly onBack: () => void; readonly label?: string | undefined }) {
  const t = useT();
  return <button type="button" className="relay-add-back" aria-label={label ?? t("Back")} onClick={onBack}><ChevronLeft aria-hidden="true" /></button>;
}

/**
 * A connect screen's sheep and title, Back at its start and the account's menu at its end where they apply; `side`: the
 * panel beside My PCs on a wide screen, under the page's own title, so no sheep and a heading one level down; `focus`:
 * counts the times the screen replaced the control that had the focus (Add PC opened it), each moving the focus to its
 * title so a keyboard keeps its place; a resize that only shows it again moves nothing.
 */
function ConnectHead({ title, onBack, backLabel, menu, side = false, focus = 0 }: { readonly title: string; readonly onBack?: (() => void) | undefined; readonly backLabel?: string | undefined; readonly menu?: ReactNode; readonly side?: boolean; readonly focus?: number }) {
  const Title = side ? "h2" : "h1";
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus > 0) heading.current?.focus(); }, [focus]);
  return (
    <>
      {!side && <SheepMascot screen="header" size={56} />}
      <div className="connect-start-head">
        {onBack && <BackButton onBack={onBack} label={backLabel} />}
        <Title className="relay-shell-title connect-start-title" ref={heading} tabIndex={-1}>{title}</Title>
        {menu}
      </div>
    </>
  );
}

/** Whether the app's saved entry is the PC it keeps open: the same origin, and the same relay scope there or none. */
function isCurrent(saved: string, current: CurrentPc | null): boolean {
  if (current === null || !("origin" in current)) return false;
  try {
    const url = new URL(saved);
    return url.origin === current.origin && serverIdOfPath(url.pathname) === current.scope;
  } catch { return false; }
}

/**
 * My PCs: every PC this phone can open in one list, the relay's (this phone's pairings, then the account's) and the ones
 * the phone app saved by a Tailscale address, over SSH or at another address, each with the way it connects and, for a
 * relay PC, the word the account or its last check has for it. The PC in use now is marked so instead: `inUse`, the PC
 * whose More opened this (`/#add`), else the one the phone app keeps open while the person chooses another, whose Back
 * goes back to it where the app can; its row does the same. A row opens its PC. Forget is no row's: the ⋮ menu's Forget
 * PCs, there whenever a row can be forgotten here (an SSH PC goes with its keys, from the app's own connect screen),
 * puts Forget on those rows until Done (PcRow). Past eight PCs a search by name, and on a `wide` screen the On and Off
 * chips. `top`: what the screen says above the list (notices, a PC not answering); `empty`: what it says with nothing
 * listed. Add PC (`onAdd`, none beside the panel on a wide screen) stays at the bottom while the list scrolls.
 */
export function MyPcs({ devices, accountPcs = null, knownPcs, checked, phone, onForget, inUse = null, onBack, onAdd, focusAdd = 0, accountMenu = false, top, empty, wide = false, hidden = false }: {
  readonly devices: readonly SavedPc[];
  /** signed in, the account's PCs, which the list adds to this phone's own pairings (relayTabPcs) */
  readonly accountPcs?: readonly MyPc[] | null;
  /** the account unread now: the account's PCs it listed last (relayTabPcs) */
  readonly knownPcs?: readonly KnownPc[] | undefined;
  /** what this device's own checks settled of the account's PCs (relayTabPcs) */
  readonly checked?: ReadonlyMap<string, CheckedPc>;
  /** counts the times Add a PC's Back, the control with the focus, came back here: each gives Add PC the focus again */
  readonly focusAdd?: number;
  readonly phone: ReturnType<typeof usePhoneSaved>;
  /** forgets one of this phone's pairings */
  readonly onForget?: ((serverId: string) => void) | undefined;
  readonly inUse?: string | null;
  readonly onBack?: (() => void) | undefined;
  readonly onAdd?: (() => void) | undefined;
  /** signed in: the ⋮ menu holds the account's items too (StartScreenAccountMenu) */
  readonly accountMenu?: boolean;
  readonly top?: ReactNode;
  readonly empty?: ReactNode;
  readonly wide?: boolean;
  /** kept mounted but not shown (Add a PC stands in its place on a phone): what it holds survives the switch back */
  readonly hidden?: boolean;
}) {
  const t = useT();
  const open = useAddressOpen("list");
  // what a tap said with no network on this device is over once it is back
  const offline = useOffline();
  const { setError } = open;
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) { setError(null); clearOutcome(); }
    wasOffline.current = offline;
  }, [offline, setError]);
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<PcShow>("all");
  // the PCs that turned this phone away as removed (relayTabPcs), read again once one is forgotten from the list
  const [removed, setRemoved] = useState(removedPcs);
  const current = inUse === null ? phone.current : null;
  // Forget PCs: the rows this phone can forget have Forget, and the PC in use's asks once more first (`asking`, its key)
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focusAdd > 0) addButton.current?.focus(); }, [focusAdd]);
  // Done, or the last PC to forget gone, takes the Done button away: Add PC, in its place, takes the focus
  const wasEditing = useRef(false);
  useEffect(() => { if (wasEditing.current && !editing) addButton.current?.focus(); wasEditing.current = editing; }, [editing]);
  // the app keeps a PC open while the person chooses another: Back goes back to it, where the app can (an app built
  // before backToCurrent opens no page while choosing)
  const backToCurrent = onBack === undefined && current !== null && hasNativeMethod(SHELL, "backToCurrent")
    ? () => { open.setError(null); callNative(SHELL, "backToCurrent").catch(open.failed); } : undefined;
  // the PC in use is open already: its row goes back to it as Back does, rather than opening it again
  const goBack = onBack ?? backToCurrent;
  // a relay PC's page opens nothing with no network on this device: the row says so instead of going there
  const offlineLink = (event: { preventDefault(): void }): void => { if (deviceOffline()) { event.preventDefault(); open.setError(offlineOpenText(t)); } };
  const forgetSaved = (pc: PhoneSavedPc) => () => { open.setError(null); callNative(SHELL, "forget", { url: pc.origin }).then(phone.reread, open.failed); };
  // a saved Tailscale PC asks the app first whether Tailscale is on: off, Open Tailscale takes over (TailscaleOff)
  const fromPhone = (pc: PhoneSavedPc): PhonePc => ({
    key: pc.origin, name: pc.name, way: pc.way, address: pc.host, ...(pc.way === "tailscale" ? { data: { "data-tailnet-pc": pc.origin } } : {}),
    ...(isCurrent(pc.origin, current) ? { word: "in-use" as const } : {}),
    open: isCurrent(pc.origin, current) && goBack ? goBack : () => open.take(new URL(pc.origin), { askTailscale: pc.way === "tailscale" }),
    forget: pc.way === "ssh" ? undefined : forgetSaved(pc),
  });
  const rows: PhonePc[] = [
    ...relayTabPcs(devices, accountPcs, removed, checked, knownPcs).map((pc): PhonePc => {
      const used = pc.server_id === inUse || (current !== null && "serverId" in current && current.serverId === pc.server_id);
      return {
        key: pc.server_id, name: pc.name ?? t("Unnamed PC"), way: "relay", ...(used && goBack ? { open: goBack } : { href: serverScopePath(pc.server_id), onLink: offlineLink }),
        word: used ? "in-use" : pc.status,
        forget: pc.status === "removed" ? () => { markRemovedPc(pc.server_id, "hidden"); setRemoved(removedPcs()); }
          : pc.saved && onForget ? () => onForget(pc.server_id) : undefined,
      };
    }),
    ...phone.pcs.filter((pc) => pc.way === "tailscale").map(fromPhone),
    ...phone.pcs.filter((pc) => pc.way !== "tailscale").map(fromPhone),
  ];
  const forgettable = rows.some((row) => row.forget !== undefined);
  if (editing && !forgettable) setEditing(false);
  if (asking !== null && !rows.some((row) => row.key === asking && row.forget !== undefined)) setAsking(null);
  const stopEditing = (): void => { setEditing(false); setAsking(null); };
  const currentName = rows.find((row) => row.word === "in-use")?.name ?? t("this PC");
  const searchable = rows.length > SEARCH_PAST;
  const shown = searchable ? pcsShown(rows, query, wide ? show : "all") : rows;
  const label: Record<PcShow, string> = { all: t("All"), on: t("On|pc state"), off: t("Off|pc state") };
  return (
    <div className="my-pcs" data-view="my-pcs" hidden={hidden || undefined}>
      <ConnectHead title={t("Your PCs")} onBack={onBack ?? backToCurrent} backLabel={backToCurrent ? t("Back to {name}", { name: currentName }) : undefined} menu={<StartScreenAccountMenu account={accountMenu} onForgetPcs={forgettable ? () => setEditing(true) : undefined} />} />
      {top}
      {!hidden && <OpenStatus view="list" anyView={!wide} tailscaleOff={<TailscaleOff />} />}
      <OpenError open={open} />
      {phone.sshPort !== null && <p className="account-error" role="alert">{t("Another app on this phone took the address the SSH PC opens on ({address}), so the app did not open it: that app would have answered in its place. Close or uninstall the app you do not know, or restart the phone, then open the PC again.", { address: phone.sshPort })}</p>}
      {searchable && (
        <div className="my-pcs-find">
          <input type="search" className="input my-pcs-search" aria-label={t("Search PC names")} placeholder={t("Search PC names")} value={query} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setQuery(event.currentTarget.value)} />
          {wide && (
            <div className="segmented my-pcs-chips" role="group" aria-label={t("Filter PCs")}>
              {(["all", "on", "off"] as const).map((each) => <button key={each} type="button" aria-pressed={show === each} data-show={each} onClick={() => setShow(each)}>{label[each]}</button>)}
            </div>
          )}
        </div>
      )}
      {shown.length > 0 ? <ul className="my-pcs-list">{shown.map((pc) => <PcRow key={pc.key} pc={pc} editing={editing} asking={asking === pc.key} onAsk={() => setAsking(pc.key)} onKeep={() => setAsking(null)} />)}</ul>
        : rows.length > 0 ? <p className="relay-shell-copy my-pcs-none" role="status">{t("No PC matches.")}</p> : empty}
      {editing ? <div className="my-pcs-add"><button type="button" className="btn btn-primary" data-action="forget-done" onClick={stopEditing}>{t("Done")}</button></div>
        : onAdd && <div className="my-pcs-add"><button ref={addButton} type="button" className="btn btn-primary" data-action="add-pc" onClick={onAdd}><Plus aria-hidden="true" />{t("Add PC")}</button></div>}
    </div>
  );
}

/** Scan a QR code, where the phone app can scan: what it read opens as a typed address would (`open`). */
function ScanWay({ open, failed, disabled = false }: { readonly open: AddressOpen; readonly failed: (cause: unknown) => void; readonly disabled?: boolean }) {
  const t = useT();
  return <Way icon={QrCode} title={t("Scan a QR code")} sub={t("The QR on the PC's screen")} action="scan-qr" disabled={disabled} onClick={() => { open.setError(null); scanQr(t, open.scanned, open.ifLive(failed)); }} />;
}

/**
 * The code a PC shows: one small line that opens its field in place. Its Pair looks the code up right here (`code.submit`):
 * while it looks the field is read-only, and after a failure the person can correct it, the same field keeping what was
 * typed, with Cancel; a code that found its PC goes on to the comparison, and that, Cancel or folding the field away ends
 * the lookup and closes the field, so dropping the code. The code stays in its input alone (src/AGENTS.md).
 */
function CodeLine({ code, disabled }: { readonly code: CodeWays; readonly disabled: boolean }) {
  const t = useT(), id = useId();
  const [shown, setShown] = useState(false);
  // the lookup this field started ended (a PC found, or Cancel): the field closes
  const [wasActive, setWasActive] = useState(false);
  if (code.state.active !== wasActive) {
    setWasActive(code.state.active);
    if (!code.state.active) setShown(false);
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!code.state.looking) code.submit((event.currentTarget.elements.namedItem("code") as HTMLInputElement).value);
  };
  return (
    <>
      <button type="button" className="connect-address-link" data-action="add-code" disabled={disabled} aria-expanded={shown} onClick={() => { if (shown && code.state.active) code.cancel(); setShown(!shown); }}>{t("Pair with a code")}</button>
      {shown && (
        <form className="relay-shell-code-form" data-code-form="" onSubmit={submit}>
          <label className="relay-shell-field-label" htmlFor={`${id}-code`}>{t("Code from the PC")}</label>
          <input id={`${id}-code`} name="code" className="input relay-shell-code-input" placeholder="XXXXX-XXXXX" disabled={disabled} readOnly={code.state.looking} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus />
          {code.state.failure !== null && <p className="account-error" role="alert">{codeFailureText(t, code.state.failure)}</p>}
          <div className="relay-shell-actions">
            <button type="submit" className="btn btn-primary" disabled={disabled || code.state.looking} aria-busy={code.state.looking || undefined}>{code.state.looking ? t("Looking for the PC…") : t("Pair")}</button>
            {code.state.active && <button type="button" className="btn" onClick={code.cancel}>{t("Cancel")}</button>}
          </div>
        </form>
      )}
    </>
  );
}

/**
 * How the relay tab's code goes on: `start` opens the code screen (a scanner that could not run); `submit` looks up a
 * code typed in the tab's own field, whose lookup (`state`: under way, `looking` now, the `failure` it ended on) shows
 * there until it finds its PC; `cancel` ends it (the connect screen owns it, and ends it too when the person leaves).
 */
export interface CodeWays {
  readonly start: () => void;
  readonly submit: (code: string) => void;
  readonly cancel: () => void;
  readonly state: { readonly active: boolean; readonly looking: boolean; readonly failure: TypedCodeFailure | null };
}

/**
 * The relay tab's way in to a PC: its QR code where the phone app can scan, and its code everywhere (the PC offers both),
 * folded to one line; a scanner that cannot run (the camera refused) leads to the code screen. Both are held while a
 * sign-in is under way (`disabled`).
 */
function QrOrCode({ code, disabled = false }: { readonly code: CodeWays; readonly disabled?: boolean }) {
  const open = useAddressOpen("add");
  return (
    <>
      {canScanQr() && <ScanWay open={open} failed={code.start} disabled={disabled} />}
      <CodeLine code={code} disabled={disabled} />
      <OpenError open={open} />
    </>
  );
}

/**
 * The relay tab signed out: what an account gives, the sign-in (`signIn`, AccountSignIn), then the PC's QR code or its
 * code, for a PC in no account, and that the other tabs need no sign-in.
 */
export function SignedOutRelayPanel({ signIn, signingIn, code }: { readonly signIn: ReactNode; readonly signingIn: boolean; readonly code: CodeWays }) {
  const t = useT();
  return (
    <>
      <p className="relay-shell-copy">{t("Reach your PCs from anywhere with your Ovis account")}</p>
      {signIn}
      <p className="relay-shell-first-time">{t("First time? Your account is made right away.")}</p>
      <QrOrCode code={code} disabled={signingIn} />
      <p className="relay-shell-detail">{t("Tailscale and SSH need no sign-in.")}</p>
    </>
  );
}

/**
 * The relay tab signed in: a PC joins the account from its own Ovis, signed in with the same account, so this says so; a
 * PC in no account pairs by its QR code where the phone app can scan, or by its code in a browser.
 */
export function AccountRelayPanel({ code }: { readonly code: CodeWays }) {
  const t = useT();
  return (
    <>
      <p className="relay-shell-copy">{t("Turn on Ovis on the PC and sign in with the same account.")}</p>
      <QrOrCode code={code} />
    </>
  );
}

/** The relay tab of a relay with no accounts: where the PC shows its QR code, then that QR code or its code. */
export function AccountlessRelayPanel({ code }: { readonly code: CodeWays }) {
  const t = useT();
  return (
    <>
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay and scan the QR code.")}</p>
      <QrOrCode code={code} />
    </>
  );
}

/** With Tailscale off on the phone a Tailscale address opens nothing: one line and Open Tailscale, where the app has it. */
function TailscaleOff() {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="connect-tailscale-off" role="alert" data-tailscale-off="">
      <p className="relay-shell-copy">{t("Turn on Tailscale to connect")}</p>
      {hasNativeMethod(SHELL, "openTailscale") && <button type="button" className="btn btn-primary" onClick={() => { setError(null); callNative(SHELL, "openTailscale").catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }}>{t("Open Tailscale")}</button>}
      {error !== null && <p className="account-error">{error}</p>}
    </div>
  );
}

/**
 * My PCs with no network on this device (useOffline): one line that says so, naming the phone in the phone app, and Try
 * again, which reads what the screen shows once more (as the network coming back does by itself).
 */
export function OfflineLine({ onRetry }: { readonly onRetry: () => void }) {
  const t = useT();
  return (
    <p className="account-error my-pcs-offline" role="alert" data-offline="">
      {hasNativePlugin(SHELL) ? t("This phone is not connected to the internet.") : t("This device is not connected to the internet.")}
      {" "}<button type="button" className="account-link" onClick={onRetry}>{t("Try again")}</button>
    </p>
  );
}

/**
 * The Tailscale tab: a PC's Tailscale address in one field, and in the phone app its QR scan; with Tailscale off on the
 * phone a tailnet address opens nothing, so one line and Open Tailscale come first (TailscaleOff), the field still under
 * it for an address on the home network. It asks the app while it is on screen (`shown`): as it comes into view and when
 * the app comes back (from Tailscale). An app that cannot tell draws it as on. `status`: the connect screen's open, at
 * the panel's end.
 */
function TailscalePanel({ shown, status }: { readonly shown: boolean; readonly status: ReactNode }) {
  const t = useT();
  const open = useAddressOpen("add");
  const native = hasNativePlugin(SHELL);
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!native || !shown) return;
    let live = true;
    const check = (): void => { void tailscaleOn().then((now) => { if (live) setOn(now); }); };
    check();
    const visible = (): void => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; document.removeEventListener("visibilitychange", visible); };
  }, [native, shown]);
  return (
    <div className="connect-start-panel" data-tab-panel="tailscale">
      {!on && <TailscaleOff />}
      <AddressForm open={open} labelShown label={t("Tailscale address")} placeholder="my-pc.tailnet.ts.net" submit={t("Connect")} />
      {on && <p className="relay-shell-detail">{t("The phone needs the Tailscale app turned on too.")}</p>}
      {canScanQr() && <ScanWay open={open} failed={open.failed} />}
      {status}
      <OpenError open={open} />
    </div>
  );
}

/**
 * The SSH tab: in the phone app SSH's user@host first, which opens the app's own SSH screen with it filled in
 * (sshHandoff); then Add by address, a text link that opens a field for a PC's https address. `status`: the connect
 * screen's open, at the panel's end.
 */
function SshPanel({ status }: { readonly status: ReactNode }) {
  const t = useT();
  const open = useAddressOpen("add");
  const ssh = sshHandoff();
  const [byAddress, setByAddress] = useState(false);
  return (
    <div className="connect-start-panel" data-tab-panel="ssh">
      {ssh && <AddressForm open={open} labelShown ssh label="SSH" placeholder="user@host" submit={t("Connect")} />}
      <button type="button" className="connect-address-link" aria-expanded={byAddress} onClick={() => { open.setError(null); setByAddress((shown) => !shown); }}>{t("Add by address")}</button>
      {byAddress && <AddressForm open={open} labelShown label={t("PC address")} placeholder="https://my-pc.example.com" submit={t("Connect")} autoFocus />}
      {status}
      <OpenError open={open} />
    </div>
  );
}

/**
 * Add a PC: the desktop's Add a connection tabs in its order, the Ovis relay chosen, holding only the ways to add or
 * open a PC, no list; on a wide screen always open beside My PCs. `relay`: that tab's way in (signed out its sign-in, signed in what to do on the PC); `title`:
 * Connect a PC where this is the front page, Add PC behind My PCs (`onBack`). A browser cannot see the tailnet or reach
 * SSH, so Tailscale and SSH each take a PC's address (RelayAddPc's AddressForm, which opens that PC's own Ovis); the
 * phone app adds what it knows.
 */
export function AddPcTabs({ title, relay, way, onWay, away, onBack, layout = "page", focus = 0, hidden = false }: {
  readonly title: string; readonly relay: ReactNode; readonly onBack?: (() => void) | undefined;
  /** the chosen tab, which the connect screen keeps (leaving the relay tab ends a code it looks up) */
  readonly way: ConnectWay; readonly onWay: (way: ConnectWay) => void;
  /** what the relay tab says that stays in view on the other tabs: a sign-in that ended */
  readonly away?: ReactNode;
  /** `front`: the front page itself (a centred card on a wide screen); `side`: the panel beside My PCs on a wide screen */
  readonly layout?: "page" | "front" | "side";
  /** counts the times My PCs' Add PC opened this: each moves the focus to its title (ConnectHead) */
  readonly focus?: number;
  /** kept mounted but not shown (My PCs stands in its place on a phone): its tab and what is typed survive the switch */
  readonly hidden?: boolean;
}) {
  const t = useT();
  const label: Record<ConnectWay, string> = { relay: t("Ovis relay"), tailscale: "Tailscale", ssh: "SSH" };
  // in the pane on screen only; beside My PCs, why an open started there did not go is said there, on its own here
  const status = hidden ? null : <OpenStatus view="add" anyView={layout !== "side"} tailscaleOff={<TailscaleOff />} />;
  return (
    <div className={layout === "page" ? "connect-add" : `connect-add connect-add-${layout}`} data-view="add-pc" hidden={hidden || undefined}>
      <ConnectHead title={title} onBack={onBack} side={layout === "side"} focus={focus} />
      <div className="segmented connect-start-tabs" role="group" aria-label={t("How to connect")}>
        {CONNECT_WAYS.map((each) => <button key={each} type="button" aria-pressed={way === each} data-tab={each} onClick={() => onWay(each)}>{label[each]}</button>)}
      </div>
      {way !== "relay" && away}
      {way === "relay" && <div className="connect-start-panel" data-tab-panel="relay">{relay}{status}</div>}
      {way === "tailscale" && <TailscalePanel shown={!hidden} status={status} />}
      {way === "ssh" && <SshPanel status={status} />}
    </div>
  );
}
