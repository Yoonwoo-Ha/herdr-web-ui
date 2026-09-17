/**
 * Serves the built client out of dist/.
 *
 * Cache-Control is decided per file on purpose: Vite fingerprints everything under
 * /assets/, so those are safe to pin for a year, while the service worker, the web
 * manifest and the index.html shell must revalidate on every load - a cached sw.js
 * or shell pins the installed PWA to a build the user can no longer get rid of.
 */

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

const DIST_DIR = new URL("../dist", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Files whose URL never changes but whose contents decide what the app becomes. */
const REVALIDATED_PATHS = new Set(["/sw.js", "/manifest.webmanifest"]);

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=86400";
const REVALIDATE = "no-cache";

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

function cacheControlFor(pathname: string): string {
  if (REVALIDATED_PATHS.has(pathname)) return REVALIDATE;
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE;
  return SHORT_CACHE;
}

export async function serveStatic(pathname: string): Promise<Response> {
  const indexPath = join(DIST_DIR, "index.html");
  if (!existsSync(indexPath)) {
    return new Response(
      "herdr-web-ui server is running, but the browser client has not been built yet.\nRun: bun run build\n",
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(DIST_DIR, relative);
  if (candidate.startsWith(DIST_DIR) && relative !== "/" && existsSync(candidate)) {
    const file = Bun.file(candidate);
    if ((await file.exists()) && !(await file.stat()).isDirectory()) {
      return new Response(file, {
        headers: { "content-type": contentTypeFor(candidate), "cache-control": cacheControlFor(pathname) },
      });
    }
  }
  return new Response(Bun.file(indexPath), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": REVALIDATE },
  });
}
