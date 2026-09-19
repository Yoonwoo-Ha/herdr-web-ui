import type { AgentStatus, SessionSnapshot } from "../../shared/protocol.ts";

/**
 * Merges a pushed `pane-status` into the last snapshot so the sidebar badge updates
 * instantly; the debounced /api/session refetch that follows brings the derived
 * workspace/tab rollups back in line. Pure: returns the same object when nothing changed.
 */
export function applyPaneStatus(snapshot: SessionSnapshot, paneId: string, status: AgentStatus): SessionSnapshot {
  let paneChanged = false;
  const panes = snapshot.panes.map((pane) => {
    if (pane.pane_id !== paneId || pane.agent_status === status) return pane;
    paneChanged = true;
    return { ...pane, agent_status: status };
  });
  if (!paneChanged) return snapshot;
  const agents = snapshot.agents.map((agent) =>
    agent.pane_id === paneId && agent.agent_status !== status ? { ...agent, agent_status: status } : agent,
  );
  return { ...snapshot, panes, agents };
}
