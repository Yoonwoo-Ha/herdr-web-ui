import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = join(import.meta.dir, "plugin.ts");
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "launcher-plugin-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
function environment() {
  return { HOME: home, TMPDIR: tmpdir(), PATH: "/usr/bin:/bin", HERDR_PLUGIN_CONFIG_DIR: join(home, "config"), HERDR_PLUGIN_STATE_DIR: join(home, "plugin-state"), OVIS_STATE_DIR: join(home, "app-state"), HERDR_PLUGIN_ROOT: join(home, "checkout") };
}

it("does not request a signal for an unverified legacy pid", () => {
  const env = environment();
  mkdirSync(env.HERDR_PLUGIN_STATE_DIR);
  writeFileSync(join(env.HERDR_PLUGIN_STATE_DIR, "server.pid"), "7654321\n");
  const probe = `const sent = []; let live = true; process.kill = (pid, signal) => {
    if (Math.abs(pid) !== 7654321) throw new Error('unexpected pid');
    if (signal === 0 && !live) throw Object.assign(new Error('gone'), {code:'ESRCH'});
    if (signal !== 0) { sent.push(signal); live = false; } return true;
  }; const {stop} = await import(${JSON.stringify(plugin)}); await stop(); console.log(JSON.stringify(sent));`;
  const child = Bun.spawnSync([process.execPath, "-e", probe], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString().trim().split("\n").at(-1)).toBe("[]");
});
