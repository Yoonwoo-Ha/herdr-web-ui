import { Monitor, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { newPcNoticeClosed, newPcNoticeKey } from "../lib/account/newPcNotice.ts";
import { ACCOUNT_SIGN_OUT_EVENT, indexedAccountService, sameSignIn, SignedOutError, type DirectoryPc } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { deviceOs } from "../lib/phone.ts";
import { usePcRemoval } from "./usePcRemoval.tsx";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

const REFRESH_MS = 60_000;
const QUIET_REFRESH_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 10_000;

/**
 * a PC still in its 24 hours that was added after this device signed in (one already in the account when it joined is
 * not new to it), or one added under the first-PC exemption before this device joined (told once, with no end)
 */
type NewPc = DirectoryPc;

type Listing = { readonly session: AccountSession; readonly pcs: readonly NewPc[] };

/** When this device first signed in to `account` (ms), kept in this browser and moved only earlier; null when nothing says. */
function firstJoin(account: string, signedInAt: number | null): number | null {
  const key = `ovis:account-joined:${account}`;
  let kept = Number.NaN;
  try { kept = Number(localStorage.getItem(key) ?? Number.NaN); } catch (error) { if (!(error instanceof DOMException)) throw error; }
  const first = Number.isFinite(kept) ? (signedInAt === null ? kept : Math.min(kept, signedInAt)) : signedInAt;
  if (first !== null && first !== kept) {
    try { localStorage.setItem(key, String(first)); } catch (error) { if (!(error instanceof DOMException)) throw error; }
  }
  return first;
}

export function NewPcNotices({ enabled = true, ownWindowOf, signIn, onRemoved }: {
  /** the account's step-2 switch is on here (this PC lists account-opens-all/1): off, the list is never read */
  readonly enabled?: boolean;
  /** the PC this window is the own local window of: it added itself, so it is not told; every other window is, the relay's included */
  readonly ownWindowOf?: string | undefined;
  readonly signIn?: string | undefined;
  readonly onRemoved?: (() => void) | undefined;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  useEffect(() => {
    if (!enabled) { setListing(null); return; }
    let version = 0;
    let pending: AbortController | undefined;
    /** the last read listed a PC to tell of: only then is the list read every minute (a new one rings this device anyway) */
    let telling = false;
    /** when the list was last read: a focus or a page shown again reads it at most once a minute, unless a PC is told of */
    let readAt = Number.NEGATIVE_INFINITY;
    /** when the sign-in read last was made (GET /v1/session), read once per sign-in; null when the service does not say */
    let joined: { readonly sign_in_id: string | undefined; readonly at: number | null } | undefined;
    const read = async () => {
      readAt = Date.now();
      const mine = ++version;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const session = await indexedAccountService.session();
        if (mine !== version) return;
        if (session === undefined) { setListing(null); return; }
        setListing((prior) => prior !== null && sameSignIn(prior.session, session) ? prior : null);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
        const directory = indexedAccountService.forSignIn(session);
        const [pcs, signedInAt] = await Promise.all([
          directory.listPcs(signal),
          joined !== undefined && joined.sign_in_id === session.sign_in_id ? joined.at : directory.signedInAt(signal),
        ]);
        // this device joined the account at its first sign-in to it, kept here: a later sign-in (Sign in again to remove a PC
        // leaves a browser for the provider and comes back signed in anew) leaves the PCs it was told of told
        const joinedAt = firstJoin(session.account, signedInAt);
        joined = { sign_in_id: session.sign_in_id, at: signedInAt };
        const current = await indexedAccountService.session();
        if (mine !== version) return;
        const now = Date.now();
        // a service that does not say when this device signed in leaves every new PC told, as before
        const addedSinceJoin = (pc: NewPc): boolean => joinedAt === null || pc.admitted_at === null || !(Date.parse(pc.admitted_at) < joinedAt);
        const told = pcs.filter((pc) => pc.admitted_before_you || (pc.new_until !== null && Date.parse(pc.new_until) > now && addedSinceJoin(pc)));
        // a notice this device already closed is nothing left to tell
        telling = told.some((pc) => pc.server_id !== ownWindowOf && !newPcNoticeClosed(newPcNoticeKey(session.account, pc)));
        setListing(current !== undefined && sameSignIn(current, session) ? { session, pcs: told } : null);
      } catch (error) {
        if (mine !== version) return;
        if (error instanceof SignedOutError) setListing(null);
        else if (error instanceof Error) console.warn("Ovis: new PCs could not be read", error.name);
        else throw error;
      }
    };
    const visibleRead = () => { if (document.visibilityState === "visible") void read(); };
    const focusRead = () => { if (telling || Date.now() - readAt >= REFRESH_MS) visibleRead(); };
    const signInChanged = () => { setListing(null); void read(); };
    signInChanged();
    // every minute while a PC is told of; otherwise every QUIET_REFRESH_MS, so a page left open hears of a new PC anyway
    const timer = setInterval(() => { if (telling || Date.now() - readAt >= QUIET_REFRESH_MS) visibleRead(); }, REFRESH_MS);
    document.addEventListener("visibilitychange", focusRead);
    window.addEventListener("focus", focusRead);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    return () => {
      version++;
      pending?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", focusRead);
      window.removeEventListener("focus", focusRead);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
      window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    };
  }, [signIn, enabled, ownWindowOf]);

  if (listing === null) return null;
  return listing.pcs.filter((pc) => pc.server_id !== ownWindowOf).map((pc) => {
    const dismissalKey = newPcNoticeKey(listing.session.account, pc);
    return <NewPcNotice key={`${listing.session.sign_in_id}:${dismissalKey}`} pc={pc} session={listing.session} dismissalKey={dismissalKey} onRemoved={onRemoved} />;
  });
}

export function NewPcNotice({ pc, session, dismissalKey, onRemoved }: {
  readonly pc: NewPc;
  readonly session: AccountSession;
  readonly dismissalKey: string;
  readonly onRemoved?: (() => void) | undefined;
}) {
  const t = useT();
  const expiresAt = pc.admitted_before_you ? Number.POSITIVE_INFINITY : Date.parse(pc.new_until ?? "");
  const [hidden, setHidden] = useState(() => newPcNoticeClosed(dismissalKey));
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const removal = usePcRemoval(indexedAccountService, () => {
    setHidden(true);
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    onRemoved?.();
  });
  useEffect(() => {
    if (hidden || !Number.isFinite(expiresAt)) return;
    // The directory can only issue a 24-hour mark. Cap the timer even if an invalid service sends a date farther out.
    const timer = setTimeout(() => setHidden(true), Math.max(0, Math.min(86_400_000, expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [expiresAt, hidden]);

  if (hidden || !(expiresAt > Date.now())) return null;
  const remove = async () => {
    if (inFlight.current || !(expiresAt > Date.now())) return;
    inFlight.current = true;
    setSending(true);
    setFailed(false);
    try {
      await removal.remove(session, pc.server_id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setFailed(true);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  /** told once on this device, per PC and admission: closed, or answered Yes */
  const close = () => {
    setHidden(true);
    try { localStorage.setItem(dismissalKey, "1"); }
    catch (error) { if (!(error instanceof DOMException)) throw error; }
  };
  const failure = failed && <span className="account-error" role="alert">{t("The PC could not be removed. Try again.")}</span>;
  if (pc.admitted_before_you) {
    // #29: added before this device joined, asked once in the main area by name; never a row in the sidebar
    const os = deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0);
    const phone = os === "android" || os === "ios";
    return (
      <div className="update-notice is-paired device-notice" role="status" data-before-you-pc={pc.server_id}>
        <Monitor aria-hidden="true" />
        <span className="device-notice-text">
          <span>{phone ? t("{name} was added to your account before this phone joined. Did you add it?", { name: pc.label })
            : t("{name} was added to your account before this device joined. Did you add it?", { name: pc.label })}</span>
          {failure}
          {removal.prompt}
        </span>
        <div className="device-paired-actions">
          <button type="button" className="btn" disabled={sending} onClick={close}>{t("Yes|account pc")}</button>
          <button type="button" className="btn" disabled={sending} onClick={remove}>{t("No (remove)|account pc")}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="update-notice is-paired device-notice" role="status">
      <Monitor aria-hidden="true" />
      <span className="device-notice-text">
        <span>{t("New PC added to your account: {name}", { name: pc.label })}</span>
        <span className="settings-hint">{t("If you did not add it, remove it.")}</span>
        {failure}
        {removal.prompt}
      </span>
      <div className="device-paired-actions">
        <button type="button" className="btn" disabled={sending} onClick={remove}>{t("I didn't add this")}</button>
        <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Close")} title={t("Close")} onClick={close}><X aria-hidden="true" /></button>
      </div>
    </div>
  );
}
