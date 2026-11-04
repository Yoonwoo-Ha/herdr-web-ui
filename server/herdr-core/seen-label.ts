import type { HcConnection } from "./connection.ts";
import { SEEN_LABEL, seenTurnOf } from "./snapshot.ts";

type Hc = Pick<HcConnection, "call">;

/**
 * Tells every Herdr client that a person looked at a terminal's agent (herdr-app docs/labels.md):
 * `herdr.seen` becomes the terminal's turn, so a finish read in Ovis is read in the Herdr app too.
 * Written only to raise it, or where it is missing so a terminal started elsewhere joins, and once
 * per turn: a pane left on screen does not overrule a "mark unread" from another client. One
 * terminal's writes go in order, so an earlier turn never lands after a later one.
 */
export class SeenMarker {
  /** the turn this server last wrote on each terminal */
  private readonly written = new Map<string, number>();
  private readonly turns = new Map<string, Promise<void>>();

  constructor(private readonly hc: Hc) {}

  mark(address: string): Promise<void> {
    const run = (this.turns.get(address) ?? Promise.resolve()).then(() => this.write(address));
    const settled = run.catch(() => {});
    this.turns.set(address, settled);
    void settled.then(() => { if (this.turns.get(address) === settled) this.turns.delete(address); });
    return run;
  }

  private async write(address: string): Promise<void> {
    const record = await this.hc.call("terminal.get", { terminal: address });
    if (record.state !== "live") return;
    const turn = record.turn ?? 0;
    if (turn <= (this.written.get(address) ?? -1)) return;
    const seen = seenTurnOf(record.labels);
    if (seen !== null && seen >= turn) return;
    await this.hc.call("terminal.label", { terminal: address, labels: { [SEEN_LABEL]: String(turn) } });
    this.written.set(address, turn);
  }
}
