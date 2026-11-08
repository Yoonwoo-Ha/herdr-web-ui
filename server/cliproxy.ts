import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CLIProxyStatus, ProviderUsage } from "../shared/protocol.ts";
import { isJsonObject } from "./http.ts";
import { FRESH_MS, MIN_REFRESH_MS, systemUsageContext, USAGE_PROVIDERS, UsageHttpError } from "./usage.ts";

export class CLIProxyError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export const proxyInvalid = () => new CLIProxyError("invalid_cliproxy_request", 400, "Invalid Hub request");
type Config = { readonly url: string; readonly management_key: string };
const DEFAULT_URL = "http://localhost:8317";

/** Only fixed messages cross this boundary; upstream errors can echo management credentials. */
export class CLIProxyService {
  private config: Config | null;
  private readonly path: string;
  private blocked: CLIProxyError | null = null;
  private problem: string | null = null;
  private checked = false;
  private nextAt = 0;
  private readAt = 0;
  private entries: readonly ProviderUsage[] = [];
  private pending: Promise<readonly ProviderUsage[]> | null = null;
  private generation = 0;
  private requests: Promise<void> = Promise.resolve();
  /** the hidden or removed accounts of the last report: their credentials are not used (#3333) */
  private skipped: ReadonlySet<string> = new Set();
  /** the account (email, ChatGPT workspace) each row's file named when it was read; never reported */
  private readonly holders = new WeakMap<ProviderUsage, string>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "cliproxy.json");
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (isJsonObject(value) && Object.keys(value).length === 0) { this.config = null; return; }
      if (!isJsonObject(value) || typeof value["url"] !== "string" || typeof value["management_key"] !== "string") throw proxyInvalid();
      this.config = { url: this.base(value["url"]), management_key: value["management_key"] };
    } catch (error) {
      this.config = null;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.problem = "Could not read Hub configuration";
        console.warn(`cliproxy: ${this.problem}`);
      }
    }
  }

  private base(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw proxyInvalid(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw proxyInvalid();
    return url.href.replace(/\/+$/, "").replace(/\/v8\/management$/, "");
  }

  status(): CLIProxyStatus {
    return { configured: this.config !== null, url: this.config?.url ?? DEFAULT_URL, ok: this.checked && this.problem === null, problem: this.problem };
  }

  async save(value: unknown): Promise<CLIProxyStatus> {
    if (!isJsonObject(value) || typeof value["url"] !== "string" || value["url"].length > 2000) throw proxyInvalid();
    const url = this.base(value["url"]);
    const supplied = value["management_key"];
    if (supplied !== undefined && (typeof supplied !== "string" || !supplied.trim())) throw proxyInvalid();
    const suppliedKey = typeof supplied === "string" ? supplied.trim() : null;
    const key = suppliedKey ?? this.config?.management_key;
    if (!key || key.length > 2000 || /\s/.test(key) || url.includes(key) || (this.config && url !== this.config.url && !suppliedKey)) throw proxyInvalid();
    this.persist({ url, management_key: key });
    return this.check();
  }

  async check(): Promise<CLIProxyStatus> {
    if (!this.config || this.checked) return this.status();
    const generation = this.generation;
    let problem: string | null = null;
    try {
      const body = await this.call("/credentials");
      if (!Array.isArray(body["files"])) throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response");
    } catch (error) {
      if (!(error instanceof CLIProxyError)) throw error;
      problem = error.message;
    }
    if (generation === this.generation) { this.problem = problem; this.checked = true; }
    return this.status();
  }

  remove(): CLIProxyStatus {
    this.persist(null);
    return this.status();
  }

  private persist(config: Config | null): void {
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(config ?? {}), { mode: 0o600 });
    renameSync(temporary, this.path);
    // another Hub, or another key to it, has other accounts: no row of the old one stays, hidden or not
    const moved = config?.url !== this.config?.url || config?.management_key !== this.config?.management_key;
    this.config = config;
    this.blocked = null;
    this.problem = null;
    this.checked = false;
    this.invalidate();
    if (moved) this.entries = [];
  }

  /** The next report reads the Hub anew, except the rows of the hidden or removed accounts: their credentials stay unused (#3333). */
  invalidate(): void {
    this.generation++; this.nextAt = 0; this.readAt = 0; this.pending = null;
    this.entries = this.entries.filter((entry) => this.skipped.has(entry.key));
  }

  call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    // A revoked key must cause one refusal, not one per account (the proxy bans after five).
    const request = this.requests.then(() => this.request(path, init));
    this.requests = request.then(() => undefined, () => undefined);
    return request;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    if (this.blocked) throw this.blocked;
    const config = this.config;
    if (!config) throw new CLIProxyError("cliproxy_not_configured", 409, "Configure Hub first");
    try {
      const response = await fetch(`${config.url}/v8/management${path}`, {
        ...init, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/json", authorization: `Bearer ${config.management_key}` },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const auth = response.status === 401 || response.status === 403;
        const error = new CLIProxyError(auth ? "cliproxy_auth" : "cliproxy_upstream", 502,
          auth ? "Hub rejected the key. Save a valid key." : "Hub could not complete the request");
        if (auth && config === this.config) this.blocked = error;
        throw error;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) { await reader.cancel(); throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const value: unknown = JSON.parse(raw.split(JSON.stringify(config.management_key).slice(1, -1)).join("[redacted]"));
      if (!isJsonObject(value)) throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response");
      return value;
    } catch (error) {
      const safe = error instanceof CLIProxyError ? error : new CLIProxyError("cliproxy_unreachable", 502, "Could not reach Hub");
      if (config === this.config) { this.problem = safe.message; this.checked = true; }
      throw safe;
    }
  }

  /** `skipped`: accounts hidden or removed from Ovis, whose last rows stay without asking the Hub to use their credentials; one shown again is read now. */
  report(refresh = false, skipped: ReadonlySet<string> = new Set()): Promise<readonly ProviderUsage[]> {
    if (!this.config) return Promise.resolve([]);
    if (this.pending) return this.pending;
    const now = Date.now();
    const shownAgain = this.entries.some((entry) => this.skipped.has(entry.key) && !skipped.has(entry.key));
    this.skipped = skipped;
    if (now < this.nextAt && !shownAgain && !(refresh && now - this.readAt >= MIN_REFRESH_MS)) return Promise.resolve(this.entries);
    const generation = this.generation;
    const pass = this.collect(skipped).then((entries) => {
      if (generation !== this.generation) return [];
      this.entries = entries; this.readAt = now; this.nextAt = now + FRESH_MS;
      return entries;
    }).finally(() => { if (this.pending === pass) this.pending = null; });
    this.pending = pass;
    return pass;
  }

  private async collect(skipped: ReadonlySet<string>): Promise<readonly ProviderUsage[]> {
    try {
      const body = await this.call("/credentials");
      if (!Array.isArray(body["files"])) throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response");
      const files = body["files"].filter(isJsonObject);
      this.problem = null; this.checked = true;
      const ctx = systemUsageContext();
      return await Promise.all(files.flatMap((file) => {
        const provider = USAGE_PROVIDERS.find((item) => (item.id === "claude" || item.id === "codex") && item.id === file["provider"]);
        const index = file["auth_index"];
        if (!provider || typeof index !== "string" || !index) return [];
        const name = typeof file["name"] === "string" ? file["name"] : index;
        const account = typeof file["email"] === "string" ? file["email"] : name;
        const claims = file["id_token"];
        const workspace = isJsonObject(claims) && typeof claims["chatgpt_account_id"] === "string" ? claims["chatgpt_account_id"] : null;
        const entry: ProviderUsage = { id: provider.id, key: `${provider.id}:cliproxy:${encodeURIComponent(name)}`, account, plan: null, windows: [], problem: "failed", checked_at: null };
        // a hidden or removed account keeps its last row; one never read yet is read once, so it can be listed
        // only while the file still names that account: another one under the same name is read anew
        const holder = JSON.stringify([typeof file["email"] === "string" ? file["email"] : null, workspace]);
        const kept = skipped.has(entry.key) ? this.entries.find((held) => held.key === entry.key && this.holders.get(held) === holder) : undefined;
        if (kept) return [Promise.resolve(kept)];
        const held = (row: ProviderUsage): ProviderUsage => { this.holders.set(row, holder); return row; };
        if (file["disabled"] === true || file["unavailable"] === true) return [Promise.resolve(held(entry))];
        return [(async (): Promise<ProviderUsage> => {
          try {
            const reading = await provider.read({ ...ctx, fetch: async (url, init) => {
              const header = Object.fromEntries(new Headers(init.headers).entries());
              header["authorization"] = "Bearer $TOKEN$";
              const answer = await this.call("/requests/api-call", { method: "POST", body: JSON.stringify({ auth_index: index, method: "GET", url, header }) });
              const status = answer["status_code"];
              if (typeof status !== "number" || status < 200 || status > 599 || typeof answer["body"] !== "string") throw proxyInvalid();
              return new Response(answer["body"], { status });
            } }, { token: "$TOKEN$", expiresAt: null, chatgptAccount: workspace });
            return reading ? { ...entry, plan: reading.plan, windows: reading.windows, problem: null, checked_at: new Date().toISOString() } : entry;
          } catch (error) {
            return { ...entry, problem: error instanceof UsageHttpError && (error.status === 401 || error.status === 403) ? "expired" : "failed" };
          }
        })().then(held)];
      }));
    } catch (error) {
      if (!(error instanceof CLIProxyError)) throw error;
      this.problem = error.message; this.checked = true;
      return [];
    }
  }
}
