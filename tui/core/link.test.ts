import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FRAME_CLOSE, FRAME_DATA, HcError, type HcTransport, makeFrameReader } from "../../server/herdr-core/connection.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { LINE_SILENCE_MS, LINE_STABLE_MS, RECONNECT_FIRST_MS, RECONNECT_MOST_MS } from "../model/deadlines.ts";
import type { CoreLink, LinkNotice, LinkOptions } from "./link.ts";

const WAIT_MS = 5000;
/**
 * Set only in the `bun test` of this file that the last block runs in a folder of its own, whose bin/
 * (stand-ins for hc, herdr-core and herdr) comes first on that bun's startup PATH. The link and the
 * socket transport are loaded only there, so a link that started hc by name, with env or without,
 * at load or later, could only reach a stand-in, never a real hc from this test's own process.
 */
const standInRun = process.env["OVIS_STANDIN_RUN"];
/** the cases of the first block: the last block checks that the stand-in run passed every one */
const LINK_CASES = 34;
/** the cases the plan names (row 22), which the last block finds by name among those that passed */
const NAMED = ["EOF", "missed", "stale socket", "incompatible names the methods", "a call while offline opens no socket"];

/** every method a fake core answers, for a core that leaves some out */
const ANSWERED = ["terminal.list", "terminal.get", "terminal.run", "terminal.kill", "terminal.rm", "terminal.label", "terminal.attach", "doc.get", "doc.set", "events.subscribe", "machine.list"];
const HELLO = { generation: 1, framed: true, version: "0.1.18", core: { id: "s1", name: "scripted" }, methods: ANSWERED, features: [] };
/** what a scripted core's handler answers to keep a call waiting */
const HOLD = Symbol("hold");

type Answer = (method: string, params: Record<string, unknown>, line: ScriptedLine) => unknown;

/**
 * One connection to a core scripted by the test, served on a unix socket so that the link reaches it
 * through the real socket transport: answers hello with `hello` (never, when null), each call with
 * `answer` (an error when it throws or its promise rejects, nothing while it answers HOLD), and lets the test put lines
 * or a CLOSE on a stream channel, send raw frames, or end the connection (EOF).
 */
class ScriptedLine {
  readonly calls: string[] = [];
  ended = false;
  private plain = true;
  private readonly frames = makeFrameReader((frame) => this.onFrame(frame.channel, frame.kind, frame.payload), () => {});

  constructor(private readonly socket: Socket, private readonly hello: Record<string, unknown> | null, private readonly answer: Answer, private readonly heard: () => void) {
    socket.on("data", (data: Buffer) => this.receive(new Uint8Array(data)));
    socket.on("close", () => { this.ended = true; heard(); });
    socket.on("error", () => {});
  }

  /** a line on a stream channel, as hc sends a notification */
  line(channel: number, text: string): void {
    this.send(encodeFrame(channel, FRAME_DATA, `${text}\n`));
  }

  notify(channel: number, method: string, params: Record<string, unknown>): void {
    this.line(channel, JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** hc ends a stream channel while the connection stays */
  closeChannel(channel: number): void {
    this.send(encodeFrame(channel, FRAME_CLOSE, new Uint8Array(0)));
  }

  send(bytes: Uint8Array): void {
    if (!this.ended) this.socket.write(bytes);
  }

  /** EOF: the core went */
  end(): void {
    this.socket.end();
  }

  private receive(bytes: Uint8Array): void {
    if (!this.plain) {
      this.frames(bytes);
      return;
    }
    const at = bytes.indexOf(0x0a);
    this.plain = false;
    this.calls.push("hello");
    this.heard();
    if (this.hello) this.send(new TextEncoder().encode(`${JSON.stringify({ id: 0, jsonrpc: "2.0", result: this.hello })}\n`));
    if (at !== -1 && at + 1 < bytes.length) this.frames(bytes.subarray(at + 1));
  }

  private onFrame(channel: number, kind: number, payload: Uint8Array): void {
    if (channel !== 0) {
      if (kind === FRAME_CLOSE) this.send(encodeFrame(channel, FRAME_CLOSE, new Uint8Array(0)));
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(payload)) as { id: number; method: string; params: Record<string, unknown> };
    this.calls.push(message.method === "doc.get" ? `doc.get ${String(message.params["name"])}` : message.method);
    this.heard();
    const refused = (error: unknown) => ({ error: { code: -32000, message: String(error), data: { kind: "refused" } } });
    const send = (reply: Record<string, unknown>) => this.send(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })));
    let reply: Record<string, unknown>;
    try {
      const result = this.answer(message.method, message.params, this);
      if (result === HOLD) return;
      // an answer the test gives later, in the order it chooses
      if (result instanceof Promise) {
        void result.then((value: unknown) => send({ result: value }), (error: unknown) => send(refused(error)));
        return;
      }
      reply = { result };
    } catch (error) {
      reply = refused(error);
    }
    send(reply);
  }
}

// a unix socket for the core: the Windows pipe is reached by the same Bun.connect
describe.skipIf(process.platform === "win32" || standInRun === undefined)("the core link", () => {
  /** short: a unix socket path must stay within the OS's 107 bytes */
  const dir = standInRun ?? "";
  const hcLog = () => join(dir, "hc.log");
  let openLink!: (options: LinkOptions) => CoreLink;
  let connectCoreSocket!: (path: string) => Promise<HcTransport>;
  /** the injected clock: nothing in these cases waits for real time */
  let now = 0;
  let sockets = 0;
  const links: CoreLink[] = [];
  const servers: { close: () => Promise<void> }[] = [];
  /** what the link told, and what the channels on it heard, in one order */
  let timeline: string[] = [];
  let notices: LinkNotice[] = [];

  const waiters = new Set<{ check: () => boolean; resolve: () => void }>();
  const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  const until = (label: string, check: () => boolean): Promise<void> => {
    if (check()) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`no ${label} within ${WAIT_MS}ms; the link told: ${timeline.join(", ")}`)); }, WAIT_MS);
    waiters.add(waiter);
    return promise;
  };
  /** for what the link tells nobody (a heartbeat read, the fake's side of a closed line): yields turns until `check` holds, at most 1000 */
  const read = async (check: () => boolean) => {
    for (let turn = 0; turn < 1_000 && !check(); turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const socket = () => join(dir, `c${++sockets}.sock`);
  const serve = async (core: FakeHcCore, path: string) => {
    const server = await core.listen(path);
    servers.push(server);
    return server;
  };
  const start = (path: string, connect?: LinkOptions["connect"], timeoutMs?: number) => {
    const link = openLink({
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      socket: path,
      now: () => now,
      model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null },
      notify: (notice) => {
        notices.push(notice);
        timeline.push(notice.type === "state" ? `state ${notice.state.kind}` : `${notice.type}${notice.type === "snapshot" ? ` ${notice.cause}` : ""}`);
        wake();
      },
      ...(connect ? { connect } : {}),
    });
    links.push(link);
    return link;
  };
  const online = (link: CoreLink, epoch: number) => until(`Online in epoch ${epoch}`, () => link.state.kind === "Online" && link.state.epoch === epoch);
  const kindOf = (error: unknown) => (error instanceof HcError ? error.kind : String(error));
  const failure = (promise: Promise<unknown>) => promise.then(() => "answered", kindOf);
  /** the calls the fake got on each line, `doc.get` with the document's name */
  const callsByLine = (core: FakeHcCore) => {
    const lines = new Map<number, string[]>();
    for (const call of core.calls()) lines.set(call.line, [...(lines.get(call.line) ?? []), call.method === "doc.get" ? `doc.get ${String(call.params["name"])}` : call.method]);
    return [...lines.values()];
  };
  const COMING_UP = ["hello", "events.subscribe", "doc.get herdr-app", "doc.get ovis-layout"];
  /** frames a viewer sent on a terminal's stream: an attach, a write, a resize, a close */
  const terminalFrames = (core: FakeHcCore, line: number) => core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.terminal !== null && entry.line === line);
  const lastLine = (core: FakeHcCore) => core.calls().at(-1)!.line;
  /** a scripted core listening on a socket of its own: `cores` holds one ScriptedLine per connection, in order */
  const scripted = async (answer: Answer, hello: Record<string, unknown> | null = HELLO) => {
    const cores: ScriptedLine[] = [];
    const open = new Set<Socket>();
    const server = createServer((connection) => {
      open.add(connection);
      connection.on("close", () => open.delete(connection));
      cores.push(new ScriptedLine(connection, hello, answer, wake));
      wake();
    });
    const path = socket();
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));
    servers.push({ close: () => new Promise<void>((resolve) => { for (const connection of open) connection.destroy(); server.close(() => resolve()); }) });
    return { cores, path };
  };
  /** a scripted core whose event stream is channel 1, with `terminals` in its snapshot at seq 1 */
  const subscribing = (terminals: unknown[] = []): Answer => (method) => {
    if (method === "events.subscribe") return { channel: 1, seq: 1, terminals };
    if (method === "doc.get") return { value: null, version: 0 };
    throw new Error(`no ${method} here`);
  };

  beforeAll(async () => {
    ({ openLink } = await import("./link.ts"));
    ({ connectCoreSocket } = await import("../../server/herdr-core/socket-transport.ts"));
  });

  afterEach(async () => {
    for (const link of links.splice(0)) await link.close();
    for (const server of servers.splice(0)) await server.close();
    timeline = [];
    notices = [];
    now = 0;
    // nothing the link did ran hc, herdr-core or herdr by name
    expect(existsSync(hcLog()) ? readFileSync(hcLog(), "utf8") : "").toBe("");
  });

  it("EOF", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    core.spawn();
    const link = start(path);
    await online(link, 1);
    const heard: unknown[] = [];
    await link.attach({ terminal: "t1", cols: 80, rows: 24, resumed: true }, { onData: () => {}, onClose: (reason) => { heard.push(reason); timeline.push("channel closed"); } });
    const first = lastLine(core);
    now = 1_000;
    core.restart();
    await until("Offline", () => link.state.kind === "Offline");
    expect(heard).toEqual([{ reason: "connection_lost" }]);
    expect(timeline.slice(timeline.indexOf("channel closed"))).toEqual(["channel closed", "state Offline"]);
    expect(link.state).toEqual({ kind: "Offline", code: "closed", retryAt: 1_000 + RECONNECT_FIRST_MS, reason: expect.any(String) });
    expect([...link.deadlines()]).toEqual([["reconnect", 1_000 + RECONNECT_FIRST_MS]]);
    now = 1_000 + RECONNECT_FIRST_MS - 1;
    link.fire();
    expect(link.state.kind).toBe("Offline");
    now = 1_000 + RECONNECT_FIRST_MS;
    link.fire();
    await online(link, 2);
    // the new line came up in the rule's order, and nothing written on the old line was written again
    expect(callsByLine(core)).toEqual([[...COMING_UP, "terminal.attach"], COMING_UP]);
    expect(terminalFrames(core, lastLine(core))).toEqual([]);
    expect(lastLine(core)).not.toBe(first);
    expect(core.viewers()).toEqual([]);
  });

  it("missed", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    core.spawn();
    core.spawn();
    const link = start(path);
    await online(link, 1);
    let closed = 0;
    await link.attach({ terminal: "t1", cols: 80, rows: 24, resumed: true }, { onData: () => {}, onClose: () => { closed++; } });
    core.emit("title", "t1", { title: "x" });
    await until("the title event", () => notices.some((notice) => notice.type === "event"));
    core.missed();
    await until("the missed snapshot", () => notices.some((notice) => notice.type === "snapshot" && notice.cause === "missed"));
    const snapshot = [...notices].reverse().find((notice) => notice.type === "snapshot")!;
    const lastSeq = core.log.flatMap((entry) => (entry.what === "event" ? [entry.seq] : [])).at(-1);
    expect(snapshot).toMatchObject({ type: "snapshot", epoch: 1, cause: "missed", seq: lastSeq });
    expect((snapshot as { terminals: { address: string }[] }).terminals.map((terminal) => terminal.address)).toEqual(["t1", "t2"]);
    // both documents read again, on the same line, after the snapshot
    expect(callsByLine(core)).toEqual([[...COMING_UP, "terminal.attach", "doc.get herdr-app", "doc.get ovis-layout"]]);
    expect(timeline.slice(timeline.lastIndexOf("snapshot missed"))).toEqual(["snapshot missed", "doc", "doc"]);
    // no stream closed: the attach and the event stream go on
    expect(closed).toBe(0);
    expect(core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_CLOSE)).toEqual([]);
    expect(link.state).toEqual({ kind: "Online", epoch: 1 });
    core.spawn();
    await until("the event after missed", () => notices.at(-1)?.type === "event" && (notices.at(-1) as { event: { type: string } }).event.type === "created");
  });

  it("stale socket", async () => {
    const live = socket();
    const stale = socket();
    const listener = Bun.listen({ unix: live, socket: { data: () => {} } });
    // a stopped listener removes its file; a second name keeps it, as a core that died leaves its socket
    linkSync(live, stale);
    listener.stop(true);
    expect(existsSync(stale)).toBe(true);
    const link = start(stale);
    await until("NoCore", () => link.state.kind === "NoCore");
    expect(link.state).toEqual({ kind: "NoCore", code: "no_core", reason: expect.any(String) });
    // the link waits for whoever starts a core: no retry of its own
    expect([...link.deadlines()]).toEqual([]);
    now = 60_000;
    link.fire();
    expect(link.state.kind).toBe("NoCore");
    // asked again, it tries once more and finds the same
    const before = notices.length;
    link.connect();
    await until("NoCore again", () => notices.length >= before + 2 && link.state.kind === "NoCore");
    expect(timeline.slice(-2)).toEqual(["state Connecting", "state NoCore"]);
    // still the file of a core that died: nothing listens there, nothing was started
    expect(await failure(connectCoreSocket(stale))).toBe("no_core");
    expect(existsSync(live)).toBe(false);
    const missing = start(join(dir, "absent.sock"));
    await until("NoCore for a missing socket", () => missing.state.kind === "NoCore");
    expect(missing.state).toEqual({ kind: "NoCore", code: "no_core", reason: expect.any(String) });
  });

  it("incompatible names the methods", async () => {
    const path = socket();
    const core = new FakeHcCore({ methods: ANSWERED.filter((method) => method !== "terminal.attach" && method !== "doc.get") });
    await serve(core, path);
    const link = start(path);
    await until("Incompatible", () => link.state.kind === "Incompatible");
    expect(link.state).toEqual({ kind: "Incompatible", code: "missing_methods", missing: ["doc.get", "terminal.attach"], reason: expect.any(String) });
    // nothing after hello, and nothing later: a core that cannot serve the screen is not tried again
    expect(callsByLine(core)).toEqual([["hello"]]);
    expect([...link.deadlines()]).toEqual([]);
    now = 60_000;
    link.fire();
    expect(link.state.kind).toBe("Incompatible");
    expect(await failure(link.call("terminal.list", {}))).toBe("offline");
  });

  it("incompatible without terminal.list, which the layout's reads call", async () => {
    const path = socket();
    const core = new FakeHcCore({ methods: ANSWERED.filter((method) => method !== "terminal.list") });
    await serve(core, path);
    const link = start(path);
    await until("the hello's verdict", () => link.state.kind === "Incompatible" || link.state.kind === "Online");
    expect(link.state).toEqual({ kind: "Incompatible", code: "missing_methods", missing: ["terminal.list"], reason: expect.stringContaining("terminal.list") });
    expect(callsByLine(core)).toEqual([["hello"]]);
  });

  it("a call while offline opens no socket", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    core.spawn();
    let opened = 0;
    const link = start(path, (at) => { opened++; return connectCoreSocket(at); });
    await online(link, 1);
    expect(opened).toBe(1);
    core.restart();
    await until("Offline", () => link.state.kind === "Offline");
    const refused = await Promise.all([
      failure(link.call("terminal.list", {})),
      failure(link.call("doc.get", { name: "ovis-layout" })),
      failure(link.call("terminal.label", { terminal: "t1", labels: { "herdr.seen": "1" } })),
      failure(link.attach({ terminal: "t1", cols: 80, rows: 24, resumed: true }, { onData: () => {}, onClose: () => {} })),
      failure(link.hello()),
    ]);
    expect(refused).toEqual(["offline", "offline", "offline", "offline", "offline"]);
    expect(opened).toBe(1);
    expect(callsByLine(core)).toEqual([COMING_UP]);
    // the same while there is no core at all
    const none = start(join(dir, "absent.sock"), (at) => { opened++; return connectCoreSocket(at); });
    await until("NoCore", () => none.state.kind === "NoCore");
    expect(await failure(none.call("terminal.list", {}))).toBe("offline");
    expect(opened).toBe(2);
  });

  it("ends a line silent for LINE_SILENCE_MS, and a heartbeat keeps it", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    core.spawn();
    const link = start(path);
    await online(link, 1);
    let lost = 0;
    await link.attach({ terminal: "t1", cols: 80, rows: 24, resumed: true }, { onData: () => {}, onClose: () => { lost++; } });
    expect([...link.deadlines()]).toEqual([["silence", LINE_SILENCE_MS]]);
    now = 30_000;
    core.heartbeat();
    await read(() => link.deadlines().get("silence") === now + LINE_SILENCE_MS);
    expect([...link.deadlines()]).toEqual([["silence", 30_000 + LINE_SILENCE_MS]]);
    now = 30_000 + LINE_SILENCE_MS - 1;
    link.fire();
    expect(link.state.kind).toBe("Online");
    now = 30_000 + LINE_SILENCE_MS;
    link.fire();
    expect(link.state).toEqual({ kind: "Offline", code: "silent", retryAt: now + RECONNECT_FIRST_MS, reason: expect.any(String) });
    expect(lost).toBe(1);
    await read(() => core.viewers().length === 0);
    expect(core.viewers()).toEqual([]);
  });

  it("retries after 250 ms doubling to 5 s while no core listens, and starts again at 250 ms once online", async () => {
    const path = socket();
    const core = new FakeHcCore();
    const server = await serve(core, path);
    const link = start(path);
    await online(link, 1);
    await server.close();
    core.restart();
    await until("Offline", () => link.state.kind === "Offline");
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const state = link.state as { kind: "Offline"; retryAt: number };
      if (attempt > 0) expect(link.state).toMatchObject({ code: "no_core" });
      waits.push(state.retryAt - now);
      now = state.retryAt;
      link.fire();
      await until(`attempt ${attempt + 1} to fail`, () => link.state.kind === "Offline" && link.state.retryAt !== null && link.state.retryAt > now);
    }
    expect(waits).toEqual([250, 500, 1_000, 2_000, 4_000, RECONNECT_MOST_MS, RECONNECT_MOST_MS]);
    rmSync(path, { force: true });
    const again = new FakeHcCore();
    await serve(again, path);
    now = (link.state as { retryAt: number }).retryAt;
    link.fire();
    await online(link, 2);
    // a line that stayed up LINE_STABLE_MS was healthy: after it the wait starts again at the first
    now += LINE_STABLE_MS;
    again.restart();
    await until("Offline again", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ code: "closed", retryAt: now + RECONNECT_FIRST_MS });
  });

  for (const step of ["hello", "events.subscribe", "herdr-app", "ovis-layout"]) {
    it(`an EOF during ${step}, twice in a row, is one retry chain`, async () => {
      const path = socket();
      const core = new FakeHcCore();
      await serve(core, path);
      let cut = 0;
      const link = start(path, async (at) => {
        const transport = await connectCoreSocket(at);
        if (cut >= 2) return transport;
        cut++;
        return { ...transport, write: (bytes: Uint8Array) => (Buffer.from(bytes).includes(`"${step}"`) ? transport.kill() : transport.write(bytes)) };
      });
      await until("the first Offline", () => link.state.kind === "Offline");
      expect(link.state).toMatchObject({ retryAt: RECONNECT_FIRST_MS });
      now = RECONNECT_FIRST_MS;
      link.fire();
      await until("the second Offline", () => timeline.filter((entry) => entry === "state Offline").length === 2);
      expect(link.state).toMatchObject({ kind: "Offline", retryAt: RECONNECT_FIRST_MS + 2 * RECONNECT_FIRST_MS });
      expect([...link.deadlines()]).toEqual([["reconnect", 3 * RECONNECT_FIRST_MS]]);
      now = 3 * RECONNECT_FIRST_MS;
      link.fire();
      await online(link, 1);
      expect(timeline.filter((entry) => entry.startsWith("state"))).toEqual(["state Connecting", "state Offline", "state Connecting", "state Offline", "state Connecting", "state Online"]);
      expect(callsByLine(core).at(-1)).toEqual(COMING_UP);
    });
  }

  // one case or more per code, each on the path that produces it, through the real socket transport

  it("code bad_line: hc closes the event stream on a line that stays, or sends a line that is not JSON, too long, a missed without its snapshot, or an invalid frame", async () => {
    const sources: [string, (line: ScriptedLine) => void][] = [
      ["the event stream closed", (line) => line.closeChannel(1)],
      ["a line that is not JSON", (line) => line.line(1, "not json")],
      ["a line over its size limit", (line) => line.line(1, "x".repeat(4 * 1024 * 1024 + 1))],
      ["a missed without its snapshot", (line) => line.notify(1, "missed", { seq: 3 })],
      ["an invalid frame", (line) => line.send(encodeFrame(0, FRAME_DATA, "not json"))],
    ];
    for (const [source, send] of sources) {
      const { cores, path } = await scripted(subscribing());
      const link = start(path);
      await online(link, 1);
      send(cores[0]!);
      await until(`Offline after ${source}`, () => link.state.kind === "Offline");
      expect({ source, state: link.state }).toMatchObject({ source, state: { code: "bad_line", retryAt: RECONNECT_FIRST_MS } });
      await read(() => cores[0]!.ended);
      expect(cores[0]!.ended).toBe(true);
      await link.close();
    }
  });

  it("code bad_line: a subscribe answer without its snapshot ends the line, and it is tried again", async () => {
    const { cores, path } = await scripted((method) => (method === "events.subscribe" ? { channel: 1, seq: 1, terminals: { t1: {} } } : { value: null, version: 0 }));
    const link = start(path);
    await until("Offline", () => link.state.kind === "Offline");
    expect(cores[0]!.calls).toEqual(["hello", "events.subscribe"]);
    expect(link.state).toMatchObject({ code: "bad_line", retryAt: RECONNECT_FIRST_MS });
    await read(() => cores[0]!.ended);
    expect(cores[0]!.ended).toBe(true);
  });

  it("code bad_line: a framed subscribe answer without a positive whole channel never comes Online", async () => {
    const channels: [string, Record<string, unknown>][] = [["none", {}], ["null", { channel: null }], ["0", { channel: 0 }], ["1.5", { channel: 1.5 }], ["a string", { channel: "1" }], ["2^32, past a frame's 32 bits", { channel: 0x1_0000_0000 }]];
    for (const [given, channel] of channels) {
      const { cores, path } = await scripted((method) => (method === "events.subscribe" ? { ...channel, seq: 1, terminals: [] } : { value: null, version: 0 }));
      timeline = [];
      const link = start(path);
      await until(`the line's end or Online with channel ${given}`, () => link.state.kind === "Offline" || link.state.kind === "Online");
      expect({ given, state: link.state, told: timeline }).toEqual({ given, state: { kind: "Offline", code: "bad_line", retryAt: RECONNECT_FIRST_MS, reason: expect.stringContaining("channel") }, told: ["state Connecting", "state Offline"] });
      expect(cores[0]!.calls).toEqual(["hello", "events.subscribe"]);
      await link.close();
    }
  });

  // the connection's own timers are real time: the link is given a short one, so these cases wait SHORT_MS, not 10 s
  const SHORT_MS = 50;

  it("code timeout: a hello never answered", async () => {
    const { cores, path } = await scripted(subscribing(), null);
    const link = start(path, undefined, SHORT_MS);
    await until("Offline", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ code: "timeout", retryAt: RECONNECT_FIRST_MS });
    expect(cores[0]!.calls).toEqual(["hello"]);
  });

  it("code timeout: a doc.get never answered on a line silent since", async () => {
    const { cores, path } = await scripted((method, params, line) => (method === "doc.get" ? HOLD : subscribing()(method, params, line)));
    const link = start(path, undefined, SHORT_MS);
    await until("Offline", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ code: "timeout", retryAt: RECONNECT_FIRST_MS });
    expect(cores[0]!.calls).toEqual(COMING_UP);
  });

  it("code timeout: a doc.get never answered while the event stream keeps bringing heartbeats", async () => {
    const { cores, path } = await scripted((method, params, line) => {
      if (method !== "doc.get") return subscribing()(method, params, line);
      line.notify(1, "heartbeat", { seq: 1 });
      return HOLD;
    });
    const link = start(path, undefined, SHORT_MS);
    await until("Offline", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ code: "timeout", retryAt: RECONNECT_FIRST_MS });
    expect(cores[0]!.calls).toEqual(COMING_UP);
  });

  it("code call_failed: the core refuses events.subscribe, either doc.get, or a re-read", async () => {
    for (const refused of ["events.subscribe", "doc.get herdr-app", "doc.get ovis-layout"]) {
      const { cores, path } = await scripted((method, params, line) => {
        if ((method === "doc.get" ? `doc.get ${String(params["name"])}` : method) === refused) throw new Error("refused here");
        return subscribing()(method, params, line);
      });
      const link = start(path);
      await until(`Offline when ${refused} is refused`, () => link.state.kind === "Offline");
      expect({ refused, state: link.state }).toMatchObject({ refused, state: { code: "call_failed" } });
      expect(cores[0]!.calls).toContain(refused);
      await link.close();
    }
    let reads = 0;
    const { cores, path } = await scripted((method, params, line) => {
      if (method === "doc.get" && ++reads > 2) throw new Error("refused here");
      return subscribing()(method, params, line);
    });
    const link = start(path);
    await online(link, 1);
    cores[0]!.notify(1, "event", { seq: 2, type: "doc", data: { name: "ovis-layout", version: 1 } });
    await until("Offline when the re-read is refused", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ code: "call_failed" });
    expect(cores[0]!.calls).toEqual([...COMING_UP, "doc.get ovis-layout"]);
  });

  it("code refused: the test-session guard keeps the user's own core out of reach", async () => {
    const saved = process.env["HERDR_TEST_SESSION"];
    process.env["HERDR_TEST_SESSION"] = "ovis-test-link";
    try {
      // the user's default socket as hc works it out in this run (its XDG_RUNTIME_DIR is this test's own folder)
      const link = start(join(dir, "run", "herdr-core", "default.sock"));
      await until("NoCore", () => link.state.kind === "NoCore");
      expect(link.state).toEqual({ kind: "NoCore", code: "refused", reason: expect.any(String) });
    } finally {
      if (saved === undefined) delete process.env["HERDR_TEST_SESSION"];
      else process.env["HERDR_TEST_SESSION"] = saved;
    }
  });

  it("code unreachable: a socket that cannot be opened at all", async () => {
    // longer than a unix socket path may be: the connect fails before any core could answer
    const link = start(join(dir, `${"u".repeat(120)}.sock`));
    await until("NoCore", () => link.state.kind === "NoCore");
    expect(link.state).toEqual({ kind: "NoCore", code: "unreachable", reason: expect.any(String) });
  });

  it("code silent: the silence deadline reached by fire() wins over a call still waiting for its own timeout", async () => {
    const { cores, path } = await scripted((method, params, line) => (method === "terminal.get" ? HOLD : subscribing()(method, params, line)));
    const link = start(path);
    await online(link, 1);
    const pending = failure(link.call("terminal.get", { terminal: "t1" }, 60_000));
    await until("the call at the core", () => cores[0]!.calls.includes("terminal.get"));
    now = LINE_SILENCE_MS;
    link.fire();
    expect(link.state).toMatchObject({ kind: "Offline", code: "silent" });
    expect(await pending).toBe("closed");
  });

  it("code bad_hello: a core of another protocol generation", async () => {
    const { cores, path } = await scripted(subscribing(), { ...HELLO, generation: 2 });
    const link = start(path);
    await until("Incompatible", () => link.state.kind === "Incompatible");
    expect(link.state).toEqual({ kind: "Incompatible", code: "bad_hello", missing: [], reason: expect.any(String) });
    expect(cores[0]!.calls).toEqual(["hello"]);
    expect([...link.deadlines()]).toEqual([]);
  });

  it("drops events at or below the seq of missed, and passes an event about a terminal it does not know", async () => {
    const { cores, path } = await scripted(subscribing([{ address: "t1", state: "live", turn: 0, labels: {}, status: { state: "working", app: "codex" } }]));
    const link = start(path);
    await online(link, 1);
    const core = cores[0]!;
    const seqs = () => notices.flatMap((notice) => (notice.type === "event" ? [notice.seq] : []));
    // an event about a terminal neither snapshot named is told, with the change the model makes of it
    core.notify(1, "event", { seq: 2, type: "status", terminal: "t9", data: { status: { state: "blocked", app: "codex" } } });
    await until("the event about t9", () => seqs().includes(2));
    expect(notices.at(-1)).toMatchObject({ type: "event", epoch: 1, changes: [{ type: "status", terminal: "t9", shown: "blocked" }] });
    // t1 is gone from the missed snapshot: a fresh model tells its next status as new, not as the end of a working turn
    core.notify(1, "missed", { seq: 5, terminals: [] });
    core.notify(1, "event", { seq: 4, type: "status", terminal: "t1", data: { status: { state: "idle", app: "codex" } } });
    core.notify(1, "event", { seq: 5, type: "status", terminal: "t1", data: { status: { state: "idle", app: "codex" } } });
    core.notify(1, "event", { seq: 6, type: "status", terminal: "t1", data: { status: { state: "idle", app: "codex" } } });
    await until("the event after missed", () => seqs().includes(6));
    expect(seqs()).toEqual([2, 6]);
    expect(notices.at(-1)).toMatchObject({ changes: [{ type: "status", terminal: "t1", shown: "idle" }] });
    expect(link.state).toEqual({ kind: "Online", epoch: 1 });
  });

  it("fails a call whose line ended before its answer, and no answer reaches it from the new line", async () => {
    let hold = true;
    const { cores, path } = await scripted((method, params, line) => (method === "terminal.get" && hold ? HOLD : subscribing()(method, params, line)));
    const link = start(path);
    await online(link, 1);
    const pending = failure(link.call("terminal.get", { terminal: "t1" }));
    await until("the call at the core", () => cores[0]!.calls.includes("terminal.get"));
    cores[0]!.end();
    expect(await pending).toBe("closed");
    await until("Offline", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ kind: "Offline", code: "closed" });
    hold = false;
    now = RECONNECT_FIRST_MS;
    link.fire();
    await online(link, 2);
    // the new line was asked only what coming up asks: the old call was not sent again
    expect(cores[1]!.calls).toEqual(COMING_UP);
  });

  it("reads a layout document again when hc says it changed, and only then", async () => {
    const versions: Record<string, number> = { "herdr-app": 0, "ovis-layout": 0 };
    const { cores, path } = await scripted((method, params, line) => {
      if (method === "doc.get") return { value: null, version: versions[String(params["name"])] };
      if (method === "machine.list") return { machines: [] };
      return subscribing()(method, params, line);
    });
    const link = start(path);
    await online(link, 1);
    const core = cores[0]!;
    const reads = () => core.calls.filter((call) => call.startsWith("doc.get"));
    const docNotices = (name: string) => notices.flatMap((notice) => (notice.type === "doc" && notice.name === name ? [notice.doc.version] : []));
    let seq = 2;
    for (const name of ["ovis-layout", "herdr-app"]) {
      versions[name] = 2;
      core.notify(1, "event", { seq: seq++, type: "doc", data: { name, version: 2 } });
      await until(`${name} read again`, () => docNotices(name).includes(2));
      // the same version and an older one: nothing is read
      core.notify(1, "event", { seq: seq++, type: "doc", data: { name, version: 2 } });
      core.notify(1, "event", { seq: seq++, type: "doc", data: { name, version: 1 } });
      const told = notices.length;
      await until("both events told", () => notices.length >= told + 2);
      // a call after them goes out behind any read they would have asked for
      await link.call("machine.list", {});
      expect(docNotices(name)).toEqual([0, 2]);
    }
    expect(reads()).toEqual(["doc.get herdr-app", "doc.get ovis-layout", "doc.get ovis-layout", "doc.get herdr-app"]);
  });

  it("never tells an older layout document after a newer one: a re-read that settles while a missed resync reads", async () => {
    let held = false;
    const pending: ((doc: unknown) => void)[] = [];
    const { cores, path } = await scripted((method, params, line) => {
      if (method !== "doc.get") return subscribing()(method, params, line);
      if (!held) return { value: null, version: params["name"] === "ovis-layout" && pending.length > 0 ? 2 : 0 };
      const { promise, resolve } = Promise.withResolvers<unknown>();
      pending.push(resolve);
      return promise;
    });
    const link = start(path);
    await online(link, 1);
    const core = cores[0]!;
    const layouts = () => notices.flatMap((notice) => (notice.type === "doc" && notice.name === "ovis-layout" ? [notice.doc.version] : []));
    held = true;
    core.notify(1, "event", { seq: 2, type: "doc", data: { name: "ovis-layout", version: 1 } });
    await until("the re-read asked", () => core.calls.filter((call) => call.startsWith("doc.get")).length === 3);
    core.notify(1, "missed", { seq: 3, terminals: [] });
    await until("the resync's reads asked", () => core.calls.filter((call) => call.startsWith("doc.get")).length === 5);
    const [old, app, current] = pending;
    old!({ value: { tag: "old" }, version: 1 });
    // answered after the re-read on the same line: the re-read has settled once this call has
    await link.call("machine.list", {}).catch(() => {});
    // a refresh asked while the resync still reads settles only once the resync's layout is told
    held = false;
    const refreshed = link.refreshLayout().then((ok) => ({ ok, toldBefore: layouts() }));
    app!({ value: null, version: 0 });
    current!({ value: { tag: "current" }, version: 2 });
    expect(await refreshed).toEqual({ ok: true, toldBefore: [0, 2] });
    expect(layouts()).toEqual([0, 2]);
    expect(notices.filter((notice) => notice.type === "doc" && notice.name === "ovis-layout").at(-1)).toMatchObject({ doc: { version: 2, value: { tag: "current" } } });
  });

  /** Online in epoch 1, then two `missed` (seq 3, then 4) whose document reads the test answers: `held` holds them in the order asked, the first resync's two before the second's. */
  const twoResyncs = async () => {
    let hold = false;
    const held: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
    const { cores, path } = await scripted((method, params, line) => {
      if (method !== "doc.get" || !hold) return subscribing()(method, params, line);
      const read = Promise.withResolvers<unknown>();
      held.push(read);
      return read.promise;
    });
    const link = start(path);
    await online(link, 1);
    const core = cores[0]!;
    const asked = () => core.calls.filter((call) => call.startsWith("doc.get")).length;
    hold = true;
    core.notify(1, "missed", { seq: 3, terminals: [] });
    await until("the first resync's reads asked", () => asked() === 4);
    core.notify(1, "missed", { seq: 4, terminals: [] });
    await until("the second resync's reads asked", () => asked() === 6);
    return { link, cores, held };
  };
  const missedSeqs = () => notices.flatMap((notice) => (notice.type === "snapshot" && notice.cause === "missed" ? [notice.seq] : []));

  it("keeps the line when a document read of a resync that a newer missed took over fails", async () => {
    const { link, cores, held } = await twoResyncs();
    const [firstApp, firstLayout, app, layout] = held;
    app!.resolve({ value: null, version: 0 });
    layout!.resolve({ value: null, version: 0 });
    await until("the second resync's snapshot", () => missedSeqs().includes(4));
    firstApp!.reject(new Error("doc.get refused"));
    firstLayout!.resolve({ value: null, version: 0 });
    // answered behind the refusal on the same line, and the second only after a round trip: the first resync has heard it
    for (let call = 0; call < 2; call++) await link.call("machine.list", {}).catch(() => {});
    expect(link.state).toEqual({ kind: "Online", epoch: 1 });
    expect(cores.length).toBe(1);
    expect(cores[0]!.ended).toBe(false);
    expect(missedSeqs()).toEqual([4]);
  });

  it("ends the line when a document read of the latest resync fails, while an older resync still reads", async () => {
    const { link, held } = await twoResyncs();
    held[2]!.reject(new Error("doc.get refused"));
    await until("Offline", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ kind: "Offline", code: "call_failed" });
    expect(missedSeqs()).toEqual([]);
  });

  it("can be read from inside its first notice, which comes after openLink returned", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    const seen: string[] = [];
    const link: CoreLink = openLink({
      socket: path,
      now: () => now,
      model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null },
      notify: (notice) => { seen.push(`${notice.type} ${link.state.kind}`); wake(); },
    });
    links.push(link);
    expect(seen).toEqual([]);
    expect(link.state.kind).toBe("Connecting");
    await until("Online", () => link.state.kind === "Online");
    expect(seen).toEqual(["state Connecting", "state Online", "snapshot Online", "doc Online", "doc Online"]);
  });

  it("a notify that throws strands nothing: the line it broke ends, and the next fire() throws it", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    core.spawn();
    const broken = new Error("the owner's handler broke");
    let breakOn: (notice: LinkNotice) => boolean = (notice) => notice.type === "state" && notice.state.kind === "Connecting";
    const link = openLink({
      socket: path,
      now: () => now,
      model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null },
      notify: (notice) => {
        notices.push(notice);
        wake();
        if (breakOn(notice)) { breakOn = () => false; throw broken; }
      },
    });
    links.push(link);
    // thrown on the first notice: the link still comes up, and asks to be fired at once
    await online(link, 1);
    expect(link.deadlines().get("failure")).toBe(now);
    expect(() => link.fire()).toThrow(broken);
    expect([...link.deadlines()]).toEqual([["silence", LINE_SILENCE_MS]]);
    // thrown on an event: what the owner was told can no longer be trusted, so the line ends as an unreadable one does
    now = 1_000;
    breakOn = (notice) => notice.type === "event";
    core.spawn();
    await until("Offline", () => link.state.kind === "Offline");
    expect(link.state).toEqual({ kind: "Offline", code: "notify_failed", retryAt: 1_000 + RECONNECT_FIRST_MS, reason: expect.any(String) });
    expect(() => link.fire()).toThrow(broken);
    now = 1_000 + RECONNECT_FIRST_MS;
    link.fire();
    await online(link, 2);
  });

  it("backs off a core that breaks its line right after coming up, and starts again at the first wait only after a stable line", async () => {
    const { cores, path } = await scripted(subscribing());
    const link = start(path);
    const waits: number[] = [];
    for (let epoch = 1; epoch <= 6; epoch++) {
      await online(link, epoch);
      cores.at(-1)!.line(1, "not json");
      await until(`Offline after epoch ${epoch}`, () => link.state.kind === "Offline");
      const state = link.state as { kind: "Offline"; retryAt: number };
      waits.push(state.retryAt - now);
      now = state.retryAt;
      link.fire();
    }
    expect(waits).toEqual([250, 500, 1_000, 2_000, 4_000, RECONNECT_MOST_MS]);
    await online(link, 7);
    now += LINE_STABLE_MS;
    cores.at(-1)!.line(1, "not json");
    await until("Offline after a stable line", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ code: "bad_line", retryAt: now + RECONNECT_FIRST_MS });
  });

  it("keeps the first of two errors notify throws in one burst, and connect() throws a kept error as fire() does", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    const thrown: Record<string, Error> = { "state Online": new Error("first"), "state Offline": new Error("second") };
    const link = openLink({
      socket: path,
      now: () => now,
      model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null },
      notify: (notice) => {
        notices.push(notice);
        wake();
        const key = notice.type === "state" ? `state ${notice.state.kind}` : notice.type;
        const error = thrown[key];
        delete thrown[key];
        if (error) throw error;
      },
    });
    links.push(link);
    // Online throws, which ends the line; the Offline it causes throws again in the same burst
    await until("Offline", () => link.state.kind === "Offline");
    expect(link.state).toMatchObject({ code: "notify_failed", retryAt: RECONNECT_FIRST_MS });
    expect(() => link.fire()).toThrow("first");
    expect([...link.deadlines()]).toEqual([["reconnect", RECONNECT_FIRST_MS]]);
    expect(() => link.fire()).not.toThrow();
    // connect() in place of the waiting retry: what the notice it makes throws comes back from connect() itself
    thrown["state Connecting"] = new Error("third");
    expect(() => link.connect()).toThrow("third");
    await online(link, 2);
  });

  it("refuses calls once closed, and closes the event stream before its line", async () => {
    const path = socket();
    const core = new FakeHcCore();
    await serve(core, path);
    const link = start(path);
    await online(link, 1);
    await link.close();
    expect(link.state).toEqual({ kind: "Offline", code: "link_closed", retryAt: null, reason: expect.any(String) });
    expect(core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_CLOSE)).toHaveLength(1);
    expect(await failure(link.call("terminal.list", {}))).toBe("offline");
    expect([...link.deadlines()]).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32" || standInRun !== undefined)("the core link, run only where a spawn of hc by name finds a stand-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "r22-"));
  /** the stand-ins' log: one line per run of `hc`, `herdr-core` or `herdr` by name, with its arguments */
  const hcLog = join(dir, "hc.log");
  /** starts hc by name both ways, as a regressed link would */
  const controlScript = join(dir, "control.ts");
  const hcRuns = () => (existsSync(hcLog) ? readFileSync(hcLog, "utf8") : "");
  /** processes still running from a stand-in run: each inherits its OVIS_STANDIN_RUN, whichever way it was spawned */
  const fromStandInRun = () => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").includes(`OVIS_STANDIN_RUN=${dir}\0`); } catch { return false; }
  });

  /**
   * Runs `bun <args>` with a startup environment built here: the stand-ins first on PATH, a scratch
   * HOME and XDG folders under this test's own, and no herdr of the tests' own (HERDR_TEST_MODE=unit).
   * Where /proc tells it, returns only once every process of the run has ended, so a spawn nobody
   * awaited has written its line.
   */
  const runInStandIns = async (...args: string[]): Promise<{ code: number; out: string }> => {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: join(dir, "home"), XDG_RUNTIME_DIR: join(dir, "run"), XDG_CONFIG_HOME: join(dir, "config"), TMPDIR: dir, OVIS_STANDIN_RUN: dir, HERDR_TEST_MODE: "unit" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (process.platform === "linux") {
      const deadline = Date.now() + WAIT_MS;
      while (fromStandInRun().length > 0) {
        if (Date.now() > deadline) throw new Error(`processes of the stand-in run still running after ${WAIT_MS}ms: ${fromStandInRun().join(", ")}`);
        await Bun.sleep(25);
      }
    }
    return { code, out: `${out}${err}` };
  };

  beforeAll(() => {
    for (const sub of ["bin", "home", "run", "config"]) mkdirSync(join(dir, sub));
    for (const name of ["hc", "herdr-core", "herdr"]) {
      writeFileSync(join(dir, "bin", name), `#!/bin/sh\necho "${name} $*" >> '${hcLog}'\n`);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    writeFileSync(controlScript, [
      "Bun.spawn([\"hc\", \"with-env\"], { env: process.env, stdout: \"ignore\", stderr: \"ignore\" });",
      "Bun.spawn([\"hc\", \"without-env\"], { stdout: \"ignore\", stderr: \"ignore\" });",
    ].join("\n"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // waiting for the run's processes needs /proc
  it.skipIf(process.platform !== "linux")("the stand-in sees a spawn of hc by name, with env and without", async () => {
    expect(await runInStandIns(controlScript)).toEqual({ code: 0, out: "" });
    expect(hcRuns().split("\n").filter(Boolean).sort()).toEqual(["hc with-env", "hc without-env"]);
    rmSync(hcLog);
  });

  it("passes every case of the link there, the named ones among them, and none of them runs hc, herdr-core or herdr", async () => {
    const { code, out } = await runInStandIns("test", import.meta.path);
    const passed = Number(out.match(/^\s*(\d+) pass$/m)?.[1] ?? 0);
    const names = [...out.matchAll(/^\(pass\) the core link > (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((match) => match[1]!);
    // the stand-in run's own list of cases, so this run shows them by name
    console.log(out.split("\n").filter((line) => line.startsWith("(pass)") || line.startsWith("(fail)")).join("\n"));
    expect({ code, passed, out: code === 0 && passed === LINK_CASES ? "" : out }).toEqual({ code: 0, passed: LINK_CASES, out: "" });
    expect(names).toEqual(expect.arrayContaining(NAMED));
    expect(hcRuns()).toBe("");
  });
});
