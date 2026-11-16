/**
 * The machine profile's mark in a state folder it took empty (`{"profile":"machine"}`, mode 0600,
 * server/machine-profile.ts), and what it means to every other server that comes up on a state folder:
 * the folder is the profile's own, and its list of paired devices is kept by one server only.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "machine-profile.json";
/** The most a marker may hold: the profile's own is a few bytes. */
const MARKER_MAX_BYTES = 4096;

/**
 * Whether `path` is the profile's marker. A file that cannot be read, or holds anything else, is not. It is looked
 * at first without following a link or opening it, so that only a small regular file is read: opening a FIFO would
 * wait for a writer that never comes, a large file would be read whole, and a link is not the profile's own file.
 */
export function markedByProfile(path: string): boolean {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.size > MARKER_MAX_BYTES) return false;
    const marker: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof marker === "object" && marker !== null && (marker as { profile?: unknown }).profile === "machine";
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && "code" in error) return false;
    throw error;
  }
}

/**
 * Why a server other than the profile does not start on `stateDir`, the folder as it will use it, or null: the
 * folder holds the profile's marker. One read of one file, before anything reads, moves or writes the folder.
 */
export function profileFolderRefusal(stateDir: string): string | null {
  const marker = join(stateDir, MARKER);
  return markedByProfile(marker) ? `The Ovis state folder ${stateDir} is a machine profile's (${marker}), so no server was started; give this one another OVIS_STATE_DIR.` : null;
}
