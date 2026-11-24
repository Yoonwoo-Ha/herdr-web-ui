import { expect, it, spyOn } from "bun:test";
import { agentLaunch } from "../agent-launch.ts";
import * as shell from "../shell-agent.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpChildren } from "../acp/children.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { HARNESS_SKILL } from "../../shared/harness-skill.ts";
import { TOOL_SCHEMAS, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { AgentToolHub } from "./hub.ts";
import { forgetLocalRun, launchHarnessTool, useAgentToolHub } from "./launch.ts";
import { mcpMessage } from "./mcp.ts";

it.skipIf(process.platform === "win32")("one launch config holds both relays; no run secret is in argv, config or the MCP answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "at-launch-"));
  let setting: HarnessToolSetting = { level: "start", depth: 2, harnesses: ["opencode"] };
  const hub = new AgentToolHub({ dir, acp: new AcpChildren(join(dir, "acp")), setting: () => setting });
  serveRuntime(HERDR_CORE); useAgentToolHub(hub);
  try {
    hub.listen();
    for (const kind of ["claude","codex","copilot"]) {
      const launch = launchHarnessTool("t1", kind, { platform: "linux", args: ["--", "prompt"], browsers: { [kind]: "playwright" } });
      if (!launch) throw new Error("no launch");
      const token = readFileSync(launch.tokenFile, "utf8");
      expect(launch.args.slice(-2)).toEqual(["--", "prompt"]);
      const config = kind === "codex" ? launch.args.join(" ") : readFileSync(String(launch.args[1]).replace(/^@/, ""), "utf8");
      expect(config).toContain("ovis-agent"); expect(config).toContain("ovis-browser");
      expect(config).not.toContain(token);
      expect(JSON.stringify(launch.args)).not.toContain(token);
      expect(statSync(launch.socket).mode & 0o777).toBe(0o600);
      const door = { socket: launch.socket, tokenFile: launch.tokenFile };
      expect(await mcpMessage(door, { method: "initialize", id: 1 })).toMatchObject({result:{ instructions: HARNESS_SKILL }});
      const tools = await mcpMessage(door, { method: "tools/list", id: 2 });
      expect(tools).toMatchObject({ result: { tools: Object.entries(TOOL_SCHEMAS).map(([v,schema]) => ({ name: `agent_${v}`, inputSchema: schema })) } });
      expect(JSON.stringify(tools)).not.toContain(token);
      const replacement = spyOn(shell, "startShellAgent").mockRejectedValueOnce(new Error("fixture: replacement missing"));
      try {
        expect(await agentLaunch("t1", { kind: "omo" })).toMatchObject({ agent_started: false });
        expect(hub.runs.verify(token)?.self).toBe("t1");
      } finally { replacement.mockRestore(); }
      forgetLocalRun("t1");
      expect(hub.runs.verify(token)).toBeNull();
      expect(existsSync(launch.tokenFile)).toBe(false);
    }
    setting = { ...setting, level: "off" };
    hub.settingsChanged();
    expect(launchHarnessTool("t1", "claude", { platform: "linux", browsers: {} })).toBeNull();
  } finally { useAgentToolHub(null); serveRuntime(null); hub.close(); rmSync(dir,{recursive:true,force:true}); }
});
