import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRolloutPath, matchCodexTranscript, parseCodexTranscript } from "./codex.ts";
import { splitTurn } from "../src/lib/workBlocks.ts";

const ts = "2026-09-22T01:00:00.000Z";
const item = (payload: unknown, timestamp = ts) => ({ type: "response_item", timestamp, payload });
const event = (payload: unknown, timestamp = ts) => ({ type: "event_msg", timestamp, payload });
const message = (role: string, text: string, phase?: string) => item({
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}),
});
const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("Codex conversation records", () => {
  it("hides injected context, metadata and developer messages while preserving the real request", () => {
    const turns = parseCodexTranscript(jsonl(
      { type: "session_meta", payload: { base_instructions: "internal system prompt" } },
      message("developer", "internal developer prompt"),
      message("user", "# AGENTS.md instructions for /project\n<INSTRUCTIONS>internal rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>"),
      message("user", "<environment_context>cwd</environment_context>"),
      item({ type: "message", role: "user", content: [null, { type: "input_text", text: "<environment_context>cwd</environment_context>" }, { type: "input_text", text: "Fix chat" }] }),
      event({ type: "user_message", kind: "internal", message: "injected reminder" }),
      event({ type: "token_count", info: { total: 10 } }),
      message("assistant", "Fixed", "final_answer"),
    ));
    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Fix chat" }]);
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Fixed", phase: "final_answer" }]);
  });

  it("pairs duplicate display/model records in either order but keeps genuine repeated prompts", () => {
    for (const reverse of [false, true]) {
      const pair = [message("user", "continue"), event({ type: "user_message", message: "continue" })];
      if (reverse) pair.reverse();
      const turns = parseCodexTranscript(jsonl(
        ...pair,
        event({ type: "agent_message", message: "Done" }), message("assistant", "Done", "final_answer"),
        message("user", "continue"), message("user", "continue"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "user"]);
      expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Done", phase: "final_answer" }]);
    }
  });

  it("does not deduplicate identical messages in separate turns", () => {
    expect(parseCodexTranscript(jsonl(
      message("user", "continue"),
      event({ type: "user_message", message: "continue" }, "2026-09-22T01:00:02.000Z"),
    ))).toHaveLength(2);
  });

  it("folds matched function/freeform tool output and commentary, keeping only the final answer outside", () => {
    const turns = parseCodexTranscript(jsonl(
      message("user", "Check"),
      message("assistant", "Checking", "commentary"),
      item({ type: "function_call", call_id: "read", name: "exec_command", arguments: '{"cmd":"git status"}' }),
      item({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }),
      item({ type: "custom_tool_call_output", call_id: "patch", output: "applied" }),
      item({ type: "function_call_output", call_id: "read", output: [{ type: "text", text: "clean" }] }),
      item({ type: "function_call_output", call_id: "unknown", output: "not a chat message" }),
      message("assistant", "Verifying", "commentary"),
      message("assistant", "All fixed", "final_answer"),
    ));
    const split = splitTurn(turns[1]!.parts);
    expect(split.work.map((part) => part.kind)).toEqual(["text", "tool", "tool", "text"]);
    expect(split.work[1]).toMatchObject({ summary: "git status", output: "clean" });
    expect(split.work[2]).toMatchObject({ name: "apply_patch", output: "applied" });
    expect(split.answer).toEqual([{ kind: "text", text: "All fixed", phase: "final_answer" }]);
  });

  it("retains reasoning summaries as thinking without decoding encrypted context", () => {
    const turns = parseCodexTranscript(jsonl(
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "Considering options" }], encrypted_content: "secret" }),
      item({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "Analysis text" }] }),
      message("assistant", "Answer", "final_answer"),
    ));
    expect(turns[0]?.parts.map((part) => part.kind)).toEqual(["thinking", "thinking", "text"]);
    expect(JSON.stringify(turns)).not.toContain("secret");
  });

  it("uses task timestamps rather than idle time before the next user prompt", () => {
    const turns = parseCodexTranscript(jsonl(
      event({ type: "task_started", started_at: ts }),
      message("user", "Check"),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }], phase: "final_answer" }, "2026-09-22T01:00:06.000Z"),
      event({ type: "task_complete" }, "2026-09-22T01:00:07.000Z"),
      event({ type: "user_message", message: "Next" }, "2026-09-22T02:00:00.000Z"),
    ));
    expect(turns[1]).toMatchObject({ ts, end_ts: "2026-09-22T01:00:07.000Z" });
  });

  it("bounds tool output and history and tolerates malformed or partially written records", () => {
    const text = jsonl(null, 1, { type: "response_item", payload: null },
      item({ type: "function_call", call_id: "c", name: "exec_command", arguments: "{bad json" }),
      item({ type: "function_call_output", call_id: "c", output: "x".repeat(10_000) }));
    const part = parseCodexTranscript(`${text}\n{"type":`)[0]?.parts[0];
    expect(part?.kind === "tool" ? part.output.length : 0).toBeGreaterThan(4000);
    expect(part?.kind === "tool" ? part.output.length : 0).toBeLessThan(4100);
    expect(parseCodexTranscript(jsonl(...Array.from({ length: 150 }, (_, i) => message("user", `request ${i}`))))).toHaveLength(100);
  });
});

describe("Codex rollout resolution", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("accepts files inside the store and rejects traversal, external symlinks, missing files and directories", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-path-")); roots.push(root);
    const home = join(root, "codex"); const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "rollout.jsonl"); writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    const outside = join(root, "other.jsonl"); writeFileSync(outside, "");
    symlinkSync(outside, join(sessions, "escape.jsonl"));
    expect(codexRolloutPath(path, home)).toBe(path);
    for (const candidate of [outside, join(sessions, "escape.jsonl"), join(sessions, "missing.jsonl"), sessions]) {
      expect(codexRolloutPath(candidate, home)).toBeNull();
    }
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: { subagent: { parent_thread_id: "parent" } } } }));
    expect(codexRolloutPath(path, home)).toBeNull();
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "subagent" } }));
    expect(codexRolloutPath(path, home)).toBeNull();
  });

  const answer = "The chat parser now reads native session records, removes internal context, and keeps assistant commentary inside the expandable work section.";
  it("requires a unique substantial rendered assistant match and handles terminal wrapping", () => {
    const candidates = [
      { path: "correct", text: jsonl(message("assistant", answer, "final_answer")) },
      { path: "newer-unrelated", text: jsonl(message("assistant", "Another conversation")) },
    ];
    expect(matchCodexTranscript(`• ${answer.replaceAll(" ", "\n  ")}`, candidates)).toBe("correct");
    expect(matchCodexTranscript("Different pane", candidates)).toBeNull();
    expect(matchCodexTranscript(answer, [...candidates, { ...candidates[0]!, path: "ambiguous-copy" }])).toBeNull();
    expect(matchCodexTranscript("Done", [{ path: "short", text: jsonl(message("assistant", "Done")) }])).toBeNull();
  });

  it("does not bind using user context, tool output or a previous session above the welcome card", () => {
    expect(matchCodexTranscript(answer, [{ path: "user", text: jsonl(message("user", answer)) }])).toBeNull();
    expect(matchCodexTranscript(`${answer}\nOpenAI Codex (v1.0)\nNew session`, [{ path: "old", text: jsonl(message("assistant", answer)) }])).toBeNull();
  });
});
