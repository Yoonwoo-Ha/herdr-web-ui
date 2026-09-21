import { describe, expect, it } from "bun:test";
import { parseInline, parseMarkdown, safeMarkdownHref } from "./markdown.ts";

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

  it("parses inline code, bold, italic, and strikethrough", () => {
    expect(parseInline("`code` **bold** *italic* ~~gone~~").map((node) => node.type)).toEqual([
      "code", "text", "strong", "text", "em", "text", "del",
    ]);
  });
});
