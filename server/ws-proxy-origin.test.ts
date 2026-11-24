import { describe, expect, it } from "bun:test";
import { sameOrigin, canSendSecret } from "./machine-security.ts";

function upgrade(headers: Record<string, string> = {}, path = "/ws", method = "GET"): Request {
  return new Request(`http://public.example${path}`, { method, headers: {
    origin: "https://public.example", "sec-fetch-site": "same-origin",
    "x-forwarded-proto": "wss", upgrade: "websocket", connection: "Upgrade", ...headers,
  } });
}

describe("Traefik secure WebSocket origin", () => {
  it("maps the forwarded wss upgrade to its https browser Origin", () => {
    expect(sameOrigin(upgrade())).toBe(true);
    expect(sameOrigin(upgrade({ upgrade: "WebSocket", connection: "keep-alive, uPgRaDe" }))).toBe(true);
    expect(sameOrigin(upgrade({ origin: "https://public.example:443" }))).toBe(true);
  });
  it("still refuses different hosts, ports, schemes, cross-site requests and forwarded-host overrides", () => {
    for (const origin of ["https://other.example", "https://public.example:8443", "http://public.example", "null"]) {
      expect(sameOrigin(upgrade({ origin }))).toBe(false);
    }
    expect(sameOrigin(upgrade({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(upgrade({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(sameOrigin(upgrade({ origin: "https://other.example", "x-forwarded-host": "other.example" }))).toBe(false);
  });
  it("accepts wss only for a real GET /ws upgrade, never unrelated HTTP requests", () => {
    expect(sameOrigin(upgrade({}, "/api/pane/close", "POST"))).toBe(false);
    expect(sameOrigin(upgrade({}, "/api/session"))).toBe(false);
    expect(sameOrigin(upgrade({}, "/ws", "POST"))).toBe(false);
    expect(sameOrigin(upgrade({ upgrade: "not-websocket" }))).toBe(false);
    expect(sameOrigin(upgrade({ connection: "keep-alive" }))).toBe(false);
    expect(sameOrigin(upgrade({ connection: "xupgrade" }))).toBe(false);
    for (const header of ["connection", "upgrade"]) {
      const request = upgrade();
      request.headers.delete(header);
      expect(sameOrigin(request)).toBe(false);
    }
    expect(sameOrigin(upgrade({ "x-forwarded-proto": "https,wss" }))).toBe(false);
    expect(sameOrigin(upgrade({ "x-forwarded-proto": "ws" }))).toBe(false);
  });
  it("preserves matching and mismatching nondefault request ports", () => {
    const headers = new Headers(upgrade().headers);
    headers.set("origin", "https://public.example:9443");
    expect(sameOrigin(new Request("http://public.example:9443/ws", { headers }))).toBe(true);
    headers.set("origin", "https://public.example:8443");
    expect(sameOrigin(new Request("http://public.example:9443/ws", { headers }))).toBe(false);
  });
  it("keeps ordinary HTTP(S) proxy checks and secret-input rules unchanged", () => {
    expect(sameOrigin(upgrade({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(sameOrigin(upgrade({ "x-forwarded-proto": "http", origin: "http://public.example" }))).toBe(true);
    expect(canSendSecret(upgrade({}, "/api/pane/secret", "POST"))).toBe(false);
  });
});

describe("the phone app's own origins", () => {
  // The hosted shell (https://app.ovis.sh) and the iOS app's own copy (capacitor://app.ovis.sh) reach a PC through the
  // relay or its direct carrier, never this server's own HTTP or WebSocket: neither is accepted here, nor any other app origin.
  it("refuses each of them on a PC's own WebSocket and its controls, as any other site", () => {
    for (const origin of ["https://app.ovis.sh", "https://app-ap.ovis.sh", "capacitor://app.ovis.sh", "capacitor://localhost", "capacitor://public.example"]) {
      const headers = { origin, "x-forwarded-proto": "", "sec-fetch-site": "" };
      expect(sameOrigin(upgrade(headers))).toBe(false);
      expect(sameOrigin(upgrade(headers, "/api/pane/close", "POST"))).toBe(false);
    }
  });
});
