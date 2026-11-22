import { afterAll, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { coreFolder, corePids, IsolatedCore, isolatedHcEnv, isolationProblem, recordStaleStartForTest, signalChildGroup, stopTestCores, stoppedCleanly } from "./test-hc.ts";

// A stand-in hc that writes down how it was run: no real core is started or stopped.
const root = mkdtempSync(join(tmpdir(), "ovis-test-hc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const record = join(root, "ran");
const bin = join(root, "hc");
writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$HC_SOCKET" "$OVIS_CANARY" >> ${JSON.stringify(record)}\n`);
chmodSync(bin, 0o755);
const ran = () => (existsSync(record) ? readFileSync(record, "utf8") : "");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** a detached sleeper that stands in for a core or a holder of the core `env` names: its environment names that core's socket, as theirs does */
const sleeper = async (env: Record<string, string>) => Number((await new Response(Bun.spawn(["/bin/sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { env: { PATH: "/usr/bin:/bin", HC_SOCKET: env["HC_SOCKET"]! }, stdout: "pipe" }).stdout).text()).trim());
/** a stand-in hc whose status names `pids` as the core and its holders, and whose stop does nothing */
const naming = (name: string, [core, ...holders]: number[]) => {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n[ "$1 $2" = "server status" ] && echo '${JSON.stringify({ pid: core, holders: holders.map((pid) => ({ pid })) })}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
};
/** a stand-in hc that answers nothing and whose stop does nothing */
const silent = join(root, "hc-silent");
writeFileSync(silent, "#!/bin/sh\nexit 0\n");
chmodSync(silent, 0o755);
/** an isolated environment whose socket file is there, as a running core's is */
const withSocket = (name: string) => {
  const env = isolatedHcEnv(join(root, name));
  mkdirSync(join(root, name, "run"), { recursive: true });
  writeFileSync(env["HC_SOCKET"], "");
  return env;
};
// a pid is proven to be a core's only through /proc: where there is none, nothing is killed
const proc = existsSync("/proc/self/stat");

it.skipIf(!proc)("reads the holder again before a stop, and kills and names what outlived the stop", async () => {
  // this stand-in's stop leaves the core, the holder it got after its start, and the socket
  const env = withSocket("stuck");
  const [core, holder] = [await sleeper(env), await sleeper(env)];
  expect(await stopTestCores(naming("hc-stuck", [core, holder]), [{ env, pids: [core] }], 200)).toEqual({ stopped: [0], killed: [core, holder], unproven: [], socketsLeft: [env["HC_SOCKET"]] });
  expect([core, holder].filter(alive)).toEqual([]);
});

it.skipIf(!proc)("ends what one core left before the next core is stopped, as a running first core would start the next again", async () => {
  const [first, next] = [withSocket("first"), withSocket("next")];
  const left = await sleeper(first);
  const seen = join(root, "seen-at-next-stop");
  // its status names the first core's leftover; its stop removes the socket, as hc's does, and at the next core's
  // stop writes down whether that leftover still runs
  const two = join(root, "hc-two");
  writeFileSync(two, `#!/bin/sh\n[ "$1 $2" = "server status" ] && echo '{"pid":${left},"holder":null}'\nif [ "$1 $2" = "server stop" ]; then\n  rm -f "$HC_SOCKET"\n  if [ "$HC_SOCKET" = "${next["HC_SOCKET"]}" ]; then if kill -0 ${left} 2>/dev/null; then echo running > ${JSON.stringify(seen)}; else echo gone > ${JSON.stringify(seen)}; fi; fi\nfi\nexit 0\n`);
  chmodSync(two, 0o755);
  expect(await stopTestCores(two, [{ env: first, pids: [left] }, { env: next, pids: [] }], 200)).toEqual({ stopped: [0, 0], killed: [left], unproven: [], socketsLeft: [] });
  expect(readFileSync(seen, "utf8")).toBe("gone\n");
});

it("kills no recorded pid that is now a process of another core, and names it unproven", async () => {
  const env = withSocket("intended");
  // what a recorded pid would be once its number went to another core: the status names it, so its start time is recorded
  const stranger = Bun.spawn(["sleep", "30"], { env: isolatedHcEnv(join(root, "other")) });
  try {
    const result = await stopTestCores(naming("hc-other", [stranger.pid]), [{ env, pids: [stranger.pid] }], 200);
    expect({ result, alive: alive(stranger.pid) }).toEqual({ result: { stopped: [0], killed: [], unproven: [stranger.pid], socketsLeft: [env["HC_SOCKET"]] }, alive: true });
    // an unproven pid is a leak: the stop was not clean
    expect(stoppedCleanly({ pids: [stranger.pid], killed: [], unproven: [stranger.pid], alive: [], socketGone: true, rootGone: true })).toBe(false);
  } finally {
    stranger.kill();
    await stranger.exited;
  }
});

it("kills no pid that no status named, even one started in the core's own environment, and names it unproven", async () => {
  const env = withSocket("unnamed");
  // this stand-in's status prints nothing, so no start time is recorded for the pid the test passes in
  const stranger = Bun.spawn(["sleep", "30"], { env });
  try {
    const result = await stopTestCores(silent, [{ env, pids: [stranger.pid] }], 200);
    expect({ result, alive: alive(stranger.pid) }).toEqual({ result: { stopped: [0], killed: [], unproven: [stranger.pid], socketsLeft: [env["HC_SOCKET"]] }, alive: true });
  } finally {
    stranger.kill();
    await stranger.exited;
  }
});

it.skipIf(!proc)("proves a core started without HC_SOCKET by the socket its session and runtime folder name", async () => {
  const { HC_SOCKET: _named, ...unnamed } = isolatedHcEnv(join(root, "unnamed"));
  // where hc puts the socket of a core started without HC_SOCKET, and that socket's file, as a running core's is there
  const socket = join(unnamed["XDG_RUNTIME_DIR"], "herdr-core", `${unnamed["HC_SESSION"]}.sock`);
  mkdirSync(join(unnamed["XDG_RUNTIME_DIR"], "herdr-core"), { recursive: true });
  writeFileSync(socket, "");
  // a core started so, and a process of the same session in another runtime folder
  const core = Bun.spawn(["sleep", "30"], { env: unnamed });
  const other = Bun.spawn(["sleep", "30"], { env: { ...unnamed, XDG_RUNTIME_DIR: join(root, "elsewhere-run") } });
  try {
    const result = await stopTestCores(naming("hc-unnamed", [core.pid, other.pid]), [{ env: { ...unnamed, HC_SOCKET: socket }, pids: [core.pid, other.pid] }], 200);
    expect({ killed: result.killed, unproven: result.unproven, alive: [core.pid, other.pid].filter(alive) }).toEqual({ killed: [core.pid], unproven: [other.pid], alive: [other.pid] });
  } finally {
    for (const sleep of [core, other]) sleep.kill();
    await Promise.all([core.exited, other.exited]);
  }
});

it("kills no recorded pid whose start time is not the one recorded with it", async () => {
  const env = withSocket("restarted");
  // a sleep whose environment names the core's socket, as the core's own does: only its start time tells it apart
  const other = Bun.spawn(["sleep", "30"], { env: { PATH: "/usr/bin:/bin", HC_SOCKET: env["HC_SOCKET"] } });
  try {
    expect(await corePids(naming("hc-restarted", [other.pid]), env)).toEqual([other.pid]);
    // what a pid recorded for a process that has since ended and whose number came back would carry
    recordStaleStartForTest(other.pid);
    const result = await stopTestCores(silent, [{ env, pids: [other.pid] }], 200);
    expect({ result, alive: alive(other.pid) }).toEqual({ result: { stopped: [0], killed: [], unproven: [other.pid], socketsLeft: [env["HC_SOCKET"]] }, alive: true });
  } finally {
    other.kill();
    await other.exited;
  }
});

it.skipIf(!proc)("signals a child's process group only while the child is not reaped, and never a pid that cannot be its own group", async () => {
  // a child that leads a group of its own (detached) and leaves a member in it, which ends when the child's stdin closes
  const child = Bun.spawn(["sh", "-c", "exec 3<&0; cat <&3 >/dev/null & echo $!"], { env: { PATH: "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true });
  try {
    const member = Number((await new Response(child.stdout).text()).trim());
    await child.exited;
    // the child is reaped: its pid, and so its group's, may belong to someone else by now
    expect({ sent: signalChildGroup(child, "SIGTERM"), memberAlive: alive(member) }).toEqual({ sent: false, memberAlive: true });
  } finally {
    child.stdin.end();
  }
  // a reaped child whose number now leads another group: a detached sleep of the test's own stands in for that group
  const reused = Bun.spawn(["sleep", "30"], { env: { PATH: "/usr/bin:/bin" }, detached: true });
  try {
    expect({ sent: signalChildGroup({ pid: reused.pid, exitCode: 0, signalCode: null }, "SIGTERM"), alive: alive(reused.pid) }).toEqual({ sent: false, alive: true });
  } finally {
    reused.kill();
    await reused.exited;
  }
  // signal 0 only asks, so even a wrong answer here signals no one
  const ownGroup = Number(readFileSync("/proc/self/stat", "latin1").split(") ")[1]!.split(" ")[2]);
  const unreaped = { exitCode: null, signalCode: null };
  for (const pid of [undefined, 0, 1, ownGroup]) expect({ pid, sent: signalChildGroup({ ...unreaped, pid: pid as number }, 0) }).toEqual({ pid, sent: false });
});

it("refuses, before any hc command, an environment that names no core of its own", async () => {
  rmSync(record, { force: true });
  // without HC_SOCKET and HC_SESSION, hc server stop there would stop the user's default core
  const users = { PATH: "/usr/bin:/bin", HOME: join(root, "home") };
  for (const env of [users, {}, { ...isolatedHcEnv(join(root, "named")), HC_SESSION: "default" }]) {
    expect(await stopTestCores(bin, [{ env, pids: [] }]).then(() => "stopped", () => "refused")).toBe("refused");
  }
  // nor is an isolated core stopped first when another of the list is not one
  expect(await stopTestCores(bin, [{ env: withSocket("own"), pids: [] }, { env: users, pids: [] }]).then(() => "stopped", () => "refused")).toBe("refused");
  expect(ran()).toBe("");
});

// the child's startup PATH has the stand-in first, so a spawn of `hc` by name finds it with env or without
it.skipIf(process.platform === "win32")("refuses the user's own core before any hc command, whatever names it", async () => {
  rmSync(record, { force: true });
  const dir = join(root, "users");
  const standIns = join(dir, "bin");
  mkdirSync(standIns, { recursive: true });
  const log = join(dir, "hc.log");
  writeFileSync(join(standIns, "hc"), `#!/bin/sh\necho "hc $*" >> '${log}'\n`);
  chmodSync(join(standIns, "hc"), 0o755);
  const child = join(dir, "child.ts");
  // HC_SOCKET is the default core socket of the child's own (scratch) HOME and runtime folder: what userCore recognises
  writeFileSync(child, [
    `import { corePids, IsolatedCore, stopTestCores } from ${JSON.stringify(join(import.meta.dir, "test-hc.ts"))};`,
    "const env = { PATH: process.env.PATH!, HC_SESSION: \"t1\", HC_SOCKET: `${process.env.XDG_RUNTIME_DIR}/herdr-core/default.sock` };",
    "const tries: [string, () => Promise<unknown>][] = [",
    "  [\"stop\", () => stopTestCores(\"hc\", [{ env, pids: [] }], 200)],",
    "  [\"pids\", () => corePids(\"hc\", env)],",
    `  ["core", async () => new IsolatedCore("hc", { root: ${JSON.stringify(dir)}, env })],`,
    "];",
    "for (const [name, attempt] of tries) console.log(`${name} ${await attempt().then(() => \"ran\", () => \"refused\")}`);",
    "await Bun.spawn([\"hc\", \"control\"], { stdout: \"ignore\" }).exited;",
  ].join("\n"));
  const run = Bun.spawn([process.execPath, child], {
    env: { PATH: `${standIns}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: join(dir, "home"), XDG_RUNTIME_DIR: join(dir, "run"), TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect({ code, err, out: out.trim().split("\n") }).toEqual({ code: 0, err: "", out: ["stop refused", "pids refused", "core refused"] });
  // the stand-in saw the control spawn and nothing of the helper's
  expect(readFileSync(log, "utf8")).toBe("hc control\n");
  expect(ran()).toBe("");
});

it("refuses a core whose socket is outside the folder it was given", () => {
  const folder = join(root, "given");
  expect(() => new IsolatedCore(bin, { root: folder, env: isolatedHcEnv(join(root, "elsewhere")) })).toThrow();
});

it("refuses a socket or folder that names the core's folder on its way out of it", () => {
  const folder = join(root, "climb");
  const env = isolatedHcEnv(folder);
  expect(isolationProblem(env, folder)).toBeNull();
  expect(isolationProblem({ ...env, HC_SOCKET: `${folder}/../elsewhere/run/hc.sock` }, folder)).not.toBeNull();
  expect(isolationProblem({ ...env, XDG_STATE_HOME: `${folder}/run/../../elsewhere` }, folder)).not.toBeNull();
  expect(isolationProblem({ ...env, HOME: `${folder}-sibling/home` }, folder)).not.toBeNull();
});

it("keeps the folder of a core whose stop left its socket, so its report is not a clean stop", async () => {
  const core = new IsolatedCore(silent, coreFolder(root));
  mkdirSync(dirname(core.socket), { recursive: true });
  writeFileSync(core.socket, "");
  try {
    const report = await core.stop();
    expect({ socketGone: report.socketGone, rootGone: report.rootGone, clean: stoppedCleanly(report) }).toEqual({ socketGone: false, rootGone: false, clean: false });
  } finally {
    rmSync(core.root, { recursive: true, force: true });
  }
}, 20_000);

it("runs no hc command of a core whose environment stopped being isolated", () => {
  rmSync(record, { force: true });
  const core = new IsolatedCore(bin, coreFolder(root));
  try {
    // checked on every command, not only when the core was made
    core.env["HC_SOCKET"] = join(root, "elsewhere.sock");
    expect(() => core.hc(["server", "status", "--json"])).toThrow();
    expect(ran()).toBe("");
  } finally {
    rmSync(core.root, { recursive: true, force: true });
  }
});

it("refuses a folder whose socket path is longer than the OS takes, and leaves nothing of it", () => {
  const deep = join(root, "d".repeat(Math.max(1, 108 - root.length)));
  mkdirSync(deep);
  expect(() => coreFolder(deep)).toThrow();
  expect(readdirSync(deep)).toEqual([]);
});

it("waits for the socket of a core it has no pid for, and names one that stays", async () => {
  const env = withSocket("pidless");
  // a core that goes a moment after its stop answered, and one whose stop leaves its socket
  const late = join(root, "hc-late");
  writeFileSync(late, `#!/bin/sh\n(sleep 0.3; rm -f "$HC_SOCKET") >/dev/null 2>&1 &\nexit 0\n`);
  const stays = join(root, "hc-stays");
  writeFileSync(stays, "#!/bin/sh\nexit 0\n");
  for (const stand of [late, stays]) chmodSync(stand, 0o755);
  expect(await stopTestCores(late, [{ env, pids: [] }])).toEqual({ stopped: [0], killed: [], unproven: [], socketsLeft: [] });
  expect(existsSync(env["HC_SOCKET"])).toBe(false);
  writeFileSync(env["HC_SOCKET"], "");
  expect(await stopTestCores(stays, [{ env, pids: [] }], 200)).toEqual({ stopped: [0], killed: [], unproven: [], socketsLeft: [env["HC_SOCKET"]] });
});

it("waits for the core's pids after its socket went, and kills nothing that ends within the wait", async () => {
  const env = withSocket("early");
  // a stand-in core that ends by itself once its stop writes to this fifo: nothing signals it
  const fifo = join(root, "early-stop");
  expect(Bun.spawnSync(["mkfifo", fifo], { env: { PATH: "/usr/bin:/bin" } }).exitCode).toBe(0);
  const core = Bun.spawn(["sh", "-c", 'read _ < "$0"', fifo], { env: { PATH: "/usr/bin:/bin", HC_SOCKET: env["HC_SOCKET"] } });
  // its stop removes the socket at once and lets the core go a moment after the stop returned, as hc's own stop does:
  // that delay is the behaviour under test (the helper must wait for the pid, not only for the socket)
  const early = join(root, "hc-early");
  writeFileSync(early, `#!/bin/sh\ncase "$1 $2" in\n  "server status") echo '{"pid":${core.pid},"holder":null}' ;;\n  "server stop") rm -f "$HC_SOCKET"; (sleep 0.3; timeout 20 sh -c 'echo go > "$0"' '${fifo}') >/dev/null 2>&1 & ;;\nesac\nexit 0\n`);
  chmodSync(early, 0o755);
  try {
    expect(await stopTestCores(early, [{ env, pids: [core.pid] }])).toEqual({ stopped: [0], killed: [], unproven: [], socketsLeft: [] });
    expect({ exitCode: core.exitCode, signalCode: core.signalCode }).toEqual({ exitCode: 0, signalCode: null });
  } finally {
    core.kill();
    await core.exited;
  }
});

it.skipIf(!proc)("asks no status of a core whose pids live but whose socket is gone: status there could start a core", async () => {
  rmSync(record, { force: true });
  const env = isolatedHcEnv(join(root, "socketless"));
  const living = await sleeper(env);
  // recorded as a caller records a core it started: from that core's status, while it ran
  await corePids(naming("hc-socketless", [living]), env);
  expect(await stopTestCores(bin, [{ env, pids: [living] }], 200)).toEqual({ stopped: [0], killed: [living], unproven: [], socketsLeft: [] });
  expect(ran()).toBe(`server stop|${env["HC_SOCKET"]}|\n`);
});

it.skipIf(!proc)("asks a core's status only while every recorded pid lives and its socket is there, and runs nothing when no core is left", async () => {
  rmSync(record, { force: true });
  const env = withSocket("half");
  const living = await sleeper(env);
  await corePids(naming("hc-half", [living]), env);
  const ended = Bun.spawn(["/bin/true"], { env: { PATH: "/usr/bin:/bin" } });
  await ended.exited;
  const gone = ended.pid;
  // one pid gone: status there could start a core, so only the stop runs, and the living pid is killed
  expect(await stopTestCores(bin, [{ env, pids: [living, gone] }], 200)).toEqual({ stopped: [0], killed: [living], unproven: [], socketsLeft: [env["HC_SOCKET"]] });
  expect(ran()).toBe(`server stop|${env["HC_SOCKET"]}|\n`);
  // no pid alive and no socket: no hc command at all
  rmSync(record, { force: true });
  expect(await stopTestCores(bin, [{ env: isolatedHcEnv(join(root, "none")), pids: [gone] }], 200)).toEqual({ stopped: [null], killed: [], unproven: [], socketsLeft: [] });
  expect(ran()).toBe("");
});

it("stops the test's own core, in its environment alone", async () => {
  rmSync(record, { force: true });
  process.env["OVIS_CANARY"] = "inherited";
  try {
    const env = withSocket("core");
    await stopTestCores(bin, [{ env, pids: [] }], 200);
    expect(ran()).toBe(`server stop|${env["HC_SOCKET"]}|\n`);
  } finally {
    delete process.env["OVIS_CANARY"];
  }
});
