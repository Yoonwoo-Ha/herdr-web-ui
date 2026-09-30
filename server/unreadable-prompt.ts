import { createHash } from "node:crypto";

import type { UnreadablePrompt, UnreadablePromptAction } from "../shared/protocol.ts";

/**
 * A dialog on screen that no parser in prompt.ts recognizes, while herdr reports the pane
 * blocked: the chat still offers what the screen itself says to press. Two sources, on the
 * screen's last rows only:
 *
 * - a numbered menu above a select/cancel footer (`1. Yes` … `Enter to select · Esc to cancel`),
 *   whatever the agent, as chatmux's terminal shortcuts find it: each option is its number key;
 * - the keys the last rows name (Enter, Esc, Tab, arrows, y/n, Ctrl chords).
 *
 * Only while blocked: a menu answered stays on screen as text, and must not come back as a card.
 * Never a replacement for a parsed card: readPrompt asks for this only when there is none.
 */

const FOOTER_RE = /esc(?:ape)? to (?:cancel|go back|exit|close|dismiss)|enter to (?:select|confirm|continue|submit|choose)|press enter|↑\/↓ to (?:navigate|move|select)/i;
const OPTION_RE = /^\s*[❯›>▶]?\s*(\d)[.)]\s+(\S.*)$/;
/** how far above the footer a menu's options may start */
const OPTION_SCAN_ROWS = 15;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 9;
/** rows the key hints are read from, counted from the bottom */
const HINT_ROWS = 6;
/** rows shown in the card */
const SHOWN_ROWS = 14;
const ROW_CHARS = 200;
const RULE_RE = /^[\s─━═╌▔_-]+$/;

interface KeyHint { re: RegExp; actions: UnreadablePromptAction[] }

/** a key named as one to press: "Enter to select", "press Esc", "(Tab)", not a word in a sentence */
const named = (key: string) => new RegExp(`\\bpress\\s+(?:${key})\\b|\\b(?:${key})\\s+to\\b|[[(<](?:${key})[\\])>]`, "i");

const KEY_HINTS: KeyHint[] = [
  { re: new RegExp(`${named("enter|return").source}|⏎|↵`, "i"), actions: [{ id: "enter", label: "Enter", keys: ["enter"] }] },
  { re: named("esc|escape"), actions: [{ id: "esc", label: "Esc", keys: ["esc"] }] },
  // shift+tab is Claude's mode switch at its idle prompt, never an answer
  { re: new RegExp(`(?<!shift\\s*[+-]\\s*)(?:${named("tab").source})`, "i"), actions: [{ id: "tab", label: "Tab", keys: ["tab"] }] },
  { re: /[↑↓]|\bup\s*\/\s*down\b|\barrow keys?\b/i, actions: [{ id: "up", label: "↑", keys: ["up"] }, { id: "down", label: "↓", keys: ["down"] }] },
  { re: /[←→]|\bleft\s*\/\s*right\b/i, actions: [{ id: "left", label: "←", keys: ["left"] }, { id: "right", label: "→", keys: ["right"] }] },
  { re: /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i, actions: [{ id: "y", label: "y", text: "y" }, { id: "n", label: "n", text: "n" }] },
  { re: named("space"), actions: [{ id: "space", label: "Space", keys: ["space"] }] },
];
const CTRL_RE = /\b(?:ctrl|control)\s*[+-]\s*([a-z])\b|\^([A-Z])\b/gi;

function trimRows(screen: string): string[] {
  const rows = screen.split("\n").map((row) => row.replace(/\r$/, "").trimEnd());
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** The numbered options above the select/cancel footer nearest the bottom, 1..n in order. */
function menuOptions(rows: string[]): { options: UnreadablePromptAction[]; first: number; footer: number } | null {
  let footer = -1;
  for (let index = rows.length - 1; index >= Math.max(0, rows.length - 12); index -= 1) {
    if (FOOTER_RE.test(rows[index]!)) { footer = index; break; }
  }
  if (footer === -1) return null;
  const labels = new Map<number, { label: string; row: number }>();
  for (let index = footer - 1; index >= Math.max(0, footer - OPTION_SCAN_ROWS); index -= 1) {
    const match = rows[index]!.match(OPTION_RE);
    if (!match) continue;
    const number = Number(match[1]);
    // nearest the footer wins: an older menu scrolled above keeps its own numbers
    if (!labels.has(number)) labels.set(number, { label: match[2]!.trim(), row: index });
  }
  const options: UnreadablePromptAction[] = [];
  let first = footer;
  for (let number = 1; number <= MAX_OPTIONS && labels.has(number); number += 1) {
    const { label, row } = labels.get(number)!;
    options.push({ id: `option-${number}`, label: `${number}. ${label}`, text: String(number) });
    first = Math.min(first, row);
  }
  return options.length >= MIN_OPTIONS ? { options, first, footer } : null;
}

/** The keys the last rows name, each once, in a stable order. */
function hintedKeys(rows: string[]): UnreadablePromptAction[] {
  const tail = rows.filter((row) => row.trim() !== "").slice(-HINT_ROWS).join("\n");
  const actions: UnreadablePromptAction[] = [];
  for (const hint of KEY_HINTS) if (hint.re.test(tail)) actions.push(...hint.actions);
  const chords = new Set<string>();
  for (const match of tail.matchAll(CTRL_RE)) chords.add((match[1] ?? match[2]!).toLowerCase());
  for (const letter of [...chords].sort()) actions.push({ id: `ctrl-${letter}`, label: `Ctrl+${letter.toUpperCase()}`, keys: [`ctrl+${letter}`] });
  return actions;
}

export function parseUnreadablePrompt(screen: string, blocked: boolean): UnreadablePrompt | null {
  if (!blocked) return null;
  const rows = trimRows(screen);
  if (rows.length === 0) return null;
  const menu = menuOptions(rows);
  const actions = [...(menu?.options ?? []), ...hintedKeys(rows)];
  if (actions.length === 0) return null;
  // the menu with the block of rows right above it (its question), or the screen's last rows
  let from = 0;
  if (menu) {
    from = menu.first;
    while (from > 0 && rows[from - 1]!.trim() === "") from -= 1;
    for (let taken = 0; from > 0 && rows[from - 1]!.trim() !== "" && taken < 4; taken += 1) from -= 1;
  }
  const to = menu ? menu.footer + 1 : rows.length;
  const lines = rows.slice(from, to)
    .filter((row) => row.trim() !== "" && !RULE_RE.test(row))
    .slice(-SHOWN_ROWS)
    .map((row) => row.length > ROW_CHARS ? `${row.slice(0, ROW_CHARS)}…` : row);
  const id = createHash("sha256").update(JSON.stringify([lines, actions.map((action) => action.id)])).digest("hex").slice(0, 12);
  return { id, lines, actions };
}
