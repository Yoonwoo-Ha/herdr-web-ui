import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RelayStatus } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SettingsQuery, settingsQueryWords } from "./SettingsControls.tsx";
import type { RelayState } from "../lib/useRelay.ts";
import { failureText, RelayDirectRow, statusText } from "./RelayPanel.tsx";

const t = ((text: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text)) as Parameters<typeof statusText>[0];
const base: RelayStatus = { phase: "online", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: null, error: null };

test("the relay row says when Ovis's relay needs an account, and nothing new otherwise", () => {
  expect(statusText(t, base)).toBe("Online. No phone connected.");
  expect(statusText(t, { ...base, pass: { state: "ok", relay: "ok", enforce_at: null, refused: false } })).toBe("Online. No phone connected.");
  expect(statusText(t, { ...base, phase: "error", error: "The Ovis relay needs a signed-in account (relay pass required).", pass: { state: "no_account", relay: null, enforce_at: null, refused: true } }))
    .toBe("The Ovis relay needs an Ovis account. Sign in, or connect over the same Wi-Fi or Tailscale.");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "limit", relay: null, enforce_at: null, refused: true } })).toStartWith("This account has as many PCs");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "unavailable", relay: null, enforce_at: null, refused: true } })).toBe("Cannot reach the Ovis account service for a relay pass. Retrying.");
  expect(statusText(t, { ...base, pass: { state: "no_account", relay: "missing", enforce_at: "2027-01-01T00:00:00.000Z", refused: false } })).toStartWith("Online. Sign in to keep using the Ovis relay after ");
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "no_account", relay: null, enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "unavailable", relay: null, enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "not_listed", relay: null, enforce_at: null, refused: true } })).toStartWith("Add this PC to your Ovis account");
  expect(statusText(t, { ...base, phase: "error", error: "x", pass: { state: "ok", relay: null, enforce_at: null, refused: true } })).toBe("Error: x");
  expect(statusText(t, { ...base, pass: { state: "ok", relay: "missing", enforce_at: "2027-01-01T00:00:00.000Z", refused: false } })).toBe("Online. No phone connected.");
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "ok", relay: "ok", enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
});

test("a machine's refusal to make a pairing code is said in words, and any other refusal keeps the server's own", () => {
  // a machine makes no code that names no account
  expect(failureText(new ApiError("/api/relay/offer", 409, "machine profile", "machine_profile"))).toBe("Run ovis add on this machine, then scan its QR code with a signed-in device.");
  expect(failureText(new ApiError("/api/relay/offer", 409, "This PC is already in an Ovis account.", "in_account"))).toBe("This PC is already in an Ovis account.");
});

/** the Direct connection row as Settings draws it, in `language`, under a Settings search for `query`: its name, its one line and its switch */
function directRow(direct: NonNullable<RelayStatus["direct"]>, language = "en", query = ""): { label: string; line: string; toggle: string } {
  const relay = { status: { ...base, direct }, pending: false, request: async () => ({ ...base, direct }) } as unknown as RelayState;
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: [language] });
  try {
    const row = createElement(RelayDirectRow, { relay, readOnly: false });
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(SettingsQuery.Provider, { value: settingsQueryWords(query) }, row) }));
    const text = (pattern: RegExp): string => pattern.exec(html)?.[1]?.replace(/<[^>]+>/g, "") ?? "";
    const toggle = /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";
    const name = /aria-label="([^"]*)"/.exec(toggle)?.[1];
    return { label: text(/class="settings-label">([^<]*)</), line: text(/class="(?:visually-hidden|settings-description)">([\s\S]*?)<\/span>/),
      toggle: name === undefined ? "" : `${name} ${/aria-checked="true"/.test(toggle) ? "on" : "off"}` };
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

test("the Direct connection row says what its switch does, off and on, and names the Tailscale carrier too", () => {
  expect(directRow({ on: false, carriers: [] })).toEqual({ label: "Direct connection", line: "Relay connections stay on the relay.", toggle: "Direct connection off" });
  const on = "The Ovis app on a phone that reaches this PC on the same Wi-Fi or over Tailscale moves to a direct connection: faster, and this PC listens for it on those addresses.";
  expect(directRow({ on: true, carriers: ["ws://192.168.0.10:7319"] })).toEqual({ label: "Direct connection", line: on, toggle: "Direct connection on" });
  expect(directRow({ on: true, carriers: ["ws://192.168.0.10:7319", "ws://100.64.0.7:7319"] }).line).toBe(on);
  expect(directRow({ on: true, carriers: [] }).line).toBe(on);
  expect(directRow({ on: false, carriers: [] }, "ko").label).toBe("직접 연결");
});

test("Settings search finds the Direct connection row by the networks it governs, off or on, in every language", () => {
  const found = (query: string, language = "en", on = false): boolean => directRow({ on, carriers: [] }, language, query).label !== "";
  for (const query of ["Wi-Fi", "Tailscale", "LAN", "same Wi-Fi", "home network", "direct"]) {
    expect([query, found(query)]).toEqual([query, true]);
    expect([query, found(query, "en", true)]).toEqual([query, true]);
  }
  for (const [language, queries] of [["ko", ["같은 Wi-Fi", "Tailscale", "LAN", "집 네트워크", "직접 연결"]], ["ja", ["同じWi-Fi", "Tailscale", "自宅ネットワーク"]], ["zh", ["同一 Wi-Fi", "Tailscale", "局域网"]]] as const) {
    for (const query of queries) expect([language, query, found(query, language)]).toEqual([language, query, true]);
  }
  expect(found("printer")).toBe(false);
});
