import { useCallback, useState } from "react";
import type { DevicePairedEvent, RelayPairingRequest } from "../../shared/machines.ts";

/** Enrollments this window was told of and has not dismissed (components/DevicePairedNotice.tsx), and relay pairings waiting for approval (components/RelayPairingPrompt.tsx). */
export function usePairedNotices() {
  const [pairedNotices, setPairedNotices] = useState<readonly DevicePairedEvent[]>([]);
  const [relayPairings, setRelayPairings] = useState<readonly RelayPairingRequest[]>([]);
  const dismissPairedNotice = useCallback((event: DevicePairedEvent) => setPairedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  return { pairedNotices, setPairedNotices, dismissPairedNotice, relayPairings, setRelayPairings };
}
