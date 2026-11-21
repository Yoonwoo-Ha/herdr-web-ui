/**
 * The desktop app signs in through the system browser (lib/account/desktop.ts), and the PC's own window in a
 * browser on the PC through the loopback redirect (lib/account/ownWindow.ts); any other browser on the PC's
 * address, which no sign-in can be sent back to, signs in with a code (lib/account/deviceSignIn.ts): one button
 * and the Ovis link page where the service has it, else the provider's device flow.
 */
import { useCallback, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, X } from "lucide-react";

import type { AccountLimits } from "../../shared/protocol.ts";
import { AddPcWaitOver, addInOnePress, closeAddWindow, keepAddPcWaiting, listThisPc, onAddPcWaiting, pagePc, pcAnswers, readAddPcWaiting, reopenAddWindow, thisPcInNoAccount, thisPcMembership, type AddPcWaiting, type ListedPc } from "../lib/account/addThisPc.ts";
import { deleteAccount, holdingSessionStore, installSignInAgain } from "../lib/account/deleteAccount.ts";
import { desktopAccount, desktopProviders, desktopSignIn } from "../lib/account/desktop.ts";
import { ApiError, fetchBridgeHealth, fetchRelay, requestRelay } from "../lib/api.ts";
import { startDeviceSignIn, startLinkPageSignIn, type DeviceSignInProvider } from "../lib/account/deviceSignIn.ts";
import { AccountPcError, within } from "../lib/account/join.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import { ownWindowSignIn, useOwnWindowRedirect } from "../lib/account/ownWindow.ts";
import { AccountServiceError, DEVICE_PROVIDERS, indexedAccountService, offeredProviders, pcAccountServiceOf, sameSignIn, SignedOutError, type AccountIdentity, type AccountService, type DeviceProvider, type OfferedProviders } from "../lib/account/service.ts";
import { SignInError } from "../lib/account/signin.ts";
import { indexedAccountStore, type AccountProvider, type AccountSession, type AccountStore } from "../lib/account/store.ts";
import { currentLocale, useT, type Translate } from "../lib/i18n.ts";
import { inMacApp, inNativeApp } from "../lib/nativeApp.ts";
import { pairThisBrowser, UnconfirmedPairing } from "../lib/pairing.ts";
import { deviceLabel, deviceOs } from "../lib/phone.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { AccountPcList, AccountSignIn, HOSTED_APP_URL, PROVIDER_NAMES, ProviderMark, providerChoice } from "./AccountPcs.tsx";
import { QrCode } from "./QrCode.tsx";
import { statusText } from "./RelayPanel.tsx";
import { SettingsGroup, SettingsQuery, SettingsRow } from "./SettingsControls.tsx";

/** A delete confirmed in this section, for the sign-in it was asked for (AccountSection's `deletion`). */
interface Deletion { readonly session: AccountSession }

type View =
  | { kind: "loading" }
  | { kind: "signed-out"; error: string | null; notice?: string }
  /** `link`: the sign-in page the browser would not open in a tab of its own, offered to open by hand */
  | { kind: "signing-in"; link?: string }
  | { kind: "device-code"; provider: DeviceSignInProvider; userCode: string | null; verificationUri: string; verificationUriComplete: string | null }
  | { kind: "signed-in"; provider: AccountProvider; account: string; pcs: MyPc[] | null; methods: AccountIdentity[] | null; limits: AccountLimits | null; error: string | null };

export function formatRelayBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return `${Math.round(safe)} B`;
  if (safe < 1024 * 1024) return `${Math.max(1, Math.round(safe / 1024))} KB`;
  if (safe < 1024 * 1024 * 1024) {
    const mb = safe / (1024 * 1024);
    return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
  }
  const gb = safe / (1024 * 1024 * 1024);
  const rounded = gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb);
  return `${rounded} GB`;
}

/** The plan and its use on one line: "Free · 2/20 PCs", with the relay data when the plan caps it. */
export function formatAccountLimits(t: Translate, limits: AccountLimits, listedPcs: number): string {
  const plan = limits.plan.length > 0 ? limits.plan[0]!.toUpperCase() + limits.plan.slice(1) : limits.plan;
  const usedPcs = limits.pcs_used ?? listedPcs;
  const pcsPart = t("{used}/{max} PCs", { used: usedPcs, max: limits.pcs_max });
  const dataPart = typeof limits.data_cap_bytes === "number" && limits.data_cap_bytes > 0 && typeof limits.data_used_bytes === "number"
    ? t("{used} / {cap} relay data", { used: formatRelayBytes(limits.data_used_bytes), cap: formatRelayBytes(limits.data_cap_bytes) })
    : null;
  return [plan, pcsPart, ...(dataPart !== null ? [dataPart] : [])].join(" · ");
}

/** The account's limits as `session` reads them; null when the service reports none, or once another sign-in (or none) is stored. */
export async function accountLimitsOf(service: AccountService, session: AccountSession): Promise<AccountLimits | null> {
  const limits = await service.forSignIn(session).limits().catch(() => null);
  // another tab may have signed out or in while the answer was on its way: then it is no longer this section's to show
  const current = await service.session();
  return current !== undefined && sameSignIn(current, session) ? limits : null;
}

/**
 * The account's PCs and sign-in methods as `session` reads them; null once another sign-in (or none) is stored,
 * before the reads or while their answers were on the way: those are not this section's to show under its heading.
 */
export async function accountListsOf(service: AccountService, session: AccountSession): Promise<{ pcs: Awaited<ReturnType<AccountService["listPcs"]>>; methods: Awaited<ReturnType<AccountService["identities"]>> | null } | null> {
  const shown = service.forSignIn(session);
  const replaced = async (): Promise<boolean> => {
    const current = await service.session();
    return current === undefined || !sameSignIn(current, session);
  };
  try {
    const [pcs, methods] = await Promise.all([
      shown.listPcs(),
      shown.identities().catch((error: unknown) => {
        if (error instanceof AccountServiceError) return null;
        throw error;
      }),
    ]);
    return await replaced() ? null : { pcs, methods };
  } catch (error) {
    if (error instanceof SignedOutError && await service.session().catch(() => undefined) !== undefined) return null;
    throw error;
  }
}

const isDeviceProvider = (provider: AccountProvider): provider is DeviceProvider => (DEVICE_PROVIDERS as readonly string[]).includes(provider);

export const linkAddress = (uri: string): string => { const url = new URL(uri); return url.host + url.pathname; };

/** The directory entry this screen keeps is listed anew a minute before the account's devices stop showing it. */
const RELIST_MS = 9 * 60_000;
/** The pairing window is opened again this often while the screen waits: a restart of Ovis closes it for no longer. */
export const REOPEN_MS = 30_000;
export const ADDED_POLL_MS = 3_000;
/** How long one press keeps this PC waiting: after it nothing is reopened until the person asks again. */
export const WAITING_MS = 30 * 60_000;
export const ANSWER_MS = 10_000;
/** How long a sign-in that just finished here is still listed by itself while this PC's account cannot be read. */
export const SIGNED_IN_RETRY_MS = 60_000;
export const ADDING_MS = 2 * REOPEN_MS;

type AddThisPcState =
  | { kind: "hidden" }
  | { kind: "offer" }
  | { kind: "adding" }
  /**
   * that listing found the relay off: one button turns it on and lists, under `account` (the sign-in that just
   * finished) and no other; `error`: why the last press did neither
   */
  | { kind: "relay-off"; account: string; error: string | null }
  /**
   * `mark`: the wait as its tab keeps it (null without a stored sign-in to bind it to: such a wait is not resumed);
   * `resumed`: taken up after a reload; `signedIn`: begun by a sign-in on this screen, not by a press
   */
  | { kind: "waiting"; name: string; until: number; mark: AddPcWaiting | null; resumed: boolean; signedIn?: boolean }
  | { kind: "expired" }
  /** `enrolling`: the device that added the PC has not let the account's other devices in yet */
  | { kind: "done"; account: string; enrolling: boolean }
  | { kind: "error"; message: string };

const pageHidden = (): boolean => typeof document !== "undefined" && document.hidden === true;

const offering = (state: AddThisPcState): boolean => state.kind === "offer" || state.kind === "expired" || state.kind === "error" || state.kind === "relay-off";

const IN_USE_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#a-sign-in-method-that-belongs-to-another-account";

const warned = (what: string) => (error: unknown): void => console.warn(what, error instanceof Error ? error.name : error);

/** Whether a kept wait is one this page may take up: within the thirty minutes of its press, and for the PC this page shows. */
function resumable(kept: AddPcWaiting, now: number): boolean {
  const pc = pagePc();
  return kept.until > now && kept.until <= now + WAITING_MS && (pc === null || pc === kept.serverId);
}

/**
 * Closes this PC's pairing window, so nothing more is taken through it; an older Ovis has no such route and lets it run out.
 * A wait begun right after asks for its window only once this close was answered (`closeAddWindow`).
 */
function closeWindow(): void {
  closeAddWindow().catch((error: unknown) => {
    if (!(error instanceof ApiError && error.status === 404)) console.warn("Ovis: this PC's pairing window was not closed", error instanceof Error ? error.name : error);
  });
}

/** Whether this tab keeps a wait that still runs: its window is then not closed under it. */
const waitKept = (): boolean => { const kept = readAddPcWaiting(); return kept !== null && resumable(kept, Date.now()); };

/**
 * A sign-in that just finished on the screen, as AccountSection hands it to Add this PC once. `adds`: the button
 * that began it said it adds this PC ("Sign in and add this PC"); only then is the PC listed without another press.
 */
export interface SignedInHere { readonly account: string; readonly adds: boolean }

let relistOnItsWay: { readonly until: number; readonly listed: Promise<ListedPc> } | null = null;

/**
 * This PC, signed in and in no account yet: listed in the account with one tap, then it waits for a
 * device already in the account to add it, which the owner approves here (docs/account.md, "Adding a PC").
 * While it waits it keeps its pairing window open, for thirty minutes a press, and says when a device added it.
 * A reloaded tab takes the wait up again only on the same PC under the same account: which PC answers is read
 * (`pcAnswers`) before a wait has a window opened or says the PC was added. A sign-in that just
 * finished on this screen through a button that said it adds this PC lists the PC and waits by itself
 * (`signedInHere`), under its own account alone, with a window only this PC approves, and gives the button back
 * when that gets no answer; a listing no press began is dropped when its screen goes, and the window it opened for
 * nobody is closed. A sign-in whose button said nothing of adding lists and opens nothing: it gets the offer.
 * The relay is never turned on without a press. Nothing else is listed or opened without one. A device that only
 * watches this PC can list nothing, and is shown nothing.
 */
export function AddThisPc({ relayAbove = true, gateNote = true, relayOn, service, signedInHere, onListed, opensAll = () => false }: {
  relayAbove?: boolean;
  /**
   * The relay's state as a switch beside this one shows it (the relay tab): once it is on, an offer to turn it on and
   * add the PC becomes the plain offer. Only that idle offer changes; an add or a wait under way goes on as it is.
   */
  relayOn?: boolean;
  /** false where the relay's own switch beside it already says that turning it on closes the device gate (the relay tab) */
  gateNote?: boolean;
  /** this PC lists account-opens-all/1 now (its step-2 switch is on): only then is a one press tried */
  opensAll?: () => boolean;
  onListed?: () => void;
  service?: () => AccountService;
  /**
   * The sign-in that just finished on this screen, answered once (null after, and for a sign-in that was
   * already there): only that one adds the PC without another press, and only when its button said so.
   */
  signedInHere?: () => SignedInHere | null;
}) {
  const t = useT();
  const [state, setState] = useState<AddThisPcState>({ kind: "hidden" });
  const accountService = useCallback((): AccountService => service?.() ?? indexedAccountService, [service]);
  /** What the screen shows of a PC that has an account: "in your account" only when it is the one signed in to now, else nothing here is true of it. */
  const joinedAs = useCallback(async (account: string, enrolling: boolean): Promise<AddThisPcState> => {
    const session = await accountService().session();
    return session?.account === account ? { kind: "done", account, enrolling } : { kind: "hidden" };
  }, [accountService]);
  const afterSignIn = useEffectEvent((fresh: SignedInHere) => { if (fresh.adds) add(fresh.account); else offerAfterSignIn(fresh.account); });
  useEffect(() => {
    let live = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    let waited = false;
    const began = Date.now();
    /**
     * The sign-in that just finished here, taken once by this mount whatever comes of it, also when the PC's
     * account could not be read: a later mount of this screen is no sign-in that just finished.
     */
    let fresh: SignedInHere | null = null;
    let taken = false;
    const takeFresh = (): SignedInHere | null => {
      if (!taken) { taken = true; fresh = signedInHere?.() ?? null; }
      return fresh;
    };
    /** that sign-in while it still counts as one that just finished: a minute, also for a PC that answered only after it */
    const justSignedIn = (): SignedInHere | null => { const signedIn = takeFresh(); return Date.now() < began + SIGNED_IN_RETRY_MS ? signedIn : null; };
    const read = (): void => {
      again = null;
      within(ANSWER_MS, thisPcMembership()).then(async ({ account, enrolling }) => {
        if (!live) return;
        const signedIn = justSignedIn();
        const stored = readAddPcWaiting();
        const kept = stored !== null && resumable(stored, Date.now()) ? stored : null;
        if (kept === null) {
          keepAddPcWaiting(null);
          if (account !== null) return;
          // a device that only watches this PC lists nothing (the PC refuses it the window): no listing, and no button that could only fail
          const watching = await within(ANSWER_MS, fetchBridgeHealth()).then(({ auth }) => auth?.role === "watch", (error: unknown) => {
            warned("Ovis: what this browser may do on this PC could not be read")(error);
            return null;
          });
          if (!live || watching === true) return;
          // while that could not be read nothing is listed without a press: the button, which the PC answers for itself
          const adding = watching === null ? null : signedIn;
          if (adding === null && !waitKept()) { setState({ kind: "offer" }); return; }
          // the sign-in that just finished here adds the PC, when it is still the one stored: another, or none, starts from the offer
          const session = await accountService().session().catch(() => undefined);
          if (!live) return;
          const begun = readAddPcWaiting();
          if (begun !== null && resumable(begun, Date.now())) setState(session?.account === begun.account ? { kind: "waiting", name: begun.name, until: begun.until, mark: begun, resumed: false } : { kind: "offer" });
          else if (adding !== null && session?.account === adding.account) afterSignIn(adding);
          else setState({ kind: "offer" });
          return;
        }
        const session = await accountService().session().catch(() => undefined);
        if (!live) return;
        if (account !== null) {
          // a device added this PC while the tab that waited for it was reloading: said only under the sign-in that waited, still
          // stored, and only of the PC that waited (this address may answer for another PC of the account now)
          const added = kept.account === account && session?.account === account && await within(ANSWER_MS, pcAnswers(kept.serverId));
          if (!live) return;
          keepAddPcWaiting(null);
          if (added) setState({ kind: "done", account, enrolling });
          return;
        }
        const now = readAddPcWaiting();
        const running = now !== null && resumable(now, Date.now()) ? now : null;
        if (running === null) { setState({ kind: "offer" }); return; }
        // only the account the press was made under goes on waiting: another sign-in, or none, starts from the offer
        if (session === undefined || session.account !== running.account) {
          keepAddPcWaiting(null);
          if (signedIn !== null && session?.account === signedIn.account) afterSignIn(signedIn);
          else setState({ kind: "offer" });
          return;
        }
        // the screen was waiting when its tab reloaded: it goes on, within the thirty minutes of its press
        setState({ kind: "waiting", name: running.name, until: running.until, mark: running, resumed: true });
      }).catch((error: unknown) => {
        console.warn("Ovis: this PC's account could not be read", error instanceof Error ? error.name : error);
        if (!live) return;
        const signedIn = takeFresh();
        const stored = readAddPcWaiting();
        if (stored === null) {
          // the PC refused this browser its account (403: one in only through an open device gate, or a Portal visitor):
          // asking again gets the same answer, so it is not asked again
          if (error instanceof AccountPcError && error.status === 403) return;
          // a sign-in that just finished here is asked about too: closely for a minute, after which the PC is no longer
          // listed without a press, then now and then, so its button comes once the PC answers again
          if (signedIn !== null) again = setTimeout(read, Date.now() < began + SIGNED_IN_RETRY_MS ? ADDED_POLL_MS : REOPEN_MS);
          return;
        }
        if (resumable(stored, Date.now())) { waited = true; again = setTimeout(read, ADDED_POLL_MS); }
        else if (waited) { keepAddPcWaiting(null); setState({ kind: "expired" }); }
      });
    };
    read();
    return () => { live = false; if (again !== null) clearTimeout(again); };
  }, [accountService, signedInHere]);
  const pressed = useRef<number | null>(null);
  /** how many listings and relay starts this copy began: a window is closed late only while none began since */
  const starts = useRef(0);
  const stops = useRef(0);
  const idle = offering(state);
  useEffect(() => {
    if (!idle) return;
    let live = true;
    const off = onAddPcWaiting((kept) => {
      if (kept === null || kept.until === pressed.current || !resumable(kept, Date.now())) return;
      accountService().session().then((session) => {
        const now = readAddPcWaiting();
        // only under the sign-in the wait was begun in, and only while it is still the wait the tab keeps
        if (!live || session?.account !== kept.account || now === null || now.until !== kept.until) return;
        setState((current) => offering(current) ? { kind: "waiting", name: now.name, until: now.until, mark: now, resumed: false } : current);
      }, warned("Ovis: the account's sign-in could not be read"));
    });
    return () => { live = false; off(); };
  }, [idle, accountService]);
  const begun = state.kind === "waiting" ? state : null;
  const listed = useEffectEvent(() => onListed?.());
  useEffect(() => { if (begun !== null) listed(); }, [begun !== null]);
  useEffect(() => {
    if (begun === null) return;
    const until = begun.until;
    let live = true;
    let mark = begun.mark;
    const shared = mark !== null && readAddPcWaiting()?.until === until;
    /** Another copy of this screen ended this wait: nothing more is opened, listed or kept for it. */
    const withdrawn = (): boolean => shared && readAddPcWaiting()?.until !== until;
    const forget = (): void => { const now = readAddPcWaiting(); if (now === null || now.until === until) keepAddPcWaiting(null); };
    const left = (): void => {
      const now = readAddPcWaiting();
      setState(now !== null && now.until !== until && now.account === mark?.account && resumable(now, Date.now())
        ? { kind: "waiting", name: now.name, until: now.until, mark: now, resumed: false }
        : { kind: "offer" });
    };
    const stopped = (): void => { forget(); left(); };
    const stopsThen = stops.current;
    const startsThen = starts.current;
    /**
     * A reopen or a listing of this wait reached the PC after Stop waiting closed its window (here, or in another
     * copy), and opened it again for nobody: closed once more, unless the person began another wait meanwhile.
     */
    const closeLate = (): boolean => {
      if (!((stops.current !== stopsThen || withdrawn()) && starts.current === startsThen && !waitKept())) return false;
      closeWindow();
      return true;
    };
    const expired = (): boolean => {
      if (Date.now() < until) return false;
      forget();
      setState({ kind: "expired" });
      return true;
    };
    /** Whether the sign-in stored now is the one the press was made under: another tab may have signed out, or in as someone else. */
    const stillSignedIn = async (): Promise<boolean> => mark === null || (await accountService().session())?.account === mark.account;
    /** The PC has an account: the screen says so, or shows nothing when it is not the one signed in to. */
    const joined = async (account: string, enrolling: boolean): Promise<void> => {
      // believed only of the PC that waited: this address may answer for another PC now, one that has an account
      // already, and of that one the screen says nothing, as on a page that kept no wait
      const next: AddThisPcState = mark === null || await pcAnswers(mark.serverId) ? await joinedAs(account, enrolling) : { kind: "hidden" };
      if (!live) return;
      keepAddPcWaiting(null);
      setState(next);
    };
    let reopening = false;
    /** Opens the window again; never under a hidden page, past the thirty minutes of the press, or under another sign-in. */
    const reopen = (): void => {
      if (expired() || pageHidden() || reopening || withdrawn()) return;
      reopening = true;
      within(ANSWER_MS, (async (): Promise<void> => {
        if (!await stillSignedIn()) { if (live) stopped(); return; }
        if (!live || withdrawn()) return;
        // asked before the window, of a request that opens nothing: the address may answer for another PC than the
        // one that waited, and no window is opened on that one
        if (mark !== null && !await pcAnswers(mark.serverId)) { if (live) stopped(); return; }
        if (!live || withdrawn()) return;
        const pc = await reopenAddWindow();
        const closed = closeLate();
        // it changed PC between that question and the window: the wait is not this one's
        if (pc === null || mark === null || pc === mark.serverId) return;
        if (live) stopped();
        // and that request opened a window on the other PC, where no screen waits for anyone: closed again, unless
        // it was just now, or the person began another wait meanwhile (whose window a close would take)
        if (!closed && starts.current === startsThen && !waitKept()) closeWindow();
      })()).catch(warned("Ovis: this PC's pairing window was not reopened")).finally(() => { reopening = false; });
    };
    let asking = false;
    const ask = (): void => {
      if (pageHidden() || asking) return;
      asking = true;
      within(ANSWER_MS, (async (): Promise<void> => {
        const { account, enrolling } = await thisPcMembership();
        if (!live) return;
        if (account !== null) await joined(account, enrolling);
        else if (withdrawn()) left();
      })()).catch(warned("Ovis: this PC's account could not be read")).finally(() => { asking = false; });
    };
    let relisting: ReturnType<typeof setTimeout> | null = null;
    const due = (): number => Math.min(RELIST_MS, Math.max(0, (mark?.listedAt ?? Date.now()) + RELIST_MS - Date.now()));
    /**
     * Lists the PC anew when its entry is about to leave the account's devices (which also opens the window),
     * `RELIST_MS` after it was last listed; a listing that failed is tried again as soon as the window is.
     * Also under a hidden page, unlike the reopening: the entry would leave the account's devices otherwise.
     */
    const relist = (): void => {
      relisting = null;
      if (expired()) return;
      let mine: typeof relistOnItsWay = null;
      let over = false;
      let asked = false;
      const closeAsked = (): void => { if (asked && closeLate()) asked = false; };
      within(2 * REOPEN_MS, (async (): Promise<boolean> => {
        const { account, enrolling } = await thisPcMembership();
        if (!live) return true;
        if (account !== null) { await joined(account, enrolling); return true; }
        if (withdrawn()) { left(); return true; }
        // listed only under the account the press was made in: another sign-in since then ends the wait
        if (!await stillSignedIn()) { if (live) stopped(); return true; }
        if (!live || over) return true;
        if (withdrawn()) { left(); return true; }
        const kept = shared ? readAddPcWaiting() : null;
        if (mark !== null && kept !== null && kept.until === until && kept.listedAt > mark.listedAt) { mark = kept; return true; }
        // listed for this wait alone: nothing is written for another PC, under another sign-in, or once the wait
        // was stopped (here or in another copy) while the listing was on its way
        const wait = mark === null ? undefined : { serverId: mark.serverId, account: mark.account, running: (): boolean => live && !withdrawn() };
        const flying = shared && relistOnItsWay?.until === until ? relistOnItsWay : null;
        asked = flying === null;
        const listed = flying?.listed ?? listThisPc(accountService(), { relistMs: RELIST_MS, for: wait });
        // its request for the window may reach the PC only after this attempt was given up for getting no answer in
        // time, and after Stop waiting closed the window: closed once more when the listing itself is over, and
        // when the attempt is (a listing whose directory never answers is never over)
        if (flying === null) void listed.then(closeAsked, closeAsked);
        if (shared && flying === null) relistOnItsWay = mine = { until, listed };
        await listed;
        if (!live) return true;
        // another copy stopped the wait while the PC was being listed: what it forgot is not kept again
        if (withdrawn()) { left(); return true; }
        if (mark !== null) { mark = { ...mark, listedAt: Date.now() }; keepAddPcWaiting(mark); }
        return true;
      })()).catch((error: unknown) => {
        if (error instanceof AddPcWaitOver) {
          if (!live) return true;
          // the address answers for another PC now, or the tab is signed in to another account: the wait is not this one's
          if (error.why !== "ended") { stopped(); return true; }
          if (withdrawn()) { left(); return true; }
          return false;
        }
        console.warn("Ovis: this PC was not listed in the account again", error instanceof Error ? error.name : error);
        return false;
      }).then((ok) => {
        over = true;
        closeAsked();
        if (mine !== null && relistOnItsWay === mine) relistOnItsWay = null;
        if (live && relisting === null) relisting = setTimeout(relist, ok ? due() || RELIST_MS : REOPEN_MS);
      });
    };
    const shown = (): void => { if (!pageHidden()) { reopen(); ask(); } };
    const timers = [setInterval(reopen, REOPEN_MS), setInterval(ask, ADDED_POLL_MS)];
    relisting = setTimeout(relist, due());
    // a hidden page's timers run late or not at all: the end of the thirty minutes has a timer of its own
    const end = setTimeout(expired, Math.max(0, until - Date.now()));
    document.addEventListener("visibilitychange", shown);
    if (begun.resumed) reopen();
    return () => {
      live = false;
      for (const timer of timers) clearInterval(timer);
      if (relisting !== null) clearTimeout(relisting);
      clearTimeout(end);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [begun, joinedAs, accountService]);
  // the PC is in the account, but the device that added it has not finished its enrollment: asked until it has
  const settling = state.kind === "done" && state.enrolling ? state.account : null;
  useEffect(() => {
    if (settling === null) return;
    let live = true;
    let asking = false;
    const timer = setInterval(() => {
      if (pageHidden() || asking) return;
      asking = true;
      within(ANSWER_MS, thisPcMembership()).then(({ account, enrolling }) => {
        if (!live) return;
        // its first member left before enrolling it: the PC is in no account again
        if (account !== settling) setState(account === null ? { kind: "offer" } : { kind: "hidden" });
        else if (!enrolling) setState({ kind: "done", account, enrolling: false });
      }, warned("Ovis: this PC's account could not be read")).finally(() => { asking = false; });
    }, ADDED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [settling]);
  const attempt = useRef(0);
  /**
   * What ends the attempt under way when its screen goes, for one that shows no button meanwhile (a listing no
   * press began, the relay button's start): it is dropped, and the window it opened for nobody is closed.
   * Null for a pressed listing, which goes on as it always did, and once the attempt is over.
   */
  const dropped = useRef<(() => void) | null>(null);
  useEffect(() => () => { dropped.current?.(); dropped.current = null; }, []);
  /**
   * Lists this PC and waits, thirty minutes from this press, or from the sign-in that just finished here
   * (`as`, its account): that one says what it is doing, lists under that account alone, is given up after
   * `ADDING_MS` (the button again) or when its screen goes, and a relay that is off is offered with one button,
   * never started. The window such an attempt opened is closed again when nobody comes to wait on it.
   */
  const add = (as: string | null = null): void => {
    const mine = ++attempt.current;
    const began = ++starts.current;
    const current = (): boolean => attempt.current === mine;
    if (as !== null) setState({ kind: "adding" });
    let opened = false;
    let writing = false;
    let closed = false;
    /** Closes the window this attempt opened, once: never under a wait the tab keeps, or a listing begun since. */
    const closeOpened = (): void => {
      if (!opened || closed || starts.current !== began || waitKept()) return;
      closed = true;
      closeWindow();
    };
    const drop = as === null ? null : (): void => { if (current()) attempt.current++; closeOpened(); };
    dropped.current = drop;
    const over = (): void => { if (dropped.current === drop) dropped.current = null; };
    const reached = (step: "opened" | "writing"): void => { if (step === "opened") opened = true; else writing = true; };
    const listing = (async (): Promise<AddThisPcState | null> => {
      // the window outlives a wait that stopped by up to ten minutes: a device may have added this PC through it, and then nothing is listed again
      const { account: joined, enrolling } = await thisPcMembership();
      if (!current()) return null;
      if (joined !== null) { keepAddPcWaiting(null); return await joinedAs(joined, enrolling); }
      const { name, serverId, account } = await listThisPc(accountService(), { relistMs: RELIST_MS, ...(as === null ? {} : { as: { account: as, running: current, reached } }) });
      if (!current()) return null;
      // in one press when the account service admits it; the window this listing opened is then needed no more
      if (account !== null && await addInOnePress(accountService(), serverId, account, current, opensAll())) {
        // an attempt given up or replaced meanwhile clears nothing that a newer one owns
        if (!current()) return null;
        // the account lists this PC now: whoever shows the account's PCs reads them again
        listed();
        keepAddPcWaiting(null);
        closeAddWindow().catch(warned("Ovis: this PC's pairing window could not be closed"));
        return await joinedAs(account, false);
      }
      if (!current()) return null;
      const now = Date.now();
      const mark = account === null ? null : { name, until: now + WAITING_MS, serverId, account, listedAt: now };
      pressed.current = mark?.until ?? null;
      keepAddPcWaiting(mark);
      return { kind: "waiting", name, until: now + WAITING_MS, mark, resumed: false, signedIn: as !== null };
    })();
    // an attempt given up, or whose screen went, while its window was still being opened: closed once it is open
    if (as !== null) listing.then(() => {}, () => {}).then(() => { if (!current()) closeOpened(); });
    (as === null ? listing : within(ADDING_MS, listing)).then((next) => { over(); if (next !== null && current()) setState(next); }, (error: unknown) => {
      over();
      if (!current()) return;
      attempt.current++;
      console.warn("Ovis: this PC was not listed in the account", error instanceof Error ? error.name : error);
      // nobody waits on the window a listing no press began opened
      closeOpened();
      // another sign-in, or none, is stored than the one that just finished here: nothing was listed, and the button lists under that one
      if (as !== null && error instanceof AddPcWaitOver) { setState({ kind: "offer" }); return; }
      const relayOff = error instanceof ApiError && error.code === "relay_off";
      if (as !== null && relayOff) { setState({ kind: "relay-off", account: as, error: null }); return; }
      setState({ kind: "error", message: relayOff
        ? relayAbove ? t("Turn on remote access through the Ovis relay above first.") : t("Turn on remote access through the Ovis relay in Settings → Devices and PCs first.")
        // its entry was already on the way to the directory when the screen gave up: it may be listed all the same
        : writing ? t("This PC may not have been listed in your account. Try again.") : t("This PC could not be listed in your account. Try again.") });
    });
  };
  /**
   * A sign-in that just finished here through a button that said nothing of adding this PC: nothing is listed or
   * opened. It gets the offer, and with the relay off the one button that turns it on and lists, under `account`.
   */
  const offerAfterSignIn = (account: string): void => {
    const mine = ++attempt.current;
    const current = (): boolean => attempt.current === mine;
    const drop = (): void => { if (current()) attempt.current++; };
    dropped.current = drop;
    within(ANSWER_MS, fetchRelay()).then((relay) => relay.phase === "off", (error: unknown) => {
      warned("Ovis: this PC's relay could not be read")(error);
      return false;
    }).then((off) => {
      if (dropped.current === drop) dropped.current = null;
      if (current()) setState(off ? { kind: "relay-off", account, error: null } : { kind: "offer" });
    });
  };
  const relayOff = state.kind === "relay-off";
  useEffect(() => {
    if (relayOn === undefined) return;
    if (relayOn) { setState((current) => current.kind === "relay-off" ? { kind: "offer" } : current); return; }
    // turned off again: the idle offer becomes the one press that turns it on and adds, under the sign-in stored now
    let live = true;
    accountService().session().then((session) => {
      if (live && session !== undefined) setState((current) => current.kind === "offer" ? { kind: "relay-off", account: session.account, error: null } : current);
    }, warned("Ovis: the sign-in could not be read"));
    return () => { live = false; };
  }, [relayOn, accountService]);
  const [closesGate, setClosesGate] = useState(false);
  useEffect(() => {
    if (!relayOff) return;
    let live = true;
    fetchBridgeHealth().then(({ security }) => { if (live) setClosesGate(security !== undefined && security.pairing_gate === "open" && !security.token_configured); },
      warned("Ovis: this PC's access facts could not be read"));
    return () => { live = false; };
  }, [relayOff]);
  /**
   * The one press that turns the relay on and lists this PC, under the sign-in the button was offered to
   * (`account`): with another one stored, or none, nothing is started and the plain offer comes back. A relay
   * that may not start says why and nothing is listed; a start that does not answer within `ADDING_MS` gives
   * the button back. Turning the relay on closes a device gate still open, which would shut out a browser in
   * only because nothing is paired yet (auth via "open"). The PC refuses such a browser its account
   * (server/dispatch.ts, owner_only), so this button is never offered to one; should how this browser is in
   * have changed since, it pairs itself first, as the setup guide's relay button does (SetupGuide), and the relay
   * is not started when that, or reading how this browser is in, fails.
   */
  const startRelayAndAdd = (account: string): void => {
    const mine = ++attempt.current;
    starts.current++;
    const current = (): boolean => attempt.current === mine;
    // the screen shows no button meanwhile: a start that answers after its screen went lists nothing
    const drop = (): void => { if (current()) attempt.current++; };
    dropped.current = drop;
    const over = (): void => { if (dropped.current === drop) dropped.current = null; };
    setState({ kind: "adding" });
    within(ADDING_MS, (async (): Promise<void> => {
      const session = await accountService().session();
      if (!current()) return;
      if (session?.account !== account) { setState({ kind: "offer" }); return; }
      const { auth } = await fetchBridgeHealth();
      if (!current()) return;
      if (auth?.via === "open") await pairThisBrowser();
      if (!current()) return;
      const status = await requestRelay("start");
      if (!current()) return;
      if (status.blocked !== null) { setState({ kind: "relay-off", account, error: statusText(t, status) }); return; }
      if (status.phase === "off") { setState({ kind: "relay-off", account, error: t("The relay could not be turned on. Try again.") }); return; }
      add(account);
    })()).then(over, (error: unknown) => {
      over();
      if (!current()) return;
      attempt.current++;
      console.warn("Ovis: the relay was not turned on", error instanceof Error ? error.name : error);
      setState({ kind: "relay-off", account, error: error instanceof UnconfirmedPairing
        ? t("Could not confirm this browser is paired. Check that cookies are enabled, then try again.")
        : t("The relay could not be turned on. Try again.") });
    });
  };
  /**
   * Stops waiting, in every copy of this screen, and closes the window on the PC so nothing more is taken;
   * an older Ovis has no such route and lets it run out. A reopen or a listing still on its way to the PC may
   * open the window again after that close: the wait's own effect closes it once more when they answer (`closeLate`),
   * also a listing that was given up for getting no answer in time.
   */
  const stop = (): void => {
    stops.current++;
    keepAddPcWaiting(null);
    setState({ kind: "offer" });
    closeWindow();
  };
  if (state.kind === "hidden") return null;
  return (
    <div className="settings-item account-add-pc">
      {state.kind === "adding" ? (
        <p className="settings-description" role="status">{t("Signed in. Adding this PC to your account…")}</p>
      ) : state.kind === "relay-off" ? (
        <>
          <p className="settings-description">{t("Add this PC to your account, so every device of your account can use it with one approval.")}</p>
          <p className="settings-description">{t("The Ovis relay lets your devices reach this PC from anywhere.")}</p>
          {closesGate && gateNote && <p className="settings-condition">{t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
          <button type="button" className="btn btn-primary" onClick={() => startRelayAndAdd(state.account)}>{t("Turn on the relay and add this PC")}</button>
          {state.error !== null && <p className="settings-condition" role="alert">{state.error}</p>}
        </>
      ) : state.kind === "waiting" ? (
        <>
          {state.signedIn === true && <p className="settings-description">{t("Signed in. Adding this PC to your account…")}</p>}
          <p className="settings-description">{t("On a device signed in to this account (the Ovis app or app.ovis.sh), choose Add on {name}. This screen then shows a six-digit number: type it there, then press Approve here. Keep this page open.", { name: state.name })}</p>
          <NoOtherDevice />
          <p className="settings-description" role="status">{t("Waiting. The window reopens by itself if Ovis restarts.")}</p>
          <button type="button" className="btn" onClick={stop}>{t("Stop waiting")}</button>
        </>
      ) : state.kind === "done" ? (
        <>
          <p className="settings-description" role="status">{state.enrolling
            ? t("Not finished yet: the device that added this PC is still setting it up. If it stopped, open this PC on that device and choose Try again.")
            : t("This PC is in your account. A new device of your account may need one approval here.")}</p>
          <p className="settings-description" title={state.account}>{t("Account")} <code className="account-id">{state.account.length > 12 ? `${state.account.slice(0, 12)}…` : state.account}</code></p>
        </>
      ) : state.kind === "expired" ? (
        <>
          <p className="settings-description" role="status">{t("This PC stopped waiting after 30 minutes.")}</p>
          <NoOtherDevice />
          <button type="button" className="btn btn-primary" onClick={() => add()}>{t("Keep waiting")}</button>
        </>
      ) : (
        <>
          <p className="settings-description">{t("Add this PC to your account, so every device of your account can use it with one approval.")}</p>
          <button type="button" className="btn btn-primary" onClick={() => add()}>{t("Add this PC to my account")}</button>
          {state.kind === "error" && <p className="settings-condition" role="alert">{state.message}</p>}
        </>
      )}
    </div>
  );
}

/** The one-PC owner's way to the other side of the add (first-user path D4): the hosted app in another tab of this browser. */
function NoOtherDevice() {
  const t = useT();
  return (
    <>
      <p className="settings-description">{t("No other device? Open app.ovis.sh in a new tab here and sign in the same way. Choose Add there, then come back to this tab to approve.")}</p>
      <ExternalLink kind="ovis" className="btn" href={HOSTED_APP_URL}>{t("Open app.ovis.sh")}</ExternalLink>
    </>
  );
}

export function reachabilityProbe(report: (reachable: boolean) => void, fetchImpl: typeof fetch = fetch): (input: Request | string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    try {
      const response = await fetchImpl(input, init);
      report(response.status < 500);
      return response;
    } catch (error) {
      report(false);
      throw error;
    }
  };
}

export const REPROBE_MS = [5_000, 15_000, 60_000] as const;

interface ReprobeTimers { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const windowTimers: ReprobeTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function probeUntilReachable(probe: (live: () => boolean) => Promise<boolean>, timers: ReprobeTimers = windowTimers): () => void {
  let live = true;
  let handle: unknown = null;
  let tries = 0;
  const run = async (): Promise<void> => {
    handle = null;
    const reachable = await probe(() => live).catch(() => false);
    if (!live || reachable) return;
    handle = timers.set(() => void run(), REPROBE_MS[Math.min(tries, REPROBE_MS.length - 1)]!);
    tries += 1;
  };
  void run();
  return () => {
    live = false;
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
}

export interface AccountState {
  signedIn: boolean; account: string | null; pcs: MyPc[] | null;
  provider: AccountProvider | null;
  noPcs: boolean;
  reachable: boolean;
}

/** the phone and Mac apps sign in their own way, never with a code from a PC's page */
const pcServiceHere = (): string | null => desktopAccount() === null && !inNativeApp() && !inMacApp() ? pcAccountServiceOf(document, window.isSecureContext) : null;

export const accountServiceHere = (): string | null => desktopAccount()?.service ?? pcServiceHere();

export function AccountSection({ onAccount, recheck = 0, opensAll, deleteSlot = null }: {
  onAccount?: (state: AccountState) => void;
  recheck?: number;
  /** this PC lists account-opens-all/1 now (App, from the local socket's features) */
  opensAll?: () => boolean;
  /** where Delete account goes: the foot of the Devices and PCs page, below every other group; a row of the group without one */
  deleteSlot?: HTMLElement | null;
} = {}) {
  const t = useT();
  // a search finds settings rows only: while one runs, Delete account is the group's row again
  const searching = useContext(SettingsQuery).length > 0;
  const foot = searching ? null : deleteSlot;
  const bridge = desktopAccount();
  const pcService = pcServiceHere();
  const ownRedirect = useOwnWindowRedirect(bridge === null && pcService !== null);
  const offered = bridge !== null || pcService !== null;
  const [view, setView] = useState<View>({ kind: "loading" });
  const fallback: AccountProvider[] = bridge ? desktopProviders(bridge) : ["github"];
  const [offer, setOffer] = useState<OfferedProviders | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  /** the in_use line addMethod showed: its steps link shows only while that exact line is the error */
  const [inUseShown, setInUseShown] = useState<string | null>(null);
  /** a change to the ways in that waits for a fresh sign-in (403 reauth_required) */
  const [reauth, setReauth] = useState<{ action: "add" | "remove"; provider: AccountProvider } | { action: "delete"; provider: AccountProvider; deletion: Deletion } | null>(null);
  /**
   * Delete account was pressed once, for this sign-in: the same button now asks, says what goes, and its second press
   * deletes this sign-in's account alone. A sign-out, a sign-in or another account shown drops the question.
   */
  const [deleteAsked, setDeleteAsked] = useState<AccountSession | null>(null);
  /**
   * The delete confirmed here, until it ends: a sign-out or a sign-in ends it, and every step of it after a wait (the
   * sign-in again, the delete after it, what is drawn) goes on only while it is still this one.
   */
  const deletion = useRef<Deletion | null>(null);
  const [deleteOut, setDeleteOut] = useState<Deletion | null>(null);
  /** why the last delete was refused, said beside Delete account wherever it is drawn, for the account it was asked for */
  const [deleteFailed, setDeleteFailed] = useState<{ readonly account: string; readonly message: string } | null>(null);
  /** the sign-in-again prompt, while it is for the account shown: a delete's prompt never carries over to another account */
  const reauthShown = reauth !== null && (reauth.action !== "delete" || (view.kind === "signed-in" && reauth.deletion.session.account === view.account)) ? reauth : null;
  const deviceSignIn = useRef<AbortController | null>(null);
  /**
   * The sign-in that just finished on this screen, whether the button pressed for it said it adds this PC, and
   * when it finished, until Add this PC takes it: only a sign-in whose button said so adds the PC by itself, and
   * only for `SIGNED_IN_RETRY_MS`: one left untaken is none that just finished.
   */
  const signedInHere = useRef<(SignedInHere & { readonly at: number }) | null>(null);
  const takeSignedInHere = useCallback((): SignedInHere | null => {
    const fresh = signedInHere.current;
    signedInHere.current = null;
    return fresh !== null && Date.now() < fresh.at + SIGNED_IN_RETRY_MS ? { account: fresh.account, adds: fresh.adds } : null;
  }, []);
  const startedProvider = useRef<DeviceSignInProvider | null>(null);
  const service = bridge?.service ?? pcService;
  const fallbackKey = fallback.join(",");
  useEffect(() => {
    if (service === null) return;
    return probeUntilReachable(async (live) => {
      let reachable = true;
      const probe = reachabilityProbe((answer) => { reachable = answer; if (live()) setUnreachable(!answer); });
      try {
        const offered = await offeredProviders(service, fallbackKey.split(",") as AccountProvider[], { fetch: probe });
        if (live()) setOffer(offered);
      } catch (error) {
        console.warn("Ovis: the account service's sign-ins could not be read", error instanceof Error ? error.name : error);
      }
      return reachable;
    });
  }, [service, fallbackKey, recheck]);
  /** the desktop app and the PC's own window come back over loopback with any provider; another window only through a device flow */
  const providers: AccountProvider[] = bridge !== null || ownRedirect ? offer?.providers ?? fallback : offer?.device ?? ["github"];
  const linkPage = bridge === null && pcService !== null && ownRedirect === null && (offer?.page.length ?? 0) > 0;
  // bumped by a sign-out and on unmount: a load still waiting for the account's PCs then shows nothing
  const loads = useRef(0);

  const load = useCallback(async function read(): Promise<void> {
    const generation = ++loads.current;
    const show = (next: View) => { if (loads.current === generation) setView(next); };
    const service = indexedAccountService;
    const session = await service.session();
    if (session === undefined) { signedInHere.current = null; show({ kind: "signed-out", error: null }); return; }
    const signedIn = { kind: "signed-in", provider: session.provider, account: session.account } as const;
    show({ ...signedIn, pcs: null, methods: null, limits: null, error: null });
    void accountLimitsOf(service, session).then((limits) => {
      if (loads.current !== generation || limits === null) return;
      setView((current) => current.kind === "signed-in" && current.account === session.account ? { ...current, limits } : current);
    });
    try {
      const lists = await accountListsOf(service, session);
      if (loads.current !== generation) return;
      if (lists === null) { void read(); return; }
      const { pcs, methods } = lists;
      setView((current) => ({ ...signedIn, pcs: myPcs(pcs, [], { now: Date.now() }), methods, limits: current.kind === "signed-in" && current.account === session.account ? current.limits : null, error: null }));
    } catch (error) {
      // a sign-in that ended is none that just finished: one stored again later (another tab) adds nothing by itself
      if (error instanceof SignedOutError) {
        if (loads.current === generation) signedInHere.current = null;
        show({ kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") });
      }
      else if (loads.current === generation) setView((current) => ({ ...signedIn, pcs: [], methods: null, limits: current.kind === "signed-in" && current.account === session.account ? current.limits : null, error: t("The account service could not be reached. The PCs this device is paired with still work.") }));
    }
  }, [t]);

  const recheckAccount = useEffectEvent(() => {
    switch (view.kind) {
      case "device-code":
      case "signing-in": return;
      case "loading":
      case "signed-out":
      case "signed-in": if (offered) void load(); return;
      default: view satisfies never;
    }
  });
  useEffect(() => { recheckAccount(); }, [offered, load, recheck]);
  useEffect(() => {
    const signedIn = view.kind === "signed-in" ? view : null;
    onAccount?.({ signedIn: signedIn !== null, account: signedIn?.account ?? null, pcs: signedIn?.pcs ?? null, provider: signedIn?.provider ?? null,
      noPcs: signedIn !== null && signedIn.pcs !== null && signedIn.pcs.length === 0 && signedIn.error === null, reachable: !unreachable });
  }, [onAccount, view, unreachable]);
  // closing Settings ends a device sign-in still waiting: its session is then never kept
  useEffect(() => () => { deviceSignIn.current?.abort(); loads.current++; }, []);
  // the link page's one button says what it leads to, only where the sign-in does add the PC: one in no account,
  // with its relay on (the sign-in never turns it on), to a browser that drives it (a watching one lists nothing).
  // What the button says at the press is what the sign-in does (`signIn`), so words read a moment ago never add
  // the PC behind a plain "Sign in"; they follow the relay, which its switch in the same fold turns on and off:
  // read again every few seconds while the page shows, and when Settings asks (`recheck`).
  const signedOut = view.kind === "signed-out";
  const [addsPc, setAddsPc] = useState(false);
  useEffect(() => {
    if (!(linkPage || ownRedirect) || !signedOut) return;
    let live = true;
    /** whether this PC is in no account and this browser drives it; null until both were read */
    let addable: boolean | null = null;
    let reading = false;
    const read = (): void => {
      if (reading || pageHidden()) return;
      reading = true;
      within(ANSWER_MS, (async (): Promise<boolean> => {
        const [facts, relay] = await Promise.all([
          addable ?? Promise.all([thisPcInNoAccount(), fetchBridgeHealth()]).then(([none, { auth }]) => none && auth?.role !== "watch"),
          fetchRelay(),
        ]);
        addable = facts;
        return facts && relay.phase !== "off";
      })()).then((adds) => { if (live) setAddsPc(adds); }, (error: unknown) => {
        warned("Ovis: whether a sign-in adds this PC could not be read")(error);
        if (live) setAddsPc(false);
      }).finally(() => { reading = false; });
    };
    read();
    const timer = setInterval(read, ADDED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [linkPage, ownRedirect, signedOut, recheck]);

  if (!offered) return null;

  const unlinked = bridge !== null && view.kind === "signed-in" && view.methods !== null
    ? providers.filter((provider) => !view.methods?.some((method) => method.provider === provider)) : [];

  const cancelDeviceSignIn = (): void => {
    deviceSignIn.current?.abort();
    deviceSignIn.current = null;
  };

  const failureText = (error: unknown, provider: AccountProvider | null): string => {
    const name = provider === null ? null : PROVIDER_NAMES[provider];
    if (error instanceof AccountServiceError && error.code === "identity_exists" && name !== null) return t("Your account already signs in with {provider}.", { provider: name });
    if (!(error instanceof SignInError)) return t("The sign-in did not finish. Try again.");
    switch (error.code) {
      case "denied": return name === null ? t("The sign-in was refused.") : t("{provider} refused the sign-in.", { provider: name });
      case "expired": return t("The code expired. Sign in again to get a new one.");
      case "unsupported": return t("This account service can't sign in a browser on this PC yet.");
      case "in_use": return name === null
        ? t("This sign-in already belongs to another Ovis account. Nothing was changed.")
        : t("This {provider} account is linked to another Ovis account. Take {provider} off that account first, then you can add it here.", { provider: name });
      case "no_sign_in": return t("The sign-in did not finish. Try again.");
    }
  };

  const signInWithCode = (pcServiceOrigin: string, provider: DeviceSignInProvider, store: AccountStore = indexedAccountStore): Promise<AccountSession> => {
    cancelDeviceSignIn();
    const controller = new AbortController();
    deviceSignIn.current = controller;
    setView({ kind: "device-code", provider, userCode: null, verificationUri: "", verificationUriComplete: null });
    startedProvider.current = null;
    return (async () => {
      const requester = { label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0), os: deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
      const started = provider === "ovis"
        ? await startLinkPageSignIn({ service: pcServiceOrigin, store, requester }, offer?.device[0] ?? "github")
        : await startDeviceSignIn({ service: pcServiceOrigin, store, provider, requester });
      controller.signal.throwIfAborted();
      startedProvider.current = started.provider;
      setView({ kind: "device-code", provider: started.provider, userCode: started.userCode, verificationUri: started.verificationUri, verificationUriComplete: started.verificationUriComplete });
      return started.finish(controller.signal);
    })().finally(() => { if (deviceSignIn.current === controller) deviceSignIn.current = null; });
  };

  /**
   * Runs one provider's sign-in the way this page can; null when it cannot here. `viaLinkPage`: the
   * link page, where the person picks GitHub or Google; a sign-in again for this same account passes
   * false, so it stays with the provider the account signed in with.
   */
  /** `store`: where the sign-in is kept; a sign-in again to delete holds it back (deleteAccount.ts, holdingSessionStore) */
  const runSignIn = (provider: AccountProvider, viaLinkPage = linkPage, store: AccountStore = indexedAccountStore): Promise<AccountSession> | null => {
    if (bridge !== null) return desktopSignIn(provider, bridge, store);
    if (pcService === null) return null;
    if (ownRedirect) {
      cancelDeviceSignIn();
      const controller = new AbortController();
      deviceSignIn.current = controller;
      setView({ kind: "signing-in" });
      // held back until it is known not to be cancelled: a sign-in finished after Cancel is never kept
      return ownWindowSignIn(provider, { service: pcService, redirect: ownRedirect, store: holdingSessionStore(store), signal: controller.signal, blocked: (link) => setView({ kind: "signing-in", link }) })
        .then(async (session) => {
          let kept = false;
          await store.update("session", (current) => { if (controller.signal.aborted) return current; kept = true; return session; });
          if (!kept) throw new DOMException("The sign-in was cancelled", "AbortError");
          return session;
        })
        .finally(() => { if (deviceSignIn.current === controller) deviceSignIn.current = null; });
    }
    if (viaLinkPage) return signInWithCode(pcService, "ovis", store);
    return isDeviceProvider(provider) ? signInWithCode(pcService, provider, store) : null;
  };

  /**
   * `addsPc`: what the button pressed said. Only a press of "Sign in and add this PC" adds the PC with the
   * sign-in; a provider's own button, and the desktop app's, say nothing of it, so their sign-in adds nothing
   * and Add this PC offers its button.
   */
  const signIn = (provider: AccountProvider, addsPc = false): void => {
    deletion.current = null;
    setDeleteAsked(null);
    setReauth(null);
    if (bridge !== null) setView({ kind: "signing-in" });
    runSignIn(provider)?.then((session) => {
      // this sign-in, and no other, is the one that just finished here (AddThisPc): it adds the PC without a
      // second press only when its button said it would
      signedInHere.current = { account: session.account, adds: addsPc, at: Date.now() };
      return load();
    }, (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      const started = startedProvider.current;
      const named = bridge === null && pcService !== null && linkPage ? (started === null || started === "ovis" ? null : started) : provider;
      setView({ kind: "signed-out", error: failureText(error, named) });
    });
  };

  const needsReauth = (error: unknown): boolean => error instanceof AccountServiceError && error.code === "reauth_required";

  /**
   * Adds `provider` to the signed-in account on purpose, from the desktop app only: a link goes
   * through a redirect sign-in, never a device code someone else could have typed.
   */
  const addMethod = (provider: AccountProvider): void => {
    if (bridge === null) return;
    setView({ kind: "signing-in" });
    indexedAccountService.addMethod(provider, (linkToken, bearer) => desktopSignIn(provider, bridge, indexedAccountStore, { linkToken, bearer }))
      .then(() => load(), async (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Ovis: the sign-in method was not added", error instanceof SignInError || error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
        await load();
        if (needsReauth(error)) { setReauth({ action: "add", provider }); return; }
        const message = failureText(error, provider);
        setInUseShown(error instanceof SignInError && error.code === "in_use" ? message : null);
        setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
      });
  };

  const removeMethod = (provider: AccountProvider): void => {
    indexedAccountService.removeIdentity(provider).then(() => load(), (error: unknown) => {
      console.warn("Ovis: the sign-in method was not removed", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      if (needsReauth(error)) { setReauth({ action: "remove", provider }); return; }
      const message = error instanceof AccountServiceError && error.code === "last_identity"
        ? t("Add another way to sign in before removing this one.") : t("The sign-in method could not be removed. Try again.");
      setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
    });
  };

  /**
   * The service wants a sign-in from the last ten minutes to change the ways in: sign in again
   * with the method this device uses, then repeat the change, on the same account only.
   */
  const signInAgain = (): void => {
    if (reauthShown === null || view.kind !== "signed-in") return;
    const { action, provider } = reauthShown;
    const { account, provider: current } = view;
    const resumed = reauthShown.action === "delete" ? reauthShown.deletion : null;
    if (resumed !== null && deletion.current !== resumed) return;
    setReauth(null);
    // a sign-in again for the same account is none that adds the PC: one left untaken does not outlive it either
    signedInHere.current = null;
    runSignIn(current, false, resumed === null ? indexedAccountStore : holdingSessionStore(indexedAccountStore))?.then(async (session) => {
      if (resumed !== null) {
        // kept only in the place of the sign-in the delete was asked for, while it is still on and still stored: a sign-out
        // or another sign-in made meanwhile (here or in another tab) stays, and nothing is deleted
        const goesOn = deletion.current === resumed && session.account === resumed.session.account && await installSignInAgain(indexedAccountStore, resumed.session, session, () => deletion.current === resumed);
        if (deletion.current === resumed && !goesOn) deletion.current = null;
        await load();
        if (goesOn && deletion.current === resumed) runDelete(resumed, session);
        return;
      }
      await load();
      if (session.account !== account) return;
      switch (action) {
        case "add": addMethod(provider); return;
        case "remove": removeMethod(provider); return;
        case "delete": return;
        default: action satisfies never;
      }
    }, async (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      await load();
      setView((now) => now.kind === "signed-in" ? { ...now, error: failureText(error, current) } : now);
    });
  };

  /** The first press of Delete account: asks, for the sign-in stored now, when that is the account this section shows. */
  const askDelete = (): void => {
    if (deleteOut !== null) return;
    setReauth(null);
    setDeleteFailed(null);
    void indexedAccountService.session().then((session) => {
      // another tab signed out, or in as someone else: the section reads what is stored now instead of asking
      if (session === undefined || view.kind !== "signed-in" || session.account !== view.account) { void load(); return; }
      setDeleteAsked(session);
    }, (error: unknown) => console.warn("Ovis: the sign-in could not be read", error instanceof Error ? error.name : error));
  };

  /**
   * Deletes the account of `session`, the sign-in the question was asked for or a sign-in again to its account
   * (lib/account/deleteAccount.ts): one stored meanwhile (another tab) is never touched, and the section then reads
   * it. The service wants a sign-in from the last ten minutes, as for a change to the ways in.
   */
  /** The confirming press: one delete, for the sign-in the question was asked for. */
  const confirmDelete = (asked: AccountSession): void => {
    if (deleteOut !== null) return;
    const mine: Deletion = { session: asked };
    deletion.current = mine;
    runDelete(mine, asked);
  };

  /** One step of `mine`: deletes with `session` (its own sign-in, or a sign-in again to its account), while it is still on. */
  const runDelete = (mine: Deletion, session: AccountSession): void => {
    setDeleteAsked(null);
    setDeleteOut(mine);
    const service = indexedAccountService;
    void deleteAccount({ service, accountStore: indexedAccountStore, session }).finally(() => {
      setDeleteOut((out) => out === mine ? null : out);
    }).then(() => {
      // called off by a sign-out or a sign-in meanwhile: what that began is left be
      if (deletion.current !== mine) return;
      deletion.current = null;
      cancelDeviceSignIn();
      // a PC that waited to be added under the deleted account waits no longer
      keepAddPcWaiting(null);
      signedInHere.current = null;
      loads.current++;
      setReauth(null);
      // a sign-in that took the deleted one's place while the delete was out stays (deleteAccount.ts): it is shown
      void service.session().then((stored) => {
        if (stored !== undefined) { void load(); return; }
        setView((current) => current.kind === "signed-in" && current.account !== session.account ? current : { kind: "signed-out", error: null, notice: t("Your account was deleted.") });
      }, () => { void load(); });
    }, (error: unknown) => {
      if (deletion.current !== mine) return;
      console.warn("Ovis: the account was not deleted", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      // the delete goes on only through the prompt to sign in again, which carries it
      if (needsReauth(error)) { setReauth({ action: "delete", provider: session.provider, deletion: mine }); return; }
      deletion.current = null;
      if (error instanceof SignedOutError) { void load(); return; }
      setDeleteFailed({ account: session.account, message: error instanceof AccountServiceError && error.code === "subscription_active"
        ? t("Cancel your subscription first, then delete the account.") : t("The account could not be deleted. Try again.") });
    });
  };

  const signOut = (): void => {
    deletion.current = null;
    setDeleteAsked(null);
    setDeleteFailed(null);
    setReauth(null);
    cancelDeviceSignIn();
    // a PC that waited to be added under this sign-in waits no longer under the next one
    keepAddPcWaiting(null);
    signedInHere.current = null;
    loads.current++;
    void indexedAccountService.signOut()
      .catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error))
      .finally(() => setView({ kind: "signed-out", error: null }));
  };

  /** the question Delete account asked, while the account it was asked for is the one shown */
  const asked = view.kind === "signed-in" && deleteAsked?.account === view.account ? deleteAsked : null;

  const signInParts = (
    <>
      {view.kind === "signed-out" && ownRedirect !== undefined && (
        <div className="settings-item" data-offer={offer === null ? "build" : "service"}>
          {linkPage
            ? (
              <div className="account-sign-in">
                <button type="button" className="btn btn-primary account-provider" data-provider="ovis" onClick={() => signIn("github", addsPc)}>{addsPc ? t("Sign in and add this PC") : t("Sign in")}</button>
                {view.notice !== undefined && view.error === null && <p className="account-fineprint account-notice" role="status">{view.notice}</p>}
                {view.error !== null && <p className="account-error" role="alert">{view.error}</p>}
              </div>
            )
            : (
              <>
                {ownRedirect && addsPc && <p className="settings-description">{t("Signing in adds this PC to your account.")}</p>}
                <AccountSignIn onSignIn={(provider) => signIn(provider, Boolean(ownRedirect) && addsPc)} error={view.error} notice={view.notice ?? null} providers={providers} />
              </>
            )}
        </div>
      )}
      {view.kind === "signing-in" && (
        <SettingsRow label={t("Signing in…")} description={t("Finish signing in in your browser.")}>
          {ownRedirect ? (
            <>
              {view.link !== undefined && <ExternalLink kind="sign-in" className="btn btn-primary" href={view.link}>{t("Open the sign-in page")}</ExternalLink>}
              <button type="button" className="btn" onClick={() => { cancelDeviceSignIn(); void load(); }}>{t("Cancel")}</button>
            </>
          ) : null}
        </SettingsRow>
      )}
      {view.kind === "device-code" && (
        <div className="settings-item account-device">
          {view.userCode === null
            ? <p className="settings-description" role="status">{t("Signing in…")}</p>
            : view.provider === "ovis"
              ? (
                <>
                  <p className="settings-description">{t("On any device, open {address} and enter this code, then continue with {providers}. Enter it only if you started this sign-in on this page.", { address: linkAddress(view.verificationUri), providers: providerChoice(currentLocale(), offer !== null && offer.page.length > 0 ? offer.page : offer?.device ?? ["github"]) })}</p>
                  {view.verificationUriComplete !== null && <QrCode value={view.verificationUriComplete} label={t("QR code of the sign-in page with this code filled in")} />}
                  <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                  <p className="settings-description" role="status">{t("Waiting for the sign-in…")}</p>
                </>
              )
              : (
                <>
                  <p className="settings-description">{t("Open {provider} and enter this code. Enter it only if you started this sign-in on this page.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                  <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                  <p className="settings-description" role="status">{t("Waiting for {provider}…", { provider: PROVIDER_NAMES[view.provider] })}</p>
                </>
              )}
          <div className="account-device-actions">
            {view.userCode !== null && (
              <ExternalLink kind="sign-in" className="btn btn-primary" href={view.verificationUri}>
                {view.provider === "ovis" ? t("Open the sign-in page") : t("Open {provider}", { provider: PROVIDER_NAMES[view.provider] })}
              </ExternalLink>
            )}
            <button type="button" className="btn" onClick={() => { cancelDeviceSignIn(); void load(); }}>{t("Cancel")}</button>
          </div>
        </div>
      )}
    </>
  );

  const whereToDelete = t("To delete your account, use the Ovis phone app, the desktop app or app.ovis.sh.");
  const deleteSays = asked !== null
    ? <span role="status" data-testid="delete-account-says">{t("This deletes your Ovis account for good: your sign-in methods, your list of PCs and your plan. It cannot be undone. Devices stay paired with your PCs until you revoke them on each PC. A subscription that still renews has to be cancelled first.")}</span>
    : null;
  const deleteActions = (
    <>
      <button type="button" className={asked !== null ? "btn btn-danger" : foot === null ? "btn" : "account-delete-link"} data-action="delete-account" data-confirm={asked !== null ? "delete-account" : undefined}
        disabled={deleteOut !== null} aria-busy={deleteOut !== null ? "true" : undefined}
        onClick={() => { if (asked !== null) confirmDelete(asked); else askDelete(); }}>{asked !== null ? t("Delete account for good?") : t("Delete account")}</button>
      {asked !== null && <button type="button" className="btn btn-ghost" onClick={() => setDeleteAsked(null)}>{t("Cancel")}</button>}
    </>
  );
  const plan = view.kind === "signed-in" && view.limits !== null ? formatAccountLimits(t, view.limits, view.pcs?.filter((pc) => pc.listed).length ?? 0) : null;
  const deleteRefused = view.kind === "signed-in" && deleteFailed?.account === view.account ? deleteFailed.message : null;
  const deleteParts = view.kind === "signed-in" && (
    <>
      {/* A PC's own page in a browser signs in with a device code or the link page, whose sign-in the service never lets
          delete the account (web_sign_in_required): it says where to delete instead. */}
      {foot === null
        ? bridge === null
          ? <SettingsRow label={t("Delete account")} description={whereToDelete}>{null}</SettingsRow>
          : <SettingsRow label={t("Delete account")} description={deleteSays ?? undefined}>{deleteActions}</SettingsRow>
        : bridge === null
          ? (
            <details className="settings-item account-delete">
              <summary className="account-delete-link">{t("Delete account")}</summary>
              <p className="settings-description">{whereToDelete}</p>
            </details>
          )
          : (
            <div className="settings-item account-delete">
              {deleteSays !== null && <p className="settings-description">{deleteSays}</p>}
              <div className="account-delete-actions">{deleteActions}</div>
            </div>
          )}
      {deleteRefused !== null && <p className="settings-condition" role="alert">{deleteRefused}</p>}
      {reauthShown?.action === "delete" && (
        <div className="settings-item account-reauth" role="alert">
          <p className="settings-description">{t("To delete your account, sign in again with {provider} first.", { provider: PROVIDER_NAMES[view.provider] })}</p>
          <button type="button" className="btn btn-primary" onClick={signInAgain}>{t("Sign in again")}</button>
        </div>
      )}
    </>
  );

  return (
    <SettingsGroup title={t("Account")} section="account" keepNote note={view.kind === "signed-out" ? t("Sign in to use this PC from your phone and your other PCs.|account group") : undefined}>
      {signInParts}
      {view.kind === "signed-in" && (
        <>
          {/* which account: the service keeps no login or email, so its id names it, in the tooltip only (G-106) */}
          {searching
            ? (
              <SettingsRow label={t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })} description={plan ?? undefined} keywords={t("Sign out")}>
                <button type="button" className="btn" onClick={signOut}>{t("Sign out of {provider}", { provider: PROVIDER_NAMES[view.provider] })}</button>
              </SettingsRow>
            )
            : (
              <div className="settings-row account-head">
                <span className="account-who" title={view.account}>
                  <ProviderMark provider={view.provider} />
                  <span className="settings-label" aria-hidden="true">{PROVIDER_NAMES[view.provider]}</span>
                  <span className="visually-hidden">{t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}</span>
                  {plan !== null && <span className="account-plan">{plan}</span>}
                </span>
                <button type="button" className="btn account-head-btn" aria-label={t("Sign out of {provider}", { provider: PROVIDER_NAMES[view.provider] })} onClick={signOut}>{t("Sign out")}</button>
              </div>
            )}
          {view.methods !== null && (
            <div className="settings-item account-methods">
              <div className="account-method-row" title={bridge === null ? t("Add another way to sign in from the Ovis desktop app.") : undefined}>
                <span className="settings-label">{t("Ways to sign in")}{bridge === null && <span className="visually-hidden"> {t("Add another way to sign in from the Ovis desktop app.")}</span>}</span>
                <ul className="account-method-list">
                  {view.methods.map((method) => (
                    <li key={method.provider} className="account-method account-chip" data-provider={method.provider} title={PROVIDER_NAMES[method.provider]}>
                      <ProviderMark provider={method.provider} />
                      <span className="visually-hidden">{t("{provider}, connected", { provider: PROVIDER_NAMES[method.provider] })}</span>
                      <Check className="account-chip-icon" aria-hidden="true" />
                      {/* the method this device signed in with stays: removing it would end this sign-in. */}
                      {view.methods !== null && view.methods.length > 1 && method.provider !== view.provider && (
                        <button type="button" className="account-chip-remove" title={t("Remove {provider}", { provider: PROVIDER_NAMES[method.provider] })} onClick={() => removeMethod(method.provider)}>
                          <X aria-hidden="true" /><span className="visually-hidden">{t("Remove {provider}", { provider: PROVIDER_NAMES[method.provider] })}</span>
                        </button>
                      )}
                    </li>
                  ))}
                  {unlinked.map((provider) => (
                    <li key={provider}>
                      <button type="button" className="account-chip account-chip-add" data-provider={provider} title={t("Add {provider}", { provider: PROVIDER_NAMES[provider] })} onClick={() => addMethod(provider)}>
                        <Plus className="account-chip-icon" aria-hidden="true" /><ProviderMark provider={provider} />
                        <span className="visually-hidden">{t("Add {provider}", { provider: PROVIDER_NAMES[provider] })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {reauthShown !== null && reauthShown.action !== "delete" && (
                <div className="account-reauth" role="alert">
                  <p className="settings-description">{bridge === null
                      // a sign-in again stays with this account's provider, at its own device page, never the link page's choice
                      ? t("To change how you sign in, sign in again with {provider} on its own sign-in page first.", { provider: PROVIDER_NAMES[view.provider] })
                      : t("To change how you sign in, sign in again with {provider} first.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                  {(bridge !== null || isDeviceProvider(view.provider)) && <button type="button" className="btn btn-primary" onClick={signInAgain}>{t("Sign in again")}</button>}
                </div>
              )}
            </div>
          )}
          <AddThisPc signedInHere={takeSignedInHere} onListed={() => { void load(); }} {...(opensAll === undefined ? {} : { opensAll })} />
          {view.pcs !== null && onAccount === undefined && <div className="settings-item"><AccountPcList pcs={view.pcs} /></div>}
          {foot !== null ? deleteParts && createPortal(deleteParts, foot) : deleteParts}
          {view.error !== null && <p className="settings-condition" role="alert">{view.error}{view.error === inUseShown && <> <ExternalLink kind="link" className="settings-link" href={IN_USE_HELP}>{t("See how")}</ExternalLink></>}</p>}
        </>
      )}
    </SettingsGroup>
  );
}
