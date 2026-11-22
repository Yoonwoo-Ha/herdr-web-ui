import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedCore, type StopReport, stoppedCleanly } from "../../scripts/test-hc.ts";
import { type Channel, encodeFrame, FRAME_AUTOMATIC_INPUT, FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA, FRAME_RESIZE, HcConnection, type HcTransport, makeFrameReader } from "./connection.ts";
import { FakeHcCore, type FakeProgram } from "./core.fake.ts";
import { connectCoreSocket } from "./socket-transport.ts";

/**
 * Keeps the fake honest: one script of viewer actions (probe c's c2, c4-c8, its verifier's steps
 * 3a-3c, and k1: what a lone viewer's close and attach do to the size) runs against an isolated real hc and against the fake configured like it (its
 * version and hello features, so a 0.1.17 has no automatic input), and both must give the same
 * terminal sizes, `size` events per viewer, attach replies, CLOSE payloads and bytes the program
 * saw; k2 compares the order in which one line hears its attach's reply, its stream's first bytes
 * and the `size` events; k3 holds the order a line hears beside another viewer's attach written in the
 * same turn, and reports how often the real core sent the form the fake sends only with its `late`
 * option (the line's reply ahead of the other attach's event). Runs only where OVIS_TEST_HC_BIN names
 * an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

const WAIT_MS = 5000;
const TEST_MS = 60_000;
/** how long the real core gets to emit a `size` event after a step, before the step is read */
const QUIET_MS = 100;
const R = { resumed: true } as const;

type Name = "A" | "B" | "C" | "D";
type Step =
  | ["attach", Name, number, number, { resumed?: boolean; display?: boolean }?]
  | ["detach", Name]
  /** close, wait for the core's CLOSE, attach again with `resumed` at this size (the repaint routine) */
  | ["reattach", Name, number, number]
  | ["data", Name, string]
  | ["resize", Name, number, number]
  | ["focus", Name, 0 | 1]
  | ["facts", Name]
  /** a kind 6 frame as it is, whether the core named the feature or not */
  | ["automatic", Name, string]
  /** waits until the viewer got these bytes, and notes whether a repaint (CAN) came after its first paint */
  | ["bytes", Name, string]
  /** waits for the core to close the viewer's stream */
  | ["closed", Name]
  | ["kill"];

/** channel 0 payloads that are JSON but not a call */
const MALFORMED = ["null", "42", "[]", "{}", "{\"id\":7}", "{\"id\":7,\"method\":5}", "\"x\""];

interface Scenario { name: string; steps: Step[]; noFocusReports?: boolean }

const SCENARIOS: Scenario[] = [
  { name: "c2 a resumed attach beside a driver", steps: [["attach", "A", 120, 40], ["attach", "B", 80, 24, R], ["detach", "B"], ["detach", "A"]] },
  { name: "c2 alone and resumed", steps: [["attach", "B", 80, 24, R], ["detach", "B"]] },
  { name: "c2 two resumed viewers, nobody typing", steps: [["attach", "A", 120, 40, R], ["attach", "B", 80, 24, R], ["detach", "B"], ["detach", "A"]] },
  { name: "c4 the program exits", steps: [["attach", "A", 80, 24], ["data", "A", "q"], ["closed", "A"]] },
  { name: "c4 terminal.kill while attached", steps: [["attach", "A", 80, 24], ["kill"], ["closed", "A"]] },
  {
    name: "c5 a follower gets one size event, no RESIZE and no repaint",
    steps: [["attach", "A", 120, 40], ["data", "A", "x"], ["attach", "B", 80, 24, R], ["resize", "A", 100, 30], ["bytes", "B", "SIZE 100x30"], ["reattach", "B", 80, 24], ["detach", "B"], ["detach", "A"]],
  },
  { name: "c6 nobody viewing", steps: [["attach", "A", 120, 40], ["data", "A", "x"], ["attach", "B", 80, 24, R], ["detach", "B"], ["detach", "A"]] },
  {
    name: "c7 automatic input, DATA and focus",
    steps: [
      ["attach", "A", 120, 40], ["data", "A", "a"], ["attach", "B", 80, 24, R], ["automatic", "B", "\x1b[I"], ["data", "A", "a"], ["data", "B", "\x1b[I"], ["data", "A", "a"],
      ["focus", "B", 1], ["focus", "B", 0], ["data", "A", "a"], ["focus", "B", 0], ["detach", "B"], ["detach", "A"],
    ],
  },
  {
    name: "c8 FACTS, display and any RESIZE",
    steps: [
      ["attach", "A", 120, 40], ["data", "A", "x"], ["attach", "B", 80, 24, R], ["facts", "B"], ["detach", "B"], ["attach", "B", 80, 24, { resumed: true, display: true }],
      ["resize", "B", 80, 24], ["data", "A", "x"], ["resize", "B", 90, 28], ["data", "A", "x"], ["resize", "B", 120, 40], ["attach", "D", 70, 20, R], ["detach", "A"], ["detach", "D"], ["detach", "B"],
    ],
  },
  {
    name: "c8 an attach at the current size, without and with resumed",
    steps: [
      ["attach", "A", 120, 40], ["data", "A", "x"], ["attach", "C", 120, 40], ["attach", "B", 80, 24, R], ["detach", "A"], ["detach", "B"], ["detach", "C"],
      ["attach", "A", 120, 40], ["data", "A", "x"], ["attach", "C", 120, 40, R], ["attach", "B", 80, 24, R], ["detach", "A"], ["detach", "B"], ["detach", "C"],
    ],
  },
  {
    name: "3a a resumed reattach beside a viewer that typed",
    steps: [
      ["attach", "A", 120, 40], ["data", "A", "a"], ["attach", "B", 80, 24, R], ["reattach", "B", 100, 30], ["detach", "B"], ["detach", "A"],
      ["attach", "A", 120, 40, R], ["attach", "B", 80, 24, R], ["data", "A", "a"], ["reattach", "B", 100, 30], ["detach", "B"], ["detach", "A"],
    ],
  },
  {
    name: "3b two idle viewers, a repaint attach, then a take",
    steps: [["attach", "A", 80, 24, R], ["attach", "B", 120, 40, R], ["reattach", "A", 120, 40], ["resize", "A", 80, 24], ["data", "A", "k"], ["reattach", "B", 80, 24], ["detach", "B"], ["detach", "A"]],
  },
  { name: "3c focus reports as automatic input", steps: [["attach", "A", 120, 40], ["data", "A", "a"], ["attach", "B", 80, 24, R], ["automatic", "B", "\x1b[O"], ["automatic", "B", "\x1b[I"], ["detach", "B"], ["detach", "A"]] },
  { name: "x1 a program without mode 1004", noFocusReports: true, steps: [["attach", "A", 120, 40], ["data", "A", "a"], ["attach", "B", 80, 24, R], ["automatic", "B", "\x1b[I"], ["focus", "B", 1], ["detach", "B"], ["detach", "A"]] },
  { name: "x2 FOCUS 0 from a viewer that never sent FOCUS 1", steps: [["attach", "A", 120, 40], ["data", "A", "a"], ["attach", "C", 80, 24, R], ["focus", "C", 0], ["detach", "C"], ["detach", "A"]] },
  {
    // B's only stamp is a RESIZE to the size the terminal already has: once the driver leaves, B leads, not the newer C
    name: "v10 a RESIZE to the current size is a viewer's only stamp",
    steps: [["attach", "A", 120, 40], ["data", "A", "a"], ["attach", "B", 80, 24, R], ["resize", "B", 120, 40], ["attach", "C", 70, 20, R], ["detach", "A"], ["detach", "C"], ["detach", "B"]],
  },
  {
    // A repainted beside a driver and is left alone at the size it advertised. From there its close leaves the terminal with
    // nobody, and its attach, resumed and alone, gets whatever it advertises: the size it had, another, the size of a terminal nobody views
    name: "k1 a lone viewer's close and attach",
    steps: [
      ["attach", "A", 100, 30, R], ["attach", "B", 120, 40], ["reattach", "A", 120, 40], ["resize", "B", 100, 30], ["detach", "B"],
      ["reattach", "A", 120, 40], ["data", "A", "a"], ["reattach", "A", 100, 30], ["data", "A", "a"], ["reattach", "A", 200, 120], ["data", "A", "a"], ["detach", "A"],
    ],
  },
  {
    name: "k1 the other viewer leaves between a viewer's close and its attach",
    steps: [["attach", "A", 100, 30, R], ["attach", "B", 120, 40], ["data", "B", "x"], ["detach", "A"], ["detach", "B"], ["attach", "A", 120, 40, R], ["data", "A", "a"], ["detach", "A"]],
  },
];

/** The program in every terminal: raw input logged as hex to a file, its size printed on SIGWINCH, exit 3 on a lone "q". */
const PROGRAM = [
  "import os, signal, sys, tty",
  "log = sys.argv[1]",
  "tty.setraw(0)",
  "def winch(*_):",
  "    cols, rows = os.get_terminal_size(0)",
  "    os.write(1, ('SIZE %dx%d\\r\\n' % (cols, rows)).encode())",
  "signal.signal(signal.SIGWINCH, winch)",
  "os.write(1, (b'' if '--no1004' in sys.argv else b'\\x1b[?1004h') + b'READY\\r\\n')",
  "with open(log, 'ab', buffering=0) as out:",
  "    out.write(b'R\\n')",
  "    while True:",
  "        data = os.read(0, 1024)",
  "        if not data:",
  "            break",
  "        out.write(('IN:' + data.hex() + '\\n').encode())",
  "        if data == b'q':",
  "            sys.exit(3)",
].join("\n");

/** What a run of one scenario gave: the same on the real core and the fake, or the fake is wrong. */
interface Outcome {
  steps: { step: string; size: string; sizeEvents: Partial<Record<Name, string[]>>; reply?: { size: string; automatic_input: unknown }; bytes?: { saw: boolean; repaint: boolean }; closed?: unknown }[];
  /** RESIZE frames each viewer received over the whole scenario */
  resizeFrames: Partial<Record<Name, number>>;
  /** every byte the program read, as hex */
  program: string;
}

interface Target {
  socket: string;
  real: boolean;
  /** starts the scenario's program; resolves once it is ready for input */
  start: (control: HcConnection, label: string, noFocusReports: boolean) => Promise<string>;
  /** every byte the program read so far, as hex */
  read: (terminal: string, label: string) => string;
}

interface Waiter { check: () => boolean; resolve: () => void }

describe.skipIf(!bin)("the fake herdr-core against a real hc", () => {
  let core: IsolatedCore | null = null;
  let fake: FakeHcCore;
  let fakeDir = "";
  let fakeServer: { close: () => Promise<void> } | null = null;
  let real: Target;
  let faked: Target;
  const programs = new Map<string, FakeProgram>();
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
  /** what a program read: polled, since neither the real program's file nor the fake's program announces it */
  const untilRead = async (label: string, check: () => boolean) => {
    const deadline = Date.now() + WAIT_MS;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`no ${label} within ${WAIT_MS}ms`);
      await Bun.sleep(10);
    }
  };

  /** the one teardown: afterAll and a signal to this test process (bun test skips afterAll then) both await it */
  let tearing: Promise<StopReport | null> | null = null;
  /** cores a single case started for itself (one that stops its core): stopped here too, should the case not get that far */
  const own: IsolatedCore[] = [];
  const teardown = () => (tearing ??= (async () => {
    await fakeServer?.close();
    for (const started of own) await started.stop();
    if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
    return core ? await core.stop() : null;
  })());
  const onSignal = (signal: NodeJS.Signals) => () => { void teardown().finally(() => process.exit(128 + constants.signals[signal])); };
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) => [signal, onSignal(signal)] as const);

  beforeAll(async () => {
    for (const [signal, handler] of handlers) process.on(signal, handler);
    core = new IsolatedCore(bin!);
    await core.start();
    const scripts = join(core.root, "s");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "program.py"), PROGRAM);
    const logOf = (label: string) => join(scripts, `${label}.log`);
    const logged = (label: string) => existsSync(logOf(label)) ? readFileSync(logOf(label), "utf8") : "";
    real = {
      socket: core.socket,
      real: true,
      start: async (control, label, noFocusReports) => {
        const { address } = await control.call("terminal.run", { argv: ["python3", join(scripts, "program.py"), logOf(label), ...(noFocusReports ? ["--no1004"] : [])] });
        await untilRead(`${label}'s program to start`, () => logged(label).startsWith("R\n"));
        return address;
      },
      read: (_terminal, label) => [...logged(label).matchAll(/^IN:([0-9a-f]*)$/gm)].map((match) => match[1]).join(""),
    };
    const hello = await withLine(core.socket, (hc) => hc.hello());
    fake = new FakeHcCore({ version: hello.version, features: hello.features });
    fake.onStart = (program) => {
      programs.set(program.address, program);
      program.onResize = (cols, rows) => program.output(`SIZE ${cols}x${rows}\r\n`);
      program.onInput = (bytes) => { if (Buffer.from(bytes).toString("latin1") === "q") program.exit(3); };
      program.output(`${program.argv.includes("--no1004") ? "" : "\x1b[?1004h"}READY\r\n`);
    };
    fakeDir = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "ovis-fk-"));
    fakeServer = await fake.listen(join(fakeDir, "hc.sock"));
    faked = {
      socket: join(fakeDir, "hc.sock"),
      real: false,
      start: async (control, label, noFocusReports) => (await control.call("terminal.run", { argv: ["python3", "program.py", label, ...(noFocusReports ? ["--no1004"] : [])] })).address,
      read: (terminal) => programs.get(terminal)!.receivedHex(),
    };
  }, TEST_MS);

  afterAll(async () => {
    const report = await teardown();
    for (const [signal, handler] of handlers) process.off(signal, handler);
    // a core that had to be killed, or anything left, is a leak: it fails the suite
    if (report) expect({ killed: report.killed, alive: report.alive, socketGone: report.socketGone, rootGone: report.rootGone }).toEqual({ killed: [], alive: [], socketGone: true, rootGone: true });
  }, TEST_MS);

  /** One connected line, handed over as `HcConnection` wants it (a socket opens asynchronously). */
  async function line(socket: string, onFrame?: (kind: number, payload: Uint8Array) => void): Promise<{ hc: HcConnection; raw: HcTransport }> {
    const transport = await connectCoreSocket(socket);
    let given = transport;
    if (onFrame) {
      const [mine, tapped] = transport.readable.tee();
      given = { ...transport, readable: mine };
      const read = makeFrameReader((frame) => { if (frame.channel !== 0) onFrame(frame.kind, frame.payload); }, () => {});
      void (async () => {
        const reader = tapped.getReader();
        let framed = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
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
    }
    let used = false;
    const hc = new HcConnection(() => {
      if (used) throw new Error("this test's line is single-use");
      used = true;
      return given;
    });
    return { hc, raw: transport };
  }

  async function withLine<T>(socket: string, use: (hc: HcConnection) => Promise<T>): Promise<T> {
    const { hc } = await line(socket);
    try {
      return await use(hc);
    } finally {
      hc.close();
    }
  }

  async function play(target: Target, scenario: Scenario, label: string): Promise<Outcome> {
    const opened: HcConnection[] = [];
    try {
      const control = (await line(target.socket)).hc;
      opened.push(control);
      const marker = (await control.call("terminal.run", { argv: ["sleep", "1000"] })).address;
      const terminal = await target.start(control, label, scenario.noFocusReports === true);
      interface Viewer { hc: HcConnection; raw: HcTransport; channel: Channel | null; bytes: string; closed: unknown; sizes: string[]; seen: number; marks: Set<string>; resizes: number }
      const viewers = new Map<Name, Viewer>();
      for (const name of new Set(scenario.steps.flatMap((step) => step[0] === "kill" ? [] : [step[1]]))) {
        const viewer: Viewer = { hc: null!, raw: null!, channel: null, bytes: "", closed: undefined, sizes: [], seen: 0, marks: new Set(), resizes: 0 };
        Object.assign(viewer, await line(target.socket, (kind) => { if (kind === FRAME_RESIZE) viewer.resizes++; }));
        opened.push(viewer.hc);
        let pending = "";
        await viewer.hc.open("events.subscribe", {}, {
          onData: (payload) => {
            pending += Buffer.from(payload).toString();
            for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
              const note = JSON.parse(pending.slice(0, at)) as { method: string; params: { type?: string; terminal?: string; data?: Record<string, unknown> } };
              pending = pending.slice(at + 1);
              if (note.method !== "event") continue;
              if (note.params.type === "size" && note.params.terminal === terminal) viewer.sizes.push(`${String(note.params.data?.["cols"])}x${String(note.params.data?.["rows"])}`);
              if (note.params.type === "labels" && note.params.terminal === marker) viewer.marks.add(String((note.params.data?.["labels"] as Record<string, string>)["mark"]));
            }
            wake();
          },
          onClose: () => {},
        });
        viewers.set(name, viewer);
      }
      const of = (name: Name) => viewers.get(name)!;
      const on = (name: Name) => {
        const channel = of(name).channel;
        if (!channel) throw new Error(`${name} is not attached`);
        return channel;
      };
      const sizeNow = async () => {
        const record = await control.call("terminal.get", { terminal });
        return `${record.cols}x${record.rows}`;
      };
      const attach = async (name: Name, cols: number, rows: number, options: { resumed?: boolean; display?: boolean } = {}) => {
        const viewer = of(name);
        viewer.bytes = "";
        viewer.closed = undefined;
        const { result, channel } = await viewer.hc.open("terminal.attach", {
          terminal, cols, rows, ...(options.resumed ? { resumed: true } : {}), ...(options.display ? { display: { fg: "#ffffff", bg: "#000000", cursor: "#ffffff", cell: [9, 18] } } : {}),
        }, {
          onData: (payload) => { viewer.bytes += Buffer.from(payload).toString("latin1"); wake(); },
          onClose: (reason) => { viewer.closed = reason; wake(); },
        });
        viewer.channel = channel;
        const reply = result as unknown as Record<string, unknown>;
        return { size: `${result.terminal.cols}x${result.terminal.rows}`, automatic_input: "automatic_input" in reply ? reply["automatic_input"] : "absent" };
      };
      let marks = 0;
      /**
       * After a step: the actor's own line answers a call (its frames were taken), the real core
       * gets a quiet moment for a late `size` event, and a label on the marker terminal reaches
       * every viewer's subscription, so every event before it has arrived too.
       */
      const settle = async (actor: Name | null) => {
        if (actor) await of(actor).hc.call("terminal.get", { terminal: marker });
        if (target.real) {
          // fixed wait: proving that no size event follows the step on the real core
          await Bun.sleep(QUIET_MS);
        }
        const mark = String(++marks);
        await control.call("terminal.label", { terminal: marker, labels: { mark } });
        await until(`mark ${mark} on every viewer's events`, () => [...viewers.values()].every((viewer) => viewer.marks.has(mark)));
      };
      const outcome: Outcome = { steps: [], resizeFrames: {}, program: "" };
      const record = async (step: string, extra: Partial<Outcome["steps"][number]> = {}) => {
        const sizeEvents: Partial<Record<Name, string[]>> = {};
        for (const [name, viewer] of viewers) {
          sizeEvents[name] = viewer.sizes.slice(viewer.seen);
          viewer.seen = viewer.sizes.length;
        }
        outcome.steps.push({ step, size: await sizeNow(), sizeEvents, ...extra });
      };
      await settle(null);
      await record("start");
      let ended = false;
      for (const step of scenario.steps) {
        const extra: Partial<Outcome["steps"][number]> = {};
        switch (step[0]) {
          case "attach": extra.reply = await attach(step[1], step[2], step[3], step[4]); break;
          case "detach": await on(step[1]).close(); of(step[1]).channel = null; break;
          case "reattach": await on(step[1]).close(); extra.reply = await attach(step[1], step[2], step[3], R); break;
          case "data": on(step[1]).write(step[2]); break;
          case "resize": on(step[1]).resize(step[2], step[3]); break;
          case "focus": on(step[1]).focus(step[2] === 1); break;
          case "facts": on(step[1]).facts({ fg: "#ffffff", bg: "#000000", cursor: "#ffffff", cell: [9, 18] }); break;
          case "automatic": of(step[1]).raw.write(encodeFrame(on(step[1]).id, FRAME_AUTOMATIC_INPUT, step[2])); break;
          case "bytes": {
            const viewer = of(step[1]);
            const saw = await until(`"${step[2]}" on ${step[1]}`, () => viewer.bytes.includes(step[2])).then(() => true, () => false);
            const paintEnd = viewer.bytes.search(/\x1b\[\?9001[hl]/);
            extra.bytes = { saw, repaint: viewer.bytes.slice(paintEnd + 1).includes("\x18") };
            break;
          }
          case "closed": {
            const viewer = of(step[1]);
            await until(`the core's CLOSE on ${step[1]}`, () => viewer.closed !== undefined);
            const reason = viewer.closed as Record<string, unknown> | null;
            extra.closed = reason && { ...reason, finished_ms: typeof reason["finished_ms"] === "number" ? "a time" : reason["finished_ms"] };
            ended = true;
            break;
          }
          case "kill": await control.call("terminal.kill", { terminal }); break;
        }
        const actor = step[0] === "kill" ? null : step[1];
        if (!ended) await settle(actor);
        await record(step.map((part) => JSON.stringify(part)).join(" "), extra);
      }
      // the program's input is read in order: once a last key has reached it, so has everything before
      if (!ended) {
        const name = [...viewers.keys()][0]!;
        if (!of(name).channel) await attach(name, 80, 24, R);
        on(name).write("z");
        const done = () => target.read(terminal, label).endsWith("7a");
        await untilRead("the sentinel key at the program", done);
      }
      outcome.program = ended ? target.read(terminal, label) : target.read(terminal, label).slice(0, -2);
      for (const [name, viewer] of viewers) outcome.resizeFrames[name] = viewer.resizes;
      await control.call("terminal.kill", { terminal });
      await control.call("terminal.kill", { terminal: marker });
      return outcome;
    } finally {
      for (const hc of opened) hc.close();
    }
  }

  /** Channel 0 replies to calls that are not a call, on a fresh line after hello, then a plain-mode `null` on another line. */
  async function malformedReplies(socket: string): Promise<{ framed: unknown[]; open: boolean; plain: unknown }> {
    const framedLine = await connectCoreSocket(socket);
    const replies: unknown[] = [];
    let ended = false;
    const read = makeFrameReader((frame) => { if (frame.channel === 0) replies.push(JSON.parse(Buffer.from(frame.payload).toString())); wake(); }, () => {});
    void (async () => {
      let framed = false;
      for await (const chunk of framedLine.readable) {
        let bytes = chunk;
        if (!framed) {
          const at = bytes.indexOf(0x0a);
          if (at === -1) continue;
          framed = true;
          bytes = bytes.subarray(at + 1);
          replies.push("hello");
          wake();
        }
        read(bytes);
      }
      ended = true;
      wake();
    })();
    try {
      framedLine.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { generation: 1, framed: true } })}\n`));
      await until("the hello answer", () => replies.length === 1);
      for (const input of MALFORMED) framedLine.write(encodeFrame(0, 0, input));
      // a real call after them: the line is still open and answers it
      framedLine.write(encodeFrame(0, 0, JSON.stringify({ jsonrpc: "2.0", id: 99, method: "machine.list", params: {} })));
      await until("an answer to every malformed call and the call after them", () => replies.length === MALFORMED.length + 2 || ended);
    } finally {
      framedLine.kill();
    }
    const plainLine = await connectCoreSocket(socket);
    try {
      const answer = plainLine.readable.getReader().read();
      plainLine.write(new TextEncoder().encode("null\n"));
      const { value } = await answer;
      return { framed: replies.slice(1), open: !ended, plain: value ? JSON.parse(Buffer.from(value).toString()) : "nothing" };
    } finally {
      plainLine.kill();
    }
  }

  /**
   * What a viewer's line hears while its core is stopped: the events about the terminal it is attached
   * to, the CLOSE of that attach and the end of its event stream, in the order they came. A stream the
   * core closed itself carries the core's reason; one that only ended with the line carries this
   * side's `connection_lost`.
   */
  async function stopOutcome(socket: string, stop: () => Promise<void>): Promise<string[]> {
    const viewer = (await line(socket)).hc;
    const heard: string[] = [];
    try {
      const { address } = await viewer.call("terminal.run", { argv: ["sleep", "1000"] });
      const timeless = (data: Record<string, unknown> | null | undefined) => data && { ...data, ...(typeof data["finished_ms"] === "number" ? { finished_ms: "a time" } : {}) };
      let pending = "";
      let attached = false;
      await viewer.open("events.subscribe", {}, {
        onData: (payload) => {
          pending += Buffer.from(payload).toString();
          for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
            const note = JSON.parse(pending.slice(0, at)) as { method: string; params: { type?: string; terminal?: string; data?: Record<string, unknown> } };
            pending = pending.slice(at + 1);
            if (attached && note.method === "event" && note.params.terminal === address) heard.push(`event ${String(note.params.type)} ${JSON.stringify(timeless(note.params.data))}`);
          }
        },
        onClose: (reason) => { heard.push(`events CLOSE ${JSON.stringify(reason)}`); wake(); },
      });
      await viewer.open("terminal.attach", { terminal: address, cols: 80, rows: 24, resumed: true }, {
        onData: () => {},
        onClose: (reason) => { heard.push(`attach CLOSE ${JSON.stringify(timeless(reason))}`); wake(); },
      });
      // the attach changed the size: only what the stop itself causes is compared
      await viewer.call("terminal.get", { terminal: address });
      attached = true;
      await stop();
      await until("the end of the viewer's event stream", () => heard.some((entry) => entry.startsWith("events CLOSE")));
      await until("the end of the viewer's attach", () => heard.some((entry) => entry.startsWith("attach CLOSE")));
      return heard;
    } finally {
      viewer.close();
    }
  }

  /**
   * What one viewer's line hears about a terminal around its own attaches, step by step and in the
   * order the frames came on that line: `reply COLSxROWS` (the attach reply and the size it names),
   * `bytes` (the first bytes of that attach's stream), `size COLSxROWS` (a `size` event) and `closed`
   * (the answer to its own CLOSE). The line is read frame by frame, since `HcConnection` hands a
   * reply over a turn later than the frames behind it.
   */
  async function attachOrder(socket: string): Promise<string[][]> {
    const other = (await line(socket)).hc;
    const raw = await connectCoreSocket(socket);
    const heard: string[] = [];
    const calls = new Map<number, string>();
    let greeted = false;
    let events = -1;
    let stream = -1;
    let fresh = false;
    let terminal = "";
    let pending = "";
    const read = makeFrameReader((frame) => {
      const text = Buffer.from(frame.payload).toString();
      if (frame.channel === 0) {
        const message = JSON.parse(text) as { id: number; result?: { channel?: number; terminal?: { cols: number; rows: number } } };
        const method = calls.get(message.id);
        if (method === "events.subscribe") events = message.result!.channel!;
        if (method === "terminal.attach") {
          stream = message.result!.channel!;
          fresh = true;
          heard.push(`reply ${message.result!.terminal!.cols}x${message.result!.terminal!.rows}`);
        }
      } else if (frame.channel === events && frame.kind === FRAME_DATA) {
        pending += text;
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          const note = JSON.parse(pending.slice(0, at)) as { method: string; params: { type?: string; terminal?: string; data?: Record<string, unknown> } };
          pending = pending.slice(at + 1);
          if (note.method === "event" && note.params.type === "size" && note.params.terminal === terminal) heard.push(`size ${String(note.params.data?.["cols"])}x${String(note.params.data?.["rows"])}`);
        }
      } else if (frame.channel === stream && frame.kind === FRAME_DATA && fresh) {
        fresh = false;
        heard.push("bytes");
      } else if (frame.channel === stream && frame.kind === FRAME_CLOSE) heard.push("closed");
      wake();
    }, () => {});
    void (async () => {
      for await (const chunk of raw.readable) {
        let bytes = chunk;
        if (!greeted) {
          const at = bytes.indexOf(0x0a);
          if (at === -1) continue;
          greeted = true;
          bytes = bytes.subarray(at + 1);
          wake();
        }
        read(bytes);
      }
    })();
    let id = 0;
    const call = (method: string, params: Record<string, unknown>) => {
      calls.set(++id, method);
      raw.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    };
    const steps: string[][] = [];
    const step = async (label: string, act: () => void | Promise<void>, done: (seen: string[]) => boolean) => {
      const from = heard.length;
      await act();
      await until(label, () => done(heard.slice(from)));
      steps.push(heard.slice(from));
    };
    const attach = (cols: number, rows: number) => call("terminal.attach", { terminal, cols, rows, resumed: true });
    const close = () => raw.write(encodeFrame(stream, FRAME_CLOSE, new Uint8Array(0)));
    try {
      raw.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { generation: 1, framed: true } })}\n`));
      await until("the hello answer", () => greeted);
      terminal = (await other.call("terminal.run", { argv: ["sleep", "1000"] })).address;
      call("events.subscribe", {});
      await until("the event stream", () => events !== -1);
      // alone, the attach sets the size: its reply names it, and the event follows the reply
      await step("a lone attach and its size event", () => attach(100, 30), (seen) => seen.includes("bytes") && seen.includes("size 100x30"));
      let theirs: Channel | null = null;
      await step("another idle viewer's size", async () => { theirs = (await other.open("terminal.attach", { terminal, cols: 120, rows: 40, resumed: true }, { onData: () => {}, onClose: () => {} })).channel; }, (seen) => seen.includes("size 120x40"));
      // beside that viewer the newest attach leads: again the reply first, then the event
      await step("the answer to the viewer's CLOSE", close, (seen) => seen.includes("closed"));
      await step("an attach beside an idle viewer and its size event", () => attach(110, 35), (seen) => seen.includes("bytes") && seen.includes("size 110x35"));
      // its CLOSE hands the terminal to the viewer that stays; an attach at that size sets nothing and has no event of its own,
      // which the next real change (the other viewer's RESIZE) shows
      await step("the size after the viewer's CLOSE", close, (seen) => seen.includes("closed") && seen.includes("size 120x40"));
      await step("an attach that sets no size", () => attach(120, 40), (seen) => seen.includes("bytes"));
      await step("the other viewer's RESIZE", () => theirs!.resize(90, 28), (seen) => seen.includes("size 90x28"));
      await other.call("terminal.kill", { terminal });
      return steps;
    } finally {
      raw.kill();
      other.close();
    }
  }

  it("k2 the size event of a viewer's own attach follows its reply, on either side of its stream's first bytes", async () => {
    // each of five lines must hear this order, but for the side of the first bytes beside an attach's reply: on a real core that side
    // is a matter of timing in about one attach of a hundred and sixty. The fake sends what most lines hear
    const expected = [
      // the line's event stream had carried nothing yet: the event is ahead of the first bytes
      ["reply 100x30", "size 100x30", "bytes"],
      ["size 120x40"],
      ["closed"],
      ["reply 110x35", "bytes", "size 110x35"],
      ["closed", "size 120x40"],
      ["reply 120x40", "bytes"],
      ["size 90x28"],
    ];
    /** the run with the two attaches that set a size read without the side of the first bytes, which is timing alone */
    const sided = (steps: string[][]) => steps.map((step) => step.some((entry) => entry.startsWith("reply ")) ? step.filter((entry) => entry !== "bytes") : step);
    const runs: string[][][] = [];
    for (let run = 0; run < 5; run++) runs.push(await attachOrder(real.socket));
    for (const run of runs) expect(sided(run)).toEqual(sided(expected));
    console.log(`k2: ${runs.filter((run) => JSON.stringify(run) === JSON.stringify(expected)).length} of ${runs.length} real lines heard the first bytes where the fake sends them`);
    expect(await attachOrder(faked.socket)).toEqual(expected);
    // what no run may show: the event for the size an attach set ahead of that attach's reply
    for (const seen of runs) {
      for (const step of seen) {
        const reply = step.findIndex((entry) => entry.startsWith("reply "));
        const own = reply === -1 ? -1 : step.indexOf(step[reply]!.replace("reply", "size"));
        expect(own === -1 || own > reply).toBe(true);
      }
    }
  }, TEST_MS);

  /**
   * One line's view of two attaches written in one turn, beside an idle viewer that stays: per round this line (A) closes, then
   * another viewer's attach with a new size and A's attach with the size the terminal had are written together, and A's line is read
   * frame by frame (attachOrder's names). Counted only where the core applied the other attach first: the terminal then ends at A's
   * size, and A's line hears the other's size and then its own. Which attach the core applies first, and on which side of A's reply
   * the other's event falls, is how the kernel schedules the core and this test: `first` and `behind` are what this run saw.
   */
  async function meetings(socket: string, rounds: number): Promise<{ first: number; behind: number; wrong: string[]; sample: string[] }> {
    const control = (await line(socket)).hc;
    const raws = await Promise.all([connectCoreSocket(socket), connectCoreSocket(socket), connectCoreSocket(socket)]);
    const [a, r, s] = raws.map((raw) => {
      const state = { raw, heard: [] as string[], stream: -1, greeted: false, events: -1, fresh: false, pending: "", id: 0, calls: new Map<number, string>(), terminal: "" };
      const read = makeFrameReader((frame) => {
        const text = Buffer.from(frame.payload).toString();
        if (frame.channel === 0) {
          const message = JSON.parse(text) as { id: number; result?: { channel?: number; terminal?: { cols: number; rows: number } } };
          const method = state.calls.get(message.id);
          if (method === "events.subscribe") state.events = message.result!.channel!;
          if (method === "terminal.attach") {
            state.stream = message.result!.channel!;
            state.fresh = true;
            state.heard.push(`reply ${message.result!.terminal!.cols}x${message.result!.terminal!.rows}`);
          }
        } else if (frame.channel === state.events && frame.kind === FRAME_DATA) {
          const credit = new Uint8Array(4);
          new DataView(credit.buffer).setUint32(0, frame.payload.length, true);
          raw.write(encodeFrame(state.events, FRAME_CREDIT, credit));
          state.pending += text;
          for (let at = state.pending.indexOf("\n"); at !== -1; at = state.pending.indexOf("\n")) {
            const note = JSON.parse(state.pending.slice(0, at)) as { method: string; params: { type?: string; terminal?: string; data?: Record<string, unknown> } };
            state.pending = state.pending.slice(at + 1);
            if (note.method === "event" && note.params.type === "size" && note.params.terminal === state.terminal) state.heard.push(`size ${String(note.params.data?.["cols"])}x${String(note.params.data?.["rows"])}`);
          }
        } else if (frame.channel === state.stream && frame.kind === FRAME_DATA && state.fresh) {
          state.fresh = false;
          state.heard.push("bytes");
        } else if (frame.channel === state.stream && frame.kind === FRAME_CLOSE) state.heard.push("closed");
        wake();
      }, () => {});
      void (async () => {
        for await (const chunk of raw.readable) {
          let bytes = chunk;
          if (!state.greeted) {
            const at = bytes.indexOf(0x0a);
            if (at === -1) continue;
            state.greeted = true;
            bytes = bytes.subarray(at + 1);
            wake();
          }
          read(bytes);
        }
      })();
      const call = (method: string, params: Record<string, unknown>) => {
        state.calls.set(++state.id, method);
        raw.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: state.id, method, params })));
      };
      return { state, call, attach: (cols: number, rows: number) => call("terminal.attach", { terminal: state.terminal, cols, rows, resumed: true }), close: () => raw.write(encodeFrame(state.stream, FRAME_CLOSE, new Uint8Array(0))) };
    });
    const counts = { first: 0, behind: 0, wrong: [] as string[], sample: [] as string[] };
    try {
      const terminal = (await control.call("terminal.run", { argv: ["sleep", "1000"] })).address;
      for (const viewer of [a!, r!, s!]) {
        viewer.state.raw.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { generation: 1, framed: true } })}\n`));
        await until("the hello answer", () => viewer.state.greeted);
        viewer.state.terminal = terminal;
      }
      a!.call("events.subscribe", {});
      await until("A's event stream", () => a!.state.events !== -1);
      const size = async () => { const record = await control.call("terminal.get", { terminal }); return `${record.cols}x${record.rows}`; };
      a!.attach(100, 30);
      await until("A's first bytes", () => a!.state.heard.includes("bytes"));
      s!.attach(100, 30);
      await until("the idle viewer's first bytes", () => s!.state.heard.includes("bytes"));
      for (let round = 0; round < rounds; round++) {
        const other = `${110 + (round % 40)}x35`;
        const heard = a!.state.heard;
        const closing = heard.length;
        a!.close();
        await until("the answer to A's CLOSE", () => heard.slice(closing).includes("closed"));
        const from = heard.length;
        const theirs = r!.state.heard.length;
        r!.attach(110 + (round % 40), 35);
        a!.attach(100, 30);
        await until("both replies and first bytes", () => r!.state.heard.slice(theirs).includes("bytes") && heard.slice(from).includes("bytes"));
        const ended = await size();
        if (ended === "100x30") {
          await until("the other's size and then A's own on A's line", () => { const seen = heard.slice(from); const at = seen.indexOf(`size ${other}`); return at !== -1 && seen.indexOf("size 100x30", at) !== -1; });
          const seen = heard.slice(from);
          counts.first++;
          if (seen.indexOf(`size ${other}`) > seen.indexOf("reply 100x30")) {
            counts.behind++;
            if (counts.sample.length === 0) counts.sample = seen;
          }
          // never: A's own event ahead of its reply, or the other's event behind A's own
          if (seen.indexOf("size 100x30") < seen.indexOf("reply 100x30") || seen.lastIndexOf(`size ${other}`) > seen.indexOf("size 100x30")) counts.wrong.push(seen.join(", "));
        } else await until("the other's size on A's line", () => heard.slice(from).includes(`size ${other}`));
        const leaving = heard.length;
        const closed = r!.state.heard.length;
        r!.close();
        await until("the answer to the other's CLOSE", () => r!.state.heard.slice(closed).includes("closed"));
        if (ended !== "100x30") await until("the terminal back at A's size", () => heard.slice(leaving).includes("size 100x30"));
      }
      await control.call("terminal.kill", { terminal });
      return counts;
    } finally {
      for (const raw of raws) raw.kill();
      control.close();
    }
  }

  it("k3 beside another viewer's attach written in the same turn, a line's own size event follows its reply and the other's comes before the own", async () => {
    const ROUNDS = 60;
    const seen = await meetings(real.socket, ROUNDS);
    // the two counts are reported, not required: they are this machine's scheduling. With CPU short the other attach is applied first
    // in a minority of the rounds, or in none, and the late order (the other's event behind this line's reply) may not come at all
    const checked = seen.first === 0 ? "0 such rounds, so this run had nothing to check" : `its event came behind this line's reply in ${seen.behind}`;
    console.log(`k3: ${seen.first} of ${ROUNDS} rounds the other attach was applied first; ${checked}${seen.sample.length > 0 ? `; e.g. ${seen.sample.join(", ")}` : ""}`);
    // what the core keeps, and the fake with and without `late`, in every round where the other attach was applied first: this
    // line's own event after its reply, and the other's event before the own, on either side of the reply
    expect(seen.wrong).toEqual([]);
  }, TEST_MS * 2);

  it("a core that is stopped closes each attach with its reason before the line ends", async () => {
    const stopped = new IsolatedCore(bin!);
    own.push(stopped);
    await stopped.start();
    const onReal = await stopOutcome(stopped.socket, async () => { expect(stoppedCleanly(await stopped.stop())).toBe(true); });
    const { version, features } = await withLine(real.socket, (hc) => hc.hello());
    const stand = new FakeHcCore({ version, features });
    const server = await stand.listen(join(fakeDir, "stop.sock"));
    try {
      const onFake = await stopOutcome(join(fakeDir, "stop.sock"), async () => stand.stop());
      // the core's own CLOSE reaches the attach while the line is still there: the line's end comes after it
      expect(onReal.findIndex((entry) => entry.startsWith("attach CLOSE"))).toBeLessThan(onReal.findIndex((entry) => entry.startsWith("events CLOSE")));
      expect(onReal.find((entry) => entry.startsWith("attach CLOSE"))).toContain("server_stop");
      expect(onFake).toEqual(onReal);
    } finally {
      await server.close();
    }
  }, TEST_MS);

  /** What one line hears of a terminal whose agent reports `states` one after another, and the turn and state the core then keeps. */
  async function turns(target: Target, states: readonly string[]): Promise<{ heard: string[]; turn: number | undefined; state: string | undefined }> {
    const { hc } = await line(target.socket);
    try {
      const heard: { terminal: string | undefined; text: string }[] = [];
      let pending = "";
      await hc.open("events.subscribe", {}, {
        onData: (payload) => {
          pending += Buffer.from(payload).toString();
          for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
            const note = JSON.parse(pending.slice(0, at)) as { method: string; params: { type?: string; terminal?: string; data?: Record<string, unknown> } };
            pending = pending.slice(at + 1);
            const { type, terminal, data } = note.params;
            if (note.method !== "event" || (type !== "status" && type !== "turn")) continue;
            const state = type === "status" ? (data?.["status"] as { state?: unknown } | undefined)?.state : data?.["state"];
            heard.push({ terminal, text: type === "turn" ? `turn ${String(state)} ${String(data?.["turn"])}` : `status ${String(state)}` });
          }
          wake();
        },
        onClose: () => {},
      });
      const report = (state: string) => `printf '\\033]7501;state=${state}:app=claude\\033\\\\'`;
      const { address } = await hc.call("terminal.run", { argv: ["sh", "-c", `${states.map((state) => `${report(state)}; sleep 0.2`).join("; ")}; sleep 30`] });
      if (!target.real) for (const state of states) fake.reportStatus(address, { state, app: "claude" });
      const mine = () => heard.filter((entry) => entry.terminal === address).map((entry) => entry.text);
      await until(`${states.length} status reports`, () => mine().filter((text) => text.startsWith("status ")).length >= states.length);
      const record = await hc.call("terminal.get", { terminal: address });
      // read before the kill: a real core then reports the ended program's status as null
      const told = mine();
      await hc.call("terminal.kill", { terminal: address });
      return { heard: told, turn: record.turn, state: record.status?.state };
    } finally {
      hc.close();
    }
  }

  it("t1 a report that leaves working ends a turn: the status, then a turn event with the new state, and the record counts it", async () => {
    const states = ["working", "idle", "working", "blocked", "idle"];
    const onReal = await turns(real, states);
    const onFake = await turns(faked, states);
    expect(onReal).toEqual({
      heard: ["status working", "status idle", "turn idle 1", "status working", "status blocked", "turn blocked 2", "status idle"],
      turn: 2,
      state: "idle",
    });
    expect(onFake).toEqual(onReal);
  }, TEST_MS);

  it("answers calls that are not calls as the real core does", async () => {
    const onReal = await malformedReplies(real.socket);
    const onFake = await malformedReplies(faked.socket);
    expect(onReal.framed).toHaveLength(MALFORMED.length + 1);
    expect(onFake).toEqual(onReal);
  }, TEST_MS);

  for (const [index, scenario] of SCENARIOS.entries()) {
    it(scenario.name, async () => {
      const label = `s${index}`;
      const onReal = await play(real, scenario, label);
      const onFake = await play(faked, scenario, label);
      expect(onReal.steps).toHaveLength(scenario.steps.length + 1);
      expect(onFake).toEqual(onReal);
    }, TEST_MS);
  }
});
