import { createHash } from "node:crypto";

import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { codexTranscriptPath, unansweredCodexQuestions, type QueuedQuestion } from "./codex.ts";
import { HerdrError, paneRead, paneSendKeys, paneSendText, sessionSnapshot } from "./herdr/client.ts";
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
const SOLID_RULE_RE = /^[─━]{8,}$/;
const CODEX_APPROVAL_HEADER_RE =
  /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Trust this folder\?|Enable full access)/i;
const NUMBERED_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;

const KEY = {
  up: "up",
  down: "down",
  enter: "enter",
  escape: "esc",
  space: "space",
  tab: "tab",
  right: "right",
  backtab: "shift+tab",
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
  | "claude-plan";

type ParsedPrompt = InteractivePrompt & {
  responder: Responder;
  menuLabels: string[];
  selectedIndex: number;
  checkedOptionIndices: number[];
  customMenuIndex: number | null;
  rejectWithEscapeIndex: number | null;
};

type AnswerStep = { keys?: string[]; text?: string };
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

function findLastIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index]!)) return index;
  }
  return -1;
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
    for (let lineIndex = row.lineIndex + 1; lineIndex < nextLineIndex; lineIndex += 1) {
      const description = cleanLine(lines[lineIndex]!);
      if (!description || isDivider(description)) continue;
      row.description = description;
      break;
    }
  }
  return rows;
}

function sequentialRows(rows: NumberedRow[]): boolean {
  return rows.length > 0 && rows.every((row, index) => row.number === index + 1);
}

function finishPrompt(
  agent: string,
  input: Omit<InteractivePrompt, "id" | "agent">,
  internal: Omit<ParsedPrompt, keyof InteractivePrompt>,
): ParsedPrompt {
  const id = createHash("sha256")
    .update(JSON.stringify({ agent, ...input }))
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
  };
  parsedByPublicPrompt.set(prompt, parsed);
  return prompt;
}

function parseOmpQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (line) => OMP_SINGLE_HINT_RE.test(cleanLine(line)) || OMP_MULTI_HINT_RE.test(cleanLine(line)));
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
  const hintIndex = findLastIndex(lines, (line) => CODEX_CONTINUE_HINT_RE.test(cleanLine(line)));
  if (hintIndex < 0) return null;
  const rows = parseNumberedRows(lines, Math.max(0, hintIndex - 64), hintIndex);
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
  const hintIndex = findLastIndex(lines, (line) => CODEX_ASK_HINT_RE.test(line));
  if (hintIndex < 0) return null;
  const rows = parseNumberedRows(lines, Math.max(0, hintIndex - 48), hintIndex);
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
  const hintIndex = findLastIndex(lines, (line) => CODEX_ASYNC_ASK_HINT_RE.test(line));
  if (hintIndex < 0) return null;
  const header = findLastIndex(lines.slice(Math.max(0, hintIndex - 48), hintIndex), (line) => CODEX_QUEUE_HEADER_RE.test(cleanLine(line)));
  const top = header < 0 ? Math.max(0, hintIndex - 48) : Math.max(0, hintIndex - 48) + header + 1;
  const rows = parseNumberedRows(lines, top, hintIndex);
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
  if (at < 0 || !/\bto answer$/i.test(lines[at + 1] ?? "") || !/^›\s/.test(lines[at + 2] ?? "")) return 0;
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

function parseClaudeQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (line) => CLAUDE_ASK_HINT_RE.test(line));
  if (hintIndex < 0) return null;
  const rows = parseNumberedRows(lines, Math.max(0, hintIndex - 64), hintIndex);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const chatIndex = rows.findIndex((row) => row.label === "Chat about this");
  const customIndex = rows.findIndex((row) => /^Type something\.?$/i.test(row.label));
  if (chatIndex !== rows.length - 1 || customIndex !== chatIndex - 1 || customIndex < 1) return null;
  const tabs = claudeTabs(lines, rows[0]!.lineIndex);
  const question = claudeQuestionText(lines, tabs?.index ?? -1, rows[0]!.lineIndex) ?? nearestQuestion(lines, rows[0]!.lineIndex);
  if (!question) return null;
  const optionRows = rows.slice(0, customIndex);
  const multiSelect = optionRows.some((row) => /^\s*(?:[›>❯]\s*)?\d+\.\s+\[[ xX✓]\]/.test(lines[row.lineIndex]!));
  const current = tabs?.tabs.findIndex((tab) => !tab.answered) ?? -1;
  // a bar cut off by a narrow pane does not show how many questions there are
  const title = tabs && current >= 0 ? `${tabs.tabs[current]!.label}${tabs.whole && tabs.tabs.length > 1 ? ` · ${current + 1} of ${tabs.tabs.length}` : ""}`
    : multiSelect ? "Multiple choice" : "Question";
  return finishPrompt("claude", {
    kind: "question", title, question, body: null,
    options: optionRows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multi_select: multiSelect, custom_option_index: multiSelect ? null : customIndex,
  }, {
    responder: "claude-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex, rejectWithEscapeIndex: null,
  });
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
  const planIndex = findLastIndex(lines, (line) => /Claude has written up a plan and is ready to execute\. Would you like to proceed\?/i.test(cleanLine(line)));
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
  const hintIndex = findLastIndex(lines, (line) => /esc to cancel/i.test(cleanLine(line)));
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

function promptTailIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const cleanLines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  const last = cleanLines.filter((line) => line && !isDivider(line)).at(-1) ?? "";
  if (prompt.responder === "omp-question") return OMP_SINGLE_HINT_RE.test(last) || OMP_MULTI_HINT_RE.test(last);
  if (prompt.responder === "codex-menu") return CODEX_CONTINUE_HINT_RE.test(last);
  if (prompt.responder === "codex-question") return CODEX_ASK_HINT_RE.test(last);
  if (prompt.responder === "codex-async-question") return cleanLines.slice(-4).some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line));
  if (prompt.responder === "claude-question") return CLAUDE_ASK_HINT_RE.test(last);
  if (prompt.responder === "claude-submit") return /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i.test(last);
  if (prompt.responder === "codex-approval") return /press enter to confirm|esc to cancel|enter continue.*esc back|^\d+\.\s+(?:No|Reject|Cancel|Deny)\b/i.test(last);
  if (prompt.responder === "omp-approval") return /^(?:Approve|Deny)$|esc.*cancel/i.test(last);
  if (prompt.responder === "claude-approval") return /esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain/i.test(last);
  return /ctrl\+g to edit|shift\+tab to approve with this feedback/i.test(last);
}

function parsePrompt(agent: string, screen: string): ParsedPrompt | null {
  const candidates = agent === "codex"
    ? [parseCodexContinueMenu(screen), parseCodexQuestion(screen), parseCodexAsyncQuestion(screen), parseCodexApproval(screen)]
    : agent === "omp"
      ? [parseOmpQuestion(screen), parseOmpApproval(screen)]
      : agent === "claude"
        ? [parseClaudeQuestion(screen), parseClaudeSubmit(screen), parseClaudeApproval(screen)]
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

export function parseInteractivePrompt(agent: string, screen: string): InteractivePrompt | null {
  const parsed = parsePrompt(agent, screen);
  return parsed ? publicPrompt(parsed) : null;
}

class InvalidAnswer extends Error {}

function navigationKeys(delta: number): string[] {
  return Array.from({ length: Math.abs(delta) }, () => delta > 0 ? KEY.down : KEY.up);
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
    const navigation = navigationKeys(parsed.customMenuIndex - parsed.selectedIndex);
    // Codex's queue types into its last row once it is selected: no enter first
    if (!["claude-question", "claude-plan", "codex-question", "codex-async-question"].includes(parsed.responder)) navigation.push(KEY.enter);
    if (parsed.responder === "codex-question") navigation.push(KEY.tab);
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
  if (!Number.isInteger(index) || index! < 0 || index! >= parsed.options.length || parsed.multi_select) {
    throw new InvalidAnswer("A valid option index is required.");
  }
  if (parsed.rejectWithEscapeIndex === index) return keySteps([KEY.escape]);
  return keySteps([...navigationKeys(index! - parsed.selectedIndex), KEY.enter]);
}

/**
 * The question each pane's queue opened on when that was not the card's (a skipped
 * question leaves the rollout's newest-first guess behind): the next card shows it.
 */
const queueFronts = new Map<string, QueueFront & { rollout: string }>();

/** Each pane's rollout, resolved for its collapsed queue: a poll every 2s would otherwise redo it. */
const queueRollouts = new Map<string, { path: string | null; at: number }>();
const QUEUE_ROLLOUT_MS = 15_000;

async function readPrompt(paneId: string, codexHome?: string): Promise<{ agent: string; prompt: InteractivePrompt | null }> {
  const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const agent = pane.agent ?? "";
  if (agent !== "claude" && agent !== "omp" && agent !== "codex") return { agent, prompt: null };
  const screen = await paneRead({ paneId, source: "visible", format: "text" });
  const prompt = parseInteractivePrompt(agent, screen.text);
  const count = agent === "codex" && prompt === null ? queuedQuestionCount(screen.text) : 0;
  if (count === 0 || !pane.cwd) return { agent, prompt };
  let rollout = queueRollouts.get(paneId);
  if (!rollout || Date.now() - rollout.at > QUEUE_ROLLOUT_MS) {
    rollout = { path: await codexTranscriptPath(paneId, pane.cwd, codexHome), at: Date.now() };
    queueRollouts.set(paneId, rollout);
    if (queueRollouts.size > 64) queueRollouts.delete(queueRollouts.keys().next().value!);
  }
  try {
    // a question remembered from another rollout (a new session) means nothing here
    const front = queueFronts.get(paneId);
    if (front && front.rollout !== rollout.path) queueFronts.delete(paneId);
    return {
      agent,
      prompt: rollout.path ? codexQueuedPrompt(screen.text, await unansweredCodexQuestions(rollout.path), front?.rollout === rollout.path ? front : null) : null,
    };
  } catch {
    return { agent, prompt: null }; // the rollout went away
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
    const screen = (await paneRead({ paneId, source: "visible", format: "text" })).text;
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
async function openQueuedQuestion(paneId: string, queued: ParsedPrompt): Promise<InteractivePrompt | null> {
  // the key only once the screen still shows the questions' count, nothing of the user's queued
  if (queuedQuestionCount((await paneRead({ paneId, source: "visible", format: "text" })).text) === 0) return null;
  await paneSendKeys(paneId, [KEY.openQueue]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(100);
    const opened = parsePrompt("codex", (await paneRead({ paneId, source: "visible", format: "text" })).text);
    if (opened?.responder !== "codex-async-question") continue;
    if (sameText(opened.question, queued.question) && opened.options.length === queued.options.length
      && opened.options.every((option, index) => sameText(option.label, queued.options[index]!.label))) return publicPrompt(opened);
    const rollout = queueRollouts.get(paneId)?.path;
    if (rollout) queueFronts.set(paneId, { question: opened.question, options: opened.options.map((option) => option.label), rollout });
    if (queueFronts.size > 64) queueFronts.delete(queueFronts.keys().next().value!);
    break;
  }
  // not the card's question (a skip can leave the rollout's guess behind), or nothing opened:
  // never leave the queue open, where it would hold the input a message goes to
  await closeOpenQuestion(paneId);
  return null;
}

/** Closes Codex's queue if a question shows open in it. */
async function closeOpenQuestion(paneId: string): Promise<void> {
  const screen = (await paneRead({ paneId, source: "visible", format: "text" })).text;
  if (parsePrompt("codex", screen)?.responder === "codex-async-question") await paneSendKeys(paneId, [KEY.closeQueue]);
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
      return jsonResponse({ prompt: (await readPrompt(paneId, options.codexHome)).prompt });
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
    return await serialize(body.pane_id, async () => {
      const { prompt } = await readPrompt(body.pane_id, options.codexHome);
      if (!prompt || prompt.id !== body.prompt_id) return promptChanged();
      // checked against the card before anything is sent: an invalid answer never opens the queue
      let steps: AnswerStep[];
      try {
        steps = answerKeys(prompt, body);
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      }
      let target = prompt;
      const opensQueue = parsedByPublicPrompt.get(prompt)?.responder === "codex-queued-question";
      if (opensQueue) {
        // the card came from the rollout: answer it in the open queue, once it shows this question
        const opened = await openQueuedQuestion(body.pane_id, parsedByPublicPrompt.get(prompt)!);
        if (!opened) return promptChanged();
        target = opened;
      }
      let answered = false;
      try {
        // the keys for the question as it shows in the open queue
        if (target !== prompt) steps = answerKeys(target, body);
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index]!;
          if (step.keys) await paneSendKeys(body.pane_id, step.keys);
          else if (step.text !== undefined) await paneSendText(body.pane_id, step.text);
          if (index < steps.length - 1) await Bun.sleep(30);
        }
        answered = true;
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      } finally {
        // the queue this request opened never stays open, whatever failed on the way
        if (opensQueue && !answered) await closeOpenQuestion(body.pane_id).catch(() => undefined);
      }
      // answered from the chat, the queue closes again: the next question waits collapsed, and
      // the main prompt (where a message typed in the chat goes) has the input back
      if (parsedByPublicPrompt.get(target)?.responder === "codex-async-question") {
        queueFronts.delete(body.pane_id);
        await closeQueue(body.pane_id, target.id);
      }
      return jsonResponse({ ok: true });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
