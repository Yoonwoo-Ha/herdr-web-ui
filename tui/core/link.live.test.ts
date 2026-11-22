import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { coreFolder, IsolatedCore, type StopReport, stoppedCleanly } from "../../scripts/test-hc.ts";
import { RECONNECT_FIRST_MS } from "../model/deadlines.ts";
import { type CoreLink, type LinkNotice, openLink } from "./link.ts";

/**
 * The link against a real hc, in cores of the test's own (IsolatedCore): it comes up, follows a
 * terminal it started, goes Offline when its core is stopped and starts none while it retries, and
 * comes up again in a new epoch on a new core at the same socket. Runs only where OVIS_TEST_HC_BIN
 * names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

const WAIT_MS = 5000;
/** above twice the helper's own 10 s wait for a stopped core */
const TEST_MS = 60_000;

describe.skipIf(!bin || process.platform === "win32")("the core link against a real hc", () => {
  const cores: IsolatedCore[] = [];
  let link: CoreLink | null = null;
  /** the one teardown: the test, afterAll and a signal all await it */
  let teardown: Promise<StopReport[]> | null = null;
  const stopAll = () => (teardown ??= (async () => {
    await link?.close();
    const reports: StopReport[] = [];
    for (const core of cores) reports.push(await core.stop());
    return reports;
  })());
  /** a signal ends `bun test` without running afterAll: the same teardown runs first */
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => { void stopAll().finally(() => process.exit(128 + constants.signals[signal])); };

  const waiters = new Set<{ check: () => boolean; resolve: () => void }>();
  const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  const notices: LinkNotice[] = [];
  const until = (label: string, check: () => boolean): Promise<void> => {
    if (check()) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`no ${label} within ${WAIT_MS}ms`)); }, WAIT_MS);
    waiters.add(waiter);
    return promise;
  };
  /** processes whose environment names this test's core folder: a core, a holder, or anything they started (Linux only: it reads /proc) */
  const runningIn = (root: string) => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").includes(root); } catch { return false; }
  });

  afterAll(async () => {
    const reports = await stopAll();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    expect(reports.map(stoppedCleanly)).toEqual(cores.map(() => true));
  }, TEST_MS);

  it("comes up, follows a terminal, starts nothing while its core is gone, and comes up in a new epoch on the next core", async () => {
    for (const signal of SIGNALS) process.once(signal, onSignal);
    const folder = coreFolder();
    const first = new IsolatedCore(bin!, folder);
    cores.push(first);
    await first.start();
    let now = 0;
    link = openLink({ socket: first.socket, now: () => now, model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null }, notify: (notice) => { notices.push(notice); wake(); } });
    await until("Online", () => link!.state.kind === "Online");
    expect(link.state).toEqual({ kind: "Online", epoch: 1 });
    expect(notices.find((notice) => notice.type === "snapshot")).toMatchObject({ cause: "connect", epoch: 1, terminals: [] });
    expect(notices.filter((notice) => notice.type === "doc").map((notice) => (notice as { name: string }).name)).toEqual(["herdr-app", "ovis-layout"]);

    // a terminal the link starts, whose program reports its status when told to
    const report = (state: string) => `printf '\\033]7501;state=${state}:app=ovis-test\\033\\\\'`;
    const record = await link.call("terminal.run", { argv: ["bash", "-c", `stty -echo; while IFS= read -r line; do case "$line" in w) ${report("working")};; d) ${report("done")};; esac; done`] });
    await until("created", () => notices.some((notice) => notice.type === "event" && notice.event.type === "created" && notice.event.terminal === record.address));
    const closes: unknown[] = [];
    const { channel } = await link.attach({ terminal: record.address, cols: 80, rows: 24, resumed: true }, { onData: () => {}, onClose: (reason) => { closes.push(reason); } });
    const shown = () => notices.flatMap((notice) => (notice.type === "event" ? notice.changes.flatMap((change) => (change.type === "status" && change.terminal === record.address ? [change.shown] : [])) : []));
    channel.write("w\r");
    await until("working", () => shown().includes("working"));
    channel.write("d\r");
    await until("done", () => shown().at(-1) === "done");

    // the core goes: the link is Offline, every channel heard it, and its retries start no core
    const stopped = await first.stop();
    expect(stoppedCleanly(stopped)).toBe(true);
    await until("Offline", () => link!.state.kind === "Offline");
    // a stopping core closes each attach itself (`server_stop`) before its line ends; a channel still open then hears `connection_lost`
    expect(closes).toHaveLength(1);
    expect(["server_stop", "connection_lost"]).toContain((closes[0] as { reason: string }).reason);
    expect(link.state).toMatchObject({ retryAt: RECONNECT_FIRST_MS });
    for (let attempt = 1; attempt <= 3; attempt++) {
      now = (link.state as { retryAt: number }).retryAt;
      link.fire();
      await until(`attempt ${attempt} to fail`, () => link!.state.kind === "Offline" && (link!.state as { retryAt: number }).retryAt > now);
    }
    expect(link.state).toMatchObject({ kind: "Offline", code: "no_core" });
    expect(existsSync(first.socket)).toBe(false);
    // only Linux has /proc; elsewhere the stop report and the socket above stand for it
    if (process.platform === "linux") expect(runningIn(folder.root)).toEqual([]);

    // a new core at the same socket: the next attempt brings the link up again, in a new epoch
    for (const sub of ["home", "state", "config", "run"]) mkdirSync(join(folder.root, sub), { recursive: true, mode: 0o700 });
    const second = new IsolatedCore(bin!, folder);
    cores.push(second);
    await second.start();
    expect(second.socket).toBe(first.socket);
    now = (link.state as { retryAt: number }).retryAt;
    link.fire();
    await until("Online again", () => link!.state.kind === "Online");
    expect(link.state).toEqual({ kind: "Online", epoch: 2 });
    expect(notices.filter((notice) => notice.type === "snapshot").at(-1)).toMatchObject({ cause: "connect", epoch: 2, terminals: [] });
    expect((await link.hello()).version).toMatch(/^\d+\.\d+\.\d+/);

    const reports = await stopAll();
    expect(reports.map(stoppedCleanly)).toEqual([true, true]);
  }, TEST_MS);
});
