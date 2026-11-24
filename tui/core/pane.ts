/**
 * The pane attach machine of the terminal screen: for each pane of the shown tab, the attach to its
 * terminal in herdr-core, the emulator the stream is fed into, the gate the user's input passes, and
 * the size rules (size.ts). It holds no terminal of its own: the attach stream is the truth, and
 * every attach starts a new emulator from the core's first paint.
 *
 * States of a pane, and the fourteen ways it moves (T1-T14 name them in the code):
 * - Idle: not attached. Opening: an attach is on its way. Painting: its reply is in, the first paint
 *   not yet drawn. Live: the picture is on the host; the only state that takes input. Closing: our
 *   CLOSE is out, the core's not yet in. Waiting: `offline` (no line to the core), `lost` (a kept
 *   terminal waits for its new shell), `closed` (the core closed the stream and the cause is being
 *   asked). Ended: the program finished. Failed: the attach was refused or cannot be shown; only the
 *   user's retry leaves it.
 *
 * What it guarantees, each tested after every step of random runs (pane.model.test.ts):
 * - Nothing typed arrives late. Input makes frames only inside `input`, only for a Live pane on an
 *   Online link, and only when it was read after the pane went live. A refused input is kept nowhere.
 *   There is no queue between the keyboard and a channel.
 * - No input before the replay ended: nothing but credit and CLOSE leaves a channel before Live.
 * - Generations do not mix: every attach has its own emulator, and what an older attach still
 *   delivers (a late reply, bytes, a CLOSE) only gets that attach's channel closed.
 * - Credit follows what the emulator consumed, and stops with our CLOSE.
 * - Close before attach: a new attach leaves only after the core answered the CLOSE of the one before.
 * - The size is never taken by the screen itself: every attach is a resumed plain viewer, and a RESIZE
 *   (and, on a core without automatic input, FOCUS 1) leaves only directly ahead of the user's own
 *   input in the focused pane, which is the one place called the take. Beside one other viewer a
 *   repaint leaves the terminal at the size the last viewer chose, also when that viewer chose it
 *   between the pane's CLOSE and its next attach: it advertises what the core last said of a viewed
 *   terminal, never the size its own CLOSE left behind, and it is made again at once when the core's
 *   event for its own size shows that it took the terminal from a choice it had not heard of yet.
 *   size.ts names the three cases that stay open until a user's next key or window change (an idle
 *   viewer at exactly 200x120 inside the gap, a reply that overtakes an idle viewer's event, three
 *   screens on one terminal): in them the terminal rests at an older size some viewer chose with its
 *   own rectangle, never at 200x120, and nothing attaches again.
 * - Nothing here throws into its caller or into the connection's reader, and no emulator is called
 *   from inside its own callback: what an emulator says during a write is acted on after it returned.
 *
 * Time is the caller's: the machine reads the injected clock, names its deadlines and acts on the
 * due ones in `fire`. Input events carry the time of the read that held them, on the same clock.
 */

import { type Channel, type ChannelHandlers, HcError } from "../../server/herdr-core/connection.ts";
import type { Display, TerminalAttachParams } from "../../server/herdr-core/hc-api.generated.ts";
import { TERMINAL_HISTORY_LINES } from "../../shared/terminal-flow.ts";
import { createEmulator } from "../emulator/ghostty.ts";
import type { Emulator, EmulatorOptions, EmulatorResult, EngineEvents } from "../emulator/index.ts";
import type { InputEvent } from "../input/decode.ts";
import { type Deadlines, NO_DEADLINES, PAINT_QUIET_MS, PANE_REOPEN_LIMIT, setDeadline } from "../model/deadlines.ts";
import type { CoreLink, LinkNotice } from "./link.ts";
import { attachSent, attachSize, detached, newPaneSize, overtaken, type PaneSize, reattachDue, reattaching, rectangleChanged, refused, replied, sameSize, type Size, sizedBy, sizeHeard, sizeTold, took } from "./size.ts";
import type { ProbeResult } from "../host/index.ts";
import { displayAfter, displayFacts, type Reply } from "../host/probe.ts";

/** Why a pane is Failed: the stable code beside its `reason`, which is for people. */
export type FailedCode = "attach" | "bad_reply" | "emulator" | "size" | "closed" | "record";

export type PaneState =
  | { kind: "Idle" }
  | { kind: "Opening" }
  | { kind: "Painting" }
  | { kind: "Live" }
  | { kind: "Closing" }
  | { kind: "Waiting"; why: "offline" | "lost" | "closed" }
  | { kind: "Ended"; reason: string; code: number | null }
  | { kind: "Failed"; code: FailedCode; reason: string };

/**
 * Why an input was not sent. By the pane's state: `idle`, `opening`, `painting`, `closing`, `offline`,
 * `lost`, `closed`, `ended`, `failed`. In a Live pane: `covered` (under a zoom), `early` (read before
 * the pane went live), `paste_cut` (the input layer cut the paste at its limit), `emulator` (it could
 * not be encoded). Dropped without a notice: `no_pane` (no focused pane, or it is gone), `unseen`
 * (the program cannot see this key or asked for no mouse), `release` (a key release, or a mouse move
 * or release, whose press was not sent on this attach).
 */
export type RefusalCode =
  | "idle" | "opening" | "painting" | "closing" | "offline" | "lost" | "closed" | "ended" | "failed"
  | "covered" | "early" | "paste_cut" | "emulator" | "no_pane" | "unseen" | "release";

/** `notice`: tell the user. True once per pane per state entry, so held keys do not repeat it. */
export type InputResult = { sent: true } | { sent: false; code: RefusalCode; notice: boolean };

/** What the input ladder hands a pane: a key, text, a paste or a mouse event of the host input decoder, with the time it was read. */
export type PaneInput = Extract<InputEvent, { type: "key" | "text" | "paste" | "mouse" }>;

type PaneEffect = Parameters<NonNullable<EngineEvents["onEffect"]>>[0];

/**
 * What the set tells its owner, never from inside an emulator's call:
 * - `state`: a pane's view changed (its state, its sizes, or its first paint is complete);
 * - `output`: its picture changed;
 * - `effect`: its program rang the bell or wrote the clipboard (Live panes only);
 * - `hold`: its picture began or ended a synchronized-output hold;
 * - `gone`: its terminal no longer exists; the pane was dropped.
 */
export type PaneNotice =
  | { type: "state"; terminal: string }
  | { type: "output"; terminal: string }
  | { type: "effect"; terminal: string; effect: PaneEffect }
  | { type: "hold"; terminal: string; held: boolean }
  | { type: "gone"; terminal: string };

/** A pane the shown tab's layout gives a rectangle; `covered`: a zoom hides it, so it stays attached and silent. */
export interface ShownPane { terminal: string; cols: number; rows: number; covered?: boolean }

export interface PaneView {
  terminal: string;
  state: PaneState;
  /** counts the attaches of this pane */
  gen: number;
  wanted: Size;
  /** the terminal's size as the attach in use was told it, which the emulator has; with no attach in use, the grid of the picture still shown */
  actual: Size | null;
  /** what the attach in use last told the core */
  advertised: Size | null;
  /** the real grid's size when it is not the pane's rectangle: the pane is drawn clipped (size.ts `clipTop`) with this in its notice */
  sizedBy: Size | null;
  /** the picture to draw: the newest attach's once its first paint is complete, until then the one before */
  emulator: Emulator | null;
  /** the grid `emulator` has, which a frame lays its picture out at (an attach whose first paint is not complete may have another); null with no picture */
  grid: Size | null;
  /** the first paint is complete: after the frame pass that draws it (and the read of what stdin still holds) the loop calls `live` */
  ready: boolean;
  covered: boolean;
  /** bytes consumed and not yet credited back to the core */
  owed: number;
}

/** What the machine needs of the core link. */
export type PaneLink = Pick<CoreLink, "state" | "attach" | "call">;

export interface PanesOptions {
  link: PaneLink;
  /** the loop's clock, in ms: the one the input events' `at` is read from */
  now: () => number;
  /** hears every notice, in order; what it throws is kept and thrown by the next `fire` (as the link does) */
  notify: (notice: PaneNotice) => void;
  /** makes each attach's emulator (the embedded engine unless a test hands in its own) */
  createEmulator?: (options: EmulatorOptions) => Promise<EmulatorResult<Emulator>>;
  /** the terminal this screen itself runs in, when the entry knows one: passed to every attach */
  caller?: string;
}

/** The panes of one screen. */
export interface Panes {
  /** Every notice of the core link, in the order it came. */
  notice(notice: LinkNotice): void;
  /** The panes of the shown tab with their rectangles: all of them, every time (a host resize, a layout change, a tab change). */
  show(panes: ShownPane[]): void;
  /** The pane the user's input goes to; selecting it never moves anything in the core. */
  focus(terminal: string | null): void;
  /** The host terminal's own focus report. */
  hostFocus(focused: boolean): void;
  /** What the host terminal looks like: sent with every attach and refreshed by FACTS. */
  setDisplay(display: Display | undefined): void;
  displayProbe(probe: ProbeResult): void;
  displayReply(reply: Reply): void;
  /** Input for the focused pane: sent now, or refused; never kept. */
  input(event: PaneInput): InputResult;
  /** Credits the core up to `budget` bytes of what this pane consumed, at a frame pass; answers how many. */
  credit(terminal: string, budget: number): number;
  /** The frame pass that drew a `ready` pane is over and stdin was read: the pane is Live from now. */
  live(terminal: string): boolean;
  /** The user's retry of a pane that failed or waits. */
  retry(terminal: string): void;
  /** `paint` and `reattach`: the earliest of each among the panes; `failure`: now, while an error of `notify` waits. */
  deadlines(): Deadlines;
  /** Acts on what is due, then throws what `notify` threw, if anything. */
  fire(): void;
  view(terminal: string): PaneView | undefined;
  views(): PaneView[];
  /** Detaches every pane (no terminal is killed) and settles once the core answered, or the line ended. */
  close(): Promise<void>;
}

export const PAINT_DEADLINE = "paint";
export const REATTACH_DEADLINE = "reattach";
export const FAILURE_DEADLINE = "failure";

/** What the machine keeps of a terminal's record: whether its program finished, and why it is not running. */
interface TerminalRecord { finished: boolean; reason: string | null; code: number | null }

/** One attach of a pane, from the call to the end of its stream: the pane's generation. */
interface Attempt {
  /** given up, or its stream is over: whatever it still delivers is not the pane's any more */
  abandoned: boolean;
  emulator: Emulator | null;
  /** the emulator's grid */
  grid: Size;
  /** the attach call left, with the size it advertises */
  sent: boolean;
  /** null until the attach reply was applied */
  channel: Channel | null;
  /** what the stream (and the event stream, after its first bytes) brought before the reply was applied, in order */
  early: ({ data: Uint8Array } | { size: Size })[];
  /** the stream ended before the reply was applied */
  closed: { reason: Record<string, unknown> | null } | null;
  /** delivered and not yet consumed by the emulator */
  backlog: Uint8Array[];
  /** what the emulator said during a write, acted on after it returned */
  out: ({ reply: Uint8Array } | { hold: boolean } | { effect: PaneEffect })[];
  mark: PaintMark;
  painted: boolean;
  /** since when the stream is quiet with nothing owed */
  quietFrom: number;
  owed: number;
  /** FOCUS 1 went out on this channel (a core without automatic input) */
  focusSent: boolean;
  keyDown: boolean;
  mouseDown: boolean;
  /** the display facts the core has from this channel, as JSON */
  toldDisplay: string;
}

const MARK = [0x1b, 0x5b, 0x3f, 0x39, 0x30, 0x30, 0x31] as const;

/** Finds the end of hc's first paint, `CSI ? 9001 h` or `l`, in a stream that may be cut anywhere. */
class PaintMark {
  private matched = 0;

  /** whether the mark ended in `bytes` */
  feed(bytes: Uint8Array): boolean {
    let found = false;
    for (const byte of bytes) {
      if (this.matched === MARK.length && (byte === 0x68 || byte === 0x6c)) found = true;
      this.matched = byte === MARK[this.matched] ? this.matched + 1 : byte === 0x1b ? 1 : 0;
    }
    return found;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function recordOf(data: unknown): TerminalRecord | null {
  if (!isRecord(data)) return null;
  return { finished: data["state"] === "finished", reason: typeof data["reason"] === "string" ? data["reason"] : null, code: typeof data["exit_code"] === "number" ? data["exit_code"] : null };
}

function sizeOf(data: unknown): Size | null {
  if (!isRecord(data)) return null;
  const { cols, rows } = data;
  return typeof cols === "number" && typeof rows === "number" && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1 ? { cols, rows } : null;
}

class Pane {
  state: PaneState = { kind: "Idle" };
  gen = 0;
  size: PaneSize;
  /** the shown tab gives it a rectangle */
  inTab = true;
  covered = false;
  /** the picture to draw */
  shown: Emulator | null = null;
  /** the grid `shown` has: set with it, and as it is resized (the attach on its way may have another one) */
  private shownGrid: Size | null = null;
  dropped = false;
  // What follows remembers something across steps. Each describes one thing and is cleared when that thing is over: a memory that
  // outlives what it describes is counted again later (the waits of `size` follow the same rule, in size.ts).
  private attempt: Attempt | null = null;
  /** attaches given up whose channel the core has not closed yet: the next attach waits for them; each ends when the core answered or its line ended */
  private unsettled = 0;
  private liveSince = 0;
  private noticed = false;
  /**
   * whether the program was last told (or would have been, had it asked for focus reports) that its pane has the focus. It is the
   * program's belief, so it ends with the program (finished, lost, a new shell), with the line (the screen cannot know what is at
   * the other end of the next one) and when the pane leaves the tab, where the program is told
   */
  private inFocus = false;
  /** attaches made in a row without the user. The row ends when the pane is Live, when the user asks anew (retry, shown again), with a new shell and with the line */
  private reopens = 0;
  /** the `terminal.get` whose answer decides a Waiting(closed) pane: it belongs to that state and ends when the pane leaves it */
  private probing: object | null = null;

  constructor(private readonly set: PaneSet, readonly terminal: string, rectangle: Size) {
    this.size = newPaneSize(rectangle);
  }

  view(): PaneView {
    const attempt = this.attempt;
    return {
      terminal: this.terminal, state: this.state, gen: this.gen, wanted: this.size.wanted, actual: this.size.actual, advertised: this.size.advertised,
      sizedBy: sizedBy(this.size), emulator: this.shown, grid: this.shown ? this.shownGrid : null, ready: this.state.kind === "Painting" && attempt?.painted === true, covered: this.covered, owed: attempt?.owed ?? 0,
    };
  }

  private become(state: PaneState): void {
    // a pane the shown tab no longer holds only waits for its CLOSE to be answered, whatever becomes of its terminal or its line meanwhile
    if (!this.inTab && state.kind !== "Closing") return;
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.noticed = false;
    this.probing = null;
    // no attach is in use any more (one that still drains takes no input): what it advertised and what waited for it are over
    if (state.kind === "Waiting" || state.kind === "Ended" || state.kind === "Failed") this.size = detached(this.size);
    this.set.tell({ type: "state", terminal: this.terminal });
  }

  /** Where a pane that holds no attach stands, by the link and its terminal's record; a terminal that lives is attached (T1). */
  settle(): void {
    if (!this.set.online()) return this.become({ kind: "Waiting", why: "offline" });
    const record = this.set.records.get(this.terminal);
    if (!record) return this.become({ kind: "Idle" });
    if (record.finished) return this.become({ kind: "Ended", reason: record.reason ?? "finished", code: record.code });
    if (record.reason !== null) return this.become({ kind: "Waiting", why: "lost" });
    this.toIdle();
  }

  /** On the way to a new attach: a stream still open is closed first, and the attach waits for the core's CLOSE. */
  private toIdle(): void {
    this.abandon();
    if (this.unsettled > 0) return this.become({ kind: "Closing" });
    this.become({ kind: "Idle" });
    this.open();
  }

  /** T1: a new generation with a new emulator, attached as a resumed plain viewer. */
  private open(): void {
    const record = this.set.records.get(this.terminal);
    if (this.state.kind !== "Idle" || this.attempt || this.unsettled > 0 || !this.inTab || !this.set.online() || !record || record.finished || record.reason !== null) return;
    const attempt: Attempt = {
      abandoned: false, emulator: null, grid: attachSize(this.size), sent: false, channel: null, early: [], closed: null, backlog: [], out: [],
      mark: new PaintMark(), painted: false, quietFrom: 0, owed: 0, focusSent: false, keyDown: false, mouseDown: false, toldDisplay: "{}",
    };
    this.attempt = attempt;
    this.gen++;
    this.become({ kind: "Opening" });
    this.set.track(this.attach(attempt));
  }

  /** One attach from its emulator to its reply. Every step after a wait first asks whether the attach was given up meanwhile. */
  private async attach(attempt: Attempt): Promise<void> {
    let made: EmulatorResult<Emulator>;
    try {
      made = await this.set.options.createEmulator({
        cols: attempt.grid.cols,
        rows: attempt.grid.rows,
        // the emulator calls these from inside its own write: they only note what it said, and `pump` acts once the write returned
        events: {
          onReply: (reply) => { attempt.out.push({ reply }); },
          onHold: (hold) => { attempt.out.push({ hold }); },
          onEffect: (effect) => { attempt.out.push({ effect }); },
        },
      });
    } catch (error) {
      made = { ok: false, error: { kind: "failed", message: messageOf(error) } };
    }
    if (made.ok) attempt.emulator = made.value;
    if (attempt.abandoned) return this.set.enter(() => this.over(attempt));
    if (!made.ok) {
      const { kind, message } = made.error;
      return this.set.enter(() => {
        this.attempt = null;
        // a repaint at a size another viewer chose and no emulator takes: the terminal cannot be drawn until it has another size, as on an attach in use
        this.fail(kind === "size" && !sameSize(attempt.grid, this.size.wanted) ? "size" : "emulator", message);
      });
    }
    // the size is read as the attach leaves: the rectangle may have changed while the emulator was made
    const size = attachSize(this.size);
    this.size = attachSent(this.size, size);
    attempt.sent = true;
    const display = this.set.display;
    const caller = this.set.options.caller;
    const params: TerminalAttachParams = {
      terminal: this.terminal, cols: size.cols, rows: size.rows, history: TERMINAL_HISTORY_LINES, resumed: true,
      ...(display === undefined ? {} : { display }), ...(caller === undefined ? {} : { caller }),
    };
    attempt.toldDisplay = JSON.stringify(display ?? {});
    let opened: Awaited<ReturnType<PaneLink["attach"]>>;
    try {
      opened = await this.set.options.link.attach(params, this.handlers(attempt));
    } catch (error) {
      return this.set.enter(() => {
        if (attempt.abandoned) return this.over(attempt);
        this.attempt = null;
        attempt.emulator?.dispose();
        this.refused(error);
      });
    }
    if (attempt.abandoned) {
      // a reply for an attach given up meanwhile still owns a channel: it is closed, and the next attach waits for that too
      await opened.channel.close();
      return this.set.enter(() => this.over(attempt));
    }
    this.set.enter(() => this.replied(attempt, opened.result, opened.channel));
  }

  /** An attach that was given up while on its way has come back. */
  private over(attempt: Attempt): void {
    attempt.emulator?.dispose();
    this.release();
  }

  private handlers(attempt: Attempt): ChannelHandlers {
    return {
      credit: "manual",
      onData: (data) => this.set.enter(() => {
        if (attempt.abandoned) return;
        if (!attempt.channel) {
          attempt.early.push({ data });
          return;
        }
        attempt.backlog.push(data);
        this.pump(attempt);
      }),
      onClose: (reason) => this.set.enter(() => {
        if (attempt.abandoned) return;
        if (!attempt.channel) attempt.closed = { reason };
        else this.coreClosed(attempt, reason);
      }),
    };
  }

  /** T2: the reply is in. The emulator gets the terminal's real size before the first byte is fed. */
  private replied(attempt: Attempt, result: unknown, channel: Channel): void {
    const actual = sizeOf(isRecord(result) ? result["terminal"] : null);
    if (!actual) {
      this.attempt = null;
      attempt.abandoned = true;
      attempt.emulator?.dispose();
      this.unsettled++;
      this.set.track(channel.close().then(() => this.set.enter(() => this.release())));
      this.fail("bad_reply", "herdr-core answered the attach without the terminal's size");
      return;
    }
    attempt.channel = channel;
    attempt.quietFrom = this.set.now();
    this.size = replied(this.size, actual);
    this.become({ kind: "Painting" });
    this.displayChanged();
    // what came while the reply was on its way, in its order: a `size` event after the stream's first bytes is newer than the reply
    for (const item of attempt.early.splice(0)) {
      if (this.attempt !== attempt) {
        // the attach was given up while this was replayed. When it is made again at once (the repaint took the terminal from a newer
        // choice), what the core said of the size behind it is still heard: it may be a choice newer still
        if ("size" in item && this.state.kind === "Closing") this.sizeEvent(item.size);
        continue;
      }
      if ("size" in item) this.sizeEvent(item.size);
      else {
        attempt.backlog.push(item.data);
        this.pump(attempt);
      }
    }
    if (this.attempt === attempt) this.pump(attempt);
    if (this.attempt === attempt && attempt.closed) this.coreClosed(attempt, attempt.closed.reason);
  }

  /** T3: the attach was refused. */
  private refused(error: unknown): void {
    const kind = error instanceof HcError ? error.kind : "error";
    if (kind === "unavailable") return this.become({ kind: "Waiting", why: "lost" });
    if (kind === "finished") {
      const record = this.set.records.get(this.terminal);
      return this.become({ kind: "Ended", reason: record?.finished ? record.reason ?? "finished" : "finished", code: record?.finished ? record.code : null });
    }
    if (kind === "not_found") return this.gone();
    if (kind === "timeout" || kind === "closed" || kind === "offline") return this.become({ kind: "Waiting", why: "offline" });
    this.fail("attach", `${kind}: ${messageOf(error)}`);
  }

  /** Gives the emulator the terminal's real size (S6); false when it cannot be fed now. */
  private fit(attempt: Attempt): boolean {
    const actual = this.size.actual;
    if (!actual || sameSize(attempt.grid, actual)) return true;
    const cell = this.set.display?.cell ?? [0, 0];
    const resized = attempt.emulator!.resize(actual.cols, actual.rows, cell[0], cell[1]);
    if (resized.ok) {
      attempt.grid = actual;
      if (attempt.emulator === this.shown) this.shownGrid = actual;
      return true;
    }
    const { kind, message } = resized.error;
    if (kind === "trapped") this.rebuild(attempt, message);
    else if (kind === "size" || kind === "failed") {
      // a grid no emulator takes, or one it refused: this terminal cannot be drawn until it has another size. A picture still
      // shown keeps its own grid, which may be an earlier attach's
      this.abandon();
      this.size = refused(this.size, this.shown ? this.shownGrid : null);
      this.fail("size", message);
    }
    // busy or disposed: nothing was done, and the next pump asks again
    return false;
  }

  /** T4, T5: feeds what the stream delivered, in order, and then acts on what the emulator said meanwhile. */
  private pump(attempt: Attempt): void {
    let fed = false;
    while (this.attempt === attempt && this.fit(attempt) && attempt.backlog.length > 0) {
      const bytes = attempt.backlog[0]!;
      const written = attempt.emulator!.write(bytes);
      // `failed`: a handler threw, and the bytes went in all the same
      if (!written.ok && written.error.kind !== "failed") {
        // busy or disposed: the emulator was not entered and the bytes wait; only a trap ends it
        if (written.error.kind === "trapped") this.rebuild(attempt, written.error.message);
        break;
      }
      attempt.backlog.shift();
      attempt.owed += bytes.length;
      attempt.quietFrom = this.set.now();
      fed = true;
      if (!attempt.painted && attempt.mark.feed(bytes)) this.painted(attempt);
      this.said(attempt);
    }
    if (fed) this.set.tell({ type: "output", terminal: this.terminal });
  }

  /** The first paint is complete: from here the new picture is the one to draw. */
  private painted(attempt: Attempt): void {
    attempt.painted = true;
    if (this.shown !== attempt.emulator) {
      this.shown?.dispose();
      this.shown = attempt.emulator;
    }
    this.shownGrid = attempt.grid;
    this.set.tell({ type: "state", terminal: this.terminal });
  }

  /** What the emulator said during the write that just returned: replies for the program, effects and holds for the owner. */
  private said(attempt: Attempt): void {
    for (const item of attempt.out.splice(0)) {
      if ("reply" in item) this.reply(attempt, item.reply);
      else if ("hold" in item) {
        if (attempt.emulator === this.shown) this.set.tell({ type: "hold", terminal: this.terminal, held: item.hold });
      } else if (this.state.kind === "Live") this.set.tell({ type: "effect", terminal: this.terminal, effect: item.effect });
    }
  }

  /**
   * A reply of the pane's own emulator, in Live only. As automatic input it is nobody's typing. On a
   * core without it the bytes are DATA, which makes this viewer the active one: only the pane the
   * user drives (focused, typed into on this attach, advertising its rectangle) may send them.
   */
  private reply(attempt: Attempt, bytes: Uint8Array): void {
    const channel = attempt.channel;
    if (this.state.kind !== "Live" || !channel || this.covered) return;
    if (channel.automaticInput) channel.writeAutomatic(bytes);
    else if (this.set.owns(this) && attempt.focusSent && this.advertisesRectangle()) channel.write(bytes);
  }

  /** The frame pass that drew the new picture is over, and what stdin still held was read: input counts from now. */
  live(): boolean {
    if (this.state.kind !== "Painting" || !this.attempt?.painted) return false;
    this.liveSince = this.set.now();
    this.reopens = 0;
    this.become({ kind: "Live" });
    this.focus(this.set.owns(this));
    return true;
  }

  /** T10, T11: the core closed the stream, or its line ended. The CLOSE says what the pane is, else the record, else the core is asked once. */
  private coreClosed(attempt: Attempt, reason: Record<string, unknown> | null): void {
    this.attempt = null;
    attempt.abandoned = true;
    if (attempt.emulator !== this.shown) attempt.emulator?.dispose();
    const why = typeof reason?.["reason"] === "string" ? reason["reason"] : null;
    // a core that is stopped closes its streams itself before its line ends: it is going away
    if (why === "connection_lost" || why === "server_stop") return this.offline();
    if (typeof reason?.["finished_ms"] === "number") {
      const code = typeof reason["exit_code"] === "number" ? reason["exit_code"] : null;
      this.set.records.set(this.terminal, { finished: true, reason: why, code });
      return this.finished(why ?? "finished", code);
    }
    const record = this.set.records.get(this.terminal);
    if (why === "signaled" && record && !record.finished) record.reason = why;
    if (record?.finished) return this.finished(record.reason ?? "finished", record.code);
    if (record && record.reason !== null) return this.lost();
    this.become({ kind: "Waiting", why: "closed" });
    this.probe();
  }

  /** One `terminal.get` decides a stream closed without a cause: finished, lost, or still live (a relay dropped it), which is attached again a bounded number of times. */
  private probe(): void {
    const token = (this.probing = {});
    // an answer counts only while the pane still waits for it: `become` drops the token with the state
    const decide = (apply: () => void) => this.set.enter(() => {
      if (this.probing === token) apply();
    });
    this.set.track(this.set.options.link.call("terminal.get", { terminal: this.terminal }).then(
      (answer) => decide(() => {
        const record = recordOf(answer);
        if (!record) return this.fail("record", "herdr-core answered terminal.get without a record");
        this.set.records.set(this.terminal, record);
        if (!record.finished && record.reason === null && ++this.reopens > PANE_REOPEN_LIMIT) return this.fail("closed", "herdr-core keeps closing this terminal's stream");
        this.settle();
      }),
      (error: unknown) => decide(() => {
        const kind = error instanceof HcError ? error.kind : "error";
        if (kind === "not_found") return this.gone();
        if (kind === "timeout" || kind === "closed" || kind === "offline") return this.become({ kind: "Waiting", why: "offline" });
        this.fail("record", `${kind}: ${messageOf(error)}`);
      }),
    ));
  }

  /** T11: there is no line; Ended and Failed stay what they are. */
  private offline(): void {
    this.inFocus = false;
    this.reopens = 0;
    if (this.state.kind !== "Ended" && this.state.kind !== "Failed") this.become({ kind: "Waiting", why: "offline" });
  }

  /** The link is not Online: whatever attach there was is over with its line. */
  linkDown(): void {
    this.abandon();
    this.offline();
  }

  /** T7: the gate shuts at once; the stream is still fed until the core closes it. */
  lost(): void {
    this.inFocus = false;
    if (this.attempt && !this.attempt.channel) this.abandon();
    this.become({ kind: "Waiting", why: "lost" });
  }

  /** T9: the gate shuts; what the program still had to say is fed until the core's CLOSE. */
  finished(reason: string, code: number | null): void {
    this.inFocus = false;
    if (this.attempt && !this.attempt.channel) this.abandon();
    this.become({ kind: "Ended", reason, code });
  }

  /** T8: the terminal has a new shell: a new generation, once the old channel is closed. */
  restarted(): void {
    this.inFocus = false;
    this.reopens = 0;
    this.abandon();
    // the new shell is attached as any first attach: what waited belonged to the old one
    this.size = detached(this.size);
    this.settle();
  }

  /** T13 and `missed`: a snapshot of the terminals. The record decides what a pane without a running attach is. */
  resynced(): void {
    const record = this.set.records.get(this.terminal);
    if (!record) return this.gone();
    if (record.finished) return this.finished(record.reason ?? "finished", record.code);
    if (record.reason !== null) return this.lost();
    if (this.state.kind === "Waiting" || this.state.kind === "Ended" || this.state.kind === "Idle") this.settle();
  }

  /** T12: the terminal no longer exists. */
  gone(): void {
    this.probing = null;
    this.abandon();
    this.shown?.dispose();
    this.shown = null;
    this.set.drop(this);
    this.set.tell({ type: "gone", terminal: this.terminal });
  }

  /** T6: the shown tab no longer holds this pane. The program hears the focus leave where it heard it come, then the channel is closed. */
  hide(): void {
    this.inTab = false;
    this.probing = null;
    this.reopens = 0;
    const attempt = this.attempt;
    if (attempt?.channel) {
      this.focus(false);
      // FOCUS 0 only on a channel that got FOCUS 1 from this screen: the core passes it on from any viewer
      if (attempt.focusSent) attempt.channel.focus(false);
    }
    this.inFocus = false;
    this.abandon();
    this.size = detached(this.size);
    this.shown?.dispose();
    this.shown = null;
    if (this.unsettled > 0) this.become({ kind: "Closing" });
    else this.set.drop(this);
  }

  /** The shown tab holds the pane (again, or still), with this rectangle. */
  shownAt(rectangle: Size, covered: boolean): void {
    this.inTab = true;
    const size = rectangleChanged(this.size, rectangle, this.set.now());
    const uncovered = this.covered && !covered;
    if (size !== this.size || covered !== this.covered) this.set.tell({ type: "state", terminal: this.terminal });
    this.size = size;
    this.covered = covered;
    if (uncovered) this.focus(this.set.owns(this));
  }

  /** Gives up the attach in use, if any: our CLOSE when its channel is here. The next attach waits until the core answered it. */
  private abandon(): void {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    attempt.abandoned = true;
    this.unsettled++;
    if (attempt.emulator !== this.shown) attempt.emulator?.dispose();
    // without a channel yet, the attach on its way releases the pane when it comes back (`over`)
    if (attempt.channel) this.set.track(attempt.channel.close().then(() => this.set.enter(() => this.release())));
  }

  /** The core answered a CLOSE of ours (or the line ended): once none is out, the pane may attach again. */
  private release(): void {
    this.unsettled--;
    if (this.unsettled > 0 || this.dropped) return;
    if (!this.inTab) return this.set.drop(this);
    if (this.state.kind === "Closing") this.settle();
  }

  /** The emulator trapped: it is dead, and so is this generation. A new one is made, a bounded number of times in a row. */
  private rebuild(attempt: Attempt, reason: string): void {
    if (attempt.emulator === this.shown) this.shown = null;
    attempt.emulator?.dispose();
    this.abandon();
    this.size = detached(this.size);
    if (++this.reopens > PANE_REOPEN_LIMIT) this.fail("emulator", reason);
    else this.toIdle();
  }

  private fail(code: FailedCode, reason: string): void {
    this.become({ kind: "Failed", code, reason });
  }

  retry(): void {
    if (this.state.kind !== "Failed" && this.state.kind !== "Waiting") return;
    this.reopens = 0;
    this.settle();
  }

  /** The attach in use: its reply is in, and its stream is the picture the pane draws. Only it is told the terminal's size, and only it is attached again. */
  private inUse(): Attempt | null {
    const attempt = this.attempt;
    return attempt?.channel && (this.state.kind === "Painting" || this.state.kind === "Live") ? attempt : null;
  }

  /**
   * T14: the core said the terminal's size. On the attach in use the emulator follows at once, and a new attach may follow later
   * (size.ts). With no attach in use the size changes neither the picture still shown nor its notice: it is the size the last
   * viewer chose, which the pane's repaint advertises, unless it is the size the core gives a terminal nobody views. And when the
   * core's event for the size a repaint set shows that it took the terminal from such a choice, the repaint is made again at once:
   * every other screen that heard its size waits before it repaints at it.
   */
  sizeEvent(size: Size): void {
    const attempt = this.inUse();
    if (!attempt) {
      // behind the first bytes of an attach whose reply is still on its way, the event is newer than that reply: it waits for it
      if (this.attempt && !this.attempt.channel && this.attempt.early.length > 0) {
        this.attempt.early.push({ size });
        return;
      }
      // a terminal that could not be drawn at its size has another one now
      if (this.state.kind === "Failed" && this.state.code === "size") return this.retry();
    }
    const before = this.size;
    const now = this.set.now();
    // an attach the pane shows (Live) is told the size; before that the pane only hears it
    const stage = !attempt ? (this.attempt?.sent ? "sent" : "none") : this.state.kind === "Painting" ? "unshown" : null;
    const again = attempt !== null && overtaken(before, size);
    this.size = stage === null ? sizeTold(before, size, now) : sizeHeard(before, size, now, stage);
    if (attempt) {
      this.pump(attempt);
      if (!sameSize(before.actual, size)) this.set.tell({ type: "state", terminal: this.terminal });
    }
    // a change of the rectangle that waits is attached with the rectangle, once its own wait is over
    if (again && this.attempt === attempt && this.size.ownAt === null) this.attachAgain();
  }

  /**
   * Close, wait for the core's CLOSE, then attach. The size keeps what waits until that attach leaves, which reads from it whether
   * it carries the rectangle or (after another viewer's resize) only repaints, at the size the last viewer chose.
   */
  private attachAgain(): void {
    this.size = reattaching(this.size);
    this.abandon();
    this.toIdle();
  }

  /** When this pane has something to do by the clock: its first paint without a mark, and a new attach. */
  due(): { paint?: number; reattach?: number } {
    const attempt = this.attempt;
    const due: { paint?: number; reattach?: number } = {};
    if (this.state.kind === "Painting" && attempt?.channel && !attempt.painted && attempt.owed === 0 && attempt.backlog.length === 0) due.paint = attempt.quietFrom + PAINT_QUIET_MS;
    const reattach = this.reattach();
    if (reattach !== null) due.reattach = reattach;
    return due;
  }

  /** A pane attaches again only where a picture is shown and frames may leave: attached, and not under a zoom. */
  private reattach(): number | null {
    return this.covered || !this.inUse() ? null : reattachDue(this.size);
  }

  fire(now: number): void {
    const attempt = this.attempt;
    if (attempt?.channel && attempt.backlog.length > 0) this.pump(attempt);
    const { paint } = this.due();
    if (paint !== undefined && now >= paint && this.attempt) this.painted(this.attempt);
    const reattach = this.reattach();
    if (reattach !== null && now >= reattach) this.attachAgain();
  }

  credit(budget: number): number {
    const attempt = this.attempt;
    if (!attempt?.channel || this.covered) return 0;
    if (attempt.backlog.length > 0) this.pump(attempt);
    const bytes = Math.min(attempt.owed, Math.floor(budget));
    if (this.attempt !== attempt || !(bytes > 0)) return 0;
    attempt.channel.credit(bytes);
    attempt.owed -= bytes;
    if (attempt.owed === 0) attempt.quietFrom = this.set.now();
    return bytes;
  }

  /**
   * The focus contract on a channel with automatic input: the program hears the focus enter and leave
   * its pane, once each, as bytes that are nobody's typing; mode 1004 is read from the emulator, since
   * the core passes such bytes to a program that never asked. Without automatic input nothing is
   * written here: there the focus-in travels with the take.
   */
  focus(owner: boolean): void {
    const attempt = this.attempt;
    if (this.state.kind !== "Live" || !attempt?.channel?.automaticInput || this.covered || owner === this.inFocus) return;
    const modes = attempt.emulator!.modes();
    if (!modes.ok) return;
    this.inFocus = owner;
    if (modes.value.focusReports) attempt.channel.writeAutomatic(owner ? "\x1b[I" : "\x1b[O");
  }

  /** Whether DATA may leave as it is: it makes this viewer the active one with the size its channel advertises, which must be the rectangle. */
  private advertisesRectangle(): boolean {
    return sameSize(this.size.wanted, this.size.advertised);
  }

  /** Both core releases understand FACTS, which updates this viewer without taking the terminal's size. */
  displayChanged(): void {
    const attempt = this.attempt;
    if (!attempt?.channel || attempt.closed) return;
    const display = JSON.stringify(this.set.display ?? {});
    if (display === attempt.toldDisplay) return;
    attempt.channel.facts({ ...this.set.display });
    attempt.toldDisplay = display;
  }

  /** The input gate, and behind it the take. */
  input(event: PaneInput): InputResult {
    const press = event.type === "text" || event.type === "paste" || event.action === "press" || event.action === "repeat";
    const refusal: RefusalCode | null = this.state.kind !== "Live" ? (this.state.kind === "Waiting" ? this.state.why : this.state.kind.toLowerCase() as RefusalCode)
      : !this.set.online() ? "offline"
      : this.covered ? "covered"
      // read before the pane went live (or at an unknown time): what was typed at an older picture is not sent to the new one
      : !(event.at > this.liveSince) ? "early"
      : null;
    if (refusal) {
      const notice = press && !this.noticed;
      if (press) this.noticed = true;
      return { sent: false, code: refusal, notice };
    }
    const attempt = this.attempt!;
    const channel = attempt.channel!;
    const emulator = attempt.emulator!;
    if (event.type === "paste" && !event.complete) return { sent: false, code: "paste_cut", notice: true };
    if (event.type === "key" && event.key === "UNIDENTIFIED") return { sent: false, code: "unseen", notice: false };
    const encoded: EmulatorResult<Uint8Array> = event.type === "text" ? { ok: true, value: new TextEncoder().encode(event.text) }
      : event.type === "paste" ? emulator.encodePaste(event.text)
      : event.type === "mouse" ? emulator.encodeMouse({ action: event.action, mods: event.mods, col: event.col, row: event.row, ...(event.button === undefined ? {} : { button: event.button }) })
      : emulator.encodeKey({ key: event.key, mods: event.mods, action: event.action, ...(event.text === undefined ? {} : { text: event.text }), ...(event.unshifted === undefined ? {} : { unshifted: event.unshifted }) });
    if (!encoded.ok) {
      if (encoded.error.kind === "trapped") this.rebuild(attempt, encoded.error.message);
      return { sent: false, code: "emulator", notice: true };
    }
    if (encoded.value.length === 0) return { sent: false, code: "unseen", notice: false };
    if (!press) {
      // a release or a move belongs to a press sent on this attach; it never takes the size, so it never leaves ahead of one
      // a motion with no button (the program asked for any-motion, 1003) is the pointer passing: herdr sends it from the start
      const hover = event.type === "mouse" && event.action === "motion" && event.button === undefined;
      const down = event.type === "key" ? attempt.keyDown : attempt.mouseDown;
      if ((!down && !hover) || !this.advertisesRectangle()) return { sent: false, code: "release", notice: false };
      channel.write(encoded.value);
      return { sent: true };
    }
    // the take: the one place a RESIZE leaves. DATA makes this viewer the active one with the size it advertises, so the rectangle is advertised first
    if (!this.advertisesRectangle()) channel.resize(this.size.wanted.cols, this.size.wanted.rows);
    this.size = took(this.size);
    if (!channel.automaticInput && !attempt.focusSent) {
      channel.focus(true);
      attempt.focusSent = true;
    }
    channel.write(encoded.value);
    if (event.type === "key") attempt.keyDown = true;
    else if (event.type === "mouse") attempt.mouseDown = true;
    return { sent: true };
  }
}

class PaneSet implements Panes {
  readonly records = new Map<string, TerminalRecord>();
  readonly options: PanesOptions & { createEmulator: NonNullable<PanesOptions["createEmulator"]> };
  display: Display | undefined;
  private readonly panes = new Map<string, Pane>();
  private target: string | null = null;
  private hostFocused = true;
  /** calls into the set that are running: notices wait until the outermost returned */
  private depth = 0;
  private readonly outbox: PaneNotice[] = [];
  /** what `notify` threw, until `fire` throws it */
  private failure: { error: unknown } | null = null;
  /** attaches and CLOSEs on their way */
  private readonly settling = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: PanesOptions) {
    this.options = { ...options, createEmulator: options.createEmulator ?? createEmulator };
  }

  now(): number {
    return this.options.now();
  }

  online(): boolean {
    return !this.closed && this.options.link.state.kind === "Online";
  }

  /** Whether `pane` is where the user's input goes, on a host terminal that has the focus. */
  owns(pane: Pane): boolean {
    return this.hostFocused && this.target === pane.terminal;
  }

  track(work: Promise<unknown>): void {
    this.settling.add(work);
    const done = () => { this.settling.delete(work); };
    work.then(done, done);
  }

  drop(pane: Pane): void {
    pane.dropped = true;
    if (this.panes.get(pane.terminal) === pane) this.panes.delete(pane.terminal);
  }

  /** Runs one entry into the set; the notices it made are told once the outermost entry returned, so the owner never hears one mid-change. */
  enter<T>(run: () => T): T {
    this.depth++;
    try {
      return run();
    } finally {
      if (--this.depth === 0) this.flush();
    }
  }

  tell(notice: PaneNotice): void {
    this.outbox.push(notice);
    if (this.depth === 0) this.flush();
  }

  private flush(): void {
    this.depth++;
    try {
      for (let notice = this.outbox.shift(); notice; notice = this.outbox.shift()) {
        try {
          this.options.notify(notice);
        } catch (error) {
          this.failure ??= { error };
        }
      }
    } finally {
      this.depth--;
    }
  }

  notice(notice: LinkNotice): void {
    this.enter(() => {
      if (this.closed) return;
      if (notice.type === "state") {
        if (notice.state.kind === "Online") return;
        // what was known of the terminals was the old line's: the next line's snapshot says it anew
        this.records.clear();
        for (const pane of [...this.panes.values()]) pane.linkDown();
      } else if (notice.type === "snapshot") {
        this.records.clear();
        for (const terminal of notice.terminals) {
          const record = recordOf(terminal);
          if (record && isRecord(terminal) && typeof terminal["address"] === "string") this.records.set(terminal["address"], record);
        }
        for (const pane of [...this.panes.values()]) pane.resynced();
      } else if (notice.type === "event") this.event(notice.event);
    });
  }

  private event(event: Extract<LinkNotice, { type: "event" }>["event"]): void {
    const terminal = event.terminal;
    // another machine's terminals are not this screen's
    if (terminal === undefined || event.machine !== undefined) return;
    const pane = this.panes.get(terminal);
    const record = this.records.get(terminal);
    if (event.type === "created" || event.type === "restarted") {
      const made = recordOf(event.data);
      if (!made) return;
      this.records.set(terminal, made);
      if (event.type === "restarted") pane?.restarted();
      else if (pane?.state.kind === "Idle") pane.settle();
    } else if (event.type === "lost") {
      if (record) record.reason = typeof event.data?.["reason"] === "string" ? event.data["reason"] : "lost";
      pane?.lost();
    } else if (event.type === "finished") {
      const reason = typeof event.data?.["reason"] === "string" ? event.data["reason"] : "finished";
      const code = typeof event.data?.["exit_code"] === "number" ? event.data["exit_code"] : null;
      this.records.set(terminal, { finished: true, reason, code });
      // a core that is stopped finishes every terminal on its way out: the end of its line says what the pane becomes
      if (reason !== "server_stop") pane?.finished(reason, code);
    } else if (event.type === "removed") {
      this.records.delete(terminal);
      pane?.gone();
    } else if (event.type === "size") {
      const size = sizeOf(event.data);
      if (size) pane?.sizeEvent(size);
    }
  }

  show(shown: ShownPane[]): void {
    this.enter(() => {
      if (this.closed) return;
      const held = new Set(shown.map((pane) => pane.terminal));
      for (const pane of [...this.panes.values()]) if (pane.inTab && !held.has(pane.terminal)) pane.hide();
      for (const { terminal, cols, rows, covered } of shown) {
        const pane = this.panes.get(terminal);
        if (pane) {
          pane.shownAt({ cols, rows }, covered === true);
          continue;
        }
        const made = new Pane(this, terminal, { cols, rows });
        made.covered = covered === true;
        this.panes.set(terminal, made);
        made.settle();
      }
    });
  }

  focus(terminal: string | null): void {
    this.enter(() => {
      this.target = terminal;
      this.refocus();
    });
  }

  hostFocus(focused: boolean): void {
    this.enter(() => {
      this.hostFocused = focused;
      this.refocus();
    });
  }

  private refocus(): void {
    for (const pane of this.panes.values()) pane.focus(this.owns(pane));
  }

  setDisplay(display: Display | undefined): void {
    if (display === this.display) return;
    this.enter(() => {
      this.display = display;
      for (const pane of this.panes.values()) pane.displayChanged();
    });
  }

  displayProbe(probe: ProbeResult): void {
    const initial = displayFacts(probe);
    // A reply following DA1 in the same read can arrive before the probe's promise settles here.
    if (initial) this.setDisplay({ ...initial, ...this.display });
  }

  displayReply(reply: Reply): void {
    this.setDisplay(displayAfter(this.display, reply));
  }

  input(event: PaneInput): InputResult {
    return this.enter(() => {
      const pane = this.target === null ? undefined : this.panes.get(this.target);
      return pane ? pane.input(event) : { sent: false, code: "no_pane", notice: false };
    });
  }

  credit(terminal: string, budget: number): number {
    return this.enter(() => this.panes.get(terminal)?.credit(budget) ?? 0);
  }

  live(terminal: string): boolean {
    return this.enter(() => this.panes.get(terminal)?.live() ?? false);
  }

  retry(terminal: string): void {
    this.enter(() => this.panes.get(terminal)?.retry());
  }

  deadlines(): Deadlines {
    let paint: number | undefined;
    let reattach: number | undefined;
    for (const pane of this.panes.values()) {
      const due = pane.due();
      if (due.paint !== undefined && (paint === undefined || due.paint < paint)) paint = due.paint;
      if (due.reattach !== undefined && (reattach === undefined || due.reattach < reattach)) reattach = due.reattach;
    }
    let deadlines = NO_DEADLINES;
    if (paint !== undefined) deadlines = setDeadline(deadlines, PAINT_DEADLINE, paint);
    if (reattach !== undefined) deadlines = setDeadline(deadlines, REATTACH_DEADLINE, reattach);
    if (this.failure) deadlines = setDeadline(deadlines, FAILURE_DEADLINE, this.now());
    return deadlines;
  }

  fire(): void {
    this.enter(() => {
      const now = this.now();
      for (const pane of [...this.panes.values()]) pane.fire(now);
    });
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure.error;
  }

  view(terminal: string): PaneView | undefined {
    return this.panes.get(terminal)?.view();
  }

  views(): PaneView[] {
    return [...this.panes.values()].map((pane) => pane.view());
  }

  async close(): Promise<void> {
    this.enter(() => {
      this.closed = true;
      for (const pane of [...this.panes.values()]) pane.hide();
    });
    while (this.settling.size > 0) await Promise.allSettled([...this.settling]);
  }
}

/** The panes of one screen on `options.link`: none yet, until `show` names the shown tab's. */
export function createPanes(options: PanesOptions): Panes {
  return new PaneSet(options);
}
