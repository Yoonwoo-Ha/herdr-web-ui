import { describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import type { SshCandidate } from "./api.ts";
import { reachablePcs, reachableState, type ReachableFacts } from "./reachablePcs.ts";

const config = (name: string, detail: string | null, tailnet?: string, reach: { user?: string | null; port?: number } = {}): SshCandidate =>
  ({ name, destination: name, detail, source: "ssh_config", ...(tailnet === undefined ? {} : { tailnet }), ...reach });
const peer = (dnsName: string): SshCandidate => ({ name: dnsName.split(".")[0]!, destination: dnsName, detail: dnsName, source: "tailscale", tailnet: dnsName });
const shape = (rows: ReturnType<typeof reachablePcs>) => rows.map(({ name, way, address, destination, machine }) => ({ name, way, address, destination, machine: machine === true }));

describe("reachablePcs", () => {
  it("makes one row of the aliases that reach one Tailscale PC the same way, under its machine name, showing what it opens", () => {
    const rows = reachablePcs([
      config("mymac", "devswha@100.64.0.7", "macbookpro.tail0000.ts.net", { user: "devswha" }),
      config("hosthatch", "root@hosthatch", undefined, { user: "root" }),
      config("macbook", "devswha@macbookpro.tail0000.ts.net", "macbookpro.tail0000.ts.net", { user: "devswha" }),
      peer("old-desktop.tail0000.ts.net"),
    ]);
    expect(shape(rows)).toEqual([
      // the first alias in config order opens it; the dim text says which, and as whom, before the press
      { name: "macbookpro", way: "tailscale", address: "mymac · devswha@macbookpro.tail0000.ts.net", destination: "mymac", machine: true },
      { name: "hosthatch", way: "ssh_config", address: "root@hosthatch", destination: "hosthatch", machine: false },
      { name: "old-desktop", way: "tailscale", address: "old-desktop.tail0000.ts.net", destination: "old-desktop.tail0000.ts.net", machine: true },
    ]);
    expect(rows[0]!.found.map((pc) => pc.name)).toEqual(["mymac", "macbook"]);
  });

  it("opens a folded row by the alias named as the machine when there is one, else by the first in config order", () => {
    const [row] = reachablePcs([config("mymac", null, "macbookpro.ts.net"), config("MacBookPro", null, "macbookpro.ts.net")]);
    expect(row).toMatchObject({ name: "macbookpro", destination: "MacBookPro", address: "macbookpro.ts.net" });
    const [first] = reachablePcs([config("b-mac", null, "macbookpro.ts.net"), config("a-mac", null, "macbookpro.ts.net")]);
    expect(first).toMatchObject({ destination: "b-mac", address: "b-mac · macbookpro.ts.net" });
  });

  it("keeps an alias on another port a row of its own, by its alias, so the PC's own row still opens the PC (an sshd in WSL)", () => {
    const rows = reachablePcs([
      config("winvm-wsl", "rise@winvm.ts.net", "winvm.ts.net", { user: "rise", port: 2222 }),
      config("winvm", "rise@winvm.ts.net", "winvm.ts.net", { user: "rise", port: 22 }),
    ]);
    expect(shape(rows)).toEqual([
      { name: "winvm-wsl", way: "tailscale", address: "rise@winvm.ts.net:2222", destination: "winvm-wsl", machine: false },
      { name: "winvm", way: "tailscale", address: "rise@winvm.ts.net", destination: "winvm", machine: true },
    ]);
  });

  it("keeps aliases of one PC with different users apart, each by its alias, and names neither the machine", () => {
    const rows = reachablePcs([
      config("mac-root", "root@macbookpro.ts.net", "macbookpro.ts.net", { user: "root" }),
      config("mymac", "devswha@macbookpro.ts.net", "macbookpro.ts.net", { user: "devswha" }),
    ]);
    expect(shape(rows)).toEqual([
      { name: "mac-root", way: "tailscale", address: "root@macbookpro.ts.net", destination: "mac-root", machine: false },
      { name: "mymac", way: "tailscale", address: "devswha@macbookpro.ts.net", destination: "mymac", machine: false },
    ]);
  });

  it("folds nothing whose User a Match may set: it is not known to be the same way in", () => {
    const rows = reachablePcs([config("box", null, "box.ts.net", { user: null }), peer("box.ts.net")]);
    expect(shape(rows)).toEqual([
      { name: "box", way: "tailscale", address: "box.ts.net", destination: "box", machine: false },
      { name: "box", way: "tailscale", address: "box.ts.net", destination: "box.ts.net", machine: true },
    ]);
  });

  it("never merges by name: two hosts of one HostName stay two rows, a port beside the address", () => {
    const rows = reachablePcs([config("vm1", "me@localhost", undefined, { port: 2201 }), config("vm2", "me@localhost", undefined, { port: 2202 }), config("desk", null)]);
    expect(rows.map((row) => [row.name, row.address])).toEqual([["vm1", "me@localhost:2201"], ["vm2", "me@localhost:2202"], ["desk", "desk"]]);
  });

  it("keeps two Tailscale PCs of one machine name apart: the resolved MagicDNS name decides", () => {
    const rows = reachablePcs([peer("box.tail0000.ts.net"), peer("box.tail1111.ts.net")]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});

describe("reachableState", () => {
  const ssh = (destination: string, extra: Partial<Machine> = {}): Machine => ({ id: destination, name: destination, kind: "ssh", target: { destination }, enabled: true, state: "connected", error: null, snapshot: null, ...extra } as Machine);
  const relayPc = (serverId: string): Machine => ({ id: serverId, name: serverId, kind: "relay", relay: { server_id: serverId, relay: "wss://relay.test" }, enabled: true, state: "connected", error: null, snapshot: null } as Machine);
  const [mac] = reachablePcs([config("mymac", null, "macbookpro.ts.net"), config("macbook", null, "macbookpro.ts.net")]);
  const [hosthatch] = reachablePcs([config("hosthatch", "root@hosthatch")]);
  const facts = (extra: Partial<ReachableFacts> = {}): ReachableFacts => ({ machines: [], tailnet: { read: true, pcs: new Map() }, ...extra });

  it("is added when this app has a PC at any of its addresses, as Add would add it", () => {
    expect(reachableState(mac!, facts({ machines: [ssh("macbook")] }))).toBe("added");
    expect(reachableState(mac!, facts({ machines: [ssh("macbook", { target: { destination: "macbook", port: 2222 } })] }))).toBe("open");
    expect(reachableState(mac!, facts({ machines: [ssh("macbook", { target: { destination: "macbook", session: "work" } })] }))).toBe("open");
  });

  it("waits for the Tailscale PCs' Ovis to be known, then says an older one needs updating", () => {
    expect(reachableState(mac!, facts({ tailnet: { read: false, pcs: new Map() } }))).toBe("waiting");
    expect(reachableState(mac!, facts({ tailnet: { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: true, server_id: null }]]) } }))).toBe("outdated");
    // a config host off the tailnet waits for nothing
    expect(reachableState(hosthatch!, facts({ tailnet: { read: false, pcs: new Map() } }))).toBe("open");
  });

  it("with the account's PCs given, says in-account by the PC's relay ID, from its Tailscale answer or from this app's PC at that address", () => {
    const probed = { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: false, server_id: "srv_mac" }]]) };
    expect(reachableState(mac!, facts({ tailnet: probed, accountPcs: new Set(["srv_mac"]) }))).toBe("in-account");
    expect(reachableState(mac!, facts({ tailnet: probed, accountPcs: new Set(["srv_other"]) }))).toBe("open");
    expect(reachableState(hosthatch!, facts({ machines: [ssh("hosthatch", { server_id: "srv_hh" })], accountPcs: new Set(["srv_hh"]) }))).toBe("in-account");
    expect(reachableState(hosthatch!, facts({ machines: [ssh("hosthatch", { server_id: "srv_hh" })], accountPcs: new Set() }))).toBe("added");
    // a PC this app already has through the relay is not added a second time over SSH
    expect(reachableState(mac!, facts({ tailnet: probed, machines: [relayPc("srv_mac")], accountPcs: new Set() }))).toBe("added");
    // in the account comes first: an older Ovis there needs no update to be in it
    const old = { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: true, server_id: "srv_mac" }]]) };
    expect(reachableState(mac!, facts({ tailnet: old, accountPcs: new Set(["srv_mac"]) }))).toBe("in-account");
  });

  it("gives the PC's own Tailscale answer only to the row that is the PC reached the plain way, and each row only its own aliases' PCs", () => {
    const [wsl, winvm] = reachablePcs([config("winvm-wsl", null, "winvm.ts.net", { port: 2222 }), config("winvm", null, "winvm.ts.net")]);
    const probed = { read: false, pcs: new Map([["winvm.ts.net", { outdated: true, server_id: "srv_win" }]]) };
    // the sshd on 2222 is another Ovis, if any: neither waits on the PC's answer nor takes it
    expect(reachableState(wsl!, facts({ tailnet: probed, accountPcs: new Set(["srv_win"]) }))).toBe("open");
    expect(reachableState(winvm!, facts({ tailnet: { ...probed, read: true }, accountPcs: new Set(["srv_win"]) }))).toBe("in-account");
    // this app's PC at the WSL alias marks that row, not the PC's own
    expect(reachableState(wsl!, facts({ machines: [ssh("winvm-wsl")] }))).toBe("added");
    expect(reachableState(winvm!, facts({ machines: [ssh("winvm-wsl")] }))).toBe("open");
  });

  it("without the account's PCs (the Tailscale tab) keeps to what this app has at that address", () => {
    const probed = { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: false, server_id: "srv_mac" }]]) };
    expect(reachableState(mac!, facts({ tailnet: probed, machines: [relayPc("srv_mac")] }))).toBe("open");
  });
});
