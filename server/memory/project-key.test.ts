import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectKeyOf, remoteKey } from "./project-key.ts";

describe("remoteKey", () => {
  it.each([
    ["git@github.com:devswha/ovis.git", "git:github.com/devswha/ovis"],
    ["https://github.com/devswha/ovis", "git:github.com/devswha/ovis"],
    ["ssh://git@github.com/devswha/ovis.git", "git:github.com/devswha/ovis"],
    ["https://GitHub.com/Devswha/Ovis.git/", "git:github.com/devswha/ovis"],
    ["ssh://git@github.com:22/devswha/ovis.git", "git:github.com/devswha/ovis"],
    ["https://git.example.com:8443/team/app.git", "git:git.example.com:8443/team/app"],
    ["git://example.org/a/b", "git:example.org/a/b"],
  ])("reads %p as %p", (url, key) => {
    expect(remoteKey(url)).toBe(key);
  });

  it("drops the user part, where a token can be, and keeps nothing of it", () => {
    const key = remoteKey("https://x-access-token:ghs_abcdef0123456789@github.com/devswha/ovis.git");
    expect(key).toBe("git:github.com/devswha/ovis");
  });

  it("drops a port only where it is that scheme's default, so two services never share a key", () => {
    expect(remoteKey("ssh://git@git.example/team/app")).toBe("git:git.example/team/app");
    expect(remoteKey("ssh://git@git.example:443/team/app")).toBe("git:git.example:443/team/app");
    expect(remoteKey("https://git.example:22/team/app")).toBe("git:git.example:22/team/app");
  });

  it.each(["/srv/git/app.git", "file:///srv/git/app.git", "../app", "", "https://github.com/", "https://github.com/a/%E0%A4%A", "https://github.com/a b/c"])("has no key for %p", (url) => {
    expect(remoteKey(url)).toBeNull();
  });
});

describe("projectKeyOf", () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-memory-project-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = async (cwd: string, ...args: string[]) => {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(0);
  };

  it("takes origin from the repository's top folder, from a folder inside it too", async () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    await git(repo, "init", "-q");
    await git(repo, "remote", "add", "upstream", "https://github.com/someone/ovis.git");
    await git(repo, "remote", "add", "origin", "git@github.com:devswha/ovis.git");
    expect(await projectKeyOf(join(repo, "src", "deep"))).toBe("git:github.com/devswha/ovis");
  });

  it("takes the only remote when there is no origin, and none when several are not origin", async () => {
    const one = join(root, "one");
    mkdirSync(one);
    await git(one, "init", "-q");
    await git(one, "remote", "add", "fork", "https://github.com/devswha/fork.git");
    expect(await projectKeyOf(one)).toBe("git:github.com/devswha/fork");
    await git(one, "remote", "add", "other", "https://github.com/devswha/other.git");
    expect(await projectKeyOf(one)).toBeNull();
  });

  it("has no project for a folder outside git or one that is not there", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await projectKeyOf(plain)).toBeNull();
    expect(await projectKeyOf(join(root, "missing"))).toBeNull();
  });
});
