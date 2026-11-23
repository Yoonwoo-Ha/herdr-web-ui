/**
 * Which project a folder is, the same on every PC: `git:` and its repository's `origin` address with
 * the user part (where a token can be), default port, `.git` and case dropped. With no origin, the one
 * remote it has; with several and none named origin, or none at all, no project. The address is a
 * claim the folder makes, not proof: a person confirms a folder's project before agents are given
 * its notes (a later step). The address read is never stored, only the key.
 */
import { PROJECT_KEY } from "./entry.ts";

const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22", "git+ssh:": "22", "ssh+git:": "22", "git:": "9418" };
const GIT_TIMEOUT_MS = 5_000;

export function remoteKey(url: string): string | null {
  const trimmed = url.trim();
  let host: string;
  let port = "";
  let scheme = "ssh:";
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try { parsed = new URL(trimmed); } catch { return null; }
    if (!(parsed.protocol in DEFAULT_PORT)) return null;
    scheme = parsed.protocol;
    host = parsed.hostname;
    port = parsed.port;
    try { path = decodeURIComponent(parsed.pathname); } catch { return null; }
  } else if (scp !== null && !trimmed.startsWith("/") && !trimmed.startsWith(".")) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  const cleanPath = path.toLowerCase().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (host === "" || cleanPath === "") return null;
  const where = port === "" || DEFAULT_PORT[scheme] === port ? host.toLowerCase() : `${host.toLowerCase()}:${port}`;
  const key = `git:${where}/${cleanPath}`;
  return PROJECT_KEY.test(key) ? key : null;
}

function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // a repository the server itself was started inside is not the one asked about
    if (value === undefined || name.startsWith("GIT_")) continue;
    env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

async function gitLines(folder: string, args: string[]): Promise<string[] | null> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    // an empty core.fsmonitor keeps a repository's own hook from running for a read
    proc = Bun.spawn(["git", "--no-optional-locks", "-c", "core.fsmonitor=", "-C", folder, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: gitEnvironment() });
  } catch {
    return null;
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.split("\n").map((line) => line.trim()).filter((line) => line !== "") : null;
  } finally {
    clearTimeout(timer);
  }
}

export async function projectKeyOf(folder: string): Promise<string | null> {
  const top = (await gitLines(folder, ["rev-parse", "--show-toplevel"]))?.[0];
  if (top === undefined) return null;
  const remotes = await gitLines(top, ["remote"]) ?? [];
  const name = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : null;
  if (name === null) return null;
  const url = (await gitLines(top, ["remote", "get-url", name]))?.[0];
  return url === undefined ? null : remoteKey(url);
}
