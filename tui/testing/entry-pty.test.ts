import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainTail } from "./drain.ts";
import { closeOwnedServer, closedBoxes, ENTRY_MAX_OUTPUT_CHARS, entryPty, runBounded, shutdownOwned, terminate } from "./entry-pty.ts";
import { processesWith } from "./processes.ts";

const ENV = { PATH: "/usr/bin:/bin" };
const TEST_MS = 20_000;
const bounds = { cwd: "/", env: ENV, deadlineMs: 400, maxBytes: 4096, graceMs: 400 };
// a SIGTERM stays ignored across exec, so only SIGKILL ends it
const STUBBORN = ["sh", "-c", 'trap "" TERM; exec sleep 30'];
const spawn = (command: string[]) => Bun.spawn(command, { env: ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" });

describe("runBounded", () => {
  it("returns the code and both streams of a command that ends in time", async () => {
    expect(await runBounded(["sh", "-c", "printf out; printf err >&2; exit 3"], bounds)).toEqual({ code: 3, out: "out", err: "err" });
  }, TEST_MS);

  it("stops a command that hangs, with SIGTERM when that is enough", async () => {
    await expect(runBounded(["sh", "-c", "exec sleep 30"], bounds)).rejects.toThrow(/did not finish within 400 ms \(stopped with SIGTERM\)/);
  }, TEST_MS);

  it("kills a command that ignores SIGTERM and says so", async () => {
    await expect(runBounded(STUBBORN, bounds)).rejects.toThrow(/\(stopped with SIGKILL\)/);
  }, TEST_MS);

  it("rejects a response past the byte limit and stops the flooding command", async () => {
    await expect(runBounded(["yes"], { ...bounds, deadlineMs: 10_000 })).rejects.toThrow(/passed 4096 bytes/);
    await expect(runBounded(["sh", "-c", "yes >&2"], { ...bounds, deadlineMs: 10_000 })).rejects.toThrow(/passed 4096 bytes/);
  }, TEST_MS);
});

describe("runBounded with a signal", () => {
  it("starts nothing once the signal is aborted", async () => {
    const marker = join(scratch, `started-${crypto.randomUUID()}`);
    const stop = new AbortController();
    stop.abort();
    await expect(runBounded(["sh", "-c", `: > ${marker}`], { ...bounds, signal: stop.signal })).rejects.toThrow(/not started, cancelled/);
    expect(existsSync(marker)).toBe(false);
  }, TEST_MS);

  it("ends a running command through its own handle when the signal aborts, leaving no process", async () => {
    const mark = `NOMARK-${crypto.randomUUID()}`;
    const cwd = mkdtempSync(join(scratch, "cwd-"));
    const stop = new AbortController();
    const running = runBounded(["sh", "-c", "exec sleep 30"], { ...bounds, cwd, deadlineMs: 10_000, signal: stop.signal });
    stop.abort();
    await expect(running).rejects.toThrow(/cancelled \(stopped with SIGTERM\)/);
    expect(processesWith(mark, cwd)).toEqual([]);
  }, TEST_MS);
});

describe("entryPty", () => {
  it("bounds the transcript by default, ending a flood and rejecting the wait", async () => {
    const run = entryPty(["yes"], { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch }, 80, 24);
    await expect(run.until("never printed")).rejects.toThrow(`the output passed ${ENTRY_MAX_OUTPUT_CHARS} characters`);
    await run.exited;
  }, TEST_MS);
});

describe("shutdownOwned", () => {
  it("does not force a child that stops after the request", async () => {
    const child = spawn(["sleep", "30"]);
    expect(await shutdownOwned(child, async () => { child.kill("SIGTERM"); }, 2000)).toEqual({ forced: null, unconfirmed: false, askError: undefined });
  }, TEST_MS);

  it("ends a child through its handle when the request does nothing, and reports the signal", async () => {
    const child = spawn(["sleep", "30"]);
    expect(await shutdownOwned(child, async () => {}, 300)).toEqual({ forced: "SIGTERM", unconfirmed: false, askError: undefined });
    expect(child.signalCode).toBe("SIGTERM");
  }, TEST_MS);

  it("kills a child that ignores SIGTERM and keeps the request's error", async () => {
    const child = spawn(STUBBORN);
    const failure = new Error("stop hung");
    const ended = await shutdownOwned(child, () => Promise.reject(failure), 300);
    expect(ended).toEqual({ forced: "SIGKILL", unconfirmed: false, askError: failure });
    expect(child.signalCode).toBe("SIGKILL");
  }, TEST_MS);
});

describe("an exit that never shows", () => {
  const unreapable = () => {
    const signals: string[] = [];
    let unrefs = 0;
    return { signals, unrefs: () => unrefs, child: { exitCode: null, signalCode: null, exited: new Promise<number>(() => {}), kill: (signal?: string | number) => { signals.push(String(signal)); }, unref: () => { unrefs++; } } };
  };

  it("terminate gives up on the reap after SIGKILL and reports it unconfirmed", async () => {
    const { child, signals, unrefs } = unreapable();
    expect(await terminate(child, 100)).toBe("unconfirmed");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(unrefs()).toBe(1);
  }, TEST_MS);

  it("shutdownOwned reports the forced signal and the unconfirmed exit", async () => {
    const { child } = unreapable();
    expect(await shutdownOwned(child, async () => {}, 100)).toEqual({ forced: "SIGKILL", unconfirmed: true, askError: undefined });
  }, TEST_MS);
});

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "entry-pty-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("a child that stays alive after SIGKILL", () => {
  it("lets the parent process exit once terminate gave up on it", async () => {
    // the stand-in outlives every signal it is sent here; it ends when its stdin closes, i.e. with this helper
    const script = `
      import { terminate } from ${JSON.stringify(join(import.meta.dir, "entry-pty.ts"))};
      const real = Bun.spawn(["sh", "-c", "read line"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      const stuck = { exitCode: null, signalCode: null, exited: real.exited, kill: () => {}, unref: () => real.unref() };
      console.log(await terminate(stuck, 100));
    `;
    const helper = Bun.spawn([process.execPath, "-e", script], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => helper.kill("SIGKILL"), 10_000);
    try {
      const [out, err, code] = await Promise.all([new Response(helper.stdout).text(), new Response(helper.stderr).text(), helper.exited]);
      expect({ out: out.trim(), code, err }).toEqual({ out: "unconfirmed", code: 0, err: "" });
    } finally {
      clearTimeout(deadline);
    }
  }, TEST_MS);
});

describe("closeOwnedServer", () => {
  const openStream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("boot")); } });
  const closedStream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const sockets = (...present: boolean[]) => present.map((here, at) => {
    const path = join(scratch, `sock-${crypto.randomUUID()}-${at}`);
    if (here) writeFileSync(path, "");
    return path;
  });
  const reports = () => {
    const lines: string[] = [];
    return { lines, report: { warn: (line: string) => lines.push(`warn ${line}`), info: (line: string) => lines.push(`info ${line}`) } };
  };
  const stuck = () => ({ exitCode: null, signalCode: null, exited: new Promise<number>(() => {}), kill: () => {}, unref: () => {} });
  const exits = () => Bun.spawn(["sleep", "30"], { env: ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" });

  it("succeeds, and says so, for a server that exits when asked, with its pipe closed and no sockets", async () => {
    const child = exits();
    const { lines, report } = reports();
    await closeOwnedServer({ child, ask: async () => { child.kill("SIGTERM"); }, graceMs: 2000, stderr: drainTail(closedStream(), 64), sockets: sockets(false, false), report });
    expect(lines).toEqual(["info herdr cleanup: owned server exited; both scratch sockets removed"]);
  }, TEST_MS);

  it("succeeds with a warning for a server that exits only after the deadline passed, with its pipe held open", async () => {
    const child = exits();
    const { lines, report } = reports();
    await closeOwnedServer({ child, ask: async () => {}, graceMs: 200, stderr: drainTail(openStream(), 64), sockets: sockets(false), report });
    expect(lines.some((line) => line.includes("ended with SIGTERM"))).toBe(true);
    expect(lines.some((line) => line.includes("reader was cancelled"))).toBe(true);
    expect(lines.some((line) => line.startsWith("info"))).toBe(true);
  }, TEST_MS);

  it("fails for an unconfirmed exit even when both sockets are absent, and prints no success", async () => {
    const { lines, report } = reports();
    await expect(closeOwnedServer({ child: stuck(), ask: async () => {}, graceMs: 100, stderr: drainTail(closedStream(), 64), sockets: sockets(false, false), report })).rejects.toThrow(/exit was not confirmed within 100 ms after SIGKILL/);
    expect(lines.some((line) => line.startsWith("info"))).toBe(false);
    expect(lines.some((line) => line.includes("SIGKILL sent; exit not confirmed"))).toBe(true);
    expect(lines.some((line) => line.includes("ended with SIGKILL"))).toBe(false);
  }, TEST_MS);

  it("fails for an unconfirmed exit with the pipe held open, after cancelling the drain", async () => {
    const { lines, report } = reports();
    await expect(closeOwnedServer({ child: stuck(), ask: async () => {}, graceMs: 100, stderr: drainTail(openStream(), 64), sockets: sockets(false), report })).rejects.toThrow(/not confirmed/);
    expect(lines.some((line) => line.includes("reader was cancelled"))).toBe(true);
  }, TEST_MS);

  it("fails for a confirmed exit that left a socket", async () => {
    const child = exits();
    const [gone, left] = sockets(false, true);
    const { lines, report } = reports();
    await expect(closeOwnedServer({ child, ask: async () => { child.kill("SIGTERM"); }, graceMs: 2000, stderr: drainTail(closedStream(), 64), sockets: [gone!, left!], report })).rejects.toThrow(`isolated herdr left ${left}`);
    expect(lines.some((line) => line.startsWith("info"))).toBe(false);
  }, TEST_MS);

  it("reports both problems at once for an unconfirmed exit with a socket left", async () => {
    const { report } = reports();
    await expect(closeOwnedServer({ child: stuck(), ask: async () => {}, graceMs: 100, stderr: drainTail(closedStream(), 64), sockets: sockets(true), report })).rejects.toThrow(/not confirmed.*; isolated herdr left/);
  }, TEST_MS);
});

describe("drainTail", () => {
  it("keeps only the last characters of a flood and reads it to the end", async () => {
    const child = Bun.spawn(["sh", "-c", 'head -c 300000 /dev/zero | tr "\\0" x; printf END'], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const tail = drainTail(child.stdout, 64);
    expect(await tail.finish(10_000)).toBe("complete");
    expect(tail.text()).toHaveLength(64);
    expect(tail.text().endsWith("xxEND")).toBe(true);
  }, TEST_MS);

  it("cancels a reader mid-read when the stream stays open, keeping what arrived", async () => {
    const open = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } });
    const tail = drainTail(open, 64);
    expect(await tail.finish(100)).toBe("cancelled");
    expect(tail.text()).toBe("partial");
  }, TEST_MS);

  it("completes when the stream ends before the limit, whether or not the child has exited", async () => {
    const child = Bun.spawn(["sh", "-c", "printf late >&2"], { env: ENV, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    await child.exited;
    const tail = drainTail(child.stderr, 64);
    expect(await tail.finish(5000)).toBe("complete");
    expect(tail.text()).toBe("late");
  }, TEST_MS);
});

describe("closedBoxes", () => {
  const frame = ["┌──┐", "│  │", "└──┘"].join("\n");

  it("finds a closed frame by its corners and sides, not by what it says", () => {
    expect(closedBoxes(`${frame}\n`)).toEqual(["0,0,2,3"]);
    expect(closedBoxes(["  ╭────╮", "  │ hi │", "  ╰────╯"].join("\n"))).toEqual(["0,2,2,7"]);
  });

  it("finds nothing in a frame cut short, and tells a new frame from the one before", () => {
    expect(closedBoxes(["┌──┐", "│  │", "└──"].join("\n"))).toEqual([]);
    expect(closedBoxes(["┌──┐", "│  │"].join("\n"))).toEqual([]);
    const before = new Set(closedBoxes(frame));
    expect(closedBoxes(`${frame}\n ┌───┐\n │   │\n └───┘`).filter((box) => !before.has(box))).toEqual(["3,1,5,5"]);
  });
});
