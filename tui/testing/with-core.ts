/**
 * Runs one command against a herdr-core of its own, and always cleans up:
 *
 *   bun tui/testing/with-core.ts [--no-core | --core-env <file>] [--limit <seconds>]
 *     [--pty [--size COLSxROWS] [--keys <list>] [--answer y|n] [--dump]] -- [--] <command...>
 *
 * Bun drops a `--` that comes right after the script, so a command whose first word starts with a
 * dash goes after `-- --`: one more `--` right after the one that ends the options is dropped here.
 * After a single `--` such a word is read as an option, and refused as one (exit 2).
 *
 * Default: a real core (the hc OVIS_TEST_HC_BIN names, run by that absolute path) in a fresh folder
 * under TMPDIR, stopped afterwards. `--no-core`: the same environment, no core. `--core-env <file>`:
 * no core started; the command reaches the core the file's HC_SOCKET, HC_SESSION and XDG_* lines
 * name: an absolute socket path that, through every link, the socket's own included, lies under
 * ~/.cache/ovis-tmp/ (a trial's demo core, never someone's own).
 *
 * The command gets the caller's environment without any HC_*, XDG_*, OVIS_* or HERDR_WEB_* name,
 * then the isolated core's (HC_SOCKET, HC_SESSION, XDG_*), a scratch HOME and HERDR_TEST_SESSION.
 * It does not inherit HERDR_SOCKET and uses scratch plugin folders and closed port 1.
 * It runs as the leader of a process group of its own (`detached: true`: Bun starts it through
 * setsid()), which a signal or the time limit ends as a whole, while the helper has not reaped it.
 * The core's cleanup goes through scripts/test-hc.ts, which kills only a pid proven to be that core's.
 *
 * `--pty` runs the command on a pseudo-terminal of its own (tui/testing/pty.ts; default 80x24, or
 * `--size`) instead of on the helper's stdio, and answers its DA1 and DECRQM 2026 queries the way a
 * terminal does: in the order they arrive, a query cut across reads included (the start probe ends
 * at its DA1 reply, so a reply after it would come too late). What it prints goes to stdout as it
 * comes, or, with `--dump`, only the final cell grid as text, one line a row, once the command
 * ended. `--keys` types a comma-separated list after the first frame (the first `ESC[?2026l`), so
 * after the probe's last reply: keys, mouse reports such as `click@30:5` and text, as
 * tui/testing/keys.ts names them.
 * `--answer y|n` answers the launcher's `[Y/n]` question with that letter and Enter.
 *
 * Exit code: the command's (128 + n when a signal n ended it); 128 + n when the helper got signal
 * n; 124 when `--limit` (default 600 s) ran out; 2 for a wrong call; 125 when the core could not
 * be started or the cleanup had to kill, met a pid it could not prove the core's, or left something.
 * Every path waits for the one cleanup. stderr carries `root=<folder>` once the folder exists and
 * `stopped pids=<a,b> killed=<..> unproven=<..>` at the end.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { coreFolder, IsolatedCore, signalChildGroup, stoppedCleanly } from "../../scripts/test-hc.ts";
import { keyBytes } from "./keys.ts";
import { answerQueries, gridText, runOnPty, screenOutput, type PtyRun } from "./pty.ts";

/** the longest delay a timer holds (a signed 32-bit count of ms) */
const TIMER_MAX_MS = 2 ** 31 - 1;
const USAGE = "usage: bun tui/testing/with-core.ts [--no-core | --core-env <file>] [--limit <seconds>] [--pty [--size COLSxROWS] [--keys <list>] [--answer y|n] [--dump]] -- [--] <command...>";
const FIRST_FRAME_END = "\x1b[?2026l";
const QUESTION = "[Y/n]";
/** what a terminal answers to the queries a screen's start probe ends with */
const ANSWERS: [query: string, answer: string][] = [["\x1b[c", "\x1b[?62;22c"], ["\x1b[?2026$p", "\x1b[?2026;2$y"]];
const COMMAND_GRACE_MS = 5000;
const EXIT_USAGE = 2;
const EXIT_LIMIT = 124;
const EXIT_FAILED = 125;

class Refused extends Error {}

/** The command on a pseudo-terminal: its output passed on (or kept for the dump), queries answered, keys typed. */
function startPty(choice: PtyChoice, command: string[], env: Record<string, string>, limitSeconds: number): PtyRun {
  const answerProbe = answerQueries((answer) => run.type(answer), ANSWERS);
  const run: PtyRun = runOnPty({
    command, env, cols: choice.cols, rows: choice.rows, deadlineMs: limitSeconds * 1000 + COMMAND_GRACE_MS,
    onData: (text) => {
      if (!choice.dump) process.stdout.write(text);
      answerProbe(text);
    },
  });
  const keys = choice.keys;
  if (keys) void run.until(FIRST_FRAME_END, "the first frame").then(() => run.type(keys.split(",").map(keyBytes).join("")), () => {});
  const answer = choice.answer;
  if (answer) void run.until(QUESTION, "the question").then(() => run.type(`${answer}\r`), () => {});
  return run;
}

interface PtyChoice { cols: number; rows: number; keys: string | null; answer: "y" | "n" | null; dump: boolean }

interface Options { mode: "core" | "no-core" | "core-env"; coreEnv: string | null; limitSeconds: number; pty: PtyChoice | null; command: string[] }

/**
 * Options come first; the first `--`, or the first word that is not an option, starts the command,
 * and one more `--` right after that `--` is dropped. Bun itself drops a `--` that comes right after
 * the script, so `-- sh -c x` arrives as `sh -c x` and `-- -- -x` as `-- -x`.
 */
function parse(args: string[]): Options {
  const options: Options = { mode: "core", coreEnv: null, limitSeconds: 600, pty: null, command: [] };
  let pty = false;
  const choice: PtyChoice = { cols: 80, rows: 24, keys: null, answer: null, dump: false };
  const ptyOnly: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--" || !flag.startsWith("-")) {
      const command = args.slice(flag === "--" ? i + 1 : i);
      options.command = flag === "--" && command[0] === "--" ? command.slice(1) : command;
      break;
    }
    if (flag === "--no-core") options.mode = "no-core";
    else if (flag === "--core-env") {
      const file = args[++i];
      if (!file) throw new Refused("--core-env needs a file");
      options.mode = "core-env";
      options.coreEnv = file;
    } else if (flag === "--limit") {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Refused("--limit needs a number of seconds above 0");
      // a longer timer would fire at once
      if (seconds * 1000 > TIMER_MAX_MS) throw new Refused(`--limit takes at most ${Math.floor(TIMER_MAX_MS / 1000)} seconds`);
      options.limitSeconds = seconds;
    } else if (flag === "--pty") pty = true;
    else if (flag === "--size") {
      const size = /^(\d+)x(\d+)$/.exec(args[++i] ?? "");
      const [cols, rows] = [Number(size?.[1]), Number(size?.[2])];
      if (!size || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) throw new Refused("--size needs COLSxROWS, each 1 to 1000");
      Object.assign(choice, { cols, rows });
      ptyOnly.push(flag);
    } else if (flag === "--keys") {
      const keys = args[++i];
      if (!keys) throw new Refused("--keys needs a comma-separated list");
      choice.keys = keys;
      ptyOnly.push(flag);
    } else if (flag === "--answer") {
      const answer = args[++i];
      if (answer !== "y" && answer !== "n") throw new Refused("--answer needs y or n");
      choice.answer = answer;
      ptyOnly.push(flag);
    } else if (flag === "--dump") {
      choice.dump = true;
      ptyOnly.push(flag);
    } else throw new Refused(`unknown option ${flag} (a command whose first word starts with a dash goes after -- --); ${USAGE}`);
  }
  if (options.command.length === 0) throw new Refused(`no command after --; ${USAGE}`);
  if (!pty && ptyOnly.length > 0) throw new Refused(`${ptyOnly[0]} needs --pty`);
  options.pty = pty ? choice : null;
  return options;
}

/** The caller's environment without anything that names a core, a session folder or an Ovis server. */
function cleanedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== "HERDR_SOCKET" && !/^(HC_|XDG_|OVIS_|HERDR_WEB_)/.test(entry[0])));
}

/** HC_SOCKET, HC_SESSION and XDG_* from a `KEY=value` (or `export KEY='value'`) file, refused unless the socket is a trial's. */
function readCoreEnv(file: string): Record<string, string> {
  const named: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.trim().match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || !/^(HC_SOCKET|HC_SESSION|XDG_[A-Z_]+)$/.test(match[1]!)) continue;
    named[match[1]!] = match[2]!.replace(/^'(.*)'$|^"(.*)"$/, "$1$2");
  }
  const home = process.env["HOME"];
  const socket = named["HC_SOCKET"];
  if (!home || !socket) throw new Refused(`${file} names no HC_SOCKET`);
  if (!isAbsolute(socket)) throw new Refused(`refused: HC_SOCKET ${socket} is not an absolute path`);
  // through every link, the socket's own too: a link under ovis-tmp to someone's core is not a trial's socket
  const real = realSocket(socket);
  if (real === null || !real.startsWith(`${realOrNamed(join(home, ".cache", "ovis-tmp"))}/`)) throw new Refused(`refused: ${socket} is not under ${home}/.cache/ovis-tmp/`);
  if (!named["HC_SESSION"] || named["HC_SESSION"] === "default") throw new Refused(`refused: ${file} names HC_SESSION ${named["HC_SESSION"] ?? "(none)"}`);
  return named;
}

/** `path` through its links, or (not there) as written, `..` resolved */
function realOrNamed(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The socket through every link: its own real path when it is there; else its folder's and its name, or null for a link to nothing. */
function realSocket(socket: string): string | null {
  try { return realpathSync(socket); } catch { /* not there, or a link to nothing */ }
  try { if (lstatSync(socket).isSymbolicLink()) return null; } catch { /* nothing at all: judged by its folder */ }
  return join(realOrNamed(dirname(socket)), basename(socket));
}

async function main(): Promise<number> {
  let options: Options;
  let bin = "";
  let coreEnv: Record<string, string> = {};
  try {
    options = parse(process.argv.slice(2));
    if (options.mode === "core") {
      bin = process.env["OVIS_TEST_HC_BIN"] ?? "";
      if (!bin) throw new Refused("OVIS_TEST_HC_BIN is not set: name the hc to start, e.g. OVIS_TEST_HC_BIN=$HOME/.local/bin/hc");
    }
    if (options.mode === "core-env") coreEnv = readCoreEnv(options.coreEnv!);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    console.error(`with-core: ${error.message}`);
    return EXIT_USAGE;
  }

  /** the exit code: the first signal or the time limit decides it, else the command's end */
  let forced: number | null = null;
  let interrupted = false;
  let finishing: Promise<number> | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let ptyRun: PtyRun | null = null;
  let core: IsolatedCore | null = null;
  let folder: { root: string; env: Record<string, string> } | null = null;

  // the group is signalled only while the child is not reaped (signalChildGroup): a reaped child's pid may be someone else's
  const stopCommand = async (signal: NodeJS.Signals) => {
    // the PTY host this helper started hangs the command's group up, and kills what is left
    if (ptyRun) return ptyRun.stop();
    if (!child || !signalChildGroup(child, signal)) return;
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(COMMAND_GRACE_MS).then(() => false)])) return;
    if (signalChildGroup(child, "SIGKILL")) await child.exited;
  };

  /** The one cleanup: the command, then the core, then the folder. Every exit path awaits this promise. */
  const finish = (why: string, code: number, signal: NodeJS.Signals = "SIGTERM", interrupting = false): Promise<number> => {
    if (interrupting && !interrupted) {
      interrupted = true;
      forced = code;
    }
    forced ??= code;
    finishing ??= (async () => {
      console.error(`with-core: stopping (${why})`);
      await stopCommand(signal);
      if (!folder) return forced!;
      let failed = false;
      if (core) {
        const report = await core.stop();
        failed = !stoppedCleanly(report);
        console.error(`with-core: stopped pids=${report.pids.join(",")} killed=${report.killed.join(",")} unproven=${report.unproven.join(",")} alive=${report.alive.join(",")} socket=${report.socketGone ? "gone" : "left"} root=${report.rootGone ? "gone" : "left"}`);
        return failed ? EXIT_FAILED : forced!;
      }
      // no core of ours: a socket in our folder means the command started one there
      const socket = folder.env["HC_SOCKET"]!;
      if (existsSync(socket)) {
        failed = true;
        const named = process.env["OVIS_TEST_HC_BIN"];
        console.error(`with-core: the command left a core at ${socket}${named ? "" : " and no hc is named to stop it"}`);
        if (named) {
          const stray = new IsolatedCore(named, folder);
          await stray.adopt();
          await stray.stop();
        }
      } else rmSync(folder.root, { recursive: true, force: true });
      console.error(`with-core: stopped pids= killed= unproven= alive= socket=${existsSync(socket) ? "left" : "gone"} root=${existsSync(folder.root) ? "left" : "gone"}`);
      return failed ? EXIT_FAILED : forced!;
    })();
    return finishing;
  };

  // before anything exists to clean up, so no signal can end the helper around its cleanup
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(name, () => { void finish(name, 128 + constants.signals[name], name, true).then((code) => process.exit(code)); });
  }
  const limit = setTimeout(() => { void finish("time limit", EXIT_LIMIT, "SIGTERM", true).then((code) => process.exit(code)); }, options.limitSeconds * 1000);

  try {
    folder = coreFolder();
  } catch (error) {
    console.error(`with-core: ${error instanceof Error ? error.message : String(error)}`);
    clearTimeout(limit);
    return EXIT_USAGE;
  }
  console.error(`with-core: root=${folder.root}`);

  const env: Record<string, string> = {
    ...cleanedEnv(), ...folder.env, HERDR_TEST_SESSION: `with-core-${process.pid}`, PORT: "1",
    HERDR_PLUGIN_CONFIG_DIR: join(folder.root, "plugin-config"), HERDR_PLUGIN_STATE_DIR: join(folder.root, "plugin-state"),
  };
  if (options.mode === "core" && !finishing) {
    core = new IsolatedCore(bin, folder);
    try {
      await core.start();
      console.error(`with-core: started pids=${core.pids.join(",")}`);
    } catch (error) {
      if (!finishing) {
        console.error(`with-core: ${error instanceof Error ? error.message : String(error)}`);
        forced ??= EXIT_FAILED;
      }
    }
  } else if (options.mode === "core-env") {
    for (const name of Object.keys(env)) if (/^(HC_|XDG_)/.test(name)) delete env[name];
    Object.assign(env, coreEnv);
  }

  if (!finishing && forced === null && options.pty) {
    try {
      ptyRun = startPty(options.pty, options.command, env, options.limitSeconds);
    } catch (error) {
      console.error(`with-core: cannot run ${options.command[0]} on a pseudo-terminal: ${error instanceof Error ? error.message : String(error)}`);
      forced ??= 127;
    }
    if (ptyRun) {
      try {
        const code = await ptyRun.exited;
        if (options.pty.dump) process.stdout.write(await gridText(screenOutput(ptyRun.output()), options.pty.cols, options.pty.rows));
        forced ??= code ?? EXIT_FAILED;
      } catch (error) {
        console.error(`with-core: cannot finish pseudo-terminal output: ${error instanceof Error ? error.message : String(error)}`);
        forced ??= EXIT_FAILED;
      }
    }
  } else if (!finishing && forced === null) {
    try {
      child = Bun.spawn(options.command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true });
    } catch (error) {
      console.error(`with-core: cannot run ${options.command[0]}: ${error instanceof Error ? error.message : String(error)}`);
      forced ??= 127;
    }
    if (child) {
      await child.exited;
      const signal = child.signalCode as NodeJS.Signals | null;
      forced ??= signal ? 128 + (constants.signals[signal] ?? 0) : child.exitCode ?? 1;
    }
  }
  clearTimeout(limit);
  return finish("the command ended", forced ?? EXIT_FAILED);
}

process.exit(await main());
