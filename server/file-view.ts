import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

import type { FileInfo, FileKind } from "../shared/protocol.ts";
import { filesNamed } from "./files.ts";

/**
 * Opening a file from the browser: the files agents write (a screenshot, a demo video, a
 * PDF, a log) seen on a phone that has no terminal to open them with.
 *
 * Nothing is read into memory to serve a file: the response is `Bun.file`, which Bun
 * streams from disk (sendfile where it can) and answers Range requests for, so a video
 * plays and seeks without the server holding more than its socket buffers. Only the
 * first bytes of a file are read, to tell text from binary.
 *
 * It opens what this server's user can read, which is no more than the terminal the same
 * browser can already type into.
 */

/** A path as agents and people write it: absolute, `~/…`, or relative to the pane's folder. */
export function resolveFilePath(input: string, cwd: string | null): string | null {
  const path = input.trim();
  if (path === "") return null;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd === null ? null : resolve(cwd, path);
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|typescript|xml|x-sh|toml|yaml|x-yaml|sql)|image\/svg\+xml)/;
const SNIFF_BYTES = 8192;

function kindOf(mime: string, path: string): FileKind {
  if (mime === "image/svg+xml") return "image";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (TEXT_TYPES.test(mime)) return "text";
  // no known type (a .log, a dotfile, source without a registered extension): text when
  // its first bytes hold no NUL
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0) ? "binary" : "text";
  } catch {
    return "binary";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The file a path means: as written, or — for a relative path that is not there — the one
 * file under the pane's folder whose path ends in it (agents often name `demo.mp4` without
 * `docs/screenshots/`). Several such files come back as candidates to choose from.
 */
export function locateFile(input: string, cwd: string | null): { info: FileInfo } | { candidates: string[] } | null {
  const path = resolveFilePath(input, cwd);
  const info = path === null ? null : fileInfo(path);
  if (info !== null) return { info };
  const relative = input.trim();
  if (cwd === null || relative === "" || isAbsolute(relative) || relative.startsWith("~") || relative.startsWith("../")) return null;
  const found = filesNamed(cwd, relative).map((match) => resolve(cwd, match));
  if (found.length === 1) {
    const only = fileInfo(found[0]!);
    return only === null ? null : { info: only };
  }
  return found.length > 1 ? { candidates: found } : null;
}

/** What the viewer needs to know about a file, or null when it is not a readable file. */
export function fileInfo(path: string): FileInfo | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mime = Bun.file(path).type.split(";")[0] || "application/octet-stream";
  return { path, name: basename(path), size: stat.size, modified: stat.mtime.toISOString(), mime, kind: kindOf(mime, path) };
}

/**
 * An HTML page drawn as a page (the report or chart an agent wrote): its own script runs, but in
 * a sandbox without `allow-same-origin`, so it has no origin, no cookie and no storage of this
 * app's, and with no `connect-src` it cannot fetch, open a socket or beacon anything, here or
 * anywhere. It may load pictures, styles, fonts and scripts from https (a page made with a chart
 * library from a CDN draws as it does in any browser), but nothing from this server: an image
 * that loads or fails would tell it which of this PC's files exist. Only this app may frame it.
 * What it takes from its own folder (a screenshot beside the report, its stylesheet and script)
 * is put into the page before it is sent (`pageWithLocalFiles`), so it still asks for nothing.
 */
const PAGE_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  // nothing from the web either: the page holds its own folder's files (below), and a script that
  // could reach any https URL could send them there
  "script-src 'unsafe-inline' 'unsafe-eval' data:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** A page's own files are put into it up to these sizes; a larger one is left as the page names it. */
const EMBED_FILE_BYTES = 8 * 1024 * 1024;
const EMBED_TOTAL_BYTES = 32 * 1024 * 1024;
/** A page larger than this is sent as it is, without its files put into it. */
const EMBED_PAGE_BYTES = 8 * 1024 * 1024;
/** Distinct URLs a page may name; past this many the rest are left as they are (each is a filesystem lookup). */
const EMBED_REFS = 1_000;

/**
 * The file a page names by a relative URL, when it is a file in the page's folder or below,
 * symlinks resolved, with no hidden name on the way (`.ssh/`, `.env`); null for a URL with a
 * scheme, a host or a rooted path, or anything outside.
 */
function pageFile(ref: string, folder: string): string | null {
  const value = ref.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\") || value.startsWith("#")) return null;
  let relative: string;
  try { relative = decodeURIComponent(value.split(/[?#]/)[0]!); } catch { return null; }
  // decoded, it may name a root, a drive or a share (`%5C%5Chost%5Cshare`): on Windows, resolving
  // that would reach out to the share before any check, so it never gets that far
  if (!relative || isAbsolute(relative) || /^[\\/]/.test(relative) || /^[a-z]:/i.test(relative)) return null;
  const target = resolve(folder, relative);
  if (!target.startsWith(folder + sep)) return null;
  try {
    const file = realpathSync(target);
    if (!file.startsWith(folder + sep) || file.slice(folder.length + 1).split(sep).some((part) => part.startsWith("."))) return null;
    return statSync(file).isFile() ? file : null;
  } catch { return null; }
}

/** The page's script can read what is put into it, so each element takes only its own kind of
 * file: never a key or a .env named as a picture's source. */
const mimeOf = (file: string): string => Bun.file(file).type.split(";")[0] || "application/octet-stream";
const MEDIA = (mime: string) => /^(?:image|video|audio)\//.test(mime);
const SCRIPT = (mime: string) => mime === "text/javascript" || mime === "application/javascript";
const STYLE = (mime: string) => mime === "text/css";
/** a script element that runs (no type, a JavaScript type, or a module); a data block (`type="text/plain"`) takes no file */
const RUNS = (type: string | null) => type === null || /^\s*(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)?\s*$/i.test(type);

/**
 * The page with the pictures, media, stylesheets and scripts it takes from its own folder put
 * into it as data: URLs, so the element keeps its attributes (`defer`, `type="module"`, a
 * stylesheet's `media`): the sandbox may ask this server for nothing, and on a paired phone it
 * could not anyway (the device cookie is SameSite=Strict, and a sandboxed page has no origin).
 * Nothing outside the page's folder is read; a URL is resolved once however often it is named.
 */
export function pageWithLocalFiles(path: string): string {
  const folder = realpathSync(dirname(path));
  let left = EMBED_TOTAL_BYTES;
  const resolved = new Map<string, string | null>();
  const take = (ref: string | null, accepts: (mime: string) => boolean): string | null => {
    if (ref === null) return null;
    if (!resolved.has(ref)) resolved.set(ref, resolved.size < EMBED_REFS ? pageFile(ref, folder) : null);
    const file = resolved.get(ref) ?? null;
    if (file === null || !accepts(mimeOf(file))) return null;
    const size = statSync(file).size;
    if (size > EMBED_FILE_BYTES || size > left) return null;
    left -= size;
    return file;
  };
  const embed = (attribute: string, accepts: (mime: string) => boolean, when: (element: HTMLRewriterTypes.Element) => boolean = () => true) => ({
    element(element: HTMLRewriterTypes.Element) {
      if (!when(element)) return;
      const file = take(element.getAttribute(attribute), accepts);
      if (file !== null) element.setAttribute(attribute, `data:${mimeOf(file)};base64,${readFileSync(file).toString("base64")}`);
    },
  });
  return new HTMLRewriter()
    .on("img[src]", embed("src", MEDIA))
    .on("source[src]", embed("src", MEDIA))
    .on("video[src]", embed("src", MEDIA))
    .on("video[poster]", embed("poster", MEDIA))
    .on("audio[src]", embed("src", MEDIA))
    .on("script[src]", embed("src", SCRIPT, (element) => RUNS(element.getAttribute("type"))))
    .on('link[rel~="stylesheet" i][href]', embed("href", STYLE))
    .transform(readFileSync(path, "utf8"));
}

/**
 * A file read asked for by another site's page as a picture, script or fetch, not a navigation:
 * a rendered page (which has no origin) naming this server's files to learn which exist, or any
 * other site doing the same where the server lets a request in without a cookie. A navigation (a
 * new tab, a download, Android's PDF "Open" button) and a browser that sends no Fetch Metadata
 * still pass.
 */
export function crossSiteFileRead(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin" || site === "none") return false;
  return request.headers.get("sec-fetch-mode") !== "navigate";
}

/** Whether `fileResponse` can draw this file as a page, given `render`. */
export function isHtmlPage(info: FileInfo): boolean {
  return info.kind === "text" && info.mime === "text/html";
}

/**
 * The file itself. `download` asks the browser to save it. Answers are sandboxed (an HTML
 * or SVG file opened from this origin must not run script with the app's access), and
 * text is served as plain text whatever its extension says it runs as. `render` asks for an
 * HTML page as a page (`PAGE_POLICY`); any other file ignores it.
 */
export function fileResponse(info: FileInfo, download: boolean, render = false): Response {
  const name = encodeURIComponent(info.name);
  const headers = new Headers({
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  const page = render && !download && isHtmlPage(info);
  // a PDF is drawn by the browser's own viewer, which refuses a sandboxed document; its
  // scripts stay inside that viewer, never on this origin
  if (page) headers.set("content-security-policy", PAGE_POLICY);
  else if (info.kind !== "pdf") headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  // text shows as text, whatever its extension says it runs as
  const type = page ? "text/html; charset=utf-8" : info.kind === "text" && info.mime !== "image/svg+xml" ? "text/plain; charset=utf-8" : info.mime;
  if (page && info.size <= EMBED_PAGE_BYTES) {
    headers.set("content-type", type);
    return new Response(pageWithLocalFiles(info.path), { headers });
  }
  const file = Bun.file(info.path, { type });
  return new Response(file, { headers });
}
