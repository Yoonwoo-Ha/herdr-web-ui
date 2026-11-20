import { describe, expect, it } from "bun:test";
import { holdWaitMs } from "./joinHold.ts";

const NOW = Date.parse("2026-11-20T04:00:00.000Z");

describe("the ten-second wait", () => {
  it("T53: follows the PC's own deadline, never a timer the app starts", () => {
    expect(holdWaitMs({ reason: "join_hold", until: "2026-11-20T04:00:07.500Z" }, NOW)).toBe(7_500);
    expect(holdWaitMs({ reason: "join_hold", until: "2026-11-20T03:59:59.000Z" }, NOW)).toBe(0);
  });

  it("T53: a hold that is not the join hold has no countdown", () => {
    expect(holdWaitMs({ reason: "catching_up" }, NOW)).toBeNull();
    expect(holdWaitMs({ reason: "frozen", block: "d".repeat(64) }, NOW)).toBeNull();
  });

  it("P17: a join hold whose notice is not yet published has no countdown yet", () => {
    expect(holdWaitMs({ reason: "join_hold", until: null }, NOW)).toBeNull();
  });

  it("T67: a PC that sends no hold has no wait", () => {
    expect(holdWaitMs(undefined, NOW)).toBe(0);
  });
});
