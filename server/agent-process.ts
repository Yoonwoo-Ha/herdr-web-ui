import { agentProcesses } from "./conversation.ts";
import type { ProcessInfo } from "./herdr/client.ts";

type ForegroundProcess = NonNullable<ProcessInfo["foreground_processes"]>[number];

export function agentProcessInFront(info: ProcessInfo | null | undefined, agent: string | null | undefined, bound?: number | null, held?: number | null): ForegroundProcess | null {
  const foreground = info?.foreground_processes ?? [];
  const listed = (pid: number | null | undefined) => pid == null ? undefined : foreground.find((entry) => entry.pid === pid);
  return listed(bound) ?? listed(held) ?? (agent ? agentProcesses(foreground, agent)[0] ?? null : null);
}
