import { afterEach, expect, it } from "bun:test";
import { FRAME_DATA } from "../../server/herdr-core/connection.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { keyBytes } from "../testing/keys.ts";
import { Stage } from "../testing/pane-harness.ts";
import { Run } from "../testing/run.ts";
import { FRAME_PASS_MS } from "./deadlines.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

const HISTORY = Array.from({ length: 32 }, (_, row) => {
  if (row === 0) return "Old needle";
  if (row === 14) return "Middle needle";
  if (row === 29) return "Recent needle";
  if (row === 30) return "upper words";
  if (row === 31) return "alpha beta gambit";
  return `row-${row}`;
}).join("\r\n") + "\r";

async function start(paint = HISTORY, other?: string): Promise<Run> {
  const run = await Run.start({
    cols: other === undefined ? 60 : 120, rows: 14,
    fixture: { build(core) {
      const where = { space: "work", spaceName: "work", tab: "one", tabName: "one" };
      place(core, where, paint);
      if (other !== undefined) place(core, where, other);
    } },
  });
  runs.push(run);
  await run.live();
  await run.advance(1);
  await run.keys("ctrl+b,[");
  return run;
}

const clips = (run: Run) => [...run.host.output().matchAll(/\x1b]52;c;([A-Za-z0-9+/=]+)\x1b\\/g)]
  .map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
const data = (run: Run) => run.sent.filter(({ kind, channel }) => kind === FRAME_DATA && channel !== 0)
  .map(({ payload }) => Buffer.from(payload).toString());

it.each([
  ["l", "l", "l"],
  ["h", "l,l,h", "l"],
  ["k", "k", "u"],
  ["j", "k,j", "a"],
  ["w", "w", "b"],
  ["b", "w,w,b", "b"],
  ["0", "w,0", "a"],
  ["$", "l,$", "t"],
  ["g", "g", "O"],
  ["G", "g,G", "a"],
  ["ctrl+u", "ctrl+u,l,l,l,l,l", "6"],
  ["ctrl+d", "ctrl+u,ctrl+d", "a"],
  ["arrows", "up,right,down,left", "a"],
])("key table: %s", async (_key, keys, text) => {
  const run = await start();
  await run.keys(`${keys},v,y`);
  expect(clips(run)).toEqual([text]);
});

it("search finds and scrolls", async () => {
  const run = await start();
  await run.keys("/,NEEDLE,enter");
  await run.advance(10);
  expect(run.grid().map((row) => row.slice(1, 14))).toContain("Recent needle");
  await run.keys("n");
  await run.advance(10);
  expect(run.grid().map((row) => row.slice(1, 14))).toContain("Middle needle");
  expect(run.grid().map((row) => row.slice(1, 14))).not.toContain("Recent needle");
  await run.keys("N");
  await run.advance(10);
  expect(run.grid().map((row) => row.slice(1, 14))).toContain("Recent needle");
  expect(run.grid().map((row) => row.slice(1, 14))).not.toContain("Middle needle");
});

it("copy is one OSC 52 write with the selected text", async () => {
  const run = await start("left\r\n한글 e\u0301\r");
  await run.keys("v,l,l,l,y");
  expect(clips(run)).toEqual(["한글 e\u0301"]);
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(run.loop.model().notices.at(-1)).toMatchObject({ code: "copied", calm: true });
});

it("line selection extends across both rows when moving backwards", async () => {
  const run = await start("left\r\nright\r");
  await run.keys("V,k,y");
  expect(clips(run)).toEqual(["left\nright"]);
});

it("nothing reaches the pane", async () => {
  const run = await start();
  run.forget();
  await run.keys(Array.from({ length: 30 }, (_, i) => ["h", "j", "x", "ctrl+b", "["][i % 5]).join(","));
  run.type("\x1b[200~paste that never reaches the program\x1b[201~");
  await run.keys("press@4:4,release@4:4");
  expect(data(run)).toEqual([]);
  // q leaves copy mode; what its read holds after it goes to the program, as it would read apart
  run.type("qafter");
  await run.advance(1);
  expect(data(run)).toEqual(["after"]);
  await run.keys("Z");
  expect(data(run)).toEqual(["after", "Z"]);
});

it.each([
  ["1", "https://example.org/a"],
  ["2", "./docs/guide.md:12"],
  ["3", "c0ffee42"],
])("hints on a fixture screen: %s", async (digit, target) => {
  const run = await start("한 https://example.org/a\r\n./docs/guide.md:12 c0ffee42\r");
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 10)).toBe("한 1ttps:/");
  expect(run.grid()[3]?.slice(1, 25)).toBe("2/docs/guide.md:12 30ffe");
  await run.keys(digit);
  expect(clips(run)).toEqual([target]);
});

it("resize cancels copy and restores the viewport before the replacement attach", async () => {
  const run = await start();
  await run.keys("g,v,l");
  await run.advance(10);
  const current = run.loop.panes.view("t1")?.emulator;
  run.host.resize(61, 14);
  await run.advance(20);
  expect(run.loop.panes.view("t1")?.emulator).toBe(current);
  expect(run.grid()[11]?.slice(1, 18)).toBe("alpha beta gambit");
  expect(run.loop.model().mode.name).toBe("terminal");
  await run.advance(180);
  await run.live();
  expect(run.loop.panes.view("t1")?.emulator).not.toBe(current);
  expect(run.grid()[11]?.slice(1, 18)).toBe("alpha beta gambit");
  expect(clips(run)).toEqual([]);
});

it("output invalidates a displayed hint before its label can copy stale text", async () => {
  const run = await start("https://example.org/a\r");
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 6)).toBe("1ttps");
  run.core.program("t1").output("https://example.org/b\r");
  await run.advance(10);
  await run.keys("1");
  expect(clips(run)).toEqual([]);
});

it("Escape leaves the search prompt and restores the original viewport", async () => {
  const run = await start();
  await run.keys("g,/,que");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 11)).toBe("Old needle");
  await run.keys("esc");
  await run.advance(160);
  expect(run.grid()[11]?.slice(1, 18)).toBe("alpha beta gambit");
});

it("Backspace removes the final grapheme before searching", async () => {
  const run = await start();
  await run.keys("g,/,Recent needle😀,backspace,enter");
  await run.advance(10);
  expect(run.grid().map((row) => row.slice(1, 14))).toContain("Recent needle");
});

it("a missing or empty query does not move history", async () => {
  const run = await start();
  await run.keys("g,/,not-in-this-history,enter,n");
  await run.advance(10);
  expect(run.loop.report().mode.notice).toBe("copy_no_match");
  await run.keys("/,enter,N");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 11)).toBe("Old needle");
  expect(run.loop.report().mode.notice).toBeUndefined();
});

it("the search cursor follows the rendered prompt and query", async () => {
  const run = await start();
  await run.keys("/,한abc");
  await run.advance(10);
  const bar = run.grid()[13];
  expect(bar).toEndWith("/한abc");
  const cursor = [...run.host.output().matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1);
  expect(cursor?.slice(1)).toEqual(["14", String(Bun.stringWidth(bar ?? "") + 1)]);
});

it("an alternate screen change restores the main buffer to the bottom on return", async () => {
  const run = await start();
  await run.keys("g,v,l");
  run.core.program("t1").output("\x1b[?1049h\x1b[HALT\r");
  await run.advance(10);
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(run.grid()[2]?.slice(1, 4)).toBe("ALT");
  run.core.program("t1").output("\x1b[?1049l");
  await run.advance(10);
  expect(run.grid()[11]?.slice(1, 18)).toBe("alpha beta gambit");
  expect(clips(run)).toEqual([]);
});

it("an alternate screen round trip restores a nonzero entry offset", async () => {
  const run = await start();
  await run.keys("q,wheelup@4:4");
  await run.advance(10);
  const first = run.grid()[2]?.slice(1, 7);
  expect(first).not.toBe("row-22");
  await run.keys("ctrl+b,[,g");
  await run.advance(10);
  const program = run.core.program("t1");
  program.output("\x1b[?1049hALT");
  await run.advance(10);
  program.output("\x1b[?1049l");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 7)).toBe(first);
});

it("leaving copy on the same buffer restores a nonzero entry offset", async () => {
  const run = await start();
  await run.keys("q,wheelup@4:4");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 7)).toBe("row-19");
  await run.keys("ctrl+b,[,g");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 11)).toBe("Old needle");
  await run.keys("q");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 7)).toBe("row-19");
});

it("program exit cancels copy and restores the last picture to the entry offset", async () => {
  const run = await start();
  await run.keys("g,V");
  run.core.program("t1").exit(0);
  await run.advance(20);
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(run.grid()[11]?.slice(1, 18)).toBe("alpha beta gambit");
});

it("output clears an active selection before yank", async () => {
  const run = await start("before\r");
  await run.keys("V");
  run.core.program("t1").output("after\r");
  await run.advance(10);
  await run.keys("y");
  expect(run.loop.model().mode.name).toBe("copy");
  expect(clips(run)).toEqual([]);
});

const WRAPPED_URL = `https://example.org/${"seg/".repeat(12)}tail/file.ts:12`;
const LONG_URL = `https://example.org/${"seg/".repeat(27)}end.html`;
const WRAPPED_PATH = `./${"directory-name/".repeat(4)}src/components/Widget.tsx:120:8`;
const WRAPPED_HASH = " ".repeat(45) + "0123456789abcdef".repeat(4);
const WRAP_CUTS = [
  ["URL", [WRAPPED_URL.slice(0, 58)], "g/seg/seg/tail/file.ts:12"],
  ["URL over 3 rows", [LONG_URL.slice(0, 58), LONG_URL.slice(58, 116)], "seg/seg/seg/end.html"],
  ["path", [WRAPPED_PATH.slice(0, 58)], "ame/src/components/Widget.tsx:120:8"],
  ["Korean path", [`./${"디렉터리/".repeat(6)}디`], "렉터리/소스/위젯.tsx:120:8"],
  ["hash", [WRAPPED_HASH.slice(0, 58)], "def0123456789abcdef0123456789abcdef0123456789abcdef"],
] as const;

it.each(WRAP_CUTS)("a pruned wrapped %s has no hint on the oldest kept row", async (_kind, head, tail) => {
  const run = await start();
  await run.keys("q");
  const line = head.join("") + tail;
  // Clear the old screen and history, then let Ghostty lay out the live bytes.
  run.core.program("t1").output(Buffer.from(`\x1bcone\r\n${(`${line}\r\n`).repeat(2999)}${line}\r`));
  await run.advance(20);
  await run.keys("ctrl+b,[,g,f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 1 + tail.length)).toBe(tail);
  await run.keys("1");
  expect(clips(run)).toEqual([line.trimStart()]);
  expect(data(run)).toEqual([]);
});

it.each(WRAP_CUTS)("a pruned replay of %s has no hint on its oldest tail", async (_kind, head, tail) => {
  // A real replay hard-breaks each physical row. Repeating the record makes
  // the engine drop earlier pages, so there is no preceding row to inspect.
  const line = [...head, tail].join("\r\n");
  const run = await start("one\r\n" + (`${line}\r\n`).repeat(2999) + line + "\r");
  await run.keys("g,f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 1 + tail.length)).toBe(tail);
  await run.keys("1");
  expect(clips(run)).toEqual([]);
  expect(data(run)).toEqual([]);
});

it.each([
  ["a URL scheme", "https://whole.test/a", "1ttps://whole.test/a", "https://whole.test/a"],
  ["a file scheme", "file:///docs/guide.md", "1ile:///docs/guide.md", "file:///docs/guide.md"],
  ["a dot root", "./docs/guide.md", "1/docs/guide.md", "./docs/guide.md"],
  ["a parent root", "../docs/guide.md", "1./docs/guide.md", "../docs/guide.md"],
  ["a home root", "~/docs/guide.md", "1/docs/guide.md", "~/docs/guide.md"],
  ["an explicitly spaced hash", " c0ffee42", " 10ffee42", "c0ffee42"],
  ["an explicitly spaced absolute path", " /docs/guide.md", " 1docs/guide.md", "/docs/guide.md"],
  ["a token after a clipped one", "tail/file.ts c0ffee42", "tail/file.ts 10ffee42", "c0ffee42"],
  ["a token after a slash-leading tail", "/tail/file.ts c0ffee42", "/tail/file.ts 10ffee42", "c0ffee42"],
  ["a token after punctuation inside a tail", "(c0ffee42) /whole.md", "(c0ffee42) 1whole.md", "/whole.md"],
  ["a token after a scheme within the first field", "(https://cut.test/a) c0ffee42", "(https://cut.test/a) 10ffee42", "c0ffee42"],
])("oldest row can prove %s", async (_kind, line, drawn, target) => {
  const run = await start(`${line}\r\n${"padding\r\n".repeat(14)}end\r`);
  await run.keys("g,f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 1 + drawn.length)).toBe(drawn);
  await run.keys("1");
  expect(clips(run)).toEqual([target]);
});

it("an oldest-row scheme reaching the margin does not prove a complete target", async () => {
  const url = "https://example.org/" + "a".repeat(38);
  const run = await start(`${url}\r\n\r\n${"padding\r\n".repeat(14)}end\r`);
  await run.keys("g,f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 59)).toBe(url);
  await run.keys("1");
  expect(clips(run)).toEqual([]);
});

it("an intact wrapped URL at the history limit can still be copied", async () => {
  const run = await start((`${WRAPPED_URL}\r\n`).repeat(2999) + WRAPPED_URL + "\r");
  await run.keys("g,f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 6)).toBe("1ttps");
  await run.keys("1");
  expect(clips(run)).toEqual([WRAPPED_URL]);
});

it.each([
  ["URL", WRAPPED_URL, "1ttps"],
  ["path", `./${"directory/".repeat(5)}abcde한글/파일.ts:12`, "1/dir"],
  ["hash", " ".repeat(45) + "0123456789abcdef".repeat(4), "11234"],
])("a fully visible wrapped %s has one label and copies whole", async (_kind, line, label) => {
  const run = await start(`${line}\r\nhttps://next.test/a\r`);
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(line.length - line.trimStart().length + 1, line.length - line.trimStart().length + 6)).toBe(label);
  expect(run.grid()[4]?.slice(1, 6)).toBe("2ttps");
  await run.keys("1");
  expect(clips(run)).toEqual([line.trimStart()]);
});

it("a wrapped target whose first row is above the viewport has no hint", async () => {
  const run = await start(`${WRAPPED_URL} https://same.test/a\r\nhttps://next.test/a\r\n${"padding\r\n".repeat(7)}last\r`);
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 9)).toBe("g/seg/se");
  expect(run.grid()[2]).toContain(" https://same.test/a ");
  expect(run.grid()[3]?.slice(1, 6)).toBe("1ttps");
  await run.keys("1");
  expect(clips(run)).toEqual(["https://next.test/a"]);
});

it("a target ending at the last terminal column is not offered", async () => {
  const url = "https://example.org/";
  const run = await start(`${url}${"a".repeat(58 - url.length)}\r\n\r\nhttps://next.test/a\r`);
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 6)).toBe("https");
  await run.keys("1");
  expect(clips(run)).toEqual(["https://next.test/a"]);
});

it("hard breaks in an attach replay do not turn a wrapped URL fragment into a hint", async () => {
  const broken = [WRAPPED_URL.slice(0, 58), WRAPPED_URL.slice(58)];
  const run = await start(`${broken.join("\r\n")} https://next.test/a\r`);
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[3]?.slice(1, 9)).toBe("g/seg/se");
  await run.keys("1");
  expect(clips(run)).toEqual(["https://next.test/a"]);
});

it("replay fragments starting with a wide letter also get no hint", async () => {
  const run = await start(`./${"directory/".repeat(5)}abcde\r\n한글/파일.ts https://next.test/a\r`);
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[3]?.slice(1, 3)).toBe("한글");
  await run.keys("1");
  expect(clips(run)).toEqual(["https://next.test/a"]);
});

it("a hint scan draws only the first nine of twelve targets", async () => {
  const run = await start(Array.from({ length: 6 }, (_, i) => `https://a.test/${2 * i} https://b.test/${2 * i + 1}`).join("\r\n"));
  await run.keys("f");
  await run.advance(10);
  const labels = run.grid().slice(2, 8).flatMap((row) => [...row.matchAll(/(\d+)ttps:/g)].map((at) => at[1]));
  expect(labels).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  expect(run.grid()[6]).toContain(" https://b.test/9 ");
  expect(run.grid()[7]).toContain("|https://a.test/10 https://b.test/11 ");
});

it("a target cut by a narrower viewer has no hint", async () => {
  const run = await start(`${" ".repeat(46)}https://example.org/hidden\r\nhttps://next.test/a\r`);
  const rival = new Stage(run.core).rival();
  try {
    await run.keys("q");
    await rival.attach("t1", 80, 10);
    await run.advance(300);
    await run.live();
    expect(run.loop.panes.view("t1")?.actual).toEqual({ cols: 80, rows: 10 });
    await run.keys("ctrl+b,[,f");
    await run.advance(10);
    expect(run.grid()[2]?.slice(47, 52)).toBe("https");
    expect(run.grid()[3]?.slice(1, 6)).toBe("1ttps");
    await run.keys("1");
    expect(clips(run)).toEqual(["https://next.test/a"]);
  } finally {
    await rival.detach();
    rival.close();
  }
});

it("a wrapped target cut below a taller viewer's visible clip has no hint", async () => {
  const run = await start(`https://next.test/a\r\n${"padding\r\n".repeat(8)}${WRAPPED_URL}\r\nTAIL\r`);
  const rival = new Stage(run.core).rival();
  try {
    await run.keys("q");
    await rival.attach("t1", 58, 20);
    await run.advance(300);
    await run.live();
    expect(run.loop.panes.view("t1")?.actual).toEqual({ cols: 58, rows: 20 });
    await run.keys("ctrl+b,[,g,f");
    await run.advance(10);
    expect(run.grid()[2]?.slice(1, 6)).toBe("1ttps");
    expect(run.grid()[11]?.slice(1, 6)).toBe("https");
    await run.keys("2");
    expect(clips(run)).toEqual([]);
  } finally {
    await rival.detach();
    rival.close();
  }
});

it.each([
  // a terminal taller than its cells is drawn clipped round the program's cursor; copy mode at the oldest row draws its top
  ["rows", [58, 20], `first\r\n${"padding\r\n".repeat(12)}last\r`, "g", "padding", "first"],
  // a terminal wider than its cells is drawn from its first column; copy mode at a row's end draws that end
  ["columns", [80, 10], `LEFT-${".".repeat(17)}RIGHT-${"-".repeat(45)}THE-END\r`, "$", "LEFT-", "RIGHT"],
] as const)("a drag read with the key that left copy mode selects the cells copy mode last drew, not the clip a later frame draws: %s", async (_clipped, [cols, rows], paint, move, before, drawn) => {
  const run = await start(paint);
  const rival = new Stage(run.core).rival();
  try {
    await run.keys("q");
    await rival.attach("t1", cols, rows);
    await run.advance(300);
    await run.live();
    expect(run.grid()[2]?.slice(1, 1 + before.length)).toBe(before);
    await run.keys(`ctrl+b,[,${move}`);
    await run.advance(10);
    expect(run.grid()[2]?.slice(1, 6)).toBe(drawn);
    // no frame between the reads: the mouse lands on what the host still shows
    await run.keys("q,press@1:2,drag@5:2,release@5:2");
    expect(clips(run)).toEqual([drawn]);
  } finally {
    await rival.detach();
    rival.close();
  }
});

it.each([
  ["a press its program got is released there as copy mode takes over, and the release read in copy mode goes nowhere",
    ["press@4:4", "ctrl+b", "[", "release@4:4", "q", "Z"], "\x1b[<0;4;3M\x1b[<0;4;3mZ"],
  ["a drag its program got is released at the last cell it reached",
    ["press@4:4", "drag@6:4", "ctrl+b", "[", "release@8:4", "q", "Z"], "\x1b[<0;4;3M\x1b[<32;6;3M\x1b[<0;6;3mZ"],
  ["a press that began in copy mode reaches the program neither there nor at its release after copy mode",
    ["press@4:4", "ctrl+b", "[", "release@4:4", "press@6:4", "q", "release@6:4", "Z"], "\x1b[<0;4;3M\x1b[<0;4;3mZ"],
] as const)("copy mode entered over a held mouse button: %s", async (_name, keys, wire) => {
  // read whole, a read a key, and a read a key with a frame after each: the program is sent the same bytes
  for (const reads of ["one read", "a read each", "a frame after each"] as const) {
    const run = await start("\x1b[?1002h\x1b[?1006hpane\r");
    await run.keys("q");
    if (reads === "one read") run.type(keys.map(keyBytes).join(""));
    else {
      for (const key of keys) {
        await run.keys(key);
        if (reads === "a frame after each") await run.advance(FRAME_PASS_MS);
      }
    }
    // and nothing more once the next frame is drawn
    await run.advance(FRAME_PASS_MS);
    expect([reads, data(run).join("")]).toEqual([reads, wire]);
  }
});

it("copy mode refused over a held mouse button takes nothing over: the drag and its release go on to the program", async () => {
  const run = await start("\x1b[?1002h\x1b[?1006hpane\r");
  await run.keys("q");
  // inside the program's synchronized update copy mode does not start
  run.core.program("t1").output("\x1b[?2026h");
  await run.advance(10);
  await run.keys("press@4:4,ctrl+b,[,drag@6:4,release@6:4");
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(data(run).join("")).toBe("\x1b[<0;4;3M\x1b[<32;6;3M\x1b[<0;6;3m");
});

it("copy consumes a click on the other pane", async () => {
  const run = await start("first\r", "second\r");
  await run.keys("click@100:4");
  expect(run.loop.model().mode.name).toBe("copy");
  await run.keys("q,Z");
  expect(run.core.program("t1").receivedHex()).toBe("5a");
  expect(run.core.program("t2").receivedHex()).toBe("");
});

it("copy blocks an external menu action", async () => {
  const run = await start();
  const menu = () => run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
  menu();
  expect(run.loop.model().overlays).toEqual([]);
  await run.keys("q");
  menu();
  expect(run.loop.model().overlays.at(-1)?.kind).toBe("menu");
});

it("an explicit focus move ends copy and sends the next key to the new pane", async () => {
  const run = await start(HISTORY, "second\r");
  await run.keys("g,V");
  run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
  await run.keys("y");
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(clips(run)).toEqual([]);
  expect(run.core.program("t1").receivedHex()).toBe("");
  expect(run.core.program("t2").receivedHex()).toBe("79");
});

it.each([
  ["balanced", "https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
  ["outer punctuation", "(see https://example.org/a)", "https://example.org/a"],
])("copy hints keep only URL parentheses that belong to the target: %s", async (_kind, line, target) => {
  const run = await start(line);
  await run.keys("f");
  await run.advance(10);
  await run.keys("1");
  expect(clips(run)).toEqual([target]);
});

it("hint labels skip malformed schemes and copy extensionless paths literally", async () => {
  const run = await start("javascript://host/src/a.ts https:// /var/log/messages\r");
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 54)).toBe("javascript://host/src/a.ts https:// 1var/log/messages");
  await run.keys("1");
  expect(clips(run)).toEqual(["/var/log/messages"]);
});

it("half pages scroll the viewport while the cursor can still be visible", async () => {
  const run = await start();
  await run.keys("ctrl+u");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 7)).toBe("row-17");
  await run.keys("ctrl+d");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 7)).toBe("row-22");
});

it("repeated cancels and re-entry never reuse the previous selection or query", async () => {
  const run = await start();
  await run.keys("g,V,/,needle,esc");
  await run.advance(160);
  await run.keys("ctrl+b,[,n,y,q,ctrl+b,[,v,y");
  expect(clips(run)).toEqual(["a"]);
  expect(data(run)).toEqual([]);
});

it("copy swallows commands while synchronized output hides the new cells", async () => {
  const run = await start();
  run.core.program("t1").output("\x1b[?2026hNEW");
  await run.advance(10);
  await run.keys("v,y");
  expect(run.loop.model().mode.name).toBe("copy");
  expect(clips(run)).toEqual([]);
  expect(data(run)).toEqual([]);
});
