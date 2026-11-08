import nodePath from "node:path";
import { AGENT_CATALOG, catalogPlatform, type CatalogPlatform } from "../shared/agent-catalog.ts";
import type { AgentSessionInfo, AgentStatus } from "../shared/herdr-api.generated.ts";

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

/**
 * The status a program's own report says (herdr-core keeps its OSC 7501 word: idle, working, done,
 * blocked, error, …), in herdr's narrower words: an error says nothing about the turn having
 * finished, so it shows as no status, like a word neither knows.
 */
export function reportedStatus(state: string | null | undefined): AgentStatus {
  switch (state) {
    case "working":
    case "blocked":
    case "idle":
    case "done":
      return state;
    default:
      return "unknown";
  }
}

/** Letta Code's terminal title while a turn runs: a braille spinner frame, then its agent's name ("⠋ Tutor"; at rest "Tutor"; letta-code 0.34.44). */
export const LETTA_BUSY_TITLE = /^[\u2800-\u28FF] /;
/** Letta Code's title while a tool call waits for the user's approval, blinking between the two marks ("[ ! ] Action Required | Tutor"; letta-code 0.34.44, standard permission mode). */
export const LETTA_ASKING_TITLE = /^\[ [.!] \] Action Required \| /;

/**
 * The status an agent's own terminal title says, for an agent known to set one: Letta's spinner
 * prefix while it works, its "Action Required" mark while it waits for the user's approval. The
 * program writes the title itself; nothing is read off the screen. Null for another agent or no title.
 */
export function titleStatus(agent: string | null, title: string | null | undefined): "working" | "idle" | "blocked" | null {
  if (agent !== "letta" || typeof title !== "string" || title === "") return null;
  if (LETTA_ASKING_TITLE.test(title)) return "blocked";
  return LETTA_BUSY_TITLE.test(title) ? "working" : "idle";
}

/** What a runtime tells about which conversation a pane's agent shows. */
export interface SessionFacts {
  /** the sessions the agent named as busy while it ran here (OpenCode's OSC 7501 records), the newest last */
  named?: readonly string[];
  /** the sessions in the agent's own store whose title is the pane's terminal title */
  titled?: readonly string[];
}

/**
 * The conversation a pane's agent shows, in herdr's report shape so every resolver reads one form;
 * null when the facts do not settle it. OpenCode: a record names a busy tab, not the one on screen,
 * so the session is the one it named that alone carries the terminal's title.
 */
export function paneSession(agent: string | null, facts: SessionFacts): AgentSessionInfo | null {
  if (agent !== "opencode") return null;
  const titled = facts.titled ?? [];
  return titled.length === 1 && (facts.named ?? []).includes(titled[0]!) ? { agent: "opencode", source: "herdr:opencode", kind: "id", value: titled[0]! } : null;
}

/** The agent a pane runs: the program's own report first, else the process in front of it; null for none. */
export function paneAgent(facts: PaneFacts, platform: CatalogPlatform | null = catalogPlatform(process.platform)): string | null {
  return reportedAgent(facts.reported) ?? (facts.foreground?.length ? processAgent(facts.foreground, platform) : null);
}
