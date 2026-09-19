import { describe, expect, it } from "bun:test";

import { composerPayload, imageMention, MAX_COMPOSER_CHARS } from "./compose.ts";

describe("composerPayload", () => {
  it("bracketed mode wraps the text as one paste and submits with a bare CR", () => {
    expect(composerPayload("hello", true)).toBe("\u001b[200~hello\u001b[201~\r");
  });

  it("bracketed mode keeps inner newlines literal to the TUI input box", () => {
    expect(composerPayload("line one\nline two", true)).toBe("\u001b[200~line one\rline two\u001b[201~\r");
  });

  it("normalizes CRLF and lone CR to the pty newline CR", () => {
    expect(composerPayload("a\r\nb\rc", true)).toBe("\u001b[200~a\rb\rc\u001b[201~\r");
  });

  it("drops trailing newlines: the submit CR belongs to the composer, not the text", () => {
    expect(composerPayload("cmd\n\n", true)).toBe("\u001b[200~cmd\u001b[201~\r");
    expect(composerPayload("cmd\n\n", false)).toBe("cmd\r");
  });

  it("plain mode uses classic paste semantics: every newline submits its own line", () => {
    expect(composerPayload("git status\ngit diff", false)).toBe("git status\rgit diff\r");
  });

  it("plain mode sends a single line plus the submit CR", () => {
    expect(composerPayload("git status", false)).toBe("git status\r");
  });

  it("empty text still emits only the submit keystroke", () => {
    expect(composerPayload("", true)).toBe("\u001b[200~\u001b[201~\r");
    expect(composerPayload("", false)).toBe("\r");
  });

  it("caps what one send can carry", () => {
    expect(MAX_COMPOSER_CHARS).toBeLessThanOrEqual(20_000);
    expect(composerPayload("x".repeat(MAX_COMPOSER_CHARS), false)).toHaveLength(MAX_COMPOSER_CHARS + 1);
  });
});

describe("imageMention", () => {
  it("references the stored file as an editable @path with a trailing space", () => {
    expect(imageMention("/tmp/proj/.herdr-web-ui/paste-1.png")).toBe(
      "@/tmp/proj/.herdr-web-ui/paste-1.png ",
    );
  });
});
