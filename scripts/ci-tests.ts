/**
 * Every test belongs to one suite; newly added unit tests are picked up automatically.
 *
 * The integration suite runs its files side by side: a few workers take files off one
 * queue, each worker on a herdr session of its own (`<session>-<n>`), so no two files
 * ever share a herdr, and none shares the plain `<session>` with the browser scripts.
 * HERDR_TEST_SHARDS sets the worker count; 1 is the old serial run.
 */
import { availableParallelism } from "node:os";

const suite = process.argv[2];
if (suite !== "unit" && suite !== "integration") throw new Error("Usage: bun scripts/ci-tests.ts unit|integration");
const files = [...new Bun.Glob("{src,shared,server,scripts,telemetry}/**/*.test.ts").scanSync({ cwd: process.cwd() })].sort();
// The legacy updater suite mixes Git-only cases with real bridge restart/rollback cases.
const needsHerdr = (file: string) => file.endsWith(".contract.test.ts") || file === "server/updater.test.ts" || file.startsWith("server/herdr/") || file.startsWith("server/pty/");
const selected = files.filter((file) => needsHerdr(file) === (suite === "integration"));
if (!selected.length) throw new Error(`No ${suite} tests found`);
const herdr = process.env["HERDR_WEB_HERDR_BIN"] || "herdr";
if (suite === "integration" && !Bun.which(herdr)) {
  throw new Error("Integration tests require herdr on PATH (or HERDR_WEB_HERDR_BIN)");
}
if (suite === "integration" && process.env["HERDR_TEST_LIVE"] === "1") {
  throw new Error("CI integration tests must use an isolated herdr session");
}
console.log(`${suite}: ${selected.length} test files`);

if (suite === "unit") {
  const child = Bun.spawn([process.execPath, "test", ...selected.map((file) => `./${file}`)], {
    env: { ...process.env, HERDR_TEST_MODE: suite },
    windowsHide: true, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}

const requested = Number(process.env["HERDR_TEST_SHARDS"]);
const shards = Math.min(selected.length, requested >= 1 ? Math.floor(requested) : Math.min(4, availableParallelism()));
const baseSession = process.env["HERDR_TEST_SESSION"] || "herdr-web-ui-test";
// Always `<session>-<n>`, also for one worker: the plain session belongs to the browser scripts,
// which run beside this suite in CI (scripts/ci-lanes.ts) and must never share a herdr with it.
const sessions = Array.from({ length: shards }, (_, index) => `${baseSession}-${index + 1}`);
// Largest first: the long files are the large ones, and one started last would run on alone.
const queue = [...selected].sort((a, b) => Bun.file(b).size - Bun.file(a).size);
const totals = { pass: 0, fail: 0, skip: 0 };
const failed: string[] = [];
const unread: string[] = [];
const startedAt = Date.now();

async function work(session: string): Promise<void> {
  for (let file = queue.shift(); file; file = queue.shift()) {
    const fileStartedAt = Date.now();
    // Live process/pane probes can poll for 10s; Bun's 5s default would cut them off early.
    // One stream, so a file's output reads in the order it was written.
    const child = Bun.spawn(["sh", "-c", 'exec "$@" 2>&1', "sh", process.execPath, "test", "--timeout", "15000", `./${file}`], {
      env: { ...process.env, HERDR_TEST_MODE: suite!, HERDR_TEST_SESSION: session },
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const count = (word: keyof typeof totals) => Number(new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(output)?.[1] ?? 0);
    for (const word of ["pass", "fail", "skip"] as const) totals[word] += count(word);
    // a run that never printed its counts cannot be told from one that ran nothing
    if (!/^\s*\d+ pass$/m.test(output) && !/^\s*\d+ fail$/m.test(output)) unread.push(file);
    if (code !== 0) failed.push(file);
    console.log(`\n--- ${file} (${session}, ${((Date.now() - fileStartedAt) / 1000).toFixed(1)}s, exit ${code})\n${output.trimEnd()}`);
  }
}

await Promise.all(sessions.map(work));
// The sessions `<session>-<n>` exist for this run only.
await Promise.all(sessions.map((session) => Bun.spawn([herdr, "--session", session, "server", "stop"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited));
console.log(`\nintegration: ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip in ${selected.length} files, ${shards} at a time, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
for (const file of failed) console.log(`FAILED ${file}`);
for (const file of unread) console.log(`NO RESULT ${file}`);
process.exit(failed.length || unread.length ? 1 : 0);
