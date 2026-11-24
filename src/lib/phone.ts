import type { AccountOs } from "../../shared/account-asker.ts";
import type { RemoteAccess } from "../../shared/protocol.ts";
import { isTailnetAddress } from "../../shared/relay-mux.ts";
import { LOCALE_TAGS, t, translate, type Language } from "./i18n.ts";
import { inNativeApp } from "./nativeApp.ts";

export interface PageLocation {
  protocol: string;
  hostname: string;
  origin: string;
  secure: boolean;
  shell?: boolean;
}

export type PhonePlan =
  | { kind: "here"; url: string }
  | { kind: "served"; url: string }
  | { kind: "command"; command: string; url: string | null }
  | { kind: "stopped" }
  | { kind: "missing" }
  | { kind: "unknown" };

/**
 * A MagicDNS name or a Tailscale address (100.64.0.0/10, or fd7a:115c:a1e0::/48 as the phone app's own page reads it): a
 * page open at one is this PC's Tailscale address already.
 */
export function tailnetHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host.endsWith(".ts.net") || host.startsWith("fd7a:115c:a1e0:") || isTailnetAddress(host);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]" || hostname === "::1";
}

export function phonePlan(page: PageLocation, access: RemoteAccess | null): PhonePlan {
  if (page.protocol === "https:" && page.secure && !page.shell && !isLoopbackHost(page.hostname)) return { kind: "here", url: page.origin };
  return tailscalePlan(access);
}

/** What Tailscale alone offers a phone, whatever address this page is open at (Add a connection's Tailscale tab). */
export function tailscalePlan(access: RemoteAccess | null): Exclude<PhonePlan, { kind: "here" }> {
  if (access === null) return { kind: "unknown" };
  const tailscale = access.tailscale;
  if (tailscale.state !== "running") return { kind: tailscale.state };
  if (tailscale.serving_url !== null) return { kind: "served", url: tailscale.serving_url };
  if (tailscale.serve_command !== null) return { kind: "command", command: tailscale.serve_command, url: tailscale.serve_url };
  return { kind: "unknown" };
}

export function deviceOs(userAgent: string, maxTouchPoints = 0): AccountOs | null {
  const ua = userAgent;
  return /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? "ios" : /Android/.test(ua) ? "android" : /Macintosh/.test(ua) ? "macos"
    : /Windows/.test(ua) ? "windows" : /CrOS/.test(ua) ? "chromeos" : /Linux/.test(ua) ? "linux" : null;
}

/**
 * The name a device pairs under: the Ovis app as the app (`inApp`: the phone app's Capacitor bridge;
 * the Mac app says so in its user agent), since its WebView's user agent reads as Chrome on Android,
 * else the browser, then the device.
 */
export function deviceLabel(userAgent: string, maxTouchPoints = 0, inApp = false): string {
  const ua = userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
  if (inApp || /\bOvisMac\//.test(ua)) return t("Ovis app ({device})", { device });
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|Chromium\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  return browser ? `${browser} (${device})` : device;
}

const DEVICES = ["iPhone", "iPad", "Android", "Mac", "Windows", "Chromebook", "Linux", "Device"] as const;
type NamedDevice = (typeof DEVICES)[number];
const BROWSERS = ["Edge", "Firefox", "Chrome", "Safari"];
/** "Ovis app" in each language a device may have paired in */
const APP_NAMES = (Object.keys(LOCALE_TAGS) as Language[]).map((language) => translate(language, "Ovis app ({device})", { device: "" }).replace(/ \(\)$/, ""));

/**
 * The device in a name {@link deviceLabel} made, whatever language it was made in, the older "Android · Chrome" form
 * included; null for a name someone typed.
 */
export function labelDevice(label: string): NamedDevice | null {
  const known = (device: string | undefined): NamedDevice | null => DEVICES.find((each) => each === device) ?? null;
  const made = / \(([A-Za-z]+)\)$/.exec(label);
  if (made !== null) {
    const client = label.slice(0, made.index);
    return BROWSERS.includes(client) || APP_NAMES.includes(client) ? known(made[1]) : null;
  }
  const [device, browser, ...rest] = label.split(" · ");
  return rest.length === 0 && (browser === undefined || BROWSERS.includes(browser)) ? known(device) : null;
}

/** This device's {@link deviceLabel}. */
export function thisDeviceLabel(): string {
  return deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0, inNativeApp());
}

/** The `?pair=CODE` a QR code carries, taken off the address at once so it stays out of history and referrers. */
export function takePairCode(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const code = url.searchParams.get("pair") ?? "";
  if (code !== "") {
    url.searchParams.delete("pair");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }
  return code.replace(/\D/g, "").slice(0, 6);
}
