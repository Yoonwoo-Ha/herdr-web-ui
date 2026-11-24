import { type AgentRecord, pendingToolCall } from "./record.ts";

const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/**
 * Letta Code's local backend records a turn's messages as they come (`conversations/<key>/messages.jsonl`, pi's
 * shape, letta-code 0.34): the `Bash` call is there before Letta asks to run it. Its dialog, as 0.34.23 draws it:
 *
 *   Run this command?
 *
 *     $ touch am-short.flag
 *
 *     <the call's description>
 *
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for 'touch am-short.flag' in this project
 *     3. No, and tell Letta Code what to do differently
 *
 * A longer command's preview ends `… output clipped` or `… +3 more lines`: no card answers that dialog.
 */
export const lettaRecord: AgentRecord = {
  dialog: /^Run this command\?$/u,
  lead: /^\$ /u,
  // a long command's preview, cut at two rows (and at a phone's width): the terminal answers it
  cut: /^… (?:output clipped|\+\d+ more lines?)$/u,
  pending: (text) => pendingToolCall(text, SHELL_TOOLS),
};
