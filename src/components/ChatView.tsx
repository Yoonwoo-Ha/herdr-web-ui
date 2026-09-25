import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ArrowDown, Bot, Brain, Check, ChevronDown, ChevronRight, ChevronUp, Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, Copy, FilePen, FileSearch, Globe, ListChecks, Terminal, Wrench,
  type LucideProps,
} from "lucide-react";

import "./ChatView.css";

import { AgentMark } from "./AgentMark.tsx";
import { Markdown } from "./Markdown.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";
import { formatWorkDuration, splitTurn, workSummary, type ToolPart as ToolPartType } from "../lib/workBlocks.ts";
import { phaseRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import { isTodoTool, parseTodoAnswer, todoCallSummary, todoState, type TodoItem, type TodoStatus } from "../lib/todos.ts";
import { useSettings } from "../lib/settings.ts";
import { usePageVisible } from "../lib/visibility.ts";
import type { TypedAnswer } from "../lib/promptAnswer.ts";
import type { AgentStatus, ConversationMetadata, ConversationPart, ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";

const TRANSCRIPT_LINES = 400;
const POLL_MS = 2000;
/** Scrolling this close to the top asks for the page before it. */
const LOAD_OLDER_PX = 400;

export interface ChatViewProps {
  paneId: string;
  refreshKey: number;
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
  onMetadata?: (paneId: string, metadata: ConversationMetadata | null) => void;
  /** the agent's waiting prompt, for the composer to answer too */
  onPrompt?: (paneId: string, prompt: InteractivePrompt | null) => void;
  /** bumped after the composer answered: read the prompt again now */
  promptRefreshKey?: number;
  /** a typed pick of an approval's option, waiting in the card for Confirm */
  pendingAnswer?: { promptId: string; answer: TypedAnswer } | null;
  onPendingAnswerDone?: () => void;
}

interface ChatState {
  source: "conversation" | "scrollback";
  turns: ConversationTurn[];
  messages: TranscriptMessage[];
  truncated: boolean;
}

const EMPTY_STATE: ChatState = { source: "conversation", turns: [], messages: [], truncated: false };


function formatTime(ts: string | null): string | null {
  if (ts === null) return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "");
}

/** A quiet text button that copies and says "Copied" for a moment. */
function CopyButton({ text, label, className = "icon-button chat-copy", children }: { text: string; label: string; className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className={className} onClick={() => void copy()} aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children}
    </button>
  );
}

function ChecklistView({ rows }: { rows: ChecklistRow[] }) {
  return <ul className="chat-checklist">{rows.map((row, index) => (
    <li key={index} className={row.heading ? "chat-checklist-phase" : row.done ? "is-done" : row.active ? "is-active" : undefined}>
      {!row.heading && <span className="chat-checklist-box" aria-hidden="true">{row.done ? "✓" : "•"}</span>}{row.label}
    </li>
  ))}</ul>;
}

const TODO_ICONS: Record<TodoStatus, ComponentType<LucideProps>> = {
  completed: CircleCheck, in_progress: CircleDot, pending: Circle, blocked: CircleAlert, dropped: CircleSlash,
};
const TODO_LABELS: Record<TodoStatus, string> = {
  completed: "done", in_progress: "in progress", pending: "to do", blocked: "blocked", dropped: "dropped",
};

/** A todo list by phase: one row per item, its state as an icon (and in words, for screen readers). */
function TodoList({ items }: { items: TodoItem[] }) {
  const groups: { phase: string | null; items: TodoItem[] }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.phase === item.phase) group.items.push(item); else groups.push({ phase: item.phase, items: [item] });
  }
  return <div className="todo-list">{groups.map((group, index) => (
    <div key={index} className="todo-group">
      {group.phase !== null && <p className="todo-phase">{group.phase}</p>}
      <ul>{group.items.map((item, row) => {
        const Icon = TODO_ICONS[item.status];
        return <li key={row} className={`todo-item is-${item.status}`}>
          <Icon className="todo-icon" aria-hidden="true" />
          <span className="todo-label">{item.label}<span className="sr-only"> ({TODO_LABELS[item.status]})</span>{item.note && <span className="todo-note">{item.note}</span>}</span>
        </li>;
      })}</ul>
    </div>
  ))}</div>;
}

const TODO_OPEN_KEY = "herdr-web-ui:todo-open";

/**
 * The agent's todo list as it stands, pinned to the bottom of the chat: one line (done
 * count and the item in progress) that opens to the whole list. Whether it is open is
 * remembered for every pane.
 */
function TodoPanel({ items }: { items: TodoItem[] }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(TODO_OPEN_KEY) === "1"; } catch { return false; } });
  const toggle = (): void => {
    setOpen(!open);
    try { localStorage.setItem(TODO_OPEN_KEY, open ? "0" : "1"); } catch { /* private mode */ }
  };
  const counted = items.filter((item) => item.status !== "dropped");
  const done = counted.filter((item) => item.status === "completed").length;
  const now = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "blocked");
  const status = counted.length > 0 && done === counted.length ? "All done" : now ? `${now.status === "blocked" ? "Blocked" : "Now"}: ${now.label}` : `${counted.length - done} to do`;
  return <section className={`todo-panel${open ? " is-open" : ""}`} aria-label="Todo list">
    <button type="button" className="todo-panel-head" aria-expanded={open} onClick={toggle}>
      <ListChecks className="todo-panel-icon" aria-hidden="true" />
      <span className="todo-panel-count">{done}/{counted.length}</span>
      <span className="todo-panel-now">{status}</span>
      {open ? <ChevronDown className="todo-panel-caret" aria-hidden="true" /> : <ChevronUp className="todo-panel-caret" aria-hidden="true" />}
    </button>
    {open && <div className="todo-panel-body"><TodoList items={items} /></div>}
  </section>;
}

function ompEditLineClass(line: string): string | undefined {
  if (line.startsWith("+-") || line.startsWith("-") || /^(CUT|REM)\b/.test(line)) return "chat-diff-del";
  if (line.startsWith("+")) return "chat-diff-add";
  if (/^(PUT|MV)/.test(line) || line.startsWith("[")) return "chat-diff-head";
  return undefined;
}

function ToolInputView({ part }: { part: ToolPartType }) {
  // a todo call shows the list as it stood after it, when the agent answered with it
  const after = isTodoTool(part.name) ? parseTodoAnswer(part.output) : null;
  if (after !== null && after.length > 0) return <TodoList items={after} />;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(part.input) as Record<string, unknown>; }
  catch { return <pre className="chat-tool-io">{part.input}</pre>; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return <pre className="chat-tool-io">{part.input}</pre>;
  const str = (key: string): string | undefined => typeof parsed[key] === "string" ? parsed[key] : undefined;
  const command = str("command") ?? str("cmd");
  if (command !== undefined) return <div className="chat-tool-io"><pre>{command}</pre>{(str("cwd") ?? str("description")) !== undefined && <p className="chat-tool-io-meta">{str("cwd") ?? str("description")}</p>}</div>;
  const oldString = str("old_string");
  const newString = str("new_string");
  if (oldString !== undefined || newString !== undefined) return <div className="chat-tool-io">{str("file_path") !== undefined && <p className="chat-tool-file">{str("file_path")}</p>}{oldString !== undefined && <pre className="chat-diff chat-diff-del">{oldString}</pre>}{newString !== undefined && <pre className="chat-diff chat-diff-add">{newString}</pre>}</div>;
  const editScript = str("input");
  if (editScript !== undefined) return <pre className="chat-tool-io chat-diff">{editScript.split("\n").map((line, index) => <span key={index} className={ompEditLineClass(line)}>{line}{"\n"}</span>)}</pre>;
  const content = str("content");
  if (content !== undefined) return <div className="chat-tool-io">{(str("file_path") ?? str("path")) !== undefined && <p className="chat-tool-file">{str("file_path") ?? str("path")}</p>}<pre>{content}</pre></div>;
  const path = str("file_path") ?? str("path");
  if (path !== undefined) return <div className="chat-tool-io"><p className="chat-tool-file">{str("pattern") !== undefined ? `${path} — /${str("pattern")}/` : path}</p></div>;
  for (const [key, toRows] of [["list", phaseRows], ["todos", todoRows], ["tasks", taskRows]] as const) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const rows = toRows(value);
      if (rows.length > 0) return <ChecklistView rows={rows} />;
    }
  }
  return <pre className="chat-tool-io">{part.input}</pre>;
}

function toolIcon(name: string): ComponentType<LucideProps> {
  const normalized = name.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return Terminal;
  if (["read", "glob", "grep"].some((item) => normalized.includes(item))) return FileSearch;
  if (normalized.includes("edit") || normalized.includes("write")) return FilePen;
  if (normalized.includes("task") || normalized.includes("agent")) return Bot;
  if (normalized.includes("web")) return Globe;
  if (normalized.includes("todo")) return ListChecks;
  return Wrench;
}

/** One row of a work block: `▸ name  summary`, expanding to the call's input and output. */
function WorkRow({ part }: { part: ToolPartType }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(part.name);
  const summary = todoCallSummary(part) ?? part.summary;
  // the list is the answer of a todo call: its raw text would say it twice
  const output = isTodoTool(part.name) && parseTodoAnswer(part.output) !== null ? "" : part.output;
  return <div className="work-row">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <Icon className="work-row-icon" aria-hidden="true" />
      <span className="work-row-name">{part.name}</span>
      {summary.length > 0 && summary !== part.name && <><span className="work-row-sep" aria-hidden="true">/</span><span className="work-row-summary">{summary}</span></>}
    </button>
    {open && <div className="work-row-detail"><ToolInputView part={part} />{output.length > 0 && <section className="chat-tool-output"><h4>Output</h4><pre className="chat-tool-io">{output}</pre></section>}</div>}
  </div>;
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <div className="work-row work-row-thinking">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <Brain className="work-row-icon" aria-hidden="true" />
      <span className="work-row-name">thinking</span>
    </button>
    {open && <div className="work-row-detail work-thinking-text">{text}</div>}
  </div>;
}

/**
 * Everything the agent did on the way — tool calls, reasoning and the narration
 * between them — under one header ("Worked for 7s · 1 edit"). Rows stay one line
 * each until opened; the narration reads as dim prose between them.
 */
function WorkBlockView({ parts, duration, live, defaultOpen, showThinking }: { parts: ConversationPart[]; duration: string | null; live: boolean; defaultOpen: boolean; showThinking: boolean }) {
  const [chosenOpen, setOpen] = useState<boolean | null>(null);
  const open = chosenOpen ?? defaultOpen;
  const visible = showThinking ? parts : parts.filter((part) => part.kind !== "thinking");
  if (visible.length === 0) return null;
  const summary = workSummary(visible);
  const title = live ? "Working…" : duration !== null ? `Worked for ${duration}` : "Worked";
  return <section className={`work-block${live ? " is-live" : ""}`}>
    <button type="button" className="work-block-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-block-title">{title}</span>
      {summary.length > 0 && <span className="work-block-summary">· {summary}</span>}
    </button>
    {open && <div className="work-block-rows">{visible.map((part, index) =>
      part.kind === "thinking" ? <ThinkingRow key={index} text={part.text} />
        : part.kind === "text" ? <div key={index} className="work-narration"><Markdown>{part.text}</Markdown></div>
          : <WorkRow key={index} part={part} />)}</div>}
  </section>;
}

interface TurnProps {
  turn: ConversationTurn;
  /** the last turn while the agent runs: its work block reads "Working…" */
  live: boolean;
  /** the newest assistant turn opens its work; older ones start folded */
  last: boolean;
  showThinking: boolean;
}

// a turn that did not change keeps its object across polls: skip re-rendering it
const Turn = memo(function Turn({ turn, live, last, showThinking }: TurnProps) {
  const time = formatTime(turn.ts);
  if (turn.role === "user") {
    const text = turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");
    return <article className="chat-turn chat-turn-user">
      <div className="chat-bubble"><Markdown>{text}</Markdown></div>
      <div className="chat-turn-meta">{time !== null && <time dateTime={turn.ts ?? undefined}>{time}</time>}<CopyButton text={text} label="Copy message" /></div>
    </article>;
  }
  const { work, answer } = splitTurn(turn.parts);
  const answerText = answer.map((part) => part.text).join("\n\n");
  return <article className="chat-turn chat-turn-agent">
    {work.length > 0 && <WorkBlockView parts={work} duration={formatWorkDuration(turn.ts, turn.end_ts ?? null)} live={live} defaultOpen={last} showThinking={showThinking} />}
    {answer.map((part, index) => <Markdown key={index}>{part.text}</Markdown>)}
    {answerText.length > 0 && <div className="chat-turn-meta chat-agent-meta">
      <CopyButton className="chat-meta-btn" text={answerText} label="Copy as markdown">MD</CopyButton>
      <CopyButton className="chat-meta-btn" text={plainText(answerText)} label="Copy as plain text">TXT</CopyButton>
      {time !== null && <time dateTime={turn.ts ?? undefined}>{time}</time>}
    </div>}
  </article>;
});

function FallbackTurn({ message }: { message: TranscriptMessage }) {
  if (message.role === "status") return null;
  const turn: ConversationTurn = { role: message.role === "user" ? "user" : "assistant", ts: null, parts: [{ kind: "text", text: message.text }] };
  return <Turn turn={turn} live={false} last={false} showThinking={false} />;
}

// the app re-renders on every pane-status and poll; an unchanged transcript sits those out
export const ChatView = memo(function ChatView({ paneId, refreshKey, connected, ended, agent, agentStatus, onMetadata, onPrompt, promptRefreshKey = 0, pendingAnswer = null, onPendingAnswerDone }: ChatViewProps) {
  const { fetchPaneConversation, fetchPanePrompt, fetchPaneTranscript } = useMachineApi();
  const { settings } = useSettings();
  // polls pause while the page is hidden and pick up at once when it is back
  const visible = usePageVisible();
  /** the answer last laid out: an unchanged poll (a 304) hands back this very object */
  const lastAnswer = useRef<unknown>(null);
  const [state, setState] = useState<ChatState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [prompt, setPrompt] = useState<InteractivePrompt | null>(null);
  const [promptPollKey, setPromptPollKey] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const signature = useRef("");
  // Older pages sit above the newest one. Once any shows, the newest page is
  // polled from its start at that moment, so the two always meet.
  const [older, setOlder] = useState<ConversationTurn[]>([]);
  /** the page before everything shown; null at the conversation's beginning, undefined when unknown */
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "failed">("idle");
  const heldFrom = useRef<string | null>(null);
  const loadingOlder = useRef(false);
  /** bumped whenever the older pages are dropped: a load still in flight for them is ignored */
  const olderGeneration = useRef(0);
  const shownPane = useRef(paneId);
  const prepended = useRef<{ top: number; height: number } | null>(null);
  const [pollKey, setPollKey] = useState(0);

  const dropOlder = (): void => {
    olderGeneration.current += 1; loadingOlder.current = false;
    heldFrom.current = null; prepended.current = null; setOlder([]); setOlderCursor(undefined); setOlderState("idle");
  };

  useEffect(() => {
    shownPane.current = paneId;
    stickToBottom.current = true; signature.current = ""; setState(EMPTY_STATE); setNewMessages(false); setError(null); setErrorStatus(null); setPrompt(null);
    dropOlder();
    lastAnswer.current = null;
  }, [paneId]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number | undefined;
    /** The turns between the held start and where the newest page now starts, a page at a time; null when they cannot be joined. */
    const turnsBetween = async (held: string, start: string): Promise<ConversationTurn[] | null> => {
      const pages: ConversationTurn[][] = [];
      let before = start;
      try {
        for (let step = 0; step < 32 && before !== held; step++) {
          const page = await fetchPaneConversation(paneId, { before, since: held });
          if (typeof page.cursor !== "string") return null;
          pages.unshift(page.turns);
          before = page.cursor;
        }
      } catch {
        return null;
      }
      return before === held ? pages.flat() : null;
    };
    const read = async (): Promise<void> => {
      try {
        let conversation;
        try {
          conversation = await fetchPaneConversation(paneId, heldFrom.current === null ? undefined : { from: heldFrom.current });
        } catch (cause) {
          // a new session or a Codex backtrack replaced the transcript the older pages came from
          if (heldFrom.current === null || !(cause instanceof ApiError) || cause.status !== 409) throw cause;
          if (!cancelled) dropOlder();
          conversation = await fetchPaneConversation(paneId);
        }
        if (cancelled) return;
        // a 304 hands back the answer already shown: nothing to compare or lay out again
        if (conversation === lastAnswer.current) { setError(null); setErrorStatus(null); return; }
        // The newest page moved past the held start: the turns in between join the older
        // pages and the newest page is held from its new start, so no poll reads more than a page.
        const held = heldFrom.current;
        let moved: ConversationTurn[] = [];
        if (held !== null && conversation.source !== "scrollback" && typeof conversation.cursor === "string" && conversation.cursor !== held) {
          const between = await turnsBetween(held, conversation.cursor);
          if (cancelled) return;
          if (between === null) dropOlder();
          else { moved = between; heldFrom.current = conversation.cursor; }
        }
        if (moved.length > 0) setOlder((turns) => [...turns, ...moved]);
        if (heldFrom.current === null) setOlderCursor(conversation.source === "scrollback" ? undefined : conversation.cursor);
        onMetadata?.(paneId, conversation.source === "scrollback" ? null : conversation.metadata ?? null);
        let next: ChatState;
        if (conversation.source !== "scrollback") next = { source: "conversation", turns: conversation.turns, messages: [], truncated: false };
        else {
          const result = await fetchPaneTranscript(paneId, TRANSCRIPT_LINES);
          if (cancelled) return;
          next = { source: "scrollback", turns: [], messages: toTranscriptMessages(result.text).filter((message) => message.role !== "status"), truncated: result.truncated === true };
        }
        const nextSignature = JSON.stringify(next);
        if (nextSignature !== signature.current) {
          if (signature.current !== "" && !stickToBottom.current) setNewMessages(true);
          signature.current = nextSignature;
          setState(next);
        }
        setError(null); setErrorStatus(null);
        // only an answer laid out in full is skipped when it comes back unchanged: a read
        // cancelled mid-way (a pane switch, the page hidden during a gap fill) is redone
        lastAnswer.current = conversation;
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setErrorStatus(cause instanceof ApiError ? cause.status : null);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void read(), POLL_MS);
      }
    };
    void read();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [paneId, refreshKey, onMetadata, pollKey, visible]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const node = scroller.current;
    if (node === null || loadingOlder.current || typeof olderCursor !== "string") return;
    const before = olderCursor;
    const generation = olderGeneration.current;
    loadingOlder.current = true;
    setOlderState("loading");
    try {
      const page = await fetchPaneConversation(paneId, { before });
      if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
      // a bridge without pages answers with its newest turns: nothing older to add
      if (page.source === "scrollback" || page.cursor === undefined) { setOlderCursor(undefined); setOlderState("idle"); return; }
      const first = heldFrom.current === null;
      heldFrom.current ??= before;
      prepended.current = { top: node.scrollTop, height: node.scrollHeight };
      setOlder((turns) => [...page.turns, ...turns]);
      setOlderCursor(page.cursor);
      setOlderState("idle");
      // the newest page may have slid since it was read: poll it from the held start now
      if (first) setPollKey((key) => key + 1);
    } catch (cause) {
      if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
      if (cause instanceof ApiError && cause.status === 409) dropOlder();
      else setOlderState("failed");
    } finally {
      if (olderGeneration.current === generation) loadingOlder.current = false;
    }
  }, [fetchPaneConversation, olderCursor, paneId]);

  // Older turns went in above the reader: keep the same turns under their eyes.
  useLayoutEffect(() => {
    const node = scroller.current;
    const anchor = prepended.current;
    if (node === null || anchor === null) return;
    prepended.current = null;
    node.scrollTop = anchor.top + (node.scrollHeight - anchor.height);
  }, [older]);

  // A new Codex TUI can show its directory-trust menu while herdr still reports
  // idle. The visible prompt, not the status badge, decides whether to offer answers.
  const pollPrompt = connected && !ended && agent !== null;
  useEffect(() => {
    if (!pollPrompt) { setPrompt(null); return; }
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const readPrompt = async (): Promise<void> => {
      // the same prompt keeps its object: the composer and the card only change with it
      try { const next = await fetchPanePrompt(paneId); if (!cancelled) setPrompt((current) => current?.id === next?.id ? current : next); }
      catch { if (!cancelled) setPrompt(null); }
      finally { if (!cancelled) timer = window.setTimeout(() => void readPrompt(), POLL_MS); }
    };
    void readPrompt();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pollPrompt, paneId, promptPollKey, promptRefreshKey, fetchPanePrompt, visible]);

  useEffect(() => {
    onPrompt?.(paneId, prompt);
    return () => onPrompt?.(paneId, null);
  }, [onPrompt, paneId, prompt]);

  // away from the page, the prompt is not read: it can be answered in the terminal and asked
  // again unseen, so a typed pick waiting for Confirm does not outlive the page being hidden
  useEffect(() => {
    if (!visible) onPendingAnswerDone?.();
  }, [visible, onPendingAnswerDone]);

  // Before paint and without animation: an opened conversation starts at its end
  // instead of scrolling there from the top.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [state, prompt]);

  // A resized composer, a raised keyboard or a narrower window shrinks the view
  // without a scroll event; a reader at the end stays at the end, at once.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    stickToBottom.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 48;
    if (stickToBottom.current) setNewMessages(false);
    if (node.scrollTop < LOAD_OLDER_PX && olderState === "idle") void loadOlder();
  };
  const scrollToBottom = (): void => {
    const node = scroller.current;
    if (node === null) return;
    node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    stickToBottom.current = true; setNewMessages(false);
  };
  const turns = useMemo(() => older.length > 0 ? [...older, ...state.turns] : state.turns, [older, state.turns]);
  const todos = useMemo(() => state.source === "conversation" ? todoState(turns) : null, [state.source, turns]);
  const empty = state.source === "conversation" ? turns.length === 0 : state.messages.length === 0;

  return <div className="chat-view" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label={`conversation of ${paneId}`}>
    <div className="chat-transcript">
      {/* one button in every state: swapping it for a status line of another height would shift the reader */}
      {state.source === "conversation" && typeof olderCursor === "string" && (
        <button type="button" className="btn btn-ghost chat-older" disabled={olderState === "loading"} onClick={() => void loadOlder()}>
          {olderState === "loading" ? "Loading earlier messages…" : olderState === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages"}
        </button>
      )}
      {state.source === "conversation" && olderCursor === null && older.length > 0 && <p className="chat-endcap">beginning of conversation</p>}
      {state.source === "conversation"
        ? turns.map((turn, index) => {
            const last = index === turns.length - 1;
            return <Turn key={`${turn.role}:${turn.ts ?? index}`} turn={turn} live={last && turn.role === "assistant" && agentStatus === "working"} last={last} showThinking={settings.showThinking} />;
          })
        : agent === "codex"
          ? <details className="chat-terminal-fallback"><summary>Conversation unavailable — show terminal output</summary><pre>{state.messages.map((message) => message.text).join("\n\n")}</pre></details>
          : state.messages.map((message, index) => <FallbackTurn key={index} message={message} />)}
      {!ended && !connected && <p className="chat-inline-state">reconnecting…</p>}
      {error !== null && <p className="chat-inline-state chat-inline-error" role="alert">{errorStatus === 401 ? "locked — the token gate is asking again" : error}</p>}
      {empty && error === null && prompt === null && <div className="chat-empty"><AgentMark agent={agent ?? "agent"} size={32} /><p>No conversation yet — say something below</p></div>}
      {prompt !== null && <PromptCard paneId={paneId} prompt={prompt} typedAnswer={pendingAnswer?.promptId === prompt.id ? pendingAnswer.answer : null} onTypedAnswerDone={onPendingAnswerDone} onPromptChanged={() => setPromptPollKey((key) => key + 1)} onAnswered={() => { setPrompt(null); onPendingAnswerDone?.(); }} />}
      {ended && <p className="chat-endcap">terminal ended</p>}
      {todos !== null && todos.length > 0 && <TodoPanel items={todos} />}
    </div>
    {newMessages && <button type="button" className="btn chat-new-messages" onClick={scrollToBottom}>New messages <ArrowDown aria-hidden="true" /></button>}
  </div>;
});
