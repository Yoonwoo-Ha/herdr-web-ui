import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PcInstallFailure, PcInstallJob, SshTarget } from "../shared/machines.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { posixHost, REMOTE_PATH } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { sshAddress } from "./ssh-address.ts";

/**
 * Ovis installed or put right on another PC over SSH, from the PC in use (docs/remote-pcs.md): the official
 * installer pinned to this app's release, the same one the docs give, on a PC without Ovis or in place of a server
 * started by hand; or a restart through its own launcher where its supervisor is too old to install by revision.
 * SSH uses keys only (BatchMode): nothing asks for a password. herdr, its sessions and the user's settings files are
 * never touched; only the server named in the plan is stopped.
 */

/** the official installer, as the README and docs/guide.md give it */
export const INSTALLER = "https://ovis.sh/install.sh";
/** the installer of one release, from its own tag: the same script as INSTALLER, at the release it installs, never a newer copy */
export const installerAt = (release: string): string => `https://raw.githubusercontent.com/devswha/ovis/${release}/install.sh`;
/** what an install needs in the home folder: Bun, herdr and a built checkout */
const MIN_FREE_KB = 1024 * 1024;
/** the installer clones and builds Ovis (about a minute), and may install herdr and Bun first */
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const STOP_WAIT_MS = 15_000;

/** the same PC over SSH as ssh resolves it (an alias, or the default port given, is the same one), whatever herdr session each names */
export const samePc = (a: SshTarget, b: SshTarget): boolean => sshAddress(a) === sshAddress(b);
/**
 * The official installer's run on that PC, for one SSH command. Downloaded first, so a failed download is told as one
 * (piped, sh would run an empty script and exit 0), then run with nothing on stdin, on herdr (a herdr plugin that updates
 * itself, as the steps shown say). The exit status is printed rather than returned, so the installer's own last words come
 * back either way.
 *
 * A command run over SSH without a terminal keeps running once the connection ends, as a cancel ends it: so a watcher,
 * started before the download, writes an empty line to the connection every two seconds, and once it cannot (nobody reads there
 * any more) stops the command's whole process group, the download or the installer with it; the command then ends
 * without starting anything more. Right before the installer starts, the command itself writes to the connection too,
 * so one closed since the watcher last wrote starts no installer. It is stopped itself when the installer ends. Empty lines are no
 * output to the reader.
 */
export const installerRun = (release: string, from = installerAt(release)): string =>
  `${REMOTE_PATH}script=$(mktemp) || exit 1; trap 'rm -f "$script"' EXIT; trap 'exit 143' HUP INT TERM; `
  + `( trap '' PIPE; while printf '\\n' 2>/dev/null; do sleep 2 >/dev/null 2>&1; done; kill -TERM 0 ) </dev/null 2>/dev/null & watch=$!; `
  + `if ! curl -fsSL --max-time 120 ${from} -o "$script" || ! head -n 1 "$script" | grep -q '^#!/bin/sh'; then kill "$watch" 2>/dev/null; echo "Ovis: could not download the installer of ${release} from github.com"; printf '\\novis-install-exit=1\\n'; exit 0; fi; `
  // a connection closed since the watcher last wrote ends the command here (SIGPIPE, or the write's error), not the installer
  + `printf '\\n' || exit 141; `
  + `OVIS_REF=${release} OVIS_RUNTIME=herdr OVIS_NO_OPEN=1 sh "$script" </dev/null 2>&1; status=$?; `
  + `kill "$watch" 2>/dev/null; printf '\\novis-install-exit=%s\\n' "$status"`;
/** connects the PC once Ovis answers there (MachineManager.setup, keys only): resolves null once connected, else why not */
export type InstallConnect = (request: { target: SshTarget; name?: string; machine_id?: string; update: boolean; revision?: string; onJob?(job_id: string): void }) => { job_id: string; finished: Promise<string | null>; cancel(): void };
/** what to put right on a PC added here whose own Ovis cannot update itself, and the process that runs it now */
/** `token`: the shown server's descriptor token, so a server that took its pid since is never the one stopped */
export interface InstallPlan { mode: "replace" | "restart"; pid: number; token?: string }
/**
 * The install a PC whose own Ovis refused to update can be offered (Machine.ovis_update how "install"): only on Linux
 * and macOS, where the official installer and this installer's checks run. A Windows PC keeps its plain refusal.
 */
export function installPlanFor(fix: InstallPlan["mode"] | undefined, host: "posix" | "windows", pid: number, target: SshTarget, token?: string): (InstallPlan & { target: SshTarget }) | undefined {
  return fix && host === "posix" ? { mode: fix, pid, ...(token ? { token } : {}), target: { ...target } } : undefined;
}

let release: string | undefined;
/** this app's own release (`v0.5.1`): what the installer installs, so both ends speak one bundle version */
export function appRelease(): string {
  return release ??= `v${(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version}`;
}

class InstallFailed extends Error { constructor(readonly code: PcInstallFailure, message: string) { super(message); } }

/** what one look at the PC finds (PROBE) */
interface Facts { os: string; arch: string; tools: Set<string>; writable: boolean; freeKb: number | null; herdrRunning: boolean; launcher: Launcher }
/**
 * How an installed Ovis starts itself there: the herdr plugin (under its id, or the one before the rename), or the
 * user service the installer registers for Ovis on herdr-core; none when it was never installed.
 */
type Launcher = "plugin" | "plugin-legacy" | "systemd" | "launchd" | "none";
const PROBE = REMOTE_PATH + [
  `printf 'os=%s\\narch=%s\\n' "$(uname -s)" "$(uname -m)"`,
  `for tool in curl git tar; do command -v "$tool" >/dev/null 2>&1 && printf 'has=%s\\n' "$tool"; done`,
  `test -w "$HOME" && printf 'writable=1\\n'`,
  `printf 'free_kb=%s\\n' "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 { print $4 }')"`,
  `command -v herdr >/dev/null 2>&1 && printf 'herdr=1\\n'`,
  `herdr status server --json 2>/dev/null </dev/null | grep -q '"running":true' && printf 'herdr_running=1\\n'`,
  `plugins=$(herdr plugin list 2>/dev/null </dev/null); if printf '%s\\n' "$plugins" | grep -q 'devswha.ovis '; then echo launcher=plugin; elif printf '%s\\n' "$plugins" | grep -q 'devswha.herdr-web-ui '; then echo launcher=plugin-legacy; elif systemctl --user cat ovis.service >/dev/null 2>&1; then echo launcher=systemd; elif test -f "$HOME/Library/LaunchAgents/sh.ovis.server.plist"; then echo launcher=launchd; else echo launcher=none; fi`,
  "true",
].join("; ");
function parseProbe(out: string): Facts {
  const lines = out.split("\n");
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? "";
  const free = Number(value("free_kb"));
  return { os: value("os"), arch: value("arch"), tools: new Set(lines.filter((line) => line.startsWith("has=")).map((line) => line.slice(4).trim())),
    writable: lines.includes("writable=1"), freeKb: value("free_kb") !== "" && Number.isFinite(free) ? free : null, herdrRunning: lines.includes("herdr_running=1"),
    launcher: (["plugin", "plugin-legacy", "systemd", "launchd"] as const).find((name) => value("launcher") === name) ?? "none" };
}
/** Stops (restart) or starts an installed Ovis through its own launcher, which stops its supervisor and all with it. */
function viaLauncher(launcher: Exclude<Launcher, "none">, restart: boolean): string {
  const plugin = launcher === "plugin" ? "devswha.ovis" : "devswha.herdr-web-ui";
  if (launcher === "plugin" || launcher === "plugin-legacy") return `${REMOTE_PATH}${restart ? `herdr plugin action invoke ${plugin}.stop >/dev/null </dev/null; ` : ""}herdr plugin action invoke ${plugin}.start >/dev/null </dev/null`;
  if (launcher === "systemd") return `systemctl --user ${restart ? "restart" : "start"} ovis.service </dev/null`;
  return `launchctl kickstart ${restart ? "-k " : ""}"gui/$(id -u)/sh.ovis.server"`;
}
/** herdr started headless, in a session of its own so it outlives this SSH connection */
const HEADLESS_HERDR = `${REMOTE_PATH}if command -v setsid >/dev/null 2>&1; then setsid nohup herdr server </dev/null >/dev/null 2>&1 & else nohup herdr server </dev/null >/dev/null 2>&1 & fi`;
/** an Ovis server's own command line: Bun running its server, supervisor, launcher or plugin start */
const OVIS_COMMAND = /\bbun\b.*(server\/(index|managed|supervisor)\.ts|scripts\/plugin\.ts)/;

/** ssh's own refusal, in words for the person who asked */
function sshFailure(error: unknown): InstallFailed {
  const words = (error instanceof Error ? error.message : String(error)).trim().split("\n").filter(Boolean).at(-1) ?? "no answer";
  if (/Host key verification failed|IDENTIFICATION HAS CHANGED|host key .* not known/i.test(words)) {
    return new InstallFailed("ssh_host_key", "That PC's SSH host key is not known here yet, or it changed. Add the PC once with Add PC (SSH), which shows its fingerprint to check, then try again.");
  }
  if (/Permission denied|Too many authentication failures|password|passphrase/i.test(words)) {
    return new InstallFailed("ssh_refused", "That PC did not let this app in with SSH keys, and installing from here never asks for a password. Add this PC's key there (ssh-copy-id), or add the PC once with Add PC (SSH), which can register a key, then try again.");
  }
  return new InstallFailed("ssh_unreachable", `That PC could not be reached over SSH: ${words.slice(0, 300)}`);
}

interface State { public: PcInstallJob; abort: AbortController; ssh?: SshConnection; connect?: { cancel(): void }; finished: Promise<void>; settled?: boolean }

export class PcInstaller {
  private jobs = new Map<string, State>();
  private readonly pollMs: number;
  private readonly startMs: number;
  private readonly stopMs: number;
  constructor(private readonly options: { sshDir: string; connect: InstallConnect; release?: string; onChange?(job: PcInstallJob): void; pollMs?: number; startMs?: number; stopMs?: number }) {
    this.pollMs = options.pollMs ?? 1000;
    this.startMs = options.startMs ?? 180_000;
    this.stopMs = options.stopMs ?? STOP_WAIT_MS;
  }
  start(request: { target: SshTarget; name?: string; machine_id?: string; plan?: InstallPlan; revision?: string }): PcInstallJob {
    const id = randomUUID();
    const job: PcInstallJob = { id, machine_id: request.machine_id ?? null, target: request.target, mode: request.plan?.mode ?? "install", phase: "connecting",
      step: "Connecting with SSH keys…", error: null, error_code: null, connect_job: null };
    const state: State = { public: job, abort: new AbortController(), finished: Promise.resolve() };
    this.jobs.set(id, state);
    // ended jobs are kept for their dialog to read, at most the last 40
    // only a job whose run has ended: a cancelled one may still run there, and keeps its PC busy until then
    if (this.jobs.size > 40) for (const [key, other] of this.jobs) if (key !== id && other.settled) { this.jobs.delete(key); break; }
    state.finished = this.run(state, request);
    this.options.onChange?.(job);
    return job;
  }
  job(id: string): PcInstallJob | undefined { return this.jobs.get(id)?.public; }
  async finished(id: string): Promise<void> { await this.jobs.get(id)?.finished; }
  /** the install running for a PC added here, if any */
  runningFor(machineId: string): PcInstallJob | undefined {
    return [...this.jobs.values()].find((state) => state.public.machine_id === machineId && !state.settled)?.public;
  }
  /** the install running at an SSH address, if any: one at a time per PC */
  runningAt(target: SshTarget): PcInstallJob | undefined {
    // whatever herdr session is asked: the install restarts herdr's Ovis on that PC, for every session there
    return [...this.jobs.values()].find((state) => !state.settled && samePc(state.public.target, target))?.public;
  }
  /**
   * Ends the job here, and the connect it handed over to. Its SSH connection closes, which stops an installer already
   * running there within seconds (installerRun). The PC counts as busy (runningFor, runningAt) until this job's own run has ended, so no
   * other install or setup starts beside it. A server already stopped stays stopped, as the job then says.
   */
  cancel(id: string): void {
    const state = this.jobs.get(id);
    if (!state || ["connected", "failed", "cancelled"].includes(state.public.phase)) return;
    state.abort.abort();
    // told at once, as a setup job's cancel is: whatever the job was waiting on ends on its own
    state.public.phase = "cancelled"; state.public.step = "Cancelled";
    state.ssh?.close();
    state.connect?.cancel();
    this.options.onChange?.(state.public);
  }
  stop(): void { for (const id of this.jobs.keys()) this.cancel(id); }

  private async run(state: State, request: { target: SshTarget; name?: string; machine_id?: string; plan?: InstallPlan; revision?: string }): Promise<void> {
    const { public: job, abort } = state;
    const { target, plan } = request;
    const release = this.options.release ?? appRelease();
    const step = (phase: PcInstallJob["phase"], words: string) => {
      if (abort.signal.aborted) throw new Error("Install cancelled");
      job.phase = phase; job.step = words;
      this.options.onChange?.(job);
    };
    const pause = () => new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, this.pollMs);
      abort.signal.addEventListener("abort", done, { once: true });
    });
    // the server started by hand there was stopped by this try: a later failure says so, as nothing runs there now
    let stopped = false;
    // a start through herdr or the launcher that fails there is told in words, as every failure is
    const launch = async (command: string) => {
      try { await state.ssh!.run(command); } catch (error) {
        if (abort.signal.aborted) throw error;
        throw new InstallFailed("not_started", `Ovis could not be started on that PC: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      }
    };
    // whether an Ovis was installed or started in its place: "maybe" while that command still ran, when a cancel can come
    let replaced: "no" | "maybe" | "yes" = "no";
    try {
      // the installer sets Ovis up for herdr's default session; one for a named session is not this app's to guess
      if (target.session) throw new InstallFailed("unsupported", `Installing from here sets Ovis up for herdr's default session only, and this PC is added with the session "${target.session}". Add it without a session to install there.`);
      const ssh = new SshConnection(target, this.options.sshDir, request.machine_id ? join(this.options.sshDir, request.machine_id) : undefined);
      state.ssh = ssh;
      // no challenge: BatchMode, so a PC that wants a password or an unknown host key refuses instead of asking
      try { await ssh.start(); } catch (error) { if (abort.signal.aborted) throw error; throw sshFailure(error); }
      step("checking", "Checking that PC…");
      let facts: Facts;
      try { facts = parseProbe(await ssh.run(PROBE)); } catch (error) { if (abort.signal.aborted) throw error; throw sshFailure(error); }
      if (!["Linux", "Darwin"].includes(facts.os) || !["x86_64", "amd64", "aarch64", "arm64"].includes(facts.arch)) {
        throw new InstallFailed("unsupported", `Installing Ovis from here works on Linux and macOS PCs (x64 or arm64); that PC is ${facts.os ? `${facts.os} ${facts.arch}` : "not one (no POSIX shell answered)"}.`);
      }
      for (const tool of ["curl", "git", "tar"]) if (!facts.tools.has(tool)) throw new InstallFailed("missing_tool", `That PC has no ${tool}, which the installer needs. Install ${tool} there with its package manager, then try again.`);
      if (!facts.writable) throw new InstallFailed("permission", "This SSH account cannot write to its own home folder on that PC, where Ovis installs.");
      if (facts.freeKb !== null && facts.freeKb < MIN_FREE_KB) throw new InstallFailed("disk", `That PC has only ${Math.floor(facts.freeKb / 1024)} MB free in its home folder; installing Ovis needs about 1 GB.`);
      const inspection = await posixHost.inspect(ssh);
      const listed = inspection.descriptors.filter((d) => d.socket_path === inspection.expectedSocket);
      const live: BridgeDescriptor[] = [];
      for (const descriptor of listed) if (Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0 && await posixHost.alive(ssh, descriptor.pid)) live.push(descriptor);
      // a new Ovis registers anew, with a token of its own: a pid alone could be an old one's, reused
      const before = new Set(listed.map((d) => d.token));
      // an Ovis already installed there (a plugin, or its service) is started through that, and updated once it answers:
      // the installer would keep it as it is and only start it, whatever release it was asked for
      const installed = facts.launcher !== "none";
      // the planned server already gone (see below): nothing of it is waited for after the launcher's start
      let gone = false;
      if (!plan) {
        if (live.some((d) => d.managed_remote)) throw new InstallFailed("bridge_there", "That PC runs this app's bridge for herdr; update it from its card with Update instead.");
        if (live.length) throw new InstallFailed("ovis_there", "Ovis already runs on that PC. Add it with Add PC, or update it from its card.");
      } else {
        // only the very process the plan was made for, only a server this app did not start, and only while that pid
        // still runs an Ovis server: a pid reused by another program since is never signalled
        const shown = live.find((d) => d.pid === plan.pid && !d.managed_remote && (plan.token === undefined || d.token === plan.token));
        // gone already (an earlier try stopped it, or the launcher stopped it and failed to start one), with no other Ovis
        // running there: nothing is left to stop, and the install or the launcher's start is tried again
        gone = !shown && live.length === 0;
        const command = shown ? await ssh.run(`ps -o args= -p ${plan.pid} 2>/dev/null || true`) : "";
        if (!gone && (!shown || !OVIS_COMMAND.test(command))) throw new InstallFailed("changed", "That PC's Ovis changed since it was looked at, so nothing was stopped. Reconnect it and try again.");
        if (gone && plan.mode === "replace") stopped = true;
        // a restart goes through the launcher that runs it, which must be there before anything is stopped
        if (plan.mode === "restart" && !installed) throw new InstallFailed("no_launcher", "That PC's Ovis was not installed as a herdr plugin or a user service, so it cannot be restarted from here. Restart it on that PC (Settings → Updates there tells how), then update it.");
        if (plan.mode === "replace" && !gone) {
          step("stopping", `Stopping that PC's Ovis (process ${plan.pid}); herdr and its sessions keep running…`);
          await ssh.run(`kill -TERM ${plan.pid}`);
          for (const until = Date.now() + this.stopMs; await posixHost.alive(ssh, plan.pid);) {
            if (Date.now() >= until) throw new InstallFailed("not_stopped", `That PC's Ovis (process ${plan.pid}) did not stop within ${Math.round(this.stopMs / 1000)} seconds, so nothing was installed.`);
            await pause();
            if (abort.signal.aborted) throw new Error("Install cancelled");
          }
          stopped = true;
        }
      }
      // updated once it answers: a restarted supervisor, or an install there that was kept as it was
      let update = job.mode === "restart";
      if (facts.launcher !== "none") {
        step("starting", job.mode === "restart" ? "Restarting that PC's Ovis through its own launcher…" : "Starting the Ovis already installed on that PC…");
        // a plugin's actions need a herdr server: without one, herdr is started headless and starts the plugin itself
        const plugin = facts.launcher === "plugin" || facts.launcher === "plugin-legacy";
        if (plugin && !facts.herdrRunning) await launch(HEADLESS_HERDR);
        else { if (stopped) replaced = "maybe"; await launch(viaLauncher(facts.launcher, job.mode === "restart")); }
        if (stopped) replaced = "yes";
        // the launcher restarts what it runs: a planned process it did not run (started by hand beside it) is still
        // there, and a second Ovis would serve the same socket, so nothing is connected
        // a planned server already gone is not waited for: its pid may run something else by now (after a reboot)
        if (plan?.mode === "restart" && !gone) {
          for (const until = Date.now() + this.stopMs; await posixHost.alive(ssh, plan.pid);) {
            if (Date.now() >= until) {
              // the launcher started an Ovis of its own beside the planned one: only that new one (a token not seen
              // before, an Ovis server's command line) is stopped again, so one Ovis serves the socket, as before
              for (const extra of (await posixHost.descriptors(ssh)).filter((d) => d.socket_path === inspection.expectedSocket && !d.managed_remote && !before.has(d.token) && Number.isSafeInteger(d.pid) && d.pid > 0 && d.pid !== plan.pid)) {
                if (OVIS_COMMAND.test(await ssh.run(`ps -o args= -p ${extra.pid} 2>/dev/null || true`))) await ssh.run(`kill -TERM ${extra.pid} 2>/dev/null || true`);
              }
              throw new InstallFailed("not_stopped", `That PC's Ovis (process ${plan.pid}) was not started by its launcher, so restarting the launcher did not restart it; the one the launcher started beside it was stopped again. Stop it on that PC, then update it.`);
            }
            await pause();
            if (abort.signal.aborted) throw new Error("Install cancelled");
          }
        }
        update = true;
      } else {
        step("installing", `Installing Ovis ${release} with its official installer (about a minute)…`);
        // downloaded first, so a failed download is told as one (piped, sh would run an empty script and exit 0), then
        // run with nothing on stdin, on herdr (a herdr plugin that updates itself, as the steps shown say). The exit
        // status is printed rather than returned, so the installer's own last words come back either way
        if (stopped) replaced = "maybe";
        // a dropped connection, or the run's time up, is told as one, with its code
        let out: string;
        try { out = await ssh.run(installerRun(release), undefined, INSTALL_TIMEOUT_MS); } catch (error) { if (abort.signal.aborted) throw error; throw sshFailure(error); }
        const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.at(-1) !== "ovis-install-exit=0") {
          // it ended, failed: nothing was started in its place
          replaced = "no";
          const said = lines.filter((line) => !line.startsWith("ovis-install-exit=")).slice(-3).join(" ").slice(0, 500);
          throw new InstallFailed("installer_failed", `The Ovis installer failed on that PC: ${said || "it said nothing"}`);
        }
        if (stopped) replaced = "yes";
        // the plugin starts with herdr: one not running is started headless, which runs the plugin's startup hook
        // (as scripts/fresh-install-docker.ts checks), in a session of its own so it outlives this SSH connection
        if (!facts.herdrRunning) await launch(HEADLESS_HERDR);
      }
      step("starting", "Waiting for Ovis to answer on that PC…");
      for (const until = Date.now() + this.startMs; ;) {
        const answering = (await posixHost.descriptors(ssh)).find((d) => d.socket_path === inspection.expectedSocket && !d.managed_remote && !before.has(d.token) && Number.isSafeInteger(d.pid) && d.pid > 0);
        if (answering && await posixHost.alive(ssh, answering.pid)) break;
        if (Date.now() >= until) throw new InstallFailed("not_started", `Ovis is ${job.mode === "restart" ? "restarted" : "installed"} on that PC but did not start within ${Math.round(this.startMs / 1000)} seconds. Check herdr's plugin log there (herdr plugin log list).`);
        await pause();
        if (abort.signal.aborted) throw new Error("Install cancelled");
      }
      ssh.close();
      step("connecting_pc", "Connecting to that PC's Ovis…");
      const connect = this.options.connect({ target, ...(request.name ? { name: request.name } : {}), ...(request.machine_id ? { machine_id: request.machine_id } : {}), ...(request.revision ? { revision: request.revision } : {}), update,
        // a follow-up connect (its update after the first one found it older) is the one to follow from now on
        onJob: (id) => { job.connect_job = id; this.options.onChange?.(job); } });
      state.connect = connect;
      job.connect_job = connect.job_id;
      this.options.onChange?.(job);
      const refused = await connect.finished;
      if (abort.signal.aborted) throw new Error("Install cancelled");
      if (refused) throw new InstallFailed("connect_failed", refused);
      job.phase = "connected"; job.step = "Connected";
    } catch (error) {
      if (abort.signal.aborted) {
        job.phase = "cancelled"; job.step = "Cancelled";
        if (stopped) job.error = replaced === "no"
          ? "Cancelled after the Ovis started by hand on that PC was stopped, so none runs there now; Update tries the install again."
          : `Cancelled after the Ovis started by hand on that PC was stopped and another was ${replaced === "yes" ? "installed" : "being installed"} in its place, which may not be running; Update tries again.`;
      }
      else {
        job.phase = "failed"; job.step = "Install failed";
        job.error_code = error instanceof InstallFailed ? error.code : null;
        job.error = (error instanceof Error ? error.message : String(error))
          + (!stopped ? "" : replaced === "yes"
            ? " The Ovis started by hand on that PC was stopped, and the one installed in its place did not connect; Update tries again."
            : replaced === "maybe"
            ? " The Ovis started by hand on that PC was stopped, and another may have been installed in its place; Update tries again."
            : " The Ovis started by hand on that PC was already stopped, so none runs there now; Update tries the install again.");
      }
    } finally {
      state.ssh?.close();
      state.settled = true;
      this.options.onChange?.(job);
    }
  }
}
