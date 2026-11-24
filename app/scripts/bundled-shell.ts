/**
 * The hosted shell the Android app carries (docs/native-app.md, "The bundled shell"): a dist-shell copied into the
 * app's assets, which the app serves at the hosted shell's own origin with no network (BundledShell.java), so a person
 * who updates from a build that loaded it from the network keeps that origin's storage: sign-in, keys and pairings.
 *
 * OVIS_APP_SHELL picks where the shell comes from: `bundled` (the app's assets) or `hosted` (the network, at
 * OVIS_APP_URL's origin, as every build did before: the owner's preview app and the QA twin). Which shell is carried,
 * written down in `shell-provenance.json` beside it: a release's (OVIS_APP_SHELL_ARCHIVE, the tag's dist-shell.tar.gz,
 * checked against OVIS_APP_SHELL_SHA256 before it is unpacked, and OVIS_APP_SHELL_TAG), the only kind a store build
 * takes; a folder (OVIS_APP_SHELL_DIR); or, with neither, one built from this checkout, as the demo is.
 * android/app/build.gradle reads the choice from hosted-origin.properties (hosted-origin.ts), refuses to package a
 * hosted shell as the store app, and refuses a store build whose shell is not a release's.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { RENDER_PATH, SHELL_META } from "../../scripts/shell-build.ts";

export type AppShell = "bundled" | "hosted";

/**
 * OVIS_APP_SHELL: `bundled` or `hosted`. Unset, a build of the production origin (no OVIS_APP_URL, what a store build
 * is) carries the shell, and a build for another origin (`appUrl`, a preview shell, which exists to be loaded) loads
 * it from the network, as such builds always did.
 */
export function appShell(value: string | undefined, appUrl: string | null): AppShell {
  if (!value) return appUrl === null ? "bundled" : "hosted";
  if (value !== "bundled" && value !== "hosted") throw new Error(`OVIS_APP_SHELL must be bundled or hosted: ${value}`);
  return value;
}

/**
 * Where, under app/, the carried shell is written once for every platform's build: `shell/` is the dist-shell the app
 * serves, `shell-policy.json` the policies it sends with it (`page` on every answer, `render` alone on a PC's render
 * host). Outside app/www, so `bunx cap sync` leaves it alone and the app's own origin (https://localhost) never serves
 * it: the Android build adds it as an assets folder of its own (android/app/build.gradle).
 */
export const SHELL_ASSETS = "bundled-shell";

/** The carried copy's size limit: 31 MB on 2026-11-24, so a copy that doubles (sidecars, a second copy) fails the build. */
export const SHELL_BUDGET_BYTES = 64 * 1024 * 1024;

/** Its floor: a copy under half its size of 2026-11-24 lost part of itself (a partial unpack would ship a blank app). */
export const SHELL_FLOOR_BYTES = 14 * 1024 * 1024;

/**
 * Which shell a build carries (`shell-provenance.json`): a release's archive, its tag and SHA-256 (the only kind
 * Gradle packages as the store app), a folder handed to the build, or one built from the checkout; `revision` and
 * `dirty` as the copy's own build.json says.
 */
export type Provenance =
  | { source: "release"; tag: string; sha256: string }
  | { source: "folder" }
  | { source: "checkout" };

/**
 * Whether the dist-shell file at `path` (relative, `/`-separated) goes into the app: not the server's precompressed
 * copies (the app reads files itself, and Android's asset merger takes `x.js` and `x.js.gz` for one asset), and not
 * Pages' own files, whose rules the app carries out itself (`_headers`, `_redirects`) or which only the web host
 * answers (`.well-known/`, the app links' files).
 */
export function carried(path: string): boolean {
  if (/\.(gz|br)$/.test(path)) return false;
  if (path === "_headers" || path === "_redirects") return false;
  return !(path === ".well-known" || path.startsWith(".well-known/"));
}

/**
 * The two policies a dist-shell's `_headers` gives (scripts/shell-build.ts shellHeaders): `page` on every path,
 * `render` alone on a PC's render host, the first detached there. Read from the copy carried, so the app sends what
 * Pages sends for that very copy; anything else in that place throws.
 */
export function shellPoliciesOf(headers: string): { page: string; render: string } {
  const blocks = new Map<string, string[]>();
  let path: string | null = null;
  for (const line of headers.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) { path = null; continue; }
    if (!/^\s/.test(line)) { path = line.trim(); blocks.set(path, []); continue; }
    if (path !== null) blocks.get(path)!.push(line.trim());
  }
  const policy = (lines: string[] | undefined) => lines?.filter((line) => line.startsWith("Content-Security-Policy:")).map((line) => line.slice("Content-Security-Policy:".length).trim()) ?? [];
  const page = policy(blocks.get("/*"));
  const render = policy(blocks.get(RENDER_PATH));
  if (page.length !== 1 || !page[0]) throw new Error("the dist-shell's _headers gives no one Content-Security-Policy for /*");
  if (render.length !== 1 || !render[0] || !blocks.get(RENDER_PATH)?.includes("! Content-Security-Policy")) {
    throw new Error(`the dist-shell's _headers gives ${RENDER_PATH} no policy of its own`);
  }
  return { page: page[0], render: render[0] };
}

/** The files index.html starts with (`/assets/…` in a `src` or `href`), which must all be there. */
export function indexAssets(html: string): string[] {
  return [...new Set([...html.matchAll(/\b(?:src|href)="\/(assets\/[^"?#]+)"/g)].map((match) => match[1]!))];
}

/** A release tag as release.yml makes them (`v0.5.10`, `v0.6.0-beta.2`), else it throws. */
export function releaseTag(tag: string | undefined): string {
  if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`OVIS_APP_SHELL_TAG must be the release's tag, such as v0.5.10: ${tag ?? "(unset)"}`);
  return tag;
}

/**
 * Unpacks the release archive `archive` into the empty folder `into` once its SHA-256 is `sha256` (as the release's
 * dist-shell.tar.gz.sha256 gives it), and only plain files and folders come out of it; anything else throws.
 */
export function unpackRelease(archive: string, sha256: string, into: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`OVIS_APP_SHELL_SHA256 must be the archive's SHA-256 in hex: ${sha256}`);
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== sha256) throw new Error(`${archive} has SHA-256 ${actual}, not the release's ${sha256}`);
  mkdirSync(into, { recursive: true });
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", into, "--no-same-owner", "--no-same-permissions"], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(`${archive} did not unpack: ${tar.stderr.toString()}`);
  // as release.yml checks the archive it deploys: a link or a device in it could point the copy elsewhere
  const odd = Bun.spawnSync(["find", into, "!", "-type", "f", "!", "-type", "d"], { stdout: "pipe" }).stdout.toString().trim();
  if (odd !== "") throw new Error(`${archive} holds something other than files and folders: ${odd.split("\n")[0]}`);
}

/** Where a bundled build's shell comes from, as its environment names it. */
export type ShellSource =
  | { kind: "release"; archive: string; sha256: string; tag: string }
  | { kind: "folder"; dir: string }
  | { kind: "checkout" };

/**
 * The shell `env` names: a release archive (OVIS_APP_SHELL_ARCHIVE, with OVIS_APP_SHELL_SHA256 and OVIS_APP_SHELL_TAG,
 * all three or none), a folder (OVIS_APP_SHELL_DIR), or neither, this checkout's. Two at once, or half a release, throws.
 */
export function shellSource(env: Record<string, string | undefined>): ShellSource {
  const archive = env["OVIS_APP_SHELL_ARCHIVE"], sha256 = env["OVIS_APP_SHELL_SHA256"], tag = env["OVIS_APP_SHELL_TAG"], dir = env["OVIS_APP_SHELL_DIR"];
  if (archive && dir) throw new Error("OVIS_APP_SHELL_ARCHIVE and OVIS_APP_SHELL_DIR name two shells: give one");
  if (archive || sha256 || tag) {
    if (!archive || !sha256) throw new Error("a release's shell takes OVIS_APP_SHELL_ARCHIVE, OVIS_APP_SHELL_SHA256 and OVIS_APP_SHELL_TAG together");
    return { kind: "release", archive, sha256: sha256.toLowerCase(), tag: releaseTag(tag) };
  }
  return dir ? { kind: "folder", dir } : { kind: "checkout" };
}

/** What packShell writes down for `source`. */
export function provenanceOf(source: ShellSource): Provenance {
  return source.kind === "release" ? { source: "release", tag: source.tag, sha256: source.sha256 } : { source: source.kind };
}

/** Every file under `dir`, relative and `/`-separated. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => statSync(join(dir, file)).isFile())
    .map((file) => file.split(sep).join("/"));
}

/**
 * Copies the dist-shell `from` into `assets` (SHELL_ASSETS), after clearing it: its files the app carries into `shell/`,
 * the policies of its `_headers` into `shell-policy.json`, and where it came from (`provenance`, with the copy's own
 * build.json revision) into `shell-provenance.json`. Throws, leaving `assets` as it found it, when `from` is not a whole
 * dist-shell (a file index.html starts with is missing) or the copy is over `budget` or under `floor` bytes.
 */
export function packShell(from: string, assets: string, provenance: Provenance, { budget = SHELL_BUDGET_BYTES, floor = SHELL_FLOOR_BYTES } = {}): { files: number; bytes: number } {
  for (const file of ["index.html", "render.html", "manifest.webmanifest", "_headers"]) {
    if (!existsSync(join(from, file))) throw new Error(`${from} is not a dist-shell: it holds no ${file} (bun run build:shell makes one)`);
  }
  const index = readFileSync(join(from, "index.html"), "utf8");
  if (!index.includes(SHELL_META)) throw new Error(`${from}/index.html is not the shell's: it lacks ${SHELL_META}`);
  const missing = indexAssets(index).filter((file) => !existsSync(join(from, file)));
  if (missing.length > 0) throw new Error(`${from} is missing files its index.html starts with (${missing.join(", ")}): a partial copy would open blank`);
  const policies = shellPoliciesOf(readFileSync(join(from, "_headers"), "utf8"));
  const files = filesIn(from).filter(carried);
  const bytes = files.reduce((sum, file) => sum + statSync(join(from, file)).size, 0);
  if (bytes < floor) throw new Error(`the shell to carry is ${(bytes / 1048576).toFixed(1)} MB, under its ${(floor / 1048576).toFixed(0)} MB floor (SHELL_FLOOR_BYTES; it was 31 MB on 2026-11-24): a copy that lost part of itself`);
  if (bytes > budget) {
    const top = new Map<string, number>();
    for (const file of files) top.set(file.split("/")[0]!, (top.get(file.split("/")[0]!) ?? 0) + statSync(join(from, file)).size);
    const largest = [...top].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, size]) => `${name} ${(size / 1048576).toFixed(1)} MB`).join(", ");
    throw new Error(`the shell to carry is ${(bytes / 1048576).toFixed(1)} MB, over its ${(budget / 1048576).toFixed(0)} MB budget (SHELL_BUDGET_BYTES; it was 31 MB on 2026-11-24). Largest: ${largest}. Find what grew before raising it.`);
  }
  let build: { revision?: unknown; dirty?: unknown } = {};
  try { build = JSON.parse(readFileSync(join(from, "build.json"), "utf8")) as typeof build; } catch {}
  const written = { ...provenance, ...(typeof build.revision === "string" ? { revision: build.revision } : {}), ...(typeof build.dirty === "boolean" ? { dirty: build.dirty } : {}) };
  rmSync(assets, { recursive: true, force: true });
  const into = join(assets, "shell");
  mkdirSync(into, { recursive: true });
  for (const file of files) cpSync(join(from, file), join(into, file));
  writeFileSync(join(assets, "shell-policy.json"), `${JSON.stringify(policies)}\n`);
  writeFileSync(join(assets, "shell-provenance.json"), `${JSON.stringify(written)}\n`);
  return { files: files.length, bytes };
}

/** The shell built from this checkout into `out`, as `bun run build:shell` builds it, for a build given no shell. */
export function buildShell(out: string): void {
  const repo = join(import.meta.dir, "../..");
  const vite = Bun.spawnSync([process.execPath, "--bun", join(repo, "node_modules/.bin/vite"), "build", "--mode", "shell", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo, env: process.env, stderr: "pipe", stdout: "ignore" });
  if (vite.exitCode !== 0) throw new Error(`the shell did not build:\n${new TextDecoder().decode(vite.stderr)}`);
}

