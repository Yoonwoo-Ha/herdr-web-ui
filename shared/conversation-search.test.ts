import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "./protocol.ts";
import { conversationTurnAnchor, matchSnippet, searchableText, searchPattern, searchTurns } from "./conversation-search.ts";

const user = (text: string, ts: string | null = "2026-10-01T00:00:00Z"): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text }] });

describe("searchPattern", () => {
  it("matches the words in order across any whitespace, case ignored, every character literal", () => {
    const pattern = searchPattern("  Deploy   script ")!;
    expect(pattern.test("the deploy\n\tSCRIPT failed")).toBe(true);
    expect(pattern.test("the script deploy")).toBe(false);
    expect(searchPattern("a.b (c)? [d] {e} | f\\g /h ^$*+")!.test("x a.b (c)? [d] {e} | f\\g /h ^$*+ y")).toBe(true);
    expect(searchPattern("a.b")!.test("axb")).toBe(false);
    expect(searchPattern("ÉCOLE")!.test("l'école")).toBe(true);
    expect(searchPattern("   ")).toBeNull();
    expect(searchPattern("")).toBeNull();
  });
});

describe("searchableText", () => {
  it("reads the user's words and the agent's answers, never its tools, thinking or progress notes", () => {
    const turn: ConversationTurn = { role: "assistant", ts: null, parts: [
      { kind: "thinking", text: "secret plan" },
      { kind: "text", text: "Looking at the plan.", phase: "commentary" },
      { kind: "tool", name: "Bash", summary: "plan", input: "cat plan", output: "plan output" },
      { kind: "text", text: "The plan is done." },
      { kind: "text", text: "Final word.", phase: "final_answer" },
    ] };
    expect(searchableText(turn)).toBe("The plan is done.\n\nFinal word.");
    expect(searchableText({ role: "user", ts: null, parts: [{ kind: "text", text: "one" }, { kind: "image", media_type: "image/png", ref: "r" }, { kind: "text", text: "two" }] })).toBe("one\n\ntwo");
  });

  it("reads an answer's words as the chat draws them, without its Markdown marks", () => {
    const answer = "## Done\n\n- **`POST /payments`** replays the [stored](https://example.com/a) response.\n2. A `snake_case_name` stays.\n> quoted\n```ts\nconst a = 1;\n```";
    expect(searchableText({ role: "assistant", ts: null, parts: [{ kind: "text", text: answer }] }))
      .toBe("Done\n\nPOST /payments replays the stored response.\nA snake_case_name stays.\nquoted\n\nconst a = 1;\n");
    expect(searchPattern("payments replays the stored")!.test(searchableText({ role: "assistant", ts: null, parts: [{ kind: "text", text: answer }] }))).toBe(true);
  });
});

describe("matchSnippet", () => {
  it("keeps the words around the match, cut with an ellipsis, whitespace as single spaces", () => {
    const text = `${"lead ".repeat(40)}the needle\n\nin  the ${"tail ".repeat(60)}`;
    const snippet = matchSnippet(text, searchPattern("needle")!)!;
    expect(snippet.match).toBe("needle");
    expect(snippet.before.startsWith("…")).toBe(true);
    expect(snippet.before.endsWith("the ")).toBe(true);
    expect(snippet.before.length).toBeLessThanOrEqual(33);
    // the word the cut went through goes with it
    expect(snippet.before).toMatch(/^…(?:lead )+the $/);
    expect(snippet.after).toMatch(/^ in the (?:tail )*tail…$/);
    expect(snippet.after.startsWith(" in the tail")).toBe(true);
    expect(snippet.after.endsWith("…")).toBe(true);
    expect(snippet.after.length).toBeLessThanOrEqual(161);
    expect(matchSnippet("needle", searchPattern("needle")!)).toEqual({ before: "", match: "needle", after: "" });
    expect(matchSnippet("hay", searchPattern("needle")!)).toBeNull();
  });

  it("never cuts a character made of two code units in half", () => {
    const emoji = "😀".repeat(100);
    // an odd number of code units before the match puts every margin's edge inside a pair
    for (const text of [`${emoji}needle${emoji}`, `${emoji}a needle${emoji}`, `${emoji}${" ".repeat(200)}a needle ${" ".repeat(400)}${emoji}`]) {
      const snippet = matchSnippet(text, searchPattern("needle")!)!;
      for (const side of [snippet.before, snippet.after]) expect(side.replaceAll("…", "")).toMatch(/^(?:😀| |a)*$/u);
    }
  });
});

describe("searchTurns", () => {
  it("lists each matching turn once, newest first, named as the chat names its rows", () => {
    const turns = [user("fix the build"), { role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [{ kind: "text", text: "The build is fixed. The build passes." }] } satisfies ConversationTurn, user("thanks")];
    expect(searchTurns(turns, searchPattern("build")!)).toEqual([
      { turn: conversationTurnAnchor(turns[1]!), role: "assistant", ts: "2026-10-01T00:00:01Z", before: "The ", match: "build", after: " is fixed. The build passes." },
      { turn: "user|2026-10-01T00:00:00Z|text|fix the build", role: "user", ts: "2026-10-01T00:00:00Z", before: "fix the ", match: "build", after: "" },
    ]);
  });
});
