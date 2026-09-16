import { useCallback, useEffect, useState } from "react";

import type { SessionSnapshot } from "../shared/protocol.ts";
import { fetchHealth, fetchSession, type HealthInfo } from "./lib/api.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  return (
    <div className="app">
      <header className="app-header">
        <button
          type="button"
          className="drawer-toggle"
          aria-label="Toggle workspace list"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          ☰
        </button>
        <h1 className="brand">
          herdr<span className="brand-accent">-br</span>
        </h1>
        <div className="header-meta">
          {selectedPane && <span className="current-pane">{selectedPane.pane_id}</span>}
          {health ? (
            <span className="health ok" title={`herdr protocol ${health.herdr.protocol}`}>
              herdr {health.herdr.version}
            </span>
          ) : (
            <span className="health down">herdr offline</span>
          )}
        </div>
      </header>

      <div className="app-body">
        <aside className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error ? (
            <div className="error-state">
              <p className="error-message">{error}</p>
              <button type="button" onClick={() => void load()}>
                Retry
              </button>
            </div>
          ) : (
            <Sidebar snapshot={snapshot} selectedPaneId={selectedPaneId} onSelectPane={selectPane} />
          )}
        </aside>

        {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}

        <main className="terminal-host">
          <PaneTerminal paneId={selectedPaneId} />
        </main>
      </div>
    </div>
  );
}
