import { type AgentRecord, OpenRequests, object } from "./record.ts";

/** A row of Hermes's `messages` table (its `state.db`), as server/hermes.ts reads a session's last ones. */
export interface HermesMessage {
  readonly role: string;
  readonly tool_calls: string | null;
  readonly tool_call_id: string | null;
}

function parsed(json: string): unknown {
  try { return JSON.parse(json); } catch { return undefined; }
}

/**
 * A row's calls, each with its `terminal` command; a call, or a row, that does not read as one counts as a call whose
 * command is not known (`row` names it), so it is never taken for none.
 */
function calls(json: string | null, row: number): { id: string; command: string | null }[] {
  const list = json === null ? [] : parsed(json);
  if (!Array.isArray(list)) return [{ id: `row:${row}`, command: null }];
  return list.map((entry, index) => {
    const call = object(entry);
    const fn = object(call?.function);
    const command = fn?.name === "terminal" && typeof fn.arguments === "string" ? object(parsed(fn.arguments))?.command : null;
    return { id: typeof call?.id === "string" ? call.id : `row:${row}:${index}`, command: typeof command === "string" ? command : null };
  });
}

/**
 * Hermes (classic CLI, 0.21) records an assistant row with its `terminal` call (`tool_calls[].function.arguments`
 * `command`) before it asks, and a `tool` row with the call's id once it ran or was refused. Its dangerous-command
 * panel (dialogs/hermes.ts) is the dialog, read as its card reads it.
 */
export const hermesRecord: AgentRecord<readonly HermesMessage[]> = {
  pending(rows) {
    const open = new OpenRequests();
    for (const [index, row] of rows.entries()) {
      if (row.role === "user") open.clear();
      else if (row.role === "tool") open.close(row.tool_call_id);
      else if (row.role === "assistant") for (const call of calls(row.tool_calls, index)) open.open(call.id, call.command);
    }
    return open.only();
  },
};
