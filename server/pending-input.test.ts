import { describe, expect, it } from "bun:test";
import { MAX_PENDING_PER_OWNER, PendingInputs } from "./pending-input.ts";

function fixture() {
  let now = 1_000;
  let id = 0;
  const receipts: Array<{ owner: string; pane: string; messages: unknown[]; removed?: unknown[] }> = [];
  const queue = new PendingInputs<string, string>((owner, pane, messages, removed) => receipts.push({ owner, pane, messages, removed }), () => now, 100, () => `pending-${++id}`);
  const enqueue = (request: number, owner = "a", pane = "p1", text = `message ${request}`) => queue.enqueue(owner, pane, request, text, "lease", { agent: "claude", terminalId: "t1", session: null });
  return { queue, receipts, enqueue, advance: (ms: number) => { now += ms; queue.expire(); } };
}

describe("bridge pending input", () => {
  it("deduplicates the same connection's request and rejects id reuse for another message", () => {
    const f = fixture();
    const first = f.enqueue(1);
    expect(f.enqueue(1)).toBe(first);
    expect(() => f.enqueue(1, "a", "p1", "different")).toThrow("another message");
    expect(f.queue.list("a", "p1")).toHaveLength(1);
    expect(f.queue.list("a", "p1")[0]?.request_id).toBe(1);
  });

  it("keeps identities and receipts private to the owner and pane", () => {
    const f = fixture();
    const item = f.enqueue(1);
    expect(f.queue.get("b", "p1", item.message.id)).toBeUndefined();
    expect(f.queue.get("a", "p2", item.message.id)).toBeUndefined();
    expect(f.queue.list("b", "p1")).toEqual([]);
    expect(f.receipts[0]?.owner).toBe("a");
  });

  it("bounds the retained queue without dropping a submitted message", () => {
    const f = fixture();
    for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) f.enqueue(i);
    expect(() => f.enqueue(MAX_PENDING_PER_OWNER)).toThrow("full");
    expect(f.queue.list("a", "p1")).toHaveLength(MAX_PENDING_PER_OWNER);
  });

  it("lets automatic delivery and clicking claim the same id only once", () => {
    const f = fixture(); const item = f.enqueue(1);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(item, true)).toBe(true);
    expect(f.queue.claim(item, false)).toBe(false);
    f.queue.committing(item); f.queue.settle(item);
    expect(f.queue.claim(item, false)).toBe(false);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("sent");
    expect(f.queue.outcome("b", "p1", item.message.id)).toBeUndefined();
  });

  it("never offers a held message to automatic delivery, only to an explicit send", () => {
    const f = fixture();
    const held = f.queue.enqueue("a", "p1", 1, "later", "lease", { agent: "claude", terminalId: "t1", session: null }, true);
    const queued = f.enqueue(2);
    expect(held.message.state).toBe("held");
    f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBe(queued);
    expect(f.queue.claim(held, true)).toBe(false);
    expect(f.queue.claim(held, false)).toBe(true);
  });

  it("does not flush a second message from a lagging ready snapshot", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "done");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    f.queue.status("p1", "done"); f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBe(second);
  });

  it("waits for the current work to finish after an explicit steer", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working");
    expect(f.queue.claim(first, false)).toBe(true); f.queue.committing(first, true); f.queue.settle(first);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBe(second);
  });

  for (const settleBeforeIdle of [true, false]) it(`keeps the interruption's ready state from draining the queue (${settleBeforeIdle ? "settled" : "in flight"})`, () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false);
    f.queue.committing(first, true, true);
    if (settleBeforeIdle) f.queue.settle(first);
    f.queue.status("p1", "idle");
    if (!settleBeforeIdle) f.queue.settle(first);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBe(second);
  });

  it("holds remaining input when an interruption never exposes its ready transition", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false);
    f.queue.committing(first, true, true); f.queue.settle(first);
    f.queue.status("p1", "working"); f.queue.status("p1", "working"); f.advance(101);
    expect(second.message.state).toBe("held");
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBeNull();
  });

  it("holds remaining input when the interrupted turn stops but its replacement never starts", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false);
    f.queue.committing(first, true, true); f.queue.settle(first);
    f.queue.status("p1", "idle"); f.advance(101);
    expect(second.message.state).toBe("held");
    expect(second.message.error?.code).toBe("pending_turn_unconfirmed");
  });

  it("retains a restarted turn's completion observed before the send settles", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false); f.queue.committing(first, true, true);
    f.queue.status("p1", "idle"); f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBeNull(); f.queue.settle(first);
    expect(f.queue.next("p1")).toBe(second);
  });

  it("holds the remaining queue when no new turn was confirmed before its deadline", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "idle"); f.queue.claim(first, true); f.queue.committing(first); f.queue.settle(first);
    f.advance(101);
    expect(second.message.state).toBe("held");
    f.queue.status("p1", "working"); f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBeNull();
    expect(f.queue.claim(second, false)).toBe(true);
  });

  it("does not apply the start deadline to a confirmed long-running turn", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "idle"); f.queue.claim(first, true); f.queue.committing(first); f.queue.settle(first);
    f.queue.status("p1", "working"); f.advance(1_000);
    expect(second.message.state).toBe("queued"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBe(second);
  });

  it("holds before dispatch on lease loss, without rearming on subsequent status events", () => {
    const f = fixture(); const item = f.enqueue(1);
    f.queue.hold("a", "p1");
    expect(item.message.state).toBe("held");
    f.queue.status("p1", "working"); f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBeNull();
  });

  it("marks loss during input uncertain and never retries an ambiguous commit", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false); f.queue.close("a");
    expect(first.message.state).toBe("uncertain"); expect(second.message.state).toBe("held");
    f.queue.settle(first, { code: "submit_changed", message: "check terminal" }, true);
    f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBeNull(); expect(f.queue.claim(first, false)).toBe(false);
  });

  it("discards without sending and replays only the explicit removal outcome", () => {
    const f = fixture(); const item = f.enqueue(1);
    expect(f.queue.discard(item)).toBe(true); expect(f.queue.discard(item)).toBe(false);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("discarded");
    expect(f.receipts.at(-1)?.removed).toEqual([{ id: item.message.id, outcome: "discarded" }]);
  });

  it("never drains blocked or unknown states", () => {
    const f = fixture(); f.enqueue(1);
    f.queue.status("p1", "blocked"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "unknown"); expect(f.queue.next("p1")).toBeNull();
  });

  it("keeps an earlier send's unconfirmed turn when a later explicit send is refused before its key", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2); const third = f.enqueue(3);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.claim(second, false)).toBe(true);
    f.queue.settle(second, { code: "pending_lease_lost", message: "lost" });
    expect(second.message.state).toBe("held");
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBe(third);
  });

  it("counts the earlier turn's cycle seen while a later explicit send was being checked", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2); const third = f.enqueue(3);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.claim(second, false)).toBe(true);
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBeNull();
    f.queue.settle(second, { code: "agent_blocked", message: "menu" });
    expect(f.queue.next("p1")).toBe(third);
  });

  it("still holds the rest when the earlier turn never starts, whatever a refused explicit send did", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2); const third = f.enqueue(3);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.claim(second, false)).toBe(true);
    f.queue.settle(second, { code: "pending_lease_lost", message: "lost" });
    f.advance(100);
    expect(third.message.state).toBe("held");
    expect(third.message.error?.code).toBe("pending_turn_unconfirmed");
  });

  it("keeps a completion the collector reported while a snapshot that still said working was being read", () => {
    const f = fixture();
    f.queue.status("p1", "working");
    const mark = f.queue.mark("p1");
    f.queue.status("p1", "done");
    f.queue.observe("p1", "working", mark);
    const item = f.enqueue(1);
    expect(f.queue.next("p1")).toBe(item);
  });

  it("takes a snapshot's status when no event came since, also as the first word on a pane", () => {
    const f = fixture(); const item = f.enqueue(1);
    f.queue.observe("p1", "idle", f.queue.mark("p1"));
    expect(f.queue.next("p1")).toBe(item);
    f.queue.observe("p1", "working", f.queue.mark("p1"));
    expect(f.queue.next("p1")).toBeNull();
  });

  it("knows a pane where a message still waits its turn", () => {
    const f = fixture(); f.enqueue(1);
    expect(f.queue.waiting("p1")).toBe(true);
    expect(f.queue.waiting("p2")).toBe(false);
    f.queue.hold("a");
    expect(f.queue.waiting("p1")).toBe(false);
  });

  it("forgets an ended pane's status and its turn gate", () => {
    const f = fixture(); const first = f.enqueue(1);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    f.queue.status("p1", "working");
    f.queue.forget("p1");
    const second = f.enqueue(2);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBe(second);
  });

  it("ignores another turn's pre-key cycle and waits for the committed message's own cycle", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "idle"); f.queue.claim(first, true);
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBe(second);
  });
});
