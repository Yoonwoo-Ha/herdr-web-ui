import { describe, expect, it } from "bun:test";
import { FOLD_CODE_AFTER_LINES, FOLDED_CODE_LINES, foldCode, parseInline, parseMarkdown, safeMarkdownHref, type InlineNode } from "./markdown.ts";

describe("parseMarkdown", () => {
  it("parses level one through three headings", () => {
    expect(parseMarkdown("# One\n## Two\n### Three").map((block) => block.type === "heading" ? block.level : null)).toEqual([1, 2, 3]);
  });

  it("parses unordered, ordered, and one-level nested lists", () => {
    const blocks = parseMarkdown("- first\n  - nested\n- second\n\n1. one\n2. two");
    expect(blocks[0]).toMatchObject({
      type: "list",
      ordered: false,
      items: [{ children: { type: "list", ordered: false, items: [{ content: [{ type: "text", value: "nested" }] }] } }, {}],
    });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true, items: [{}, {}] });
  });

  it("keeps fenced code and its language", () => {
    expect(parseMarkdown("```ts\nconst x = 1;\n```")).toEqual([{ type: "code", language: "ts", value: "const x = 1;" }]);
  });

  it("parses a GFM table", () => {
    const [table] = parseMarkdown("| Name | Value |\n| --- | --- |\n| a | b |");
    expect(table).toMatchObject({ type: "table", header: [[{ value: "Name" }], [{ value: "Value" }]], rows: [[[{ value: "a" }], [{ value: "b" }]]] });
  });
});

describe("inline markdown", () => {
  it("parses links and rejects unsafe protocols", () => {
    expect(safeMarkdownHref("https://example.com")).toBe("https://example.com");
    expect(safeMarkdownHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(parseInline("[safe](https://example.com) [unsafe](javascript:bad)" )).toMatchObject([
      { type: "link", href: "https://example.com" },
      { type: "text", value: " " },
      { type: "text", value: "unsafe" },
    ]);
  });

  it("keeps a link to a local file as that file, not only its label", () => {
    expect(parseInline("근거: [실험 결과](/home/u/repo/output/REPORT.md)")).toEqual([
      { type: "text", value: "근거: " },
      { type: "file", path: "/home/u/repo/output/REPORT.md", children: [{ type: "text", value: "실험 결과" }] },
    ]);
    expect(parseInline("[x](src/x.ts#L12) [y](~/y.md:3:1)")).toMatchObject([
      { type: "file", path: "src/x.ts" },
      { type: "text", value: " " },
      { type: "file", path: "~/y.md" },
    ]);
    for (const target of ["javascript:bad", "data:text/html,x", "#section"]) {
      expect(parseInline(`[label](${target})`)).toEqual([{ type: "text", value: "label" }]);
    }
  });

  it("parses inline code, bold, italic, and strikethrough", () => {
    expect(parseInline("`code` **bold** *italic* ~~gone~~").map((node) => node.type)).toEqual([
      "code", "text", "strong", "text", "em", "text", "del",
    ]);
  });

  it("preserves underscores in identifiers while retaining standalone emphasis", () => {
    for (const value of ["MAC_QA_CHAT_OK", "api_key_name", "foo__bar__baz", "한글_세션_이름"]) {
      expect(parseInline(value)).toEqual([{ type: "text", value }]);
    }
    expect(parseInline("_italic_ (__bold__) `api_key_name`").map((node) => node.type)).toEqual([
      "em", "text", "strong", "text", "code",
    ]);
    expect(parseInline("__MAC_QA_CHAT_OK__")).toEqual([
      { type: "strong", children: [{ type: "text", value: "MAC_QA_CHAT_OK" }] },
    ]);
  });
});

describe("autolinks", () => {
  const link = (href: string): InlineNode => ({ type: "link", href, children: [{ type: "text", value: href }] });

  it("links a bare http(s) URL and keeps the text around it", () => {
    expect(parseInline("https://github.com/devswha/herdr-web-ui/pull/36 이런거")).toEqual([
      link("https://github.com/devswha/herdr-web-ui/pull/36"),
      { type: "text", value: " 이런거" },
    ]);
    // no space before Korean: the address ends at the first non-ASCII character
    expect(parseInline("see https://example.com/a에서 확인")).toEqual([
      { type: "text", value: "see " }, link("https://example.com/a"), { type: "text", value: "에서 확인" },
    ]);
  });

  it("leaves the sentence's punctuation out, and keeps parentheses the URL opened", () => {
    expect(parseInline("(see https://example.com/a).")).toEqual([
      { type: "text", value: "(see " }, link("https://example.com/a"), { type: "text", value: ")." },
    ]);
    expect(parseInline("https://en.wikipedia.org/wiki/Rust_(language), then")).toEqual([
      link("https://en.wikipedia.org/wiki/Rust_(language)"), { type: "text", value: ", then" },
    ]);
    expect(parseInline("done: https://example.com/x?y=1&z=2!")).toEqual([
      { type: "text", value: "done: " }, link("https://example.com/x?y=1&z=2"), { type: "text", value: "!" },
    ]);
  });

  it("links an <angle> URL, and nothing inside code, a markdown link, or another scheme", () => {
    expect(parseInline("<https://example.com/a>")).toEqual([link("https://example.com/a")]);
    expect(parseInline("`https://example.com`")).toEqual([{ type: "code", value: "https://example.com" }]);
    expect(parseInline("[https://example.com](https://example.com/b)")).toEqual([
      { type: "link", href: "https://example.com/b", children: [{ type: "text", value: "https://example.com" }] },
    ]);
    for (const value of ["javascript:alert(1)", "ftp://example.com", "file:///etc/passwd", "http:/x"]) {
      expect(parseInline(value).some((node) => node.type === "link")).toBe(false);
    }
  });

  it("links inside emphasis", () => {
    expect(parseInline("**https://example.com**")).toEqual([{ type: "strong", children: [link("https://example.com")] }]);
  });
});

describe("foldCode", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  it("shows blocks up to the limit whole", () => {
    expect(foldCode(lines(12))).toBeNull();
    expect(foldCode(lines(FOLD_CODE_AFTER_LINES))).toBeNull();
  });

  it("folds a longer block to its first lines and counts all of them", () => {
    const fold = foldCode(lines(382));
    expect(fold?.lines).toBe(382);
    expect(fold?.head.split("\n")).toHaveLength(FOLDED_CODE_LINES);
    expect(fold?.head.startsWith("line 1\n")).toBe(true);
    expect(fold?.head.endsWith(`line ${FOLDED_CODE_LINES}`)).toBe(true);
  });
});
