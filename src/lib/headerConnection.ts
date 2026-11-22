import { useEffect, useState, useSyncExternalStore } from "react";
import type { Translate } from "./i18n.ts";
import { getTransport } from "./transport.ts";

/** `failed`: reconnecting has gone on RECONNECT_FAILED_AFTER_MS; the line then says why, once (connectionWord) */
export type HeaderConnection = "reconnecting" | "failed" | "connected" | null;

export interface ConnectionFacts {
  scope: string;
  reportedBy: string | null;
  connected: boolean;
  connectedBefore: boolean;
  outputStopped: boolean;
}

export interface ConnectionTrack {
  lostOn: string | null;
  recoveredOn: string | null;
  /** the loss has lasted RECONNECTING_SHOWN_AFTER_MS: shorter reconnects are never named, nor their return */
  shown: boolean;
  failed: boolean;
}

export const NO_TRACK: ConnectionTrack = { lostOn: null, recoveredOn: null, shown: false, failed: false };

export const CONNECTED_SHOWN_MS = 2000;
export const RECONNECTING_SHOWN_AFTER_MS = 1000;
export const RECONNECT_FAILED_AFTER_MS = 10_000;

const lost = (facts: ConnectionFacts): boolean => !facts.connected && facts.connectedBefore && !facts.outputStopped;

export function stepConnection(track: ConnectionTrack, facts: ConnectionFacts): ConnectionTrack {
  if (facts.reportedBy !== facts.scope) return NO_TRACK;
  if (lost(facts)) return track.lostOn === facts.scope ? track : { lostOn: facts.scope, recoveredOn: null, shown: false, failed: false };
  if (facts.connected && track.lostOn === facts.scope) return track.shown ? { lostOn: null, recoveredOn: facts.scope, shown: false, failed: false } : NO_TRACK;
  if (facts.connected && track.recoveredOn === facts.scope) return track;
  return NO_TRACK;
}

export function headerConnection(facts: ConnectionFacts, track: ConnectionTrack): HeaderConnection {
  if (facts.reportedBy !== facts.scope) return null;
  const shownLoss = track.lostOn === facts.scope && track.shown;
  if (!facts.connected) return lost(facts) && shownLoss ? track.failed ? "failed" : "reconnecting" : null;
  return track.recoveredOn === facts.scope || shownLoss ? "connected" : null;
}

/**
 * The header's one line for a connection. A failed reconnect says what the relay found: nobody there for the PC
 * (its Ovis is not running) or no relay at all.
 */
export function connectionWord(connection: Exclude<HeaderConnection, null>, t: Translate): string {
  if (connection === "connected") return t("Connected");
  if (connection === "reconnecting") return t("Reconnecting…");
  return getTransport().unreached === "pc" ? t("Turn on Ovis on the PC") : t("Can't reach the PC");
}

const noChange = (): (() => void) => () => {};
const subscribeTransport = (listener: () => void): (() => void) => getTransport().onRouteChange?.(listener) ?? noChange();
const unreachedNow = (): string | undefined => getTransport().unreached;

export function useHeaderConnection(facts: ConnectionFacts): HeaderConnection {
  const [track, setTrack] = useState<ConnectionTrack>(NO_TRACK);
  // what a reconnect found changes the failed line's words: the page draws it again
  useSyncExternalStore(subscribeTransport, unreachedNow, unreachedNow);
  const isLost = lost(facts);
  useEffect(() => {
    setTrack((previous) => stepConnection(previous, facts));
  }, [isLost, facts.connected, facts.scope, facts.reportedBy]);
  useEffect(() => {
    if (track.lostOn === null) return;
    const lostOn = track.lostOn;
    const mark = (after: Partial<ConnectionTrack>) => () => setTrack((previous) => previous.lostOn === lostOn ? { ...previous, ...after } : previous);
    const timers = [window.setTimeout(mark({ shown: true }), RECONNECTING_SHOWN_AFTER_MS), window.setTimeout(mark({ shown: true, failed: true }), RECONNECT_FAILED_AFTER_MS)];
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [track.lostOn]);
  useEffect(() => {
    if (track.recoveredOn === null) return;
    const timer = window.setTimeout(() => setTrack((previous) => ({ ...previous, recoveredOn: null })), CONNECTED_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [track.recoveredOn]);
  return headerConnection(facts, track);
}
