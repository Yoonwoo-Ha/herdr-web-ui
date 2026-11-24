/**
 * The PC's own part of following its account's signed list (list-follow.ts): when it reads without being told to,
 * what it keeps across a restart, and what work in flight may still do. The account service here only serves the log
 * a real account wrote; the clock, the binding and the disk are the test's.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PC_READ_SECONDS } from "../../shared/account-list-follower.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { ACCOUNT_LIST_FILE, ListFollow, type ListFollowDeps } from "./list-follow.ts";
import { ListKeyStore } from "./list-keys.ts";
import { listMember, TestList } from "./list.test-helpers.ts";
import { AccountServiceRefusal } from "./mailbox.ts";

const ACCOUNT = "acct_1";
const SERVICE = "https://account.test";
const BIND = "ab".repeat(16);

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A PC's follower over a state folder of its own, an account's real list, and a clock the test moves (seconds). */
async function following(options: { stateDir?: string; seconds?: number; account?: TestList; service?: FakeAccountService } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "ovis-list-follow-"));
  if (options.stateDir === undefined) dirs.push(stateDir);
  const world = {
    seconds: options.seconds ?? 1_800_000_000, bound: true, bind: BIND, calls: [] as string[],
    /** what the service answers a log request with, in the log's place */
    log: null as ((body: Record<string, unknown>) => Record<string, unknown>) | null,
    /** each call waits for this before it answers */
    gate: null as Promise<void> | null,
    until: null as number | null,
  };
  const service = options.service ?? new FakeAccountService(() => world.seconds * 1000);
  service.listAccounts = "*";
  const account = options.account ?? await TestList.start(service, ACCOUNT, undefined, () => world.seconds);
  const identity = loadRelayIdentity(stateDir);
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  // the account lists this PC, so the service serves it the list's routes on its own proof
  const listed = await service.fetch(new Request(`${SERVICE}/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT, { twoStep: true })}` },
    body: JSON.stringify({ label: "PC", public_key: endpoint, relay: "wss://relay.ovis.sh" }) }));
  if (!listed.ok) throw new Error(`The PC was not listed: ${listed.status}`);
  const prove = async () => {
    const challenge = await (await service.fetch(new Request(`${SERVICE}/v1/pc/challenge`, { method: "POST", body: JSON.stringify({ server_id: identity.server_id, public_key: endpoint }) }))).json() as { challenge_id: string; frame: string };
    return { server_id: identity.server_id, public_key: endpoint, challenge_id: challenge.challenge_id, proof: answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key), { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id })! };
  };
  const deps: ListFollowDeps = {
    stateDir, keys: new ListKeyStore(stateDir), identity: () => identity,
    binding: () => world.bound ? { account: ACCOUNT, id: world.bind } : null,
    rowKey: () => null,
    now: () => world.seconds * 1000,
    call: async (path, body) => {
      world.calls.push(path);
      if (world.gate !== null) await world.gate;
      if (world.log !== null && path === "/v2/pc/list/log") return world.log(body);
      const answer = await service.fetch(new Request(`${SERVICE}${path}`, { method: "POST", body: JSON.stringify({ ...await prove(), ...body }) }));
      const said = await answer.json() as Record<string, unknown>;
      if (!answer.ok) throw new AccountServiceRefusal(answer.status, (said.error as { code?: string } | undefined)?.code ?? null, path);
      return path === "/v2/pc/list/keys" && world.until !== null ? { ...said, until: world.until } : said;
    },
  };
  const list = new ListFollow(deps);
  stops.push(() => list.stop());
  const hint = () => { const held = service.accountList(ACCOUNT)!; return { id: held.id, head: held.head }; };
  /** A mailbox pull that named the list as the service holds it, followed to its end. */
  const pull = async () => { list.heard(ACCOUNT, hint()); await list.settled(); };
  const reads = () => world.calls.filter((path) => path === "/v2/pc/list/log").length;
  /** Resolves once a log request is out that was not when this was called (`after`: the count then), within ten seconds. */
  const asked = async (after = 0) => {
    const deadline = Date.now() + 10_000;
    while (reads() <= after) { if (Date.now() > deadline) throw new Error("The PC asked for no log"); await Bun.sleep(5); }
  };
  /** A member adds this PC from the keys it posted: from then on the list answers for its devices. */
  const addPc = async () => { await pull(); await account.addPostedPc(endpoint); await pull(); };
  return { list, world, service, account, stateDir, pull, reads, hint, deps, addPc, asked };
}

describe("a PC that holds a list reads it at its own pace", () => {
  test("a mailbox that names no list hides no removal: the PC reads the log when its own time has come", async () => {
    const pc = await following();
    await pc.pull();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ devices: 2, head: pc.account.place });
    await pc.account.remove(phone.key);
    const before = pc.reads();
    // the mailbox goes on naming no list
    pc.list.heard(ACCOUNT, null);
    await pc.list.settled();
    expect(pc.reads()).toBe(before);
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.heard(ACCOUNT, null);
    await pc.list.settled();
    expect(pc.reads()).toBe(before + 1);
    expect(pc.list.status()).toMatchObject({ devices: 1, head: pc.account.place });
  });

  test("and with no mailbox answer at all: its clock alone brings the read", async () => {
    const pc = await following();
    await pc.pull();
    await pc.account.addDevice(await listMember());
    const before = pc.reads();
    pc.list.tick();
    await pc.list.settled();
    expect(pc.reads()).toBe(before);
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    expect(pc.reads()).toBe(before + 1);
    expect(pc.list.status()).toMatchObject({ devices: 2 });
  });

  test("a PC whose account never had a list asks for no log, whatever its clock shows", async () => {
    const pc = await following();
    pc.list.heard(ACCOUNT, null);
    pc.world.seconds += 10 * PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    expect(pc.world.calls).toEqual([]);
  });

  test("after a restart it holds its saved copy before any mailbox answer", async () => {
    const pc = await following();
    await pc.account.addDevice(await listMember());
    await pc.pull();
    const held = pc.list.status();
    pc.list.stop();
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service });
    again.list.start();
    await again.list.settled();
    expect(again.list.status()).toMatchObject({ list: held.list, head: held.head, devices: 2 });
    expect(again.world.calls).toEqual([]);
  });
});

describe("what the account service names is only its word", () => {
  test("a list id it named, of which the PC verified no entry, gives way to the one it names next", async () => {
    const pc = await following();
    const real = pc.hint();
    // the first answer names a list whose log the service does not serve
    pc.list.heard(ACCOUNT, { id: "ef".repeat(32), head: { seq: 3, hash: "cd".repeat(32) } });
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ list: "ef".repeat(32), head: null });
    pc.list.heard(ACCOUNT, real);
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ list: real.id, head: real.head, last_verdict: "caught_up" });
  });

  test("a list of which it verified an entry does not give way", async () => {
    const pc = await following();
    await pc.pull();
    const held = pc.list.status();
    pc.list.heard(ACCOUNT, { id: "ef".repeat(32), head: { seq: 3, hash: "cd".repeat(32) } });
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ list: held.list, head: held.head, last_verdict: "not_my_list" });
  });
});

describe("the PC's clock never counts for less than it once showed", () => {
  test("an hour a decision turned on is saved: a restart with the clock set back does not let an expired device in again", async () => {
    const pc = await following({ seconds: 1_800_000_000 });
    const watcher = await listMember();
    await pc.account.addDevice(watcher, { role: "watch", power: "bound", until: 1_800_000_050 });
    await pc.addPc();
    const said: string[] = [];
    const log = spyOn(console, "info").mockImplementation((line: unknown) => { said.push(String(line)); });
    try {
      // the same head, five seconds past the device's time and under a minute since the last save: only the
      // decision itself saves the hour. The shadow says the list would not let it in
      pc.world.seconds = 1_800_000_055;
      await pc.pull();
      pc.list.shadowSnapshot([watcher.key]);
      await pc.list.settled();
      expect(said.some((line) => line.includes('"list":"expired"'))).toBe(true);
      pc.list.stop();
      said.length = 0;
      // the clock is set back to before that time
      const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service, seconds: 1_800_000_040 });
      again.list.start();
      again.list.shadowSnapshot([watcher.key]);
      await again.list.settled();
      expect(said.some((line) => line.includes('"list":"expired"'))).toBe(true);
      expect(said.some((line) => line.includes('"list":"watch"'))).toBe(false);
    } finally { log.mockRestore(); }
  });
});

describe("work in flight when the PC leaves its account", () => {
  test("a read that answers after the binding was cleared writes no copy and posts no card", async () => {
    const pc = await following();
    let release = () => {};
    pc.world.gate = new Promise((resolve) => { release = resolve; });
    pc.list.heard(ACCOUNT, pc.hint());
    // the log request is out
    await pc.asked();
    pc.world.bound = false;
    release();
    await pc.list.settled();
    expect(pc.world.calls).toEqual(["/v2/pc/list/log"]);
    expect(await Bun.file(join(pc.stateDir, ACCOUNT_LIST_FILE)).exists()).toBe(false);
    expect(pc.list.status().list).toBeNull();
  });

  test("and nothing is posted after stop", async () => {
    const pc = await following();
    let release = () => {};
    pc.world.gate = new Promise((resolve) => { release = resolve; });
    pc.list.heard(ACCOUNT, pc.hint());
    await pc.asked();
    pc.list.stop();
    release();
    await pc.list.settled();
    expect(pc.world.calls).toEqual(["/v2/pc/list/log"]);
  });
});

describe("what the PC says of itself", () => {
  test("a copy file that could not be read is read again once it can be", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const pc = await following();
    await pc.account.addDevice(await listMember());
    await pc.pull();
    pc.list.stop();
    const path = join(pc.stateDir, ACCOUNT_LIST_FILE);
    chmodSync(path, 0o000);
    const again = await following({ stateDir: pc.stateDir, account: pc.account, service: pc.service });
    await again.pull();
    expect(again.list.status()).toMatchObject({ list: null, error: `${ACCOUNT_LIST_FILE} cannot be read` });
    expect(again.reads()).toBe(0);
    chmodSync(path, 0o600);
    await again.pull();
    expect(again.list.status()).toMatchObject({ list: pc.account.id, head: pc.account.place, error: null });
  });

  test("it names no post of its keys once the list holds it", async () => {
    const pc = await following();
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "waiting" });
    expect(pc.list.status().posted_until).not.toBeNull();
    // a member adds it from that post
    await pc.account.addPostedPc(bytesToHex(importPublicKey(pc.deps.identity()!.public_key)));
    await pc.pull();
    expect(pc.list.status()).toMatchObject({ standing: "in", posted_until: null });
  });

  test("a post's end the service names out of any range does not break what the PC says", async () => {
    const pc = await following();
    pc.world.until = Number.MAX_SAFE_INTEGER;
    await pc.pull();
    expect(() => pc.list.status()).not.toThrow();
    expect(pc.list.status()).toMatchObject({ standing: "waiting", posted_until: null });
  });

  test("a key only the snapshot or only the list holds is said as a difference of credentials: the two may be one phone", async () => {
    const pc = await following();
    const member = await listMember();
    const signIn = await listMember();
    await pc.account.addDevice(member);
    await pc.addPc();
    const said: Record<string, unknown>[] = [];
    const log = spyOn(console, "info").mockImplementation((line: unknown) => { try { said.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* another line */ } });
    try {
      // the snapshot names the phone by the key of its sign-in, the list by its member key
      pc.list.shadowSnapshot([signIn.key, pc.account.first.key]);
      await pc.list.settled();
    } finally { log.mockRestore(); }
    const differences = said.filter((line) => line.event === "account.list.differs").map(({ snapshot, list, of }) => ({ snapshot, list, of }));
    expect(differences).toEqual([{ snapshot: "admitted", list: "never_added", of: "credential" }, { snapshot: "none", list: "drive", of: "credential" }]);
  });
});

describe("found in review", () => {
  test("a read that ends after a sign-in moved the copy's clock on is kept", async () => {
    const pc = await following();
    await pc.addPc();
    const phone = await listMember();
    await pc.account.addDevice(phone);
    let release = () => {};
    pc.world.gate = new Promise((resolve) => { release = resolve; });
    const before = pc.reads();
    pc.list.heard(ACCOUNT, pc.hint());
    await pc.asked(before);
    // a sign-in is decided on the copy meanwhile, a second later
    pc.world.seconds += 1;
    pc.list.shadowSignIn({ deviceId: "0".repeat(16), nonce: new Uint8Array(32), signature: "x", serverId: pc.deps.identity()!.server_id, snapshot: "admitted" });
    pc.list.shadowSnapshot([pc.account.first.key]);
    release();
    pc.world.gate = null;
    await pc.list.settled();
    expect(pc.list.status()).toMatchObject({ head: pc.account.place, devices: 2 });
  });

  test("what was said of a binding the PC left is not said of the next", async () => {
    const pc = await following();
    pc.world.log = () => { throw new AccountServiceRefusal(500, "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE", "/v2/pc/list/log"); };
    await pc.pull();
    // the code the service sent is no code of its own form: it is not repeated
    expect(pc.list.status().error).toBe("The account service answered 500 to /v2/pc/list/log");
    expect(pc.list.status().last_verdict).not.toBeNull();
    pc.world.bound = false;
    expect(pc.list.status()).toMatchObject({ account: null, list: null, last_verdict: null, error: null, keys: null, differences: 0 });
  });

  test("a hint asked for under one binding is not followed under the next", async () => {
    const pc = await following();
    const asked = pc.list.scopeToken();
    pc.world.bind = "cd".repeat(16);
    pc.list.heard(ACCOUNT, pc.hint(), asked);
    await pc.list.settled();
    expect(pc.world.calls).toEqual([]);
    expect(pc.list.status().list).toBeNull();
    // one asked for under the binding the PC has is
    pc.list.heard(ACCOUNT, pc.hint(), pc.list.scopeToken());
    await pc.list.settled();
    expect(pc.list.status().list).toBe(pc.account.id);
  });

  test("a PC that waits to be added renews its post by its own clock, with no mailbox answer", async () => {
    const pc = await following();
    await pc.pull();
    const posts = () => pc.world.calls.filter((path) => path === "/v2/pc/list/keys").length;
    expect(posts()).toBe(1);
    pc.world.seconds += PC_READ_SECONDS;
    pc.list.tick();
    await pc.list.settled();
    expect(posts()).toBe(2);
  });

  test("a post whose end is not ahead is no post: it is not named, and is made again within a minute", async () => {
    const pc = await following();
    pc.world.until = 0;
    await pc.pull();
    const posts = () => pc.world.calls.filter((path) => path === "/v2/pc/list/keys").length;
    expect(pc.list.status().posted_until).toBeNull();
    expect(posts()).toBe(1);
    pc.world.until = null;
    pc.world.seconds += 61;
    await pc.pull();
    expect(posts()).toBe(2);
    expect(pc.list.status().posted_until).not.toBeNull();
  });
});
