/** True when `work` settled within `ms`, false at the limit; the timer never outlives the call. */
export async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Tail {
  text(): string;
  /**
   * Waits up to `ms` for the stream's end. At the limit the reader is cancelled (a descendant that holds
   * the pipe open is never signalled) and `"cancelled"` is returned; the text keeps what was read.
   */
  finish(ms: number): Promise<"complete" | "cancelled">;
}

/** Keeps only the last `keep` characters of a stream and reads the rest away, so a noisy child never fills memory. */
export function drainTail(stream: ReadableStream<Uint8Array>, keep: number): Tail {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  const done = (async () => {
    try {
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        tail = (tail + decoder.decode(part.value, { stream: true })).slice(-keep);
      }
    } catch (error) {
      tail = `${tail}[read failed: ${error instanceof Error ? error.message : String(error)}]`.slice(-keep);
    }
  })();
  return {
    text: () => tail,
    async finish(ms) {
      if (await settledWithin(done, ms)) return "complete";
      const cancelled = reader.cancel().catch((error: unknown) => {
        tail = `${tail}[cancel failed: ${error instanceof Error ? error.message : String(error)}]`.slice(-keep);
      });
      await settledWithin(cancelled, ms);
      await settledWithin(done, ms);
      return "cancelled";
    },
  };
}
