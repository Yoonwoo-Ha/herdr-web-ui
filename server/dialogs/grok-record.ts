import { type AgentRecord, OpenRequests, jsonLines, object } from "./record.ts";

/**
 * Grok Build's session record (`updates.jsonl`, as 1.0.92 writes it): its ACP `session/update`s, a `tool_call`
 * with `rawInput.command` when a shell call is issued, then `tool_call_update`s for its id, one with a `status`
 * (`completed`, `failed`) once it is done; a refused one ends with the user's next prompt (`user_message_chunk`).
 * The call is issued before Grok asks, so it waits on the user only while the screen shows its permission panel,
 * which opens on the call's description under Grok's `┃` bar; a command it wraps goes on in a `┆` row, the space it
 * wrapped at drawn as a `·` ending the row above:
 *
 *   ┃  ›  Run the file contents as one shell command
 *   ┃  │ : fixture;·
 *   ┃  ┆ touch am-short.flag
 *   ┃  ← widen scope · e edit pattern            (or → narrow scope)
 *   ┃
 *   ┃  3 (●) Yes, proceed
 */
export const grokRecord: AgentRecord = {
  dialog: /^┃\s+›\s/u,
  wrapMark: /·$/u,
  after: /^[←→] (?:widen|narrow) scope\b/u,
  pending(text) {
    const calls = new OpenRequests();
    for (const entry of jsonLines(text)) {
      const update = object(object(entry.params)?.update);
      if (update?.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
        const command = object(update.rawInput)?.command;
        calls.open(update.toolCallId, typeof command === "string" ? command : null);
      } else if (update?.sessionUpdate === "tool_call_update" && typeof update.status === "string") calls.close(update.toolCallId);
      else if (update?.sessionUpdate === "user_message_chunk") calls.clear();
    }
    return calls.only();
  },
};
