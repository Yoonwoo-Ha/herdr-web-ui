import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { controlCode, isPrintable, keySequence, type KeyBarKey } from "../lib/keys.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, type InputDraft } from "../lib/draft.ts";
import { QUEUE_READY_STATUS, composerPayload } from "../lib/compose.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { KeyBar } from "./KeyBar.tsx";
import { ChatView } from "./ChatView.tsx";
import { Composer } from "./Composer.tsx";
import type { AgentStatus, ClientRole, ConversationMetadata, ServerMessage } from "../../shared/protocol.ts";
import type { PaneView } from "../lib/actions.ts";
import { terminalTheme, type ResolvedTheme } from "../lib/settings.ts";

const FONT_STACK =
  '"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Noto Sans Mono CJK KR", "Malgun Gothic", monospace';

/** The one message parked for a pane, tagged with the pane it belongs to. */
interface QueuedMessage {
  pane: string;
  text: string;
}

export interface PaneTerminalProps {
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /** the pane's agent name — the chat lens labels the assistant's voice with it */
  agent?: string | null;
  /** the pane's live agent status: `working` turns composer sends into the queue */
  agentStatus?: AgentStatus;
  /** the lens over the pane: the chat transcript, or the live xterm grid (App remembers it per pane) */
  view: PaneView;
  /** xterm font size (settings) */
  terminalFontSize: number;
  /** the resolved UI theme: the xterm theme object mirrors it */
  theme: ResolvedTheme;
  /** The connection's desired role; changes are sent to the server, acks come back via onRoleAck. */
  role?: ClientRole;
  /** Fires with the server-confirmed role (the header toggle shows it). */
  onRoleAck?: (mode: ClientRole) => void;
  /** Fires on every change of the socket's connected state (the header shows it). */
  onConnectionChange?: (connected: boolean) => void;
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  onServerMessage?: (message: ServerMessage) => void;
}

export function PaneTerminal({
  paneId,
  agent = null,
  agentStatus,
  view,
  terminalFontSize,
  theme,
  role = "interact",
  onRoleAck,
  onConnectionChange,
  onServerMessage,
}: PaneTerminalProps) {
  const machineId = useMachineId();
  const { uploadPaneImage } = useMachineApi();
  const chatView = view === "chat";
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  // one-shot Control from the key bar: the ref is what onData reads, the state is what the bar shows
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  const [observing, setObserving] = useState(false);
  // input typed while disconnected, held for the user to review and send
  const [draft, setDraft] = useState<InputDraft>(EMPTY_DRAFT);
  const draftPaneRef = useRef<string | null>(null);
  const draftOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!paneId) return;
    const owner = paneStorageId(machineId, paneId);
    if (draftOwner.current !== owner) { draftOwner.current = owner; return; }
    try { if (draftIsEmpty(draft)) localStorage.removeItem(`herdr-web-ui:terminal-draft:${owner}`); else localStorage.setItem(`herdr-web-ui:terminal-draft:${owner}`, JSON.stringify(draft)); } catch {}
  }, [draft, paneId]);
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  // the composer's send bumps this so the chat lens refetches without waiting a poll beat
  const [chatRefresh, setChatRefresh] = useState(0);
  const [chatMetadata, setChatMetadata] = useState<{ pane: string; value: ConversationMetadata | null } | null>(null);
  const onChatMetadata = useCallback((pane: string, value: ConversationMetadata | null) => {
    setChatMetadata((previous) => previous?.pane === pane && previous.value?.model === value?.model
      && previous.value?.reasoning_effort === value?.reasoning_effort ? previous : { pane, value });
  }, []);
  // The next message is held per target in localStorage for an explicit send. It carries the
  // pane it was written for, because a pane switch changes `agent`/`agentStatus`
  // in the same commit that reloads this state: without the tag, the dispatch
  // effect sees the OLD text beside the NEW pane's ready status and types one
  // pane's message into another pane's agent.
  const queueOwner = useRef<string | null>(null);
  const [queued, setQueued] = useState<QueuedMessage | null>(null);

  paneRef.current = paneId;
  onConnectionChangeRef.current = onConnectionChange;
  onServerMessageRef.current = onServerMessage;
  onRoleAckRef.current = onRoleAck;

  useEffect(() => {
    onConnectionChangeRef.current?.(connected);
  }, [connected]);

  const noteClipboard = useCallback((note: string) => {
    if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
    setClipboardNote(note);
    clipboardTimerRef.current = window.setTimeout(() => {
      clipboardTimerRef.current = null;
      setClipboardNote(null);
    }, 2500);
  }, []);

  // one terminal + one socket for the lifetime of the component
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // xterm keeps no scrollback: the attach stream lives in the alternate screen and herdr
      // owns scrollback (wheel and touch go to it). With scrollback on, the fit addon reserves
      // a scrollbar column - 15px by fallback wherever scrollbars are overlays - and the last
      // columns of the hero surface go dead.
      scrollback: 0,
      allowProposedApi: true,
      fontSize: terminalFontSize,
      fontFamily: FONT_STACK,
      theme: terminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // OSC 52: the pane program asked the terminal to set the clipboard - the pty
    // cannot reach the browser clipboard, so xterm hands us the sequence and
    // navigator.clipboard completes the hop (text only; queries are ignored)
    const osc52 = term.parser.registerOscHandler(52, (payload) => {
      const text = parseOsc52(payload);
      if (text !== null) {
        void navigator.clipboard?.writeText(text).then(
          () => noteClipboard("copied to clipboard"),
          () => noteClipboard("clipboard write blocked by the browser"),
        );
      }
      return true;
    });

    const socket = new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}`);
    socketRef.current = socket;
    const off = socket.on((message) => {
      onServerMessageRef.current?.(message);
      if (message.type === "pty-data") {
        if (message.pane_id !== paneRef.current) return;
        // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
        term.write(message.data, socket.outputAcknowledgement(message));
      } else if (message.type === "pty-exit") {
        if (message.pane_id === paneRef.current) setEnded(true);
      } else if (message.type === "role-ack") {
        // the server is the authority on the role; only after this ack may an
        // interact client reclaim the shared grid it stopped owning
        const nowObserving = message.mode === "observe";
        observeRef.current = nowObserving;
        setObserving(nowObserving);
        term.options.disableStdin = nowObserving;
        onRoleAckRef.current?.(message.mode);
        if (!nowObserving) {
          try {
            fit.fit();
          } catch {
            /* not laid out yet */
          }
          const pane = paneRef.current;
          if (pane) socket.resize(pane, term.cols, term.rows, true);
        }
      } else if (message.type === "pane-geometry") {
        // observe clients adopt the pty's grid; interact clients drive it and ignore this
        if (!observeRef.current || message.pane_id !== paneRef.current) return;
        if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
      } else if (message.type === "error") {
        if (message.code === "output_stalled" || message.code === "attach_conflict") {
          setOutputError(message.message);
          setEnded(true);
          setConnected(false);
          term.options.disableStdin = true;
          return;
        }
        term.writeln(`\r\n\u001b[31m[herdr-web-ui] ${message.code}: ${message.message}\u001b[0m`);
      }
      setConnected(socket.connected);
    });
    socket.connect();

    const poll = window.setInterval(() => setConnected(socket.connected), 1000);

    const onData = term.onData((data) => {
      const current = paneRef.current;
      if (!current || observeRef.current) return;
      if (!socket.connected) {
        // policy: commands typed into a dead connection are never auto-sent on
        // reconnect - they wait in a draft the user reviews (see the banner below)
        if (draftPaneRef.current !== current) {
          draftPaneRef.current = current;
          setDraft(EMPTY_DRAFT);
        }
        setDraft((prev) => applyToDraft(prev, data));
        return;
      }
      if (ctrlRef.current && isPrintable(data)) {
        ctrlRef.current = false;
        setCtrlArmed(false);
        socket.sendInput(current, controlCode(data) ?? data);
        return;
      }
      socket.sendInput(current, data);
    });

    const observer = new ResizeObserver(() => {
      if (observeRef.current) return; // the grid belongs to the pty while observing
      try {
        fit.fit();
      } catch {
        return;
      }
      const current = paneRef.current;
      if (current) socket.resize(current, term.cols, term.rows);
    });
    observer.observe(host);

    // Touch screens never emit wheel events and xterm.js has no touch scrolling:
    // translate a single-finger drag on the terminal into wheel events, so the
    // normal buffer scrolls its own viewport and the alternate buffer (with mouse
    // reporting on) forwards the gesture to herdr, exactly like a mouse wheel.
    let touchY = 0;
    let tracking = false;
    const onTouchStart = (event: TouchEvent): void => {
      tracking = event.touches.length === 1;
      const first = event.touches[0];
      if (tracking && first) touchY = first.clientY;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;
      event.preventDefault();
      const first = event.touches[0];
      const y = first ? first.clientY : touchY;
      // finger moving up (y < touchY) must scroll up, i.e. a negative wheel deltaY
      const delta = y - touchY;
      touchY = y;
      if (delta !== 0) {
        const target = term.element ?? host;
        target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: delta }));
      }
    };
    const onTouchEnd = (): void => {
      tracking = false;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });

    // The pty is shared per pane: a client on another device (typically a phone)
    // resizes it to its own geometry, and this tab's viewport never changed, so
    // the ResizeObserver above stays silent and the pane is left at the other
    // device's size. Re-assert our geometry whenever this tab comes back. Observe
    // connections never do this: they own no geometry to re-assert.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current || observeRef.current) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      socket.resize(current, term.cols, term.rows, true);
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refit();
    };
    window.addEventListener("focus", refit);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(poll);
      observer.disconnect();
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("focus", refit);
      document.removeEventListener("visibilitychange", onVisible);
      onData.dispose();
      osc52.dispose();
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      off();
      socket.close();
      term.dispose();
      termRef.current = null;
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
  }, []);

  // theme and font size follow the settings without a remount; a font change moves the grid
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme(theme);
    if (term.options.fontSize !== terminalFontSize) {
      term.options.fontSize = terminalFontSize;
      if (observeRef.current) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      const pane = paneRef.current;
      if (pane) socketRef.current?.resize(pane, term.cols, term.rows, true);
    }
  }, [theme, terminalFontSize]);

  // the grid must re-fit when the lens switches back: the chat lens covered it, and a
  // resize while covered may have been skipped by a zero-size layout
  useEffect(() => {
    if (chatView || observeRef.current) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
    } catch {
      return;
    }
    const pane = paneRef.current;
    if (pane && term) socketRef.current?.resize(pane, term.cols, term.rows, true);
    term?.focus();
  }, [chatView]);

  // follow the selected pane
  useEffect(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!socket || !term) return;
    setEnded(false);
    setOutputError(null);
    term.options.disableStdin = observeRef.current;
    draftOwner.current = null;
    let saved = EMPTY_DRAFT;
    try {
      const value = paneId ? JSON.parse(localStorage.getItem(`herdr-web-ui:terminal-draft:${paneStorageId(machineId, paneId)}`) ?? "null") : null;
      if (value && typeof value.text === "string" && Number.isInteger(value.droppedSpecial)) saved = value;
    } catch {}
    setDraft(saved);
    draftPaneRef.current = paneId;
    term.reset();
    // a message queued for the next idle moment is remembered per pane
    queueOwner.current = null;
    setQueued(() => {
      if (paneId === null) return null;
      try {
        const text = window.localStorage.getItem(`herdr-web-ui:queue:${paneStorageId(machineId, paneId)}`);
        return text === null ? null : { pane: paneId, text };
      } catch { return null; }
    });
    if (!paneId) return;
    try {
      fit?.fit();
    } catch {
      /* not laid out yet; the ResizeObserver will follow up */
    }
    socket.attach(paneId, term.cols, term.rows);
    term.focus();
    return () => {
      socket.detach(paneId);
    };
  }, [paneId]);


  // key-bar taps go through xterm so the onData -> socket path above is reused
  const pressKey = useCallback((key: KeyBarKey) => {
    const term = termRef.current;
    if (!term) return;
    term.input(keySequence(key, term.modes.applicationCursorKeysMode));
    term.focus();
  }, []);

  const toggleCtrl = useCallback(() => {
    const armed = !ctrlRef.current;
    ctrlRef.current = armed;
    setCtrlArmed(armed);
    termRef.current?.focus();
  }, []);

  // ask the server for the role change; the role-ack handler applies the local
  // consequences (stdin gate, grid adoption or reclamation) once it is confirmed.
  // The initial default is skipped: the server already treats fresh connections as interact.
  const lastSentRole = useRef<ClientRole>(role);
  useEffect(() => {
    if (role === lastSentRole.current) return;
    lastSentRole.current = role;
    socketRef.current?.setMode(role);
  }, [role]);

  const sendDraft = useCallback(() => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || !pane || draft.text.length === 0 || !socket.connected) return;
    socket.sendInput(pane, draft.text);
    setDraft(EMPTY_DRAFT);
  }, [draft]);

  const discardDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);

  // the composer rides the same term.input() -> onData -> socket path as the key
  // bar: one input path, and the never-queue draft policy still governs it on a
  // dead socket. Bracketed-paste wrapping follows the pane program's own mode.
  const sendComposerText = useCallback((text: string): boolean => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return false;
    term.input(composerPayload(text, term.modes.bracketedPasteMode));
    // the chat lens refetches at once so the sent prompt appears without a poll beat
    setChatRefresh((current) => current + 1);
    return true;
  }, []);

  // the composer's stop button: Escape interrupts the agent's current turn in every
  // supported TUI (Claude Code, omp, codex) without killing the process the way ^C would
  const abortTurn = useCallback(() => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return;
    term.input("\u001b");
  }, []);

  // chatmux's queue-next: while the pane's agent runs, a send becomes the ONE
  // queued message; it leaves the queue when the agent is known to be ready.
  const busy = agent !== null && agentStatus === "working";
  const readyForQueue = agentStatus !== undefined && QUEUE_READY_STATUS[agentStatus] === true;

  const composerSend = useCallback(
    (text: string): boolean => {
      const pane = paneRef.current;
      if (pane !== null && agent !== null && agentStatus === "working") {
        setQueued({ pane, text });
        return true; // the composer may clear its box: the text lives in the queue card
      }
      return sendComposerText(text);
    },
    [agent, agentStatus, sendComposerText],
  );

  // A reconnect or status refresh never sends held text without a user action.
  // Held messages survive reloads but always require review and an explicit send.
  useEffect(() => {
    const pane = paneRef.current;
    if (pane === null) return;
    const owner = paneStorageId(machineId, pane);
    if (queueOwner.current !== owner) { queueOwner.current = owner; return; }
    try {
      if (queued !== null && queued.pane === pane && queued.text.trim().length > 0) {
        window.localStorage.setItem(`herdr-web-ui:queue:${paneStorageId(machineId, pane)}`, queued.text);
      } else if (queued === null) window.localStorage.removeItem(`herdr-web-ui:queue:${paneStorageId(machineId, pane)}`);
    } catch {
      /* private mode: the queue just stops being remembered */
    }
  }, [queued]);

  // Capture the owner's pane for the entire upload batch, even across a pane switch.
  const uploadImage = useCallback((file: File) => uploadPaneImage(paneId ?? "", file), [paneId]);

  return (
    <div className={`terminal-stack${chatView ? " is-chat" : ""}`}>
      {paneId === null && (
        <div className="terminal-placeholder">
          <div className="terminal-placeholder-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
              <path d="M7 9l3 3-3 3" />
              <path d="M12.5 15h4.5" />
            </svg>
            <span>Select a pane to open its terminal</span>
          </div>
        </div>
      )}
      <div className="terminal-banners">
        {paneId !== null && outputError && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <a className="btn" href={`?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}`}>Reconnect</a>
          </div>
        )}
        {/* the chat lens says these itself (ChatView), inline; the pills are the grid's */}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            terminal ended{!draftIsEmpty(draft) ? " — held input discarded" : ""}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connected && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            reconnecting to herdr web ui…
            {!draftIsEmpty(draft) && <span className="draft-held"> input held: “{draft.text}”</span>}
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            <span className="draft-label">input held while disconnected:</span>
            <code className="draft-text">{draft.text.length > 0 ? draft.text : "—"}</code>
            {draft.droppedSpecial > 0 && (
              <span className="draft-dropped">{draft.droppedSpecial} special key{draft.droppedSpecial === 1 ? "" : "s"} dropped</span>
            )}
            <span className="draft-actions">
              <button type="button" className="draft-send" disabled={draft.text.length === 0 || observing} onClick={sendDraft}>
                Send
              </button>
              <button type="button" className="draft-discard" onClick={discardDraft}>
                Discard
              </button>
            </span>
          </div>
        )}
        {paneId !== null && !ended && observing && (
          <div className="terminal-banner terminal-banner-observe" role="status">
            view only — the operator’s screen size is untouched
          </div>
        )}
        {clipboardNote && (
          <div className="terminal-banner" role="status">
            {clipboardNote}
          </div>
        )}
      </div>
      <div className="terminal-surface">
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} />
        {paneId !== null && chatView && (
          <ChatView
            paneId={paneId}
            refreshKey={chatRefresh}
            connected={connected}
            ended={ended}
            agent={agent}
            agentStatus={agentStatus}
            onMetadata={onChatMetadata}
          />
        )}
      </div>
      {paneId !== null && !observing && !ended && queued !== null && queued.pane === paneId && (
        <div className="composer-queue" role="group" aria-label="Queued next message">
          <span className="composer-queue-label">
            {readyForQueue ? "Held message — review and send" : "Held until the agent is ready"}
          </span>
          <textarea
            className="composer-queue-text"
            value={queued.text}
            rows={Math.min(4, queued.text.split("\n").length)}
            aria-label="Queued message"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setQueued({ pane: queued.pane, text: event.target.value })}
          />
          <span className="composer-queue-actions">
            <button
              type="button"
              className="composer-queue-send"
              disabled={!connected}
              onClick={() => {
                if (sendComposerText(queued.text)) setQueued(null);
              }}
            >
              Send now
            </button>
            <button type="button" className="composer-queue-discard" onClick={() => setQueued(null)}>
              Discard
            </button>
          </span>
        </div>
      )}
      {/* the composer belongs to the chat lens: in terminal mode the grid itself is
          the input surface (key bar included), so a second box would only duplicate it */}
      {paneId !== null && chatView && !observing && !ended && (
        <Composer
          key={paneId}
          paneId={paneId}
          agent={agent}
          agentStatus={agentStatus}
          metadata={chatMetadata?.pane === paneId ? chatMetadata.value : null}
          connected={connected}
          queueMode={busy}
          onSend={composerSend}
          onAbort={abortTurn}
          onUploadImage={uploadImage}
        />
      )}
      {paneId !== null && !observing && !chatView && <KeyBar onKey={pressKey} ctrlArmed={ctrlArmed} onToggleCtrl={toggleCtrl} />}
    </div>
  );
}
