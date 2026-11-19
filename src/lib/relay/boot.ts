import "../../components/SheepMascot.css";

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppCrash } from "../../components/AppCrash.tsx";
import { moveQueryToFragment } from "../pageQuery.ts";
import { loadRelayShell } from "../relay.ts";
import { SHEEP_FOR } from "./sheepBadges.ts";

interface Page {
  location: { href: string; pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
}

/**
 * The offer travels in the fragment, which no request carries; taking it off the address before anything else runs keeps it out of the history entry, a bookmark, a shared tab and a screenshot of the
 * address bar, and a reload then lands on the saved PC instead of pairing again. What the page
 * shows rides in the fragment too (lib/pageQuery.ts) and stays; a query from an address made
 * before that reached the host with the page's load, and is moved into the fragment (in place of
 * any other fragment, as pageSearch reads it) so no later request carries it.
 */
export function takeEntryUrl(page: Page): string {
  const { href, pathname, search, hash } = page.location;
  // a sign-in's return (`#code=…&state=…`, account/signin.ts) leaves with the offer: its code is a credential too
  const kept = search.length > 1 ? `#${search.slice(1)}` : hash.startsWith("#offer=") || signInFragment(hash) ? "" : hash;
  if (`${search}${hash}` !== kept) page.history.replaceState(null, "", pathname + kept);
  return href;
}

function signInFragment(hash: string): boolean {
  const fields = new URLSearchParams(hash.slice(1));
  return fields.has("state") && (fields.has("code") || fields.has("error"));
}

/**
 * The start screen while the shell loads and reads this device's pairings: once the mascot is drawn, the page's
 * loading ring gives way to it in its badge, nothing else; the shell's first screen replaces it.
 */
export function showStart(container: ParentNode, load: () => Promise<Pick<typeof import("./mascot.ts"), "playMascot" | "SMALL_BELOW_PX">> = () => import("./mascot.ts")): Promise<void> {
  const boot = container.querySelector(".boot"), ring = boot?.querySelector(".boot-spinner");
  if (!boot || !ring) return Promise.resolve();
  const badge = document.createElement("span"), sheep = document.createElement("span");
  badge.className = "sheep-badge sheep-badge-112";
  sheep.className = "sheep-mascot sheep-mascot-112";
  badge.append(sheep);
  const quiet = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  // the ring and its words stay until the sheep is there to take their place
  return load()
    .then(({ playMascot, SMALL_BELOW_PX }) => {
      if (!ring.isConnected) return;
      ring.replaceWith(badge);
      boot.classList.add("relay-start");
      playMascot(sheep, SHEEP_FOR.start, { small: 112 < SMALL_BELOW_PX, quiet });
    })
    .catch((error: unknown) => { console.warn("Ovis: the mascot was not drawn", error); });
}

export function bootRelayShell(container: HTMLElement, renderApp: () => Root, load: typeof loadRelayShell = loadRelayShell): void {
  const entryUrl = takeEntryUrl(window);
  void showStart(container);
  // an older entry of this tab's history may still hold its query: it moves as the load's did, before the app reads it
  window.addEventListener("popstate", () => { moveQueryToFragment(window); });
  void load().then(({ mountRelayShell }) => mountRelayShell({ container, entryUrl, renderApp })).catch((error: unknown) => {
    console.error("Ovis: the relay shell did not start", error);
    createRoot(container).render(createElement(AppCrash, { error }));
  });
}
