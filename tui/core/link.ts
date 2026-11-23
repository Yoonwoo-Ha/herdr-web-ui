/**
 * The terminal screen's one line to herdr-core. It opens the core's socket itself
 * (socket-transport.ts) and never starts a core: a socket that is missing or that nobody listens
 * on is NoCore, and the launcher, not this link, decides whether to start one.
 *
 * Coming up on a new line: `hello` (protocol generation 1 and every method in SCREEN_METHODS, else
 * Incompatible, naming what is missing), `events.subscribe {}` unfiltered so that `doc` events
 * arrive too, its snapshot applied to a fresh core model, then both layout documents read; the link
 * is then Online in a new epoch. A `missed` on that line takes the same resync path: a fresh model
 * from its snapshot, events at or below its seq dropped, both documents read again, and no stream
 * closed.
 *
 * The line ends on an EOF, on an event stream hc closed or that sent what cannot be read, and after
 * LINE_SILENCE_MS without an event or heartbeat. Then every channel on it hears `connection_lost`,
 * the link is Offline, and a new line is tried after RECONNECT_FIRST_MS, doubling to
 * RECONNECT_MOST_MS; the wait starts again at the first only after a line that stayed up
 * LINE_STABLE_MS. Nothing written on the old line is written again. Every state without a core
 * carries a stable `code` beside its `reason`, which is for people. Every call of the screen
 * goes through `call`, `hello` or `attach` and is refused with `offline` unless the link is Online,
 * so a call never opens a line by itself (an HcConnection would).
 *
 * Time is the caller's: the link reads the injected clock, names its deadlines (`deadlines`) and
 * acts on the due ones when the loop calls `fire`; it arms no timer of its own.
 */

import { type Channel, type ChannelHandlers, HcConnection, HcError, type HcTransport, type HelloInfo } from "../../server/herdr-core/connection.ts";
import { type CoreChange, coreModel, type HcEvent } from "../../server/herdr-core/core-model.ts";
import { type MissedSnapshot, openEventStream } from "../../server/herdr-core/event-stream.ts";
import type { DocGetResult, HcMethod, HcMethods, TerminalAttachParams } from "../../server/herdr-core/hc-api.generated.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { LAYOUT_DOC } from "../../server/herdr-core/snapshot.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { type Deadlines, LINE_SILENCE_MS, LINE_STABLE_MS, NO_DEADLINES, RECONNECT_FIRST_MS, RECONNECT_MOST_MS, setDeadline } from "../model/deadlines.ts";

/**
 * The calls the screen makes, which a core's hello must name: the event stream, documents, attach,
 * and listing, reading, labelling, starting and closing terminals (the layout's reads list them:
 * layout-ops.ts). `doc.set` is not among them: a core that writes no documents still shows the
 * screen, without layout edits (layout-ops.ts `layoutCalls`).
 */
export const SCREEN_METHODS = ["events.subscribe", "doc.get", "terminal.attach", "terminal.list", "terminal.get", "terminal.label", "terminal.run", "terminal.kill", "terminal.rm"] as const satisfies readonly HcMethod[];

/** The documents read on every new line and after every `missed`: the Herdr app's layout, then Ovis's own. */
export const LINK_DOCS = [LAYOUT_DOC, OVIS_LAYOUT_DOC] as const;

/** The HcError kind every call gets while the link is not Online. */
export const OFFLINE = "offline";

/** The names under which the link's deadlines appear in `deadlines()`. */
export const RECONNECT_DEADLINE = "reconnect";
export const SILENCE_DEADLINE = "silence";
/** due at once while an error thrown by `notify` waits to be thrown by `fire` */
export const FAILURE_DEADLINE = "failure";

/**
 * Why there is no core to talk to, from the socket transport's error kind: `no_core` (no socket file,
 * or one nobody listens on), `refused` (the test-session guard kept the user's own core out of
 * reach), `unreachable` (the socket could not be opened at all).
 */
export type NoCoreCode = "no_core" | "refused" | "unreachable";
/**
 * Why the link is Offline: a NoCoreCode when a retry found no core; else why the line ended, as
 * first known:
 * - the connection ended the line, and its own kind (HcConnection `onEnd`) says why: `closed` (EOF:
 *   the transport ended, or the connection's `closed`), `timeout` (hello, or a call on a line silent
 *   since it was sent, went unanswered), `bad_line` (an invalid frame);
 * - a call the link needs failed while the line stayed: `timeout` (unanswered, while other lines
 *   kept coming), `call_failed` (the core refused it: `events.subscribe`, either `doc.get`, a re-read);
 * - the line stayed but its event stream cannot be read on: `bad_line` (hc closed the stream, or sent
 *   a line that is not JSON or too long, a `missed` without its snapshot, a subscribe answer without one
 *   or without its channel);
 * - the link's own: `silent` (LINE_SILENCE_MS without a whole line on the event stream, reached by
 *   `fire` before any call's own timeout ended the line), `notify_failed` (the owner's `notify`
 *   threw), `link_closed` (closed by its owner, never retried).
 */
export type OfflineCode = NoCoreCode | "closed" | "timeout" | "bad_line" | "call_failed" | "silent" | "notify_failed" | "link_closed";
/** Why the core cannot serve the screen: `bad_hello` (the connection's kind for a hello it cannot speak to: another protocol generation, no framed mode) or `missing_methods`. */
export type IncompatibleCode = "bad_hello" | "missing_methods";

/**
 * Where the link stands:
 * - NoCore: no core listens on the socket (none was there, or the file is a dead core's); nothing is retried until `connect`;
 * - Connecting: a new line is being opened and brought up;
 * - Online: the line is up; `epoch` counts the lines that came up, from 1;
 * - Offline: the line ended; a new one is tried at `retryAt` on the caller's clock (null: closed by its owner, never again);
 * - Incompatible: the core cannot serve the screen (another protocol, or without `missing`); it is not tried again.
 */
export type LinkState =
  | { kind: "NoCore"; code: NoCoreCode; reason: string }
  | { kind: "Connecting" }
  | { kind: "Online"; epoch: number }
  | { kind: "Offline"; code: OfflineCode; retryAt: number | null; reason: string }
  | { kind: "Incompatible"; code: IncompatibleCode; reason: string; missing: string[] };

/**
 * What the link tells its owner, in the order it happened:
 * - `state`: the link's state changed;
 * - `snapshot`: the terminals as hc gave them, as a whole, now in a fresh core model (`connect`: the
 *   first on a new line, `seq` its subscribe answer's; `missed`: hc's snapshot after events were
 *   lost). It makes no change records: each terminal's state is read from `terminals`;
 * - `doc`: a layout document as read;
 * - `event`: one hc event above the snapshot's seq, and the change records the model made of it.
 * Each carries the epoch of the line it came from.
 */
export type LinkNotice =
  | { type: "state"; state: LinkState }
  | { type: "snapshot"; epoch: number; cause: "connect" | "missed"; seq: number; terminals: unknown[] }
  | { type: "doc"; epoch: number; name: string; doc: DocGetResult }
  | { type: "event"; epoch: number; seq: number | null; event: HcEvent; changes: CoreChange[] };

export interface LinkOptions {
  /** the core's socket, as the entry worked it out (core-socket.ts `coreSocket`) */
  socket: string;
  /** the loop's clock, in ms */
  now: () => number;
  /** what each fresh core model is made with: one on every new line and after every `missed` */
  model: Parameters<typeof coreModel>[0];
  /**
   * hears every notice, in order, the first after `openLink` returned. What it throws ends the line
   * in use (`notify_failed`), as a line that cannot be read does, and is thrown by the next `fire`
   * or `connect` (FAILURE_DEADLINE asks for that `fire` at once).
   */
  notify: (notice: LinkNotice) => void;
  /** one attempt at the socket: socket-transport.ts's own, which a test may wrap */
  connect?: (path: string) => Promise<HcTransport>;
  /** how long hello and each call of the link wait for the core: the connection's own default (10 s) unless a test shortens it */
  timeoutMs?: number;
}

/** The link as the screen uses it; `call` and `hello` stand in for an HcConnection's (seen-label.ts, layout-ops.ts). */
export interface CoreLink {
  readonly state: LinkState;
  /** One attempt at a new line now, from NoCore (a core was started) or Offline (in place of the waiting retry); then throws what `notify` threw, if anything. */
  connect(): void;
  /** Acts on what is due by the clock (a retry, or the end of a silent line), then throws what `notify` threw, if anything. */
  fire(): void;
  /** When `fire` has something to do next: RECONNECT_DEADLINE while Offline, SILENCE_DEADLINE while Online, FAILURE_DEADLINE now while `notify` threw. */
  deadlines(): Deadlines;
  call<M extends HcMethod>(method: M, params: HcMethods[M]["params"], timeoutMs?: number): Promise<HcMethods[M]["result"]>;
  hello(): Promise<HelloInfo>;
  /** Publish the current Ovis layout before settling its write; false if the line ended. */
  refreshLayout(signal?: AbortSignal): Promise<boolean>;
  /** Attaches on the current line; the channel hears `connection_lost` when that line ends, and is never reopened here. */
  attach(params: TerminalAttachParams, handlers: ChannelHandlers): Promise<{ result: HcMethods["terminal.attach"]["result"]; channel: Channel }>;
  /** Closes the event stream, then the line, and opens none again. */
  close(): Promise<void>;
}

/** What one line to the core holds. */
interface Line {
  readonly hc: HcConnection;
  /** set once, when the line ended or was given up: nothing of it is acted on after */
  over: boolean;
  /** the connection ended the line (HcConnection `onEnd`): its verdict, not a symptom of it, names the end */
  ending: boolean;
  hello: HelloInfo | null;
  events: Channel | null;
  /** 0 until the line's first resync is published */
  epoch: number;
  model: ReturnType<typeof coreModel> | null;
  /** events at or below this seq are in the model's snapshot already */
  floor: number;
  /** what the event stream said before the subscribe answer was applied, in order */
  early: ({ event: HcEvent; seq: number | null } | { missed: MissedSnapshot })[] | null;
  /** the newest resync on this line: an older one that settles later is dropped */
  round: number;
  /** The snapshot publication in progress, if a document refresh has to wait for it. */
  resyncing: Promise<void> | null;
  /** notices made while a resync reads its documents, told once it is published */
  held: ((epoch: number) => LinkNotice)[] | null;
  docs: Map<string, DocGetResult>;
  /** when the event stream last brought a line */
  heardAt: number;
  /** when the line came up (null: not yet): one that stayed up LINE_STABLE_MS was healthy */
  onlineAt: number | null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why there is no core, from the socket transport's error kind (socket-transport.ts). */
function noCoreCode(error: unknown): NoCoreCode {
  const kind = error instanceof HcError ? error.kind : null;
  return kind === "no_core" ? "no_core" : kind === "live_core_refused" ? "refused" : "unreachable";
}

/** Why the connection ended a line, from the kind it ended it for (connection.ts `end`). */
function endCode(kind: string): OfflineCode {
  if (kind === "timeout") return "timeout";
  if (kind === "bad_frame") return "bad_line";
  return "closed";
}

/**
 * Why a call the link needs failed on a line that stayed (a line the connection ended was told by
 * `onEnd` first): unanswered while other lines kept coming, or refused by the core.
 */
function callCode(error: unknown): OfflineCode {
  return error instanceof HcError && error.kind === "timeout" ? "timeout" : "call_failed";
}

/** A link to the core at `options.socket`: Connecting at once, with its first notice after this returned. */
export function openLink(options: LinkOptions): CoreLink {
  const link = new Link(options);
  link.start();
  return link;
}

class Link implements CoreLink {
  private current: LinkState = { kind: "Connecting" };
  private line: Line | null = null;
  private epochs = 0;
  private delay = RECONNECT_FIRST_MS;
  /** the newest connect attempt: an older one that settles later comes to nothing */
  private attempt = 0;
  /** a line ended and no new one came up since: a failed attempt waits and tries again, instead of NoCore */
  private retrying = false;
  private closed = false;
  /** what `notify` threw, until `fire` or `connect` throws it */
  private failure: { error: unknown } | null = null;
  private readonly open: (path: string) => Promise<HcTransport>;

  constructor(private readonly options: LinkOptions) {
    this.open = options.connect ?? connectCoreSocket;
  }

  get state(): LinkState {
    return this.current;
  }

  /** The first attempt, begun once `openLink` returned, so that its first notice can read the link. */
  start(): void {
    const attempt = ++this.attempt;
    queueMicrotask(() => { if (attempt === this.attempt) void this.newLine(); });
  }

  connect(): void {
    if (!this.closed && (this.current.kind === "NoCore" || this.current.kind === "Offline")) void this.newLine();
    this.raise();
  }

  fire(): void {
    const now = this.options.now();
    const state = this.current;
    const line = this.line;
    if (state.kind === "Offline" && state.retryAt !== null && now >= state.retryAt) {
      if (!this.closed) void this.newLine();
    } else if (state.kind === "Online" && line && now >= line.heardAt + LINE_SILENCE_MS) {
      this.lineEnded(line, "silent", `herdr-core sent no event and no heartbeat for ${LINE_SILENCE_MS} ms`);
    }
    this.raise();
  }

  deadlines(): Deadlines {
    const state = this.current;
    let deadlines = NO_DEADLINES;
    if (state.kind === "Offline" && state.retryAt !== null) deadlines = setDeadline(deadlines, RECONNECT_DEADLINE, state.retryAt);
    if (state.kind === "Online" && this.line) deadlines = setDeadline(deadlines, SILENCE_DEADLINE, this.line.heardAt + LINE_SILENCE_MS);
    if (this.failure) deadlines = setDeadline(deadlines, FAILURE_DEADLINE, this.options.now());
    return deadlines;
  }

  async call<M extends HcMethod>(method: M, params: HcMethods[M]["params"], timeoutMs?: number): Promise<HcMethods[M]["result"]> {
    return this.online().hc.call(method, params, timeoutMs);
  }

  async hello(): Promise<HelloInfo> {
    return this.online().hello!;
  }

  async refreshLayout(signal?: AbortSignal): Promise<boolean> {
    const line = this.line;
    if (line === null || this.current.kind !== "Online") return false;
    // A missed-event snapshot must finish publishing before we confirm a document to its writer.
    do {
      while (!line.over && !signal?.aborted && line.resyncing) await line.resyncing;
      if (line.over || signal?.aborted) return false;
      const round = line.round;
      await this.readDoc(line, OVIS_LAYOUT_DOC);
      if (line.round === round) break;
    } while (!line.over);
    return !line.over && !signal?.aborted;
  }

  async attach(params: TerminalAttachParams, handlers: ChannelHandlers): Promise<{ result: HcMethods["terminal.attach"]["result"]; channel: Channel }> {
    return this.online().hc.open("terminal.attach", params, handlers);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.attempt++;
    const line = this.line;
    this.line = null;
    if (line && !line.over) {
      line.over = true;
      await line.events?.close();
      line.hc.close();
    }
    this.setState({ kind: "Offline", code: "link_closed", retryAt: null, reason: "the link was closed" });
  }

  /** The current line, when the link is Online; otherwise the call is refused. */
  private online(): Line {
    const line = this.line;
    if (this.current.kind !== "Online" || !line || line.over) throw new HcError(OFFLINE, `herdr-core is not reachable (${this.current.kind})`);
    return line;
  }

  private setState(state: LinkState): void {
    this.current = state;
    this.deliver({ type: "state", state });
  }

  /**
   * Tells the owner. What `notify` throws is kept for `fire` to throw, and ends the line in use: the
   * owner missed what it was told, so what it holds can no longer be trusted, as after a bad line.
   */
  private deliver(notice: LinkNotice): void {
    try {
      this.options.notify(notice);
    } catch (error) {
      this.failure ??= { error };
      const line = this.line;
      if (line && !line.over) this.lineEnded(line, "notify_failed", `the link's owner failed on a notice: ${messageOf(error)}`);
    }
  }

  /** Throws what `notify` threw, once. */
  private raise(): void {
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure.error;
  }

  private async newLine(): Promise<void> {
    const attempt = ++this.attempt;
    this.setState({ kind: "Connecting" });
    let transport: HcTransport;
    try {
      transport = await this.open(this.options.socket);
    } catch (error) {
      if (attempt !== this.attempt) return;
      // no core there (`no_core`), or a socket that cannot be opened at all: either way none to talk to
      if (this.retrying) this.retryLater(noCoreCode(error), messageOf(error));
      else this.setState({ kind: "NoCore", code: noCoreCode(error), reason: messageOf(error) });
      return;
    }
    if (attempt !== this.attempt) {
      transport.kill();
      return;
    }
    let handedOut = false;
    // the line's one transport: once it ended, an HcConnection call that would open another fails instead
    const hc = new HcConnection(() => {
      if (handedOut) throw new HcError(OFFLINE, "this line to herdr-core ended");
      handedOut = true;
      return transport;
    }, {
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      // the connection's verdict comes before its waiting calls fail and its channels close: what follows
      // from that end is a symptom. The event stream's close is ignored while `ending`; a rejected call's
      // handler runs after the microtask queued here, which has ended the line by then. The line is named
      // once the connection has told every channel, so each hears `connection_lost` first.
      onEnd: (kind, message) => {
        if (line.over) return;
        line.ending = true;
        queueMicrotask(() => {
          if (kind === "bad_hello") this.incompatible(line, "bad_hello", message, []);
          else this.lineEnded(line, endCode(kind), message);
        });
      },
    });
    const line: Line = { hc, over: false, ending: false, hello: null, events: null, epoch: 0, model: null, floor: 0, early: [], round: 0, resyncing: null, held: null, docs: new Map(), heardAt: this.options.now(), onlineAt: null };
    this.line = line;

    let hello: HelloInfo;
    try {
      hello = await hc.hello();
    } catch {
      // hello fails only when the connection ends the line, and `onEnd` named why already
      return;
    }
    if (line.over) return;
    line.hello = hello;
    const missing = SCREEN_METHODS.filter((method) => !hello.methods.includes(method));
    if (missing.length > 0) {
      this.incompatible(line, "missing_methods", `herdr-core ${hello.version} does not answer ${missing.join(", ")}`, missing);
      return;
    }

    let subscribed: Awaited<ReturnType<typeof openEventStream>>;
    try {
      subscribed = await openEventStream(hc, {
        event: (event, seq) => this.onEvent(line, event, seq),
        resync: (missed) => {
          if (!missed) { if (!line.ending) this.lineEnded(line, "bad_line", "herdr-core's event stream ended or sent what cannot be read"); }
          else if (line.early) line.early.push({ missed });
          else void this.resync(line, missed);
        },
        tooLong: () => this.lineEnded(line, "bad_line", "herdr-core sent an event line over its size limit"),
        heard: () => { line.heardAt = this.options.now(); },
      });
    } catch (error) {
      this.lineEnded(line, callCode(error), messageOf(error));
      return;
    }
    if (line.over) return;
    const { channel, seq, terminals } = subscribed.result as { channel: unknown; seq: unknown; terminals: unknown };
    // the connection takes hc's channel as given and routes frames only to a numeric one; channel 0 is JSON-RPC's,
    // and a frame names its channel in 32 bits, so a larger one could never be heard
    if (!Number.isInteger(channel) || (channel as number) < 1 || (channel as number) > 0xffff_ffff) {
      this.lineEnded(line, "bad_line", "herdr-core answered events.subscribe without an event channel");
      return;
    }
    line.events = subscribed.channel;
    if (typeof seq !== "number" || !Array.isArray(terminals)) {
      this.lineEnded(line, "bad_line", "herdr-core answered events.subscribe without a snapshot");
      return;
    }
    // what came with or right after the answer: a `missed` among it is the newer snapshot
    const early = line.early ?? [];
    line.early = null;
    let lastMissed = -1;
    early.forEach((item, at) => { if ("missed" in item) lastMissed = at; });
    const base = lastMissed === -1 ? { seq, terminals } : (early[lastMissed] as { missed: MissedSnapshot }).missed;
    const settled = this.resync(line, base);
    for (const item of early.slice(lastMissed + 1)) if ("event" in item) this.onEvent(line, item.event, item.seq);
    await settled;
  }

  /**
   * The one resync path, for a new line's snapshot and for `missed`: a fresh core model from the
   * snapshot, then both documents read; what was learned meanwhile is told after them. The first
   * on a line makes the link Online in a new epoch.
   */
  private resync(line: Line, snapshot: MissedSnapshot): Promise<void> {
    const reading = this.readSnapshot(line, snapshot).finally(() => {
      if (line.resyncing === reading) line.resyncing = null;
    });
    line.resyncing = reading;
    return reading;
  }

  private async readSnapshot(line: Line, snapshot: MissedSnapshot): Promise<void> {
    const round = ++line.round;
    line.floor = snapshot.seq;
    line.model = coreModel(this.options.model);
    // a fresh model has no event waiting for its snapshot, so seeding it makes no change record
    line.model.seed(snapshot.terminals);
    const held: ((epoch: number) => LinkNotice)[] = [];
    line.held = held;
    let docs: DocGetResult[];
    try {
      docs = await Promise.all(LINK_DOCS.map((name) => line.hc.call("doc.get", { name })));
    } catch (error) {
      // a newer resync took over this line: its own reads decide, and a failure here ends nothing
      if (line.over || round !== line.round) return;
      this.lineEnded(line, callCode(error), `herdr-core's layout documents could not be read: ${messageOf(error)}`);
      return;
    }
    if (line.over || round !== line.round) return;
    line.held = null;
    // a re-read that settled while these reads ran may hold a newer version: the newest stays the one known
    LINK_DOCS.forEach((name, at) => { if (docs[at]!.version >= (line.docs.get(name)?.version ?? -1)) line.docs.set(name, docs[at]!); });
    const cause = line.epoch === 0 ? "connect" : "missed";
    if (cause === "connect") {
      line.epoch = ++this.epochs;
      line.heardAt = this.options.now();
      line.onlineAt = line.heardAt;
      this.retrying = false;
      this.setState({ kind: "Online", epoch: line.epoch });
    }
    const { epoch } = line;
    const readNow = new Map<string, number>(LINK_DOCS.map((name, at) => [name, docs[at]!.version]));
    const notices: LinkNotice[] = [
      { type: "snapshot", epoch, cause, seq: snapshot.seq, terminals: snapshot.terminals },
      ...LINK_DOCS.map((name, at): LinkNotice => ({ type: "doc", epoch, name, doc: docs[at]! })),
      // a document told while these reads ran that is older than what they read is not told after them
      ...held.map((notice) => notice(epoch)).filter((notice) => notice.type !== "doc" || notice.doc.version >= (readNow.get(notice.name) ?? -1)),
    ];
    // a notice the owner failed on ends the line: nothing after it is told
    for (const notice of notices) if (!line.over) this.deliver(notice);
  }

  private onEvent(line: Line, event: HcEvent, seq: number | null): void {
    if (line.over) return;
    if (line.early) {
      line.early.push({ event, seq });
      return;
    }
    if (seq !== null && seq <= line.floor) return;
    const changes = line.model!.event(event);
    this.tell(line, (epoch) => ({ type: "event", epoch, seq, event, changes }));
    const name = event.data?.["name"];
    const version = event.data?.["version"];
    if (event.type === "doc" && event.machine === undefined && (name === LAYOUT_DOC || name === OVIS_LAYOUT_DOC) && typeof version === "number" && version > (line.docs.get(name)?.version ?? -1)) {
      void this.readDoc(line, name);
    }
  }

  /** A layout document hc says changed, read again; an answer older than one already read is dropped. */
  private async readDoc(line: Line, name: string): Promise<void> {
    let doc: DocGetResult;
    try {
      doc = await line.hc.call("doc.get", { name });
    } catch (error) {
      this.lineEnded(line, callCode(error), `herdr-core's ${name} document could not be read: ${messageOf(error)}`);
      return;
    }
    if (line.over || doc.version <= (line.docs.get(name)?.version ?? -1)) return;
    line.docs.set(name, doc);
    this.tell(line, (epoch) => ({ type: "doc", epoch, name, doc }));
  }

  private tell(line: Line, notice: (epoch: number) => LinkNotice): void {
    if (line.held) line.held.push(notice);
    else this.deliver(notice(line.epoch));
  }

  /**
   * The line is over, once: every channel on it hears `connection_lost` (HcConnection's close), and
   * the link waits to try a new one. After a line that stayed up LINE_STABLE_MS the wait starts
   * again at the first; after a shorter one it keeps doubling.
   */
  private lineEnded(line: Line, code: OfflineCode, reason: string): void {
    if (line.over) return;
    line.over = true;
    line.held = null;
    line.hc.close();
    if (this.line !== line) return;
    this.line = null;
    this.retrying = true;
    if (line.onlineAt !== null && this.options.now() - line.onlineAt >= LINE_STABLE_MS) this.delay = RECONNECT_FIRST_MS;
    this.retryLater(code, reason);
  }

  private retryLater(code: OfflineCode, reason: string): void {
    const retryAt = this.options.now() + this.delay;
    this.delay = Math.min(this.delay * 2, RECONNECT_MOST_MS);
    this.setState({ kind: "Offline", code, retryAt, reason });
  }

  private incompatible(line: Line, code: IncompatibleCode, reason: string, missing: string[]): void {
    if (line.over) return;
    line.over = true;
    line.hc.close();
    if (this.line === line) this.line = null;
    this.setState({ kind: "Incompatible", code, reason, missing });
  }
}
