/**
 * The one helper for a test's own herdr-core: its environment (isolatedHcEnv), a fresh folder for it
 * (coreFolder), a core started and stopped there (IsolatedCore), or the stop of cores a test started
 * itself (corePids, stopTestCores). Every hc command here first refuses an environment that is not
 * isolated (isolationProblem), the user's own core above all. A pid is killed only once it is proven
 * to still be the core or holder recorded for the test's own core (provenCore), so neither another
 * run's core under the same TMPDIR nor a process that got a recorded pid's number is ever touched;
 * a test's own command is signalled as a group only while it is not reaped (signalChildGroup).
 *
 * hc is always run by the path the test gave: the installed `hc` may be a guard script that finds
 * the real program beside itself, which still works under a scratch HOME.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { coreSocket, userCore } from "../server/herdr-core/core-socket.ts";

/** the longest unix socket path the OS takes (sun_path less its terminating NUL) */
const SOCKET_PATH_MAX = 107;
/** how long an hc command or a stopped core's processes may take to end */
const STOP_WAIT_MS = 10_000;

/**
 * A herdr-core of a test's own: its session, state, config and runtime folders under `root`, and the
 * environment hc runs in holds nothing of this process's (no inherited HC_*, HOME or XDG_*), so no
 * hc call of the test can reach the user's own core.
 */
export function isolatedHcEnv(root: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: `${root}/home`,
    // short names: hc's socket path under a long TMPDIR must stay within the OS's limit (107 bytes)
    HC_SESSION: `t${process.pid}`,
    XDG_STATE_HOME: `${root}/state`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_RUNTIME_DIR: `${root}/run`,
    HC_SOCKET: `${root}/run/hc.sock`,
    ...extra,
  };
}

/**
 * Why hc in `env` could reach a core that is not the test's own, or null when it cannot: it names
 * no HC_SOCKET or HC_SESSION of its own, the session is `default`, or its socket is the one the
 * user's own core listens on (userCore). With `root` (the folder the caller made for this core),
 * the socket, HOME and XDG folders must also lie under it, and the socket path within the OS's limit.
 */
export function isolationProblem(env: Record<string, string | undefined>, root?: string): string | null {
  const socket = env["HC_SOCKET"];
  // resolved first: `${root}/../elsewhere` names the root but lies outside it
  const inside = (name: string) => {
    const path = env[name];
    if (root === undefined || path === undefined) return false;
    const rel = relative(resolve(root), resolve(path));
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!socket || !env["HC_SESSION"]) return "it names no HC_SOCKET and HC_SESSION of its own (isolatedHcEnv sets both)";
  if (env["HC_SESSION"] === "default") return "its HC_SESSION is default";
  if (userCore(env)) return `${socket} is the user's own core`;
  if (root === undefined) return null;
  if (!inside("HC_SOCKET")) return `HC_SOCKET ${socket} is outside ${root}`;
  if (!["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"].every(inside)) return `HOME or an XDG folder is outside ${root}`;
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) return `the socket path ${socket} is longer than ${SOCKET_PATH_MAX} bytes: use a shorter TMPDIR`;
  return null;
}

function refuseUnlessIsolated(env: Record<string, string>, root?: string): void {
  const problem = isolationProblem(env, root);
  if (problem) throw new Error(`not an isolated core, so no hc command runs there: ${problem}`);
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The fields of /proc/<pid>/stat from the third (state) on, or null when the process is gone or there is no /proc. */
function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    // the second field, the name in parentheses, may hold spaces and parentheses itself
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** when `pid` started (field 22 of /proc/<pid>/stat, clock ticks after boot), or null */
const startTime = (pid: number): string | null => statFields(pid)?.[19] ?? null;

/** the process group `pid` is in (field 5 of /proc/<pid>/stat), or null */
function processGroup(pid: number): number | null {
  const group = statFields(pid)?.[2];
  return group === undefined ? null : Number(group);
}

/**
 * Every pid a status read of this helper named, with its start time read right then: a later process
 * that gets the same number has another start time. Where there is no /proc nothing is recorded.
 */
const recordedStarts = new Map<number, string>();

/**
 * Test seam, for scripts/test-hc.test.ts alone: records `pid` with a start time no process has, as a
 * pid whose number came back after its process ended would carry. It can only make a pid unprovable.
 */
export function recordStaleStartForTest(pid: number): void {
  recordedStarts.set(pid, "stale");
}

function record(pids: number[]): number[] {
  for (const pid of pids) {
    const start = startTime(pid);
    if (start !== null) recordedStarts.set(pid, start);
  }
  return pids;
}

/**
 * Whether `pid` is still the process a status of the core at `socket` named: it lives, its start time
 * is the one recorded with it, and the environment it was started in (which a core and its holders
 * keep) names that core's own socket: by HC_SOCKET, or without one through HC_SESSION and
 * XDG_RUNTIME_DIR, as hc works it out (coreSocket). Without /proc nothing is proven.
 */
function provenCore(pid: number, socket: string): boolean {
  const recorded = recordedStarts.get(pid);
  if (recorded === undefined || startTime(pid) !== recorded) return false;
  let environ: string;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, "latin1");
  } catch {
    return false;
  }
  // terminal-env.ts's envBlock parses the same way, but it is private there, and its exported processEnv is async: an
  // await between this proof and the kill would widen the gap a reused pid could slip into
  const env = Object.fromEntries(environ.split("\0").filter((entry) => entry.includes("=")).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  return coreSocket({ env }).path === socket;
}

/**
 * Sends `signal` to the process group of a child the test started as the leader of a group of its own
 * (Bun.spawn's `detached: true` runs it through setsid(), so its group's id is its pid), only while
 * this process has not reaped it: once reaped, its number, and with it the group's, may be someone
 * else's. Never for a pid that is missing, 0 or 1, this process's own group, or not a group leader;
 * where there is no /proc, never. Answers whether the signal was sent.
 */
export function signalChildGroup(child: { pid: number; exitCode: number | null; signalCode: string | null }, signal: NodeJS.Signals | 0): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const own = processGroup(process.pid);
  if (own === null || pid === own || processGroup(pid) !== pid) return false;
  try {
    process.kill(-pid, signal);
  } catch {
    // the whole group ended meanwhile
  }
  return true;
}

/** A test's own core: the environment it was started in, and the pids of its core and holder known so far. */
export interface TestCore {
  env: Record<string, string>;
  pids: number[];
}

/** What stopTestCores did, per core in the order given, and what it found left. */
export interface StopResult {
  /** `hc server stop`'s exit code, or null when no core was there to stop (no recorded pid alive, no socket) */
  stopped: (number | null)[];
  /** pids alive after the stop and the wait, proven to be the core's (provenCore), then killed: a test asserts this is empty, so a leak fails it */
  killed: number[];
  /** pids alive after the stop and the wait that could not be proven to be the core's, so not killed: a leak as well */
  unproven: number[];
  /** sockets still there at the end */
  socketsLeft: string[];
}

/**
 * The pids of the core `env` names and of its holders, as `hc server status --json` there answers,
 * each recorded with its start time. Right after a start the holder is still null: read them again
 * later. Ask only a core known to run, since status starts one when none does.
 */
export async function corePids(bin: string, env: Record<string, string>): Promise<number[]> {
  refuseUnlessIsolated(env);
  const result = await hcCommand(bin, ["server", "status", "--json"], env);
  if (result.exit !== 0) throw new Error(`hc server status exited ${result.exit}: ${result.err.trim()}`);
  return record(statusPids(result.out));
}

/** One deadline covers the owned child and both streams, even after an inheritor keeps a pipe open. */
async function hcCommand(bin: string, args: string[], env: Record<string, string>): Promise<{ exit: number; out: string; err: string }> {
  const child = Bun.spawn([bin, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const abort = new AbortController();
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    try {
      await stream.pipeTo(new WritableStream<Uint8Array>({
        write(chunk) { text += decoder.decode(chunk, { stream: true }); },
      }), { signal: abort.signal });
    } catch (error) {
      if (!abort.signal.aborted || error !== abort.signal.reason) throw error;
    }
    return text + decoder.decode();
  };
  const reads = [read(child.stdout), read(child.stderr)] as const;
  const stop = () => {
    abort.abort(new Error("hc command deadline or cleanup"));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const deadline = setTimeout(stop, STOP_WAIT_MS);
  try {
    const [out, err, exit] = await Promise.all([...reads, child.exited]);
    return { out, err, exit: abort.signal.aborted ? 124 : exit };
  } finally {
    clearTimeout(deadline);
    stop();
    await Promise.allSettled(reads);
    await child.exited;
  }
}

/** the core's and its holders' pids in what `hc server status --json` printed */
function statusPids(out: string): number[] {
  const status = JSON.parse(out) as { pid: number; holder?: { pid: number } | null; holders?: { pid: number }[] };
  return [...new Set([status.pid, ...(status.holder ? [status.holder.pid] : []), ...(status.holders ?? []).map((holder) => holder.pid)])];
}

/** a core that runs for sure: every pid recorded for it alive and its socket there (status anywhere else could start one) */
const surelyRuns = (core: TestCore) => core.pids.length > 0 && core.pids.every(pidAlive) && existsSync(core.env["HC_SOCKET"]!);

/** until `done()` holds or `waitMs` passed: hc's core and holder are daemons, whose exit no event announces */
async function settle(done: () => boolean, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!done() && Date.now() < deadline) await Bun.sleep(25);
}

/**
 * Stops a test's own cores in the order given, each in its own environment: a core that dials
 * another goes first, as while it runs it starts that one again. Before each stop the core's holder
 * is read again while the core surely runs (an orphaned holder starts a new core about 3 s later);
 * `hc server stop` runs only when a recorded pid lives or the socket is there; then the pids and the
 * socket are waited for, because hc's stop returns while they live and a detached daemon's exit has
 * no event. Whatever of a core outlives `waitMs` is killed by its recorded pid, and gone, before the
 * next core is stopped, so it cannot start that one again; it is named in `killed`, but only once
 * provenCore shows the pid is still that core's. Any other pid alive is named in `unproven` and left
 * alone (a pid that no status of this helper named is never proven: record pids with corePids).
 * Delete a core's folder only after this: a late hc child would otherwise run whatever hc PATH finds.
 * Throws before any hc command when an environment is not isolated.
 */
export async function stopTestCores(bin: string, cores: TestCore[], waitMs = STOP_WAIT_MS): Promise<StopResult> {
  for (const core of cores) refuseUnlessIsolated(core.env);
  const stopped: (number | null)[] = [];
  const killed: number[] = [];
  const unproven: number[] = [];
  for (const core of cores) {
    const socket = core.env["HC_SOCKET"]!;
    // a status that fails keeps the pids recorded so far
    if (surelyRuns(core)) core.pids = [...new Set([...core.pids, ...(await corePids(bin, core.env).catch(() => []))])];
    if (!core.pids.some(pidAlive) && !existsSync(socket)) {
      stopped.push(null);
      continue;
    }
    stopped.push(await Bun.spawn([bin, "server", "stop"], { env: core.env, stdout: "ignore", stderr: "ignore", timeout: STOP_WAIT_MS, killSignal: "SIGKILL" }).exited);
    await settle(() => !core.pids.some(pidAlive) && !existsSync(socket), waitMs);
    // what of this core outlived the wait goes before the next core is stopped: while it ran, it could dial that one and start it again
    const ended: number[] = [];
    for (const pid of core.pids.filter(pidAlive)) {
      if (!provenCore(pid, socket)) {
        unproven.push(pid);
        continue;
      }
      ended.push(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // it ended right after the proof: a leak all the same, as it outlived the wait
      }
    }
    killed.push(...ended);
    await settle(() => !ended.some(pidAlive), waitMs);
  }
  return { stopped, killed, unproven, socketsLeft: cores.map((core) => core.env["HC_SOCKET"]!).filter((socket) => existsSync(socket)) };
}

/** What an IsolatedCore's stop found: whether anything had to be killed, and what is left. */
export interface StopReport {
  /** every core and holder pid recorded for this core */
  pids: number[];
  /** pids still alive after `hc server stop` and the wait, proven to be this core's, then killed */
  killed: number[];
  /** pids still alive after the wait that could not be proven to be this core's, so not killed */
  unproven: number[];
  /** pids alive even after the kill */
  alive: number[];
  socketGone: boolean;
  rootGone: boolean;
}

/** A clean stop: nothing killed, nothing unproven, nothing left. */
export const stoppedCleanly = (report: StopReport): boolean =>
  report.killed.length === 0 && report.unproven.length === 0 && report.alive.length === 0 && report.socketGone && report.rootGone;

/**
 * A fresh folder for one core, directly under `base` (TMPDIR, or the system's temp folder), and the
 * environment hc runs in there. Throws before anything runs when the environment is not isolated.
 */
export function coreFolder(base = process.env["TMPDIR"] || tmpdir()): { root: string; env: Record<string, string> } {
  const root = mkdtempSync(join(base, "ovis-hc-"));
  for (const sub of ["home", "state", "config", "run"]) mkdirSync(join(root, sub), { mode: 0o700 });
  const env = isolatedHcEnv(root);
  const problem = isolationProblem(env, root);
  if (problem) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`not an isolated core: ${problem}`);
  }
  return { root, env };
}

/**
 * A real herdr-core of a test's own in a folder of its own (coreFolder): started, its core and
 * holder pids recorded, and stopped once through stopTestCores so that a leak is reported, never hidden.
 */
export class IsolatedCore implements TestCore {
  readonly bin: string;
  readonly root: string;
  readonly env: Record<string, string>;
  /** the core's and every holder's pid, as `hc server status` named them */
  pids: number[] = [];
  /** `hc server start` succeeded: from then on a core runs here until the stop */
  private started = false;
  /** the start in flight, which a stop awaits before it judges whether a core runs */
  private starting: Promise<unknown> = Promise.resolve();
  /** hc commands still running: the stop waits for them, so none can start a core after it */
  private readonly running = new Set<Promise<unknown>>();
  private stopping: Promise<StopReport> | null = null;

  constructor(bin: string, folder = coreFolder()) {
    refuseUnlessIsolated(folder.env, folder.root);
    this.bin = resolve(bin);
    this.root = folder.root;
    this.env = folder.env;
  }

  get socket(): string {
    return this.env["HC_SOCKET"]!;
  }

  /** `hc server start`, then the pids it reports. Refused once the stop began. */
  async start(): Promise<void> {
    const starting = this.hc(["server", "start"]).then((started) => {
      if (started.exit === 0) this.started = true;
      return started;
    });
    this.starting = starting.catch(() => {});
    const started = await starting;
    if (started.exit !== 0) throw new Error(`hc server start exited ${started.exit}: ${started.err.trim()}`);
    await this.readPids();
  }

  /** A core something else started in this folder (its socket is there): its pids are read, so `stop` stops it. */
  async adopt(): Promise<void> {
    this.started = existsSync(this.socket);
    await this.readPids();
  }

  /**
   * Adds the pids `hc server status` names now. Asked only while this core is known to run (started,
   * and none of its recorded pids gone): in an environment with no core, `status` starts one.
   */
  async readPids(fromStop = false): Promise<void> {
    if (!this.started || !existsSync(this.socket) || (this.pids.length > 0 && !this.pids.every(pidAlive))) return;
    const status = await this.hc(["server", "status", "--json"], fromStop);
    if (status.exit !== 0) return;
    this.pids = [...new Set([...this.pids, ...record(statusPids(status.out))])];
  }

  /**
   * Stops the core, once: every caller (a signal, a time limit, the normal end) awaits the same
   * stop. A start in flight and every hc command still running are awaited first; the pids are read
   * when a started core has none recorded yet; then stopTestCores. The folder goes only once no pid is left.
   */
  stop(): Promise<StopReport> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<StopReport> {
    await this.starting;
    await Promise.allSettled([...this.running]);
    // a stop that came before the start's own status: stopTestCores reads again only a core with pids
    if (this.pids.length === 0) await this.readPids(true).catch(() => {});
    const { killed, unproven, socketsLeft } = await stopTestCores(this.bin, [this]);
    const alive = this.pids.filter(pidAlive);
    // a late hc child in a deleted folder would run whatever hc is first on PATH: the folder outlives every pid.
    // With no pid recorded, nothing proves the core ended while its socket is left: the folder stays then too, so
    // the report cannot read as stopped (with pids, all gone, the socket is only what a killed core left behind)
    const unprovenEnd = socketsLeft.length > 0 && this.pids.length === 0;
    if (alive.length === 0 && !unprovenEnd) rmSync(this.root, { recursive: true, force: true });
    return { pids: this.pids, killed, unproven, alive, socketGone: !existsSync(this.socket), rootGone: !existsSync(this.root) };
  }

  /** an hc command in this core's environment alone */
  hc(args: string[], fromStop = false): Promise<{ exit: number; out: string; err: string }> {
    if (this.stopping && !fromStop) return Promise.reject(new Error(`no hc ${args.join(" ")} once the core is being stopped`));
    refuseUnlessIsolated(this.env, this.root);
    const done = hcCommand(this.bin, args, this.env);
    this.running.add(done);
    void done.finally(() => this.running.delete(done)).catch(() => {});
    return done;
  }
}
