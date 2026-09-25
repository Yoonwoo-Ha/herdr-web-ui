import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import { sessionSnapshot } from "./herdr/client.ts";

/**
 * `done` for agents herdr loses track of on the way.
 *
 * herdr reports `done` for an agent that went back to idle while its pane was not being
 * looked at (not focused), and `idle` once it is. It follows the agent it saw working, so
 * an agent recognised from its screen and processes rather than an integration can
 * finish as plain `idle`: an omo pane reads `pi/working`, then `claude/unknown` while
 * omo's claude child runs, then `claude/idle` (live-traced with omo 5.0), and the
 * working agent herdr knew never finished. The sidebar said READY, and no alert came.
 *
 * So each pane's "worked since it was last idle" is kept here, and an idle that follows
 * work, in a pane herdr does not have focused, is reported as `done` until the pane is
 * focused or works again: what herdr itself reports for an agent it did not lose. And
 * the `unknown` in between, while an agent is still there, is reported as `working`
 * (omo's whole turn read `unknown`, and the sidebar showed no RUN).
 */
export class CompletionTracker {
  /** panes that worked (or were blocked) since they were last idle, done or seen */
  private readonly worked = new Set<string>();
  /** panes reported here as `done` while herdr says `idle` */
  private readonly finished = new Set<string>();
  /** each pane's latest event, so a finish still asking about focus never lands after a newer one */
  private readonly latest = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly focusedPane: () => Promise<string | null> = async () => {
    const snapshot = await sessionSnapshot();
    return snapshot.panes.find((pane) => pane.focused)?.pane_id ?? null;
  }) {}

  /**
   * A status change as herdr sent it; resolves to the status to report, or null when a
   * newer change of the same pane arrived meanwhile (that one is reported instead).
   */
  async observe(paneId: string, status: AgentStatus, agent: string | null = null): Promise<AgentStatus | null> {
    const id = ++this.sequence;
    this.latest.set(paneId, id);
    if (status !== "idle" || !this.worked.has(paneId)) return this.settle(paneId, status, null, agent);
    // herdr's events do not say whether the pane is focused: ask, once per finish
    const focused = await this.focusedPane().catch(() => null);
    if (this.latest.get(paneId) !== id) return null;
    return this.settle(paneId, status, focused === paneId, agent);
  }

  /** A snapshot as the browser should see it: idle panes this tracker saw finish read `done`. */
  present(snapshot: SessionSnapshot): SessionSnapshot {
    const statuses = new Map<string, AgentStatus>();
    for (const pane of snapshot.panes) {
      const status = this.settle(pane.pane_id, pane.agent_status, pane.focused, pane.agent ?? null);
      if (status !== pane.agent_status) statuses.set(pane.pane_id, status);
    }
    const live = new Set(snapshot.panes.map((pane) => pane.pane_id));
    for (const pane of [...this.worked, ...this.finished]) if (!live.has(pane)) this.forget(pane);
    if (statuses.size === 0) return snapshot;
    return {
      ...snapshot,
      panes: snapshot.panes.map((pane) => statuses.has(pane.pane_id) ? { ...pane, agent_status: statuses.get(pane.pane_id)! } : pane),
      agents: snapshot.agents.map((agent) => statuses.has(agent.pane_id) ? { ...agent, agent_status: statuses.get(agent.pane_id)! } : agent),
    };
  }

  forget(paneId: string): void {
    this.worked.delete(paneId);
    this.finished.delete(paneId);
    this.latest.delete(paneId);
  }

  /** `focused` is null when unknown (an event): it then never counts as seen. */
  private settle(paneId: string, status: AgentStatus, focused: boolean | null, agent: string | null): AgentStatus {
    switch (status) {
      case "working":
      case "blocked":
        this.worked.add(paneId);
        this.finished.delete(paneId);
        return status;
      case "done":
        this.worked.delete(paneId);
        this.finished.delete(paneId);
        return status;
      case "idle":
        if (focused === true) {
          this.worked.delete(paneId);
          this.finished.delete(paneId);
          return status;
        }
        if (this.worked.delete(paneId)) this.finished.add(paneId);
        return this.finished.has(paneId) ? "done" : status;
      default:
        // `unknown` right after work, with an agent still there, is the work going on under
        // another identity; with no agent left, the pane is a shell again
        if (!this.worked.has(paneId)) return status;
        if (agent === null) {
          this.worked.delete(paneId);
          return status;
        }
        return "working";
    }
  }
}

/** The one tracker of this server: events and every snapshot the browser gets go through it. */
export const completions = new CompletionTracker();
