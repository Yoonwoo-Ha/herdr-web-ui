/**
 * The screen's read state: `herdr.seen` raised on the terminal a person looks at, through the shared SeenMarker
 * (server/herdr-core/seen-label.ts) on the screen's own line, so every Herdr client (the browser, the phone, the Herdr
 * app) counts that turn as read. Who looks at what is `look` (tui/model/look.ts); this keeps what it needs between two
 * looks: the last look, the turn of each terminal the look has heard of, and whether input came after it heard.
 */
import type { SeenMarker } from "../../server/herdr-core/seen-label.ts";
import { look, type LookState } from "../model/look.ts";

/** The facts of a look the caller gathers; whether input came after the pane's turn is kept here. */
export type LookFacts = Omit<LookState, "inputAfterTurn">;

/** What a person does: a probe's reply, a focus report or an unknown sequence comes from the host terminal alone. */
const BY_A_PERSON: ReadonlySet<string> = new Set(["key", "text", "paste", "mouse"]);

export class SeenWrites {
  private facts: LookFacts | null = null;
  private looked: string | null = null;
  /** input events read so far, and how many had been read when the look heard of each terminal's turn */
  private inputs = 0;
  private readonly turnsAt = new Map<string, number>();
  /** each terminal's turn as the core last told it */
  private readonly told = new Map<string, number>();
  /**
   * Each terminal's turn as the look has heard of it (none: 0), from `turn` and `snapshot`: the turn a write marks, and
   * the one input must come after. Both move together, so a write never marks a turn that input does not vouch for.
   */
  private readonly turns = new Map<string, number>();

  /** `failed` hears a write that did not get through (its line ended): it is not tried again */
  constructor(private readonly marker: Pick<SeenMarker, "mark" | "unread">, private readonly failed: (error: unknown) => void) {}

  get current(): string | null {
    return this.looked;
  }

  /** The core told `terminal`'s turn: in its record, or as a turn of it ended. The look hears of it from `turn` or `snapshot`. */
  observe(terminal: string, turn: number): void {
    this.told.set(terminal, turn);
  }

  /** What the screen shows changed: a look that begins (a new pane, or the same one back in view) writes, even for a turn written before. */
  update(facts: LookFacts): void {
    this.facts = facts;
    this.again();
  }

  /** An input event was read: a key, text, a paste or a click proves a person on a host that never reports focus. */
  input(event: { readonly type: string }): void {
    if (!BY_A_PERSON.has(event.type)) return;
    this.inputs++;
    this.again();
  }

  /** A turn of `terminal` ended: the pane still looked at writes once for it. */
  turn(terminal: string): void {
    this.hear(terminal);
  }

  /**
   * A snapshot of the core came (a new line, or events were missed). A turn it shows that no event told ended with
   * nobody watching: it is heard of now, as a turn that ends now is.
   */
  snapshot(): void {
    for (const terminal of this.told.keys()) this.hear(terminal);
  }

  /** "Mark unread" on `terminal`: its last turn shows as done again, on every client. */
  unread(terminal: string): void {
    this.marker.unread(terminal).catch(this.failed);
  }

  private again(): void {
    const facts = this.facts;
    const now = facts === null ? null : look({ ...facts, inputAfterTurn: facts.pane !== null && this.inputs > (this.turnsAt.get(facts.pane) ?? 0) });
    const begins = now !== null && now !== this.looked;
    this.looked = now;
    if (begins) this.mark(now, true);
  }

  /**
   * The look hears of the turn the core told of `terminal`. A turn it did not know dates the input read so far: none
   * of it proves a person after that turn. The pane still looked at (a host that reports its focus) writes once for it.
   */
  private hear(terminal: string): void {
    const turn = this.told.get(terminal) ?? 0;
    if (turn === (this.turns.get(terminal) ?? 0)) return;
    this.turns.set(terminal, turn);
    this.turnsAt.set(terminal, this.inputs);
    this.again();
    if (this.looked === terminal) this.mark(terminal, false);
  }

  /** The write is for the turn the look has heard of: one that ends before the write runs was not looked at. */
  private mark(terminal: string, again: boolean): void {
    this.marker.mark(terminal, again, this.turns.get(terminal) ?? 0).catch(this.failed);
  }
}
