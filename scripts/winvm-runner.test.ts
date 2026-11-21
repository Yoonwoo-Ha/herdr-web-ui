import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/self-hosted-runner/winvm-runner.sh --once against fake winvm, ssh, scp, gh and sleep: what it resets, when it
// offers winvm to the route (CI_WINVM_READY), which jobs it serves before it stops and what it leaves to the next user.
const script = fileURLToPath(new URL("./self-hosted-runner/winvm-runner.sh", import.meta.url));
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const fakes: Record<string, string> = {
  winvm: `#!/bin/bash
echo "winvm $*" >> "$FAKE/calls"
case "$1" in
  status) [ -f "$FAKE/status-fails-after-job" ] && [ -s "$FAKE/rounds" ] && exit 1
          cat "$FAKE/state"; if [ -f "$FAKE/lease" ]; then echo "lease: $(cat "$FAKE/lease")"; else echo "lease: free"; fi ;;
  lease) if [ -f "$FAKE/lease" ] && [ "$(cut -d' ' -f1 "$FAKE/lease")" != "$2" ]; then echo "winvm: busy, leased by $(cat "$FAKE/lease")"; exit 1; fi
         echo "$2 2026-11-21T00:00:00+09:00" > "$FAKE/lease"; echo "winvm: leased to $2" ;;
  release) [ -f "$FAKE/release-fails" ] && exit 1; rm -f "$FAKE/lease" ;;
  reset) echo x >> "$FAKE/resets"; [ -f "$FAKE/reset-fails-after-job" ] && [ -s "$FAKE/rounds" ] && exit 1
         echo "services 1" > "$FAKE/services"; true ;;
  start) echo running > "$FAKE/state" ;;
esac
`,
  // the VM: a fence stops the other runner services that are not in a job (one service per worker), and counts this
  // runner's own job only when the script it is sent asks for that; Invoke-InSession runs one job a round, and from the
  // second round on serves one of the jobs queued for the label
  ssh: `#!/bin/bash
cmd="\${@: -1}"
case "$cmd" in
  *EncodedCommand*) [ -f "$FAKE/unreachable" ] && exit 255
    [ -f "$FAKE/fence-lies" ] && { echo "FENCE 0 0"; exit 255; }
    w=$(cat "$FAKE/workers"); [ -f "$FAKE/workers-after-job" ] && [ -s "$FAKE/rounds" ] && w=1
    s=$(cut -d' ' -f2 "$FAKE/services")
    while [ "$s" -gt "$w" ]; do echo "Stopped actions.runner.other-$s"; s=$((s - 1)); done
    echo "services $s" > "$FAKE/services"
    if [ -f "$FAKE/own-job-after-round" ] && [ -s "$FAKE/rounds" ] && base64 -d <<<"\${cmd##* }" | iconv -f UTF-16LE -t UTF-8 | grep -q -- '^} -IncludeOwn'; then w=$((w + 1)); fi
    echo "fence $s $w" >> "$FAKE/calls"; echo "FENCE $s $w" ;;
  *"Get-Process Runner.Worker"*) [ -f "$FAKE/unreachable" ] && exit 255; cat "$FAKE/workers" ;;
  *"Get-Process explorer"*) echo UP ;;
  *"ReadLine"*) cat > "$FAKE/token" ;;
  *Invoke-InSession*) echo "ssh $cmd" >> "$FAKE/calls"
    [ -f "$FAKE/session-fails" ] && { echo round >> "$FAKE/rounds"; echo "LOW-DISK: not starting"; exit 3; }
    [ -f "$FAKE/stop-in-round" ] && [ ! -s "$FAKE/rounds" ] && kill -TERM "$PPID"
    if [ -s "$FAKE/rounds" ]; then n=$(cat "$FAKE/queued" 2>/dev/null || echo 0); [ "$n" -gt 0 ] && echo $((n - 1)) > "$FAKE/queued"; fi
    echo round >> "$FAKE/rounds"
    echo "Current runner version: '9.9.9'"; echo "2026-11-21 00:00:00Z: Listening for Jobs"
    echo "2026-11-21 00:00:05Z: Running job: Native Windows install"; echo "Job Native Windows install completed with result: Succeeded" ;;
  *) true ;;
esac
`,
  scp: "#!/bin/sh\nexit 0\n",
  sleep: '#!/bin/sh\necho "$1" >> "$FAKE/sleeps"\n',
  // a late job: its route read the last offer when it was three minutes old, and its Detect changes took five; it is
  // queued only once the launcher has waited that long
  gh: `#!/bin/bash
echo "gh $*" >> "$FAKE/calls"
case "$*" in
  "variable set"*) echo "mark \${@: -1}" >> "$FAKE/marks" ;;
  *releases/latest*) [ -f "$FAKE/package-fails" ] && exit 1; echo v9.9.9 ;;
  *registration-token*) echo SECRET-TOKEN ;;
  *"-X DELETE"*) echo deleted >> "$FAKE/deleted" ;;
  *actions/runners*) [ -f "$FAKE/runners-unreadable" ] && exit 1; echo 42 ;;
  *"runs?status=queued"*)
    if [ -f "$FAKE/queue-fails-once" ]; then rm "$FAKE/queue-fails-once"; exit 1; fi
    if [ -f "$FAKE/late-job" ] && awk '$1 >= 480 { found = 1 } END { exit !found }' "$FAKE/sleeps"; then rm "$FAKE/late-job"; echo 1 > "$FAKE/queued"; fi
    echo 7 ;;
  *runs/7/jobs*) cat "$FAKE/queued" 2>/dev/null || echo 0 ;;
  *) true ;;
esac
`,
};

type State = { workers?: number; services?: number; queued?: number; lease?: string; flags?: readonly string[] };

function setup(state: State = {}) {
  const dir = mkdtempSync(join(tmpdir(), "winvm-runner-"));
  created.push(dir);
  const bin = join(dir, "bin");
  const fake = join(dir, "fake");
  const cache = join(dir, "cache");
  for (const d of [bin, fake, join(cache, "winvm-runner")]) mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(cache, "winvm-runner", "actions-runner-win-x64-9.9.9.zip"), "zip");
  writeFileSync(join(fake, "state"), "running\n");
  writeFileSync(join(fake, "workers"), `${state.workers ?? 0}\n`);
  writeFileSync(join(fake, "services"), `services ${state.services ?? 0}\n`);
  writeFileSync(join(fake, "queued"), `${state.queued ?? 0}\n`);
  for (const file of ["calls", "marks", "rounds", "deleted", "resets", "sleeps"]) writeFileSync(join(fake, file), "");
  for (const flag of state.flags ?? []) writeFileSync(join(fake, flag), "");
  if (state.lease) writeFileSync(join(fake, "lease"), `${state.lease} 2026-11-21T00:00:00+09:00\n`);
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE: fake, XDG_CACHE_HOME: cache, HOME: dir };
  const lines = (file: string): string[] => readFileSync(join(fake, file), "utf8").split("\n").filter(Boolean);
  const run = (args: readonly string[] = ["--once"]) => {
    const result = spawnSync("bash", [script, ...args], { encoding: "utf8", timeout: 30_000, env });
    expect(result.error).toBeUndefined();
    return result;
  };
  const vmCalls = (): string[] => lines("calls").filter((call) => /^(winvm (reset|start|release)|fence )/.test(call));
  return { run, env, lines, vmCalls, lockFile: join(cache, "winvm-runner", "launcher.lock"), leaseHeld: () => existsSync(join(fake, "lease")) };
}

describe.skipIf(process.platform === "win32")("winvm-runner.sh", () => {
  it("fences and resets winvm before the job and after it, offers it only while its runner listens, and frees it", () => {
    const { run, lines, vmCalls, leaseHeld } = setup({ services: 1 });
    const result = run();
    expect(result.status).toBe(0);
    // the snapshot's other runner service is stopped before each reset, which brings it back, and again right after the
    // reset, before this runner registers: it stays stopped for the round
    expect(vmCalls()).toEqual(["fence 0 0", "winvm reset", "winvm start", "fence 0 0", "fence 0 0", "winvm reset", "winvm start", "winvm release"]);
    const calls = lines("calls");
    const registered = calls.findIndex((call) => call.includes("Invoke-InSession"));
    expect(calls.slice(calls.indexOf("winvm start"), registered).some((call) => call.startsWith("fence "))).toBe(true);
    const marks = lines("marks").map((line) => line.slice("mark ".length));
    const offered = marks.findIndex((mark) => /^[1-9]\d{9}$/.test(mark));
    expect(offered).toBeGreaterThanOrEqual(0);
    expect(marks.indexOf("0", offered)).toBeGreaterThan(offered);
    expect(marks.at(-1)).toBe("0");
    expect(lines("deleted")).toEqual(["deleted"]);
    expect(leaseHeld()).toBe(false);
  });

  it("waits out the routes that read its last offer before it reads the queue and stops", () => {
    const { run, lines } = setup();
    expect(run().status).toBe(0);
    const sleeps = lines("sleeps").map(Number);
    expect(sleeps.some((seconds) => seconds >= 300)).toBe(true);
    const calls = lines("calls");
    const lastRound = calls.map((call) => call.includes("Invoke-InSession")).lastIndexOf(true);
    expect(calls.findIndex((call) => call.includes("runs?status=queued"))).toBeGreaterThan(lastRound);
  });

  it("hands the registration token over stdin, never in a command line", () => {
    const { run, lines, env } = setup();
    expect(run().status).toBe(0);
    expect(readFileSync(join(env.FAKE, "token"), "utf8")).toBe("SECRET-TOKEN\n");
    expect(lines("calls").filter((call) => call.includes("SECRET-TOKEN"))).toEqual([]);
  });

  // each walks the hour of fencing (sleep is a no-op); the VM was never touched, so the lease goes back as it was
  for (const [why, state] of [
    ["the VM does not answer", { flags: ["unreachable"] }],
    ["a fence answers 0 0 but its ssh failed", { flags: ["fence-lies"] }],
    ["another runner in it stays in a job", { workers: 1, services: 1 }],
  ] as const) {
    it(`resets nothing and fails while ${why}`, () => {
      const { run, lines, leaseHeld } = setup(state);
      const result = run();
      expect(result.status).toBe(1);
      expect(lines("resets")).toEqual([]);
      expect(lines("rounds")).toEqual([]);
      expect(leaseHeld()).toBe(false);
      expect(result.stdout).toContain("winvm was not shown free of jobs; not resetting it");
    }, 15_000);
  }

  it("keeps the lease and fails when after the job another runner stays in one", () => {
    const { run, lines, leaseHeld } = setup({ flags: ["workers-after-job"] });
    const result = run();
    expect(result.status).toBe(1);
    expect(lines("rounds")).toHaveLength(1);
    expect(lines("resets")).toHaveLength(1);
    expect(leaseHeld()).toBe(true);
    expect(result.stdout).toContain("winvm was not reset; the lease stays with ci-winvm-runner");
  }, 15_000);

  it("keeps the lease and fails while its own job still runs in the VM after the ssh that watched it ended", () => {
    const { run, lines, leaseHeld } = setup({ flags: ["own-job-after-round"] });
    const result = run();
    expect(result.status).toBe(1);
    expect(lines("rounds")).toHaveLength(1);
    expect(lines("resets")).toHaveLength(1);
    expect(leaseHeld()).toBe(true);
    expect(result.stdout).toContain("winvm was not reset; the lease stays with ci-winvm-runner");
  }, 15_000);

  it("keeps the lease and fails when its fence stopped a service but another stays in a job", () => {
    const { run, lines, leaseHeld } = setup({ workers: 1, services: 2 });
    const result = run();
    expect(result.status).toBe(1);
    expect(lines("rounds")).toEqual([]);
    expect(lines("resets")).toEqual([]);
    expect(leaseHeld()).toBe(true);
    expect(result.stdout).toContain("winvm was not reset; the lease stays with ci-winvm-runner");
  }, 15_000);

  it("fails when its round's session failed, and still resets and frees the VM", () => {
    const { run, lines, leaseHeld } = setup({ flags: ["session-fails"] });
    const result = run();
    expect(result.status).toBe(1);
    expect(lines("rounds")).toHaveLength(1);
    expect(lines("resets")).toHaveLength(2);
    expect(leaseHeld()).toBe(false);
  });

  it("fails when it cannot read whether its runner is still registered", () => {
    const { run, leaseHeld } = setup({ flags: ["runners-unreadable"] });
    const result = run();
    expect(result.status).toBe(1);
    expect(leaseHeld()).toBe(false);
    expect(result.stdout).toContain("runner ovis-winvm may still be registered");
  });

  it("keeps the lease and fails when the reset after the job fails", () => {
    const { run, lines, leaseHeld } = setup({ flags: ["reset-fails-after-job"] });
    const result = run();
    expect(result.status).toBe(1);
    expect(lines("rounds")).toHaveLength(1);
    expect(lines("resets")).toHaveLength(2);
    expect(lines("calls")).not.toContain("winvm release");
    expect(leaseHeld()).toBe(true);
  });

  it("keeps the lease and fails when winvm status fails after the job, or the release fails", () => {
    const status = setup({ flags: ["status-fails-after-job"] });
    const stopped = status.run();
    expect(stopped.status).toBe(1);
    expect(status.lines("resets")).toHaveLength(1);
    expect(status.leaseHeld()).toBe(true);
    expect(stopped.stdout).toContain("winvm was not reset; the lease stays with ci-winvm-runner");
    const release = setup({ flags: ["release-fails"] });
    const result = release.run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("winvm release failed");
  });

  it("neither resets nor keeps a VM it never touched, and fails when its round failed", () => {
    const { run, lines, leaseHeld } = setup({ flags: ["package-fails"] });
    const result = run();
    expect(result.status).toBe(1);
    expect(lines("resets")).toEqual([]);
    expect(lines("rounds")).toEqual([]);
    expect(lines("calls")).toContain("winvm release");
    expect(leaseHeld()).toBe(false);
  });

  it("takes no job and neither resets nor releases a VM a lane holds", () => {
    const { run, lines, leaseHeld } = setup({ lease: "some-lane" });
    const result = run();
    expect(result.status).toBe(0);
    expect(lines("resets")).toEqual([]);
    expect(lines("rounds")).toEqual([]);
    expect(lines("calls")).not.toContain("winvm release");
    expect(leaseHeld()).toBe(true);
    expect(result.stdout).toContain("winvm: busy, leased by some-lane");
  });

  for (const [why, state] of [
    ["was queued for its label", { queued: 1 }],
    ["is queued only after its route's Detect changes ends", { flags: ["late-job"] }],
    ["is queued while the first queue read fails", { queued: 1, flags: ["queue-fails-once"] }],
  ] as const) {
    it(`serves a job that ${why} before it stops`, () => {
      const { run, lines, env } = setup(state);
      expect(run().status).toBe(0);
      expect(lines("rounds")).toHaveLength(2);
      expect(readFileSync(join(env.FAKE, "queued"), "utf8").trim()).toBe("0");
    });
  }

  it("fails, saying what to do, when jobs still wait after three more rounds, as a unit stopped in a round too", () => {
    for (const [args, flags] of [[["--once"], []], [[], ["stop-in-round"]]] as const) {
      const { run, lines } = setup({ queued: 9, flags });
      const result = run(args);
      expect(result.status).toBe(1);
      expect(lines("rounds")).toHaveLength(4);
      expect(result.stdout).toContain("cancel it and re-run all jobs of its run");
    }
  });

  it("refuses to run beside another copy", async () => {
    const { run, lines, lockFile } = setup();
    const holder = spawn("flock", [lockFile, "-c", "echo locked; cat >/dev/null"], { stdio: ["pipe", "pipe", "inherit"] });
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    try {
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("another copy runs");
      expect(lines("calls")).toEqual([]);
    } finally {
      holder.stdin.end();
      await new Promise((resolve) => holder.once("exit", resolve));
    }
  });
});
