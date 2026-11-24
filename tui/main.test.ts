import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { FakeHcCore } from "../server/herdr-core/core.fake.ts";
import { crashRecord, recordCrash } from "./crash.ts";
import { CRASH_RECORDS_KEPT, QUIT_BOUND_MS } from "./model/deadlines.ts";
import { ending } from "./start.ts";
import { demo } from "./testing/fixtures/demo.ts";
import { Run } from "./testing/run.ts";

const TEST_MS = 120_000;
const ENTRY = join(import.meta.dir, "main.ts");
const root = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "main-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** stand-ins for hc, herdr-core and herdr first on PATH: each run of one is logged, and none must happen */
const standIns = join(root, "bin");
const standInLog = join(root, "stand-in.log");
mkdirSync(standIns);
for (const name of ["hc", "herdr-core", "herdr"]) {
  writeFileSync(join(standIns, name), `#!/bin/sh\necho "${name} $*" >> "${standInLog}"\nexit 1\n`);
  chmodSync(join(standIns, name), 0o755);
}

/** The entry as a process of its own, on pipes, with exactly this environment. */
async function entry(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, ENTRY, ...args], {
    env: { PATH: `${standIns}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: root, XDG_RUNTIME_DIR: join(root, "run"), XDG_CONFIG_HOME: join(root, "config"), ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

/** The files the entry loads before its first line runs: its static imports, followed through relative imports. */
function staticClosure(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file) || !file.endsWith(".ts")) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/^import\s(?!type\s)[^;]*?from\s+"(\.[^"]+)"|^import\s+"(\.[^"]+)"/gm)) walk(join(file, "..", match[1] ?? match[2]!));
  };
  walk(entry);
  return [...seen].map((file) => file.slice(join(import.meta.dir, "..").length + 1));
}

describe("the entry", () => {
  it("answers -h, -V and a wrong call before it loads tui/view, tui/emulator or tui/core", () => {
    const loaded = staticClosure(ENTRY);
    expect(loaded).toContain("tui/start.ts");
    expect(loaded.filter((file) => /^tui\/(view|emulator|core)\//.test(file))).toEqual([]);
  });

  it("answers -V with the version, -h with its usage, and a wrong call with exit 2", async () => {
    expect(await entry(["-V"])).toMatchObject({ code: 0, out: `${version}\n` });
    const help = await entry(["-h"]);
    expect(help.code).toBe(0);
    expect(help.out.startsWith("usage: ovis tui")).toBe(true);
    for (const args of [["--bogus"], ["--session"], ["--session", ""], ["--session", "a/b"], ["--session", "a", "--session", "b"]]) {
      const wrong = await entry(args);
      expect(wrong.code).toBe(2);
      expect(wrong.err.startsWith("ovis tui: usage: ")).toBe(true);
    }
  }, TEST_MS);

  it("with no core listening says so in one line with a stable code, and starts nothing", async () => {
    rmSync(standInLog, { force: true });
    const missing = await entry([], { HC_SOCKET: join(root, "none.sock") });
    expect(missing.code).toBe(1);
    expect(missing.err.trim().split("\n")).toHaveLength(1);
    expect(missing.err.startsWith("ovis tui: no_core: ")).toBe(true);
    const session = await entry(["--session", "elsewhere"], { HC_SOCKET: join(root, "none.sock") });
    expect(session.err).toContain(join(root, "run", "herdr-core", "elsewhere.sock"));
    expect(existsSync(standInLog)).toBe(false);
  }, TEST_MS);

  it("refuses inside its own core's pane, runs inside another core's", async () => {
    const own = new FakeHcCore();
    const other = new FakeHcCore();
    const ownSocket = join(root, "own.sock");
    const otherSocket = join(root, "other.sock");
    const listeners = [await own.listen(ownSocket), await other.listen(otherSocket)];
    try {
      const inside = await entry([], { HC_TERMINAL_ID: "t1", HC_SOCKET: ownSocket });
      expect(inside.code).toBe(1);
      expect(inside.err.trim().split("\n")).toHaveLength(1);
      expect(inside.err.startsWith("ovis tui: inside_own_core: ")).toBe(true);
      const named = await entry([], { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: ownSocket, HC_SOCKET: ownSocket });
      expect(named.err.startsWith("ovis tui: inside_own_core: ")).toBe(true);
      expect(own.calls()).toEqual([]);
      // a pane of another core: the screen joins the core it was asked for (it is no terminal here, so it ends after the hello)
      const elsewhere = await entry([], { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: ownSocket, HC_SOCKET: otherSocket });
      expect(elsewhere.err.startsWith("ovis tui: not_a_terminal: ")).toBe(true);
      expect(other.calls().map(({ method }) => method)).toContain("hello");
      expect(own.calls()).toEqual([]);
    } finally {
      for (const listener of listeners) await listener.close();
    }
  }, TEST_MS);

  it("a quit whose terminal restore failed prints its quit line, then one line with the write's code, and exits 0", async () => {
    const run = await Run.start({ fixture: demo });
    try {
      await run.live();
      run.host.failWrites("EBADF");
      // the prefix and the detach key in one read: the quit starts before any frame could be written
      run.type("\x02q");
      await run.advance(QUIT_BOUND_MS);
      const end = await run.loop.done;
      // a quit, not a crash: the entry writes a crash record only for `crashed`
      expect(end.kind).toBe("quit");
      if (end.kind !== "quit") return;
      const target = { path: run.socket, session: "default" };
      const said = ending(end, target);
      expect(said.out).toBe(ending({ kind: "quit" }, target).out);
      expect(said.err.map(([code]) => code)).toEqual(["EBADF"]);
      expect(said.exit).toBe(0);
    } finally {
      await run.close();
    }
  }, TEST_MS);
});

describe("the crash record", () => {
  it("crash record holds no typed text: the terminal is given back first, the record holds codes only, the ten newest are kept", async () => {
    const run = await Run.start({ fixture: demo });
    const folder = join(root, "state", "ovis-tui");
    try {
      await run.live();
      const typed = Array.from({ length: 200 }, (_, at) => "QXJZ한글secret"[at % 12]).join("");
      for (const char of typed) await run.keys(char);
      run.type("\x1b[200~PASTED-SECRET-TOKEN\x1b[201~");
      run.core.program("t1").output("PANE-BYTES-TOKEN\r\n");
      await run.advance(50);
      run.host.duringNextWrite(() => { throw Object.assign(new Error("EBADF: bad file descriptor"), { code: "EBADF" }); });
      run.core.program("t1").output("more\r\n");
      await run.advance(50);
      const end = await run.loop.done;
      expect(end.kind).toBe("crashed");
      if (end.kind !== "crashed") return;
      const order: string[] = [];
      const before = existsSync(folder) ? readdirSync(folder).length : 0;
      const path = recordCrash(() => {
        order.push(`leave with ${existsSync(folder) ? readdirSync(folder).length : 0} records`);
        run.host.leave();
      }, folder, crashRecord(version, run.loop.report(), end.error, new Date()), process.pid);
      order.push("written");
      expect(order).toEqual([`leave with ${before} records`, "written"]);
      expect(run.host.log().at(-1)).toBe("raw off");
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const text = readFileSync(path, "utf8");
      const record = JSON.parse(text) as { version: string; size: unknown; mode: { name: string }; actions: string[]; error: { code: string } };
      expect(record.version).toBe(version);
      expect(record.size).toEqual({ cols: 120, rows: 40 });
      expect(record.mode.name).toBe("terminal");
      expect(record.error.code).toBe("EBADF");
      expect(record.actions.length).toBeGreaterThan(0);
      for (const secret of ["QXJZ", "한글", "secret", "PASTED", "TOKEN", "PANE-BYTES", "more"]) expect(text).not.toContain(secret);
      for (let at = 0; at + 6 <= typed.length; at++) expect(text.includes(typed.slice(at, at + 6))).toBe(false);
      for (let n = 0; n < 12; n++) recordCrash(() => {}, folder, crashRecord(version, null, new Error("x"), new Date(Date.UTC(2030, 0, 1, 0, 0, n))), process.pid);
      const kept = readdirSync(folder).sort();
      expect(kept).toHaveLength(CRASH_RECORDS_KEPT);
      expect(kept.at(-1)).toContain("2030-01-01T00-00-11");
      expect(kept[0]).toContain("2030-01-01T00-00-02");
    } finally {
      await run.close();
    }
  }, TEST_MS);
});
