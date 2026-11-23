import { writeSync } from "node:fs";
import { WRITE_AGAIN_LIMIT, WRITE_AGAIN_PAUSE_MS } from "../model/deadlines.ts";
import { guardedHost, type HostHooks } from "./guard.ts";
import type { Host } from "./index.ts";

type Listener = () => void;

export interface UnixStdin {
  isTTY?: boolean;
  setRawMode(on: boolean): unknown;
  on(event: "readable", listener: Listener): unknown;
  off(event: "readable", listener: Listener): unknown;
  read(): Uint8Array | string | null;
  pause(): unknown;
  unref?(): unknown;
}

export interface UnixStdout {
  isTTY?: boolean;
  fd: number;
  columns?: number;
  rows?: number;
  on(event: "resize", listener: Listener): unknown;
  off(event: "resize", listener: Listener): unknown;
}

export interface UnixProcess {
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  exit(code: number): unknown;
  kill(pid: number, signal: string): unknown;
  readonly pid: number;
}

export interface UnixHostParts {
  stdin: UnixStdin;
  stdout: UnixStdout;
  process: UnixProcess;
  env: Record<string, string | undefined>;
  writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  /** blocks this long between two tries of a refused write */
  pause: (ms: number) => void;
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4));
/** a synchronous wait that does not spin: writes are synchronous, so the retry must be too */
const pauseSync = (ms: number) => { Atomics.wait(pauseCell, 0, 0, ms); };

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The host terminal of this process: stdin, stdout and their tty. Writes are synchronous, one
 * frame at a time (probe d: Bun writes to a tty synchronously and `drain` never fires); stdin is
 * read in paused mode, a `readable` event then `read()` until null, in whole chunks. The parts are
 * replaceable so its wiring can be tested without a terminal; the defaults are this process's own.
 */
export function createUnixHost(parts: Partial<UnixHostParts> = {}): Host {
  const stdin: UnixStdin = parts.stdin ?? process.stdin;
  const stdout: UnixStdout = parts.stdout ?? process.stdout;
  const proc: UnixProcess = parts.process ?? process;
  const env = parts.env ?? process.env;
  const write = parts.writeSync ?? writeSync;
  const pause = parts.pause ?? pauseSync;
  let sink: ((bytes: Uint8Array) => void) | null = null;

  const readAll = () => {
    for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) {
      sink?.(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
    }
  };

  return guardedHost({
    isTerminal: stdin.isTTY === true && stdout.isTTY === true,
    colorTerm: env["COLORTERM"],
    setRaw: (on) => { stdin.setRawMode(on); },
    write(bytes) {
      let refused = 0;
      for (let at = 0; at < bytes.length;) {
        try {
          at += write(stdout.fd, bytes, at, bytes.length - at);
          refused = 0;
        } catch (error) {
          // a tty another program left non-blocking: tried again, a while apart, up to a limit; then the
          // EAGAIN goes up and the guard reports the terminal gone
          if ((error as { code?: unknown }).code !== "EAGAIN" || ++refused > WRITE_AGAIN_LIMIT) throw error;
          pause(WRITE_AGAIN_PAUSE_MS);
        }
      }
    },
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    startReading(onBytes) {
      sink = onBytes;
      stdin.on("readable", readAll);
    },
    readNow: readAll,
    stopReading() {
      sink = null;
      stdin.off("readable", readAll);
      stdin.pause();
      // a paused stdin still holds the loop open in Bun; unref lets the process end, and fd 0 stays open
      stdin.unref?.();
    },
    timer(ms, fire) {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
    now: () => performance.now(),
    hook(hooks: HostHooks) {
      const signals = SIGNALS.map((name) => [name, () => hooks.signal(name)] as const);
      for (const [name, listener] of signals) proc.on(name, listener);
      proc.on("exit", hooks.exit);
      stdout.on("resize", hooks.resize);
      proc.on("SIGTSTP", hooks.stop);
      proc.on("SIGCONT", hooks.cont);
      return () => {
        for (const [name, listener] of signals) proc.off(name, listener);
        proc.off("exit", hooks.exit);
        stdout.off("resize", hooks.resize);
        proc.off("SIGTSTP", hooks.stop);
        proc.off("SIGCONT", hooks.cont);
      };
    },
    exit: (code) => { proc.exit(code); },
    // this process itself, the one stop no handler can catch
    suspend: () => { proc.kill(proc.pid, "SIGSTOP"); },
  });
}
