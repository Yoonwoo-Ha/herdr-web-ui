import { describe, expect, it } from "bun:test";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";

const snapshot = (panes: { id: string; status: string; focused?: boolean }[]): SessionSnapshot => ({
  panes: panes.map((pane) => ({ pane_id: pane.id, agent: "claude", agent_status: pane.status, focused: pane.focused ?? false })),
  agents: panes.map((pane) => ({ pane_id: pane.id, agent_status: pane.status, focused: pane.focused ?? false })),
} as unknown as SessionSnapshot);

describe("CompletionTracker", () => {
  it("reports an idle after work as done while the pane is not focused, as herdr does for agents it does not lose", async () => {
    const tracker = new CompletionTracker(async () => "other");
    // omo, live-traced: pi/working, then claude/unknown, then claude/idle
    expect(await tracker.observe("p", "working", "pi")).toBe("working");
    // the turn goes on under omo's claude child: still working, not unknown
    expect(await tracker.observe("p", "unknown", "claude")).toBe("working");
    expect(await tracker.observe("p", "idle", "claude")).toBe("done");
    // snapshots keep saying done until the pane is focused
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("done");
    const seen = tracker.present(snapshot([{ id: "p", status: "idle", focused: true }]));
    expect(seen.panes[0]!.agent_status).toBe("idle");
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
  });

  it("leaves idle alone when the pane is focused, never worked, or herdr said done itself", async () => {
    const focused = new CompletionTracker(async () => "p");
    await focused.observe("p", "working");
    expect(await focused.observe("p", "idle")).toBe("idle");
    const tracker = new CompletionTracker(async () => null);
    expect(await tracker.observe("q", "idle")).toBe("idle");
    await tracker.observe("q", "working");
    expect(await tracker.observe("q", "done")).toBe("done");
    expect(await tracker.observe("q", "idle")).toBe("idle");
  });

  it("drops a finish overtaken by a newer event of the same pane", async () => {
    let answer: (pane: string | null) => void = () => {};
    const tracker = new CompletionTracker(() => new Promise((resolve) => { answer = resolve; }));
    await tracker.observe("p", "working");
    const finishing = tracker.observe("p", "idle");
    expect(await tracker.observe("p", "working")).toBe("working");
    answer(null);
    expect(await finishing).toBeNull();
    expect(tracker.present(snapshot([{ id: "p", status: "working" }])).panes[0]!.agent_status).toBe("working");
  });

  it("lets an unknown with no agent left be unknown: the agent quit", async () => {
    const tracker = new CompletionTracker(async () => null);
    await tracker.observe("p", "working", "gjc");
    expect(await tracker.observe("p", "unknown", null)).toBe("unknown");
    expect(await tracker.observe("p", "idle", null)).toBe("idle");
  });

  it("forgets panes that left the snapshot", async () => {
    const tracker = new CompletionTracker(async () => null);
    await tracker.observe("gone", "working");
    await tracker.observe("gone", "idle");
    tracker.present(snapshot([]));
    expect(tracker.present(snapshot([{ id: "gone", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
  });
});
