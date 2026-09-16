import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { HerdrSocket } from "../lib/ws.ts";

const FONT_STACK = '"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Noto Sans Mono CJK KR", "Malgun Gothic", monospace';

export function PaneTerminal({ paneId }: { paneId: string | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const revisionRef = useRef<number>(-1);
  const [connected, setConnected] = useState(false);

  paneRef.current = paneId;

  // one terminal + one socket for the lifetime of the component
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 5000,
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
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* host not laid out yet */
      }
    });

    const socket = new HerdrSocket();
    socketRef.current = socket;
    const off = socket.on((message) => {
      if (message.type === "pane-output") {
        if (message.pane_id !== paneRef.current) return;
        if (message.revision <= revisionRef.current) return;
        revisionRef.current = message.revision;
        // the server sends the pane's full current screen, so repaint wholesale
        term.reset();
        term.write(message.text);
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
        /* ignore transient zero-size */
      }
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
    if (!socket || !term) return;
    revisionRef.current = -1;
    term.reset();
    if (!paneId) return;
    socket.watch(paneId);
    return () => {
      socket.unwatch(paneId);
    };
  }, [paneId]);

  return (
    <>
      {paneId === null && <div className="terminal-placeholder">Select a pane to open its terminal</div>}
      {paneId !== null && !connected && <div className="terminal-banner">reconnecting to herdr-br…</div>}
      <div className="pane-terminal" ref={hostRef} />
    </>
  );
}
