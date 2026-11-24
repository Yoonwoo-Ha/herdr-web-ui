import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthAuth } from "../shared/protocol.ts";
import type { TailnetNodesAnswer } from "../shared/tailnet-nodes.ts";
import { exportAccountKey, newRecordId, signSafetyRecord, type BlockRecord } from "../shared/account-records.ts";
import { DeviceJournal } from "./account/device-journal.ts";
import { PcAccountState } from "./account/pc-binding.ts";
import { RemovalEvidence } from "./account/removal-evidence.ts";
import { SafetyLog } from "./account/safety-log.ts";
import { bounded } from "./relay/test-helpers.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { privateStateFs } from "./private-state.ts";
import { handleTailnetNodeRequest, mergeTailnetNodes, TAILNET_NODES_FILE, tailnetNodeGate, TailnetNodes } from "./tailnet-nodes.ts";
import { parseWhois, TailnetIdentitySource } from "./tailscale.ts";

const OWNER = "owner@example.com";
const STATUS = JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.example.ts.net.", UserID: 7, TailscaleIPs: ["100.100.100.100"] }, User: { "7": { LoginName: OWNER } } });
/** the owner's nodes as `tailscale whois --json` names them, by tailnet address: never the real CLI */
const NODES: Record<string, { id: string; name: string; login: string }> = {
  "100.64.0.9": { id: "nPhone1CNTRL", name: "pixel", login: OWNER },
  "100.64.0.10": { id: "nTablet2CNTRL", name: "ipad", login: OWNER },
  "100.64.0.11": { id: "nLaptop3CNTRL", name: "laptop", login: OWNER },
};
const whoisJson = (address: string) => {
  const node = NODES[address];
  return node === undefined ? null : JSON.stringify({ Node: { StableID: node.id, ComputedName: node.name, Name: `${node.name}.example.ts.net.` }, UserProfile: { LoginName: node.login } });
};
const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
const over = (address: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": address, "tailscale-user-login": OWNER, ...extra });

const dirs: string[] = [];
const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const stateDir = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `ovis-tailnet-${name}-`)); dirs.push(dir); return dir; };

function start(dir: string) {
  const server = createServer({ port: 0, stateDir: dir, tailscaleOwner: OWNER, tailnet: new TailnetIdentitySource(async () => STATUS, async (address) => whoisJson(address)) });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const auth = async (headers: Record<string, string> = {}) => ((await (await fetch(`${base}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
  const nodes = async (headers: Record<string, string> = {}) => fetch(`${base}/api/devices/tailnet-nodes`, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...guard, ...headers }, body: JSON.stringify(body) });
  /** a device paired with a code from this PC; its own credential then arrives over the tailnet from `address` */
  const pair = async (address: string) => {
    const { code } = (await (await post("/api/devices/pair/start", {})).json()) as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, accept: "application/json" }, body: JSON.stringify({ code, label: "Phone" }) });
    const { token } = (await paired.json()) as { token: string };
    const credential = { authorization: `Device ${token}` };
    expect(await auth(over(address, credential))).toMatchObject({ authenticated: true, via: "device" });
    const list = (await (await fetch(`${base}/api/devices`)).json()) as { devices: { id: string }[] };
    return { id: list.devices.at(-1)!.id, credential };
  };
  return { server, base, auth, nodes, post, pair };
}

describe("owner decision #13: a device removed on the PC stays out over Tailscale", () => {
  it("keeps a removed row's node out, asks this PC's own window, and Allow lets it in again; another node is in as today", async () => {
    const dir = stateDir("remove");
    const pc = start(dir);
    const phone = await pc.pair("100.64.0.9");
    // the row recorded the node its own credential came from
    expect(JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")).devices[0].tailnet_nodes).toEqual(["nPhone1CNTRL"]);
    expect((await fetch(`${pc.base}/api/devices/${phone.id}`, { method: "DELETE", headers: guard })).status).toBe(204);

    // the same node, by the owner's login alone: no grant, and the card names it
    expect(await pc.auth(over("100.64.0.9"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });
    expect((await fetch(`${pc.base}/api/session`, { headers: over("100.64.0.9") })).status).toBe(401);
    const card = (await (await pc.nodes()).json()) as TailnetNodesAnswer;
    expect(card.pending).toMatchObject({ id: "nPhone1CNTRL", hostname: "pixel", login: OWNER });
    expect(card.nodes.find((node) => node.id === "nPhone1CNTRL")).toMatchObject({ blocked: true, rows: [] });

    // a different node of the owner gets in as today, but is no own window: it neither reads nor answers the card
    expect(await pc.auth(over("100.64.0.10"))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect((await pc.nodes(over("100.64.0.10"))).status).toBe(403);
    const fromTablet = await pc.post("/api/devices/tailnet-nodes/answer", { id: "nPhone1CNTRL", decision: "allow" }, over("100.64.0.10"));
    expect([fromTablet.status, ((await fromTablet.json()) as { error: { code: string } }).error.code]).toEqual([403, "local_required"]);
    expect(await pc.auth(over("100.64.0.9"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });

    // Allow, on this PC's own window: in again
    expect((await pc.post("/api/devices/tailnet-nodes/answer", { id: "nPhone1CNTRL", decision: "allow" })).status).toBe(200);
    expect(await pc.auth(over("100.64.0.9"))).toMatchObject({ authenticated: true, via: "tailscale" });
  });

  it("Decline keeps the node out, and the block survives a restart", async () => {
    const dir = stateDir("restart");
    const first = start(dir);
    const phone = await first.pair("100.64.0.9");
    expect((await fetch(`${first.base}/api/devices/${phone.id}`, { method: "DELETE", headers: guard })).status).toBe(204);
    expect(await first.auth(over("100.64.0.9"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });
    expect((await first.post("/api/devices/tailnet-nodes/answer", { id: "nPhone1CNTRL", decision: "decline" })).status).toBe(200);
    expect(await first.auth(over("100.64.0.9"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });
    first.server.stop();

    const again = start(dir);
    expect(await again.auth(over("100.64.0.9"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });
    expect(await again.auth(over("100.64.0.10"))).toMatchObject({ authenticated: true, via: "tailscale" });
  });

  it("Revoke all keeps every node seen so far out; a node never seen gets in as before", async () => {
    const pc = start(stateDir("revoke-all"));
    await pc.pair("100.64.0.9");
    expect(await pc.auth(over("100.64.0.10"))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect((await pc.post("/api/devices/revoke-all", {})).status).toBe(200);
    expect(await pc.auth(over("100.64.0.9"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });
    expect(await pc.auth(over("100.64.0.10"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });
    expect(await pc.auth(over("100.64.0.11"))).toMatchObject({ authenticated: true, via: "tailscale" });
  });

  it("closes a live tailnet socket the moment its node is blocked from the dialog, and no other node's", async () => {
    const pc = start(stateDir("live"));
    const open = async (address: string) => {
      expect(await pc.auth(over(address))).toMatchObject({ authenticated: true, via: "tailscale" });
      const socket = new WebSocket(`${pc.base.replace("http", "ws")}/ws`, { headers: over(address) } as unknown as string[]);
      await bounded(new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("close", reject, { once: true }); }), 5000);
      return socket;
    };
    const tablet = await open("100.64.0.10");
    const laptop = await open("100.64.0.11");
    const closed = new Promise<CloseEvent>((resolve) => tablet.addEventListener("close", resolve, { once: true }));
    try {
      expect((await pc.post("/api/devices/tailnet-nodes/block", { ids: ["nTablet2CNTRL"] })).status).toBe(200);
      const event = await bounded(closed, 5000);
      expect([event.code, event.reason]).toEqual([1008, "Device access revoked"]);
      expect(laptop.readyState).toBe(WebSocket.OPEN);
    } finally { tablet.close(); laptop.close(); }
  });

  it("the removal dialog blocks a node that never had a row, and only a node this PC has seen", async () => {
    const pc = start(stateDir("dialog"));
    expect(await pc.auth(over("100.64.0.10"))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect((await pc.post("/api/devices/tailnet-nodes/block", { ids: ["nUnknown9CNTRL"] })).status).toBe(404);
    expect((await pc.post("/api/devices/tailnet-nodes/block", { ids: ["nTablet2CNTRL"] }, over("100.64.0.11"))).status).toBe(403);
    expect((await pc.post("/api/devices/tailnet-nodes/block", { ids: ["nTablet2CNTRL"] })).status).toBe(200);
    expect(await pc.auth(over("100.64.0.10"))).toMatchObject({ authenticated: false, reason: "tailnet_blocked" });
  });
});

describe("the tailnet node list", () => {
  const view = (nodes: TailnetNodes) => nodes.list(() => []).map(({ id, blocked }) => [id, blocked]);

  it("refuses an Allow while the lock stands, and any request from a window that is not this PC's own", async () => {
    const dir = stateDir("guards");
    const nodes = new TailnetNodes(dir);
    nodes.block([{ id: "nPhone1CNTRL", hostname: "pixel" }]);
    nodes.ask({ id: "nPhone1CNTRL", hostname: "pixel", login: OWNER });
    const allowed: string[] = [];
    const rows = { noteTailnetNode() {}, tailnetRowsOf: () => [], keepOutTailnetNodes: () => [], allowTailnetNode: (id: string) => { allowed.push(id); nodes.allow(id); } };
    const answer = (input: { ownWindow: boolean; locked: boolean }) => handleTailnetNodeRequest(new Request("http://127.0.0.1/api/devices/tailnet-nodes/answer", {
      method: "POST", headers: guard, body: JSON.stringify({ id: "nPhone1CNTRL", decision: "allow" }),
    }), "/api/devices/tailnet-nodes/answer", { nodes, rows, ...input });
    expect((await answer({ ownWindow: true, locked: true })).status).toBe(423);
    expect((await answer({ ownWindow: false, locked: false })).status).toBe(403);
    expect(allowed).toEqual([]);
    expect((await answer({ ownWindow: true, locked: false })).status).toBe(200);
    expect(allowed).toEqual(["nPhone1CNTRL"]);
  });

  it("asks about one node at a time", () => {
    const nodes = new TailnetNodes(stateDir("one"));
    nodes.block([{ id: "nPhone1CNTRL" }, { id: "nTablet2CNTRL" }]);
    nodes.ask({ id: "nPhone1CNTRL", hostname: "pixel", login: OWNER });
    nodes.ask({ id: "nTablet2CNTRL", hostname: "ipad", login: OWNER });
    expect(nodes.prompt()?.id).toBe("nPhone1CNTRL");
  });

  it("merges a sibling folder like a tombstone: a block in either stands, unless an Allow came after it", () => {
    const [a, b] = [stateDir("merge-a"), stateDir("merge-b")];
    let at = Date.parse("2026-11-01T00:00:00Z");
    const clock = () => at;
    new TailnetNodes(a, null, clock).block([{ id: "nPhone1CNTRL" }]);
    at += 60_000;
    const sibling = new TailnetNodes(b, null, clock);
    sibling.block([{ id: "nTablet2CNTRL" }, { id: "nPhone1CNTRL" }]);
    at += 60_000;
    sibling.allow("nPhone1CNTRL");
    expect(mergeTailnetNodes(a, b)).toBeNull();
    for (const dir of [a, b]) expect(view(new TailnetNodes(dir)).sort()).toEqual([["nPhone1CNTRL", false], ["nTablet2CNTRL", true]]);
  });

  it("keeps every node out while its file cannot be read", () => {
    const dir = stateDir("bad");
    writeFileSync(join(dir, TAILNET_NODES_FILE), "not json", { mode: 0o600 });
    const nodes = new TailnetNodes(dir);
    expect(nodes.problem).not.toBeNull();
    expect(nodes.isBlocked("nAnything1CNTRL")).toBe(true);
  });

  it("names a node by its StableID from tailscale whois, and nothing that is not one", () => {
    expect(parseWhois(whoisJson("100.64.0.9"))).toEqual({ id: "nPhone1CNTRL", hostname: "pixel", login: OWNER });
    expect(parseWhois(JSON.stringify({ Node: { StableID: "../x" } }))).toBeNull();
    expect(parseWhois(null)).toBeNull();
  });

  it("an account record's drop keeps the row's node out: Not me, and a member's remove", async () => {
    const key = async () => { const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]); return { keys, spki: await exportAccountKey(keys.publicKey) }; };
    for (const how of ["not_me", "remove"] as const) {
      const dir = stateDir(`record-${how}`);
      const log = SafetyLog.open(dir);
      const journal = DeviceJournal.open(dir, () => log.ensureFile());
      const store = new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal });
      const nodes = new TailnetNodes(dir);
      store.attachTailnetNodes(nodes);
      const member = async () => {
        const k = await key();
        const id = store.pairRelay(store.startPairing().code, "Phone", k.spki)!.device.id;
        store.linkAccountKey(id, k.spki, k.spki, "acct_1");
        return { ...k, id };
      };
      const signer = await member();
      const target = await member();
      store.noteTailnetNode(target.id, "nPhone1CNTRL");
      const ended: string[] = [];
      nodes.onBlocked("nPhone1CNTRL", () => ended.push(how));
      if (how === "not_me") {
        const record = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: target.spki, target_no: 9, signer_no: 1, signer: signer.spki, signed_at: new Date().toISOString(), nonce: newRecordId() }, signer.keys.privateKey) as BlockRecord;
        expect(await store.applyBlock(record, "session")).toMatchObject({ outcome: "applied" });
      } else {
        expect(store.removeAccountKey(target.spki, "acct_1", { id: newRecordId(), issuedAt: new Date().toISOString(), by: { device_id: signer.id, label: "Phone" } })).toBe(true);
      }
      expect(store.has(target.id)).toBe(false);
      // the same node, by the owner's login, is refused next
      const next = await tailnetNodeGate({ level: "full", via: "tailscale", role: "drive", login: OWNER }, {
        address: "100.64.0.9", owner: OWNER, nodes, rows: store, whois: async (address) => parseWhois(whoisJson(address)),
      });
      expect([next.access, ended]).toEqual([{ level: "none", reason: "tailnet_blocked" }, [how]]);
      expect(journal.entries().filter((entry) => entry.kind === "tailnet").map(({ how: what, row }) => [what, row])).toEqual([["block", target.id]]);
    }
  });

  it("Not me with the node-list write failing still keeps the node out after a restart; a later Allow stands", async () => {
    const dir = stateDir("record-restart");
    const open = () => {
      const log = SafetyLog.open(dir);
      const store = new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) });
      const nodes = new TailnetNodes(dir);
      store.attachTailnetNodes(nodes);
      return { store, nodes };
    };
    const gate = (nodes: TailnetNodes, store: DeviceStore, address: string) => tailnetNodeGate({ level: "full", via: "tailscale", role: "drive", login: OWNER }, {
      address, owner: OWNER, nodes, rows: store, whois: async (at) => parseWhois(whoisJson(at)),
    }).then(({ access }) => access);
    const first = open();
    const key = async () => { const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]); return { keys, spki: await exportAccountKey(keys.publicKey) }; };
    const member = async () => {
      const k = await key();
      const id = first.store.pairRelay(first.store.startPairing().code, "Phone", k.spki)!.device.id;
      first.store.linkAccountKey(id, k.spki, k.spki, "acct_1");
      return { ...k, id };
    };
    const signer = await member();
    const target = await member();
    first.store.noteTailnetNode(target.id, "nPhone1CNTRL");
    const record = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: target.spki, target_no: 9, signer_no: 1, signer: signer.spki, signed_at: new Date().toISOString(), nonce: newRecordId() }, signer.keys.privateKey) as BlockRecord;
    const rename = privateStateFs.renameSync;
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation(((from: string, to: string) => {
      if (String(to).endsWith(TAILNET_NODES_FILE)) throw new Error("simulated EIO");
      return rename(from, to);
    }) as typeof rename);
    try { expect(await first.store.applyBlock(record, "session")).toMatchObject({ outcome: "applied" }); }
    finally { failing.mockRestore(); }
    expect([first.store.has(target.id), first.nodes.problem !== null, await gate(first.nodes, first.store, "100.64.0.9")]).toEqual([false, true, { level: "none", reason: "tailnet_blocked" }]);

    const restarted = open();
    expect(restarted.nodes.problem).toBeNull();
    expect(await gate(restarted.nodes, restarted.store, "100.64.0.9")).toEqual({ level: "none", reason: "tailnet_blocked" });
    expect((await gate(restarted.nodes, restarted.store, "100.64.0.10")).level).toBe("full");

    restarted.store.allowTailnetNode("nPhone1CNTRL");
    const again = open();
    expect((await gate(again.nodes, again.store, "100.64.0.9")).level).toBe("full");
  });

  it("journals a removal's block before the row goes, and an Allow", () => {
    const dir = stateDir("journal");
    const journal = DeviceJournal.open(dir);
    const store = new DeviceStore(dir, null, null, { journal });
    const nodes = new TailnetNodes(dir);
    store.attachTailnetNodes(nodes);
    const { code } = store.startPairing();
    const paired = store.pair(code, "Phone", "drive", Date.now(), [], false)!;
    const row = store.match(paired.token)!;
    store.noteTailnetNode(row.id, "nPhone1CNTRL");
    expect(store.revoke(row.id)).toBe(true);
    expect(nodes.isBlocked("nPhone1CNTRL")).toBe(true);
    store.allowTailnetNode("nPhone1CNTRL");
    expect(journal.entries().filter((entry) => entry.kind === "tailnet").map(({ how, row: subject, label }) => [how, subject, label]))
      .toEqual([["block", row.id, "nPhone1CNTRL · nPhone1CNTRL"], ["allow", null, "nPhone1CNTRL · nPhone1CNTRL"]]);
  });
});
