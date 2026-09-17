import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { KeyBar, type KeyBarKey } from "./KeyBar.tsx";

const FONT_STACK =
  '"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Noto Sans Mono CJK KR", "Malgun Gothic", monospace';

/** A single printable character: what the one-shot Control modifier consumes. */
function isPrintable(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/** The control code for A-Z and @ [ \ ] ^ _ (Ctrl+C = 0x03, Ctrl+[ = ESC, ...), null otherwise. */
function controlCode(ch: string): string | null {
  if (!/^[A-Za-z@[\\\]^_]$/.test(ch)) return null;
  return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
}

/** What a key-bar tap feeds xterm; arrows follow the application cursor keys mode like a real keyboard. */
function keySequence(term: Terminal, key: KeyBarKey): string {
  const cursor = (final: "A" | "B" | "C" | "D"): string => (term.modes.applicationCursorKeysMode ? "\u001bO" : "\u001b[") + final;
  switch (key) {
    case "Escape":
      return "\u001b";
    case "Tab":
      return "\t";
    case "ctrl-c":
      return "\u0003";
    case "ArrowUp":
      return cursor("A");
    case "ArrowDown":
      return cursor("B");
    case "ArrowRight":
      return cursor("C");
    case "ArrowLeft":
      return cursor("D");
  }
}

export interface PaneTerminalProps {
  paneId: string | null;
  /** Fires on every change of the socket's connected state (the header shows it). */
  onConnectionChange?: (connected: boolean) => void;
}

export function PaneTerminal({ paneId, onConnectionChange }: PaneTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  // one-shot Control from the key bar: the ref is what onData reads, the state is what the bar shows
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);

  paneRef.current = paneId;
  onConnectionChangeRef.current = onConnectionChange;

  useEffect(() => {
    onConnectionChangeRef.current?.(connected);
  }, [connected]);

  // one terminal + one socket for the lifetime of the component
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      scrollback: 10000,
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

    const socket = new HerdrSocket();
    socketRef.current = socket;
    const off = socket.on((message) => {
      if (message.type === "pty-data") {
        if (message.pane_id !== paneRef.current) return;
        // raw pty bytes: append, never repaint, so xterm keeps scrollback and selection
        term.write(message.data);
      } else if (message.type === "pty-exit") {
        if (message.pane_id === paneRef.current) setEnded(true);
      } else if (message.type === "error") {
        term.writeln(`\r\n\u001b[31m[herdr-web-ui] ${message.code}: ${message.message}\u001b[0m`);
      }
      setConnected(socket.connected);
    });
    socket.connect();

    const poll = window.setInterval(() => setConnected(socket.connected), 1000);

    const onData = term.onData((data) => {
      const current = paneRef.current;
      if (!current) return;
      if (ctrlRef.current && isPrintable(data)) {
        ctrlRef.current = false;
        setCtrlArmed(false);
        socket.sendInput(current, controlCode(data) ?? data);
        return;
      }
      socket.sendInput(current, data);
    });

    const observer = new ResizeObserver(() => {
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
    // device's size. Re-assert our geometry whenever this tab comes back.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current) return;
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
    term.input(keySequence(term, key));
    term.focus();
  }, []);

  const toggleCtrl = useCallback(() => {
    const armed = !ctrlRef.current;
    ctrlRef.current = armed;
    setCtrlArmed(armed);
    termRef.current?.focus();
  }, []);

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
      {paneId !== null && ended && (
        <div className="terminal-banner" role="status">
          terminal ended
        </div>
      )}
      {paneId !== null && !ended && !connected && (
        <div className="terminal-banner terminal-banner-warning" role="status">
          reconnecting to herdr web ui…
        </div>
      )}
      <div className="pane-terminal" ref={hostRef} />
      <KeyBar onKey={pressKey} ctrlArmed={ctrlArmed} onToggleCtrl={toggleCtrl} />
    </div>
  );
}
