/**
 * Ovis's own relay endpoints. A PC that names no relay of its own stays connected to the global
 * one and, when a regional one answers much faster, also to that one and puts it in new pairing
 * offers (server/relay/service.ts). A phone whose saved relay is one of the regional ones falls
 * back to the global one when it cannot get through (src/lib/relay/transport.ts). The browser
 * imports this file, so it reads no environment.
 */
export const GLOBAL_RELAY = "wss://relay.ovis.sh";

export const REGIONAL_RELAYS: readonly string[] = ["wss://relay-ap.ovis.sh"];

/** The relay to try when `relay` does not get through, or null: only Ovis's regional relays fall back. */
export function relayFallback(relay: string, regional: readonly string[] = REGIONAL_RELAYS): string | null {
  return regional.includes(relay) ? GLOBAL_RELAY : null;
}

/**
 * The relay a phone saves for a PC that named `hints` in AUTH_OK (the preferred one first): only
 * one of Ovis's own relays, and only in place of one of Ovis's own, so a self-hosted relay is never
 * traded and a PC can only move its phones between Ovis's relays.
 */
export function hintedRelay(saved: string, hints: readonly string[] | undefined, regional: readonly string[] = REGIONAL_RELAYS): string {
  const ours = (relay: string): boolean => relay === GLOBAL_RELAY || regional.includes(relay);
  const preferred = hints?.[0];
  return preferred !== undefined && ours(saved) && ours(preferred) ? preferred : saved;
}
