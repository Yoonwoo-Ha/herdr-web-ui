import { afterEach, describe, expect, it } from "bun:test";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type PcInstallFailure, type PcInstallJob } from "../shared/machines.ts";
import { installerRun, installPlanFor, PcInstaller, type InstallConnect } from "./pc-install.ts";
import { SshConnection } from "./ssh.ts";

// A PC reached over SSH, as a script-answering stand-in: every command this app would run there is answered here,
// and none reaches a real PC, the user's herdr or the network. An unexpected command fails the test.
const SOCKET = "/home/fx/.config/herdr/herdr.sock";
interface Descriptor { pid: number; port: number; token: string; socket_path: string; managed_remote: boolean; bridge_protocol: number; bundle_version: string }
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
  /** its launcher's start fails there, with these words */
  launcherFails?: string;
  /** the installer's SSH command ends without its answer, with these words (a dropped connection, its time up) */
  installerDrops?: string;
  /** the installer's command holds until this settles, and tells when it starts */
  installerHeld?: { started(): void; gate: Promise<void> };
  descriptors?: Descriptor[];
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(pc: Pc) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pc-install-"));
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close };
  cleanups.push(() => { Object.assign(SshConnection.prototype, real); rmSync(dir, { recursive: true, force: true }); });
  const listed: Descriptor[] = [...(pc.descriptors ?? [])];
  const alive = new Set(listed.map((d) => d.pid));
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
    if (script.startsWith("ps -o args=")) return pc.command ?? "/home/fx/.bun/bin/bun /home/fx/ovis/server/index.ts";
    if (script.includes("kill -0")) return alive.has(Number(/kill -0 (\d+)/.exec(script)![1])) ? "live" : "";
    if (script.includes("kill -TERM")) { alive.delete(Number(/kill -TERM (\d+)/.exec(script)![1])); return ""; }
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) return listed.map((d) => JSON.stringify(d)).join("\n") + "\n";
    if (script.includes(" server </dev/null")) { register(); return ""; }
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
  const installer = new PcInstaller({ sshDir: join(dir, "ssh"), connect, release: "v9.9.9", pollMs: 1, startMs: 200, stopMs: 100, onChange });
  cleanups.push(() => installer.stop());
  const settled = async (job: PcInstallJob) => { await installer.finished(job.id); return installer.job(job.id)!; };
  return { installer, commands, challenges, connects, settled, alive, failConnect: (words: string) => { answer = words; }, holdConnect: (gate: Promise<void>) => { held = gate; }, cancelled: () => cancelled, reached, followUps, installerAnswer: (answer: { exit: number; output: string }) => { pc.installer = answer; } };
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
    const pc = fixture({ descriptors: [descriptor(4242)], installer: { exit: 1, output: "Ovis: could not download Ovis v9.9.9 from github.com." } });
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
    const pc = fixture({ descriptors: [descriptor(4242)], installerHeld: { started: () => started.resolve(), gate: gate.promise } });
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
