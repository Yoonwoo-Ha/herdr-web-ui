import type { AgentStatus } from "../../shared/protocol.ts";

/**
 * Web Notifications for pane status transitions. Guarded for this app's reality:
 * Notification exists only in secure contexts (https or localhost) - a plain-http
 * LAN deployment reports "unsupported" and the UI hides the bell entirely.
 *
 * Pure decision logic lives in shouldNotifyStatus so the transition policy is
 * unit-testable without a browser.
 */

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

export function notificationState(): NotificationState {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/** Statuses worth interrupting the user for. `idle`/`working` are the busy baseline. */
export function shouldNotifyStatus(previous: AgentStatus | undefined, next: AgentStatus): boolean {
  if (previous === undefined) return false; // first sighting (app open, new pane): not news
  if (previous === next) return false;
  return next === "blocked" || next === "done";
}

interface NotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly onClick?: () => void;
}

function show({ title, body, onClick }: NotificationOptions): void {
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return; // visible tab: the UI already shows it
  const notification = new globalThis.Notification(title, { body, tag: title });
  notification.addEventListener("click", () => {
    window.focus();
    onClick?.();
  });
}

const STATUS_BODY: Readonly<Record<string, string>> = {
  blocked: "waiting for your input",
  done: "work finished",
};

export function showPaneStatusNotification(paneTitle: string, status: AgentStatus, onClick?: () => void): void {
  const body = STATUS_BODY[status] ?? String(status);
  show({ title: paneTitle, body, onClick });
}

export function showPaneEndedNotification(paneTitle: string, onClick?: () => void): void {
  show({ title: paneTitle, body: "terminal ended", onClick });
}
