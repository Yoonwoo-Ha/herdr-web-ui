import { expect, it } from "bun:test";
import { parseTailscale } from "./tailscale.ts";

it("an existing public Funnel is not a tailnet-only Serve destination", () => {
  const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.example.ts.net." } });
  const serve = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "pc.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } } }, AllowFunnel: { "pc.example.ts.net:443": true } });
  expect(parseTailscale({ status, serve }, 7317).serving_url).toBeNull();
});
