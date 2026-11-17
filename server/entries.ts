import { dirname, join } from "node:path";

export const ENTRIES = {
  serve: "server/index.ts",
  managed: "server/managed.ts",
  supervisor: "server/supervisor.ts",
  remote: "server/remote-entry.ts",
  machine: "server/herdr-core/machine-entry.ts",
  plugin: "scripts/plugin.ts",
  askpass: "server/ssh-askpass.ts",
  "windows-launch": "server/windows-launch.ts",
} as const;

export type EntryName = keyof typeof ENTRIES;

/** Whether this process is the compiled binary: its modules then live in Bun's embedded file system. */
export const COMPILED = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(import.meta.path);

export function serverRoot(compiled = COMPILED): string {
  return compiled ? dirname(process.execPath) : join(import.meta.dir, "..");
}
export const ROOT = serverRoot();

export function assetsRoot(env: Record<string, string | undefined> = process.env, root = ROOT): string {
  return env["OVIS_ASSETS"] || root;
}
export const ASSETS = assetsRoot();

/**
 * The environment that makes process.execPath run as Bun itself (`-e`, a script file): the compiled
 * binary is Bun only with BUN_BE_BUN set; from source process.execPath already is Bun.
 */
export const BUN_ENV: Record<string, string> = COMPILED ? { BUN_BE_BUN: "1" } : {};

export function entryCommand(name: EntryName, root = ROOT, compiled = COMPILED): [string, string] {
  return [process.execPath, compiled ? name : join(root, ENTRIES[name])];
}
