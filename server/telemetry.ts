/**
 * Anonymous install and update counts (shared/telemetry.ts). One event when an install first
 * runs, one when it runs a new version; nothing in between. No event goes out before the app
 * has shown its notice once, while the switch is off, or where the environment says not to.
 * Only the real entrypoint (index.ts) makes one of these, so tests and a remote PC's bridge
 * send nothing.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallMethod, TelemetryEvent, TelemetryStatus } from "../shared/telemetry.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { updateRequestAllowed } from "./update-api.ts";

export const TELEMETRY_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/events";
const FILE = "telemetry.json";
const SEND_TIMEOUT_MS = 10_000;
/** after a start, long enough for the supervisor to have told what the update replaced */
const START_DELAY_MS = 15_000;
/** after the notice was shown, time to read it and press Turn off before the first event goes */
export const NOTICE_GRACE_MS = 10 * 60_000;

interface Saved {
  install_id: string;
  enabled: boolean;
  notice_seen_at: string | null;
  /** the version the last delivered event was for; null before the first one */
  reported_version: string | null;
}

type Env = Record<string, string | undefined>;

export function telemetryBlocked(env: Env): boolean {
  const own = env["HERDR_WEB_TELEMETRY"]?.trim().toLowerCase();
  if (own && ["0", "false", "off", "no"].includes(own)) return true;
  const dnt = env["DO_NOT_TRACK"]?.trim();
  if (dnt && dnt !== "0") return true;
  return Boolean(env["CI"] || env["HERDR_TEST_MODE"] || env["HERDR_TEST_SESSION"]);
}

export function installMethod(env: Env): InstallMethod {
  if (env["HERDR_PLUGIN_ROOT"]) return "plugin";
  return env["HERDR_WEB_MANAGED"] === "1" ? "managed" : "source";
}

function readSaved(file: string): Saved | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isJsonObject(value) || typeof value["install_id"] !== "string" || value["install_id"] === "") return null;
    return {
      install_id: value["install_id"],
      enabled: value["enabled"] !== false,
      notice_seen_at: typeof value["notice_seen_at"] === "string" ? value["notice_seen_at"] : null,
      reported_version: typeof value["reported_version"] === "string" ? value["reported_version"] : null,
    };
  } catch { return null; }
}

export class Telemetry {
  private saved: Saved;
  private sending: Promise<void> | null = null;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly file: string;
  /** false when the state file could not be written: then nothing is sent (it could not be remembered) */
  private writable = true;

  constructor(private readonly options: {
    stateDir: string;
    version: string;
    env: Env;
    fetch: typeof fetch;
    url?: string;
    platform?: string;
    arch?: string;
    /** the version the running release replaced, as the supervisor told it; null when none did */
    previousVersion?: () => string | null;
    /** tests move the clock; the notice's grace is measured with it */
    now?: () => number;
    noticeGraceMs?: number;
  }) {
    this.file = join(options.stateDir, FILE);
    const saved = readSaved(this.file);
    this.saved = saved ?? { install_id: randomUUID(), enabled: true, notice_seen_at: null, reported_version: null };
    if (!saved) {
      try { this.persist(); } catch (error) {
        // the app still starts; telemetry just stays silent
        this.writable = false;
        console.error(`telemetry: ${this.file} could not be written, so nothing will be sent (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** another server on the same state directory may have changed the switch: its file wins */
  private refresh(): void {
    const latest = readSaved(this.file);
    if (latest) this.saved = latest;
  }

  private persist(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(temp, this.file);
    this.writable = true;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.report(), ms);
    this.timer.unref?.();
  }

  private blocked(): boolean { return telemetryBlocked(this.options.env); }

  /** the event this version still owes, whether or not it may be sent now */
  private pending(): TelemetryEvent | null {
    const { version } = this.options;
    const reported = this.saved.reported_version;
    if (reported === version) return null;
    const replaced = reported ?? this.options.previousVersion?.() ?? null;
    const update = replaced !== null && replaced !== version;
    return {
      event: update ? "update" : "install",
      install_id: this.saved.install_id,
      version,
      previous_version: update ? replaced : null,
      os: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      install_method: installMethod(this.options.env),
    };
  }

  status(): TelemetryStatus {
    this.refresh();
    return {
      enabled: this.saved.enabled,
      blocked_by_env: this.blocked(),
      notice_seen: this.saved.notice_seen_at !== null,
      next: this.pending(),
    };
  }

  change(patch: { enabled?: boolean; notice_seen?: true }): TelemetryStatus {
    this.refresh();
    if (patch.enabled !== undefined) this.saved.enabled = patch.enabled;
    if (patch.notice_seen && this.saved.notice_seen_at === null) this.saved.notice_seen_at = new Date(this.now()).toISOString();
    this.persist();
    // turned off while an event is on its way: stop it rather than let it land
    if (patch.enabled === false) this.abort?.abort();
    void this.report();
    return this.status();
  }

  start(): void { this.schedule(START_DELAY_MS); }
  stop(): void { clearTimeout(this.timer); this.abort?.abort(); }

  /**
   * Sends the owed event once, no sooner than NOTICE_GRACE_MS after the notice was shown; a
   * failure is logged and tried again at the next start or change.
   */
  report(): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.writable) return Promise.resolve();
    this.refresh();
    const event = this.pending();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (!event || !this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    const wait = seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS) - this.now();
    if (wait > 0) { this.schedule(wait); return Promise.resolve(); }
    const abort = new AbortController();
    this.abort = abort;
    this.sending = (async () => {
      try {
        const response = await this.options.fetch(this.options.url ?? TELEMETRY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.refresh();
        this.saved.reported_version = event.version;
        this.persist();
      } catch (error) {
        if (!abort.signal.aborted) console.error(`telemetry: the ${event.event} event was not delivered (${error instanceof Error ? error.message : String(error)})`);
      } finally { this.sending = null; this.abort = undefined; }
    })();
    return this.sending;
  }
}

export async function handleTelemetryRequest(request: Request, telemetry?: Telemetry): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  if (!telemetry) return reply({ error: { code: "not_found", message: "This server sends no telemetry" } }, 404);
  if (request.method === "GET") return reply(telemetry.status());
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use GET or POST /api/telemetry" } }, 405);
  if (!updateRequestAllowed(request)) return reply({ error: { code: "invalid_telemetry_request", message: "Use the controls from this app." } }, 403);
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  if (!isJsonObject(body)) return badRequest("invalid_body", "Send an object");
  const { enabled, notice_seen } = body;
  if (enabled !== undefined && typeof enabled !== "boolean") return badRequest("invalid_body", "enabled is a boolean");
  if (notice_seen !== undefined && notice_seen !== true) return badRequest("invalid_body", "notice_seen can only be true");
  try { return reply(telemetry.change({ ...(enabled !== undefined ? { enabled } : {}), ...(notice_seen ? { notice_seen } : {}) })); }
  catch (error) { return errorResponse(error); }
}
