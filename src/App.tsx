import { type CSSProperties, type DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bell, Ellipsis, FolderInput, FolderOpen, Link, Lock, Menu, MessageSquare, PanelLeft, Plus, Search, SquareTerminal, X } from "lucide-react";

import type { AgentStatus, ServerMessage, AccessRefusal, HealthAuth, HerdrPane } from "../shared/protocol.ts";
import { ApiError, authenticate, fetchHealth, fetchBridgeHealth, fetchMachines, fetchSession, pairDevice, routeMissing, sendTestPush, signOut, splitPane, zoomPane, type HealthInfo } from "./lib/api.ts";
import { deviceLabel, takePairCode } from "./lib/phone.ts";
import { displayPaneTitle } from "./components/Sidebar.tsx";
import { PaneCanvas } from "./components/PaneCanvas.tsx";
import { MachineSessionsProvider } from "./lib/machineSessionContext.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "./lib/paneRegion.ts";
import { AccessGate } from "./components/AccessGate.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import { NewSessionDialog, type NewTabTarget } from "./components/NewSessionDialog.tsx";
import { MovePaneMenu } from "./components/MovePaneMenu.tsx";
import { passingFolder, recentDirectories } from "./lib/recent-directories.ts";
import { usePreferencesSync } from "./lib/preferencesSync.ts";
import { TabStrip } from "./components/TabStrip.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { loadedOnSettingsEntry, onSettingsHistory, recordSettings, settingsEntry } from "./lib/settingsHistory.ts";
import { fileFromLink, followMoved, isNavigation, linkSearch, linksSomewhere, NAV_KEY, readLink, resolveLink, slugOf, type AppLink, type CreateDraft, type LinkNote } from "./lib/deepLink.ts";
import { copyText } from "./lib/clipboard.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { MachineContext } from "./lib/machineContext.tsx";
import { MachineActionBanner, MachineSidebar } from "./components/MachineSidebar.tsx";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { storedSidebarWidth } from "./lib/sidebarWidth.ts";
import { MachineDialog } from "./components/MachineDialog.tsx";
import { RowMenu, type RowMenuItem } from "./components/RowMenu.tsx";
import { focusWorkspaceListToggle } from "./lib/focus.ts";
import { headerCrumb, showsChat } from "./lib/headerCrumb.ts";
import { paneStorageId, type Machine, type MachineEvent } from "../shared/machines.ts";
import { takeAuthTokenFromUrl } from "./lib/authLink.ts";
import { applyPaneStatus } from "./lib/snapshot.ts";
import { rosterPanes } from "./lib/dagPane.ts";
import { carryPaneRecords, paneMovedTo, paneMovePending, paneMovesVersion, recordPaneMove, subscribePaneMoves } from "./lib/paneMove.ts";
import { SnapshotRequests } from "./lib/snapshotRequests.ts";
import { alertPrefs, useSettings } from "./lib/settings.ts";
import { useShortcuts } from "./lib/shortcuts.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import { PaneLenses } from "./lib/paneLens.ts";
import { paneContextPress } from "./lib/paneCanvas.ts";
import type { AppActions, PaneView } from "./lib/actions.ts";
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
import { notificationTargetFromSearch, notificationViewForPane, onNotificationTarget, type NotificationTarget } from "./lib/notificationTarget.ts";
import { useUpdates } from "./lib/updates.ts";
import { UpdateNotice } from "./components/UpdateControls.tsx";
import { LanExposureNotice } from "./components/LanExposureNotice.tsx";
import { TelemetryNotice } from "./components/TelemetryControls.tsx";
import { FilesDialog } from "./components/FilesDialog.tsx";
import { FileViewer } from "./components/FileViewer.tsx";
import { OpenFileContext } from "./lib/filePaths.ts";
import { useFileViewer } from "./lib/useFileViewer.ts";
import { useT } from "./lib/i18n.ts";
import { markSelection, selectionStill, type SelectionMark } from "./lib/selectionMark.ts";
import { useScreenWakeLock } from "./lib/wakeLock.ts";
import { watchDrawerSwipe } from "./lib/edgeSwipe.ts";
import { Droplet } from "./components/Droplet.tsx";
import { dropletAllows, endedTurn, seedStatuses, showDroplet, trackTurn, type DropletKind } from "./lib/droplet.ts";
import { canPlayAlertSound, playAlertSound, unlockAlertSound, type AlertSoundKind } from "./lib/alertSound.ts";
import { createAlertTurnPlayer } from "./lib/alertTurns.ts";
import { dockPane, draggedPane, dropSide, otherSlot, PANE_DRAG_TYPE, sameTarget, slotSide, storedSplit, storeSplit, type SplitSide, type SplitSlot, type SplitState, type SplitTarget } from "./lib/split.ts";
import { paneDrag } from "./lib/paneDrag.ts";
import { SplitDropPreview } from "./components/SplitDropPreview.tsx";

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
  const { settings, resolvedTheme, update: updateSettings } = useSettings();
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
  const canSignOut = auth?.authenticated === true && (auth.via === "token" || auth.via === "device");
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
  // the file a link named, opened over its pane once that pane is shown
  const pendingFile = useRef<string | null>(initialLink ? fileFromLink(initialLink) : null);
  // a short word in the header: a link that could not open what it named, or a link copied
  const [headerNote, setHeaderNote] = useState<LinkNote | "copied" | null>(null);
  useEffect(() => {
    if (headerNote === null) return;
    const timer = window.setTimeout(() => setHeaderNote(null), headerNote === "copied" ? 1600 : 8000);
    return () => window.clearTimeout(timer);
  }, [headerNote]);
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
  // a desktop opened by a link that says so starts with the sidebar collapsed, and the address says so while it is
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialLink?.sidebar === "hidden");
  // the width the sidebar's edge was dragged to on this device; null is the density's own
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
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
  const [findRequest, setFindRequest] = useState<{ paneId: string | null; serial: number }>({ paneId: null, serial: 0 });
  // the header's More menu: its button, and whether it opened on a phone-width screen
  const [more, setMore] = useState<{ anchor: HTMLElement; phone: boolean } | null>(null);
  const closeMore = useCallback(() => setMore(null), []);
  // the pane canvas's actions, for the phone's tab menu (TabStrip)
  const paneActionsRef = useRef<((target: HerdrPane) => RowMenuItem[]) | null>(null);
  const moreOpen = more !== null;
  // a sheet stays up through a resize: its palette item follows the header's palette button,
  // which the same breakpoint hides
  useEffect(() => {
    if (!moreOpen) return;
    const media = window.matchMedia("(max-width: 480px)");
    const onChange = (): void => setMore((open) => open && { ...open, phone: media.matches });
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [moreOpen]);
  // the Files dialog, and the file open in the viewer (a path as the chat or the dialog gave it)
  const [filesOpen, setFilesOpen] = useState(false);
  const [movingPane, setMovingPane] = useState<{ machineId: string; paneId: string; anchor: HTMLElement } | null>(null);
  const movingOwner = movingPane ? machines.find((machine) => machine.id === movingPane.machineId) : null;
  const movingLivePane = movingOwner?.state === "connected" ? movingOwner.snapshot?.panes.find((pane) => pane.pane_id === movingPane?.paneId) : null;
  useEffect(() => { if (movingPane && !movingLivePane) setMovingPane(null); }, [movingPane, movingLivePane]);
  const { viewing, openFile, closeFile } = useFileViewer();
  const viewFile = useCallback((path: string) => {
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId]);
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
  const [outputStopped, setOutputStopped] = useState(false);
  const [notifications, setNotifications] = useState<NotificationState>(() => notificationState());
  // this device has a server-side push subscription: alerts come from the server, not the tab
  const [pushOn, setPushOn] = useState(false);
  const pushOnRef = useRef(pushOn);
  pushOnRef.current = pushOn;
  // the shared settings and pins, the same in every browser of this server, once the app is in
  const receivePreferences = usePreferencesSync(locked === false);
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
        setMachineRosterLoaded(true);
        setError(null); setLocked(false);
      });
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) { setLocked(true); return; }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

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

  // The tab a pane is in, from the roster this client has: a pane of the tab a half shows is shown
  // there, so one tab is never drawn twice (two terminals on one pane)
  const tabOf = useCallback((target: SplitTarget): string | undefined =>
    machinesRef.current.find((m) => m.id === target.machineId)?.snapshot?.panes.find((pane) => pane.pane_id === target.paneId)?.tab_id, []);
  const sameTab = useCallback((a: SplitTarget, b: SplitTarget): boolean => {
    if (a.machineId !== b.machineId) return false;
    if (a.paneId === b.paneId) return true;
    const tab = tabOf(a);
    return tab !== undefined && tab === tabOf(b);
  }, [tabOf]);
  /** the pane is in the tab the other half holds, drawn or not: a narrow window keeps the split, and a
   *  pick of that half's pane there trades the halves instead of putting one tab in both */
  const inOtherHalf = useCallback((machineId: string, paneId: string): boolean => {
    const open = splitRef.current;
    return open !== null && sameTab(open.other, { machineId, paneId });
  }, [sameTab]);

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
      title: displayPaneTitle(pane),
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
      // A poll started before this event can carry an older roster or pane status.
      snapshotRequests.current.invalidate();
      if (payload.type === "machines") {
        seedStatuses(statusRef.current, alerting(payload.machines), { started: turnStartRef.current, lasted: lastTurnRef.current });
        setMachines((previous) => sameData(previous, payload.machines) ? previous : payload.machines);
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
        if (pane && shouldNotifyStatus(previous, status) && alertsOnRef.current && !pushOnRef.current && alertsAllow(alertsRef.current, status)) showPaneStatusNotification(message.pane_id, `${machine.name} · ${displayPaneTitle(pane)}`, status, () => selectTargetRef.current(machine.id, message.pane_id, "chat"), machine.id);
        setMachines((list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id !== machine.id || !m.snapshot) return m;
            const snapshot = applyPaneStatus(m.snapshot, message.pane_id, message.agent_status, message.background_tasks, message.background_wait === true, message.plan);
            if (snapshot === m.snapshot) return m;
            changed = true;
            return { ...m, snapshot };
          });
          return changed ? next : list;
        });
      }
      if (message.type === "pane-exited") {
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        const worked = endedTurn(turnStartRef.current, lastTurnRef.current, paneStorageId(machine.id, message.pane_id), Date.now());
        if (pane && dropletAllows(alertsRef.current, "done", worked)) {
          dropIn(machine, pane, "ended");
          chime(machine, pane, "done");
        }
      }
      if (message.type === "pane-exited" && alertsOnRef.current && !pushOnRef.current && alertsRef.current.done !== "off") {
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        if (pane) showPaneEndedNotification(message.pane_id, `${machine.name} · ${displayPaneTitle(pane)}`, () => selectTargetRef.current(machine.id, message.pane_id, "chat"), machine.id);
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
      /* the cookie may still be set: the health answer decides whether the gate shows */
    }
    await loadHealth();
  }, [loadHealth]);

  const selectedMachineRef = useRef(selectedMachineId);
  selectedMachineRef.current = selectedMachineId;
  const selectTarget = useCallback((machineId: string, paneId: string | null, view?: PaneView) => {
    // Only another PC mounts a new terminal (and socket), which reports its own state. A pane
    // on the same PC keeps the connected socket, which never reports again: resetting here
    // left the header on "reconnecting" after every pane switch.
    if (machineId !== selectedMachineRef.current) setConnected(false);
    // a pane of the tab open in the other half is picked by making that half active
    const open = splitRef.current;
    const current = selectionRef.current;
    if (open && paneId !== null && current.paneId !== null && inOtherHalf(machineId, paneId)) {
      setSplit({ other: { machineId: current.machineId, paneId: current.paneId }, bSide: open.bSide, active: otherSlot(open.active) });
    }
    setSelectedMachineId(machineId); setSelectedPaneId(paneId); setAutoSelected(false); setDrawerOpen(false);
    setOutputStopped(false);
    setNotificationViewTarget(view && paneId !== null ? { machine_id: machineId, pane_id: paneId, view } : null);
    // this browser's choice only: herdr's focus, its TUI and every other device stay where they are
    storeSelection(machineId, paneId);
    // a pane picked (a tapped notification, the sidebar, Back) before a link landed supersedes the link
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
  }, [inOtherHalf, setSplit]);
  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;
  // the moves this client asked for and has no answer to yet (MovePaneMenu): the effect below
  // looks again when one ends, since a failed move leaves the selection to it after all
  const movesVersion = useSyncExternalStore(subscribePaneMoves, paneMovesVersion);
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
      // the pane is gone because this client is moving it and the roster outran the answer:
      // the answer names the id to follow (actions.paneMoved), and herdr's focus is not it
      if (paneMovePending(selectedMachineId, selectedPaneId)) return;
      setSelectedPaneId(fallback(current));
      setAutoSelected(true);
    }).catch(() => { /* a failed read is not evidence that the pane disappeared */ });
    return () => { cancelled = true; };
  }, [snapshot, selectedPaneId, selectedMachineId, selectedMachine?.state, movesVersion]);
  useEffect(() => {
    storeSelection(selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);

  const selectPane = useCallback((paneId: string, focusInput = true) => {
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
    const open = splitRef.current;
    const current = selectionRef.current;
    if (open && current.paneId !== null && inOtherHalf(current.machineId, paneId)) {
      setSplit({ other: { machineId: current.machineId, paneId: current.paneId }, bSide: open.bSide, active: otherSlot(open.active) });
    }
    setSelectedPaneId(paneId);
    setNotificationViewTarget(null);
    setAutoSelected(!focusInput);
    setDrawerOpen(false);
  }, [inOtherHalf, setSplit]);

  // a layout call the palette made and the PC refused: a bridge from before the route says so
  // over the pane (the tab's own menu has a line of its own); anything else is logged, as
  // other background failures are
  const layoutRefused = useCallback((what: string, err: unknown): void => {
    if (routeMissing(err)) setLayoutNotice(t("This PC's bridge does not offer this yet"));
    else console.warn(what, err);
  }, [t]);

  // a tapped notification focuses this window and names the pane (public/sw.js)
  useEffect(() => onNotificationTarget((target) => selectTargetRef.current(target.machine_id, target.pane_id, target.view)), []);


  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null);
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const selectedLayout = snapshot?.layouts.find((layout) => layout.tab_id === selectedPane?.tab_id);
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
  // both halves on one tab (a saved split beside a link to its other tab, a pane moved across) would
  // attach the tab's panes twice on the PC's one socket, and the detach of the half that then closes
  // would take the other half's attachment with it: the other half is not drawn while that holds, and
  // the effect below ends the split
  const overlapping = split !== null && split.other.machineId === selectedMachineId
    && (split.other.paneId === selectedPaneId || (otherPane !== null && selectedPane !== null && otherPane.tab_id === selectedPane.tab_id));
  const splitOn = split !== null && wideScreen && selectedPaneId !== null && !overlapping;
  splitShownRef.current = splitOn;
  const otherWorkspace = otherPane ? otherMachine?.snapshot?.workspaces.find((workspace) => workspace.workspace_id === otherPane.workspace_id) ?? null : null;
  const otherHerdr = split?.other.machineId === "local" ? health?.herdr : otherMachine?.herdr;
  const otherAttach = otherHerdr?.terminal_attach !== false || otherHerdr?.terminal_mirror === true;

  // the other half's pane closed: another pane of its tab takes its place, else back to one pane.
  // Both halves on one tab (a pane moved in) is one tab too many. An offline PC's cached roster
  // cannot say so, as for the selection itself
  const otherTabRef = useRef<string | null>(null);
  if (otherPane) otherTabRef.current = otherPane.tab_id;
  useEffect(() => {
    if (!split || !machineRosterLoaded) return;
    const selected = selectedPaneId === null ? null : { machineId: selectedMachineId, paneId: selectedPaneId };
    if (selected && sameTab(split.other, selected)) { endSplit(split.active); return; }
    if (!otherMachine) { endSplit(split.active); return; }
    if (!otherMachine.snapshot || otherMachine.state !== "connected") return;
    const panes = otherMachine.snapshot.panes;
    if (panes.some((pane) => pane.pane_id === split.other.paneId)) return;
    const tabId = otherTabRef.current;
    const focused = otherMachine.snapshot.layouts.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
    const heir = panes.find((pane) => pane.tab_id === tabId && pane.pane_id === focused) ?? panes.find((pane) => pane.tab_id === tabId);
    if (heir) setSplit({ ...split, other: { machineId: split.other.machineId, paneId: heir.pane_id } });
    else endSplit(split.active);
  }, [split, machineRosterLoaded, otherMachine, selectedMachineId, selectedPaneId, endSplit, setSplit, sameTab]);

  /** A split change and the pane it selects. The half that becomes active keeps its terminals: only
   *  a half whose pane moves to another PC attaches again and reports its connection. */
  // `keepFocus`: the focus already went somewhere in the half made active (a Tab onto one of its
  // buttons): the half's terminal and composer must not take the keyboard from it (autoSelected)
  const applySplit = (next: SplitState | null, select: SplitTarget, keepFocus = false): void => {
    const was = splitOn ? split : null;
    const current: SplitTarget | null = selectedPaneId === null ? null : { machineId: selectedMachineId, paneId: selectedPaneId };
    const after: SplitSlot = next ? next.active : was && sameTarget(select, was.other) ? otherSlot(was.active) : was ? was.active : soloSlot;
    const before = was ? (was.active === after ? current : was.other) : after === soloSlot ? current : null;
    if (before === null || before.machineId !== select.machineId) setConnected(false);
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
    // read the state from before the event: as two steps the second would undo the first and leave one
    // tab in both halves, which ends the split
    applySplit({ other: { machineId: selectedMachineId, paneId: selectedPaneId }, bSide: open.bSide, active: slot }, { machineId, paneId }, !focusInput);
  };
  /** A pane dropped at a point: the half under it opens the pane. A pane of a tab a half already
   *  shows counts as that half's own pane, and is then picked in it. */
  const dockAt = (dragged: SplitTarget, x: number, y: number): void => {
    const box = paneAreaRef.current?.getBoundingClientRect();
    const inside = !!box && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    const side = box && inside ? dropSide(x, box.left, box.width, dropAtRef.current) : null;
    clearDropPreview();
    if (side === null || !wideScreen || selectedPaneId === null) return;
    const current = { machineId: selectedMachineId, paneId: selectedPaneId };
    const shown = sameTab(dragged, current) ? current : splitOn && sameTab(dragged, split.other) ? split.other : dragged;
    const result = dockPane(splitOn ? split : null, current, shown, side, soloSlot);
    if (!result) {
      if (shown === current && !sameTarget(dragged, current)) selectPane(dragged.paneId);
      return;
    }
    applySplit(result.split, sameTarget(result.select, shown) ? dragged : result.select);
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
    // a move gives the pane a new id (lib/paneMove.ts): the same pane, so the same entry
    const sameMoved = previous !== null && previous.machine === link.machine && paneMovedTo(previous.machine, previous.pane) === link.pane;
    if (previous !== null && !popped && !sameMoved && !autoSelected && !settingsOpen && !newSessionOpen && isNavigation(previous, link)) window.history.pushState({ [NAV_KEY]: true }, "", url);
    else window.history.replaceState(window.history.state, "", url);
  }, [locked, machines.length, snapshot, linkLanded, selectedMachineId, selectedPaneId, linkWorkspaceId, linkSlug, linkFile, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, newSessionOpen, newTab, newFields, wideScreen, sidebarCollapsed, autoSelected]);


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
      const link = readLink(window.location.search);
      // before the PCs are in, nothing can say the entry's PC is still set up: it waits as a link
      // opened with the page does, settled against its roster or answered with a note once they are
      if (machinesRef.current.length === 0) {
        if (!link.pane && !link.workspace) return;
        selectTargetRef.current(link.machine, link.pane, link.view ?? undefined);
        pendingLink.current = link; pendingFile.current = null; setLinkLanded(false);
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
        const target = followMoved(link, paneMovedTo(link.machine, link.pane), machine?.snapshot);
        const pane = machine?.snapshot ? resolveLink(machine.snapshot, target).pane : target.pane;
        if (pane === null) return;
        const current = selectionRef.current;
        // the entry's lens is drawn over the pane's own, as a tapped notification's is. Where it
        // lands is written over the entry, so Forward keeps the entries after it
        if (current.machineId !== link.machine || current.paneId !== pane) { poppedTo.current = true; selectTargetRef.current(link.machine, pane, target.pane === pane ? link.view ?? undefined : undefined); return; }
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
  const connWord = t(connected ? "live" : outputStopped ? "disconnected" : "reconnecting");
  const crumb = selectedPane && selectedTitle !== null
    ? headerCrumb({ machine: selectedMachine?.name ?? selectedMachineId, workspace: selectedWorkspace?.label ?? selectedPane.workspace_id, title: selectedTitle, cwd: selectedPane.cwd })
    : null;

  useEffect(() => {
    document.title = selectedTitle ? `${selectedTitle} · herdr` : APP_TITLE;
  }, [selectedTitle]);

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
      toggleView: () => setView(view === "chat" ? "terminal" : "chat"),
      openNewSession: () => {
        setDrawerOpen(false);
        setNewSessionMachineId(selectedMachineId);
        setNewTab(null);
        setNewSessionOpen(true);
      },
      openNewTab: (target) => {
        const machineId = target?.machineId ?? selectionRef.current.machineId;
        const roster = machinesRef.current.find((m) => m.id === machineId)?.snapshot;
        // pane ids repeat across PCs: the selected pane counts only on the PC the tab is for
        const selectedPaneId = selectionRef.current.machineId === machineId ? selectionRef.current.paneId : null;
        const workspaceId = target?.workspaceId ?? roster?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id;
        const workspace = roster?.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
        if (!roster || !workspace) return;
        // the tab's folder is the workspace's: a worktree's checkout, else where the pane in
        // front (the selected one, else the one herdr has in front, else the first) is
        const panes = roster.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
        const inFront = panes.find((pane) => pane.pane_id === selectedPaneId)
          ?? panes.find((pane) => pane.pane_id === roster.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
          ?? panes[0];
        setDrawerOpen(false);
        setNewSessionMachineId(machineId);
        setNewTab({ workspaceId: workspace.workspace_id, workspaceLabel: workspace.label, cwd: workspace.worktree?.checkout_path ?? inFront?.cwd ?? null, number: workspace.tab_count + 1 });
        setNewSessionOpen(true);
      },
      openPalette: () => setPaletteOpen(true),
      paneMoved: (machineId, previousPaneId, paneId) => {
        if (previousPaneId === paneId) return;
        carryPaneRecords(machineId, previousPaneId, paneId);
        recordPaneMove(machineId, previousPaneId, paneId);
        lenses.move(paneStorageId(machineId, previousPaneId), paneStorageId(machineId, paneId));
        // the new id is selected before a snapshot without the old one can fall the selection
        // back to herdr's focus; a pane moved from the sidebar while another is open stays unselected
        const current = selectionRef.current;
        if (current.machineId === machineId && current.paneId === previousPaneId) selectPane(paneId);
      },
      openFind: () => {
        if (selectedPaneId === null) return;
        setView("terminal");
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
      lock: canSignOut ? () => void lock() : null,
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
  // pane's title, and the palette is the menu's first item.
  const paletteItem: RowMenuItem = { id: "palette", label: t("Command palette"), icon: Search, run: () => setPaletteOpen(true) };
  // a link to a PC this app does not have lands on this PC instead, and says so: the roster lists
  // every configured PC, connected or not, so one missing from it is not set up here
  useEffect(() => {
    const linked = pendingLink.current;
    if (!linked || machines.length === 0 || machines.some((machine) => machine.id === linked.machine)) return;
    pendingLink.current = null; pendingFile.current = null;
    setLinkLanded(true);
    setHeaderNote("machine-missing");
    // no pane: the link's pane id means nothing on another PC, so the pane herdr has in front opens
    selectTarget("local", null);
  }, [machines, selectTarget]);

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

  const moreItems: RowMenuItem[] = [
    ...(selectedPane && !selectedPane.restore_error ? [{ id: "find", label: t("Find in terminal"), icon: Search, run: actions.openFind }] : []),
    ...(selectedPane && selectedWorkspace
      ? [{ id: "new-tab", label: t("New tab"), title: t("New tab in {workspace}", { workspace: selectedWorkspace.label }), icon: Plus, run: () => actions.openNewTab() }]
      : []),
    ...(selectedPane ? [{ id: "move-pane", label: t("Move pane to…"), icon: FolderInput, run: () => {
      const anchor = document.querySelector<HTMLElement>(".header-more-button");
      if (anchor) setMovingPane({ machineId: selectedMachineId, paneId: selectedPane.pane_id, anchor });
    } }] : []),
    ...(selectedPane ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: () => setFilesOpen(true) }] : []),
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
            <p className="tree-state" role="status">
              Connecting…
            </p>
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
    <MachineSessionsProvider machineIds={machines.map((machine) => machine.id)}><MachineContext.Provider value={selectedMachineId}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={sidebarWidth === null ? undefined : { "--sidebar-user-w": `${sidebarWidth}px` } as CSSProperties}>
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
          <button type="button" className="icon-button palette-button" aria-label={t("Command palette")} title={t("Command palette (⌘⇧K)")} onClick={() => setPaletteOpen(true)}>
            <Search />
          </button>
        </div>
        {headerNote ? (
          <div className="context">
            <span className="pill header-note" role="status" style={{ minWidth: 0 }}>
              <span className="context-title-text">{t(headerNote === "copied" ? "Link copied" : headerNote === "pane-closed" ? "That agent has closed: its workspace is open" : headerNote === "machine-missing" ? "That link's PC is not set up here" : "That link's workspace is closed")}</span>
            </span>
          </div>
        ) : selectedPane && crumb ? (
          <div className="context" title={crumb.tooltip}>
            <div className="context-title">
              {selectedAgent && <AgentMark agent={selectedAgent} size={18} />}
              <span className="context-title-text">{selectedTitle}</span>
            </div>
            <div className="context-sub">
              <span className="machine-context-name">{crumb.machine}</span><span className="context-sep" aria-hidden="true">›</span>
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
            <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")} title={t("Chat transcript (⌘⇧J)")}>
              <MessageSquare />
              <span className="header-desktop-only">{t("Chat")}</span>
            </button>
            <button type="button" aria-pressed={view === "terminal"} onClick={() => setView("terminal")} title={terminalAttach ? t("Live terminal (⌘⇧J)") : t("Live terminal: coming to Windows PCs once herdr can attach there")}>
              <SquareTerminal />
              <span className="header-desktop-only">{t("Terminal")}</span>
              {!terminalAttach && <span className="pill pill-soon">{t("soon")}</span>}
            </button>
          </div>
        )}
        <div className="header-meta">
          {/* speaks only while the bridge is not live; live, it stays in the document for a screen
              reader (and the browser scripts that wait on it), drawn by nothing (styles.css) */}
          <span
            className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`}
            role="status"
            title={[connected ? null : connWord, targetHerdr ? t("herdr {version} · protocol {protocol}", { version: targetHerdr.version, protocol: targetHerdr.protocol }) : null].filter((part) => part !== null).join(" · ") || undefined}
          >
            <span className="conn-dot" aria-hidden="true" />
            <span className="conn-text">{connWord}</span>
          </span>
          {!targetHerdr && <span className="pill pill-offline">{t("herdr offline")}</span>}
          {canSignOut && (
            <button type="button" className="icon-button lock-button header-desktop-only" aria-label={t("Sign out")} title={t("Sign out")} onClick={() => void lock()}>
              <Lock />
            </button>
          )}
          {/* with nothing of its own to offer it is still the phone's way to the palette */}
          <span className={`header-more${moreItems.length === 0 ? " is-phone-only" : ""}`}>
            <button
              type="button"
              className="icon-button header-more-button"
              aria-label={alertsOffDot ? t("More · alerts are off") : t("More")}
              title={alertsOffDot ? t("More · alerts are off") : t("More")}
              aria-haspopup="menu"
              aria-expanded={more !== null}
              onClick={(event) => {
                const anchor = event.currentTarget;
                setMore((open) => (open ? null : { anchor, phone: window.matchMedia("(max-width: 480px)").matches }));
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
            items={more.phone ? [paletteItem, ...moreItems] : moreItems}
            onClose={closeMore}
          />
        )}
      </header>

      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>{t("Retry")}</button></div>}
          <MachineSidebar machines={machines} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} actions={actions} onSelect={selectTarget} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={(id) => { setNewSessionMachineId(id); setNewTab(null); setNewSessionOpen(true); setDrawerOpen(false); }} />
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
        </aside>

        {/* kept on the page closed (styles.css): a swipe that begins on it closes the drawer */}
        <div className={`scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />

        {/* a file path in the chat opens in the viewer, relative to the selected pane's folder */}
        <OpenFileContext.Provider value={selectedPaneId !== null ? viewFile : null}>
        <div className={`pane-column${chatShown ? " is-chat" : ""}`}>
        {/* over the pane only: a bar across the window would cut the sidebar off from its top row in the header */}
        <UpdateNotice updates={updates} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <TelemetryNotice enabled={locked === false} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <MachineActionBanner machines={machines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
        {layoutNotice && <p className="pane-notice" role="alert">{layoutNotice}</p>}
        {health?.lan_exposure && <LanExposureNotice host={health.lan_exposure.host} onOpen={() => { setSettingsLinkPage("devices"); setSettingsOpen(true); }} />}
        {/* the pane's tab, or two tabs side by side (lib/split.ts): a tab dragged down out of its strip,
            or a sidebar row dragged over this area, opens its pane in the half it is dropped on */}
        <div ref={paneAreaRef} className={`pane-split${splitOn ? " is-split" : ""}`} onDragOverCapture={paneDragOver} onDragLeave={paneDragLeave} onDropCapture={paneDrop}>
          {(["a", "b"] as const).map((slot) => {
            // one pane: the solo slot, or a split's active half where the window is too narrow for both
            if (!splitOn && slot !== (split ? split.active : soloSlot)) return null;
            const active = !splitOn || split.active === slot;
            const machineId = active ? selectedMachineId : split.other.machineId;
            const paneId = active ? selectedPaneId : split.other.paneId;
            const machine = active ? selectedMachine : otherMachine;
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
            return (
              <MachineContext.Provider key={slot} value={machineId}>
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
                {splitOn && (
                  <div className="pane-slot-bar">
                    {pane?.agent && <AgentMark agent={pane.agent} size={14} />}
                    <span className="pane-slot-title" title={pane ? displayPaneTitle(pane) : undefined}>{pane ? displayPaneTitle(pane) : t("Pane closed")}</span>
                    {machines.length > 1 && <span className="pane-slot-machine">{machine?.name ?? machineId}</span>}
                    <button type="button" className="icon-button pane-slot-action" aria-label={t(slotView === "chat" ? "Show the terminal" : "Show the chat")} title={t(slotView === "chat" ? "Show the terminal" : "Show the chat")} onClick={toggleSlotView}>
                      {slotView === "chat" ? <SquareTerminal /> : <MessageSquare />}
                    </button>
                    <button type="button" className="icon-button pane-slot-action" aria-label={t("Close this half")} title={t("Close this half")} onClick={() => closeSlot(slot)}>
                      <X />
                    </button>
                  </div>
                )}
                {slotSnapshot && pane && workspace && (
                  <TabStrip snapshot={slotSnapshot} workspace={workspace} selectedPane={pane} panelId={slotPanelId} splitDrag={wideScreen} onSelectPane={onSelect}
                    onNewTab={() => actions.openNewTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
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
                    isTerminal={(item) => lensOf(item) === "terminal"}
                    renderPane={(item, itemActive, herdrSplit) => <OpenFileContext.Provider value={item ? (path) => openFile({ path, paneId: item.pane_id, machineId }) : null}>
                      <PaneTerminal
                        title={item ? displayPaneTitle(item) : active ? selectedTitle : null}
                        // Wait for the roster before attaching: the loading placeholder is replaced
                        // by the keyed tile, and must never claim the pane on a throwaway connection.
                        paneId={item?.restore_error ? null : item?.pane_id ?? null}
                        restoreError={item?.restore_error ?? null}
                        agent={item?.agent ?? null}
                        agentStatus={item?.agent_status}
                        backgroundTasks={item?.background_tasks ?? 0}
                        // an offline PC's cached plan cannot be read
                        plan={machine?.state === "connected" ? (item as HerdrPane | undefined)?.plan ?? null : null}
                        backgroundWait={item?.background_wait === true}
                        cwd={item?.cwd ?? null}
                        machineName={machine?.name ?? machineId}
                        view={item ? lensOf(item) : slotView}
                        // the other half never takes the keyboard: a press in it makes it active first
                        active={active && itemActive}
                        findRequest={active && findRequest.paneId === item?.pane_id ? findRequest.serial : 0}
                        autoSelected={active ? autoSelected : true}
                        terminalFontSize={settings.terminalFontSize}
                        split={herdrSplit || splitOn}
                        terminalCursorStyle={settings.terminalCursorStyle}
                        terminalCursorBlink={settings.terminalCursorBlink}
                        terminalWheelSpeed={settings.terminalWheelSpeed}
                        terminalFontFamily={settings.terminalFontFamily}
                        theme={resolvedTheme}
                        palette={settings.palette}
                        onConnectionChange={active && itemActive ? (next) => { setConnected(next); if (next) setOutputStopped(false); } : undefined}
                        onServerMessage={active && itemActive ? handleServerMessage : undefined}
                      />
                    </OpenFileContext.Provider>} />
                  </div>
                </main>
              </div>
              </MachineContext.Provider>
            );
          })}
          <SplitDropPreview visible={splitDragOn && (paneDragging || tabDrag !== null)} side={dropAt} />
        </div>
        </div>
        </OpenFileContext.Provider>
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
          if (agentStarted) lenses.startedAgent(paneStorageId(newSessionMachineId, paneId), window.matchMedia?.("(pointer: coarse)").matches === true);
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
      {movingPane && movingLivePane && movingOwner?.snapshot && <MachineContext.Provider value={movingPane.machineId}><MovePaneMenu anchor={movingPane.anchor} snapshot={movingOwner.snapshot} pane={movingLivePane}
        paneTitle={displayPaneTitle(movingLivePane)} onMoved={(moved) => actions.paneMoved(movingPane.machineId, moved.previous_pane_id, moved.pane.pane_id)}
        onError={(reason) => setLayoutNotice(t("Move failed: {reason}", { reason }))} onClose={() => setMovingPane(null)} /></MachineContext.Provider>}
      <SettingsDialog auth={auth} herdrVersion={health?.herdr?.version ?? null} open={settingsOpen} section={settingsSection} linkPage={settingsLinkPage} linkSection={settingsLinkSection} onPage={onSettingsPage} onClose={closeSettings} actions={actions} updates={updates} onEnableNotifications={enableNotifications} overPreview={viewing !== null} />
      {filesOpen && selectedPane && (
        <FilesDialog start={selectedPane.foreground_cwd ?? selectedPane.cwd ?? ""} viewing={viewing !== null} onOpenFile={viewFile} onClose={() => setFilesOpen(false)} />
      )}
      {viewing !== null && <MachineContext.Provider value={viewing.machineId}>
        <FileViewer key={viewing.path} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path })} keyboardActive={!settingsOpen} />
      </MachineContext.Provider>}
      <CommandPalette key={selectedMachineId} machines={machines} onSelect={selectTarget} open={paletteOpen} onClose={() => setPaletteOpen(false)} snapshot={snapshot} online={selectedMachine?.state === "connected"} selectedPaneId={selectedPaneId} view={view} actions={actions} />
    </div></MachineContext.Provider></MachineSessionsProvider>
  );
}
