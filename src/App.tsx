import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Lock, Menu, MessageSquare, Moon, PanelLeft, Search, Settings, SquareTerminal, Sun, X } from "lucide-react";

import type { AgentStatus, ClientRole, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { ApiError, authenticate, fetchHealth, fetchSession, sendTestPush, signOut, type HealthInfo } from "./lib/api.ts";
import { displayPaneTitle, paneTitle, Sidebar } from "./components/Sidebar.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { TokenGate } from "./components/TokenGate.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import { NewSessionDialog } from "./components/NewSessionDialog.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { applyPaneStatus } from "./lib/snapshot.ts";
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

const APP_TITLE = "herdr web ui";
const POLL_MS = 5000;
/** trailing debounce for push-triggered refetches: bursts of events become one fetch */
const REFETCH_DEBOUNCE_MS = 500;

/** A notification tapped while the app was closed opens `/?pane=<id>` (public/sw.js). */
function paneFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("pane");
}

/** The lens a pane opens in: remembered per pane; agent panes start as chat, shells as terminal. */
function storedView(paneId: string, hasAgent: boolean): PaneView {
  try {
    const stored = window.localStorage.getItem(`herdr-web-ui:view:${paneId}`);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {
    /* private mode */
  }
  return hasAgent ? "chat" : "terminal";
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
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(paneFromUrl);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [view, setViewState] = useState<PaneView>("terminal");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const snapshotRef = useRef<SessionSnapshot | null>(null);
  snapshotRef.current = snapshot;

  const loadHealth = useCallback(async () => {
    try {
      const next = await fetchHealth();
      setHealth(next);
      if (next.auth) setLocked(next.auth.required && !next.auth.authenticated);
    } catch {
      setHealth(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await fetchSession();
      setSnapshot(next);
      setError(null);
      setLocked(false);
      // a closed pane leaves the selection: fall through to herdr's focus or the first pane
      setSelectedPaneId((current) =>
        current !== null && next.panes.some((pane) => pane.pane_id === current)
          ? current
          : (next.focused_pane_id ?? next.panes[0]?.pane_id ?? null),
      );
    } catch (err) {
      // the auth check runs before every route: 401 means the cookie is missing or
      // stale, and any other answer proves this browser is past the gate
      if (err instanceof ApiError && err.status === 401) {
        setLocked(true);
        return;
      }
      setLocked(false);
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

  // remember the baseline statuses a notification is measured against
  useEffect(() => {
    if (!snapshot) return;
    for (const pane of snapshot.panes) statusRef.current.set(pane.pane_id, pane.agent_status);
  }, [snapshot]);

  const notifyStatus = useCallback((paneId: string, status: AgentStatus) => {
    const previous = statusRef.current.get(paneId);
    statusRef.current.set(paneId, status);
    if (!shouldNotifyStatus(previous, status) || pushOnRef.current) return;
    const pane = snapshotRef.current?.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) return;
    showPaneStatusNotification(paneId, paneTitle(pane), status, () => selectPaneRef.current?.(paneId));
  }, []);

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "error":
          if (message.code === "output_stalled") setOutputStopped(true);
          break;
        case "pane-status":
          setSnapshot((current) => (current ? applyPaneStatus(current, message.pane_id, message.agent_status) : current));
          notifyStatus(message.pane_id, message.agent_status);
          scheduleRefetch(); // derived workspace/tab rollups come from the snapshot
          break;
        case "pane-exited": {
          const pane = snapshotRef.current?.panes.find((candidate) => candidate.pane_id === message.pane_id);
          if (pane && !pushOnRef.current) {
            showPaneEndedNotification(message.pane_id, paneTitle(pane), () => selectPaneRef.current?.(message.pane_id));
          }
          scheduleRefetch();
          break;
        }
        case "session-changed":
          scheduleRefetch();
          break;
        default:
          break; // terminal-level frames are PaneTerminal's business
      }
    },
    [notifyStatus, scheduleRefetch],
  );

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

  const selectPane = useCallback((paneId: string) => {
    setSelectedPaneId(paneId);
    setDrawerOpen(false);
  }, []);
  const selectPaneRef = useRef(selectPane);
  selectPaneRef.current = selectPane;

  // a tapped notification focuses this window and names the pane (public/sw.js)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; pane_id?: unknown } | null;
      if (data?.type === "select-pane" && typeof data.pane_id === "string") selectPaneRef.current(data.pane_id);
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
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  const selectedAgent = selectedPane?.agent ?? null;

  // the lens follows the selected pane: each pane remembers its own
  useEffect(() => {
    if (selectedPaneId === null) return;
    setViewState(storedView(selectedPaneId, selectedAgent !== null));
  }, [selectedPaneId, selectedAgent]);

  const setView = useCallback(
    (next: PaneView) => {
      setViewState(next);
      if (selectedPaneId === null) return;
      try {
        window.localStorage.setItem(`herdr-web-ui:view:${selectedPaneId}`, next);
      } catch {
        /* private mode: the lens just stops being remembered */
      }
    },
    [selectedPaneId],
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
    [selectPane, selectedPaneId, setView, view, updateSettings, resolvedTheme, health, lock, bellVisible, bell.disabled, enableNotifications, load],
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
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
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
          <Brand />
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
          <span className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`} role="status">
            <span className="conn-dot" aria-hidden="true" />
            <span className="conn-text">{connected ? "live" : outputStopped ? "disconnected" : "reconnecting"}</span>
          </span>
          {health ? (
            <span className="pill pill-version" title={`herdr protocol ${health.herdr.protocol}`}>
              herdr {health.herdr.version}
            </span>
          ) : (
            <span className="pill pill-offline">herdr offline</span>
          )}
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
          <button
            type="button"
            className="icon-button header-desktop-only"
            aria-label={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={resolvedTheme === "dark" ? "Light theme" : "Dark theme"}
            onClick={actions.toggleTheme}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </button>
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

      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error ? (
            <div className="error-state" role="alert">
              <p className="error-message">{error}</p>
              <button type="button" className="error-retry" onClick={() => void load()}>
                Retry
              </button>
            </div>
          ) : (
            <Sidebar snapshot={snapshot} selectedPaneId={selectedPaneId} actions={actions} version={health?.herdr.version ?? null} />
          )}
        </aside>

        {drawerOpen && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

        <main className="terminal-host">
          <PaneTerminal
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

      <NewSessionDialog
        open={newSessionOpen}
        defaultCwd={selectedPane?.cwd ?? null}
        onClose={() => setNewSessionOpen(false)}
        onCreated={(paneId) => {
          setNewSessionOpen(false);
          selectPane(paneId);
          void load();
        }}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} actions={actions} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} snapshot={snapshot} selectedPaneId={selectedPaneId} view={view} actions={actions} />
    </div>
  );
}
