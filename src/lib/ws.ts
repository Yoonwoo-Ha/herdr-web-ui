import type { ClientMessage, ClientRole, ServerFeature, ServerMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";

type Handler = (message: ServerMessage) => void;

/** How a composer message ended: ok once the pane has it and its Enter, else why not. */
export type SubmitResult = { ok: true } | { ok: false; code: string; message: string };

/** Right after a reconnect the snapshot that says what the server supports may still be on its way. */
const SNAPSHOT_WAIT_MS = 2000;
/** A submit the server never answers: the composer stops waiting and keeps the text. */
const SUBMIT_TIMEOUT_MS = 30_000;
const DISCONNECTED: SubmitResult = { ok: false, code: "disconnected", message: "the connection dropped before the pane confirmed this message" };

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
  private retries = 0;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private mode: ClientRole = "interact";
  private outputStopped = false;
  /** what the connected server listed in its snapshot: empty until it arrives, and on older bridges */
  private features = new Set<ServerFeature>();
  /** settles when this connection's snapshot arrives (or the connection ends) */
  private snapshotSeen: Promise<void> = Promise.resolve();
  private markSnapshot: () => void = () => {};
  private nextSubmit = 1;
  /** submits waiting for their submit-result, by id */
  private readonly submits = new Map<number, (result: SubmitResult) => void>();

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
    this.features = new Set();
    this.snapshotSeen = new Promise((resolve) => { this.markSnapshot = resolve; });

    socket.addEventListener("open", () => {
      this.retries = 0;
      // always send the role, never only when non-default: a user can flip the role
      // while disconnected (setMode stores it without sending), so without this frame
      // the reconnect would leave the server on the stale role and no ack would ever
      // arrive - the UI would stay stuck in the old role while the header pill lies
      this.rawSend({ type: "role", mode: this.mode });
      for (const [paneId, state] of this.attached) {
        this.rawSend({ type: "attach", pane_id: paneId, cols: state.cols, rows: state.rows, flow_control: "ack" });
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        /* ignore malformed frame */
        return;
      }
      if (message.type === "snapshot") {
        this.features = new Set(message.features ?? []);
        this.markSnapshot();
      }
      if (message.type === "submit-result") {
        const settle = this.submits.get(message.id);
        this.submits.delete(message.id);
        settle?.(message.ok ? { ok: true } : { ok: false, code: message.code ?? "submit_failed", message: message.message ?? "the pane did not take the message" });
      }
      // A terminal/parser failure is not malformed JSON and must not disappear.
      this.emit(message);
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.markSnapshot();
      this.settleSubmits(DISCONNECTED);
      if (event.code === OUTPUT_STALLED_CLOSE_CODE) {
        this.outputStopped = true;
        this.emit({ type: "error", code: "output_stalled", message: "Terminal output stopped because this device could not keep up." });
        return;
      }
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
    // Role/attach/geometry already live in state. Replaying both that state and
    // a queue used to attach twice and duplicate the initial terminal replay.
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
    this.send({ type: "attach", pane_id: paneId, cols, rows, flow_control: "ack" });
    if (this.outputStopped) {
      this.outputStopped = false;
      this.connect();
    }
  }

  /** Capture connection AND subscription before xterm's asynchronous write. Never queue ACKs. */
  outputAcknowledgement(message: Extract<ServerMessage, { type: "pty-data" }>): (() => void) | undefined {
    const flow = message.flow;
    if (!flow) return undefined;
    const connection = this.socket;
    const subscription = this.attached.get(message.pane_id);
    return () => {
      if (!connection || this.socket !== connection || !this.connected || !subscription
        || this.attached.get(message.pane_id) !== subscription) return;
      this.rawSend({ type: "pty-ack", pane_id: message.pane_id, stream_id: flow.stream_id, offset: flow.offset });
    };
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

  /**
   * Types a composer message and submits it, straight to the socket: a Ctrl armed on the
   * terminal key bar must not turn a one-letter message into a control key. A server
   * listing "submit" sends the Enter itself, after a gap, and says how it went; an older
   * bridge gets the payload and its Enter in one frame, as before. `text` is the message
   * as written, `payload` the same shaped for the pane's paste mode. null, sending
   * nothing, when offline.
   */
  submit(paneId: string, text: string, payload: string): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null) return null;
    return (async (): Promise<SubmitResult> => {
      await Promise.race([this.snapshotSeen, new Promise((resolve) => window.setTimeout(resolve, SNAPSHOT_WAIT_MS))]);
      if (!this.connected || this.socket !== socket) return DISCONNECTED;
      if (!this.features.has("submit")) {
        this.rawSend({ type: "input", pane_id: paneId, text: `${payload}\r` });
        return { ok: true };
      }
      const id = this.nextSubmit++;
      const result = new Promise<SubmitResult>((resolve) => {
        this.submits.set(id, resolve);
        window.setTimeout(() => {
          if (!this.submits.delete(id)) return;
          resolve({ ok: false, code: "timeout", message: "the pane did not confirm this message in time" });
        }, SUBMIT_TIMEOUT_MS);
      });
      this.rawSend({ type: "submit", id, pane_id: paneId, text, payload });
      return await result;
    })();
  }

  private settleSubmits(result: SubmitResult): void {
    for (const settle of this.submits.values()) settle(result);
    this.submits.clear();
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
    this.settleSubmits(DISCONNECTED);
    this.handlers.clear();
  }
}
