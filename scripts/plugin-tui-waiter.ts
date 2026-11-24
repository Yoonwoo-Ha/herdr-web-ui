/** Replace the launcher with a small waiter, without putting the screen's environment in argv. */
import { FFIType, ptr } from "bun:ffi";
import { undoHeld } from "../tui/host/guard.ts";
import { HOLD_BYTES } from "../tui/host/hold.ts";
import { openLibc } from "../tui/host/libc.ts";

export const waiterCommand = (command: readonly string[], hold: string): string[] => [
  "/bin/sh", "-c", [
    'held=$1; modes=$2; watch=$3; shift 3',
    // Ignore, not a handler: macOS's Bash 3.2 can lose a HUP arriving during an INT handler.
    "trap '' INT",
    'saved=$(/bin/stty -g 2>/dev/null)',
    'pid=; pending=',
    `trap 'if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null; else pending=TERM; fi' TERM`,
    `trap 'if [ -n "$pid" ]; then kill -HUP "$pid" 2>/dev/null; else pending=HUP; fi' HUP`,
    'exec 3<&0',
    '{ exec 0<&3 3<&-; exec "$@"; } &',
    'pid=$!',
    'exec 3<&-',
    '[ -z "$pending" ] || kill "-$pending" "$pid" 2>/dev/null',
    'wait "$pid"; status=$?',
    'while kill -0 "$pid" 2>/dev/null; do wait "$pid"; status=$?; done',
    // The screen returns 128 + signal after restoring itself for these three signals.
    'case $status in 129|130|143) ;; *)',
    '  if [ "$status" -gt 128 ]; then',
    '    trap "" TTOU',
    '    [ -z "$saved" ] || /bin/stty "$saved"',
    '    case $(/bin/cat "$held" 2>/dev/null) in',
    `      ${HOLD_BYTES.modes}) printf %s "$modes" ;;`,
    `      ${HOLD_BYTES["modes+watch"]}) printf %s "$watch" ;;`,
    '    esac',
    '  fi ;;',
    'esac',
    'if [ -n "$held" ]; then /bin/rm -f -- "$held"; /bin/rmdir -- "${held%/*}"; fi',
    'exit "$status"',
  ].join("\n"), "ovis-tui", hold, undoHeld("modes"), undoHeld("modes+watch"), ...command,
];

function cStrings(values: readonly string[]) {
  const bytes = values.map((word) => Buffer.from(`${word}\0`));
  const pointers = new BigUint64Array(bytes.length + 1);
  bytes.forEach((word, index) => { pointers[index] = BigInt(ptr(word)); });
  return { bytes, pointers };
}

export function execWaiter(command: readonly string[], options: { readonly env: Record<string, string>; readonly cwd: string }, hold: string): void {
  const libc = openLibc({ execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
  if (libc === null) return;
  const argv = cStrings(waiterCommand(command, hold));
  const envp = cStrings(Object.entries(options.env).map(([name, value]) => `${name}=${value}`));
  const cwd = process.cwd();
  process.chdir(options.cwd);
  libc.symbols.execve(Buffer.from("/bin/sh\0"), argv.pointers, envp.pointers);
  // execve returns only on failure; keep the backing buffers alive across it.
  void [argv.bytes, envp.bytes];
  process.chdir(cwd);
}
