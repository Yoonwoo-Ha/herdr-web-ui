import { type AgentRecord, OpenRequests, jsonLines, object } from "./record.ts";

/**
 * Muse Code's session record (`session.jsonl`, 1.4) writes the approval it asks for while it asks: a `runtime.session`
 * event of kind `requested` under an `approval` payload, its `pending_action_id`, and for a shell command the
 * `approval_subject` `raw_command`; the same id's `decision_applied` (or its `approval_wait.effect.terminal`) once
 * answered. Its dialog:
 *
 *   Would you like to run the following command?
 *
 *     $ touch am-short.flag
 *     Stage 1/1
 *     Current argv: ["touch","am-short.flag"]
 *
 *   ⟩ 1. Allow this stage once (y)
 */
export const museRecord: AgentRecord = {
  dialog: /^Would you like to run the following command\?$/u,
  lead: /^\$ /u,
  after: /^Stage \d+\/\d+$/u,
  pending(text) {
    const approvals = new OpenRequests();
    for (const entry of jsonLines(text)) {
      const payload = object(entry.payload);
      const event = object(payload?.event);
      if (entry.payload_type === "approval_wait.effect.terminal") approvals.close(object(payload?.record)?.pending_action_id);
      if (entry.payload_type !== "runtime.session" || event === null) continue;
      if (payload?.kind === "approval" && event.kind === "requested" && typeof event.pending_action_id === "string") {
        const subject = object(event.approval_subject);
        approvals.open(event.pending_action_id, subject?.kind === "shell_command" && typeof subject.raw_command === "string" ? subject.raw_command : null);
      } else if (event.kind === "decision_applied") approvals.close(event.pending_action_id);
    }
    return approvals.only();
  },
};
