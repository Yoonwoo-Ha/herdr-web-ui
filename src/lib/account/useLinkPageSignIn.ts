/**
 * Signing in from a button outside Settings (the relay tab of Add a connection): the sign-in starts
 * on the Ovis link page (deviceSignIn.ts, startLinkPageSignIn) in a new tab, with its code filled in,
 * and this page waits for it there. The tab is opened blank in the click itself, so no popup blocker
 * takes it, and pointed at the page once the service named it; in the desktop app that blank window
 * hands the page to the system browser (app/electron/src/main.ts, guard). A blocked tab leaves the
 * page and its code to open from here. Unmounting ends a sign-in still waiting, as Settings' does.
 * A sent tab stays open (no opener by design); after cancellation its old code never completes here.
 * The desktop app and the PC's own window sign in their own way instead (`own`): the person picks a provider here, and
 * the sign-in comes back over loopback (desktop.ts, ownWindow.ts), as an app's own sign-in.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { reserveTab } from "../externalLink.ts";
import { deviceLabel, deviceOs } from "../phone.ts";
import { holdingSessionStore } from "./deleteAccount.ts";
import { desktopAccount, desktopSignIn } from "./desktop.ts";
import { startDeviceSignIn, startLinkPageSignIn, type DeviceSignIn } from "./deviceSignIn.ts";
import { ownWindowSignIn, useOwnWindowRedirect } from "./ownWindow.ts";
import { offeredProviders, type OfferedProviders } from "./service.ts";
import { indexedAccountStore, type AccountProvider, type AccountSession } from "./store.ts";

export type LinkPageSignInState =
  | { kind: "idle" }
  | { kind: "starting" }
  /** `opened`: the page is in a tab of its own; false, the browser blocked it and only this page shows it */
  | { kind: "waiting"; started: Pick<DeviceSignIn, "provider" | "userCode" | "verificationUri" | "verificationUriComplete">; opened: boolean }
  /** an own sign-in at the provider's pages; `link`: the page the browser would not open in a tab of its own */
  | { kind: "redirecting"; link: string | null }
  | { kind: "signed-in"; session: AccountSession }
  | { kind: "failed"; error: unknown };

export interface LinkPageSignIn {
  readonly state: LinkPageSignInState;
  readonly ready: boolean;
  /** the providers to pick from for an own sign-in, null where the one button starts the link page's */
  readonly own: readonly AccountProvider[] | null;
  /** the providers the link page offers, as its copy names them */
  readonly linkPage: readonly AccountProvider[];
  readonly start: (provider?: AccountProvider) => void;
  readonly cancel: () => void;
}

export function useLinkPageSignIn(service: string, onSignedIn: (session: AccountSession) => void, onOpenAccount: () => void): LinkPageSignIn {
  const [state, setState] = useState<LinkPageSignInState>({ kind: "idle" });
  const [offer, setOffer] = useState<OfferedProviders | null>(null);
  const bridge = desktopAccount();
  const ownRedirect = useOwnWindowRedirect(bridge === null);
  const running = useRef<AbortController | null>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    let live = true;
    setOffer(null);
    void offeredProviders(service, ["github"]).then((next) => { if (live) setOffer(next); });
    return () => { live = false; };
  }, [service]);

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setState({ kind: "idle" });
  }, []);

  const own = offer === null || (bridge === null && !ownRedirect) ? null : offer.providers;
  const start = useCallback((provider?: AccountProvider) => {
    if (offer === null) return;
    if (own !== null && provider !== undefined) {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      setState({ kind: "redirecting", link: null });
      // held back until it is known not to be cancelled: a sign-in finished after Cancel is never kept
      const store = holdingSessionStore(indexedAccountStore);
      const blocked = (link: string): void => setState({ kind: "redirecting", link });
      const signing = bridge !== null ? desktopSignIn(provider, bridge, store)
        : ownRedirect ? ownWindowSignIn(provider, { service, redirect: ownRedirect, store, signal: controller.signal, blocked })
        : Promise.reject(new Error("no own sign-in here"));
      signing.then(async (session) => {
        // kept only if not cancelled, decided inside the write itself: a Cancel after it is too late and shows the sign-in
        let kept = false;
        await indexedAccountStore.update("session", (current) => { if (controller.signal.aborted) return current; kept = true; return session; });
        if (!kept) return;
        if (running.current === controller) running.current = null;
        setState({ kind: "signed-in", session });
        signedIn.current(session);
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (running.current === controller) running.current = null;
        console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
        setState({ kind: "failed", error });
      });
      return;
    }
    if (offer.page.length === 0 && offer.device.length === 0) { onOpenAccount(); return; }
    running.current?.abort();
    const tab = reserveTab();
    const controller = new AbortController();
    let sent = false;
    controller.signal.addEventListener("abort", () => { if (!sent) tab?.close(); }, { once: true });
    running.current = controller;
    setState({ kind: "starting" });
    void (async () => {
      const requester = { label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0), os: deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
      const options = { service, store: indexedAccountStore, requester };
      const fallback = offer.device[0];
      const started = fallback === undefined
        ? await startDeviceSignIn({ ...options, provider: "ovis" })
        : await startLinkPageSignIn(options, fallback);
      controller.signal.throwIfAborted();
      if (tab !== null) tab.location.href = started.verificationUriComplete ?? started.verificationUri;
      sent = true;
      setState({ kind: "waiting", started, opened: tab !== null });
      const session = await started.finish(controller.signal);
      running.current = null;
      setState({ kind: "signed-in", session });
      signedIn.current(session);
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (!sent) tab?.close();
      console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
      setState({ kind: "failed", error });
    }).finally(() => { if (running.current === controller) running.current = null; });
  }, [service, offer, own, bridge, ownRedirect, onOpenAccount]);

  return { state, ready: offer !== null && ownRedirect !== undefined, own, linkPage: offer === null ? [] : offer.page.length > 0 ? offer.page : offer.device, start, cancel };
}
