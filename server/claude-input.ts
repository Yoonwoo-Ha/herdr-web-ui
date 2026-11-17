import type { InteractivePrompt } from "../shared/protocol.ts";
import { ANSI_RE, SOLID_RULE_RE, normalizeText, parsedByPublicPrompt } from "./dialogs/shared.ts";
import { claudeRewindPanelBelow } from "./dialogs/claude.ts";
import { paneRead } from "./herdr/client.ts";

export const SUGGESTION_READ_MS = 1_500;

/** Claude's new-session tip in the empty input (`Try "how does <filepath> work?"`), not a suggestion. */
const CLAUDE_TIP_RE = /^Try "/;

/**
 * Claude Code's IDE pill, drawn right after the `❯` while an editor is connected: `[⧉ 3 lines
 * selected] ` or `[⧉ In src/foo.ts] ` (Claude Code 2.1.302 matches it as `\[⧉ [^\]\n]+\]`). It is
 * painted in the theme's IDE color, not dim, yet it is no input: typing and Ctrl+K/Ctrl+U leave it.
 */
const CLAUDE_IDE_PILL_RE = /^[ \u00a0]?\[⧉ [^\]\n]+\] ?/;

const withoutIdePill = (afterPrompt: string): string => afterPrompt.replace(CLAUDE_IDE_PILL_RE, " ");

function idePillChars(afterPrompt: string): number {
  const match = CLAUDE_IDE_PILL_RE.exec(afterPrompt);
  return match === null ? 0 : Array.from(match[0]).length;
}

/** SGR 38/48/58 colors are skipped whole: the 2 of `38;2;r;g;b` is a color mode, not dim. */
function sgrRuns(line: string): [string, boolean, boolean][] {
  const runs: [string, boolean, boolean][] = [];
  let dim = false;
  let inverse = false;
  let offset = 0;
  const escape = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
  for (const match of line.matchAll(escape)) {
    if (match.index! > offset) runs.push([line.slice(offset, match.index), dim, inverse]);
    offset = match.index! + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 38 || code === 48 || code === 58) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
      else if (code === 0) { dim = false; inverse = false; }
      else if (code === 22) dim = false;
      else if (code === 2) dim = true;
      else if (code === 27) inverse = false;
      else if (code === 7) inverse = true;
    }
  }
  if (offset < line.length) runs.push([line.slice(offset), dim, inverse]);
  return runs;
}

/**
 * Claude Code draws its suggested prompt grey in its empty input box: the `❯` line between the
 * screen's last two rules (the live input box, not an earlier one above a bash-mode input), all
 * of it dim but for Claude's own drawn cursor on its first character.
 */
export function parseClaudeSuggestion(ansi: string): string | null {
  const grey = claudeGreyInput(ansi);
  return grey === null || CLAUDE_TIP_RE.test(grey) ? null : grey;
}

function claudeGreyInput(ansi: string): string | null {
  const lines = ansi.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = lines.map((line) => line.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, ""));
  let index = plain.length - 1;
  while (index >= 0 && !SOLID_RULE_RE.test(plain[index]!.trim())) index--;
  index--;
  if (index < 1 || !/^❯[\s\u00a0]/.test(plain[index]!) || !SOLID_RULE_RE.test(plain[index - 1]!.trim())) return null;
  let text = "";
  let seenPrompt = false;
  let cursor = false;
  let pill = idePillChars(plain[index]!.slice(plain[index]!.indexOf("❯") + 1));
  for (const [run, dim, inverse] of sgrRuns(lines[index]!)) {
    for (const character of run) {
      if (!seenPrompt) { if (character === "❯") seenPrompt = true; continue; }
      if (pill > 0) { pill--; continue; }
      const blank = character.trim() === "" || character === "\u00a0";
      // the cursor Claude draws itself sits inverse on the first grey character
      if (!dim && !blank && !(inverse && text.trim() === "" && !cursor)) return null;
      if (!dim && !blank) cursor = true;
      text += character;
    }
  }
  // a cursor over typed text has nothing grey after it
  if (cursor && !sgrRuns(lines[index]!).some(([run, dim]) => dim && run.trim() !== "")) return null;
  const suggestion = text.replace(/\u00a0/g, " ").trim();
  return suggestion === "" ? null : suggestion;
}

/**
 * Claude's named session (`──── my-session ─`), and OmO's own box while it works
 * (`── • Running eval (7s • esc to interrupt) ───`), which herdr reports as Claude.
 */
const BOX_LABELED_RULE_RE = /^─{2,}\s.*─$/;

function claudeInputBox(screen: string): { plain: string[]; raw: string[] } | "clipped" | null {
  const raw = screen.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = raw.map((line) => line.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").trimEnd());
  const rule = (line: string): boolean => SOLID_RULE_RE.test(line.trim()) || BOX_LABELED_RULE_RE.test(line.trim());
  let end = plain.length - 1;
  while (end >= 0 && !rule(plain[end]!)) end--;
  if (end < 0) return null;
  let start = end - 1;
  while (start >= 0 && !rule(plain[start]!)) start--;
  if (start < 0) return "clipped";
  return { plain: plain.slice(start + 1, end), raw: raw.slice(start + 1, end) };
}

const CLAUDE_TIP_ROW_RE = /^Try "[^"]+"$/;

function colorless(ansi: string): boolean {
  for (const match of ansi.matchAll(/\u001b\[([0-9;:]*)m/g)) {
    for (const code of (match[1] || "0").split(/[;:]/).map((value) => Number(value || 0))) {
      if (code === 2 || (code >= 30 && code <= 38) || (code >= 40 && code <= 48) || (code >= 90 && code <= 97) || (code >= 100 && code <= 107)) return false;
    }
  }
  return true;
}

export function claudeInputDraft(live: string, colors: string | null): boolean {
  const box = claudeInputBox(live);
  if (box === null) return false;
  if (box === "clipped" || !box.plain[0]?.startsWith("❯")) return true;
  const afterPill = withoutIdePill(box.plain[0]!.slice(1));
  if ([afterPill, ...box.plain.slice(1)].join("\n").replace(/\u00a0/g, " ").trim() === "") return false;
  if (foldedPlaceholder(box.plain.join("\n"))) return true;
  if (colors === null) return true;
  const shown = claudeInputBox(colors);
  if (shown === null || shown === "clipped" || shown.plain.join("\n") !== box.plain.join("\n")) return true;
  // Under NO_COLOR (#926) the tip is not dim: only its exact form as the box's whole one row, on a
  // screen drawn without any color, tells it from typed words. Typed `Try "…"` reads the same there.
  if (box.plain.length === 1 && CLAUDE_TIP_ROW_RE.test(afterPill.replace(/\u00a0/g, " ").trim()) && colorless(colors)) return false;
  let prompt = false;
  let pill = idePillChars(box.plain[0]!.slice(1));
  let first = true;
  let cursor = false;
  let grey = false;
  for (const row of shown.raw) {
    for (const [run, dim, inverse] of sgrRuns(row)) {
      for (const character of run) {
        if (!prompt) { prompt = character === "❯"; continue; }
        if (pill > 0) { pill--; continue; }
        if (character.trim() === "" || character === "\u00a0") continue;
        if (dim) grey = true;
        // the cursor Claude draws itself sits inverse on the first grey character
        else if (first && inverse) cursor = true;
        else return true;
        first = false;
      }
    }
  }
  // a cursor over a typed character has nothing grey after it
  return cursor && !grey;
}

export function claudeInputEmpty(live: string, colors: string | null): boolean {
  const box = claudeInputBox(live);
  return box !== null && box !== "clipped" && box.plain[0]?.startsWith("❯") === true
    && !claudeInputDraft(live, colors);
}

/** What empties a one-row Claude input box: the row after the cursor, then before it (measured on 2.1.295; Ctrl+Y puts it back). */
export const CLAUDE_CLEAR_INPUT_KEYS = ["ctrl+k", "ctrl+u"];

/** CLAUDE_CLEAR_INPUT_KEYS edit one screen row: a draft on more rows (a long line wraps) is not offered. */
export function claudeClearableDraft(live: string, colors: string | null): string | null {
  if (colors === null || !claudeInputDraft(live, colors)) return null;
  const box = claudeInputBox(live);
  if (box === null || box === "clipped" || box.plain.length !== 1 || !box.plain[0]!.startsWith("❯")) return null;
  if (foldedPlaceholder(box.plain[0]!)) return null;
  const rowText = (row: string): string => row.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  const row = rowText(box.raw[0]!);
  const shown = claudeInputBox(colors);
  if (shown === null || shown === "clipped" || shown.raw.length !== 1 || rowText(shown.raw[0]!) !== row) return null;
  const afterPrompt = row.slice(1);
  const pill = CLAUDE_IDE_PILL_RE.exec(afterPrompt)?.[0];
  const draft = pill === undefined ? afterPrompt.replace(/^[ \u00a0]/, "") : afterPrompt.slice(pill.length);
  return draft.trim() === "" ? null : draft;
}

export const INPUT_BOX_SHOWN_CHARS = 200;

export function claudeInputBoxContent(live: string): string | null {
  const box = claudeInputBox(live);
  if (box === null || box === "clipped") return null;
  return box.plain.map((row) => row.replace(/\u00a0/g, " ").trimEnd()).join("\n").trim();
}

/** Claude Code's placeholder for a paste or an image it folded, whole: `[Pasted text #1 +12 lines]`, `[Pasted text #1]`, `[Image #1]`, `[...Truncated text #1 +40 lines...]`. */
const FOLDED_WHOLE = /\[(?:Pastedtext#\d+(?:\+\d+lines?)?|Image#\d+)\]|\[\.\.\.Truncatedtext#\d+(?:\+\d+lines?)?\.\.\.\]/;
const FOLDED_START = /\[(?:Pastedtext#\d+|Image#\d+|(?:\.\.\.)?Truncatedtext#\d+)/;

/** Claude wraps its box at the pane's width, also inside a placeholder, between words or inside one, any number of times. */
export function foldedPlaceholder(text: string, whole = false): boolean {
  return (whole ? FOLDED_WHOLE : FOLDED_START).test(text.replace(/\s+/g, ""));
}

export function claudeSendAnywayBox(live: string): string | null {
  const content = claudeInputBoxContent(live);
  return content === null || foldedPlaceholder(content, true) ? null : content;
}

/**
 * Claude Code's rewind dialog takes its input box's place in every recorded state; a reply that
 * draws the panel has the box under it.
 */
export function claudeRewindOpen(screen: string): boolean {
  const below = claudeRewindPanelBelow(screen);
  return below !== null && claudeInputBoxContent(below) === null;
}

export function shownInputBox(content: string): string {
  return content.length > INPUT_BOX_SHOWN_CHARS ? `${content.slice(0, INPUT_BOX_SHOWN_CHARS)}…` : content;
}

export function claudeInputBoxText(live: string): string {
  return shownInputBox(claudeInputBoxContent(live) ?? "");
}

/** Claude Code puts the message back in its input box as typed text when the send right before is cancelled. */
export function claudeRestoredDraft(live: string, colors: string | null, sent: string | null): string | null {
  if (sent === null || sent.trim() === "" || colors === null || !claudeInputDraft(live, colors)) return null;
  const box = claudeInputBox(live);
  if (box === null || box === "clipped" || !box.plain[0]?.startsWith("❯")) return null;
  if (foldedPlaceholder(box.plain.join("\n"))) return null;
  const rows = box.plain.map((row, index) => (index === 0 ? withoutIdePill(row.slice(1)) : row).replace(/\u00a0/g, " ").trim());
  // walked row by row over the set of places the sent text can be at, never a regex: one built from
  // the rows backtracks exponentially over a box of blank rows
  const text = sent.replace(/\u00a0/g, " ").trim();
  let at = new Set([0]);
  rows.forEach((row, index) => {
    const next = new Set<number>();
    for (const from of at) {
      // a wrap between words leaves one space or line break before the next row; within a word, none
      const starts = index === 0 ? [from] : /\s/.test(text[from] ?? "") ? [from, from + 1] : [from];
      for (const start of starts) if (text.startsWith(row, start)) next.add(start + row.length);
    }
    at = next;
  });
  return at.has(text.length) ? sent : null;
}

export function viewportShowsLive(scrollBefore: { offset_from_bottom: number } | null, scrollAfter: { offset_from_bottom: number } | null,
  colors: string, before: string, live: string): boolean {
  const atBottom = scrollBefore !== null && scrollAfter !== null
    ? scrollBefore.offset_from_bottom === 0 && scrollAfter.offset_from_bottom === 0
    : scrollBefore === null && scrollAfter === null && screenLines(colors) === screenLines(live);
  return atBottom && live === before;
}

const screenLines = (text: string): string => text.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
  .split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trimEnd();

/**
 * herdr's history ends with the live screen whatever the viewport shows, so only a redraw between
 * the reads can tell them apart: a suggestion accepted with Tab keeps its words and changes only its colors.
 */
export function historyEndShowsLive(colors: string, colorsAfter: string, lives: readonly string[]): boolean {
  return colors === colorsAfter && !colorless(colors) && lives.length > 0 && lives.every((live) => live === lives[0])
    && screenLines(colors) === screenLines(lives[0]!);
}

export function isClaudeHeld(prompt: InteractivePrompt): boolean {
  return parsedByPublicPrompt.get(prompt)?.responder === "claude-held";
}

/**
 * Claude's hint outlasts the message for a moment (sent or cleared in the terminal), over a box
 * that is empty again and shows its tip or a suggested prompt: Enter there sends Claude's
 * suggestion and Ctrl+C asks to leave Claude. herdr gives colors for the viewport alone (an ANSI
 * read of "detection" carries no escapes: measured on 0.9.3), and a viewport scrolled into the
 * history can show an older box.
 */
export async function claudeHeldIsGrey(paneId: string, prompt: InteractivePrompt): Promise<boolean> {
  if (!isClaudeHeld(prompt)) return false;
  const same = (text: string | null): boolean => text !== null && normalizeText(text) === normalizeText(prompt.body ?? "");
  return paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
    .then((read) => same(claudeGreyInput(read.text)), () => false);
}
