import type { HoldState } from "../../../shared/account-devices-api.ts";

/** Milliseconds left of the join hold; null for a hold with no deadline (catching up, frozen, or a join hold not yet published). */
export function holdWaitMs(hold: HoldState | undefined, now: number): number | null {
  if (hold === undefined) return 0;
  if (hold.reason !== "join_hold" || hold.until === null) return null;
  return Math.max(0, Date.parse(hold.until) - now);
}
