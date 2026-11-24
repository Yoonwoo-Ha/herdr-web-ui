import { it as test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harmlessGroups, trustRefusal } from "./herdr-core/discovery.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";

/**
 * serve() refuses the machine profile on Windows (its owner's door is a unix socket in a folder only this
 * account may enter): every case here runs a profile or compares a server with one, so all are skipped there,
 * and the one case of `test.if` in machine-profile-lifecycle.contract.test.ts checks that refusal instead.
 */
export const it = process.platform === "win32" ? test.skip : test;
export const cleanup: (() => void | Promise<void>)[] = [];
export const root = resolve(import.meta.dir, "..");
export const token = "machine-contract-owner";
export const headers = { authorization: `Bearer ${token}`, "x-herdr-update": "1", "x-herdr-machine": "1" };
/**
 * The profile walks its state folder's path at start and refuses one under a folder another account
 * may write: a TMPDIR the walk refuses (a group-writable folder whose group cannot be shown to be
 * private) leaves these folders in root's sticky /tmp, where every CI runner has them.
 */
const parent = trustRefusal(realpathSync(tmpdir()), harmlessGroups(), true) === null ? tmpdir() : "/tmp";
function folder(under: string, prefix = "ovis-machine-profile-") {
  const dir = mkdtempSync(join(under, prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export const state = () => folder(parent);
export const scratch = () => folder(tmpdir());
/** The local owner's call: on the profile's socket in its state folder, addressed as the command line addresses it. */
export function owner(stateDir: string, path: string, init: RequestInit = {}) {
  return fetch(`http://localhost${path}`, { ...init, unix: join(stateDir, "serve.sock") });
}
export function cookieRow(stateDir: string, secret: string): string {
  const id = "machine-contract-cookie-row";
  const at = new Date().toISOString();
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: at, devices: [
    { id, label: "a browser at the machine's address", role: "drive", token_hash: createHash("sha256").update(secret).digest("hex"), created_at: at, last_seen_at: null },
  ] }), { mode: 0o600 });
  return id;
}
/**
 * A folder for XDG_CONFIG_HOME, its herdr folder `<it>/herdr`: a short path, as a unix socket's in it must be, and
 * with no link in it (macOS's temporary folder is reached through one), as the profile requires of a herdr socket.
 */
export const herdrConfig = () => realpathSync(folder(parent, "ovis-h-"));
/**
 * A server reads the versions of the agent tools it finds on its PATH, each in a process group of its
 * own that outlives a server a test ends, and those tools would write into the HOME of a server whose
 * folders the test has removed.
 */
const launchPath = "/usr/bin:/bin";
/**
 * HOME is a folder of its own unless `env` names one: Bun writes its cache into HOME before the server
 * runs, and a profile starts only on an empty state folder or one it marked.
 */
export function launch(stateDir: string, env: Record<string, string | undefined> = {}, umask?: string) {
  const ready = deferred<string>();
  let output = "";
  let errors = "";
  const merged: Record<string, string | undefined> = { ...process.env, OVIS_PROFILE: "machine", OVIS_PREVIEW: "fleet", OVIS_RUNTIME: "herdr", OVIS_STATE_DIR: stateDir,
    HOME: env["HOME"] ?? scratch(), OVIS_TOKEN: token, PATH: launchPath, PORT: "0", HOST: "127.0.0.1", HERDR_REMOTE_SOCKET: process.env["HERDR_SOCKET"] ?? "",
    OVIS_MANAGED: "0", OVIS_TAILSCALE_SERVE_ONLY: "0", OVIS_RELAY_URL: "wss://relay.invalid", ...env };
  const command = umask === undefined ? [process.execPath, "server/main.ts", "serve"] : ["/bin/sh", "-c", `umask ${umask} && exec "$0" server/main.ts serve`, process.execPath];
  const child = Bun.spawn(command, {
    cwd: root, env: Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const read = async (stream: ReadableStream<Uint8Array>, standardError: boolean) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      output += text;
      if (standardError) errors += text;
      const match = /Ovis listening on (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) ready.resolve(match[1]);
    }
  };
  const drained = Promise.all([read(child.stdout, false), read(child.stderr, true)]);
  const exited = child.exited.then(async (code) => { await drained; ready.reject(new Error(output || `Server exited ${code}`)); return code; });
  void ready.promise.catch(() => undefined);
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await bounded(exited, 15_000); });
  return { child, ready: ready.promise, exited, output: () => output, errors: () => errors };
}

