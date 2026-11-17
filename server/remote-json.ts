const KiB = 1024;
const MiB = 1024 * KiB;
export const REMOTE_LIMITS = {
  bridgeIdentity: 64 * KiB,
  bridgeError: 8 * KiB,
  health: 64 * KiB,
  ownUpdates: 64 * KiB,
  bundleManifest: MiB,
  sessionSnapshot: 64 * MiB,
  proxy: 64 * MiB,
  watchedPrompt: MiB,
} as const;

/** Fixed messages: neither carries the URL, the token or any of the answer. */
export class RemoteResponseTooLarge extends Error {
  constructor() { super("The other PC's answer was larger than this app accepts"); this.name = "RemoteResponseTooLarge"; }
}
export class RemoteResponseInvalid extends Error {
  constructor() { super("The other PC's answer could not be read"); this.name = "RemoteResponseInvalid"; }
}

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export async function readCapped(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await discard(response); throw new RemoteResponseTooLarge(); }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new RemoteResponseTooLarge(); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function parseJson<T>(bytes: Uint8Array): T {
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
  catch { throw new RemoteResponseInvalid(); }
}

export async function readCappedJson<T>(response: Response, limit: number): Promise<T> {
  return parseJson<T>(await readCapped(response, limit));
}
