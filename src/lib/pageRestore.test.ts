import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { reloadRestoredAppPage, restoreHeld, retryRestore } from "./pageRestore.ts";
import { PaneLifetimes } from "./paneLifetime.ts";

/** storage that refuses every write while `refusing` */
class Storage_ implements Storage {
  readonly data = new Map<string, string>();
  refusing = false;
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.refusing) throw new DOMException("full", "QuotaExceededError"); this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

const DRAFT = "ovis:composer-draft:w1:p1";
/** a PC whose server names no herdr: its pane state stays in this page alone (paneLifetime.ts) */
const olderBridge = { id: "local", name: "local", snapshot: { panes: [{ pane_id: "w1:p1", label: "api" }] } as unknown as SessionSnapshot } as Machine;

/** a page whose loads are written down, with its pane state over `storage` */
function page(storage: Storage_, draft: string | null) {
  const target = new EventTarget();
  const lifetimes = new PaneLifetimes(() => storage, () => 1_000, () => "id");
  lifetimes.observe([olderBridge], (pane) => pane.pane_id);
  if (draft !== null) lifetimes.paneStorage.setItem(DRAFT, draft);
  const loads: string[] = [];
  const shown = {
    addEventListener: target.addEventListener.bind(target),
    location: { reload: () => { loads.push("reload"); } },
  };
  reloadRestoredAppPage(shown, () => true, () => lifetimes.carry());
  return { loads, lifetimes, show: (persisted: boolean) => target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted })) };
}

describe("a page the browser brings back from its back/forward cache", () => {
  it("loads again in the phone app once what it held in memory alone is in storage, or when it held none", () => {
    for (const draft of ["typed under an older bridge", null]) {
      const storage = new Storage_();
      const shown = page(storage, draft);
      shown.show(false);
      expect(shown.loads).toEqual([]);
      shown.show(true);
      expect(shown.loads).toEqual(["reload"]);
      expect(restoreHeld()).toBe(0);
    }
  });

  it("stays as it is when storage refuses that text, the text still on the page, until a retry finds it stored or gone", () => {
    const storage = new Storage_();
    storage.refusing = true;
    const shown = page(storage, "typed under an older bridge");
    shown.show(true);
    expect(shown.loads).toEqual([]);
    expect(shown.lifetimes.paneStorage.getItem(DRAFT)).toBe("typed under an older bridge");
    expect(restoreHeld()).toBe(1);
    // still refused: it stays, and says so
    retryRestore();
    expect([shown.loads, restoreHeld()]).toEqual([[], 2]);
    // the person copied the text and cleared it: nothing waits for storage any more
    shown.lifetimes.paneStorage.removeItem(DRAFT);
    retryRestore();
    expect([shown.loads, restoreHeld()]).toEqual([["reload"], 0]);
  });

  it("is left to reconnect in place in a browser", () => {
    const target = new EventTarget();
    const loads: string[] = [];
    reloadRestoredAppPage({ addEventListener: target.addEventListener.bind(target), location: { reload: () => { loads.push("reload"); } } }, () => false, () => true);
    target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(loads).toEqual([]);
  });
});
