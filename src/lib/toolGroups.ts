import type { ConversationPart } from "../../shared/protocol.ts";

/** A run of consecutive same-name tool calls, folded into one expandable block. */
export interface ToolRunGroup {
  kind: "tool-group";
  name: string;
  tools: Extract<ConversationPart, { kind: "tool" }>[];
}

export type GroupedPart = ConversationPart | ToolRunGroup;

/**
 * Folds runs of consecutive same-name tool parts (chatmux's toolGrouping):
 * a transcript lens otherwise drowns in 50 `read` chips. Text parts break a
 * run — the agent speaking between calls means the calls were not one cluster.
 */
export function groupToolRuns(parts: ConversationPart[], threshold = 2): GroupedPart[] {
  const out: GroupedPart[] = [];
  let run: { name: string; tools: Extract<ConversationPart, { kind: "tool" }>[] } | null = null;

  const flush = (): void => {
    if (run === null) return;
    if (run.tools.length >= threshold) {
      out.push({ kind: "tool-group", name: run.name, tools: run.tools });
    } else {
      out.push(...run.tools);
    }
    run = null;
  };

  for (const part of parts) {
    if (part.kind === "tool" && run !== null && run.name === part.name) {
      run.tools.push(part);
      continue;
    }
    flush();
    if (part.kind === "tool") {
      run = { name: part.name, tools: [part] };
    } else {
      out.push(part);
    }
  }
  flush();
  return out;
}
