/**
 * Claude Code's command approvals through its own PermissionRequest hook, for a Claude Ovis starts on this PC.
 *
 * Such a Claude gets a command hook (its `--settings`, in a 0600 file) that runs `ovis-server claude-hook`
 * (server/claude-hook-relay.ts) for each Bash permission request. The relay posts it to a socket in a 0700 folder of
 * this server's state, which no other account can open, with a token that names the pane the Claude was started in. A
 * loopback port would not do: once this server stopped, another account could take the port and answer for it. The
 * socket's path stays the same across restarts, and a request for a token a restarted server does not know gets no
 * decision. Windows has no such socket here, so a Claude there keeps the keys, as pi-ask does. The request is held open while the card shows it: the card reads the whole command from it rather than from the
 * screen, and a Yes or No from the card is the hook's answer, not keys. Measured on Claude Code 2.1.330:
 * - the terminal draws its own dialog while the hook waits, and whichever answers first wins;
 * - answered in the terminal, the hook's request stays open and a later answer to it is ignored, so a request the
 *   screen no longer shows is released here (answered with no decision);
 * - a hook that ends with no decision leaves the terminal's dialog as it is, at once.
 * So every card still has its keys: the hook is only how a Yes or No goes when it holds the very request on screen.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { settingsFile } from "./claude-settings-file.ts";
import { COMPILED, entryCommand, ROOT } from "./entries.ts";
import { jsonResponse } from "./http.ts";

export type PermissionDecision = "allow" | "deny";

export interface HeldPermission {
  /** what a card built on this request carries in its id, so that its answer settles this request and no other */
  id: string;
  command: string;
  description: string | null;
}

interface Pending {
  nonce: string;
  command: string;
  description: string | null;
  at: number;
  settle: (decision: PermissionDecision | null) => void;
}

const PATH = "/claude/permission";
const BODY_MAX = 256 * 1024;
/** A read of the screen just before Claude draws its dialog must not release the hook it sent with it. */
const GRACE_MS = 3_000;
/** Claude Code's own default for a command hook: past it Claude has stopped waiting on the request. */
const HELD_MS = 600_000;
/** Under the shortest limit on a socket's path (104 bytes on macOS), with room for its terminating byte. */
const SOCKET_PATH_MAX = 100;
const PANES_MAX = 256;
/** The most of a card's body the bridge and the card show (finishPrompt, promptWords). */
const CARD_BODY_MAX = 12_000;

const spaced = (text: string): string => text.trim().replace(/\s+/g, " ");
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a Bash dialog whose panel shows `screen` as its command shows this command, whole. Runs of white space count
 * as one; a line break on the screen is where the pane wrapped, which takes the space it broke at, or breaks a word.
 */
function shows(screen: string, command: string): boolean {
  const lines = screen.split("\n").map(spaced).filter(Boolean);
  return lines.length > 0 && new RegExp(`^${lines.map(literal).join(" ?")}$`).test(spaced(command));
}

/**
 * Whether the card can show this text as it is: no control character but newline and tab, no format character (bidi
 * controls, zero-width ones) or separator that draws a line break, no lone surrogate, and no run of blank lines or of
 * spaces long enough to push the rest out of sight.
 */
export function showable(text: string): boolean {
  return !/(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(text) && !/(?:^|\n)(?:[^\S\n]*\n){3}/.test(text) && !/[^\S\n]{40,}/.test(text);
}

/** Computed from the command and words again at each answer: the card's answer settles a request only while it holds what the card showed. */
const idOf = (entry: Pending): string =>
  createHash("sha256").update(JSON.stringify([entry.nonce, entry.command, entry.description])).digest("hex").slice(0, 16);

/** Yes allows and No declines; any other option of the dialog goes as its keys. */
export function permissionDecision(label: string): PermissionDecision | null {
  return label === "Yes" ? "allow" : /^No\b/.test(label) ? "deny" : null;
}

export class ClaudePermissionHooks {
  private listener: ReturnType<typeof Bun.serve> | null = null;
  private readonly panes = new Map<string, string>();
  private readonly pending = new Map<string, Pending[]>();

  private readonly socket: string;

  constructor(private readonly dir: string, private readonly options: {
    now?: () => number; heldMs?: number; onHeld?: (paneId: string) => void; onSettled?: (paneId: string) => void; platform?: string;
    /** what the hook runs, before its own arguments */
    relay?: readonly string[];
  } = {}) {
    this.socket = join(dir, "hub.sock");
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private listen(): void {
    if (this.listener !== null) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // a folder that was there already is narrowed only when it is this account's own, never through a link
    const folder = lstatSync(this.dir);
    if (!folder.isDirectory() || folder.uid !== process.getuid?.()) throw new Error(`${this.dir} is not a folder of this account`);
    chmodSync(this.dir, 0o700);
    // a settings file names a token of an earlier run of this server, which nothing here answers any more, and the
    // socket of that run is in the way of this one's
    for (const name of readdirSync(this.dir)) if (name.endsWith(".json") || name === "hub.sock") rmSync(join(this.dir, name), { force: true });
    // Bun gives a socket the umask's mode, as for the machine profile's owner socket (server/index.ts)
    const umask = process.umask(0o077);
    try {
      this.listener = Bun.serve({
        unix: this.socket,
        fetch: (request, server) => {
          // no idle cut (Bun's default is 10 s): a request waits as long as its card does
          server.timeout(request, 0);
          return this.receive(request);
        },
      });
      chmodSync(this.socket, 0o600);
    } finally {
      process.umask(umask);
    }
  }

  /**
   * `args` for a Claude started in `paneId`, with the hook in a `--settings` file. An inline JSON `--settings` it
   * already has (the dialog's) goes into that file with it; a `--settings` that names a file, or more than one, could
   * not be merged, and leaves `args` as they are.
   */
  launchArgs(paneId: string, args: readonly string[] | undefined): string[] | undefined {
    // whatever ran in the pane before is not this Claude
    this.forget(paneId);
    if ((this.options.platform ?? process.platform) === "win32" || Buffer.byteLength(this.socket) > SOCKET_PATH_MAX) return args === undefined ? undefined : [...args];
    const given = args ?? [];
    const end = given.indexOf("--");
    const flags = end < 0 ? given : given.slice(0, end);
    const at = flags.flatMap((arg, index) => arg === "--settings" || arg.startsWith("--settings=") ? [index] : []);
    if (at.length > 1) return args === undefined ? undefined : [...given];
    let settings: Record<string, unknown> = {};
    let replaced: { from: number; to: number } | null = null;
    if (at.length === 1) {
      const index = at[0]!;
      const inline = flags[index] === "--settings";
      const value = inline ? flags[index + 1] : flags[index]!.slice("--settings=".length);
      if (value === undefined) return [...given];
      try {
        const parsed: unknown = JSON.parse(value.trim().startsWith("{") ? value : "null");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [...given];
        settings = parsed as Record<string, unknown>;
      } catch {
        return [...given];
      }
      replaced = { from: index, to: index + (inline ? 2 : 1) };
    }
    const token = randomBytes(32).toString("base64url");
    try {
      this.listen();
    } catch (error) {
      console.error(`claude permission hook: ${error instanceof Error ? error.message : String(error)}`);
      return args === undefined ? undefined : [...given];
    }
    const [command, ...relay] = this.options.relay ?? relayCommand();
    const hooks = typeof settings["hooks"] === "object" && settings["hooks"] !== null && !Array.isArray(settings["hooks"])
      ? { ...(settings["hooks"] as Record<string, unknown>) } : {};
    const theirs = Array.isArray(hooks["PermissionRequest"]) ? hooks["PermissionRequest"] as unknown[] : [];
    // Monitor too: under a Bash-only matcher Claude Code posts a Monitor command as a Bash call, whose allow it then
    // ignores (its hooks reference, 2.1.314 on); matched by name it comes as itself, and is left to the terminal here
    hooks["PermissionRequest"] = [...theirs, {
      matcher: "Bash|Monitor",
      // exec form: no shell between Claude and the relay, on any platform
      hooks: [{ type: "command", command, args: [...relay, "--socket", this.socket, "--launch", token] }],
    }];
    let path: string;
    try {
      path = settingsFile(JSON.stringify({ ...settings, hooks }), this.dir);
    } catch (error) {
      console.error(`claude permission hook: ${error instanceof Error ? error.message : String(error)}`);
      return args === undefined ? undefined : [...given];
    }
    this.panes.set(digest(token), paneId);
    if (this.panes.size > PANES_MAX) this.panes.delete(this.panes.keys().next().value!);
    if (replaced === null) return ["--settings", path, ...given];
    return [...given.slice(0, replaced.from), "--settings", path, ...given.slice(replaced.to)];
  }

  private paneOf(authorization: string | null): string | undefined {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (token === "") return undefined;
    const key = digest(token);
    for (const [known, pane] of this.panes) {
      if (timingSafeEqual(Buffer.from(known, "hex"), Buffer.from(key, "hex"))) return pane;
    }
    return undefined;
  }

  private async receive(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== PATH) return new Response(null, { status: 404 });
    const paneId = this.paneOf(request.headers.get("authorization"));
    if (paneId === undefined) return new Response(null, { status: 401 });
    if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return new Response(null, { status: 413 });
    const text = await request.text();
    if (text.length > BODY_MAX) return new Response(null, { status: 413 });
    // the pane forgotten while the request came in (forget)
    if (this.paneOf(request.headers.get("authorization")) !== paneId) return jsonResponse({});
    let input: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown };
    try { input = JSON.parse(text) as typeof input; } catch { return new Response(null, { status: 400 }); }
    const tool = input.tool_input as { command?: unknown; description?: unknown } | null | undefined;
    // a Monitor command, or anything not a Bash command, is the terminal's: no decision
    if (input.hook_event_name !== "PermissionRequest" || input.tool_name !== "Bash" || typeof tool !== "object" || tool === null
      || typeof tool.command !== "string" || tool.command.trim() === "") return jsonResponse({});
    const command = tool.command;
    const description = typeof tool.description === "string" && tool.description.trim() !== "" ? tool.description : null;
    // a command the card could not show whole, or as it is, is the terminal's: a Yes allows only what the card showed
    const body = heldBody({ command, description });
    if (body.length > CARD_BODY_MAX || !showable(body)) return jsonResponse({});
    const decision = await new Promise<PermissionDecision | null>((resolve) => {
      const list = this.pending.get(paneId) ?? [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const entry: Pending = {
        nonce: randomBytes(16).toString("hex"), command, description, at: this.now(),
        settle: (decision) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const left = (this.pending.get(paneId) ?? []).filter((other) => other !== entry);
          if (left.length) this.pending.set(paneId, left);
          else this.pending.delete(paneId);
          resolve(decision);
          this.options.onSettled?.(paneId);
        },
      };
      list.push(entry);
      this.pending.set(paneId, list);
      timer = setTimeout(() => entry.settle(null), this.options.heldMs ?? HELD_MS);
      request.signal.addEventListener("abort", () => entry.settle(null), { once: true });
      this.options.onHeld?.(paneId);
    });
    if (decision === null) return jsonResponse({});
    return jsonResponse({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        // No, as the terminal's No: Claude stops and waits for the user
        decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "The user declined this command in Ovis.", interrupt: true },
      },
    });
  }

  private showing(paneId: string, screen: string | null): Pending[] {
    return screen === null ? [] : (this.pending.get(paneId) ?? []).filter((entry) => shows(screen, entry.command));
  }

  /**
   * What a read of `paneId` found: the command of the Bash approval on its screen (dialogs/claude.ts), or null for
   * none. A held request the screen does not show (answered in the terminal, or by another dialog) is released. The one
   * request it shows is returned, for its card to show whole. When two show the same command, both stay held and none
   * is returned: the card keeps the screen's text and its keys.
   */
  shown(paneId: string, screen: string | null): HeldPermission | null {
    const showing = this.showing(paneId, screen);
    for (const entry of this.pending.get(paneId) ?? []) {
      if (!showing.includes(entry) && this.now() - entry.at >= GRACE_MS) entry.settle(null);
    }
    const held = showing.length === 1 ? showing[0]! : null;
    return held === null ? null : { id: idOf(held), command: held.command, description: held.description };
  }

  /** The request a card built on `id` showed, while it is still held and still the one request the screen shows. */
  private bound(paneId: string, screen: string, id: string): Pending | null {
    const showing = this.showing(paneId, screen);
    return showing.length === 1 && idOf(showing[0]!) === id ? showing[0]! : null;
  }

  holds(paneId: string, screen: string, id: string): boolean {
    return this.bound(paneId, screen, id) !== null;
  }

  /** Answers the request a card built on `id` showed. False when that request is no longer bound to the card. */
  answer(paneId: string, screen: string, id: string, decision: PermissionDecision): boolean {
    const held = this.bound(paneId, screen, id);
    if (held === null) return false;
    held.settle(decision);
    return true;
  }

  /**
   * Forgets `paneId`: what a Claude started there asks is no longer this pane's (the pane moved to another ID, ended or
   * closed, and herdr reuses IDs; or another Claude starts in it). Its held requests are released with no decision,
   * and its launches' requests get none.
   */
  forget(paneId: string): void {
    for (const entry of [...(this.pending.get(paneId) ?? [])]) entry.settle(null);
    for (const [key, pane] of this.panes) if (pane === paneId) this.panes.delete(key);
  }

  stop(): void {
    // each held request gets its answer (no decision, so the terminal's dialog stands) before the listener closes
    for (const list of [...this.pending.values()]) for (const entry of list) entry.settle(null);
    if (this.listener === null) return;
    void this.listener.stop();
    this.listener = null;
    // a relay that finds no socket gives no decision at once, rather than waiting on one nothing answers
    rmSync(this.socket, { force: true });
  }
}

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * What the hook runs. Claude runs it in its working folder, the project, where a model may write files, and a Bun there
 * reads that folder's bunfig.toml (whose preload could print an allow) and .env. The compiled binary is built to read
 * neither (scripts/server-artifact.ts); from source, Bun gets Ovis's own config and no env file.
 */
export function relayCommand(root = ROOT, compiled = COMPILED): string[] {
  const [bun, entry] = entryCommand("claude-hook", root, compiled);
  return compiled ? [bun, entry] : [bun, `--config=${join(root, "bunfig.toml")}`, "--no-env-file", entry];
}

/** In the order Claude's dialog draws them. */
export function heldBody(held: Pick<HeldPermission, "command" | "description">): string {
  return held.description === null ? held.command : `${held.description}\n${held.command}`;
}
