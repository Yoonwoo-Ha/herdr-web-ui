import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeStateDocument } from "../state-document.ts";
import { HARNESS_LIMITS } from "../../shared/harness-tool.ts";
import { readProcessBirth } from "../process-owner.ts";

export interface Run {
  readonly id: string;
  readonly self: string;
  readonly depth: number;
  readonly started_by: string | null;
  readonly root: string;
  readonly harness: string;
  readonly created_ms: number;
  /** Server-verified permission contract, not a harness mode name. Absent for TUI launches. */
  readonly ceiling?: string;
}
interface Saved { readonly run: Run; readonly hash: string; readonly starts?: readonly { key: string; run: string }[]; readonly calls?: readonly number[]; readonly foreground?: { pid: number; birth: string } }
const idPattern = /^[a-f0-9]{16}$/;
const digest = (token: string) => createHash("sha256").update(token).digest();
export interface LiveToolTerminal {
  address: string; state: string; labels: Record<string, string>;
  foreground?: { pid?: number; argv: readonly string[] } | null;
  parent?: string | null;
}

export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error("Agent tool state must be a directory owned by this user.");
  chmodSync(path, 0o700);
}

export function writePrivate(path: string, text: string): void {
  writeStateDocument(path, text, false);
}

function saved(value: unknown): value is Saved {
  if (!value || typeof value !== "object" || !("hash" in value) || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) || !("run" in value)) return false;
  if ("starts" in value && (!Array.isArray(value.starts) || !value.starts.every(s => s && typeof s.key === "string" && typeof s.run === "string" && idPattern.test(s.run)))) return false;
  if ("calls" in value && (!Array.isArray(value.calls) || value.calls.length > HARNESS_LIMITS.calls_per_minute || !value.calls.every(Number.isFinite))) return false;
  const r = value.run;
  return !!r && typeof r === "object" && "id" in r && typeof r.id === "string" && idPattern.test(r.id)
    && "root" in r && typeof r.root === "string" && idPattern.test(r.root)
    && "started_by" in r && (r.started_by === null || typeof r.started_by === "string" && idPattern.test(r.started_by))
    && "self" in r && typeof r.self === "string" && "depth" in r && typeof r.depth === "number" && Number.isInteger(r.depth) && r.depth >= 0 && r.depth <= 3
    && "created_ms" in r && typeof r.created_ms === "number" && Number.isFinite(r.created_ms) && "harness" in r && typeof r.harness === "string";
}

export class RunStore {
  private readonly entries = new Map<string, Saved>();
  private readonly pending = new Map<string, { depth: number; hash: string; ceiling?: string }>();
  constructor(readonly dir: string) {
    privateDir(dir);
    const file = join(dir, "runs.json");
    if (!existsSync(file)) return;
    try {
      const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(doc) && doc.every(saved)) for (const row of doc) this.entries.set(row.run.id, row);
    } catch {
      console.warn("Agent tool: unreadable run registry; existing credentials will not be accepted.");
    }
  }
  private save(): void { writePrivate(join(this.dir, "runs.json"), JSON.stringify([...this.entries.values()])); }
  reserve(depth = 0, ceiling?: string) {
    const id = randomBytes(8).toString("hex");
    const dir = join(this.dir, "tokens");
    privateDir(dir);
    const tokenFile = join(dir, `${id}.token`);
    const token = `ovr1.${id}.${randomBytes(32).toString("base64url")}`;
    const hash = digest(token).toString("hex");
    writePrivate(tokenFile, token);
    this.pending.set(id, { depth, hash, ceiling });
    return { id, tokenFile, cancel: () => this.revoke(id),
      bind: (claims: Omit<Run, "id" | "created_ms">): Run => {
        if (!this.pending.delete(id)) throw new Error("Agent tool reservation has been revoked.");
        const run = { id, ...claims, created_ms: Date.now() };
        this.entries.set(id, { run, hash });
        try { this.save(); } catch (error) { this.entries.delete(id); throw error; }
        return run;
      } };
  }
  verify(token: string): Run | null {
    const id = /^ovr1\.([a-f0-9]{16})\.[A-Za-z0-9_-]{43}$/.exec(token)?.[1];
    const row = id ? this.entries.get(id) : undefined;
    return row && timingSafeEqual(digest(token), Buffer.from(row.hash, "hex")) ? row.run : null;
  }
  discovery(token: string) {
    const id = token.split(".")[1];
    const entry = id ? this.pending.get(id) : undefined;
    return entry && timingSafeEqual(digest(token), Buffer.from(entry.hash, "hex")) ? entry : undefined;
  }
  ancestors(run: Run): string[] {
    const chain: string[] = [];
    let id = run.started_by;
    while (id && chain.length < 3) {
      const parent = this.entries.get(id)?.run;
      if (!parent) break;
      chain.push(parent.self);
      id = parent.started_by;
    }
    return chain;
  }
  previousStart(id: string, key: string): string | undefined { return this.entries.get(id)?.starts?.find(s => s.key === key)?.run; }
  forgetFailedStart(id: string, failed: string): void {
    const row = this.entries.get(id);
    if (!row?.starts?.some(s => s.run === failed)) return;
    this.entries.set(id, { ...row, starts: row.starts.filter(s => s.run !== failed) });
    this.save();
  }
  takeCall(id: string, now: number): boolean {
    const row = this.entries.get(id);
    if (!row) return false;
    const calls = (row.calls ?? []).filter(at => at > now - 60_000);
    const max = HARNESS_LIMITS.calls_per_minute;
    this.entries.set(id, { ...row, calls: [...calls, now].slice(-max) });
    this.save();
    return calls.length < max;
  }
  rememberStart(id: string, key: string, child: string): void {
    const row = this.entries.get(id);
    if (!row) throw new Error("Agent tool run has ended.");
    this.entries.set(id, { ...row, starts: [...row.starts ?? [], { key, run: child }] });
    this.save();
  }
  revoke(id: string): void {
    if (!idPattern.test(id)) return;
    this.pending.delete(id);
    if (this.entries.delete(id)) this.save();
    rmSync(join(this.dir, "tokens", `${id}.token`), { force: true });
    rmSync(join(this.dir, "mcp", `${id}.json`), { force: true });
  }
  forgetTerminal(self: string, keep?: string): void {
    for (const { run } of this.entries.values()) if (run.self === self && run.id !== keep) this.revoke(run.id);
  }
  rememberForeground(id: string, pid: number): void {
    const row = this.entries.get(id), reading = readProcessBirth(pid);
    if (row && reading.state === "identified") {
      this.entries.set(id, { ...row, foreground: { pid, birth: reading.birth.value } });
      this.save();
    }
  }
  reconcile(terminals: readonly LiveToolTerminal[], keeper: (address: string) => string | undefined): void {
    const live = new Map(terminals.filter(t => t.state === "live").map(t => [t.address, t]));
    for (const { run, foreground } of this.entries.values()) {
      const t = live.get(run.self);
      const config = join(this.dir, "mcp", `${run.id}.json`);
      const argv = t?.foreground?.argv ?? [];
      const id = keeper(run.self);
      const birth = foreground && t?.foreground?.pid === foreground.pid ? readProcessBirth(foreground.pid) : null;
      const verified = run.started_by === null
        ? birth?.state === "identified" && birth.birth.value === foreground?.birth && argv.some((word, i) => (word === "--mcp-config" && argv[i + 1] === config) || (word === "--additional-mcp-config" && argv[i + 1] === `@${config}`)
          || (word.startsWith("mcp_servers.ovis-agent.args=") && argv[i - 1] === "-c" && word.includes(`'${join(this.dir, "tokens", `${run.id}.token`)}'`)))
        : !!id && t?.labels["ovis.acp"] === id && t.labels["ovis.run"] === run.id;
      if (!verified) this.revoke(run.id);
    }
  }
  revokeAll(): void {
    this.pending.clear();
    this.entries.clear();
    this.save();
    for (const dir of ["tokens", "mcp"]) rmSync(join(this.dir, dir), { recursive: true, force: true });
  }
}
