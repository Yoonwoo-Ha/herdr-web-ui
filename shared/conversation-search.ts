import type { ConversationTurn } from "./protocol.ts";

/**
 * GET /api/pane/conversation/search?pane_id=&q=[&before=&history_id=]: the pane's conversation
 * searched for `q`, newest first, over what the chat shows as messages: what the user wrote and
 * the agent's answers, never a tool's input or output, its thinking or its progress notes. One
 * answer searches a few pages at most; `cursor` goes on from where it stopped.
 */
export interface ConversationSearchResponse {
  /** the history the pages were read from: pass it back with `cursor`, a changed one answers 409 history_changed */
  history_id?: string;
  /** newest first, one per turn */
  matches: ConversationSearchMatch[];
  /** pass as `before` to search the pages before these; null once the conversation's first page was searched */
  cursor: string | null;
}

/** One turn that holds the query, with the words around its first match. */
export interface ConversationSearchMatch {
  /** the turn's identity, as the chat names its rows (conversationTurnAnchor) */
  turn: string;
  role: "user" | "assistant";
  ts: string | null;
  /**
   * the turn's whole searched text, Markdown marks and all, when it was searched, as a digest (textDigest):
   * which of turns that share the name is the one, and whether it changed since. An older server
   * sends none.
   */
  text_digest?: string;
  /** the text before the match, the match and the text after it, each with whitespace runs as one space */
  before: string;
  match: string;
  after: string;
}

/** a query longer than this is refused: no message is found by a paragraph of it */
export const MAX_SEARCH_QUERY = 200;
/** the words a snippet keeps before the match and after it */
const SNIPPET_BEFORE = 32;
const SNIPPET_AFTER = 160;
/** how far from a cut a space may be for the cut word to go with it */
const WORD_CUT = 16;

/**
 * A turn's identity that survives a remount and another page size: row keys are browser slots
 * that a new mount allocates again, so the turn is named by what it is: its role, its time and
 * how its first part begins. Only the beginning counts: a turn still streaming keeps the name it had.
 */
export function conversationTurnAnchor(turn: ConversationTurn): string {
  const first = turn.parts[0];
  const head = first === undefined ? "" : "text" in first ? first.text.slice(0, 80) : JSON.stringify(first).slice(0, 80);
  return `${turn.role}|${turn.ts ?? ""}|${first?.kind ?? ""}|${head}`;
}

/**
 * Text near enough to how the chat draws it: a fence's line, a heading's, a quote's or a list item's
 * mark, a link's address, bold's asterisks and code's backticks are not words anyone looks for.
 */
const plainText = (markdown: string): string => markdown
  .replace(/^ {0,3}(?:```|~~~).*$/gm, "")
  .replace(/^ {0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+/gm, "")
  .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
  .replace(/\*\*|`/g, "");

/**
 * What a search reads of a turn: the user's own words, or the agent's answers as the chat shows
 * them outside a work block (text not marked commentary, lib/workBlocks.ts splitTurn).
 */
export function searchableText(turn: ConversationTurn): string {
  return turn.parts.flatMap((part) => part.kind === "text" && (turn.role === "user" || part.phase !== "commentary") ? [plainText(part.text)] : []).join("\n\n");
}

/**
 * The query as a pattern: its words in order, any whitespace between them, case ignored. Null
 * for a blank one.
 */
export function searchPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return new RegExp(words.map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join("\\s+"), "iu");
}

const squash = (text: string): string => text.replace(/\s+/g, " ");

/**
 * The text parts a search reads (searchableText), as written: marks the search drops still tell two
 * turns apart. A 32-bit FNV-1a hash and its length (two texts can still collide).
 */
function textDigest(turn: ConversationTurn): string {
  const text = turn.parts.flatMap((part) => part.kind === "text" && (turn.role === "user" || part.phase !== "commentary") ? [part.text] : []).join("\n\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

/** Whether `turn` says exactly what the match's turn said when it was searched (false without a digest). */
const saysSearched = (turn: ConversationTurn, match: ConversationSearchMatch): boolean =>
  match.text_digest !== undefined && textDigest(turn) === match.text_digest;

/** The words around the first match in `text`, or null without one. */
export function matchSnippet(text: string, pattern: RegExp): Pick<ConversationSearchMatch, "before" | "match" | "after"> | null {
  const found = pattern.exec(text);
  if (found === null) return null;
  const start = found.index, end = start + found[0].length;
  // whitespace runs shrink once squashed, so a margin wider than what is kept is read; one cut
  // inside a character of two code units leaves no half of it
  const lead = Array.from(squash(text.slice(Math.max(0, start - SNIPPET_BEFORE * 4), start).replace(/^[\uDC00-\uDFFF]/, "")).trimStart());
  const trail = Array.from(squash(text.slice(end, end + SNIPPET_AFTER * 4).replace(/[\uD800-\uDBFF]$/, "")).trimEnd());
  // a cut word goes too, when a space is near the cut (text written without spaces keeps its cut)
  const kept = lead.slice(-SNIPPET_BEFORE).join(""), space = kept.indexOf(" ");
  const before = lead.length > SNIPPET_BEFORE || start > SNIPPET_BEFORE * 4 ? `…${space >= 0 && space < WORD_CUT ? kept.slice(space + 1) : kept}` : lead.join("");
  const shown = trail.slice(0, SNIPPET_AFTER).join(""), last = shown.lastIndexOf(" ");
  const after = trail.length > SNIPPET_AFTER || end + SNIPPET_AFTER * 4 < text.length ? `${last > shown.length - WORD_CUT ? shown.slice(0, last) : shown}…` : trail.join("");
  return { before, match: squash(found[0]), after };
}

/**
 * Whether `turn` may be the one `match` was found in after it changed since the search, so its name
 * (conversationTurnAnchor) changed too: an answer that went on, or whose first tool's output came. It
 * has the match's role and time, goes on from how the searched turn began (its first text grew, or
 * its first tool is the same call up to its output), and still holds the match after the same words
 * (a Markdown mark that streamed in may close: `[deploy` became a link). Two answers of one time
 * (Codex, when the user steers mid-task) can both pass: see pickedTurn.
 */
export function searchedTurnChanged(turn: ConversationTurn, match: ConversationSearchMatch): boolean {
  if (turn.role !== match.role || turn.ts !== match.ts) return false;
  const name = conversationTurnAnchor(turn);
  const prefix = `${turn.role}|${turn.ts ?? ""}|`;
  if (!match.turn.startsWith(prefix)) return false;
  const began = match.turn.slice(prefix.length), now = name.slice(prefix.length);
  const output = began.startsWith("tool|") ? began.indexOf('"output":') : -1;
  if (!now.startsWith(output < 0 ? began : began.slice(0, output))) return false;
  // the matched words find what the query found: the same words, any whitespace, case ignored
  const pattern = searchPattern(match.match);
  const snippet = pattern === null ? null : matchSnippet(searchableText(turn), pattern);
  if (snippet === null || snippet.match !== match.match) return false;
  // a snippet keeps the last words before the match, so a mark gone moves where a long one is cut:
  // then one ends the other
  const words = (before: string): string => before.replace(/^…/, "").replace(/!?\[|[\]*`]/g, "");
  const was = words(match.before), after = words(snippet.before);
  const sameBefore = !match.before.startsWith("…") && !snippet.before.startsWith("…") ? was === after
    : was !== "" && after !== "" && (after.endsWith(was) || was.endsWith(after));
  // and the words after it go on as they did (a turn grows at its end; a snippet's end may be cut)
  const marks = (text: string): string => text.replace(/…$/, "").replace(/!?\[|[\]*`]/g, "");
  const went = marks(match.after), goes = marks(snippet.after);
  return sameBefore && (goes.startsWith(went) || went.startsWith(goes));
}

/**
 * The row a pick opens among the turns shown (null: a row that is no turn): the first with the
 * match's name, as before, unless a turn of its time before it changed into the match; else the one
 * turn changed since (searchedTurnChanged). `several` when an earlier turn changed into the match and
 * a later one has its name (an answer grew and a later answer of its time took its old name), or two
 * changed ones: none is opened, never the wrong one. Turns of its time that share the name (their
 * first 80 characters agree, or their first tool call) go by which still has the matched words
 * anywhere in its text, a progress note's too: an answer's words never leave it, though they can
 * leave the search (Codex marks them commentary later). None when that is not exactly one. Turns
 * without a time (Kimi's prompts) go by name and their whole searched text: the first of the name
 * that still says it, else the one of the name that changed since; by name only for a match of an
 * older server, which has no digest.
 */
export function pickedTurn(turns: readonly (ConversationTurn | null)[], match: ConversationSearchMatch): number | "none" | "several" {
  const names = turns.flatMap((turn, index) => turn != null && conversationTurnAnchor(turn) === match.turn ? [index] : []);
  if (match.ts === null) {
    if (match.text_digest === undefined) return names[0] ?? "none";
    const same = names.find((index) => saysSearched(turns[index]!, match));
    if (same !== undefined) return same;
    const changed = names.filter((index) => searchedTurnChanged(turns[index]!, match));
    return changed.length > 1 ? "several" : changed[0] ?? "none";
  }
  const pattern = searchPattern(match.match);
  const holds = (index: number): boolean => pattern !== null
    && pattern.test(turns[index]!.parts.flatMap((part) => part.kind === "text" ? [plainText(part.text)] : []).join("\n\n"));
  const holding = names.length > 1 ? names.filter(holds) : names;
  if (holding.length > 1 || names.length > 1 && holding.length === 0) return "several";
  const named = holding[0] ?? -1;
  let changed: number | null = null;
  // a turn that grew can lose its old name only to a later turn
  for (let index = 0; index < (named >= 0 ? named : turns.length); index++) {
    const turn = turns[index];
    if (turn == null || !searchedTurnChanged(turn, match)) continue;
    if (changed !== null || named >= 0) return "several";
    changed = index;
  }
  return named >= 0 ? named : changed ?? "none";
}

/**
 * Whether the turns read so far (the conversation's end, earlier pages put before them) settle a
 * pick: one has the match's name, and the turn the search found cannot be on a page not read yet. A
 * turn that changed since loses its name only to a later turn of its time (pickedTurn), so a pick
 * reads on until a turn before the named one is of an earlier time: turns come in time order, but for
 * answers dated by an earlier start (Codex, when the user steers mid-task), which all follow that
 * start. A time that cannot be read tells nothing. That holds only while a turn of the name still
 * says what was searched: a clock that went back (Hermes orders by its own ids) puts a turn of the
 * match's time after an earlier one, so when none does the pick reads to the beginning. Turns
 * without a time go by name and searched text alone (by name for an older server's match).
 */
export function pickSettled(turns: readonly ConversationTurn[], match: ConversationSearchMatch): boolean {
  const named = turns.findIndex((turn) => conversationTurnAnchor(turn) === match.turn);
  if (named < 0) return false;
  if (match.text_digest !== undefined && !turns.some((turn) => conversationTurnAnchor(turn) === match.turn && saysSearched(turn, match))) return false;
  if (match.ts === null) return true;
  const at = Date.parse(match.ts);
  return turns.slice(0, named).some((turn) => turn.ts !== null && Date.parse(turn.ts) < at);
}

/** The turns that hold the pattern, newest first, each with its first match. */
export function searchTurns(turns: readonly ConversationTurn[], pattern: RegExp): ConversationSearchMatch[] {
  const matches: ConversationSearchMatch[] = [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const snippet = matchSnippet(searchableText(turn), pattern);
    if (snippet !== null) matches.push({ turn: conversationTurnAnchor(turn), role: turn.role, ts: turn.ts, text_digest: textDigest(turn), ...snippet });
  }
  return matches;
}
