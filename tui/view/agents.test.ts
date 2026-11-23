import { afterEach, describe, expect, it } from "bun:test";
import type { CoreChange } from "../../server/herdr-core/core-model.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { buildSnapshot, coreHost, type HcTerminal, PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import type { Machine } from "../../shared/machines.ts";
import { agentRoster, groupAgentRows as browserGroups } from "../../src/lib/agentRoster.ts";
import { CoreWorld, jumpOrder } from "../core/world.ts";
import { focused } from "../model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { Run } from "../testing/run.ts";

const TEST_MS = 120_000;

/** One terminal of workspace `space`, its pane named `name`, its agent reporting `state` (none: no agent). */
const term = (address: string, name: string, state: string | null, extra: Record<string, unknown> = {}, space = "w") => ({
  address, state: "live", cols: 80, rows: 24, cwd: "/home/u/proj", turn: 0, reason: null,
  labels: { [SPACE_LABEL]: space, [WORKSPACE_NAME_LABEL]: space === "w" ? "work" : "docs", [TAB_LABEL]: `${space}-tab`, [TAB_NAME_LABEL]: "tab", [PANE_NAME_LABEL]: name },
  ...(state === null ? {} : { status: { state, app: "claude" }, reported: true }),
  ...extra,
});

function worldOf(terminals: unknown[]): CoreWorld {
  const world = new CoreWorld();
  world.notice({ type: "snapshot", epoch: 1, cause: "connect", seq: 1, terminals });
  world.view();
  return world;
}

/** The core model's record that `terminal` now shows `shown`, as the link hands it on. */
function told(world: CoreWorld, terminal: string, shown: "blocked" | "done" | "working" | "idle", seq: number): void {
  const change: CoreChange = { type: "status", terminal, status: { state: shown, app: "claude" }, shown, agent: "claude" };
  world.notice({ type: "event", epoch: 1, seq, event: { type: "status", terminal }, changes: [change] });
  world.view();
}

const after = (state: ModelState, ...events: ModelEvent[]): ModelState => events.reduce((current, event) => reduce(current, event).state, state);
const shownPane = (state: ModelState) => focused(state.world, state.focus).pane?.id ?? null;

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

describe("the agents' order", () => {
  it("jump order", () => {
    // all four from the first snapshot: blocked t1, done t2; then t3 turns blocked, later t4 done
    const world = worldOf([term("t1", "one", "blocked"), term("t2", "two", "done"), term("t3", "three", "working"), term("t4", "four", "idle"), term("t5", "shell", null)]);
    told(world, "t3", "blocked", 2);
    told(world, "t4", "done", 3);
    const view = world.view();
    // blocked rows first, then done rows, each the longest in that state first
    expect(view.world.waiting).toEqual(["t1", "t3", "t2", "t4"]);
    // an agent that turns blocked later stands behind one blocked since before, wherever the list puts it
    const later = worldOf([term("t1", "one", "working"), term("t2", "two", "blocked")]);
    told(later, "t1", "blocked", 2);
    expect(later.view().world.waiting).toEqual(["t2", "t1"]);
    expect(jumpOrder([{ paneId: "a", status: "done" }, { paneId: "b", status: "blocked" }, { paneId: "c", status: "done" }, { paneId: "d", status: "working" }], new Map([["a", 5], ["c", 2]])))
      .toEqual(["b", "c", "a"]);
    // the jump key goes from the shown pane's place to the next, round; from a pane that needs nothing, to the first
    const start = after(initialState(undefined), { type: "world", world: view.world, at: 0 });
    const jump: ModelEvent = { type: "action", action: "open_notification_target", at: 1 };
    const fromShell = after(start, { type: "select", target: { kind: "pane", id: "t5" }, at: 1 });
    const visits: (string | null)[] = [];
    let state = fromShell;
    for (let press = 0; press < 5; press++) {
      state = after(state, jump);
      visits.push(shownPane(state));
    }
    expect(visits).toEqual(["t1", "t3", "t2", "t4", "t1"]);
    // nothing needs the user: a calm notice says so, and focus stays
    const calm = worldOf([term("t1", "one", "idle"), term("t2", "two", "working")]).view();
    const quiet = after(initialState(undefined), { type: "world", world: calm.world, at: 0 }, jump);
    expect([shownPane(quiet), quiet.notices.map((notice) => [notice.code, notice.calm])]).toEqual(["t1", [["nothing_waiting", true]]]);
  });

  it("the browser's sections and order, an agent and its helpers together", () => {
    // t2 is a helper t1 started: blocked, it brings its agent up into Needs you; t4 is in another workspace
    const view = worldOf([
      term("t1", "lead", "idle"),
      term("t2", "helper", "blocked", { parent: "t1" }),
      term("t3", "build", "working"),
      term("t4", "notes", "done", { turn: 2 }, "v"),
      term("t5", "shell", null),
    ]).view();
    expect(view.agents.map(({ paneId, group, helper, workspace }) => [paneId, group, helper, workspace])).toEqual([
      ["t1", "blocked", false, "work"],
      ["t2", "blocked", true, "work"],
      ["t3", "working", false, "work"],
      ["t4", "done", false, "docs"],
    ]);
    expect(view.world.agents).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("the agent keys focus by the agents' order", () => {
    const view = worldOf([term("t1", "one", "working"), term("t2", "two", "blocked"), term("t3", "three", "done", {}, "v"), term("t5", "shell", null)]).view();
    expect(view.world.agents).toEqual(["t2", "t1", "t3"]);
    const start = after(initialState(undefined), { type: "world", world: view.world, at: 0 }, { type: "select", target: { kind: "pane", id: "t5" }, at: 0 });
    // herdr's focus_agent N, next_agent and previous_agent go by the same order; from a pane with no agent, the first or the last
    expect(shownPane(after(start, { type: "action", action: "focus_agent", index: 2, at: 1 }))).toBe("t1");
    expect(shownPane(after(start, { type: "action", action: "next_agent", at: 1 }))).toBe("t2");
    expect(shownPane(after(start, { type: "action", action: "previous_agent", at: 1 }))).toBe("t3");
    const onFirst = after(start, { type: "action", action: "next_agent", at: 1 });
    expect(shownPane(after(onFirst, { type: "action", action: "previous_agent", at: 1 }))).toBe("t3");
    expect(shownPane(after(onFirst, { type: "action", action: "next_agent", at: 1 }))).toBe("t1");
  });

});

/** A small seeded generator, so the table below is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const STATES = ["blocked", "working", "done", "idle", "waiting", "error"] as const;
/** where a helper stands: in its agent's tab, with no labels of its own (hc places it), in another tab, in another workspace */
const PLACEMENTS = ["same tab", "unlabelled", "other tab", "other workspace"] as const;

/** One state of the table: agents over three workspaces of two tabs, shells beside them, helpers placed as `placement` says. */
function tableState(index: number): HcTerminal[] {
  const random = seeded(index + 1);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const placement = PLACEMENTS[index % PLACEMENTS.length]!;
  const records: Record<string, unknown>[] = [];
  const at = (space: number, tab: number) => ({ [SPACE_LABEL]: `w${space}`, [WORKSPACE_NAME_LABEL]: `space${space}`, [TAB_LABEL]: `w${space}-t${tab}`, [TAB_NAME_LABEL]: `tab${tab}` });
  const terminal = (address: string, labels: Record<string, string>, state: string | null, extra: Record<string, unknown> = {}) =>
    records.push({ address, state: "live", cols: 80, rows: 24, cwd: "/home/u/proj", turn: index % 3, reason: null, labels, ...(state === null ? {} : { status: { state, app: "claude" }, reported: true }), ...extra });
  const agents = 6 + (index % 5);
  for (let n = 1; n <= agents; n++) terminal(`t${n}`, { ...at(n % 3, n % 2), [PANE_NAME_LABEL]: `agent${n}` }, pick(STATES));
  for (let n = 1; n <= 3; n++) terminal(`s${n}`, { ...at(n % 3, (n + 1) % 2), [PANE_NAME_LABEL]: `shell${n}` }, null);
  // helpers: of an agent, of a helper, two of one agent, of a shell, of a terminal that is gone
  const parents = [`t${1 + (index % agents)}`, "h1", `t${1 + ((index + 2) % agents)}`, `t${1 + ((index + 2) % agents)}`, "s1", "gone"];
  parents.slice(0, 2 + (index % 5)).forEach((parent, n) => {
    const home = Number(/^t(\d+)$/.exec(parent)?.[1] ?? 1);
    const labels = placement === "unlabelled" ? {}
      : placement === "same tab" ? at(home % 3, home % 2)
        : placement === "other tab" ? at(home % 3, (home + 1) % 2)
          : at((home + 1) % 3, home % 2);
    terminal(`h${n + 1}`, { ...labels, [PANE_NAME_LABEL]: `helper${n + 1}` }, pick(STATES), { parent });
  });
  return records as unknown as HcTerminal[];
}

describe("the agent list in the browser's order", () => {
  it("with every helper placement: 36 states, the screen's rows against the browser's roster and groups", () => {
    const differs: string[] = [];
    for (let index = 0; index < 36; index++) {
      const records = tableState(index);
      const screen = worldOf(records).view().agents.map((agent) => agent.paneId);
      // the browser (src/lib/agentInbox.ts inboxOrder, src/components/AgentSidebar.tsx): its roster of the PC, then its groups;
      // the first snapshot dates every state alike, as the browser's empty counters do
      const snapshot = buildSnapshot(records, null, "", (terminal) => terminal.turn ?? 0, null, undefined, coreHost(false));
      const machine = { id: "local", state: "connected", snapshot } as unknown as Machine;
      const seqs = new Map<string, number>();
      const browser = browserGroups(agentRoster([machine], { byActivity: false, seqs: () => seqs, pinned: [] }).rest, {
        sort: "wait", status: (row) => row.entry.pane.agent_status, name: () => "", seqs: () => seqs,
      }).flatMap((group) => group.rows.map((row) => row.entry.pane.pane_id));
      expect(screen.length).toBeGreaterThan(5);
      if (JSON.stringify(screen) !== JSON.stringify(browser)) differs.push(`${index} ${PLACEMENTS[index % PLACEMENTS.length]}: screen ${screen.join(",")} browser ${browser.join(",")}`);
    }
    expect(differs).toEqual([]);
  });

  it("one agent blocked beside a family whose helper is blocked: the family where its agent stands, as in the browser", () => {
    const view = worldOf([term("t1", "lead", "idle"), term("t2", "other", "blocked"), term("t3", "helper", "blocked", { parent: "t1" })]).view();
    expect(view.world.agents).toEqual(["t1", "t3", "t2"]);
  });
});

describe("the longest in that state first, by the screen's own dates", () => {
  it("longest first after a reconnect: an agent first seen when the line is back stands behind one waiting since before", async () => {
    const core = new FakeHcCore();
    const agent = (name: string, state: string, space: string) => {
      const { address } = core.spawn({ labels: { [SPACE_LABEL]: space, [WORKSPACE_NAME_LABEL]: space, [TAB_LABEL]: `${space}-t`, [TAB_NAME_LABEL]: "tab", [PANE_NAME_LABEL]: name, "herdr.seen": "0" } });
      core.setPaint(address, { body: `${name}\r\n` });
      core.reportStatus(address, { state, app: "claude" });
      return address;
    };
    agent("one", "idle", "a");
    agent("two", "working", "b");
    const run = await Run.start({ core, cols: 120, rows: 40 });
    runs.push(run);
    await run.live();
    core.reportStatus("t2", { state: "blocked", app: "claude" });
    await run.advance(20);
    await run.cutLine();
    await run.advance(1_000);
    const three = agent("three", "blocked", "a");
    await run.listen();
    await run.advance(8_000);
    await run.live();
    expect(run.loop.model().world.waiting).toEqual(["t2", three]);
    await run.keys("ctrl+b,o");
    await run.advance(20);
    expect(shownPane(run.loop.model())).toBe("t2");
  }, TEST_MS);

  it("longest first after a missed snapshot: what it brings first stands behind what waited before it, and the old dates stay", () => {
    const world = worldOf([term("t1", "one", "working"), term("t2", "two", "blocked"), term("t3", "three", "idle")]);
    told(world, "t1", "blocked", 2);
    expect(world.view().world.waiting).toEqual(["t2", "t1"]);
    // events were lost: hc's snapshot again, with a new agent t4 already blocked, listed first
    world.notice({ type: "snapshot", epoch: 1, cause: "missed", seq: 9, terminals: [term("t4", "four", "blocked"), term("t1", "one", "blocked"), term("t2", "two", "blocked"), term("t3", "three", "idle")] });
    expect(world.view().world.waiting).toEqual(["t2", "t1", "t4"]);
    // a state that changed while the events were lost dates from the snapshot too: behind what kept its state
    world.notice({ type: "snapshot", epoch: 1, cause: "missed", seq: 12, terminals: [term("t4", "four", "blocked"), term("t1", "one", "blocked"), term("t2", "two", "blocked"), term("t3", "three", "blocked")] });
    expect(world.view().world.waiting).toEqual(["t2", "t1", "t4", "t3"]);
  });
});
