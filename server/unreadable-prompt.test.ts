import { describe, expect, test } from "bun:test";

import { parseUnreadablePrompt } from "./unreadable-prompt.ts";

const ids = (screen: string, blocked: boolean) => parseUnreadablePrompt(screen, blocked)?.actions.map((action) => action.id) ?? null;

describe("a dialog no parser reads", () => {
  const menu = [
    "● Some earlier answer the agent gave.",
    "",
    "Pick a deployment target",
    "",
    "❯ 1. Staging",
    "  2. Production",
    "  3. Skip for now",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  test("a numbered menu above a select/cancel footer: each option is its number", () => {
    const parsed = parseUnreadablePrompt(menu, true)!;
    expect(parsed.actions.slice(0, 3)).toEqual([
      { id: "option-1", label: "1. Staging", text: "1" },
      { id: "option-2", label: "2. Production", text: "2" },
      { id: "option-3", label: "3. Skip for now", text: "3" },
    ]);
    expect(parsed.actions.slice(3).map((action) => action.id)).toEqual(["enter", "esc", "up", "down"]);
    // the menu with its question, not the answer far above it
    expect(parsed.lines).toEqual(["Pick a deployment target", "❯ 1. Staging", "  2. Production", "  3. Skip for now", "Enter to select · ↑/↓ to navigate · Esc to cancel"]);
  });

  test("the same dialog keeps its id; another one gets a new id", () => {
    expect(parseUnreadablePrompt(menu, true)!.id).toBe(parseUnreadablePrompt(menu, true)!.id);
    expect(parseUnreadablePrompt(menu.replace("Staging", "Preview"), true)!.id).not.toBe(parseUnreadablePrompt(menu, true)!.id);
  });

  test("nothing unless herdr reports the pane blocked: an answered menu stays on screen as text", () => {
    expect(parseUnreadablePrompt(menu, false)).toBeNull();
  });

  test("options count only from 1 on, in order, with the nearest menu winning", () => {
    expect(ids("  2. Two\n  3. Three\nEsc to cancel", true)).toEqual(["esc"]);
    const older = ["1. Old one", "2. Old two", "later text", "1. New one", "2. New two", "Esc to cancel"].join("\n");
    expect(parseUnreadablePrompt(older, true)!.actions.slice(0, 2).map((action) => action.label)).toEqual(["1. New one", "2. New two"]);
  });

  test("the keys the last rows name", () => {
    const screen = "Installing the update needs a restart.\nPress Enter to continue, Ctrl+C to quit";
    expect(ids(screen, false)).toBeNull();
    expect(ids(screen, true)).toEqual(["enter", "ctrl-c"]);
    expect(ids("Overwrite notes.txt? (y/N)", true)).toEqual(["y", "n"]);
    expect(ids("Use ←/→ to pick a tab, Space to toggle", true)).toEqual(["left", "right", "space"]);
  });

  test("nothing for a screen that names no key, nor for Claude's own mode switch", () => {
    expect(ids("thinking about it…", true)).toBeNull();
    expect(ids("❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)", true)).toBeNull();
    expect(ids("", true)).toBeNull();
  });

  test("long rows are cut and rules are left out", () => {
    const parsed = parseUnreadablePrompt(`${"x".repeat(300)}\n${"─".repeat(40)}\nPress Enter`, true)!;
    expect(parsed.lines).toEqual([`${"x".repeat(200)}…`, "Press Enter"]);
  });
});
