import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { HerdrSocket } from "../lib/ws.ts";

const FONT_STACK =
  '"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Noto Sans Mono CJK KR", "Malgun Gothic", monospace';

export function PaneTerminal({ paneId }: { paneId: string | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);

  paneRef.current = paneId;

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
        term.writeln(`\r\n\u001b[31m[herdr-br] ${message.code}: ${message.message}\u001b[0m`);
      }
      setConnected(socket.connected);
    });
    socket.connect();

    const poll = window.setInterval(() => setConnected(socket.connected), 1000);

    const onData = term.onData((data) => {
      const current = paneRef.current;
      if (current) socket.sendInput(current, data);
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

    return () => {
      window.clearInterval(poll);
      observer.disconnect();
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

  return (
    <>
      {paneId === null && <div className="terminal-placeholder">Select a pane to open its terminal</div>}
      {paneId !== null && ended && <div className="terminal-banner">terminal ended</div>}
      {paneId !== null && !ended && !connected && <div className="terminal-banner">reconnecting to herdr-br…</div>}
      <div className="pane-terminal" ref={hostRef} />
    </>
  );
}
