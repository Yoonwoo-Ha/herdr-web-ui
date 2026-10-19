// Shared by the app's own pages: the native plugin (ios/App/App/HerdrShellPlugin.swift) and
// what an address typed or scanned becomes.

/** Calls the native HerdrShell plugin through Capacitor's bridge. */
export function shell(method, options = {}) {
  return window.Capacitor.nativePromise("HerdrShell", method, options);
}

/**
 * What the user typed or scanned, as the URL to open, or null. A missing scheme becomes
 * http for an IPv4 address (a tailnet or LAN IP, served plain) and https for a name.
 * A pairing link (`?pair=CODE`, the PC's QR code) keeps its code.
 */
export function parseAddress(text) {
  let value = String(text).trim();
  if (value === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value) ? "http://" : "https://") + value;
  let url;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
  return url;
}
