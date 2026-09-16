import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";

type Handler = (message: ServerMessage) => void;

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Reconnecting client for /ws. Watches are remembered so a dropped connection
 * restores the live terminal instead of silently going stale.
 */
export class HerdrSocket {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Set<Handler>();
  private readonly watched = new Set<string>();
  private queue: ClientMessage[] = [];
  private retries = 0;
  private reconnectTimer: number | null = null;
  private disposed = false;

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
      for (const paneId of this.watched) this.rawSend({ type: "watch", pane_id: paneId });
      const queued = this.queue;
      this.queue = [];
      for (const message of queued) this.rawSend(message);
      this.emit({ type: "pane-status", pane_id: "", agent_status: "unknown" });
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

  watch(paneId: string): void {
    this.watched.add(paneId);
    this.send({ type: "watch", pane_id: paneId });
  }

  unwatch(paneId: string): void {
    this.watched.delete(paneId);
    this.send({ type: "unwatch", pane_id: paneId });
  }

  sendInput(paneId: string, text: string): void {
    this.send({ type: "input", pane_id: paneId, text });
  }

  sendKeys(paneId: string, keys: string[]): void {
    this.send({ type: "keys", pane_id: paneId, keys });
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
