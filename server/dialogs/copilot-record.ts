import { type AgentRecord, OpenRequests, jsonLines, object } from "./record.ts";

/**
 * GitHub Copilot CLI's session record (`session-state/<id>/events.jsonl`, 1.0.109) writes the approval it asks for
 * while it asks: `permission.requested` with its `requestId` and, for a shell command, `fullCommandText`; and
 * `permission.completed` with the same `requestId` once answered. Its dialog boxes the command in a box of its own,
 * the last box opened on the screen:
 *
 *   ╭─────────────────────────────────────────────╮
 *   │ Run cmds/fixture.txt contents               │
 *   │ ─────────────────────────────────────────── │
 *   │ ╭─────────────────────────────────────────╮ │
 *   │ │ touch am-short.flag                     │ │
 *   │ ╰─────────────────────────────────────────╯ │
 *   │ Do you want to run this command?            │
 *   │ ❯ 1. Yes                                    │
 */
export const copilotRecord: AgentRecord = {
  dialog: /^╭─+╮$/u,
  pending(text) {
    const requests = new OpenRequests();
    for (const entry of jsonLines(text)) {
      const data = object(entry.data);
      if (entry.type === "permission.requested" && typeof data?.requestId === "string") {
        const command = object(data.permissionRequest)?.fullCommandText;
        requests.open(data.requestId, typeof command === "string" ? command : null);
      } else if (entry.type === "permission.completed") requests.close(data?.requestId);
      else if (entry.type === "user.message") requests.clear();
    }
    return requests.only();
  },
};
