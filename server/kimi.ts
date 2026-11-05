/**
 * Kimi Code keeps one append-only wire log per agent session:
 * `~/.kimi-code/sessions/wd_<dir>_<hash>/<session>/agents/<agent>/wire.jsonl`.
 * This file reads the main agent's log into conversation turns for the chat view.
 *
 * The pane's session is proven, never guessed: a session lock the CLI wrote for one of the
 * pane's own processes (`~/.kimi-code/locks/sessions/<id>.lock`, held from the session's first
 * write while it works), else, on Linux, the main wire log one of them holds open; an idle Kimi
 * keeps the session its same process proved last. With no such proof, or with two sessions, the
 * chat falls back to the terminal: no picking by creation time or newest mtime, on any OS.
 */
import { closeSync, openSync, opendirSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processAlive, processStartedAt, processStartUpperBound } from "./process-start.ts";
import { trimOutput } from "./tool-output.ts";

/** Every main wire log under `sessions` a pid holds open, by real path; empty on any read failure. */
function wireLogsHeld(pid: number, sessions: string): string[] {
  let dir: ReturnType<typeof opendirSync>;
  try { dir = opendirSync(`/proc/${pid}/fd`); } catch { return []; }
  const held: string[] = [];
  try {
    let count = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > 4096) return [];
      let path: string;
      try { path = realpathSync(readlinkSync(`/proc/${pid}/fd/${entry.name}`)); } catch { continue; }
      if (path.startsWith(sessions + sep) && path.endsWith(`${sep}agents${sep}main${sep}wire.jsonl`)) held.push(path);
    }
  } finally { dir.closeSync(); }
  return held;
}

/** A lock is a small JSON object; anything larger is not the CLI's. */
const LOCK_BYTES = 4096;

/**
 * Whether one of `own` wrote this lock and still holds it: the CLI writes
 * `{ pid, hostname, startedAt }` when it takes the session and removes the file when it lets go,
 * but a crash leaves it behind, and its pid can come to name another process later. A lock
 * written before its pid's process started (by the latest that start can be) is that leftover.
 */
function lockOwner(path: string, own: Set<number>): number | null {
  let lock: unknown;
  try {
    if (statSync(path).size > LOCK_BYTES) return null;
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
  if (lock === null || typeof lock !== "object") return null;
  const { pid, hostname: host, startedAt } = lock as { pid?: unknown; hostname?: unknown; startedAt?: unknown };
  if (typeof pid !== "number" || !own.has(pid)) return null;
  if (typeof host === "string" && host !== "" && host !== hostname()) return null;
  if (typeof startedAt !== "number" || !processAlive(pid)) return null;
  const started = processStartUpperBound(pid);
  return started !== null && startedAt >= started ? pid : null;
}

/** The main agent's wire log of the session with this id, in whichever folder's store holds it. */
function wireOfSession(sessionId: string, sessions: string): string | null {
  let stores: string[];
  try { stores = readdirSync(sessions); } catch { return null; }
  for (const store of stores) {
    // a folder's sessions (wd_) and managed workspaces' (wm_)
    if (!store.startsWith("wd_") && !store.startsWith("wm_")) continue;
    const path = join(sessions, store, sessionId, "agents", "main", "wire.jsonl");
    try { if (statSync(path).isFile()) return path; } catch { /* not in this store */ }
  }
  return null;
}

/** What the processes prove: one session's log and the process that holds it, none, or two sessions. */
type Proof = { path: string; pid: number } | "none" | "ambiguous";

/**
 * The session these processes (a pane's shell and foreground processes) own right now: the one a
 * live lock of theirs names, else on Linux the main log they hold open, which a session has before
 * its lock.
 */
function proveWire(own: Set<number>, home: string): Proof {
  const sessions = join(home, ".kimi-code", "sessions");
  const locks = join(home, ".kimi-code", "locks", "sessions");
  let names: string[] = [];
  try { names = readdirSync(locks); } catch { /* no session holds a lock */ }
  const locked = new Map<string, number>();
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    const pid = lockOwner(join(locks, name), own);
    if (pid !== null) locked.set(name.slice(0, -".lock".length), pid);
  }
  if (locked.size > 1) return "ambiguous";
  if (locked.size === 1) {
    const [sessionId, pid] = [...locked][0]!;
    const path = wireOfSession(sessionId, sessions);
    return path === null ? "none" : { path, pid };
  }
  if (process.platform !== "linux") return "none";
  let root: string;
  try { root = realpathSync(sessions); } catch { return "none"; }
  const held = new Map<string, number>();
  for (const pid of own) for (const path of wireLogsHeld(pid, root)) held.set(path, pid);
  if (held.size > 1) return "ambiguous";
  const [first] = [...held];
  return first === undefined ? "none" : { path: first[0], pid: first[1] };
}

/** What names a running program: its start, and on Linux its command line, which an exec replaces. */
function programOf(pid: number): string | null {
  const started = processStartedAt(pid);
  if (started === null) return null;
  if (process.platform !== "linux") return String(started);
  try { return `${started}\0${readFileSync(`/proc/${pid}/cmdline`, "utf8")}`; } catch { return null; }
}

/**
 * The last session proven for each pane, and the program that held it. The CLI lets go of its lock
 * a few seconds after a turn ends and opens its log only to append, so an idle Kimi proves nothing;
 * while that same program still runs in the pane, holds no other session, no other process has
 * locked this one and the folder has started no session since, its last session is still the one
 * it shows.
 */
const proven = new Map<string, { path: string; pid: number; program: string; store: number }>();

/**
 * The wire log these processes own: the session they prove now, else the one the same live program
 * proved last for this pane. Two sessions are no answer, and neither is none.
 */
export function kimiWireForPane(paneId: string, pids: number[], home = homedir()): string | null {
  const own = new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1));
  const proof = proveWire(own, home);
  if (typeof proof === "object") {
    const program = programOf(proof.pid);
    let store: number | null = null;
    try { store = statSync(dirname(dirname(dirname(dirname(proof.path))))).mtimeMs; } catch { /* gone: nothing to keep */ }
    if (program === null || store === null) proven.delete(paneId);
    else proven.set(paneId, { ...proof, program, store });
    return proof.path;
  }
  const last = proven.get(paneId);
  proven.delete(paneId);
  if (proof !== "none" || last === undefined || !own.has(last.pid) || !processAlive(last.pid) || programOf(last.pid) !== last.program) return null;
  // a lock on this session now is another process's (the pane's own would have proved it)
  const session = dirname(dirname(dirname(last.path)));
  try { statSync(join(home, ".kimi-code", "locks", "sessions", `${basename(session)}.lock`)); return null; } catch { /* nobody holds it */ }
  // a session the folder got since (`/new`) may be the one this Kimi has switched to before it writes
  try { if (statSync(dirname(session)).mtimeMs !== last.store) return null; } catch { return null; }
  proven.set(paneId, last);
  return last.path;
}

/** The wire log of the Kimi session the pane's own processes hold, or null: the chat then stays on the terminal. */
export async function kimiTranscriptPathForPane(pane: HerdrPane, home = homedir()): Promise<string | null> {
  const info = await paneProcessInfo(pane.pane_id).catch(() => null);
  if (!info) return null;
  const pids = [info.shell_pid, ...(info.foreground_processes ?? []).map((process) => process.pid)];
  return kimiWireForPane(pane.pane_id, pids.filter((pid): pid is number => typeof pid === "number"), home);
}

/** The text of a user message: Kimi stores content as parts, older ones as a plain string. */
function kimiUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part): part is { type: "text"; text: string } =>
    part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string");
  return texts.length === 0 ? null : texts.map((part) => part.text).join("\n");
}

/**
 * The parts of a prompt the user sent, null for any other record. The CLI tags every stored message
 * with its origin: injections (AGENTS.md, system reminders), task notifications and cron firings are
 * not the user's and open no turn; records from older CLIs without an origin still count. One rule
 * for the parser and the page scanner, so a page starts where a turn does.
 */
export function kimiPrompt(record: unknown): ConversationPart[] | null {
  if (record === null || typeof record !== "object") return null;
  const { type, message } = record as { type?: unknown; message?: { role?: unknown; content?: unknown; origin?: { kind?: unknown } } };
  if (type !== "context.append_message" || message === null || typeof message !== "object" || message.role !== "user") return null;
  const originKind = message.origin?.kind;
  if (typeof originKind === "string" && originKind !== "user") return null;
  const text = kimiUserText(message.content);
  return text === null ? [] : [{ kind: "text", text }];
}

/** The ISO time of a record's millisecond epoch, null when it is not a sane epoch. */
function kimiWireTs(time: unknown): string | null {
  return typeof time === "number" && Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null;
}

/** A short rendering of a tool call for the fold: a command is its command line, else its name. */
function kimiToolSummary(event: { name?: unknown; display?: { kind?: unknown; command?: unknown } }): string {
  const display = event.display;
  if (display?.kind === "command" && typeof display.command === "string" && display.command.length > 0) return display.command;
  return typeof event.name === "string" ? event.name : "tool";
}

/** tool.result records name the call by Kimi's own toolCallId. */
type PendingTool = Extract<ConversationPart, { kind: "tool" }> & { state: "pending" | "ok" | "error" };

/**
 * wire.jsonl records, one per line: user prompts are `context.append_message`
 * records; the answer loop is `context.append_loop_event` records — `content.part`
 * (text or think), `tool.call` and its later `tool.result`, all carrying the loop's
 * `time`. Everything between two user prompts is one assistant turn. A stored user
 * message whose `origin.kind` is not "user" (injections, task notifications, cron
 * firings) is meta traffic and never becomes a turn. A record whose shape is wrong
 * (a `null` line, a wild timestamp) is skipped, never fails the page; a tool result
 * is cut like the other readers' (trimOutput), the rest fetched by its toolCallId.
 */
export function parseKimiTranscript(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Map<string, PendingTool>();
  let current: ConversationTurn | null = null;
  const ensureAssistant = (ts: string | null): ConversationTurn => {
    if (current === null) current = { role: "assistant", ts, parts: [] };
    if (current.ts === null && ts !== null) current.ts = ts;
    return current;
  };
  const flush = (): void => {
    if (current !== null && current.parts.length > 0) turns.push(current);
    current = null;
  };
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let record: {
      type?: unknown; time?: unknown;
      event?: {
        type?: unknown; part?: { type?: unknown; text?: unknown; think?: unknown };
        toolCallId?: unknown; name?: unknown; args?: unknown; display?: { kind?: unknown; command?: unknown };
        result?: { output?: unknown; isError?: unknown; error?: unknown };
      };
    } | null;
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (record === null || typeof record !== "object") continue;
    const ts = kimiWireTs(record.time);
    const prompt = kimiPrompt(record);
    if (prompt !== null) {
      flush();
      turns.push({ role: "user", ts, parts: prompt });
      continue;
    }
    if (record.type === "context.undo") {
      // `/undo`: Kimi drops the last `count` prompts and everything after each, as its own view does
      flush();
      const count = (record as { count?: unknown }).count;
      for (let undone = 0; typeof count === "number" && undone < count && turns.length > 0;) if (turns.pop()!.role === "user") undone += 1;
      pending.clear();
      continue;
    }
    if (record.type !== "context.append_loop_event" || record.event === null || typeof record.event !== "object") continue;
    const event = record.event;
    if (event.type === "content.part") {
      const part = event.part;
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        ensureAssistant(ts).parts.push({ kind: "text", text: part.text });
      } else if (part?.type === "think" && typeof part.think === "string" && part.think.length > 0) {
        ensureAssistant(ts).parts.push({ kind: "thinking", text: part.think });
      }
    } else if (event.type === "tool.call") {
      const tool: PendingTool = {
        kind: "tool",
        name: typeof event.name === "string" ? event.name : "tool",
        summary: kimiToolSummary(event),
        input: typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? {}),
        output: "",
        state: "pending",
      };
      if (typeof event.toolCallId === "string") tool.call_id = event.toolCallId;
      ensureAssistant(ts).parts.push(tool);
      if (tool.call_id !== undefined) pending.set(tool.call_id, tool);
    } else if (event.type === "tool.result") {
      const tool = typeof event.toolCallId === "string" ? pending.get(event.toolCallId) : undefined;
      if (tool === undefined) continue;
      const output = event.result?.output;
      trimOutput(tool, typeof output === "string" ? output : JSON.stringify(output ?? ""), event.toolCallId as string);
      tool.state = event.result?.isError === true || event.result?.error ? "error" : "ok";
      if (tool.state === "error") tool.error = true;
      pending.delete(event.toolCallId as string);
    }
  }
  flush();
  return turns;
}

/** A result record longer than this is not read back whole. */
const RECORD_BYTES = 64 * 1024 * 1024;

/**
 * The whole output of one tool call, by Kimi's toolCallId, cut at `max`: the log is searched in
 * chunks for the id's bytes, and only a line that holds them is read back and parsed.
 */
export function kimiToolOutput(path: string, ref: string, max: number): string | null {
  const id = Buffer.from(JSON.stringify(ref));
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  /** The output if the line at [start, end) is this call's result. */
  const result = (start: number, end: number): string | undefined => {
    if (end - start > RECORD_BYTES) return undefined;
    const bytes = Buffer.alloc(end - start);
    if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length) return undefined;
    let record: { type?: unknown; event?: { type?: unknown; toolCallId?: unknown; result?: { output?: unknown } } } | null;
    try { record = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
    const event = record?.event;
    if (record?.type !== "context.append_loop_event" || event?.type !== "tool.result" || event.toolCallId !== ref) return undefined;
    const output = event.result?.output;
    const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
    return text.length > max ? `${text.slice(0, max)}\n… trimmed` : text;
  };
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    // where the current line starts, whether it holds the id, and its last bytes before this chunk (an id cut in two)
    let lineStart = 0;
    let hit = false;
    let tail = Buffer.alloc(0);
    let position = 0;
    for (let got = 0; (got = readSync(fd, chunk, 0, chunk.length, position)) > 0; position += got) {
      const bytes = chunk.subarray(0, got);
      for (let from = 0; ;) {
        const newline = bytes.indexOf(0x0a, from);
        const end = newline === -1 ? got : newline;
        if (!hit) hit = (from === 0 && tail.length > 0 ? Buffer.concat([tail, bytes.subarray(0, end)]) : bytes.subarray(from, end)).includes(id);
        if (newline === -1) {
          tail = Buffer.from(bytes.subarray(Math.max(from, got - id.length + 1), got));
          break;
        }
        if (hit) {
          const found = result(lineStart, position + newline);
          if (found !== undefined) return found;
        }
        lineStart = position + newline + 1;
        hit = false;
        tail = Buffer.alloc(0);
        from = newline + 1;
      }
    }
    // the last record, whole when it parses, may not end in a newline yet
    return (hit ? result(lineStart, position) : undefined) ?? null;
  } catch { return null; } finally { closeSync(fd); }
}
