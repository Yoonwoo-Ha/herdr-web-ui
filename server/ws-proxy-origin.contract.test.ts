import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerInstance } from "./index.ts";

/** An isolated bridge with the request headers Traefik forwards after TLS termination. */
describe("secure WebSocket proxy origin contract", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-wss-origin-"));
  let bridge: ServerInstance;
  beforeAll(() => { bridge = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "fixture-origin", machines: false, tailscaleOwner: null }); });
  afterAll(() => { bridge?.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  async function connect(origin: string, forwardedProto = "wss"): Promise<boolean> {
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const ws = new RuntimeSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: {
      authorization: "Bearer fixture-origin", host: "proxy.example.test", origin,
      "x-forwarded-proto": forwardedProto, "sec-fetch-site": "same-origin",
    } });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("upgrade did not settle within 5 seconds")), 5_000);
        ws.addEventListener("open", () => { clearTimeout(deadline); resolve(true); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(deadline); resolve(false); }, { once: true });
      });
    } finally { ws.close(); }
  }

  it("upgrades the same HTTPS browser Origin behind Traefik, with no terminal attach", async () => {
    expect(await connect("https://proxy.example.test")).toBe(true);
    expect(await connect("https://proxy.example.test", "https")).toBe(true);
  });
  it("still refuses cross-origin hosts, nonmatching ports and plaintext browser Origins", async () => {
    expect(await connect("https://other.example.test")).toBe(false);
    expect(await connect("https://proxy.example.test:8443")).toBe(false);
    expect(await connect("http://proxy.example.test")).toBe(false);
  });
});
