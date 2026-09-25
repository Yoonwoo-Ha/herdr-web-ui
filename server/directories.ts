import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { DirectoryListing } from "../shared/protocol.ts";

/** A folder with more subfolders than this lists the first ones and says it stopped. */
export const MAX_DIRECTORY_ENTRIES = 500;

/**
 * The folders inside one directory, for the new-session dialog's folder browser. One
 * directory at a time, names only, nothing kept between calls: the cost is one readdir.
 * `path` takes an absolute path, `~` or `~/…` (the dialog's own syntax); empty means home.
 * Hidden folders (a leading dot) are left out unless asked for. Null when `path` is not
 * a directory this user can read.
 */
export function listDirectories(path: string, hidden = false): DirectoryListing | null {
  const home = homedir();
  const trimmed = path.trim();
  const target = trimmed === "" || trimmed === "~" ? home : trimmed.startsWith("~/") ? resolve(home, trimmed.slice(2)) : resolve(trimmed);
  let entries;
  try {
    if (!statSync(target).isDirectory()) return null;
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    if (!hidden && entry.name.startsWith(".")) continue;
    let isDirectory = entry.isDirectory();
    // a link to a folder is a folder to open (a dangling or looping one is not)
    if (!isDirectory && entry.isSymbolicLink()) {
      try { isDirectory = statSync(join(target, entry.name)).isDirectory(); } catch { isDirectory = false; }
    }
    if (isDirectory) directories.push(entry.name);
  }
  directories.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true }));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: directories.length > MAX_DIRECTORY_ENTRIES,
  };
}
