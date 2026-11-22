/**
 * After `ovis logout` the PC left its account (POST /v1/pcs/{server_id}/leave, account#65): for 30 days the account's
 * PUT lists it again only with the PC's own proof. Add this PC on the PC's own window carries that proof
 * (POST /api/account/pc-proof), so the way back is a sign-in on the PC; a PUT without it is refused 409 `pc_left`.
 */
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { listThisPc } from "../../src/lib/account/addThisPc.ts";
import { AccountService } from "../../src/lib/account/service.ts";
import { memoryAccountStore } from "../../src/lib/account/store.ts";
import { nativeTransport, setTransport } from "../../src/lib/transport.ts";
import { handleRequest } from "../dispatch.ts";
import { pairingPc } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_left";
const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  setTransport(nativeTransport);
  for (const close of closes.splice(0)) await close();
});

async function leftPc() {
  const pc = await pairingPc();
  closes.push(() => pc.close());
  const identity = pc.app.context.services.relay.currentIdentity();
  if (!identity) throw new TypeError("The relay fixture needs its identity");
  const store = memoryAccountStore();
  await store.set("session", { account: ACCOUNT, provider: "github", service: "https://account.test", access_token: pc.account.issueToken(ACCOUNT), refresh_token: "fixture", expires_at: Date.now() + 3_600_000 });
  const service = new AccountService({ store, fetch: pc.account.fetch });
  const entry = { label: "Desk", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test" };
  await service.putPc(identity.server_id, entry);
  // `ovis logout`: the PC leaves the account by its own proof
  const left = await pc.account.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}/leave`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT, ...await pc.app.context.services.accountMailbox.listingProof() }),
  }));
  expect(left.status).toBe(204);
  expect(await service.listPcs()).toEqual([]);
  const base = `http://127.0.0.1:${pc.app.port}`;
  const ownWindow = (input: RequestInfo | URL, init?: RequestInit) => fetch(new URL(String(input), base), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: base } });
  setTransport({ ...nativeTransport, fetch: Object.assign(ownWindow, { preconnect: fetch.preconnect }) });
  return { pc, service, serverId: identity.server_id, entry };
}

test("after the PC left, a PUT without the PC's own proof is refused 409 pc_left and lists nothing", async () => {
  const { service, serverId, entry } = await leftPc();

  await expect(service.putPc(serverId, entry)).rejects.toMatchObject({ status: 409, code: "pc_left" });

  expect(await service.listPcs()).toEqual([]);
});

test("Add this PC on the PC's own window lists it again with the PC's own proof", async () => {
  const { pc, service, serverId } = await leftPc();

  expect(await listThisPc(service, { relistMs: 9 * 60_000 })).toMatchObject({ serverId, account: ACCOUNT });

  expect((await service.listPcs()).map((entry) => entry.server_id)).toEqual([serverId]);
  expect(pc.account.requests.filter((line) => line.startsWith("PUT "))).toEqual([`PUT /v1/pcs/${serverId}`, `PUT /v1/pcs/${serverId}`]);
});

test("only this PC's own window gets its proof: a device through the relay that drives it is refused", async () => {
  const { pc, serverId } = await leftPc();
  const before = pc.account.requests.length;

  const relayed = await handleRequest(new Request("https://relay.ovis.invalid/api/account/pc-proof", {
    method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: "{}",
  }), { ...pc.app.context, peer: { kind: "relay", device: { id: "aaaaaaaaaaaaaaaa", label: "Relay", role: "drive" }, sessionId: "s", serverId, key: "" }, timeout: () => {} });

  expect([relayed?.status, ((await relayed!.json()) as { error: { code: string } }).error.code]).toEqual([403, "owner_only"]);
  expect(pc.account.requests.slice(before)).toEqual([]);
});
