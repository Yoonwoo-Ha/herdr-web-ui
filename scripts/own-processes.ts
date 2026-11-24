/**
 * The processes `root` (this process by default) started, at any depth, whose command line matches `pattern`. A test
 * finds and ends what it started this way, never by a name on the whole PC (`pgrep -f`, `pkill -f`): a herdr terminal
 * or pane id names another session's pane too, and the user's own session runs the same commands.
 */
export function ownProcesses(pattern: RegExp, root = process.pid): number[] {
  const table = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (table.exitCode !== 0) throw new Error(`ps failed (${table.exitCode}): ${table.stderr.toString()}`);
  const children = new Map<number, { pid: number; args: string }[]>();
  for (const line of table.stdout.toString().split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (row === null) continue;
    const parent = Number(row[2]);
    children.set(parent, [...children.get(parent) ?? [], { pid: Number(row[1]), args: row[3]!.trim() }]);
  }
  const found: number[] = [];
  for (let level = [root]; level.length > 0;) {
    const below = level.flatMap((pid) => children.get(pid) ?? []);
    found.push(...below.filter(({ args }) => pattern.test(args)).map(({ pid }) => pid));
    level = below.map(({ pid }) => pid);
  }
  return found;
}
