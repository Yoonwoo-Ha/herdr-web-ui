/**
 * Runs the real screen loop (tui/loop.ts) over the headless host and the fake herdr-core behind the real socket
 * transport, on an injected clock. A library for tests (`Run`, `ManualClock`) and a command:
 *
 *   bun tui/testing/run.ts [--fixture demo|agents|machines|scale] [--size COLSxROWS] [--keys <list>] [--dump]
 *     [--cut-line] [--crash]
 *
 * `--keys` types a comma-separated list once every shown pane is live, one read per item (tui/testing/keys.ts: keys,
 * mouse reports such as `click@30:5`, anything else typed as written). `--dump` prints the final
 * cell grid as text, one line a row. `--cut-line` ends the fake core's line after the first frame. `--crash` forces an
 * unexpected error after the keys (one write the host refuses with EBADF) and writes the crash record the entry would,
 * into OVIS_TUI_STATE_DIR. Exit code 2 for a wrong call. Nothing here waits for real time but the socket's own turns.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../../package.json";
import { type Frame, type HcTransport, makeFrameReader } from "../../server/herdr-core/connection.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { crashRecord, recordCrash } from "../crash.ts";
import { type Loop, type LoopClock, type LoopEnd, startLoop } from "../loop.ts";
import { agents } from "./fixtures/agents.ts";
import { demo } from "./fixtures/demo.ts";
import type { Fixture } from "./fixtures/fixture.ts";
import { machines } from "./fixtures/machines.ts";
import { scale } from "./fixtures/scale.ts";
import { HeadlessHost } from "./headless-host.ts";
import { keyBytes } from "./keys.ts";

const FIXTURES: Readonly<Record<string, Fixture>> = { demo, agents, machines, scale };

/** What the headless host answers the start probe with: the kitty flags in force, DECRQM 2026 known, then DA1. */
const PROBE_ANSWER = "\x1b[?1u\x1b[?2026;2$y\x1b[?62;22c";
/** hc sends a heartbeat this often; `advance` sends them on the fake core (none while `muted`) */
const HEARTBEAT_MS = 15_000;
/** how far `advance` moves at most while the host has a timer of its own (its probe, a drain) */
const HOST_STEP_MS = 10;
const SETTLE_ROUNDS = 2_000;
/** the call `settle` sends down the screen's line to learn that everything before it arrived */
const BARRIER = "machine.list";

/** The loop's clock in a test: moved by hand; counts the timers armed at once. */
export class ManualClock implements LoopClock {
  current = 0;
  /** the most timers ever armed at the same time */
  maxArmed = 0;
  private timers: { at: number; fire: () => void }[] = [];

  now(): number {
    return this.current;
  }

  arm(at: number, fire: () => void): () => void {
    const timer = { at, fire };
    this.timers.push(timer);
    this.maxArmed = Math.max(this.maxArmed, this.timers.length);
    return () => {
      const at = this.timers.indexOf(timer);
      if (at !== -1) this.timers.splice(at, 1);
    };
  }

  armed(): number {
    return this.timers.length;
  }

  next(): number | undefined {
    return this.timers.reduce<number | undefined>((first, timer) => first === undefined || timer.at < first ? timer.at : first, undefined);
  }

  /** Fires every timer due by now, the earliest first; answers how many fired. */
  fireDue(): number {
    let fired = 0;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= this.current).sort((a, b) => a.at - b.at)[0];
      if (!due) return fired;
      this.timers.splice(this.timers.indexOf(due), 1);
      fired++;
      due.fire();
    }
  }
}

export interface RunOptions {
  fixture?: Fixture;
  /** a core of the test's own instead of the fixture's */
  core?: FakeHcCore;
  cols?: number;
  rows?: number;
  /** the host's COLORTERM: "truecolor" by default; anything else is a 256-colour host (tui/host colorDepth) */
  colorTerm?: string;
}

export class Run {
  /** every frame the screen wrote to its line, as it left: the channel, the kind, the payload */
  readonly sent: Frame[] = [];
  /** the clock at each frame write the host was handed */
  readonly writeTimes: number[] = [];
  private listener: { close: () => Promise<void> } | null = null;
  private writesSeen = 0;
  private nextBeat: number;
  private counted = { read: 0, sum: 0 };
  /** what reaches the screen from the line stops here while set: a core that no longer answers */
  muted = false;

  private constructor(
    readonly core: FakeHcCore,
    readonly host: HeadlessHost,
    readonly clock: ManualClock,
    readonly folder: string,
    readonly socket: string,
  ) {
    this.nextBeat = HEARTBEAT_MS;
    this.loop = startLoop({ host, clock, socket, keys: undefined, connect: (path) => this.connect(path) });
  }

  readonly loop: Loop;

  static async start(options: RunOptions = {}): Promise<Run> {
    const fixture = options.fixture ?? null;
    const core = options.core ?? new FakeHcCore(fixture?.options ?? {});
    if (!options.core) fixture?.build(core);
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "run-"));
    const socket = join(folder, "hc.sock");
    const host = new HeadlessHost({ cols: options.cols ?? 120, rows: options.rows ?? 40, colorTerm: options.colorTerm ?? "truecolor", answer: PROBE_ANSWER });
    const run = new Run(core, host, new ManualClock(), folder, socket);
    try {
      await run.listen();
      await run.settle();
      if (run.loop.link.state.kind === "Online") fixture?.online?.(core);
      await run.settle();
    } catch (error) {
      // the caller never gets this run: it lets go of the listener and the folder itself, and the startup error is the one thrown
      await run.close().catch(() => {});
      throw error;
    }
    return run;
  }

  /** The fake core listens at the run's socket (again, after `cutLine`). */
  async listen(): Promise<void> {
    if (!this.listener) this.listener = await this.core.listen(this.socket);
  }

  /** Ends the fake core's line: every connection is dropped and nobody listens until `listen`. */
  async cutLine(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    await listener?.close();
  }

  private async connect(path: string): Promise<HcTransport> {
    const transport = await connectCoreSocket(path);
    let framed = false;
    const reader = makeFrameReader((frame: Frame) => this.sent.push(frame), () => {});
    const readable = transport.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => { if (!this.muted) controller.enqueue(chunk); },
    }));
    return {
      readable,
      exited: transport.exited,
      kill: transport.kill,
      write: (bytes) => {
        if (framed) reader(bytes);
        else {
          const end = bytes.indexOf(0x0a);
          if (end !== -1) {
            framed = true;
            if (end + 1 < bytes.length) reader(bytes.subarray(end + 1));
          }
        }
        transport.write(bytes);
      },
    };
  }

  /** what changed anywhere: the core's log (without settle's own calls), the host, the loop's actions, the frames sent */
  private activity(): number {
    for (const log = this.core.log; this.counted.read < log.length; this.counted.read++) {
      const entry = log[this.counted.read]!;
      if (!((entry.what === "call" || entry.what === "reply") && entry.method === BARRIER)) this.counted.sum++;
    }
    // calls (channel 0) are left out: settle's own barrier is one
    const frames = this.sent.reduce((sum, frame) => sum + (frame.channel === 0 ? 0 : 1), 0);
    return this.counted.sum + this.host.log().length + this.loop.report().actions.length + frames + this.loop.report().passes;
  }

  private fireDue(): void {
    this.host.advance(0);
    this.clock.fireDue();
    const attempts = this.host.writeAttempts();
    for (; this.writesSeen < attempts; this.writesSeen++) this.writeTimes.push(this.clock.current);
  }

  /** Runs until nothing changes for two turns of the event loop, with what is due by the clock fired on the way. */
  async settle(): Promise<void> {
    for (let quiet = 0, rounds = 0; quiet < 2; rounds++) {
      if (rounds > SETTLE_ROUNDS) throw new Error(`the run did not come to rest within ${SETTLE_ROUNDS} rounds`);
      const before = this.activity();
      this.fireDue();
      if (this.loop.link.state.kind === "Online" && !this.muted) await this.loop.link.call(BARRIER, {}).catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      quiet = this.activity() === before && this.loop.link.state.kind !== "Connecting" ? quiet + 1 : 0;
    }
  }

  /** Moves the clock on by `ms`, firing the loop's timer and the host's own in order, with hc's heartbeats on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.clock.current + ms;
    await this.settle();
    while (this.clock.current < target) {
      let step = target;
      const next = this.clock.next();
      if (next !== undefined && next > this.clock.current) step = Math.min(step, next);
      if (this.host.timers() > 0) step = Math.min(step, this.clock.current + HOST_STEP_MS);
      step = Math.min(step, this.nextBeat);
      step = Math.max(step, this.clock.current + (next !== undefined && next <= this.clock.current ? 0 : 1));
      const delta = step - this.clock.current;
      this.clock.current = step;
      this.host.advance(delta);
      if (this.clock.current >= this.nextBeat) {
        this.nextBeat += HEARTBEAT_MS;
        if (!this.muted) this.core.heartbeat();
      }
      await this.settle();
    }
  }

  /** Advances until every pane the screen shows is Live (or `limitMs` passed). */
  async live(limitMs = 5_000): Promise<void> {
    const until = this.clock.current + limitMs;
    while (this.clock.current < until) {
      const views = this.loop.panes.views().filter((view) => !view.covered);
      if (views.length > 0 && views.every((view) => view.state.kind === "Live")) return;
      await this.advance(10);
    }
    throw new Error(`panes not live after ${limitMs} ms: ${this.loop.panes.views().map((view) => `${view.terminal}=${view.state.kind}`).join(" ")}`);
  }

  /** Types `bytes` into the host as one read, now. */
  type(bytes: string): void {
    this.host.feed(bytes);
  }

  /** Types a comma-separated key list (see the top of this file), one read per item, the clock moving 1 ms between. */
  async keys(list: string): Promise<void> {
    for (const item of list.split(",")) {
      this.clock.current += 1;
      this.host.advance(1);
      this.type(keyBytes(item));
      await this.settle();
    }
  }

  /** The screen as the host shows it, one string per row, blanks at a row's end dropped. */
  grid(): string[] {
    const screen = this.loop.screen();
    if (!screen) return [];
    const rows: string[] = [];
    for (let row = 0; row < screen.rows; row++) {
      let text = "";
      for (let col = 0; col < screen.cols; col++) {
        const at = row * screen.cols + col;
        if (screen.width[at] !== 0) text += screen.text[at];
      }
      rows.push(text.trimEnd());
    }
    return rows;
  }

  /**
   * Empties what the run keeps for its tests: the frames the screen sent, the write times, the fake core's log and the
   * headless host's kept writes. A long run calls it before it measures memory, so it measures the screen and not this
   * tooling. The headless host (row 21's) keeps every write and has no call to drop them: its two lists are emptied here.
   */
  forget(): void {
    this.sent.length = 0;
    this.writeTimes.length = 0;
    this.core.log.length = 0;
    this.counted.read = 0;
    const kept = this.host as unknown as { entries: string[]; chunks: Uint8Array[] };
    kept.entries.length = 0;
    kept.chunks.length = 0;
  }

  /** Detaches through the screen's own quit (the reducer's `detach`) unless it ended already, then lets go of everything. */
  async close(): Promise<LoopEnd> {
    let end: LoopEnd | null = null;
    void this.loop.done.then((how) => { end = how; });
    /** the first error of the detach, the line's cut and the folder's removal: each is tried, and this one is thrown */
    let first: { error: unknown } | null = null;
    try {
      await this.settle();
      if (!end) {
        this.loop.dispatch({ type: "action", action: "detach", at: this.clock.current });
        for (let waited = 0; !end && waited < 3_000; waited += 100) await this.advance(100);
      }
    } catch (error) {
      first = { error };
    }
    try {
      await this.cutLine();
    } catch (error) {
      first ??= { error };
    }
    try {
      rmSync(this.folder, { recursive: true, force: true });
    } catch (error) {
      first ??= { error };
    }
    if (first) throw first.error;
    return end ?? { kind: "crashed", error: new Error("the screen did not end") };
  }
}

/** `COLSxROWS` within what an emulator takes (1x1 to 1000x500), or null. */
function parseSize(text: string): { cols: number; rows: number } | null {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(text);
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  return cols >= 1 && cols <= 1000 && rows >= 1 && rows <= 500 ? { cols, rows } : null;
}

const USAGE = "usage: bun tui/testing/run.ts [--fixture demo|agents|machines|scale] [--size COLSxROWS] [--keys <list>] [--dump] [--cut-line] [--crash]";

async function main(argv: string[]): Promise<number> {
  const choice = { fixture: "demo", size: { cols: 120, rows: 40 }, keys: "", dump: false, cut: false, crash: false };
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    const value = () => argv[++at];
    if (word === "--fixture") {
      const name = value();
      if (name === undefined || !Object.hasOwn(FIXTURES, name)) return usage(`unknown fixture ${JSON.stringify(name ?? "")}`);
      choice.fixture = name;
    } else if (word === "--size") {
      const size = parseSize(value() ?? "");
      if (!size) return usage("--size takes COLSxROWS between 1x1 and 1000x500");
      choice.size = size;
    } else if (word === "--keys") {
      const keys = value();
      if (keys === undefined) return usage("--keys takes a list");
      choice.keys = keys;
    } else if (word === "--dump") choice.dump = true;
    else if (word === "--cut-line") choice.cut = true;
    else if (word === "--crash") choice.crash = true;
    else return usage(`unknown argument ${JSON.stringify(word)}`);
  }
  if (choice.crash && !process.env["OVIS_TUI_STATE_DIR"]) return usage("--crash writes its record only into OVIS_TUI_STATE_DIR: set it");
  const run = await Run.start({ fixture: FIXTURES[choice.fixture]!, ...choice.size });
  await run.live();
  if (choice.cut) {
    await run.cutLine();
    await run.advance(1_000);
  }
  if (choice.keys) await run.keys(choice.keys);
  await run.advance(100);
  if (choice.crash) {
    run.host.duringNextWrite(() => { throw Object.assign(new Error("EBADF: bad file descriptor"), { code: "EBADF" }); });
    run.core.program(run.loop.panes.views()[0]!.terminal).output("x");
    await run.advance(100);
    const end = await Promise.race([run.loop.done, Promise.resolve(null)]);
    if (end?.kind !== "crashed") throw new Error(`the forced error did not end the screen: ${end?.kind ?? "still running"}`);
    const where = recordCrash(() => run.host.leave(), process.env["OVIS_TUI_STATE_DIR"]!, crashRecord(version, run.loop.report(), end.error, new Date()), process.pid);
    process.stderr.write(`ovis tui: crashed: a record is in ${where}\n`);
  }
  if (choice.dump) process.stdout.write(`${run.grid().join("\n")}\n`);
  const report = run.loop.report();
  const end = await run.close();
  process.stderr.write(`fixture=${choice.fixture} size=${choice.size.cols}x${choice.size.rows} passes=${report.passes} writes=${report.writes} link=${report.link.kind}${report.link.code ? `:${report.link.code}` : ""} end=${end.kind} maxArmed=${run.clock.maxArmed}\n`);
  return 0;
}

function usage(why: string): number {
  process.stderr.write(`run.ts: ${why}\n${USAGE}\n`);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
