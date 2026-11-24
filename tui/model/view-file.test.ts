import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC, OVIS_LAYOUT_SCHEMA } from "../../server/herdr-core/layout-doc.ts";
import { agents } from "../testing/fixtures/agents.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";
import { type ViewFiles, ViewStore } from "../view-store.ts";
import { FIRST_CLAIM_MS } from "./deadlines.ts";
import { type Focus, nextFocus, type World } from "./focus.ts";
import { initialState, type ModelState, reduce } from "./reduce.ts";
import { readView, restoredFocus, VIEW_FILE_MAX_BYTES, type ViewProblem, viewText } from "./view-file.ts";

const TEST_MS = 120_000;
/** how long the child that opens a FIFO in the view file's place may take; it starts in well under a second */
const PROBE_DEADLINE_MS = 20_000;
const folders: string[] = [];
const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function scratch(): string {
  const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "view-file-"));
  folders.push(folder);
  return folder;
}

const pane = (id: string, created?: number) => ({ id, name: `name of ${id}`, ...(created === undefined ? {} : { created }) });
const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [pane("p1", 1), pane("p2", 2), pane("p3", 3)] }, { id: "t2", name: "b", panes: [pane("p4", 4)] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [pane("p5", 5)] }] },
  ],
};
const AT_P2: Focus = { workspace: "w1", tabs: { w1: "t1", w2: "t3" }, panes: { t1: "p2", t2: "p4", t3: "p5" }, previous: null };

const saved = (world: World, focus: Focus) => {
  const read = readView(viewText(world, focus)!);
  if (!("view" in read)) throw new Error(`not read: ${read.problem}`);
  return read.view;
};
const without = (world: World, gone: string): World => ({
  workspaces: world.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, panes: tab.panes.filter((one) => one.id !== gone) })) })),
});
const stateOf = (world: World, focus: Focus): ModelState => ({ ...reduce(initialState(undefined), { type: "world", world, at: 0 }).state, focus });

describe("what the view file holds", () => {
  it("ids only: the focus and the workspaces, tabs and terminals it was taken among, with no name", () => {
    expect(JSON.parse(viewText(WORLD, AT_P2)!)).toEqual({
      v: 1,
      focus: { workspace: "w1", tabs: { w1: "t1", w2: "t3" }, panes: { t1: "p2", t2: "p4", t3: "p5" }, previous: null },
      world: [
        { id: "w1", tabs: [{ id: "t1", panes: [{ id: "p1", created: 1 }, { id: "p2", created: 2 }, { id: "p3", created: 3 }] }, { id: "t2", panes: [{ id: "p4", created: 4 }] }] },
        { id: "w2", tabs: [{ id: "t3", panes: [{ id: "p5", created: 5 }] }] },
      ],
    });
    expect(viewText(WORLD, AT_P2)).not.toContain("name of");
  });

  it("nothing to keep when no pane shows", () => {
    expect(viewText({ workspaces: [] }, AT_P2)).toBeNull();
    expect(viewText({ workspaces: [{ id: "w1", name: "", tabs: [] }] }, AT_P2)).toBeNull();
  });

  it("a file this screen did not write is no view, and the problem is named", () => {
    const valid = JSON.parse(viewText(WORLD, AT_P2)!);
    const table: [name: string, text: string, problem: ViewProblem][] = [
      ["not JSON", "{\"v\":1,", "not_json"],
      ["another version's", JSON.stringify({ ...valid, v: 2 }), "version"],
      ["no version", JSON.stringify({ focus: valid.focus, world: valid.world }), "version"],
      ["a list", "[]", "shape"],
      ["a focus id that is no string", JSON.stringify({ ...valid, focus: { ...valid.focus, workspace: 7 } }), "shape"],
      ["an empty id", JSON.stringify({ ...valid, focus: { ...valid.focus, panes: { t1: "" } } }), "shape"],
      ["an id of 257 characters", JSON.stringify({ ...valid, focus: { ...valid.focus, previous: "x".repeat(257) } }), "shape"],
      ["a pane without an id", JSON.stringify({ ...valid, world: [{ id: "w1", tabs: [{ id: "t1", panes: [{ created: 1 }] }] }] }), "shape"],
      ["a created time that is no number", JSON.stringify({ ...valid, world: [{ id: "w1", tabs: [{ id: "t1", panes: [{ id: "p1", created: "1" }] }] }] }), "shape"],
    ];
    for (const [name, text, problem] of table) expect({ name, read: readView(text) }).toEqual({ name, read: { problem } });
  });
});

describe("reopening the same place", () => {
  it("a rerun with the saved file focuses the same pane", () => {
    expect(restoredFocus(saved(WORLD, AT_P2), WORLD)).toEqual({ focus: AT_P2, moved: false });
  });

  it("a saved pane that no longer exists falls back by the next-focus function: the next pane of its tab in tree order", () => {
    const now = without(WORLD, "p2");
    const back = restoredFocus(saved(WORLD, AT_P2), now);
    expect(back).toEqual({ focus: { ...AT_P2, panes: { ...AT_P2.panes, t1: "p3" } }, moved: true });
    expect(back.focus).toEqual(nextFocus(saved(WORLD, AT_P2).world, now, AT_P2));
  });

  it("a saved pane gone gives way to the saved previous pane while that one lives", () => {
    const back = restoredFocus(saved(WORLD, { ...AT_P2, previous: "p1" }), without(WORLD, "p2"));
    expect(back.focus.panes["t1"]).toBe("p1");
    expect(back.moved).toBe(true);
  });

  it("a saved workspace gone: the next workspace, with its own remembered tab and pane", () => {
    const now: World = { workspaces: [WORLD.workspaces[1]!] };
    expect(restoredFocus(saved(WORLD, AT_P2), now)).toEqual({ focus: { workspace: "w2", tabs: { w2: "t3" }, panes: { t3: "p5" }, previous: null }, moved: true });
  });

  it("an address the core now gives a newer terminal counts as gone", () => {
    const reused: World = { workspaces: [{ ...WORLD.workspaces[0]!, tabs: [{ id: "t1", name: "a", panes: [pane("p1", 1), pane("p2", 99), pane("p3", 3)] }, WORLD.workspaces[0]!.tabs[1]!] }, WORLD.workspaces[1]!] };
    expect(restoredFocus(saved(WORLD, AT_P2), reused)).toEqual({ focus: { ...AT_P2, panes: { ...AT_P2.panes, t1: "p3" } }, moved: true });
  });

  it("the reducer applies a kept view once the world has something in it, and says so when the place moved", () => {
    const empty = initialState(undefined);
    const waiting = reduce(empty, { type: "restore", core: "A", view: saved(WORLD, AT_P2), problem: null, at: 1 }).state;
    expect(waiting.restoring).not.toBeNull();
    const shown = reduce(waiting, { type: "world", core: "A", world: WORLD, at: 2 }).state;
    expect([shown.restoring, shown.focus, shown.notices]).toEqual([null, AT_P2, []]);
    const moved = reduce(waiting, { type: "world", core: "A", world: without(WORLD, "p2"), at: 2 }).state;
    expect([moved.focus.panes["t1"], moved.notices.map((notice) => [notice.code, notice.calm])]).toEqual(["p3", [["view_moved", true]]]);
  });

  it("a file that could not be used is said so, and the screen opens where it would without one", () => {
    const base = stateOf(WORLD, { workspace: null, tabs: {}, panes: {}, previous: null });
    const step = reduce(base, { type: "restore", core: "A", view: null, problem: "not_json", at: 1 }).state;
    expect([step.focus, step.notices.map((notice) => [notice.code, notice.data, notice.calm])]).toEqual([base.focus, [["view_unread", { reason: "not_json" }, true]]]);
  });

  it("an unidentified replacement snapshot neither consumes nor reports a move for the old core's view", () => {
    const waiting = reduce(initialState(undefined), { type: "restore", core: "A", view: saved(WORLD, AT_P2), problem: null, at: 0 }).state;
    const replacement = reduce(waiting, { type: "world", core: null, world: without(WORLD, "p2"), at: 1 }).state;
    expect(replacement.notices).toEqual([]);
    expect(replacement.restoring?.core).toBe("A");
    const same = reduce(replacement, { type: "restore", core: "A", view: null, problem: null, at: 2 }).state;
    expect([same.focus.panes["t1"], same.notices.map(({ code }) => code)]).toEqual(["p3", ["view_moved"]]);
    const other = reduce(replacement, { type: "restore", core: "B", view: null, problem: null, at: 2 }).state;
    expect([other.focus.panes["t1"], other.notices, other.restoring]).toEqual(["p1", [], null]);
  });
});

describe("the file on disk", () => {
  it("one file per core id, named by the id when it is a plain word and by its hash otherwise", () => {
    const named = (core: string): string[] => {
      const folder = scratch();
      const store = new ViewStore(folder);
      store.open(core);
      store.keep(stateOf(WORLD, AT_P2));
      return readdirSync(folder);
    };
    expect(named("c0ffee-01_A")).toEqual(["view-c0ffee-01_A.json"]);
    for (const core of ["../../etc/passwd", "x".repeat(65), "한글"]) expect({ core, files: named(core).map((file) => /^view-[0-9a-f]{32}\.json$/.test(file)) }).toEqual({ core, files: [true] });
  });

  it("the view is read once per core id: the same core again reads nothing, another core reads its own file", () => {
    const folder = scratch();
    const [writer, reader] = [new ViewStore(folder), new ViewStore(folder)];
    for (const core of ["core1", "core2"]) {
      writer.open(core);
      writer.keep(stateOf(WORLD, core === "core1" ? AT_P2 : { ...AT_P2, workspace: "w2" }));
    }
    expect(reader.open("core1").view?.focus.workspace).toBe("w1");
    writer.open("core1");
    writer.keep(stateOf(WORLD, { ...AT_P2, panes: { ...AT_P2.panes, t1: "p1" } }));
    expect(reader.open("core1")).toEqual({ view: null, problem: null });
    expect(reader.open("core2").view?.focus.workspace).toBe("w2");
  });

  it("written by rename: the file 0600 in a 0700 folder, nothing else left there", () => {
    const folder = join(scratch(), "state");
    const store = new ViewStore(folder);
    expect(store.open("core1")).toEqual({ view: null, problem: null });
    expect(store.keep(stateOf(WORLD, AT_P2))).toBeNull();
    expect(store.keep(stateOf(WORLD, { ...AT_P2, workspace: "w2" }))).toBeNull();
    expect(readdirSync(folder)).toEqual(["view-core1.json"]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "view-core1.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(folder, "view-core1.json"), "utf8")).focus.workspace).toBe("w2");
  });

  it("written only when what it holds changed: the same view again writes nothing", () => {
    const folder = scratch();
    const store = new ViewStore(folder);
    store.open("core1");
    store.keep(stateOf(WORLD, AT_P2));
    const first = statSync(join(folder, "view-core1.json")).ino;
    for (let n = 0; n < 5; n++) store.keep({ ...stateOf(WORLD, AT_P2), nextNotice: n });
    expect(statSync(join(folder, "view-core1.json")).ino).toBe(first);
    store.keep(stateOf(WORLD, { ...AT_P2, panes: { ...AT_P2.panes, t1: "p3" } }));
    expect(statSync(join(folder, "view-core1.json")).ino).not.toBe(first);
  });

  it("nothing is written before the core is known, nor while a kept view waits to be applied", () => {
    const folder = scratch();
    const store = new ViewStore(folder);
    store.keep(stateOf(WORLD, AT_P2));
    expect(readdirSync(folder)).toEqual([]);
    store.open("core1");
    store.keep({ ...stateOf(WORLD, AT_P2), restoring: { core: "core1", view: saved(WORLD, AT_P2) } });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("two screens on one core share the file and the last writer wins", () => {
    const folder = scratch();
    const [one, two] = [new ViewStore(folder), new ViewStore(folder)];
    one.open("core1");
    two.open("core1");
    one.keep(stateOf(WORLD, AT_P2));
    two.keep(stateOf(WORLD, { ...AT_P2, workspace: "w2" }));
    expect(new ViewStore(folder).open("core1").view?.focus.workspace).toBe("w2");
    one.keep(stateOf(WORLD, { ...AT_P2, panes: { ...AT_P2.panes, t1: "p1" } }));
    expect(new ViewStore(folder).open("core1").view?.focus).toEqual({ ...AT_P2, panes: { ...AT_P2.panes, t1: "p1" } });
  });

  it("a corrupt or oversized file is no view and says why; a missing one is no problem", () => {
    const folder = scratch();
    writeFileSync(join(folder, "view-bad.json"), "{\"v\":1,\"focus\":");
    writeFileSync(join(folder, "view-big.json"), " ".repeat(VIEW_FILE_MAX_BYTES + 1));
    writeFileSync(join(folder, "view-edge.json"), `${viewText(WORLD, AT_P2)!}${" ".repeat(VIEW_FILE_MAX_BYTES - viewText(WORLD, AT_P2)!.length)}`);
    expect(new ViewStore(folder).open("bad")).toEqual({ view: null, problem: "not_json" });
    expect(new ViewStore(folder).open("big")).toEqual({ view: null, problem: "too_large" });
    expect(new ViewStore(folder).open("edge").view?.focus).toEqual(AT_P2);
    expect(new ViewStore(folder).open("none")).toEqual({ view: null, problem: null });
  });

  it("a FIFO, a link to /dev/zero or a folder in the file's place is refused at once and never read", async () => {
    const folder = scratch();
    const made = Bun.spawn(["mkfifo", join(folder, "view-fifo.json")], { env: { PATH: "/usr/bin:/bin" } });
    expect(await made.exited).toBe(0);
    symlinkSync("/dev/zero", join(folder, "view-zero.json"));
    mkdirSync(join(folder, "view-folder.json"));
    // the reads run in a child this test ends by its own handle at a deadline: an open that waited on the FIFO would
    // fail the test there, not hold the test run for ever
    const store = join(import.meta.dir, "..", "view-store.ts");
    const probe = Bun.spawn([process.execPath, "-e", [
      `const { ViewStore } = await import(${JSON.stringify(store)});`,
      `console.log(JSON.stringify(["fifo", "zero", "folder"].map((core) => new ViewStore(${JSON.stringify(folder)}).open(core))));`,
    ].join("\n")], { env: { PATH: "/usr/bin:/bin", HOME: folder, TMPDIR: folder }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_DEADLINE_MS, killSignal: "SIGKILL" });
    const [out, err, exit] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
    const refused = { view: null, problem: "not_a_file" };
    expect({ exit, signal: probe.signalCode, err, out }).toEqual({ exit: 0, signal: null, err: "", out: `${JSON.stringify([refused, refused, refused])}\n` });
  }, TEST_MS);

  it("the writer keeps the reader's limits: a file of 1 MiB and an id of 256 characters are written, one byte or character more is refused and the good file stays", () => {
    const folder = scratch();
    const file = join(folder, "view-core1.json");
    /** a view whose file is exactly `bytes` long: panes of 200-character ids, the last one's id sized to land on it */
    const sized = (bytes: number): ModelState => {
      const panes: { id: string; name: string }[] = [{ id: "p0", name: "" }];
      const world = (): World => ({ workspaces: [{ id: "w1", name: "", tabs: [{ id: "t1", name: "", panes }] }] });
      const focus: Focus = { workspace: "w1", tabs: { w1: "t1" }, panes: { t1: "p0" }, previous: null };
      const length = () => Buffer.byteLength(viewText(world(), focus)!);
      // each pane adds `,{"id":"<id>"}`: 10 bytes and its id; the last one's id is left 1 to 210 characters
      const count = Math.floor((bytes - length() - 11) / 210);
      for (let n = 0; n < count; n++) panes.push({ id: `${panes.length}-`.padEnd(200, "x"), name: "" });
      panes.push({ id: `${panes.length}-`.padEnd(bytes - length() - 10, "x"), name: "" });
      expect(length()).toBe(bytes);
      return stateOf(world(), focus);
    };
    const store = new ViewStore(folder);
    store.open("core1");
    const long = (chars: number) => stateOf(WORLD, { ...AT_P2, panes: { ...AT_P2.panes, ["t".repeat(chars)]: "p1" } });
    expect(store.keep(long(256))).toBeNull();
    expect(new ViewStore(folder).open("core1").view?.focus.panes["t".repeat(256)]).toBe("p1");
    const good = readFileSync(file, "utf8");
    expect(store.keep(long(257))).toBe("shape");
    expect(readFileSync(file, "utf8")).toBe(good);
    expect(store.keep(sized(VIEW_FILE_MAX_BYTES + 1))).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(good);
    expect(store.keep(sized(VIEW_FILE_MAX_BYTES))).toBeNull();
    expect([statSync(file).size, new ViewStore(folder).open("core1").problem]).toEqual([VIEW_FILE_MAX_BYTES, null]);
    // the first refusal is said, by the reader's own problem
    const fresh = new ViewStore(scratch());
    fresh.open("core1");
    expect(fresh.keep(sized(VIEW_FILE_MAX_BYTES + 1))).toBe("too_large");
  });

  describe("a write that fails part-way leaves the good file", () => {
    const DISK: ViewFiles = { write: (fd, bytes, offset) => writeSync(fd, bytes, offset), rename: renameSync, remove: (path) => rmSync(path, { force: true }) };
    /** a store over a folder that already holds a good file for core1 (AT_P2) */
    const withGood = (files: Partial<ViewFiles>) => {
      const folder = scratch();
      const before = new ViewStore(folder);
      before.open("core1");
      before.keep(stateOf(WORLD, AT_P2));
      const store = new ViewStore(folder, { ...DISK, ...files });
      store.open("core1");
      return { store, held: () => ({ files: readdirSync(folder), text: readFileSync(join(folder, "view-core1.json"), "utf8") }) };
    };
    const MOVED = { ...AT_P2, workspace: "w2" };

    it("a write that takes a few bytes at a time: the rest follows, and the whole view is renamed in", () => {
      const { store, held } = withGood({ write: (fd, bytes, offset) => writeSync(fd, bytes, offset, Math.min(7, bytes.length - offset)) });
      expect(store.keep(stateOf(WORLD, MOVED))).toBeNull();
      expect(held()).toEqual({ files: ["view-core1.json"], text: viewText(WORLD, MOVED)! });
    });

    it("a write that takes nothing more: refused by code, the good file kept, the temp file gone", () => {
      const { store, held } = withGood({ write: (fd, bytes, offset) => (offset === 0 ? writeSync(fd, bytes, 0, 7) : 0) });
      expect(store.keep(stateOf(WORLD, MOVED))).toBe("short_write");
      expect(held()).toEqual({ files: ["view-core1.json"], text: viewText(WORLD, AT_P2)! });
    });

    it("a rename that fails: refused by code, the good file kept, and the same view written once a rename works", () => {
      let failing = true;
      const { store, held } = withGood({
        rename: (from, to) => {
          if (failing) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          renameSync(from, to);
        },
      });
      expect(store.keep(stateOf(WORLD, MOVED))).toBe("EXDEV");
      expect(held()).toEqual({ files: ["view-core1.json"], text: viewText(WORLD, AT_P2)! });
      failing = false;
      expect(store.keep(stateOf(WORLD, MOVED))).toBeNull();
      expect(held()).toEqual({ files: ["view-core1.json"], text: viewText(WORLD, MOVED)! });
    });

    it("a rename that fails and a temp file that cannot be removed: the rename's code is said, nothing thrown", () => {
      const { store, held } = withGood({
        rename: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
        remove: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
      });
      expect(store.keep(stateOf(WORLD, MOVED))).toBe("EXDEV");
      const { files, text } = held();
      expect([files.length, text]).toEqual([2, viewText(WORLD, AT_P2)!]);
    });
  });

  it("a write that fails is told once, by its code", () => {
    const parent = scratch();
    const folder = join(parent, "file");
    writeFileSync(folder, "not a folder");
    const store = new ViewStore(folder);
    store.open("core1");
    expect(store.keep(stateOf(WORLD, AT_P2))).toBe("EEXIST");
    expect(store.keep(stateOf(WORLD, { ...AT_P2, workspace: "w2" }))).toBeNull();
  });
});

describe("a rerun of the screen on the same core", () => {
  async function first(core: FakeHcCore, folder: string, cols = 120, rows = 40): Promise<Run> {
    const run = await Run.start({ core, views: new ViewStore(folder), cols, rows });
    runs.push(run);
    await run.live();
    await run.advance(1);
    return run;
  }
  const close = async (run: Run) => {
    runs.splice(runs.indexOf(run), 1);
    await run.close();
  };

  it.each([45, 120])("an unchanged zoomed restart keeps remembered focus without view_moved at %s columns", async (cols) => {
    const folder = scratch();
    const core = new FakeHcCore();
    demo.build(core);
    const layout = (zoomed: string | null) => ({ schema: 1, workspaces: [{ id: "w-ovis", tabs: [{
      id: "t-main", root: { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } }, zoomed,
    }] }] });
    core.docs.set(OVIS_LAYOUT_DOC, { value: layout("t2"), version: 1 });
    const before = await first(core, folder, cols);
    expect(before.loop.model().focus.panes["t-main"]).toBe("t1");
    await close(before);
    const again = await first(core, folder, cols);
    expect(again.loop.panes.views().filter((view) => !view.covered).map((view) => view.terminal)).toEqual(["t2"]);
    expect(again.loop.model().notices.map((notice) => notice.code)).not.toContain("view_moved");
    expect(again.loop.model().focus.panes["t-main"]).toBe("t1");
    await again.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: layout(null), version: 1 });
    await again.advance(200);
    await again.live();
    again.type("z");
    await again.settle();
    expect(["t1", "t2"].map((id) => core.program(id).receivedHex())).toEqual(["7a", ""]);
  }, TEST_MS);

  it("a rerun with the saved file focuses the same pane, at 45 columns too, and its file holds nothing private", async () => {
    const folder = scratch();
    const core = new FakeHcCore();
    demo.build(core);
    const before = await first(core, folder);
    await before.keys("ctrl+b,n,ctrl+b,p,ctrl+b,tab");
    await before.live();
    await before.advance(1);
    await before.keys("typed-secret-1234");
    core.program("t2").output("printed-secret-5678\r\n");
    await before.advance(100);
    expect(before.loop.model().focus.panes["t-main"]).toBe("t2");
    await close(before);
    const files = readdirSync(folder);
    expect(files).toEqual(["view-fake0000.json"]);
    const text = readFileSync(join(folder, files[0]!), "utf8");
    // names would show as JSON strings ("ovis"); the ids of the fake core contain them (w-ovis), so the quotes count
    for (const secret of ["typed-secret", "printed-secret", "\"ovis\"", "\"main\"", "\"logs\"", "shell", "files", "문서", "안녕"]) expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
    const again = await first(core, folder, 45, 30);
    expect(again.loop.model().focus.panes["t-main"]).toBe("t2");
    expect(again.loop.panes.views().map((view) => view.terminal).sort()).toEqual(["t1", "t2"]);
    expect(again.loop.model().notices).toEqual([]);
  }, TEST_MS);

  it("a state folder that cannot be written: the screen says view_unread and view_unsaved, and works on", async () => {
    const folder = join(scratch(), "file");
    writeFileSync(folder, "not a folder");
    const core = new FakeHcCore();
    demo.build(core);
    const run = await first(core, folder);
    await run.keys("ctrl+b,n");
    await run.advance(1);
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-logs");
    expect(run.loop.model().notices.map((notice) => [notice.code, notice.data])).toEqual([["view_unread", { reason: "unreadable" }], ["view_unsaved", { reason: "EEXIST" }]]);
  }, TEST_MS);

  it("a line back to another core on the same socket never writes that core's world into the first core's file", async () => {
    const folder = scratch();
    const one = new FakeHcCore({ core: { id: "coreone", name: "one" } });
    demo.build(one);
    const run = await first(one, folder);
    await run.keys("ctrl+b,n");
    await run.advance(1);
    const kept = readFileSync(join(folder, "view-coreone.json"), "utf8");
    expect(JSON.parse(kept).focus.tabs["w-ovis"]).toBe("t-logs");
    await run.cutLine();
    await run.advance(1_000);
    const other = new FakeHcCore({ core: { id: "coretwo", name: "two" } });
    agents.build(other);
    const listener = await other.listen(run.socket);
    try {
      await run.advance(10_000);
      expect(run.loop.link.state).toMatchObject({ kind: "Online", epoch: 2 });
      expect(run.loop.model().focus.workspace).not.toBe("w-ovis");
      expect(readFileSync(join(folder, "view-coreone.json"), "utf8")).toBe(kept);
      // the second core's world went to its own file once its hello said whose it is
      expect(JSON.parse(readFileSync(join(folder, "view-coretwo.json"), "utf8")).focus.workspace).toBe(run.loop.model().focus.workspace);
    } finally {
      await close(run);
      await listener.close();
    }
  }, TEST_MS);

  it("a line back to the same core keeps writing its file, the change made while the line was down included", async () => {
    const folder = scratch();
    const core = new FakeHcCore();
    demo.build(core);
    const run = await first(core, folder);
    const file = () => JSON.parse(readFileSync(join(folder, "view-fake0000.json"), "utf8")).focus;
    await run.keys("ctrl+b,n");
    await run.advance(1);
    expect(file().tabs["w-ovis"]).toBe("t-logs");
    await run.cutLine();
    await run.advance(1_000);
    await run.keys("ctrl+b,n");
    await run.advance(1);
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-main");
    await run.listen();
    await run.advance(10_000);
    expect(run.loop.link.state).toMatchObject({ kind: "Online", epoch: 2 });
    expect(file().tabs["w-ovis"]).toBe("t-main");
    await run.keys("ctrl+b,n");
    await run.advance(1);
    expect(file().tabs["w-ovis"]).toBe("t-logs");
    expect(run.loop.model().notices.map((notice) => notice.code)).toEqual([]);
  }, TEST_MS);

  it("exiting offline keeps the tab selected on the last known core", async () => {
    const folder = scratch();
    const core = new FakeHcCore();
    demo.build(core);
    const before = await first(core, folder);
    await before.keys("ctrl+b,n");
    expect(before.loop.model().focus.tabs["w-ovis"]).toBe("t-logs");
    await before.cutLine();
    await before.advance(1_000);
    await before.keys("ctrl+b,n");
    expect(before.loop.link.state.kind).toBe("Offline");
    expect(before.loop.model().focus.tabs["w-ovis"]).toBe("t-main");
    await close(before);
    const again = await first(core, folder);
    expect(again.loop.model().focus.tabs["w-ovis"]).toBe("t-main");
  }, TEST_MS);

  it.each([["coreone", false], ["coretwo", false], ["coreone", true], ["coretwo", true]] as const)("an empty core's pending Logs view only follows its own core (reconnect: %s, initially empty: %s)", async (id, initiallyEmpty) => {
    const folder = scratch();
    const options = (id: string) => ({ core: { id, name: id } });
    const original = new FakeHcCore(options("coreone"));
    demo.build(original);
    const before = await first(original, folder);
    await before.keys("ctrl+b,n");
    await close(before);
    const file = join(folder, "view-coreone.json");
    const kept = readFileSync(file, "utf8");
    expect(JSON.parse(kept).focus.tabs["w-ovis"]).toBe("t-logs");
    // another screen holds the claim to open the first workspace (tui/core/layout.ts `claimFirst`): this one leaves the core empty
    const claimed = (core: FakeHcCore) => {
      core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: OVIS_LAYOUT_SCHEMA, workspaces: [], first_workspace: { opening: true, until: FIRST_CLAIM_MS } }, version: 1 });
      return core;
    };
    const empty = await Run.start({ core: claimed(new FakeHcCore(options("coreone"))), views: new ViewStore(folder) });
    runs.push(empty);
    expect(empty.loop.model().world.workspaces).toEqual([]);
    await empty.cutLine();
    await empty.advance(1_000);
    const other = id === "coreone" && !initiallyEmpty ? original : initiallyEmpty ? claimed(new FakeHcCore(options(id))) : new FakeHcCore(options(id));
    if (!initiallyEmpty && other !== original) demo.build(other); // another core can issue the same addresses
    const listener = await other.listen(empty.socket);
    try {
      await empty.advance(10_000);
      expect(empty.loop.link.state).toMatchObject({ kind: "Online", epoch: 2 });
      if (initiallyEmpty) {
        expect(empty.loop.model().world.workspaces).toEqual([]);
        demo.build(other);
        await empty.advance(100);
      }
      const tab = id === "coreone" ? "t-logs" : "t-main";
      expect(empty.loop.model().focus.tabs["w-ovis"]).toBe(tab);
      expect(JSON.parse(readFileSync(join(folder, `view-${id}.json`), "utf8")).focus.tabs["w-ovis"]).toBe(tab);
      if (id !== "coreone") expect(readFileSync(file, "utf8")).toBe(kept);
      // When A creates new terminals after its empty snapshot, their addresses match but their birth times do not.
      expect(empty.loop.model().notices.some(({ code }) => code === "view_moved")).toBe(initiallyEmpty && id === "coreone");
    } finally {
      await close(empty);
      await listener.close();
    }
  }, TEST_MS);

  it("the saved pane gone on the core: the screen opens on the next one and says so", async () => {
    const folder = scratch();
    const core = new FakeHcCore();
    demo.build(core);
    const before = await first(core, folder);
    await before.keys("ctrl+b,tab");
    await before.advance(1);
    await close(before);
    core.remove("t2");
    const again = await first(core, folder);
    await again.advance(10);
    expect(again.loop.model().focus.panes["t-main"]).toBe("t1");
    expect(again.loop.model().notices.map((notice) => notice.code)).toEqual(["view_moved"]);
    expect(again.grid().join("\n")).toContain("view_moved: the place this core was left at is gone");
  }, TEST_MS);
});
