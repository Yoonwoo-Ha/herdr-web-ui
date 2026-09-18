import { describe, expect, it } from "bun:test";
import type { AgentStatus } from "../../shared/protocol.ts";
import { shouldNotifyStatus } from "./notifications.ts";

describe("shouldNotifyStatus", () => {
  it("notifies when a known pane becomes blocked", () => {
    expect(shouldNotifyStatus("working", "blocked")).toBe(true);
  });

  it("notifies when a known pane becomes done", () => {
    expect(shouldNotifyStatus("blocked", "done")).toBe(true);
  });

  it("does not notify for the busy baseline states", () => {
    expect(shouldNotifyStatus("idle", "working")).toBe(false);
    expect(shouldNotifyStatus("working", "idle")).toBe(false);
  });

  it("does not notify when the status does not change", () => {
    expect(shouldNotifyStatus("blocked", "blocked")).toBe(false);
  });

  it("does not notify on first sight of a pane", () => {
    // the app just opened or the pane is new: not news
    expect(shouldNotifyStatus(undefined, "blocked")).toBe(false);
  });

  it("carries unknown future statuses through without notifying", () => {
    expect(shouldNotifyStatus("working", "teleporting" as AgentStatus)).toBe(false);
  });
});
