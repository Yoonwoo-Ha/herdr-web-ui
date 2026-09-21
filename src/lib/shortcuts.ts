import { useEffect } from "react";

import type { AppActions } from "./actions.ts";

export const SHORTCUTS = [
  { id: "palette", label: "Command palette", keys: ["Mod", "Shift", "K"] },
  { id: "toggle-view", label: "Switch chat / terminal", keys: ["Mod", "Shift", "J"] },
  { id: "toggle-sidebar", label: "Toggle sidebar", keys: ["Mod", "Shift", "B"] },
  { id: "new-session", label: "New session", keys: ["Mod", "Shift", "N"] },
  { id: "previous-pane", label: "Previous pane", keys: ["Mod", "Shift", "ArrowUp"] },
  { id: "next-pane", label: "Next pane", keys: ["Mod", "Shift", "ArrowDown"] },
  { id: "settings", label: "Settings", keys: ["Mod", "Shift", ","] },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const KEY_TO_ID: Readonly<Record<string, ShortcutId>> = {
  k: "palette",
  j: "toggle-view",
  b: "toggle-sidebar",
  n: "new-session",
  ArrowUp: "previous-pane",
  ArrowDown: "next-pane",
  ",": "settings",
};

export function matchShortcut(event: ShortcutEventLike, platformIsMac: boolean): ShortcutId | null {
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!hasMod || !event.shiftKey || event.altKey) return null;
  return KEY_TO_ID[event.key.length === 1 ? event.key.toLowerCase() : event.key] ?? null;
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function formatKeys(keys: readonly string[]): string[] {
  const mod = modKeyLabel();
  return keys.map((key) => (key === "Mod" ? mod : key));
}

export function useShortcuts(actions: AppActions, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const platformIsMac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = matchShortcut(event, platformIsMac);
      if (shortcut === null) return;
      event.preventDefault();
      switch (shortcut) {
        case "palette":
          actions.openPalette();
          break;
        case "toggle-view":
          actions.toggleView();
          break;
        case "toggle-sidebar":
          actions.toggleSidebar();
          break;
        case "new-session":
          actions.openNewSession();
          break;
        case "previous-pane":
          actions.selectAdjacentPane(-1);
          break;
        case "next-pane":
          actions.selectAdjacentPane(1);
          break;
        case "settings":
          actions.openSettings();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actions, enabled]);
}
