import type { UpdatesModel } from "../lib/updates.ts";
import "./UpdateControls.css";

export function UpdateControls({ updates }: { updates: UpdatesModel }) {
  const { status, error, busy, needsReload, request } = updates;
  return <section className="settings-section settings-updates">
    <h3>Updates</h3>
    <p className="settings-hint">{status?.current_revision ? `Running ${status.current_revision.slice(0, 12)}` : "herdr web ui"}</p>
    <p className="settings-hint" role="status">
      {error ?? status?.error ?? status?.blocked_reason ?? (busy ?
        status?.phase === "building" ? "Installing dependencies and building…" : status?.phase === "restarting" ? "Restarting the bridge…" : "Checking for updates…" :
        status?.available ? `New version ${status.latest_revision?.slice(0, 12)} available.` : status?.checked_at ? "Up to date." : "Waiting for an update check…")}
    </p>
    {status?.managed && <>
      <p className="settings-hint">Checks every 5 minutes. {status.auto_update ? "Automatic installation is enabled." : "Install when you are ready; the bridge briefly reconnects and herdr sessions keep running."}</p>
      <div className="update-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void request("check")}>Check for updates</button>
        <button type="button" className="btn btn-primary" disabled={busy || !status.available || !!status.blocked_reason} onClick={() => void request("install")}>Update and restart</button>
      </div>
    </>}
    {status?.checked_at && <p className="settings-hint">Last checked {new Date(status.checked_at).toLocaleString()}</p>}
    {needsReload && <p className="settings-hint">The server was updated. Save any unsent drafts, then <button type="button" className="btn" onClick={() => window.location.reload()}>Reload app</button></p>}
  </section>;
}

export function UpdateNotice({ updates, onOpen }: { updates: UpdatesModel; onOpen: () => void }) {
  const { status, needsReload } = updates;
  if (!needsReload && !status?.available && status?.phase !== "building" && status?.phase !== "restarting") return null;
  return <div className="update-notice" role="status">
    <span>{needsReload ? "App updated. Save unsent drafts before reloading." : status?.phase === "building" ? "Preparing the update…" : status?.phase === "restarting" ? "Updating; reconnecting shortly…" : "A herdr web ui update is available."}</span>
    <button type="button" className="btn" onClick={needsReload ? () => window.location.reload() : onOpen}>{needsReload ? "Reload app" : "View update"}</button>
  </div>;
}
