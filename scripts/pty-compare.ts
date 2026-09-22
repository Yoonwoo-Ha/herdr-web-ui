/** Isolated comparison, never a production backend. Owns and closes its herdr workspace. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { PtySession, type PtySessionOptions } from "../server/pty/session.ts";
import { herdrRpc, herdrSocketPath } from "../server/herdr/client.ts";

type Backend = "sidecar" | "native";
type Session = Pick<PtySession, "write" | "resize" | "kill">;

function spawn(backend: Backend, options: PtySessionOptions): Session {
  if (backend === "sidecar") return new PtySession(options);
  const decoder = new TextDecoder();
  let closed = false;
  let eof!: () => void;
  const outputDone = new Promise<void>(resolve => { eof = resolve; });
  const proc = Bun.spawn([options.command, ...options.args], {
    cwd: process.env.HOME ?? "/",
    env: { ...process.env, ...options.env, TERM: "xterm-256color" },
    terminal: {
      cols: options.cols, rows: options.rows,
      data(_terminal, data) {
        const text = decoder.decode(data, { stream: true });
        if (text) options.onData(text);
      },
      exit() {
        const tail = decoder.decode();
        if (tail) options.onData(tail);
        eof();
      },
    },
  });
  void Promise.all([proc.exited, outputDone]).then(([code]) => {
    proc.terminal?.close();
    if (!closed) options.onExit(code);
  });
  return {
    write: data => { proc.terminal?.write(data); },
    resize: (cols, rows) => proc.terminal?.resize(cols, rows),
    kill: () => { closed = true; proc.kill(); proc.terminal?.close(); },
  };
}

async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function treeRssKiB(): number {
  const rows = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid=,rss="]).stdout.toString().trim().split("\n")
    .map(line => line.trim().split(/\s+/).map(Number));
  const own = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) if (own.has(parent!) && !own.has(pid!)) { own.add(pid!); changed = true; }
  }
  return rows.reduce((sum, [pid, , rss]) => sum + (own.has(pid!) ? rss! : 0), 0);
}

const interactiveProgram = `
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  let pending = "";
  process.stdin.on("data", data => {
    if (data.includes("\\x03")) { process.stdout.write("INTERRUPTED"); return; }
    pending += data;
    for (let i; (i = pending.indexOf("\\n")) !== -1;) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      if (line === "size") process.stdout.write("SIZE:" + process.stdout.columns + "x" + process.stdout.rows);
      else if (line === "exit") process.stdout.write("FINAL:끝🙂", () => process.exit(7));
      else process.stdout.write("ECHO:" + line);
    }
  });
  process.stdout.write("READY:" + process.stdout.isTTY);
`;

async function compatibility(backend: Backend) {
  let output = "";
  let code: number | null | undefined;
  const started = performance.now();
  const session = spawn(backend, {
    command: "node", args: ["-e", interactiveProgram], cols: 80, rows: 24,
    onData: text => { output += text; }, onExit: value => { code = value; },
  });
  try {
    await until(() => output.includes("READY:true"), "TTY ready");
    const startupMs = performance.now() - started;
    session.write("한글🙂\n");
    await until(() => output.includes("ECHO:한글🙂"), "Korean input/output");
    session.resize(93, 37);
    session.write("size\n");
    await until(() => output.includes("SIZE:93x37"), "resize");
    const interrupt = performance.now();
    session.write("\x03");
    await until(() => output.includes("INTERRUPTED"), "Ctrl+C");
    const interruptMs = performance.now() - interrupt;
    session.write("exit\n");
    await until(() => code !== undefined, "exit");
    assert.equal(code, 7);
    assert.ok(output.endsWith("FINAL:끝🙂"));
    return { startupMs: Math.round(startupMs), interruptMs: Math.round(interruptMs), utf8: true, resize: true, finalOutput: true, exitCode: code };
  } finally { session.kill(); }
}

async function sustained(backend: Backend, seconds: number) {
  const unit = "한글🙂abcdef";
  const chunk = unit.repeat(1024);
  const chunks = seconds * 100;
  const expected = createHash("sha256");
  for (let i = 0; i < chunks; i++) expected.update(chunk);
  const hash = createHash("sha256");
  let bytes = 0;
  let code: number | null | undefined;
  const rss: number[] = [];
  const started = performance.now();
  const session = spawn(backend, {
    command: "node", args: ["-e", `
      const chunk = ${JSON.stringify(unit)}.repeat(1024);
      let remaining = ${chunks};
      function next() {
        if (remaining-- <= 0) { process.exitCode = 7; return; }
        if (process.stdout.write(chunk)) setTimeout(next, 10);
        else process.stdout.once("drain", () => setTimeout(next, 10));
      }
      next();
    `], cols: 80, rows: 24,
    onData: text => { bytes += Buffer.byteLength(text); hash.update(text); },
    onExit: value => { code = value; },
  });
  const sampler = setInterval(() => rss.push(treeRssKiB()), 500);
  try {
    await until(() => code !== undefined, "sustained output", seconds * 2000 + 5000);
    assert.equal(code, 7);
    assert.equal(bytes, Buffer.byteLength(chunk) * chunks);
    assert.equal(hash.digest("hex"), expected.digest("hex"));
    return { bytes, elapsedMs: Math.round(performance.now() - started), peakTreeRssKiB: Math.max(...rss), firstTreeRssKiB: rss[0], lastTreeRssKiB: rss.at(-1), checksum: "matched" };
  } finally { clearInterval(sampler); session.kill(); }
}

async function herdrCompatibility(backend: Backend) {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string; terminal_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-pty-${backend}`, cwd: "/tmp", focus: false },
  );
  let session: Session | undefined;
  let output = "";
  let ended = false;
  let terminalId = created.root_pane.terminal_id;
  try {
    if (!terminalId) {
      const { snapshot } = await herdrRpc<{ snapshot: { panes: Array<{ pane_id: string; terminal_id: string }> } }>("session.snapshot", {});
      terminalId = snapshot.panes.find(pane => pane.pane_id === created.root_pane.pane_id)!.terminal_id;
    }
    session = spawn(backend, {
      command: "herdr", args: ["terminal", "attach", terminalId], cols: 100, rows: 30,
      env: { HERDR_SOCKET_PATH: herdrSocketPath() },
      onData: text => { output = (output + text).slice(-65536); }, onExit: () => { ended = true; },
    });
    await until(() => output.length > 0, "herdr paint");
    await Bun.sleep(500);
    session.write("printf 'PROBE_%s\\n' '한글🙂'\r");
    try {
      await until(() => stripVTControlCharacters(output).includes("PROBE_한글🙂"), "herdr input/output");
    } catch (error) {
      console.error(JSON.stringify({ backend, terminalTail: output.slice(-4096) }));
      throw error;
    }
    session.resize(93, 37);
    assert.equal(ended, false);
    session.kill();
    session = undefined;
    await until(() => Bun.spawnSync(["pgrep", "-f", `terminal attach ${terminalId}`]).stdout.length === 0, "attach cleanup", 5000);
    return { attach: true, utf8Input: true, cleanup: true };
  } finally {
    session?.kill();
    await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id });
  }
}

const seconds = Number(process.argv[2] ?? 30);
assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 300);
console.log(JSON.stringify({ bun: Bun.version, node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim(), seconds }));
for (const backend of ["sidecar", "native"] as const) {
  const interactive = await compatibility(backend);
  const herdr = await herdrCompatibility(backend);
  console.log(JSON.stringify({ backend, interactive, herdr }));
  console.log(JSON.stringify({ backend, sustained: await sustained(backend, seconds) }));
}
console.log(JSON.stringify({ nativeOutputPause: "pause" in Bun.Terminal.prototype, decision: "Keep the sidecar until native output backpressure is available." }));
