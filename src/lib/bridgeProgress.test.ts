import { describe, expect, it } from "bun:test";

import { describeProgress, formatRemaining } from "./bridgeProgress.ts";

const MB = 1024 * 1024;

describe("bridge update progress", () => {
  it("says the step, the bytes and a rounded time left for a stage with a size", () => {
    expect(describeProgress({ stage: "upload", done: 45 * MB, total: 130 * MB, rate: MB, elapsed_ms: 45_000 })).toEqual({
      step: "Step 2 of 4", label: "Sending it to the PC", percent: 34, detail: "45 MB of 130 MB · about 1 min left",
    });
    expect(describeProgress({ stage: "download", done: 120 * MB, total: 130 * MB, rate: MB, elapsed_ms: 1000 })?.detail).toBe("120 MB of 130 MB · about 10 s left");
  });

  it("leaves out the time before there is a rate, and the size for a stage without one", () => {
    expect(describeProgress({ stage: "download", done: 0, total: 130 * MB, rate: null, elapsed_ms: 0 })?.detail).toBe("0 MB of 130 MB");
    expect(describeProgress({ stage: "install", done: 0, total: null, rate: null, elapsed_ms: 3000 })).toEqual({ step: "Step 3 of 4", label: "Verifying and installing", percent: null, detail: null });
    expect(describeProgress(null)).toBeNull();
  });

  it("rounds a guess instead of pretending to precision", () => {
    expect(formatRemaining(3)).toBe("about 5 s");
    expect(formatRemaining(44)).toBe("about 45 s");
    expect(formatRemaining(200)).toBe("about 3 min");
  });
});
