import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { controlCode, isPrintable, keySequence, type KeyBarKey } from "../lib/keys.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, type InputDraft } from "../lib/draft.ts";
import { composerPayload } from "../lib/compose.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { uploadPaneImage } from "../lib/api.ts";
import { KeyBar } from "./KeyBar.tsx";
import { Composer } from "./Composer.tsx";
import type { ClientRole, ServerMessage } from "../../shared/protocol.ts";

const FONT_STACK =
  '"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Noto Sans Mono CJK KR", "Malgun Gothic", monospace';

export interface PaneTerminalProps {
  paneId: string | null;
  /** The connection's desired role; changes are sent to the server, acks come back via onRoleAck. */
  role?: ClientRole;
  /** Fires with the server-confirmed role (the header toggle shows it). */
  onRoleAck?: (mode: ClientRole) => void;
  /** Fires on every change of the socket's connected state (the header shows it). */
  onConnectionChange?: (connected: boolean) => void;
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  onServerMessage?: (message: ServerMessage) => void;
}

export function PaneTerminal({ paneId, role = "interact", onRoleAck, onConnectionChange, onServerMessage }: PaneTerminalProps) {
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
  // one-shot Control from the key bar: the ref is what onData reads, the state is what the bar shows
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  const [observing, setObserving] = useState(false);
  // input typed while disconnected, held for the user to review and send
  const [draft, setDraft] = useState<InputDraft>(EMPTY_DRAFT);
  const draftPaneRef = useRef<string | null>(null);
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);

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
      fontSize: 13,
      fontFamily: FONT_STACK,
      theme: {
        background: "#0b0e14",
        foreground: "#c5cdd9",
        cursor: "#6cb6ff",
        selectionBackground: "#2d3f5e",
      },
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

    const socket = new HerdrSocket();
    socketRef.current = socket;
    const off = socket.on((message) => {
      onServerMessageRef.current?.(message);
      if (message.type === "pty-data") {
        if (message.pane_id !== paneRef.current) return;
        // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
        term.write(message.data);
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
  }, []);

  // follow the selected pane
  useEffect(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!socket || !term) return;
    setEnded(false);
    setDraft(EMPTY_DRAFT);
    draftPaneRef.current = null;
    term.reset();
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
  // Returns false (composer keeps the text) when the socket is already dead, so a
  // send racing a disconnect degrades to "held", never to a silently lost message.
  const sendComposerText = useCallback((text: string): boolean => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return false;
    term.input(composerPayload(text, term.modes.bracketedPasteMode));
    return true;
  }, []);

  const uploadImage = useCallback((file: File) => uploadPaneImage(paneRef.current ?? "", file), []);

  return (
    <div className="terminal-stack">
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
        {paneId !== null && ended && (
          <div className="terminal-banner" role="status">
            terminal ended{!draftIsEmpty(draft) ? " — held input discarded" : ""}
          </div>
        )}
        {paneId !== null && !ended && !connected && (
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
      <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} />
      {paneId !== null && !observing && !ended && (
        <Composer key={paneId} connected={connected} onSend={sendComposerText} onUploadImage={uploadImage} />
      )}
      {paneId !== null && !observing && <KeyBar onKey={pressKey} ctrlArmed={ctrlArmed} onToggleCtrl={toggleCtrl} />}
    </div>
  );
}
