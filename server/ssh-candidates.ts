/**
 * Settings → Devices and PCs → Add a connection → SSH: the PCs this PC's server could reach over SSH, for one
 * tap to open Add PC with the address filled in. Two sources, both read only, neither connected to:
 * the hosts named in its own account's ssh config, and the other PCs of its own Tailscale login (reached by
 * their MagicDNS name, over SSH like any other address, never through the relay).
 */
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

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

interface HostBlock { aliases: string[]; hostname?: string; user?: string }

/**
 * The hosts an ssh config names, in its order, with the first HostName and User each block sets. Hosts named only
 * by a pattern (`*`, `?`, `!`) and everything under Match are left out; a later block repeating an alias adds nothing.
 * `include(pattern)` reads the files an Include names, as text, in their order.
 */
export async function sshConfigHosts(text: string, include: (pattern: string) => Promise<string[]> = async () => []): Promise<{ alias: string; hostname: string | null; user: string | null }[]> {
  const blocks: HostBlock[] = [];
  let current: HostBlock | null = null;
  let inMatch = false;
  const walk = async (text: string, depth: number): Promise<void> => {
    for (const line of text.split(/\r?\n/)) {
      const parsed = keyword(line);
      if (parsed === null) continue;
      if (parsed.key === "host") {
        inMatch = false;
        // `Host valid server-*` still names `valid`; a negated pattern on the line leaves out each alias it matches
        // (`Host web01 !web*` names nothing), as ssh never applies the block to that host
        const negated = parsed.values.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
        current = { aliases: parsed.values.filter((value) => plainAlias(value) && !negated.some((pattern) => globMatch(pattern, value))) };
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
            await walk(included, depth + 1);
          }
        }
        [current, inMatch] = [outer, outerMatch];
      } else if (current !== null && !inMatch) {
        if (parsed.key === "hostname" && current.hostname === undefined) current.hostname = parsed.values[0];
        if (parsed.key === "user" && current.user === undefined) current.user = parsed.values[0];
      }
    }
  };
  await walk(text, 0);
  const seen = new Set<string>();
  const hosts: { alias: string; hostname: string | null; user: string | null }[] = [];
  for (const block of blocks) {
    for (const alias of block.aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      hosts.push({ alias, hostname: block.hostname ?? null, user: block.user ?? null });
    }
  }
  return hosts.slice(0, MAX_HOSTS);
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

/**
 * The SSH tab's list: the ssh config's hosts, then the Tailscale PCs no config host already names (by alias,
 * HostName or MagicDNS name). Either source missing leaves the other.
 */
export async function sshCandidates(options: SshCandidatesOptions = {}): Promise<SshCandidate[]> {
  const sshDir = options.sshDir ?? join(homedir(), ".ssh");
  const [config, status] = await Promise.all([readCapped(join(sshDir, "config"), MAX_FILE_BYTES), (options.readStatus ?? readTailscaleStatus)()]);
  const hosts = config === null ? [] : await sshConfigHosts(config, includer(sshDir, options.home ?? homedir()));
  const peers = tailnetPeers(status);
  // a config host names a Tailscale PC by its machine or MagicDNS name, as alias or HostName: that row stands for it
  const peerOf = (alias: string, hostname: string | null) => {
    const names = [alias, ...(hostname === null ? [] : [hostname])].map((value) => value.toLowerCase().replace(/\.$/, ""));
    return peers.find(({ name, dnsName }) => names.includes(name.toLowerCase()) || names.includes(dnsName.toLowerCase()));
  };
  const claimed = new Set<string>();
  const fromConfig: SshCandidate[] = hosts.map(({ alias, hostname, user }) => {
    const peer = peerOf(alias, hostname);
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
