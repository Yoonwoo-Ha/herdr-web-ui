import type { HcConnection } from "./connection.ts";
import { SEEN_LABEL, seenTurnOf } from "./snapshot.ts";

type Hc = Pick<HcConnection, "call">;

/**
 * Tells every Herdr client that a person looked at a terminal's agent (herdr-app docs/labels.md):
 * `herdr.seen` becomes the terminal's turn, so a finish read in Ovis is read in the Herdr app too.
 */
export class SeenMarker {
  /**
   * The highest turn each terminal is known to be read at: by a `herdr.seen` any client wrote, as the core told it,
   * or by a write of this marker.
   */
  private readonly read = new Map<string, number>();
  private readonly turns = new Map<string, Promise<void>>();

  constructor(private readonly hc: Hc) {}

  /** The core told a terminal's turn and labels. A label past the turn it comes with reads that turn, no later one. */
  observe(address: string, turn: number, labels: Record<string, string>): void {
    const seen = seenTurnOf(labels);
    if (seen !== null) this.raise(address, Math.min(seen, turn));
  }

  /**
   * `looked`: the turn the person looked at, when the caller knows it. The write runs later (behind another for the same
   * terminal, or a slow answer) and marks that turn and none after it: a turn that ended meanwhile stays unread.
   * It only raises `herdr.seen`: a newer read told meanwhile, by any client, stands.
   */
  mark(address: string, again = false, looked?: number): Promise<void> {
    return this.queue(address, () => this.write(address, again, looked));
  }

  /**
   * "Mark unread", the one write that lowers `herdr.seen`: one below the terminal's turn, so its last turn shows as done
   * again on every client. Nothing at turn 0, nor when the label is already below the turn.
   */
  unread(address: string): Promise<void> {
    return this.queue(address, async () => {
      const record = await this.hc.call("terminal.get", { terminal: address });
      const turn = record.turn ?? 0;
      const seen = seenTurnOf(record.labels);
      if (record.state !== "live" || turn <= 0 || (seen !== null && seen < turn)) return;
      await this.hc.call("terminal.label", { terminal: address, labels: { [SEEN_LABEL]: String(turn - 1) } });
    });
  }

  /** One terminal's writes, in the order they were asked for. */
  private queue(address: string, work: () => Promise<void>): Promise<void> {
    const run = (this.turns.get(address) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    this.turns.set(address, settled);
    void settled.then(() => { if (this.turns.get(address) === settled) this.turns.delete(address); });
    return run;
  }

  private raise(address: string, turn: number): void {
    if (turn > (this.read.get(address) ?? -1)) this.read.set(address, turn);
  }

  private async write(address: string, again: boolean, looked: number | undefined): Promise<void> {
    const asked = this.read.get(address) ?? -1;
    const record = await this.hc.call("terminal.get", { terminal: address });
    if (record.state !== "live") return;
    const turn = Math.min(record.turn ?? 0, looked ?? Infinity);
    const read = this.read.get(address) ?? -1;
    // A read past this turn that the core told of while its answer was on the way is newer than the answer: the label
    // that read left stands, for a look that begins too. What was known before the core was asked is in its answer.
    if (read > asked && read > turn) return;
    if (!again && turn <= read) return;
    const seen = seenTurnOf(record.labels);
    if (seen === null || seen < turn) await this.hc.call("terminal.label", { terminal: address, labels: { [SEEN_LABEL]: String(turn) } });
    this.raise(address, turn);
  }
}
