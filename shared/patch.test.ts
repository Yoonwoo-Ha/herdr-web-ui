import { describe, expect, it } from "bun:test";

import { patchFiles, patchText } from "./patch.ts";

const PATCH = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: docs/b.md\n+hi\n*** End Patch\n";

describe("Codex patches", () => {
  it("finds a patch given whole, or as the string an exec script hands to tools.apply_patch", () => {
    expect(patchText(PATCH)).toBe(PATCH);
    const script = `text(await tools.apply_patch(${JSON.stringify(PATCH)}));\nconsole.log("done")`;
    expect(patchText(script)).toBe(PATCH);
    expect(patchText("await tools.apply_patch(`" + PATCH + "`)")).toBe(PATCH);
    expect(patchText("tools.exec_command({cmd: 'ls'})")).toBeNull();
    expect(patchText('tools.apply_patch("not a patch")')).toBeNull();
    expect(patchText(`tools.apply_patch(patch); tools.apply_patch("unclosed\\"); tools.apply_patch( ${JSON.stringify(PATCH)})`)).toBeNull();
    expect(patchText(`tools.apply_patch(patch);\ntools.apply_patch(\n  ${JSON.stringify(PATCH)})`)).toBe(PATCH);
  });

  it("finds the patch in an exec script of any size", () => {
    const line = '+const path = "C:\\\\tmp\\\\a.txt"; // a line of a large edit\n';
    for (const lines of [3_000, 30_000]) {
      const patch = `*** Begin Patch\n*** Add File: big.ts\n${line.repeat(lines)}*** End Patch\n`;
      expect(patchText(`text(await tools.apply_patch(${JSON.stringify(patch)}));`)).toBe(patch);
      expect(patchText("await tools.apply_patch(`" + patch + "`)")).toBe(patch);
    }
  });

  it("names each file a patch touches once, in order", () => {
    expect(patchFiles(PATCH + "*** Update File: src/a.ts\n*** Delete File: old.txt\n")).toEqual(["src/a.ts", "docs/b.md", "old.txt"]);
  });
});
