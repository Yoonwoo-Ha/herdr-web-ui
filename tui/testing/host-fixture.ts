/**
 * The real host (tui/host/unix.ts) in a small entry, for tui/host/restore.contract.test.ts:
 *
 *   bun tui/testing/host-fixture.ts exit|linger|process-exit|throw|wait|leave-fails|fail-wait|watch-kill|kill-first|job
 *
 * It enters, listens, runs the probe and reports on the terminal it holds: `PROBE <ms> <json>`, `DEPTH`,
 * `RESIZE <cols>x<rows>`, `INPUT <length> <hex of the first 32 bytes>`, then `READY`. A `q` ends it the
 * way its argument names: `exit` leaves and lets the loop run dry, `linger` leaves and stays until a
 * signal (so the termios can be read after leave while it still runs), `process-exit` calls
 * process.exit(0) without leaving, `throw` throws from the input listener; `wait` ends only by a
 * signal. From the `q` on, `leave-fails` and `fail-wait` make every write of the host fail with
 * EBADF: `leave-fails` then leaves, writes `LEFT <what leave threw>` past the host and stays until a
 * signal; `fail-wait` ends only by a signal. `watch-kill` turns on the colour-scheme watch at the `q` and then dies by
 * SIGKILL, as a screen that cannot give the terminal back; `kill-first` dies by SIGKILL before it enters, holding
 * none of the terminal's modes. `job` ends only by a signal, and a Ctrl+Z byte sends SIGTSTP to
 * its own process group, as a shell's job control stops a foreground job. Not a terminal: one line on stderr, exit 3.
 */
import { writeSync } from "node:fs";
import { createUnixHost } from "../host/unix.ts";

const mode = process.argv[2] ?? "wait";
const hash = process.env["HOST_FIXTURE_HASH_INPUT"] === "1" ? new Bun.CryptoHasher("sha256") : null;
let failing = false;
const host = createUnixHost({
  writeSync: (fd, buffer, offset, length) => {
    if (failing) throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
    return writeSync(fd, buffer, offset, length);
  },
});
const say = (line: string) => host.write(`${line}\r\n`);

if (mode === "kill-first") process.kill(process.pid, "SIGKILL");
if (!host.enter()) {
  process.stderr.write("host-fixture: not a terminal\n");
  process.exit(3);
}
// listening before the probe, so that anything the probe let through would show
host.onInput((bytes) => {
  hash?.update(bytes);
  say(`INPUT ${bytes.length} ${Buffer.from(bytes.subarray(0, 32)).toString("hex")}`);
  if (mode === "job" && bytes.includes(0x1a)) process.kill(0, "SIGTSTP");
  if (!bytes.includes(0x71)) return;
  if (hash) say(`SHA256 ${hash.digest("hex")}`);
  if (mode === "exit") host.leave();
  else if (mode === "linger") { host.leave(); setInterval(() => {}, 1000); }
  else if (mode === "process-exit") process.exit(0);
  else if (mode === "throw") throw new Error("fixture: thrown on purpose");
  else if (mode === "watch-kill") { host.watchDisplay(); process.kill(process.pid, "SIGKILL"); }
  else if (mode === "fail-wait") failing = true;
  else if (mode === "leave-fails") {
    failing = true;
    let thrown = "nothing";
    try { host.leave(); } catch (error) { thrown = (error as { code?: string }).code ?? String(error); }
    writeSync(1, `LEFT ${thrown}\r\n`);
    setInterval(() => {}, 1000);
  }
});
host.onResize(({ cols, rows }) => say(`RESIZE ${cols}x${rows}`));
const asked = performance.now();
const result = await host.probe();
say(`PROBE ${Math.round(performance.now() - asked)} ${JSON.stringify(result)}`);
say(`DEPTH ${host.colorDepth}`);
say("READY");
