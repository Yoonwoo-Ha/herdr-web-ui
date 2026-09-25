import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";

/**
 * The agent's todo list as it stands, from its todo tool calls. Each agent keeps its list
 * its own way:
 * - Claude Code `TodoWrite` and Codex `update_plan` send the whole list every time;
 * - omp / omo `todo`, gjc `todo_write` (and omo's `mcp__…__todo` through Claude) send
 *   operations (init, append, start, done, drop, block, note) on one list, and answer
 *   each call with the whole list as it now stands.
 * Calls are replayed in order; an answer that lists the whole list wins over the replay,
 * so a list started before the loaded pages is still right.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked" | "dropped";

export interface TodoItem {
  label: string;
  /** the phase (omp, omo, gjc) the item belongs to */
  phase: string | null;
  status: TodoStatus;
  /** why it is blocked, or a note the agent attached */
  note?: string;
}

type Tool = Extract<ConversationPart, { kind: "tool" }>;
type Kind = "whole" | "codex-plan" | "ops";

function toolKind(name: string): Kind | null {
  if (name === "TodoWrite") return "whole";
  if (name === "update_plan") return "codex-plan";
  if (name === "todo" || name === "todo_write" || /^mcp__.+__todo$/.test(name)) return "ops";
  return null;
}

export function isTodoTool(name: string): boolean {
  return toolKind(name) !== null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function args(part: Tool): Record<string, unknown> {
  try { return record(JSON.parse(part.input)); } catch { return {}; }
}

function statusOf(value: unknown): TodoStatus {
  return value === "completed" || value === "in_progress" || value === "blocked" ? value : value === "cancelled" || value === "dropped" ? "dropped" : "pending";
}

/** The operations of one `todo` / `todo_write` call: `ops: [...]`, or the call itself as one. */
function operations(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input["ops"]) ? input["ops"].map(record) : [input];
}

function phases(list: unknown): TodoItem[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const phase = record(entry);
    const name = text(phase["phase"]);
    const items = Array.isArray(phase["items"]) ? phase["items"] : [];
    return items.flatMap((item) => text(item) === null ? [] : [{ label: text(item)!, phase: name, status: "pending" as TodoStatus }]);
  });
}

function find(items: TodoItem[], label: string | null): TodoItem | undefined {
  if (label === null) return undefined;
  return items.find((item) => item.label === label) ?? items.find((item) => item.label.toLowerCase() === label.toLowerCase());
}

function applyOperation(items: TodoItem[], op: Record<string, unknown>): TodoItem[] {
  const kind = text(op["op"]) ?? (Array.isArray(op["list"]) ? "init" : null);
  const task = text(op["task"]);
  const phase = text(op["phase"]);
  const inPhase = (item: TodoItem) => phase !== null && item.phase === phase;
  switch (kind) {
    case "init":
      return phases(op["list"]);
    case "clear":
      return [];
    case "append": {
      const added = (Array.isArray(op["items"]) ? op["items"] : []).flatMap((item) => text(item) === null ? [] : [{ label: text(item)!, phase, status: "pending" as TodoStatus }]);
      // into its phase, after that phase's last item, as the agent lists it
      const last = phase === null ? -1 : items.map((item) => item.phase).lastIndexOf(phase);
      return last < 0 ? [...items, ...added] : [...items.slice(0, last + 1), ...added, ...items.slice(last + 1)];
    }
    case "done":
    case "start":
    case "drop":
    case "block":
    case "note": {
      const next = items.map((item) => ({ ...item }));
      const target = find(next, task);
      const touched = target !== undefined ? [target] : task === null ? next.filter(inPhase) : [];
      for (const item of touched) {
        if (kind === "done" && item.status !== "dropped") item.status = "completed";
        else if (kind === "start") item.status = "in_progress";
        else if (kind === "drop" && item.status !== "completed") item.status = "dropped";
        else if (kind === "block") { item.status = "blocked"; item.note = text(op["reason"]) ?? item.note; }
        else if (kind === "note") item.note = text(op["text"]) ?? item.note;
      }
      return next;
    }
    default:
      return items;
  }
}

/** omp, omo and gjc start the next open item once none is in progress. */
function advance(items: TodoItem[]): TodoItem[] {
  if (items.some((item) => item.status === "in_progress")) return items;
  const next = items.findIndex((item) => item.status === "pending");
  return next < 0 ? items : items.map((item, index) => index === next ? { ...item, status: "in_progress" } : item);
}

const EMPTY_ANSWER = /^(?:Todo list is empty\.|Todo list cleared\.)/m;

/**
 * The whole list from a `todo` answer, when it has one:
 *   `  Phase:` then `    - [X] item`, `    - [ ] item (in progress)`, `    - [ ] item (dropped)` (omp, omo)
 *   or `    ✓ item`, `    → item`, `    ○ item` (gjc).
 * Null when the answer has no list, or was cut before its end.
 */
export function parseTodoAnswer(output: string): TodoItem[] | null {
  if (output.endsWith("… trimmed")) return null;
  if (EMPTY_ANSWER.test(output) && !/^ {4}\S/m.test(output)) return [];
  const items: TodoItem[] = [];
  let phase: string | null = null;
  for (const line of output.split("\n")) {
    const heading = /^ {2}(\S.*):$/.exec(line);
    if (heading) { phase = heading[1]!; continue; }
    const box = /^ {4}- \[(X| )\] (.+)$/.exec(line);
    if (box) {
      let label = box[2]!;
      let status: TodoStatus = box[1] === "X" ? "completed" : "pending";
      let note: string | undefined;
      const suffix = / \((in progress|dropped|blocked)(?:: (.*))?\)$/.exec(label);
      if (suffix) {
        label = label.slice(0, suffix.index);
        status = suffix[1] === "in progress" ? "in_progress" : suffix[1] === "dropped" ? "dropped" : "blocked";
        note = suffix[2];
      }
      items.push(note === undefined ? { label, phase, status } : { label, phase, status, note });
      continue;
    }
    const glyph = /^ {4}([✓→○✗⊘!]) (.+)$/.exec(line);
    if (glyph) {
      const mark = glyph[1];
      items.push({ label: glyph[2]!, phase, status: mark === "✓" ? "completed" : mark === "→" ? "in_progress" : mark === "○" ? "pending" : mark === "!" ? "blocked" : "dropped" });
    }
  }
  if (items.length === 0) return null;
  // `Overall: 9/11 done` counts every item: a list shorter than that was cut
  const overall = /^Overall: \d+\/(\d+) done/m.exec(output);
  if (overall && Number(overall[1]) > items.length) return null;
  return items;
}

/** The todo list after every todo call in these turns, oldest first; null when there was none. */
export function todoState(turns: readonly ConversationTurn[]): TodoItem[] | null {
  let items: TodoItem[] | null = null;
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind !== "tool") continue;
      const kind = toolKind(part.name);
      if (kind === null) continue;
      const input = args(part);
      if (kind === "whole") {
        const todos = Array.isArray(input["todos"]) ? input["todos"] : [];
        items = todos.flatMap((todo) => {
          const entry = record(todo);
          const label = text(entry["content"]);
          return label === null ? [] : [{ label, phase: null, status: statusOf(entry["status"]) }];
        });
      } else if (kind === "codex-plan") {
        const plan = Array.isArray(input["plan"]) ? input["plan"] : [];
        items = plan.flatMap((step) => {
          const entry = record(step);
          const label = text(entry["step"]);
          return label === null ? [] : [{ label, phase: null, status: statusOf(entry["status"]) }];
        });
      } else {
        let next: TodoItem[] = items ?? [];
        for (const op of operations(input)) next = applyOperation(next, op);
        items = parseTodoAnswer(part.output) ?? advance(next);
      }
    }
  }
  return items;
}

/** One line for a todo call in the work block, instead of its raw input. */
export function todoCallSummary(part: Tool): string | null {
  const kind = toolKind(part.name);
  if (kind === null) return null;
  const input = args(part);
  if (kind === "whole" || kind === "codex-plan") {
    const list = Array.isArray(input[kind === "whole" ? "todos" : "plan"]) ? input[kind === "whole" ? "todos" : "plan"] as unknown[] : [];
    const done = list.filter((entry) => record(entry)["status"] === "completed").length;
    return `${done}/${list.length} done`;
  }
  const lines = operations(input).map((op) => {
    const what = text(op["op"]) ?? (Array.isArray(op["list"]) ? "init" : "update");
    if (what === "init") {
      const items = phases(op["list"]);
      return `plan · ${items.length} item${items.length === 1 ? "" : "s"}`;
    }
    if (what === "append") return `add · ${(Array.isArray(op["items"]) ? op["items"] : []).filter((item) => text(item) !== null).length} to ${text(op["phase"]) ?? "list"}`;
    const target = text(op["task"]) ?? text(op["phase"]);
    return target === null ? what : `${what} · ${target}`;
  });
  return lines.join(", ");
}
