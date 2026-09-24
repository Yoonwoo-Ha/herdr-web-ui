import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetHistoryChains } from "./codex.ts";
import { ConversationUnavailable, HistoryChanged, isOmoProcess, MAX_TURNS, omoTranscriptPath, parseClaudeTranscript, parseOmpTranscript, transcriptPage } from "./conversation.ts";

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
      { role: "assistant", ts: "2026-09-19T08:00:02.000Z", end_ts: "2026-09-19T08:00:05.000Z", parts: [
        { kind: "text", text: "먼저 상태를 확인하겠습니다." },
        { kind: "tool", name: "Bash", summary: "git status --short", input: expect.stringContaining("git status"), output: "M src/app.ts" },
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "text", text: "변경된 파일이 하나입니다." },
      ] },
    ]);
  });

  it("shows a pasted text without Claude Code's paste wrapper, in string and block prompts", () => {
    const pasted = '\n\n<pasted_content id="6d8b">\n| a | b |\n\nsecond paragraph\n</pasted_content id="6d8b">\n';
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: pasted } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `look at this${pasted}` }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "typed <\\pasted_content id=\"6d8b\"> stays" } }),
    ].join("\n"));
    expect(turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "| a | b |\n\nsecond paragraph" },
      { kind: "text", text: "look at this\n\n| a | b |\n\nsecond paragraph" },
      { kind: "text", text: 'typed <\\pasted_content id="6d8b"> stays' },
    ]);
  });

  it("drops slash-command bookkeeping entries", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns.some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.includes("/clear")))).toBe(false);
  });

  it("keeps thinking blocks in transcript order", () => {
    const assistant = parseClaudeTranscript(lines)[1];
    expect(assistant?.parts.map((part) => part.kind)).toEqual(["text", "tool", "thinking", "text"]);
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

  it("preserves array user text, including mixed tool results, without exposing bookkeeping", () => {
    const transcript = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] } },
      { type: "user", message: { content: [null, { type: "tool_result", tool_use_id: "t", content: "result" }, { type: "text", text: "Actual request" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<command-name>/clear</command-name>" }] } },
      { type: "user", isMeta: true, message: { content: "internal reminder" } },
      { type: "user", isCompactSummary: true, message: { content: "compacted context" } },
      null,
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const turns = parseClaudeTranscript(transcript);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts[0]).toMatchObject({ kind: "tool", output: "result" });
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Actual request" }]);
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
    { type: "thinking", thinking: "alternate thinking field" },
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
      { role: "assistant", ts: "2026-09-20T08:39:02.000Z", end_ts: "2026-09-20T08:39:05.000Z", parts: [
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "thinking", text: "alternate thinking field" },
        { kind: "tool", name: "bash", summary: "Checking ports", input: expect.stringContaining("ss -tlnp"), output: "LISTEN 0 512 100.123.228.51:7317" },
        { kind: "text", text: "http://100.123.228.51:7317" },
      ] },
    ]);
  });

  it("keeps thinking parts while ignoring title/session headers", () => {
    const rendered = JSON.stringify(parseOmpTranscript(ompLines));
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"internal reasoning stays private\"");
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"alternate thinking field\"");
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

describe("omo transcript resolution", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  /** A temp HOME holding one omo session store for `slug`, each transcript stamped with its own mtime. */
  function omoHome(slug: string, files: { name: string; cwd: string; mtime: string }[]): string {
    const home = mkdtempSync(join(tmpdir(), "omo-home-"));
    homes.push(home);
    const dir = join(home, ".omo", "agent", "sessions", slug);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const path = join(dir, file.name);
      writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: file.name, cwd: file.cwd })}\n`);
      utimesSync(path, new Date(file.mtime), new Date(file.mtime));
    }
    return home;
  }

  it("picks the newest transcript whose session header names the pane cwd", () => {
    const home = omoHome("--home-u-project--", [
      { name: "older.jsonl", cwd: "/home/u/project", mtime: "2026-09-19T00:00:00.000Z" },
      { name: "live.jsonl", cwd: "/home/u/project", mtime: "2026-09-21T00:00:00.000Z" },
      // a newer file the store keeps for another cwd under the same slug must not win
      { name: "foreign.jsonl", cwd: "/home/u/elsewhere", mtime: "2026-09-21T12:00:00.000Z" },
    ]);
    expect(omoTranscriptPath("/home/u/project", home)).toBe(join(home, ".omo", "agent", "sessions", "--home-u-project--", "live.jsonl"));
  });

  it("recognizes omo from a pane's foreground processes, not from herdr's label", () => {
    // argv exactly as herdr's pane.process_info reported them for an omo pane
    expect(isOmoProcess(["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeTrue();
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/bin/omo.js"])).toBeTrue();
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js", "--extension", "/home/u/lib/node_modules/omo-ai/plugin"])).toBeTrue();
    // the pane herdr labels `claude` because of omo's child still names omo
    expect(isOmoProcess(["/home/u/lib/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", "--output-format", "stream-json"])).toBeTrue();

    expect(isOmoProcess(["/home/u/.local/bin/claude"])).toBeFalse();
    expect(isOmoProcess(["omp"])).toBeFalse();
    expect(isOmoProcess(["node", "/home/u/omo-tools/watch.js"])).toBeFalse();
  });

  it("reports no session rather than guessing when the store holds nothing for the cwd", () => {
    const home = omoHome("--home-u-project--", [{ name: "foreign.jsonl", cwd: "/home/u/elsewhere", mtime: "2026-09-21T00:00:00.000Z" }]);
    expect(() => omoTranscriptPath("/home/u/project", home)).toThrow(ConversationUnavailable);
    expect(() => omoTranscriptPath("/home/u/never-opened", home)).toThrow(ConversationUnavailable);
  });
});

describe("transcript pages", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = (): string => { const root = mkdtempSync(join(tmpdir(), "herdr-pages-")); roots.push(root); return root; };
  /** a prompt, a tool call and its result: the result answers the turn, never the next page */
  const claudeTurn = (n: number) => [
    { type: "user", timestamp: `2026-09-23T00:00:${String(n % 60).padStart(2, "0")}.000Z`, message: { role: "user", content: `prompt ${n}` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `echo ${n}` } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `out ${n}` }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const texts = (turns: { parts: { kind: string; text?: string; output?: string }[] }[]) =>
    turns.map((turn) => turn.parts.map((part) => part.kind === "tool" ? `[${part.output}]` : part.text).join(" "));

  it("pages back through a long conversation without gaps, overlaps or split turns", () => {
    const path = join(temp(), "session.jsonl");
    const whole = Array.from({ length: 120 }, (_, n) => claudeTurn(n)).join("\n");
    writeFileSync(path, `${whole}\n`);

    const newest = transcriptPage("claude-transcript", path);
    expect(newest.turns).toHaveLength(MAX_TURNS);
    expect(texts(newest.turns)[0]).toBe("prompt 70");
    expect(newest.cursor).not.toBeNull();
    const middle = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(middle.turns)[0]).toBe("prompt 20");
    const first = transcriptPage("claude-transcript", path, { before: middle.cursor! });
    expect(first.cursor).toBeNull();
    expect(texts([...first.turns, ...middle.turns, ...newest.turns])).toEqual(texts(parseClaudeTranscript(whole, Infinity)));
    expect(texts(middle.turns).at(-1)).toBe("[out 69] answer 69");
  });

  it("keeps a held start while it is inside the newest page, then fills the turns it moved past a page at a time", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    const held = transcriptPage("claude-transcript", path).cursor!;
    // while the last turn grows, the held start (prompt 10) is still inside the newest page
    const more = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "still working" }] } });
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n${more}\n`);
    const growing = transcriptPage("claude-transcript", path, { from: held });
    expect(growing.cursor).toBe(held);
    expect(texts(growing.turns).at(-1)).toBe("[out 59] answer 59 still working");
    writeFileSync(path, `${Array.from({ length: 70 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    // the newest page slid past it: the answer is the newest page, never more than a page
    const newest = transcriptPage("claude-transcript", path, { from: held });
    expect(newest.cursor).not.toBe(held);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    // the turns in between come from `before` the newest page, `since` the held start
    const gap = transcriptPage("claude-transcript", path, { before: newest.cursor!, since: held });
    expect(gap.cursor).toBe(held);
    expect(texts(gap.turns)[0]).toBe("prompt 10");
    expect(texts(gap.turns).at(-1)).toBe("[out 19] answer 19");
    for (const cursor of ["another-file:10", `${held.split(":")[0]}:999999999`, "garbage"]) {
      expect(() => transcriptPage("claude-transcript", path, { before: cursor })).toThrow(HistoryChanged);
    }
    expect(() => transcriptPage("claude-transcript", path, { before: held, since: newest.cursor! })).toThrow(HistoryChanged);
  });

  it("reads one window for the newest page even when no turn starts in it; an older page reaches the turn's start", () => {
    const path = join(temp(), "session.jsonl");
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: "run the long job" } });
    // one turn of 20MB of tool output: no turn starts in the newest window
    const output = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1024 * 1024) }] } });
    writeFileSync(path, `${claudeTurn(0)}\n${prompt}\n${Array.from({ length: 20 }, () => output).join("\n")}\n`);
    const size = Buffer.byteLength(`${claudeTurn(0)}\n${prompt}\n`) + 20 * (Buffer.byteLength(output) + 1);
    const newest = transcriptPage("claude-transcript", path);
    const start = Number(newest.cursor!.split(":").at(-1));
    expect(size - start).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(newest.turns.every((turn) => turn.role === "assistant")).toBe(true);
    const older = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(older.turns).slice(0, 3)).toEqual(["prompt 0", "[out 0] answer 0", "run the long job"]);
  });

  it("refuses a cursor once the rollouts before the live file change, instead of pointing at other turns", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 20 }, (_, n) => task(n)).join("\n")}\n`;
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 60 }, (_, n) => task(20 + n)).join("\n")}\n`);
    // the earlier rollout is not there yet: the chain stops at the segment
    forgetHistoryChains();
    const newest = transcriptPage("codex-transcript", segment, {}, home);
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(texts(older.turns)[0]).toBe("prompt 20");
    // it appears: positions now count from its start, and the old cursors name another chain
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), kept);
    forgetHistoryChains();
    expect(() => transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home)).toThrow(HistoryChanged);
    expect(() => transcriptPage("codex-transcript", segment, { from: newest.cursor! }, home)).toThrow(HistoryChanged);
    // read afresh, the pages reach the earlier rollout
    const again = transcriptPage("codex-transcript", segment, {}, home);
    const all = [...transcriptPage("codex-transcript", segment, { before: again.cursor! }, home).turns, ...again.turns];
    expect(texts(all)[0]).toBe("prompt 0");
  });

  it("looks a remembered chain up again once a rollout in it is archived, instead of failing every read", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n)).join("\n")}\n`;
    const parent = join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`);
    writeFileSync(parent, kept);
    // right after a backtrack the live file is small: its newest page reaches into the parent
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 3 }, (_, n) => task(80 + n)).join("\n")}\n`);
    forgetHistoryChains();
    const before = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(before.turns)[0]).toBe("prompt 33");
    expect(before.cursor).not.toBeNull();
    // archived while the complete chain is remembered
    renameSync(parent, join(home, "archived_sessions", `rollout-2026-09-15T12-58-12-${thread}.jsonl`));
    const after = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(after.turns)).toEqual(["prompt 80", "answer 80", "prompt 81", "answer 81", "prompt 82", "answer 82"]);
    // a reader holding a position in the old chain reloads once
    expect(() => transcriptPage("codex-transcript", segment, { before: before.cursor! }, home)).toThrow(HistoryChanged);
  });

  it("pages across the rollouts a backtracked Codex conversation continues", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 60 }, (_, n) => task(n)).join("\n")}\n`;
    const keptLines = kept.split("\n").length - 1;
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), `${kept}${task(999)}\n`);
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: keptLines, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 10 }, (_, n) => task(60 + n)).join("\n")}\n`);

    const newest = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(older.cursor).toBeNull();
    const all = texts([...older.turns, ...newest.turns]);
    expect(all).toEqual(Array.from({ length: 70 }, (_, n) => [`prompt ${n}`, `answer ${n}`]).flat());
  });
});
