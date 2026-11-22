import { afterEach, expect, spyOn, test } from "bun:test";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { bounded, relayAccountFixture, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT, createListedPc, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { PcAccountState } from "./pc-binding.ts";
import { exportAccountKey } from "../../shared/account-records.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { STALE_READ_MS } from "./account-devices.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { parseSnapshotPage } from "../../shared/account-snapshot.ts";
import type { WsStream } from "../../shared/relay-mux-engine.ts";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { privateStateFs } from "../private-state.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey } from "../../shared/relay-e2ee.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T56: a failed service past one hour closes account-only sessions and refuses their sign-ins and requests", async () => {
  const clock = new TestClock();
  const epoch = Date.now();
  let correction = 0;
  const time = spyOn(Date, "now").mockImplementation(() => epoch + clock.now() + correction);
  closes.push(() => time.mockRestore());
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  devices.useClock(clock);
  clock.advance(JOIN_HOLD_MS);
  const schedule = clock.setTimeout.bind(clock);
  spyOn(clock, "setTimeout").mockImplementation((fire, ms) => schedule(fire, ms === STALE_READ_MS ? ms - 1 : ms));
  // Refresh through the real mailbox with the PC clock installed, not by supplying staleness to the row store: the
  // hour below counts from this whole read
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const session = await relayConnection(pc.fixture, { serverId: pc.serverId, websocket: pc.fixture.app.context.services.core.socketHandlers });
  await session.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  const socket = session.openSocket();
  await socket.opened;
  await socket.until(message => message.type === "features");
  expect((await ask(session, "/api/account/status")).status).toBe(200);
  const errors: string[] = [];
  session.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) errors.push(frame.payload.code); };
  pc.service.opensAll = false;

  clock.advance(STALE_READ_MS - 1);
  correction = 60_000;
  await accountMailbox.pull();
  expect((await ask(session, "/api/account/status")).status).toBe(200);
  correction = -1;
  clock.advance(1);
  expect(await bounded(socket.closed)).toMatchObject({ code: 1008 });
  expect(devices.canDrive(pc.device.id)).toBe(false);
  expect(await bounded(session.serverError)).toBe("auth_changed");
  await session.flush();
  expect(errors).toEqual(["auth_changed"]);
  await expect(ask(session, "/api/account/status")).rejects.toThrow();
  const refused = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let hold: unknown;
  refused.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) hold = frame.payload.hold; };
  void refused.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => undefined);
  expect(await bounded(refused.serverError)).toBe("held");
  expect(hold).toEqual({ reason: "catching_up" });

  pc.service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const recovered = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await recovered.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(recovered, "/api/account/status")).status).toBe(200);
});

test("T56: a failed service past one hour also ends an account member kept in devices.json, and the PC keeps its account", async () => {
  const clock = new TestClock();
  const pc = await createListedPc(close => closes.push(close), clock);
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  // a member's remote approval makes the listed device a devices.json member: no snapshot row bounds it any more
  expect(devices.pairRelayApproved("Laptop", pc.device.publicKey, { path: "account", addedBy: pc.member.id, id: pc.device.id })?.device.id).toBe(pc.device.id);
  expect(devices.accountOnly(pc.device.id)).toBe(true);
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => wall.mockRestore());
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const session = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await session.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(session, "/api/health")).status).toBe(200);
  pc.service.opensAll = false;
  await accountMailbox.pull();
  clock.advance(STALE_READ_MS - 1);
  expect((await ask(session, "/api/health")).status).toBe(200);
  clock.advance(1);
  expect(await bounded(session.serverError)).toBe("auth_changed");
  expect(devices.sessionRow(pc.device.id)).toBeNull();
  expect(devices.account()).toBe(ACCOUNT);
  const refused = await relayConnection(pc.fixture, { serverId: pc.serverId });
  void refused.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => undefined);
  expect(await bounded(refused.serverError)).toBe("held");
  // a pairing made at this PC is no account access: it stays
  const local = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await local.auth(pc.member);
  // a row a member paired here approves after the hour waits like the rest
  const late = await phone();
  const lateId = accountDeviceId(pc.serverId, late.spki);
  expect(devices.pairRelayApproved("Late", late.spki, { path: "account", addedBy: pc.member.id, id: lateId })?.device.id).toBe(lateId);
  expect(devices.sessionRow(lateId)).toBeNull();
  const waits = await relayConnection(pc.fixture, { serverId: pc.serverId });
  void waits.auth({ id: lateId, keys: late.keys, publicKey: late.spki }, [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => undefined);
  expect(await bounded(waits.serverError)).toBe("held");

  pc.service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const recovered = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await recovered.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(recovered, "/api/health")).status).toBe(200);
});

test("T56: a request at the monotonic hour is refused before timer delivery", async () => {
  const clock = new TestClock();
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  devices.useClock(clock);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  closes.push(() => wall.mockRestore());
  const session = await relayConnection(pc.fixture, { serverId: pc.serverId });
  await session.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(session, "/api/health")).status).toBe(200);
  // Advance the clock reading independently of its callback queue (a busy event loop).
  const elapsed = spyOn(clock, "now").mockReturnValue(STALE_READ_MS);
  closes.push(() => elapsed.mockRestore());
  await expect(ask(session, "/api/health")).rejects.toThrow();
  expect(await bounded(session.serverError)).toBe("auth_changed");
});

test("T56: a failed method journal leaves the previous read deadline in force", async () => {
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  const clock = new TestClock();
  devices.useClock(clock);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const closedAt: number[] = [];
  devices.onRevoke(pc.device.id, () => closedAt.push(clock.now()));
  clock.advance(STALE_READ_MS - 1);
  const page = accountMailbox.snapshotPage.bind(accountMailbox);
  spyOn(accountMailbox, "snapshotPage").mockImplementation(async (...args) => {
    const result = await page(...args);
    if (!("page" in result)) return result;
    const parsed = parseSnapshotPage(result.page);
    return { page: { ...parsed, methods_version: parsed.methods_version + 1 } };
  });
  const fault = spyOn(DeviceJournal.prototype, "append").mockImplementationOnce(() => { throw new Error("journal unavailable"); });
  closes.push(() => fault.mockRestore());
  expect(await accountMailbox.readSnapshot()).toBeNull();
  expect(fault.mock.calls[0]?.[0].kind).toBe("method");
  clock.advance(1);
  expect(closedAt).toEqual([STALE_READ_MS]);
});

test("a waiting block that fails closed during list admission cannot renew whole-read freshness", async () => {
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  const clock = new TestClock();
  devices.useClock(clock);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  clock.advance(1);
  const { spki } = await phone();
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: spki, target_no: 3,
    signer: pc.member.publicKey, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, pc.member.keys.privateKey);
  expect(await devices.applyBlock(record, "mailbox")).toMatchObject({ reason: "unknown_target" });
  pc.service.registerDevice(ACCOUNT, spki, "Phone");
  const rename = privateStateFs.renameSync;
  const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith("/account-log.json")) throw new Error("unwritable safety log");
    rename(from, to);
  });
  try {
    const outcome = await accountMailbox.readSnapshot();
    expect(devices.failsClosed).toBe(true);
    expect(devices.openNotices().some(entry => entry.key === spki)).toBe(false);
    expect(outcome?.committed ?? false).toBe(false);
    expect([...clock.tasks.values()].map(task => task.at)).not.toContain(1 + STALE_READ_MS);
  } finally { fault.mockRestore(); }
});

test("T56: a page delivered after server shutdown starts no new deadline", async () => {
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  const clock = new TestClock();
  devices.useClock(clock);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const fetched = Promise.withResolvers<void>();
  const deliver = Promise.withResolvers<void>();
  const page = accountMailbox.snapshotPage.bind(accountMailbox);
  spyOn(accountMailbox, "snapshotPage").mockImplementationOnce(async (...args) => {
    const result = await page(...args);
    fetched.resolve();
    await deliver.promise;
    return result;
  });
  const reading = accountMailbox.readSnapshot();
  await bounded(fetched.promise);
  pc.fixture.app.stop();
  expect(clock.tasks.size).toBe(0);
  deliver.resolve();
  const outcome = await bounded(reading);
  expect(clock.tasks.size).toBe(0);
  expect(outcome?.committed).toBe(false);
});

test("T56: a server-originated WebSocket frame also checks elapsed freshness", async () => {
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  const clock = new TestClock();
  devices.useClock(clock);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  closes.push(() => wall.mockRestore());
  const opened = Promise.withResolvers<WsStream>();
  const link = await relayConnection(pc.fixture, {
    serverId: pc.serverId, onWs: stream => { stream.accept(); opened.resolve(stream); },
  });
  await link.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]);
  const socket = link.openSocket();
  await socket.opened;
  const server = await bounded(opened.promise);
  server.send(JSON.stringify({ type: "pong" }));
  await link.flush();
  expect(socket.messages).toHaveLength(1);
  spyOn(clock, "now").mockReturnValue(STALE_READ_MS);
  server.send(JSON.stringify({ type: "pong" }));
  await link.flush();
  expect(socket.messages).toHaveLength(1);
});

test.each(["removed", "removed and listed again"] as const)("a PC bound by a device's link leaves its account when the account's listing of it is %s, and a pairing made here stays", async (how) => {
  const pc = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox, relay } = pc.fixture.app.context.services;
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => wall.mockRestore());
  expect(devices.serviceBinding()).toBeNull();
  // the pull names the listing the account's rows are let in under
  await accountMailbox.pull();
  const open = async (device: { id: string; keys: CryptoKeyPair; publicKey: string }) => {
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    return link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "admitted", () => bounded(link.serverError));
  };
  expect(await open(pc.device)).toBe("admitted");
  const identity = relay.currentIdentity()!;
  const url = `https://account.test/v1/pcs/${pc.serverId}`;
  const headers = { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` };
  expect((await pc.service.fetch(new Request(url, { method: "DELETE", headers }))).status).toBe(204);
  if (how === "removed and listed again") {
    expect((await pc.service.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test" }) }))).status).toBe(200);
  }
  await accountMailbox.pull();
  expect(devices.account()).toBeNull();
  expect(devices.addAtPcRequired()).toBe(true);
  expect(await open(pc.device)).toBe("auth_failed");
  expect(await open(pc.member)).toBe("admitted");
  // nothing a later read finds brings the rows back
  await accountMailbox.pull();
  expect(devices.account()).toBeNull();
  expect(await open(pc.device)).toBe("auth_failed");
});

/**
 * A PC as an update finds it: bound by a device's link before listings were kept (its binding names none), listed by its
 * account, with the account's rows it let in before. `answer`: what a call to the account service gets instead of the
 * service's own answer.
 */
async function linkBoundPc(answer?: (request: Request, service: FakeAccountService) => Promise<Response | undefined>) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true,
    accountService: { url: "https://account.test", fetch: async (request) => await answer?.(request, service) ?? service.fetch(request) } });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await exportAccountKey(keys.publicKey);
  service.registerDevice(ACCOUNT, publicKey, "Laptop");
  const { devices, accountMailbox } = fixture.app.context.services;
  // as every read before the update: the service is asked for no listing, so none is named
  service.completions = false;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  service.completions = true;
  const wall = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => wall.mockRestore());
  const open = async (device: { id: string; keys: CryptoKeyPair; publicKey: string }) => {
    const link = await relayConnection(fixture, { serverId });
    return { link, answer: await link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "admitted", () => bounded(link.serverError)) };
  };
  const binding = () => PcAccountState.open(fixture.stateDir).binding();
  const listed = async () => {
    const pcs = await (await service.fetch(new Request("https://account.test/v1/pcs", { headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` } }))).json() as { pcs: { server_id: string; listing_id?: string }[] };
    return pcs.pcs.find(row => row.server_id === serverId)?.listing_id;
  };
  return { fixture, member, device: { keys, publicKey, id: accountDeviceId(serverId, publicKey) }, service, serverId, devices, accountMailbox, open, binding, listed };
}

test("update: a PC bound by a link that its account lists keeps its account, its rows and its sessions, with nothing done by anyone", async () => {
  const pc = await linkBoundPc();
  expect(pc.binding()).toMatchObject({ account: ACCOUNT });
  expect(pc.binding()?.listing_id).toBeUndefined();
  // the first read after the update
  await pc.accountMailbox.pull();
  const listing = await pc.listed();
  expect(listing).toMatch(/^[0-9a-f]{32}$/);
  expect(pc.binding()).toMatchObject({ account: ACCOUNT, listing_id: listing });
  const account = await pc.open(pc.device);
  const own = await pc.open(pc.member);
  expect([account.answer, own.answer]).toEqual(["admitted", "admitted"]);
  for (let poll = 0; poll < 3; poll++) await pc.accountMailbox.pull();
  expect((await ask(account.link, "/api/health")).status).toBe(200);
  expect((await ask(own.link, "/api/health")).status).toBe(200);
  expect(pc.binding()).toMatchObject({ account: ACCOUNT, listing_id: listing });
  expect(pc.devices.addAtPcRequired()).toBe(false);
  expect(PcAccountState.open(pc.fixture.stateDir).clears()).toEqual([]);
});

const pathOf = (request: Request) => new URL(request.url).pathname;
test.each([
  ["the account service is down", async () => new Response(null, { status: 503 })],
  ["its snapshot does not parse", async (request: Request) => pathOf(request) === "/v1/pc/snapshot" ? Response.json({ last: true }) : undefined],
  ["its mailbox does not parse", async (request: Request) => pathOf(request) === "/v1/pc/mailbox" ? Response.json({ listing_id: "f".repeat(32) }) : undefined],
  ["its mailbox names a listing that is no listing ID", async (request: Request, service: FakeAccountService) =>
    pathOf(request) === "/v1/pc/mailbox" ? Response.json({ ...await (await service.fetch(request)).json() as object, listing_id: "L1" }) : undefined],
  ["its mailbox names another listing in an answer that does not parse", async (request: Request) => pathOf(request) === "/v1/pc/mailbox" ? Response.json({ listing_id: "e".repeat(32), records: "none" }) : undefined],
] as const)("update: a PC bound by a link clears nothing when %s at its first read, and names its listing at the next", async (_case, failing) => {
  let fails = false;
  const pc = await linkBoundPc(async (request, service) => fails ? failing(request, service) : undefined);
  fails = true;
  for (let poll = 0; poll < 2; poll++) await pc.accountMailbox.pull();
  expect(pc.devices.account()).toBe(ACCOUNT);
  expect(pc.binding()?.listing_id).toBeUndefined();
  expect(PcAccountState.open(pc.fixture.stateDir).clears()).toEqual([]);
  expect(pc.devices.addAtPcRequired()).toBe(false);
  expect((await pc.open(pc.member)).answer).toBe("admitted");
  // the account's device it let in before still gets in
  expect((await pc.open(pc.device)).answer).toBe("admitted");
  fails = false;
  await pc.accountMailbox.pull();
  expect(pc.binding()).toMatchObject({ account: ACCOUNT, listing_id: await pc.listed() });
  expect((await pc.open(pc.device)).answer).toBe("admitted");
});

test("update: a PC bound by a link that its account no longer lists leaves it at its first read, and a pairing made here stays", async () => {
  const pc = await linkBoundPc();
  expect((await pc.service.fetch(new Request(`https://account.test/v1/pcs/${pc.serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` } }))).status).toBe(204);
  await pc.accountMailbox.pull();
  expect(pc.devices.account()).toBeNull();
  expect(pc.devices.addAtPcRequired()).toBe(true);
  expect((await pc.open(pc.member)).answer).toBe("admitted");
  expect((await pc.open(pc.device)).answer).toBe("auth_failed");
});

test.each([
  ["its mailbox does not answer", async (request: Request) => pathOf(request) === "/v1/pc/mailbox" ? new Response(null, { status: 503 }) : undefined],
  ["its mailbox names no listing", async (request: Request, service: FakeAccountService) =>
    pathOf(request) === "/v1/pc/mailbox" ? Response.json({ ...await (await service.fetch(request)).json() as object, listing_id: null }) : undefined],
] as const)("a PC bound by a link lets no new device of the account in while %s, and keeps its account", async (_case, failing) => {
  let fails = false;
  const pc = await linkBoundPc(async (request, service) => fails ? failing(request, service) : undefined);
  await pc.accountMailbox.pull();
  expect(pc.binding()?.listing_id).toBe(await pc.listed());
  const late = await phone();
  pc.service.registerDevice(ACCOUNT, late.spki, "Late");
  const lateId = accountDeviceId(pc.serverId, late.spki);
  fails = true;
  await pc.accountMailbox.pull();
  expect(await pc.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  expect(pc.devices.has(lateId)).toBe(false);
  expect(pc.devices.account()).toBe(ACCOUNT);
  fails = false;
  await pc.accountMailbox.pull();
  expect(pc.devices.has(lateId)).toBe(true);
});

test("a read of its own asks which listing the account names now: one named at an earlier pull lets nobody in", async () => {
  const pc = await linkBoundPc();
  await pc.accountMailbox.pull();
  const headers = { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` };
  const url = `https://account.test/v1/pcs/${pc.serverId}`;
  expect((await pc.service.fetch(new Request(url, { method: "DELETE", headers }))).status).toBe(204);
  await registerSnapshotPc(pc.service, pc.fixture, pc.fixture.app.context.services.relay.currentIdentity()!);
  const late = await phone();
  pc.service.registerDevice(ACCOUNT, late.spki, "Late");
  await pc.accountMailbox.readSnapshot();
  expect(pc.devices.has(accountDeviceId(pc.serverId, late.spki))).toBe(false);
  expect(pc.devices.account()).toBeNull();
});

test("a read that may not widen still drops the listed devices its snapshot says the account removed", async () => {
  let fails = false;
  const pc = await linkBoundPc(async (request) => fails && pathOf(request) === "/v1/pc/mailbox" ? new Response(null, { status: 503 }) : undefined);
  await pc.accountMailbox.pull();
  const open = await pc.open(pc.device);
  expect(open.answer).toBe("admitted");
  pc.service.removeDevice(ACCOUNT, pc.device.publicKey);
  fails = true;
  await pc.accountMailbox.pull();
  expect(pc.devices.has(pc.device.id)).toBe(false);
  expect(await bounded(open.link.serverError)).toBe("auth_revoked");
  expect((await pc.open(pc.device)).answer).toBe("auth_failed");
  expect(pc.devices.account()).toBe(ACCOUNT);
});

test("a read of its own takes no listing from a mailbox answer the pull would reject", async () => {
  let garbled = false;
  const pc = await linkBoundPc(async (request) => garbled && pathOf(request) === "/v1/pc/mailbox" ? Response.json({ listing_id: "e".repeat(32), records: "invalid" }) : undefined);
  await pc.accountMailbox.pull();
  const listing = await pc.listed();
  garbled = true;
  await pc.accountMailbox.readSnapshot();
  expect(pc.binding()).toMatchObject({ account: ACCOUNT, listing_id: listing });
  expect(PcAccountState.open(pc.fixture.stateDir).clears()).toEqual([]);
});

test("a mailbox answer asked for one binding names no listing for the binding that replaced it meanwhile", async () => {
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const pc = await linkBoundPc(async (request, service) => {
    if (!hold || pathOf(request) !== "/v1/pc/mailbox") return undefined;
    hold = false;
    const answer = await (await service.fetch(request)).json() as object;
    asked.resolve();
    await release.promise;
    // what the account named for the old binding
    return Response.json({ ...answer, listing_id: "a".repeat(32) });
  });
  hold = true;
  const pull = pc.accountMailbox.pull();
  await bounded(asked.promise);
  const before = pc.binding()?.bind_id;
  expect(pc.devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
  const fresh = await phone();
  const paired = pc.devices.pairRelay(pc.devices.startPairing().code, "Phone", fresh.spki)!.device;
  expect(pc.devices.linkAccountKey(paired.id, fresh.spki, fresh.spki, ACCOUNT)).not.toBeNull();
  expect(pc.binding()?.bind_id).not.toBe(before);
  release.resolve();
  await pull;
  expect(pc.binding()).toMatchObject({ account: ACCOUNT });
  expect(pc.binding()?.listing_id).not.toBe("a".repeat(32));
  await pc.accountMailbox.pull();
  expect(pc.devices.account()).toBe(ACCOUNT);
  expect(pc.binding()?.listing_id).toBe(await pc.listed());
});
