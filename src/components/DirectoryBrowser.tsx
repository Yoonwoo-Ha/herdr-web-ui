import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, House } from "lucide-react";

import type { DirectoryListing } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";

export interface DirectoryBrowserProps {
  /** where to open: the path typed so far (absolute, `~` or `~/…`); empty or unreadable opens home */
  start: string;
  /** the folder chosen, in the dialog's own syntax (`~/…` inside home) */
  onPick: (path: string) => void;
}

/** `~/…` for a path inside home, as the directory field is usually typed. */
export function homeRelative(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function childPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/**
 * A folder browser for the new-session dialog: one directory at a time, fetched from the
 * PC the session starts on. Nothing is kept but the folder shown now.
 */
export function DirectoryBrowser({ start, onPick }: DirectoryBrowserProps) {
  const { fetchDirectories } = useMachineApi();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const open = useCallback(async (path: string, showHidden: boolean, fallbackHome: boolean) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await fetchDirectories(path, showHidden);
      if (id !== request.current) return;
      setListing(next);
      setError(null);
      listRef.current?.scrollTo({ top: 0 });
    } catch (reason: unknown) {
      if (id !== request.current) return;
      // a path typed half-way opens home instead of an error
      if (fallbackHome && reason instanceof ApiError && reason.code === "invalid_cwd") return void open("", showHidden, false);
      setError(reason instanceof ApiError && reason.status === 404
        ? "This PC's bridge cannot browse folders yet. Type the path instead."
        : reason instanceof ApiError && reason.code === "invalid_cwd" ? "This folder cannot be opened." : "Folders could not be loaded.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [fetchDirectories]);

  useEffect(() => { void open(start, false, true); }, []);

  const path = listing?.path ?? "";
  const shown = listing ? homeRelative(listing.path, listing.home) : start || "~";

  return (
    <div className="dir-browser" role="group" aria-label="Choose a folder" aria-busy={loading}>
      <div className="dir-browser-bar">
        <button type="button" className="icon-button" aria-label="Parent folder" title="Parent folder" disabled={!listing?.parent || loading} onClick={() => listing?.parent && void open(listing.parent, hidden, false)}>
          <ArrowUp aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="Home folder" title="Home folder" disabled={loading || (listing !== null && listing.path === listing.home)} onClick={() => void open("", hidden, false)}>
          <House aria-hidden="true" />
        </button>
        <span className="dir-browser-path" title={path}><span dir="ltr">{shown}</span></span>
      </div>
      {error !== null ? <p className="dir-browser-note dir-browser-error" role="alert">{error}</p> : (
        <ul className="dir-browser-list" ref={listRef}>
          {listing?.directories.map((name) => (
            <li key={name}>
              <button type="button" className="dir-browser-item" disabled={loading} onClick={() => void open(childPath(path, name), hidden, false)}>
                <Folder aria-hidden="true" />
                <span>{name}</span>
              </button>
            </li>
          ))}
          {listing !== null && listing.directories.length === 0 && <li className="dir-browser-note">No folders here</li>}
          {listing?.truncated && <li className="dir-browser-note">Showing the first {listing.directories.length} folders; type the rest of the path to go further.</li>}
        </ul>
      )}
      <div className="dir-browser-footer">
        <label className="dir-browser-hidden">
          <input type="checkbox" checked={hidden} disabled={loading && listing === null} onChange={(event) => { setHidden(event.target.checked); if (listing) void open(listing.path, event.target.checked, false); }} />
          Show hidden
        </label>
        <button type="button" className="btn btn-primary" disabled={listing === null || loading} onClick={() => listing && onPick(homeRelative(listing.path, listing.home))}>
          Use this folder
        </button>
      </div>
    </div>
  );
}
