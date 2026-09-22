// Count UTF-8 payload bytes, not JSON framing or UTF-16 string length. A fresh
// subscription id keeps delayed callbacks from acknowledging a later attach.
export const OUTPUT_HIGH_BYTES = 256 * 1024;
export const OUTPUT_LOW_BYTES = 64 * 1024;
export const OUTPUT_HARD_BYTES = 1024 * 1024;
export const OUTPUT_STALL_MS = 2000;

export class OutputWindow {
  readonly id = crypto.randomUUID();
  sent = 0;
  acknowledged = 0;
  blocked = false;

  get pending(): number { return this.sent - this.acknowledged; }

  write(bytes: number): number {
    this.sent += bytes;
    if (this.pending >= OUTPUT_HIGH_BYTES) this.blocked = true;
    return this.sent;
  }

  acknowledge(id: string, offset: number): boolean {
    if (id !== this.id || !Number.isSafeInteger(offset) || offset < 0 || offset > this.sent) return false;
    // Duplicate and out-of-order ACKs cannot release credit twice.
    this.acknowledged = Math.max(this.acknowledged, offset);
    if (this.pending <= OUTPUT_LOW_BYTES) this.blocked = false;
    return true;
  }
}

/** Keep a bounded UTF-8 tail without starting in the middle of a code point. */
export function replayTail(previous: string, data: string, limit: number): string {
  const bytes = Buffer.from(previous + data);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}
