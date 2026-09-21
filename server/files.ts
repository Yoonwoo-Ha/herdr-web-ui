import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CACHE_MS = 5_000;
const MAX_ENTRIES = 5_000;
const MAX_DEPTH = 6;
const SKIP: Record<string, true> = { ".git": true, node_modules: true, dist: true, target: true, ".venv": true };
const cache = new Map<string, { expires: number; files: string[] }>();

async function gitFiles(cwd: string): Promise<string[] | null> {
  if (!existsSync(join(cwd, ".git"))) return null;
  const proc = Bun.spawn(["git", "-C", cwd, "ls-files", "-co", "--exclude-standard"], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), 3_000);
  try {
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return output.split("\n").filter(Boolean).slice(0, MAX_ENTRIES);
  } finally {
    clearTimeout(timer);
  }
}

function walkFiles(cwd: string): string[] {
  const files: string[] = [];
  let visited = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => Number(left.isDirectory()) - Number(right.isDirectory()) || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) break;
      if (SKIP[entry.name]) continue;
      visited += 1;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) files.push(relative(cwd, path).split(sep).join("/"));
    }
  };
  visit(cwd, 0);
  return files;
}

async function inventory(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && hit.expires > Date.now()) return hit.files;
  const files = (await gitFiles(cwd)) ?? walkFiles(cwd);
  files.sort();
  cache.set(cwd, { expires: Date.now() + CACHE_MS, files });
  return files;
}

function subsequence(path: string, query: string): boolean {
  let index = 0;
  for (const character of path) if (character === query[index]) index += 1;
  return index === query.length;
}

function score(path: string, query: string): number {
  if (!query) return 1;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const at = lower.indexOf(query);
  if (at >= 0) return 300 - at + (name.includes(query) ? 30 : 0);
  if (subsequence(name, query)) return 200 - name.length;
  if (subsequence(lower, query)) return 100 - lower.length / 1000;
  return -1;
}

export async function paneFiles(cwd: string, query = "", limit = 20): Promise<string[]> {
  const normalized = query.trim().toLowerCase();
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 20));
  return (await inventory(cwd))
    .map((path) => ({ path, score: score(path, normalized) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, boundedLimit)
    .map((item) => item.path);
}

export function clearFileCache(): void {
  cache.clear();
}
