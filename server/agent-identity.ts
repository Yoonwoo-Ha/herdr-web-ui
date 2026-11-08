import nodePath from "node:path";
import { AGENT_CATALOG, catalogPlatform, type CatalogPlatform } from "../shared/agent-catalog.ts";

/**
 * Which agent a pane runs, decided in one place from the facts a runtime gives about it, so the
 * same answer holds whatever runtime serves the pane. Today herdr-core's snapshot names its panes
 * here (herdr's TUI names its own); sessions and status are to follow.
 */
export interface PaneFacts {
  /** the app the program reported itself as (herdr-core's OSC 7501 `app`), in the runtime's words */
  reported?: string | null;
  /** the argv of the process in front of the pane; its name alone when the runtime gives no argv */
  foreground?: readonly string[] | null;
}

/** Runtimes' names for agents herdr names otherwise: the rest of the server knows herdr's (`claude`, `agy`). */
const REPORTED_NAMES: Readonly<Record<string, string>> = { "claude-code": "claude", antigravity: "agy", "kimi-code": "kimi", "grok-build": "grok" };

/** The interpreters an agent's script runs under when its install is a script (npm's node bin, a Python entry point). */
const INTERPRETERS = new Set(["node", "bun", "python", "python3"]);

/** A program's name in a process listing: its path's last part, without a Windows or script extension. */
export function programName(word: string): string {
  return nodePath.posix.basename(word.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|js|mjs|cjs)$/i, "");
}

/** The agent a reported app names, by herdr's name; null for no report. */
export function reportedAgent(app: string | null | undefined): string | null {
  if (!app) return null;
  return Object.hasOwn(REPORTED_NAMES, app) ? REPORTED_NAMES[app]! : app;
}

/** A path's last part as `platform` names files: on Windows in any case, a program without its `.exe` or `.cmd`. */
function fileName(word: string, platform: CatalogPlatform | null, program: boolean): string {
  const name = nodePath.posix.basename(word.replace(/\\/g, "/"));
  if (platform !== "windows") return name;
  return program ? name.toLowerCase().replace(/\.(?:exe|cmd)$/, "") : name.toLowerCase();
}

/** Interpreter options after which the next word is code or a module, not a script file. */
const NOT_A_SCRIPT = new Set(["-e", "--eval", "-p", "--print", "-c", "-m", "-"]);

/** The script an interpreter runs: the first word after its own options; null for code or a module given inline. */
function scriptOf(argv: readonly string[]): string | null {
  for (const word of argv.slice(1)) {
    if (NOT_A_SCRIPT.has(word) || word === "--") return null;
    if (!word.startsWith("-")) return word;
  }
  return null;
}

/**
 * The catalog agent a foreground process is: one of its detect binaries run directly, or the
 * extensionless script by that name an interpreter runs (npm's bin, a Python entry point), never
 * any `pi.js` that shares a name. A binary whose name proves nothing on `platform` (Windows' own
 * cmd) names none there.
 */
export function processAgent(argv: readonly string[], platform: CatalogPlatform | null): string | null {
  const first = fileName(argv[0] ?? "", platform, true);
  const program = INTERPRETERS.has(first) ? fileName(scriptOf(argv) ?? "", platform, false) : first;
  if (!program) return null;
  const entry = AGENT_CATALOG.find((candidate) => candidate.detect.binaries.includes(program) && !(platform && candidate.detect.unreliable_on?.[platform]));
  return entry?.id ?? null;
}

/** The agent a pane runs: the program's own report first, else the process in front of it; null for none. */
export function paneAgent(facts: PaneFacts, platform: CatalogPlatform | null = catalogPlatform(process.platform)): string | null {
  return reportedAgent(facts.reported) ?? (facts.foreground?.length ? processAgent(facts.foreground, platform) : null);
}
