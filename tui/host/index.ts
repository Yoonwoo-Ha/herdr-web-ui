/**
 * The host terminal the screen runs in. Every touch of it goes through one `Host`: entering and
 * leaving (raw mode, the alternate screen, focus reports, bracketed paste, mouse 1002 with 1006,
 * one kitty keyboard entry with flag 1), its size, the bytes typed into it, its resizes, writes, the
 * start probe and a drain of what waits on stdin. What `enter` turns on is turned off again, in
 * reverse order and exactly once, on `leave`, on the process's exit (a thrown error included) and
 * on SIGINT, SIGTERM and SIGHUP. Nothing here knows panes, keys or herdr-core.
 *
 * `unix.ts` is the real host; `tui/testing/headless-host.ts` is the same interface in memory.
 */

export interface HostSize { cols: number; rows: number }

/** truecolor when COLORTERM is `truecolor` or `24bit`, else 256 colours */
export type ColorDepth = "truecolor" | "256";

export type Rgb = readonly [number, number, number];

/** What the host answered to the start probe; null where it said nothing (or nothing parseable). */
export interface ProbeResult {
  /** its DA1 reply ended the probe; false when the time limit did, or nothing was probed */
  answered: boolean;
  /** the kitty keyboard flags in force (1 once our entry took) */
  kittyFlags: number | null;
  /** DECRQM 2026: whether the host knows synchronized output */
  syncOutput: boolean | null;
  foreground: Rgb | null;
  background: Rgb | null;
  cursorColor: Rgb | null;
  /** one cell in pixels (`CSI 16t`) */
  cellPixels: { width: number; height: number } | null;
  /** the DA1 parameters */
  deviceAttributes: number[] | null;
  /** from the background colour (OSC 11) */
  theme: "light" | "dark" | null;
}

/**
 * How the host ended. `gone` (a hang-up, or a write that failed with EIO or EPIPE) is reported once,
 * and nothing is written after it. After a signal the terminal is already given back; the host ends
 * the process (128 + the signal's number) once its end listeners have settled, within
 * SIGNAL_END_WAIT_MS.
 */
export type HostEnd =
  | { kind: "gone"; why: "hangup" | "write-failed" }
  | { kind: "signal"; signal: "SIGINT" | "SIGTERM" };

export interface Host {
  readonly colorDepth: ColorDepth;
  /**
   * Takes the terminal over: true once entered (a second call changes nothing). False, with nothing
   * written or changed, when stdin or stdout is not a terminal or after `leave`.
   */
  enter(): boolean;
  /** Gives the terminal back as it was: every mode undone in reverse order, once. Nothing before `enter`. */
  leave(): void;
  size(): HostSize;
  /** The bytes typed, as read, without the probe's replies. Returns the unsubscribe. */
  onInput(listener: (bytes: Uint8Array) => void): () => void;
  /** After a resize, once the host's modes were sent again. */
  onResize(listener: (size: HostSize) => void): () => void;
  onEnd(listener: (end: HostEnd) => void | Promise<void>): () => void;
  /** One frame, written whole; false (and nothing written) when not entered or gone. */
  write(data: Uint8Array | string): boolean;
  /**
   * Asks the host what it can do (kitty flags, DECRQM 2026, OSC 10, 11 and 12, `CSI 16t`, then DA1
   * as the end). Settles at the DA1 reply or after REPLY_WAIT_MS. The initial replies stay out of
   * `onInput`; once display watching is enabled, later display updates go to the input decoder.
   * The same promise on every call.
   */
  probe(): Promise<ProbeResult>;
  /** Subscribe to terminal color-scheme notifications until leave. */
  watchDisplay(): void;
  /** Ask for the current colors and cell size again after a scheme notification. */
  refreshDisplay(): void;
  /**
   * Reads what already waits on stdin and settles once no more arrives within DRAIN_WAIT_MS (probe d's
   * recipe). What it reads goes to `onInput` as it comes, as any input does. At once when not entered.
   */
  drain(): Promise<void>;
}
