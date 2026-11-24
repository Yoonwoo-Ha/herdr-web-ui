import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { constants } from "node:os";
import { join } from "node:path";
import { IsolatedCore, stoppedCleanly } from "../scripts/test-hc.ts";
import { FRAME_DATA, FRAME_FACTS, FRAME_FOCUS, FRAME_RESIZE } from "../server/herdr-core/connection.ts";
import { DETACH, entryEnv, fresh, HOST_ANSWERS, visibleGrid } from "./testing/entry-pty.ts";
import { detach, fidelityScene, livePane } from "./testing/fidelity-scene.ts";
import { answerQueries, runOnPty, stopAllPtyRuns, type PtyRun } from "./testing/pty.ts";

const bin = process.env["OVIS_TEST_HC_BIN"];
const wait = 60_000;
const changes = new Set([FRAME_DATA, FRAME_FACTS, FRAME_FOCUS, FRAME_RESIZE]);
const frame = "\x1b[?2026l";

async function given<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const until = performance.now() + 4_000;
  for (;;) {
    const value = await read();
    if (ready(value) || performance.now() >= until) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(!bin || process.platform === "win32")("screen ownership beside another real viewer", () => {
  let core: IsolatedCore | undefined;
  let scene: Awaited<ReturnType<typeof fidelityScene>>;
  let close: (() => Promise<void>) | undefined;
  let ending: Promise<void> | undefined;
  const stop = () => (ending ??= (async () => {
    await stopAllPtyRuns();
    await close?.();
    if (core) expect(stoppedCleanly(await core.stop())).toBe(true);
  })());
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) =>
    [signal, () => { void stop().finally(() => process.exit(128 + constants.signals[signal])); }] as const);
  for (const [signal, handler] of handlers) process.once(signal, handler);
  beforeEach(async () => {
    if (!bin) throw new Error("requires an isolated hc binary");
    ending = undefined;
    close = undefined;
    core = new IsolatedCore(bin);
    await core.start();
    scene = await fidelityScene(core);
    close = scene.close;
  }, wait);
  afterEach(stop, wait);
  afterAll(() => { for (const [signal, handler] of handlers) process.off(signal, handler); });

  const driver = async (terminal: string, cols: number, rows: number) => (await scene.hc.open("terminal.attach", {
    terminal, cols, rows,
  }, { onData: () => {}, onClose: () => {} })).channel;

  const attachRequests = (terminal: string) => scene.wire.requests.filter(({ method, params }) =>
    method === "terminal.attach" && params["terminal"] === terminal);
  const takes = () => scene.wire.frames.filter(({ kind }) => changes.has(kind));

  it("beside an active viewer: chrome, focus, tab changes and reconnect do not take its size", async () => {
    const pane = await scene.seed("DRIVEN");
    await scene.seed("SECOND", "", "two");
    const active = await driver(pane.id, 120, 40);
    active.write("D");
    await pane.received(1);
    const run = scene.screen();
    await livePane(run, pane.name);
    await run.until("sized by another viewer (120x40)");
    run.type("\x022");
    await run.until("SECOND-READY");
    const old = run.output().length;
    run.type("\x021");
    await fresh(run, old, "sized by another viewer (120x40)");
    scene.wire.cut();
    await run.until("herdr-core is not answering");
    const cut = run.output().length;
    scene.wire.resume();
    await fresh(run, cut, "sized by another viewer (120x40)");
    await fresh(run, cut, "\x1b[?25h");
    expect(takes()).toEqual([]);
    expect(await pane.nextSize()).toEqual({ cols: 120, rows: 40 });
    run.type("A");
    expect((await pane.received(2)).toString("utf8")).toBe("DA");
    // a tab's only pane at 100x30: all right of the sidebar and under the tab bar, less its scrollbar column
    expect(await pane.nextSize()).toEqual({ cols: 73, rows: 29 });
    expect(takes().filter(({ kind }) => kind === FRAME_DATA).map(({ payload }) => Buffer.from(payload).toString("utf8"))).toEqual(["A"]);
    if (process.env["OVIS_TEST_ENTRY_GRIDS"] === "1") console.log(await visibleGrid(run, 100, 30));
    expect(await detach(run)).toBe(0);
  }, wait);

  it("two idle viewers settle: 80x24 and 120x40 views stop reattaching", async () => {
    if (!core) throw new Error("requires an isolated core");
    const pane = await scene.seed("IDLE");
    const env = entryEnv(core);
    // No launcher/supervisor processes in this two-screen case: measure two real screen entries
    // without starting more processes than the isolated core already needs.
    const direct = (cols: number, rows: number): PtyRun => {
      const probe = answerQueries((answer) => run.type(answer), HOST_ANSWERS);
      const run = runOnPty({
        command: [process.execPath, join(import.meta.dir, "main.ts")],
        env: { ...env, HC_SOCKET: join(scene.core.root, "wire.sock"), OVIS_TUI_STATE_DIR: join(scene.core.root, `view-${cols}`) },
        cols, rows, deadlineMs: 15_000, onData: probe,
      });
      return run;
    };
    const small = direct(80, 24);
    await small.until("IDLE-READY");
    const big = direct(120, 40);
    await big.until("IDLE-READY");
    await small.until("sized by another viewer");
    const count = await given(async () => attachRequests(pane.id).length, (n) => n >= 3);
    expect(count).toBe(3);
    const chosen = { cols: 93, rows: 39 }; // the sidebar, the tab bar and the scrollbar column are not part of its terminal
    expect(await pane.nextSize()).toEqual(chosen);
    // The barrier: the small screen closed its first attach before its repaint left, so it draws a line printed now only
    // through that repaint, which the core has then applied. A second line, printed after that, follows on each screen's
    // line everything the core said while it applied the three attaches: a screen that drew it has heard all of it.
    pane.emit("REPAINT-IN-USE\r\n");
    await small.until("REPAINT-IN-USE");
    pane.emit("BOTH-LINES-READ\r\n");
    await Promise.all([small.until("BOTH-LINES-READ"), big.until("BOTH-LINES-READ")]);
    // Behind it nothing is on its way and nothing is owed: the repaint advertised the size the big screen chose, not the
    // small one's rectangle, so it took nothing, and the terminal rests at the size both attaches in use advertise. A
    // pane attaches again only when its rectangle changes or it hears a size that is neither (size.ts). That no wait
    // outlives its cause and sends an attach later is the stepped clock's to show: size.test.ts "two idle screens settle".
    expect(attachRequests(pane.id).map(({ params }) => [params["cols"], params["rows"]])).toEqual([[53, 23], [93, 39], [93, 39]]);
    expect(await pane.nextSize()).toEqual(chosen);
    expect(takes()).toEqual([]);
    big.type(DETACH);
    await big.exited;
    small.type(DETACH);
    await small.exited;
  }, wait);

  it("take advertises the pane's new rectangle even when the key arrives before the resize settles", async () => {
    const pane = await scene.seed("TAKE");
    const run = scene.screen({}, 106, 28);
    await livePane(run, pane.name);
    expect(await pane.nextSize()).toEqual({ cols: 79, rows: 27 });
    const active = await driver(pane.id, 120, 40);
    active.write("B");
    await pane.received(1);
    await run.until("sized by another viewer (120x40)");
    const before = run.output().length;
    run.resize(126, 34);
    await fresh(run, before, frame);
    run.type("A");
    expect((await pane.received(2)).toString("utf8")).toBe("BA");
    expect(await pane.nextSize()).toEqual({ cols: 99, rows: 33 });
    expect(takes().filter(({ kind }) => kind === FRAME_RESIZE).map(({ payload }) => {
      const data = Buffer.from(payload);
      return [data.readUInt16LE(0), data.readUInt16LE(2)];
    })).toEqual([[99, 33]]);
    expect(await detach(run)).toBe(0);
  }, wait);

  it("same size is not ownership: two window resizes and returning focus never stamp that viewer", async () => {
    const pane = await scene.seed("SAME");
    await scene.seed("ANOTHER", "", "two");
    // the screen's own size for this pane at 100x30
    const active = await driver(pane.id, 73, 29);
    active.write("S");
    await pane.received(1);
    const run = scene.screen();
    await livePane(run, pane.name);
    for (const cols of [110, 120]) {
      const from = run.output().length;
      run.resize(cols, 30);
      await fresh(run, from, frame);
    }
    run.type("\x022");
    await run.until("ANOTHER-READY");
    const hide = run.output().length;
    run.type("\x021");
    await fresh(run, hide, "sized by another viewer (73x29)");
    expect(takes()).toEqual([]);
    expect(await pane.nextSize()).toEqual({ cols: 73, rows: 29 });
    expect(await detach(run)).toBe(0);
  }, wait);
});
