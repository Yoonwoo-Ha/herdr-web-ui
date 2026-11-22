/**
 * Adding a PC to the account over SSH (docs/account.md, "Adding a PC over SSH"): the adding PC's route vouches only from
 * its own window and only with its own binding's account; the added PC answers its owner's recovery socket with its public
 * relay fields, and binds only on its own admission for that account.
 */
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { handleRequest } from "../dispatch.ts";
import { pairingPc, setUpFor, type Pc } from "./pairing.test-helpers.ts";
import { askRecovery } from "./recovery.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(): Promise<Pc> {
  const made = await pairingPc({ server: { accountOpensAll: true } });
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
