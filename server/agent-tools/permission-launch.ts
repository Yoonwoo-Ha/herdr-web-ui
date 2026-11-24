import type { HarnessCommand } from "./harnesses.ts";

export const OPEN_REVIEW = "opencode/all-tools-ask/v1";
type Verified = HarnessCommand & { ceiling: { profile: string; mode: string } };

/** Never infer permissions from an adapter's mode name. For an unverified parent only
 * OpenCode has a configured pre-launch policy that also identifies itself over ACP. */
export function permissionLaunch(kind: string, parent: string | undefined, runId: string, command: HarnessCommand): Verified | null {
  if (parent && command.ceiling?.profile === parent) return { ...command, ceiling: command.ceiling };
  if (kind !== "opencode" || (parent !== undefined && parent !== OPEN_REVIEW)) return null;
  const mode = `ovis-ask-${runId}`;
  const permissions = [{ action: "*", resource: "*", effect: "ask" }];
  return {
    ...command,
    ceiling: { profile: OPEN_REVIEW, mode },
    env: {
      ...command.env,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: mode, permissions, agents: { [mode]: { mode: "primary", permissions } } }),
    },
  };
}
