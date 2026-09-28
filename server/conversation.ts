/**
 * Agent session transcripts -> structured conversation turns.
 *
 * The recognized stores are provider-native and read-only:
 * - Codex: native rollout JSONL, resolved by session metadata/open descriptors
 *   or a unique pane-text match for shared app-server TUIs (codex.ts).
 * - Claude Code: herdr's agent.get names the session id, the transcript lives
 *   at ~/.claude/projects/<cwd-slug>/<session>.jsonl (the store chatmux reads).
 * - omp: herdr's agent.get hands us the session jsonl path outright under
 *   ~/.omp/agent/sessions/<cwd-slug>/ — same shape of truth, one less hop.
 * - omo: herdr knows nothing about its store and its label for the pane flips
 *   between `pi` and `claude` as omo spawns model CLIs, so the pane's process
 *   tree routes it and process/session evidence selects a unique transcript
 *   under ~/.omo/agent/sessions/<cwd-slug>/. It writes omp's session shape, so
 *   parseOmpTranscript reads it.
 * - gjc: a unique open session file belonging to its process, also in omp session format.
 *
 * This module turns those files into the conversation the chat lens renders;
 * the pty stays the input path. Pure parsing lives in parseClaudeTranscript /
 * parseOmpTranscript (unit-tested); pane/session/file resolution is
 * integration and lives in paneConversation.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";
import { codexHistorySegments, createCodexTranscriptParser, codexOutputText, codexTranscriptPath, defaultCodexHome, parseCodexTranscript, readRange } from "./codex.ts";
import { CODEX_IMAGE_REF, codexTranscriptImage } from "./codex-images.ts";
import { isOmoProcess, omoTranscriptForPane } from "./omo.ts";
import { trimOutput } from "./tool-output.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";

import { invokedSkill } from "./skill-activity.ts";
import { isContextClear, piMessage, piResults } from "./transcript-records.ts";

export { isOmoProcess } from "./omo.ts";

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
  let changed = false;
  const visible = text.replace(/<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="([^"\r\n]+)">/g,
    (whole: string, opening: string, body: string, closing: string) => {
      if (opening !== closing || opening.length > 64 || !/^[\w-]+$/.test(opening)) return whole;
      changed = true;
      return body;
    });
  return changed ? visible.replace(/^\n+|\n+$/g, "") : text;
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
  uuid?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown };
}

function claudeResultText(output: unknown): string {
  return typeof output === "string" ? output
    : Array.isArray(output) ? output.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join("")
      : "";
}

/** The image types a chat shows; anything else stays out of the page. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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
    if (entry === null || typeof entry !== "object" || entry.isMeta) continue;
    if (isContextClear(entry, "claude-transcript")) { turns.length = 0; pending.clear(); continue; }
    const content = entry.message?.content;
    // a compaction's summary marks where the conversation was folded, readable on request
    if (entry.isCompactSummary) {
      const summary = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").join("\n") : "";
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "compact", text: summary }] });
      continue;
    }

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
        const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: unknown };
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const tool = pending.get(result.tool_use_id);
        if (tool === undefined) continue;
        pending.delete(result.tool_use_id);
        trimOutput(tool, claudeResultText(result.content), result.tool_use_id);
        if (result.is_error === true) tool.error = true;
        if (tool.skill) tool.skill.status = result.is_error === true ? "failed" : "loaded";
      }
      // an image pasted into the prompt: named here, fetched only when shown
      const images: ConversationPart[] = typeof entry.uuid !== "string" ? [] : content.flatMap((block: unknown, index: number) => {
        const image = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown } } | null;
        if (image?.type !== "image" || image.source?.type !== "base64" || typeof image.source.media_type !== "string" || !IMAGE_TYPES.has(image.source.media_type)) return [];
        return [{ kind: "image" as const, media_type: image.source.media_type, ref: `${entry.uuid}:${index}` }];
      });
      if (prompt.trim() || images.length > 0) turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [...images, ...(prompt.trim() ? [{ kind: "text" as const, text: unwrapPastes(prompt) }] : [])] });
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
          const skill = invokedSkill(b.name, input);
          if (skill) { part.skill = skill; part.summary = skill.name; }
          turn.parts.push(part);
          pending.set(String((block as { id?: unknown }).id ?? ""), part);
        }
        // unsupported transcript blocks are intentionally ignored
      }
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
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
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn tail line while omp is mid-append
    }
    if (entry === null || typeof entry !== "object") continue;
    if (isContextClear(entry, "omp-transcript")) { turns.length = 0; pending.clear(); continue; }
    const message = piMessage(entry);
    if (message === null) continue;
    const timestamp = (entry as { timestamp?: string }).timestamp;
    const applyResults = () => {
      for (const result of piResults(message)) {
        const tool = pending.get(result.id);
        if (!tool) continue;
        pending.delete(result.id);
        trimOutput(tool, result.text, result.id);
        if (result.error) tool.error = true;
      }
    };
    if (message.role !== "assistant") applyResults();

    if (message.role === "user") {
      const prompt =
        typeof message.content === "string"
          ? message.content
          : contentParts(message.content)
              .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
              .filter((part) => part.length > 0)
              .join("\n");
      if (prompt.length === 0) continue; // image-only user parts have no text to show
      turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "text", text: prompt }] });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const turn = assistantTurn(timestamp);
      if (timestamp) turn.end_ts = timestamp;
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
      // A provider can place a result beside its call in the same assistant record.
      applyResults();
      // a failed request (a 401, an overloaded provider) leaves an empty message: without its
      // error the chat showed the prompt with no answer at all
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
        turn.parts.push({ kind: "text", text: `Error: ${message.errorMessage}` });
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
  source: "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "codex-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the first turn's position, for the page before it; null at the conversation's beginning */
  cursor: string | null;
  history_id: string;
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
  floor: number;
}

// In-place rewrites keep the inode. Change the cursor generation when observed,
// invalidating settled turns and incremental parsers as well as the response cache.
const transcriptRevisions = new Map<string, { identity: string; size: number; changed: string; generation: string }>();
function transcriptGeneration(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = transcriptRevisions.get(path);
  const rewritten = previous && previous.identity === identity && (stat.size < previous.size || (stat.size === previous.size && changed !== previous.changed));
  const generation = rewritten ? randomUUID() : previous?.identity === identity ? previous.generation : "";
  remember(transcriptRevisions, path, { identity, size: stat.size, changed, generation }, 64);
  return generation ? `-${generation}` : "";
}

function transcriptStream(source: RecognizedConversation["source"], path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, codexHome: string): TranscriptStream {
  // (a chain whose parent was archived since comes back shorter: codexHistorySegments)
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
  return { id: `${stat.dev.toString(36)}-${stat.ino.toString(36)}${chain}${transcriptGeneration(path, stat)}`, files, length: start, floor: 0 };
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

/** Reset markers are small native control records. Scan each appended byte once,
 * in bounded chunks; retain offsets, never a session-sized string. */
const clearScans = new Map<string, { id: string; scanned: number; floor: number; tail: string }>();
function applyHistoryBoundary(path: string, stream: TranscriptStream, source: RecognizedConversation["source"]): void {
  if (source === "codex-transcript") return;
  let scan = clearScans.get(path);
  if (!scan || scan.id !== stream.id || scan.scanned > stream.length || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, scanned: 0, floor: 0, tail: "" };
  }
  let position = scan.scanned;
  let carry = Buffer.alloc(0);
  let skipping = false;
  const isClear = (line: Buffer): boolean => {
    if (!line.includes(source === "claude-transcript" ? "/clear" : "context_clear")) return false;
    try { return isContextClear(JSON.parse(line.toString("utf8")), source); } catch { return false; }
  };
  while (position < stream.length) {
    const end = Math.min(stream.length, position + TRANSCRIPT_WINDOW_BYTES);
    const bytes = Buffer.concat([carry, readStream(stream, position, end)]);
    const base = position - carry.length;
    let offset = 0;
    for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
      if (!skipping && isClear(bytes.subarray(offset, newline))) scan.floor = base + offset;
      skipping = false;
      offset = newline + 1;
      scan.scanned = base + offset;
    }
    carry = bytes.subarray(offset);
    // An oversized data record cannot be a native clear control envelope.
    if (carry.length > METADATA_HEAD_BYTES) { carry = Buffer.alloc(0); skipping = true; }
    position = end;
  }
  scan.tail = bytesBefore(stream, scan.scanned);
  remember(clearScans, path, scan, 32);
  // A valid final JSON object is visible before its newline; rescan it on append.
  stream.floor = !skipping && carry.length > 0 && isClear(carry) ? stream.length - carry.length : scan.floor;
  if (stream.floor > 0) stream.id += `-clear-${stream.floor.toString(36)}`;
}

/** Bytes that every line opening a turn contains: a cheap filter before JSON.parse. */
const TURN_MARK: Record<RecognizedConversation["source"], Buffer> = {
  "codex-transcript": Buffer.from('"task_started"'),
  "claude-transcript": Buffer.from('"user"'),
  "omp-transcript": Buffer.from('"user"'),
  "omo-transcript": Buffer.from('"user"'),
  "gjc-transcript": Buffer.from('"user"'),
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
  if (source !== "claude-transcript") {
    const message = piMessage(entry);
    return message?.role === "user" && (message.content as Record<string, unknown>[]).some((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0);
  }
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
function pageBefore(stream: TranscriptStream, source: RecognizedConversation["source"], to: number, { floor = stream.floor, widen }: { floor?: number; widen: boolean }): { start: number; bytes: Buffer } {
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

/**
 * The newest page is asked for on every poll while an agent works, and between polls its
 * file only grows. Rescanning its whole window (16 MB on a long session) and reparsing
 * the page each time held the event loop 50-110 ms every 2 s, so per live file:
 * - the turn starts found so far are kept, and only the bytes appended since are scanned;
 * - the turns before the page's last turn start are kept (a later append cannot change a
 *   turn that another has followed), and only the last turn is parsed again.
 */
interface LiveScan {
  id: string;
  source: RecognizedConversation["source"];
  /** complete lines up to here are scanned */
  scanned: number;
  /** turn starts in the scanned bytes, ascending, none before the window */
  starts: number[];
  /** the bytes just before `scanned`: a file rewritten rather than appended to no longer has them */
  tail: string;
}
const liveScans = new Map<string, LiveScan>();

interface SettledTurns {
  id: string;
  /** the page start these turns begin at, and the turn start they end at */
  start: number;
  end: number;
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the bytes just before `end` (see LiveScan.tail) */
  tail: string;
}
const settledTurns = new Map<string, SettledTurns>();

function bytesBefore(stream: TranscriptStream, offset: number): string {
  return readStream(stream, Math.max(0, offset - 64), offset).toString("latin1");
}

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** The newest page's start and every turn start in it (pageBefore without widening), or null when it starts mid-turn. */
function newestPage(path: string, stream: TranscriptStream, source: RecognizedConversation["source"]): { start: number; starts: number[] } | null {
  const from = Math.max(stream.floor, stream.length - TRANSCRIPT_WINDOW_BYTES);
  let scan = liveScans.get(path);
  // a window that slid past the scanned bytes starts over at its edge (a line may be cut
  // there, as in pageBefore, and never counts as a start)
  if (!scan || scan.id !== stream.id || scan.source !== source || scan.scanned > stream.length || scan.scanned < from
    || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, source, scanned: from, starts: [], tail: bytesBefore(stream, from) };
  }
  let pending: number[] = [];
  if (scan.scanned < stream.length) {
    const bytes = readStream(stream, scan.scanned, stream.length);
    const complete = bytes.lastIndexOf(0x0a) + 1;
    for (const offset of turnStarts(bytes.subarray(0, complete), source)) scan.starts.push(scan.scanned + offset);
    // a last line still without its newline counts now, and is scanned again once complete
    pending = turnStarts(bytes.subarray(complete), source).map((offset) => scan!.scanned + complete + offset);
    scan.scanned += complete;
    scan.tail = bytesBefore(stream, scan.scanned);
  }
  const stale = scan.starts.findIndex((offset) => offset >= from);
  if (stale !== 0) scan.starts.splice(0, stale === -1 ? scan.starts.length : stale);
  remember(liveScans, path, scan, 32);
  const starts = pending.length > 0 ? [...scan.starts, ...pending] : scan.starts;
  const start = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === stream.floor ? stream.floor : starts[0];
  return start === undefined ? null : { start, starts };
}

function parseTurns(source: RecognizedConversation["source"], text: string): ConversationTurn[] {
  return source === "codex-transcript" ? parseCodexTranscript(text, Infinity)
    : source === "claude-transcript" ? parseClaudeTranscript(text, Infinity) : parseOmpTranscript(text, Infinity);
}

interface LiveCodexTurn {
  id: string;
  start: number;
  scanned: number;
  boundary: string;
  parser: ReturnType<typeof createCodexTranscriptParser>;
  metadata: ConversationMetadata;
}
const codexTurns = new Map<string, LiveCodexTurn>();

/** Incremental within a long Codex task, including results for tools from earlier polls. */
function codexLiveTurn(path: string, stream: TranscriptStream, start: number, before: ConversationMetadata): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  let cached = codexTurns.get(path);
  if (!cached || cached.id !== stream.id || cached.start !== start || cached.scanned > stream.length
    || bytesBefore(stream, cached.scanned) !== cached.boundary) {
    cached = { id: stream.id, start, scanned: start, boundary: bytesBefore(stream, start), parser: createCodexTranscriptParser(), metadata: before };
  }
  const bytes = readStream(stream, cached.scanned, stream.length);
  const complete = bytes.lastIndexOf(0x0a) + 1;
  if (complete > 0) {
    const text = bytes.subarray(0, complete).toString("utf8");
    cached.parser.write(text);
    cached.metadata = parseConversationMetadata(text, "codex-transcript", cached.metadata);
    cached.scanned += complete;
    cached.boundary = bytesBefore(stream, cached.scanned);
  }
  const tail = bytes.subarray(complete).toString("utf8");
  // Both record count and retained source bytes are bounded, independent of session length.
  remember(codexTurns, path, cached, 8);
  let retained = [...codexTurns.values()].reduce((sum, turn) => sum + turn.scanned - turn.start, 0);
  for (const [key, turn] of codexTurns) {
    if (retained <= 2 * TRANSCRIPT_WINDOW_BYTES) break;
    codexTurns.delete(key);
    retained -= turn.scanned - turn.start;
  }
  return { turns: cached.parser.snapshot(tail), metadata: parseConversationMetadata(tail, "codex-transcript", cached.metadata) };
}

/** Codex settings belong to the live rollout; native clears bound other stores. */
function metadataHead(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number): string {
  return source === "codex-transcript" ? readRange(path, 0, METADATA_HEAD_BYTES)
    : readStream(stream, stream.floor, Math.min(start, stream.floor + METADATA_HEAD_BYTES)).toString("utf8");
}

/**
 * The newest page's turns from `start`: the settled ones (before the last turn start)
 * from memory, extended by any turn that has since been followed, plus the live last turn.
 */
function liveTurns(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number, starts: number[]): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  // starts ascend: the last one, when it lies past the page start
  const last = Math.max(start, starts[starts.length - 1] ?? start);
  const key = `${path}\0${start}`;
  let settled = settledTurns.get(key);
  if (!settled || settled.id !== stream.id || settled.end > last || bytesBefore(stream, settled.end) !== settled.tail) {
    const head = start > stream.floor ? metadataHead(path, stream, source, start) : "";
    settled = { id: stream.id, start, end: start, turns: [], metadata: parseConversationMetadata(`${head}\n`, source), tail: bytesBefore(stream, start) };
  }
  if (settled.end < last) {
    const text = readStream(stream, settled.end, last).toString("utf8");
    settled = { ...settled, end: last, turns: [...settled.turns, ...parseTurns(source, text)], metadata: parseConversationMetadata(text, source, settled.metadata), tail: bytesBefore(stream, last) };
  }
  remember(settledTurns, key, settled, 8);
  if (source === "codex-transcript") {
    const live = codexLiveTurn(path, stream, last, settled.metadata);
    return { turns: [...settled.turns, ...live.turns], metadata: live.metadata };
  }
  const text = readStream(stream, last, stream.length).toString("utf8");
  return { turns: [...settled.turns, ...parseTurns(source, text)], metadata: parseConversationMetadata(text, source, settled.metadata) };
}

/** Forget every scan and parse kept between polls (tests compare against a cold read). */
export function forgetTranscriptState(): void {
  cache.clear();
  liveScans.clear();
  settledTurns.clear();
  codexTurns.clear();
  transcriptRevisions.clear();
  clearScans.clear();
}

function formatCursor(stream: TranscriptStream, offset: number): string | null {
  return offset > stream.floor ? `${stream.id}:${offset}` : null;
}

function parseCursor(stream: TranscriptStream, cursor: string): number {
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== stream.id || !Number.isSafeInteger(offset) || offset < stream.floor || offset > stream.length) {
    throw new HistoryChanged();
  }
  return offset;
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
 * A directory descriptor or cwd proves only the store, not the active session.
 * Require one exact open transcript; recency changes when a sibling pane writes.
 * Without readable descriptors (including macOS), fail closed rather than guess.
 */
export async function gjcTranscriptPath(paneId: string, cwd: string, home = process.env["HOME"] ?? ""): Promise<string> {
  let root: string;
  try { root = realpathSync(join(home, ".gjc", "agent", "sessions")); }
  catch { throw new ConversationUnavailable("no_session_path"); }
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  const paths = new Set<string>();
  for (const process of info?.process_info?.foreground_processes ?? []) {
    const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
    // Native gjc and interpreter-launched gjc scripts both occur in process_info.
    const executable = /(^|\/)gjc(?:\.[cm]?js)?$/;
    const isGjc = executable.test(argv[0] ?? "") ||
      (/(^|\/)(?:bun|node)(?:\.exe)?$/.test(argv[0] ?? "") && executable.test(argv[1] ?? ""));
    if (typeof process.pid !== "number" || !isGjc) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${process.pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const target = realpathSync(readlinkSync(`/proc/${process.pid}/fd/${fd}`));
        if (target.startsWith(`${root}/`) && target.endsWith(".jsonl") &&
            statSync(target).isFile() && transcriptCwd(target) === cwd) paths.add(target);
      } catch { /* closed, deleted or unreadable descriptor */ }
    }
  }
  if (paths.size !== 1) throw new ConversationUnavailable("no_session_path");
  return [...paths][0]!;
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

/**
 * herdr labels an omo pane `pi` while it waits and `claude` while omo's claude-sdk child
 * runs, so the sidebar showed another agent's mark, and one that changed as omo worked.
 * The snapshots the browser gets name such a pane `omo`, decided by its process tree
 * (paneRunsOmo), checked for those two labels only.
 */
export async function labelOmoPanes(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  const candidates = snapshot.panes.filter((pane) => pane.agent === "pi" || pane.agent === "claude");
  const omo = new Set<string>();
  await Promise.all(candidates.map(async (pane) => { if (await paneRunsOmo(pane.pane_id)) omo.add(pane.pane_id); }));
  if (omo.size === 0) return snapshot;
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => omo.has(pane.pane_id) ? { ...pane, agent: "omo" } : pane),
    agents: snapshot.agents.map((agent) => omo.has(agent.pane_id) ? { ...agent, agent: "omo" } : agent),
  };
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
 * label alone cannot route omo. Its process tree takes precedence over the child
 * label: omo's own store is read only when omo is really running
 * in that pane, never on a matching cwd alone.
 */
async function resolveTranscript(paneId: string, agent: string, cwd: string, codexHome?: string, panes?: HerdrPane[]): Promise<{ source: RecognizedConversation["source"]; path: string }> {
  if ((agent === "omo" || agent === "pi" || agent === "claude") && await paneRunsOmo(paneId)) {
    const path = await omoTranscriptForPane(paneId, cwd, panes ?? (await sessionSnapshot()).panes);
    if (!path) throw new ConversationUnavailable("no_session_path");
    return { source: "omo-transcript", path };
  }
  try {
    if (agent === "codex") {
      const path = await codexTranscriptPath(paneId, cwd, codexHome, panes);
      if (!path) throw new ConversationUnavailable("no_session_path");
      return { source: "codex-transcript", path };
    }
    if (agent === "claude") return { source: "claude-transcript", path: await claudeTranscriptPath(paneId, cwd) };
    if (agent === "omp") return { source: "omp-transcript", path: await ompTranscriptPath(paneId) };
    if (agent === "gjc") return { source: "gjc-transcript", path: await gjcTranscriptPath(paneId, cwd) };
    throw new ConversationUnavailable("no_recognized_transcript");
  } catch (error) {
    if (!(error instanceof ConversationUnavailable) || !(await paneRunsOmo(paneId))) throw error;
    const path = await omoTranscriptForPane(paneId, cwd, panes ?? (await sessionSnapshot()).panes);
    if (!path) throw new ConversationUnavailable("no_session_path");
    return { source: "omo-transcript", path };
  }
}

/**
 * pane -> agent session -> transcript turns. Read-only, same-user files only.
 * Claude sessions are looked up by id under ~/.claude/projects; omp sessions
 * come as an absolute path from herdr, accepted only under the user's own
 * ~/.omp/agent/sessions dir; omo sessions are resolved from its own store by
 * process/session evidence (omoTranscriptForPane). Throws ConversationUnavailable when the pane has
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

  const { source, path } = await resolveTranscript(paneId, pane.agent ?? pane.agent_session?.agent ?? "", pane.cwd, codexHome, snapshot.panes);
  return transcriptPage(source, path, page, codexHome);
}

/** One page of a resolved transcript (paneConversation's `page`). */
export function transcriptPage(source: RecognizedConversation["source"], path: string, page: ConversationPage = {}, codexHome?: string): RecognizedConversation {
  let stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }
  let stream: TranscriptStream;
  try {
    stream = transcriptStream(source, path, stat, codexHome ?? defaultCodexHome());
    applyHistoryBoundary(path, stream, source);
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }
  // an older page never changes while its file and the rollouts before it stay the same
  // (the stream's id names both); the newest one changes with every append
  const key = page.before !== undefined ? `${path}\0before:${page.before}:${page.since ?? ""}` : `${path}\0from:${page.from ?? ""}`;
  const signature = page.before !== undefined ? stream.id : `${stream.id}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = cache.get(key);
  // the answer is a function of the page asked for and the file's state, so they name it
  const version = answerVersion(key, signature);
  if (cached?.signature === signature) return { source, turns: cached.turns, metadata: cached.metadata, cursor: cached.cursor, history_id: stream.id, version };

  let start: number;
  let text: string;
  let head = "";
  let cursor: string | null;
  let live: { turns: ConversationTurn[]; metadata: ConversationMetadata } | null = null;
  try {
    if (page.before !== undefined) {
      const before = parseCursor(stream, page.before);
      const floor = page.since === undefined ? stream.floor : parseCursor(stream, page.since);
      if (floor > before) throw new HistoryChanged();
      const older = before === floor ? { start: floor, bytes: Buffer.alloc(0) } : pageBefore(stream, source, before, { floor, widen: true });
      start = older.start;
      text = older.bytes.toString("utf8");
    } else {
      const held = page.from === undefined ? null : parseCursor(stream, page.from);
      const newest = newestPage(path, stream, source);
      // A chat that shows older pages holds the start of its newest turns and keeps
      // every turn after it while they are inside the newest page. Once the newest
      // page has moved past it, the chat gets the newest page and fetches the turns
      // in between with `before` + `since`: no poll reads more than a page.
      if (newest !== null) {
        start = held !== null && held >= newest.start ? held : newest.start;
        live = liveTurns(path, stream, source, start, newest.starts);
        text = "";
      } else {
        // no turn starts in the window: the page begins mid-turn, read whole as before
        const whole = pageBefore(stream, source, stream.length, { widen: false });
        start = held !== null && held >= whole.start ? held : whole.start;
        text = whole.bytes.subarray(start - whole.start).toString("utf8");
      }
    }
    if (live === null && page.before === undefined && start > stream.floor) head = metadataHead(path, stream, source, start);
    cursor = formatCursor(stream, start);
  } catch (error) {
    if (error instanceof HistoryChanged) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }

  // the store decides the parser, not the pane's label: omo writes omp's
  // session shape while herdr may be calling that same pane `claude`. The page
  // bounds the turns, so none are cut: they must meet the next page exactly.
  const turns = live?.turns ?? parseTurns(source, text);
  const metadata = live?.metadata ?? parseConversationMetadata(`${head}\n${text}`, source);
  // Record the stat from BEFORE the read: an append during parsing must cause
  // another read on the next poll, not permanently cache a torn tail.
  cache.delete(key);
  cache.set(key, { signature, turns, metadata, cursor });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return { source, turns, metadata, cursor, history_id: stream.id, version };
}

/**
 * One image a user pasted into a Claude prompt, by the ref its image part carries
 * (`<entry uuid>:<block index>`): the transcript holds it as base64, so it is decoded
 * here rather than sent with every poll of the conversation. Null when there is no such
 * image. Codex uses a hash of the native attachment and searches only the bound history.
 */
export async function conversationImage(paneId: string, ref: string, codexHome?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!IMAGE_REF.test(ref) && !CODEX_IMAGE_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: { source: RecognizedConversation["source"]; path: string };
  try { resolved = await resolveTranscript(paneId, pane.agent ?? pane.agent_session?.agent ?? "", pane.cwd, codexHome, snapshot.panes); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  if (resolved.source === "codex-transcript") return codexTranscriptImage(codexHistorySegments(resolved.path, codexHome), ref, pane.cwd);
  return resolved.source === "claude-transcript" ? transcriptImage(resolved.path, ref) : null;
}

const IMAGE_REF = /^([0-9a-f-]{8,64}):(\d{1,3})$/i;

/** The image an image part's ref names in a Claude transcript file, decoded; null when there is none. */
export function transcriptImage(path: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = IMAGE_REF.exec(ref);
  if (match === null) return null;
  const [, uuid, index] = match;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  text = activeHistoryText(text, "claude-transcript");
  const needle = JSON.stringify(uuid);
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    let entry: TranscriptEntry;
    try { entry = JSON.parse(line) as TranscriptEntry; } catch { continue; }
    if (entry.uuid !== uuid || !Array.isArray(entry.message?.content)) continue;
    const block = entry.message.content[Number(index)] as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | undefined;
    if (block?.type !== "image" || block.source?.type !== "base64" || typeof block.source.data !== "string") return null;
    const mediaType = String(block.source.media_type);
    if (!IMAGE_TYPES.has(mediaType)) return null;
    return { mediaType, bytes: new Uint8Array(Buffer.from(block.source.data, "base64")) };
  }
  return null;
}

const TOOL_REF = /^[A-Za-z0-9_:.-]{1,128}$/;
/** A whole output is still bounded: a page of it, not a log file. */
const TOOL_OUTPUT_MAX = 2_000_000;

/** The whole output of a tool call whose page output was cut, by its id; null when there is none. */
export async function toolOutput(paneId: string, ref: string, codexHome?: string): Promise<string | null> {
  if (!TOOL_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: { source: RecognizedConversation["source"]; path: string };
  try { resolved = await resolveTranscript(paneId, pane.agent ?? pane.agent_session?.agent ?? "", pane.cwd, codexHome, snapshot.panes); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  return transcriptToolOutput(resolved.source, resolved.path, ref);
}

/** The output a transcript file holds for one tool call id, whole (up to TOOL_OUTPUT_MAX). */
export function transcriptToolOutput(source: RecognizedConversation["source"], path: string, ref: string): string | null {
  if (!TOOL_REF.test(ref)) return null;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  text = activeHistoryText(text, source);
  const needle = JSON.stringify(ref);
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    let output: string | null = null;
    if (source === "claude-transcript") {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      const result = Array.isArray(content) ? content.find((block) => (block as { type?: unknown; tool_use_id?: unknown } | null)?.type === "tool_result" && (block as { tool_use_id?: unknown }).tool_use_id === ref) : undefined;
      if (result !== undefined) output = claudeResultText((result as { content?: unknown }).content);
    } else if (source === "codex-transcript") {
      const payload = entry.payload as { type?: unknown; call_id?: unknown; output?: unknown } | undefined;
      if ((payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") && payload.call_id === ref) output = codexOutputText(payload.output);
    } else {
      const message = piMessage(entry);
      if (message) output = piResults(message).find((result) => result.id === ref)?.text ?? null;
    }
    if (output !== null) return output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  return null;
}

/** Asset reads share the reset boundary even when their ref predates /clear. */
function activeHistoryText(text: string, source: RecognizedConversation["source"]): string {
  if (source === "codex-transcript") return text;
  let start = 0, offset = 0;
  for (const line of text.split("\n")) {
    if (line.includes("context_clear") || line.includes("/clear")) {
      try { if (isContextClear(JSON.parse(line), source)) start = offset + line.length + 1; } catch { /* torn line */ }
    }
    offset += line.length + 1;
  }
  return text.slice(start);
}
