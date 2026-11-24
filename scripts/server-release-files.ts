import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKeeperManifest, checkManifest, DIST_ARCHIVE, MANIFEST, RELEASE_PUBLIC_KEY, type ReleaseAsset } from "./server-manifest.ts";
import { KEEPER_MANIFEST } from "./release-assets.ts";

/**
 * The bytes at `url`, refused once they pass `limit` (a file larger than its manifest says is never read whole), or
 * null where there is no such file (HTTP 404). Redirects are followed by hand: one to anything but https is refused
 * before a request is made to it.
 */
export async function download(url: string, limit: number, name: string, fetchFile: typeof fetch = fetch, signal = AbortSignal.timeout(600_000)): Promise<Uint8Array | null> {
  const tooLarge = () => new Error(`${name} is larger than the ${limit} byte limit; nothing was changed`);
  if (url.startsWith("file://")) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) return null;
    signal.throwIfAborted();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error(name + " is not a regular file");
      if (stat.size > limit) throw tooLarge();
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!n) break;
        offset += n;
      }
      if (fstatSync(fd).size > limit) throw tooLarge();
      return bytes.subarray(0, offset);
    } finally { closeSync(fd); }
  }
  let response: Response;
  let at = url;
  for (let hops = 0; ; hops++) {
    response = await fetchFile(at, { redirect: "manual", signal });
    if (response.status < 300 || response.status > 399) break;
    const next = new URL(response.headers.get("location") ?? "", at).href;
    if (!next.startsWith("https://")) throw new Error(`${url} redirected to ${next}, which is not https; nothing was changed`);
    if (hops >= 10) throw new Error(`${url} redirected more than 10 times; nothing was changed`);
    at = next;
  }
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}; nothing was changed`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** `asset` from the release at `at`, only when its size and SHA-256 are what the checked manifest names. */
export async function checked(at: string, asset: ReleaseAsset, fetchFile?: typeof fetch, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = await download(`${at}/${asset.file}`, asset.size, asset.file, fetchFile, signal);
  if (!bytes) throw new Error(`${at}/${asset.file} does not exist; nothing was changed`);
  if (bytes.length !== asset.size) throw new Error(`${asset.file} is ${bytes.length} bytes, not the ${asset.size} its signed manifest names; nothing was changed`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) throw new Error(`${asset.file} does not match its SHA-256 in its signed manifest (got ${digest}); nothing was changed`);
  return bytes;
}

/**
 * Unpacks the client archive into `into`, after its listing shows only plain files and folders inside it: no absolute
 * path, no `..`, no link, so a crafted archive cannot write outside the release folder.
 */
export function unpack(archive: string, into: string): void {
  const tar = (...args: string[]) => {
    const result = Bun.spawnSync(["tar", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    if (result.exitCode !== 0) throw new Error(`tar ${args[0]} ${DIST_ARCHIVE} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}; nothing was changed`);
    return result.stdout.toString();
  };
  for (const name of tar("-tzf", archive).split("\n").filter(Boolean)) {
    if (/^([/\\]|[A-Za-z]:)/.test(name) || name.split(/[/\\]/).includes("..")) throw new Error(`${DIST_ARCHIVE} holds ${name}, a path outside its folder; nothing was changed`);
  }
  for (const line of tar("-tzvf", archive).split("\n").filter(Boolean)) {
    if (!/^[-d]/.test(line)) throw new Error(`${DIST_ARCHIVE} holds something other than files and folders (${line.trim()}); nothing was changed`);
  }
  mkdirSync(into, { recursive: true });
  tar("-xzf", archive, "-C", into, "--no-same-owner");
  for (const entry of readdirSync(into, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`${DIST_ARCHIVE} unpacked something other than files and folders; nothing was changed`);
  }
  if (!existsSync(join(into, "index.html"))) throw new Error(`${DIST_ARCHIVE} holds no index.html; nothing was changed`);
}

/** A packaging or repair job trusts neither the source manifests nor a previous install's records. */
export async function signedHelpers(at: string, version: string, publicKey = RELEASE_PUBLIC_KEY) {
  const required = async (name: string, limit: number) => {
    const bytes = await download(at + "/" + name, limit, name);
    if (!bytes) throw new Error("Missing signed release file: " + name);
    return Buffer.from(bytes);
  };
  const serverBytes = await required(MANIFEST, 65536);
  const server = checkManifest(serverBytes, (await required(MANIFEST + ".sig", 1024)).toString(), publicKey, { version });
  if (typeof server === "string") throw new Error(server);
  const keepers = checkKeeperManifest(await required(KEEPER_MANIFEST, 65536), (await required(KEEPER_MANIFEST + ".sig", 1024)).toString(), { version, publicKey, serverBytes });
  if (typeof keepers === "string") throw new Error(keepers);
  return { hosts: server.pty, keepers };
}
