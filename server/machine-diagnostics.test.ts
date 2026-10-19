import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { HerdrError } from "./herdr/client.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { SshConnection } from "./ssh.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

it("logs local roster failures and one recovery without copying the UI error into the log", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-machine-diagnostic-"));
  let failing = false;
  const snapshot = { protocol: 22, version: "fixture", panes: [], workspaces: [], tabs: [], layouts: [], agents: [] } as SessionSnapshot;
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  const push = { seed() {}, async onStatus() {}, async onEnded() {} } as unknown as PushService;
  const manager = new MachineManager(root, push, new CompletionTracker(null), async () => {
    if (failing) throw new HerdrError("timeout", "private-host/private-socket private-token");
    return snapshot;
  });
  cleanups.push(() => { manager.stop(); warn.mockRestore(); rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 1000;
  while (manager.list()[0]?.state !== "connected") {
    if (Date.now() > deadline) throw new Error("initial local snapshot did not finish");
    await Bun.sleep(5);
  }
  expect(lines).toHaveLength(0);
  failing = true;
  await manager.refreshLocal();
  await manager.refreshLocal();
  expect(manager.list()[0]).toMatchObject({ state: "error", error: "private-host/private-socket private-token" });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: "machine.local.failed", operation: "snapshot", code: "timeout" });
  failing = false;
  await manager.refreshLocal();
  await manager.refreshLocal();
  expect(manager.list()[0]).toMatchObject({ state: "connected", error: null });
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]!)).toMatchObject({ event: "machine.local.recovered", failures: 2, suppressed: 1, episode_id: JSON.parse(lines[0]!).episode_id });
  expect(lines.join("\n")).not.toContain("private-");
  expect(lines.join("\n")).not.toContain(root);
});

async function setupFixture(registered = false) {
  const root = mkdtempSync(join(tmpdir(), "herdr-setup-diagnostic-"));
  const id = "00000000-0000-4000-8000-000000000001";
  if (registered) writeFileSync(join(root, "machines.json"), JSON.stringify([{ id, name: "private-host", enabled: false, target: { destination: "private-host" }, snapshot: null }]));
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  const start = spyOn(SshConnection.prototype, "start").mockRejectedValue(new Error("private-host/private-path private-credential"));
  const close = spyOn(SshConnection.prototype, "close").mockImplementation(() => {});
  const snapshot = { protocol: 22, version: "fixture", panes: [], workspaces: [], tabs: [], layouts: [], agents: [] } as SessionSnapshot;
  const push = { seed() {}, async onStatus() {}, async onEnded() {} } as unknown as PushService;
  const manager = new MachineManager(root, push, new CompletionTracker(null), async () => snapshot);
  cleanups.push(() => { manager.stop(); start.mockRestore(); close.mockRestore(); warn.mockRestore(); rmSync(root, { recursive: true, force: true }); });
  type Runtime = { machine: { enabled: boolean }; retry?: ReturnType<typeof setTimeout>; endpoint?: { url: string; token: string }; ssh?: { close(): void } };
  const drive = manager as unknown as { jobs: Map<string, { finished: Promise<void> }>; machines: Map<string, Runtime>; observe(runtime: Runtime): Promise<void> };
  if (registered) drive.machines.get(id)!.machine.enabled = true;
  const records = () => lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).filter((record) => record.event.startsWith("machine.remote."));
  return { manager, drive, id, start, snapshot, lines, records };
}

it("records first-time SSH setup failures without exposing the SSH diagnostic", async () => {
  const f = await setupFixture();
  const job = f.manager.setup({ destination: "private-host" });
  await f.drive.jobs.get(job.id)!.finished;
  expect(f.manager.job(job.id)?.phase).toBe("failed");
  expect(f.records()).toHaveLength(1);
  expect(f.records()[0]).toMatchObject({ event: "machine.remote.failed", code: "connection_lost", machine_id: job.machine_id });
  expect(f.lines.join("\n")).not.toContain("private-");
});

it("records a failed SSH update and recovery when that registered machine's bridge returns", async () => {
  const f = await setupFixture(true);
  const job = f.manager.updateBridge(f.id);
  await f.drive.jobs.get(job.id)!.finished;
  expect(f.records()).toHaveLength(1);
  expect(f.records()[0]).toMatchObject({ event: "machine.remote.failed", machine_id: f.id });
  const bridge = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request, server) {
      if (new URL(request.url).pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      return Response.json({ snapshot: f.snapshot });
    },
    websocket: { message() {} },
  });
  cleanups.push(() => bridge.stop(true));
  const runtime = f.drive.machines.get(f.id)!;
  clearTimeout(runtime.retry);
  runtime.endpoint = { url: `http://127.0.0.1:${bridge.port}`, token: "private-bridge-credential" };
  runtime.ssh = { close() {} };
  await f.drive.observe(runtime);
  const deadline = Date.now() + 1000;
  while (f.records().length < 2) {
    if (Date.now() > deadline) throw new Error("bridge recovery was not observed");
    await Bun.sleep(5);
  }
  expect(f.records()[1]).toMatchObject({ event: "machine.remote.recovered", machine_id: f.id, episode_id: f.records()[0].episode_id });
  expect(f.lines.join("\n")).not.toContain("private-");
});

it("does not diagnose a user-cancelled SSH setup as a connection failure", async () => {
  const f = await setupFixture();
  let reject!: (error: Error) => void;
  f.start.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const job = f.manager.setup({ destination: "private-host" });
  f.manager.action(job.id, { action: "cancel" });
  reject(new Error("private-cancelled-SSH-diagnostic"));
  await f.drive.jobs.get(job.id)!.finished;
  expect(f.manager.job(job.id)?.phase).toBe("cancelled");
  expect(f.records()).toHaveLength(0);
});
