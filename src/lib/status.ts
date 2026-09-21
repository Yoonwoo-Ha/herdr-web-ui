import type { AgentStatus } from "../../shared/protocol.ts";

export type KnownStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** The one word every surface (sidebar, palette, composer) uses for an agent state. */
export const STATUS_WORD: Readonly<Record<KnownStatus, string>> = {
  idle: "READY",
  working: "RUN",
  blocked: "INPUT",
  done: "DONE",
  unknown: "—",
};

const KNOWN: Readonly<Record<string, KnownStatus>> = { idle: "idle", working: "working", blocked: "blocked", done: "done" };

/** herdr's AgentStatus is open-ended; the UI knows four states and files the rest under unknown. */
export function knownStatus(status?: AgentStatus): KnownStatus {
  return (status !== undefined && KNOWN[status]) || "unknown";
}
