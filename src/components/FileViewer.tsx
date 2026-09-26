import { useEffect, useState } from "react";
import { Download, ExternalLink, X } from "lucide-react";

import "./FileViewer.css";

import type { FileInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { useMachineApi } from "../lib/machineContext.tsx";

/** Bigger images are offered as a download: a phone decodes an image whole. */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
/** Text shows its first part: the rest is a download away. */
const TEXT_PREVIEW_BYTES = 256 * 1024;

export interface FileViewerProps {
  /** absolute, `~/…`, or relative to the pane's folder */
  path: string;
  paneId: string | null;
  onClose: () => void;
}

/**
 * A file an agent wrote, opened in the browser: images, video and audio (streamed, so they
 * play and seek at once), PDFs, and the start of a text file. Anything can be downloaded.
 */
export function FileViewer({ path: asked, paneId, onClose }: FileViewerProps) {
  const { fetchFileInfo, fileUrl } = useMachineApi();
  // the path as given, until a choice among files of that name replaces it
  const [path, setPath] = useState(asked);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => setPath(asked), [asked]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null); setCandidates(null); setError(null); setText(null);
    fetchFileInfo(path, paneId).then(async (next) => {
      if (cancelled) return;
      if ("candidates" in next) { setCandidates(next.candidates); return; }
      setInfo(next);
      if (next.kind !== "text") return;
      // only the first part of a text file travels: a range, whatever the file's size
      const response = await fetch(fileUrl(next.path, paneId), { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
      const body = await response.text();
      if (!cancelled) setText(body);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof ApiError && reason.status === 404 ? "No readable file at this path." : "The file could not be opened.");
    });
    return () => { cancelled = true; };
  }, [path, paneId, fetchFileInfo, fileUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // the file found (a bare name may have been found deeper in the folder), else as asked
  const url = fileUrl(info?.path ?? path, paneId);
  const body = (() => {
    if (error !== null) return <p className="file-viewer-note" role="alert">{error}</p>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">Several files are named {path.split("/").pop()}:</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate)}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return <p className="file-viewer-note">Opening…</p>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">This image is {formatBytes(info.size)}; download it to view.</p>
          : <img className="file-viewer-media" src={url} alt={info.name} />;
      case "video":
        return <video className="file-viewer-media" src={url} controls playsInline preload="metadata" />;
      case "audio":
        return <audio className="file-viewer-audio" src={url} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={url} title={info.name} />;
      case "text":
        return text === null ? <p className="file-viewer-note">Opening…</p> : <>
          <pre className="file-viewer-text">{text}</pre>
          {info.size > TEXT_PREVIEW_BYTES && <p className="file-viewer-note">Showing the first {formatBytes(TEXT_PREVIEW_BYTES)} of {formatBytes(info.size)}.</p>}
        </>;
      default:
        return <p className="file-viewer-note">{info.mime}, {formatBytes(info.size)}. This file can't be shown here; download it instead.</p>;
    }
  })();

  return (
    <div className="modal-scrim file-viewer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal file-viewer" role="dialog" aria-modal="true" aria-label={info?.name ?? path}>
        <header className="modal-header file-viewer-header">
          <div className="file-viewer-title">
            <h2 className="modal-title">{info?.name ?? path.split("/").pop()}</h2>
            <p className="file-viewer-meta" title={info?.path ?? path}>
              {info && <span className="file-viewer-size">{formatBytes(info.size)}</span>}
              <span className="file-viewer-path"><span dir="ltr">{info?.path ?? path}</span></span>
            </p>
          </div>
          <a className="icon-button" href={url} target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab"><ExternalLink aria-hidden="true" /></a>
          <a className="icon-button" href={fileUrl(info?.path ?? path, paneId, true)} download={info?.name ?? true} aria-label="Download" title="Download"><Download aria-hidden="true" /></a>
          <button type="button" className="icon-button" aria-label="Close file" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="file-viewer-body">{body}</div>
      </section>
    </div>
  );
}
