/**
 * A markdown file opened in a tab of its own (the file viewer's "Open in a new tab"): a page of
 * just the document, never the whole app over it. Its address names the file and the PC it is on.
 */
export interface ReaderTarget { machine: string; path: string }

const PARAM = "read";

export function readerHref(machine: string, path: string, pathname = window.location.pathname): string {
  const query = new URLSearchParams({ [PARAM]: path, machine });
  return `${pathname}?${query.toString()}`;
}

export function readerFromSearch(search: string): ReaderTarget | null {
  const query = new URLSearchParams(search);
  const path = query.get(PARAM);
  if (path === null || path.trim() === "") return null;
  return { machine: query.get("machine") || "local", path };
}

/**
 * A link in the document, from the folder the document is in: `docs/guide.md`, `../x.md`; absolute and
 * `~/` paths stay. Above a `~/` document's home the `..` is kept (`~/../x.md`): only the PC knows where
 * its home is, and it expands the path.
 */
export function resolveFromDocument(document: string, target: string): string {
  if (/^(?:[\\/]|~\/|[A-Za-z]:[\\/])/.test(target)) return target;
  const folder = document.replace(/\\/g, "/").split("/").slice(0, -1);
  const home = folder[0] === "~";
  // a Windows share (//server/share) is a root as a whole: `..` never climbs above it
  const root = folder[0] === "" && folder[1] === "" && folder.length >= 4 ? 4 : 1;
  for (const part of target.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (folder.length > root && folder[folder.length - 1] !== "..") folder.pop();
      else if (home) folder.push("..");
    } else folder.push(part);
  }
  return folder.join("/") || "/";
}
