import { describe, expect, it } from "bun:test";
import { composerLabelDraw } from "./composerLabelFit.ts";

describe("composerLabelDraw", () => {
  it("keeps a label that fits, and one already stepped out", () => {
    expect(composerLabelDraw("full", { modelClipped: false, modelWidth: 53, modelFloor: 24 })).toBe("full");
    expect(composerLabelDraw("out", { modelClipped: true, modelWidth: 24, modelFloor: 24 })).toBe("out");
  });

  it("keeps the name once the level alone stepped out and the name fits, or is shortened above its floor", () => {
    expect(composerLabelDraw("no-effort", { modelClipped: false, modelWidth: 53, modelFloor: 24 })).toBe("no-effort");
    expect(composerLabelDraw("no-effort", { modelClipped: true, modelWidth: 40, modelFloor: 24 })).toBe("no-effort");
  });

  it("steps the whole label out when the name is cut to its floor, so the ring is drawn whole", () => {
    expect(composerLabelDraw("no-effort", { modelClipped: true, modelWidth: 24, modelFloor: 24 })).toBe("out");
    expect(composerLabelDraw("no-effort", { modelClipped: true, modelWidth: 23.5, modelFloor: 24 })).toBe("out");
  });

  it("steps out at a fractional floor, where clientWidth rounds the name's width up past it", () => {
    expect(composerLabelDraw("no-effort", { modelClipped: true, modelWidth: 23, modelFloor: 22.6 })).toBe("out");
    expect(composerLabelDraw("no-effort", { modelClipped: true, modelWidth: 24, modelFloor: 22.6 })).toBe("no-effort");
  });
});
