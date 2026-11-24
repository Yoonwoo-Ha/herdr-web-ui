import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processesWith } from "./processes.ts";
import { parseStty, runOnPty, runSupervised, stopAllPtyRuns } from "./pty.ts";

const TEST_MS = 30_000;
const ENV = { PATH: "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/", TMPDIR: process.env["TMPDIR"] ?? "", TERM: "xterm-256color" };

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "pty-leaks-"));
afterAll(async () => {
  await stopAllPtyRuns();
  rmSync(scratch, { recursive: true, force: true });
}, TEST_MS);

/** The host carries the mark in its environment; the command also starts in its own directory. */
const markedEnv = () => ({ ...ENV, HOME: mkdtempSync(join(scratch, "home-")), PTY_TEST_MARK: crypto.randomUUID() });

describe("parseStty", () => {
  it("reads canonical mode, echo and signals from `stty -a`", () => {
    expect(parseStty("speed 38400 baud; rows 24; columns 80;\n-ignbrk brkint\nisig icanon iexten echo echoe").canonical).toBe(true);
    const raw = parseStty("isig -icanon iexten -echo echoe");
    expect([raw.canonical, raw.echo, raw.signals]).toEqual([false, false, true]);
  });
});

describe("runOnPty", () => {
  it("runs the command on a terminal of the asked size and reports its exit", async () => {
    const run = runOnPty({ command: ["sh", "-c", "test -t 0 && test -t 1 && stty size && exit 7"], env: ENV, cols: 33, rows: 7 });
    await run.until("7 33");
    expect(await run.exited).toBe(7);
  }, TEST_MS);

  it("ends a command at the deadline through the PTY host, rejects the wait and leaves nothing", async () => {
    const env = markedEnv();
    const run = runOnPty({ command: ["sh", "-c", "printf started; exec sleep 30"], env, deadlineMs: 1500 });
    await run.until("started");
    await expect(run.until("never printed")).rejects.toThrow("deadline of 1500 ms");
    expect(await run.exited).toBeNull();
    expect(processesWith(`PTY_TEST_MARK=${env.PTY_TEST_MARK}`, env.HOME)).toEqual([]);
  }, TEST_MS);

  it("stop hangs the command up and leaves nothing", async () => {
    const env = markedEnv();
    const run = runOnPty({ command: ["sh", "-c", 'printf "started %d\\n" "$$"; exec /bin/sleep 30'], env });
    const started = /started (\d+)\r?\n/;
    await run.until(started);
    const pid = Number(started.exec(run.output())![1]);
    const marker = `PTY_TEST_MARK=${env.PTY_TEST_MARK}`;
    expect(processesWith(marker, env.HOME)).toContain(pid);
    await run.stop();
    expect(processesWith(marker, env.HOME)).toEqual([]);
  }, TEST_MS);

  it("ends a run whose output passes its limit and rejects the wait instead of truncating", async () => {
    const run = runOnPty({ command: ["yes"], env: ENV, maxOutputChars: 20_000 });
    await expect(run.until("never printed")).rejects.toThrow("the output passed 20000 characters");
    await run.exited;
  }, TEST_MS);

  it("never matches a marker once the output passed its limit, even one inside the crossing chunk", async () => {
    const run = runOnPty({ command: ["sh", "-c", `printf 'MARKER%0200d' 0`], env: ENV, maxOutputChars: 100 });
    await run.exited;
    expect(run.output()).toContain("MARKER");
    await expect(run.until("MARKER")).rejects.toThrow("the output passed 100 characters");
  }, TEST_MS);

  it("a wait for output that never comes rejects when the command ends", async () => {
    const run = runOnPty({ command: ["sh", "-c", "printf done"], env: ENV });
    await expect(run.until("other")).rejects.toThrow("the command ended");
    expect(await run.exited).toBe(0);
  }, TEST_MS);
});

describe("runSupervised", () => {
  it("signals the entry through the supervisor and reports its end with the termios around it", async () => {
    const env = markedEnv();
    const script = 'process.on("SIGTERM", () => { process.stdout.write("TERM\\n"); process.exit(5); }); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);';
    const run = runSupervised({ entry: [process.execPath, "-e", script], env });
    await run.until("ready");
    run.signal("SIGTERM");
    const end = await run.ended;
    expect({ code: end.code, signal: end.signal, before: end.before.canonical, after: end.after?.canonical }).toEqual({ code: 5, signal: null, before: true, after: true });
    expect(run.output()).toContain("TERM");
    await run.exited;
    expect(processesWith(`PTY_TEST_MARK=${env.PTY_TEST_MARK}`, env.HOME)).toEqual([]);
  }, TEST_MS);

  it("keeps a bounded tail of an entry that floods stderr and never writes stdout", async () => {
    const run = runSupervised({ entry: ["sh", "-c", 'head -c 3000000 /dev/zero | tr "\\0" x >&2; printf "tail-mark" >&2'], env: ENV });
    const end = await run.ended;
    expect(end.code).toBe(0);
    expect(end.stderr.length).toBeLessThanOrEqual(16 * 1024);
    expect(end.stderr.endsWith("tail-mark")).toBe(true);
    await run.exited;
  }, TEST_MS);

  it("reports the end of an entry whose stderr a descendant keeps open, without signalling the descendant", async () => {
    const env = markedEnv();
    const run = runSupervised({ entry: ["sh", "-c", "printf err >&2; sleep 6 >&2 & exit 0"], env });
    const end = await run.ended;
    expect(end.code).toBe(0);
    expect(end.stderr).toContain("err");
    expect(end.stderr).toContain("stderr stayed open");
    await run.exited;
    expect(processesWith(`PTY_TEST_MARK=${env.PTY_TEST_MARK}`, env.HOME)).toEqual([]);
  }, TEST_MS);

  // the supervisor tells a stopped entry by /proc: without it, a continue is sent at once, as before
  it.skipIf(!existsSync("/proc/self/stat"))("holds a continue that came before the entry stopped itself until it has stopped, as a shell does", async () => {
    // like the screen, the entry gives the terminal back at SIGTSTP and stops itself after: here only once a line is typed
    const script = [
      'process.on("SIGTSTP", () => {',
      '  process.stdout.write("given back\\n");',
      '  process.stdin.once("data", () => { process.kill(process.pid, "SIGSTOP"); process.stdout.write("continued\\n"); process.exit(0); });',
      "});",
      'process.stdout.write("ready\\n");',
      "process.stdin.resume();",
    ].join("\n");
    const run = runSupervised({ entry: [process.execPath, "-e", script], env: ENV });
    await run.until("ready");
    run.signal("SIGTSTP");
    await run.until("given back");
    run.signal("SIGCONT");
    // the supervisor answers in order: once the termios is read, the continue was dealt with, before the entry stopped
    await run.stty();
    run.type("go\r");
    await run.until("continued");
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("reads the termios while the entry runs, and names a signal that ended it", async () => {
    const run = runSupervised({ entry: ["sh", "-c", "stty -icanon -echo; printf ready; exec sleep 30"], env: ENV });
    await run.until("ready");
    const during = await run.stty();
    expect([during.canonical, during.echo]).toEqual([false, false]);
    run.signal("SIGINT");
    const end = await run.ended;
    expect([end.code, end.signal]).toEqual([130, "SIGINT"]);
  }, TEST_MS);
});
