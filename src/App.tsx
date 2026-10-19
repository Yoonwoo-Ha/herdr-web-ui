import { type CSSProperties, type DragEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bell, Ellipsis, FolderOpen, Link, Menu, MessageSquare, PanelLeft, Search, SquareTerminal, X } from "lucide-react";

import type { AgentStatus, ServerMessage, AccessRefusal, HealthAuth, HerdrPane } from "../shared/protocol.ts";
import { ApiError, authenticate, createTab, fetchHealth, fetchBridgeHealth, fetchMachines, fetchSession, pairDevice, routeMissing, sendTestPush, signOut, splitPane, zoomPane, type HealthInfo } from "./lib/api.ts";
import { deviceLabel, takePairCode } from "./lib/phone.ts";
import { alertPaneTitle, displayPaneTitle } from "./components/Sidebar.tsx";
import { PaneCanvas } from "./components/PaneCanvas.tsx";
import { MachineSessionsProvider } from "./lib/machineSessionContext.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { paneCovered, paneContentKey, paneContentPresented } from "./lib/panePresentation.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "./lib/paneRegion.ts";
import { worktreeRepoName } from "./lib/composerStrip.ts";
import { AccessGate } from "./components/AccessGate.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import { NewSessionDialog, type NewTabTarget } from "./components/NewSessionDialog.tsx";
import { passingFolder, recentDirectories } from "./lib/recent-directories.ts";
import { usePreferencesSync } from "./lib/preferencesSync.ts";
import { TabStrip } from "./components/TabStrip.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { loadedOnSettingsEntry, onSettingsHistory, recordSettings, settingsEntry } from "./lib/settingsHistory.ts";
import { sheetSteppedOff } from "./lib/sheetHistory.ts";
import { fileFromLink, isNavigation, linkSearch, linksSomewhere, NAV_KEY, readLink, resolveLink, slugOf, type AppLink, type CreateDraft, type LinkNote } from "./lib/deepLink.ts";
import { copyText } from "./lib/clipboard.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { paletteOpenQuery } from "./lib/paletteSeed.ts";
import { MachineContext } from "./lib/machineContext.tsx";
import { MachineActionBanner, MachineSidebar } from "./components/MachineSidebar.tsx";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { storedSidebarWidth } from "./lib/sidebarWidth.ts";
import { FilePanelResizer } from "./components/FilePanelResizer.tsx";
import { FILE_PANEL_DOCK_QUERY, storedFilePanelWidth } from "./lib/filePanelWidth.ts";
import { openPresentation, type FilePresentation } from "./lib/filePresentation.ts";
import { MachineDialog } from "./components/MachineDialog.tsx";
import { RowMenu, type RowMenuItem } from "./components/RowMenu.tsx";
import { focusWorkspaceListToggle } from "./lib/focus.ts";
import { headerCrumb, showsChat } from "./lib/headerCrumb.ts";
import { LOCAL_MACHINE, paneStorageId, type Machine, type MachineEvent } from "../shared/machines.ts";
import { takeAuthTokenFromUrl } from "./lib/authLink.ts";
import { applyPaneStatus } from "./lib/snapshot.ts";
import { setAgentRowTokens } from "./lib/agentRowTokens.ts";
import { rosterPanes } from "./lib/dagPane.ts";
import { SnapshotRequests } from "./lib/snapshotRequests.ts";
import { alertPrefs, useSettings } from "./lib/settings.ts";
import { formatKeys, shortcutDisplayKeys, useShortcuts } from "./lib/shortcuts.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import { useAnnouncedText } from "./lib/useAnnouncedText.ts";
import { PaneLenses } from "./lib/paneLens.ts";
import { paneContextPress } from "./lib/paneCanvas.ts";
import type { AppActions, PaneView, PaneControls } from "./lib/actions.ts";
import {
  notificationState,
  requestNotificationPermission,
  shouldNotifyStatus,
  alertStatus,
  alertsAllow,
  showPaneEndedNotification,
  showPaneStatusNotification,
  type NotificationState,
} from "./lib/notifications.ts";
import { ensurePushSubscription, pushSupported, removePushSubscription } from "./lib/push.ts";
import { machineGone, notificationLanding, notificationTargetFromSearch, sameLink, notificationViewForPane, onNotificationTarget, type NotificationTarget } from "./lib/notificationTarget.ts";
import { useUpdates } from "./lib/updates.ts";
import { UpdateNotice } from "./components/UpdateControls.tsx";
import { LanExposureNotice } from "./components/LanExposureNotice.tsx";
import { TelemetryNotice } from "./components/TelemetryControls.tsx";
import { FilesDialog } from "./components/FilesDialog.tsx";
import { folderQueryFor } from "./lib/paletteFolders.ts";
import { FileViewer } from "./components/FileViewer.tsx";
import { WebPanel } from "./components/WebPanel.tsx";
import { panelUrl, WebPanelContext, wantsPanel } from "./lib/webPanel.ts";
import { RepoDiffViewer } from "./components/RepoDiffViewer.tsx";
import { OpenFileContext } from "./lib/filePaths.ts";
import { useFileViewer } from "./lib/useFileViewer.ts";
import { useFocusReturn } from "./lib/useFocusTrap.ts";
import { useRepoDiffViewer } from "./lib/useRepoDiffViewer.ts";
import { useT } from "./lib/i18n.ts";
import { markSelection, selectionStill, type SelectionMark } from "./lib/selectionMark.ts";
import { useScreenWakeLock } from "./lib/wakeLock.ts";
import { watchDrawerSwipe } from "./lib/edgeSwipe.ts";
import { Droplet } from "./components/Droplet.tsx";
import { dropletAllows, endedTurn, seedStatuses, showDroplet, trackTurn, type DropletKind } from "./lib/droplet.ts";
import { canPlayAlertSound, playAlertSound, unlockAlertSound, type AlertSoundKind } from "./lib/alertSound.ts";
import { createAlertTurnPlayer } from "./lib/alertTurns.ts";
import { dockPane, draggedPane, paneDragData, dropSide, otherSlot, PANE_DRAG_TYPE, sameTarget, slotSide, storedSplit, storeSplit, type SplitSide, type SplitSlot, type SplitState, type SplitTarget } from "./lib/split.ts";
import { paneDrag } from "./lib/paneDrag.ts";
import { PaneFollowContext } from "./lib/paneSubmitContext.ts";
import { SplitDropPreview } from "./components/SplitDropPreview.tsx";
import { CrashProbe, RegionCrash } from "./components/AppCrash.tsx";
import { RenderBoundary } from "./components/RenderBoundary.tsx";

const APP_TITLE = "herdr web ui";
/** how soon after a key press a focus counts as the user's own (lastKeyAtRef) */
const KEY_FOCUS_MS = 1000;
const POLL_MS = 5000;

/**
 * Polls and the event stream hand over fresh objects every few seconds even when nothing
 * changed; storing them re-rendered the whole app (the chat transcript included) each time.
 */
function sameData(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
/** trailing debounce for push-triggered refetches: bursts of events become one fetch */
const REFETCH_DEBOUNCE_MS = 500;

const SELECTION_KEY = "herdr-web-ui:selection";
type StoredSelection = { machine_id?: string; pane_id?: string | null };

/**
 * The pane to open: this window's own (sessionStorage is per window and survives
 * its reloads), else the last one any window showed, for a newly opened window.
 */
function storedSelection(): StoredSelection | null {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try {
      const value: unknown = JSON.parse(window[storage].getItem(SELECTION_KEY) ?? "null");
      if (value !== null && typeof value === "object") return value as StoredSelection;
    } catch {
      /* private mode */
    }
  }
  return null;
}

function storeSelection(machineId: string, paneId: string | null): void {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try { window[storage].setItem(SELECTION_KEY, JSON.stringify({ machine_id: machineId, pane_id: paneId })); } catch {}
  }
}

/**
 * The lens a pane opens in: the one picked for it by hand, remembered per pane, else its default
 * (lib/paneLens.ts), kept for the page once the pane is known so an agent starting or exiting in
 * it does not switch the lens under the user. A PC whose herdr has no terminal attach and no
 * mirror either (an older Windows bridge) always opens its chat: its terminal lens is only a
 * notice, so a remembered choice there is not worth keeping. A mirrored PC counts as having a
 * terminal.
 */
/** `hasAgent`: herdr leaves `agent` out for a shell, so callers compare with `!= null` */
function storedView(lenses: PaneLenses, picks: ReadonlyMap<string, PaneView>, paneId: string, machineId: string, hasAgent: boolean | null, terminalAttach: boolean): PaneView {
  if (!terminalAttach) return "chat";
  const key = paneStorageId(machineId, paneId);
  const picked = picks.get(key);
  if (picked !== undefined) return picked;
  try {
    const stored = window.localStorage.getItem(`herdr-web-ui:view:${key}`);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {
    /* private mode */
  }
  return lenses.of(key, hasAgent, window.matchMedia?.("(pointer: coarse)").matches === true);
}

/** Slot b of the split draws on connections of its own: both halves may attach one tab, and each
 *  attaches and detaches it as the other is not there (lib/split.ts). */
function SlotSessions({ slot, machineIds, children }: { slot: SplitSlot; machineIds: readonly string[]; children: ReactNode }) {
  return slot === "b" ? <MachineSessionsProvider machineIds={machineIds}>{children}</MachineSessionsProvider> : <>{children}</>;
}

/** The header's note. Its status is in the header from the header's first render, clipped while empty
    (never display: none, as the connection chip), and its words land a frame after the box, even the
    ones a page opens with (lib/useAnnouncedText.ts). Its sentence is cut like the title it stands in
    for, under its own class: only the pane title carries .context-title-text, which the browser
    checks measure (scripts/mobile-tabs-regression.ts). */
function HeaderNote({ note }: { note: string | null }) {
  const shown = useAnnouncedText(note);
  return (
    <div className={shown === null ? "visually-hidden" : "context"}>
      <span className={shown === null ? undefined : "pill header-note"} role="status" style={{ minWidth: 0 }}>
        <span className="header-note-text">{shown}</span>
      </span>
    </div>
  );
}

/** The connecting shell's one sidebar line: the same announced status as every other (lib/useAnnouncedText.ts). */
function ConnectingNote() {
  const t = useT();
  const shown = useAnnouncedText(t("Connecting…"));
  return <p className={shown === null ? "visually-hidden" : "tree-state"} role="status">{shown}</p>;
}

/** The header's connection chip. It speaks only while the bridge is not live; live, it stays in the document
    for a screen reader (and the browser scripts that wait on it), drawn by nothing (styles.css). Its word lands
    a frame after the chip (lib/useAnnouncedText.ts), as every status line's does. */
function ConnectionChip({ connected, word, title }: { connected: boolean; word: string; title: string | undefined }) {
  const shown = useAnnouncedText(word);
  return (
    <span className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`} role="status" title={title}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{shown}</span>
    </span>
  );
}

function Brand() {
  return (
    <h1 className="brand">
      <img src="/icons/icon-192.png?v=ram1" alt="" width="22" height="22" className="brand-mark" />
      <span className="brand-name">
        herdr <span className="brand-sub">web ui</span>
      </span>
    </h1>
  );
}

export function App() {
  const t = useT();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const { settings, resolvedTheme, resolvedEntry, update: updateSettings } = useSettings();
  // this device's alert choices: sent with its push subscription, and applied to tab alerts here
  const alerts = useMemo(() => alertPrefs(settings), [settings.alertInput, settings.alertDone]);
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  // the Alerts item's switch for this device (the header's More menu): off drops its push subscription and silences tab and in-app alerts
  const alertsOn = settings.alertsOn;
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineRosterLoaded, setMachineRosterLoaded] = useState(false);
  // the place the address names, read once at load: a link wins over this window's last selection
  const [initialLink] = useState(() => {
    // a link's lens is drawn over its pane's own, as a tapped notification's is (notificationViewTarget below)
    if (!linksSomewhere(window.location.search)) return null;
    const link = readLink(window.location.search);
    // a load onto an entry Settings left (a reload) steps out of it (lib/settingsHistory.ts): the
    // dialog its address names, on that entry or on the one stepped back to, is the one it closed
    return loadedOnSettingsEntry() ? { ...link, settings: null, section: null } : link;
  });
  // New workspace's recent folders also know where a PC's panes are: kept behind the folders started in
  useEffect(() => {
    for (const machine of machines) {
      if (machine.state !== "connected" || !machine.snapshot) continue;
      // a worktree's checkout or a temporary folder is no project to start a workspace in
      const linked = machine.snapshot.workspaces.filter((workspace) => workspace.worktree?.is_linked_worktree);
      const inLinked = new Set(linked.map((workspace) => workspace.workspace_id));
      const worktrees = linked.map((workspace) => workspace.worktree!.checkout_path);
      recentDirectories.remember(machine.id, machine.snapshot.panes
        .filter((pane) => !pane.restore_error && !inLinked.has(pane.workspace_id) && !(pane.cwd && passingFolder(pane.cwd, worktrees)))
        .map((pane) => pane.cwd).reverse());
    }
  }, [machines]);
  const [selectedMachineId, setSelectedMachineId] = useState(() => {
    if (initialLink && (initialLink.pane || initialLink.workspace || fileFromLink(initialLink))) return initialLink.machine;
    return storedSelection()?.machine_id ?? "local";
  });
  const selectedMachine = machines.find((m) => m.id === selectedMachineId);
  const snapshot = selectedMachine?.snapshot ?? null;
  const machinesRef = useRef(machines); machinesRef.current = machines;
  const [updateRemote, setUpdateRemote] = useState(false);
  const [machineDialog, setMachineDialog] = useState<Machine | "new" | null>(null);
  // Add PC from Settings or the palette leaves no trigger to return focus to once its dialog
  // closes (Settings closed when it opened): the header's workspace-list toggle stands in
  const addPcFocusReturn = useRef(false);
  const closeMachineDialog = useCallback(() => {
    setMachineDialog(null);
    if (!addPcFocusReturn.current) return;
    addPcFocusReturn.current = false;
    focusWorkspaceListToggle();
  }, []);
  const [newSessionMachineId, setNewSessionMachineId] = useState("local");
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a palette layout call a PC's bridge could not take: a line over the pane, gone after a moment as the tab strip's is
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!layoutNotice) return;
    const timer = window.setTimeout(() => setLayoutNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [layoutNotice]);
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockReason, setLockReason] = useState<AccessRefusal | null>(null);
  /** the code a scanned QR brought along (`?pair=CODE`), taken off the address at once */
  const [pairCode] = useState(() => takePairCode());
  const [auth, setAuth] = useState<HealthAuth | null>(null);
  // a token a proxy sends with every request comes back right after signing out: signing out is the proxy's
  const canSignOut = auth?.authenticated === true && (auth.via === "device" || (auth.via === "token" && auth.bearer !== true));
  // a device that is in only because nothing is paired yet still pairs from the QR code's address
  const pairedFromAddress = useRef(false);
  useEffect(() => {
    if (locked !== false || pairCode === "" || pairedFromAddress.current || auth?.via === "device") return;
    pairedFromAddress.current = true;
    pairDevice(pairCode, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)).then(() => loadHealth()).catch(() => { /* the gate, if any, reports it */ });
  }, [locked, pairCode, auth]); // eslint-disable-line react-hooks/exhaustive-deps
  const updates = useUpdates(locked === false);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(() => {
    if (initialLink?.pane) return initialLink.pane;
    // a link to a workspace opens the pane its row opens, once the roster is in (below)
    if (initialLink && (initialLink.workspace || fileFromLink(initialLink))) return null;
    return storedSelection()?.pane_id ?? null;
  });
  const [notificationViewTarget, setNotificationViewTarget] = useState<NotificationTarget | null>(
    () => notificationTargetFromSearch(window.location.search),
  );
  // the place a link named, settled against the PC's roster once it is in (lib/deepLink.ts resolveLink)
  const pendingLink = useRef<AppLink | null>(initialLink && (initialLink.pane || initialLink.workspace || fileFromLink(initialLink)) ? initialLink : null);
  // state, not only the ref: what waits on the link landing (the address, its file) runs again when it does
  const [linkLanded, setLinkLanded] = useState(() => pendingLink.current === null);
  // A PC is gone only by a roster the server sent after it was named (lib/notificationTarget.ts
  // machineGone): the count of rosters in, and the count when the pending link and the selection
  // were made (a remembered selection: 0, so the first roster checks it)
  const rosterSeq = useRef(0);
  const linkSince = useRef(0);
  const selectionSince = useRef(0);
  // the checks run again on a roster that came in while a link waits (the same list, kept as it
  // was, changes nothing they watch), and on a link a tap set (its pane may be the one selected)
  const [rosterTick, setRosterTick] = useState(0);
  const [linkTick, setLinkTick] = useState(0);
  // a split half whose pane the PC could not be asked about is checked again on the next roster
  const otherRecheck = useRef(false);
  const [otherRosterTick, setOtherRosterTick] = useState(0);
  const rosterIn = useCallback((): void => {
    rosterSeq.current += 1;
    if (pendingLink.current !== null) setRosterTick(rosterSeq.current);
    if (otherRecheck.current) { otherRecheck.current = false; setOtherRosterTick(rosterSeq.current); }
  }, []);
  // the file a link named, opened over its pane once that pane is shown
  const pendingFile = useRef<string | null>(initialLink ? fileFromLink(initialLink) : null);
  // the workspace a tapped alert named for the pane it selected at once: a roster in hand may
  // still list a pane that has ended (a phone resumed from the background), and when the next
  // one drops it, that workspace opens with a word, as a link's does. Any other pick clears it.
  const selectionHint = useRef<{ machine: string; pane: string; workspace: string } | null>(null);
  // a short word in the header: a link that could not open what it named, or a link copied
  const [headerNote, setHeaderNote] = useState<LinkNote | "copied" | null>(null);
  useEffect(() => {
    if (headerNote === null) return;
    const timer = window.setTimeout(() => setHeaderNote(null), headerNote === "copied" ? 1600 : 8000);
    return () => window.clearTimeout(timer);
  }, [headerNote]);
  // the note that stands where the title does: a link that could not open what it named or was
  // copied, or a link waiting for its PC's roster before it can open what it named (HeaderNote)
  const note = headerNote
    ? t(headerNote === "copied" ? "Link copied" : headerNote === "pane-closed" ? "That agent has closed: its workspace is open" : headerNote === "machine-missing" ? "That link's PC is not set up here" : "That link's workspace is closed")
    : !linkLanded ? t("Opening link…") : null;
  // App picked the selected pane itself because the one selected closed: it must not raise a
  // phone's keyboard (over the drawer the close was tapped in) until the user picks a pane or lens
  const [autoSelected, setAutoSelected] = useState(false);
  // a phone opened by a link that says so starts with its drawer out (lib/deepLink.ts)
  const [drawerOpen, setDrawerOpen] = useState(() => initialLink?.sidebar === "shown" && window.matchMedia?.("(min-width: 769px)").matches !== true);
  const drawerOpenRef = useRef(drawerOpen); drawerOpenRef.current = drawerOpen;
  // from 769px the drawer is a plain sidebar column and its toggle is hidden, so a drawer a
  // narrow window opened must not come back (with its scrim) the next time the window narrows
  const wideScreen = useMediaQuery("(min-width: 769px)");
  useEffect(() => { if (wideScreen) setDrawerOpen(false); }, [wideScreen]);
  // with a generation (lib/selectionMark.ts): a call that answers after the user opened another pane or PC leaves
  // the selection alone. Marked at commit, not in render: a render React throws away (Strict Mode, a replay)
  // must not move the generation on, and every reader runs from an event or a reply, after the commit
  const selectionRef = useRef<SelectionMark>({ machineId: selectedMachineId, paneId: selectedPaneId, generation: 0 });
  useLayoutEffect(() => {
    selectionRef.current = markSelection(selectionRef.current, selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);
  // on a phone the drawer follows a swipe in from the left edge, and a swipe back (lib/edgeSwipe.ts)
  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen), []);
  // Escape puts the open drawer away and goes no further: in the capture phase, so a terminal that kept the
  // focus never receives it. A dialog or an IME composition on top keeps its own Escape
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !drawerOpenRef.current || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, []);
  // a desktop opened by a link that says so starts with the sidebar collapsed, and the address says so while it is
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialLink?.sidebar === "hidden");
  // the width the sidebar's edge was dragged to on this device; null is the density's own
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const filePanelAvailable = useMediaQuery(FILE_PANEL_DOCK_QUERY);
  const [filePanelWidth, setFilePanelWidth] = useState(storedFilePanelWidth);
  const [lens, setLens] = useState<{ key: string; view: PaneView }>({ key: "", view: "terminal" });
  // Explicit lens choices stay authoritative in this page even when storage cannot be written.
  const [viewPicks, setViewPicks] = useState<ReadonlyMap<string, PaneView>>(() => new Map());
  // two tabs side by side (lib/split.ts): the other half's pane, its side, and the active slot.
  // Only drawn where the sidebar stands beside the pane; a narrower window shows the active half
  const [split, setSplitState] = useState<SplitState | null>(storedSplit);
  const setSplit = useCallback((next: SplitState | null) => {
    setSplitState(next);
    storeSplit(next);
  }, []);
  // the slot a single pane is drawn in: the half left when a split ends keeps its slot, and with it
  // its terminals' connections and the messages those connections hold for the agent
  const [soloSlot, setSoloSlot] = useState<SplitSlot>(() => storedSplit()?.active ?? "a");
  const endSplit = useCallback((remaining: SplitSlot) => {
    setSplit(null);
    setSoloSlot(remaining);
  }, [setSplit]);
  const splitRef = useRef(split); splitRef.current = split;
  // whether the other half is drawn: a narrow window keeps the split but shows the active half alone
  const splitShownRef = useRef(false);
  // when a key was last pressed: a focus moving into the other half makes it active only right after
  // one (a Tab), never when the app's own code moves the focus (an upload that finished)
  const lastKeyAtRef = useRef(0);
  useEffect(() => {
    const onKey = (): void => { lastKeyAtRef.current = Date.now(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // the guide appears as soon as a pane is picked up; a target is chosen only over the area
  const [paneDragging, setPaneDragging] = useState(false);
  const [dropAt, setDropAt] = useState<SplitSide | null>(null);
  const dropAtRef = useRef<SplitSide | null>(null);
  const showDropTarget = useCallback((side: SplitSide | null): void => {
    dropAtRef.current = side;
    setDropAt(side);
  }, []);
  const clearDropPreview = useCallback((): void => {
    setPaneDragging(false);
    showDropTarget(null);
  }, [showDropTarget]);
  const paneAreaRef = useRef<HTMLDivElement>(null);
  // a tab dragged out of its strip (lib/paneDrag.ts)
  const tabDrag = useSyncExternalStore(paneDrag.subscribe, paneDrag.snapshot);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const openPalette = useCallback((query?: unknown) => { setPaletteQuery(paletteOpenQuery(query)); setPaletteOpen(true); }, []);
  const paneControls = useRef<PaneControls | null>(null);
  const [findRequest, setFindRequest] = useState<{ paneId: string | null; serial: number }>({ paneId: null, serial: 0 });
  // the header's More menu: its button
  const [more, setMore] = useState<{ anchor: HTMLElement } | null>(null);
  const closeMore = useCallback(() => setMore(null), []);
  // the pane canvas's actions, for the phone's tab menu (TabStrip)
  const paneActionsRef = useRef<((target: HerdrPane) => RowMenuItem[]) | null>(null);
  // the Files dialog, and the file open in the viewer (a path as the chat or the dialog gave it)
  const [filesOpen, setFilesOpen] = useState(false);
  const { viewing, openFile, closeFile, setPresentation, releaseFile } = useFileViewer();
  // a repository diff from the Files dialog's Changes tab, an entry of its own like a file
  const { viewing: diffViewing, openDiff, closeDiff, releaseDiff } = useRepoDiffViewer();
  const presentation = viewing?.presentation ?? openPresentation(viewing?.path ?? "", settings.fileOpen);
  const fileDocked = filePanelAvailable && presentation === "panel";
  useEffect(() => {
    if (viewing !== null && fileDocked) setFilesOpen(false);
  }, [viewing, fileDocked]);
  // a page this PC serves, beside the pane in the file panel's place: a file docked there replaces it
  const [webPage, setWebPage] = useState<string | null>(null);
  useEffect(() => {
    if (viewing !== null && fileDocked) setWebPage(null);
  }, [viewing, fileDocked]);
  const openWebPage = useCallback((uri: string, shiftKey: boolean, machineId: string) => {
    if (machineId !== LOCAL_MACHINE || !wantsPanel(settings.webLinks, shiftKey)) return false;
    const url = panelUrl(uri, window.location);
    if (url === null) return false;
    if (viewing !== null && fileDocked) closeFile();
    setWebPage(url);
    return true;
  }, [settings.webLinks, viewing, fileDocked, closeFile]);
  // the panel is no dialog, so no trap gives the focus back when it closes: what opened the file
  // (a link in the chat, a row of Files) gets it, as it does from the popup
  useFocusReturn(viewing !== null && fileDocked);
  // a collapse (below) whose two steps back have not landed: a second click on Show beside the
  // pane, or the kind correction in the same moment, must not queue two steps more and the file twice
  const collapsing = useRef(false);
  // a collapse whose step back never lands must not lock the toggle once the file and diff are gone
  useEffect(() => { if (viewing === null && diffViewing === null) collapsing.current = false; }, [viewing, diffViewing]);
  const presentFile = useCallback((next: FilePresentation) => {
    if (collapsing.current) return;
    if (next === "panel" && filePanelAvailable && diffViewing !== null && viewing !== null) {
      // Collapse the stacked diff and popup to one panel entry. Pushing from their opener
      // also discards the old forward entries, so Forward cannot resurrect the popup or diff.
      const preview = { ...viewing, presentation: next };
      collapsing.current = true;
      window.addEventListener("popstate", () => {
        collapsing.current = false;
        releaseDiff();
        openFile(preview);
      }, { once: true });
      window.history.go(-2);
    } else setPresentation(next);
  }, [filePanelAvailable, diffViewing, viewing, releaseDiff, openFile, setPresentation]);
  // the kind corrects a guess from the extension; with files set to open in the popup there is no guess to correct
  const reportFileKind = useCallback((kind: FilePresentation) => {
    const wanted = settings.fileOpen === "panel" ? kind : "popup";
    if (viewing !== null && viewing.presentation === undefined && wanted !== openPresentation(viewing.path, settings.fileOpen)) presentFile(wanted);
  }, [viewing, presentFile, settings.fileOpen]);
  const toggleFilePresentation = filePanelAvailable && viewing !== null
    ? () => presentFile(fileDocked ? "popup" : "panel")
    : undefined;
  const viewFile = useCallback((path: string) => {
    // the Files dialog would cover the docked panel the file opens in
    if (filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel") setFilesOpen(false);
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId, filePanelAvailable, settings.fileOpen]);
  // a link to Settings opens it on its page, for that first opening alone
  const [settingsOpen, setSettingsOpen] = useState(() => initialLink?.settings != null);
  const [settingsLinkPage, setSettingsLinkPage] = useState<string | null>(() => initialLink?.settings ?? null);
  // the group on that page a link named: in the address while that page is shown
  const [settingsLinkSection, setSettingsLinkSection] = useState<string | null>(() => initialLink?.section ?? null);
  // the page Settings shows, for the address
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  // set by a button that points at one section of Settings, for that opening alone
  const [settingsSection, setSettingsSection] = useState<"updates" | null>(null);
  const closeSettings = useCallback(() => { setSettingsOpen(false); setSettingsSection(null); setSettingsLinkPage(null); setSettingsLinkSection(null); setSettingsPage(null); }, []);
  const settingsLinkPageRef = useRef(settingsLinkPage); settingsLinkPageRef.current = settingsLinkPage;
  const onSettingsPage = useCallback((page: string | null) => {
    setSettingsPage(page);
    if (page !== settingsLinkPageRef.current) setSettingsLinkSection(null);
  }, []);
  // Settings is in the history (lib/settingsHistory.ts): Back out of its last entry closes it,
  // Forward onto one opens it again, and closing it any other way takes its entries off
  useEffect(() => onSettingsHistory((entry, own) => {
    if (own) return;
    if (entry === null) closeSettings();
    else setSettingsOpen(true);
  }), [closeSettings]);
  useEffect(() => { if (!settingsOpen) recordSettings([]); }, [settingsOpen]);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // the New workspace dialog in the address (lib/deepLink.ts): the fields a link filled for this
  // opening, and what the fields say now
  const [newPrefill, setNewPrefill] = useState<Omit<CreateDraft, "kind"> | null>(null);
  const [newFields, setNewFields] = useState<Omit<CreateDraft, "kind"> | null>(null);
  // a link to the dialog, opened once the PCs are in (a tab, once its workspace is found)
  const pendingCreate = useRef<CreateDraft | null>(initialLink?.create ?? null);
  // the dialog makes a tab in this workspace instead of a workspace, while set
  const [newTab, setNewTab] = useState<NewTabTarget | null>(null);
  const [connected, setConnected] = useState(false);
  /** the active terminal's socket has been connected on this page before (PaneTerminal reports it): not
   *  connected, the chip says reconnecting; before this page's first connection to the PC, connecting */
  const [connectedBefore, setConnectedBefore] = useState(false);
  // the active slot's pane could not be drawn: no terminal is attached there to say so itself
  const paneLost = useCallback(() => setConnected(false), []);
  const [outputStopped, setOutputStopped] = useState(false);
  const [notifications, setNotifications] = useState<NotificationState>(() => notificationState());
  // this device has a server-side push subscription: alerts come from the server, not the tab
  const [pushOn, setPushOn] = useState(false);
  const pushOnRef = useRef(pushOn);
  pushOnRef.current = pushOn;
  // the shared settings and pins, the same in every browser of this server, once the app is in
  const { receive: receivePreferences, saveError: settingsSaveError } = usePreferencesSync(locked === false);
  const receivePreferencesRef = useRef(receivePreferences); receivePreferencesRef.current = receivePreferences;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // last-seen agent status per pane: the baseline that decides whether a push is news
  const statusRef = useRef<Map<string, AgentStatus>>(new Map());
  // when each pane's turn began, so an in-app alert knows a long turn from a quick one
  const turnStartRef = useRef<Map<string, number>>(new Map());
  // how long each pane's last finished turn took: a pane that ends is told by it too
  const lastTurnRef = useRef<Map<string, number>>(new Map());
  const alertInAppRef = useRef(settings.alertInApp);
  alertInAppRef.current = settings.alertInApp;
  const alertSoundRef = useRef(settings.alertSound);
  alertSoundRef.current = settings.alertSound;
  const refetchTimer = useRef<number | null>(null);
  const snapshotRef = useRef<typeof snapshot>(null);
  snapshotRef.current = snapshot;

  const loadHealth = useCallback(async () => {
    try { const next = await fetchBridgeHealth(); setLocked(next.auth.required && !next.auth.authenticated); setLockReason(next.auth.reason ?? null); setAuth(next.auth); }
    catch { /* retain the gate while the connection server restarts */ }
    try { const next = await fetchHealth(); setHealth((previous) => sameData(previous, next) ? previous : next); } catch { setHealth(null); }
  }, []);
  const snapshotRequests = useRef(new SnapshotRequests());
  const load = useCallback(async () => {
    try {
      await snapshotRequests.current.read(fetchMachines, (next) => {
        setMachines((previous) => sameData(previous, next) ? previous : next);
        rosterIn();
        setMachineRosterLoaded(true);
        setError(null); setLocked(false);
      });
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) { setLocked(true); return; }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rosterIn]);

  useEffect(() => {
    const tick = (): void => {
      // a hidden tab (or a phone app in the background) polls nothing; it catches up on return
      if (document.visibilityState === "hidden") return;
      void loadHealth();
      // a locked tab only watches health, so a token entered in another tab still unlocks it
      if (lockedRef.current !== true) void load();
    };
    let timer = 0;
    let disposed = false;
    void (async (): Promise<void> => {
      // a bookmarked `#auth=<token>` link unlocks without typing; the fragment is
      // stripped before anything renders, and a stale token falls through to the
      // gate the first health check mounts
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken !== null) await authenticate(linkToken).catch(() => undefined);
      if (disposed) return;
      tick();
      timer = window.setInterval(tick, POLL_MS);
    })();
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && !disposed) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, loadHealth]);

  // push-triggered refetches are debounced so an event burst becomes one fetch
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      if (lockedRef.current !== true) void load();
    }, REFETCH_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => () => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
  }, []);

  // In-app alerts (components/Droplet.tsx): only while the app is on screen - a hidden app has
  // its system notifications - and never for the pane already open in front of the user.
  const dropIn = useCallback((machine: Machine, pane: HerdrPane, kind: DropletKind) => {
    if (!alertsOnRef.current || !alertInAppRef.current || document.visibilityState !== "visible") return;
    const open = selectionRef.current;
    if (open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
    if (splitShownRef.current && sameTarget(splitRef.current?.other ?? null, { machineId: machine.id, paneId: pane.pane_id }) && !drawerOpenRef.current) return;
    showDroplet({
      machineId: machine.id,
      paneId: pane.pane_id,
      agent: pane.agent ?? null,
      title: alertPaneTitle(pane),
      machine: machinesRef.current.length > 1 ? machine.name : null,
      kind,
    });
  }, []);

  // The alert sound (lib/alertSound.ts): heard also while the tab is hidden and a Focus silences
  // system notifications; never for the pane open in front of the user.
  const alertTurns = useRef<ReturnType<typeof createAlertTurnPlayer> | null>(null);
  useEffect(() => {
    const player = createAlertTurnPlayer({
      play: (kind) => alertsOnRef.current && alertSoundRef.current && playAlertSound(kind),
    });
    alertTurns.current = player;
    return () => { player.dispose(); alertTurns.current = null; };
  }, []);
  const chime = useCallback((machine: Machine, pane: HerdrPane, kind: AlertSoundKind) => {
    if (!alertsOnRef.current || !alertSoundRef.current || !canPlayAlertSound()) return;
    const open = selectionRef.current;
    if (document.visibilityState === "visible" && open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
    if (document.visibilityState === "visible" && splitShownRef.current && sameTarget(splitRef.current?.other ?? null, { machineId: machine.id, paneId: pane.pane_id }) && !drawerOpenRef.current) return;
    alertTurns.current?.chime(JSON.stringify([machine.id, pane.pane_id, kind]), kind);
  }, []);

  // a page plays audio only after a tap or key on it: each one lets the next chime play. A mouse
  // activates the page on press, a touch only on release, so both ends of a tap try
  useEffect(() => {
    if (!settings.alertSound) return;
    const unlock = () => { void unlockAlertSound(); };
    const events = ["pointerdown", "pointerup", "keydown"] as const;
    for (const event of events) window.addEventListener(event, unlock, true);
    return () => { for (const event of events) window.removeEventListener(event, unlock, true); };
  }, [settings.alertSound]);

  // One SSE subscription watches every PC, even when no terminal is selected.
  useEffect(() => {
    if (locked !== false) return;
    // the alerts take a pane waiting on its turn's background work for working (shared/notify-policy.ts)
    const alerting = (list: Machine[]) => list.map((machine) => ({
      id: machine.id,
      snapshot: machine.snapshot && { panes: machine.snapshot.panes.map((pane) => ({ pane_id: pane.pane_id, agent_status: alertStatus(pane.agent_status, (pane as HerdrPane).background_wait) })) },
    }));
    const events = new EventSource("/api/machines/events");
    events.onmessage = (event) => {
      let payload: MachineEvent;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === "preferences") { receivePreferencesRef.current(payload.preferences); return; }
      if (payload.type === "herdr-sidebar") { setAgentRowTokens(payload.agents); return; }
      // A poll started before this event can carry an older roster or pane status.
      snapshotRequests.current.invalidate();
      if (payload.type === "machines") {
        seedStatuses(statusRef.current, alerting(payload.machines), { started: turnStartRef.current, lasted: lastTurnRef.current });
        setMachines((previous) => sameData(previous, payload.machines) ? previous : payload.machines);
        rosterIn();
        setMachineRosterLoaded(true);
        return;
      }
      const machine = machinesRef.current.find((m) => m.id === payload.machine_id);
      if (!machine) return;
      const message = payload.message;
      if (message.type === "pane-status") {
        const key = paneStorageId(machine.id, message.pane_id);
        const previous = statusRef.current.get(key);
        const status = alertStatus(message.agent_status, message.background_wait);
        statusRef.current.set(key, status);
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        const worked = trackTurn(turnStartRef.current, key, previous, status, Date.now());
        if (worked !== null) lastTurnRef.current.set(key, worked);
        if (pane && shouldNotifyStatus(previous, status) && dropletAllows(alertsRef.current, status, worked)) {
          const kind = status === "blocked" ? "blocked" : "done";
          dropIn(machine, pane, kind);
          chime(machine, pane, kind);
        }
        if (pane && shouldNotifyStatus(previous, status) && alertsOnRef.current && !pushOnRef.current && alertsAllow(alertsRef.current, status)) showPaneStatusNotification(message.pane_id, `${machine.name} · ${alertPaneTitle(pane)}`, status, () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, view: "chat", workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
        setMachines((list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id !== machine.id || !m.snapshot) return m;
            const snapshot = applyPaneStatus(m.snapshot, message.pane_id, message.agent_status, message.background_tasks, message.background_wait === true, message.plan, message.finish_id, message.finish_epoch);
            if (snapshot === m.snapshot) return m;
            changed = true;
            return { ...m, snapshot };
          });
          return changed ? next : list;
        });
      }
      if (message.type === "pane-exited") {
        if (machine.id === "local") window.dispatchEvent(new Event("herdr-usage-changed"));
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        const worked = endedTurn(turnStartRef.current, lastTurnRef.current, paneStorageId(machine.id, message.pane_id), Date.now());
        if (pane && dropletAllows(alertsRef.current, "done", worked)) {
          dropIn(machine, pane, "ended");
          chime(machine, pane, "done");
        }
      }
      if (message.type === "pane-exited" && alertsOnRef.current && !pushOnRef.current && alertsRef.current.done !== "off") {
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        if (pane) showPaneEndedNotification(message.pane_id, `${machine.name} · ${alertPaneTitle(pane)}`, () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, view: "chat", workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
      }
      if (message.type === "session-changed" || message.type === "pane-exited") scheduleRefetch();
    };
    return () => events.close();
  }, [locked, scheduleRefetch, dropIn, chime]);

  const handleServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === "error" && message.code === "output_stalled") setOutputStopped(true);
  }, []);

  const enableNotifications = useCallback(async () => {
    // in-app alerts need no permission: the switch goes on whatever the browser answers
    updateSettings({ alertsOn: true });
    const current = notificationState();
    const next = current === "default" ? await requestNotificationPermission() : current;
    setNotifications(next);
    if (next !== "granted") return false;
    try {
      const endpoint = await ensurePushSubscription(alertsRef.current);
      setPushOn(endpoint !== null);
      // the confirmation push proves the whole path (server -> push service -> this device)
      if (endpoint) await sendTestPush(endpoint);
      return endpoint !== null;
    } catch (err) {
      console.warn("web push unavailable, alerts stay tab-only", err);
      return false;
    }
  }, [updateSettings]);

  // The browser's permission cannot be taken back from the page: turning alerts off drops
  // this device's push subscription (the server forgets it) and silences the tab's own.
  const disableNotifications = useCallback(async () => {
    updateSettings({ alertsOn: false });
    setPushOn(false);
    await removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err));
  }, [updateSettings]);

  // a device that already allowed alerts re-registers on every load: idempotent, and it
  // brings the device back if the server lost its subscriptions; a changed choice of
  // alerts goes the same way
  useEffect(() => {
    if (locked !== false || notifications !== "granted" || !alertsOn || !pushSupported()) return;
    let cancelled = false;
    ensurePushSubscription(alerts)
      .then((endpoint) => {
        if (!cancelled) setPushOn(endpoint !== null);
      })
      .catch(() => {
        if (!cancelled) setPushOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locked, notifications, alerts, alertsOn]);

  const unlock = useCallback(() => {
    setLocked(false);
    void loadHealth();
    void load();
  }, [load, loadHealth]);

  // pasting the auth link into an already-open tab is a fragment-only navigation:
  // no reload happens, so the boot consumer never re-runs. Watch for the arrival
  // of the fragment instead; a wrong token just leaves the gate as it is.
  useEffect(() => {
    const onHashChange = (): void => {
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken === null) return;
      void authenticate(linkToken)
        .then(unlock)
        .catch(() => undefined);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [unlock]);

  const lock = useCallback(async () => {
    setDrawerOpen(false);
    // before signOut: the unsubscribe call needs the cookie, and a locked device must stop
    // receiving pane titles
    await removePushSubscription().catch(() => undefined);
    setPushOn(false);
    try {
      await signOut();
    } catch {
      throw new Error(t("Could not sign out. Try again."));
    } finally {
      // The response may have been lost after the cookie was cleared.
      await loadHealth();
    }
  }, [loadHealth, t]);

  const selectedMachineRef = useRef(selectedMachineId);
  selectedMachineRef.current = selectedMachineId;
  const selectTarget = useCallback((machineId: string, paneId: string | null, view?: PaneView) => {
    // Only another PC mounts a new terminal (and socket), which reports its own state. A pane
    // on the same PC keeps the connected socket, which never reports again: resetting here
    // left the header on "reconnecting" after every pane switch.
    if (machineId !== selectedMachineRef.current) { setConnected(false); setConnectedBefore(false); }
    // the active half alone takes the pick, whatever the other half shows (lib/split.ts)
    setSelectedMachineId(machineId); setSelectedPaneId(paneId); setAutoSelected(false); setDrawerOpen(false);
    setOutputStopped(false);
    setNotificationViewTarget(view && paneId !== null ? { machine_id: machineId, pane_id: paneId, view } : null);
    // this browser's choice only: herdr's focus, its TUI and every other device stay where they are
    storeSelection(machineId, paneId);
    // a pane picked (a tapped notification, the sidebar, Back) before a link landed supersedes the link
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
    selectionHint.current = null;
    // a PC picked now (Open PC, before load() brings it) is checked against a roster sent after this
    selectionSince.current = rosterSeq.current;
  }, []);
  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;
  useEffect(() => {
    // An offline PC's cached roster cannot invalidate a selection. Once connected,
    // a closed pane (including one remembered across reloads) must release its selection.
    if (!snapshot || selectedMachine?.state !== "connected") return;
    // a link lands once its PC's roster is in: its pane, the pane its workspace's row opens, or,
    // when nothing it named is open, the usual fallback below with a word in the header
    const fallback = (current: typeof snapshot) => current.panes.find((pane) => pane.pane_id === current.focused_pane_id)?.pane_id ?? current.panes[0]?.pane_id ?? null;
    const linked = pendingLink.current;
    if (linked && linked.machine === selectedMachineId) {
      const land = (landed: ReturnType<typeof resolveLink>): boolean => {
        pendingLink.current = null;
        setLinkLanded(true);
        if (landed.note) setHeaderNote(landed.note);
        if (landed.pane) {
          if (landed.pane !== selectedPaneId) {
            setSelectedPaneId(landed.pane);
            // the link's lens was for its own pane: the one opened instead keeps its own
            setNotificationViewTarget(landed.pane === linked.pane && linked.view ? { machine_id: linked.machine, pane_id: landed.pane, view: linked.view } : null);
          }
          if (landed.pane !== linked.pane) pendingFile.current = null;
          return true;
        }
        if (linked.pane || linked.workspace) pendingFile.current = null;
        return false;
      };
      const landed = resolveLink(snapshot, linked);
      if (!landed.note) {
        if (land(landed)) return;
      } else {
        // The combined roster is cached: a pane made just before the link opened can be missing
        // from it. Ask this PC before saying the link's place has closed.
        let cancelled = false;
        void fetchSession(selectedMachineId).then((current) => ({ current, confirmed: resolveLink(current, linked) }), () => null).then((read) => {
          if (cancelled || pendingLink.current !== linked) return;
          // a failed read is not evidence that anything closed: the link settles without a word
          if (read === null) { land({ pane: null, workspace: null, note: null }); return; }
          const { current, confirmed } = read;
          if (land(confirmed)) return;
          // as below: nothing selected takes the fallback, a selection that has gone takes it as auto-selected
          if (current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
          setSelectedPaneId(fallback(current));
          if (selectedPaneId !== null) setAutoSelected(true);
        });
        return () => { cancelled = true; };
      }
    }
    if (snapshot.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
    if (selectedPaneId === null) { setSelectedPaneId(fallback(snapshot)); return; }
    // The combined roster is cached: a newly created pane can be selected before it
    // appears there. Confirm absence against this PC before discarding the selection.
    let cancelled = false;
    void fetchSession(selectedMachineId).then((current) => {
      if (cancelled || current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
      // a pane a tapped alert selected: the workspace the alert named opens, and says so
      const hint = selectionHint.current;
      selectionHint.current = null;
      if (hint && hint.machine === selectedMachineId && hint.pane === selectedPaneId) {
        const landed = resolveLink(current, { workspace: hint.workspace, workspaceSlug: null, pane: hint.pane });
        if (landed.note) setHeaderNote(landed.note);
        setNotificationViewTarget(null);
        setSelectedPaneId(landed.pane ?? fallback(current));
        setAutoSelected(true);
        return;
      }
      setSelectedPaneId(fallback(current));
      setAutoSelected(true);
    }).catch(() => { /* a failed read is not evidence that the pane disappeared */ });
    return () => { cancelled = true; };
  }, [snapshot, selectedPaneId, selectedMachineId, selectedMachine?.state, linkTick]);
  useEffect(() => {
    storeSelection(selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);

  const selectPane = useCallback((paneId: string, focusInput = true) => {
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
    selectionHint.current = null;
    setSelectedPaneId(paneId);
    setNotificationViewTarget(null);
    setAutoSelected(!focusInput);
    setDrawerOpen(false);
  }, []);

  // a layout call the palette made and the PC refused: a bridge from before the route says so
  // over the pane (the tab's own menu has a line of its own); anything else is logged, as
  // other background failures are
  const layoutRefused = useCallback((what: string, err: unknown): void => {
    if (routeMissing(err)) setLayoutNotice(t("This PC's bridge does not offer this yet"));
    else console.warn(what, err);
  }, [t]);

  // a tapped notification focuses this window and names the pane (public/sw.js). A pane not known
  // yet waits as a link does (this also keeps a cold start's link, which the worker names again
  // once the page is up), and so does one on a PC this roster lacks: a roster asked for now says
  // whether it was removed (the [machines] effect below) or set up since this one was read
  const takeNotificationTarget = useCallback((target: NotificationTarget): void => {
    const landing = notificationLanding(machinesRef.current, target);
    if (landing.kind === "select") {
      selectTargetRef.current(target.machine_id, target.pane_id, target.view);
      if (target.workspace_id) selectionHint.current = { machine: target.machine_id, pane: target.pane_id, workspace: target.workspace_id };
      return;
    }
    // the worker names one tap twice, before and after focus: the second leaves the first's lookup be
    if (sameLink(pendingLink.current, landing.link)) return;
    selectTargetRef.current(target.machine_id, target.pane_id, target.view);
    pendingLink.current = landing.link; pendingFile.current = null; setLinkLanded(false);
    linkSince.current = rosterSeq.current;
    setLinkTick((tick) => tick + 1);
    if (landing.stale) void load();
  }, [load]);
  // the tab's own alerts shown without a worker (lib/notifications.ts) land the same way
  const takeNotificationTargetRef = useRef(takeNotificationTarget); takeNotificationTargetRef.current = takeNotificationTarget;
  useEffect(() => onNotificationTarget(takeNotificationTarget), [takeNotificationTarget]);


  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null);
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const selectedLayout = snapshot?.layouts.find((layout) => layout.tab_id === selectedPane?.tab_id);
  // Selection can precede rendering: in a zoomed tab the layout effect below redirects it,
  // but the sidebar's passive effect can still see that first selection. Only the selected
  // pane the canvas actually draws counts; paneInFront checks coverage at acknowledgement time.
  const presentedPaneId = !drawerOpen && selectedPane && !selectedPane.restore_error
    && (!selectedLayout?.panes.length || selectedLayout.panes.some((pane) => pane.pane_id === selectedPane.pane_id))
    && (!selectedLayout?.zoomed || selectedLayout.focused_pane_id === selectedPane.pane_id)
    ? selectedPane.pane_id : null;
  useLayoutEffect(() => {
    if (selectedLayout?.zoomed && selectedLayout.focused_pane_id !== selectedPaneId
      && snapshot?.panes.some((pane) => pane.pane_id === selectedLayout.focused_pane_id)) {
      setSelectedPaneId(selectedLayout.focused_pane_id);
      setAutoSelected(true);
    }
    // a pick of another pane of a zoomed tab lands on herdr's zoomed one too: herdr shows only it
  }, [selectedMachineId, selectedPaneId, selectedLayout?.zoomed, selectedLayout?.focused_pane_id]);
  const targetHerdr = selectedMachineId === "local" ? health?.herdr : selectedMachine?.herdr;
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  // the tab that governs the pane region, so the strip's tabs and the pane they select are
  // one thing to a screen reader (A4); null while no tab owns this pane
  const tabPanelLabel = paneTabPanelLabel(snapshot, selectedPane, t);
  const selectedAgent = selectedPane?.agent ?? null;
  // unknown herdr (offline, or a server that predates the flag) counts as attach-capable
  // a server that repaints the pane's screen instead (terminal_mirror) has a terminal lens too
  const terminalAttach = targetHerdr?.terminal_attach !== false || targetHerdr?.terminal_mirror === true;

  // the lens follows the selected pane: each pane remembers its own. It is settled in the render
  // that selects the pane, not in an effect after it: the pane's terminal attaches in that render's
  // layout effect, and an attach in the previous pane's lens resized a pane whose lens is chat
  // a new Settings default is a new start for every pane's lens
  const lenses = useMemo(() => new PaneLenses(settings.defaultView), [settings.defaultView]);
  const lensKey = JSON.stringify([selectedPaneId, selectedMachineId, selectedPane !== null, selectedAgent !== null, terminalAttach, settings.defaultView]);
  const notificationView = notificationViewForPane(notificationViewTarget, selectedMachineId, selectedPaneId);
  let view = lens.view;
  if (lens.key !== lensKey) {
    if (selectedPaneId !== null) view = storedView(lenses, viewPicks, selectedPaneId, selectedMachineId, selectedPane ? selectedAgent !== null : null, terminalAttach);
    setLens({ key: lensKey, view });
  }
  // a tapped alert's lens is drawn over the pane's own, never stored: once it is gone (the pane or
  // its lens picked by hand) the pane is back on the lens it had. A shell has no conversation to
  // show (storedView), so its alert opens its own lens; until the snapshot says, it counts as an agent
  if (notificationView !== null && !(notificationView === "chat" && selectedPane !== null && selectedAgent === null)) view = notificationView;

  const contentKey = paneContentKey(selectedMachine, selectedPane, view);
  // App-owned coverage, plus dialogs/menus mounted by descendants (rename, worktree, lightbox,
  // confirmations). A desktop popup counts as covered too; docked file/web panels do not.
  const [dialogCover, setDialogCover] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    const update = () => {
      setDialogCover(paneCovered());
      setContentReady(paneContentPresented(contentKey));
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "role", "aria-modal", "data-pane-content", "hidden", "inert", "aria-hidden", "class"] });
    update();
    return () => observer.disconnect();
  }, [contentKey]);
  const paneInFront = useCallback(() => locked === false && linkLanded && pendingFile.current === null && pendingCreate.current === null
    && !drawerOpen && !settingsOpen && !newSessionOpen
    && !filesOpen && !machineDialog && !paletteOpen && !diffViewing && !(viewing && !fileDocked)
    && !dialogCover && !paneCovered()
    && contentReady && paneContentPresented(contentKey),
  [locked, linkLanded, drawerOpen, settingsOpen, newSessionOpen, filesOpen, machineDialog, paletteOpen, diffViewing, viewing, fileDocked, dialogCover, contentReady, contentKey]);

  const pickView = useCallback((machineId: string, paneId: string, next: PaneView) => {
    const key = paneStorageId(machineId, paneId);
    setViewPicks((current) => current.get(key) === next ? current : new Map(current).set(key, next));
    try {
      window.localStorage.setItem(`herdr-web-ui:view:${key}`, next);
    } catch {
      /* private mode: the lens is still picked for this page */
    }
  }, []);

  const setView = useCallback(
    (next: PaneView) => {
      setNotificationViewTarget(null);
      setLens((current) => ({ ...current, view: next }));
      setAutoSelected(false);
      if (selectedPaneId === null) return;
      pickView(selectedMachineId, selectedPaneId, next);
    },
    [selectedPaneId, selectedMachineId, pickView],
  );

  // The split view (lib/split.ts): drawn only where the sidebar stands beside the pane, and only
  // while a pane is selected; a narrower window shows the active half alone and keeps the split
  const otherMachine = split ? machines.find((m) => m.id === split.other.machineId) : undefined;
  const otherPane = split ? otherMachine?.snapshot?.panes.find((pane) => pane.pane_id === split.other.paneId) ?? null : null;
  // both halves may show one tab: slot b draws on a connection of its own (the slot's
  // MachineSessionsProvider below), so each half attaches and detaches the tab's panes by itself
  const splitOn = split !== null && wideScreen && selectedPaneId !== null;
  // the half that is not active, drawing the active half's tab too, shows it at the grid the active
  // half gives the pane: one pty has one size (PaneFollowContext)
  const sameTabs = splitOn && otherPane !== null && selectedPane !== null
    && split.other.machineId === selectedMachineId && otherPane.tab_id === selectedPane.tab_id;
  splitShownRef.current = splitOn;
  const otherWorkspace = otherPane ? otherMachine?.snapshot?.workspaces.find((workspace) => workspace.workspace_id === otherPane.workspace_id) ?? null : null;
  const otherHerdr = split?.other.machineId === "local" ? health?.herdr : otherMachine?.herdr;
  const otherAttach = otherHerdr?.terminal_attach !== false || otherHerdr?.terminal_mirror === true;

  // the other half's pane closed: another pane of its tab takes its place, else back to one pane.
  // An offline PC's cached roster cannot say so, as for the selection itself
  const otherTabRef = useRef<{ key: string; tab: string } | null>(null);
  const otherKey = split ? `${split.other.machineId}:${split.other.paneId}` : null;
  if (otherPane && otherKey) otherTabRef.current = { key: otherKey, tab: otherPane.tab_id };
  else if (otherTabRef.current?.key !== otherKey) otherTabRef.current = null;
  useEffect(() => {
    if (!split || !machineRosterLoaded) return;
    if (!otherMachine) { endSplit(split.active); return; }
    if (!otherMachine.snapshot || otherMachine.state !== "connected") return;
    const panes = otherMachine.snapshot.panes;
    if (panes.some((pane) => pane.pane_id === split.other.paneId)) return;
    const tabId = otherTabRef.current?.tab ?? null;
    // a pane this page has not seen in the roster yet (a saved split, a pane made just before the page
    // loaded) may be newer than the cached roster: ask the PC before the split ends, as the selection does
    if (tabId === null) {
      let cancelled = false;
      const other = split.other;
      void fetchSession(other.machineId).then((current) => {
        if (!cancelled && !current.panes.some((pane) => pane.pane_id === other.paneId)) endSplit(split.active);
      }).catch(() => {
        // a failed read is not evidence that the pane closed: ask again on the next roster
        if (!cancelled) otherRecheck.current = true;
      });
      return () => { cancelled = true; };
    }
    const focused = otherMachine.snapshot.layouts.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
    const heir = panes.find((pane) => pane.tab_id === tabId && pane.pane_id === focused) ?? panes.find((pane) => pane.tab_id === tabId);
    if (heir) setSplit({ ...split, other: { machineId: split.other.machineId, paneId: heir.pane_id } });
    else endSplit(split.active);
  }, [split, machineRosterLoaded, otherMachine, otherRosterTick, endSplit, setSplit]);

  /** A split change and the pane it selects. The half that becomes active keeps its terminals: only
   *  a half whose pane moves to another PC attaches again and reports its connection. */
  // `keepFocus`: the focus already went somewhere in the half made active (a Tab onto one of its
  // buttons): the half's terminal and composer must not take the keyboard from it (autoSelected)
  const applySplit = (next: SplitState | null, select: SplitTarget, keepFocus = false): void => {
    const was = splitOn ? split : null;
    const current: SplitTarget | null = selectedPaneId === null ? null : { machineId: selectedMachineId, paneId: selectedPaneId };
    const after: SplitSlot = next ? next.active : was && sameTarget(select, was.other) ? otherSlot(was.active) : was ? was.active : soloSlot;
    const before = was ? (was.active === after ? current : was.other) : after === soloSlot ? current : null;
    if (before === null || before.machineId !== select.machineId) { setConnected(false); setConnectedBefore(false); }
    if (next === null) endSplit(after); else setSplit(next);
    setSelectedMachineId(select.machineId); setSelectedPaneId(select.paneId); setAutoSelected(keepFocus); setOutputStopped(false);
    storeSelection(select.machineId, select.paneId);
  };
  const activateSlot = (slot: SplitSlot, keepFocus = false): void => {
    if (!splitOn || split.active === slot || selectedPaneId === null) return;
    applySplit({ other: { machineId: selectedMachineId, paneId: selectedPaneId }, bSide: split.bSide, active: slot }, split.other, keepFocus);
  };
  const closeSlot = (slot: SplitSlot): void => {
    if (!splitOn) return;
    if (slot !== split.active) { endSplit(split.active); return; }
    applySplit(null, split.other);
  };
  const selectInSlot = (slot: SplitSlot, machineId: string, paneId: string, focusInput = true): void => {
    const open = splitRef.current;
    if (!open || !splitOn || open.active === slot) { selectPane(paneId, focusInput); return; }
    if (selectedPaneId === null) return;
    // a pick in the other half (a press on a sibling pane of its tab, a tab opened there) makes that half
    // active with the picked pane selected, in one step. The press's own activation and this pick both
    // read the state from before the event: as two steps the second would undo the first
    applySplit({ other: { machineId: selectedMachineId, paneId: selectedPaneId }, bSide: open.bSide, active: slot }, { machineId, paneId }, !focusInput);
  };
  /** A pane opened in one half (a drop, the pane menu): that half shows it and is the active one; the
   *  other half keeps what it shows, the same tab included (lib/split.ts). */
  const dockSide = (dragged: SplitTarget, side: SplitSide): void => {
    if (!wideScreen || selectedPaneId === null) return;
    const result = dockPane(splitOn ? split : null, { machineId: selectedMachineId, paneId: selectedPaneId }, dragged, side, soloSlot);
    if (result) applySplit(result.split, result.select);
  };
  /** A pane dropped at a point: the half under it opens the pane. */
  const dockAt = (dragged: SplitTarget, x: number, y: number): void => {
    const box = paneAreaRef.current?.getBoundingClientRect();
    const inside = !!box && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    const side = box && inside ? dropSide(x, box.left, box.width, dropAtRef.current) : null;
    clearDropPreview();
    if (side !== null) dockSide(dragged, side);
  };
  const dockAtRef = useRef(dockAt); dockAtRef.current = dockAt;
  useEffect(() => {
    paneDrag.onDrop((target, x, y) => dockAtRef.current(target, x, y));
    return () => paneDrag.onDrop(null);
  }, []);
  // a tab dragged out of its strip: the guide follows it as a sidebar row's drag does below
  const splitDragOn = wideScreen && selectedPaneId !== null;
  useEffect(() => {
    if (!tabDrag || !splitDragOn) { if (!tabDrag) showDropTarget(null); return; }
    const box = paneAreaRef.current?.getBoundingClientRect();
    const point = tabDrag.point;
    const inside = !!box && !!point && point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;
    showDropTarget(box && point && inside ? dropSide(point.x, box.left, box.width, dropAtRef.current) : null);
  }, [tabDrag, splitDragOn, showDropTarget]);
  // dragenter too: a drop hit-tests once more, and when the node under the pointer was replaced since
  // the last dragover (xterm redraws its rows, a transcript renders again) the new node gets a
  // dragenter instead. Chromium refuses a drop whose last drag event nobody accepted.
  const paneDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!splitDragOn || !event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setPaneDragging(true);
    const box = paneAreaRef.current?.getBoundingClientRect();
    if (box) showDropTarget(dropSide(event.clientX, box.left, box.width, dropAtRef.current));
  };
  const paneDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    // Some browsers omit relatedTarget when crossing a child. The pointer still being inside
    // the area must not clear the preview (or its stable side at the centre).
    const box = event.currentTarget.getBoundingClientRect();
    if (event.relatedTarget === null && event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom) return;
    showDropTarget(null);
  };
  const paneDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    // the composer and the terminal take dropped files: a dropped pane is not one
    event.preventDefault();
    event.stopPropagation();
    const dragged = draggedPane(event.dataTransfer.getData(PANE_DRAG_TYPE));
    if (dragged) dockAt(dragged, event.clientX, event.clientY);
    else clearDropPreview();
  };
  // Bubble phase: the sidebar row has put its pane type into DataTransfer by then.
  useEffect(() => {
    if (!splitDragOn) { clearDropPreview(); return; }
    const start = (event: globalThis.DragEvent): void => {
      if (event.dataTransfer?.types.includes(PANE_DRAG_TYPE)) {
        showDropTarget(null);
        setPaneDragging(true);
      }
    };
    const cancel = (event: KeyboardEvent): void => { if (event.key === "Escape") clearDropPreview(); };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", clearDropPreview);
    window.addEventListener("drop", clearDropPreview);
    window.addEventListener("blur", clearDropPreview);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", clearDropPreview);
      window.removeEventListener("drop", clearDropPreview);
      window.removeEventListener("blur", clearDropPreview);
      window.removeEventListener("keydown", cancel);
    };
  }, [splitDragOn, clearDropPreview, showDropTarget]);

  // The address follows the app (lib/deepLink.ts): opening another pane or PC is an entry of the
  // history, so Back returns to the last one; a lens, a Settings page or a pane the app picked
  // itself replace the entry. Nothing is written while locked or before the roster is in, so a
  // link survives the access gate and a slow first read.
  const writtenLink = useRef<AppLink | null>(null);
  // Back or Forward landed somewhere other than its entry said: that place is written over the entry
  const poppedTo = useRef(false);
  const newSessionOpenRef = useRef(newSessionOpen); newSessionOpenRef.current = newSessionOpen;
  const linkWorkspaceId = selectedPane?.workspace_id ?? (selectedPaneId === null ? null : undefined);
  const linkSlug = slugOf(selectedWorkspace?.label) || null;
  const linkFile = viewing && viewing.machineId === selectedMachineId && (viewing.paneId === null || viewing.paneId === selectedPaneId) ? viewing.path : null;
  // the file is its pane's (its paths are read from the pane's folder): another pane or PC
  // selected leaves it behind, and the move takes the file's entry over (below), so Back returns
  // to the pane the file was open on, without the file
  const fileLeft = viewing !== null && linkFile === null;
  useEffect(() => {
    if (fileLeft) releaseFile();
  }, [fileLeft, releaseFile]);
  useEffect(() => {
    if (locked !== false || machines.length === 0 || snapshot === null || linkWorkspaceId === undefined || !linkLanded) return;
    const link: AppLink = {
      machine: selectedMachineId, workspace: linkWorkspaceId, workspaceSlug: linkSlug, pane: selectedPaneId, view: selectedPaneId ? view : null, file: linkFile,
      settings: settingsOpen ? settingsPage : null, section: settingsOpen && settingsPage === settingsLinkPage ? settingsLinkSection : null,
      sidebar: wideScreen && sidebarCollapsed ? "hidden" : null,
      create: newSessionOpen ? { kind: newTab ? "tab" : "workspace", cwd: newFields?.cwd ?? null, name: newFields?.name ?? null, agent: newFields?.agent ?? null } : null,
    };
    const previous = writtenLink.current;
    writtenLink.current = link;
    const search = linkSearch(link, window.location.search);
    const popped = poppedTo.current;
    poppedTo.current = false;
    // Back and Forward land where the address already says: nothing to write
    if (search === window.location.search) return;
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (previous !== null && !popped && !autoSelected && !settingsOpen && !newSessionOpen && isNavigation(previous, link)) {
      // a move that leaves the open file behind takes the file's entry: no entry is left between
      if (fileLeft) window.history.replaceState({ [NAV_KEY]: true }, "", url);
      else window.history.pushState({ [NAV_KEY]: true }, "", url);
    } else window.history.replaceState(window.history.state, "", url);
  }, [locked, machines.length, snapshot, linkLanded, selectedMachineId, selectedPaneId, linkWorkspaceId, linkSlug, linkFile, fileLeft, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, newSessionOpen, newTab, newFields, wideScreen, sidebarCollapsed, autoSelected]);


  // a file a link named opens over its pane once the pane is shown, as the chat's file links do
  useEffect(() => {
    const path = pendingFile.current;
    // a viewer already up (a reload restores it from its history entry) is the file the address names:
    // the link has nothing left to open, and a Back that closes the viewer must not bring it back
    if (viewing) { pendingFile.current = null; return; }
    if (path === null || !linkLanded || locked !== false || selectedMachine?.state !== "connected" || snapshot === null) return;
    pendingFile.current = null;
    openFile({ path, paneId: selectedPane?.pane_id ?? null, machineId: selectedMachineId });
  }, [linkLanded, locked, selectedMachine?.state, snapshot, selectedPane, selectedMachineId, viewing, openFile]);

  // Back and Forward between panes: the entry's address says which one. Settings' own entries
  // are its module's (lib/settingsHistory.ts)
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      if (settingsEntry(event.state) !== null) return;
      // a phone's sheet closing itself steps off its entry: not a Back, and what its item opened (a
      // worktree's shell, before the roster lists it) is written over the address once it is listed
      if (sheetSteppedOff()) return;
      const link = readLink(window.location.search);
      // before the PCs are in, nothing can say the entry's PC is still set up: it waits as a link
      // opened with the page does, settled against its roster or answered with a note once they are
      if (machinesRef.current.length === 0) {
        if (!link.pane && !link.workspace) return;
        selectTargetRef.current(link.machine, link.pane, link.view ?? undefined);
        pendingLink.current = link; pendingFile.current = null; setLinkLanded(false);
        linkSince.current = rosterSeq.current;
        poppedTo.current = true;
        return;
      }
      const machine = machinesRef.current.find((candidate) => candidate.id === link.machine);
      const missing = !machine && machinesRef.current.length > 0;
      // the New workspace dialog is part of the address it was open on: Back closes it, Forward opens
      // it again, but not for a PC removed since
      if (!link.create) setNewSessionOpen(false);
      else if (!missing && !newSessionOpenRef.current) pendingCreate.current = link.create;
      // an entry naming a PC since removed leaves the app where it is and says so, as a link to it would
      if (missing) setHeaderNote("machine-missing");
      else {
        const pane = machine?.snapshot ? resolveLink(machine.snapshot, link).pane : link.pane;
        if (pane === null) return;
        const current = selectionRef.current;
        // the entry's lens is drawn over the pane's own, as a tapped notification's is. Where it
        // lands is written over the entry, so Forward keeps the entries after it
        if (current.machineId !== link.machine || current.paneId !== pane) { poppedTo.current = true; selectTargetRef.current(link.machine, pane, link.pane === pane ? link.view ?? undefined : undefined); return; }
      }
      // the same pane, or no PC to go to: the entry landed on may still say what is no longer shown
      // (the address a link to Settings opened the page with, under the dialog's own entries), so it says it now
      const shown = writtenLink.current;
      const search = shown ? linkSearch(shown, window.location.search) : window.location.search;
      if (search !== window.location.search) window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);


  // The Alerts item says what this device does, whatever the browser's permission: in-app alerts
  // need none, so they count as on. A device that has not answered the permission question is
  // asked by the item; one that has answered gets a plain switch.
  const bell: { state: string; title: string; on: boolean; run: () => Promise<unknown> } =
    !alertsOn
      ? { state: t("Off on this device"), title: t("Alerts off on this device. Tap to turn them on"), on: false, run: enableNotifications }
      : notifications !== "granted"
        ? !settings.alertInApp
          ? { state: t("Off on this device"), title: t("Notify me when a pane needs input or finishes"), on: false, run: enableNotifications }
          : notifications === "default"
            ? { state: t("On in the app"), title: t("Alerts on in the app. Tap to allow them when it is closed too"), on: true, run: enableNotifications }
            : { state: t("On in the app"), title: t("Alerts on in the app. Tap to turn them off"), on: true, run: disableNotifications }
        : pushOn
          ? { state: t("On, pushed to this device"), title: t("Alerts on, pushed to this device, even with the app closed. Tap to turn them off"), on: true, run: disableNotifications }
          : {
              state: t("On in this tab"),
              // turning them off and on again retries the push subscription
              title: pushSupported()
                ? t("Alerts on while this tab is open. Tap to turn them off")
                : t("Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off"),
              on: true,
              run: disableNotifications,
            };
  // hidden only where it could do nothing: no system notifications and in-app alerts off
  const bellVisible = notifications === "default" || notifications === "granted" || settings.alertInApp;
  // the menu's button carries a dot while alerts are off here: the one state of the menu worth a glance
  const alertsOffDot = bellVisible && !bell.on;
  const connWord = t(connected ? "live" : outputStopped ? "disconnected" : connectedBefore ? "reconnecting" : "connecting");
  const crumb = selectedPane && selectedTitle !== null
    ? headerCrumb({ machine: selectedMachine?.name ?? selectedMachineId, machineCount: machines.length, workspace: selectedWorkspace?.label ?? selectedPane.workspace_id, title: selectedTitle, cwd: selectedPane.cwd })
    : null;

  useEffect(() => {
    document.title = selectedTitle ? `${selectedTitle} · herdr` : APP_TITLE;
  }, [selectedTitle]);

  // A new tab's workspace: the named one, else the selected pane's. Its folder is the workspace's:
  // a worktree's checkout, else where the pane in front (the selected one, else the one herdr has
  // in front, else the first) is. Read from refs, so the actions keep no stale roster.
  const newTabTarget = (target?: { machineId: string; workspaceId: string }) => {
    const machineId = target?.machineId ?? selectionRef.current.machineId;
    const roster = machinesRef.current.find((m) => m.id === machineId)?.snapshot;
    // pane ids repeat across PCs: the selected pane counts only on the PC the tab is for
    const selectedPaneId = selectionRef.current.machineId === machineId ? selectionRef.current.paneId : null;
    const workspaceId = target?.workspaceId ?? roster?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id;
    const workspace = roster?.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!roster || !workspace) return null;
    const panes = roster.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
    const inFront = panes.find((pane) => pane.pane_id === selectedPaneId)
      ?? panes.find((pane) => pane.pane_id === roster.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes[0];
    return { machineId, workspace, cwd: workspace.worktree?.checkout_path ?? inFront?.cwd ?? null };
  };

  const actions = useMemo<AppActions>(
    () => ({
      selectPane,
      selectAdjacentPane: (direction) => {
        // the panes the sidebar lists: a step never lands on a viewer it leaves out
        const panes = rosterPanes(snapshotRef.current?.panes ?? [], selectedPaneId);
        if (panes.length === 0) return;
        const index = panes.findIndex((pane) => pane.pane_id === selectedPaneId);
        const next = panes[(index + direction + panes.length) % panes.length];
        if (next) selectPane(next.pane_id);
      },
      setView,
      toggleView: () => { setView(view === "chat" ? "terminal" : "chat"); setDrawerOpen(false); },
      focusInput: () => paneControls.current?.focusInput(),
      scrollPage: (direction) => paneControls.current?.scrollPage(direction),
      openNewSession: () => {
        setDrawerOpen(false);
        setNewSessionMachineId(selectedMachineId);
        setNewTab(null);
        setNewSessionOpen(true);
      },
      openNewTab: (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        const { machineId, workspace, cwd } = found;
        setDrawerOpen(false);
        setNewSessionMachineId(machineId);
        setNewTab({ workspaceId: workspace.workspace_id, workspaceLabel: workspace.label, cwd, number: workspace.tab_count + 1 });
        setNewSessionOpen(true);
      },
      openTerminalTab: async (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        const asked = selectionRef.current;
        const created = await createTab({ workspace_id: found.workspace.workspace_id, cwd: found.cwd, label: null, agent: null }, found.machineId);
        void load();
        // what the user went to while herdr answered is theirs to keep
        if (selectionStill(asked, selectionRef.current)) selectTargetRef.current(found.machineId, created.pane_id);
      },
      openPalette,
      agentStarted: (machineId, paneId) => lenses.startedAgent(paneStorageId(machineId, paneId), window.matchMedia?.("(pointer: coarse)").matches === true),
      openFind: () => {
        if (selectedPaneId === null) return;
        setView("terminal");
        setDrawerOpen(false);
        setFindRequest((request) => ({ paneId: selectedPaneId, serial: request.serial + 1 }));
      },
      openSettings: () => {
        setDrawerOpen(false);
        setSettingsSection(null);
        setSettingsOpen(true);
      },
      openAddPc: () => {
        // the new PC reports its progress in the sidebar: nothing should sit over it
        setSettingsOpen(false);
        setUpdateRemote(false);
        addPcFocusReturn.current = true;
        setMachineDialog("new");
      },
      toggleSidebar: () => {
        if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen((open) => !open);
        else setSidebarCollapsed((collapsed) => !collapsed);
      },
      toggleTheme: () => updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" }),
      lock: canSignOut ? lock : null,
      enableNotifications: bellVisible && bell.run === enableNotifications ? () => void enableNotifications() : null,
      refresh: () => void load(),
      openFiles: selectedPaneId !== null ? () => { setDrawerOpen(false); setFilesOpen(true); } : null,
      // herdr's layout calls on the selected pane (components/TabStrip.tsx has the same for the
      // tab's own menu): the new layout reaches every client as session-changed, so only a
      // refusal is left to say, and that is logged as other background failures are
      splitPane: selectedPaneId !== null ? (direction, focus = false) => {
        const asked = selectionRef.current;
        if (asked.paneId === null) return;
        void splitPane(asked.paneId, direction, focus, asked.machineId)
          .then((pane) => {
            void load();
            // herdr focused the new pane: the app follows, unless another pane or PC was opened
            // while herdr answered (over SSH, say): what the user went to is theirs to keep
            if (focus && selectionStill(asked, selectionRef.current)) selectPane(pane.pane_id);
          })
          .catch((err) => layoutRefused("pane split failed", err));
      } : null,
      zoomPane: selectedPaneId !== null ? (mode) => {
        const { machineId, paneId } = selectionRef.current;
        if (paneId === null) return;
        void zoomPane(paneId, mode, machineId).then(() => void load()).catch((err) => layoutRefused("pane zoom failed", err));
      } : null,
    }),
    [selectPane, selectedPaneId, selectedMachineId, setView, view, updateSettings, resolvedTheme, canSignOut, lock, bellVisible, bell.run, enableNotifications, load, layoutRefused, lenses],
  );

  useShortcuts(actions, locked === false);

  // The header's More menu: what used to be three buttons of its own. Each item is there under
  // the condition its button had. At phone width the palette's button gives its room to the
  // pane's title, and the menu's first item opens the palette.
  // a link to a PC this app does not have lands on this PC instead, and says so: the roster lists
  // every configured PC, connected or not, so one missing from it is not set up here. So does a
  // selection of a PC removed since (a reload, a new window), here or on another device. Only a
  // roster the server sent after the PC was named decides (lib/notificationTarget.ts machineGone)
  useEffect(() => {
    const linked = pendingLink.current;
    const machineId = linked ? linked.machine : selectedMachineRef.current;
    const since = linked ? linkSince.current : selectionSince.current;
    if (!machineGone(machines, rosterSeq.current, since, machineId)) return;
    pendingLink.current = null; pendingFile.current = null;
    setLinkLanded(true);
    setHeaderNote("machine-missing");
    // no pane: the link's pane id means nothing on another PC, so the pane herdr has in front opens
    selectTargetRef.current("local", null);
  }, [machines, rosterTick, linkTick]);

  // a link to the New workspace dialog opens it once the PCs are in; one for a tab, once the
  // linked workspace's pane is selected (its folder is the workspace's, as the tab strip's + does)
  const [createTick, setCreateTick] = useState(0);
  useEffect(() => {
    const linked = pendingCreate.current;
    if (linked === null || !linkLanded || machines.length === 0 || newSessionOpen) return;
    if (linked.kind === "tab" && !selectedPane) return;
    pendingCreate.current = null;
    const fields = { cwd: linked.cwd, name: linked.name, agent: linked.agent };
    setNewPrefill(fields);
    setNewFields(fields);
    if (linked.kind === "tab") actions.openNewTab({ machineId: selectedMachineId, workspaceId: selectedPane!.workspace_id });
    else { setNewSessionMachineId(selectedMachineId); setNewTab(null); setNewSessionOpen(true); }
  }, [linkLanded, machines.length, newSessionOpen, selectedPane, selectedMachineId, actions, createTick]);
  // Forward onto an entry the dialog was open on: the popstate above leaves it pending
  useEffect(() => {
    const onPop = (): void => setCreateTick((tick) => tick + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const closeNewSession = useCallback(() => { setNewSessionOpen(false); setNewPrefill(null); setNewFields(null); }, []);

  // the palette's shortcut, said beside its item where a hardware keyboard is likely (a fine pointer)
  const keyboardLikely = useMediaQuery("(hover: hover) and (pointer: fine)");
  const paletteKeys = keyboardLikely ? formatKeys(shortcutDisplayKeys("palette", settings.shortcutOverrides)).join("+") : "";
  const moreItems: RowMenuItem[] = [
    // first at every width: a phone's header has no palette button, and a touch screen no shortcut
    { id: "palette", label: t("Search panes and actions"), icon: Search, ...(paletteKeys ? { hint: paletteKeys } : {}), run: () => openPalette() },
    ...(selectedPane && !selectedPane.restore_error ? [{ id: "find", label: t("Find in terminal"), icon: Search, run: actions.openFind }] : []),
    // from 769px Files has its own button beside the lens switch; a phone keeps it here
    ...(selectedPane && !wideScreen ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: () => setFilesOpen(true) }] : []),
    // the address says where the app is (lib/deepLink.ts); a phone has no address bar to copy it from
    { id: "copy-link", label: t("Copy link"), icon: Link, run: () => void copyText(window.location.href).then((ok) => { if (ok) setHeaderNote("copied"); }) },
    ...(bellVisible ? [{ id: "alerts", label: t("Alerts"), hint: bell.state, checked: bell.on, title: bell.title, icon: Bell, run: () => void bell.run() }] : []),
  ];

  // the chat's surface is what the pane column shows: the header's pane zone and the tab strip
  // take it (from 769px). A pane herdr could not restore draws a placeholder, not the chat.
  const chatShown = showsChat(selectedPane, view);

  if (locked === null) {
    // the auth state is unknown until /api/health or /api/session answers (ten seconds when
    // herdr is down): show the shell without the terminal, and so without a WebSocket,
    // instead of a blank page
    return (
      <div className="app">
        <header className="app-header">
          <Brand />
        </header>
        <div className="app-body">
          <aside className="sidebar">
            <ConnectingNote />
          </aside>
          <main className="terminal-host">
            <div className="terminal-placeholder">
              <div className="terminal-placeholder-inner">
                <span>{t("Connecting to herdr web ui…")}</span>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (locked) return <AccessGate reason={lockReason} initialCode={pairCode} onUnlocked={unlock} />;

  return (
    <MachineSessionsProvider machineIds={machines.map((machine) => machine.id)}><MachineContext.Provider value={selectedMachineId}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={sidebarWidth === null && filePanelWidth === null ? undefined : {
      ...(sidebarWidth === null ? {} : { "--sidebar-user-w": `${sidebarWidth}px` }),
      ...(filePanelWidth === null ? {} : { "--file-panel-user-w": `${filePanelWidth}px` }),
    } as CSSProperties}>
      <header className={`app-header is-zoned${chatShown ? " is-chat" : ""}`}>
        {/* is-zoned tells this header from the connecting shell's, which has no zones to draw.
            .header-side is the sidebar's own top row from 769px (styles.css); below that its
            buttons sit in the bar */}
        <div className="header-side">
          <button
            type="button"
            className="icon-button drawer-toggle"
            aria-label={t(drawerOpen ? "Close workspace list" : "Open workspace list")}
            aria-expanded={drawerOpen}
            aria-controls="workspace-drawer"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? <X /> : <Menu />}
          </button>
          <button
            type="button"
            className="icon-button header-desktop-only sidebar-toggle"
            aria-label={t(sidebarCollapsed ? "Show workspace list" : "Hide workspace list")}
            aria-pressed={!sidebarCollapsed}
            title={t("Toggle sidebar (⌘⇧B)")}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <PanelLeft />
          </button>
          <button type="button" className="icon-button palette-button" aria-label={t("Command palette")} title={t("Command palette (⌘⇧K)")} onClick={() => openPalette()}>
            <Search />
          </button>
        </div>
        <HeaderNote note={note} />
        {note !== null ? null : selectedPane && crumb ? (
          <div className="context" title={crumb.tooltip}>
            <div className="context-title">
              {selectedAgent && <AgentMark agent={selectedAgent} size={18} />}
              <span className="context-title-text">{selectedTitle}</span>
            </div>
            <div className="context-sub">
              {/* one PC needs no name: the sidebar leaves it out too, and More still says it */}
              {crumb.showMachine && <><span className="machine-context-name">{crumb.machine}</span><span className="context-sep" aria-hidden="true">›</span></>}
              <span>{crumb.workspace}</span>
              {crumb.folder !== null && (
                <>
                  <span className="context-sep" aria-hidden="true">›</span>
                  <span>{crumb.folder}</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <><Brand /><span className="machine-context-name">{selectedMachine?.name ?? selectedMachineId}</span></>
        )}
        {selectedPane && (
          <div className="segmented view-switch" role="group" aria-label="Pane view">
            <button type="button" aria-pressed={view === "chat"} onClick={() => { setView("chat"); setDrawerOpen(false); }} title={t("Chat transcript (⌘⇧J)")}>
              <MessageSquare />
              <span className="header-desktop-only">{t("Chat")}</span>
            </button>
            <button type="button" aria-pressed={view === "terminal"} onClick={() => { setView("terminal"); setDrawerOpen(false); }} title={terminalAttach ? t("Live terminal (⌘⇧J)") : t("Live terminal: coming to Windows PCs once herdr can attach there")}>
              <SquareTerminal />
              <span className="header-desktop-only">{t("Terminal")}</span>
              {!terminalAttach && <span className="pill pill-soon">{t("soon")}</span>}
            </button>
          </div>
        )}
        {selectedPane && wideScreen && (
          <>
            {/* opens Files, it is no third lens: set apart from the switch by a hairline */}
            <span className="header-divider" aria-hidden="true" />
            <button type="button" className="icon-button header-files-button" aria-label={t("Browse files")} title={t("Browse files")} onClick={() => setFilesOpen(true)}>
              <FolderOpen />
            </button>
          </>
        )}
        <div className="header-meta">
          <ConnectionChip
            connected={connected}
            word={connWord}
            title={[connected ? null : connWord, targetHerdr ? t("herdr {version} · protocol {protocol}", { version: targetHerdr.version, protocol: targetHerdr.protocol }) : null].filter((part) => part !== null).join(" · ") || undefined}
          />
          {/* the Host's herdr is away: the step to take is on that PC (the sidebar's state line says the same) */}
          {!targetHerdr && <span className="pill pill-offline" title={selectedMachineId === "local" ? t("Start herdr on this PC, or check HERDR_SOCKET.") : undefined}>{t("herdr offline")}</span>}
          <span className="header-more">
            <button
              type="button"
              className="icon-button header-more-button"
              aria-label={alertsOffDot ? t("More · alerts are off") : t("More")}
              title={alertsOffDot ? t("More · alerts are off") : t("More")}
              aria-haspopup="menu"
              aria-expanded={more !== null}
              onClick={(event) => {
                const anchor = event.currentTarget;
                setMore((open) => (open ? null : { anchor }));
              }}
            >
              <Ellipsis />
            </button>
            {alertsOffDot && <span className="header-more-dot" aria-hidden="true" />}
          </span>
        </div>
        {more && (
          <RowMenu
            anchor={more.anchor}
            title={t("More")}
            header={crumb ? (
              <div className="header-more-crumb">
                <span>{crumb.place}</span>
                {crumb.path !== null && <span className="header-more-path">{crumb.path}</span>}
              </div>
            ) : undefined}
            items={moreItems}
            onClose={closeMore}
          />
        )}
      </header>

      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>{t("Retry")}</button></div>}
          {/* a sidebar that cannot be drawn leaves the panes working */}
          <RenderBoundary resetKey={null} fallback={(retry) => <RegionCrash message={t("The sidebar can't be shown.")} retry={retry} />}>
            <CrashProbe region="sidebar" />
            <MachineSidebar machines={machines} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} presentedPaneId={presentedPaneId} paneInFront={paneInFront} actions={actions} onSelect={selectTarget} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={(id) => { setNewSessionMachineId(id); setNewTab(null); setNewSessionOpen(true); setDrawerOpen(false); }} />
          </RenderBoundary>
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
        </aside>

        {/* kept on the page closed (styles.css): a swipe that begins on it closes the drawer */}
        <div className={`scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />

        {/* a file path in the chat opens in the viewer, relative to the selected pane's folder */}
        <OpenFileContext.Provider value={selectedPaneId !== null ? viewFile : null}>
        <WebPanelContext.Provider value={filePanelAvailable ? openWebPage : null}>
        <div className={`pane-column${chatShown ? " is-chat" : ""}`}>
        {/* over the pane only: a bar across the window would cut the sidebar off from its top row in the header */}
        <UpdateNotice updates={updates} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <TelemetryNotice enabled={locked === false} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <MachineActionBanner machines={machines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
        {layoutNotice && <p className="pane-notice" role="alert">{layoutNotice}</p>}
        {health?.lan_exposure && <LanExposureNotice host={health.lan_exposure.host} onOpen={() => { setSettingsLinkPage("devices"); setSettingsOpen(true); }} />}
        {/* the pane's tab, or two tabs side by side (lib/split.ts): a tab dragged down out of its strip,
            or a sidebar row dragged over this area, opens its pane in the half it is dropped on */}
        <div ref={paneAreaRef} className={`pane-split${splitOn ? " is-split" : ""}`} onDragEnterCapture={paneDragOver} onDragOverCapture={paneDragOver} onDragLeave={paneDragLeave} onDropCapture={paneDrop}>
          {(["a", "b"] as const).map((slot) => {
            // one pane: the solo slot, or a split's active half where the window is too narrow for both
            if (!splitOn && slot !== (split ? split.active : soloSlot)) return null;
            const active = !splitOn || split.active === slot;
            const machineId = active ? selectedMachineId : split.other.machineId;
            const paneId = active ? selectedPaneId : split.other.paneId;
            const machine = active ? selectedMachine : otherMachine;
            const herdr = active ? targetHerdr : otherHerdr;
            const pane = active ? selectedPane : otherPane;
            const workspace = active ? selectedWorkspace : otherWorkspace;
            const slotSnapshot = active ? snapshot : otherMachine?.snapshot ?? null;
            const attach = active ? terminalAttach : otherAttach;
            const lensOf = (item: HerdrPane): PaneView => active && item.pane_id === selectedPaneId ? view
              : storedView(lenses, viewPicks, item.pane_id, machineId, item.agent != null, attach);
            const slotView = active ? view : pane ? lensOf(pane) : "terminal";
            const onSelect = active ? selectPane : (id: string, focusInput = true) => selectInSlot(slot, machineId, id, focusInput);
            // one pane's panel keeps the page's own id, whichever slot draws it
            const slotPanelId = !splitOn || slot === "a" ? PANE_TABPANEL_ID : `${PANE_TABPANEL_ID}-${slot}`;
            const slotPanelLabel = active ? tabPanelLabel : paneTabPanelLabel(slotSnapshot, pane, t);
            const toggleSlotView = (): void => {
              const next = slotView === "chat" ? "terminal" : "chat";
              if (active) setView(next); else if (pane) pickView(machineId, pane.pane_id, next);
            };
            // a half's own lens and close sit at the end of its tab strip. The row's free end is the
            // half's grip: its pane, dropped on a half of the pane area, opens there too (dockSide)
            const slotEnd = splitOn ? <div className="pane-slot-grip" draggable={paneId !== null}
              onDragStart={(event) => {
                if (paneId === null) return;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
              }}>
              {machines.length > 1 && <span className="pane-slot-machine">{machine?.name ?? machineId}</span>}
              {pane && <button type="button" className="icon-button pane-slot-action" aria-label={t(slotView === "chat" ? "Show the terminal" : "Show the chat")} title={t(slotView === "chat" ? "Show the terminal" : "Show the chat")} onClick={toggleSlotView}>
                {slotView === "chat" ? <SquareTerminal /> : <MessageSquare />}
              </button>}
              <button type="button" className="icon-button pane-slot-action" aria-label={t("Close this half")} title={t("Close this half")} onClick={() => closeSlot(slot)}>
                <X />
              </button>
            </div> : undefined;
            // a half with no strip to carry its close (its pane gone, or the half crashed) keeps one in a bar of its own
            const slotBar = splitOn ? <div className="pane-slot-bar"><span className="pane-slot-title">{pane ? displayPaneTitle(pane) : t("Pane closed")}</span>{slotEnd}</div> : null;
            return (
              <MachineContext.Provider key={slot} value={machineId}><SlotSessions slot={slot} machineIds={machines.map((item) => item.id)}><PaneFollowContext.Provider value={sameTabs && !active}>
              <div
                className={`pane-slot${showsChat(pane, slotView) ? " is-chat" : ""}${splitOn ? active ? " is-active" : " is-inactive" : ""}`}
                data-slot={slot}
                data-side={splitOn ? slotSide(split, slot) : undefined}
                // a press or the focus in the other half makes it the active one, before the press acts;
                // its own bar's buttons (its lens, its close) act on it as it is
                onPointerDownCapture={active ? undefined : (event) => {
                  if (event.button === 0 && !paneContextPress(event, apple) && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot);
                }}
                onFocusCapture={active ? undefined : (event) => { if (Date.now() - lastKeyAtRef.current < KEY_FOCUS_MS && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot, true); }}
                // a file or text dropped into the other half is for its pane: an upload's paths and the pasted
                // text reach only the active half's terminal, so the drop makes the half active first
                onDropCapture={active ? undefined : (event) => { if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) activateSlot(slot); }}
              >
                {/* a pane this half cannot draw leaves the sidebar and the other half working; picking
                    another pane tries again */}
                <RenderBoundary resetKey={`${machineId}:${paneId ?? ""}`} fallback={(retry) => <>{slotBar}<RegionCrash message={t("This pane can't be shown.")} retry={retry} onShown={active ? paneLost : undefined} /></>}>
                <CrashProbe region="pane" />
                {!(slotSnapshot && pane && workspace) && slotBar}
                {slotSnapshot && pane && workspace && (
                  <TabStrip snapshot={slotSnapshot} workspace={workspace} selectedPane={pane} panelId={slotPanelId} splitDrag={wideScreen} onSelectPane={onSelect} end={slotEnd}
                    onNewTab={() => actions.openNewTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
                    onNewTerminal={() => actions.openTerminalTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
                    paneActions={active ? (paneId) => {
                      const target = snapshot?.panes.find((item) => item.pane_id === paneId);
                      if (!target || !paneActionsRef.current) return [];
                      // the strip renders before the canvas, so its items come from the canvas's previous render:
                      // an action runs against the canvas's latest one, where a snapshot change has landed
                      return paneActionsRef.current(target).map((item) => ({ ...item, run: () => (paneActionsRef.current?.(target).find((fresh) => fresh.id === item.id) ?? item).run() }));
                    } : undefined} />
                )}
                {/* the tab strip's panel: its id is what each tab's aria-controls points at, one per half.
                    No tabIndex - the terminal (PaneTerminal) and the composer are the focusable things inside it. */}
                <main className="terminal-host">
                  <div id={slotPanelId} className="terminal-tabpanel" role={slotPanelLabel === null ? undefined : "tabpanel"} aria-label={slotPanelLabel ?? undefined}>
                  <PaneCanvas key={machineId} snapshot={slotSnapshot} pane={pane} selectedPaneId={paneId} onSelect={onSelect} onChanged={actions.refresh} actionsRef={active ? paneActionsRef : undefined}
                    onOpenInHalf={wideScreen ? (id, side) => dockSide({ machineId, paneId: id }, side) : undefined}
                    renderPane={(item, itemActive, herdrSplit) => <OpenFileContext.Provider value={item ? (path) => openFile({ path, paneId: item.pane_id, machineId }) : null}>
                      <PaneTerminal
                        presentationKey={paneContentKey(machine, item, item ? lensOf(item) : slotView)}
                        finishEpoch={machine?.snapshot?.finish_epoch}
                        finishId={item?.finish_id}
                        title={item ? displayPaneTitle(item) : active ? selectedTitle : null}
                        // Wait for the roster before attaching: the loading placeholder is replaced
                        // by the keyed tile, and must never claim the pane on a throwaway connection.
                        paneId={item?.restore_error ? null : item?.pane_id ?? null}
                        terminalId={item?.terminal_id ?? null}
                        mirrored={herdr ? herdr.terminal_attach === false || herdr.terminal_mirror === true : null}
                        restoreError={item?.restore_error ?? null}
                        agent={item?.agent ?? null}
                        agentStatus={item?.agent_status}
                        backgroundTasks={item?.background_tasks ?? 0}
                        // an offline PC's cached plan cannot be read
                        plan={machine?.state === "connected" ? (item as HerdrPane | undefined)?.plan ?? null : null}
                        backgroundWait={item?.background_wait === true}
                        cwd={item?.cwd ?? null}
                        workspaceId={item?.workspace_id ?? null}
                        worktreeRepo={worktreeRepoName(item === null ? undefined : slotSnapshot?.workspaces.find((workspace) => workspace.workspace_id === item.workspace_id))}
                        machineName={machine?.name ?? machineId}
                        view={item ? lensOf(item) : slotView}
                        // the other half never takes the keyboard: a press in it makes it active first
                        active={active && itemActive}
                        // the paging shortcuts reach the selected pane of the active half only
                        controls={active && itemActive ? paneControls : undefined}
                        findRequest={active && findRequest.paneId === item?.pane_id ? findRequest.serial : 0}
                        autoSelected={active ? autoSelected : true}
                        terminalFontSize={settings.terminalFontSize}
                        split={herdrSplit || splitOn}
                        terminalWheelSpeed={settings.terminalWheelSpeed}
                        terminalFontFamily={settings.terminalFontFamily}
                        theme={resolvedEntry.mode}
                        palette={resolvedEntry.id}
                        onConnectionChange={active && itemActive ? (next, before) => { setConnected(next); setConnectedBefore(before); if (next) setOutputStopped(false); } : undefined}
                        onServerMessage={active && itemActive ? handleServerMessage : undefined}
                      />
                    </OpenFileContext.Provider>} />
                  </div>
                </main>
                </RenderBoundary>
              </div>
              </PaneFollowContext.Provider></SlotSessions></MachineContext.Provider>
            );
          })}
          <SplitDropPreview visible={splitDragOn && (paneDragging || tabDrag !== null)} side={dropAt} />
        </div>
        </div>
        </WebPanelContext.Provider>
        </OpenFileContext.Provider>
        {/* last in the row: the file beside the pane (from 980px), the pane column shrinks and its terminal refits */}
        {viewing !== null && fileDocked && <MachineContext.Provider value={viewing.machineId}>
          <FileViewer key={viewing.path} docked panelStart={<FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} />} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path, presentation })} onKind={reportFileKind} onTogglePresentation={toggleFilePresentation} keyboardActive={!settingsOpen} />
        </MachineContext.Provider>}
        {webPage !== null && filePanelAvailable && !(viewing !== null && fileDocked) &&
          <WebPanel key={webPage} url={webPage} onClose={() => setWebPage(null)} panelStart={<FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} />} />}
      </div>

      <MachineContext.Provider value={newSessionMachineId}><NewSessionDialog
        key={newSessionMachineId}
        machineName={machines.find((m) => m.id === newSessionMachineId)?.name ?? newSessionMachineId}
        worktrees={machines.find((m) => m.id === newSessionMachineId)?.snapshot?.workspaces.flatMap((workspace) => workspace.worktree?.is_linked_worktree ? [workspace.worktree.checkout_path] : []) ?? []}
        open={newSessionOpen}
        tab={newTab}
        defaultCwd={newSessionMachineId === selectedMachineId ? selectedPane?.cwd ?? null : null}
        prefill={newPrefill}
        onDraft={setNewFields}
        onClose={closeNewSession}
        onCreated={(paneId, agentStarted) => {
          closeNewSession();
          if (agentStarted) actions.agentStarted(newSessionMachineId, paneId);
          selectTarget(newSessionMachineId, paneId);
          void load();
        }}
      /></MachineContext.Provider>
      {machineDialog && <MachineDialog updateRemote={updateRemote} machine={machineDialog === "new" ? undefined : machineDialog} onClose={closeMachineDialog} onConnected={(id) => { closeMachineDialog(); selectTarget(id, null); void load(); }} />}
      <Droplet onOpen={(machineId, paneId) => {
        // an ended pane's card outlives the pane: the refetch has dropped it, and selecting it attaches nothing
        if (!machinesRef.current.find((m) => m.id === machineId)?.snapshot?.panes.some((p) => p.pane_id === paneId)) return;
        // Files lists the pane it was opened on, and would open its paths on the new one
        setFilesOpen(false);
        selectTargetRef.current(machineId, paneId);
      }} />
      <SettingsDialog auth={auth} herdrVersion={health?.herdr?.version ?? null} open={settingsOpen} section={settingsSection} linkPage={settingsLinkPage} linkSection={settingsLinkSection} onPage={onSettingsPage} onClose={closeSettings} onUsageLogin={(paneId) => { closeSettings(); selectTarget("local", paneId, "terminal"); void load(); }} actions={actions} updates={updates} onEnableNotifications={enableNotifications} saveError={settingsSaveError} overPreview={(viewing !== null && !fileDocked) || diffViewing !== null} />
      {filesOpen && selectedPane && (
        <FilesDialog start={selectedPane.foreground_cwd ?? selectedPane.cwd ?? ""} paneId={selectedPane.pane_id} viewing={(viewing !== null && !fileDocked) || diffViewing !== null} onOpenFile={viewFile}
          onOpenDiff={(comparison, file) => openDiff({ machineId: selectedMachineId, paneId: selectedPane.pane_id, directory: selectedPane.foreground_cwd ?? selectedPane.cwd ?? null, ...comparison, path: file.path, oldPath: file.old_path })}
          onBrowseFolders={(path) => actions.openPalette(folderQueryFor(path, null))}
          onClose={() => setFilesOpen(false)} />
      )}
      {diffViewing !== null && <MachineContext.Provider value={diffViewing.machineId}>
        <RepoDiffViewer key={`${diffViewing.scope}:${diffViewing.path}`} target={diffViewing} onClose={closeDiff} onOpenFile={(path) => {
          const docked = filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel";
          if (docked) {
            setFilesOpen(false);
            releaseDiff();
          }
          openFile({ path, paneId: diffViewing.paneId, machineId: diffViewing.machineId }, docked);
        }} keyboardActive={!settingsOpen && (viewing === null || fileDocked)} />
      </MachineContext.Provider>}
      {viewing !== null && !fileDocked && <MachineContext.Provider value={viewing.machineId}>
        <FileViewer key={viewing.path} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path, presentation })} onKind={reportFileKind} onTogglePresentation={toggleFilePresentation} keyboardActive={!settingsOpen} />
      </MachineContext.Provider>}
      <CommandPalette key={selectedMachineId} machines={machines} onSelect={selectTarget} open={paletteOpen} initialQuery={paletteQuery} onClose={() => setPaletteOpen(false)} snapshot={snapshot} online={selectedMachine?.state === "connected"} selectedPaneId={selectedPaneId} view={view} actions={actions} />
    </div></MachineContext.Provider></MachineSessionsProvider>
  );
}
