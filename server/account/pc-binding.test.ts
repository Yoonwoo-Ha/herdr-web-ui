import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { DeviceStore, type StoredDevice } from "../devices.ts";
import { relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { PcAccountState } from "./pc-binding.ts";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "acct_1";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pc-binding-"));
  dirs.push(dir);
  return dir;
}

async function accountKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

const store = (dir: string) => new DeviceStore(dir, null, null, { pc: PcAccountState.open(dir) });
const pcFile = (dir: string) => JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8")) as {
  v: number; binding: { account: string; bind_id: string } | null; clears: { bind_id: string; reason: string; by: string }[];
  first: { key: string; list_key: string | null } | null; others_ever: boolean; next_admit: number;
};

/** A relay row of this PC that links into `account` with its own key, as the link route does after its checks. */
async function linked(devices: DeviceStore, account = ACCOUNT): Promise<{ id: string; key: string }> {
  const key = (await accountKey()).spki;
  const paired = devices.pairRelay(devices.startPairing().code, "Phone", key);
  if (!paired) throw new Error("pairing failed");
  if (devices.linkAccountKey(paired.device.id, key, key, account) === null) throw new Error("link failed");
  return { id: paired.device.id, key };
}

function memberRow(account: string): StoredDevice {
  return { id: randomBytes(8).toString("hex"), label: "Old phone", role: "drive", token_hash: randomBytes(32).toString("hex"),
    account, created_at: "2026-10-01T00:00:00.000Z", last_seen_at: null };
}

describe("the PC's account binding (account-pc.json)", () => {
  test("T59/T67: neither a current nor stale relay challenge binds a first-device list key", async () => {
    for (const fresh of [true, false]) {
      const f = relayFixture(false, { accountOpensAll: true });
      fixtures.push(f);
      const device = await relayDevice(f);
      const listKey = await accountKey();
      const link = await relayConnection(f);
      await link.auth(device);
      const nonce = Buffer.from((await link.welcome).payload.nonce, "base64url");
      if (!fresh) nonce[0] = (nonce[0] ?? 0) ^ 1;
      const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, listKey.keys.privateKey,
        Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(SERVER_ID)]))).toString("base64url");
      const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: device.publicKey, server_id: SERVER_ID, device_id: device.id, old_key: device.publicKey, issued_at: new Date().toISOString(), id: newRecordId(), signer: device.publicKey }, device.keys.privateKey);
      const request = link.open("/api/account/link", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
      await request.stream.sendBody(new Response(JSON.stringify({ record, list_key: listKey.spki, list_signature: signature })).body!);
      expect((await request.response).status).toBe(200);
      expect(pcFile(f.stateDir).first).toEqual({ key: device.publicKey, list_key: null });
    }
  });

  test("T67/H2: another linked member permanently consumes first-device status", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    expect(pcFile(dir).others_ever).toBe(false);
    const second = await linked(devices);
    expect(devices.revoke(second.id)).toBe(true);
    expect(PcAccountState.open(dir).othersEver()).toBe(true);
  });
  test("T13: first link and enrollment barrier commit together", async () => {
    const f = relayFixture(false, { accountOpensAll: true });
    fixtures.push(f);
    const device = await relayDevice(f);
    const key = await accountKey();
    const link = await relayConnection(f);
    await link.auth(device);
    const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: key.spki, server_id: SERVER_ID, device_id: device.id, old_key: device.publicKey, issued_at: new Date().toISOString(), id: newRecordId(), signer: key.spki }, key.keys.privateKey);
    const request = link.open("/api/account/link", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
    void request.stream.sendBody(new Response(JSON.stringify({ record })).body!).catch(() => {});
    expect((await request.response).status).toBe(200);
    // the barrier that holds account adds back, and the binding, are both on disk once the link answered
    expect(existsSync(join(f.stateDir, "account-enrolling.json"))).toBe(true);
    const bound = pcFile(f.stateDir);
    expect(bound.binding?.account).toBe(ACCOUNT);
    expect(bound.binding?.bind_id).toMatch(/^[0-9a-f]{32}$/);
    expect(bound.first).toEqual({ key: key.spki, list_key: null });

    // a link whose row cannot be written leaves no binding behind
    const dir = stateDir();
    const devices = store(dir);
    const key2 = (await accountKey()).spki;
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", key2)!;
    rmSync(join(dir, "devices.json"));
    mkdirSync(join(dir, "devices.json"));
    expect(() => devices.linkAccountKey(paired.device.id, key2, key2, ACCOUNT)).toThrow();
    expect(devices.account()).toBeNull();
    expect(pcFile(dir).binding).toBeNull();
  });

  test("T59: link binds the PC and only a named local clear or identity reset clears it", async () => {
    const dir = stateDir();
    const devices = store(dir);
    expect(devices.account()).toBeNull();
    const first = await linked(devices);
    expect(devices.account()).toBe(ACCOUNT);
    const bindId = pcFile(dir).binding!.bind_id;
    // a second member, a record that removes it, and a Revoke change nothing of the binding
    const second = await linked(devices);
    expect(devices.removeAccountKey(second.key, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() })).toBe(true);
    expect(devices.revoke(first.id)).toBe(true);
    expect(pcFile(dir).binding).toEqual({ account: ACCOUNT, bind_id: bindId });

    // a named clear at the PC: the binding goes, the clear is kept, and the file stays
    devices.clearAccountBinding("left_on_pc", "pc");
    expect(devices.account()).toBeNull();
    expect(pcFile(dir)).toMatchObject({ binding: null, clears: [{ bind_id: bindId, reason: "left_on_pc", by: "pc" }] });
    // the next first link makes a new binding; the earlier clear is never cut
    await linked(devices, "acct_2");
    const rebound = pcFile(dir);
    expect(rebound.binding?.account).toBe("acct_2");
    expect(rebound.binding?.bind_id).not.toBe(bindId);
    // Revoke all clears too
    devices.revokeAll();
    expect(pcFile(dir).clears.map((clear) => clear.reason)).toEqual(["left_on_pc", "revoke_all"]);
    expect(store(dir).account()).toBeNull();

    // a relay identity reset clears it
    const f = relayFixture(false, { accountOpensAll: true });
    fixtures.push(f);
    const served = f.app.context.services.devices;
    await linked(served);
    expect(served.account()).toBe(ACCOUNT);
    await f.app.context.services.relay.resetIdentity();
    expect(served.account()).toBeNull();
    expect(pcFile(f.stateDir).clears.at(-1)?.reason).toBe("identity_reset");
  });

  test("T30: removing the last member leaves the PC bound", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const only = await linked(devices);
    expect(devices.removeAccountKey(only.key, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() })).toBe(true);
    expect(devices.list(null).filter((device) => device.account !== undefined)).toHaveLength(0);
    expect(devices.account()).toBe(ACCOUNT);
    expect(store(dir).account()).toBe(ACCOUNT);
  });

  test("T50: legacy migration is once only and conflicting accounts fail closed", () => {
    // the rows' one account becomes the binding, once; an upgraded PC never takes the first-device path
    const dir = stateDir();
    const rows = [memberRow(ACCOUNT), memberRow(ACCOUNT), { ...memberRow(ACCOUNT), account: undefined }];
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: rows[0]!.created_at, devices: rows }), { mode: 0o600 });
    expect(store(dir).account()).toBe(ACCOUNT);
    const migrated = pcFile(dir);
    expect(migrated).toMatchObject({ v: 1, binding: { account: ACCOUNT }, clears: [], first: null, others_ever: true, next_admit: 1 });
    expect(store(dir).account()).toBe(ACCOUNT);
    expect(pcFile(dir).binding?.bind_id).toBe(migrated.binding!.bind_id);

    // a PC with no rows starts with no binding and no history
    const fresh = stateDir();
    expect(store(fresh).account()).toBeNull();
    expect(pcFile(fresh)).toMatchObject({ binding: null, clears: [], first: null, others_ever: false });

    // rows of two accounts: no binding is guessed, and the PC fails closed
    const split = stateDir();
    const two = [memberRow(ACCOUNT), memberRow("acct_2")];
    writeFileSync(join(split, "devices.json"), JSON.stringify({ gate_closed_at: two[0]!.created_at, devices: two }), { mode: 0o600 });
    const pc = PcAccountState.open(split);
    const closed = new DeviceStore(split, null, null, { pc });
    expect(closed.accountError).not.toBeNull();
    expect(closed.pair(closed.startPairing().code, "New", "drive")).toBeNull();
    expect(existsSync(join(split, ADMISSION_FILE))).toBe(false);
  });
});
