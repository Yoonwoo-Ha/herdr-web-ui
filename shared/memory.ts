/**
 * Ovis memory: notes kept on this PC for agents to consult. The wire contract of /api/memory
 * (server/memory/routes.ts) and the limits both sides show. Agents get nothing from here yet: the
 * store keeps notes, a person confirms them on a screen, and handing confirmed notes to agents is
 * a later step.
 */

export const MEMORY_SCOPES = ["account", "project", "machine"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = ["preference", "fact", "decision", "pointer"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_TITLE_MAX = 80;
export const MEMORY_BODY_MAX_BYTES = 2048;
export const MEMORY_BODY_MAX_LINES = 30;
/** Days an unconfirmed note waits before it goes to the trash. */
export const MEMORY_INBOX_DAYS = 14;

/** Who wrote a note, kept as written: a later edit does not change it. */
export interface MemoryOrigin {
  by: "human" | "agent";
  /** where a person wrote it: an Ovis screen, or `ovis memory` on a command line */
  surface?: "screen" | "cli";
  harness?: string;
  harness_version?: string;
  drive?: "terminal" | "acp";
  /** the PC it was written on (memory.json's machine id) */
  machine?: string;
  /** the run that wrote it; never a key's value */
  run?: string;
  session?: string | null;
  turn?: number;
  /** "web" when the run that wrote it had read web pages */
  exposure?: "web" | "none";
  at: string;
}

/**
 * confirmed: a person confirmed exactly this text. stale: confirmed, but past its expiry, so it is
 * not given to agents. unconfirmed: waits in the inbox. changed: its file no longer matches what was
 * confirmed (edited outside Ovis), so it waits for a person again.
 */
export type MemoryState = "confirmed" | "stale" | "unconfirmed" | "changed";

/** What the inbox marks for a second look before confirming. */
export type MemoryFlag = "web" | "command" | "absolute" | "address";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  /** the project key (`git:github.com/owner/repo`) of a project note, else null */
  project: string | null;
  kind: MemoryKind;
  key: string;
  title: string;
  body: string;
  /** the secret rule its text fails: then title and body are empty, and it can only be thrown away */
  withheld: string | null;
  state: MemoryState;
  /** SHA-256 of the note's file as listed: confirm and edit name it, so a note that changed since is refused */
  digest: string;
  /** YYYY-MM-DD, or null for never */
  expires: string | null;
  rev: number;
  updated_at: string;
  verified_at: string | null;
  verified_by: string | null;
  source_ref: string | null;
  origin: MemoryOrigin;
  flags: MemoryFlag[];
}

export interface MemoryProject {
  key: string;
  label: string;
}

export interface MemoryView {
  /** this PC: its memory id and host name */
  machine: { id: string; name: string };
  /** the project of the folder asked about, when it has one */
  here: MemoryProject | null;
  /** every project that has a note, and `here` */
  projects: MemoryProject[];
  /** every readable note, confirmed or not */
  items: MemoryItem[];
}

export interface MemoryDraft {
  scope: MemoryScope;
  project: string | null;
  kind: MemoryKind;
  title: string;
  body: string;
  expires: string | null;
  /** the person said a random-looking string in it is not a secret */
  notSecret?: boolean;
}

export interface MemoryEdit extends MemoryDraft {
  id: string;
  rev: number;
  digest: string;
}

/** Besides the usual codes; a request refused with `secret_suspected` may be sent again with notSecret. */
export type MemoryErrorCode = "invalid_memory" | "secret_found" | "secret_suspected" | "memory_full" | "memory_conflict" | "memory_not_found" | "memory_too_new";

/** Days until a new note expires: preferences never, pointers and this PC's notes 90, the rest 180. */
export function defaultExpiryDays(kind: MemoryKind, scope: MemoryScope): number | null {
  if (kind === "preference") return null;
  if (kind === "pointer" || scope === "machine") return 90;
  return 180;
}

/** YYYY-MM-DD `days` after `now`, in UTC. */
export function expiryDate(now: number, days: number): string {
  return new Date(now + days * 86_400_000).toISOString().slice(0, 10);
}

/** `git:github.com/devswha/ovis` reads as `devswha/ovis`. */
export function projectLabel(key: string): string {
  const path = key.replace(/^git:[^/]+\//, "");
  return path === key ? key.replace(/^git:/, "") : path;
}
