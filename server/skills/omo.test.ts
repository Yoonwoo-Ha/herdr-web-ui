import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./omo.ts";

const roots: string[] = [];
// Names and stable labels are copied from the pinned Senpi README/extension registrations
// and OmO senpi's pinned component registrations (commits cited in omo.ts).
const PINNED_OMO_BUILTINS = `settings\tTheme, message delivery, transport, and other preferences
model\tSwitch this session's model; Ctrl+S in the picker, or /model <id> --default, also makes it the startup default
thinking\tSwitch thinking level; Ctrl+S in the picker saves the startup default
scoped-models\tEnable/disable models for Ctrl+P cycling
favorite-models\tManage favorite models for Ctrl+P cycling
export\tExport session to HTML or JSONL file
import\tImport and resume a session from a JSONL file
share\tUpload as private GitHub gist with shareable HTML link
copy\tCopy last assistant message to clipboard
rename\tRename the current session (\`/name\` is an alias)
name\tRename the current session (\`/name\` is an alias)
session\tShow session info (file, ID, messages, tokens, cost)
changelog\tDisplay version history
hotkeys\tShow all keyboard shortcuts
fork\tCreate a new session from a previous user message
clone\tDuplicate the current active branch into a new session
trust\tSave project trust decision for future sessions (restart required)
login\tManage provider credentials
logout\tManage provider credentials
new\tStart a new session
compact\tManually compact context, optional custom instructions
resume\tPick from previous sessions
sessions\tAlias of /resume (browse and resume past sessions)
reload\tReload keybindings, extensions, skills, prompts, themes, and context files
quit\tQuit omo
exit\tQuit omo
tasks\tList session tasks (--all for every session).
dag\tList dag runs, or show one run's wave tree.
doctor\tRun deterministic memory health checks and repair skill frontmatter.
facts\tShow facts-extraction queue/backoff state, or manually retry parked batches.
memory\tView committed memory: HEAD, system bodies, external names, and uncommitted changes; unlock re-checks and removes a stranded git lock.
people\tShow the people roster and relationship graph, one person's record, or ask about them.
search\tSearch past session transcripts and show scored, numbered results.
task-kill\tCancel a session task via selector.
computer\tComputer use (experimental): on, off, status, stop, or resume (stop and resume are user-only)
dream\tRequest a manual multi-conversation memory dream run.
init\tInitialize the memory repository and instruct the agent to create initial memory.
memfs\tInspect and maintain the memory filesystem repository.
memory-repository\tConfigure the push-only mirror remote for the memory repository.
recompile\tRecompile the memory block into the system prompt on the next agent run.
reflect\tRequest a memory reflection run now, optionally scoped and focused.
remember\tPersist text to long-term memory via a memory-tool turn.
sleeptime\tShow the resolved sleeptime memory settings for this identity.
palace\tGenerate the memory palace HTML viewer for the bound identity.
help\tShow usage, keybindings, and all commands
keybindings\tOpen your keybindings.json in $EDITOR and reload it live
history\tSearch prompt history across sessions
files\tShow files read/written/edited in this session
diff\tShow git changes and open in VS Code diff view
lookat\tView and manage the current-session look_at vision model chain.
account\tList and manage credential accounts for any provider.
claude-account\tList and manage Anthropic Subscription accounts.
cursor-account\tList and manage Cursor CLI (OAuth) accounts.
gpt-account\tList and manage ChatGPT Subscription OAuth accounts.
efforts\tShow or set the reasoning effort for the current model
answer\tOpen the pending question
goal\tSet, inspect, pause, resume, or clear the persistent goal
loop\tRepeat a prompt on a fixed interval or a self-paced schedule (e.g. /loop 5m check the deploy)
mcp\tInspect and manage MCP servers.
fallback\tView and manage retry model fallback chains.
reasoning\tShow or toggle reasoning for the current model
rules\tInspect loaded pi-rules.
reload-rules\tReload pi-rules for the current session.
fast\tTurn ChatGPT Subscription fast mode on or off for the current model
todo\tShow or edit the todo list (edit/copy/export/import/append/start/done/drop/rm)
tree\tJump to any point in the session and continue from there
ttsr\tShow TTSR stream-rule status: builtin detectors, user rules, injected rules.
websearch\tShow web search provider status
ir\tImport a CI issue-analysis session from a gist ID, share URL, or issue URL and switch to it
nested-agents\tToggle the nested AGENTS.md context widget and dump cache state.
tui\tShow TUI stats
btw\tAsk a side question in parallel without touching the main session`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-catalog-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  const pluginDir = join(root, "plugin");
  mkdirSync(join(home, ".omo"), { recursive: true });
  mkdirSync(join(cwd, ".omo"), { recursive: true });
  mkdirSync(join(pluginDir, "skills", "bundled-x"), { recursive: true });
  writeFileSync(join(pluginDir, "skills", "bundled-x", "SKILL.md"), "---\nname: bundled-x\ndescription: bundled fixture\n---\nBody\n");
  return { root, home, cwd, pluginDir };
}

describe("OmO command catalog", () => {
  test("matches pinned builtin names and descriptions exactly", () => {
    const ctx = fixture();
    const expected = PINNED_OMO_BUILTINS.split("\n").map((line) => line.split("\t") as [string, string]).sort(([a], [b]) => a.localeCompare(b));
    const actual = paneCommands("omo", null, ctx.home, { pluginDir: ctx.pluginDir })
      .filter((row) => row.source === "builtin")
      .map((row) => [row.name, row.description] as [string, string]);
    expect(actual).toEqual(expected);
    expect(source.pin).toBe("2026.10.19");
  });

  test("verifies static catalog rows only for the pinned Senpi major and minor", () => {
    const ctx = fixture();
    const matching = paneCommands("omo", null, ctx.home, { pluginDir: ctx.pluginDir }, "2026.10.42");
    const mismatched = paneCommands("omo", null, ctx.home, { pluginDir: ctx.pluginDir }, "2026.11.0");
    const pinnedNames = new Set([...source.builtins, ...(source.terminalBound ?? [])]);
    const pinnedRows = matching.filter((row) => row.source === "builtin" && pinnedNames.has(row.name));
    const extensionRows = matching.filter((row) => row.source === "builtin" && !pinnedNames.has(row.name));
    expect(pinnedRows.length).toBeGreaterThan(0);
    expect(pinnedRows.every((row) => row.provenance?.verified === true)).toBe(true);
    expect(extensionRows.length).toBeGreaterThan(0);
    expect(extensionRows.every((row) => row.provenance?.verified === false)).toBe(true);
    expect(mismatched.filter((row) => row.source === "builtin").every((row) => row.provenance?.verified === false)).toBe(true);
    const withoutPlugin = paneCommands("omo", null, ctx.home, {}, "2026.10.19");
    expect(withoutPlugin.find((row) => row.name === "tasks")?.provenance).toEqual({ transport: "static", verified: false });
  });

  test("hides plugin bundled skills disabled in project config", () => {
    const ctx = fixture();
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), JSON.stringify({ disabled_skills: ["bundled-x"] }));
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:bundled-x")).toBe(false);
  });

  test("unions disabled skills from user, project, senpi, and selected profile config", () => {
    const ctx = fixture();
    for (const name of ["user-x", "project-x", "senpi-x", "profile-x"]) {
      mkdirSync(join(ctx.pluginDir, "skills", name), { recursive: true });
      writeFileSync(join(ctx.pluginDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nBody\n`);
    }
    writeFileSync(join(ctx.home, ".omo", "omo.jsonc"), JSON.stringify({
      disabled_skills: ["user-x"],
      profiles: { selected: { disabled_skills: ["profile-x"] } },
    }));
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), JSON.stringify({
      disabled_skills: ["project-x"],
      "[senpi]": { disabled_skills: ["senpi-x"] },
    }));
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: ["OMO_PROFILE=selected"], roots: { pluginDir: ctx.pluginDir } });
    for (const name of ["user-x", "project-x", "senpi-x", "profile-x"]) {
      expect(rows.some((row) => row.name === `skill:${name}`)).toBe(false);
    }
  });

  test("unions disabled skills from the legacy [senpi] harness block", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "legacy-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "legacy-x", "SKILL.md"), "---\nname: legacy-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), JSON.stringify({
      "[senpi]": { disabled_skills: ["legacy-x"] },
    }));
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:legacy-x")).toBe(false);
  });

  test("unions disabled skills from the canonical [native] harness block", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "native-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "native-x", "SKILL.md"), "---\nname: native-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), JSON.stringify({
      "[native]": { disabled_skills: ["native-x"] },
    }));
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:native-x")).toBe(false);
  });

  test("selects disabled skills with OCX_PROFILE", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "ocx-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "ocx-x", "SKILL.md"), "---\nname: ocx-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.home, ".omo", "omo.jsonc"), JSON.stringify({
      profiles: { selected: { disabled_skills: ["ocx-x"] } },
    }));
    const ocxRows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: ["OCX_PROFILE=selected"], roots: { pluginDir: ctx.pluginDir } });
    expect(ocxRows.some((row) => row.name === "skill:ocx-x")).toBe(false);
  });

  test("selects disabled skills from OPENCODE_CONFIG_DIR profile path", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "opencode-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "opencode-x", "SKILL.md"), "---\nname: opencode-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.home, ".omo", "omo.jsonc"), JSON.stringify({
      profiles: { opencode: { disabled_skills: ["opencode-x"] } },
    }));
    const rows = source.discover({
      ...ctx,
      repoRoot: ctx.cwd,
      env: [`OPENCODE_CONFIG_DIR=${join(ctx.home, ".omo", "profiles", "opencode")}`],
      roots: { pluginDir: ctx.pluginDir },
    });
    expect(rows.some((row) => row.name === "skill:opencode-x")).toBe(false);
  });

  test("falls back to user and project omo.json when omo.jsonc is absent", () => {
    const ctx = fixture();
    for (const name of ["user-json-x", "project-json-x"]) {
      mkdirSync(join(ctx.pluginDir, "skills", name), { recursive: true });
      writeFileSync(join(ctx.pluginDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nBody\n`);
    }
    rmSync(join(ctx.home, ".omo", "omo.jsonc"), { force: true });
    rmSync(join(ctx.cwd, ".omo", "omo.jsonc"), { force: true });
    writeFileSync(join(ctx.home, ".omo", "omo.json"), JSON.stringify({ disabled_skills: ["user-json-x"] }));
    writeFileSync(join(ctx.cwd, ".omo", "omo.json"), JSON.stringify({ disabled_skills: ["project-json-x"] }));
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:user-json-x")).toBe(false);
    expect(rows.some((row) => row.name === "skill:project-json-x")).toBe(false);
  });

  test("strips a leading BOM before parsing JSONC denylist with comments and trailing commas", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "bom-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "bom-x", "SKILL.md"), "---\nname: bom-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), "\uFEFF{\n  // pinned loader accepts JSONC comments\n  \"disabled_skills\": [\"bom-x\",],\n}\n");
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:bom-x")).toBe(false);
  });

  test("ignores malformed JSONC layers like the upstream loader", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "malformed-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "malformed-x", "SKILL.md"), "---\nname: malformed-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["malformed-x"]} /* unterminated');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:malformed-x")).toBe(true);
  });

  test("discards JSONC layers when comments split a boolean token", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "split-bool-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "split-bool-x", "SKILL.md"), "---\nname: split-bool-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["split-bool-x"],"task":tru/*comment*/e}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:split-bool-x")).toBe(true);
  });

  test("discards JSONC layers when comments split a number token", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "split-number-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "split-number-x", "SKILL.md"), "---\nname: split-number-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["split-number-x"],"task":1/*comment*/2}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:split-number-x")).toBe(true);
  });

  test("preserves URL strings containing comment-like text in JSONC", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "url-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "url-x", "SKILL.md"), "---\nname: url-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["url-x"],"url":"https://example.com/*x*/"}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:url-x")).toBe(false);
  });

  test("discards JSONC with a malformed empty object comma", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "empty-object-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "empty-object-x", "SKILL.md"), "---\nname: empty-object-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["empty-object-x"],"task":{,}}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:empty-object-x")).toBe(true);
  });

  test("discards JSONC with a malformed empty array comma", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "empty-array-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "empty-array-x", "SKILL.md"), "---\nname: empty-array-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["empty-array-x"],"disabled_agents":[,]}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:empty-array-x")).toBe(true);
  });

  test("discards JSONC with NBSP after a comma", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "nbsp-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "nbsp-x", "SKILL.md"), "---\nname: nbsp-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), `{"disabled_skills":["nbsp-x"],\u00a0}`);
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:nbsp-x")).toBe(true);
  });

  test("discards JSONC with a root-level trailing comma", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "root-comma-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "root-comma-x", "SKILL.md"), "---\nname: root-comma-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["root-comma-x"]},');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:root-comma-x")).toBe(true);
  });

  test("discards JSONC with trailing non-comment garbage", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "garbage-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "garbage-x", "SKILL.md"), "---\nname: garbage-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["garbage-x"]} garbage');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:garbage-x")).toBe(true);
  });

  test("discards JSONC when a comment splits a signed number", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "signed-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "signed-x", "SKILL.md"), "---\nname: signed-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["signed-x"],"task":-/*c*/1}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:signed-x")).toBe(true);
  });

  test("discards JSONC with a leading-dot number", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "leading-dot-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "leading-dot-x", "SKILL.md"), "---\nname: leading-dot-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["leading-dot-x"],"task":.1}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:leading-dot-x")).toBe(true);
  });

  test("discards JSONC with a trailing-dot number", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "trailing-dot-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "trailing-dot-x", "SKILL.md"), "---\nname: trailing-dot-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), '{"disabled_skills":["trailing-dot-x"],"task":1.}');
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:trailing-dot-x")).toBe(true);
  });

  test("reads disabled skills from project config above the nearest git boundary", () => {
    const ctx = fixture();
    const parent = join(ctx.home, "parent");
    const repository = join(parent, "repo");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(join(parent, ".omo"), { recursive: true });
    mkdirSync(join(ctx.pluginDir, "skills", "ancestor-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "ancestor-x", "SKILL.md"), "---\nname: ancestor-x\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(parent, ".omo", "omo.jsonc"), JSON.stringify({ disabled_skills: ["ancestor-x"] }));
    const rows = source.discover({ ...ctx, cwd: repository, repoRoot: repository, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:ancestor-x")).toBe(false);
  });

  test("ignores symlinked project .omo directories", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "symlink-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "symlink-x", "SKILL.md"), "---\nname: symlink-x\ndescription: fixture\n---\nBody\n");

    const linkedDirectoryProject = join(ctx.root, "linked-directory-project");
    const linkedDirectoryTarget = join(ctx.root, "linked-directory-target");
    mkdirSync(linkedDirectoryProject, { recursive: true });
    mkdirSync(join(linkedDirectoryTarget, ".omo"), { recursive: true });
    writeFileSync(join(linkedDirectoryTarget, ".omo", "omo.jsonc"), JSON.stringify({ disabled_skills: ["symlink-x"] }));
    symlinkSync(join(linkedDirectoryTarget, ".omo"), join(linkedDirectoryProject, ".omo"));
    const directoryRows = source.discover({ ...ctx, cwd: linkedDirectoryProject, repoRoot: linkedDirectoryProject, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(directoryRows.some((row) => row.name === "skill:symlink-x")).toBe(true);
  });

  test("ignores symlinked project config files", () => {
    const ctx = fixture();
    mkdirSync(join(ctx.pluginDir, "skills", "symlink-x"), { recursive: true });
    writeFileSync(join(ctx.pluginDir, "skills", "symlink-x", "SKILL.md"), "---\nname: symlink-x\ndescription: fixture\n---\nBody\n");
    const linkedFileProject = join(ctx.root, "linked-file-project");
    const linkedFileTarget = join(ctx.root, "linked-file-omo.jsonc");
    mkdirSync(join(linkedFileProject, ".omo"), { recursive: true });
    writeFileSync(linkedFileTarget, JSON.stringify({ disabled_skills: ["symlink-x"] }));
    symlinkSync(linkedFileTarget, join(linkedFileProject, ".omo", "omo.jsonc"));
    const fileRows = source.discover({ ...ctx, cwd: linkedFileProject, repoRoot: linkedFileProject, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(fileRows.some((row) => row.name === "skill:symlink-x")).toBe(true);
  });

  test("matches bundled disabled skills by plugin directory name", () => {
    const ctx = fixture();
    writeFileSync(join(ctx.pluginDir, "skills", "bundled-x", "SKILL.md"), "---\nname: different\ndescription: fixture\n---\nBody\n");
    writeFileSync(join(ctx.cwd, ".omo", "omo.jsonc"), JSON.stringify({ disabled_skills: ["bundled-x"] }));
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.some((row) => row.name === "skill:different")).toBe(false);
  });

  test("lists enabled plugin bundled skills and static extension commands", () => {
    const ctx = fixture();
    const rows = source.discover({ ...ctx, repoRoot: ctx.cwd, env: null, roots: { pluginDir: ctx.pluginDir } });
    expect(rows.find((row) => row.name === "skill:bundled-x")).toMatchObject({
      origin: "bundled",
      id: realpathSync(join(ctx.pluginDir, "skills", "bundled-x", "SKILL.md")),
    });
    expect(rows.some((row) => row.name === "tasks" && row.source === "builtin")).toBe(true);
  });

  test("declares terminal and dialog forms for OmO commands", () => {
    expect(source.forms?.tasks).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.dag).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.btw).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.model).toEqual([{ match: "bare", interaction: "dialog", dialog: "omo-model" }]);
    expect(source.terminalBound).toContain("sessions");
    // Senpi's share and trust selectors and the /import <path> confirmation wait for a key; bare /import only prints its usage
    for (const name of ["share", "trust"]) expect(source.terminalBound).toContain(name);
    expect(source.terminalBound).not.toContain("import");
    expect(source.forms?.import).toEqual([{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "terminal" }]);
    // a bare /rename or /name opens a text input; with a name it is stored
    for (const name of ["rename", "name"]) expect(source.forms?.[name]).toEqual([{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }]);
    for (const name of ["new", "clone", "compact", "export"]) expect(source.terminalBound).not.toContain(name);
  });

  test("compiles scanner metadata into terminal visibility and static provenance", () => {
    const ctx = fixture();
    const rows = paneCommands("omo", ctx.cwd, ctx.home, { pluginDir: ctx.pluginDir });
    expect(rows.find((row) => row.name === "tasks")).toMatchObject({
      visibility: "terminal",
      provenance: { transport: "static", verified: false },
      forms: [{ match: "bare", interaction: "terminal" }],
    });
  });
});

describe("OmO skill identity", () => {
  test("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const home = mkdtempSync(join(tmpdir(), "omo-identity-"));
    roots.push(home);
    const skills = join(home, ".omo", "agent", "skills");
    mkdirSync(join(skills, "aliased"), { recursive: true });
    writeFileSync(join(skills, "aliased", "SKILL.md"), "---\nname: aliased\ndescription: Aliased skill\n---\n");
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(skills, join(home, ".agents", "skills"), "dir");
    const rows = paneCommands("omo", null, home).filter(({ name }) => name === "skill:aliased");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", origin: "user", id: realpathSync(join(skills, "aliased", "SKILL.md")) });
  });
});
