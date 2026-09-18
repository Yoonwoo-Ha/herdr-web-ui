import type { ClientMessage, ClientRole, ServerMessage } from "../../shared/protocol.ts";

type Handler = (message: ServerMessage) => void;

interface AttachState {
  cols: number;
  rows: number;
}

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Reconnecting client for /ws. Attachments are remembered with their geometry so a
 * dropped connection restores the live terminal at the right size instead of
 * leaving a stale screen behind.
 *
 * Two policies live here:
 * - The connection's role survives reconnects: an observe connection re-sends its
 *   role before the attach replay, so a reconnecting phone still cannot resize or
 *   type into the operator's pty.
 * - Terminal input is NEVER queued while disconnected (a command typed into a dead
 *   socket must not fire later, unannounced); PaneTerminal keeps it as a draft the
 *   user reviews instead. Control frames (attach/resize/role) replay as before.
 */
export class HerdrSocket {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Set<Handler>();
  private readonly attached = new Map<string, AttachState>();
  private queue: ClientMessage[] = [];
  private retries = 0;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private mode: ClientRole = "interact";

  constructor(url: string = defaultUrl()) {
    this.url = url;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retries = 0;
      // the role must land before the attaches: the server skips the attach-time
      // resize for observe connections, and WS frames are processed in order
      if (this.mode !== "interact") this.rawSend({ type: "role", mode: this.mode });
      for (const [paneId, state] of this.attached) {
        this.rawSend({ type: "attach", pane_id: paneId, cols: state.cols, rows: state.rows });
      }
      const queued = this.queue;
      this.queue = [];
      for (const message of queued) this.rawSend(message);
    });

    socket.addEventListener("message", (event) => {
      try {
        this.emit(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        /* ignore malformed frame */
      }
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = Math.min(5000, 250 * 2 ** this.retries);
    this.retries += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private rawSend(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private send(message: ClientMessage): void {
    if (this.connected) this.rawSend(message);
    else this.queue.push(message);
  }

  private emit(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  attach(paneId: string, cols: number, rows: number): void {
    this.attached.set(paneId, { cols, rows });
    this.send({ type: "attach", pane_id: paneId, cols, rows });
  }

  detach(paneId: string): void {
    this.attached.delete(paneId);
    this.send({ type: "detach", pane_id: paneId });
  }

  resize(paneId: string, cols: number, rows: number, force = false): void {
    const state = this.attached.get(paneId);
    if (state) {
      // skip only redundant resizes of OUR OWN geometry: a force resize re-asserts
      // it after another client resized the shared pty (see PaneTerminal refit)
      if (!force && state.cols === cols && state.rows === rows) return;
      state.cols = cols;
      state.rows = rows;
    }
    this.send({ type: "resize", pane_id: paneId, cols, rows });
  }

  /** Sets the connection's role. Not queued: the role replays before the attaches on reconnect. */
  setMode(mode: ClientRole): void {
    this.mode = mode;
    if (this.connected) this.rawSend({ type: "role", mode });
  }

  sendInput(paneId: string, text: string): void {
    if (!this.connected) return;
    this.rawSend({ type: "input", pane_id: paneId, text });
  }

  sendKeys(paneId: string, keys: string[]): void {
    if (!this.connected) return;
    this.rawSend({ type: "keys", pane_id: paneId, keys });
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.handlers.clear();
  }
}
