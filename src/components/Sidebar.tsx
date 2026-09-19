import { useEffect, useRef, useState } from "react";

import "./Sidebar.css";

import { closePane } from "../lib/api.ts";
import type { AgentStatus, SessionSnapshot } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";

/** How long a first close click stays armed before it disarms itself. */
const CLOSE_ARM_MS = 3000;
/** How long a failed close keeps its note under the tree. */
const CLOSE_ERROR_MS = 5000;

const STATUS_LABEL: Record<string, string> = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  done: "done",
  unknown: "—",
};

/** The line people scan for: the live terminal title, then the cwd, never blank (shared with push). */
export { paneTitle };

function StatusBadge({ status }: { status?: AgentStatus }) {
  const value = status ?? "unknown";
  return (
    <span className={`badge badge-${value}`} data-status={value} title={`agent ${value}`}>
      {STATUS_LABEL[value] ?? value}
    </span>
  );
}

/**
 * The row's ✕. Click one to arm (the label says so), click again within CLOSE_ARM_MS
 * to actually close; the arm state lives in the Sidebar so only one row is armed at a time.
 */
function PaneCloseButton({ paneId, armed, onConfirm }: { paneId: string; armed: boolean; onConfirm: (paneId: string) => void }) {
  return (
    <button
      type="button"
      className={`pane-close${armed ? " is-armed" : ""}`}
      aria-label={armed ? `confirm close ${paneId}` : `close ${paneId}`}
      title={armed ? "click again to close" : "close pane"}
      onClick={() => onConfirm(paneId)}
    >
      {armed ? "sure?" : "✕"}
    </button>
  );
}

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  onSelectPane: (paneId: string) => void;
}

export function Sidebar({ snapshot, selectedPaneId, onSelectPane }: SidebarProps) {
  // two-step close: the first click arms (a mis-tap on a live pane must not kill it),
  // the second within CLOSE_ARM_MS fires; a failure notes itself under the tree
  const [armedId, setArmedId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
  }, []);

  useEffect(() => {
    if (closeError === null) return;
    const timer = window.setTimeout(() => setCloseError(null), CLOSE_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [closeError]);

  const closePaneClick = (paneId: string): void => {
    setCloseError(null);
    if (armedId !== paneId) {
      setArmedId(paneId);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null;
        setArmedId(null);
      }, CLOSE_ARM_MS);
      return;
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedId(null);
    closePane(paneId).catch((err: unknown) => {
      // either herdr refused or the pane was already gone; the poll reconciles
      setCloseError(err instanceof Error ? err.message : String(err));
    });
  };
  if (!snapshot) {
    return (
      <p className="tree-state" role="status">
        Loading workspaces…
      </p>
    );
  }

  if (snapshot.workspaces.length === 0) {
    return <p className="tree-state tree-state-empty" role="status">No workspaces yet — open one in herdr</p>;
  }

  return (
    <>
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
                {/* the header badge is the multi-pane rollup: with one pane it would
                    just repeat the row badge underneath, so it stays off then */}
                {workspacePanes.length > 1 && <StatusBadge status={workspace.agent_status} />}
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
                          <li key={pane.pane_id} className="pane-item">
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
                            <PaneCloseButton paneId={pane.pane_id} armed={armedId === pane.pane_id} onConfirm={closePaneClick} />
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
      {closeError !== null && (
        <p className="tree-state tree-close-error" role="alert">
          close failed: {closeError}
        </p>
      )}
    </>
  );
}
