/**
 * How the screen ended: `quit` (the detach key: every channel closed, the terminal given back), `gone` (the host hung up
 * or a write failed), `signal` (the host gave the terminal back and ends the process), `no_core` and `incompatible`
 * (before the host was entered), `not_a_terminal`, `crashed` (an unexpected error: the caller restores the terminal
 * first, then writes the crash record).
 */
export type LoopEnd =
  /** `leaveError`: giving the terminal back failed with this code; it is still a quit */
  | { kind: "quit"; leaveError?: string }
  | { kind: "gone"; why: "hangup" | "write-failed" }
  | { kind: "signal" }
  | { kind: "no_core"; code: string }
  | { kind: "incompatible"; code: string; reason: string }
  | { kind: "not_a_terminal" }
  | { kind: "crashed"; error: unknown };
