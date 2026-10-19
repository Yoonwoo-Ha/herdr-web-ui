import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { useSidebarActivityState, type SidebarActivity } from "./sidebarActivity.tsx";
import { cleanSeen, loadSeen, saveSeen, seenKey, SEEN_LIMIT } from "./seenFinishes.ts";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
function roster(finishes: Record<string, number>, statuses: Record<string, AgentStatus> = {}, epoch: string | undefined = "server-a"): Machine[] {
  const machine = structuredClone(fixture[0]);
  if (!machine?.snapshot) throw new Error("fixture has no snapshot");
  const pane = machine.snapshot.panes[0], agent = machine.snapshot.agents[0];
  if (!pane || !agent) throw new Error("fixture has no agent pane");
  machine.snapshot.finish_epoch = epoch;
  machine.snapshot.panes = Object.entries(finishes).map(([id, finish_id]) => ({ ...pane, pane_id: id, agent_status: statuses[id] ?? "done", finish_id }));
  // Deliberately unchanged: native overrides finish without any herdr counter change.
  machine.snapshot.agents = Object.keys(finishes).map((id) => ({ ...agent, pane_id: id, agent_status: statuses[id] ?? "done", state_change_seq: 5 }));
  return [machine];
}

describe("sidebar finish acknowledgement through React effects", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderers: ReactTestRenderer[];
  let visibility: DocumentVisibilityState;
  let events: EventTarget;
  let storageEvents: EventTarget;
  let data: Map<string, string>;

  beforeEach(() => {
    for (const key of ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    renderers = []; visibility = "visible"; events = new EventTarget(); storageEvents = new EventTarget(); data = new Map();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      addEventListener: storageEvents.addEventListener.bind(storageEvents), removeEventListener: storageEvents.removeEventListener.bind(storageEvents),
    } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    } });
  });
  afterEach(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function storage(key: string, newValue: string | null): Promise<void> {
    await act(async () => {
      const event = new Event("storage");
      Object.defineProperties(event, { key: { value: key }, newValue: { value: newValue } });
      storageEvents.dispatchEvent(event);
    });
  }

  async function open(machines: Machine[], selected: string | null = null, covered = false) {
    let activity: SidebarActivity | undefined;
    let current = machines;
    function Probe({ machines, selected, covered }: { machines: Machine[]; selected: string | null; covered: boolean }) {
      // Keep callback identity stable between the hook's own renders.
      activity = useSidebarActivityState(machines, "local", selected, inFronts[Number(covered)]!);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(createElement(Probe, { machines, selected, covered })); });
    if (!renderer) throw new Error("probe did not mount");
    const mounted = renderer; renderers.push(mounted);
    return {
      status(id: string, override?: Partial<HerdrPane>): AgentStatus | undefined {
        const pane = current[0]?.snapshot?.panes.find((pane) => pane.pane_id === id);
        if (!activity || !pane) throw new Error("probe has no pane");
        return activity.status("local", { ...pane, ...override });
      },
      async update(next: Machine[], selected: string | null = null, covered = false): Promise<void> {
        current = next;
        await act(async () => { mounted.update(createElement(Probe, { machines: next, selected, covered })); });
      },
    };
  }
  const inFronts = [() => true, () => false];

  for (const state of ["connecting", "reconnecting", "disconnected"] as const) {
    it(`keeps cached read finishes ready while ${state}, without marking an unseen selected pane`, async () => {
      const client = await open(roster({ a: 1, b: 1 }), "a");
      const offline = roster({ a: 1, b: 1 });
      offline[0]!.state = state;
      await client.update(offline, "b");
      expect(client.status("a")).toBe("idle");
      expect(client.status("b")).toBe("done");
      expect(loadSeen("local", "server-a")).toEqual({ a: 1 });
      const reopened = await open(offline, "b");
      expect(reopened.status("a")).toBe("idle");
      expect(reopened.status("b")).toBe("done");
    });
  }

  it("does not scan unrelated stored finishes again to clean a repeated acknowledgement", async () => {
    const client = await open(roster({ a: 1 }), "a");
    let unrelatedReads = 0;
    const read = localStorage.getItem;
    const key = seenKey("remote", "server-b", "other");
    data.set(key, JSON.stringify({ id: 4, at: 1 }));
    localStorage.getItem = (name) => { if (name === key) unrelatedReads++; return read(name); };
    await client.update(roster({ a: 1 }), "a");
    expect(unrelatedReads).toBe(0);
    await client.update(roster({ a: 2 }), "a");
    expect(unrelatedReads).toBe(1);
  });

  it("does not mark WORKING; a later native DONE with unchanged herdr seq keeps its dot", async () => {
    const client = await open(roster({ a: 1 }, { a: "working" }), "a");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 2 }));
    expect(client.status("a")).toBe("done");
  });

  it("keeps a later unseen finish after opening an earlier finish", async () => {
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
    await client.update(roster({ a: 1 }, { a: "working" }));
    await client.update(roster({ a: 2 }));
    expect(client.status("a")).toBe("done");
  });

  it("does not mark a finish under an overlay, but marks when uncovered", async () => {
    const client = await open(roster({ a: 0 }, { a: "working" }), "a", true);
    await client.update(roster({ a: 1 }), "a", true);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
  });

  it("does not acknowledge background work while the underlying status is DONE", async () => {
    const machines = roster({ a: 1 });
    machines[0]!.snapshot!.panes[0]!.background_wait = true;
    const client = await open(machines, "a");
    expect(client.status("a")).toBe("waiting");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 1 }));
    expect(client.status("a")).toBe("done");
  });

  it("drops the prior epoch even if pane IDs and finish counters are identical", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await client.update(roster({ a: 1 }, {}, "server-b"));
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
  });

  it("never restores an old tab's mark into a new epoch", async () => {
    const stale = await open(roster({ a: 1, b: 1 }), "a");
    const fresh = await open(roster({ a: 1, b: 1 }));
    await fresh.update(roster({ a: 1, b: 1 }, {}, "server-b"), "b");
    await stale.update(roster({ a: 1, b: 1 }), "b");
    const reload = await open(roster({ a: 1, b: 1 }, {}, "server-b"));
    expect([reload.status("a"), reload.status("b")]).toEqual(["done", "idle"]);
  });

  it("keeps another tab's new-pane marks when this tab has an older roster", async () => {
    const stale = await open(roster({ a: 1 }));
    await open(roster({ a: 1, c: 3 }), "c");
    await stale.update(roster({ a: 1 }), "a");
    expect(loadSeen("local", "server-a")).toEqual({ a: 1, c: 3 });
  });

  it("does not mistake an older initial roster or lower herdr seq for a restart", async () => {
    saveSeen("local", "server-a", "a", 4);
    const stale = await open(roster({ a: 1 }));
    expect(loadSeen("local", "server-a")).toEqual({ a: 4 });
    await stale.update(roster({ a: 4 }));
    expect(stale.status("a")).toBe("idle");
  });

  it("does not let an older initial epoch delete a newer tab's marks", async () => {
    saveSeen("local", "server-b", "b", 2);
    await open(roster({ a: 1 }, {}, "server-a"), "a");
    expect(loadSeen("local", "server-b")).toEqual({ b: 2 });
  });

  it("persists independent pane writes even with both reads before either write", () => {
    // This is the read/read/write/write schedule that lost a mark in the old whole-record store.
    const first = loadSeen("local", "server-a"), second = loadSeen("local", "server-a");
    expect([first, second]).toEqual([{}, {}]);
    saveSeen("local", "server-a", "a", 1);
    saveSeen("local", "server-a", "b", 2);
    expect(loadSeen("local", "server-a")).toEqual({ a: 1, b: 2 });
  });

  it("updates another mounted tab on storage events and repairs a lower same-pane race", async () => {
    const client = await open(roster({ a: 4 }));
    const key = seenKey("local", "server-a", "a");
    // Both contexts already prepared values; the older write lands last.
    data.set(key, JSON.stringify({ id: 4, at: 1 }));
    data.set(key, JSON.stringify({ id: 2, at: 2 }));
    await storage(key, JSON.stringify({ id: 4, at: 1 }));
    expect(loadSeen("local", "server-a")).toEqual({ a: 4 });
    expect(client.status("a")).toBe("idle");
  });

  it("marks only a visible page and a connected, actually rendered pane", async () => {
    visibility = "hidden";
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("done");
    await act(async () => { visibility = "visible"; events.dispatchEvent(new Event("visibilitychange")); });
    expect(client.status("a")).toBe("idle");
    const absent = await open(roster({ b: 1 }), "not-rendered");
    expect(absent.status("b")).toBe("done");
    await absent.update(roster({ b: 1 }).map((m) => ({ ...m, state: "disconnected" })), "b");
    expect(absent.status("b")).toBe("done");
  });

  it("does not resurrect a deleted key when a previously queued write event arrives", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await client.update(roster({ a: 1 }));
    const key = seenKey("local", "server-a", "a");
    data.delete(key);
    await storage(key, JSON.stringify({ id: 1, at: 1 }));
    expect(data.has(key)).toBe(false);
  });

  it("leaves older bridges without an epoch or finish ID always unread", async () => {
    const machines = roster({ a: 1 });
    delete machines[0]!.snapshot!.finish_epoch;
    const noEpoch = await open(machines, "a");
    expect(noEpoch.status("a")).toBe("done");
    const noId = roster({ a: 1 });
    delete noId[0]!.snapshot!.panes[0]!.finish_id;
    const client = await open(noId, "a");
    expect(client.status("a")).toBe("done");
  });

  it("removes old-format records and caps keys oldest first, never by a roster", () => {
    data.set("herdr-web-ui:seen:local", '{"a":5}');
    data.set("herdr-web-ui:settings", "{}");
    for (let i = 0; i <= SEEN_LIMIT; i++) data.set(seenKey("local", "server-a", `p${i}`), JSON.stringify({ id: 1, at: i }));
    cleanSeen();
    expect(data.has("herdr-web-ui:seen:local")).toBe(false);
    expect(data.has(seenKey("local", "server-a", "p0"))).toBe(false);
    expect(data.has(seenKey("local", "server-a", `p${SEEN_LIMIT}`))).toBe(true);
    expect(data.get("herdr-web-ui:settings")).toBe("{}");
  });
});
