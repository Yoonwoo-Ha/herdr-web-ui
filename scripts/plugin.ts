/**
 * herdr plugin lifecycle for the web UI.
 *
 * herdr's startup hooks are one-shot initialization commands, not supervised
 * daemons (https://herdr.dev/docs/plugins/), so this script owns the process:
 * `start` detaches the server and records its pid under HERDR_PLUGIN_STATE_DIR,
 * `stop` takes it down, `status` reports, `pair` prints a pairing code for another device, `phone`
 * publishes the app to the user's tailnet and prints its address as a QR code. Start is idempotent — a server that is
 * already answering on the port is left alone, which is what makes it safe as
 * both a startup hook and a hand-invoked action.
 *
 * The port is settled here, before the server is spawned: with no PORT set, a default that cannot
 * be opened gives way to the next one that can (scripts/plugin-port.ts), and that choice is kept
 * for later starts and for `status`, `pair` and `phone`.
 *
 * Two pieces of herdr's runtime environment have to be translated:
 * - herdr injects HERDR_SOCKET_PATH; the server reads HERDR_SOCKET. Without the
 *   mapping a named session's plugin would talk to the default socket.
 * - plugin commands inherit herdr's environment, not the user's shell, so the
 *   token and any overrides are read from `env` and `.env` in HERDR_PLUGIN_CONFIG_DIR.
 */

import { mergeEnvLayers } from "../server/legacy-env.ts";
import { acquireOwnerDirectory, guardPath, type OwnerLease } from "../server/owner-guard.ts";
import { parseBirth, readProcessBirth } from "../server/process-owner.ts";
import { writeStateDocument } from "../server/state-document.ts";
import { defaultStateDir } from "../server/update-state.ts";
import { fleetPreview } from "../server/preview.ts";
import { stateDirRefusal } from "../server/machine-profile.ts";
import { COMPILED, entryCommand, ROOT as SERVER_ROOT } from "../server/entries.ts";
import { version as builtVersion } from "../package.json";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, uptime } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

import { DEFAULT_PORT } from "../shared/protocol.ts";
import type { RemoteAccess } from "../shared/protocol.ts";
import { canServe, FALLBACK_PORTS, freePort, savedPort } from "./plugin-port.ts";
import type { WaitingDevice } from "./plugin-link.ts";
import { activePluginScript, COMMAND_ALIASES } from "./plugin-runtime.ts";
import { runTui } from "./plugin-tui.ts";
import { accountServiceOrigin, DEFAULT_ACCOUNT_SERVICE } from "../server/static.ts";
import { herdrStateDir } from "./plugin-state.ts";
import { HTTPS_PORT_VARIABLE, HTTPS_PORTS, httpsPorts, parseTailscale, parseTailscaleIp, parseTailscaleOwner, readTailscale, tailscaleBinary } from "../server/tailscale.ts";
import { descendantProcesses, windowsArgv, windowsProcessTable } from "../server/windows-processes.ts";

const ENV_FILES = ["env", ".env"];
const ROOT = resolve(process.env["HERDR_PLUGIN_ROOT"] ?? SERVER_ROOT);
function ownDir(parent: string): string {
  const legacy = join(parent, "herdr-web-ui");
  const next = join(parent, "ovis");
  return existsSync(next) || !existsSync(legacy) ? next : legacy;
}
const DEFAULT_STATE_DIR = ownDir(join(homedir(), ".local", "state"));
const PLUGIN_ID = "devswha.ovis";
const LEGACY_PLUGIN_ID = "devswha.herdr-web-ui";
const HERDR_PLUGIN_STATE = join(herdrStateDir(process.env, platform(), homedir()), "plugins");
const MANAGED_STATE_DIR = [PLUGIN_ID, LEGACY_PLUGIN_ID].map((id) => join(HERDR_PLUGIN_STATE, id)).find((dir) => existsSync(dir)) ?? join(HERDR_PLUGIN_STATE, PLUGIN_ID);
const REQUESTED_STATE_DIR = process.env["HERDR_PLUGIN_STATE_DIR"]
  ?? (pidIn(join(DEFAULT_STATE_DIR, "server.pid")) !== null || !existsSync(MANAGED_STATE_DIR) ? DEFAULT_STATE_DIR : MANAGED_STATE_DIR);
let STATE_DIR = runningStateDir(REQUESTED_STATE_DIR);
const CONFIG_DIR = process.env["HERDR_PLUGIN_CONFIG_DIR"] ?? herdrConfigDir() ?? ownDir(join(homedir(), ".config"));
adoptLegacyConfig(CONFIG_DIR);
let PID_FILE = join(STATE_DIR, "server.pid");
let LOG_FILE = join(STATE_DIR, "server.log");
let OWNER_FILE = join(STATE_DIR, "server.owner");
function settleStateDir(): void {
  STATE_DIR = runningStateDir(REQUESTED_STATE_DIR);
  PID_FILE = join(STATE_DIR, "server.pid");
  LOG_FILE = join(STATE_DIR, "server.log");
  OWNER_FILE = join(STATE_DIR, "server.owner");
}
const LIFECYCLE_LOCK = join(REQUESTED_STATE_DIR, "lifecycle.lock");
const LIFECYCLE_BUSY = "another start or stop of Ovis is running";
const LIFECYCLE_WAIT_MS = 60_000;
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
const KILL_WAIT_MS = 3_000;
/** `tailscale serve` waits while the user turns HTTPS on for the tailnet at the link it prints */
const SERVE_TIMEOUT_MS = 180_000;
/** how to come back to `phone` once Tailscale is set up: an action's output goes to herdr's log, not a terminal */
const PHONE_AGAIN = platform() === "win32"
  ? "irm https://ovis.sh/install.ps1 | iex"
  : "curl -fsSL https://ovis.sh/install.sh | sh";

function herdrConfigDir(): string | null {
  const herdr = Bun.which("herdr");
  if (herdr === null) return null;
  for (const id of [PLUGIN_ID, LEGACY_PLUGIN_ID]) {
    try {
      const result = Bun.spawnSync([herdr, "plugin", "config-dir", id], { windowsHide: true, stdout: "pipe", stderr: "ignore", timeout: 3000 });
      const dir = result.exitCode === 0 ? result.stdout.toString().trim() : "";
      if (dir !== "" && ENV_FILES.some((name) => existsSync(join(dir, name)))) return dir;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * herdr keeps a plugin's config dir by its id (`plugins/config/<id>`), so the settings and token
 * an install wrote under the old id are copied to the new id's dir the first time it has none.
 * The old dir stays: the plugin under the old id, still installed until the installer removes
 * it, reads it too.
 */
function adoptLegacyConfig(dir: string): void {
  if (basename(dir) !== PLUGIN_ID || ENV_FILES.some((name) => existsSync(join(dir, name)))) return;
  const legacy = join(dirname(dir), LEGACY_PLUGIN_ID);
  for (const name of ENV_FILES) {
    const from = join(legacy, name);
    if (!existsSync(from)) continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(from, join(dir, name));
    chmodSync(join(dir, name), statSync(from).mode & 0o777);
  }
}

function readEnvFile(file: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

const CONFIG_FILES = ENV_FILES.map((name) => join(CONFIG_DIR, name)).filter((file) => existsSync(file));
const fileVars = CONFIG_FILES.map(readEnvFile);
const shadowed = fileVars.length === 2 ? Object.keys(fileVars[0]!).filter((key) => key in fileVars[1]! && fileVars[0]![key] !== fileVars[1]![key]) : [];
const env = mergeEnvLayers([process.env, ...fileVars]);
const configuredSocket = fileVars.some((vars) => (vars["HERDR_SOCKET"] ?? "") !== "");
const PATH_KEY = platform() === "win32" ? Object.keys(env).sort().find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
const APP_STATE_DIR = defaultStateDir(env);
const PORT_FILE = join(APP_STATE_DIR, "plugin-port");
const portSet = (env["PORT"] ?? "") !== "";
let port = portSet ? Number(env["PORT"]) : savedPort(PORT_FILE) ?? DEFAULT_PORT;
const host = env["HOST"] ?? "127.0.0.1";
const ipv6Loopback = env["OVIS_IPV6_LOOPBACK"] === "1";
const originOf = (value: number): string => `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${value}`;
let origin = originOf(port);

const machineProfile = fleetPreview(env) && env["OVIS_PROFILE"] === "machine";
const RECORD_MAX_BYTES = 4096;
/**
 * How the record is opened, as server/profile-marker.ts opens the profile's marker: never through a link, never waiting
 * (opening a FIFO for reading would wait for a writer), and never as this process's terminal.
 */
const RECORD_OPEN = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

function profileRecord(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, RECORD_OPEN);
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > RECORD_MAX_BYTES) return null;
    const bytes = Buffer.alloc(RECORD_MAX_BYTES + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < bytes.length; length += read) read = readSync(fd, bytes, length, bytes.length - length, length);
    if (length > RECORD_MAX_BYTES) return null;
    return JSON.parse(bytes.toString("utf8", 0, length));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ownerDoor(): string | null {
  if (!machineProfile) return null;
  try {
    const dir = realpathSync(APP_STATE_DIR);
    if (stateDirRefusal(dir) !== null) return null;
    const record = profileRecord(join(dir, "serve.lock", "http.json")) as { door?: unknown; socket?: unknown } | null;
    const own = join(dir, "serve.sock");
    if (typeof record !== "object" || record === null || record.door !== 1 || record.socket !== own) return null;
    const socket = lstatSync(own);
    return socket.isSocket() && socket.uid === process.getuid?.() && (socket.mode & 0o022) === 0 ? own : null;
  } catch { return null; }
}
let commandDoor: string | null | undefined;
const serverDoor = (): string | null => commandDoor === undefined ? ownerDoor() : commandDoor;
const serverOrigin = (): string => serverDoor() === null ? origin : "http://localhost";
function ownerFetch(door: string, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  request.headers.delete("authorization");
  return fetch(request, { unix: door });
}
function profileRelayOnly(): string {
  const cli = env["OVIS_CLI_NAME"] || "ovis";
  return `A phone reaches this machine profile through the Ovis relay only, not at an address: run ${cli} add to add this machine to your Ovis account, or ${cli} link --code to pair one device.`;
}

function serverFetch(path: string, init: RequestInit = {}, door = serverDoor()): Promise<Response> {
  return door === null ? fetch(`${origin}${path}`, init) : ownerFetch(door, `http://localhost${path}`, init);
}

/**
 * herdr's PATH plus where the one-line installer (install.sh) puts Bun, Node and herdr: herdr may
 * have been started from a shell that has none of them, and the server spawns `node` for every
 * terminal. Appended, so a Node the user chose (nvm, Homebrew) still comes first.
 */
function toolPath(): string {
  const current = (env[PATH_KEY] ?? "").split(delimiter).filter(Boolean);
  const home = homedir();
  const extra = [join(home, ".bun", "bin"), join(home, ".local", "bin"), join(home, ".local", "share", "ovis", "node", "bin"), join(home, ".local", "share", "herdr-web-ui", "node", "bin")];
  return [...current, ...extra.filter((dir) => existsSync(dir) && !current.includes(dir))].join(delimiter);
}

/** A clickable address where a terminal shows it (OSC 8), plain where the output goes to a log or a file. */
function link(url: string): string {
  return process.stdout.isTTY ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\` : url;
}

async function qrDrawer(): Promise<(text: string) => string> {
  const { default: qrcode } = await import("qrcode-generator");
  return (text) => {
    const code = qrcode(0, "M");
    code.addData(text);
    code.make();
    return code.createASCII(1, 1);
  };
}

async function pairingParts(): Promise<{ qr: (text: string) => string; decodeOffer: (url: string) => unknown }> {
  const [qr, { decodeOffer }] = await Promise.all([qrDrawer(), import("../shared/relay-offer.ts")]);
  return { qr, decodeOffer };
}

async function appHealth(): Promise<{ readonly engineDown: string | null } | null> {
  const door = serverDoor();
  if (machineProfile && door === null) return null;
  try {
    const response = await serverFetch("/api/health", { signal: AbortSignal.timeout(1500) }, door);
    if (!response.ok) return null;
    const body = await response.json() as { ok?: unknown; herdr?: unknown; auth?: unknown; machine_profile?: unknown };
    if (body.ok !== true || !appAuth(body.auth)) return null;
    const profile = door === null ? null : body.machine_profile as { runtime_down?: unknown; reason?: unknown } | null | undefined;
    const engine = typeof profile === "object" && profile !== null && typeof profile.runtime_down === "boolean" ? profile : null;
    if ((typeof body.herdr !== "object" || body.herdr === null) && engine === null) return null;
    commandDoor = door;
    return { engineDown: engine?.runtime_down === true ? (typeof engine.reason === "string" ? engine.reason : "") : null };
  } catch {
    return null;
  }
}

async function health(): Promise<boolean> {
  return (await appHealth()) !== null;
}

async function appOnPort(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health?scope=bridge`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; auth?: unknown; bridge_protocol?: unknown };
    return body.ok === true && Number.isInteger(body.bridge_protocol) && appAuth(body.auth);
  } catch {
    return false;
  }
}

function appAuth(auth: unknown): boolean {
  const fields = auth as { required?: unknown; authenticated?: unknown } | null | undefined;
  return typeof fields?.required === "boolean" && typeof fields.authenticated === "boolean";
}

async function healthError(): Promise<string | null> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await response.json()) as { ok?: unknown; error?: { message?: unknown } };
    if (response.ok && body.ok === true) return null;
    return typeof body.error?.message === "string" ? body.error.message : `its health check answered ${response.status}`;
  } catch {
    return "its health check did not answer";
  }
}

function recordedPid(): number | null {
  return pidIn(PID_FILE);
}

function provedServer(): number | null {
  const pid = recordedPid();
  // an exited server its parent has not reaped yet still answers signal 0, with its birth
  if (pid === null || liveProcess(pid) === false) return null;
  return recordedServer(pid) === "ours" ? pid : null;
}

function recordedServer(pid: number): "ours" | "replaced" | "unrecorded" {
  let owner = null as { pid?: unknown; birth?: unknown; birth_unknown?: unknown } | null;
  let recordedAt = 0;
  try {
    owner = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as typeof owner;
    recordedAt = statSync(OWNER_FILE).mtimeMs;
  } catch {}
  if (owner?.pid !== pid) return "unrecorded";
  const now = readProcessBirth(pid);
  if (now.state === "absent") return "replaced";
  // a recorded birth alone decides (Linux's carries the boot id): the wall clock can step forward
  // (NTP on a PC without a clock of its own, a resumed VM) and make a live server look older than this boot
  const birth = parseBirth(owner.birth);
  if (birth !== null && birth.platform === process.platform) return now.state === "unknown" || now.birth.value === birth.value ? "ours" : "replaced";
  if (owner.birth_unknown !== true) return "unrecorded";
  if (recordedAt < Date.now() - uptime() * 1000 - 1000) return "replaced";
  return now.state === "identified" && startedAfter(now.birth.value, recordedAt) ? "replaced" : "ours";
}

function startedAfter(birth: string, time: number): boolean {
  if (process.platform === "win32") return Number(birth) > time;
  if (process.platform === "darwin") {
    // `ps -o lstart` under TZ=UTC, to the second: "Wed Oct 21 17:41:40 2026"
    const [, month, day, clock, year] = birth.split(" ");
    return Date.parse(`${month} ${day} ${year} ${clock} UTC`) > time + 1000;
  }
  return false; // Linux: ticks after boot; a reused pid within one boot needs the pid space to wrap
}

/**
 * herdr keeps a plugin's state dir by its id too. A server started under the old id keeps its pid
 * in the old id's dir until it stops (the installer stops it before moving the install to the new
 * id; `herdr plugin update` never moves the id), so `stop` and `status` read that dir while it runs.
 */
function runningStateDir(dir: string): string {
  if (basename(dir) !== PLUGIN_ID || pidIn(join(dir, "server.pid")) !== null) return dir;
  const legacy = join(dirname(dir), LEGACY_PLUGIN_ID);
  return pidIn(join(legacy, "server.pid")) !== null ? legacy : dir;
}

function pidIn(file: string): number | null {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}


async function takeTurn(): Promise<OwnerLease | string> {
  try { closeSync(openSync(guardPath(LIFECYCLE_LOCK), "a", 0o600)); }
  catch (error) { return `${guardPath(LIFECYCLE_LOCK)} could not be opened: ${(error as Error).message}`; }
  const deadline = Date.now() + LIFECYCLE_WAIT_MS;
  let said = false;
  for (;;) {
    try {
      return acquireOwnerDirectory(LIFECYCLE_LOCK, { running: LIFECYCLE_BUSY, starting: LIFECYCLE_BUSY }, {}, { wait: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith(LIFECYCLE_BUSY)) return message;
      if (Date.now() >= deadline) return `${message} and did not finish within ${LIFECYCLE_WAIT_MS / 1000}s; if none is running, remove ${LIFECYCLE_LOCK}`;
      if (!said) process.stdout.write(`${message}; waiting for it to finish\n`);
      said = true;
    }
    await Bun.sleep(250);
  }
}

function warnShadowed(): void {
  if (shadowed.length === 0) return;
  process.stdout.write(`both env and .env in ${CONFIG_DIR} set ${shadowed.join(", ")}; .env wins. Merge them into one file.\n`);
}

/**
 * A start's failure, in full to herdr's plugin log and in one line to server.log: the Windows
 * launcher runs this in a hidden console, so the log is all it can show. A start that opened its
 * server's log passes that handle, so the line stays with its run if the log has moved meanwhile.
 */
function failStart(message: string, detail = "", log: number | string = LOG_FILE): number {
  process.stderr.write(`${message}${detail}\n`);
  appendFileSync(log, `start: ${message}\n`);
  return 1;
}

const LOG_TAIL_BYTES = 64 * 1024;

function logSince(log: number, offset: number): string {
  const size = fstatSync(log).size;
  const from = Math.max(offset, size - LOG_TAIL_BYTES);
  const bytes = Buffer.alloc(Math.max(0, size - from));
  let text = bytes.subarray(0, readSync(log, bytes, 0, bytes.length, from)).toString("utf8");
  if (from > offset) {
    const rest = text.slice(text.indexOf("\n") + 1);
    if (rest.trim() !== "") text = rest;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? "(nothing)" : lines.slice(-15).join("\n");
}

/**
 * Keeps the run before this one as server.log.1 rather than appending every run to one file. A
 * recorded server that is still alive may still write the log, so it is appended to then, as is a
 * log that cannot be moved (Windows refuses while some program holds it open without sharing).
 */
function keepPreviousLog(): void {
  if (recordedPid() !== null) return;
  try {
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    const message = `appending to ${LOG_FILE}: it could not be moved to ${LOG_FILE}.1 (${(error as Error).message})`;
    process.stdout.write(`${message}\n`);
    // the Windows launcher's console is hidden: the log is where this can be read
    appendFileSync(LOG_FILE, `start: ${message}\n`);
  }
}

async function settlePort(): Promise<"ready" | "running" | "failed"> {
  if (await canServe(host, port, ipv6Loopback)) return "ready";
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (recordedPid() !== null && Date.now() < deadline) {
    const kept = portSet ? port : savedPort(PORT_FILE) ?? DEFAULT_PORT;
    if (kept !== port) {
      port = kept;
      origin = originOf(port);
    }
    if (await health()) return "running";
    await Bun.sleep(250);
  }
  if (!machineProfile && await appOnPort()) {
    if (await health()) return "running";
    const why = await healthError();
    if (why === null) return "running";
    const pid = recordedPid();
    failStart(`Ovis is running at ${origin}${pid === null ? "" : ` (pid ${pid})`} but cannot reach herdr: ${why}. It keeps this port and answers again once herdr is back.`);
    return "failed";
  }
  const settings = CONFIG_FILES.at(-1) ?? join(CONFIG_DIR, "env");
  const blocked = platform() === "win32"
    ? `port ${port} on ${host} cannot be opened: another program has it, or Windows reserves it for Hyper-V, WSL2 or Docker (netsh interface ipv4 show excludedportrange protocol=tcp lists the reserved ranges).`
    : `port ${port} on ${host} cannot be opened: another program has it.`;
  if (portSet) {
    failStart(`${blocked} Set another PORT in ${settings}`);
    return "failed";
  }
  const free = await freePort(port, DEFAULT_PORT, (candidate) => canServe(host, candidate, ipv6Loopback));
  if (free === null) {
    failStart(`${blocked} Neither can ${[DEFAULT_PORT, ...FALLBACK_PORTS].filter((candidate) => candidate !== port).join(", ")}. Put PORT=<a free port> in ${settings}`);
    return "failed";
  }
  process.stdout.write(`${blocked} Using port ${free} instead; to choose one yourself, put PORT=<port> in ${settings}\n`);
  port = free;
  origin = originOf(port);
  return "ready";
}

async function start(): Promise<number> {
  warnShadowed();
  if (await health()) {
    process.stdout.write(`Ovis already running at ${origin}\n`);
    return 0;
  }
  if (machineProfile) {
    process.stderr.write("This plugin does not start a machine profile. Start it with OVIS_PROFILE=machine, OVIS_PREVIEW=fleet and OVIS_STATE_DIR naming a folder of its own, running ovis-server serve.\n");
    return 1;
  }
  mkdirSync(REQUESTED_STATE_DIR, { recursive: true });
  const turn = await takeTurn();
  if (typeof turn === "string") return failStart(`could not start Ovis: ${turn}`);
  try {
    settleStateDir();
    return await startInTurn();
  } finally {
    turn.release();
  }
}

async function startInTurn(): Promise<number> {
  if (!portSet) {
    const kept = savedPort(PORT_FILE) ?? DEFAULT_PORT;
    if (kept !== port) {
      port = kept;
      origin = originOf(port);
    }
  }
  if (await health()) {
    process.stdout.write(`Ovis already running at ${origin}\n`);
    return 0;
  }
  const settled = await settlePort();
  if (settled === "failed") return 1;
  if (settled === "running") {
    process.stdout.write(`Ovis already running at ${origin}\n`);
    return 0;
  }
  const running = provedServer();
  if (running !== null) return failStart(`Ovis (pid ${running}) is still running but does not answer ${origin}/api/health. Stop it before starting it again.`);
  if (!portSet) {
    if (port === DEFAULT_PORT) rmSync(PORT_FILE, { force: true });
    else {
      mkdirSync(APP_STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(`${PORT_FILE}.tmp`, `${port}\n`, { mode: 0o600 });
      renameSync(`${PORT_FILE}.tmp`, PORT_FILE);
    }
  }
  keepPreviousLog();
  const log = openSync(LOG_FILE, "a+");
  const logged = fstatSync(log).size;
  const [runtime, managed] = entryCommand("managed", ROOT);
  const child = spawn(runtime, [managed], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
      [PATH_KEY]: toolPath(),
      HOST: host,
      PORT: String(port),
      ...(env["HERDR_SOCKET_PATH"] !== undefined && !configuredSocket ? { HERDR_SOCKET: env["HERDR_SOCKET_PATH"] } : {}),
    },
  });
  child.unref();
  if (child.pid === undefined) {
    process.stderr.write("could not spawn the server\n");
    return 1;
  }
  try {
    const birth = readProcessBirth(child.pid);
    writeRecord(OWNER_FILE, `${JSON.stringify({ pid: child.pid, ...(birth.state === "identified" ? { birth: birth.birth } : { birth_unknown: true }) })}\n`);
    writeRecord(PID_FILE, `${child.pid}\n`);
  } catch (error) {
    const stopped = await stopSpawned(child);
    forgetServer(child.pid);
    return failStart(`could not record the server it started (pid ${child.pid}): ${(error as Error).message}; ${stopped ? "it was stopped" : "it may still be running"}`, "", log);
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await health()) {
      process.stdout.write(`Ovis listening at ${origin}\n`);
      if ((env["OVIS_TOKEN"] ?? "") === "") {
        process.stdout.write(`no token set: your own Tailscale devices get in as you; pair any other device in Settings → Devices, or put OVIS_TOKEN=<token> in ${join(CONFIG_DIR, "env")}\n`);
      }
      return 0;
    }
    await Bun.sleep(250);
  }
  const why = child.exitCode === null
    ? `server did not answer ${origin}/api/health within ${READY_TIMEOUT_MS / 1000}s`
    : `the server stopped (exit ${child.exitCode}) before it answered ${origin}/api/health`;
  return failStart(why, `; ${LOG_FILE} ends with:\n${logSince(log, logged)}`, log);
}

/** Written whole or not at all, and flushed before it replaces the old one: a reader never finds half a record, nor an empty one after a power cut. */
function writeRecord(file: string, text: string): void {
  writeStateDocument(file, text, false);
}

function forgetServer(pid: number): void {
  try { if (Number(readFileSync(PID_FILE, "utf8").trim()) === pid) rmSync(PID_FILE, { force: true }); } catch {}
  try { if ((JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { pid?: unknown }).pid === pid) rmSync(OWNER_FILE, { force: true }); } catch {}
}

async function stopSpawned(child: ReturnType<typeof spawn>): Promise<boolean> {
  const pid = child.pid!;
  const windows = platform() === "win32";
  try {
    if (windows) stopDependencies.terminateTree(pid);
    else process.kill(-pid, "SIGKILL");
  } catch {}
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const gone = (): boolean => {
    if (!exited()) return false;
    if (windows) return true;
    try { process.kill(-pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    return liveProcess(-pid) === false;
  };
  const deadline = Date.now() + KILL_WAIT_MS;
  while (!gone() && Date.now() < deadline) await Bun.sleep(50);
  return gone();
}

/**
 * Whether a process (a pid) or process group (a negative pgid) has a member that has not exited,
 * from /proc: a zombie, exited but not yet reaped by its parent, still answers `kill(pid, 0)`.
 * null without /proc (macOS), where signal 0 is all there is.
 */
function liveProcess(target: number): boolean | null {
  if (!existsSync("/proc/self/stat")) return null;
  // "<pid> (<comm>) <state> <ppid> <pgrp> ...": comm may hold spaces and parens
  const stat = (pid: string): { state: string; group: number } | null => {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, , group] = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      return { state: state!, group: Number(group) };
    } catch {
      return null;
    }
  };
  if (target > 0) {
    const own = stat(String(target));
    return own !== null && own.state !== "Z";
  }
  return readdirSync("/proc").some((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    const member = stat(pid);
    return member !== null && member.group === -target && member.state !== "Z";
  });
}

type StopDependencies = {
  readonly isWindows: boolean;
  readonly processTable: typeof windowsProcessTable;
  readonly isAlive: (pid: number) => boolean;
  readonly terminateTree: (pid: number) => { status: number | null; error: Error | undefined; stderr: string };
};

const stopDependencies: StopDependencies = {
  isWindows: platform() === "win32",
  processTable: windowsProcessTable,
  isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
  terminateTree(pid) {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, encoding: "utf8" });
    return {
      status: result.status,
      error: result.error,
      stderr: result.stderr?.trim() ?? "",
    };
  },
};

export function startedByThisPlugin(path: string, argv: string[], env: Record<string, string | undefined> = process.env): boolean {
  const same = (left: string | undefined, right: string) => left?.toLowerCase() === right.toLowerCase();
  if (same(path, process.execPath) && same(argv[1], entryCommand("managed", ROOT)[1])) return true;
  const checkout = env["OVIS_PLUGIN_CHECKOUT"] ?? env["HERDR_PLUGIN_ROOT"];
  if (!checkout) return false;
  if (same(argv[1], join(checkout, "server", "managed.ts")) && /^bun(\.exe)?$/i.test(basename(path))) return true;
  const installed = `${join(checkout, ".ovis", "server").toLowerCase()}${sep}`;
  return argv[1] === "managed" && path.toLowerCase().startsWith(installed) && /^ovis-server(\.exe)?$/i.test(basename(path));
}

export async function stop(dependencies: StopDependencies = stopDependencies): Promise<number> {
  if (!existsSync(REQUESTED_STATE_DIR) && recordedPid() === null) {
    process.stdout.write("Ovis is not running\n");
    return 0;
  }
  mkdirSync(REQUESTED_STATE_DIR, { recursive: true });
  const turn = await takeTurn();
  if (typeof turn === "string") {
    process.stderr.write(`could not stop Ovis: ${turn}\n`);
    return 1;
  }
  try {
    settleStateDir();
    return await stopInTurn(dependencies);
  } finally {
    turn.release();
  }
}

function recordedWindowsBirth(pid: number): number | null {
  try {
    const owner = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { pid?: unknown; birth?: unknown };
    const birth = parseBirth(owner.birth);
    return owner.pid === pid && birth?.platform === "win32" ? Number(birth.value) : null;
  } catch { return null; }
}

async function stopInTurn(dependencies: StopDependencies): Promise<number> {
  const pid = recordedPid();
  if (pid === null) {
    rmSync(PID_FILE, { force: true });
    process.stdout.write("Ovis is not running\n");
    return 0;
  }
  let target = dependencies.isWindows ? pid : -pid;
  if (dependencies.isWindows) {
    const recordedAt = statSync(PID_FILE).mtimeMs;
    const processes = await dependencies.processTable();
    const owner = processes.find(row => row.pid === pid);
    const birth = recordedWindowsBirth(pid);
    const identified = owner?.started !== undefined && (birth !== null
      ? owner.started === birth
      : owner.started <= recordedAt && startedByThisPlugin(owner.path ?? "", windowsArgv(owner.commandLine ?? "")));
    if (!owner || !identified
      || !existsSync(PID_FILE) || statSync(PID_FILE).mtimeMs !== recordedAt
      || Number(readFileSync(PID_FILE, "utf8").trim()) !== pid) {
      process.stderr.write("could not verify the recorded Ovis process; it was left running and its pid file was kept\n");
      return 1;
    }
    const tree = [owner, ...descendantProcesses(processes, pid).flatMap(({ pid: memberPid }) => {
      const member = processes.find(row => row.pid === memberPid);
      return member ? [member] : [];
    })];
    // Windows has no Unix process groups or graceful SIGTERM: include the supervisor and bridge.
    const killed = dependencies.terminateTree(pid);
    if (killed.status !== 0 && recordedPid() !== null) {
      process.stderr.write(`could not stop Ovis: ${killed.error?.message ?? killed.stderr.trim()}\n`);
      return 1;
    }
    const deadline = Date.now() + 10_000;
    let exited = false;
    while (Date.now() < deadline) {
      const alive = tree.filter(member => dependencies.isAlive(member.pid));
      if (alive.length === 0) { exited = true; break; }
      const currentProcesses = await dependencies.processTable(Math.max(1, deadline - Date.now()));
      const running = alive.some(member => {
        if (!dependencies.isAlive(member.pid)) return false;
        const current = currentProcesses.find(row => row.pid === member.pid);
        return !(member.started !== undefined && current?.started !== undefined && current.started !== member.started);
      });
      if (!running) { exited = true; break; }
      await Bun.sleep(50);
    }
    if (!exited) {
      process.stderr.write("could not confirm Ovis stopped; its pid file was kept\n");
      return 1;
    }
    // Never send another kill to a number Windows may have reassigned after taskkill.
    if (existsSync(PID_FILE) && statSync(PID_FILE).mtimeMs === recordedAt
      && Number(readFileSync(PID_FILE, "utf8").trim()) === pid) rmSync(PID_FILE);
    process.stdout.write(`stopped Ovis (pid ${pid})\n`);
    return 0;
  } else {
    if (recordedServer(pid) === "replaced") {
      forgetServer(pid);
      process.stdout.write(`Ovis is not running (pid ${pid} now belongs to another process)\n`);
      return 0;
    }
    try {
      process.kill(target, "SIGTERM");
    } catch {
      target = pid;
      process.kill(pid, "SIGTERM");
    }
  }
  const running = (): boolean => {
    try {
      process.kill(target, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
    // an exited server its parent has not reaped yet still answers signal 0
    return liveProcess(target) ?? true;
  };
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (running() && Date.now() < deadline) await Bun.sleep(100);
  const killed = running();
  const handedOn = killed && target === pid && recordedServer(pid) === "replaced";
  if (killed && !handedOn) {
    try { process.kill(target, "SIGKILL"); } catch {}
    const killDeadline = Date.now() + KILL_WAIT_MS;
    while (running() && Date.now() < killDeadline) await Bun.sleep(100);
    if (running()) {
      process.stderr.write(`Ovis (pid ${pid}) is still running after SIGKILL; its pid file is kept\n`);
      return 1;
    }
  }
  forgetServer(pid);
  process.stdout.write(`stopped Ovis (pid ${pid})${killed && !handedOn ? `; it was still running after ${STOP_TIMEOUT_MS / 1000}s, so it was killed` : ""}\n`);
  return 0;
}

async function pair(parts?: Awaited<ReturnType<typeof pairingParts>>): Promise<number> {
  if (process.argv.includes("--approve")) return approvePairings();
  if (machineProfile) {
    process.stderr.write(`${profileRelayOnly()}\n`);
    return 1;
  }
  const { qr, decodeOffer } = parts ?? await pairingParts();
  if (!(await health())) {
    process.stderr.write(`Ovis is not running at ${origin}; start it first\n`);
    return 1;
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1" };
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const started = await serverFetch("/api/devices/pair/start", { method: "POST", headers, body: "{}" });
  if (!started.ok) {
    process.stderr.write(`could not start a pairing (${started.status}): ${await started.text()}\n`);
    return 1;
  }
  const { code } = (await started.json()) as { code: string; expires_at: string };
  let url: string | null = null;
  try {
    const access = (await (await serverFetch("/api/access", { headers })).json()) as { tailscale: { serving_url: string | null } };
    url = access.tailscale.serving_url;
  } catch {}
  const out: string[] = [`Pairing code: ${code.slice(0, 3)} ${code.slice(3)}   (good for 10 minutes, for one device)`];
  if (url !== null) {
    out.push(`On the other device, open ${link(url)} and enter the code, or scan this to open it with the code filled in:`, "");
    out.push(qr(`${url}/?pair=${code}`));
  } else {
    out.push("On the other device, open the app's address and enter the code. Settings → Phone, on any signed-in device, shows the address and how to get one.");
  }
  try {
    const relayResponse = await serverFetch("/api/relay", { headers, signal: AbortSignal.timeout(5000) });
    if (relayResponse.status !== 404) {
      if (!relayResponse.ok) throw new Error(`relay status request failed (${relayResponse.status})`);
      const relayStatus: unknown = await relayResponse.json();
      if (typeof relayStatus !== "object" || relayStatus === null || !("phase" in relayStatus) || typeof relayStatus.phase !== "string") {
        throw new Error("invalid relay status response");
      }
      if (relayStatus.phase === "online") {
        const offerResponse = await serverFetch("/api/relay/offer", {
          method: "POST",
          headers: { ...headers, "x-herdr-update": "1", origin: serverOrigin() },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        if (!offerResponse.ok) throw new Error(`relay offer request failed (${offerResponse.status})`);
        const offer: unknown = await offerResponse.json();
        if (typeof offer !== "object" || offer === null || !("url" in offer) || typeof offer.url !== "string" || !offer.url.includes("#offer=")) {
          throw new Error("invalid relay offer response");
        }
        if (!decodeOffer(offer.url)) throw new Error("invalid relay offer URL");
        out.push("", "Ovis relay", link(offer.url), "", qr(offer.url));
      } else {
        out.push("To turn on Ovis relay: Settings -> Devices and PCs -> Ovis relay.");
      }
    }
  } catch (error) {
    process.stderr.write(`Could not read Ovis relay pairing: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

async function approvePairings(): Promise<number> {
  const { approveWaiting, discardTyped } = await import("./plugin-link.ts");
  if (!(await health())) {
    process.stderr.write(`Ovis is not running at ${origin}; start it first\n`);
    return 1;
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: serverOrigin() };
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const listed = await serverFetch("/api/relay/pairings", { headers });
  if (!listed.ok) {
    process.stderr.write(`could not read the waiting pairings (${listed.status}): ${await listed.text()}\n`);
    return 1;
  }
  const { pairings } = (await listed.json()) as { pairings: WaitingDevice[] };
  if (pairings.length === 0) {
    process.stdout.write("No device is waiting to pair.\n");
    return 0;
  }
  return approveWaiting(pairings, {
    out: (text) => process.stdout.write(text),
    lines: console[Symbol.asyncIterator](),
    terminal: process.stdin.isTTY === true,
    discard: discardTyped,
    signal: new AbortController().signal,
    list: async () => {
      const again = await serverFetch("/api/relay/pairings", { headers, signal: AbortSignal.timeout(15_000) });
      if (!again.ok) throw new Error(`could not read the waiting pairings (${again.status})`);
      return ((await again.json()) as { pairings: WaitingDevice[] }).pairings;
    },
    decide: async (id, decision) => {
      try {
        const decided = await serverFetch("/api/relay/pairing", { method: "POST", headers, body: JSON.stringify({ id, decision }), signal: AbortSignal.timeout(15_000) });
        return decided.ok ? "taken" : "gone";
      } catch { return "away"; }
    },
  });
}

/**
 * Runs the release Settings → Updates installed (its scripts/plugin.ts, `active`) with `args` in this terminal, and gives
 * back its exit code: the checkout survives in-app updates, and the release that runs has the command that fits its
 * server. A SIGINT, SIGTERM or SIGHUP sent to this process is passed on, and this process waits for the release, which
 * ends with it and takes back what it handed out (link's code). A Ctrl+C on the terminal they share reaches the release
 * itself too, so it gets that SIGINT twice: every release ends at the first or catches each (link). On Windows a SIGINT
 * is not passed on: there Bun ends a child outright for any signal it is sent, without the clean-up the release's own
 * Ctrl+C gives it, and a Ctrl+C reaches every process of the console anyway.
 * Listening starts before the release does, so a signal that comes while it starts no longer ends this process with the
 * release left running: Bun runs the listener from the event loop, after `child` is set. A release that could not be
 * started has nothing to pass one on to, and the listeners go on every way out.
 */
async function handOn(active: string, args: readonly string[]): Promise<number> {
  let child: Bun.Subprocess | undefined;
  const pass = (signal: NodeJS.Signals) => () => { child?.kill(signal); };
  const handlers = { SIGINT: process.platform === "win32" ? () => undefined : pass("SIGINT"), SIGTERM: pass("SIGTERM"), SIGHUP: pass("SIGHUP") } as const;
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    child = Bun.spawn([process.execPath, active, ...args], { cwd: ROOT, windowsHide: true, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  }
}

async function linkCommand(): Promise<number> {
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) return await handOn(active, ["link", ...process.argv.slice(3)]);
  const { discardTyped, link: linkPc, linkSettings } = await import("./plugin-link.ts");
  if (!(await health())) {
    process.stderr.write(`Ovis is not running at ${origin}; start it first\n`);
    return 1;
  }
  const headers: Record<string, string> = {};
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const stop = new AbortController();
  const halt = (): void => {
    if (stop.signal.aborted) return;
    stop.abort();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, halt);
  // An output that went away (the terminal closed, a pipe's reader ended) fails the next write. A failed write nobody
  // hears ends the process where it stands, or leaves it running with nobody to read it: the code stays valid either
  // way. It is heard instead, and stops the run as its signal would
  process.stdout.on("error", halt);
  const door = serverDoor();
  return linkPc(process.argv.slice(3), {
    origin: door === null ? origin : "http://localhost", headers, signal: stop.signal,
    ...(door === null ? {} : { fetch: (input: string | URL | Request, init?: RequestInit) => ownerFetch(door, input, init) }),
    accountService: accountServiceOrigin(env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE),
    ...linkSettings(env),
    out: (text) => process.stdout.write(text),
    lines: console[Symbol.asyncIterator](),
    terminal: process.stdin.isTTY === true,
    discard: discardTyped,
    isTty: process.stdout.isTTY === true,
    size: () => process.stdout.isTTY === true ? { rows: process.stdout.rows, columns: process.stdout.columns } : null,
  });
}

async function phone(): Promise<number> {
  if (machineProfile) {
    process.stdout.write(`${profileRelayOnly()}\n`);
    return 0;
  }
  const qr = await qrDrawer();
  const say = (line = "") => process.stdout.write(line + "\n");
  const running = await health();
  say(`Ovis on this PC: ${link(origin)}${running ? "" : " (not running yet: it starts with herdr)"}`);
  if (!["127.0.0.1", "0.0.0.0", "localhost"].includes(host)) {
    say(`HOST is ${host}, so Tailscale, which serves 127.0.0.1, is left alone. On the phone, open ${link(`http://${host}:${port}`)}.`);
    return 0;
  }
  const chosen = env[HTTPS_PORT_VARIABLE]?.trim() ?? "";
  const candidates = httpsPorts(chosen);
  const binary = tailscaleBinary();
  let output = await readTailscale(binary);
  let access = parseTailscale(output, port, candidates);
  if (binary === null || access.state === "missing") {
    say("For your phone: install Tailscale on this PC and on the phone (https://tailscale.com/download),");
    say(`sign in to the same account on both, then run: ${PHONE_AGAIN}`);
    return 0;
  }
  if (access.state === "stopped") {
    say(`For your phone: Tailscale is installed but not signed in. Run \`tailscale up\` (or open the Tailscale app), then run: ${PHONE_AGAIN}`);
    return 0;
  }
  let published = false;
  if (access.serving_url === null) {
    if (access.serve_command === null) {
      if (chosen === "") say(`Tailscale on this PC already uses every HTTPS port this would take (${HTTPS_PORTS.join(", ")}). Settings → Phone shows what to do.`);
      else if (candidates.length === 0) say(`${HTTPS_PORT_VARIABLE} is "${chosen}", which is not a port (1-65535). Fix it where you set it (the plugin's env file, or the installer's command), then run: ${PHONE_AGAIN}`);
      else say(`Tailscale on this PC already uses HTTPS port ${candidates[0]}, which ${HTTPS_PORT_VARIABLE} names, so the app is not published on another one. Free that port or name another, then run: ${PHONE_AGAIN}`);
      return chosen !== "" && candidates.length === 0 ? 1 : 0;
    }
    say(`Publishing the app to your tailnet: ${access.serve_command}`);
    const [, ...args] = access.serve_command.split(" ");
    const serve = Bun.spawn([binary, ...args.slice(0, 1), "--yes", ...args.slice(1)], { windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => serve.kill(), SERVE_TIMEOUT_MS);
    const code = await serve.exited;
    clearTimeout(timer);
    if (code !== 0) {
      say(`Tailscale did not take it (exit ${code}).${platform() === "linux" ? " On Linux, let your user change Tailscale once with `sudo tailscale set --operator=$USER`," : ""}`);
      say(`then run: ${PHONE_AGAIN}   Or run the command above yourself.`);
      return 1;
    }
    output = await readTailscale(binary);
    access = parseTailscale(output, port, candidates);
    published = true;
  }
  const url = access.serving_url;
  if (url === null) {
    say("Tailscale accepted the command, but does not report the address yet. Settings → Phone shows it once it does.");
    return 1;
  }
  const httpsPort = new URL(url).port || "443";
  if (published) say(`Tailscale now serves ${url} → http://127.0.0.1:${port}, for your tailnet only. To undo: tailscale serve --https=${httpsPort} off`);
  const owner = parseTailscaleOwner(output?.status ?? null);
  const ip = parseTailscaleIp(output?.status ?? null);
  say("");
  say(`On your phone: ${link(url)}`);
  if (ip !== null) say(`Tailscale IP of this PC: ${ip}. Open the name above, not the IP: the HTTPS certificate is for the name.`);
  say(`Scan this with a phone signed in to Tailscale${owner === null ? "" : ` as ${owner}`}; that login gets in without a code (with OVIS_TOKEN set, after entering the token once).`);
  say("Anyone else on your tailnet needs a pairing code: Settings → Devices, or the pair command.");
  say(qr(url));
  return 0;
}

async function phoneSetup(): Promise<number> {
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) return await handOn(active, ["phone-setup"]);
  const parts = machineProfile ? null : await pairingParts();
  process.stdout.write(`Phone setup\n\n${parts === null ? profileRelayOnly() : `App on this PC: ${link(origin)}`}\n`);
  let code = 0;
  if (parts === null) code = 0;
  else if (!(await health())) {
    process.stdout.write("The app is not running. Run the Start Ovis action, then reopen Phone setup.\n");
    code = 1;
  } else {
    const headers: Record<string, string> = {};
    if (env["OVIS_TOKEN"]) headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
    try {
      const response = await serverFetch("/api/access", { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`access request failed (${response.status})`);
      const access = await response.json() as RemoteAccess;
      if (!access.tailscale.serving_url) {
        if (access.tailscale.serve_command) process.stdout.write(`To make a phone address, run this on the PC, then reopen Phone setup:\n\n  ${access.tailscale.serve_command}\n\n`);
        else process.stdout.write("For a phone address, set up Tailscale on both devices, or use your own HTTPS proxy. Settings → Phone shows the connection options.\n\n");
      }
      code = await pair(parts);
    } catch {
      process.stderr.write("Could not read phone setup. Check the app's token and connection, then reopen this pane.\n");
      code = 1;
    }
  }
  if (process.stdin.isTTY) {
    process.stdout.write("\nPress Enter to finish. Reopen Phone setup for a fresh pairing code.\n");
    await new Promise<void>((done) => { process.stdin.once("data", () => done()); process.stdin.resume(); });
    process.stdin.pause();
  }
  return code;
}

function runningVersion(): string | null {
  if (COMPILED) return builtVersion;
  try {
    const version = (JSON.parse(readFileSync(join(dirname(activePluginScript(ROOT, port, APP_STATE_DIR)), "..", "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

/** Reporting "down" is not an action failure: herdr logs a nonzero exit as failed. */
async function status(): Promise<number> {
  const pid = recordedPid();
  const answer = await appHealth();
  process.stdout.write(`${answer !== null ? "running" : "down"} ${origin}${pid === null ? "" : ` (pid ${pid})`}\n`);
  if (typeof answer?.engineDown === "string") process.stdout.write(`engine: down${answer.engineDown === "" ? "" : ` (${answer.engineDown})`}\n`);
  const version = runningVersion();
  if (version !== null) process.stdout.write(`version: ${version}\n`);
  process.stdout.write(`config: ${CONFIG_FILES.length === 0 ? `none (settings go in ${join(CONFIG_DIR, "env")})` : CONFIG_FILES.join(", ")}\n`);
  warnShadowed();
  return 0;
}

export async function runPlugin(): Promise<void> {
  const named = process.argv[2] ?? "status";
  const command = Object.hasOwn(COMMAND_ALIASES, named) ? COMMAND_ALIASES[named] : named;
  if (command === "start") process.exit(await start());
  else if (command === "stop") process.exit(await stop());
  else if (command === "status") process.exit(await status());
  else if (command === "pair") process.exit(await pair());
  else if (command === "link") process.exit(await linkCommand());
  else if (command === "phone") process.exit(await phone());
  else if (command === "phone-setup") process.exit(await phoneSetup());
  else if (command === "tui") process.exit(await runTui(process.argv.slice(3), { platform: platform(), where: { root: ROOT, home: homedir() }, caller: process.env, settings: env, err: (text) => process.stderr.write(text), on: (signal, handler) => { process.on(signal, handler); return () => process.off(signal, handler); } }));
  else {
    const active = activePluginScript(ROOT, port, APP_STATE_DIR);
    if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) process.exit(await handOn(active, process.argv.slice(2)));
    process.stderr.write([
      "usage: bun scripts/plugin.ts <start|stop|status|pair|link|add|login|phone|phone-setup|tui>",
      "add (also login, link): sign this PC in, then scan its QR code with a device of your Ovis account to add it (--approve: approve that device here instead; --print: write the QR code where there is no terminal).",
      "link --code: show a code and a QR code to pair one device instead.",
      "tui: herdr-core's terminals in this terminal, as herdr shows them.",
      "",
    ].join("\n"));
    process.exit(2);
  }
}

if (import.meta.main) await runPlugin();
