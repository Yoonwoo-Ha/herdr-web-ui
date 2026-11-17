/**
 * The server goes into .ovis/server in this checkout: herdr gives its build step no state dir, and every later command
 */
/**
 * Source instead of the binary (INSTALL.md, "Binary or source"; install.sh's pick_install is wider for now): with
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { hostPlatform, installServer, NoBinaryRelease, releasesBase } from "./server-install.ts";
import { sourceTrees } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const USAGE = "usage: bun scripts/plugin-launch.ts install | <command> [flags]   (the commands of scripts/plugin.ts: start, stop, status, phone-setup, add, ...)";

const signalExit = (signal: NodeJS.Signals): number => 128 + constants.signals[signal];

export async function run(argv: string[], env: Record<string, string> = {}, received: { signal?: NodeJS.Signals } = {}): Promise<number> {
  // Ctrl+C reaches the child too (it shares the terminal). Bun runs a signal listener from the event loop, so one for a
  // signal that came before the spawn returned runs once `child` is set.
  let child: Bun.Subprocess | undefined;
  const forward = (signal: NodeJS.Signals) => () => { received.signal ??= signal; try { child?.kill(signal); } catch {} };
  const handlers = { SIGTERM: forward("SIGTERM"), SIGHUP: forward("SIGHUP"), SIGINT: () => {} } as const;
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    child = Bun.spawn(argv, { cwd: root, env: { ...process.env, ...env }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    return child.signalCode ? signalExit(child.signalCode) : code;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  }
}

async function fromSource(command: string, args: string[]): Promise<number> {
  if (command !== "install") return await run([process.execPath, join(root, "scripts", "plugin.ts"), command, ...args]);
  const received: { signal?: NodeJS.Signals } = {};
  for (const step of [["install"], ["run", "build"], [join(root, "scripts", "pty-sidecar.ts"), "install"]]) {
    const code = await run([process.execPath, ...step], {}, received);
    if (code !== 0) return code;
    if (received.signal) return signalExit(received.signal);
  }
  return 0;
}

export type CheckoutCommit = { commit: string } | { none: "nested" | "no checkout" } | { failed: string; trust?: string; trustCmd?: string };

const shellQuote = (text: string, platform = process.platform): string =>
  platform === "win32" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;

export function gitFailed(err: string, platform = process.platform): CheckoutCommit {
  const first = err.split(/\r?\n/)[0]!;
  const owned = /^fatal: detected dubious ownership in repository at '(.*)'$/.exec(first);
  if (!owned) return { failed: err };
  const folder = owned[1]!;
  const trust = (quoted: string) => `git config --global --add safe.directory ${quoted}`;
  if (platform !== "win32") return { failed: first, trust: trust(shellQuote(folder, platform)) };
  // git prints its own command quoted for a POSIX shell; cmd.exe keeps single quotes and expands `%name%` (and `!name!`
  // under delayed expansion) inside double quotes, so a folder with either gets no cmd.exe form
  return { failed: first, trust: trust(shellQuote(folder, platform)), ...(/[%!]/.test(folder) ? {} : { trustCmd: trust(`"${folder}"`) }) };
}

const said = (answer: CheckoutCommit): string =>
  "commit" in answer ? `commit ${answer.commit.slice(0, 12)}` : "none" in answer ? (answer.none === "nested" ? "a folder inside another repository" : "no git checkout") : "git failing";

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

export async function main(args: string[], { home = join(root, ".ovis", "server"), source = fromSource, fetchFile, sources = sourceTrees(root), commit = () => checkoutCommit() }: { home?: string; source?: typeof fromSource; fetchFile?: typeof fetch; sources?: ReturnType<typeof sourceTrees>; commit?: () => Promise<CheckoutCommit> } = {}): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || ["--help", "-h", "help"].includes(command)) {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const platform = hostPlatform();
  const marker = join(home, "from-source");
  const remember = () => { mkdirSync(home, { recursive: true }); writeFileSync(marker, `${version}\n`); };
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
      if (failed.trust) {
        const windows = process.platform === "win32";
        console.error(`Ovis: git does not trust this folder (another account owns it); to trust it, run${windows ? " in PowerShell" : ""}:\n${failed.trust}`);
        if (failed.trustCmd) console.error(`Ovis: or in cmd.exe:\n${failed.trustCmd}`);
      }
    }
    else if (JSON.stringify(now) !== JSON.stringify(builtFrom)) {
      console.error("commit" in now && "commit" in builtFrom
        ? "Ovis: the checkout moved to another commit while it was built, so the build is not marked finished"
        : `Ovis: git's answer for the checkout changed while it was built (${said(builtFrom)} before, ${said(now)} after), so the build is not marked finished`);
    }
    else writeFileSync(stamp, `${"commit" in builtFrom ? `${version} ${builtFrom.commit}` : version}\n`);
    return code;
  };
  const rebuild = process.platform === "win32"
    ? `$env:OVIS_FROM_SOURCE = '1'; bun ${shellQuote(join(root, "scripts", "plugin-launch.ts"))} install`
    : `OVIS_FROM_SOURCE=1 bun ${shellQuote(join(root, "scripts", "plugin-launch.ts"))} install`;
  const builtState = async (): Promise<{ missing: string[]; stale: string | null }> => {
    const stamped = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
    const missing = [
      ...(existsSync(join(root, "node_modules")) ? [] : ["no node_modules"]),
      ...(existsSync(join(root, "dist", "index.html")) ? [] : ["no dist/index.html"]),
      ...(stamped === "started" ? ["its last build did not finish"] : []),
    ];
    if (missing.length > 0 || stamped === null || stamped === "started") return { missing, stale: null };
    const [built, builtFrom] = stamped.split(" ");
    if (built !== version) return { missing, stale: `version ${built} while the checkout is at version ${version}` };
    const now = await commit();
    if ("commit" in now && builtFrom !== now.commit) return { missing, stale: `${builtFrom ? `commit ${builtFrom.slice(0, 12)}` : "no commit"} while the checkout is at commit ${now.commit.slice(0, 12)}` };
    return { missing, stale: null };
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
      home, version, fetchFile, sources,
    });
    if (result.installed || command === "install") console.error(`Ovis: ${result.message}`);
    binary = result.binary;
  } catch (error) {
    if (error instanceof NoBinaryRelease) {
      if (command === "install") {
        console.error(`Ovis: ${error.message}, so this checkout runs from source`);
        return await build();
      }
      if (command === "start") {
        const { missing, stale } = await builtState();
        if (missing.length > 0) {
          console.error(`Ovis: ${error.message}, and this checkout has no finished build of its own (${missing.join(", ")}), so nothing was started. To build it, run:\n${rebuild}`);
          return 1;
        }
        if (stale !== null) console.error(`Ovis: this checkout's build is of ${stale}; to rebuild it, run: ${rebuild}`);
      }
      if ("error" in sources) {
        console.error(`Ovis: ${error.message}, so this checkout runs its own build`);
        return await source(command, rest);
      }
      console.error(`Ovis: ${error.message}, so this checkout runs from source`);
      if (command === "start") remember();
      return await source(command, rest);
    }
    const why = error instanceof Error ? error.message : String(error);
    if (command === "stop" || command === "status") {
      console.error(`Ovis: could not install the server of v${version} (${why}), so this checkout's ${command} runs from source`);
      return await source(command, rest);
    }
    console.error(`Ovis: could not install the server of v${version}: ${why}`);
    return 1;
  }
  if (command === "install") return 0;
  return await run([binary, "plugin", command, ...rest], { OVIS_PLUGIN_CHECKOUT: root });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
