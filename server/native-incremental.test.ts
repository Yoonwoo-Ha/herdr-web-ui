import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import { forgetTranscriptState, HistoryChanged, transcriptPage } from "./conversation.ts";

type Source = "omp-transcript" | "claude-transcript";
const roots: string[] = [];
const jsonl = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry) + "\n").join("");
const fixture = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-native-incremental-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, text);
  return path;
};
const message = (source: Source, role: string, content: unknown) => ({ type: source === "omp-transcript" ? "message" : role, message: { role, content } });
const prompt = (source: Source, text: string) => message(source, "user", [{ type: "text", text }]);
const answer = (source: Source, text: string) => message(source, "assistant", [{ type: "text", text }]);
const call = (source: Source, id: string) => message(source, "assistant", [source === "omp-transcript"
  ? { type: "toolCall", id, name: "bash", arguments: { command: "printf synthetic" } }
  : { type: "tool_use", id, name: "Bash", input: { command: "printf synthetic" } }]);
const result = (source: Source, id: string, text: string) => source === "omp-transcript"
  ? { type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } }
  : message(source, "user", [{ type: "tool_result", tool_use_id: id, content: text }]);
const textParts = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts.flatMap(part => part.kind === "text" ? [part.text] : []));
const toolParts = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool");
afterEach(() => {
  forgetTranscriptState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const source of ["omp-transcript", "claude-transcript"] as const) {
  test(`${source}: a torn UTF-8 result previews without consuming the pending call or mutating earlier responses`, () => {
    const path = fixture(jsonl(prompt(source, "Read the result"), call(source, "read")));
    const initial = transcriptPage(source, path);
    const line = Buffer.from(JSON.stringify(result(source, "read", "한글 " + "x".repeat(9000))));
    const split = line.indexOf(Buffer.from("한")) + 1;
    appendFileSync(path, line.subarray(0, split));
    expect(toolParts(transcriptPage(source, path).turns)[0]?.output).toBe("");
    appendFileSync(path, line.subarray(split));
    const preview = transcriptPage(source, path);
    expect(toolParts(preview.turns)[0]).toMatchObject({ output_ref: "read", output_size: 9003 });
    expect(toolParts(preview.turns)[0]?.output.startsWith("한글 ")).toBe(true);
    expect(toolParts(initial.turns)[0]?.output).toBe("");
    appendFileSync(path, "\n" + jsonl(answer(source, "The result arrived")));
    const completed = transcriptPage(source, path);
    expect(toolParts(completed.turns)).toHaveLength(1);
    expect(textParts(completed.turns)).toEqual(["Read the result", "The result arrived"]);
    expect(textParts(preview.turns)).toEqual(["Read the result"]);
    forgetTranscriptState();
    expect(transcriptPage(source, path).turns).toEqual(completed.turns);
  });

  test(`${source}: same-size rewrites, replacement and truncation discard live parser state`, () => {
    const history = Array.from({ length: 55 }, (_, i) => prompt(source, `prompt ${i}`));
    const old = jsonl(...history, call(source, "old"), result(source, "old", "OLD"), answer(source, "OLD"));
    const path = fixture(old);
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const initial = transcriptPage(source, path);
    expect(initial.cursor).toBeString();
    writeFileSync(path, old.replaceAll("OLD", "NEW"));
    utimesSync(path, 1_700_000_001, 1_700_000_001);
    const rewritten = transcriptPage(source, path);
    expect(rewritten.history_id).not.toBe(initial.history_id);
    expect(textParts(rewritten.turns).at(-1)).toBe("NEW");
    expect(toolParts(rewritten.turns)[0]?.output).toBe("NEW");
    expect(textParts(initial.turns).at(-1)).toBe("OLD");
    expect(() => transcriptPage(source, path, { from: initial.cursor! })).toThrow(HistoryChanged);
    const replacement = `${path}.replacement`;
    writeFileSync(replacement, jsonl(prompt(source, "replacement"), answer(source, "replacement answer")));
    renameSync(replacement, path);
    const replaced = transcriptPage(source, path);
    expect(replaced.history_id).not.toBe(rewritten.history_id);
    expect(textParts(replaced.turns)).toEqual(["replacement", "replacement answer"]);
    expect(toolParts(replaced.turns)).toEqual([]);
    writeFileSync(path, jsonl(prompt(source, "short")));
    expect(textParts(transcriptPage(source, path).turns)).toEqual(["short"]);
  });

  test(`${source}: a growing rewrite behind an unchanged trailing boundary is reread`, () => {
    const padding = "Unchanged trailing record ".repeat(20);
    const old = jsonl(prompt(source, "start"), answer(source, "before"), answer(source, padding));
    const path = fixture(old);
    const initial = transcriptPage(source, path);
    writeFileSync(path, old.replace("before", "after!") + jsonl(answer(source, "new suffix")));
    const rewritten = transcriptPage(source, path);
    expect(textParts(rewritten.turns)).toEqual(["start", "after!", padding, "new suffix"]);
    expect(textParts(initial.turns)).toEqual(["start", "before", padding]);
    forgetTranscriptState();
    expect(transcriptPage(source, path).turns).toEqual(rewritten.turns);
  });

  test(`${source}: an evicted session reconnects delayed results without borrowing another session's state`, () => {
    const first = fixture(jsonl(prompt(source, "first"), call(source, "shared-id")));
    const original = transcriptPage(source, first);
    for (let i = 0; i < 12; i++) {
      const otherSource = i % 2 ? "omp-transcript" : "claude-transcript";
      const other = fixture(jsonl(prompt(otherSource, `other ${i}`), call(otherSource, "shared-id"), result(otherSource, "shared-id", `other result ${i}`)));
      expect(toolParts(transcriptPage(otherSource, other).turns)[0]?.output).toBe(`other result ${i}`);
    }
    appendFileSync(first, jsonl(result(source, "shared-id", "first result")));
    expect(toolParts(transcriptPage(source, first).turns)[0]?.output).toBe("first result");
    expect(toolParts(original.turns)[0]?.output).toBe("");
  });
}

test("Claude live completion cards adopt late meta files without changing earlier snapshots", () => {
  const source = "claude-transcript";
  const content = '<task-notification><task-id>review</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status><summary>Agent "Fallback" finished</summary><result>Checked the result.</result></task-notification>';
  const path = fixture(jsonl(prompt(source, "Review it"), call(source, "work"), { type: "queue-operation", operation: "enqueue", content }));
  const cards = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts.flatMap(part => part.kind === "task_result" ? part.tasks : []));
  const initial = transcriptPage(source, path);
  expect(cards(initial.turns)[0]).toMatchObject({ title: "Fallback", agent: null });
  const directory = join(dirname(path), "session", "subagents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "agent-review.meta.json"), JSON.stringify({ description: "Review parser state", agentType: "reviewer" }));
  appendFileSync(path, jsonl(answer(source, "Finished reviewing")));
  const updated = transcriptPage(source, path);
  expect(cards(updated.turns)[0]).toMatchObject({ title: "Review parser state", agent: "reviewer", result: "Checked the result." });
  expect(cards(initial.turns)[0]).toMatchObject({ title: "Fallback", agent: null });
  forgetTranscriptState();
  expect(transcriptPage(source, path).turns).toEqual(updated.turns);
});
