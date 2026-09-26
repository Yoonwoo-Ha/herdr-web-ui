import { describe, expect, it } from "bun:test";
import { isLoopbackHost, phonePlan } from "./phone.ts";
import type { RemoteAccess } from "../../shared/protocol.ts";

const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317", secure: true };
const running = (patch: Partial<RemoteAccess["tailscale"]> = {}): RemoteAccess => ({
  port: 7317,
  tailscale: { state: "running", dns_name: "pc.example.ts.net", serving_url: null, serve_command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", serve_url: "https://pc.example.ts.net", ...patch },
});

describe("phonePlan", () => {
  it("points at this page when it is already on an HTTPS address a phone can open", () => {
    const page = { protocol: "https:", hostname: "pc.example.ts.net", origin: "https://pc.example.ts.net", secure: true };
    expect(phonePlan(page, null)).toEqual({ kind: "here", url: "https://pc.example.ts.net" });
    expect(phonePlan(page, running({ state: "missing" }))).toEqual({ kind: "here", url: "https://pc.example.ts.net" });
  });

  it("treats localhost over HTTPS and any plain-HTTP page as not reachable from a phone", () => {
    expect(phonePlan({ protocol: "https:", hostname: "localhost", origin: "https://localhost:7317", secure: true }, null)).toEqual({ kind: "unknown" });
    expect(phonePlan({ protocol: "http:", hostname: "192.168.0.10", origin: "http://192.168.0.10:7317", secure: false }, running()).kind).toBe("command");
  });

  it("shows the address Tailscale already serves, else the command", () => {
    expect(phonePlan(local, running({ serving_url: "https://pc.example.ts.net:17317", serve_command: null, serve_url: null }))).toEqual({ kind: "served", url: "https://pc.example.ts.net:17317" });
    expect(phonePlan(local, running())).toEqual({ kind: "command", command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", url: "https://pc.example.ts.net" });
    expect(phonePlan(local, running({ dns_name: null, serve_url: null }))).toEqual({ kind: "command", command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", url: null });
  });

  it("reports what is in the way", () => {
    expect(phonePlan(local, running({ state: "stopped", dns_name: null, serve_command: null, serve_url: null }))).toEqual({ kind: "stopped" });
    expect(phonePlan(local, running({ state: "missing", dns_name: null, serve_command: null, serve_url: null }))).toEqual({ kind: "missing" });
    expect(phonePlan(local, null)).toEqual({ kind: "unknown" });
    expect(phonePlan(local, running({ serve_command: null, serve_url: null }))).toEqual({ kind: "unknown" });
  });

  it("knows the loopback names", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["pc.example.ts.net", "192.168.0.10", "localhost.example.com"]) expect(isLoopbackHost(host)).toBe(false);
  });
});
