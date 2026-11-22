import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { corePids, isolatedHcEnv, stopTestCores, type TestCore } from "../../scripts/test-hc.ts";
import { HcConnection, HcError } from "./connection.ts";
import { coreSocket } from "./core-socket.ts";
import { connectCoreSocket } from "./socket-transport.ts";

/**
 * The socket transport against a real hc, in a core of its own (isolatedHcEnv) found without
 * HC_SOCKET, as hc finds it from HC_SESSION and XDG_RUNTIME_DIR. Runs only where OVIS_TEST_HC_BIN
 * names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

const WAIT_MS = 5000;
/** each test and hook outlasts its own bounded waits and calls, so a failure names the wait that ran out */
const TEST_MS = 30_000;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const output = async (args: string[], env: Record<string, string>) => {
  const proc = Bun.spawn([bin!, ...args], { env, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect({ args, code }).toEqual({ args, code: 0 });
  return out;
};

describe.skipIf(!bin || process.platform === "win32")("the socket transport against a real hc", () => {
  let root = "";
  /** set before the core is started, so the teardown stops whatever the start left */
  let core: TestCore | null = null;
  /** the core's environment without HC_SOCKET: hc and coreSocket work out its socket from HC_SESSION and XDG_RUNTIME_DIR */
  let plain: Record<string, string> = {};
  const lines: HcConnection[] = [];
  /** the one teardown: the test that stops the core and afterAll both await it */
  let teardown: ReturnType<typeof stopTestCores> | null = null;
  const stopCore = () => (teardown ??= core ? stopTestCores(bin!, [core], WAIT_MS) : Promise.resolve({ stopped: [], killed: [], unproven: [], socketsLeft: [] }));
  /** a signal ends `bun test` without running afterAll: the same teardown runs first */
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => {
    void stopCore().finally(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      process.exit(128 + constants.signals[signal]);
    });
  };
  const failureOf = (path: string) => connectCoreSocket(path).then(
    (transport) => { transport.kill(); return "connected"; },
    (error: unknown) => (error instanceof HcError ? error.kind : String(error)),
  );

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ovis-hc-"));
    for (const sub of ["state", "config", "run", "home"]) mkdirSync(join(root, sub), { mode: 0o700 });
    const { HC_SOCKET: _named, ...env } = isolatedHcEnv(root);
    plain = env;
    // the helper runs hc only in an environment that names its socket: the one the rule gives
    core = { env: { ...env, HC_SOCKET: coreSocket({ env }).path }, pids: [] };
    for (const signal of SIGNALS) process.once(signal, onSignal);
    await output(["server", "start"], env);
    core.pids = await corePids(bin!, core.env);
  }, TEST_MS);

  afterAll(async () => {
    for (const hc of lines) hc.close();
    const { stopped, killed, unproven, socketsLeft } = await stopCore();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    // only once its pids are gone: a late hc child would otherwise run whatever hc PATH finds
    if (root) rmSync(root, { recursive: true, force: true });
    expect({ stopped, killed, unproven, socketsLeft }).toEqual({ stopped: core ? [0] : [], killed: [], unproven: [], socketsLeft: [] });
  }, TEST_MS);

  it("coreSocket finds this core's socket without HC_SOCKET", async () => {
    const found = coreSocket({ env: plain });
    expect(found.path.startsWith(root)).toBe(true);
    const transport = await connectCoreSocket(found.path);
    const hc = new HcConnection(() => transport);
    lines.push(hc);
    const status = JSON.parse(await output(["server", "status", "--json"], core!.env)) as { core: { id: string } };
    expect((await hc.hello()).core.id).toBe(status.core.id);
  }, TEST_MS);

  it("answers hello through HcConnection in generation 1 with the core's version", async () => {
    const transport = await connectCoreSocket(coreSocket({ env: plain }).path);
    const hc = new HcConnection(() => transport);
    lines.push(hc);
    const hello = await hc.hello();
    expect(`hc ${hello.version}`).toBe((await output(["--version"], core!.env)).trim());
    expect((await hc.call("terminal.list", {})).terminals).toEqual([]);
  }, TEST_MS);

  it("gives no_core once the core is stopped, and starts none", async () => {
    const path = coreSocket({ env: plain }).path;
    expect(await stopCore()).toEqual({ stopped: [0], killed: [], unproven: [], socketsLeft: [] });
    expect(await failureOf(path)).toBe("no_core");
    expect(coreSocket({ env: plain }).running).toBe(false);
    expect(core!.pids.filter(alive)).toEqual([]);
  }, TEST_MS);
});
