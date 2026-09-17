import { useCallback, useEffect, useState } from "react";

import type { SessionSnapshot } from "../shared/protocol.ts";
import { fetchHealth, fetchSession, type HealthInfo } from "./lib/api.ts";
import { paneTitle, Sidebar } from "./components/Sidebar.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";

const APP_TITLE = "herdr web ui";

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

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [connected, setConnected] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchSession();
      setSnapshot(next);
      setError(null);
      setSelectedPaneId((current) => current ?? next.focused_pane_id ?? next.panes[0]?.pane_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

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
