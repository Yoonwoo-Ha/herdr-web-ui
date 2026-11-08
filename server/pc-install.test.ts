import { afterEach, describe, expect, it } from "bun:test";
import { createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as listenOn } from "node:net";
import { tmpdir } from "node:os";
import { readProcessBirth } from "./process-owner.ts";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type PcInstallFailure, type PcInstallJob } from "../shared/machines.ts";
import { bornAs, captureServer, type InstallConnect, installerRun, installPlanFor, PcInstaller, processIdentity, restoreServer, SAVED_SERVER, startedBeforeRegistration } from "./pc-install.ts";
import { SshConnection } from "./ssh.ts";

// A PC reached over SSH, as a script-answering stand-in: every command this app would run there is answered here,
// and none reaches a real PC, the user's herdr or the network. An unexpected command fails the test.
const SOCKET = "/home/fx/.config/herdr/herdr.sock";
interface Descriptor { pid: number; port: number; token: string; socket_path: string; managed_remote: boolean; bridge_protocol: number; bundle_version: string; birth?: { platform: string; value: string } }
const descriptor = (pid: number, managed = false, token = "a".repeat(64)): Descriptor => ({ pid, port: 7317, token, socket_path: SOCKET, managed_remote: managed, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION });
interface Pc {
  /** what ssh says when it cannot get in with keys, or nothing */
  refused?: string;
  os?: string;
  tools?: string[];
  freeKb?: number;
  writable?: boolean;
  herdrRunning?: boolean;
  /** an Ovis installed there, and how it starts itself */
  launcher?: "plugin" | "systemd";
  /** what `ps` names the process of the plan's pid: an Ovis server unless set */
  command?: string;
  /** the new Ovis registers with this pid: one an old descriptor already named, reused */
  newPid?: number;
  /** a server started by hand beside the launcher: restarting the launcher leaves it running */
  besideLauncher?: boolean;
  /** the probe's SSH command fails, as a dropped connection does */
  probeFails?: boolean;
  /** the installer's answer: its exit status and last words; it starts the plugin when herdr runs */
  installer?: { exit: number; output: string };
  /** the installed Ovis never registers */
  neverStarts?: boolean;
  /** its server's command, folder and environment cannot be copied (macOS has no /proc) */
  uncapturable?: boolean;
  /** the copied server, started again, never registers */
  restoreFails?: boolean;
  /** /proc is there, but its server could not be copied this time */
  captureFails?: boolean;
  /** its server can never be copied faithfully (its program deleted, say) */
  unfaithful?: boolean;
  /** starting herdr headless fails there */
  headlessFails?: boolean;
  /** the planned pid is taken by another process after this many reads of its identity (pid reuse) */
  reusedAfterReads?: number;
  /** the copied server's address is held by a live server when it is to be started again */
  addressTaken?: boolean;
  /** Settings -> Experimental -> PCs: start a replaced server again; on in these tests unless said */
  restoreOff?: boolean;
  /** the birth each pid's process has now, where it differs from what its registration recorded (a pid reused) */
  births?: Record<number, string>;
  /** pids whose process started after its birth-less registration was written (a pid reused later) */
  startedLate?: number[];
  /** pids that run another program than Ovis now (a registration left behind, its pid reused) */
  otherPrograms?: number[];
  /** the stop signal does not end the server */
  killIgnored?: boolean;
  /** the server ends this many liveness checks after the stop signal (Ovis takes a moment to stop) */
  exitAfterChecks?: number;
  /** its launcher's start fails there, with these words */
  launcherFails?: string;
  /** the installer's SSH command ends without its answer, with these words (a dropped connection, its time up) */
  installerDrops?: string;
  /** the installer's command holds until this settles, and tells when it starts */
  installerHeld?: { started(): void; gate: Promise<void> };
  descriptors?: Descriptor[];
}

const cleanups: (() => void)[] = [];
/** a port nothing listens on now, for a stand-in server's own address */
async function freePort(): Promise<number> {
  const probe = listenOn(() => {});
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(pc: Pc) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pc-install-"));
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close };
  cleanups.push(() => { Object.assign(SshConnection.prototype, real); rmSync(dir, { recursive: true, force: true }); });
  const listed: Descriptor[] = [...(pc.descriptors ?? [])];
  const alive = new Set(listed.map((d) => d.pid));
  /** each pid's identity (its start and owner), and how often it was read */
  let identityReads = 0;
  const identity = (pid: number) => pid === 4242 && pc.reusedAfterReads !== undefined && identityReads > pc.reusedAfterReads ? "Mon Nov  9 09:00:00 2026 1000" : `Sun Nov  8 08:00:00 2026 1000 ${pid}`;
  /** whether a script's sameProcess gate holds for that pid now */
  /** whether a script's bornAs gates hold: the process at that pid has the birth its registration recorded */
  const bornAsShown = (script: string) => [...script.matchAll(/born_of=(\d+);[\s\S]*?\)" = '([^']*)' \]/g)].every((m) => (pc.births?.[Number(m[1])] ?? m[2]) === m[2])
    && [...script.matchAll(/reg_of=(\d+);/g)].every((m) => !pc.startedLate?.includes(Number(m[1])));
  const sameAsShown = (script: string) => { const m = /\[ "\$\(id_of=(\d+);[\s\S]*?fi\)" = '([^']*)' \]/.exec(script); if (!m) return true; identityReads++; return identity(Number(m[1])) === m[2]; };
  /** signalled servers still stopping, and how many liveness checks each has left */
  const dying = new Map<number, number>();
  const commands: string[] = [];
  const challenges: unknown[] = [];
  const register = () => { if (pc.neverStarts) return; const next = descriptor(pc.newPid ?? 5555, false, "b".repeat(64)); listed.push(next); alive.add(next.pid); };
  SshConnection.prototype.start = async (challenge?: unknown) => { challenges.push(challenge); if (pc.refused) throw new Error(pc.refused); };
  SshConnection.prototype.close = () => {};
  SshConnection.prototype.run = async (script: string) => {
    commands.push(script);
    if (script.includes("free_kb=")) {
      if (pc.probeFails) throw new Error("Connection to lab.invalid closed by remote host.");
      const tools = pc.tools ?? ["curl", "git", "tar"];
      return [`os=${pc.os ?? "Linux"}`, "arch=x86_64", ...tools.map((tool) => `has=${tool}`), ...(pc.writable === false ? [] : ["writable=1"]), `free_kb=${pc.freeKb ?? 50_000_000}`,
        "herdr=1", ...(pc.herdrRunning === false ? [] : ["herdr_running=1"]), `launcher=${pc.launcher ?? "none"}`].join("\n") + "\n";
    }
    // the copy of a server before it is stopped, its start again, and its removal
    if (script.startsWith("id_of=")) { identityReads++; return identity(Number(/^id_of=(\d+)/.exec(script)![1])) + "\n"; }
    if (script.includes("ovis-restore.XXXXXXXX") && !sameAsShown(script)) return "changed\n";
    if (script.includes("ovis-restore.XXXXXXXX")) return pc.uncapturable ? "" : pc.captureFails ? "error\n" : pc.unfaithful ? "unfaithful\n" : "/tmp/ovis-restore.Ab12Cd34\n";
    if (script.includes('[ -L "$d/exe" ]') && pc.addressTaken) return "taken\n";
    if (script.includes('[ -L "$d/exe" ]')) { if (!pc.restoreFails) { const back = descriptor(4243, false, "d".repeat(64)); listed.push(back); alive.add(back.pid); } return ""; }
    if (script.startsWith("rm -rf '") && script.includes("ovis-restore.")) return "";
    // the installer's run first: its watcher's own `kill -TERM 0` is no stop of a process
    if (script.includes("/install.sh -o")) {
      if (pc.installerHeld) { pc.installerHeld.started(); await pc.installerHeld.gate; }
      if (pc.installerDrops) throw new Error(pc.installerDrops);
      const answer = pc.installer ?? { exit: 0, output: "Ovis: installing the herdr plugin" };
      if (answer.exit === 0 && pc.herdrRunning !== false) register();
      return `${answer.output}\novis-install-exit=${answer.exit}\n`;
    }
    if (script.includes("uname -s") && script.includes("bundle-ready")) return `Linux\nx86_64\n/home/fx\n/home/fx/.config\n/usr/bin/herdr\n${listed.map((d) => JSON.stringify(d)).join("\n")}\n`;
    if (script.includes("socket=")) return SOCKET;
    if (script.startsWith("ps -o args=") && pc.otherPrograms?.includes(Number(/-p (\d+)/.exec(script)![1]))) return "/usr/bin/vim notes.txt";
    if (script.startsWith("ps -o args=")) return pc.command ?? "/home/fx/.bun/bin/bun /home/fx/ovis/server/index.ts";
    if (script.includes("kill -0")) {
      const pid = Number(/kill -0 (\d+)/.exec(script)![1]);
      if (dying.has(pid)) { const left = dying.get(pid)! - 1; if (left <= 0) { dying.delete(pid); alive.delete(pid); } else dying.set(pid, left); }
      return alive.has(pid) ? "live" : "";
    }
    if (script.endsWith("&& echo born || true")) return bornAsShown(script) ? "born\n" : "";
    if (script.includes("kill -TERM")) {
      const pid = Number(/kill -TERM (\d+)/.exec(script)![1]);
      if (!bornAsShown(script) || !sameAsShown(script)) return "changed\n";
      if (pc.exitAfterChecks) dying.set(pid, pc.exitAfterChecks); else if (!pc.killIgnored) alive.delete(pid);
      return script.includes("echo stopping") ? "stopping\n" : "";
    }
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) return listed.map((d) => JSON.stringify(d)).join("\n") + "\n";
    if (script.includes(" server </dev/null")) { if (pc.headlessFails) throw new Error("herdr: could not start the server"); register(); return ""; }
    if (pc.launcherFails && (script.includes("devswha.ovis.start") || script.includes("ovis.service"))) throw new Error(pc.launcherFails);
    if (script.includes("devswha.ovis.start") || script.includes("ovis.service")) { if (!pc.besideLauncher && (script.includes("devswha.ovis.stop") || script.includes("restart"))) for (const d of listed) alive.delete(d.pid); register(); return ""; }
    throw new Error(`Unexpected remote command: ${script}`);
  };
  const connects: Parameters<InstallConnect>[0][] = [];
  let answer: string | null = null;
  /** while set, the connect after the install waits for it */
  let held: Promise<void> | null = null;
  let cancelled = 0;
  /** each connect's follow-up hook, to tell it a second setup started */
  const followUps: ((id: string) => void)[] = [];
  const connect: InstallConnect = (request) => { const { onJob, ...asked } = request; connects.push(asked); if (onJob) followUps.push(onJob); return { job_id: "setup-job", cancel: () => { cancelled++; }, finished: (held ?? Promise.resolve()).then(() => answer) }; };
  /** resolves once a job reaches a phase, told by the installer's own change events */
  const waiters: { phase: string; resolve(): void }[] = [];
  const onChange = (job: PcInstallJob) => { for (const waiter of waiters.splice(0)) if (waiter.phase === job.phase) waiter.resolve(); else waiters.push(waiter); };
  const reached = (phase: string) => new Promise<void>((resolve) => { waiters.push({ phase, resolve }); });
  const installer = new PcInstaller({ sshDir: join(dir, "ssh"), connect, release: "v9.9.9", pollMs: 1, startMs: 200, stopMs: 100, onChange, restore: () => !pc.restoreOff });
  cleanups.push(() => installer.stop());
  const settled = async (job: PcInstallJob) => { await installer.finished(job.id); return installer.job(job.id)!; };
  return { installer, commands, challenges, connects, settled, alive, registerNew: register, failConnect: (words: string) => { answer = words; }, holdConnect: (gate: Promise<void>) => { held = gate; }, cancelled: () => cancelled, reached, followUps, installerAnswer: (answer: { exit: number; output: string }) => { pc.installer = answer; } };
}

const target = { destination: "me@lab.invalid" };
const installs = (commands: string[]) => commands.filter((command) => command.includes("install.sh"));

describe("which PCs an install over SSH is offered for", () => {
  it("offers one on Linux and macOS, never on Windows, where the installer and its checks are not the ones used", () => {
    const target = { destination: "me@pc.invalid" };
    expect(installPlanFor("replace", "posix", 4242, target)).toEqual({ mode: "replace", pid: 4242, target });
    expect(installPlanFor("restart", "posix", 4242, target)).toEqual({ mode: "restart", pid: 4242, target });
    expect(installPlanFor("replace", "windows", 4242, target)).toBeUndefined();
    expect(installPlanFor(undefined, "posix", 4242, target)).toBeUndefined();
  });
});

describe("installing Ovis on a PC over SSH", () => {
  it("runs the official installer pinned to this app's release with keys only, waits for it to answer, then connects it", async () => {
    const pc = fixture({});
    const job = await pc.settled(pc.installer.start({ target, name: "Lab" }));
    expect(job).toMatchObject({ phase: "connected", error: null, error_code: null, connect_job: "setup-job", mode: "install", machine_id: null });
    expect(pc.challenges).toEqual([undefined]);
    expect(installs(pc.commands)).toHaveLength(1);
    // downloaded to a file and run from it: piped into a sh whose stdin is /dev/null, nothing would run at all
    // the installer of the release it installs, from that release's own tag: never a newer copy
    expect(installs(pc.commands)[0]).toContain("curl -fsSL --max-time 120 https://raw.githubusercontent.com/devswha/ovis/v9.9.9/install.sh -o \"$script\"");
    expect(installs(pc.commands)[0]).toContain("OVIS_REF=v9.9.9 OVIS_RUNTIME=herdr OVIS_NO_OPEN=1 sh \"$script\" </dev/null");
    expect(installs(pc.commands)[0]).not.toContain("| OVIS_REF");
    expect(pc.connects).toEqual([{ target, name: "Lab", update: false }]);
  });

  it("starts herdr without a terminal when the installed plugin waits for it", async () => {
    const pc = fixture({ herdrRunning: false });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("connected");
    expect(pc.commands.some((command) => command.includes("nohup herdr server </dev/null"))).toBe(true);
  });

  const refusals: [string, Pc, PcInstallFailure, RegExp][] = [
    ["keys are not let in", { refused: "me@lab.invalid: Permission denied (publickey,password)." }, "ssh_refused", /did not let this app in with SSH keys/],
    ["its host key is unknown", { refused: "Host key verification failed." }, "ssh_host_key", /host key is not known here/],
    ["it cannot be reached", { refused: "ssh: Could not resolve hostname lab.invalid: Name or service not known" }, "ssh_unreachable", /could not be reached over SSH: ssh: Could not resolve hostname/],
    ["it runs Windows", { os: "MINGW64_NT-10.0" }, "unsupported", /Linux and macOS/],
    ["it has no curl", { tools: ["git", "tar"] }, "missing_tool", /has no curl/],
    ["its disk is full", { freeKb: 200_000 }, "disk", /only 195 MB free/],
    ["its home is not writable", { writable: false }, "permission", /cannot write to its own home folder/],
    ["this app's bridge serves it", { descriptors: [descriptor(4242, true)] }, "bridge_there", /runs this app's bridge/],
    ["Ovis already runs there", { descriptors: [descriptor(4242)] }, "ovis_there", /Ovis already runs on that PC/],
  ];
  for (const [when, pcState, code, words] of refusals) it(`says in plain words why it cannot install when ${when}, and installs nothing`, async () => {
    const pc = fixture(pcState);
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("failed");
    expect(job.error_code).toBe(code);
    expect(job.error).toMatch(words);
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.connects).toEqual([]);
  });

  it("refuses a named herdr session, which the installer does not serve", async () => {
    const pc = fixture({});
    const job = await pc.settled(pc.installer.start({ target: { ...target, session: "work" } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "unsupported" });
    expect(pc.commands).toEqual([]);
  });

  it("tells the installer's own last words when it fails there", async () => {
    const pc = fixture({ installer: { exit: 1, output: "Ovis: needs herdr 0.9.0 or newer; this is 0.8.1." } });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(job.error).toBe("The Ovis installer failed on that PC: Ovis: needs herdr 0.9.0 or newer; this is 0.8.1.");
  });

  it("fails in plain words when the installed Ovis never starts, or the connect after it fails", async () => {
    const silent = fixture({ neverStarts: true });
    expect(await silent.settled(silent.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "not_started" });
    const refused = fixture({});
    refused.failConnect("This PC needs a password.");
    expect(await refused.settled(refused.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "connect_failed", error: "This PC needs a password." });
  });

  it("replaces a server started by hand: stops that very process, installs, and connects the PC it was for", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "replace", machine_id: "pc-1" });
    expect(pc.alive.has(4242)).toBe(false);
    expect(pc.commands.findIndex((command) => command.includes("kill -TERM 4242"))).toBeLessThan(pc.commands.findIndex((command) => command.includes("install.sh")));
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: false }]);
  });

  it("restarts a too-old supervisor through its own launcher, stopping it there rather than by its pid, then asks for the update", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "plugin" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "restart" });
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("herdr plugin action invoke devswha.ovis.stop") && command.includes("devswha.ovis.start"))).toBe(true);
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: true }]);
  });

  it("stops nothing for a restart when no launcher there could start it again", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "no_launcher" });
    expect(pc.alive.has(4242)).toBe(true);
    expect(pc.commands.some((command) => command.includes("kill") && !command.includes("kill -0"))).toBe(false);
  });

  it("stops nothing when the pid of the server shown now runs another program", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], command: "/usr/bin/vim notes.txt" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("starts an Ovis already installed there through its launcher and updates it, instead of an installer that would keep its release", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "systemd" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "replace" });
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: true }]);
  });

  it("knows the new Ovis by its new token even when it reuses an old process id", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], newPid: 4242 });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("connected");
  });

  it("cancels the connect it handed over to, and never reports a cancelled install as connected", async () => {
    const pc = fixture({});
    const gate = Promise.withResolvers<void>();
    pc.holdConnect(gate.promise);
    const handedOver = pc.reached("connecting_pc");
    const started = pc.installer.start({ target });
    await handedOver;
    pc.installer.cancel(started.id);
    gate.resolve();
    expect(await pc.settled(started)).toMatchObject({ phase: "cancelled" });
    expect(pc.cancelled()).toBe(1);
  });

  it("stops nothing when the server it was asked to replace is no longer the one there", async () => {
    const pc = fixture({ descriptors: [descriptor(4343)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
  });

  it("ends a cancelled install before anything more runs there", async () => {
    const pc = fixture({ neverStarts: true });
    const started = pc.installer.start({ target });
    pc.installer.cancel(started.id);
    const job = await pc.settled(started);
    expect(job.phase).toBe("cancelled");
    expect(pc.connects).toEqual([]);
  });

  it("says the server it stopped is gone when the install then fails, and installs on a retry with nothing left to stop", async () => {
    // a server that cannot be copied (macOS): it stays stopped, as the job says
    const pc = fixture({ descriptors: [descriptor(4242)], uncapturable: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const failed = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(failed).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(failed.error).toContain("already stopped, so none runs there now");
    pc.installerAnswer({ exit: 0, output: "Ovis: installing the herdr plugin" });
    const retried = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(retried).toMatchObject({ phase: "connected", error: null });
    expect(pc.commands.filter((command) => command.includes("kill -TERM 4242"))).toHaveLength(1);
  });

  it("restarts through the launcher on a retry after a restart whose launcher stopped the server and failed to start one", async () => {
    // the planned server is gone, and no Ovis runs there: the launcher is asked again instead of failing as changed
    const pc = fixture({ launcher: "systemd" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", error: null });
    expect(pc.commands.some((command) => command.includes("ovis.service"))).toBe(true);
  });

  it("restarts through the launcher on a retry when the planned server is gone and its pid now runs something else", async () => {
    // after a reboot: no Ovis is registered there, and the old pid belongs to an unrelated process
    const pc = fixture({ launcher: "systemd" });
    pc.alive.add(4242);
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", error: null });
    // the Ovis the launcher started is never stopped as one left beside it
    expect(pc.commands.some((command) => /kill -TERM 5555/.test(command))).toBe(false);
  });

  it("fails with a code when the installer's SSH command ends without its answer", async () => {
    const pc = fixture({ installerDrops: "Connection to lab.invalid closed by remote host." });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job).toMatchObject({ phase: "failed", error_code: "ssh_unreachable", error: expect.stringContaining("closed by remote host") });
  });

  it("fails in plain words, with its code, when the launcher's start fails there", async () => {
    const pc = fixture({ launcher: "systemd", launcherFails: "Failed to start ovis.service: Unit not found." });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "not_started", error: expect.stringContaining("Ovis could not be started on that PC: Failed to start ovis.service") });
  });

  it("says the server it stopped is gone only while nothing was started in its place", async () => {
    // the installer ran and its Ovis started, then the connect failed: the stopped one is not said to be all there is
    const pc = fixture({ descriptors: [descriptor(4242)] });
    pc.failConnect("refused by that PC");
    const failed = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(failed).toMatchObject({ phase: "failed", error_code: "connect_failed" });
    expect(failed.error).not.toContain("none runs there now");
    expect(failed.error).toContain("installed in its place");
  });

  it("stops nothing when the shown server's pid now belongs to another Ovis server, by its token", async () => {
    // the planned pid runs an Ovis server, but not the one shown: another took that pid since
    const pc = fixture({ descriptors: [descriptor(4242, false, "c".repeat(64))] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242, token: "a".repeat(64) } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(false);
  });

  it("says another may have been installed when it is cancelled while the installer still runs there", async () => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    // a server that cannot be copied (macOS): nothing is started again, and the words say what may be there
    const pc = fixture({ descriptors: [descriptor(4242)], uncapturable: true, installerHeld: { started: () => started.resolve(), gate: gate.promise } });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await started.promise;
    pc.installer.cancel(job.id);
    // the cancel closed the SSH connection: the installer's command ends without telling how the installer did
    gate.reject(new Error("Connection cancelled"));
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error).not.toContain("none runs there now");
    expect(ended.error).toContain("being installed in its place");
  });

  it("stops nothing when the shown server ended and another Ovis took its pid, the setting off: its registration's birth differs", async () => {
    // the registration that was shown, of a server long gone; the pid now runs another Ovis server
    const pc = fixture({ descriptors: [{ ...descriptor(4242), birth: { platform: "linux", value: "boot-1:100" } }], births: { 4242: "boot-1:900" }, restoreOff: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.commands.some((command) => /kill -TERM 4242$/.test(command) || command.includes("&& kill -TERM 4242"))).toBe(false);
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("stops a server whose registration recorded no birth (0.5.x) only if it started before that registration, the setting off", async () => {
    // the pid now runs a process that started after the registration was written: another, never stopped
    const late = fixture({ descriptors: [descriptor(4242)], startedLate: [4242], restoreOff: true });
    const job = await late.settled(late.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(job.error).toContain("started after that Ovis registered");
    expect(late.alive.has(4242)).toBe(true);
    // the genuine old server, which started before it registered: stopped and replaced
    const genuine = fixture({ descriptors: [descriptor(4242)], restoreOff: true });
    expect((await genuine.settled(genuine.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }))).phase).toBe("connected");
    expect(genuine.alive.has(4242)).toBe(false);
  });

  it("stops the shown server when its birth still matches its registration", async () => {
    const pc = fixture({ descriptors: [{ ...descriptor(4242), birth: { platform: "linux", value: "boot-1:100" } }], restoreOff: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("connected");
    expect(pc.alive.has(4242)).toBe(false);
  });

  it("never copies or starts again the server it stopped while that setting is off (the default): it stays stopped, as before", async () => {
    for (const how of ["failed", "cancelled"] as const) {
      const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const pc = fixture({ descriptors: [descriptor(4242)], restoreOff: true,
        ...(how === "failed" ? { installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } } : { installerHeld: { started: () => started.resolve(), gate: gate.promise } }) });
      const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
      if (how === "cancelled") { await started.promise; pc.installer.cancel(job.id); gate.reject(new Error("Connection cancelled")); }
      const ended = await pc.settled(job);
      expect(ended.phase).toBe(how);
      expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(true);
      expect(pc.commands.some((command) => command.includes("ovis-restore."))).toBe(false);
      expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
      expect(pc.alive.has(4243)).toBe(false);
    }
  });

  it("starts the server it stopped again as it was when the installer then fails", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(job.error).toContain("has been started again as it was");
    // copied before it was stopped, and started again from that copy
    const at = (pattern: RegExp) => pc.commands.findIndex((command) => pattern.test(command));
    expect(at(/ovis-restore\.XXXXXXXX/)).toBeLessThan(at(/kill -TERM 4242/));
    expect(at(/\[ -L "\$d\/exe" \]/)).toBeGreaterThan(at(/install\.sh -o/));
    expect(pc.alive.has(4243)).toBe(true);
  });

  it("starts nothing again once its replacement is installed, even before that one answers: its start may still be on its way", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], neverStarts: true });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await pc.reached("starting");
    pc.installer.cancel(job.id);
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error).toContain("installed in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("waits for a server still stopping when the install is cancelled, then starts it again as it was, over a new connection", async () => {
    // it takes a moment to stop after the signal, and the cancel comes meanwhile
    const pc = fixture({ descriptors: [descriptor(4242)], exitAfterChecks: 3 });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await pc.reached("stopping");
    pc.installer.cancel(job.id);
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error).toBe("Cancelled. The Ovis started by hand on that PC was stopped for the install, and has been started again as it was.");
    expect(pc.alive.has(4243)).toBe(true);
  });

  it("removes the copy and starts nothing again once the new Ovis is installed", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("connected");
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("starts nothing beside an Ovis that already came up in its place, and says when starting it again fails", async () => {
    // cancelled while the installer ran, which had already started its Ovis there
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const pc = fixture({ descriptors: [descriptor(4242)], installerHeld: { started: () => started.resolve(), gate: gate.promise } });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await started.promise;
    pc.registerNew();
    pc.installer.cancel(job.id);
    gate.reject(new Error("Connection cancelled"));
    const ended = await pc.settled(job);
    expect(ended.error).toContain("being installed in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    // started again, but it never comes up: the job says so
    const failing = fixture({ descriptors: [descriptor(4242)], restoreFails: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const failed = await failing.settled(failing.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(failed.error).toContain("starting it again as it was failed: it did not start within");
  });

  it("stops nothing when /proc is there but the server could not be copied first", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], captureFails: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "not_stopped", error: expect.stringContaining("could not be copied first") });
    expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(false);
  });

  it("starts nothing again, but removes the copy, when cancelled while the installer still ran there", async () => {
    // a start of the installer's own may still be on its way: no second server beside it
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const pc = fixture({ descriptors: [descriptor(4242)], installerHeld: { started: () => started.resolve(), gate: gate.promise } });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await started.promise;
    pc.installer.cancel(job.id);
    gate.reject(new Error("Connection cancelled"));
    const ended = await pc.settled(job);
    expect(ended.error).toContain("being installed in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("starts nothing again when cancelled while the server it signalled still runs, and removes the copy", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], killIgnored: true });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await pc.reached("stopping");
    pc.installer.cancel(job.id);
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error ?? "").not.toContain("stopped");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("replaces a server that can never be copied faithfully, as on macOS, and says it stays stopped when the install then fails", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], unfaithful: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(true);
    expect(job.error).toContain("none runs there now");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("starts nothing again when herdr was started headless for its plugin, or the installer itself failed: either may have started one", async () => {
    // an installed plugin, herdr not running: starting it headless fails, but may have started the plugin's own Ovis
    const headless = fixture({ descriptors: [descriptor(4242)], launcher: "plugin", herdrRunning: false, headlessFails: true });
    const one = await headless.settled(headless.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(one.phase).toBe("failed");
    expect(headless.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    // the installer ran and failed later than its download
    const late = fixture({ descriptors: [descriptor(4242)], installer: { exit: 1, output: "Ovis: building failed" } });
    const two = await late.settled(late.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(two.phase).toBe("failed");
    expect(late.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(late.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("copies and stops nothing once the planned pid belongs to another process: at the check, before the copy, or before the stop", async () => {
    // identity reads: two around the command-line check, one gating the copy, one gating the stop
    for (const [after, copied] of [[1, false], [2, false], [3, true]] as const) {
      const pc = fixture({ descriptors: [descriptor(4242)], reusedAfterReads: after });
      const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
      expect([after, job.phase, job.error_code]).toEqual([after, "failed", "changed"]);
      // never signalled: the process at that pid is not the one shown
      expect(pc.alive.has(4242)).toBe(true);
      // a copy made before the pid changed hands is removed again
      expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(copied);
    }
  });

  it("starts nothing beside any live server on the session's socket, a managed bridge on another port included", async () => {
    // a connection server's bridge serves this herdr session too, on its own port
    const pc = fixture({ descriptors: [descriptor(4242), descriptor(4300, true, "e".repeat(64))], installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.error).toContain("another already runs in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("says another may have been installed when the installer fails after its download, the setting off", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], restoreOff: true, installer: { exit: 1, output: "Ovis: building failed" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(job.error).toContain("another may have been installed in its place");
  });

  it("starts nothing beside a live server that holds the address, and says so", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], addressTaken: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("another already runs in its place");
    expect(pc.alive.has(4243)).toBe(false);
  });

  it("starts herdr headless for an installed plugin when herdr is not running, instead of a plugin action that needs it", async () => {
    const pc = fixture({ launcher: "plugin", herdrRunning: false });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("connected");
    expect(pc.commands.some((command) => command.includes("herdr plugin action invoke"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("nohup herdr server </dev/null"))).toBe(true);
  });

  it("connects nothing when the launcher's restart leaves the planned server running beside it", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "plugin", besideLauncher: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "not_stopped" });
    expect(pc.connects).toEqual([]);
    // the Ovis the launcher started beside it is stopped again; the planned one is left as it was
    expect(pc.alive.has(5555)).toBe(false);
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("tells a connection dropped while it looks at the PC as one, not as an unsupported PC", async () => {
    const pc = fixture({ probeFails: true });
    expect(await pc.settled(pc.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "ssh_unreachable" });
  });

  it("follows the connect that updates it when the first one found it still older", async () => {
    const pc = fixture({});
    const gate = Promise.withResolvers<void>();
    pc.holdConnect(gate.promise);
    const handedOver = pc.reached("connecting_pc");
    const started = pc.installer.start({ target });
    await handedOver;
    expect(pc.installer.job(started.id)?.connect_job).toBe("setup-job");
    pc.followUps[0]!("update-job");
    expect(pc.installer.job(started.id)?.connect_job).toBe("update-job");
    gate.resolve();
    expect((await pc.settled(started)).phase).toBe("connected");
  });

  it("keeps the PC busy after a cancel until the install's own run has ended", async () => {
    const pc = fixture({});
    const gate = Promise.withResolvers<void>();
    pc.holdConnect(gate.promise);
    const handedOver = pc.reached("connecting_pc");
    const started = pc.installer.start({ target });
    await handedOver;
    pc.installer.cancel(started.id);
    expect(pc.installer.job(started.id)?.phase).toBe("cancelled");
    expect(pc.installer.runningAt(target)?.id).toBe(started.id);
    gate.resolve();
    await pc.settled(started);
    expect(pc.installer.runningAt(target)).toBeUndefined();
  });
});

// the installer's own command, run by a real shell in a session of its own (as sshd runs a command), its output read
// through a pipe as SSH reads it. Linux CI has setsid; elsewhere this is skipped
describe.skipIf(!Bun.which("setsid") || !Bun.which("curl"))("the installer's run on that PC", () => {
  const fakeInstaller = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-installer-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "install.sh");
    writeFileSync(path, "#!/bin/sh\n" + body.replaceAll("$DIR", dir));
    return { dir, url: "file://" + path };
  };

  it("tells the installer's exit status as its last line, and ends with it", async () => {
    const { url } = fakeInstaller("echo installing\nexit 3\n");
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", installerRun("v0.5.1", url)], { stdout: "pipe", stderr: "ignore" });
    const lines = (await new Response(run.stdout).text()).split("\n").map((line) => line.trim()).filter(Boolean);
    expect(await run.exited).toBe(0);
    expect(lines).toEqual(["installing", "ovis-install-exit=3"]);
  });

  it("stops the installer once nobody reads its output any more, as when a cancel closes the SSH connection", async () => {
    // the installer holds a pipe open for as long as it runs: its end there is the end of what this reads
    const { dir, url } = fakeInstaller("echo started\nexec sleep 60 3>$DIR/held\n");
    expect(await Bun.spawn(["mkfifo", join(dir, "held")]).exited).toBe(0);
    const held = new Promise<void>((resolve) => createReadStream(join(dir, "held")).on("close", () => resolve()).resume());
    // the reader stands in for SSH: it goes away once the installer has started, as a cancelled connection does
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", 'sh -c "$1" | { while IFS= read -r line; do [ "$line" = started ] && break; done; }', "ssh", installerRun("v0.5.1", url)], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => run.kill());
    await held;
    await run.exited;
  }, 20_000);

  it("starts no installer once nobody reads, even when the connection closed while it was still downloading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-installer-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // a download that has not ended: the installer comes through a pipe this test keeps open
    const pipe = join(dir, "install.sh");
    expect(await Bun.spawn(["mkfifo", pipe]).exited).toBe(0);
    const download = createWriteStream(pipe).on("error", () => {});
    download.write("#!/bin/sh\necho ran > " + join(dir, "ran") + "\n");
    // the reader stands in for SSH, closed at once, as by a cancel while it downloads
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", 'sh -c "$1" | { IFS= read -r line; }', "ssh", installerRun("v0.5.1", "file://" + pipe)], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => run.kill());
    await run.exited;
    // the download ends only now, after the command was stopped: nothing is left to run it
    download.end();
    expect(existsSync(join(dir, "ran"))).toBe(false);
  }, 20_000);

  it("starts no installer when the connection closed just before the download ended, before the watcher writes again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-installer-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pipe = join(dir, "install.sh"), source = join(dir, "source.sh");
    writeFileSync(source, "#!/bin/sh\necho ran > " + join(dir, "ran") + "\n");
    expect(await Bun.spawn(["mkfifo", pipe]).exited).toBe(0);
    // the reader stands in for SSH: it closes the connection, then lets the download end at once, well inside the
    // watcher's two seconds
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", 'sh -c "$1" | { IFS= read -r line; exec 0<&-; cat "$2" > "$3"; }', "ssh", installerRun("v0.5.1", "file://" + pipe), source, pipe], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => run.kill());
    await run.exited;
    expect(existsSync(join(dir, "ran"))).toBe(false);
  }, 20_000);
});

// the copy of a server started by hand, made before it is stopped, and its start again after an install that failed or was
// cancelled: real shells on this PC's own /proc (Linux), with a stand-in server in a folder and environment of its own
describe.skipIf(!existsSync("/proc/self/environ") || !Bun.which("setsid"))("starting a stopped server again as it was", () => {
  const shell = async (script: string, env: Record<string, string>) => {
    const run = Bun.spawn(["sh", "-c", script], { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    return out.trim();
  };

  it("copies a server's program, arguments, folder and environment before it is stopped, and starts it again exactly so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // a folder whose name ends in a newline, and Bun at a path with "=" in it where it can be linked there
    const home = join(dir, "home"), work = join(dir, "work\n"), mark = join(dir, "mark");
    mkdirSync(home); mkdirSync(work); mkdirSync(join(dir, "x=y"));
    let bun = join(dir, "x=y", "bun");
    try { linkSync(process.execPath, bun); } catch { bun = process.execPath; }
    // its token has a space and a quote, and its environment is far longer than one command line's argument
    const env: Record<string, string> = { PATH: process.env.PATH!, HOME: home, OVIS_TOKEN: "tok'en with space", MARK: mark, PORT: String(await freePort()) };
    for (let i = 0; i < 60; i++) env[`OVIS_PAD_${i}`] = "x".repeat(4000);
    const server = Bun.spawn([bun, "-e", 'require("node:fs").writeFileSync(process.env.MARK, [process.pid, process.env.OVIS_TOKEN, process.cwd()].join("|")); console.log("up"); setInterval(() => {}, 1000);', "--flag=value"], { cwd: work, env, stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const before = { environ: readFileSync(join("/proc", String(server.pid), "environ")), cmdline: readFileSync(join("/proc", String(server.pid), "cmdline")) };
    const saved = await shell(captureServer(server.pid, await shell(processIdentity(server.pid), {})), { HOME: home, TMPDIR: dir });
    expect(saved).toMatch(SAVED_SERVER);
    expect(statSync(saved).mode & 0o777).toBe(0o700);
    server.kill();
    await server.exited;
    // the started-again server tells the same through a pipe this test reads
    rmSync(mark);
    expect(await Bun.spawn(["mkfifo", mark]).exited).toBe(0);
    const told = new Promise<string>((resolve) => { let said = ""; createReadStream(mark).on("data", (chunk) => { said += chunk; }).on("close", () => resolve(said)); });
    const pid = await shell(restoreServer(saved), { HOME: home, XDG_STATE_HOME: join(dir, "state") });
    cleanups.push(() => { try { process.kill(Number(pid)); } catch { /* gone already */ } });
    const [toldPid, token, where] = (await told).split("|");
    expect(toldPid).toBe(pid);
    expect(token).toBe("tok'en with space");
    expect(where).toBe(realpathSync(work));
    // exactly its environment and arguments, nothing of the SSH session's; the copy holding its token is gone; its log
    // is this account's alone
    expect(readFileSync(join("/proc", pid, "environ"))).toEqual(before.environ);
    expect(readFileSync(join("/proc", pid, "cmdline"))).toEqual(before.cmdline);
    expect(existsSync(saved)).toBe(false);
    expect(statSync(join(dir, "state", "ovis", "restored-server.log")).mode & 0o077).toBe(0);
  });

  it("says no faithful copy can be made where its environment cannot be read, its program is deleted, or a byte would not survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // no such process, or another one at its pid: nothing is copied
    expect(await shell(captureServer(2 ** 22 + 1, "Sun Nov  8 08:00:00 2026 1000"), { TMPDIR: dir })).toBe("changed");
    const serve = async (command: string[]) => {
      const server = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
      cleanups.push(() => server.kill());
      await server.stdout.getReader().read();
      return server;
    };
    const up = 'console.log("up"); setInterval(() => {}, 1000);';
    // an environment value that is not UTF-8: JavaScript would change it
    const latin = await serve(["sh", "-c", `exec env OVIS_ODD="$(printf '\\377')" "${process.execPath}" -e '${up}'`]);
    expect(await shell(captureServer(latin.pid, "another process"), { TMPDIR: dir })).toBe("changed");
    expect(await shell(captureServer(latin.pid, await shell(processIdentity(latin.pid), {})), { TMPDIR: dir })).toBe("unfaithful");
    // its program deleted since it started (an upgrade replaced it)
    const program = join(dir, "bun-copy");
    try { linkSync(process.execPath, program); } catch { return; }
    const orphan = await serve([program, "-e", up]);
    rmSync(program);
    expect(await shell(captureServer(orphan.pid, await shell(processIdentity(orphan.pid), {})), { TMPDIR: dir })).toBe("unfaithful");
    // its folder deleted since it started
    const gone = join(dir, "gone");
    mkdirSync(gone);
    const homeless = Bun.spawn([process.execPath, "-e", up], { cwd: gone, stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => homeless.kill());
    await homeless.stdout.getReader().read();
    rmSync(gone, { recursive: true });
    expect(await shell(captureServer(homeless.pid, await shell(processIdentity(homeless.pid), {})), { TMPDIR: dir })).toBe("unfaithful");
    // and no copy is left behind by any of them
    expect(readdirSync(dir).filter((name) => name.startsWith("ovis-restore."))).toEqual([]);
  });

  it("starts nothing when its address is taken by a live server, and keeps its log this account's alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, "home"), state = join(dir, "state"), mark = join(dir, "mark");
    mkdirSync(home);
    const port = await freePort();
    const copy = async () => {
      const server = Bun.spawn([process.execPath, "-e", 'require("node:fs").appendFileSync(process.env.MARK, "x"); console.log("up"); setInterval(() => {}, 1000);'], { cwd: dir, env: { PATH: process.env.PATH!, HOME: home, MARK: mark, PORT: String(port) }, stdout: "pipe", stderr: "ignore" });
      cleanups.push(() => server.kill());
      await server.stdout.getReader().read();
      const saved = await shell(captureServer(server.pid, await shell(processIdentity(server.pid), {})), { HOME: home, TMPDIR: dir });
      server.kill(); await server.exited;
      return saved;
    };
    // its replacement already listens on its address: nothing is started, and the copy goes
    const taken = await copy();
    const replacement = listenOn(() => {});
    await new Promise<void>((resolve) => replacement.listen(port, "127.0.0.1", () => resolve()));
    try { expect(await shell(restoreServer(taken), { HOME: home, XDG_STATE_HOME: state })).toBe("taken"); }
    finally { replacement.close(); }
    expect(existsSync(taken)).toBe(false);
    expect(readFileSync(mark, "utf8")).toBe("x");
    // a log anybody could read is made this account's alone; a link in its place is never followed
    mkdirSync(join(state, "ovis"), { recursive: true });
    writeFileSync(join(state, "ovis", "restored-server.log"), "", { mode: 0o644 });
    const pid = await shell(restoreServer(await copy()), { HOME: home, XDG_STATE_HOME: state });
    cleanups.push(() => { try { process.kill(Number(pid)); } catch { /* gone already */ } });
    expect(statSync(join(state, "ovis", "restored-server.log")).mode & 0o777).toBe(0o600);
    process.kill(Number(pid));
    rmSync(join(state, "ovis", "restored-server.log"));
    symlinkSync(join(dir, "elsewhere"), join(state, "ovis", "restored-server.log"));
    const linked = Bun.spawn(["sh", "-c", restoreServer(await copy())], { env: { PATH: process.env.PATH!, HOME: home, XDG_STATE_HOME: state }, stdout: "pipe", stderr: "ignore" });
    expect(await linked.exited).not.toBe(0);
    expect(existsSync(join(dir, "elsewhere"))).toBe(false);
  });

  it("tells a process by its start in clock ticks and its owner, and leaves no copy when nobody reads its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const stat = readFileSync(join("/proc", String(server.pid), "stat"), "utf8");
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    const identity = await shell(processIdentity(server.pid), {});
    expect(identity).toBe(`${ticks} ${process.getuid!()}`);
    // the SSH connection gone before the copy's path was told: the copy removes itself
    const lost = Bun.spawn(["sh", "-c", 'sh -c "$1" | true', "ssh", captureServer(server.pid, identity)], { env: { PATH: process.env.PATH!, TMPDIR: dir }, stdout: "ignore", stderr: "ignore" });
    await lost.exited;
    expect(readdirSync(dir).filter((name) => name.startsWith("ovis-restore."))).toEqual([]);
  });

  it("fails the restore, never says taken, when its address cannot be used at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // an address this PC does not have (TEST-NET-1)
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, HOST: "192.0.2.1", PORT: String(await freePort()) }, stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const saved = await shell(captureServer(server.pid, await shell(processIdentity(server.pid), {})), { HOME: dir, TMPDIR: dir });
    server.kill(); await server.exited;
    const run = Bun.spawn(["sh", "-c", restoreServer(saved)], { env: { PATH: process.env.PATH!, HOME: dir, XDG_STATE_HOME: join(dir, "state") }, stdout: "pipe", stderr: "pipe" });
    const [said, why, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect([said.trim(), code]).toEqual(["", 1]);
    expect(why).toContain("cannot be used");
    expect(existsSync(saved)).toBe(false);
  });

  it("tells a process's birth as server/process-owner.ts records it, and another birth from it", async () => {
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const reading = readProcessBirth(server.pid);
    if (reading.state !== "identified") throw new Error("no birth here");
    expect(await shell(`${bornAs(server.pid, reading.birth)} && echo born || true`, {})).toBe("born");
    expect(await shell(`${bornAs(server.pid, { ...reading.birth, value: reading.birth.value + "0" })} && echo born || true`, {})).toBe("");
  });

  it("tells a process that started before its birth-less registration was written from one that started after it", async () => {
    const home = mkdtempSync(join(tmpdir(), "ovis-registry-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const bridges = join(home, ".config", "herdr-web-ui", "bridges");
    mkdirSync(bridges, { recursive: true });
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const token = "c".repeat(64), file = join(bridges, "own.json");
    const check = () => shell(`${startedBeforeRegistration(server.pid, token)} && echo before || true`, { HOME: home });
    // written after it started, as a server writes its own registration
    writeFileSync(file, JSON.stringify({ pid: server.pid, token }));
    expect(await check()).toBe("before");
    // a registration written well before it started: this process took the pid of a server that ended
    const past = new Date(Date.now() - 600_000);
    utimesSync(file, past, past);
    expect(await check()).toBe("");
    // and none at all holds its token
    rmSync(file);
    expect(await check()).toBe("");
  });
});
