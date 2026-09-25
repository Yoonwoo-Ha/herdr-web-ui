import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { shellQuote } from "./machine-security.ts";
import type { SshConnection } from "./ssh.ts";

export interface BundleManifest {
  version: string;
  assets: Record<string, { url: string; sha256: string }>;
}
interface BundleSourceOptions { manifest?: string; directory?: string }
export async function bundleManifestSource(platform: string, options: BundleSourceOptions = {}): Promise<string> {
  if (!/^(linux|darwin)-(x64|arm64)$/.test(platform)) throw new Error(`Unsupported bundle platform: ${platform}`);
  const configured = options.manifest ?? process.env["HERDR_WEB_BUNDLE_MANIFEST"];
  if (configured) return configured;
  // Development installs can distribute locally built runtimes without publishing
  // a release. Resolve beside this server, never against its launch directory.
  const local = join(options.directory ?? join(import.meta.dir, "..", "remote-bundles"), `manifest-${platform}.json`);
  try { await access(local); return local; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return `https://github.com/devswha/herdr-web-ui/releases/download/remote-v${REMOTE_BUNDLE_VERSION}/manifest.json`;
}
export interface BundleFile { path: string; sha256: string; size: number }
interface BundleFileOptions extends BundleSourceOptions {
  /** where downloaded bundles are kept by checksum (the state directory's bundles/) */
  cacheDir?: string;
  onProgress?(done: number, total: number | null): void;
}

/** One download per checksum at a time: PCs updating together share it, and it is kept. */
const downloads = new Map<string, { promise: Promise<void>; done: number; total: number | null; listeners: Set<(done: number, total: number | null) => void> }>();
const CACHED_BUNDLES = 4;

/** A web stream's chunks, for loops (the DOM typings give ReadableStream no async iterator). */
export async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } }
  finally { reader.releaseLock(); }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of chunksOf(Bun.file(path).stream())) hash.update(chunk);
  return hash.digest("hex");
}

/** The response body to <cache>/<sha>.tgz, checked on the way; a partial file never keeps the name. */
async function download(url: string, sha256: string, cacheDir: string, report: (done: number, total: number | null) => void): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Bundle download failed (${response.status})`);
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  // a download cut short by a restart leaves its part file; nothing else will pick it up
  for (const name of await readdir(cacheDir)) {
    if (name.includes(".part-") && Date.now() - (await stat(join(cacheDir, name)).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 3_600_000) await rm(join(cacheDir, name), { force: true });
  }
  const part = join(cacheDir, `${sha256}.tgz.part-${process.pid}-${Date.now()}`);
  const sink = Bun.file(part).writer();
  const hash = createHash("sha256");
  let done = 0;
  try {
    for await (const chunk of chunksOf(response.body)) {
      hash.update(chunk); sink.write(chunk); await sink.flush();
      done += chunk.length; report(done, total);
    }
    await sink.end();
    if (hash.digest("hex") !== sha256) throw new Error("Remote bundle checksum mismatch");
    await rename(part, join(cacheDir, `${sha256}.tgz`));
  } catch (error) {
    try { await sink.end(); } catch {}
    await rm(part, { force: true });
    throw error;
  }
  // keep the newest few (one per platform is the steady state)
  const cached = (await readdir(cacheDir)).filter((name) => /^[a-f0-9]{64}\.tgz$/.test(name));
  if (cached.length > CACHED_BUNDLES) {
    const byAge = await Promise.all(cached.map(async (name) => ({ name, at: (await stat(join(cacheDir, name))).mtimeMs })));
    for (const { name } of byAge.sort((a, b) => b.at - a.at).slice(CACHED_BUNDLES)) await rm(join(cacheDir, name), { force: true });
  }
}

/**
 * The verified bundle file for a platform: a local manifest's own file, or a release asset
 * downloaded once into cacheDir and reused while its checksum still matches.
 */
export async function bundleFile(platform: string, signal: AbortSignal, options: BundleFileOptions = {}): Promise<BundleFile> {
  signal.throwIfAborted();
  const source = await bundleManifestSource(platform, options);
  const https = source.startsWith("https://");
  const manifest: BundleManifest = https
    ? await fetch(source, { signal }).then(async (r) => { if (!r.ok) throw new Error(`Remote bundle for ${platform} is unavailable (HTTP ${r.status}). On the web server, run bun run build:remote ${platform}, or configure HERDR_WEB_BUNDLE_MANIFEST.`); return r.json() as Promise<BundleManifest>; })
    : JSON.parse(await readFile(source, { encoding: "utf8", signal }));
  if (manifest.version !== REMOTE_BUNDLE_VERSION) throw new Error("Remote bundle version mismatch");
  const asset = manifest.assets[platform];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`No verified bundle for ${platform}`);
  let path: string;
  if (asset.url.startsWith("https://")) {
    if (!options.cacheDir) throw new Error("No bundle cache directory configured");
    path = join(options.cacheDir, `${asset.sha256}.tgz`);
    const cachedOk = await access(path).then(() => fileSha256(path).then((sha) => sha === asset.sha256), () => false);
    if (!cachedOk) {
      let entry = downloads.get(asset.sha256);
      if (!entry) {
        const created = { done: 0, total: null as number | null, listeners: new Set<(done: number, total: number | null) => void>(), promise: Promise.resolve() };
        created.promise = download(asset.url, asset.sha256, options.cacheDir, (done, total) => {
          created.done = done; created.total = total;
          for (const listener of created.listeners) listener(done, total);
        }).finally(() => downloads.delete(asset.sha256));
        downloads.set(asset.sha256, created);
        entry = created;
      }
      const listener = (done: number, total: number | null) => options.onProgress?.(done, total);
      entry.listeners.add(listener);
      options.onProgress?.(entry.done, entry.total);
      // a cancelled setup stops waiting; the shared download finishes and stays cached
      try { await Promise.race([entry.promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("Setup cancelled")), { once: true }))]); }
      finally { entry.listeners.delete(listener); }
    }
  } else {
    if (https || asset.url.includes("..") || asset.url.startsWith("/")) throw new Error("Bundle URL must use HTTPS");
    path = join(dirname(source), asset.url);
    signal.throwIfAborted();
    if (await fileSha256(path) !== asset.sha256) throw new Error("Remote bundle checksum mismatch");
  }
  if (signal.aborted) throw new Error("Setup cancelled");
  return { path, sha256: asset.sha256, size: (await stat(path)).size };
}

export const REMOTE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
export const BUNDLE_DIR = `.local/share/herdr-web-ui/remote-v${REMOTE_BUNDLE_VERSION}`;
export type InstallStage = "download" | "upload" | "install";
export async function installBundle(ssh: SshConnection, platform: string, signal: AbortSignal, options: { cacheDir?: string; onProgress?(stage: InstallStage, done: number, total: number | null): void } = {}): Promise<void> {
  const report = options.onProgress ?? (() => {});
  const asset = await bundleFile(platform, signal, { cacheDir: options.cacheDir, onProgress: (done, total) => report("download", done, total) });
  report("upload", 0, asset.size);
  // Verify on BOTH hosts, extract into staging and atomically rename. No user-wide
  // Bun/Node/herdr installation is changed; the complete runtime lives in this dir.
  await ssh.run(`set -eu; umask 077; base="$HOME/.local/share/herdr-web-ui"; mkdir -p "$base"; mkdir "$base/install.lock" || { printf 'Another installation is in progress; retry shortly\\n' >&2; exit 1; }; tmp=$(mktemp -d "$base/install.XXXXXX"); trap 'rm -rf "$tmp"; rmdir "$base/install.lock"' EXIT HUP INT TERM; cat > "$tmp/bundle.tgz"; if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/bundle.tgz" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$tmp/bundle.tgz" | cut -d ' ' -f 1); fi; test "$actual" = ${shellQuote(asset.sha256)}; mkdir "$tmp/runtime"; tar xzf "$tmp/bundle.tgz" -C "$tmp/runtime"; test -x "$tmp/runtime/bin/bun"; test -x "$tmp/runtime/bin/node"; test -x "$tmp/runtime/bin/herdr"; "$tmp/runtime/bin/bun" --version; "$tmp/runtime/bin/herdr" --version; "$tmp/runtime/bin/node" "$tmp/runtime/server/pty/smoke.mjs"; release="$HOME/${BUNDLE_DIR}-${asset.sha256.slice(0, 16)}"; if test ! -d "$release"; then mv "$tmp/runtime" "$release"; fi; ln -s "$release" "$tmp/current"; if test -d "$HOME/${BUNDLE_DIR}" && test ! -L "$HOME/${BUNDLE_DIR}"; then mv "$HOME/${BUNDLE_DIR}" "$HOME/${BUNDLE_DIR}-legacy-$(date +%s)"; fi; "$release/bin/bun" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$tmp/current" "$HOME/${BUNDLE_DIR}"`, { path: asset.path, onProgress: (done) => report("upload", done, asset.size), onUploaded: () => report("install", 0, null) }, 30 * 60_000);
}
