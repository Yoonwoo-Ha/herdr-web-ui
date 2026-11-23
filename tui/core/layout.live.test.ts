import { afterAll, describe, expect, it } from "bun:test";
import { constants } from "node:os";
import { coreFolder, IsolatedCore, type StopReport, stoppedCleanly } from "../../scripts/test-hc.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { LAYOUT_DOC } from "../../server/herdr-core/snapshot.ts";
import type { RunEffect } from "../model/effects.ts";
import type { Target } from "../model/focus.ts";
import { type LayoutAnswer, LayoutWrites } from "./layout.ts";
import { type CoreLink, openLink } from "./link.ts";

/**
 * The screen's layout writes against a real hc, in a core of the test's own (IsolatedCore): what it creates, splits
 * and zooms lands in hc's terminals and document, and each close ends exactly the terminals the user saw and no other;
 * a close whose terminals changed since ends nothing. Runs only where OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

const WAIT_MS = 5000;
/** above twice the helper's own 10 s wait for a stopped core */
const TEST_MS = 60_000;

describe.skipIf(!bin || process.platform === "win32")("the screen's layout writes against a real hc", () => {
  let core: IsolatedCore | null = null;
  let link: CoreLink | null = null;
  /** the one teardown: the test, afterAll and a signal all await it */
  let teardown: Promise<StopReport | null> | null = null;
  const stopAll = () => (teardown ??= (async () => {
    await link?.close();
    return core ? core.stop() : null;
  })());
  /** a signal ends `bun test` without running afterAll: the same teardown runs first */
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => { void stopAll().finally(() => process.exit(128 + constants.signals[signal])); };

  afterAll(async () => {
    const report = await stopAll();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    expect(report === null || stoppedCleanly(report)).toBe(true);
  }, TEST_MS);

  it("creates, splits and zooms into hc's document, and each close ends only the terminals the user saw", async () => {
    for (const signal of SIGNALS) process.once(signal, onSignal);
    core = new IsolatedCore(bin!, coreFolder());
    await core.start();
    const online = Promise.withResolvers<void>();
    link = openLink({ socket: core.socket, now: () => 0, model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null }, notify: () => { if (link?.state.kind === "Online") online.resolve(); } });
    const timer = setTimeout(() => online.reject(new Error(`not Online within ${WAIT_MS}ms`)), WAIT_MS);
    await online.promise;
    clearTimeout(timer);
    const hc = link;

    const answers: LayoutAnswer[] = [];
    const writes = new LayoutWrites({ hc, model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null }, folder: core.root, answer: (answer) => answers.push(answer) });
    const run = async (action: RunEffect["action"], target: Target | null = null, more: Partial<RunEffect> = {}) => {
      await writes.run({ type: "run", action, target, index: null, name: null, ...more });
    };
    const followed = () => {
      const last = answers.at(-1);
      if (last?.type !== "follow") throw new Error(`expected a pane to follow, got ${JSON.stringify(last)}`);
      return last.target.id;
    };
    const live = async () => (await hc.call("terminal.list", {})).terminals.map((terminal) => terminal.address).sort();
    const seen = async (...ids: string[]) => Promise.all(ids.map(async (id) => ({ id, created: (await hc.call("terminal.get", { terminal: id })).created_ms })));
    const pane = (id: string): Target => ({ kind: "pane", id });

    await run("new_workspace");
    const first = followed();
    const started = await hc.call("terminal.get", { terminal: first });
    expect(started.cwd).toBe(core.root);
    const space = started.labels?.["herdr.space"]!;
    await run("split_vertical", pane(first));
    const second = followed();
    await run("zoom", pane(first));
    const doc = (await hc.call("doc.get", { name: OVIS_LAYOUT_DOC })).value as { workspaces: { id: string; tabs: { root: unknown; zoomed: string | null }[] }[] };
    expect(doc.workspaces.map((workspace) => [workspace.id, workspace.tabs[0]!.zoomed, workspace.tabs[0]!.root])).toEqual([[space, first, { split: "right", ratio: 0.5, first: { leaf: first }, second: { leaf: second } }]]);
    await run("new_workspace");
    const bystander = followed();

    // a pane whose shell runs: it ends, and no other
    await run("close_pane", pane(second), { seen: await seen(second) });
    expect(await live()).toEqual([first, bystander].sort());
    // a tab of its own: it ends, and no other
    await run("new_tab", { kind: "workspace", id: space }, { name: "second" });
    const tabbed = followed();
    const tab = (await hc.call("terminal.get", { terminal: tabbed })).labels?.["herdr.tab"]!;
    await run("close_tab", { kind: "tab", id: tab }, { seen: await seen(tabbed) });
    expect(await live()).toEqual([first, bystander].sort());
    // the workspace, as a dialog kept it before another terminal joined it: nothing ends
    const kept = await seen(first);
    await run("split_horizontal", pane(first));
    const joined = followed();
    await run("close_workspace", { kind: "workspace", id: space }, { seen: kept });
    expect(await live()).toEqual([first, bystander, joined].sort());
    // a terminal made at another time than the one shown: nothing ends
    await run("close_workspace", { kind: "workspace", id: space }, { seen: [{ ...kept[0]!, created: kept[0]!.created - 1 }, ...await seen(joined)] });
    expect(await live()).toEqual([first, bystander, joined].sort());
    // as shown: the workspace's two end, the other workspace's stays
    await run("close_workspace", { kind: "workspace", id: space }, { seen: await seen(first, joined) });
    expect(await live()).toEqual([bystander]);
    expect(answers.filter((answer) => answer.type === "notice")).toEqual([
      { type: "notice", code: "target_changed", data: { action: "close_workspace" } },
      { type: "notice", code: "target_changed", data: { action: "close_workspace" } },
    ]);
    expect((await hc.call("doc.get", { name: LAYOUT_DOC })).value ?? null).toBeNull();

    // a pane whose program ended by itself: closing it removes its record; a workspace holding one closes whole
    const endedIn = async (space: string, tab: string) => {
      const made = (await hc.call("terminal.run", { keep: true, argv: ["sh", "-c", "exit 0"], labels: { "herdr.space": space, "herdr.tab": tab } })).address;
      for (const end = Date.now() + WAIT_MS; (await hc.call("terminal.get", { terminal: made })).state === "live"; await new Promise((resolve) => setTimeout(resolve, 20))) {
        if (Date.now() > end) throw new Error(`${made} did not end within ${WAIT_MS}ms`);
      }
      return made;
    };
    await run("new_workspace");
    const holder = followed();
    const keptLabels = (await hc.call("terminal.get", { terminal: holder })).labels!;
    const gone = await endedIn(keptLabels["herdr.space"]!, keptLabels["herdr.tab"]!);
    await run("close_pane", pane(gone), { seen: await seen(gone) });
    const lastOne = await endedIn(keptLabels["herdr.space"]!, keptLabels["herdr.tab"]!);
    await run("close_workspace", { kind: "workspace", id: keptLabels["herdr.space"]! }, { seen: await seen(holder, lastOne) });
    expect([(await hc.call("terminal.list", { all: true })).terminals.map((terminal) => terminal.address), answers.filter((answer) => answer.type === "notice").length]).toEqual([[bystander], 2]);
  }, TEST_MS);
});
