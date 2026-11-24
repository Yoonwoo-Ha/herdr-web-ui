import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchOf, repositoryFiles } from "./git-head.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A scratch folder holding `files` (path to text), as git leaves them on disk. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "git-head-"));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("the branch a folder's checkout is on, from git's files", () => {
  it("reads HEAD from the folder or any folder above it", () => {
    const root = tree({ "repo/.git/HEAD": "ref: refs/heads/feature/sidebar\n", "repo/src/deep/keep": "" });
    expect(branchOf(join(root, "repo"))).toBe("feature/sidebar");
    expect(branchOf(join(root, "repo", "src", "deep"))).toBe("feature/sidebar");
  });

  it("follows a linked worktree's .git file to its git folder, relative or absolute", () => {
    const root = tree({ "main/.git/worktrees/wt/HEAD": "ref: refs/heads/topic\n", "wt/.git": "gitdir: ../main/.git/worktrees/wt\n" });
    expect(branchOf(join(root, "wt"))).toBe("topic");
    writeFileSync(join(root, "wt", ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "wt")}\n`);
    expect(branchOf(join(root, "wt"))).toBe("topic");
  });

  it("gives a detached HEAD's commit by its first seven characters", () => {
    expect(branchOf(join(tree({ "repo/.git/HEAD": `${COMMIT}\n` }), "repo"))).toBe("0123456");
  });

  it("is null outside a checkout, for a relative folder, and where git's files make no sense", () => {
    const root = tree({ "plain/keep": "", "odd/.git/HEAD": "nonsense\n", "nohead/.git/config": "", "badlink/.git": "not a gitdir line\n" });
    // the scratch folder sits under the user's temp folder: nothing above it may be a checkout for this case to hold
    expect(branchOf(join(root, "plain"))).toBeNull();
    expect(branchOf("repo")).toBeNull();
    for (const folder of ["odd", "nohead", "badlink"]) expect({ folder, branch: branchOf(join(root, folder)) }).toEqual({ folder, branch: null });
  });

  it("lists a repository and its linked worktrees from git's files, from either checkout, leaving out one whose folder is gone", () => {
    const root = tree({ "repo/.git/HEAD": "ref: refs/heads/main\n", "repo/src/keep": "" });
    const linked = (name: string, branch: string) => {
      const own = join(root, "repo", ".git", "worktrees", name);
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, ".git"), `gitdir: ${own}\n`);
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, "HEAD"), `ref: refs/heads/${branch}\n`);
      writeFileSync(join(own, "gitdir"), `${join(root, name, ".git")}\n`);
      writeFileSync(join(own, "commondir"), "../..\n");
    };
    linked("wt", "feature");
    linked("gone", "old");
    rmSync(join(root, "gone"), { recursive: true });
    const fromMain = repositoryFiles(join(root, "repo", "src"));
    expect(fromMain && { ...fromMain, checkouts: fromMain.checkouts.map(({ path, branch }) => [path, branch]) }).toEqual({
      repo_key: join(root, "repo", ".git"), repo_name: "repo", repo_root: join(root, "repo"), checkout: join(root, "repo"), git_dir: join(root, "repo", ".git"),
      checkouts: [[join(root, "repo"), "main"], [join(root, "wt"), "feature"]],
    });
    const fromLinked = repositoryFiles(join(root, "wt"));
    expect([fromLinked?.repo_key, fromLinked?.checkout, fromLinked?.git_dir]).toEqual([join(root, "repo", ".git"), join(root, "wt"), join(root, "repo", ".git", "worktrees", "wt")]);
    // a bare repository has no checkout of its own to list first
    expect(repositoryFiles(join(tree({ "bare.git/HEAD": "ref: refs/heads/main\n", "bare.git/worktrees/x/commondir": "../..\n", "x/.git": "gitdir: ../bare.git/worktrees/x\n", "bare.git/worktrees/x/HEAD": "ref: refs/heads/x\n" }), "x"))).toBeNull();
  });

  it("reads no HEAD that is not a regular file, so a FIFO in its place cannot hold the screen", async () => {
    const root = tree({ "repo/.git/keep": "" });
    const made = Bun.spawn(["mkfifo", join(root, "repo", ".git", "HEAD")], { env: { PATH: "/usr/bin:/bin" } });
    expect(await made.exited).toBe(0);
    expect(branchOf(join(root, "repo"))).toBeNull();
  });
});
