/**
 * One memory note is one `.md` file: a header of `name: <JSON value>` lines between `---` lines,
 * then the body. Every value is JSON, which YAML reads the same way, so a person can open the file
 * in any editor while the parser stays a few lines and cannot be fooled by YAML's other forms.
 * A field this version does not know is kept and written back after the ones it knows.
 */
import { MEMORY_BODY_MAX_BYTES, MEMORY_BODY_MAX_LINES, MEMORY_KINDS, MEMORY_SCOPES, MEMORY_TITLE_MAX, type MemoryKind, type MemoryOrigin, type MemoryScope } from "../../shared/memory.ts";
import { showable } from "../approvals/hub.ts";

export const ENTRY_VERSION = 1;
const FILE_MAX_BYTES = 4096;
const HEADER_MAX_BYTES = 1024;
const KEY = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** what project-key.ts's remoteKey makes, and nothing else */
export const PROJECT_KEY = /^git:[a-z0-9.-]+(?::\d{1,5})?(?:\/[a-z0-9._~+-]+)+$/;

export function headerFits(entry: MemoryEntry): boolean {
  return parseEntry(formatEntry(entry)).ok;
}

export interface MemoryEntry {
  v: number;
  id: string;
  scope: MemoryScope;
  project: string | null;
  kind: MemoryKind;
  key: string;
  title: string;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  expires: string | null;
  rev: number;
  updated_at: string;
  updated_on: string;
  source_ref: string | null;
  replaces: string | null;
  origin: MemoryOrigin;
  body: string;
  extra: Record<string, unknown>;
}

export type ParsedEntry = { ok: true; entry: MemoryEntry } | { ok: false; reason: string };

const FIELDS = ["v", "id", "scope", "project", "kind", "key", "title", "verified", "verified_at", "verified_by", "expires", "rev", "updated_at", "updated_on", "source_ref", "replaces", "origin"] as const;
type Field = (typeof FIELDS)[number];
const known = (name: string): name is Field => (FIELDS as readonly string[]).includes(name);

export function isEntryId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

export function formatEntry(entry: MemoryEntry): string {
  const lines = FIELDS.map((name) => `${name}: ${JSON.stringify(entry[name])}`);
  for (const [name, value] of Object.entries(entry.extra)) lines.push(`${name}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n${entry.body === "" ? "" : `${entry.body}\n`}`;
}

/** Why a title and body cannot be a note, or null. */
export function textProblem(title: string, body: string): string | null {
  if (title.trim() === "" || [...title].length > MEMORY_TITLE_MAX || title.includes("\n")) return "title";
  if (Buffer.byteLength(body) > MEMORY_BODY_MAX_BYTES || body.split("\n").length > MEMORY_BODY_MAX_LINES) return "body";
  if (!showable(title) || !showable(body)) return "hidden_characters";
  return null;
}

export function parseEntry(text: string): ParsedEntry {
  if (Buffer.byteLength(text) > FILE_MAX_BYTES) return { ok: false, reason: "too_large" };
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) return { ok: false, reason: "no_header" };
  const [, header = "", rest = ""] = match;
  if (Buffer.byteLength(header) > HEADER_MAX_BYTES) return { ok: false, reason: "header_too_large" };
  const fields: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const line of header.split("\n")) {
    const at = line.indexOf(": ");
    if (at <= 0) return { ok: false, reason: "header_line" };
    const name = line.slice(0, at);
    let value: unknown;
    try { value = JSON.parse(line.slice(at + 2)); } catch { return { ok: false, reason: "header_value" }; }
    if (name in fields || name in extra) return { ok: false, reason: "duplicate_field" };
    if (known(name)) fields[name] = value;
    else extra[name] = value;
  }
  if (typeof fields["v"] === "number" && fields["v"] > ENTRY_VERSION) return { ok: false, reason: "too_new" };
  const body = rest.endsWith("\n") ? rest.slice(0, -1) : rest;
  const entry = { ...fields, body, extra } as MemoryEntry;
  const problem = entryProblem(entry);
  return problem === null ? { ok: true, entry } : { ok: false, reason: problem };
}

const text = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const time = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

const ORIGIN_FIELDS = new Set(["by", "surface", "harness", "harness_version", "drive", "machine", "run", "session", "turn", "exposure", "at"]);

function originProblem(origin: unknown): boolean {
  if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return true;
  const { by, at, surface, drive, exposure, turn, session } = origin as Record<string, unknown>;
  return Object.keys(origin).some((name) => !ORIGIN_FIELDS.has(name)) || (by !== "human" && by !== "agent") || !time(at)
    || (surface !== undefined && surface !== "screen" && surface !== "cli")
    || (drive !== undefined && drive !== "terminal" && drive !== "acp")
    || (exposure !== undefined && exposure !== "web" && exposure !== "none")
    || (turn !== undefined && !Number.isSafeInteger(turn))
    || (session !== undefined && !textOrNull(session))
    || ["harness", "harness_version", "machine", "run"].some((name) => {
      const value = (origin as Record<string, unknown>)[name];
      return value !== undefined && (!text(value) || !showable(value) || value.length > 120);
    });
}

function entryProblem(entry: MemoryEntry): string | null {
  if (entry.v !== ENTRY_VERSION) return "version";
  if (!isEntryId(entry.id)) return "id";
  if (!(MEMORY_SCOPES as readonly unknown[]).includes(entry.scope)) return "scope";
  if (entry.scope === "project" ? !text(entry.project) || !PROJECT_KEY.test(entry.project) : entry.project !== null) return "project";
  if (!(MEMORY_KINDS as readonly unknown[]).includes(entry.kind)) return "kind";
  if (!text(entry.key) || !KEY.test(entry.key)) return "key";
  if (!text(entry.title) || !text(entry.body)) return "text";
  const problem = textProblem(entry.title, entry.body);
  if (problem !== null) return problem;
  if (typeof entry.verified !== "boolean" || (entry.verified_at !== null && !time(entry.verified_at)) || !textOrNull(entry.verified_by)) return "verified";
  if (entry.expires !== null && (!text(entry.expires) || !DATE.test(entry.expires))) return "expires";
  if (!Number.isSafeInteger(entry.rev) || entry.rev < 1 || !time(entry.updated_at) || !text(entry.updated_on)) return "revision";
  if (!textOrNull(entry.source_ref) || (entry.replaces !== null && !isEntryId(entry.replaces))) return "reference";
  if (originProblem(entry.origin)) return "origin";
  return null;
}
