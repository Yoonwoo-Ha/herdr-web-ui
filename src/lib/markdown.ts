export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] };

export interface ListItem {
  content: InlineNode[];
  children?: ListBlock;
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: ListItem[];
}

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; content: InlineNode[] }
  | { type: "paragraph"; lines: InlineNode[][] }
  | ListBlock
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "code"; language: string; value: string }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

export function safeMarkdownHref(href: string): string | null {
  const value = href.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null;
}

/** Dependency-free inline markdown scanner. Unknown or malformed markup remains text. */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Underscores inside identifiers are literal: MAC_QA_CHAT_OK must survive
  // rendering exactly as it appears in the terminal and native transcript.
  const marker = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}\p{M}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/gu;
  let offset = 0;
  for (const match of source.matchAll(marker)) {
    const index = match.index ?? 0;
    if (index > offset) nodes.push({ type: "text", value: source.slice(offset, index) });
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const href = safeMarkdownHref(token.slice(split + 2, -1));
      nodes.push(href === null ? { type: "text", value: label } : { type: "link", href, children: parseInline(label) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push({ type: "strong", children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith("~~")) {
      nodes.push({ type: "del", children: parseInline(token.slice(2, -2)) });
    } else {
      nodes.push({ type: "em", children: parseInline(token.slice(1, -1)) });
    }
    offset = index + token.length;
  }
  if (offset < source.length) nodes.push({ type: "text", value: source.slice(offset) });
  return nodes;
}

const listLine = /^(\s*)([-*]|\d+\.)\s+(.+)$/;
const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}


function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^```/.test(line) || /^#{1,3}\s+/.test(line) || /^\s*>/.test(line) || /^(?:\s*[-*_]){3,}\s*$/.test(line) || listLine.test(line)
    || (line.includes("|") && tableSeparator.test(lines[index + 1] ?? ""));
}

function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = listLine.exec(lineAt(lines, start));
  if (first === null) return { block: { type: "list", ordered: false, items: [] }, next: start + 1 };
  const baseIndent = (first[1] ?? "").length;
  const ordered = /\d/.test(first[2] ?? "");
  const block: ListBlock = { type: "list", ordered, items: [] };
  let index = start;
  while (index < lines.length) {
    const match = listLine.exec(lineAt(lines, index));
    if (match === null || (match[1] ?? "").length < baseIndent) break;
    if ((match[1] ?? "").length >= baseIndent + 2) {
      const parent = block.items.at(-1);
      if (parent === undefined) break;
      const nested = parseList(lines, index);
      parent.children = nested.block;
      index = nested.next;
      continue;
    }
    if ((match[1] ?? "").length !== baseIndent || /\d/.test(match[2] ?? "") !== ordered) break;
    block.items.push({ content: parseInline(match[3] ?? "") });
    index += 1;
  }
  return { block, next: index };
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line.trim() === "") { index += 1; continue; }

    const fence = /^```\s*([^\s`]*)/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lineAt(lines, index))) body.push(lineAt(lines, index++));
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1] ?? "", value: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3, content: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lineAt(lines, index))) quoted.push(lineAt(lines, index++).replace(/^\s*>\s?/, ""));
      blocks.push({ type: "blockquote", blocks: parseMarkdown(quoted.join("\n")) });
      continue;
    }

    if (listLine.test(line)) {
      const parsed = parseList(lines, index);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    if (line.includes("|") && tableSeparator.test(lines[index + 1] ?? "")) {
      const header = cells(line).map(parseInline);
      index += 2;
      const rows: InlineNode[][][] = [];
      while (index < lines.length && lineAt(lines, index).includes("|") && lineAt(lines, index).trim() !== "") {
        rows.push(cells(lineAt(lines, index)).map(parseInline));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const paragraph: InlineNode[][] = [];
    while (index < lines.length && lineAt(lines, index).trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push(parseInline(lineAt(lines, index)));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}
