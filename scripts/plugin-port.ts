import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { defaultStateDir } from "../server/update-state.ts";

/** Tried in order after the default: far apart, so one reserved range cannot hold them all. */
export const FALLBACK_PORTS = [17317, 27317, 37317, 47317];

export function savedPort(file: string): number | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const port = Number(text.trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** The port the app listens on as the plugin settles it: PORT, else the one a start kept (`plugin-port` in its state folder), else the default. */
export function settledPort(env: Readonly<Record<string, string | undefined>>, portFile?: string): number {
  return env["PORT"] ? Number(env["PORT"]) : savedPort(portFile ?? join(defaultStateDir(env), "plugin-port")) ?? DEFAULT_PORT;
}

/** The app's address on `host` (HOST, else loopback; a bind to every address is reached on loopback). */
export function originOf(host: string, port: number): string {
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}

/** Where the app answers for these settings, as `ovis status` reaches it over TCP. */
export function appOrigin(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const config = env["XDG_CONFIG_HOME"] || join(home, ".config");
  const host = env["HOST"] ?? "127.0.0.1";
  return originOf(host === "::1" ? "[::1]" : host, settledPort({ ...env, XDG_CONFIG_HOME: config }));
}

/** A port inside a range Windows reserves (Hyper-V, WSL2, Docker) fails although nothing listens on it. */
export async function canBind(hostname: string, port: number): Promise<boolean> {
  try {
    await Bun.serve({ hostname, port, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

export async function canServe(hostname: string, port: number, ipv6Loopback: boolean): Promise<boolean> {
  if (!await canBind(hostname, port)) return false;
  return !ipv6Loopback || hostname !== "127.0.0.1" || canBind("::1", port);
}

export async function freePort(failed: number, defaultPort: number, opens: (port: number) => Promise<boolean>): Promise<number | null> {
  for (const port of [defaultPort, ...FALLBACK_PORTS]) {
    if (port !== failed && await opens(port)) return port;
  }
  return null;
}
