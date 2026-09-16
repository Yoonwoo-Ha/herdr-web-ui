#!/usr/bin/env node
/**
 * PTY host: runs ONE command on a real pseudo-terminal and bridges it to its parent.
 *
 * This exists as a separate Node process on purpose. herdr's terminal attach only
 * behaves like a terminal when it owns a TTY, but Bun 1.4 has no PTY API
 * (Bun.spawn ignores `pty`, Bun.PTY is undefined) and loading node-pty inside Bun
 * panics the runtime (oven-sh/bun#18546). Node runs node-pty correctly, so the
 * Bun server spawns this host and speaks a tiny protocol to it.
 *
 * Protocol
 *   argv:   <cols> <rows> <command> [args...]
 *   stdin:  newline-delimited JSON control frames
 *             {"t":"i","d":"<text>"}          write text into the pty
 *             {"t":"r","c":<cols>,"r":<rows>} resize the pty
 *   stdout: raw pty bytes, unmodified
 *   stderr: diagnostics only
 *   exit:   mirrors the child's exit code
 */

import * as pty from "node-pty";

const [colsRaw, rowsRaw, command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("pty-host: usage: pty-host.mjs <cols> <rows> <command> [args...]\n");
  process.exit(2);
}

const cols = Number.parseInt(colsRaw ?? "", 10);
const rows = Number.parseInt(rowsRaw ?? "", 10);

const term = pty.spawn(command, args, {
  name: "xterm-256color",
  cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
  rows: Number.isFinite(rows) && rows > 0 ? rows : 24,
  cwd: process.env.HOME ?? "/",
  env: { ...process.env, TERM: "xterm-256color" },
});

term.onData((chunk) => {
  process.stdout.write(chunk);
});

let exited = false;
term.onExit(({ exitCode }) => {
  exited = true;
  // let stdout drain before the process disappears
  process.stdout.write("", () => process.exit(exitCode ?? 0));
});

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index = pending.indexOf("\n");
  while (index !== -1) {
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    if (line) handle(line);
    index = pending.indexOf("\n");
  }
});

function handle(line) {
  if (exited) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  try {
    if (frame.t === "i" && typeof frame.d === "string") term.write(frame.d);
    else if (frame.t === "r") term.resize(clamp(frame.c), clamp(frame.r));
  } catch (error) {
    process.stderr.write(`pty-host: ${error?.message ?? error}\n`);
  }
}

function clamp(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1000);
}

const stop = () => {
  if (!exited) {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  }
};
process.on("SIGTERM", () => { stop(); process.exit(0); });
process.on("SIGINT", () => { stop(); process.exit(0); });
process.stdin.on("close", stop);
