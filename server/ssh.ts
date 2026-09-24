import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SshTarget } from "../shared/machines.ts";
import { shellQuote } from "./machine-security.ts";
import { chunksOf } from "./remote-bundle.ts";

/** A file streamed to a remote command's stdin, with how much of it went so far. */
export interface StreamInput { path: string; onProgress?(done: number): void; onUploaded?(): void }

export class SshConnection {
  private dir = mkdtempSync(join(tmpdir(), "herdr-ssh-"));
  private control = join(this.dir, "control");
  private master: ReturnType<typeof Bun.spawn> | null = null;
  private children = new Set<ReturnType<typeof Bun.spawn>>();
  private closed = false;
  private askSockets = new Set<Socket>();
  private askServer = createServer();
  private stderr = "";
  usedSecret = false;
  onExit: (() => void) | null = null;

  constructor(readonly target: SshTarget, readonly stateDir: string, readonly keyPath?: string, readonly keyOnly = false) {
    chmodSync(this.dir, 0o700);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  private base(): string[] {
    const args = ["ssh", "-S", this.control, "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
    if (this.keyOnly) args.push("-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none");
    if (this.target.port) args.push("-p", String(this.target.port));
    if (this.target.identity_file) args.push("-i", this.target.identity_file.replace(/^~\//, homedir() + "/"));
    if (this.keyPath && existsSync(this.keyPath)) args.push("-i", this.keyPath);
    return args;
  }
  async start(challenge?: (prompt: string, hostKey: boolean) => Promise<string>): Promise<void> {
    const askPath = join(this.dir, "ask");
    this.askServer.on("connection", (socket) => {
      this.askSockets.add(socket);
      socket.on("close", () => this.askSockets.delete(socket));
      let data = "";
      socket.on("data", async (chunk) => {
        data += chunk;
        if (data.length > 16384) { socket.destroy(); return; }
        if (!data.includes("\n")) return;
        socket.pause();
        try {
          const prompt = String(JSON.parse(data).prompt);
          const hostKey = /fingerprint|continue connecting/i.test(prompt);
          if (!challenge) throw new Error("SSH authentication required; reconnect from PC settings");
          if (!hostKey) this.usedSecret = true;
          const answer = await challenge(prompt, hostKey);
          if (!this.closed) socket.end(JSON.stringify({ answer }) + "\n");
        } catch { socket.destroy(); }
      });
    });
    await new Promise<void>((resolve, reject) => { this.askServer.once("error", reject); this.askServer.listen(askPath, resolve); });
    chmodSync(askPath, 0o600);
    const helper = join(this.dir, "askpass");
    writeFileSync(helper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "ssh-askpass.ts"))} "$@"\n`, { mode: 0o700 });
    const knownHosts = join(this.stateDir, "known_hosts");
    if (!existsSync(knownHosts)) writeFileSync(knownHosts, "", { mode: 0o600 });
    const args = [...this.base(), "-M", "-N", "-T", "-o", "ControlPersist=no", "-o", "ExitOnForwardFailure=yes", "-o", `BatchMode=${challenge ? "no" : "yes"}`, "-o", `StrictHostKeyChecking=${challenge ? "ask" : "yes"}`, "-o", `UserKnownHostsFile=${shellQuote(knownHosts)} ${shellQuote(join(homedir(), ".ssh/known_hosts"))} ${shellQuote(join(homedir(), ".ssh/known_hosts2"))}`, this.target.destination];
    const proc = this.master = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "herdr:0", HERDR_ASKPASS_SOCKET: askPath } });
    void (async () => {
      const reader = proc.stderr.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; this.stderr = (this.stderr + new TextDecoder().decode(value)).slice(-8192); } } finally { reader.releaseLock(); }
    })();
    void proc.exited.then(() => { if (!this.closed) this.onExit?.(); });
    const until = Date.now() + (challenge ? 300_000 : 25_000);
    while (!existsSync(this.control)) {
      if (this.closed) throw new Error("Connection cancelled");
      if (proc.exitCode !== null || Date.now() > until) throw new Error(this.stderr.trim() || "SSH connection timed out");
      await Bun.sleep(100);
    }
  }
  async run(script: string, input?: Uint8Array | StreamInput, timeout = 90_000): Promise<string> {
    if (this.closed) throw new Error("SSH connection closed");
    // BatchMode prevents an expired master from unexpectedly opening a new password prompt.
    return this.exec([...this.base(), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-T", this.target.destination, "sh -c " + shellQuote(script)], input, timeout);
  }
  async forward(port: number, remotePort: number): Promise<void> {
    await this.exec([...this.base(), "-O", "forward", "-L", `127.0.0.1:${port}:127.0.0.1:${remotePort}`, this.target.destination]);
  }
  private async exec(args: string[], input?: Uint8Array | StreamInput, timeout = 30_000): Promise<string> {
    const stream = input !== undefined && !(input instanceof Uint8Array) ? input : undefined;
    const proc = Bun.spawn(args, { stdin: stream ? "pipe" : input ? new Blob([new Uint8Array(input as Uint8Array)]) : "ignore", stdout: "pipe", stderr: "pipe" });
    this.children.add(proc);
    const timer = setTimeout(() => proc.kill(), timeout);
    // a file goes over in chunks, each written once ssh has taken the last one, so what was
    // written tracks what was sent to within ssh's own buffer
    const feed = stream ? (async () => {
      const sink = proc.stdin as import("bun").FileSink;
      let done = 0;
      try {
        for await (const chunk of chunksOf(Bun.file(stream.path).stream())) {
          sink.write(chunk); await sink.flush();
          done += chunk.length; stream.onProgress?.(done);
        }
      } finally { try { await sink.end(); } catch {} }
      stream.onUploaded?.();
    })().then(() => null, (error: unknown) => error) : Promise.resolve(null);
    try {
      const [out, err, code, fed] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited, feed]);
      if (this.closed) throw new Error("Connection cancelled");
      // the remote side's own words say more than a broken pipe on this side
      if (code !== 0) throw new Error(err.trim().slice(-4096) || `SSH command failed (${code})`);
      if (fed) throw fed instanceof Error ? fed : new Error(String(fed));
      return out;
    } finally { clearTimeout(timer); this.children.delete(proc); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.master?.kill();
    for (const child of this.children) child.kill();
    for (const socket of this.askSockets) socket.destroy();
    this.askServer.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
