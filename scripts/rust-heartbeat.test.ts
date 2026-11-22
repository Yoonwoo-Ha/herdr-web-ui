import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./self-hosted-runner/rust-heartbeat.sh", import.meta.url));
const repo = "devswha/ovis";
const now = 2_000_000_000;

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rust-heartbeat-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
[ "$1 $2" = "variable set" ] && exit 0
[ -f "$FAKE_GH/runners-error" ] && { echo "gh: Server Error (HTTP 503)" >&2; exit 1; }
cat "$FAKE_GH/runners.json"
`);
chmodSync(join(bin, "gh"), 0o755);

type Runner = { status: string; labels: string[] };

function heartbeat(pages: Runner[][], failing = false): { status: number | null; calls: string[] } {
  const dir = tempDir();
  writeFileSync(join(dir, "runners.json"), pages.map((runners) => JSON.stringify({ runners: runners.map((runner) => ({ status: runner.status, labels: runner.labels.map((name) => ({ name })) })) })).join("\n"));
  if (failing) writeFileSync(join(dir, "runners-error"), "");
  const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 10_000, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_GH: dir, HEARTBEAT_NOW: String(now) } });
  expect(result.error).toBeUndefined();
  return { status: result.status, calls: existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [] };
}

const written = (calls: string[]) => calls.filter((call) => call.startsWith("variable set"));
const pool = { status: "online", labels: ["self-hosted", "self-hosted-ovis"] };

describe.skipIf(process.platform === "win32")("Rust runners' heartbeat", () => {
  it("writes the time while a runner labelled self-hosted-ovis-rust is online, on any page and in any case", () => {
    for (const pages of [
      [[pool, { status: "online", labels: ["self-hosted", "self-hosted-ovis-rust"] }]],
      [[pool], [{ status: "online", labels: ["Self-Hosted", "Self-Hosted-Ovis-Rust"] }]],
    ]) {
      const { status, calls } = heartbeat(pages);
      expect(status).toBe(0);
      expect(written(calls)).toEqual([`variable set CI_RUST_RUNNER_SEEN --repo ${repo} --body ${now}`]);
    }
  });

  it("writes nothing while no such runner is online, so the value ages and the route goes hosted", () => {
    for (const pages of [[[pool]], [[pool, { status: "offline", labels: ["self-hosted", "self-hosted-ovis-rust"] }]], [[]]]) {
      const { status, calls } = heartbeat(pages);
      expect(status).toBe(0);
      expect(written(calls)).toEqual([]);
    }
  });

  it("writes nothing and fails when the runners cannot be listed", () => {
    const { status, calls } = heartbeat([[{ status: "online", labels: ["self-hosted-ovis-rust"] }]], true);
    expect(status).not.toBe(0);
    expect(written(calls)).toEqual([]);
  });
});
