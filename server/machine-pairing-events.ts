import type { Access } from "./access.ts";
import { sameBrowser } from "./devices.ts";
import type { ServerContext } from "./dispatch.ts";
import type { MachineEventDocument } from "./machine-events.ts";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import { shownTo, type JoinViewer } from "./join-notices.ts";

/** Pairing events visible to this browser's authorized machine-event document. */
export function machinePairingEvents({ services, peer }: ServerContext, access: Access, keys: readonly string[], viewer: JoinViewer): NonNullable<MachineEventDocument["pairings"]> {
  const { devices, joins, pendingRedemptions, relay } = services;
  const deviceId = access.level === "full" ? access.device?.id : undefined;
  const openAccess = access.level === "full" && access.via === "open";
  const driving = access.level === "full" && access.role === "drive" && access.via !== "open";
  return { subscribe(listener) {
    // An enrollment excludes its own device (by row, and by key: another row of the same key is that device too) and
    // asking browser. The enrollment closes the gate on the open LAN; this PC's own window is local, never open.
    const ownKey = peer.kind === "relay" ? peer.key : undefined;
    const tells = (event: DevicePairedEvent, origin: readonly string[]) => !openAccess && event.device_id !== deviceId
      && !(ownKey !== undefined && devices.relayKeyOf(event.device_id) === ownKey) && !sameBrowser(origin, keys);
    const stopPaired = devices.onPaired((event, origin) => { if (tells(event, origin)) listener(event); });
    // a join nobody has seen yet waits on the PC for the next window to open, until one window marks it seen for all: this
    // PC's own window, or a device that was here before the join (shownTo)
    for (const join of joins.waiting()) if (shownTo(join, viewer) && tells(join.event, join.origin)) listener(join.event);
    const stopSeen = openAccess ? undefined : joins.onSeen((eventId) => listener({ type: "device-paired-seen", event_id: eventId }));
    const stopRemoved = driving ? devices.onRemoved(listener) : undefined;
    // Direct approvers see the digits; drive account members on the relay get three candidates instead.
    const approver = driving && access.via !== "relay" && access.via !== "portal";
    const remoteApprover = peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
    const stopRelay = approver ? relay.approvals.subscribe((list) => listener({ type: "relay-pairings", pairings: list }))
      : remoteApprover ? relay.approvals.subscribeRemote((list) => listener({ type: "remote-pairings", pairings: list })) : undefined;
    // A window that lost the right to approve needs to clear its prompts.
    if (!approver) listener({ type: "relay-pairings", pairings: [] });
    let stopPending: (() => void) | undefined;
    if (driving && pendingRedemptions !== undefined) {
      // Approval stays on the PC's screen. Read before registering: view() can itself expire keys.
      const tellPending = () => listener({ type: "pending-redemptions", pending: pendingRedemptions.view() });
      tellPending();
      stopPending = pendingRedemptions.onChange(tellPending);
    }
    return () => { stopPaired(); stopSeen?.(); stopRemoved?.(); stopRelay?.(); stopPending?.(); };
  } };
}
