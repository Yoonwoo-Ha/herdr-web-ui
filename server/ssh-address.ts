import { userInfo } from "node:os";
import type { SshTarget } from "../shared/machines.ts";
import { sshClient } from "./ssh.ts";

/** how long a resolved address is reused: the SSH config may change, but not between one job's checks */
const KEPT_MS = 60_000;
const kept = new Map<string, { address: string; at: number }>();

/**
 * The PC an SSH target reaches, as OpenSSH resolves it (`ssh -G`, which reads the config and connects to nothing):
 * `user@hostname:port`. Two aliases of one host, or a port given and the default 22, are the same PC. When ssh cannot
 * tell, the target's own words stand: its user (or this account's) at its host, on its port or 22.
 */
export function sshAddress(target: SshTarget): string {
  const key = `${target.destination}\0${target.port ?? ""}`;
  const now = Date.now();
  const hit = kept.get(key);
  if (hit && now - hit.at < KEPT_MS) return hit.address;
  const address = sshAddresses.resolve(target) ?? literalAddress(target);
  kept.set(key, { address, at: now });
  return address;
}

/** The resolver, replaceable in tests with one that reads a config file of their own. */
export const sshAddresses = {
  resolve(target: SshTarget, config?: string): string | null {
    try {
      const run = Bun.spawnSync([sshClient().ssh, ...(config ? ["-F", config] : []), "-G", ...(target.port ? ["-p", String(target.port)] : []), target.destination], {
        stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3000, windowsHide: true,
      });
      if (run.exitCode !== 0) return null;
      const said = new Map<string, string>();
      for (const line of run.stdout.toString().split("\n")) {
        const space = line.indexOf(" ");
        if (space > 0) said.set(line.slice(0, space).toLowerCase(), line.slice(space + 1).trim());
      }
      const user = said.get("user"), hostname = said.get("hostname"), port = said.get("port");
      return user && hostname && port ? `${user}@${hostname.toLowerCase()}:${port}` : null;
    } catch { return null; }
  },
};

function literalAddress(target: SshTarget): string {
  const at = target.destination.lastIndexOf("@");
  const user = at >= 0 ? target.destination.slice(0, at) : userInfo().username;
  return `${user}@${target.destination.slice(at + 1).toLowerCase()}:${target.port ?? 22}`;
}

/** forgets what was resolved: for tests that change the resolver between cases */
export function forgetSshAddresses(): void { kept.clear(); }
