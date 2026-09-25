import { describe, expect, it } from "bun:test";
import type { EventFrame } from "./herdr/client.ts";
import { parseStatusFrame, parseStructureFrame } from "./collector.ts";

/**
 * Frame shapes are the live wire format observed against herdr protocol 22 (see
 * collector.ts's header): status frames are flat with a dotted `event` key,
 * structure frames carry a snake_case `data.type`.
 */

describe("parseStatusFrame", () => {
  it("parses a real agent_status_changed frame", () => {
    const frame: EventFrame = {
      event: "pane.agent_status_changed",
      data: { agent: "claude", agent_status: "blocked", pane_id: "w3J:p1", workspace_id: "w3J" },
    };
    expect(parseStatusFrame(frame)).toEqual({ paneId: "w3J:p1", status: "blocked", agent: "claude" });
  });

  it("rejects frames that are not status events", () => {
    expect(parseStatusFrame({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p1" } })).toBeNull();
  });

  it("rejects malformed payloads instead of throwing", () => {
    expect(parseStatusFrame({ event: "pane.agent_status_changed", data: { pane_id: 7 } })).toBeNull();
    expect(parseStatusFrame({ event: "pane.agent_status_changed" })).toBeNull();
    expect(parseStatusFrame({})).toBeNull();
  });
});

describe("parseStructureFrame", () => {
  it("parses a pane_exited frame into a pane-ended event", () => {
    const frame: EventFrame = { event: "pane_exited", data: { type: "pane_exited", pane_id: "w3M:p1", workspace_id: "w3M" } };
    expect(parseStructureFrame(frame)).toEqual({ kind: "pane-ended", paneId: "w3M:p1" });
  });

  it("parses pane_created and pane_closed into a structure-changed event", () => {
    expect(parseStructureFrame({ data: { type: "pane_created" } })).toEqual({ kind: "structure-changed" });
    expect(parseStructureFrame({ data: { type: "pane_closed", pane_id: "w1:p1" } })).toEqual({ kind: "structure-changed" });
  });

  it("rejects unknown or malformed frames", () => {
    expect(parseStructureFrame({ data: { type: "workspace_closed" } })).toBeNull();
    expect(parseStructureFrame({ data: { type: "pane_exited", pane_id: 42 } })).toBeNull();
    expect(parseStructureFrame({})).toBeNull();
  });
});

