/**
 * The files an ssh config's Include lines name, read for the SSH tab's list (server/ssh-candidates.ts): only what
 * really is inside the home or ssh folder, within one budget of files, bytes, folder entries and matching work per
 * config. A file or folder is opened first and what was opened is checked, so nothing swapped in on the way after a
 * check stands in for it: Linux names the opened object itself (/proc/self/fd) and lists a folder through its open
 * descriptor (getdents64), a bounded read at a time; elsewhere a file's path is resolved again once open and must
 * still name the same object. Without getdents64 (macOS, Windows, a Linux without glibc) Bun has no descriptor-relative
 * listing, so a wildcard's folders are listed by path, which a swap after the check can redirect. Such a listing only
 * gives names: a name from a folder out of home can be listed (its file is still opened and checked), and a file can be
 * hidden. So every file reached that way comes back marked `unclaimed` (its hosts are listed but claim no Tailscale
 * PC), and the Include also leaves the unread marker after them, whatever the listing found, so no host whose options
 * were still unset there (any host after it) claims one either.
 */
import { constants } from "node:fs";
import { open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

import type { Included } from "./ssh-config.ts";
import { matchComponent, parseComponent, type Token } from "./ssh-include-glob.ts";

/** an ssh config is a few kilobytes; past this it is not read on */
export const MAX_FILE_BYTES = 256 * 1024;
/** files every Include of one config together reads at most */
const MAX_INCLUDED_FILES = 64;
/** bytes every Include of one config together reads at most */
const MAX_INCLUDED_BYTES = 1024 * 1024;
/** folder entries every Include of one config together looks at, matching or not */
const MAX_SCANNED_ENTRIES = 1024;
/** characters every Include of one config together tries a pattern on */
const MAX_MATCH_STEPS = 1_000_000;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const FOLDER_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);

type Budget = { files: number; bytes: number; entries: number; steps: number };
/** a folder's names; "unread" for one left unlisted (out of reach, past the budget, or not listed safely); null for none there */
type Listing = string[] | "unread" | null;

/** a regular file's text when it is at most `cap` bytes, read from the open handle; null for anything else */
async function readHandle(handle: FileHandle, cap: number): Promise<string | null> {
  const found = await handle.stat();
  if (!found.isFile() || found.size > cap) return null;
  const buffer = Buffer.alloc(found.size);
  const { bytesRead } = await handle.read(buffer, 0, found.size, 0);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** A regular file's text when it is at most `cap` bytes; opened without blocking, so a FIFO never holds the list */
export async function readCapped(path: string, cap: number): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, READ_FLAGS);
    return await readHandle(handle, cap);
  } catch { return null; } finally { await handle?.close(); }
}

const inside = (path: string, roots: readonly string[]): boolean => roots.some((root) => {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
});

/** whether the object open at `handle`, opened as `path`, really is inside `roots` */
async function openedInside(handle: FileHandle, path: string, roots: readonly string[]): Promise<boolean> {
  if ((includeTestOnly.platform ?? process.platform) === "linux") return inside(await readlink(`/proc/self/fd/${handle.fd}`), roots);
  const real = await realpath(path);
  const [opened, named] = await Promise.all([handle.stat({ bigint: true }), stat(real, { bigint: true })]);
  return inside(real, roots) && opened.dev === named.dev && opened.ino === named.ino;
}

/** `path` opened, links followed as ssh does, when what was opened is inside `roots`; null when nothing is there */
async function openInside(path: string, roots: readonly string[], flags: number): Promise<FileHandle | "refused" | null> {
  let handle: FileHandle;
  try { handle = await open(path, flags); } catch (error) {
    // only a path that is not there is nothing, as for ssh; one it could not open (EACCES, EMFILE, ELOOP) is unread
    return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? null : "refused";
  }
  if (await openedInside(handle, path, roots).catch(() => false)) return handle;
  await handle.close();
  return "refused";
}

/** getdents64(2): fills `buffer` with a folder's entries from its descriptor and answers the bytes written, or -1 */
type Getdents = (fd: number, buffer: Buffer, length: number) => number | bigint;

/**
 * glibc's getdents64(2), which reads a folder's entries from its descriptor a buffer at a time; null without glibc. It is
 * called synchronously through bun:ffi, so a folder on a stalled network mount (an NFS or SMB home) blocks the server's
 * event loop, every request with it, until the mount answers, while the SSH list is built.
 */
const getdents: Getdents | null = (() => {
  if (process.platform !== "linux") return null;
  try { return dlopen("libc.so.6", { getdents64: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 } }).symbols.getdents64; } catch { return null; }
})();

/** whether a wildcard Include's folders are listed through their descriptor (getdents64); without it, by path, unclaimed */
export const wildcardIncludesRead = getdents !== null;

/** for tests only: getdents64 stood in for (a fake one, or null for a platform without it), and the platform openedInside checks on */
export const includeTestOnly: { getdents?: Getdents | null; platform?: NodeJS.Platform } = {};
const descriptorListing = (): Getdents | null => includeTestOnly.getdents === undefined ? getdents : includeTestOnly.getdents;

/**
 * The names in a folder open at `fd`, each one charged to `budget.entries`; "unread" once it runs out, when getdents64
 * fails, or when what it answers is not well formed (a byte count past the buffer, a record that is empty, runs past
 * the bytes answered, or holds no terminated name)
 */
function entriesOf(fd: number, read: Getdents, budget: Budget): Listing {
  const buffer = Buffer.alloc(32 * 1024);
  const names: string[] = [];
  for (;;) {
    const got = Number(read(fd, buffer, buffer.byteLength));
    if (!Number.isInteger(got) || got < 0 || got > buffer.byteLength) return "unread";
    if (got === 0) return names;
    // struct linux_dirent64: d_ino (8), d_off (8), d_reclen (2), d_type (1), then the name and its NUL
    for (let at = 0; at < got;) {
      if (at + 20 > got) return "unread";
      const length = buffer.readUInt16LE(at + 16);
      const end = buffer.indexOf(0, at + 19);
      if (length < 20 || at + length > got || end <= at + 19 || end >= at + length) return "unread";
      const name = buffer.toString("utf8", at + 19, end);
      // a name whose bytes are not UTF-8 cannot be opened by the name decoded: what that file sets is unknown
      if (!Buffer.from(name).equals(buffer.subarray(at + 19, end))) return "unread";
      at += length;
      // every record counts against the budget, `.` and `..` too
      if (budget.entries-- <= 0) return "unread";
      if (name === "." || name === "..") continue;
      names.push(name);
    }
  }
}

/**
 * The names in folder `dir` when it really is inside `roots`: through its open descriptor where getdents64 is, else by
 * the path its realpath checked, read whole (Bun has no listing that stops early) and then charged to `budget.entries`
 */
async function listInside(dir: string, roots: readonly string[], budget: Budget): Promise<Listing> {
  const read = descriptorListing();
  if (read !== null) {
    const folder = await openInside(dir, roots, FOLDER_FLAGS);
    if (folder === null) return null;
    if (folder === "refused") return "unread";
    try { return entriesOf(folder.fd, read, budget); } finally { await folder.close(); }
  }
  const real = await realpath(dir).catch(() => null);
  if (real === null) return null;
  if (!inside(real, roots)) return "unread";
  // Bun has no listing that stops early: opendir's first read loads the whole folder too, and it ignores a buffer
  // encoding (so a name that is not UTF-8 could not be told apart); readdir is used, and a folder past the budget is unread
  let raw: Buffer[];
  try { raw = await readdir(real, { encoding: "buffer" }); } catch (error) {
    // a match that is a file (`conf.d/*/x`) or gone is nothing, as for ssh; a folder it could not list is unread
    return error instanceof Error && "code" in error && (error.code === "ENOTDIR" || error.code === "ENOENT") ? null : "unread";
  }
  const names = raw.map((bytes) => bytes.toString("utf8"));
  if (names.length > budget.entries || names.some((name, at) => !Buffer.from(name).equals(raw[at]!))) return "unread";
  budget.entries -= names.length;
  return names;
}

/**
 * The files an Include pattern names: relative to `sshDir` as ssh reads the user config, `~` for the home folder. A
 * wildcard is walked one component at a time from the folder before it, each folder listed only when it is inside the
 * home or ssh folder; matches keep the spelling the pattern gives them and glob(3)'s order. A file ssh would read that is
 * left unread (out of those folders, past a budget, behind a pattern not matched exactly here, `~user`, a `%` token or
 * `${VAR}`, not a regular file of at most the size cap) comes back as null, so what it might set stays unknown; a file
 * that is not there is nothing, as for ssh. A file reached through a folder listed by path comes back `unclaimed`.
 */
export function includer(sshDir: string, home: string): (pattern: string) => Promise<Included[]> {
  const roots = Promise.all([sshDir, home].map((root) => realpath(root).catch(() => null)));
  const budget: Budget = { files: MAX_INCLUDED_FILES, bytes: MAX_INCLUDED_BYTES, entries: MAX_SCANNED_ENTRIES, steps: MAX_MATCH_STEPS };
  const escapes = sep === "/";
  return async (pattern) => {
    if (budget.files <= 0 || budget.bytes <= 0) return [null];
    // ssh expands `%` tokens, `${VAR}` and `~user` in an Include, which this offline reading does not
    if (/%|\$\{/.test(pattern) || (pattern.startsWith("~") && !pattern.startsWith("~/") && pattern !== "~")) return [null];
    const allowed = (await roots).filter((root): root is string => root !== null);
    // put together, never normalized: `*/..` and a trailing `/` are glob(3)'s to read, through the folders matched
    const expanded = pattern === "~" || pattern.startsWith("~/") ? `${home}${sep}${pattern.slice(2)}` : isAbsolute(pattern) ? pattern : `${sshDir}${sep}${pattern}`;
    const parts = expanded.split(escapes ? "/" : /[\\/]/).map((part) => part === "" ? { name: "" } : parseComponent(part, escapes));
    if (parts.includes(null)) return [null];
    const components = parts.filter((part): part is { name: string } | { tokens: Token[] } => part !== null);
    const first = components.findIndex((part) => "tokens" in part);
    const literal = (upTo: number) => components.slice(0, upTo).map((part) => "name" in part ? part.name : "").join(sep) || sep;
    // a scan cut short, or a folder left unlisted, may have missed a file sorted before the ones found
    let [scanCut, truncated] = [false, false];
    let paths: string[] = [];
    if (first < 0) paths = [literal(components.length)];
    else {
      let level = [literal(first)];
      for (const component of components.slice(first)) {
        const next: string[] = [];
        for (const dir of level) {
          if ("name" in component) { next.push(`${dir}${sep}${component.name}`); continue; }
          const names = await listInside(dir, allowed, budget);
          if (names === "unread") { scanCut = true; continue; }
          for (const name of names ?? []) {
            const matched = matchComponent(component.tokens, name, budget);
            if (matched === null || (matched && next.length >= budget.files)) { scanCut = true; break; }
            if (matched) next.push(`${dir}${sep}${name}`);
          }
        }
        level = next;
      }
      // ssh reads the files glob(3) returns, sorted by their spelling's bytes (strcmp); a folder among them is no config
      const folders = await Promise.all(level.map((path) => stat(path).then((found) => found.isDirectory(), () => false)));
      paths = level.filter((_, at) => !folders[at]).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    }
    const byPath = first >= 0 && descriptorListing() === null;
    const texts: Included[] = [];
    for (const path of paths) {
      if (budget.files <= 0 || budget.bytes <= 0) { truncated = true; break; }
      const handle = await openInside(path, allowed, READ_FLAGS);
      if (handle === null) continue;
      if (handle === "refused") { texts.push(null); continue; }
      budget.files--;
      try {
        const text = await readHandle(handle, Math.min(MAX_FILE_BYTES, budget.bytes)).catch(() => null);
        if (text !== null) budget.bytes -= Buffer.byteLength(text);
        texts.push(text === null || !byPath ? text : { text, unclaimed: true });
      } finally { await handle.close(); }
    }
    return [...(scanCut ? [null] : []), ...texts, ...(truncated || byPath ? [null] : [])];
  };
}
