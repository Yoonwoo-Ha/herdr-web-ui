import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { UsageProviderId } from "../shared/protocol.ts";
import type { UsageLoginFollowed, UsageLoginPrompt, UsageLoginStarted } from "../shared/usage-login.ts";
import { paneClose, paneProcessInfo, paneSendKeys, paneSendText, sessionSnapshot, tabCreate, workspaceCreate } from "./herdr/client.ts";
import { loginPrompt, screenText, type PromptProvider } from "./usage-login-prompt.ts";
import { homeBefore, loginAccount, type LoginAccount, type LoginTarget } from "./usage-login-account.ts";
import { isSecureRequest, parseCookies } from "./auth.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { psQuote } from "./powershell.ts";
import { withOwnerGuard } from "./owner-guard.ts";
import { writePrivateState } from "./private-state.ts";
import { PtySession } from "./pty/session.ts";
import { newOwnerRecord, ownerGone, parseBirth, type ProcessBirth } from "./process-owner.ts";
import { paneShell, shellCommandLine, type PaneShell } from "./shell-agent.ts";
import { localSignInPlace, systemUsageContext, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const LOGIN = {
  claude: { cli: "claude", binaries: ["claude"], args: ["auth", "login"] },
  codex: { cli: "codex", binaries: ["codex"], args: ["login"] },
  cursor: { cli: "Cursor CLI (agent)", binaries: ["agent", "cursor-agent"], args: ["login"] },
  copilot: { cli: "GitHub CLI (gh)", binaries: ["gh"], args: ["auth", "login", "--hostname", "github.com"] },
  grok: { cli: "grok", binaries: ["grok"], args: ["login"] },
  antigravity: { cli: "Antigravity CLI (agy)", binaries: ["agy"], args: null },
  opencode: { cli: "opencode", binaries: ["opencode"], args: ["auth", "login"] },
} as const;

/**
 * What the sign-in line sets first in `shell`: the credential home `name` names (`home`), or none
 * (null: the default home). The pane's shell may have inherited another account's home, so the
 * default one is reached by removing the variable, not by leaving it out of the tab's environment.
 */
function credentialHomePrefix(shell: PaneShell, name: string, home: string | null): string {
  if (shell === "posix") return `${shellCommandLine("posix", "env", home === null ? ["-u", name] : [`${name}=${home}`])} `;
  if (shell === "powershell") return home === null ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue; ` : `$env:${name} = ${psQuote(home)}; `;
  if (/["%\r\n]/.test(home ?? "")) throw new Error("this credential home cannot be typed into cmd.exe");
  return `set "${name}=${home ?? ""}" & `;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/**
 * The login holding a credential home: the pane its tab opened as, and that tab's terminal. herdr names
 * each terminal once and keeps the name when the tab moves to another workspace (its pane ID changes), so
 * the terminal is there exactly as long as the login runs in it: the CLI replaces the tab's shell (exec),
 * or the shell exits after it. A pane ID alone is no proof: a restarted herdr hands the same IDs out again.
 */
interface LoginHolder { readonly pane: string; readonly terminal: string }
interface Launch { readonly launch: string; readonly pid: number; readonly at: number }
/**
 * A login the browser follows, run by the server process `pid` in a terminal of its own since `at`. Saved in
 * a launch's shape, so an older server reads it (as a launch that soon expires) instead of refusing the file.
 * `launch` is a lock id of its own: the file can be read by any device that reads files, and the id that
 * reaches the login's prompt is never written there.
 */
interface PrivateHolder { readonly launch: string; readonly pid: number; readonly at: number; readonly private: true; readonly birth?: ProcessBirth }
type Holder = LoginHolder | Launch | PrivateHolder;

/** A sign-in the browser follows: the CLI in the server's own PTY, never a herdr pane another device could read. */
interface PrivateLogin {
  readonly provider: PromptProvider;
  readonly target: LoginTarget;
  readonly before: readonly string[] | undefined;
  exitCode: number | null;
  signedIn: LoginAccount | null;
  readonly owner: string;
  /**
   * The secret of the browser that started it, sent back only in its HttpOnly cookie: two browsers can share an
   * owner (every browser signed in with the server's token is one), and an id alone reaches nothing.
   */
  readonly secret: string;
  cancelled: boolean;
  expired: boolean;
  readonly lock: string;
  readonly done: Promise<void>;
  read: boolean;
  readonly madeHome: string | null;
  readonly proc: PtySession;
  changed: ReturnType<typeof Promise.withResolvers<void>>;
  output: string;
  ended: boolean;
}

/** A launch opens its tab within the request's 30 s, the CLI's help taking up to 10 of them: one older has failed. */
const LAUNCH_MS = 60_000;

const PRIVATE_LOGINS_MAX = 32;
const PRIVATE_OUTPUT_MAX = 65_536;
const PRIVATE_COLUMNS = 400;
const PRIVATE_MAX_MS = 30 * 60_000;
const PRIVATE_LEASE_MS = 30_000;
const liveLocks = new Set<string>();

/** the cookie that carries one followed sign-in's secret; one per sign-in, so two dialogs never overwrite each other's */
const signInCookie = (loginId: string): string => `ovis-sign-in-${loginId}`;

const SIGN_IN_CODE = /^[A-Za-z0-9._~#-]{1,2048}$/;

const isPrivate = (holder: Holder): holder is PrivateHolder => "private" in holder;
const isLaunch = (holder: Holder): holder is Launch => "launch" in holder && !isPrivate(holder);
const isTab = (holder: Holder): holder is LoginHolder => !("launch" in holder);
const sameHolder = (a: Holder, b: Holder): boolean => isLaunch(a) ? isLaunch(b) && a.launch === b.launch
  : isPrivate(a) ? isPrivate(b) && a.launch === b.launch : isTab(b) && a.terminal === b.terminal;

class LoginStateUnreadable extends Error {
  constructor(file: string, cause: unknown) {
    super(`${file} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "LoginStateUnreadable";
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

export class UsageLoginService {
  private readonly panes = new Map<string, UsageProviderId>();
  /**
   * The sign-ins the browser follows, by the random id only the browser that started one is given: each
   * runs in this server's own PTY, so no herdr pane (read, attached, streamed or listed by any device) ever
   * holds its sign-in address or the code typed into it. Kept a while after the CLI exits, as ended.
   */
  private readonly privates = new Map<string, PrivateLogin>();
  private readonly handedOff = new Set<string>();

  private owned(id: string, request: Request, owner: string | null): PrivateLogin | undefined {
    const login = this.privates.get(id);
    if (login === undefined || login.owner !== owner) return undefined;
    const sent = Buffer.from(parseCookies(request.headers.get("cookie")).get(signInCookie(id)) ?? "");
    const secret = Buffer.from(login.secret);
    return sent.length === secret.length && timingSafeEqual(sent, secret) ? login : undefined;
  }
  private readonly endedListeners: ((account: string | null, provider: UsageProviderId) => void)[] = [];
  private stopped = false;

  onLoginEnded(listener: (account: string | null, provider: UsageProviderId) => void): void { this.endedListeners.push(listener); }
  private readonly logins = new Map<string, Holder>();
  private file: string | null = null;

  constructor(private readonly home = homedir(), private readonly env = process.env,
    private readonly context: UsageContext = { ...systemUsageContext(), home, env },
    private readonly timing: { readonly leaseMs: number; readonly maxMs: number } = { leaseMs: PRIVATE_LEASE_MS, maxMs: PRIVATE_MAX_MS }) {}

  settled(id: string): Promise<void> { return this.privates.get(id)?.done ?? Promise.resolve(); }

  changed(id: string): Promise<void> { return this.privates.get(id)?.changed.promise ?? Promise.resolve(); }

  async stopAll(): Promise<void> {
    this.stopped = true;
    const running = [...this.privates.values()].filter((login) => !login.ended);
    for (const login of running) login.proc.kill();
    await Promise.all(running.map((login) => login.done));
  }

  ended(paneId: string): UsageProviderId | undefined {
    for (const [home, holder] of this.logins) if (isTab(holder) && holder.pane === paneId) this.release(home, holder);
    const provider = this.panes.get(paneId);
    this.panes.delete(paneId);
    return provider;
  }

  persistTo(stateDir: string): void { this.file = join(stateDir, "usage-logins.json"); }

  /**
   * The browser's view of a sign-in it follows, by its login id: GET /api/usage/login/prompt?login= reads
   * the CLI's screen for the page to open and the code to enter; POST /api/usage/login/code types a code the
   * page showed into the CLI, then Enter; POST /api/usage/login/cancel stops the CLI. The CLI signs in and
   * writes its own credentials; nothing here keeps or logs a code. A watching device reads no prompt (it
   * could approve a device code with its own account) and, as for every change, sends nothing.
   */
  async handlePrompt(request: Request, readOnly: boolean, owner: string | null): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const gone = () => jsonResponse({ error: { code: "login_not_found", message: "This sign-in has ended. Start it again." } }, 404);
    try {
      if (readOnly) return jsonResponse({ error: { code: "forbidden", message: "A device that only watches cannot follow a sign-in" } }, 403);
      if (pathname.endsWith("/prompt")) {
        if (request.method !== "GET") return badRequest("method_not_allowed", "Use GET");
        const login = this.owned(searchParams.get("login") ?? "", request, owner);
        if (login === undefined) return gone();
        if (login.ended) return jsonResponse({ provider: login.provider, url: null, user_code: null, wants_code: false, ended: true, succeeded: login.signedIn !== null, account: login.signedIn?.label ?? null } satisfies UsageLoginPrompt);
        login.read = true;
        return jsonResponse({ provider: login.provider, ...loginPrompt(login.provider, screenText(login.output)), ended: false } satisfies UsageLoginPrompt);
      }
      if (request.method !== "POST") return badRequest("method_not_allowed", "Use POST");
      let body: unknown;
      try { body = await request.json(); } catch { return badRequest("invalid_json", "Request body must be JSON"); }
      const id = isJsonObject(body) && typeof body["login"] === "string" ? body["login"] : "";
      const login = this.owned(id, request, owner);
      if (login === undefined) return gone();
      if (pathname.endsWith("/cancel")) {
        if (!login.ended) {
          login.cancelled = true;
          login.proc.kill();
          await login.done;
        }
        return new Response(null, { status: 204 });
      }
      if (pathname.endsWith("/code")) {
        const code = isJsonObject(body) && typeof body["code"] === "string" ? body["code"].trim() : null;
        if (code === null || !SIGN_IN_CODE.test(code)) return badRequest("invalid_code", "Paste the code the sign-in page showed, as it is");
        if (login.ended) return gone();
        if (!loginPrompt(login.provider, screenText(login.output)).wants_code) return conflictResponse("code_not_wanted", "The sign-in is not asking for a code now.");
        if (!login.proc.write(`${code}\r`)) return gone();
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private readonly settling = new Map<string, Promise<void>>();
  private settle(id: string): Promise<void> {
    const known = this.settling.get(id);
    if (known !== undefined) return known;
    const done = (async () => {
      const login = this.privates.get(id);
      if (login === undefined || login.ended) return;
      login.output = "";
      let account: LoginAccount | null = null;
      try {
        if (login.exitCode === 0 && !login.cancelled && !login.expired) account = await loginAccount(this.context, login.target, login.before);
      } catch {
        // Credential readers may fail; never put their contents in an error or leave the login held.
        console.warn("Could not identify the account after its sign-in");
      }
      login.signedIn = login.cancelled || login.expired ? null : account;
      liveLocks.delete(login.lock);
      // a CLI may have written credentials there: only an empty home goes, as for a tab that never ran its login
      if (login.madeHome !== null) {
        try { rmdirSync(login.madeHome); }
        catch (error) {
          const written = error instanceof Error && "code" in error && ["ENOTEMPTY", "EEXIST"].includes(String(error.code));
          if (written && login.cancelled) this.handedOff.add(login.madeHome);
          else if (!(written || error instanceof Error && "code" in error && error.code === "ENOENT")) console.warn("Could not remove an unused sign-in credential home", error);
        }
      }
      for (const [home, holder] of this.logins) if (isPrivate(holder) && holder.launch === login.lock) this.release(home, holder);
      for (const listener of this.endedListeners) listener(login.signedIn?.key ?? null, login.provider);
      login.ended = true;
      login.changed.resolve();
      const ended = [...this.privates].filter(([, entry]) => entry.ended);
      for (const [old] of ended.slice(0, Math.max(0, ended.length - PRIVATE_LOGINS_MAX))) { this.privates.delete(old); this.settling.delete(old); }
    })();
    this.settling.set(id, done);
    return done;
  }

  private read(file: string): Map<string, Holder> {
    const found = new Map<string, Holder>();
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return found;
      throw new LoginStateUnreadable(file, error);
    }
    let saved: unknown;
    try { saved = JSON.parse(text); } catch (error) { throw new LoginStateUnreadable(file, error); }
    if (!isJsonObject(saved) || !Array.isArray(saved["logins"])) throw new LoginStateUnreadable(file, "no list of sign-ins");
    for (const entry of saved["logins"]) {
      if (!isJsonObject(entry) || typeof entry["home"] !== "string") throw new LoginStateUnreadable(file, "a sign-in without its home");
      const { home, pane, terminal, launch, pid, at } = entry;
      if (typeof pane === "string" && typeof terminal === "string") found.set(home, { pane, terminal });
      else if (entry["private"] === true && typeof launch === "string" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof at === "number" && Number.isFinite(at)) {
        const birth = parseBirth(entry["birth"]);
        if (entry["birth"] !== undefined && birth === null) throw new LoginStateUnreadable(file, "a sign-in with an unreadable process identity");
        found.set(home, { launch, pid, at, private: true, ...(birth ? { birth } : {}) });
      }
      else if (typeof launch === "string" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof at === "number" && Number.isFinite(at)) found.set(home, { launch, pid, at });
      else throw new LoginStateUnreadable(file, "a sign-in it cannot tell");
    }
    return found;
  }

  private edit<T>(change: (saved: Map<string, Holder>) => T): T {
    const file = this.file;
    if (file === null) return change(new Map());
    return withOwnerGuard(file, () => {
      const saved = this.read(file);
      const before = JSON.stringify([...saved]);
      const result = change(saved);
      if (JSON.stringify([...saved]) !== before) {
        const written = writePrivateState(file, { logins: [...saved].map(([home, holder]) => ({ home, ...holder })) });
        // a rename the directory did not record may be gone after a crash (Windows does not sync a directory)
        if (!written.directorySynced && process.platform !== "win32") throw new Error(`${file} was written, but its directory could not be synced`);
      }
      return result;
    });
  }

  private release(home: string, holder: Holder): void {
    if (this.logins.get(home) === holder) this.logins.delete(home);
    try { this.edit((saved) => { const now = saved.get(home); if (now !== undefined && sameHolder(now, holder)) saved.delete(home); }); }
    catch (error) { console.warn("Could not free a sign-in's credential home for other servers", error); }
  }

  private async holds(holder: Holder): Promise<boolean> {
    if (isLaunch(holder)) return Date.now() - holder.at <= LAUNCH_MS && processAlive(holder.pid);
    if (isPrivate(holder)) {
      if (liveLocks.has(holder.launch)) return true;
      return holder.pid !== process.pid && !ownerGone(holder);
    }
    try { return (await sessionSnapshot()).panes.some((pane) => pane.terminal_id === holder.terminal); }
    catch { return true; }
  }

  private async reserve(home: string): Promise<Launch | null> {
    let ended: Holder | undefined;
    for (;;) {
      const own = this.logins.get(home);
      if (own !== undefined) {
        if (await this.holds(own)) return null;
        this.release(home, own);
        continue;
      }
      const launch: Launch = { launch: randomUUID(), pid: process.pid, at: Date.now() };
      let holder: Holder | undefined;
      try {
        holder = this.edit((saved) => {
          const found = saved.get(home);
          if (found !== undefined && !(ended !== undefined && sameHolder(found, ended))) return found;
          saved.set(home, launch);
          return undefined;
        });
      } catch (error) {
        if (!(error instanceof LoginStateUnreadable)) this.release(home, launch);
        throw error;
      }
      if (holder === undefined) { this.logins.set(home, launch); return launch; }
      if (await this.holds(holder)) return null;
      ended = holder;
    }
  }

  async handle(request: Request, trackPane?: (paneId: string) => void, owner: string | null = null): Promise<Response> {
    const executableFor = (id: UsageProviderId) => LOGIN[id].binaries.map((cli) => Bun.which(cli, { PATH: this.env["PATH"] ?? "" })).find(Boolean);
    if (request.method === "GET") {
      const id = new URL(request.url).searchParams.get("provider");
      if (id !== null) {
        const provider = USAGE_PROVIDERS.find((provider) => provider.id === id);
        if (!provider) return badRequest("invalid_provider", "Unknown usage provider");
        try {
          const found = await provider.signIns(this.context);
          return jsonResponse({ accounts: found.map((signIn) => signIn.account?.label ?? signIn.account?.id ?? null) });
        } catch (error) { return errorResponse(error); }
      }
      return jsonResponse({ providers: USAGE_PROVIDERS.map(({ id }) => ({
        id, cli: LOGIN[id].cli, installed: Boolean(executableFor(id)), local: LOGIN[id].args !== null,
        separate_home: id === "claude" || id === "codex",
      })) });
    }
    if (request.method !== "POST") return badRequest("method_not_allowed", "Use GET or POST");
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "Request body must be JSON"); }
    const provider = isJsonObject(body) ? USAGE_PROVIDERS.find(({ id }) => id === body["provider"]) : undefined;
    if (!provider || !isJsonObject(body)) return badRequest("invalid_provider", "Unknown usage provider");
    const id = provider.id;
    const separate = id === "claude" || id === "codex";
    // Signing in again names a listed account by its key; its credential home is the server's to find.
    const again = body["account"] !== undefined;
    const asDefault = body["default"] !== undefined;
    // followed in the browser: the CLI runs in this server's own PTY, not a herdr tab (Claude Code and Codex)
    const follow = body["follow"] !== undefined;
    if (follow && (body["follow"] !== true || !separate)) return badRequest("invalid_provider", "Only Claude Code and Codex sign in from the browser");
    if (follow && owner === null) return jsonResponse({ error: { code: "forbidden", message: "Sign in from an authenticated device" } }, 403);
    if (follow && this.stopped) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
    if (asDefault) {
      if (!separate || again || body["default"] !== true || body["name"] !== undefined || (body["replace"] !== undefined && body["replace"] !== true)) {
        return badRequest("invalid_account", "Only Claude and Codex sign in to their own home this way, without a name");
      }
    } else if (again) {
      if (!separate || typeof body["account"] !== "string" || body["account"].length > 256 || body["name"] !== undefined || body["replace"] !== undefined) {
        return badRequest("invalid_account", "Name one account this PC lists to sign in to it again");
      }
    } else if (separate ? typeof body["name"] !== "string" || !/^[a-z0-9-]{1,32}$/.test(body["name"])
      : body["name"] !== undefined || (body["replace"] !== undefined && body["replace"] !== true)) {
      return badRequest("invalid_account_name", "Use 1–32 lowercase letters, numbers or hyphens for the account name");
    }
    const login = LOGIN[id];
    if (login.args === null) return conflictResponse("login_not_supported", "Sign in interactively in Antigravity on the server PC");
    // POSIX exec lets herdr's pane-ended event identify completion, without a second watcher.
    const executable = executableFor(id);
    if (!executable) return conflictResponse("cli_unavailable", "Install the official CLI on this PC before signing in");
    let unusedCredentialHome: string | null = null;
    let reserved: string | null = null;
    let holding: Holder | null = null;
    try {
      const found = again && typeof body["account"] === "string" ? await localSignInPlace(this.context, body["account"]) : null;
      if (again && found?.provider !== id) {
        return jsonResponse({ error: { code: "account_not_found", message: "This PC no longer lists that account. Refresh and try again." } }, 404);
      }
      if (found && "ambiguous" in found) {
        return conflictResponse("account_ambiguous", "This account is signed in in more than one credential folder on this PC, so Ovis cannot tell which one to renew. Sign in again from a terminal in the folder you want.");
      }
      const place = found;
      // a default home holding the CLI's credential file has a sign-in, even one this server cannot read; and
      // any sign-in found asks too: discovery can stop at another account's home before the default one's
      // keychain item (Codex on macOS), so a found one never proves the default home empty
      const defaultDir = resolve(this.home, id === "claude" ? ".claude" : ".codex");
      const replacesDefault = asDefault && (existsSync(join(defaultDir, id === "claude" ? ".credentials.json" : "auth.json"))
        || (await provider.signIns(this.context)).length > 0);
      if (!asDefault && !separate && !again && body["replace"] !== true && (await provider.signIns(this.context)).length > 0
        || replacesDefault && body["replace"] !== true) {
        return conflictResponse("account_confirmation_required", "Confirm before signing in again to this provider");
      }
      let loginHome: string;
      try {
        loginHome = place || asDefault ? `${id}:${canonicalPath(place?.home.kind === "dir" ? place.home.dir : join(this.home, id === "claude" ? ".claude" : ".codex"))}`
          : separate ? `${id}:${canonicalPath(join(this.home, `.${id}-${body["name"]}`))}` : id;
      } catch (error) {
        console.warn("Could not tell which credential home a sign-in would write", error);
        return conflictResponse("credential_home_unreadable", "Ovis cannot read this account's credential folder, so it cannot tell whether a sign-in is already running there. Check the folder's permissions on the server PC.");
      }
      try { holding = await this.reserve(loginHome); }
      catch (error) {
        if (!(error instanceof LoginStateUnreadable)) throw error;
        console.warn("Could not read the sign-ins running in herdr tabs", error);
        return conflictResponse("login_state_unreadable", "Ovis cannot read its record of the sign-ins running on this PC (usage-logins.json in its state folder), so it cannot tell whether one is already open for this account. Close any sign-in tab still open, then repair or remove that file on the server PC.");
      }
      if (holding === null) {
        return conflictResponse("login_in_progress", "A sign-in to this account is already open. Finish or close it first.");
      }
      reserved = loginHome;
      const cliEnv: Record<string, string> = { HOME: this.home, ...(process.platform === "win32" ? { USERPROFILE: this.home } : {}) };
      for (const [name, value] of Object.entries(this.env)) {
        if (value !== undefined && /^(PATH|PATHEXT|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_.*|TERM|COLORTERM|TZ|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME)$/.test(name)) cliEnv[name] = value;
      }
      const help = Bun.spawn([executable, ...(id === "claude" ? ["auth"] : login.args), "--help"], {
        env: follow ? cliEnv : this.env, stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(10_000),
      });
      const text = await new Response(help.stdout).text();
      const success = await help.exited === 0;
      const manual = id === "claude" && !(success && /\blogin\b/.test(text));
      const device = (id === "codex" || id === "grok") && success && text.includes("--device-auth");
      const args = manual ? [] : [...login.args, ...(device ? ["--device-auth"] : [])];
      if (request.signal.aborted || (follow && this.stopped)) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
      const env: Record<string, string> = { HOME: this.home };
      if (process.platform === "win32") env["USERPROFILE"] = this.home;
      const homeVariable = id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const againHome = place?.home.kind === "dir" ? place.home.dir : null;
      if (place) {
        if (againHome !== null) env[homeVariable] = againHome;
      } else if (separate && !asDefault) {
        const credentialHome = join(this.home, `.${id}-${body["name"]}`);
        try { mkdirSync(credentialHome, { mode: 0o700 }); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          if (!this.handedOff.delete(credentialHome)) return conflictResponse("account_exists", "That account name already has a credential home. Choose another name.");
        }
        unusedCredentialHome = credentialHome;
        env[id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = credentialHome;
      }
      if (id === "copilot") env["XDG_CONFIG_HOME"] = this.env["XDG_CONFIG_HOME"] || join(this.home, ".config");
      if (id === "cursor") env["NO_OPEN_BROWSER"] = "1";
      if (id === "copilot" && this.env["GH_CONFIG_DIR"]) env["GH_CONFIG_DIR"] = this.env["GH_CONFIG_DIR"];
      if (id === "opencode") env["XDG_DATA_HOME"] = this.env["XDG_DATA_HOME"] || join(this.home, ".local", "share");
      if (follow && owner !== null) {
        // a CLI the browser cannot follow: an old Claude Code without `auth login` signs in inside the agent, and
        // a Codex without a device code answers on this PC's own localhost, out of a remote browser's reach
        if (manual || (id === "codex" && !device)) return conflictResponse("follow_unsupported", "This version signs in only in a terminal.");
        // Only CLI runtime settings, never the bridge's tokens, agent hooks or provider API keys.
        const procEnv: Record<string, string> = { ...cliEnv, ...env, BROWSER: "true" };
        if (againHome !== null) procEnv[homeVariable] = resolve(againHome);
        if ((place || asDefault) && againHome === null) delete procEnv[homeVariable];
        const homeDir = procEnv[homeVariable];
        const target: LoginTarget = { provider: id === "claude" ? "claude" : "codex", home: homeDir ? { kind: "dir", dir: homeDir } : { kind: "default" } };
        const before = await homeBefore(this.context, target);
        if (request.signal.aborted || this.stopped) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
        const loginId = randomUUID();
        const lock = randomUUID();
        const { birth } = newOwnerRecord();
        const privateHolder: PrivateHolder = { launch: lock, pid: process.pid, at: Date.now(), private: true, ...(birth ? { birth } : {}) };
        const home = reserved;
        const launch = holding;
        const recorded = this.edit((saved) => {
          const now = saved.get(home);
          if (now !== undefined && !sameHolder(now, launch)) return false;
          saved.set(home, privateHolder);
          return true;
        });
        if (!recorded) return conflictResponse("login_in_progress", "A sign-in to this account is already open. Finish or close it first.");
        holding = privateHolder;
        this.logins.set(home, privateHolder);
        liveLocks.add(lock);
        let proc: PtySession;
        try {
          proc = new PtySession({
            command: executable, args, env: procEnv, inheritEnv: false,
            cols: PRIVATE_COLUMNS, rows: 50,
            onData: (data) => {
              const login = this.privates.get(loginId);
              if (login !== undefined && !login.ended) {
                const bytes = Buffer.from(login.output + data);
                let start = Math.max(0, bytes.length - PRIVATE_OUTPUT_MAX);
                while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
                login.output = bytes.subarray(start).toString("utf8");
                login.changed.resolve();
                login.changed = Promise.withResolvers<void>();
              }
            },
            onExit: (code) => {
              const login = this.privates.get(loginId);
              if (login !== undefined) login.exitCode = code;
            },
          });
        } catch (error) {
          liveLocks.delete(lock);
          console.warn("Could not start a sign-in in a private terminal", error instanceof Error ? error.message : String(error));
          return conflictResponse("follow_unsupported", "This server cannot run a sign-in here. Use a terminal instead.");
        }
        const done = proc.exited.then(() => this.settle(loginId));
        const secret = randomUUID();
        this.privates.set(loginId, {
          provider: target.provider, target, before,
          exitCode: null, signedIn: null, owner, secret, cancelled: false, expired: false, lock, done,
          changed: Promise.withResolvers<void>(), read: false, madeHome: unusedCredentialHome, proc, output: "", ended: false,
        });
        unusedCredentialHome = null;
        reserved = null;
        const expire = () => { const login = this.privates.get(loginId); if (login !== undefined && !login.ended) login.expired = true; proc.kill(); };
        const lease = setTimeout(() => { const login = this.privates.get(loginId); if (login !== undefined && !login.read && !login.ended) expire(); }, this.timing.leaseMs);
        const deadline = setTimeout(expire, this.timing.maxMs);
        void done.then(() => { clearTimeout(lease); clearTimeout(deadline); });
        if (request.signal.aborted) { proc.kill(); return conflictResponse("request_cancelled", "The sign-in request was cancelled"); }
        const answer = jsonResponse({ login_id: loginId, device_auth: device } satisfies UsageLoginFollowed);
        answer.headers.append("set-cookie", `${signInCookie(loginId)}=${secret}; Path=/api/usage/login; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(this.timing.maxMs / 1000)}${isSecureRequest(request) ? "; Secure" : ""}`);
        return answer;
      }
      const snapshot = await sessionSnapshot();
      if (request.signal.aborted) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
      const workspace = snapshot.workspaces[0];
      const options = {
        cwd: againHome !== null && !isAbsolute(againHome) ? process.cwd() : this.home, label: again ? `${id} sign-in again` : `${id} sign-in${separate && !asDefault ? ` · ${body["name"]}` : ""}`, env,
      };
      const created = workspace ? await tabCreate({ ...options, workspaceId: workspace.workspace_id }) : await workspaceCreate(options);
      const paneId = created.root_pane.pane_id;
      this.panes.set(paneId, id);
      trackPane?.(paneId);
      const launch = holding;
      const opened: LoginHolder = { pane: paneId, terminal: created.root_pane.terminal_id };
      const home = reserved;
      let recorded = false;
      try {
        recorded = this.edit((saved) => {
          const now = saved.get(home);
          if (now !== undefined && !sameHolder(now, launch)) return false;
          saved.set(home, opened);
          return true;
        });
      } catch (error) {
        this.release(home, opened);
        await paneClose(paneId).catch((closeError: unknown) => console.warn("Could not close a sign-in tab whose login was not sent", closeError));
        throw error;
      }
      if (!recorded) {
        await paneClose(paneId).catch((closeError: unknown) => console.warn("Could not close a sign-in tab whose login was not sent", closeError));
        return conflictResponse("login_in_progress", "A sign-in to this account is already open in a terminal tab. Finish or close it first.");
      }
      holding = opened;
      if (this.logins.get(home) === launch) this.logins.set(home, opened);
      if (process.platform === "win32") {
        const info = await paneProcessInfo(paneId);
        const shell = paneShell(info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe");
        const command = `${place || asDefault ? credentialHomePrefix(shell, homeVariable, againHome) : ""}${shellCommandLine(shell, executable, args)}`;
        await paneSendText(paneId, `${command}${shell === "cmd" ? " & exit" : "; exit $LASTEXITCODE"}`);
        unusedCredentialHome = null;
        await paneSendKeys(paneId, ["Enter"]);
      } else {
        await paneSendText(paneId, `${manual ? "printf 'Type /login in Claude to sign in.\\n'; " : ""}exec ${place || asDefault ? credentialHomePrefix("posix", homeVariable, againHome) : ""}${shellCommandLine("posix", executable, args)}\n`);
        unusedCredentialHome = null;
      }
      reserved = null;
      return jsonResponse({
        pane_id: paneId, workspace_id: created.tab.workspace_id, manual, device_auth: device,
      } satisfies UsageLoginStarted);
    } catch (error) {
      return errorResponse(error);
    } finally {
      if (unusedCredentialHome) {
        try { rmdirSync(unusedCredentialHome); }
        catch (cleanupError) {
          // A CLI may already have written credentials; never remove a nonempty home.
          if (!(cleanupError instanceof Error && "code" in cleanupError
            && ["ENOTEMPTY", "EEXIST", "ENOENT"].includes(String(cleanupError.code)))) {
            console.warn("Could not remove unused sign-in credential home", cleanupError);
          }
        }
      }
      if (reserved !== null && holding !== null) this.release(reserved, holding);
    }
  }
}
