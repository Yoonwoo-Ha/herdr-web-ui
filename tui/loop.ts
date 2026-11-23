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
import type { ScreenRange } from "./emulator/index.ts";
import { DividerWrites } from "./core/divider.ts";
import { type CoreLink, type LinkNotice, type LinkState, openLink } from "./core/link.ts";
import { createPanes, type PaneInput, type PaneNotice, type Panes } from "./core/pane.ts";
import { CoreWorld, focusDirection, paneToward } from "./core/world.ts";
import { errorCode } from "./crash.ts";
import { effectBytes, osc52 } from "./host/effects.ts";
import type { Host, HostEnd } from "./host/index.ts";
import type { InputEvent } from "./input/decode.ts";
import { Framer } from "./input/framer.ts";
import type { TuiThemeMode } from "./theme.generated.ts";
import { buildChrome, sessionFromSocket } from "./view/chrome.ts";
import { LINK_UNKNOWN, paneLive, shownLink, type ShownLink } from "./view/link-view.ts";
import { type Deadlines, earliest, FRAME_PASS_MS, HOLD_RELEASE_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, QUIT_BOUND_MS, STYLE_TABLE_LIMIT, CRASH_ACTIONS_KEPT } from "./model/deadlines.ts";
import type { Effect } from "./model/effects.ts";
import { focused } from "./model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./model/reduce.ts";
import { PaneGrid } from "./view/grid.ts";
import { type PaneLook, type PanePicture, Pointer, type PointerAct, type PointerScene, rowsAboveBottom } from "./view/mouse.ts";
import { type HitMap, Painter, type PaneScene } from "./view/paint.ts";
import { layOut, paneScene, type ScreenShape } from "./view/screen.ts";

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
  mode: { name: string; locked: boolean; armed: boolean; overlays: string[] };
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
  /** Published together only after a frame is taken: the cells and layout the mouse actually sees. */
  let hits: HitMap | null = null;
  let drawn = new Map<string, PanePicture>();
  let paintedLayout: Pick<PointerScene, "tab" | "splits"> = { tab: null, splits: [] };
  let shownKey = "";
  let paneFocus: string | null = null;
  let hello: HelloInfo | null = null;
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
    model: world.model,
    notify: (notice) => {
      guard(() => onLinkNotice(notice));
      arm();
    },
    ...(options.connect ? { connect: options.connect } : {}),
  });

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
      if (notice.state.kind === "Online") {
        const epoch = notice.state.epoch;
        void link.hello().then((info) => {
          if (link.state.kind === "Online" && link.state.epoch === epoch) {
            hello = info;
            world.setVersion(info.version);
          }
        }, () => {});
      }
      owePass();
      return;
    }
    if (world.notice(notice)) worldChanged();
    readCore();
  }

  function worldChanged(): void {
    dispatch({ type: "world", world: world.view().world, at: clock.now() });
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
    if (notice.type === "hold") {
      if (notice.held) holds.set(notice.terminal, clock.now());
      else holds.delete(notice.terminal);
    }
    if (notice.type === "gone") grids.delete(notice.terminal);
    if (notice.type === "effect" && !closing) {
      const bytes = effectBytes(notice.effect, notice.terminal === paneFocus);
      if (bytes && !host.write(bytes)) painter?.invalidate();
    }
    owePass();
  }

  /** One event through the state core, and its effects performed in order, now. */
  function dispatch(event: ModelEvent): void {
    const before = state;
    const step = reduce(state, event);
    state = step.state;
    for (const effect of step.effects) perform(effect);
    if (state !== before) {
      reshow();
      owePass();
    }
  }

  function perform(effect: Effect): void {
    switch (effect.type) {
      case "pane":
        for (const step of pointer.typed(effect.pane, lookOf(effect.pane))) performPointer(step);
        toPane(effect.pane, effect.input);
        return;
      case "run": {
        act(`run:${effect.action}`);
        const direction = focusDirection(effect.action);
        if (direction && effect.target?.kind === "pane") {
          const tab = focused(state.world, state.focus).tab;
          const shapeOf = tab ? world.view().tabs.get(tab.id) : undefined;
          const toward = shapeOf ? paneToward(shapeOf, effect.target.id, direction) : null;
          if (toward !== null) dispatch({ type: "select", target: { kind: "pane", id: toward }, at: clock.now() });
          return;
        }
        // layout writes and the agent list come with later rows of the plan: one notice per press, never silence
        dispatch({ type: "notice", code: "not_built", data: { action: effect.action }, at: clock.now() });
        return;
      }
      case "input":
        // the rest of a text run, behind the action before it: it meets the focus and mode that action left
        dispatch(effect.event);
        return;
      case "quit":
        act("quit");
        quit();
        return;
      case "reload_keys":
        act("reload_keys");
        dispatch({ type: "keys", keys: options.readKeys ? options.readKeys() : options.keys, at: clock.now() });
        return;
      case "mouse":
        act(`mouse:${effect.over}`);
        for (const step of pointer.mouse(effect.over, effect.event, pointerScene())) performPointer(step);
        return;
      case "host_reply":
        return;
    }
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
    }
  }

  /** The selected text to the host's clipboard as OSC 52, with a notice: `copied`, or `copy_refused` over the size cap. */
  function copy(pane: string, range: ScreenRange, contentVersion: number): void {
    const text = panes.view(pane)?.emulator?.textOf(range, contentVersion);
    if (!text?.ok) return;
    const data = new TextEncoder().encode(text.value);
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
    dispatch({ type: "notice", code: "copied", data: { bytes: data.length }, at: clock.now() });
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
    return { hits, focus: paneFocus, ...paintedLayout, look: lookOf, painted: (pane) => drawn.get(pane) ?? null };
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
    shape = layOut(size.cols, size.rows, tab ? dividers.shape(tab.id, view.tabs.get(tab.id)) ?? null : null, { sidebarCollapsed: state.sidebarCollapsed });
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
      act(`read:${event.type}`);
      if (event.type === "reply") {
        if (event.kind === "scheme") host.refreshDisplay();
        else panes.displayReply(event);
      }
      if (event.type === "focus") {
        panes.hostFocus(event.focused);
        // the host lost its screen meanwhile, or redrew it: the next frame writes every cell
        if (event.focused) painter?.invalidate();
      }
      dispatch(event);
    }
  }

  /** Everything due by the clock, then a frame pass when one is owed and FRAME_PASS_MS passed since the last. */
  function turn(): void {
    const now = clock.now();
    if (closing) {
      if (quitting && now >= quitting.at) quitting.settle();
      return;
    }
    for (const event of framer.tick(now)) dispatch(event);
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

  function pass(now: number): void {
    if (!painter || !shape || ended) return;
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
    const copied = new Set<string>();
    const nextDrawn = new Map<string, PanePicture>();
    for (const spot of frameShape.spots) {
      if (spot.covered) continue;
      const view = panes.view(spot.pane);
      // the grid of the picture drawn, never a size a newer attach was told before its first paint: with none, the visible cells
      const actual = view?.grid ?? { cols: spot.cells.cols, rows: spot.cells.rows };
      let held = grids.get(spot.pane);
      const emulator = view?.emulator ?? null;
      if (!held || held.emulator !== emulator) {
        held = { emulator, grid: new PaneGrid(painter.styles, actual.cols, actual.rows) };
        grids.set(spot.pane, held);
      }
      held.grid.resize(actual.cols, actual.rows);
      const copy = emulator ? held.grid.copy(emulator, held.grid.allDirty) : null;
      if (copy?.ok) copied.add(spot.pane);
      const live = paneLive(view, shown);
      const scene = paneScene(spot, held.grid, actual, { live, hold: holds.has(spot.pane), dim: !live });
      const snapshot = copy?.ok && emulator ? emulator.frameScreen() : null;
      const look: PanePicture | null = snapshot?.ok && snapshot.value && emulator ? {
        rect: scene.rect, top: scene.view?.row ?? 0, grid: actual, emulator,
        altScreen: snapshot.value.altScreen, screen: snapshot.value.screens, history: snapshot.value.history, contentVersion: snapshot.value.contentVersion,
      } : null;
      if (look) nextDrawn.set(spot.pane, look);
      const selection = pointer.shown(spot.pane, paneFocus, look);
      scenes.push({ ...scene, scrolledBack: look !== null && rowsAboveBottom(look) > 0, ...(selection ? { selection } : {}) });
    }
    const size = host.size();
    const paneViews = new Map(panes.views().map((v) => [v.terminal, v]));
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
    paintedLayout = nextLayout;
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
      return {
        due: timer ? due : [],
        passes,
        writes,
        actions: [...actions],
        leaveError,
        hc: hello ? { version: hello.version, features: [...hello.features] } : null,
        size: entered ? host.size() : { cols: 0, rows: 0 },
        grids: [...grids].map(([pane, { grid }]) => ({ pane, cols: grid.grid.cols, rows: grid.grid.rows })),
        mode: { name: state.mode.name, locked: state.locked, armed: state.armed, overlays: state.overlays.map((overlay) => overlay.kind) },
        link: { kind: link.state.kind, code: "code" in link.state ? link.state.code : null },
      };
    },
  };
}
