import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import { parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock } from "../lib/markdown.ts";

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return <>{nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case "text": return <span key={key}>{node.value}</span>;
      case "code": return <code key={key}>{node.value}</code>;
      case "strong": return <strong key={key}><Inline nodes={node.children} /></strong>;
      case "em": return <em key={key}><Inline nodes={node.children} /></em>;
      case "del": return <del key={key}><Inline nodes={node.children} /></del>;
      case "link": return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer"><Inline nodes={node.children} /></a>;
    }
  })}</>;
}

function List({ block }: { block: ListBlock }) {
  const Tag = block.ordered ? "ol" : "ul";
  return (
    <Tag className="markdown-list">
      {block.items.map((item, index) => (
        <li key={index}>
          <Inline nodes={item.content} />
          {item.children !== undefined && <List block={item.children} />}
        </li>
      ))}
    </Tag>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="markdown-code">
      <div className="markdown-code-header">
        <span>{language || "text"}</span>
        <button type="button" className="icon-button markdown-code-copy" onClick={() => void copy()} aria-label={copied ? "Code copied" : "Copy code"}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      <pre><code>{value}</code></pre>
    </div>
  );
}

function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
  return <>{blocks.map((block, index): ReactNode => {
    const key = `${block.type}-${index}`;
    switch (block.type) {
      case "heading": {
        const Tag = `h${block.level}` as "h1" | "h2" | "h3";
        return <Tag key={key}><Inline nodes={block.content} /></Tag>;
      }
      case "paragraph":
        return <p key={key}>{block.lines.map((line, lineIndex) => <span key={lineIndex}><Inline nodes={line} />{lineIndex < block.lines.length - 1 && <br />}</span>)}</p>;
      case "list": return <List key={key} block={block} />;
      case "blockquote": return <blockquote key={key}><Blocks blocks={block.blocks} /></blockquote>;
      case "code": return <CodeBlock key={key} language={block.language} value={block.value} />;
      case "hr": return <hr key={key} />;
      case "table": return (
        <div className="markdown-table-wrap" key={key}>
          <table><thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}><Inline nodes={cell} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><Inline nodes={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
  })}</>;
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(children), [children]);
  return <div className={className === undefined ? "markdown" : `markdown ${className}`}><Blocks blocks={blocks} /></div>;
}
