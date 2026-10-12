import { afterEach, describe, expect, it } from "bun:test";
import { paneDrag } from "./paneDrag.ts";

const A = { machineId: "local", paneId: "w1:p1" };

describe("tab drag out of its strip", () => {
  afterEach(() => { paneDrag.cancel(); paneDrag.onDrop(null); });

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
});
