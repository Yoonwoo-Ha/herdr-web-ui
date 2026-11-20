import { describe, expect, it } from "bun:test";
import { clearDeadline, earliest, NO_DEADLINES, setDeadline } from "./deadlines.ts";

describe("deadlines", () => {
  it("answers nothing when empty", () => {
    expect(earliest(NO_DEADLINES)).toBeUndefined();
  });

  it("answers the only deadline", () => {
    expect(earliest(setDeadline(NO_DEADLINES, "esc", 1_050))).toEqual({ name: "esc", at: 1_050 });
  });

  it("answers the earliest of several, whatever order they were set in", () => {
    let deadlines = setDeadline(NO_DEADLINES, "reconnect", 3_000);
    deadlines = setDeadline(deadlines, "esc", 1_050);
    deadlines = setDeadline(deadlines, "notice", 2_000);
    expect(earliest(deadlines)).toEqual({ name: "esc", at: 1_050 });
  });

  it("replaces a name's time when it is set again, and leaves the earlier value as it was", () => {
    const first = setDeadline(setDeadline(NO_DEADLINES, "esc", 1_050), "notice", 2_000);
    const moved = setDeadline(first, "esc", 5_000);
    expect(earliest(moved)).toEqual({ name: "notice", at: 2_000 });
    expect(moved.size).toBe(2);
    expect(earliest(first)).toEqual({ name: "esc", at: 1_050 });
  });

  it("removes a cleared name, and clearing one that is not set changes nothing", () => {
    const both = setDeadline(setDeadline(NO_DEADLINES, "esc", 1_050), "notice", 2_000);
    expect(earliest(clearDeadline(both, "esc"))).toEqual({ name: "notice", at: 2_000 });
    expect(earliest(clearDeadline(clearDeadline(both, "esc"), "notice"))).toBeUndefined();
    expect(clearDeadline(both, "missing")).toBe(both);
  });

  it("breaks a tie by name, the one that sorts first winning, in either setting order", () => {
    const one = setDeadline(setDeadline(NO_DEADLINES, "notice", 2_000), "esc", 2_000);
    const other = setDeadline(setDeadline(NO_DEADLINES, "esc", 2_000), "notice", 2_000);
    expect(earliest(one)).toEqual({ name: "esc", at: 2_000 });
    expect(earliest(other)).toEqual({ name: "esc", at: 2_000 });
  });
});
