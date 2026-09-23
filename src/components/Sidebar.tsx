import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Download, GripVertical, Pencil, Plus, Settings, Terminal, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { knownStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";

const CLOSE_ARM_MS = 3000;
const ERROR_NOTE_MS = 5000;

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/** Herdr's agent glyph and spinner are already represented by the row mark and badge. */
const AGENT_CHROME = /^\u03c0\s*[^\p{L}\p{N}\s]?\s*/u;

function stripPaneChrome(title: string, agent: string | null | undefined): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  return agent ? shellStripped.replace(AGENT_CHROME, "") : shellStripped;
}

export { paneTitle };

/** The title a row or the header shows: the user's label, else the live title minus its chrome. */
export function displayPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || stripPaneChrome(paneTitle(pane), pane.agent) || pane.pane_id;
}

export function StatusBadge({ status }: { status?: AgentStatus }) {
  const value = knownStatus(status);
  return (
    <span className={`badge badge-${value}`} data-status={value} title={`Agent ${value}`}>
      {STATUS_WORD[value]}
    </span>
  );
}

function cwdBasename(cwd: string | null | undefined): string {
  if (!cwd) return "unknown directory";
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.split("/").pop() || cwd;
}

interface InlineError {
  paneId?: string;
  message: string;
}

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  actions: AppActions;
  version: string | null;
  embedded?: boolean;
}

export function Sidebar({ snapshot, selectedPaneId, actions, version, embedded = false }: SidebarProps) {
  const machineId = useMachineId();
  const { closePane, moveWorkspace, renamePane, renameWorkspace } = useMachineApi();
  const [armedId, setArmedId] = useState<string | null>(null);
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null);
  const [paneLabel, setPaneLabel] = useState("");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const armTimer = useRef<number | null>(null);
  const { canInstall, install } = useInstallPrompt();

  useEffect(() => () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
  }, []);

  useEffect(() => {
    if (inlineError === null) return;
    const timer = window.setTimeout(() => setInlineError(null), ERROR_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [inlineError]);

  useEffect(() => {
    if (!snapshot) {
      setWorkspaceOrder([]);
      return;
    }
    const serverOrder = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    setWorkspaceOrder((current) => current.join("\u0000") === serverOrder.join("\u0000") ? current : serverOrder);
  }, [snapshot]);

  const panes = snapshot?.panes ?? [];
  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);

  const noteError = (message: string, paneId?: string): void => setInlineError({ message, paneId });

  const closePaneClick = (paneId: string): void => {
    setInlineError(null);
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
    void closePane(paneId).catch((reason: unknown) => {
      noteError(`Close failed: ${reason instanceof Error ? reason.message : String(reason)}`, paneId);
    });
  };

  const beginPaneRename = (pane: PaneInfo): void => {
    setEditingPaneId(pane.pane_id);
    setPaneLabel(pane.label ?? "");
  };

  const savePaneRename = (paneId: string): void => {
    const label = paneLabel.trim();
    setEditingPaneId(null);
    void renamePane(paneId, label).catch((reason: unknown) => {
      noteError(`Rename failed: ${reason instanceof Error ? reason.message : String(reason)}`, paneId);
    });
  };

  const beginWorkspaceRename = (workspace: WorkspaceInfo): void => {
    setEditingWorkspaceId(workspace.workspace_id);
    setWorkspaceLabel(workspace.label);
  };

  const saveWorkspaceRename = (workspaceId: string): void => {
    const label = workspaceLabel.trim();
    setEditingWorkspaceId(null);
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => {
      noteError(`Rename failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
  };

  const reorderWorkspace = (workspaceId: string, insertIndex: number): void => {
    const sourceIndex = workspaceOrder.indexOf(workspaceId);
    if (sourceIndex < 0) return;
    const boundedIndex = Math.max(0, Math.min(workspaceOrder.length - 1, insertIndex));
    if (sourceIndex === boundedIndex) return;
    const previous = workspaceOrder;
    const next = [...workspaceOrder];
    next.splice(sourceIndex, 1);
    next.splice(boundedIndex, 0, workspaceId);
    setWorkspaceOrder(next);
    void moveWorkspace(workspaceId, boundedIndex).catch((reason: unknown) => {
      setWorkspaceOrder(previous);
      noteError(`Reorder failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
  };

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    reorderWorkspace(sourceId, workspaceOrder.indexOf(targetWorkspaceId));
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const current = workspaceOrder.indexOf(workspaceId);
    reorderWorkspace(workspaceId, current + (event.key === "ArrowUp" ? -1 : 1));
  };

  const dragHandle = (workspace: WorkspaceInfo, draggable: boolean) => (
    <button
      type="button"
      className="sidebar-drag-handle"
      aria-label={`Reorder workspace ${workspace.label}`}
      title="Drag to reorder · Alt+↑/↓"
      draggable={draggable}
      onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
      onDragEnd={() => setDragWorkspaceId(null)}
      onKeyDown={(event) => onHandleKeyDown(event, workspace.workspace_id)}
    >
      <GripVertical aria-hidden="true" />
    </button>
  );

  return (
    <div className={embedded ? "machine-workspaces" : "sidebar-shell"}>
      {!embedded && <div className="sidebar-topbar">
        <button type="button" className="btn sidebar-new-session" onClick={actions.openNewSession}>
          <Plus aria-hidden="true" />
          New session
        </button>
      </div>}

      <nav className="sidebar-list" aria-label="Herdr workspaces">
        {!snapshot && <p className="tree-state" role="status">Loading workspaces…</p>}
        {snapshot && snapshot.workspaces.length === 0 && (
          <p className="tree-state tree-state-empty" role="status">No workspaces yet</p>
        )}
        {orderedWorkspaces.map((workspace) => {
          const visiblePanes = panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
          if (visiblePanes.length === 0) return null;
          // A single pane already names its workspace in the subtitle. Keep the
          // separate workspace heading only when it groups several panes.
          const merged = visiblePanes.length === 1;
          return (
            <section
              className={`workspace${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}`}
              key={workspace.workspace_id}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => onDrop(event, workspace.workspace_id)}
            >
              {!merged && (
                <header
                  className="workspace-header"
                  draggable
                  onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
                  onDragEnd={() => setDragWorkspaceId(null)}
                >
                  {dragHandle(workspace, false)}
                  <span className="workspace-number">{workspace.number}</span>
                  {editingWorkspaceId === workspace.workspace_id ? (
                    <input
                      className="input workspace-rename-input"
                      aria-label="Workspace name"
                      autoFocus
                      value={workspaceLabel}
                      onChange={(event) => setWorkspaceLabel(event.target.value)}
                      onBlur={() => setEditingWorkspaceId(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id);
                        if (event.key === "Escape") setEditingWorkspaceId(null);
                      }}
                    />
                  ) : (
                    <span className="workspace-label" title={workspace.label} onDoubleClick={() => beginWorkspaceRename(workspace)}>
                      {workspace.label}
                    </span>
                  )}
                  <StatusBadge status={workspace.agent_status} />
                  <button type="button" className="sidebar-row-action workspace-rename" aria-label={`Rename workspace ${workspace.label}`} onClick={() => beginWorkspaceRename(workspace)}>
                    <Pencil aria-hidden="true" />
                  </button>
                </header>
              )}

              <ul className="pane-list">
                {visiblePanes.map((pane) => {
                  const fullTitle = paneTitle(pane);
                  const displayTitle = displayPaneTitle(pane);
                  const selected = pane.pane_id === selectedPaneId;
                  const editing = editingPaneId === pane.pane_id;
                  return (
                    <li className={`pane-item${selected ? " is-selected" : ""}`} key={pane.pane_id}>
                      <div className="pane-row">
                        {merged && dragHandle(workspace, true)}
                        <div
                          className="pane-select"
                          role="button"
                          tabIndex={0}
                          aria-current={selected ? "true" : undefined}
                          title={`${pane.pane_id} — ${fullTitle}${pane.cwd ? ` — ${pane.cwd}` : ""}`}
                          onClick={() => actions.selectPane(pane.pane_id)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            actions.selectPane(pane.pane_id);
                          }}
                        >
                          <span className={`agent-mark-holder${pane.agent ? "" : " is-shell"}`} title={pane.agent ?? "Shell"}>
                            {pane.agent ? <AgentMark agent={pane.agent} size={22} /> : <Terminal aria-hidden="true" />}
                          </span>
                          <span className="pane-copy">
                            <span className="pane-primary">
                              {editing ? (
                                <input
                                  className="input pane-rename-input"
                                  aria-label="Pane name"
                                  autoFocus
                                  value={paneLabel}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => setPaneLabel(event.target.value)}
                                  onBlur={() => setEditingPaneId(null)}
                                  onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === "Enter") savePaneRename(pane.pane_id);
                                    if (event.key === "Escape") setEditingPaneId(null);
                                  }}
                                />
                              ) : (
                                <span className="pane-title">{displayTitle}</span>
                              )}
                            </span>
                            <span className="pane-meta">
                              <StatusBadge status={pane.agent_status} />
                              <span className="pane-subtitle">{workspace.label} · {cwdBasename(pane.cwd)}</span>
                            </span>
                          </span>
                        </div>
                        <div className="pane-actions">
                          <button type="button" className="sidebar-row-action" aria-label={`Rename ${displayTitle}`} title="Rename pane" onClick={() => beginPaneRename(pane)}>
                            <Pencil aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={`sidebar-row-action pane-close${armedId === pane.pane_id ? " is-armed" : ""}`}
                            aria-label={armedId === pane.pane_id ? `Confirm close ${displayTitle}` : `Close ${displayTitle}`}
                            title={armedId === pane.pane_id ? "Click again to close" : "Close pane"}
                            onClick={() => closePaneClick(pane.pane_id)}
                          >
                            {armedId === pane.pane_id ? <span>sure?</span> : <X aria-hidden="true" />}
                          </button>
                        </div>
                      </div>
                      {inlineError?.paneId === pane.pane_id && <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {inlineError && inlineError.paneId === undefined && (
          <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>
        )}
      </nav>

      {!embedded && <footer className="sidebar-footer">
        {canInstall && (
          <button type="button" className="btn btn-ghost sidebar-footer-action" onClick={() => void install().catch((reason: unknown) => noteError(reason instanceof Error ? reason.message : String(reason)))}>
            <Download aria-hidden="true" />
            Install app
          </button>
        )}
        <button type="button" className="btn btn-ghost sidebar-footer-action" onClick={actions.openSettings}>
          <Settings aria-hidden="true" />
          Settings
        </button>
        <div className="sidebar-brandline">
          <span className="sidebar-app-name">herdr web ui</span>
          <span className="pill">herdr {version ?? "offline"}</span>
        </div>
      </footer>}
    </div>
  );
}
