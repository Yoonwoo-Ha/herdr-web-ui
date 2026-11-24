import { useSyncExternalStore } from "react";

/**
 * Whether this device has no network at all, as the browser (or the phone app's WebView) says: only an explicit
 * `navigator.onLine === false` is offline. `true` can still be a network with no way to the internet, which the request
 * that fails then says itself.
 */
export function deviceOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function watch(changed: () => void): () => void {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  return () => {
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", changed);
  };
}

/** deviceOffline, drawn again as the browser's online and offline events say it changed. */
export function useOffline(): boolean {
  return useSyncExternalStore(watch, deviceOffline, () => false);
}
