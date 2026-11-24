import { KeeperDisconnected, KeeperRequestError, record, text, type Message } from "./messages.ts";

interface InFlight { resolve: (result: unknown) => void; reject: (error: Error) => void }
/** The local calls on a keeper connection: a prompt's delivery receipt and the agent's reply
 * have separate lifetimes. Neither is transferred to a later connection. */
export class KeeperRequests {
  private nextId = 1;
  private readonly receipts = new Map<number, () => void>();
  private readonly inFlight = new Map<number, InFlight>();

  constructor(private readonly write: (message: unknown) => void) {}

  /** Chat waits for the writer, not the end of a turn that may itself wait for an approval. */
  async submit(sessionId: string, text: string, expectedMode?: string): Promise<void> {
    const id = this.nextId++;
    const receipt = Promise.withResolvers<void>();
    this.receipts.set(id, receipt.resolve);
    const timer = setTimeout(() => receipt.reject(new KeeperDisconnected()), 5000);
    try {
      this.inFlight.set(id, { resolve: () => {}, reject: receipt.reject });
      this.write({ jsonrpc: "2.0", id, method: expectedMode !== undefined ? "_keeper/tool_prompt" : "session/prompt", ...(expectedMode !== undefined ? { expectedMode } : {}), params: { sessionId, prompt: [{ type: "text", text }] } });
      await receipt.promise;
    } finally { clearTimeout(timer); this.receipts.delete(id); this.inFlight.delete(id); }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new KeeperDisconnected());
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.inFlight.set(id, { resolve, reject });
    const abort = () => { this.inFlight.delete(id); reject(new KeeperDisconnected()); };
    signal?.addEventListener("abort", abort, { once: true });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise.finally(() => signal?.removeEventListener("abort", abort));
  }

  delivered(key: unknown): void {
    if (typeof key === "number") this.receipts.get(key)?.();
  }

  answered(message: Message): void {
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return;
    const call = this.inFlight.get(id);
    if (call === undefined) return;
    if (!this.receipts.has(id)) this.inFlight.delete(id);
    const error = record(message.error);
    if (error !== null) call.reject(new KeeperRequestError(typeof error["code"] === "number" ? error["code"] : 0, text(error["message"]) ?? "error"));
    else call.resolve(message.result);
  }

  dropped(): void {
    for (const call of this.inFlight.values()) call.reject(new KeeperDisconnected());
    this.inFlight.clear();
  }
}
