/**
 * The system's C library through bun:ffi, for the calls Bun has no API for: the terminal's settings, a signal's
 * disposition, macOS's exec-time environment. The screen and the launcher both open it here.
 */
import { dlopen, type FFIFunction, type Library } from "bun:ffi";

/** The C library's file names, in the order tried: glibc then musl on Linux, libSystem on macOS; none elsewhere. */
function libcNames(platform: NodeJS.Platform, arch: string): readonly string[] {
  if (platform === "linux") return ["libc.so.6", `libc.musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`];
  return platform === "darwin" ? ["libSystem.B.dylib"] : [];
}

/** `symbols` from the first C library of this system that opens, or null where none does (Windows, an unknown system). */
export function openLibc<Fns extends Record<string, FFIFunction>>(symbols: Fns): Library<Fns> | null {
  for (const library of libcNames(process.platform, process.arch)) {
    try {
      return dlopen(library, symbols);
    } catch { /* not this system's C library: the next one */ }
  }
  return null;
}
