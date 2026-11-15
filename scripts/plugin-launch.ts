/**
 * herdr's way into Ovis: herdr-plugin.toml names this file for every command (through scripts/with-bun.sh, and
 * scripts/plugin.ps1 on Windows). It installs the server of this checkout's version (package.json) from its release
 * when that is not installed yet, checked by scripts/server-install.ts (the manifest's signature by the committed key,
 * then the size and SHA-256 of each file) and moved in by one rename, then runs `ovis-server plugin <command>`.
 *
 *   bun scripts/plugin-launch.ts install            fetch and check only: herdr's build step
 *   bun scripts/plugin-launch.ts <command> [flags]  start, stop, status, phone-setup, add …, as scripts/plugin.ts has them
 *
 * The server goes into .ovis/server in this checkout: herdr gives its build step no state dir, and every later command
 * runs what that step installed once it still verifies (scripts/server-install.ts verifiedInstall), so a first start
 * needs no network. OVIS_RELEASES_URL names another place for releases: https://, or a file:// folder.
 *
 * Source instead of the binary (INSTALL.md, "Binary or source"; install.sh's pick_install is wider for now): with
 * OVIS_FROM_SOURCE=1 (a developer checkout, or a branch install.sh hands to herdr), and when this version's release ships no ovis-server.json at all
 * (HTTP 404, or none in a file:// folder: a release from before the compiled server). `install` then builds the checkout
 * (bun install, bun run build, the Rust PTY host) and every command runs scripts/plugin.ts; .ovis/server/from-source
 * remembers the second case for this version, so later commands ask no server. A manifest that exists and fails a
 * check, a server error or a network failure is a failure, never a reason to build from source.
 * .ovis/server/source-build is what that build came to (install.ps1 reads it): `started` from its first step, and the
 * version and the checkout's commit (the version alone in a folder that has none: see checkoutCommit) only once every
 * step returned 0, and only when git read the same answer before and after the build. Without git on PATH the launcher
 * still runs: the release's binary is taken only for sources git can tie to it (scripts/server-manifest.ts
 * sourceTrees), so such a checkout runs from source, saying why.
 * This file imports nothing outside scripts/ and shared/.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostPlatform, installServer, NoBinaryRelease, releasesBase } from "./server-install.ts";
import { sourceTrees } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const USAGE = "usage: bun scripts/plugin-launch.ts install | <command> [flags]   (the commands of scripts/plugin.ts: start, stop, status, phone-setup, add, ...)";

/** Runs `argv` with this process's terminal and gives back its exit code. */
export async function run(argv: string[], env: Record<string, string> = {}): Promise<number> {
  const child = Bun.spawn(argv, { cwd: root, env: { ...process.env, ...env }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  // the child takes back what it handed out (a pairing code) on SIGTERM or SIGHUP: pass them on, and let Ctrl+C reach
  // it alone (it shares the terminal) instead of ending this launcher before it
  const forward = (signal: NodeJS.Signals) => () => { try { child.kill(signal); } catch { /* gone already */ } };
  const handlers = { SIGTERM: forward("SIGTERM"), SIGHUP: forward("SIGHUP"), SIGINT: () => {} } as const;
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    const code = await child.exited;
    return child.signalCode ? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as Record<string, number>)[child.signalCode] ?? 0) : code;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  }
}

/** The checkout's own path: built from source, and scripts/plugin.ts run by this Bun. */
async function fromSource(command: string, args: string[]): Promise<number> {
  if (command !== "install") return await run([process.execPath, join(root, "scripts", "plugin.ts"), command, ...args]);
  for (const step of [["install"], ["run", "build"], [join(root, "scripts", "pty-sidecar.ts"), "install"]]) {
    const code = await run([process.execPath, ...step]);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * What git answers for the checkout in a folder, by one rule that install.ps1 (Read-InstalledCommit) and install.sh
 * (ref_not_moved) read it by too: a checkout's top level has its commit; a folder inside another repository
 * (`--show-prefix` names its path there) or one git says is no repository has none of its own; anything else (git's
 * own error, a lock, no git on PATH) is git failing, on which nothing may be decided. A folder git distrusts (another
 * account owns it) fails on every call: `trust` is the command that trusts it, for this platform's shell, built from the
 * folder git names on its first line (the command git prints is quoted for a POSIX shell).
 */
export type CheckoutCommit = { commit: string } | { none: "nested" | "no checkout" } | { failed: string; trust?: string };

function gitFailed(err: string): CheckoutCommit {
  const first = err.split(/\r?\n/)[0]!;
  const owned = /^fatal: detected dubious ownership in repository at '(.*)'$/.exec(first);
  if (!owned) return { failed: err };
  const quoted = process.platform === "win32" ? `'${owned[1]!.replaceAll("'", "''")}'` : `'${owned[1]!.replaceAll("'", "'\\''")}'`;
  return { failed: first, trust: `git config --global --add safe.directory ${quoted}` };
}

export async function checkoutCommit(dir = root): Promise<CheckoutCommit> {
  // git's own words, untranslated: "not a git repository" is told from its other errors by them
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", dir, ...args], { env: { ...process.env, LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out: out.trim(), err: err.trim() || `git exited with ${code}`, code };
  };
  try {
    const prefix = await git("rev-parse", "--show-prefix");
    if (prefix.code !== 0) return /not a git repository/.test(prefix.err) ? { none: "no checkout" } : gitFailed(prefix.err);
    if (prefix.out !== "") return { none: "nested" };
    const head = await git("rev-parse", "HEAD");
    return head.code === 0 && head.out !== "" ? { commit: head.out } : gitFailed(head.err);
  } catch (error) {
    return { failed: (error as NodeJS.ErrnoException).code === "ENOENT" ? "git is not on PATH" : String(error) };
  }
}

/** the tests': the install folder, what stands in for the source path, how a file is fetched, and how the commit is read */
export async function main(args: string[], { home = join(root, ".ovis", "server"), source = fromSource, fetchFile, sources = sourceTrees(root), commit = () => checkoutCommit() }: { home?: string; source?: typeof fromSource; fetchFile?: typeof fetch; sources?: ReturnType<typeof sourceTrees>; commit?: () => Promise<CheckoutCommit> } = {}): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || ["--help", "-h", "help"].includes(command)) {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const platform = hostPlatform();
  // The build step's choice of source, whatever made it (OVIS_FROM_SOURCE=1, which install.sh sets for a branch, or a
  // release without ovis-server.json), is remembered for this checkout's version, and every later command, which herdr
  // runs without that variable, keeps it. The next build step (a later install, or herdr plugin update) decides anew:
  // without the variable it drops the choice and asks the release again. A choice made for another version is ignored.
  const marker = join(home, "from-source");
  const remember = () => { mkdirSync(home, { recursive: true }); writeFileSync(marker, `${version}\n`); };
  // The marker is the choice, written before the build; the stamp says whether the build finished. It says `started`
  // before the marker is written and names the version and commit only after every step returned 0, so a build that
  // failed or was cut off (in bun install, or over the packages and client of an earlier build) is never taken as
  // finished. A checkout without a stamp was built by a launcher from before it, or took the release's binary. The
  // commit is the one the build started from: a checkout that moved meanwhile (a pull while bun install ran) holds
  // sources other than the ones built, and its build stays `started`. So does one where git failed, before or after:
  // the version alone would claim a folder with no commit of its own, and install.ps1 would take it as built.
  const stamp = join(home, "source-build");
  const build = async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(stamp, "started\n");
    remember();
    const builtFrom = await commit();
    const code = await source("install", rest);
    if (code !== 0) return code;
    const now = await commit();
    const failed = "failed" in builtFrom ? builtFrom : "failed" in now ? now : null;
    if (failed !== null) {
      console.error(`Ovis: git could not read the checkout's commit (${failed.failed}), so the build is not marked finished`);
      if (failed.trust) console.error(`Ovis: git does not trust this folder (another account owns it); to trust it, run:\n${failed.trust}`);
    }
    else if (JSON.stringify(now) !== JSON.stringify(builtFrom)) console.error("Ovis: the checkout moved to another commit while it was built, so the build is not marked finished");
    else writeFileSync(stamp, `${"commit" in builtFrom ? `${version} ${builtFrom.commit}` : version}\n`);
    return code;
  };
  if (command === "install") {
    rmSync(marker, { force: true });
    rmSync(stamp, { force: true });
    if (process.env["OVIS_FROM_SOURCE"] === "1") return await build();
  } else if (process.env["OVIS_FROM_SOURCE"] === "1" || (existsSync(marker) && readFileSync(marker, "utf8").trim() === version)) {
    return await source(command, rest);
  }
  let binary: string;
  try {
    const result = await installServer({
      // the release's binary only for the sources it was built from: a branch or main between releases builds its own
      home, version, fetchFile, sources,
      // the Rust PTY host comes with it, the one the signed manifest names (scripts/server-install.ts)
    });
    if (result.installed || command === "install") console.error(`Ovis: ${result.message}`);
    binary = result.binary;
  } catch (error) {
    if (error instanceof NoBinaryRelease) {
      console.error(`Ovis: ${error.message}, so this checkout runs from source`);
      if (command === "install") return await build();
      remember();
      return await source(command, rest);
    }
    console.error(`Ovis: could not install the server of v${version}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (command === "install") return 0;
  // the server it starts knows it is this plugin's: Settings then says its updates come from herdr (server/updater.ts)
  return await run([binary, "plugin", command, ...rest], { OVIS_PLUGIN_CHECKOUT: root });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
