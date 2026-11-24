import { afterEach, expect, spyOn, test } from "bun:test";
import { newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import type { DeviceConnection, DevicePairedEvent, PairedDevice } from "../../shared/protocol.ts";
import type { Access } from "../access.ts";
import { handleDeviceRequest } from "../devices.ts";
import type { ServerContext } from "../dispatch.ts";
import { handleJoinSeen, JOIN_SEEN_PATH, shownTo, type JoinViewer } from "../join-notices.ts";
import { machinePairingEvents } from "../machine-pairing-events.ts";
import { relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { EXPIRY_DAYS } from "./row-expiry.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listedPc = () => createListedPc(close => closes.push(close));
type Pc = Awaited<ReturnType<typeof listedPc>>;

/** GET /api/devices from this PC's own window (loopback). */
async function ownList(port: number): Promise<PairedDevice[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/devices`);
  expect(response.status).toBe(200);
  return (await response.json() as { devices: PairedDevice[] }).devices;
}

/** The same read at the handler, as this PC's own window, with the relay sessions `live` up. */
async function handlerList(pc: Pc, live = new Map<string, DeviceConnection>()): Promise<PairedDevice[]> {
  const response = await handleDeviceRequest(new Request("http://127.0.0.1/api/devices"), "/api/devices", pc.fixture.app.context.services.devices,
    { level: "full", via: "local", role: "drive" }, null, undefined, false, { list: () => live, check: async () => {} }, true);
  expect(response.status).toBe(200);
  return (await response.json() as { devices: PairedDevice[] }).devices;
}

test("GET /api/devices lists an account-joined row once, marked through_account, while list(null) keeps devices.json alone", async () => {
  const { fixture, device, member } = await listedPc();
  const { devices } = fixture.app.context.services;
  expect(devices.list(null).map(row => row.id)).toEqual([member.id]);
  const rows = await ownList(fixture.app.port);
  expect(rows.map(row => row.id).sort()).toEqual([member.id, device.id].sort());
  const joined = rows.find(row => row.id === device.id);
  expect(joined).toMatchObject({ label: "Laptop", role: "drive", current: false, via_relay: true, through_account: true });
  // account fields stay with devices.json members: an account-joined key signs no remove of another device
  expect(joined?.account).toBeUndefined();
  expect(joined?.account_key).toBeUndefined();
  expect(rows.find(row => row.id === member.id)?.through_account).toBeUndefined();
  expect(devices.list(null).map(row => row.id)).toEqual([member.id]);
});

test("the account-joined row's own session sees itself as this device, and the PC's window sees its connection", async () => {
  const { fixture, device, member, serverId } = await listedPc();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    const link = await relayConnection(fixture, { serverId });
    await link.auth(device);
    const answer = await ask(link, "/api/devices");
    expect(answer.status).toBe(200);
    const seen = (answer.body as unknown as { devices: PairedDevice[] }).devices;
    expect(seen.find(row => row.id === device.id)).toMatchObject({ current: true, through_account: true, remote_revoke: "allowed" });
    expect(seen.find(row => row.id === member.id)).toMatchObject({ current: false, remote_revoke: "older" });
    expect(seen.filter(row => row.current)).toHaveLength(1);
    expect((await ownList(fixture.app.port)).some(row => row.current)).toBe(false);
  } finally { clock.mockRestore(); }
});

test("the PC's own window sees how an account-joined row's session reaches it, by the row's id", async () => {
  const pc = await listedPc();
  const connection: DeviceConnection = { route: "relay", relay: "wss://relay.ovis.sh", rtt_ms: 40, since: new Date().toISOString() };
  const rows = await handlerList(pc, new Map([[pc.device.id, connection]]));
  expect(rows.find(row => row.id === pc.device.id)).toMatchObject({ through_account: true, connection });
  expect(rows.find(row => row.id === pc.member.id)?.connection).toBeUndefined();
});

test("an expired account-joined row is not listed, by the clock or by its state", async () => {
  const { fixture, device } = await listedPc();
  expect((await ownList(fixture.app.port)).some(row => row.id === device.id)).toBe(true);
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + (EXPIRY_DAYS + 1) * 86_400_000);
  try {
    expect((await ownList(fixture.app.port)).some(row => row.id === device.id)).toBe(false);
    fixture.app.context.services.accountRows?.store()?.expire();
  } finally { clock.mockRestore(); }
  expect(fixture.app.context.services.accountRows?.row(device.id)?.state).toBe("expired");
  expect((await ownList(fixture.app.port)).some(row => row.id === device.id)).toBe(false);
});

test.each(["lock", "freeze"] as const)("an account-joined row that cannot sign in here (%s) is not listed as a usable device", async change => {
  const pc = await listedPc();
  const { device } = pc;
  const { safetyLog, accountRows } = pc.fixture.app.context.services;
  expect((await handlerList(pc)).some(row => row.id === device.id)).toBe(true);
  if (change === "lock") expect(safetyLog?.appendLock({ account: ACCOUNT })).toMatchObject({ outcome: "applied" });
  else expect(safetyLog?.append({ got: "snapshot", record: { v: 1, kind: "freeze", id: `f:${"c".repeat(64)}`, account: ACCOUNT,
    target: device.publicKey, after: 1, signer: "service", signed_at: new Date().toISOString(), signature: "" } }).outcome).toBe("applied");
  // still in account-devices.json, but stale here: the list leaves it out rather than show it as one that gets in
  expect(accountRows?.row(device.id)).not.toBeNull();
  expect((await handlerList(pc)).some(row => row.id === device.id)).toBe(false);
});

test("the PC's own window renames and revokes an account-joined row by its id, through the routes every row uses", async () => {
  const pc = await listedPc();
  const { devices, accountRows } = pc.fixture.app.context.services;
  const call = (method: string, body?: unknown) => handleDeviceRequest(new Request(`http://127.0.0.1/api/devices/${pc.device.id}`, {
    method, headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), `/api/devices/${pc.device.id}`, devices, { level: "full", via: "local", role: "drive" }, null, undefined, false, undefined, true);
  const renamed = await call("PATCH", { label: "Work laptop" });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ id: pc.device.id, label: "Work laptop", through_account: true, current: false });
  expect((await handlerList(pc)).find(row => row.id === pc.device.id)).toMatchObject({ label: "Work laptop", through_account: true });
  expect((await call("DELETE")).status).toBe(204);
  expect(accountRows?.row(pc.device.id)).toBeNull();
  expect((await handlerList(pc)).map(row => row.id)).toEqual([pc.member.id]);
  expect(devices.list(null).map(row => row.id)).toEqual([pc.member.id]);
});

type Viewer = { access: Access; peer: ServerContext["peer"]; viewer: JoinViewer };

/** The device-paired notices (by label) and take-backs (by event id) a window of `viewer` hears from now on. */
function listen(fixture: Pc["fixture"], { access, peer, viewer }: Viewer) {
  const told: string[] = [];
  const taken: string[] = [];
  closes.push(machinePairingEvents({ ...fixture.app.context, peer } as ServerContext, access, [], viewer).subscribe(event => {
    if (event.type === "device-paired") told.push(event.label);
    if (event.type === "device-paired-seen") taken.push(event.event_id);
  }));
  return { told, taken };
}

function viewers(pc: Pc): Record<"own" | "member" | "joined" | "watch" | "portal", Viewer> {
  const { devices } = pc.fixture.app.context.services;
  const relayed = (id: string, key: string, role: "drive" | "watch"): Viewer => {
    const device = { id, label: id, role };
    return { access: { level: "full", via: "relay", role, device }, peer: { kind: "relay", device, sessionId: id, serverId: pc.serverId, key },
      viewer: { ownWindow: false, since: devices.addedAt(id) } };
  };
  return {
    own: { access: { level: "full", via: "local", role: "drive" }, peer: { kind: "socket" }, viewer: { ownWindow: true, since: undefined } },
    member: relayed(pc.member.id, pc.member.publicKey, "drive"),
    joined: relayed(pc.device.id, pc.device.publicKey, "drive"),
    watch: relayed(pc.member.id, pc.member.publicKey, "watch"),
    portal: { access: { level: "full", via: "portal", role: "drive" }, peer: { kind: "socket" }, viewer: { ownWindow: false, since: undefined } },
  };
}

test("one whole read's admissions are one notice, told to this PC's own window alone: no other device, no push, nobody else marks it seen", async () => {
  const pc = await listedPc();
  const { joins, devices, accountMailbox, core } = pc.fixture.app.context.services;
  const push = spyOn(core.push, "devicePaired");
  const paired: DevicePairedEvent[] = [];
  devices.onPaired(event => paired.push(event));
  const who = viewers(pc);
  const live = Object.fromEntries(Object.entries(who).map(([name, viewer]) => [name, listen(pc.fixture, viewer).told]));
  // the account-joined row the fixture admitted waits for this PC's own window only
  expect(Object.fromEntries(Object.entries(who).map(([name, { viewer }]) => [name, joins.waiting().filter(join => shownTo(join, viewer)).map(join => join.event.label)])))
    .toEqual({ own: ["Laptop"], member: [], joined: [], watch: [], portal: [] });

  for (const [label, device] of [["Tablet", await phone()], ["Pixel", await phone()]] as const) pc.service.registerDevice(ACCOUNT, device.spki, label);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  // the own window heard the waiting one as it subscribed, then this read's one live
  expect(live).toEqual({ own: ["Laptop", "Tablet +1"], member: [], joined: [], watch: [], portal: [] });
  expect(paired).toEqual([]);
  expect(push).not.toHaveBeenCalled();
  push.mockRestore();
  // a window that opens later: the own window hears both notices, an older device neither
  expect([listen(pc.fixture, who.own).told, listen(pc.fixture, who.member).told]).toEqual([["Laptop", "Tablet +1"], []]);

  const [notice] = joins.waiting().filter(join => join.event.label === "Tablet +1");
  const mark = ({ access, viewer }: Viewer) => handleJoinSeen(new Request(`http://127.0.0.1${JOIN_SEEN_PATH}`, {
    method: "POST", headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ event_id: notice!.event.event_id }),
  }), joins, access, viewer);
  expect((await mark(who.member)).status).toBe(404);
  expect((await mark(who.joined)).status).toBe(404);
  expect((await mark(who.own)).status).toBe(200);
  expect(joins.waiting().map(join => join.event.label)).toEqual(["Laptop"]);
});

test("Not me takes the notice back from this PC's own window once its row is dropped", async () => {
  const pc = await listedPc();
  const { joins, devices } = pc.fixture.app.context.services;
  const [notice] = joins.waiting();
  expect(notice?.event.label).toBe("Laptop");
  const own = listen(pc.fixture, viewers(pc).own);
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: pc.device.publicKey, signer: pc.member.publicKey,
    target_no: 2, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, pc.member.keys.privateKey);
  expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
  expect(devices.has(pc.device.id)).toBe(false);
  expect(own.taken).toEqual([notice!.event.event_id]);
  expect(joins.waiting()).toEqual([]);
});

test("a notice is told once a whole read: not again on a re-read, a sign-in or a restart", async () => {
  const { fixture, device, service, serverId } = await listedPc();
  const { joins, accountMailbox } = fixture.app.context.services;
  const told: string[] = [];
  joins.onListed(event => told.push(event.label));
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    const link = await relayConnection(fixture, { serverId });
    await link.auth(device);
  } finally { clock.mockRestore(); }
  expect(told).toEqual([]);

  const newer = await phone();
  service.registerDevice(ACCOUNT, newer.spki, "Tablet");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(told).toEqual(["Tablet"]);
  const [first] = joins.waiting();
  expect(joins.waiting().map(join => join.event.label)).toEqual(["Laptop", "Tablet"]);

  expect(joins.see(first!.event.event_id)).toBe(true);
  fixture.app.stop();
  const reopened = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.unshift(() => reopened.app.stop());
  const again: string[] = [];
  reopened.app.context.services.joins.onListed(event => again.push(event.label));
  expect(await reopened.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(again).toEqual([]);
  expect(reopened.app.context.services.joins.waiting().map(join => join.event.label)).toEqual(["Tablet"]);
});
