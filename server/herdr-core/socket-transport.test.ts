import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import { HcError, type HcTransport } from "./connection.ts";
import { coreSocket } from "./core-socket.ts";
import { connectCoreSocket } from "./socket-transport.ts";

const WAIT_MS = 5000;
/**
 * Set only in the `bun test` of this file that the last block runs in a folder of its own, whose bin/
 * (stand-ins for hc, herdr-core and herdr) comes first on that bun's startup PATH: every case that calls
 * the transport runs there, so a transport that spawned hc by name, with env or without, could only
 * reach a stand-in, never a real hc from this test's own process.
 */
const standInRun = process.env["OVIS_STANDIN_RUN"];
/** the cases of the first block: the last block checks that the stand-in run passed every one */
const TRANSPORT_CASES = 7;

// a unix socket for the core: the Windows pipe is reached by the same Bun.connect
describe.skipIf(process.platform === "win32" || standInRun === undefined)("the socket transport", () => {
  /** short: a unix socket path must stay within the OS's 107 bytes */
  const dir = standInRun!;
  const NAMES = ["HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "HC_SOCKET", "HC_SESSION", "HERDR_TEST_SESSION", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR"] as const;
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  const listeners: UnixSocketListener<undefined>[] = [];
  const transports: HcTransport[] = [];

  const waiters = new Set<{ check: () => boolean; resolve: () => void }>();
  const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  const until = (label: string, check: () => boolean): Promise<void> => {
    if (check()) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`no ${label} within ${WAIT_MS}ms`)); }, WAIT_MS);
    waiters.add(waiter);
    return promise;
  };

  /** a core stand-in: what it was sent, and its open connections */
  const listen = (path: string) => {
    const got: Uint8Array[] = [];
    const peers: Socket<undefined>[] = [];
    let closed = 0;
    const listener = Bun.listen({
      unix: path,
      socket: {
        open: (socket) => { peers.push(socket); wake(); },
        data: (_socket, chunk) => { got.push(new Uint8Array(chunk)); wake(); },
        close: () => { closed++; wake(); },
      },
    });
    listeners.push(listener);
    return { listener, got, peers, closed: () => closed, bytes: () => Buffer.concat(got) };
  };
  const connect = async (path: string) => {
    const transport = await connectCoreSocket(path);
    transports.push(transport);
    return transport;
  };
  const failureOf = (path?: string) => connectCoreSocket(path).then(
    (transport) => { transports.push(transport); return null; },
    (error: unknown) => (error instanceof HcError ? error.kind : String(error)),
  );

  afterEach(() => {
    for (const transport of transports.splice(0)) transport.kill();
    for (const listener of listeners.splice(0)) listener.stop(true);
    for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  it("carries frames to the socket byte for byte and in order, and the socket's bytes to readable", async () => {
    const path = join(dir, "rt.sock");
    const core = listen(path);
    const transport = await connect(path);
    // more than a socket buffer takes at once, so some writes wait for the socket to drain
    const frames = Array.from({ length: 64 }, (_, at) => new Uint8Array(at === 32 ? 4 * 1024 * 1024 : 1 + at * 97).fill(at));
    for (const frame of frames) transport.write(frame);
    const sent = Buffer.concat(frames);
    await until(`${sent.length} bytes at the socket`, () => core.bytes().length >= sent.length);
    expect(core.bytes().equals(sent)).toBe(true);

    const reader = transport.readable.getReader();
    const answer = new TextEncoder().encode("hello back\n");
    await until("the transport's connection", () => core.peers.length === 1);
    core.peers[0]!.write(answer);
    const read: Uint8Array[] = [];
    while (Buffer.concat(read).length < answer.length) {
      const { done, value } = await reader.read();
      if (done) break;
      read.push(value);
    }
    expect(Buffer.concat(read).equals(Buffer.from(answer))).toBe(true);
    reader.releaseLock();
  });

  it("missing socket file gives no_core", async () => {
    expect(await failureOf(join(dir, "absent.sock"))).toBe("no_core");
  });

  it("stale socket file refuses", async () => {
    const live = join(dir, "live.sock");
    const stale = join(dir, "stale.sock");
    const core = listen(live);
    // a stopped listener removes its file; a second name keeps it, as a core that was killed leaves its socket
    linkSync(live, stale);
    core.listener.stop(true);
    expect(existsSync(stale)).toBe(true);
    expect(await failureOf(stale)).toBe("no_core");
  });

  it("kill closes the socket and settles exited", async () => {
    const path = join(dir, "kill.sock");
    const core = listen(path);
    const transport = await connect(path);
    await until("the transport's connection", () => core.peers.length === 1);
    let settled = false;
    void transport.exited.then(() => { settled = true; wake(); });
    transport.kill();
    await until("exited", () => settled);
    await until("the socket's close at the core", () => core.closed() === 1);
    expect((await transport.readable.getReader().read()).done).toBe(true);
  });

  it("settles exited on kill after the reader was cancelled", async () => {
    const path = join(dir, "cancel.sock");
    const core = listen(path);
    const transport = await connect(path);
    await until("the transport's connection", () => core.peers.length === 1);
    let settled = false;
    void transport.exited.then(() => { settled = true; wake(); });
    await transport.readable.getReader().cancel();
    transport.kill();
    await until("exited", () => settled);
  });

  it("settles exited and ends readable when the core closes the socket", async () => {
    const path = join(dir, "end.sock");
    const core = listen(path);
    const transport = await connect(path);
    await until("the transport's connection", () => core.peers.length === 1);
    let settled = false;
    void transport.exited.then(() => { settled = true; wake(); });
    core.peers[0]!.end();
    await until("exited", () => settled);
    expect((await transport.readable.getReader().read()).done).toBe(true);
  });

  it("the test-session guard refuses the user's default socket", async () => {
    // the user's default socket is under this test's own folders: a guard that let it through finds no core there
    process.env["HOME"] = join(dir, "home");
    process.env["XDG_RUNTIME_DIR"] = join(dir, "run");
    process.env["XDG_CONFIG_HOME"] = join(dir, "config");
    for (const name of ["HC_SOCKET", "HC_SESSION", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR"]) delete process.env[name];
    process.env["HERDR_TEST_SESSION"] = "ovis-test-guard";
    const userDefault = coreSocket().path;
    expect(userDefault.startsWith(dir)).toBe(true);
    expect(await failureOf()).toBe("live_core_refused");
    // another spelling of the same socket
    expect(await failureOf(join(dir, "run", "herdr-core", "..", "herdr-core", "default.sock"))).toBe("live_core_refused");
    // a core of the test's own is not the user's
    expect(await failureOf(join(dir, "own.sock"))).toBe("no_core");
    // said out loud, the user's own core may be reached
    process.env["OVIS_ALLOW_LIVE_HERDR"] = "1";
    expect(await failureOf(userDefault)).toBe("no_core");
  });
});

describe.skipIf(process.platform === "win32" || standInRun !== undefined)("the socket transport, called only where a spawn of hc by name finds a stand-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "r9-"));
  /** the stand-ins' log: one line per run of `hc`, `herdr-core` or `herdr` by name, with its arguments */
  const hcLog = join(dir, "hc.log");
  /** starts hc by name both ways, as a regressed transport would */
  const controlScript = join(dir, "control.ts");
  const hcRuns = () => (existsSync(hcLog) ? readFileSync(hcLog, "utf8") : "");
  /** processes still running from a stand-in run: each inherits its OVIS_STANDIN_RUN, whichever way it was spawned */
  const fromStandInRun = () => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").includes(`OVIS_STANDIN_RUN=${dir}\0`); } catch { return false; }
  });

  /**
   * Runs `bun <args>` with a startup environment built here: the stand-ins first on PATH (a spawn of hc,
   * herdr-core or herdr by name finds them whether or not it passes `env`), a scratch HOME, and no herdr
   * of the tests' own (HERDR_TEST_MODE=unit). Where /proc tells it, returns only once every process of the
   * run has ended, so a spawn nobody awaited has written its line. A spawn by absolute path is not seen
   * here; server/conventions.test.ts finds any process start in the transport's imports.
   */
  const runInStandIns = async (...args: string[]): Promise<{ code: number; out: string }> => {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: join(dir, "home"), TMPDIR: dir, OVIS_STANDIN_RUN: dir, HERDR_TEST_MODE: "unit" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (process.platform === "linux") {
      const deadline = Date.now() + WAIT_MS;
      while (fromStandInRun().length > 0) {
        if (Date.now() > deadline) throw new Error(`processes of the stand-in run still running after ${WAIT_MS}ms: ${fromStandInRun().join(", ")}`);
        await Bun.sleep(25);
      }
    }
    return { code, out: `${out}${err}` };
  };

  beforeAll(() => {
    mkdirSync(join(dir, "bin"));
    for (const name of ["hc", "herdr-core", "herdr"]) {
      writeFileSync(join(dir, "bin", name), `#!/bin/sh\necho "${name} $*" >> '${hcLog}'\n`);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    writeFileSync(controlScript, [
      "Bun.spawn([\"hc\", \"with-env\"], { env: process.env, stdout: \"ignore\", stderr: \"ignore\" });",
      "Bun.spawn([\"hc\", \"without-env\"], { stdout: \"ignore\", stderr: \"ignore\" });",
    ].join("\n"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // waiting for the run's processes needs /proc
  it.skipIf(process.platform !== "linux")("the stand-in sees a spawn of hc by name, with env and without", async () => {
    expect(await runInStandIns(controlScript)).toEqual({ code: 0, out: "" });
    expect(hcRuns().split("\n").filter(Boolean).sort()).toEqual(["hc with-env", "hc without-env"]);
    rmSync(hcLog);
  });

  it("passes every case that calls the transport there, and none of them runs hc, herdr-core or herdr", async () => {
    const { code, out } = await runInStandIns("test", import.meta.path);
    const passed = Number(out.match(/^\s*(\d+) pass$/m)?.[1] ?? 0);
    expect({ code, passed, out: code === 0 && passed === TRANSPORT_CASES ? "" : out }).toEqual({ code: 0, passed: TRANSPORT_CASES, out: "" });
    expect(hcRuns()).toBe("");
  });
});
