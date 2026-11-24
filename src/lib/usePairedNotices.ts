import { useCallback, useEffect, useRef, useState } from "react";
import { markJoinSeen } from "./api.ts";
import { browserStorage } from "./firstHints.ts";
import { hiddenJoins, hideJoin } from "./pairedNotices.ts";
import type { DevicePairedEvent, DeviceRemovedEvent, PendingKey, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";

/** `watching`: this window may only watch, so it hides a join for itself instead of marking it seen on the PC. */
export function usePairedNotices(pendingAccess: boolean | undefined, watching = false) {
  const [pairedNotices, setPairedNotices] = useState<readonly DevicePairedEvent[]>([]);
  const [hiddenHere, setHiddenHere] = useState(() => hiddenJoins(browserStorage()));
  const [relayPairings, setRelayPairings] = useState<readonly RelayPairingRequest[]>([]);
  /** devices asking to join the account through this PC, for this device to approve as a member (components/AccountApprovals.tsx) */
  const [remotePairings, setRemotePairings] = useState<readonly RemotePairingRequest[]>([]);
  const [removedNotices, setRemovedNotices] = useState<readonly DeviceRemovedEvent[]>([]);
  /** devices waiting for this PC's screen (S2-34) */
  const [pendingKeys, keepPendingKeys] = useState<readonly PendingKey[]>([]);
  const access = useRef(pendingAccess);
  access.current = pendingAccess;
  // A roster event can beat the first health read. Keep it masked until drive access is confirmed.
  const setPendingKeys = useCallback((pending: readonly PendingKey[]) => {
    if (access.current !== false) keepPendingKeys(pending);
  }, []);
  const clearPendingKeys = useCallback(() => keepPendingKeys((current) => current.length === 0 ? current : []), []);
  useEffect(() => {
    if (pendingAccess === false) clearPendingKeys();
  }, [pendingAccess, clearPendingKeys]);
  const dismissRemovedNotice = useCallback((event: DeviceRemovedEvent) => setRemovedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  // seen here is seen in every window of the PC; a watching window may not mark it, so it hides it for itself, for good
  const dismissPairedNotice = useCallback((event: DevicePairedEvent) => {
    setPairedNotices((list) => list.filter((item) => item.event_id !== event.event_id));
    if (watching) { setHiddenHere(hideJoin(browserStorage(), event.event_id)); return; }
    markJoinSeen(event.event_id).catch((error: unknown) => console.warn("Ovis: the join could not be marked seen on the PC", error instanceof Error ? error.message : error));
  }, [watching]);
  return { pairedNotices: pairedNotices.filter((event) => !hiddenHere.has(event.event_id)), setPairedNotices, dismissPairedNotice, relayPairings, setRelayPairings, remotePairings, setRemotePairings, removedNotices, setRemovedNotices, dismissRemovedNotice, pendingKeys: pendingAccess === true ? pendingKeys : [], setPendingKeys, clearPendingKeys };
}
