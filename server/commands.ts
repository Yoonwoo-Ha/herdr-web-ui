import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { SlashCommand } from "../shared/protocol.ts";

const BUILTINS: Record<string, readonly string[]> = {
  claude: ["clear", "compact", "config", "cost", "help", "init", "memory", "model", "permissions", "review", "status", "doctor", "login", "logout", "pr-comments", "release-notes", "terminal-setup", "vim"],
  omp: ["help", "clear", "compact", "model", "new", "sessions", "exit"],
  codex: ["clear", "compact", "diff", "help", "model", "new", "quit", "review", "status"],
};

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
};

function description(markdown: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (frontmatter) {
    const found = frontmatter[1]?.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (found) return found.replace(/^(["'])(.*)\1$/, "$2").slice(0, 120);
  }
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return (body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "").slice(0, 120);
}

function customCommands(root: string, source: "user" | "project"): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
        result.push({ name: relativeName, description: description(readFileSync(path, "utf8")), source });
      }
    }
  };
  visit(root);
  return result;
}

export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = process.env.HOME ?? ""): SlashCommand[] {
  if (!agent || !(agent in BUILTINS)) return [];
  const commands: SlashCommand[] = (BUILTINS[agent] ?? []).map((name) => ({ name, description: DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin" }));
  if (agent === "claude") {
    commands.push(...customCommands(join(home, ".claude", "commands"), "user"));
    if (cwd) commands.push(...customCommands(join(cwd, ".claude", "commands"), "project"));
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}
