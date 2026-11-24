/**
 * A line to herdr-core straight over its socket, for a client that must never start a core: every
 * hc command but `--version`, `hc connect` included (hc-connect.ts), starts one when none runs.
 * Here a socket file that is missing, or that nobody listens on (a core that died leaves its file),
 * is an HcError `no_core`, and nothing is started. On Windows the path is hc's named pipe, which
 * Bun.connect takes as it takes a socket file (pipe.ts).
 */

import { liveSessionsRefused } from "../herdr/test-session.ts";
import { HcError, type HcTransport } from "./connection.ts";
import { coreSocket, userCore } from "./core-socket.ts";

/** what a connect fails with when no core listens: no socket file (or pipe), or a file nobody accepts on */
const NO_CORE = new Set(["ENOENT", "ECONNREFUSED"]);

/**
 * An HcTransport over the socket at `path`, by default the one this environment's core listens on
 * (coreSocket). Each call is one connect attempt, never retried or reopened here: when to reconnect
 * is the caller's policy.
 */
export async function connectCoreSocket(path: string = coreSocket().path): Promise<HcTransport> {
  // a process that asked for an isolated herdr never reaches the user's default core, as spawnHcConnect refuses it
  if (liveSessionsRefused(process.env) && userCore({ HC_SOCKET: path })) {
    throw new HcError("live_core_refused", `HERDR_TEST_SESSION is set, but ${path} is the user's own herdr-core: connect to a core of the test's own, or set OVIS_ALLOW_LIVE_HERDR=1`);
  }
  /** bytes the socket has not taken yet, in the order they were written */
  const queue: Uint8Array[] = [];
  let ended = false;
  const { promise: exited, resolve: settle } = Promise.withResolvers<void>();
  let reading!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (controller) => { reading = controller; } });

  let socket: Bun.Socket<undefined>;
  try {
    socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_socket, chunk) => reading.enqueue(chunk),
        drain: (open) => flush(open),
        close: () => {
          if (ended) return;
          ended = true;
          queue.length = 0;
          settle();
          // a reader that cancelled the stream closed it already
          try { reading.close(); } catch { /* cancelled */ }
        },
        // the close that follows ends the line
        error: () => {},
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (NO_CORE.has(code)) throw new HcError("no_core", `no herdr-core listens at ${path} (${code})`);
    throw new HcError("closed", `herdr-core's socket ${path} could not be opened: ${code || (error instanceof Error ? error.message : String(error))}`);
  }

  function flush(open: Bun.Socket<undefined>): void {
    while (queue.length > 0) {
      const head = queue[0]!;
      const sent = open.write(head);
      // the socket took part of it: the rest waits for drain, and everything written after it behind it
      if (sent < head.length) {
        if (sent > 0) queue[0] = head.subarray(sent);
        return;
      }
      queue.shift();
    }
  }

  return {
    readable,
    write: (bytes) => {
      // a closed socket takes no more: its end is reported through `exited`
      if (ended) return;
      queue.push(bytes);
      if (queue.length === 1) flush(socket);
    },
    exited,
    kill: () => socket.terminate(),
  };
}
