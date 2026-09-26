import { describe, expect, it } from "bun:test";
import { decideAccess, isLoopbackAddress, type AccessInput } from "./access.ts";

const device = { id: "d1", label: "Phone", role: "drive" as const };
const base: AccessInput = { loopback: true, forwarded: false, funnel: false, tailscaleLogin: null, tokenMatched: false, device: null, owner: null, tokenConfigured: false, gated: false };
const via = (input: Partial<AccessInput>) => { const a = decideAccess({ ...base, ...input }); return a.level === "full" ? a.via : `refused:${a.reason}`; };

describe("decideAccess", () => {
  it("lets this PC in without a token, but not through a proxy", () => {
    expect(via({})).toBe("local");
    expect(via({ forwarded: true, gated: true })).toBe("refused:pairing_required");
  });

  it("keeps everything open, as before, while no token and no device exist", () => {
    expect(via({ loopback: false })).toBe("open");
    expect(via({ loopback: true, forwarded: true })).toBe("open");
    expect(via({ loopback: false, gated: true })).toBe("refused:pairing_required");
  });

  it("never treats a Funnel request as open", () => {
    expect(via({ loopback: true, forwarded: true, funnel: true })).toBe("refused:pairing_required");
    expect(via({ loopback: true, forwarded: true, funnel: true, device })).toBe("device");
  });

  it("trusts the PC's own Tailscale login only from the local tailscaled", () => {
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("tailscale");
    expect(via({ forwarded: true, tailscaleLogin: "Me@Example.com", owner: "me@example.com" })).toBe("tailscale");
    expect(via({ forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com", gated: true })).toBe("refused:other_user");
    expect(via({ forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com" })).toBe("refused:other_user");
    // a LAN client can type any header: from off this machine it means nothing
    expect(via({ loopback: false, tailscaleLogin: "me@example.com", owner: "me@example.com", gated: true })).toBe("refused:pairing_required");
    // no owner known yet: the header decides nothing either way
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: null })).toBe("open");
  });

  it("a configured token gates everything, this PC included, and still admits identity and devices", () => {
    expect(via({ tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, tokenMatched: true })).toBe("token");
    expect(via({ tokenConfigured: true, device })).toBe("device");
    expect(via({ tokenConfigured: true, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("tailscale");
    expect(via({ tokenConfigured: true, forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com" })).toBe("refused:other_user");
  });

  it("a paired device gets in from anywhere, with its role", () => {
    const access = decideAccess({ ...base, loopback: false, gated: true, device: { ...device, role: "watch" } });
    expect(access).toEqual({ level: "full", via: "device", role: "watch", device: { ...device, role: "watch" } });
  });

  it("knows loopback addresses in every spelling", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ["192.168.0.10", "100.64.0.2", "::ffff:192.168.0.10", "fd7a::1"]) expect(isLoopbackAddress(address)).toBe(false);
  });
});
