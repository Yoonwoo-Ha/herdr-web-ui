import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStart } from "./check.ts";
import { failureSite, longestFirst, scriptTimeoutSeconds, serialBrowserScripts, shardScripts } from "./ci-browser-parallel.ts";

/** A killed process that its parent (a subreaper, say) has not reaped yet is a zombie: not alive. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return true; }
};

/** The command every stand-in the stub starts runs. */
const STAND_IN = ["sleep", "1000"];

const commandLine = (pid: number): string[] | null => {
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1); } catch { return null; }
  }
  const ps = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 ? ps.stdout.trim().split(/\s+/) : null;
};

/**
 * The stand-in a record names, while that very process still runs, else null. The stub writes the
 * record, "<pid> <start>", as soon as it has started the stand-in: its own child, which it has not
 * reaped, so that pid cannot belong to anything else yet. A pid alone proves nothing later: once the
 * stand-in has ended, its number may be given to any other process of this user. So the process
 * must still have started when the record says (processStart: the boot and clock tick on Linux),
 * not be a zombie, and run the stand-in's command.
 */
function standIn(record: string): number | null {
  const match = /^(\d+) (.+)\n$/.exec(record);
  if (!match) throw new Error(`not a stand-in record: ${JSON.stringify(record)}`);
  const pid = Number(match[1]);
  // the start last: it is what tells this process from a later one, so it is read nearest the signal
  return alive(pid) && commandLine(pid)?.join(" ") === STAND_IN.join(" ") && processStart(pid) === match[2] ? pid : null;
}

/** Ends the stand-in a record names, only when standIn proves it is still that process. */
function stopStandIn(record: string): void {
  const pid = standIn(record);
  if (pid !== null) process.kill(pid, "SIGKILL");
}

/**
 * The stub's shell function that prints what processStart says of pid $1 (here a child of the
 * stub's own): on Linux the boot id and the start in clock ticks, /proc/<pid>/stat's field 22,
 * read after the command name in parentheses; on macOS ps's start, in its clock and words.
 */
const STARTED = [
  "started() {",
  "  if [ -r /proc/$1/stat ]; then printf '%s:%s\\n' \"$(cat /proc/sys/kernel/random/boot_id)\" \"$(sed 's/.*) //' /proc/$1/stat | cut -d' ' -f20)\"",
  "  else LC_ALL=C TZ=UTC ps -o lstart= -p $1 | sed 's/^ *//;s/ *$//'; fi",
  "}",
].join("\n");

/**
 * Runs the lane on one stub script whose last step is `end`, after it has started a process that
 * keeps the script's output open (as a stray server would) and one that ignores SIGTERM and writes
 * nowhere, and returns what the lane printed and wrote.
 */
async function runStub(end: string, timeoutSeconds: string) {
  const dir = mkdtempSync(join(tmpdir(), "browser-parallel-test-"));
  const bin = join(dir, "bin");
  const logs = join(dir, "browser-logs");
  const leftover = join(dir, "leftover.pid");
  const stubborn = join(dir, "stubborn.pid");
  mkdirSync(bin);
  writeFileSync(join(bin, "bash"), '#!/bin/sh\nprintf "/stub/chrome\\\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nif [ "$1" = scripts/demo-build.ts ]; then exit 0; fi\n${STARTED}\n(exec ${STAND_IN.join(" ")}) &\necho "$! $(started $!)" > ${leftover}\n(trap '' TERM; exec ${STAND_IN.join(" ")}) >/dev/null 2>&1 &\necho "$! $(started $!)" > ${stubborn}\necho "PASS a step before the end"\necho "the last line it wrote"\n${end}\n`, { mode: 0o755 });
  try {
    const child = Bun.spawn([process.execPath, "scripts/ci-browser-parallel.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BROWSER_SCRIPTS: "scripts/ui-regression.ts",
        BROWSER_SCRIPT_TIMEOUT_SECONDS: timeoutSeconds,
        CHECK_DIR: dir,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [text, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      text, code, signal: child.signalCode,
      retried: existsSync(join(logs, "ui-regression.attempt-1.log")),
      summary: JSON.parse(readFileSync(join(logs, "summary.json"), "utf8")),
      // both stand-ins were recorded, and neither still runs
      leftAlive: [leftover, stubborn].map((file) => standIn(readFileSync(file, "utf8"))).filter((pid) => pid !== null),
    };
  } finally {
    try {
      for (const file of [leftover, stubborn]) {
        // a record that cannot be read proves nothing: it is left alone, and the error the run raised for it stands
        try { if (existsSync(file)) stopStandIn(readFileSync(file, "utf8")); } catch { /* unproven: left alone */ }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe("parallel browser script deadline", () => {
  it("stops a hung script and what it started at the bound, names it with its last lines, and does not run it again", async () => {
    const run = await runStub("exec sleep 1000", "1");
    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.text).toContain("[worker-0] TIMEOUT scripts/ui-regression.ts: Timed out after 1s; what it started was stopped.");
    expect(run.text).toMatch(/^\[[^\]]+\] the last line it wrote$/m);
    expect(run.text.match(/START scripts\/ui-regression\.ts/g)).toHaveLength(1);
    expect(run.retried).toBe(false);
    expect(run.summary.scripts).toEqual([expect.objectContaining({ script: "scripts/ui-regression.ts", code: 124, message: "Timed out after 1s" })]);
    expect(run.leftAlive).toEqual([]);
  }, 20_000);

  // A process whose parent has exited is found through /proc: Linux only, as CI's runners are.
  it.skipIf(process.platform !== "linux")("fails a script that exits but leaves a process holding its output, without waiting for the bound", async () => {
    // the bound is past the stub run's own 15 s limit: only the exit can end this run in time
    const run = await runStub("exit 0", "60");
    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.text).toContain("[worker-0] STOPPED scripts/ui-regression.ts: Exited 0, but a process it started still held its output; what it started was stopped.");
    expect(run.text).toMatch(/^\[[^\]]+\] the last line it wrote$/m);
    expect(run.retried).toBe(false);
    expect(run.summary.scripts).toEqual([expect.objectContaining({ code: 1, message: "Exited 0, but a process it started still held its output" })]);
    expect(run.leftAlive).toEqual([]);
  }, 20_000);

  // A stand-in the stub records that standIn could never prove would read as gone, and leftAlive would pass unchecked.
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("records a start exactly as processStart names it", () => {
    const own = processStart(process.pid);
    expect(own).not.toBeNull();
    expect(spawnSync("sh", ["-c", `${STARTED}\nstarted ${process.pid}`], { encoding: "utf8" }).stdout).toBe(`${own}\n`);
  });

  // Every process here is one this test started for the purpose, its handle kept: nothing else is signalled.
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("ends a recorded stand-in only, never another process its pid names", async () => {
    const start = (command: string[]) => Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const recorded = start(STAND_IN);
    // the same command, but the record is of an earlier process that had its pid
    const later = start(STAND_IN);
    // started when the record says, but another command
    const other = start(["sleep", "999"]);
    const startOf = (pid: number) => processStart(pid) ?? "";
    const records = [
      `${recorded.pid} ${startOf(recorded.pid)}\n`,
      `${later.pid} ${startOf(later.pid).replace(/\d+$/, (n) => String(Number(n) - 1))}\n`,
      `${other.pid} ${startOf(other.pid)}\n`,
    ];
    try {
      expect(standIn(records[0]!)).toBe(recorded.pid);
      for (const record of records) stopStandIn(record);
      // a SIGKILL sent above would end them before the SIGTERM sent here
      later.kill("SIGTERM");
      other.kill("SIGTERM");
      await Promise.all([recorded.exited, later.exited, other.exited]);
      expect([recorded.signalCode, later.signalCode, other.signalCode]).toEqual(["SIGKILL", "SIGTERM", "SIGTERM"]);
    } finally {
      for (const child of [recorded, later, other]) child.kill("SIGKILL");
    }
  });

  it("reads its bound as positive seconds and refuses anything else", () => {
    expect(scriptTimeoutSeconds(undefined)).toBe(600);
    expect(scriptTimeoutSeconds("")).toBe(600);
    expect(scriptTimeoutSeconds("1.5")).toBe(1.5);
    expect(scriptTimeoutSeconds("2147483")).toBe(2147483);
    for (const bad of ["0", "-3", "soon", "Infinity", "2147484"]) expect(() => scriptTimeoutSeconds(bad)).toThrow("BROWSER_SCRIPT_TIMEOUT_SECONDS");
  });
});

describe("parallel browser script order", () => {
  it("starts the longest scripts first and keeps the listed order on a tie", () => {
    const timings = { "a.ts": 10, "b.ts": 300, "c.ts": 50, "d.ts": 50, "e.ts": 0 };
    expect(longestFirst(["e.ts", "a.ts", "d.ts", "b.ts", "c.ts"], timings)).toEqual(["b.ts", "d.ts", "c.ts", "a.ts", "e.ts"]);
    expect(longestFirst(["a.ts", "b.ts"], {})).toEqual(["a.ts", "b.ts"]);
  });

  // Nobody has measured it: counted as a typical script, relay-e2e (300 s) started 124th of 184
  // and ran on alone for four minutes after every other script had ended.
  it("starts a script the table does not hold before the longest one it does", () => {
    const timings = { "a.ts": 10, "b.ts": 300, "c.ts": 50 };
    expect(longestFirst(["a.ts", "new.ts", "c.ts", "b.ts"], timings)).toEqual(["new.ts", "b.ts", "c.ts", "a.ts"]);
    // several of them keep the listed order among themselves, wherever the list holds them
    expect(longestFirst(["a.ts", "new-1.ts", "b.ts", "new-2.ts", "c.ts", "new-3.ts"], timings))
      .toEqual(["new-1.ts", "new-2.ts", "new-3.ts", "b.ts", "c.ts", "a.ts"]);
    // seconds that are not a number time nothing
    expect(longestFirst(["a.ts", "odd.ts", "b.ts"], { ...timings, "odd.ts": Number.NaN })).toEqual(["odd.ts", "b.ts", "a.ts"]);
  });

  it("times only scripts the serial lane runs", () => {
    const timings = JSON.parse(readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8")) as Record<string, number>;
    const listed = serialBrowserScripts();
    expect(Object.keys(timings).filter((script) => !listed.includes(script))).toEqual([]);
    expect(Object.values(timings).every((seconds) => Number.isFinite(seconds) && seconds >= 0)).toBe(true);
  });
});

describe("parallel browser shards", () => {
  it("splits the scripts by estimated time into disjoint shards that together hold every script once", () => {
    const scripts = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const timings = { "a.ts": 200, "b.ts": 100, "c.ts": 100, "d.ts": 90, "e.ts": 10 };
    // longest first to the least-loaded shard: a -> 1; b -> 2; c -> 2 (100 < 200); d -> 1 (a tie goes to
    // the first); e -> 2 (200 < 290)
    expect(shardScripts(scripts, timings, "1/2")).toEqual(["a.ts", "d.ts"]);
    expect(shardScripts(scripts, timings, "2/2")).toEqual(["b.ts", "c.ts", "e.ts"]);
    const listed = serialBrowserScripts();
    const table = JSON.parse(readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8")) as Record<string, number>;
    const shards = [1, 2, 3, 4].map((k) => shardScripts(listed, table, `${k}/4`));
    expect(shards.flat().sort()).toEqual([...listed].sort());
  });

  it("counts a script the table does not hold as the median in a shard's load, and deals it out in that place", () => {
    // median 100. Longest first: a -> 1; new (100, listed before b) -> 2; b -> 2 (100 < 300); c -> 2.
    // Dealt out first, as the workers start it, new would take shard 1 and a shard 2.
    const timings = { "a.ts": 300, "b.ts": 100, "c.ts": 20 };
    expect(shardScripts(["new.ts", "a.ts", "b.ts", "c.ts"], timings, "1/2")).toEqual(["a.ts"]);
    expect(shardScripts(["new.ts", "a.ts", "b.ts", "c.ts"], timings, "2/2")).toEqual(["new.ts", "b.ts", "c.ts"]);
    // every script 100: new-1 -> 1; new-2 -> 2; a -> 1. Counted as nothing, a would go first and both of them to shard 2.
    const even = { "a.ts": 100, "b.ts": 100, "c.ts": 100 };
    expect(shardScripts(["new-1.ts", "new-2.ts", "a.ts"], even, "1/2")).toEqual(["new-1.ts", "a.ts"]);
    expect(shardScripts(["new-1.ts", "new-2.ts", "a.ts"], even, "2/2")).toEqual(["new-2.ts"]);
  });

  it("still deals every script to one shard, in the listed order, when the table holds only some of them", () => {
    const listed = serialBrowserScripts();
    const table = JSON.parse(readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8")) as Record<string, number>;
    const half = Object.fromEntries(Object.entries(table).filter((_, index) => index % 2 === 0));
    for (const total of [1, 2, 3, 4, 7]) {
      const shards = Array.from({ length: total }, (_, k) => shardScripts(listed, half, `${k + 1}/${total}`));
      expect(shards.flat().sort()).toEqual([...listed].sort());
      for (const shard of shards) expect(shard).toEqual(listed.filter((script) => shard.includes(script)));
      // the same split every time it is computed, as each job computes it for itself
      expect(shards).toEqual(Array.from({ length: total }, (_, k) => shardScripts(listed, half, `${k + 1}/${total}`)));
    }
  });

  it("deals the scripts out in turn without timings, and keeps every script without a shard", () => {
    expect(shardScripts(["a.ts", "b.ts", "c.ts"], {}, "2/2")).toEqual(["b.ts"]);
    expect(shardScripts(["a.ts", "b.ts"], {}, "1/1")).toEqual(["a.ts", "b.ts"]);
    expect(shardScripts(["a.ts", "b.ts"], {}, undefined)).toEqual(["a.ts", "b.ts"]);
    expect(shardScripts(["a.ts", "b.ts"], {}, " ")).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses a shard that is not k/n with 1 <= k <= n", () => {
    for (const shard of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) expect(() => shardScripts(["a.ts"], {}, shard)).toThrow("BROWSER_SHARD");
  });
});

describe("parallel browser output timestamps", () => {
  it("timestamps script log lines without changing status output or summary JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-parallel-test-"));
    const bin = join(dir, "bin");
    const logs = join(dir, "browser-logs");
    mkdirSync(bin);
    writeFileSync(join(bin, "bash"), '#!/bin/sh\nprintf "/stub/chrome\\\\n"\n', { mode: 0o755 });
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nif [ "$1" = scripts/demo-build.ts ]; then exit 0; fi\nprintf "PASS stubbed browser step\\\\nFAIL stubbed failure marker\\\\nSERVER listening on 127.0.0.1:4321"\n', { mode: 0o755 });
    try {
      const child = Bun.spawn([process.execPath, "scripts/ci-browser-parallel.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BROWSER_SCRIPTS: "scripts/ui-regression.ts",
          BROWSER_RETRY: "0",
          CHECK_DIR: dir,
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      const [text, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toBe("");
      expect(code).toBe(0);
      expect(text).toContain("[worker-0] PASS scripts/ui-regression.ts");
      const log = readFileSync(join(logs, "ui-regression.log"), "utf8");
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] PASS stubbed browser step$/m);
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] FAIL stubbed failure marker$/m);
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] SERVER listening on 127\.0\.0\.1:4321$/m);
      expect(failureSite(`${log}[2026-10-23T00:00:00.000Z] AssertionError: stub failure\n[2026-10-23T00:00:00.000Z]     at run (/repo/scripts/ui-regression.ts:1:1)`)).toEqual({
        site: "scripts/ui-regression.ts:1",
        message: "AssertionError: stub failure",
      });
      expect(text).toContain("Total: 1/1 passed");
      const summary = readFileSync(join(logs, "summary.json"), "utf8");
      expect(summary).toContain('"workers": 1');
      expect(summary).toContain('"passed": 1');
      expect(summary).toContain('"total": 1');
      expect(summary).toContain('"flaky": []');
      expect(summary).toContain('"script": "scripts/ui-regression.ts"');
      expect(summary).toContain('"code": 0');
      expect(summary).not.toContain("timestamp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
