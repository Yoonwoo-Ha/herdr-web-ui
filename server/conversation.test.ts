import { describe, expect, it } from "bun:test";

import { MAX_TURNS, parseClaudeTranscript, parseOmpTranscript } from "./conversation.ts";

/** Minimal but shape-true slices of a Claude Code session jsonl. */
const lines = [
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:00.000Z", message: { role: "user", content: "리팩터링 시작해줘" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:02.000Z", message: { role: "assistant", content: [
    { type: "text", text: "먼저 상태를 확인하겠습니다." },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status --short", description: "check tree" } },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:03.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "M src/app.ts" },
  ] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:05.000Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "internal reasoning stays private" },
    { type: "text", text: "변경된 파일이 하나입니다." },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:01:00.000Z", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
].join("\n");

describe("parseClaudeTranscript", () => {
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-19T08:00:00.000Z", parts: [{ kind: "text", text: "리팩터링 시작해줘" }] },
      { role: "assistant", ts: "2026-09-19T08:00:02.000Z", parts: [
        { kind: "text", text: "먼저 상태를 확인하겠습니다." },
        { kind: "tool", name: "Bash", summary: "git status --short", input: expect.stringContaining("git status"), output: "M src/app.ts" },
        { kind: "text", text: "변경된 파일이 하나입니다." },
      ] },
    ]);
  });

  it("drops slash-command bookkeeping entries", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns.some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.includes("/clear")))).toBe(false);
  });

  it("keeps thinking blocks out of the conversation", () => {
    expect(JSON.stringify(parseClaudeTranscript(lines))).not.toContain("internal reasoning");
  });

  it("survives a torn tail line while Claude is mid-append", () => {
    expect(parseClaudeTranscript(`${lines}\n{"type":"ass`).length).toBe(2);
  });

  it("trims a huge tool result instead of shipping megabytes to the browser", () => {
    const big = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "/etc/big" } },
      ] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t", content: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const turns = parseClaudeTranscript(big);
    const tool = turns[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);
  });

  it("caps the turn list", () => {
    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `m${i}` } }),
    ).join("\n");
    expect(parseClaudeTranscript(many).length).toBe(MAX_TURNS);
  });

  it("returns nothing for an empty transcript", () => {
    expect(parseClaudeTranscript("")).toEqual([]);
  });
});

/** Minimal but shape-true slices of an omp session jsonl. */
const ompLines = [
  JSON.stringify({ type: "title", v: 1, title: "프로젝트 불편사항 패치" }),
  JSON.stringify({ type: "session", version: 3, id: "01a0bdf7-b9e3-72bb-bad1-671dde7082f8" }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:00.000Z", message: { role: "user", attribution: "user", content: [
    { type: "text", text: "주소좀 줘봐" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:02.000Z", message: { role: "assistant", content: [
    { type: "thinking", text: "internal reasoning stays private" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ss -tlnp", i: "Checking ports" }, intent: "Checking ports" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:03.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: false, content: [
    { type: "text", text: "LISTEN 0 512 100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:05.000Z", message: { role: "assistant", content: [
    { type: "text", text: "http://100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:40:00.000Z", message: { role: "user", content: [
    { type: "image", blob: "..." },
  ] } }),
].join("\n");

describe("parseOmpTranscript", () => {
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-20T08:39:00.000Z", parts: [{ kind: "text", text: "주소좀 줘봐" }] },
      { role: "assistant", ts: "2026-09-20T08:39:02.000Z", parts: [
        { kind: "tool", name: "bash", summary: "Checking ports", input: expect.stringContaining("ss -tlnp"), output: "LISTEN 0 512 100.123.228.51:7317" },
        { kind: "text", text: "http://100.123.228.51:7317" },
      ] },
    ]);
  });

  it("keeps thinking parts and title/session headers out of the conversation", () => {
    const rendered = JSON.stringify(parseOmpTranscript(ompLines));
    expect(rendered).not.toContain("internal reasoning");
    expect(rendered).not.toContain("프로젝트 불편사항 패치");
  });

  it("skips an image-only user part instead of an empty turn", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });

  it("falls back to the first interesting argument when a toolCall has no intent", () => {
    const noIntent = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "c", name: "read", arguments: { file_path: "/tmp/x" } },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(noIntent)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.summary : "").toBe("/tmp/x");
  });

  it("survives a torn tail line while omp is mid-append", () => {
    expect(parseOmpTranscript(`${ompLines}\n{"type":"mess`).length).toBe(2);
  });

  it("trims a huge tool result and caps the turn list", () => {
    const big = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "cat /etc/big" } },
      ] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t", content: [
        { type: "text", text: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(big)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);

    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `m${i}` }] } }),
    ).join("\n");
    expect(parseOmpTranscript(many).length).toBe(MAX_TURNS);
  });
});
