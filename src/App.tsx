import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionSnapshot } from "../shared/protocol.ts";
import { ApiError, fetchHealth, fetchSession, signOut, type HealthInfo } from "./lib/api.ts";
import { paneTitle, Sidebar } from "./components/Sidebar.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { TokenGate } from "./components/TokenGate.tsx";

const APP_TITLE = "herdr web ui";
const POLL_MS = 5000;

function DrawerIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      {open ? (
        <>
          <path d="M5 5l10 10" />
          <path d="M15 5L5 15" />
        </>
      ) : (
        <>
          <path d="M3.5 5.5h13" />
          <path d="M3.5 10h13" />
          <path d="M3.5 14.5h13" />
        </>
      )}
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="9" width="11" height="7.5" rx="2" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </svg>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

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
      setSelectedPaneId((current) => current ?? next.focused_pane_id ?? next.panes[0]?.pane_id ?? null);
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
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, loadHealth]);

  const unlock = useCallback(() => {
    setLocked(false);
    void loadHealth();
    void load();
  }, [load, loadHealth]);

  const lock = useCallback(async () => {
    setDrawerOpen(false);
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

  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const selectedTitle = selectedPane ? paneTitle(selectedPane) : null;

  useEffect(() => {
    document.title = selectedTitle ? `${selectedTitle} · herdr` : APP_TITLE;
  }, [selectedTitle]);

  if (locked === null) return null;
  if (locked) return <TokenGate onUnlocked={unlock} />;

  return (
    <div className="app">
      <header className="app-header">
        <button
          type="button"
          className="icon-button drawer-toggle"
          aria-label={drawerOpen ? "Close workspace list" : "Open workspace list"}
          aria-expanded={drawerOpen}
          aria-controls="workspace-drawer"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <DrawerIcon open={drawerOpen} />
        </button>
        <h1 className="brand">
          <img src="/icons/icon.svg" alt="" width="22" height="22" className="brand-mark" />
          <span className="brand-name">
            herdr <span className="brand-sub">web ui</span>
          </span>
        </h1>
        {selectedPane && (
          <div className="context" title={`${selectedWorkspace?.label ?? selectedPane.workspace_id} › ${selectedTitle}`}>
            <span className="context-workspace">{selectedWorkspace?.label ?? selectedPane.workspace_id}</span>
            <span className="context-sep" aria-hidden="true">
              ›
            </span>
            <span className="context-pane">{selectedTitle}</span>
          </div>
        )}
        <div className="header-meta">
          <span className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`} role="status">
            <span className="conn-dot" aria-hidden="true" />
            {connected ? "live" : "reconnecting"}
          </span>
          {health ? (
            <span className="pill pill-version" title={`herdr protocol ${health.herdr.protocol}`}>
              herdr {health.herdr.version}
            </span>
          ) : (
            <span className="pill pill-offline">herdr offline</span>
          )}
          {health?.auth?.required && (
            <button type="button" className="icon-button lock-button" aria-label="Lock" title="Lock" onClick={() => void lock()}>
              <LockIcon />
            </button>
          )}
        </div>
      </header>

      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error ? (
            <div className="error-state">
              <p className="error-message">{error}</p>
              <button type="button" className="error-retry" onClick={() => void load()}>
                Retry
              </button>
            </div>
          ) : (
            <Sidebar snapshot={snapshot} selectedPaneId={selectedPaneId} onSelectPane={selectPane} />
          )}
        </aside>

        {drawerOpen && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

        <main className="terminal-host">
          <PaneTerminal paneId={selectedPaneId} onConnectionChange={setConnected} />
        </main>
      </div>
    </div>
  );
}
