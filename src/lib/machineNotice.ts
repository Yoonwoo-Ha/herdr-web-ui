import type { Machine } from "../../shared/machines.ts";

const KEY = "herdr-web-ui:pc-notice-dismissed";

/** One dismissal covers one PC waiting for one thing: a PC that later waits for another shows again. */
export function noticeKey(machine: Pick<Machine, "id" | "action_required">): string {
  return `${machine.id}:${machine.action_required ?? ""}`;
}

/** The PCs the app-wide line still speaks for. */
export function waitingMachines(machines: Machine[], dismissed: readonly string[]): Machine[] {
  return machines.filter((machine) => machine.action_required && machine.action_required !== "connect" && !dismissed.includes(noticeKey(machine)));
}

/**
 * A dismissal ends when its PC connects: the next time that PC waits is news again. A failed
 * retry or bridge update keeps it, since the PC only goes back to waiting for the same thing.
 */
export function keepDismissed(dismissed: readonly string[], machines: Machine[]): string[] {
  const connected = machines.filter((machine) => machine.state === "connected").map((machine) => `${machine.id}:`);
  return dismissed.filter((key) => !connected.some((prefix) => key.startsWith(prefix)));
}

export function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

export function writeDismissed(dismissed: readonly string[]): void {
  try {
    if (dismissed.length) window.localStorage.setItem(KEY, JSON.stringify(dismissed));
    else window.localStorage.removeItem(KEY);
  } catch { /* storage blocked: the dismissal lasts until the page reloads */ }
}
