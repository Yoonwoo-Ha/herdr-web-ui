// navigator.serviceWorker only exists in secure
// contexts (https:// or localhost), so on a plain http:// LAN/tailnet IP this
// silently does nothing and the app still works uncached.
// In the hosted shell each PC's page registers the worker under its own scope
// (lib/shellMode.ts shellServiceWorker), and the shell's front page registers none.
// The phone app's own copy of the client (lib/appShell.ts) registers none, and retires
// the ones a hosted build left at once, before a PC's page can open under one.
import { appShell } from "./lib/appShell.ts";
import { retireServiceWorkers, shellMode, shellServiceWorker } from "./lib/shellMode.ts";

const bundled = appShell() !== null;
if (bundled && "serviceWorker" in navigator) {
  const reloaded = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
  retireServiceWorkers(navigator.serviceWorker, typeof caches === "undefined" ? null : caches, () => window.location.reload(), reloaded).catch((err: unknown) => {
    console.warn("the hosted app's service workers were not removed", err);
  });
}

window.addEventListener("load", () => {
  if (bundled || !("serviceWorker" in navigator)) return;
  const worker = shellMode() === "relay" ? shellServiceWorker(window.location.pathname) : { script: "/sw.js", scope: "/" };
  if (worker === null) return;
  navigator.serviceWorker.register(worker.script, { scope: worker.scope }).catch((err) => {
    console.warn("service worker registration failed", err);
  });
});
