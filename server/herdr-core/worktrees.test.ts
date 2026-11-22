import { expect, it } from "bun:test";
import { repositoryOf } from "./worktrees.ts";

it("reads a repository through the git it is given, and names no path from this disk", async () => {
  const asked: string[][] = [];
  const run = async (cwd: string, args: string[]) => {
    asked.push([cwd, ...args]);
    if (args[0] === "rev-parse") return { ok: true, stdout: "/srv/lab/wt\n/srv/lab/.git\n/srv/lab/.git/worktrees/wt\n", stderr: "" };
    return { ok: true, stdout: "worktree /srv/lab\0HEAD abc\0branch refs/heads/main\0\0worktree /srv/lab/wt\0HEAD def\0branch refs/heads/fix\0\0", stderr: "" };
  };
  const repository = await repositoryOf("/srv/lab/wt/src", { run, real: (path) => path });
  expect(repository).toMatchObject({ repo_key: "/srv/lab/.git", repo_name: "lab", repo_root: "/srv/lab", checkout: "/srv/lab/wt", git_dir: "/srv/lab/.git/worktrees/wt" });
  expect(repository.checkouts.map((checkout) => checkout.path)).toEqual(["/srv/lab", "/srv/lab/wt"]);
  expect(asked.every(([cwd]) => cwd === "/srv/lab/wt/src")).toBe(true);
});
