import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Braces, Check, Code, Copy, Download, ExternalLink, TriangleAlert, X } from "lucide-react";

import "./FileViewer.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { useHighlightedLines } from "./HighlightedCode.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { TextFileView } from "./TextFileView.tsx";
import { MarkdownImageContext } from "./Markdown.tsx";

import type { FileInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";
import { useOpeningPaneLane } from "../lib/chatLane.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { copyText, selectContents } from "../lib/clipboard.ts";
import { pathParts } from "../lib/filePaths.ts";
import { languageForPath, LINE_ELEMENT_LIMIT } from "../lib/highlight.ts";
import { useT } from "../lib/i18n.ts";
import { MAX_INLINE_IMAGE_BYTES, markdownImagePreview } from "../lib/markdownImages.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import type { MarkdownBlock } from "../lib/markdown.ts";
import { knownPreview, parsePreviewOffThread } from "../lib/markdownPreview.ts";
import { hasPreview, type TextViewMode } from "../lib/textPreview.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { readFilePreviewText, TEXT_PREVIEW_BYTES, type FilePreviewText } from "../lib/filePreviewText.ts";
import { readerHref } from "../lib/fileReader.ts";

type Preview = { status: "none" | "pending" | "failed" } | { status: "ready"; blocks: MarkdownBlock[] };

const NO_PREVIEW: Preview = { status: "none" };
const PENDING_PREVIEW: Preview = { status: "pending" };
const FAILED_PREVIEW: Preview = { status: "failed" };

/**
 * The Preview of `text` (null: none is asked for), parsed in a worker so the page never waits for
 * the parser: pending until it answers, failed when it gave up or ran over its budget.
 */
function useMarkdownPreview(text: string | null): Preview {
  const known = useMemo((): Preview | null => {
    if (text === null) return NO_PREVIEW;
    const blocks = knownPreview(text);
    if (blocks === undefined) return null;
    return blocks === null ? FAILED_PREVIEW : { status: "ready", blocks };
  }, [text]);
  const [answer, setAnswer] = useState<{ text: string; blocks: MarkdownBlock[] | null } | null>(null);
  useEffect(() => {
    if (known !== null || text === null) return;
    let live = true;
    const job = parsePreviewOffThread(text);
    void job.promise.then((blocks) => { if (live) setAnswer({ text, blocks }); });
    return () => { live = false; job.cancel(); };
  }, [known, text]);
  // a new object each render is fine: only its status and its (stable) blocks are read
  if (known !== null) return known;
  if (answer === null || answer.text !== text) return PENDING_PREVIEW;
  return answer.blocks === null ? FAILED_PREVIEW : { status: "ready", blocks: answer.blocks };
}

export interface FileViewerProps {
  /** absolute, `~/…`, or relative to the pane's folder */
  path: string;
  paneId: string | null;
  onClose: () => void;
  /** Settings can open above this preview; its Escape must not also close the file. */
  keyboardActive?: boolean;
  /** a file chosen in a folder's listing: opened as the preview, so history and a reload keep it */
  onOpen?: (path: string) => void;
  /** the document is the page (a markdown file's own tab, FileReader): no dialog, nothing to close */
  page?: boolean;
}

/**
 * Copies the whole file; owns its "copied" flip, so only the button re-renders for it. When nothing
 * copies it (no clipboard API on plain-HTTP LAN, and the browser's copy command refused: copyText)
 * it selects the source `<pre>` instead; in a Markdown Preview there is none, so `onShowSource`
 * switches to Code first and the viewer selects it once rendered.
 */
function CopyFileButton({ text, sourceRef, onShowSource }: { text: string; sourceRef: RefObject<HTMLPreElement>; onShowSource: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("File copied") : t("Copy file");
  /** Copies the file, or selects its source for a long press; from a Preview, shows the source first. */
  const copy = async (): Promise<void> => {
    // the code <pre> is the source text alone: line numbers are a CSS counter, not text
    const source = sourceRef.current;
    if (await copyText(text, source)) setCopied(true);
    else if (!source) onShowSource();
  };
  return <button type="button" className="icon-button file-viewer-action" aria-label={label} title={label} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </button>;
}

/**
 * A file an agent wrote, opened in the browser: images, video and audio (streamed, so they
 * play and seek at once), PDFs, HTML pages, and the start of a text file (markdown drawn, its images read through the file endpoint). Anything can be downloaded.
 */
export function FileViewer({ path: asked, paneId, onClose, onOpen, keyboardActive = true, page = false }: FileViewerProps) {
  const t = useT();
  const { fetchFileInfo, fileUrl, fetchDirectories } = useMachineApi();
  // a remote PC's bridge reads a relative folder from the pane's folder only from its next bundle
  // on; until then it would list the bridge's own folder, so only an absolute or ~/ one is listed there
  const machineId = useMachineId();
  const remote = machineId !== LOCAL_MACHINE;
  const [directory, setDirectory] = useState<string | null>(null);
  // the path as given, until a choice among files of that name replaces it
  const [path, setPath] = useState(asked);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  // an HTML page shows as the page, or as its source when asked
  const [source, setSource] = useState(false);
  // Escape closes it, Tab stays in it, and the focus goes back to the row that opened it
  const surface = useFocusTrap<HTMLElement>(!page);
  // Settings → Chat width, Default: the Preview is as wide as the chat of the pane that opened it
  useOpeningPaneLane(surface, paneId === null ? null : paneStorageId(machineId, paneId));
  // a kind, not a message: it is said in the language of the moment it shows
  const [error, setError] = useState<"missing" | "unreadable" | null>(null);
  const [loaded, setLoaded] = useState<FilePreviewText | null>(null);
  // the mode is the user's choice for this path, else Preview: derived, so a new path never paints the old mode
  const [chosen, setChosen] = useState<{ path: string; mode: TextViewMode } | null>(null);
  const mode = chosen?.path === path ? chosen.mode : "preview";
  // the code <pre> while the code shows, which Copy selects when the clipboard is out of reach
  const sourceRef = useRef<HTMLPreElement>(null);
  // Copy failed in a Preview: select the source as soon as the Code view has rendered
  const selectSourceOnCode = useRef(false);
  /** Switches a Preview to its source and has it selected once rendered, for Copy without a clipboard. */
  const showSourceToSelect = (): void => {
    selectSourceOnCode.current = true;
    setChosen({ path, mode: "code" });
    setSource(true);
  };
  useLayoutEffect(() => {
    if (!selectSourceOnCode.current || mode !== "code") return;
    selectSourceOnCode.current = false;
    if (sourceRef.current) selectContents(sourceRef.current);
  }, [mode, loaded, source]);

  useSheetSwipe(surface, page ? null : onClose);
  useEffect(() => setPath(asked), [asked]);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setInfo(null); setCandidates(null); setError(null); setLoaded(null); setDirectory(null); setSource(false);
    fetchFileInfo(path, paneId).then(async (next) => {
      if (cancelled) return;
      if ("candidates" in next) { setCandidates(next.candidates); return; }
      setInfo(next);
      if (next.kind !== "text") return;
      // only the first part of a text file travels: a range, whatever the file's size
      deadline = setTimeout(() => abort.abort(), 5_000);
      try {
        const response = await fetch(fileUrl(next.path, paneId), { signal: abort.signal, headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
        const body = await readFilePreviewText(response, TEXT_PREVIEW_BYTES, { signal: abort.signal });
        if (!cancelled) setLoaded(body);
      } finally { clearTimeout(deadline); }
    }).catch(async (reason: unknown) => {
      if (cancelled) return;
      // a folder is listed from the pane's folder, as a file is found from it
      if (reason instanceof ApiError && reason.status === 404 && (!remote || /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(path))) {
        try {
          const listing = await fetchDirectories(path, false, true, paneId);
          if (!cancelled) setDirectory(listing.path);
          return;
        } catch { /* retain the file error when the target is not a readable directory */ }
      }
      if (cancelled) return;
      setError(reason instanceof ApiError && reason.status === 404 ? "missing" : "unreadable");
    });
    return () => { cancelled = true; clearTimeout(deadline); abort.abort(); };
  }, [path, paneId, fetchFileInfo, fileUrl, fetchDirectories, remote]);

  useEffect(() => {
    if (!keyboardActive || page) return;
    // the FilesDialog beneath listens on window too (and stands down while this is open); this
    // one is the topmost overlay, so it takes the key, unless a native modal (Add PC) is over it
    /** Escape closes the viewer from anywhere in it. */
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive, page]);

  // the file found (a bare name may have been found deeper in the folder), else as asked
  const url = fileUrl(info?.path ?? path, paneId);
  // drawn by its own script in a sandbox with no origin and no network (server/file-view.ts); a PC
  // whose bridge predates `render` answers with the source, which the frame shows as text
  const htmlPage = info !== null && info.kind === "text" && info.mime === "text/html";
  const pageUrl = `${url}&render=1`;
  const modes = <div className="segmented file-viewer-modes" role="group" aria-label={t("Show the HTML file as")}>
    <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>{t("Page")}</button>
    <button type="button" aria-pressed={source} onClick={() => setSource(true)}>{t("Source")}</button>
  </div>;
  const textFile = info?.kind === "text";
  const language = languageForPath(info?.path ?? path);
  // a Preview its parser gave up on (too slow, or failed) opens the source instead
  const preview = useMarkdownPreview(textFile && loaded !== null && mode === "preview" && hasPreview(language) ? loaded.text : null);
  const previewRefused = preview.status === "failed";
  const previewable = hasPreview(language) && !previewRefused;
  const view = previewable && mode === "preview" ? "markdown" : "code";
  const codeShown = textFile && loaded !== null && view === "code" && (!htmlPage || source);
  // a file's code has no length limit (the load limit bounds it): only a worker that gave up leaves it plain
  const code = useHighlightedLines(codeShown ? loaded.text : "", codeShown ? language : null);
  const shownPath = info?.path ?? path;
  const { stem, extension } = pathParts(info?.name ?? shownPath);
  const { folder } = pathParts(shownPath);
  // what holds for the whole file is said with its size, where it is seen first, not after a megabyte of text
  const cutShort = textFile && (!htmlPage || source) && loaded !== null && loaded.truncated;
  const notes = [
    cutShort && ((loaded.total ?? info.size) > TEXT_PREVIEW_BYTES
      ? t("Showing the first {shown} of {total}.", { shown: formatBytes(TEXT_PREVIEW_BYTES), total: formatBytes(loaded.total ?? info.size) })
      : t("Only part of this file is shown. Download it to read the rest.")),
    textFile && loaded !== null && previewRefused && t("Too long to preview"),
    codeShown && code.tooLong && t("Too long to highlight"),
    // past it the code is one text (CodeLines), and line numbers are an element per line
    codeShown && code.lines.length > LINE_ELEMENT_LIMIT && t("Too many lines to number"),
  ].filter((note): note is string => typeof note === "string");
  const noticed = notes.length > 0;
  const copyable = textFile && loaded !== null && !loaded.truncated;
  const markdown = info?.kind === "text" && /\.(?:md|markdown)$/i.test(info.name);
  // a page of just the document, not the app over it (FileReader)
  const previewUrl = readerHref(machineId, shownPath);
  // images of a markdown file load through the file endpoint, as the file itself does
  const imagePreview = useCallback((src: string) => markdownImagePreview(
    src, shownPath, (target) => fetchFileInfo(target, paneId), (target, download) => fileUrl(target, paneId, download),
  ), [shownPath, paneId, fetchFileInfo, fileUrl]);
  const body = (() => {
    if (directory !== null) return <DirectoryBrowser key={directory} start={directory} onOpenFile={onOpen ?? setPath} />;
    if (error !== null) return <p className="file-viewer-note" role="alert">{error === "missing" ? t("No readable file at this path.") : t("The file could not be opened.")}</p>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">Several files are named {path.split("/").pop()}:</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate)}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return <p className="file-viewer-note">{t("Opening…")}</p>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">{t("This image is {size}; download it to view.", { size: formatBytes(info.size) })}</p>
          : <img className="file-viewer-media" src={url} alt={info.name} />;
      case "video":
        return <video className="file-viewer-media" src={url} controls playsInline preload="metadata" />;
      case "audio":
        return <audio className="file-viewer-audio" src={url} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={url} title={info.name} />;
      case "text":
        if (htmlPage && !source) return <>
          {modes}
          <iframe className="file-viewer-page" src={pageUrl} sandbox="allow-scripts" title={info.name} />
        </>;
        return <>
          {htmlPage && modes}
          {loaded === null || (view === "markdown" && preview.status !== "ready")
          ? <p className="file-viewer-note">{t("Opening…")}</p>
          // a text the renderer cannot draw fails here, not the app: the header (Show source, Open raw file,
          // Close) stays, and a Preview that fails offers its source
          : <RenderBoundary key={view} resetKey={loaded} fallback={() => view === "markdown"
            ? <div className="file-viewer-note" role="alert">
              <p>{t("This preview can't be shown.")}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setChosen({ path, mode: "code" })}>{t("Show source")}</button>
            </div>
            : <p className="file-viewer-note" role="alert">{t("The file could not be opened.")}</p>}>
            <MarkdownImageContext.Provider value={imagePreview}><TextFileView path={info.path} blocks={view === "markdown" && preview.status === "ready" ? preview.blocks : null} lines={code.lines} onOpen={onOpen ?? setPath} sourceRef={sourceRef} /></MarkdownImageContext.Provider>
          </RenderBoundary>}
        </>;
      default:
        return <p className="file-viewer-note">{info.mime}, {formatBytes(info.size)}. This file can't be shown here; download it instead.</p>;
    }
  })();

  const Heading = page ? "h1" : "h2";
  const header = <header className={
    "modal-header file-viewer-header file-viewer-header-stacked" + (page ? " file-reader-header" : "")
  }>
    <div className="file-viewer-title">
      {/* a long name is cut inside its stem, so its type stays in view */}
      <Heading className="modal-title"><span className="file-viewer-stem">{stem}</span>{extension}</Heading>
      <p className="file-viewer-meta" title={shownPath}>
        {/* a partial view is told by the size ("256 KB of 1.3 MB") in the warning color, beside an
            icon so the color is not the only sign; what it means is the tooltip (and read out) */}
        {info && (noticed
          ? <span className="file-viewer-notice" title={notes.join("\n")}>
            <TriangleAlert aria-hidden="true" />
            <span>{cutShort && (loaded.total ?? info.size) > TEXT_PREVIEW_BYTES ? t("{done} of {total}", { done: formatBytes(TEXT_PREVIEW_BYTES), total: formatBytes(loaded.total ?? info.size) }) : formatBytes(info.size)}</span>
            <span className="visually-hidden">{notes.join(". ")}</span>
          </span>
          : <span className="file-viewer-size">{formatBytes(info.size)}</span>)}
        {/* the dot is the folder's, so where the folder has no room left no dot dangles */}
        {folder !== "" && <span className="file-viewer-path"><span dir="ltr">{info && <span className="file-viewer-dot" aria-hidden="true">·</span>}{folder}</span></span>}
      </p>
    </div>
    <div className="file-viewer-actions">
      {/* how the text shows: Preview or source is one choice of two, so one toggle; wrapping is a
          setting (Settings → File viewer), not an action here */}
      {textFile && previewable && <div className="file-viewer-group">
        <button type="button" className="icon-button file-viewer-action" aria-pressed={mode === "code"} aria-label={t("Show source")} title={t("Show source")} onClick={() => setChosen({ path, mode: mode === "code" ? "preview" : "code" })}><Braces aria-hidden="true" /></button>
      </div>}
      {/* the file itself: a Markdown tab is the reader; raw and download keep the original bytes */}
      <div className="file-viewer-group">
        {!page && <a className="icon-button file-viewer-action" href={htmlPage && !source ? pageUrl : markdown ? previewUrl : url} target="_blank" rel="noopener" aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>}
        {(page || markdown) && <a className="icon-button file-viewer-action" href={url} target="_blank" rel="noopener" aria-label={t("Open raw file")} title={t("Open raw file")}><Code aria-hidden="true" /></a>}
        <a className="icon-button file-viewer-action" href={fileUrl(shownPath, paneId, true)} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
        {copyable && <CopyFileButton text={loaded.text} sourceRef={sourceRef} onShowSource={showSourceToSelect} />}
      </div>
    </div>
    {!page && <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close file")} title={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>}
  </header>;
  if (page) return (
    <main ref={surface} className="file-reader">
      {header}
      <div className="file-viewer-body file-reader-body">{body}</div>
    </main>
  );

  return (
    <div className="modal-scrim file-viewer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal file-viewer" role="dialog" aria-modal="true" aria-label={info?.name ?? path} ref={surface} tabIndex={-1}>
        {header}
        <div className="file-viewer-body">{body}</div>
      </section>
    </div>
  );
}
