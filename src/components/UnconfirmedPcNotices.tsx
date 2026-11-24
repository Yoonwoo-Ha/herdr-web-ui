import { Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCOUNT_OS_NAMES, accountLabel, placeName, type AccountAsker } from "../../shared/account-asker.ts";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { newPcNoticeKey } from "../lib/account/newPcNotice.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountServiceError, indexedAccountService, SignedOutError, type AccountService, type DirectoryPc } from "../lib/account/service.ts";
import type { AccountProvider, AccountSession } from "../lib/account/store.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { NewPcNotice } from "./NewPcNotices.tsx";
import { usePcRemoval } from "./usePcRemoval.tsx";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

/**
 * security-triage condition 3: Add only while the listing is this young, by its added_at, and never past the account
 * service's own window for a listing that asks to join (`asking_until`); after it, that one's request ran out (No alone),
 * and any other unconfirmed PC (`asking_until` null: one no window applies to, which may be a PC in use) offers its removal
 */
const ADD_WINDOW_MS = 10 * 60_000;
/** how often the time left is drawn again */
const TICK_MS = 15_000;
/** the add a Sign in again was pressed for, by account, PC and listing: the sign-in comes back as a page load, which goes on with it once */
const PENDING_ADD = "ovis:confirm-pc";

/** the add pressed before a Sign in again: that PC, and the listing its card showed when the service gave one (account#67) */
type PendingAdd = { readonly server_id: string; readonly listing_id?: string };
type Listing = { readonly session: AccountSession; readonly pcs: readonly DirectoryPc[]; readonly pending: PendingAdd | null };
/** `signInAgain`: a fresh own sign-in may pass it */
type Problem = { readonly text: string; readonly signInAgain: boolean };

function takePendingAdd(account: string): PendingAdd | null {
  try {
    const kept = sessionStorage.getItem(PENDING_ADD);
    sessionStorage.removeItem(PENDING_ADD);
    const parsed: unknown = kept === null ? null : JSON.parse(kept);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { account: of, server_id, listing_id } = parsed as { account?: unknown; server_id?: unknown; listing_id?: unknown };
    return of === account && typeof server_id === "string" ? { server_id, ...(typeof listing_id === "string" ? { listing_id } : {}) } : null;
  } catch { return null; }
}

function keepPendingAdd(account: string, pc: DirectoryPc): void {
  try { sessionStorage.setItem(PENDING_ADD, JSON.stringify({ account, server_id: pc.server_id, ...(typeof pc.listing_id === "string" ? { listing_id: pc.listing_id } : {}) })); }
  catch { /* not kept: Add is pressed again after the sign-in */ }
}

/**
 * The add pressed before a Sign in again goes on only for the listing it was pressed on: a replacement waits for its own
 * press, and so does any listing when the kept add names none (an older Ovis kept it) or another. Only where the service
 * gives the PC no listing ID at all is there nothing to tell listings apart by, and an add kept without one goes on.
 */
const pendingFor = (pending: PendingAdd | null, pc: DirectoryPc): boolean =>
  pending?.server_id === pc.server_id && pending.listing_id === (typeof pc.listing_id === "string" ? pc.listing_id : undefined);

/** "Linux · Seoul, South Korea": what the account service knows of who is asking, null when it knows nothing */
function askerLine(asker: AccountAsker | undefined, language: string): string | null {
  if (asker === undefined) return null;
  const parts = [asker.os === null ? null : ACCOUNT_OS_NAMES[asker.os], placeName(language, asker)].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** the admit refusals about the sign-in alone (docs/account.md) say so, with Sign in again: a fresh own sign-in may pass them */
function refusal(t: Translate, error: Error): Problem {
  switch (error instanceof AccountServiceError ? error.code : null) {
    case "session_not_fresh": return { text: t("Sign in again to add it: your sign-in is more than ten minutes old."), signInAgain: true };
    case "own_sign_in_required": return { text: t("Sign in on this device to add it."), signInAgain: true };
    case "pc_add_cap": return { text: t("This account has added as many PCs as it can today. Try again later."), signInAgain: false };
    // an account service from before 2026-11-23 still asks a used account's admit for two-step, which signing in again does not give
    case "two_step_required": return { text: t("This account has no two-step sign-in to add it here. Add it with the number on the PC's screen."), signInAgain: false };
    default: return { text: t("The PC could not be added. Try again."), signInAgain: false };
  }
}

/**
 * PCL-1: the PCs a device code listed in the account (anyone may type one for any PC) and no app's own sign-in confirmed,
 * each offered to this device while its sign-in is an app's own; a device code's sign-in is offered nothing. Read on
 * mount, focus and when the account's PCs change. Add is the account's one-press admission of the PC, which also
 * confirms its listing: the PC then takes it with its own key's proof (`ovis add` waits for it; docs/relay.md, "A PC
 * with no screen"). `tellConfirmed`: after Add, the PC's new-PC card (C3) is drawn here, where no NewPcNotices tells of
 * it already. `onSignInAgain`: a fresh own sign-in, after which the add goes on.
 */
export function UnconfirmedPcNotices({ service = indexedAccountService, enabled = true, tellConfirmed = true, now = Date.now, onSignInAgain }: {
  readonly service?: AccountService;
  readonly enabled?: boolean;
  readonly tellConfirmed?: boolean;
  readonly now?: () => number;
  readonly onSignInAgain?: ((provider: AccountProvider) => void) | undefined;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [confirmed, setConfirmed] = useState<readonly DirectoryPc[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) { setListing(null); return; }
    let version = 0;
    const read = async (): Promise<void> => {
      const mine = ++version;
      try {
        const session = await service.session();
        if (mine !== version) return;
        if (session === undefined) { setListing(null); return; }
        const directory = service.forSignIn(session);
        const [own, pcs] = await Promise.all([directory.ownSignIn(), directory.listUnconfirmedPcs()]);
        if (mine !== version) return;
        // a device code's sign-in cannot admit, and it is no one's to remove a PC with: nothing is offered to it
        setListing((prior) => own ? { session, pcs, pending: prior?.session.account === session.account ? prior.pending : takePendingAdd(session.account) } : null);
      } catch (error) {
        if (mine !== version) return;
        if (error instanceof SignedOutError) setListing(null);
        else if (error instanceof Error) console.warn("Ovis: the account's unconfirmed PCs could not be read", error.name);
        else throw error;
      }
    };
    const visibleRead = (): void => { if (document.visibilityState === "visible") void read(); };
    const signInChanged = (): void => { setListing(null); setConfirmed([]); void read(); };
    void read();
    document.addEventListener("visibilitychange", visibleRead);
    window.addEventListener("focus", visibleRead);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    return () => {
      version++;
      document.removeEventListener("visibilitychange", visibleRead);
      window.removeEventListener("focus", visibleRead);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
      window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    };
  }, [service, enabled]);

  if (listing === null) return null;
  const { session } = listing;
  const told = new Set(confirmed.map((pc) => pc.server_id));
  return (
    <>
      {listing.pcs.filter((pc) => !told.has(pc.server_id) && !removed.has(pc.server_id)).map((pc) => (
        <UnconfirmedPcNotice key={`${session.account}:${pc.server_id}:${pc.listing_id ?? pc.added_at}`} pc={pc} session={session} service={service} now={now} retry={pendingFor(listing.pending, pc)}
          {...(onSignInAgain ? { onSignInAgain } : {})}
          onConfirmed={(row) => setConfirmed((prior) => [...prior.filter((each) => each.server_id !== row.server_id), row])}
          onRemoved={() => setRemoved((prior) => new Set([...prior, pc.server_id]))} />
      ))}
      {tellConfirmed && confirmed.map((pc) => <NewPcNotice key={`${session.account}:new:${pc.server_id}`} pc={pc} session={session} dismissalKey={newPcNoticeKey(session.account, pc)} />)}
    </>
  );
}

function UnconfirmedPcNotice({ pc, session, service, now, retry, onSignInAgain, onConfirmed, onRemoved }: {
  readonly pc: DirectoryPc;
  readonly session: AccountSession;
  readonly service: AccountService;
  readonly now: () => number;
  readonly retry: boolean;
  readonly onSignInAgain?: (provider: AccountProvider) => void;
  readonly onConfirmed: (row: DirectoryPc) => void;
  readonly onRemoved: () => void;
}) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const added = Date.parse(pc.added_at);
  // the account service names a window only for a listing that asks to join; null or absent, the card is as it was
  const [toldExpired, setToldExpired] = useState(false);
  const asking = typeof pc.asking_until === "string" || toldExpired;
  const askedUntil = typeof pc.asking_until === "string" ? Date.parse(pc.asking_until) : Number.POSITIVE_INFINITY;
  const until = Math.min(added + ADD_WINDOW_MS, askedUntil);
  const youngAt = (at: number): boolean => !(at > until);
  const [young, setYoung] = useState(() => youngAt(now()));
  const ranOut = asking && !young;
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const inFlight = useRef(false);
  const removal = usePcRemoval(service, () => {
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    onRemoved();
  });
  useEffect(() => {
    if (!young) return;
    const timer = setTimeout(() => setYoung(false), Math.max(0, Math.min(ADD_WINDOW_MS, until - now())));
    const tick = setInterval(() => setTick((count) => count + 1), TICK_MS);
    return () => { clearTimeout(timer); clearInterval(tick); };
  }, [young, until, now]);
  // what an Add was told says nothing once the request ran out
  useEffect(() => { if (ranOut) setProblem(null); }, [ranOut]);

  const act = async (work: () => Promise<void>, failed: (error: Error) => Problem): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try { await work(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      setProblem(failed(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const directory = service.forSignIn(session);
  // the ten minutes are checked again at the press: a page left open never adds an old listing
  const add = (): Promise<void> => act(async () => {
    if (!youngAt(now())) { setYoung(false); return; }
    // account#67: the admit names no listing, so the one waiting is read first. When it is no longer the one this card
    // showed (another device said No, the PC listed itself again), nothing is admitted and the card is drawn again
    const waiting = (await directory.listUnconfirmedPcs()).find((each) => each.server_id === pc.server_id);
    if (waiting === undefined || waiting.listing_id !== pc.listing_id) {
      window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
      return;
    }
    let admitted: { readonly new_until: string; readonly admitted_at: string | null };
    try { admitted = await directory.admitPc(pc.server_id, undefined, typeof waiting.listing_id === "string" ? waiting.listing_id : undefined); }
    catch (error) {
      // the service's own window for it ended: nothing was admitted, and the request is started again on the PC
      if (error instanceof AccountServiceError && error.code === "listing_expired") { setToldExpired(true); setYoung(false); return; }
      // the account no longer lists it, or lists another listing of it: nothing was admitted, and the card is drawn again.
      // A key proof signs the listing it read, so a listing replaced meanwhile is refused as the sign-in's age: read again
      const changed = error instanceof AccountServiceError && (error.code === "unknown_pc" || error.code === "listing_changed"
        || (error.code === "session_not_fresh" && await directory.listUnconfirmedPcs().then((pcs) => pcs.find((each) => each.server_id === pc.server_id)?.listing_id !== pc.listing_id, () => false)));
      if (!changed) throw error;
      window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
      return;
    }
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    // the new-PC card's dismissal is kept under the admission's time (newPcNoticeKey): the service's own, as its directory
    // row gives it, never this device's clock, so a card closed here stays closed when the row is read again
    const at = admitted.admitted_at ?? (await directory.listPcs().catch(() => [])).find((each) => each.server_id === pc.server_id)?.admitted_at ?? null;
    const { unconfirmed: _unconfirmed, asking: _asking, asking_until: _until, ...listed } = pc;
    onConfirmed({ ...listed, new_until: admitted.new_until, admitted_at: at });
  }, (error) => refusal(t, error));
  const remove = (): Promise<void> => act(async () => { await removal.remove(session, pc.server_id, typeof pc.listing_id === "string" ? pc.listing_id : undefined); },
    () => ({ text: t("The PC could not be removed. Try again."), signInAgain: false }));
  const latestAdd = useRef(add);
  latestAdd.current = add;
  useEffect(() => { if (retry) void latestAdd.current(); }, [retry]);

  const time = new Date(added).toLocaleTimeString(resolvedLanguage, { hour: "2-digit", minute: "2-digit" });
  const asker = askerLine(pc.asking, resolvedLanguage);
  return (
    <div className="update-notice is-paired device-notice" role="status" data-unconfirmed-pc={pc.server_id} {...(asking ? { "data-asking": young ? "open" : "ran-out" } : {})}>
      <Monitor aria-hidden="true" />
      <span className="device-notice-text">
        {young && <span>{t("Add this PC to your account?")}</span>}
        <span>{t("Name the PC gave itself: \"{name}\"", { name: accountLabel(pc.label) })}</span>
        {asker !== null && <span className="settings-hint" data-asker>{asker}</span>}
        <span className="settings-hint">{t("A PC was added to your account with a sign-in code at {time}.", { time })}{young ? ` ${t("Add it only if you started adding that PC yourself and entered the code it showed. If someone else gave you the code, or you did not start this, press No.")}` : ""}</span>
        {asking && young && <span className="settings-hint">{t("Expires in {minutes} min", { minutes: Math.min(10, Math.max(1, Math.ceil((until - now()) / 60_000))) })}</span>}
        {ranOut && <span>{t("This request ran out. To add this PC, start again on the PC.")}</span>}
        {problem !== null && <span className="account-error" role="alert">{problem.text}</span>}
        {removal.prompt}
      </span>
      <div className="device-paired-actions">
        {!ranOut && problem?.signInAgain === true && onSignInAgain !== undefined && (
          <button type="button" className="btn" disabled={busy} onClick={() => { keepPendingAdd(session.account, pc); onSignInAgain(session.provider); }}>{t("Sign in again")}</button>
        )}
        {young ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={add}>{t("Add|account pc")}</button>
            <button type="button" className="btn" disabled={busy} onClick={remove}>{t("No|account pc")}</button>
          </>
        ) : <button type="button" className="btn" disabled={busy} onClick={remove}>{ranOut ? t("No|account pc") : t("Remove from my account")}</button>}
      </div>
    </div>
  );
}
