import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./agy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agy-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
function skill(path: string, fields = ""): void {
  put(join(path, "SKILL.md"), `---\ndescription: Probe skill. More detail.\n${fields}---\nProbe body\n`);
}

it("discovers each agy root with nearest-project precedence and no undocumented global root", () => {
  const home = temp(), repo = join(home, "repo"), cwd = join(repo, "sub");
  put(join(repo, ".git"), "gitdir: fixture");
  for (const prefix of [".agents", ".agent", "_agents", "_agent"]) skill(join(repo, prefix, "skills", prefix.slice(1)));
  skill(join(repo, ".agents", "skills", "collision"));
  skill(join(cwd, ".agents", "skills", "collision"));
  skill(join(home, ".gemini", "config", "skills", "personal"));
  skill(join(home, ".gemini", "config", "skills", "collision"));
  skill(join(home, ".gemini", "config", "plugins", "sample", "skills", "plugin-skill"));
  skill(join(home, ".gemini", "antigravity-cli", "builtin", "skills", "bundled-skill"));
  skill(join(home, ".gemini", "antigravity-cli", "skills", "wrong-global"));
  skill(join(home, ".agents", "skills", "outside-repo"));
  const commands = paneCommands("agy", cwd, home).filter(({ source }) => source === "skill");
  expect(commands.map(({ name, origin }) => [name, origin])).toEqual([
    ["agent", "project"], ["agents", "project"], ["collision", "project"],
    ["personal", "user"], ["plugin-skill", "plugin"],
  ]);
  expect(commands.find(({ name }) => name === "personal")).toMatchObject({
    id: join(home, ".gemini", "config", "skills", "personal", "SKILL.md"),
    provenance: { transport: "scan", verified: false },
  });
});

it("requires descriptions, skips disabled skills, and scans only one level by default", () => {
  const home = temp(), root = join(home, ".gemini", "config", "skills");
  skill(join(root, "enabled"), "name: renamed\n");
  skill(join(root, "disabled"), "disable-slash-command: true\n");
  skill(join(root, "group", "nested"));
  put(join(root, "missing", "SKILL.md"), "---\nname: missing\n---\nBody\n");
  put(join(root, "blank", "SKILL.md"), '---\ndescription: " "\n---\n');
  const commands = paneCommands("agy", null, home).filter(({ source }) => source === "skill");
  expect(commands.map(({ name }) => name)).toEqual(["renamed"]);
});

it("loads nested include_only registrations with path resolution and excludes", () => {
  const home = temp(), repo = join(home, "repo"), cwd = join(repo, "sub");
  put(join(repo, ".git"), "gitdir: fixture");
  mkdirSync(cwd, { recursive: true });
  skill(join(repo, "shared", "category", "nested"));
  skill(join(repo, "shared", "category", "excluded"));
  skill(join(home, "extra", "home-skill"));
  skill(join(home, "absolute", "absolute-skill"));
  put(join(repo, ".agents", "skills.json"), JSON.stringify({ entries: [
    { path: "shared", include_only: ["category/nested", "category/excluded"], exclude: ["category/excluded"] },
    { path: "~/extra" }, { path: join(home, "absolute") },
  ] }));
  const commands = paneCommands("agy", cwd, home).filter(({ source }) => source === "skill");
  expect(commands.map(({ name, origin }) => [name, origin])).toEqual([
    ["absolute-skill", "project"], ["home-skill", "project"], ["nested", "project"],
  ]);
});

it("offers only bundled skills loaded by the CLI", () => {
  const home = temp(), bundled = join(home, ".gemini", "antigravity-cli", "builtin", "skills");
  for (const name of ["agy-customizations", "plugin", "kept"]) skill(join(bundled, name));
  const commands = paneCommands("agy", null, home);
  expect(commands.filter(({ name }) => name === "agy-customizations").map(({ source }) => source)).toEqual(["builtin"]);
  expect(commands.filter(({ source }) => source === "skill").map(({ name }) => name)).toEqual([]);
});

it("retains the recorded palette and aliases", () => {
  const commands = paneCommands("agy", null, temp());
  expect(commands.map(({ name }) => name).sort()).toEqual([
    "add-dir", "agents", "agy-customizations", "antigravity-guide", "artifact", "boost", "branch", "browser",
    "btw", "changelog", "clear", "codesearch", "compact", "config", "context", "conversation", "copy",
    "credits", "cs", "diff", "effort", "exit", "fast", "feedback", "fork", "goal", "grill-me",
    "help", "hooks", "keybindings", "learn", "logout", "mcp", "model", "new", "open", "permissions",
    "plan", "planning", "plugin", "quit", "quota", "record", "remote-control", "rename", "resume",
    "rewind", "schedule", "search", "skills", "statusline", "switch", "tasks", "teamwork",
    "teamwork-preview", "title", "undo", "usage", "voice",
  ].sort());
  expect(commands.filter(({ name }) => ["usage", "credits", "changelog"].includes(name)).every(({ source }) => source === "builtin")).toBeTrue();
  expect(commands.every(({ source }) => source === "builtin")).toBeTrue();
});

it("lists only the bundled skills loaded by Antigravity CLI", () => {
  const home = temp(), bundled = join(home, ".gemini", "antigravity-cli", "builtin", "skills");
  for (const name of [
    "agy-customizations", "antigravity-guide", "automation", "browser", "browser-agent",
    "code-review", "creative-writing", "data-analysis", "design",
  ]) skill(join(bundled, name));
  for (const name of ["agy-customizations", "antigravity-guide"]) skill(join(home, ".gemini", "config", "skills", name));
  const commands = paneCommands("agy", null, home);
  expect(commands.filter(({ source }) => source === "builtin").map(({ name }) => name)).toEqual(expect.arrayContaining([
    "agy-customizations", "antigravity-guide",
  ]));
  expect(commands.filter(({ source, origin }) => source === "skill" && origin === "bundled").map(({ name }) => name)).toEqual([]);
});

it("offers every former exclusion as a terminal command", () => {
  const former = ["model", "resume", "config", "permissions", "agents", "hooks", "mcp", "plugin", "skills", "voice", "effort", "keybindings"];
  expect(source.builtins).toEqual(expect.arrayContaining([...former, "usage", "credits", "changelog"]));
  expect(source.terminalBound).toEqual(expect.arrayContaining([...former, "usage", "credits", "changelog"]));
  expect(source.forms?.usage).toEqual([{ match: "bare", interaction: "terminal" }]);
});

it("keeps the panels, pickers and forms that hold the screen in the terminal", () => {
  const held = ["artifact", "codesearch", "cs", "search", "context", "diff", "help", "tasks", "rewind", "undo", "feedback", "logout"];
  expect(source.terminalBound).toEqual(expect.arrayContaining(held));
  for (const name of held) expect(source.forms?.[name]).toEqual([{ match: "bare", interaction: "terminal" }]);
  // /open <file> opens the PC's editor; bare it only prints its usage
  expect(source.forms?.open).toEqual([{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "terminal" }]);
  for (const name of ["compact", "clear", "new", "fork", "title"]) expect(source.terminalBound).not.toContain(name);
});

it("isolated scan lists config as a terminal command", () => {
  const home = temp();
  const commands = paneCommands("agy", null, home);
  for (const name of ["model", "resume", "config", "permissions", "agents", "hooks", "mcp", "plugin", "skills", "voice", "effort", "keybindings"]) {
    expect(commands.find(({ name: commandName }) => commandName === name)).toMatchObject({
      visibility: "terminal",
      forms: [{ match: "bare", interaction: "terminal" }],
    });
  }
  expect(commands.find(({ name }) => name === "config")).toMatchObject({ name: "config", visibility: "terminal" });
  expect(commands.find(({ name }) => name === "usage")).toMatchObject({
    visibility: "terminal",
    forms: [{ match: "bare", interaction: "terminal" }],
  });
});

it("includes the current CLI commands and aliases", () => {
  const commands = paneCommands("agy", null, temp());
  expect(commands.map(({ name }) => name)).toEqual(expect.arrayContaining([
    "credits", "fast", "planning", "compact", "switch", "conversation", "teamwork", "record",
  ]));
});

it("gives aliases the canonical command visibility and forms", () => {
  const commands = paneCommands("agy", null, temp());
  for (const [alias, canonical] of [
    ["switch", "resume"],
    ["conversation", "resume"],
    ["record", "voice"],
    ["quota", "usage"],
  ]) {
    const aliasRow = commands.find(({ name }) => name === alias);
    const canonicalRow = commands.find(({ name }) => name === canonical);
    expect(aliasRow?.visibility).toBe(canonicalRow?.visibility);
    expect(aliasRow?.forms).toEqual(canonicalRow?.forms);
  }
});

it("describes record as microphone dictation into the prompt", () => {
  expect(source.descriptions?.record).toBe("Dictate a prompt using your microphone");
});

it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
  const home = temp(), config = join(home, ".gemini", "config");
  skill(join(config, "skills", "aliased"));
  mkdirSync(join(config, "plugins", "mirror"), { recursive: true });
  symlinkSync(join(config, "skills"), join(config, "plugins", "mirror", "skills"), "dir");
  const rows = paneCommands("agy", null, home).filter(({ name }) => name === "aliased");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ origin: "user", id: realpathSync(join(config, "skills", "aliased", "SKILL.md")) });
});
