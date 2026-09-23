/** App updates are independent of the herdr daemon and its terminal sessions. */
export interface UpdateStatus {
  managed: boolean;
  auto_update: boolean;
  phase: "idle" | "checking" | "building" | "restarting" | "error";
  current_revision: string | null;
  latest_revision: string | null;
  available: boolean;
  checked_at: string | null;
  blocked_reason: string | null;
  error: string | null;
}

export type UpdateCommand = "check" | "install";

export function unmanagedUpdateStatus(): UpdateStatus {
  return {
    managed: false, auto_update: false, phase: "idle", current_revision: null,
    latest_revision: null, available: false, checked_at: null, error: null,
    blocked_reason: "Start with bun run start or the herdr plugin to enable updates.",
  };
}
