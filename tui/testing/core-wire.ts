import { createConnection, createServer, type Socket } from "node:net";
import { encodeFrame, FRAME_DATA, makeFrameReader, type Frame } from "../../server/herdr-core/connection.ts";

type Request = { readonly method: string; readonly params: Record<string, unknown> };

/** Observe a screen's real socket traffic separately from that of the test's other viewers. */
export async function coreWire(path: string, firstTarget: string) {
  const frames: Frame[] = [];
  const received: Frame[] = [];
  const requests: Request[] = [];
  const sockets = new Map<Socket, Socket>();
  const lines = new WeakMap<Frame, Socket>();
  let target = firstTarget;
  let accepting = true;
  const stopId = "fidelity-stop";
  let stopping: { upstream: Socket; reply: ReturnType<typeof Promise.withResolvers<unknown>> } | undefined;
  const server = createServer((client) => {
    if (!accepting) { client.destroy(); return; }
    const upstream = createConnection(target);
    sockets.set(client, upstream);
    let hello = false;
    const read = makeFrameReader((frame) => {
      if (frame.channel === 0 && frame.kind === FRAME_DATA) {
        requests.push(JSON.parse(Buffer.from(frame.payload).toString("utf8")));
      } else if (frame.channel !== 0) frames.push(frame);
    }, (error) => client.destroy(new Error(error)));
    let answered = false;
    const readCore = makeFrameReader((frame) => {
      if (frame.channel === 0 && frame.kind === FRAME_DATA && stopping?.upstream === upstream) {
        const response = JSON.parse(Buffer.from(frame.payload).toString("utf8"));
        if (response.id === stopId) {
          stopping.reply.resolve(response);
          stopping = undefined;
        }
      } else if (frame.channel !== 0) {
        received.push(frame);
        lines.set(frame, client);
      }
    }, (error) => client.destroy(new Error(error)));
    client.on("data", (chunk: Buffer) => {
      if (hello) { read(chunk); return; }
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      hello = true;
      read(chunk.subarray(newline + 1));
    });
    upstream.on("data", (chunk: Buffer) => {
      if (answered) { readCore(chunk); return; }
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      answered = true;
      readCore(chunk.subarray(newline + 1));
    });
    client.on("error", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => {
      if (stopping?.upstream === upstream) {
        stopping.reply.reject(new Error("the core closed before answering framed server.stop"));
        stopping = undefined;
      }
      client.destroy();
    });
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const cut = () => {
    accepting = false;
    for (const socket of sockets.keys()) socket.destroy();
  };
  return {
    frames, received, requests,
    viewerData(on: Frame, bytes: string) {
      const client = lines.get(on);
      if (!client || client.destroyed) throw new Error("the observed attach's viewer has closed");
      client.write(encodeFrame(on.channel, FRAME_DATA, bytes));
    },
    stopCore(): Promise<unknown> {
      const [upstream] = sockets.values();
      if (sockets.size !== 1 || !upstream || stopping) throw new Error("framed stop needs one live viewer connection");
      // The plain CLI request can shut down the core before the viewer's terminal.list round trip.
      // Framed shutdown flushes its reply and final events before exiting. Use a string id so
      // the viewer, whose own requests use numeric ids, ignores our control reply.
      const reply = Promise.withResolvers<unknown>();
      stopping = { upstream, reply };
      upstream.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: stopId, method: "server.stop", params: {} })));
      return reply.promise;
    },
    cut,
    resume(next = target) { target = next; accepting = true; },
    close: () => {
      cut();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
