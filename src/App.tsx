import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Lock, Menu, MessageSquare, PanelLeft, Search, Settings, SquareTerminal, X } from "lucide-react";

import type { AgentStatus, ClientRole, ServerMessage } from "../shared/protocol.ts";
import { ApiError, authenticate, fetchHealth, fetchBridgeHealth, fetchMachines, sendTestPush, signOut, type HealthInfo } from "./lib/api.ts";
import { displayPaneTitle, paneTitle } from "./components/Sidebar.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { TokenGate } from "./components/TokenGate.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import { NewSessionDialog } from "./components/NewSessionDialog.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { MachineContext } from "./lib/machineContext.tsx";
import { MachineActionBanner, MachineSidebar } from "./components/MachineSidebar.tsx";
import { MachineDialog } from "./components/MachineDialog.tsx";
import { paneStorageId, type Machine, type MachineEvent } from "../shared/machines.ts";
import { takeAuthTokenFromUrl } from "./lib/authLink.ts";
import { useSettings } from "./lib/settings.ts";
import { useShortcuts } from "./lib/shortcuts.ts";
import type { AppActions, PaneView } from "./lib/actions.ts";
import {
  notificationState,
  requestNotificationPermission,
  shouldNotifyStatus,
  showPaneEndedNotification,
  showPaneStatusNotification,
  type NotificationState,
} from "./lib/notifications.ts";
import { ensurePushSubscription, pushSupported, removePushSubscription } from "./lib/push.ts";
import { useUpdates } from "./lib/updates.ts";
import { UpdateNotice } from "./components/UpdateControls.tsx";

const APP_TITLE = "herdr web ui";
const POLL_MS = 5000;
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
 * and guessing terminal flashed it for the seconds before the snapshot arrived.
 */
function storedView(paneId: string, machineId: string, hasAgent: boolean | null): PaneView {
  try {
    const stored = window.localStorage.getItem(`herdr-web-ui:view:${paneStorageId(machineId, paneId)}`);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {
    /* private mode */
  }
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
  const { settings, resolvedTheme, update: updateSettings } = useSettings();
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
  const [newSessionMachineId, setNewSessionMachineId] = useState("local");
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const updates = useUpdates(locked === false);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(() => {
    if (paneFromUrl()) return paneFromUrl();
    return storedSelection()?.pane_id ?? null;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [view, setViewState] = useState<PaneView>("terminal");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
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
  const refetchTimer = useRef<number | null>(null);
  const snapshotRef = useRef<typeof snapshot>(null);
  snapshotRef.current = snapshot;

  const loadHealth = useCallback(async () => {
    try { const next = await fetchBridgeHealth(); setLocked(next.auth.required && !next.auth.authenticated); }
    catch { /* retain the gate while the connection server restarts */ }
    try { setHealth(await fetchHealth()); } catch { setHealth(null); }
  }, []);
  const load = useCallback(async () => {
    try { const next = await fetchMachines(); setMachines(next); setError(null); setLocked(false); }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) { setLocked(true); return; }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const tick = (): void => {
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
    return () => {
      disposed = true;
      window.clearInterval(timer);
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

  // One SSE subscription watches every PC, even when no terminal is selected.
  useEffect(() => {
    if (locked !== false) return;
    const seed = (list: Machine[]) => {
      for (const machine of list) for (const pane of machine.snapshot?.panes ?? []) {
        statusRef.current.set(paneStorageId(machine.id, pane.pane_id), pane.agent_status);
      }
    };
    const events = new EventSource("/api/machines/events");
    events.onmessage = (event) => {
      let payload: MachineEvent;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === "machines") { seed(payload.machines); setMachines(payload.machines); return; }
      const machine = machinesRef.current.find((m) => m.id === payload.machine_id);
      if (!machine) return;
      const message = payload.message;
      if (message.type === "pane-status") {
        const key = paneStorageId(machine.id, message.pane_id);
        const previous = statusRef.current.get(key);
        statusRef.current.set(key, message.agent_status);
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        if (pane && shouldNotifyStatus(previous, message.agent_status) && !pushOnRef.current) showPaneStatusNotification(message.pane_id, `${machine.name} · ${paneTitle(pane)}`, message.agent_status, () => selectTargetRef.current(machine.id, message.pane_id), machine.id);
        setMachines((list) => list.map((m) => m.id === machine.id && m.snapshot ? { ...m, snapshot: { ...m.snapshot, panes: m.snapshot.panes.map((p) => p.pane_id === message.pane_id ? { ...p, agent_status: message.agent_status } : p) } } : m));
      }
      if (message.type === "pane-exited" && !pushOnRef.current) {
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        if (pane) showPaneEndedNotification(message.pane_id, `${machine.name} · ${paneTitle(pane)}`, () => selectTargetRef.current(machine.id, message.pane_id), machine.id);
      }
      if (message.type === "session-changed" || message.type === "pane-exited") scheduleRefetch();
    };
    return () => events.close();
  }, [locked, scheduleRefetch]);

  const handleServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === "error" && message.code === "output_stalled") setOutputStopped(true);
  }, []);

  const enableNotifications = useCallback(async () => {
    const next = notificationState() === "granted" ? "granted" : await requestNotificationPermission();
    setNotifications(next);
    if (next !== "granted") return;
    try {
      const endpoint = await ensurePushSubscription();
      setPushOn(endpoint !== null);
      // the confirmation push proves the whole path (server -> push service -> this device)
      if (endpoint) await sendTestPush(endpoint);
    } catch (err) {
      console.warn("web push unavailable, alerts stay tab-only", err);
    }
  }, []);

  // a device that already allowed alerts re-registers on every load: idempotent, and it
  // brings the device back if the server lost its subscriptions
  useEffect(() => {
    if (locked !== false || notifications !== "granted" || !pushSupported()) return;
    let cancelled = false;
    ensurePushSubscription()
      .then((endpoint) => {
        if (!cancelled) setPushOn(endpoint !== null);
      })
      .catch(() => {
        if (!cancelled) setPushOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locked, notifications]);

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

  const selectTarget = useCallback((machineId: string, paneId: string | null) => {
    setSelectedMachineId(machineId); setSelectedPaneId(paneId); setDrawerOpen(false);
    setConnected(false); setOutputStopped(false);
    storeSelection(machineId, paneId);
  }, []);
  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;
  useEffect(() => {
    if (selectedPaneId !== null || !snapshot || selectedMachine?.state !== "connected") return;
    setSelectedPaneId(snapshot.focused_pane_id ?? snapshot.panes[0]?.pane_id ?? null);
  }, [snapshot, selectedPaneId, selectedMachine?.state]);
  useEffect(() => {
    storeSelection(selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);

  const selectPane = useCallback((paneId: string) => {
    setSelectedPaneId(paneId);
    setDrawerOpen(false);
  }, []);

  // a tapped notification focuses this window and names the pane (public/sw.js)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; pane_id?: unknown; machine_id?: unknown } | null;
      if (data?.type === "select-pane" && typeof data.pane_id === "string") selectTargetRef.current(typeof data.machine_id === "string" ? data.machine_id : "local", data.pane_id);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // the ?pane= a notification opened us with has done its job once it selected the pane
  useEffect(() => {
    if (paneFromUrl() !== null) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const targetHerdr = selectedMachineId === "local" ? health?.herdr : selectedMachine?.herdr;
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  const selectedAgent = selectedPane?.agent ?? null;

  // the lens follows the selected pane: each pane remembers its own
  useEffect(() => {
    if (selectedPaneId === null) return;
    setViewState(storedView(selectedPaneId, selectedMachineId, selectedPane ? selectedAgent !== null : null));
  }, [selectedPaneId, selectedMachineId, selectedPane !== null, selectedAgent !== null]);

  const setView = useCallback(
    (next: PaneView) => {
      setViewState(next);
      if (selectedPaneId === null) return;
      try {
        window.localStorage.setItem(`herdr-web-ui:view:${paneStorageId(selectedMachineId, selectedPaneId)}`, next);
      } catch {
        /* private mode: the lens just stops being remembered */
      }
    },
    [selectedPaneId, selectedMachineId],
  );

  const bell =
    notifications !== "granted"
      ? { label: "Enable notifications", title: "Notify me when a pane needs input or finishes", disabled: false }
      : pushOn
        ? { label: "Alerts on", title: "Alerts on — pushed to this device, even with the app closed", disabled: true }
        : pushSupported()
          ? { label: "Alerts on in this tab", title: "Alerts on while this tab is open — tap to get them with the app closed too", disabled: false }
          : {
              label: "Alerts on in this tab",
              title: "Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app)",
              disabled: true,
            };
  const bellVisible = notifications !== "unsupported" && notifications !== "denied";

  useEffect(() => {
    document.title = selectedTitle ? `${selectedTitle} · herdr` : APP_TITLE;
  }, [selectedTitle]);

  const actions = useMemo<AppActions>(
    () => ({
      selectPane,
      selectAdjacentPane: (direction) => {
        const panes = snapshotRef.current?.panes ?? [];
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
        setNewSessionOpen(true);
      },
      openPalette: () => setPaletteOpen(true),
      openSettings: () => {
        setDrawerOpen(false);
        setSettingsOpen(true);
      },
      toggleSidebar: () => {
        if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen((open) => !open);
        else setSidebarCollapsed((collapsed) => !collapsed);
      },
      toggleTheme: () => updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" }),
      lock: health?.auth?.required ? () => void lock() : null,
      enableNotifications: bellVisible && !bell.disabled ? () => void enableNotifications() : null,
      refresh: () => void load(),
    }),
    [selectPane, selectedPaneId, selectedMachineId, setView, view, updateSettings, resolvedTheme, health, lock, bellVisible, bell.disabled, enableNotifications, load],
  );

  useShortcuts(actions, locked === false);

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
                <span>Connecting to herdr web ui…</span>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (locked) return <TokenGate onUnlocked={unlock} />;

  return (
    <MachineContext.Provider value={selectedMachineId}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header className="app-header">
        <button
          type="button"
          className="icon-button drawer-toggle"
          aria-label={drawerOpen ? "Close workspace list" : "Open workspace list"}
          aria-expanded={drawerOpen}
          aria-controls="workspace-drawer"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? <X /> : <Menu />}
        </button>
        <button
          type="button"
          className="icon-button header-desktop-only sidebar-toggle"
          aria-label={sidebarCollapsed ? "Show workspace list" : "Hide workspace list"}
          aria-pressed={!sidebarCollapsed}
          title="Toggle sidebar (⌘⇧B)"
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          <PanelLeft />
        </button>
        {selectedPane ? (
          <div className="context" title={`${selectedWorkspace?.label ?? selectedPane.workspace_id} › ${selectedTitle}`}>
            <div className="context-title">
              {selectedAgent && <AgentMark agent={selectedAgent} size={18} />}
              <span className="context-title-text">{selectedTitle}</span>
            </div>
            <div className="context-sub">
              <span className="machine-context-name">{selectedMachine?.name ?? selectedMachineId}</span><span aria-hidden="true"> › </span>
              <span>{selectedWorkspace?.label ?? selectedPane.workspace_id}</span>
              {selectedPane.cwd && (
                <>
                  <span className="context-sep" aria-hidden="true">
                    ›
                  </span>
                  <span>{selectedPane.cwd}</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <><Brand /><span className="machine-context-name">{selectedMachine?.name ?? selectedMachineId}</span></>
        )}
        {selectedPane && (
          <div className="segmented view-switch" role="group" aria-label="Pane view">
            <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")} title="Chat transcript (⌘⇧J)">
              <MessageSquare />
              <span className="header-desktop-only">Chat</span>
            </button>
            <button type="button" aria-pressed={view === "terminal"} onClick={() => setView("terminal")} title="Live terminal (⌘⇧J)">
              <SquareTerminal />
              <span className="header-desktop-only">Terminal</span>
            </button>
          </div>
        )}
        <div className="header-meta">
          <span
            className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`}
            role="status"
            title={targetHerdr ? `herdr ${targetHerdr.version} · protocol ${targetHerdr.protocol}` : undefined}
          >
            <span className="conn-dot" aria-hidden="true" />
            <span className="conn-text">{connected ? "live" : outputStopped ? "disconnected" : "reconnecting"}</span>
          </span>
          {!targetHerdr && <span className="pill pill-offline">herdr offline</span>}
          <button type="button" className="icon-button" aria-label="Command palette" title="Command palette (⌘⇧K)" onClick={() => setPaletteOpen(true)}>
            <Search />
          </button>
          {bellVisible && (
            <button
              type="button"
              className={`icon-button bell-button${notifications === "granted" ? " is-on" : ""}`}
              aria-label={bell.label}
              title={bell.title}
              disabled={bell.disabled}
              onClick={() => void enableNotifications()}
            >
              <Bell />
            </button>
          )}
          <button type="button" className="icon-button" aria-label="Settings" title="Settings (⌘⇧,)" onClick={() => setSettingsOpen(true)}>
            <Settings />
          </button>
          {health?.auth?.required && (
            <button type="button" className="icon-button lock-button header-desktop-only" aria-label="Lock" title="Lock" onClick={() => void lock()}>
              <Lock />
            </button>
          )}
        </div>
      </header>

      <UpdateNotice updates={updates} onOpen={() => setSettingsOpen(true)} />
      <MachineActionBanner machines={machines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>Retry</button></div>}
          <MachineSidebar version={health?.herdr?.version ?? null} machines={machines} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} actions={actions} onSelect={selectTarget} onAdd={() => { setUpdateRemote(false); setMachineDialog("new"); }} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={(id) => { setNewSessionMachineId(id); setNewSessionOpen(true); setDrawerOpen(false); }} />
        </aside>

        {drawerOpen && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

        <main className="terminal-host">
          <PaneTerminal
            key={selectedMachineId}
            paneId={selectedPaneId}
            agent={selectedAgent}
            agentStatus={selectedPane?.agent_status}
            view={view}
            terminalFontSize={settings.terminalFontSize}
            theme={resolvedTheme}
            role={role}
            onRoleAck={setRole}
            onConnectionChange={(next) => { setConnected(next); if (next) setOutputStopped(false); }}
            onServerMessage={handleServerMessage}
          />
        </main>
      </div>

      <MachineContext.Provider value={newSessionMachineId}><NewSessionDialog
        key={newSessionMachineId}
        machineName={machines.find((m) => m.id === newSessionMachineId)?.name ?? newSessionMachineId}
        open={newSessionOpen}
        defaultCwd={newSessionMachineId === selectedMachineId ? selectedPane?.cwd ?? null : null}
        onClose={() => setNewSessionOpen(false)}
        onCreated={(paneId) => {
          setNewSessionOpen(false);
          selectTarget(newSessionMachineId, paneId);
          void load();
        }}
      /></MachineContext.Provider>
      {machineDialog && <MachineDialog updateRemote={updateRemote} machine={machineDialog === "new" ? undefined : machineDialog} onClose={() => setMachineDialog(null)} onConnected={(id) => { setMachineDialog(null); selectTarget(id, null); void load(); }} />}
      <SettingsDialog open={settingsOpen} onClose={closeSettings} actions={actions} updates={updates} />
      <CommandPalette key={selectedMachineId} open={paletteOpen} onClose={() => setPaletteOpen(false)} snapshot={snapshot} selectedPaneId={selectedPaneId} view={view} actions={actions} />
    </div></MachineContext.Provider>
  );
}
