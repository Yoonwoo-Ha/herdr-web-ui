import { useSyncExternalStore } from "react";
import { inNativeApp } from "./nativeApp.ts";
import { paneLifetimes } from "./paneLifetime.ts";

interface RestorablePage extends Pick<EventTarget, "addEventListener"> {
  readonly location: { reload(): void };
}

/** How many times the reload waited because storage refused the page's unsent text: 0, none waits. */
let refusals = 0;
let again: (() => void) | null = null;
const watching = new Set<() => void>();
function setRefusals(next: number): void { refusals = next; for (const watch of [...watching]) watch(); }

/**
 * A page WebKit kept whole in its back/forward cache and shows again (pageshow, persisted): in the phone app nothing it
 * waits on will come, whatever its sockets say, because Capacitor drops every native listener as a navigation starts
 * (WebViewDelegationHandler → CapacitorBridge.reset) and OvisDirect closes the page's direct sockets as it is left. So it
 * loads again, once what it holds in memory alone is in storage (`handOver`, PaneLifetimes.carry, as when the app
 * replaces a page) or it holds none. When storage refuses it, the page stays as it is, its text in its fields, and waits
 * for the person (restoreHeld, retryRestore). In a browser the transports reconnect in place (lib/ws.ts,
 * lib/relay/transport.ts).
 */
export function reloadRestoredAppPage(page: RestorablePage = window, native: () => boolean = inNativeApp, handOver: () => boolean = () => paneLifetimes.carry()): void {
  const reload = (): void => {
    if (!handOver()) { setRefusals(refusals + 1); return; }
    again = null;
    setRefusals(0);
    page.location.reload();
  };
  page.addEventListener("pageshow", (event) => {
    if ((event as { persisted?: unknown }).persisted !== true || !native()) return;
    again = reload;
    reload();
  });
}

/** How many times this page's reload waited for its unsent text (0: it does not wait). */
export function restoreHeld(): number { return refusals; }

/** Tries the waiting reload again: it goes ahead once the unsent text is in storage, or gone from the page. */
export function retryRestore(): void { again?.(); }

/** restoreHeld, as it changes. */
export function useRestoreHeld(): number {
  return useSyncExternalStore((listener) => { watching.add(listener); return () => { watching.delete(listener); }; }, restoreHeld, () => 0);
}
