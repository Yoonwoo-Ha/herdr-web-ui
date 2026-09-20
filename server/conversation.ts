/**
 * Agent session transcripts -> structured conversation turns.
 *
 * Two stores are recognized, both provider-native and read-only:
 * - Claude Code: herdr's agent.get names the session id, the transcript lives
 *   at ~/.claude/projects/<cwd-slug>/<session>.jsonl (the store chatmux reads).
 * - omp: herdr's agent.get hands us the session jsonl path outright under
 *   ~/.omp/agent/sessions/<cwd-slug>/ — same shape of truth, one less hop.
 *
 * This module turns those files into the conversation the chat lens renders;
 * the pty stays the input path. Pure parsing lives in parseClaudeTranscript /
 * parseOmpTranscript (unit-tested); pane/session/file resolution is
 * integration and lives in paneConversation.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";

/** Enough turns for a conversation; a 6MB transcript is not read whole into the UI. */
export const MAX_TURNS = 100;

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

/** The one-line summary a collapsed tool chip shows. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const first = input["command"] ?? input["file_path"] ?? input["pattern"] ?? input["description"] ?? input["url"];
  return typeof first === "string" ? first.slice(0, 120) : name;
}

/** A parsed JSONL line's message shape (only the fields we read). */
interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/**
 * Splits one transcript file's contents into turns. Adjacent assistant entries
 * merge into a single turn (text parts + tool parts); each tool_use is followed
 * by a user tool_result entry, which is folded into the tool part it answers.
 */
export function parseClaudeTranscript(text: string): ConversationTurn[] {
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
    const content = entry.message?.content;

    if (entry.type === "user" && typeof content === "string") {
      if (isCommandEntry(content)) continue;
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: content }] });
      continue;
    }

    if (entry.type === "user" && Array.isArray(content)) {
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
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      const turn = assistantTurn(entry.timestamp);
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
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
        // thinking blocks stay private to the agent
      }
    }
  }

  return turns.slice(-MAX_TURNS);
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
export function parseOmpTranscript(text: string): ConversationTurn[] {
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
    Array.isArray(content) ? (content as { type?: string; text?: unknown }[]) : [];

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: OmpEntry;
    try {
      entry = JSON.parse(line) as OmpEntry;
    } catch {
      continue; // a torn tail line while omp is mid-append
    }
    if (entry.type !== "message" || entry.message === undefined) continue; // title/session headers
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
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; name?: unknown; id?: unknown; arguments?: unknown; intent?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
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
        // thinking parts stay private to the agent
      }
    }
  }

  return turns.slice(-MAX_TURNS);
}

/** Re-parse only when the file actually grew; one viewer polls every 2s. */
const cache = new Map<string, { size: number; turns: ConversationTurn[] }>();

export class ConversationUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

/** What paneConversation resolved: which store the turns came from. */
export type RecognizedConversation = { source: "claude-transcript" | "omp-transcript"; turns: ConversationTurn[] };

/**
 * pane -> agent session -> transcript turns. Read-only, same-user files only.
 * Claude sessions are looked up by id under ~/.claude/projects; omp sessions
 * come as an absolute path from herdr, accepted only under the user's own
 * ~/.omp/agent/sessions dir. Throws ConversationUnavailable when the pane has
 * no recognized agent store (the caller falls back to the scrollback
 * transcript view, like chatmux).
 */
export async function paneConversation(paneId: string): Promise<RecognizedConversation> {
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined) throw new ConversationUnavailable("pane_not_found");
  if (typeof pane.cwd !== "string" || pane.cwd.length === 0) throw new ConversationUnavailable("no_recognized_transcript");

  let path: string;
  let source: RecognizedConversation["source"];
  if (pane.agent === "claude") {
    source = "claude-transcript";
    const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: paneId });
    const session = info.agent.agent_session?.value;
    if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
    path = join(process.env["HOME"] ?? "", ".claude", "projects", projectSlug(pane.cwd), `${session}.jsonl`);
  } else if (pane.agent === "omp") {
    source = "omp-transcript";
    const info = await herdrRpc<{ agent: { agent_session?: { kind?: unknown; value?: unknown } } }>("agent.get", { target: paneId });
    const session = info.agent.agent_session;
    const value = session?.kind === "path" ? session.value : undefined;
    const sessionsDir = join(process.env["HOME"] ?? "", ".omp", "agent", "sessions") + "/";
    if (typeof value !== "string" || !value.startsWith(sessionsDir) || !value.endsWith(".jsonl")) {
      throw new ConversationUnavailable("no_session_path");
    }
    path = value;
  } else {
    throw new ConversationUnavailable("no_recognized_transcript");
  }

  let text: string;
  try {
    const stat = statSync(path);
    const cached = cache.get(path);
    if (cached !== undefined && cached.size === stat.size) return { source, turns: cached.turns };
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }

  const turns = pane.agent === "omp" ? parseOmpTranscript(text) : parseClaudeTranscript(text);
  cache.set(path, { size: statSync(path).size, turns });
  return { source, turns };
}
