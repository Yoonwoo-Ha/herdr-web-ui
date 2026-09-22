import { describe, expect, it } from "bun:test";
import { parseConversationMetadata } from "./conversation-metadata.ts";

const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

describe("recorded conversation model settings", () => {
  it("uses the latest Codex turn context, not the session's initial model", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "session_meta", payload: { model: "initial", reasoning_effort: "low" } },
      { type: "turn_context", payload: { model: "current", effort: "xhigh" } },
      { type: "response_item", payload: { type: "message", role: "user", model: "user text is not metadata" } },
    ), "codex-transcript")).toEqual({ model: "current", reasoning_effort: "xhigh" });
  });

  it("recognizes collaboration-mode settings and explicit effort overrides", () => {
    const context = { collaboration_mode: { settings: { model: "collaboration-model", reasoning_effort: "high" } } };
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: context }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "high" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: "none" } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "none" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: null } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: null });
  });

  it("does not carry an old effort into a Codex context that no longer reports one", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "turn_context", payload: { model: "first", effort: "high" } },
      { type: "turn_context", payload: { model: "second" } },
    ), "codex-transcript")).toEqual({ model: "second", reasoning_effort: null });
  });

  it("updates independent omp/omo model and thinking settings, including off", () => {
    for (const source of ["omp-transcript", "omo-transcript"] as const) {
      expect(parseConversationMetadata(jsonl(
        { type: "model_change", modelId: "first" },
        { type: "thinking_level_change", thinkingLevel: "max" },
        { type: "model_change", modelId: "second" },
      ), source)).toEqual({ model: "second", reasoning_effort: "max" });
      expect(parseConversationMetadata(jsonl(
        { type: "thinking_level_change", thinkingLevel: "off" },
        { type: "message", message: { role: "assistant", model: "actual-response-model" } },
      ), source)).toEqual({ model: "actual-response-model", reasoning_effort: "off" });
    }
  });

  it("reads Claude's actual model without deriving effort from thinking content", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "text" }] } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
    ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: null });
  });

  it("tolerates absent metadata, unexpected types and a torn append without losing valid settings", () => {
    const text = jsonl(null, [], { type: "turn_context", payload: null },
      { type: "turn_context", payload: { model: "recorded", effort: "medium" } },
      { type: "turn_context", payload: { model: {}, effort: undefined } });
    expect(parseConversationMetadata(`${text}\n{"type":`, "codex-transcript"))
      .toEqual({ model: "recorded", reasoning_effort: "medium" });
    expect(parseConversationMetadata("", "scrollback")).toEqual({ model: null, reasoning_effort: null });
  });
});
