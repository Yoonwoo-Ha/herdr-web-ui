import { describe, expect, test } from "bun:test";
import { renderedClipboardPayload, type ClipboardNode } from "./markdownClipboard.ts";

const text = (value: string): ClipboardNode => ({ tag: "", text: value });
const element = (tag: string, content: readonly ClipboardNode[], attrs?: Record<string, string>): ClipboardNode => ({ tag, children: content, attrs });

describe("renderedClipboardPayload", () => {
  test("keeps native selected text rather than synthesizing Markdown from formatting", () => {
    const nodes = [
      element("H3", [text("Plan")], { "data-markdown-heading": "1" }),
      element("UL", [
        element("LI", [element("STRONG", [text("First")])]),
        element("LI", [element("A", [text("Docs")], { href: "https://example.com" })]),
      ]),
    ];
    const payload = renderedClipboardPayload(nodes, "Plan\n\nFirst\nDocs");
    expect(payload.text).toBe("Plan\n\nFirst\nDocs");
    expect(payload.html).toBe('<h3>Plan</h3><ul><li><strong>First</strong></li><li><a href="https://example.com">Docs</a></li></ul>');
  });

  test("retains nested ordered lists in rich HTML without adding markers to plain text", () => {
    const nodes = [element("OL", [
      element("LI", [text("Done"), element("UL", [element("LI", [text("Child")])])]),
    ], { start: "3" })];
    expect(renderedClipboardPayload(nodes, "Done\nChild")).toEqual({
      text: "Done\nChild", html: '<ol start="3"><li>Done<ul><li>Child</li></ul></li></ol>',
    });
  });

  test("preserves native whitespace in mixed prose and code and omits copy controls from HTML", () => {
    const code = "  one\n\n\n  two  ";
    const nodes = [element("P", [text("Run this")]), element("DIV", [
      element("DIV", [text("ts"), element("BUTTON", [text("Copy")])], { class: "markdown-code-header" }),
      element("PRE", [element("CODE", [text(code)])]),
    ])];
    expect(renderedClipboardPayload(nodes, ` Run this\n\n${code}\n`)).toEqual({
      text: ` Run this\n\n${code}\n`, html: `<p>Run this</p><pre><code>${code}</code></pre>`,
    });
  });

  test("keeps selected file and fallback image labels without restoring unselected Markdown source", () => {
    const nodes = [element("P", [
      element("BUTTON", [element("CODE", [text("main.ts")])], { class: "markdown-file" }),
      element("SPAN", [text("diagram")], { "data-markdown-copy": '![<diagram>](https://example.com/picture.png)' }),
    ])];
    expect(renderedClipboardPayload(nodes, "main.ts diagram")).toEqual({
      text: "main.ts diagram", html: '<p><code>main.ts</code>diagram</p>',
    });
  });

  test("exports rich HTML without executable attributes, embedded resources, or unsafe links", () => {
    const nodes = [
      element("P", [text('<hello & "world">')], { onclick: "alert(1)", style: "background:url(https://example.com)" }),
      element("SCRIPT", [text("alert(1)")]),
      element("IFRAME", [], { src: "https://example.com" }),
      element("IMG", [], { alt: "picture", src: "https://example.com/p.png", onerror: "alert(1)" }),
      element("A", [text("unsafe")], { href: "javascript:alert(1)" }),
      element("STRONG", [text("safe")]),
      element("SPAN", [text("hidden")], { "aria-hidden": "true" }),
    ];
    expect(renderedClipboardPayload(nodes, "visible").html).toBe('<p>&lt;hello &amp; &quot;world&quot;&gt;</p>picture<a>unsafe</a><strong>safe</strong>');
  });

  test("retains quotes and tables in rich HTML without generating Markdown table delimiters", () => {
    const nodes = [
      element("BLOCKQUOTE", [element("P", [text("Quote")])]),
      element("TABLE", [
        element("THEAD", [element("TR", [element("TH", [text("Name")])])]),
        element("TBODY", [element("TR", [element("TD", [text("a|b")])])]),
      ]),
    ];
    expect(renderedClipboardPayload(nodes, "Quote\n\nName\na|b")).toEqual({
      text: "Quote\n\nName\na|b",
      html: "<blockquote><p>Quote</p></blockquote><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>a|b</td></tr></tbody></table>",
    });
  });
});
