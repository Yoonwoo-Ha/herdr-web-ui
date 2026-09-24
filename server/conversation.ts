/**
 * Agent session transcripts -> structured conversation turns.
 *
 * Four stores are recognized, all provider-native and read-only:
 * - Codex: native rollout JSONL, resolved by session metadata/open descriptors
 *   or a unique pane-text match for shared app-server TUIs (codex.ts).
 * - Claude Code: herdr's agent.get names the session id, the transcript lives
 *   at ~/.claude/projects/<cwd-slug>/<session>.jsonl (the store chatmux reads).
 * - omp: herdr's agent.get hands us the session jsonl path outright under
 *   ~/.omp/agent/sessions/<cwd-slug>/ — same shape of truth, one less hop.
 * - omo: herdr knows nothing about its store and its label for the pane flips
 *   between `pi` and `claude` as omo spawns model CLIs, so the pane's process
 *   tree routes it and the transcript is resolved from the store's own layout
 *   under ~/.omo/agent/sessions/<cwd-slug>/. It writes omp's session shape, so
 *   parseOmpTranscript reads it.
 *
 * This module turns those files into the conversation the chat lens renders;
 * the pty stays the input path. Pure parsing lives in parseClaudeTranscript /
 * parseOmpTranscript (unit-tested); pane/session/file resolution is
 * integration and lives in paneConversation.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";
import { codexHistorySegments, codexTranscriptPath, defaultCodexHome, parseCodexTranscript, readRange } from "./codex.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";

/** Enough turns for a conversation. */
export const MAX_TURNS = 100;

/**
 * A transcript is read a page at a time, the newest page re-read on every append
 * while an agent works: Codex rollouts reach hundreds of MB (a 400MB one took 1.1s
 * and 1.7GB of memory to parse whole). 16MB still holds dozens of turns of a
 * tool-heavy session; the chat asks for the pages before it as the reader scrolls up.
 */
export const TRANSCRIPT_WINDOW_BYTES = 16 * 1024 * 1024;

/** A page never holds more prompts than this (each opens a user + assistant pair). */
const MAX_PAGE_PROMPTS = MAX_TURNS / 2;

/** A single turn longer than a window still gets a page of its own, up to this. */
const MAX_PAGE_BYTES = 4 * TRANSCRIPT_WINDOW_BYTES;

/** Settings recorded once at the start (an omp thinking level) sit before a tail window. */
const METADATA_HEAD_BYTES = 64 * 1024;

/** Claude's project slug: the cwd with every `/` replaced by `-`. */
function projectSlug(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

/** Session ids are uuids; refusing anything else keeps the path traversal-free. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Slash-command and bookkeeping entries Claude logs as user turns — not conversations. */
function isCommandEntry(text: string): boolean {
  return text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-");
}

/**
 * Claude Code wraps a long paste in `<pasted_content id="…">` tags so the model can
 * tell it from typed text; its own TUI shows only the text, and so does the chat.
 */
export function unwrapPastes(text: string): string {
  return text
    .replace(/<pasted_content(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s[^>]*)?>/g, "$1")
    .replace(/^\n+|\n+$/g, "");
}

/** The one-line summary a collapsed tool chip shows. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const first = input["command"] ?? input["file_path"] ?? input["pattern"] ?? input["description"] ?? input["url"];
  return typeof first === "string" ? first.slice(0, 120) : name;
}

/** A parsed JSONL line's message shape (only the fields we read). */
interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown };
}

/**
 * Splits one transcript file's contents into turns. Adjacent assistant entries
 * merge into a single turn (text parts + tool parts); each tool_use is followed
 * by a user tool_result entry, which is folded into the tool part it answers.
 */
export function parseClaudeTranscript(text: string, maxTurns = MAX_TURNS): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** tool parts still waiting for their result, by tool_use id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant") return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // a torn tail line while Claude is mid-append
    }
    if (entry === null || typeof entry !== "object" || entry.isMeta || entry.isCompactSummary) continue;
    const content = entry.message?.content;

    if (entry.type === "user" && typeof content === "string") {
      if (isCommandEntry(content)) continue;
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(content) }] });
      continue;
    }

    if (entry.type === "user" && Array.isArray(content)) {
      const prompt = content.flatMap((block: unknown) => {
        if (block === null || typeof block !== "object") return [];
        const part = block as { type?: string; text?: unknown };
        return part.type === "text" && typeof part.text === "string" && !isCommandEntry(part.text.trim()) ? [part.text] : [];
      }).join("\n");
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const result = block as { type?: string; tool_use_id?: string; content?: unknown };
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const tool = pending.get(result.tool_use_id);
        if (tool === undefined) continue;
        pending.delete(result.tool_use_id);
        const output = result.content;
        tool.output =
          typeof output === "string"
            ? output
            : Array.isArray(output)
              ? output.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join("")
              : "";
        if (tool.output.length > 4000) tool.output = `${tool.output.slice(0, 4000)}\n… trimmed`;
      }
      if (prompt.trim()) turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(prompt) }] });
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      const turn = assistantTurn(entry.timestamp);
      if (entry.timestamp) turn.end_ts = entry.timestamp;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: toolSummary(b.name, input),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          turn.parts.push(part);
          pending.set(String((block as { id?: unknown }).id ?? ""), part);
        }
        // unsupported transcript blocks are intentionally ignored
      }
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

/** An omp session line's message shape (only the fields we read). */
interface OmpEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
  };
}

/**
 * Splits one omp session jsonl into turns. Same shape of result as the Claude
 * parser: adjacent assistant messages merge, toolCall parts adopt the output
 * of the toolResult entry that answers them (matched by toolCallId), thinking
 * stays private to the agent.
 */
export function parseOmpTranscript(text: string, maxTurns = MAX_TURNS): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** tool parts still waiting for their result, by toolCall id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant") return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  const contentParts = (content: unknown): { type?: string; text?: unknown }[] =>
    Array.isArray(content) ? content.filter((part) => typeof part === "object" && part !== null) : [];

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: OmpEntry;
    try {
      entry = JSON.parse(line) as OmpEntry;
    } catch {
      continue; // a torn tail line while omp is mid-append
    }
    if (entry === null || typeof entry !== "object") continue;
    if (entry.type !== "message" || entry.message == null) continue; // title/session headers
    const message = entry.message;

    if (message.role === "user") {
      const prompt =
        typeof message.content === "string"
          ? message.content
          : contentParts(message.content)
              .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
              .filter((part) => part.length > 0)
              .join("\n");
      if (prompt.length === 0) continue; // image-only user parts have no text to show
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: prompt }] });
      continue;
    }

    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string") continue;
      const tool = pending.get(message.toolCallId);
      if (tool === undefined) continue;
      pending.delete(message.toolCallId);
      const output = contentParts(message.content)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
      tool.output = output.length > 4000 ? `${output.slice(0, 4000)}\n… trimmed` : output;
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const turn = assistantTurn(entry.timestamp);
      if (entry.timestamp) turn.end_ts = entry.timestamp;
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; arguments?: unknown; intent?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const input = (typeof b.arguments === "object" && b.arguments !== null ? b.arguments : {}) as Record<string, unknown>;
          const summary = typeof b.intent === "string" && b.intent.length > 0 ? b.intent : toolSummary(b.name, input);
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: summary.slice(0, 120),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          turn.parts.push(part);
          if (typeof b.id === "string") pending.set(b.id, part);
        }
        // unsupported transcript parts are intentionally ignored
      }
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

/** Re-parse on file changes, including replacement and same-size rewrites. */
const cache = new Map<string, { signature: string; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null }>();

export class ConversationUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

/** A cursor from another transcript: the pane started a new session, or a Codex backtrack replaced the file. */
export class HistoryChanged extends Error {
  constructor() {
    super("the conversation's transcript changed; reload it from its newest turns");
    this.name = "HistoryChanged";
  }
}

/** What paneConversation resolved: which store the turns came from, and where they start. */
export type RecognizedConversation = {
  source: "claude-transcript" | "omp-transcript" | "omo-transcript" | "codex-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the first turn's position, for the page before it; null at the conversation's beginning */
  cursor: string | null;
  /** changes whenever the answer could: the route's ETag, so an unchanged poll costs no body */
  version: string;
};

/** A restart may parse the same files differently: its answers never match an earlier ETag. */
const PROCESS_VERSION = randomUUID();

function answerVersion(key: string, signature: string): string {
  return createHash("sha256").update(`${PROCESS_VERSION}\0${key}\0${signature}`).digest("base64url").slice(0, 22);
}

/**
 * Which turns: without `before`, the newest page (with `from`, from that held start
 * while it is still inside the newest page); with `before`, the page ending there,
 * never reaching back past `since`.
 */
export type ConversationPage = { before?: string; since?: string; from?: string };

/**
 * A transcript as one byte stream: for a paginated Codex rollout the history it
 * continues comes first (codexHistorySegments). Transcripts only grow at the end,
 * so a position in it keeps naming the same turn for as long as the file does.
 */
interface TranscriptStream {
  /** the live file's identity: cursors from any other file are refused */
  id: string;
  files: { path: string; start: number; length: number }[];
  length: number;
}

function transcriptStream(source: RecognizedConversation["source"], path: string, stat: { dev: number; ino: number; size: number }, codexHome: string): TranscriptStream {
  const segments = source === "codex-transcript" ? codexHistorySegments(path, codexHome) : [{ path, end: stat.size }];
  const files: TranscriptStream["files"] = [];
  let start = 0;
  for (const segment of segments) {
    // the live file is read to the size it had when it was identified
    const length = segment.path === path ? Math.min(segment.end, stat.size) : segment.end;
    files.push({ path: segment.path, start, length });
    start += length;
  }
  // Positions count from the start of the whole chain: a cursor names the live file AND
  // the rollouts before it, so one read against another chain (an earlier rollout found
  // later, a parent since archived) answers 409 instead of pointing at other turns.
  const earlier = files.slice(0, -1).map((file) => {
    const identity = statSync(file.path, { throwIfNoEntry: false });
    return `${file.path}\0${file.length}\0${identity ? `${identity.dev}:${identity.ino}` : "-"}`;
  });
  const chain = earlier.length === 0 ? "" : `-${createHash("sha256").update(earlier.join("\n")).digest("base64url").slice(0, 10)}`;
  return { id: `${stat.dev.toString(36)}-${stat.ino.toString(36)}${chain}`, files, length: start };
}

function readStream(stream: TranscriptStream, from: number, to: number): Buffer {
  const chunks: Buffer[] = [];
  for (const file of stream.files) {
    const low = Math.max(from, file.start);
    const high = Math.min(to, file.start + file.length);
    if (low >= high) continue;
    const fd = openSync(file.path, "r");
    try {
      const buffer = Buffer.alloc(high - low);
      chunks.push(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, low - file.start)));
    } finally {
      closeSync(fd);
    }
  }
  return Buffer.concat(chunks);
}

/** Bytes that every line opening a turn contains: a cheap filter before JSON.parse. */
const TURN_MARK: Record<RecognizedConversation["source"], Buffer> = {
  "codex-transcript": Buffer.from('"task_started"'),
  "claude-transcript": Buffer.from('"type":"user"'),
  "omp-transcript": Buffer.from('"role":"user"'),
  "omo-transcript": Buffer.from('"role":"user"'),
};

/**
 * Does this line open a turn? Pages start at such lines, so a page never splits
 * a turn: a Codex task (its prompt, duplicate records and tool calls all follow
 * task_started), a Claude or omp prompt (tool results answer the turn before it).
 */
function opensTurn(source: RecognizedConversation["source"], line: string): boolean {
  let entry: { type?: unknown; isMeta?: unknown; isCompactSummary?: unknown; payload?: { type?: unknown }; message?: { role?: unknown; content?: unknown } };
  try { entry = JSON.parse(line); } catch { return false; }
  if (entry === null || typeof entry !== "object") return false;
  if (source === "codex-transcript") return entry.type === "event_msg" && entry.payload?.type === "task_started";
  if (source !== "claude-transcript") return entry.type === "message" && entry.message?.role === "user";
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return !isCommandEntry(content);
  return Array.isArray(content) && content.some((block: { type?: unknown; text?: unknown } | null) =>
    block?.type === "text" && typeof block.text === "string" && !isCommandEntry(block.text.trim()));
}

function turnStarts(bytes: Buffer, source: RecognizedConversation["source"]): number[] {
  const starts: number[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(TURN_MARK[source]) && opensTurn(source, line.toString("utf8"))) starts.push(offset);
    offset = end + 1;
  }
  return starts;
}

/**
 * The page of turns ending at `to`: at most MAX_PAGE_PROMPTS prompts, starting on a
 * line that opens a turn, at `floor` (a held start) or at the very beginning. An
 * older page is read once, so for a turn longer than a window it reaches further
 * back, a new chunk at a time, up to MAX_PAGE_BYTES. The newest page is read on
 * every append, so it never does: with no turn start in its window it starts
 * mid-turn, at a whole line.
 */
function pageBefore(stream: TranscriptStream, source: RecognizedConversation["source"], to: number, { floor = 0, widen }: { floor?: number; widen: boolean }): { start: number; bytes: Buffer } {
  let from = Math.max(floor, to - TRANSCRIPT_WINDOW_BYTES);
  let bytes = readStream(stream, from, to);
  for (;;) {
    const starts = turnStarts(bytes, source);
    const keep = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === floor ? 0 : starts[0];
    if (keep !== undefined) return { start: from + keep, bytes: bytes.subarray(keep) };
    if (!widen || to - from >= MAX_PAGE_BYTES) {
      const firstLine = bytes.indexOf(0x0a) + 1;
      return { start: from + firstLine, bytes: bytes.subarray(firstLine) };
    }
    const next = Math.max(floor, from - TRANSCRIPT_WINDOW_BYTES);
    bytes = Buffer.concat([readStream(stream, next, from), bytes]);
    from = next;
  }
}

function formatCursor(stream: TranscriptStream, offset: number): string | null {
  return offset > 0 ? `${stream.id}:${offset}` : null;
}

function parseCursor(stream: TranscriptStream, cursor: string): number {
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== stream.id || !Number.isSafeInteger(offset) || offset < 0 || offset > stream.length) {
    throw new HistoryChanged();
  }
  return offset;
}

/** omo's per-cwd session dir: `/home/u/p` -> `--home-u-p--` (verified against every dir on disk). */
function omoSlug(cwd: string): string {
  return `-${cwd.replaceAll("/", "-")}--`;
}

/**
 * The cwd an omo transcript names in its first line (`{"type":"session",...}`),
 * or null when the file is not one. Read bounded: only the header decides, and
 * a rejected candidate can be megabytes.
 */
function transcriptCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null; // the file vanished between the listing and this read
  }
  try {
    const buffer = Buffer.alloc(4096);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, size).toString("utf8").split("\n")[0] ?? "") as { type?: string; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
  } catch {
    return null; // not an omo transcript, or a header longer than the read
  } finally {
    closeSync(fd);
  }
}

/**
 * The live omo transcript for a pane's cwd. omo is invisible to herdr's session
 * discovery — the `pi` manifest only detects status and agent.get carries no
 * agent_session — and, unlike omp, omo does not keep the file open while it
 * runs, so chatmux's /proc/<pid>/fd oracle has nothing to read here (measured
 * 2026-09-21). What is left is the store's own layout: the newest transcript
 * under the cwd slug whose session header names that same cwd. Two omo panes
 * sharing one cwd therefore read the same, newer, transcript.
 */
export function omoTranscriptPath(cwd: string, home = process.env["HOME"] ?? ""): string {
  const dir = join(home, ".omo", "agent", "sessions", omoSlug(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new ConversationUnavailable("no_session_path");
  }

  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat !== undefined) candidates.push({ path, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const live = candidates.find((candidate) => transcriptCwd(candidate.path) === cwd);
  if (live === undefined) throw new ConversationUnavailable("no_session_path");
  return live.path;
}

/** argv words only an omo process carries: its launcher, its entry, or anything under its install root. */
const OMO_PROCESS = /(^|\/)omo(\.js)?$|\/omo-ai\//;

export function isOmoProcess(argv: readonly string[]): boolean {
  return argv.some((word) => OMO_PROCESS.test(word));
}

/**
 * Is omo the agent in this pane, whatever herdr currently labels it? A probe
 * failure answers "no": the caller then reports why the labelled store failed,
 * which is the more useful error.
 */
async function paneRunsOmo(paneId: string): Promise<boolean> {
  // pane.process_info wants `pane_id`; given `target` herdr answers for the
  // FOCUSED pane instead of erroring (live-verified 2026-09-21).
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  return (info?.process_info?.foreground_processes ?? []).some((process) =>
    isOmoProcess(Array.isArray(process.argv) ? process.argv.map(String) : []),
  );
}

/** Claude's transcript for a pane: herdr names the session id, the store is addressed by cwd slug. */
async function claudeTranscriptPath(paneId: string, cwd: string): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session?.value;
  if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
  return join(process.env["HOME"] ?? "", ".claude", "projects", projectSlug(cwd), `${session}.jsonl`);
}

/** omp's transcript: herdr hands over the absolute path, accepted only inside the user's own store. */
async function ompTranscriptPath(paneId: string): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: unknown; value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  const value = session?.kind === "path" ? session.value : undefined;
  const sessionsDir = join(process.env["HOME"] ?? "", ".omp", "agent", "sessions") + "/";
  if (typeof value !== "string" || !value.startsWith(sessionsDir) || !value.endsWith(".jsonl")) {
    throw new ConversationUnavailable("no_session_path");
  }
  return value;
}

/**
 * The store a pane's transcript lives in. herdr's agent label follows the
 * pane's foreground processes, so an omo pane reads as `pi` while it waits and
 * as `claude` while its claude-sdk child runs (live-verified 2026-09-21) — the
 * label alone cannot route omo. Whenever the labelled store yields nothing, the
 * process tree decides: omo's own store is read only when omo is really running
 * in that pane, never on a matching cwd alone.
 */
async function resolveTranscript(paneId: string, agent: string, cwd: string, codexHome?: string): Promise<{ source: RecognizedConversation["source"]; path: string }> {
  try {
    if (agent === "codex") {
      const path = await codexTranscriptPath(paneId, cwd, codexHome);
      if (!path) throw new ConversationUnavailable("no_session_path");
      return { source: "codex-transcript", path };
    }
    if (agent === "claude") return { source: "claude-transcript", path: await claudeTranscriptPath(paneId, cwd) };
    if (agent === "omp") return { source: "omp-transcript", path: await ompTranscriptPath(paneId) };
    throw new ConversationUnavailable("no_recognized_transcript");
  } catch (error) {
    if (!(error instanceof ConversationUnavailable) || !(await paneRunsOmo(paneId))) throw error;
    return { source: "omo-transcript", path: omoTranscriptPath(cwd) };
  }
}

/**
 * pane -> agent session -> transcript turns. Read-only, same-user files only.
 * Claude sessions are looked up by id under ~/.claude/projects; omp sessions
 * come as an absolute path from herdr, accepted only under the user's own
 * ~/.omp/agent/sessions dir; omo sessions are resolved from its own store by
 * cwd (omoTranscriptPath). Throws ConversationUnavailable when the pane has
 * no recognized agent store (the caller falls back to the scrollback
 * transcript view, like chatmux).
 *
 * Without `page` this is the newest page. `before` is the page ending at a
 * returned cursor; `from` is every turn after one, for a chat that already
 * shows the pages before it. A cursor from another file throws HistoryChanged.
 */
export async function paneConversation(paneId: string, codexHome?: string, page: ConversationPage = {}): Promise<RecognizedConversation> {
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined) throw new ConversationUnavailable("pane_not_found");
  if (typeof pane.cwd !== "string" || pane.cwd.length === 0) throw new ConversationUnavailable("no_recognized_transcript");

  const { source, path } = await resolveTranscript(paneId, pane.agent ?? pane.agent_session?.agent ?? "", pane.cwd, codexHome);
  return transcriptPage(source, path, page, codexHome);
}

/** One page of a resolved transcript (paneConversation's `page`). */
export function transcriptPage(source: RecognizedConversation["source"], path: string, page: ConversationPage = {}, codexHome?: string): RecognizedConversation {
  let stat: { dev: number; ino: number; size: number; mtimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }
  let stream: TranscriptStream;
  try {
    stream = transcriptStream(source, path, stat, codexHome ?? defaultCodexHome());
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }
  // an older page never changes while its file and the rollouts before it stay the same
  // (the stream's id names both); the newest one changes with every append
  const key = page.before !== undefined ? `${path}\0before:${page.before}:${page.since ?? ""}` : `${path}\0from:${page.from ?? ""}`;
  const signature = page.before !== undefined ? stream.id : `${stream.id}:${stat.size}:${stat.mtimeMs}`;
  const cached = cache.get(key);
  // the answer is a function of the page asked for and the file's state, so they name it
  const version = answerVersion(key, signature);
  if (cached?.signature === signature) return { source, turns: cached.turns, metadata: cached.metadata, cursor: cached.cursor, version };

  let start: number;
  let text: string;
  let head = "";
  let cursor: string | null;
  try {
    if (page.before !== undefined) {
      const before = parseCursor(stream, page.before);
      const floor = page.since === undefined ? 0 : parseCursor(stream, page.since);
      if (floor > before) throw new HistoryChanged();
      const older = before === floor ? { start: floor, bytes: Buffer.alloc(0) } : pageBefore(stream, source, before, { floor, widen: true });
      start = older.start;
      text = older.bytes.toString("utf8");
    } else {
      const newest = pageBefore(stream, source, stream.length, { widen: false });
      const held = page.from === undefined ? null : parseCursor(stream, page.from);
      // A chat that shows older pages holds the start of its newest turns and keeps
      // every turn after it while they are inside the newest page. Once the newest
      // page has moved past it, the chat gets the newest page and fetches the turns
      // in between with `before` + `since`: no poll reads more than a page.
      start = held !== null && held >= newest.start ? held : newest.start;
      text = newest.bytes.subarray(start - newest.start).toString("utf8");
    }
    if (page.before === undefined && start > 0) head = readRange(path, 0, METADATA_HEAD_BYTES);
    cursor = formatCursor(stream, start);
  } catch (error) {
    if (error instanceof HistoryChanged) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }

  // the store decides the parser, not the pane's label: omo writes omp's
  // session shape while herdr may be calling that same pane `claude`. The page
  // bounds the turns, so none are cut: they must meet the next page exactly.
  const turns = source === "codex-transcript" ? parseCodexTranscript(text, Infinity)
    : source === "claude-transcript" ? parseClaudeTranscript(text, Infinity) : parseOmpTranscript(text, Infinity);
  const metadata = parseConversationMetadata(`${head}\n${text}`, source);
  // Record the stat from BEFORE the read: an append during parsing must cause
  // another read on the next poll, not permanently cache a torn tail.
  cache.delete(key);
  cache.set(key, { signature, turns, metadata, cursor });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return { source, turns, metadata, cursor, version };
}
