import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHistoryTail, codexRolloutPath, forgetHistoryChains, matchCodexTranscript, parseCodexTranscript, resumedThread } from "./codex.ts";
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
  it("reads the thread a TUI was resumed on from its command line", () => {
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    expect(resumedThread([["node", "/usr/bin/codex", "resume", thread, "--yolo"], ["/vendor/codex", "resume"]])).toBe(thread);
    expect(resumedThread([["codex", "resume", "--last"], ["codex"]])).toBeNull();
    expect(resumedThread([["codex", "exec", "resume"]])).toBeNull();
    expect(resumedThread([])).toBeNull();
  });

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

  /** Rollouts as Codex 0.156 writes them: one record per line, ordinals running on from the cut a rollout starts at. */
  type Cut = { thread: string; ordinal: number; byte: number };
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-chain-")); roots.push(root);
    const home = join(root, "codex");
    const rollout = (day: string, name: string, thread: string, records: unknown[], base?: Cut) => {
      const header = { type: "session_meta", payload: { source: "cli", thread_source: "user",
        ...(base ? { history_base: { thread_id: base.thread, end_ordinal_exclusive: base.ordinal, end_byte_offset: base.byte } } : {}) } };
      const lines = [header, ...records].map((record) => `${JSON.stringify(record)}\n`);
      mkdirSync(join(home, "sessions", "2026", "09", day), { recursive: true });
      const path = join(home, "sessions", "2026", "09", day, name);
      writeFileSync(path, lines.join(""));
      const first = base?.ordinal ?? 0;
      return {
        path, size: Buffer.byteLength(lines.join("")),
        /** the cut a backtrack to just before records[index] names */
        cutBefore: (index: number): Cut => ({ thread, ordinal: first + 1 + index, byte: Buffer.byteLength(lines.slice(0, index + 1).join("")) }),
      };
    };
    const texts = (path: string, budget = 1024 * 1024) => parseCodexTranscript(codexHistoryTail(path, budget, home))
      .map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : "").join(""));
    return { rollout, texts };
  };
  const parent = "01a09a35-5c5f-7830-94f7-4a1854613531";
  const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";

  it("reads a paginated rollout through the history it continues, without the turns a backtrack discarded", () => {
    const { rollout, texts } = store();
    const forked = rollout("13", `rollout-2026-09-13T18-59-43-${parent}.jsonl`, parent, [message("user", "parent question"), message("assistant", "parent answer")]);
    const original = rollout("15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`, thread,
      [message("user", "첫 질문"), message("assistant", "첫 답"), message("user", "discarded"), message("assistant", "discarded answer")], forked.cutBefore(2));
    // an unrelated later rollout of the same thread must not be taken for the base
    rollout("24", `rollout-2026-09-24T09-00-00-${thread}_01a0cc00-0000-7000-8000-000000000000.jsonl`, thread, [message("user", "future")]);
    const segment = rollout("23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`, thread,
      [message("user", "다시 묻기"), message("assistant", "새 답")], original.cutBefore(2));

    expect(texts(segment.path)).toEqual(["parent question", "parent answer", "첫 질문", "첫 답", "다시 묻기", "새 답"]);
    // a small budget reads only the newest bytes and never reaches the parent; the cut line is dropped
    const answerLine = Buffer.byteLength(JSON.stringify(message("assistant", "첫 답"))) + 1;
    expect(texts(segment.path, segment.size + answerLine + 10)).toEqual(["첫 답", "다시 묻기", "새 답"]);
  });

  it("follows each backtrack to the rollout that holds its cut, however many there were", () => {
    const { rollout, texts } = store();
    const turns = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => [
      message("user", `${prefix}${index}? ${"x".repeat(200)}`), message("assistant", `${prefix}${index}.`),
    ]).flat();
    const first = rollout("15", `rollout-2026-09-15T12-00-00-${thread}.jsonl`, thread, turns("a", 6));
    // backtrack 1 to before a4, backtrack 2 further back to before a2, backtrack 3 into the second rollout
    const second = rollout("20", `rollout-2026-09-20T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000001.jsonl`, thread, turns("b", 2), first.cutBefore(8));
    const third = rollout("21", `rollout-2026-09-21T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000002.jsonl`, thread, turns("c", 1), first.cutBefore(4));
    const fourth = rollout("22", `rollout-2026-09-22T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000003.jsonl`, thread, turns("d", 1), second.cutBefore(2));
    // the second rollout is newer and larger than the third one's cut: a name-and-size guess would take it
    expect(second.size).toBeGreaterThan(first.cutBefore(4).byte);
    const answers = (path: string) => texts(path).filter((text) => text.endsWith("."));
    expect(answers(second.path)).toEqual(["a0.", "a1.", "a2.", "a3.", "b0.", "b1."]);
    expect(answers(third.path)).toEqual(["a0.", "a1.", "c0."]);
    expect(answers(fourth.path)).toEqual(["a0.", "a1.", "a2.", "a3.", "b0.", "d0."]);
  });

  it("shows less history, never the wrong one, when no rollout holds a cut, and finds it once one does", () => {
    const { rollout, texts } = store();
    const other = "01a0d000-0000-7000-8000-00000000000a";
    const cut = { thread: other, ordinal: 3, byte: 0 };
    const pending = [message("user", "earlier question"), message("assistant", "earlier answer")];
    const lines = [{ type: "session_meta", payload: { source: "cli", thread_source: "user" } }, ...pending].map((record) => `${JSON.stringify(record)}\n`);
    cut.byte = Buffer.byteLength(lines.join(""));
    const segment = rollout("23", `rollout-2026-09-23T12-00-00-${thread}.jsonl`, thread, [message("user", "later question"), message("assistant", "later answer")], cut);
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
    rollout("22", `rollout-2026-09-22T12-00-00-${other}.jsonl`, other, pending);
    // an incomplete chain is kept a short while (no walk of sessions/ on every append)...
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
    // ...and looked up afresh once that expires
    forgetHistoryChains();
    expect(texts(segment.path)).toEqual(["earlier question", "earlier answer", "later question", "later answer"]);
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
