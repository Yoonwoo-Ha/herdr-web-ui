/**
 * A new user's install, watched: a disposable Ubuntu 24.04 with nothing but curl, git and Node 18
 * (the distro's), a normal user, herdr and Bun from their installers, a headless herdr, then
 * `herdr plugin install` from GitHub exactly as the README says, the start action, /api/health,
 * and the startup hook after a herdr restart. Requires Docker and network; nothing on the host
 * changes. It installs a pushed ref, by default the current branch.
 *
 *   bun scripts/fresh-install-docker.ts [owner/repo] [ref]      KEEP=1 leaves the container behind
 */
import assert from "node:assert/strict";

const source = process.argv[2] ?? originSlug();
const ref = process.argv[3] ?? Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
const name = `herdr-fresh-install-${process.pid}`;
const NOISE = /cannot set terminal process group|no job control in this shell|tcsetattr: Inappropriate ioctl/;

function originSlug(): string {
  const url = Bun.spawnSync(["git", "remote", "get-url", "origin"]).stdout.toString().trim();
  const match = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url);
  if (!match) throw new Error(`origin is not a GitHub repository: ${url}`);
  return match[1]!;
}

async function docker(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdin: input ? new Blob([input]) : "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // an interactive bash echoes its prompt and "logout" on stderr; only a failure needs them
  const noise = stderr.split("\n").filter((line) => line && !NOISE.test(line)).join("\n");
  if (code !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed (${code}):\n${stdout.slice(-1500)}\n${noise.slice(-1500)}`);
  return stdout;
}
/** as the user, in a shell like a terminal's: login (~/.local/bin) and interactive (~/.bashrc, where Bun puts itself) */
const asUser = (script: string) => docker(["exec", "-i", "-u", "alice", "-w", "/home/alice", name, "bash", "-li"], script);
const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await run();
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
};

console.log(`fresh install of ${source}@${ref} in a clean Ubuntu 24.04 (Node 18, no Python, make or compiler)`);
try {
  await step("container: base image, curl, git, Node 18, a user", async () => {
    await docker(["run", "-d", "--name", name, "--hostname", "fresh-pc", "ubuntu:24.04", "sleep", "infinity"]);
    await docker(["exec", name, "bash", "-c", "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends curl ca-certificates git unzip xz-utils nodejs >/dev/null && useradd -m -s /bin/bash alice"]);
    const tools = await docker(["exec", name, "bash", "-c", "node --version; for t in python3 make g++ cc; do command -v $t >/dev/null && echo \"$t present\"; done; true"]);
    assert.match(tools, /^v18\./m, "the distro Node is 18");
    assert.doesNotMatch(tools, /present/, "no build toolchain in the box");
  });
  await step("herdr and Bun from their installers", async () => {
    await asUser("curl -fsSL https://herdr.dev/install.sh | sh >/dev/null 2>&1; curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1");
    const versions = await asUser("herdr --version; bun --version");
    assert.match(versions, /herdr \d/, "herdr on the PATH of a terminal shell");
    assert.match(versions, /^1\.[4-9]|^[2-9]\./m, "Bun 1.4+ on the PATH of a terminal shell");
  });
  await step("a headless herdr", async () => {
    await asUser("setsid nohup herdr server > ~/herdr-server.log 2>&1 < /dev/null & sleep 3; herdr status server");
  });
  const install = await step("herdr plugin install", async () => {
    const out = await asUser(`herdr plugin install ${source} --ref ${ref} --yes 2>&1`);
    assert.match(out, /Installed /, `the install did not finish:\n${out.slice(-2500)}`);
    assert.doesNotMatch(out, /gyp ERR|node-gyp/, "nothing compiled");
    return out;
  });
  assert.match(await asUser("herdr plugin list"), /enabled/);
  await step("start action, then /api/health", async () => {
    await asUser("herdr plugin action invoke devswha.herdr-web-ui.start >/dev/null");
    const health = await asUser('for i in $(seq 1 20); do if curl -sf http://127.0.0.1:7317/api/health; then exit 0; fi; sleep 1; done; echo TIMEOUT; cat ~/.local/state/herdr/plugins/*/server.log 2>/dev/null | tail -20; exit 1');
    assert.match(health, /"ok":true/);
  });
  await step("a terminal through the sidecar, on the box's own Node", async () => {
    const out = await asUser('cd ~/.config/herdr/plugins/github/devswha.herdr-web-ui-*/ && node server/pty/smoke.mjs && echo PTY_OK');
    assert.match(out, /PTY_OK/, `the bundled PTY smoke test failed:\n${out.slice(-1500)}`);
  });
  await step("startup hook: herdr restarts, the app comes back by itself", async () => {
    await asUser("herdr plugin action invoke devswha.herdr-web-ui.stop >/dev/null 2>&1; sleep 1; herdr server stop >/dev/null 2>&1; sleep 2; setsid nohup herdr server > ~/herdr-server2.log 2>&1 < /dev/null &");
    const health = await asUser('for i in $(seq 1 25); do if curl -sf http://127.0.0.1:7317/api/health >/dev/null; then echo "up after ${i}s"; exit 0; fi; sleep 1; done; echo TIMEOUT; herdr plugin log list 2>&1 | tail -c 1500; exit 1');
    console.log(`  ${/up after \d+s/.exec(health)?.[0] ?? health.trim().split("\n").pop()}`);
  });
  const said = install.split("\n").filter((line) => /Installed |Config:/.test(line));
  console.log(`\nA new user on a bare Ubuntu 24.04 gets a working herdr web ui. herdr said:\n${said.map((l) => `  ${l.trim()}`).join("\n")}`);
} finally {
  if (process.env["KEEP"] === "1") console.log(`container kept: docker exec -it -u alice ${name} bash -li`);
  else await docker(["rm", "-f", name]).catch(() => {});
}
