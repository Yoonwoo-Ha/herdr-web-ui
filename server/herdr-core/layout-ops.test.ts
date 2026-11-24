import { describe, expect, it } from "bun:test";
import { HcError, type HcConnection } from "./connection.ts";
import { AdapterError } from "./errors.ts";
import type { OvisLayout } from "./layout-doc.ts";
import { type Edited, editLayout, LayoutStore, readCore, moveBesideEdit, ownsLayout, ratioEdit, resizeEdit, splitEdit, swapEdit, tabOrderEdit, workspaceOrderEdit, zoomEdit } from "./layout-ops.ts";
import { buildSnapshot, type HcTerminal, OTHER_WORKSPACE_ID } from "./snapshot.ts";

type Handler = (params: Record<string, unknown>) => unknown;

/** Workspace A holds tab A1 (t1 beside t2) and tab A2 (t3), B holds B1 (t4). */
const known = (zoomed: string | null = null): OvisLayout => ({ schema: 1, workspaces: [
  { id: "A", tabs: [
    { id: "A1", zoomed, root: { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } } },
    { id: "A2", zoomed: null, root: { leaf: "t3" } },
  ] },
  { id: "B", tabs: [{ id: "B1", zoomed: null, root: { leaf: "t4" } }] },
] });
const labeled = (address: string, space: string, tab: string): HcTerminal => ({ address, cols: 100, rows: 30, cwd: "/home/u", state: "live", labels: { "herdr.space": space, "herdr.tab": tab } });
const conflict = () => new HcError("conflict", "version 1 is not the document's");
/** One turn of the event loop: every answer already given has been read and acted on. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A core in process, in front of the store: terminals that follow their runs, labels and ends, and
 * documents written only at the version read. `hold` keeps a call's answer back until `release`;
 * any `doc.set` of the Herdr app's document is refused and counted.
 */
function fakeCore({ layout = known() as unknown, app = null as unknown, conflicts = 0 } = {}) {
  const terminals = [labeled("t1", "A", "A1"), labeled("t2", "A", "A1"), labeled("t3", "A", "A2"), labeled("t4", "B", "B1")];
  const docs = new Map<string, { value: unknown; version: number }>([["ovis-layout", { value: layout, version: 1 }], ["herdr-app", { value: app, version: app === null ? 0 : 1 }]]);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const appWrites: unknown[] = [];
  const held = new Map<string, (() => void)[]>();
  const holding = new Set<string>();
  const arrived = new Map<string, () => void>();
  let next = 10;
  let left = conflicts;
  const handlers: Record<string, Handler> = {
    "terminal.list": () => ({ terminals, hidden_finished: 0 }),
    "terminal.get": (params) => {
      const found = terminals.find((entry) => entry.address === params["terminal"]);
      if (!found) throw new HcError("not_found", `no terminal ${String(params["terminal"])}`);
      return found;
    },
    "doc.get": (params) => docs.get(String(params["name"])) ?? { value: null, version: 0 },
    "doc.set": (params) => {
      const name = String(params["name"]);
      if (name === "herdr-app") { appWrites.push(params["value"]); throw new HcError("refused", "Ovis never writes herdr-app"); }
      const stored = docs.get(name) ?? { value: null, version: 0 };
      if (left > 0) { left--; docs.set(name, { ...stored, version: stored.version + 1 }); throw conflict(); }
      if (params["version"] !== stored.version) throw conflict();
      docs.set(name, { value: params["value"], version: stored.version + 1 });
      return { version: stored.version + 1 };
    },
    "terminal.run": (params) => {
      const record: HcTerminal = { address: `t${next++}`, cols: 100, rows: 30, cwd: "/home/u", state: "live", labels: params["labels"] as Record<string, string> };
      terminals.push(record);
      return record;
    },
    "terminal.label": (params) => {
      const found = terminals.find((entry) => entry.address === params["terminal"])!;
      found.labels = Object.fromEntries(Object.entries({ ...found.labels, ...(params["labels"] as Record<string, string>) }).filter(([, value]) => value !== ""));
      return found;
    },
    "terminal.kill": (params) => ({ ...terminals.find((entry) => entry.address === params["terminal"]), state: "finished" }),
    "terminal.rm": (params) => {
      terminals.splice(terminals.findIndex((entry) => entry.address === params["terminal"]), 1);
      return { removed: params["terminal"] };
    },
  };
  const keyOf = (method: string, params: Record<string, unknown>) => (method.startsWith("doc.") ? `${method} ${String(params["name"])}` : method);
  const hc = {
    hello: async () => ({ version: "0.1.18", methods: Object.keys(handlers), features: [] }),
    call: (method: string, params: Record<string, unknown>) => {
      const key = keyOf(method, params);
      calls.push({ method, params });
      arrived.get(key)?.();
      const answer = () => new Promise((resolve) => resolve(handlers[method]!(params)));
      if (!holding.has(key)) return answer();
      return new Promise((resolve, reject) => held.set(key, [...held.get(key) ?? [], () => answer().then(resolve, reject)]));
    },
  };
  const store = new LayoutStore(hc as unknown as Pick<HcConnection, "call" | "hello">, {
    snapshot: async () => {
      const [list, appDoc, ovis] = await Promise.all([hc.call("terminal.list", {}), hc.call("doc.get", { name: "herdr-app" }), hc.call("doc.get", { name: "ovis-layout" })]) as [{ terminals: HcTerminal[] }, { value: unknown }, { value: unknown }];
      return { shown: buildSnapshot(list.terminals, appDoc.value, "0.1.18", undefined, ovis.value), own: ownsLayout(appDoc.value) };
    },
    newId: () => `ovis-n${next++}`,
    terminal: async (address) => (await hc.call("terminal.get", { terminal: address })) as HcTerminal,
  });
  return {
    hc, store, docs, calls, appWrites, terminals,
    steps: () => calls.map((call) => keyOf(call.method, call.params)),
    hold: (key: string) => holding.add(key),
    /** resolves once a call of `key` was sent */
    sent: (key: string) => new Promise<void>((resolve) => arrived.set(key, resolve)),
    release: (key: string) => { holding.delete(key); for (const answer of held.get(key) ?? []) answer(); held.delete(key); },
  };
}

/** Every edit of the document, each on the fixture where it changes something. */
const EDITS: [string, (layout: OvisLayout) => Edited][] = [
  ["split", splitEdit("t1", "t9", "down")],
  ["move beside", moveBesideEdit("t1", "A1", "t2", "down")],
  ["swap", swapEdit("t1", null, "right")],
  ["ratio", ratioEdit("A1", [], 0.3)],
  ["resize", resizeEdit("t1", "right", 0.1)],
  ["zoom", zoomEdit("t1", "on")],
  ["tab order", tabOrderEdit("A", "A2", ["A1", "A2"], 0)],
  ["workspace order", workspaceOrderEdit("B", ["A", "B", "hc-other"], 0)],
];

describe("layout operations", () => {
  it("edits are pure", () => {
    const root = (layout: OvisLayout | null, tab = 0, workspace = 0) => layout?.workspaces[workspace]!.tabs[tab]!;
    const before = known("t2");
    const frozen = structuredClone(before);
    const made = Object.fromEntries(EDITS.map(([name, edit]) => [name, edit(before)]));
    // no edit touches the layout it was given
    expect(before).toEqual(frozen);
    expect(root(made["split"]!.layout)).toEqual({ id: "A1", zoomed: null, root: { split: "right", ratio: 0.5, first: { split: "down", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t9" } }, second: { leaf: "t2" } } });
    expect(root(made["move beside"]!.layout)).toEqual({ id: "A1", zoomed: null, root: { split: "down", ratio: 0.5, first: { leaf: "t2" }, second: { leaf: "t1" } } });
    expect(made["swap"]).toMatchObject({ reason: null, target: "t2" });
    expect(root(made["swap"]!.layout)?.root).toEqual({ split: "right", ratio: 0.5, first: { leaf: "t2" }, second: { leaf: "t1" } });
    expect(root(made["ratio"]!.layout)?.root).toMatchObject({ ratio: 0.3 });
    expect(root(made["resize"]!.layout)?.root).toMatchObject({ ratio: 0.6 });
    expect(root(made["zoom"]!.layout)?.zoomed).toBe("t1");
    expect(made["tab order"]!.layout!.workspaces[0]!.tabs.map((tab) => tab.id)).toEqual(["A2", "A1"]);
    expect(made["workspace order"]!.layout!.workspaces.map((workspace) => workspace.id)).toEqual(["B", "A"]);
    // the same arguments on the same layout make the same layout
    expect(EDITS.map(([, edit]) => edit(before))).toEqual(EDITS.map(([name]) => made[name]!));
  });

  it("version before terminals", async () => {
    for (const [name, edit] of EDITS) {
      const core = fakeCore();
      core.hold("doc.get ovis-layout");
      const sent = core.sent("doc.get ovis-layout");
      const done = core.store.edit(edit);
      await sent;
      await turn();
      // Ovis's document is asked alone, and nothing more until it is answered
      expect([name, core.steps()]).toEqual([name, ["doc.get ovis-layout"]]);
      core.release("doc.get ovis-layout");
      await done;
      expect([name, core.steps()]).toEqual([name, ["doc.get ovis-layout", "terminal.list", "doc.get herdr-app", "doc.set ovis-layout"]]);
    }
  });

  it("an edit needs only the core's line: the store's calls, document and answer", async () => {
    const alone = fakeCore();
    const stored = fakeCore();
    const answers = [
      await editLayout(alone.hc as unknown as Pick<HcConnection, "call" | "hello">, ratioEdit("A1", [], 0.3)),
      await stored.store.edit(ratioEdit("A1", [], 0.3)),
    ];
    expect(answers).toEqual([{ changed: true, reason: null }, { changed: true, reason: null }]);
    expect(alone.steps()).toEqual(["doc.get ovis-layout", "terminal.list", "doc.get herdr-app", "doc.set ovis-layout"]);
    expect(alone.steps()).toEqual(stored.steps());
    expect(alone.docs.get("ovis-layout")).toEqual(stored.docs.get("ovis-layout"));
    expect((alone.docs.get("ovis-layout")!.value as OvisLayout).workspaces[0]!.tabs[0]!.root).toMatchObject({ split: "right", ratio: 0.3 });
  });

  it("terminals and the app's document go out together", async () => {
    const core = fakeCore();
    core.hold("terminal.list");
    core.hold("doc.get herdr-app");
    const listed = core.sent("terminal.list");
    const done = core.store.edit(ratioEdit("A1", [], 0.3));
    await listed;
    await turn();
    // both are asked before either is answered
    expect(core.steps()).toEqual(["doc.get ovis-layout", "terminal.list", "doc.get herdr-app"]);
    core.release("doc.get herdr-app");
    core.release("terminal.list");
    expect(await done).toEqual({ changed: true, reason: null });
  });

  it("no-op writes nothing", async () => {
    const unchanged: [string, (layout: OvisLayout) => Edited, string | null][] = [
      ["zoom of a one-pane tab", zoomEdit("t3", "toggle"), "single_pane"],
      ["zoom off where nothing is zoomed", zoomEdit("t1", "off"), "already_unzoomed"],
      ["swap at an edge", swapEdit("t1", null, "left"), "no_neighbor"],
      ["swap with itself", swapEdit("t1", "t1", null), "same_pane"],
      ["swap across tabs", swapEdit("t1", "t3", null), "cross_tab"],
      ["resize with no border", resizeEdit("t3", "right", 0.1), "unchanged"],
      ["ratio where no split is", ratioEdit("A2", [], 0.3), "split_not_found"],
      ["move beside itself", moveBesideEdit("t1", "A1", "t1", "down"), "same_pane"],
    ];
    for (const [what, edit, reason] of unchanged) {
      const core = fakeCore();
      const answer = await core.store.edit(edit);
      expect([what, answer.changed, answer.reason, core.steps()]).toEqual([what, false, reason, ["doc.get ovis-layout", "terminal.list", "doc.get herdr-app"]]);
      expect(core.docs.get("ovis-layout")).toEqual({ value: known(), version: 1 });
    }
  });

  it("app-owned refuses", async () => {
    const core = fakeCore({ app: { spaces: [] } });
    const arranging: [string, () => Promise<unknown>][] = [
      ...EDITS.map(([name, edit]): [string, () => Promise<unknown>] => [name, () => core.store.edit(edit)]),
      ["split a pane", () => core.store.split("t1", "right")],
      ["rename a workspace", () => core.store.rename({ workspace: "A", name: "api" })],
      ["rename a tab", () => core.store.rename({ tab: "A1", name: "main" })],
      ["rename a pane", () => core.store.rename({ pane: "t1", name: "logs" })],
      ["move a pane to a new tab", () => core.store.moveToNewTab("t3", "B", "")],
      ["move a tab", () => core.store.moveTab("A2", 0)],
      ["move a workspace", () => core.store.moveWorkspace("B", 0)],
    ];
    for (const [what, operation] of arranging) {
      const refused = await operation().then(() => null, (error: unknown) => (error instanceof AdapterError ? error.code : String(error)));
      expect([what, refused]).toEqual([what, "unsupported"]);
    }
    const written = core.calls.filter((call) => call.method === "doc.set" || call.method === "terminal.label" || call.method === "terminal.run");
    expect(written).toEqual([]);
    // ownership is read on every operation: once the app's document is gone, the next one is allowed
    core.docs.set("herdr-app", { value: null, version: 2 });
    await core.store.rename({ pane: "t1", name: "logs" });
    expect(await core.store.edit(zoomEdit("t1", "on"))).toEqual({ changed: true, reason: null });
  });

  it("never herdr-app", async () => {
    const operations: [string, (store: LayoutStore) => Promise<unknown>][] = [
      ...EDITS.map(([name, edit]): [string, (store: LayoutStore) => Promise<unknown>] => [name, (store) => store.edit(edit)]),
      ["create a workspace", (store) => store.createWorkspace({ name: "web" })],
      ["create a tab", (store) => store.createTab("A", { name: "logs" })],
      ["create a tab in Other terminals", (store) => store.createTab("hc-other", {})],
      ["split a pane", (store) => store.split("t1", "down")],
      ["rename a workspace", (store) => store.rename({ workspace: "A", name: "api" })],
      ["rename a tab", (store) => store.rename({ tab: "A1", name: "main" })],
      ["rename a pane", (store) => store.rename({ pane: "t1", name: null })],
      ["move a pane to a new tab", (store) => store.moveToNewTab("t3", "B", "moved")],
      ["move a pane to Other terminals", (store) => store.moveToNewTab("t4", "hc-other", "")],
      ["move a tab", (store) => store.moveTab("A2", 0)],
      ["move a workspace", (store) => store.moveWorkspace("B", 0)],
      ["close a pane", (store) => store.close({ pane: "t2" })],
      ["close a tab", (store) => store.close({ tab: "A1" })],
      ["close a workspace", (store) => store.close({ workspace: "B", group: false })],
    ];
    const ran: string[] = [];
    const written: unknown[] = [];
    for (const [what, operation] of operations) {
      const core = fakeCore();
      await operation(core.store);
      ran.push(what);
      written.push(...core.appWrites, ...core.calls.filter((call) => call.method === "doc.set").map((call) => call.params["name"]));
    }
    expect(ran).toEqual(operations.map(([what]) => what));
    // every write is Ovis's own document: the eight edits, the split's, the tab's and the workspace's move
    expect(written).toEqual(Array(11).fill("ovis-layout"));
  });

  it("foreign schema", async () => {
    const core = fakeCore({ layout: { schema: 2, anything: true } });
    for (const [name, edit] of EDITS) {
      const refused = await core.store.edit(edit).then(() => null, (error: unknown) => (error instanceof AdapterError ? error.code : String(error)));
      expect([name, refused]).toEqual([name, "unsupported"]);
    }
    // a split the document cannot hold starts no shell
    await expect(core.store.split("t1", "right")).rejects.toMatchObject({ code: "unsupported" });
    expect(core.calls.filter((call) => call.method === "doc.set" || call.method === "terminal.run")).toEqual([]);
    expect(core.docs.get("ovis-layout")).toEqual({ value: { schema: 2, anything: true }, version: 1 });
  });

  it("a second conflict is thrown as it came", async () => {
    const core = fakeCore({ conflicts: 2 });
    const error = await core.store.edit(ratioEdit("A1", [], 0.3)).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HcError);
    expect((error as HcError).kind).toBe("conflict");
    expect(core.steps().filter((step) => step === "doc.set ovis-layout")).toHaveLength(2);
    // a split's shell runs: the answer says it could not be placed, and nothing ends it
    const split = fakeCore({ conflicts: 2 });
    await expect(split.store.split("t1", "down")).rejects.toMatchObject({ code: "layout_not_saved" });
    expect(split.calls.filter((call) => call.method === "terminal.run")).toHaveLength(1);
    expect(split.calls.filter((call) => call.method === "terminal.kill" || call.method === "terminal.rm")).toEqual([]);
  });

  it("the retry edits the re-read document", async () => {
    const core = fakeCore();
    const theirs = known();
    theirs.workspaces.reverse();
    const seen: string[][] = [];
    // another writer moves B first between this read and this write
    core.hold("doc.set ovis-layout");
    const sent = core.sent("doc.set ovis-layout");
    const done = core.store.edit((layout) => {
      seen.push(layout.workspaces.map((workspace) => workspace.id));
      return tabOrderEdit("A", "A2", ["A1", "A2"], 0)(layout);
    });
    await sent;
    core.docs.set("ovis-layout", { value: theirs, version: 2 });
    core.release("doc.set ovis-layout");
    expect(await done).toEqual({ changed: true, reason: null });
    expect(seen).toEqual([["A", "B"], ["B", "A"]]);
    const writes = core.calls.filter((call) => call.method === "doc.set");
    expect(writes.map((call) => call.params["version"])).toEqual([1, 2]);
    const stored = core.docs.get("ovis-layout")!.value as OvisLayout;
    expect(stored.workspaces.map((workspace) => [workspace.id, workspace.tabs.map((tab) => tab.id)])).toEqual([["B", ["B1"]], ["A", ["A2", "A1"]]]);
  });
});

describe("closing and reading the core, shared with the screen", () => {
  it("a close ends live terminals and only removes the record of one whose program already finished", async () => {
    const core = fakeCore();
    await core.store.end(["t1", "t2"], new Set(["t2"]));
    expect(core.calls.map((call) => `${call.method} ${String(call.params["terminal"])}`).sort()).toEqual(["terminal.kill t1", "terminal.rm t1", "terminal.rm t2"]);
  });

  it("end still tries every terminal and throws the first failure in request order", async () => {
    const core = fakeCore();
    const first = new HcError("blocked", "kill refused");
    const secondFailed = Promise.withResolvers<void>();
    const call = core.hc.call.bind(core.hc);
    core.hc.call = async (method, params) => {
      if (method === "terminal.kill" && params["terminal"] === "t1") {
        await secondFailed.promise;
        throw first;
      }
      if (method === "terminal.rm" && params["terminal"] === "t2") {
        secondFailed.resolve();
        throw new HcError("live", "remove refused");
      }
      return call(method, params);
    };
    await expect(core.store.end(["t1", "t2", "t3"])).rejects.toBe(first);
    expect(core.terminals.map(({ address }) => address)).toEqual(["t1", "t2", "t4"]);
  });

  it("endsOf names what closeTargets names and refuses Other terminals as a whole", async () => {
    const core = fakeCore();
    const { shown } = await readCore(core.hc as unknown as Pick<HcConnection, "call" | "hello">, { host: null });
    expect(core.store.endsOf(shown, { workspace: "A", group: false })).toEqual(["t1", "t2", "t3"]);
    expect(() => core.store.endsOf(shown, { workspace: OTHER_WORKSPACE_ID, group: false })).toThrow(expect.objectContaining({ code: "unsupported" }));
  });

  it("readCore asks for finished terminals only when told, and groups them as the caller shows them", async () => {
    const core = fakeCore();
    const finished: HcTerminal = { ...labeled("t9", "B", "B1"), state: "finished" };
    core.terminals.push(finished);
    const read = await readCore(core.hc as unknown as Pick<HcConnection, "call" | "hello">, { host: null, all: true, shown: (terminals) => terminals.map((terminal) => (terminal.address === "t9" ? { ...terminal, state: "live" } : terminal)) });
    expect([core.calls[0], read.terminals.find((terminal) => terminal.address === "t9")?.state, read.shown.panes.some((pane) => pane.pane_id === "t9"), read.own])
      .toEqual([{ method: "terminal.list", params: { all: true } }, "finished", true, true]);
  });
});
