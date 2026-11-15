/**
 * The notice about the anonymous usage counts (shared/telemetry.ts), kept apart from that file: the
 * telemetry Worker bundles shared/telemetry.ts and the release guard fingerprints it, and the Worker
 * never reads the notice, so changing the notice needs no new deploy.
 */

/**
 * The notice's wording as a number: an install that saw an older one sees the notice again, and
 * sends nothing until it has (3: events now carry an allowlisted settings snapshot; 4: a daily
 * active message with the harness kinds; 5: that message also counts the day's usage, TelemetryUsage).
 */
export const NOTICE_VERSION = 5;
