/** A way of Add a connection (ConnectPhoneDialog's tabs). */
export type AddConnectionTab = "relay" | "tailscale" | "ssh";

export const ADD_CONNECTION_EVENT = "ovis:add-connection";

let asked: AddConnectionTab | null = null;

/**
 * Asks Settings → Devices and PCs to open Add a connection on `tab` (the setup checklist's Connect your phone): kept
 * until Settings takes it, so a page that opens only after this still opens the dialog.
 */
export function askAddConnection(tab: AddConnectionTab): void {
  asked = tab;
  window.dispatchEvent(new Event(ADD_CONNECTION_EVENT));
}

/** The tab Add a connection was asked to open on, taken once; null when nothing asked. */
export function takeAddConnection(): AddConnectionTab | null {
  const tab = asked;
  asked = null;
  return tab;
}
