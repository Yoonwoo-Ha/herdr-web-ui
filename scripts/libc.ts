/**
 * The system's C library through bun:ffi, for the terminal calls and macOS exec-time environment Bun has no API for.
 */
import { FFIType } from "bun:ffi";
import { openLibc } from "../tui/host/libc.ts";

/**
 * KERN_PROCARGS2 starts with a native int argc, the executable path and NUL padding. Exactly argc
 * NUL-terminated arguments follow, then the environment up to padding or the apple vector. Current
 * kernels zero the vector's first records. Older kernels can expose `pfz=` and `stack_guard=` right
 * after the last environment entry when no alignment padding is needed.
 */
export function parseProcArgs(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  const argc = bytes.readInt32LE(0);
  const pathEnd = bytes.indexOf(0, 4);
  if (argc < 1 || pathEnd <= 4) return null;
  let at = pathEnd + 1;
  while (bytes[at] === 0) at++;
  for (let i = 0; i < argc; i++) {
    const end = bytes.indexOf(0, at);
    if (end === -1) return null;
    at = end + 1;
  }
  if (at === bytes.length) return "";
  if (bytes[bytes.length - 1] !== 0) return null;
  const guard = bytes.lastIndexOf("\0stack_guard=");
  const apple = guard === -1 ? 0 : bytes.lastIndexOf("\0pfz=0x", guard) + 1;
  const limit = apple >= at ? apple : bytes.length;
  let end = at;
  while (end < limit && bytes[end] !== 0) {
    end = bytes.indexOf(0, end) + 1;
  }
  return bytes.toString("utf8", at, end);
}

/** Read the environment in this process's original exec stack, independently of libc's live environ. */
export function macExecEnv(): string | null {
  try {
    const libc = openLibc({ sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64_fast], returns: FFIType.i32 } });
    if (libc === null) return null;
    try {
      const mib = new Int32Array([1, 49, process.pid]); // CTL_KERN, KERN_PROCARGS2, own pid
      const size = new BigUint64Array(1); // size_t on both macOS architectures
      const { sysctl } = libc.symbols;
      if (sysctl(mib, mib.length, null, size, null, 0) !== 0 || size[0] === undefined || size[0] < 4n) return null;
      const bytes = Buffer.alloc(Number(size[0]));
      if (sysctl(mib, mib.length, bytes, size, null, 0) !== 0 || size[0] === undefined || size[0] > BigInt(bytes.length)) return null;
      return parseProcArgs(bytes.subarray(0, Number(size[0])));
    } finally {
      libc.close();
    }
  } catch {
    return null; // no trustworthy exec-time snapshot
  }
}

let flush: (() => boolean) | null = null;

/**
 * Discards what the terminal on stdin holds unread, with the system's own tcflush: a line typed and not sent sits in
 * the terminal, not in this process, so nothing here can see or drop it otherwise. False where that cannot be done
 * (Windows, a system whose C library is not found, an input that is no terminal).
 */
export function discardTyped(): boolean {
  try {
    if (flush === null) {
      // TCIFLUSH, the input queue: 0 on Linux, 1 on macOS
      const queue = process.platform === "darwin" ? 1 : 0;
      const libc = openLibc({ tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      flush = libc === null ? () => false : () => libc.symbols.tcflush(0, queue) === 0;
    }
    return flush();
  } catch { return false; }
}
