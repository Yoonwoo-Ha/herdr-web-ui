import { createHash } from "node:crypto";
import { ANSI_RE, CARD_BODY_MAX, cleanLine, isDivider, type ParsedPrompt } from "./shared.ts";

/**
 * A shell command waiting on the user's approval, as the agent's own record holds it (its session file or
 * database, server/record-cards.ts): the request's id there and the command to the letter. The screen
 * wraps, cuts and redraws a command; the record does not.
 */
export interface RecordRequest {
  readonly id: string;
  readonly command: string;
}

/**
 * How an agent's record names its pending approval: `pending` reads the record (a session file's tail, or its rows);
 * `dialog` is the line the agent's approval dialog starts with on the screen, or absent where the generic card
 * itself is the dialog (gjc's selector, read from its opening border); `wrapMark` is what the agent draws at the
 * end of a row it wrapped a command at; `lead` is what starts the command's first row, where the agent draws one (a
 * shell's `$ `), so no other row is taken for it; `before` and `after` are the dialog's own rows that may stand
 * right above and right under the command, beside a blank or box-drawn row, the `dialog` line, and the dialog's
 * edges; `cut` is a row that says the dialog left part of the command out, where no key may answer it at all.
 */
export interface AgentRecord<Source = string> {
  pending(source: Source): RecordRequest | null;
  readonly dialog?: RegExp;
  readonly wrapMark?: RegExp;
  readonly lead?: RegExp;
  readonly before?: RegExp;
  readonly after?: RegExp;
  readonly cut?: RegExp;
}

type DialogShape = Omit<AgentRecord, "pending">;

/** Box drawing and spaces at a row's ends: the borders, rules and indents a screen draws around a command's rows. */
const EDGES_RE = /^[\s\u2500-\u257f]+|[\s\u2500-\u257f]+$/gu;
const drawnRow = (row: string): string => row.replace(EDGES_RE, "");

/**
 * Where a command's text could go on after one of its rows, read from `from`: the row's characters in order, a tab
 * drawn as one or more of the spaces before the next character. Each (command, row) position is tried once.
 */
function rowEnds(command: string, from: number, row: string): number[] {
  const ends = new Set<number>();
  const seen = new Set<string>();
  const walk = (position: number, at: number): void => {
    const state = `${position}:${at}`;
    if (seen.has(state)) return;
    seen.add(state);
    if (at === row.length) { ends.add(position); return; }
    if (command[position] === row[at]) walk(position + 1, at + 1);
    else if (command[position] === "\t") for (let next = at; next < row.length && row[next] === " "; next += 1) walk(position + 1, next + 1);
  };
  walk(from, 0);
  return [...ends];
}

/** Where the text goes on after a row break: right there (a word cut in two), or past the whitespace it broke at. */
function breakEnds(command: string, at: number): number[] {
  let end = at;
  while (end < command.length && /\s/u.test(command[end]!)) end += 1;
  return end === at ? [at] : [at, end];
}

/**
 * The rows that draw the whole command, after `first` (the row the dialog starts with): each row's characters in the
 * command's order with nothing before or after them but box drawing and indentation (and `lead` on the first, a
 * shell's `$ `), every space as drawn and a tab as a run of spaces, a row break standing for whitespace the screen
 * wrapped at or for none (a word cut in two). The rows around them must be the dialog's own (`bounded`), so a longer
 * command wrapped right at a word is not taken for a shorter one. Null when no rows draw exactly this command: a cut
 * one, a longer one that starts or ends with it, or one with other spacing.
 */
export function commandRows(command: string, rows: readonly string[], bounded: (start: number, end: number) => boolean = () => true,
  first = 0, lead?: RegExp): { start: number; end: number } | null {
  const wanted = command.trim();
  if (wanted === "") return null;
  for (let start = first; start < rows.length; start += 1) {
    const opening = drawnRow(rows[start]!);
    const led = lead === undefined ? opening : opening.replace(lead, "");
    if (led === "" || (lead !== undefined && led === opening)) continue;
    let positions = [0];
    for (let at = start; at < rows.length && positions.length > 0; at += 1) {
      const row = at === start ? led : drawnRow(rows[at]!);
      const ends = [...new Set(positions.flatMap((from) => rowEnds(wanted, from, row)))];
      if (row !== "" && ends.includes(wanted.length) && bounded(start, at)) return { start, end: at };
      positions = [...new Set(ends.flatMap((end) => breakEnds(wanted, end)))];
    }
  }
  return null;
}

/**
 * The rows of the screen's last approval dialog, from its last `dialog` line to the screen's end, as the generic card
 * reads them (cleanLine); the card's own body where the agent draws no such line. Null when the line is not there.
 */
function dialogRows(card: ParsedPrompt, screen: string, { dialog }: DialogShape): string[] | null {
  if (dialog === undefined) return (card.body ?? "").split("\n");
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  let start = lines.length - 1;
  while (start >= 0 && !dialog.test(lines[start]!)) start -= 1;
  return start < 0 ? null : lines.slice(start);
}

/**
 * The card for a dialog the screen shows with the command its record holds: the card's own words, the rows the screen
 * drew the command on replaced by the command to the letter, so what else the dialog says (its stage, the row under
 * its cursor) stays. The id covers the request too, so an answer goes to that request only. Without a request, or a
 * dialog (in the card's body) that does not draw exactly that whole command, the card is the screen's own.
 */
export function withRecord(card: ParsedPrompt, request: RecordRequest | null, screen: string, record: DialogShape): ParsedPrompt {
  const rows = request === null ? null : dialogRows(card, screen, record);
  const unmarked = rows?.map((row) => record.wrapMark ? row.replace(record.wrapMark, "") : row);
  const own = (row: string | undefined, also: RegExp | undefined): boolean =>
    row === undefined || drawnRow(row) === "" || record.dialog?.test(row) === true || also?.test(drawnRow(row)) === true;
  // a card that is the dialog itself (no dialog line) has its command right at its top, under the title `before` names
  const opening = (start: number): boolean => record.dialog !== undefined || start <= (record.before === undefined ? 0 : 1);
  const drawn = request === null || !unmarked ? null
    : commandRows(request.command, unmarked, (start, end) => opening(start) && own(unmarked[start - 1], record.before) && own(unmarked[end + 1], record.after),
      record.dialog === undefined ? 0 : 1, record.lead);
  if (request === null || rows === null || drawn === null) return card;
  const body = keysBody(card, rows) ?? (card.body ?? "").split("\n");
  const shown = rows.slice(drawn.start, drawn.end + 1);
  let at = body.length - shown.length;
  while (at >= 0 && shown.some((row, index) => body[at + index] !== row)) at -= 1;
  if (at < 0) return card;
  const id = createHash("sha256").update(JSON.stringify({ card: card.id, record: request.id, command: request.command })).digest("hex").slice(0, 12);
  const words = [...body.slice(0, at), request.command, ...body.slice(at + shown.length)].join("\n");
  return { ...card, id, body: words.slice(0, CARD_BODY_MAX), record: request };
}

/**
 * Whether the screen's last approval dialog says it left part of its command out (`cut`): a card would ask to run
 * a command no one sees whole, so the terminal answers it.
 */
export function commandCut(screen: string, record: DialogShape): boolean {
  if (record.cut === undefined || record.dialog === undefined) return false;
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  let start = lines.length - 1;
  while (start >= 0 && !record.dialog.test(lines[start]!)) start -= 1;
  return start >= 0 && lines.slice(start + 1).some((line) => record.cut!.test(line));
}

/**
 * The generic keys card's body (the screen's last rows, fallback.ts) reaching back to the dialog's start line, where
 * the dialog is taller than those rows: the dialog's rows shown, its question left out, when the body is their end.
 */
function keysBody(card: ParsedPrompt, rows: readonly string[]): string[] | null {
  if (card.responder !== "fallback-keys" || card.body === null) return null;
  const shown = rows.filter((row) => row !== "" && !isDivider(row));
  const asked = shown.lastIndexOf(card.question);
  const dialog = asked < 0 ? shown : [...shown.slice(0, asked), ...shown.slice(asked + 1)];
  const body = card.body.split("\n");
  return dialog.length > body.length && body.every((row, index) => dialog[dialog.length - body.length + index] === row) ? dialog : null;
}

export const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A record's JSON lines that parse to objects: a first line read from its middle, or a last one half written, does not. */
export function jsonLines(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    try { return [object(JSON.parse(line))].filter((entry) => entry !== null); } catch { return []; }
  });
}

/**
 * The requests a record holds open, in the order they were made: `open` adds one (or replaces one by its id), `close`
 * ends one, and `clear` all, at a turn the user starts: one the agent left open before it (refused, interrupted)
 * never ran and is not asked any more. A record that holds more than one open at a time names no single pending request, so `only` gives none:
 * the screen's dialog could be any of them, and one command can be a part of another's.
 */
export class OpenRequests {
  readonly #open = new Map<string, RecordRequest | null>();
  open(id: string, command: string | null): void {
    this.#open.delete(id);
    this.#open.set(id, command === null ? null : { id, command });
  }
  close(id: unknown): void {
    if (typeof id === "string") this.#open.delete(id);
  }
  clear(): void {
    this.#open.clear();
  }
  only(): RecordRequest | null {
    return this.#open.size === 1 ? [...this.#open.values()][0]! : null;
  }
}

/**
 * The shell call a session file of pi's shape (`{"type":"message","message":{…}}` lines, as gjc and Letta's local
 * backend write them) holds open: an assistant's `toolCall` to a tool named in `tools` with no `toolResult` for its
 * id after it, and no other call open beside it. Calls are issued before they are approved, so this is a pending
 * approval only while the screen shows the dialog for it (withRecord).
 */
export function pendingToolCall(text: string, tools: ReadonlySet<string>): RecordRequest | null {
  const calls = new OpenRequests();
  for (const entry of jsonLines(text)) {
    const message = object(entry.message);
    if (message?.role === "toolResult") calls.close(message.toolCallId);
    if (message?.role === "user") calls.clear();
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content.map(object)) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      const command = object(part.arguments)?.command;
      calls.open(part.id, typeof part.name === "string" && tools.has(part.name) && typeof command === "string" ? command : null);
    }
  }
  return calls.only();
}
