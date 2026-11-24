/**
 * The unit and integration files' seconds, by which scripts/ci-tests.ts starts the longest first.
 * `--runs` reads them through `gh` from the check logs of the newest green pushes to main and
 * changes nothing there: the runs' check-fast-* and integration-logs-* artifacts go to a temporary
 * folder that is removed again. Log files named on the command line are read as one run each.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longestFirst } from "./ci-browser-parallel.ts";
import { gh, lastAttemptArtifacts, refreshRequest, refreshTimings } from "./ci-browser-timings.ts";

const repo = join(import.meta.dir, "..");
const TABLE = "scripts/ci-test-timings.json";
export const CHECK_ARTIFACT = /^((?:check-fast|integration-logs)-\d+)-(\d+)$/;

export function testFiles(cwd = repo): string[] {
  return [...new Bun.Glob("{src,shared,server,scripts,telemetry,push-relay,relay,integrations,tui}/**/*.test.{ts,tsx}").scanSync({ cwd })].sort();
}

/**
 * Longest first by `timings`. A file without an entry (a new one) starts first, and among such
 * files, or files of the same seconds, the larger file first, as all of them did before the table.
 */
export function testQueue(files: readonly string[], timings: Readonly<Record<string, number>>, size: (file: string) => number): string[] {
  const bySize = [...files].sort((a, b) => size(b) - size(a));
  return longestFirst(bySize, { ...timings });
}

export function readTestTimings(): Record<string, number> {
  try {
    const table: unknown = JSON.parse(readFileSync(join(repo, TABLE), "utf8"));
    if (table === null || typeof table !== "object" || Array.isArray(table)) throw new Error("not an object of file seconds");
    return table as Record<string, number>;
  } catch (error) {
    console.log(`No test timings (${(error as Error).message}): the largest files start first`);
    return {};
  }
}

export function fileSeconds(log: string): Record<string, number> {
  const seconds: Record<string, number> = {};
  for (const match of log.matchAll(/^(?:\[\w+\] )?--- (\S+\.test\.tsx?) \([^,()]+, (\d+(?:\.\d+)?)s, exit 0\)$/gm)) {
    seconds[match[1]!] = Number(match[2]);
  }
  return seconds;
}

/**
 * Downloads the check logs of the newest `runs` green pushes to main into `dir`; returns one folder
 * per run. A run without them is passed over (one that changed only docs ran no tests, and an old
 * run's artifacts have expired); a read or download that fails ends the refresh.
 */
async function downloadRuns(runs: number, dir: string): Promise<string[]> {
  const found: { databaseId: number }[] = JSON.parse(await gh([
    "run", "list", "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--status", "success", "--limit", String(runs), "--json", "databaseId",
  ]));
  const folders: string[] = [];
  for (const { databaseId } of found) {
    const kept = await gh(["api", "--paginate", `repos/{owner}/{repo}/actions/runs/${databaseId}/artifacts?per_page=100`, "--jq", ".artifacts[] | select(.expired | not) | .name"]);
    const names = lastAttemptArtifacts(kept.split("\n").filter(Boolean), CHECK_ARTIFACT);
    if (names.length === 0) { console.log(`run ${databaseId}: no check logs kept`); continue; }
    const folder = join(dir, String(databaseId));
    await gh(["run", "download", String(databaseId), ...names.flatMap((name) => ["--name", name]), "--dir", folder]);
    folders.push(folder);
  }
  return folders;
}

const runSeconds = (folder: string): Record<string, number> =>
  Object.assign({}, ...[...new Bun.Glob("**/*.stdout.log").scanSync({ cwd: folder, absolute: true, dot: true })].sort().map((log) => fileSeconds(readFileSync(log, "utf8"))));

async function main(): Promise<void> {
  const request = refreshRequest(process.argv.slice(2));
  const path = join(repo, TABLE);
  let existing: Record<string, number> = {};
  try { existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>; } catch {}
  const listed = testFiles();
  const dir = request.runs > 0 ? mkdtempSync(join(tmpdir(), "ci-test-timings-")) : null;
  try {
    const runs = [
      ...request.summaries.map((log) => fileSeconds(readFileSync(log, "utf8"))),
      ...(dir ? (await downloadRuns(request.runs, dir)).map(runSeconds) : []),
    ];
    if (request.runs > 0 && runs.every((run) => Object.keys(run).length === 0)) throw new Error(`No file seconds in the check logs of the newest ${request.runs} green runs of ci.yml on main`);
    const table = refreshTimings(listed, existing, runs);
    writeFileSync(path, JSON.stringify(table, null, 2) + "\n");
    const changed = listed.filter((file) => table[file] !== existing[file]);
    const untimed = listed.filter((file) => !(file in table));
    console.log(`${TABLE}: ${runs.length} runs read, ${changed.length} entries changed; ${Object.keys(table).length} of the ${listed.length} test files have one`);
    if (untimed.length > 0) console.log(`In no run as a pass, and without an entry, so they keep starting first: ${untimed.join(", ")}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
