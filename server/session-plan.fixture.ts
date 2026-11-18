import { afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetPlans } from "./session-plan.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetPlans();
});

export const at = (minute: number): string => new Date(Date.parse("2026-10-07T00:00:00.000Z") + minute * 60_000).toISOString();
export const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

export function file(name = "s.jsonl"): { path: string; add: (entry: unknown) => void } {
  const root = mkdtempSync(join(tmpdir(), "herdr-plan-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, json({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }));
  return { path, add: (entry) => appendFileSync(path, json(entry)) };
}

/** A Claude transcript: each task call is an assistant tool_use, answered by a user tool_result as Claude Code 2.1.28x writes them. */
export function claude() {
  const f = file();
  let call = 0;
  let next = 0;
  const use = (name: string, input: unknown, minute: number) => {
    const id = `toolu_${++call}`;
    f.add({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    return id;
  };
  return {
    path: f.path,
    add: f.add,
    create(subject: string, minute = 1, extra: Record<string, unknown> = {}): string {
      const toolId = use("TaskCreate", { subject, description: `do ${subject}`, ...extra }, minute);
      const id = String(++next);
      f.add({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Task #${id} created successfully: ${subject}` }] }, toolUseResult: { task: { id, subject } } });
      return id;
    },
    update(input: Record<string, unknown>, minute = 1, answer: Record<string, unknown> = { success: true }, error = false): void {
      const toolId = use("TaskUpdate", input, minute);
      f.add({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: error ? "<tool_use_error>Task not found</tool_use_error>" : `Updated task #${String(input["taskId"])}`, ...(error ? { is_error: true } : {}) }] }, toolUseResult: answer });
    },
  };
}
