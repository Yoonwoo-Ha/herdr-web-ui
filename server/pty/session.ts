import { join } from "node:path";

const HOST_SCRIPT = join(import.meta.dir, "pty-host.mjs");

export interface PtySessionOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
}

/**
 * A command running on a real PTY, hosted by a Node sidecar (see pty-host.mjs for
 * why it cannot run in-process under Bun).
 */
export class PtySession {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private closed = false;

  constructor(private readonly options: PtySessionOptions) {
    this.proc = Bun.spawn(
      ["node", HOST_SCRIPT, String(options.cols), String(options.rows), options.command, ...options.args],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    void this.pump();
    void this.proc.exited.then((code) => {
      if (this.closed) return;
      this.closed = true;
      options.onExit(code ?? null);
    });
  }

  private async pump(): Promise<void> {
    const stream = this.proc.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        // stream:true keeps a multi-byte character split across reads intact
        const text = decoder.decode(value, { stream: true });
        if (text) this.options.onData(text);
      }
    } catch {
      /* the pty closed underneath us; onExit reports it */
    } finally {
      reader.releaseLock();
    }
  }

  private send(frame: Record<string, unknown>): void {
    if (this.closed) return;
    const sink = this.proc.stdin;
    if (!sink || typeof sink === "number" || !("write" in sink)) return;
    try {
      sink.write(`${JSON.stringify(frame)}\n`);
      sink.flush();
    } catch {
      /* host already gone */
    }
  }

  write(data: string): void {
    this.send({ t: "i", d: data });
  }

  resize(cols: number, rows: number): void {
    this.send({ t: "r", c: cols, r: rows });
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    const sink = this.proc.stdin;
    try {
      if (sink && typeof sink !== "number" && "end" in sink) sink.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}
