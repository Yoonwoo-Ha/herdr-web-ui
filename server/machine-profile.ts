/**
 * The ordinary server beside an owner's classic herdr, with no engine lifecycle authority. Its local owner is
 * whoever connects to `<state folder>/serve.sock`: the kernel lets only this account (and root) in there. Its
 * TCP port tells everyone that it is alive and nothing else; its devices come through the relay.
 */
import { closeSync, constants, type Dirent, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { LOCAL_MACHINE, type Machine, type MachineRoster } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { trustRefusal } from "./herdr-core/discovery.ts";
import { discoverPinnableHerdrSessions, heldHerdrSocketStatus, type HerdrSocketPlace, pinnedHerdrSocketStatus, profileGroups, validHerdrSocket } from "./herdr-discovery.ts";
import { checkHerdrSockets, HerdrError, herdrSocketPath, ping } from "./herdr/client.ts";
import { errorResponse, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { acquireOwnerDirectory, holdForLife, liveOwner, OwnerGuardBusy } from "./owner-guard.ts";
import { writePrivateState } from "./private-state.ts";
import { MARKER, markedByProfile } from "./profile-marker.ts";
import { stateDirNames } from "./update-state.ts";

export const MACHINE_DIRECT_CARRIER_ENABLED = false;

export class MachineProfileError extends Error {}

/** The local owner's socket in a state folder: a path the server never takes from anything but its folder. */
export function ownerSocketPath(stateDir: string): string { return join(stateDir, "serve.sock"); }
const SOCKET_PATH_MAX = 100;
export function machineEngine(stateDir: string, port: number): string {
  const named = process.env["OVIS_RUNTIME"];
  if (named) return named;
  try {
    const saved: unknown = JSON.parse(readFileSync(join(stateDir, `runtime-${port}.json`), "utf8"));
    if (isJsonObject(saved) && typeof saved.runtime === "string") return saved.runtime;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return "herdr";
}

function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

function walkedStateDir(told: string): string {
  const made = mkdirSync(told, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(told);
  const refusal = stateDirRefusal(stateDir);
  if (refusal === null) return stateDir;
  if (made !== undefined) for (let dir = resolve(told); ; dir = dirname(dir)) { rmdirSync(dir); if (dir === resolve(made)) break; }
  throw new MachineProfileError(`The machine profile's state folder is not safe to serve from, so no server was started: ${refusal}`);
}

export function stateDirRefusal(stateDir: string): string | null {
  const stats = statSync(stateDir);
  return trustRefusal(stateDir, profileGroups(), true)
    ?? (stats.uid !== process.getuid?.() ? `${stateDir} belongs to uid ${stats.uid}, not to this account`
      : (stats.mode & 0o7777) !== 0o700 ? `${stateDir} has mode ${(stats.mode & 0o7777).toString(8).padStart(4, "0")}, not 0700` : null);
}

/**
 * A lease per canonical state folder, across checkouts and ports of the machine profile. Never on a
 * folder the ordinary server uses by default, one whose path another account could change, nor one an
 * Ovis's supervisor or an ordinary server started with the same preview holds: a second responder there
 * would answer with that Ovis's relay key. Nothing is written before these are ruled out. The state folder
 * is held exclusively for the life of the process (`serve.own`, which an ordinary server holds shared when
 * it runs with OVIS_PREVIEW=fleet, and not at all without it), and its owner's socket is `serve.sock` in it.
 * The folder is the profile's own: it was empty when the profile first held it and marked it (MARKER), as
 * it holds nothing else. Another server's files there and no mark refuse it: a server without a hold would
 * keep its own copy of the paired devices beside the profile's.
 */
export function claimServerState(told: string | undefined) {
  const own = "name a folder of its own with OVIS_STATE_DIR";
  const { legacy, next } = stateDirNames(process.env);
  if (!told || [legacy, next].some((dir) => canonical(dir) === canonical(told))) {
    throw new MachineProfileError(`The machine profile does not run on a default Ovis state folder, so no server was started; ${own}`);
  }
  const named = ownerSocketPath(canonical(told));
  if (Buffer.byteLength(named) > SOCKET_PATH_MAX) {
    throw new MachineProfileError(`The machine profile's socket ${named} would be longer than ${SOCKET_PATH_MAX} bytes, so no server was started; name a shorter folder with OVIS_STATE_DIR`);
  }
  const stateDir = walkedStateDir(told);
  const updates = join(stateDir, "updates");
  let ids: Dirent[] = [];
  try { ids = readdirSync(updates, { withFileTypes: true }); }
  catch (error) { if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error; }
  for (const id of ids) {
    const holder = id.isDirectory() ? liveOwner(join(updates, id.name, "supervisor.lock")) : null;
    if (holder !== null) throw new MachineProfileError(`An Ovis already runs on this state folder (${holder}), so no second server was started; ${own}`);
  }
  const marker = join(stateDir, MARKER);
  const look = () => {
    const entries = readdirSync(stateDir).filter((name) => name !== "serve.own");
    const marked = entries.includes(MARKER) && markedByProfile(marker);
    return { marked, foreign: !marked && entries.length > 0, wrongMarker: !marked && entries.includes(MARKER) };
  };
  const foreign = (found: ReturnType<typeof look>) => new MachineProfileError(found.wrongMarker
    ? `The state folder's ${marker} is not the machine profile's own, so no server was started; name an empty folder or the profile's own with OVIS_STATE_DIR`
    : `The state folder ${stateDir} holds files that are not the machine profile's and no ${MARKER}, so no server was started; name an empty folder or the profile's own with OVIS_STATE_DIR`);
  const first = look();
  if (first.foreign) throw foreign(first);
  const running = "Another server already owns this Ovis state directory, so no second server was started";
  const hold = join(stateDir, "serve.own");
  const cannotHold = (error: unknown) => new MachineProfileError(`The machine profile cannot hold its state folder, so no server was started (${error instanceof Error ? error.message : String(error)})`);
  let made = false;
  try {
    closeSync(openSync(hold, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    made = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw cannotHold(error);
  }
  let release: () => void;
  try { release = holdForLife(hold, "exclusive"); }
  catch (error) {
    if (error instanceof OwnerGuardBusy) throw new MachineProfileError(`${running} (${hold} is held)`);
    throw cannotHold(error);
  }
  const held = look();
  if (held.foreign) {
    if (made) rmSync(hold, { force: true });
    release();
    throw foreign(held);
  }
  if (!held.marked) writePrivateState(marker, { profile: "machine" });
  const lease = acquireOwnerDirectory(join(stateDir, "serve.lock"), {
    running,
    starting: "Another server is claiming this Ovis state directory, so no second server was started",
  }, {}, { wait: false });
  const socket = ownerSocketPath(stateDir);
  rmSync(socket, { force: true });
  return { stateDir, socket, release: lease.release, listening: (port: number, hostname: string) => lease.amend((lock) => writePrivateState(join(lock, "http.json"), { port, hostname, socket, door: 1 })) };
}

export function machineHerdrBinary(): string {
  const named = process.env["OVIS_HERDR_BIN"];
  if (named) return `herdr binary: ${named} (from OVIS_HERDR_BIN)`;
  return `herdr binary: ${Bun.which("herdr") ?? "herdr, not found"} (from PATH)`;
}

const unsafeSocket = (reason: string | null | undefined) => `The selected herdr socket cannot be used safely by this account${reason ? `: ${reason}` : ""}`;
let engineRefusal: string | null = null;
let pinnedPlace: HerdrSocketPlace | null = null;
let rediscovery: (() => Promise<string | null>) | null = null;
let rediscovering: Promise<void> | null = null;

export async function machineSocket(stateDir: string, engine: string): Promise<string | null> {
  engineRefusal = await selectSocket(stateDir, engine);
  return engineRefusal;
}

export async function machineSocketRefusal(): Promise<string | null> {
  if (rediscovery) await (rediscovering ??= rediscovery().then((found) => { engineRefusal = found; }).finally(() => { rediscovering = null; }));
  return engineRefusal;
}

async function selectSocket(stateDir: string, engine: string): Promise<string | null> {
  const unavailable = join(stateDir, "unavailable", "herdr.sock");
  if (engine !== "herdr") { process.env["HERDR_SOCKET"] = unavailable; return `${engine} is not supported for a machine yet`; }
  const named = process.env["HERDR_REMOTE_SESSION"];
  const socket = process.env["HERDR_REMOTE_SOCKET"];
  let selected = socket || (named ? join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr", "sessions", named, "herdr.sock") : process.env["HERDR_SOCKET"]);
  process.env["HERDR_SOCKET"] = unavailable;
  if (named && !/^[A-Za-z0-9_-]{1,64}$/.test(named)) return "HERDR_REMOTE_SESSION must name a herdr session";
  if (selected && !validHerdrSocket(selected)) return `${socket ? "HERDR_REMOTE_SOCKET" : named ? "HERDR_REMOTE_SESSION" : "HERDR_SOCKET"} must be an absolute path ending in /herdr.sock`;
  return selected ? pinned(selected, unavailable) : discovered(unavailable);
}

async function discovered(unavailable: string): Promise<string | null> {
  const { sessions: found, refused } = await discoverPinnableHerdrSessions();
  const refusal = found.length === 1 ? await pinned(found[0]!.socket_path, unavailable)
    : found.length > 1 ? "Several herdr sessions are running; select one with HERDR_REMOTE_SOCKET"
      : refused !== null ? unsafeSocket(refused) : "herdr is not running for the selected session";
  rediscovery = refusal === null ? null : () => discovered(unavailable);
  return refusal;
}

async function pinned(selected: string, unavailable: string): Promise<string | null> {
  const { status, place, reason } = await pinnedHerdrSocketStatus(selected);
  if (status === "refused") return unsafeSocket(reason);
  pinnedPlace = place;
  checkHerdrSockets((path) => heldHerdrSocketStatus(path, place) === "usable" ? path : unavailable);
  process.env["HERDR_SOCKET"] = selected;
  return null;
}

/** Readiness is separate from the HTTP server's liveness and is only sent after authentication. `refusal`: why the engine serve() chose is down, null while it answers. */
export async function machineHealth(engine: string, refusal: string | null = engine === "herdr" ? null : `${engine} is not supported for a machine yet`) {
  let reason = refusal;
  let herdr: Awaited<ReturnType<typeof ping>> | undefined;
  if (reason === null) {
    try {
      herdr = await ping(herdrSocketPath(), 1500);
      if (herdr.protocol < 22) reason = "herdr protocol 22 or newer is required; update herdr explicitly";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const path = herdrSocketPath();
      reason = pinnedPlace && heldHerdrSocketStatus(path, pinnedPlace) === "refused" ? unsafeSocket(pinnedPlace.walk(dirname(path))) : `${engine} is not running for the selected session`;
    }
  }
  return { machine_profile: { engine, runtime_down: reason !== null, reason }, ...(herdr ? { herdr } : {}) };
}

const READ_FAILED = "herdr did not answer this request";
const READ_FAILED_CODE = "herdr_error";

const KEPT_HERDR_CODES: ReadonlySet<string> = new Set(["pane_not_found", "stale_content", "agent_blocked", "agent_not_ready", "not_git_worktree", "invalid_request"]);

const KEPT_LAYOUT_REASONS: ReadonlySet<string> = new Set(["same_pane", "cross_tab", "not_found", "no_neighbor", "zoomed_tab", "unchanged"]);
export const machineLayoutReason = (reason: string): string => KEPT_LAYOUT_REASONS.has(reason) ? reason : READ_FAILED_CODE;

const NOT_RESTORED = "herdr could not restore this pane after it restarted";

export function machineSnapshot<S extends Pick<SessionSnapshot, "panes">>(snapshot: S): S {
  if (!snapshot.panes.some((pane) => pane.restore_error)) return snapshot;
  return { ...snapshot, panes: snapshot.panes.map((pane) => pane.restore_error ? { ...pane, restore_error: NOT_RESTORED } : pane) };
}

export function machineFailure(error: HerdrError, reason: string | null = null): { code: string; message: string } {
  return { code: error.fromReply && !KEPT_HERDR_CODES.has(error.code) ? READ_FAILED_CODE : error.code,
    message: reason ?? (error.code === "pane_not_restored" ? NOT_RESTORED : error.outcome ?? READ_FAILED) };
}

export async function machineReadError(error: unknown, engine: string, refusal: string | null | undefined): Promise<Response> {
  const answer = errorResponse(error);
  if (!(error instanceof HerdrError)) return answer;
  const reason = (await machineHealth(engine, refusal)).machine_profile.reason;
  const { code, message } = machineFailure(error, reason);
  return jsonResponse({ error: { code, message } }, answer.status, { "cache-control": "no-store" });
}

export function machineRouteRestricted(path: string, method: string): boolean {
  if (path === "/api/machines" && method === "GET") return false;
  return /^\/api\/(?:herdr\/update$|runtime(?:\/|$)|portal(?:\/|$)|fleet(?:\/|$)|machines(?:\/|$)|bridge$|devices\/pair$)/.test(path)
    || path === "/api/relay/direct" && !MACHINE_DIRECT_CARRIER_ENABLED;
}

/**
 * GET /api/machines: this machine alone, as an ordinary server lists its own PC (server/machines.ts list()), so the app's
 * PC list, and the terminals it draws from it, read here what they read everywhere else. Its name is the machine's host
 * name, as that server and the pairing offer give it; while its engine is down it is listed with the reason its health
 * gives (`refusal` as health is handed it) and no terminals. A read that fails while the engine answers is that read's
 * failure, thrown and answered as /api/session answers it (machineReadError), so the app keeps the list it has.
 * `?verify_source_boot=local` proves this server's own boot, as the manager proves its local PC's
 * (src/lib/workspaceOrder.ts asks it after a move).
 */
export async function machineRoster(url: URL, read: () => Promise<SessionSnapshot>, ids: { bootId: string; serverId: string | undefined },
  engine: string, refusal: string | null | undefined): Promise<MachineRoster> {
  const machine: Machine = { id: LOCAL_MACHINE, name: hostname(), kind: "local", enabled: true, state: "connected", error: null, snapshot: null,
    source_boot_id: ids.bootId, ...(ids.serverId ? { server_id: ids.serverId } : {}) };
  try { machine.snapshot = await read(); }
  catch (error) {
    const reason = error instanceof HerdrError ? (await machineHealth(engine, refusal)).machine_profile.reason : null;
    if (reason === null) throw error;
    machine.state = "error";
    machine.error = reason;
  }
  const asked = url.searchParams.getAll("verify_source_boot");
  return { machines: [machine], ...(asked.length === 1 && asked[0] === LOCAL_MACHINE ? { verified_source_boot: { machine_id: LOCAL_MACHINE, boot_id: ids.bootId } } : {}) };
}

export function machineUnauthorized(pathname: string): Response {
  setRequestRoute("auth-refusal");
  return pathname === "/ws" ? new Response("unauthorized", { status: 401 })
    : jsonResponse({ error: { code: "unauthorized", message: "This machine's server answers its owner on its socket, and devices through the relay" } }, 401);
}

/**
 * The profile's TCP port, for every caller and whatever the request carries (a token, a cookie, a forwarding
 * or identity header): its liveness at /api/health, 401 for every other API call and the terminal socket, and
 * nothing else.
 */
export function machineTcpAnswer(request: Request, pathname: string): Response {
  if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
    setRequestRoute(pathname);
    return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/ws" || pathname.startsWith("/api/")) return machineUnauthorized(pathname);
  setRequestRoute("not-found");
  return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
}
