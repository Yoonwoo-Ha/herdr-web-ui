import type { AgentStatus, PaneInfo } from "./herdr-api.generated.ts";

/**
 * When a pane is worth interrupting the user for, and what the interruption says.
 * Shared by the browser's tab notifications and the server's web push, so a device
 * with the app open and a phone with it closed fire on exactly the same events.
 */

/** Statuses worth interrupting the user for. `idle`/`working` are the busy baseline. */
export function shouldNotifyStatus(previous: AgentStatus | undefined, next: AgentStatus): boolean {
  if (previous === undefined) return false; // first sighting (app open, new pane): not news
  if (previous === next) return false;
  return next === "blocked" || next === "done";
}

/** The name a pane goes by in the sidebar and in every notification. */
export function paneTitle(pane: Pick<PaneInfo, "pane_id" | "cwd" | "terminal_title" | "terminal_title_stripped">): string {
  return pane.terminal_title_stripped ?? pane.terminal_title ?? pane.cwd ?? pane.pane_id;
}

const STATUS_BODY: Readonly<Record<string, string>> = {
  blocked: "waiting for your input",
  done: "work finished",
};

export function statusNotificationBody(status: AgentStatus): string {
  return STATUS_BODY[status] ?? String(status);
}

export const ENDED_NOTIFICATION_BODY = "terminal ended";

/** One notification slot per pane: a newer one replaces the older, whichever path showed it. */
export function paneNotificationTag(paneId: string, machineId = "local"): string {
  return machineId === "local" ? `herdr-pane-${paneId}` : `herdr-remote-${encodeURIComponent(machineId)}-${encodeURIComponent(paneId)}`;
}
