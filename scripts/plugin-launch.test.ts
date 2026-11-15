import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkoutCommit, main } from "./plugin-launch.ts";
import { generateKeyPair, MANIFEST, releaseFile, PTY_ASSETS, ptyFile, SERVER_PLATFORMS, signManifest, writeManifest } from "./server-manifest.ts";

/**
 * scripts/plugin-launch.ts's choice between the release's binary and this checkout's sources (INSTALL.md, "Binary or
 * source"): sources only when this version's release has no ovis-server.json at all. The source path is a
 * stand-in that records its call (the real one would build the checkout and run scripts/plugin.ts), and every install
 * goes into a folder of the test's own.
 */
const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
let scratch = "";
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-launch-"));
  saved = { OVIS_RELEASES_URL: process.env["OVIS_RELEASES_URL"], OVIS_FROM_SOURCE: process.env["OVIS_FROM_SOURCE"] };
  delete process.env["OVIS_FROM_SOURCE"];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** runs `args` with the source path recorded; what it returned, and each call the source path got */
const BUILT_FROM = { server: "a".repeat(40), shared: "b".repeat(40) };
async function launch(args: string[], fetchFile?: typeof fetch): Promise<{ code: number; sourced: string[][]; home: string }> {
  const home = join(scratch, "server");
  const sourced: string[][] = [];
  const code = await main(args, { home, fetchFile, source: async (command, rest) => { sourced.push([command, ...rest]); return 7; } });
  return { code, sourced, home };
}

describe("the herdr plugin's launcher", () => {
  it("builds from source, saying so, when this version's release folder has no ovis-server.json, and remembers it", async () => {
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    mkdirSync(join(scratch, "release", `v${version}`), { recursive: true });
    const first = await launch(["status", "--json"]);
    expect(first).toMatchObject({ code: 7, sourced: [["status", "--json"]] });
    expect(readFileSync(join(first.home, "from-source"), "utf8")).toBe(`${version}\n`);
    // a later command asks no server: an address it could not even use changes nothing
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    expect(await launch(["stop"])).toMatchObject({ code: 7, sourced: [["stop"]] });
    expect(existsSync(join(first.home, "bin"))).toBe(false);
  });

  it("builds from source when GitHub answers 404 for this version's ovis-server.json", async () => {
    delete process.env["OVIS_RELEASES_URL"];
    const asked: string[] = [];
    const notFound = (async (url: string | URL | Request) => { asked.push(String(url)); return new Response(null, { status: 404 }); }) as typeof fetch;
    expect(await launch(["install"], notFound)).toMatchObject({ code: 7, sourced: [["install"]] });
    expect(asked).toEqual([`https://github.com/devswha/ovis/releases/download/v${version}/ovis-server.json`]);
  });

  it("fails, and never builds from source, on a server error", async () => {
    delete process.env["OVIS_RELEASES_URL"];
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const result = await launch(["start"], broken);
    expect(result).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(result.home, "from-source"))).toBe(false);
  });

  it("fails, and never builds from source, on a manifest that is there but not signed by the pinned key", async () => {
    const dir = join(scratch, "release", `v${version}`);
    mkdirSync(dir, { recursive: true });
    for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
    for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
    writeFileSync(join(dir, "ovis-dist.tar.gz"), "client\n");
    writeManifest(dir, { version, sources: BUILT_FROM });
    signManifest(dir, generateKeyPair().privateKeyPem);
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    const result = await launch(["start"]);
    expect(result).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(result.home, "from-source"))).toBe(false);
    rmSync(join(dir, MANIFEST));
    expect((await launch(["start"])).sourced).toEqual([["start"]]);
  });

  it("asks the release again at the build step, so a release that gained its binary is taken", async () => {
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    mkdirSync(join(scratch, "release", `v${version}`), { recursive: true });
    await launch(["status"]);
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    // the build step drops what was remembered and asks again; this address is refused, so it fails
    expect(await launch(["install"])).toMatchObject({ code: 1, sourced: [] });
  });

  it("takes the source path at once with OVIS_FROM_SOURCE=1", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    expect(await launch(["phone-setup"])).toMatchObject({ code: 7, sourced: [["phone-setup"]] });
  });

  it("keeps the build step's source choice for every later command herdr runs without the variable", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const install = await launch(["install"]);
    expect(install).toMatchObject({ code: 7, sourced: [["install"]] });
    delete process.env["OVIS_FROM_SOURCE"];
    // the release answers a server error: a start that asked it would fail, not run the sources the install built
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 7, sourced: [["start"]] });
  });

  it("ignores a source choice made for another version, and a build step without the variable drops it", async () => {
    const home = join(scratch, "server");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "from-source"), "0.0.1\n");
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 1, sourced: [] });
    writeFileSync(join(home, "from-source"), `${version}\n`);
    expect(await launch(["install"], broken)).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(home, "from-source"))).toBe(false);
  });

  // .ovis/server/source-build, which install.ps1 reads: what the stamp says while the build runs is what a build cut
  // off there (a closed window, a restart) leaves
  const head = Bun.spawnSync(["git", "-C", join(import.meta.dir, ".."), "rev-parse", "HEAD"]).stdout.toString().trim();
  const finished = `${[version, head].filter(Boolean).join(" ")}\n`;
  async function build(exitCode: number, fetchFile?: typeof fetch): Promise<{ code: number; during: string; after: string }> {
    const home = join(scratch, "server");
    let during = "";
    const code = await main(["install"], { home, fetchFile, source: async () => { during = readFileSync(join(home, "source-build"), "utf8"); return exitCode; } });
    return { code, during, after: readFileSync(join(home, "source-build"), "utf8") };
  }

  it("stamps the build finished, with the version and the commit, only after every step returned 0", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    expect(await build(0)).toEqual({ code: 0, during: "started\n", after: finished });
    // a release without ovis-server.json builds and stamps the same
    delete process.env["OVIS_FROM_SOURCE"];
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await build(0, notFound)).toEqual({ code: 0, during: "started\n", after: finished });
  });

  it("stamps the version alone in a folder git says is no repository", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    // git pointed at no repository says so as it does in a folder that is no git checkout
    process.env["GIT_DIR"] = join(scratch, "no-git");
    try {
      expect(await checkoutCommit()).toEqual({ none: "no checkout" });
      expect(await build(0)).toEqual({ code: 0, during: "started\n", after: `${version}\n` });
    } finally {
      delete process.env["GIT_DIR"];
    }
  });

  it("leaves the build unfinished, saying git's words, where git fails at a checkout's top level", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    // git refusing a repository it takes for another user's, as for a folder another account owns (with no config of
    // this PC's that trusts every folder)
    const set = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: join(scratch, "no-config"), GIT_CONFIG_NOSYSTEM: "1" };
    const given = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
    Object.assign(process.env, set);
    try {
      expect(await checkoutCommit()).toEqual({ failed: expect.stringMatching(/^fatal: detected dubious ownership in repository at /), trust: expect.stringContaining("git config --global --add safe.directory ") });
      // regression (main stamped the version alone, which install.ps1 took as built whatever commit the checkout is at)
      expect(await build(0)).toEqual({ code: 0, during: "started\n", after: "started\n" });
    } finally {
      for (const [name, value] of Object.entries(given)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("leaves a build that fails or is cut off unfinished, over an earlier finished one too", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    expect(await build(0)).toMatchObject({ after: finished });
    expect(await build(1)).toEqual({ code: 1, during: "started\n", after: "started\n" });
    // a build step that takes the release's binary drops the stamp with the marker
    delete process.env["OVIS_FROM_SOURCE"];
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["install"], broken)).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(scratch, "server", "source-build"))).toBe(false);
  });

  it("stamps the commit the build started from, and leaves the build unfinished when the checkout moved while it ran", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const home = join(scratch, "server");
    const stamped = async (commits: string[]) => {
      const code = await main(["install"], { home, source: async () => 0, commit: async () => ({ commit: commits.shift()! }) });
      return { code, after: readFileSync(join(home, "source-build"), "utf8") };
    };
    expect(await stamped(["a".repeat(40), "a".repeat(40)])).toEqual({ code: 0, after: `${version} ${"a".repeat(40)}\n` });
    // a pull while bun install ran: the sources built are not the commit's that HEAD now names
    expect(await stamped(["a".repeat(40), "b".repeat(40)])).toEqual({ code: 0, after: "started\n" });
    // git failing after the build, or before it: nothing tells what was built
    for (const answers of [[{ commit: "a".repeat(40) }, { failed: "git exited with 128" }], [{ failed: "git exited with 128" }, { commit: "a".repeat(40) }]] as const) {
      const given = [...answers];
      expect(await main(["install"], { home, source: async () => 0, commit: async () => given.shift()! })).toBe(0);
      expect(readFileSync(join(home, "source-build"), "utf8")).toBe("started\n");
    }
  });

  it("stamps the version alone for a folder that is not a checkout's top level, not the commit of the repository around it", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const around = join(scratch, "around");
    const plugin = join(around, "plugin");
    mkdirSync(plugin, { recursive: true });
    for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"]]) {
      expect(Bun.spawnSync(["git", "-C", around, ...args]).exitCode).toBe(0);
    }
    const aroundCommit = Bun.spawnSync(["git", "-C", around, "rev-parse", "HEAD"]).stdout.toString().trim();
    expect(await checkoutCommit(around)).toEqual({ commit: aroundCommit });
    expect(await checkoutCommit(plugin)).toEqual({ none: "nested" });
    const home = join(scratch, "server");
    expect(await main(["install"], { home, source: async () => 0, commit: () => checkoutCommit(plugin) })).toBe(0);
    expect(readFileSync(join(home, "source-build"), "utf8")).toBe(`${version}\n`);
  });

  it("names, for a folder git distrusts, a command that trusts it, quoted for a path with a space and an apostrophe, and says it on stderr", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const folder = join(scratch, "John Doe's plugin");
    mkdirSync(folder);
    for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"]]) {
      expect(Bun.spawnSync(["git", "-C", folder, ...args]).exitCode).toBe(0);
    }
    const set = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: join(scratch, "global-config"), GIT_CONFIG_NOSYSTEM: "1" };
    const given = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
    Object.assign(process.env, set);
    const said: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    try {
      const answer = await checkoutCommit(folder);
      if (!("failed" in answer) || !answer.trust) throw new Error(`no trust command: ${JSON.stringify(answer)}`);
      // the build in that folder is left unfinished, and the command is said on a line of its own
      const home = join(scratch, "server");
      expect(await main(["install"], { home, source: async () => 0, commit: () => checkoutCommit(folder) })).toBe(0);
      expect(readFileSync(join(home, "source-build"), "utf8")).toBe("started\n");
      expect(said.join("\n").split("\n")).toContain(answer.trust);
      // the command, run as printed in this platform's shell, trusts the folder: git reads its commit then
      const shell = process.platform === "win32" ? ["powershell", "-NoProfile", "-Command", answer.trust] : ["sh", "-c", answer.trust];
      expect(Bun.spawnSync(shell, { env: process.env }).exitCode).toBe(0);
      expect(await checkoutCommit(folder)).toEqual({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
      // git's ownership answer is told by its own first line, not by the words anywhere: a missing folder named so is not it
      expect(await checkoutCommit(join(scratch, "no such dubious ownership folder"))).toEqual({ failed: expect.stringContaining("cannot change to") });
    } finally {
      console.error = error;
      for (const [name, value] of Object.entries(given)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // The release's binary is taken only for sources git ties to it (sourceTrees); nothing else the launcher does needs git.
  // Run in a process of its own, started with a PATH that has no git (Bun looks a program up on the PATH it started with).
  it("runs without git on PATH: builds and runs from source, leaving the build unfinished, and gives no binary to sources it cannot tie", async () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const home = join(scratch, "server");
    const script = `
const { main } = await import(${JSON.stringify(join(import.meta.dir, "plugin-launch.ts"))});
const { sourceTrees } = await import(${JSON.stringify(join(import.meta.dir, "server-manifest.ts"))});
const { readFileSync } = await import("node:fs");
const home = ${JSON.stringify(home)};
const calls = [];
const source = async (command) => { calls.push(command); return 0; };
const install = await main(["install"], { home, source });
const stamp = readFileSync(${JSON.stringify(join(home, "source-build"))}, "utf8");
delete process.env.OVIS_FROM_SOURCE;
const status = await main(["status"], { home, source });
console.log(JSON.stringify({ install, stamp, status, calls, trees: sourceTrees() }));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: bin, OVIS_FROM_SOURCE: "1" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // regression (fails on main): sourceTrees threw ENOENT before any command ran
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ install: 0, stamp: "started\n", status: 0, calls: ["install", "status"], trees: { error: "git is not on PATH, so the binaries cannot be tied to their sources" } });
    expect(err).toContain("git could not read the checkout's commit (git is not on PATH)");
  });

  it("keeps running from source a checkout an older launcher built: a marker and no stamp", async () => {
    const home = join(scratch, "server");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "from-source"), `${version}\n`);
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 7, sourced: [["start"]] });
    expect(existsSync(join(home, "source-build"))).toBe(false);
  });

});

describe("the launcher's child", () => {
  // POSIX signals: on Windows herdr runs scripts/plugin.ps1, and no SIGTERM or SIGHUP reaches a launcher there
  it.skipIf(process.platform === "win32")("gets the SIGTERM sent to the launcher, and the launcher exits as the child did", async () => {
    const ready = join(scratch, "ready");
    const got = join(scratch, "got");
    const script = `const { run } = await import(${JSON.stringify(join(import.meta.dir, "plugin-launch.ts"))});
process.exit(await run(["sh", "-c", 'trap "echo got > ${got}; exit 3" TERM; : > ${ready}; while :; do sleep 0.05; done']));`;
    const launcher = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) { if (Date.now() > deadline) throw new Error("the child never started"); await Bun.sleep(20); }
    launcher.kill("SIGTERM");
    expect(await launcher.exited).toBe(3);
    expect(readFileSync(got, "utf8")).toBe("got\n");
  });
});
