/**
 * What Tailscale on this PC can already do for a phone: `tailscale status --json` and
 * `tailscale serve status --json`. The Settings → Phone panel turns the answer into the address that already works.
 * Two changes are made, each only when this PC's own window asks (dispatch.ts): `serveTailscale` runs the one
 * `tailscale serve` for this server's port on a free allowed HTTPS port, and `openTailscaleApp` opens the Tailscale
 * app so its owner can turn it on and sign in. Nothing runs `up`, and no serve config for another port is touched.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RemoteAccess, TailscaleAccess } from "../shared/protocol.ts";
import { addressesNode } from "./access.ts";

const TIMEOUT_MS = 2500;
/** the macOS App Store build puts no `tailscale` on the PATH; its CLI lives in the app bundle */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const HTTPS_PORTS: readonly number[] = [443, 8443, 7317, 17317];
export const HTTPS_PORT_VARIABLE = "OVIS_TAILSCALE_HTTPS_PORT";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface TailscaleOutput {
  status: string | null;
  serve: string | null;
}

interface NodeJson { DNSName?: string; UserID?: number | string; TailscaleIPs?: string[]; Tags?: string[] }
interface StatusJson { BackendState?: string; Self?: NodeJson; Peer?: Record<string, NodeJson>; User?: Record<string, { LoginName?: string }> }
interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  /** "host:port" -> handlers by path */
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  /** "host:port" -> true for a listener Tailscale Funnel opens to the public internet */
  AllowFunnel?: Record<string, boolean>;
  /** the listeners a foreground `tailscale serve` session holds while it runs, by session */
  Foreground?: Record<string, ServeJson>;
}

const NONE: TailscaleAccess = { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null };

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** Whether `text` is JSON at all: `null` is, and is what a node that serves nothing may print. */
function isJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * `tailscale status --json` with every `UserID` kept as the digits written. Tailscale's user ids
 * pass 2^53, so as a double an id stops matching its key in `User`, and two ids can become one.
 */
function parseStatus(status: string | null): StatusJson | null {
  return parseJson<StatusJson>(status === null ? null : status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"'));
}

function proxiesTo(target: string | undefined, port: number): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return LOOPBACK.has(url.hostname) && targetPort === port && (url.pathname === "" || url.pathname === "/");
  } catch { return false; }
}

function httpsUrl(host: string, port: number): string {
  return `https://${host}${port === 443 ? "" : `:${port}`}`;
}

/**
 * The HTTPS ports a new `tailscale serve` may take, in order: the usual ones while the variable is
 * unset, only the port it names when it is set, and none when it names no port. A port the user
 * chose is never traded for another, since a phone's installed app stays on the address it was
 * installed from.
 */
export function httpsPorts(value: string | undefined): readonly number[] {
  const text = value?.trim() ?? "";
  if (text === "") return HTTPS_PORTS;
  const port = /^\d+$/.test(text) ? Number(text) : 0;
  return port >= 1 && port <= 65535 ? [port] : [];
}

export function parseTailscale(output: TailscaleOutput | null, port: number, candidates: readonly number[] = HTTPS_PORTS): TailscaleAccess {
  return readServe(output, port, candidates).access;
}

/** `parseTailscale`'s answer and the free allowed HTTPS port its command names (null when it names none). */
function readServe(output: TailscaleOutput | null, port: number, candidates: readonly number[]): { access: TailscaleAccess; free: number | null; known: boolean } {
  if (output === null) return { access: NONE, free: null, known: false };
  const status = parseJson<StatusJson>(output.status);
  if (status === null || status.BackendState !== "Running") return { access: { ...NONE, state: "stopped" }, free: null, known: false };
  const dns = parseNodeName(output.status);
  const serve = parseJson<ServeJson>(output.serve);
  // a foreground session's listeners are taken too, though they end with it
  const listeners = [serve?.TCP, ...Object.values(serve?.Foreground ?? {}).map((session) => session.TCP)];
  const taken = new Set(listeners.flatMap((tcp) => Object.keys(tcp ?? {})).map(Number).filter(Number.isFinite));
  let servingUrl: string | null = null;
  for (const [hostPort, site] of Object.entries(serve?.Web ?? {})) {
    const separator = hostPort.lastIndexOf(":");
    const host = hostPort.slice(0, separator);
    const webPort = Number(hostPort.slice(separator + 1));
    // an HTTP listener is no use to a phone: it can neither install the app nor receive alerts
    if (!serve?.TCP?.[String(webPort)]?.HTTPS) continue;
    // a Funnel listener is public, not the tailnet-only address asked for: its port stays taken, nothing is reported
    if (serve.AllowFunnel?.[hostPort] === true) continue;
    if (proxiesTo(site.Handlers?.["/"]?.Proxy, port)) { servingUrl = httpsUrl(host, webPort); break; }
  }
  const free = servingUrl === null ? candidates.find((candidate) => !taken.has(candidate)) ?? null : null;
  return {
    free,
    // whether the serve status was read at all: only then are the taken ports known. A command that succeeded with
    // JSON was read, `null` or `{}` included (nothing served); only a failed command or output that is no JSON was not
    known: output.serve !== null && isJson(output.serve),
    access: {
      state: "running",
      dns_name: dns,
      serving_url: servingUrl,
      serve_command: free === null ? null : `tailscale serve --bg --https=${free} http://127.0.0.1:${port}`,
      serve_url: free === null || dns === null ? null : httpsUrl(dns, free),
    },
  };
}

export function tailscaleBinary(): string | null {
  return Bun.which("tailscale") ?? (existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
}

async function run(binary: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn([binary, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readTailscale(binary: string | null = tailscaleBinary()): Promise<TailscaleOutput | null> {
  if (binary === null) return null;
  const [status, serve] = await Promise.all([run(binary, ["status", "--json"]), run(binary, ["serve", "status", "--json"])]);
  return { status, serve };
}

export async function remoteAccess(port: number, candidates: readonly number[] = httpsPorts(process.env[HTTPS_PORT_VARIABLE]), binary: string | null = tailscaleBinary()): Promise<RemoteAccess> {
  return { port, platform: process.platform, tailscale: parseTailscale(await readTailscale(binary), port, candidates) };
}

const SERVE_TIMEOUT_MS = 15_000;

export type TailscaleChange =
  | { readonly ok: true; readonly access: RemoteAccess }
  | {
    readonly ok: false;
    readonly code: "tailscale_missing" | "tailscale_not_running" | "tailscale_no_port" | "tailscale_serve_refused" | "tailscale_app_unavailable";
    /** the first line the CLI wrote, for the server's log only */
    readonly detail?: string;
    /** Linux refused for want of operator rights: `sudo tailscale set --operator=$USER` once lets this user serve */
    readonly operator?: boolean;
  };

const firstLine = (text: string): string => text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";

/**
 * Serves this server on the tailnet: reads Tailscale again and, only while it runs and serves nothing for `port`,
 * runs `<tailscale> serve --bg --https=<free> http://127.0.0.1:<port>` on the first free port `candidates` allows
 * (never another), as an argument array with no shell and a deadline, then reads again and answers what it serves.
 * Already served, it answers at once and runs nothing.
 */
export async function serveTailscale(port: number, candidates: readonly number[] = httpsPorts(process.env[HTTPS_PORT_VARIABLE]),
  binary: string | null = tailscaleBinary(), platform: NodeJS.Platform = process.platform): Promise<TailscaleChange> {
  if (binary === null) return { ok: false, code: "tailscale_missing" };
  const before = readServe(await readTailscale(binary), port, candidates);
  if (before.access.state !== "running") return { ok: false, code: "tailscale_not_running" };
  if (before.access.serving_url !== null) return { ok: true, access: { port, platform, tailscale: before.access } };
  // a port is only taken when it is shown free: a serve status that could not be read changes nothing
  if (!before.known) return { ok: false, code: "tailscale_serve_refused", detail: "tailscale serve status could not be read" };
  if (before.free === null) return { ok: false, code: "tailscale_no_port" };
  const proc = Bun.spawn([binary, "serve", "--bg", `--https=${before.free}`, `http://127.0.0.1:${port}`], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), SERVE_TIMEOUT_MS);
  let code: number;
  let said: string;
  try {
    const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    code = exit;
    said = firstLine(err) || firstLine(out);
  } finally {
    clearTimeout(timer);
  }
  const refused = (detail: string): TailscaleChange => ({
    ok: false, code: "tailscale_serve_refused", detail,
    operator: platform === "linux" && /access denied|permission|operator|root/i.test(detail),
  });
  if (code !== 0) return refused(said || `exit ${code}`);
  const after = parseTailscale(await readTailscale(binary), port, candidates);
  if (after.serving_url === null) return refused(said || "serve ran but serves no address for this port");
  return { ok: true, access: { port, platform, tailscale: after } };
}

/** How this PC opens its Tailscale app, as an argument array; null where it has none to open (Linux has no app of Tailscale's). */
export function tailscaleAppCommand(platform: NodeJS.Platform, env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync): string[] | null {
  if (platform === "darwin") return ["open", "-a", "Tailscale"];
  if (platform !== "win32") return null;
  const gui = join(env["ProgramFiles"] ?? "C:\\Program Files", "Tailscale", "tailscale-ipn.exe");
  return exists(gui) ? [gui] : null;
}

/** Opens the Tailscale app on this PC, where it has one, and does not wait for it: its owner turns it on and signs in there. */
export function openTailscaleApp(platform: NodeJS.Platform = process.platform): { ok: true } | { ok: false; code: "tailscale_app_unavailable"; detail?: string } {
  const command = tailscaleAppCommand(platform);
  if (command === null) return { ok: false, code: "tailscale_app_unavailable" };
  try {
    Bun.spawn(command, { windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "tailscale_app_unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** A tagged node belongs to no person: its `User` entry is the node itself, named by its MagicDNS name. */
export function isTaggedNode(status: string | null): boolean {
  return (parseJson<StatusJson>(status)?.Self?.Tags?.length ?? 0) > 0;
}

/** The login this PC's Tailscale node belongs to, from `tailscale status --json`; null when it does not say, or the node is tagged. */
export function parseTailscaleOwner(status: string | null): string | null {
  const parsed = parseStatus(status);
  const id = parsed?.Self?.UserID;
  if (id === undefined || id === null || isTaggedNode(status)) return null;
  return parsed?.User?.[String(id)]?.LoginName || null;
}

/**
 * The one login `tailscale status --json` proves owns every node of this tailnet, with none of them
 * tagged, or null. A tagged node is the one case `tailscale serve` deliberately states no person
 * for, and a tailnet can hold many of those, which is why a proxied request with no login is
 * otherwise a stranger. Where Tailscale says there is no tagged node and no second login, the
 * owner's own devices are all a tailnet request can come from. A second login, a single tag
 * anywhere, a node whose owner the status does not name, or a status it could not read answer
 * null: the proof has to be positive, never the benefit of the doubt.
 */
export function parseSoleTailnetLogin(status: string | null): string | null {
  return readSoleLogin(status).login;
}

/**
 * `parseSoleTailnetLogin`'s proof together with what the status settles for good: a Running status
 * that names this PC's user states whether one login owns the tailnet - the login above, or a tag
 * or a second login against it. A daemon still coming up, a status that names no user for this
 * PC, or one that names no login for a tailnet it would prove, leaves the question open instead.
 */
function readSoleLogin(status: string | null): { login: string | null; settled: boolean } {
  // "every node" is every node this PC's Tailscale lists: a node an ACL hides is not in its network map
  const parsed = parseStatus(status);
  if (parsed === null || parsed.BackendState !== "Running") return { login: null, settled: false };
  const self = parsed.Self;
  if (self === undefined || self.UserID === undefined || self.UserID === null) return { login: null, settled: false };
  const owner = self.UserID;
  // offline peers count: they are nodes of this tailnet and can come back at any moment
  const nodes: NodeJson[] = [self, ...Object.values(parsed.Peer ?? {})];
  const sole = nodes.every((node) => (node.Tags?.length ?? 0) === 0
    && node.UserID !== undefined && node.UserID !== null && String(node.UserID) === String(owner));
  if (!sole) return { login: null, settled: true };
  const login = parsed.User?.[String(owner)]?.LoginName || null;
  return { login, settled: login !== null };
}

/** This PC's IPv4 address on the tailnet (100.x.y.z), from `tailscale status --json`; null when it has none. */
export function parseTailscaleIp(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
}

/** This PC's MagicDNS name from `tailscale status --json`, without its trailing dot; null when it has none. */
export function parseNodeName(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.DNSName?.replace(/\.$/, "") || null;
}

export interface TailnetIdentity {
  owner: string | null;
  tagged: boolean;
  soleLogin: string | null;
  dnsName: string | null;
  tailnetIp: string | null;
}

const OWNER_TTL_MS = 5 * 60_000;
/** how soon a request stating a login may read the status again while this PC's own login is unknown */
const LOGIN_RETRY_MS = 2_000;

const cliStatus = async (): Promise<string | null> => {
  const binary = tailscaleBinary();
  return binary === null ? null : run(binary, ["status", "--json"]);
};

/**
 * The WhoIs a source without a reader of its own asks: the tailscale CLI. Under bun test the preload replaces `read` with
 * one that answers nothing (scripts/test-herdr.ts), so no test asks the real tailscaled; a test that needs an answer
 * passes its own reader.
 */
export const tailscaleWhois = {
  read: async (address: string): Promise<string | null> => {
    const binary = tailscaleBinary();
    return binary === null ? null : run(binary, ["whois", "--json", address]);
  },
};

/**
 * The tailnet node a request came from, by `tailscale whois`: `id` is its StableNodeID, which survives a node key's
 * rotation (the node key does not) and is what a block names; `hostname` is for display only.
 */
export interface TailnetNode { readonly id: string; readonly hostname: string; readonly login: string | null }

export const STABLE_NODE_ID = /^[A-Za-z0-9]{1,64}$/;

interface WhoisJson { Node?: { StableID?: string; Name?: string; ComputedName?: string; Hostinfo?: { Hostname?: string } }; UserProfile?: { LoginName?: string } }

/** `tailscale whois --json <address>`'s node, or null when it names no StableID this PC can keep. */
export function parseWhois(text: string | null): TailnetNode | null {
  const whois = parseJson<WhoisJson>(text);
  const node = whois?.Node;
  const id = node?.StableID;
  if (typeof id !== "string" || !STABLE_NODE_ID.test(id)) return null;
  const name = node?.ComputedName || node?.Hostinfo?.Hostname || node?.Name?.replace(/\.$/, "").split(".")[0] || id;
  const login = whois?.UserProfile?.LoginName;
  return { id, hostname: name.slice(0, 64), login: typeof login === "string" && login !== "" ? login : null };
}

/** how long a tailnet address is taken to stay the same node */
const WHOIS_TTL_MS = 60_000;
/** how long a WhoIs that named nothing is not asked again, so a broken CLI is not spawned once per request */
const WHOIS_FAILED_MS = 5_000;

/**
 * What `tailscale status --json` says about this PC and its tailnet, read through `readStatus` and
 * kept five minutes. `identity` answers every reader that does not grant from the cache, refreshing
 * a stale value in the background, so those readers never wait on the tailscale CLI; the first
 * lookup is what `createServer` starts. `freshIdentity` is the owner's grant path, the one reader
 * that waits for a read, shared with any read already in flight.
 */
export class TailnetIdentitySource {
  /**
   * the last read's answer and when it landed; null until the first read lands. `ownerKnown`: a
   * Running status named this PC's login, or that its node is tagged and has none
   */
  private cache: (TailnetIdentity & { at: number; settled: boolean; ownerKnown: boolean }) | null = null;
  private reading: Promise<void> | null = null;

  private readonly nodes = new Map<string, { node: TailnetNode | null; at: number }>();
  private readonly asking = new Map<string, Promise<TailnetNode | null>>();

  constructor(private readonly readStatus: () => Promise<string | null> = cliStatus,
    private readonly readWhois: (address: string) => Promise<string | null> = (address) => tailscaleWhois.read(address)) {}

  /**
   * The node behind one tailnet address (`tailscale whois`), kept a minute; a read that names nothing is kept five
   * seconds, so a broken CLI is not spawned per request. Reads of one address share the one in flight.
   */
  async node(address: string): Promise<TailnetNode | null> {
    const kept = this.nodes.get(address);
    if (kept !== undefined && Date.now() - kept.at < (kept.node === null ? WHOIS_FAILED_MS : WHOIS_TTL_MS)) return kept.node;
    let reading = this.asking.get(address);
    if (reading === undefined) {
      reading = this.readWhois(address).then(parseWhois, () => null).finally(() => this.asking.delete(address));
      this.asking.set(address, reading);
    }
    const node = await reading;
    this.nodes.set(address, { node, at: Date.now() });
    return node;
  }

  /**
   * A read that failed, or one whose status leaves the sole-login question open, keeps what the
   * last read said about this PC, withdraws the sole-login proof, and marks the cache unsettled,
   * so the next grant-path request reads again at once instead of waiting out the TTL. A status
   * that states the answer for good - one login's tailnet, or a tag or a second login against it
   * - stands for the TTL. Readers that do not grant keep the TTL as before.
   */
  private async read(): Promise<void> {
    const status = await this.readStatus();
    if (status === null) {
      this.cache = {
        owner: this.cache?.owner ?? null,
        tagged: this.cache?.tagged ?? false,
        soleLogin: null,
        dnsName: this.cache?.dnsName ?? null,
        tailnetIp: this.cache?.tailnetIp ?? null,
        settled: false,
        ownerKnown: this.cache?.ownerKnown ?? false,
        at: Date.now(),
      };
      return;
    }
    const sole = readSoleLogin(status);
    // a daemon that is not Running proves nothing about whose PC this is: the login a Running one named is
    // kept, else the one this status names is used; either stays unconfirmed, so a login request reads again
    // (`loginIdentity`)
    const running = parseStatus(status)?.BackendState === "Running";
    const kept = !running && this.cache !== null && (this.cache.owner !== null || this.cache.tagged) ? this.cache : null;
    const owner = kept ? kept.owner : parseTailscaleOwner(status);
    const tagged = kept ? kept.tagged : isTaggedNode(status);
    this.cache = {
      owner,
      tagged,
      soleLogin: sole.login,
      dnsName: parseNodeName(status),
      tailnetIp: parseTailscaleIp(status),
      settled: sole.settled,
      ownerKnown: running && (owner !== null || tagged),
      at: Date.now(),
    };
  }

  private refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => { this.reading = null; });
    return this.reading;
  }

  /**
   * The PC's own Tailscale login, or that its node is tagged and has none, and the one login that
   * owns this whole tailnet (`parseSoleTailnetLogin`), cached five minutes. A stale value is
   * answered at once and refreshed in the background.
   */
  identity(): TailnetIdentity {
    if (this.cache === null || Date.now() - this.cache.at >= OWNER_TTL_MS) void this.refresh();
    return {
      owner: this.cache?.owner ?? null,
      tagged: this.cache?.tagged ?? false,
      soleLogin: this.cache?.soleLogin ?? null,
      dnsName: this.cache?.dnsName ?? null,
      tailnetIp: this.cache?.tailnetIp ?? null,
    };
  }

  /**
   * `identity` for a request that states a Tailscale login. Until a read has named this PC's own
   * login (or found its node tagged), this waits for a read, shared and bounded like
   * `freshIdentity`: a server started at boot asks before tailscaled has logged in, and that
   * answer must not stand for five minutes against the owner's own devices. A new read starts at
   * most every `LOGIN_RETRY_MS`, so requests cannot keep the tailscale CLI spawning.
   */
  async loginIdentity(): Promise<TailnetIdentity> {
    if (this.cache !== null && this.cache.ownerKnown) return this.identity();
    if (this.reading === null && this.cache !== null && Date.now() - this.cache.at < LOGIN_RETRY_MS) return this.identity();
    await this.refresh();
    return this.identity();
  }

  /**
   * `identity` for a request the owner's sole-login proof would admit. A cache that already says
   * a node is tagged, that the tailnet is not one login's, or that this Host is not this PC's name
   * answers at once and grants nothing. Otherwise this waits for one status read, shared with any
   * read in flight and bounded by the read's own timeout, so the grant never rests on a warm cache.
   * A read that fails, or leaves the question open, grants nothing and is read again next request.
   */
  async freshIdentity(host: string | null): Promise<TailnetIdentity> {
    const cached = this.identity();
    if (this.cache !== null && this.cache.settled && (this.cache.soleLogin === null || !addressesNode({ host, dnsName: this.cache.dnsName, tailnetIp: this.cache.tailnetIp }))) return cached;
    await this.refresh();
    return this.identity();
  }
}
