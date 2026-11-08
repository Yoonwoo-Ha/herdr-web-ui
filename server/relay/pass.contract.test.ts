import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import { passPolicy } from "../../relay/pass.ts";
import { RELAY_PASS_HEADER, signRelayPass } from "../../shared/relay-pass.ts";
import { offerFromCode } from "../../shared/relay-code-offer.ts";
import { proofKey, serverChallenge, verifyServerProof } from "../../shared/relay-server-proof.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { createServer } from "../index.ts";
import { RelayService, type RelayServiceOptions } from "./service.ts";
import { loadRelayIdentity } from "./identity.ts";
import { bounded, deferred } from "./test-helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const KID = "0badc0de";

/** An enforcing Bun relay, an account service that lists this PC under `acct_1` only, and a PC that may use them. */
async function fixture(mode: "grace" | "enforce" = "enforce", extra: Partial<RelayServiceOptions> = {}, relayKeys?: string) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  // the relay trusts the account service's key unless the test names others
  const pass = await passPolicy({ RELAY_PASS_MODE: mode, RELAY_PASS_ENFORCE_AT: "2099-01-01T00:00:00Z", RELAY_PASS_KEYS: relayKeys ?? `${KID}:${Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("")}` });
  const allow = { async limit() { return { success: true }; } };
  const relay = startBunRelay({ port: 0, pass, limiters: { perAddress: allow, global: allow } });
  cleanup.push(() => relay.stop());
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-pass-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const origin = `wss://127.0.0.1:${relay.port}`;
  const challenges = new Map<string, string>();
  const asked: string[] = [];
  /** the accounts that list this PC */
  const listed = new Set(["acct_1"]);
  const hooks: { refused?: () => void; limited?: () => void } = {};
  /** the accounts that have as many PCs on the relay as they may */
  const limited = new Set<string>();
  const accountFetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const body = await request.json() as Record<string, string>;
    asked.push(path);
    if (path === "/v1/pc/challenge") {
      const id = crypto.randomUUID().replace(/-/g, "");
      const { expected, frame } = serverChallenge(proofKey(body["public_key"])!, { server_id: body["server_id"]!, role: "account", connection_id: id });
      challenges.set(id, expected);
      return Response.json({ challenge_id: id, frame });
    }
    const expected = challenges.get(body["challenge_id"] ?? "");
    challenges.delete(body["challenge_id"] ?? "");
    if (!expected || !verifyServerProof(body["proof"], expected)) return Response.json({ error: { code: "proof_invalid" } }, { status: 401 });
    if (!listed.has(body["account"] ?? "")) { hooks.refused?.(); return Response.json({ error: { code: "not_listed" } }, { status: 403 }); }
    if (limited.has(body["account"] ?? "")) { hooks.limited?.(); return Response.json({ error: { code: "relay_limit" } }, { status: 409 }); }
    return Response.json({ pass: await signRelayPass(pair.privateKey, KID, body["server_id"]!, Math.floor(Date.now() / 1000)), expires_in: 172_800, refresh_in: 43_200 });
  };
  /** what each control socket heard first after its proof, and how it closed */
  const syncs: Record<string, unknown>[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  /** what the PC sent on its control sockets after the proof */
  const sentOnControl: string[] = [];
  const renewal = deferred<string>();
  let synced = deferred<Record<string, unknown>>();
  let refused = deferred<{ code: number; reason: string }>();
  /** refusals so far by reason, and who waits for how many of one */
  const refusals = new Map<string, number>();
  const waiting: { reason: string; times: number; resolve: () => void }[] = [];
  const refusedFor = (reason: string, times = 1) => {
    const done = deferred<void>();
    if ((refusals.get(reason) ?? 0) >= times) done.resolve();
    else waiting.push({ reason, times, resolve: () => done.resolve() });
    return done.promise;
  };
  const connect = (url: string, extra?: Record<string, string>) => {
    const target = new URL(url);
    headers.push(extra);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`, (extra ? { headers: extra } : undefined) as unknown as string[]);
    if (target.pathname === "/v1/ws" && !target.searchParams.has("connection_id") && !target.searchParams.has("warm")) {
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") { sentOnControl.push(data); if (data.includes('"relay_pass"')) renewal.resolve(data); }
        send(data);
      };
      socket.addEventListener("message", (event) => {
        const value = typeof event.data === "string" ? JSON.parse(event.data) as Record<string, unknown> : null;
        if (value?.["type"] === "sync") { syncs.push(value); synced.resolve(value); }
      });
      socket.addEventListener("close", (event) => {
        if (event.code !== 4402) return;
        refused.resolve({ code: event.code, reason: event.reason });
        const count = (refusals.get(event.reason) ?? 0) + 1;
        refusals.set(event.reason, count);
        for (const waiter of waiting.filter((entry) => entry.reason === event.reason && entry.times <= count)) waiter.resolve();
      });
    }
    return socket;
  };
  const options = { stateDir, relay: origin, regionalRelays: [], connect, accountService: "https://account.test", accountFetch, ovisRelays: [origin], pairCodeRelay: origin, ...extra };
  let service = new RelayService(options);
  let app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service });
  cleanup.push(async () => { await service.shutdown(); app.stop(); });
  const base = () => `http://127.0.0.1:${app.port}`;
  return {
    stateDir, origin, relayPort: relay.port, asked, headers, syncs, listed, hooks, limited, sentOnControl, renewal: renewal.promise,
    get service() { return service; },
    refusedFor,
    get synced() { return synced.promise; },
    get refused() { return refused.promise; },
    async start() {
      const response = await fetch(`${base()}/api/relay/start`, { method: "POST", headers: { origin: base(), "x-herdr-update": "1" } });
      expect(response.status).toBe(200);
    },
    nameAccount: (account: string) => fetch(`${base()}/api/account/relay-account`, {
      method: "POST", headers: { origin: base(), "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ account }),
    }),
    async restart(changes: Partial<typeof options> = {}) {
      await service.shutdown();
      app.stop();
      synced = deferred();
      refused = deferred();
      service = new RelayService({ ...options, ...changes });
      app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service });
    },
  };
}

test("an enforcing relay refuses a PC with no account to name; once its owner names one it gets a pass and comes online", async () => {
  const f = await fixture();
  await f.start();
  expect(await bounded(f.refused)).toEqual({ code: 4402, reason: "relay pass required" });
  const refused = f.service.status();
  expect(refused.phase).toBe("error");
  expect(refused.pass).toEqual({ state: "no_account", relay: null, enforce_at: null, refused: true });
  expect(f.asked).toEqual([]);
  // an account that does not list this PC gets no pass
  expect((await f.nameAccount("acct_2")).status).toBe(204);
  expect((await f.nameAccount("not an id")).status).toBe(400);
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  expect((await bounded(f.synced))["relay_pass"]).toEqual({ state: "ok", enforce_at: "2099-01-01T00:00:00.000Z" });
  const online: RelayStatus = f.service.status();
  expect(online.phase).toBe("online");
  expect(online.error_code).toBeNull();
  expect(online.pass).toEqual({ state: "ok", relay: "ok", enforce_at: "2099-01-01T00:00:00.000Z", refused: false });
  // sent in a header on every PC socket, never in the address
  expect(f.headers.at(-1)?.[RELAY_PASS_HEADER]).toStartWith("ovp1.");
  expect(existsSync(join(f.stateDir, "relay", "pass.json"))).toBe(true);
});

test("a PC the relay refuses for its pass says why as a fixed code: no account to name, not listed by the one it names, or at its limit", async () => {
  for (const [account, code] of [[null, "pass_required"], ["acct_2", "pass_not_listed"], ["acct_1", "pass_limit"]] as const) {
    // the keeper waits half an hour after each of these answers: that wait being set says the answer is in
    const answered = deferred<void>();
    const passClock = { now: () => Date.now(), setTimeout: (callback: () => void, ms: number) => {
      if (ms === 30 * 60_000) answered.resolve();
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    } };
    const f = await fixture("enforce", { passClock });
    f.limited.add("acct_1");
    if (account !== null) expect((await f.nameAccount(account)).status).toBe(204);
    await f.start();
    await bounded(f.refused);
    await bounded(answered.promise);
    expect(f.service.status()).toMatchObject({ phase: "error", error_code: code });
  }
});

test("a PC whose pass the relay refuses (a key it does not trust) says pass_refused, and one with no account service says pass_unsupported", async () => {
  const untrusted = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", untrusted.publicKey)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const f = await fixture("enforce", {}, `${KID}:${raw}`);
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  // a pass this PC kept under another key: its control socket carries it from the start, so no retry waits on a timer
  const identity = loadRelayIdentity(f.stateDir);
  const stale = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  mkdirSync(join(f.stateDir, "relay"), { recursive: true });
  writeFileSync(join(f.stateDir, "relay", "pass.json"), JSON.stringify({ pass: await signRelayPass(stale.privateKey, KID, identity.server_id, Math.floor(Date.now() / 1000)), server_id: identity.server_id, expires_at: Date.now() + 3_600_000, refresh_at: Date.now() + 3_600_000 }));
  await f.start();
  // the kept pass refused is replaced at once, and the replacement goes out at once on a new control socket: refused too,
  // the PC holds a pass the relay will not take
  await bounded(f.refusedFor("relay pass invalid", 2));
  expect(f.service.status()).toMatchObject({ phase: "error", error_code: "pass_refused" });
  const off = await fixture("enforce", { accountService: undefined });
  await off.start();
  await bounded(off.refused);
  expect(off.service.status()).toMatchObject({ phase: "error", error_code: "pass_unsupported" });
});

test("a restarted PC goes online on the pass it saved, without asking the account service", async () => {
  const f = await fixture();
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await f.start();
  await bounded(f.synced);
  const asked = f.asked.length;
  expect(asked).toBeGreaterThan(0);
  await f.restart();
  await f.start();
  expect((await bounded(f.synced))["relay_pass"]).toEqual({ state: "ok", enforce_at: "2099-01-01T00:00:00.000Z" });
  expect(f.asked).toHaveLength(asked);
});

test("a relay that is not Ovis's gets no pass, and the account service is never asked", async () => {
  const f = await fixture();
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await f.restart({ ovisRelays: [] });
  await f.start();
  await bounded(f.refused);
  expect(f.headers.every((sent) => sent === undefined)).toBe(true);
  expect(f.asked).toEqual([]);
  expect(f.service.status().pass).toBeUndefined();
});

test("on an enforcing relay, a PC with its pass holds its typed code's nameplate by proving its key, and a device finds the PC there", async () => {
  const f = await fixture();
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await f.start();
  await bounded(f.synced);
  const minted = await bounded(f.service.pairCode());
  const offer = await bounded(offerFromCode(minted!.code, { relay: f.origin, connect: (address) => new WebSocket(address.replace(f.origin, `ws://127.0.0.1:${f.relayPort}`)) }));
  expect(offer.server_id).toBe(minted!.server_id);
});

test("a pass the relay refuses is dropped and a new one asked for at once", async () => {
  const f = await fixture();
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  // a pass this PC kept, signed under a key the relay no longer trusts
  const identity = loadRelayIdentity(f.stateDir);
  const stale = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  mkdirSync(join(f.stateDir, "relay"), { recursive: true });
  writeFileSync(join(f.stateDir, "relay", "pass.json"), JSON.stringify({ pass: await signRelayPass(stale.privateKey, KID, identity.server_id, Math.floor(Date.now() / 1000)), server_id: identity.server_id, expires_at: Date.now() + 3_600_000, refresh_at: Date.now() + 3_600_000 }));
  await f.start();
  expect(await bounded(f.refused)).toEqual({ code: 4402, reason: "relay pass invalid" });
  expect((await bounded(f.synced))["relay_pass"]).toEqual({ state: "ok", enforce_at: "2099-01-01T00:00:00.000Z" });
  expect(f.service.status().phase).toBe("online");
});

test("a pass renewed while online goes to the relay on the open control socket", async () => {
  const f = await fixture();
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await f.start();
  await bounded(f.synced);
  // another account (which does not list this PC), then back: the PC asks again and renews on the open socket
  expect((await f.nameAccount("acct_2")).status).toBe(204);
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  expect(JSON.parse(await bounded(f.renewal))).toEqual({ type: "relay_pass", pass: expect.stringMatching(/^ovp1\./) });
});

test("in grace, a PC that signs in sends its pass on the open control socket and the sign-in notice is over", async () => {
  const f = await fixture("grace");
  await f.start();
  expect((await bounded(f.synced))["relay_pass"]).toEqual({ state: "missing", enforce_at: "2099-01-01T00:00:00.000Z" });
  expect(f.service.status().pass).toMatchObject({ relay: "missing", enforce_at: "2099-01-01T00:00:00.000Z" });
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await bounded(f.renewal);
  expect(f.service.status().pass).toEqual({ state: "ok", relay: "ok", enforce_at: "2099-01-01T00:00:00.000Z", refused: false });
});

test("naming the same account again asks the account service nothing more", async () => {
  const f = await fixture();
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await f.start();
  await bounded(f.synced);
  const asked = f.asked.length;
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  expect(f.asked).toHaveLength(asked);
});

test("naming the same account again asks again while this PC holds no pass (it was not listed a moment ago)", async () => {
  const f = await fixture("grace");
  // the account does not list the PC when it first asks; the add-me screen puts it back right after
  f.listed.clear();
  f.hooks.refused = () => f.listed.add("acct_1");
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await f.start();
  await bounded(f.synced);
  // the screen names the same account again: with no pass held, the PC asks again and renews on the open socket
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  expect(JSON.parse(await bounded(f.renewal))).toEqual({ type: "relay_pass", pass: expect.stringMatching(/^ovp1\./) });
});

test("naming the same account again keeps the scheduled retry after a refusal for the account's limit", async () => {
  const f = await fixture("grace");
  const answered = deferred<void>();
  f.hooks.limited = () => answered.resolve();
  f.limited.add("acct_1");
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  await f.start();
  await bounded(f.synced);
  // the limit answer lands; the add-me screen relists and names the same account, twice
  await bounded(answered.promise);
  const asked = f.asked.length;
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  expect((await f.nameAccount("acct_1")).status).toBe(204);
  expect(f.asked).toHaveLength(asked);
});
