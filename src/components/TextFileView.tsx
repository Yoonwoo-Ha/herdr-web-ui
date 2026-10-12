import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import { OpenFileContext } from "../lib/filePaths.ts";
import { resolveFromDocument } from "../lib/fileReader.ts";
import type { Lines } from "../lib/highlight.ts";
import type { MarkdownBlock } from "../lib/markdown.ts";
import { useSettings, type MarkdownWidth } from "../lib/settings.ts";
import { CodeLines } from "./HighlightedCode.tsx";
import { ParsedMarkdown } from "./Markdown.tsx";

/** The stored width is a setting's value, not a class name: a rename of either leaves the other alone. */
const MARKDOWN_CLASS: Record<MarkdownWidth, string> = {
  readable: "file-viewer-markdown file-viewer-markdown-readable",
  full: "file-viewer-markdown",
};

export interface TextFileViewProps {
  path: string;
  /** the Preview's blocks, parsed in a worker; `null` shows the code */
  blocks: MarkdownBlock[] | null;
  /** the code's lines, from `useHighlightedLines` */
  lines: Lines;
  onOpen: (path: string) => void;
  /** set to the code `<pre>` while the code shows, for Copy to select when the clipboard is out of reach */
  sourceRef: RefObject<HTMLPreElement>;
}

/** The text of a file: Markdown rendered, or its code with line numbers. */
export function TextFileView({ path, blocks, lines, onOpen, sourceRef }: TextFileViewProps) {
  const { settings } = useSettings();
  // the app hands a new onOpen on every render (each poll): read it from a ref, so the context
  // value changes only with the file, and the memoized Markdown and its links are left alone
  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => { onOpenRef.current = onOpen; });
  const openLink = useCallback((href: string) => onOpenRef.current(resolveFromDocument(path, href)), [path]);
  return <div className="file-viewer-content">
    {blocks !== null
      ? <OpenFileContext.Provider value={openLink}><ParsedMarkdown className={MARKDOWN_CLASS[settings.markdownWidth]} blocks={blocks} /></OpenFileContext.Provider>
      : <CodeLines ref={sourceRef} className="file-viewer-text" lines={lines} open={null} lineNumbers wrap={settings.wrapCode} />}
  </div>;
}
