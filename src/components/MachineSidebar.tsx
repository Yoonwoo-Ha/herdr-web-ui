import { useState } from "react";
import { ChevronDown, ChevronRight, Download, Monitor, Plus, Settings, SlidersHorizontal } from "lucide-react";
import type { Machine } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { machineRequest } from "../lib/api.ts";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { Sidebar } from "./Sidebar.tsx";
import "./Machines.css";

interface Props { machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; actions: AppActions; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onAdd(): void; onSetup(machine: Machine, update?: boolean): void }
export function MachineSidebar(props: Props) {
  const { canInstall, install } = useInstallPrompt();
  return <div className="sidebar-shell">
    <div className="sidebar-topbar"><button className="btn sidebar-new-session" onClick={props.onAdd}><Monitor /> Add PC</button></div>
    <div className="machine-list" aria-label="PCs and workspaces">
      {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} />)}
      {!props.machines.length && <p className="tree-state" role="status">Loading PCs…</p>}
    </div>
    <footer className="sidebar-footer">{canInstall && <button className="btn btn-ghost sidebar-footer-action" onClick={() => void install()}><Download />Install app</button>}<button className="btn btn-ghost sidebar-footer-action" onClick={props.actions.openSettings}><Settings />Settings</button><span className="sidebar-app-name">herdr web ui</span></footer>
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
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}`} aria-label={`PC ${machine.name}`}>
    <header className="machine-header">
      <button className="machine-toggle" aria-expanded={!collapsed} onClick={() => { setCollapsed(!collapsed); try { localStorage.setItem(`herdr-web-ui:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {} }}>
        {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}<Monitor size={16} /><span>{machine.name}</span>
      </button>
      <button className="icon-button" disabled={!online} aria-label={`New session on ${machine.name}`} onClick={() => props.onNew(machine.id)}><Plus /></button>
      {machine.kind === "ssh" && <button className="icon-button" aria-label={`Manage ${machine.name}`} aria-expanded={editing} onClick={() => { setEditing(!editing); setConfirmDelete(false); }}><SlidersHorizontal /></button>}
    </header>
    <p className={`machine-state${online ? " is-online" : ""}`} role="status">{machine.kind === "local" ? "This PC · " : ""}{machine.state}{machine.error && <span title={machine.error}> · {machine.error}</span>}</p>
    {editing && <div className="machine-controls">
      <form onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }); }}><label className="field"><span className="field-label">PC name</span><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn" type="submit">Rename</button></form>
      <div className="machine-control-buttons"><button className="btn" onClick={() => void mutate("PATCH", { enabled: !machine.enabled })}>{machine.enabled ? "Disconnect" : "Connect"}</button><button className="btn" onClick={() => props.onSetup(machine)}>Reconnect / setup</button><button className="btn" onClick={() => props.onSetup(machine, true)}>Update bridge…</button><button className="btn btn-danger" onClick={() => { if (confirmDelete) void mutate("DELETE"); else setConfirmDelete(true); }}>{confirmDelete ? "Confirm remove PC" : "Remove PC"}</button></div>
      {confirmDelete && <p className="field-hint">Removes this registration. Remote sessions keep running.</p>}
    </div>}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {!collapsed && <div className={online ? "" : "machine-offline"} {...(!online ? { inert: "" } : {})}>
      {!online && !machine.snapshot ? <p className="tree-state" role="status">No saved sessions</p> : <MachineContext.Provider value={machine.id}><Sidebar embedded snapshot={machine.snapshot} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} version={null} /></MachineContext.Provider>}
    </div>}
  </section>;
}
