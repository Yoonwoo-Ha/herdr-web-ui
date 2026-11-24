/**
 * Install Ovis first, then add that PC to the account, end to end over real SSH (docs/account.md, "Adding a PC over SSH"):
 * a throwaway OpenSSH server on 127.0.0.1 for this user, whose sessions run in a HOME of their own ("that PC"). The
 * official installer is stood in for by a local artifact fetched with curl from a file:// address (no network): it
 * starts this checkout's server there as that PC's own Ovis. On that PC, `herdr` and `systemctl` are stand-ins, and the
 * user bus is not reachable, so nothing here can reach this machine's own Ovis service or herdr; that PC's Ovis serves
 * the isolated test herdr. The account service is the fake, on loopback.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { startBunRelay } from "../relay/bun.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import type { SetupJob, SshTarget } from "../shared/machines.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { CompletionTracker } from "./completion.ts";
import { shellQuote } from "./machine-security.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

const SSHD = "/usr/sbin/sshd";
const herdrSocket = process.env["HERDR_SOCKET"] ?? "";
const available = process.platform !== "win32" && existsSync(SSHD) && herdrSocket !== "" && existsSync(herdrSocket) && Bun.which("curl") !== null;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function keygen(path: string): void {
  const made = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
}

/** "That PC": a HOME of its own with stand-in herdr and systemctl, the test herdr as its default session, and an sshd into it. */
async function thatPc(root: string, accountService: string, relayPort: number): Promise<{ target: SshTarget; home: string; installer: string }> {
  const home = join(root, "remote");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  // its herdr's default session is the isolated test session: the socket's folder, as herdr's config folder there
  mkdirSync(join(home, ".config"), { recursive: true });
  symlinkSync(realpathSync(dirname(herdrSocket)), join(home, ".config", "herdr"));
  writeFileSync(join(bin, "herdr"), [
    "#!/bin/sh",
    `case "$1 $2" in "status server") echo '{"running":true}'; exit 0 ;; "plugin list") exit 0 ;; esac`,
    `[ "$1" = --version ] && { echo "herdr 0.9.5"; exit 0; }`,
    "exit 1",
  ].join("\n") + "\n", { mode: 0o755 });
  // never this machine's own user services: an installed Ovis service there would be started otherwise
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const state = join(home, "ovis-state");
  const installer = join(root, "install.sh");
  writeFileSync(installer, [
    "#!/bin/sh",
    `mkdir -p "$OVIS_FIXTURE_STATE" && chmod 700 "$OVIS_FIXTURE_STATE" || exit 1`,
    `setsid nohup "$OVIS_FIXTURE_BUN" "$OVIS_FIXTURE_ENTRY" </dev/null >"$HOME/ovis-fixture.log" 2>&1 &`,
    `echo "Ovis installed (local fixture artifact)"`,
  ].join("\n") + "\n", { mode: 0o755 });
  const shell = join(root, "remote-shell");
  writeFileSync(shell, [
    "#!/bin/sh",
    `export HOME=${shellQuote(home)}`,
    "unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK HERDR_PLUGIN_STATE_DIR",
    `export PATH=${shellQuote(`${bin}:/usr/bin:/bin`)}`,
    `export HERDR_SOCKET=${shellQuote(herdrSocket)} OVIS_FIXTURE_STATE=${shellQuote(state)} OVIS_FIXTURE_ACCOUNT_SERVICE=${shellQuote(accountService)} OVIS_FIXTURE_RELAY_PORT=${relayPort}`,
    `export OVIS_FIXTURE_BUN=${shellQuote(process.execPath)} OVIS_FIXTURE_ENTRY=${shellQuote(join(import.meta.dir, "account", "ssh-add-pc.child.fixture.ts"))}`,
    `cd "$HOME"`,
    `exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"`,
  ].join("\n") + "\n", { mode: 0o755 });
  keygen(join(root, "host"));
  keygen(join(root, "client"));
  writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "client.pub")), { mode: 0o600 });
  const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = free.port;
  free.stop(true);
  const config = join(root, "sshd_config");
  writeFileSync(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(root, "host")}\nPidFile ${join(root, "sshd.pid")}\nAuthorizedKeysFile ${join(root, "authorized_keys")}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers ${userInfo().username}\nAllowTcpForwarding yes\nAllowStreamLocalForwarding yes\nPermitTTY no\nForceCommand ${shell}\n`);
  const daemon = Bun.spawn([SSHD, "-D", "-e", "-f", config], { stdout: "ignore", stderr: "pipe" });
  cleanups.push(async () => { daemon.kill(); await daemon.exited; });
  const decoder = new TextDecoder();
  let said = "";
  const timeout = setTimeout(() => daemon.kill(), 15_000);
  try {
    for await (const chunk of daemon.stderr) {
      said += decoder.decode(chunk, { stream: true });
      if (said.includes(`Server listening on 127.0.0.1 port ${port}`)) break;
    }
  } finally { clearTimeout(timeout); }
  if (!said.includes(`Server listening on 127.0.0.1 port ${port}`)) throw new Error(`sshd did not listen: ${said}`);
  void (async () => { for await (const _ of daemon.stderr) { /* drained */ } })().catch(() => {});
  // that PC's Ovis outlives the SSH session it was started in: it is stopped by the pid it registered
  cleanups.push(() => {
    const registry = join(home, ".config", "herdr-web-ui", "bridges");
    for (const name of existsSync(registry) ? readdirSync(registry) : []) {
      try { process.kill((JSON.parse(readFileSync(join(registry, name), "utf8")) as { pid: number }).pid, "SIGTERM"); } catch { /* gone already */ }
    }
  });
  return { target: { destination: `${userInfo().username}@127.0.0.1`, port, identity_file: join(root, "client") }, home, installer };
}

test.skipIf(!available)("Ovis is installed on that PC from a local artifact, then the PC is added to the account over the same SSH and completes its add", async () => {
  // short: that PC's recovery socket is forwarded by its path, and a Unix socket path has 108 bytes at most
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? tmpdir() : "/tmp", "ovis-sa-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fake = new FakeAccountService();
  fake.opensAll = true;
  fake.completions = true;
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => fake.fetch(request) });
  cleanups.push(() => service.stop(true));
  // the relay that PC's Ovis links to once its relay is on, on loopback
  const relay = startBunRelay({ port: 0 });
  cleanups.push(() => relay.stop());
  const pc = await thatPc(root, `http://127.0.0.1:${service.port}`, relay.port);
  const stateDir = join(root, "here");
  mkdirSync(stateDir, { mode: 0o700 });
  const manager = new MachineManager(stateDir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("this PC's own herdr is not this test's"); },
    { installer: `file://${pc.installer}` });
  cleanups.push(() => manager.stop());
  // the person confirms that PC's host key in the dialog, as asked
  type Waiting = { wait(job: { public: SetupJob }): Promise<string> };
  const prototype = MachineManager.prototype as unknown as Waiting;
  const wait = prototype.wait;
  const asked: string[] = [];
  const answering = spyOn(prototype, "wait").mockImplementation(function (this: Waiting, job) {
    const pending = wait.call(this, job);
    const challenge = job.public.challenge;
    if (challenge?.kind === "host_key") { asked.push(challenge.prompt); manager.action(job.public.id, { action: "answer", challenge_id: challenge.id, answer: "yes" }); }
    return pending;
  });
  cleanups.push(() => answering.mockRestore());
  const settled = (start: () => SetupJob) => new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const timeout = setTimeout(() => { off(); reject(new Error(`setup did not settle: ${JSON.stringify(job)}`)); }, 60_000);
    const off = manager.subscribe(() => {
      if (job && ["failed", "connected", "cancelled"].includes(job.phase)) { clearTimeout(timeout); off(); resolve(job); }
    });
    job = start();
  });

  // 1. no Ovis there: the add asks for Ovis to be installed, after the host key was confirmed; nothing is listed
  const first = await settled(() => manager.setup({ ...pc.target, account_add: true }));
  expect([first.phase, first.action_required]).toEqual(["failed", "install_ovis"]);
  expect(asked).toHaveLength(1);
  expect(existsSync(join(pc.home, ".config", "herdr-web-ui", "bridges"))).toBe(false);

  // 2. the existing installer, over SSH keys only, from the local artifact: that PC's own Ovis starts and connects
  const install = manager.install(pc.target);
  await (manager as unknown as { installer: { finished(id: string): Promise<void> } }).installer.finished(install.id);
  const installed = manager.installJob(install.id)!;
  expect([installed.phase, installed.error]).toEqual(["connected", null]);
  const machineId = manager.job(installed.connect_job!)?.machine_id;
  expect(manager.list().find((machine) => machine.id === machineId)?.state).toBe("connected");

  // 3. the add again, on the PC the install added: it lands on that PC's own Ovis and reads its public fields
  const added = await settled(() => manager.setup({ ...pc.target, machine_id: machineId!, account_add: true }));
  expect([added.phase, added.error]).toEqual(["connected", null]);
  const target = added.account_add!;
  expect(target.account).toBeNull();
  expect(asked).toHaveLength(1);
  expect(manager.list().filter((machine) => machine.target?.port === pc.target.port)).toHaveLength(1);

  // 4. the window lists and admits it with its own fresh two-step sign-in
  const token = fake.issueToken("acct_1", { twoStep: true });
  const call = (path: string, method: string, body?: unknown) => fake.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  expect((await call(`/v1/pcs/${target.server_id}`, "PUT", { label: target.label, public_key: bytesToHex(importPublicKey(target.public_key)), relay: target.relay })).ok).toBe(true);
  expect((await call(`/v1/pcs/${target.server_id}/admit`, "POST", {})).ok).toBe(true);

  // 5. this PC hands it the account; that PC takes the admission on its own proof, binds, completes its add, and turns
  // its relay on: off since the install, it answers once it is online
  expect(await manager.accountTake(added.id, target.server_id, "acct_1")).toEqual({ account: "acct_1", relay: { phase: "online", blocked: null } });
  const listed = ((await (await call("/v1/pcs", "GET")).json()) as { pcs: { server_id: string; completed_at: string | null }[] }).pcs.find((entry) => entry.server_id === target.server_id);
  expect(listed?.completed_at).toEqual(expect.any(String));
}, 240_000);
