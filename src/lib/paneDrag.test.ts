import { afterEach, describe, expect, it } from "bun:test";
import { paneDrag, workspaceDropAt, type ElementAtPoint } from "./paneDrag.ts";

const A = { machineId: "local", paneId: "w1:p1" };

interface MockElement {
  closest: <T extends Element = HTMLElement>(selector: string) => T | null;
  dataset: Record<string, string | undefined>;
}

function rowElement({ machine = "local", workspace = "w2", header = true, blocked = false }: {
  machine?: string;
  workspace?: string;
  header?: boolean;
  blocked?: boolean;
} = {}): Element {
  const machineNode: MockElement = {
    dataset: { machine },
    closest: <T extends Element = HTMLElement>(selector: string): T | null =>
      selector === ".machine-workspaces[data-machine]" ? (machineNode as unknown as T)
        : blocked && selector.includes(".machine-offline") ? (machineNode as unknown as T)
        : null,
  };
  const groupNode: MockElement = {
    dataset: { workspace },
    closest: <T extends Element = HTMLElement>(selector: string): T | null =>
      selector === ".workspace-group[data-workspace]" ? (groupNode as unknown as T)
        : machineNode.closest<T>(selector),
  };
  const headerNode: MockElement = {
    dataset: {},
    closest: <T extends Element = HTMLElement>(selector: string): T | null =>
      selector === ".workspace-header" ? (headerNode as unknown as T)
        : groupNode.closest<T>(selector),
  };
  const target: MockElement = {
    dataset: {},
    closest: <T extends Element = HTMLElement>(selector: string): T | null =>
      selector === ".workspace-header" ? (header ? (headerNode as unknown as T) : null) : headerNode.closest<T>(selector),
  };
  return target as unknown as Element;
}

describe("tab drag out of its strip", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  afterEach(() => {
    paneDrag.cancel();
    paneDrag.onDrop(null);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const withElementAt = (fn: ElementAtPoint): void => {
    if (!descriptors.has("document")) descriptors.set("document", Object.getOwnPropertyDescriptor(globalThis, "document"));
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: { elementFromPoint: fn },
    });
  };

  it("follows the pointer once it leaves the strip, and forgets it back over the strip", () => {
    paneDrag.start(A);
    expect(paneDrag.snapshot()).toEqual({ target: A, point: null });
    paneDrag.move(10, 20);
    expect(paneDrag.snapshot()?.point).toEqual({ x: 10, y: 20 });
    paneDrag.back();
    expect(paneDrag.snapshot()?.point).toBeNull();
  });

  it("hands a drop to App's handler once, and ends the drag", () => {
    const drops: unknown[] = [];
    paneDrag.onDrop((target, x, y) => drops.push([target, x, y]));
    paneDrag.start(A);
    paneDrag.drop(5, 6);
    paneDrag.drop(7, 8);
    expect(drops).toEqual([[A, 5, 6]]);
    expect(paneDrag.snapshot()).toBeNull();
  });

  it("drops nothing after a cancel, and a move without a drag starts none", () => {
    const drops: unknown[] = [];
    paneDrag.onDrop((target) => drops.push(target));
    paneDrag.move(1, 1);
    expect(paneDrag.snapshot()).toBeNull();
    paneDrag.start(A);
    paneDrag.cancel();
    paneDrag.drop(1, 1);
    expect(drops).toEqual([]);
  });

  it("tells its listeners only of a change", () => {
    let calls = 0;
    const off = paneDrag.subscribe(() => { calls += 1; });
    paneDrag.back();
    paneDrag.cancel();
    expect(calls).toBe(0);
    paneDrag.start(A);
    paneDrag.cancel();
    off();
    paneDrag.start(A);
    expect(calls).toBe(2);
  });

  it("matches valid same-PC workspace rows and refuses offline, inert, or foreign rows", () => {
    const targets = new Set(["w2", "w3"]);
    expect(workspaceDropAt(5, 5, "local", targets, () => rowElement({ machine: "local", workspace: "w2" }))).toEqual({ machineId: "local", workspaceId: "w2" });
    expect(workspaceDropAt(5, 5, "local", targets, () => rowElement({ machine: "local", workspace: "w1" }))).toBeNull();
    expect(workspaceDropAt(5, 5, "local", targets, () => rowElement({ machine: "remote", workspace: "w2" }))).toBeNull();
    expect(workspaceDropAt(5, 5, "local", targets, () => rowElement({ machine: "local", workspace: "w2", blocked: true }))).toBeNull();
    expect(workspaceDropAt(5, 5, "local", targets, () => rowElement({ machine: "local", workspace: "w2", header: false }))).toBeNull();
    expect(workspaceDropAt(5, 5, "local", targets, () => null)).toBeNull();
    expect(workspaceDropAt(5, 5, "local", new Set(), () => rowElement({ machine: "local", workspace: "w2" }))).toBeNull();
  });

  it("tracks workspace targets during move, clears them on back/cancel, and moves on drop instead of splitting", () => {
    const moved: string[] = [];
    const splits: unknown[] = [];
    paneDrag.onDrop((target, x, y) => splits.push([target, x, y]));
    withElementAt((x) => x < 100 ? rowElement({ machine: "local", workspace: "w2" }) : null);

    paneDrag.start(A, { targets: new Set(["w2"]), move: (workspaceId) => moved.push(workspaceId) });
    paneDrag.move(40, 20);
    const firstHit = paneDrag.snapshot()?.workspaceTarget;
    expect(firstHit).toEqual({ machineId: "local", workspaceId: "w2" });
    paneDrag.move(50, 22);
    expect(paneDrag.snapshot()?.workspaceTarget).toBe(firstHit);

    paneDrag.move(240, 22);
    expect(paneDrag.snapshot()?.workspaceTarget).toBeUndefined();

    paneDrag.move(40, 20);
    expect(paneDrag.snapshot()?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });
    paneDrag.back();
    expect(paneDrag.snapshot()?.workspaceTarget).toBeUndefined();
    expect(paneDrag.snapshot()?.point).toBeNull();

    paneDrag.move(40, 20);
    paneDrag.cancel();
    paneDrag.drop(40, 20);
    expect(moved).toEqual([]);
    expect(splits).toEqual([]);

    paneDrag.start(A, { targets: new Set(["w2"]), move: (workspaceId) => moved.push(workspaceId) });
    paneDrag.move(40, 20);
    paneDrag.drop(40, 20);
    expect(moved).toEqual(["w2"]);
    expect(splits).toEqual([]);
    expect(paneDrag.snapshot()).toBeNull();

    paneDrag.start(A, { targets: new Set(["w2"]), move: (workspaceId) => moved.push(workspaceId) });
    paneDrag.drop(240, 20);
    expect(moved).toEqual(["w2"]);
    expect(splits).toEqual([[A, 240, 20]]);
  });

  it("rechecks dynamic workspace targets on refresh, move, and drop", () => {
    const moved: string[] = [];
    let currentTargets: ReadonlySet<string> = new Set(["w2"]);
    withElementAt(() => rowElement({ machine: "local", workspace: "w2" }));

    paneDrag.start(A, { targets: () => currentTargets, move: (workspaceId) => moved.push(workspaceId) });
    paneDrag.move(40, 20);
    expect(paneDrag.snapshot()?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });

    // Eligibility drops while pointer stays stationary -> refresh clears highlight immediately.
    currentTargets = new Set();
    paneDrag.refresh();
    expect(paneDrag.snapshot()?.workspaceTarget).toBeUndefined();
    expect(paneDrag.snapshot()?.point).toEqual({ x: 40, y: 20 });

    paneDrag.move(42, 20);
    expect(paneDrag.snapshot()?.workspaceTarget).toBeUndefined();
    paneDrag.drop(42, 20);
    expect(moved).toEqual([]);
  });

  it("updates the highlighted workspace target when a scroll moves another row under a stationary pointer", () => {
    const moved: string[] = [];
    const scrollEvents = new EventTarget();
    let rowUnderPointer = rowElement({ machine: "local", workspace: "w2" });
    if (!descriptors.has("document")) descriptors.set("document", Object.getOwnPropertyDescriptor(globalThis, "document"));
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: {
        elementFromPoint: () => rowUnderPointer,
        addEventListener: scrollEvents.addEventListener.bind(scrollEvents),
        removeEventListener: scrollEvents.removeEventListener.bind(scrollEvents),
      },
    });

    paneDrag.start(A, { targets: new Set(["w2", "w3"]), move: (workspaceId) => moved.push(workspaceId) });
    paneDrag.move(40, 20);
    expect(paneDrag.snapshot()?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w2" });

    rowUnderPointer = rowElement({ machine: "local", workspace: "w3" });
    scrollEvents.dispatchEvent(new Event("scroll"));
    expect(paneDrag.snapshot()?.workspaceTarget).toEqual({ machineId: "local", workspaceId: "w3" });

    paneDrag.drop(40, 20);
    expect(moved).toEqual(["w3"]);
  });
});
