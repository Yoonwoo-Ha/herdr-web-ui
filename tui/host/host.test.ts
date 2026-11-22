import { describe, expect, it } from "bun:test";
import { HeadlessHost } from "../testing/headless-host.ts";
import { LEAVE as EXPORTED_LEAVE } from "./guard.ts";

// The host's rules, run on the headless twin: it drives the same guard as the real host, with an
// in-memory terminal, a manual clock and signals delivered by the test. The byte strings are the
// contract and are written out here on purpose.
const ESC = "\x1b";
const ST = `${ESC}\\`;
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1006h${ESC}[>1u`;
const LEAVE = `${ESC}[<u${ESC}[?1006l${ESC}[?1002l${ESC}[?2004l${ESC}[?1004l${ESC}[?25h${ESC}[?1049l`;
const AGAIN = `${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1006h${ESC}[=1;1u`;
const PROBE = `${ESC}[?u${ESC}[?2026$p${ESC}]10;?${ST}${ESC}]11;?${ST}${ESC}]12;?${ST}${ESC}[16t${ESC}[c`;
const ANSWER = `${ESC}[?1u${ESC}[?2026;2$y${ESC}]10;rgb:1111/2222/3333${ST}${ESC}]11;rgb:0000/0000/0000${ST}${ESC}]12;rgb:ffff/ffff/ffff${ST}${ESC}[6;18;9t${ESC}[?62;22c`;

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const text = (data: Uint8Array) => new TextDecoder().decode(data);

function inputs(host: HeadlessHost): string[] {
  const seen: string[] = [];
  host.onInput((bytes) => seen.push(text(bytes)));
  return seen;
}

describe("enter and leave", () => {
  it("turns raw mode on first, then writes the modes in one write, and leave undoes them in reverse, raw mode last", () => {
    const host = new HeadlessHost();
    expect(host.enter()).toBe(true);
    expect(host.log()).toEqual(["raw on", `write ${ENTER}`]);
    host.leave();
    expect(host.log()).toEqual(["raw on", `write ${ENTER}`, `write ${LEAVE}`, "raw off"]);
    expect(host.hooked()).toBe(false);
  });

  it("exports exactly the bytes leave writes, for a parent that gives the terminal back after the screen died", () => {
    expect(EXPORTED_LEAVE).toBe(LEAVE);
  });

  it("leaves once however often it is asked, and on the process's exit after a leave does nothing more", () => {
    const host = new HeadlessHost();
    host.enter();
    host.leave();
    host.leave();
    host.processExit();
    expect(count(host.output(), LEAVE)).toBe(1);
    expect(host.log().filter((entry) => entry === "raw off")).toHaveLength(1);
  });

  it("leaves on the process's exit (a thrown error or process.exit) when nobody called leave", () => {
    const host = new HeadlessHost();
    host.enter();
    host.processExit();
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(host.log().at(-1)).toBe("raw off");
  });

  it("a second enter changes nothing; enter after leave is refused; leave without enter writes nothing", () => {
    const host = new HeadlessHost();
    host.leave();
    expect(host.log()).toEqual([]);
    expect(host.enter()).toBe(true);
    expect(host.enter()).toBe(true);
    expect(count(host.output(), ENTER)).toBe(1);
    host.leave();
    expect(host.enter()).toBe(false);
    expect(host.output()).toBe(ENTER + LEAVE);
  });

  it("nothing is entered when stdin or stdout is not a terminal", async () => {
    const host = new HeadlessHost({ terminal: false });
    expect(host.enter()).toBe(false);
    expect(host.write("frame")).toBe(false);
    expect(await host.probe()).toMatchObject({ answered: false });
    host.leave();
    host.processExit();
    expect(host.log()).toEqual([]);
    expect(host.hooked()).toBe(false);
    expect(host.timers()).toBe(0);
  });

  it("writes only while entered", () => {
    const host = new HeadlessHost();
    expect(host.write("early")).toBe(false);
    host.enter();
    expect(host.write("frame")).toBe(true);
    host.leave();
    expect(host.write("late")).toBe(false);
    expect(host.output()).toBe(`${ENTER}frame${LEAVE}`);
  });
});

describe("signals", () => {
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    it(`gives the terminal back on ${signal}, reports it, and ends the process with ${code}`, () => {
      const host = new HeadlessHost();
      const ends: unknown[] = [];
      host.onEnd((end) => { ends.push(end); });
      host.enter();
      host.signal(signal);
      expect(host.output()).toBe(ENTER + LEAVE);
      expect(host.log().at(-1)).toBe("raw off");
      expect(ends).toEqual([{ kind: "signal", signal }]);
      expect(host.exitCode).toBe(code);
    });
  }

  it("a second signal during the end neither repeats nor cuts the restore, and the first decides the exit code", async () => {
    const host = new HeadlessHost();
    let finish = () => {};
    let told = 0;
    host.onEnd(() => { told++; return new Promise<void>((resolve) => { finish = resolve; }); });
    host.enter();
    host.signal("SIGTERM");
    host.signal("SIGINT");
    host.signal("SIGHUP");
    expect(host.exitCode).toBeNull();
    finish();
    await host.settled();
    expect(host.exitCode).toBe(143);
    expect(told).toBe(1);
    expect(count(host.output(), LEAVE)).toBe(1);
    expect(host.log().filter((entry) => entry === "raw off")).toHaveLength(1);
  });

  it("ends the process after SIGNAL_END_WAIT_MS when an end listener never settles", () => {
    const host = new HeadlessHost();
    host.onEnd(() => new Promise<void>(() => {}));
    host.enter();
    host.signal("SIGTERM");
    host.advance(1999);
    expect(host.exitCode).toBeNull();
    host.advance(1);
    expect(host.exitCode).toBe(143);
  });

  it("a signal that lands while enter is writing is handled after it: everything is undone once", () => {
    const host = new HeadlessHost();
    host.duringNextWrite(() => host.signal("SIGTERM"));
    expect(host.enter()).toBe(true);
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(host.exitCode).toBe(143);
  });

  it("a signal that lands while leave is writing does not write the leave sequence again", () => {
    const host = new HeadlessHost();
    host.enter();
    host.duringNextWrite(() => host.signal("SIGINT"));
    host.leave();
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(host.log().filter((entry) => entry === "raw off")).toHaveLength(1);
  });

  it("a signal before enter or after leave is the process's own business: the host has no hook then", () => {
    const host = new HeadlessHost();
    expect(host.hooked()).toBe(false);
    host.enter();
    expect(host.hooked()).toBe(true);
    host.leave();
    expect(host.hooked()).toBe(false);
  });
});

describe("gone after hang-up", () => {
  it("on SIGHUP gives the terminal back once, reports gone once, writes nothing after it and ends with 129", () => {
    const host = new HeadlessHost();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    host.hangUp();
    expect(host.write("frame")).toBe(false);
    host.resize(100, 30);
    host.feed(`${ESC}[I`);
    host.hangUp();
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(ends).toEqual([{ kind: "gone", why: "hangup" }]);
    expect(host.exitCode).toBe(129);
  });

  it("a write that fails with EIO reports gone once, and nothing is written again, the leave sequence included", () => {
    const host = new HeadlessHost();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    host.failWrites("EIO");
    expect(host.write("frame")).toBe(false);
    expect(host.write("frame")).toBe(false);
    host.leave();
    expect(ends).toEqual([{ kind: "gone", why: "write-failed" }]);
    expect(host.output()).toBe(ENTER);
    expect(host.writeAttempts()).toBe(2);
    expect(host.log().at(-1)).toBe("raw off");
    expect(host.exitCode).toBeNull();
  });

  it("a hang-up after a failed write ends the process without reporting gone a second time", () => {
    const host = new HeadlessHost();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    host.failWrites("EIO");
    host.write("frame");
    host.hangUp();
    expect(ends).toEqual([{ kind: "gone", why: "write-failed" }]);
    expect(host.exitCode).toBe(129);
    expect(host.log().at(-1)).toBe("raw off");
  });

  it("EPIPE is gone too; any other write error is thrown to the caller", () => {
    const host = new HeadlessHost();
    host.enter();
    host.failWrites("EPIPE");
    expect(host.write("frame")).toBe(false);
    const other = new HeadlessHost();
    other.enter();
    other.failWrites("EBADF");
    expect(() => other.write("frame")).toThrow("EBADF");
  });
});

// Write errors that are not gone: three system codes, an error with no code, and the write function's
// own throw. `inject` makes the next write fail with it (a code keeps failing every write after it).
const WRITE_ERRORS: [what: string, inject: (host: HeadlessHost) => void, error: string | Error][] = [
  ...(["EBADF", "ENOSPC", "EINVAL"] as const).map((code): [string, (host: HeadlessHost) => void, string] => [code, (host) => host.failWrites(code), `${code}: write failed`]),
  ...([["an error with no code", new Error("write failed")], ["a throw from the write function itself", new TypeError("write is not a function")]] as const)
    .map(([what, error]): [string, (host: HeadlessHost) => void, Error] => [what, (host) => host.duringNextWrite(() => { throw error; }), error]),
];

/** What `run` threw (which must be something), with the host's log as it was when it surfaced. */
function thrownBy(host: HeadlessHost, run: () => void): { error: unknown; log: string[] } {
  try {
    run();
  } catch (error) {
    return { error, log: host.log() };
  }
  throw new Error("nothing was thrown");
}

const sameError = (thrown: unknown, error: string | Error) => (typeof error === "string" ? (thrown as Error).message === error : thrown === error);

describe("a write error that is not gone", () => {
  for (const [what, inject, error] of WRITE_ERRORS) {
    it(`${what} during leave: raw mode off and the hooks released first, LEAVE tried once, then the error`, () => {
      const host = new HeadlessHost({ answer: null });
      host.enter();
      inject(host);
      const { error: thrown, log } = thrownBy(host, () => host.leave());
      expect(sameError(thrown, error)).toBe(true);
      expect(log).toEqual(["raw on", `write ${ENTER}`, "raw off"]);
      expect(host.writeAttempts()).toBe(2);
      expect(host.hooked()).toBe(false);
      // given back once: a second leave, the process's exit and a signal change nothing, and enter is refused
      host.leave();
      host.processExit();
      host.signal("SIGTERM");
      expect(host.enter()).toBe(false);
      expect(host.log()).toEqual(log);
      expect(host.writeAttempts()).toBe(2);
    });

    it(`${what} during enter: enter throws it, and the terminal is given back`, () => {
      const host = new HeadlessHost();
      inject(host);
      const { error: thrown, log } = thrownBy(host, () => host.enter());
      expect(sameError(thrown, error)).toBe(true);
      expect(log).toEqual(error instanceof Error ? ["raw on", `write ${LEAVE}`, "raw off"] : ["raw on", "raw off"]);
      expect(host.writeAttempts()).toBe(2);
      expect(host.hooked()).toBe(false);
      expect(host.enter()).toBe(false);
    });

    it(`${what} while entered: write throws it and changes nothing else`, () => {
      const host = new HeadlessHost();
      const ends: unknown[] = [];
      host.onEnd((end) => { ends.push(end); });
      host.enter();
      inject(host);
      expect(sameError(thrownBy(host, () => host.write("frame")).error, error)).toBe(true);
      expect(host.log()).toEqual(["raw on", `write ${ENTER}`]);
      expect(host.hooked()).toBe(true);
      expect(ends).toEqual([]);
    });
  }

  it("a second error while enter gives the terminal back does not replace the first", () => {
    const host = new HeadlessHost();
    const first = new Error("the enter write failed");
    host.duringNextWrite(() => { host.failWrites("EBADF"); throw first; });
    expect(thrownBy(host, () => host.enter()).error).toBe(first);
    expect(host.log()).toEqual(["raw on", "raw off"]);
    expect(host.hooked()).toBe(false);
  });

  it("on a signal the restore runs to its end and the signal decides the exit, though the leave write fails", () => {
    const host = new HeadlessHost();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    host.failWrites("EBADF");
    host.signal("SIGTERM");
    expect(host.log()).toEqual(["raw on", `write ${ENTER}`, "raw off"]);
    expect(ends).toEqual([{ kind: "signal", signal: "SIGTERM" }]);
    expect(host.exitCode).toBe(143);
  });

  it("a signal that lands while a failing leave writes: restored once, the signal's exit, and leave still throws", () => {
    const host = new HeadlessHost();
    host.enter();
    host.failWrites("EBADF");
    host.duringNextWrite(() => host.signal("SIGTERM"));
    expect((thrownBy(host, () => host.leave()).error as Error).message).toBe("EBADF: write failed");
    expect(host.log()).toEqual(["raw on", `write ${ENTER}`, "raw off"]);
    expect(host.exitCode).toBe(143);
  });
});

describe("modes again after resize and focus-in", () => {
  it("sends its own modes again after a host resize, then reports the size", () => {
    const host = new HeadlessHost();
    const sizes: unknown[] = [];
    host.onResize((size) => sizes.push({ size, output: host.output() }));
    host.enter();
    host.resize(100, 30);
    expect(sizes).toEqual([{ size: { cols: 100, rows: 30 }, output: ENTER + AGAIN }]);
    expect(host.size()).toEqual({ cols: 100, rows: 30 });
  });

  it("sends its own modes again when the host reports focus-in, and still hands the report on as input", () => {
    const host = new HeadlessHost({ answer: ANSWER });
    const seen = inputs(host);
    host.enter();
    host.feed(`${ESC}[I`);
    expect(host.output()).toBe(ENTER + AGAIN);
    expect(seen).toEqual([`${ESC}[I`]);
    host.feed(`x${ESC}[O`);
    expect(count(host.output(), AGAIN)).toBe(1);
  });

  it("finds a focus-in split across two reads", () => {
    const host = new HeadlessHost();
    host.enter();
    host.feed(`${ESC}[`);
    host.feed("I");
    expect(count(host.output(), AGAIN)).toBe(1);
  });

  it("sends nothing on a resize before enter or after leave", () => {
    const host = new HeadlessHost();
    host.resize(90, 20);
    host.enter();
    host.leave();
    host.resize(100, 30);
    expect(host.output()).toBe(ENTER + LEAVE);
  });
});

describe("the start probe", () => {
  it("the probe ends at 500 ms with no reply", async () => {
    const host = new HeadlessHost();
    host.enter();
    let result: unknown = null;
    void host.probe().then((value) => { result = value; });
    expect(host.output()).toBe(ENTER + PROBE);
    host.advance(499);
    await host.settled();
    expect(result).toBeNull();
    host.advance(1);
    await host.settled();
    expect(result).toEqual({
      answered: false, kittyFlags: null, syncOutput: null, foreground: null, background: null, cursorColor: null,
      cellPixels: null, deviceAttributes: null, theme: null,
    });
    expect(host.timers()).toBe(0);
  });

  it("the probe ends at DA1 with replies, and none of them is input", async () => {
    const host = new HeadlessHost({ answer: ANSWER });
    const seen = inputs(host);
    host.enter();
    const result = await host.probe();
    expect(result).toEqual({
      answered: true, kittyFlags: 1, syncOutput: true, foreground: [17, 34, 51], background: [0, 0, 0], cursorColor: [255, 255, 255],
      cellPixels: { width: 9, height: 18 }, deviceAttributes: [62, 22], theme: "dark",
    });
    expect(host.timers()).toBe(0);
    expect(seen).toEqual([]);
    host.feed("typed");
    expect(seen).toEqual(["typed"]);
  });

  it("a light background is light", async () => {
    const host = new HeadlessHost({ answer: `${ESC}]11;rgb:ffff/ffff/f0f0\x07${ESC}[?62c` });
    host.enter();
    expect((await host.probe()).theme).toBe("light");
  });

  it("swallows replies that come after the limit, and lets typing through", async () => {
    const host = new HeadlessHost();
    const seen = inputs(host);
    host.enter();
    const probed = host.probe();
    host.advance(500);
    expect((await probed).answered).toBe(false);
    host.feed(ANSWER);
    host.feed("x");
    expect(seen).toEqual(["x"]);
    host.feed(`${ESC}[?1u`);
    expect(seen).toEqual(["x", `${ESC}[?1u`]);
  });

  it("garbage is input, a whole reply inside it is not, and a broken reply is delivered whole at SEQUENCE_DROP_MS; the probe still ends at its limit", async () => {
    const host = new HeadlessHost();
    const seen = inputs(host);
    host.enter();
    const probed = host.probe();
    host.feed(`garbage${ESC}[?1u${ESC}]11;rgb:ff`);
    expect(seen).toEqual(["garbage"]);
    host.advance(499);
    expect(seen).toEqual(["garbage"]);
    host.advance(1);
    expect(await probed).toMatchObject({ answered: false, kittyFlags: 1, background: null });
    expect(seen).toEqual(["garbage", `${ESC}]11;rgb:ff`]);
    host.feed("x");
    expect(seen).toEqual(["garbage", `${ESC}]11;rgb:ff`, "x"]);
  });

  it("1 MiB of text during the probe is input, all of it, in order; the probe still ends at its limit", async () => {
    const host = new HeadlessHost();
    const seen = inputs(host);
    host.enter();
    const probed = host.probe();
    const text = "A".repeat(1024 * 1024);
    for (let at = 0; at < text.length; at += 65536) host.feed(text.slice(at, at + 65536));
    host.advance(500);
    expect((await probed).answered).toBe(false);
    expect(seen.join("")).toBe(text);
  });

  it("typing that arrives in the same read after the DA1 reply is input", async () => {
    const host = new HeadlessHost({ answer: `${ESC}[?62c` + "ab" });
    const seen = inputs(host);
    host.enter();
    await host.probe();
    expect(seen).toEqual(["ab"]);
  });

  it("ends when its query's write throws: the caller gets the error, and a second call the settled answer", async () => {
    const host = new HeadlessHost();
    host.enter();
    host.duringNextWrite(() => { throw Object.assign(new Error("EBADF: write failed"), { code: "EBADF" }); });
    expect(() => host.probe()).toThrow("EBADF");
    const second: { answered?: boolean } = {};
    void host.probe().then((result) => { second.answered = result.answered; });
    // one turn of the event loop: every reaction of a settled promise has run by then
    await new Promise((resolve) => setImmediate(resolve));
    expect(second).toEqual({ answered: false });
    expect(host.timers()).toBe(0);
  });

  it("is asked once: a second call gets the same answer and writes nothing", async () => {
    const host = new HeadlessHost({ answer: ANSWER });
    host.enter();
    const first = host.probe();
    expect(host.probe()).toBe(first);
    await first;
    expect(count(host.output(), PROBE)).toBe(1);
  });

  it("restores display notifications and passes late palette updates, but not late DA1, to the input decoder", async () => {
    const host = new HeadlessHost();
    const seen = inputs(host);
    host.enter();
    const probed = host.probe();
    host.advance(500);
    await probed;
    host.watchDisplay();
    host.watchDisplay();
    const update = `${ESC}]11;#123456\x07`;
    host.feed(`${update}${ESC}[?62c`);
    host.leave();
    expect([seen, count(host.output(), `${ESC}[?2031h`), host.output().endsWith(`${ESC}[?2031l${LEAVE}`)]).toEqual([[update], 1, true]);
  });

  it("ends at leave and keeps its replies out of the input to the last", async () => {
    const host = new HeadlessHost();
    host.enter();
    const probed = host.probe();
    host.leave();
    expect((await probed).answered).toBe(false);
    expect(host.timers()).toBe(0);
    expect(host.output()).toBe(ENTER + PROBE + LEAVE);
  });
});

// The filter works on whole sequences, the same way during the probe and after its limit: bytes that
// cannot start a reply pass at once, an unfinished sequence is held across reads, a finished one of a
// probe reply's shape stays in the module, any other is delivered whole, and a held one whose wait ends
// is delivered whole. Time only passes where a case says so.
const REPLIES = [
  `${ESC}[?1u`, `${ESC}[?2026;2$y`, `${ESC}]10;rgb:1111/2222/3333${ST}`, `${ESC}]11;rgb:ffff/ffff/ffff\x07`,
  `${ESC}]12;rgb:0000/0000/0000${ST}`, `${ESC}[6;18;9t`, `${ESC}[?62;22c`,
];
const KEYS = ["x", `${ESC}[A`, "\ud55c", `${ESC}[6;5~`];
const latin = (data: string) => Buffer.from(data, "utf8").toString("latin1");
const fromLatin = (data: string) => Buffer.from(data, "latin1");

/** A host whose probe is waiting (`probing`) or gave up (`late`), and what reached onInput, byte for byte. */
async function filtering(phase: "probing" | "late") {
  const host = new HeadlessHost();
  const seen: string[] = [];
  host.onInput((bytes) => seen.push(Buffer.from(bytes).toString("latin1")));
  host.enter();
  const probed = host.probe();
  if (phase === "late") { host.advance(500); await probed; }
  const feed = (reads: string[]) => { for (const read of reads) host.feed(fromLatin(read)); };
  return { host, seen, feed, probed };
}

/** Every way to cut `data` into two and three reads, and byte by byte. */
function cuts(data: string): string[][] {
  const out: string[][] = [[...data]];
  for (let i = 1; i < data.length; i++) {
    out.push([data.slice(0, i), data.slice(i)]);
    for (let j = i + 1; j < data.length; j++) out.push([data.slice(0, i), data.slice(i, j), data.slice(j)]);
  }
  return out;
}

describe("probe replies never reach the input, whatever the read boundaries", () => {
  for (const phase of ["probing", "late"] as const) {
    it(`${phase}: every reply, cut in two at every offset, in three reads and byte by byte, is never input`, async () => {
      for (const reply of REPLIES) {
        for (const reads of cuts(latin(reply))) {
          const { seen, feed } = await filtering(phase);
          feed(reads);
          feed(["k"]);
          expect([reply, reads, seen]).toEqual([reply, reads, ["k"]]);
        }
      }
    });
  }

  it("while probing, a reply cut across reads still counts for the result", async () => {
    const { feed, probed } = await filtering("probing");
    feed([ESC, "]11;rgb:ffff/ff", "ff/ffff", ST, `${ESC}[?6`, "2c"]);
    expect(await probed).toMatchObject({ answered: true, background: [255, 255, 255], theme: "light" });
  });
});

describe("keys typed during the probe are input, whole and in order", () => {
  it("each key, whole and cut at every offset, between replies, is delivered and an escape key arrives in one piece", async () => {
    for (const key of KEYS) {
      const bytes = latin(key);
      for (let cut = 0; cut <= bytes.length; cut++) {
        const { seen, feed, probed } = await filtering("probing");
        feed([`${latin(REPLIES[0]!)}${bytes.slice(0, cut)}`, `${bytes.slice(cut)}${latin(REPLIES[3]!)}`, latin(REPLIES[6]!)]);
        expect([key, cut, seen.join("")]).toEqual([key, cut, bytes]);
        if (key.startsWith(ESC)) expect([key, cut, seen.includes(bytes)]).toEqual([key, cut, true]);
        expect((await probed).answered).toBe(true);
      }
    }
  });

  it("keys before, between and after the replies come out in the order typed", async () => {
    const { seen, feed } = await filtering("probing");
    feed([`x${ESC}[?1u${ESC}[A`, `\xed\x95\x9c${ESC}]10;rgb:0/0/0${ST}${ESC}[6;5~`, `${ESC}[?62c`, "after"]);
    expect(seen.join("")).toBe(`x${ESC}[A\xed\x95\x9c${ESC}[6;5~after`);
  });
});

describe("after the probe's limit", () => {
  it("ctrl+PageDown in three reads is delivered as one whole sequence", async () => {
    const { seen, feed } = await filtering("late");
    feed([`${ESC}[6;`, "5", "~"]);
    expect(seen).toEqual([`${ESC}[6;5~`]);
  });

  it("a lone ESC is delivered after ESC_WAIT_SLOW_MS, not before; ESC then a key within it is one Alt chord", async () => {
    const { host, seen, feed } = await filtering("late");
    feed([ESC]);
    host.advance(149);
    expect(seen).toEqual([]);
    host.advance(1);
    expect(seen).toEqual([ESC]);
    feed([ESC]);
    host.advance(100);
    feed(["x"]);
    expect(seen).toEqual([ESC, `${ESC}x`]);
  });

  it("an unfinished longer sequence is held until SEQUENCE_DROP_MS after its first byte, then delivered whole", async () => {
    const { host, seen, feed } = await filtering("late");
    feed([`${ESC}[6;`]);
    host.advance(400);
    feed(["5"]);
    host.advance(99);
    expect(seen).toEqual([]);
    host.advance(1);
    expect(seen).toEqual([`${ESC}[6;5`]);
  });

  it("a mouse report and a bracketed-paste start, cut at every offset, arrive whole; the paste's text passes as it comes", async () => {
    for (const sequence of [`${ESC}[<0;10;5M`, `${ESC}[200~`]) {
      for (const reads of cuts(sequence).filter((reads) => reads.length <= 2)) {
        const { seen, feed } = await filtering("late");
        feed(reads);
        expect([sequence, reads, seen]).toEqual([sequence, reads, [sequence]]);
      }
    }
    const { seen, feed } = await filtering("late");
    feed([`${ESC}[200~pasted ${ESC}[?62c text`, `${ESC}[201~`]);
    expect(seen.join("")).toBe(`${ESC}[200~pasted ${ESC}[?62c text${ESC}[201~`);
  });

  it("an endless sequence loses none of its bytes (the holding bound is pinned in probe.test.ts)", async () => {
    const { seen, feed } = await filtering("late");
    const body = "1".repeat(1024 * 1024);
    feed([`${ESC}[`]);
    for (let at = 0; at < body.length; at += 65536) {
      feed([body.slice(at, at + 65536)]);
    }
    feed(["m"]);
    expect(seen.join("")).toBe(`${ESC}[${body}m`);
  });
});

describe("the filter loses and reorders nothing that is not a reply", () => {
  it("200 seeded interleavings of keys and replies with random cuts give back the keys byte for byte", async () => {
    const tokens = ["x", "hello", "\xed\x95\x9c", `${ESC}[A`, `${ESC}[6;5~`, `${ESC}[<0;10;5M`, `${ESC}[1;5C`, `${ESC}OP`, `${ESC}[I`, `${ESC}[97;5u`, `${ESC}x`];
    const replies = REPLIES.slice(0, 6).map(latin);
    for (let seed = 1; seed <= 200; seed++) {
      let state = seed;
      const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
      const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
      const parts: string[] = [];
      let keys = "";
      for (let n = 0; n < 12; n++) {
        if (random() < 0.4) parts.push(pick(replies));
        else { const key = pick(tokens); parts.push(key); keys += key; }
      }
      parts.push(latin(REPLIES[6]!));
      const tail = pick(tokens);
      parts.push(tail);
      keys += tail;
      const stream = parts.join("");
      const reads: string[] = [];
      for (let at = 0; at < stream.length;) { const size = 1 + Math.floor(random() * 9); reads.push(stream.slice(at, at + size)); at += size; }
      const { host, seen, feed } = await filtering(random() < 0.5 ? "probing" : "late");
      feed(reads);
      host.advance(1000);
      expect([seed, seen.join("")]).toEqual([seed, keys]);
    }
  });
});

describe("colour depth", () => {
  it("is truecolor for COLORTERM truecolor or 24bit, else 256 colours", () => {
    expect(new HeadlessHost({ colorTerm: "truecolor" }).colorDepth).toBe("truecolor");
    expect(new HeadlessHost({ colorTerm: "24bit" }).colorDepth).toBe("truecolor");
    expect(new HeadlessHost({ colorTerm: "yes" }).colorDepth).toBe("256");
    expect(new HeadlessHost({}).colorDepth).toBe("256");
  });
});

describe("drain", () => {
  it("reads what waits and hands it to onInput as it comes, then settles once nothing arrives for DRAIN_WAIT_MS", async () => {
    const host = new HeadlessHost({ answer: ANSWER });
    const seen = inputs(host);
    host.enter();
    await host.probe();
    host.queue("typed ahead");
    let drained = false;
    void host.drain().then(() => { drained = true; });
    expect(seen).toEqual(["typed ahead"]);
    host.advance(30);
    host.feed(" more");
    expect(seen).toEqual(["typed ahead", " more"]);
    host.advance(49);
    await host.settled();
    expect(drained).toBe(false);
    host.advance(1);
    await host.settled();
    expect([drained, host.timers()]).toEqual([true, 0]);
    host.feed("live");
    expect(seen).toEqual(["typed ahead", " more", "live"]);
  });

  it("keeps probe replies out of onInput while it runs", async () => {
    const host = new HeadlessHost();
    const seen = inputs(host);
    host.enter();
    void host.probe();
    const drained = host.drain();
    host.feed(`${ESC}[?1u`);
    host.advance(50);
    await drained;
    expect(seen).toEqual([]);
  });

  it("answers its promise when what it reads makes a listener leave at once", async () => {
    const host = new HeadlessHost({ answer: ANSWER });
    host.enter();
    await host.probe();
    host.onInput(() => { host.leave(); });
    host.queue("typed ahead");
    let settled = false;
    host.drain().then(() => { settled = true; });
    await host.settled();
    expect([settled, host.log().at(-1)]).toEqual([true, "raw off"]);
  });

  it("settles at once when not entered", async () => {
    const host = new HeadlessHost();
    await host.drain();
    expect(host.timers()).toBe(0);
  });
});
