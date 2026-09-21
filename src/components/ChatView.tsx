import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  ArrowDown, Bot, Brain, Check, ChevronDown, ChevronRight, Copy, FilePen, FileSearch, Globe, ListChecks, Terminal, Wrench,
  type LucideProps,
} from "lucide-react";

import "./ChatView.css";

import { AgentMark } from "./AgentMark.tsx";
import { Markdown } from "./Markdown.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { ApiError, fetchPaneConversation, fetchPanePrompt, fetchPaneTranscript } from "../lib/api.ts";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";
import { formatWorkDuration, splitTurn, workSummary, type ToolPart as ToolPartType } from "../lib/workBlocks.ts";
import { phaseRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import { useSettings } from "../lib/settings.ts";
import type { AgentStatus, ConversationPart, ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";

const TRANSCRIPT_LINES = 400;
const POLL_MS = 2000;

export interface ChatViewProps {
  paneId: string;
  refreshKey: number;
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
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

function ompEditLineClass(line: string): string | undefined {
  if (line.startsWith("+-") || line.startsWith("-") || /^(CUT|REM)\b/.test(line)) return "chat-diff-del";
  if (line.startsWith("+")) return "chat-diff-add";
  if (/^(PUT|MV)/.test(line) || line.startsWith("[")) return "chat-diff-head";
  return undefined;
}

function ToolInputView({ part }: { part: ToolPartType }) {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(part.input) as Record<string, unknown>; }
  catch { return <pre className="chat-tool-io">{part.input}</pre>; }
  const str = (key: string): string | undefined => typeof parsed[key] === "string" ? parsed[key] : undefined;
  const command = str("command");
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
  return <div className="work-row">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <Icon className="work-row-icon" aria-hidden="true" />
      <span className="work-row-name">{part.name}</span>
      {part.summary.length > 0 && part.summary !== part.name && <><span className="work-row-sep" aria-hidden="true">/</span><span className="work-row-summary">{part.summary}</span></>}
    </button>
    {open && <div className="work-row-detail"><ToolInputView part={part} />{part.output.length > 0 && <section className="chat-tool-output"><h4>Output</h4><pre className="chat-tool-io">{part.output}</pre></section>}</div>}
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
  const [open, setOpen] = useState(defaultOpen);
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
  /** the next turn's timestamp: how long this one's work took */
  nextTs: string | null;
  /** the last turn while the agent runs: its work block reads "Working…" */
  live: boolean;
  /** the newest assistant turn opens its work; older ones start folded */
  last: boolean;
  showThinking: boolean;
}

function Turn({ turn, nextTs, live, last, showThinking }: TurnProps) {
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
    {work.length > 0 && <WorkBlockView parts={work} duration={formatWorkDuration(turn.ts, nextTs)} live={live} defaultOpen={last} showThinking={showThinking} />}
    {answer.map((part, index) => <Markdown key={index}>{part.text}</Markdown>)}
    {answerText.length > 0 && <div className="chat-turn-meta chat-agent-meta">
      <CopyButton className="chat-meta-btn" text={answerText} label="Copy as markdown">MD</CopyButton>
      <CopyButton className="chat-meta-btn" text={plainText(answerText)} label="Copy as plain text">TXT</CopyButton>
      {time !== null && <time dateTime={turn.ts ?? undefined}>{time}</time>}
    </div>}
  </article>;
}

function FallbackTurn({ message }: { message: TranscriptMessage }) {
  const turn: ConversationTurn = { role: message.role === "user" ? "user" : "assistant", ts: null, parts: [{ kind: "text", text: message.text }] };
  return <Turn turn={turn} nextTs={null} live={false} last={false} showThinking={false} />;
}

export function ChatView({ paneId, refreshKey, connected, ended, agent, agentStatus }: ChatViewProps) {
  const { settings } = useSettings();
  const [state, setState] = useState<ChatState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [prompt, setPrompt] = useState<InteractivePrompt | null>(null);
  const [promptPollKey, setPromptPollKey] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const signature = useRef("");

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const conversation = await fetchPaneConversation(paneId);
        if (cancelled) return;
        let next: ChatState;
        if (conversation.source !== "scrollback") next = { source: "conversation", turns: conversation.turns, messages: [], truncated: false };
        else {
          const result = await fetchPaneTranscript(paneId, TRANSCRIPT_LINES);
          if (cancelled) return;
          next = { source: "scrollback", turns: [], messages: toTranscriptMessages(result.text), truncated: result.truncated === true };
        }
        const nextSignature = JSON.stringify(next);
        if (nextSignature !== signature.current) {
          if (signature.current !== "" && !stickToBottom.current) setNewMessages(true);
          signature.current = nextSignature;
          setState(next);
        }
        setError(null); setErrorStatus(null);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setErrorStatus(cause instanceof ApiError ? cause.status : null);
      }
    };
    stickToBottom.current = true; signature.current = ""; setState(EMPTY_STATE); setNewMessages(false); setError(null); setErrorStatus(null);
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [paneId, refreshKey]);

  useEffect(() => {
    if (agentStatus !== "blocked") { setPrompt(null); return; }
    let cancelled = false;
    const readPrompt = async (): Promise<void> => {
      try { const next = await fetchPanePrompt(paneId); if (!cancelled) setPrompt(next); }
      catch { if (!cancelled) setPrompt(null); }
    };
    void readPrompt();
    const timer = window.setInterval(() => void readPrompt(), POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [agentStatus, paneId, promptPollKey]);

  useEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [state, prompt]);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    stickToBottom.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 48;
    if (stickToBottom.current) setNewMessages(false);
  };
  const scrollToBottom = (): void => {
    const node = scroller.current;
    if (node === null) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    stickToBottom.current = true; setNewMessages(false);
  };
  const empty = state.source === "conversation" ? state.turns.length === 0 : state.messages.length === 0;

  return <div className="chat-view" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label={`conversation of ${paneId}`}>
    <div className="chat-transcript">
      {state.source === "conversation"
        ? state.turns.map((turn, index) => {
            const last = index === state.turns.length - 1;
            return <Turn key={index} turn={turn} nextTs={state.turns[index + 1]?.ts ?? null} live={last && turn.role === "assistant" && agentStatus === "working"} last={last} showThinking={settings.showThinking} />;
          })
        : state.messages.map((message, index) => <FallbackTurn key={index} message={message} />)}
      {!ended && !connected && <p className="chat-inline-state">reconnecting…</p>}
      {error !== null && <p className="chat-inline-state chat-inline-error" role="alert">{errorStatus === 401 ? "locked — the token gate is asking again" : error}</p>}
      {empty && error === null && <div className="chat-empty"><AgentMark agent={agent ?? "agent"} size={32} /><p>No conversation yet — say something below</p></div>}
      {prompt !== null && <PromptCard paneId={paneId} prompt={prompt} onPromptChanged={() => setPromptPollKey((key) => key + 1)} onAnswered={() => setPrompt(null)} />}
      {ended && <p className="chat-endcap">terminal ended</p>}
    </div>
    {newMessages && <button type="button" className="btn chat-new-messages" onClick={scrollToBottom}>New messages <ArrowDown aria-hidden="true" /></button>}
  </div>;
}
