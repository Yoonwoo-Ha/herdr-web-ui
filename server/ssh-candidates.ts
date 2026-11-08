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

import { type ConfigHost, MAX_HOSTS, sshConfigHosts } from "./ssh-config.ts";
import { canonicalIp, RESOLVE_TIMEOUT_MS, resolveWithin, systemResolve } from "./ssh-lookup.ts";
import { readTailscaleStatus, tailnetPeers } from "./tailnet-pcs.ts";

/** an ssh config is a few kilobytes; past this it is not read on */
const MAX_FILE_BYTES = 256 * 1024;
/** files every Include of one config together reads at most */
const MAX_INCLUDED_FILES = 64;
/** bytes every Include of one config together reads at most */
const MAX_INCLUDED_BYTES = 1024 * 1024;

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
 * the response; and every Include of one config shares one budget of files and bytes. A file ssh would read that is
 * left unread (out of those folders, past the budget, not a regular file of at most the size cap) comes back as null,
 * so what it might set stays unknown; a file that is not there is nothing, as for ssh.
 */
function includer(sshDir: string, home: string): (pattern: string) => Promise<(string | null)[]> {
  const roots = Promise.all([sshDir, home].map((root) => realpath(root).catch(() => null)));
  const budget = { files: MAX_INCLUDED_FILES, bytes: MAX_INCLUDED_BYTES };
  return async (pattern) => {
    if (budget.files <= 0 || budget.bytes <= 0) return [null];
    // ssh expands `%` tokens and `${VAR}` in an Include, which this offline reading does not: what it names stays unread
    if (/%|\$\{/.test(pattern)) return [null];
    const allowed = (await roots).filter((root): root is string => root !== null);
    // ssh's glob(3) has no `**`: it is one `*`, which also keeps a scan to the pattern's own depth
    const expanded = (pattern.startsWith("~/") ? join(home, pattern.slice(2)) : isAbsolute(pattern) ? pattern : join(sshDir, pattern)).replace(/\*{2,}/g, "*");
    const paths: string[] = [];
    // a scan cut short may have missed a file sorted before the ones it found; a read cut short misses only later ones
    let [scanCut, truncated] = [false, false];
    const wildcard = expanded.search(/[*?[]/);
    if (wildcard >= 0) {
      // the folder before the first wildcard is scanned only inside the home or ssh folder
      const literal = expanded.slice(0, wildcard);
      const base = await realpath(literal.slice(0, Math.max(literal.lastIndexOf("/"), literal.lastIndexOf(sep)) + 1) || ".").catch(() => null);
      if (base === null) return [];
      if (!allowed.some((root) => inside(base, root))) return [null];
      // links are followed as ssh's glob(3) does (a dotfiles repo linked in); each path is still read only when its real
      // target is inside the home or ssh folder, below, and one that is not comes back as null
      for await (const path of new Bun.Glob(expanded).scan({ absolute: true, onlyFiles: true, followSymlinks: true })) {
        if (paths.length >= budget.files) { scanCut = true; break; }
        paths.push(path);
      }
      paths.sort();
    } else paths.push(expanded);
    const texts: (string | null)[] = [];
    for (const path of paths) {
      if (budget.files <= 0 || budget.bytes <= 0) { truncated = true; break; }
      const real = await realpath(path).catch(() => null);
      if (real === null) continue;
      if (!allowed.some((root) => inside(real, root))) { texts.push(null); continue; }
      budget.files--;
      const text = await readCapped(real, Math.min(MAX_FILE_BYTES, budget.bytes));
      if (text !== null) budget.bytes -= Buffer.byteLength(text);
      texts.push(text);
    }
    return [...(scanCut ? [null] : []), ...texts, ...(truncated ? [null] : [])];
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
  // stays absolute). A proxied host's name is resolved at the far end, wherever that leads, and an undetermined one may
  // go elsewhere, so neither claims a PC. An alias alone never claims a PC its HostName leads away from: one kept from
  // before a rename names a PC it no longer reaches
  const claimable = peers.length === 0 ? [] : hosts.filter((host) => host.proxied !== true && host.undetermined !== true);
  const names = [...new Set(claimable.map(({ alias, hostname }) => hostname ?? alias).filter((name) => isIP(name) === 0))];
  const resolved = await resolveWithin(names, { resolve: options.resolve ?? systemResolve, timeoutMs: options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS });
  const peerByIp = new Map<string, (typeof peers)[number]>();
  for (const peer of peers) for (const ip of peer.ips) if (!peerByIp.has(canonicalIp(ip))) peerByIp.set(canonicalIp(ip), peer);
  const peerOf = ({ alias, hostname, addressFamily, proxied, undetermined }: ConfigHost) => {
    if (proxied === true || undetermined === true) return undefined;
    const written = hostname ?? alias;
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
