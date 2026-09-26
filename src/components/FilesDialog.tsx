import { useEffect } from "react";
import { X } from "lucide-react";

import { DirectoryBrowser } from "./DirectoryBrowser.tsx";

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

/** The files of the pane's folder (and any other), each opened in the file viewer. */
export function FilesDialog({ start, onOpenFile, onClose }: FilesDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title">
        <header className="modal-header">
          <h2 className="modal-title" id="files-dialog-title">Files</h2>
          <button type="button" className="icon-button" aria-label="Close files" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <DirectoryBrowser start={start} onOpenFile={onOpenFile} />
        </div>
      </section>
    </div>
  );
}
