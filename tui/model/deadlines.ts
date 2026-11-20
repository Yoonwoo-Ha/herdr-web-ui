/**
 * Named deadlines, each a time in ms on a clock the caller keeps (the loop's injected clock).
 * A value: setting or clearing a name answers a new one and leaves the old as it was, so the
 * model can hold it in its state. It reads no clock and starts no timer; the loop asks for the
 * earliest deadline and arms its one timer for that.
 */
export type Deadlines = ReadonlyMap<string, number>;

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
