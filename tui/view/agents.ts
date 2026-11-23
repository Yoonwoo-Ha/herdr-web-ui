/**
 * The lines of an agent list, the sidebar's Agents section and the full-screen list alike: the agents of every
 * workspace in the sections and order of shared/attention.ts (the browser's), each section under a heading with its
 * count, an agent's helpers right under it. The rows are numbered from 1 in that order, the numbers the list's digit
 * keys and herdr's focus_agent go by.
 */
import { type AgentGroup, knownStatus, type KnownStatus } from "../../shared/attention.ts";
import type { CoreView } from "../core/world.ts";

export type AgentLine =
  | { readonly kind: "section"; readonly group: AgentGroup; readonly count: number }
  | {
    readonly kind: "agent";
    readonly id: string;
    /** the row's place in the list, from 1 */
    readonly number: number;
    readonly helper: boolean;
    readonly status: KnownStatus;
    /** its name, the folder it works in and the agent, as one line */
    readonly text: string;
    readonly workspace: string;
  };

export function agentLines(agents: CoreView["agents"]): AgentLine[] {
  const lines: AgentLine[] = [];
  agents.forEach((agent, at) => {
    if (agents[at - 1]?.group !== agent.group) lines.push({ kind: "section", group: agent.group, count: agents.filter((row) => row.group === agent.group).length });
    const where = agent.folder ? ` ${agent.folder === "/" ? "/" : `/${agent.folder}`}` : "";
    const what = agent.agent && agent.agent !== agent.name ? ` ${agent.agent}` : "";
    lines.push({ kind: "agent", id: agent.paneId, number: at + 1, helper: agent.helper, status: knownStatus(agent.status), text: `${agent.name}${where}${what}`, workspace: agent.workspace });
  });
  return lines;
}
