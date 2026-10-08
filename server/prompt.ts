import { createHash, randomBytes } from "node:crypto";

import type { HerdrPane, InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { codexTranscriptPath, paneCodexHome, unansweredCodexQuestions, type QueuedQuestion } from "./codex.ts";
import { HerdrError, paneRead, paneSendKeys, paneSendText, sessionSnapshot } from "./herdr/client.ts";
import { omoTranscriptForPane } from "./omo.ts";
import { OmoAskReader, omoAsksAfter, type OmoAskCall, type OmoAsks } from "./omo-ask.ts";
import { badRequest, errorResponse, jsonResponse } from "./http.ts";

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SELECTED_RE = /^[❯›>]\s*/;
const DIVIDER_RE = /^[\s╭╮╰╯├┤┬┴┼─━═╌▔]+$/;
const OMP_SINGLE_HINT_RE = /enter select.*↑\/↓ move.*esc cancel/i;
const OMP_MULTI_HINT_RE = /space\/enter toggle.*↑\/↓ move.*esc cancel/i;
// the last of several questions submits them all
const CODEX_ASK_HINT_RE = /tab to add notes.*enter to submit (?:answer|all).*esc to interrupt/i;
const CODEX_ASYNC_ASK_HINT_RE = /(?:enter|return).*submit.*(?:ctrl\s*\+\s*\]|skip)/i;
const CODEX_CONTINUE_HINT_RE = /press\s+enter\s+to\s+continue/i;
// Codex 0.156's queue of questions asked with request_user_input_async, above the main
// prompt: collapsed ("? 2 questions · 8s" / "alt+↑ to answer") or open on one question
const CODEX_QUEUE_HEADER_RE = /^(?:•\s*)?Queued follow-up inputs$/;
const CODEX_QUEUE_COUNT_RE = /^\?\s*(\d+)\s+questions?\b/;
const CODEX_QUEUE_POSITION_RE = /^(\d+) of (\d+)$/;
// several questions navigate between tabs: "Tab/Arrow keys to navigate"
const CLAUDE_ASK_HINT_RE = /enter to select.*(?:↑\/↓|tab\/arrow keys) to navigate.*esc to cancel/i;
// question tabs, whole (`←  ☒ Route  ☐ Author  ✔ Submit  →`) or cut off by a narrow pane
const CLAUDE_TABS_RE = /^←\s+[☐☒☑✔]/;
// Claude Code's unnumbered menus (the folder-trust check on a new folder, among others):
// plain rows, `❯` on the selected one, under this hint
const CLAUDE_CONFIRM_HINT_RE = /enter to confirm.*esc to (?:cancel|exit|go back)/i;
/** Claude Code took invisible characters out of a message and holds it in its input (2.1.294) */
const CLAUDE_HELD_HINT_RE = /^Removed (\d+) invisible characters?\s*·\s*review and press \S+ to send$/i;
// Claude Code's `/model` list, by the two keys it takes a pick with: Enter saves it as the default
// for new sessions, `s` keeps it to this session
const CLAUDE_MODEL_HINT_RE = /enter to set as default.*\bs to use this session only.*esc to cancel/i;
// Claude Code's `/effort` slider (2.1.294), the same two keys in other words: Enter saves the level
// as the default for new sessions, `s` keeps it to this session
const CLAUDE_EFFORT_HINT_RE = /←\/→ to adjust\s*·\s*enter to confirm\s*·\s*s for this session only\s*·\s*esc to cancel/i;
// The slider by its keys alone, for the guard that keeps the fallback card and pending input off
// it: a hint cut inside a word, or drawn without `s`, is still a slider whose Enter saves a default
const CLAUDE_EFFORT_GUARD_RE = new RegExp(["←/→ to adjust · Enter to confirm", "Esc to cancel"]
  .map((part) => [...part.replace(/\s+/g, "")].map((char) => char.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")).join(".*"), "i");
// Codex's `/model` lists, by the footer of the row under the cursor (its keymap's own words): a
// row that only opens the next list takes Enter, a row that picks takes `s` for this session and
// Enter to save the pick as the default (`enter apply` on Ultra)
const CODEX_MODEL_OPEN_HINT_RE = /^enter select\s*·\s*esc back$/i;
const CODEX_MODEL_PICK_HINT_RE = /^enter (?:default|apply)\s*·\s*s session\s*·\s*esc back$/i;
const CODEX_MODEL_TITLE_RE = /^(?:Select Model and Effort|Select Reasoning Level for (\S.*)|Advanced Reasoning)$/;
// the row of a model's levels that opens the advanced ones, by the name Codex gives it
const CODEX_MODEL_MORE_ROW_RE = /^More reasoning(?:…|\.{3})$/;
const SOLID_RULE_RE = /^[─━]{8,}$/;
const CODEX_APPROVAL_HEADER_RE =
  /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Trust this folder\?|Enable full access)/i;
const NUMBERED_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;
// OmO's ask_user_question form (omo 5.1): `Ask user · 30m`, a tab per question then Submit, and
// under them the active question or, on the Submit tab, the review of the answers
const OMO_ASK_TITLE_RE = /^Ask user(?:\s+·.*)?$/;
const OMO_OPTIONS_HINT_RE = /^↑↓ move\s+1-9 select\s+space (select|toggle)\s+enter (?:next|toggle)\b.*\besc cancel/;
const OMO_REVIEW_HINT_RE = /^enter (submit|edit answer)\s+↑.*\btab next question\s+esc back/;
const OMO_TYPING_HINT_RE = /^enter save and next\s+↑↓ back to options\b.*\besc discard/;
const OMO_OWN_ANSWER = "Type your own answer...";
/** the lines a narrow pane wraps the form's key hint onto, at most */
const OMO_HINT_LINES = 5;
/** lines of OmO's footer under the form's rule, at most: cwd and context, then model (one may wrap) */
const OMO_FOOTER_LINES = 3;
/** where each of the form's hints ends, however a narrow pane wraps it */
const OMO_HINT_END_RE = /\besc (?:cancel|back|discard)$/;
/** never a line of OmO's footer: an input box (`>`, `❯`) or a shell's prompt */
const OMO_NOT_FOOTER_RE = /^[>❯›➜λ$%#]|[$%#>❯›λ]$/;
// OmO's widget over its input box for a question that does not wait for its answer (omo 5.1.19)
const OMO_PENDING_STATUS_RE = /^\?\s+(?:Question pending \((\d+) unanswered\)|\d+ questions pending)(?:\s+·.*)?$/;
const OMO_PENDING_HINT_RE = /^enter(?: or \S+)? to answer · \/answer · or just type your reply\b/;
/** OmO's apparently empty input box; never sufficient evidence for sending text into it. */
const OMO_EMPTY_BOX_RE = /^[❯›>]$/;

const KEY = {
  up: "up",
  down: "down",
  enter: "enter",
  escape: "esc",
  space: "space",
  tab: "tab",
  right: "right",
  left: "left",
  backtab: "shift+tab",
  backspace: "backspace",
  // opens Codex's queue on its first question, and closes it back to the main prompt
  // (herdr's own alt+arrow bindings apply to the keyboard, not to keys sent to the pane)
  openQueue: "alt+up",
  closeQueue: "alt+down",
} as const;

type Responder =
  | "codex-question"
  | "codex-async-question"
  | "codex-queued-question"
  | "omp-question"
  | "claude-question"
  | "claude-submit"
  | "codex-menu"
  | "codex-approval"
  | "omp-approval"
  | "claude-approval"
  | "claude-plan"
  | "claude-confirm"
  | "claude-held"
  | "claude-model"
  | "claude-effort"
  | "codex-model"
  | "omo-question"
  | "omo-review"
  | "omo-typing"
  | "omo-pending"
  | "pi-question"
  | "pi-confirm"
  | "pi-input"
  | "pi-model"
  | "fallback-menu"
  | "fallback-gjc-menu"
  | "fallback-keys";

type ParsedPrompt = InteractivePrompt & {
  responder: Responder;
  /** Stable question identity across the folded widget and the expanded form. */
  omoQuestion?: { call: string; index: number };
  menuLabels: string[];
  selectedIndex: number;
  checkedOptionIndices: number[];
  customMenuIndex: number | null;
  rejectWithEscapeIndex: number | null;
  /** each option's own steps, for a card whose options are not rows of a menu */
  optionSteps?: AnswerStep[][];
  /** the steps for a typed answer, for a card whose menu does not take one the usual way */
  customSteps?: (text: string) => AnswerStep[];
  /** the steps for a multiple choice, for a card whose menu does not toggle the usual way */
  multiSteps?: (choices: number[]) => AnswerStep[];
  /** the key the menu itself names for the row under the cursor now, for a card whose rows do not all take the same one */
  rowKey?: AnswerStep | null;
};

/** `pick`: the menu's own key for the row the moves end on, read off the screen once the cursor is there (`rowKey`) */
type AnswerStep = { keys?: string[]; text?: string; pick?: true };
type MenuRow = { label: string; selected: boolean; checked: boolean; description?: string; lineIndex: number };
type NumberedRow = MenuRow & { number: number };

const parsedByPublicPrompt = new WeakMap<InteractivePrompt, ParsedPrompt>();

function cleanLine(rawLine: string): string {
  let line = rawLine.replace(ANSI_RE, "").trim();
  if (line.startsWith("│")) line = line.slice(1).trimStart();
  if (line.endsWith("│")) line = line.slice(0, -1).trimEnd();
  return line.trim();
}

function isDivider(line: string): boolean {
  const value = cleanLine(line);
  return Boolean(value) && DIVIDER_RE.test(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findLastIndex(lines: string[], predicate: (line: string, index: number) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index]!, index)) return index;
  }
  return -1;
}

/**
 * A line and the two after it, as one: a narrow pane wraps a hint line
 * (`Enter to select · ↑/↓ to navigate · Esc to` / `cancel`), so hints are matched
 * across the wrap. The last line a window matches from is where the hint begins.
 */
function wrapped(lines: string[], index: number, span = 3): string {
  return lines.slice(index, index + span).map(cleanLine).filter((line) => line && !isDivider(line)).join(" ");
}

function nearestQuestion(lines: string[], beforeIndex: number): string | null {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 14); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!line || isDivider(line) || /^Planning:/i.test(line) || /^[←→].*Submit/i.test(line)
      || /^[☐☑✔]\s+\S/.test(line) || /^Question \d+\/\d+/i.test(line)) continue;
    return line.replace(/^\(\d+\s+selected\)\s*/i, "").trim();
  }
  return null;
}

function parseBorderMenu(lines: string[], startDivider: number, endDivider: number): MenuRow[] {
  const rows: MenuRow[] = [];
  for (let index = startDivider + 1; index < endDivider; index += 1) {
    let text = cleanLine(lines[index]!);
    if (!text || isDivider(text)) continue;
    const selected = SELECTED_RE.test(text);
    text = text.replace(SELECTED_RE, "").trim();
    const checked = /^[☑☒✓]/.test(text);
    text = text.replace(/^[○●◉◯☐☑☒✓]\s*/, "").trim();
    if (text) rows.push({ label: normalizeText(text), selected, checked, lineIndex: index });
  }
  return rows;
}

function findMenuDividers(lines: string[], hintIndex: number): [number, number] | null {
  let end = -1;
  for (let index = hintIndex - 1; index >= 0; index -= 1) {
    if (!isDivider(lines[index]!)) continue;
    if (end < 0) end = index;
    else return [index, end];
  }
  return null;
}

function parseNumberedRows(lines: string[], start: number, end: number): NumberedRow[] {
  const rows: NumberedRow[] = [];
  for (let index = start; index < end; index += 1) {
    const match = lines[index]!.replace(ANSI_RE, "").trim().match(NUMBERED_OPTION_RE);
    if (!match) continue;
    let label = match[3]!.trim();
    const checked = /^\[[xX✓]\]/.test(label);
    label = label.replace(/^\[[ xX✓]\]\s*/, "").trim();
    rows.push({ number: Number.parseInt(match[2]!, 10), label, selected: Boolean(match[1]), checked, lineIndex: index });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const nextLineIndex = rows[index + 1]?.lineIndex ?? end;
    // a description a narrow pane wraps goes on to the next blank line or rule
    const description: string[] = [];
    for (let lineIndex = row.lineIndex + 1; lineIndex < nextLineIndex; lineIndex += 1) {
      const line = cleanLine(lines[lineIndex]!);
      if (line && !isDivider(line)) description.push(line);
      else if (description.length > 0) break;
    }
    if (description.length > 0) row.description = normalizeText(description.join(" "));
  }
  return rows;
}

/**
 * A menu's rows among numbered lines read from well above it: the last run that counts up from 1,
 * among the lines numbered in the column of the row the cursor is on. What is above a menu can hold
 * a numbered line of its own, such as a message sent before ("❯ 1. …", "› 1. …") still on screen;
 * a numbered line in an option's description is indented further.
 */
function menuRows(lines: string[], start: number, end: number): NumberedRow[] {
  const rows = parseNumberedRows(lines, start, end);
  const column = (row: NumberedRow): number => lines[row.lineIndex]!.replace(ANSI_RE, "").search(/\d/);
  // the cursor's row is the menu's (a sent message after the same mark lines up with it); without one, the last row
  const anchor = [...rows].reverse().find((row) => row.selected) ?? rows.at(-1);
  const menu = anchor === undefined ? rows : rows.filter((row) => column(row) === column(anchor));
  return menu.slice(Math.max(0, menu.map((row) => row.number).lastIndexOf(1)));
}

function sequentialRows(rows: NumberedRow[]): boolean {
  return rows.length > 0 && rows.every((row, index) => row.number === index + 1);
}

function finishPrompt(
  agent: string,
  input: Omit<InteractivePrompt, "id" | "agent">,
  internal: Omit<ParsedPrompt, keyof InteractivePrompt>,
  /** fields as the id reads them, where that is not as the card shows them (a fallback card's ticking working line) */
  hashed: Partial<Pick<InteractivePrompt, "question" | "body">> & { call?: string } = {},
): ParsedPrompt {
  const id = createHash("sha256")
    .update(JSON.stringify({ agent, ...input, ...hashed }))
    .digest("hex")
    .slice(0, 12);
  // Hash all approval details before applying the display cap. Cursor movement
  // is excluded, but a different command, plan or option description is stale.
  return { id, agent, ...input, body: input.body?.slice(0, 12_000) ?? null, ...internal };
}

function publicPrompt(parsed: ParsedPrompt): InteractivePrompt {
  const prompt: InteractivePrompt = {
    id: parsed.id,
    agent: parsed.agent,
    kind: parsed.kind,
    title: parsed.title,
    question: parsed.question,
    body: parsed.body,
    options: parsed.options,
    multi_select: parsed.multi_select,
    custom_option_index: parsed.custom_option_index,
    ...(parsed.queued ? { queued: parsed.queued } : {}),
    ...(parsed.steps ? { steps: parsed.steps } : {}),
    ...(parsed.fallback ? { fallback: true as const } : {}),
  };
  parsedByPublicPrompt.set(prompt, parsed);
  return prompt;
}

function parseOmpQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMP_SINGLE_HINT_RE.test(wrapped(lines, index)) || OMP_MULTI_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const dividers = findMenuDividers(lines, hintIndex);
  if (!dividers) return null;
  const [startDivider, endDivider] = dividers;
  const rows = parseBorderMenu(lines, startDivider, endDivider);
  const selectedIndex = rows.findIndex((row) => row.selected);
  const customIndex = rows.findIndex((row) => /^Other \(type your own\)$/i.test(row.label));
  const optionRows = rows.filter((_, index) => index !== customIndex);
  const multiSelect = OMP_MULTI_HINT_RE.test(cleanLine(lines[hintIndex]!));
  const question = nearestQuestion(lines, startDivider);
  if (!question || selectedIndex < 0 || optionRows.length === 0 || customIndex < 0) return null;
  return finishPrompt("omp", {
    kind: "question", title: multiSelect ? "Multiple choice" : "Question", question, body: null,
    options: optionRows.map((row) => ({ label: row.label.replace(/ \(Recommended\)$/i, ""), description: null })),
    multi_select: multiSelect, custom_option_index: multiSelect ? null : optionRows.length,
  }, {
    responder: "omp-question", menuLabels: rows.map((row) => row.label), selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex, rejectWithEscapeIndex: null,
  });
}

function parseCodexContinueMenu(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_CONTINUE_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 64), hintIndex);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const body = lines.slice(Math.max(0, rows[0]!.lineIndex - 16), rows[0]!.lineIndex)
    .map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  return finishPrompt("codex", {
    kind: "menu", title: "Codex", question: "Choose how to continue", body: body || null,
    options: rows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "codex-menu", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

function parseCodexQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 48), hintIndex);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^None of the above\b/i.test(row.label));
  if (customIndex !== rows.length - 1 || customIndex < 1) return null;
  const question = nearestQuestion(lines, rows[0]!.lineIndex);
  if (!question) return null;
  const options = rows.slice(0, customIndex).map((row) => {
    const [label, ...description] = row.label.split(/\s{2,}/);
    return { label: label!, description: description.length ? description.join(" ") : null };
  });
  const progress = lines.slice(Math.max(0, rows[0]!.lineIndex - 6), rows[0]!.lineIndex)
    .map(cleanLine).map((line) => line.match(/^Question (\d+)\/(\d+)/)).find(Boolean);
  const title = progress && progress[2] !== "1" ? `Question ${progress[1]} of ${progress[2]}` : "Question";
  return finishPrompt("codex", {
    kind: "question", title, question, body: null, options,
    multi_select: false, custom_option_index: options.length,
  }, {
    responder: "codex-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: customIndex,
    rejectWithEscapeIndex: null,
  });
}

/**
 * A question from Codex's queue, open: under the queue header, an optional "1 of 2", the
 * question (wrapped over as many lines as the pane needs), then its options and a last
 * row that takes a typed answer ("Other", or what was typed there). A free-form question
 * has no options, only that answer line ("Type your answer").
 */
function parseCodexAsyncQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ASYNC_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const header = findLastIndex(lines.slice(Math.max(0, hintIndex - 48), hintIndex), (line) => CODEX_QUEUE_HEADER_RE.test(cleanLine(line)));
  const top = header < 0 ? Math.max(0, hintIndex - 48) : Math.max(0, hintIndex - 48) + header + 1;
  // without the header the rows are read from well above: a message sent before can be there too
  const rows = menuRows(lines, top, hintIndex);
  const text = (from: number, to: number) => lines.slice(from, to).map(cleanLine).filter((line) => line && !isDivider(line));
  let position: RegExpMatchArray | null = null;
  const questionLines = (to: number): string[] => {
    const found = text(top, to);
    position = found[0]?.match(CODEX_QUEUE_POSITION_RE) ?? null;
    return position ? found.slice(1) : found;
  };
  let question: string | null;
  let options: InteractivePrompt["options"];
  let menuLabels: string[];
  let selectedIndex: number;
  if (rows.length === 0) {
    // free form: the answer line sits right above the hint
    if (header < 0) return null;
    const answerLine = findLastIndex(lines.slice(0, hintIndex), (line) => Boolean(cleanLine(line)) && !isDivider(line));
    if (answerLine < top) return null;
    question = normalizeText(questionLines(answerLine).join(" ")) || null;
    options = [];
    menuLabels = [];
    selectedIndex = 0;
  } else {
    if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
    // an old layout without the header must still end in its "Other" row
    if (header < 0 && !/^Other\b/i.test(rows.at(-1)!.label)) return null;
    // a wrapped option continues on the lines under it: these rows carry no descriptions
    const labels = rows.map((row, index) => normalizeText([row.label, ...text(row.lineIndex + 1, rows[index + 1]?.lineIndex ?? hintIndex)].join(" ")));
    question = header < 0 ? nearestQuestion(lines, rows[0]!.lineIndex) : normalizeText(questionLines(rows[0]!.lineIndex).join(" ")) || null;
    options = labels.slice(0, -1).map((label) => ({ label, description: null }));
    menuLabels = labels;
    selectedIndex = rows.findIndex((row) => row.selected);
  }
  if (!question) return null;
  const at = position as RegExpMatchArray | null;
  return finishPrompt("codex", {
    kind: "question", title: at ? `Question ${at[1]} of ${at[2]}` : "Question", question, body: null,
    // Codex keeps working while it asks: the card answers it, never a message typed in the chat
    options, multi_select: false, custom_option_index: options.length, queued: "open",
  }, {
    responder: "codex-async-question", menuLabels, selectedIndex, checkedOptionIndices: [],
    customMenuIndex: menuLabels.length === 0 ? 0 : menuLabels.length - 1, rejectWithEscapeIndex: null,
  });
}

/**
 * How many questions wait in Codex's collapsed queue at the bottom of the screen, with the
 * main prompt right under it; 0 otherwise. The card (codexQueuedPrompt) and the send path
 * (codexQuestionsCollapsed) both read this count, so they cannot disagree.
 * - A message of the user's own waiting to be submitted replaces the questions' block
 *   (alt+↑ then opens nothing, checked on Codex 0.156.1): no count then.
 * - An open question (its "enter submit … skip" hint) or an approval under the queue holds the
 *   input itself: no count either.
 */
function queuedQuestionCount(screen: string): number {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  const header = findLastIndex(lines, (line) => CODEX_QUEUE_HEADER_RE.test(line));
  // the queue sits right above the main prompt and its status line
  if (header < 0 || lines.length - header > 16) return 0;
  if (lines.slice(header).some((line) => /^↳\s/.test(line) || /Messages to be submitted/i.test(line) || CODEX_ASYNC_ASK_HINT_RE.test(line))) return 0;
  const at = lines.findIndex((line, index) => index > header && index <= header + 7 && CODEX_QUEUE_COUNT_RE.test(line));
  // (the main prompt, not a numbered menu row the parser did not recognise)
  if (at < 0 || !/\bto answer$/i.test(lines[at + 1] ?? "") || !/^›\s(?!\d+\.)/.test(lines[at + 2] ?? "")) return 0;
  return Number(lines[at]!.match(CODEX_QUEUE_COUNT_RE)![1]);
}

/** The question a pane's queue opened on, as it showed there, when that was not the card's. */
export interface QueueFront { question: string; options: string[] }

/**
 * The collapsed queue shows only a count: the card takes its first question from the
 * rollout, the newest `count` unanswered ones (a skipped question leaves no record).
 */
function queuedPrompt(count: number, unanswered: QueuedQuestion[], front: QueueFront | null = null): ParsedPrompt | null {
  const waiting = unanswered.slice(-count);
  // the question the queue opened on last time, when that was not the newest guess: by its
  // title and its options, the newest such one (an older skipped one may share the title)
  const first = (front !== null ? [...unanswered].reverse().find((question) => sameText(front.question, question.title)
    && question.options.length === front.options.length && question.options.every((option, index) => sameText(front.options[index]!, option))) : undefined)
    ?? waiting[0];
  if (!first || waiting.length !== count || !first.title.trim()) return null;
  return finishPrompt("codex", {
    kind: "question", title: count > 1 ? `Question 1 of ${count}` : "Question", question: normalizeText(first.title), body: null,
    options: first.options.map((label) => ({ label, description: null })),
    multi_select: false, custom_option_index: first.options.length, queued: "collapsed",
  }, {
    responder: "codex-queued-question", menuLabels: first.options.length ? [...first.options, "Other"] : [],
    selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: first.options.length, rejectWithEscapeIndex: null,
  });
}

/**
 * A question whose options carry a preview (AskUserQuestion's `preview`): the selected option's
 * preview is drawn in a box to the right of the options, "Notes: press n to add notes" under it,
 * with no "Type something" row and an unnumbered "Chat about this" (Claude Code 2.1.288).
 * The box and the notes line are cut off each line, leaving the options as in the plain form.
 * The box stands in one column on every line (its top corner names it), so only what sits in
 * that column goes: a `│` inside an option's own text stays.
 */
const CLAUDE_PREVIEW_HINT_RE = /\bn to add notes\b/i;
const PREVIEW_EDGE = "┌│└├╭╰┐┘╮╯";
/** where the terminal column `column` begins in `line`: a wide character takes two columns and a joined
 * emoji is one grapheme of two, so the index may be smaller; -1 when no grapheme starts there */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function indexAtColumn(line: string, column: number): number {
  let width = 0;
  for (const { segment, index } of GRAPHEMES.segment(line)) {
    if (width === column) return index;
    width += Bun.stringWidth(segment);
  }
  return width === column ? line.length : -1;
}
function withoutPreview(lines: string[], from: number, to: number): string[] {
  let column = -1;
  for (let index = from; index <= to && column < 0; index += 1) {
    const line = lines[index] ?? "";
    const corner = /\s{2,}[┌╭]/.exec(line);
    if (corner !== null) column = Bun.stringWidth(line.slice(0, corner.index + corner[0].length - 1));
  }
  return lines.map((line) => {
    const at = column >= 2 ? indexAtColumn(line, column) : -1;
    const edge = at >= 0 ? line[at] : undefined;
    const boxed = edge !== undefined && PREVIEW_EDGE.includes(edge) && line.slice(Math.max(0, at - 2), at) === "  ";
    // only the preview's own notes line goes: a question may begin with "Notes:" too
    return (boxed ? line.slice(0, at).trimEnd() : line).replace(/^\s*Notes:\s+press n to add notes\b.*$/i, "");
  });
}

function parseClaudeQuestion(screen: string): ParsedPrompt | null {
  const raw = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(raw, (_, index) => CLAUDE_ASK_HINT_RE.test(wrapped(raw, index)));
  if (hintIndex < 0) return null;
  const preview = CLAUDE_PREVIEW_HINT_RE.test(wrapped(raw, hintIndex));
  const lines = preview ? withoutPreview(raw, Math.max(0, hintIndex - 64), hintIndex) : raw;
  // with a preview the options end at the rule above "Chat about this": nothing under it is theirs
  const end = preview ? findLastIndex(lines.slice(0, hintIndex), (line) => isDivider(line)) : hintIndex;
  const rows = menuRows(lines, Math.max(0, hintIndex - 64), end);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const chatIndex = rows.findIndex((row) => row.label === "Chat about this");
  const customIndex = rows.findIndex((row) => /^Type something\.?$/i.test(row.label));
  if (preview) {
    // its notes are no answer of their own: no typed-answer row, the options are the menu
    if (customIndex >= 0 || chatIndex >= 0) return null;
  } else if (chatIndex !== rows.length - 1 || customIndex !== chatIndex - 1 || customIndex < 1) return null;
  const tabs = claudeTabs(lines, rows[0]!.lineIndex);
  const question = claudeQuestionText(lines, tabs?.index ?? -1, rows[0]!.lineIndex) ?? nearestQuestion(lines, rows[0]!.lineIndex);
  const chip = tabs === null ? claudeChip(lines, rows[0]!.lineIndex) : null;
  if (!question) return null;
  const optionRows = preview ? rows : rows.slice(0, customIndex);
  const multiSelect = optionRows.some((row) => /^\s*(?:[›>❯]\s*)?\d+\.\s+\[[ xX✓]\]/.test(lines[row.lineIndex]!));
  const current = tabs?.tabs.findIndex((tab) => !tab.answered) ?? -1;
  // a bar cut off by a narrow pane does not show how many questions there are
  const title = tabs && current >= 0 ? `${tabs.tabs[current]!.label}${tabs.whole && tabs.tabs.length > 1 ? ` · ${current + 1} of ${tabs.tabs.length}` : ""}`
    : chip ?? (multiSelect ? "Multiple choice" : "Question");
  return finishPrompt("claude", {
    kind: "question", title, question, body: null,
    options: optionRows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multi_select: multiSelect, custom_option_index: multiSelect || preview ? null : customIndex,
  }, {
    responder: "claude-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: preview ? null : customIndex, rejectWithEscapeIndex: null,
  });
}

/** A single question's header chip (`☐ Dataset`), the question's own short name; null when there is none. */
function claudeChip(lines: string[], firstRow: number): string | null {
  for (let index = firstRow - 1; index >= Math.max(0, firstRow - 40); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (isDivider(line) || CLAUDE_TABS_RE.test(line)) return null;
    const chip = /^[☐☒☑✔]\s+(\S.*)$/.exec(line);
    if (chip !== null) return chip[1]!.trim();
  }
  return null;
}

/**
 * Claude's question tabs above several questions, `←  ☒ Route  ☐ Author  ✔ Submit  →`,
 * looked for up the panel however far a long question wraps; a narrow pane can cut
 * the bar off at its right edge. ☐ is unanswered, ☒ answered, ✔ the Submit step.
 */
function claudeTabs(lines: string[], beforeIndex: number): { index: number; whole: boolean; tabs: { label: string; answered: boolean }[] } | null {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 60); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (SOLID_RULE_RE.test(line)) return null;
    if (!CLAUDE_TABS_RE.test(line)) continue;
    const tabs = [...line.replace(/^←/, "").replace(/→$/, "").matchAll(/([☐☒☑✔])\s+(.+?)(?=\s{2,}|\s*$)/g)]
      .filter((match) => match[1] !== "✔")
      .map((match) => ({ label: match[2]!.trim(), answered: match[1] !== "☐" }));
    return { index, whole: /→$/.test(line), tabs };
  }
  return null;
}

/** The question over Claude's options, joined back when a narrow pane wraps it over several lines. */
function claudeQuestionText(lines: string[], tabsIndex: number, firstRow: number): string | null {
  const text: string[] = [];
  for (let index = firstRow - 1; index > Math.max(tabsIndex, firstRow - 30); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!line) { if (text.length > 0) break; continue; }
    // the single question's header chip (`☐ Dataset`) or the panel's top rule ends the question
    if (/^[☐☒☑✔]\s+\S/.test(line) || isDivider(line) || CLAUDE_TABS_RE.test(line)) break;
    text.unshift(line);
  }
  return text.length > 0 ? normalizeText(text.join(" ")) : null;
}

/** After several questions Claude shows the answers and asks before sending them. */
function parseClaudeSubmit(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const questionIndex = findLastIndex(lines, (line) => /^Ready to submit your answers\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  const tabsIndex = findLastIndex(lines.slice(0, questionIndex), (line) => CLAUDE_TABS_RE.test(cleanLine(line)));
  if (tabsIndex < 0 || questionIndex - tabsIndex > 40) return null;
  const rows = parseNumberedRows(lines, questionIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const body = lines.slice(tabsIndex + 1, questionIndex).map(cleanLine)
    .filter((line) => line && !isDivider(line) && !/^Review your answers$/i.test(line)).join("\n");
  return finishPrompt("claude", {
    // a menu, not a question: a typed pick submits every answer at once, so it waits for Confirm
    kind: "menu", title: "Review your answers", question: cleanLine(lines[questionIndex]!), body: body || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-submit", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

interface OmoForm {
  /** the line the tab bar ends on (a narrow pane wraps it between tabs) */
  barEnd: number;
  tabs: { label: string; answered: boolean; current: boolean }[];
  /** the Submit tab is the current one: the answers are reviewed */
  reviewing: boolean;
}

/**
 * The head of OmO's form above its hint: the `Ask user` title, then the tab bar, each tab whole
 * on its line (`→` marks the current one, `✓` an answered one) and Submit last:
 *
 *    Ask user · 30m
 *      표시 위치 ✓  → 월 한도    Submit
 */
function omoForm(lines: string[], hintIndex: number): OmoForm | null {
  const titleIndex = findLastIndex(lines.slice(0, hintIndex), (line) => OMO_ASK_TITLE_RE.test(cleanLine(line)));
  if (titleIndex < 0 || hintIndex - titleIndex > 120) return null;
  let barEnd = titleIndex + 1;
  while (barEnd < hintIndex && !/(?:^|\s)(?:→\s)?Submit$/.test(cleanLine(lines[barEnd]!))) barEnd += 1;
  if (barEnd >= hintIndex || barEnd - titleIndex > 12) return null;
  const labels = lines.slice(titleIndex + 1, barEnd + 1).map(cleanLine).filter(Boolean).join("  ").split(/\s{2,}/);
  const submit = labels.pop()!;
  const tabs = labels.map((label) => ({
    label: label.replace(/^→\s+/, "").replace(/\s+✓$/, ""),
    answered: /\s✓$/.test(label),
    current: label.startsWith("→"),
  }));
  const reviewing = submit.startsWith("→");
  if (tabs.length === 0 || tabs.some((tab) => !tab.label) || tabs.filter((tab) => tab.current).length !== (reviewing ? 0 : 1)) return null;
  return { barEnd, tabs, reviewing };
}

/**
 * The questions of the form omo waits on, as its ask_user_question call asked them: the card's
 * text comes from here when the pane's session shows the call, never cut or wrapped by the pane.
 */
export interface OmoAsk {
  /** Session-qualified tool-call identity; absent only for screen-only legacy parsing. */
  id?: string;
  questions: { header: string; question: string; multiSelect: boolean; options: { label: string; description: string | null }[] }[];
  /** false: the call does not wait for its answer, and OmO folds it into a widget over its input box */
  wait?: boolean;
}

/** A call's questions, or null for arguments that are not the shape omo asks with. */
function omoAskOf(call: OmoAskCall): OmoAsk | null {
  const questions = (call.args as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const ask: OmoAsk = { id: call.id, questions: [], wait: call.wait };
  for (const question of questions as Record<string, unknown>[]) {
    if (typeof question?.["header"] !== "string" || typeof question["question"] !== "string" || (question["options"] !== undefined && !Array.isArray(question["options"]))) return null;
    const options = ((question["options"] ?? []) as Record<string, unknown>[]).map((option) => ({
      label: typeof option?.["label"] === "string" ? option["label"] : "",
      description: typeof option?.["description"] === "string" && option["description"] ? option["description"] : null,
    }));
    if (options.some((option) => !option.label)) return null;
    ask.questions.push({ header: question["header"], question: question["question"], multiSelect: question["multiSelect"] === true, options });
  }
  return ask;
}

/** the records that can open or close a question; the rest of a session's tail is not parsed */
const OMO_ASK_RECORD_RE = /"role":"(?:assistant|toolResult|user)"|ask-user:settlement/;

/**
 * The questions omo's session (its .jsonl, or the tail of it) still has open (omo-ask.ts), newest
 * first: a waiting call until its tool result, a non-waiting call until it is settled. Calls whose arguments are not the shape omo asks
 * with are left out.
 */
export function openOmoAsks(jsonl: string): OmoAsk[] {
  let open: OmoAsks = [];
  for (const line of jsonl.split("\n")) {
    if (!OMO_ASK_RECORD_RE.test(line)) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry === "object" && entry !== null) open = omoAsksAfter(open, entry);
  }
  return open.flatMap((call) => omoAskOf(call) ?? []).reverse();
}

/** The newest question omo's session has open, or null. */
export function pendingOmoAsk(jsonl: string): OmoAsk | null {
  return openOmoAsks(jsonl)[0] ?? null;
}

/** A tab shows its question's header, cut with an ellipsis when the pane is too narrow for it. */
function sameHeader(tab: string, header: string): boolean {
  const shown = normalizeText(tab);
  const asked = normalizeText(header);
  return shown === asked || (shown.endsWith("…") && asked.startsWith(shown.slice(0, -1).trimEnd()));
}

/** The session's call is the form on screen: as many tabs, each its question's header. */
function askOnScreen(form: OmoForm, ask: OmoAsk): boolean {
  return form.tabs.length === ask.questions.length && form.tabs.every((tab, index) => sameHeader(tab.label, ask.questions[index]!.header));
}

/** The steps for the card, from the tabs on screen, named as asked when the call is known. */
function omoSteps(tabs: OmoForm["tabs"], ask: OmoAsk | null): InteractivePrompt["steps"] {
  return tabs.length > 1 ? tabs.map((tab, index) => ({ ...tab, label: ask?.questions[index]?.header ?? tab.label })) : undefined;
}

/** The card's title: where the question stands among several, else its header. */
function omoTitle(tabs: OmoForm["tabs"], index: number, ask: OmoAsk | null): string {
  return tabs.length > 1 ? `Question ${index + 1} of ${tabs.length}` : ask?.questions[index]?.header ?? tabs[index]!.label;
}

/**
 * Keys from omo's cursor to a row of its list. Without a cursor on screen (its row above the
 * visible part) they start from the top: ↑ stops at the first row, so `rows` of them get there.
 */
function omoWalk(to: number, from: number, rows: number): string[] {
  return from >= 0 ? navigationKeys(to - from) : [...navigationKeys(-rows), ...navigationKeys(to)];
}

/**
 * Lines a narrow pane wrapped, joined back into one text (`lead` cut off the first line's
 * start, a row's number). A wrap at a space dropped it, so the lines join with one; but Korean,
 * Japanese and Chinese also wrap inside a word: a line that ends in a wide character, filled to
 * the pane's edge (`width`, its widest line) so that the next line's first character (wide, or
 * closing punctuation) would not have fitted after it, goes on without a space. A line filled
 * that far can also have ended at a space; the word wrapped inside is the likelier reading. The
 * session's own text, when there is one, makes this a fallback.
 */
function joinWrapped(raw: string[], width: number, lead?: RegExp): string {
  let text = "";
  let previous = "";
  for (const line of raw) {
    const clean = text === "" && lead ? cleanLine(line).replace(lead, "") : cleanLine(line);
    if (!clean) continue;
    const first = [...clean][0]!;
    const glued = text !== "" && Bun.stringWidth([...previous.trimEnd()].at(-1) ?? "") === 2
      && (Bun.stringWidth(first) === 2 || /^[.,!?;:)\]}…]/.test(first))
      && Bun.stringWidth(previous.trimEnd()) + Bun.stringWidth(first) > width - 1;
    text += text === "" || glued ? clean : ` ${clean}`;
    previous = line;
  }
  return normalizeText(text);
}

/** The pane's width as the screen shows it: OmO's rules and its footer span all of it. */
function screenWidth(lines: string[]): number {
  return Math.max(0, ...lines.map((line) => Bun.stringWidth(line.trimEnd())));
}

/** "Submit (1/2 answered)": how many of the form's questions have an answer. */
function omoAnsweredCount(lines: string[], from: number, to: number): number | null {
  const match = /Submit \((\d+)\/\d+ answered\)/.exec(lines.slice(from, to).map(cleanLine).join(" "));
  return match ? Number(match[1]) : null;
}

interface OmoQuestionView {
  /** the question's lines; none when the pane cut them off */
  question: string[];
  /** the options in view: a pane too short for the form shows only the last ones */
  rows: { number: number; label: string[]; description: string[]; selected: boolean }[];
  own: { selected: boolean; lineIndex: number } | null;
}

/**
 * The question, its numbered options (`→` on the highlighted row, `✓` after a chosen one) with
 * descriptions indented under them, and the row for a typed answer, between `start` and `end`:
 *
 *    음성 사용량과 추정 비용을 어디에 보여줄까요?
 *    → 1. 설정 > 음성 입력 (추천)
 *         오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여주고 … 변경 범위가 가장 작습니
 *    다.
 *      2. 설정 + 사이드바 미터
 *      Type your own answer...
 *
 * A wrapped line starts at the pane's edge, so the indent tells rows from descriptions only on a
 * line's first row: lines under an option are its label wrapped until the first indented one,
 * the description, which takes the rest. From the screen's top (`cut`, the form taller than the
 * pane) the first row in view may be any number, and lines above it belong to rows out of view.
 */
function omoQuestionView(lines: string[], start: number, end: number, cut: boolean): OmoQuestionView {
  const view: OmoQuestionView = { question: [], rows: [], own: null };
  for (let index = start; index < end && view.own === null; index += 1) {
    const raw = lines[index]!;
    const line = cleanLine(raw);
    if (!line || isDivider(line)) continue;
    const indent = raw.search(/\S/);
    const selected = line.startsWith("→");
    const text = line.replace(/^→\s+/, "");
    // the row's label, cut by a narrow pane: "Type your own" / "answer..."
    if ((selected || indent >= 2) && /^Type your own\b/.test(text)) {
      view.own = { selected, lineIndex: index };
      continue;
    }
    const row = /^(\d+)\.\s+(.+)$/.exec(text);
    const last = view.rows.at(-1);
    const next = last ? last.number + 1 : cut ? Number(row?.[1]) : 1;
    if (row && Number(row[1]) === next && (selected || (indent >= 2 && indent < 5))) {
      view.rows.push({ number: next, label: [raw], description: [], selected });
      continue;
    }
    if (!last) { if (!cut) view.question.push(raw); }
    else if (last.description.length > 0 || indent >= 5) last.description.push(raw);
    else last.label.push(raw);
  }
  return view;
}

/**
 * The question of the session's call a cut-off form shows: the one whose options end with the
 * rows in view, each matched by its first line (which the pane may cut). Unique, or -1.
 */
function askedQuestion(view: OmoQuestionView, ask: OmoAsk): number {
  const start = (raw: string): string => comparable(cleanLine(raw).replace(/^(?:→\s+)?\d+\.\s+/, "").replace(/\s+✓$/, ""));
  const last = view.rows.at(-1)?.number;
  const matches = ask.questions.flatMap((question, index) => question.options.length === last
    && view.rows.every((row) => comparable(question.options[row.number - 1]!.label).startsWith(start(row.label[0]!))) ? [index] : []);
  return matches.length === 1 ? matches[0]! : -1;
}

/**
 * Where the form stands when its tabs are out of view: the question asked now, answered ones
 * before it when the count says so (answered in order, as the card does), none after it.
 */
function cutSteps(ask: OmoAsk, current: number, currentAnswered: boolean, answeredCount: number | null): OmoForm["tabs"] {
  const inOrder = answeredCount !== null && answeredCount - (currentAnswered ? 1 : 0) === current;
  return ask.questions.map((question, index) => ({
    label: question.header,
    answered: index === current ? currentAnswered : inOrder && index < current,
    current: index === current,
  }));
}

/**
 * OmO's form on a question: the tab bar (`→ 표시 위치    월 한도    Submit`) over the question view,
 * then `Submit (0/2 answered) — Enter advances` and the key hint:
 *
 *    ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
 *
 * The question and options read from the session's call when it shows; from the screen
 * otherwise, which then needs the whole form in view. Navigate to an option and confirm it;
 * in a multiple choice, clear the previous answer (Backspace), navigate and toggle each choice
 * with Space, then move on with Tab.
 */
function parseOmoQuestion(screen: string, ask: OmoAsk | null, trusted: boolean): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_OPTIONS_HINT_RE.test(wrapped(lines, index, OMO_HINT_LINES)));
  if (hintIndex < 0) return null;
  const form = omoForm(lines, hintIndex);
  if (form?.reviewing || (!form && !ask)) return null;
  const known = ask && (!form || askOnScreen(form, ask)) ? ask : null;
  if (!trusted && !known) return null;
  const view = omoQuestionView(lines, form ? form.barEnd + 1 : 0, hintIndex, !form);
  if (view.own === null || (view.rows.length === 0 && !known)) return null;
  const multiSelect = OMO_OPTIONS_HINT_RE.exec(wrapped(lines, hintIndex, OMO_HINT_LINES))![1] === "toggle";
  const width = screenWidth(lines);
  const shownLabels = view.rows.map((row) => joinWrapped(row.label, width, /^(?:→\s+)?\d+\.\s+/));
  const currentAnswered = shownLabels.some((label) => /\s✓$/.test(label)) || /^(?:→\s+)?Type your own answer\.\.\.:/.test(cleanLine(lines[view.own.lineIndex]!));
  let index: number;
  let tabs: OmoForm["tabs"];
  let question: string;
  let options: InteractivePrompt["options"];
  if (known) {
    index = form ? form.tabs.findIndex((tab) => tab.current) : askedQuestion(view, known);
    if (index < 0) return null;
    const asked = known.questions[index]!;
    // the screen must show this question's rows, numbered to its last option
    if (asked.multiSelect !== multiSelect || (view.rows.at(-1)?.number ?? 0) !== asked.options.length) return null;
    if (view.question.length > 0 && !sameText(joinWrapped(view.question, width), asked.question)) return null;
    if (!view.rows.every((row, at) => sameText(shownLabels[at]!.replace(/\s+✓$/, ""), asked.options[row.number - 1]!.label))) return null;
    tabs = form ? form.tabs : cutSteps(known, index, currentAnswered, omoAnsweredCount(lines, view.own.lineIndex, hintIndex));
    question = normalizeText(asked.question);
    options = asked.options.map((option) => ({ label: normalizeText(option.label), description: option.description && normalizeText(option.description) }));
  } else {
    if (!form || view.question.length === 0 || view.rows[0]!.number !== 1) return null;
    index = form.tabs.findIndex((tab) => tab.current);
    tabs = form.tabs;
    question = joinWrapped(view.question, width);
    options = shownLabels.map((label, row) => ({
      label: label.replace(/\s+✓$/, ""),
      description: view.rows[row]!.description.length > 0 ? joinWrapped(view.rows[row]!.description, width) : null,
    }));
  }
  const highlighted = view.rows.find((row) => row.selected);
  // the cursor, when its row is in view: on an option, or on the typed answer's row
  const selectedIndex = view.own.selected ? options.length : highlighted ? highlighted.number - 1 : -1;
  const rows = options.length + 1;
  const pick = (option: number): AnswerStep[] => keySteps([...omoWalk(option, selectedIndex, rows), KEY.enter]);
  return finishPrompt("omo", {
    // several questions: the card's steps name them, the title says where this one stands
    kind: "question", title: omoTitle(tabs, index, known),
    question, body: null, options, multi_select: multiSelect, custom_option_index: multiSelect ? null : options.length,
    steps: omoSteps(tabs, known),
  }, {
    omoQuestion: known?.id ? { call: known.id, index } : undefined,
    responder: "omo-question", menuLabels: [...options.map((option) => option.label), OMO_OWN_ANSWER], selectedIndex,
    checkedOptionIndices: view.rows.flatMap((row, at) => /\s✓$/.test(shownLabels[at]!) ? [row.number - 1] : []),
    customMenuIndex: options.length, rejectWithEscapeIndex: null,
    optionSteps: options.map((_, option) => pick(option)),
    // what was typed before stays in the row: a Backspace on the options clears the answer first
    customSteps: (text) => [...keySteps([KEY.backspace, ...omoWalk(options.length, selectedIndex, rows), KEY.enter]), { text }, ...keySteps([KEY.enter])],
    multiSteps: (choices) => {
      let at = selectedIndex;
      const steps = keySteps([KEY.backspace]);
      for (const option of [...choices].sort((a, b) => a - b)) {
        steps.push(...keySteps([...omoWalk(option, at, rows), KEY.space]));
        at = option;
      }
      return [...steps, ...keySteps([KEY.tab])];
    },
  }, { call: known?.id });
}

/**
 * OmO's form while an answer is typed in the terminal (the typed answer's row opened):
 *
 *    Your answer (enter to save, ↑↓ back to options, esc to discard)
 *    > 안녕
 *    Submit (0/2 answered) — Enter advances
 *    enter save and next  ↑↓ back to options  tab next question  esc discard
 *
 * The card offers to save what is typed (Enter, which moves on as an answer does) or to discard it.
 */
function parseOmoTyping(screen: string, ask: OmoAsk | null, trusted: boolean): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_TYPING_HINT_RE.test(wrapped(lines, index, OMO_HINT_LINES)));
  if (hintIndex < 0) return null;
  const form = omoForm(lines, hintIndex);
  if (form?.reviewing || (!form && !ask)) return null;
  const known = ask && (!form || askOnScreen(form, ask)) ? ask : null;
  if (!trusted && !known) return null;
  const label = findLastIndex(lines.slice(0, hintIndex), (line) => /^Your answer \(/.test(cleanLine(line)));
  const field = findLastIndex(lines.slice(0, hintIndex), (line, index) => index > label && /^>/.test(cleanLine(line)));
  if (label < 0 || field < 0) return null;
  const typed = cleanLine(lines[field]!).replace(/^>\s?/, "").trim();
  const view = omoQuestionView(lines, form ? form.barEnd + 1 : 0, label, !form);
  let index: number;
  let tabs: OmoForm["tabs"];
  let question: string;
  if (known) {
    index = form ? form.tabs.findIndex((tab) => tab.current) : view.rows.length > 0 ? askedQuestion(view, known) : -1;
    if (index < 0) return null;
    tabs = form ? form.tabs : cutSteps(known, index, false, null);
    question = normalizeText(known.questions[index]!.question);
  } else {
    if (!form || view.question.length === 0) return null;
    index = form.tabs.findIndex((tab) => tab.current);
    tabs = form.tabs;
    question = joinWrapped(view.question, screenWidth(lines));
  }
  const choices: { label: string; description: string | null; steps: AnswerStep[] }[] = [
    { label: "Save the typed answer", description: typed || null, steps: keySteps([KEY.enter]) },
    { label: "Discard it", description: null, steps: keySteps([KEY.escape]) },
  ];
  return finishPrompt("omo", {
    // a menu: a number typed in the chat acts on the terminal's input, so it waits for Confirm
    kind: "menu", title: omoTitle(tabs, index, known), question, body: null,
    options: choices.map((choice) => ({ label: choice.label, description: choice.description })),
    multi_select: false, custom_option_index: null, steps: omoSteps(tabs, known),
  }, {
    responder: "omo-typing", menuLabels: choices.map((choice) => choice.label), selectedIndex: -1,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: choices.map((choice) => choice.steps),
  }, { call: known?.id });
}

/**
 * OmO's form on its Submit tab, after the last question or a Tab past it: a row per question
 * with its answer, then a comment field, which has the cursor until ↑ moves it onto a row:
 *
 *    Review your answers
 *      표시 위치: 설정 > 음성 입력 (추천)
 *    → 월 한도: 월 $5 한도
 *
 *    Comment (optional; unanswered questions are reported)
 *    >
 *    Submit (2/2 answered)
 *    enter edit answer  ↑↓ move  tab next question  esc back
 *
 * Enter on the comment submits the form (with the comment, when one is typed); on a row it opens
 * that question again. The card offers Submit, each row to change its answer, and the comment.
 * With the tabs out of view, the session's call names the rows; a row above the screen's top
 * then shows by its question's header alone.
 */
function parseOmoReview(screen: string, ask: OmoAsk | null, trusted: boolean): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_REVIEW_HINT_RE.test(wrapped(lines, index, OMO_HINT_LINES)));
  if (hintIndex < 0) return null;
  const form = omoForm(lines, hintIndex);
  if ((form && !form.reviewing) || (!form && !ask)) return null;
  const known = ask && (!form || askOnScreen(form, ask)) ? ask : null;
  if (!trusted && !known) return null;
  const heading = findLastIndex(lines.slice(0, hintIndex), (line, index) => index > (form?.barEnd ?? -1) && cleanLine(line) === "Review your answers");
  if (heading < 0 && form) return null;
  const rows: { text: string[]; selected: boolean }[] = [];
  let index = heading + 1;
  for (; index < hintIndex; index += 1) {
    const raw = lines[index]!;
    const line = cleanLine(raw);
    // the comment field's label, or with that cut off the field itself
    if (line.startsWith("Comment (") || line.startsWith(">")) break;
    if (!line) { if (heading >= 0 || rows.length > 0) break; continue; }
    const selected = line.startsWith("→");
    if (selected || raw.search(/\S/) >= 2) rows.push({ text: [raw], selected });
    else if (rows.length > 0) rows.at(-1)!.text.push(raw);
  }
  const width = screenWidth(lines);
  const shown = rows.map((row) => ({ label: joinWrapped(row.text, width, /^→\s+/), selected: row.selected }));
  const count = known ? known.questions.length : form!.tabs.length;
  // each question's row: by its header when the call is known (rows above the screen's top are
  // out of view), else in order, all of them
  const rowOf = known
    ? known.questions.map((question) => shown.find((row) => row.label.startsWith(`${normalizeText(question.header)}:`)))
    : shown.length === count ? shown : null;
  if (!rowOf) return null;
  const rest = lines.slice(index, hintIndex).filter((line) => cleanLine(line) && !isDivider(line));
  // the field's label (a narrow pane wraps it), the field (`>` and what is typed there), then
  // a notice (`! …`) and the Submit line, both wrapped as well
  const field = rest.findIndex((line) => cleanLine(line).startsWith(">"));
  if (field < 0) return null;
  const commentLabel = joinWrapped(rest.slice(0, field), width) || "Comment";
  const comment = cleanLine(rest[field]!).replace(/^>\s?/, "").trim();
  const after = joinWrapped(rest.slice(field + 1), width);
  const submitAt = after.search(/Submit \(\d+\/\d+ answered\)/);
  const notice = (submitAt < 0 ? after : after.slice(0, submitAt)).replace(/^!\s*/, "").trim();
  const answeredCount = omoAnsweredCount(lines, index, hintIndex);
  // the cursor: on the comment (the row after the answers), on the answer it marks, or out of view
  const onComment = OMO_REVIEW_HINT_RE.exec(wrapped(lines, hintIndex, OMO_HINT_LINES))![1] === "submit";
  const selectedIndex = onComment ? count : rowOf.findIndex((row) => row?.selected);
  const labels = rowOf.map((row, at) => row?.label ?? normalizeText(known!.questions[at]!.header));
  const tabs = form ? form.tabs : known!.questions.map((question, at) => ({
    label: question.header,
    answered: rowOf[at] ? !/:\s*unanswered$/.test(rowOf[at]!.label) : answeredCount === count,
    current: false,
  }));
  const choices: { label: string; steps: AnswerStep[] }[] = [
    { label: "Submit", steps: keySteps([...omoWalk(count, selectedIndex, count + 1), KEY.enter]) },
    ...labels.map((label, row) => ({ label, steps: keySteps([...omoWalk(row, selectedIndex, count + 1), KEY.enter]) })),
  ];
  return finishPrompt("omo", {
    // a menu: a number typed in the chat submits the whole form, so it waits for Confirm
    kind: "menu", title: "Review your answers", question: submitAt < 0 ? "Submit your answers?" : after.slice(submitAt),
    body: [notice, comment ? `Comment: ${comment}` : ""].filter(Boolean).join("\n") || null,
    options: [...choices.map(({ label }) => ({ label, description: null })), { label: commentLabel, description: null }],
    multi_select: false, custom_option_index: choices.length, steps: omoSteps(tabs, known),
  }, {
    responder: "omo-review", menuLabels: [...labels, commentLabel], selectedIndex,
    checkedOptionIndices: [], customMenuIndex: count, rejectWithEscapeIndex: null,
    optionSteps: [...choices.map(({ steps }) => steps), []],
    customSteps: (text) => [...keySteps(omoWalk(count, selectedIndex, count + 1)), { text }, ...keySteps([KEY.enter])],
  }, { call: known?.id });
}

/**
 * OmO's widget over its input box for a question asked without waiting for the answer (omo
 * 5.1.19): OmO goes on working, or ends its turn, and the question stays open until answered:
 *
 *    ? Question pending (2 unanswered) · 30m          (`? 2 questions pending · 30m` for several calls)
 *      표시 위치 — 음성 사용량과 추정 비용을 어디에 보여줄까요?
 *    [ 설정 > 음성 입력 (추천) ]  [ 설정 + 사이드바 미터 ]  [ own answer… ]
 *    +1 more question
 *    enter to answer · /answer · or just type your reply
 *
 * It shows the first unanswered question of one call, by its header; the session's open calls
 * that do not wait name it, and the card is only for one of them. The answer route opens the
 * form with Alt+Up, verifies the call and question again, then uses the form's navigation.
 * No answer text is sent to the composer, even when whitespace makes its draft look empty.
 */
function parseOmoPending(screen: string, pending: OmoAsk[]): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_PENDING_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const statusIndex = findLastIndex(lines.slice(0, hintIndex), (line) => OMO_PENDING_STATUS_RE.test(cleanLine(line)));
  if (statusIndex < 0 || hintIndex - statusIndex > 12) return null;
  const unanswered = OMO_PENDING_STATUS_RE.exec(cleanLine(lines[statusIndex]!))![1];
  const shown = /^(.+?) — (.+)$/.exec(cleanLine(lines[statusIndex + 1] ?? ""));
  if (!shown) return null;
  // the line is cut at the pane's edge
  const start = comparable(shown[2]!.replace(/(?:…|\.\.\.)$/, ""));
  const matches = pending.filter((ask) => ask.wait === false).flatMap((ask) => ask.questions.flatMap((question, index) =>
    sameHeader(shown[1]!, question.header) && comparable(question.question).startsWith(start) ? [{ ask, index }] : []));
  if (matches.length !== 1) return null;
  const { ask, index } = matches[0]!;
  const asked = ask.questions[index]!;
  const tabs = cutSteps(ask, index, false, unanswered === undefined ? null : ask.questions.length - Number(unanswered));
  const options = asked.options.map((option) => ({ label: normalizeText(option.label), description: option.description && normalizeText(option.description) }));
  return finishPrompt("omo", {
    kind: "question", title: omoTitle(tabs, index, ask), question: normalizeText(asked.question), body: null,
    options, multi_select: asked.multiSelect, custom_option_index: asked.multiSelect ? null : options.length,
    steps: omoSteps(tabs, ask),
  }, {
    omoQuestion: ask.id ? { call: ask.id, index } : undefined,
    responder: "omo-pending", menuLabels: [...options.map((option) => option.label), "Type your reply"], selectedIndex: -1,
    checkedOptionIndices: [], customMenuIndex: asked.multiSelect ? null : options.length, rejectWithEscapeIndex: null,
    // Validation only here: execution requires the opened form and its freshly read cursor.
    optionSteps: options.map(() => []),
    customSteps: () => [],
    multiSteps: () => [],
  }, { call: ask.id });
}

function parseCodexApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => CODEX_APPROVAL_HEADER_RE.test(line) && !NUMBERED_OPTION_RE.test(line));
  if (headerIndex < 0) return null;
  const rows = parseNumberedRows(lines, headerIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  // "Trust this folder? Codex can read, …": the question heads the card, its explanation joins the body
  const header = cleanLine(lines[headerIndex]!);
  const split = header.match(/^(.*?\?)\s+(.+)$/);
  const heading = split ? split[1]! : header;
  const body = [split?.[2] ?? "", ...lines.slice(headerIndex + 1, rows[0]!.lineIndex).map(cleanLine)].filter(Boolean).join("\n");
  return finishPrompt("codex", {
    kind: "approval", title: heading, question: heading, body: body || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "codex-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: rows.findIndex((row) => /^(?:No|Reject|Cancel|Deny)\b/i.test(row.label)),
  });
}

function parseOmpApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => /^\s*Allow tool:\s*\S+/i.test(cleanLine(line)));
  if (headerIndex < 0) return null;
  const rows: MenuRow[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const match = cleanLine(lines[index]!).match(/^([›>❯•])?\s*(Approve|Deny)$/i);
    if (match) rows.push({ label: match[2]!, selected: Boolean(match[1]), checked: false, lineIndex: index });
  }
  if (rows.length !== 2 || rows.filter((row) => row.selected).length !== 1) return null;
  return finishPrompt("omp", {
    kind: "approval", title: cleanLine(lines[headerIndex]!), question: cleanLine(lines[headerIndex]!),
    body: lines.slice(headerIndex + 1, rows[0]!.lineIndex).map(cleanLine).filter(Boolean).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

function parseClaudeApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const planIndex = findLastIndex(lines, (_, index) => /Claude has written up a plan and is ready to execute\. Would you like to proceed\?/i.test(wrapped(lines, index)));
  if (planIndex >= 0) {
    const rows = parseNumberedRows(lines, planIndex + 1, lines.length);
    if (!sequentialRows(rows) || rows.length < 3 || rows.filter((row) => row.selected).length !== 1) return null;
    const customIndex = rows.findIndex((row) => /^Tell Claude what to change$/i.test(row.label));
    const bodyStart = Math.max(0, findLastIndex(lines.slice(0, planIndex), (line) => /Ready to code\?/i.test(cleanLine(line))));
    return finishPrompt("claude", {
      kind: "plan", title: "Ready to code?", question: cleanLine(lines[planIndex]!),
      body: lines.slice(bodyStart, planIndex).map(cleanLine).filter((line) => !isDivider(line)).join("\n") || null,
      options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false,
      custom_option_index: customIndex >= 0 ? customIndex : null,
    }, {
      responder: "claude-plan", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
      checkedOptionIndices: [], customMenuIndex: customIndex >= 0 ? customIndex : null, rejectWithEscapeIndex: null,
    });
  }

  const requiredIndex = findLastIndex(lines, (line) => /This command requires approval/i.test(cleanLine(line)));
  const dangerousRmIndex = findLastIndex(lines, (line) => /^Dangerous rm operation\b/i.test(cleanLine(line)));
  const approvalIndex = Math.max(requiredIndex, dangerousRmIndex);
  // "Do you want to proceed?", "Do you want to create hello.txt?", "Do you want to make this edit to a.ts?"
  const questionIndex = findLastIndex(lines, (line) => /^Do you want to .+\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  // options end at the key hint: a line under the last one is then only its wrapped label
  const hintIndex = findLastIndex(lines, (_, index) => /esc to cancel/i.test(wrapped(lines, index)));
  const rows = parseNumberedRows(lines, questionIndex + 1, hintIndex > questionIndex ? hintIndex : lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  let title: string;
  let body: string;
  if (approvalIndex >= 0 && approvalIndex < questionIndex) {
    title = nearestQuestion(lines, approvalIndex) ?? "Command approval";
    const bodyEnd = dangerousRmIndex > requiredIndex ? questionIndex : approvalIndex;
    body = lines.slice(Math.max(0, approvalIndex - 8), bodyEnd).map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  } else {
    // Claude Code 2.1 has neither marker: the panel under a solid rule opens with the
    // tool ("Bash command", "Create file"), then the command or file and its description
    // the panel's rule is the first one under the tool call (`● Write(a.ts)`): rules further
    // down belong to a file preview; with the call scrolled away, the nearest rule
    // Claude's own text opens with ● too ("● Results table follows:"): a call is a tool name and "("
    // (an MCP call reads "● server - tool (MCP)(…)")
    const callIndex = findLastIndex(lines.slice(0, questionIndex), (line) => /^●\s+[\w.:-]+(?:\s[\w.:-]+)*(?:\s\(MCP\))?\(/.test(cleanLine(line)));
    const rules = lines.slice(0, questionIndex).flatMap((line, index) => index > callIndex && SOLID_RULE_RE.test(cleanLine(line)) ? [index] : []);
    const ruleIndex = callIndex >= 0 ? rules[0] ?? -1 : rules.at(-1) ?? -1;
    if (ruleIndex < 0 || questionIndex - ruleIndex > 60) return null;
    const panel = lines.slice(ruleIndex + 1, questionIndex).map(cleanLine)
      .filter((line) => line && !isDivider(line) && !/^Tip:/i.test(line));
    if (panel.length === 0) return null;
    title = panel[0]!;
    body = panel.slice(1).join("\n");
  }
  return finishPrompt("claude", {
    kind: "approval", title, question: cleanLine(lines[questionIndex]!),
    body: body || null,
    // an approval's options have no descriptions: lines under one are its label wrapped by a narrow pane
    options: rows.map((row, index) => ({ label: normalizeText([row.label, ...lines.slice(row.lineIndex + 1, rows[index + 1]?.lineIndex ?? (hintIndex > questionIndex ? hintIndex : lines.length))
      .map(cleanLine).filter((line) => line && !isDivider(line))].join(" ")), description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-approval", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

/**
 * Claude Code 2.1.294 takes zero-width and other invisible characters out of a message, and instead
 * of sending it keeps it in its input until it is reviewed. For a moment it says so over the box:
 *
 *                       Removed 1 invisible character · review and press Enter to send
 *   ────────────────
 *   ❯ helloworld test
 *   ────────────────
 *     [Haiku 4.5] │ project
 *
 * The chat had sent the message and cleared its box, so it seemed gone. The card shows the
 * message as Claude now holds it and sends it (Enter) or drops it (Ctrl+C clears the input).
 * The hint does not stay (a turn's status line takes its row), so the box counts on its own too:
 * when it still holds what the chat last sent here less only invisible characters (`sent`).
 * `working`: Claude is under a turn. Ctrl+C then interrupts the turn and leaves the box as it was
 * (live, 2.1.294: "Interrupted · What should Claude do instead?"), so the card offers Send alone
 * until the turn ends; Enter under a turn queues the message as it does from the terminal.
 */
function parseClaudeHeld(screen: string, sent: string | null, working: boolean): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  // the input box: the last rule with only Claude's footer under it, the rule above it, and a ❯ line first
  const bottom = findLastIndex(lines, (line) => isDivider(line));
  if (bottom < 0) return null;
  const footer = lines.slice(bottom + 1).map(cleanLine).filter(Boolean);
  if (footer.length > 8 || footer.some((line) => line.startsWith("❯"))) return null;
  let top = bottom - 1;
  while (top >= 0 && !isDivider(lines[top]!)) top -= 1;
  if (top < 0 || bottom - top > 40) return null;
  const box = lines.slice(top + 1, bottom).map((line) => line.replace(/\s+$/, ""));
  if (!/^\s*❯/.test(box[0] ?? "")) return null;
  // the box's own lines: the first after its ❯, the rest at the box's indent
  const message = box.map((line, index) => index === 0 ? line.replace(/^\s*❯\s?/, "") : line.replace(/^ {0,2}/, "")).join("\n").trim();
  if (!message) return null;
  let above = top - 1;
  while (above >= 0 && !cleanLine(lines[above]!)) above -= 1;
  const hint = above >= 0 ? CLAUDE_HELD_HINT_RE.exec(cleanLine(lines[above]!)) : null;
  const removed = hint ? Number(hint[1]) : sent !== null ? removedInvisible(sent, message) : 0;
  if (removed <= 0) return null;
  const title = removed === 1 ? "Claude Code removed 1 invisible character" : `Claude Code removed ${removed} invisible characters`;
  // the choices are part of the card's id: a Discard tapped on a card read before the turn began is refused
  const choices = [{ label: "Send", steps: keySteps([KEY.enter]) }, ...(working ? [] : [{ label: "Discard", steps: keySteps(["ctrl+c"]) }])];
  return finishPrompt("claude", {
    kind: "approval", title, question: "The message waits in its input. Send it as it is now?",
    body: message,
    options: choices.map(({ label }) => ({ label, description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-held", menuLabels: choices.map(({ label }) => label), selectedIndex: -1,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: choices.map(({ steps }) => steps),
  });
}

/** Characters no one sees: format controls (zero-width spaces and joiners, bidi marks, tags), combining marks, Hangul fillers. */
export const INVISIBLE_CHAR_RE = /[\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0]/u;

/**
 * How many characters of `sent` the box `shown` lacks, when it lacks only invisible ones (0 when
 * anything else differs). Whitespace is left out of both: the box wraps a long message.
 */
export function removedInvisible(sent: string, shown: string): number {
  // whitespace, but not U+FEFF, which \s takes for a space and Claude Code counts as invisible
  const a = [...sent.replace(/[^\S\uFEFF]+/g, "")];
  const b = [...shown.replace(/[^\S\uFEFF]+/g, "")];
  let i = 0;
  let removed = 0;
  for (const char of a) {
    if (i < b.length && b[i] === char) { i += 1; continue; }
    if (!INVISIBLE_CHAR_RE.test(char)) return 0;
    removed += 1;
  }
  return i === b.length ? removed : 0;
}

/** What the chat last sent to each pane, while it carried invisible characters (noteSubmitted). */
const heldCandidates = new Map<string, { text: string; at: number }>();
/** Long enough to read the card and answer it; a message kept past this is the user's own business */
const HELD_WINDOW_MS = 10 * 60_000;

/** A message the chat just sent to a pane: one with invisible characters may be held by Claude Code. */
export function noteSubmitted(paneId: string, text: string): void {
  if (INVISIBLE_CHAR_RE.test(text)) heldCandidates.set(paneId, { text, at: Date.now() });
  else heldCandidates.delete(paneId);
}

/** What the chat sent a pane that Claude Code may be holding, for the readers that ask whether it waits. */
export function heldCandidate(paneId: string): string | null {
  const entry = heldCandidates.get(paneId);
  if (!entry) return null;
  if (Date.now() - entry.at > HELD_WINDOW_MS) { heldCandidates.delete(paneId); return null; }
  return entry.text;
}

/**
 * Claude Code's unnumbered menus, live in 2.1.285 on a folder it has not seen:
 *
 *   Accessing workspace:
 *   /home/user/project
 *   Quick safety check: Is this a project you created or one you trust? (Like your own code,
 *   …
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 *
 * herdr reports the pane blocked. The rows are the lines right above the hint, up to a blank
 * line or a rule, exactly one of them `❯`; numbered rows are left to the menus above.
 */
function parseClaudeConfirm(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_CONFIRM_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  let end = hintIndex - 1;
  while (end >= 0 && !cleanLine(lines[end]!)) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  if (end < 0 || start < 0) return null;
  // A narrow pane wraps a long label onto the next line, at the label's own indent, so the
  // indent cannot tell a wrapped label from the next row. Words wrap only when the next one no
  // longer fits: a line under a row (without its own ❯) continues that row when its first word
  // would not have fitted after it. The widest line off the rows stands for the pane's width; a
  // row wider than all of them says nothing of it, and the line under it could be either, so a
  // screen like that gets no card rather than one that answers a row it does not show.
  const width = Math.max(0, ...lines.filter((_, index) => index < start || index > end).map((line) => line.trimEnd().length));
  let unsure = false;
  const wrappedFrom = (above: string, line: string): boolean => {
    if (above.trimEnd().length + 1 + (line.split(/\s+/)[0]?.length ?? 0) <= width) return false;
    if (above.trimEnd().length > width) unsure = true;
    return true;
  };
  const rows: { label: string; selected: boolean; lineIndex: number }[] = [];
  for (let index = start; index <= end; index += 1) {
    const line = cleanLine(lines[index]!);
    const selected = SELECTED_RE.test(line);
    const previous = rows.at(-1);
    if (previous && !selected && wrappedFrom(lines[index - 1]!, line)) {
      previous.label = normalizeText(`${previous.label} ${line}`);
      continue;
    }
    rows.push({ label: line.replace(SELECTED_RE, "").trim(), selected, lineIndex: index });
  }
  if (unsure) return null;
  if (rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length !== 1) return null;
  if (rows.some((row) => !row.label || NUMBERED_OPTION_RE.test(row.label))) return null;
  // the panel above the rows: its first line names it, a sentence ending in "?" asks
  let top = start - 1;
  while (top >= 0 && !isDivider(lines[top]!) && start - top <= 30) top -= 1;
  const panel = lines.slice(top + 1, start).map(cleanLine).filter(Boolean);
  const title = (panel[0] ?? "Choose an option").replace(/:$/, "");
  const prose = normalizeText(panel.slice(1).join(" "));
  const asked = /(?:^|[.:!]\s+)([^.:!?]*\?)/.exec(prose)?.[1]?.trim();
  return finishPrompt("claude", {
    kind: "menu", title, question: asked ?? title,
    body: panel.slice(1).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-confirm", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

/**
 * Claude Code's `/model` list, live in 2.1.290:
 *
 *   Select model
 *   Switch between Claude models. Your pick becomes the default for new sessions. …
 *
 *     1.  Default (recommended)  Fable 5.1
 *   ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks
 *     …
 *   ↓ 10. Opus 4.7               Best for everyday, complex tasks
 *      … +2 models
 *
 *   ◐ Medium effort (default) ←/→ to adjust
 *
 *   Enter to set as default · s to use this session only · Esc to cancel
 *
 * herdr never reports the pane blocked while it waits (idle, on herdr 0.9.3), so the card can
 * only come from the screen. The list is read off its hint, the one line that is always there:
 * a pane shorter than the list scrolls the title off its top, and Claude then draws fewer rows
 * (five of twelve at 24 lines) so that the one under the cursor stays on screen.
 *
 * What the list holds is Claude's to decide and differs from one session to the next (twelve
 * models by name, or five by family with the name in the description), so a row is read by its
 * shape alone: its number, what it names, `✔` on the model in use, and after two spaces or more
 * what it says of it, which a narrow pane wraps under itself at the same column. The rows drawn
 * are a window on the list: `↑` and `↓` stand in the cursor's column on the first and last of
 * them when more lie beyond, and `… +2 models` counts the ones below. Only the rows drawn become
 * options, the rest are counted for the card to say so.
 *
 * The line under the rows is the effort the pick would run at. It follows the cursor (a model's
 * own default, or the session's when one was set), so it is no part of what the card asks.
 */
const CLAUDE_MODEL_ROW_RE = /^\s*([❯›>↑↓])?\s*(\d+)\.\s+(\S.*)$/;
const CLAUDE_MODEL_MORE_RE = /^…\s*\+(\d+) models?$/;
/** lines between the rows and the hint, at most: the effort line, wrapped by a narrow pane */
const CLAUDE_MODEL_UNDER_LINES = 3;

interface ListRow {
  number: number; cursor: boolean;
  /** `↑` or `↓` in the cursor's column: the window's first or last row, with more of the list beyond it */
  edge: string | null;
  /** the row after its number, as drawn */
  text: string;
  /** the first gap of two spaces or more in it: where it begins and ends in `text`, and the
   * terminal column the text after it is drawn at; -1 with no gap */
  gap: number; resumes: number; column: number;
  /** the lines wrapped under the row at that column */
  wrapped: string[];
}

/** A row of a numbered list: the cursor or a scroll mark, the row's number, then its text. */
function listRow(line: string, shape: RegExp): ListRow | null {
  const match = shape.exec(line);
  if (!match) return null;
  const text = match[3]!;
  const gap = /\s{2,}/.exec(text);
  return {
    number: Number.parseInt(match[2]!, 10), cursor: SELECTED_RE.test(match[1] ?? ""), edge: match[1] === "↑" || match[1] === "↓" ? match[1] : null,
    text, gap: gap?.index ?? -1, resumes: gap ? gap.index + gap[0].length : -1,
    // in the terminal's columns, as the lines wrapped under it are indented: a wide glyph in the name takes two
    column: gap ? Bun.stringWidth(line.slice(0, line.length - text.length + gap.index + gap[0].length)) : -1,
    wrapped: [],
  };
}

/**
 * Each row's name and what the row says of it. What the rows say stands in one column for the
 * whole list, so a gap at another column, or in one row alone, is part of that row's name
 * (`Custom  Model`). Wrapped lines are joined with a space, as most of them broke at one. A word
 * longer than its column is cut where the column ends (`longest-runni` / `ng tasks`) and stays
 * cut, as the pane shows it: a line that fills its column says nothing of whether a space was
 * there. Null: lines wrapped under a row whose gap was no column, so the rows are not as drawn.
 */
function listNames(rows: ListRow[]): { name: string; said: string | null }[] | null {
  const counts = new Map<number, number>();
  for (const row of rows) if (row.column >= 0) counts.set(row.column, (counts.get(row.column) ?? 0) + 1);
  const [column, count] = [...counts].sort((left, right) => right[1] - left[1])[0] ?? [-1, 0];
  const shared = count >= 2 ? column : -1;
  if (rows.some((row) => row.column !== shared && row.wrapped.length > 0)) return null;
  return rows.map((row) => shared >= 0 && row.column === shared
    ? { name: row.text.slice(0, row.gap), said: [row.text.slice(row.resumes), ...row.wrapped].join(" ") }
    : { name: normalizeText(row.text), said: null });
}

/**
 * The numbered rows right above a list's hint, read downward. A row that does not count on from
 * the one above it, that follows anything but its own wrapped text, or that carries the window's
 * `↑` starts the list again, and so does any row under the one that carries its `↓`: numbered
 * lines further up (an answer's own list) are nothing of this menu's.
 * `below`: the rows a line under them counts (`more`). `first` and `last`: the first row's line
 * and the last line that was the list's.
 * `unread`: a line under a row that is not its wrapped text (a name the pane cut in two), so the
 * rows are not the list as it was drawn.
 */
function listRows(lines: string[], hintIndex: number, shape: RegExp, more: RegExp | null): { rows: ListRow[]; below: number; first: number; last: number; unread: boolean } {
  let rows: ListRow[] = [];
  let below = 0;
  let ended = false;
  let unread = false;
  let first = -1;
  let last = -1;
  for (let index = Math.max(0, hintIndex - 80); index < hintIndex; index += 1) {
    const line = lines[index]!;
    const text = line.trim();
    const above = ended ? undefined : rows.at(-1);
    // what a row says, wrapped under itself: told by its column, before anything it happens to begin with
    if (above !== undefined && text !== "" && above.column >= 0 && line.length - line.trimStart().length === above.column) {
      above.wrapped.push(text);
      last = index;
      continue;
    }
    const row = listRow(line, shape);
    if (row) {
      if (above === undefined || row.number !== above.number + 1 || row.edge === "↑" || above.edge === "↓") [rows, first] = [[], index];
      rows.push(row);
      [below, ended, unread, last] = [0, false, false, index];
      continue;
    }
    if (above === undefined || text === "") { ended = true; continue; }
    const counted = more?.exec(text);
    if (counted) [below, ended, last] = [Number(counted[1]), true, index];
    else [ended, unread] = [true, true];
  }
  return { rows, below, first, last, unread };
}

/**
 * Codex's `/model` lists, live in 0.160.1 and as its source draws them
 * (tui/src/chatwidget/model_popups.rs, session_model_selection.rs):
 *
 *   Select Model and Effort                      Select Reasoning Level for GPT-6-Astra
 *
 *     1. GPT-6.1-Sol (default)  Latest workhorse…   1. Low                         Fast responses…
 *   › 2. GPT-6-Astra (current)  Frontier intelli… › 2. Medium (default) (current)  Balances speed…
 *     …                                             5. More reasoning…             Max and Ultra…
 *
 *     enter select · esc back                       enter default · s session · esc back
 *
 * and, behind "More reasoning…", `Advanced Reasoning` over `⚠ Consumes usage limits faster` with
 * Max and Ultra. herdr never reports the pane blocked while one waits (working, done), so the
 * card can only come from the screen.
 *
 * The footer is the row's own, not the list's. Under `enter select` Enter only opens the next
 * list. Under `enter default · s session` (`enter apply` on Ultra) the row picks: `s` for this
 * session, Enter to save the pick as the default for every new one. A model with a single
 * reasoning level picks from the first list already. So which key a row takes is only known
 * with the cursor on it: `rowKey` is that key for the row under the cursor now, and an answer
 * takes it from the screen it reads after its moves (the `pick` step).
 *
 * Enter is sent in one list only, the list of models, where a row opens that model's levels.
 * In a list of levels the row that opens a list ("More reasoning…") stands beside rows whose
 * Enter saves a default, and the look before a key and the key are two herdr calls: a key
 * pressed in the terminal between them would put an Enter meant for that row on a level. So
 * that row is not offered, and no row of those lists is answered with Enter: open the advanced
 * list in the terminal, then its levels can be picked from the card with `s`. The same gap
 * is left in the list of models, where it matters only
 * beside a model with a single level (issue #469 records it for every card).
 *
 * The list is known by its title, since `enter select · esc back` is the footer of every list
 * Codex draws. `Select Model`, the list of quick presets some accounts get first, was not
 * available to look at and gets no card. A pane too narrow for what a row says draws the names
 * alone, or wraps it under itself (the advanced list at 46 columns). The advanced list does not
 * name its model: two models' advanced lists read the same.
 */
const CODEX_MODEL_ROW_RE = /^\s*([❯›>])?\s*(\d+)\.\s+(\S.*)$/;
/** lines Codex puts under a list's title, at most: what the list is for, a warning */
const CODEX_MODEL_NOTE_LINES = 2;
/** how far back a footer is looked for, including words split across very narrow lines */
const CODEX_MODEL_TAIL_LINES = 30;
// Key names a list hint can display, including remapped keys. Restrict the key field so
// ordinary words before a real footer cannot become a fictitious key name after joining lines.
const CODEX_LIST_KEY_HINT = String.raw`(?:(?:ctrl|alt|shift|cmd|super)\+)*(?:enter|return|tab|space|esc|escape|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f\d{1,2}|[a-z0-9])`;
const CODEX_MODEL_GUARD_HINT_RE = new RegExp(`^${CODEX_LIST_KEY_HINT}(?:select|default|apply|confirm)·(?:ssession·)?${CODEX_LIST_KEY_HINT}back$`, "i");


/**
 * A Codex model list's title and the lines under it, from the block of lines right above the
 * rows (blank lines stand between the two). The title is looked for in that block alone: another
 * list's header under an older title is another list. A pane too narrow for the levels' title
 * wraps the model's name under it, and the two are read as one. Lines over the title are the
 * conversation's.
 */
function codexModelHeader(lines: string[], first: number, allowPresets = false): { title: string; model: string | undefined; notes: string[] } | null {
  let end = first - 1;
  while (end >= 0 && !cleanLine(lines[end]!)) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!)) start -= 1;
  const block = end < 0 ? [] : lines.slice(start, end + 1).map(cleanLine);
  const at = findLastIndex(block, (line) => /^(?:Select\b|Advanced Reasoning$)/.test(line));
  if (at < 0) return null;
  // the levels' title runs on to the end of the block when it wrapped; the others are one line
  const whole = /^Select Reasoning Level for(?: \S.*)?$/.test(block[at]!) ? block.slice(at).join(" ") : block[at]!;
  const match = CODEX_MODEL_TITLE_RE.exec(whole);
  const notes = whole === block[at] ? block.slice(at + 1) : [];
  return (match || (allowPresets && whole === "Select Model")) && notes.length <= CODEX_MODEL_NOTE_LINES ? { title: whole, model: match?.[1], notes } : null;
}

/** The key a Codex list's footer names for picking the row under the cursor; null for any other footer. */
function codexModelRowKey(footer: string): AnswerStep | null {
  if (CODEX_MODEL_PICK_HINT_RE.test(footer)) return { text: "s" };
  return CODEX_MODEL_OPEN_HINT_RE.test(footer) ? { keys: [KEY.enter] } : null;
}

/**
 * Whether a Codex model list holds the end of the screen, read or not: by the footer of a row
 * that picks, or by a model title over rows and a footer cut beyond the reader's limit. Such a
 * list gets no fallback card while herdr happens to report the pane blocked: that card offers
 * Enter, and Enter under a footer that offers `s` saves the row as the default for every new
 * session.
 */
function codexModelListWaits(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const shown = lines.map((line, index) => ({ text: cleanLine(line), index }))
    .filter(({ text }) => text && !isDivider(text)).slice(-CODEX_MODEL_TAIL_LINES);
  for (let start = 0; start < shown.length; start += 1) {
    // Join a footer split inside words by a very narrow pane. Anything printed after it
    // prevents the match, so an old title/footer in the transcript cannot hide a new prompt.
    const footer = shown.slice(start).map(({ text }) => text).join("").replace(/\s+/g, "");
    if (/^enter(?:default|apply)·ssession·escback$/i.test(footer)) return true;
    if (!CODEX_MODEL_GUARD_HINT_RE.test(footer)) continue;
    // The generic list footer needs a model header in the block immediately above its rows.
    // Quick presets are recognized only by this guard, never offered as a readable card.
    const { rows, first, last } = listRows(lines, shown[start]!.index, CODEX_MODEL_ROW_RE, null);
    const intervening = lines.slice(last + 1, shown[start]!.index).some((line) => cleanLine(line) && !isDivider(cleanLine(line)));
    if (rows.length > 0 && !intervening && codexModelHeader(lines, first, true) !== null) return true;
  }
  return false;
}

function parseCodexModel(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (_, index) => codexModelRowKey(wrapped(lines, index)) !== null);
  if (hintIndex < 0) return null;
  const { rows, first, last, unread } = listRows(lines, hintIndex, CODEX_MODEL_ROW_RE, null);
  // the rows end right over their footer, and one of them carries the cursor
  if (unread || rows.length < 2 || rows.filter((row) => row.cursor).length !== 1 || lines.slice(last + 1, hintIndex).some((line) => line.trim() !== "")) return null;
  const header = codexModelHeader(lines, first);
  const names = listNames(rows);
  if (header === null || names === null) return null;
  const drawn = names.map(({ name, said }) => ({ label: name.replace(/\s*\(current\)$/, ""), description: said }));
  const selectedIndex = rows.findIndex((row) => row.cursor);
  const footer = codexModelRowKey(wrapped(lines, hintIndex))!;
  const opens = footer.keys !== undefined;
  // the list of models, where a row opens a model's levels and Enter is its key
  const models = header.title === "Select Model and Effort";
  // elsewhere a row that only opens a list is left to the terminal: the one Codex names so, and
  // the one under the cursor when its footer says so
  const offered = rows.flatMap((_, row) => !models && (CODEX_MODEL_MORE_ROW_RE.test(drawn[row]!.label) || (row === selectedIndex && opens)) ? [] : [row]);
  if (offered.length === 0) return null;
  const current = names.findIndex(({ name }) => /\s\(current\)$/.test(name));
  // "Medium (default)" in use reads as Medium: the tag is the list's, not the level's name
  const now = current >= 0 ? ` (currently ${drawn[current]!.label.replace(/\s*\(default\)$/i, "")})` : "";
  const asked = header.title === "Advanced Reasoning" ? "Select advanced reasoning for this session"
    : header.model !== undefined ? `Select reasoning level for ${header.model} for this session` : "Select model for this session";
  return finishPrompt("codex", {
    kind: "question",
    title: "",
    question: `${asked}${now}${offered.length < rows.length ? ". More levels are listed in the terminal." : ""}`,
    body: header.notes.join("\n") || null,
    options: offered.map((row) => drawn[row]!),
    multi_select: false,
    custom_option_index: null,
  }, {
    // every row drawn, by its list, its number and what it says (the reasoning list of another
    // model has the same rows): the cursor moves among all of them, offered or not
    responder: "codex-model", menuLabels: rows.map((row, index) => `${header.title}  ${row.number}. ${drawn[index]!.label}  ${drawn[index]!.description ?? ""}`), selectedIndex,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: offered.map((row) => [...keySteps(navigationKeys(row - selectedIndex)), { pick: true as const }]),
    // Enter in the list of models alone; `s` wherever the footer offers it; no key otherwise
    rowKey: opens ? models ? footer : null : footer,
  });
}

/**
 * Whether a model list of Claude Code's or Codex's holds the end of the screen, read or not. Enter
 * there saves a default, so nothing that ends in Enter is typed while one is open.
 */
export function modelListWaits(agent: string, screen: string): boolean {
  return claudeModelListWaits(screen) || claudeModelListWaits(screen, CLAUDE_EFFORT_GUARD_RE) || (agent === "codex" && codexModelListWaits(screen));
}

/**
 * Whether Claude Code's model list holds the end of the screen, by its hint alone: also a list
 * parseClaudeModel could not read (a name the pane cut in two). Such a list gets no fallback card
 * while herdr happens to report the pane blocked: that card offers Enter, and Enter on this list
 * saves the row under the cursor as the default for every new session. `hint`: the effort slider's
 * instead, whose Enter saves a default the same way.
 */
function claudeModelListWaits(screen: string, hint: RegExp = CLAUDE_MODEL_HINT_RE): boolean {
  const visible = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter((line) => line && !isDivider(line));
  // wider than the reader's own window: a hint wrapped further than it reads is still this list's.
  // The match runs into the line it ends at, as in promptTailIsActive: a hint that ended above
  // later output is an answered list's, and holds nothing
  const ends = (lines: string[], end: number): boolean => [1, 2, 3, 4, 5, 6].some((span) => {
    const from = Math.max(0, end - span);
    return hint.test(lines.slice(from, end).join(" ")) && (span === 1 || !hint.test(lines.slice(from, end - 1).join(" ")));
  });
  // Claude's own footer under the open list (the session's rule, its task list) is no later
  // output, and it sits under a wrapped hint as under a whole one
  const shown = withoutClaudeTasks(visible, ends);
  return ends(shown, shown.length);
}

function parseClaudeModel(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_MODEL_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const { rows, below, last, unread } = listRows(lines, hintIndex, CLAUDE_MODEL_ROW_RE, CLAUDE_MODEL_MORE_RE);
  const under = lines.slice(last + 1, hintIndex).filter((line) => line.trim() !== "").length;
  const selectedIndex = rows.findIndex((row) => row.cursor);
  if (unread || under > CLAUDE_MODEL_UNDER_LINES || rows.length < 2 || rows.filter((row) => row.cursor).length !== 1) return null;
  const names = listNames(rows);
  if (names === null) return null;
  const options = names.map(({ name, said }) => ({ label: name.replace(/\s*[✔✓]$/, ""), description: said }));
  // counted, not named: the rows above the window (the list counts from 1) and the ones below it
  const hidden = rows[0]!.number - 1 + below;
  const current = names.findIndex(({ name }) => /\s[✔✓]$/.test(name));
  // "Default (recommended)" in use reads as Default: the tag is the list's advice, not the model's name
  const asked = `Select model for this session${current >= 0 ? ` (currently ${options[current]!.label.replace(/\s*\(recommended\)$/i, "")})` : ""}`;
  return finishPrompt("claude", {
    kind: "question",
    title: "",
    question: hidden > 0 ? `${asked}. ${hidden} more ${hidden === 1 ? "model is" : "models are"} listed in the terminal.` : asked,
    body: null,
    options,
    multi_select: false,
    custom_option_index: null,
  }, {
    // a row by its number in the whole list and by what it says too: the window moves, two rows
    // may share a name, and a list by family names the model itself only in what the row says
    responder: "claude-model", menuLabels: rows.map((row, index) => `${row.number}. ${options[index]!.label}  ${options[index]!.description ?? ""}`), selectedIndex,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    // `s`, never Enter: the pick stays in this session, and the default for new ones is left alone
    optionSteps: rows.map((_, index) => [...keySteps(navigationKeys(index - selectedIndex)), { text: "s" }]),
  });
}

/**
 * Claude Code's `/effort` slider, as 2.1.294 draws it:
 *
 *   Effort
 *
 *                Faster                             Smarter
 *                ────────────────────▲─────────────────────      Ultracode  off
 *                low     medium     high     xhigh      max      Tab to toggle
 *
 *
 *   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
 *
 * ▲ stands over the level the slider is on. The levels are the card's options, picked with ←/→
 * and `s`, never Enter. Ultracode is left to the terminal.
 */
const CLAUDE_EFFORT_LEVEL_RE = /\b(?:low|medium|high|xhigh|max)\b/g;
/** how far ▲ may stand from the middle of a level's name and still be over it */
const CLAUDE_EFFORT_ALIGN = 3;
/** blank lines between the level names and the hint, at most */
const CLAUDE_EFFORT_UNDER_LINES = 3;

function parseClaudeEffort(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_EFFORT_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  let labelsIndex = hintIndex - 1;
  while (labelsIndex > 0 && lines[labelsIndex]!.trim() === "") labelsIndex -= 1;
  const labels = lines[labelsIndex] ?? "";
  const track = lines[labelsIndex - 1] ?? "";
  const scale = /^\s*[─▲]+/.exec(track)?.[0] ?? "";
  const titled = lines.slice(Math.max(0, labelsIndex - 4), Math.max(0, labelsIndex - 1)).some((line) => line.trim() === "Effort");
  // a line of level names and nothing else (the toggle's hint aside), cut or wrapped by a narrow pane: not read
  const onlyLevels = labels.replace(CLAUDE_EFFORT_LEVEL_RE, "").replace(/Tab to toggle/i, "").trim() === "";
  // two blank lines stand between the level names and the hint as Claude draws it
  if (hintIndex - labelsIndex > CLAUDE_EFFORT_UNDER_LINES + 1 || !titled || !onlyLevels || scale.split("▲").length !== 2) return null;
  const arrow = track.indexOf("▲");
  const levels = [...labels.matchAll(CLAUDE_EFFORT_LEVEL_RE)].map((match) => ({ name: match[0], middle: match.index + match[0].length / 2 }));
  if (levels.length < 2 || new Set(levels.map(({ name }) => name)).size !== levels.length) return null;
  const distance = (index: number) => Math.abs(levels[index]!.middle - arrow);
  const selectedIndex = levels.reduce((best, _, index) => distance(index) < distance(best) ? index : best, 0);
  if (distance(selectedIndex) > CLAUDE_EFFORT_ALIGN) return null;
  const names = levels.map(({ name }) => name);
  return finishPrompt("claude", {
    // where the slider stands is no part of what the card asks: one card wherever ▲ is
    kind: "question",
    title: "",
    question: "Set effort for this session",
    body: null,
    options: names.map((label) => ({ label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "claude-effort", menuLabels: names, selectedIndex,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    // `s`, never Enter: the level stays in this session, and the default for new ones is left alone
    optionSteps: names.map((_, index) => [...keySteps(sliderKeys(index - selectedIndex)), { text: "s" }]),
  });
}

/**
 * Claude Code keeps its task list under an open panel (2.1.289): a rule with the session's name
 * on it, `3 tasks (0 done, 1 in progress, 2 open)`, a row per task (◻ ◼ ✔), an in-progress task's
 * activity (`…`) and `… +2 pending`. Cut off, the panel is the last thing on screen again.
 *
 * Only Claude's own footer goes, and only where it sits directly under the panel's hint: the
 * list holds task rows, the activity under a task in progress and the pending count, nothing
 * else. The agent's answer to the question, a shell's prompt or a rule of another program under
 * the hint keep the panel what it is then: answered, with its keys owed to no one.
 */
const CLAUDE_TASKS_HEAD_RE = /^(\d+) tasks \(\d+ done, (?:\d+ in progress, )?\d+ open\)$/;
const CLAUDE_TASK_ROW_RE = /^[◻◼✔]\s/;
const CLAUDE_TASKS_MORE_RE = /^…\s\+\d+ pending$/;
const LABELED_RULE_RE = /^─{3,}\s.*─$/;
const CLAUDE_HINT_TAIL_RE = /\besc to (?:cancel|exit|go back)\b/i;
/** `hintEnds`: whether the panel's hint ends at line `end`; a hint a narrow pane wrapped needs its own reading */
function withoutClaudeTasks(shown: string[], hintEnds: (lines: string[], end: number) => boolean = (lines, end) => CLAUDE_HINT_TAIL_RE.test(lines[end - 1] ?? "")): string[] {
  let end = shown.length;
  const head = findLastIndex(shown, (line) => CLAUDE_TASKS_HEAD_RE.test(line));
  if (head >= 0) {
    const total = Number(CLAUDE_TASKS_HEAD_RE.exec(shown[head]!)![1]);
    let rows = 0;
    let inProgress = false;
    let list = true;
    for (let index = head + 1; index < shown.length && list; index += 1) {
      const line = shown[index]!;
      if (CLAUDE_TASK_ROW_RE.test(line)) { rows += 1; inProgress = line.startsWith("◼"); }
      else if (CLAUDE_TASKS_MORE_RE.test(line)) list = index === shown.length - 1;
      // the activity under the task in progress: one line, ending in an ellipsis, no prompt or bullet of its own
      else if (inProgress && line.endsWith("…") && !/^[❯>›●⏺]/.test(line)) inProgress = false;
      else list = false;
    }
    if (list && rows > 0 && rows <= total) end = head;
  }
  // the session's rule is drawn above the list, and with no task list too
  if (LABELED_RULE_RE.test(shown[end - 1] ?? "")) end -= 1;
  return end < shown.length && hintEnds(shown, end) ? shown.slice(0, end) : shown;
}

function promptTailIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const cleanLines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  const visible = cleanLines.filter((line) => line && !isDivider(line));
  const shown = prompt.responder.startsWith("claude-") ? withoutClaudeTasks(visible) : visible;
  const last = shown.at(-1) ?? "";
  // The menu is still at the bottom. A narrow pane wraps its hint, so the last line alone can
  // be the hint's tail (`cancel`): the lines before it count only when the match runs into
  // the last one, never for a hint that ended above later output (an answered, stale menu).
  const ends = (re: RegExp): boolean => [1, 2, 3].some((span) =>
    re.test(shown.slice(-span).join(" ")) && (span === 1 || !re.test(shown.slice(-span, -1).join(" "))));
  if (prompt.responder === "omp-question") return ends(OMP_SINGLE_HINT_RE) || ends(OMP_MULTI_HINT_RE);
  if (prompt.responder === "codex-menu") return ends(CODEX_CONTINUE_HINT_RE);
  if (prompt.responder === "codex-question") return ends(CODEX_ASK_HINT_RE);
  if (prompt.responder === "codex-async-question") return cleanLines.slice(-4).some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line)) || ends(CODEX_ASYNC_ASK_HINT_RE);
  if (prompt.responder === "claude-question") return ends(CLAUDE_ASK_HINT_RE);
  if (prompt.responder === "claude-submit") return /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i.test(last);
  // the last row carries the cursor once a move has put it there
  if (prompt.responder === "codex-approval") return ends(/press enter to confirm|esc to cancel|enter continue.*esc back|^(?:[›>❯]\s*)?\d+\.\s+(?:No|Reject|Cancel|Deny)\b/i);
  if (prompt.responder === "omp-approval") return ends(/^(?:[›>❯•]\s*)?(?:Approve|Deny)$|esc.*cancel/i);
  if (prompt.responder === "claude-approval") return ends(/esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain/i);
  if (prompt.responder === "claude-confirm") return ends(CLAUDE_CONFIRM_HINT_RE);
  // its parser already found the hint over the input box with only the footer under it
  if (prompt.responder === "claude-held") return true;
  if (prompt.responder === "claude-model") return ends(CLAUDE_MODEL_HINT_RE);
  if (prompt.responder === "claude-effort") return ends(CLAUDE_EFFORT_HINT_RE);
  if (prompt.responder === "codex-model") return ends(/(?:^|\s)enter select\s*·\s*esc back$|(?:^|\s)enter (?:default|apply)\s*·\s*s session\s*·\s*esc back$/i);
  if (prompt.responder === "omo-question" || prompt.responder === "omo-review" || prompt.responder === "omo-typing") {
    // The form is live only with nothing but OmO's own footer under its hint: blank lines, one
    // rule, then the footer's few lines (cwd, context, model). Anything else is the form's text
    // in another program (printed in a shell, quoted in a transcript over an input box), where
    // an answer's keys would be typed into that program.
    const hint = { "omo-question": OMO_OPTIONS_HINT_RE, "omo-review": OMO_REVIEW_HINT_RE, "omo-typing": OMO_TYPING_HINT_RE }[prompt.responder];
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && hint.test(wrapped(cleanLines, index, OMO_HINT_LINES)));
    if (at < 0) return false;
    let end = at;
    while (end < at + OMO_HINT_LINES && !OMO_HINT_END_RE.test(cleanLines.slice(at, end + 1).join(" ").trim())) end += 1;
    if (end >= at + OMO_HINT_LINES) return false;
    let rules = 0;
    let footer = 0;
    for (const line of cleanLines.slice(end + 1)) {
      if (!line) continue;
      if (SOLID_RULE_RE.test(line)) {
        if (rules > 0 || footer > 0) return false;
        rules = 1;
      } else if (rules === 0 || ++footer > OMO_FOOTER_LINES || OMO_NOT_FOOTER_RE.test(line)) return false;
    }
    return rules === 1;
  }
  if (prompt.responder === "omo-pending") {
    // The widget is live over OmO's input box, other widgets maybe between them: the box (a rule,
    // the box's line, empty, a rule) and then nothing but OmO's footer.
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && OMO_PENDING_HINT_RE.test(wrapped(cleanLines, index)));
    const box = cleanLines.findIndex((line, index) => index > at && OMO_EMPTY_BOX_RE.test(line));
    if (at < 0 || box < 0 || box - at > 60 || !cleanLines[box - 1]!.startsWith("─")) return false;
    let rules = 0;
    let footer = 0;
    for (const line of cleanLines.slice(box + 1)) {
      if (!line) continue;
      if (SOLID_RULE_RE.test(line)) {
        if (rules > 0 || footer > 0) return false;
        rules = 1;
      } else if (rules === 0 || ++footer > OMO_FOOTER_LINES || OMO_NOT_FOOTER_RE.test(line)) return false;
    }
    return rules === 1;
  }
  // pi keeps its footer under every dialog — the pane's folder, then its context meter — so the
  // hint sits near the end without being it. A dialog already answered leaves its hint far
  // above whatever came after, which is what keeps this window narrow.
  if (prompt.responder === "pi-model") return hintAtEnd(shown, PI_MODEL_HINT_AT_END_RE, PI_FOOTER_LINES);
  if (prompt.responder === "pi-question" || prompt.responder === "pi-confirm" || prompt.responder === "pi-input") {
    return hintAtEnd(shown, PI_MENU_HINT_AT_END_RE, PI_FOOTER_LINES, 4)
      || hintAtEnd(shown, PI_INPUT_HINT_AT_END_RE, PI_FOOTER_LINES, 4);
  }
  return ends(/ctrl\+g to edit|shift\+tab to approve with this feedback/i);
}

/**
 * pi draws one menu widget for its dialogs — an extension's `ctx.ui.select`, `confirm` and
 * `input`, and the selectors `/login` and `/scoped-models` open — and names what it takes in a
 * hint line at the dialog's end: `↑↓ navigate  enter select  escape/ctrl+c cancel`, or
 * `enter submit  escape/ctrl+c cancel` while it wants text. Read off that hint, not off
 * indentation: a confirm's message sits indented beside its options, so a row is told from
 * prose only by the hint that follows it. `/tree` is left alone on purpose: its hint says
 * `↑/↓ move`, and answering it from the chat would move the session's branch, which the chat
 * has no way to undo by clicking. pi never reports itself blocked for a dialog — it stays idle
 * while one waits — so the card can only come from the screen, as it does for the other agents.
 */
const PI_MENU_HINT_RE = /\u2191\u2193 navigate\s+enter select\s+escape\/ctrl\+c cancel/i;
const PI_INPUT_HINT_RE = /enter submit\s+escape\/ctrl\+c cancel/i;
/**
 * The same two hints told from the end of the window. A phone leaves pi a pane barely wide enough
 * for its hint, which wraps it, and pi keeps its footer underneath: the wrapped hint then sits
 * further from the bottom than a three-line window reaches, while a wider pane still has it as the
 * last thing. Anchored, because the footer's own lines complete a join that merely starts with the
 * hint's words, which would keep an answered dialog offering to press keys into the pane.
 */
const PI_MENU_HINT_AT_END_RE = new RegExp(`${PI_MENU_HINT_RE.source}$`, "i");
const PI_INPUT_HINT_AT_END_RE = new RegExp(`${PI_INPUT_HINT_RE.source}$`, "i");
/** the line pi types an answer into */
const PI_INPUT_LINE_RE = /^[\u203a>\u276f]+\s*(.*)$/;
/** a menu row: pi's cursor, an optional tick marking the current choice, then the label */
const PI_ROW_RE = /^([\u2192\u276f\u279c])?\s*(?:[\u2713\u2714]\s+)?(\S.*)$/;

/**
 * `/model` draws a widget of its own, not the one above: `Enter to select · Ctrl+S to set as
 * default · Escape/Ctrl+C to cancel`. It carries no `↑↓ navigate`, so the menu reader cannot
 * see it, and its list is the provider catalogue — every model pi can answer with, each with
 * the provider that serves it. The cursor starts on the model in use, which is not the first
 * row once another one is current, so the position is read rather than assumed.
 */
const PI_MODEL_HINT_RE = /enter to select\s*·\s*ctrl\+s to set as default\s*·\s*escape\/ctrl\+c to cancel/i;
/** The same hint told from the end, so lines that follow it cannot complete a match of their own. */
const PI_MODEL_HINT_AT_END_RE = new RegExp(`${PI_MODEL_HINT_RE.source}$`, "i");
/**
 * pi's own footer, under `/model` and under every dialog alike: the pane's folder, then its
 * context meter. A hint is allowed this many lines of it before the bottom of the screen.
 */
const PI_FOOTER_LINES = 2;

/**
 * Whether a hint is the last thing before an agent's footer, allowing for a phone's pane being
 * too narrow to hold it on one line: a TUI hard-wraps, so the hint arrives split over two or
 * three lines with nothing marking the break. Anchored to the end of the joined window, because
 * a hint's words also match a join that merely starts with them — the footer's own lines read as
 * a hint that way, which would keep an answered, buried list offering a switch into whatever the
 * pane shows by then.
 */
function hintAtEnd(shown: string[], atEnd: RegExp, footerLines: number, span = 3): boolean {
  for (let end = shown.length - 1; end >= Math.max(0, shown.length - 1 - footerLines); end -= 1) {
    for (let size = 1; size <= span; size += 1) {
      const from = end - size + 1;
      if (from < 0) break;
      if (atEnd.test(shown.slice(from, end + 1).join(" "))) return true;
    }
  }
  return false;
}
/** `/model` types a filter into this line, then lists what is left under it */
const PI_MODEL_FILTER_RE = /^[\u203a>\u276f]\s*$/;
/** pi ticks the model answering now, and marks the one it starts on with `· default` */
const PI_MODEL_CURRENT_RE = /[\u2713\u2714]/;
const PI_MODEL_DEFAULT_RE = /\s*\u00b7\s*default$/;

/**
 * The rows a dialog takes its answer from, and its own words over them. pi separates the two
 * with a blank line and ends the block with its hint, so the run of lines directly above the
 * hint is what its arrow keys move through, and what sits above the blank over it is what the
 * dialog asks. The rule over the dialog is no use for this: it stands over the whole thing,
 * title included, and a confirm indents its message level with its own options.
 *
 * A pane narrower than an option wraps it, and the rest of the label lands on a line of its own.
 * pi sets a row three columns in (` → ` on the cursor's, three spaces on the others) and the
 * wrapped rest one column in, which is all that tells them apart: read as a row of its own, the
 * rest became one more option, and tapping it pressed Down once more than pi has rows, onto the
 * option after it (measured on pi 0.87.1 at 46 columns). The title and a confirm's message wrap
 * the same way, so they are read as one run of lines, the title first.
 */
const PI_WRAPPED_REST_RE = /^ (?![\u2192\u276f\u279c])\S/;
function piDialogRows(lines: string[], hintIndex: number): { rows: { line: string; cursor: boolean }[]; title: string[] } {
  const rows: { line: string; cursor: boolean }[] = [];
  let index = hintIndex - 1;
  while (index >= 0 && !cleanLine(lines[index]!)) index -= 1;
  // read upwards, so the wrapped rest of a row is met before the row it belongs to
  let rest: string[] = [];
  for (; index >= 0; index -= 1) {
    const raw = lines[index]!.replace(ANSI_RE, "");
    const line = cleanLine(raw);
    if (!line || isDivider(line)) break;
    if (PI_WRAPPED_REST_RE.test(raw)) { rest.unshift(line); continue; }
    rows.unshift({ line: [line, ...rest].join(" "), cursor: /^[\u2192\u276f\u279c]\s*\S/.test(line) });
    rest = [];
  }
  // lines one column in with no row over them are not a wrapped option: they stand as they are,
  // for the caller to refuse (the slash palette's own first line, for one)
  rows.unshift(...rest.map((line) => ({ line, cursor: false })));
  const title: string[] = [];
  // the run of lines right over the rows' blank: past the next blank is whatever the pane showed before
  for (; index >= 0 && title.length < 8; index -= 1) {
    if (isDivider(lines[index]!)) break;
    const line = cleanLine(lines[index]!);
    if (!line) {
      if (title.length > 0) break;
      continue;
    }
    title.unshift(line);
  }
  return { rows, title };
}

/** a catalogue row names the provider serving the model, in brackets */
const PI_MODEL_PROVIDER_RE = /\[[^\]]+\]/;
/** the tail of a model's name a narrow pane wrapped onto its own line: only the provider's bracket */
const PI_MODEL_TAIL_RE = /^\[[^\]]+\](\s*\u00b7\s*default)?$/;

/**
 * The catalogue `/model` lists under its filter line: every row names its provider in brackets,
 * which is what tells it from pi's own notes, since `Model Name: qwen-3-8` sits indented among
 * the rows and `Could not refresh llama.cpp; showing cached models.` under them. The run ends at
 * the first line that is not a row. In a pane narrower than a model's name the row wraps: the
 * wrap is joined back first, and a row that still ends without its provider voids the reading,
 * because offering half a name would switch pi to a model that does not exist.
 */
function piModelRows(lines: string[], startIndex: number): { label: string; cursor: boolean; current: boolean }[] | null {
  const rows: { label: string; cursor: boolean; current: boolean }[] = [];
  // pi leaves a blank between its filter line and what still matches it
  let start = startIndex;
  while (start < lines.length && !cleanLine(lines[start]!)) start += 1;
  // A phone leaves pi a pane barely wider than a model's name, which wraps it and drops the
  // provider's bracket — the one mark that tells a row from a note — onto the next line at column
  // zero, where it reads exactly like a note. Join such a tail back onto the line it wrapped from
  // before reading any row, so the row keeps the name pi would answer with and the bracket that
  // proves it, and the rules below see the same rows a wide pane shows. A blank between the two
  // rules the tail out: pi separates what it means as its own line with a blank.
  const block: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index]!.replace(ANSI_RE, "");
    const line = cleanLine(raw);
    const previous = block.at(-1);
    if (previous !== undefined && cleanLine(previous) && !PI_MODEL_PROVIDER_RE.test(cleanLine(previous))
      && /^ {0,1}\S/.test(raw) && PI_MODEL_TAIL_RE.test(line)) {
      block[block.length - 1] = `${previous} ${line}`;
      continue;
    }
    block.push(raw);
  }
  // A row cut before its provider bracket closes is a catalogue still being drawn, not a note.
  // pi's own notes ("Model Name: …", "Refreshing model catalogs…") are indented lines with no
  // bracket at all, and they end the list without voiding it; an unclosed `[` is the one mark that
  // tells the two apart, and it means the rows above are a prefix of a list pi has not finished
  // writing. Offering that prefix would let a reader count down into rows that do not exist.
  const cutMidBracket = (line: string) => line.includes("[") && !PI_MODEL_PROVIDER_RE.test(line);
  for (const raw of block) {
    const line = cleanLine(raw);
    if (!line || isDivider(line) || PI_MODEL_HINT_RE.test(line)) break;
    const cursor = /^[\u2192\u276f\u279c]\s*\S/.test(line);
    if (!cursor && !/^ {2,}/.test(raw)) break;
    const label = line.match(PI_ROW_RE)?.[2]?.trim();
    if (!label || !PI_MODEL_PROVIDER_RE.test(label) || /\s{2,}/.test(label)) {
      if (cutMidBracket(line)) return null;
      break;
    }
    rows.push({ label, cursor, current: PI_MODEL_CURRENT_RE.test(raw) });
  }
  // A name wrapped in the middle of its bracket is not a model pi can be switched to, and joining
  // what is left would invent one, so any row still missing its provider voids the whole reading.
  if (!rows.every((row) => PI_MODEL_PROVIDER_RE.test(row.label))) return null;
  return rows.length >= 2 && rows.some((row) => row.cursor) ? rows : null;
}

function parsePiModel(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => PI_MODEL_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  // the filter line is the anchor: the catalogue is what sits under it, and anything above
  // belongs to whatever the pane showed before `/model` was typed
  const filterIndex = findLastIndex(lines.slice(0, hintIndex), (line) => PI_MODEL_FILTER_RE.test(cleanLine(line)));
  if (filterIndex < 0) return null;
  const rows = piModelRows(lines, filterIndex + 1);
  if (rows === null) return null;
  const selectedIndex = rows.findIndex((row) => row.cursor);
  const labels = rows.map((row) => row.label);
  // the card names the model answering now, because the answer switches it and whoever taps
  // should know what they are switching from; pi's tick is the only mark that says so
  const current = rows.find((row) => row.current);
  const question = current
    ? `Select model (currently ${current.label.replace(PI_MODEL_DEFAULT_RE, "")})`
    : "Select model";
  return finishPrompt("pi", {
    kind: "question",
    title: "",
    question,
    body: null,
    options: labels.map((label) => ({ label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "pi-model", menuLabels: labels, selectedIndex, checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

function parsePiDialog(screen: string, moved = false): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => PI_MENU_HINT_RE.test(wrapped(lines, index)) || PI_INPUT_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const block = piDialogRows(lines, hintIndex);
  if (block.rows.length === 0) return null;
  // the first line is the dialog's own; what follows is a confirm's message, or more of a wrapped line
  const title = block.title[0];
  const body = block.title.length > 1 ? block.title.slice(1).join(" ") : undefined;
  // pi wants text on a `>` line: there is nothing to pick, and the answer is typed into it
  if (PI_INPUT_HINT_RE.test(wrapped(lines, hintIndex))) {
    if (!block.rows.every((row) => PI_INPUT_LINE_RE.test(row.line))) return null;
    return finishPrompt("pi", {
      kind: "question", title: body ?? "", question: title ?? "", body: null,
      options: [{ label: "Type your answer", description: null }], multi_select: false, custom_option_index: 0,
    }, { responder: "pi-input", menuLabels: [], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 0, rejectWithEscapeIndex: null });
  }
  // every line of the block must be a row, and a row must be a single label: pi sets its
  // command palette out in two columns, and offering those as options would run a slash
  // command on a click. The palette ends in a row count of its own, not this hint.
  const rows = block.rows.map((row) => row.line.match(PI_ROW_RE)).filter((row): row is RegExpMatchArray => row !== null && row[2] !== undefined);
  if (rows.length !== block.rows.length || rows.length < 2) return null;
  if (rows.some((row) => /\s{2,}/.test(row[2]!))) return null;
  // a dialog moved through by hand sits wherever its last key left the cursor, and the chat
  // would then navigate from a position it cannot see. `moved`: an answer's own keys moved it,
  // and the read before its Enter looks where it stands (the answer route)
  const cursor = block.rows.findIndex((row) => row.cursor);
  if (moved ? cursor < 0 : cursor !== 0) return null;
  // Yes/No reads as a confirmation; anything else is a question asked among its options
  const labels = rows.map((row) => row[2]!.trim());
  const confirming = labels.length === 2 && /^yes\b/i.test(labels[0]!) && /^no\b/i.test(labels[1]!);
  return finishPrompt("pi", {
    kind: confirming ? "approval" : "question",
    title: confirming ? (title ?? "") : "",
    // a select has a title alone: a second line is the rest of it, wrapped
    question: confirming ? (body ?? title ?? "") : block.title.join(" "),
    body: null,
    options: labels.map((label) => ({ label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: confirming ? "pi-confirm" : "pi-question",
    menuLabels: block.rows.map((row) => row.line),
    selectedIndex: cursor, checkedOptionIndices: [], customMenuIndex: null,
    // "No" is pressed, not cancelled: pi's own Yes/No answers the question false, which is
    // what a confirmation means, where Escape would leave it unanswered
    rejectWithEscapeIndex: null,
  });
}

function parsePrompt(agent: string, screen: string, omoAsk: OmoAsk | null = null, omoTrusted = true, omoOpen: OmoAsk[] = [], sent: string | null = null, working = false): ParsedPrompt | null {
  const omo = () => {
    const forms = (ask: OmoAsk | null, trusted: boolean) => [parseOmoQuestion(screen, ask, trusted), parseOmoTyping(screen, ask, trusted), parseOmoReview(screen, ask, trusted)];
    const matched = omoOpen.flatMap((ask) => forms(ask, false)).filter((form) => form !== null);
    return [...(omoOpen.length > 0 ? matched.length === 1 ? matched : [] : forms(omoAsk, omoTrusted)), parseOmoPending(screen, omoOpen)];
  };
  const candidates = agent === "codex"
    ? [parseCodexContinueMenu(screen), parseCodexQuestion(screen), parseCodexAsyncQuestion(screen), parseCodexApproval(screen), parseCodexModel(screen)]
    : agent === "omp"
      ? [parseOmpQuestion(screen), parseOmpApproval(screen)]
      // herdr names an omo pane `pi` while omo waits (or no agent at all, as it can for an omo
      // started in the pane's shell), `claude` while its claude-sdk child runs. A pane named
      // `pi` reads pi's own dialogs first: pi's hint is its own, so an omo form never matches
      // it and falls through to omo()'s parsers.
      : agent === "claude"
        ? [parseClaudeQuestion(screen), parseClaudeSubmit(screen), parseClaudeApproval(screen), parseClaudeConfirm(screen), parseClaudeModel(screen), parseClaudeEffort(screen), parseClaudeHeld(screen, sent, working), ...omo()]
        : agent === "pi"
          ? [parsePiModel(screen), parsePiDialog(screen), ...omo()]
        : agent === "omo" || agent === ""
          ? omo()
          : [];
  return candidates.find((candidate): candidate is ParsedPrompt => candidate !== null && promptTailIsActive(candidate, screen)) ?? null;
}

/**
 * Codex 0.156 holds the questions it asked with request_user_input_async in a queue above
 * its main prompt, collapsed to "? 2 questions / alt+↑ to answer", and herdr reports the
 * agent blocked meanwhile. Yet the main prompt has the input and takes a message (Codex
 * then drops the questions). True only for that collapsed queue with the main prompt (›)
 * right under it and no other prompt on screen: an open question (its "enter submit …
 * skip" hint) or an approval below the queue holds the input itself.
 */
export function codexQuestionsCollapsed(screen: string): boolean {
  return parsePrompt("codex", screen) === null && queuedQuestionCount(screen) > 0;
}

/** The card for Codex's collapsed queue on this screen, from the rollout's unanswered questions. */
export function codexQueuedPrompt(screen: string, unanswered: QueuedQuestion[], front: QueueFront | null = null): InteractivePrompt | null {
  const count = queuedQuestionCount(screen);
  const queued = count > 0 ? queuedPrompt(count, unanswered, front) : null;
  return queued ? publicPrompt(queued) : null;
}

/**
 * `omoAsk`: the call an omo pane's session waits on (pendingOmoAsk), for its form's own text.
 * `omoTrusted` false: an omo form on the screen counts only when that call matches it.
 * `omoOpen`: every question the session has open (openOmoAsks), for omo's widget of the ones
 * asked without waiting.
 */
/** `sent`: what the chat last sent to the pane, and `working`: whether its agent is under a turn, for a message Claude Code holds back (parseClaudeHeld) */
export function parseInteractivePrompt(agent: string, screen: string, omoAsk: OmoAsk | null = null, omoTrusted = true, omoOpen: OmoAsk[] = [], sent: string | null = null, working = false): InteractivePrompt | null {
  const parsed = parsePrompt(agent, screen, omoAsk, omoTrusted, omoOpen, sent, working);
  return parsed ? publicPrompt(parsed) : null;
}

class InvalidAnswer extends Error {}

function navigationKeys(delta: number): string[] {
  return Array.from({ length: Math.abs(delta) }, () => delta > 0 ? KEY.down : KEY.up);
}

/** a slider's moves: → is the next level, as ↓ is the next row */
function sliderKeys(delta: number): string[] {
  return Array.from({ length: Math.abs(delta) }, () => delta > 0 ? KEY.right : KEY.left);
}

function keySteps(keys: string[]): AnswerStep[] {
  return keys.map((key) => ({ keys: [key] }));
}

export function answerKeys(prompt: InteractivePrompt, answer: Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">): AnswerStep[] {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (!parsed) throw new InvalidAnswer("The prompt was not produced by parseInteractivePrompt.");
  const supplied = [answer.option_index !== undefined, answer.option_indices !== undefined, answer.custom_text !== undefined].filter(Boolean).length;
  if (supplied !== 1) throw new InvalidAnswer("Exactly one answer is required.");

  if (answer.custom_text !== undefined) {
    if (typeof answer.custom_text !== "string") throw new InvalidAnswer("Custom text must be a string.");
    const text = answer.custom_text.trim();
    if (!text || parsed.customMenuIndex === null || parsed.multi_select) throw new InvalidAnswer("This prompt does not accept a custom answer.");
    if (parsed.customSteps) return parsed.customSteps(text);
    const navigation = navigationKeys(parsed.customMenuIndex - parsed.selectedIndex);
    // Codex's queue types into its last row once it is selected: no enter first. pi's text
    // dialog is the same but for a worse reason: its `>` line already owns the input, so an
    // enter typed before the answer submits the dialog empty and leaves the answer behind to
    // be typed into the agent's own prompt.
    if (!["claude-question", "claude-plan", "codex-question", "codex-async-question", "pi-input"].includes(parsed.responder)) navigation.push(KEY.enter);
    if (parsed.responder === "codex-question") navigation.push(KEY.tab);
    // what was typed into pi's line in the terminal would stay around the answer: the line is
    // emptied first, after the cursor and before it (pi's editor keys, measured on 0.87.1)
    if (parsed.responder === "pi-input") navigation.push("ctrl+k", "ctrl+u");
    return [
      ...keySteps(navigation),
      { text },
      ...(parsed.responder === "claude-plan" ? keySteps([KEY.backtab]) : keySteps([KEY.enter])),
    ];
  }

  if (answer.option_indices !== undefined) {
    if (!Array.isArray(answer.option_indices)) throw new InvalidAnswer("Option indices must be an array.");
    if (!parsed.multi_select || answer.option_indices.length === 0) throw new InvalidAnswer("This prompt requires one or more selections.");
    const choices = [...new Set(answer.option_indices)];
    if (choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= parsed.options.length)) {
      throw new InvalidAnswer("An option index is outside the displayed range.");
    }
    if (parsed.multiSteps) return parsed.multiSteps(choices);
    const desired = new Set(choices);
    const checked = new Set(parsed.checkedOptionIndices);
    const toggles = parsed.options.flatMap((_, index) => desired.has(index) !== checked.has(index) ? [index] : []);
    let cursor = parsed.selectedIndex;
    const keys: string[] = [];
    for (const optionIndex of toggles) {
      keys.push(...navigationKeys(optionIndex - cursor), parsed.responder === "omp-question" ? KEY.space : KEY.enter);
      cursor = optionIndex;
    }
    if (parsed.responder === "omp-question") keys.push(KEY.tab, KEY.enter);
    // → leaves the choice for the next question or the review of the answers, never an
    // enter: on the next question it would pick that question's first option
    else if (parsed.responder === "claude-question") keys.push(KEY.right);
    else throw new InvalidAnswer("This agent does not support multiple selections.");
    return keySteps(keys);
  }

  const index = answer.option_index;
  if (!Number.isInteger(index) || index! < 0 || index! >= parsed.options.length || index === parsed.custom_option_index || parsed.multi_select) {
    throw new InvalidAnswer("A valid option index is required.");
  }
  if (parsed.optionSteps) return parsed.optionSteps[index!]!;
  if (parsed.rejectWithEscapeIndex === index) return keySteps([KEY.escape]);
  return keySteps([...navigationKeys(index! - parsed.selectedIndex), KEY.enter]);
}

/**
 * The last resort, for a pane herdr reports blocked that none of the readers above know (a
 * menu a new agent version draws differently, an agent without a reader): the chat must never
 * leave the user without a way to answer. It guesses as little as it can: a numbered menu that
 * still owns the screen's end becomes options answered by number, and GJC's exact unnumbered
 * selector becomes options answered by its cursor keys. Anything else shows the screen's last
 * lines with the keys its hint lines name, plus Enter and Esc.
 */
/** a question, allowing a trailing choice hint such as "(y/n)" */
const ASKED_RE = /\?\s*(?:[([][^)\]]*[)\]])?\s*$/;
/** a (y/n) hint ending its line, as a prompt does; a mention mid-sentence or quoted does not */
const YES_NO_RE = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]\s*[:?]?\s*$/i;
const ARROWS_RE = /[↑↓]|\barrow keys\b/i;
/**
 * what a menu's hint line says to do with it: a way to choose ("Enter to select", "↵ choose",
 * "Enter a number", "Type 1-3", "↑/↓ to move"). A plain Enter or Press asks for something else
 * ("Enter recovery code", "Enter your phone number", "Press any key").
 */
const MENU_HINT_RE = /\b(?:select|choose|pick|confirm|navigate|move|esc|cancel)\b|[↑↓↵⏎]|\b(?:enter|type)\s+(?:(?:a|an|the)\s+)?number\b|\b\d\s*[-–]\s*\d\b/i;
const GJC_SELECT_HINT_RE = /^(?:\[↑↓ to navigate, enter to select, esc to (?:cancel|go back)\]|up\/down navigate\s+enter select(?:\s+←\/→ question)?\s+esc cancel|↑\/↓ select\s+enter(?:\s+←\/→ question)?\s+esc\s+PgUp\/PgDn\/Ctrl\+u\/d: question · Wheel: transcript)$/i;
/** an input field waiting at a line's end ("Password:", "Choice: 2") */
const INPUT_FIELD_RE = /:\s*\S{0,3}$/;
/** a line that reads as a hint of its own, not a label's wrapped words ("…the selected number", "choose one") */
const HINT_LINE_RE = /^(?:[↵⏎]|(?:Press|Enter|Select|Choose|Pick|Type|Esc|ESC)\b)/;
/** how many lines the last row of a menu wraps onto, at most: more reads as output under it */
const MENU_WRAP_LINES = 2;
/** a line that is an input box or quoted output rather than a prompt's own text */
const NOT_PROMPT_TEXT_RE = /^(?:[❯›>"'“]|\$ )/;

/**
 * Claude Code's working line, whole: one of its spinner's frames, what it is doing ending in an
 * ellipsis, and in parentheses the time it has taken and the tokens it has used, then maybe the
 * interrupt hint: "✢ Tempering… (1m 55s · ↓ 10.0k tokens)".
 */
const WORKING_LINE_RE = /^[·✢✳✶✻✽*] (\S(?:.*\S)?…) \((?:\d+h )?(?:\d+m )?\d+s · [↑↓] [\d.,]+[kKmM]? tokens( · esc to interrupt)?\)$/u;

/**
 * How a fallback card's id reads a line of the screen. Claude Code keeps its working line on the
 * screen while it waits on a prompt, and the line's spinner, time and token count change every
 * second or so. An id that took them in refused each answer tapped after a tick as stale (#365).
 *
 * They are blanked on that one line, and only when it is known to be it: the pane runs Claude,
 * the line is its working line to the letter, token count with its arrow included, and no other
 * line of the screen has that shape. Without the token count a time in parentheses may be one
 * that is offered ("Restart service… (300s)"), and two such lines may be a menu's rows with their
 * marker ("· Delete all…" / "* Cancel…"): those screens are hashed as they are, like every other
 * line and every other agent's screen. The words stay in the id, so "Deleting staging…" is never
 * "Deleting production…".
 */
function steadyReader(agent: string, shown: string[]): SteadyReader {
  const working = agent === "claude" ? shown.flatMap((line, at) => WORKING_LINE_RE.test(line) ? [at] : []) : [];
  const [at] = working;
  if (working.length !== 1 || at === undefined) return { read: (other) => other, working: null };
  const line = shown[at]!;
  const steady = line.replace(WORKING_LINE_RE, (_all, doing: string, hint: string | undefined) => `* ${doing} (<time> · <tokens>${hint ?? ""})`);
  return { read: (other) => other === line ? steady : other, working: at };
}

interface SteadyReader {
  read(line: string): string;
  /** which of the shown lines was read as the working line; it goes into the id beside the text, so
   * that a screen holding the blanked form as its own text ("* Tempering… (<time> · <tokens>)") is
   * another card */
  working: number | null;
}

export function parseFallbackPrompt(agent: string, screen: string): InteractivePrompt {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  const steady = steadyReader(agent, shown.map((index) => cleanLine(lines[index]!)));
  // GJC's exact selector first: a label of its that starts with a number is still moved to, never typed
  const selectionMenu = fallbackGjcSelectionMenu(agent, lines, shown);
  const menu = selectionMenu ? null : fallbackMenu(lines, shown);
  if (menu) {
    const above = shown.filter((index) => index < menu.start).map((index) => cleanLine(lines[index]!));
    const question = [...above].reverse().find((line) => ASKED_RE.test(line)) ?? above.at(-1);
    // a row's number is typed alone, as a menu reading keys takes it; a program reading a whole
    // line ("Enter a number >") still waits for the Enter after it, and Esc backs out
    const choices: { label: string; steps: AnswerStep[] }[] = [
      ...menu.rows.map((row) => ({ label: row.label, steps: [{ text: String(row.number) }] })),
      { label: "Enter", steps: keySteps([KEY.enter]) },
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    const body = withoutLine(above, question);
    return screenCard(lines, shown, steady, finishPrompt(agent, {
      // the body is every other line above the rows, so a changed command above a same-looking
      // menu is another card; the display cap applies after the hash
      kind: "menu", fallback: true, title: "Waiting for your answer", question: question ?? "The agent is waiting for your answer.",
      body,
      options: choices.map(({ label }) => ({ label, description: null })),
      multi_select: false, custom_option_index: null,
    }, {
      responder: "fallback-menu", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
      checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
      optionSteps: choices.map(({ steps }) => steps),
    }, steadyFields(question, body, steady.read)));
  }
  if (selectionMenu) {
    const above = shown.filter((index) => index < selectionMenu.start).map((index) => cleanLine(lines[index]!));
    // the selector's own heading: the block of lines right above its rows, never an earlier question
    let headEnd = selectionMenu.start;
    while (headEnd > 0 && (!cleanLine(lines[headEnd - 1]!) || isDivider(lines[headEnd - 1]!))) headEnd -= 1;
    let headStart = headEnd;
    while (headStart > 0 && cleanLine(lines[headStart - 1]!) && !isDivider(lines[headStart - 1]!)) headStart -= 1;
    const heading = lines.slice(headStart, headEnd).map((line) => cleanLine(line));
    const question = [...heading].reverse().find((line) => ASKED_RE.test(line)) ?? heading.at(-1);
    const choiceRows = new Set(selectionMenu.rows.map((row) => row.lineIndex));
    const choices = [
      ...selectionMenu.rows.map((row, index) => ({
        label: row.label,
        steps: keySteps([...navigationKeys(index - selectionMenu.selectedIndex), KEY.enter]),
      })),
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    const body = withoutLine(above, question);
    return screenCard(lines, shown, steady, finishPrompt(agent, {
      kind: "menu", fallback: true, title: "Waiting for your answer", question: question ?? "The agent is waiting for your answer.",
      body,
      options: choices.map(({ label }) => ({ label, description: null })),
      multi_select: false, custom_option_index: null,
    }, {
      responder: "fallback-gjc-menu", menuLabels: choices.map(({ label }) => label), selectedIndex: selectionMenu.selectedIndex,
      checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
      optionSteps: choices.map(({ steps }) => steps),
    }, steadyFields(question, body, steady.read)), choiceRows);
  }
  const last = shown.slice(-16).map((index) => cleanLine(lines[index]!));
  // letters and arrows only for the prompt's own last lines, never while an input box ends the
  // screen (the agent's composer owns the keys then) or for a line of quoted output
  const hints = NOT_PROMPT_TEXT_RE.test(last.at(-1) ?? "") ? [] : last.slice(-2).filter((line) => !NOT_PROMPT_TEXT_RE.test(line));
  const question = [...last].reverse().find((line) => ASKED_RE.test(line)) ?? last.at(-1);
  // a (y/n) letter is offered only for the prompt at the screen's end, never for a mention
  // above it; it is typed without an Enter: a program reading a whole line still waits for
  // one, and the card that follows offers it
  const choices: { label: string; steps: AnswerStep[] }[] = [
    ...(hints.some((line) => YES_NO_RE.test(line)) ? [{ label: "Yes (y)", steps: [{ text: "y" }] }, { label: "No (n)", steps: [{ text: "n" }] }] : []),
    ...(hints.some((line) => ARROWS_RE.test(line)) ? [{ label: "↑", steps: keySteps([KEY.up]) }, { label: "↓", steps: keySteps([KEY.down]) }] : []),
    { label: "Enter", steps: keySteps([KEY.enter]) },
    { label: "Esc", steps: keySteps([KEY.escape]) },
  ];
  const body = withoutLine(last, question);
  return screenCard(lines, shown, steady, finishPrompt(agent, {
    kind: "menu", fallback: true, title: "Waiting for input", question: question ?? "The agent is waiting for input.",
    body,
    options: choices.map(({ label }) => ({ label, description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "fallback-keys", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: choices.map(({ steps }) => steps),
  }, steadyFields(question, body, steady.read)));
}

/** A fallback card's question and body as its id reads them: with the working line's ticking parts blanked. */
function steadyFields(question: string | undefined, body: string | null, steady: (line: string) => string): Partial<Pick<InteractivePrompt, "question" | "body">> {
  return { ...(question === undefined ? {} : { question: steady(question) }), body: body === null ? null : body.split("\n").map(steady).join("\n") };
}

/**
 * A fallback card's id covers the whole visible screen, not just the lines it shows: a changed
 * command, footer or wrapped label anywhere on it makes an answer to the old card stale. A working
 * line's spinner, time and token count are the one thing it leaves out (steadyReader).
 */
function screenCard(lines: string[], shown: number[], steady: SteadyReader, parsed: ParsedPrompt, cursorRows?: ReadonlySet<number>): InteractivePrompt {
  const screen = shown.map((index) => {
    const line = cleanLine(lines[index]!);
    // GJC moves its cursor within the same menu; the selectedIndex is checked separately on reread.
    return steady.read(cursorRows?.has(index) ? line.replace(SELECTED_RE, "") : line);
  }).join("\n");
  parsed.id = createHash("sha256").update(JSON.stringify({ card: parsed.id, screen, ...(steady.working === null ? {} : { working: steady.working }) })).digest("hex").slice(0, 12);
  return publicPrompt(parsed);
}

/** the screen lines shown under the card's question, without the question itself */
function withoutLine(lines: string[], question: string | undefined): string | null {
  const at = question === undefined ? -1 : lines.lastIndexOf(question);
  return lines.filter((_, index) => index !== at).join("\n") || null;
}

/**
 * A numbered menu (`1.` … `n.`, 2 to 9 rows, at most one marked) that still owns the screen's
 * end: its hint, a line that says to choose, is the screen's last, and between the last row and
 * it are only the lines that row wraps onto (right under it, indented past its number). Anything
 * else there (another hint, a new prompt, an input box) may be what takes the keys now, so it is
 * no menu. A wrapped label is no guess here, since every row starts with its own number.
 */
function fallbackMenu(lines: string[], shown: number[]): { start: number; rows: NumberedRow[] } | null {
  const lastRow = [...shown].reverse().find((index) => NUMBERED_OPTION_RE.test(cleanLine(lines[index]!)));
  const hintIndex = shown.at(-1);
  if (lastRow === undefined || hintIndex === undefined || hintIndex === lastRow) return null;
  const hint = cleanLine(lines[hintIndex]!);
  // a hint that says to choose, and no input field ("Password:", "Choice: 2"): a numbered
  // list in the agent's output is not a menu
  if (!MENU_HINT_RE.test(hint) || SELECTED_RE.test(hint) || NOT_PROMPT_TEXT_RE.test(hint) || INPUT_FIELD_RE.test(hint)) return null;
  let end = lastRow + 1;
  const numberAt = lines[lastRow]!.search(/\d/);
  while (end < hintIndex && cleanLine(lines[end]!) && !isDivider(lines[end]!) && lines[end]!.search(/\S/) > numberAt) end += 1;
  if (shown.some((index) => index >= end && index < hintIndex) || end - lastRow - 1 > MENU_WRAP_LINES) return null;
  // up from the last row, through rows and the lines they wrap onto, to a blank line or a rule
  let start = lastRow;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  while (start < lastRow && !NUMBERED_OPTION_RE.test(cleanLine(lines[start]!))) start += 1;
  const rows = parseNumberedRows(lines, start, end);
  if (!sequentialRows(rows) || rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length > 1) return null;
  // the lines a row wraps onto belong to its label; an input box or quote between rows, or a
  // row with its own letter key ("Read only (r)"), means the number may not be the key
  for (const [at, row] of rows.entries()) {
    const wrapped = lines.slice(row.lineIndex + 1, rows[at + 1]?.lineIndex ?? end).map(cleanLine).filter(Boolean);
    // a hint or an input field inside the last row's wrap may be an older prompt, with a new one under it
    if (wrapped.some((line) => NOT_PROMPT_TEXT_RE.test(line) || (at === rows.length - 1 && (HINT_LINE_RE.test(line) || /:\s*$/.test(line))))) return null;
    // the key may end the row's first line, with a description wrapped under it
    if ([row.label, ...wrapped].some((line) => /\(\w\)$/.test(line))) return null;
    row.label = [row.label, ...wrapped].join(" ");
  }
  return { start, rows };
}

/** GJC's unnumbered selector: a cursor-marked row, two-space rows, and its own selection footer. */
function fallbackGjcSelectionMenu(agent: string, lines: string[], shown: number[]): { start: number; rows: MenuRow[]; selectedIndex: number } | null {
  if (agent !== "gjc" || shown.length === 0) return null;
  let hintStart = -1;
  for (let length = 1; length <= Math.min(3, shown.length); length += 1) {
    const suffix = shown.slice(-length).map((index) => cleanLine(lines[index]!)).join(" ");
    if (GJC_SELECT_HINT_RE.test(suffix)) {
      hintStart = shown[shown.length - length]!;
      break;
    }
  }
  if (hintStart < 0) return null;

  // GJC's standard selector separates the footer with a spacer and can outline its rows.
  // The provider wizard puts its footer directly below them.
  let end = hintStart;
  while (end > 0 && (!cleanLine(lines[end - 1]!) || isDivider(lines[end - 1]!))) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  if (start === 0 || (cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!))) return null;
  const rows: MenuRow[] = [];
  for (let index = start; index < end; index += 1) {
    const text = cleanLine(lines[index]!);
    const selected = SELECTED_RE.test(text);
    const label = normalizeText(text.replace(SELECTED_RE, ""));
    // A windowed/truncated list is not a complete set of choices. Keep its manual keys.
    if (!label || /^\(\d+\/\d+\)$/.test(label) || /…|\.\.\./.test(label)) return null;
    rows.push({ label, selected, checked: false, lineIndex: index });
  }
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (rows.length < 2 || selectedIndex < 0 || rows.filter((row) => row.selected).length !== 1) return null;
  return { start, rows, selectedIndex };
}

/**
 * The panes whose current wait on an unknown screen is logged: once per wait, not per screen,
 * so a screen that keeps changing (a clock, a spinner) cannot log on every poll.
 */
const fallbackLogged = new Set<string>();
/** panes whose wait is logged at most; past it a new wait goes unlogged rather than relogging one */
const FALLBACK_LOGGED_MAX = 256;

/**
 * The question each pane's queue opened on when that was not the card's (a skipped
 * question leaves the rollout's newest-first guess behind): the next card shows it.
 */
const queueFronts = new Map<string, QueueFront & { rollout: string }>();

/**
 * Which asking of its prompt each pane shows. A prompt's own id is a hash of what it says, so the
 * same question asked twice in a row would be one card: an answer tapped for the first asking (or
 * a typed pick left waiting for Confirm) would go to the second. The id a card carries therefore
 * names the asking too, and a
 * new asking starts on any evidence that the last one ended: a read that showed no prompt or
 * another one, an answer sent from here, the agent back at work. With none of these (answered in
 * a terminal and asked again between two reads, by an agent that reports no work in between)
 * two askings cannot be told apart from the screen.
 */
interface Asking { content: string | null; n: number; queued: boolean }
const askings = new Map<string, Asking>();
/** counted across panes and never reused: a pane forgotten here starts no asking over */
let askingCount = 0;
/** this run of the server: a card read before a restart is not one of this run's askings */
const SERVER_RUN = randomBytes(6).toString("hex");
/**
 * The panes an answer is on its way to. Its keys redraw the menu (a move, a row opened for typing,
 * pi's dialog with its cursor off the first row), so what another read finds meanwhile says
 * nothing about the asking: it neither ends it nor starts one. The answer reads the screen
 * itself before its first key that is not a move, and promptWaitEnded still ends the asking
 * under it.
 */
const answersUnderWay = new Set<string>();
/**
 * How many answers have begun or ended on each pane. A read takes its time: one that began
 * before or under an answer and comes back after it shows a screen of that answer's, not of now,
 * so a read during which this number moved changes nothing either.
 */
const answerTurns = new Map<string, number>();

/**
 * The prompt a read found, under the id of its asking; a read without one ends the pane's asking.
 * `turns`: the pane's answerTurns when the read began.
 */
function asked(paneId: string, prompt: InteractivePrompt | null, turns: number): InteractivePrompt | null {
  let asking = askings.get(paneId);
  if (!answersUnderWay.has(paneId) && (answerTurns.get(paneId) ?? 0) === turns) {
    if (prompt === null) {
      if (asking) asking.content = null;
      return null;
    }
    if (asking?.content !== prompt.id) {
      // kept until its pane closes (readPrompt): a live asking is never dropped to make room
      asking = { content: prompt.id, n: askingCount += 1, queued: prompt.queued !== undefined };
      askings.set(paneId, asking);
    }
  }
  if (prompt === null) return null;
  prompt.id = createHash("sha256").update(JSON.stringify([prompt.id, SERVER_RUN, asking?.n ?? 0])).digest("hex").slice(0, 12);
  return prompt;
}

/** The pane's prompt was answered: the same prompt on its screen after this is asked anew. */
function askingEnded(paneId: string): void {
  const asking = askings.get(paneId);
  if (asking) asking.content = null;
}

/**
 * The pane's agent is back at work: it has had its answer, maybe from a terminal, and the same
 * prompt on its screen after this is asked anew. Not so for a question in Codex's queue, which
 * Codex asks while it works and goes on working under: its status says nothing about the
 * question.
 */
export function promptWaitEnded(paneId: string): void {
  if (!askings.get(paneId)?.queued) askingEnded(paneId);
}

/** A prompt's id as its text alone makes it, whichever asking it is. */
function contentId(prompt: InteractivePrompt | null): string | undefined {
  return prompt ? parsedByPublicPrompt.get(prompt)?.id : undefined;
}

/** When each pane's omo form was last answered from the chat (see readPrompt). */
const formsAnswered = new Map<string, number>();
const FORM_SETTLE_MS = 3_000;

/** Each pane's rollout, resolved for its collapsed queue: a poll every 2s would otherwise redo it. */
const queueRollouts = new Map<string, { path: string | null; at: number }>();
const QUEUE_ROLLOUT_MS = 15_000;

/** how long a prompt poll waits for the ANSI read behind Claude's suggestion before going without it */
const SUGGESTION_READ_MS = 1_500;

/** Claude's new-session tip in the empty input (`Try "how does <filepath> work?"`), not a suggestion. */
const CLAUDE_TIP_RE = /^Try "/;

/**
 * Whether each character of an ANSI line is drawn dim (SGR 2) and inverse (SGR 7), as
 * [text, dim, inverse] runs. Only SGR sequences change the state; 38/48 colors are skipped whole,
 * so the 2 of `38;2;r;g;b` is a color mode, not dim. Other escapes are dropped.
 */
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
 * The prompt Claude Code suggests next, grey in its empty input box: the `❯` line between the
 * screen's last two rules (the live input box, not an earlier one above a bash-mode input), all
 * of it dim but for Claude's own drawn cursor on its first character. None while anything is
 * typed there (typed text is not dim), for the new-session tip, or for an input box of more than
 * one line.
 */
export function parseClaudeSuggestion(ansi: string): string | null {
  const grey = claudeGreyInput(ansi);
  return grey === null || CLAUDE_TIP_RE.test(grey) ? null : grey;
}

/**
 * What Claude Code's input box shows in grey while it is empty (a suggested prompt, or the
 * new-session tip), null when the box holds typed text or nothing. Only an ANSI read tells grey
 * text from a message: as plain text both are `❯ words`.
 */
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
  for (const [run, dim, inverse] of sgrRuns(lines[index]!)) {
    for (const character of run) {
      if (!seenPrompt) { if (character === "❯") seenPrompt = true; continue; }
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
 * Whether a held-message card was read off Claude's own grey text. Claude's hint outlasts the
 * message for a moment (sent or cleared in the terminal), over a box that is empty again and shows
 * its tip or a suggested prompt: Enter there sends Claude's suggestion and Ctrl+C asks to leave
 * Claude. A read that fails or shows no box says nothing, and the card stays.
 */
export async function claudeHeldIsGrey(paneId: string, prompt: InteractivePrompt): Promise<boolean> {
  if (parsedByPublicPrompt.get(prompt)?.responder !== "claude-held") return false;
  return paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
    .then((read) => claudeGreyInput(read.text) !== null, () => false);
}

async function readPrompt(paneId: string, codexHome?: string): Promise<{ agent: string; status: string; prompt: InteractivePrompt | null; pane: HerdrPane; panes: HerdrPane[] }> {
  const { panes } = await sessionSnapshot();
  // a closed pane's wait has ended too
  for (const logged of fallbackLogged) if (!panes.some((candidate) => candidate.pane_id === logged)) fallbackLogged.delete(logged);
  for (const known of askings.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) askings.delete(known);
  for (const known of answerTurns.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) answerTurns.delete(known);
  for (const known of heldCandidates.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) heldCandidates.delete(known);
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const agent = pane.agent ?? "";
  const status = pane.agent_status;
  // counted right before the screen is read, after the snapshot: what matters is whether an
  // answer ran while the screen was being read
  const turns = answerTurns.get(paneId) ?? 0;
  const known = await readKnownPrompt(paneId, pane, agent, codexHome, panes);
  // an omo form just answered has closed, while herdr still reports the wait for a moment: that
  // is no screen to answer, and its fallback card would flash up after the form's last answer
  const settling = Date.now() - (formsAnswered.get(paneId) ?? 0) < FORM_SETTLE_MS;
  if (known.prompt !== null || status !== "blocked" || !agent || settling) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, known.prompt, turns), pane, panes };
  }
  // herdr says the agent waits on the user and no reader knows the screen: the fallback card
  const screen = known.screen ?? await liveScreen(paneId);
  // Codex's collapsed question queue reads blocked while its main prompt takes a message; a
  // model list of Claude Code's or Codex's that no reader could read is left to the terminal
  // (claudeModelListWaits, codexModelListWaits)
  if ((agent === "codex" && (codexQuestionsCollapsed(screen) || codexModelListWaits(screen))) || claudeModelListWaits(screen) || claudeModelListWaits(screen, CLAUDE_EFFORT_GUARD_RE)) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, null, turns), pane, panes };
  }
  const prompt = asked(paneId, parseFallbackPrompt(agent, screen), turns)!;
  if (!fallbackLogged.has(paneId) && fallbackLogged.size < FALLBACK_LOGGED_MAX) {
    fallbackLogged.add(paneId);
    console.warn(`prompt: ${agent} pane ${paneId} is blocked on a screen no reader knows; fallback card (${prompt.options.length} options)`);
  }
  return { agent, status, prompt, pane, panes };
}

/**
 * The pane's live screen as text: herdr's bottom buffer, whatever part of the history the pane's
 * viewport shows. A pane scrolled up (a drag or the wheel in a terminal) stays scrolled while the
 * agent draws its next menu at the bottom, out of that viewport.
 */
async function liveScreen(paneId: string): Promise<string> {
  return (await paneRead({ paneId, source: "detection", format: "text" })).text;
}

/** omo's form or its widget on a screen, by a line of its key hint: worth a look in the pane's session. */
const OMO_FORM_RE = /\b1-9 select\b|enter save and next|\btab next question\b|\bor just type your reply\b/;
const omoAskReader = new OmoAskReader();

/** Resolve the live process tree every time: a cached session can outlive its agent. */
async function omoAsksFor(paneId: string, cwd: string, panes: HerdrPane[]): Promise<OmoAsk[]> {
  const path = await omoTranscriptForPane(paneId, cwd, panes).catch(() => null);
  if (!path) return [];
  try { return omoAskReader.read(path).flatMap((call) => omoAskOf({ ...call, id: `${path}\0${call.id}` }) ?? []).reverse(); }
  catch { return []; }
}

async function readKnownPrompt(
  paneId: string,
  pane: { cwd?: string | null; agent_status?: string },
  agent: string,
  codexHome?: string,
  panes: HerdrPane[] = [],
): Promise<{ prompt: InteractivePrompt | null; screen?: string }> {
  if (!["claude", "omp", "codex", "omo", "pi", "gjc", ""].includes(agent)) return { prompt: null };
  const screen = await liveScreen(paneId);
  // omo's form reads its text from the session's call, the screen showing where the form stands
  const omoAsks = ["omo", "pi", "claude", ""].includes(agent) && pane.cwd && OMO_FORM_RE.test(screen)
    ? await omoAsksFor(paneId, pane.cwd, panes) : [];
  // a pane herdr names claude, or not at all, is omo's only on evidence: herdr reports it waiting
  // on the user, or the session's pending call is the form on screen
  const omoTrusted = (agent !== "claude" && agent !== "") || pane.agent_status === "blocked";
  const prompt = parseInteractivePrompt(agent, screen, omoAsks[0] ?? null, omoTrusted, omoAsks, agent === "claude" ? heldCandidate(paneId) : null, pane.agent_status === "working");
  if (prompt && await claudeHeldIsGrey(paneId, prompt)) return { prompt: null, screen };
  if (!prompt && agent === "gjc") {
    const fallback = parseFallbackPrompt(agent, screen);
    if (parsedByPublicPrompt.get(fallback)?.responder === "fallback-gjc-menu") return { prompt: fallback, screen };
  }
  const count = agent === "codex" && prompt === null ? queuedQuestionCount(screen) : 0;
  if (count === 0 || !pane.cwd) return { prompt, screen };
  let rollout = queueRollouts.get(paneId);
  if (!rollout || Date.now() - rollout.at > QUEUE_ROLLOUT_MS) {
    rollout = { path: await codexTranscriptPath(paneId, pane.cwd, await paneCodexHome(paneId, codexHome)), at: Date.now() };
    queueRollouts.set(paneId, rollout);
    if (queueRollouts.size > 64) queueRollouts.delete(queueRollouts.keys().next().value!);
  }
  try {
    // a question remembered from another rollout (a new session) means nothing here
    const front = queueFronts.get(paneId);
    if (front && front.rollout !== rollout.path) queueFronts.delete(paneId);
    return {
      prompt: rollout.path ? codexQueuedPrompt(screen, await unansweredCodexQuestions(rollout.path), front?.rollout === rollout.path ? front : null) : null,
      screen,
    };
  } catch {
    return { prompt: null, screen }; // the rollout went away
  }
}

/**
 * After an answer from the chat: if Codex opened its next question, close the queue, so
 * the main prompt has the input back. Only once another question shows (`answered` is the
 * id of the one just answered, which can still be on screen for a moment). alt+↓ elsewhere,
 * on the main prompt or an approval, changes nothing (checked on Codex 0.156.1).
 */
async function closeQueue(paneId: string, answered: string): Promise<void> {
  const since = Date.now();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Bun.sleep(100);
    const screen = await liveScreen(paneId);
    const shown = parsePrompt("codex", screen);
    if (shown?.responder === "codex-async-question") {
      // the question just answered, a moment ago; still there after 600ms, it is its twin
      // (Codex takes the Enter at once, and questions may repeat a title and options)
      if (shown.id === answered && Date.now() - since < 600) continue;
      await paneSendKeys(paneId, [KEY.closeQueue]);
      return;
    }
    if (queuedQuestionCount(screen) > 0 || shown === null) return;
  }
}

/** Letters and digits only: a question the pane wraps or punctuates differently still compares equal. */
const comparable = (text: string): string => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

function sameText(shown: string, asked: string): boolean {
  const a = comparable(shown);
  const b = comparable(asked);
  // a pane too narrow for a line may cut it with an ellipsis
  return a === b || (/…\s*$/.test(shown) && a.length >= 24 && b.startsWith(a));
}

/**
 * Opens Codex's collapsed queue on its first question and returns that question, only
 * if it is the one the card showed (title and options). Another one stays open, so the
 * chat's next read shows the question actually waiting (a skip can leave the rollout's
 * guess behind); a queue that does not open is left alone.
 */
async function openQueuedQuestion(paneId: string, queued: ParsedPrompt, givenUp: () => boolean = () => false, opens: (open: boolean) => void = () => undefined): Promise<InteractivePrompt | null> {
  // the key only once the screen still shows the questions' count, nothing of the user's queued,
  // and while somebody still waits for the answer (asked after the read, which takes its time)
  if (queuedQuestionCount(await liveScreen(paneId)) === 0 || givenUp()) return null;
  // told before the key goes: it may be pressed and its reply still be lost
  opens(true);
  await paneSendKeys(paneId, [KEY.openQueue]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(100);
    const opened = parsePrompt("codex", await liveScreen(paneId));
    if (opened?.responder !== "codex-async-question") continue;
    if (sameText(opened.question, queued.question) && opened.options.length === queued.options.length
      && opened.options.every((option, index) => sameText(option.label, queued.options[index]!.label))) return publicPrompt(opened);
    const rollout = queueRollouts.get(paneId)?.path;
    if (rollout) queueFronts.set(paneId, { question: opened.question, options: opened.options.map((option) => option.label), rollout });
    if (queueFronts.size > 64) queueFronts.delete(queueFronts.keys().next().value!);
    break;
  }
  // not the card's question (a skip can leave the rollout's guess behind), or nothing opened:
  // never leave the queue open, where it would hold the input a message goes to. The one
  // close of this request's opening, told before it is tried: if its reply is lost, nobody
  // closes a second time what another client may have opened since
  opens(false);
  await closeOpenQuestion(paneId);
  return null;
}

/** Closes Codex's queue if a question shows open in it. */
async function closeOpenQuestion(paneId: string): Promise<void> {
  const screen = await liveScreen(paneId);
  if (parsePrompt("codex", screen)?.responder === "codex-async-question") await paneSendKeys(paneId, [KEY.closeQueue]);
}

/** How long an answer waits for the menu to show the cursor on its row, before it is refused. */
const SETTLE_MS = 1_500;

/**
 * After an answer to a form of several questions (omo) or to a model list (Claude Code, Codex):
 * back once the pane shows its next step (the next question, the review, a model's levels, or
 * nothing when it was submitted or closed), so the card's read right after the answer gets that
 * step and never the one just answered. A screen that does not move within a second leaves it to
 * the card's next poll.
 */
async function formMovedOn(paneId: string, answered: string, codexHome?: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(50);
    const prompt = await readPrompt(paneId, codexHome).then((read) => read.prompt, () => null);
    // by what it says: the answer ended that asking, so the same step still on screen has a new id
    if (contentId(prompt) !== answered) return;
  }
}

function promptChanged(): Response {
  return jsonResponse({ error: { code: "prompt_changed", message: "The interactive prompt changed; reopen it and try again." } }, 409);
}

export interface PromptRequestOptions {
  /** runs a pane's answer after the input already queued for it (a composer message in flight) */
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  /** Native Codex store, for the rollout behind a collapsed queue; defaults to CODEX_HOME */
  codexHome?: string;
}

export async function handlePromptRequest(request: Request, url: URL, options: PromptRequestOptions = {}): Promise<Response | null> {
  if (url.pathname !== "/api/pane/prompt" && url.pathname !== "/api/pane/prompt/answer") return null;
  try {
    if (url.pathname === "/api/pane/prompt") {
      if (request.method !== "GET") return badRequest("method_not_allowed", "GET is required.");
      const paneId = url.searchParams.get("pane_id")?.trim();
      if (!paneId) return badRequest("missing_pane_id", "pane_id is required.");
      const { agent, status, prompt } = await readPrompt(paneId, options.codexHome);
      // no menu up: what Claude suggests typing next, for the composer's placeholder. Only a
      // nicety: it is read only while Claude waits for the next prompt (a working agent shows
      // none), and a failed or slow read of it (a herdr without ansi reads, a busy one) leaves
      // the prompt answer as it is, on time.
      const suggestion = prompt === null && agent === "claude" && (status === "idle" || status === "done")
        ? await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
          .then((read) => parseClaudeSuggestion(read.text), () => null)
        : null;
      return jsonResponse({ prompt, suggestion });
    }

    if (request.method !== "POST") return badRequest("method_not_allowed", "POST is required.");
    let body: PromptAnswer;
    try {
      body = await request.json() as PromptAnswer;
    } catch {
      return badRequest("invalid_json", "The request body must be valid JSON.");
    }
    if (!body || typeof body !== "object") return badRequest("invalid_answer", "The answer body is required.");
    if (typeof body.pane_id !== "string" || !body.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required.");
    if (typeof body.prompt_id !== "string" || !body.prompt_id) return badRequest("invalid_answer", "prompt_id is required.");

    // read, checked and answered in the pane's turn: a message still in flight goes first, and
    // one sent meanwhile waits until the queue is opened, answered and closed again
    const serialize = options.serialize ?? (<T>(_paneId: string, task: () => Promise<T>) => task());
    const form: { answered?: string } = {};
    const response = await serialize(body.pane_id, async () => {
      // given up while it waited its turn: nothing is read, opened or sent for it
      if (request.signal.aborted) return promptChanged();
      const { prompt, agent, pane, panes } = await readPrompt(body.pane_id, options.codexHome);
      if (!prompt || prompt.id !== body.prompt_id) return promptChanged();
      // checked against the card before anything is sent: an invalid answer never opens the queue
      let steps: AnswerStep[];
      try {
        steps = answerKeys(prompt, body);
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      }
      // The asking this answer is for, held to its last key: once anything says it ended (the
      // agent back at work), no key of this answer goes out any more, whatever the screen shows.
      const asking = askings.get(body.pane_id)!;
      const asks = (): boolean => askings.get(body.pane_id) === asking && asking.content !== null;
      let target = prompt;
      /** what the card said at the answer's last look: a list drawn as another window by then is another text */
      let lastSeen: string | undefined;
      const opensQueue = parsedByPublicPrompt.get(prompt)?.responder === "codex-queued-question";
      const opensOmo = parsedByPublicPrompt.get(prompt)?.responder === "omo-pending";
      let answered = false;
      let committed = false;
      // whether this request's alt+↑ may have left the queue open
      let queueOpened = false;
      answersUnderWay.add(body.pane_id);
      answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
      try {
        if (request.signal.aborted) return promptChanged();
        if (opensQueue) {
          // the card came from the rollout: answer it in the open queue, once it shows this question
          const opened = await openQueuedQuestion(body.pane_id, parsedByPublicPrompt.get(prompt)!, () => request.signal.aborted, (open) => { queueOpened = open; });
          // a queue it could not answer in it has closed again itself, or never opened: a
          // queue another client opened meanwhile is that client's to close
          if (!opened) return promptChanged();
          if (!asks()) return promptChanged();
          target = opened;
        }
        if (opensOmo) {
          // Alt+Up opens the form even with whitespace in the composer; no draft is submitted.
          // A remapped shortcut or a different question fails closed before any answer text.
          await paneSendKeys(body.pane_id, [KEY.openQueue]);
          const deadline = Date.now() + SETTLE_MS;
          let opened: InteractivePrompt | null = null;
          while (Date.now() < deadline) {
            if (!asks() || request.signal.aborted) return promptChanged();
            const left = deadline - Date.now();
            const read = await Promise.race([readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes), Bun.sleep(left).then(() => null)]);
            if (!read || Date.now() > deadline) return promptChanged();
            const parsed = read.prompt && parsedByPublicPrompt.get(read.prompt);
            if (parsed?.responder === "omo-question") {
              // Opening a form changes its drawing, but not the call or question it answers.
              const pending = parsedByPublicPrompt.get(prompt)!;
              if (!pending.omoQuestion || parsed.omoQuestion?.call !== pending.omoQuestion.call
                || parsed.omoQuestion.index !== pending.omoQuestion.index
                || parsed.question !== pending.question || parsed.multi_select !== pending.multi_select
                || JSON.stringify(parsed.options) !== JSON.stringify(pending.options)) return promptChanged();
              opened = read.prompt;
              break;
            }
            await Bun.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
          }
          if (!opened || !asks()) return promptChanged();
          target = opened;
        }
        // the keys for the question as it shows in the open queue
        if (target !== prompt) steps = answerKeys(target, body);
        const parsed = parsedByPublicPrompt.get(target)!;
        const responder = parsed.responder;
        // where the moves sent so far leave the cursor (↑ stops at the first row: omoWalk)
        let cursor = parsed.selectedIndex;
        // Claude's unnumbered rows and pi's models are read with no number to aim at: looked at
        // again before the Enter even when it needs no move. So is Claude's model list, picked
        // with a letter: typed after the list has gone, it would stand in the agent's own prompt
        let moved = responder === "claude-confirm" || responder === "pi-model" || responder === "omo-question" || responder === "claude-model" || responder === "claude-effort" || responder === "codex-model" || responder === "fallback-gjc-menu";
        // Claude's and Codex's model lists: a window on a list, picked with a letter; Claude's effort
        // slider the same way, its levels side by side
        const list = responder === "claude-model" || responder === "claude-effort" || responder === "codex-model";
        // ←/→ move the slider; anywhere else they are a menu's own keys (Claude's question tabs)
        const sideways = responder === "claude-effort";
        /** the menu as the last look before a key showed it */
        let seen: ParsedPrompt | null = null;
        const looked = (shown: ParsedPrompt | null): void => { seen = shown; lastSeen = shown?.id; };
        /** Whether the screen is the card's own menu, with the cursor on the row the moves were for. */
        const aimed = (shown: ParsedPrompt | null, screen: string): boolean => {
          // pi's catalogue shows ten rows of a longer list and scrolls under the cursor, so the
          // rows on screen, and with them the card's id, change on the way down: what must
          // hold is the model under the cursor, by name. A wrong model, unlike a wrong menu
          // entry, answers every later turn silently
          if (responder === "pi-model") return shown?.responder === "pi-model" && shown.options[shown.selectedIndex]?.label === parsed.options[cursor]?.label;
          // Claude's list is a window too, drawn with fewer rows in a pane made shorter meanwhile:
          // the model under the cursor, by its number in the list, its name and what the row says
          // Codex's lists the same way, the list's title with the row: the reasoning levels of
          // another model are the same rows
          if (list) return shown?.responder === responder && shown.menuLabels[shown.selectedIndex] === parsed.menuLabels[cursor];
          // a dialog of pi's has a card only with its cursor on the first row (parsePiDialog),
          // which the answer's own moves have just left: read off the screen itself
          if ((responder === "pi-question" || responder === "pi-confirm") && cursor !== 0) {
            const dialog = parsePiDialog(screen, true);
            return dialog?.id === parsed.id && dialog.selectedIndex === cursor && promptTailIsActive(dialog, screen);
          }
          return shown?.id === parsed.id && shown.selectedIndex === cursor;
        };
        /**
         * Waits for the screen to show the card's own menu with the cursor where the moves sent
         * so far leave it. False: the asking ended, nobody waits for the answer, or the menu did
         * not show so within SETTLE_MS.
         */
        const onRow = async (): Promise<boolean> => {
          const deadline = Date.now() + SETTLE_MS;
          for (;;) {
            // nobody waits for this answer any more: nothing that cannot be undone is started
            if (!asks() || request.signal.aborted) return false;
            const left = deadline - Date.now();
            if (left <= 0) return false;
            // a read that outlasts the wait is no read
            const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes);
            reading.catch(() => undefined);
            const read = await Promise.race([reading, Bun.sleep(left).then(() => null)]);
            if (!read || Date.now() > deadline) return false;
            const shown = read.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
            if (asks() && aimed(shown, read.screen ?? "")) { looked(shown); return true; }
            await Bun.sleep(50);
          }
        };
        // whether a move of this answer has gone out
        let walked = false;
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index]!;
          const move = step.keys?.every((key) => key === KEY.up || key === KEY.down || (sideways && (key === KEY.left || key === KEY.right))) ?? false;
          // the asking ended under the answer: no further key, whatever the screen shows
          if (!asks()) return promptChanged();
          // A model list can be nine rows from the cursor, and an Esc in the terminal hands its
          // keys to the agent's own prompt, where an arrow walks the prompt's history: each move
          // after the first goes only once the list shows the one before it
          // GJC's selector the same: dismissed under the answer, its composer would take the moves
          if (move && walked && (list || responder === "fallback-gjc-menu") && !(await onRow())) return promptChanged();
          if (!move && !committed) {
            // An answer is only as good as the menu and the cursor it moves from, and both are
            // as old as the read above by the time its moves are done: the menu answered in the
            // terminal, with another one in its place, would take the Enter meant for this one,
            // and an arrow key typed there sends it to the wrong row. Moves change nothing; the
            // first key that does (the Enter, a toggle, the row opened for typing) goes only
            // once the screen shows this menu again, with the cursor on the row the moves were
            // for. The keys after that one follow as they always did: the menu itself changes
            // under them.
            if (moved && !(await onRow())) return promptChanged();
            // given up before anything that cannot be undone, with or without a move before it
            if (request.signal.aborted) return promptChanged();
          }
          // before the key goes: herdr may press it and the reply still be lost, and a key that
          // may have been pressed has ended the asking as much as one that was
          // the menu's own key for the row the moves ended on, as the look just before showed it:
          // none where no look was taken or the row names no key this reader knows
          const key: AnswerStep | null = step.pick ? (seen as ParsedPrompt | null)?.rowKey ?? null : step;
          if (key === null) return promptChanged();
          const first = !move && !committed;
          if (!move) committed = true;
          try {
            if (key.keys) await paneSendKeys(body.pane_id, key.keys);
            else if (key.text !== undefined) await paneSendText(body.pane_id, key.text);
          } catch (error) {
            // herdr was never reached, so nothing was pressed: the card is still to be answered
            if (first && error instanceof HerdrError && error.code === "connect_failed") committed = false;
            throw error;
          }
          if (move) {
            moved = true;
            walked = true;
            for (const key of step.keys!) cursor = key === KEY.down || key === KEY.right ? cursor + 1 : Math.max(0, cursor - 1);
          }
          if (index < steps.length - 1) await Bun.sleep(30);
        }
        answered = true;
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      } finally {
        answersUnderWay.delete(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        // the queue this request opened never stays open, whatever failed on the way
        if (queueOpened && !answered) await closeOpenQuestion(body.pane_id).catch(() => undefined);
        // answered, or as good as: the same prompt on the screen after this is asked anew
        if (committed) askingEnded(body.pane_id);
        // sent or dropped from its card: the same words in the box after this are a new message
        if (committed && parsedByPublicPrompt.get(target)?.responder === "claude-held") heldCandidates.delete(body.pane_id);
      }
      // answered from the chat, the queue closes again: the next question waits collapsed, and
      // the main prompt (where a message typed in the chat goes) has the input back
      if (parsedByPublicPrompt.get(target)?.responder === "codex-async-question") {
        queueFronts.delete(body.pane_id);
        // by what it says, as closeQueue reads it off the screen
        await closeQueue(body.pane_id, contentId(target)!);
      }
      const responder = parsedByPublicPrompt.get(target)?.responder;
      if (responder === "omo-question" || responder === "omo-review" || responder === "omo-typing" || responder === "omo-pending") {
        formsAnswered.set(body.pane_id, Date.now());
        if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
      }
      // A model list closes, or opens its next list, a moment after its key: the same wait, so
      // the card's read right after the answer does not get the list just answered once more
      if (target.steps) form.answered = contentId(target);
      else if (responder === "claude-model" || responder === "claude-effort" || responder === "codex-model") form.answered = lastSeen ?? contentId(target);
      return jsonResponse({ ok: true });
    });
    // the wait for the form's next step only reads the pane: after the pane's turn, so a message
    // queued for it meanwhile is not held up behind the polls
    if (form.answered !== undefined) await formMovedOn(body.pane_id, form.answered, options.codexHome);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
