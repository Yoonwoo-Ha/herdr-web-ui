import { describe, expect, it } from "bun:test";

import { formatWorkDuration, splitTurn, workSummary } from "./workBlocks.ts";
import type { ConversationPart } from "../../shared/protocol.ts";

const tool = (name: string, summary = name): Extract<ConversationPart, { kind: "tool" }> => ({ kind: "tool", name, summary, input: "{}", output: "" });
const text = (value: string): Extract<ConversationPart, { kind: "text" }> => ({ kind: "text", text: value });
const thinking = (value: string): Extract<ConversationPart, { kind: "thinking" }> => ({ kind: "thinking", text: value });

describe("splitTurn", () => {
  it("folds every action and the narration between them into the work; the trailing prose is the answer", () => {
    const split = splitTurn([thinking("hm"), tool("read"), text("looking…"), tool("edit"), text("done"), text("really")]);
    expect(split.work).toEqual([thinking("hm"), tool("read"), text("looking…"), tool("edit")]);
    expect(split.answer).toEqual([text("done"), text("really")]);
  });

  it("is all answer when the agent only spoke, and drops whitespace-only prose", () => {
    expect(splitTurn([text("  \n"), text("hi")])).toEqual({ work: [], answer: [text("hi")] });
  });

  it("is all work when the turn ends on an action (still running)", () => {
    expect(splitTurn([text("on it"), tool("bash")])).toEqual({ work: [text("on it"), tool("bash")], answer: [] });
  });
});

describe("workSummary", () => {
  it("counts by what the reader cares about, singular and plural", () => {
    expect(workSummary([tool("Edit"), tool("Write"), tool("read"), tool("Bash"), tool("WebFetch")])).toBe("2 edits · 1 file read · 1 command · 1 other tool");
  });

  it("is empty for reasoning and prose alone", () => {
    expect(workSummary([thinking("x"), text("y")])).toBe("");
  });
});

describe("formatWorkDuration", () => {
  it("formats seconds, minutes and rejects unknown or negative spans", () => {
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:07.4Z")).toBe("7s");
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:12Z")).toBe("1m 12s");
    expect(formatWorkDuration("2026-01-01T00:00:10Z", "2026-01-01T00:00:00Z")).toBeNull();
    expect(formatWorkDuration(null, "2026-01-01T00:00:00Z")).toBeNull();
  });
});
