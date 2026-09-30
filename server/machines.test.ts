import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeProgress } from "../src/lib/bridgeProgress.ts";
import type { SetupJob } from "../shared/machines.ts";
import { paneNotificationTag } from "../shared/notify-policy.ts";
import { machinePath, paneStorageId } from "../shared/machines.ts";
import { canSendSecret, sameOrigin, shellQuote, validateTarget } from "./machine-security.ts";
import { handleMachineRequest, MACHINE_PROXY_PATH } from "./machine-api.ts";
import { hostProbeError, MachineManager, UNSUPPORTED_HOST } from "./machines.ts";
import { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";
import { recentSshOutput } from "./ssh.ts";

describe("machine boundaries", () => {
  it("separates equal pane IDs while preserving historical local storage", () => {
    expect(paneStorageId("local", "p:1")).toBe("p:1");
    expect(new Set(["local", "one", "two"].map((id) => paneStorageId(id, "p:1"))).size).toBe(3);
    expect(paneNotificationTag("p:1", "one")).not.toBe(paneNotificationTag("p:1", "two"));
    expect(machinePath("pc/name", "pane/image")).toBe("/api/machines/pc%2Fname/pane/image");
  });
  it("rejects shell and SSH-option injection in user-controlled target fields", () => {
    for (const destination of ["-oProxyCommand=touch /tmp/no", "host;id", "x\ny", "$(id)", "user@host -p 22", ""]) expect(() => validateTarget({ destination })).toThrow();
    expect(validateTarget({ destination: "user@[::1]", port: 2222, session: "work" }).port).toBe(2222);
    for (const session of ["../default", "$(id)", "work;id"]) expect(() => validateTarget({ destination: "host", session })).toThrow();
    const value = "a'$(touch /tmp/no)";
    expect(Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`]).stdout.toString()).toBe(value);
  });
  it("rejects cross-origin controls and limits secret submission to secure origins", () => {
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://evil.test" } }))).toBe(false);
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://localhost:7317" } }))).toBe(true);
    expect(canSendSecret(new Request("http://192.0.2.1/api/machines"))).toBe(false);
    expect(canSendSecret(new Request("https://app.example/api/machines"))).toBe(true);
    expect(canSendSecret(new Request("http://127.0.0.1/api/machines"))).toBe(true);
  });
  it("proxies only pane/workspace data and never remote management credentials", () => {
    for (const path of ["auth", "push", "updates/install", "machines/setup", "bridge", "../auth", "pane/../../auth", "pane/prompt/answer/extra"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
    for (const path of ["session", "agents", "pane/files", "pane/image", "pane/prompt/answer", "workspace/create"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
  });
});

// A setup job placed directly in the manager: driving a whole setup needs a real SSH host, but
// action() and stage() are the code that decides what the dialog shows.
type TestJob = { public: SetupJob; abort: AbortController; timer: ReturnType<typeof setTimeout>; stageStartedAt: number; pending?: { resolve(value: string): void; reject(error: Error): void }; update: boolean; auto: boolean; finished: Promise<void> };
describe("setup job labels", () => {
  const dirs: string[] = [];
  const managers: MachineManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function fixture(phase: SetupJob["phase"], step: string, challenge: SetupJob["challenge"] = null) {
    const dir = mkdtempSync(join(tmpdir(), "herdr-machines-"));
    dirs.push(dir);
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker);
    managers.push(manager);
    const job: TestJob = {
      public: { id: "job", machine_id: "machine", target: { destination: "pc" }, phase, step, challenge, installations: [], error: null, ssh_output: null, progress: null },
      abort: new AbortController(), timer: setTimeout(() => {}, 0), stageStartedAt: Date.now(), update: false, auto: false, finished: Promise.resolve(),
    };
    clearTimeout(job.timer);
    job.pending = { resolve: () => {}, reject: () => {} };
    (manager as unknown as { jobs: Map<string, TestJob> }).jobs.set("job", job);
    const drive = manager as unknown as { stage(job: TestJob, phase: SetupJob["phase"], step: string): void; progress(job: TestJob, stage: "download" | "upload" | "install" | "restart", done: number, total: number | null): void };
    return { manager, job, drive };
  }

  it("drops the review heading as soon as an approval is given", () => {
    const { manager, job } = fixture("approval", "Review the changes on this PC");
    manager.action("job", { action: "approve" });
    expect(manager.job("job")?.phase).toBe("installing");
    expect(manager.job("job")?.step).not.toBe("Review the changes on this PC");
    expect(job.public.step).toBe("Installing on this PC…");
  });

  it("drops the SSH question's heading as soon as it is answered", () => {
    for (const [step, kind] of [["Verify the server fingerprint", "host_key"], ["SSH authentication required", "secret"]] as const) {
      const { manager } = fixture("authentication", step, { id: "c1", kind, prompt: "?" });
      manager.action("job", { action: "answer", challenge_id: "c1", answer: kind === "host_key" ? "yes" : "pw" });
      expect(manager.job("job")?.phase).toBe("connecting");
      expect(manager.job("job")?.step).not.toBe(step);
    }
  });

  it("labels the first start of a bridge as its own step, not as a restart", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.progress(job, "install", 0, null);
    drive.stage(job, "starting", "Starting the remote bridge…");
    expect(manager.job("job")?.step).toBe("Starting the remote bridge…");
    expect(manager.job("job")?.progress).toBeNull();
    expect(describeProgress(manager.job("job")?.progress)).toBeNull();
  });

  it("keeps the restart label for the restart of a bridge update", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.stage(job, "starting", "Restarting the verified remote bridge…");
    drive.progress(job, "restart", 0, null);
    expect(describeProgress(manager.job("job")?.progress)?.label).toBe("Restarting the bridge");
  });

  it("shows a step without byte progress by its own text, not the previous stage's label", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.progress(job, "install", 0, null);
    expect(describeProgress(manager.job("job")?.progress)?.label).toBe("Verifying and installing");
    drive.stage(job, "installing", "Registering the app SSH key…");
    expect(manager.job("job")?.progress).toBeNull();
    expect(describeProgress(manager.job("job")?.progress)).toBeNull();
  });
});

describe("SSH output during setup", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  /** A PC whose ssh prints a line and then waits for the user, like Tailscale SSH's browser check. */
  function waitingSsh(script: string): MachineManager {
    const root = mkdtempSync(join(tmpdir(), "herdr-ssh-output-"));
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", bin]);
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    const manager = new MachineManager(join(root, "state"), {} as PushService, new CompletionTracker(null));
    // stop() cancels the job, which kills the fake ssh (it `exec`s sleep, so there is no orphan)
    cleanups.push(() => { manager.stop(); process.env["PATH"] = path; rmSync(root, { recursive: true, force: true }); });
    return manager;
  }
  async function until<T>(read: () => T | undefined | null | false): Promise<T> {
    for (let i = 0; i < 100; i += 1) { const value = read(); if (value) return value; await Bun.sleep(50); }
    throw new Error("timed out");
  }

  it("shows what ssh printed while it is still waiting, and drops it once the setup is cancelled", async () => {
    const manager = waitingSsh(`echo "To authenticate, visit: https://login.tailscale.com/a/check123" >&2\nexec sleep 30`);
    const started = manager.setup({ destination: "check-pc" });
    expect(started.ssh_output).toBeNull();
    const job = await until(() => manager.job(started.id)?.ssh_output ? manager.job(started.id) : null);
    expect(job.phase).toBe("connecting");
    expect(job.ssh_output).toBe("To authenticate, visit: https://login.tailscale.com/a/check123");
    // the dialog polls this route: the line has to be in its answer, not only on the manager
    const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/setup/${started.id}`, { headers: { origin: "http://localhost:7317" } }), manager);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "connecting", ssh_output: "To authenticate, visit: https://login.tailscale.com/a/check123" });
    manager.action(started.id, { action: "cancel" });
    expect(manager.job(started.id)).toMatchObject({ phase: "cancelled", ssh_output: null });
  });

  it("keeps only the recent lines, without terminal control characters", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(recentSshOutput(lines).split("\n")).toEqual(["line 12", "line 13", "line 14", "line 15", "line 16", "line 17", "line 18", "line 19"]);
    expect(recentSshOutput("\x1b[31mred\x1b[0m\r\n\n  \nspinner\rdone\x07\n")).toBe("red\nspinner\ndone");
    expect(recentSshOutput("x".repeat(5000)).length).toBe(2048);
    expect(recentSshOutput("")).toBe("");
  });
});

describe("host probe", () => {
  it("names Windows hosts as unsupported when cmd or PowerShell cannot find sh", () => {
    const cmd = "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.";
    const pwsh = "sh : The term 'sh' is not recognized as a name of a cmdlet, function, script file, or executable program.";
    expect(hostProbeError(new Error(cmd)).message).toBe(UNSUPPORTED_HOST);
    expect(hostProbeError(new Error(pwsh)).message).toBe(UNSUPPORTED_HOST);
    expect(UNSUPPORTED_HOST).toContain("Windows hosts are not supported yet");
  });
  it("keeps any other probe failure as it was", () => {
    const error = new Error("ssh: connect to host pc port 22: Connection refused");
    expect(hostProbeError(error)).toBe(error);
  });
});
