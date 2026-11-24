/**
 * The ACP children this server runs: each agent Ovis drives over ACP runs under its own keeper (crates/acp-keeper) in a
 * herdr-core terminal of this PC, which sits under its parent's terminal (G1) and is labelled `ovis.acp` with the
 * child's id. The keeper's ROOT is `<state>/acp/<id>`, private to this user, and this server is the keeper's ACP client
 * (KeeperClient). Stopping the server closes the clients but leaves the keepers: a keeper keeps its turn across an Ovis
 * restart, and the next start re-attaches to it (`restore`). Only this server's own ROOTs and the terminals they name are
 * ever touched.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HcMethods } from "../herdr-core/hc-api.generated.ts";
import { coreConnection, hcMachine } from "../herdr-core/runtime.ts";
import { capabilities } from "../runtime/capabilities.ts";
import { KeeperClient, keeperRunning } from "./client.ts";
import { acpKeeperBin } from "./keeper-bin.ts";

type AcpHcMethod = "terminal.run" | "terminal.kill" | "terminal.list";
/** The hc calls the registry makes (HcConnection, or a test's stand-in). */
export interface AcpHc {
  call<M extends AcpHcMethod>(method: M, params: HcMethods[M]["params"]): Promise<HcMethods[M]["result"]>;
}

export interface AcpStart {
  /** the agent kind, as a card names it */
  harness: string;
  /** the agent's command line, passed to the keeper as it is */
  argv: readonly string[];
  cwd: string;
  /** the terminal (pane) the child sits under */
  parentPane?: string;
  /** the keeper's name for the agent, on its status line (default the harness) */
  name?: string;
  /** `_meta` of the keeper's `session/new` (the Claude adapter takes its model and settings this way) */
  sessionMeta?: unknown;
  /** the terminal's environment over the core's */
  env?: Record<string, string>;
}

export interface AcpChild {
  id: string;
  harness: string;
  root: string;
  /** the keeper's terminal, which is its pane */
  terminal: string;
  client: KeeperClient;
}

export class AcpUnavailable extends Error {
  constructor(readonly reason: "not_local" | "no_keeper" | "path_too_long", message: string) {
    super(message);
    this.name = "AcpUnavailable";
  }
}

export class AcpStartFailed extends Error {
  constructor(readonly reason: "no_socket" | "no_session" | "agent_exited", message: string) {
    super(message);
    this.name = "AcpStartFailed";
  }
}

export interface AcpChildrenOptions {
  /** default this server's core (coreConnection) */
  hc?: AcpHc;
  keeperBin?: () => string | null;
  /** how long a start waits for the keeper's socket */
  socketMs?: number;
  /** how long a start waits for the agent's session (its answers to `initialize` and `session/new`) */
  sessionMs?: number;
}

const LABEL = "ovis.acp";
const CHILD_FILE = "child.json";
/** Under the shortest limit on a socket's path (104 bytes on macOS), with room for its terminating byte. */
const SOCKET_PATH_MAX = 100;
const SOCKET_MS = 10_000;
const SESSION_MS = 30_000;

/** Waits, bounded, for the keeper to create its socket in `root`: a file it makes, watched rather than polled. */
function socketAppears(root: string, ms: number): Promise<boolean> {
  const socket = join(root, "acp.sock");
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const watcher = watch(root, () => { if (existsSync(socket)) done(true); });
  const timer = setTimeout(() => done(false), ms);
  function done(appeared: boolean) {
    clearTimeout(timer);
    watcher.close();
    resolve(appeared);
  }
  if (existsSync(socket)) done(true);
  return promise;
}

/** Waits, bounded, for the agent's session, or for the agent to end first. */
function sessionOpens(client: KeeperClient, ms: number): Promise<"open" | "exited" | "late"> {
  const state = () => client.session !== null ? "open" : client.agentGone || client.keeperGone ? "exited" : null;
  const now = state();
  if (now !== null) return Promise.resolve(now);
  const { promise, resolve } = Promise.withResolvers<"open" | "exited" | "late">();
  const timer = setTimeout(() => { off(); resolve("late"); }, ms);
  const off = client.onChange(() => {
    const reached = state();
    if (reached === null) return;
    clearTimeout(timer);
    off();
    resolve(reached);
  });
  return promise;
}

function owned(path: string, kind: "directory" | "file"): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat !== undefined && (process.getuid === undefined || stat.uid === process.getuid()) && (kind === "directory" ? stat.isDirectory() : stat.isFile());
}

function harnessOf(root: string): string | null {
  try {
    if (!owned(root, "directory") || !owned(join(root, CHILD_FILE), "file")) return null;
    const harness = (JSON.parse(readFileSync(join(root, CHILD_FILE), "utf8")) as { harness?: unknown }).harness;
    return typeof harness === "string" && harness !== "" ? harness : null;
  } catch {
    return null;
  }
}

export class AcpChildren {
  private readonly children = new Map<string, AcpChild>();

  constructor(private readonly dir: string, private readonly options: AcpChildrenOptions = {}) {}

  private hc(): AcpHc {
    return this.options.hc ?? coreConnection();
  }

  /** ACP children run only on this PC's own herdr-core: hc's terminals elsewhere are another machine's. */
  private refusal(): AcpUnavailable | null {
    return capabilities().acpChildren && hcMachine() === null ? null : new AcpUnavailable("not_local", "ACP children run only on this PC's herdr-core");
  }

  /** The folder the ROOTs live in, made private to this user; one that is there already must be this user's own. */
  private folder(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!owned(this.dir, "directory")) throw new Error(`${this.dir} is not a folder of this account`);
    chmodSync(this.dir, 0o700);
  }

  async start(start: AcpStart): Promise<AcpChild> {
    const refused = this.refusal();
    if (refused !== null) throw refused;
    const bin = (this.options.keeperBin ?? acpKeeperBin)();
    if (bin === null) throw new AcpUnavailable("no_keeper", "no ACP keeper is installed or built");
    const id = randomBytes(6).toString("hex");
    const root = join(this.dir, id);
    if (Buffer.byteLength(join(root, "acp.sock")) > SOCKET_PATH_MAX) throw new AcpUnavailable("path_too_long", `the keeper's socket under ${this.dir} would pass the OS's limit on a socket's path`);
    this.folder();
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    writeFileSync(join(root, CHILD_FILE), JSON.stringify({ harness: start.harness }), { mode: 0o600 });
    const argv = [
      bin, root, "--cwd", start.cwd, "--name", start.name ?? start.harness,
      ...(start.sessionMeta === undefined ? [] : ["--session-meta", JSON.stringify(start.sessionMeta)]),
      "--", ...start.argv,
    ];
    let terminal: string;
    try {
      ({ address: terminal } = await this.hc().call("terminal.run", {
        argv, cwd: start.cwd,
        ...(start.parentPane === undefined ? { no_parent: true } : { parent: start.parentPane }),
        labels: { [LABEL]: id },
        ...(start.env === undefined ? {} : { env: start.env }),
      }));
    } catch (error) {
      const live = await this.liveTerminals().catch((lookupError: unknown) => {
        console.warn(`acp: keeping ${root} after terminal lookup failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`);
        return null;
      });
      if (live !== null) {
        const address = live.get(id);
        if (address !== undefined) await this.endFailedStart(address, root);
        else rmSync(root, { recursive: true, force: true });
      }
      throw error;
    }
    const failed = async (reason: AcpStartFailed["reason"], message: string, client?: KeeperClient): Promise<never> => {
      client?.close();
      await this.endFailedStart(terminal, root);
      throw new AcpStartFailed(reason, message);
    };
    if (!(await socketAppears(root, this.options.socketMs ?? SOCKET_MS))) return failed("no_socket", "the ACP keeper did not open its socket");
    const client = new KeeperClient(root);
    const opened = await sessionOpens(client, this.options.sessionMs ?? SESSION_MS);
    if (opened === "late") return failed("no_session", "the agent did not open a session (no answer to initialize or session/new)", client);
    if (opened === "exited") return failed("agent_exited", "the agent ended before its session opened", client);
    return this.add({ id, harness: start.harness, root, terminal, client });
  }

  private async liveTerminals(): Promise<Map<string, string>> {
    const { terminals } = await this.hc().call("terminal.list", {});
    return new Map(terminals.flatMap((terminal) => {
      const id = terminal.labels[LABEL];
      return id !== undefined && terminal.state === "live" ? [[id, terminal.address] as const] : [];
    }));
  }

  private add(child: AcpChild): AcpChild {
    this.children.set(child.id, child);
    // a keeper that ended by itself (Ctrl+Q in its pane, its terminal closed) takes its child along
    const off = child.client.onChange(() => {
      if (!child.client.keeperGone || this.children.get(child.id) !== child) return;
      off();
      this.children.delete(child.id);
      if (!keeperRunning(child.root)) rmSync(child.root, { recursive: true, force: true });
    });
    return child;
  }

  /** The child whose keeper runs in `paneId`'s terminal. */
  forPane(paneId: string): AcpChild | undefined {
    for (const child of this.children.values()) if (child.terminal === paneId) return child;
    return undefined;
  }

  /** Kills the keeper's terminal (the keeper ends its agent with it); ROOT goes once the terminal is gone. */
  private async end(terminal: string, root: string): Promise<void> {
    await this.hc().call("terminal.kill", { terminal });
    rmSync(root, { recursive: true, force: true });
  }

  private async endFailedStart(terminal: string, root: string): Promise<void> {
    try {
      await this.end(terminal, root);
    } catch (error) {
      // a ROOT whose terminal may still run stays: restore() removes it once its keeper is gone
      console.warn(`acp: could not end ${terminal}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops a child: the running turn is cancelled, then its terminal is killed and it is forgotten. */
  async stop(id: string): Promise<void> {
    const child = this.children.get(id);
    if (child === undefined) return;
    const { client } = child;
    if (client.turn?.running && client.session !== null) client.notify("session/cancel", { sessionId: client.session });
    await this.end(child.terminal, child.root);
    client.close();
    if (this.children.get(id) === child) this.children.delete(id);
  }

  /**
   * At the server's start: re-attaches to every live terminal labelled with one of this server's ROOTs (the client
   * replays its keeper's log from the start), and removes the ROOTs no live terminal names whose keeper is gone.
   */
  async restore(): Promise<void> {
    if (this.refusal() !== null || !owned(this.dir, "directory")) return;
    const live = await this.liveTerminals();
    for (const id of readdirSync(this.dir)) {
      const root = join(this.dir, id);
      if (!/^[a-f0-9]{12}$/.test(id)) continue;
      const harness = harnessOf(root);
      if (harness === null) continue;
      const terminal = live.get(id);
      if (terminal !== undefined) {
        if (!this.children.has(id)) this.add({ id, harness, root, terminal, client: new KeeperClient(root) });
      } else if (!keeperRunning(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  /** The server stops: its clients close, and the keepers go on with their turns. */
  close(): void {
    for (const child of this.children.values()) child.client.close();
    this.children.clear();
  }
}
