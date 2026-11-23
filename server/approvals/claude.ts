/**
 * Claude Code's adapter to the approval hub (server/approvals/hub.ts): its Bash approvals through its own
 * PermissionRequest hook. The hook goes in a `--settings` file (0600, in the hub's folder), never the user's settings.
 * Measured on Claude Code 2.1.330:
 * - the terminal draws its own dialog while the hook waits, and whichever answers first wins;
 * - answered in the terminal, the hook's request stays open and a later answer to it is ignored, so a request the
 *   screen no longer shows is released (answered with no decision);
 * - a hook that ends with no decision leaves the terminal's dialog as it is, at once.
 * So every card still has its keys: the hook is only how a Yes or No goes when it holds the very request on screen.
 */
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import { settingsFile } from "../claude-settings-file.ts";
import type { ApprovalAdapter, ApprovalDecision } from "./hub.ts";

/**
 * The first Claude Code that draws a Bash dialog's command between dashed rules (its changelog), which is what a held
 * request is bound to (dialogs/claude.ts). An earlier one would bind nothing, so it gets no hook.
 */
export const CLAUDE_HOOK_MIN_VERSION = "2.1.286";

/** Yes allows and No declines; any other option of the dialog goes as its keys. */
export function permissionDecision(label: string): ApprovalDecision | null {
  return label === "Yes" ? "allow" : /^No\b/.test(label) ? "deny" : null;
}

export const claudeApprovals: ApprovalAdapter = {
  kind: "claude",

  supports: (version) => meetsMinVersion(version, CLAUDE_HOOK_MIN_VERSION),

  /**
   * An inline JSON `--settings` the launch already has (the dialog's) goes into the hook's file with it; a `--settings`
   * that names a file, or more than one, could not be merged, and gets no hook.
   */
  launchArgs(args, hook, dir) {
    const given = args ?? [];
    const end = given.indexOf("--");
    const flags = end < 0 ? given : given.slice(0, end);
    const at = flags.flatMap((arg, index) => arg === "--settings" || arg.startsWith("--settings=") ? [index] : []);
    if (at.length > 1) return null;
    let settings: Record<string, unknown> = {};
    let replaced: { from: number; to: number } | null = null;
    if (at.length === 1) {
      const index = at[0]!;
      const inline = flags[index] === "--settings";
      const value = inline ? flags[index + 1] : flags[index]!.slice("--settings=".length);
      if (value === undefined) return null;
      try {
        const parsed: unknown = JSON.parse(value.trim().startsWith("{") ? value : "null");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        settings = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
      replaced = { from: index, to: index + (inline ? 2 : 1) };
    }
    const hooks = typeof settings["hooks"] === "object" && settings["hooks"] !== null && !Array.isArray(settings["hooks"])
      ? { ...(settings["hooks"] as Record<string, unknown>) } : {};
    const theirs = Array.isArray(hooks["PermissionRequest"]) ? hooks["PermissionRequest"] as unknown[] : [];
    // Monitor too: under a Bash-only matcher Claude Code posts a Monitor command as a Bash call, whose allow it then
    // ignores (its hooks reference, 2.1.314 on); matched by name it comes as itself, and is left to the terminal here
    hooks["PermissionRequest"] = [...theirs, {
      matcher: "Bash|Monitor",
      // exec form: no shell between Claude and the relay, on any platform
      hooks: [{ type: "command", command: hook.command, args: hook.args }],
    }];
    const path = settingsFile(JSON.stringify({ ...settings, hooks }), dir);
    if (replaced === null) return ["--settings", path, ...given];
    return [...given.slice(0, replaced.from), "--settings", path, ...given.slice(replaced.to)];
  },

  // a Monitor command, or anything not a Bash command, is the terminal's
  toCard(event) {
    const input = event as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown } | null;
    if (typeof input !== "object" || input === null || input.hook_event_name !== "PermissionRequest" || input.tool_name !== "Bash") return null;
    const tool = input.tool_input as { command?: unknown; description?: unknown } | null | undefined;
    if (typeof tool !== "object" || tool === null || typeof tool.command !== "string" || tool.command.trim() === "") return null;
    return { command: tool.command, description: typeof tool.description === "string" && tool.description.trim() !== "" ? tool.description : null };
  },

  decision: permissionDecision,

  toAnswer(decision) {
    if (decision === null) return "{}";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        // No, as the terminal's No: Claude stops and waits for the user
        decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "The user declined this command in Ovis.", interrupt: true },
      },
    });
  },
};
