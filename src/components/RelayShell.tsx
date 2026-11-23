import "./RelayShell.css";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ACCOUNT_PCS_CHANGED_EVENT, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { hasNativePlugin } from "../lib/nativeApp.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { AccountView, RelayShellState } from "../lib/relay/shellState.ts";
import { usePhoneSheetBack, useSheetHistory } from "../lib/sheetHistory.ts";
import { observedVersionOf } from "../lib/relay/device.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { StartScreenAccountMenu } from "./AccountHead.tsx";
import { AccountJoinRequests } from "./AccountJoinRequests.tsx";
import { AccountSignIn } from "./AccountPcs.tsx";
import { AddPcSheet } from "./AddPcSheet.tsx";
import { AccountlessRelayPanel, AccountRelayPanel, AddPcTabs, type CheckedPc, MyPcs, SHELL, SignedOutRelayPanel, usePhoneSaved } from "./ConnectStart.tsx";
import { codeFailureText, type TypedCodeFailure } from "./codeFailureText.ts";
import { KeyId } from "./KeyId.tsx";
import { NoPcOnline } from "./NoPcOnline.tsx";
import { EnrollmentStatus } from "./EnrollmentStatus.tsx";
import { ADD_PC_FROM_KEY } from "./MachineSidebar.tsx";
import { NewPcNotices } from "./NewPcNotices.tsx";
import { canScanQr, scanQr, useAddressOpen } from "./RelayAddPc.tsx";
import { INSTALLER_COMMAND, PcApprovalWait, type PlainReason, PLUGIN_COMMANDS, RelayShellCardContent, TypedDigits } from "./RelayShellScreens.tsx";
import { RelayStepFrame, type RelayStepBack } from "./RelayStepFrame.tsx";
import { SheepMascot } from "./SheepMascot.tsx";
import { UnconfirmedPcNotices } from "./UnconfirmedPcNotices.tsx";

export { INSTALLER_COMMAND, PLUGIN_COMMANDS, TypedDigits };

export interface RelayShellProps {
  state: RelayShellState;
  pcStatus?: ReadonlyMap<string, PcStatus>;
  onCheckPcs?: () => void;
  /** the front page's Check again when no PC answered a launch (`noneOnline`): opens the first saved PC that answers */
  onFindPc?: () => void;
  onRefreshAccount?: () => void | Promise<void>;
  /** Admission succeeded; only this action hands the scoped page to the PC app. */
  onOpenPc?: () => void;
  /** forgets one of this phone's pairings from My PCs (ConnectStart MyPcs) */
  onForgetSaved?: (serverId: string) => void;
  scoped: boolean; iosTab: boolean;
  onPair: () => void; onRetry: () => void; onCancel: () => void; onBack: () => void; onForget: () => void;
  onUpdate: () => void;
  /** pairing without a code: the digits on this screen are the ones the PC shows (`typed`: typed from the PC's screen) */
  onMatch: (typed?: string) => void;
  onSignIn?: (provider: AccountProvider) => void;
  sheetJoin?: { mode: "new" | "join"; server_id: string } | null;
  /** that sheet's typed comparison, for a PC that shows no number: the same request goes on as a join, with this device's digits */
  onJoinInstead?: () => void;
  /** that join is the one a sign-in's launch asked by itself (#16): it waits on one plain screen, not the sheet */
  launchJoin?: boolean;
  /** Check again over My PCs when none of the account's PCs is on (`waitPc`): the sign-in's launch once more */
  onWaitAgain?: () => void;
  signedIn?: boolean;
  /** Ask again after this device was removed from its PC: the front page's launch asks the account's PCs again */
  onAskAgain?: () => void;
  accountProviders?: readonly AccountProvider[];
  onCodeStart: () => void; onCodeSubmit: (code: string) => void; onCodeMatch: () => void;
  /** the front page was opened on My PCs (`/#add`: a PC page's More → Connect a PC), whatever the account's state */
  addEntry?: boolean;
}

/** The field a code is typed in, kept in the input itself (src/AGENTS.md: secret input stays in the DOM). */
export function CodeEntry({ failure, looking = false, onSubmit, back, titleTag: Title = "h1", titleId, formId, omitHeading = false }: { readonly failure: TypedCodeFailure | null; readonly looking?: boolean | undefined; readonly onSubmit: (code: string) => void; readonly back?: ReactNode; readonly titleTag?: "h1" | "h2" | undefined; readonly titleId?: string | undefined; readonly formId?: string | undefined; readonly omitHeading?: boolean | undefined }) {
  const t = useT(), id = useId(), label = t("Code from the PC");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!looking) onSubmit((event.currentTarget.elements.namedItem("code") as HTMLInputElement).value);
  };
  return (
    <>
      {!omitHeading && <Title className="relay-shell-title" id={titleId}>{t("Pair with a code")}</Title>}
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay and type the code it shows.")}</p>
      <form id={formId} className="relay-shell-code-form" onSubmit={submit}>
        <label className="relay-shell-field-label" htmlFor={`${id}-code`}>{label}</label>
        <input id={`${id}-code`} name="code" className="input relay-shell-code-input" aria-label={label} placeholder="XXXXX-XXXXX" disabled={looking} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus />
        {failure !== null && <p className="account-error" role="alert">{codeFailureText(t, failure)}</p>}
        {back !== undefined && <div className="relay-shell-actions"><button type="submit" className="btn btn-primary" aria-busy={looking ? "true" : undefined} disabled={looking}>{looking ? t("Looking for the PC…") : t("Pair")}</button>{back}</div>}
      </form>
    </>
  );
}

function PairQrDialog({ state, onCodeStart, onCodeSubmit, onCodeMatch, onCancel, onClose }: {
  readonly state: RelayShellState; readonly onCodeStart: () => void; readonly onCodeSubmit: (code: string) => void;
  readonly onCodeMatch: () => void; readonly onCancel: () => void; readonly onClose: () => void;
}) {
  const t = useT(), titleId = useId(), codeFormId = `${titleId}-code-form`, surface = useFocusTrap<HTMLDivElement>(true), phone = useMediaQuery(SHEET_QUERY);
  const inCode = state.kind === "code-entry" || state.kind === "code-looking" || state.kind === "code-compare", looking = state.kind === "code-looking";
  const close = (): void => { if (inCode) onCancel(); onClose(); };
  const latestClose = useRef(close);
  latestClose.current = close;
  useSheetSwipe(surface, close);
  usePhoneSheetBack(() => { latestClose.current(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation(); event.preventDefault(); latestClose.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const pc = state.kind === "code-compare" ? (state.offer.name ?? t("this PC")) : t("this PC");
  const mode = state.kind === "code-entry" || state.kind === "code-looking" ? "code" : state.kind === "code-compare" ? "compare" : "qr";
  const title = mode === "code" ? t("Pair with a code") : mode === "compare" ? t("Does {name}'s screen show this ID?", { name: pc }) : t("Scan the QR code on your PC");
  const secondary = mode === "qr" ? <button key="back" type="button" className="btn" onClick={close}>{t("Back")}</button> : <button key="cancel" type="button" className="btn" onClick={close}>{t("Cancel")}</button>;
  const primary = mode === "code"
    ? <button key="pair" type="submit" form={codeFormId} className="btn btn-primary" data-sheet-primary aria-busy={looking ? "true" : undefined} disabled={looking}>{looking ? t("Looking for the PC…") : t("Pair")}</button>
    : mode === "compare"
      ? <button key="match" type="button" className="btn btn-primary" data-sheet-primary onClick={onCodeMatch}>{t("It matches")}</button>
      : <button key="code" type="button" className="btn btn-primary" data-sheet-primary onClick={onCodeStart}>{t("Pair with a code")}</button>;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={surface} className="modal add-pc-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-pair-dialog={mode}>
        <header className="modal-header add-pc-head"><h2 className="modal-title" id={titleId}>{title}</h2></header>
        <div className="modal-body add-pc-body">
          {mode === "code" ? (
            <CodeEntry omitHeading formId={codeFormId} failure={state.kind === "code-entry" ? state.failure : null} looking={looking} onSubmit={onCodeSubmit} />
          ) : mode === "compare" && state.kind === "code-compare" ? (
            <>
              <p className="relay-shell-copy">{t("The PC shows its ID at the top of Settings → Devices and PCs. Pair only if every group matches.")}</p>
              <p className="relay-shell-code-id"><KeyId id={state.offer.server_id} label={t("ID of the PC this code found")} /></p>
            </>
          ) : (
            <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay and scan the QR code.")}</p>
          )}
        </div>
        <footer className="modal-footer add-pc-footer">{phone ? <>{primary}{secondary}</> : <>{secondary}{primary}</>}</footer>
      </div>
    </div>,
    document.body,
  );
}

/** A completed pairing owns its transport until Open PC or Cancel, including in continued scope. */
export function ReadyCheckpoint({ open, cancel, state, retry }: { readonly open: () => void; readonly cancel: () => void; readonly state?: Extract<RelayShellState, { kind: "ready" }>; readonly retry?: () => void }) {
  const t = useT(), title = useId(), surface = useFocusTrap<HTMLDivElement>(true);
  const latestCancel = useRef(cancel); latestCancel.current = cancel;
  usePhoneSheetBack(() => { latestCancel.current(); });
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancel]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div ref={surface} className="modal add-pc-sheet" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1} data-add-pc-phase="ready">
        <header className="modal-header"><h2 id={title} className="modal-title" role="status">{t("Ready")}</h2></header>
        {state && <div className="modal-body"><p className="relay-shell-copy">{t("{name} is ready to open on this device.", { name: state.name ?? t("this PC") })}</p><EnrollmentStatus state={state.enrollment} {...(retry ? { retry } : {})} /></div>}
        <footer className="modal-footer"><button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button><button type="button" className="btn btn-primary" onClick={open}>{t("Open PC")}</button></footer>
      </div>
    </div>
  );
}

export function RelayShell(props: RelayShellProps) {
  const { state, pcStatus, onRefreshAccount, scoped, onPair, onRetry, onCancel, onBack, onMatch, onCodeStart, onCodeSubmit, onCodeMatch, onOpenPc, onSignIn, sheetJoin = null, onJoinInstead, accountProviders } = props;
  const t = useT();
  const [cachedAccount, setCachedAccount] = useState<AccountView | null>(null);
  // a notice on this page confirmed or removed one of the account's PCs: My PCs reads them again at once
  const latestRefresh = useRef(onRefreshAccount);
  latestRefresh.current = onRefreshAccount;
  useEffect(() => {
    const changed = (): void => { void latestRefresh.current?.(); };
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, changed);
  }, []);
  const rawAccount: AccountView | null = (state.kind === "list" || state.kind === "empty") && onSignIn ? state.account ?? null : null;
  if (rawAccount !== null && rawAccount !== cachedAccount) setCachedAccount(rawAccount);
  const account: AccountView | null = rawAccount ?? (addingPcOpen(state) && onSignIn ? cachedAccount : null);
  const front = state.kind === "list" || state.kind === "empty";
  const signedOut = account?.kind === "signed-out" || account?.kind === "signing-in";
  const [addingPc, setAddingPc] = useState(false);
  const [addOpen, setAddOpen] = useState(props.addEntry === true);
  // the PC page whose More opened My PCs, read once as it opens: a mark left by an earlier one never sends Back elsewhere
  const [addFrom] = useState(() => props.addEntry === true ? takeAddFrom() : null);
  // Add PC opened over My PCs (its Add PC, or the plain screen's Other ways to connect): its Back comes back to the list
  const [addView, setAddView] = useState(false);
  // a sign-out found while the pairing dialog is open closes it: a later sign-in opens no stale dialog
  if (addingPc && signedOut && front) setAddingPc(false);
  // a sign-in made on Add PC lands on My PCs, where the account's PCs now are
  const [accountKind, setAccountKind] = useState(account?.kind);
  if (account?.kind !== accountKind) {
    setAccountKind(account?.kind);
    if (account?.kind === "signed-in" && (accountKind === "signed-out" || accountKind === "signing-in")) setAddView(false);
  }
  // My PCs opened by a PC's More (`/#add`) gives way to a screen of its own (a pairing, a failure); a code typed from its
  // Add PC comes back to it
  if (addOpen && !front && !addingPcOpen(state)) setAddOpen(false);
  const name = state.kind === "confirm" || state.kind === "code-compare" ? state.offer.name ?? null
    : state.kind === "list" || state.kind === "empty" || state.kind === "code-entry" || state.kind === "code-looking" ? null : state.name;
  const pc = name ?? t("this PC");
  const stateName = state.kind === "failed" ? state.failure : state.kind === "outdated" ? "pc-outdated" : state.kind === "forged" ? "identity-changed" : state.kind;
  const devices = state.kind === "list" ? state.devices : [];
  const scan = useAddressOpen();
  const phone = usePhoneSaved(hasNativePlugin(SHELL));
  // the plain wait's QR way in: the phone app's scanner, else a code typed in (#16)
  const qrOrCode = (code: () => void) => (): void => { if (canScanQr()) { scan.setError(null); scanQr(t, scan.take, code); } else code(); };
  // no PC on (#16): a launch that asked every saved PC heard none (Check again asks them again), or, signed in with
  // nothing saved here, none of the account's PCs is on (Check again is the sign-in's launch once more); the rows say Off
  const checkAgain = !front ? undefined : state.noneOnline === true ? props.onFindPc : state.kind === "empty" && state.waitPc === true ? props.onWaitAgain : undefined;
  const noneOnline = checkAgain ? <NoPcOnline onCheck={checkAgain} /> : null;
  // a pairing's sign-in reads on the plain page, with nothing around it; its other steps are on the step frame
  const plain = state.kind === "failed" && state.failure === "sign-in-first" && onSignIn !== undefined;

  // this phone's pairings as their last check found them (MyPcs adds the account's)
  const offOf = (serverId: string): boolean => { const now = pcStatus?.get(serverId); const shown = now?.kind === "checking" ? now.previous : now; return shown?.kind === "offline" && shown.reason === "pc"; };
  const answered = (serverId: string): boolean => { const now = pcStatus?.get(serverId); return (now?.kind === "checking" ? now.previous : now)?.kind === "answered"; };
  // what this device knows itself comes first: a pairing's saved Ovis too old, then what a check settled, for its own
  // pairings and the account's PCs alike (a check the relay turned away settles nothing)
  const checkedOf = (serverId: string): CheckedPc | undefined => offOf(serverId) ? "off" : answered(serverId) ? "online" : undefined;
  const savedPcs = devices.map((device) => ({ server_id: device.server_id, name: device.name, status: observedVersionOf(device)?.outdated === true ? "update" as const : checkedOf(device.server_id) }));
  const checked = new Map([...(pcStatus?.keys() ?? [])].flatMap((serverId) => { const found = checkedOf(serverId); return found === undefined ? [] : [[serverId, found] as const]; }));

  // the front page: My PCs once anything opens here (signed in, a PC saved on this phone, or asked for by a PC's More),
  // otherwise Add a PC itself, as Connect a PC. What is saved decides only the app's own front page: a PC's page (scoped)
  // keeps that PC's sign-in, and its Back. Until the phone app says what it saved, a front page that waits on that draws
  // neither, so it does not flash the other (usePhoneSaved waits only so long)
  const inventory = !scoped && (devices.length > 0 || phone.pcs.length > 0);
  const listed = addOpen || account?.kind === "signed-in" || inventory;
  const undecided = !listed && !scoped && !phone.read;
  const myPcsShown = listed && !addView;
  // Add a PC over My PCs has an entry of its own in the history: Back (the phone's, the browser's or its own) comes back to
  // the list, and the focus goes back to Add PC
  const [cameBack, setCameBack] = useState(false);
  const closeAdd = (): void => { setAddView(false); setCameBack(true); };
  useSheetHistory(addView && listed, closeAdd);
  const signIn = signedOut && onSignIn ? (
    <AccountSignIn onSignIn={onSignIn} error={account.kind === "signed-out" ? account.error : null} notice={account.kind === "signed-out" ? (account.notice ?? null) : null}
      busy={account.kind === "signing-in"} busyProvider={account.kind === "signing-in" ? (account.provider ?? null) : null} failedProvider={account.kind === "signed-out" ? (account.provider ?? null) : null}
      {...(accountProviders ? { providers: accountProviders } : {})} />
  ) : null;
  // signed in, a code is typed in the pairing dialog over the page; otherwise on a screen of its own, whose Cancel comes back
  const relayPanel = account?.kind === "signed-in" ? <AccountRelayPanel onCodeStart={() => { setAddingPc(true); onCodeStart(); }} />
    : account !== null ? <SignedOutRelayPanel signIn={signIn} signingIn={account.kind === "signing-in"} onCodeStart={onCodeStart} />
    : <AccountlessRelayPanel onCodeStart={onCodeStart} />;
  const frontView = (top: ReactNode, menu?: ReactNode): ReactNode => myPcsShown
    ? <MyPcs devices={savedPcs} accountPcs={account?.kind === "signed-in" ? account.pcs : null} checked={checked} phone={phone} onForget={props.onForgetSaved} addFocused={cameBack}
      inUse={addOpen && addFrom !== null ? serverIdOfPath(addFrom) : null} onBack={addOpen ? () => { setAddOpen(false); leaveAddEntry(addFrom); } : undefined}
      onAdd={() => { setCameBack(false); setAddView(true); }} menu={menu} top={top}
      empty={account?.kind === "signed-in" && account.pcs !== null ? <p className="relay-shell-copy">{t("Sign in with the same account on the PC where Ovis runs")}</p> : undefined} />
    : <AddPcTabs title={listed ? t("Add PC") : t("Connect a PC")} relay={relayPanel} focused={listed} onBack={listed ? closeAdd : account === null && scoped ? onBack : undefined} />;
  // the sign-in's progress, told to a screen reader as the page that holds it changes
  const announcedSignIn = useAnnouncedText(front && account?.kind === "signing-in" ? t("Signing in…") : null);
  const frontClass = (shownList: boolean): string => shownList ? "relay-shell-screen relay-add-screen my-pcs-screen" : "relay-shell-screen relay-add-screen";

  // signed in, the front page is My PCs, the account's notices and menu on it (#16: with no PC on, or none in the account
  // yet, the same page, the rows saying Off or the list saying to sign in on a PC); a code typed from Add PC's relay tab
  // goes on in the pairing dialog over it
  if (account?.kind === "signed-in") {
    const directoryError = account.error !== null && (
      <p className="account-error relay-add-directory-error" role="alert">{account.error}{onRefreshAccount && <> <button type="button" className="account-link" onClick={() => { void onRefreshAccount(); }}>{t("Try again")}</button></>}</p>
    );
    return (
      <main className={frontClass(myPcsShown)} data-relay-state={stateName} data-account-state={account.kind}>
        {/* one wrapper whether the dialog is open or not: swapping it in would remount the page, losing the control that opened it before its focus trap records it */}
        <div className="relay-shell account-centered relay-shell-signin" inert={addingPc || undefined}>
          {frontView(<>{noneOnline}<NewPcNotices /><AccountJoinRequests /><UnconfirmedPcNotices tellConfirmed={false} onSignInAgain={onSignIn} />{directoryError}</>, <StartScreenAccountMenu />)}
          {!myPcsShown && directoryError}
        </div>
        {addingPc && (
          <PairQrDialog state={state} onCodeStart={onCodeStart} onCodeSubmit={onCodeSubmit} onCodeMatch={onCodeMatch} onCancel={onCancel} onClose={() => {
            setAddingPc(false);
            queueMicrotask(() => { if (document.activeElement === null || document.activeElement === document.body) [...document.querySelectorAll<HTMLElement>('[data-action="add-pc"], [data-action="add-code"], [data-action="scan-qr"]')].find((el) => el.getClientRects().length > 0)?.focus({ preventScroll: true }); });
          }} />
        )}
      </main>
    );
  }

  // signed out, or a relay with no accounts: My PCs or Add a PC the same way, the sign-in on Add PC's relay tab (the old
  // list of this device's pairings stays the front page of a relay with no accounts, unless a PC's More asked for My PCs)
  if (front && (signedOut || state.kind === "empty" || addOpen)) {
    const ended = account?.kind === "signed-out" && myPcsShown ? account.error ?? account.notice ?? null : null;
    return (
      <main className={frontClass(!undecided && myPcsShown)} data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
        <div className="visually-hidden" role="status">{announcedSignIn}</div>
        <div className="relay-shell account-centered relay-shell-signin">
          {!undecided && frontView(<>{noneOnline}{ended !== null && account?.kind === "signed-out" && <p className={account.error !== null ? "account-error" : "account-fineprint account-notice"} role={account.error !== null ? "alert" : "status"}>{ended}</p>}</>)}
        </div>
      </main>
    );
  }

  const continued = scoped && sheetJoin !== null && (state.kind === "confirm" ? state.offer.server_id === sheetJoin.server_id
    : state.kind === "failed" ? state.server_id === sheetJoin.server_id && state.failure !== "identity-changed"
    : state.kind === "connecting" || state.kind === "compare" || state.kind === "ready");
  if (continued) {
    // #16: the join a sign-in's launch asked by itself waits on one plain screen, and ends on one too (declined, removed,
    // the PC off: Ask again or Check again asks once more); any other failure, or a number to type here, keeps the sheet
    const launched: { readonly reason: PlainReason; readonly digits?: string; readonly ask?: () => void; readonly check?: () => void } | null = props.launchJoin !== true ? null
      : state.kind === "confirm" || state.kind === "connecting" ? { reason: "allow" }
      : state.kind === "compare" && state.typed !== true ? { reason: state.approveOn === undefined ? "type" : "allow", digits: state.digits }
      : state.kind === "failed" && (state.failure === "pair-declined" || state.failure === "pair-unavailable") ? { reason: "declined", ask: onRetry }
      : state.kind === "failed" && state.failure === "pair-unanswered" ? { reason: "unanswered", ask: onRetry }
      : state.kind === "failed" && state.failure === "revoked" ? { reason: "removed", ask: onRetry }
      : state.kind === "failed" && state.failure === "pc-offline" ? { reason: "off", check: onRetry }
      : null;
    if (launched !== null) {
      return (
        <main className="relay-shell-screen" data-relay-state={stateName}>
          <PcApprovalWait reason={launched.reason} name={pc} digits={launched.digits ?? null} onQr={qrOrCode(onCodeStart)} onAskAgain={launched.ask} onCheck={launched.check} />
          {scan.error !== null && <p className="account-error" role="alert">{scan.error}</p>}
        </main>
      );
    }
    const joining: MyPc = { server_id: sheetJoin.server_id, name: pc, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false };
    return (
      <main className="relay-shell-screen relay-add-screen" data-relay-state={stateName}>
        <AddPcSheet mode={sheetJoin.mode} pc={joining} state={state} onJoin={() => {}} onPair={onPair} onMatch={onMatch} onRetry={onRetry} {...(onOpenPc ? { onOpenPc } : {})} onCancel={onCancel} onClose={onBack} {...(sheetJoin.mode === "new" && onJoinInstead ? { onAskToJoin: onJoinInstead } : {})} />
      </main>
    );
  }

  // #16: a signed-in device removed from a PC it had opened says so in one line, with Ask again
  if (scoped && state.kind === "failed" && state.failure === "revoked" && props.signedIn === true && props.onAskAgain) {
    return (
      <main className="relay-shell-screen" data-relay-state={stateName}>
        <PcApprovalWait reason="removed" name={pc} onQr={qrOrCode(onCodeStart)} onAskAgain={props.onAskAgain} />
        {scan.error !== null && <p className="account-error" role="alert">{scan.error}</p>}
      </main>
    );
  }
  const content = <RelayShellCardContent props={props} />;
  const step = plain ? undefined : pairingStep(state);
  if (step !== undefined) {
    // before this phone's press the comparison can still go back; after it, the pairing waits on the PC and only its own small Cancel ends it
    const back: RelayStepBack | null = state.kind === "confirm" || (state.kind === "compare" && !state.confirmed) ? { label: t("Back"), onClick: onCancel }
      : state.kind === "connecting" ? { label: t("Cancel"), onClick: onCancel } : null;
    const note = state.kind === "connecting" ? t("Connecting…") : state.kind === "compare" && state.confirmed ? t("Waiting for approval…") : null;
    return (
      <main className="relay-step-screen" data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
        <RelayStepFrame step={step} back={back} note={note}>{content}</RelayStepFrame>
      </main>
    );
  }

  return (
    <main className={plain ? "relay-shell-screen relay-shell-plain" : "relay-shell-screen"} data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
      <div className={plain ? "relay-shell relay-shell-signin" : "relay-shell"}>
        {plain ? <SheepMascot screen="header" size={80} /> : <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="relay-shell-mark" />}
        {noneOnline}
        {content}
      </div>
    </main>
  );
}

/**
 * A pairing's steps, drawn on the step frame: the confirm (1), the comparison and the connection before
 * the PC's approval (2), the connection after it (3), and a pairing that failed (no step). `undefined`:
 * the screen is not a pairing step (the ready checkpoint too: a saved PC's enrollment retry reaches it).
 */
function pairingStep(state: RelayShellState): 1 | 2 | 3 | null | undefined {
  switch (state.kind) {
    case "confirm": return 1;
    case "compare": return 2;
    // a saved PC opening again connects, and fails, on the card: only a new pairing has steps
    case "connecting": return state.pairing ? (state.approved ? 3 : 2) : undefined;
    case "failed": return state.pairing ? null : undefined;
    default: return undefined;
  }
}

/** The PC page that opened My PCs by its address (MachineSidebar.openAddPc), taken off so it serves that one opening alone. */
function takeAddFrom(): string | null {
  try {
    const from = sessionStorage.getItem(ADD_PC_FROM_KEY);
    sessionStorage.removeItem(ADD_PC_FROM_KEY);
    return from !== null && serverIdOfPath(from) !== null ? from : null;
  } catch { return null; }
}

/**
 * Back from My PCs opened by its address (`/#add`): to the PC page whose More opened it (`from`), or, for a link or a
 * bookmark from elsewhere, the front page itself, the `#add` dropped so a reload does not open it again.
 */
export function leaveAddEntry(from: string | null, history: Pick<History, "back" | "replaceState"> = window.history): void {
  if (from !== null) history.back();
  else history.replaceState(null, "", "/");
}

function addingPcOpen(state: RelayShellState): boolean {
  return state.kind === "code-entry" || state.kind === "code-looking" || state.kind === "code-compare";
}
