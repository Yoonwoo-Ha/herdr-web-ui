import { createHash } from "node:crypto";

import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
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
// several questions navigate between tabs: "Tab/Arrow keys to navigate"
const CLAUDE_ASK_HINT_RE = /enter to select.*(?:↑\/↓|tab\/arrow keys) to navigate.*esc to cancel/i;
const CLAUDE_TABS_RE = /^←.*Submit\s*→$/;
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
} as const;

type Responder =
  | "codex-question"
  | "codex-async-question"
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
  /** one of several Claude questions: → moves to the next one, not to Submit */
  tabbed?: boolean;
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

function parseCodexAsyncQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (line) => CODEX_ASYNC_ASK_HINT_RE.test(line));
  if (hintIndex < 0) return null;
  const rows = parseNumberedRows(lines, Math.max(0, hintIndex - 48), hintIndex);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^Other\b/i.test(row.label));
  if (customIndex !== rows.length - 1 || customIndex < 1) return null;
  const question = nearestQuestion(lines, rows[0]!.lineIndex);
  if (!question) return null;
  return finishPrompt("codex", {
    kind: "question", title: "Question", question, body: null,
    options: rows.slice(0, customIndex).map((row) => ({ label: row.label, description: row.description ?? null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "codex-async-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
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
  const question = nearestQuestion(lines, rows[0]!.lineIndex);
  if (!question) return null;
  const optionRows = rows.slice(0, customIndex);
  const multiSelect = optionRows.some((row) => /^\s*(?:[›>❯]\s*)?\d+\.\s+\[[ xX✓]\]/.test(lines[row.lineIndex]!));
  const tabs = claudeTabs(lines, rows[0]!.lineIndex);
  const current = tabs.findIndex((tab) => !tab.answered);
  const title = tabs.length > 1 && current >= 0 ? `${tabs[current]!.label} · ${current + 1} of ${tabs.length}`
    : multiSelect ? "Multiple choice" : "Question";
  return finishPrompt("claude", {
    kind: "question", title, question, body: null,
    options: optionRows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multi_select: multiSelect, custom_option_index: multiSelect ? null : customIndex,
  }, {
    responder: "claude-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex, rejectWithEscapeIndex: null, tabbed: tabs.length > 1,
  });
}

/** Claude's question tabs above several questions: `←  ☒ Route  ☐ Author  ✔ Submit  →`. */
function claudeTabs(lines: string[], beforeIndex: number): { label: string; answered: boolean }[] {
  const tabsIndex = findLastIndex(lines.slice(Math.max(0, beforeIndex - 8), beforeIndex), (line) => CLAUDE_TABS_RE.test(cleanLine(line)));
  if (tabsIndex < 0) return [];
  const bar = cleanLine(lines[Math.max(0, beforeIndex - 8) + tabsIndex]!).replace(/^←|→$/g, "");
  return [...bar.matchAll(/([☐☒☑✔])\s+(.+?)(?=\s{2,}|\s*$)/g)]
    .filter((match) => match[2] !== "Submit")
    .map((match) => ({ label: match[2]!, answered: match[1] !== "☐" }));
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
    kind: "question", title: "Review your answers", question: cleanLine(lines[questionIndex]!), body: body || null,
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
    const ruleIndex = findLastIndex(lines.slice(0, questionIndex), (line) => /^[─━]{8,}$/.test(cleanLine(line)));
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
    // an approval's options have no descriptions: a line under one is its label wrapped by a narrow pane
    options: rows.map((row) => ({ label: row.description ? `${row.label} ${row.description}` : row.label, description: null })),
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
  if (parsePrompt("codex", screen) !== null) return false;
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  const header = findLastIndex(lines, (line) => /^(?:•\s*)?Queued follow-up inputs$/.test(line));
  if (header < 0 || lines.length - header > 16 || lines.some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line))) return false;
  const count = lines.findIndex((line, index) => index > header && /^\?\s*\d+\s+questions?\b/.test(line));
  if (count < 0 || count > header + 7) return false;
  return /\bto answer$/i.test(lines[count + 1] ?? "") && /^›\s/.test(lines[count + 2] ?? "");
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
    if (parsed.responder !== "claude-question" && parsed.responder !== "claude-plan" && parsed.responder !== "codex-question") navigation.push(KEY.enter);
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
    // one of several questions: → goes on to the next one; alone, → reaches Submit and enter sends it
    else if (parsed.responder === "claude-question") keys.push(...(parsed.tabbed ? [KEY.right] : [KEY.right, KEY.enter]));
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

async function readPrompt(paneId: string): Promise<{ agent: string; prompt: InteractivePrompt | null }> {
  const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const agent = pane.agent ?? "";
  if (agent !== "claude" && agent !== "omp" && agent !== "codex") return { agent, prompt: null };
  const screen = await paneRead({ paneId, source: "visible", format: "text" });
  return { agent, prompt: parseInteractivePrompt(agent, screen.text) };
}

function promptChanged(): Response {
  return jsonResponse({ error: { code: "prompt_changed", message: "The interactive prompt changed; reopen it and try again." } }, 409);
}

export interface PromptRequestOptions {
  /** runs a pane's answer after the input already queued for it (a composer message in flight) */
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
}

export async function handlePromptRequest(request: Request, url: URL, options: PromptRequestOptions = {}): Promise<Response | null> {
  if (url.pathname !== "/api/pane/prompt" && url.pathname !== "/api/pane/prompt/answer") return null;
  try {
    if (url.pathname === "/api/pane/prompt") {
      if (request.method !== "GET") return badRequest("method_not_allowed", "GET is required.");
      const paneId = url.searchParams.get("pane_id")?.trim();
      if (!paneId) return badRequest("missing_pane_id", "pane_id is required.");
      return jsonResponse({ prompt: (await readPrompt(paneId)).prompt });
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

    // read, checked and answered in the pane's turn: a message still in flight goes first
    const serialize = options.serialize ?? (<T>(_paneId: string, task: () => Promise<T>) => task());
    return await serialize(body.pane_id, async () => {
      const { prompt } = await readPrompt(body.pane_id);
      if (!prompt || prompt.id !== body.prompt_id) return promptChanged();
      let steps: AnswerStep[];
      try {
        steps = answerKeys(prompt, body);
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      }
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]!;
        if (step.keys) await paneSendKeys(body.pane_id, step.keys);
        else if (step.text !== undefined) await paneSendText(body.pane_id, step.text);
        if (index < steps.length - 1) await Bun.sleep(30);
      }
      return jsonResponse({ ok: true });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
