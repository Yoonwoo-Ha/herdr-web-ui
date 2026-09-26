/**
 * Who a request is and whether it gets in. There is no user database: a request is trusted
 * for where it comes from (this PC, with no proxy in front), for who Tailscale says it is
 * (the PC's own login, which `tailscale serve` states in a header it strips from what it
 * receives), or for what it holds (a paired device's cookie, or the shared token). A token,
 * when one is configured, gates everything, this PC included: the remote-PC bridge runs on
 * a loopback port of a PC other people may use. Without a token, and until the first device is
 * paired, anything that reaches the server is let in as it always was.
 */
import type { AccessRefusal, AccessVia, DeviceRole } from "../shared/protocol.ts";
import type { DeviceMatch } from "./devices.ts";

export interface AccessInput {
  /** the connection came from this machine: 127/8, ::1 or their IPv4-mapped forms */
  loopback: boolean;
  /** a proxy in front added X-Forwarded-For (tailscale serve does, so does any reverse proxy) */
  forwarded: boolean;
  /** Tailscale-Funnel-Request: the request came from the public internet through Funnel */
  funnel: boolean;
  /** Tailscale-User-Login: set by tailscale serve for a person's device, absent for tagged nodes */
  tailscaleLogin: string | null;
  /** the shared token matched (cookie or bearer) */
  tokenMatched: boolean;
  /** the device the cookie belongs to */
  device: DeviceMatch | null;
  /** the PC's own Tailscale login, when known */
  owner: string | null;
  tokenConfigured: boolean;
  /** a device has been paired at some point: the gate is closed to strangers (server/devices.ts) */
  gated: boolean;
}

export type Access =
  | { level: "full"; via: AccessVia; role: DeviceRole; device?: DeviceMatch; login?: string }
  | { level: "none"; reason: AccessRefusal };

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export function decideAccess(input: AccessInput): Access {
  if (input.tokenMatched) return { level: "full", via: "token", role: "drive" };
  if (input.device !== null) return { level: "full", via: "device", role: input.device.role, device: input.device };
  // the identity header is only worth something from the local tailscaled, never from a LAN client
  if (input.loopback && input.tailscaleLogin !== null && input.owner !== null) {
    if (input.tailscaleLogin.toLowerCase() === input.owner.toLowerCase()) return { level: "full", via: "tailscale", role: "drive", login: input.tailscaleLogin };
    return { level: "none", reason: "other_user" };
  }
  if (input.tokenConfigured) return { level: "none", reason: "token_required" };
  if (input.loopback && !input.forwarded) return { level: "full", via: "local", role: "drive" };
  // the public internet is never "open", whatever is paired
  if (!input.gated && !input.funnel) return { level: "full", via: "open", role: "drive" };
  return { level: "none", reason: "pairing_required" };
}
