import { afterAll, describe, expect, it } from "bun:test";
import type { Socket } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { coreFolder, IsolatedCore, type StopReport, stoppedCleanly } from "../scripts/test-hc.ts";
import { HcConnection } from "../server/herdr-core/connection.ts";
import { OVIS_LAYOUT_DOC } from "../server/herdr-core/layout-doc.ts";
import { SPACE_LABEL, TAB_LABEL, WORKSPACE_NAME_LABEL } from "../server/herdr-core/snapshot.ts";
import { connectCoreSocket } from "../server/herdr-core/socket-transport.ts";
import { SCREEN_FOLDER, SCREEN_SERVER } from "./start.ts";
import { gridText, runSupervised, stopAllPtyRuns, type SupervisedRun } from "./testing/pty.ts";

/**
 * The real entry (`bun tui/main.ts`) on a real pseudo-terminal against a real hc, in cores of the test's own: the
 * screen comes up and shows a shell's output, a typed command runs once, the detach key quits with one line and the
 * terminal cooked again, and the core and its terminal still run; started again it shows the same pane. Inside a pane
 * of its own core it refuses; inside another core's pane it runs. Signals at each stage give the terminal back. Runs
 * only where OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const ENTRY = join(import.meta.dir, "main.ts");
/** how long one step of the real screen and core may take on a pinned, loaded machine */
const WAIT_MS = 30_000;
/** above twice the helper's own 10 s wait for a stopped core, and the waits of every run */
const TEST_MS = 300_000;
const DETACH = "\x02q";
/** what the host writes when it gives the terminal back (tui/host/guard.ts LEAVE): exactly once per run */
const LEAVE = "\x1b[<u\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l";
/** the query that ends the screen's start probe (DA1): the probe waits for its answer, or REPLY_WAIT_MS */
const DA1 = "\x1b[c";
/** what the screen writes once its start probe ended (tui/host/guard.ts watchDisplay): the sign that it got past the probe */
const DISPLAY_WATCH = "\x1b[?2031h";
/** what a terminal answers to the queries the screen's start probe ends with */
const ANSWERS: [query: string, answer: string][] = [[DA1, "\x1b[?62;22c"], ["\x1b[?2026$p", "\x1b[?2026;2$y"]];

/** Bytes on their way through one direction of a held line, sent as the socket takes them. */
interface Outbound { socket: Socket<Line> | null; queue: Uint8Array[] }
/** One line of the screen through the holding socket: `held` once the screen asked for an attach on it. */
interface Line { toCore: Outbound; toScreen: Outbound; held: boolean; tail: string }

function flush(out: Outbound): void {
  while (out.socket && out.queue.length > 0) {
    const chunk = out.queue[0]!;
    const written = out.socket.write(chunk);
    if (written < chunk.length) {
      out.queue[0] = chunk.subarray(Math.max(0, written));
      return;
    }
    out.queue.shift();
  }
}

function send(out: Outbound, bytes: Uint8Array): void {
  out.queue.push(bytes.slice());
  flush(out);
}

/**
 * A socket at `path` in front of the core at `core`: everything passes both ways until the screen asks for an attach on a
 * line; from then on nothing the core sends on that line reaches the screen, so the attach's reply stays pending.
 */
function attachHolder(core: string, path: string): { path: string; asked: Promise<void>; close: () => void } {
  let told!: () => void;
  const asked = new Promise<void>((resolve) => { told = resolve; });
  const sockets = new Set<Socket<Line>>();
  const server = Bun.listen<Line>({
    unix: path,
    socket: {
      open(screen) {
        const line: Line = { toCore: { socket: null, queue: [] }, toScreen: { socket: screen, queue: [] }, held: false, tail: "" };
        screen.data = line;
        sockets.add(screen);
        void Bun.connect<Line>({
          unix: core,
          data: line,
          socket: {
            open(upstream) {
              sockets.add(upstream);
              line.toCore.socket = upstream;
              flush(line.toCore);
            },
            data(_upstream, bytes) {
              if (!line.held) send(line.toScreen, bytes);
            },
            drain() { flush(line.toCore); },
            close() { screen.end(); },
          },
        }).catch(() => screen.end());
      },
      data(screen, bytes) {
        const line = screen.data;
        // the request's method name, also when a read cuts it in two
        const text = line.tail + Buffer.from(bytes).toString("latin1");
        line.tail = text.slice(-32);
        if (!line.held && text.includes("\"terminal.attach\"")) {
          line.held = true;
          told();
        }
        send(line.toCore, bytes);
      },
      drain(screen) { flush(screen.data.toScreen); },
      close(screen) { screen.data.toCore.socket?.end(); },
    },
  });
  return {
    path,
    asked,
    close: () => {
      for (const socket of sockets) socket.end();
      server.stop(true);
      rmSync(path, { force: true });
    },
  };
}

/** A grid decoded from the run's output, and the length of the output it was decoded from. */
interface Shown { text: string; length: number }

describe.skipIf(!bin || process.platform === "win32")("the screen's entry against a real hc", () => {
  const cores: IsolatedCore[] = [];
  const lines: HcConnection[] = [];
  let teardown: Promise<StopReport[]> | null = null;
  const stopAll = () => (teardown ??= (async () => {
    await stopAllPtyRuns();
    for (const line of lines) line.close();
    const reports: StopReport[] = [];
    for (const core of cores) reports.push(await core.stop());
    return reports;
  })());
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => { void stopAll().finally(() => process.exit(128 + constants.signals[signal])); };
  for (const signal of SIGNALS) process.once(signal, onSignal);

  afterAll(async () => {
    const reports = await stopAll();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    expect(reports.map(stoppedCleanly)).toEqual(cores.map(() => true));
  }, TEST_MS);

  async function core(): Promise<{ core: IsolatedCore; hc: HcConnection; root: string }> {
    const folder = coreFolder();
    const started = new IsolatedCore(bin!, folder);
    cores.push(started);
    await started.start();
    const transport = await connectCoreSocket(started.socket);
    const hc = new HcConnection(() => transport);
    lines.push(hc);
    return { core: started, hc, root: folder.root };
  }

  /** The entry on a pty of its own, in the core's environment, answering the probe as a terminal does. */
  function screen(isolated: IsolatedCore, root: string, options: { socket?: string; answerDa1?: boolean; folder?: string; server?: string } = {}): SupervisedRun {
    const env = {
      ...isolated.env, TERM: "xterm-256color", COLORTERM: "truecolor", OVIS_TUI_STATE_DIR: join(root, "tui-state"), TMPDIR: root,
      ...(options.socket ? { HC_SOCKET: options.socket } : {}),
      ...(options.folder ? { [SCREEN_FOLDER]: options.folder } : {}),
      ...(options.server ? { [SCREEN_SERVER]: options.server } : {}),
    };
    const answers = options.answerDa1 === false ? ANSWERS.filter(([query]) => query !== DA1) : ANSWERS;
    let tail = "";
    const run: SupervisedRun = runSupervised({
      entry: [process.execPath, ENTRY], env, cols: 100, rows: 30, deadlineMs: WAIT_MS * 4,
      onData: (text) => {
        const window = tail + text;
        // answered in the order asked, as a terminal does: DA1 comes last and ends the probe
        const asked: [at: number, answer: string][] = [];
        for (const [query, answer] of answers) {
          for (let at = window.indexOf(query); at !== -1; at = window.indexOf(query, at + 1)) if (at + query.length > tail.length) asked.push([at, answer]);
        }
        for (const [, answer] of asked.sort((a, b) => a[0] - b[0])) run.type(answer);
        tail = window.slice(-16);
      },
    });
    return run;
  }

  const labels = { [SPACE_LABEL]: "w-live", [TAB_LABEL]: "t-live" };

  it("comes up, runs a typed command once, detaches with one line, and leaves the core and its terminal running; again it shows the same pane", async () => {
    const { core: isolated, hc, root } = await core();
    const ran = join(root, "ran.log");
    const { address } = await hc.call("terminal.run", { argv: ["sh", "-c", "echo READY-MARK; exec sh"], labels, cwd: root });
    const first = screen(isolated, root);
    await first.until("READY-MARK", "the shell's output");
    // the cursor is shown only once the pane is Live (tui/view/paint.ts, step 6)
    await first.until(/READY-MARK[\s\S]*\x1b\[\?25h/, "the live pane's cursor");
    first.type(`echo typed-$((40+2)) >> ${ran}; echo done-$((1+1))\r`);
    await first.until("done-2", "the typed command's output");
    first.type(DETACH);
    const end = await first.ended;
    expect(end.code).toBe(0);
    expect(end.after?.canonical).toBe(true);
    expect(end.after?.echo).toBe(true);
    expect(first.output()).toContain("detached from herdr-core session");
    expect(first.output().split(LEAVE).length - 1).toBe(1);
    expect(readFileSync(ran, "utf8")).toBe("typed-42\n");
    const record = await hc.call("terminal.get", { terminal: address });
    expect(record.state).toBe("live");

    const again = screen(isolated, root);
    await again.until(/done-2[\s\S]*\x1b\[\?25h/, "the same pane, live again");
    again.type(DETACH);
    expect((await again.ended).code).toBe(0);
    expect(readFileSync(ran, "utf8")).toBe("typed-42\n");
    expect((await hc.call("terminal.get", { terminal: address })).state).toBe("live");
  }, TEST_MS);

  it("a folder the core cannot use: two screens open one first workspace between them in the core's own folder, ~, each saying which folder failed", async () => {
    const { core: isolated, hc, root } = await core();
    const gone = join(root, "gone");
    for (const name of ["a", "b"]) mkdirSync(join(root, name));
    const both = ["a", "b"].map((name) => screen(isolated, join(root, name), { folder: gone }));
    await Promise.all(both.map((run, at) => run.until(/\x1b\[\?1049h[\s\S]*\x1b\[\?25h/, `screen ${at + 1}'s live first pane`)));
    const { terminals } = await hc.call("terminal.list", {});
    expect(terminals.map((terminal) => [terminal.cwd === gone, terminal.labels?.[WORKSPACE_NAME_LABEL]])).toEqual([[false, "~"]]);
    // the screen whose create was refused says so, calmly; the other found the claim taken and made nothing
    expect(both.filter((run) => run.output().includes("first_folder_unusable")).length).toBe(1);
    for (const run of both) {
      run.type(DETACH);
      expect((await run.ended).code).toBe(0);
    }
  }, TEST_MS);

  it("on a new line to a core emptied meanwhile, a folder removed since gives the first workspace to the core's own folder, ~", async () => {
    const { core: isolated, hc } = await core();
    // outside the core's folder, which its stop removes
    const outside = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "screen-"));
    const project = join(outside, "project");
    mkdirSync(project);
    const run = screen(isolated, outside, { folder: project });
    await run.until(/\x1b\[\?1049h[\s\S]*\x1b\[\?25h/, "the live first pane in the project");
    const [made] = (await hc.call("terminal.list", {})).terminals;
    expect(made?.cwd).toBe(project);
    await hc.call("terminal.kill", { terminal: made!.address });
    await hc.call("terminal.rm", { terminal: made!.address });
    expect(stoppedCleanly(await isolated.stop())).toBe(true);
    await run.until("herdr-core is not answering", "the offline banner");
    rmSync(project, { recursive: true });
    for (const sub of ["home", "state", "config", "run"]) mkdirSync(join(isolated.root, sub), { recursive: true, mode: 0o700 });
    const again = new IsolatedCore(bin!, { root: isolated.root, env: isolated.env });
    cores.push(again);
    const from = run.output().length;
    await again.start();
    await run.until(new RegExp(`^[\\s\\S]{${from}}[\\s\\S]*first_folder_unusable`), "the notice on the new line");
    const transport = await connectCoreSocket(again.socket);
    const line = new HcConnection(() => transport);
    lines.push(line);
    for (let tries = 0; tries < 50 && (await line.call("terminal.list", {})).terminals.length === 0; tries++) await run.until(new RegExp(`^[\\s\\S]{${run.output().length + 1}}`), "more output");
    const { terminals } = await line.call("terminal.list", {});
    expect(terminals.map((terminal) => [terminal.cwd === project, terminal.labels?.[WORKSPACE_NAME_LABEL]])).toEqual([[false, "~"]]);
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
    rmSync(outside, { recursive: true, force: true });
  }, TEST_MS);

  it("two screens started together on an empty core open one first workspace between them", async () => {
    const { core: isolated, hc, root } = await core();
    const folders = ["a", "b"].map((name) => join(root, name));
    for (const folder of folders) mkdirSync(folder);
    const both = folders.map((folder) => screen(isolated, folder, { folder }));
    // the cursor is shown only once a pane is Live: each screen shows the one first workspace's shell
    await Promise.all(both.map((run, at) => run.until(/\x1b\[\?1049h[\s\S]*\x1b\[\?25h/, `screen ${at + 1}'s live first pane`)));
    // one workspace, its shell in the folder of the screen that won the claim, named after it (no name of its own)
    const { terminals } = await hc.call("terminal.list", {});
    expect(terminals.length).toBe(1);
    expect(folders).toContain(terminals[0]!.cwd);
    expect(terminals[0]!.labels?.[WORKSPACE_NAME_LABEL]).toBeUndefined();
    // the claim that decided it is out of the layout document again
    expect(Object.keys(((await hc.call("doc.get", { name: OVIS_LAYOUT_DOC })).value ?? {}) as object)).not.toContain("first_workspace");
    for (const run of both) {
      run.type(DETACH);
      expect((await run.ended).code).toBe(0);
    }
  }, TEST_MS);

  it("refuses inside its own core's pane, runs inside another core's", async () => {
    const own = await core();
    const other = await core();
    const report = (name: string) => join(own.root, name);
    const inPane = async (name: string, prefix: string) => {
      const line = `env | grep '^HC_' | sed 's/=.*//' > ${report(`${name}.env`)}; ${prefix} ${process.execPath} ${ENTRY} </dev/null 2> ${report(`${name}.err`)}; echo "exit=$?" >> ${report(`${name}.err`)}`;
      await own.hc.call("terminal.run", { argv: ["sh", "-c", line], labels, cwd: own.root, wait: true, timeout: WAIT_MS / 1000 });
      return readFileSync(report(`${name}.err`), "utf8");
    };
    const inside = await inPane("inside", "");
    expect(inside).toMatch(/^ovis tui: inside_own_core: .*\nexit=1\n$/);
    expect(readFileSync(report("inside.env"), "utf8").split("\n")).toContain("HC_TERMINAL_ID");
    const elsewhere = await inPane("elsewhere", `HC_SOCKET=${other.core.socket}`);
    expect(elsewhere).toMatch(/^ovis tui: not_a_terminal: .*\nexit=1\n$/);
  }, TEST_MS);

  it("gives the terminal back on SIGTERM, SIGINT and SIGHUP at every stage, and the terminal keeps running", async () => {
    const { core: isolated, hc, root } = await core();
    const { address } = await hc.call("terminal.run", { argv: ["sh", "-c", "echo READY-MARK; exec sh"], labels, cwd: root });
    type Hold = { answerDa1?: boolean; attach?: boolean };
    const stages: [stage: string, signal: "SIGTERM" | "SIGINT" | "SIGHUP", hold: Hold, reach: (run: SupervisedRun, attachAsked: Promise<void>) => Promise<void>][] = [
      // DA1 is left unanswered: the signal comes while the probe waits for it (it waits REPLY_WAIT_MS at most, from the query)
      ["the start probe", "SIGTERM", { answerDa1: false }, async (run) => { await run.started; await run.until(DA1, "the probe's last query"); }],
      // the core's answers are held from the screen's attach request on: the signal comes while that attach waits for its reply
      ["the first attach", "SIGINT", { attach: true }, async (run, attachAsked) => {
        await run.until("\x1b[?1049h", "the screen's entry");
        await Promise.race([attachAsked, run.ended.then(() => { throw new Error("the screen ended before it asked for an attach"); })]);
      }],
      // the typed command is echoed: wait for a line only its output holds (flood-42), never the command's own text
      ["a flood", "SIGHUP", {}, async (run) => {
        await run.until(/READY-MARK[\s\S]*\x1b\[\?25h/, "the live pane");
        run.type("yes flood-$((6*7)) | head -n 200000\r");
        await run.until("flood-42", "the flood");
      }],
      // the flood scrolled READY-MARK away: a shown cursor alone says the pane is Live
      ["quit", "SIGTERM", {}, async (run) => { await run.until(/\x1b\[\?1049h[\s\S]*\x1b\[\?25h/, "the live pane"); run.type(DETACH); }],
    ];
    const codes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
    for (const [stage, signal, hold, reach] of stages) {
      const holder = hold.attach ? attachHolder(isolated.socket, join(root, "h.sock")) : null;
      try {
        const run = screen(isolated, root, { ...(holder ? { socket: holder.path } : {}), ...(hold.answerDa1 === false ? { answerDa1: false } : {}) });
        await reach(run, holder?.asked ?? Promise.resolve());
        run.signal(signal);
        const end = await run.ended;
        // a quit may finish before the signal lands
        expect([codes[signal], ...(stage === "quit" ? [0] : [])]).toContain(end.code);
        expect([stage, end.after?.canonical, end.after?.echo]).toEqual([stage, true, true]);
        expect([stage, run.output().split(LEAVE).length - 1]).toEqual([stage, 1]);
        // the held attach never replied: nothing of the pane was drawn
        if (holder) expect([stage, run.output().includes("READY-MARK")]).toEqual([stage, false]);
        // the signal came before the probe ended: the display watch the screen turns on right after it (tui/loop.ts) never went
        // out. Read once every byte of the pty is in, so a late one is not missed
        if (hold.answerDa1 === false) {
          await run.exited;
          expect([stage, run.output().includes(DISPLAY_WATCH)]).toEqual([stage, false]);
        }
        expect((await hc.call("terminal.get", { terminal: address })).state).toBe("live");
      } finally {
        holder?.close();
      }
    }
  }, TEST_MS);

  /** The screen's grid as the output so far draws it, and how much output that was. */
  const gridNow = async (run: SupervisedRun): Promise<Shown> => {
    const output = run.output();
    return { text: await gridText(output, 100, 30), length: output.length };
  };

  /**
   * The screen's grid once output arrived beyond what `seen` was decoded from (output that came while it was decoded counts);
   * the run's own deadline bounds the wait.
   */
  const nextGrid = async (run: SupervisedRun, seen: Shown): Promise<Shown> => {
    await run.until(new RegExp(`^[\\s\\S]{${seen.length + 1}}`), "more output");
    return gridNow(run);
  };

  it("the pointer chooses in a right-click menu from the host's own motion reports (any-motion mode 1003), and the modes are restored on exit", async () => {
    const { core: isolated, hc, root } = await core();
    await hc.call("terminal.run", { argv: ["sh", "-c", "echo HOVER-MARK; exec sh"], labels: { ...labels, "ovis.pane": "hover" }, cwd: root });
    const run = screen(isolated, root);
    await run.until(/HOVER-MARK[\s\S]*\x1b\[\?25h/, "the live pane");
    // the screen asked the host for motion with no button held, as herdr does
    expect(run.output()).toContain("\x1b[?1003h");
    const grid = async () => (await gridText(run.output(), 100, 30)).split("\n");
    const mark = (await grid()).findIndex((line) => line.includes("HOVER-MARK"));
    const col = (await grid())[mark]!.indexOf("HOVER-MARK");
    run.type(`\x1b[<2;${col + 4};${mark + 1}M\x1b[<2;${col + 4};${mark + 1}m`);
    let shown = await gridNow(run);
    while (!shown.text.includes("Split down")) shown = await nextGrid(run, shown);
    const rows = shown.text.split("\n");
    const y = rows.findIndex((line) => line.includes("Split down"));
    const x = rows[y]!.indexOf("Split down");
    // a host in 1003 mode reports the pointer moving onto the entry: code 35, no button
    run.type(`\x1b[<35;${x + 3};${y + 1}M`);
    shown = await nextGrid(run, shown);
    run.type("\r");
    for (let tries = 0; tries < 100 && (await hc.call("terminal.list", {})).terminals.length < 2; tries++) shown = await nextGrid(run, shown);
    expect((await hc.call("terminal.list", {})).terminals.length).toBe(2);
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
    expect(run.output().endsWith(LEAVE) || run.output().includes(LEAVE)).toBe(true);
  }, TEST_MS);

  it("a stop from outside gives the terminal back (no mouse reports while stopped) and a continue enters again and repaints", async () => {
    const { core: isolated, hc, root } = await core();
    await hc.call("terminal.run", { argv: ["sh", "-c", "echo STOP-MARK; exec sh"], labels: { ...labels, "ovis.pane": "stop" }, cwd: root });
    const run = screen(isolated, root);
    await run.until(/STOP-MARK[\s\S]*\x1b\[\?25h/, "the live pane");
    // more output after `from` until it holds `needle`
    const waitFor = async (from: number, needle: string, what: string) => {
      while (run.output().indexOf(needle, from) < 0) await run.until(new RegExp(`^[\\s\\S]{${run.output().length + 1}}`), what);
      return run.output().indexOf(needle, from);
    };
    const before = run.output().length;
    run.signal("SIGTSTP");
    const stoppedAt = await waitFor(before, LEAVE, "the terminal given back at the stop");
    run.signal("SIGCONT");
    const back = await waitFor(stoppedAt + LEAVE.length, "\x1b[?1003h", "the modes entered again");
    await waitFor(back, "STOP-MARK", "the screen repainted");
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("New worktree and Delete worktree checkout... through a scratch Ovis server: the screen's entries make and remove the checkout, grouped as the web's", async () => {
    const { core: isolated, hc, root } = await core();
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-c", "gc.auto=0", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_MASTER: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
      return out;
    };
    await git("init", "-q", "-b", "main");
    await Bun.write(join(repo, "a"), "a");
    await git("add", "a");
    await git("commit", "-q", "-m", "a");
    await hc.call("terminal.run", { argv: ["sh", "-c", "echo REPO-MARK; exec sh"], labels: { [SPACE_LABEL]: "w-repo", [TAB_LABEL]: "t-repo" }, cwd: repo });
    // Ovis binds its own ephemeral port atomically and prints the bound origin when ready.
    const server = Bun.spawn([process.execPath, "server/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...isolated.env, PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root, HOST: "127.0.0.1", PORT: "0", OVIS_STATE_DIR: join(root, "ovis-state"), OVIS_RUNTIME: "herdr-core", OVIS_HC_BIN: bin!, TMPDIR: root, HERDR_TEST_MODE: "unit" },
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
    const output = server.stdout.getReader();
    let drain: Promise<void> | undefined;
    try {
      let origin: string | undefined;
      const decoder = new TextDecoder();
      let startup = "";
      for (let part = await output.read(); !part.done; part = await output.read()) {
        startup += decoder.decode(part.value, { stream: true });
        origin = /^Ovis listening on (http:\/\/127\.0\.0\.1:[1-9]\d*)\r?$/m.exec(startup)?.[1];
        if (origin !== undefined) break;
      }
      if (origin === undefined) throw new Error(`scratch Ovis did not report a listening port:\n${startup}`);
      drain = (async () => { while (!(await output.read()).done) { /* discard subsequent logs */ } })();
      const run = screen(isolated, root, { server: origin });
      await run.until(/REPO-MARK[\s\S]*\x1b\[\?25h/, "the repository's pane");
      // the screen as read up to `seen` bytes, and a wait for output past exactly those: what arrived while the grid was
      // being read is not missed
      const settled = async (until: (rows: string[]) => boolean, what: string): Promise<string[]> => {
        for (;;) {
          const seen = run.output().length;
          const rows = (await gridText(run.output().slice(0, seen), 100, 30)).split("\n");
          if (until(rows)) return rows;
          await run.until(new RegExp(`^[\\s\\S]{${seen + 1}}`), what);
        }
      };
      // `width`: only so many columns from the left (the sidebar's 26: a pane's corner draws └─ too)
      const at = async (text: string, width = 100): Promise<{ x: number; y: number }> => {
        const rows = await settled((lines) => lines.some((line) => line.slice(0, width).includes(text)), text);
        const y = rows.findIndex((line) => line.slice(0, width).includes(text));
        return { x: rows[y]!.indexOf(text), y };
      };
      const press = (button: 0 | 2, cell: { x: number; y: number }) => run.type(`\x1b[<${button};${cell.x + 2};${cell.y + 1}M\x1b[<${button};${cell.x + 2};${cell.y + 1}m`);
      // New worktree on the repository's row, Enter on herdr's suggested branch
      press(2, await at(" repo"));
      press(0, await at("New worktree"));
      await at("create and open");
      run.type("\r");
      // the sidebar's grouped row itself: the dialog's lower left corner reads └─ too while it closes
      const grouped = await at("└─ · worktree-", 26);
      type Session = { snapshot: { workspaces: { workspace_id: string; label: string; worktree?: { is_linked_worktree: boolean; repo_name: string; checkout_path: string } | null }[] } };
      // the web's session follows the core's events a moment behind the screen: read it until it has the new workspace
      const linked = async () => ((await (await fetch(`${origin}/api/session`)).json()) as Session).snapshot.workspaces.find((workspace) => workspace.worktree?.is_linked_worktree);
      let made = await linked();
      for (let tries = 0; tries < 100 && !made; tries++) {
        await Bun.sleep(20);
        made = await linked();
      }
      // what the web reads: the new workspace carries the worktree's facts, of the same repository as the one it came from
      expect(made?.worktree?.repo_name).toBe("repo");
      expect(made?.label.startsWith("worktree-")).toBe(true);
      expect(await git("worktree", "list")).toContain(made!.worktree!.checkout_path);
      // Delete worktree checkout... on the grouped row: asked first, then removed with its workspace
      // on its name: the tree's lines are no part of the row's hit, as in herdr's (parity's rc-workspace-worktree presses there too)
      press(2, { x: grouped.x + 5, y: grouped.y });
      press(0, await at("Delete worktree checkout..."));
      await at("delete worktree checkout?");
      run.type("\r");
      await settled((lines) => !lines.some((line) => line.slice(0, 26).includes("└─ · worktree-") || line.includes("delete worktree checkout?")), "the worktree gone");
      expect(await git("worktree", "list")).not.toContain(made!.worktree!.checkout_path);
      run.type(DETACH);
      expect((await run.ended).code).toBe(0);
    } finally {
      if (server.exitCode === null && server.signalCode === null) server.kill();
      await server.exited;
      await drain;
      output.releaseLock();
    }
  }, TEST_MS);

  it("shows a program named like an agent coming to the front as that agent in the sidebar's agents, with no reconnect", async () => {
    const { core: isolated, hc, root } = await core();
    mkdirSync(join(root, "bin"));
    // a shell every runner image has, under the agent's name; it stays in front until its read ends
    symlinkSync("/bin/sh", join(root, "bin", "claude"));
    await hc.call("terminal.run", { argv: ["sh", "-c", "echo FRONT-MARK; exec sh"], labels: { ...labels, "ovis.pane": "front-pane" }, cwd: root });
    const run = screen(isolated, root);
    await run.until(/FRONT-MARK[\s\S]*\x1b\[\?25h/, "the live pane");
    // herdr's two rows an agent in the sidebar: its workspace, then the agent three columns in
    const agentRows = (grid: string) => grid.split("\n").filter((line) => line.slice(0, 25).trimEnd() === "   claude").length;
    const before = await gridText(run.output(), 100, 30);
    expect(agentRows(before)).toBe(0);
    run.type(`exec ${join(root, "bin", "claude")} -c 'read line'\r`);
    let grid = await gridNow(run);
    while (agentRows(grid.text) === 0) grid = await nextGrid(run, grid);
    // the pane has a row among the agents only once it runs an agent; a tab's only pane has no border to carry a title
    expect(agentRows(grid.text)).toBe(1);
    expect(run.output()).not.toContain("herdr-core is not answering");
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("closes a pane whose program exited at once, as herdr does: the pane beside it takes the room", async () => {
    const { core: isolated, hc, root } = await core();
    await hc.call("terminal.run", { argv: ["sh", "-c", "echo STAY-MARK; exec sh"], labels: { ...labels, "ovis.pane": "stays" }, cwd: root });
    const { address } = await hc.call("terminal.run", { argv: ["sh", "-c", "echo END-MARK; read line; exit 3"], labels: { ...labels, "ovis.pane": "ends" }, cwd: root });
    const run = screen(isolated, root);
    await run.until(/(?=[\s\S]*STAY-MARK)(?=[\s\S]*END-MARK)[\s\S]*\x1b\[\?25h/, "both panes live");
    const grid = await gridText(run.output(), 100, 30);
    expect([grid.includes("┌ stays "), grid.includes("┌ ends ")]).toEqual([true, true]);
    await hc.call("terminal.send", { terminal: address, text: "go\r" });
    // the pane may be gone already: read what arrived meanwhile before waiting for more
    let after = await gridNow(run);
    while (after.text.includes("┌ ends ")) after = await nextGrid(run, after);
    // the core keeps the finished record: the screen does not show it, as the browser does not
    expect((await hc.call("terminal.get", { terminal: address })).state).toBe("finished");
    // the pane that stays is its tab's only pane now: drawn without a border, its program's output in view
    expect([after.text.includes("STAY-MARK"), after.text.includes("ended (3)")]).toEqual([true, false]);
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("draws the chrome (session header, sidebar, tabs, borders, mode bar, help overlay, notices) and the offline state on a real pty", async () => {
    const { core: isolated, hc, root } = await core();
    await hc.call("terminal.run", {
      argv: ["sh", "-c", "echo CHROME-LIVE-MARK; exec sh"],
      labels: { ...labels, "ovis.workspace": "live-ws", "ovis.tab": "live-tab", "ovis.pane": "live-pane" },
      cwd: root,
    });
    const run = screen(isolated, root);
    await run.until(/CHROME-LIVE-MARK[\s\S]*\x1b\[\?25h/, "the live pane and its chrome");
    expect(run.output()).toContain(" spaces");
    expect(run.output()).toContain(" agents");
    expect(run.output()).toContain("live-ws");
    expect(run.output()).toContain("live-tab");
    // terminal mode draws no mode line
    expect(run.output()).not.toContain("TERMINAL");

    // Armed prefix -> mode bar shows PREFIX, then '?' opens Keyboard Shortcuts help overlay, Enter closes it
    run.type("\x02");
    await run.until("PREFIX", "the armed prefix mode bar");
    run.type("?");
    await run.until("Keyboard Shortcuts", "the help overlay");
    run.type("\r");
    // Parity action prefix+s shows not_built notice
    run.type("\x02s");
    await run.until("not_built", "the parity action notice");

    // Stop the isolated core while the screen stays open -> screen draws the offline state with the command
    const stopped = await isolated.stop();
    expect(stoppedCleanly(stopped)).toBe(true);
    await run.until("herdr-core is not answering", "the offline banner");
    expect(run.output()).toContain("hc server start");

    run.type(DETACH);
    const end = await run.ended;
    expect(end.code).toBe(0);
    expect(end.after?.canonical).toBe(true);
    expect(end.after?.echo).toBe(true);
  }, TEST_MS);
});
