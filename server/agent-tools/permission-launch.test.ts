import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_REVIEW, OPEN_REVIEW, askable, claudeManagedPaths, claudeManagedPolicy, permissionLaunch } from "./permission-launch.ts";

it("an unknown parent can launch only the named all-ask profile, never an adapter default", () => {
  const cmd = { argv: ["/bin/opencode", "acp"] };
  const recipe = permissionLaunch("opencode", undefined, "abc123", cmd);
  if (!recipe?.env?.OPENCODE_CONFIG_CONTENT) throw new Error("No all-ask launch policy");
  const config = JSON.parse(recipe.env.OPENCODE_CONFIG_CONTENT);
  expect(config.default_agent).toBe("ovis-ask-abc123");
  expect(config.agents[config.default_agent].permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
  expect(recipe.ceiling.mode).toBe(config.default_agent);
  expect(recipe.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  expect(recipe).toMatchObject({ askEveryTime: true, privateFiles: { OPENCODE_DB: "opencode.db" } });
  for (const kind of ["codex","gjc","agy","copilot"]) {
    expect(askable(kind)).toBe(false);
    expect(permissionLaunch(kind, undefined, "abc123", cmd)).toBeNull();
  }
  expect(permissionLaunch("opencode", "readonly", "abc123", cmd)).toBeNull();
});

it("Claude's all-ask launch sets its mode before the session answers and loads no user, project or hook setting", () => {
  const cmd = { argv: ["/bin/claude-agent-acp", "--hide-claude-auth"], env: { CLAUDE_CODE_EXECUTABLE: "/bin/claude" } };
  const before = process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  const recipe = permissionLaunch("claude", undefined, "abc123", cmd);
  process.env["CLAUDE_CONFIG_DIR"] = "/config";
  const named = permissionLaunch("claude", undefined, "abc123", cmd);
  if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"]; else process.env["CLAUDE_CONFIG_DIR"] = before;
  if (!recipe) throw new Error("No all-ask launch for Claude");
  expect(recipe.argv).toEqual(["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", ...cmd.argv]);
  expect(named).toMatchObject({ argv: cmd.argv, env: { ...cmd.env, CLAUDE_CONFIG_DIR: "/config" } });
  expect(recipe).toMatchObject({ env: cmd.env, askEveryTime: true, ceiling: { profile: CLAUDE_REVIEW, mode: "default" },
    configOptions: [{ configId: "mode", value: "default" }] });
  expect(recipe.sessionMeta).toEqual({ claudeCode: { options: { settingSources: [], allowDangerouslySkipPermissions: false,
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch"], settings: {
    disableAllHooks: true, sandbox: { autoAllowBashIfSandboxed: false },
    permissions: { defaultMode: "default", ask: ["Write", "Edit", "Bash", "WebFetch", "WebSearch", "mcp__ovis-agent"] } } } } });
  expect(permissionLaunch("claude", OPEN_REVIEW, "abc123", cmd)?.ceiling.profile).toBe(CLAUDE_REVIEW);
  expect(permissionLaunch("opencode", CLAUDE_REVIEW, "abc123", { argv: ["/bin/opencode"] })?.ceiling.profile).toBe(OPEN_REVIEW);
  expect(permissionLaunch("claude", "readonly", "abc123", cmd)).toBeNull();
});

it("a managed Claude Code policy file refuses the Claude launch", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  try {
    const policy = join(dir, "managed-settings.json");
    expect(claudeManagedPolicy([policy])).toBeNull();
    writeFileSync(policy, "{}");
    expect(claudeManagedPolicy([policy])).not.toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("the Claude launch also looks for an MDM profile and a claude.ai organization's cached policy", () => {
  const before = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = "/config";
  try {
    expect(claudeManagedPaths()).toEqual(expect.arrayContaining(["/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-mcp.json",
      "/Library/Managed Preferences/com.anthropic.claudecode.plist", "/config/remote-settings.json"]));
  } finally { if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"]; else process.env["CLAUDE_CONFIG_DIR"] = before; }
});
