import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneCommands } from "./commands.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("paneCommands", () => {
  it("returns sorted built-ins for supported agents and none for unknown agents", () => {
    const claude = paneCommands("claude", null, temp("commands-home-"));
    expect(claude.some((command) => command.name === "clear" && command.source === "builtin")).toBeTrue();
    expect(claude.map((command) => command.name)).toEqual([...claude.map((command) => command.name)].sort());
    expect(paneCommands("unknown", "/tmp")).toEqual([]);
    expect(paneCommands(null, "/tmp")).toEqual([]);
  });

  it("loads user and nested project Claude commands with descriptions", () => {
    const home = temp("commands-home-");
    const cwd = temp("commands-project-");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".claude", "commands", "team"), { recursive: true });
    writeFileSync(join(home, ".claude", "commands", "deploy.md"), "---\ndescription: Deploy safely\n---\nignored body\n");
    writeFileSync(join(cwd, ".claude", "commands", "team", "review.md"), "\nReview this project thoroughly\nMore detail");

    const commands = paneCommands("claude", cwd, home);
    expect(commands).toContainEqual({ name: "deploy", description: "Deploy safely", source: "user" });
    expect(commands).toContainEqual({ name: "team:review", description: "Review this project thoroughly", source: "project" });
  });
});
