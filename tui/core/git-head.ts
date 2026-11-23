/**
 * The branch of the git checkout a folder is in, for the sidebar's branch row (docs/tui/visual-parity.md S4). The screen
 * starts no process and never asks the Ovis server, so it reads git's own files: `.git` found walking up from the folder
 * as git does (a linked worktree's `.git` is a file naming its git folder), then that folder's `HEAD`. Ahead and behind
 * would need git's object store, so the screen shows the branch alone. Open worktree... lists a repository's checkouts
 * from the same files (`repositoryFiles`).
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Checkout, Repository } from "../../server/herdr-core/worktrees.ts";

/** More than any HEAD or `.git` file git writes: anything larger is not one. */
const MOST_BYTES = 4096;

/** A regular file's text, when it is one and small; null otherwise (a FIFO in its place must never hold the screen). */
function smallFile(path: string): string | null {
  try {
    const found = statSync(path);
    return found.isFile() && found.size <= MOST_BYTES ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** The git folder that `.git` at `dotGit` stands for; undefined when there is no `.git` there, null when it is unreadable. */
function gitFolder(dotGit: string): string | null | undefined {
  let found;
  try {
    found = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (found.isDirectory()) return dotGit;
  const named = /^gitdir: (.+)$/m.exec(smallFile(dotGit) ?? "")?.[1]?.trim();
  return named ? resolve(dirname(dotGit), named) : null;
}

/**
 * The branch checked out in the checkout `folder` is in; a detached HEAD gives its commit's first seven characters.
 * null outside a checkout, for a folder that is not absolute, and when git's files cannot be read.
 */
export function branchOf(folder: string): string | null {
  const found = checkoutOf(folder);
  return found === null || found.git === null ? null : headOf(found.git)?.name ?? null;
}

/** The checkout `folder` is in: its top folder and its own git folder (null: its `.git` cannot be read); null outside one. */
function checkoutOf(folder: string): { top: string; git: string | null } | null {
  if (!isAbsolute(folder)) return null;
  for (let at = resolve(folder); ; at = dirname(at)) {
    const git = gitFolder(join(at, ".git"));
    if (git !== undefined) return { top: at, git };
    if (dirname(at) === at) return null;
  }
}

/** The top folder of the checkout `folder` is in (its nearest `.git` up), as a real path; null outside one. */
export function checkoutTop(folder: string): string | null {
  const found = checkoutOf(folder);
  return found === null ? null : realPath(found.top);
}

/** A git folder's HEAD: the branch's name, or a detached commit's first seven characters; null when it makes no sense. */
function headOf(git: string): { name: string; detached: boolean } | null {
  const head = smallFile(join(git, "HEAD"))?.trim() ?? null;
  if (head === null) return null;
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
  if (branch) return { name: branch, detached: false };
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ? { name: head.slice(0, 7), detached: true } : null;
}

const realPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The repository `folder` is in, with its checkouts, as the Ovis server reads them with git (worktrees.ts
 * `repositoryOf`), from git's files alone: the common git folder (a linked worktree's `commondir`), the repository's own
 * checkout first, then each linked worktree its `worktrees/<name>/gitdir` names (one whose folder is gone is left out).
 * null outside a checkout, in a bare repository, and when git's files cannot be read.
 */
export function repositoryFiles(folder: string): Repository | null {
  const found = checkoutOf(folder);
  if (found === null || found.git === null) return null;
  const linked = smallFile(join(found.git, "commondir"))?.trim();
  const common = linked ? resolve(found.git, linked) : found.git;
  if (basename(common) !== ".git") return null;
  const root = realPath(dirname(common));
  const checkoutAt = (path: string, git: string): Checkout | null => {
    const head = headOf(git);
    return head === null ? null : { path: realPath(path), branch: head.detached ? null : head.name, is_bare: false, is_detached: head.detached, is_prunable: false };
  };
  const checkouts: Checkout[] = [];
  const main = checkoutAt(root, common);
  if (main === null) return null;
  checkouts.push(main);
  let names: string[] = [];
  try {
    names = readdirSync(join(common, "worktrees")).sort();
  } catch {
    // no linked worktree
  }
  for (const name of names) {
    const own = join(common, "worktrees", name);
    const dotGit = smallFile(join(own, "gitdir"))?.trim();
    if (!dotGit || gitFolder(dotGit) === undefined) continue;
    const checkout = checkoutAt(dirname(dotGit), own);
    if (checkout !== null) checkouts.push(checkout);
  }
  return { repo_key: realPath(common), repo_name: basename(root), repo_root: root, checkout: realPath(found.top), git_dir: realPath(found.git), checkouts };
}
