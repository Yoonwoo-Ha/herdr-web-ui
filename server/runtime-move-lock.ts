import { dlopen, FFIType, read } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";

export const moveLockPath = (herdrSocket: string): string => join(dirname(herdrSocket), "runtime-move.sock");

export class MoveLockUnsafe extends Error {}
export const MOVE_LOCK_UNSAFE = "The folder of this herdr session's socket is not yours, anybody may write in it, or something Ovis did not make sits at runtime-move.sock or runtime-move.lock there, so Ovis cannot lock a move. Fix that on this PC, then try again.";

export type MoveLockStep = "stale" | "bound";

export interface MoveLockHandle {
  holds(): Promise<boolean>;
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

type Flock = { flock(fd: number, operation: number): number; errno(): number };
const LOCK_EX = 2, LOCK_NB = 4;
/** "would block": another holder has it (Linux EAGAIN, macOS EWOULDBLOCK) */
const WOULD_BLOCK = process.platform === "darwin" ? 35 : 11;
/** O_CLOEXEC, which node:fs does not name (and Bun 1.4.2 does not add): a program a server starts never holds the lock on */
const CLOEXEC = process.platform === "darwin" ? 0x0100_0000 : 0o2000000;
let flockCalls: Flock | null | undefined;
function flockBinding(): Flock | null {
  if (flockCalls !== undefined) return flockCalls;
  flockCalls = null;
  const libraries = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`];
  const errnoAt = process.platform === "darwin" ? "__error" : "__errno_location";
  for (const library of libraries) {
    try {
      const { symbols } = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }, [errnoAt]: { args: [], returns: FFIType.ptr } });
      const where = symbols[errnoAt] as () => number;
      flockCalls = { flock: symbols.flock as (fd: number, operation: number) => number, errno: () => read.i32(where() as never) };
      break;
    } catch {}
  }
  return flockCalls;
}
interface KernelLock { held(): boolean; release(): void }
function takeKernelLock(path: string): KernelLock | null {
  const calls = flockBinding();
  if (!calls) throw new MoveLockUnsafe("This PC's C library cannot be loaded to lock a move, so Ovis cannot move this herdr session here.");
  // only this user's own regular file, never through a link: anything else there is refused, not an internal error
  let fd: number;
  try { fd = openSync(join(dirname(path), "runtime-move.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | CLOEXEC, 0o600); }
  catch (error) { if (["ELOOP", "EISDIR", "ENOTDIR", "EACCES", "EPERM", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new MoveLockUnsafe(MOVE_LOCK_UNSAFE); throw error; }
  let locked: boolean, errno = 0;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) throw new MoveLockUnsafe(MOVE_LOCK_UNSAFE);
    locked = calls.flock(fd, LOCK_EX | LOCK_NB) === 0;
    if (!locked) errno = calls.errno();
  } catch (error) { closeSync(fd); throw error; }
  if (!locked) {
    closeSync(fd);
    if (errno === WOULD_BLOCK) return null;
    throw new MoveLockUnsafe(`This PC could not lock a move on the folder of this herdr session's socket (error ${errno}): its filesystem may not support locks. Ovis cannot move this session here.`);
  }
  let open = true;
  return { held: () => open, release: () => { if (open) { open = false; closeSync(fd); } } };
}

const listen = (path: string, token: string): Promise<Server | "in_use"> => new Promise((resolve, reject) => {
  const server = createServer((socket) => socket.end(token));
  server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") resolve("in_use"); else reject(error); });
  server.listen(path, () => resolve(server));
});

const ask = (path: string): Promise<string | "none" | null> => new Promise((resolve) => {
  let said = "";
  const socket = connect(path);
  const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 2000);
  socket.on("data", (chunk) => { said += chunk.toString(); });
  socket.on("end", () => { clearTimeout(timer); resolve(said); });
  socket.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "none" : null); });
});

export async function takeMoveLock(asked: string, onStep?: (step: MoveLockStep) => Promise<void> | void): Promise<MoveLockHandle | null> {
  if (process.platform === "win32") throw new MoveLockUnsafe("Moving herdr's session to herdr-core runs on Linux and macOS only.");
  const path = realLockPath(asked);
  const kernel = takeKernelLock(path);
  if (!kernel) return null;
  try {
    const handle = await takeSocketLock(path, onStep, kernel);
    if (!handle) kernel.release();
    return handle;
  } catch (error) { kernel.release(); throw error; }
}

async function takeSocketLock(path: string, onStep: ((step: MoveLockStep) => Promise<void> | void) | undefined, kernel: KernelLock): Promise<MoveLockHandle | null> {
  const token = randomUUID();
  let server = await listen(path, token);
  if (server === "in_use") {
    if (await ask(path) !== "none") return null;
    await onStep?.("stale");
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
  let bound: number | null = null;
  try { bound = lstatSync(path).ino; } catch {}
  const ours = (): boolean => { try { return bound !== null && lstatSync(path).ino === bound; } catch { return false; } };
  const handle: MoveLockHandle = {
    holds: async () => kernel.held() && held.listening && ours() && await ask(path) === token,
    release: () => {
      if (ours()) try { unlinkSync(path); } catch {}
      held.close();
      kernel.release();
    },
  };
  if (await handle.holds()) return handle;
  held.close();
  return null;
}
