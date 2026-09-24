import type { HealthAuth, ServerMessage, SessionSnapshot } from "./protocol.ts";

export const LOCAL_MACHINE = "local";
export const BRIDGE_PROTOCOL = 1;
export const REMOTE_BUNDLE_VERSION = "2";
export interface PaneTarget { machine_id: string; pane_id: string }
export type MachineState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
export interface SshTarget {
  destination: string;
  port?: number;
  identity_file?: string;
  session?: string;
}
export interface Machine {
  id: string;
  name: string;
  kind: "local" | "ssh";
  target?: SshTarget;
  enabled: boolean;
  state: MachineState;
  error: string | null;
  snapshot: SessionSnapshot | null;
  herdr?: { version: string; protocol: number };
}
export interface SetupRequest extends SshTarget { name?: string; machine_id?: string; update_remote?: boolean }
export type SetupPhase = "connecting" | "authentication" | "checking" | "approval" | "installing" | "starting" | "connected" | "failed" | "cancelled";
export interface SetupChallenge { id: string; kind: "host_key" | "secret"; prompt: string }
export interface SetupJob {
  id: string;
  machine_id: string;
  phase: SetupPhase;
  step: string;
  challenge: SetupChallenge | null;
  installations: string[];
  error: string | null;
  target: SshTarget;
}
export type SetupAction = { action: "answer"; challenge_id: string; answer: string } | { action: "approve" } | { action: "cancel" };
export type MachineEvent = { type: "machines"; machines: Machine[] } | { type: "machine-message"; machine_id: string; message: ServerMessage };
export interface BridgeHealth { ok: true; auth: HealthAuth; bridge_protocol: number }
export interface BridgeIdentity {
  pid: number;
  managed_remote: boolean;
  bridge_protocol: number;
  bundle_version: string;
  socket_path: string;
  socket_id: string;
  herdr: { version: string; protocol: number };
}

/** Local storage keeps its historical keys; remote IDs occupy a separate namespace. */
export function paneStorageId(machineId: string, paneId: string): string {
  return machineId === LOCAL_MACHINE ? paneId : `remote:${encodeURIComponent(machineId)}:${encodeURIComponent(paneId)}`;
}
export function machinePath(machineId: string, path: string): string {
  return machineId === LOCAL_MACHINE ? `/api/${path}` : `/api/machines/${encodeURIComponent(machineId)}/${path}`;
}
