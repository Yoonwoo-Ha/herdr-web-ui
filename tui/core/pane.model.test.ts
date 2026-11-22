import { expect, it } from "bun:test";
import { FRAME_CLOSE, FRAME_DATA, FRAME_FOCUS, FRAME_RESIZE } from "../../server/herdr-core/connection.ts";
import { type FakeCoreOptions, type FakeEntry, FakeHcCore, FEATURES_0_1_17, HEADLESS } from "../../server/herdr-core/core.fake.ts";
import { typedKey } from "../input/decode.ts";
import { PANE_REOPEN_LIMIT } from "../model/deadlines.ts";
import { type AttachRecord, type ChannelCall, type EmulatorRecord, type Rival, type Screen, Stage } from "../testing/pane-harness.ts";
import type { PaneInput } from "./pane.ts";

/**
 * The pane machine under random runs: each sequence is a fake core (like hc 0.1.18 or 0.1.17), one
 * screen with real emulators, a rival viewer, and a run of random steps: panes shown, hidden, covered
 * and resized, focus moves, input of every kind with fresh and stale stamps, program output cut
 * anywhere, the clock, frame passes, another client attaching, typing and resizing, programs ending,
 * shells lost and restarted, terminals removed, the line lost, the core stopped and replaced, missed
 * events, emulator and attach faults, and the owner calling back in from a draw or a notice. After
 * EVERY step the invariants of the machine are checked by an oracle that does not ask the machine:
 * it sees each call on a channel and each write into an emulator as it is made, and reads the fake
 * core's own record of what each viewer advertises.
 *
 * Every sequence ends with the row's settle property in its strong form, on a pane that lived through
 * the run: nobody types and the host does not change any more; another viewer comes, resizes and
 * undoes it, leaves (also inside the wait, while the pane is under a zoom, hidden, or between its own
 * CLOSE and its next attach), the rectangle becomes what the channel advertises, a shell is replaced
 * in the middle of a repaint, the pane is shown again, an old answer arrives late, a new core comes
 * up. For each the number of attaches must be exactly what the row allows ("once per change"), and
 * the terminal's size must not move while nobody types.
 *
 * A repaint leaves the terminal at the size the last viewer chose. Two rules hold it here, neither of
 * which asks the machine: an attach advertises the pane's rectangle, or a size the core itself said
 * the terminal has since the pane's last shown attach (what that attach was told, then the `size`
 * events the core sent from its CLOSE on), never the size of a terminal nobody views; and a terminal
 * somebody views is never left at that size. Which of those sizes a repaint has to advertise, the
 * last one a viewer chose, is what the second part holds.
 *
 * The second part puts two screens on one terminal, and beside them a viewer that drives it: windows
 * change (also twice 150 ms apart), the screens fire in any order within one turn of the clock, the
 * user types, the driving viewer comes, resizes, types and leaves, a screen leaves the tab and comes
 * back, and all of it also inside another screen's gap (its CLOSE answer or its attach reply held).
 * Beside the fake core runs a reference that hears every call and frame the core gets and keeps the
 * core's own size rule, with one difference: a screen's repaint advertises the size the terminal has
 * at that moment (or, with nobody viewing it, had when somebody last did). Beside a viewer that drives
 * the terminal a repaint's size has no effect, and the reference takes what it advertised as it is.
 *
 * With two screens and the fake's usual order, after every quiet tail the terminal must have the
 * reference's size, which is the size the last choosing viewer chose; the wire must stay as it is;
 * and no screen may have sent anything but a resumed attach and CLOSE outside the user's input.
 *
 * In a quarter of the sequences a third screen joins, and in three in ten the fake sends a size event
 * behind the reply of an attach written in the same turn (its `late` option: real cores did so in 10 to
 * 51 percent of such races over one verification's runs of 1,200, depending on who else listens to the
 * core and views the terminal: a range of runs, not a bound). There the row's sentence does not hold, and docs/tui/parity.md
 * says why: on the wire another screen's repaint and a viewer's choice are the same resumed attach,
 * and an earlier change's event behind a reply reads like a later choice, so a repaint can keep or take
 * an older size. For those tails with no viewer whose input leads, only this is asserted: the terminal
 * rests at a size some viewer chose with its own rectangle in the sequence (an attach that carried it,
 * the take's RESIZE, the driver's attach or RESIZE), never at the size of a terminal nobody views; the
 * wire stays as it is; nothing leaves a screen outside the user's input but a resumed attach and CLOSE;
 * and at the end the next key in a screen sends RESIZE with its rectangle (where its channel advertises
 * another size) and then the key, after which the full rule holds again. Where a viewer's input leads,
 * the full rule holds in those sequences too.
 *
 * The viewer beside the screens drives the terminal. An earlier form of this part also had a viewer
 * that only views, and with it the model failed in a case of the same family: both screens between
 * their CLOSE and their next attach, the core falls back to that viewer's older size, and a repaint
 * takes it for a choice. That viewer was taken out of the generator then, which this header did not
 * say at first; the third screen stands for that family now, under the weaker oracle above.
 *
 * OVIS_TUI_MODEL_SEQUENCES sets how many sequences of each part run (default 200 one-screen and 150
 * two-screen sequences, which is what the unit lane runs; OVIS_TUI_MODEL_PAIRS sets the second count
 * alone; the evidence runs use thousands and several seeds), OVIS_TUI_MODEL_SEED picks the run
 * (default 23), and OVIS_TUI_MODEL_ONLY or OVIS_TUI_MODEL_PAIR replays one sequence of the first or
 * the second part by the seed a failure printed.
 */
const SEED = Number(process.env["OVIS_TUI_MODEL_SEED"] ?? 23);
const SEQUENCES = Number(process.env["OVIS_TUI_MODEL_SEQUENCES"] ?? 200);
const PAIRS = Number(process.env["OVIS_TUI_MODEL_PAIRS"] ?? process.env["OVIS_TUI_MODEL_SEQUENCES"] ?? 150);
const ONLY = process.env["OVIS_TUI_MODEL_ONLY"];
const PAIR = process.env["OVIS_TUI_MODEL_PAIR"];
const STEPS = 28;
const RECTANGLES = [[20, 6], [30, 8], [40, 10], [24, 7]] as const;
const OUTPUTS = [
  "a line of output\r\n", "\x1b[?1004h", "\x1b[?1004l", "\x1b[?1000h\x1b[?1006h", "\x1b[?1000l", "\x1b[5n", "\x1b[6n", "\x1b[?2004h", "\x1b[?2004l",
  "\x1b[2J\x1b[H", "\x1b[31mred\x1b[0m", "\x07", "\x1b[?2026h", "\x1b[?2026l", "\x1b]0;title\x07",
];

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface Totals { steps: number; attaches: number; lives: number; accepted: number; refused: number; takes: number; reattaches: number; lines: number; settled: number; handedBack: number; deep: number }

/** `deep`: the sequence also ends with the probes that replace a shell, a line and a core (each costs several attaches, and every attach a real emulator) */
async function sequence(seed: number, totals: Totals, deep: boolean): Promise<void> {
  const random = mulberry(seed);
  const chance = (share: number) => random() < share;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const options: FakeCoreOptions = chance(0.4) ? { version: "0.1.17", features: FEATURES_0_1_17 } : {};
  const stage = new Stage(new FakeHcCore(options));
  let terminals = [1, 2, 3].map(() => stage.core.spawn().address);
  const screen: Screen = await stage.screen();
  const rival: Rival = stage.rival();

  // what the test itself did, which the oracle judges the machine against
  const shown = new Map<string, { cols: number; rows: number; covered: boolean }>();
  let focus: string | null = null;
  let hostFocused = true;
  /** the attaches that were taken live, and when */
  const liveAt = new Map<AttachRecord, number>();
  const gotFocus = new Set<AttachRecord>();
  const fedBy = new Map<EmulatorRecord, { attach: AttachRecord; next: number; bytes: number }>();
  const feeds = new Set<AttachRecord>();
  const broken: string[] = [];
  const trace: string[] = [];
  const latest = (terminal: string) => screen.attaches.filter((record) => record.terminal === terminal).at(-1);
  const open = (record: AttachRecord | undefined): record is AttachRecord => record !== undefined && record.state === "open" && !record.closeAsked && !record.closeHeard;
  const wantedOf = (terminal: string) => { const pane = shown.get(terminal); return pane ? `${pane.cols}x${pane.rows}` : null; };
  const alive = (terminal: string) => {
    try {
      const record = stage.core.terminal(terminal);
      return record.state === "live" && record.reason === null;
    } catch {
      return false;
    }
  };
  const isReply = (text: string) => screen.emulators.some((record) => record.replies.some((reply) => text.endsWith(` ${Buffer.from(reply).toString("hex")}`)));

  // what each attach was last told its terminal's size is while it was in use: a `size` event behind the stream's first bytes
  // is newer than the reply, and one that comes after our CLOSE (or the stream's end) was not told to it
  const toldSize = new Map<AttachRecord, string>();
  screen.hooks.link = (notice) => {
    if (notice.type !== "event" || notice.event.type !== "size" || notice.event.terminal === undefined) return;
    const attach = latest(notice.event.terminal);
    if (attach && attach.received.length > 0 && !attach.closeAsked && !attach.closeHeard) toldSize.set(attach, `${String(notice.event.data?.["cols"])}x${String(notice.event.data?.["rows"])}`);
  };
  const headless = `${HEADLESS.cols}x${HEADLESS.rows}`;
  /** where the core's log stood when the machine asked each attach's CLOSE: what the core said of the terminal's size from there on is what the pane could hear in its gap */
  const closedAt = new Map<AttachRecord, { core: FakeHcCore; at: number }>();

  // I8, I9: every attach is a resumed plain viewer with the rectangle or (a repaint) a size the core said the terminal has since
  // the pane's last shown attach, never the size of a terminal nobody views, and none leaves while an earlier one is open
  screen.hooks.attach = (record) => {
    totals.attaches++;
    const { terminal } = record;
    const params = record.params;
    if (params["resumed"] !== true || params["history"] !== 2000 || "observe" in params || "resize_notifications" in params) broken.push(`I8 attach params ${JSON.stringify(params)}`);
    const size = `${String(params["cols"])}x${String(params["rows"])}`;
    const past = screen.attaches.filter((other) => other !== record && other.terminal === terminal);
    const before = past.at(-1);
    const told = before ? toldSize.get(before) ?? before.reply : null;
    // the pane's last attach that was shown (taken live), or its first: the core's `size` events from that attach's CLOSE on
    const since = [...past].reverse().find((other) => liveAt.has(other)) ?? past[0];
    const mark = since ? closedAt.get(since) : undefined;
    const said = mark && mark.core === stage.core
      ? stage.core.log.slice(mark.at).flatMap((entry) => entry.what === "event" && entry.type === "size" && entry.terminal === terminal ? [`${String((entry.data as Record<string, unknown>)["cols"])}x${String((entry.data as Record<string, unknown>)["rows"])}`] : [])
      : [];
    if (size !== wantedOf(terminal) && (size === headless || (size !== told && !said.includes(size)))) broken.push(`I8 ${terminal} attached at ${size}: neither its rectangle ${wantedOf(terminal)}, nor ${told}, the size its attach before was told last, nor a size the core said the terminal has since (${said.join(", ") || "none"}), or the size of a terminal nobody views`);
    if (!shown.has(terminal)) broken.push(`I14 ${terminal} is not shown and was attached`);
    const earlier = screen.attaches.filter((other) => other !== record && other.terminal === terminal && other.state !== "refused" && !other.closeHeard);
    if (earlier.length > 0) broken.push(`I9 ${terminal} attached again while attach ${earlier.map((other) => other.index).join(",")} is not closed`);
    if (screen.attaches.filter((other) => other.terminal === terminal).length > 1) totals.reattaches++;
  };

  // I4: an emulator is fed the frames of exactly one attach, each once, in the order they came
  screen.hooks.write = (emulator, bytes) => {
    let feed = fedBy.get(emulator);
    if (!feed) {
      const attach = screen.attaches.find((record) => record.received[0] === bytes);
      if (!attach || feeds.has(attach)) {
        broken.push(`I4 emulator ${emulator.index} was first fed bytes that open no attach's stream, or one that feeds another emulator`);
        return;
      }
      feeds.add(attach);
      fedBy.set(emulator, feed = { attach, next: 0, bytes: 0 });
    }
    if (feed.attach.received[feed.next] !== bytes) broken.push(`I4 emulator ${emulator.index} got bytes that are not frame ${feed.next} of attach ${feed.attach.index}`);
    feed.next++;
    feed.bytes += bytes.length;
  };

  // I1, I3, I5, I6, I7, I14: judged at the moment the machine makes the call
  screen.hooks.call = (call: ChannelCall) => {
    const { attach, op, text } = call;
    const terminal = attach.terminal;
    const where = `${op} ${text.slice(0, 40)} on attach ${attach.index} (${terminal})`;
    if (attach.closeAsked) broken.push(`I14 ${where} after our CLOSE`);
    if (op === "close") {
      closedAt.set(attach, { core: stage.core, at: stage.core.log.length });
      return;
    }
    // Display facts belong to an open attach, independent of the input and visibility gates.
    if (op === "facts") return;
    if (shown.get(terminal)?.covered) broken.push(`I6 ${where} while the pane is covered`);
    if (op === "credit") return;
    if (op === "focus" && text === "FOCUS 0") {
      if (!gotFocus.has(attach)) broken.push(`I6 ${where}: this channel never got FOCUS 1`);
      if (shown.has(terminal)) broken.push(`I6 ${where} while the pane is shown`);
      return;
    }
    if (!liveAt.has(attach)) broken.push(`I3 ${where} before the pane was live`);
    if (screen.panes.view(terminal)?.state.kind !== "Live") broken.push(`I3 ${where} in state ${screen.state(terminal)}`);
    const typing = call.input !== null;
    if (op === "writeAutomatic") {
      if (!attach.automaticInput) broken.push(`I6 ${where} on a channel without automatic input`);
      if (text !== "AUTOMATIC_INPUT 1b5b49" && text !== "AUTOMATIC_INPUT 1b5b4f" && !isReply(text)) broken.push(`I2 ${where} is neither a focus report nor an emulator's reply`);
      return;
    }
    if (op === "write" && !typing) {
      // a reply as DATA: only without automatic input, only from the pane the user drives
      if (attach.automaticInput || !isReply(text)) broken.push(`I1 ${where} outside the user's input`);
      if (focus !== terminal || !hostFocused || !gotFocus.has(attach)) broken.push(`I6 ${where} from a pane the user does not drive`);
    }
    if (op !== "write" && !typing) broken.push(`I6 ${where} without the user's input`);
    if (typing && focus !== terminal) broken.push(`I1 ${where} is not the focused pane`);
    const told = screen.advertisedTo(attach);
    if (op === "resize") {
      if (text !== `RESIZE ${wantedOf(terminal)}`) broken.push(`I6 ${where}: not the rectangle ${wantedOf(terminal)}`);
      if (told === wantedOf(terminal)) broken.push(`I6 ${where}: the channel already advertises it`);
      totals.takes++;
    }
    if (op === "focus") {
      if (attach.automaticInput || gotFocus.has(attach)) broken.push(`I6 ${where}: a second FOCUS 1, or one on a channel with automatic input`);
      gotFocus.add(attach);
    }
    if (op === "write" && told !== null && told !== wantedOf(terminal)) broken.push(`I7 ${where} while the channel advertises ${told}, not ${wantedOf(terminal)}`);
  };

  const input = (event: PaneInput): void => {
    const terminal = focus;
    const attach = terminal === null ? undefined : latest(terminal);
    const allowed = terminal !== null && open(attach) && liveAt.has(attach) && event.at > liveAt.get(attach)! && screen.link.state.kind === "Online" && shown.get(terminal)?.covered === false;
    const before = screen.calls.length;
    const result = screen.input(event);
    const made = screen.calls.slice(before).filter((call) => call.op !== "close");
    if (result.sent) totals.accepted++;
    else totals.refused++;
    // I1: sent only when the test's own account allows it; a refusal sends nothing
    if (result.sent && !allowed) broken.push(`I1 input ${event.type} read at ${event.at} was sent to ${terminal} (${terminal === null ? "none" : screen.state(terminal)}, live since ${attach ? liveAt.get(attach) : "never"})`);
    if (!result.sent && made.length > 0) broken.push(`I1 a refused input (${result.code}) made ${made.map((call) => call.text).join(", ")}`);
    // I2, I6: one DATA, last, with at most RESIZE and FOCUS 1 ahead of it in that order
    if (result.sent && !/^(resize )?(focus )?write $/.test(made.map((call) => `${call.op} `).join(""))) broken.push(`I2 an accepted input made ${made.map((call) => call.text).join(", ")}`);
    if (event.type === "paste" && !event.complete && result.sent) broken.push("I1 a cut paste was sent");
  };
  const stamp = () => (chance(0.15) ? stage.clock.now - Math.floor(random() * 400) : screen.stamp());
  const someInput = (): PaneInput => {
    const at = stamp();
    const kind = random();
    if (kind < 0.55) return { ...typedKey(pick(["a", "b", "Z", "1", " "]), {}), at };
    if (kind < 0.62) return { ...typedKey("q", {}, "release"), at };
    if (kind < 0.7) return { type: "text", text: pick(["x", "한", "é"]), at };
    if (kind < 0.8) return { type: "paste", text: pick(["pasted", "two\nlines"]), complete: !chance(0.2), at };
    if (kind < 0.85) return { type: "key", key: pick(["ENTER", "ESCAPE", "ARROW_UP", "UNIDENTIFIED"]), mods: {}, action: "press", at };
    return { type: "mouse", action: pick(["press", "press", "release", "motion"] as const), button: pick(["left", "wheelUp"] as const), mods: {}, col: 2, row: 1, at };
  };

  /** a relay closes the stream with no reason while the terminal lives */
  const drop = (record: AttachRecord | undefined) => {
    if (!open(record)) return;
    record.closeHeard = true;
    record.state = "closed";
    record.handlers.onClose(null);
  };
  const apply = () => screen.show(...[...shown].map(([terminal, pane]) => [terminal, pane.cols, pane.rows, pane.covered] as [string, number, number, boolean]));
  const pass = (budget: number) => {
    for (const view of screen.panes.views()) {
      view.emulator?.frame(() => {});
      screen.panes.credit(view.terminal, budget);
      if (!view.ready) continue;
      // noted before the call: the owner may type from the notice the pane's new state makes
      const attach = latest(view.terminal);
      if (attach) liveAt.set(attach, stage.clock.now);
      if (screen.panes.live(view.terminal)) {
        if (!open(attach)) broken.push(`I3 ${view.terminal} went live without an open attach`);
        totals.lives++;
      } else if (attach) liveAt.delete(attach);
    }
  };
  const reconnect = async () => {
    for (let attempt = 0; attempt < 12 && screen.link.state.kind === "Offline" && screen.link.state.retryAt !== null; attempt++) {
      await stage.advance(Math.max(0, screen.link.state.retryAt - stage.clock.now));
    }
  };

  /** [weight, name, what it does]: a step that awaits something cannot be part of a burst */
  const steps: [number, string, () => void | Promise<void>][] = [
    [10, "show", () => {
      shown.clear();
      for (const terminal of terminals) {
        if (chance(0.6)) {
          const [cols, rows] = pick(RECTANGLES);
          shown.set(terminal, { cols, rows, covered: chance(0.08) });
        }
      }
      apply();
    }],
    [8, "resize", () => {
      for (const pane of shown.values()) if (chance(0.6)) [pane.cols, pane.rows] = pick(RECTANGLES);
      apply();
    }],
    [4, "rectangle flickers inside the wait", () => {
      // a rectangle that changes and is back 50 ms later: nothing of it may be left to count later
      const panes = [...shown.values()];
      if (panes.length === 0) return;
      const pane = pick(panes);
      const { cols, rows } = pane;
      [pane.cols, pane.rows] = pick(RECTANGLES.filter(([otherCols, otherRows]) => otherCols !== cols || otherRows !== rows));
      apply();
      stage.clock.now += 50;
      screen.fire();
      Object.assign(pane, { cols, rows });
      apply();
    }],
    [4, "take inside the wait", () => {
      const pane = focus === null ? undefined : shown.get(focus);
      if (!pane) return;
      [pane.cols, pane.rows] = pick(RECTANGLES);
      apply();
      stage.clock.now += 50;
      screen.fire();
      input({ ...typedKey("t", {}), at: screen.stamp() });
    }],
    [3, "cover", () => {
      for (const pane of shown.values()) pane.covered = chance(0.3);
      apply();
    }],
    [7, "focus", () => {
      focus = chance(0.1) ? null : chance(0.8) && shown.size > 0 ? pick([...shown.keys()]) : pick(terminals);
      screen.panes.focus(focus);
    }],
    [2, "host focus", () => {
      hostFocused = !hostFocused;
      screen.panes.hostFocus(hostFocused);
    }],
    [30, "input", () => { for (let count = 1 + Math.floor(random() * 3); count > 0; count--) input(someInput()); }],
    [14, "output", () => {
      const terminal = pick(terminals);
      if (!alive(terminal)) return;
      const program = stage.core.program(terminal);
      const kind = random();
      if (kind < 0.04) program.output("x".repeat(300_000));
      else if (kind < 0.12) program.output("0123456789".repeat(4_000));
      else if (kind < 0.25) {
        // one sequence in two pieces, cut inside a character or an escape
        const whole = Buffer.from(pick(["한글 text\r\n", "\x1b[38;5;196mcolour\x1b[0m", "\x1b]0;a title\x07"]));
        const cut = 1 + Math.floor(random() * (whole.length - 1));
        program.output(whole.subarray(0, cut));
        program.output(whole.subarray(cut));
      } else program.output(pick(OUTPUTS));
    }],
    [24, "pass", () => pass(chance(0.3) ? 2_000 : 512 * 1024)],
    [12, "clock", () => {
      stage.clock.now += pick([1, 50, 149, 150, 151, 1_000, 5_000]);
      screen.fire();
    }],
    [5, "rival attaches", async () => {
      const terminal = pick(terminals);
      if (rival.attached || !alive(terminal)) return;
      const [cols, rows] = pick([...RECTANGLES, [120, 40], [1200, 50]] as const);
      await rival.attach(terminal, cols, rows, chance(0.4)).catch(() => {});
    }],
    [5, "rival types", () => rival.type("r")],
    [4, "rival resizes", () => { const [cols, rows] = pick(RECTANGLES); rival.resize(cols, rows); }],
    [3, "rival leaves", async () => { await rival.detach(); }],
    [3, "shell lost", () => { const terminal = pick(terminals); if (alive(terminal)) stage.core.lose(terminal); }],
    [3, "shell restarted", () => {
      const terminal = pick(terminals);
      try {
        const record = stage.core.terminal(terminal);
        if (record.state === "live" && record.reason !== null) stage.core.restartTerminal(terminal);
      } catch { /* the terminal is gone */ }
    }],
    [2, "program ends", () => { const terminal = pick(terminals); if (alive(terminal)) stage.core.program(terminal).exit(Math.floor(random() * 4)); }],
    [1, "terminal removed", () => { const terminal = pick(terminals); try { stage.core.remove(terminal); } catch { /* gone already */ } }],
    [2, "terminal made", () => { terminals = [...terminals, stage.core.spawn().address]; }],
    [4, "line lost", () => stage.core.restart()],
    [8, "reconnect", reconnect],
    [2, "core stopped and replaced", () => {
      stage.core.stop();
      stage.core = new FakeHcCore(options);
      terminals = [1, 2, 3].slice(0, 1 + Math.floor(random() * 3)).map(() => stage.core.spawn().address);
      totals.lines++;
    }],
    [2, "missed", () => stage.core.missed()],
    [1, "heartbeat", () => stage.core.heartbeat()],
    [3, "emulator fault", () => {
      const kind = random();
      if (kind < 0.5) screen.faults.write = pick(["trapped", "failed", "busy"] as const);
      else if (kind < 0.65) screen.faults.resize = pick(["size", "failed"] as const);
      else if (kind < 0.85) screen.faults.encode = pick(["busy", "failed"] as const);
      else screen.faults.create = true;
    }],
    [3, "attach fault", () => {
      const kind = random();
      if (kind < 0.45) screen.faults.attach = { reject: pick(["unavailable", "finished", "not_found", "timeout", "closed", "blocked"]) };
      else if (kind < 0.6) screen.faults.attach = { reply: () => ({ channel: 1, terminal: {} }) };
      else if (kind < 0.8) screen.faults.holdReplies = true;
      // the core's answer to our CLOSE comes late: no attach may leave before it
      else screen.faults.holdCloses = true;
    }],
    [4, "held answers let go", () => screen.release()],
    [2, "stream dropped", () => drop(terminals.map(latest).find(open))],
    [2, "owner calls back from a draw", () => {
      const view = screen.panes.views().find((seen) => seen.emulator && seen.state.kind === "Live");
      if (!view) return;
      stage.core.program(view.terminal).output("redraw\r\n");
      let done = false;
      const hide = () => {
        if (done) return;
        done = true;
        shown.delete(view.terminal);
        apply();
      };
      // the picture may have nothing new to draw yet: then the owner hides the pane right after
      view.emulator!.frame(hide);
      hide();
    }],
    [2, "owner calls back from a notice", () => {
      screen.hooks.notice = () => {
        screen.hooks.notice = undefined;
        input(someInput());
        for (const view of screen.panes.views()) screen.panes.credit(view.terminal, 1_000);
      };
    }],
    [2, "display changes", () => screen.panes.setDisplay(chance(0.3) ? undefined : { fg: pick(["#ffffff", "#000000"]), bg: "#101010" })],
    [2, "retry", () => screen.panes.retry(pick(terminals))],
  ];
  const total = steps.reduce((sum, [weight]) => sum + weight, 0);
  const draw = () => {
    let at = random() * total;
    return steps.find(([weight]) => (at -= weight) < 0)!;
  };

  /** what holds whenever the stage is at rest */
  const check = (after: string) => {
    // I5: credited <= consumed <= received, per attach
    for (const attach of screen.attaches) {
      const consumed = [...fedBy.values()].find((feed) => feed.attach === attach)?.bytes ?? 0;
      if (attach.credited > consumed || consumed > attach.receivedBytes) broken.push(`I5 attach ${attach.index}: credited ${attach.credited}, consumed ${consumed}, received ${attach.receivedBytes}`);
    }
    // I15: a terminal somebody views is not at the size of a terminal nobody views: no rectangle here is that size, so only a
    // viewer that advertised what its own CLOSE left behind could have put it there
    for (const terminal of terminals) {
      if (alive(terminal) && stage.core.viewers(terminal).length > 0 && stage.core.size(terminal) === headless) broken.push(`I15 ${terminal} is at ${headless}, the size of a terminal nobody views, with ${stage.core.viewers(terminal).length} viewer(s): ${stage.core.viewers(terminal).map((viewer) => `${viewer.cols}x${viewer.rows}`).join(", ")}`);
    }
    // I13: the machine never calls an emulator from inside that emulator's own write
    for (const emulator of screen.emulators) if (emulator.reentered.length > 0) broken.push(`I13 emulator ${emulator.index} was called from inside its own write: ${emulator.reentered.join(", ")}`);
    for (const view of screen.panes.views()) {
      const { terminal, state } = view;
      if (!shown.has(terminal) && state.kind !== "Closing") broken.push(`I14 ${terminal} is not shown and is ${state.kind}`);
      if (state.kind !== "Painting" && state.kind !== "Live") continue;
      const attach = latest(terminal);
      if (!open(attach)) {
        broken.push(`I4 ${terminal} is ${state.kind} with no open attach`);
        continue;
      }
      // I10: the grid follows the record, and the emulator has it
      const feed = [...fedBy.entries()].find(([, fed]) => fed.attach === attach);
      if (screen.link.state.kind === "Online" && alive(terminal)) {
        const size = stage.core.size(terminal);
        if (!view.actual || `${view.actual.cols}x${view.actual.rows}` !== size) broken.push(`I10 ${terminal} holds ${JSON.stringify(view.actual)} and the core's record says ${size}`);
        if (feed && `${feed[0].cols}x${feed[0].rows}` !== size) broken.push(`I10 ${terminal}'s emulator is ${feed[0].cols}x${feed[0].rows} and the core's record says ${size}`);
      }
      if (state.kind === "Live" && !liveAt.has(attach)) broken.push(`I3 ${terminal} is Live and its attach was never taken live`);
    }
    if (broken.length > 0) throw new Error(`after "${after}": ${broken.slice(0, 4).join(" | ")}`);
  };

  try {
    // every sequence starts with a tab shown and its panes on their way
    for (const terminal of terminals.slice(0, 2)) shown.set(terminal, { cols: 30, rows: 8, covered: false });
    apply();
    focus = terminals[0]!;
    screen.panes.focus(focus);
    await stage.settle();
    pass(512 * 1024);
    check("start");
    for (let step = 0; step < STEPS; step++) {
      const burst = chance(0.15) ? 3 : 1;
      const names: string[] = [];
      for (let part = 0; part < burst; part++) {
        const [, name, run] = draw();
        names.push(name);
        await run();
      }
      trace.push(names.join(" + "));
      await stage.settle();
      totals.steps++;
      check(names.join(" + "));
    }

    // I11: left alone, it settles. Faults and held replies end, the line comes back, and nothing more is asked of anyone
    Object.assign(screen.faults, { attach: null, create: false, write: null, resize: null, encode: null });
    screen.release();
    screen.hooks.notice = undefined;
    await rival.detach();
    await stage.settle();
    await reconnect();
    const quiet = () => `${screen.attaches.length} attaches, ${screen.calls.filter((call) => call.op !== "credit").length} frames, terminals at ${terminals.filter(alive).map((terminal) => stage.core.size(terminal)).join(" ")}`;
    let rest = "";
    for (let turn = 0; turn < 9; turn++) {
      stage.clock.now += 150;
      screen.fire();
      await stage.settle();
      pass(512 * 1024);
      await stage.settle();
      if (turn === 4) rest = quiet();
      if (turn > 4 && quiet() !== rest) broken.push(`I11 turn ${turn} of the quiet tail: ${quiet()}, after ${rest}`);
      trace.push("tail");
      check("the quiet tail");
    }
    // I11 in its strong form: what the row allows a settled pane to do when others act and nobody types here
    const turns = async (count: number, each?: (turn: number) => void) => {
      for (let turn = 0; turn < count; turn++) {
        stage.clock.now += 150;
        screen.fire();
        await stage.settle();
        pass(512 * 1024);
        await stage.settle();
        each?.(turn);
      }
    };
    const livePane = (terminal: string) => alive(terminal) && screen.panes.view(terminal)?.state.kind === "Live" && open(latest(terminal)) && shown.get(terminal)?.covered === false;
    let t = screen.link.state.kind === "Online" ? terminals.find(livePane) : undefined;
    if (!t && screen.link.state.kind === "Online") {
      // no pane of the run is live at its end: a new terminal stands in
      const made = stage.core.spawn().address;
      terminals = [...terminals, made];
      await stage.settle();
      shown.set(made, { cols: 30, rows: 8, covered: false });
      apply();
      await turns(2);
      if (livePane(made)) t = made;
    }
    probes: if (t) {
      const pane = t;
      // a stream this test dropped the way a relay would is still a viewer in the fake core: a new line leaves the pane's own
      // attach as the terminal's only viewer, which is what the probes about a pane left alone start from
      if (stage.core.viewers(pane).length !== 1) {
        stage.core.restart();
        await stage.settle();
        await reconnect();
        await turns(2);
        if (!livePane(pane) || stage.core.viewers(pane).length !== 1) break probes;
      }
      totals.settled++;
      const countOf = () => screen.attaches.filter((record) => record.terminal === pane).length;
      const sizeOf = (record: AttachRecord | undefined) => (record ? `${String(record.params["cols"])}x${String(record.params["rows"])}` : "none");
      /** four deadline steps (a wait is one): the terminal's size must not move, and exactly `allowed` attaches may follow (asking `asks`) */
      const watch = async (label: string, before: number, allowed: number, asks: string | null) => {
        const size = stage.core.size(pane);
        await turns(4, (turn) => {
          if (alive(pane) && stage.core.size(pane) !== size) broken.push(`I11 ${label}: the terminal went from ${size} to ${stage.core.size(pane)} at turn ${turn} with nobody typing`);
        });
        const made = countOf() - before;
        if (made !== allowed) broken.push(`I11 ${label}: ${made} attach(es) followed, the row allows ${allowed}; the last asked ${screen.attaches.filter((record) => record.terminal === pane).slice(-3).map(sizeOf).join(", ")}`);
        else if (asks !== null && allowed > 0 && sizeOf(latest(pane)) !== asks) broken.push(`I11 ${label}: the attach asked ${sizeOf(latest(pane))}, not ${asks}`);
        check(label);
      };
      // only this pane stays in the tab, focused, on a focused host; then it is left alone
      for (const terminal of [...shown.keys()]) if (terminal !== pane) shown.delete(terminal);
      apply();
      focus = pane;
      screen.panes.focus(pane);
      hostFocused = true;
      screen.panes.hostFocus(true);
      await turns(2);

      // the last user input: the rectangle changes and the user types inside the wait. The take tells the core, and nothing follows
      let before = countOf();
      const [nextCols, nextRows] = RECTANGLES.find(([otherCols, otherRows]) => `${otherCols}x${otherRows}` !== wantedOf(pane))!;
      shown.set(pane, { cols: nextCols, rows: nextRows, covered: false });
      apply();
      stage.clock.now += 50;
      screen.fire();
      input({ ...typedKey("s", {}), at: screen.stamp() });
      await stage.settle();
      await watch("a take inside the wait", before, 0, null);

      // the last host change: the rectangle changes and is back 50 ms later, at what the channel advertises
      before = countOf();
      const [awayCols, awayRows] = RECTANGLES.find(([otherCols, otherRows]) => otherCols !== nextCols || otherRows !== nextRows)!;
      shown.set(pane, { cols: awayCols, rows: awayRows, covered: false });
      apply();
      stage.clock.now += 50;
      screen.fire();
      shown.set(pane, { cols: nextCols, rows: nextRows, covered: false });
      apply();
      await stage.settle();
      await watch("the rectangle came back inside the wait", before, 0, null);
      const rectangle = wantedOf(pane)!;

      // another viewer comes (idle, or typing): one repaint at the terminal's size if the size moved, else nothing
      before = countOf();
      const sizeBefore = stage.core.size(pane);
      const driving = chance(0.5);
      await rival.attach(pane, 120, 40, !driving);
      if (driving) rival.type("r");
      await stage.settle();
      const taken = stage.core.size(pane);
      await watch("another viewer comes", before, taken !== sizeBefore && taken !== rectangle ? 1 : 0, taken);

      // it resizes, and 50 ms later it is at the pane's own rectangle: nothing is owed
      before = countOf();
      rival.resize(100, 30);
      await stage.settle();
      stage.clock.now += 50;
      screen.fire();
      await stage.settle();
      const [cols, rows] = rectangle.split("x").map(Number) as [number, number];
      rival.resize(cols, rows);
      await stage.settle();
      await watch("another viewer's resize undone inside the wait", before, 0, null);

      // the other viewer, which has the pane's own size, leaves: the core hands the terminal to the one viewer left, at what its
      // attach advertises. The emulator has that grid already, so nothing is repainted, and a repaint would have to CLOSE first
      const told = screen.advertisedTo(latest(pane)!);
      /** one viewer is left, and the terminal is at `size` */
      const left = (label: string, size: string | null) => {
        const viewers = stage.core.viewers(pane).length;
        if (viewers !== 1 || stage.core.size(pane) !== size) broken.push(`I11 ${label}: ${viewers} viewer(s), the terminal at ${stage.core.size(pane)}, the one left advertises ${size}`);
      };
      before = countOf();
      if (told !== rectangle) totals.handedBack++;
      await rival.detach();
      await stage.settle();
      left("the other viewer leaves", told);
      await watch("the other viewer leaves", before, 0, null);

      // another comes and is gone again inside the wait: the terminal is back at what this attach advertises, and nothing is owed
      before = countOf();
      await rival.attach(pane, 100, 30);
      await stage.settle();
      stage.clock.now += 50;
      screen.fire();
      await rival.detach();
      await stage.settle();
      left("the other viewer came and left inside the wait", told);
      await watch("the other viewer came and left inside the wait", before, 0, null);

      // the same while the pane is under a zoom, and for longer than the wait: nothing waits when the zoom ends
      before = countOf();
      shown.set(pane, { ...shown.get(pane)!, covered: true });
      apply();
      await rival.attach(pane, 100, 30);
      await turns(2);
      rival.resize(90, 28);
      await turns(2);
      await rival.detach();
      await turns(2);
      shown.set(pane, { ...shown.get(pane)!, covered: false });
      apply();
      left("the other viewer left while the pane was covered", told);
      await watch("the other viewer left while the pane was covered", before, 0, null);

      // the host is resized to what the channel advertises already: nothing to tell the core
      if (told !== null && told !== rectangle) {
        before = countOf();
        const [toldCols, toldRows] = told.split("x").map(Number) as [number, number];
        shown.set(pane, { cols: toldCols, rows: toldRows, covered: false });
        apply();
        await watch("the rectangle becomes what the channel advertises", before, 0, null);
      }

      // the other viewer leaves between the pane's CLOSE for a repaint and its next attach: nobody views the terminal then. The
      // repaint advertises the size the terminal had when it was decided, and alone the terminal comes back to it
      await rival.attach(pane, 100, 30);
      await stage.settle();
      screen.faults.holdCloses = true;
      stage.clock.now += 150;
      screen.fire();
      await stage.settle();
      const decided = stage.core.size(pane);
      before = countOf();
      await rival.detach();
      await stage.settle();
      if (stage.core.size(pane) !== headless) broken.push(`I11 a repaint by the only viewer left: the terminal is at ${stage.core.size(pane)} with nobody viewing it`);
      // the pane heard of that size before the core's answer to its CLOSE; a core may also say it after, while the next attach is on its way
      const asked = screen.attaches.length;
      screen.hooks.notice = () => {
        if (screen.state(pane) === "Opening" && screen.attaches.length === asked) screen.panes.notice({ type: "event", epoch: 0, seq: null, event: { type: "size", terminal: pane, data: { ...HEADLESS } }, changes: [] });
      };
      screen.release();
      await turns(2);
      screen.hooks.notice = undefined;
      if (countOf() - before !== 1 || sizeOf(latest(pane)) !== decided || !livePane(pane)) broken.push(`I11 a repaint by the only viewer left: ${countOf() - before} attach(es), the last at ${sizeOf(latest(pane))}, decided at ${decided}; the pane is ${screen.state(pane)}`);
      left("a repaint by the only viewer left", decided);
      await watch("a repaint by the only viewer left", countOf(), 0, null);

      // the other viewer leaves while the pane is out of the tab: shown again it is attached with its rectangle, and alone it fits
      await rival.attach(pane, 100, 30);
      await stage.settle();
      const hidden = shown.get(pane)!;
      shown.delete(pane);
      apply();
      await rival.detach();
      await stage.settle();
      shown.set(pane, hidden);
      apply();
      await turns(2);
      if (sizeOf(latest(pane)) !== wantedOf(pane) || !livePane(pane)) broken.push(`I11 the other viewer left while the pane was hidden: ${screen.state(pane)}, attached at ${sizeOf(latest(pane))}, the rectangle ${wantedOf(pane)}`);
      left("the other viewer left while the pane was hidden", wantedOf(pane));
      check("the other viewer left while the pane was hidden");

      if (!deep) break probes;
      totals.deep++;
      await rival.attach(pane, 120, 40);
      rival.type("r");
      await turns(2);

      // a repaint begins, and before the core answered its CLOSE a new shell is announced: it is attached with the rectangle
      screen.faults.holdCloses = true;
      rival.resize(90, 28);
      await stage.settle();
      stage.clock.now += 150;
      screen.fire();
      await stage.settle();
      stage.core.emit("restarted", pane, stage.core.terminal(pane));
      await stage.settle();
      screen.release();
      await turns(2);
      if (sizeOf(latest(pane)) !== wantedOf(pane) || !livePane(pane)) {
        broken.push(`I11 a new shell during a repaint: ${screen.state(pane)}, attached at ${sizeOf(latest(pane))}, the rectangle ${wantedOf(pane)}`);
      }
      check("a new shell during a repaint");

      // the other viewer resizes, and inside the wait the pane leaves the tab and is back: it is attached with its rectangle, as any pane shown
      rival.resize(91, 28);
      await stage.settle();
      const held = shown.get(pane)!;
      shown.delete(pane);
      apply();
      shown.set(pane, held);
      apply();
      await turns(2);
      if (sizeOf(latest(pane)) !== wantedOf(pane) || !livePane(pane)) broken.push(`I11 shown again during a waiting repaint: ${screen.state(pane)}, attached at ${sizeOf(latest(pane))}, the rectangle ${wantedOf(pane)}`);
      check("shown again during a waiting repaint");

      // another viewer takes the terminal, and before the repaint is due the line ends: on the next line the pane attaches with its rectangle
      await rival.detach();
      await stage.settle();
      await rival.attach(pane, 100, 30);
      rival.type("r");
      await stage.settle();
      stage.core.restart();
      await stage.settle();
      await reconnect();
      await turns(2);
      if (sizeOf(latest(pane)) !== wantedOf(pane) || stage.core.size(pane) !== wantedOf(pane) || !livePane(pane)) {
        broken.push(`I11 a new line during a waiting repaint: ${screen.state(pane)}, attached at ${sizeOf(latest(pane))}, the terminal at ${stage.core.size(pane)}, the rectangle ${wantedOf(pane)}`);
      }
      check("a new line during a waiting repaint");

      // the stream is dropped as often as the pane re-attaches by itself; shown again, it starts counting anew
      for (let round = 0; round < PANE_REOPEN_LIMIT; round++) {
        drop(latest(pane));
        await stage.settle();
      }
      const kept = shown.get(pane)!;
      shown.delete(pane);
      apply();
      shown.set(pane, kept);
      apply();
      await stage.settle();
      drop(latest(pane));
      await turns(2);
      if (!livePane(pane)) broken.push(`I11 shown again: the pane is ${screen.state(pane)} after one more dropped stream`);
      check("shown again");

      // the core is stopped, and a new one has a terminal at this pane's address whose program asks for focus reports
      stage.core.stop();
      await stage.settle();
      stage.core = new FakeHcCore(options);
      let again = "";
      while (again !== pane) again = stage.core.spawn().address;
      stage.core.setPaint(pane, { body: "\x1b[?1004h" });
      terminals = [pane];
      await reconnect();
      await turns(2);
      const heard = stage.core.program(pane).receivedHex();
      const report = options.features ? "" : "1b5b49";
      if (!livePane(pane) || heard !== report) broken.push(`I6 a new core: the pane is ${screen.state(pane)} and its program heard "${heard}", the focus contract says "${report}"`);
      check("a new core");

      // an answer about a dropped stream arrives after the program ended: it is not used
      before = countOf();
      screen.faults.holdCalls = true;
      drop(latest(pane));
      await stage.settle();
      stage.core.program(pane).exit(3);
      await stage.settle();
      screen.release();
      await stage.settle();
      const ended = screen.panes.view(pane)?.state;
      if (countOf() !== before || ended?.kind !== "Ended" || ended.code !== 3) broken.push(`I11 a late answer: ${screen.state(pane)} and ${countOf() - before} attach(es) after the program ended with 3`);
      check("a late answer");
    }
    // at rest every byte delivered to a pane that still shows a picture was fed
    for (const [emulator, feed] of fedBy) if (open(feed.attach) && !emulator.disposed && feed.next !== feed.attach.received.length) broken.push(`I13 emulator ${emulator.index} was fed ${feed.next} of ${feed.attach.received.length} frames`);
    check("the end");
  } catch (error) {
    // I12 too: nothing the machine does may throw
    throw new Error(`sequence seed ${seed} failed (replay: OVIS_TUI_MODEL_ONLY=${seed}) ${error instanceof Error ? error.message : String(error)}\nsteps: ${trace.join(" > ")}`);
  } finally {
    await stage.close();
  }
}

const PAIR_SIZES = [[80, 24], [100, 30], [110, 35], [120, 40], [90, 28], [60, 20]] as const;
const PAIR_ROUNDS = 3;
/** the shares of second-part sequences with a third screen, and with the core's late order */
const THREE_SHARE = 0.25;
const LATE_SHARE = 0.3;
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const;
const PAIR_STEPS = 7;

interface PairTotals { steps: number; rests: number; attaches: number; repaints: number; unshownAgain: number; inGap: number; sameTurn: number; takes: number; threeScreens: number; late: number; heldEvents: number; weakRests: number; restored: number }

/**
 * Two screens (or three) and a rival viewer on one terminal, with a reference beside the core that says what size the last choosing
 * viewer chose. Which sequences have a third screen or the core's late order is drawn apart from the steps, so that a two-screen
 * sequence without the late order is the same for a seed as before either existed.
 */
async function pair(seed: number, totals: PairTotals): Promise<void> {
  const random = mulberry(seed);
  const chance = (share: number) => random() < share;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const variant = mulberry(seed ^ 0x57_57_57);
  const three = variant() < THREE_SHARE;
  const lateOrder = variant() < LATE_SHARE;
  const held = mulberry(seed ^ 0x1a_7e_1a);
  const options: FakeCoreOptions = chance(0.4) ? { version: "0.1.17", features: FEATURES_0_1_17 } : {};
  const core = new FakeHcCore(lateOrder ? { ...options, late: () => { const hold = held() < 0.5; if (hold) totals.heldEvents++; return hold; } } : options);
  const stage = new Stage(core);
  const t = core.spawn().address;
  const screens: Screen[] = [await stage.screen(), await stage.screen()];
  if (three) screens.push(await stage.screen());
  if (three) totals.threeScreens++;
  if (lateOrder) totals.late++;
  /** the weaker oracle's sequences: what holds there is in the header */
  const weak = three || lateOrder;
  const rival: Rival = stage.rival();
  const headless = `${HEADLESS.cols}x${HEADLESS.rows}`;
  const broken: string[] = [];
  const trace: string[] = [];
  const name = (screen: Screen) => "ABC"[screens.indexOf(screen)]!;
  /** every size a viewer chose with its own rectangle in this sequence: an attach that carried it, the take's RESIZE, the driver's */
  const rectangles = new Set<string>();

  // the test's own account of each screen: its rectangle (null: out of the tab), what its newest attach advertised on the wire (null: none
  // since it was shown), whether its rectangle changed since, so that its next attach has to carry the rectangle (kind (a)), whether it is
  // between its CLOSE and its next attach, and whether its rectangle changed for that CLOSE or inside that gap: then its next attach
  // may carry the rectangle also when the change was undone meanwhile (it has closed, and attaches with what its window is)
  const own = new Map<Screen, { rect: string | null; advertised: string | null; changed: boolean; between: boolean; mayCarry: boolean }>(screens.map((screen) => [screen, { rect: null, advertised: null, changed: false, between: false, mayCarry: false }]));
  /** the attaches of each screen that were taken live */
  const shown = new Set<AttachRecord>();
  const newest = (screen: Screen) => screen.attaches.at(-1);

  // the reference: the core's own size rule (the latest stamp leads, else the newest attach) over every viewer the core's log shows,
  // where a screen's repaint advertises the terminal's size at that moment, or the last one it had while somebody viewed it
  /** `size`: what the reference lets the viewer advertise; `sent`: what its attach or RESIZE really advertised, which the core uses once the viewer's input stamps it */
  interface Viewer { size: string; sent: string; stamp: number | null; attached: number }
  const viewers = new Map<string, Viewer>();
  let ticks = 0;
  let lastViewed: string | null = null;
  const leader = (): Viewer | null => {
    let lead: Viewer | null = null;
    for (const viewer of viewers.values()) if (!lead || (viewer.stamp ?? -1) > (lead.stamp ?? -1) || ((viewer.stamp ?? -1) === (lead.stamp ?? -1) && viewer.attached > lead.attached)) lead = viewer;
    return lead;
  };
  const chosen = (): string | null => leader()?.size ?? null;
  /** per line: what the screen's attach about to reach the core is (noted as the machine asks it), and the attach the core is answering */
  const asking = new Map<number, { repaint: boolean }>();
  const answering = new Map<number, { size: string; sent: string; resumed: boolean }>();
  const see = (entry: FakeEntry): void => {
    if (entry.what === "call" && entry.method === "terminal.attach" && entry.params["terminal"] === t) {
      const asked = asking.get(entry.line);
      asking.delete(entry.line);
      const sent = `${String(entry.params["cols"])}x${String(entry.params["rows"])}`;
      // beside a viewer that drives the terminal the core does not use what a repaint advertises: it counts as it was sent
      const copies = asked?.repaint === true && leader()?.stamp == null;
      answering.set(entry.line, { size: copies ? chosen() ?? lastViewed ?? sent : sent, sent, resumed: entry.params["resumed"] === true });
    } else if (entry.what === "reply" && entry.method === "terminal.attach") {
      const attach = answering.get(entry.line);
      answering.delete(entry.line);
      const channel = (entry.result as { channel?: number } | undefined)?.channel;
      if (attach && channel !== undefined) viewers.set(`${entry.line}:${channel}`, { size: attach.size, sent: attach.sent, stamp: attach.resumed ? null : ++ticks, attached: ++ticks });
    } else if (entry.what === "frame" && entry.from === "viewer") {
      const key = `${entry.line}:${entry.channel}`;
      const viewer = viewers.get(key);
      if (!viewer) return;
      if (entry.kind === FRAME_CLOSE) viewers.delete(key);
      // a viewer whose input stamps it leads with what it really advertised: a repaint's copy of the terminal's size was the reference's
      else if (entry.kind === FRAME_DATA || (entry.kind === FRAME_FOCUS && entry.payload[0] === 1)) Object.assign(viewer, { size: viewer.sent, stamp: ++ticks });
      else if (entry.kind === FRAME_RESIZE && entry.payload.length >= 4) {
        viewer.size = viewer.sent = `${Buffer.from(entry.payload).readUInt16LE(0)}x${Buffer.from(entry.payload).readUInt16LE(2)}`;
        viewer.stamp = ++ticks;
      }
    } else if (entry.what === "event" && entry.type === "size") trace.push(`[${String((entry.data as Record<string, unknown>)["cols"])}x${String((entry.data as Record<string, unknown>)["rows"])}]`);
    lastViewed = chosen() ?? lastViewed;
  };
  const log = core.log as FakeEntry[];
  const push = log.push.bind(log);
  log.push = (...entries: FakeEntry[]) => {
    for (const entry of entries) see(entry);
    return push(...entries);
  };

  for (const screen of screens) {
    screen.hooks.attach = (record) => {
      const mine = own.get(screen)!;
      const size = `${String(record.params["cols"])}x${String(record.params["rows"])}`;
      if (record.params["resumed"] !== true || "observe" in record.params || "resize_notifications" in record.params) broken.push(`I-c ${name(screen)} attached with ${JSON.stringify(record.params)}`);
      if (mine.rect === null) broken.push(`${name(screen)} attached while it shows no pane`);
      // kind (a): the first attach since the pane was shown, or one after its rectangle changed; else a repaint
      const repaint = mine.advertised !== null && !mine.changed && !(mine.mayCarry && size === mine.rect);
      if (!repaint && size !== mine.rect) broken.push(`I8 ${name(screen)}'s attach after a change of its rectangle advertises ${size}, not the rectangle ${mine.rect}`);
      if (!repaint) rectangles.add(size);
      if (repaint && size === headless) broken.push(`I-b ${name(screen)}'s repaint advertises ${headless}, the size of a terminal nobody views`);
      const before = screen.attaches.at(-2);
      // a repaint that follows an attach which was never shown: among them the ones made again at once
      if (repaint && before && !shown.has(before) && before.closeAsked) totals.unshownAgain++;
      asking.set(record.line, { repaint });
      trace.push(`[${name(screen)} ${repaint ? "repaints at" : "attaches with"} ${size}]`);
      Object.assign(mine, { changed: false, between: false, mayCarry: false });
      mine.advertised = size;
      totals.attaches++;
      if (repaint) totals.repaints++;
    };
    // I-c: outside the user's input a screen may update display facts, credit, close, or let go of focus, but never take the size.
    screen.hooks.call = (call: ChannelCall) => {
      if (call.op === "close") Object.assign(own.get(screen)!, { between: true, mayCarry: own.get(screen)!.changed });
      if (call.op === "close" || call.op === "credit" || call.op === "facts") return;
      if (call.text === "FOCUS 0" && own.get(screen)!.rect === null) return;
      if (call.input === null && call.op !== "writeAutomatic") broken.push(`I-c ${name(screen)} sent ${call.text} without the user's input`);
      if (call.op === "resize") {
        if (call.text !== `RESIZE ${own.get(screen)!.rect}`) broken.push(`I-c ${name(screen)} sent ${call.text}, not its rectangle ${own.get(screen)!.rect}`);
        totals.takes++;
      }
    };
  }

  const show = (screen: Screen, rect: string | null): void => {
    const mine = own.get(screen)!;
    if (rect === null) {
      Object.assign(mine, { rect: null, advertised: null, changed: false, between: false, mayCarry: false });
      screen.show();
      return;
    }
    if (rect === mine.rect) return;
    if (mine.between) mine.mayCarry = true;
    // a rectangle that comes back to what the channel advertises leaves nothing to tell the core
    mine.changed = mine.advertised !== null && rect !== mine.advertised;
    mine.rect = rect;
    const [cols, rows] = rect.split("x").map(Number) as [number, number];
    screen.show([t, cols, rows]);
  };
  const type = (screen: Screen): void => {
    const mine = own.get(screen)!;
    if (!screen.type("k")[0]!.sent) return;
    // the take: the channel advertises the rectangle from here on
    mine.advertised = mine.rect;
    if (mine.rect !== null) rectangles.add(mine.rect);
    mine.changed = false;
  };
  const pass = (): void => {
    for (const screen of screens) {
      screen.pass();
      const record = newest(screen);
      if (record && screen.panes.view(t)?.state.kind === "Live") shown.add(record);
    }
  };
  const fire = (): void => {
    const due = screens.filter((screen) => screen.panes.deadlines().has("reattach") && screen.panes.deadlines().get("reattach")! <= stage.clock.now);
    if (due.length >= 2) totals.sameTurn++;
    // two screens in either order; three in any of the six, drawn apart from the steps
    const order = screens.length === 2 ? (chance(0.5) ? screens : [screens[1]!, screens[0]!]) : ORDERS[Math.floor(variant() * ORDERS.length)]!.map((at) => screens[at]!);
    for (const screen of order) screen.fire();
  };
  const size = () => pick(PAIR_SIZES).join("x");
  /** a screen between its CLOSE and its next attach's reply */
  const between = () => screens.some((screen) => { const state = screen.panes.view(t)?.state.kind; return state === "Closing" || state === "Opening"; });
  const rivalActs = async (): Promise<string> => {
    const [cols, rows] = pick(PAIR_SIZES);
    if (between()) totals.inGap++;
    // a viewer that drives the terminal: each screen is already the viewer that only views beside the other
    if (!rival.attached) {
      rectangles.add(`${cols}x${rows}`);
      await rival.attach(t, cols, rows);
      return `the driver attaches ${cols}x${rows}`;
    }
    const kind = random();
    if (kind < 0.45) {
      rectangles.add(`${cols}x${rows}`);
      rival.resize(cols, rows);
      return `the driver resizes ${cols}x${rows}`;
    }
    if (kind < 0.6) {
      rival.type("r");
      return "the driver types";
    }
    await rival.detach();
    return "the driver leaves";
  };
  const windowChanges = (): string => {
    const screen = pick(screens);
    const rect = size();
    if (own.get(screen)!.rect === null) return `${name(screen)} is out of the tab`;
    if (between()) totals.inGap++;
    show(screen, rect);
    return `${name(screen)}'s window ${rect}`;
  };
  const clock = (): string => {
    const ms = pick([0, 50, 149, 150, 150, 151]);
    stage.clock.now += ms;
    fire();
    return `${ms} ms`;
  };

  const steps: [number, () => string | Promise<string>][] = [
    [12, windowChanges],
    [12, clock],
    [5, () => { pass(); return "pass"; }],
    [4, () => { const screen = pick(screens); type(screen); return `${name(screen)} types`; }],
    [8, rivalActs],
    [2, () => {
      const screen = pick(screens);
      const mine = own.get(screen)!;
      if (mine.rect === null) {
        show(screen, size());
        return `${name(screen)} comes back to the tab`;
      }
      show(screen, null);
      return `${name(screen)} leaves the tab`;
    }],
    [4, () => { const screen = pick(screens); screen.faults.holdCloses = true; return `${name(screen)}'s CLOSE answers held`; }],
    [2, () => { const screen = pick(screens); screen.faults.holdReplies = true; return `${name(screen)}'s replies held`; }],
    [5, () => { const screen = pick(screens); screen.release(); return `${name(screen)}'s held answers let go`; }],
  ];
  const total = steps.reduce((sum, [weight]) => sum + weight, 0);
  const draw = () => {
    let at = random() * total;
    return steps.find(([weight]) => (at -= weight) < 0)![1];
  };
  const wire = () => `${core.calls().filter((call) => call.method === "terminal.attach").length} attaches, ${core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind !== 1).length} frames, ${core.events(t, "size").length} size events, the terminal at ${core.size(t)}`;
  const fail = (after: string) => {
    if (broken.length > 0) throw new Error(`after "${after}": ${broken.slice(0, 4).join(" | ")}`);
  };
  /** Nobody acts any more: the wire comes to rest, and the terminal has the size the last choosing viewer chose. */
  const rest = async (label: string, counted = true): Promise<void> => {
    for (const screen of screens) screen.release();
    await stage.settle();
    let still = "";
    for (let turn = 0; turn < 10; turn++) {
      stage.clock.now += 150;
      for (const screen of screens) screen.fire();
      await stage.settle();
      pass();
      await stage.settle();
      if (turn === 4) still = wire();
      if (turn > 4 && wire() !== still) broken.push(`I-d ${label}, turn ${turn} of the quiet tail: ${wire()}, after ${still}`);
    }
    const expected = chosen();
    const actual = core.size(t);
    const told = [...viewers.values()].map((viewer) => `${viewer.size}${viewer.stamp === null ? "" : " (drives)"}`).join(", ");
    // with three screens, or a reply that overtakes an earlier event, and no viewer whose input leads: an older size some viewer chose
    if (weak && expected !== null && leader()?.stamp == null) {
      totals.weakRests++;
      if (!rectangles.has(actual)) broken.push(`I-a (three screens or the late order) ${label}: the terminal rests at ${actual}, a size no viewer chose with its own rectangle (${[...rectangles].join(", ")})`);
    } else if (expected !== null && actual !== expected) broken.push(`I-a ${label}: the terminal rests at ${actual}, and the last choosing viewer chose ${expected} (the reference's viewers: ${told}; the core's: ${core.viewers(t).map((viewer) => `${viewer.cols}x${viewer.rows}`).join(", ")})`);
    if (expected === null && actual !== headless) broken.push(`I-a ${label}: nobody views the terminal and it is at ${actual}`);
    if (expected !== null && actual === headless) broken.push(`I-b ${label}: a viewed terminal rests at ${headless}`);
    for (const screen of screens) {
      if (own.get(screen)!.rect === null) continue;
      const view = screen.panes.view(t);
      if (view?.state.kind !== "Live") broken.push(`${label}: ${name(screen)}'s pane is ${screen.state(t)} at rest`);
      else if (!view.actual || `${view.actual.cols}x${view.actual.rows}` !== actual) broken.push(`I10 ${label}: ${name(screen)} holds ${JSON.stringify(view.actual)} and the terminal is at ${actual}`);
    }
    if (counted) totals.rests++;
    trace.push("rest");
    fail(label);
  };
  /** The next key in a screen gives its rectangle back: RESIZE with it where the channel advertises another size, then the key. */
  const restores = async (): Promise<void> => {
    const ready = screens.filter((screen) => own.get(screen)!.rect !== null && screen.panes.view(t)?.state.kind === "Live");
    if (ready.length === 0) return;
    const screen = ready[Math.floor(variant() * ready.length)]!;
    const rect = own.get(screen)!.rect!;
    const view = screen.view(t);
    const resize = view.advertised && `${view.advertised.cols}x${view.advertised.rows}` === rect ? [] : [`RESIZE ${rect}`];
    const from = screen.calls.length;
    type(screen);
    const made = screen.calls.slice(from).filter((call) => call.op !== "credit" && call.text !== "FOCUS 1").map((call) => call.text.startsWith("DATA ") ? "DATA" : call.text);
    if (JSON.stringify(made) !== JSON.stringify([...resize, "DATA"])) broken.push(`the next key in ${name(screen)} sent ${made.join(", ")}, not ${[...resize, "DATA"].join(", ")}`);
    trace.push(`${name(screen)} types`);
    await rest("after the next key", false);
    if (core.size(t) !== rect) broken.push(`the next key in ${name(screen)}: the terminal rests at ${core.size(t)}, not its rectangle ${rect}`);
    totals.restored++;
    fail("the next key");
  };

  try {
    for (const screen of screens) {
      screen.panes.focus(t);
      show(screen, size());
    }
    await stage.settle();
    pass();
    await stage.settle();
    for (let round = 0; round < PAIR_ROUNDS; round++) {
      for (let step = 0; step < PAIR_STEPS; step++) {
        const did = await draw()();
        trace.push(did);
        // one step in three runs into the next with nothing settled in between
        if (!chance(0.33)) await stage.settle();
        totals.steps++;
        fail(did);
      }
      await stage.settle();
      fail("the steps");
      await rest(`round ${round + 1}`);
    }
    if (weak) await restores();
  } catch (error) {
    throw new Error(`two-screen sequence seed ${seed} failed (replay: OVIS_TUI_MODEL_PAIR=${seed}) ${error instanceof Error ? error.message : String(error)}\nsteps: ${trace.join(" > ")}`);
  } finally {
    await stage.close();
  }
}

it(`${PAIR ? 1 : PAIRS} seeded sequences of two screens on one terminal rest at the size the last viewer chose (seed ${PAIR ?? SEED})`, async () => {
  const totals: PairTotals = { steps: 0, rests: 0, attaches: 0, repaints: 0, unshownAgain: 0, inGap: 0, sameTurn: 0, takes: 0, threeScreens: 0, late: 0, heldEvents: 0, weakRests: 0, restored: 0 };
  const seeds = PAIR ? [Number(PAIR)] : Array.from({ length: PAIRS }, (_, index) => SEED * 1_000_003 + index);
  for (const seed of seeds) await pair(seed, totals);
  console.log(`pane model, two screens: seed ${PAIR ?? SEED}, ${seeds.length} sequences, ${JSON.stringify(totals)}`);
  // the runs did reach what the rule is about: repaints, choices inside a gap, both screens due in one turn
  if (!PAIR) {
    expect(totals.rests).toBe(PAIRS * PAIR_ROUNDS);
    expect(totals.repaints).toBeGreaterThan(PAIRS);
    expect(totals.inGap).toBeGreaterThan(PAIRS / 10);
    expect(totals.sameTurn).toBeGreaterThan(PAIRS / 10);
    expect(totals.unshownAgain).toBeGreaterThan(0);
    expect([totals.threeScreens, totals.late, totals.heldEvents, totals.weakRests, totals.restored].every((count) => count > 0)).toBe(true);
  }
}, 1_500_000);

it(`${ONLY ? 1 : SEQUENCES} seeded sequences keep every invariant after every step (seed ${ONLY ?? SEED})`, async () => {
  const totals: Totals = { steps: 0, attaches: 0, lives: 0, accepted: 0, refused: 0, takes: 0, reattaches: 0, lines: 0, settled: 0, handedBack: 0, deep: 0 };
  const seeds = ONLY ? [Number(ONLY)] : Array.from({ length: SEQUENCES }, (_, index) => SEED * 100_003 + index);
  // every sequence ends with the settle probes on the two size waits; every fourth goes on through the heavy ones
  for (const [index, seed] of seeds.entries()) await sequence(seed, totals, ONLY !== undefined || index % 4 === 0);
  console.log(`pane model: seed ${ONLY ?? SEED}, ${seeds.length} sequences, ${JSON.stringify(totals)}`);
  // the runs did reach what the invariants are about
  if (!ONLY) {
    expect(totals.steps).toBe(SEQUENCES * STEPS);
    expect(totals.lives).toBeGreaterThan(SEQUENCES * 2);
    expect(totals.accepted).toBeGreaterThan(SEQUENCES * 2);
    expect(totals.refused).toBeGreaterThan(SEQUENCES * 2);
    expect(totals.takes).toBeGreaterThan(SEQUENCES / 20);
    expect(totals.reattaches).toBeGreaterThan(SEQUENCES);
    expect(totals.settled).toBeGreaterThan(SEQUENCES * 0.9);
    expect(totals.handedBack).toBeGreaterThan(SEQUENCES * 0.2);
    expect(totals.deep).toBeGreaterThan(SEQUENCES * 0.2);
  }
}, 1_500_000);
