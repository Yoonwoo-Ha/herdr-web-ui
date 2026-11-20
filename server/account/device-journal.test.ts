import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceNotice, NoticeReplay } from "../../shared/account-devices-api.ts";
import { DEVICE_COOKIE } from "../auth.ts";
import { DeviceStore, readDeviceRegistry } from "../devices.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { DeviceJournal, JOURNAL_FILE, OPEN_NOTICES_MAX } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-device-journal-"));
  dirs.push(dir);
  return dir;
}

async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

function store(dir: string, journal?: DeviceJournal): DeviceStore {
  const safety = SafetyLog.open(dir);
  journal ??= DeviceJournal.open(dir, () => safety.ensureFile());
  return new DeviceStore(dir, null, null, { safety, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, safety), journal });
}

const admit = (journal: DeviceJournal, row: string, no: number) =>
  journal.append({ kind: "admit", how: "list", key: null, no, row, label: `Phone ${row}`, by: null, account: "acct_1" });

/** Frames of one WebSocket in arrival order. */
async function frames(port: number, cookie: string, count: number): Promise<{ list: { type: string; [field: string]: unknown }[]; socket: WebSocket }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } } as unknown as string[]);
  const list: { type: string; [field: string]: unknown }[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.onmessage = (event) => { list.push(JSON.parse(String(event.data))); if (list.length >= count) resolve(); };
    socket.onerror = () => reject(new Error("socket failed"));
  });
  return { list, socket };
}

describe("the device journal (P10, P15)", () => {
  test("T57: reconnect replays unseen notices before other events and ack never decides a notice", async () => {
    const f = relayFixture(false, { accountOpensAll: true, token: "a-token-long-enough-to-be-a-real-one" });
    fixtures.push(f);
    const devices = f.app.context.services.devices;
    const older = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    devices.match(older.token);
    const newer = devices.pairRelay(devices.startPairing().code, "Phone", await key())!;
    const cookie = `${DEVICE_COOKIE}=${older.token}`;

    // the replay comes right after the features frame, before the snapshot, and names the newer row's admission
    const first = await frames(f.app.port, cookie, 2);
    expect(first.list.map((frame) => frame.type)).toEqual(["features", "device-notice-replay"]);
    const replay = first.list[1]!["replay"] as NoticeReplay;
    const notice = replay.notices.find((n) => n.row === newer.device.id && n.kind === "admit") as DeviceNotice;
    expect(notice).toMatchObject({ open: true, label: "Phone" });
    // the newer row is not told of the older one's admission
    expect(replay.notices.some((n) => n.row === older.device.id)).toBe(false);

    // an acknowledgement marks it seen for this row and decides nothing; the pong behind it says it was handled
    const pong = new Promise<void>((resolve) => {
      first.socket.onmessage = (event) => { if ((JSON.parse(String(event.data)) as { type: string }).type === "pong") resolve(); };
    });
    first.socket.send(JSON.stringify({ type: "notice-seen", seq: notice.seq }));
    first.socket.send(JSON.stringify({ type: "ping", id: 1 }));
    await pong;
    first.socket.close();
    expect(devices.openNotices().map((n) => n.id)).toContain(notice.id);
    const again = await frames(f.app.port, cookie, 2);
    const replayed = (again.list[1]!["replay"] as NoticeReplay).notices;
    // still offered while undecided, and no longer unseen
    expect(replayed.filter((n) => n.id === notice.id)).toEqual([expect.objectContaining({ open: true })]);
    expect(replayed.filter((n) => n.seq > notice.seq || n.id !== notice.id)).toEqual([]);
    again.socket.close();
  });

  test("T57: a departed row's undecided admission survives trimming and stays actionable", () => {
    const dir = stateDir();
    const journal = DeviceJournal.open(dir);
    const kept = admit(journal, "aaaaaaaaaaaaaaaa", 5);
    for (let index = 0; index < 1_050; index += 1) journal.append({ kind: "drop", how: "list", key: null, no: 6, row: "bbbbbbbbbbbbbbbb", label: "Other", by: null, account: "acct_1" });
    const reopened = DeviceJournal.open(dir);
    expect(reopened.entries().length).toBeLessThanOrEqual(1_000);
    expect(reopened.entries().some((entry) => entry.id === kept.id)).toBe(false);
    expect(reopened.openNotices().map((entry) => entry.id)).toEqual([kept.id]);
    // a row that had not seen the trimmed entries is told how many it missed, and the open one is still offered
    const replay = reopened.replay("cccccccccccccccc", () => true);
    expect(replay.cut).toBeGreaterThan(0);
    expect(replay.notices.find((notice) => notice.id === kept.id)).toMatchObject({ open: true, row: "aaaaaaaaaaaaaaaa" });
    // only a decision takes it out
    reopened.ack("cccccccccccccccc", reopened.entries().at(-1)!.seq);
    expect(DeviceJournal.open(dir).openNotices()).toHaveLength(1);
    reopened.decide(kept.id);
    expect(DeviceJournal.open(dir).openNotices()).toHaveLength(0);
  }, 30_000);

  test("G14: failed journal write admits nobody and a throwing listener skips nobody else", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const heard: string[] = [];
    devices.onPaired(() => { throw new Error("a listener that fails"); });
    devices.onPaired((event) => { heard.push(event.device_id); });
    const first = devices.pairRelay(devices.startPairing().code, "Phone", await key())!;
    expect(heard).toEqual([first.device.id]);
    expect(DeviceJournal.open(dir).entries().map((entry) => [entry.kind, entry.row])).toEqual([["admit", first.device.id]]);

    // the journal cannot be written: the pairing makes no row
    rmSync(join(dir, JOURNAL_FILE));
    mkdirSync(join(dir, JOURNAL_FILE));
    const second = await key();
    expect(() => devices.pairRelay(devices.startPairing().code, "Tablet", second)).toThrow();
    const registry = readDeviceRegistry(join(dir, "devices.json"));
    expect(registry.kind === "ok" && registry.devices.some((row) => row.relay_public_key === second)).toBe(false);
    expect(heard).toHaveLength(1);
  });

  test("G14: with the flag on, a listener that throws a value with no message skips nobody either", async () => {
    const devices = store(stateDir());
    const heard: string[] = [];
    devices.onPaired(() => { throw { toString() { throw new Error("no message"); } }; });
    devices.onPaired((event) => { heard.push(event.device_id); });
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", await key())!;
    expect(heard).toEqual([paired.device.id]);
  });

  test("with the flag off, a pairing listener that throws fails the pairing, as on main", async () => {
    const devices = new DeviceStore(stateDir());
    devices.onPaired(() => { throw new Error("a listener that fails"); });
    const k = await key();
    expect(() => devices.pairRelay(devices.startPairing().code, "Phone", k)).toThrow("a listener that fails");
  });

  test("S19: a journal whose entries, open notices or seen values are malformed is strict, never read", () => {
    for (const bad of [
      { v: 1, next_seq: 2, entries: [null], seen: {}, open: [], trimmed: 0 },
      { v: 1, next_seq: 2, entries: [], seen: {}, open: [{ seq: "x" }], trimmed: 0 },
      { v: 1, next_seq: 2, entries: [], seen: { row: "one" }, open: [], trimmed: 0 },
      { v: 1, next_seq: 1, entries: [{ seq: 5, id: "a", at: "2026-10-01T00:00:00.000Z", kind: "admit", how: "code", key: null, no: null, row: "r", label: "", by: null, account: null }], seen: {}, open: [], trimmed: 0 },
    ]) {
      const dir = stateDir();
      writeFileSync(join(dir, JOURNAL_FILE), JSON.stringify(bad), { mode: 0o600 });
      expect(DeviceJournal.open(dir).strict).not.toBeNull();
    }
  });

  test("P10: a notice listener that throws a value with no message skips no other listener", async () => {
    const devices = store(stateDir());
    const heard: number[] = [];
    devices.onNotice(() => { throw { toString() { throw new Error("no message"); } }; });
    devices.onNotice((entry) => { heard.push(entry.seq); });
    devices.pairRelay(devices.startPairing().code, "Phone", await key());
    expect(heard).toHaveLength(1);
  });

  test("G15: unanswered notice cap stops new list admissions without trimming open notices", () => {
    const dir = stateDir();
    const journal = DeviceJournal.open(dir);
    for (let index = 0; index < OPEN_NOTICES_MAX - 1; index += 1) admit(journal, index.toString(16).padStart(16, "0"), index + 1);
    expect(journal.admitsFromList()).toBe(true);
    admit(journal, "ffffffffffffffff", 999);
    expect(journal.admitsFromList()).toBe(false);
    for (let index = 0; index < 1_100; index += 1) journal.append({ kind: "drop", how: "list", key: null, no: 1, row: "eeeeeeeeeeeeeeee", label: "x", by: null, account: "acct_1" });
    expect(DeviceJournal.open(dir).openNotices()).toHaveLength(OPEN_NOTICES_MAX);
    journal.decide(journal.openNotices()[0]!.id);
    expect(journal.admitsFromList()).toBe(true);
  }, 30_000);
});
