/** Text shows its first part: this also bounds parsing and highlighting in the viewer. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;

export interface FilePreviewText {
  text: string;
  truncated: boolean;
  /** The whole size reported with the body, not the earlier stat. */
  total?: number;
}

/** Range is a request, not a client memory limit: a peer can ignore it or a file can grow. */
export async function readFilePreviewText(response: Response, limit: number, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<FilePreviewText> {
  const discard = () => { void response.body?.cancel().catch(() => {}); };
  // An empty file has no first byte to send for Range. Discard any error body, never render it.
  if (response.status === 416 && response.headers.get("content-range")?.trim() === "bytes */0") {
    discard();
    return { text: "", truncated: false, total: 0 };
  }
  if (!response.ok) { discard(); throw new Error("The file could not be opened."); }
  if (!Number.isSafeInteger(limit) || limit < 1) { discard(); throw new Error("Invalid preview limit."); }
  const range = response.status === 206 ? /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "") : null;
  if (response.status === 206 && (!range || Number(range[1]) >= Number(range[2]))) { discard(); throw new Error("Invalid file range."); }
  const reader = response.body?.getReader();
  // a 206 names the file's whole size, so a cut there can say how much is shown
  const total = range ? { total: Number(range[2]) } : {};
  if (!reader) return { text: "", truncated: range !== null, ...total };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  // Only partial files lose an incomplete final line; a single huge line keeps its whole characters.
  const finish = (truncated: boolean): FilePreviewText => {
    const newline = text.lastIndexOf("\n");
    return { text: truncated ? (newline < 0 ? text : text.slice(0, newline + 1)) : text + decoder.decode(), truncated, ...total };
  };
  let stopped: Error | undefined;
  let reject!: (error: Error) => void;
  const interruption = new Promise<never>((_, fail) => { reject = fail; });
  const stop = (error: Error) => { stopped = error; reject(error); void reader.cancel().catch(() => {}); };
  const aborted = () => stop(new Error("File preview aborted."));
  const timer = setTimeout(() => stop(new Error("File preview timed out.")), options.timeoutMs ?? 5_000);
  options.signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (options.signal?.aborted) { aborted(); await interruption; }
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interruption]);
      if (stopped) throw stopped;
      if (done) return finish(range !== null && bytes < Number(range[2]));
      const remaining = limit - bytes;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += Math.min(remaining, value.byteLength);
      if (bytes >= limit) {
        let more = value.byteLength > remaining || (range !== null && Number(range[2]) > bytes);
        // a 200 that ends exactly at the budget is the whole file: look for one more chunk before calling it cut
        if (!more && range === null) {
          const next = await Promise.race([reader.read(), interruption]);
          if (stopped) throw stopped;
          more = !next.done;
        }
        // Never wait on a remote cancellation promise, or a hostile/stalled body can hold the UI.
        void reader.cancel().catch(() => {});
        return finish(more);
      }
    }
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); reader.releaseLock();
  }
}
