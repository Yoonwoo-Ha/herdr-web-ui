import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./devin.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devin-skills-"));
  directories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const put = (path: string, content = "---\ndescription: Test skill. More information.\n---\nBody") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const commands = (environ: readonly string[] = []) => paneCommands("devin", cwd, home, { environ });
  const skills = (environ: readonly string[] = []) => commands(environ).filter((command) => command.source === "skill" && command.origin !== "bundled");
  return { root, home, cwd, put, commands, skills };
}

test("loads native user and project roots with directory names and origin", () => {
  const f = fixture();
  for (const [base, paths] of [
    [f.home, [".config/devin/skills/user", ".config/cognition/skills/cognition", ".agents/skills/agents"]],
    [f.cwd, [".devin/skills/project", ".cognition/skills/project-cognition", ".agents/skills/project-agents"]],
  ] as const) for (const path of paths) f.put(join(base, path, "SKILL.md"), "---\nname: display-only\ndescription: Test description.\n---");
  f.put(join(f.cwd, ".devin/skills/nested/child/SKILL.md"));
  const result = f.skills();
  expect(result.map((command) => [command.name, command.origin])).toEqual([
    ["agents", "user"], ["cognition", "user"], ["project", "project"],
    ["project-agents", "project"], ["project-cognition", "project"], ["user", "user"],
  ]);
});

test("pins recorded source collision and native root precedence", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":true}}');
  for (const root of [".devin/skills", ".cognition/skills", ".agents/skills", ".claude/skills"]) f.put(join(f.cwd, root, "collision/SKILL.md"));
  f.put(join(f.home, ".agents/skills/herdr/SKILL.md"));
  f.put(join(f.cwd, ".devin/skills/herdr/SKILL.md"));
  expect(f.skills().map((command) => [command.name, command.origin])).toEqual([
    ["agents:herdr", "user"], ["claude:collision", "project"],
    ["devin:collision", "project"], ["devin:herdr", "project"],
  ]);
});

test("project replaces user within one namespace without duplicate rows", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/skills/shared/SKILL.md"));
  f.put(join(f.cwd, ".devin/skills/shared/SKILL.md"));
  expect(f.skills()).toHaveLength(1);
  expect(f.skills()[0]).toMatchObject({ name: "shared", description: "Test skill. More information.", source: "skill", origin: "project" });
  expect(f.skills()[0]?.id).toEndWith("/project/.devin/skills/shared/SKILL.md");
});

test("hides model-only and empty trigger lists without hiding default or user triggers", () => {
  const f = fixture();
  f.put(join(f.cwd, ".devin/skills/default/SKILL.md"));
  for (const [name, triggers] of [["hidden", "[model]"], ["empty", "[]"], ["visible", "[user]"]] as const) {
    f.put(join(f.cwd, ".devin/skills", name, "SKILL.md"), `---\ntriggers: ${triggers}\n---`);
  }
  expect(f.skills().map((command) => command.name)).toEqual(["default", "visible"]);
});

test("imports recursive Claude, Windsurf, Copilot and Cursor skills when enabled", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":true,"windsurf":true,"copilot":true,"cursor":true}}');
  f.put(join(f.cwd, ".claude/skills/group/claude/SKILL.md"));
  f.put(join(f.home, ".claude/skills/personal/SKILL.md"));
  f.put(join(f.cwd, ".claude/commands/docs/release.md"));
  f.put(join(f.cwd, ".github/skills/group/copilot/SKILL.md"));
  f.put(join(f.home, ".copilot/skills/group/global/SKILL.md"));
  f.put(join(f.cwd, ".windsurf/skills/windsurf/SKILL.md"));
  f.put(join(f.home, ".codeium/windsurf/skills/global-windsurf/SKILL.md"));
  f.put(join(f.cwd, ".cursor/skills/group/project-cursor/SKILL.md"));
  f.put(join(f.home, ".cursor/skills/group/global-cursor/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual([
    "claude", "copilot", "docs:release", "global", "global-cursor", "global-windsurf",
    "personal", "project-cursor", "windsurf",
  ]);
});

test("JSONC disabled imports hide user and project imports while native roots remain", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), `{
    // Imports are disabled; strings containing URLs and trailing-comma text stay intact.
    "example": "https://example.com/a,}",
    "read_config_from": {"claude": false, "windsurf": false, "copilot": false,},
  }`);
  f.put(join(f.cwd, ".devin/config.json"), '{"read_config_from":{"claude":false,"windsurf":false,"copilot":false}}');
  for (const base of [f.home, f.cwd]) {
    f.put(join(base, ".claude/skills/claude/SKILL.md"));
    f.put(join(base, ".agents/skills/native/SKILL.md"));
  }
  f.put(join(f.cwd, ".claude/commands/hidden.md"));
  f.put(join(f.cwd, ".github/skills/copilot/SKILL.md"));
  f.put(join(f.cwd, ".windsurf/skills/windsurf/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual(["native"]);
});

test("defaults user and project Claude skill roots on with no config", () => {
  const f = fixture();
  f.put(join(f.home, ".claude/skills/x/SKILL.md"));
  f.put(join(f.cwd, ".claude/skills/project-only/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual(["project-only", "x"]);
});

test("disables a Claude skill only when read_config_from says false", () => {
  const f = fixture();
  f.put(join(f.home, ".claude/skills/x/SKILL.md"));
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":false}}');
  expect(f.skills().map((command) => command.name)).not.toContain("x");
});

test("treats an invalid read_config_from array as defaults", () => {
  const f = fixture();
  f.put(join(f.home, ".claude/skills/x/SKILL.md"));
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":["cursor"]}');
  expect(f.skills().map((command) => command.name)).toContain("x");
});

test("leaves a non-colliding imported Claude skill unqualified", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":true}}');
  f.put(join(f.home, ".claude/skills/x/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toContain("x");
  expect(f.skills().map((command) => command.name)).not.toContain("claude:x");
});

test("qualifies imported and native skills when their names collide", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":true}}');
  f.put(join(f.home, ".claude/skills/x/SKILL.md"));
  f.put(join(f.cwd, ".devin/skills/x/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual(["claude:x", "devin:x"]);
});

test("project opt-out does not disable the user Claude skill root", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":true}}');
  f.put(join(f.cwd, ".devin/config.json"), '{"read_config_from":{"claude":false}}');
  f.put(join(f.home, ".claude/skills/x/SKILL.md"));
  f.put(join(f.cwd, ".claude/skills/project-only/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual(["x"]);
});

test("user opt-out also disables the project Claude skill root", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":false}}');
  f.put(join(f.cwd, ".devin/config.json"), '{"read_config_from":{"claude":true}}');
  f.put(join(f.home, ".claude/skills/user-only/SKILL.md"));
  f.put(join(f.cwd, ".claude/skills/project-only/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual([]);
});

test("disables both Claude skill roots when both configs say false", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":false}}');
  f.put(join(f.cwd, ".devin/config.json"), '{"read_config_from":{"claude":false}}');
  f.put(join(f.home, ".claude/skills/user-only/SKILL.md"));
  f.put(join(f.cwd, ".claude/skills/project-only/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual([]);
});

test("honors process XDG and user opt-outs for project imports", () => {
  const f = fixture();
  const config = join(f.root, "config");
  const copilot = join(f.root, "copilot");
  f.put(join(config, "devin/config.json"), '{"read_config_from":{"claude":false,"copilot":true}}');
  f.put(join(config, "devin/skills/xdg/SKILL.md"));
  f.put(join(f.home, ".config/devin/skills/wrong/SKILL.md"));
  f.put(join(copilot, "skills/custom/SKILL.md"));
  f.put(join(f.cwd, ".devin/config.json"), '{"read_config_from":{"claude":true}}');
  f.put(join(f.cwd, ".claude/skills/enabled/SKILL.md"));
  expect(f.skills([`XDG_CONFIG_HOME=${config}`, `COPILOT_HOME=${copilot}`]).map((command) => command.name)).toEqual(["custom", "xdg"]);
});

test("loads plugin manifests, relocated skills and disabled skill roots without following cycles", () => {
  const f = fixture();
  const data = join(f.root, "data");
  const plugins = join(data, "devin/cli/plugins");
  f.put(join(plugins, "cache/active/.devin-plugin/plugin.json"), '{"name":"tools","skills":["custom"]}');
  f.put(join(plugins, "cache/active/custom/review/SKILL.md"));
  f.put(join(plugins, "cache/active/skills/wrong/SKILL.md"));
  f.put(join(plugins, "disabled/.claude-plugin/plugin.json"), '{"name":"off","skills":[]}');
  f.put(join(plugins, "disabled/skills/hidden/SKILL.md"));
  symlinkSync(plugins, join(plugins, "cycle"));
  expect(f.skills([`XDG_DATA_HOME=${data}`])).toMatchObject([
    expect.objectContaining({ name: "tools:review", description: "Test skill. More information.", source: "skill", origin: "plugin", id: expect.stringContaining("/cache/active/custom/review/SKILL.md") }),
  ]);
});

test("keeps Devin commands and lists formerly omitted terminal screens", () => {
  const f = fixture();
  const names = f.commands().map((command) => command.name);
  for (const name of ["login", "goal", "code", "fusion", "share", "cloud", "handoff", "pickup", "ssh", "bypass-permissions", "models", "debug", "workspaces", "normal", "rename", "mcp", "upload-secrets", "declarative-repo-setup"]) expect(names).toContain(name);
  for (const name of ["repo", "platform"]) expect(names).not.toContain(name);
});

test("describes Devin's terminal-bound and picker forms in the scanner source", () => {
  const terminal = ["status", "context", "session-stats", "help", "usage", "workspaces", "recap", "steps"];
  expect(source.terminalBound).toEqual(expect.arrayContaining([...terminal, "model", "fusion", "org", "billing"]));
  for (const name of terminal) {
    expect(source.forms?.[name]).toEqual([{ match: "bare", interaction: "terminal" }]);
  }
  for (const name of ["model", "fusion", "org", "billing", "shortcuts", "btw", "handoff", "logout"]) {
    expect(source.forms?.[name]).toEqual([{ match: "bare", interaction: "terminal" }]);
  }
  // a picker or form bare, an action given a value; an untrusted directory asks first
  for (const name of ["mode", "revert", "bug"]) expect(source.forms?.[name]?.[0]).toEqual({ match: "bare", interaction: "terminal" });
  expect(source.forms?.mode?.[1]).toEqual({ match: "other", interaction: "none" });
  expect(source.forms?.["add-dir"]).toEqual([{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "terminal" }]);
  expect(source.pin).toBe("3000.11.92");
});

test("every Devin discovered skill has a stable identity", () => {
  const f = fixture();
  f.put(join(f.cwd, ".devin/skills/local/SKILL.md"));
  f.put(join(f.home, ".config/devin/config.json"), '{"read_config_from":{"claude":true}}');
  f.put(join(f.home, ".claude/skills/imported/SKILL.md"));
  const discovered = source.discover({ home: f.home, cwd: f.cwd, repoRoot: f.cwd, env: null, roots: {} });
  expect(discovered.filter(({ source: type }) => type === "skill").every(({ id }) => typeof id === "string" && id.length > 0)).toBe(true);
});

test("catalog core marks Devin terminal commands", () => {
  const f = fixture();
  const commands = f.commands();
  const status = commands.find(({ name }) => name === "status");
  expect(status).toMatchObject({
    visibility: "terminal",
    forms: [{ match: "bare", interaction: "terminal" }],
    provenance: { transport: "static", verified: false },
  });
});

test("catalog core marks Devin bundled skills", () => {
  const f = fixture();
  const commands = f.commands();
  const upload = commands.find(({ name }) => name === "upload-secrets");
  expect(upload).toMatchObject({
    source: "builtin",
    provenance: { transport: "static", verified: false },
  });
});

test("lists MCP prompts declared by configured servers without connecting", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/mcp_config.json"), JSON.stringify({
    mcpServers: {
      linear: { command: "unused", prompts: ["bug_report", "triage"] },
      disabled: { command: "unused", disabled: true, prompts: ["private"] },
    },
  }));
  f.put(join(f.cwd, ".devin/mcp_config.json"), JSON.stringify({
    mcpServers: { project: { url: "https://example.invalid/mcp", prompts: ["review"] } },
  }));
  const commands = source.discover({ home: f.home, cwd: f.cwd, repoRoot: f.cwd, env: null, roots: {} });
  expect(commands.filter((command) => command.name.startsWith("mcp__")).map(({ name }) => name)).toEqual([
    "mcp__linear__bug_report", "mcp__linear__triage", "mcp__project__review",
  ]);
});

test("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
  const f = fixture();
  const real = join(f.home, ".config/devin/skills");
  f.put(join(real, "aliased/SKILL.md"));
  mkdirSync(join(f.home, ".agents"), { recursive: true });
  symlinkSync(real, join(f.home, ".agents/skills"), "dir");
  const rows = f.skills().filter(({ name }) => name === "aliased");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ origin: "user", id: realpathSync(join(real, "aliased/SKILL.md")) });
});

test("identifies an imported Claude project command by its real file", () => {
  const f = fixture();
  const shared = join(f.root, "shared");
  f.put(join(shared, "ship.md"), "Ship it\n");
  mkdirSync(join(f.cwd, ".claude"), { recursive: true });
  symlinkSync(shared, join(f.cwd, ".claude/commands"), "dir");
  const rows = f.commands().filter(({ name }) => name === "ship");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: realpathSync(join(shared, "ship.md")) });
});

test("lists an imported skill that is the same file as a native one once, under Devin's native name", () => {
  // native Devin 3000.11.92 lists one skill when ~/.claude/skills links to ~/.config/devin/skills
  const f = fixture();
  const native = join(f.home, ".config/devin/skills");
  f.put(join(native, "linked/SKILL.md"));
  mkdirSync(join(f.home, ".claude"), { recursive: true });
  symlinkSync(native, join(f.home, ".claude/skills"), "dir");
  // a different file with a native name still collides and is qualified
  f.put(join(native, "other/SKILL.md"));
  f.put(join(f.cwd, ".claude/skills/other/SKILL.md"));
  const names = f.skills().map(({ name }) => name);
  expect(names.filter((name) => name.endsWith("linked"))).toEqual(["linked"]);
  expect(f.skills().find(({ name }) => name === "linked")).toMatchObject({ origin: "user", id: realpathSync(join(native, "linked/SKILL.md")) });
  expect(names).toContain("devin:other");
  expect(names).toContain("claude:other");
});
