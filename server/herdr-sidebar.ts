import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PANE_TOKEN_NAME, type AgentRowTokens, type PaneTokenRule, type PaneTokenSpec } from "../shared/pane-tokens.ts";

/** how often a watched config.toml is looked at again while a browser listens */
const POLL_MS = 5_000;
/** herdr's canonical agent ids (`rows_by_agent` keys): `claude`, `codex`, `pi` */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT_CONDITIONS = ["equals", "contains", "starts_with"] as const;
const NUMBER_CONDITIONS = ["gt", "lt"] as const;

/**
 * herdr's config.toml, as herdr resolves it (`herdr --help`): HERDR_CONFIG_PATH, else herdr/ under
 * XDG_CONFIG_HOME when it is set (on Windows too, as for its sockets), else under %APPDATA% on
 * Windows and ~/.config elsewhere.
 */
export function herdrConfigPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env["HERDR_CONFIG_PATH"]) return env["HERDR_CONFIG_PATH"];
  const root = env["XDG_CONFIG_HOME"] || (platform === "win32" ? env["APPDATA"] || join(home, "AppData", "Roaming") : join(home, ".config"));
  return join(root, "herdr", "config.toml");
}

function table(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A rule with exactly one condition of its kind, as herdr accepts it; anything else herdr refuses, and is left out. */
function tokenRule(value: unknown): PaneTokenRule | null {
  const rule = table(value);
  if (!rule) return null;
  const text = TEXT_CONDITIONS.filter((key) => rule[key] !== undefined);
  const number = NUMBER_CONDITIONS.filter((key) => rule[key] !== undefined);
  if (text.length + number.length !== 1) return null;
  const hide = rule["hide"] === true ? { hide: true } : {};
  if (text.length === 1) {
    const condition = rule[text[0]!];
    if (typeof condition !== "string") return null;
    return { [text[0]!]: condition, ...(rule["ignore_case"] === true ? { ignore_case: true } : {}), ...hide };
  }
  const condition = rule[number[0]!];
  if (typeof condition !== "number" || !Number.isFinite(condition) || rule["ignore_case"] !== undefined) return null;
  return { [number[0]!]: condition, ...hide };
}

/**
 * The `$name` tokens of one layout's rows, in order, a token named twice kept twice: herdr tests each
 * place's rules on its own, so one hidden at its first place may still show at a later one
 * (paneTokenValues draws it once, at the first place that shows it). Null when it is not a list of rows.
 */
function tokenSpecs(rows: unknown): PaneTokenSpec[] | null {
  if (!Array.isArray(rows) || !rows.every(Array.isArray)) return null;
  const specs: PaneTokenSpec[] = [];
  for (const row of rows as unknown[][]) {
    for (const entry of row) {
      const style = table(entry);
      const token = typeof entry === "string" ? entry : style?.["token"];
      if (typeof token !== "string" || !token.startsWith("$")) continue;
      const name = token.slice(1);
      if (!PANE_TOKEN_NAME.test(name)) continue;
      const rules = Array.isArray(style?.["rules"]) ? (style["rules"] as unknown[]).flatMap((rule) => tokenRule(rule) ?? []) : [];
      // only a rule that hides decides anything here: the web UI does not draw herdr's styles
      specs.push(rules.some((rule) => rule.hide) ? { name, rules } : { name });
    }
  }
  return specs;
}

/**
 * The `$name` tokens herdr's `[ui.sidebar.agents]` rows draw, from a parsed config.toml; null when
 * the config sets neither `rows` nor `rows_by_agent`, and the web UI then draws every token.
 */
export function agentRowTokens(config: unknown): AgentRowTokens | null {
  const agents = table(table(table(config)?.["ui"])?.["sidebar"])?.["agents"];
  const layout = table(agents);
  if (!layout) return null;
  const rows = tokenSpecs(layout["rows"]);
  const byAgent = Object.fromEntries(Object.entries(table(layout["rows_by_agent"]) ?? {})
    .filter(([agent]) => AGENT_ID.test(agent))
    .flatMap(([agent, value]) => {
      const specs = tokenSpecs(value);
      return specs === null ? [] : [[agent, specs] as const];
    }));
  if (rows === null && Object.keys(byAgent).length === 0) return null;
  return { rows, by_agent: byAgent };
}

/**
 * herdr's sidebar rows for agents, read from its config.toml, and read again when the file
 * changes while a browser listens (herdr's own sidebar reads them at start and on reload-config).
 * A config that is missing or does not parse names no token: the rows draw every one.
 */
export class HerdrSidebarConfig {
  /** the file's mtime and size when last read; null when it was missing, undefined before the first look */
  private stamp: string | null | undefined;
  private layout: AgentRowTokens | null = null;
  private readonly listeners = new Set<(layout: AgentRowTokens | null) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly path = herdrConfigPath(), private readonly pollMs = POLL_MS) {}

  get(): AgentRowTokens | null {
    this.refresh();
    return this.layout;
  }

  /** Told each time what the rows draw changes; the file is looked at only while someone listens. */
  subscribe(listener: (layout: AgentRowTokens | null) => void): () => void {
    this.listeners.add(listener);
    if (this.timer === null) {
      this.timer = setInterval(() => this.refresh(), this.pollMs);
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0 || this.timer === null) return;
      clearInterval(this.timer);
      this.timer = null;
    };
  }

  /** A change found by any read is told to everyone listening: a browser that connects must not take it from the others. */
  private refresh(): void {
    if (!this.read()) return;
    for (const told of [...this.listeners]) told(this.layout);
  }

  /** Reads the file again when it changed; true when what the rows draw changed with it. */
  private read(): boolean {
    let stamp: string | null;
    try {
      const stat = statSync(this.path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch { stamp = null; }
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    let next: AgentRowTokens | null = null;
    if (stamp !== null) {
      try { next = agentRowTokens(Bun.TOML.parse(readFileSync(this.path, "utf8"))); } catch { next = null; }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.layout);
    this.layout = next;
    return changed;
  }
}
