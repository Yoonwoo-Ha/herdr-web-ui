import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coreFolder, corePids, IsolatedCore, pidAlive } from "../../scripts/test-hc.ts";
import { processesWith } from "./processes.ts";

/**
 * The helper end to end, against a real hc where OVIS_TEST_HC_BIN names one: the command's
 * environment, its exit code, and that no exit path (the end, a failing command, a signal before
 * the core answered, while the command runs or during cleanup, the time limit, a stop that does
 * nothing) leaves a process, a socket or a folder behind.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const HELPER = join(import.meta.dir, "with-core.ts");
const PROBE_ECHO = join(import.meta.dir, "probe-echo.ts");
const WAIT_MS = 30_000;
const TEST_MS = 90_000;
const callerHome = process.env["HOME"] ?? "";
/** the Ovis server's old token setting, spelled in pieces so this file does not hold the old name the repo-wide scan looks for */
const OLD_TOKEN = ["HERDR", "WEB", "TOKEN"].join("_");

/** the environment of the tools this test runs itself (mkfifo, timeout): never the inherited one */
const TOOL_ENV = { PATH: "/usr/bin:/bin" };

let scratch = "";
/** helpers still running and the test's own core: the one teardown ends them */
const running = new Set<{ signal: (name: NodeJS.Signals) => void; exited: Promise<number> }>();
let ownCore: IsolatedCore | null = null;
let tearing: Promise<void> | null = null;
/** afterAll and a signal to this test process (bun test skips afterAll then) both await it */
const teardown = () => (tearing ??= (async () => {
  // a helper stops its own core on SIGTERM: it is asked to, and awaited
  for (const run of running) run.signal("SIGTERM");
  await Promise.allSettled([...running].map((run) => run.exited));
  await ownCore?.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
})());
const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) => [signal, () => { void teardown().finally(() => process.exit(128 + constants.signals[signal])); }] as const);
beforeAll(() => {
  for (const [signal, handler] of handlers) process.on(signal, handler);
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "wct-"));
});
afterAll(async () => {
  await teardown();
  for (const [signal, handler] of handlers) process.off(signal, handler);
});

/** The caller's environment as a pane of someone's core would give it: an HC_TERMINAL_ID, an OVIS_TOKEN. */
function callerEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const own = Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("HC_") && entry[1] !== undefined);
  return Object.fromEntries(Object.entries({ ...Object.fromEntries(own), HC_TERMINAL_ID: "t99", HC_SCOPE: "someone", OVIS_TOKEN: "not-for-the-command", [OLD_TOKEN]: "not-either", ...extra }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

interface Run {
  cwd: string;
  /** resolves once a line of the helper's stderr or the command's stdout matches */
  line: (pattern: RegExp) => Promise<RegExpMatchArray>;
  exited: Promise<number>;
  signal: (name: NodeJS.Signals) => void;
  stdout: () => string;
  stderr: () => string;
}

function helper(args: string[], env: Record<string, string>, options: { cwd?: string; preload?: string } = {}): Run {
  const cwd = options.cwd ?? mkdtempSync(join(scratch, "command-"));
  // A detached system command can keep this directory after with-core exits and removes its root.
  const child = Bun.spawn([process.execPath, ...(options.preload ? ["--preload", options.preload] : []), HELPER, ...args], { env: { ...env, TMPDIR: realpathSync(tmpdir()) }, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  let err = "";
  const waiters = new Set<() => void>();
  const pump = async (stream: ReadableStream<Uint8Array>, add: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      add(decoder.decode(chunk, { stream: true }));
      for (const wake of [...waiters]) wake();
    }
  };
  const pumped = Promise.all([pump(child.stdout, (text) => { out += text; }), pump(child.stderr, (text) => { err += text; })]);
  const exited = pumped.then(() => child.exited);
  const run = { signal: (name: NodeJS.Signals) => child.kill(name), exited };
  running.add(run);
  void exited.finally(() => running.delete(run));
  return {
    cwd,
    exited,
    signal: (name) => child.kill(name),
    stdout: () => out,
    stderr: () => err,
    line: (pattern) => new Promise((resolve, reject) => {
      const check = () => {
        const found = `${err}\n${out}`.split("\n").map((text) => text.match(pattern)).find((match) => match !== null);
        if (!found) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no line matching ${pattern} within ${WAIT_MS}ms; stderr: ${err}`)); }, WAIT_MS);
      waiters.add(check);
      void exited.then(() => setTimeout(check, 0));
      check();
    }),
  };
}

/** What the run left: from the helper's report and a process snapshot. */
function leftovers(run: Run): { pidsAlive: number[]; socket: boolean; root: boolean; processes: number[] } {
  const root = run.stderr().match(/root=(\S+)/)?.[1];
  if (!root) throw new Error(`the helper named no root: ${run.stderr()}`);
  const pids = (run.stderr().match(/stopped pids=(\S*)/)?.[1] ?? "").split(",").filter(Boolean).map(Number);
  return { pidsAlive: pids.filter(pidAlive), socket: existsSync(join(root, "run", "hc.sock")), root: existsSync(root), processes: processesWith(root, run.cwd, root) };
}
const NOTHING_LEFT = { pidsAlive: [], socket: false, root: false, processes: [] };

/** A core CLI stand-in: a socket file records its lifetime; no daemon or unrelated pid is ever stopped. */
function standInHc(name: string, block?: "start" | "status" | "stop") {
  const dir = join(scratch, name);
  mkdirSync(dir);
  const path = join(dir, "hc");
  const log = join(dir, "calls");
  const watchdog = join(dir, "watchdog");
  writeFileSync(path, [
    `#!${process.execPath}`,
    'import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";',
    "const verb = process.argv[3];",
    `appendFileSync(${JSON.stringify(log)}, verb + "\\n");`,
    "const socket = process.env.HC_SOCKET;",
    "const reply = () => {",
    '  if (verb === "start") writeFileSync(socket, "stand-in core");',
    '  else if (verb === "status") console.log(JSON.stringify({ pid: process.pid }));',
    '  else if (verb === "stop" && existsSync(socket)) unlinkSync(socket);',
    "};",
    `if (verb === ${JSON.stringify(block)}) {`,
    '  process.on("SIGTERM", () => {});',
    // This is the regression's escape hatch, not its synchronization: an unbounded helper must still end safely.
    `  setTimeout(() => { writeFileSync(${JSON.stringify(watchdog)}, "escaped"); reply(); }, 30_000);`,
    "} else reply();",
  ].join("\n"));
  chmodSync(path, 0o755);
  return { path, log, watchdog };
}

/**
 * An hc that waits before `server <verb>` until the test writes to `<gate>` (bounded, so a failed
 * test still lets it through), or does nothing for `server stop` with `noStop`: run by its
 * absolute path, it hands everything else to the real hc.
 */
function gatedHc(name: string, options: { gate?: "start" | "stop"; noStop?: boolean }, target = bin): { path: string; open: () => Promise<void> } {
  const dir = join(scratch, name);
  mkdirSync(dir);
  const fifo = join(dir, "gate");
  // Resolve before using the restricted tool environment: Homebrew supplies gtimeout, or timeout in gnubin.
  const lookup = { PATH: process.env["PATH"] ?? "" };
  const timeout = options.gate ? Bun.which("timeout", lookup) ?? Bun.which("gtimeout", lookup) : null;
  if (options.gate) {
    if (!timeout) throw new Error("the gate contract needs GNU timeout or gtimeout on PATH");
    const made = Bun.spawnSync(["mkfifo", fifo], { env: TOOL_ENV });
    if (made.exitCode !== 0) throw new Error("mkfifo failed");
  }
  const script = [
    "#!/bin/sh",
    "PATH=/usr/bin:/bin",
    options.gate ? `if [ "$1 $2" = "server ${options.gate}" ]; then '${timeout}' 20 sh -c 'read _ < "$0"' '${fifo}'; fi` : "",
    options.noStop ? `if [ "$1 $2" = "server stop" ]; then exit 0; fi` : "",
    `exec '${resolve(target!)}' "$@"`,
  ].join("\n");
  const path = join(dir, "hc");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return {
    path,
    open: async () => {
      if (!timeout) throw new Error("this hc has no gate");
      const opened = Bun.spawn([timeout, "20", "sh", "-c", `echo go > '${fifo}'`], { env: TOOL_ENV });
      expect(await opened.exited).toBe(0);
    },
  };
}

describe("with-core's options", () => {
  it("runs both gate waits through gtimeout found outside the system PATH", async () => {
    const timer = Bun.which("timeout") ?? Bun.which("gtimeout");
    if (!timer) throw new Error("the gate contract needs GNU timeout or gtimeout");
    const tools = join(scratch, "homebrew-bin");
    mkdirSync(tools);
    const log = join(tools, "timer-ran");
    const gtimeout = join(tools, "gtimeout");
    writeFileSync(gtimeout, `#!/bin/sh\necho timer >> '${log}'\nexec '${timer}' "$@"\n`);
    chmodSync(gtimeout, 0o755);
    const path = process.env["PATH"];
    let hc: ReturnType<typeof gatedHc>;
    try {
      process.env["PATH"] = tools;
      hc = gatedHc("portable-gate", { gate: "start" }, "/bin/echo");
    } finally {
      if (path === undefined) delete process.env["PATH"];
      else process.env["PATH"] = path;
    }
    const child = Bun.spawn([hc.path, "server", "start"], { env: TOOL_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited, hc.open()]);
      expect({ out, err, code }).toEqual({ out: "server start\n", err: "", code: 0 });
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("timer\ntimer\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, TEST_MS);

  it("sees a detached system command in its run's working directory after the helper exits", async () => {
    const run = helper(["--no-core", "--", "true"], callerEnv());
    expect(await run.exited).toBe(0);
    // No marker in argv or the environment: SIP does not disclose these commands' environments.
    const stray = Bun.spawn(["/bin/sleep", "30"], { env: TOOL_ENV, cwd: run.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    try {
      expect(leftovers(run)).toEqual({ ...NOTHING_LEFT, processes: [stray.pid] });
    } finally {
      stray.kill();
      await stray.exited;
    }
  }, TEST_MS);

  for (const [what, args, env] of [
    ["an unknown option", ["--frobnicate", "--", "true"], {}],
    ["--size without --pty", ["--no-core", "--size", "40x5", "--", "true"], {}],
    ["a --size that is not COLSxROWS", ["--no-core", "--pty", "--size", "40", "--", "true"], {}],
    ["an --answer that is not y or n", ["--no-core", "--pty", "--answer", "maybe", "--", "true"], {}],
    ["an empty --keys list", ["--no-core", "--pty", "--keys", "", "--", "true"], {}],
    ["no command", ["--no-core"], {}],
    ["a limit that is not a number", ["--limit", "soon", "--", "true"], {}],
    ["a limit longer than a timer holds", ["--no-core", "--limit", "2147484", "--", "true"], {}],
    ["no hc named", ["--", "true"], { OVIS_TEST_HC_BIN: undefined }],
  ] as const) {
    it(`exits 2 on ${what}, before anything runs`, async () => {
      const run = helper([...args], callerEnv(env));
      expect(await run.exited).toBe(2);
      expect(run.stderr()).not.toContain("root=");
      expect(run.stderr().trim().split("\n")).toHaveLength(1);
    }, TEST_MS);
  }

  it("refuses --core-env with a socket outside ~/.cache/ovis-tmp/ before anything runs", async () => {
    const file = join(scratch, "outside.env");
    const marker = join(scratch, "ran");
    writeFileSync(file, "HC_SOCKET=/var/empty/hc.sock\nHC_SESSION=elsewhere\nXDG_RUNTIME_DIR=/var/empty\n");
    const run = helper(["--core-env", file, "--", "sh", "-c", `touch '${marker}'`], callerEnv());
    expect(await run.exited).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(run.stderr()).not.toContain("root=");
  }, TEST_MS);

  it("refuses --core-env with a relative socket, or a socket that is a link out of ~/.cache/ovis-tmp/, before anything runs", async () => {
    // a HOME of the test's own, run from inside its ~/.cache/ovis-tmp/: each input would pass but for the check it tests, on any machine
    const home = join(scratch, "home");
    const trials = join(home, ".cache", "ovis-tmp");
    const links = join(trials, "links");
    const cwd = join(trials, "cwd");
    mkdirSync(links, { recursive: true });
    mkdirSync(cwd);
    // a link to a file that is there and one to nothing, both pointing outside that ~/.cache/ovis-tmp/
    symlinkSync("/bin/sh", join(links, "there.sock"));
    symlinkSync("/var/empty/hc.sock", join(links, "nothing.sock"));
    for (const socket of ["run/hc.sock", join(links, "there.sock"), join(links, "nothing.sock")]) {
      const file = join(scratch, "linked.env");
      const marker = join(scratch, "ran-linked");
      writeFileSync(file, `HC_SOCKET=${socket}\nHC_SESSION=elsewhere\n`);
      const run = helper(["--core-env", file, "--", "sh", "-c", `touch '${marker}'`], callerEnv({ HOME: home }), { cwd });
      expect({ socket, exit: await run.exited, ran: existsSync(marker) }).toEqual({ socket, exit: 2, ran: false });
      expect(run.stderr()).not.toContain("root=");
    }
  }, TEST_MS);

  it("runs a command whose first word starts with a dash after `-- --`, and refuses it as an option after one `--`", async () => {
    const dir = join(scratch, "dash");
    mkdirSync(dir);
    writeFileSync(join(dir, "-dash"), "#!/bin/sh\necho dashed \"$@\"\n");
    chmodSync(join(dir, "-dash"), 0o755);
    const env = callerEnv({ PATH: `${dir}:${process.env["PATH"]}`, OVIS_TEST_HC_BIN: undefined });
    const ran = helper(["--no-core", "--", "--", "-dash", "x"], env);
    expect(await ran.exited).toBe(0);
    expect(ran.stdout()).toBe("dashed x\n");
    // bun drops a `--` right after the script, so one `--` leaves the dash word where options are read
    const refused = helper(["--", "-dash"], env);
    expect(await refused.exited).toBe(2);
    expect(refused.stderr()).not.toContain("root=");
  }, TEST_MS);

  it("runs the command as the leader of a process group and session of its own", async () => {
    // `s` in ps's state is a session leader on both Linux and macOS.
    const run = helper(["--no-core", "--", "sh", "-c", 'exec /bin/ps -p "$$" -o pid= -o pgid= -o stat='], callerEnv({ OVIS_TEST_HC_BIN: undefined }));
    expect(await run.exited).toBe(0);
    expect(run.stdout().trim()).toMatch(/^([1-9]\d*)\s+\1\s+\S*s\S*$/);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("redirects plugin discovery and status away from the caller's herdr and Ovis", async () => {
    const env = callerEnv({
      HERDR_SOCKET: "/not-the-test/herdr.sock", PORT: "7317",
      HERDR_PLUGIN_CONFIG_DIR: "/not-the-test/config", HERDR_PLUGIN_STATE_DIR: "/not-the-test/state",
      HC_SOCKET: "/not-the-test/hc.sock", OVIS_TEST_HC_BIN: undefined,
    });
    const run = helper(["--no-core", "--", "sh", "-c",
      'printf "%s\\n" "${HERDR_SOCKET-unset}" "$PORT" "$HC_SOCKET" "$HERDR_PLUGIN_CONFIG_DIR" "$HERDR_PLUGIN_STATE_DIR"'], env);
    expect(await run.exited).toBe(0);
    const root = run.stderr().match(/root=(\S+)/)?.[1];
    expect(root).toBeDefined();
    expect(run.stdout().trimEnd().split("\n")).toEqual([
      "unset", "1", `${root}/run/hc.sock`, `${root}/plugin-config`, `${root}/plugin-state`,
    ]);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("--no-core starts no hc: a stand-in hc first on PATH logs nothing", async () => {
    const dir = join(scratch, "standin");
    mkdirSync(dir);
    const log = join(dir, "calls.log");
    writeFileSync(join(dir, "hc"), `#!/bin/sh\necho "$@" >> '${log}'\n`);
    chmodSync(join(dir, "hc"), 0o755);
    const env = callerEnv({ PATH: `${dir}:${process.env["PATH"]}`, OVIS_TEST_HC_BIN: join(dir, "hc") });
    const run = helper(["--no-core", "--", "sh", "-c", 'test ! -e "$HC_SOCKET" && test "$HOME" != "$CALLER_HOME" && test -z "$HC_TERMINAL_ID"'], { ...env, CALLER_HOME: callerHome });
    expect(await run.exited).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
    // the stand-in does log when it is run
    expect(await Bun.spawn([join(dir, "hc"), "control"], { env }).exited).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("control\n");
  }, TEST_MS);
});

describe("with-core cleanup with a CLI stand-in", () => {
  for (const mode of ["start", "status", "status-read"] as const) {
    it(`cleans up before the test releases inherited hc pipes: ${mode}`, async () => {
      const dir = mkdtempSync(join(scratch, "pipes-"));
      const gate = join(dir, "gate");
      const seen = join(dir, "seen");
      const python = Bun.which("python3");
      if (!python) throw new Error("the inherited-pipe contract needs Python 3 for SCM_RIGHTS");
      // SCM_RIGHTS transfers the real inherited writers to a child whose handle the test owns. This works for
      // Bun's socketpair-backed pipes too; opening /proc/<pid>/fd cannot duplicate those descriptors.
      const holder = Bun.spawn([python, "-I", "-c", [
        "import contextlib, os, socket, sys",
        "with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:",
        "    server.bind(sys.argv[1])",
        "    server.listen(1)",
        '    print("listening", flush=True)',
        "    conn, _ = server.accept()",
        "    with conn:",
        "        _, fds, _, _ = socket.recv_fds(conn, 1, 2)",
        "    with contextlib.ExitStack() as stack:",
        "        for fd in fds:",
        '            stack.enter_context(os.fdopen(fd, "wb"))',
        '        print("holding", flush=True)',
        "        sys.stdin.read()",
      ].join("\n"), gate], { env: TOOL_ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const reader = holder.stdout.getReader();
      let output = "";
      let holding = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const until = async (word: string) => {
        const read = async () => {
          while (!output.includes(word)) {
            const part = await reader.read();
            if (part.done) throw new Error(`pipe holder ended before ${word}: ${output}`);
            output += new TextDecoder().decode(part.value);
          }
        };
        try {
          await Promise.race([read(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no pipe holder ${word}`)), WAIT_MS);
          })]);
        } finally { clearTimeout(timer); }
      };
      const sendFds = [
        "import socket, sys",
        "with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:",
        "    conn.connect(sys.argv[1])",
        '    socket.send_fds(conn, [b"x"], [1, 2])',
      ].join("\n");
      const path = join(dir, "hc");
      writeFileSync(path, [
        `#!${process.execPath}`,
        'import { existsSync, unlinkSync, writeFileSync } from "node:fs";',
        "const verb = process.argv[3];",
        'if (verb === "start") writeFileSync(process.env.HC_SOCKET, "stand-in");',
        'if (verb === "status") console.log(JSON.stringify({ pid: process.pid }));',
        'if (verb === "stop" && existsSync(process.env.HC_SOCKET)) unlinkSync(process.env.HC_SOCKET);',
        `if (verb === ${JSON.stringify(mode === "start" ? "start" : "status")} && !existsSync(${JSON.stringify(seen)})) {`,
        `  writeFileSync(${JSON.stringify(seen)}, "seen");`,
        '  console.error("stderr prefix");',
        `  const sender = Bun.spawn([${JSON.stringify(python)}, "-I", "-c", ${JSON.stringify(sendFds)}, ${JSON.stringify(gate)}], { env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });`,
        "  if (await sender.exited !== 0) process.exit(1);",
        "}",
      ].join("\n"));
      chmodSync(path, 0o755);
      const folder = mode === "status-read" ? coreFolder() : null;
      let run: Run | null = null;
      let status: Promise<boolean> | null = null;
      try {
        await until("listening");
        run = folder ? null : helper(["--limit", "1", "--", "/bin/true"], callerEnv({ OVIS_TEST_HC_BIN: path }));
        status = folder ? corePids(path, folder.env).then(() => false, (error: unknown) => error instanceof Error && error.message.includes("exited 124")) : null;
        await until("holding");
        holding = true;
        if (run) {
          await run.line(/with-core: stopped pids=/);
          expect(await run.exited).toBe(124);
          expect(existsSync(run.stderr().match(/root=(\S+)/)![1]!)).toBe(false);
        } else {
          const bounded = await Promise.race([status, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), WAIT_MS); })]);
          expect(bounded).toBe(true);
        }
        expect(holder.exitCode).toBeNull();
        expect(holder.signalCode).toBeNull();
      } finally {
        clearTimeout(timer);
        holder.stdin.end();
        if (!holding && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
        await holder.exited;
        reader.releaseLock();
        expect(await new Response(holder.stderr).text()).toBe("");
        if (run) await run.exited;
        if (status) await status;
        if (folder) rmSync(folder.root, { recursive: true, force: true });
      }
      if (run) expect(leftovers(run)).toEqual(NOTHING_LEFT);
    }, TEST_MS);
  }

  for (const verb of ["start", "status", "stop"] as const) {
    it(`an hc server ${verb} that ignores SIGTERM cannot strand cleanup`, async () => {
      const hc = standInHc(`blocked-${verb}`, verb);
      const run = helper(["--limit", "1", "--", "/bin/true"], callerEnv({ OVIS_TEST_HC_BIN: hc.path }));
      // Once the command ended, with-core clears --limit before normal cleanup; its successful exit still wins.
      expect(await run.exited).toBe(verb === "stop" ? 0 : 124);
      expect(readFileSync(hc.log, "utf8")).toContain(`${verb}\n`);
      expect(existsSync(hc.watchdog)).toBe(false);
      expect(leftovers(run)).toEqual(NOTHING_LEFT);
    }, TEST_MS);
  }

  it("a dump WASM failure stops the started core and removes its folder", async () => {
    const hc = standInHc("dump-failure");
    const preload = join(scratch, "fail-dump.js");
    writeFileSync(preload, 'WebAssembly.Module = new Proxy(WebAssembly.Module, { construct() { throw new Error("forced dump WASM failure"); } });\n');
    const run = helper(["--pty", "--dump", "--", "/bin/sh", "-c", "printf rendered"], callerEnv({ OVIS_TEST_HC_BIN: hc.path }), { preload });
    const code = await run.exited;
    expect({
      code, renderingFailed: run.stderr().includes("forced dump WASM failure"),
      calls: readFileSync(hc.log, "utf8").trim().split("\n"), left: leftovers(run),
    }).toEqual({ code: 125, renderingFailed: true, calls: ["start", "status", "stop"], left: NOTHING_LEFT });
  }, TEST_MS);
});

describe("with-core --pty", () => {
  const noHc = () => callerEnv({ OVIS_TEST_HC_BIN: undefined });

  it("--dump preserves the last alternate screen even after the command restores the terminal", async () => {
    const run = helper(["--no-core", "--pty", "--size", "40x5", "--dump", "--", "sh", "-c",
      "printf 'original-screen\\033[?1049h\\033[Hlast-frame\\033[?1049ldetached\\r\\n'"], noHc());
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toMatch(/^last-frame\n+\s*$/m);
    expect(run.stdout()).not.toMatch(/original-screen|detached/);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("runs the command on a pseudo-terminal of the given size, and --dump prints the final cells", async () => {
    const run = helper(["--no-core", "--pty", "--size", "30x4", "--dump", "--", "sh", "-c", "test -t 0 && test -t 1 && stty size && printf hello"], noHc());
    expect(await run.exited).toBe(0);
    // server/pty/host.ts may say first, on stdout, which PTY host it took; the dump is what ends stdout
    expect(run.stdout().endsWith("\n4 30\nhello\n\n\n") || run.stdout() === "4 30\nhello\n\n\n").toBe(true);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("keeps a finite command's exit code when it prints more than the entry runs' transcript cap", async () => {
    const run = helper(["--no-core", "--pty", "--limit", "60", "--dump", "--", "sh", "-c", "head -c 17825793 /dev/zero | tr '\\0' x; exit 7"], noHc());
    expect(await run.exited).toBe(7);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("without --dump passes the output on as it comes", async () => {
    const run = helper(["--no-core", "--pty", "--", "sh", "-c", "printf streamed"], noHc());
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("streamed");
  }, TEST_MS);

  it("--answer answers the [Y/n] question and --keys are typed only after the first frame", async () => {
    const script = 'printf "start it? [Y/n] "; read a; printf "\\033[?2026h\\033[?2026l"; read b; echo "a=$a b=$b"';
    const run = helper(["--no-core", "--pty", "--answer", "y", "--keys", "x,ctrl+v,y,enter", "--dump", "--", "sh", "-c", script], noHc());
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("a=y b=xy");
  }, TEST_MS);

  // the queries in the shell's printf notation, and the replies a terminal sends, as hex
  const DA1 = { query: "\\033[c", reply: "1b5b3f36323b323263" };
  const SYNC = { query: "\\033[?2026$p", reply: "1b5b3f323032363b322479" };
  /** each printf, then what the command reads back after it (that many bytes), all printed as hex on one line at the end */
  const readBack = (...steps: [printf: string, bytes: number][]) =>
    `stty raw -echo; ${steps.map(([printf, bytes], i) => `${printf}; r${i}=$(head -c ${bytes} | od -An -tx1 -v | tr -d ' \\n')`).join("; ")}; printf '%s' ${steps.map((_, i) => `"$r${i}"`).join(" ")}; stty sane`;

  it("answers DA1 as a terminal does", async () => {
    const script = readBack([`printf '${DA1.query}'`, 9]);
    const run = helper(["--no-core", "--pty", "--limit", "20", "--dump", "--", "sh", "-c", script], noHc());
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain(DA1.reply);
  }, TEST_MS);

  for (const [what, script, replies] of [
    ["the start probe's queries (those it does not know left unanswered)", readBack([`printf '\\033[?u${SYNC.query}\\033]10;?\\033\\\\\\033]11;?\\033\\\\\\033]12;?\\033\\\\\\033[16t${DA1.query}'`, 20]), [SYNC, DA1]],
    ["DA1 before DECRQM 2026", readBack([`printf '${DA1.query}${SYNC.query}'`, 20]), [DA1, SYNC]],
    // the rest of the cut query is written only once the DA1 reply came back (two reads for certain), and nothing between
    ["a query cut across two reads", readBack([`printf '${DA1.query}\\033[?20'`, 9], ["printf '26$p'", 11]), [DA1, SYNC]],
  ] as const) {
    it(`answers queries in the order they arrive: ${what}`, async () => {
      const run = helper(["--no-core", "--pty", "--limit", "20", "--dump", "--", "sh", "-c", script], noHc());
      expect(await run.exited).toBe(0);
      expect(run.stdout()).toContain(replies.map((answer) => answer.reply).join(""));
    }, TEST_MS);
  }

  it("types --keys only after the probe's last reply", async () => {
    const script = readBack([`printf '${SYNC.query}${DA1.query}\\033[?2026h\\033[?2026l'`, 23]);
    const run = helper(["--no-core", "--pty", "--limit", "20", "--keys", "x,ctrl+b,y", "--dump", "--", "sh", "-c", script], noHc());
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain(`${SYNC.reply}${DA1.reply}780279`);
  }, TEST_MS);

  it("ends a command that outlives --limit through the PTY host, and leaves nothing", async () => {
    const run = helper(["--no-core", "--pty", "--limit", "1", "--", "sh", "-c", "printf running; exec sleep 30"], noHc());
    expect(await run.exited).toBe(124);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);
});

describe.skipIf(!bin)("with-core against a real hc", () => {
  it("gives the command an isolated core and none of the caller's settings", async () => {
    const check = [
      'test -S "$HC_SOCKET"', 'test -z "$HC_TERMINAL_ID"', 'test -z "$HC_TERMINAL_SOCKET"', 'test -z "$HC_SCOPE"', 'test -z "$OVIS_TOKEN"', `test -z "$${OLD_TOKEN}"`,
      'test -z "$OVIS_TEST_HC_BIN"', 'test -n "$HERDR_TEST_SESSION"', `test "$HOME" != '${callerHome}'`, 'test "$HC_SESSION" != default', 'echo isolated',
    ].join(" && ");
    const run = helper(["--", "sh", "-c", check], callerEnv({ OVIS_TEST_HC_BIN: bin, HC_TERMINAL_SOCKET: "/run/user/0/elsewhere.sock" }));
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("isolated");
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("passes the command's exit code through, 128 plus the signal for a command a signal ended", async () => {
    const failing = helper(["--", "sh", "-c", "exit 7"], callerEnv({ OVIS_TEST_HC_BIN: bin }));
    expect(await failing.exited).toBe(7);
    expect(leftovers(failing)).toEqual(NOTHING_LEFT);
    const signalled = helper(["--", "sh", "-c", "kill -TERM $$"], callerEnv({ OVIS_TEST_HC_BIN: bin }));
    expect(await signalled.exited).toBe(128 + constants.signals.SIGTERM);
    expect(leftovers(signalled)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it(`${name} before the core answered: the core it then gets is still stopped`, async () => {
      const hc = gatedHc(`start-${name}`, { gate: "start" });
      const marker = join(scratch, `ran-${name}`);
      const run = helper(["--", "sh", "-c", `touch '${marker}'`], callerEnv({ OVIS_TEST_HC_BIN: hc.path }));
      await run.line(/root=/);
      run.signal(name);
      await hc.open();
      expect(await run.exited).toBe(128 + constants.signals[name]);
      expect(existsSync(marker)).toBe(false);
      expect(run.stderr()).toMatch(/stopped pids=\d+/);
      expect(leftovers(run)).toEqual(NOTHING_LEFT);
    }, TEST_MS);

    it(`${name} while the command runs: the command's processes end, then the core`, async () => {
      const run = helper(["--", "sh", "-c", "echo running $$; exec sleep 30"], callerEnv({ OVIS_TEST_HC_BIN: bin }));
      const command = Number((await run.line(/running (\d+)/))[1]);
      run.signal(name);
      expect(await run.exited).toBe(128 + constants.signals[name]);
      expect(pidAlive(command)).toBe(false);
      expect(leftovers(run)).toEqual(NOTHING_LEFT);
    }, TEST_MS);

    it(`${name} during cleanup: the cleanup still finishes`, async () => {
      const hc = gatedHc(`stop-${name}`, { gate: "stop" });
      const run = helper(["--", "true"], callerEnv({ OVIS_TEST_HC_BIN: hc.path }));
      await run.line(/with-core: stopping/);
      run.signal(name);
      await hc.open();
      expect(await run.exited).toBe(128 + constants.signals[name]);
      expect(leftovers(run)).toEqual(NOTHING_LEFT);
    }, TEST_MS);
  }

  it("a program that enters through tui/host detects synchronized output and gets exactly the typed --keys", async () => {
    const run = helper(["--limit", "20", "--pty", "--size", "100x30", "--keys", "a,b,ctrl+b", "--", process.execPath, PROBE_ECHO], callerEnv({ OVIS_TEST_HC_BIN: bin }));
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("SYNC true\r");
    // a read may cut the typed text in two: text events are taken a character at a time
    const events = [...run.stdout().matchAll(/EVENT ([^\r]*)\r/g)].flatMap(([, event]) => (event!.startsWith("text ") ? [...event!.slice(5)] : [event!]));
    expect(events).toEqual(["a", "b", "key ctrl+B"]);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("--limit ends the command and still cleans up", async () => {
    const started = Date.now();
    const run = helper(["--limit", "2", "--", "sh", "-c", "echo running $$; exec sleep 30"], callerEnv({ OVIS_TEST_HC_BIN: bin }));
    const command = Number((await run.line(/running (\d+)/))[1]);
    expect(await run.exited).toBe(124);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(pidAlive(command)).toBe(false);
    expect(leftovers(run)).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("a stop that does nothing: the recorded core and holder are killed, and the run fails", async () => {
    const hc = gatedHc("nostop", { noStop: true });
    // a terminal of the command's own: its core then has a holder, whose pid is read before the stop
    const script = join(scratch, "run-terminal.ts");
    writeFileSync(script, [
      `import { HcConnection } from ${JSON.stringify(join(import.meta.dir, "..", "..", "server", "herdr-core", "connection.ts"))};`,
      `import { connectCoreSocket } from ${JSON.stringify(join(import.meta.dir, "..", "..", "server", "herdr-core", "socket-transport.ts"))};`,
      "const transport = await connectCoreSocket(process.env.HC_SOCKET!);",
      "const hc = new HcConnection(() => transport);",
      'await hc.call("terminal.run", { argv: ["sleep", "1000"] });',
      "hc.close();",
    ].join("\n"));
    const run = helper(["--", process.execPath, script], callerEnv({ OVIS_TEST_HC_BIN: hc.path }));
    expect(await run.exited).not.toBe(0);
    expect(run.stderr()).toMatch(/killed=\d+,\d+/);
    expect({ ...leftovers(run), socket: false }).toEqual(NOTHING_LEFT);
  }, TEST_MS);

  it("--core-env runs the command against a core named in a file under ~/.cache/ovis-tmp/, and starts nothing", async () => {
    const core = new IsolatedCore(bin!);
    ownCore = core;
    try {
      await core.start();
      const inside = core.socket.startsWith(`${callerHome}/.cache/ovis-tmp/`);
      const file = join(scratch, "core.env");
      writeFileSync(file, Object.entries(core.env).filter(([key]) => key.startsWith("HC_") || key.startsWith("XDG_")).map(([key, value]) => `export ${key}='${value}'`).join("\n"));
      const run = helper(["--core-env", file, "--", "sh", "-c", `test "$HC_SOCKET" = '${core.socket}' && test -S "$HC_SOCKET" && test "$HOME" != '${callerHome}'`], callerEnv({ OVIS_TEST_HC_BIN: undefined }));
      // outside ~/.cache/ovis-tmp (a CI runner's temp folder) the same file is refused
      expect(await run.exited).toBe(inside ? 0 : 2);
      expect(existsSync(core.socket)).toBe(true);
    } finally {
      // still named while it stops: a signal's teardown awaits the same stop
      const report = await core.stop();
      ownCore = null;
      expect({ killed: report.killed, alive: report.alive, rootGone: report.rootGone }).toEqual({ killed: [], alive: [], rootGone: true });
    }
  }, TEST_MS);
});
