import { useEffect, useRef, useState, type ReactNode } from "react";

import "./ChatView.css";

import { AgentMark } from "./AgentMark.tsx";
import { ApiError, fetchPaneConversation, fetchPaneTranscript } from "../lib/api.ts";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";
import { groupToolRuns, type ToolRunGroup } from "../lib/toolGroups.ts";
import { phaseRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";

/** herdr caps a read at 1000 lines; 400 keeps one poll comfortably small. */
const TRANSCRIPT_LINES = 400;
/** herdr owns the scrollback — the chat view is a reader, so it polls. */
const POLL_MS = 2000;

export interface ChatViewProps {
  paneId: string;
  /** bumped by the composer's send, so the user's prompt appears without waiting a poll */
  refreshKey: number;
  connected: boolean;
  ended: boolean;
  /** the pane's agent name, shown as the assistant's voice label (null: unlabeled) */
  agent: string | null;
}

interface ChatState {
  /** structured turns when the pane has a recognized transcript, else scrollback bubbles */
  source: "conversation" | "scrollback";
  turns: ConversationTurn[];
  messages: TranscriptMessage[];
  truncated: boolean;
}

const EMPTY_STATE: ChatState = { source: "conversation", turns: [], messages: [], truncated: false };

/** inline `code` and **bold** — the only markup assistant prose reliably uses */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-c${index}`}>{match[1]}</code>);
    } else {
      nodes.push(<strong key={`${keyPrefix}-b${index}`}>{match[2]}</strong>);
    }
    last = match.index + match[0].length;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** markdown-lite: fenced code stays monospace, `- ` runs become lists, the rest is prose */
function TextPart({ text }: { text: string }) {
  const segments = text.split("```");
  return (
    <>
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <pre className="chat-code" key={index}>
            {segment.replace(/^\w*\n/, "")}
          </pre>
        ) : (
          <ProseBlock key={index} text={segment} />
        ),
      )}
    </>
  );
}

function ProseBlock({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let prose: string[] = [];
  let key = 0;
  const flush = (): void => {
    if (prose.length > 0) {
      blocks.push(
        <p className="chat-prose" key={`p${(key += 1)}`}>
          {inline(prose.join("\n"), `p${key}`)}
        </p>,
      );
      prose = [];
    }
    if (bullets.length > 0) {
      blocks.push(
        <ul className="chat-list" key={`u${(key += 1)}`}>
          {bullets.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, `u${key}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const line of text.split("\n")) {
    if (/^\s*[-*]\s+/.test(line)) {
      if (prose.length > 0) flush();
      bullets.push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (line.trim().length === 0) {
      flush();
    } else {
      if (bullets.length > 0) flush();
      prose.push(line);
    }
  }
  flush();
  return <>{blocks}</>;
}

function ChecklistView({ rows }: { rows: ChecklistRow[] }) {
  return (
    <ul className="chat-checklist">
      {rows.map((row, index) => (
        <li
          key={index}
          className={row.heading ? "chat-checklist-phase" : row.done ? "is-done" : row.active ? "is-active" : undefined}
        >
          {row.heading !== true && (
            <span className="chat-checklist-box" aria-hidden="true">
              {row.done ? "✓" : "•"}
            </span>
          )}
          {row.label}
        </li>
      ))}
    </ul>
  );
}

/** omp edit scripts are diff-language: mark added, removed and header lines */
function ompEditLineClass(line: string): string | undefined {
  if (line.startsWith("+-") || line.startsWith("-")) return "chat-diff-del";
  if (line.startsWith("+")) return "chat-diff-add";
  if (/^(CUT|REM)\b/.test(line)) return "chat-diff-del";
  if (/^(PUT|MV)/.test(line) || line.startsWith("[")) return "chat-diff-head";
  return undefined;
}

/**
 * Per-tool input rendering (chatmux's ToolRenderer idea, herdr-sized): commands
 * as commands, claude edits as old/new diffs, omp edit scripts as highlighted
 * diffs, writes as file panels, todo/task as progress — raw JSON only when
 * nothing better is known about the tool.
 */
function ToolInputView({ part }: { part: Extract<ConversationPart, { kind: "tool" }> }) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(part.input) as Record<string, unknown>;
  } catch {
    return <pre className="chat-tool-io">{part.input}</pre>;
  }
  const str = (key: string): string | undefined => {
    const value = parsed[key];
    return typeof value === "string" ? value : undefined;
  };

  const command = str("command");
  if (command !== undefined) {
    return (
      <div className="chat-tool-io">
        <pre className="chat-tool-cmd">{command}</pre>
        {(str("cwd") ?? str("description")) !== undefined && (
          <p className="chat-tool-io-meta">{str("cwd") ?? str("description")}</p>
        )}
      </div>
    );
  }

  // claude's Edit carries the old and new strings: render them as the diff they are
  const oldString = str("old_string");
  const newString = str("new_string");
  if (oldString !== undefined || newString !== undefined) {
    return (
      <div className="chat-tool-io">
        {str("file_path") !== undefined && <p className="chat-tool-file">{str("file_path")}</p>}
        {oldString !== undefined && <pre className="chat-diff chat-diff-del">{oldString}</pre>}
        {newString !== undefined && <pre className="chat-diff chat-diff-add">{newString}</pre>}
      </div>
    );
  }

  // omp's edit input is the whole edit-language script: highlight its lines
  const editScript = str("input");
  if (editScript !== undefined) {
    return (
      <pre className="chat-tool-io chat-diff">
        {editScript.split("\n").map((line, index) => (
          <span key={index} className={ompEditLineClass(line)}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    );
  }

  const content = str("content");
  if (content !== undefined) {
    const path = str("file_path") ?? str("path");
    return (
      <div className="chat-tool-io">
        {path !== undefined && <p className="chat-tool-file">{path}</p>}
        <pre className="chat-tool-cmd">{content}</pre>
      </div>
    );
  }

  const path = str("file_path") ?? str("path");
  const pattern = str("pattern");
  if (path !== undefined) {
    return (
      <div className="chat-tool-io">
        <p className="chat-tool-file">{pattern !== undefined ? `${path} — /${pattern}/` : path}</p>
      </div>
    );
  }

  for (const [key, toRows] of [
    ["list", phaseRows],
    ["todos", todoRows],
    ["tasks", taskRows],
  ] as const) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const rows = toRows(value);
      if (rows.length > 0) return <ChecklistView rows={rows} />;
    }
  }

  return <pre className="chat-tool-io">{part.input}</pre>;
}

/** one tool call, collapsed to a chip until opened — the chatmux affordance */
function ToolPart({ part }: { part: Extract<ConversationPart, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-tool">
      <button
        type="button"
        className="chat-tool-chip"
        aria-expanded={open}
        title={open ? "collapse" : "show input and output"}
        onClick={() => setOpen(!open)}
      >
        <span className="chat-tool-name">{part.name}</span>
        <span className="chat-tool-summary">{part.summary}</span>
        <span className="chat-tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="chat-tool-detail">
          <ToolInputView part={part} />
          {part.output.length > 0 && <pre className="chat-tool-io chat-tool-output">{part.output}</pre>}
        </div>
      )}
    </div>
  );
}

/** chatmux's grouped run: N consecutive same-name calls in one collapsed block */
function ToolRun({ group }: { group: ToolRunGroup }) {
  const [open, setOpen] = useState(false);
  const summaries = group.tools.map((tool) => tool.summary).filter((summary) => summary.length > 0);
  return (
    <div className="chat-tool chat-tool-run">
      <button
        type="button"
        className="chat-tool-chip is-run"
        aria-expanded={open}
        title={open ? "collapse" : `${group.tools.length} ${group.name} calls`}
        onClick={() => setOpen(!open)}
      >
        <span className="chat-tool-name">{group.name}</span>
        <span className="chat-tool-summary">
          {open ? `×${group.tools.length} calls` : (
            <>×{group.tools.length} — {summaries.slice(0, 2).join(" · ")}{summaries.length > 2 ? " ·…" : ""}</>
          )}
        </span>
        <span className="chat-tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="chat-tool-run-detail">
          {group.tools.map((tool, index) => (
            <ToolPart key={index} part={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function Turn({ turn, agent }: { turn: ConversationTurn; agent: string | null }) {
  if (turn.role === "user") {
    return (
      <div className="chat-turn chat-turn-user">
        <span className="chat-role">you</span>
        <div className="chat-bubble">
          {turn.parts.map((part, index) =>
            part.kind === "text" ? <TextPart key={index} text={part.text} /> : <ToolPart key={index} part={part} />,
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="chat-turn chat-turn-agent">
      {agent !== null && (
        <span className="chat-role chat-role-agent">
          <AgentMark agent={agent} size={14} />
          {agent}
        </span>
      )}
      {groupToolRuns(turn.parts).map((part, index) =>
        part.kind === "tool-group" ? (
          <ToolRun key={index} group={part} />
        ) : part.kind === "tool" ? (
          <ToolPart key={index} part={part} />
        ) : (
          <TextPart key={index} text={part.text} />
        ),
      )}
    </div>
  );
}

/**
 * The pane as a chat: structured conversation turns when herdr names a
 * recognized agent session (Claude's or omp's own transcript store, like
 * chatmux), the ANSI-stripped scrollback as bubbles otherwise. The xterm view stays mounted
 * and attached underneath — this is a lens over the same pane, not a second
 * connection; the composer still types into the pty.
 */
export function ChatView({ paneId, refreshKey, connected, ended, agent }: ChatViewProps) {
  const [state, setState] = useState<ChatState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let cancelled = false;
    // a pane switch abandons a slower earlier read instead of flashing its text
    const readForPane = paneId;

    const read = async (): Promise<void> => {
      try {
        const conversation = await fetchPaneConversation(readForPane);
        if (cancelled) return;
        if (conversation.source !== "scrollback") {
          setState({ source: "conversation", turns: conversation.turns, messages: [], truncated: false });
        } else {
          // no recognized store: the pane as scrollback bubbles (chatmux's terminal fallback)
          const result = await fetchPaneTranscript(readForPane, TRANSCRIPT_LINES);
          if (cancelled) return;
          setState({ source: "scrollback", turns: [], messages: toTranscriptMessages(result.text), truncated: result.truncated === true });
        }
        setError(null);
        setErrorStatus(null);
      } catch (err) {
        if (cancelled) return;
        // the transcript stays on screen; the note names what failed
        setError(err instanceof Error ? err.message : String(err));
        setErrorStatus(err instanceof ApiError ? err.status : null);
      }
    };

    stickToBottom.current = true;
    setState(EMPTY_STATE);
    setError(null);
    setErrorStatus(null);
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [paneId, refreshKey]);

  // follow the newest message unless the reader scrolled up on purpose
  useEffect(() => {
    const node = scroller.current;
    if (node === null || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [state]);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    stickToBottom.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 48;
  };

  const empty = state.source === "conversation" ? state.turns.length === 0 : state.messages.length === 0;

  return (
    <div
      className="chat-view"
      ref={scroller}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label={`conversation of ${paneId}`}
    >
      {state.source === "conversation"
        ? state.turns.map((turn, index) => <Turn key={index} turn={turn} agent={agent} />)
        : state.messages.map((message, index) => (
            <div key={index} className={`chat-msg chat-${message.role}`}>
              {message.role === "user" && <span className="chat-role">you</span>}
              {message.text}
            </div>
          ))}
      {!ended && !connected && <p className="chat-note">reconnecting…</p>}
      {ended && <p className="chat-note">terminal ended</p>}
      {error !== null && (
        <p className="chat-note chat-note-error" role="alert">
          {errorStatus === 401 ? "locked — the token gate is asking again" : error}
        </p>
      )}
      {empty && error === null && <p className="chat-note">no conversation yet</p>}
    </div>
  );
}
