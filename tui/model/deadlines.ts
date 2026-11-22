/**
 * Named deadlines, each a time in ms on a clock the caller keeps (the loop's injected clock).
 * A value: setting or clearing a name answers a new one and leaves the old as it was, so the
 * model can hold it in its state. It reads no clock and starts no timer; the loop asks for the
 * earliest deadline and arms its one timer for that.
 */
export type Deadlines = ReadonlyMap<string, number>;

// The waits and limits of the screen, each named once here: code elsewhere uses these names, never a
// number of its own. Times are ms on the caller's clock.

/** How long a read that ends in a lone ESC, `ESC [` or `ESC O` waits for the rest before it is Escape, Alt+[ or Alt+O. */
export const ESC_WAIT_MS = 30;
/**
 * The same wait while the host reports the mouse or has the kitty keyboard flag on: a mouse report cut
 * after `ESC [` must not become Alt+[ and text, and with the kitty flag the Escape key is `CSI 27 u` anyway.
 */
export const ESC_WAIT_SLOW_MS = 150;
/** An unfinished longer escape sequence (CSI with parameters, OSC, DCS, APC) is dropped this long after its first byte. */
export const SEQUENCE_DROP_MS = 500;
/** The longest the host's replies to the start probe are awaited; its DA1 reply ends the wait sooner. */
export const REPLY_WAIT_MS = 500;
/** A bracketed paste longer than this many bytes is refused whole. */
export const PASTE_LIMIT_BYTES = 1024 * 1024;
/** The most bytes of one escape sequence kept; a longer one is consumed to its end and reported cut to this. */
export const SEQUENCE_LIMIT_BYTES = 4096;
/** How long the core link waits before it opens a new line after one ended; each attempt that fails doubles it. */
export const RECONNECT_FIRST_MS = 250;
/** The longest the core link waits between two attempts at a new line. */
export const RECONNECT_MOST_MS = 5_000;
/**
 * A line to the core that stayed up this long was healthy: when it ends, the core link's wait starts
 * again at RECONNECT_FIRST_MS. A line that ends sooner keeps doubling it, so a core that breaks its
 * line right after each start is tried every RECONNECT_MOST_MS, not every RECONNECT_FIRST_MS.
 */
export const LINE_STABLE_MS = 5_000;
/** A line to the core that brought no event and no heartbeat (hc sends one every 15 s) for this long is ended, as an EOF ends it. */
export const LINE_SILENCE_MS = 40_000;

/** A drain of stdin ends when no more bytes arrive within this long (probe d: one `readable` wait, repeated). */
export const DRAIN_WAIT_MS = 50;
/** After a signal gave the terminal back, the host ends the process once its end listeners settle, or after this long. */
export const SIGNAL_END_WAIT_MS = 2000;
/** A write the terminal refuses with EAGAIN (a tty another program left non-blocking) is tried again this often... */
export const WRITE_AGAIN_LIMIT = 2000;
/** ...this long apart; past the limit the write fails and the host reports the terminal gone. */
export const WRITE_AGAIN_PAUSE_MS = 1;

export const NO_DEADLINES: Deadlines = new Map();

/** `deadlines` with `name` due at `at`, replacing that name's earlier time if it had one. */
export function setDeadline(deadlines: Deadlines, name: string, at: number): Deadlines {
  return new Map(deadlines).set(name, at);
}

/** `deadlines` without `name`; the same value when that name is not set. */
export function clearDeadline(deadlines: Deadlines, name: string): Deadlines {
  if (!deadlines.has(name)) return deadlines;
  const next = new Map(deadlines);
  next.delete(name);
  return next;
}

/**
 * The deadline due first, or undefined when there is none. Of two due at the same time, the name
 * that sorts first (by code unit) wins, so the answer never depends on the order they were set.
 */
export function earliest(deadlines: Deadlines): { name: string; at: number } | undefined {
  let first: { name: string; at: number } | undefined;
  for (const [name, at] of deadlines) {
    if (!first || at < first.at || (at === first.at && name < first.name)) first = { name, at };
  }
  return first;
}
