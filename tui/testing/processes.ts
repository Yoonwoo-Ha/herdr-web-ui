import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** List commands, environments and working directories belonging to this run. Never signal a match. */
export function processesWith(marker: string, ...directories: string[]): number[] {
  const inRun = (cwd: string) => directories.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`));
  if (process.platform === "darwin") {
    const env = { LC_ALL: "C", PATH: "/usr/bin:/bin" };
    const snapshot = Bun.spawnSync(["/bin/ps", "-E", "-axww", "-o", "pid=", "-o", "command="], {
      env,
    });
    if (snapshot.exitCode !== 0) throw new Error(`ps failed: ${snapshot.stderr.toString()}`);
    const pids = new Set<number>();
    for (const line of snapshot.stdout.toString().split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match?.[2]?.includes(marker)) pids.add(Number(match[1]));
    }
    // SIP hides system binaries' environments even after exec in an ordinary test shell.
    // Their working directory survives exec and reparenting, even if with-core removed it.
    const cwd = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-u", String(process.getuid!()), "-d", "cwd", "-Fpn"], { env });
    if (cwd.exitCode !== 0) throw new Error(`lsof failed: ${cwd.stderr.toString()}`);
    let pid = 0;
    for (const line of cwd.stdout.toString().split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && inRun(line.slice(1))) pids.add(pid);
    }
    pids.delete(process.pid);
    return [...pids].sort((a, b) => a - b);
  }
  return readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid).flatMap((pid) => {
    try {
      if (inRun(readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ""))) return [Number(pid)];
    } catch { /* the process exited or belongs to another user */ }
    for (const file of ["cmdline", "environ"]) {
      try {
        if (readFileSync(`/proc/${pid}/${file}`, "latin1").includes(marker)) return [Number(pid)];
      } catch { /* the process exited or belongs to another user */ }
    }
    return [];
  });
}
