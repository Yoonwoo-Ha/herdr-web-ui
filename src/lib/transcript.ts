/**
 * pane.read "recent" text -> chat-style transcript messages.
 *
 * herdr's scrollback is plain text (strip_ansi), so speaker attribution is
 * heuristic and deliberately conservative: only markers every agent TUI in
 * this setup actually emits are structural (the ❯ prompt echo and full-width
 * rule lines); everything else degrades to an agent bubble instead of being
 * misfiled. Pure logic, DOM-free, unit-tested in transcript.test.ts.
 */

export type TranscriptRole = "user" | "agent" | "status";

export interface TranscriptMessage {
  role: TranscriptRole;
  /** paragraph breaks are kept as \n inside one message */
  text: string;
}

/** Full-width rules agent TUIs draw between turns (Claude Code separators). */
const RULE_LINE = /^[─━═]{6,}$/;
/** The prompt echo: what the user typed, shown back by the agent TUI. */
const USER_LINE = /^❯\s?/;
/**
 * Chrome the TUI repaints every turn — model/cwd line, context meters, mode
 * footers. Dimmed, never bubble-styled, so the transcript reads as messages.
 */
const STATUS_LINE =
  /^(?:\[[^\]]*\]\s*│|⏵|⣾|█|Context\s|Usage\s|[·•]\s*\d+\s*shell)/;

/** Splits a stripped scrollback read into ordered transcript messages. */
export function toTranscriptMessages(text: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let pending: { role: TranscriptRole; lines: string[] } | null = null;

  const flush = (): void => {
    if (pending === null) return;
    const body = pending.lines.join("\n").replace(/^\n+|\n+$/g, "");
    if (body.length > 0) messages.push({ role: pending.role, text: body });
    pending = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trimEnd();
    if (RULE_LINE.test(line.trim())) {
      flush();
      continue;
    }
    if (USER_LINE.test(line.trim())) {
      flush();
      const prompt = line.trim().replace(USER_LINE, "").trim();
      if (prompt.length > 0) messages.push({ role: "user", text: prompt });
      continue;
    }
    const role: TranscriptRole = STATUS_LINE.test(line.trim()) ? "status" : "agent";
    if (pending !== null && pending.role === role) {
      pending.lines.push(line);
      continue;
    }
    flush();
    pending = { role, lines: [line] };
  }
  flush();
  return messages;
}
