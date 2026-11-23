/**
 * Runs on a test's pseudo-terminal, between the PTY host and the entry under test:
 *
 *   bun tui/testing/supervise.ts <socket> <entry...>
 *
 * It reads the pty's termios with `stty -a` before the entry starts and after it ended, starts the
 * entry on the same pty (stdin and stdout inherited, stderr kept for the report), and talks to
 * `runSupervised` (pty.ts) over the unix socket: `signal` sends a signal to the entry through the
 * handle of the child this process started, and only while that child is not reaped; `stty` reads
 * the termios now; at the end it reports the entry's exit, both termios and its stderr. It signals
 * nothing else.
 */
import { constants } from "node:os";
import { drainTail } from "./drain.ts";

// the entry's stderr is kept as a bounded tail: a flood is never held whole or sent in one message
const STDERR_KEEP = 16 * 1024;
const STDERR_EOF_MS = 2_000;

const [socketPath, ...entry] = process.argv.slice(2);
if (!socketPath || entry.length === 0) {
  console.error("usage: bun tui/testing/supervise.ts <socket> <entry...>");
  process.exit(2);
}

const toolEnv = { PATH: process.env["PATH"] || "/usr/bin:/bin" };
const sttyPath = Bun.which("stty", toolEnv) ?? "/bin/stty";

async function stty(): Promise<string | null> {
  const proc = Bun.spawn([sttyPath, "-a"], { env: toolEnv, stdin: "inherit", stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? text : null;
}

// a hang-up of the pty reaches the entry too (the same process group); this process stays to report
process.on("SIGHUP", () => {});

type Signal = "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGTSTP" | "SIGCONT";
let child: ReturnType<typeof Bun.spawn> | null = null;
const early: Signal[] = [];
const deliver = (name: Signal) => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill(name);
};

let buffered = "";
let socketClosed: () => void = () => {};
const closed = new Promise<void>((resolve) => { socketClosed = resolve; });
const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    data(_socket, data) {
      buffered += data.toString();
      for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, at)) as { t: string; name?: Signal; id?: number };
        buffered = buffered.slice(at + 1);
        if (message.t === "signal" && message.name) {
          if (child) deliver(message.name);
          else early.push(message.name);
        } else if (message.t === "stty") void stty().then((text) => send({ t: "stty", id: message.id, text }));
      }
    },
    close() { socketClosed(); },
  },
});
const send = (message: Record<string, unknown>) => { socket.write(`${JSON.stringify(message)}\n`); };

const before = await stty();
child = Bun.spawn(entry, { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "pipe" });
const stderr = drainTail(child.stderr as ReadableStream<Uint8Array>, STDERR_KEEP);
send({ t: "started" });
for (const name of early.splice(0)) deliver(name);
await child.exited;
const after = await stty();
const signal = child.signalCode as NodeJS.Signals | null;
const code = signal ? 128 + (constants.signals[signal] ?? 0) : child.exitCode ?? 1;
const stderrEnd = await stderr.finish(STDERR_EOF_MS);
send({ t: "ended", code, signal, before, after, stderr: stderrEnd === "complete" ? stderr.text() : `${stderr.text()}\n[stderr stayed open after the entry exited]` });
socket.end();
await closed;
process.exit(code);
