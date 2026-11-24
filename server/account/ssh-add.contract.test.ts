/**
 * Adding a PC to the account over SSH (docs/account.md, "Adding a PC over SSH"): the adding PC's route vouches only from
 * its own window and only with its own binding's account; the added PC answers its owner's recovery socket with its public
 * relay fields, and binds only on its own admission for that account.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { startBunRelay, type BunRelay } from "../../relay/bun.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { handleRequest } from "../dispatch.ts";
import { pairingPc, setUpFor, type Pc } from "./pairing.test-helpers.ts";
import { askRecovery } from "./recovery.ts";

const pcs: Pc[] = [];
const relays: BunRelay[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
  for (const relay of relays.splice(0)) await relay.stop();
});

/** A relay on this machine that a PC's relay comes online on: its port. */
function localRelay(): number {
  const relay = startBunRelay({ port: 0 });
  relays.push(relay);
  return relay.port;
}

async function pc(options: Parameters<typeof pairingPc>[0] = {}): Promise<Pc> {
  const made = await pairingPc({ ...options, server: { accountOpensAll: true, ...options.server } });
  made.account.opensAll = true;
  pcs.push(made);
  return made;
}

async function admitAt(f: Pc, account: string): Promise<void> {
  const identity = f.app.context.services.relay.currentIdentity()!;
  const token = f.account.issueToken(account, { twoStep: true });
  const call = (path: string, method: string, body: unknown) =>
    f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  expect((await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).ok).toBe(true);
}

const sshAdd = (f: Pc, body: unknown) => f.local("/api/account/ssh-add", { method: "POST", headers: { "x-herdr-machine": "1" }, body });

/** What the adding PC sends on that PC's recovery socket around the window's list and admit: inspect, then take for `account`. */
async function inspectAndTake(b: Pc, account: string, admit = true): Promise<unknown> {
  const { server_id } = await askRecovery(b.stateDir, { act: "account_add_inspect" }) as { server_id: string };
  if (admit) await admitAt(b, account);
  return await askRecovery(b.stateDir, { act: "account_add_take", account, server_id });
}

const relayPhase = async (f: Pc) => (await f.local("/api/relay")).body["phase"];

// an Ovis installed over SSH never had its relay turned on (its Settings page was never opened): the add turns it on
test.skipIf(process.platform === "win32")("a take turns that PC's relay on, and answers once it is online, saying so", async () => {
  const b = await pc({ relayPort: localRelay(), startRelay: false });
  expect(await relayPhase(b)).toBe("off");
  expect(await inspectAndTake(b, "acct_1")).toEqual({ account: "acct_1", relay: { phase: "online", blocked: null } });
  expect(b.devices.account()).toBe("acct_1");
  expect(await relayPhase(b)).toBe("online");
  // as its own Settings switch turns it on: it is on again after a restart
  expect(JSON.parse(readFileSync(join(b.stateDir, "relay", "state.json"), "utf8"))).toMatchObject({ enabled: true });
});

test.skipIf(process.platform === "win32")("a relay not online within the wait: the take says where it stands, and that PC stays in the account", async () => {
  // its relay is turned on, but its socket never opens
  const b = await pc({ startRelay: false, server: { accountAddRelayMs: 300 } });
  expect(await inspectAndTake(b, "acct_1")).toEqual({ account: "acct_1", relay: { phase: "connecting", blocked: null } });
  expect(b.devices.account()).toBe("acct_1");
});

test.skipIf(process.platform === "win32")("a PC already in that account keeps a relay its owner turned off: a re-add leaves it off and says so", async () => {
  const b = await pc({ relayPort: localRelay(), startRelay: false });
  await inspectAndTake(b, "acct_1");
  expect((await b.local("/api/relay/stop", { method: "POST", headers: { "x-herdr-update": "1" } })).status).toBe(200);
  expect(await relayPhase(b)).toBe("off");
  expect(await inspectAndTake(b, "acct_1", false)).toEqual({ account: "acct_1", relay: { phase: "off", blocked: null } });
  expect(await relayPhase(b)).toBe("off");
});

test.skipIf(process.platform === "win32")("a PC already in that account whose relay switch was never set has it turned on by a re-add", async () => {
  // in the account by its own page's one press, its relay never turned on: no switch saved
  const b = await pc({ relayPort: localRelay(), startRelay: false });
  const { server_id } = await askRecovery(b.stateDir, { act: "account_add_inspect" }) as { server_id: string };
  await setUpFor(b, "acct_1");
  await admitAt(b, "acct_1");
  expect((await b.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: "acct_1" } })).status).toBe(200);
  expect(existsSync(join(b.stateDir, "relay", "state.json"))).toBe(false);
  expect(await askRecovery(b.stateDir, { act: "account_add_take", account: "acct_1", server_id })).toEqual({ account: "acct_1", relay: { phase: "online", blocked: null } });
  expect(await relayPhase(b)).toBe("online");
});

test.skipIf(process.platform === "win32")("a take refused as another account's PC, for another identity, or on a bridge turns nothing on", async () => {
  const b = await pc({ relayPort: localRelay(), startRelay: false });
  const { server_id } = await askRecovery(b.stateDir, { act: "account_add_inspect" }) as { server_id: string };
  expect(await askRecovery(b.stateDir, { act: "account_add_take", account: "acct_1", server_id: "0".repeat(32) })).toMatchObject({ code: "identity_changed" });
  const before = process.env["OVIS_REMOTE"];
  process.env["OVIS_REMOTE"] = "1";
  try { expect(await askRecovery(b.stateDir, { act: "account_add_take", account: "acct_1", server_id })).toMatchObject({ code: "managed" }); }
  finally { if (before === undefined) delete process.env["OVIS_REMOTE"]; else process.env["OVIS_REMOTE"] = before; }
  await setUpFor(b, "acct_other");
  await admitAt(b, "acct_other");
  expect((await b.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: "acct_other" } })).status).toBe(200);
  expect(await askRecovery(b.stateDir, { act: "account_add_take", account: "acct_1", server_id })).toMatchObject({ code: "other_account" });
  expect(await relayPhase(b)).toBe("off");
  expect(existsSync(join(b.stateDir, "relay", "state.json"))).toBe(false);
});

test.skipIf(process.platform === "win32")("a take that binds nothing turns nothing on", async () => {
  const b = await pc({ relayPort: localRelay(), startRelay: false });
  expect(await inspectAndTake(b, "acct_1", false)).toMatchObject({ code: "no_admission" });
  expect(b.devices.account()).toBeNull();
  expect(await relayPhase(b)).toBe("off");
});

test.skipIf(process.platform === "win32")("the added PC tells its public relay fields only, its ID derived from its key", async () => {
  const b = await pc();
  const answer = await askRecovery(b.stateDir, { act: "account_add_inspect" }) as Record<string, unknown>;
  expect(Object.keys(answer).sort()).toEqual(["account", "label", "public_key", "relay", "server_id"]);
  expect(deriveServerId(importPublicKey(answer.public_key as string))).toBe(answer.server_id as string);
  expect(answer.account).toBeNull();
});

test.skipIf(process.platform === "win32")("a bridge another PC started answers neither inspect nor take", async () => {
  const b = await pc();
  const before = process.env["OVIS_REMOTE"];
  process.env["OVIS_REMOTE"] = "1";
  try {
    expect(await askRecovery(b.stateDir, { act: "account_add_inspect" })).toMatchObject({ code: "managed" });
    const serverId = b.app.context.services.relay.currentIdentity()!.server_id;
    expect(await askRecovery(b.stateDir, { act: "account_add_take", account: "acct_1", server_id: serverId })).toMatchObject({ code: "managed" });
  } finally {
    if (before === undefined) delete process.env["OVIS_REMOTE"]; else process.env["OVIS_REMOTE"] = before;
  }
  expect(b.devices.account()).toBeNull();
});

test.skipIf(process.platform === "win32")("a PC in another account binds nothing for a take", async () => {
  const b = await pc();
  await setUpFor(b, "acct_other");
  await admitAt(b, "acct_other");
  expect((await b.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: "acct_other" } })).status).toBe(200);
  const serverId = b.app.context.services.relay.currentIdentity()!.server_id;
  expect(await askRecovery(b.stateDir, { act: "account_add_take", account: "acct_1", server_id: serverId })).toMatchObject({ code: "other_account" });
  expect(b.devices.account()).toBe("acct_other");
});

test("a bound PC's completion receipt the service did not take is sent again after its next pull, and the directory then shows it completed", async () => {
  // the first read asks about the listing, then the receipt is sent: both fail once the service is down
  let refuse = 2;
  const b = await pairingPc({ server: { accountOpensAll: true }, accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/complete" && refuse-- > 0) return Response.json({ error: { code: "unavailable", message: "down" } }, { status: 503 });
    return await service.fetch(request);
  } });
  b.account.opensAll = true;
  b.account.completions = true;
  pcs.push(b);
  await setUpFor(b, "acct_1");
  await admitAt(b, "acct_1");
  expect((await b.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: "acct_1" } })).status).toBe(200);
  const serverId = b.app.context.services.relay.currentIdentity()!.server_id;
  const completedAt = async () => {
    const answer = await b.account.fetch(new Request("https://account.test/v1/pcs", { headers: { authorization: `Bearer ${b.account.issueToken("acct_1")}` } }));
    return ((await answer.json()) as { pcs: { server_id: string; completed_at?: string | null }[] }).pcs.find((pc) => pc.server_id === serverId)?.completed_at;
  };
  expect(await completedAt()).toBeNull();
  await b.app.context.services.accountMailbox.pull();
  expect(await completedAt()).toEqual(expect.any(String));
});

test("a device through the relay cannot vouch for another PC", async () => {
  const a = await pc();
  const serverId = a.app.context.services.relay.currentIdentity()!.server_id;
  const response = await handleRequest(new Request("https://relay.ovis.invalid/api/account/ssh-add", {
    method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ job_id: "x", server_id: "0".repeat(32) }),
  }), { ...a.app.context, peer: { kind: "relay", device: { id: "aaaaaaaaaaaaaaaa", label: "Relay", role: "drive" }, sessionId: "s", serverId, key: "" }, timeout: () => {} });
  expect([response?.status, ((await response!.json()) as { error: { code: string } }).error.code]).toEqual([403, "owner_only"]);
});

test("a PC in no account has no account to vouch with", async () => {
  const a = await pc();
  const answer = await sshAdd(a, { job_id: "x", server_id: "0".repeat(32) });
  expect([answer.status, answer.body.error?.code]).toEqual([409, "not_in_account"]);
});

test("the account is this PC's own binding's: the body names none, and a job it does not hold adds nothing", async () => {
  const a = await pc();
  await setUpFor(a, "acct_1");
  await admitAt(a, "acct_1");
  expect((await a.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: "acct_1" } })).status).toBe(200);
  const self = await sshAdd(a, { job_id: "x", server_id: a.app.context.services.relay.currentIdentity()!.server_id });
  expect([self.status, self.body.error?.code]).toEqual([409, "self"]);
  const unknown = await sshAdd(a, { job_id: "x", server_id: "0".repeat(32), account: "acct_other" });
  expect(unknown.status).toBe(404);
});
