/**
 * The app's controls as the anonymous usage counts see them (shared/telemetry.ts TelemetryCounts): a
 * handler names what was used, from TELEMETRY_COUNTERS only (a name not in it does not compile), and a
 * control that is not always drawn says once a day that it was shown. Nothing else is told: no text,
 * no pane, no time. A batch goes to this page's server (POST /api/telemetry `counts`) about once a
 * minute and when the page is hidden; the server adds it to today's counts and sends a day only after
 * it has ended, as buckets.
 *
 * Nothing is counted in a build whose notice does not say so (shared/telemetry-notice.ts COUNTS_ON).
 * Counting follows the server's word: only while its counts are on, not blocked, and its current
 * notice was shown. Until the page has heard that, a use is not kept, so nothing pressed before the
 * notice is ever told. A pane on another PC is not counted, and neither is a switch the app makes by
 * itself. A window at most SHEET_QUERY wide counts as narrow, any other as wide.
 */
import { useEffect } from "react";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { COUNTS_ON } from "../../shared/telemetry-notice.ts";
import { harnessOf, type TelemetryCounter, type TelemetryCountsChange, type TelemetryShown, type TelemetryStatus, type TelemetryViewSource, type TelemetryWidth } from "../../shared/telemetry.ts";
import type { PaneView } from "./actions.ts";
import { changeTelemetry, fetchTelemetry, onTelemetryStatus } from "./api.ts";
import { SHEET_QUERY } from "./sheets.ts";

/** how long a batch waits before it is told, unless the page is hidden first */
export const FLUSH_MS = 60_000;

interface Pending { add: Partial<Record<TelemetryCounter, number>>; shown: Set<TelemetryShown>; keys: string[] }

export interface UsageCountersOptions {
  /** whether this build counts at all (COUNTS_ON): off, nothing is kept, asked or told */
  on: boolean;
  /** tells the server one width's batch; `keepalive` when the page is going away */
  send: (counts: TelemetryCountsChange, keepalive: boolean) => Promise<TelemetryStatus | null>;
  status: () => Promise<TelemetryStatus | null>;
  narrow: () => boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
}

/** the server's word: counting is on only while all of these hold */
export function countingAllowed(status: TelemetryStatus | null): boolean {
  return status !== null && status.enabled && !status.blocked_by_env && status.notice_seen;
}

export function createUsageCounters(options: UsageCountersOptions) {
  /** null until the page has heard the server's word; then whether it counts */
  let allowed: boolean | null = null;
  let asking = false;
  const empty = (): Pending => ({ add: {}, shown: new Set(), keys: [] });
  const pending: Record<TelemetryWidth, Pending> = { narrow: empty(), wide: empty() };
  /** controls told (or on their way) as shown, by UTC day and width; a batch that is lost takes its own back out */
  const toldShownByDayAndWidth = new Set<string>();
  /** controls drawn now, each with how many places draw it: told again on a new day or width while they stay */
  const drawn = new Map<TelemetryShown, number>();
  const forget = (keys: readonly string[]): void => { for (const key of keys) toldShownByDayAndWidth.delete(key); };
  let cancelTimer: (() => void) | null = null;

  const heard = (status: TelemetryStatus | null): void => {
    const was = allowed;
    allowed = countingAllowed(status);
    if (!allowed) drop();
    // drawn before the server's word came: told now
    else if (was !== true) reshow();
  };
  const ask = (): void => {
    if (asking || allowed !== null) return;
    asking = true;
    options.status().then(heard, () => { /* not heard: nothing is kept, and the next use asks again */ }).finally(() => { asking = false; });
  };
  const drop = (): void => {
    for (const width of ["narrow", "wide"] as const) { forget(pending[width].keys); pending[width] = empty(); }
    cancelTimer?.();
    cancelTimer = null;
  };
  const schedule = (): void => {
    if (cancelTimer === null) cancelTimer = options.setTimer(() => { cancelTimer = null; flush(false); }, FLUSH_MS);
  };
  const ready = (): boolean => {
    if (!options.on) return false;
    if (allowed === null) ask();
    return allowed === true;
  };

  /** a control drawn now, told as shown unless it already was today at this width */
  const markShown = (name: TelemetryShown): void => {
    const width = options.narrow() ? "narrow" : "wide";
    const key = `${new Date(options.now()).toISOString().slice(0, 10)}:${width}:${name}`;
    if (toldShownByDayAndWidth.has(key)) return;
    toldShownByDayAndWidth.add(key);
    pending[width].shown.add(name);
    pending[width].keys.push(key);
    schedule();
  };
  /** every control still drawn, for a day or a width that has not had it yet */
  const reshow = (): void => { if (ready()) for (const name of drawn.keys()) markShown(name); };

  function flush(keepalive: boolean): void {
    if (allowed !== true) { drop(); return; }
    // what is still drawn goes with this batch, so the timer it may arm is the one cleared here
    reshow();
    cancelTimer?.();
    cancelTimer = null;
    for (const width of ["narrow", "wide"] as const) {
      const { add, shown, keys } = pending[width];
      if (Object.keys(add).length === 0 && shown.size === 0) continue;
      pending[width] = empty();
      // a batch that is not taken is not tried again: a count told twice would be worse than one lost. Its shown
      // controls are forgotten, so the next batch tells them again; a refusal (a watching device) stops counting here
      options.send({ width, add, shown: [...shown].sort() }, keepalive).then((status) => { if (status) heard(status); }, (error: unknown) => {
        forget(keys);
        allowed = (error as { status?: unknown } | null)?.status === 403 ? false : null;
      });
    }
  }

  return {
    /** the page's server said where counting stands (any answer of GET or POST /api/telemetry) */
    heard,
    count(name: TelemetryCounter): void {
      if (!ready()) return;
      const batch = pending[options.narrow() ? "narrow" : "wide"];
      batch.add[name] = (batch.add[name] ?? 0) + 1;
      schedule();
    },
    /** a control that is not always drawn was drawn: told once a day per width */
    shown(name: TelemetryShown): void {
      if (ready()) markShown(name);
    },
    /**
     * A control that is not always drawn is drawn from now until the returned undo: told as shown now, and again
     * on each new day or width while it stays (with the next batch, on return to the page or a change of width)
     */
    draw(name: TelemetryShown): () => void {
      drawn.set(name, (drawn.get(name) ?? 0) + 1);
      if (ready()) markShown(name);
      return () => {
        const left = (drawn.get(name) ?? 1) - 1;
        if (left > 0) drawn.set(name, left); else drawn.delete(name);
      };
    },
    /** the page came back, or its width crossed SHEET_QUERY: the controls drawn now, for a day or width not told yet */
    reshow,
    /**
     * A chat/terminal switch a person asked for, on a pane of `machineId` running `agent`, counted under
     * the pane's kind and under where it was asked. `source` null is a switch the app made by itself: not counted.
     */
    viewSwitch(to: PaneView, agent: string | null | undefined, source: TelemetryViewSource | null, machineId: string): void {
      if (source === null || machineId !== LOCAL_MACHINE) return;
      this.count(`view_${to}_${harnessOf(agent) ?? "shell"}`);
      this.count(`view_${to}_by_${source}`);
    },
    /** a use on a pane of `machineId`: counted only on this PC's own panes */
    paneUse(name: TelemetryCounter, machineId: string): void {
      if (machineId === LOCAL_MACHINE) this.count(name);
    },
    flush,
  };
}

export type UsageCounters = ReturnType<typeof createUsageCounters>;

export const usageCounters: UsageCounters = createUsageCounters({
  on: COUNTS_ON,
  send: (counts, keepalive) => changeTelemetry({ counts }, { keepalive }),
  status: fetchTelemetry,
  narrow: () => typeof window !== "undefined" && window.matchMedia?.(SHEET_QUERY).matches === true,
  now: () => Date.now(),
  setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
});

if (typeof document !== "undefined") {
  onTelemetryStatus(usageCounters.heard);
  // a phone's page is often closed by leaving it: what it used goes as it is hidden; back, what is drawn is told for today
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") usageCounters.flush(true); else usageCounters.reshow(); });
  window.matchMedia?.(SHEET_QUERY).addEventListener?.("change", () => usageCounters.reshow());
  window.addEventListener("pagehide", () => usageCounters.flush(true));
}

/** `name` is drawn while `drawn`, for a pane of `machineId`: told once a day per width while it stays, only for this PC's own panes */
export function useShownCount(name: TelemetryShown, drawn: boolean, machineId: string): void {
  useEffect(() => drawn && machineId === LOCAL_MACHINE ? usageCounters.draw(name) : undefined, [name, drawn, machineId]);
}
