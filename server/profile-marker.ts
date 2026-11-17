import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "machine-profile.json";
const MARKER_MAX_BYTES = 4096;
/**
 * How the marker is opened: never through a link (a link is not the profile's own file) and never waiting (opening
 * a FIFO for reading would wait for a writer), and never as this process's terminal. Windows has none of these
 * flags, and needs none: no profile runs there, and a FIFO is no file in its folders.
 */
const MARKER_OPEN = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

export function markedByProfile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, MARKER_OPEN);
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > MARKER_MAX_BYTES) return false;
    const bytes = Buffer.alloc(MARKER_MAX_BYTES + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < bytes.length; length += read) read = readSync(fd, bytes, length, bytes.length - length, length);
    if (length > MARKER_MAX_BYTES) return false;
    const marker: unknown = JSON.parse(bytes.toString("utf8", 0, length));
    return typeof marker === "object" && marker !== null && (marker as { profile?: unknown }).profile === "machine";
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && "code" in error) return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class ProfileFolderError extends Error {}

export function profileFolderRefusal(stateDir: string): string | null {
  const marker = join(stateDir, MARKER);
  return markedByProfile(marker) ? `The Ovis state folder ${stateDir} is a machine profile's (${marker}), so no server was started; give this one another OVIS_STATE_DIR.` : null;
}
