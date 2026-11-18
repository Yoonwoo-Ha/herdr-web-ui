import type { ComposerModelDraw } from "./compose.ts";

export function composerLabelDraw(draw: ComposerModelDraw, measured: { modelClipped: boolean; modelWidth: number; modelFloor: number }): ComposerModelDraw {
  if (draw !== "no-effort") return draw;
  // modelWidth is a whole clientWidth and the 3ch floor seldom is: a name cut to a 22.6px floor measures 23
  return measured.modelClipped && measured.modelWidth < measured.modelFloor + 1 ? "out" : draw;
}
