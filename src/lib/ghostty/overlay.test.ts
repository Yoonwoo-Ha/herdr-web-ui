import { expect, test } from "bun:test";
import { hasXtermPicture, newLines } from "./overlay.ts";

test("announces only the lines a scroll brought in, not the rows that moved up", () => {
  const before = Array.from({ length: 5 }, (_, i) => `OLD-${i}`);
  expect(newLines(before, ["OLD-1", "OLD-2", "OLD-3", "OLD-4", "NEW-ONLY-LINE"])).toEqual(["NEW-ONLY-LINE"]);
  expect(newLines(before, ["OLD-3", "OLD-4", "A", "B", "$"])).toEqual(["A", "B", "$"]);
});

test("announces a row that changed in place, and nothing when nothing changed", () => {
  expect(newLines(["$ ls", "$", "", ""], ["$ ls", "a.txt", "$", ""])).toEqual(["a.txt", "$"]);
  expect(newLines(["x", "y"], ["x", "y"])).toEqual([]);
});

test("tells the pictures only xterm draws (iTerm2, sixel) from Kitty ones and text", () => {
  expect(hasXtermPicture("a\x1b]1337;File=inline=1;size=3:AAAA\x07b")).toBe(true);
  expect(hasXtermPicture(new TextEncoder().encode("\x1bP0;1;0q#0;2;0;0;0~\x1b\\"))).toBe(true);
  expect(hasXtermPicture("\x1b_Ga=T,f=32;AAAA\x1b\\")).toBe(false);
  expect(hasXtermPicture("\x1b]0;title\x07plain text")).toBe(false);
});
