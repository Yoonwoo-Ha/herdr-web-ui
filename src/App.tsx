import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Bell, Ellipsis, FolderOpen, Lock, Menu, MessageSquare, PanelLeft, Plus, Search, SquareTerminal, X } from "lucide-react";

import type { AgentStatus, ClientRole, ServerMessage, AccessRefusal, HealthAuth, HerdrPane } from "../shared/protocol.ts";
import { ApiError, authenticate, fetchHealth, fetchBridgeHealth, fetchMachines, fetchSession, pairDevice, sendTestPush, signOut, type HealthInfo } from "./lib/api.ts";
import { deviceLabel, takePairCode } from "./lib/phone.ts";
import { displayPaneTitle } from "./components/Sidebar.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "./lib/paneRegion.ts";
import { AccessGate } from "./components/AccessGate.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import { NewSessionDialog, type NewTabTarget } from "./components/NewSessionDialog.tsx";
import { TabStrip } from "./components/TabStrip.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { onSettingsHistory, recordSettings } from "./lib/settingsHistory.ts";
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
import { SnapshotRequests } from "./lib/snapshotRequests.ts";
import { alertPrefs, useSettings, type DefaultView } from "./lib/settings.ts";
import { useShortcuts } from "./lib/shortcuts.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import type { AppActions, PaneView } from "./lib/actions.ts";
import {
  notificationState,
  requestNotificationPermission,
  shouldNotifyStatus,
  alertsAllow,
  showPaneEndedNotification,
  showPaneStatusNotification,
  type NotificationState,
} from "./lib/notifications.ts";
import { ensurePushSubscription, pushSupported, removePushSubscription } from "./lib/push.ts";
import { onNotificationTarget } from "./lib/notificationTarget.ts";
import { useUpdates } from "./lib/updates.ts";
import { UpdateNotice } from "./components/UpdateControls.tsx";
import { TelemetryNotice } from "./components/TelemetryControls.tsx";
import { FilesDialog } from "./components/FilesDialog.tsx";
import { FileViewer } from "./components/FileViewer.tsx";
import { OpenFileContext } from "./lib/filePaths.ts";
import { useFileViewer } from "./lib/useFileViewer.ts";
import { useT } from "./lib/i18n.ts";
import { useScreenWakeLock } from "./lib/wakeLock.ts";
import { watchDrawerSwipe } from "./lib/edgeSwipe.ts";
import { Droplet } from "./components/Droplet.tsx";
import { dropletAllows, endedTurn, seedStatuses, showDroplet, trackTurn, type DropletKind } from "./lib/droplet.ts";
import { playAlertSound, unlockAlertSound, type AlertSoundKind } from "./lib/alertSound.ts";

const APP_TITLE = "herdr web ui";
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

/** A notification tapped while the app was closed opens `/?pane=<id>` (public/sw.js). */
function paneFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("pane");
}

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
 * The lens a pane opens in: remembered per pane. A pane seen for the first time opens its
 * terminal, except an agent pane on a touch screen, which opens its chat: a phone reads a
 * conversation better than a TUI sized for a desktop. Until the snapshot says whether the
 * pane has an agent (null), a touch screen guesses chat: most panes opened there are agents,
 * and guessing terminal flashed it for the seconds before the snapshot arrived. A PC whose
 * herdr has no terminal attach and no mirror either (an older Windows bridge) always opens
 * its chat: its terminal lens is only a notice, so a remembered choice there is not worth
 * keeping. A mirrored PC counts as having a terminal.
 */
function storedView(paneId: string, machineId: string, hasAgent: boolean | null, terminalAttach: boolean, defaultView: DefaultView): PaneView {
  if (!terminalAttach) return "chat";
  try {
    const stored = window.localStorage.getItem(`herdr-web-ui:view:${paneStorageId(machineId, paneId)}`);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {
    /* private mode */
  }
  // Settings' choice for every pane: chat needs an agent, a shell has no conversation to show
  if (defaultView === "chat") return hasAgent !== false ? "chat" : "terminal";
  if (defaultView === "terminal") return "terminal";
  return hasAgent !== false && window.matchMedia?.("(pointer: coarse)").matches === true ? "chat" : "terminal";
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
  const [selectedMachineId, setSelectedMachineId] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has("pane")) return query.get("machine") ?? "local";
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
    if (paneFromUrl()) return paneFromUrl();
    return storedSelection()?.pane_id ?? null;
  });
  // App picked the selected pane itself because the one selected closed: it must not raise a
  // phone's keyboard (over the drawer the close was tapped in) until the user picks a pane or lens
  const [autoSelected, setAutoSelected] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenRef = useRef(drawerOpen); drawerOpenRef.current = drawerOpen;
  // from 769px the drawer is a plain sidebar column and its toggle is hidden, so a drawer a
  // narrow window opened must not come back (with its scrim) the next time the window narrows
  const wideScreen = useMediaQuery("(min-width: 769px)");
  useEffect(() => { if (wideScreen) setDrawerOpen(false); }, [wideScreen]);
  const selectionRef = useRef({ machineId: selectedMachineId, paneId: selectedPaneId });
  selectionRef.current = { machineId: selectedMachineId, paneId: selectedPaneId };
  // on a phone the drawer follows a swipe in from the left edge, and a swipe back (lib/edgeSwipe.ts)
  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // the width the sidebar's edge was dragged to on this device; null is the density's own
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [lens, setLens] = useState<{ key: string; view: PaneView }>({ key: "", view: "terminal" });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // the header's More menu: its button, and whether it opened on a phone-width screen
  const [more, setMore] = useState<{ anchor: HTMLElement; phone: boolean } | null>(null);
  const closeMore = useCallback(() => setMore(null), []);
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
  const { viewing, openFile, closeFile } = useFileViewer();
  const viewFile = useCallback((path: string) => {
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // set by a button that points at one section of Settings, for that opening alone
  const [settingsSection, setSettingsSection] = useState<"updates" | null>(null);
  const closeSettings = useCallback(() => { setSettingsOpen(false); setSettingsSection(null); }, []);
  // Settings is in the history (lib/settingsHistory.ts): Back out of its last entry closes it,
  // Forward onto one opens it again, and closing it any other way takes its entries off
  useEffect(() => onSettingsHistory((entry, own) => {
    if (own) return;
    if (entry === null) closeSettings();
    else setSettingsOpen(true);
  }), [closeSettings]);
  useEffect(() => { if (!settingsOpen) recordSettings([]); }, [settingsOpen]);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // the dialog makes a tab in this workspace instead of a workspace, while set
  const [newTab, setNewTab] = useState<NewTabTarget | null>(null);
  const [connected, setConnected] = useState(false);
  const [outputStopped, setOutputStopped] = useState(false);
  // the connection's role: the server's role-ack confirms it (no UI control today)
  const [role, setRole] = useState<ClientRole>("interact");
  const [notifications, setNotifications] = useState<NotificationState>(() => notificationState());
  // this device has a server-side push subscription: alerts come from the server, not the tab
  const [pushOn, setPushOn] = useState(false);
  const pushOnRef = useRef(pushOn);
  pushOnRef.current = pushOn;
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

  // In-app alerts (components/Droplet.tsx): only while the app is on screen - a hidden app has
  // its system notifications - and never for the pane already open in front of the user.
  const dropIn = useCallback((machine: Machine, pane: HerdrPane, kind: DropletKind) => {
    if (!alertsOnRef.current || !alertInAppRef.current || document.visibilityState !== "visible") return;
    const open = selectionRef.current;
    if (open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
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
  const chime = useCallback((machine: Machine, pane: HerdrPane, kind: AlertSoundKind) => {
    if (!alertsOnRef.current || !alertSoundRef.current) return;
    const open = selectionRef.current;
    if (document.visibilityState === "visible" && open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
    playAlertSound(kind);
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
    const events = new EventSource("/api/machines/events");
    events.onmessage = (event) => {
      let payload: MachineEvent;
      try { payload = JSON.parse(event.data); } catch { return; }
      // A poll started before this event can carry an older roster or pane status.
      snapshotRequests.current.invalidate();
      if (payload.type === "machines") {
        seedStatuses(statusRef.current, payload.machines, { started: turnStartRef.current, lasted: lastTurnRef.current });
        setMachines((previous) => sameData(previous, payload.machines) ? previous : payload.machines);
        return;
      }
      const machine = machinesRef.current.find((m) => m.id === payload.machine_id);
      if (!machine) return;
      const message = payload.message;
      if (message.type === "pane-status") {
        const key = paneStorageId(machine.id, message.pane_id);
        const previous = statusRef.current.get(key);
        statusRef.current.set(key, message.agent_status);
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        const worked = trackTurn(turnStartRef.current, key, previous, message.agent_status, Date.now());
        if (worked !== null) lastTurnRef.current.set(key, worked);
        if (pane && shouldNotifyStatus(previous, message.agent_status) && dropletAllows(alertsRef.current, message.agent_status, worked)) {
          const kind = message.agent_status === "blocked" ? "blocked" : "done";
          dropIn(machine, pane, kind);
          chime(machine, pane, kind);
        }
        if (pane && shouldNotifyStatus(previous, message.agent_status) && alertsOnRef.current && !pushOnRef.current && alertsAllow(alertsRef.current, message.agent_status)) showPaneStatusNotification(message.pane_id, `${machine.name} · ${displayPaneTitle(pane)}`, message.agent_status, () => selectTargetRef.current(machine.id, message.pane_id), machine.id);
        setMachines((list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id !== machine.id || !m.snapshot) return m;
            const snapshot = applyPaneStatus(m.snapshot, message.pane_id, message.agent_status, message.background_tasks);
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
        if (pane) showPaneEndedNotification(message.pane_id, `${machine.name} · ${displayPaneTitle(pane)}`, () => selectTargetRef.current(machine.id, message.pane_id), machine.id);
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
  const selectTarget = useCallback((machineId: string, paneId: string | null) => {
    // Only another PC mounts a new terminal (and socket), which reports its own state. A pane
    // on the same PC keeps the connected socket, which never reports again: resetting here
    // left the header on "reconnecting" after every pane switch.
    if (machineId !== selectedMachineRef.current) setConnected(false);
    setSelectedMachineId(machineId); setSelectedPaneId(paneId); setAutoSelected(false); setDrawerOpen(false);
    setOutputStopped(false);
    storeSelection(machineId, paneId);
  }, []);
  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;
  useEffect(() => {
    // An offline PC's cached roster cannot invalidate a selection. Once connected,
    // a closed pane (including one remembered across reloads) must release its selection.
    if (!snapshot || selectedMachine?.state !== "connected") return;
    if (snapshot.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
    const fallback = (current: typeof snapshot) => current.panes.find((pane) => pane.pane_id === current.focused_pane_id)?.pane_id ?? current.panes[0]?.pane_id ?? null;
    if (selectedPaneId === null) { setSelectedPaneId(fallback(snapshot)); return; }
    // The combined roster is cached: a newly created pane can be selected before it
    // appears there. Confirm absence against this PC before discarding the selection.
    let cancelled = false;
    void fetchSession(selectedMachineId).then((current) => {
      if (cancelled || current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
      setSelectedPaneId(fallback(current));
      setAutoSelected(true);
    }).catch(() => { /* a failed read is not evidence that the pane disappeared */ });
    return () => { cancelled = true; };
  }, [snapshot, selectedPaneId, selectedMachineId, selectedMachine?.state]);
  useEffect(() => {
    storeSelection(selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);

  const selectPane = useCallback((paneId: string) => {
    setSelectedPaneId(paneId);
    setAutoSelected(false);
    setDrawerOpen(false);
  }, []);

  // a tapped notification focuses this window and names the pane (public/sw.js)
  useEffect(() => onNotificationTarget((target) => selectTargetRef.current(target.machine_id, target.pane_id)), []);

  // the ?pane= a notification opened us with has done its job once it selected the pane
  useEffect(() => {
    if (paneFromUrl() !== null) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null);
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
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
  const lensKey = JSON.stringify([selectedPaneId, selectedMachineId, selectedPane !== null, selectedAgent !== null, terminalAttach, settings.defaultView]);
  let view = lens.view;
  if (lens.key !== lensKey) {
    if (selectedPaneId !== null) view = storedView(selectedPaneId, selectedMachineId, selectedPane ? selectedAgent !== null : null, terminalAttach, settings.defaultView);
    setLens({ key: lensKey, view });
  }

  const setView = useCallback(
    (next: PaneView) => {
      setLens((current) => ({ ...current, view: next }));
      setAutoSelected(false);
      if (selectedPaneId === null) return;
      try {
        window.localStorage.setItem(`herdr-web-ui:view:${paneStorageId(selectedMachineId, selectedPaneId)}`, next);
      } catch {
        /* private mode: the lens just stops being remembered */
      }
    },
    [selectedPaneId, selectedMachineId],
  );

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
    }),
    [selectPane, selectedPaneId, selectedMachineId, setView, view, updateSettings, resolvedTheme, canSignOut, lock, bellVisible, bell.run, enableNotifications, load],
  );

  useShortcuts(actions, locked === false);

  // The header's More menu: what used to be three buttons of its own. Each item is there under
  // the condition its button had. At phone width the palette's button gives its room to the
  // pane's title, and the palette is the menu's first item.
  const paletteItem: RowMenuItem = { id: "palette", label: t("Command palette"), icon: Search, run: () => setPaletteOpen(true) };
  const moreItems: RowMenuItem[] = [
    ...(selectedPane && selectedWorkspace
      ? [{ id: "new-tab", label: t("New tab"), title: t("New tab in {workspace}", { workspace: selectedWorkspace.label }), icon: Plus, run: () => actions.openNewTab() }]
      : []),
    ...(selectedPane ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: () => setFilesOpen(true) }] : []),
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
    <MachineContext.Provider value={selectedMachineId}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={sidebarWidth === null ? undefined : { "--sidebar-user-w": `${sidebarWidth}px` } as CSSProperties}>
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
        {selectedPane && crumb ? (
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

        {drawerOpen && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

        {/* a file path in the chat opens in the viewer, relative to the selected pane's folder */}
        <OpenFileContext.Provider value={selectedPaneId !== null ? viewFile : null}>
        <div className={`pane-column${chatShown ? " is-chat" : ""}`}>
        {/* over the pane only: a bar across the window would cut the sidebar off from its top row in the header */}
        <UpdateNotice updates={updates} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <TelemetryNotice enabled={locked === false} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <MachineActionBanner machines={machines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
        {snapshot && selectedPane && selectedWorkspace && (
          <TabStrip snapshot={snapshot} workspace={selectedWorkspace} selectedPane={selectedPane} onSelectPane={selectPane} onNewTab={() => actions.openNewTab()} />
        )}
        {/* the tab strip's panel: its id is what each tab's aria-controls points at. No tabIndex -
            the terminal (PaneTerminal) and the composer are the focusable things inside it. */}
        <main className="terminal-host">
          {/* the panel sits inside main, so the page keeps its main landmark; it draws no box */}
          <div id={PANE_TABPANEL_ID} className="terminal-tabpanel" role={tabPanelLabel === null ? undefined : "tabpanel"} aria-label={tabPanelLabel ?? undefined}>
          <PaneTerminal
            key={selectedMachineId}
            paneId={selectedPane?.restore_error ? null : selectedPaneId}
            restoreError={selectedPane?.restore_error ?? null}
            agent={selectedAgent}
            agentStatus={selectedPane?.agent_status}
            backgroundTasks={(selectedPane as HerdrPane | null)?.background_tasks ?? 0}
            cwd={selectedPane?.cwd ?? null}
            machineName={selectedMachine?.name ?? selectedMachineId}
            view={view}
            autoSelected={autoSelected}
            terminalFontSize={settings.terminalFontSize}
            terminalWheelSpeed={settings.terminalWheelSpeed}
            terminalFontFamily={settings.terminalFontFamily}
            theme={resolvedTheme}
            palette={settings.palette}
            role={role}
            onRoleAck={setRole}
            onConnectionChange={(next) => { setConnected(next); if (next) setOutputStopped(false); }}
            onServerMessage={handleServerMessage}
          />
          </div>
        </main>
        </div>
        </OpenFileContext.Provider>
      </div>

      <MachineContext.Provider value={newSessionMachineId}><NewSessionDialog
        key={newSessionMachineId}
        machineName={machines.find((m) => m.id === newSessionMachineId)?.name ?? newSessionMachineId}
        open={newSessionOpen}
        tab={newTab}
        defaultCwd={newSessionMachineId === selectedMachineId ? selectedPane?.cwd ?? null : null}
        onClose={() => setNewSessionOpen(false)}
        onCreated={(paneId) => {
          setNewSessionOpen(false);
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
      <SettingsDialog auth={auth} herdrVersion={health?.herdr?.version ?? null} open={settingsOpen} section={settingsSection} onClose={closeSettings} actions={actions} updates={updates} onEnableNotifications={enableNotifications} overPreview={viewing !== null} />
      {filesOpen && selectedPane && (
        <FilesDialog start={selectedPane.foreground_cwd ?? selectedPane.cwd ?? ""} viewing={viewing !== null} onOpenFile={viewFile} onClose={() => setFilesOpen(false)} />
      )}
      {viewing !== null && <MachineContext.Provider value={viewing.machineId}>
        <FileViewer key={viewing.path} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path })} keyboardActive={!settingsOpen} />
      </MachineContext.Provider>}
      <CommandPalette key={selectedMachineId} open={paletteOpen} onClose={() => setPaletteOpen(false)} snapshot={snapshot} selectedPaneId={selectedPaneId} view={view} actions={actions} />
    </div></MachineContext.Provider>
  );
}
