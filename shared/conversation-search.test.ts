import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "./protocol.ts";
import { createCodexTranscriptParser } from "../server/codex.ts";
import { conversationTurnAnchor, matchSnippet, pickedTurn, searchableText, searchedTurnChanged, searchPattern, searchTurns } from "./conversation-search.ts";

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

describe("searchedTurnChanged", () => {
  const line = (timestamp: string, type: string, payload: Record<string, unknown>): string => `${JSON.stringify({ timestamp, type, payload })}\n`;
  const started = line("2026-10-01T00:00:00Z", "event_msg", { type: "task_started", turn_id: "t1" });
  const asked = line("2026-10-01T00:00:00Z", "event_msg", { type: "user_message", message: "check the deploy" });
  const found = (turns: readonly ConversationTurn[], query: string) => searchTurns(turns, searchPattern(query)!).find((match) => match.role === "assistant")!;

  it("finds a tool-first answer whose output arrived after it was searched, which no longer has its name", () => {
    const parser = createCodexTranscriptParser();
    parser.write(started + asked
      + line("2026-10-01T00:00:01Z", "response_item", { type: "function_call", name: "exec", arguments: "", call_id: "c1" })
      + line("2026-10-01T00:00:02Z", "event_msg", { type: "agent_message", message: "The deploy script is ready." }));
    const match = found(parser.snapshot(), "deploy script");
    parser.write(line("2026-10-01T00:00:03Z", "response_item", { type: "function_call_output", call_id: "c1", output: "deploy.sh" }));
    const turns = parser.snapshot();
    expect(turns.some((turn) => conversationTurnAnchor(turn) === match.turn)).toBe(false);
    expect(turns.filter((turn) => searchedTurnChanged(turn, match))).toEqual([turns[1]!]);
  });

  it("finds an answer that went on after it was searched, its first words grown", () => {
    const answer = (text: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [{ kind: "text", text }] });
    const match = found([user("go"), answer("The deploy script")], "deploy script");
    const grown = answer("The deploy script is ready, and it ran on both hosts without a single error.");
    expect(conversationTurnAnchor(grown)).not.toBe(match.turn);
    expect(searchedTurnChanged(grown, match)).toBe(true);
    // a link that streamed in closes, and its mark leaves the words before the match
    const linked = found([user("go"), answer("Result: [deploy")], "deploy");
    expect(linked.before).toBe("Result: [");
    expect(searchedTurnChanged(answer("Result: [deploy](https://example.com) is up."), linked)).toBe(true);
    const linkAfter = found([user("go"), answer("deploy [docs")], "deploy");
    expect(searchedTurnChanged(answer("deploy [docs](https://example.com) are ready"), linkAfter)).toBe(true);
  });

  it("tells apart two answers of one time that the user steered between, and takes none whose words before the match changed", () => {
    const parser = createCodexTranscriptParser();
    parser.write(started + asked
      + line("2026-10-01T00:00:01Z", "event_msg", { type: "agent_message", message: "First: the deploy script fails." })
      + line("2026-10-01T00:00:02Z", "event_msg", { type: "user_message", message: "try again" })
      + line("2026-10-01T00:00:03Z", "event_msg", { type: "agent_message", message: "Second: the deploy script passes." }));
    const turns = parser.snapshot();
    // Codex dates both answers by the task's start
    expect(turns[1]!.ts).toBe(turns[3]!.ts);
    const [second, first] = searchTurns(turns, searchPattern("deploy script")!).filter((match) => match.role === "assistant");
    expect(turns.filter((turn) => searchedTurnChanged(turn, first!))).toEqual([turns[1]!]);
    expect(turns.filter((turn) => searchedTurnChanged(turn, second!))).toEqual([turns[3]!]);
    const rewritten: ConversationTurn = { ...turns[1]!, parts: [{ kind: "text", text: "Now: the deploy script fails." }] };
    expect(searchedTurnChanged(rewritten, first!)).toBe(false);
    expect(searchedTurnChanged({ ...turns[1]!, ts: "2026-10-01T00:00:09Z" }, first!)).toBe(false);
    expect(searchedTurnChanged({ ...turns[1]!, role: "user" }, first!)).toBe(false);
  });
});

describe("pickedTurn", () => {
  const answer = (text: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [{ kind: "text", text }] });
  const match = searchTurns([answer("The deploy script")], searchPattern("deploy script")!)[0]!;

  it("opens the one turn that is the match, by its name or changed since, past rows that are no turn", () => {
    expect(pickedTurn([user("go"), null, answer("The deploy script")], match)).toBe(2);
    expect(pickedTurn([user("go"), answer("The deploy script is ready."), user("thanks")], match)).toBe(1);
    expect(pickedTurn([user("go"), answer("Another deploy script")], match)).toBe("none");
    // an answer that begins with the match: an answer of its time with words before it is another one
    const opening = searchTurns([answer("deploy script")], searchPattern("deploy script")!)[0]!;
    expect(pickedTurn([answer("deploy script"), user("again"), answer("Meanwhile deploy script fails")], opening)).toBe(0);
    // a long answer's snippet is cut: a closed link moves the cut, and the words still end alike
    const long = `${"word ".repeat(20)}see [deploy`;
    const cut = searchTurns([answer(long)], searchPattern("deploy")!)[0]!;
    expect(cut.before.startsWith("…")).toBe(true);
    expect(pickedTurn([answer(`${long}](https://example.com) now`)], cut)).toBe(0);
  });

  it("opens each of two answers of one time that begin with the match, by its name", () => {
    const turns = [answer("Deploy script fails."), user("again"), answer("Deploy script passes.")];
    const [passes, fails] = searchTurns(turns, searchPattern("deploy script")!);
    expect(pickedTurn(turns, fails!)).toBe(0);
    expect(pickedTurn(turns, passes!)).toBe(2);
    // one that went on is still found
    expect(pickedTurn([answer("Deploy script fails. Rerunning it."), user("again"), answer("Deploy script passes.")], fails!)).toBe(0);
  });

  it("opens an answer by its name when a later answer of its time begins with it", () => {
    const parser = createCodexTranscriptParser();
    const line = (timestamp: string, payload: Record<string, unknown>): string => `${JSON.stringify({ timestamp, type: "event_msg", payload })}\n`;
    parser.write(line("2026-10-01T00:00:00Z", { type: "task_started", turn_id: "t1" }) + line("2026-10-01T00:00:00Z", { type: "user_message", message: "fix the build" })
      + line("2026-10-01T00:00:01Z", { type: "agent_message", message: "Done." }) + line("2026-10-01T00:00:02Z", { type: "user_message", message: "also the lint" })
      + line("2026-10-01T00:00:03Z", { type: "agent_message", message: "Done. The lint passes too." }));
    const turns = parser.snapshot();
    const [later, first] = searchTurns(turns, searchPattern("done")!);
    expect(pickedTurn(turns, first!)).toBe(1);
    expect(pickedTurn(turns, later!)).toBe(3);
    // steered twice: answers after the named one never stop it
    const thrice = [answer("Done."), user("lint"), answer("Done. Lint passes."), user("tests"), answer("Done. Tests pass.")];
    expect(pickedTurn(thrice, searchTurns([answer("Done.")], searchPattern("done")!)[0]!)).toBe(0);
    // turns without a time: by name only
    const untimed = [user("fix it now", null), answer("ok"), user("fix it", null)];
    expect(pickedTurn(untimed, searchTurns(untimed, searchPattern("fix it")!)[0]!)).toBe(2);
    const prompts = [user("run tests", null), answer("ok"), user("run tests now", null)];
    expect(pickedTurn(prompts, searchTurns(prompts, searchPattern("run tests")!)[1]!)).toBe(0);
  });

  it("opens the first of turns that share the match's name, as without a changed one", () => {
    const turns = [user("continue", null), answer("ok one"), user("continue", null), answer("ok two")];
    for (const match of searchTurns(turns, searchPattern("continue")!)) expect(pickedTurn(turns, match)).toBe(0);
  });

  it("takes no answer of the same opening whose words after the match went another way", () => {
    const tooled = (output: string, text: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [
      { kind: "tool", name: "exec", summary: "exec", input: "", output }, { kind: "text", text }] });
    const searched = searchTurns([tooled("ok", "deploy succeeded")], searchPattern("deploy")!)[0]!;
    expect(pickedTurn([tooled("fail", "deploy failed")], searched)).toBe("none");
    expect(pickedTurn([tooled("ok, all of it", "deploy succeeded on both hosts")], searched)).toBe(0);
  });

  it("opens none when the answer grew and a later answer of its time took its old name", () => {
    expect(pickedTurn([answer("The deploy script is ready."), user("again"), answer("The deploy script")], match)).toBe("several");
    expect(pickedTurn([answer("The deploy script is ready."), user("again"), answer("The deploy script passes.")], match)).toBe("several");
  });
});
