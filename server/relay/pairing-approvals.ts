import { randomBytes } from "node:crypto";
import type { RelayPairingRequest } from "../../shared/machines.ts";

/** Comparisons waiting on the owner at once; a phone past them is refused (`auth_failed`), so prompts cannot pile up. */
export const MAX_PENDING_APPROVALS = 3;
/** How long after the owner copies a link without a code this PC takes comparisons, as a Bluetooth device in pairing mode. */
export const PAIRING_WINDOW_MS = 10 * 60_000;

/**
 * The phones waiting for the owner to approve them on this PC after both screens showed the same
 * digits (server/relay/session.ts). Held in memory only: a restart drops them with their sessions.
 * Every change goes to the PC's own windows (`relay-pairings` on the machines event stream).
 */
export class RelayPairingApprovals {
  private readonly waiting = new Map<string, { request: RelayPairingRequest; finish: (approved: boolean) => void }>();
  private readonly listeners = new Set<(pairings: RelayPairingRequest[]) => void>();
  private windowUntil = 0;

  /** The owner asked for a link without a code: comparisons are taken for PAIRING_WINDOW_MS from now. */
  openWindow(now = Date.now()): void { this.windowUntil = now + PAIRING_WINDOW_MS; }

  /** Outside the window a comparison is refused before any prompt, so nobody the owner did not invite can raise one. */
  windowOpen(now = Date.now()): boolean { return now < this.windowUntil; }

  list(): RelayPairingRequest[] {
    return [...this.waiting.values()].map(({ request }) => request);
  }

  /** Told the whole list at once, so a window that reconnects drops what was decided meanwhile, then on every change. */
  subscribe(listener: (pairings: RelayPairingRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => { this.listeners.delete(listener); };
  }

  /** Null when MAX_PENDING_APPROVALS are already waiting. `withdraw` ends it unapproved (the phone left, or time ran out). */
  ask(label: string, digits: string, expiresAt: number): { decision: Promise<boolean>; withdraw: () => void } | null {
    if (this.waiting.size >= MAX_PENDING_APPROVALS) return null;
    const id = randomBytes(8).toString("hex");
    const decided = Promise.withResolvers<boolean>();
    const finish = (approved: boolean) => {
      if (!this.waiting.delete(id)) return;
      this.changed();
      decided.resolve(approved);
    };
    this.waiting.set(id, { request: { id, label, digits, expires_at: new Date(expiresAt).toISOString() }, finish });
    this.changed();
    return { decision: decided.promise, withdraw: () => finish(false) };
  }

  /** False for an id that is not waiting: never asked, already decided, withdrawn or expired. */
  decide(id: string, approved: boolean): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    entry.finish(approved);
    return true;
  }

  private changed(): void {
    const pairings = this.list();
    for (const listener of this.listeners) listener(pairings);
  }
}
