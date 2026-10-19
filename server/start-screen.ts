import type { ConversationMetadata, ConversationResponse } from "../shared/protocol.ts";

/**
 * Models stated by the agent's own layout before its transcript exists.
 * omp is deliberately excluded: its display names require a catalog lookup, and listing
 * that catalog can refresh the CLI's OAuth credentials.
 */
type Screen = Pick<ConversationMetadata, "model" | "reasoning_effort">;
const NOTHING: Screen = { model: null, reasoning_effort: null };

const CLAUDE_FAMILY = "opus|sonnet|haiku|fable|mythos";
const VERSION = "[1-9]\\d?";
const EFFORT = "none|minimal|low|medium|high|xhigh|max";

function lastMatch(lines: string[], pattern: RegExp): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]!);
    if (match) return match;
  }
  return null;
}

/** `▝▜██████▀  Haiku 5.5 · Claude Max`, the line under `Claude Code v…`. */
function claudeScreen(lines: string[]): Screen {
  const title = lastMatch(lines, /Claude Code v\d/u);
  if (!title) return NOTHING;
  const named = new RegExp(`(?:^|\\s)(${CLAUDE_FAMILY}) (${VERSION})(?:\\.(0|${VERSION}))? · `, "iu").exec(lines[lines.indexOf(title.input) + 1] ?? "");
  if (!named) return NOTHING;
  return { model: `claude-${named[1]!.toLowerCase()}-${named[2]}${named[3] === undefined ? "" : `-${named[3]}`}`, reasoning_effort: null };
}

/** Only the live composer footer owns a Codex model. Text above it (an answer quoting the
 * /model picker, a draft) never does, and while a popup hides the footer the model is unknown. */
function codexScreen(lines: string[]): Screen {
  let header = lines.length - 1;
  while (header >= 0 && !lines[header]!.includes("OpenAI Codex (v")) header--;
  if (header < 0) return NOTHING;
  const visible = lines.slice(header + 1);
  const footer = new RegExp(`^\\s*(GPT-[\\w.-]+) (${EFFORT})(?: \\w+)? · `, "u");
  let end = visible.length - 1;
  while (end >= 0 && visible[end]!.trim() === "") end--;
  if (end < 1 || !/^\s*[←?].*(?:for agents|shortcuts)/u.test(visible[end]!)) return NOTHING;
  const found = footer.exec(visible[end - 1]!);
  if (!found || !visible.slice(0, end - 1).some((line) => /^\s*›(?:\s|$)/u.test(line))) return NOTHING;
  return { model: found[1]!.toLowerCase(), reasoning_effort: found[2]! };
}

/** ` ⬢ opus-5.5 · ◉ xhigh · 1.5% / …`, the status line over the composer. */
function gjcScreen(lines: string[]): Screen {
  const found = lastMatch(lines, new RegExp(`⬢ (\\S+) · ◉ (${EFFORT})(?: |$)`, "u"));
  if (!found) return NOTHING;
  const claude = new RegExp(`^(${CLAUDE_FAMILY})-(${VERSION})(?:\\.(0|${VERSION}))?$`, "u").exec(found[1]!);
  const model = claude ? `claude-${claude[1]}-${claude[2]}${claude[3] === undefined ? "" : `-${claude[3]}`}` : found[1]!;
  return { model, reasoning_effort: found[2]! };
}

const SCREENS: Partial<Record<ConversationResponse["source"], (lines: string[]) => Screen>> = {
  "claude-transcript": claudeScreen,
  "codex-transcript": codexScreen,
  "gjc-transcript": gjcScreen,
};

export function readsStartScreen(source: ConversationResponse["source"]): boolean {
  return SCREENS[source] !== undefined;
}

export function startScreenMetadata(source: ConversationResponse["source"], screen: string): Screen {
  return SCREENS[source]?.(screen.split("\n")) ?? NOTHING;
}
