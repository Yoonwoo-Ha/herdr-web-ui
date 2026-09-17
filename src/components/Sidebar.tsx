import "./Sidebar.css";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";

const STATUS_LABEL: Record<string, string> = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  done: "done",
  unknown: "—",
};

/** The line people scan for: the live terminal title, then the cwd, never blank. */
export function paneTitle(pane: HerdrPane): string {
  return pane.terminal_title_stripped ?? pane.terminal_title ?? pane.cwd ?? pane.pane_id;
}

function StatusBadge({ status }: { status?: AgentStatus }) {
  const value = status ?? "unknown";
  return (
    <span className={`badge badge-${value}`} data-status={value} title={`agent ${value}`}>
      {STATUS_LABEL[value] ?? value}
    </span>
  );
}

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  onSelectPane: (paneId: string) => void;
}

export function Sidebar({ snapshot, selectedPaneId, onSelectPane }: SidebarProps) {
  if (!snapshot) {
    return (
      <p className="tree-state" role="status">
        Loading workspaces…
      </p>
    );
  }

  if (snapshot.workspaces.length === 0) {
    return <p className="tree-state tree-state-empty">No workspaces yet — open one in herdr</p>;
  }

  return (
    <nav className="tree" aria-label="herdr workspaces">
      {snapshot.workspaces.map((workspace) => {
        const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
        const workspacePanes = snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
        return (
          <section className="workspace" key={workspace.workspace_id}>
            <header className="workspace-header">
              <span className="workspace-number">{workspace.number}</span>
              <span className="workspace-label" title={workspace.label}>
                {workspace.label}
              </span>
              <StatusBadge status={workspace.agent_status} />
            </header>

            {workspacePanes.length === 0 && <div className="workspace-empty">no panes</div>}

            {tabs.map((tab) => {
              const panes = snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id);
              return (
                <div className="tab-group" key={tab.tab_id}>
                  {tabs.length > 1 && <div className="tab-label">tab {tab.label}</div>}
                  <ul className="pane-list">
                    {panes.map((pane) => {
                      const title = paneTitle(pane);
                      const selected = pane.pane_id === selectedPaneId;
                      return (
                        <li key={pane.pane_id}>
                          <button
                            type="button"
                            className={`pane-row${selected ? " is-selected" : ""}`}
                            aria-current={selected ? "true" : undefined}
                            onClick={() => onSelectPane(pane.pane_id)}
                            title={`${pane.pane_id} — ${title}`}
                          >
                            <span className="pane-title">{title}</span>
                            <span className="pane-meta">
                              <span className="pane-id">{pane.pane_id}</span>
                              {pane.agent && <span className="agent-chip">{pane.agent}</span>}
                              <StatusBadge status={pane.agent_status} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}
