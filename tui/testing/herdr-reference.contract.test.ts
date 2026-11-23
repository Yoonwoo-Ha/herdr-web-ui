import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, type FSWatcher, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processesWith } from "./processes.ts";

const CAPTURE = join(import.meta.dir, "herdr-reference.ts");
const TEST_MS = 60_000;
/** the capture's own limit for one CLI call (15 s): a TERM that arrives only then means the abort was lost, so the receipt must come well before it */
const TERM_RECEIPT_LIMIT_MS = 10_000;
/** the capture waits this long after TERM before SIGKILL; the second TERM has to arrive inside it */
const STOP_GRACE_MS = 5_000;
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "herdr-ref-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** resolves once `path` (directly in the scratch folder) exists; `close` ends the watcher whatever happened */
function appearance(path: string): { promise: Promise<void>; close: () => void } {
  let watcher: FSWatcher | undefined;
  const promise = new Promise<void>((resolve) => {
    watcher = watch(scratch, () => { if (existsSync(path)) resolve(); });
    if (existsSync(path)) resolve();
  });
  return { promise, close: () => watcher?.close() };
}

describe("the herdr reference capture, with a stand-in herdr", () => {
  it("cancels a blocked CLI call on the first TERM, survives a second one during the grace, and leaves no process", async () => {
    const started = join(scratch, "version-started");
    const termSeen = join(scratch, "version-term");
    const standIn = join(scratch, "herdr");
    // Every stand-in has a finite life of its own, so a capture that dies early strands nothing for long:
    // the server runs until `server stop` or 20 s, `--version` announces itself only once its TERM handler
    // is installed, marks the receipt of TERM by creating a file atomically (written aside, then renamed:
    // existence means complete) and stays alive until SIGKILL or 25 s.
    const version = `import { renameSync, writeFileSync } from "node:fs"; process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(`${termSeen}.tmp`)}, ""); renameSync(${JSON.stringify(`${termSeen}.tmp`)}, ${JSON.stringify(termSeen)}); }); writeFileSync(${JSON.stringify(started)}, ""); setTimeout(() => process.exit(0), 25000); setInterval(() => {}, 1000);`;
    writeFileSync(standIn, `#!/bin/sh
state="$XDG_CONFIG_HOME/herdr/sessions/r32"
case "$3" in
  server)
    if [ "$4" = stop ]; then : > "$state/stop"; exit 0; fi
    mkdir -p "$state"; : > "$state/herdr.sock"; : > "$state/herdr-client.sock"
    i=0
    while [ ! -e "$state/stop" ] && [ "$i" -lt 400 ]; do sleep 0.05; i=$((i + 1)); done
    rm -f "$state/herdr.sock" "$state/herdr-client.sock"; exit 0 ;;
  --version) exec ${process.execPath} -e '${version}' ;;
esac
exit 3
`);
    chmodSync(standIn, 0o700);
    const launchedAt = performance.now();
    const capture = Bun.spawn([process.execPath, CAPTURE, standIn], {
      env: { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(capture.stdout).text();
    const stderr = new Response(capture.stderr).text();
    const deadline = setTimeout(() => capture.kill("SIGKILL"), 40_000);
    const blocked = appearance(started);
    const received = appearance(termSeen);
    const earlyEnd = capture.exited.then(async () => { throw new Error(`the capture ended early: ${await stderr}`); });
    earlyEnd.catch(() => {});
    try {
      await Promise.race([blocked.promise, earlyEnd]);
      const firstTermAt = performance.now();
      capture.kill("SIGTERM");
      await Promise.race([received.promise, earlyEnd]);
      const receivedAt = performance.now();
      // the CLI is alive and ignoring TERM: the second TERM comes right after the receipt, inside the grace
      capture.kill("SIGTERM");
      const secondTermAt = performance.now();
      expect({ receivedWithinLimit: receivedAt - launchedAt < TERM_RECEIPT_LIMIT_MS, receivedAfterFirstTerm: receivedAt >= firstTermAt, secondInsideGrace: secondTermAt - firstTermAt < STOP_GRACE_MS })
        .toEqual({ receivedWithinLimit: true, receivedAfterFirstTerm: true, secondInsideGrace: true });
      const code = await capture.exited;
      expect({ code, cleaned: (await stdout).includes("owned server exited"), left: processesWith(`NOMARK-${crypto.randomUUID()}`, scratch) }).toEqual({ code: 143, cleaned: true, left: [] });
    } finally {
      clearTimeout(deadline);
      blocked.close();
      received.close();
    }
  }, TEST_MS);
});
