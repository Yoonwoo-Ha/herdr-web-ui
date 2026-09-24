import { useState } from "react";
import { ChevronDown, ChevronRight, Download, Monitor, Plus, Settings, SlidersHorizontal } from "lucide-react";
import type { Machine, MachineState } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { machineRequest } from "../lib/api.ts";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { Sidebar } from "./Sidebar.tsx";
import "./Machines.css";

declare const __APP_VERSION__: string;

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone. */
const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

interface Props { machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; actions: AppActions; version: string | null; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onAdd(): void; onSetup(machine: Machine, update?: boolean): void }
export function MachineSidebar(props: Props) {
  const { canInstall, installed, install, help } = useInstallPrompt();
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  // the new session opens on the selected PC, the same one Mod+Shift+N uses
  const target = props.machines.find((machine) => machine.id === props.selectedMachineId);
  return <div className="sidebar-shell">
    <div className="sidebar-topbar sidebar-topbar-row">
      <button className="btn sidebar-new-session" disabled={target !== undefined && target.state !== "connected"} title={target ? `New session on ${target.name}` : "New session"} onClick={props.actions.openNewSession}><Plus aria-hidden="true" />New session</button>
      <button className="btn btn-ghost sidebar-add-pc" onClick={props.onAdd}><Monitor aria-hidden="true" />Add PC</button>
    </div>
    <div className="machine-list" aria-label="PCs and workspaces">
      {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} />)}
      {!props.machines.length && <p className="tree-state" role="status">Loading PCs…</p>}
    </div>
    <footer className="sidebar-footer">
      {/* browsers without an install prompt (iOS, plain HTTP) get the steps instead */}
      {!installed && <button className="btn btn-ghost sidebar-footer-action" aria-expanded={canInstall ? undefined : installHelpOpen} onClick={() => { if (canInstall) void install(); else setInstallHelpOpen(!installHelpOpen); }}><Download aria-hidden="true" />Install app</button>}
      {!installed && !canInstall && installHelpOpen && <p className="sidebar-install-help" role="status">{help}</p>}
      <button className="btn btn-ghost sidebar-footer-action" onClick={props.actions.openSettings}><Settings aria-hidden="true" />Settings</button>
      <div className="sidebar-brandline">
        <span className="sidebar-app-name">herdr web ui v{__APP_VERSION__}</span>
        {props.version && <span className="pill">herdr {props.version}</span>}
      </div>
    </footer>
  </div>;
}

function MachineGroup({ machine, ...props }: Props & { machine: Machine }) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`herdr-web-ui:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  const mutate = async (method: string, body?: unknown) => {
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); if (method === "DELETE" && props.selectedMachineId === machine.id) props.onSelect("local", null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(`herdr-web-ui:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}`} aria-label={`PC ${machine.name}`}>
    <header className="machine-header">
      <button className="machine-toggle" aria-expanded={!collapsed} onClick={toggle}>
        {collapsed ? <ChevronRight className="machine-caret" aria-hidden="true" /> : <ChevronDown className="machine-caret" aria-hidden="true" />}
        <Monitor className="machine-icon" aria-hidden="true" />
        <span className="machine-name">{machine.name}</span>
        {machine.kind === "local" && <span className="machine-kind">This PC</span>}
        <span className={`machine-dot is-${machine.state}`} title={STATE_WORD[machine.state]} aria-hidden="true" />
      </button>
      <button className="sidebar-row-action" disabled={!online} aria-label={`New session on ${machine.name}`} title="New session" onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
      {machine.kind === "ssh" && <button className="sidebar-row-action" aria-label={`Manage ${machine.name}`} title="Manage PC" aria-expanded={editing} onClick={() => { setEditing(!editing); setConfirmDelete(false); }}><SlidersHorizontal aria-hidden="true" /></button>}
    </header>
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    <p className={`machine-state is-${machine.state}${online ? " visually-hidden" : ""}`} role="status" title={machine.error ?? undefined}>
      <span className="machine-state-word">{STATE_WORD[machine.state]}</span>
      {machine.error && <span className="machine-state-detail">{machine.error}</span>}
    </p>
    {editing && <div className="machine-controls">
      <form onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }); }}><label className="field"><span className="field-label">PC name</span><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn" type="submit">Rename</button></form>
      <div className="machine-control-buttons"><button className="btn" onClick={() => void mutate("PATCH", { enabled: !machine.enabled })}>{machine.enabled ? "Disconnect" : "Connect"}</button><button className="btn" onClick={() => props.onSetup(machine)}>Reconnect / setup</button><button className="btn" onClick={() => props.onSetup(machine, true)}>Update bridge…</button><button className="btn btn-danger" onClick={() => { if (confirmDelete) void mutate("DELETE"); else setConfirmDelete(true); }}>{confirmDelete ? "Confirm remove PC" : "Remove PC"}</button></div>
      {confirmDelete && <p className="field-hint">Removes this registration. Remote sessions keep running.</p>}
    </div>}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {!collapsed && <div className={online ? "" : "machine-offline"} {...(!online ? { inert: "" } : {})}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">No saved sessions</p> : <MachineContext.Provider value={machine.id}><Sidebar embedded snapshot={machine.snapshot} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} version={null} /></MachineContext.Provider>}
    </div>}
  </section>;
}
