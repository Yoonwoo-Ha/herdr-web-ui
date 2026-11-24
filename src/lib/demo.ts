/**
 * Whether this page is the demo: its transport (site/demo/transport.ts), which every demo build loads before the
 * client, marks the page, so the website's, the test lane's and the phone apps' demos say so wherever they are
 * served. An address says nothing: the iOS app's own copy of the client runs at capacitor:// too.
 */
export function demoBuild(): boolean {
  return (globalThis as { __ovisDemo?: unknown }).__ovisDemo === true;
}
