import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { X } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind, WorkspaceCreated } from "../../shared/protocol.ts";
import { ApiError, createWorkspace, fetchAgentKinds } from "../lib/api.ts";

const LAST_AGENT_KEY = "herdr-web-ui:new-session-agent";
const AGENT_ERROR_NOTE_MS = 4000;

type WorkspaceResult = WorkspaceCreated & { error?: { code?: string; message?: string } };

export interface NewSessionDialogProps {
  open: boolean;
  defaultCwd: string | null;
  onClose: () => void;
  onCreated: (paneId: string) => void;
}

function rememberedAgent(): string {
  try {
    return window.localStorage.getItem(LAST_AGENT_KEY) ?? "";
  } catch {
    return "";
  }
}

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? "";
}

export function NewSessionDialog({ open, defaultCwd, onClose, onCreated }: NewSessionDialogProps) {
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const completionTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (completionTimer.current !== null) window.clearTimeout(completionTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    setCwd(defaultCwd ?? "");
    setName("");
    setError(null);
    setPending(false);
    const stored = rememberedAgent();
    setAgentKind(stored);
    let cancelled = false;
    void fetchAgentKinds()
      .then((next) => {
        if (cancelled) return;
        setAgents(next);
        if (stored && !next.some((agent) => agent.kind === stored)) setAgentKind("");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [open, defaultCwd]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const pendingLabel = selectedAgent ? `Starting ${selectedAgent.label}… up to 30s` : "Starting shell…";

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      try {
        window.localStorage.setItem(LAST_AGENT_KEY, agentKind);
      } catch {
        /* private mode: the choice simply is not remembered */
      }
      const result = (await createWorkspace({
        cwd: cwd.trim() || null,
        label: name.trim() || null,
        agent: agentKind ? { kind: agentKind } : null,
      })) as WorkspaceResult;
      if (agentKind && !result.agent_started && result.error?.message) {
        setPending(false);
        setError(result.error.message);
        completionTimer.current = window.setTimeout(() => {
          completionTimer.current = null;
          onCreated(result.pane_id);
        }, AGENT_ERROR_NOTE_MS);
        return;
      }
      onCreated(result.pane_id);
    } catch (reason: unknown) {
      setPending(false);
      if (reason instanceof ApiError && reason.code === "invalid_cwd") setError("Directory not found");
      else setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onSubmit={(event) => void submit(event)}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title">New session</h2>
          <button type="button" className="icon-button" aria-label="Close new session dialog" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Agent</span>
            <select ref={firstFieldRef} className="select" value={agentKind} disabled={pending} onChange={(event) => setAgentKind(event.target.value)}>
              <option value="">Shell only</option>
              {agents.map((agent) => <option key={agent.kind} value={agent.kind}>{agent.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Directory</span>
            <input className="input" value={cwd} disabled={pending} autoComplete="off" onChange={(event) => setCwd(event.target.value)} />
            <span className="field-hint">absolute path or ~/…</span>
          </label>
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input"
              value={name}
              disabled={pending}
              autoComplete="off"
              placeholder={directoryBasename(cwd)}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">Optional workspace label</span>
          </label>
          {pending && <p className="new-session-note" role="status">{pendingLabel}</p>}
          {error && <p className="field-hint new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Starting…" : "Start session"}</button>
        </footer>
      </form>
    </div>
  );
}
