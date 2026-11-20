/**
 * The lock where access is decided (device-row-states rows P11, S24, N1-N7, R7, T46): with a lock in this PC's log, a
 * row not approved at this PC's screen, a loopback window without screen proof and every grant that is not a row are
 * refused, while this PC's own programs keep working. A PC in no account offers no lock.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PcAccountState } from "./pc-binding.ts";
import { LockSignal, untilLockFrom } from "../lock-boundary.ts";
import { firstPairingRead, pairingPc, memberRow, signIn, type Pc } from "./pairing.test-helpers.ts";
import { bounded, deferred, relayFixture } from "../relay/test-helpers.ts";
import { handleRequest } from "../dispatch.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

const BRIDGE_TOKEN = "b".repeat(64);

async function expectLocalSnapshot(pc: Pc) {
  const snapshot = { version: "fixture", protocol: 22, agents: [], layouts: [], panes: [], tabs: [], workspaces: [] };
  const read = spyOn(pc.app.context.services.core, "clientSnapshot").mockResolvedValue(snapshot);
  try {
    const tried = await pc.local("/api/session", { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } });
    expect([tried.status, tried.body]).toEqual([200, { snapshot }]);
  } finally { read.mockRestore(); }
}

async function lockedPc() {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, bridgeToken: BRIDGE_TOKEN } });
  pcs.push(made);
  const receipt = made.app.context.services.safetyLog!.appendLock({ account: "acct_1" });
  expect(receipt.outcome).toBe("applied");
  return Object.assign(made, { member });
}

test("T46: a locked PC refuses relay sign-in from a row that could sign in before the lock", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  await firstPairingRead(made);
  const signed = await signIn(made, member.row.id, member.key);
  if ("error" in signed) throw new Error(`The relay fixture could not sign in before locking: ${signed.error}`);
  const receipt = made.app.context.services.safetyLog?.appendLock({ account: "acct_1" });
  expect(receipt?.outcome).toBe("applied");
  const tried = await signIn(made, member.row.id, member.key);
  expect(tried).toEqual({ error: "auth_failed" });
});

test("N4: a locked PC refuses a loopback window that gave no screen proof", async () => {
  const made = await lockedPc();
  const tried = await made.local("/api/devices");
  expect([tried.status, tried.body.error?.code]).toEqual([403, "locked"]);
});

test("N6: this PC's own programs keep working while it is locked", async () => {
  const made = await lockedPc();
  await expectLocalSnapshot(made);
});

test("T46: an unlocked PC is as before", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  expect((await made.local("/api/devices")).status).toBe(200);
});

test("T46: a PC in no account offers no lock", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  const tried = await made.local("/api/account/lock", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
  expect([tried.status, tried.body.error?.code]).toEqual([409, "not_bound"]);
  expect((await made.local("/api/account/lock")).body.bound).toBe(false);
});

test("T47: on a locked PC, this PC's own window may read the lock and ask for an unlock, which only the screen grants", async () => {
  const made = await lockedPc();
  const read = await made.local("/api/account/lock");
  expect(read.status).toBe(200);
  const lockId = read.body.locked as string;
  expect(lockId).toMatch(/./);
  const asked = await made.local("/api/account/unlock", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { lock: lockId } });
  expect(asked.status).toBe(202);
  expect((await made.local("/api/account/lock")).body.locked).toBe(lockId);
  expect((await made.local("/api/devices")).body.error?.code).toBe("locked");
});

test("T47: a forwarded window gets no such passage on a locked PC", async () => {
  const made = await lockedPc();
  const tried = await made.local("/api/account/lock", { headers: { "x-forwarded-for": "100.64.0.9" } });
  expect(tried.status).toBeGreaterThanOrEqual(400);
});

test("P11: a lock holds whatever account it names, the PC's binding or another", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  expect(made.app.context.services.safetyLog!.appendLock({ account: "acct_other" }).outcome).toBe("applied");
  expect((await made.local("/api/devices")).body.error?.code).toBe("locked");
});

test("S19: a log that cannot be read is stricter than locked: no window without screen proof gets in, yet it can read why", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, bridgeToken: BRIDGE_TOKEN },
    startRelay: false, prepare: (dir) => { writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  expect((await made.local("/api/devices")).body.error?.code).toBe("strict");
  expect((await made.local("/api/account/lock")).body.strict).toBe(true);
  await expectLocalSnapshot(made);
});

test("P11: a lock taken under the PC's account holds after that binding is cleared and the PC bound to another account", async () => {
  const made = await lockedPc();
  const binding = PcAccountState.open(made.stateDir);
  binding.clear("left_on_pc", "pc");
  binding.bind("acct_2", made.member.key.spki);
  expect((await made.local("/api/devices")).body.error?.code).toBe("locked");
});

test("S19: while the log cannot be read, the PC's screen still confirms acts", async () => {
  let push!: (line: string) => void;
  const input = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(line)); } });
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true, desktopOwner: { input, write: () => {} } },
    prepare: (dir) => { writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  const confirms = made.app.context.services.localConfirms!;
  const { id } = confirms.request({ kind: "leave_account" }, { title: "Leave the account", lines: [] });
  push(`${JSON.stringify({ approve: id })}\n`);
  expect(await bounded(confirms.answer(id))).toBe("approved");
});

test("N4: no browser window drives a locked PC this release, whatever cookie it brings", async () => {
  const made = await lockedPc();
  for (const cookie of ["ovis_screen=1", "ovis_token=x", `ovis_device=${"a".repeat(64)}`]) {
    expect((await made.local("/api/devices", { headers: { cookie } })).body.error?.code).toBe("locked");
  }
});

test("N4: on a locked PC, a direct loopback window gets 403 locked on everything but reading the lock and asking for an unlock", async () => {
  const made = await lockedPc();
  for (const [path, method] of [["/api/devices", "GET"], ["/api/session", "GET"], ["/api/account/status", "GET"], ["/api/account/lock", "POST"], ["/api/relay/offer", "POST"]] as const) {
    const tried = await made.local(path, { method, headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, ...(method === "POST" ? { body: {} } : {}) });
    expect([path, tried.status, tried.body.error?.code]).toEqual([path, 403, "locked"]);
  }
  expect((await made.local("/api/account/lock")).status).toBe(200);
});

/** A bound PC whose screen a test answers through the desktop owner channel. */
async function screenedPc() {
  const member = await memberRow("acct_1");
  const told: { pending: { id: string; action: { kind: string } }[] }[] = [];
  let push!: (line: string) => void;
  const input = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(line)); } });
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, desktopOwner: { input, write: (line) => { told.push(JSON.parse(line)); } } } });
  pcs.push(made);
  const approve = (kind: string) => {
    const open = told.at(-1)?.pending.find((entry) => entry.action.kind === kind);
    if (!open) throw new Error(`nothing waits for ${kind}`);
    push(`${JSON.stringify({ approve: open.id })}\n`);
  };
  return Object.assign(made, { member, approve });
}

test("T46/S24: the screen's approval of a lock ends a connection already open on a grant that is not a row", async () => {
  const made = await screenedPc();
  const socket = new WebSocket(`ws://127.0.0.1:${made.app.port}/ws`);
  const opened = deferred<void>(), closed = deferred<number>();
  socket.onopen = () => opened.resolve();
  socket.onclose = (event) => closed.resolve(event.code);
  await bounded(opened.promise);
  const asked = await made.local("/api/account/lock", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
  expect(asked.status).toBe(202);
  made.approve("lock");
  await bounded(closed.promise);
  expect(made.app.context.services.safetyLog!.state().locked).toBe(true);
});

test("S19/P11: an admission order that cannot be read refuses a loopback window as an unreadable log does, and the lock says strict", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], startRelay: false, server: { accountOpensAll: true },
    prepare: (dir) => { writeFileSync(join(dir, "account-pc.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  expect(made.devices.failsClosed).toBe(true);
  const tried = await made.local("/api/devices");
  expect([tried.status, tried.body.error?.code]).toEqual([403, "strict"]);
  expect((await made.local("/api/account/lock")).body.strict).toBe(true);
});

test("P11/T47: an unlock the screen approves ends the lock it names, under the account that lock was taken in, whatever the binding is now", async () => {
  const made = await screenedPc();
  const log = made.app.context.services.safetyLog!;
  const lock = log.appendLock({ account: "acct_old" });
  expect(lock.outcome).toBe("applied");
  const asked = await made.local("/api/account/unlock", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { lock: lock.id } });
  expect(asked.status).toBe(202);
  // the route's own continuation was registered on the answer first, so it has written by the time this await returns
  const answered = made.app.context.services.localConfirms!.answer(asked.body.confirm as string);
  made.approve("unlock");
  expect(await bounded(answered)).toBe("approved");
  expect(log.state().locked).toBe(false);
});

test("T47/N4: on a PC with an access token, the owner's own window (loopback, the token) may read the lock and ask for an unlock, which only the screen grants", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], startRelay: false, server: { accountOpensAll: true, token: "owner-token" } });
  pcs.push(made);
  const lock = made.app.context.services.safetyLog!.appendLock({ account: "acct_1" });
  const auth = { authorization: "Bearer owner-token" };
  const read = await made.local("/api/account/lock", { headers: auth });
  expect([read.status, read.body.locked]).toEqual([200, lock.id]);
  const asked = await made.local("/api/account/unlock", { method: "POST", headers: { ...auth, "x-herdr-machine": "1" }, body: { lock: lock.id } });
  expect(asked.status).toBe(202);
  expect((await made.local("/api/devices", { headers: auth })).body.error?.code).toBe("locked");
  const forwarded = await made.local("/api/account/lock", { headers: { ...auth, "x-forwarded-for": "100.64.0.9" } });
  expect(forwarded.status).toBeGreaterThanOrEqual(400);
});

test("T46/S24: a connection whose upgrade was admitted before a lock's approval and opens after it ends as it opens", () => {
  const signal = new LockSignal();
  const lifetime = untilLockFrom(signal);
  signal.fire();
  let closed = 0;
  lifetime(() => { closed++; });
  expect(closed).toBe(1);
});


test("R10: health tells a window whether it is this PC's own (the lock routes' rule): loopback yes, the token from loopback yes, forwarded no", async () => {
  const made = await lockedPc();
  expect(((await made.local("/api/health")).body.auth as { own_window?: true } | undefined)?.own_window).toBe(true);
  expect(((await made.local("/api/health", { headers: { "x-forwarded-for": "100.64.0.9" } })).body.auth as { own_window?: true } | undefined)?.own_window).toBeUndefined();
  const member = await memberRow("acct_1");
  const tokened = await pairingPc({ rows: [member.row], startRelay: false, server: { accountOpensAll: true, token: "owner-token" } });
  pcs.push(tokened);
  expect(((await tokened.local("/api/health", { headers: { authorization: "Bearer owner-token" } })).body.auth as { own_window?: true } | undefined)?.own_window).toBe(true);
});

test("S36-1: a lock or unlock asked by a window that is not this PC's own is refused local_required, locked or not", async () => {
  for (const lock of [true, false]) {
    const member = await memberRow("acct_1");
    const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
    pcs.push(made);
    const id = lock ? made.app.context.services.safetyLog!.appendLock({ account: "acct_1" }).id : null;
    for (const path of ["/api/account/lock", "/api/account/unlock"]) {
      const tried = await made.local(path, { method: "POST", headers: { "x-herdr-machine": "1", "x-forwarded-for": "100.64.0.9" }, body: { lock: id } });
      expect({ lock, path, status: tried.status, code: tried.body.error?.code }).toEqual({ lock, path, status: 403, code: "local_required" });
    }
    expect(made.app.context.services.localConfirms!.pending()).toEqual([]);
  }
});

test("T46, t13r: a code a member started from afar ends with the screen-approved lock, and a device that brings it afterwards is refused", async () => {
  const made = await screenedPc();
  const code = made.devices.startPairing(Date.now(), { remote: true, startedBy: null, memberRequired: false }).code;
  const asked = await made.local("/api/account/lock", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
  expect(asked.status).toBe(202);
  const answered = made.app.context.services.localConfirms!.answer(asked.body.confirm as string);
  made.approve("lock");
  expect(await bounded(answered)).toBe("approved");
  expect(made.app.context.services.safetyLog!.state().locked).toBe(true);
  expect(made.devices.activePairing()).toBeNull();
  const before = made.stored().length;
  const tried = await made.local("/api/devices/pair", { method: "POST", body: { code, label: "Intruder" } });
  expect(tried.status).toBeGreaterThanOrEqual(400);
  expect(made.stored().length).toBe(before);
});

test("S36-1: through dispatch, a Tailscale login, a token from another address, the open LAN and a gated LAN all get local_required for both requests, locked or not, and nothing reaches the screen", async () => {
  for (const [via, token, gated] of [["tailscale", "", true], ["remote token", "owner-token", true], ["open LAN", "", false], ["gated LAN", "", true]] as const) {
    const f = relayFixture(false, { accountOpensAll: true, token });
    try {
      const { devices, safetyLog, localConfirms } = f.app.context.services;
      if (gated) devices.pairRelay(devices.startPairing().code, "Phone", "k".repeat(43));
      const lan = via === "open LAN" || via === "gated LAN" || via === "remote token";
      const context = {
        ...f.app.context,
        requestIP: () => ({ address: lan ? "192.168.1.20" : "127.0.0.1" }),
        timeout: () => {},
        services: { ...f.app.context.services, identityOf: async () => ({ owner: "owner@example.com", soleLogin: null, dnsName: null, tailnetIp: null, tagged: false }) },
      };
      const credentials: Record<string, string> = via === "tailscale" ? { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.1" }
        : via === "remote token" ? { authorization: "Bearer owner-token" } : {};
      for (const locked of [false, true]) {
        const lock = locked ? safetyLog!.appendLock({ account: "acct_1" }) : null;
        for (const path of ["/api/account/lock", "/api/account/unlock"]) {
          const answer = await handleRequest(new Request(`http://127.0.0.1${path}`, {
            method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json", ...credentials },
            body: JSON.stringify(lock === null ? {} : { lock: lock.id }),
          }), context);
          const body = await answer?.json() as { error?: { code: string } } | undefined;
          expect({ via, locked, path, status: answer?.status, code: body?.error?.code }).toEqual({ via, locked, path, status: 403, code: "local_required" });
        }
        if (lock !== null) safetyLog!.appendUnlock(lock.id, { account: "acct_1" });
      }
      expect(localConfirms?.pending() ?? []).toEqual([]);
    } finally { f.close(); }
  }
});

test("T47, N4: a window that is not this PC's own gets health 'locked' on a locked PC, not a pairing prompt", async () => {
  const made = await lockedPc();
  const forwarded = await made.local("/api/health", { headers: { "x-forwarded-for": "100.64.0.9" } });
  expect((forwarded.body.auth as { reason?: string } | undefined)?.reason).toBe("locked");
});
