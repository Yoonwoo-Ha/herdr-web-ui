import { expect, test } from "bun:test";
import { newLines } from "./overlay.ts";

test("announces only the lines a scroll brought in, not the rows that moved up", () => {
  const before = Array.from({ length: 5 }, (_, i) => `OLD-${i}`);
  expect(newLines(before, ["OLD-1", "OLD-2", "OLD-3", "OLD-4", "NEW-ONLY-LINE"])).toEqual(["NEW-ONLY-LINE"]);
  expect(newLines(before, ["OLD-3", "OLD-4", "A", "B", "$"])).toEqual(["A", "B", "$"]);
});

test("announces a row that changed in place, and nothing when nothing changed", () => {
  expect(newLines(["$ ls", "$", "", ""], ["$ ls", "a.txt", "$", ""])).toEqual(["a.txt", "$"]);
  expect(newLines(["x", "y"], ["x", "y"])).toEqual([]);
});
