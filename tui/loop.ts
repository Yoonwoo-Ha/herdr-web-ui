/**
 * Where the screen's modules meet: the host terminal, the input decoder, the core link, the pane machine, the state
 * core and the painter. The loop holds no rule of its own; it moves what one module answers to the module that acts
 * on it, in this order within a turn:
 *   1. host input -> the framer -> the reducer -> its effects, performed at once (typed bytes leave here, before any frame);
 *   2. when the one timer fires: whatever is due in the framer, the link, the panes, the model, a hold, a refused paste;
 *   3. a frame pass, at most every FRAME_PASS_MS: each shown pane's picture copied, ONE write, then credit (at most
 *      PASS_CREDIT_BYTES, the focused pane first, none when the write was not taken), then panes whose first paint was
 *      drawn go live after stdin was drained;
 *   4. the one timer armed again for the earliest deadline of all, or none.
 * Time and the timer are the caller's (`LoopClock`), so a test runs it on an injected clock.
 */

import type { HcTransport, HelloInfo } from "../server/herdr-core/connection.ts";
import { editLayout } from "../server/herdr-core/layout-ops.ts";
import { SeenMarker } from "../server/herdr-core/seen-label.ts";
import { SeenWrites } from "./core/seen.ts";
import { alertsOf } from "./model/look.ts";
import type { ScreenRange } from "./emulator/index.ts";
import { DividerWrites } from "./core/divider.ts";
import { type LayoutDone, LayoutWrites } from "./core/layout.ts";
import { type CoreLink, LINK_DOCS, type LinkNotice, type LinkState, openLink } from "./core/link.ts";
import { createPanes, type PaneInput, type PaneNotice, type Panes, type PaneView } from "./core/pane.ts";
import type { Size } from "./core/size.ts";
import { CoreWorld } from "./core/world.ts";
import { errorCode } from "./crash.ts";
import { effectBytes, osc52 } from "./host/effects.ts";
import type { Host, HostEnd } from "./host/index.ts";
import type { InputEvent } from "./input/decode.ts";
import { Framer } from "./input/framer.ts";
import type { TuiThemeMode } from "./theme.generated.ts";
import { buildChrome, sessionFromSocket } from "./view/chrome.ts";
import { LINK_UNKNOWN, paneLive, shownLink, type ShownLink } from "./view/link-view.ts";
import { BEHIND_WRITE_BYTES, BEHIND_WRITE_EVENTS, type Deadlines, earliest, FRAME_PASS_MS, HOLD_RELEASE_MS, LAYOUT_SHOWN_WAIT_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, QUIT_BOUND_MS, STYLE_TABLE_LIMIT, CRASH_ACTIONS_KEPT } from "./model/deadlines.ts";
import type { Effect, MouseInput } from "./model/effects.ts";
import { menuChoice } from "./model/overlays.ts";
import { exists, focused } from "./model/focus.ts";
import { type Following, initialState, type ModelEvent, type ModelState, presentedMenu, reduce } from "./model/reduce.ts";
import { PaneGrid } from "./view/grid.ts";
import { CopyView } from "./view/copy.ts";
import { type DeferredMouse, type PaneLook, type PanePicture, Pointer, type PointerAct, type PointerScene, rowsAboveBottom } from "./view/mouse.ts";
import { type HitMap, Painter, type PaneScene } from "./view/paint.ts";
import { layOut, paneScene, type PaneSpot, type ScreenShape } from "./view/screen.ts";
import type { ViewStore } from "./view-store.ts";

/** The caller's clock and its one timer: `arm` sets the timer for `at` (on the same clock) and answers its cancel. */
export interface LoopClock {
  now(): number;
  arm(at: number, fire: () => void): () => void;
}

export interface LoopOptions {
  host: Host;
  clock: LoopClock;
  /** the core's socket, as the entry worked it out */
  socket: string;
  /** herdr's parsed `[keys]` table (anything else: the defaults) */
  keys: unknown;
  /** reads herdr's `[keys]` table again, for the reload action */
  readKeys?: () => unknown;
  /** one attempt at the socket: the real socket transport unless a test wraps it */
  connect?: (path: string) => Promise<HcTransport>;
  /** the hc session joined, shown in the header */
  session?: string;
  /** the folder the command was typed in, shown when the core has no workspaces */
  cwd?: string;
  /** where the view is kept per core between runs; none: nothing is kept */
  views?: ViewStore;
}

/**
 * How the screen ended: `quit` (the detach key: every channel closed, the terminal given back), `gone` (the host hung up
 * or a write failed), `signal` (the host gave the terminal back and ends the process), `no_core` and `incompatible`
 * (before the host was entered), `not_a_terminal`, `crashed` (an unexpected error: the caller restores the terminal
 * first, then writes the crash record).
 */
export type LoopEnd =
  /** `leaveError`: giving the terminal back failed with this code; it is still a quit */
  | { kind: "quit"; leaveError?: string }
  | { kind: "gone"; why: "hangup" | "write-failed" }
  | { kind: "signal" }
  | { kind: "no_core"; code: string }
  | { kind: "incompatible"; code: string; reason: string }
  | { kind: "not_a_terminal" }
  | { kind: "crashed"; error: unknown };

/** What a test and the crash record read of a running loop. */
export interface LoopReport {
  /** the names due when the one armed timer fires (none: no timer) */
  due: string[];
  passes: number;
  /** frame writes handed to the host (an unchanged frame writes nothing) */
  writes: number;
  /** the last action codes: what happened, never what was typed or shown */
  actions: string[];
  hc: { version: string; features: string[] } | null;
  size: { cols: number; rows: number };
  /** the pane grids the frame keeps, each at its size */
  grids: { pane: string; cols: number; rows: number }[];
  mode: { name: string; locked: boolean; armed: boolean; overlays: string[]; notice?: NonNullable<ReturnType<CopyView["searchNotice"]>> };
  /** the stable code of the error giving the terminal back at quit failed with, or null */
  leaveError: string | null;
  /** the core link's state as data: what the chrome shows (Offline and its code, NoCore, Incompatible) */
  link: { kind: LinkState["kind"]; code: string | null };
}

export interface Loop {
  readonly done: Promise<LoopEnd>;
  report(): LoopReport;
  /** the state core's state now (tests read focus and notices) */
  model(): ModelState;
  /** An event from outside the host's input (a click turned into a `select`, a menu's `action`), through the state core now. */
  dispatch(event: ModelEvent): void;
  readonly panes: Panes;
  readonly link: CoreLink;
  /** the painter's composed screen: what the host shows once the last write was taken */
  screen(): Painter["screen"] | null;
}

export function startLoop(options: LoopOptions): Loop {
  const { host, clock } = options;
  const framer = new Framer(true);
  const world = new CoreWorld();
  const actions: string[] = [];
  const act = (code: string) => {
    actions.push(code);
    if (actions.length > CRASH_ACTIONS_KEPT) actions.shift();
  };

  let state = initialState(options.keys);
  let painter: Painter | null = null;
  /** the host answered DECRQM 2026 at start */
  let sync = false;
  let theme: TuiThemeMode = "dark";
  let shown: ShownLink = LINK_UNKNOWN;
  const session = options.session ?? sessionFromSocket(options.socket);
  const cwd = options.cwd ?? "~";
  let grids = new Map<string, { emulator: unknown; grid: PaneGrid }>();
  let shape: ScreenShape | null = null;
  const pointer = new Pointer();
  const copyView = new CopyView();
  /** Published together only after a frame is taken: the cells and layout the mouse actually sees. */
  let hits: HitMap | null = null;
  let drawn = new Map<string, PanePicture>();
  let paintedLayout: Pick<PointerScene, "tab" | "splits"> = { tab: null, splits: [] };
  let paintedOverlay: ModelState["overlays"][number] | undefined;
  let overlayGeneration = 0;
  /** What the last frame the host took showed a person: the pane drawn focused, and whether an overlay lay over the panes. */
  let presented: { readonly pane: string | null; readonly overlay: boolean } = { pane: null, overlay: false };
  /** What a person has in front of them, as `sight` last worked it out: the pane (null: none), and whether anything covers the panes. */
  let sighted = presented;
  let shownKey = "";
  let paneFocus: string | null = null;
  let hello: HelloInfo | null = null;
  let helloEpoch = 0;
  /** One snapshot publication: the terminals and both layout documents, possibly ahead of this line's hello. */
  let snapshot: { epoch: number; complete: boolean; core: string | null } | null = null;
  let entered = false;
  let ended = false;
  let quitting: { at: number; settle: () => void } | null = null;
  /** every channel is being closed (quit, hang-up, a signal): nothing is drawn again, whatever arrives meanwhile */
  let closing = false;
  let leaveError: string | null = null;
  let passOwed = false;
  let lastPass = -Infinity;
  let passes = 0;
  let writes = 0;
  let draining = false;
  const holds = new Map<string, number>();
  let pasteAt: number | null = null;
  let timer: { at: number; cancel: () => void } | null = null;
  let firstState: ((state: LinkState) => void) | null = null;

  let resolveDone!: (end: LoopEnd) => void;
  const done = new Promise<LoopEnd>((resolve) => { resolveDone = resolve; });

  /** Ends the loop once: no timer, no frame, no write after this. */
  const end = (how: LoopEnd) => {
    if (ended) return;
    ended = true;
    timer?.cancel();
    timer = null;
    act(`end:${how.kind}`);
    resolveDone(how);
  };

  const fail = (error: unknown) => {
    if (ended) return;
    act("crash");
    end({ kind: "crashed", error });
    void panes.close().catch(() => {});
    void link.close().catch(() => {});
  };

  /** Runs one piece of a turn; an error nothing expected ends the screen as a crash. */
  const guard = (work: () => void) => {
    if (ended && !quitting) return;
    try {
      work();
    } catch (error) {
      fail(error);
    }
  };

  const link = openLink({
    socket: options.socket,
    now: () => clock.now(),
    model: { ...world.model, observeSeen: (address, turn, labels) => {
      marker.observe(address, turn, labels);
      seen.observe(address, turn);
    } },
    notify: (notice) => {
      guard(() => onLinkNotice(notice));
      arm();
    },
    ...(options.connect ? { connect: options.connect } : {}),
  });

  const marker = new SeenMarker(link);
  const seen = new SeenWrites(marker, (error) => act(`seen_failed:${errorCode(error)}`));

  const panes = createPanes({
    link,
    now: () => clock.now(),
    notify: (notice) => {
      guard(() => onPaneNotice(notice));
      arm();
    },
  });

  const dividers = new DividerWrites({
    edit: (change) => editLayout(link, change),
    tree: (tab) => world.view().tabs.get(tab)?.root,
    refused: (refusal) => {
      guard(() => {
        dispatch({ type: "notice", code: refusal.code, data: refusal.reason === null ? {} : { reason: refusal.reason }, at: clock.now() });
        reshow();
        owePass();
      });
      arm();
    },
  });

  const layout = new LayoutWrites({
    hc: link,
    model: world.model,
    folder: options.cwd,
    answer: (answer) => {
      guard(() => dispatch(answer.type === "notice"
        ? { type: "notice", code: answer.code, data: answer.data, ...(answer.calm ? { calm: true } : {}), at: clock.now() }
        : { type: "follow", target: answer.target, away: answer.away, at: clock.now() }));
      arm();
    },
  });

  function onLinkNotice(notice: LinkNotice): void {
    panes.notice(notice);
    if (notice.type === "state") {
      act(`link:${notice.state.kind}${"code" in notice.state ? `:${notice.state.code}` : ""}`);
      if (notice.state.kind !== "Connecting" && firstState) {
        const told = firstState;
        firstState = null;
        told(notice.state);
      }
      shown = shownLink(shown, notice.state);
      look();
      if (notice.state.kind === "Online") {
        const epoch = notice.state.epoch;
        void link.hello().then((info) => {
          if (link.state.kind === "Online" && link.state.epoch === epoch) {
            hello = info;
            helloEpoch = epoch;
            world.setVersion(info.version);
            guard(identifySnapshot);
            arm();
          }
        }, () => {});
      }
      owePass();
      return;
    }
    if (notice.type === "snapshot") {
      snapshot = { epoch: notice.epoch, complete: false, core: null };
      options.views?.suspend();
    }
    // the core's word comes when it comes, whatever was read since the last frame: the alerts and a turn's end below
    // ask who is in front of a person now
    if (notice.type === "event") sight();
    const before = world.view();
    const alerts = notice.type === "event" ? alertsOf(notice.event.type, notice.changes, (terminal) => before.panes.get(terminal)?.status, seen.current) : [];
    if (world.notice(notice)) worldChanged();
    const after = world.view();
    for (const alert of alerts) {
      const agent = after.agents.find((row) => row.paneId === alert.terminal)?.name ?? alert.terminal;
      dispatch({ type: "notice", code: alert.kind === "blocked" ? "agent_blocked" : "agent_done", data: { agent }, calm: true, at: clock.now() });
    }
    if (notice.type === "event" && notice.event.type === "turn" && notice.event.terminal !== undefined) seen.turn(notice.event.terminal);
    // a snapshot shows turns no event told (the line was down, or events were missed): the look hears of them here,
    // after the world took the snapshot in
    if (notice.type === "snapshot") {
      sight();
      seen.snapshot();
    }
    if (snapshot && !snapshot.complete && notice.type === "doc" && notice.epoch === snapshot.epoch && notice.name === LINK_DOCS.at(-1)) {
      snapshot.complete = true;
      identifySnapshot();
    }
    readCore();
  }

  function identifySnapshot(): void {
    if (!snapshot?.complete || snapshot.core !== null || snapshot.epoch !== helloEpoch || !hello) return;
    snapshot.core = hello.core.id;
    if (options.views) dispatch({ type: "restore", core: snapshot.core, ...options.views.open(snapshot.core), at: clock.now() });
  }

  function worldChanged(): void {
    dispatch({ type: "world", world: world.view().world, core: snapshot?.core ?? null, epoch: snapshot?.epoch ?? 0, at: clock.now() });
    reshow();
  }

  /** The read of the core the world asks for, its answer handed back to it. */
  function readCore(): void {
    const read = world.nextRead();
    if (!read) return;
    const answered = (terminals: readonly unknown[] | null) => {
      guard(() => {
        if (world.answer(read, terminals)) worldChanged();
        readCore();
      });
      arm();
    };
    link.call(read.method, read.params).then((result) => answered(result.terminals), () => answered(null));
  }

  function onPaneNotice(notice: PaneNotice): void {
    if (copyView.changed(notice, panes)) dispatch({ type: "copy_closed", pane: notice.terminal });
    if (notice.type === "hold") {
      if (notice.held) holds.set(notice.terminal, clock.now());
      else holds.delete(notice.terminal);
    }
    if (notice.type === "gone") grids.delete(notice.terminal);
    if (notice.type === "effect" && !closing) {
      const bytes = effectBytes(notice.effect, notice.terminal === paneFocus);
      if (bytes && !host.write(bytes)) painter?.invalidate();
    }
    look();
    owePass();
  }

  /**
   * What the user typed, pasted or clicked while a layout write that one of their actions started is under way: it
   * waits behind that write, in order, and goes through once the write is done, so it meets the layout the write
   * leaves (the pane a close focuses, the pane a split follows), as a later read would. null when no write holds it.
   * What waits is classified when read: pane input, and mouse reports bound to what they meet. A detach never waits,
   * and any other action, overlay or mode input is refused when it is read. `armed`: the prefix state of what was read,
   * kept apart so a refused chord takes no place in what waits. `awaiting`: the write is done
   * and the screen does not show what it did yet: the pane it made or moved (`follow`: what waits goes there once
   * focus follows it), or the panes a close ended still in the world (`gone`: what waits goes through once they left
   * and focus moved off them). It is refused if that is not so by `until`, never sent to the pane focused before.
   * `bytes`: the text among what waits (typed, pasted, or carried by a key); `full`: what waits reached
   * BEHIND_WRITE_EVENTS or BEHIND_WRITE_BYTES, and nothing more waits.
   */
  let behindWrite: {
    readonly events: HeldInput[];
    /** the prefix state of what was read during the hold, kept apart from what waits */
    armed: boolean;
    /** Only a prefix begun in terminal context may survive release; overlay prefixes recognize held detach only. */
    terminalArmed: boolean;
    readonly mouse: ReturnType<Pointer["defer"]>;
    /** Only the owning write's success can supply a recipient for input read without a pane. */
    inputTarget: string | null;
    awaiting: ({ readonly kind: "follow"; readonly following: Following } | { readonly kind: "gone"; readonly done: LayoutDone } | { readonly kind: "zoom"; readonly read: AbortController }) & { readonly until: number } | null;
    bytes: number;
    full: boolean;
    ready: boolean;
  } | null = null;
  /** what waited behind a write is going through: a layout action in it was refused when it was read */
  let replaying = false;
  let busyReported = false;
  type HeldInput = (Extract<Effect, { type: "held_pane" }> & { readonly unassigned: boolean })
    | { type: "held_mouse"; input: MouseInput; continuation: boolean; route: DeferredMouse };

  /**
   * A user's input event: through the state core now, or behind the layout write under way. A detach among what would
   * wait leaves at once: a user leaving never waits for a write (what waited, typed before it, goes nowhere). A layout
   * action among it is refused now: once the write is done it would meet another layout and act on another target.
   */
  function userInput(event: ModelEvent): void {
    // nothing after a detach goes anywhere, from the same read either: the screen is leaving
    if (closing) return;
    // the host's focus waits in order too: a focus loss returns an armed prefix to Idle, for the read-ahead and the replay alike
    if (behindWrite === null || !(event.type === "key" || event.type === "text" || event.type === "paste" || event.type === "mouse" || event.type === "focus")) {
      dispatch(event);
      return;
    }
    // What waits is classified now: pane input, or a mouse report bound to what it meets. Overlay and mode input,
    // refused chords and prefixes take no place in it; the prefix state is kept apart.
    const pieces: HeldInput[] = [];
    if (event.type === "mouse") {
      const scene = pointerScene();
      const continuation = behindWrite.mouse.continuation(event);
      if (!continuation) {
        const blocked = state.overlays.length > 0 || state.mode.name !== "terminal" || state.menuDismissed;
        // the last accepted frame's overlay owns its cells even once the model closed it
        const hit = hits?.at(event.col, event.row);
        if (blocked || (hit && "part" in hit && (hit.part.startsWith("overlay:") || hit.id === "menu"))) {
          busy(state.overlays.at(-1)?.kind ?? (blocked ? state.mode.name : "menu"));
          return;
        }
        const route = behindWrite.mouse.bind(event, scene);
        const owner = overlayGeneration;
        pieces.push({ type: "held_mouse", input: event, continuation: false,
          route: (over, now) => owner === overlayGeneration && paintedOverlay === state.overlays.at(-1)
            ? route(over, now) : pointer.cancel(now, event.at) });
      } else pieces.push({ type: "held_mouse", input: event, continuation: true, route: behindWrite.mouse.bind(event, scene) });
    }
    // read the event the way the loop would, then each rest of a read it hands back, in order. The hold parser knows
    // pane input, prefix chords and detach only: it never runs the overlay or mode ladder
    const units: ModelEvent[] = [event];
    for (let next = units.shift(); next !== undefined; next = units.shift()) {
      const before = { ...state, armed: behindWrite.armed };
      const step = reduce(before, next, true);
      behindWrite.armed = step.state.armed;
      if (!step.state.armed) behindWrite.terminalArmed = false;
      else if (step.prefixStarted) behindWrite.terminalArmed = before.overlays.length === 0 && before.mode.name === "terminal" && !before.menuDismissed;
      for (const notice of step.state.notices) {
        if (notice.id >= before.nextNotice) dispatch({ type: "notice", code: notice.code, data: notice.data, ...(notice.calm ? { calm: true } : {}), at: clock.now() });
      }
      for (const effect of step.effects) {
        if (effect.type === "quit") {
          drop("detach", false);
          perform({ type: "quit" });
          return;
        }
        if (effect.type === "input") units.push(effect.event);
        if (effect.type === "busy") busy(effect.action);
        if (effect.type === "held_pane") pieces.push({ ...effect, unassigned: focused(before.world, before.focus).pane === null });
      }
    }
    // the host's focus is no pane input: the screen takes it now, after the hold's prefix state took it in order
    if (event.type === "focus") dispatch(event);
    if (behindWrite.full) return;
    // the text a key typed (a kitty key reports it) costs its bytes too, as the same text read as text does
    const bytes = pieces.reduce((sum, piece) => sum + (piece.type === "held_pane" ? Buffer.byteLength(piece.input.text ?? "") : 0), 0);
    if (behindWrite.events.length + pieces.length > BEHIND_WRITE_EVENTS || behindWrite.bytes + bytes > BEHIND_WRITE_BYTES) {
      // nothing more waits, so what goes through later keeps its order and no paste is cut; a detach still leaves above
      behindWrite.full = true;
      dispatch({ type: "notice", code: "input_dropped", data: { reason: "full" }, at: clock.now() });
      return;
    }
    behindWrite.events.push(...pieces);
    behindWrite.bytes += bytes;
  }

  /** A layout action chosen while a write, or what waits behind it, is under way: one notice, nothing written. */
  function busy(action: string): void {
    if (busyReported) return;
    busyReported = true;
    dispatch({ type: "notice", code: "layout_busy", data: { action }, at: clock.now() });
  }

  /**
   * Holds the user's input until `writing` is done; then what waited goes through in order, or, when the write asked
   * focus to follow a pane the screen does not show yet or ended panes the screen still shows, once the screen shows
   * what it did.
   */
  function holdUntil(writing: Promise<LayoutDone>, zoom?: { tab: string; pane: string; from: string | null }): void {
    if (behindWrite === null) {
      behindWrite = { events: [], armed: state.armed, terminalArmed: state.armed, mouse: pointer.defer(), inputTarget: null, awaiting: null, bytes: 0, full: false, ready: false };
      busyReported = false;
    }
    const held = behindWrite;
    const before = state.following;
    const line = link.state;
    void writing.then((done) => {
      guard(() => {
        if (behindWrite !== held) return;
        held.inputTarget = done.inputTarget ?? null;
        const until = clock.now() + LAYOUT_SHOWN_WAIT_MS;
        if (!closedShown(done.ended)) behindWrite.awaiting = { kind: "gone", done, until };
        else if (done.dropInput) drop(done.dropInput);
        else if (done.refreshZoom) {
          // An unzoom restores remembered focus. A doc.set reply alone cannot tell the model which pane to route to.
          const wait = { kind: "zoom", read: new AbortController(), until } as const;
          behindWrite.awaiting = wait;
          const confirmed = (ok: boolean) => {
            guard(() => {
              if (behindWrite?.awaiting !== wait) return;
              if (ok && line === link.state && clock.now() < until) {
                // The move was issued on a wide screen: the document showing its pane confirms it, whatever the width is now.
                const { tab, pane } = focused(state.world, state.focus);
                if (zoom && tab?.id === zoom.tab && tab.zoomed === zoom.pane && pane?.id === zoom.pane) {
                  dispatch({ type: "zoom_followed", pane: pane.id, from: zoom.from, at: clock.now() });
                }
                release();
              } else drop("not_shown");
            });
            arm();
          };
          if (line !== link.state) confirmed(false);
          else void link.refreshLayout(wait.read.signal).then(confirmed, () => confirmed(false));
        } else if (state.following !== null && state.following !== before) behindWrite.awaiting = { kind: "follow", following: state.following, until };
        else release();
      });
      arm();
    });
  }

  /** Whether the screen shows these ended panes gone: none of them is in the world any more. */
  function closedShown(panes: readonly string[]): boolean {
    return panes.every((id) => !exists(state.world, { kind: "pane", id }));
  }

  /** A settled write remains a hold until a frame built after it settled is accepted. */
  function release(): void {
    if (behindWrite === null) return;
    behindWrite.awaiting = null;
    behindWrite.ready = true;
    owePass();
  }

  /** What waited goes through as it was classified when read; overlay and mode input never reaches replay. */
  function replay(): void {
    const waited = behindWrite?.events ?? [];
    const full = behindWrite?.full === true;
    const armed = behindWrite?.armed === true && behindWrite.terminalArmed;
    const inputTarget = behindWrite?.inputTarget ?? null;
    behindWrite = null;
    replaying = true;
    try {
      let unassigned = 0;
      for (const event of waited) {
        if (event.type === "held_pane") {
          if (event.unassigned) {
            if (inputTarget === null || !exists(state.world, { kind: "pane", id: inputTarget })) {
              unassigned++;
              continue;
            }
            perform({ type: "pane", pane: inputTarget, input: event.input });
          } else perform(event);
        } else if (event.continuation) routeMouse(event.input, "screen", event.route);
        else dispatch(event.input, event.route);
      }
      if (unassigned > 0) dispatch({ type: "notice", code: "input_dropped", data: { reason: "not_shown", events: unassigned }, at: clock.now() });
      // what came after the queue filled went nowhere, possibly the key a prefix waited for: the prefix returns to Idle
      dispatch({ type: "armed", armed: armed && !full, at: clock.now() });
    } finally {
      replaying = false;
    }
  }

  /** What waited behind a write goes nowhere, with one notice saying so when anything did. */
  function drop(reason: string, notify = true): void {
    const count = behindWrite?.events.length ?? 0;
    if (behindWrite?.awaiting?.kind === "zoom") behindWrite.awaiting.read.abort();
    behindWrite = null;
    if (notify && count > 0) dispatch({ type: "notice", code: "input_dropped", data: { reason, events: count }, at: clock.now() });
  }

  /** Once focus no longer waits for the pane a write made or moved: what waited goes there if focus landed on it, else nowhere. */
  function followed(following: Following): void {
    if (focused(state.world, state.focus).pane?.id === following.target.id) release();
    else drop("not_shown");
  }

  /** What waits for the screen to show what a write did goes on once it does. */
  function onceShown(): void {
    const awaiting = behindWrite?.awaiting;
    if (!awaiting) return;
    if (awaiting.kind === "follow") {
      if (state.following !== awaiting.following) followed(awaiting.following);
    } else if (awaiting.kind === "gone" && closedShown(awaiting.done.ended)) {
      if (awaiting.done.dropInput) drop(awaiting.done.dropInput);
      else release();
    }
  }

  /**
   * Works out again what a person has in front of them: the pane the last frame the host took showed focused, while the
   * model still has it focused, and whether an overlay lies over the panes in that frame or in the model. A focus move
   * or a closed overlay shows nothing until a frame does. Called only where the answer cannot depend on how a read was
   * cut (a frame taken, the host's own focus, the core's events), never as a key is read: one read of two moves and two
   * reads of one each leave the same turns read.
   */
  function sight(): void {
    const pane = focused(state.world, state.focus).pane?.id ?? null;
    sighted = { pane: pane === presented.pane ? pane : null, overlay: presented.overlay || state.overlays.length > 0 };
    look();
  }

  /** What a person has in front of them, told to the read state: a person looking at a pane marks its turn read. */
  function look(): void {
    const { pane, overlay } = sighted;
    seen.update({
      hostFocused: state.host.focused,
      pane,
      live: pane !== null && panes.view(pane)?.state.kind === "Live",
      drawn: pane !== null && drawn.has(pane),
      overlay,
      online: link.state.kind === "Online",
    });
  }

  /** One event through the state core, and its effects performed in order, now. */
  function dispatch(event: ModelEvent, route?: DeferredMouse): void {
    const before = state;
    const step = reduce(state, event);
    state = step.state;
    for (const effect of step.effects) perform(effect, route);
    if (state !== before) {
      keepView();
      reshow();
      if (state.host.focused !== before.host.focused) sight();
      owePass();
    }
    onceShown();
  }

  /** The view written to this core's file when it changed; a failed write said once. */
  function keepView(): void {
    const unsaved = options.views?.keep(state) ?? null;
    if (unsaved !== null) dispatch({ type: "notice", code: "view_unsaved", data: { reason: unsaved }, at: clock.now() });
  }

  function perform(effect: Effect, route?: DeferredMouse): void {
    switch (effect.type) {
      case "held_pane": {
        // Classification needs no current destination; the completed write supplies it at replay.
        const pane = focused(state.world, state.focus).pane;
        if (pane !== null) perform({ type: "pane", pane: pane.id, input: effect.input });
        return;
      }
      case "copy": {
        // a copy command reads the pane as it is now, not as the last frame drew it: what one read holds (a scroll, hint
        // mode, a label) acts as it does read apart, with a frame between each
        const spot = effect.command.kind === "leave" ? undefined : shape?.spots.find((spot) => spot.pane === effect.pane && !spot.covered);
        const answer = copyView.run(effect, panes.view(effect.pane), painter && spot ? sceneNow(painter.styles, spot).scene : undefined);
        // copy mode takes the mouse from here and swallows what it reads of it, a release too: a gesture under way ends now,
        // where its press went (a program that got the press gets its release, a divider its last ratio)
        if (effect.command.kind === "enter" && !answer.close) for (const step of pointer.cancel(pointerScene(), clock.now())) performPointer(step);
        if (answer.text !== undefined) writeCopy(answer.text);
        if (answer.close) dispatch({ type: "copy_closed", pane: effect.pane });
        if (answer.unavailable) dispatch({ type: "notice", code: "copy_unavailable", at: clock.now() });
        owePass();
        return;
      }
      case "pane":
        for (const step of pointer.typed(effect.pane, lookOf(effect.pane))) performPointer(step);
        toPane(effect.pane, effect.input);
        return;
      case "run": {
        act(`run:${effect.action}`);
        if ((behindWrite !== null || replaying) && layout.writes(effect)) {
          busy(effect.action);
          return;
        }
        const writing = layout.run(effect);
        if (writing !== null) {
          // the pane the move left is the reducer's, taken before focus changed tabs: the state here already shows the new tab
          holdUntil(writing, effect.zoomTab && effect.target?.kind === "pane"
            ? { tab: effect.zoomTab, pane: effect.target.id, from: effect.zoomFrom ?? null } : undefined);
          return;
        }
        // An action without a performer is reported, never silently swallowed.
        dispatch({ type: "notice", code: "not_built", data: { action: effect.action }, at: clock.now() });
        return;
      }
      case "input":
        // the rest of a text run, behind the action before it: it meets the focus and mode that action left
        userInput(effect.event);
        return;
      case "unread":
        act("unread");
        seen.unread(effect.pane);
        return;
      case "quit":
        act("quit");
        quit();
        return;
      case "reload_keys":
        act("reload_keys");
        dispatch({ type: "keys", keys: options.readKeys ? options.readKeys() : options.keys, at: clock.now() });
        return;
      case "busy":
        busy(effect.action);
        return;
      case "mouse":
        act(`mouse:${effect.over}`);
        routeMouse(effect.event, effect.over, route);
        return;
      case "host_reply":
        return;
    }
  }

  function routeMouse(event: MouseInput, over: "overlay" | "screen", route?: DeferredMouse): void {
    const scene = pointerScene();
    const acts = route ? route(over, scene) : pointer.mouse(over, event, scene);
    for (const step of acts) performPointer(step);
  }

  /** Input for a pane: each goes to the pane it names, in order (a prefix in a text run can move focus between two). */
  function toPane(pane: string, input: PaneInput): void {
    if (paneFocus !== pane) {
      paneFocus = pane;
      panes.focus(pane);
    }
    const sent = panes.input(input);
    act(`input:${input.type}:${sent.sent ? "sent" : sent.code}`);
    if (!sent.sent && sent.notice) dispatch({ type: "notice", code: "input_refused", data: { reason: sent.code }, at: clock.now() });
  }

  function performPointer(step: PointerAct): void {
    switch (step.kind) {
      case "select":
        dispatch({ type: "select", target: step.target, at: clock.now() });
        return;
      case "action":
        dispatch({ type: "action", action: step.action, at: clock.now() });
        return;
      case "forward":
        toPane(step.pane, step.event);
        return;
      case "scroll":
        // the emulator marks every row of its screen changed when the screen moves: the next pass draws them all
        panes.view(step.pane)?.emulator?.scrollFromBottom(step.fromBottom);
        owePass();
        return;
      case "copy":
        copy(step.pane, step.range, step.contentVersion);
        return;
      case "divider":
        act(`divider:${step.done ? "done" : "move"}`);
        dividers.move(step.grab, step.tab, step.name, step.ratio, step.done);
        reshow();
        owePass();
        return;
      case "redraw":
        owePass();
        return;
      case "close_overlay":
        dispatch({ type: "close_overlay", at: clock.now() });
        return;
      case "choose":
        // The menu validates its presented identity across updates. Picker and agent rows belong to the painted overlay.
        if (state.overlays.at(-1)?.kind !== "menu" && paintedOverlay !== state.overlays.at(-1)) return;
        dispatch({ type: "choose", entry: step.entry, at: clock.now() });
        return;
    }
  }

  /** The selected text to the host's clipboard as OSC 52, with a notice: `copied`, or `copy_refused` over the size cap. */
  function copy(pane: string, range: ScreenRange, contentVersion: number): void {
    const text = panes.view(pane)?.emulator?.textOf(range, contentVersion);
    if (text?.ok) writeCopy(text.value);
  }

  function writeCopy(text: string): void {
    const data = new TextEncoder().encode(text);
    const write = osc52(data);
    if (!write.ok) {
      if (write.code !== "empty") dispatch({ type: "notice", code: "copy_refused", data: { reason: write.code, bytes: data.length }, at: clock.now() });
      return;
    }
    act("copy");
    // a write the host does not take means the terminal is gone: the screen ends, and no notice could be seen
    if (!host.write(write.bytes)) {
      painter?.invalidate();
      return;
    }
    dispatch({ type: "notice", code: "copied", data: { bytes: data.length }, calm: true, at: clock.now() });
  }

  /** Live modes and identity for routing and validation, located in the last accepted frame. */
  function lookOf(pane: string): PaneLook | null {
    const view = panes.view(pane);
    const picture = drawn.get(pane);
    const emulator = view?.emulator;
    if (!emulator || !view.actual || !picture) return null;
    const modes = emulator.modes();
    const history = emulator.history();
    if (!modes.ok || !history.ok) return null;
    return { ...picture, grid: view.actual, programMouse: modes.value.mouse !== "none", altScreen: modes.value.altScreen, screen: modes.value.screens, emulator, history: history.value };
  }

  function pointerScene(): PointerScene {
    return { hits, focus: paneFocus, ...paintedLayout, look: lookOf, painted: (pane) => drawn.get(pane) ?? null,
      acceptsMenu: (entry) => {
        const menu = state.overlays.at(-1);
        return menu?.kind === "menu" ? menuChoice(menu, entry).accepted : menu === paintedOverlay;
      } };
  }

  /** The shown tab's panes with their cells, told to the pane machine when anything about them changed. */
  function reshow(): void {
    const size = host.size();
    const view = world.view();
    const { tab, pane } = focused(state.world, state.focus);
    // the focus moves before the layout: a pane that a zoom is about to cover still tells its program the focus left (a
    // covered pane is silent), and one the zoom uncovers hears it come once it shows
    if ((pane?.id ?? null) !== paneFocus) {
      paneFocus = pane?.id ?? null;
      pointer.focusChanged(paneFocus);
      panes.focus(paneFocus);
    }
    shape = layOut(size.cols, size.rows, tab ? dividers.shape(tab.id, view.tabs.get(tab.id)) ?? null : null, { sidebarCollapsed: state.sidebarCollapsed, pane: pane?.id ?? null });
    // a pane that left the shown tab keeps no grid: shown again, it is drawn anew from its new attach
    for (const pane of grids.keys()) if (!shape.spots.some((spot) => spot.pane === pane)) grids.delete(pane);
    const shown = shape.spots.map(({ pane, cells, covered }) => ({ terminal: pane, cols: cells.cols, rows: cells.rows, covered }));
    const key = JSON.stringify(shown);
    if (painter && key !== shownKey) {
      shownKey = key;
      panes.show(shown);
    }
  }

  function owePass(): void {
    passOwed = true;
  }

  /** Bytes read from the host: events, each through the state core at once. */
  function read(bytes: Uint8Array): void {
    const events: InputEvent[] = framer.feed(bytes, clock.now());
    // only a refused paste whose end mark has not come yet is waited for: a paste begun after its end is framed as any paste
    pasteAt = framer.discarding() ? clock.now() + PASTE_ABANDON_MS : null;
    for (const event of events) {
      // the rest of a read that detached goes nowhere, as a later read would not
      if (closing) break;
      act(`read:${event.type}`);
      seen.input(event);
      if (event.type === "reply") {
        if (event.kind === "scheme") host.refreshDisplay();
        else panes.displayReply(event);
      }
      if (event.type === "focus") {
        panes.hostFocus(event.focused);
        // the host lost its screen meanwhile, or redrew it: the next frame writes every cell
        if (event.focused) painter?.invalidate();
      }
      userInput(event);
    }
  }

  /** Everything due by the clock, then a frame pass when one is owed and FRAME_PASS_MS passed since the last. */
  function turn(): void {
    const now = clock.now();
    if (closing) {
      if (quitting && now >= quitting.at) quitting.settle();
      return;
    }
    // what a write did never showed in time: what waited for it is refused, not sent elsewhere
    if (behindWrite?.awaiting && now >= behindWrite.awaiting.until) drop(behindWrite.awaiting.kind === "gone" ? behindWrite.awaiting.done.dropInput ?? "not_closed" : "not_shown");
    for (const event of framer.tick(now)) userInput(event);
    if (pasteAt !== null && now >= pasteAt) {
      pasteAt = null;
      framer.reset();
      act("paste_reset");
    }
    link.fire();
    panes.fire();
    for (const [name, at] of state.deadlines) if (at <= now) dispatch({ type: "deadline", name, at: now });
    for (const [terminal, since] of holds) {
      if (since + HOLD_RELEASE_MS > now) continue;
      holds.delete(terminal);
      panes.view(terminal)?.emulator?.releaseHold();
      owePass();
    }
    if (passOwed && painter && now >= lastPass + FRAME_PASS_MS) pass(now);
  }

  /**
   * A shown pane as its emulator holds it now: its grid brought up to date (step 1 of a frame pass; the rows it copies stay
   * owed to the painter) and the scene that draws it. `filled`: the emulator gave its picture. Nothing here is published as
   * drawn: only a frame the host took is.
   */
  function sceneNow(styles: Painter["styles"], spot: PaneSpot, view: PaneView | undefined = panes.view(spot.pane)): { scene: PaneScene; actual: Size; filled: boolean } {
    // the grid of the picture drawn, never a size a newer attach was told before its first paint: with none, the visible cells
    const actual = view?.grid ?? { cols: spot.cells.cols, rows: spot.cells.rows };
    let held = grids.get(spot.pane);
    const emulator = view?.emulator ?? null;
    if (!held || held.emulator !== emulator) {
      held = { emulator, grid: new PaneGrid(styles, actual.cols, actual.rows) };
      grids.set(spot.pane, held);
    }
    held.grid.resize(actual.cols, actual.rows);
    const filled = emulator !== null && held.grid.copy(emulator, held.grid.allDirty).ok;
    const live = paneLive(view, shown);
    return { scene: paneScene(spot, held.grid, actual, { live, hold: holds.has(spot.pane), dim: !live }), actual, filled };
  }

  function pass(now: number): void {
    if (!painter || !shape || ended) return;
    const releaseHeld = behindWrite?.ready === true ? behindWrite : null;
    const frameShape = shape;
    const tab = focused(state.world, state.focus).tab;
    const tree = tab ? dividers.shape(tab.id, world.view().tabs.get(tab.id)) : undefined;
    const nextLayout = { tab: tab && tree ? { id: tab.id, root: tree.root } : null, splits: frameShape.splits };
    passOwed = false;
    lastPass = now;
    passes++;
    // the style table only grows: past its limit the painter and every grid are made anew
    if (painter.styles.get(STYLE_TABLE_LIMIT) !== undefined) rebuildPainter();
    const scenes: PaneScene[] = [];
    let copying: ReturnType<CopyView["draw"]> = null;
    const copied = new Set<string>();
    const nextDrawn = new Map<string, PanePicture>();
    for (const spot of frameShape.spots) {
      if (spot.covered) continue;
      const view = panes.view(spot.pane);
      const { scene, actual, filled } = sceneNow(painter.styles, spot, view);
      if (filled) copied.add(spot.pane);
      const copy = copyView.draw(scene);
      if (copy) copying = copy;
      // copy mode clips the pane round its own cursor: the picture published is the one drawn
      const painted = copy?.pane ?? scene;
      const emulator = view?.emulator ?? null;
      const snapshot = filled && emulator ? emulator.frameScreen() : null;
      const look: PanePicture | null = snapshot?.ok && snapshot.value && emulator ? {
        rect: painted.rect, top: painted.view?.row ?? 0, left: painted.view?.col ?? 0, grid: actual, emulator,
        altScreen: snapshot.value.altScreen, screen: snapshot.value.screens, history: snapshot.value.history, contentVersion: snapshot.value.contentVersion,
      } : null;
      if (look) nextDrawn.set(spot.pane, look);
      const selection = pointer.shown(spot.pane, paneFocus, look);
      scenes.push({ ...painted, scrolledBack: look !== null && rowsAboveBottom(look) > 0, ...(!copy && selection ? { selection } : {}) });
    }
    const size = host.size();
    const paneViews = new Map(panes.views().map((v) => [v.terminal, v]));
    const frameMenu = state.overlays.at(-1);
    const frameMenuDismissed = state.menuDismissed;
    // taken before the write, as the menu is: input read during it may move the focus the frame does not show
    const frameFocus = paneFocus;
    const chrome = buildChrome({
      regions: frameShape.regions,
      spots: frameShape.spots,
      splits: frameShape.splits,
      state,
      world: world.view(),
      panes: paneViews,
      link: shown,
      session,
      cwd,
      theme,
      colors: host.colorDepth,
      copying,
    });
    const frame = painter.paint({
      width: size.cols, height: size.rows, parts: chrome.parts,
      panes: scenes, overlays: chrome.overlays, focus: paneFocus, input: chrome.input,
    });
    let taken = true;
    if (frame.bytes.length > 0) {
      writes++;
      taken = host.write(frame.bytes);
    }
    painter.taken(taken);
    if (ended || !taken) return;
    hits = frame.hits;
    drawn = nextDrawn;
    presented = { pane: frameFocus, overlay: frameMenu !== undefined };
    sight();
    paintedLayout = nextLayout;
    if (paintedOverlay !== frameMenu) {
      paintedOverlay = frameMenu;
      overlayGeneration++;
    }
    // A menu acknowledgement changes only presentation metadata. Keep that same painted owner,
    // but never bless an overlay changed by input or a world update during the host write.
    const sameOverlay = state.overlays.at(-1) === paintedOverlay;
    state = presentedMenu(state, frameMenu, frameMenuDismissed);
    if (sameOverlay) paintedOverlay = state.overlays.at(-1);
    // credit after the write was taken: the focused pane first, then the others (the pane machine credits a covered pane nothing)
    let budget = PASS_CREDIT_BYTES;
    const order = [...frameShape.spots].sort((a, b) => Number(b.pane === paneFocus) - Number(a.pane === paneFocus));
    for (const spot of order) {
      if (budget <= 0) break;
      budget -= panes.credit(spot.pane, budget);
    }
    // bytes a covered pane owes stay owed by design (it takes no credit until the zoom ends): they owe no pass
    if (order.some((spot) => { const view = panes.view(spot.pane); return view !== undefined && !view.covered && view.owed > 0; })) owePass();
    const ready = [...copied].filter((pane) => panes.view(pane)?.ready);
    if (ready.length > 0 && !draining) drainThenLive(ready);
    if (releaseHeld !== null && behindWrite === releaseHeld) replay();
  }

  /**
   * What was typed before a pane's first paint was drawn is read (and refused there), then the pane is Live. It is read as any
   * input, at once and through the focus it meets: a pane already Live takes it without waiting for this one.
   */
  function drainThenLive(ready: string[]): void {
    draining = true;
    host.drain().then(() => guard(() => {
      draining = false;
      for (const pane of ready) if (panes.view(pane)?.ready) panes.live(pane);
      owePass();
      arm();
    }), fail);
  }

  function rebuildPainter(): void {
    if (!painter) return;
    painter = new Painter({ sync, colors: host.colorDepth });
    grids = new Map();
    act("painter_rebuilt");
  }

  /** Every deadline of every module, each under its own prefix, so two `failure` names stay apart. */
  function deadlines(): Deadlines {
    const all = new Map<string, number>();
    if (closing) return quitting ? all.set("quit", quitting.at) : all;
    const input = framer.deadline();
    if (input !== undefined) all.set("input", input);
    if (pasteAt !== null) all.set("paste", pasteAt);
    if (behindWrite?.awaiting) all.set("layout_shown", behindWrite.awaiting.until);
    for (const [name, at] of link.deadlines()) all.set(`link:${name}`, at);
    for (const [name, at] of panes.deadlines()) all.set(`panes:${name}`, at);
    for (const [name, at] of state.deadlines) all.set(`model:${name}`, at);
    for (const since of holds.values()) all.set("hold", Math.min(all.get("hold") ?? Infinity, since + HOLD_RELEASE_MS));
    if (passOwed && painter) all.set("pass", Math.max(lastPass + FRAME_PASS_MS, clock.now()));
    return all;
  }

  /** The one timer, for the earliest deadline; none when there is none. */
  function arm(): void {
    if (ended && !quitting) return;
    const first = earliest(deadlines());
    if (timer && first && timer.at === first.at) return;
    timer?.cancel();
    timer = null;
    if (!first) return;
    const at = first.at;
    timer = { at, cancel: clock.arm(at, () => {
      timer = null;
      guard(turn);
      arm();
    }) };
  }

  /** Closes every pane channel and the event stream, and settles when they are answered or QUIT_BOUND_MS passed. */
  function closeAll(): Promise<void> {
    act("close_all");
    closing = true;
    const closes = Promise.allSettled([panes.close(), link.close()]);
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        quitting = null;
        timer?.cancel();
        timer = null;
        resolve();
      };
      quitting = { at: clock.now() + QUIT_BOUND_MS, settle };
      timer?.cancel();
      timer = null;
      arm();
      void closes.then(settle);
    });
  }

  function quit(): void {
    if (ended) return;
    void closeAll().then(() => {
      // the terminal is restored before the host throws a held write error: the quit stands, with the error's code
      try {
        host.leave();
      } catch (error) {
        leaveError = errorCode(error);
        act(`leave_failed:${leaveError}`);
      }
      end(leaveError === null ? { kind: "quit" } : { kind: "quit", leaveError });
    });
  }

  function onHostEnd(how: HostEnd): Promise<void> | void {
    if (ended) return;
    act(`host:${how.kind}`);
    // closeAll puts the loop in its closing state: no frame is drawn from here on
    return closeAll().then(() => {
      end(how.kind === "gone" ? { kind: "gone", why: how.why } : { kind: "signal" });
    });
  }

  async function start(): Promise<void> {
    const first = await new Promise<LinkState>((resolve) => {
      if (link.state.kind !== "Connecting") resolve(link.state);
      else firstState = resolve;
    });
    if (ended) return;
    if (first.kind === "NoCore" || first.kind === "Incompatible") {
      void link.close().catch(() => {});
      end(first.kind === "NoCore" ? { kind: "no_core", code: first.code } : { kind: "incompatible", code: first.code, reason: first.reason });
      return;
    }
    // heard before the entry: the entry's own write can find the terminal gone, and a signal held during it is told at its end
    host.onEnd((how) => onHostEnd(how));
    if (!host.enter()) {
      void link.close().catch(() => {});
      end({ kind: "not_a_terminal" });
      return;
    }
    entered = true;
    if (closing) return;
    framer.setModes({ mouse: true });
    host.onInput((bytes) => {
      guard(() => read(bytes));
      arm();
    });
    host.onResize((size) => {
      guard(() => {
        act("resize");
        rebuildPainter();
        dispatch({ type: "resize", cols: size.cols, rows: size.rows, at: clock.now() });
        reshow();
        owePass();
      });
      arm();
    });
    const size = host.size();
    guard(() => {
      dispatch({ type: "resize", cols: size.cols, rows: size.rows, at: clock.now() });
      reshow();
    });
    const probe = await host.probe();
    if (ended || closing) return;
    guard(() => {
      framer.setModes({ kitty: (probe.kittyFlags ?? 0) > 0 });
      sync = probe.syncOutput === true;
      if (probe.theme === "light" || probe.theme === "dark") theme = probe.theme;
      panes.displayProbe(probe);
      host.watchDisplay();
      painter = new Painter({ sync, colors: host.colorDepth });
      reshow();
      owePass();
    });
    arm();
  }

  void start().catch(fail);

  return {
    done,
    panes,
    link,
    model: () => state,
    dispatch: (event) => {
      guard(() => dispatch(event));
      arm();
    },
    screen: () => painter?.screen ?? null,
    report: () => {
      const first = earliest(deadlines());
      const due = first ? [...deadlines()].filter(([, at]) => at === first.at).map(([name]) => name) : [];
      const notice = copyView.searchNotice();
      return {
        due: timer ? due : [],
        passes,
        writes,
        actions: [...actions],
        leaveError,
        hc: hello ? { version: hello.version, features: [...hello.features] } : null,
        size: entered ? host.size() : { cols: 0, rows: 0 },
        grids: [...grids].map(([pane, { grid }]) => ({ pane, cols: grid.grid.cols, rows: grid.grid.rows })),
        mode: { name: state.mode.name, locked: state.locked, armed: state.armed, overlays: state.overlays.map((overlay) => overlay.kind), ...(notice === null ? {} : { notice }) },
        link: { kind: link.state.kind, code: "code" in link.state ? link.state.code : null },
      };
    },
  };
}
