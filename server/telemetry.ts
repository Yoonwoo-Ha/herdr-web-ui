import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACTIVE_LATE_DAYS, countBucket, COUNTS_LATE_DAYS, emptyUsage, harnessOf, sameUsage, TELEMETRY_COUNT_MAX, TELEMETRY_COUNTERS, TELEMETRY_SHOWN, telemetryCountsChange, telemetryHarnesses, telemetrySettings, telemetrySurface, telemetryUsage, type InstallMethod, type TelemetryActive, type TelemetryBucket, type TelemetryChange, type TelemetryCounter, type TelemetryCounts, type TelemetryCountsChange, type TelemetryEvent, type TelemetryHarness, type TelemetryIngress, type TelemetryRuntime, type TelemetrySettings, type TelemetryShown, type TelemetryStatus, type TelemetrySurface, type TelemetryUsage, type TelemetryUsageCount, type TelemetryWidthCounts } from "../shared/telemetry.ts";
import { COUNTS_ON, NOTICE_VERSION } from "../shared/telemetry-notice.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { FileBusyError } from "./file-pool.ts";
import { updateRequestAllowed } from "./update-api.ts";

export const TELEMETRY_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/events";
export const ACTIVE_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/active";
export const COUNTS_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/counts";
const FILE = "telemetry.json";
const OFF_FILE = "telemetry-off";
const LOCK_FILE = "telemetry.lock";
/** how long a server waits for another's lock before it skips its write (an off never waits: it goes without the lock) */
const LOCK_WAIT_MS = 200;
const LOCK_STALE_MS = 5_000;
const LOCK_MAX_HOLD_MS = 5 * 60_000;
const heldLocks = new Set<string>();

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function staleLock(file: string): boolean {
  try {
    const [pid = NaN] = readFileSync(file, "utf8").split(" ").map(Number);
    const age = Date.now() - statSync(file).mtimeMs;
    if (age > LOCK_MAX_HOLD_MS) return true;
    if (!Number.isSafeInteger(pid) || pid <= 0) return age > LOCK_STALE_MS;
    if (pid === process.pid) return !heldLocks.has(file);
    try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    try { return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS; } catch { return false; }
  }
}
const SEND_TIMEOUT_MS = 10_000;
const START_DELAY_MS = 15_000;
export const NOTICE_GRACE_MS = 10 * 60_000;
const SETTINGS_NOTICE_VERSION = 3;
const VISITS_NOTICE_VERSION = 4;
export const COUNTS_SETTLE_MS = 5 * 60_000;
const TELEMETRY_CHANGE_KEYS = new Set(["enabled", "notice_seen", "notice_version", "settings", "alert_opened", "counts", "generation"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const USAGE_RESEND_MS = 60 * 60_000;
/** a change is a few small fields and at most one settings snapshot, which the receiver takes only under 8 KiB with the rest of its event */
const MAX_CHANGE_BYTES = 16 * 1024;

interface ActiveDay {
  day: string;
  harnesses: TelemetryHarness[];
  sent: TelemetryHarness[] | null;
  visited: boolean;
  usage: TelemetryUsage;
  sent_usage: TelemetryUsage | null;
  wire_usage: TelemetryUsage | null;
  sent_at: number | null;
}

function withKind<T extends string>(list: readonly T[], item: T | null | undefined): T[] {
  return item ? [...new Set([...list, item])].sort() : [...list];
}

interface Timer { clear(): void }

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

function sameHarnesses(a: readonly TelemetryHarness[], b: readonly TelemetryHarness[]): boolean {
  return a.length === b.length && a.every((harness, index) => harness === b[index]);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function readActive(value: unknown): ActiveDay[] {
  if (!Array.isArray(value)) return [];
  const days: ActiveDay[] = [];
  for (const item of value) {
    if (!isJsonObject(item) || typeof item["day"] !== "string" || !DAY.test(item["day"])) continue;
    const harnesses = telemetryHarnesses(item["harnesses"]);
    const sent = item["sent"] === null ? null : telemetryHarnesses(item["sent"]);
    if (!harnesses || (item["sent"] !== null && !sent)) continue;
    if (days.some((known) => known.day === item["day"])) continue;
    const usage = telemetryUsage(item["usage"]) ?? emptyUsage();
    const sentUsage = item["sent_usage"] === undefined ? (sent === null ? null : usage) : telemetryUsage(item["sent_usage"]);
    const wireUsage = item["wire_usage"] === undefined ? sentUsage : telemetryUsage(item["wire_usage"]);
    const sentAt = typeof item["sent_at"] === "number" && Number.isFinite(item["sent_at"]) ? item["sent_at"] : null;
    days.push({ day: item["day"], harnesses, sent, visited: item["visited"] !== false, usage, sent_usage: sentUsage, wire_usage: wireUsage, sent_at: sentAt });
  }
  return days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function withoutUsage(days: ActiveDay[]): ActiveDay[] {
  return days.filter((entry) => entry.visited).map((entry) => ({ ...entry, usage: emptyUsage(), sent_usage: entry.sent_usage === null ? null : emptyUsage(), wire_usage: entry.wire_usage === null ? null : emptyUsage() }));
}

interface WidthTally {
  counts: Partial<Record<TelemetryCounter, number>>;
  shown: TelemetryShown[];
}

interface CountDay {
  day: string;
  version: string;
  narrow: WidthTally | null;
  wide: WidthTally | null;
}

function readTally(value: unknown): WidthTally | null {
  if (!isJsonObject(value) || !isJsonObject(value["counts"]) || !Array.isArray(value["shown"])) return null;
  const counts: Partial<Record<TelemetryCounter, number>> = {};
  for (const [name, count] of Object.entries(value["counts"])) {
    if ((TELEMETRY_COUNTERS as readonly string[]).includes(name) && typeof count === "number" && Number.isInteger(count) && count >= 1) counts[name as TelemetryCounter] = Math.min(count, TELEMETRY_COUNT_MAX);
  }
  const shown = [...new Set(value["shown"].filter((name): name is TelemetryShown => typeof name === "string" && (TELEMETRY_SHOWN as readonly string[]).includes(name)))].sort();
  return { counts, shown };
}

function readCountDays(value: unknown): CountDay[] {
  if (!Array.isArray(value)) return [];
  const days: CountDay[] = [];
  for (const item of value) {
    if (!isJsonObject(item) || typeof item["day"] !== "string" || !DAY.test(item["day"]) || typeof item["version"] !== "string") continue;
    if (days.some((known) => known.day === item["day"])) continue;
    const narrow = item["narrow"] === null ? null : readTally(item["narrow"]);
    const wide = item["wide"] === null ? null : readTally(item["wide"]);
    if (narrow === null && wide === null) continue;
    days.push({ day: item["day"], version: item["version"], narrow, wide });
  }
  return days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function widthCounts(tally: WidthTally | null): TelemetryWidthCounts | null {
  if (tally === null) return null;
  const counts: Partial<Record<TelemetryCounter, TelemetryBucket>> = {};
  for (const name of (Object.keys(tally.counts) as TelemetryCounter[]).sort()) {
    const bucket = countBucket(tally.counts[name] ?? 0);
    if (bucket !== 0) counts[name] = bucket;
  }
  return { counts, shown: [...tally.shown] };
}

interface Saved {
  install_id: string;
  enabled: boolean;
  notice_seen_at: string | null;
  notice_version: number;
  reported_version: string | null;
  replaced_forgotten: boolean;
  forgotten: number;
  visits_after_notice: true;
  settings: TelemetrySettings | null;
  active: ActiveDay[];
  usage_after_notice: true;
  counts: CountDay[];
}

type Env = Record<string, string | undefined>;

export function telemetryBlocked(env: Env): boolean {
  const own = env["OVIS_TELEMETRY"]?.trim().toLowerCase();
  if (own && ["0", "false", "off", "no"].includes(own)) return true;
  const dnt = env["DO_NOT_TRACK"]?.trim();
  if (dnt && dnt !== "0") return true;
  return Boolean(env["CI"] || env["HERDR_TEST_MODE"] || env["HERDR_TEST_SESSION"]);
}

/**
 * What a visit's `/ws?surface=` gives the day's usage: a known kind of screen; null when the page named none (a page
 * from before surfaces: the visit still counts its way in); or false for any other value, whose connection then counts
 * no usage at all, neither a screen nor its way in. The connection itself is never refused for it.
 */
export function visitSurface(asked: string | null): TelemetrySurface | null | false {
  return asked === null ? null : telemetrySurface(asked) ?? false;
}

export function installMethod(env: Env): InstallMethod {
  if (env["HERDR_PLUGIN_ROOT"]) return "plugin";
  return env["OVIS_MANAGED"] === "1" ? "managed" : "source";
}

function telemetryChange(value: unknown): TelemetryChange | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !TELEMETRY_CHANGE_KEYS.has(key))) return null;

    const clean: TelemetryChange = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      switch (key) {
        case "enabled":
          if (typeof descriptor.value !== "boolean") return null;
          clean.enabled = descriptor.value;
          break;
        case "notice_seen":
          if (descriptor.value !== true) return null;
          clean.notice_seen = true;
          break;
        case "notice_version":
          if (descriptor.value !== NOTICE_VERSION) return null;
          clean.notice_version = NOTICE_VERSION;
          break;
        case "settings": {
          const settings = telemetrySettings(descriptor.value);
          if (!settings) return null;
          clean.settings = settings;
          break;
        }
        case "alert_opened":
          if (descriptor.value !== true) return null;
          clean.alert_opened = true;
          break;
        case "generation":
          if (typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return null;
          clean.generation = descriptor.value;
          break;
        case "counts": {
          const counts = telemetryCountsChange(descriptor.value);
          if (!counts) return null;
          clean.counts = counts;
          break;
        }
      }
    }
    if (clean.notice_seen === true && clean.notice_version !== NOTICE_VERSION) return null;
    return clean;
  } catch {
    return null;
  }
}

function offMarked(offFile: string): boolean {
  try {
    lstatSync(offFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  try {
    accessSync(dirname(offFile), constants.R_OK | constants.X_OK);
    return false;
  } catch { return true; }
}

function keptDiffers(file: string, saved: Saved): boolean {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (value["visits_after_notice"] !== true) return true;
    return JSON.stringify([value["active"] ?? [], value["counts"] ?? [], value["settings"] ?? null]) !== JSON.stringify([saved.active, saved.counts, saved.settings]);
  } catch { return false; }
}

function readSaved(file: string, offFile: string): Saved | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isJsonObject(value) || typeof value["install_id"] !== "string" || value["install_id"] === "") return null;
    // a switch an older build turned off is copied into OFF_FILE whenever it is read, so no late write of FILE can turn it
    // on; a read that cannot write it now still reads off, and the next read tries again
    if (value["enabled"] === false && !offMarked(offFile)) {
      try { writeFileSync(offFile, "", { mode: 0o600 }); } catch {}
    }
    const noticeSeenAt = value["notice_version"] === NOTICE_VERSION && typeof value["notice_seen_at"] === "string" ? value["notice_seen_at"] : null;
    const seenVersion = typeof value["notice_seen_at"] === "string" && typeof value["notice_version"] === "number" ? value["notice_version"] : 0;
    const active = seenVersion < VISITS_NOTICE_VERSION ? [] : value["visits_after_notice"] === true ? readActive(value["active"]) : readActive(value["active"]).flatMap((entry) => entry.sent === null ? [] : [{ ...entry, harnesses: [...entry.sent], usage: entry.sent_usage ?? emptyUsage(), sent_usage: entry.sent_usage ?? emptyUsage(), wire_usage: entry.sent_usage ?? emptyUsage() }]);
    const on = value["enabled"] !== false && !offMarked(offFile);
    return {
      install_id: value["install_id"],
      enabled: on,
      notice_seen_at: noticeSeenAt,
      notice_version: NOTICE_VERSION,
      reported_version: typeof value["reported_version"] === "string" ? value["reported_version"] : null,
      replaced_forgotten: value["replaced_forgotten"] === true,
      forgotten: typeof value["forgotten"] === "number" && Number.isSafeInteger(value["forgotten"]) && value["forgotten"] >= 0 ? value["forgotten"] : 0,
      visits_after_notice: true,
      settings: on && seenVersion >= SETTINGS_NOTICE_VERSION && value["visits_after_notice"] === true ? telemetrySettings(value["settings"]) : null,
      active: !on ? [] : noticeSeenAt !== null && value["usage_after_notice"] === true ? active : withoutUsage(active),
      usage_after_notice: true,
      counts: noticeSeenAt === null || !on ? [] : readCountDays(value["counts"]),
    };
  } catch { return null; }
}

export class Telemetry {
  private saved: Saved;
  private sending: Promise<void> | null = null;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private activeSending: Promise<void> | null = null;
  private activeAgain = false;
  private activeAgainVisit = false;
  private activeAbort?: AbortController;
  private activeTimer?: Timer;
  private countsSending: Promise<void> | null = null;
  private readonly countsDelivered = new Set<string>();
  private countsAbort?: AbortController;
  private lockDepth = 0;
  private lockStamp: string | null = null;
  private countsTimer?: Timer;
  private readonly file: string;
  private readonly offFile: string;
  private writable = true;

  constructor(private readonly options: {
    stateDir: string;
    version: string;
    env: Env;
    fetch: typeof fetch;
    url?: string;
    activeUrl?: string;
    countsUrl?: string;
    countsOn?: boolean;
    platform?: string;
    arch?: string;
    previousVersion?: () => string | null;
    runtime?: TelemetryRuntime;
    now?: () => number;
    noticeGraceMs?: number;
    setTimer?: (fn: () => void, ms: number) => Timer;
  }) {
    this.file = join(options.stateDir, FILE);
    this.offFile = join(options.stateDir, OFF_FILE);
    try { mkdirSync(options.stateDir, { recursive: true, mode: 0o700 }); } catch {}
    const saved = readSaved(this.file, this.offFile);
    this.saved = saved ?? { install_id: randomUUID(), enabled: !offMarked(this.offFile), notice_seen_at: null, notice_version: NOTICE_VERSION, reported_version: null, replaced_forgotten: true, forgotten: 0, visits_after_notice: true, settings: null, active: [], usage_after_notice: true, counts: [] };
    if (saved) {
      this.locked(() => {
        this.refresh();
        if (!keptDiffers(this.file, this.saved)) return;
        try { this.persist(); } catch (error) {
          console.error(`telemetry: ${this.file} could not be written (${error instanceof Error ? error.message : String(error)})`);
        }
      }, () => this.skipped("the start's cleaned state"));
    } else {
      this.locked(() => {
        const made = readSaved(this.file, this.offFile);
        if (made) { this.saved = made; return; }
        try { this.persist(); } catch (error) {
          this.writable = false;
          console.error(`telemetry: ${this.file} could not be written, so nothing will be sent (${error instanceof Error ? error.message : String(error)})`);
        }
      }, () => { this.skipped("a new state"); this.refresh(); });
    }
    if (this.blocked() && this.writable) {
      const purge = () => {
        this.refresh();
        this.forgetUnsent();
        try { this.persist(); } catch (error) {
          console.error(`telemetry: ${this.file} could not be written, so it is removed (${error instanceof Error ? error.message : String(error)})`);
          try { rmSync(this.file, { force: true }); } catch (removal) {
            console.error(`telemetry: ${this.file} could not be removed either (${removal instanceof Error ? removal.message : String(removal)})`);
          }
        }
      };
      this.locked(purge, purge);
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private refresh(): void {
    const latest = readSaved(this.file, this.offFile);
    if (latest) this.saved = latest;
    else if (offMarked(this.offFile)) this.saved.enabled = false;
  }

  private markOff(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.offFile, "", { mode: 0o600 });
  }

  private persist(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    // an off another server wrote since this one read the file: what this one holds is from before it, so it is not
    // written back, and the counter is never lowered
    const onDisk = readSaved(this.file, this.offFile);
    if (onDisk && onDisk.forgotten > this.saved.forgotten) {
      this.saved.forgotten = onDisk.forgotten;
      this.saved.active = [];
      this.saved.counts = [];
      this.saved.settings = null;
      this.saved.replaced_forgotten = true;
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    if (this.lockStamp !== null) {
      let still = false;
      try { still = readFileSync(join(this.options.stateDir, LOCK_FILE), "utf8") === this.lockStamp; } catch {}
      if (!still) {
        rmSync(temp, { force: true });
        console.error(`telemetry: ${this.file} was not written: this server's lock was taken over while it held it`);
        return;
      }
    }
    renameSync(temp, this.file);
    this.writable = true;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.report(); void this.flushCounts(); }, ms);
    this.timer.unref?.();
  }

  private blocked(): boolean { return telemetryBlocked(this.options.env); }

  private prune(): boolean {
    const today = new Date(this.now());
    const cutoff = utcDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - ACTIVE_LATE_DAYS));
    const kept = this.saved.active.filter((entry) => entry.day >= cutoff);
    const countsCutoff = utcDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - COUNTS_LATE_DAYS));
    const counts = this.saved.counts.filter((entry) => entry.day >= countsCutoff);
    if (kept.length === this.saved.active.length && counts.length === this.saved.counts.length) return false;
    this.saved.active = kept;
    this.saved.counts = counts;
    return true;
  }

  private countsMessage(day: string): TelemetryCounts {
    const entry = this.saved.counts.find((known) => known.day === day);
    return { event: "counts", day, install_id: this.saved.install_id, version: entry?.version ?? this.options.version, narrow: widthCounts(entry?.narrow ?? null), wide: widthCounts(entry?.wide ?? null) };
  }

  private activeMessage(entry?: { day: string; harnesses: TelemetryHarness[]; usage: TelemetryUsage }): TelemetryActive {
    return {
      event: "active",
      day: entry?.day ?? utcDay(this.now()),
      install_id: this.saved.install_id,
      version: this.options.version,
      os: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      install_method: installMethod(this.options.env),
      harnesses: [...(entry?.harnesses ?? [])],
      usage: entry ? { ...entry.usage, surfaces: [...entry.usage.surfaces], ingress: [...entry.usage.ingress] } : emptyUsage(),
      runtime: this.options.runtime ?? "herdr",
    };
  }

  private pending(): TelemetryEvent | null {
    const { version } = this.options;
    const reported = this.saved.reported_version;
    if (reported === version) return null;
    const known = reported ?? this.options.previousVersion?.() ?? null;
    const update = known !== null && known !== version;
    const replaced = this.saved.replaced_forgotten ? null : known;
    return {
      event: update ? "update" : "install",
      install_id: this.saved.install_id,
      version,
      previous_version: update ? replaced : null,
      os: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      install_method: installMethod(this.options.env),
      settings: this.saved.settings === null ? null : telemetrySettings(this.saved.settings),
      runtime: this.options.runtime ?? "herdr",
    };
  }

  status(): TelemetryStatus {
    this.refresh();
    return {
      enabled: this.saved.enabled,
      blocked_by_env: this.blocked(),
      notice_seen: this.saved.notice_seen_at !== null,
      next: this.pending(),
      active: this.activeMessage(this.saved.active.find((entry) => entry.day === utcDay(this.now()))),
      ...(this.countsOn() ? { counts: this.countsMessage(utcDay(this.now())), counts_generation: this.saved.forgotten } : {}),
    };
  }

  change(patch: TelemetryChange): TelemetryStatus {
    const clean = telemetryChange(patch);
    if (!clean) throw new TypeError("Invalid telemetry change");
    if (clean.enabled === false) {
      this.abort?.abort(); this.activeAbort?.abort(); this.countsAbort?.abort();
      this.markOff();
    }
    const markOf = (): number | null => { try { return statSync(this.offFile).mtimeMs; } catch { return null; } };
    const apply = () => this.locked((): "applied" | "superseded" => {
      const markAtStart = markOf();
      this.refresh();
      const heard = this.saved.forgotten;
      if (clean.enabled === false) this.markOff();
      if (clean.enabled === false || (clean.enabled === true && !this.saved.enabled)) this.forgetUnsent();
      if (clean.enabled !== undefined) this.saved.enabled = clean.enabled;
      if (clean.enabled === true && this.saved.reported_version === this.options.version) this.saved.replaced_forgotten = false;
      if (clean.notice_seen && this.saved.notice_seen_at === null) this.saved.notice_seen_at = new Date(this.now()).toISOString();
      if (clean.settings !== undefined && clean.generation === heard && this.saved.notice_seen_at !== null && this.saved.enabled && !this.blocked()) this.saved.settings = clean.settings;
      if (clean.enabled !== false && markOf() !== markAtStart) return "superseded";
      this.persist();
      if (clean.enabled === false) this.markOff();
      if (clean.enabled === true && markOf() === markAtStart) rmSync(this.offFile, { force: true });
      return "applied";
    }, (): "applied" | "superseded" | "busy" => {
      if (clean.enabled !== false) return "busy";
      this.markOff();
      this.refresh();
      this.forgetUnsent();
      this.saved.enabled = false;
      try { this.persist(); } catch (error) { console.error(`telemetry: ${this.file} could not be written (${message(error)})`); }
      this.markOff();
      return "applied";
    });
    let applied = apply();
    if (applied === "busy") applied = apply();
    if (applied === "busy") throw new FileBusyError("Another Ovis server on this PC is changing the usage counts; try again");
    if (applied === "superseded") return this.status();
    if (clean.alert_opened) {
      this.tally("alerts_opened");
      if (Object.keys(clean).length === 1) return this.status();
    }
    if (clean.counts) {
      this.tallyCounts(clean.counts);
      if (Object.keys(clean).length === 1) return this.status();
    }
    void this.report();
    void this.flushActive();
    void this.flushCounts();
    return this.status();
  }

  private forgetUnsent(): void {
    this.saved.active = [];
    this.saved.counts = [];
    this.saved.settings = null;
    this.saved.replaced_forgotten = true;
    this.saved.forgotten += 1;
  }

  /** Whether a browser visit is recorded at all: never while the switch is off or the environment forbids sending. */
  counting(): boolean {
    if (!this.writable) return false;
    this.refresh();
    return this.saved.enabled && !this.blocked();
  }

  private countingUsage(): boolean {
    return this.counting() && this.saved.notice_seen_at !== null;
  }

  /**
   * Counts one prompt answer, alert delivered or alert tapped in today's usage; never while usage
   * is not counted. It sends nothing by itself: the day's next visit (or a later day's) carries it.
   */
  tally(kind: TelemetryUsageCount): void {    this.locked(() => {
      if (!this.countingUsage()) return;
      const day = utcDay(this.now());
      this.prune();
      if (!this.saved.active.some((entry) => entry.day === day)) {
        this.saved.active = readActive([...this.saved.active, { day, harnesses: [], sent: null, visited: false, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null }]);
      }
      const entry = this.saved.active.find((known) => known.day === day);
      if (!entry || entry.usage[kind] >= TELEMETRY_COUNT_MAX) return;
      entry.usage = { ...entry.usage, [kind]: entry.usage[kind] + 1 };
      try { this.persist(); } catch (error) {
        console.error(`telemetry: the ${kind} count could not be recorded (${message(error)})`);
      }
    }, () => this.skipped(`the ${kind} count`));
  }

  /**
   * Adds what a browser used in one width to today's counts (each to TELEMETRY_COUNT_MAX) under the running
   * version; never while usage is not counted (off, blocked, or the current notice not shown), so nothing
   * pressed before the notice is kept. It sends nothing by itself.
   */
  tallyCounts(change: TelemetryCountsChange): void {    this.locked(() => {
      if (!this.countsOn() || !this.countingUsage()) return;
      if (change.generation !== this.saved.forgotten) return;
      const today = utcDay(this.now());
      const yesterday = utcDay(this.now() - 86_400_000);
      const day = change.day ?? today;
      if (day !== today && day !== yesterday) return;
      this.prune();
      let entry = this.saved.counts.find((known) => known.day === day);
      if (!entry) {
        entry = { day, version: this.options.version, narrow: null, wide: null };
        this.saved.counts = [...this.saved.counts, entry].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      }
      entry.version = this.options.version;
      const tally = entry[change.width] ?? { counts: {}, shown: [] };
      for (const [name, add] of Object.entries(change.add) as [TelemetryCounter, number][]) {
        tally.counts[name] = Math.min((tally.counts[name] ?? 0) + add, TELEMETRY_COUNT_MAX);
      }
      tally.shown = [...new Set([...tally.shown, ...change.shown])].sort();
      entry[change.width] = tally;
      try { this.persist(); } catch (error) {
        console.error(`telemetry: the counts could not be recorded (${message(error)})`);
      }
      if (day !== today) this.settleLater();
    }, () => this.skipped("a browser's counts"));
  }

  private countsOn(): boolean { return this.options.countsOn ?? COUNTS_ON; }

  takesCounts(): boolean { return this.countsOn(); }

  private flushCounts(): Promise<void> {
    if (!this.countsOn()) return Promise.resolve();
    if (this.countsSending) return this.countsSending;
    if (!this.writable) return Promise.resolve();
    this.refresh();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (!this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    if (this.now() < seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS)) return Promise.resolve();
    const pruned = this.locked(() => {
      this.refresh();
      if (this.prune()) {
        try { this.persist(); } catch (error) {
          console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
          return false;
        }
      }
      return true;
    }, () => { this.skipped("the counts to send"); return false; });
    if (!pruned) return Promise.resolve();
    const settled = utcDay(this.now() - COUNTS_SETTLE_MS);
    const due = this.saved.counts.filter((entry) => entry.day < settled && !this.countsDelivered.has(entry.day)).map((entry) => this.countsMessage(entry.day));
    this.settleLater();
    if (due.length === 0) return Promise.resolve();
    const generation = this.saved.forgotten;
    const abort = new AbortController();
    this.countsAbort = abort;
    this.countsSending = (async () => {
      try {
        for (const counts of due) {
          if (abort.signal.aborted || offMarked(this.offFile)) return;
          this.refresh();
          if (!this.saved.enabled || this.saved.forgotten !== generation || !this.saved.counts.some((entry) => entry.day === counts.day)) return;
          try {
            const response = await this.options.fetch(this.options.countsUrl ?? COUNTS_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(counts),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          } catch (error) {
            if (!abort.signal.aborted) console.error(`telemetry: the counts message was not delivered (${message(error)})`);
            return;
          }
          this.locked(() => {
            this.refresh();
            if (this.saved.forgotten !== generation) return;
            this.countsDelivered.add(counts.day);
            this.saved.counts = this.saved.counts.filter((entry) => entry.day !== counts.day);
            this.persist();
          }, () => {
            if (this.saved.forgotten === generation) this.countsDelivered.add(counts.day);
            this.skipped("a counts day's delivery");
          });
        }
      } catch (error) {
        console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
      }
    })().finally(() => {
      this.countsSending = null;
      this.countsAbort = undefined;
    });
    return this.countsSending;
  }

  private settleLater(): void {
    const today = utcDay(this.now());
    const settled = utcDay(this.now() - COUNTS_SETTLE_MS);
    if (settled === today || !this.saved.counts.some((entry) => entry.day === settled && !this.countsDelivered.has(entry.day))) return;
    this.countsTimer?.clear();
    this.countsTimer = this.arm(() => void this.flushCounts(), Date.parse(`${today}T00:00:00Z`) + COUNTS_SETTLE_MS - this.now());
  }

  private locked<T>(section: () => T, busy: () => T): T {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try { return section(); } finally { this.lockDepth -= 1; }
    }
    const lock = join(this.options.stateDir, LOCK_FILE);
    const deadline = Date.now() + LOCK_WAIT_MS;
    const stamp = `${process.pid} ${Date.now()} ${randomUUID()}`;
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try { writeSync(fd, stamp); } finally { closeSync(fd); }
        heldLocks.add(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return busy();
        if (staleLock(lock)) { rmSync(lock, { force: true }); continue; }
        if (Date.now() >= deadline) return busy();
        sleepSync(5);
      }
    }
    this.lockDepth = 1;
    this.lockStamp = stamp;
    try { return section(); } finally {
      this.lockDepth = 0;
      this.lockStamp = null;
      heldLocks.delete(lock);
      try { if (readFileSync(lock, "utf8") === stamp) rmSync(lock, { force: true }); } catch {}
    }
  }

  private skipped(what: string): void { console.error(`telemetry: ${what} was not recorded: another server held ${LOCK_FILE}`); }

  private arm(fn: () => void, ms: number): Timer {
    if (this.options.setTimer) return this.options.setTimer(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { clear: () => clearTimeout(timer) };
  }

  start(): void { this.schedule(START_DELAY_MS); }
  stop(): void { clearTimeout(this.timer); this.abort?.abort(); this.activeTimer?.clear(); this.activeAbort?.abort(); this.countsTimer?.clear(); this.countsAbort?.abort(); }

  active(agents: readonly (string | null | undefined)[] | Promise<readonly (string | null | undefined)[]>, visit: { surface?: TelemetrySurface | null; ingress?: TelemetryIngress | null } = {}): Promise<void> {
    const day = utcDay(this.now());
    const forgotten = this.locked((): number | null => {
      if (!this.countingUsage()) return null;
      const counter = this.saved.forgotten;
      const pruned = this.prune();
      let changed = false;
      if (!this.saved.active.some((entry) => entry.day === day)) {
        this.saved.active = readActive([...this.saved.active, { day, harnesses: [], sent: null, visited: true, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null }]);
        changed = true;
      }
      const today = this.saved.active.find((entry) => entry.day === day);
      if (today) {
        const surfaces = withKind(today.usage.surfaces, visit.surface);
        const ingress = withKind(today.usage.ingress, visit.ingress);
        if (!today.visited || surfaces.join() !== today.usage.surfaces.join() || ingress.join() !== today.usage.ingress.join()) {
          today.visited = true;
          today.usage = { ...today.usage, surfaces, ingress };
          changed = true;
        }
      }

      if (changed || pruned) {
        try { this.persist(); } catch (error) {
          console.error(`telemetry: the visit could not be recorded (${message(error)})`);
          return null;
        }
      }
      return counter;
    }, () => { this.skipped("a visit"); return null; });
    if (forgotten === null) {
      Promise.resolve(agents).catch(() => {});
      return Promise.resolve();
    }
    return (async () => {
      let found: readonly (string | null | undefined)[];
      try { found = await agents; } catch (error) {
        console.error(`telemetry: the panes could not be read (${message(error)})`);
        found = [];
      }
      const go = this.locked(() => {
        if (!this.countingUsage() || this.saved.forgotten !== forgotten) return false;
        const entry = this.saved.active.find((known) => known.day === day);
        if (entry) {
          const merged = [...new Set([...entry.harnesses, ...found.map(harnessOf).filter((harness) => harness !== null)])].sort();
          if (!sameHarnesses(merged, entry.harnesses)) {
            entry.harnesses = merged;
            try { this.persist(); } catch (error) {
              console.error(`telemetry: the visit could not be recorded (${message(error)})`);
              return false;
            }
          }
        }
        return true;
      }, () => { this.skipped("a visit's kinds of agents"); return false; });
      if (!go) return;
      void this.flushCounts();
      return this.flushActive(true);
    })();
  }

  /**
   * Delivers every recorded day whose harnesses were not delivered yet, oldest first, no sooner
   * than NOTICE_GRACE_MS after the notice; never records a day. A failure is logged and tried
   * again at the next visit or change. Today's usage as it stands goes only with its first message or
   * from a `visit`, USAGE_RESEND_MS after it last went on the wire; any other message carries what went.
   */
  private flushActive(visit = false): Promise<void> {
    if (!this.writable) return Promise.resolve();
    const pruned = this.locked(() => {
      this.refresh();
      if (this.prune()) {
        try { this.persist(); } catch (error) {
          console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
          return false;
        }
      }
      return true;
    }, () => { this.skipped("the visit days to send"); return false; });
    if (!pruned) return Promise.resolve();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (!this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    const today = utcDay(this.now());
    const usageDue = (entry: ActiveDay) => entry.sent_at === null
      || ((visit || entry.day < today) && this.now() - entry.sent_at >= USAGE_RESEND_MS);
    const carried = (entry: ActiveDay) => usageDue(entry) ? entry.usage : entry.wire_usage ?? entry.sent_usage ?? entry.usage;
    const owed = (entry: ActiveDay) => entry.visited && (entry.sent === null || entry.sent_usage === null
      || !sameHarnesses(entry.sent, entry.harnesses)
      || !sameUsage(entry.sent_usage, carried(entry)));
    if (!this.activeSending && !this.saved.active.some(owed)) return Promise.resolve();
    const wait = seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS) - this.now();
    if (wait > 0) {
      this.activeTimer?.clear();
      this.activeTimer = this.arm(() => void this.flushActive(), wait);
      return Promise.resolve();
    }
    if (this.activeSending) { this.activeAgain = true; this.activeAgainVisit ||= visit; return this.activeSending; }
    const due = this.saved.active.filter(owed).map((entry) => ({ active: this.activeMessage({ ...entry, usage: carried(entry) }), fresh: usageDue(entry) }));
    const forgotten = this.saved.forgotten;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.activeSending = (async () => {
      try {
        for (const { active: built } of due) {
          if (abort.signal.aborted) return;
          let active = built;
          const next = this.locked((): "stop" | "skip" | "send" => {
            this.refresh();
            if (!this.saved.enabled || this.saved.forgotten !== forgotten) return "stop";
            const going = this.saved.active.find((known) => known.day === active.day);
            if (!going) return "skip";
            if (!owed(going)) return "skip";
            const fresh = usageDue(going);
            active = this.activeMessage({ ...going, usage: carried(going) });
            going.wire_usage = active.usage;
            if (fresh) going.sent_at = this.now();
            this.persist();
            return this.saved.forgotten !== forgotten ? "stop" : "send";
          }, () => { this.skipped("an active message about to go"); return "stop"; });
          if (next === "stop") return;
          if (next === "skip") continue;
          if (offMarked(this.offFile)) return;
          this.refresh();
          if (this.saved.forgotten !== forgotten) return;
          try {
            const response = await this.options.fetch(this.options.activeUrl ?? ACTIVE_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(active),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          } catch (error) {
            if (!abort.signal.aborted) console.error(`telemetry: the active message was not delivered (${message(error)})`);
            return;
          }
          const marked = this.locked(() => {
            this.refresh();
            if (this.saved.forgotten !== forgotten) return false;
            const entry = this.saved.active.find((known) => known.day === active.day);
            if (entry) {
              entry.sent = active.harnesses;
              entry.sent_usage = active.usage;
              this.persist();
            }
            return true;
          }, () => { this.skipped("an active message's delivery"); return false; });
          if (!marked) return;
        }
      } catch (error) {
        console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
      }
    })().finally(() => {
      this.activeSending = null;
      this.activeAbort = undefined;
      if (this.activeAgain) {
        const again = this.activeAgainVisit;
        this.activeAgain = false;
        this.activeAgainVisit = false;
        void this.flushActive(again);
      }
    });
    return this.activeSending;
  }

  report(): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.writable) return Promise.resolve();
    this.refresh();
    const event = this.pending();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (!event || !this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    const wait = seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS) - this.now();
    if (wait > 0) { this.schedule(wait); return Promise.resolve(); }
    const forgotten = this.saved.forgotten;
    const abort = new AbortController();
    this.abort = abort;
    this.sending = (async () => {
      try {
        if (offMarked(this.offFile)) return;
        this.refresh();
        if (this.saved.forgotten !== forgotten) return;
        const response = await this.options.fetch(this.options.url ?? TELEMETRY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.locked(() => {
          this.refresh();
          if (this.saved.forgotten !== forgotten) return;
          this.saved.reported_version = event.version;
          this.saved.replaced_forgotten = false;
          this.persist();
        }, () => this.skipped(`the ${event.event} event's delivery`));
      } catch (error) {
        if (!abort.signal.aborted) console.error(`telemetry: the ${event.event} event was not delivered (${error instanceof Error ? error.message : String(error)})`);
      }
    })().finally(() => {
      this.sending = null;
      this.abort = undefined;
    });
    return this.sending;
  }
}

export async function handleTelemetryRequest(request: Request, telemetry?: Telemetry): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  if (!telemetry) return reply({ error: { code: "not_found", message: "This server sends no telemetry" } }, 404);
  if (request.method === "GET") return reply(telemetry.status());
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use GET or POST /api/telemetry" } }, 405);
  if (!updateRequestAllowed(request)) return reply({ error: { code: "invalid_telemetry_request", message: "Use the controls from this app." } }, 403);
  const tooLarge = () => reply({ error: { code: "too_large", message: "The telemetry change is too large" } }, 413);
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_CHANGE_BYTES) return tooLarge();
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_CHANGE_BYTES) return tooLarge();
  let body: unknown;
  try { body = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  if (!isJsonObject(body)) return badRequest("invalid_body", "Send an object");
  const change = telemetryChange(body);
  // a counts change is refused as any unknown key was before, while this build counts nothing
  if (!change || (change.counts !== undefined && !telemetry.takesCounts())) return badRequest("invalid_body", "Send enabled, settings, or the current notice acknowledgement");
  try { return reply(telemetry.change(change)); }
  catch (error) { return errorResponse(error); }
}
