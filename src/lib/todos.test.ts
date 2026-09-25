import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { parseTodoAnswer, todoCallSummary, todoState } from "./todos.ts";

const call = (name: string, input: unknown, output = "") => ({ kind: "tool" as const, name, summary: name, input: JSON.stringify(input), output });
const turn = (...parts: ReturnType<typeof call>[]): ConversationTurn => ({ role: "assistant", ts: null, parts });
const view = (items: ReturnType<typeof todoState>) => (items ?? []).map((item) => `${item.status}:${item.phase ?? ""}:${item.label}`);

// an omp/omo answer, as the tool prints it
const OMP_ANSWER = `Remaining items (2):
  - E2E check [in_progress] (Verify)
  - Release run [pending] (Verify)
Overall: 2/5 done, 2 open.
Active phase 2/2 "Verify" (0/3).
  Build:
    - [X] Parser
    - [X] Panel
  Verify:
    - [ ] Old flow (dropped)
    - [ ] E2E check (in progress)
    - [ ] Release run`;

// a gjc answer
const GJC_ANSWER = `Remaining items (2):
  - Fix installer [in_progress] (Recovery)
  - Run regressions [pending] (Verification)
Phase 1/2 "Recovery" — 1/2 tasks complete
  Recovery:
    ✓ Confirm handoff
    → Fix installer
  Verification:
    ○ Run regressions`;

describe("todoState", () => {
  it("takes Claude's TodoWrite and Codex's update_plan whole, the newest call winning", () => {
    expect(view(todoState([turn(
      call("TodoWrite", { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "pending" }] }),
      call("TodoWrite", { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }] }),
    )]))).toEqual(["completed::Read", "in_progress::Write"]);
    expect(view(todoState([turn(call("update_plan", { explanation: "x", plan: [{ step: "Probe", status: "completed" }, { step: "Patch", status: "in_progress" }] }))])))
      .toEqual(["completed::Probe", "in_progress::Patch"]);
  });

  it("replays omp operations, starting the next item as the tool does", () => {
    const items = todoState([turn(
      call("todo", { op: "init", list: [{ phase: "Build", items: ["Parser", "Panel"] }, { phase: "Verify", items: ["E2E"] }] }),
      call("todo", { op: "done", task: "Parser" }),
      call("todo", { op: "append", phase: "Build", items: ["Styles"] }),
      call("todo", { op: "block", task: "E2E", reason: "needs a device" }),
      call("todo", { op: "drop", phase: "Verify" }),
    )]);
    expect(view(items)).toEqual(["completed:Build:Parser", "in_progress:Build:Panel", "pending:Build:Styles", "dropped:Verify:E2E"]);
  });

  it("takes gjc's ops arrays, and a whole-list answer over the replay", () => {
    const replayed = todoState([turn(call("todo_write", { ops: [{ op: "init", list: [{ phase: "Recovery", items: ["Confirm handoff", "Fix installer"] }] }, { op: "done", task: "Confirm handoff", phase: "", items: [""] }] }))]);
    expect(view(replayed)).toEqual(["completed:Recovery:Confirm handoff", "in_progress:Recovery:Fix installer"]);
    // the list began before the loaded pages: only the answer knows it
    const answered = todoState([turn(call("todo", { op: "done", task: "Panel" }, OMP_ANSWER))]);
    expect(view(answered)).toEqual(["completed:Build:Parser", "completed:Build:Panel", "dropped:Verify:Old flow", "in_progress:Verify:E2E check", "pending:Verify:Release run"]);
  });

  it("is null without todo calls, and empty once the list is cleared", () => {
    expect(todoState([turn(call("Bash", { command: "ls" }))])).toBeNull();
    expect(todoState([turn(call("todo", { op: "init", list: [{ phase: "A", items: ["x"] }] }), call("todo", { op: "view" }, "Todo list is empty."))])).toEqual([]);
  });
});

describe("parseTodoAnswer", () => {
  it("reads omp/omo boxes and gjc glyphs, with a blocked item's reason", () => {
    expect(parseTodoAnswer(GJC_ANSWER)!.map((item) => item.status)).toEqual(["completed", "in_progress", "pending"]);
    const blocked = parseTodoAnswer("Remaining items (1):\n  Ops:\n    - [ ] Update tailscale (blocked: needs sudo)")!;
    expect(blocked).toEqual([{ label: "Update tailscale", phase: "Ops", status: "blocked", note: "needs sudo" }]);
    // a label that merely ends in parentheses keeps them
    expect(parseTodoAnswer("  A:\n    - [X] Install rsync (fast tools)")![0]!.label).toBe("Install rsync (fast tools)");
  });

  it("refuses an answer cut short, or one without a list", () => {
    expect(parseTodoAnswer(`${OMP_ANSWER.split("\n").slice(0, -1).join("\n")}`)).toBeNull();
    expect(parseTodoAnswer(`${OMP_ANSWER}\n… trimmed`)).toBeNull();
    expect(parseTodoAnswer("[shaken ~178 tokens — recover: artifact://298]")).toBeNull();
  });
});

describe("todoCallSummary", () => {
  it("says what a call did in one line", () => {
    expect(todoCallSummary(call("todo", { op: "init", list: [{ phase: "A", items: ["x", "y"] }] }))).toBe("plan · 2 items");
    expect(todoCallSummary(call("todo", { op: "done", phase: "Contract" }))).toBe("done · Contract");
    expect(todoCallSummary(call("todo_write", { ops: [{ op: "start", task: "Fix" }, { op: "append", phase: "B", items: ["z"] }] }))).toBe("start · Fix, add · 1 to B");
    expect(todoCallSummary(call("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }))).toBe("1/2 done");
    expect(todoCallSummary(call("Bash", { command: "ls" }))).toBeNull();
  });
});
