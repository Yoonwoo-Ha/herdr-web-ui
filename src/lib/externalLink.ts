/**
 * The one way the client opens an address outside the app: a link to click (`ExternalLink`), an
 * address opened from code (`openExternal`) and a tab held in a click for a sign-in (`reserveTab`).
 * The shell decides which browser shows it (a tab here; the system browser in the apps). `kind`
 * names what the address is, for the place that will route it: `link` a page on the web,
 * `sign-in` a sign-in page, `ovis` an Ovis page (another PC's, a file in a tab of its own).
 * Nothing reads it yet. src/conventions.test.ts keeps every other file off target="_blank" and
 * window.open.
 */
import { createElement, type AnchorHTMLAttributes, type ReactElement, type Ref } from "react";

import { inMacApp, inNativeApp } from "./nativeApp.ts";

export type ExternalLinkKind = "link" | "sign-in" | "ovis";

/**
 * Whether this page can keep a browser tab to reuse. The iOS, Android, Mac and desktop apps hand an
 * external address to the system browser, so the window they give back is never that tab.
 */
export function canReuseExternalLinkTab(): boolean {
  return !inNativeApp() && !inMacApp() && !(typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent));
}

/**
 * A URI this app opens in a new tab: an http(s) address and nothing else. Both link paths in
 * PaneTerminal answer to it, so a line crafted to look like a link cannot hand the browser a
 * scheme of its own choosing (`javascript:`, `data:`, an OS handler).
 */
export function isWebLink(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/**
 * Makes an http(s) link opener. Each instance owns at most one reusable tab. A browser lets a page
 * steer a tab of another site only as its opener, so the reused tab keeps its opener: the site in it
 * can see and navigate this tab. That is why reuse is a setting, off by default; a new tab has none.
 */
export function createWebLinkOpener(): (uri: string, reuse: boolean) => void {
  let reusable: Window | null = null;
  const newTab = (uri: string): void => {
    const link = document.createElement("a");
    link.href = uri;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.click();
  };
  return (uri, reuse) => {
    if (!reuse || !canReuseExternalLinkTab()) {
      newTab(uri);
      return;
    }
    try {
      if (reusable === null || reusable.closed) {
        reusable = window.open(uri, "_blank");
        if (reusable === null) newTab(uri);
        return;
      }
      reusable.location.href = uri;
      reusable.focus();
    } catch {
      // the browser refused to open or steer that tab (say, it no longer counts this page as its opener): a click never does nothing
      reusable = null;
      newTab(uri);
    }
  };
}

const openWebLink = createWebLinkOpener();

/**
 * Opens `url` outside the app from code. An http(s) address reuses the one external tab when
 * `reuse` (the "Reuse tab for external links" setting, for a plain click); any other address gets
 * a tab of its own, with no opener or referrer.
 */
export function openExternal(url: string, _kind: ExternalLinkKind, reuse = false): void {
  if (isWebLink(url)) openWebLink(url, reuse);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * A blank tab opened in the click itself, before anything is awaited (a tab opened later is a
 * popup the browser blocks), to send to a sign-in page once the service names it. The page it gets
 * has no handle on this one. Null when the browser blocked it. In the desktop app the blank window
 * hands the address it is sent to to the system browser (app/electron/src/main.ts, guard).
 */
export function reserveTab(): Window | null {
  const tab = window.open("about:blank", "_blank");
  if (tab !== null) tab.opener = null;
  return tab;
}

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel"> & {
  kind: ExternalLinkKind;
  /** send the page's address as the referrer: only to this app's own pages (the file viewer's) */
  referrer?: boolean;
  ref?: Ref<HTMLAnchorElement>;
};

export function ExternalLink({ kind: _kind, referrer = false, href, ...props }: ExternalLinkProps): ReactElement {
  return createElement("a", { href, target: "_blank", rel: referrer ? "noopener" : "noopener noreferrer", ...props });
}
