import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";

/**
 * Which Ovis server is moving a herdr session (docs/runtime-move.md, "One move at a time"). The PC's own server and a
 * connection server's bridge can serve the same session, and only one may move it. The lock is the kernel's own: a
 * server listening on a unix socket in that session's folder. A second bind fails while the holder listens, and the
 * kernel frees it when the holder's process dies, so no process id or start time is ever read or trusted.
 */
export const moveLockPath = (herdrSocket: string): string => join(dirname(herdrSocket), "runtime-move.sock");

/** The lock cannot be taken safely here: its folder is not this user's own, anybody may write in it, or something else sits at its name. */
export class MoveLockUnsafe extends Error {}
export const MOVE_LOCK_UNSAFE = "The folder of this herdr session's socket is not yours, anybody may write in it, or a file Ovis did not make sits at runtime-move.sock there, so Ovis cannot lock a move. Fix that on this PC, then try again.";

/** where a take is, for a test that comes in between: its socket bound and listening, not yet read back */
export type MoveLockStep = "bound";

export interface MoveLockHandle {
  /** whether this server still holds it: the socket at its name answers with this holder's own token */
  holds(): Promise<boolean>;
  /** lets go at once: its socket file is removed only while it is still the one this holder bound */
  release(): void;
}

/**
 * The socket where it really is: in the real folder behind any symlinks (a dotfiles `~/.config`, a symlinked `/home`,
 * macOS's `/tmp`), so every server of the session finds the same one whichever path it names. That folder must be a
 * directory of this user's own that not everybody may write in (lstat; a private group's write, from a umask of 002, is
 * fine).
 */
function realLockPath(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const folder = realpathSync(dirname(path));
  const info = lstatSync(folder);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o002) !== 0) throw new MoveLockUnsafe(MOVE_LOCK_UNSAFE);
  return join(folder, basename(path));
}

const listen = (path: string, token: string): Promise<Server | "in_use"> => new Promise((resolve, reject) => {
  // every connection is told this holder's token, then closed: how a server tells whether it is still the holder
  const server = createServer((socket) => socket.end(token));
  server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") resolve("in_use"); else reject(error); });
  server.listen(path, () => resolve(server));
});

/** What answers at the socket: the token its holder tells, "none" when nobody listens there, null when it cannot be told. */
const ask = (path: string): Promise<string | "none" | null> => new Promise((resolve) => {
  let said = "";
  const socket = connect(path);
  const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 2000);
  socket.on("data", (chunk) => { said += chunk.toString(); });
  socket.on("end", () => { clearTimeout(timer); resolve(said); });
  socket.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "none" : null); });
});

/**
 * Takes the session's move lock, or null while another server holds it (or might). A socket file with nobody listening
 * (its holder died) is removed only after a refused connection proves it, and only once; only a socket is ever removed.
 * After binding, the socket is asked who holds it: of two servers that both removed a dead holder's file, the one whose
 * own token answers holds it, and the other gives up its unreachable listener.
 */
export async function takeMoveLock(asked: string, onStep?: (step: MoveLockStep) => Promise<void> | void): Promise<MoveLockHandle | null> {
  if (process.platform === "win32") throw new MoveLockUnsafe("Moving herdr's session to herdr-core runs on Linux and macOS only.");
  const path = realLockPath(asked);
  const token = randomUUID();
  let server = await listen(path, token);
  if (server === "in_use") {
    if (await ask(path) !== "none") return null;
    // nobody listens: its holder died. Only a socket of this user's is removed, never another kind of file
    let info;
    try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (info && (!info.isSocket() || (process.getuid?.() !== undefined && info.uid !== process.getuid!()))) throw new MoveLockUnsafe(MOVE_LOCK_UNSAFE);
    if (info) try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    server = await listen(path, token);
    if (server === "in_use") return null;
  }
  await onStep?.("bound");
  const held: Server = server;
  // the socket file this holder bound: another one at the name since (a racer's) is never removed by it
  let bound: number | null = null;
  try { bound = lstatSync(path).ino; } catch { /* removed meanwhile: it is not this holder's */ }
  const ours = (): boolean => { try { return bound !== null && lstatSync(path).ino === bound; } catch { return false; } };
  const handle: MoveLockHandle = {
    holds: async () => held.listening && ours() && await ask(path) === token,
    release: () => {
      if (ours()) try { unlinkSync(path); } catch { /* gone already */ }
      held.close();
    },
  };
  if (await handle.holds()) return handle;
  // another server's listener answers at the name: this one is unreachable, and gives up
  held.close();
  return null;
}
