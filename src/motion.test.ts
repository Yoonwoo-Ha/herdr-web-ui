import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const stylesheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? stylesheets(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

describe("motion", () => {
  // A smooth endless animation has the browser draw a frame at every display refresh while it
  // runs (an agent works for minutes), which stutters a video playing next to the app. An endless
  // one jumps between steps instead; only the bridge install's progress bar, shown while it
  // installs, slides.
  it("runs no endless animation smoothly, apart from the bridge install's progress bar", () => {
    const smooth = stylesheets(join(import.meta.dir)).flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
        /animation:.*\binfinite\b/.test(line) && !/steps\(|var\(--ease-pulse\)/.test(line) && !/bridge-progress-slide/.test(line)
          ? [`${file.slice(import.meta.dir.length + 1)}:${index + 1}: ${line.trim()}`] : []));
    expect(smooth).toEqual([]);
  });
});
