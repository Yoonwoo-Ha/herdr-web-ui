import { paneRead } from "../herdr/client.ts";
import { ANSI_RE, type OmoAsk, PI_MODEL_HINT_RE, PROMPT_LINE_RE, type ParsedPrompt, SOLID_RULE_RE, cleanLine, findLastIndex, isDivider, wrapped } from "./shared.ts";
import { registry } from "./registry.ts";
import { CODEX_ASK_HINT_RE, CODEX_ASYNC_ASK_HINT_RE, CODEX_CONTINUE_HINT_RE } from "./codex.ts";
import { OMO_FOOTER_LINES, OMO_HINT_LINES, OMO_NOT_FOOTER_RE, OMO_OPTIONS_HINT_RE, OMO_PENDING_HINT_RE, OMO_REVIEW_HINT_RE, OMO_TYPING_HINT_RE, omoModelListWaits } from "./omo.ts";
import { CLAUDE_ASK_HINT_RE, CLAUDE_CONFIRM_HINT_RE, CLAUDE_EFFORT_HINT_RE, claudeModelListWaits, withoutClaudeSidePanel, withoutClaudeTasks } from "./claude.ts";
import { OMP_CLIPPED_SINGLE_HINT_RE, OMP_MULTI_CLIPPED_HINT_RE, OMP_MULTI_HINT_RE, OMP_REVIEW_HINT_RE, OMP_SINGLE_CLIPPED_HINT_RE, OMP_SINGLE_HINT_RE, ompApprovalPanelShown } from "./omp.ts";
import { HERMES_HINT_RE } from "./hermes.ts";
import { AGY_ASK_HINT_RE } from "./agy.ts";
import { PI_INPUT_HINT_RE, PI_MENU_HINT_RE, PI_THINKING_HINT_LINES } from "./pi.ts";
import { openCodeV1QuestionActive } from "./opencode.ts";
import { isPiQuestionnaireScreen } from "./pi-questionnaire.ts";
import { cmdFooterStart } from "./cmd.ts";
import { dshQuestionActive } from "./dsh.ts";

/**
 * A row of OmO's omo-task widget under the input box (omo-ai plugin/extensions/omo-task.js): a live row
 * `<spinner> <task> · <route> · <state>[ · <elapsed>]` with the route `agent:X`, `category:X` or `task`,
 * a finished row `<task>|<route> <mode> <status>`, or the `+N more` line after five rows.
 */
const OMO_TASK_ROW_RE = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏‖] .+? · (?:agent:|category:|task(?: ·|$))|[^|]+\|(?:agent:|category:|task\b)|\+\d+ more$)/u;
const OMO_SPINNER_ROW_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏‖] /u;
const OMO_TASK_TAIL_RE = /^(?:[^\u00b7]+ \u00b7 )*\d+[hms](?: \d+[hms])*$/u;
const OMO_TASK_WRAP_MAX = 32;
const OMO_HINT_END_RE = /\besc (?:cancel|back|discard)$/;
/** OmO's apparently empty input box; never sufficient evidence for sending text into it. */
const OMO_EMPTY_BOX_RE = /^[❯›>]$/;

/**
 * omp's status row (18.12.6 with `composer.shape: pi`): a spinner and the elapsed time while the agent waits, or
 * `π` at rest, then its ` · `-separated fields, e.g. ` ⠋ 0s · ⬢ Ask fixture · 🗑 …/home/fixture · ◫ 5.7%/131K ⟲`.
 */
const OMP_STATUS_ROW_RE = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \S+|π) · /u;
const OMP_PANEL_BOTTOM_RE = /^╰─+╯$/u;

/**
 * omp prints its status row right under the Ask panel's bottom border while the question waits (#1644), one empty
 * row lower in the composer shapes that keep a gap over it (`rule`, `field`, `rail`; pi-tui `bottomBarGap`).
 */
function withoutOmpStatusRow(visible: string[], cleanLines: string[]): string[] {
  const end = findLastIndex(cleanLines, (line) => line !== "");
  const border = cleanLines[end - 1] === "" ? end - 2 : end - 1;
  if (border < 1 || !OMP_STATUS_ROW_RE.test(cleanLines[end]!) || !OMP_PANEL_BOTTOM_RE.test(cleanLines[border]!)
    || cleanLines[border - 1] !== visible.at(-2)) return visible;
  return visible.slice(0, -1);
}

const CLAUDE_SUBMIT_TAIL_RE = /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i;

function omoFooterIsActive(lines: string[]): boolean {
  let rules = 0;
  let footer = 0;
  let widget = false;
  let tail = false;
  for (const line of lines) {
    if (!line) continue;
    if (OMO_SPINNER_ROW_RE.test(line) && !OMO_TASK_ROW_RE.test(line)) return false;
    if (SOLID_RULE_RE.test(line)) {
      if (rules > 0 || footer > 0) return false;
      rules = 1;
    } else if (rules > 0 && footer === 0 && (
      /^(?:[▶◌✗✓] .*\bcategory:|▶ .* \bwave \d+\/\d+\b)/.test(line)
      || (widget && /^(?:\d+[hms]\s*)+$/.test(line))
    )) {
      tail = false;
      widget = true;
    } else if (rules > 0 && footer === 0 && !OMO_NOT_FOOTER_RE.test(line) && (
      OMO_TASK_ROW_RE.test(line)
      || (tail && line.length <= OMO_TASK_WRAP_MAX && OMO_TASK_TAIL_RE.test(line))
    )) {
      tail = OMO_TASK_ROW_RE.test(line);
    } else if (rules === 0 || ++footer > OMO_FOOTER_LINES || OMO_NOT_FOOTER_RE.test(line)) return false;
  }
  return rules === 1;
}

export function promptTailIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const cleanLines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  const visible = cleanLines.filter((line) => line && !isDivider(line));
  // Claude's review has no hint of its own: its last row ends the panel, the session's rule and task list come after it
  const shown = prompt.responder === "claude-submit" ? withoutClaudeTasks(visible, (lines, end) => CLAUDE_SUBMIT_TAIL_RE.test(lines[end - 1] ?? ""))
    : prompt.responder.startsWith("claude-") ? withoutClaudeTasks(visible)
    : prompt.responder === "omp-question" || prompt.responder === "omp-submit" ? withoutOmpStatusRow(visible, cleanLines) : visible;
  const last = shown.at(-1) ?? "";
  // The menu is still at the bottom. A narrow pane wraps its hint, so the last line alone can
  // be the hint's tail (`cancel`): the lines before it count only when the match runs into
  // the last one, never for a hint that ended above later output (an answered, stale menu).
  const ends = (re: RegExp): boolean => [1, 2, 3].some((span) =>
    re.test(shown.slice(-span).join(" ")) && (span === 1 || !re.test(shown.slice(-span, -1).join(" "))));
  if (prompt.responder.startsWith("pi-questionnaire-")) return true;
  if (prompt.responder === "pi-ask-question" || prompt.responder === "pi-ask-submit") return true;
  if (prompt.responder === "omp-question") return ends(OMP_SINGLE_HINT_RE) || ends(OMP_CLIPPED_SINGLE_HINT_RE) || ends(OMP_SINGLE_CLIPPED_HINT_RE) || ends(OMP_MULTI_HINT_RE)
    || ends(OMP_MULTI_CLIPPED_HINT_RE);
  if (prompt.responder === "omp-submit") return ends(OMP_REVIEW_HINT_RE);
  // Hermes keeps its status line (and maybe the hint's wrapped tail) under the hint; an answered
  // question leaves the screen, so a hint among the last few lines is the live one
  if (prompt.responder === "hermes-question" || prompt.responder === "hermes-input") return shown.slice(-4).some((line) => HERMES_HINT_RE.test(line));
  if (prompt.responder === "agy-question") return shown.slice(-6).some((_, at, tail) => AGY_ASK_HINT_RE.test(tail.slice(at, at + 3).join(" ")));
  if (prompt.responder === "hermes-approval") return true;
  if (prompt.responder === "codex-menu") return ends(CODEX_CONTINUE_HINT_RE);
  if (prompt.responder === "codex-question") return ends(CODEX_ASK_HINT_RE);
  if (prompt.responder === "codex-async-question") return cleanLines.slice(-4).some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line)) || ends(CODEX_ASYNC_ASK_HINT_RE);
  if (prompt.responder === "claude-question") return ends(CLAUDE_ASK_HINT_RE);
  if (prompt.responder === "claude-submit") return CLAUDE_SUBMIT_TAIL_RE.test(last);
  // Codex's folder trust prompt ends "enter continue · esc back" or, from 0.163, "· esc quit".
  // Only those two: its update prompt ends "· esc skip" and must not read as an approval.
  if (prompt.responder === "codex-approval") return ends(/press enter to confirm|esc to cancel|enter continue\s*·\s*esc (?:back|quit)$|^(?:[›>❯]\s*)?\d+\.\s+(?:No|Reject|Cancel|Deny)\b/i);
  // the panel (with 18.13's composer under it), or the older Approve/Deny menu's rows
  if (prompt.responder === "omp-approval") return ompApprovalPanelShown(screen) || ends(/^(?:[›>❯•]\s*)?(?:Approve|Deny)$|esc.*cancel/i);
  // Claude Code 2.1.29x ends with "Esc to cancel", optionally followed by its stop-agents chord
  if (prompt.responder === "claude-approval") return ends(/esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain|^esc to cancel(?:\s*·\s*ctrl\+x ctrl\+k twice to stop background agents)?$/i);
  if (prompt.responder === "claude-confirm") return ends(CLAUDE_CONFIRM_HINT_RE);
  if (prompt.responder === "claude-held") return true;
  if (prompt.responder === "omp-handoff") return true;
  if (prompt.responder === "claude-goal") return ends(/esc to dismiss$/i);
  if (prompt.responder === "claude-model") return claudeModelListWaits(screen);
  if (prompt.responder === "claude-effort") return ends(CLAUDE_EFFORT_HINT_RE);
  if (prompt.responder === "letta-model") return ends(/^(?:enter select · ↑↓ navigate · ←→\/tab switch · esc cancel|no models match your search\.)$/i);
  if (prompt.responder === "letta-effort") return ends(/^enter select · ←→\/tab switch · esc back$/i);
  if (prompt.responder === "codex-model") return ends(/(?:^|\s)enter select\s*·\s*esc back$|(?:^|\s)enter (?:default|apply)\s*·\s*s session\s*·\s*esc back$/i);
  if (prompt.responder === "omo-question" || prompt.responder === "omo-review" || prompt.responder === "omo-typing") {
    // The form is live only with OmO's footer and extension status under its hint: blank lines, one
    // rule, status widgets, then the footer's few lines (cwd, context, model).
    const hint = { "omo-question": OMO_OPTIONS_HINT_RE, "omo-review": OMO_REVIEW_HINT_RE, "omo-typing": OMO_TYPING_HINT_RE }[prompt.responder];
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && hint.test(wrapped(cleanLines, index, OMO_HINT_LINES)));
    if (at < 0) return false;
    let end = at;
    while (end < at + OMO_HINT_LINES && !OMO_HINT_END_RE.test(cleanLines.slice(at, end + 1).join(" ").trim())) end += 1;
    if (end >= at + OMO_HINT_LINES) return false;
    return omoFooterIsActive(cleanLines.slice(end + 1));
  }
  if (prompt.responder === "omo-pending") {
    // The widget is live over OmO's input box, other widgets maybe between them: the box (a rule,
    // the box's line, empty, a rule) and then OmO's extension status and native footer.
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && OMO_PENDING_HINT_RE.test(wrapped(cleanLines, index)));
    const box = cleanLines.findIndex((line, index) => index > at && OMO_EMPTY_BOX_RE.test(line));
    if (at < 0 || box < 0 || box - at > 60 || !cleanLines[box - 1]!.startsWith("─")) return false;
    return omoFooterIsActive(cleanLines.slice(box + 1));
  }
  // pi keeps its footer under every dialog — the pane's folder, then its stats line, then any
  // extension status (piFooterLines) — so the hint sits near the end without being it.
  if (prompt.responder === "pi-model") return hintAtEnd(shown, PI_MODEL_HINT_AT_END_RE, piFooterLines(shown));
  if (prompt.responder === "pi-thinking") return hintAtEnd(shown, PI_MODEL_HINT_AT_END_RE, piFooterLines(shown), PI_THINKING_HINT_LINES);
  if (prompt.responder === "omo-model") return omoModelListWaits(screen);
  if (prompt.responder === "omp-model") return true;
  if (prompt.responder === "pi-question" || prompt.responder === "pi-confirm" || prompt.responder === "pi-input") {
    return hintAtEnd(shown, PI_MENU_HINT_AT_END_RE, piFooterLines(shown), 4)
      || hintAtEnd(shown, PI_INPUT_HINT_AT_END_RE, piFooterLines(shown), 4);
  }
  if (prompt.responder === "cmd-question") return cmdFooterStart(shown) >= 0;
  if (prompt.responder === "dsh-question") return dshQuestionActive(screen);
  if (prompt.responder === "opencode-v1-question") return openCodeV1QuestionActive(screen);
  return ends(/ctrl\+g to edit|shift\+tab to approve with this feedback/i) || claudePlanFooterEnds(shown);
}

const CLAUDE_PLAN_FOOTER_RE = /^ctrl\+g to edit in [^·]+?[ \n]·[ \n]([^]+)$/i;

/**
 * Whether Claude's plan footer, `ctrl+g to edit in VS Code · ~/.claude/plans/x.md`, ends the screen. A narrow pane
 * wraps it with nothing marking the breaks: at a space before the path, or anywhere inside the path, even
 * between `.m` and `d`, and over as many lines as the path needs. The folder may hold a `·` (`CLAUDE_CONFIG_DIR`).
 */
function claudePlanFooterEnds(shown: string[]): boolean {
  const at = findLastIndex(shown, (line) => /^ctrl\+g to edit\b/i.test(line));
  const path = at < 0 ? undefined : CLAUDE_PLAN_FOOTER_RE.exec(shown.slice(at).join("\n"))?.[1];
  if (path === undefined) return false;
  const joined = path.replaceAll("\n", "");
  return joined.indexOf(".md") === joined.length - 3;
}
const PI_MENU_HINT_AT_END_RE = new RegExp(`${PI_MENU_HINT_RE.source}$`, "i");
const PI_INPUT_HINT_AT_END_RE = new RegExp(`${PI_INPUT_HINT_RE.source}$`, "i");
const PI_MODEL_HINT_AT_END_RE = new RegExp(`${PI_MODEL_HINT_RE.source}$`, "i");
/**
 * pi's own footer, under `/model` and under every dialog alike: the pane's folder, then its
 * stats line.
 */
const PI_FOOTER_LINES = 2;

/**
 * pi's stats line, its second footer line: usage counters (`↑1.2k ↓300 R… W… CH…% $0.012 (sub)`), then
 * the context meter (`3.7%/1.0M`, `?/200k`). The meter comes last, and a narrow pane cuts the line
 * with `...` before it (`↑52 ↓5.3k R460k W33k CH98.9% $0.461 (sub) 3.7...`), so the line is told by how
 * it starts: both counters (`↑52 ↓5.3k`), or the meter when pi has no usage yet, optionally
 * preceded by the cost (`$0.000 (sub) 0.0%/1.0M` in pi 1.5.0).
 */
const PI_STATS_LINE_RE = /^(?:↑[\d.]+[kKmMbB]? ↓[\d.]+[kKmMbB]?|(?:\$\d+\.\d{3}(?: \(sub\))? )?(?:\d+(?:\.\d+)?%|\?)\/[\d.]+[kKmMbB]?)(?:\s|\.\.\.|$)/u;

const PI_FOLDER_LINE_RE = /^(?:~(?:[\\/]|\s|$)|\/|[A-Za-z]:[\\/])/u;

/**
 * An extension's `ctx.ui.setStatus` adds a third footer line under the stats line: pi joins every
 * status into that one line and truncates it to the pane's width, so it never wraps (pi 1.4.0's
 * footer). pi mounts its footer last, so while it runs nothing else can follow the stats line.
 */
function piFooterLines(shown: string[]): number {
  // Windows names no foreground process to tell a live pi from the shell under its last screen: no status line there
  if (process.platform === "win32") return PI_FOOTER_LINES;
  const status = shown.at(-1) ?? "";
  const footer = PI_FOLDER_LINE_RE.test(shown.at(-3) ?? "") && PI_STATS_LINE_RE.test(shown.at(-2) ?? "");
  return footer && !PROMPT_LINE_RE.test(status) ? PI_FOOTER_LINES + 1 : PI_FOOTER_LINES;
}

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

export function parsePrompt(agent: string, fullScreen: string, omoAsk: OmoAsk | null = null, omoTrusted = true, omoOpen: OmoAsk[] = [], sent: string | null = null, working = false): ParsedPrompt | null {
  const screen = agent === "claude" ? withoutClaudeSidePanel(fullScreen) : fullScreen;
  if (agent === "pi" && isPiQuestionnaireScreen(screen)) return null;
  const ctx = { agent, omoAsk, omoTrusted, omoOpen, sent, working };
  for (const reader of registry.readersFor(agent)) {
    if (reader.kind === "result") continue;
    const candidate = reader.parse(screen, ctx);
    if (candidate !== null && promptTailIsActive(candidate, screen)) return candidate;
  }
  return null;
}

/**
 * The pane's live screen as text: herdr's bottom buffer, whatever part of the history the pane's
 * viewport shows. A pane scrolled up (a drag or the wheel in a terminal) stays scrolled while the
 * agent draws its next menu at the bottom, out of that viewport.
 */
export async function liveScreen(paneId: string): Promise<string> {
  return (await paneRead({ paneId, source: "detection", format: "text" })).text;
}
