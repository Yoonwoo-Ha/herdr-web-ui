import type {
  PaneReadResult,
  ReadFormat,
  ReadSource,
  SessionSnapshot,
} from "../../shared/protocol.ts";

const DEFAULT_SOCKET = `${process.env.HOME ?? ""}/.config/herdr/herdr.sock`;
const DEFAULT_TIMEOUT_MS = 10_000;

export function herdrSocketPath(): string {
  return process.env.HERDR_SOCKET ?? DEFAULT_SOCKET;
}

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

let requestCounter = 0;
function nextId(): string {
  requestCounter += 1;
  return `br-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * Splits a growing buffer into complete newline-terminated frames.
 * herdr frames arrive split across reads, so partial tails must be retained.
 */
function makeLineReader(onLine: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

/**
 * One request, one connection.
 * The herdr server closes the connection after a single response, so a pooled
 * or reused socket would never see a second reply.
 */
export async function herdrRpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  socketPath: string = herdrSocketPath(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const id = nextId();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let socket: { end: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        /* the server may already have closed it */
      }
      fn();
    };

    timer = setTimeout(
      () => finish(() => reject(new HerdrError("timeout", `herdr ${method} timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );

    const handleLine = (line: string) => {
      let frame: { id?: string; result?: unknown; error?: { code?: string; message?: string } };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        finish(() => reject(new HerdrError("bad_frame", `herdr sent unparseable frame: ${line.slice(0, 200)}`)));
        return;
      }
      if (frame.error) {
        const { code = "herdr_error", message = "herdr request failed" } = frame.error;
        finish(() => reject(new HerdrError(code, message)));
        return;
      }
      finish(() => resolve(frame.result as T));
    };

    const onData = makeLineReader(handleLine);

    Bun.connect({
      unix: socketPath,
      socket: {
        data(_sock, chunk) {
          onData(chunk);
        },
        error(_sock, err) {
          finish(() => reject(new HerdrError("socket_error", err?.message ?? "herdr socket error")));
        },
        close() {
          finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
        },
      },
    })
      .then((sock) => {
        socket = sock;
        if (settled) {
          try {
            sock.end();
          } catch {
            /* already gone */
          }
          return;
        }
        sock.write(`${JSON.stringify({ id, method, params })}\n`);
      })
      .catch((err: Error) => {
        finish(() =>
          reject(new HerdrError("connect_failed", `cannot reach herdr at ${socketPath}: ${err.message}`)),
        );
      });
  });
}

export async function ping(socketPath?: string): Promise<{ version: string; protocol: number }> {
  const result = await herdrRpc<{ version: string; protocol: number }>("ping", {}, socketPath);
  return { version: result.version, protocol: result.protocol };
}

export async function sessionSnapshot(socketPath?: string): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {}, socketPath);
  return result.snapshot;
}

export interface PaneReadOptions {
  paneId: string;
  source?: ReadSource;
  format?: ReadFormat;
  lines?: number;
  stripAnsi?: boolean;
}

export async function paneRead(options: PaneReadOptions, socketPath?: string): Promise<PaneReadResult> {
  const { paneId, source = "visible", format = "text", lines, stripAnsi } = options;
  // Escape sequences must survive for xterm.js, so an ansi read defaults to strip_ansi:false.
  const strip = stripAnsi ?? format !== "ansi";
  const params: Record<string, unknown> = { pane_id: paneId, source, format, strip_ansi: strip };
  if (lines !== undefined) params["lines"] = lines;
  const result = await herdrRpc<{ read: PaneReadResult }>("pane.read", params, socketPath);
  return result.read;
}

export async function paneSendText(paneId: string, text: string, socketPath?: string): Promise<void> {
  await herdrRpc("pane.send_text", { pane_id: paneId, text }, socketPath);
}

export async function paneSendKeys(paneId: string, keys: string[], socketPath?: string): Promise<void> {
  await herdrRpc("pane.send_keys", { pane_id: paneId, keys }, socketPath);
}

export interface HerdrSubscription {
  type: string;
  pane_id?: string;
  [key: string]: unknown;
}

export interface EventFrame {
  event?: string;
  data?: Record<string, unknown>;
}

export interface SubscribeHandlers {
  onEvent: (frame: EventFrame) => void;
  onStarted?: () => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface Subscription {
  close: () => void;
}

/**
 * Long-lived connection. Unlike ordinary RPC, events.subscribe keeps the socket
 * open and streams frames until the caller closes it.
 */
export function subscribeEvents(
  subscriptions: HerdrSubscription[],
  handlers: SubscribeHandlers,
  socketPath: string = herdrSocketPath(),
): Subscription {
  let closed = false;
  let socket: { end: () => void } | null = null;
  let started = false;

  const onData = makeLineReader((line) => {
    let frame: { id?: string; result?: { type?: string }; error?: { code?: string; message?: string } } & EventFrame;
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return;
    }
    if (frame.error) {
      handlers.onError?.(new HerdrError(frame.error.code ?? "herdr_error", frame.error.message ?? "subscription failed"));
      return;
    }
    if (!started && frame.result?.type === "subscription_started") {
      started = true;
      handlers.onStarted?.();
      return;
    }
    handlers.onEvent(frame);
  });

  Bun.connect({
    unix: socketPath,
    socket: {
      data(_sock, chunk) {
        onData(chunk);
      },
      error(_sock, err) {
        if (!closed) handlers.onError?.(new HerdrError("socket_error", err?.message ?? "herdr socket error"));
      },
      close() {
        if (!closed) {
          closed = true;
          handlers.onClose?.();
        }
      },
    },
  })
    .then((sock) => {
      socket = sock;
      if (closed) {
        try {
          sock.end();
        } catch {
          /* already gone */
        }
        return;
      }
      sock.write(`${JSON.stringify({ id: nextId(), method: "events.subscribe", params: { subscriptions } })}\n`);
    })
    .catch((err: Error) => {
      handlers.onError?.(new HerdrError("connect_failed", err.message));
    });

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        socket?.end();
      } catch {
        /* already gone */
      }
    },
  };
}
