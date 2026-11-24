/**
 * The teardown of a test suite that starts processes. Every step is tried, whatever the ones before it did, and what
 * failed is thrown once, after the last: a teardown that stops at its first failure leaves every later process running.
 */
import { stoppedCleanly, type StopReport } from "./test-hc.ts";

/** Runs every step in order; then throws the one failure, or all of them together. */
export async function cleanUpAll(steps: readonly (() => unknown)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} cleanup steps failed`);
}

/** One step for each core: it is stopped, and one that did not stop cleanly is a failure that carries its report. */
export function coreStops(cores: readonly { stop(): Promise<StopReport> }[]): (() => Promise<void>)[] {
  return cores.map((core) => async () => {
    const report = await core.stop();
    if (!stoppedCleanly(report)) throw new Error(`a test core did not stop cleanly: ${JSON.stringify(report)}`);
  });
}
