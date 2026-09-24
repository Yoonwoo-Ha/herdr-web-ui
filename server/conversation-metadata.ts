import type { ConversationMetadata, ConversationResponse } from "../shared/protocol.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const label = (value: unknown): string | null => typeof value === "string" && value.trim() && !value.startsWith("<") ? value.trim() : null;

/** Read recorded settings, never infer effort from the presence of thinking text.
 * Codex turn_context is a snapshot; omp/omo setting changes are separate events. */
export function parseConversationMetadata(text: string, source: ConversationResponse["source"]): ConversationMetadata {
  const metadata: ConversationMetadata = { model: null, reasoning_effort: null };
  for (const line of text.split("\n")) {
    let entry: RecordValue;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (source === "codex-transcript") {
      if (entry.type !== "turn_context" && entry.type !== "session_meta") continue;
      const payload = record(entry.payload);
      const settings = record(record(payload.collaboration_mode).settings);
      const model = label(payload.model) ?? label(settings.model);
      const effort = "effort" in payload ? payload.effort
        : "reasoning_effort" in payload ? payload.reasoning_effort : settings.reasoning_effort;
      if (model) metadata.model = model;
      // A new complete context without effort must not retain an older value.
      if (model || effort !== undefined) metadata.reasoning_effort = label(effort);
    } else if (source === "omp-transcript" || source === "omo-transcript") {
      if (entry.type === "model_change") metadata.model = label(entry.modelId);
      if (entry.type === "thinking_level_change") metadata.reasoning_effort = label(entry.thinkingLevel);
      const message = record(entry.message);
      if (entry.type === "message" && message.role === "assistant" && label(message.model)) metadata.model = label(message.model);
    } else if (source === "claude-transcript") {
      const message = record(entry.message);
      if (entry.type === "assistant" && label(message.model)) metadata.model = label(message.model);
      // Claude Code records the effort each response ran at; versions before it record none
      if (entry.type === "assistant" && "effort" in entry) metadata.reasoning_effort = label(entry.effort);
    }
  }
  return metadata;
}
