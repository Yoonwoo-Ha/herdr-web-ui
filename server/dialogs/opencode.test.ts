import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { commandOutcome, type CommandSend } from "../outcome.ts";
import { openCodePromptTexts, skillsNotAttached } from "../opencode-native.ts";
import type { OpenCodePermissionRequest } from "../opencode-service.ts";
import { nativePermissionReader, nativeQuestionReader, openCodePermissionPrompt, v1QuestionReader } from "./opencode.ts";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { registry } from "./registry.ts";

const send = (over: Partial<CommandSend> = {}): CommandSend => ({
  id: "send-1", text: "@effect apply it", at: 1_000, agent: "opencode", identity: "[\"t\",null]", screen: "",
  form: null, invocations: [{ name: "effect", argument: "apply it", form: null }], ...over,
});

describe("OpenCode native question reader", () => {
  it("is the reader the native card names, for OpenCode only, and never reads a screen", () => {
    expect(registry.readerFor("opencode-question")).toBe(nativeQuestionReader);
    expect(registry.readersFor("opencode").map((reader) => reader.id)).toContain("opencode-question");
    expect(registry.readersFor("claude").map((reader) => reader.id)).not.toContain("opencode-question");
    const context = { agent: "opencode", omoAsk: null, omoTrusted: false, omoOpen: [], sent: null, working: false };
    expect(nativeQuestionReader.parse("┃ Asked 1 question\n┃ 1. Yes", context)).toBeNull();
  });

  it("keeps a send on its open native card, and resolves it only from native evidence after the send", () => {
    const sent = send();
    const dialog = { id: "card", reader: nativeQuestionReader.id };
    expect(commandOutcome("p", sent, { now: 2_000, dialog }).state).toBe("interaction-required");
    expect(commandOutcome("p", sent, { now: 2_000, evidence: { kind: "native", at: 900 } }).state).toBe("accepted");
    const done = commandOutcome("p", sent, { now: 3_000, evidence: { kind: "native", at: 2_500 } });
    expect(done.state).toBe("result-observed");
    expect(done.evidence).toEqual([{ kind: "native", at: new Date(2_500).toISOString() }]);
  });

  it("sends a skill OpenCode did not attach to the terminal, saying which, and nothing settles it", () => {
    const sent = skillsNotAttached(send(), ["effect"]);
    const outcome = commandOutcome("p", sent, { now: 3_000, evidence: { kind: "native", at: 2_500 } });
    expect(outcome.state).toBe("terminal-required");
    expect(outcome.note).toContain("@effect");
    expect(skillsNotAttached(send(), [])).toEqual(send());
  });
});

const v1 = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", `opencode-question-1.2.27-${name}.txt`), "utf8");

describe("OpenCode 1.x question prompt read off the screen (#1386)", () => {
  it.each(["wide", "narrow"])("reads the recorded single question with its options and typed answer (%s)", (width) => {
    const prompt = parseInteractivePrompt("opencode", v1(`single-${width}`));
    expect(prompt).toMatchObject({
      kind: "question", question: "Which color do you prefer?", multi_select: false, custom_option_index: 2,
      options: [{ label: "Red", description: "Warm and bold" }, { label: "Blue", description: "Calm and cool" }, { label: "Type your own answer", description: null }],
    });
  });

  it.each(["wide", "narrow"])("answers with the row's own digit, which picks and submits a single question (%s)", (width) => {
    const prompt = parseInteractivePrompt("opencode", v1(`single-${width}`))!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
    expect(answerKeys(prompt, { custom_text: "Green" })).toEqual([{ text: "3" }, { text: "Green" }, { keys: ["enter"] }]);
  });

  it.each(["wide", "narrow"])("reads nothing once the question was answered (%s)", (width) => {
    expect(parseInteractivePrompt("opencode", v1(`answered-${width}`))).toBeNull();
  });

  it("is OpenCode's reader only", () => {
    expect(v1QuestionReader.agents).toEqual(["opencode"]);
    expect(parseInteractivePrompt("claude", v1("single-wide"))).toBeNull();
  });

  it("refuses OpenCode 2's form, which has the same footer under a Field header", () => {
    const lines = v1("single-wide").split("\n");
    const question = lines.findIndex((line) => line.includes("Which color do you prefer?"));
    lines.splice(question, 0, lines[question]!.replace("Which color do you prefer?", "Field 1 of 1 · 0/1 completed"), lines[question - 1]!);
    expect(parseInteractivePrompt("opencode", lines.join("\n"))).toBeNull();
  });

  it("refuses a prompt whose footer is not the screen's last content, or that asks several questions", () => {
    expect(parseInteractivePrompt("opencode", `${v1("single-wide").trimEnd()}\n  later output\n`)).toBeNull();
    expect(parseInteractivePrompt("opencode", v1("single-wide").replace("enter submit", "enter confirm"))).toBeNull();
    expect(parseInteractivePrompt("opencode", v1("single-narrow").replace("submit  ", "toggle  "))).toBeNull();
  });

  it("refuses rows that do not count up from 1", () => {
    expect(parseInteractivePrompt("opencode", v1("single-wide").replace("2. Blue", "4. Blue"))).toBeNull();
  });
});

describe("the prompt text OpenCode 2.0.32 stores for a send", () => {
  it("is exactly what was typed and pasted, spacing included", () => {
    expect([...openCodePromptTexts([{ typed: "@effect " }, { pasted: " apply  it" }])]).toEqual(["@effect  apply  it"]);
    expect(openCodePromptTexts([{ typed: "@effect " }, { pasted: "apply it" }]).has("@effect apply it ")).toBe(false);
  });

  it("also expects a long or 3-line paste the way OpenCode keeps it: line ends as \\n, trimmed, then one space", () => {
    expect([...openCodePromptTexts([{ typed: "@effect " }, { pasted: "one\r\ntwo\rthree\n" }])]).toEqual(["@effect one\ntwo\nthree\n", "@effect one\ntwo\nthree "]);
    const long = ` ${"x".repeat(151)} `;
    expect([...openCodePromptTexts([{ pasted: long }])]).toEqual([long, `${"x".repeat(151)} `]);
  });
});

describe("OpenCode permission card", () => {
  const recorded = (JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "opencode-permission-2.2.2.json"), "utf8")) as { events: { type: string; data: OpenCodePermissionRequest }[] })
    .events.filter((event) => event.type === "permission.asked").map((event) => event.data);
  /** a recorded shell request, with the input its call carried (as the service reads it from the message) */
  const shell = { ...recorded.find((asked) => asked.action === "shell")!, input: { command: "ls -la ." } };
  const request = (action: string): OpenCodePermissionRequest => action === "shell" ? shell : recorded.find((asked) => asked.action === action)!;
  const card = (action: string) => openCodePermissionPrompt(request(action))!;
  const commands = (JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "opencode-permission-command-2.2.2.json"), "utf8")) as {
    cases: { condition: string; executed: string; permission: Omit<OpenCodePermissionRequest, "source"> & { source: { id: string } }; message: { data: { content: { id: string; state: { input: Record<string, unknown> } }[] } } }[];
  }).cases;

  it("is the native reader its card names, and reads no screen", () => {
    expect(registry.readerFor("opencode-permission")).toBe(nativePermissionReader);
    expect(card("shell").responder).toBe("opencode-permission");
  });

  it("shows what each recorded request asks for: a command, a file's patch, a URL, an MCP tool's input", () => {
    expect(card("shell")).toMatchObject({ kind: "approval", body: "$ ls -la ." });
    expect(card("edit").own_text?.question?.vars).toEqual({ file: "hello.txt" });
    expect(card("edit").body).toBe((request("edit").metadata!.files as { patch: string }[])[0]!.patch);
    expect(card("webfetch")).toMatchObject({ body: null, own_text: { question: { vars: { url: "https://example.com" } } } });
    expect(card("ovisfix_echo")).toMatchObject({ body: JSON.stringify({ word: "hello" }, null, 2), own_text: { question: { vars: { tool: "ovisfix_echo" } } } });
  });

  it("offers Always allow, with what it saves, only when OpenCode would save something", () => {
    expect(card("shell").openCodePermission?.decisions).toEqual(["once", "always", "reject"]);
    expect(card("shell").own_text?.descriptions?.[1]?.vars).toEqual({ patterns: "ls *" });
    expect(card("edit").own_text?.descriptions?.[1]?.vars).toEqual({ action: "edit" });
    expect(openCodePermissionPrompt({ ...request("shell"), save: [] })!.openCodePermission?.decisions).toEqual(["once", "reject"]);
  });

  it("makes no card it cannot show whole: an edit missing a file's patch, a body longer than a card shows", () => {
    const edit = request("edit");
    const file = (edit.metadata!.files as Record<string, unknown>[])[0]!;
    expect(openCodePermissionPrompt({ ...edit, metadata: { files: [file, { ...file, patch: 7 }] } })).toBeNull();
    expect(openCodePermissionPrompt({ ...edit, metadata: {} })).toBeNull();
    expect(openCodePermissionPrompt({ ...request("shell"), input: { command: "echo " + "x".repeat(12_000) } })).toBeNull();
  });

  it.each(commands.map((recorded) => [recorded.condition, recorded] as const))("shows the %s command the call runs, byte for byte, not the pieces its rules match", (_, { executed, permission: { source, ...permission }, message }) => {
    const input = message.data.content.find((part) => part.id === source.id)!.state.input;
    expect(openCodePermissionPrompt({ ...permission, input })!.body).toBe(`$ ${executed}`);
  });

  it("makes no shell card from the pieces alone: without the call's input, what runs is not known", () => {
    for (const { permission: { source: _, ...permission } } of commands) expect(openCodePermissionPrompt(permission)).toBeNull();
  });

  it("is another card for another request of the same words", () => {
    expect(openCodePermissionPrompt({ ...request("shell"), id: "per_other" })!.id).not.toBe(card("shell").id);
  });
});
