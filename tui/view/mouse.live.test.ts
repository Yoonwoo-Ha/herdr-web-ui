import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { coreFolder, IsolatedCore, type StopReport, stoppedCleanly } from "../../scripts/test-hc.ts";
import { HcConnection } from "../../server/herdr-core/connection.ts";
import { openEventStream } from "../../server/herdr-core/event-stream.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { keyBytes } from "../testing/keys.ts";
import { runSupervised, stopAllPtyRuns, type SupervisedRun } from "../testing/pty.ts";
import { selectionColors } from "./chrome.ts";

/**
 * The real entry (`bun tui/main.ts`) on a real pseudo-terminal against a real hc in a core of the test's own, with SGR
 * mouse reports typed into the pty as a terminal sends them. In the pane runs a small program that writes every byte it
 * reads to a file and prints its hex: one that asked for mouse reporting gets the click in its own cells; with shift, or
 * from a program that asked for none, a drag sends it nothing and the selection reaches the host as OSC 52. Runs only
 * where OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const ENTRY = join(import.meta.dir, "..", "main.ts");
/** how long one step of the real screen and core may take on a pinned, loaded machine */
const WAIT_MS = 30_000;
/** above twice the helper's own 10 s wait for a stopped core, and the waits of every run */
const TEST_MS = 300_000;
const DETACH = "\x02q";
/** what the host writes when it gives the terminal back (tui/host/guard.ts LEAVE): exactly once per run */
const LEAVE = "\x1b[<u\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l";
const ANSWERS: [query: string, answer: string][] = [["\x1b[c", "\x1b[?62;22c"], ["\x1b[?2026$p", "\x1b[?2026;2$y"]];
const hex = (text: string): string => Buffer.from(text, "latin1").toString("hex");
const osc52Of = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x1b\\`;
/** the pane's text drawn selected by the mouse: on the selection's background (the run's host is dark and truecolor) */
const SELECTED = (() => {
  const { bg } = selectionColors("dark", "truecolor");
  if (typeof bg === "number") throw new Error("a truecolor host draws the selection in RGB");
  return new RegExp(`\\x1b\\[0;[\\d;:]*48;2;${bg[0]};${bg[1]};${bg[2]}mSELECT-ME`);
})();

/**
 * The pane's program: raw input, each read appended to `file` and printed as `IN:<hex>`; after a read that holds a
 * mouse release it prints `UP:<releases so far>`, a line short enough for any pane (an `IN:` line of a press and a
 * release read at once is wider than a half-width pane, which draws it on two rows). `mouse` "1" turns mouse
 * reporting on at its first read, "2" at its start, "0" never.
 */
const PROGRAM = `
const [file, mouse] = process.argv.slice(2);
const { appendFileSync } = require("node:fs");
process.stdin.setRawMode(true);
process.stdout.write(mouse === "1" ? "TYPE-G\\r\\n" : mouse === "2" ? "\\x1b[?1000h\\x1b[?1006hMOUSE-ON\\r\\n" : "SELECT-ME\\r\\n");
let first = true;
let releases = 0;
process.stdin.on("data", (bytes) => {
  appendFileSync(file, bytes);
  process.stdout.write("IN:" + Buffer.from(bytes).toString("hex") + "\\r\\n");
  const released = (Buffer.from(bytes).toString("latin1").match(/\\x1b\\[<[0-9;]*m/g) || []).length;
  if (released) process.stdout.write("UP:" + (releases += released) + "\\r\\n");
  if (first && mouse === "1") process.stdout.write("\\x1b[?1000h\\x1b[?1006hMOUSE-READY\\r\\n");
  first = false;
});
`;

describe.skipIf(!bin || process.platform === "win32")("the mouse at the screen's entry against a real hc", () => {
  const cores: IsolatedCore[] = [];
  const lines: HcConnection[] = [];
  let teardown: Promise<StopReport[]> | null = null;
  const stopAll = () => (teardown ??= (async () => {
    await stopAllPtyRuns();
    for (const line of lines) line.close();
    const reports: StopReport[] = [];
    for (const core of cores) reports.push(await core.stop());
    return reports;
  })());
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => { void stopAll().finally(() => process.exit(128 + constants.signals[signal])); };
  for (const signal of SIGNALS) process.once(signal, onSignal);

  afterAll(async () => {
    const reports = await stopAll();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    expect(reports.map(stoppedCleanly)).toEqual(cores.map(() => true));
  }, TEST_MS);

  /** A core of its own with the program in one pane; the file the program writes what it reads to. */
  async function coreWithProgram(mouse: boolean): Promise<{ core: IsolatedCore; hc: HcConnection; root: string; file: string; run: (name: string, mouse: "0" | "1" | "2", tab: string) => Promise<string> }> {
    const folder = coreFolder();
    const started = new IsolatedCore(bin!, folder);
    cores.push(started);
    await started.start();
    const hc = new HcConnection(await connectCoreSocket(started.socket).then((transport) => () => transport));
    lines.push(hc);
    const script = join(folder.root, "echo-in.cjs");
    writeFileSync(script, PROGRAM);
    /** the program in a new pane of tab `tab`, writing what it reads to a file of its own */
    const run = async (name: string, mouse: "0" | "1" | "2", tab: string): Promise<string> => {
      const file = join(folder.root, `${name}.bin`);
      writeFileSync(file, "");
      await hc.call("terminal.run", { argv: [process.execPath, script, file, mouse], labels: { [SPACE_LABEL]: "w-live", [TAB_LABEL]: tab, [TAB_NAME_LABEL]: tab }, cwd: folder.root });
      return file;
    };
    const file = await run("got", mouse ? "1" : "0", "one");
    return { core: started, hc, root: folder.root, file, run };
  }

  /** The entry on a 100x30 pty in the core's environment: its one pane's program shows in cells x 26-98, y 1-29 (no border on a tab's only pane, its scrollbar column at x 99). */
  function screen(isolated: IsolatedCore, root: string): SupervisedRun {
    const env = { ...isolated.env, TERM: "xterm-256color", COLORTERM: "truecolor", OVIS_TUI_STATE_DIR: join(root, "tui-state"), TMPDIR: root };
    let tail = "";
    const run: SupervisedRun = runSupervised({
      entry: [process.execPath, ENTRY], env, cols: 100, rows: 30, deadlineMs: WAIT_MS * 4,
      onData: (text) => {
        const window = tail + text;
        const asked: [at: number, answer: string][] = [];
        for (const [query, answer] of ANSWERS) {
          for (let at = window.indexOf(query); at !== -1; at = window.indexOf(query, at + 1)) if (at + query.length > tail.length) asked.push([at, answer]);
        }
        for (const [, answer] of asked.sort((a, b) => a[0] - b[0])) run.type(answer);
        tail = window.slice(-16);
      },
    });
    return run;
  }

  const type = (run: SupervisedRun, list: string) => run.type(list.split(",").map(keyBytes).join(""));

  it("a program that asked for the mouse gets a click in its own cells; with shift a drag sends it nothing and copies", async () => {
    const { core, root, file } = await coreWithProgram(true);
    const run = screen(core, root);
    await run.until(/TYPE-G[\s\S]*\x1b\[\?25h/, "the live pane");
    type(run, "g");
    await run.until("MOUSE-READY", "the program's mouse mode");
    // screen cell (31, 4) is the program's cell (5, 3): SGR counts from 1
    type(run, "click@31:4");
    await run.until(/IN:[0-9a-f]*6d/, "the click's release at the program");
    expect(readFileSync(file, "latin1")).toBe("g\x1b[<0;6;4M\x1b[<0;6;4m");
    // MOUSE-READY is the program's row 2: screen row 3, cells 26-36
    type(run, "shift+press@26:3,shift+drag@36:3,shift+release@36:3");
    await run.until(osc52Of("MOUSE-READY"), "the copy at the host");
    type(run, "z");
    await run.until(`IN:${hex("z")}`, "the key after the drag");
    expect(readFileSync(file, "latin1")).toBe("g\x1b[<0;6;4M\x1b[<0;6;4mz");
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("a program that asked for no mouse gets nothing from a press and drag, which selects and copies", async () => {
    const { core, root, file } = await coreWithProgram(false);
    const run = screen(core, root);
    await run.until(/SELECT-ME[\s\S]*\x1b\[\?25h/, "the live pane");
    type(run, "press@26:1,drag@34:1,release@34:1");
    await run.until(osc52Of("SELECT-ME"), "the copy at the host");
    type(run, "q");
    await run.until(`IN:${hex("q")}`, "the key after the drag");
    expect(readFileSync(file, "latin1")).toBe("q");
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("a click on the pane without focus only focuses it; a divider drag writes the core's layout document; a tab click shows that tab", async () => {
    const { core, hc, root, file, run: start } = await coreWithProgram(true);
    const second = await start("second", "2", "one");
    await start("third", "0", "two");
    let written: (() => void) | null = null;
    const wrote = new Promise<void>((resolve) => { written = resolve; });
    const events = openEventStream(hc, {
      event: (event) => { if (event.type === "doc" && event.data?.["name"] === OVIS_LAYOUT_DOC) written?.(); },
      resync: () => {},
      tooLong: () => {},
    });
    const run = screen(core, root);
    // the panes region is x 26-99: t1's box x 26-62, t2's x 63-99, the divider at x 62-63
    await run.until(/TYPE-G[\s\S]*\x1b\[\?25h/, "the panes live");
    await run.until("MOUSE-ON", "the second program's mouse mode");
    // the second pane's program asked for the mouse: the first click only focuses it, the second reaches it in its cells
    type(run, "click@71:5");
    type(run, "click@71:5");
    await run.until("UP:1", "the second click at the second program");
    expect(readFileSync(second, "latin1")).toBe("\x1b[<0;8;4M\x1b[<0;8;4m");
    expect(readFileSync(file, "latin1")).toBe("");
    // the divider dragged from x 62 to x 52: the first side is 27 of 74 columns
    type(run, "press@62:10,drag@52:10,release@52:10");
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([wrote, new Promise<never>((_, reject) => { bound = setTimeout(() => reject(new Error("no write of the layout document")), WAIT_MS); })]);
    clearTimeout(bound);
    const doc = await hc.call("doc.get", { name: OVIS_LAYOUT_DOC });
    const tab = (doc.value as { workspaces: { tabs: { id: string; root: { ratio?: number } }[] }[] }).workspaces[0]!.tabs.find((one) => one.id === "one")!;
    expect(tab.root.ratio).toBe(27 / 74);
    // the drag reached the divider alone, and no click came after the one the program got
    expect(readFileSync(second, "latin1")).toBe("\x1b[<0;8;4M\x1b[<0;8;4m");
    // the tab bar: "  one     two   " from x 26
    type(run, "click@37:0");
    await run.until("SELECT-ME", "the second tab's pane");
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
    (await events).channel.close();
  }, TEST_MS);

  it("a signal in the middle of a drag or with a selection held gives the terminal back cooked, once", async () => {
    const { core, hc, root, run: start } = await coreWithProgram(false);
    // a second pane beside the first: t1's box x 26-62 (its text from x 27, y 2), the divider at x 62-63; the selections stay in t1
    await start("second", "0", "one");
    // the screen writes the layout document only for a divider drag: its event says the drag was taken in
    let written: (() => void) | null = null;
    const events = await openEventStream(hc, {
      event: (event) => { if (event.type === "doc" && event.data?.["name"] === OVIS_LAYOUT_DOC) written?.(); },
      resync: () => {},
      tooLong: () => {},
    });
    const codes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
    for (const [signal, keys] of [["SIGTERM", "press@27:2,drag@35:2"], ["SIGINT", "press@27:2,drag@35:2,release@35:2"], ["SIGHUP", "press@62:10,drag@52:10"]] as const) {
      const run = screen(core, root);
      await run.until(/SELECT-ME[\s\S]*\x1b\[\?25h/, "the live pane");
      const wrote = new Promise<void>((resolve) => { written = resolve; });
      type(run, keys);
      if (signal === "SIGINT") await run.until(osc52Of("SELECT-ME"), "the copy at the host");
      // the selection drawn on its own background (herdr's look for a mouse selection): no frame before the drag has it
      else if (signal === "SIGTERM") await run.until(SELECTED, "the selection drawn");
      else {
        let bound: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([wrote, new Promise<never>((_, reject) => { bound = setTimeout(() => reject(new Error("no write of the layout document")), WAIT_MS); })]);
        clearTimeout(bound);
        const doc = await hc.call("doc.get", { name: OVIS_LAYOUT_DOC });
        expect((doc.value as { workspaces: { tabs: { id: string; root: { ratio?: number } }[] }[] }).workspaces[0]!.tabs.find((one) => one.id === "one")!.root.ratio).toBe(27 / 74);
      }
      written = null;
      run.signal(signal);
      const end = await run.ended;
      expect([signal, end.code, end.after?.canonical, end.after?.echo]).toEqual([signal, codes[signal], true, true]);
      expect([signal, run.output().split(LEAVE).length - 1]).toEqual([signal, 1]);
    }
    events.channel.close();
  }, TEST_MS);
});
