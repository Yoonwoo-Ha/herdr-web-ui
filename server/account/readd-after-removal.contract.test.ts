/**
 * Adding a PC again after its account removed it (the real-device run r10, route 1): the device the removal cut off
 * must get back in by the digits the PC's own window approves.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId } from "../../shared/account-records.ts";
import { openRelayChannel, type RelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice } from "../../shared/relay-device.ts";
import { channelBinding, importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_FEATURE, ACCOUNT_LISTING_ERRORS, FrameType, PAIR_INTENT_ACCOUNT, PAIR_SAS_FEATURE } from "../../shared/relay-mux.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { readDeviceRegistry } from "../devices.ts";
import { createServer } from "../index.ts";
import { DirectCarrier } from "../relay/direct.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";
import { pressOnce } from "./one-press.ts";
import { ask, linkRecord, pairingPc, phone, sendLink, SERVER_ID, setUpFor, vouchFor, type Pc, type Phone } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_1";
const ends: (() => Promise<void>)[] = [];
afterEach(async () => { for (const end of ends.splice(0).reverse()) await end(); });

type Served = Parameters<typeof relayConnection>[0];
type Decision = (served: Served, key: Phone, digits: string) => Promise<void>;

/** A comparison of digits by a device signed in to the account: "admitted", or the code the PC ended it with. */
async function compare(served: Served, key: Phone, decide: Decision): Promise<string> {
  const joiner = await relayConnection(served);
  await joiner.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  const binding = channelBinding(joiner.channel);
  if (!binding) throw new Error("Missing SAS binding");
  const nonce = randomPairNonce();
  const challenge = Promise.withResolvers<string>();
  const outcome = Promise.withResolvers<string>();
  joiner.onFrame = frame => {
    if (frame.type === FrameType.PAIR_CHALLENGE) challenge.resolve(frame.payload.nonce);
    if (frame.type === FrameType.AUTH_OK) outcome.resolve("admitted");
    if (frame.type === FrameType.SESSION_ERROR) outcome.resolve(frame.payload.code);
  };
  joiner.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Phone 2", public_key: key.spki, commitment: toBase64Url(pairCommitment(binding, key.spki, nonce)) } });
  const digits = pairDigits(binding, key.spki, nonce, fromBase64Url(await bounded(challenge.promise)));
  joiner.mux.sendSession({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  await decide(served, key, digits);
  joiner.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  return bounded(outcome.promise);
}

/** The PC's own window: its Add this PC screen holds the approve-here window open, and its owner presses Approve on the card. */
const approvedAtPc: Decision = async (served) => {
  const { approvals } = served.app.context.services.relay;
  for (let turn = 0; turn < 400; turn++) {
    const own = approvals.ownJoins()[0], shown = approvals.list()[0];
    if (own) { if (approvals.decideOwn(own.id, true) === "typed_only") throw new Error("The card took no Approve"); return; }
    if (shown) { expect(approvals.decide(shown.id, true)).toBe(true); return; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("The PC's own window was shown no join");
};

/** The PC stopped and started again from a copy of its state folder. */
async function startedAgain(f: Pc, from: Served): Promise<Served> {
  await from.app.stop();
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-readd-"));
  cpSync(from.stateDir, stateDir, { recursive: true });
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, registerBridge: false, sidecar: false,
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: f.account.fetch } });
  const closes: (() => void)[] = [];
  ends.push(async () => { for (const end of closes) end(); await app.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  await app.context.services.accountMailbox.pull();
  return { stateDir, app, closes, close() {} };
}

async function signIn(served: Served, id: string, key: Phone): Promise<string> {
  const link = await relayConnection(served);
  return link.auth({ id, keys: key.keys, publicKey: key.spki }).then(() => "admitted", () => bounded(link.serverError));
}

async function listedAndAdmitted(f: Pc): Promise<string> {
  const identity = f.app.context.services.relay.currentIdentity()!;
  const headers = { authorization: `Bearer ${f.account.issueToken(ACCOUNT, { twoStep: true })}` };
  const call = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  expect((await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).ok).toBe(true);
  return identity.server_id;
}

test.each([
  ["the PC was started again after it left", true],
  ["the PC kept running", false],
] as const)("a device the removal cut off gets back in by digits approved at the PC, once the PC is added again (%s)", async (_case, restart) => {
  const f = await pairingPc({ server: { accountOpensAll: true } });
  ends.push(() => f.close());
  f.account.opensAll = true;
  f.account.completions = true;
  await setUpFor(f, ACCOUNT);
  const listed = await listedAndAdmitted(f);
  expect((await f.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: ACCOUNT } })).status).toBe(200);

  // phone 1: paired at the PC, then linked into the account by its signed-in app
  const first = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Phone 1", first.spki)!.device;
  const reopen = async () => { const link = await relayConnection(f); await link.auth({ id: paired.id, keys: first.keys, publicKey: first.spki }); return link; };
  expect((await sendLink(await reopen(), await linkRecord(paired.id, ACCOUNT, first))).status).toBe(200);

  // phone 2: let in by phone 1's approval alone; no row of the account's list carries its key to this PC
  const second = await phone();
  f.app.context.services.relay.approvals.openWindow();
  const approver = await reopen();
  expect(await compare(f, second, async (_served, key, digits) => {
    const asked = Promise.withResolvers<string>();
    const stop = f.app.context.services.relay.approvals.subscribeRemote(list => { const prompt = list.find(entry => entry.key === key.spki); if (prompt) asked.resolve(prompt.id); });
    const id = await bounded(asked.promise).finally(stop);
    expect((await ask(approver, "/api/relay/pairing", { method: "POST", body: { id, decision: "approve", digits } })).status).toBe(200);
  })).toBe("admitted");
  const id = accountDeviceId(SERVER_ID, second.spki);
  expect(f.stored().find(row => row.id === id)).toMatchObject({ member_approved_in: ACCOUNT });
  expect(await signIn(f, id, second)).toBe("admitted");

  // "I didn't add this": the account stops listing the PC, the PC leaves it, phone 2 is cut off and phone 1 stays
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${listed}`, { method: "DELETE", headers: { authorization: `Bearer ${f.account.issueToken(ACCOUNT)}` } }))).status).toBe(204);
  await f.app.context.services.accountMailbox.pull();
  expect(f.devices.account()).toBeNull();
  expect(f.stored().some(row => row.id === id)).toBe(false);
  expect(await signIn(f, paired.id, first)).toBe("admitted");

  const served = restart ? await startedAgain(f, f) : f;
  const { devices, relay, accountMailbox } = served.app.context.services;

  // the owner adds the PC again at its own window, in one press
  await listedAndAdmitted(f);
  expect(await pressOnce({ devices, relay, accountMailbox }, ACCOUNT)).toEqual({ account: ACCOUNT });
  expect(devices.account()).toBe(ACCOUNT);

  // phone 2 asks to join again; nobody but the PC can approve, and its owner presses Approve on the PC's card
  const posted = await f.account.fetch(new Request("https://account.test/v1/admissions", { method: "POST", headers: { authorization: `Bearer ${f.account.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ server_id: listed, label: "Phone 2", key: second.spki }) }));
  expect(posted.ok).toBe(true);
  relay.approvals.openWindow(undefined, { localOnly: true });
  expect(await compare(served, second, approvedAtPc)).toBe("admitted");
  expect(await signIn(served, id, second)).toBe("admitted");

  // phone 3 is removed at the PC for good; phone 2's row stays
  const third = await phone();
  const gone = devices.pairRelayApproved("Phone 3", third.spki, { path: "code", id: accountDeviceId(SERVER_ID, third.spki) })?.device;
  if (!gone) throw new Error("The PC approved no third device");
  expect(devices.revoke(gone.id)).toBe(true);
  // the PC is started once more: what it admitted again stands, and what it removed stays out
  const later = await startedAgain(f, served);
  expect(await signIn(later, id, second)).toBe("admitted");
  expect(await signIn(later, gone.id, third)).toBe("auth_failed");
  expect(later.app.context.services.devices.has(gone.id)).toBe(false);
  // a phone that never heard its approval asks once more: the row it already has lets it in
  later.app.context.services.relay.approvals.openWindow(undefined, { localOnly: true });
  expect(await compare(later, second, approvedAtPc)).toBe("admitted");
});

test("a comparison approved at the PC for a key whose row was written but never answered lets that row in, and a removed key's stays refused", async () => {
  const f = await pairingPc({ server: { accountOpensAll: true } });
  ends.push(() => f.close());
  const key = await phone();
  const id = accountDeviceId(SERVER_ID, key.spki);
  // as a PC is left by the fault this file is about: the row is on disk, and its phone was told it was declined
  expect(f.devices.pairRelayApproved("Phone", key.spki, { path: "code", id })?.device.id).toBe(id);
  f.app.context.services.relay.approvals.openWindow(undefined, { localOnly: true });
  expect(await compare(f, key, approvedAtPc)).toBe("admitted");
  expect(f.stored().filter(row => row.relay_public_key === key.spki)).toHaveLength(1);
  expect(f.devices.revoke(id)).toBe(true);
  expect(await signIn(f, id, key)).toBe("auth_failed");
});

/** A call from the PC's own window. */
async function own(served: Served, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: { url?: string; account?: string | null; pc_add_required?: boolean } }> {
  const base = `http://127.0.0.1:${served.app.port}`;
  const response = await fetch(base + path, { method: body === undefined && path === "/api/account/status" ? "GET" : "POST",
    headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
}

function rowsOf(served: Served, key: Phone) {
  const registry = readDeviceRegistry(join(served.stateDir, "devices.json"));
  return (registry.kind === "ok" ? registry.devices : []).filter(row => row.relay_public_key === key.spki);
}

test.each([
  ["the PC was started again after it left", true],
  ["the PC kept running", false],
] as const)("a phone paired at the PC that scans the PC's own QR code after the PC left its account keeps a pairing and puts the PC back in the account (%s)", async (_case, restart) => {
  const f = await pairingPc({ server: { accountOpensAll: true } });
  ends.push(() => f.close());
  f.account.opensAll = true;
  f.account.completions = true;
  await setUpFor(f, ACCOUNT);
  const listed = await listedAndAdmitted(f);
  expect((await f.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: ACCOUNT } })).status).toBe(200);

  // the phone: its digits approved at the PC's own window, then in the account by the link its signed-in app sends
  const key = await phone();
  f.app.context.services.relay.approvals.openWindow(undefined, { localOnly: true });
  expect(await compare(f, key, approvedAtPc)).toBe("admitted");
  const [paired] = rowsOf(f, key);
  if (!paired) throw new Error("The PC wrote no row for the phone");
  const session = await relayConnection(f);
  await session.auth({ id: paired.id, keys: key.keys, publicKey: key.spki });
  expect((await sendLink(session, await linkRecord(paired.id, ACCOUNT, key))).status).toBe(200);
  expect(rowsOf(f, key)).toMatchObject([{ id: paired.id, account: ACCOUNT }]);

  // "I didn't add this": the PC leaves the account, and the phone keeps the pairing it made at the PC
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${listed}`, { method: "DELETE", headers: { authorization: `Bearer ${f.account.issueToken(ACCOUNT)}` } }))).status).toBe(204);
  await f.app.context.services.accountMailbox.pull();
  expect(f.devices.account()).toBeNull();
  expect(await signIn(f, paired.id, key)).toBe("admitted");

  const served = restart ? await startedAgain(f, f) : f;
  const { devices } = served.app.context.services;
  expect((await own(served, "/api/account/status", {})).body).toMatchObject({ account: null, pc_add_required: true });

  // the PC's own window: Add a connection names the account and shows the QR code
  expect((await own(served, "/api/account/relay-account", { "x-herdr-machine": "1" }, { account: ACCOUNT })).status).toBe(204);
  if (restart) expect((await own(served, "/api/relay/start", { "x-herdr-update": "1" })).status).toBe(200);
  const offer = await own(served, "/api/relay/offer", { "x-herdr-update": "1", "x-ovis-no-account-only": "1" });
  const code = decodeOffer(offer.body.url ?? "")?.code;
  if (code === undefined) throw new Error(`The PC showed no QR code: ${offer.status}`);

  // a page the phone still has open on the PC, under the pairing it made there
  const open = await relayConnection(served);
  await open.auth({ id: paired.id, keys: key.keys, publicKey: key.spki });
  const removed: string[] = [];
  devices.onRemoved(event => removed.push(event.device_id));

  // the phone scans it: its signed-in app lists the PC, posts its admission, pairs with the code and links
  await vouchFor(f, ACCOUNT, key, { server: served.app.context.services.relay.currentIdentity()! });
  const scan = await relayConnection(served);
  const made = await scan.pair(code, key.spki);
  const fresh = await relayConnection(served);
  await fresh.auth({ id: made.device_id, keys: key.keys, publicKey: key.spki });
  const linked = await sendLink(fresh, await linkRecord(made.device_id, ACCOUNT, key));
  expect([linked.status, linked.body.error?.code]).toEqual([200, undefined]);

  // the scan was the add at the PC: it is in the account again, and the latch is lifted
  expect(devices.account()).toBe(ACCOUNT);
  expect((await own(served, "/api/account/status", {})).body).toMatchObject({ account: ACCOUNT });
  // the record the phone's app holds after the scan signs in, and the PC has this phone once, as a member
  expect(await signIn(served, made.device_id, key)).toBe("admitted");
  expect(rowsOf(served, key)).toMatchObject([{ id: made.device_id, account: ACCOUNT }]);
  // the pairing it took the place of is no row of its own any more: its page signs in again, and nobody is told of a removal
  expect(await bounded(open.serverError)).toBe("auth_changed");
  expect(await signIn(served, paired.id, key)).toBe("auth_failed");
  expect(removed).toEqual([]);
  // and so after another start
  const later = await startedAgain(f, served);
  expect(await signIn(later, made.device_id, key)).toBe("admitted");
  expect(later.app.context.services.devices.account()).toBe(ACCOUNT);
});

test("a device that pairs again with the PC's QR code takes the place of no row that only watches: its link is refused, and that row stays", async () => {
  const f = await pairingPc({ server: { accountOpensAll: true } });
  ends.push(() => f.close());
  const key = await phone();
  const watching = f.devices.pairRelayApproved("Other PC", key.spki, { path: "vouched" })?.device;
  expect(watching?.role).toBe("watch");
  await setUpFor(f, ACCOUNT);
  const code = await f.tabCode();
  await vouchFor(f, ACCOUNT, key);
  const made = await (await relayConnection(f)).pair(code, key.spki);
  const fresh = await relayConnection(f);
  await fresh.auth({ id: made.device_id, keys: key.keys, publicKey: key.spki });
  const linked = await sendLink(fresh, await linkRecord(made.device_id, ACCOUNT, key));
  expect([linked.status, linked.body.error?.code]).toEqual([409, "key_in_use"]);
  expect(f.devices.account()).toBeNull();
  expect(rowsOf(f, key)).toMatchObject([{ id: watching!.id, role: "watch" }]);
});

/**
 * The app's own channel code (shared/relay-channel.ts) signing in with the record it saved for the row `id`: the
 * channel and how the PC ended it, or the code the PC refused the sign-in with.
 */
async function appSignIn(served: Served, id: string, key: Phone): Promise<{ channel: RelayChannel; ended: Promise<string> } | string> {
  const identity = loadRelayIdentity(served.stateDir);
  const direct = new DirectCarrier({ identity, services: served.app.context.services, port: served.app.port, addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: () => true });
  await direct.start();
  ends.push(() => direct.stop());
  const offer = { v: 1 as const, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.example.test" };
  let saved: RelayDevice | undefined = { ...offer, device_id: id, private_key: key.keys.privateKey, public_spki: key.spki, label: "Phone 2" };
  const codeOf = (error: unknown) => (error as { code?: string }).code ?? String(error);
  const ended = Promise.withResolvers<string>();
  try {
    const channel = await bounded(openRelayChannel(offer, {
      store: { get: async () => saved, update: async (_id, change) => (saved = change(saved)), list: async () => saved ? [saved] : [], remove: async () => { saved = undefined; } },
      socket: () => new WebSocket(`ws://127.0.0.1:${direct.port}/v1/ws?v=1`),
      onClose: error => ended.resolve(codeOf(error)),
    }));
    ends.push(async () => channel.close());
    return { channel, ended: ended.promise };
  } catch (error) { return codeOf(error); }
}

test("a device the account's removal of the PC cut off is told to add the PC again: on its open page, at its next sign-in and after the PC starts again", async () => {
  const f = await pairingPc({ server: { accountOpensAll: true } });
  ends.push(() => f.close());
  f.account.opensAll = true;
  f.account.completions = true;
  await setUpFor(f, ACCOUNT);
  const listed = await listedAndAdmitted(f);
  expect((await f.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: ACCOUNT } })).status).toBe(200);
  const first = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Phone 1", first.spki)!.device;
  const approver = await relayConnection(f);
  await approver.auth({ id: paired.id, keys: first.keys, publicKey: first.spki });
  expect((await sendLink(approver, await linkRecord(paired.id, ACCOUNT, first))).status).toBe(200);
  const member = await relayConnection(f);
  await member.auth({ id: paired.id, keys: first.keys, publicKey: first.spki });

  // phone 2: in by phone 1's approval, with a record of its own for the row the PC wrote
  const second = await phone();
  f.app.context.services.relay.approvals.openWindow();
  expect(await compare(f, second, async (_served, key, digits) => {
    const asked = Promise.withResolvers<string>();
    const stop = f.app.context.services.relay.approvals.subscribeRemote(list => { const prompt = list.find(entry => entry.key === key.spki); if (prompt) asked.resolve(prompt.id); });
    const prompt = await bounded(asked.promise).finally(stop);
    expect((await ask(member, "/api/relay/pairing", { method: "POST", body: { id: prompt, decision: "approve", digits } })).status).toBe(200);
  })).toBe("admitted");
  const [row] = rowsOf(f, second);
  if (!row) throw new Error("The PC wrote no row for phone 2");
  // a device this PC's owner revoked here, before the account removed the PC
  const third = await phone();
  const revoked = f.devices.pairRelay(f.devices.startPairing().code, "Phone 3", third.spki)!.device;
  expect(f.devices.revoke(revoked.id)).toBe(true);

  const page = await appSignIn(f, row.id, second);
  if (typeof page === "string") throw new Error(`Phone 2 was refused: ${page}`);
  expect(page.channel.role).toBe("drive");

  // a sign-in that said HELLO while the PC was still in the account, as a page does that reconnects while the PC asks
  const reconnecting = await relayConnection(f);
  const greeting = await reconnecting.hello([ACCOUNT_FEATURE, ACCOUNT_LISTING_ERRORS]);

  // "I didn't add this": the PC leaves the account, and the page phone 2 has open ends
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${listed}`, { method: "DELETE", headers: { authorization: `Bearer ${f.account.issueToken(ACCOUNT)}` } }))).status).toBe(204);
  await f.app.context.services.accountMailbox.pull();
  expect(f.devices.account()).toBeNull();
  expect(rowsOf(f, second)).toEqual([]);
  await bounded(page.ended);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, second.keys.privateKey,
    Buffer.concat([Buffer.from("ovis-relay-auth/1"), Buffer.from(greeting.nonce, "base64url"), Buffer.from(SERVER_ID)]))).toString("base64url");
  reconnecting.mux.sendSession({ type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "device-key", device_id: row.id, signature } });
  expect(await bounded(reconnecting.serverError)).toBe("account_readd_required");
  // the page signs in again, and so does a reload: the app has kept its record
  expect(await appSignIn(f, row.id, second)).toBe("account_readd_required");
  // and after the PC was started again
  const later = await startedAgain(f, f);
  expect(await appSignIn(later, row.id, second)).toBe("account_readd_required");
  // said only for the key that row held, and for no row this PC removed itself
  const stranger = await phone();
  expect(await appSignIn(later, row.id, stranger)).toBe("auth_failed");
  expect(await appSignIn(later, revoked.id, third)).toBe("auth_failed");
  // phone 1, paired at the PC, opens it as before
  const kept = await appSignIn(later, paired.id, first);
  expect(typeof kept === "string" ? kept : kept.channel.role).toBe("drive");
});
