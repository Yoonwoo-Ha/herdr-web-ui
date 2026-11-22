/**
 * Adding another PC to this PC's account over SSH (docs/account.md, "Adding a PC over SSH"): the setup job lands only on
 * that PC's own Ovis, reads its public relay fields over its owner's recovery socket, and the take hands it only the
 * account; that PC then takes the admission on its own proof. The other PC here is a real Ovis server with a fake
 * account service; SSH itself is stood in for (ssh-account-add.test.ts runs real OpenSSH).
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type SetupJob, type SetupRequest } from "../shared/machines.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import type { CompletionTracker } from "./completion.ts";
import { ACCOUNT_ADD_BRIDGE_ONLY, ACCOUNT_ADD_NO_OVIS, MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { pairingPc, type Pc } from "./account/pairing.test-helpers.ts";
import { askRecovery, openRecoverySocket } from "./account/recovery.ts";
import { sendAccountAddAct } from "./account-add-channel.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const REMOTE_SOCKET = "/home/fixture/.local/state/ovis/recover/recover.sock";

async function otherPc(): Promise<Pc> {
  const pc = await pairingPc({ server: { accountOpensAll: true } });
  pc.account.opensAll = true;
  cleanups.push(() => pc.close());
  return pc;
}

/**
 * That PC's recovery socket as the forward reaches it, behind a stand-in that records every request it is sent: the
 * socket itself answers every recovery act, so what reaches it is what the adding PC chose to send.
 */
function recorded(pc: Pc): { path: string; seen: unknown[] } {
  const seen: unknown[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ovis-account-add-proxy-"));
  const proxy = openRecoverySocket({ stateDir: dir, handle: async (request) => { seen.push(request); return await askRecovery(pc.stateDir, request); } });
  if ("refused" in proxy) throw new Error(proxy.refused);
  cleanups.push(() => { proxy.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { path: proxy.path, seen };
}

/** What the owner's signed-in window does with the fields the job read: lists that PC, then admits it (S1). */
async function listAndAdmit(pc: Pc, account: string, fields: NonNullable<SetupJob["account_add"]>, twoStep: boolean | null = true): Promise<Response> {
  const token = pc.account.issueToken(account, { twoStep });
  const call = (path: string, method: string, body: unknown) =>
    pc.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${fields.server_id}`, "PUT", { label: fields.label, public_key: bytesToHex(importPublicKey(fields.public_key)), relay: fields.relay });
  if (!listed.ok) throw new Error(`Not listed: ${listed.status} ${await listed.text()}`);
  return await call(`/v1/pcs/${fields.server_id}/admit`, "POST", {});
}

function fixture(remote: { descriptor: "own" | "managed" | "none"; recoverSocket?: string | null; socketPath?: string; hostKey?: "confirm" | "reject" }) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-account-add-"));
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, {} as CompletionTracker, async () => { throw new Error("fixture local offline"); });
  const socket = "/home/fixture/.config/herdr/herdr.sock";
  const descriptor = (): BridgeDescriptor => ({ pid: 12345, port: 17317, token: "a".repeat(64), socket_path: socket, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION,
    managed_remote: remote.descriptor === "managed", ...(remote.descriptor === "own" && remote.recoverSocket !== null ? { recover_socket: remote.recoverSocket ?? REMOTE_SOCKET } : {}) });
  const commands: string[] = [];
  const forwarded: string[] = [];
  const closed: string[] = [];
  const prompts: boolean[] = [];
  const mocks: { mockRestore(): void }[] = [
    spyOn(SshConnection.prototype, "run").mockImplementation(async (script) => {
      commands.push(script);
      if (script.includes("uname")) return `Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\n\n${remote.descriptor === "none" ? "" : JSON.stringify(descriptor())}\n`;
      if (script.startsWith("socket=")) return socket;
      if (script.includes("--version")) return "herdr 0.9.5";
      if (script.startsWith("kill -0")) return "live";
      throw new Error(`Unexpected remote command: ${script}`);
    }),
    spyOn(SshConnection.prototype, "start").mockImplementation(async function (this: SshConnection, challenge) {
      if (remote.hostKey === undefined) return;
      prompts.push(true);
      // a host this PC has no key for: asked in the dialog, exactly as ssh asks it
      const answer = await challenge!("The authenticity of host 'fixture-pc' can't be established.\nED25519 key fingerprint is SHA256:fixture.\nAre you sure you want to continue connecting (yes/no)? ", true);
      if (answer !== "yes") throw new Error("Host key verification failed.");
    }),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "connected").mockReturnValue(true),
    spyOn(SshConnection.prototype, "forwardSocket").mockImplementation(async (path) => { forwarded.push(path); return remote.socketPath ?? "/nonexistent"; }),
    spyOn(SshConnection.prototype, "closeSocketForward").mockImplementation(async (local) => { closed.push(local); }),
    spyOn(MachineManager.prototype as unknown as { verify(): Promise<unknown> }, "verify").mockImplementation(async () => ({
      endpoint: { url: "http://127.0.0.1:1", token: "fixture-token" },
      identity: { ...descriptor(), managed_remote: remote.descriptor === "managed", socket_id: "fixture-socket", herdr: { version: "0.9.5", protocol: 22 } } satisfies BridgeIdentity,
    })),
    spyOn(MachineManager.prototype as unknown as { observe(): Promise<void> }, "observe").mockResolvedValue(undefined),
    spyOn(posixHost, "installBundle").mockImplementation(async () => { throw new Error("must not install a bridge"); }),
    spyOn(posixHost, "start").mockImplementation(async () => { throw new Error("must not start a bridge"); }),
  ];
  // the question waits on the dialog's answer (MachineManager.wait): the person's answer is sent once it is asked
  type Waiting = { wait(job: { public: SetupJob }): Promise<string> };
  const prototype = MachineManager.prototype as unknown as Waiting;
  const wait = prototype.wait;
  mocks.push(spyOn(prototype, "wait").mockImplementation(function (this: Waiting, job) {
    const asked = wait.call(this, job);
    const challenge = job.public.challenge;
    if (challenge?.kind === "host_key") manager.action(job.public.id, { action: "answer", challenge_id: challenge.id, answer: remote.hostKey === "confirm" ? "yes" : "no" });
    return asked;
  }));
  cleanups.push(() => { manager.stop(); for (const mock of mocks) mock.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  const settled = (request: SetupRequest) => new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const timeout = setTimeout(() => { off(); reject(new Error(`setup did not settle: ${JSON.stringify(job)}`)); }, 5000);
    const off = manager.subscribe(() => {
      if (job && ["failed", "connected", "approval", "cancelled"].includes(job.phase)) { clearTimeout(timeout); off(); resolve(job); }
    });
    job = manager.setup(request);
  });
  return { manager, commands, forwarded, closed, prompts, settled };
}

/** What the account service's directory says of that PC, as the window's own sign-in reads it. */
async function listing(pc: Pc, account: string, serverId: string): Promise<Record<string, unknown> | undefined> {
  const answer = await pc.account.fetch(new Request("https://account.test/v1/pcs", { headers: { authorization: `Bearer ${pc.account.issueToken(account)}` } }));
  return ((await answer.json()) as { pcs: Record<string, unknown>[] }).pcs.find((entry) => entry.server_id === serverId);
}

test("happy path: host key confirmed, that PC's own Ovis is reached, the window lists and admits it, it takes the admission itself, and its add completes", async () => {
  const b = await otherPc();
  b.account.completions = true;
  const socket = recorded(b);
  const { manager, forwarded, closed, prompts, settled } = fixture({ descriptor: "own", hostKey: "confirm", socketPath: socket.path });
  const job = await settled({ destination: "fixture-pc", account_add: true });
  expect(prompts).toEqual([true]);
  expect(job.phase).toBe("connected");
  // only the socket its own registration named is forwarded
  expect(forwarded).toEqual([REMOTE_SOCKET]);
  const identity = b.app.context.services.relay.currentIdentity()!;
  expect(job.account_add).toEqual({ server_id: identity.server_id, public_key: identity.public_key, relay: expect.stringMatching(/^wss:\/\//), label: expect.any(String), account: null });
  expect(JSON.stringify(job.account_add)).not.toContain("secret");
  expect((await listAndAdmit(b, "acct_1", job.account_add!)).ok).toBe(true);
  // listed and admitted is not added: that PC is in no account until it takes the admission, and its add is not complete
  expect(b.devices.account()).toBeNull();
  expect(await listing(b, "acct_1", identity.server_id)).toMatchObject({ completed_at: null });
  expect(closed).toEqual([]);
  expect(await manager.accountTake(job.id, identity.server_id, "acct_1")).toEqual({ account: "acct_1" });
  expect(b.devices.account()).toBe("acct_1");
  // that PC's own receipt of its bind: the directory shows its add completed
  expect((await listing(b, "acct_1", identity.server_id))?.completed_at).toEqual(expect.any(String));
  // the forward carried an inspect and one take, and closed as the take answered
  expect(socket.seen.map((request) => (request as { act: string }).act)).toEqual(["account_add_inspect", "account_add_take"]);
  expect(closed).toEqual([socket.path]);
  // nothing more goes on it: another take needs a new connection (which then finds that PC in the account)
  await expect(manager.accountTake(job.id, identity.server_id, "acct_1")).rejects.toMatchObject({ code: "disconnected" });
  expect(socket.seen).toHaveLength(2);
});

test("nothing but an account add's inspect and take is ever sent on the forwarded recovery socket", async () => {
  const b = await otherPc();
  const socket = recorded(b);
  for (const request of [
    { act: "admit", pending: "a".repeat(32), fingerprint: "AB12-CD34" }, { act: "revoke_all" }, { act: "lift", blocks: ["a".repeat(64)] },
    { act: "remove", targets: ["0123456789abcdef"] }, { act: "release", rows: ["0123456789abcdef"] }, { act: "list" },
    { act: "account_add_inspect", rows: ["0123456789abcdef"] }, { act: "account_add_take", account: "acct_1", server_id: "0".repeat(32), pending: "x" },
  ]) await expect(sendAccountAddAct(socket.path, request as never)).rejects.toThrow("Only an account add's inspect and take");
  expect(socket.seen).toEqual([]);
});

test("a refused inspect closes the forward at once", async () => {
  const b = await otherPc();
  const socket = recorded(b);
  const before = process.env["OVIS_REMOTE"];
  process.env["OVIS_REMOTE"] = "1";
  try {
    const { closed, settled } = fixture({ descriptor: "own", socketPath: socket.path });
    const job = await settled({ destination: "fixture-pc", account_add: true });
    expect(job.phase).toBe("failed");
    expect(socket.seen.map((request) => (request as { act: string }).act)).toEqual(["account_add_inspect"]);
    expect(closed).toEqual([socket.path]);
  } finally {
    if (before === undefined) delete process.env["OVIS_REMOTE"]; else process.env["OVIS_REMOTE"] = before;
  }
});

test("a setup that fails after the inspect closes the forward", async () => {
  const b = await otherPc();
  const socket = recorded(b);
  const { closed, settled } = fixture({ descriptor: "own", socketPath: socket.path });
  const observe = spyOn(MachineManager.prototype as unknown as { observe(): Promise<void> }, "observe").mockRejectedValue(new Error("fixture: the bridge stopped answering"));
  cleanups.push(() => observe.mockRestore());
  const job = await settled({ destination: "fixture-pc", account_add: true });
  expect(job.phase).toBe("failed");
  expect(closed).toEqual([socket.path]);
});

test("a take the other PC refuses closes the forward, and binds nothing", async () => {
  const b = await otherPc();
  const socket = recorded(b);
  const { manager, closed, settled } = fixture({ descriptor: "own", socketPath: socket.path });
  const job = await settled({ destination: "fixture-pc", account_add: true });
  await expect(manager.accountTake(job.id, job.account_add!.server_id, "acct_1")).rejects.toMatchObject({ code: "no_admission" });
  expect(b.devices.account()).toBeNull();
  expect(closed).toEqual([socket.path]);
});

test("a take for another PC than the one the job reached binds nothing and sends nothing", async () => {
  const b = await otherPc();
  const socket = recorded(b);
  const { manager, settled } = fixture({ descriptor: "own", socketPath: socket.path });
  const job = await settled({ destination: "fixture-pc", account_add: true });
  await listAndAdmit(b, "acct_1", job.account_add!);
  await expect(manager.accountTake(job.id, "0".repeat(32), "acct_1")).rejects.toMatchObject({ code: "identity_changed" });
  expect(b.devices.account()).toBeNull();
  expect(socket.seen).toHaveLength(1);
});

test("an unknown host key the user does not confirm: nothing is read, listed or taken", async () => {
  const b = await otherPc();
  const socket = recorded(b);
  const { manager, forwarded, prompts, settled } = fixture({ descriptor: "own", hostKey: "reject", socketPath: socket.path });
  const job = await settled({ destination: "fixture-pc", account_add: true });
  expect(prompts).toEqual([true]);
  expect(job.phase).toBe("failed");
  expect(job.account_add).toBeUndefined();
  expect(forwarded).toEqual([]);
  expect(socket.seen).toEqual([]);
  expect(manager.list().some((pc) => pc.target?.destination === "fixture-pc")).toBe(false);
  await expect(manager.accountTake(job.id, b.app.context.services.relay.currentIdentity()!.server_id, "acct_1")).rejects.toMatchObject({ code: "job_not_found" });
  expect(b.devices.account()).toBeNull();
});

test("landing on a bridge this app started there is refused, and nothing is installed, started or read", async () => {
  const { forwarded, commands, settled } = fixture({ descriptor: "managed" });
  const job = await settled({ destination: "fixture-pc", account_add: true });
  expect([job.phase, job.error, job.action_required]).toEqual(["failed", ACCOUNT_ADD_BRIDGE_ONLY, "setup"]);
  expect(forwarded).toEqual([]);
  expect(commands.some((script) => script.includes("nohup") || script.includes("mkdir"))).toBe(false);
});

test("a PC without Ovis asks for Ovis to be installed there, never for a bridge", async () => {
  const { forwarded, settled } = fixture({ descriptor: "none" });
  const job = await settled({ destination: "fixture-pc", account_add: true });
  expect([job.phase, job.error, job.action_required]).toEqual(["failed", ACCOUNT_ADD_NO_OVIS, "install_ovis"]);
  expect(job.installations).toEqual([]);
  expect(forwarded).toEqual([]);
});

test("an Ovis there too old to name its owner's socket is not added", async () => {
  const { forwarded, settled } = fixture({ descriptor: "own", recoverSocket: null });
  const job = await settled({ destination: "fixture-pc", account_add: true });
  expect([job.phase, job.action_required]).toEqual(["failed", "setup"]);
  expect(forwarded).toEqual([]);
});

test("an account add is never an automatic or update setup", () => {
  const { manager } = fixture({ descriptor: "own" });
  expect(() => manager.setup({ destination: "fixture-pc", account_add: true, update_remote: true })).toThrow("its own setup");
  expect(() => manager.setup({ destination: "fixture-pc", account_add: true, start_new_herdr: true })).toThrow("own Ovis");
});
