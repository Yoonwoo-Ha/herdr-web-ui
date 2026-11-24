import { afterEach, expect, it as test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createServer } from "./index.ts";
import { claimServerState, MachineProfileError } from "./machine-profile.ts";
import { cleanup, cookieRow, headers, it, launch, owner, root, scratch, state, token } from "./machine-profile.test-helpers.ts";
import { guardLibrary } from "./owner-guard.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import { updateStateDir } from "./update-state.ts";

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function marked(stateDir: string) {
  writeFileSync(join(stateDir, "machine-profile.json"), '{"profile":"machine"}', { mode: 0o600 });
}
function contents(dir: string) {
  return (readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
    const path = join(dir, name);
    const entry = lstatSync(path);
    return [name, entry.isFile() ? readFileSync(path, "base64") : entry.isDirectory() ? "folder" : "other"];
  });
}
async function refused(server: ReturnType<typeof launch>): Promise<string> {
  expect(await bounded(server.exited, 20_000)).toBe(1);
  const sentence = server.errors().trim();
  expect(sentence).not.toContain("\n");
  expect(sentence).toMatch(/^[A-Z].*\.$/);
  return sentence;
}

it("binds the machine profile only to IPv4 loopback despite publishing settings", async () => {
  const dir = state();
  const herdr = join(dir, "bin", "herdr");
  const server = launch(dir, { HOST: "0.0.0.0", OVIS_IPV6_LOOPBACK: "1", OVIS_LAN_HTTPS: "1", OVIS_TAILSCALE_SERVE_ONLY: "1", OVIS_HERDR_BIN: herdr });
  const base = await bounded(server.ready, 20_000);
  expect(new URL(base).hostname).toBe("127.0.0.1");
  expect(server.output()).toContain(`herdr binary: ${herdr} (from OVIS_HERDR_BIN)\n`);
  const response = await owner(dir, "/api/health", { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, machine_profile: { engine: "herdr" } });
  const direct = await owner(dir, "/api/relay/direct", { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body: '{"on":true}' });
  expect(direct.status).toBe(409);
  expect(server.output()).not.toContain("LAN HTTPS on");
});

it.each(["environment", "saved"])("refuses herdr-core selected by %s in its health and runs no hc process", async (source) => {
  const dir = state();
  const bin = scratch();
  const calls = join(bin, "hc-calls");
  const hc = join(bin, "hc");
  writeFileSync(hc, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = --version ]; then echo 'hc 0.1.18'; else exit 1; fi\n`, { mode: 0o700 });
  if (source === "saved") { marked(dir); writeFileSync(join(dir, "runtime-0.json"), JSON.stringify({ runtime: "herdr-core", previous: "herdr" })); }
  // the core's own folders are this test's: no core of the user's is ever looked at. Under root's sticky
  // /tmp: a core socket is taken only on a path that no other account can write
  const core = mkdtempSync("/tmp/ovis-machine-core-absent-");
  cleanup.push(() => rmSync(core, { recursive: true, force: true }));
  const server = launch(dir, { OVIS_RUNTIME: source === "environment" ? "herdr-core" : "", OVIS_HC_BIN: hc, HC_SOCKET: join(core, "absent.sock"),
    XDG_RUNTIME_DIR: core, XDG_STATE_HOME: core, XDG_CONFIG_HOME: core });
  await bounded(server.ready, 20_000);
  for (const path of ["/api/health", "/api/health?scope=bridge"]) {
    const response = await owner(dir, path, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, machine_profile: {
      engine: "herdr-core", runtime_down: true, reason: "herdr-core is not supported for a machine yet",
    } });
  }
  await (await owner(dir, "/api/session", { headers })).text();
  expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
});

it("a second machine start on another port and canonical spelling leaves the first owner answering", async () => {
  const dir = state();
  const alias = `${dir}-alias`;
  symlinkSync(dir, alias, "junction");
  cleanup.push(() => rmSync(alias));
  const first = launch(dir, {});
  await bounded(first.ready, 20_000);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop();
  const second = launch(alias, { PORT: String(port) });
  const outcome = await bounded(Promise.race([second.exited.then((code) => ({ code })), second.ready.then(() => ({ code: 0 }), () => second.exited.then((code) => ({ code })))]), 20_000);
  expect(outcome.code).toBe(1);
  expect(await refused(second)).toContain("already owns this Ovis state directory");
  expect((await owner(dir, "/api/health?scope=bridge")).status).toBe(200);
});

it("refuses the machine profile without OVIS_PREVIEW=fleet before its state folder is touched, and starts it with the preview on", async () => {
  const dir = state();
  // a HOME of its own: Bun keeps its transpiler cache there, which is not the server's writing
  expect(await refused(launch(dir, { OVIS_PREVIEW: undefined, HOME: scratch() }))).toContain("OVIS_PREVIEW=fleet");
  expect(readdirSync(dir)).toEqual([]);
  await bounded(launch(dir).ready, 20_000);
  const health = await (await owner(dir, "/api/health")).json() as Record<string, unknown>;
  expect(health["machine_profile"]).toBeDefined();
});

test.if(process.platform === "win32")("refuses the machine profile on Windows before its state folder is touched", async () => {
  const dir = scratch();
  expect(await refused(launch(dir))).toContain("Windows");
  expect(readdirSync(dir)).toEqual([]);
});

it("keeps an ordinary server's health free of the profile's facts, with OVIS_PREVIEW set or not", async () => {
  for (const preview of [undefined, "fleet"]) {
    const base = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: preview }).ready, 20_000);
    const answer = await fetch(`${base}/api/health`, { headers });
    expect(answer.status).toBe(200);
    const body = await answer.json() as Record<string, unknown>;
    expect(body["auth"]).toMatchObject({ authenticated: true });
    expect(body).not.toHaveProperty("machine_profile");
    const stranger = await (await fetch(`${base}/api/health`)).json() as Record<string, unknown>;
    expect(stranger["auth"]).toMatchObject({ authenticated: false });
    expect(stranger).not.toHaveProperty("machine_profile");
  }
});

it("has an ordinary server hold its state folder only with OVIS_PREVIEW=fleet", async () => {
  for (const [preview, held] of [[undefined, false], ["fleet", true]] as const) {
    const dir = state();
    await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: preview, HOME: scratch() }).ready, 20_000);
    expect(existsSync(join(dir, "serve.own"))).toBe(held);
  }
});

it("ordinary servers on one state folder and different ports both answer without a lease", async () => {
  const dir = state();
  const first = launch(dir, { OVIS_PROFILE: "" });
  const one = await bounded(first.ready, 20_000);
  const second = launch(dir, { OVIS_PROFILE: "" });
  const two = await bounded(second.ready, 20_000);
  expect(one).not.toBe(two);
  for (const base of [one, two]) {
    const answer = await fetch(base + "/api/health?scope=bridge", { headers });
    expect(answer.status).toBe(200);
    expect(await answer.json()).not.toHaveProperty("machine_profile");
  }
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

async function supervisorRecord(lock: string) {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const holder = Bun.spawn([process.execPath, "-e", `const { acquireOwnerDirectory } = await import(${JSON.stringify(join(root, "server/owner-guard.ts"))});
acquireOwnerDirectory(${JSON.stringify(lock)}, { running: "running", starting: "starting" });
console.log("held");
setInterval(() => {}, 60_000);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const held = deferred<void>();
  void (async () => { for await (const chunk of holder.stdout) if (new TextDecoder().decode(chunk).includes("held")) held.resolve(); })();
  void holder.exited.then((code) => held.reject(new Error(`the record's holder exited ${code}`)));
  cleanup.push(async () => { holder.kill(); await bounded(holder.exited, 15_000); });
  await bounded(held.promise, 20_000);
  return holder;
}

async function sharedHold(path: string) {
  const holder = Bun.spawn([process.execPath, "-e", `const { holdForLife } = await import(${JSON.stringify(join(root, "server/owner-guard.ts"))});
holdForLife(${JSON.stringify(path)}, "shared");
console.log("held");
setInterval(() => {}, 60_000);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const held = deferred<void>();
  void (async () => { for await (const chunk of holder.stdout) if (new TextDecoder().decode(chunk).includes("held")) held.resolve(); })();
  void holder.exited.then((code) => held.reject(new Error(`the hold's holder exited ${code}`)));
  cleanup.push(async () => { holder.kill(); await bounded(holder.exited, 15_000); });
  await bounded(held.promise, 20_000);
}

it("refuses a state folder where an Ovis supervisor alive records itself, and starts once that owner is gone", async () => {
  const dir = state();
  marked(dir);
  const lock = join(updateStateDir(root, 7317, dir), "supervisor.lock");
  const holder = await supervisorRecord(lock);
  const before = readdirSync(dir).sort();
  // a HOME of its own: Bun itself writes into HOME, which the state folder is in the other launches
  const server = launch(dir, { HOME: scratch() });
  expect(await refused(server)).toContain(`An Ovis already runs on this state folder (lock ${lock}, owner pid ${holder.pid} generation `);
  expect(readdirSync(dir).sort()).toEqual(before);
  holder.kill();
  await bounded(holder.exited, 15_000);
  expect(existsSync(join(lock, "owner.json"))).toBe(true);
  const after = launch(dir);
  await bounded(after.ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

const spellings: [string, (home: string) => string | undefined][] = [
  ["OVIS_STATE_DIR unset", () => undefined],
  ["the default folder", (home) => join(home, ".config", "ovis")],
  ["the older default folder", (home) => join(home, ".config", "herdr-web-ui")],
  ["a trailing slash", (home) => `${join(home, ".config", "ovis")}/`],
  ["a path through ..", (home) => join(home, ".config", "herdr-web-ui", "..", "ovis")],
  ["a relative path", (home) => relative(root, join(home, ".config", "ovis"))],
  ["a symlink", (home) => { const alias = join(home, "alias"); symlinkSync(join(home, ".config", "ovis"), alias, "junction"); return alias; }],
];
it.each(spellings)("refuses a default Ovis state folder named by %s and writes nothing there", async (_, spelling) => {
  const home = scratch();
  for (const name of ["ovis", "herdr-web-ui"]) {
    mkdirSync(join(home, ".config", name), { recursive: true });
    writeFileSync(join(home, ".config", name, "devices.json"), "{}");
  }
  const server = launch(home, { HOME: home, XDG_CONFIG_HOME: undefined, OVIS_STATE_DIR: spelling(home) });
  expect(await refused(server)).toContain("default Ovis state folder");
  for (const name of ["ovis", "herdr-web-ui"]) expect(readdirSync(join(home, ".config", name))).toEqual(["devices.json"]);
});

it("removes its lease, its socket and the recorded listener when stopped cleanly", async () => {
  const dir = state();
  const server = launch(dir);
  const base = await bounded(server.ready, 20_000);
  expect(JSON.parse(readFileSync(join(dir, "serve.lock", "http.json"), "utf8"))).toEqual({ port: Number(new URL(base).port), hostname: "127.0.0.1", socket: join(realpathSync(dir), "serve.sock"), door: 1 });
  server.child.kill("SIGTERM");
  expect(await bounded(server.exited, 20_000)).toBe(0);
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
  expect(existsSync(join(dir, "serve.sock"))).toBe(false);
});

it("takes a state folder holding only an unheld serve.own, as a start killed before its mark leaves it", async () => {
  const dir = state();
  writeFileSync(join(dir, "serve.own"), "", { mode: 0o600 });
  await bounded(launch(dir).ready, 20_000);
  expect(JSON.parse(readFileSync(join(dir, "machine-profile.json"), "utf8"))).toEqual({ profile: "machine" });
});

it("refuses a state folder whose serve.own an ordinary server holds shared, as owned by another server", async () => {
  const dir = state();
  await sharedHold(join(dir, "serve.own"));
  expect(await refused(launch(dir))).toContain("already owns this Ovis state directory");
  expect(readdirSync(dir)).toEqual(["serve.own"]);
});

it("refuses a state folder an ordinary server has used, and leaves it as it was", async () => {
  const dir = state();
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  await bounded(ordinary.ready, 20_000);
  ordinary.child.kill("SIGKILL");
  await bounded(ordinary.exited, 15_000);
  const before = contents(dir);
  expect(before.length).toBeGreaterThan(0);
  const profile = launch(dir);
  expect(await bounded(profile.ready.then(() => "started", () => profile.exited), 20_000)).toBe(1);
  expect(await refused(profile)).toContain(realpathSync(dir));
  expect(contents(dir)).toEqual(before);
});

it("refuses a folder another server wrote into while the profile took its hold, and leaves what that server left", () => {
  const dir = realpathSync(state());
  guardLibrary.posix = (calls) => ({ ...calls, flock: (fd, operation) => { writeFileSync(join(dir, "telemetry.json"), "{}"); return calls.flock(fd, operation); } });
  cleanup.push(() => { delete guardLibrary.posix; });
  expect(() => claimServerState(dir)).toThrow(MachineProfileError);
  expect(readdirSync(dir)).toEqual(["telemetry.json"]);
});

it("leaves the serve.own another server made right before this start would make it, when it refuses the folder", () => {
  const dir = realpathSync(state());
  const hold = join(dir, "serve.own");
  const open = fs.openSync;
  let theirs: number | undefined;
  const made = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    if (path === hold && theirs === undefined) {
      writeFileSync(hold, "", { mode: 0o600 });
      theirs = lstatSync(hold).ino;
      writeFileSync(join(dir, "telemetry.json"), "{}");
    }
    return (open as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync);
  cleanup.push(() => { made.mockRestore(); });
  expect(() => claimServerState(dir)).toThrow(MachineProfileError);
  expect(theirs).toBeDefined();
  expect(lstatSync(hold).ino).toBe(theirs ?? -1);
  expect(readdirSync(dir).sort()).toEqual(["serve.own", "telemetry.json"]);
});

it("refuses an ordinary server whose folder a profile marked after its first look, before the device list is read", () => {
  const dir = state();
  marked(dir);
  let error: unknown;
  try {
    const server = createServer({ stateDir: dir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false });
    cleanup.push(() => server.stop());
  } catch (thrown) { error = thrown; }
  expect(String(error)).toContain(join(dir, "machine-profile.json"));
  expect(readdirSync(dir)).toEqual(["machine-profile.json"]);
});

it("refuses a state folder whose machine-profile.json is not its own, naming that file, and leaves it as it was", async () => {
  const dir = realpathSync(state());
  writeFileSync(join(dir, "machine-profile.json"), '{"profile":"other"}', { mode: 0o600 });
  const before = contents(dir);
  expect(await refused(launch(dir))).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
});

it("takes an empty state folder and marks it as its own, and starts again on the folder it marked", async () => {
  const dir = state();
  const first = launch(dir);
  await bounded(first.ready, 20_000);
  const marker = join(dir, "machine-profile.json");
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ profile: "machine" });
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  first.child.kill("SIGKILL");
  await bounded(first.exited, 15_000);
  await bounded(launch(dir).ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

it("ignores OVIS_TOKEN and says so once at its start, and names the devices paired at its own address that cannot reach it", async () => {
  const dir = state();
  const secret = "machine-contract-cookie";
  marked(dir);
  const id = cookieRow(dir, secret);
  const server = launch(dir);
  const base = await bounded(server.ready, 20_000);
  expect(server.output().split("\n").filter((line) => line.includes("OVIS_TOKEN"))).toHaveLength(1);
  expect(server.output()).toContain(id);
  for (const shape of [headers, { cookie: `ovis_device=${secret}` }]) {
    expect((await fetch(`${base}/api/session`, { headers: shape })).status).toBe(401);
    expect(await (await fetch(`${base}/api/health`, { headers: shape })).text()).toBe('{"ok":true}');
  }
  expect(await (await owner(dir, "/api/health")).json()).toMatchObject({ auth: { via: "local" } });
});

it("makes its folder 0700 and its socket 0600 under umask 002, gives the umask back, and names the socket in its lease", async () => {
  const dir = join(state(), "made");
  // a HOME of its own: Bun makes HOME's folders itself before the server runs
  const server = launch(dir, { HOME: scratch() }, "002");
  const base = await bounded(server.ready, 20_000);
  const socket = join(realpathSync(dir), "serve.sock");
  expect(statSync(dir).mode & 0o7777).toBe(0o700);
  expect(lstatSync(socket).isSocket()).toBe(true);
  expect(lstatSync(socket).mode & 0o7777).toBe(0o600);
  if (process.platform === "linux") expect(/^Umask:\s+(\d+)$/m.exec(readFileSync(`/proc/${server.child.pid}/status`, "utf8"))?.[1]).toBe("0002");
  expect(JSON.parse(readFileSync(join(dir, "serve.lock", "http.json"), "utf8"))).toEqual({ port: Number(new URL(base).port), hostname: "127.0.0.1", socket, door: 1 });
  // the kernel checks the folder at every connect, for this account too
  chmodSync(dir, 0o600);
  try {
    const connected = await Bun.connect({ unix: socket, socket: { data() {} } }).then((client) => { client.end(); return "connected"; }, (error: { code?: string }) => error.code);
    expect(connected).toBe("EACCES");
  } finally { chmodSync(dir, 0o700); }
});

const unsafe: [string, () => { told: string; looked: string }][] = [
  ["a folder above it that everyone can write", () => { const above = state(); chmodSync(above, 0o777); cleanup.push(() => chmodSync(above, 0o700)); return { told: join(above, "state"), looked: above }; }],
  ["a state folder of mode 0755", () => { const dir = state(); chmodSync(dir, 0o755); return { told: dir, looked: dir }; }],
];
it.each(unsafe)("refuses to start with %s, and writes nothing", async (_, setup) => {
  const { told, looked } = setup();
  const before = readdirSync(looked).sort();
  const sentence = await refused(launch(told, { HOME: scratch() }));
  expect(sentence).toContain(realpathSync(looked));
  expect(readdirSync(looked).sort()).toEqual(before);
});

it.skipIf(process.getuid?.() === 0)("refuses a state folder that root owns", async () => {
  const sentence = await refused(launch("/root", { HOME: scratch() }));
  expect(sentence).toContain("/root");
  expect(sentence).not.toContain("EACCES");
});

it("starts in a folder of a mktemp -d under /tmp", async () => {
  const dir = mkdtempSync("/tmp/ovis-machine-walk-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  await bounded(launch(join(dir, "state"), { HOME: scratch() }).ready, 20_000);
  expect((await owner(join(dir, "state"), "/api/health")).status).toBe(200);
});

it("refuses a state folder whose socket path would be longer than 100 bytes, and writes nothing", async () => {
  const above = realpathSync(state());
  const dir = join(above, "x".repeat(Math.max(1, 110 - above.length)));
  mkdirSync(dir, { mode: 0o700 });
  expect(Buffer.byteLength(join(dir, "serve.sock"))).toBeGreaterThan(100);
  expect(await refused(launch(dir, { HOME: scratch() }))).toContain("OVIS_STATE_DIR");
  expect(readdirSync(dir)).toEqual([]);
});

it("starts again where a killed profile left its socket", async () => {
  const dir = state();
  const first = launch(dir);
  await bounded(first.ready, 20_000);
  first.child.kill("SIGKILL");
  await bounded(first.exited, 15_000);
  expect(lstatSync(join(dir, "serve.sock")).isSocket()).toBe(true);
  const second = launch(dir);
  await bounded(second.ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

it("leaves no socket and no lease when its port is taken", async () => {
  const dir = state();
  const squatter = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  cleanup.push(() => squatter.stop(true));
  await refused(launch(dir, { PORT: String(squatter.port), HOME: scratch() }));
  expect(existsSync(join(dir, "serve.sock"))).toBe(false);
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

it("keeps an ordinary server with the preview off a folder a profile marked, running or killed, and a profile off a folder an ordinary server uses", async () => {
  const dir = state();
  // a HOME of its own for each: Bun and the programs a server asks write into HOME
  const profile = launch(dir, { HOME: scratch() });
  await bounded(profile.ready, 20_000);
  const before = readdirSync(dir).sort();
  expect(await refused(launch(dir, { OVIS_PROFILE: "", HOME: scratch() }))).toContain(join(dir, "machine-profile.json"));
  expect(readdirSync(dir).sort()).toEqual(before);
  profile.child.kill("SIGKILL");
  await bounded(profile.exited, 15_000);
  // a killed profile holds nothing, but the folder it marked is still its own
  expect(await refused(launch(dir, { OVIS_PROFILE: "", HOME: scratch() }))).toContain(join(dir, "machine-profile.json"));
  const other = state();
  const ordinary = launch(other, { OVIS_PROFILE: "", HOME: scratch() });
  const base = await bounded(ordinary.ready, 20_000);
  await refused(launch(other, { HOME: scratch() }));
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("refuses an ordinary server without the preview on a folder a profile runs on, leaves the folder as it was, and the profile keeps answering", async () => {
  const dir = state();
  const profile = launch(dir);
  await bounded(profile.ready, 20_000);
  const before = contents(dir);
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  expect(await bounded(ordinary.ready.then(() => "started", () => ordinary.exited), 20_000)).toBe(1);
  expect(await refused(ordinary)).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

it("refuses an ordinary server without the preview on a folder a stopped profile marked, and leaves it as it was", async () => {
  const dir = state();
  const profile = launch(dir);
  await bounded(profile.ready, 20_000);
  profile.child.kill("SIGTERM");
  expect(await bounded(profile.exited, 20_000)).toBe(0);
  const before = contents(dir);
  expect(before.map(([name]) => name)).toContain("machine-profile.json");
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  expect(await bounded(ordinary.ready.then(() => "started", () => ordinary.exited), 20_000)).toBe(1);
  expect(await refused(ordinary)).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
});

it("starts an ordinary server without the preview on a folder whose machine-profile.json is a FIFO, as main does", async () => {
  const dir = state();
  // opened for reading, a FIFO would wait for a writer that never comes
  expect(Bun.spawnSync(["mkfifo", join(dir, "machine-profile.json")]).exitCode).toBe(0);
  const base = await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined }).ready, 20_000);
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("starts an ordinary server without the preview beside a machine-profile.json that is not a profile's marker", async () => {
  const dir = state();
  writeFileSync(join(dir, "machine-profile.json"), '{"profile":"other"}', { mode: 0o600 });
  const base = await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined }).ready, 20_000);
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("lets exactly one of a profile and an ordinary server started at the same moment on one folder run", async () => {
  const pairs = Array.from({ length: 5 }, () => {
    const dir = state();
    return [launch(dir, { HOME: scratch() }), launch(dir, { OVIS_PROFILE: "", HOME: scratch() })];
  });
  const outcomes = await Promise.all(pairs.map((started) => Promise.all(started.map((server) => bounded(server.ready.then(() => "ready", () => server.exited), 30_000)))));
  await Promise.all(pairs.flat().map((server) => { server.child.kill("SIGKILL"); return bounded(server.exited, 15_000); }));
  for (const outcome of outcomes) expect(outcome.filter((one) => one === "ready")).toHaveLength(1);
});

it("starts an ordinary server whose hold cannot be taken for another reason, and refuses a profile there", async () => {
  const dir = state();
  mkdirSync(join(dir, "serve.own"));
  const ordinary = launch(dir, { OVIS_PROFILE: "", HOME: scratch() });
  await bounded(ordinary.ready, 20_000);
  expect(ordinary.errors()).toContain(join(dir, "serve.own"));
  ordinary.child.kill("SIGTERM");
  await bounded(ordinary.exited, 20_000);
  marked(dir);
  expect(await refused(launch(dir, { HOME: scratch() }))).toContain("serve.own");
});
