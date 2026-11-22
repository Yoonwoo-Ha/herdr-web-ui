/**
 * Test tooling for the pane machine (tui/core/pane.ts): a stage with one fake herdr-core, any number
 * of screens on it (each the real core link, real emulators and the machine under test) and rival
 * viewers, all on one injected clock. Nothing here waits for time: `settle` runs until nothing is in
 * flight and nothing changed for two turns of the loop.
 *
 * Every channel and emulator the machine gets is wrapped, so a test sees what the machine did in the
 * order it did it (`calls`, `attaches`, `emulators`) and can make the next attach or emulator call
 * fail (`faults`). The wrappers change nothing the machine can see, except what a fault asks for.
 */

import type { Channel, ChannelHandlers } from "../../server/herdr-core/connection.ts";
import { HcConnection, HcError } from "../../server/herdr-core/connection.ts";
import { describeFrame, type FakeHcCore, INPUT_KINDS } from "../../server/herdr-core/core.fake.ts";
import type { TerminalAttachParams } from "../../server/herdr-core/hc-api.generated.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { type CoreLink, type LinkNotice, openLink } from "../core/link.ts";
import { createPanes, type InputResult, type PaneInput, type PaneLink, type PaneNotice, type Panes, type PaneView } from "../core/pane.ts";
import { createEmulator } from "../emulator/ghostty.ts";
import type { Emulator, EmulatorError, EmulatorOptions, EmulatorResult } from "../emulator/index.ts";
import { type Mods, typedKey } from "../input/decode.ts";

/** the credit a frame pass of the loop hands out at most (row 25) */
export const PASS_BUDGET = 512 * 1024;
const SETTLE_LIMIT_MS = 10_000;
/** the call `settle` sends down a socket line to learn that everything before it arrived */
const BARRIER = "machine.list";

/** One attach the machine asked for, and what came of it. */
export interface AttachRecord {
  index: number;
  terminal: string;
  params: Record<string, unknown>;
  /** asked: no reply yet; open: the channel is the machine's; refused: the call failed; closed: the stream is over */
  state: "asked" | "open" | "refused" | "closed";
  automaticInput: boolean;
  /** the terminal's size in the core's answer to this attach (`80x24`), or null while there is none */
  reply: string | null;
  /** the stream as the machine got it, frame by frame */
  received: Uint8Array[];
  receivedBytes: number;
  credited: number;
  /** the machine sent CLOSE */
  closeAsked: boolean;
  /** the machine was told that the stream is over: the core's own CLOSE, the line's end, or the answer to the machine's CLOSE */
  closeHeard: boolean;
  /** the machine's own handlers: a test may hand them a frame the core would never cut that way */
  handlers: ChannelHandlers;
  /** where the attach went: the core, the fake's number of this screen's line then (0 over a socket), and the stream's channel once answered */
  core: FakeHcCore;
  line: number;
  channel: number | null;
}

/** One call the machine made on a channel, in order. */
export interface ChannelCall {
  attach: AttachRecord;
  op: "write" | "writeAutomatic" | "resize" | "credit" | "focus" | "facts" | "close";
  /** as the fake core describes frames: `DATA 61`, `RESIZE 80x24`, `FOCUS 1`, `CLOSE` */
  text: string;
  /** the number of the `input` call it was made in, or null */
  input: number | null;
}

/** One emulator the machine was given. */
export interface EmulatorRecord {
  index: number;
  cols: number;
  rows: number;
  /** what the machine wrote into it, write by write */
  written: Uint8Array[];
  writtenBytes: number;
  /** what it answered the program with */
  replies: Uint8Array[];
  disposed: boolean;
  /** calls the machine made on it from inside its own write (only `dispose` may be) */
  reentered: string[];
  emulator: Emulator;
  /** the machine's own handlers for it: a test may call one after the emulator is gone */
  events: EmulatorOptions["events"];
}

export interface Faults {
  /** the next attach: refused with this HcError kind, or answered with what `reply` makes of the core's answer */
  attach: { reject: string } | { reply: (result: unknown) => unknown } | null;
  /** attach replies reach the machine only at `release()` */
  holdReplies: boolean;
  /** the core's answer to a CLOSE of the machine reaches it only at `release()` */
  holdCloses: boolean;
  /** the core's answer to a call of the machine (`terminal.get`) reaches it only at `release()` */
  holdCalls: boolean;
  /** `size` events reach the machine only at `sizes()`, in the order they came: an event still on its way when an attach leaves or its reply comes */
  holdSizes: boolean;
  /** what the link says its state is, whatever it is: the machine must ask the link, not only its own panes */
  linkState: CoreLink["state"] | null;
  /** the 9001 mark is taken out of every stream, as a core that changed it would send it */
  stripMark: boolean;
  /** the next emulator cannot be made */
  create: boolean;
  /** what the next write, resize or encode of an emulator answers */
  write: "trapped" | "failed" | "busy" | null;
  resize: "size" | "failed" | null;
  encode: "busy" | "failed" | null;
}

const MARK = /\x1b\[\?9001[hl]/g;
const hex = (payload: Uint8Array | string) => (typeof payload === "string" ? Buffer.from(payload, "latin1") : Buffer.from(payload)).toString("hex");
const injected = (kind: EmulatorError["kind"]): { ok: false; error: EmulatorError } => ({ ok: false, error: { kind, message: `injected ${kind}` } });

export class Screen {
  readonly link: CoreLink;
  readonly panes: Panes;
  readonly linkNotices: LinkNotice[] = [];
  readonly notices: PaneNotice[] = [];
  readonly attaches: AttachRecord[] = [];
  readonly emulators: EmulatorRecord[] = [];
  readonly calls: ChannelCall[] = [];
  readonly faults: Faults = { attach: null, holdReplies: false, holdCloses: false, holdCalls: false, holdSizes: false, linkState: null, stripMark: false, create: false, write: null, resize: null, encode: null };
  /** called as each thing happens, for a test that checks rules at that very moment */
  hooks: { call?: (call: ChannelCall) => void; attach?: (record: AttachRecord) => void; write?: (record: EmulatorRecord, bytes: Uint8Array) => void; notice?: (notice: PaneNotice) => void; link?: (notice: LinkNotice) => void } = {};
  /** work of this screen that has not come back yet */
  inflight = 0;
  /** the `input` call in progress */
  inputting: number | null = null;
  private inputs = 0;
  private held: (() => void)[] = [];
  private heldCloses: (() => void)[] = [];
  private heldSizes: LinkNotice[] = [];
  /** the fake's numbers of the lines this screen's link opened, per core */
  private readonly lines = new Map<FakeHcCore, number[]>();
  /** whether the link goes through the real socket transport */
  readonly overSocket: boolean;

  constructor(private readonly stage: Stage, options: { socket?: string } = {}) {
    this.overSocket = options.socket !== undefined;
    this.link = openLink({
      socket: options.socket ?? "memory",
      now: () => stage.clock.now,
      model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null },
      notify: (notice) => {
        this.linkNotices.push(notice);
        this.hooks.link?.(notice);
        // a line that ended settles every CLOSE on it, as the connection does: none can be held past it
        if (notice.type === "state" && notice.state.kind !== "Online") for (const resolve of this.heldCloses.splice(0)) resolve();
        if (this.faults.holdSizes && notice.type === "event" && notice.event.type === "size") this.heldSizes.push(notice);
        else this.panes.notice(notice);
      },
      connect: options.socket === undefined
        ? async () => {
          const transport = stage.core.transport();
          this.lines.set(stage.core, [...(this.lines.get(stage.core) ?? []), transport.line]);
          return transport;
        }
        : connectCoreSocket,
    });
    const link: PaneLink = {
      state: this.link.state,
      call: (method, params, timeoutMs) => {
        const answered = this.track(this.link.call(method, params, timeoutMs));
        return this.faults.holdCalls ? answered.then((answer) => new Promise<typeof answer>((resolve) => this.held.push(() => resolve(answer)))) : answered;
      },
      attach: (params, handlers) => this.attach(params, handlers),
    };
    Object.defineProperty(link, "state", { get: () => this.faults.linkState ?? this.link.state });
    this.panes = createPanes({
      link,
      now: () => stage.clock.now,
      notify: (notice) => {
        this.notices.push(notice);
        this.hooks.notice?.(notice);
      },
      createEmulator: (made) => this.makeEmulator(made),
    });
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight++;
    const done = () => { this.inflight--; };
    promise.then(done, done);
    return promise;
  }

  private async attach(params: TerminalAttachParams, handlers: ChannelHandlers): Promise<{ result: Awaited<ReturnType<CoreLink["attach"]>>["result"]; channel: Channel }> {
    const record: AttachRecord = {
      index: this.attaches.length, terminal: params.terminal, params: { ...params }, state: "asked", automaticInput: false, reply: null,
      received: [], receivedBytes: 0, credited: 0, closeAsked: false, closeHeard: false, handlers,
      core: this.stage.core, line: this.lines.get(this.stage.core)?.at(-1) ?? 0, channel: null,
    };
    this.attaches.push(record);
    this.hooks.attach?.(record);
    const fault = this.faults.attach;
    this.faults.attach = null;
    if (fault && "reject" in fault) {
      record.state = "refused";
      throw new HcError(fault.reject, `injected ${fault.reject}`);
    }
    let opened: Awaited<ReturnType<CoreLink["attach"]>>;
    try {
      opened = await this.track(this.link.attach(params, {
        ...(handlers.credit === undefined ? {} : { credit: handlers.credit }),
        onData: (payload) => {
          const bytes = this.faults.stripMark ? new Uint8Array(Buffer.from(Buffer.from(payload).toString("latin1").replace(MARK, ""), "latin1")) : payload;
          if (bytes.length === 0) return;
          record.received.push(bytes);
          record.receivedBytes += bytes.length;
          handlers.onData(bytes);
        },
        onClose: (reason) => {
          // the answer to the machine's own CLOSE is told through `close()`, which a test may hold back
          if (!record.closeAsked) {
            record.state = "closed";
            record.closeHeard = true;
          }
          handlers.onClose(reason);
        },
      }));
    } catch (error) {
      record.state = "refused";
      throw error;
    }
    if (record.state === "asked") record.state = "open";
    record.automaticInput = opened.channel.automaticInput;
    record.reply = `${opened.result.terminal.cols}x${opened.result.terminal.rows}`;
    record.channel = opened.channel.id;
    if (this.faults.holdReplies) await new Promise<void>((resolve) => this.held.push(resolve));
    const result = (fault && "reply" in fault ? fault.reply(opened.result) : opened.result) as typeof opened.result;
    return { result, channel: this.wrapChannel(record, opened.channel) };
  }

  private wrapChannel(record: AttachRecord, channel: Channel): Channel {
    const note = (op: ChannelCall["op"], text: string) => {
      const call: ChannelCall = { attach: record, op, text, input: this.inputting };
      this.calls.push(call);
      this.hooks.call?.(call);
    };
    return {
      id: channel.id,
      automaticInput: channel.automaticInput,
      write: (payload) => { note("write", `DATA ${hex(payload)}`); channel.write(payload); },
      writeAutomatic: (payload) => { note("writeAutomatic", `AUTOMATIC_INPUT ${hex(payload)}`); channel.writeAutomatic(payload); },
      resize: (cols, rows) => { note("resize", `RESIZE ${cols}x${rows}`); channel.resize(cols, rows); },
      credit: (bytes) => { record.credited += bytes; note("credit", `CREDIT ${bytes}`); channel.credit(bytes); },
      focus: (focused) => { note("focus", `FOCUS ${focused ? 1 : 0}`); channel.focus(focused); },
      facts: (display) => { note("facts", `FACTS ${JSON.stringify(display)}`); channel.facts(display); },
      close: () => {
        note("close", "CLOSE");
        record.closeAsked = true;
        const answered = this.track(channel.close());
        const told = this.faults.holdCloses && this.link.state.kind === "Online" ? answered.then(() => new Promise<void>((resolve) => this.heldCloses.push(resolve))) : answered;
        return told.then(() => {
          record.closeHeard = true;
          record.state = "closed";
        });
      },
    };
  }

  private async makeEmulator(options: EmulatorOptions): Promise<EmulatorResult<Emulator>> {
    if (this.faults.create) {
      this.faults.create = false;
      return injected("failed");
    }
    const replies: Uint8Array[] = [];
    const made = await this.track(createEmulator({ ...options, events: { ...options.events, onReply: (bytes) => { replies.push(bytes); options.events.onReply?.(bytes); } } }));
    if (!made.ok) return made;
    const real = made.value;
    const record: EmulatorRecord = { index: this.emulators.length, cols: options.cols, rows: options.rows, written: [], writtenBytes: 0, replies, disposed: false, reentered: [], emulator: real, events: options.events };
    this.emulators.push(record);
    let writing = false;
    let dead = false;
    const take = <K extends "write" | "resize" | "encode">(name: K): Faults[K] => {
      const fault = this.faults[name];
      this.faults[name] = null;
      return fault;
    };
    const special: Partial<Emulator> = {
      write: (bytes) => {
        const fault = take("write");
        if (dead) return injected("trapped");
        if (fault === "trapped") {
          dead = true;
          return injected("trapped");
        }
        if (fault === "busy") return injected("busy");
        writing = true;
        let result: EmulatorResult<void>;
        try {
          result = real.write(bytes);
        } finally {
          writing = false;
        }
        record.written.push(bytes);
        record.writtenBytes += bytes.length;
        this.hooks.write?.(record, bytes);
        // a write that fails because a handler threw was applied in full
        return fault === "failed" ? injected("failed") : result;
      },
      resize: (cols, rows, cellW, cellH) => {
        const fault = take("resize");
        if (fault) return injected(fault);
        const result = real.resize(cols, rows, cellW, cellH);
        if (result.ok) Object.assign(record, { cols, rows });
        return result;
      },
      dispose: () => {
        record.disposed = true;
        real.dispose();
      },
      encodeKey: (key) => { const fault = take("encode"); return fault ? injected(fault) : real.encodeKey(key); },
      encodeMouse: (mouse) => { const fault = take("encode"); return fault ? injected(fault) : real.encodeMouse(mouse); },
      encodePaste: (text) => { const fault = take("encode"); return fault ? injected(fault) : real.encodePaste(text); },
    };
    const emulator = new Proxy(real, {
      get: (target, name) => {
        if (name in special) return special[name as keyof Emulator];
        const value: unknown = Reflect.get(target, name);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (writing) record.reentered.push(String(name));
          return (value as (...given: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    // the record holds what the machine holds, so a test can find a pane's emulator among the records
    record.emulator = emulator;
    return { ok: true, value: emulator };
  }

  /** Lets the held `size` events through to the machine, in the order they came, and holds no more. */
  sizes(): void {
    this.faults.holdSizes = false;
    for (const notice of this.heldSizes.splice(0)) this.panes.notice(notice);
  }

  /** Lets the held attach replies, CLOSE answers and call answers through to the machine. */
  release(): void {
    this.faults.holdReplies = false;
    this.faults.holdCloses = false;
    this.faults.holdCalls = false;
    for (const resolve of [...this.held.splice(0), ...this.heldCloses.splice(0)]) resolve();
  }

  /** What the shown tab's layout gives a rectangle: `[terminal, cols, rows, covered?]` each. */
  show(...panes: [terminal: string, cols: number, rows: number, covered?: boolean][]): void {
    this.panes.show(panes.map(([terminal, cols, rows, covered]) => ({ terminal, cols, rows, covered: covered === true })));
  }

  view(terminal: string): PaneView {
    const view = this.panes.view(terminal);
    if (!view) throw new Error(`no pane for ${terminal}`);
    return view;
  }

  /** A pane's state in one word: `Live`, `Waiting(offline)`, `Ended(exited 3)`, `Failed(bad_reply)`, or `gone`. */
  state(terminal: string): string {
    const state = this.panes.view(terminal)?.state;
    if (!state) return "gone";
    if (state.kind === "Waiting") return `Waiting(${state.why})`;
    if (state.kind === "Ended") return `Ended(${state.reason} ${state.code})`;
    if (state.kind === "Failed") return `Failed(${state.code})`;
    return state.kind;
  }

  /** What is due on the clock, as the loop would fire it. */
  fire(): void {
    this.link.fire();
    this.panes.fire();
  }

  /**
   * One frame pass of the loop: every pane's picture is drawn, credit is handed out, and a pane whose
   * first paint is complete becomes live, after `drain` (the loop's read of what stdin still holds).
   */
  pass({ live = true, budget = PASS_BUDGET, drain }: { live?: boolean; budget?: number; drain?: () => void } = {}): void {
    for (const view of this.panes.views()) {
      view.emulator?.frame(() => {});
      this.panes.credit(view.terminal, budget);
      if (live && view.ready) {
        drain?.();
        this.panes.live(view.terminal);
      }
    }
  }

  input(event: PaneInput): InputResult {
    this.inputting = ++this.inputs;
    try {
      return this.panes.input(event);
    } finally {
      this.inputting = null;
    }
  }

  /** The time a read of stdin would stamp its events with: the clock, moved on by one tick. */
  stamp(): number {
    return ++this.stage.clock.now;
  }

  /** Types `text`, one key per character, each read at `at` (by default a fresh read per key). */
  type(text: string, at?: number): InputResult[] {
    return [...text].map((char) => this.input({ ...typedKey(char, {}), at: at ?? this.stamp() }));
  }

  key(key: string, mods: Mods = {}, at?: number): InputResult {
    return this.input({ type: "key", key, mods, action: "press", at: at ?? this.stamp() });
  }

  paste(text: string, { at, complete = true }: { at?: number; complete?: boolean } = {}): InputResult {
    return this.input({ type: "paste", text, complete, at: at ?? this.stamp() });
  }

  mouse(action: "press" | "release" | "motion", col: number, row: number, at?: number): InputResult {
    return this.input({ type: "mouse", action, button: "left", mods: {}, col, row, at: at ?? this.stamp() });
  }

  /** The frames this screen sent on `terminal`'s streams of the stage's current core (by default the input kinds), as the fake describes them. */
  sent(terminal: string, kinds: readonly number[] = INPUT_KINDS): string[] {
    const lines = this.lines.get(this.stage.core) ?? [];
    return this.stage.core.log.flatMap((entry) => entry.what === "frame" && entry.from === "viewer" && lines.includes(entry.line) && entry.terminal === terminal && kinds.includes(entry.kind) ? [describeFrame(entry.kind, entry.payload)] : []);
  }

  /** The size the stage's current core holds for the viewer of `record` (what that attach advertises now), or null when the core has no such viewer. */
  advertisedTo(record: AttachRecord): string | null {
    if (record.core !== this.stage.core) return null;
    const viewer = record.core.viewers().find((seen) => seen.line === record.line && seen.channel === record.channel && seen.terminal === record.terminal);
    return viewer ? `${viewer.cols}x${viewer.rows}` : null;
  }

  /** What the machine did on the channels of `terminal`, in order, without the credit. */
  did(terminal: string): string[] {
    return this.calls.filter((call) => call.attach.terminal === terminal && call.op !== "credit").map((call) => call.text);
  }

  /** The attaches the machine asked for on `terminal`, as their parameters. */
  asked(terminal: string): Record<string, unknown>[] {
    return this.attaches.filter((record) => record.terminal === terminal).map((record) => record.params);
  }
}

/** An emulator's whole screen as text, one string per row, without the blanks that end a row. */
export function picture(emulator: Emulator): string[] {
  const rows: string[] = [];
  const drawn = emulator.frameAll((y, runs) => { rows[y] = runs.map((run) => run.cells.map((cell) => cell.text).join("")).join("").trimEnd(); });
  if (!drawn.ok) throw new Error(`the emulator could not be drawn: ${drawn.error.kind}`);
  return rows;
}

/** Another client on the same core: a viewer the test drives itself. */
export class Rival {
  private readonly hc: HcConnection;
  private channel: Channel | null = null;

  constructor(stage: Stage) {
    this.hc = new HcConnection(() => stage.core.transport());
  }

  /** Attaches as a plain viewer, which takes the size unless `resumed`. */
  async attach(terminal: string, cols: number, rows: number, resumed = false): Promise<void> {
    this.channel = (await this.hc.open("terminal.attach", { terminal, cols, rows, ...(resumed ? { resumed: true } : {}) }, { onData: () => {}, onClose: () => { this.channel = null; } })).channel;
  }

  get attached(): boolean {
    return this.channel !== null;
  }

  type(text: string): void {
    this.channel?.write(text);
  }

  resize(cols: number, rows: number): void {
    this.channel?.resize(cols, rows);
  }

  async detach(): Promise<void> {
    await this.channel?.close();
    this.channel = null;
  }

  close(): void {
    this.hc.close();
  }
}

/** One fake core, the screens and rival viewers on it, and their clock. */
export class Stage {
  readonly clock = { now: 1_000 };
  readonly screens: Screen[] = [];
  readonly rivals: Rival[] = [];

  constructor(public core: FakeHcCore) {}

  /** A screen whose link is up (when a core is there). `socket`: through the real socket transport, to a path the fake listens on. */
  async screen(options: { socket?: string } = {}): Promise<Screen> {
    const screen = new Screen(this, options);
    this.screens.push(screen);
    await this.settle();
    return screen;
  }

  rival(): Rival {
    const rival = new Rival(this);
    this.rivals.push(rival);
    return rival;
  }

  /** how much of the core's log was counted, and what it came to: `settle`'s own calls are not activity */
  private counted = { core: null as FakeHcCore | null, read: 0, sum: 0 };

  private activity(): number {
    if (this.counted.core !== this.core) this.counted = { core: this.core, read: 0, sum: 0 };
    for (const log = this.core.log; this.counted.read < log.length; this.counted.read++) {
      const entry = log[this.counted.read]!;
      if (!((entry.what === "call" || entry.what === "reply") && entry.method === BARRIER)) this.counted.sum++;
    }
    return this.counted.sum + this.screens.reduce((sum, screen) => sum + screen.linkNotices.length + screen.notices.length + screen.calls.length + screen.attaches.length + screen.emulators.reduce((writes, record) => writes + record.written.length, 0), 0);
  }

  /** Runs until every screen is at rest: nothing in flight, no line being opened, and nothing new for two turns of the loop. */
  async settle(): Promise<void> {
    const started = performance.now();
    for (let quiet = 0; quiet < 2;) {
      if (performance.now() - started > SETTLE_LIMIT_MS) throw new Error(`the stage did not come to rest within ${SETTLE_LIMIT_MS}ms`);
      const before = this.activity();
      // over a real socket a frame can be on its way with nothing in flight here: a call on that line comes back after it
      await Promise.all(this.screens.map((screen) => screen.overSocket && screen.link.state.kind === "Online" ? screen.link.call(BARRIER, {}).catch(() => {}) : null));
      await new Promise<void>((resolve) => setImmediate(resolve));
      // a `size` event the fake holds back (`late`) is still on its way
      const resting = this.core.heldEvents() === 0 && this.screens.every((screen) => screen.inflight === 0 && screen.link.state.kind !== "Connecting");
      quiet = resting && this.activity() === before ? quiet + 1 : 0;
    }
  }

  /** Moves the clock on and fires what is due on every screen. */
  async advance(ms: number): Promise<void> {
    this.clock.now += ms;
    for (const screen of this.screens) screen.fire();
    await this.settle();
  }

  /** A frame pass on every screen, then rest. */
  async pass(options: Parameters<Screen["pass"]>[0] = {}): Promise<void> {
    for (const screen of this.screens) screen.pass(options);
    await this.settle();
  }

  /** Shows `panes` on `screen` and takes them live: the attach, the first paint, then the frame pass. */
  async live(screen: Screen, ...panes: Parameters<Screen["show"]>): Promise<void> {
    screen.show(...panes);
    await this.settle();
    screen.pass();
    await this.settle();
    for (const [terminal] of panes) if (screen.state(terminal) !== "Live") throw new Error(`${terminal} is ${screen.state(terminal)}, not Live`);
  }

  async close(): Promise<void> {
    for (const screen of this.screens) {
      screen.release();
      await screen.panes.close();
      await screen.link.close();
    }
    for (const rival of this.rivals) rival.close();
  }
}
