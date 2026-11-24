import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** How much of a session file's end is read for the call that waits on the user: it is among its last lines. */
const RECORD_TAIL_BYTES = 1024 * 1024;

/**
 * A session file's last bytes from its first whole line on, or "" for anything but a regular file (a link, a pipe
 * that would block). Read on a file thread (file-tasks.ts `record-tail`), never the server's.
 */
export function recordTail(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "";
    const length = Math.min(stat.size, RECORD_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, stat.size - length);
    const text = bytes.toString("utf8");
    return length < stat.size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}
