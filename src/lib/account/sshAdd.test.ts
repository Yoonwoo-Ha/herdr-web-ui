import { describe, expect, it } from "bun:test";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import type { AccountAddTarget } from "../../../shared/machines.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { AccountService } from "./service.ts";
import { addOverSsh, sshAddListed, sshAddOffered, type SshTake } from "./sshAdd.ts";
import { memoryAccountStore } from "./store.ts";

const ACCOUNT = "acct_1";
const SERVICE = "https://account.test";

function pcFields(account: string | null = null): AccountAddTarget {
  const key = generateKeyPair().publicKey;
  return { server_id: deriveServerId(key), public_key: exportPublicKey(key), relay: "wss://relay.example", label: "nuc", account };
}

const ONLINE = { relay: { phase: "online", blocked: null } } as const;

async function window(options: { twoStep: boolean | null; used?: boolean; said?: SshTake; clock?: () => number }) {
  const fake = new FakeAccountService(options.clock);
  fake.opensAll = true;
  // the rule these cases are about: an account service that asks a used account's admit for two-step
  fake.admitAsksTwoStep = true;
  const store = memoryAccountStore();
  await store.set("session", { service: SERVICE, account: ACCOUNT, provider: "google", access_token: fake.issueToken(ACCOUNT, { twoStep: options.twoStep }), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const service = new AccountService({ store, fetch: fake.fetch });
  // this PC itself, listed in the account it is in: a used account, as any PC that adds another over SSH is
  if (options.used !== false) {
    const own = generateKeyPair().publicKey;
    await service.putPc(deriveServerId(own), { label: "desk", public_key: Array.from(own, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  }
  const takes: string[] = [];
  const take = async (jobId: string, serverId: string): Promise<SshTake> => { takes.push(`${jobId} ${serverId}`); return options.said ?? ONLINE; };
  return { fake, store, service, takes, take };
}

const listedIds = async (service: AccountService) => (await service.listPcs()).map((pc) => pc.server_id);

describe("adding another PC to the account over SSH, from this PC's own window", () => {
  it("lists that PC, admits it with this window's own two-step sign-in, then has this PC hand it the account", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("added");
    expect(await listedIds(service)).toContain(target.server_id);
    expect(takes).toEqual([`job-1 ${target.server_id}`]);
  });

  it("Google without two-step on a used account: told to add it with the number on that PC, and nothing is handed over", async () => {
    const { service, take, takes } = await window({ twoStep: false });
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("number");
    expect(takes).toEqual([]);
  });

  it("a never-used account needs no two-step: the service's first-PC exception admits it", async () => {
    const { service, take } = await window({ twoStep: false, used: false });
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("added");
  });

  it("a PC already in this account, or in another, is neither listed nor admitted", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const before = await listedIds(service);
    const already = pcFields(ACCOUNT);
    expect(await addOverSsh(service, { id: "job-1", account_add: already }, { account: ACCOUNT, running: () => true, take })).toBe("already");
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields("acct_other") }, { account: ACCOUNT, running: () => true, take })).toBe("other-account");
    expect(await listedIds(service)).toEqual(before);
    // the one in this account is still taken, which turns its relay on: one added before that may have it off
    expect(takes).toEqual([`job-1 ${already.server_id}`]);
  });

  it("says added only once that PC says its relay is online", async () => {
    for (const [said, outcome] of [
      [ONLINE, "added"],
      [{ relay: { phase: "connecting", blocked: null } }, "not-online"],
      [{ relay: { phase: "off", blocked: "serve_only" } }, "not-online"],
      // an Ovis there from before this says nothing of its relay: in the account, never taken for online
      [{ relay: null }, "added-unchecked"],
      // the take's answer was lost and a second look found it in the account
      [{ relay: null, unanswered: true }, "added-unanswered"],
    ] as const) {
      const { service, take } = await window({ twoStep: true, said });
      expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe(outcome);
    }
    for (const [said, outcome] of [
      [{ relay: { phase: "connecting", blocked: null } }, "not-online"],
      [{ relay: null }, "already-unchecked"],
      [{ relay: null, unanswered: true }, "already-unanswered"],
      // its owner turned its relay off there: said so, not "not online yet"
      [{ relay: { phase: "off", blocked: null } }, "relay-off"],
    ] as const) {
      const { service, take } = await window({ twoStep: true, said });
      expect(await addOverSsh(service, { id: "job-1", account_add: pcFields(ACCOUNT) }, { account: ACCOUNT, running: () => true, take })).toBe(outcome);
    }
  });

  it("a take whose SSH connection ended says so, apart from any other refusal", async () => {
    for (const [code, outcome] of [["disconnected", "disconnected"], ["job_not_found", "disconnected"], ["no_admission", "refused"], ["take_unanswered", "maybe"]] as const) {
      const { service, take } = await window({ twoStep: true, said: { refused: code } });
      expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe(outcome);
    }
  });

  it("a take this PC gave no answer to may have gone out: maybe, never refused", async () => {
    const { service } = await window({ twoStep: true });
    const take = async (): Promise<SshTake> => { throw new TypeError("Failed to fetch"); };
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take })).toBe("maybe");
  });

  it("a sign-in too old to admit asks for a fresh one; the fresh one, as it was handed in, then adds it", async () => {
    let now = Date.now();
    const { fake, store, service, take, takes } = await window({ twoStep: true, clock: () => now });
    now += 11 * 60_000;
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take })).toBe("sign-in-again");
    expect(takes).toEqual([]);
    const fresh = { service: SERVICE, account: ACCOUNT, provider: "google" as const, access_token: fake.issueToken(ACCOUNT, { twoStep: true }), refresh_token: "fresh", expires_at: Date.now() + 3600_000 };
    await store.set("session", fresh);
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take, signIn: fresh })).toBe("added");
    expect(takes).toEqual([`job-1 ${target.server_id}`]);
  });

  it("a fresh sign-in that is no longer the one stored (another tab signed in meanwhile) writes nothing", async () => {
    const { fake, store, service, take, takes } = await window({ twoStep: true });
    const fresh = { service: SERVICE, account: ACCOUNT, provider: "google" as const, access_token: fake.issueToken(ACCOUNT, { twoStep: true }), refresh_token: "fresh", expires_at: Date.now() + 3600_000 };
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take, signIn: fresh })).toBe("refused");
    expect(await listedIds(service)).not.toContain(target.server_id);
    expect(takes).toEqual([]);
    expect((await store.get("session"))?.refresh_token).toBe("r");
  });

  it("a window signed in to another account than this PC's writes nothing", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const before = await listedIds(service);
    expect(await addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: "acct_other", running: () => true, take })).toBe("refused");
    expect(await listedIds(service)).toEqual(before);
    expect(takes).toEqual([]);
  });

  it("an attempt given up writes nothing more", async () => {
    const { service, take, takes } = await window({ twoStep: true });
    const target = pcFields();
    expect(await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => false, take })).toBe("refused");
    expect(await listedIds(service)).not.toContain(target.server_id);
    expect(takes).toEqual([]);
  });

  it("is offered only in this PC's own window, signed in to the account this PC is in", () => {
    expect(sshAddOffered({ ownWindow: true, signedInAccount: ACCOUNT, pcAccount: ACCOUNT })).toBe(true);
    expect(sshAddOffered({ ownWindow: true, signedInAccount: null, pcAccount: ACCOUNT })).toBe(false);
    expect(sshAddOffered({ ownWindow: true, signedInAccount: ACCOUNT, pcAccount: null })).toBe(false);
    expect(sshAddOffered({ ownWindow: true, signedInAccount: "acct_other", pcAccount: ACCOUNT })).toBe(false);
    expect(sshAddOffered({ ownWindow: false, signedInAccount: ACCOUNT, pcAccount: ACCOUNT })).toBe(false);
  });
});

describe("where Add a connection's relay tab lists the PCs to add over SSH", () => {
  const mine = { pcAddFromAccount: true as const, signedInAccount: "acct_a", pcAccount: "acct_a" };
  it("is this PC's own window only, signed in to the account this PC is in, with the account's rules on", () => {
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1" })).toBe(true);
    expect(sshAddListed({ ...mine, auth: { via: "token" }, hostname: "localhost" })).toBe(true);
    // a device paired over the LAN, signed in to the same account: not this PC's own window
    expect(sshAddListed({ ...mine, auth: { via: "token" }, hostname: "192.168.1.5" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "relay" }, hostname: "app.ovis.sh" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "tailscale" }, hostname: "desk.tail.ts.net" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: null, hostname: "127.0.0.1" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", signedInAccount: "acct_b" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", signedInAccount: null })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", pcAddFromAccount: "unavailable" })).toBe(false);
    expect(sshAddListed({ ...mine, auth: { via: "local" }, hostname: "127.0.0.1", pcAddFromAccount: undefined })).toBe(false);
  });
});

