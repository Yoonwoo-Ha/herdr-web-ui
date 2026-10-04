import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUsage, UsageProviderId, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import { fetchUsage } from "./api.ts";
import type { UsageCount, UsageGlance } from "./settings.ts";
import { t } from "./i18n.ts";
import { usePageVisible } from "./visibility.ts";

/** The server asks a provider at most every 5 minutes; a minute here only picks that up sooner. */
const POLL_MS = 60_000;
/** from this much used, a limit is near enough to show in the blocked color */
export const HIGH_PERCENT = 80;

export const PROVIDER_NAME: Readonly<Record<UsageProviderId, string>> = {
  claude: "Claude", codex: "Codex", cursor: "Cursor", copilot: "Copilot", grok: "Grok", antigravity: "Antigravity",
};

/** AgentMark's name for each provider's logo */
export const PROVIDER_MARK: Readonly<Record<UsageProviderId, string>> = {
  claude: "claude", codex: "codex", cursor: "cursor", copilot: "copilot", grok: "grok", antigravity: "agy",
};

export const WINDOW_LABEL: Readonly<Record<UsageWindow["kind"], string>> = {
  session: "Session",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** The provider whose plan an agent's pane runs on, when the app reads that plan: the inverse of PROVIDER_MARK. */
export function providerForAgent(agent: string | null | undefined): UsageProviderId | null {
  if (agent === undefined || agent === null) return null;
  const found = (Object.keys(PROVIDER_MARK) as UsageProviderId[]).find((id) => PROVIDER_MARK[id] === agent);
  return found ?? null;
}

/**
 * The limits the chat's status line shows for a plan: the plan-wide session and week, those a
 * pane's next turns spend first. A plan with neither shows its limit closest to running out.
 */
export function statusWindows(usage: ProviderUsage): UsageWindow[] {
  const planWide = (["session", "week"] as const)
    .map((kind) => usage.windows.find((window) => window.kind === kind && window.scope === null))
    .filter((window): window is UsageWindow => window !== undefined);
  if (planWide.length > 0) return planWide;
  const tightest = tightestWindow(usage);
  return tightest === null ? [] : [tightest];
}

/** The limit closest to running out: what a chip shows when the plan has no limit of the chosen kind. */
export function tightestWindow(usage: ProviderUsage): UsageWindow | null {
  return usage.windows.reduce<UsageWindow | null>((tightest, window) => tightest === null || window.used_percent > tightest.used_percent ? window : tightest, null);
}

/**
 * The limit a chip shows: the plan-wide one of the kind chosen in Settings (the week, or the
 * short session), never a model's own. A plan without it shows its limit closest to running out.
 */
export function glanceWindow(usage: ProviderUsage, glance: UsageGlance): UsageWindow | null {
  return usage.windows.find((window) => window.kind === glance && window.scope === null) ?? tightestWindow(usage);
}

export function windowLabel(window: UsageWindow): string {
  const kind = t(WINDOW_LABEL[window.kind]);
  if (window.scope === null) return kind;
  const scope = window.scope === "Other models" ? t("Other models") : window.scope === "Cursor models" ? t("Cursor models") : window.scope;
  return `${kind} · ${scope}`;
}

/** A provider and, when known, whose account it is: "Codex · me@example.com". */
export function usageName(usage: ProviderUsage): string {
  return usage.account ? `${PROVIDER_NAME[usage.id]} · ${usage.account}` : PROVIDER_NAME[usage.id];
}

/** What a meter shows of a limit: the share used, or what is left. */
export function meterPercent(window: UsageWindow, count: UsageCount): number {
  return count === "left" ? Math.round((100 - window.used_percent) * 10) / 10 : window.used_percent;
}

/** A meter's value as text: "77%" used, "23% left". */
export function meterText(window: UsageWindow, count: UsageCount): string {
  const value = formatPercent(meterPercent(window, count));
  return count === "left" ? t("{percent} left", { percent: value }) : value;
}

/** "2d 4h", "3h 12m", "12m" until a reset; null when it is unknown or already past. */
export function formatResetIn(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return t("{m}m", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{h}h {m}m", { h: hours, m: minutes % 60 });
  return t("{d}d {h}h", { d: Math.floor(hours / 24), h: hours % 24 });
}

/** Percent as the meters print it: whole numbers, except the tenth that keeps a sliver above 0 visible. */
export function formatPercent(value: number): string {
  return value > 0 && value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/** The accounts in the user's order (`order`, by key), then the rest as the server lists them. */
export function orderProviders(providers: readonly ProviderUsage[], order: readonly string[] = []): ProviderUsage[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...providers].sort((a, b) => {
    const ranked = [rank.get(a.key), rank.get(b.key)];
    if (ranked[0] !== undefined && ranked[1] !== undefined) return ranked[0] - ranked[1];
    if (ranked[0] !== undefined || ranked[1] !== undefined) return ranked[0] !== undefined ? -1 : 1;
    return 0;
  });
}

/**
 * The order after moving `key` one place up or down among the accounts shown (`shown`, in their
 * current order). Accounts remembered but not reported now keep their place after them.
 */
export function moveInOrder(shown: readonly string[], saved: readonly string[], key: string, by: -1 | 1): string[] {
  const next = [...shown];
  const from = next.indexOf(key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return [...shown, ...saved.filter((known) => !shown.includes(known))];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return [...next, ...saved.filter((known) => !shown.includes(known))];
}

export function useUsage(enabled: boolean) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const visible = usePageVisible();
  const generation = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await fetchUsage(refresh);
      if (current === generation.current) setReport((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    } catch { /* offline or restarting: the last report stays */ }
    finally { if (current === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!enabled) { generation.current++; setReport(null); setLoading(false); return; }
    if (!visible) return;
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, visible, load]);

  const refresh = useCallback(() => void load(true), [load]);
  return { report, loading, refresh };
}
