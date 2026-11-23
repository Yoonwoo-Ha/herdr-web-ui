import { describe, expect, it } from "bun:test";
import type { Cells, PaletteName } from "../testing/herdr-grid.ts";
import { compare, comparedScene, copyToastShape, decisionsFor, herdrPicture, ovisPicture, report } from "../testing/parity.ts";
import { SCENES, sizesOf, type WorldName } from "../testing/parity-scenes.ts";

/**
 * The screen draws each scene of docs/tui/visual-parity.md as herdr's TUI does: its styled cell grid (text, attributes,
 * colour roles) and its host cursor equal herdr's stored capture (tui/testing/herdr-captures/, written only by
 * tui/testing/herdr-capture.ts) once that capture is carried through the lines the owner keeps or settles later
 * (tui/testing/parity.ts `decisionsFor` names each). A scene whose every cell those lines cover, or another case
 * compares already, has no case (`LEFT_OUT`); every case compares at least one cell.
 */

const PALETTES: readonly PaletteName[] = ["dark", "light"];
const bases = new Map<string, Promise<Cells>>();

/** The screen's first picture of a world at a size and palette, made once for its scenes. */
function basePicture(world: WorldName, cols: number, rows: number, palette: PaletteName): Promise<Cells> {
  const key = `${world} ${cols}x${rows} ${palette}`;
  let picture = bases.get(key);
  if (!picture) {
    picture = ovisPicture(world, SCENES[world][0]!, cols, rows, palette);
    bases.set(key, picture);
  }
  return picture;
}

for (const world of Object.keys(SCENES) as WorldName[]) {
  describe(`parity with herdr: ${world}`, () => {
    for (const scene of SCENES[world]) {
      for (const [cols, rows] of sizesOf(world)) {
        if (!comparedScene(scene.id, cols)) continue;
        for (const palette of PALETTES) {
          it(`${scene.id} ${cols}x${rows} ${palette}`, async () => {
            const herdr = herdrPicture(scene.id, cols, rows, palette);
            if (!herdr) throw new Error(`no stored capture of ${scene.id} at ${cols}x${rows}: run tui/testing/herdr-capture.ts`);
            const first = SCENES[world][0]!;
            const ovis = scene === first ? await basePicture(world, cols, rows, palette) : await ovisPicture(world, scene, cols, rows, palette);
            const base = scene === first ? null : { herdr: herdrPicture(first.id, cols, rows, palette)!, ovis: await basePicture(world, cols, rows, palette) };
            const { differences, compared } = compare(herdr, ovis, palette, decisionsFor(world, scene.id, cols, rows, herdr, ovis, base));
            expect(compared).toBeGreaterThan(0);
            if (differences.length > 0) throw new Error(report(herdr, ovis, differences));
            if (scene.id === "toast") {
              // the toast's cells are left out of the comparison (C2 makes its text shorter): its place, shape and colours here
              const panes = cols <= 64 ? { x: 0, width: cols } : { x: 26, width: cols - 26 };
              expect(copyToastShape(ovis, palette, panes)).toBeNull();
            }
          }, 30_000);
        }
      }
    }
  });
}
