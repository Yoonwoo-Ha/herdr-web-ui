import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, encodeFrame, FRAME_AUTOMATIC_INPUT, FRAME_CLOSE, FRAME_DATA, FRAME_RESIZE, HcConnection, HcError, makeFrameReader } from "./connection.ts";
import { CREDIT_WINDOW, FakeHcCore, type FakeCoreOptions, type FakeTransport, FEATURES_0_1_17, FEATURES_0_1_18 } from "./core.fake.ts";
import { connectCoreSocket } from "./socket-transport.ts";
import type { TerminalAttachParams } from "./hc-api.generated.ts";

const WAIT_MS = 2000;
const CAN = "\x18";
const hex = (text: string) => Buffer.from(text, "latin1").toString("hex");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

interface Waiter { check: () => boolean; resolve: () => void }

/**
 * A fake core and the viewers a test drives, each on a line of its own (as two screens would be).
 * Frames reach the fake as they are written, so a size is read right after the write that set it.
 */
function scene(options: FakeCoreOptions = {}) {
  const core = new FakeHcCore(options);
  const waiters = new Set<Waiter>();
  const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  const until = (label: string, check: () => boolean): Promise<void> => {
    if (check()) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`no ${label} within ${WAIT_MS}ms`)); }, WAIT_MS);
    waiters.add(waiter);
    return promise;
  };
  const lines: HcConnection[] = [];
  /** a line of its own (opened again after the fake's restart), and the transport under it, for frames `HcConnection` would not send */
  const line = () => {
    let transport: FakeTransport | null = null;
    const hc = new HcConnection(() => (transport = core.transport()));
    lines.push(hc);
    return { hc, transport: () => transport! };
  };
  cleanups.push(() => { for (const hc of lines) hc.close(); });
  const control = line().hc;
  interface View { hc: HcConnection; transport: () => FakeTransport; channel: Channel | null; bytes: string; closed: Record<string, unknown> | null | undefined; reply: Record<string, unknown> | null }
  const views = new Map<string, View>();
  const view = (name: string): View => {
    let found = views.get(name);
    if (!found) views.set(name, found = { ...line(), channel: null, bytes: "", closed: undefined, reply: null });
    return found;
  };
  const on = (name: string): Channel => {
    const channel = views.get(name)?.channel;
    if (!channel) throw new Error(`${name} is not attached`);
    return channel;
  };
  const s = {
    core,
    until,
    /** a test's own stream handlers call this, so a bounded wait sees what they kept */
    wake,
    control,
    async run(params: { argv?: string[]; size?: { cols: number; rows: number }; labels?: Record<string, string> } = {}): Promise<string> {
      return (await control.call("terminal.run", { argv: ["sh"], ...params })).address;
    },
    async attach(name: string, terminal: string, cols: number, rows: number, extra: Partial<TerminalAttachParams> = {}, credit: "auto" | "manual" = "auto") {
      const v = view(name);
      v.bytes = "";
      v.closed = undefined;
      const opened = await v.hc.open("terminal.attach", { terminal, cols, rows, ...extra }, {
        onData: (payload) => { v.bytes += Buffer.from(payload).toString("latin1"); wake(); },
        onClose: (reason) => { v.closed = reason; wake(); },
        credit,
      });
      v.channel = opened.channel;
      v.reply = opened.result as unknown as Record<string, unknown>;
      return opened;
    },
    async detach(name: string) {
      await on(name).close();
      view(name).channel = null;
    },
    data: (name: string, text: string) => on(name).write(text),
    resize: (name: string, cols: number, rows: number) => on(name).resize(cols, rows),
    focus: (name: string, focused: boolean) => on(name).focus(focused),
    facts: (name: string) => on(name).facts({ fg: "#ffffff", bg: "#000000" }),
    /** a kind 6 frame as it is, negotiated or not (`writeAutomatic` would fall back to DATA) */
    automatic: (name: string, text: string) => view(name).transport().write(encodeFrame(on(name).id, FRAME_AUTOMATIC_INPUT, text)),
    /** the fake's number for this viewer's current attach */
    viewer: (name: string) => core.viewers().find((viewer) => viewer.line === view(name).transport().line && viewer.channel === on(name).id)!.viewer,
    bytes: (name: string) => view(name).bytes,
    closed: (name: string) => view(name).closed,
    reply: (name: string) => view(name).reply!,
    size: (terminal: string) => core.size(terminal),
  };
  return s;
}

/** one table row of the size rules: what the viewers do, then the size */
interface SizeCase { name: string; steps: (s: ReturnType<typeof scene>, t: string) => Promise<void> | void; size: string }

async function runCases(cases: SizeCase[]): Promise<void> {
  const results: Record<string, string> = {};
  for (const row of cases) {
    const s = scene();
    const t = await s.run();
    await row.steps(s, t);
    results[row.name] = s.size(t);
  }
  expect(results).toEqual(Object.fromEntries(cases.map((row) => [row.name, row.size])));
}

describe("fake herdr-core: size rules (probe c, both versions)", () => {
  it("an agent report is available to a viewer subscribing after the pane reported", async () => {
    const s = scene();
    const terminal = await s.run();
    s.core.reportStatus(terminal, { state: "blocked", app: "claude" });
    expect((await s.control.call("terminal.get", { terminal })).status).toEqual({ state: "blocked", app: "claude" });
  });

  it("a report that leaves working ends a turn: the record counts it and a turn event follows that status", async () => {
    const s = scene();
    const terminal = await s.run();
    for (const state of ["working", "idle", "working", "blocked", "idle"]) s.core.reportStatus(terminal, { state, app: "claude" });
    expect(s.core.events(terminal, "status", "turn")).toEqual(["status", "status", "turn", "status", "status", "turn", "status"]);
    expect((await s.control.call("terminal.get", { terminal })).turn).toBe(2);
  });

  it("F1 latest stamp wins", async () => {
    await runCases([
      { name: "the later of two stamped viewers", size: "80x24", steps: async (s, t) => { await s.attach("A", t, 120, 40); await s.attach("B", t, 80, 24); } },
      { name: "a stamped viewer that types again", size: "120x40", steps: async (s, t) => { await s.attach("A", t, 120, 40); await s.attach("B", t, 80, 24); s.data("A", "a"); } },
      { name: "a stamped viewer beside a newer resumed one", size: "120x40", steps: async (s, t) => { await s.attach("A", t, 120, 40); await s.attach("B", t, 80, 24, { resumed: true }); } },
      { name: "no stamp at all: the newest attach", size: "80x24", steps: async (s, t) => { await s.attach("A", t, 120, 40, { resumed: true }); await s.attach("B", t, 80, 24, { resumed: true }); } },
      { name: "a resumed viewer that types", size: "120x40", steps: async (s, t) => { await s.attach("A", t, 120, 40, { resumed: true }); await s.attach("B", t, 80, 24, { resumed: true }); s.data("A", "a"); } },
      { name: "an observer never leads", size: "200x120", steps: async (s, t) => { await s.attach("A", t, 120, 40, { observe: true }); } },
    ]);
  });

  it("F2 what is a stamp and what is not", async () => {
    // A drives at 120x40; B acts at 80x24 beside the decoy C (resumed, 70x20, attached after B);
    // A leaves: a stamped B leads with its advertised size, an unstamped one loses to the newer C
    const attachRow = (extra: Partial<TerminalAttachParams>) => async (s: ReturnType<typeof scene>, t: string) => {
      await s.attach("A", t, 120, 40);
      s.data("A", "a");
      await s.attach("B", t, 80, 24, extra);
      await s.attach("C", t, 70, 20, { resumed: true });
      await s.detach("A");
    };
    const frameRow = (act: (s: ReturnType<typeof scene>) => void) => async (s: ReturnType<typeof scene>, t: string) => {
      await s.attach("A", t, 120, 40);
      s.data("A", "a");
      await s.attach("B", t, 80, 24, { resumed: true });
      await s.attach("C", t, 70, 20, { resumed: true });
      act(s);
      await s.detach("A");
    };
    await runCases([
      { name: "attach without resumed", size: "80x24", steps: attachRow({}) },
      { name: "attach with resumed", size: "70x20", steps: attachRow({ resumed: true }) },
      { name: "attach with resumed and display", size: "70x20", steps: attachRow({ resumed: true, display: { fg: "#ffffff" } }) },
      { name: "attach as an observer", size: "70x20", steps: attachRow({ observe: true }) },
      { name: "DATA", size: "80x24", steps: frameRow((s) => s.data("B", "b")) },
      { name: "RESIZE to its advertised size", size: "80x24", steps: frameRow((s) => s.resize("B", 80, 24)) },
      { name: "RESIZE to a new size", size: "90x28", steps: frameRow((s) => s.resize("B", 90, 28)) },
      { name: "FOCUS 1", size: "80x24", steps: frameRow((s) => s.focus("B", true)) },
      { name: "FOCUS 0", size: "70x20", steps: frameRow((s) => s.focus("B", false)) },
      { name: "FACTS", size: "70x20", steps: frameRow((s) => s.facts("B")) },
      { name: "AUTOMATIC_INPUT", size: "70x20", steps: frameRow((s) => s.automatic("B", "\x1b[I")) },
    ]);
  });

  it("F3 followers get one size event and no RESIZE", async () => {
    const s = scene();
    const t = await s.run();
    const program = s.core.program(t);
    program.onResize = (cols, rows) => program.output(`SIZE ${cols}x${rows}\r\n`);
    await s.attach("A", t, 120, 40);
    s.data("A", "a");
    await s.attach("B", t, 80, 24, { resumed: true });
    expect(s.size(t)).toBe("120x40");
    const before = s.core.log.length;
    const sizes = s.core.events(t, "size").length;
    s.resize("A", 100, 30);
    expect(s.size(t)).toBe("100x30");
    expect(s.core.events(t, "size").slice(sizes)).toEqual(["size 100x30"]);
    expect(s.core.log.slice(before).filter((entry) => entry.what === "frame" && entry.from === "core" && entry.kind === FRAME_RESIZE)).toEqual([]);
    await s.until("B's bytes for the new grid", () => s.bytes("B").includes("SIZE 100x30"));
    expect(s.bytes("B").slice(s.bytes("B").indexOf("\x1b[?9001l"))).not.toContain(CAN);
    expect(program.sizes).toEqual(["200x120", "120x40", "100x30"]);
  });

  it("F4 detach recomputes", async () => {
    const s = scene();
    const t = await s.run();
    await s.attach("A", t, 120, 40);
    await s.attach("B", t, 80, 24, { resumed: true });
    expect(s.size(t)).toBe("120x40");
    await s.detach("A");
    expect(s.size(t)).toBe("80x24");
    await s.detach("B");
    expect(s.size(t)).toBe("200x120");
    expect(s.core.events(t, "size")).toEqual(["size 120x40", "size 80x24", "size 200x120"]);
  });

  it("nobody viewing is 200x120", async () => {
    const s = scene();
    const t = await s.run();
    const sized = await s.run({ size: { cols: 100, rows: 30 } });
    expect([s.size(t), s.size(sized)]).toEqual(["200x120", "100x30"]);
    await s.attach("A", sized, 80, 24, { resumed: true });
    await s.detach("A");
    // `size` at run is only where the terminal starts
    expect(s.size(sized)).toBe("200x120");
    expect(s.core.events(sized, "size")).toEqual(["size 80x24", "size 200x120"]);
  });

  it("two idle resumed viewers: the newest wins; a repaint attach at the current size changes nothing and sends no size event", async () => {
    const s = scene();
    const t = await s.run();
    await s.attach("A", t, 80, 24, { resumed: true });
    await s.attach("B", t, 120, 40, { resumed: true });
    expect(s.size(t)).toBe("120x40");
    const events = s.core.events(t).length;
    const toB = s.core.framesTo(t, { viewer: s.viewer("B") }).length;
    await s.detach("A");
    await s.attach("A", t, 120, 40, { resumed: true });
    expect(s.reply("A")["terminal"]).toMatchObject({ cols: 120, rows: 40 });
    expect(s.size(t)).toBe("120x40");
    expect(s.core.events(t).slice(events)).toEqual([]);
    expect(s.core.framesTo(t, { viewer: s.viewer("B") }).slice(toB)).toEqual([]);
    // the take: RESIZE then DATA gives the size with exactly one size event
    const sizes = s.core.events(t, "size").length;
    s.resize("A", 80, 24);
    s.data("A", "k");
    expect(s.size(t)).toBe("80x24");
    expect(s.core.events(t, "size").slice(sizes)).toEqual(["size 80x24"]);
    const after = s.core.events(t, "size").length;
    // B's own repaint attach at the terminal's current size: nothing changes
    await s.detach("B");
    await s.attach("B", t, 80, 24, { resumed: true });
    expect(s.size(t)).toBe("80x24");
    expect(s.core.events(t, "size")).toHaveLength(after);
  });

  it("the event for a size an attach set follows that attach's reply: behind its first bytes, or ahead of them on a line whose event stream is still silent", async () => {
    const s = scene();
    const t = await s.run();
    /** what the fake sent from `since` on, in order: attach replies, the bytes of attach streams, size events */
    const order = (since: number) => s.core.log.slice(since).flatMap((entry) => {
      if (entry.what === "reply") return entry.method === "terminal.attach" ? ["reply"] : [];
      if (entry.what === "frame") return entry.from === "core" && entry.kind === FRAME_DATA && entry.terminal !== null ? ["bytes"] : [];
      if (entry.what !== "event" || entry.type !== "size") return [];
      const { cols, rows } = entry.data as { cols: number; rows: number };
      return [`size ${cols}x${rows}`];
    });
    let from = s.core.log.length;
    await s.attach("A", t, 100, 30, { resumed: true });
    // the reply names the size the attach set; the event that tells of it comes behind the first paint
    expect([s.reply("A")["terminal"], order(from)]).toMatchObject([{ cols: 100, rows: 30 }, ["reply", "bytes", "size 100x30"]]);
    from = s.core.log.length;
    await s.attach("B", t, 120, 40);
    expect(order(from)).toEqual(["reply", "bytes", "size 120x40"]);
    // an attach that sets no size is followed by no event, and one that follows another viewer's change has that event ahead of its reply
    from = s.core.log.length;
    s.resize("B", 90, 28);
    await s.attach("C", t, 70, 20, { resumed: true });
    expect(order(from)).toEqual(["size 90x28", "reply", "bytes"]);
    // a line that subscribed and has heard no event yet (a screen's first attach): the event comes ahead of the first bytes, once
    const fresh = new HcConnection(() => s.core.transport());
    cleanups.push(() => fresh.close());
    const other = await s.run();
    await fresh.open("events.subscribe", { terminal: other }, { onData: () => {}, onClose: () => {} });
    const quiet = { onData: () => {}, onClose: () => {} };
    from = s.core.log.length;
    const first = await fresh.open("terminal.attach", { terminal: other, cols: 100, rows: 30, resumed: true }, quiet);
    expect(order(from)).toEqual(["reply", "size 100x30", "bytes"]);
    await first.channel.close();
    from = s.core.log.length;
    await fresh.open("terminal.attach", { terminal: other, cols: 110, rows: 35, resumed: true }, quiet);
    expect(order(from)).toEqual(["reply", "bytes", "size 110x35"]);
  });

  it("late: the event of a change made just before a line's attach comes behind that attach's reply and first bytes, ahead of its own event", async () => {
    let hold = false;
    const core = new FakeHcCore({ late: () => hold });
    const quiet = { onData: () => {}, onClose: () => {} };
    const open = () => {
      let transport: FakeTransport | null = null;
      const hc = new HcConnection(() => (transport = core.transport()));
      cleanups.push(() => hc.close());
      return { hc, line: () => transport!.line };
    };
    const [a, r, s] = [open(), open(), open()];
    const t = (await a.hc.call("terminal.run", { argv: ["sh"] })).address;
    await a.hc.open("events.subscribe", { terminal: t }, quiet);
    // the other viewer's line is open before the race, so that its attach leaves in the very turn it is asked
    await r.hc.call("terminal.list", {});
    /** what A's line was sent from `since` on, in order: its attach replies, its streams' first bytes, the size events */
    const heard = (since: number) => core.log.slice(since).flatMap((entry) => {
      if (entry.what === "reply") return entry.line === a.line() && entry.method === "terminal.attach" ? ["reply"] : [];
      if (entry.what !== "frame" || entry.from !== "core" || entry.line !== a.line() || entry.kind !== FRAME_DATA) return [];
      if (entry.terminal !== null) return ["bytes"];
      return [...Buffer.from(entry.payload).toString().matchAll(/"data":\{"cols":(\d+),"rows":(\d+)\}[^\n]*"type":"size"/g)].map((match) => `size ${match[1]}x${match[2]}`);
    }).filter((entry, at, all) => entry !== "bytes" || all[at - 1] !== "bytes");
    // an idle viewer that stays, and A attached beside it
    await s.hc.open("terminal.attach", { terminal: t, cols: 100, rows: 30, resumed: true }, quiet);
    let mine = (await a.hc.open("terminal.attach", { terminal: t, cols: 100, rows: 30, resumed: true }, quiet)).channel;
    const meet = async () => {
      await mine.close();
      const from = core.log.length;
      // written in one turn: another viewer's attach with 120x40, then A's with 100x30
      const theirs = r.hc.open("terminal.attach", { terminal: t, cols: 120, rows: 40, resumed: true }, quiet);
      const own = a.hc.open("terminal.attach", { terminal: t, cols: 100, rows: 30, resumed: true }, quiet);
      mine = (await own).channel;
      await (await theirs).channel.close();
      return heard(from);
    };
    // by default the other attach's event is out before A's reply
    expect(await meet()).toEqual(["size 120x40", "reply", "bytes", "size 100x30"]);
    hold = true;
    expect(await meet()).toEqual(["reply", "bytes", "size 120x40", "size 100x30"]);
    // a held event with no frame of its line behind it goes out as the event loop turns, and a later one waits behind it, held or not
    const from = core.log.length;
    core.emit("size", t, { cols: 90, rows: 28 });
    hold = false;
    core.emit("size", t, { cols: 91, rows: 28 });
    expect([core.heldEvents(), heard(from)]).toEqual([2, []]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect([core.heldEvents(), heard(from)]).toEqual([0, ["size 90x28", "size 91x28"]]);
  });

  it("any RESIZE is a stamp, also at the current size", async () => {
    const s = scene();
    const t = await s.run();
    await s.attach("A", t, 120, 40);
    s.data("A", "a");
    await s.attach("B", t, 80, 24, { resumed: true });
    const events = s.core.events(t, "size").length;
    s.resize("B", 120, 40);
    expect(s.size(t)).toBe("120x40");
    expect(s.core.events(t, "size")).toHaveLength(events);
    await s.attach("D", t, 70, 20, { resumed: true });
    await s.detach("A");
    // B stamped with its RESIZE leads (120x40), not the newer unstamped D (70x20)
    expect(s.size(t)).toBe("120x40");
    s.resize("B", 120, 40);
    s.resize("D", 70, 20);
    expect(s.size(t)).toBe("70x20");
  });
});

describe("fake herdr-core: focus and automatic input", () => {
  it("focus delivery", async () => {
    const s = scene();
    const t = await s.run();
    const program = s.core.program(t);
    program.output("\x1b[?1004hREADY\r\n");
    await s.attach("A", t, 120, 40);
    s.data("A", "a");
    await s.attach("B", t, 80, 24, { resumed: true });
    await s.attach("C", t, 80, 24, { resumed: true });
    // FOCUS 0 from a viewer that never sent FOCUS 1 still reaches a 1004 program, and takes nothing
    s.focus("C", false);
    expect(s.size(t)).toBe("120x40");
    s.focus("B", true);
    expect(s.size(t)).toBe("80x24");
    s.focus("B", false);
    expect(program.receivedHex()).toBe(hex("a\x1b[O\x1b[I\x1b[O"));
    // without 1004: FOCUS gives the program nothing (and still takes the size); kind 6 reaches it as it is
    const plain = await s.run();
    const quiet = s.core.program(plain);
    await s.attach("P", plain, 120, 40);
    s.data("P", "a");
    await s.attach("Q", plain, 80, 24, { resumed: true });
    s.automatic("Q", "\x1b[I");
    expect(s.size(plain)).toBe("120x40");
    s.focus("Q", true);
    expect(s.size(plain)).toBe("80x24");
    expect(quiet.receivedHex()).toBe(hex("a\x1b[I"));
  });

  it("kind 6 without the feature is dropped", async () => {
    const old = scene({ version: "0.1.17", features: FEATURES_0_1_17 });
    expect((await old.control.hello()).features).not.toContain("automatic_input");
    const t = await old.run();
    await old.attach("A", t, 120, 40);
    old.data("A", "a");
    const { result, channel } = await old.attach("B", t, 80, 24, { resumed: true });
    expect("automatic_input" in result).toBe(false);
    expect(channel.automaticInput).toBe(false);
    old.automatic("B", "\x1b[I");
    expect(old.size(t)).toBe("120x40");
    expect(old.core.program(t).receivedHex()).toBe(hex("a"));
    expect(old.core.sentOn(t, { kinds: [FRAME_AUTOMATIC_INPUT] })).toEqual(["AUTOMATIC_INPUT 1b5b49"]);
    // writeAutomatic falls back to DATA there, which is typing and takes the size
    channel.writeAutomatic("\x1b[I");
    expect(old.size(t)).toBe("80x24");

    const current = scene({ features: FEATURES_0_1_18 });
    const u = await current.run();
    await current.attach("A", u, 120, 40);
    current.data("A", "a");
    const confirmed = await current.attach("B", u, 80, 24, { resumed: true });
    expect(confirmed.result.automatic_input).toBe(true);
    expect(confirmed.channel.automaticInput).toBe(true);
    confirmed.channel.writeAutomatic("\x1b[I");
    expect(current.size(u)).toBe("120x40");
    expect(current.core.program(u).receivedHex()).toBe(hex("a\x1b[I"));
  });
});

describe("fake herdr-core: the attach stream", () => {
  it("mark inside a frame", async () => {
    const s = scene();
    const t = await s.run();
    s.core.setPaint(t, { body: "\x1b[Hhello", mark: "l", after: "\r\x1b[Kprompt$ ", split: false });
    await s.attach("A", t, 80, 24, { resumed: true });
    expect(s.core.dataTo(t)).toEqual([`${CAN}\x1b[Hhello\x1b[0m\x1b[?9001l\r\x1b[Kprompt$ `]);
    s.core.setPaint(t, { mark: "h", split: true });
    await s.attach("B", t, 80, 24, { resumed: true });
    expect(s.core.dataTo(t).slice(1)).toEqual([`${CAN}\x1b[Hhello\x1b[0m\x1b[?9001h`, "\r\x1b[Kprompt$ "]);
    await s.until("A's whole paint", () => s.bytes("A").endsWith("prompt$ "));
  });

  it("credit window", async () => {
    const s = scene();
    const t = await s.run();
    const { channel } = await s.attach("A", t, 80, 24, { resumed: true }, "manual");
    const paint = s.core.dataTo(t).join("").length;
    s.core.program(t).output("x".repeat(300 * 1024));
    const held = () => s.core.dataTo(t).join("").length;
    expect(held()).toBe(CREDIT_WINDOW);
    expect(s.core.dataTo(t).every((chunk) => chunk.length <= 16 * 1024)).toBe(true);
    // the program ends while output is held: its CLOSE waits behind that output
    s.core.program(t).exit(0);
    expect(s.core.log.filter((entry) => entry.what === "frame" && entry.from === "core" && entry.kind === FRAME_CLOSE)).toEqual([]);
    channel.credit(10_000);
    expect(held()).toBe(CREDIT_WINDOW + 10_000);
    expect(s.core.credited(t)).toBe(10_000);
    channel.credit(paint + 300 * 1024);
    expect(held()).toBe(paint + 300 * 1024);
    await s.until("the CLOSE after the last byte", () => s.closed("A") !== undefined);
    expect(s.bytes("A")).toHaveLength(paint + 300 * 1024);
    expect(s.closed("A")).toMatchObject({ reason: "exited", exit_code: 0 });
  });

  it("close payloads", async () => {
    const s = scene();
    const ends: Record<string, unknown> = {};
    const exited = await s.run();
    await s.attach("A", exited, 80, 24);
    s.core.program(exited).output("done\r\n");
    s.core.program(exited).exit(3);
    await s.until("CLOSE after exit", () => s.closed("A") !== undefined);
    expect(s.bytes("A")).toEndWith("done\r\n");
    ends["exited"] = s.closed("A");
    expect(s.core.events(exited, "finished")).toHaveLength(1);

    const killed = await s.run();
    await s.attach("A", killed, 80, 24);
    const record = await s.control.call("terminal.kill", { terminal: killed });
    expect(record).toMatchObject({ state: "finished", reason: "killed", signal: 1, exit_code: null });
    await s.until("CLOSE after kill", () => s.closed("A") !== undefined);
    ends["killed"] = s.closed("A");

    const lost = await s.run();
    await s.attach("A", lost, 80, 24);
    s.core.lose(lost);
    await s.until("CLOSE after loss", () => s.closed("A") !== undefined);
    ends["lost"] = s.closed("A");
    await expect(s.attach("B", lost, 80, 24)).rejects.toMatchObject({ kind: "unavailable" });
    s.core.restartTerminal(lost);
    await s.attach("B", lost, 80, 24, { resumed: true });

    const mine = await s.run();
    await s.attach("C", mine, 80, 24);
    await s.detach("C");
    ends["own close"] = s.closed("C");

    const stamp = expect.any(Number);
    expect(ends).toEqual({
      exited: { exit_code: 3, finished_ms: stamp, reason: "exited", signal: null },
      killed: { exit_code: null, finished_ms: stamp, reason: "killed", signal: 1 },
      lost: { exit_code: null, finished_ms: null, reason: "signaled", signal: 9 },
      // our own CLOSE is answered with an empty one, which the line reports as no reason
      "own close": null,
    });
    expect(s.core.events(lost, "lost", "restarted")).toEqual(["lost", "restarted"]);
    // the finished event goes out before the CLOSE
    const order = s.core.log.filter((entry) => (entry.what === "event" && entry.type === "finished" && entry.terminal === exited) || (entry.what === "frame" && entry.from === "core" && entry.kind === FRAME_CLOSE && entry.terminal === exited));
    expect(order.map((entry) => entry.what)).toEqual(["event", "frame"]);
  });

  it("a stopped core closes each attach with server_stop, then says finished, then ends its lines", async () => {
    const s = scene();
    const t = await s.run();
    const idle = await s.run();
    await s.attach("A", t, 80, 24, { resumed: true });
    let ended = false;
    await s.control.open("events.subscribe", {}, { onData: () => {}, onClose: (reason) => { ended = reason?.["reason"] === "connection_lost"; s.wake(); } });
    s.core.stop();
    await s.until("the CLOSE of the attach", () => s.closed("A") !== undefined);
    await s.until("the end of the control line", () => ended);
    expect(s.closed("A")).toEqual({ exit_code: null, finished_ms: expect.any(Number), reason: "server_stop", signal: 1 });
    // the reverse of a program's own end: the stream's CLOSE goes out before the finished event
    const order = s.core.log.filter((entry) => (entry.what === "event" && entry.type === "finished" && entry.terminal === t) || (entry.what === "frame" && entry.from === "core" && entry.kind === FRAME_CLOSE && entry.terminal === t));
    expect(order.map((entry) => entry.what)).toEqual(["frame", "event"]);
    expect(s.core.events(idle, "finished")).toEqual(["finished"]);
    expect([s.core.terminal(t), s.core.terminal(idle)].map((record) => [record.state, record.reason, record.signal])).toEqual([["finished", "server_stop", 1], ["finished", "server_stop", 1]]);
    // the event stream got no CLOSE frame of its own: it ended with its line
    expect(s.core.log.filter((entry) => entry.what === "frame" && entry.from === "core" && entry.kind === FRAME_CLOSE && entry.terminal === null)).toEqual([]);
  });

  it("records every frame of a terminal, and proves nothing was sent on another", async () => {
    const s = scene();
    const t = await s.run();
    const other = await s.run();
    await s.attach("A", t, 120, 40, { resumed: true });
    await s.attach("B", other, 80, 24, { resumed: true });
    s.data("A", "a");
    s.resize("A", 100, 30);
    s.focus("A", true);
    s.facts("A");
    s.automatic("A", "\x1b[I");
    expect(s.core.sentOn(t)).toEqual(["DATA 61", "RESIZE 100x30", "FOCUS 1", "FACTS {\"fg\":\"#ffffff\",\"bg\":\"#000000\"}", "AUTOMATIC_INPUT 1b5b49"]);
    expect(s.core.sentOn(other)).toEqual([]);
    expect(s.core.calls().map((call) => call.method).filter((method) => method !== "hello")).toEqual(["terminal.run", "terminal.run", "terminal.attach", "terminal.attach"]);
  });
});

describe("fake herdr-core: documents", () => {
  it("conflict", async () => {
    const s = scene();
    expect(await s.control.call("doc.get", { name: "ovis-layout" })).toEqual({ value: null, version: 0 });
    expect(await s.control.call("doc.set", { name: "ovis-layout", value: { a: 1 }, version: 0 })).toEqual({ version: 1 });
    await expect(s.control.call("doc.set", { name: "ovis-layout", value: { a: 2 }, version: 0 })).rejects.toMatchObject({ kind: "conflict" });
    // two other writers come first: each write at the version just read fails, as with hc
    s.core.conflictNext(2);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { version } = await s.control.call("doc.get", { name: "ovis-layout" });
      await expect(s.control.call("doc.set", { name: "ovis-layout", value: { a: 3 }, version })).rejects.toMatchObject({ kind: "conflict" });
    }
    const { version } = await s.control.call("doc.get", { name: "ovis-layout" });
    expect(version).toBe(3);
    expect(await s.control.call("doc.set", { name: "ovis-layout", value: null, version })).toEqual({ version: 4 });
    expect(await s.control.call("doc.get", { name: "ovis-layout" })).toEqual({ value: null, version: 4 });
    await expect(s.control.call("doc.get", { name: "Bad Name!" })).rejects.toMatchObject({ kind: "invalid_params" });
    expect(s.core.events(null, "doc")).toEqual(["doc ovis-layout@1", "doc ovis-layout@2", "doc ovis-layout@3", "doc ovis-layout@4"]);
  });

  it("herdr-app refused", async () => {
    const s = scene();
    await expect(s.control.call("doc.set", { name: "herdr-app", value: { spaces: [] }, version: 0 })).rejects.toBeInstanceOf(HcError);
    expect(s.core.herdrAppWrites).toEqual([{ name: "herdr-app", value: { spaces: [] }, version: 0 }]);
    expect(await s.control.call("doc.get", { name: "herdr-app" })).toEqual({ value: null, version: 0 });
    expect(s.core.events(null, "doc")).toEqual([]);
  });
});

describe("fake herdr-core: calls, events and lines", () => {
  it("answers hello, terminal and machine calls with hc's shapes", async () => {
    const s = scene({ version: "0.1.17", features: FEATURES_0_1_17, methods: ["hello", "terminal.list"] });
    expect(await s.control.hello()).toMatchObject({ version: "0.1.17", features: FEATURES_0_1_17, methods: ["hello", "terminal.list"] });
    await expect(s.control.call("terminal.get", { terminal: "t1" })).rejects.toMatchObject({ kind: "unknown_method" });

    const full = scene();
    const hc = full.control;
    const t = await full.run({ labels: { x: "1" } });
    expect(await hc.call("terminal.get", { terminal: t })).toMatchObject({ address: t, cols: 200, rows: 120, state: "live", labels: { x: "1" } });
    await expect(hc.call("terminal.get", { terminal: "t99" })).rejects.toMatchObject({ kind: "not_found" });
    expect(await hc.call("terminal.label", { terminal: t, labels: { y: "2", x: "" } })).toMatchObject({ labels: { y: "2" } });
    await expect(hc.call("terminal.rm", { terminal: t })).rejects.toMatchObject({ kind: "live" });
    expect(await hc.call("terminal.kill", { terminal: t })).toMatchObject({ state: "finished", reason: "killed" });
    expect(await hc.call("terminal.list", {})).toEqual({ terminals: [], hidden_finished: 1, machines: [] });
    expect((await hc.call("terminal.list", { all: true })).terminals.map((record) => record.address)).toEqual([t]);
    await expect(hc.call("terminal.attach", { terminal: t, cols: 80, rows: 24 })).rejects.toMatchObject({ kind: "finished" });
    expect(await hc.call("terminal.rm", { terminal: t })).toEqual({ removed: t });
    expect(await hc.call("machine.list", {})).toEqual({ machines: [] });
    await expect(hc.call("terminal.run", { argv: ["sh"], on: "nowhere" })).rejects.toMatchObject({ kind: "machine_unknown" });
    expect(full.core.events(t)).toEqual(["created", "labels", "finished", "removed"]);
    expect(full.core.events(null)).toEqual([]);
  });

  it("answers an unknown method and a malformed frame with hc's errors, and ends the line on an oversized one", async () => {
    const core = new FakeHcCore();
    const transport = core.transport();
    const replies: Record<string, unknown>[] = [];
    const closes: number[] = [];
    const read = makeFrameReader((frame) => {
      if (frame.channel === 0) replies.push(JSON.parse(Buffer.from(frame.payload).toString()));
      else if (frame.kind === FRAME_CLOSE) closes.push(frame.channel);
    }, () => {});
    let ended = false;
    void (async () => {
      const reader = transport.readable.getReader();
      // the hello's answer is one plain line; every byte after it is framed
      let framed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { ended = true; return; }
        let bytes = value;
        if (!framed) {
          const at = bytes.indexOf(0x0a);
          if (at === -1) continue;
          framed = true;
          bytes = bytes.subarray(at + 1);
        }
        read(bytes);
      }
    })();
    const wait = async (label: string, check: () => boolean) => {
      const deadline = Date.now() + WAIT_MS;
      while (!check()) { if (Date.now() > deadline) throw new Error(`no ${label}`); await Bun.sleep(5); }
    };
    transport.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { generation: 1, framed: true } })}\n`));
    transport.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "no.such", params: {} })));
    transport.write(encodeFrame(0, FRAME_DATA, "this is not json"));
    transport.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "terminal.get", params: {} })));
    // a frame on a channel nobody opened: a CLOSE there is answered, anything else ignored
    transport.write(encodeFrame(9, FRAME_DATA, "stray"));
    transport.write(encodeFrame(9, FRAME_CLOSE, new Uint8Array(0)));
    transport.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "terminal.list", params: {} })));
    await wait("four replies", () => replies.length === 4);
    expect(closes).toEqual([9]);
    expect(replies.map((reply) => (reply["error"] as { code: number; data: { kind: string } } | undefined))).toEqual([
      expect.objectContaining({ code: -32601, data: expect.objectContaining({ kind: "unknown_method" }) }),
      expect.objectContaining({ code: -32700, data: expect.objectContaining({ kind: "parse_error" }) }),
      expect.objectContaining({ code: -32602, data: expect.objectContaining({ kind: "invalid_params" }) }),
      undefined,
    ]);
    expect(replies[1]!["id"]).toBeNull();
    // a call that is not an object with a string method: -32600, with the id only when an object carries one (both releases)
    const malformed: [string, number | null][] = [["null", null], ["42", null], ["[]", null], ["{}", null], ["{\"id\":7}", 7], ["{\"id\":7,\"method\":5}", 7], ["\"x\"", null]];
    for (const [input] of malformed) transport.write(encodeFrame(0, FRAME_DATA, input));
    await wait("an answer to every malformed call", () => replies.length === 4 + malformed.length);
    expect(replies.slice(4)).toEqual(malformed.map(([, id]) => ({ error: { code: -32600, data: { hint: "see `hc schema`", kind: "invalid_request" }, message: "missing method" }, id, jsonrpc: "2.0" })));
    expect(ended).toBe(false);
    // the same before framing: a hello line that is `null` is answered, and the line stays plain and open
    const plain = core.transport();
    const answer = plain.readable.getReader().read();
    plain.write(new TextEncoder().encode("null\n"));
    const { value } = await answer;
    expect(JSON.parse(Buffer.from(value!).toString())).toEqual({ error: { code: -32600, data: { hint: "see `hc schema`", kind: "invalid_request" }, message: "missing method" }, id: null, jsonrpc: "2.0" });
    const header = new Uint8Array(9);
    new DataView(header.buffer).setUint32(5, 17 * 1024 * 1024, true);
    transport.write(header);
    await wait("the line to end", () => ended);
  });

  it("streams events with seq, injects missed, heartbeats and doc events, and restarts seq after an EOF", async () => {
    const s = scene();
    const t = await s.run();
    const notes: { method: string; params: Record<string, unknown> }[] = [];
    let lost: Record<string, unknown> | null | undefined;
    let pending = "";
    const subscribed = await s.control.open("events.subscribe", {}, {
      onData: (payload) => {
        pending += Buffer.from(payload).toString();
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          notes.push(JSON.parse(pending.slice(0, at)));
          pending = pending.slice(at + 1);
        }
        s.wake();
      },
      onClose: (reason) => { lost = reason; s.wake(); },
    });
    expect(subscribed.result).toMatchObject({ seq: 1, terminals: [expect.objectContaining({ address: t })] });
    s.core.emit("size", t, { cols: 1, rows: 1 });
    s.core.heartbeat();
    s.core.missed();
    s.core.emit("doc", null, { name: "ovis-layout", version: 7 });
    s.core.remove(t);
    await s.until("five notifications", () => notes.length === 5);
    expect(notes.map((note) => `${note.method} ${String(note.params["seq"])} ${String(note.params["type"] ?? "")}`)).toEqual(["event 2 size", "heartbeat 2 ", "missed 2 ", "event 3 doc", "event 4 removed"]);
    // a filtered subscriber hears no doc event
    const filtered: string[] = [];
    await s.control.open("events.subscribe", { terminal: "t9" }, { onData: (payload) => filtered.push(Buffer.from(payload).toString()), onClose: () => {} });
    s.core.emit("doc", null, { name: "ovis-layout", version: 8 });
    await s.until("the doc event", () => notes.length === 6);
    expect(filtered).toEqual([]);
    // a core restart: the line ends (EOF), the next line's snapshot starts seq again
    s.core.restart();
    await s.until("the stream to end", () => lost !== undefined);
    expect(lost).toEqual({ reason: "connection_lost" });
    const again = await s.control.open("events.subscribe", {}, { onData: () => {}, onClose: () => {} });
    expect(again.result.seq).toBe(0);
  });

  it("speaks the same protocol over a unix socket", async () => {
    const dir = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "ovis-fk-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const core = new FakeHcCore();
    const server = await core.listen(join(dir, "hc.sock"));
    cleanups.push(() => { void server.close(); });
    const transport = await connectCoreSocket(join(dir, "hc.sock"));
    const hc = new HcConnection(() => transport);
    cleanups.push(() => hc.close());
    expect((await hc.hello()).version).toBe("0.1.18");
    const { address } = await hc.call("terminal.run", { argv: ["sh"] });
    let bytes = "";
    const { channel } = await hc.open("terminal.attach", { terminal: address, cols: 90, rows: 30, resumed: true }, { onData: (payload) => { bytes += Buffer.from(payload).toString("latin1"); }, onClose: () => {} });
    channel.write("hi");
    const deadline = Date.now() + WAIT_MS;
    while (core.program(address).receivedHex() !== hex("hi") || !bytes.includes("\x1b[?9001l")) {
      if (Date.now() > deadline) throw new Error("no input or paint over the socket");
      await Bun.sleep(5);
    }
    expect(core.size(address)).toBe("90x30");
  });
});
