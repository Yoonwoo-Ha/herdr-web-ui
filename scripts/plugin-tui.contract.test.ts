import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cleanUpAll, coreStops } from "./test-cleanup.ts";
import { coreFolder, IsolatedCore } from "./test-hc.ts";
import { buildBinary } from "./server-artifact.ts";
import { runOnPty, stopAllPtyRuns, type PtyRun } from "../tui/testing/pty.ts";

// `ovis tui` run as a user runs it: the real scripts/plugin.ts (and the compiled binary) on a pseudo-terminal, in a
// folder of the user's own that holds `.env` files and a `bunfig.toml`, against a herdr-core of the test's own. The hc
// named in the settings is a stand-in that records the environment `server start` got and then runs the real hc. The
// fallback runs the same launcher through a driver that gives it no kernel copy.

const HC = process.env["OVIS_TEST_HC_BIN"] ?? "";
const ROOT = join(import.meta.dir, "..");
const CASE_MS = 120_000;
const FIRST_FRAME_END = "\x1b[?2026l";
/** what a terminal answers to the screen's start probe: DA1 ends it, DECRQM 2026 says synchronized output works */
const ANSWERS: [query: string, answer: string][] = [["\x1b[c", "\x1b[?62;22c"], ["\x1b[?2026$p", "\x1b[?2026;2$y"]];
/** names only the folder's files give, SHELL among them: none may reach the screen or the core (Bun loads each, measured) */
const FILE_ONLY = ["CANARY_GENERIC", "DOTENV_SECRET", "OVIS_TOKEN", "LOCAL_ONLY", "H1", "H4", "S1", "S2", "S3", "QUOTED", "EXPANDED", "EXPORTED", "BACKTICK", "CRLF_NAME",
  "DB_HOST", "DATABASE_URL", "DEFAULT_TOKEN", "TOKEN", "HC_SESSION", "TZ", "TMPDIR", "HC_API_KEY", "SHELL"];
const PLUGIN = join(ROOT, "scripts", "plugin.ts");

const cores: IsolatedCore[] = [];
const scratches: string[] = [];
let built = "";
let ending: Promise<void> | undefined;
/** One teardown, whoever asks: the ptys, every core, the built binaries and the scratch homes are each tried, and what failed is thrown after the last. */
const teardown = () => (ending ??= cleanUpAll([
  stopAllPtyRuns,
  ...coreStops(cores.splice(0)),
  () => { if (built) rmSync(built, { recursive: true, force: true }); },
  () => { for (const root of scratches.splice(0)) rmSync(root, { recursive: true, force: true }); },
]));
afterAll(teardown, CASE_MS);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => { void teardown().catch(() => undefined).finally(() => process.exit(128 + 15)); });

interface Scene {
  folder: { root: string; env: Record<string, string> };
  project: string;
  record: string;
  marker: string;
  env: Record<string, string>;
  mark: string;
}

/**
 * An isolated core's folders, a home whose Ovis settings name the stand-in hc, and the user's project folder.
 * `repeated`: the folder's .env also repeats the shell's own PATH, HOME and TERM. With the kernel's copy they stay; a
 * launch without it cannot tell whose they are and drops them, so its scenes leave them to the shell alone.
 */
function scene(extra: Record<string, string> = {}, repeated = true): Scene {
  const folder = coreFolder();
  const home = join(folder.root, "home");
  const project = join(folder.root, `proj${crypto.randomUUID().slice(0, 8)}`);
  const record = join(folder.root, "hc-start-env");
  const marker = join(project, "preload-pids");
  const config = join(home, ".config");
  const settings = join(config, "ovis");
  mkdirSync(settings, { recursive: true });
  mkdirSync(project);
  const standIn = join(folder.root, "hc-stand-in");
  writeFileSync(standIn, `#!/bin/sh
if [ "$1" = server ] && [ "$2" = start ]; then
  env > '${record}'
  [ "$HC_SOCKET" = '${folder.env["HC_SOCKET"]}' ] && [ -z "$HC_SESSION" ] || exit 9
  case "$XDG_CONFIG_HOME" in ''|'${folder.env["XDG_CONFIG_HOME"]}') ;; *) exit 9 ;; esac
fi
exec '${HC}' "$@"
`);
  chmodSync(standIn, 0o755);
  // If the fallback drops the shell's HC_SOCKET, the scratch settings select the same socket.
  writeFileSync(join(settings, "env"), `OVIS_HC_BIN=${standIn}\nHC_SOCKET=${folder.env["HC_SOCKET"]}\n`);
  const path = process.env["PATH"] ?? "/usr/bin:/bin";
  writeFileSync(join(project, ".env"), [
    "CANARY_GENERIC=x", "DOTENV_SECRET=y", "OVIS_TOKEN=z",
    // the forms an older rebuild missed: a value cut at `#`, `$` expanded inside single quotes
    "H1=a#b", "H4=pass#word123", "S1='$HOME'", "S2='pa$$word'", "S3='a$b'",
    'QUOTED="a b"', "EXPANDED=${HOME}/x", "export EXPORTED=e", "BACKTICK=`bt`", "CRLF_NAME=c\r",
    "DB_HOST=localhost", "DEFAULT_TOKEN=canary", "TOKEN=${TOKEN_OVERRIDE:-$DEFAULT_TOKEN}",
    `HC_SOCKET=${join(project, "file.sock")}`, "HC_SESSION=file", "TZ=UTC", `TMPDIR=${project}`,
    "HC_API_KEY=canary", `XDG_CONFIG_HOME=${project}`, "SAMEVAL=same",
    // one of the shell's basic names that only the folder gives
    "SHELL=/only/from/folder",
    // the shell's own values repeated: they must stay
    ...(repeated ? [`PATH=${path}`, `HOME=${home}`, "TERM=xterm-256color"] : []),
    "",
  ].join("\n"));
  writeFileSync(join(project, ".env.local"), "LOCAL_ONLY=l\nDATABASE_URL=postgres://app:canary@$DB_HOST/app\n");
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(project, "preload.ts"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, process.pid + "\\n");\n`);
  const mark = crypto.randomUUID();
  // Leave HC_SESSION and TMPDIR to the file so the test can detect if either leaks.
  const { HC_SESSION: _session, ...coreEnv } = folder.env;
  const env: Record<string, string> = {
    ...coreEnv, PATH: path, HOME: home, TERM: "xterm-256color",
    SAMEVAL: "same", HERDR_TEST_SESSION: `plugin-tui-${process.pid}`, PLUGIN_TUI_MARK: mark,
    // nothing listens on port 1, and the settings and state folders are the scratch home's
    PORT: "1", HERDR_PLUGIN_CONFIG_DIR: settings, HERDR_PLUGIN_STATE_DIR: join(folder.root, "plugin-state"), ...extra,
  };
  return { folder, project, record, marker, env, mark };
}

/** `command` started in the project folder on a pty that answers the screen's probe as a terminal does. */
function launch(at: Pick<Scene, "project" | "env">, command: string): PtyRun {
  let tail = "";
  const run: PtyRun = runOnPty({
    command: ["sh", "-c", `cd '${at.project}' && exec ${command}`], env: at.env, cols: 100, rows: 30, deadlineMs: CASE_MS - 10_000,
    onData: (text) => {
      // in the order the queries came: DA1 ends the probe, so an answer after it comes too late
      const window = tail + text;
      const asked: [at: number, answer: string][] = [];
      for (const [query, answer] of ANSWERS) {
        for (let at = window.indexOf(query); at !== -1; at = window.indexOf(query, at + 1)) if (at + query.length > tail.length) asked.push([at, answer]);
      }
      for (const [, answer] of asked.sort((a, b) => a[0] - b[0])) run.type(answer);
      tail = window.slice(-16);
    },
  });
  return run;
}

const environOf = (pid: number) => Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry.includes("=")).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
const argvOf = (pid: number) => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");

/** The screen's process: it carries the scene's mark and runs the entry `tui`. Listed, never signalled. */
function screenPid(at: Scene): number {
  const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => {
    try {
      const argv = argvOf(pid);
      return readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PLUGIN_TUI_MARK=${at.mark}`) && (argv.some((word) => word.endsWith("tui/main.ts")) || argv[1] === "tui");
    } catch {
      return false;
    }
  });
  expect(pids.length).toBe(1);
  return pids[0]!;
}

const recorded = (file: string) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

/** No file-only name, by either path; and the shell's own PATH, HOME and TERM, which no file of a fallback scene names. */
function shellOnly(at: Scene, env: Record<string, string>): void {
  expect(FILE_ONLY.filter((name) => name in env)).toEqual([]);
  expect(env["HC_SOCKET"]).toBe(at.folder.env["HC_SOCKET"]);
  expect([undefined, at.env["XDG_CONFIG_HOME"]]).toContain(env["XDG_CONFIG_HOME"]);
  expect([env["PATH"], env["HOME"], env["TERM"]]).toEqual([at.env["PATH"], at.env["HOME"], at.env["TERM"]]);
}

/**
 * Runs `command` from the project folder, answers the question, checks the screen and the core (and the folder the
 * screen opens its first workspace in), detaches, and leaves the core it started to the teardown.
 */
async function startsACore(command: string, at = scene(), fallback = false): Promise<{ screen: Record<string, string>; core: Record<string, string>; serve: Record<string, string>; screenPid: number; marker: string }> {
  const core = new IsolatedCore(HC, at.folder);
  cores.push(core);
  const run = launch(at, command);
  try {
    // the space after the question: what was typed up to it is thrown away, a line typed from there on is the answer
    await run.until("[Y/n] ", "the question");
    run.type("y\r");
    await run.until(FIRST_FRAME_END, "the first frame");
    // a fresh core has no workspace: the screen opens the first one in the folder `ovis tui` was typed in, named after it
    await run.until(basename(at.project), "the folder the command was typed in");
    const pid = screenPid(at);
    const screen = environOf(pid);
    const started = recorded(at.record);
    await core.adopt();
    const [corePid] = core.pids;
    if (corePid === undefined) throw new Error("started core did not report its pid");
    const serve = environOf(corePid);
    for (const env of [screen, started, serve]) {
      shellOnly(at, env);
      if (fallback) {
        expect(env).not.toHaveProperty("SAMEVAL");
        expect(env).not.toHaveProperty("XDG_CONFIG_HOME");
      }
    }
    expect(screen["OVIS_TUI_CWD"]).toBe(at.project);
    run.type("\x02q");
    await run.until("detached from herdr-core", "the detach line");
    await run.exited;
    return { screen, core: started, serve, screenPid: pid, marker: existsSync(at.marker) ? readFileSync(at.marker, "utf8") : "" };
  } finally {
    // the core the launcher started is stopped by the teardown, whatever failed above
    await run.stop();
    await core.adopt();
  }
}

describe.skipIf(HC === "" || process.platform !== "linux")("ovis tui hands the screen and a core it starts the shell's environment", () => {
  let driver = "";
  beforeAll(async () => {
    built = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "ovis-tui-binary-"));
    await buildBinary("linux-x64", join(built, "ovis-server"));
    // the fallback: the launcher of scripts/plugin.ts, given no kernel copy; compiled, it is its own `tui` entry too
    driver = join(built, "fallback.ts");
    // as server/main.ts does: the entry's name leaves argv before the entry reads its arguments
    writeFileSync(driver, `if (process.argv[2] === "tui") process.argv.splice(2, 1), await import(${JSON.stringify(join(ROOT, "scripts", "tui-entry.ts"))});
else process.exit(await (await import(${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))})).runTui([], () => null));
`);
    await buildBinary("linux-x64", join(built, "fallback"), driver);
  }, CASE_MS);

  it("dotenv canary: from source, none of the folder's .env names, and its bunfig.toml preload never runs in the screen", async () => {
    const { screenPid: pid, marker } = await startsACore(`bun '${PLUGIN}' tui`);
    expect(marker.split("\n")).not.toContain(String(pid));
    console.log(`from source: the folder's preload ran in ${marker.split("\n").filter(Boolean).length} process(es): the launcher's own Bun, not the screen`);
  }, CASE_MS);

  it("dotenv canary: compiled, run from the user's folder: none of the folder's .env names, and no preload in the screen", async () => {
    const { screenPid: pid, marker } = await startsACore(`'${join(built, "ovis-server")}' plugin tui`);
    expect(marker.split("\n")).not.toContain(String(pid));
  }, CASE_MS);

  it("dotenv canary, fallback without a kernel copy: from source", async () => {
    await startsACore(`bun '${driver}'`, scene({}, false), true);
  }, CASE_MS);

  it("dotenv canary, fallback without a kernel copy: compiled", async () => {
    await startsACore(`'${join(built, "fallback")}'`, scene({}, false), true);
  }, CASE_MS);

  it("kernel copy keeps a shell value that the folder repeats", async () => {
    const { screen, core, serve } = await startsACore(`bun '${PLUGIN}' tui`);
    expect([screen["SAMEVAL"], core["SAMEVAL"], serve["SAMEVAL"]]).toEqual(["same", "same", "same"]);
  }, CASE_MS);

  it("from a pane of another core: the started core gets none of that pane's names, the screen keeps what its own-pane refusal reads", async () => {
    const at = scene({ HC_TERMINAL_ID: "t-other", HC_TERMINAL_SOCKET: join(process.env["TMPDIR"] ?? tmpdir(), "no-such-other-core.sock"), HC_SCOPE: "other-scope" });
    const { screen, core } = await startsACore(`bun '${PLUGIN}' tui`, at);
    expect(["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"].filter((name) => name in core)).toEqual([]);
    expect([screen["HC_TERMINAL_ID"], screen["HC_TERMINAL_SOCKET"], screen["HC_SCOPE"]]).toEqual([at.env["HC_TERMINAL_ID"], at.env["HC_TERMINAL_SOCKET"], undefined]);
  }, CASE_MS);

  it("a core already listens: no question, and the screen has the shell's environment without the Ovis server's own settings", async () => {
    // a shell that also runs the Ovis server exports its settings, a key and a secret among them
    const server = { OVIS_OPENAI_API_KEY: "canary", OVIS_PORTAL_OIDC_CLIENT_SECRET: "canary" };
    const at = scene(server);
    const core = new IsolatedCore(HC, at.folder);
    cores.push(core);
    await core.start();
    const run = launch(at, `bun '${PLUGIN}' tui`);
    try {
      await run.until(FIRST_FRAME_END, "the first frame");
      expect(run.output()).not.toContain("[Y/n]");
      const screen = environOf(screenPid(at));
      shellOnly(at, screen);
      // of Ovis's own names the screen has the two the launcher hands it, and none the shell exported
      expect(Object.keys(screen).filter((name) => name.startsWith("OVIS_")).sort()).toEqual(["OVIS_TUI_CWD", "OVIS_TUI_HOLD"]);
      expect(existsSync(at.record)).toBe(false);
      run.type("\x02q");
      await run.until("detached from herdr-core", "the detach line");
      await run.exited;
    } finally {
      await run.stop();
    }
  }, CASE_MS);

  it("keys typed before the question are no answer to it: nothing starts until the user answers after it", async () => {
    const at = scene();
    const core = new IsolatedCore(HC, at.folder);
    cores.push(core);
    const run = launch(at, `bun '${PLUGIN}' tui`);
    try {
      // typed at once, while the launcher is still starting: they wait in the terminal for whoever reads first
      run.type("y\r\r");
      await run.until("[Y/n] ", "the question");
      // a start the early keys answered would have recorded `server start` by now: the stand-in runs at once
      for (const deadline = Date.now() + 2_000; Date.now() < deadline && !existsSync(at.record); ) await Bun.sleep(25);
      expect(existsSync(at.record)).toBe(false);
      run.type("n\r");
      await run.until("hc server start", "the start command");
      await run.exited;
      expect(existsSync(at.record)).toBe(false);
      expect(existsSync(core.socket)).toBe(false);
    } finally {
      await run.stop();
      await core.adopt();
    }
  }, CASE_MS);
});

/**
 * A scratch home with no core, whose settings name an hc that only records that `server start` ran and then fails:
 * a case here asks whether a core would have been started, so none ever runs.
 */
function noCore(): Pick<Scene, "project" | "env" | "record"> & { root: string } {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "ovis-tui-ask-"));
  scratches.push(root);
  for (const sub of ["home", "run", "settings", "project"]) mkdirSync(join(root, sub));
  const record = join(root, "hc-started");
  const standIn = join(root, "hc");
  writeFileSync(standIn, `#!/bin/sh\ncase "$1" in\n  --version) echo 'hc 0.1.18' ;;\n  server) : > '${record}'; exit 7 ;;\n  *) exit 9 ;;\nesac\n`);
  chmodSync(standIn, 0o755);
  writeFileSync(join(root, "settings", "env"), `OVIS_HC_BIN=${standIn}\n`);
  return {
    root, record, project: join(root, "project"),
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: join(root, "home"), TERM: "xterm-256color", TMPDIR: root, XDG_RUNTIME_DIR: join(root, "run"),
      HC_SOCKET: join(root, "run", "none.sock"), HERDR_TEST_SESSION: `plugin-tui-${process.pid}`,
      PORT: "1", HERDR_PLUGIN_CONFIG_DIR: join(root, "settings"), HERDR_PLUGIN_STATE_DIR: join(root, "plugin-state"),
    },
  };
}

describe.skipIf(process.platform !== "linux")("ovis tui takes only a line sent after its question for an answer", () => {
  it("a space the end of the input cuts short (Space, Ctrl+D, Ctrl+D) is no line: nothing starts", async () => {
    const at = noCore();
    const run = launch(at, `bun '${PLUGIN}' tui`);
    try {
      await run.until("[Y/n] ", "the question");
      // the first Ctrl+D hands the reader the space without a newline, the second ends the input
      run.type(" \x04\x04");
      await run.exited;
      expect(existsSync(at.record)).toBe(false);
      expect(run.output()).toContain("ovis tui: no_core: ");
    } finally {
      await run.stop();
    }
  }, CASE_MS);

  it("an Enter that arrives after the launcher threw the typed keys away and before its question is no answer: nothing starts", async () => {
    const at = noCore();
    // The launcher itself, with one thing added to its first discard: once it is done, it says so and stays until a line
    // waits in the terminal, as a key that arrives in that moment would. No person can aim at it; a held key can hit it.
    const driver = join(at.root, "gap.ts");
    writeFileSync(driver, `import { FFIType } from "bun:ffi";
import { callerEnv, kernelEnv, launchTui, systemParts } from ${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))};
import { openLibc } from ${JSON.stringify(join(ROOT, "tui", "host", "libc.ts"))};
const caller = callerEnv({ kernel: kernelEnv, env: process.env, cwd: process.cwd() });
const parts = systemParts(caller, caller.HOME ?? "/");
const libc = openLibc({ poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 } });
if (libc === null) throw new Error("no C library to wait for the terminal's input with");
let first = true;
process.exit(await launchTui([], { ...parts, discard: () => {
  const done = parts.discard();
  if (first) {
    first = false;
    process.stderr.write("DISCARDED " + done + "\\n");
    // struct pollfd { int fd = 0; short events = POLLIN; short revents; }: readable once a whole line waits
    const stdin = new Uint8Array(8);
    new DataView(stdin.buffer).setInt16(4, 1, true);
    libc.symbols.poll(stdin, 1, ${CASE_MS});
  }
  return done;
} }));
`);
    const run = launch(at, `bun '${driver}'`);
    try {
      await run.until("DISCARDED true", "the launcher's first discard");
      run.type("\r");
      await run.until("[Y/n] ", "the question");
      run.type("n\r");
      await run.exited;
      expect(existsSync(at.record)).toBe(false);
      expect(run.output()).toContain("ovis tui: no_core: ");
    } finally {
      await run.stop();
    }
  }, CASE_MS);
});
