import { describe, expect, it } from "bun:test";
import { activateOther, dockPane, draggedPane, dropSide, paneDragData, slotSide, type SplitState } from "./split.ts";

const A = { machineId: "local", paneId: "w1:p1" };
const B = { machineId: "local", paneId: "w1:p2" };
const C = { machineId: "pc2", paneId: "w1:p1" };

describe("split view", () => {
  it("opens a dropped pane beside the single one, on the side it was dropped on", () => {
    expect(dockPane(null, A, B, "right")).toEqual({ split: { other: A, bSide: "right", active: "b" }, select: B });
    expect(dockPane(null, A, B, "left")).toEqual({ split: { other: A, bSide: "left", active: "b" }, select: B });
    // the single pane's slot keeps it, on the other side
    expect(slotSide({ other: A, bSide: "left", active: "b" }, "a")).toBe("right");
  });

  it("opens a dropped pane in the other slot when the single pane is in slot b", () => {
    // a split closed from its left half leaves its pane in slot b: dropping again keeps it there
    const next = dockPane(null, A, B, "right", "b")!;
    expect(next).toEqual({ split: { other: A, bSide: "left", active: "a" }, select: B });
    expect(slotSide(next.split, "a")).toBe("right");
    expect(slotSide(next.split, "b")).toBe("left");
  });

  it("does nothing for a pane dropped onto itself, or with nothing open", () => {
    expect(dockPane(null, A, A, "left")).toBeNull();
    expect(dockPane(null, null, B, "left")).toBeNull();
    const split: SplitState = { other: A, bSide: "right", active: "b" };
    expect(dockPane(split, B, B, "right")).toBeNull();
  });

  it("opens a pane dropped on the active half there, and on the other half there, making it active", () => {
    // B active on the right (slot b), A on the left (slot a)
    const split: SplitState = { other: A, bSide: "right", active: "b" };
    expect(dockPane(split, B, C, "right")).toEqual({ split, select: C });
    expect(dockPane(split, B, C, "left")).toEqual({ split: { other: B, bSide: "right", active: "a" }, select: C });
  });

  it("trades sides when a half's own pane is dropped on the other half", () => {
    const split: SplitState = { other: A, bSide: "right", active: "b" };
    // the active B dropped on the left: the slots trade sides, B stays active
    expect(dockPane(split, B, B, "left")).toEqual({ split: { other: A, bSide: "left", active: "b" }, select: B });
    // the other pane A dropped on the active right half: A moves there and is active, B goes left
    expect(dockPane(split, B, A, "right")).toEqual({ split: { other: B, bSide: "left", active: "a" }, select: A });
  });

  it("makes the other half active without moving either pane", () => {
    const split: SplitState = { other: A, bSide: "right", active: "b" };
    const next = activateOther(split, B);
    expect(next).toEqual({ split: { other: B, bSide: "right", active: "a" }, select: A });
    expect(slotSide(next.split, "a")).toBe("left");
  });

  it("tells the half by the middle of the area, and reads only a pane's drag data", () => {
    expect(dropSide(100, 0, 400)).toBe("left");
    expect(dropSide(250, 0, 400)).toBe("right");
    expect(draggedPane(paneDragData(C))).toEqual(C);
    expect(draggedPane("{\"workspace_id\":\"w1\"}")).toBeNull();
    expect(draggedPane("not json")).toBeNull();
  });
});
