import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import { forgetTranscriptState, HistoryChanged, transcriptPage } from "./conversation.ts";

const SOURCES = ["omp-transcript", "omo-transcript", "gjc-transcript", "claude-transcript"] as const;
type Source = typeof SOURCES[number];
const roots: string[] = [];
const jsonl = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry) + "\n").join("");
const fixture = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-native-incremental-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, text);
  return path;
};
const message = (source: Source, role: string, content: unknown) => ({ type: source === "claude-transcript" ? role : "message", message: { role, content } });
const prompt = (source: Source, text: string) => message(source, "user", [{ type: "text", text }]);
const answer = (source: Source, text: string) => message(source, "assistant", [{ type: "text", text }]);
const call = (source: Source, id: string) => message(source, "assistant", [source !== "claude-transcript"
  ? { type: "toolCall", id, name: "bash", arguments: { command: "printf synthetic" } }
  : { type: "tool_use", id, name: "Bash", input: { command: "printf synthetic" } }]);
const result = (source: Source, id: string, text: string) => source !== "claude-transcript"
  ? { type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } }
  : message(source, "user", [{ type: "tool_result", tool_use_id: id, content: text }]);
const textParts = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts.flatMap(part => part.kind === "text" ? [part.text] : []));
const toolParts = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool");
afterEach(() => {
  forgetTranscriptState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const source of SOURCES) {
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
      const otherSource = SOURCES[i % SOURCES.length]!;
      const other = fixture(jsonl(prompt(otherSource, `other ${i}`), call(otherSource, "shared-id"), result(otherSource, "shared-id", `other result ${i}`)));
      expect(toolParts(transcriptPage(otherSource, other).turns)[0]?.output).toBe(`other result ${i}`);
    }
    appendFileSync(first, jsonl(result(source, "shared-id", "first result")));
    expect(toolParts(transcriptPage(source, first).turns)[0]?.output).toBe("first result");
    expect(toolParts(original.turns)[0]?.output).toBe("");
  });
}

for (const source of ["omo-transcript", "gjc-transcript"] as const) {
  test(`${source}: speculative settings never replace committed metadata and clear resets the old context`, () => {
    const path = fixture(jsonl(
      { type: "model_change", modelId: "initial-model" },
      { type: "thinking_level_change", thinkingLevel: "high" },
      prompt(source, "Initial question"),
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Initial answer" }], usage: { input: 100, cacheRead: 20, cacheWrite: 5 } } },
    ));
    const initial = transcriptPage(source, path);
    expect(initial.metadata).toEqual({ model: "initial-model", reasoning_effort: "high", context: { used: 125, window: null } });
    appendFileSync(path, JSON.stringify({ type: "model_change", modelId: "preview-model" }));
    const preview = transcriptPage(source, path);
    expect(preview.metadata.model).toBe("preview-model");
    appendFileSync(path, " discarded\n" + jsonl({ type: "thinking_level_change", thinkingLevel: "low" }));
    const committed = transcriptPage(source, path);
    expect(committed.metadata).toEqual({ model: "initial-model", reasoning_effort: "low", context: { used: 125, window: null } });
    expect(initial.metadata.reasoning_effort).toBe("high");
    expect(preview.metadata.model).toBe("preview-model");
    appendFileSync(path, jsonl({ type: "custom", customType: "context_clear" }, prompt(source, "New context")));
    const cleared = transcriptPage(source, path);
    expect(cleared.metadata).toEqual({ model: null, reasoning_effort: null });
    expect(textParts(cleared.turns)).toEqual(["New context"]);
    forgetTranscriptState();
    const cold = transcriptPage(source, path);
    expect(cold.turns).toEqual(cleared.turns);
    expect(cold.metadata).toEqual(cleared.metadata);
  });
}

test("OMO task completions ignore a discarded title preview and retain the committed title after a wake", () => {
  const source = "omo-transcript";
  const path = fixture(jsonl(prompt(source, "Review the parser"), {
    type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn", name: "task", arguments: { task_summary: "Review the parser" } }] },
  }));
  const initial = transcriptPage(source, path);
  const title = {
    type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "spawn", content: "Started", details: { task_id: "review", task_summary: "Discarded title" } },
  };
  appendFileSync(path, JSON.stringify(title));
  const preview = transcriptPage(source, path);
  expect(toolParts(preview.turns)[0]?.output).toBe("Started");
  title.message.details.task_summary = "Committed review";
  appendFileSync(path, " discarded\n" + jsonl(title));
  const started = transcriptPage(source, path);
  expect(toolParts(started.turns)[0]?.output).toBe("Started");
  const completed = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Waiting for the review" }] } };
  appendFileSync(path, jsonl(completed, {
    type: "custom_message", customType: "omo-senpi:wake", display: false,
    details: [{ customType: "senpi-task.completion", details: [{ task_id: "review", status: "completed", agent_type: "reviewer", final_response: "No regression found" }] }],
  }));
  const woken = transcriptPage(source, path);
  const task = woken.turns.at(-1)?.parts[0];
  expect(task).toMatchObject({ kind: "task_result", tasks: [{ id: "review", title: "Committed review", status: "completed", result: "No regression found" }] });
  appendFileSync(path, jsonl(answer(source, "Review applied")));
  const finished = transcriptPage(source, path);
  expect(finished.turns.map(turn => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(finished.turns[1]?.parts.at(-1)).toEqual({ kind: "text", text: "Waiting for the review", phase: "final_answer" });
  expect(toolParts(initial.turns)[0]?.output).toBe("");
  expect(woken.turns.map(turn => turn.role)).toEqual(["user", "assistant", "user"]);
  forgetTranscriptState();
  expect(transcriptPage(source, path).turns).toEqual(finished.turns);
});

test("GJC background deliveries keep final answers separate and internal IRC stays hidden across refreshes", () => {
  const source = "gjc-transcript";
  const path = fixture(jsonl(prompt(source, "Run the build"), {
    type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Build started" }] },
  }));
  const initial = transcriptPage(source, path);
  for (const customType of ["irc:incoming", "irc:autoreply", "irc:relay"]) {
    appendFileSync(path, jsonl({ type: "custom_message", customType, attribution: "agent", display: true, content: "Internal delivery" }));
    expect(transcriptPage(source, path).turns).toEqual(initial.turns);
  }
  appendFileSync(path, jsonl({ type: "custom_message", customType: "async-result", display: true, content: "<system-notice>Build passed</system-notice>" }));
  const delivered = transcriptPage(source, path);
  expect(delivered.turns.at(-1)?.parts).toEqual([{ kind: "notice", source: "async-result", text: "Build passed" }]);
  appendFileSync(path, jsonl(call(source, "read"), result(source, "read", "Build receipt"), {
    type: "custom_message", customType: "async-result", display: false, content: "Hidden runtime notice",
  }, answer(source, "Checked the receipt")));
  const finished = transcriptPage(source, path);
  expect(finished.turns.map(turn => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(finished.turns[1]?.parts).toEqual([{ kind: "text", text: "Build started", phase: "final_answer" }]);
  expect(toolParts(finished.turns)[0]?.output).toBe("Build receipt");
  expect(textParts(finished.turns)).toEqual(["Run the build", "Build started", "Checked the receipt"]);
  expect(delivered.turns.at(-1)?.parts).toEqual([{ kind: "notice", source: "async-result", text: "Build passed" }]);
  forgetTranscriptState();
  expect(transcriptPage(source, path).turns).toEqual(finished.turns);
});

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
