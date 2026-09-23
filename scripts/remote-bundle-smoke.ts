import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-bundle-smoke-")));
const bundle = join(root, "runtime");
const home = join(root, "home");
mkdirSync(bundle); mkdirSync(home);
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const archive = resolve(`remote-bundles/herdr-web-ui-${process.platform}-${process.arch}.tgz`);
  assert.equal(Bun.spawnSync(["tar", "xzf", archive, "-C", bundle]).exitCode, 0);
  child = Bun.spawn([join(bundle, "bin/bun"), join(bundle, "server/remote-entry.ts")], { env: { ...process.env, HOME: home, HERDR_REMOTE_SESSION: "smoke", HERDR_WEB_HERDR_BIN: join(bundle, "bin/herdr") }, stdout: "inherit", stderr: "inherit" });
  const { createHash } = await import("node:crypto");
  const socket = join(home, ".config/herdr/sessions/smoke/herdr.sock");
  const path = join(home, ".config/herdr-web-ui/bridges", createHash("sha256").update(socket).digest("hex") + ".json");
  let descriptor: { port: number; token: string } | undefined;
  for (let i = 0; i < 150; i++) { try { descriptor = JSON.parse(readFileSync(path, "utf8")); break; } catch { await Bun.sleep(100); } }
  assert.ok(descriptor, "bundle starts a private daemon and bridge without system runtimes");
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/bridge`, { headers: { authorization: `Bearer ${descriptor.token}` } });
  assert.equal(response.status, 200);
  const identity = await response.json() as { socket_path: string };
  assert.equal(identity.socket_path, socket);
  assert.equal((await fetch(`http://127.0.0.1:${descriptor.port}/api/session`)).status, 401);
  console.log("Remote bundle startup, isolated socket and authentication passed");
} finally {
  child?.kill(); if (child) await child.exited;
  Bun.spawnSync([join(bundle, "bin/herdr"), "--session", "smoke", "server", "stop"], { env: { ...process.env, HOME: home } });
  rmSync(root, { recursive: true, force: true });
}
