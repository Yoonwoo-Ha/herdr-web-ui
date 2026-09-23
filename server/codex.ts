/** Native Codex rollouts contain both display events and model context. Only
 * conversation records belong in chat; developer prompts and terminal chrome do not. */
import { Database } from "bun:sqlite";
import { closeSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { herdrRpc, paneRead } from "./herdr/client.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contextOnly(text: string): boolean {
  const value = text.trim();
  return (value.startsWith("# AGENTS.md instructions for ") && value.includes("</INSTRUCTIONS>"))
    || /^<(environment_context|permissions instructions|turn_aborted|subagent_notification)>[\s\S]*<\/\1>$/.test(value);
}

function contentText(value: unknown, user = false): string {
  if (typeof value === "string") return user && contextOnly(value) ? "" : value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((raw) => {
    const part = record(raw);
    return ["input_text", "output_text", "text", "summary_text"].includes(string(part.type))
      && typeof part.text === "string" && !(user && contextOnly(part.text)) ? [part.text] : [];
  }).join("\n");
}

function entries(text: string): RecordValue[] {
  return text.split("\n").flatMap((line) => {
    try { return [record(JSON.parse(line))]; } catch { return []; }
  });
}

export function parseCodexTranscript(text: string, maxTurns = 100): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const tools = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  // The same message can occur in both event_msg and response_item. Pair those
  // copies only; repeated user messages in the same stream are real turns.
  const messages: { role: string; text: string; source: string; ts: string; paired: boolean; part: Extract<ConversationPart, { kind: "text" }> }[] = [];
  let startedAt: string | undefined;
  const assistant = (ts: string): ConversationTurn => {
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts: startedAt || ts || null, parts: [] };
      turns.push(turn);
    }
    if (ts) turn.end_ts = ts;
    return turn;
  };
  const message = (role: "user" | "assistant", body: string, source: string, ts: string, phase?: "commentary" | "final_answer"): void => {
    if (!body.trim()) return;
    const duplicate = messages.slice(-8).reverse().find((other) => !other.paired && other.role === role && other.text === body
      && other.source !== source && (other.ts === ts || Math.abs(Date.parse(other.ts) - Date.parse(ts)) <= 1000));
    if (duplicate) {
      duplicate.paired = true;
      if (phase) duplicate.part.phase = phase;
      return;
    }
    const part: Extract<ConversationPart, { kind: "text" }> = { kind: "text", text: body, ...(phase ? { phase } : {}) };
    if (role === "user") turns.push({ role, ts: ts || null, parts: [part] });
    else assistant(ts).parts.push(part);
    messages.push({ role, text: body, source, ts, paired: false, part });
  };

  for (const entry of entries(text)) {
    const payload = record(entry.payload);
    const ts = string(entry.timestamp);
    if (entry.type === "event_msg") {
      if (payload.type === "task_started") startedAt = string(payload.started_at) || ts;
      if (payload.type === "task_complete" || payload.type === "turn_aborted") {
        const turn = turns.at(-1);
        if (turn?.role === "assistant" && ts) turn.end_ts = ts;
        startedAt = undefined;
      }
      if (payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
        message("user", contentText(payload.message, true), "event", ts);
      }
      if (payload.type === "agent_message") {
        message("assistant", contentText(payload.message), "event", ts,
          payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    if (payload.type === "message") {
      if (payload.role === "user") message("user", contentText(payload.content, true), "response", ts);
      else if (payload.role === "assistant") {
        const body = contentText(payload.content);
        if (payload.channel === "analysis") {
          if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
        } else if (!payload.recipient || payload.recipient === "all") {
          message("assistant", body, "response", ts,
            payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
        }
      }
    } else if (payload.type === "reasoning") {
      const body = contentText(payload.summary);
      if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const name = string(payload.name) || "tool";
      const raw = payload.type === "function_call" ? payload.arguments : payload.input;
      let args = record(raw);
      if (typeof raw === "string") { try { args = record(JSON.parse(raw)); } catch { /* Freeform tool input. */ } }
      const summary = [args.cmd, args.command, args.file_path, args.path, args.pattern, args.description, args.url].find((v) => typeof v === "string");
      const part: Extract<ConversationPart, { kind: "tool" }> = {
        kind: "tool", name, summary: (string(summary) || name).slice(0, 120),
        input: Object.keys(args).length ? JSON.stringify(args, null, 2) : string(raw), output: "",
      };
      assistant(ts).parts.push(part);
      if (typeof payload.call_id === "string") tools.set(payload.call_id, part);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const tool = tools.get(string(payload.call_id));
      if (!tool) continue;
      const output = contentText(payload.output);
      tool.output = output.length > 4000 ? `${output.slice(0, 4000)}\n… trimmed` : output;
      tools.delete(string(payload.call_id));
      const turn = turns.at(-1);
      if (turn?.role === "assistant" && ts) turn.end_ts = ts;
    }
  }
  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

export const defaultCodexHome = (): string => process.env["CODEX_HOME"] || join(homedir(), ".codex");

/** The session_meta payload on a rollout's first line, or null when the file is not a rollout. */
function rolloutHeader(path: string): RecordValue | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const header = record(JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]!));
    return header.type === "session_meta" ? record(header.payload) : null;
  } finally { closeSync(fd); }
}

/** File access is constrained by canonical paths, including symlink targets. */
export function codexRolloutPath(path: string, codexHome: string): string | null {
  try {
    const canonical = realpathSync(path);
    const rel = relative(realpathSync(join(codexHome, "sessions")), canonical);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !canonical.endsWith(".jsonl")) return null;
    if (!statSync(canonical).isFile()) return null;
    const metadata = rolloutHeader(canonical);
    // A child Codex can be in the foreground process group too. Its rollout
    // is not the conversation of the parent TUI.
    if (metadata === null || (metadata.source && typeof metadata.source !== "string")
      || metadata.source === "subagent" || (metadata.thread_source && metadata.thread_source !== "user")
      || metadata.agent_role) return null;
    return canonical;
  } catch { return null; }
}

/** Bytes [start, end) of a file as text; a cut first line is dropped. */
export function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, length).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

const readdir = (path: string): string[] => { try { return readdirSync(path); } catch { return []; } };

/** A byte range of rollout history: the file's first `end` bytes. */
export interface HistorySegment { path: string; end: number }

/** Earlier segments per rollout, newest first. A header never changes, so neither does its chain. */
const historyChains = new Map<string, HistorySegment[]>();

/**
 * Paginated rollouts (Codex 0.156) do not copy history. A backtrack or fork starts
 * a new file whose session_meta.history_base names what it continues: the first
 * `end_byte_offset` bytes of an earlier rollout of `thread_id` - the same thread
 * before a backtrack, the parent after a fork. The bytes past that offset are the
 * turns the backtrack discarded. state_5.sqlite only keeps a thread's newest file,
 * so the earlier one is found by name: the latest rollout of that thread written
 * before this one.
 */
function historyChain(path: string, home: string): HistorySegment[] {
  const cached = historyChains.get(path);
  if (cached) return cached;
  const chain: HistorySegment[] = [];
  let current = path;
  for (let depth = 0; depth < 16; depth++) {
    let base: RecordValue;
    try { base = record(rolloutHeader(current)?.history_base); } catch { break; }
    const threadId = string(base.thread_id);
    const end = base.end_byte_offset;
    if (!UUID.test(threadId) || typeof end !== "number" || !Number.isSafeInteger(end) || end <= 0) break;
    // rollout-<local time>-<thread>[_<segment>].jsonl: names sort by when they were written
    const later = basename(current);
    const sessions = join(home, "sessions");
    const earlier = readdir(sessions).flatMap((year) => readdir(join(sessions, year)).flatMap((month) =>
      readdir(join(sessions, year, month)).flatMap((day) => readdir(join(sessions, year, month, day))
        .filter((name) => (name.endsWith(`-${threadId}.jsonl`) || name.includes(`-${threadId}_`)) && name < later)
        .map((name) => join(sessions, year, month, day, name)))))
      .sort((left, right) => basename(right).localeCompare(basename(left)));
    const previous = earlier.find((candidate) => (statSync(candidate, { throwIfNoEntry: false })?.size ?? 0) >= end);
    const resolved = previous ? codexRolloutPath(previous, home) : null;
    if (!resolved) break;
    chain.push({ path: resolved, end });
    current = resolved;
  }
  historyChains.set(path, chain);
  if (historyChains.size > 64) historyChains.delete(historyChains.keys().next().value!);
  return chain;
}

/** A Codex conversation's files oldest first, each with how many of its bytes belong to it. */
export function codexHistorySegments(path: string, home = defaultCodexHome()): HistorySegment[] {
  return [...historyChain(path, home)].reverse().concat({ path, end: statSync(path).size });
}

/**
 * The last `budget` bytes of a Codex conversation, across the earlier rollouts a
 * paginated one continues. A rollout can reach hundreds of MB while the chat
 * shows only its latest turns, so nothing before the budget is read.
 */
export function codexHistoryTail(path: string, budget: number, home = defaultCodexHome()): string {
  const chunks: string[] = [];
  let remaining = budget;
  for (const segment of [{ path, end: statSync(path).size }, ...historyChain(path, home)]) {
    if (remaining <= 0) break;
    const start = Math.max(0, segment.end - remaining);
    chunks.unshift(readRange(segment.path, start, segment.end));
    remaining -= segment.end - start;
  }
  return chunks.join("\n");
}

const normalizeDisplay = (text: string): string => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

/** Shared app-server TUIs do not hold rollout descriptors. For read-only display,
 * require a unique substantial assistant-message match in this pane's output.
 * Directory recency alone is never evidence: multiple panes can share a cwd. */
export function matchCodexTranscript(screen: string, candidates: { path: string; text: string }[]): string | null {
  const lastHeader = screen.lastIndexOf("OpenAI Codex (v");
  const display = normalizeDisplay(lastHeader >= 0 ? screen.slice(lastHeader) : screen);
  const matching = new Set<string>();
  for (const candidate of candidates) {
    const prose = parseCodexTranscript(candidate.text).filter((turn) => turn.role === "assistant")
      .flatMap((turn) => turn.parts).filter((part) => part.kind === "text").slice(-8);
    if (prose.some((part) => {
      const anchor = normalizeDisplay(part.text).slice(-160);
      return anchor.length >= 64 && new Set(anchor).size >= 12 && display.includes(anchor);
    })) matching.add(candidate.path);
  }
  return matching.size === 1 ? [...matching][0]! : null;
}

export async function codexTranscriptPath(paneId: string, cwd: string, home = defaultCodexHome()): Promise<string | null> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: string; value?: string } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  if (session?.kind === "path" && session.value) return codexRolloutPath(session.value, home);

  const processInfo = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>(
    "pane.process_info", { pane_id: paneId },
  );
  const open = new Set<string>();
  for (const process of processInfo.process_info?.foreground_processes ?? []) {
    if (!process.argv?.some((arg) => /(?:^|\/)codex(?:\.js)?$/.test(arg))) continue;
    if (globalThis.process.platform === "darwin") {
      // lsof is available on macOS, where /proc does not exist. Keep the same
      // canonical-store and unambiguous-open-file checks as the Linux path.
      const child = Bun.spawn(["/usr/sbin/lsof", "-nP", "-a", "-p", String(process.pid), "-Fn"], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        const text = await new Response(child.stdout).text();
        await child.exited;
        for (const line of text.split("\n")) {
          if (!line.startsWith("n") || !line.endsWith(".jsonl")) continue;
          const path = codexRolloutPath(line.slice(1), home);
          if (path) open.add(path);
        }
      } finally { clearTimeout(timer); }
      continue;
    }
    let descriptors: string[];
    try { descriptors = readdirSync(`/proc/${process.pid}/fd`); } catch { continue; }
    for (const descriptor of descriptors.slice(0, 512)) {
      try {
        const target = readlinkSync(`/proc/${process.pid}/fd/${descriptor}`);
        if (!target.endsWith(".jsonl")) continue;
        const path = codexRolloutPath(target, home);
        if (path) open.add(path);
      } catch { /* A descriptor may close while enumerating it. */ }
    }
  }
  if (open.size === 1) return [...open][0]!;

  let db: Database | undefined;
  let paths: string[] = [...open];
  try {
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    if (session?.value && UUID.test(session.value)) {
      const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(session.value);
      return row ? codexRolloutPath(row.rollout_path, home) : null;
    }
    const rows = db.query<{ rollout_path: string }, [string]>(
      "SELECT rollout_path FROM threads WHERE cwd = ? AND archived = 0 AND agent_role IS NULL ORDER BY updated_at DESC LIMIT 32",
    ).all(cwd);
    paths = [...new Set([...paths, ...rows.flatMap((row) => {
      const path = codexRolloutPath(row.rollout_path, home);
      return path ? [path] : [];
    })])];
  } catch { /* Older installations can still resolve their open descriptors. */ }
  finally { db?.close(); }
  if (!paths.length) return null;
  const screen = await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true });
  const candidates = paths.flatMap((path) => {
    try { return [{ path, text: codexHistoryTail(path, 1024 * 1024, home) }]; } catch { return []; }
  });
  return matchCodexTranscript(screen.text, candidates);
}
