import { useEffect, useRef, useState } from "react";

import "./Sidebar.css";

import { closePane } from "../lib/api.ts";
import type { AgentStatus, SessionSnapshot } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { AgentMark } from "./AgentMark.tsx";

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

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/**
 * herdr writes its own chrome in front of an agent pane's title: the agent glyph and a
 * state mark (`π > `, `π ⠴ ` — a braille spinner that would make the row twitch). The row
 * already carries both as the agent mark and the status badge, so the text drops them.
 */
const AGENT_CHROME = /^\u03c0\s*[^\p{L}\p{N}\s]?\s*/u;

function stripPaneChrome(title: string, agent: string | null | undefined): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  return agent ? shellStripped.replace(AGENT_CHROME, "") : shellStripped;
}

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
          // one pane means the workspace name and that pane's title are the same thought:
          // the row carries both on one line and the header would only repeat it
          const merged = workspacePanes.length === 1;
          return (
            <section className="workspace" key={workspace.workspace_id}>
              {!merged && (
                <header className="workspace-header">
                  <span className="workspace-number">{workspace.number}</span>
                  <span className="workspace-label" title={workspace.label}>
                    {workspace.label}
                  </span>
                  <StatusBadge status={workspace.agent_status} />
                </header>
              )}

              {workspacePanes.length === 0 && (
                <div className="workspace-empty">no panes</div>
              )}

              {tabs.map((tab) => {
                const panes = snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id);
                return (
                  <div className="tab-group" key={tab.tab_id}>
                    {tabs.length > 1 && <div className="tab-label">tab {tab.label}</div>}
                    <ul className="pane-list">
                      {panes.map((pane) => {
                        const title = paneTitle(pane);
                        // shell titles are the prompt line: keep the path, drop user@host
                        // (the full title, pane id and cwd stay in the tooltip)
                        const displayTitle = stripPaneChrome(title, pane.agent);
                        // a merged row already names the workspace: don't say it twice
                        const summary = merged && displayTitle === workspace.label ? null : displayTitle;
                        const selected = pane.pane_id === selectedPaneId;
                        return (
                          <li key={pane.pane_id} className="pane-item">
                            <button
                              type="button"
                              className={`pane-row${selected ? " is-selected" : ""}`}
                              aria-current={selected ? "true" : undefined}
                              onClick={() => onSelectPane(pane.pane_id)}
                              title={`${pane.pane_id} — ${title}${pane.cwd ? ` — ${pane.cwd}` : ""}`}
                            >
                              {merged && <span className="workspace-number">{workspace.number}</span>}
                              {merged && <span className="pane-name">{workspace.label}</span>}
                              {summary !== null && <span className="pane-title">{summary}</span>}
                              {pane.agent && (
                                <span className="agent-mark-holder" title={pane.agent}>
                                  <AgentMark agent={pane.agent} size={14} />
                                </span>
                              )}
                              {pane.agent && <StatusBadge status={pane.agent_status} />}
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
