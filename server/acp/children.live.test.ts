import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedCore, pidAlive, type StopReport } from "../../scripts/test-hc.ts";
import { startHerdrCoreAdapter } from "../herdr-core/adapter.ts";
import { sessionSnapshot } from "../herdr/client.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AcpChildren } from "./children.ts";
import { FAKE_AGENT, KEEPER_BUILD, keeperBuilt, until } from "./keeper.fake.ts";

/**
 * AcpChildren against a real hc, in a core of its own (scripts/test-hc.ts): a session, state, config and runtime folders
 * no other core uses, so the user's core and the Herdr app never see it. Run with OVIS_TEST_HC_BIN set to an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const TEST_MS = 30_000;
const WAIT_MS = 10_000;

describe.skipIf(!bin || !keeperBuilt)("AcpChildren against a real hc", () => {
  let core: IsolatedCore;
  let hc: HcConnection;
  let dir: string;

  beforeAll(async () => {
    serveRuntime(HERDR_CORE);
    core = new IsolatedCore(bin!);
    await core.start();
    hc = new HcConnection(() => {
      const child = Bun.spawn([core.bin, "connect"], { env: core.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      return {
        readable: child.stdout,
        write: (bytes: Uint8Array) => { child.stdin.write(bytes); void child.stdin.flush(); },
        exited: child.exited,
        kill: () => child.kill(),
      };
    });
    dir = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "acpl-"));
  }, TEST_MS);

  afterAll(async () => {
    serveRuntime(null);
    hc?.close();
    const report: StopReport | null = core ? await core.stop() : null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    expect(report && { killed: report.killed, unproven: report.unproven, alive: report.alive }).toEqual({ killed: [], unproven: [], alive: [] });
  }, TEST_MS);

  it("runs the agent under its parent, brings its permission request to a card's answer, and leaves no process behind once stopped", async () => {
    const children = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD });
    const parent = (await hc.call("terminal.run", { argv: ["sleep", "600"], no_parent: true })).address;
    const child = await children.start({ harness: "codex", argv: [FAKE_AGENT], cwd: dir, parentPane: parent });
    expect((await hc.call("terminal.get", { terminal: child.terminal })).parent).toBe(parent);
    expect(children.forPane(child.terminal)).toBe(child);

    const adapter = await startHerdrCoreAdapter(hc, join(dir, "adapter.sock"), undefined, { acp: children });
    const pane = async () => (await sessionSnapshot(adapter.socketPath)).panes.find(({ pane_id }) => pane_id === child.terminal);
    try {
      const snapshot = await sessionSnapshot(adapter.socketPath);
      const childPane = snapshot.panes.find(candidate => candidate.pane_id === child.terminal);
      expect(childPane).toMatchObject({ agent: "codex", acp_child: true, agent_status: "idle", parent_pane_id: parent, label: "Codex" });
      expect(snapshot.tabs.find(tab => tab.tab_id === childPane?.tab_id)?.label).toBe("Codex");
      const { client } = child;
      const turn = client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "ask" }] });
      await until(client, "the permission request", () => client.pending().length === 1);
      expect(await pane()).toMatchObject({ agent_status: "blocked", agent_kind: "permission" });
      expect(client.pending()[0]!.options.map((option) => option.optionId)).toEqual(["allow", "reject"]);
      expect(await client.answer(client.pending()[0]!.keeperId, "allow")).toBe("won");
      expect(await turn).toEqual({ stopReason: "end_turn" });
      expect(client.turn).toMatchObject({ running: false, stopReason: "end_turn", text: "answered allow" });

      expect(await pane()).toMatchObject({ agent_status: "done" });
      const hold = client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "hold" }] });
      await until(client, "working", () => client.turn?.running === true);
      expect(await pane()).toMatchObject({ agent_status: "working" });
      await client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "release" }] });
      await hold;
      const pids = JSON.parse(readFileSync(join(child.root, "process.json"), "utf8")) as { keeper: number; child: number };
      expect(pidAlive(pids.keeper) && pidAlive(pids.child)).toBe(true);
      await children.stop(child.id);
      const deadline = Date.now() + WAIT_MS;
      while (pidAlive(pids.keeper) || pidAlive(pids.child)) {
        if (Date.now() > deadline) throw new Error(`the keeper (${pids.keeper}) or its agent (${pids.child}) still runs after stop`);
        await Bun.sleep(25);
      }
      expect((await hc.call("terminal.get", { terminal: child.terminal })).state).not.toBe("live");
      expect(children.forPane(child.terminal)).toBeUndefined();
    } finally { adapter.stop(); await children.stop(child.id); await hc.call("terminal.kill", { terminal: parent }); }
  }, TEST_MS);

  it("drops the agent identity when it exits but its keeper terminal is still live", async () => {
    const children = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD });
    const child = await children.start({ harness: "fake", name: "Review helper", argv: [FAKE_AGENT], cwd: dir });
    const adapter = await startHerdrCoreAdapter(hc, join(dir, "exit.sock"), undefined, { acp: children });
    try {
      const { client } = child;
      const shown = await sessionSnapshot(adapter.socketPath);
      const pane = shown.panes.find(pane => pane.pane_id === child.terminal);
      expect(pane?.label).toBe("Review helper");
      expect(shown.tabs.find(tab => tab.tab_id === pane?.tab_id)?.label).toBe("Review helper");
      await client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "answer-and-quit" }] });
      await until(client, "agent exit", () => client.agentGone);
      expect((await sessionSnapshot(adapter.socketPath)).panes.find(pane => pane.pane_id === child.terminal)).toMatchObject({ agent: null, agent_status: "unknown" });
    } finally { adapter.stop(); await children.stop(child.id); }
  }, TEST_MS);

  it("keeps a turn across a server restart: the next server takes the child up mid-turn and sees the turn end", async () => {
    const before = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD });
    const child = await before.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir });
    void child.client.request("session/prompt", { sessionId: child.client.session, prompt: [{ type: "text", text: "hold" }] }).catch(() => undefined);
    await until(child.client, "the running turn", () => child.client.turn?.running === true);
    before.close();

    const after = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD });
    await after.restore();
    const restored = after.forPane(child.terminal)!;
    expect(restored).toMatchObject({ id: child.id, harness: "fake" });
    await until(restored.client, "the replayed turn", () => restored.client.turn?.running === true);
    await restored.client.request("session/prompt", { sessionId: restored.client.session, prompt: [{ type: "text", text: "release" }] });
    expect(restored.client.turn).toMatchObject({ running: false, stopReason: "end_turn" });
    await after.stop(child.id);
  }, TEST_MS);
});
