import { connect } from "node:net";
export class LineClosed extends Error {}
export class LineTimeout extends Error {}

/** One request and one reply per connection. No unattended retry: the request may already have run. */
export function lineCall(socket: string, request: object, timeoutMs: number, maxBytes = 262144 + 1): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const stream = connect(socket);
    let buffer = "";
    let bytes = 0;
    const timer = setTimeout(() => stream.destroy(new LineTimeout()), timeoutMs);
    stream.once("connect", () => stream.write(`${JSON.stringify(request)}\n`));
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { stream.destroy(new Error("Socket reply too large.")); return; }
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
      stream.destroy();
    });
    stream.once("error", reject);
    stream.once("close", () => { clearTimeout(timer); reject(new LineClosed()); });
  });
}
