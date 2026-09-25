import { authenticatedWebSocket } from "./remote-websocket.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as tcpServer } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, LOCAL_MACHINE, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type Machine, type MachineAction, type MachineEvent, type MachineSettings, type SetupAction, type SetupJob, type SetupProgress, type SetupRequest, type SshTarget } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import type { PushService } from "./push.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import { labelOmoPanes } from "./conversation.ts";
import { shellQuote, validateTarget } from "./machine-security.ts";
import { BUNDLE_DIR, installBundle, REMOTE_PATH } from "./remote-bundle.ts";
import { SshConnection } from "./ssh.ts";

interface StoredMachine { id: string; name: string; target: SshTarget; enabled: boolean; snapshot?: SessionSnapshot | null }
interface Runtime {
  machine: Machine;
  ssh?: SshConnection;
  endpoint?: { url: string; token: string };
  observer?: WebSocket;
  retry?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
  abort?: AbortController;
  attempts: number;
  generation: number;
  refreshing: boolean;
  terminals: Set<() => void>;
}
interface JobState {
  update: boolean;
  /** started by the server for a PC whose bridge is out of date: key-only SSH, approval already given */
  auto: boolean;
  public: SetupJob;
  abort: AbortController;
  pending?: { resolve(value: string): void; reject(error: Error): void };
  ssh?: SshConnection;
  timer: ReturnType<typeof setTimeout>;
  /** the registered PC a bridge update is for, which shows it as `updating` */
  runtime?: Runtime;
  stageStartedAt: number;
  finished: Promise<void>;
}
const DEFAULT_SETTINGS: MachineSettings = { auto_update_bridges: true };

async function freePort(): Promise<number> {
  const server = tcpServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A connection that retrying cannot fix: the PC waits for the user instead of reconnecting. */
export class MachineActionRequired extends Error {
  constructor(message: string, readonly action: MachineAction) { super(message); }
}

export class MachineManager {
  private machines = new Map<string, Runtime>();
  private jobs = new Map<string, JobState>();
  private listeners = new Set<(event: MachineEvent) => void>();
  private stopped = false;
  private localBusy = false;
  private localTimer: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private statePath: string;
  private sshDir: string;
  private local: Machine = { id: LOCAL_MACHINE, name: hostname(), kind: "local", enabled: true, state: "connecting", error: null, snapshot: null };
  private settingsPath: string;
  private preferences: MachineSettings = { ...DEFAULT_SETTINGS };
  /** automatic bridge updates run one at a time: they share one bundle download */
  private autoChain: Promise<void> = Promise.resolve();
  private autoQueued = new Set<string>();
  private emitTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly stateDir: string, private push: PushService) {
    this.statePath = join(stateDir, "machines.json");
    this.sshDir = join(stateDir, "ssh");
    this.settingsPath = join(stateDir, "machine-settings.json");
    try {
      const saved: unknown = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      if (saved && typeof saved === "object" && typeof (saved as MachineSettings).auto_update_bridges === "boolean") this.preferences.auto_update_bridges = (saved as MachineSettings).auto_update_bridges;
    } catch { /* absent or unreadable: the defaults */ }
    if (existsSync(this.statePath)) {
      const saved: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (!Array.isArray(saved)) throw new Error("Invalid machines.json; registrations were preserved");
      for (const item of saved as StoredMachine[]) {
        if (!/^[a-f0-9-]{36}$/.test(item.id) || typeof item.name !== "string" || typeof item.enabled !== "boolean") throw new Error("Invalid machine registration");
        const machine: Machine = { id: item.id, name: item.name, kind: "ssh", enabled: item.enabled, target: validateTarget(item.target), state: "disconnected", snapshot: item.snapshot ?? null, error: null };
        const runtime = this.runtime(machine);
        this.machines.set(item.id, runtime);
        if (item.enabled) queueMicrotask(() => void this.reconnect(runtime));
      }
    }
    void this.refreshLocal();
    this.localTimer = setInterval(() => void this.refreshLocal(), 5000);
    this.localTimer.unref();
  }
  private runtime(machine: Machine): Runtime { return { machine, attempts: 0, generation: 0, refreshing: false, terminals: new Set() }; }
  list(): Machine[] { return [this.local, ...[...this.machines.values()].map((r) => r.machine)]; }
  subscribe(listener: (event: MachineEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "machines", machines: this.list() });
    return () => this.listeners.delete(listener);
  }
  private emit(event?: MachineEvent): void {
    if (this.stopped) return;
    for (const listener of this.listeners) listener(event ?? { type: "machines", machines: this.list() });
  }
  localMessage(message: ServerMessage): void {
    this.emit({ type: "machine-message", machine_id: LOCAL_MACHINE, message });
    if (message.type === "pane-status" && this.local.snapshot) {
      this.local.snapshot = { ...this.local.snapshot, panes: this.local.snapshot.panes.map((p) => p.pane_id === message.pane_id ? { ...p, agent_status: message.agent_status } : p) };
    }
    if (message.type === "session-changed" || message.type === "pane-exited") void this.refreshLocal();
  }
  async refreshLocal(): Promise<void> {
    if (this.localBusy || this.stopped) return;
    this.localBusy = true;
    try { this.local.snapshot = await labelOmoPanes(await sessionSnapshot()); this.local.state = "connected"; this.local.error = null; }
    catch (e) { this.local.state = "error"; this.local.error = String(e instanceof Error ? e.message : e); }
    finally { this.localBusy = false; this.emit(); }
  }
  private saveSoon(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; if (!this.stopped) { try { this.persist(); } catch (e) { console.error("PC state could not be saved:", e instanceof Error ? e.message : "write failed"); } } }, 1000);
    this.saveTimer.unref();
  }
  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const data: StoredMachine[] = [...this.machines.values()].map(({ machine: m }) => ({ id: m.id, name: m.name, target: m.target!, enabled: m.enabled, snapshot: m.snapshot }));
    const tmp = this.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600); renameSync(tmp, this.statePath);
  }
  job(id: string): SetupJob | undefined { return this.jobs.get(id)?.public; }
  settings(): MachineSettings { return { ...this.preferences }; }
  updateSettings(patch: Record<string, unknown>): MachineSettings {
    if (patch["auto_update_bridges"] !== undefined) {
      if (typeof patch["auto_update_bridges"] !== "boolean") throw new Error("auto_update_bridges must be boolean");
      this.preferences.auto_update_bridges = patch["auto_update_bridges"];
    }
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = this.settingsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.preferences), { mode: 0o600 });
    renameSync(tmp, this.settingsPath);
    return this.settings();
  }
  /**
   * Update a PC's bridge now, without a dialog: the tap (or the app update) is the approval,
   * and SSH uses the PC's saved key only. A PC that needs a password fails with the reason,
   * and its dialog stays the way in.
   */
  updateBridge(id: string): SetupJob {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    return this.setup({ ...runtime.machine.target!, machine_id: id, update_remote: true }, { auto: true });
  }
  setup(request: SetupRequest, options: { auto?: boolean } = {}): SetupJob {
    if (this.stopped) throw new Error("Server stopping");
    const target = validateTarget(request);
    if (request.name !== undefined && (typeof request.name !== "string" || request.name.length > 100)) throw new Error("PC name must be at most 100 characters");
    if ([...this.jobs.values()].filter((j) => !["connected", "failed", "cancelled"].includes(j.public.phase)).length >= 4) throw new Error("Finish or cancel the current connection jobs first");
    const existing = request.machine_id ? this.machines.get(request.machine_id) : undefined;
    if (request.machine_id && !existing) throw new Error("PC not found");
    if (existing && [...this.jobs.values()].some((j) => j.public.machine_id === existing.machine.id && !["connected", "failed", "cancelled"].includes(j.public.phase))) throw new Error("A connection job for this PC is already running");
    const id = randomUUID();
    const machineId = existing?.machine.id ?? randomUUID();
    const auto = options.auto === true && request.update_remote === true && !!existing;
    const job: JobState = { update: request.update_remote === true, auto, public: { id, machine_id: machineId, target, phase: "connecting", step: "Connecting with SSH keys and ssh-agent…", challenge: null, installations: [], error: null, progress: null }, abort: new AbortController(), timer: setTimeout(() => this.cancelJob(id), 600_000), stageStartedAt: Date.now(), finished: Promise.resolve() };
    if (job.update && existing) job.runtime = existing;
    job.timer.unref();
    this.jobs.set(id, job);
    if (this.jobs.size > 40) for (const [key, j] of this.jobs) if (["connected", "failed", "cancelled"].includes(j.public.phase) && key !== id) { this.jobs.delete(key); break; }
    const runtime = existing ?? this.runtime({ id: machineId, name: request.name?.trim() || target.destination, kind: "ssh", enabled: true, state: "connecting", target, snapshot: null, error: null });
    this.disconnect(runtime);
    runtime.machine.target = target;
    const ssh = new SshConnection(target, this.sshDir, join(this.sshDir, machineId));
    job.ssh = ssh;
    runtime.ssh = ssh;
    runtime.abort = job.abort;
    const generation = ++runtime.generation;
    this.showUpdate(job);
    job.finished = (async () => {
      try {
        // an automatic update never asks: a PC that needs a password says so and waits
        await ssh.start(auto ? undefined : (prompt, host) => {
          job.public.phase = "authentication";
          job.public.challenge = { id: randomUUID(), kind: host ? "host_key" : "secret", prompt };
          job.public.step = host ? "Verify the server fingerprint" : "SSH authentication required";
          return this.wait(job);
        });
        this.stage(job, "checking", "Checking the remote environment…");
        await this.prepare(runtime, job);
        if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
        runtime.machine.enabled = true;
        this.machines.set(machineId, runtime);
        await this.observe(runtime);
        this.persist();
        this.stage(job, "connected", "Connected");
        this.emit();
      } catch (e) {
        const ownsRuntime = runtime.generation === generation;
        if (ownsRuntime) this.disconnect(runtime);
        if (job.public.phase !== "cancelled") {
          job.public.phase = "failed"; job.public.step = "Connection failed";
          job.public.error = e instanceof Error ? e.message : String(e);
          // a failed bridge update keeps its button: the bridge is still out of date, and the
          // error says why this attempt failed (no network, a password needed, …)
          if (ownsRuntime) { runtime.machine.state = "error"; runtime.machine.error = job.public.error; runtime.machine.action_required = e instanceof MachineActionRequired ? e.action : job.update && existing ? "update_bridge" : null; }
          this.emit();
        }
      } finally {
        clearTimeout(job.timer); job.public.challenge = null; job.pending = undefined; job.ssh = undefined;
        if (job.runtime) { job.runtime.machine.updating = null; this.emit(); }
      }
    })();
    return job.public;
  }
  private stage(job: JobState, phase: SetupJob["phase"], step: string): void {
    if (job.abort.signal.aborted) throw new Error("Setup cancelled");
    job.public.phase = phase; job.public.step = step; job.public.challenge = null;
    // approved: from here on the install's own timeouts apply, not the setup's 10 minutes
    if (phase === "installing") clearTimeout(job.timer);
    if (phase === "starting") this.progress(job, "restart", 0, null);
    this.showUpdate(job);
  }
  /** A stage's bytes so far; a new stage restarts the clock its rate is measured on. */
  private progress(job: JobState, stage: SetupProgress["stage"], done: number, total: number | null): void {
    const now = Date.now();
    if (job.public.progress?.stage !== stage) job.stageStartedAt = now;
    const elapsed = now - job.stageStartedAt;
    job.public.progress = { stage, done, total, rate: elapsed >= 500 && done > 0 ? Math.round(done / (elapsed / 1000)) : null, elapsed_ms: elapsed };
    this.showUpdate(job);
  }
  /** Mirror a bridge update onto its PC, so the sidebar and header show it without the dialog. */
  private showUpdate(job: JobState): void {
    if (!job.runtime) return;
    job.runtime.machine.updating = { job_id: job.public.id, step: job.public.step, progress: job.public.progress ?? null };
    // progress arrives per chunk: a few events a second are plenty
    if (!this.emitTimer) { this.emitTimer = setTimeout(() => { this.emitTimer = undefined; this.emit(); }, 250); this.emitTimer.unref(); }
  }
  private wait(job: JobState): Promise<string> {
    if (job.abort.signal.aborted) return Promise.reject(new Error("Setup cancelled"));
    return new Promise((resolve, reject) => { job.pending = { resolve, reject }; });
  }
  action(id: string, action: SetupAction): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Setup job not found");
    if (action.action === "cancel") { this.cancelJob(id); return; }
    if (!job.pending) throw new Error("This setup step has already changed");
    if (action.action === "approve") {
      if (job.public.phase !== "approval") throw new Error("No installation is awaiting approval");
    } else if (action.action === "answer") {
      if (!job.public.challenge || action.challenge_id !== job.public.challenge.id) throw new Error("SSH question changed; read it again");
      if (typeof action.answer !== "string" || action.answer.length > 4096 || /[\r\n\0]/.test(action.answer)) throw new Error("Invalid SSH response");
      if (job.public.challenge.kind === "host_key" && !["yes", "no"].includes(action.answer)) throw new Error("Confirm or reject the fingerprint");
    } else throw new Error("Unknown setup action");
    const pending = job.pending;
    job.pending = undefined; job.public.challenge = null;
    job.public.phase = action.action === "approve" ? "installing" : "connecting";
    pending.resolve(action.action === "answer" ? action.answer : "approved");
  }
  private cancelJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job || ["connected", "failed", "cancelled"].includes(job.public.phase)) return;
    job.public.phase = "cancelled"; job.public.step = "Cancelled"; job.public.challenge = null;
    job.abort.abort(); job.pending?.reject(new Error("Setup cancelled")); job.pending = undefined;
    job.ssh?.close(); clearTimeout(job.timer);
  }
  private async prepare(runtime: Runtime, job?: JobState): Promise<void> {
    const generation = runtime.generation;
    const ssh = runtime.ssh!;
    const session = runtime.machine.target!.session;
    const inspection = await ssh.run(REMOTE_PATH + `printf '%s\\n' "$(uname -s)" "$(uname -m)" "$(cd -P "$HOME" && pwd -P)" "\${XDG_CONFIG_HOME:-$HOME/.config}" "$(command -v herdr || true)"; test -x "$HOME/${BUNDLE_DIR}/bin/bun" && printf 'bundle-ready\\n' || true; for d in "$HOME/.local/share/herdr-web-ui/remote-v"*; do if test -x "$d/bin/bun"; then printf 'bundle-older\\n'; break; fi; done; for f in "$HOME/.config/herdr-web-ui/bridges/"*.json; do test ! -f "$f" || cat "$f"; printf '\\n'; done`);
    const [os, arch, home, xdgConfig, herdrPath, ...lines] = inspection.split("\n");
    if (!home?.startsWith("/") || !["Linux", "Darwin"].includes(os ?? "") || !["x86_64", "aarch64", "arm64"].includes(arch ?? "")) throw new Error("Only Linux/macOS x64 and arm64 PCs are supported");
    const platform = `${os === "Darwin" ? "darwin" : "linux"}-${arch === "x86_64" ? "x64" : "arm64"}`;
    if (herdrPath) {
      const version = await ssh.run(`${shellQuote(herdrPath)} --version`);
      const match = /herdr (\d+)\.(\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) === 0 && Number(match[2]) < 9) throw new Error("The installed herdr is incompatible. Update it explicitly to 0.9+ before connecting; it was left unchanged.");
    }
    // the same XDG_CONFIG_HOME rule remote-entry.ts and herdr itself follow
    const herdrConfig = `${xdgConfig?.startsWith("/") ? xdgConfig : `${home}/.config`}/herdr`;
    const nominalSocket = session ? `${herdrConfig}/sessions/${session}/herdr.sock` : `${herdrConfig}/herdr.sock`;
    const expectedSocket = await ssh.run(`socket=${shellQuote(nominalSocket)}; if test -d "\${socket%/*}"; then cd -P "\${socket%/*}" && printf '%s/herdr.sock' "$PWD"; else printf '%s' "$socket"; fi`);
    const descriptors: BridgeDescriptor[] = lines.flatMap((line) => { try { const d = JSON.parse(line); return d.socket_path === expectedSocket ? [d] : []; } catch { return []; } });
    let descriptor = descriptors.find((d) => d.bridge_protocol === BRIDGE_PROTOCOL && d.bundle_version === REMOTE_BUNDLE_VERSION);
    if (job?.update && !descriptor) descriptor = descriptors[0];
    if (descriptors.length && !descriptor) throw new MachineActionRequired("This PC runs a bridge from a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    if (descriptor) {
      if (!Number.isInteger(descriptor.pid) || descriptor.pid < 1) throw new Error("Invalid bridge process identity");
      const live = await ssh.run(`kill -0 ${descriptor.pid} 2>/dev/null && printf live || true`);
      if (live !== "live") descriptor = undefined;
    }
    const hasBundle = lines.includes("bundle-ready");
    // a runtime from another bundle version and no bridge running (the PC rebooted since): an update
    if (!descriptor && !hasBundle && lines.includes("bundle-older") && !job) throw new MachineActionRequired("This PC has the bridge runtime of a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    const installs: string[] = [];
    if (job?.update) installs.push("Download and verify the bridge runtime, then restart this bridge (herdr sessions keep running)");
    if (!descriptor && !hasBundle) installs.push("Private web bridge bundle (Bun, Node and node-pty; no build tools needed)");
    if (!descriptor && !herdrPath) installs.push("Bundled herdr 0.9.1 (existing installations are preserved)");
    if (!descriptor && job) installs.push("Start the loopback bridge and, only if absent, the herdr daemon");
    if (ssh.usedSecret) installs.push("Register a dedicated SSH public key for automatic reconnection");
    if (installs.length) {
      if (!job) throw new MachineActionRequired("Remote setup needs approval. Use Reconnect / setup on this PC.", "setup");
      job.public.installations = installs;
      // an automatic bridge update was approved by the app update (or the tap that started it)
      if (!job.auto) {
        this.stage(job, "approval", "Review the changes on this PC");
        await this.wait(job);
      }
      if (job.update || !descriptor && !hasBundle) { this.stage(job, "installing", `Installing verified ${platform} bundle…`); await installBundle(ssh, platform, job.abort.signal, { cacheDir: join(this.stateDir, "bundles"), onProgress: (stage, done, total) => this.progress(job, stage, done, total) }); }
      if (ssh.usedSecret) {
        this.stage(job, "installing", "Registering the app SSH key…");
        const path = join(this.sshDir, runtime.machine.id);
        if (!existsSync(path)) {
          const keygen = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `herdr-web-ui:${runtime.machine.id}`, "-f", path], { stdout: "ignore", stderr: "pipe" });
          if (await keygen.exited !== 0) throw new Error("Could not generate the dedicated SSH key");
        }
        chmodSync(path, 0o600);
        const publicKey = readFileSync(path + ".pub", "utf8").trim();
        await ssh.run(`set -eu; umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; key=${shellQuote("no-agent-forwarding,no-X11-forwarding,no-pty " + publicKey)}; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf '\\n%s\\n' "$key" >> "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"`);
        // A separate master proves the new key actually works without a password.
        const proof = new SshConnection({ ...runtime.machine.target!, identity_file: path }, this.sshDir, path, true);
        try { await proof.start(); await proof.run("true"); } finally { proof.close(); }
      }
    }
    if (job?.update && descriptor) {
      if (!descriptor.managed_remote) throw new Error("This socket uses an independently managed web server. Update it through its own Settings; it was left running.");
      const verified = await this.verify(ssh, descriptor, expectedSocket, true);
      if (!verified.identity.managed_remote || verified.identity.pid !== descriptor.pid) throw new Error("Bridge process verification failed; no process was stopped");
      this.stage(job, "starting", "Restarting the verified remote bridge…");
      await ssh.run(`kill -TERM ${descriptor.pid}`);
      await Bun.sleep(2500);
      descriptor = undefined;
    }
    if (!descriptor) {
      if (job) this.stage(job, "starting", "Starting the remote bridge…");
      await ssh.run(REMOTE_PATH + `umask 077; mkdir -p "$HOME/.config/herdr-web-ui/bridges"; HERDR_REMOTE_SESSION=${shellQuote(session ?? "")} HERDR_WEB_HERDR_BIN=${shellQuote(herdrPath || `${home}/${BUNDLE_DIR}/bin/herdr`)} nohup "$HOME/${BUNDLE_DIR}/bin/bun" "$HOME/${BUNDLE_DIR}/server/remote-entry.ts" </dev/null >>"$HOME/.config/herdr-web-ui/bridges/bridge.log" 2>&1 &`);
      for (let i = 0; i < 40; i++) {
        if (job?.abort.signal.aborted || this.stopped) throw new Error("Setup cancelled");
        const out = await ssh.run(`for f in "$HOME/.config/herdr-web-ui/bridges/"*.json; do test ! -f "$f" || cat "$f"; printf '\\n'; done`);
        descriptor = out.split("\n").flatMap((line) => { try { const d = JSON.parse(line); return d.socket_path === expectedSocket ? [d] : []; } catch { return []; } })[0];
        if (descriptor) break;
        await Bun.sleep(250);
      }
      if (!descriptor) throw new Error("Bridge did not start. Check ~/.config/herdr-web-ui/bridges/bridge.log on the PC.");
    }
    const verified = await this.verify(ssh, descriptor, expectedSocket);
    if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
    runtime.endpoint = verified.endpoint;
    runtime.machine.herdr = verified.identity.herdr;
  }
  private async verify(ssh: SshConnection, descriptor: BridgeDescriptor, expectedSocket: string, allowOldBundle = false): Promise<{ endpoint: { url: string; token: string }; identity: BridgeIdentity }> {
    if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error("Invalid bridge credentials");
    const port = await freePort();
    await ssh.forward(port, descriptor.port);
    const endpoint = { url: `http://127.0.0.1:${port}`, token: descriptor.token };
    const response = await fetch(`${endpoint.url}/api/bridge`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Bridge verification failed (${response.status}). Reconnect after checking the remote bridge.`);
    const identity: BridgeIdentity = await response.json();
    if (identity.bridge_protocol !== BRIDGE_PROTOCOL || !allowOldBundle && identity.bundle_version !== REMOTE_BUNDLE_VERSION) throw new MachineActionRequired("This PC runs a bridge from a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    if (identity.socket_path !== expectedSocket || !identity.socket_id || identity.herdr.protocol < 22) throw new Error("Remote bridge/socket is incompatible; update it explicitly");
    return { endpoint, identity };
  }
  endpoint(id: string): { url: string; token: string } | undefined {
    const runtime = this.machines.get(id);
    return runtime?.machine.enabled && runtime.machine.state === "connected" ? runtime.endpoint : undefined;
  }
  trackTerminal(id: string, close: () => void): () => void {
    const runtime = this.machines.get(id);
    runtime?.terminals.add(close);
    return () => runtime?.terminals.delete(close);
  }
  private async refresh(runtime: Runtime): Promise<void> {
    if (!runtime.endpoint || runtime.refreshing) return;
    runtime.refreshing = true;
    const endpoint = runtime.endpoint;
    const generation = runtime.generation;
    try {
      const r = await fetch(endpoint.url + "/api/session", { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`Remote herdr unavailable (${r.status})`);
      const { snapshot } = await r.json() as { snapshot: SessionSnapshot };
      if (generation !== runtime.generation || this.stopped) return;
      runtime.machine.snapshot = snapshot; runtime.machine.error = null;
      this.saveSoon();
      this.push.seed(snapshot.panes, runtime.machine.id, runtime.machine.name);
      this.emit();
    } finally { runtime.refreshing = false; }
  }
  private async observe(runtime: Runtime): Promise<void> {
    const generation = runtime.generation;
    await this.refresh(runtime);
    if (generation !== runtime.generation || this.stopped) throw new Error("Connection cancelled");
    runtime.machine.state = "connected"; runtime.machine.action_required = null; runtime.attempts = 0;
    const endpoint = runtime.endpoint!;
    const ws = authenticatedWebSocket(endpoint.url.replace("http:", "ws:") + "/ws", endpoint.token);
    runtime.observer = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "role", mode: "observe" }));
    ws.onmessage = (event) => {
      if (generation !== runtime.generation || this.stopped) return;
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "snapshot") { runtime.machine.snapshot = message.snapshot; this.push.seed(message.snapshot.panes, runtime.machine.id, runtime.machine.name); this.emit(); }
      if (message.type === "pane-status") {
        if (runtime.machine.snapshot) runtime.machine.snapshot = { ...runtime.machine.snapshot, panes: runtime.machine.snapshot.panes.map((p) => p.pane_id === message.pane_id ? { ...p, agent_status: message.agent_status } : p) };
        void this.push.onStatus(message.pane_id, message.agent_status, runtime.machine.id).catch(() => {});
      }
      if (message.type === "pane-exited") void this.push.onEnded(message.pane_id, runtime.machine.id).catch(() => {});
      this.emit({ type: "machine-message", machine_id: runtime.machine.id, message });
      if (["pane-status", "pane-exited", "session-changed"].includes(message.type)) void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e));
    };
    ws.onclose = () => this.lost(runtime, generation, new Error("SSH bridge connection interrupted"));
    ws.onerror = () => ws.close();
    runtime.ssh!.onExit = () => this.lost(runtime, generation, new Error("SSH connection ended"));
    runtime.poll = setInterval(() => void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e)), 5000);
    runtime.poll.unref();
  }
  private lost(runtime: Runtime, generation: number, error: unknown): void {
    if (generation !== runtime.generation || !runtime.machine.enabled || this.stopped) return;
    this.disconnect(runtime);
    runtime.machine.error = error instanceof Error ? error.message : String(error);
    if (error instanceof MachineActionRequired) {
      runtime.machine.state = "error"; runtime.machine.action_required = error.action;
      this.emit();
      // SSH itself just worked without a password, so the update can run unattended
      if (error.action === "update_bridge" && this.preferences.auto_update_bridges) this.queueAutoUpdate(runtime.machine.id);
      return;
    }
    runtime.machine.state = "reconnecting";
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(runtime.attempts++, 6));
    runtime.retry = setTimeout(() => void this.reconnect(runtime), delay); runtime.retry.unref();
    this.emit();
  }
  private async reconnect(runtime: Runtime): Promise<void> {
    if (this.stopped || !runtime.machine.enabled) return;
    this.disconnect(runtime);
    runtime.machine.state = "reconnecting"; runtime.machine.action_required = null; this.emit();
    const generation = runtime.generation;
    runtime.ssh = new SshConnection(runtime.machine.target!, this.sshDir, join(this.sshDir, runtime.machine.id));
    try {
      await runtime.ssh.start(); await this.prepare(runtime);
      if (generation !== runtime.generation || this.stopped) return;
      await this.observe(runtime); this.emit();
    } catch (e) { this.lost(runtime, generation, e); }
  }
  private queueAutoUpdate(id: string): void {
    if (this.autoQueued.has(id)) return;
    this.autoQueued.add(id);
    this.autoChain = this.autoChain.then(async () => {
      const runtime = this.machines.get(id);
      // still wanted: the PC may have been updated by hand, removed or disabled meanwhile
      if (this.stopped || !runtime?.machine.enabled || runtime.machine.action_required !== "update_bridge" || !this.preferences.auto_update_bridges) return;
      if ([...this.jobs.values()].some((j) => j.public.machine_id === id && !["connected", "failed", "cancelled"].includes(j.public.phase))) return;
      const job = this.updateBridge(id);
      await this.jobs.get(job.id)?.finished;
    }).catch((e) => { console.error("Automatic bridge update failed:", e instanceof Error ? e.message : String(e)); })
      .finally(() => { this.autoQueued.delete(id); });
  }
  private disconnect(runtime: Runtime): void {
    runtime.generation++;
    clearTimeout(runtime.retry); clearInterval(runtime.poll);
    runtime.abort?.abort(); runtime.abort = undefined;
    runtime.observer?.close(); runtime.observer = undefined;
    for (const close of runtime.terminals) close(); runtime.terminals.clear();
    runtime.ssh?.close(); runtime.ssh = undefined; runtime.endpoint = undefined;
    runtime.machine.state = "disconnected";
  }
  patch(id: string, patch: { name?: unknown; enabled?: unknown }): void {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (patch.name !== undefined) { if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 100) throw new Error("Enter a PC name (1–100 characters)"); runtime.machine.name = patch.name.trim(); }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
      runtime.machine.enabled = patch.enabled;
      this.disconnect(runtime);
      for (const [id, job] of this.jobs) if (job.public.machine_id === runtime.machine.id) this.cancelJob(id);
      if (patch.enabled) void this.reconnect(runtime);
    }
    this.persist(); this.emit();
  }
  remove(id: string): void {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    runtime.machine.enabled = false; this.disconnect(runtime);
    for (const [jobId, job] of this.jobs) if (job.public.machine_id === id) this.cancelJob(jobId);
    this.machines.delete(id); this.persist();
    for (const suffix of ["", ".pub"]) try { unlinkSync(join(this.sshDir, id + suffix)); } catch {}
    this.emit();
  }
  stop(): void {
    this.stopped = true; clearInterval(this.localTimer); clearTimeout(this.saveTimer);
    for (const id of this.jobs.keys()) this.cancelJob(id);
    for (const runtime of this.machines.values()) this.disconnect(runtime);
    this.listeners.clear();
  }
}
