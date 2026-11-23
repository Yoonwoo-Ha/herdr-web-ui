/**
 * The approvals an agent Ovis starts on this PC asks through its own hook, held open while a card shows them: one hub
 * for every agent, with a small adapter per agent (ApprovalAdapter) for what differs.
 *
 * The hub owns the channel and everything about a request once it arrives: the listener (a unix socket in a 0700
 * folder of this server's state, a named pipe on Windows), a key per launch that names the pane the agent was started
 * in, the held requests and their ids, releasing them, and answering them. The hook runs `ovis-server approval-hook`
 * (server/approvals/relay.ts), which seals its request with the launch's key and takes only an answer sealed with it.
 * A loopback port would not do: once this server stopped, another account could take the port and answer for it; a
 * named pipe's name can be taken the same way, which the sealing covers. The unix socket's path stays the same
 * across restarts; a request under a key a restarted server does not know gets no decision.
 *
 * Whatever the hub cannot be sure of gets no decision, and the agent's own terminal dialog stands: an agent without an
 * adapter, a version its adapter does not support (or none read), an event its adapter does not take, a command a card
 * could not show whole, and any failure of the channel.
 *
 * A held request is kept apart from any screen: `held` lists a pane's requests and `settle` answers one by its id. The
 * card a request is shown on today is the agent's dialog on the screen (Claude's Bash dialog, dialogs/claude.ts):
 * `shown`, `holds` and `answer` bind a request to the command that dialog shows, whole, and answer only while it does.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { COMPILED, entryCommand, ROOT } from "../entries.ts";
import { isNonce, keyDigest, LINE_MAX, lineObject, seal, unseal } from "./relay.ts";

export type ApprovalDecision = "allow" | "deny";

/** One approval an agent asks, as a card shows it. */
export interface ApprovalRequest {
  command: string;
  description: string | null;
}

export interface HeldApproval extends ApprovalRequest {
  /** what a card built on this request carries in its id, so that its answer settles this request and no other */
  id: string;
  /** the adapter's agent kind */
  kind: string;
}

/** What an agent's adapter fills in. Every method may refuse (null): the request is then the terminal's. */
export interface ApprovalAdapter {
  /** the agent kind it serves, as herdr names it */
  readonly kind: string;
  /** whether this version of the agent takes the hook as launchArgs adds it; an unknown version gets none */
  supports(version: string): boolean;
  /**
   * The agent's arguments with the hook added, which runs `hook.command` with `hook.args`. Files it needs go in `dir`,
   * the hub's own private folder. It never edits the user's own settings. Null leaves the launch without the hook.
   */
  launchArgs(args: readonly string[] | undefined, hook: { command: string; args: string[] }, dir: string): string[] | null;
  /** The approval an event the hook sent asks, or null for one the hub gives no decision on. */
  toCard(event: unknown): ApprovalRequest | null;
  /** The decision a card option is, or null for an option that goes to the dialog as its keys. */
  decision(label: string): ApprovalDecision | null;
  /** What the hook prints for a decision, or for none (null), after which the agent's own dialog stands. */
  toAnswer(decision: ApprovalDecision | null): string;
}

interface Launch {
  key: string;
  paneId: string;
  adapter: ApprovalAdapter;
}

interface Pending extends ApprovalRequest {
  nonce: string;
  adapter: ApprovalAdapter;
  at: number;
  settle: (decision: ApprovalDecision | null) => void;
}

/** The most of an event the hub reads, in UTF-8 bytes. */
const EVENT_MAX = 256 * 1024;
/** A read of the screen just before the agent draws its dialog must not release the hook it sent with it. */
const GRACE_MS = 3_000;
/** Claude Code's own default for a command hook: past it the agent has stopped waiting on the request. */
const HELD_MS = 600_000;
/** Under the shortest limit on a socket's path (104 bytes on macOS), with room for its terminating byte. */
const SOCKET_PATH_MAX = 100;
const LAUNCHES_MAX = 256;
/** The most of a card's body the bridge and the card show (finishPrompt, promptWords). */
const CARD_BODY_MAX = 12_000;
const SOCKET_NAME = "hub.sock";

const spaced = (text: string): string => text.trim().replace(/\s+/g, " ");
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a dialog whose panel shows `screen` as its command shows this command, whole. Runs of white space count as
 * one; a line break on the screen is where the pane wrapped, which takes the space it broke at, or breaks a word.
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

/** In the order the agent's dialog draws them. */
export function heldBody(held: ApprovalRequest): string {
  return held.description === null ? held.command : `${held.description}\n${held.command}`;
}

/** Computed from the command and words again at each answer: the card's answer settles a request only while it holds what the card showed. */
const idOf = (entry: Pending): string =>
  createHash("sha256").update(JSON.stringify([entry.nonce, entry.command, entry.description])).digest("hex").slice(0, 16);

const publicOf = (entry: Pending): HeldApproval => ({ id: idOf(entry), kind: entry.adapter.kind, command: entry.command, description: entry.description });

/**
 * Where the hub listens: the socket in its folder, or on Windows, where a socket is not offered here, a named pipe of a
 * name no other hub has. That name is new each run, so a restarted server is never at an earlier run's.
 */
export function hubAddress(dir: string, platform: string = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\ovis-approvals-${randomBytes(16).toString("hex")}` : join(dir, SOCKET_NAME);
}

/**
 * What the hook runs. The agent runs it in its working folder, the project, where a model may write files, and a Bun
 * there reads that folder's bunfig.toml (whose preload could print an allow) and .env. The compiled binary is built to
 * read neither (scripts/server-artifact.ts); from source, Bun gets Ovis's own config and no env file.
 */
export function relayCommand(root = ROOT, compiled = COMPILED): string[] {
  const [bun, entry] = entryCommand("approval-hook", root, compiled);
  return compiled ? [bun, entry] : [bun, `--config=${join(root, "bunfig.toml")}`, "--no-env-file", entry];
}

export class ApprovalHub {
  private listener: Server | null = null;
  /** stopped with the server: a launch whose version was read after that gets no hook, and opens no listener again */
  private stopped = false;
  private readonly launches = new Map<string, Launch>();
  private readonly pending = new Map<string, Pending[]>();
  private readonly adapters: ReadonlyMap<string, ApprovalAdapter>;
  private readonly platform: string;
  readonly address: string;

  constructor(private readonly dir: string, adapters: readonly ApprovalAdapter[], private readonly options: {
    now?: () => number; heldMs?: number; onHeld?: (paneId: string) => void; onSettled?: (paneId: string) => void; platform?: string;
    /** what the hook runs, before its own arguments */
    relay?: readonly string[];
  } = {}) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    this.platform = options.platform ?? process.platform;
    this.address = hubAddress(dir, this.platform);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Whether an agent of this kind asks its approvals through the hub. */
  handles(kind: string): boolean {
    return this.adapters.has(kind);
  }

  /** The decision a card option of this agent is, or null for one that goes as keys. */
  decision(kind: string, label: string): ApprovalDecision | null {
    return this.adapters.get(kind)?.decision(label) ?? null;
  }

  private listen(): void {
    if (this.listener !== null) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // a folder that was there already is narrowed only when it is this account's own, never through a link
    const folder = lstatSync(this.dir);
    const uid = process.getuid?.();
    if (!folder.isDirectory() || (uid !== undefined && folder.uid !== uid)) throw new Error(`${this.dir} is not a folder of this account`);
    chmodSync(this.dir, 0o700);
    // a settings file names a key of an earlier run of this server, which nothing here answers any more, and the
    // socket of that run is in the way of this one's
    for (const name of readdirSync(this.dir)) if (name.endsWith(".json") || name === SOCKET_NAME) rmSync(join(this.dir, name), { force: true });
    const listener = createServer((socket) => this.receive(socket));
    // a bind that fails comes as an event on the next tick (a pipe's name taken, a folder it may not bind in): no
    // hook works then, as its relay finds no answer, and the server goes on
    listener.on("error", (error) => console.error(`approval hub: ${error.message}`));
    // the socket gets the umask's mode, and node:net binds it before listen returns
    const umask = this.platform === "win32" ? null : process.umask(0o077);
    try {
      listener.listen(this.address);
      if (umask !== null) chmodSync(this.address, 0o600);
    } catch (error) {
      listener.close();
      throw error;
    } finally {
      if (umask !== null) process.umask(umask);
    }
    this.listener = listener;
  }

  /**
   * `args` for an agent of `kind`, at `version`, started in `paneId`, with its hook. Whatever ran in the pane before is
   * forgotten. An agent with no adapter, a version it does not support or none, a hub that cannot listen, and an
   * adapter that cannot add the hook leave `args` as they are.
   */
  launchArgs(kind: string, paneId: string, args: readonly string[] | undefined, version: string | null): string[] | undefined {
    this.forget(paneId);
    const unchanged = args === undefined ? undefined : [...args];
    const adapter = this.adapters.get(kind);
    if (this.stopped || adapter === undefined || version === null || !adapter.supports(version)) return unchanged;
    if (this.platform !== "win32" && Buffer.byteLength(this.address) > SOCKET_PATH_MAX) return unchanged;
    try {
      this.listen();
    } catch (error) {
      console.error(`approval hub: ${error instanceof Error ? error.message : String(error)}`);
      return unchanged;
    }
    const key = randomBytes(32).toString("base64url");
    const [command, ...relay] = this.options.relay ?? relayCommand();
    let hooked: string[] | null;
    try {
      hooked = adapter.launchArgs(args, { command: command!, args: [...relay, "--socket", this.address, "--launch", key] }, this.dir);
    } catch (error) {
      console.error(`approval hub (${kind}): ${error instanceof Error ? error.message : String(error)}`);
      return unchanged;
    }
    if (hooked === null) return unchanged;
    this.launches.set(keyDigest(key), { key, paneId, adapter });
    if (this.launches.size > LAUNCHES_MAX) this.launches.delete(this.launches.keys().next().value!);
    return hooked;
  }

  private receive(socket: Socket): void {
    let received = "";
    let read = false;
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (read) return;
      received += chunk;
      if (received.length > LINE_MAX) return void socket.destroy();
      const end = received.indexOf("\n");
      if (end < 0) return;
      read = true;
      this.request(socket, received.slice(0, end));
    });
  }

  /** One request: refused (the connection closed, no answer) unless sealed with a known launch's key. */
  private request(socket: Socket, line: string): void {
    const envelope = lineObject(line);
    const nonce = envelope?.["nonce"];
    const launch = typeof envelope?.["launch"] === "string" ? this.launches.get(envelope["launch"]) : undefined;
    if (launch === undefined || !isNonce(nonce)) return void socket.destroy();
    const event = unseal(launch.key, "request", nonce, envelope!["sealed"]);
    if (event === null || Buffer.byteLength(event) > EVENT_MAX) return void socket.destroy();
    const reply = (decision: ApprovalDecision | null) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify({ sealed: seal(launch.key, "answer", nonce, launch.adapter.toAnswer(decision)) })}\n`);
    };
    let parsed: unknown;
    try { parsed = JSON.parse(event); } catch { return void socket.destroy(); }
    const card = launch.adapter.toCard(parsed);
    // an event the adapter does not take, or a command the card could not show whole or as it is, is the terminal's: a
    // Yes allows only what the card showed
    if (card === null) return reply(null);
    const body = heldBody(card);
    if (body.length > CARD_BODY_MAX || !showable(body)) return reply(null);
    const { paneId } = launch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const entry: Pending = {
      ...card, adapter: launch.adapter, nonce: randomBytes(16).toString("hex"), at: this.now(),
      settle: (decision) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const left = (this.pending.get(paneId) ?? []).filter((other) => other !== entry);
        if (left.length) this.pending.set(paneId, left);
        else this.pending.delete(paneId);
        reply(decision);
        this.options.onSettled?.(paneId);
      },
    };
    this.pending.set(paneId, [...this.pending.get(paneId) ?? [], entry]);
    timer = setTimeout(() => entry.settle(null), this.options.heldMs ?? HELD_MS);
    // the agent ended its hook (answered in the terminal, or timed out)
    socket.on("close", () => entry.settle(null));
    this.options.onHeld?.(paneId);
  }

  /** The requests `paneId` holds, oldest first. */
  held(paneId: string): HeldApproval[] {
    return (this.pending.get(paneId) ?? []).map(publicOf);
  }

  /** Settles the request of `paneId` whose id is `id` (null: no decision). False when no such request is held. */
  settle(paneId: string, id: string, decision: ApprovalDecision | null): boolean {
    const entry = (this.pending.get(paneId) ?? []).find((candidate) => idOf(candidate) === id);
    entry?.settle(decision);
    return entry !== undefined;
  }

  private showing(paneId: string, screen: string | null): Pending[] {
    return screen === null ? [] : (this.pending.get(paneId) ?? []).filter((entry) => shows(screen, entry.command));
  }

  /**
   * What a read of `paneId` found: the command of the approval dialog on its screen, or null for none. A held request
   * the screen does not show (answered in the terminal, or by another dialog) is released. The one request it shows is
   * returned, for its card to show whole. When two show the same command, both stay held and none is returned: the
   * card keeps the screen's text and its keys.
   */
  shown(paneId: string, screen: string | null): HeldApproval | null {
    const showing = this.showing(paneId, screen);
    for (const entry of this.pending.get(paneId) ?? []) {
      if (!showing.includes(entry) && this.now() - entry.at >= GRACE_MS) entry.settle(null);
    }
    return showing.length === 1 ? publicOf(showing[0]!) : null;
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
  answer(paneId: string, screen: string, id: string, decision: ApprovalDecision): boolean {
    const held = this.bound(paneId, screen, id);
    if (held === null) return false;
    held.settle(decision);
    return true;
  }

  /**
   * Forgets `paneId`: what an agent started there asks is no longer this pane's (the pane moved to another ID, ended or
   * closed, and herdr reuses IDs; or another agent starts in it). Its held requests are released with no decision,
   * and its launches' requests get none.
   */
  forget(paneId: string): void {
    for (const entry of [...(this.pending.get(paneId) ?? [])]) entry.settle(null);
    for (const [digest, launch] of this.launches) if (launch.paneId === paneId) this.launches.delete(digest);
  }

  stop(): void {
    this.stopped = true;
    // each held request gets its answer (no decision, so the terminal's dialog stands) before the listener closes
    for (const list of [...this.pending.values()]) for (const entry of [...list]) entry.settle(null);
    if (this.listener === null) return;
    this.listener.close();
    this.listener = null;
    // a relay that finds no socket gives no decision at once, rather than waiting on one nothing answers
    if (this.platform !== "win32") rmSync(this.address, { force: true });
  }
}
