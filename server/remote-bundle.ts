import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
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
export async function bundleFor(platform: string, signal: AbortSignal, options: BundleSourceOptions = {}): Promise<{ bytes: Uint8Array; sha256: string }> {
  signal.throwIfAborted();
  const source = await bundleManifestSource(platform, options);
  const https = source.startsWith("https://");
  const manifest: BundleManifest = https
    ? await fetch(source, { signal }).then(async (r) => { if (!r.ok) throw new Error(`Remote bundle for ${platform} is unavailable (HTTP ${r.status}). On the web server, run bun run build:remote ${platform}, or configure HERDR_WEB_BUNDLE_MANIFEST with a published manifest.`); return r.json(); })
    : JSON.parse(await readFile(source, { encoding: "utf8", signal }));
  if (manifest.version !== REMOTE_BUNDLE_VERSION) throw new Error("Remote bundle version mismatch");
  const asset = manifest.assets[platform];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`No verified bundle for ${platform}`);
  let bytes: Uint8Array;
  if (asset.url.startsWith("https://")) {
    const r = await fetch(asset.url, { signal });
    if (!r.ok) throw new Error(`Bundle download failed (${r.status})`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } else {
    if (https || asset.url.includes("..") || asset.url.startsWith("/")) throw new Error("Bundle URL must use HTTPS");
    bytes = await readFile(join(dirname(source), asset.url), { signal });
  }
  if (signal.aborted) throw new Error("Setup cancelled");
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Remote bundle checksum mismatch");
  return { bytes, sha256: asset.sha256 };
}
export const REMOTE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
export const BUNDLE_DIR = `.local/share/herdr-web-ui/remote-v${REMOTE_BUNDLE_VERSION}`;
export async function installBundle(ssh: SshConnection, platform: string, signal: AbortSignal): Promise<void> {
  const asset = await bundleFor(platform, signal);
  // Verify on BOTH hosts, extract into staging and atomically rename. No user-wide
  // Bun/Node/herdr installation is changed; the complete runtime lives in this dir.
  await ssh.run(`set -eu; umask 077; base="$HOME/.local/share/herdr-web-ui"; mkdir -p "$base"; mkdir "$base/install.lock" || { printf 'Another installation is in progress; retry shortly\\n' >&2; exit 1; }; tmp=$(mktemp -d "$base/install.XXXXXX"); trap 'rm -rf "$tmp"; rmdir "$base/install.lock"' EXIT HUP INT TERM; cat > "$tmp/bundle.tgz"; if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/bundle.tgz" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$tmp/bundle.tgz" | cut -d ' ' -f 1); fi; test "$actual" = ${shellQuote(asset.sha256)}; mkdir "$tmp/runtime"; tar xzf "$tmp/bundle.tgz" -C "$tmp/runtime"; test -x "$tmp/runtime/bin/bun"; test -x "$tmp/runtime/bin/node"; test -x "$tmp/runtime/bin/herdr"; "$tmp/runtime/bin/bun" --version; "$tmp/runtime/bin/herdr" --version; "$tmp/runtime/bin/node" "$tmp/runtime/server/pty/smoke.mjs"; release="$HOME/${BUNDLE_DIR}-${asset.sha256.slice(0, 16)}"; if test ! -d "$release"; then mv "$tmp/runtime" "$release"; fi; ln -s "$release" "$tmp/current"; if test -d "$HOME/${BUNDLE_DIR}" && test ! -L "$HOME/${BUNDLE_DIR}"; then mv "$HOME/${BUNDLE_DIR}" "$HOME/${BUNDLE_DIR}-legacy-$(date +%s)"; fi; "$release/bin/bun" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$tmp/current" "$HOME/${BUNDLE_DIR}"`, asset.bytes, 300_000);
}
