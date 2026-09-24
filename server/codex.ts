/** Native Codex rollouts contain both display events and model context. Only
 * conversation records belong in chat; developer prompts and terminal chrome do not. */
import { Database } from "bun:sqlite";
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { herdrRpc, paneRead, sessionSnapshot } from "./herdr/client.ts";

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

/**
 * Chains per rollout, newest first. A header never changes, so a complete chain is
 * kept for good; one that stops at a cut no file holds yet is kept a short while,
 * so every append does not walk sessions/ again, and then looked up afresh.
 */
const historyChains = new Map<string, { chain: HistorySegment[]; complete: boolean; at: number }>();
const INCOMPLETE_CHAIN_MS = 30_000;

/** Drops every remembered chain: the next read resolves each one again. */
export function forgetHistoryChains(): void {
  historyChains.clear();
}

/** Lines before a cut, per file identity and cut: the bytes before a cut never change. */
const linesBeforeCut = new Map<string, number>();

function countLines(path: string, end: number): number {
  const stat = statSync(path);
  const key = `${stat.dev}:${stat.ino}:${end}`;
  const known = linesBeforeCut.get(key);
  if (known !== undefined) return known;
  const fd = openSync(path, "r");
  let lines = 0;
  try {
    const buffer = Buffer.alloc(16 * 1024 * 1024);
    for (let offset = 0; offset < end;) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (length === 0) break;
      for (let index = buffer.indexOf(0x0a, 0); index !== -1 && index < length; index = buffer.indexOf(0x0a, index + 1)) lines += 1;
      offset += length;
    }
  } finally { closeSync(fd); }
  linesBeforeCut.set(key, lines);
  if (linesBeforeCut.size > 256) linesBeforeCut.delete(linesBeforeCut.keys().next().value!);
  return lines;
}

function byteAt(path: string, offset: number): number | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    return readSync(fd, buffer, 0, 1, offset) === 1 ? buffer[0]! : null;
  } finally { closeSync(fd); }
}

/** A rollout's first ordinal: where the history it continues ends, 0 for a whole history. */
function firstOrdinal(header: RecordValue): number {
  const ordinal = record(header.history_base).end_ordinal_exclusive;
  return typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : 0;
}

/**
 * Does `path` hold a cut at (ordinal, byte)? Every record is one line and a rollout's
 * ordinals start at its own first ordinal, so the cut must end a line with exactly
 * `ordinal - first` lines before it (checked on a three-rollout Codex 0.156 chain
 * against the turn offsets in its thread_history_1.sqlite).
 */
function holdsCut(path: string, ordinal: number, end: number): boolean {
  let header: RecordValue | null;
  try { header = rolloutHeader(path); } catch { return false; }
  if (header === null) return false;
  const lines = ordinal - firstOrdinal(header);
  if (lines <= 0 || (statSync(path, { throwIfNoEntry: false })?.size ?? 0) < end || byteAt(path, end - 1) !== 0x0a) return false;
  return countLines(path, end) === lines;
}

/** Every rollout of a thread: rollout-<time>-<thread>.jsonl and its rollout-<time>-<thread>_<segment>.jsonl. */
function threadRollouts(home: string, threadId: string): string[] {
  const sessions = join(home, "sessions");
  return readdir(sessions).flatMap((year) => readdir(join(sessions, year)).flatMap((month) =>
    readdir(join(sessions, year, month)).flatMap((day) => readdir(join(sessions, year, month, day))
      .filter((name) => name.endsWith(`-${threadId}.jsonl`) || name.includes(`-${threadId}_`))
      .map((name) => join(sessions, year, month, day, name)))));
}

/**
 * Paginated rollouts (Codex 0.156) do not copy history. A backtrack or fork starts
 * a new file whose session_meta.history_base names what it continues by thread,
 * ordinal and byte: the same thread before a backtrack, the parent after a fork.
 * The bytes past that cut are the turns the backtrack discarded. A thread can have
 * several rollouts (one per backtrack) and a later backtrack can cut into any of
 * them, so the one that continues is the one that holds the cut (holdsCut), never
 * guessed from names or sizes. A chain that stops at a cut no file holds shows
 * less history rather than the wrong one, and is looked up again next time.
 */
function historyChain(path: string, home: string): HistorySegment[] {
  const cached = historyChains.get(path);
  if (cached && (cached.complete || Date.now() - cached.at < INCOMPLETE_CHAIN_MS)) return cached.chain;
  const remember = (chain: HistorySegment[], complete: boolean): HistorySegment[] => {
    historyChains.delete(path);
    historyChains.set(path, { chain, complete, at: Date.now() });
    if (historyChains.size > 64) historyChains.delete(historyChains.keys().next().value!);
    return chain;
  };
  const chain: HistorySegment[] = [];
  let current = path;
  for (let depth = 0; depth < 32; depth++) {
    let base: RecordValue;
    try { base = record(rolloutHeader(current)?.history_base); } catch { return remember(chain, false); }
    const threadId = string(base.thread_id);
    const ordinal = base.end_ordinal_exclusive;
    const end = base.end_byte_offset;
    if (Object.keys(base).length === 0) return remember(chain, true);
    if (!UUID.test(threadId) || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)
      || typeof end !== "number" || !Number.isSafeInteger(end) || end <= 0) return remember(chain, false);
    const holders = threadRollouts(home, threadId).flatMap((candidate) => {
      const resolved = codexRolloutPath(candidate, home);
      return resolved !== null && resolved !== current && !chain.some((segment) => segment.path === resolved)
        && holdsCut(resolved, ordinal, end) ? [resolved] : [];
    });
    if (holders.length !== 1) return remember(chain, false);
    chain.push({ path: holders[0]!, end });
    current = holders[0]!;
  }
  return remember(chain, false);
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

/** `codex resume <thread>`: the thread a TUI was started on, straight from its command line. */
export function resumedThread(argvs: readonly (readonly string[])[]): string | null {
  for (const argv of argvs) {
    const at = argv.indexOf("resume");
    const thread = at < 0 ? undefined : argv[at + 1];
    if (thread !== undefined && UUID.test(thread)) return thread;
  }
  return null;
}

/** The rollout each pane's Codex was last matched to on screen, the processes that were running it, and when. */
const boundRollouts = new Map<string, { processes: string; path: string; at: number }>();

/**
 * When a process started, in ms since the epoch: Linux counts it in /proc (USER_HZ
 * ticks after boot). null where that is not readable, as on macOS.
 */
function processStartedAt(pid: number): number | null {
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * Threads begun in this cwd since `since` (seconds) that this pane's Codex may have moved
 * on to (/new), as their rollouts. Only interactive threads count: subagents (often with
 * a NULL agent_role) and `codex exec` runs share their parent's cwd but never replace the
 * TUI's conversation. A thread another pane is bound to is that pane's (theirs).
 */
function newerThreads(db: Database, cwd: string, since: number, except: string | null, paneId: string, home: string): string[] {
  const interactive = db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'source'").get() !== null
    ? " AND source IN ('cli', 'vscode')" : "";
  const rows = db.query<{ id: string; rollout_path: string }, [string, number]>(
    `SELECT id, rollout_path FROM threads WHERE cwd = ? AND archived = 0 AND agent_role IS NULL${interactive} AND created_at >= ?`,
  ).all(cwd, since);
  return theirs(rows.flatMap((row) => row.id === except ? [] : [codexRolloutPath(row.rollout_path, home) ?? row.rollout_path]), paneId);
}

/** The rollouts no other pane is bound to. */
function theirs(rollouts: string[], paneId: string, claimed: ReadonlySet<string> = new Set()): string[] {
  const elsewhere = new Set([...boundRollouts].flatMap(([pane, binding]) => pane === paneId ? [] : [binding.path]));
  return rollouts.filter((rollout) => !elsewhere.has(rollout) && !claimed.has(rollout));
}

/** A pane's Codex processes: the ones whose command line names codex, and their pids as one key. */
async function codexProcessesOf(paneId: string): Promise<{ list: { pid: number; argv?: string[] }[]; key: string }> {
  const processInfo = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>(
    "pane.process_info", { pane_id: paneId },
  );
  const list = (processInfo.process_info?.foreground_processes ?? [])
    .filter((process) => process.argv?.some((arg) => /(?:^|\/)codex(?:\.js)?$/.test(arg)));
  return { list, key: list.map((process) => process.pid).sort((left, right) => left - right).join(",") };
}

/** When each pane last looked at the other Codex panes for a set of threads. */
const claimChecks = new Map<string, number>();
const CLAIM_CHECK_MS = 5000;

/**
 * Which of `threads` (rollouts) another Codex pane in this cwd shows: only those threads
 * are matched against each pane's screen, whether or not anyone opened its chat, and a
 * pane that shows one is bound to it. A thread one of them shows is theirs, not a /new of
 * this pane. The same threads and panes are looked at again at most every 5s: a pane whose
 * answer is not on screen yet is tried after that.
 */
async function claimedByOtherPanes(paneId: string, cwd: string, threads: string[], home: string): Promise<Set<string>> {
  const claimed = new Set<string>();
  const panes = (await sessionSnapshot()).panes
    .filter((pane) => pane.pane_id !== paneId && pane.cwd === cwd && (pane.agent ?? pane.agent_session?.agent) === "codex")
    .slice(0, 8);
  // a pane that appeared since is looked at at once
  const key = `${paneId}\0${[...threads].sort().join("\0")}\0${panes.map((pane) => pane.pane_id).join()}`;
  const last = claimChecks.get(key);
  if (panes.length === 0 || (last !== undefined && Date.now() - last < CLAIM_CHECK_MS)) return claimed;
  claimChecks.set(key, Date.now());
  if (claimChecks.size > 64) claimChecks.delete(claimChecks.keys().next().value!);
  const candidates = threads.flatMap((path) => {
    try { return [{ path, text: codexHistoryTail(path, 1024 * 1024, home) }]; } catch { return []; }
  });
  if (candidates.length === 0) return claimed;
  for (const pane of panes) {
    try {
      const screen = await paneRead({ paneId: pane.pane_id, source: "recent", lines: 400, stripAnsi: true });
      const shown = matchCodexTranscript(screen.text, candidates);
      if (shown === null) continue;
      claimed.add(shown);
      const processes = (await codexProcessesOf(pane.pane_id)).key;
      if (processes !== "") {
        boundRollouts.delete(pane.pane_id);
        boundRollouts.set(pane.pane_id, { processes, path: shown, at: Date.now() });
        if (boundRollouts.size > 64) boundRollouts.delete(boundRollouts.keys().next().value!);
      }
    } catch { /* a pane closed meanwhile */ }
  }
  return claimed;
}

export async function codexTranscriptPath(paneId: string, cwd: string, home = defaultCodexHome()): Promise<string | null> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: string; value?: string } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  if (session?.kind === "path" && session.value) return codexRolloutPath(session.value, home);

  const { list: codexProcesses, key: processes } = await codexProcessesOf(paneId);
  const resumed = resumedThread(codexProcesses.map((process) => process.argv ?? []));
  const open = new Set<string>();
  for (const process of codexProcesses) {
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
  let resumedPath: string | null = null;
  let resumedNewer: string[] = [];
  const bound = boundRollouts.get(paneId);
  const boundHere = bound !== undefined && bound.processes === processes && processes !== "" ? bound : undefined;
  let boundNewer: string[] = [];
  try {
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    if (session?.value && UUID.test(session.value)) {
      const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(session.value);
      return row ? codexRolloutPath(row.rollout_path, home) : null;
    }
    if (resumed !== null) {
      const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(resumed);
      // After /new the command line still names the resumed thread. Trust it only while
      // no other interactive thread in this cwd began after this Codex did (newerThreads;
      // one no other pane shows counts too: then the chat says it cannot tell, rather
      // than show the wrong conversation). Without a start time, since the resumed
      // thread was last updated.
      const startedAt = Math.min(...codexProcesses.map((process) => processStartedAt(process.pid) ?? Infinity));
      const since = Number.isFinite(startedAt)
        ? Math.floor(startedAt / 1000)
        : (db.query<{ updated_at: number }, [string]>("SELECT updated_at FROM threads WHERE id = ?").get(resumed)?.updated_at ?? 0);
      resumedPath = row ? codexRolloutPath(row.rollout_path, home) : null;
      resumedNewer = newerThreads(db, cwd, since, resumed, paneId, home);
    }
    // the same guard for a match: after /new the process writes a thread begun since
    // (created_at has whole seconds, so one begun in the match's second counts too)
    if (boundHere !== undefined) boundNewer = newerThreads(db, cwd, Math.floor(boundHere.at / 1000), null, paneId, home);
    const rows = db.query<{ rollout_path: string }, [string]>(
      "SELECT rollout_path FROM threads WHERE cwd = ? AND archived = 0 AND agent_role IS NULL ORDER BY updated_at DESC LIMIT 32",
    ).all(cwd);
    paths = [...new Set([...paths, ...rows.flatMap((row) => {
      const path = codexRolloutPath(row.rollout_path, home);
      return path ? [path] : [];
    })])];
  } catch { /* Older installations can still resolve their open descriptors. */ }
  finally { db?.close(); }
  const screen = paths.length ? await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true }) : null;
  const candidates = paths.flatMap((path) => {
    try { return [{ path, text: codexHistoryTail(path, 1024 * 1024, home) }]; } catch { return []; }
  });
  const matched = screen ? matchCodexTranscript(screen.text, candidates) : null;
  if (matched !== null) {
    boundRollouts.delete(paneId);
    boundRollouts.set(paneId, { processes, path: matched, at: Date.now() });
    if (boundRollouts.size > 64) boundRollouts.delete(boundRollouts.keys().next().value!);
    return matched;
  }
  // Nothing on screen tells: a long run of tool output pushed the last answer out of
  // the read, or nothing is answered yet. The same Codex process still writes the
  // rollout it was last matched to, while no thread begun since in this cwd leaves it
  // unsure: one another Codex pane here shows is that pane's. The binding is kept even
  // when unsure, so it holds again once that thread turns out to be another pane's.
  // Failing that, the thread it was resumed on, under the same rule.
  const unsure = [...new Set([...boundNewer, ...(resumedPath !== null ? resumedNewer : [])])];
  if (unsure.length > 0) {
    const claimed = await claimedByOtherPanes(paneId, cwd, unsure, home);
    boundNewer = theirs(boundNewer, paneId, claimed);
    resumedNewer = theirs(resumedNewer, paneId, claimed);
  }
  if (boundHere !== undefined && boundNewer.length === 0 && codexRolloutPath(boundHere.path, home) !== null) {
    // a pane in use stays among the kept ones
    boundRollouts.delete(paneId);
    boundRollouts.set(paneId, boundHere);
    return boundHere.path;
  }
  return resumedNewer.length === 0 ? resumedPath : null;
}
