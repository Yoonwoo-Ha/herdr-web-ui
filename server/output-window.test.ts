import { describe, expect, it } from "bun:test";
import { OutputWindow, OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, replayTail } from "./output-window.ts";

describe("terminal output credit", () => {
  it("holds high-water backpressure until the low watermark, without duplicate credit", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES - 1);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.blocked).toBe(false);
    const pending = window.pending;
    window.acknowledge(window.id, 0);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.pending).toBe(pending);
  });

  it("rejects stale subscriptions, impossible offsets and non-integer credit", () => {
    const old = new OutputWindow();
    const current = new OutputWindow();
    current.write(100);
    expect(current.acknowledge(old.id, 100)).toBe(false);
    for (const value of [-1, 101, 0.5, NaN, Infinity]) expect(current.acknowledge(current.id, value)).toBe(false);
    expect(current.pending).toBe(100);
    expect(current.acknowledge(current.id, 100)).toBe(true);
    expect(current.pending).toBe(0);
  });

  it("bounds replay in bytes without corrupting Korean or emoji at the cut", () => {
    const text = "시작🙂끝";
    for (let limit = 1; limit <= Buffer.byteLength(text); limit++) {
      const tail = replayTail("prefix", text, limit);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(limit);
      expect(tail).not.toContain("�");
      expect(text.endsWith(tail)).toBe(true);
    }
  });
});
