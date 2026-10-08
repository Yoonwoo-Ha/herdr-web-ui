/**
 * Anonymous install and update counts (server/telemetry.ts). On by default after a one-time
 * notice in the app; nothing is sent before that notice was shown (and a grace period after it,
 * server/telemetry.ts NOTICE_GRACE_MS), and nothing between an install and an update.
 *
 *  GET  /api/telemetry  -> TelemetryStatus, no-store
 *  POST /api/telemetry  { enabled?: boolean, notice_seen?: true } -> TelemetryStatus
 *       (same-origin, `x-herdr-update: 1`)
 *
 * A server that sends nothing (tests, a remote PC's bridge, an older server) answers 404 to
 * both, and the app shows neither the notice nor the switch.
 */

export type TelemetryEventName = "install" | "update";
export type InstallMethod = "plugin" | "managed" | "source";

/** One event, exactly as it is sent. The receiver keeps these fields and the day; no IP, no address. */
export interface TelemetryEvent {
  event: TelemetryEventName;
  /** random, made on this PC the first time; says nothing about the user */
  install_id: string;
  /** the running app's version, without the v */
  version: string;
  /** the version an update replaced; null for an install, or an update from before telemetry */
  previous_version: string | null;
  /** Node's `process.platform` and `process.arch` */
  os: string;
  arch: string;
  install_method: InstallMethod;
}

export interface TelemetryStatus {
  /** the switch in Settings */
  enabled: boolean;
  /** HERDR_WEB_TELEMETRY=0, DO_NOT_TRACK or a CI/test environment: nothing is sent whatever the switch says */
  blocked_by_env: boolean;
  /** the app has shown its notice once; no event goes out before that */
  notice_seen: boolean;
  /** what the next event would be, as it would be sent; null when there is nothing left to send for this version */
  next: TelemetryEvent | null;
}
