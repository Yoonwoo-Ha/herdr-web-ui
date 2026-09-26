import type { RemoteAccess } from "../../shared/protocol.ts";

/** What the page knows about its own address. */
export interface PageLocation {
  protocol: string;
  hostname: string;
  origin: string;
  /** window.isSecureContext */
  secure: boolean;
}

/** What Settings → Phone shows: an address to open, a command to run, or what is in the way. */
export type PhonePlan =
  /** this very page is on an HTTPS address a phone can open */
  | { kind: "here"; url: string }
  /** Tailscale on the PC already proxies this server */
  | { kind: "served"; url: string }
  /** one command on the PC publishes it; `url` is where it will be, when the DNS name is known */
  | { kind: "command"; command: string; url: string | null }
  | { kind: "stopped" }
  | { kind: "missing" }
  /** the server did not say (an older server, or the request failed) */
  | { kind: "unknown" };

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]" || hostname === "::1";
}

export function phonePlan(page: PageLocation, access: RemoteAccess | null): PhonePlan {
  if (page.protocol === "https:" && page.secure && !isLoopbackHost(page.hostname)) return { kind: "here", url: page.origin };
  if (access === null) return { kind: "unknown" };
  const tailscale = access.tailscale;
  if (tailscale.state !== "running") return { kind: tailscale.state };
  if (tailscale.serving_url !== null) return { kind: "served", url: tailscale.serving_url };
  if (tailscale.serve_command !== null) return { kind: "command", command: tailscale.serve_command, url: tailscale.serve_url };
  return { kind: "unknown" };
}
