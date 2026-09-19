import { useEffect, useRef, useState } from "react";

import "./ChatView.css";

import { ApiError, fetchPaneTranscript } from "../lib/api.ts";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";

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
}

interface TranscriptState {
  messages: TranscriptMessage[];
  truncated: boolean;
}

/**
 * The pane as a chat transcript: herdr's scrollback (pane.read recent) parsed
 * into bubbles. The xterm view stays mounted and attached underneath — this is
 * a lens over the same pane, not a second connection.
 */
export function ChatView({ paneId, refreshKey, connected, ended }: ChatViewProps) {
  const [state, setState] = useState<TranscriptState>({ messages: [], truncated: false });
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
        const result = await fetchPaneTranscript(readForPane, TRANSCRIPT_LINES);
        if (cancelled) return;
        setState({ messages: toTranscriptMessages(result.text), truncated: result.truncated === true });
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
    setState({ messages: [], truncated: false });
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

  return (
    <div
      className="chat-view"
      ref={scroller}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label={`transcript of ${paneId}`}
    >
      {state.truncated && <p className="chat-note">older output trimmed by the read limit</p>}
      {state.messages.map((message, index) => (
        <div key={index} className={`chat-msg chat-${message.role}`}>
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
      {state.messages.length === 0 && error === null && <p className="chat-note">no transcript yet</p>}
    </div>
  );
}
