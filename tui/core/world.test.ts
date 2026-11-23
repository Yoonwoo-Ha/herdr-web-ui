import { describe, expect, it } from "bun:test";
import { type LayoutNode, OVIS_LAYOUT_DOC, type PaneDirection, place } from "../../server/herdr-core/layout-doc.ts";
import { coreModel, type HcEvent } from "../../server/herdr-core/core-model.ts";
import { LAYOUT_DOC, PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { WORKTREE_LABEL } from "../../server/herdr-core/worktrees.ts";
import { focusDirection, paneToward } from "../model/focus.ts";
import { CoreWorld, treeOf } from "./world.ts";

const leaf = (id: string): LayoutNode => ({ leaf: id });
const right = (ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: "right", ratio, first, second });
const down = (ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: "down", ratio, first, second });

const layoutOf = (root: LayoutNode) => {
  const placed = place(root);
  return { splits: placed.splits, panes: placed.panes.map(({ pane_id, rect }) => ({ pane_id, rect, focused: false })) };
};

describe("a tab's tree from the snapshot's layout", () => {
  it("is the tree place() cut, for single panes, nested splits and both directions", () => {
    const trees = [
      leaf("a"),
      right(0.5, leaf("a"), leaf("b")),
      right(0.3, leaf("a"), down(0.6, leaf("b"), leaf("c"))),
      down(0.5, right(0.5, leaf("a"), leaf("b")), right(0.2, leaf("c"), down(0.5, leaf("d"), leaf("e")))),
    ];
    for (const tree of trees) expect(treeOf(layoutOf(tree))).toEqual(tree);
  });

  it("is null for a layout with no pane", () => {
    expect(treeOf({ splits: [], panes: [] })).toBeNull();
  });
});

describe("the pane that lies that way (layout-doc.ts neighbour, on the tree the screen draws)", () => {
  const table: [name: string, root: LayoutNode, from: string, direction: PaneDirection, expected: string | null][] = [
    ["side by side", right(0.5, leaf("a"), leaf("b")), "a", "right", "b"],
    ["side by side, back", right(0.5, leaf("a"), leaf("b")), "b", "left", "a"],
    ["at the edge", right(0.5, leaf("a"), leaf("b")), "a", "left", null],
    ["nothing above", right(0.5, leaf("a"), leaf("b")), "a", "up", null],
    ["a tie: two share the edge equally, the first in the tree wins", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "a", "right", "b"],
    ["nested, down", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "b", "down", "c"],
    ["nested, up", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "c", "up", "b"],
    ["nested, out to the left", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "c", "left", "a"],
    ["the larger share of the edge wins", right(0.5, leaf("a"), down(0.3, leaf("b"), leaf("c"))), "a", "right", "c"],
    ["a tie from below", down(0.5, right(0.5, leaf("a"), leaf("b")), leaf("c")), "c", "up", "a"],
    ["two levels deep", down(0.5, right(0.5, leaf("a"), leaf("b")), right(0.2, leaf("c"), down(0.5, leaf("d"), leaf("e")))), "b", "down", "d"],
    ["a pane not in the tab", right(0.5, leaf("a"), leaf("b")), "z", "right", null],
  ];
  for (const [name, root, from, direction, expected] of table) {
    it(name, () => {
      expect(paneToward(root, from, direction)).toBe(expected);
    });
  }
});

describe("herdr's directional focus actions", () => {
  it("map to the side each looks to, and nothing else does", () => {
    expect(["focus_pane_left", "focus_pane_right", "focus_pane_up", "focus_pane_down", "swap_pane_left", "split_vertical", "toString", ""].map(focusDirection))
      .toEqual(["left", "right", "up", "down", null, null, null, null]);
  });
});

/** A terminal record as hc 0.1.17 and 0.1.18 send it (`created` data and `terminal.list`), recorded from both. */
const record = (address: string, space: string, tab: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  address, argv: ["sh"], cols: 200, created_ms: 1794905364788, cwd: "/home/u/proj", die_with_parent: false, exit_code: null, finished_ms: null,
  identity: "ghostty", keep: false, name: null, notify: true, parent: null, pid: 3792743, reason: null, reported: false, rm: false, rows: 120,
  screen: "exact", signal: null, state: "live", status: null, status_ms: null, template: null, title: "", turn: 0,
  labels: { [SPACE_LABEL]: space, [WORKSPACE_NAME_LABEL]: space.toUpperCase(), [TAB_LABEL]: tab, [TAB_NAME_LABEL]: `${tab} name` },
  ...extra,
});

/**
 * A world told what the link tells it: the snapshot, then each event with the change records the shared core model (the
 * link's own, made from the world's options) makes of it. `answer` is what the core's terminal.list answers next.
 */
function linked(terminals: Record<string, unknown>[]) {
  const world = new CoreWorld();
  const model = coreModel(world.model);
  model.seed(terminals);
  world.notice({ type: "snapshot", epoch: 1, cause: "connect", seq: 1, terminals });
  let seq = 1;
  const tell = (event: HcEvent, answer?: Record<string, unknown>[]) => {
    const changes = model.event(event);
    world.notice({ type: "event", epoch: 1, seq: ++seq, event, changes });
    const read = world.nextRead();
    if (read && answer) world.answer(read, answer);
    return { changes, read };
  };
  const pane = (id: string) => world.view().panes.get(id);
  const names = () => world.view().world.workspaces.map((workspace) => [workspace.id, workspace.tabs.map((tab) => [tab.id, tab.panes.map((one) => one.id)])]);
  return { world, tell, pane, names };
}

describe("core events reach the world through the shared core model", () => {
  it("status: a program's report shows at once, in the pane, the agent row and the roll-ups, with no read", () => {
    const { world, tell, pane } = linked([record("t1", "w1", "a"), record("t2", "w1", "a")]);
    const { changes, read } = tell({ type: "status", terminal: "t1", data: { status: { state: "blocked", app: "claude" }, records: {}, reported: true } });
    expect(changes.map((change) => change.type)).toEqual(["status"]);
    expect(read).toBeNull();
    expect([pane("t1")?.status, pane("t1")?.agent]).toEqual(["blocked", "claude"]);
    const view = world.view();
    expect(view.agents.map((agent) => [agent.paneId, agent.agent, agent.status])).toEqual([["t1", "claude", "blocked"]]);
    expect([view.tabStatuses.get("a"), view.workspaceGroups[0]!.status]).toEqual(["blocked", "blocked"]);
  });

  it("foreground: a program named like an agent coming to the front shows as that agent before and after the read", () => {
    const { world, tell, pane } = linked([record("t1", "w1", "a")]);
    // hc sends the record of the process in front AS the event's data (hc 0.1.17 and 0.1.18, recorded)
    const front = { argv: ["/home/u/bin/claude", "/etc/hostname"], cwd: "/home/u/api", name: "claude", pid: 4007445 };
    const { changes, read } = tell({ type: "foreground", terminal: "t1", data: front });
    expect(changes).toEqual([{ type: "updated", terminal: "t1" }, { type: "status", terminal: "t1", status: null, shown: "unknown", agent: "claude" }]);
    expect(pane("t1")?.agent).toBe("claude");
    expect(world.view().agents.map((agent) => agent.paneId)).toEqual(["t1"]);
    expect(world.answer(read!, [record("t1", "w1", "a", { foreground: front })])).toBe(true);
    expect([pane("t1")?.agent, pane("t1")?.folder]).toEqual(["claude", "api"]);
    expect(world.view().agents.map((agent) => [agent.paneId, agent.folder])).toEqual([["t1", "api"]]);
  });

  it("foreground: an agent whose program left the front is no agent row at once, before the terminals are read again", () => {
    const front = (name: string) => ({ argv: [`/home/u/bin/${name}`], cwd: "/home/u/api", name, pid: 4007445 });
    const { world, tell, pane } = linked([record("t1", "w1", "a", { foreground: front("claude") }), record("t2", "w1", "a", { foreground: front("codex") })]);
    const rows = () => [world.view().agents.map((agent) => agent.paneId), world.view().world.agents];
    expect(rows()).toEqual([["t1", "t2"], ["t1", "t2"]]);
    // claude ended and its shell is in front again: the read this asks for is not answered yet
    const { read } = tell({ type: "foreground", terminal: "t1", data: front("bash") });
    expect([read === null, pane("t1")?.agent, pane("t2")?.agent]).toEqual([false, null, "codex"]);
    expect(rows()).toEqual([["t2"], ["t2"]]);
  });

  it("turn: a turn that ends after the screen first saw the terminal shows the agent done", () => {
    const { tell, pane } = linked([record("t1", "w1", "a", { status: { state: "idle", app: "claude" }, reported: true })]);
    expect(pane("t1")?.status).toBe("idle");
    const { changes } = tell({ type: "turn", terminal: "t1", data: { turn: 1, state: "idle" } });
    expect(changes.map((change) => change.type)).toEqual(["status"]);
    expect(pane("t1")?.status).toBe("done");
  });

  it("title: a title that says nothing of the agent's state changes nothing until the terminal is read again, as in the browser", () => {
    const { tell, pane } = linked([record("t1", "w1", "a")]);
    const { changes, read } = tell({ type: "title", terminal: "t1", data: { title: "a title here" } });
    expect([changes, read]).toEqual([[], null]);
    expect(pane("t1")?.title).toBe("");
    tell({ type: "labels", terminal: "t1", data: { labels: record("t1", "w1", "a")["labels"] as Record<string, string> } }, [record("t1", "w1", "a", { title: "a title here" })]);
    expect(pane("t1")?.title).toBe("a title here");
  });

  it("a rename (labels): the read shows the new pane, tab and workspace names", () => {
    const { tell, pane, world } = linked([record("t1", "w1", "a")]);
    const labels = { [SPACE_LABEL]: "w1", [WORKSPACE_NAME_LABEL]: "다시 W", [TAB_LABEL]: "a", [TAB_NAME_LABEL]: "renamed tab", [PANE_NAME_LABEL]: "renamed pane" };
    const { changes } = tell({ type: "labels", terminal: "t1", data: { labels } }, [record("t1", "w1", "a", { labels })]);
    expect(changes).toEqual([{ type: "layout" }]);
    expect(pane("t1")?.label).toBe("renamed pane");
    expect(world.view().world.workspaces.map((workspace) => [workspace.name, workspace.tabs.map((tab) => tab.name)])).toEqual([["다시 W", ["renamed tab"]]]);
  });

  it("created: a terminal in a tab, in a new tab and in a new workspace shows once read", () => {
    const { tell, names } = linked([record("t1", "w1", "a")]);
    const all = [record("t1", "w1", "a")];
    for (const [address, space, tab] of [["t2", "w1", "a"], ["t3", "w1", "b"], ["t4", "w2", "c"]] as const) {
      all.push(record(address, space, tab));
      tell({ type: "created", terminal: address, data: record(address, space, tab) }, [...all]);
    }
    expect(names()).toEqual([["w1", [["a", ["t1", "t2"]], ["b", ["t3"]]]], ["w2", [["c", ["t4"]]]]]);
  });

  it("removed: a terminal leaves its tab, and its tab and workspace leave with their last terminal", () => {
    const terminals = [record("t1", "w1", "a"), record("t2", "w1", "a"), record("t3", "w1", "b"), record("t4", "w2", "c")];
    const { tell, names } = linked(terminals);
    tell({ type: "removed", terminal: "t2", data: {} }, [terminals[0]!, terminals[2]!, terminals[3]!]);
    expect(names()).toEqual([["w1", [["a", ["t1"]], ["b", ["t3"]]]], ["w2", [["c", ["t4"]]]]]);
    tell({ type: "removed", terminal: "t3", data: {} }, [terminals[0]!, terminals[3]!]);
    expect(names()).toEqual([["w1", [["a", ["t1"]]]], ["w2", [["c", ["t4"]]]]]);
    tell({ type: "removed", terminal: "t4", data: {} }, [terminals[0]!]);
    expect(names()).toEqual([["w1", [["a", ["t1"]]]]]);
  });

  it("finished: a program that ended by itself keeps its place until the core removes its record; a killed one, or one the core's stop finished, leaves at once", () => {
    const terminals = [record("t1", "w1", "a"), record("t2", "w1", "a"), record("t3", "w1", "a")];
    const { tell, names } = linked(terminals);
    const ended = (address: string, reason: string, code: number | null) => record(address, "w1", "a", { state: "finished", reason, exit_code: code, finished_ms: 1794905365902 });
    tell({ type: "finished", terminal: "t1", data: { exit_code: 3, finished_ms: 1794905365902, reason: "exited", signal: null } }, [ended("t1", "exited", 3), terminals[1]!, terminals[2]!]);
    expect(names()).toEqual([["w1", [["a", ["t1", "t2", "t3"]]]]]);
    tell({ type: "finished", terminal: "t2", data: { exit_code: null, finished_ms: 1794905386684, reason: "killed", signal: 1 } }, [ended("t1", "exited", 3), ended("t2", "killed", null), terminals[2]!]);
    tell({ type: "finished", terminal: "t3", data: { exit_code: null, finished_ms: 1794905386684, reason: "server_stop", signal: 1 } }, [ended("t1", "exited", 3), ended("t2", "killed", null), ended("t3", "server_stop", null)]);
    expect(names()).toEqual([["w1", [["a", ["t1"]]]]]);
    tell({ type: "removed", terminal: "t1", data: {} }, [ended("t2", "killed", null), ended("t3", "server_stop", null)]);
    expect(names()).toEqual([]);
  });
});

describe("the world's reads of the core", () => {
  it("asks for one read at a time, once more for changes that came meanwhile, and drops an answer older than a snapshot", () => {
    const { world, tell } = linked([record("t1", "w1", "a")]);
    const first = tell({ type: "created", terminal: "t2", data: record("t2", "w1", "a") }).read!;
    expect(first).toEqual({ method: "terminal.list", params: { all: true }, told: 0 });
    tell({ type: "created", terminal: "t3", data: record("t3", "w1", "a") });
    tell({ type: "removed", terminal: "t3", data: {} });
    expect(world.nextRead()).toBeNull();
    expect(world.answer(first, [record("t1", "w1", "a"), record("t2", "w1", "a")])).toBe(true);
    const second = world.nextRead()!;
    expect(world.nextRead()).toBeNull();
    world.notice({ type: "snapshot", epoch: 2, cause: "connect", seq: 1, terminals: [record("t1", "w1", "a")] });
    expect(world.answer(second, [record("t9", "w9", "z")])).toBe(false);
    expect(world.view().world.workspaces.map((workspace) => workspace.id)).toEqual(["w1"]);
    expect(world.nextRead()).toBeNull();
  });

  it("a failed read changes nothing, and the next change reads again", () => {
    const { world, tell } = linked([record("t1", "w1", "a")]);
    const read = tell({ type: "created", terminal: "t2", data: record("t2", "w1", "a") }).read!;
    expect(world.answer(read, null)).toBe(false);
    expect(world.nextRead()).toBeNull();
    expect(tell({ type: "created", terminal: "t3", data: record("t3", "w1", "a") }).read).not.toBeNull();
  });

  it("a status told after a read was asked for outlives its answer; one told before gives way to it", () => {
    const { world, tell, pane } = linked([record("t1", "w1", "a"), record("t2", "w1", "a")]);
    tell({ type: "status", terminal: "t1", data: { status: { state: "working", app: "codex" }, records: {}, reported: true } });
    const read = tell({ type: "created", terminal: "t3", data: record("t3", "w1", "a") }).read!;
    tell({ type: "status", terminal: "t2", data: { status: { state: "blocked", app: "claude" }, records: {}, reported: true } });
    // the core answers from records it held before t2's report, and after t1's went idle
    world.answer(read, [record("t1", "w1", "a", { status: { state: "idle", app: "codex" }, reported: true }), record("t2", "w1", "a"), record("t3", "w1", "a")]);
    expect([pane("t1")?.status, pane("t2")?.status]).toEqual(["idle", "blocked"]);
  });

  it("shares one first-turn memory with the link's model, and forgets terminals a snapshot no longer has", () => {
    const world = new CoreWorld();
    expect(world.model.firstTurn({ address: "t1", turn: 4 })).toBe(4);
    expect(world.model.firstTurn({ address: "t1", turn: 9 })).toBe(4);
    world.notice({ type: "snapshot", epoch: 2, cause: "connect", seq: 1, terminals: [record("t2", "w1", "a")] });
    expect(world.model.firstTurn({ address: "t1", turn: 9 })).toBe(9);
  });
});

describe("the core's layout documents", () => {
  it("takes the tree and the zoom from Ovis's own document", () => {
    const { world } = linked([record("t1", "w1", "a"), record("t2", "w1", "a")]);
    const root = down(0.25, leaf("t2"), leaf("t1"));
    world.notice({ type: "doc", epoch: 1, name: OVIS_LAYOUT_DOC, doc: { value: { schema: 1, workspaces: [{ id: "w1", tabs: [{ id: "a", root, zoomed: "t1" }] }] }, version: 1 } });
    expect(world.view().tabs.get("a")).toEqual({ root, zoomed: "t1" });
    expect(world.view().world.workspaces[0]!.tabs[0]!.panes.map((pane) => pane.id)).toEqual(["t2", "t1"]);
  });

  it("follows the Herdr app's document on a core it arranges, and ignores other documents", () => {
    const { world } = linked([record("t1", "w1", "a"), record("t2", "w1", "a")]);
    expect(world.notice({ type: "doc", epoch: 1, name: "other", doc: { value: {}, version: 1 } })).toBe(false);
    const app = { spaces: [{ id: "s1", name: "app space", tabs: [{ id: "x", name: "app tab", root: { type: "column", children: [{ content: { terminal: "t2" } }, { content: { terminal: "t1" } }] } }] }] };
    world.notice({ type: "doc", epoch: 1, name: LAYOUT_DOC, doc: { value: app, version: 1 } });
    const view = world.view();
    expect(view.ownsLayout).toBe(false);
    expect(view.world.workspaces.map((workspace) => [workspace.id, workspace.name])).toEqual([["s1", "app space"]]);
    expect(view.tabs.get("x")).toEqual({ root: { split: "down", ratio: 0.5, first: leaf("t2"), second: leaf("t1") }, zoomed: null });
  });

  it("groups linked worktree workspaces under the workspace on their repository's main checkout", () => {
    const tree = (path: string, linked: boolean) => JSON.stringify({ repo_key: "/repo/.git", repo_name: "repo", repo_root: "/repo", checkout_path: path, is_linked_worktree: linked });
    const { world } = linked([
      record("t1", "w-main", "a", { labels: { [SPACE_LABEL]: "w-main", [TAB_LABEL]: "a", [WORKTREE_LABEL]: tree("/repo", false) } }),
      record("t2", "w-other", "b"),
      record("t3", "w-wt", "c", { labels: { [SPACE_LABEL]: "w-wt", [TAB_LABEL]: "c", [WORKTREE_LABEL]: tree("/repo-wt", true) } }),
    ]);
    expect(world.view().workspaceGroups.map((group) => [group.id, group.children.map((child) => child.id)])).toEqual([["w-main", ["w-wt"]], ["w-other", []]]);
  });
});
