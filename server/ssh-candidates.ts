/**
 * Settings → Devices and PCs → Add a connection → SSH: the PCs this PC's server could reach over SSH, for one
 * tap to open Add PC with the address filled in. Two sources, both read only, neither connected to:
 * the hosts named in its own account's ssh config, and the other PCs of its own Tailscale login (reached by
 * their MagicDNS name, over SSH like any other address, never through the relay).
 */
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { canonicalIp, lookupDeadline, RESOLVE_TIMEOUT_MS, resolveWithin, systemResolve } from "./ssh-lookup.ts";
import { readTailscaleStatus, tailnetPeers } from "./tailnet-pcs.ts";

/** an ssh config is a few kilobytes; past this it is not read on */
const MAX_FILE_BYTES = 256 * 1024;
/** Include may nest; ssh itself stops at 16 */
const MAX_INCLUDE_DEPTH = 4;
/** files every Include of one config together reads at most */
const MAX_INCLUDED_FILES = 64;
/** bytes every Include of one config together reads at most */
const MAX_INCLUDED_BYTES = 1024 * 1024;
/** hosts listed at most, so a generated config costs a bounded list */
const MAX_HOSTS = 200;
/** the options ssh takes from the first block that applies to a host, whichever block sets them */
const EFFECTIVE_KEYS = new Set(["hostname", "addressfamily", "proxycommand", "proxyjump"]);

export interface SshCandidate {
  /** the Host alias, or the Tailscale machine name */
  name: string;
  /** what Add PC connects to: the alias itself (ssh resolves it through the config), or the MagicDNS name */
  destination: string;
  /** user@hostname as the config resolves it, or the MagicDNS name; null when the alias says nothing more */
  detail: string | null;
  source: "ssh_config" | "tailscale";
  /** the MagicDNS name of the PC of this PC's Tailscale login it is, when it is one (a config host may name one) */
  tailnet?: string;
}

export interface SshCandidatesOptions {
  /** the folder holding `config`; `~/.ssh` of the server's own account by default */
  sshDir?: string;
  /** the folder `~` stands for, and with `sshDir` the only one an Include may read in; the server account's own by default */
  home?: string;
  /** `tailscale status --json`; null when Tailscale is not here */
  readStatus?: () => Promise<string | null>;
  /** the addresses a host name resolves to, as ssh would reach it (getaddrinfo: hosts file, DNS, MagicDNS) */
  resolve?: (host: string) => Promise<string[]>;
  /** how long the list waits on `resolve` for every name together */
  resolveTimeoutMs?: number;
  /** the clock a name's answer is kept by; `Date.now` by default */
  now?: () => number;
  /** settles when one running lookup has waited long enough; 1.5 s by default */
  lookupDeadline?: () => Promise<void>;
}

/** a host an ssh config names, with what ssh would use for it */
export interface ConfigHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  /** the AddressFamily ssh connects over, when it is not `any` */
  addressFamily?: "inet" | "inet6";
  /** set when ssh goes through a ProxyCommand or ProxyJump, so the name is resolved at the far end, not here */
  proxied?: true;
}

/**
 * Whether `text` matches an ssh Host pattern (`*` any run, `?` one character), in lowercase as ssh compares host
 * names. One pass that steps back only to the last `*`: a RegExp built from `*a*a*a…b` backtracks for seconds on a
 * long alias and would hold the server.
 */
function globMatch(pattern: string, text: string): boolean {
  const glob = pattern.toLowerCase();
  const name = text.toLowerCase();
  let at = 0;
  let next = 0;
  let star = -1;
  let resume = 0;
  while (at < name.length) {
    if (next < glob.length && (glob[next] === "?" || glob[next] === name[at])) { at += 1; next += 1; }
    else if (next < glob.length && glob[next] === "*") { star = next; next += 1; resume = at; }
    else if (star >= 0) { next = star + 1; resume += 1; at = resume; }
    else return false;
  }
  while (next < glob.length && glob[next] === "*") next += 1;
  return next === glob.length;
}

/** a Host pattern that names one host, not a set of them */
const plainAlias = (pattern: string): boolean => pattern !== "" && !/[*?!]/.test(pattern);

/**
 * `Key value`, `Key=value` and `Key "quoted value"`, as ssh reads a line, up to a word that starts a comment
 * (`Host lab # work` names `lab` alone); null for a blank line or a comment
 */
function keyword(line: string): { key: string; values: string[] } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (match === null) return null;
  const values: string[] = [];
  for (const part of match[2]!.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (part[2]?.startsWith("#")) break;
    values.push(part[1] ?? part[2]!);
  }
  return { key: match[1]!.toLowerCase(), values };
}

/** a Host block; `within` is the block an Include sat in when this one came from the included file */
interface HostBlock { patterns: string[]; aliases: string[]; user?: string; within?: HostBlock }

/**
 * Whether a Host line applies to `alias`: one of its patterns matches and none of its negated ones does, and the Host
 * block of the Include that brought it in applies too, as ssh reads an included file only for the hosts that block
 * matches
 */
const appliesTo = ({ patterns, within }: HostBlock, alias: string): boolean =>
  patterns.some((pattern) => !pattern.startsWith("!") && globMatch(pattern, alias)) &&
  !patterns.some((pattern) => pattern.startsWith("!") && globMatch(pattern.slice(1), alias)) &&
  (within === undefined || appliesTo(within, alias));

/**
 * The hosts an ssh config names, in its order, with what ssh would use for each: the HostName, AddressFamily and
 * proxy the first block that applies to it sets (a later `Host *` included, `%h` standing for the alias), and the
 * first User its own block sets. Hosts named only by a pattern (`*`, `?`, `!`) and everything under Match are left
 * out; a later block repeating an alias adds nothing. `include(pattern)` reads the files an Include names, as text,
 * in their order.
 */
export async function sshConfigHosts(text: string, include: (pattern: string) => Promise<string[]> = async () => []): Promise<ConfigHost[]> {
  const blocks: HostBlock[] = [];
  // lines before the first Host apply to every host, as in ssh
  let current: HostBlock | null = { patterns: ["*"], aliases: [] };
  const settings: { block: HostBlock; key: string; value: string }[] = [];
  let inMatch = false;
  const walk = async (text: string, depth: number, within?: HostBlock): Promise<void> => {
    for (const line of text.split(/\r?\n/)) {
      const parsed = keyword(line);
      if (parsed === null) continue;
      if (parsed.key === "host") {
        inMatch = false;
        // `Host valid server-*` still names `valid`; a negated pattern on the line leaves out each alias it matches
        // (`Host web01 !web*` names nothing), as ssh never applies the block to that host
        const negated = parsed.values.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
        current = { patterns: parsed.values, aliases: parsed.values.filter((value) => plainAlias(value) && !negated.some((pattern) => globMatch(pattern, value))), within };
        blocks.push(current);
      } else if (parsed.key === "match") {
        inMatch = true;
        current = null;
      } else if (parsed.key === "include" && depth < MAX_INCLUDE_DEPTH && !inMatch) {
        // as ssh reads it: an included file goes on in the Host block the Include sits in (its HostName and User
        // before a Host line of its own are that block's), and the including file's block goes on after it
        const [outer, outerMatch] = [current, inMatch];
        for (const pattern of parsed.values) {
          // each file starts in the Include's own block: a Host line in one file does not carry into the next
          for (const included of await include(pattern)) {
            [current, inMatch] = [outer, outerMatch];
            await walk(included, depth + 1, outer ?? undefined);
          }
        }
        [current, inMatch] = [outer, outerMatch];
      } else if (current !== null && !inMatch) {
        if (EFFECTIVE_KEYS.has(parsed.key) && parsed.values[0] !== undefined) settings.push({ block: current, key: parsed.key, value: parsed.values[0] });
        if (parsed.key === "user" && current.user === undefined) current.user = parsed.values[0];
      }
    }
  };
  await walk(text, 0);
  const seen = new Set<string>();
  const hosts: ConfigHost[] = [];
  for (const block of blocks) {
    for (const alias of block.aliases) {
      // the list stops at its limit, so a huge config costs its HostName lines once per listed host at most
      if (hosts.length >= MAX_HOSTS) return hosts;
      if (seen.has(alias)) continue;
      seen.add(alias);
      const effective = new Map<string, string>();
      for (const line of settings) if (!effective.has(line.key) && appliesTo(line.block, alias)) effective.set(line.key, line.value);
      const hostname = effective.get("hostname")?.replace(/%([%h])/g, (_, token: string) => token === "h" ? alias : "%");
      const family = effective.get("addressfamily")?.toLowerCase();
      const proxied = ["proxycommand", "proxyjump"].some((key) => (effective.get(key) ?? "none").toLowerCase() !== "none");
      hosts.push({
        alias, hostname: hostname ?? null, user: block.user ?? null,
        ...(family === "inet" || family === "inet6" ? { addressFamily: family } : {}), ...(proxied ? { proxied: true as const } : {}),
      });
    }
  }
  return hosts;
}

/**
 * A regular file's text when it is at most `cap` bytes; null for anything else (a FIFO, a device, a folder, a larger
 * file, an error). Opened without blocking and checked on the open handle, so a FIFO never holds the list and
 * `/dev/zero` is never read.
 */
async function readCapped(path: string, cap: number): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > cap) return null;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return null; } finally { await handle?.close(); }
}

const inside = (path: string, root: string): boolean => {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

/**
 * The files an Include pattern names: relative to `sshDir` as ssh reads the user config, `~` for the home folder.
 * Only files that really are inside the home or ssh folder are read (after links and `..`), since their hosts reach
 * the response; and every Include of one config shares one budget of files and bytes.
 */
function includer(sshDir: string, home: string): (pattern: string) => Promise<string[]> {
  const roots = Promise.all([sshDir, home].map((root) => realpath(root).catch(() => null)));
  const budget = { files: MAX_INCLUDED_FILES, bytes: MAX_INCLUDED_BYTES };
  return async (pattern) => {
    if (budget.files <= 0 || budget.bytes <= 0) return [];
    const allowed = (await roots).filter((root): root is string => root !== null);
    // ssh's glob(3) has no `**`: it is one `*`, which also keeps a scan to the pattern's own depth
    const expanded = (pattern.startsWith("~/") ? join(home, pattern.slice(2)) : isAbsolute(pattern) ? pattern : join(sshDir, pattern)).replace(/\*{2,}/g, "*");
    const paths: string[] = [];
    const wildcard = expanded.search(/[*?[]/);
    if (wildcard >= 0) {
      // the folder before the first wildcard is scanned only inside the home or ssh folder
      const literal = expanded.slice(0, wildcard);
      const base = await realpath(literal.slice(0, Math.max(literal.lastIndexOf("/"), literal.lastIndexOf(sep)) + 1) || ".").catch(() => null);
      if (base === null || !allowed.some((root) => inside(base, root))) return [];
      for await (const path of new Bun.Glob(expanded).scan({ absolute: true, onlyFiles: true })) {
        paths.push(path);
        if (paths.length >= budget.files) break;
      }
      paths.sort();
    } else paths.push(expanded);
    const texts: string[] = [];
    for (const path of paths) {
      if (budget.files <= 0 || budget.bytes <= 0) break;
      const real = await realpath(path).catch(() => null);
      if (real === null || !allowed.some((root) => inside(real, root))) continue;
      budget.files--;
      const text = await readCapped(real, Math.min(MAX_FILE_BYTES, budget.bytes));
      if (text === null) continue;
      budget.bytes -= Buffer.byteLength(text);
      texts.push(text);
    }
    return texts;
  };
}

/** the listing each options object has in flight, so concurrent requests share one */
const listings = new WeakMap<SshCandidatesOptions, Promise<SshCandidate[]>>();

/**
 * The SSH tab's list: the ssh config's hosts, then the Tailscale PCs no config host already names (by alias,
 * HostName or MagicDNS name). Either source missing leaves the other. Concurrent calls with the same options share
 * one listing.
 */
export function sshCandidates(options: SshCandidatesOptions = {}): Promise<SshCandidate[]> {
  const running = listings.get(options);
  if (running !== undefined) return running;
  const listing = listCandidates(options).finally(() => listings.delete(options));
  listings.set(options, listing);
  return listing;
}

async function listCandidates(options: SshCandidatesOptions): Promise<SshCandidate[]> {
  const sshDir = options.sshDir ?? join(homedir(), ".ssh");
  const [config, status] = await Promise.all([readCapped(join(sshDir, "config"), MAX_FILE_BYTES), (options.readStatus ?? readTailscaleStatus)()]);
  const hosts = config === null ? [] : await sshConfigHosts(config, includer(sshDir, options.home ?? homedir()));
  const peers = tailnetPeers(status);
  // a config host is the Tailscale PC it reaches: its HostName when it sets one, else its alias, as ssh resolves it.
  // Then that row stands for it. An address, or the addresses a name resolves to, decide: all of them (of the
  // AddressFamily ssh uses) that PC's, else none (answers naming two PCs, or a PC and an address off the tailnet, claim
  // nothing), and a name whose lookup fails or is late claims none. A name is looked up as written (`box.example.`
  // stays absolute). A proxied host's name is resolved at the far end, so it is matched by its spelling alone. An alias
  // alone never claims a PC its HostName leads away from: one kept from before a rename names a PC it no longer reaches
  const names = peers.length === 0 ? [] : [...new Set(hosts.filter((host) => host.proxied !== true).map(({ alias, hostname }) => hostname ?? alias).filter((name) => isIP(name) === 0))];
  const resolved = await resolveWithin(names, {
    resolve: options.resolve ?? systemResolve, now: options.now ?? Date.now, timeoutMs: options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS, deadline: options.lookupDeadline ?? lookupDeadline,
  });
  const peerByIp = new Map<string, (typeof peers)[number]>();
  for (const peer of peers) for (const ip of peer.ips) if (!peerByIp.has(canonicalIp(ip))) peerByIp.set(canonicalIp(ip), peer);
  const peerOf = ({ alias, hostname, addressFamily, proxied }: ConfigHost) => {
    const written = hostname ?? alias;
    if (proxied === true && isIP(written) === 0) {
      const target = written.toLowerCase().replace(/\.$/, "");
      return peers.find(({ name, dnsName }) => target === name.toLowerCase() || target === dnsName.toLowerCase());
    }
    const addresses = (isIP(written) === 0 ? resolved.get(written) ?? [] : [canonicalIp(written)])
      .filter((address) => addressFamily === undefined || isIP(address) === (addressFamily === "inet" ? 4 : 6));
    const owners = new Set(addresses.map((address) => peerByIp.get(address)));
    return owners.size === 1 ? [...owners][0] : undefined;
  };
  const claimed = new Set<string>();
  const fromConfig: SshCandidate[] = hosts.map((host) => {
    const { alias, hostname, user } = host;
    const peer = peerOf(host);
    if (peer !== undefined) claimed.add(peer.dnsName);
    return {
      name: alias,
      destination: alias,
      detail: hostname === null ? (user === null ? null : `${user}@${alias}`) : user === null ? hostname : `${user}@${hostname}`,
      source: "ssh_config",
      ...(peer === undefined ? {} : { tailnet: peer.dnsName }),
    };
  });
  const fromTailnet: SshCandidate[] = peers
    .filter(({ dnsName }) => !claimed.has(dnsName))
    .map(({ name, dnsName }) => ({ name, destination: dnsName, detail: dnsName, source: "tailscale", tailnet: dnsName }));
  return [...fromConfig, ...fromTailnet].slice(0, MAX_HOSTS);
}
