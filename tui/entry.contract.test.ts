import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary } from "../scripts/server-artifact.ts";
import { coreFolder, IsolatedCore, stoppedCleanly } from "../scripts/test-hc.ts";
import { FakeHcCore } from "../server/herdr-core/core.fake.ts";
import { PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL } from "../server/herdr-core/snapshot.ts";
import { DETACH, entryEnv, entryPty, fresh, RESTORE, SOURCE_OVIS, visibleGrid } from "./testing/entry-pty.ts";
import { stopAllPtyRuns, type SupervisedRun } from "./testing/pty.ts";

const bin = process.env["OVIS_TEST_HC_BIN"];
const evidence = process.env["OVIS_TEST_ENTRY_GRIDS"] === "1";
const unsupported = process.platform === "win32" || (process.arch !== "x64" && process.arch !== "arm64");
const labels = { [SPACE_LABEL]: "entry", [TAB_LABEL]: "one" };
const EXITS = { SIGTERM: 143, SIGHUP: 129 } as const;
const WAIT_MS = 60_000;
const COOKED = { canonical: true, echo: true, signals: true };

async function show(run: SupervisedRun, scenario: string, cols: number, rows: number): Promise<string> {
  const grid = await visibleGrid(run, cols, rows);
  if (evidence) console.log(`\n${scenario} (${cols}x${rows})\n${grid}`);
  return grid;
}

async function expectRestored(run: SupervisedRun, code: number): Promise<void> {
  const end = await run.ended;
  expect(end.code, end.stderr).toBe(code);
  expect(end.before).toMatchObject(COOKED);
  expect(end.after).toMatchObject(COOKED);
  expect(run.output().split(RESTORE)).toHaveLength(2);
  expect(await run.exited).toBe(code);
}

describe.skipIf(unsupported)("the source and packaged Ovis launchers in a real PTY", () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  let built = "";
  let building: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= (async () => {
    await stopAllPtyRuns();
    try {
      await Promise.all(cleanup.map((fn) => fn()));
    } finally {
      await building?.catch(() => undefined);
      if (built) rmSync(built, { recursive: true, force: true });
    }
  })());
  const signals = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) =>
    [signal, () => { void stop().finally(() => process.exit(128 + constants.signals[signal])); }] as const);
  beforeAll(async () => {
    for (const [signal, handler] of signals) process.once(signal, handler);
    built = mkdtempSync(join(tmpdir(), "ovis-entry-"));
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    building = buildBinary(`${platform}-${architecture}`, join(built, "ovis-server"));
    await building;
  }, WAIT_MS);
  afterAll(async () => {
    await stop();
    for (const [signal, handler] of signals) process.off(signal, handler);
  }, WAIT_MS);

  async function fixture() {
    const folder = coreFolder();
    const fake = new FakeHcCore();
    const one = fake.spawn({ labels: { ...labels, [PANE_NAME_LABEL]: "Left" } });
    const two = fake.spawn({ labels: { ...labels, [PANE_NAME_LABEL]: "Right" } });
    fake.setPaint(one.address, { body: "LEFT-PANE" });
    fake.setPaint(two.address, { body: "RIGHT-PANE" });
    const socket = folder.env["HC_SOCKET"];
    if (socket === undefined) throw new Error("coreFolder supplied no socket");
    let current = await fake.listen(socket);
    const cut = async () => { await current.close(); rmSync(socket, { force: true }); };
    cleanup.push(async () => { await cut(); rmSync(folder.root, { recursive: true, force: true }); });
    return { folder, fake, one, two, cut, reconnect: async () => { current = await fake.listen(socket); } };
  }

  for (const build of ["source", "compiled"] as const) {
    const command = (args: string[] = ["tui"]) => [
      ...(build === "source" ? SOURCE_OVIS : [join(built, "ovis-server"), "plugin"]), ...args,
    ];

    it(`${build}: n declines the cooked prompt without starting a core`, async () => {
      const folder = coreFolder();
      const clean = async () => { rmSync(folder.root, { recursive: true, force: true }); };
      cleanup.push(clean);
      const startLog = join(folder.root, "start.log");
      const standIn = join(folder.root, "hc");
      writeFileSync(standIn, `#!/bin/sh
if [ "$1" = --version ]; then echo 'hc 0.1.18'; exit 0; fi
printf '%s\\n' "$*" > '${startLog}'
exit 3
`, { mode: 0o700 });
      const run = entryPty(command(), entryEnv(folder, standIn), 80, 24);
      await run.until("[Y/n] ");
      expect(await run.stty()).toMatchObject(COOKED);
      run.type("n\r");
      const end = await run.ended;
      expect(end.code).toBe(1);
      expect(end.stderr).toContain("hc server start");
      expect(end.after).toMatchObject(COOKED);
      expect(run.output()).not.toContain("\x1b[?1049h");
      expect(existsSync(startLog)).toBe(false);
      expect(existsSync(join(folder.root, "run/hc.sock"))).toBe(false);
      await show(run, `${build} no core n: ${command().join(" ")}`, 80, 24);
      await run.exited;
      await clean();
    }, WAIT_MS);

    it(`${build}: without a running core, bare ovis does exactly what status does on the same PTY`, async () => {
      const folder = coreFolder();
      cleanup.push(async () => { rmSync(folder.root, { recursive: true, force: true }); });
      const env = entryEnv(folder);
      const status = entryPty(command(["status"]), env, 80, 24);
      const expected = await status.ended;
      expect(status.output()).toContain("http://127.0.0.1:1");
      for (const entry of [
        command([]),
        command(["--session", "work"]),
        ["/bin/sh", "-c", 'exec "$@" </dev/null', "input", ...command([])],
        ["/bin/bash", "-o", "pipefail", "-c", '"$@" | /bin/cat', "output", ...command([])],
      ]) {
        const bare = entryPty(entry, env, 80, 24);
        const end = await bare.ended;
        expect({ code: end.code, stderr: end.stderr, stdout: bare.output() }).toEqual({
          code: expected.code, stderr: expected.stderr, stdout: status.output(),
        });
      }
    }, WAIT_MS);

    if (bin) it(`${build}: bare ovis joins a real core and detaches without stopping it`, async () => {
      const core = new IsolatedCore(bin);
      const clean = async () => { expect(stoppedCleanly(await core.stop())).toBe(true); };
      cleanup.push(clean);
      await core.start();
      const run = entryPty(command([]), entryEnv(core, bin), 80, 24);
      for (;;) {
        const seen = run.output().length;
        if ((await visibleGrid(run, 80, 24)).split("\n").some((row) => row.startsWith(" · ~ "))) break;
        await run.until(new RegExp(`^[\\s\\S]{${seen + 1}}`), "the first workspace in the sidebar");
      }
      expect(run.output()).not.toContain("[Y/n]");
      await show(run, `${build} bare: ${command([]).join(" ")}`, 80, 24);
      run.type(DETACH);
      await expectRestored(run, 0);
      expect(existsSync(core.socket)).toBe(true);
    }, WAIT_MS);

    for (const cols of [45, 60, 64, 65]) it(`${build}: ${cols} columns projects the saved split without writing layout`, async () => {
      const { folder, fake } = await fixture();
      const run = entryPty(command(), entryEnv(folder), cols, 30);
      await run.until(/LEFT-PANE[\s\S]*\x1b\[\?25h/);
      await run.until("RIGHT-PANE");
      const grid = await show(run, `${build} width ${cols}: ${command().join(" ")}`, cols, 30);
      // herdr's narrow layout changes the chrome only: the split's panes show at every width, the switch button at 64 or fewer
      expect(grid.includes("RIGHT-PANE")).toBe(true);
      expect(grid.includes("switch")).toBe(cols <= 64);
      expect(fake.calls().filter(({ method }) => method === "doc.set")).toEqual([]);
      run.type(DETACH);
      await expectRestored(run, 0);
    }, WAIT_MS);

    it(`${build}: an EOF shows offline and drops keys and pastes instead of replaying them`, async () => {
      const { folder, fake, one, cut, reconnect } = await fixture();
      const program = fake.program(one.address);
      program.onInput = (bytes) => program.output(`\r\nRECEIVED-${Buffer.from(bytes).toString("hex")}\r\n`);
      const run = entryPty(command(), entryEnv(folder), 100, 30);
      await run.until(/LEFT-PANE[\s\S]*\x1b\[\?25h/);
      await cut();
      await run.until("herdr-core is not answering");
      await show(run, `${build} cut socket: ${command().join(" ")}`, 100, 30);
      run.type("lost-key\x1b[200~lost-paste\x1b[201~");
      await run.until("input_refused");
      const from = run.output().length;
      await reconnect();
      await fresh(run, from, "LEFT-PANE");
      await fresh(run, from, "\x1b[?25h");
      run.type("Z");
      await run.until("RECEIVED-5a");
      expect(program.receivedHex()).toBe("5a");
      await show(run, `${build} restored socket: ${command().join(" ")}`, 100, 30);
      run.type(DETACH);
      await expectRestored(run, 0);
    }, WAIT_MS);

    for (const signal of ["SIGTERM", "SIGHUP"] as const) it(`${build}: ${signal} restores the PTY; reopen retains the second pane`, async () => {
      const { folder, fake, two } = await fixture();
      const env = entryEnv(folder);
      const run = entryPty(command(), env, 60, 30);
      await run.until(/LEFT-PANE[\s\S]*\x1b\[\?25h/);
      // At 60 columns both panes show, as herdr's narrow layout does; focus the right one.
      const from = run.output().length;
      run.type("\x02l");
      await fresh(run, from, "\x1b[?2026l");
      expect(await run.stty()).toMatchObject({ canonical: false, echo: false, signals: false });
      run.signal(signal);
      await expectRestored(run, EXITS[signal]);
      const again = entryPty(command(), env, 60, 30);
      await again.until(/RIGHT-PANE[\s\S]*\x1b\[\?25h/);
      // the right pane is still the focused one: a key goes to its program
      const program = fake.program(two.address);
      program.onInput = (bytes) => program.output(`\r\nRECEIVED-${Buffer.from(bytes).toString("hex")}\r\n`);
      again.type("Z");
      await again.until("RECEIVED-5a");
      await show(again, `${build} reopened after ${signal}: ${command().join(" ")}`, 60, 30);
      again.type(DETACH);
      await expectRestored(again, 0);
    }, WAIT_MS);
  }
});
