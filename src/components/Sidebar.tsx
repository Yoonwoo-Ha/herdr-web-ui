import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, Ellipsis, Folder, FolderOpen, GitBranch, Layers, LoaderCircle, Pencil, Plus, Terminal, Trash2, TriangleAlert, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { knownStatus, rollupStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { WorktreeDialog, type WorktreeDialogMode } from "./WorktreeDialog.tsx";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { folderName, shortPathTitle, taskRowLines } from "../lib/paneName.ts";
import { useT } from "../lib/i18n.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { useSettings } from "../lib/settings.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useWorktreeBranches } from "../lib/useWorktreeBranches.ts";
import { watchTouchReorder } from "../lib/touchReorder.ts";
import { worktreeLabel } from "../lib/worktreeName.ts";
import { paneMark, sidebarAgents, workspaceAgentLabels } from "../lib/sidebarAgents.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";

const ERROR_NOTE_MS = 5000;

const worktreeCollapsedKey = (machineId: string, repoKey: string) => `herdr-web-ui:worktree-group-collapsed:${machineId}:${repoKey}`;
function storedWorktreeCollapsed(machineId: string, repoKeys: string[]): Set<string> {
  const collapsed = new Set<string>();
  try {
    for (const key of repoKeys) if (localStorage.getItem(worktreeCollapsedKey(machineId, key)) === "1") collapsed.add(key);
  } catch { /* storage denied: nothing is folded */ }
  return collapsed;
}

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/** Herdr's agent glyph and spinner are already represented by the row mark and badge. */
const AGENT_CHROME = /^π\s*[^\p{L}\p{N}\s]?\s*/u;

function stripPaneChrome(title: string, agent: string | null | undefined): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  return agent ? shellStripped.replace(AGENT_CHROME, "") : shellStripped;
}

export { paneTitle };

/**
 * The title a row or the header shows: the user's label, else the live title minus its chrome,
 * a working directory written out shortened to its last folder (lib/paneName.ts).
 */
export function displayPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent)) || pane.pane_id;
}

/** herdr could not bring this pane back after a restart (0.9.3+ `restore_error`): a warning in the status cell, its reason on hover. */
export function RestoreErrorBadge({ reason }: { reason: string }) {
  const t = useT();
  const label = t("NOT RESTORED");
  return (
    <span className="badge badge-restore-error sidebar-status" data-status="restore-error" role="status" aria-label={label} title={`${label} — ${reason}`}>
      <TriangleAlert aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

export function StatusBadge({ status, compact = false }: { status?: AgentStatus; compact?: boolean }) {
  const t = useT();
  const value = knownStatus(status);
  const label = t(STATUS_WORD[value]);
  const description = value === "waiting" ? t("Agent waiting on background work") : t("Agent {status}", { status: label });
  // a compact cell draws only the states that ask for a look: a red question mark while the agent
  // waits for an answer, a green dot once it has finished and was not looked at, a dim arc while
  // it runs, the same arc held still in the working colour while its turn waits on background work.
  // Ready and unknown keep the cell, its label and its tooltip
  const Icon = { idle: null, working: LoaderCircle, blocked: null, done: null, waiting: LoaderCircle, unknown: null }[value];
  return (
    <span
      className={`badge badge-${value}${compact ? " sidebar-status" : ""}`}
      data-status={value}
      role={compact ? "status" : undefined}
      aria-label={compact ? description : undefined}
      title={description}
    >
      {compact && Icon && <Icon aria-hidden="true" />}
      {compact && value === "blocked" && <span className="sidebar-status-mark" aria-hidden="true">?</span>}
      {compact && value === "done" && <span className="sidebar-status-dot" aria-hidden="true" />}
      <span className={compact ? "visually-hidden" : undefined}>{label}</span>
    </span>
  );
}

/**
 * Background tasks an agent started that still run (OmO's `task` children): the main turn can be
 * done while they work, and they wake the session by themselves. A quiet count beside the state,
 * not a state of its own: DONE stays the moment the agent answered.
 */
export function BackgroundBadge({ count }: { count?: number }) {
  const t = useT();
  if (!count || count <= 0) return null;
  const label = t("Background tasks running: {count}", { count });
  return (
    <span className="background-count" title={label} aria-label={label} data-testid="background-tasks">
      <Layers aria-hidden="true" />{count}
    </span>
  );
}

function cwdBasename(cwd: string | null | undefined): string {
  return cwd ? folderName(cwd) : "unknown directory";
}

interface InlineError {
  workspaceId?: string;
  message: string;
}

/** The row whose ⋯ menu is open: a workspace, seen through the pane its row shows. */
interface MenuState { anchor: HTMLElement; workspace: WorkspaceInfo; pane: PaneInfo; title: string; place: string }
interface ConfirmState { title: string; body: string; action?: string; run: () => Promise<void>; escalation?: { label: string; code: string; run: () => Promise<void> } }

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  online: boolean;
  selectedPaneId: string | null;
  actions: AppActions;
}

/**
 * Spaces follow herdr's workspace roster. A workspace opens its current pane; tabs and split
 * panes are navigated through the tab strip, while Agents is an independent API-backed list.
 */
export function Sidebar({ snapshot, online, selectedPaneId, actions }: SidebarProps) {
  const t = useT();
  const { settings } = useSettings();
  const twoLine = settings.sidebarRows === "two";
  const machineId = useMachineId();
  // a DONE looked at here reads as ready with Quiet opened finishes on (lib/sidebarActivity.tsx)
  const activity = useSidebarActivity();
  const { branches, rememberOpened } = useWorktreeBranches(snapshot, online);
  const { closeWorkspace, moveWorkspace, removeWorktree, renamePane, renameWorkspace } = useMachineApi();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [worktreeDialog, setWorktreeDialog] = useState<{ mode: WorktreeDialogMode; workspace: WorkspaceInfo } | null>(null);
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null);
  const [paneLabel, setPaneLabel] = useState("");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  // a finger's drag (lib/touchReorder.ts): the row it holds and the row it is over
  const [touchDrag, setTouchDrag] = useState<{ source: string; over: string | null } | null>(null);
  // the browser's drag and drop is a mouse's: on a touch screen a long press lifts the row instead
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const rosterId = useId();
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const revealOpenedWorkspace = useRef<string | null>(null);
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => storedWorktreeCollapsed(machineId, snapshot?.workspaces.flatMap((workspace) => workspace.worktree ? [workspace.worktree.repo_key] : []) ?? []));
  // the pane each workspace was last seen on: its row keeps showing and opening that one
  const lastViewed = useRef(new Map<string, string>());

  useEffect(() => {
    const pane = selectedPaneId ? snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) : undefined;
    if (pane) lastViewed.current.set(pane.workspace_id, pane.pane_id);
  }, [selectedPaneId, snapshot]);

  const setWorktreeCollapsed = (repoKey: string, collapsed: boolean): void => {
    setCollapsedWorktrees((current) => {
      if (current.has(repoKey) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(repoKey); else next.delete(repoKey);
      return next;
    });
    try {
      if (collapsed) localStorage.setItem(worktreeCollapsedKey(machineId, repoKey), "1");
      else localStorage.removeItem(worktreeCollapsedKey(machineId, repoKey));
    } catch {}
  };

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
    // New worktree groups bring their stored fold state after reconnecting or creating a workspace.
    setCollapsedWorktrees((current) => {
      const keys = snapshot.workspaces.flatMap((workspace) => workspace.worktree && !current.has(workspace.worktree.repo_key) ? [workspace.worktree.repo_key] : []);
      const stored = storedWorktreeCollapsed(machineId, keys);
      return stored.size === 0 ? current : new Set([...current, ...stored]);
    });
  }, [snapshot, machineId]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const roster = useMemo(() => rosterPanes(snapshot?.panes ?? [], selectedPaneId), [snapshot?.panes, selectedPaneId]);
  const agentRows = useMemo(() => sidebarAgents(snapshot), [snapshot]);
  const agentByPane = useMemo(() => new Map(agentRows.map((entry) => [entry.pane.pane_id, entry])), [agentRows]);
  const agentNames = useMemo(() => workspaceAgentLabels(agentRows), [agentRows]);
  // herdr packs a repository's worktree workspaces under the one on its main checkout; a worktree
  // whose repository workspace is not open stays at the top level, in its own place
  const worktreeGroups = useMemo(() => {
    const parentByRepo = new Map<string, WorkspaceInfo>();
    for (const workspace of orderedWorkspaces) {
      if (workspace.worktree && !workspace.worktree.is_linked_worktree && !parentByRepo.has(workspace.worktree.repo_key)) parentByRepo.set(workspace.worktree.repo_key, workspace);
    }
    const childrenOf = new Map<string, WorkspaceInfo[]>();
    const top: WorkspaceInfo[] = [];
    for (const workspace of orderedWorkspaces) {
      const parent = workspace.worktree?.is_linked_worktree ? parentByRepo.get(workspace.worktree.repo_key) : undefined;
      if (!parent) { top.push(workspace); continue; }
      const children = childrenOf.get(parent.workspace_id) ?? [];
      children.push(workspace);
      childrenOf.set(parent.workspace_id, children);
    }
    return top.map((workspace) => ({ workspace, children: childrenOf.get(workspace.workspace_id) ?? [] }));
  }, [orderedWorkspaces]);

  useLayoutEffect(() => {
    const id = revealOpenedWorkspace.current;
    if (!id) return;
    const row = [...(workspaceRoot.current?.querySelectorAll<HTMLElement>(".workspace-group") ?? [])].find((candidate) => candidate.dataset.workspace === id);
    const scroller = workspaceRoot.current?.closest<HTMLElement>(".machine-list");
    if (!row || !scroller || scroller.clientHeight === 0) return;
    const item = row.getBoundingClientRect();
    const panel = scroller.getBoundingClientRect();
    if (item.top < panel.top || item.bottom > panel.bottom) {
      scroller.scrollTop += (item.top + item.bottom - panel.top - panel.bottom) / 2;
    }
    revealOpenedWorkspace.current = null;
  }, [snapshot, selectedPaneId, branches]);

  const noteError = (message: string, workspaceId?: string): void => setInlineError({ message, workspaceId });

  /** the pane a workspace's row shows and opens, among the panes the row stands for */
  const currentPane = (workspace: WorkspaceInfo, panes: PaneInfo[]): PaneInfo => {
    const pick = (id: string | null | undefined) => (id ? panes.find((pane) => pane.pane_id === id) : undefined);
    return pick(selectedPaneId)
      ?? pick(lastViewed.current.get(workspace.workspace_id))
      ?? pick(snapshot?.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes.find((pane) => pane.focused)
      ?? panes[0]!;
  };

  /**
   * What leads a row: the coding agent in the pane the row opens, so the mark never promises an
   * agent a click would not reach. A shell is a terminal, a linked worktree without an agent its branch.
   */
  const rowMark = (pane: PaneInfo, linked: boolean) => {
    const mark = paneMark(agentByPane.get(pane.pane_id));
    return (
      <span className="sidebar-mark" aria-hidden="true">
        {mark !== null ? <AgentMark agent={mark} size={18} /> : linked ? <GitBranch /> : <Terminal />}
      </span>
    );
  };
  /** the mark in words, for a reader who cannot see it */
  const markName = (pane: PaneInfo): string => {
    const entry = agentByPane.get(pane.pane_id);
    return entry?.agentLabel ?? entry?.canonicalAgent ?? t("Shell");
  };
  const agentsTitle = (workspace: WorkspaceInfo): string | null => {
    const names = agentNames.get(workspace.workspace_id);
    return names ? t("Agents: {names}", { names: names.join(", ") }) : null;
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  // A right-click on a row opens the menu its ⋯ opens, under that button, which also takes the
  // focus back when the menu goes. A name being edited keeps the browser's own menu, for its paste.
  // A finger's long press is left alone: it picks the row up to be moved (lib/touchReorder.ts),
  // and the ⋯ is always there on touch.
  const onRowContextMenu = (event: MouseEvent<HTMLElement>, toggle: (anchor: HTMLElement) => void): void => {
    if ((event.target as HTMLElement).closest("input")) return;
    // Chrome and Safari say what pressed; Firefox does not, so there the device's main pointer decides
    const pointer = (event.nativeEvent as PointerEvent).pointerType;
    if (pointer ? pointer === "touch" : window.matchMedia("(pointer: coarse)").matches) return;
    const anchor = event.currentTarget.querySelector<HTMLElement>(".row-menu-toggle");
    if (!anchor) return;
    event.preventDefault();
    toggle(anchor);
  };

  // A close takes the workspace with it, so it asks first, as herdr's ui.confirm_close does.
  // The row is gone afterwards, so focus moves to the header's workspace-list toggle.
  const leave = async (close: () => Promise<void>): Promise<void> => {
    await close();
    setConfirm(null);
    focusWorkspaceListToggle();
  };

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a pane closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const panes = snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? [];
    const paneCount = Math.max(1, panes.length);
    // the pane the row showed may have closed under the open menu: the items then act on the
    // pane the row shows now, never on an id herdr no longer has
    const originalPane = panes.find((candidate) => candidate.pane_id === state.pane.pane_id);
    const pane = originalPane ?? (panes.length > 0 ? currentPane(workspace, panes) : state.pane);
    // a worktree workspace: its checkout can be deleted; the repository's workspace: its open
    // worktree workspaces close with it, which herdr refuses without close_group
    const linked = workspace.worktree?.is_linked_worktree === true;
    const worktrees = linked ? [] : (snapshot?.workspaces.filter((candidate) => candidate.worktree?.is_linked_worktree && candidate.worktree.repo_key === workspace.worktree?.repo_key) ?? []);
    // herdr's own actions on a workspace: rename, a new tab (prefix+c), its worktrees (prefix+shift+g), close
    const items: RowMenuItem[] = [
      { id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => beginWorkspaceRename(workspace) },
      { id: "rename-pane", label: t("Rename pane"), icon: Pencil, run: () => beginPaneRename(pane) },
      { id: "new-tab", label: t("New tab"), icon: Plus, run: () => actions.openNewTab({ machineId, workspaceId: workspace.workspace_id }) },
      ...(linked ? [] : [
        { id: "new-worktree", label: t("New worktree"), icon: GitBranch, run: () => setWorktreeDialog({ mode: "create", workspace }) },
        { id: "open-worktree", label: t("Open worktree…"), icon: FolderOpen, run: () => setWorktreeDialog({ mode: "open", workspace }) },
      ] satisfies RowMenuItem[]),
    ];
    // the touch screen's way to move a row without a drag, and the menu's for everyone
    const moveItems: RowMenuItem[] = [
      ...(moveIndex(workspace.workspace_id, -1) === null ? [] : [{ id: "move-up", label: t("Move up"), icon: ArrowUp, divider: true, run: () => moveVisible(workspace.workspace_id, -1) }]),
      ...(moveIndex(workspace.workspace_id, 1) === null ? [] : [{ id: "move-down", label: t("Move down"), icon: ArrowDown, divider: moveIndex(workspace.workspace_id, -1) === null, run: () => moveVisible(workspace.workspace_id, 1) }]),
    ];
    const deleteItems: RowMenuItem[] = linked ? [{
      id: "delete-worktree", label: t("Delete worktree checkout…"), icon: Trash2, danger: true,
      run: () => setConfirm({
        title: t("Delete the checkout of {name}?", { name: workspace.label }),
        body: t("The folder at {path} is deleted and the workspace closes. The branch stays.", { path: workspace.worktree?.checkout_path ?? "" }),
        action: t("Delete"),
        run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id }); }),
        // git refuses a checkout with unsaved changes: the refusal shows, and the action becomes a forced one
        escalation: { label: t("Delete anyway"), code: "dirty_worktree_requires_force", run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id, force: true }); }) },
      }),
    }] : [];
    // a repository's open worktree workspaces go with it
    const closeItem: RowMenuItem = { id: "close", label: t("Close workspace"), icon: X, danger: true, divider: true, run: () => setConfirm({
      title: t("Close workspace {name}?", { name: workspace.label }),
      body: worktrees.length > 0 ? t("{n} panes and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay.", { n: paneCount, m: worktrees.length }) : t("{n} panes close with it, and the agents in them stop.", { n: paneCount }),
      run: () => leave(() => closeWorkspace(workspace.workspace_id, worktrees.length > 0)),
    }) };
    return [...items, ...moveItems, closeItem, ...deleteItems];
  };

  // the roster moves under an open menu: a row that left takes its menu with it, and focus
  // goes where a closed row's focus goes
  useEffect(() => {
    if (!menu) return;
    const alive = snapshot?.workspaces.some((workspace) => workspace.workspace_id === menu.workspace.workspace_id);
    if (alive && menu.anchor.isConnected) return;
    setMenu(null);
    focusWorkspaceListToggle();
  });

  const beginPaneRename = (pane: PaneInfo): void => {
    setEditingPaneId(pane.pane_id);
    setPaneLabel(pane.label ?? "");
  };

  // a rename's failure is answered after later renders: it asks the roster as it is then, and
  // reopens nothing over an editor the user opened since
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const editingRef = useRef({ pane: editingPaneId, workspace: editingWorkspaceId });
  editingRef.current = { pane: editingPaneId, workspace: editingWorkspaceId };
  const editorOpen = (): boolean => editingRef.current.pane !== null || editingRef.current.workspace !== null;

  const savePaneRename = (pane: PaneInfo): void => {
    const typed = paneLabel;
    const label = typed.trim();
    setEditingPaneId(null);
    void renamePane(pane.pane_id, label).catch((reason: unknown) => {
      // the field comes back with what was typed: a failed request is not a reason to make the
      // user write the name again. Not for a pane that has since closed
      if (!editorOpen() && snapshotRef.current?.panes.some((candidate) => candidate.pane_id === pane.pane_id)) {
        setEditingPaneId(pane.pane_id);
        setPaneLabel(typed);
      }
      noteError(t("Rename failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }), pane.workspace_id);
    });
  };

  const beginWorkspaceRename = (workspace: WorkspaceInfo): void => {
    setEditingWorkspaceId(workspace.workspace_id);
    setWorkspaceLabel(workspace.label);
  };

  const saveWorkspaceRename = (workspaceId: string): void => {
    const typed = workspaceLabel;
    const label = typed.trim();
    setEditingWorkspaceId(null);
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => {
      // as for a pane: the typed name survives a failed request, for as long as the workspace does
      if (!editorOpen() && snapshotRef.current?.workspaces.some((candidate) => candidate.workspace_id === workspaceId)) {
        setEditingWorkspaceId(workspaceId);
        setWorkspaceLabel(typed);
      }
      noteError(t("Rename failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }), workspaceId);
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
      // only this move's own optimistic order is rolled back: if a later reorder has landed in
      // the meantime, its order is the newer one and reverting to `previous` would undo it
      setWorkspaceOrder((current) => (current.length === next.length && current.every((id, index) => id === next[index]) ? previous : current));
      noteError(t("Reorder failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }));
    });
  };

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string, paneId: string): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
    // dropped on the pane area instead, the row opens its pane in half of it (lib/split.ts)
    event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    const index = dropIndex(sourceId, targetWorkspaceId);
    if (index !== null) reorderWorkspace(sourceId, index);
  };

  // The roster shows groups: a repository's workspace moves past the next or previous group as
  // one (herdr keeps its worktrees packed behind it), and a worktree moves among its siblings.
  // The index herdr gets is the edge of the group the move lands on.
  const moveIndex = (workspaceId: string, direction: -1 | 1): number | null => {
    const groupIndex = worktreeGroups.findIndex((group) => group.workspace.workspace_id === workspaceId);
    if (groupIndex >= 0) {
      const target = worktreeGroups[groupIndex + direction];
      if (!target) return null;
      const edge = direction === 1 ? (target.children[target.children.length - 1] ?? target.workspace) : target.workspace;
      return workspaceOrder.indexOf(edge.workspace_id);
    }
    const parent = worktreeGroups.find((group) => group.children.some((child) => child.workspace_id === workspaceId));
    if (!parent) return null;
    const sibling = parent.children[parent.children.findIndex((child) => child.workspace_id === workspaceId) + direction];
    return sibling ? workspaceOrder.indexOf(sibling.workspace_id) : null;
  };
  const moveVisible = (workspaceId: string, direction: -1 | 1): void => {
    const index = moveIndex(workspaceId, direction);
    if (index !== null) reorderWorkspace(workspaceId, index);
  };

  /** where a dropped workspace lands, in the flat order, or nowhere when the drop crosses a group's edge */
  const dropIndex = (sourceId: string, targetId: string): number | null => {
    const sourceGroup = worktreeGroups.find((group) => group.workspace.workspace_id === sourceId);
    if (sourceGroup) {
      const targetGroup = worktreeGroups.find((group) => group.workspace.workspace_id === targetId || group.children.some((child) => child.workspace_id === targetId));
      if (!targetGroup || targetGroup === sourceGroup) return null;
      const movingDown = workspaceOrder.indexOf(sourceId) < workspaceOrder.indexOf(targetGroup.workspace.workspace_id);
      const edge = movingDown ? (targetGroup.children[targetGroup.children.length - 1] ?? targetGroup.workspace) : targetGroup.workspace;
      return workspaceOrder.indexOf(edge.workspace_id);
    }
    const parent = worktreeGroups.find((group) => group.children.some((child) => child.workspace_id === sourceId));
    return parent && parent.children.some((child) => child.workspace_id === targetId) ? workspaceOrder.indexOf(targetId) : null;
  };

  // a finger's drag lands where the mouse's does: the same groups, the same index for herdr
  const touchHandlers = useRef<Parameters<typeof watchTouchReorder>[1] | null>(null);
  touchHandlers.current = {
    canLift: (id) => editingWorkspaceId !== id && !(editingPaneId !== null && roster.some((pane) => pane.pane_id === editingPaneId && pane.workspace_id === id)),
    onLift: (id) => { setMenu(null); setTouchDrag({ source: id, over: id }); },
    onOver: (id) => setTouchDrag((current) => current && { ...current, over: id }),
    onDrop: (id, target) => {
      setTouchDrag(null);
      const index = target === null || target === id ? null : dropIndex(id, target);
      if (index !== null) reorderWorkspace(id, index);
    },
    onCancel: () => setTouchDrag(null),
  };
  useEffect(() => {
    const root = workspaceRoot.current;
    if (!root) return;
    return watchTouchReorder(root, {
      canLift: (id) => touchHandlers.current?.canLift(id) ?? false,
      onLift: (id) => touchHandlers.current?.onLift(id),
      onOver: (id) => touchHandlers.current?.onOver(id),
      onDrop: (id, target) => touchHandlers.current?.onDrop(id, target),
      onCancel: () => touchHandlers.current?.onCancel(),
    });
  }, []);

  /** where a held row would land, drawn as a line: before or after a row, or after a group's worktrees */
  const dropMark = ((): { id: string; side: "before" | "after"; children: boolean } | null => {
    if (!touchDrag?.over || touchDrag.over === touchDrag.source || dropIndex(touchDrag.source, touchDrag.over) === null) return null;
    const down = workspaceOrder.indexOf(touchDrag.source) < workspaceOrder.indexOf(touchDrag.over);
    const sourceGroup = worktreeGroups.some((group) => group.workspace.workspace_id === touchDrag.source);
    const targetGroup = sourceGroup ? worktreeGroups.find((group) => group.workspace.workspace_id === touchDrag.over || group.children.some((child) => child.workspace_id === touchDrag.over)) : undefined;
    if (targetGroup) {
      const groupDown = workspaceOrder.indexOf(touchDrag.source) < workspaceOrder.indexOf(targetGroup.workspace.workspace_id);
      return { id: targetGroup.workspace.workspace_id, side: groupDown ? "after" : "before", children: groupDown && targetGroup.children.length > 0 };
    }
    return { id: touchDrag.over, side: down ? "after" : "before", children: false };
  })();

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    moveVisible(workspaceId, event.key === "ArrowUp" ? -1 : 1);
  };

  const renderWorkspaceRow = (workspace: WorkspaceInfo, children: WorkspaceInfo[] = [], nested = false, drop?: "before" | "after") => {
    const panes = roster.filter((pane) => pane.workspace_id === workspace.workspace_id);
    if (panes.length === 0) return null;
    const pane = currentPane(workspace, panes);
    const selected = panes.some((candidate) => candidate.pane_id === selectedPaneId);
    const repoKey = workspace.worktree?.repo_key;
    const branch = workspace.worktree?.is_linked_worktree ? branches.get(workspace.workspace_id) : undefined;
    const branchTitle = branch?.branch ?? (branch?.isDetached ? t("Detached HEAD") : null);
    // the row says the workspace's name, the one its owner gave it or herdr made from the branch; the
    // branch itself is the tooltip's and the menu's, where the name does not already say it
    const rowTitle = workspace.label;
    const secondaryBranch = branchTitle && workspace.label !== branchTitle && workspace.label !== worktreeLabel(branchTitle) ? branchTitle : null;
    // the tooltip and the menu keep the exact branch (its slashes) even where the row does not repeat it
    const branchNote = branchTitle && branchTitle !== workspace.label ? branchTitle : null;
    const paths = [...new Set([workspace.worktree?.checkout_path, pane.cwd].filter((path): path is string => Boolean(path)))];
    const collapsed = children.length > 0 && repoKey !== undefined && collapsedWorktrees.has(repoKey);
    // a folded group's parent stands for its worktrees too, as herdr's collapsed parent does:
    // a checkout that waits or has finished must not hide behind the fold
    const statusPanes = collapsed ? [...panes, ...children.flatMap((child) => roster.filter((candidate) => candidate.workspace_id === child.workspace_id))] : panes;
    // on two lines the row says what its pane is doing, and the workspace it has named until now sits under that
    const lines = twoLine ? taskRowLines({ paneTitle: displayPaneTitle(pane), labelled: Boolean(pane.label?.trim()), folder: cwdBasename(pane.cwd), workspace: rowTitle, alias: secondaryBranch }) : null;
    // a folded group still shows the checkout that is open; the count is of the ones put away
    const foldedCount = collapsed ? children.filter((child) => !roster.some((candidate) => candidate.workspace_id === child.workspace_id && candidate.pane_id === selectedPaneId)).length : 0;
    const editingWorkspace = editingWorkspaceId === workspace.workspace_id;
    const editingPane = editingPaneId === pane.pane_id;
    const menuOpen = menu?.workspace.workspace_id === workspace.workspace_id;
    const contentsId = `${rosterId}-worktrees-${encodeURIComponent(repoKey ?? workspace.workspace_id)}`;
    const toggleMenu = (anchor: HTMLElement): void => setMenu(menuOpen ? null : { anchor, workspace, pane, title: rowTitle, place: [branchNote, ...paths].filter(Boolean).join(" · ") || workspace.label });
    return <li
      className={`workspace workspace-group pane-item${selected ? " is-selected" : ""}${collapsed ? " is-collapsed" : ""}${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}${touchDrag?.source === workspace.workspace_id ? " is-lifted" : ""}`}
      key={workspace.workspace_id}
      data-workspace={workspace.workspace_id}
      data-branch={branchTitle ?? undefined}
      data-drop={drop}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => onDrop(event, workspace.workspace_id)}
    >
      <div className="workspace-header" onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
        {/* a workspace leads with its folder, which is the fold when linked worktrees sit under it */}
        {nested ? null : children.length > 0 && repoKey !== undefined ? <button
          type="button"
          className="sidebar-row-action workspace-toggle"
          aria-label={collapsed ? t("Expand worktrees of {name}", { name: workspace.label }) : t("Collapse worktrees of {name}", { name: workspace.label })}
          title={collapsed ? t("Expand worktrees of {name}", { name: workspace.label }) : t("Collapse worktrees of {name}", { name: workspace.label })}
          aria-expanded={!collapsed}
          aria-controls={contentsId}
          onClick={() => setWorktreeCollapsed(repoKey, !collapsed)}
        >{collapsed ? <Folder aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}</button> : <span className="sidebar-mark workspace-folder" aria-hidden="true"><Folder /></span>}
        <div
          className="pane-select workspace-select"
          role="button"
          tabIndex={0}
          draggable={!coarsePointer && !editingWorkspace && !editingPane}
          onDragStart={(event) => { if (!editingWorkspace && !editingPane) onDragStart(event, workspace.workspace_id, pane.pane_id); }}
          onDragEnd={() => setDragWorkspaceId(null)}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          aria-description={`${t("Reorder workspace {name}", { name: workspace.label })} · ${t("Drag to reorder · Alt+↑/↓")}`}
          data-pane={pane.pane_id}
          aria-current={selected ? "true" : undefined}
          title={[`${pane.pane_id} — ${rowTitle}`, branchNote, ...paths, paneTitle(pane), agentsTitle(workspace)].filter(Boolean).join(" — ")}
          onClick={() => actions.selectPane(pane.pane_id)}
          onKeyDown={(event) => {
            onRowKeyDown(event, workspace.workspace_id);
            if (event.defaultPrevented) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            actions.selectPane(pane.pane_id);
          }}
        >
          {rowMark(pane, workspace.worktree?.is_linked_worktree === true)}
          {editingWorkspace ? <input
            className="input workspace-rename-input"
            aria-label={t("Workspace name")}
            autoFocus
            value={workspaceLabel}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setWorkspaceLabel(event.target.value)}
            onBlur={() => setEditingWorkspaceId(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id);
              if (event.key === "Escape") setEditingWorkspaceId(null);
            }}
          /> : editingPane ? <input
            className="input pane-rename-input"
            aria-label={t("Pane name")}
            autoFocus
            value={paneLabel}
            placeholder={displayPaneTitle(pane)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setPaneLabel(event.target.value)}
            onBlur={() => setEditingPaneId(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") savePaneRename(pane);
              if (event.key === "Escape") setEditingPaneId(null);
            }}
          /> : lines ? <span className="workspace-copy is-two-line">
            <span className="workspace-line">
              <span className="workspace-name">{lines.title}</span>
              {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
            </span>
            {lines.place && <span className="workspace-place">{lines.place}</span>}
          </span> : <span className="workspace-copy">
            <span className="workspace-name">{rowTitle}</span>
            {secondaryBranch && <span className="worktree-workspace-label">{secondaryBranch}</span>}
            {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
          </span>}
          <span className="sidebar-pane-meta">
            <span className="visually-hidden">{markName(pane)}</span>
            {online && pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge compact status={online ? rollupStatus(statusPanes.map((candidate) => activity.status(machineId, candidate))) : undefined} />}
          </span>
        </div>
        <div className="workspace-actions">
          <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: rowTitle })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
      </div>
      {inlineError?.workspaceId === workspace.workspace_id && <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>}
    </li>;
  };

  return (
    <div className={`machine-workspaces${twoLine ? " is-two-line" : ""}`} ref={workspaceRoot}>
      <nav className="sidebar-list" aria-label={t("Herdr workspaces")}>
        <>
          {!snapshot && <p className="tree-state" role="status">{t("Loading workspaces…")}</p>}
          {snapshot && snapshot.workspaces.length === 0 && (
            <div className="tree-state-empty">
              <p className="tree-state" role="status">{t("No workspaces yet")}</p>
              <button type="button" className="btn" onClick={actions.openNewSession}><Plus aria-hidden="true" />{t("New workspace")}</button>
            </div>
          )}
          <ul className="workspace-list">{worktreeGroups.map(({ workspace, children }) => {
            const childrenHidden = collapsedWorktrees.has(workspace.worktree?.repo_key ?? "") && !children.some((child) => roster.some((pane) => pane.workspace_id === child.workspace_id && pane.pane_id === selectedPaneId));
            // a group moved below this one lands after its worktrees, and the line says so
            const afterChildren = dropMark?.id === workspace.workspace_id && dropMark.children;
            return <Fragment key={workspace.workspace_id}>
              {renderWorkspaceRow(workspace, children, false, dropMark?.id === workspace.workspace_id && (!dropMark.children || childrenHidden) ? dropMark.side : undefined)}
              {children.length > 0 && <li
                className="worktree-children"
                id={`${rosterId}-worktrees-${encodeURIComponent(workspace.worktree!.repo_key)}`}
                hidden={childrenHidden}
                data-drop={afterChildren && !childrenHidden ? "after" : undefined}
              ><ul className="workspace-list">
                {children.filter((child) => !collapsedWorktrees.has(workspace.worktree!.repo_key) || roster.some((pane) => pane.workspace_id === child.workspace_id && pane.pane_id === selectedPaneId)).map((child) => renderWorkspaceRow(child, [], true, dropMark?.id === child.workspace_id ? dropMark.side : undefined))}
              </ul></li>}
            </Fragment>;
          })}</ul>
          {inlineError && inlineError.workspaceId === undefined && (
            <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>
          )}
        </>
      </nav>
      {menu && <RowMenu anchor={menu.anchor} title={menu.title} subtitle={menu.place} items={menuItems(menu)} onClose={closeMenu} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={confirm.action ?? t("Close")} onConfirm={confirm.run} escalation={confirm.escalation} onClose={() => setConfirm(null)} />}
      {worktreeDialog && <WorktreeDialog mode={worktreeDialog.mode} workspace={worktreeDialog.workspace} onClose={() => setWorktreeDialog(null)} onOpened={(opened) => {
        rememberOpened(opened);
        revealOpenedWorkspace.current = opened.workspace_id;
        const repoKey = worktreeDialog.workspace.worktree?.repo_key;
        if (repoKey) setWorktreeCollapsed(repoKey, false);
        setWorktreeDialog(null);
        actions.selectPane(opened.pane_id);
      }} />}
    </div>
  );
}
