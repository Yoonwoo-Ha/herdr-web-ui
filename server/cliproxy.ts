import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CLIProxyStatus, ProviderUsage } from "../shared/protocol.ts";
import { isJsonObject } from "./http.ts";
import { writePrivateState } from "./private-state.ts";
import { FRESH_MS, MIN_REFRESH_MS, systemUsageContext, USAGE_PROVIDERS, UsageHttpError } from "./usage.ts";

export class CLIProxyError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export const proxyInvalid = () => new CLIProxyError("invalid_cliproxy_request", 400, "Invalid Hub request");
/**
 * Which account a Hub file is, whatever its file name: its provider and the account it names (email, ChatGPT
 * workspace: `holder`), its email alone (whatever its workspace) and its auth index, any of which tells it (#3428: an
 * email may change while the index stays). Never reported.
 */
const accountIdentities = (provider: string, holder: string | null, email: string | null, index: string): readonly string[] =>
  [...(holder === null ? [] : [JSON.stringify([provider, holder])]), ...(email === null ? [] : [`email:${provider}:${email}`]), `index:${provider}:${index}`];
const isIndexed = (identity: string) => identity.startsWith("index:");
const isEmail = (identity: string) => identity.startsWith("email:");
const sameAccount = (known: readonly string[], identities: readonly string[]) => known.some((identity) => identities.includes(identity));
/**
 * Whether a remembered account (`known`) is the one now read as `identities`: one known by its email is so only under
 * that email (another account, with another email or none, may take its old auth index, #3444, #3449); otherwise any
 * identity tells it.
 */
const knownAs = (known: readonly string[], identities: readonly string[]): boolean => {
  const emails = known.filter(isEmail);
  return emails.length > 0 ? sameAccount(emails, identities) : sameAccount(known, identities);
};
const IDENTITIES_MAX = 6;
const widened = (known: readonly string[], identities: readonly string[], named: boolean, listed: ReadonlySet<string>): readonly string[] => {
  const all = [...new Set([...identities.filter((identity) => named || isIndexed(identity)), ...known])];
  const unlisted = all.filter((identity) => !listed.has(identity));
  const dropped = new Set(unlisted.slice(Math.max(0, unlisted.length - Math.max(0, all.length - IDENTITIES_MAX))));
  return all.filter((identity) => !dropped.has(identity));
};
const isHubKey = (key: string) => key.includes(":cliproxy:");
interface ReadView {
  hidden: ReadonlySet<string>; blind: boolean; accounts: ReadonlyMap<string, readonly string[]>;
  hiddenIdentities: ReadonlySet<string>;
}
const unreadableIn = (view: ReadView, key: string, identities: readonly string[]): boolean => {
  if (view.blind || identities.some((identity) => view.hiddenIdentities.has(identity))) return true;
  const named = view.accounts.get(key);
  return view.hidden.has(key) && (named === undefined || sameAccount(named, identities));
};
const BLIND_PROBLEM = "Hidden accounts could not be told apart, so no hub account is read. Show again each hidden hub account, or save the hub again to read them by file name.";
const EVERY_KEY = "*";
const HIDDEN_MAX_BYTES = 64 * 1024;
const savedBytes = (document: string) => Buffer.byteLength(`${JSON.stringify(JSON.parse(document), null, 2)}\n`);

function readOwnFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > HIDDEN_MAX_BYTES || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error("not this server's file");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > HIDDEN_MAX_BYTES) throw new Error("not this server's file");
    return text;
  } finally { closeSync(fd); }
}
type Config = { readonly url: string; readonly management_key: string };
const DEFAULT_URL = "http://localhost:8317";

export class CLIProxyService {
  private config: Config | null = null;
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
  private skipped: ReadonlySet<string> = new Set();
  private hidden: () => ReadonlySet<string> = () => this.skipped;
  private readonly shownAt = new Map<string, number>();
  /** the account (email, ChatGPT workspace) each row's file named when it was read; never reported */
  private readonly holders = new WeakMap<ProviderUsage, string>();
  /** the account each row is (accountIdentities); never reported */
  private readonly identities = new WeakMap<ProviderUsage, readonly string[]>();
  private readonly shownRows = new WeakSet<ProviderUsage>();
  private readonly shownIdentities = new Map<string, readonly string[]>();
  private readonly hiddenAccounts = new Map<string, readonly string[]>();
  private readonly hiddenPath: string;
  private savedHidden: string | null = null;
  private covered: Set<string> | null = null;
  private checkedCovered = false;
  /**
   * Fail closed (#3428): set when the saved list cannot be trusted (unreadable, not the list, a link, not this user's,
   * too large) or does not cover a key hidden before this start (its save never landed). A hidden Hub key with no
   * known account may then be any account under any file name, so while one is hidden, or while the hidden list is
   * read only in part (a key left out may be one), no Hub account is read at all. Ways out, each saved: the whole
   * hidden list holds no such key, because each was shown again or names a file the Hub lists (that file's account is
   * then taken as the one hidden, as a fresh server takes it by file name); or the user saves the Hub again, told why
   * by status().problem, which keeps the hidden keys unread by file name alone.
   */
  private blind = false;
  private hiddenSaveFailed = false;
  private hiddenWhole: () => boolean = () => true;
  private partial = new Set<string>();
  private isPartial(key: string): boolean { return this.partial.has(key) || this.partial.has(EVERY_KEY); }
  private listed: ReadonlySet<string> = new Set();

  constructor(stateDir: string) {
    this.path = join(stateDir, "cliproxy.json");
    this.hiddenPath = join(stateDir, "cliproxy-hidden.json");
    this.load();
    this.loadHidden();
  }

  private load(): void {
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
    const problem = this.problem ?? (this.config !== null && this.blindTo(this.hidden()) ? BLIND_PROBLEM : null);
    return { configured: this.config !== null, url: this.config?.url ?? DEFAULT_URL, ok: this.checked && problem === null, problem };
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
    if (this.blind && this.hiddenWhole()) {
      const partial = this.partial;
      this.blind = false;
      this.partial = new Set();
      if (!this.saveHidden()) {
        this.blind = true;
        this.partial = partial;
        throw new CLIProxyError("cliproxy_hidden_unsaved", 500, "Could not save which Hub accounts are hidden");
      }
    }
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
    // an exclusive temporary file of a name no one can guess: nothing left in its place receives the key (#3428)
    writePrivateState(this.path, config ?? {});
    const moved = config?.url !== this.config?.url || config?.management_key !== this.config?.management_key;
    this.config = config;
    this.blocked = null;
    this.problem = null;
    this.checked = false;
    this.invalidate();
    if (moved) { this.entries = []; this.shownIdentities.clear(); this.listed = new Set(); this.forgetIndexed(); this.saveHidden(); }
  }

  private forgetIndexed(): void {
    for (const [key, identities] of this.hiddenAccounts) {
      const kept = identities.filter((identity) => !isIndexed(identity));
      if (kept.length === 0) this.hiddenAccounts.delete(key);
      else this.hiddenAccounts.set(key, kept);
    }
  }

  /** The Hub a saved hiddenAccounts belongs to: its address and management key, digested, so the key is never written there. */
  private hub(): string | null {
    return this.config === null ? null : createHash("sha256").update(`${this.config.url}\0${this.config.management_key}`).digest("hex");
  }

  private loadHidden(): void {
    let text: string;
    try { text = readOwnFile(this.hiddenPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.blind = true;
      console.warn("cliproxy: the saved hidden accounts cannot be read; no Hub account is read while a hidden one is unknown");
      return;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = null; }
    const accounts = isJsonObject(value) ? value["accounts"] : null;
    const keys = isJsonObject(value) ? value["keys"] : null;
    const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
    if (!isJsonObject(value) || !isJsonObject(accounts) || !strings(keys) || typeof value["blind"] !== "boolean"
      || !Object.values(accounts).every((identities) => strings(identities) && identities.length > 0)
      || (value["partial"] !== undefined && !strings(value["partial"]))) {
      this.blind = true;
      console.warn("cliproxy: the saved hidden accounts are not a list; no Hub account is read while a hidden one is unknown");
      return;
    }
    for (const [key, identities] of Object.entries(accounts)) this.hiddenAccounts.set(key, identities as string[]);
    this.covered = new Set(keys);
    this.partial = new Set(value["partial"] as string[] | undefined);
    this.blind = value["blind"];
    if (value["hub"] !== this.hub()) this.forgetIndexed();
    this.savedHidden = this.hiddenDocument();
  }

  private hiddenDocument(): string {
    return JSON.stringify({ hub: this.hub(), accounts: Object.fromEntries(this.hiddenAccounts), keys: [...this.covered ?? []], blind: this.blind,
      ...(this.partial.size > 0 ? { partial: [...this.partial] } : {}) });
  }

  private saveHidden(): boolean {
    if (this.hiddenDocument() === this.savedHidden) return true;
    try {
      if (!this.fitHidden()) {
        const blind = this.blindDocument() ?? JSON.stringify({ hub: this.hub(), accounts: {}, keys: [], blind: true, partial: [EVERY_KEY] });
        if (blind !== this.savedHidden) { writePrivateState(this.hiddenPath, JSON.parse(blind)); this.savedHidden = blind; }
        throw new Error("the hidden accounts do not fit in a saved list");
      }
      const document = this.hiddenDocument();
      writePrivateState(this.hiddenPath, JSON.parse(document));
      this.savedHidden = document;
      this.hiddenSaveFailed = false;
      return true;
    } catch {
      this.hiddenSaveFailed = true;
      console.warn("cliproxy: could not save which accounts are hidden");
      return false;
    }
  }

  private fitHidden(): boolean {
    let excess = savedBytes(this.hiddenDocument()) - HIDDEN_MAX_BYTES;
    while (excess > 0) {
      let pick: { key: string; identities: readonly string[]; at: number } | null = null;
      for (const [key, identities] of this.hiddenAccounts) {
        if (identities.length < 2 || (pick !== null && identities.length <= pick.identities.length)) continue;
        let at = identities.length - 1;
        while (at >= 0 && (isEmail(identities[at]!) || this.listed.has(identities[at]!))) at--;
        if (at >= 0) pick = { key, identities, at };
      }
      if (pick === null) return false;
      const { key, identities, at } = pick;
      this.hiddenAccounts.set(key, identities.filter((_, index) => index !== at));
      excess -= Buffer.byteLength(JSON.stringify(identities[at])) + 8;
      if (excess <= 0) excess = savedBytes(this.hiddenDocument()) - HIDDEN_MAX_BYTES;
    }
    return true;
  }

  private blindDocument(): string | null {
    const accounts = new Map(this.hiddenAccounts);
    const partial = new Set(this.partial);
    const largest = [...accounts.keys()].sort((a, b) => JSON.stringify(accounts.get(b)).length - JSON.stringify(accounts.get(a)).length);
    const fitting = () => {
      const document = JSON.stringify({ hub: this.hub(), accounts: Object.fromEntries(accounts), keys: [...this.covered ?? []], blind: true, partial: [...partial] });
      return savedBytes(document) <= HIDDEN_MAX_BYTES ? document : null;
    };
    for (const key of largest) {
      const document = fitting();
      if (document !== null) return document;
      const named = accounts.get(key)!.filter((identity) => !isIndexed(identity));
      if (named.length > 0) accounts.set(key, named);
      else accounts.delete(key);
      partial.add(key);
    }
    for (const key of largest) {
      const document = fitting();
      if (document !== null) return document;
      accounts.delete(key);
    }
    return fitting();
  }

  private blindTo(hidden: ReadonlySet<string>, whole = this.hiddenWhole()): boolean {
    return this.blind && (!whole || [...hidden].some((key) => isHubKey(key) && (!this.hiddenAccounts.has(key) || this.isPartial(key))));
  }

  private view(hidden: ReadonlySet<string>, whole: boolean): ReadView {
    const accounts = new Map(this.hiddenAccounts);
    const hiddenIdentities = new Set([...accounts].flatMap(([key, identities]) => (hidden.has(key) ? identities : [])));
    return { hidden, blind: !whole || this.blindTo(hidden, whole), accounts, hiddenIdentities };
  }

  hiddenUnsaved(): boolean { return this.hiddenSaveFailed; }

  private syncHidden(hidden: ReadonlySet<string>, whole = this.hiddenWhole()): boolean {
    for (const row of this.entries) {
      const identities = this.identities.get(row);
      if (identities !== undefined && (this.shownRows.has(row) || this.blind) && hidden.has(row.key) && !this.hiddenAccounts.has(row.key)) this.hiddenAccounts.set(row.key, identities);
    }
    for (const key of hidden) {
      const identities = this.shownIdentities.get(key);
      if (identities !== undefined && !this.hiddenAccounts.has(key)) this.hiddenAccounts.set(key, identities);
    }
    if (whole) for (const key of this.hiddenAccounts.keys()) if (!hidden.has(key)) this.hiddenAccounts.delete(key);
    if (whole) for (const key of this.partial) if (key === EVERY_KEY ? ![...hidden].some(isHubKey) : !hidden.has(key)) this.partial.delete(key);
    const hub = [...hidden].filter(isHubKey);
    if (!this.checkedCovered) this.checkCovered(hidden, whole);
    if (this.blind && whole && hub.every((key) => this.hiddenAccounts.has(key) && !this.isPartial(key))) this.blind = false;
    this.covered = new Set([...(whole ? [] : (this.covered ?? [])), ...hub]);
    return this.saveHidden();
  }

  hiddenChanged(): void {
    if (!this.syncHidden(this.hidden())) throw new Error("Could not save which Hub accounts are hidden");
  }

  skipAccounts(keys: () => ReadonlySet<string>, whole: () => boolean = () => true): void {
    this.hidden = keys;
    this.hiddenWhole = whole;
    const atStart = keys();
    if (this.checkedCovered || !whole()) return;
    this.checkCovered(atStart, true);
    this.covered = new Set([...atStart].filter(isHubKey));
  }

  private checkCovered(hidden: ReadonlySet<string>, whole: boolean): void {
    const hub = [...hidden].filter(isHubKey);
    if (this.covered !== null && hub.some((key) => !this.covered?.has(key) && !this.hiddenAccounts.has(key))) this.blind = true;
    if (whole) this.checkedCovered = true;
  }

  invalidate(): void {
    this.generation++; this.nextAt = 0; this.readAt = 0; this.pending = null; this.shownAt.clear();
    const hidden = this.hidden();
    this.entries = this.entries.filter((entry) => hidden.has(entry.key));
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

  report(refresh = false, skipped: ReadonlySet<string> = new Set()): Promise<readonly ProviderUsage[]> {
    if (!this.config) return Promise.resolve([]);
    if (this.pending) return this.pending;
    const now = Date.now();
    const due = now >= this.nextAt || (refresh && now - this.readAt >= MIN_REFRESH_MS);
    const shown = this.entries.filter((entry) => this.skipped.has(entry.key) && !skipped.has(entry.key)).map((entry) => entry.key);
    this.skipped = skipped;
    const live = this.hidden();
    const whole = this.hiddenWhole();
    const hiddenNow = new Set([...skipped, ...live]);
    this.syncHidden(live, whole);
    const start = this.view(hiddenNow, whole);
    if (!due && shown.length === 0) return Promise.resolve(this.entries);
    const kept = due
      ? new Set([...skipped, ...[...this.shownAt].filter(([, at]) => now - at < MIN_REFRESH_MS).map(([key]) => key)])
      : new Set(this.entries.map((entry) => entry.key).filter((key) => !shown.includes(key)));
    const generation = this.generation;
    const answer = { whole };
    const learned = new Map<string, { identities: readonly string[]; shown: boolean; kept?: ProviderUsage }>();
    const pass = this.collect(kept, start, answer, learned).then((entries) => {
      if (generation !== this.generation) return [];
      if (!due && entries === null) { this.skipped = new Set([...this.skipped, ...shown]); return this.entries; }
      if (entries === null) {
        const hidden = this.hidden();
        this.entries = this.entries.filter((entry) => skipped.has(entry.key) || hidden.has(entry.key));
        return this.entries;
      }
      this.entries = entries;
      for (const key of this.shownIdentities.keys()) if (!entries.some((entry) => entry.key === key)) this.shownIdentities.delete(key);
      let widenedHidden = false;
      const listed = new Set([...learned.values()].flatMap(({ identities }) => identities));
      this.listed = listed;
      const growing = new Map([...this.hiddenAccounts].map(([hiddenKey, account]) =>
        [hiddenKey, { known: new Set(account), named: account.some(isEmail), rows: [] as (readonly string[])[] }]));
      for (const [key, { identities, shown, kept }] of learned) {
        if (kept !== undefined) this.identities.set(kept, identities);
        const known = this.shownIdentities.get(key);
        if (known !== undefined && knownAs(known, identities)) this.shownIdentities.set(key, widened(known, identities, shown || known.some(isEmail), listed));
        else if (shown) this.shownIdentities.set(key, identities);
        else this.shownIdentities.delete(key);
        for (const account of growing.values()) {
          if (!identities.some((identity) => account.known.has(identity) && (!account.named || isEmail(identity)))) continue;
          const added = identities.filter((identity) => account.named || isIndexed(identity));
          for (const identity of added) account.known.add(identity);
          account.rows.push(added);
        }
      }
      for (const [hiddenKey, { named, rows }] of growing) {
        const account = this.hiddenAccounts.get(hiddenKey);
        if (account === undefined || rows.length === 0) continue;
        const next = widened(account, rows.reverse().flat(), named, listed);
        if (next.length !== account.length || next.some((identity, at) => identity !== account[at])) { this.hiddenAccounts.set(hiddenKey, next); widenedHidden = true; }
      }
      if (widenedHidden) this.saveHidden();
      if (!answer.whole) { this.skipped = new Set([...this.skipped, ...shown]); return this.entries; }
      if (due) { this.readAt = now; this.nextAt = now + FRESH_MS; this.shownAt.clear(); }
      else for (const key of shown) this.shownAt.set(key, now);
      return this.entries;
    }).finally(() => { if (this.pending === pass) this.pending = null; });
    this.pending = pass;
    return pass;
  }

  private async collect(kept: ReadonlySet<string>, start: ReadView, answer: { whole: boolean },
    learned: Map<string, { identities: readonly string[]; shown: boolean; kept?: ProviderUsage }>): Promise<readonly ProviderUsage[] | null> {
    try {
      const body = await this.call("/credentials");
      if (!Array.isArray(body["files"])) throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response");
      const files = body["files"].filter(isJsonObject);
      this.problem = null; this.checked = true;
      const ctx = systemUsageContext();
      const liveKeys = this.hidden();
      const liveWhole = this.hiddenWhole();
      const live = this.view(liveKeys, liveWhole);
      answer.whole &&= liveWhole;
      return await Promise.all(files.flatMap((file) => {
        const provider = USAGE_PROVIDERS.find((item) => (item.id === "claude" || item.id === "codex") && item.id === file["provider"]);
        const index = file["auth_index"];
        if (!provider || typeof index !== "string" || !index) return [];
        const name = typeof file["name"] === "string" ? file["name"] : index;
        const account = typeof file["email"] === "string" ? file["email"] : name;
        const claims = file["id_token"];
        const workspace = isJsonObject(claims) && typeof claims["chatgpt_account_id"] === "string" ? claims["chatgpt_account_id"] : null;
        const entry: ProviderUsage = { id: provider.id, key: `${provider.id}:cliproxy:${encodeURIComponent(name)}`, account, plan: null, windows: [], problem: "failed", checked_at: null };
        const email = typeof file["email"] === "string" ? file["email"] : null;
        const holder = email === null && workspace === null ? null : JSON.stringify([email, workspace]);
        const last = kept.has(entry.key) && holder !== null ? this.entries.find((held) => held.key === entry.key && this.holders.get(held) === holder) : undefined;
        const identities = accountIdentities(provider.id, holder, email, index);
        const shown = !start.hidden.has(entry.key) && !live.hidden.has(entry.key);
        if (last) { learned.set(entry.key, { identities, shown, kept: last }); return [Promise.resolve(last)]; }
        const held = (row: ProviderUsage): ProviderUsage => {
          if (holder !== null) this.holders.set(row, holder);
          this.identities.set(row, identities);
          if (shown) this.shownRows.add(row);
          learned.set(row.key, { identities, shown });
          return row;
        };
        if (unreadableIn(start, entry.key, identities) || unreadableIn(live, entry.key, identities)) return [Promise.resolve(held({ ...entry, problem: null }))];
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
      return null;
    }
  }
}
