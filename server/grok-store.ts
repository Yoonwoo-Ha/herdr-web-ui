/** Exact Grok session binding on the machine that owns the pane. */
import { opendirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GROUPS = 4096;
/** Linux appends this to `/proc/<pid>/exe` after the inode is unlinked. */
const DELETED_SUFFIX = " (deleted)";
/** Packaging only. A version such as `grok-1.0.52` keeps its dots. */
const EXECUTABLE_SUFFIXES = [".cjs", ".mjs", ".exe", ".js"];

export interface GrokProcessInfo { foreground_processes?: { pid: number; argv?: string[] | null }[] }
/** Discover native or bun/node-launched Grok using the same names as the exe gate. */
export function grokPaneProcesses(info: GrokProcessInfo): { pid: number }[] {
  return (info.foreground_processes ?? []).filter((p) => {
    const argv = p.argv ?? [];
    return isGrokExecutable(argv[0] ?? "") ||
      (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && isGrokExecutable(argv[1] ?? ""));
  });
}

/** True when this path's file name is Grok: `grok`, or `grok-` plus anything else
 * (`grok-1.0.52-linux-x86_64`, `grok.exe`). The session is the one Herdr reported, when that
 * events.jsonl is open. */
export function isGrokExecutable(exePath: string): boolean {
  const slash = Math.max(exePath.lastIndexOf("/"), exePath.lastIndexOf("\\"));
  let name = slash >= 0 ? exePath.slice(slash + 1) : exePath;
  if (name.endsWith(DELETED_SUFFIX)) name = name.slice(0, -DELETED_SUFFIX.length);
  name = name.toLowerCase();
  for (;;) {
    const suffix = EXECUTABLE_SUFFIXES.find((candidate) => name.endsWith(candidate));
    if (!suffix) break;
    name = name.slice(0, -suffix.length);
  }
  return name === "grok" || name.startsWith("grok-");
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** Search by exact ID, including native hashed cwd groups. Neither cwd nor mtime selects
 * a conversation. Duplicate custom IDs across groups are ambiguous and fail closed. */
export function grokTranscriptPath(home: string, session: string): string | null {
  if (!isAbsolute(home) || !SESSION.test(session)) return null;
  try {
    const store = realpathSync(join(home, "sessions"));
    const groups = opendirSync(store);
    let found: string | null = null;
    let count = 0;
    try {
      for (let group = groups.readSync(); group; group = groups.readSync()) {
        if (++count > MAX_GROUPS) return null;
        if (!group.isDirectory()) continue;
        const candidate = join(store, group.name, session, "updates.jsonl");
        try {
          const path = realpathSync(candidate);
          // Reject a link into another session as well as links outside the store.
          if (path !== candidate || !inside(store, path) || !statSync(path).isFile()) continue;
          if (found !== null) return null;
          found = path;
        } catch { /* no matching file in this group */ }
      }
    } finally { groups.closeSync(); }
    return found;
  } catch { return null; }
}

/** Do not substitute the bridge's home when the pane's environment is unreadable. */
export function grokHomeFromEnvironment(environment: string): string | null {
  const fields = environment.split("\0");
  const explicit = fields.find((field) => field.startsWith("GROK_HOME="))?.slice(10);
  const userHome = fields.find((field) => field.startsWith("HOME="))?.slice(5)
    || fields.find((field) => field.startsWith("USERPROFILE="))?.slice(12);
  const home = explicit || (userHome ? join(userHome, ".grok") : null);
  return home && isAbsolute(home) ? home : null;
}

/** Directories of real events.jsonl files this process holds. Null when that table cannot be
 * trusted: it could not be read, it is too large, or a held events file is deleted, renamed
 * or cannot be resolved as a real file. Only a complete set can confirm Herdr's ID. */
export function grokHeldSessions(pid: number, home: string): Set<string> | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const fds = opendirSync(`/proc/${pid}/fd`);
    const sessions = new Set<string>();
    let count = 0;
    try {
      for (let fd = fds.readSync(); fd; fd = fds.readSync()) {
        if (++count > 4096) return null;
        let target: string;
        // a descriptor closed since the listing is not a held file
        try { target = readlinkSync(`/proc/${pid}/fd/${fd.name}`); } catch { continue; }
        if (!inside(store, target) || !basename(target).startsWith("events.jsonl")) continue;
        const parts = relative(store, target).split(sep);
        if (parts.length !== 3 || !SESSION.test(parts[1]!)) continue;
        // Do not silently drop events.jsonl (deleted) or events.jsonl.old: that could
        // make an older held session look newest after an unreported /resume.
        if (basename(target) !== "events.jsonl" || realpathSync(target) !== target || !statSync(target).isFile()) return null;
        sessions.add(dirname(target));
      }
    } finally { fds.closeSync(); }
    return sessions;
  } catch { return null; }
}

/** Bind Herdr's exact ID only when its unique held directory has the newest events.jsonl.
 * Write times confirm that ID; they never select a different conversation. */
export async function resolveGrokStore(pane: HerdrPane, configuredHome?: string): Promise<string | null> {
  const session = pane.agent_session;
  if (pane.agent !== "grok" || session?.agent !== "grok" || session.kind !== "id" || session.source !== "herdr:grok" || !SESSION.test(session.value)) return null;
  // The held file is read from /proc, so this shortcut is Linux-only. The executable may be
  // any Grok build. Herdr's id chooses the session; an events.jsonl it did not name does not.
  if (process.platform !== "linux") return null;
  try {
    const processes = grokPaneProcesses((await paneProcessInfo(pane.pane_id)) ?? {});
    if (processes.length !== 1) return null;
    const owner = processes[0]!;
    if (!isGrokExecutable(readlinkSync(`/proc/${owner.pid}/exe`))) return null;
    const home = configuredHome ?? grokHomeFromEnvironment(readFileSync(`/proc/${owner.pid}/environ`, "utf8"));
    if (!home) return null;
    const path = grokTranscriptPath(home, session.value);
    if (path === null) return null;
    const held = grokHeldSessions(owner.pid, home);
    const sessionDir = dirname(path);
    if (!held?.has(sessionDir)) return null;
    // A duplicate held ID is ambiguous even if only one directory has updates.jsonl.
    if ([...held].filter((dir) => basename(dir) === session.value).length !== 1) return null;
    const written = statSync(join(sessionDir, "events.jsonl")).mtimeMs;
    for (const dir of held) {
      // Equal timestamps cannot prove which session was written most recently.
      if (dir !== sessionDir && statSync(join(dir, "events.jsonl")).mtimeMs >= written) return null;
    }
    return path;
  } catch { return null; }
}
