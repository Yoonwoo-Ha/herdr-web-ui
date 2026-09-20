import { describe, expect, it } from "bun:test";

import { groupToolRuns } from "./toolGroups.ts";
import type { ConversationPart } from "../../shared/protocol.ts";

const tool = (name: string, marker: string): Extract<ConversationPart, { kind: "tool" }> => ({
  kind: "tool",
  name,
  summary: marker,
  input: marker,
  output: "",
});
const text = (body: string): ConversationPart => ({ kind: "text", text: body });

describe("groupToolRuns", () => {
  it("folds a run of same-name calls into one group", () => {
    const parts = [tool("read", "a"), tool("read", "b"), tool("read", "c")];
    const grouped = groupToolRuns(parts);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.kind).toBe("tool-group");
    if (grouped[0]?.kind === "tool-group") expect(grouped[0].tools).toHaveLength(3);
  });

  it("leaves a lone call unfolded and keeps text in place", () => {
    const parts = [text("look"), tool("read", "a"), text("done")];
    expect(groupToolRuns(parts)).toEqual(parts);
  });

  it("breaks a run when the agent speaks between calls", () => {
    const parts = [tool("read", "a"), text("wait"), tool("read", "b")];
    const grouped = groupToolRuns(parts);
    expect(grouped).toEqual(parts); // two singles, not one group
  });

  it("groups runs per tool name, not across names", () => {
    const parts = [tool("read", "a"), tool("bash", "x"), tool("read", "b")];
    const grouped = groupToolRuns(parts);
    expect(grouped).toEqual(parts); // interleaved different names never fold
  });

  it("keeps group order and mixed content", () => {
    const parts = [text("go"), tool("bash", "1"), tool("bash", "2"), tool("bash", "3"), text("ok"), tool("edit", "e")];
    const grouped = groupToolRuns(parts);
    expect(grouped).toHaveLength(4);
    expect(grouped[1]?.kind).toBe("tool-group");
    expect(grouped[3]).toEqual(tool("edit", "e"));
  });
});
