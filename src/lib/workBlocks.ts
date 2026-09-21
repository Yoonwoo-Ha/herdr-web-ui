import type { ConversationPart } from "../../shared/protocol.ts";

export type ToolPart = Extract<ConversationPart, { kind: "tool" }>;
export type ThinkingPart = Extract<ConversationPart, { kind: "thinking" }>;
export type TextPart = Extract<ConversationPart, { kind: "text" }>;

/**
 * A turn the way Codex shows it: everything the agent did on the way — tool calls,
 * reasoning and the narration between them — folded under one "Worked for 7s · 1 edit"
 * header, and only what it said after the last action left out in the open as the answer.
 */
export interface SplitTurn {
  work: ConversationPart[];
  answer: TextPart[];
}

export function splitTurn(parts: ConversationPart[]): SplitTurn {
  let lastAction = -1;
  for (let index = 0; index < parts.length; index += 1) if (parts[index]?.kind !== "text") lastAction = index;
  const isProse = (part: ConversationPart): part is TextPart => part.kind === "text" && part.text.trim().length > 0;
  return {
    work: parts.slice(0, lastAction + 1).filter((part) => part.kind !== "text" || isProse(part)),
    answer: parts.slice(lastAction + 1).filter(isProse),
  };
}

type WorkCategory = "edit" | "read" | "command" | "other";

const CATEGORY_LABEL: Record<WorkCategory, [singular: string, plural: string]> = {
  edit: ["edit", "edits"],
  read: ["file read", "file reads"],
  command: ["command", "commands"],
  other: ["other tool", "other tools"],
};

function categorize(name: string): WorkCategory {
  const lower = name.toLowerCase();
  if (/edit|write|patch|create_file|multiedit/.test(lower)) return "edit";
  if (/^(read|glob|grep|ls|list|search|find|cat)/.test(lower)) return "read";
  if (/bash|command|shell|exec|eval|run/.test(lower)) return "command";
  return "other";
}

/** "1 edit · 2 file reads · 1 command" — the block's header, in the order a reader cares about. */
export function workSummary(parts: readonly ConversationPart[]): string {
  const counts: Record<WorkCategory, number> = { edit: 0, read: 0, command: 0, other: 0 };
  for (const part of parts) if (part.kind === "tool") counts[categorize(part.name)] += 1;
  return (Object.keys(counts) as WorkCategory[])
    .filter((category) => counts[category] > 0)
    .map((category) => `${counts[category]} ${CATEGORY_LABEL[category][counts[category] === 1 ? 0 : 1]}`)
    .join(" · ");
}

/** "7s" / "1m 12s" for a block header; null when the span is unknown or nonsense. */
export function formatWorkDuration(startTs: string | null, endTs: string | null): string | null {
  if (startTs === null || endTs === null) return null;
  const ms = Date.parse(endTs) - Date.parse(startTs);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes < 60 ? `${minutes}m${rest > 0 ? ` ${rest}s` : ""}` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
