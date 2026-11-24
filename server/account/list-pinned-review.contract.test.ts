/**
 * What an independent review of the PC's enforcement step attacked (docs/account.md, "The account's signed list on a
 * PC"): a pinned PC against a row a member's add made before the pin, a slow or silent account service, copies it
 * cannot use, its other state folder, a listing the service replaces, and a PC bound by one press. Beside
 * list-pinned.contract.test.ts, on the same footing: the fake account service, a state folder per PC, port 0, and the
 * PC's clocks moved by hand.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { readSave } from "../../shared/account-list-follower.ts";
import { bounded, relayAccountFixture, relayConnection, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT_LIST_FILE } from "./list-follow.ts";
import { listMember, TestList, type ListMember } from "./list.test-helpers.ts";
import { ACCOUNT, pressInto, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

type Signer = { keys: CryptoKeyPair; publicKey: string; id: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Waits for `done`, ten seconds at most, by a clock no test moves (these tests set Date.now). */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) { if (performance.now() > deadline) throw new Error(what); await Bun.sleep(5); }
}

function testTime() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  return { waits, advance(ms: number) { now += ms; waits.advance(ms); }, seconds: () => Math.floor(now / 1000) };
}

/**
 * The account service as this PC reaches it. `away`: every call fails. `stallLog`: from the call after this many
 * further `/v2/pc/list/log` calls, each log call hangs until its own abort signal fires or the test ends (a service
 * that answers as slowly as the PC's timeout lets it).
 */
function serviceControl() {
  return { away: false, stallLogAfter: null as number | null, logCalls: 0, stalled: 0, releases: [] as (() => void)[] };
}

async function listedPc() {
  const time = testTime();
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  const control = serviceControl();
  closes.push(() => { for (const release of control.releases.splice(0)) release(); });
  const fetchService = async (request: Request) => {
    if (control.away) throw new Error("The account service is away");
    if (new URL(request.url).pathname === "/v2/pc/list/log" && control.stallLogAfter !== null) {
      control.logCalls++;
      if (control.logCalls > control.stallLogAfter) {
        control.stalled++;
        await new Promise<void>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
          control.releases.push(() => reject(new Error("released")));
        });
      }
    }
    return await service.fetch(request);
  };
  const accountService = { url: "https://account.test", fetch: fetchService };
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await exportAccountKey(keys.publicKey);
  service.registerDevice(ACCOUNT, publicKey, "Laptop");
  expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const { services } = fixture.app.context;
  services.devices.useClock(time.waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const list = services.accountList!;
  const idOf = (m: ListMember): Signer => ({ keys: m.keys, publicKey: m.key, id: accountDeviceId(serverId, m.key) });
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  const signsIn = async (device: Signer): Promise<"drive" | "watch" | null> => {
    const link = await relayConnection(fixture, { serverId });
    return await link.auth(device).then((ok) => ok.role, () => null);
  };
  const rowKeys = () => services.accountRows!.rows().map((row) => row.key).sort();
  const laptop = await listMember(keys);
  const account = await TestList.start(service, ACCOUNT, undefined, time.seconds);
  await account.addDevice(laptop);
  await pull();
  return { fixture, member, service, serverId, control, accountService, time, services, endpoint, list, account, laptop, first: account.first, idOf, pull, signsIn, rowKeys, reader: { server_id: serverId } };
}

async function pinnedPc() {
  const pc = await listedPc();
  expect(await pc.list.wantList(pc.account.id)).toMatchObject({ status: { pinned: false, want: pc.account.id } });
  await pc.account.addPostedPc(pc.endpoint);
  await pc.pull();
  expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", list: pc.account.id });
  pc.time.advance(JOIN_HOLD_MS + 1_000);
  return pc;
}

/** A member's v1 `add` of `device` to this PC, signed by the account phone of the fixture (a member in devices.json). */
async function v1Add(pc: Awaited<ReturnType<typeof listedPc>>, device: ListMember, label: string) {
  const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: device.key, label, role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: pc.member.publicKey }, pc.member.keys.privateKey);
  return await applyAccountRecords(pc.services.devices, [add], pc.serverId);
}

// The names say what each test shows now. R1 to R16 are the sections of the independent review of #4607 these tests
// were written for; the first three groups failed on the head that was reviewed.
describe("R1 (D): a key the list holds, that a member's v1 add brought in before the pin, under the very id the list's row has", () => {
  test("opens as the role the list gives it (watch), not as the old row's drive", async () => {
    const pc = await listedPc();
    const tablet = await listMember();
    expect((await v1Add(pc, tablet, "Tablet"))[0]).toMatchObject({ outcome: "applied" });
    // the list holds the tablet to watch, for two minutes
    await pc.account.addDevice(tablet, { role: "watch", power: "bound", until: pc.time.seconds() + 120 });
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    // the app opens the PC through its account under accountDeviceId(server_id, key): the v1 row has that same id
    expect([pc.services.devices.has(pc.idOf(tablet).id), pc.services.devices.isAccountRow(pc.idOf(tablet).id)]).toEqual([true, false]);
    expect(await pc.signsIn(pc.idOf(tablet))).toBe("watch");
  });

  test("is refused once its until has passed by the PC's clock", async () => {
    const pc = await listedPc();
    const tablet = await listMember();
    expect((await v1Add(pc, tablet, "Tablet"))[0]).toMatchObject({ outcome: "applied" });
    await pc.account.addDevice(tablet, { role: "watch", power: "bound", until: pc.time.seconds() + 120 });
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    pc.time.advance(150_000);
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status().devices).toBe(3);
    expect(await pc.signsIn(pc.idOf(tablet))).toBeNull();
  });

  test("an open session of that row closes at the until", async () => {
    const pc = await listedPc();
    const tablet = await listMember();
    expect((await v1Add(pc, tablet, "Tablet"))[0]).toMatchObject({ outcome: "applied" });
    await pc.account.addDevice(tablet, { power: "bound", until: pc.time.seconds() + 120 });
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(tablet))).toMatchObject({ role: "drive" });
    pc.time.advance(120_000);
    pc.list.tick();
    await pc.list.settled();
    expect(await bounded(link.serverError.then(String), 2000).catch(() => "still open")).toBe("auth_revoked");
  });
});

describe("a session open under the account's id for a key, at the moment the PC pins", () => {
  test("ends with auth_changed, and its next sign-in gets the list's answer: nothing for a key the list does not hold, the list's role for one it does", async () => {
    const pc = await listedPc();
    const [outside, tablet] = [await listMember(), await listMember()];
    expect((await v1Add(pc, outside, "Outside"))[0]).toMatchObject({ outcome: "applied" });
    expect((await v1Add(pc, tablet, "Tablet"))[0]).toMatchObject({ outcome: "applied" });
    // the list holds the tablet to watch, and does not hold the other
    await pc.account.addDevice(tablet, { role: "watch", power: "bound" });
    const links = [await relayConnection(pc.fixture, { serverId: pc.serverId }), await relayConnection(pc.fixture, { serverId: pc.serverId })];
    expect(await links[0]!.auth(pc.idOf(outside))).toMatchObject({ role: "drive" });
    expect(await links[1]!.auth(pc.idOf(tablet))).toMatchObject({ role: "drive" });
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    for (const link of links) expect(await bounded(link.serverError.then(String), 2000).catch(() => "still open")).toBe("auth_changed");
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.idOf(outside))).toBeNull();
    expect(await pc.signsIn(pc.idOf(tablet))).toBe("watch");
  });
});

describe("a second Ovis server on the state folder, when the first one pins", () => {
  /** A PC that is not pinned yet, with a row under the account's id for a key the list will not hold, and a second server on its folder. */
  async function twoServers(step2: boolean) {
    const pc = await listedPc();
    const outside = await listMember();
    expect((await v1Add(pc, outside, "Outside"))[0]).toMatchObject({ outcome: "applied" });
    const second = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: step2, accountService: pc.accountService });
    closes.push(() => second.app.stop());
    const link = await relayConnection(second, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(outside))).toMatchObject({ role: "drive" });
    // the first server pins
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    const signsIn = async (device: Signer) => await (await relayConnection(second, { serverId: pc.serverId })).auth(device).then((ok) => ok.role, () => null);
    return { pc, second, outside, link, signsIn };
  }

  test("one that follows the list too closes its sessions under an account's id and decides by the list from then on", async () => {
    const { pc, second, outside, link, signsIn } = await twoServers(true);
    second.app.context.services.accountList!.tick();
    expect(await bounded(link.serverError.then(String), 2000).catch(() => "still open")).toBe("auth_changed");
    expect(second.app.context.services.devices.listFollowed()).toBe(true);
    expect(await signsIn(pc.idOf(outside))).toBeNull();
  });

  test("one that was started with Step 2 off, and so follows no list, closes its account part: no session under an account's id, no account record, and it says why", async () => {
    const { pc, second, outside, link, signsIn } = await twoServers(false);
    const { devices } = second.app.context.services;
    expect(second.app.context.services.accountList).toBeNull();
    second.app.context.services.pinWatch!();
    expect(await bounded(link.serverError.then(String), 2000).catch(() => "still open")).toBe("auth_changed");
    expect(await signsIn(pc.idOf(outside))).toBeNull();
    expect(devices.accountError).toContain("pinned to its account's signed list");
    // a member's signed add adds nobody there
    const stranger = await listMember();
    const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: stranger.key, label: "Stranger", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: pc.member.publicKey }, pc.member.keys.privateKey);
    expect((await applyAccountRecords(devices, [add], pc.serverId))[0]).toMatchObject({ outcome: "refused" });
    // the pairing this PC made itself, under an id of its own, still opens it
    expect(await signsIn({ keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id })).toBe("drive");
  });
});

describe("R2 (C/G): a read that the account service answers slowly holds back nothing the PC has verified", () => {
  test("a removal a member hands over is applied while a service read hangs", async () => {
    const pc = await pinnedPc();
    const held = pc.list.status().head!;
    // the service withholds the removal of the laptop
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq });
    const removal = await pc.account.remove(pc.laptop.key);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    // and now answers the PC's log reads as slowly as it may (each one up to the PC's own 15 s timeout)
    pc.control.stallLogAfter = 0;
    pc.list.heard(ACCOUNT, { id: pc.account.id, head: { seq: held.seq + 3, hash: "ab".repeat(32) } });
    await until(() => pc.control.stalled === 1, "the PC's read did not go out");
    // a member hands the PC the removal directly (the path that exists for a service that withholds)
    const taken = pc.list.takeFromPeer({ list: pc.account.id, after: held.seq, entries: [removal], head: pc.account.place });
    const outcome = await Promise.race([taken.then((verdict) => ({ verdict })), sleep(3_000).then(() => "still waiting" as const)]);
    expect(outcome).not.toBe("still waiting");
  });

  test("while it hangs, a device a member's page removed loses its open session", async () => {
    const pc = await pinnedPc();
    const held = pc.list.status().head!;
    pc.service.tamperList(pc.account.id, { reader: pc.reader, withholdAfter: held.seq });
    const removal = await pc.account.remove(pc.laptop.key);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    pc.control.stallLogAfter = 0;
    pc.list.heard(ACCOUNT, { id: pc.account.id, head: { seq: held.seq + 3, hash: "ab".repeat(32) } });
    await until(() => pc.control.stalled === 1, "the PC's read did not go out");
    void pc.list.takeFromPeer({ list: pc.account.id, after: held.seq, entries: [removal], head: pc.account.place });
    await until(() => pc.services.devices.sessionRow(pc.idOf(pc.laptop).id) === null, "the removed device kept its session while the read hung");
  });

  test("a removal on the first page of a read is acted on while a later page hangs", async () => {
    const pc = await pinnedPc();
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    const before = pc.list.status().head!;
    await pc.account.remove(pc.laptop.key);
    await pc.account.addDevice(await listMember());
    // the first page ends right after the removal, and the service says more follows; the second page hangs
    pc.service.tamperList(pc.account.id, { reader: pc.reader, pages: [before.seq + 1] });
    pc.control.stallLogAfter = 1;
    pc.list.heard(ACCOUNT, { id: pc.account.id, head: pc.account.place });
    await until(() => pc.control.stalled === 1, "the second page was not asked for");
    // the PC has read and verified the removal of the laptop: it is acted on while the next page hangs
    await until(() => pc.services.devices.sessionRow(pc.idOf(pc.laptop).id) === null, "the removal on the first page waited for the second");
  });
});

describe("R3 (C): an until is ended by the PC's own timer, also while the follower's queue is held by a read", () => {
  test("the session closes at the second, with no tick and no read finishing", async () => {
    const pc = await pinnedPc();
    const borrowed = await listMember();
    await pc.account.addDevice(borrowed, { power: "bound", until: pc.time.seconds() + 120 });
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(borrowed))).toMatchObject({ role: "drive" });
    // a second before the until, a pull re-arms the PC's timer at about one second
    pc.time.advance(120_000 - JOIN_HOLD_MS - 1_000 - 1_500);
    await pc.pull();
    // the queue is then held by a read the service does not answer
    pc.control.stallLogAfter = 0;
    pc.list.heard(ACCOUNT, { id: pc.account.id, head: { seq: 99, hash: "ab".repeat(32) } });
    await until(() => pc.control.stalled >= 1, "the PC's read did not go out");
    pc.time.advance(2_000);
    expect(await bounded(link.serverError.then(String), 3_500).catch(() => "still open")).toBe("auth_revoked");
  });
});

describe("R4 (D): an act of the person at the PC stands against the list", () => {
  test("a list device the owner revoked at the PC is not let in again by the next read of the list", async () => {
    const pc = await pinnedPc();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    expect(pc.services.devices.revoke(pc.idOf(pc.laptop).id)).toBe(true);
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    pc.list.tick();
    await pc.list.settled();
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBeNull();
  });
});

describe("R5 (A/F): copies the PC cannot use", () => {
  test("a copy saved by a newer follower version fails closed for the list, keeps the owner's own pairing, and says why", async () => {
    const pc = await pinnedPc();
    pc.fixture.app.stop();
    const path = join(pc.fixture.stateDir, ACCOUNT_LIST_FILE);
    const file = JSON.parse(readFileSync(path, "utf8")) as { save: string };
    // the save of a later build: its version field says 2
    const newer = file.save.replace(/"v":1/, "\"v\":2");
    expect(newer).not.toBe(file.save);
    writeFileSync(path, JSON.stringify({ ...file, save: newer }));
    expect(await readSave(newer)).toMatchObject({ read: false });
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { services } = again.app.context;
    await services.accountMailbox.pull();
    await services.accountList!.settled();
    expect(services.devices.listFollowed()).toBe(true);
    expect(services.accountList!.status().error).toContain(ACCOUNT_LIST_FILE);
    const signsIn = async (device: Signer) => await (await relayConnection(again, { serverId: pc.serverId })).auth(device).then((ok) => ok.role, () => null);
    expect(await signsIn(pc.idOf(pc.laptop))).toBeNull();
    // the account phone this PC paired itself still opens it
    expect(await signsIn({ keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id })).toBe("drive");
  });

  test("ovis status --json's source, GET /api/account/status, says that the PC lets no device of its list in", async () => {
    const pc = await pinnedPc();
    pc.fixture.app.stop();
    const path = join(pc.fixture.stateDir, ACCOUNT_LIST_FILE);
    writeFileSync(path, readFileSync(path, "utf8").slice(0, -40));
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const base = `http://127.0.0.1:${again.app.port}`;
    const status = await (await fetch(`${base}/api/account/status`, { headers: { origin: base, "x-herdr-machine": "1" } })).json() as Record<string, unknown>;
    // anything in what the CLI reads that tells the person the list cannot be followed
    expect(JSON.stringify(status)).toMatch(/account-list\.json|list/);
  });
});

describe("R6 (F): the other state folder of a pinned PC, which does not hold the pin (a pin is never taken from another folder)", () => {
  /** A pinned PC in folder A; folder B a copy of A without the pin. B starts with A as its sibling. */
  async function otherFolder(step2 = true) {
    const pc = await pinnedPc();
    pc.fixture.app.stop();
    const { cpSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const b = mkdtempSync(join(tmpdir(), "ovis-rv-sib-"));
    closes.push(() => rmSync(b, { recursive: true, force: true }));
    cpSync(pc.fixture.stateDir, b, { recursive: true });
    const doc = JSON.parse(readFileSync(join(b, "account-pc.json"), "utf8")) as { binding: Record<string, unknown> };
    delete doc.binding.list;
    delete doc.binding.list_alarm;
    writeFileSync(join(b, "account-pc.json"), JSON.stringify({ ...doc, v: 1 }));
    const again = relayFixture(false, { stateDir: b, siblingStateDir: pc.fixture.stateDir, accountOpensAll: step2, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    return { pc, again, b };
  }

  test("says which folder holds the pin in what `ovis status --json` reads", async () => {
    const { pc, again } = await otherFolder();
    const base = `http://127.0.0.1:${again.app.port}`;
    const status = await (await fetch(`${base}/api/account/status`, { headers: { origin: base, "x-herdr-machine": "1" } })).json() as { error?: { code?: string; reason?: string } };
    expect(status.error?.code).toBe("strict");
    expect(status.error?.reason).toContain("pinned to its account's signed list");
    expect(status.error?.reason).toContain(pc.fixture.stateDir);
  });

  test("lets no device of the account in, takes no pin and writes nothing of its own, also after its next start", async () => {
    const { pc, again, b } = await otherFolder();
    const file = () => readFileSync(join(b, "account-pc.json"), "utf8");
    const before = file();
    const signsIn = async (app: typeof again) => await (await relayConnection(app, { serverId: pc.serverId })).auth(pc.idOf(pc.laptop)).then((ok) => ok.role, () => null);
    expect(await signsIn(again)).toBeNull();
    expect(again.app.context.services.devices.listFollowed()).toBe(false);
    again.app.stop();
    const next = relayFixture(false, { stateDir: b, siblingStateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => next.app.stop());
    expect(await signsIn(next)).toBeNull();
    expect(file()).toBe(before);
    // the folder that holds the pin goes on as it was
    next.app.stop();
    const home = relayFixture(false, { stateDir: pc.fixture.stateDir, siblingStateDir: b, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => home.app.stop());
    home.app.context.services.devices.useClock(pc.time.waits);
    await home.app.context.services.accountMailbox.pull();
    await home.app.context.services.accountList!.settled();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(home.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(await signsIn(home)).toBe("drive");
  });

  test("that start writes nothing: every file both folders held keeps its bytes, and neither gains a file of this PC's devices or account", async () => {
    const pc = await pinnedPc();
    pc.fixture.app.stop();
    const { cpSync, mkdtempSync, readdirSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const b = mkdtempSync(join(tmpdir(), "ovis-rv-sib-"));
    closes.push(() => rmSync(b, { recursive: true, force: true }));
    cpSync(pc.fixture.stateDir, b, { recursive: true });
    const doc = JSON.parse(readFileSync(join(b, "account-pc.json"), "utf8")) as { binding: Record<string, unknown> };
    delete doc.binding.list;
    writeFileSync(join(b, "account-pc.json"), JSON.stringify({ ...doc, v: 1 }));
    // every file of a folder, by its path under it
    const files = (dir: string): Map<string, string> => {
      const found = new Map<string, string>();
      const walk = (at: string) => {
        for (const name of readdirSync(join(dir, at))) {
          const path = join(at, name);
          if (statSync(join(dir, path)).isDirectory()) walk(path); else found.set(path, readFileSync(join(dir, path)).toString("base64"));
        }
      };
      walk("");
      return found;
    };
    const before = { a: files(pc.fixture.stateDir), b: files(b) };
    const again = relayFixture(false, { stateDir: b, siblingStateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    again.app.stop();
    const after = { a: files(pc.fixture.stateDir), b: files(b) };
    for (const side of ["a", "b"] as const) {
      for (const [path, bytes] of before[side]) expect([side, path, after[side].get(path) === bytes]).toEqual([side, path, true]);
    }
    // what a start makes anew is its own log and guards, never a record of devices, of the account or of a merge
    const made = [...after.a.keys()].filter((path) => !before.a.has(path)).concat([...after.b.keys()].filter((path) => !before.b.has(path)));
    expect(made.filter((path) => /devices|account|merge|tombstone|safety|journal|evidence/.test(path))).toEqual([]);
    expect([...after.a.keys()].filter((path) => !before.a.has(path))).toEqual([]);
  });

  test("with Step 2 turned off in that folder it is closed all the same: a member's v1 add adds nobody", async () => {
    const { pc, again } = await otherFolder(false);
    const { devices } = again.app.context.services;
    const stranger = await listMember();
    const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: stranger.key, label: "Stranger", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: pc.member.publicKey }, pc.member.keys.privateKey);
    expect((await applyAccountRecords(devices, [add], pc.serverId))[0]).toMatchObject({ outcome: "refused" });
    expect(devices.hasKey(stranger.key)).toBe(false);
  });
});

describe("R7 (F/A): a list key that a pre-pin v1 add row also holds, while the PC cannot use its copy", () => {
  test("is not let in while the copy does not read (the PC fails closed for its list)", async () => {
    const pc = await listedPc();
    const tablet = await listMember();
    expect((await v1Add(pc, tablet, "Tablet"))[0]).toMatchObject({ outcome: "applied" });
    await pc.account.addDevice(tablet);
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    pc.fixture.app.stop();
    const path = join(pc.fixture.stateDir, ACCOUNT_LIST_FILE);
    writeFileSync(path, readFileSync(path, "utf8").slice(0, -40));
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { services } = again.app.context;
    services.devices.useClock(pc.time.waits);
    await services.accountMailbox.pull();
    await services.accountList!.settled();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(services.accountList!.status().error).toContain(ACCOUNT_LIST_FILE);
    const signsIn = async (device: Signer) => await (await relayConnection(again, { serverId: pc.serverId })).auth(device).then((ok) => ok.role, () => null);
    expect(await signsIn(pc.idOf(pc.laptop))).toBeNull();
    expect(await signsIn(pc.idOf(tablet))).toBeNull();
  });

  test("is held back by a fork alarm like every device the PC did not hold when it rose", async () => {
    const pc = await listedPc();
    const tablet = await listMember();
    expect((await v1Add(pc, tablet, "Tablet"))[0]).toMatchObject({ outcome: "applied" });
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    await pc.pull();
    expect(pc.list.status().pinned).toBe(true);
    // a fork is shown; the honest history then adds the tablet: the alarm holds it back
    const { texts } = await pc.account.forkFromStart();
    pc.service.tamperList(pc.account.id, { reader: pc.reader, fork: texts });
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status().alarm).toBe("fork");
    pc.service.untamperList(pc.account.id);
    await pc.account.addDevice(tablet);
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.idOf(tablet))).toBeNull();
  });
});

describe("R8 (A/C): what the snapshot says decides no row of a pinned PC", () => {
  test("the snapshot naming a list device as removed takes it out of nothing", async () => {
    const pc = await pinnedPc();
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    pc.service.removeDevice(ACCOUNT, pc.laptop.key);
    await pc.pull();
    expect(await pc.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(pc.services.devices.sessionRow(pc.idOf(pc.laptop).id)?.role).toBe("drive");
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });
});

describe("R9 (F): a service that turned Step 2 off before the PC pinned", () => {
  test("shuts none of the list's devices out once the PC is pinned", async () => {
    const pc = await listedPc();
    pc.service.opensAll = false;
    pc.service.reportsStep2Off = true;
    await pc.pull();
    pc.service.opensAll = true;
    pc.service.reportsStep2Off = false;
    await pc.list.wantList(pc.account.id);
    await pc.account.addPostedPc(pc.endpoint);
    pc.service.opensAll = false;
    pc.service.reportsStep2Off = true;
    await pc.pull();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.list.status().pinned).toBe(true);
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });
});

describe("R10 (B): a listing the service replaces takes a pinned PC out of nothing", () => {
  test("removed and listed again under a new listing: the pinned PC stays in its account and lets its devices in", async () => {
    const pc = await pinnedPc();
    const { PcAccountState } = await import("./pc-binding.ts");
    const listing = PcAccountState.open(pc.fixture.stateDir).binding()?.listing_id;
    expect(listing).toMatch(/^[0-9a-f]{32}$/);
    const url = `https://account.test/v1/pcs/${pc.serverId}`;
    const headers = { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` };
    expect((await pc.service.fetch(new Request(url, { method: "DELETE", headers }))).status).toBe(204);
    expect((await pc.service.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.test" }) }))).status).toBe(200);
    await pc.pull();
    expect(pc.services.devices.account()).toBe(ACCOUNT);
    expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
    // from here the PC's reads of the snapshot may add nobody; one that names a list device as removed puts none out
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(pc.laptop))).toMatchObject({ role: "drive" });
    pc.service.removeDevice(ACCOUNT, pc.laptop.key);
    await pc.pull();
    await pc.services.accountMailbox.readSnapshot();
    expect(pc.rowKeys()).toContain(pc.laptop.key);
    expect(pc.services.devices.sessionRow(pc.idOf(pc.laptop).id)?.role).toBe("drive");
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });
});

describe("R11 (C): an until that passed with no sign-in after it", () => {
  test("stays passed after a restart within the minute, with the clock set back and the service away", async () => {
    const pc = await pinnedPc();
    const borrowed = await listMember();
    const until = pc.time.seconds() + 120;
    await pc.account.addDevice(borrowed, { power: "bound", until });
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    expect(await link.auth(pc.idOf(borrowed))).toMatchObject({ role: "drive" });
    // half a minute before the until a pull saves the copy (and its hour)
    pc.time.advance((until - 30 - pc.time.seconds()) * 1000);
    await pc.pull();
    // then the service goes away, and the until passes: the PC's own clock ends the session; nobody signs in after it
    pc.control.away = true;
    pc.time.advance(32_000);
    pc.list.tick();
    await pc.list.settled();
    expect(await bounded(link.serverError.then(String), 2_000).catch(() => "still open")).toBe("auth_revoked");
    pc.fixture.app.stop();
    // a restart with the clock set back to before the until, the service still away
    pc.time.advance(-12_000);
    const again = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true, accountService: pc.accountService });
    closes.push(() => again.app.stop());
    const { services } = again.app.context;
    services.devices.useClock(pc.time.waits);
    await services.accountMailbox.pull();
    await services.accountList!.settled();
    expect(pc.time.seconds()).toBeLessThan(until);
    const role = await (await relayConnection(again, { serverId: pc.serverId })).auth(pc.idOf(borrowed)).then((ok) => ok.role, () => null);
    expect(role).toBeNull();
  });
});

describe("R12 (A): a member's v1 add that the account service delivers through the PC's mailbox", () => {
  test("adds nobody on a pinned PC", async () => {
    const pc = await pinnedPc();
    const stranger = await listMember();
    const record = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: stranger.key, label: "Stranger", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: pc.member.publicKey }, pc.member.keys.privateKey);
    const posted = await pc.service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` }, body: JSON.stringify({ server_ids: [pc.serverId], record }) }));
    expect(posted.status).toBe(200);
    await pc.pull();
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.services.devices.has(pc.idOf(stranger).id)).toBe(false);
    expect(await pc.signsIn(pc.idOf(stranger))).toBeNull();
  });
});

describe("R13 (D): a key held only by a pairing of the PC's own, signing in under its account id", () => {
  test("is refused once the list lets that key in no more (its until passed), though the pairing stands", async () => {
    const pc = await pinnedPc();
    const phone = await listMember(pc.member.keys);
    await pc.account.addDevice(phone, { power: "bound", until: pc.time.seconds() + 60 });
    await pc.pull();
    expect(await pc.signsIn(pc.idOf(phone))).toBe("drive");
    pc.time.advance(61_000);
    // no tick, no read: the sign-in alone
    expect(await pc.signsIn(pc.idOf(phone))).toBeNull();
    expect(await pc.signsIn({ keys: pc.member.keys, publicKey: pc.member.publicKey, id: pc.member.id })).toBe("drive");
  });
});

describe("R14 (B): the account service that stopped listing a pinned PC, a while later", () => {
  test("still shuts none of the list's devices out once the listing answer it gave last has aged", async () => {
    const pc = await pinnedPc();
    const headers = { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` };
    expect((await pc.service.fetch(new Request(`https://account.test/v1/pcs/${pc.serverId}`, { method: "DELETE", headers }))).status).toBe(204);
    await pc.pull();
    pc.time.advance(5 * 60_000);
    await pc.pull();
    expect(pc.services.devices.account()).toBe(ACCOUNT);
    expect(await pc.signsIn(pc.idOf(pc.laptop))).toBe("drive");
  });
});

describe("R16 (B): a PC bound by its own one press (on the service's word), then pinned", () => {
  test("the service that stops listing it shuts none of the list's devices out, a minute later too", async () => {
    const time = testTime();
    const service = new FakeAccountService();
    service.opensAll = true;
    service.listAccounts = "*";
    const accountService = { url: "https://account.test", fetch: (request: Request) => service.fetch(request) };
    const fixture = relayFixture(false, { accountOpensAll: true, accountService });
    closes.push(() => fixture.close());
    const { services } = fixture.app.context;
    services.devices.useClock(time.waits);
    (await import("../relay/identity.ts")).rotateRelayIdentity(fixture.stateDir);
    await pressInto(service, services);
    expect(services.devices.serviceBinding()).not.toBeNull();
    const serverId = services.relay.currentIdentity()!.server_id;
    const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
    const list = services.accountList!;
    const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
    const account = await TestList.start(service, ACCOUNT, undefined, time.seconds);
    const laptop = await listMember();
    await account.addDevice(laptop);
    await pull();
    expect(await list.wantList(account.id)).toMatchObject({ status: { want: account.id } });
    await account.addPostedPc(endpoint);
    await pull();
    expect(list.status()).toMatchObject({ pinned: true, standing: "in" });
    time.advance(JOIN_HOLD_MS + 1_000);
    const idOf = (m: ListMember): Signer => ({ keys: m.keys, publicKey: m.key, id: accountDeviceId(serverId, m.key) });
    const signsIn = async (device: Signer) => await (await relayConnection(fixture, { serverId })).auth(device).then((ok) => ok.role, () => null);
    expect(await signsIn(idOf(laptop))).toBe("drive");
    const headers = { authorization: `Bearer ${service.issueToken(ACCOUNT)}` };
    expect((await service.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers }))).status).toBe(204);
    await pull();
    time.advance(2 * 60_000);
    await pull();
    expect(services.devices.account()).toBe(ACCOUNT);
    expect(list.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(await signsIn(idOf(laptop))).toBe("drive");
  });
});
