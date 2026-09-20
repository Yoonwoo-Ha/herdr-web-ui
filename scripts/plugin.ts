/**
 * herdr plugin lifecycle for the web UI.
 *
 * herdr's startup hooks are one-shot initialization commands, not supervised
 * daemons (https://herdr.dev/docs/plugins/), so this script owns the process:
 * `start` detaches the server and records its pid under HERDR_PLUGIN_STATE_DIR,
 * `stop` takes it down, `status` reports. Start is idempotent — a server that is
 * already answering on the port is left alone, which is what makes it safe as
 * both a startup hook and a hand-invoked action.
 *
 * Two pieces of herdr's runtime environment have to be translated:
 * - herdr injects HERDR_SOCKET_PATH; the server reads HERDR_SOCKET. Without the
 *   mapping a named session's plugin would talk to the default socket.
 * - plugin commands inherit herdr's environment, not the user's shell, so the
 *   token and any overrides are read from `env` in HERDR_PLUGIN_CONFIG_DIR.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PORT } from "../shared/protocol.ts";

const ROOT = process.env["HERDR_PLUGIN_ROOT"] ?? import.meta.dir.replace(/\/scripts$/, "");
const STATE_DIR = process.env["HERDR_PLUGIN_STATE_DIR"] ?? join(homedir(), ".local", "state", "herdr-web-ui");
const CONFIG_DIR = process.env["HERDR_PLUGIN_CONFIG_DIR"] ?? join(homedir(), ".config", "herdr-web-ui");
const PID_FILE = join(STATE_DIR, "server.pid");
const LOG_FILE = join(STATE_DIR, "server.log");
/** the server needs a moment to bind and open its first herdr connection */
const READY_TIMEOUT_MS = 20_000;

/** `KEY=value` lines from the plugin's config dir: the token lives here, not in herdr's env. */
function userEnv(): Record<string, string> {
  const file = join(CONFIG_DIR, "env");
  if (!existsSync(file)) return {};
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

const env = { ...process.env, ...userEnv() };
const port = Number(env["PORT"] ?? DEFAULT_PORT);
const host = env["HOST"] ?? "127.0.0.1";
const origin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

async function health(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function recordedPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function start(): Promise<number> {
  if (await health()) {
    process.stdout.write(`herdr web ui already running at ${origin}\n`);
    return 0;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
      HOST: host,
      PORT: String(port),
      // herdr hands the plugin HERDR_SOCKET_PATH; the server (and the attach it
      // spawns) reads HERDR_SOCKET
      ...(env["HERDR_SOCKET_PATH"] !== undefined ? { HERDR_SOCKET: env["HERDR_SOCKET_PATH"] } : {}),
    },
  });
  child.unref();
  if (child.pid === undefined) {
    process.stderr.write("could not spawn the server\n");
    return 1;
  }
  writeFileSync(PID_FILE, `${child.pid}\n`, { mode: 0o600 });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await health()) {
      process.stdout.write(`herdr web ui listening at ${origin}\n`);
      if ((env["HERDR_WEB_TOKEN"] ?? "") === "") {
        process.stdout.write(`no token set: put HERDR_WEB_TOKEN=<token> in ${join(CONFIG_DIR, "env")} before exposing it\n`);
      }
      return 0;
    }
    await Bun.sleep(250);
  }
  process.stderr.write(`server did not answer ${origin}/api/health within ${READY_TIMEOUT_MS / 1000}s; see ${LOG_FILE}\n`);
  return 1;
}

function stop(): number {
  const pid = recordedPid();
  if (pid === null) {
    rmSync(PID_FILE, { force: true });
    process.stdout.write("herdr web ui is not running\n");
    return 0;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  rmSync(PID_FILE, { force: true });
  process.stdout.write(`stopped herdr web ui (pid ${pid})\n`);
  return 0;
}

/** Reporting "down" is not an action failure: herdr logs a nonzero exit as failed. */
async function status(): Promise<number> {
  const pid = recordedPid();
  const up = await health();
  process.stdout.write(`${up ? "running" : "down"} ${origin}${pid === null ? "" : ` (pid ${pid})`}\n`);
  return 0;
}

const command = process.argv[2] ?? "status";
if (command === "start") process.exit(await start());
else if (command === "stop") process.exit(stop());
else if (command === "status") process.exit(await status());
else {
  process.stderr.write(`usage: bun scripts/plugin.ts <start|stop|status>\n`);
  process.exit(2);
}
