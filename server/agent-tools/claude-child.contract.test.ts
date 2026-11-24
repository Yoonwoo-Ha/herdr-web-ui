import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, isRecord } from "../../shared/harness-tool.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AcpChildren, type AcpHc } from "../acp/children.ts";
import { KEEPER_BUILD, keeperBuilt, until } from "../acp/keeper.fake.ts";
import { lineCall } from "../line-call.ts";
import { AgentToolHub } from "./hub.ts";

const REPLAY = join(import.meta.dir, "replay-agent.fake.ts");
const ASKED = ["Write", "Bash", "Bash", "WebFetch", "WebSearch", "mcp__ovis-agent__ovis_lookup"];

/** A Claude child of a parent whose permissions Ovis cannot prove, against each recorded real adapter (with Claude Code 2.1.330). */
describe.skipIf(!keeperBuilt).each(["0.110.0", "0.112.0"])("a Claude child of claude-agent-acp %s in its ask-for-everything launch", adapter => {
  const FIXTURE = join(import.meta.dir, "fixtures", `claude-agent-acp-${adapter}-ask.jsonl`);
  let dir: string, hub: AgentToolHub, acp: AcpChildren, token: string, connection: HcConnection;
  const programs = new Map<string, ReturnType<typeof Bun.spawn>>();
  beforeEach(() => {
    serveRuntime(HERDR_CORE);
    dir = mkdtempSync(join(tmpdir(), "cc-"));
    writeFileSync(join(dir, "version"), "2.1.330 (Claude Code)\n");
    const claude = join(dir, "claude");
    writeFileSync(claude, `#!/bin/sh\ncat "${join(dir, "version")}"\n`);
    chmodSync(claude, 0o755);
    const fake = new FakeHcCore();
    fake.onStart = program => { programs.set(program.address, Bun.spawn([...program.argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })); };
    connection = new HcConnection(() => fake.transport());
    const hc: AcpHc = { call: (method, params) => {
      if (method === "terminal.kill" && "terminal" in params && typeof params.terminal === "string") programs.get(params.terminal)?.kill();
      return connection.call(method, params);
    } };
    acp = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD, sessionMs: 5000 });
    hub = new AgentToolHub({ dir: join(dir, "tools"), acp, setting: () => ({ level: "start", depth: 1, harnesses: ["claude"] }),
      resolve: kind => kind === "claude" ? { argv: [process.execPath, REPLAY, FIXTURE, join(dir, "replay.jsonl")], env: { CLAUDE_CODE_EXECUTABLE: claude } } : null });
    hub.listen();
    const parent = hub.runs.reserve();
    parent.bind({ self: "top", harness: "claude", depth: 0, root: parent.id, started_by: null });
    token = readFileSync(parent.tokenFile, "utf8");
  });
  afterEach(async () => {
    hub.close(); acp.close();
    for (const proc of programs.values()) { proc.kill(); await proc.exited; }
    programs.clear(); connection.close(); serveRuntime(null); rmSync(dir, { recursive: true, force: true });
  });
  async function call(verb: string, args: object) {
    const value = await lineCall(hub.address, { id: 1, contract: HARNESS_CONTRACT, token, verb, args }, 10_000);
    if (!isRecord(value)) throw new Error("invalid answer");
    return value;
  }
  const replayed = () => readFileSync(join(dir, "replay.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
  async function rejectEveryCard(session: string) {
    const child = acp.forPane(session)!;
    for (const name of ASKED) {
      expect(await call("wait", { session, timeout_s: 5 })).toMatchObject({ state: { state: "waiting_human" } });
      const card = child.client.pending()[0]!;
      expect(card.options.map(option => option.kind)).toEqual(["allow_once", "reject_once"]);
      expect(JSON.stringify(card)).toContain(name);
      expect(await child.client.answer(card.keeperId, "reject")).toBe("won");
    }
    expect(await call("wait", { session, timeout_s: 5 })).toMatchObject({ state: { state: "done" } });
  }

  it("opens in the recipe's mode, brings every recorded action to a person, and keeps asking on the next send", async () => {
    const started = await call("start", { harness: "claude", cwd: dir, task: "do the five actions" });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
    const session = started.session.address;
    const opened = replayed()[0]!.sessionNew;
    expect(opened.configOptions).toEqual([{ configId: "mode", value: "default" }]);
    expect(opened._meta.claudeCode.options).toMatchObject({ settingSources: [], allowDangerouslySkipPermissions: false, tools: expect.not.arrayContaining(["EnterWorktree", "Agent", "Skill"]),
      settings: { disableAllHooks: true, permissions: { defaultMode: "default", ask: expect.arrayContaining(["Write", "Edit", "Bash", "WebFetch", "WebSearch", "mcp__ovis-agent"]) } } });
    expect(acp.forPane(session)?.client.sessionMode).toBe("default");
    await rejectEveryCard(session);
    expect(await call("send", { session, task: "again" })).toMatchObject({ accepted: true });
    await rejectEveryCard(session);
    expect(acp.forPane(session)?.client.sessionMode).toBe("default");
    expect(replayed().slice(1).map(row => [row.answered, row.answer.outcome.optionId])).toEqual([...ASKED, ...ASKED].map(name => [name, "reject"]));
  });

  it("takes no new task once the child reports a wider mode", async () => {
    const started = await call("start", { harness: "claude", cwd: dir });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
    const session = started.session.address;
    expect(await call("send", { session, task: "widen" })).toMatchObject({ accepted: true });
    const child = acp.forPane(session)!;
    await until(child.client, "the wider mode", () => child.client.sessionMode === "acceptEdits");
    expect(await call("wait", { session, timeout_s: 5 })).toMatchObject({ state: { state: "done" } });
    expect(await call("send", { session, task: "do the five actions" })).toMatchObject({ error: { code: "not_granted" } });
    expect(replayed().filter(row => row.answered)).toEqual([]);
  });

  it("refuses a Claude Code version its launch was not run against, and starts nothing", async () => {
    writeFileSync(join(dir, "version"), "2.1.331 (Claude Code)\n");
    expect(await call("start", { harness: "claude", cwd: dir })).toMatchObject({ error: { code: "not_granted" } });
    expect(programs.size).toBe(0);
  });
});
