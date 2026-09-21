import { describe, expect, it } from "bun:test";

import { matchShortcut, type ShortcutEventLike } from "./shortcuts.ts";

function keyEvent(key: string, patch: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, ...patch };
}

describe("matchShortcut", () => {
  it("uses Command on Apple platforms and Control elsewhere", () => {
    expect(matchShortcut(keyEvent("K", { metaKey: true }), true)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), false)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(keyEvent("k", { metaKey: true }), false)).toBeNull();
  });

  it("matches every terminal-safe key", () => {
    expect(matchShortcut(keyEvent("j", { ctrlKey: true }), false)).toBe("toggle-view");
    expect(matchShortcut(keyEvent("B", { ctrlKey: true }), false)).toBe("toggle-sidebar");
    expect(matchShortcut(keyEvent("n", { ctrlKey: true }), false)).toBe("new-session");
    expect(matchShortcut(keyEvent("ArrowUp", { ctrlKey: true }), false)).toBe("previous-pane");
    expect(matchShortcut(keyEvent("ArrowDown", { ctrlKey: true }), false)).toBe("next-pane");
    expect(matchShortcut(keyEvent(",", { ctrlKey: true }), false)).toBe("settings");
  });

  it("requires Shift and rejects extra or competing modifiers", () => {
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("x", { ctrlKey: true }), false)).toBeNull();
  });
});
