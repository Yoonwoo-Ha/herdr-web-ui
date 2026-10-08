import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../shared/protocol.ts";

import { answerKeys, removedInvisible, codexQuestionsCollapsed, codexQueuedPrompt, handlePromptRequest, modelListWaits, openOmoAsks, parseClaudeSuggestion, parseFallbackPrompt, parseInteractivePrompt, pendingOmoAsk, promptWaitEnded } from "./prompt.ts";

const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);

describe("interactive prompt parsing", () => {
  test("invalidates approvals when their command changes, including text beyond the display cap", () => {
    const screen = (command: string, secondSelected = false) => `
Would you like to run the following command?
${command}
${secondSelected ? " " : "›"} 1. Yes, proceed
${secondSelected ? "›" : " "} 2. No, cancel
Press enter to confirm or esc to cancel
`;
    const first = parseInteractivePrompt("codex", screen("echo first"))!;
    expect(first).not.toBeNull();
    expect(parseInteractivePrompt("codex", screen("echo second"))!.id).not.toBe(first.id);
    expect(parseInteractivePrompt("codex", screen("echo first", true))!.id).toBe(first.id);
    const prefix = "x".repeat(12_010);
    expect(parseInteractivePrompt("codex", screen(prefix + "a"))!.id)
      .not.toBe(parseInteractivePrompt("codex", screen(prefix + "b"))!.id);
  });

  test("parses Claude questions, approvals, and plans", () => {
    const questionScreen = `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. T-LESS
     Texture-less objects.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    const question = parseInteractivePrompt("claude", questionScreen);
    expect(question).toMatchObject({
      agent: "claude",
      kind: "question",
      // a single question is titled by its header chip
      title: "Dataset",
      question: "Which evaluation dataset should we use?",
      multi_select: false,
      custom_option_index: 3,
    });
    expect(labels(question)).toEqual(["LM-O", "YCB-V", "T-LESS"]);
    expect(question?.options[0]?.description).toBe("Occlusion benchmark.");
    expect(parseInteractivePrompt("claude", questionScreen)?.id).toBe(question?.id);

    const approval = parseInteractivePrompt("claude", `
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for: curl *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`);
    expect(approval?.kind).toBe("approval");
    expect(approval?.title).toBe("Fetch HTTP headers.");
    expect(labels(approval)).toEqual(["Yes", "Yes, and don’t ask again for: curl *", "No"]);

    const plan = parseInteractivePrompt("claude", `
Ready to code?

Here is Claude's plan:
Add a heading to the README file.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, refine with Ultraplan on Claude Code on the web
  4. Tell Claude what to change
     shift+tab to approve with this feedback
`);
    expect(plan).toMatchObject({ kind: "plan", title: "Ready to code?", custom_option_index: 3 });
    expect(plan?.body).toContain("Add a heading");
    expect(answerKeys(plan!, { custom_text: "Keep the existing introduction" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] },
      { text: "Keep the existing introduction" },
      { keys: ["shift+tab"] },
    ]);
  });

  test("parses omp single, multi-select, and approval prompts", () => {
    const single = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────╮
│ Which target?           │
├─────────────────────────┤
│❯ ○ Jetson Orin         │
│  ○ RK3588               │
│  ○ Other (type your own)│
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`);
    expect(single).toMatchObject({ kind: "question", question: "Which target?", custom_option_index: 2 });
    expect(labels(single)).toEqual(["Jetson Orin", "RK3588"]);

    const multi = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────╮
│ Which checks?           │
├─────────────────────────┤
│❯ ☐ Lint                │
│  ☐ Tests                │
│  ☐ Build                │
│  ☐ Other (type your own)│
├─────────────────────────┤
│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel
╰─────────────────────────╯
`);
    expect(multi).toMatchObject({ kind: "question", title: "Multiple choice", multi_select: true, custom_option_index: null });
    expect(answerKeys(multi!, { option_indices: [0, 2] })).toEqual([
      { keys: ["space"] },
      { keys: ["down"] },
      { keys: ["down"] },
      { keys: ["space"] },
      { keys: ["tab"] },
      { keys: ["enter"] },
    ]);

    const approval = parseInteractivePrompt("omp", `
╭─ Permission ────────────╮
│ Allow tool: bash        │
│ curl -I example.com     │
│❯ Approve               │
│  Deny                  │
╰─────────────────────────╯
`);
    expect(approval?.kind).toBe("approval");
    expect(labels(approval)).toEqual(["Approve", "Deny"]);
  });

  test("parses Codex continue, question, async question, and approval prompts", () => {
    const menu = parseInteractivePrompt("codex", `
✨ Update available! 0.146.0 -> 0.146.1

› 1. Update now
  2. Skip
  3. Skip until next version

Press enter to continue
`);
    expect(menu).toMatchObject({ kind: "menu", title: "Codex", question: "Choose how to continue" });
    expect(answerKeys(menu!, { option_index: 2 })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);

    const question = parseInteractivePrompt("codex", `
Question 1/1 (1 unanswered)
Which export format should we use?

› 1. ONNX               Export a portable ONNX model.
  2. TensorRT           Build an NVIDIA TensorRT engine.
  3. RKNN               Build an RKNN model.
  4. None of the above  Optionally, add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`);
    expect(question).toMatchObject({ kind: "question", custom_option_index: 3 });
    expect(labels(question)).toEqual(["ONNX", "TensorRT", "RKNN"]);
    expect(question?.options[0]?.description).toBe("Export a portable ONNX model.");

    const asyncQuestion = parseInteractivePrompt("codex", `
Which accelerator?

› 1. CUDA
  2. CPU
  3. NPU
  4. Other

enter submit   ctrl + ] skip
option 1/4   shift + → main prompt
`);
    expect(asyncQuestion).toMatchObject({ kind: "question", question: "Which accelerator?", custom_option_index: 3 });
    expect(labels(asyncQuestion)).toEqual(["CUDA", "CPU", "NPU"]);

    const approval = parseInteractivePrompt("codex", `
Would you like to run the following command?

Environment: local
$ curl -I https://example.com

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with curl
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`);
    expect(approval?.kind).toBe("approval");
    expect(approval?.body).toContain("curl -I");
    expect(answerKeys(approval!, { option_index: 2 })).toEqual([{ keys: ["esc"] }]);
  });

  // screens captured from Claude Code 2.1.280 and Codex 0.156.0 (paths shortened)
  test("parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers", () => {
    const first = parseInteractivePrompt("claude", `
←  ☐ Route  ☐ Author  ✔ Submit  →
Which way should the PR go?
❯ 1. Log in as owner
     Authenticate as the repository owner and open the PR directly on the repo.
  2. Fork
     Push the branch to a fork and open the PR from there.
  3. Type something.
────────────────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(first).toMatchObject({ kind: "question", title: "Route · 1 of 2", question: "Which way should the PR go?", custom_option_index: 2 });
    expect(labels(first)).toEqual(["Log in as owner", "Fork"]);

    const sets = parseInteractivePrompt("claude", `
←  ☒ Route  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
         Include the LM-O dataset.
  2. [ ] YCB-V
         Include the YCB-V dataset.
  3. [ ] T-LESS
         Include the T-LESS dataset.
  4. [ ] Type something
     Next
────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(sets).toMatchObject({ title: "Sets · 2 of 2", multi_select: true });
    // → moves on to the next tab: an enter there would pick its first option
    expect(answerKeys(sets!, { option_indices: [0, 2] })).toEqual([
      { keys: ["enter"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] },
    ]);

    const review = parseInteractivePrompt("claude", `
←  ☒ Route  ☒ Author  ✔ Submit  →
Review your answers
 ● Which way should the PR go?
   → Log in as owner
 ● Who should author the commits?
   → Repo owner
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`);
    // a menu: a typed pick submits every answer at once, so the chat asks for Confirm
    expect(review).toMatchObject({ kind: "menu", title: "Review your answers", question: "Ready to submit your answers?", custom_option_index: null });
    expect(review?.body).toContain("→ Repo owner");
    expect(labels(review)).toEqual(["Submit answers", "Cancel"]);

    const bash = parseInteractivePrompt("claude", `
● Deleting the junk directory
  ⎿  $ rm -rf junk
────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/prompt-lab/junk from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
`);
    expect(bash).toMatchObject({ kind: "approval", title: "Bash command", question: "Do you want to proceed?", body: "rm -rf junk\nDelete the junk directory" });
    expect(labels(bash)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    // a narrow pane wraps a long option: its label still reads whole
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────────────────
 Bash command
   rm -rf junk
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
   /tmp/prompt-lab/junk from this project
   3. No
 Esc to cancel · Tab to amend
`);
    expect(labels(wrapped)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "No"]);
    // Claude's own text opens with ● as well: a rule in its table is not the approval's panel
    const underText = parseInteractivePrompt("claude", `
● Results table follows:
────────────────────────────────────────
  run   AR
────────────────────────────────────────
  a     0.66
────────────────────────────────────────
 Bash command
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(underText).toMatchObject({ kind: "approval", title: "Bash command", body: "rm -rf junk\nDelete the junk directory" });
    // an MCP call is a call too: the first rule under it opens the panel, not a rule in its preview
    const mcp = parseInteractivePrompt("claude", `
● github - create_issue (MCP)(title: "Flaky test")
────────────────────────────────────────
 Tool use
   github - create_issue(title: "Flaky test")
────────────────────────────────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(mcp).toMatchObject({ kind: "approval", title: "Tool use" });
    expect(answerKeys(bash!, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);

    const write = parseInteractivePrompt("claude", `
● Write(hello.txt)
────────────────────────────────────────
 Create file
 hello.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend
`);
    expect(write).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create hello.txt?", body: "hello.txt\n1 hi" });
  });

  test("finds Claude's question tabs over a wrapped question and a cut-off bar, and never answers the next question", () => {
    // a narrow pane: the question wraps over seven lines and the bar loses its right end
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────
←  ☒ Route  ☐ Author  ✔ Su
Who should author the
commits that go into the
pull request, given that
the fork belongs to the
lab account and the
upstream repository to
its owner?
❯ 1. Keep local
     The local git identity.
  2. Repo owner
     The repository owner.
  3. Type something.
────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(wrapped).toMatchObject({
      kind: "question", title: "Author",
      question: "Who should author the commits that go into the pull request, given that the fork belongs to the lab account and the upstream repository to its owner?",
    });
    expect(answerKeys(wrapped!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);

    // a multiple choice alone: → reaches the review of the answers, which has its own card
    const alone = parseInteractivePrompt("claude", `
←  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
  2. [ ] YCB-V
  3. [ ] T-LESS
  4. [ ] Type something
     Submit
────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(alone).toMatchObject({ title: "Sets", multi_select: true });
    expect(answerKeys(alone!, { option_indices: [1] })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] }]);
  });

  test("titles a Claude approval from its panel, not from rules in a file preview, and joins labels wrapped over lines", () => {
    const edit = parseInteractivePrompt("claude", `
● Write(notes.md)
────────────────────────────────────────
 Create file
 notes.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 # Notes
  2 ────────────────────────────────────────
  3 Results below the rule
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits
   (auto-approve file edits and common
   file commands) for this session
   3. No
 Esc to cancel · Tab to amend
`);
    expect(edit).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create notes.md?" });
    expect(labels(edit)).toEqual([
      "Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session", "No",
    ]);
  });

  test("parses the last of several Codex 0.156 questions and its folder trust prompt", () => {
    const last = parseInteractivePrompt("codex", `
  Question 2/2 (1 unanswered)
  Which split?
  › 1. train (Recommended)  Use the training split.
    2. test                 Use the test split.
    3. None of the above    Optionally, add details in notes (tab).
  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`);
    expect(last).toMatchObject({ kind: "question", title: "Question 2 of 2", question: "Which split?", custom_option_index: 2 });
    expect(labels(last)).toEqual(["train (Recommended)", "test"]);

    const trust = parseInteractivePrompt("codex", `
  Folder access
  /tmp/prompt-lab-codex
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back
`);
    expect(trust).toMatchObject({ kind: "approval", title: "Trust this folder?", body: "Codex can read, edit, and run files here, subject to your permission settings." });
    expect(labels(trust)).toEqual(["Trust and continue", "Back to Agent Command Center"]);
    expect(answerKeys(trust!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
  });

  test("ignores unknown agents, stale transcript menus, and ordinary output", () => {
    expect(parseInteractivePrompt("other", "Enter to select · ↑/↓ to navigate · Esc to cancel")).toBeNull();
    expect(parseInteractivePrompt("claude", "No response requested. The task is complete.")).toBeNull();
    expect(parseInteractivePrompt("codex", `
Would you like to run the following command?
› 1. Yes, proceed
  2. No, and tell Codex what to do differently
Press enter to confirm or esc to cancel

• Command completed successfully.
› Ask Codex to do something
`)).toBeNull();
  });
});

describe("Codex's queue of questions (request_user_input_async)", () => {
  const status = "  GPT-6-Sol xhigh · ~/lab · Context 97% left · weekly 56% left";

  test("reads an open question: its position, a wrapped title, wrapped options and the typed-answer row", () => {
    const prompt = parseInteractivePrompt("codex", `
• WAITING
• Queued follow-up inputs
  1 of 2
  정리 범위를 현재 Q255 학습 출력과 연결된 산출물로 한정할까요, 아니면
  output/test 전체 실험까지 포함할까요?
  › 1. 현재 Q255 관련 산출물만
    2. output/test 전체 실험까지 포함해서 모두 정리하고
       결과를 표로 남기기
    3. Other
  enter submit   ctrl+] skip   alt+↓ main prompt   alt+↑ next question
`);
    expect(prompt).toMatchObject({
      kind: "question", title: "Question 1 of 2", queued: "open",
      question: "정리 범위를 현재 Q255 학습 출력과 연결된 산출물로 한정할까요, 아니면 output/test 전체 실험까지 포함할까요?",
      custom_option_index: 2,
    });
    expect(labels(prompt)).toEqual(["현재 Q255 관련 산출물만", "output/test 전체 실험까지 포함해서 모두 정리하고 결과를 표로 남기기"]);
    // an answer of its own is typed into the last row once it is selected, then submitted
    expect(answerKeys(prompt!, { custom_text: "Q255 only, keep logs" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { text: "Q255 only, keep logs" }, { keys: ["enter"] },
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads an open free-form question, and a last row already typed over", () => {
    const freeForm = parseInteractivePrompt("codex", `
• Queued follow-up inputs
  Any notes?
  Type your answer
  enter submit   ctrl+] skip   alt+↓ main prompt
`);
    expect(freeForm).toMatchObject({ title: "Question", question: "Any notes?", options: [], custom_option_index: 0 });
    expect(answerKeys(freeForm!, { custom_text: "none" })).toEqual([{ text: "none" }, { keys: ["enter"] }]);

    const typed = parseInteractivePrompt("codex", `
• Queued follow-up inputs
  Which split?
    1. train
    2. test
  › 3. val spl
  enter submit   ctrl+] skip   alt+↓ main prompt
`);
    expect(labels(typed)).toEqual(["train", "test"]);
    expect(answerKeys(typed!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("a collapsed queue shows its first question, taken from the rollout's newest unanswered ones", () => {
    const collapsed = `
• WAITING
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
${status}
`;
    expect(parseInteractivePrompt("codex", collapsed)).toBeNull();
    // only the card answers it: Codex keeps working, and the chat's messages still go to Codex
    expect(codexQueuedPrompt(collapsed, [{ key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] }])?.queued).toBe("collapsed");
    // a message of the user's own waiting to go replaces the questions' block: nothing to open
    expect(codexQueuedPrompt(collapsed.replace("    alt+↑ to answer", "    alt+↑ to answer\n• Messages to be submitted after next tool call\n  ↳ stop, don't touch prod"), [
      { key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] },
    ])).toBeNull();
    const asked = [
      // skipped in the TUI: no record says so, but only the newest two are waiting
      { key: "call_a:0", title: "Old question?", options: ["x", "y"] },
      { key: "call_b:0", title: "Which dataset?", options: ["LM-O", "YCB-V"] },
      { key: "call_b:1", title: "Any notes?", options: [] },
    ];
    const prompt = codexQueuedPrompt(collapsed, asked);
    expect(prompt).toMatchObject({ kind: "question", title: "Question 1 of 2", question: "Which dataset?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["LM-O", "YCB-V"]);
    expect(codexQueuedPrompt(collapsed.replace("? 2 questions", "? 1 question"), asked)).toMatchObject({ title: "Question", question: "Any notes?", options: [], custom_option_index: 0 });
    // the queue opened on another question last time (one was skipped): the card shows that one
    expect(codexQueuedPrompt(collapsed, asked, { question: "Old question?", options: ["x", "y"] })).toMatchObject({ question: "Old question?", title: "Question 1 of 2" });
    // by title and options: an older skipped question with the same title is not the one it opened on
    const twins = [
      { key: "call_t:0", title: "Which dataset?", options: ["COCO"] },
      ...asked,
    ];
    expect(labels(codexQueuedPrompt(collapsed, twins, { question: "Which dataset?", options: ["LM-O", "YCB-V"] }))).toEqual(["LM-O", "YCB-V"]);
    expect(labels(codexQueuedPrompt(collapsed, twins, { question: "Which dataset?", options: ["COCO"] }))).toEqual(["COCO"]);
    // fewer on record than the queue holds: the card cannot say which is first
    expect(codexQueuedPrompt(collapsed, asked.slice(2))).toBeNull();
    // the count must be the queue above the main prompt, not an old line higher up
    expect(codexQueuedPrompt(collapsed.replace("› Ask Codex to do anything", `${"output line\n".repeat(20)}› Ask Codex`), asked)).toBeNull();
  });
});

describe("Codex's collapsed question queue", () => {
  test("is told apart from an open question, which holds the input", () => {
    const collapsed = `
• WAITING
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
  GPT-6-Sol xhigh · ~/lab · Context 97% left
`;
    expect(codexQuestionsCollapsed(collapsed)).toBe(true);
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  Which split?
  › 1. train
    2. test
    3. Other
  enter submit   ctrl+] skip   alt+↓ main prompt
`)).toBe(false);
    expect(codexQuestionsCollapsed("› Ask Codex to do anything\n")).toBe(false);
    // a numbered menu the parser does not know, right under the queue: not the main prompt
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  ? 1 question
    alt+↑ to answer
› 1. Continue with the new plan
  2. Stop here
`)).toBe(false);
    // an approval under the queue holds the input: a message would answer it
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  ? 1 question
    alt+↑ to answer

Would you like to run the following command?

$ rm -rf junk

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`)).toBe(false);
  });

  test("the card and the send path read the same count, so they never tell different stories", () => {
    const asked = [{ key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] }];
    const collapsed = `
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
  GPT-6-Sol xhigh · ~/lab · Context 97% left
`;
    const screens = {
      collapsed,
      // a message of the user's own waiting to be submitted
      queuedMessage: collapsed.replace("    alt+↑ to answer", "    alt+↑ to answer\n• Messages to be submitted after next tool call\n  ↳ stop, don't touch prod"),
      // something the parser does not know sits between the queue and the main prompt
      somethingBelow: collapsed.replace("› Ask Codex to do anything", "  Allow network access?\n› Ask Codex to do anything"),
      noHint: collapsed.replace("    alt+↑ to answer\n", ""),
      // a menu row the parser does not know, right under the hint, is not the main prompt
      numberedRow: collapsed.replace("› Ask Codex to do anything", "› 1. Allow once\n  2. Deny"),
      none: "› Ask Codex to do anything\n",
    };
    const shown = Object.fromEntries(Object.entries(screens).map(([name, screen]) => [name, [codexQueuedPrompt(screen, asked) !== null, codexQuestionsCollapsed(screen)]]));
    expect(shown).toEqual({ collapsed: [true, true], queuedMessage: [false, false], somethingBelow: [false, false], noHint: [false, false], numberedRow: [false, false], none: [false, false] });
  });
});

describe("interactive prompt answers", () => {
  const claudeQuestion = () => parseInteractivePrompt("claude", `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
  2. YCB-V
  3. T-LESS
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)!;

  test("selects the first and third options relative to the native cursor", () => {
    expect(answerKeys(claudeQuestion(), { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(claudeQuestion(), { option_index: 2 })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);
  });

  test("enters custom text through the provider's direct-input row", () => {
    expect(answerKeys(claudeQuestion(), { custom_text: "Use the internal benchmark" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] },
      { text: "Use the internal benchmark" },
      { keys: ["enter"] },
    ]);

    const codex = parseInteractivePrompt("codex", `
Which backend?

› 1. CUDA
  2. CPU
  3. None of the above  Add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`)!;
    expect(answerKeys(codex, { custom_text: "ROCm" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["tab"] },
      { text: "ROCm" }, { keys: ["enter"] },
    ]);
  });

  test("rejects invalid answer shapes", () => {
    expect(() => answerKeys(claudeQuestion(), { option_index: 0, custom_text: "also" })).toThrow("Exactly one answer");
    expect(() => answerKeys(claudeQuestion(), { option_indices: [0] })).toThrow("requires one or more selections");
    expect(() => answerKeys(claudeQuestion(), { option_index: 99 })).toThrow("valid option index");
    expect(() => answerKeys(claudeQuestion(), { custom_text: 42 } as never)).toThrow("must be a string");
    expect(() => answerKeys(claudeQuestion(), { option_indices: null } as never)).toThrow("must be an array");
  });
});

describe("Claude's question in a narrow pane", () => {
  // live-captured from Claude Code 2.1.283 in a 44-column herdr pane: the hint wraps
  const narrow = `────────────────────────────────────────────
 ☐ 재현 테스트

│ 재현용 테스트 질문입니다. 지금 이 질문
│ 화면을 백그라운드에서 캡처하고 있으니,
│ 15초쯤 기다렸다가 아무거나 골라 주세요.
│ 기다리는 동안 채팅 모드에 이 질문 카드가
│ 뜨는지도 봐 주시면 좋습니다.

❯ 1. 채팅에 카드가 안 떠요
     채팅 모드에 이 질문이 보이지 않음
  2. 채팅에 카드가 떠요
     채팅 모드에 이 질문이 카드로 보임
  3. Type something.
────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to
cancel
`;

  test("reads the question though its hint wrapped, and knows it is still open", () => {
    const prompt = parseInteractivePrompt("claude", narrow);
    expect(prompt).toMatchObject({
      kind: "question",
      title: "재현 테스트",
      options: [{ label: "채팅에 카드가 안 떠요" }, { label: "채팅에 카드가 떠요" }],
      custom_option_index: 2,
    });
    expect(prompt?.question).toStartWith("재현용 테스트 질문입니다.");
  });

  test("does not take an answered menu above later output for an open one", () => {
    expect(parseInteractivePrompt("claude", narrow + "\n● Done.\n\n> ")).toBeNull();
  });
});

describe("a question under a numbered message sent earlier", () => {
  // live-captured from Claude Code in a 120-column herdr pane (shortened): the message sent before,
  // "1. …", stays on screen after the prompt mark, above the panel and the session's titled rule
  const claude = `
❯ 1. 로그인해서 커넥트 눌럿어

⏺ Tailscale 로그인은 완료됐습니다.

  Ran 1 shell command
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Buzz 공개

│ Buzz를 Tailscale 없이 인터넷에서 쓰도록 공개할까요?

❯ 1. 공개 진행 (추천)
     Cloudflare Tunnel로 buzz.kilpenguin.com을 엽니다. 인바운드 포트는 열지 않습니다. relay는 닫힌 모드(멤버 키 서명만
     허용)이고 relay와 /pair만 노출합니다.
  2. Tailscale 유지
     지금 구성 그대로 갑니다(이미 동작 중).
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
─────────────────────────────────────────────────────────────────────────────────────────────── Buzz 슬랙 대체 AI 조사 ─
`;

  test("reads Claude's question, not the sent message, as the menu, with a description wrapped over two lines", () => {
    const prompt = parseInteractivePrompt("claude", claude);
    expect(prompt).toMatchObject({ kind: "question", title: "Buzz 공개", question: "Buzz를 Tailscale 없이 인터넷에서 쓰도록 공개할까요?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["공개 진행 (추천)", "Tailscale 유지"]);
    expect(prompt?.options.map((option) => option.description)).toEqual([
      "Cloudflare Tunnel로 buzz.kilpenguin.com을 엽니다. 인바운드 포트는 열지 않습니다. relay는 닫힌 모드(멤버 키 서명만 허용)이고 relay와 /pair만 노출합니다.",
      "지금 구성 그대로 갑니다(이미 동작 중).",
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("does not start the menu at a numbered line in the first option's description", () => {
    const prompt = parseInteractivePrompt("claude", `
 ☐ Setup

How should we set up?

  1. Script
     Runs these steps:
     1. Install deps
❯ 2. Manual
     Follow the guide.
  3. Type something.
────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(prompt).toMatchObject({ kind: "question", question: "How should we set up?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["Script", "Manual"]);
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("does not take the menu's column from a numbered line under its last option", () => {
    const prompt = parseInteractivePrompt("codex", `
› 1. 먼저 이것부터 해줘

✨ Update available! 0.146.0 -> 0.146.1

› 1. Update now
  2. Skip
  3. Skip until next version
     1. Asks again at the next release.

Press enter to continue
`);
    expect(prompt).toMatchObject({ kind: "menu", question: "Choose how to continue" });
    expect(labels(prompt)).toEqual(["Update now", "Skip", "Skip until next version"]);
  });

  test("reads Codex's open question without the queue header under a sent message", () => {
    const prompt = parseInteractivePrompt("codex", `
› 1. 먼저 이것부터 해줘

• 알겠습니다.

Which accelerator?

› 1. CUDA
  2. CPU
  3. Other

enter submit   ctrl + ] skip
option 1/3   shift + → main prompt
`);
    expect(prompt).toMatchObject({ kind: "question", question: "Which accelerator?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["CUDA", "CPU"]);
  });

  test("reads Codex's question under its own sent message", () => {
    const prompt = parseInteractivePrompt("codex", `
› 1. 먼저 이것부터 해줘

• 알겠습니다.

Which backend?

› 1. CUDA
  2. CPU
  3. None of the above  Add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`);
    expect(prompt).toMatchObject({ kind: "question", question: "Which backend?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["CUDA", "CPU"]);
  });
});

describe("Claude's question with option previews", () => {
  // live-captured from Claude Code 2.1.288 in a 120-column herdr pane: the selected option's
  // preview is boxed to the right of the options, and the form has no "Type something" row
  const withPreview = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Layout  ☐ Features  ✔ Submit  →

Which layout?

❯ 1. Grid                         ┌──────────────────────────────────────────┐
  2. List                         │ ┌──┐ ┌──┐                                │
                                  │ │  │ │  │                                │
                                  │ └──┘ └──┘                                │
                                  │ ┌──┐ ┌──┐                                │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel
`;

  test("reads the options without the preview box and offers no typed answer", () => {
    const prompt = parseInteractivePrompt("claude", withPreview);
    expect(prompt).toMatchObject({
      kind: "question", title: "Layout · 1 of 2", question: "Which layout?",
      options: [{ label: "Grid", description: null }, { label: "List", description: null }],
      multi_select: false, custom_option_index: null,
    });
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt!, { custom_text: "x" })).toThrow();
  });

  test("cuts the box off at its own column only: a bar inside an option's text stays", () => {
    // the same screen with qualifiers after a bar, padded so the box keeps its column
    // padded by display width, so the box keeps its terminal column: a wide character takes two
    const relabel = (screen: string, from: string, to: string) => { expect(screen).toContain(from); return screen.replace(from, to + " ".repeat(Bun.stringWidth(from) - Bun.stringWidth(to))); };
    const screen = relabel(relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. Grid  │ compact"), "  2. List                         ", "  2. List  │ spacious");
    const labelsOf = (prompt: InteractivePrompt | null) => prompt?.kind === "question" ? prompt.options.map((option) => `${option.label}${option.description === null ? "" : ` / ${option.description}`}`) : prompt;
    expect(labelsOf(parseInteractivePrompt("claude", screen))).toEqual(["Grid  │ compact", "List  │ spacious"]);
    // an option in wide characters: its box edge stands at the same column, at a smaller string index
    const wide = relabel(relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. 격자 보기"), "  2. List                         ", "  2. 目录列表  │ 宽");
    expect(labelsOf(parseInteractivePrompt("claude", wide))).toEqual(["격자 보기", "目录列表  │ 宽"]);
    // a joined emoji is one grapheme two columns wide, not the sum of its code points
    const emoji = relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. 👩‍💻 Code");
    expect(labelsOf(parseInteractivePrompt("claude", emoji))).toEqual(["👩‍💻 Code", "List"]);
  });

  test("does not take an answered form above later output for an open one", () => {
    expect(parseInteractivePrompt("claude", withPreview + "\n● Done.\n\n> ")).toBeNull();
  });

  // live-captured from Claude Code 2.1.290 in a 120-column herdr pane, asked with a long description
  // for every option: the form draws none, so nothing under an option is joined into one
  const described = (cursorOn: 0 | 1) => cursorOn === 0 ? `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Layout

Which layout should the report use?

❯ 1. Single Column                ┌──────────────────────────────────────────┐
  2. Two Column                   │ ┌──────────────────┐                     │
  3. Dashboard Grid               │ │     HEADER       │                     │
                                  │ ├──────────────────┤                     │
                                  │ │   Content here   │                     │
                                  │ │   More content   │                     │
                                  │ └──────────────────┘                     │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
` : `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Layout

Which layout should the report use?

  1. Single Column                ┌──────────────────────────────────────────┐
❯ 2. Two Column                   │ ┌─────┬──────────┐                       │
  3. Dashboard Grid               │ │ KEY │ CONTENT  │                       │
                                  │ │ INF │ CONTENT  │                       │
                                  │ │ O   │ CONTENT  │                       │
                                  │ │     │ CONTENT  │                       │
                                  │ └─────┴──────────┘                       │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
`;

  test("draws no option descriptions though the question gave them, and keeps its id as the cursor moves", () => {
    const first = parseInteractivePrompt("claude", described(0));
    const second = parseInteractivePrompt("claude", described(1));
    expect(labels(first)).toEqual(["Single Column", "Two Column", "Dashboard Grid"]);
    expect(first?.options.map((option) => option.description)).toEqual([null, null, null]);
    expect(second?.id).toBe(first!.id);
  });
});

describe("Claude's question over its task list", () => {
  // live-captured shape from Claude Code 2.1.289: the task list stays under the open panel,
  // after a rule that carries the session's name
  const question = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ 방향 검토  ☐ 문구  ✔ Submit  →

검토용 목업 페이지를 만들까요?

❯ 1. 만들지 않음 (Recommended)
     조건과 문구만 바뀌어 테스트로 확인 가능.
  2. 만듦
     목업으로 먼저 보고 확정한 뒤 구현.
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;
  const tasks = (rows: string) => `──────────────────────────────────────────────────────────────────────────────────────────────── 세션 이름 ─

${rows}
`;

  test("reads the question under the session's rule, with or without the task list", () => {
    for (const rows of [
      "",
      "  3 tasks (0 done, 3 open)\n  ◻ 준비\n  ◻ 구현\n  ◻ 검증",
      "  5 tasks (1 done, 1 in progress, 3 open)\n  ◼ 구현\n    Running tests…\n  ✔ 준비\n  ◻ 검증\n   … +2 pending",
    ]) {
      expect(parseInteractivePrompt("claude", question + tasks(rows))).toMatchObject({
        kind: "question", title: "방향 검토 · 1 of 2", question: "검토용 목업 페이지를 만들까요?",
        options: [{ label: "만들지 않음 (Recommended)" }, { label: "만듦" }], custom_option_index: 2,
      });
    }
  });

  test("does not take an answered form above later output and the task list for an open one", () => {
    const later = question + "\n⏺ 만들지 않음으로 진행합니다.\n\n────────\n❯ \n────────\n  ⏵⏵ bypass permissions on\n" + tasks("  3 tasks (0 done, 3 open)\n  ◻ 준비");
    expect(parseInteractivePrompt("claude", later)).toBeNull();
  });

  test("keeps output that ends in … after the list: only an in-progress task's activity is the list's", () => {
    const after = question + tasks("  3 tasks (0 done, 3 open)\n  ◻ 준비") + "⏺ Done…\n";
    expect(parseInteractivePrompt("claude", after)).toBeNull();
  });

  test("does not take an answered form for an open one when the agent's own lines follow the task header", () => {
    // the old panel is still in the buffer; the agent went on and the input line is the user's again
    const after = question + "\n  3 tasks (0 done, 3 open)\n● Continuing with the first option…\n❯ Explain the remaining work…\n";
    expect(parseInteractivePrompt("claude", after)).toBeNull();
  });

  test("does not take an answered form for an open one when output sits between the panel and the task list", () => {
    const after = question + "\n⏺ 만들지 않음으로 진행합니다.\n" + tasks("  3 tasks (0 done, 3 open)\n  ◻ 준비");
    expect(parseInteractivePrompt("claude", after)).toBeNull();
  });

  test("does not take a rule of another program under the panel for Claude's own", () => {
    expect(parseInteractivePrompt("claude", question + "\n⏺ Done.\n──── user@host:~/project ─\n")).toBeNull();
  });
});

describe("Claude's held message", () => {
  // Claude Code 2.1.294, live: a pasted message with a zero-width space, after its Enter
  const rule = "─".repeat(80);
  const held = (box: string, footer = "  [Haiku 4.5] │ project\n  ⏸ manual mode on") => `
 ▐▛███▜▌   Claude Code v2.1.294
${" ".repeat(40)}Removed 1 invisible character · review and press Enter to send
${rule}
${box}
${rule}
${footer}
`;

  test("shows the message Claude holds, with Send and Discard", () => {
    const prompt = parseInteractivePrompt("claude", held("❯ helloworld test"))!;
    expect(prompt).not.toBeNull();
    expect(prompt.title).toBe("Claude Code removed 1 invisible character");
    expect(prompt.body).toBe("helloworld test");
    expect(prompt.options.map((option) => option.label)).toEqual(["Send", "Discard"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["ctrl+c"] }]);
  });

  test("keeps a held message of several lines whole, and counts the characters", () => {
    const screen = held("❯ first line\n  second line").replace("Removed 1 invisible character", "Removed 3 invisible characters");
    const prompt = parseInteractivePrompt("claude", screen)!;
    expect(prompt.title).toBe("Claude Code removed 3 invisible characters");
    expect(prompt.body).toBe("first line\nsecond line");
  });

  test("knows a held message without the hint, by what the chat just sent", () => {
    // a turn's status line took the hint's row: only the box says it, and only to the one who sent it
    const screen = held("\u276f timingtest").replace(/.*Removed 1 invisible character.*\n/, "  \u273b Cooked for 1s \u00b7 done 5:23 PM\n");
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
    const prompt = parseInteractivePrompt("claude", screen, null, true, [], "timing\u200btest")!;
    expect(prompt.title).toBe("Claude Code removed 1 invisible character");
    expect(prompt.body).toBe("timingtest");
    // a box that differs in anything visible is the user's own draft
    expect(parseInteractivePrompt("claude", screen, null, true, [], "timing\u200btests")).toBeNull();
    expect(parseInteractivePrompt("claude", screen, null, true, [], "timingtest")).toBeNull();
  });

  test("counts only invisible characters as removed, a wrapped box aside", () => {
    expect(removedInvisible("a\u200bb\u2060c\ufeff", "abc")).toBe(3);
    expect(removedInvisible("long message here", "long mess\nage here")).toBe(0);
    expect(removedInvisible("abc", "abd")).toBe(0);
    expect(removedInvisible("ab\u200bc", "ab")).toBe(0);
    expect(removedInvisible("\ud55c\u3164\uae00", "\ud55c\uae00")).toBe(1);
  });

  test("offers no Discard while Claude works: its Ctrl+C would interrupt the turn", () => {
    // Claude Code 2.1.294, live: Ctrl+C under a running turn answers "Interrupted" and leaves the box as it was
    const prompt = parseInteractivePrompt("claude", held("❯ helloworld test"), null, true, [], null, true)!;
    expect(prompt.body).toBe("helloworld test");
    expect(prompt.options.map((option) => option.label)).toEqual(["Send"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { option_index: 1 })).toThrow();
  });

  test("is gone once the input is empty, and never reads the hint off a quoted screen", () => {
    // sent or discarded: the hint stays over an empty input
    expect(parseInteractivePrompt("claude", held("❯"))).toBeNull();
    // output under the box is not Claude's footer: the hint is quoted, not live
    expect(parseInteractivePrompt("claude", held("❯ hi", `  footer\n${rule}\n❯ another box`))).toBeNull();
    // the same words not over an input box
    expect(parseInteractivePrompt("claude", "Removed 1 invisible character · review and press Enter to send\nsome output\n")).toBeNull();
  });
});

describe("Claude's unnumbered menus", () => {
  // Claude Code 2.1.285 on a folder it has not seen, as herdr's pane read shows it (live)
  const trust = (selected: 0 | 1 = 0, after = "") => `
❯ claude --model claude-haiku-4-5-20251001

────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/projects/new-app

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this folder

 Enter to confirm · Esc to cancel
${after}`;

  test("reads the folder-trust check as a menu with its question and both rows", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(prompt).not.toBeNull();
    expect(prompt.kind).toBe("menu");
    expect(prompt.title).toBe("Accessing workspace");
    expect(prompt.question).toBe("Is this a project you created or one you trust?");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(prompt.body).toContain("Claude Code'll be able to read, edit, and execute files here.");
  });

  test("answers from the native cursor, and keeps its id when only the cursor moves", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    const moved = parseInteractivePrompt("claude", trust(1))!;
    expect(moved.id).toBe(prompt.id);
    expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { custom_text: "maybe" })).toThrow();
  });

  test("is gone once the menu is answered and Claude draws under it", () => {
    expect(parseInteractivePrompt("claude", trust(1, " ▐▛███▛█   Claude Code v2.1.285\n❯ Try \"fix typecheck errors\"\n"))).toBeNull();
  });

  test("keeps a label a narrow pane wrapped as one row", () => {
    // 24 columns: the panel's sentences and the second row both reach the edge and wrap
    const narrow = (selected: 0 | 1) => `
 Accessing workspace:

 Quick safety check: Is
 this a project you
 created or one you
 trust?

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this
   folder

 Enter to confirm · Esc
 to cancel
`;
    const prompt = parseInteractivePrompt("claude", narrow(0))!;
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(labels(parseInteractivePrompt("claude", narrow(1)))).toEqual(["No, exit", "Yes, I trust this folder"]);
  });

  test("never takes the next row for a wrapped label when a row is the widest line", () => {
    // nothing else on screen reaches as far as the first row, so it says nothing of the pane's
    // width: the line under it may be its tail or the next row, and a guess answers the wrong row
    const two = (selected: 0 | 1) => `
 Trust?

 ${selected === 0 ? "❯" : " "} Yes, trust this folder and continue
 ${selected === 1 ? "❯" : " "} No, exit

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", two(0))).toBeNull();
    // with the cursor on it, the second line is a row for certain
    expect(labels(parseInteractivePrompt("claude", two(1)))).toEqual(["Yes, trust this folder and continue", "No, exit"]);
    // merged, this would show two options and answer the second with one Down, the real `Yes`
    const three = `
 Trust?

 ❯ No, exit and keep this folder untrusted
   Yes
   Yes, and allow hooks too

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", three)).toBeNull();
    const panel = ` Trust? The first row is not the widest line here, so this one tells the width.\n${three.slice(" Trust?\n".length + 1)}`;
    const prompt = parseInteractivePrompt("claude", panel);
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes", "Yes, and allow hooks too"]);
    expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("leaves numbered rows and a menu without one selected row to the other readers", () => {
    expect(parseInteractivePrompt("claude", "Pick one\n\n❯ 1. First\n  2. Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
    expect(parseInteractivePrompt("claude", "Pick one\n\n  First\n  Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
  });
});

describe("OmO's ask_user_question form", () => {
  // omo 5.1.7 in a 120-column herdr pane, as herdr reads it: the overlay between two rules, then
  // omo's footer. herdr labels the pane `pi` while omo waits on it.
  const rule = "─".repeat(120);
  const footer = `${rule}\n/private/tmp/omo-ask${" ".repeat(74)}[----------] 42K/1M (4.2%)\n${" ".repeat(86)}claude-opus-5-5 · high · OmO 5.1.7\n`;
  const form = (body: string) => `\n [표시 위치] [월 한도] wait for answer\n\n${rule}\n\n Ask user · 30m\n${body}\n${footer}`;
  const first = form(` → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여줄까요?
 → 1. 설정 > 음성 입력 (추천)
      오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여주고 OpenAI 사용량 페이지 링크를 붙입니다. 변경 범위가 가장 작습니
 다.
   2. 설정 + 사이드바 미터
      사이드바의 구독 사용량 미터 옆에 음성 항목도 넣습니다. 한눈에 보이지만 UI 변경이 커집니다.
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
`);

  test("reads the question asked now, its options and the form's steps", () => {
    const prompt = parseInteractivePrompt("pi", first);
    expect(prompt).toMatchObject({
      agent: "omo", kind: "question", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?",
      multi_select: false, custom_option_index: 2,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터"]);
    // a word the pane wrapped at its edge is one word again
    expect(prompt?.options[0]?.description).toEndWith("변경 범위가 가장 작습니다.");
    // navigation picks the option and moves on; a typed answer replaces one typed before
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt!, { custom_text: "둘 다" })).toEqual([
      { keys: ["backspace"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { text: "둘 다" }, { keys: ["enter"] },
    ]);
    expect(() => answerKeys(prompt!, { option_index: 2 })).toThrow("valid option index");
    // herdr may name the pane omo, or claude while omo's SDK child runs
    expect(parseInteractivePrompt("omo", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("claude", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("codex", first)).toBeNull();
  });

  test("marks answered questions and chosen options, and a new step is another card", () => {
    const second = form(`   표시 위치 ✓  → 월 한도 ✓    Submit
 월 사용 한도를 둘까요?
   1. 한도 없음
      경고만 표시합니다.
   2. 월 $5 한도 ✓
      넘으면 음성 입력을 막습니다.
 → Type your own answer...
 Submit (2/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
`);
    const prompt = parseInteractivePrompt("pi", second);
    expect(prompt).toMatchObject({ title: "Question 2 of 2", question: "월 사용 한도를 둘까요?" });
    expect(labels(prompt)).toEqual(["한도 없음", "월 $5 한도"]);
    expect(prompt?.steps?.map((step) => [step.answered, step.current])).toEqual([[true, false], [true, true]]);
    expect(prompt?.id).not.toBe(parseInteractivePrompt("pi", first)?.id);
    // the cursor is on the typed answer's row already
    expect(answerKeys(prompt!, { custom_text: "없음" })).toEqual([{ keys: ["backspace"] }, { keys: ["enter"] }, { text: "없음" }, { keys: ["enter"] }]);
  });

  test("answers a multiple choice afresh by navigation, then moves on with Tab", () => {
    const prompt = parseInteractivePrompt("pi", form(` → 검사    보고    Submit
 어떤 검사를 돌릴까요?
 → 1. Lint ✓
      빠른 정적 검사
   2. Tests
      단위 테스트
   3. Build
   Type your own answer...
 Submit (1/2 answered) — Enter toggles; Tab to Submit
 ↑↓ move  1-9 select  space toggle  enter toggle  tab next / Submit  c comment  esc cancel
`));
    expect(prompt).toMatchObject({ title: "Question 1 of 2", multi_select: true, custom_option_index: null });
    expect(labels(prompt)).toEqual(["Lint", "Tests", "Build"]);
    expect(prompt?.options[2]?.description).toBeNull();
    // Backspace clears what was chosen before (Lint here, or rows out of view), then each number toggles one
    expect(answerKeys(prompt!, { option_indices: [2, 0] })).toEqual([{ keys: ["backspace"] }, { keys: ["space"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["tab"] }]);
    expect(answerKeys(prompt!, { option_indices: [1] })).toEqual([{ keys: ["backspace"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["tab"] }]);
  });

  test("reviews the answers: Submit, a row to change, or a comment", () => {
    const review = (rows: string, hint: string) => form(`   표시 위치 ✓    월 한도 ✓  → Submit
 Review your answers
${rows}

 Comment (optional; unanswered questions are reported)
>
 Submit (2/2 answered)
 ${hint}
`);
    const onComment = parseInteractivePrompt("pi", review("   표시 위치: 설정 > 음성 입력 (추천)\n   월 한도: 월 $5 한도", "enter submit  ↑ review answers  shift+tab back  tab next question  esc back"));
    expect(onComment).toMatchObject({
      kind: "menu", title: "Review your answers", question: "Submit (2/2 answered)", body: null, custom_option_index: 3,
      steps: [{ label: "표시 위치", answered: true, current: false }, { label: "월 한도", answered: true, current: false }],
    });
    expect(labels(onComment)).toEqual(["Submit", "표시 위치: 설정 > 음성 입력 (추천)", "월 한도: 월 $5 한도", "Comment (optional; unanswered questions are reported)"]);
    expect(answerKeys(onComment!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(onComment!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(onComment!, { custom_text: "급해요" })).toEqual([{ text: "급해요" }, { keys: ["enter"] }]);
    expect(() => answerKeys(onComment!, { option_index: 3 })).toThrow("valid option index");

    const onRow = parseInteractivePrompt("pi", review("   표시 위치: 설정 > 음성 입력 (추천)\n → 월 한도: 월 $5 한도", "enter edit answer  ↑↓ move  tab next question  esc back"));
    expect(onRow?.id).toBe(onComment?.id);
    expect(answerKeys(onRow!, { option_index: 0 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(onRow!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(onRow!, { custom_text: "급해요" })).toEqual([{ keys: ["down"] }, { text: "급해요" }, { keys: ["enter"] }]);
  });

  test("joins what a narrow pane wraps, the tab bar, the hint and words cut at the edge", () => {
    // omo's own renderer at 40 columns
    const narrow = `${"─".repeat(40)}

 Ask user
 → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여
 줄까요?
 → 1. 설정 > 음성 입력 (추천)
      오늘, 이번 달, 누적의 분·횟수·추
 정 비용을 보여줍니다.
   2. 설정 + 사이드바 미터
      한눈에 보이지만 UI 변경이 커집니
 다.
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select
 enter next  tab next question  c
 comment  esc cancel

${"─".repeat(40)}
`;
    const prompt = parseInteractivePrompt("pi", narrow);
    expect(prompt?.question).toBe("음성 사용량과 추정 비용을 어디에 보여줄까요?");
    expect(prompt?.options.map((option) => option.description)).toEqual(["오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여줍니다.", "한눈에 보이지만 UI 변경이 커집니다."]);
  });

  test("is no card once output has followed the form", () => {
    const later = first.replace(footer, `${Array.from({ length: 12 }, (_, index) => ` line ${index}`).join("\n")}\n${footer}`);
    expect(parseInteractivePrompt("pi", later)).toBeNull();
  });

  // The form's text on a screen that is not omo's live form: printed in a shell, or quoted in
  // Claude's transcript. A card there would type its answer into that program. Each is tried as
  // the form alone and with the rule and footer omo drew under it.
  const printed = [first.replace(footer, ""), first];
  const claudeBox = `\n${rule}\n❯ \n${rule}\n  ? for shortcuts\n`;
  const agents = ["", "pi", "omo", "claude"];

  test("is no card for the form's text printed in a shell, its prompt below", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text}user@host:~/project$ `)).toBeNull();
    }
  });

  test("is no card for the form's text in a shell with output after it", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text} M server/prompt.ts\n M CHANGELOG.md\n 2 files changed\n`)).toBeNull();
    }
  });

  test("is no card for the form's text in Claude's transcript, over Claude's input box", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text}${claudeBox}`)).toBeNull();
    }
  });

  test("is no card for the form's text quoted (indented) in Claude's transcript", () => {
    for (const text of printed) {
      const quoted = text.split("\n").map((line) => line ? `  ${line}` : line).join("\n");
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${quoted}${claudeBox}`)).toBeNull();
    }
  });

  test("needs the session's matching call when the pane is not known to wait on the user", () => {
    // what the server asks for a pane herdr names claude, or not at all, that is not blocked
    expect(parseInteractivePrompt("", first, null, false)).toBeNull();
    expect(parseInteractivePrompt("claude", first, null, false)).toBeNull();
    const ask = { questions: ["표시 위치", "월 한도"].map((header) => ({
      header, question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", multiSelect: false, options: [{ label: "설정 > 음성 입력 (추천)", description: null }, { label: "설정 + 사이드바 미터", description: null }],
    })) };
    expect(parseInteractivePrompt("", first, ask, false)).toMatchObject({ title: "Question 1 of 2" });
    // another form's call is no evidence
    ask.questions[1]!.header = "다른 질문";
    expect(parseInteractivePrompt("claude", first, ask, false)).toBeNull();
  });

  // omo's session file for the form below: the ask_user_question call, then (once answered) its result
  const call = {
    questions: [
      { header: "표시 위치", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", options: [
        { label: "설정 > 음성 입력 (추천)", description: "오늘, 이번 달, 누적을 보여줍니다." },
        { label: "설정 + 사이드바 미터", description: "한눈에 보이지만 UI 변경이 커집니다." },
        { label: "상단 상태 표시줄", description: "항상 보입니다." },
        { label: "표시하지 않음" },
      ] },
      { header: "월 한도", question: "월 사용 한도를 둘까요?", options: [{ label: "한도 없음" }, { label: "월 $5 한도" }] },
    ],
    waitForAnswer: true,
  };
  const record = (message: unknown) => JSON.stringify({ type: "message", message });
  const asking = [
    record({ role: "user", content: [{ type: "text", text: "ask me" }] }),
    record({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask_user_question", arguments: call }] }),
  ].join("\n");
  // omo's own renderer at 60 columns, in a pane too short for the whole form
  const rule60 = "─".repeat(60);

  test("finds the call omo's session waits on", () => {
    const ask = pendingOmoAsk(asking);
    expect(ask?.questions.map((question) => [question.header, question.options.length, question.multiSelect])).toEqual([["표시 위치", 4, false], ["월 한도", 2, false]]);
    expect(ask?.questions[0]!.options[3]).toEqual({ label: "표시하지 않음", description: null });
    // answered, the agent moved on, or not the shape omo asks with
    expect(pendingOmoAsk(`${asking}\n${record({ role: "toolResult", toolCallId: "call-1", content: [] })}`)).toBeNull();
    expect(pendingOmoAsk(`${asking}\n${record({ role: "assistant", content: [{ type: "text", text: "done" }] })}`)?.id).toBe("call-1");
    expect(pendingOmoAsk(asking.replace('"questions"', '"items"'))).toBeNull();
    // a tail read from inside a record
    expect(pendingOmoAsk(`ge":{"role":"user"}}\n${asking}`)?.questions).toHaveLength(2);
  });

  test("takes the form's text from the session's call, the screen telling where it stands", () => {
    const short = `      한눈에 보이지만 UI 변경이 커집니다.
   3. 상단 상태 표시줄
      항상 보입니다.
   4. 표시하지 않음
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next
 question  c comment  esc cancel

${rule60}
`;
    // the title, the tabs and the question are above the pane's top
    expect(parseInteractivePrompt("pi", short)).toBeNull();
    const prompt = parseInteractivePrompt("pi", short, pendingOmoAsk(asking));
    expect(prompt).toMatchObject({
      title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", custom_option_index: 4,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터", "상단 상태 표시줄", "표시하지 않음"]);
    expect(prompt?.options[0]?.description).toBe("오늘, 이번 달, 누적을 보여줍니다.");
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([...Array.from({ length: 5 }, () => ({ keys: ["up"] })), { keys: ["enter"] }]);
    // the cursor's row is out of view: to the typed answer's row from the top, where ↑ stops
    expect(answerKeys(prompt!, { custom_text: "둘 다" })).toEqual([
      { keys: ["backspace"] }, ...Array(5).fill({ keys: ["up"] }), ...Array(4).fill({ keys: ["down"] }), { keys: ["enter"] },
      { text: "둘 다" }, { keys: ["enter"] },
    ]);
    // rows that are not the call's question's are no card
    expect(parseInteractivePrompt("pi", short, { questions: [pendingOmoAsk(asking)!.questions[1]!] })).toBeNull();

    // with the whole form in view the call's text wins over the pane's wrap; another call is ignored
    const ask = pendingOmoAsk(asking.replaceAll("상단 상태 표시줄", "x").replace("오늘, 이번 달, 누적을 보여줍니다.", "원문 설명"))!;
    ask.questions[0]!.options.splice(2);
    expect(parseInteractivePrompt("pi", first, ask)?.options[0]?.description).toBe("원문 설명");
    ask.questions[1]!.header = "다른 질문";
    expect(parseInteractivePrompt("pi", first, ask)?.options[0]?.description).toEndWith("가장 작습니다.");
  });

  test("offers to save or discard an answer typed in the terminal", () => {
    const typing = `      항상 보입니다.
   4. 표시하지 않음
   Type your own answer...
 Your answer (enter to save, ↑↓ back to options, esc to
 discard)
> 안녕
 Submit (0/2 answered) — Enter advances
 enter save and next  ↑↓ back to options  tab next question
   esc discard

${rule60}
`;
    const prompt = parseInteractivePrompt("pi", typing, pendingOmoAsk(asking));
    expect(prompt).toMatchObject({ kind: "menu", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", custom_option_index: null });
    expect(prompt?.options).toEqual([{ label: "Save the typed answer", description: "안녕" }, { label: "Discard it", description: null }]);
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
    // the whole form in view needs no session
    const whole = form(` → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여줄까요?
   1. 설정 > 음성 입력 (추천)
   Type your own answer...
 Your answer (enter to save, ↑↓ back to options, esc to discard)
> 안녕
 Submit (0/2 answered) — Enter advances
 enter save and next  ↑↓ back to options  tab next question  esc discard
`);
    expect(parseInteractivePrompt("pi", whole)).toMatchObject({ title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?" });
  });

  test("reviews the answers of a form whose rows are out of view, by the call's headers", () => {
    const short = `
 Comment (optional; unanswered questions are reported)
>
 Submit (2/2 answered)
 enter submit  ↑ review answers  shift+tab back  tab next
 question  esc back

${rule60}
`;
    expect(parseInteractivePrompt("pi", short)).toBeNull();
    const prompt = parseInteractivePrompt("pi", short, pendingOmoAsk(asking));
    expect(labels(prompt)).toEqual(["Submit", "표시 위치", "월 한도", "Comment (optional; unanswered questions are reported)"]);
    expect(prompt?.steps?.every((step) => step.answered && !step.current)).toBeTrue();
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  // the same call asked without waiting: omo accepts it at once and folds it into a widget
  const accepted = (id: string) => record({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "Question accepted; the answer will arrive as a user message." }], details: { accepted: true, status: "pending" }, isError: false });
  const asyncAsking = `${asking.replace('"waitForAnswer":true', '"waitForAnswer":false')}\n${accepted("call-1")}\n${record({ role: "assistant", content: [{ type: "text", text: "meanwhile" }], stopReason: "stop" })}`;

  test("keeps a call asked without waiting open until it is settled", () => {
    expect(openOmoAsks(asyncAsking).map((ask) => [ask.questions[0]!.header, ask.wait])).toEqual([["표시 위치", false]]);
    expect(pendingOmoAsk(asyncAsking)?.questions).toHaveLength(2);
    const settlement = JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: "call-1", status: "answered" } });
    expect(openOmoAsks(`${asyncAsking}\n${settlement}`)).toEqual([]);
    expect(openOmoAsks(`${asyncAsking}\n${record({ role: "user", content: [{ type: "text", text: "[Answer to question call-1]\n표시 위치: 설정" }] })}`)).toEqual([]);
    // refused: the result is an error, and nothing is left open
    const refused = asyncAsking.replace(accepted("call-1"), record({ role: "toolResult", toolCallId: "call-1", content: [], details: {}, isError: true }));
    expect(openOmoAsks(refused)).toEqual([]);
  });

  // omo 5.1.19's widget for it at 120 columns, over its empty input box and its footer
  const widget = (box = "❯", after = "") => `● meanwhile

? Question pending (2 unanswered) · 30m
  표시 위치 — 음성 사용량과 추정 비용을 어디에 보여줄까요?
[ 설정 > 음성 입력 (추천) ]  [ 설정 + 사이드바 미터 ]  [ 상단 상태 표시줄 ]  [ 표시하지 않음 ]  [ own answer… ]
+1 more question
enter to answer · /answer · or just type your reply

 Todo
 [•] 사용량 표시
── • Running eval (3s • esc to interrupt) ${"─".repeat(80)}
${box}
${rule}${after}
~/work • main • 321K/1M (32.1%) (auto)                                         claude-opus-5-5:high
(😺 OmO Native) 🤖 2 mem just now
`;

  test("reads the widget of a question asked without waiting, by the session's open call", () => {
    const open = openOmoAsks(asyncAsking);
    // herdr may name the pane claude and report it at work: the session's open call is the evidence
    const prompt = parseInteractivePrompt("claude", widget(), null, false, open);
    expect(prompt).toMatchObject({
      agent: "omo", kind: "question", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?",
      multi_select: false, custom_option_index: 4,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터", "상단 상태 표시줄", "표시하지 않음"]);
    // a pending card validates answers but emits no steps until its form is opened and checked
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([]);
    expect(answerKeys(prompt!, { custom_text: "둘 다 보여줘" })).toEqual([]);
    for (const text of ["1", "2 please", "/answer", "!ls"]) expect(answerKeys(prompt!, { custom_text: text })).toEqual([]);
    // the second question, shown once the first has its answer
    const second = widget().replace("(2 unanswered)", "(1 unanswered)").replace(/  표시 위치 — .*\n\[.*\n\+1 more question\n/, "  월 한도 — 월 사용 한도를 둘까요?\n[ 한도 없음 ]  [ 월 $5 한도 ]  [ own answer… ]\n");
    expect(parseInteractivePrompt("claude", second, null, false, open)).toMatchObject({
      title: "Question 2 of 2", steps: [{ answered: true, current: false }, { answered: false, current: true }],
    });
  });

  test("no card for the widget without an open call, with text in the box, or with output under it", () => {
    const open = openOmoAsks(asyncAsking);
    expect(parseInteractivePrompt("claude", widget(), null, false, [])).toBeNull();
    // a call that waits has its form, never this widget
    expect(parseInteractivePrompt("claude", widget(), null, false, openOmoAsks(asking))).toBeNull();
    // a number typed now would join the text
    expect(parseInteractivePrompt("claude", widget("❯ 둘 다"), null, false, open)).toBeNull();
    expect(parseInteractivePrompt("claude", widget("❯", "\n$ echo after"), null, false, open)).toBeNull();
    expect(parseInteractivePrompt("claude", `${widget()}$ \n`, null, false, open)).toBeNull();
    expect(parseInteractivePrompt("claude", `${widget()}λ \n`, null, false, open)).toBeNull();
  });
});

describe("Claude's suggested next prompt", () => {
  // Claude Code 2.1.284 as herdr reads it with ANSI: the grey suggestion in the empty input box
  const RULE = "\u001b[0m\u001b[38;2;136;136;136m" + "─".repeat(60) + "\u001b[0m";
  const screen = (input: string, below = RULE) => [
    "\u001b[0m\u001b[38;2;255;255;255m● \u001b[0m표본 수집이 끝나면 알림이 오도록 걸어 두었습니다.",
    "",
    "\u001b[0m\u001b[38;2;153;153;153m✻ Worked for 2m 14s · done 오후 4:16\u001b[0m",
    RULE,
    input,
    below,
    "  \u001b[0m\u001b[38;5;6m[Opus 5.5 (1M context)]\u001b[0m\u001b[38;2;153;153;153m │ \u001b[0m\u001b[2m\u001b[38;2;153;153;153m⏱️  25h\u001b[0m",
    "  \u001b[0m\u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[0m",
  ].join("\r\n");

  test("reads the grey text in the empty input box", () => {
    expect(parseClaudeSuggestion(screen("❯\u00a0\u001b[0m\u001b[2m아직 진행중이야?\u001b[0m"))).toBe("아직 진행중이야?");
    // dim set together with a color, in one sequence
    expect(parseClaudeSuggestion(screen("❯ \u001b[2;38;5;8mrun the tests again\u001b[0m"))).toBe("run the tests again");
  });

  test("nothing while text is typed, the box is empty, or it holds Claude's tip", () => {
    expect(parseClaudeSuggestion(screen("❯\u00a0아직 진행중이야?"))).toBeNull();
    // typed text right after a grey remainder is still typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[2m아직\u001b[0m 진행중"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯\u00a0"))).toBeNull();
    expect(parseClaudeSuggestion(screen('❯ \u001b[2mTry "how does <filepath> work?"\u001b[0m'))).toBeNull();
  });

  test("a truecolor foreground is not dim: its 2 is the color mode", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[38;2;153;153;153mnot a suggestion\u001b[0m"))).toBeNull();
  });

  test("only the input box: not a ❯ line without its rules, nor a box of several lines", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mfirst line\u001b[0m", "  \u001b[2msecond line\u001b[0m"))).toBeNull();
    expect(parseClaudeSuggestion("❯ \u001b[2mloose text\u001b[0m\nmore")).toBeNull();
  });

  test("only the live input box, the bottom one: not an earlier box above a bash-mode input", () => {
    const below = RULE + "\r\n\u001b[38;2;255;255;255m● quoted output\u001b[0m\r\n" + RULE + "\r\n! ls\r\n" + RULE;
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mrun deploy --prod\u001b[0m", below))).toBeNull();
  });

  test("Claude's own drawn cursor on the first grey character", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m\u001b[2mun the tests\u001b[22m"))).toBe("run the tests");
    // a typed character under that cursor, with nothing grey after it, is typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27mun"))).toBeNull();
  });
});

describe("the fallback card for a blocked pane no reader knows", () => {
  test("offers a numbered menu at the screen's end as options answered by their number", () => {
    const prompt = parseFallbackPrompt("gjc", `
 Apply these 3 file changes?
 src/a.ts, src/b.ts, src/c.ts

 › 1. Apply all
   2. Review each
   3. Discard

 ↵ choose · esc back
`);
    expect(prompt.kind).toBe("menu");
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe("Apply these 3 file changes?");
    expect(prompt.body).toBe("src/a.ts, src/b.ts, src/c.ts");
    expect(labels(prompt)).toEqual(["Apply all", "Review each", "Discard", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ text: "3" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "1" }]);
    expect(() => answerKeys(prompt, { custom_text: "no" })).toThrow();
  });

  test("offers Enter and Esc after the rows, for a program that reads a whole line", () => {
    const prompt = parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n\nEnter a number >\n");
    expect(labels(prompt)).toEqual(["Work", "Home", "Enter", "Esc"]);
    // the number goes alone; the Enter that submits it is its own tap
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["esc"] }]);
  });

  test("reads GJC's unnumbered selection rows and answers with cursor navigation", () => {
    // gjc v0.18.7's custom-provider selector: active row uses the navigation cursor, other rows
    // start with two spaces, and the footer names Up/Down, Enter, and Esc.
    const compatibility = (selected: 0 | 1) => `
Step 1: Compatibility

${selected === 0 ? "❯" : " "} OpenAI-compatible
${selected === 1 ? "❯" : " "} Anthropic-compatible
[↑↓ to navigate, Enter to select, Esc to cancel]
`;
    const prompt = parseFallbackPrompt("gjc", compatibility(0));
    expect(prompt.kind).toBe("menu");
    expect(prompt.fallback).toBe(true);
    expect(labels(prompt)).toEqual(["OpenAI-compatible", "Anthropic-compatible", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["esc"] }]);
    expect(parseFallbackPrompt("gjc", compatibility(1)).id).toBe(prompt.id);
    expect(parseFallbackPrompt("gjc", compatibility(1).replace("Anthropic-compatible", "Local endpoint")).id).not.toBe(prompt.id);

    const selectedSecond = parseFallbackPrompt("gjc", `
Step 4: Credential source

  Environment variable
❯ Paste API key
[↑↓ to navigate, Enter to select, Esc to go back]
`);
    expect(labels(selectedSecond)).toEqual(["Environment variable", "Paste API key", "Esc"]);
    expect(answerKeys(selectedSecond, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("reads GJC's standard and outlined question selectors", () => {
    for (const footer of [
      "up/down navigate  enter select  esc cancel",
      "up/down navigate  enter select  ←/→ question  esc cancel",
      "↑/↓ select  enter  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript",
      "↑/↓ select  enter  ←/→ question  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript",
    ]) {
      const screen = `Choose an approach\n\n──────────────\n│❯ First     │\n│  Second    │\n──────────────\n\n${footer}\n\n──────────────\n`;
      const prompt = parseFallbackPrompt("gjc", screen);
      expect(labels(prompt)).toEqual(["First", "Second", "Esc"]);
      expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
      expect(labels(parseFallbackPrompt("gjc", screen.replace("│  Second    │", "│  (1/12)    │")))).not.toContain("First");
      expect(labels(parseFallbackPrompt("gjc", `${screen}\n❯ message input\n`))).not.toContain("First");
    }
  });

  test("does not infer GJC choices without the exact footer, a selected row, or the GJC agent", () => {
    const footer = "[↑↓ to navigate, Enter to select, Esc to cancel]";
    const generic = ["↑", "↓", "Enter", "Esc"];
    expect(labels(parseFallbackPrompt("gjc", `Pick one:\n\nAlpha\nBeta\n${footer}\n`))).toEqual(generic);
    expect(labels(parseFallbackPrompt("gjc", `Pick one:\n❯ Alpha\n  Beta\n${footer}\n`))).toEqual(generic);
    expect(labels(parseFallbackPrompt("gjc", `Pick one:\n❯ Alpha\n  Beta\n↑/↓ to move · Enter to choose · Esc to cancel\n`))).toEqual(generic);
    expect(labels(parseFallbackPrompt("claude", `Pick one:\n\n❯ Alpha\n  Beta\n${footer}\n`))).toEqual(generic);
  });

  test("titles a GJC selector with its own heading, not an earlier question on the screen", () => {
    const prompt = parseFallbackPrompt("gjc", "Delete your project?\nDone, it is kept.\n\nChoose a provider\n\n❯ Alpha\n  Beta\n[↑↓ to navigate, Enter to select, Esc to cancel]\n");
    expect(prompt.question).toBe("Choose a provider");
    expect(labels(prompt)).toEqual(["Alpha", "Beta", "Esc"]);
    expect(parseFallbackPrompt("gjc", "Earlier text\n\nWhich one?\nPick the safe one\n\n❯ Alpha\n  Beta\n[↑↓ to navigate, Enter to select, Esc to cancel]\n").question).toBe("Which one?");
  });

  test("answers a GJC selector whose labels start with numbers by moving, never by typing a number", () => {
    const prompt = parseFallbackPrompt("gjc", "Choose an approach\n\n❯ 1. Keep branch\n  2. Delete branch\nup/down navigate  enter select  esc cancel\n");
    expect(labels(prompt)).toEqual(["1. Keep branch", "2. Delete branch", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("joins the lines the last row wraps onto into its label", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit\n  2. Yes, trust folder and\n     allow all commands without asking\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, trust folder and allow all commands without asking", "Enter", "Esc"]);
  });

  test("reads no menu when the last row's wrapped label ends in its own letter key", () => {
    const prompt = parseFallbackPrompt("gjc", "Access?\n1. Read only\n2. Full access, every file and\n   command (f)\n\nEnter to select\n");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    // or ends the row's first line, a description wrapped under it
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Full access (f)\n   Allows writing to every file\n\nType f, then Enter\n"))).toEqual(["Enter", "Esc"]);
  });

  test("takes the last line for a hint only when it names a way to choose", () => {
    const menu = (hint: string) => labels(parseFallbackPrompt("gjc", `Pick one:\n1. Alpha\n2. Beta\n\n${hint}\n`));
    // a plain Enter or Press asks for something else: a digit typed there is no answer
    for (const hint of ["Enter recovery code", "Enter your password", "Enter your phone number", "Press any key", "Enter to continue"]) {
      expect(menu(hint)).toEqual(["Enter", "Esc"]);
    }
    expect(labels(parseFallbackPrompt("gjc", "1. A\n2. B\nEnter recovery code\n"))).toEqual(["Enter", "Esc"]);
    for (const hint of ["Enter to select", "↵ choose · esc back", "Enter to confirm · Esc to cancel", "Enter a number", "Type 1-2", "↑/↓ to move", "Tab/arrows to navigate"]) {
      expect(menu(hint)).toEqual(["Alpha", "Beta", "Enter", "Esc"]);
    }
  });

  test("reads no menu unless its hint is the screen's last line, with only the last row's wrap above it", () => {
    // a new prompt under the hint takes what is typed now: a digit there is no menu answer
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\nEnter to select\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\n\nEnter to select\nWaiting for the token\n"))).toEqual(["Enter", "Esc"]);
    // a line under the last row, not indented past its number, is not its wrap
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n  1. Read only\n  2. Full access\n  Saved.\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
    // nor a hint inside the last row's wrap, with a new prompt under it
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Read settings\n2. Load profiles\n   Profiles loaded\n   Enter to continue\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    // nor an input field there, or more output than a wrapped label
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Authentication required\n   Password:\nEnter password and press Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Connected to example.com\n   Authentication required\n   Waiting\nEnter to continue\n"))).toEqual(["Enter", "Esc"]);
    // a wrapped label's own words are no hint
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Allow access to the\n   selected account number only\n\nEnter to select\n"))).toEqual(["Cancel", "Allow access to the selected account number only", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Where?\n1. Here\n2. Allow the agent to\n   choose a directory\n\nEnter to select\n"))).toEqual(["Here", "Allow the agent to choose a directory", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Retry?\n1. Never\n2. Retry with a maximum\n   attempt count: 3\n\nEnter to select\n"))).toEqual(["Never", "Retry with a maximum attempt count: 3", "Enter", "Esc"]);
    // a hint right under the last row, indented like its wrap, is still the hint
    expect(labels(parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n   Enter a number >\n"))).toEqual(["Work", "Home", "Enter", "Esc"]);
  });

  test("keeps a wrapped label on its own row, since each row starts with its number", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit and keep this folder\n     untrusted\n  2. Yes, trust folder\n  3. Yes, trust and allow hooks\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes, trust folder", "Yes, trust and allow hooks", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
  });

  test("guesses no options for an unnumbered menu, offering the keys its hint names", () => {
    const prompt = parseFallbackPrompt("claude", "Continue?\n\n  Yes\n❯ No\n  Later\n\n ↑/↓ to move · Enter to choose\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Continue?");
    expect(labels(prompt)).toEqual(["↑", "↓", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }]);
  });

  test("reads no menu once a new prompt or input box follows it", () => {
    const done = parseFallbackPrompt("claude", "Pick one\n\n  1. Deny\n❯ 2. Allow\n\n● Done.\n❯ \n");
    expect(labels(done)).toEqual(["Enter", "Esc"]);
    const quoted = parseFallbackPrompt("claude", "> quoted example\n❯ Deny\n  Allow all\n");
    expect(labels(quoted)).toEqual(["Enter", "Esc"]);
  });

  test("reads a numbered list as no menu without a hint to choose, or before an input field", () => {
    expect(labels(parseFallbackPrompt("gjc", "My plan:\n\n1. Inspect files\n2. Remove backups\n\nPassword:\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. A\n2. B\nEnter a number\nChoice: 2\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Read only (r)\n2. Full access (f)\nType r or f, then Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick\n1. One\n❯ \n2. Two\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
  });

  test("offers no letters or arrows for an input box, a quote or a word", () => {
    expect(labels(parseFallbackPrompt("claude", 'The installer prints "Overwrite? (y/n)".\n❯ \n'))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Done.\n❯ Explain why the installer asks (y/n)\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Use arrow functions in the patch.\nArrowhead metadata loaded\n"))).toEqual(["Enter", "Esc"]);
  });

  test("without a menu, shows the screen's last lines and offers Enter and Esc", () => {
    const prompt = parseFallbackPrompt("codex", "Working on it\n\nPress any key to review the diff (q to quit)\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Press any key to review the diff (q to quit)");
    expect(prompt.body).toContain("Working on it");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
  });

  test("offers a (y/n) question at the screen's end as Yes and No, typing the letter alone", () => {
    const prompt = parseFallbackPrompt("gjc", " config.json already exists.\n Overwrite it? (y/n)\n Press Enter to keep it, or Esc to abort\n");
    expect(prompt.question).toBe("Overwrite it? (y/n)");
    expect(labels(prompt)).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "y" }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "n" }]);
    expect(labels(parseFallbackPrompt("gjc", "Delete the branch? [Y/n] "))).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
  });

  test("offers no letters for a (y/n) only mentioned above the prompt", () => {
    const prompt = parseFallbackPrompt("codex", 'The installer prints "Overwrite config? (y/n)".\nIt then exits.\n\n› Ask Codex to do anything\n  100% context left\n');
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("takes the question from the line that asks it, not the hint below", () => {
    const prompt = parseFallbackPrompt("gjc", "Found 3 stale caches.\nClear them now?\nPress Enter to continue, Esc to skip\n");
    expect(prompt.question).toBe("Clear them now?");
    expect(prompt.body).toBe("Found 3 stale caches.\nPress Enter to continue, Esc to skip");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("gives the same id to the same screen, and another to a changed one", () => {
    const screen = "Pick\n\n❯ 1. One\n  2. Two\n\n Enter to select\n";
    expect(parseFallbackPrompt("omo", screen).id).toBe(parseFallbackPrompt("omo", screen).id);
    expect(parseFallbackPrompt("omo", screen.replace("Two", "Three")).id).not.toBe(parseFallbackPrompt("omo", screen).id);
    const context = (command: string) => [`$ ${command}`, ...Array.from({ length: 14 }, (_, i) => `line ${i}`), "Run it?", "", "❯ 1. Yes", "  2. No", "", " Enter to select"].join("\n");
    expect(parseFallbackPrompt("gjc", context("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", context("rm safe.tmp")).id);
    const keys = (command: string) => [`$ ${command}`, ...Array.from({ length: 18 }, (_, i) => `line ${i}`), "Proceed? (y/n)"].join("\n");
    expect(parseFallbackPrompt("gjc", keys("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", keys("rm safe.tmp")).id);
    const footer = (end: string) => `Pick\n\n❯ 1. One\n  2. Two\n\n ${end}\n`;
    expect(parseFallbackPrompt("gjc", footer("Enter to select")).id).not.toBe(parseFallbackPrompt("gjc", footer("Enter to select · done")).id);
  });

  /** a numbered menu under the line an agent keeps showing while it waits */
  const underWorkingLine = (working: string, cursor = 0) => [
    working, "", "Run the tests?", "",
    ...["Yes", "No"].map((label, index) => `${index === cursor ? "❯" : " "} ${index + 1}. ${label}`),
    "", "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const idOf = (screen: string) => parseFallbackPrompt("claude", screen).id;

  test("keeps its id while only Claude's working line ticks", () => {
    // the spinner, the time and the token count move on every second; the prompt does not
    const first = parseFallbackPrompt("claude", underWorkingLine("✢ Tempering… (1m 55s · ↓ 10.0k tokens)"));
    expect(idOf(underWorkingLine("✻ Tempering… (1m 58s · ↓ 10.4k tokens)"))).toBe(first.id);
    expect(idOf(underWorkingLine("· Tempering… (2h 3m 1s · ↑ 1,204 tokens)"))).toBe(first.id);
    expect(idOf(underWorkingLine("* Running the tests… (5s · ↓ 12 tokens · esc to interrupt)"))).toBe(idOf(underWorkingLine("✶ Running the tests… (9s · ↓ 3.1k tokens · esc to interrupt)")));
    // the card shows the line as the screen has it
    expect(first.body).toBe("✢ Tempering… (1m 55s · ↓ 10.0k tokens)");
    // the keys card holds the line among its last ones, and as its question when nothing asks
    const keys = (working: string) => ["Apply the migration to the staging database", working, "Proceed? (y/n)"].join("\n");
    expect(idOf(keys("✢ Tempering… (5s · ↓ 1.0k tokens)"))).toBe(idOf(keys("✶ Tempering… (9s · ↓ 1.3k tokens)")));
    const asked = (working: string) => ["Pick one", "", "❯ 1. One", "  2. Two", working, "Enter to select"].join("\n");
    expect(idOf(asked("✢ Tempering… (5s · ↓ 1.0k tokens)"))).toBe(idOf(asked("✶ Tempering… (9s · ↓ 1.3k tokens)")));
  });

  test("makes another card of anything else that changed, on a working line too", () => {
    const working = "✢ Tempering… (5s · ↓ 1.0k tokens)";
    // what the agent is doing: the words stay in the id
    expect(idOf(underWorkingLine("✢ Deleting staging… (5s · ↓ 1.0k tokens)"))).not.toBe(idOf(underWorkingLine("✢ Deleting production… (5s · ↓ 1.0k tokens)")));
    // the row the cursor is on: Enter would pick another one
    expect(idOf(underWorkingLine(working, 0))).not.toBe(idOf(underWorkingLine(working, 1)));
    // the hint coming or going is a change of the line, once
    expect(idOf(underWorkingLine(working))).not.toBe(idOf(underWorkingLine("✢ Tempering… (5s · ↓ 1.0k tokens · esc to interrupt)")));
    // what is asked about, named above the lines the keys card shows, under a line that ticks
    const keys = (target: string, time: string) => [`Delete ${target}`, ...Array.from({ length: 15 }, (_, i) => `detail ${i}`), `✢ Tempering… (${time} · ↓ 1.0k tokens)`, "Proceed? (y/n)"].join("\n");
    expect(idOf(keys("staging", "5s"))).toBe(idOf(keys("staging", "9s")));
    expect(idOf(keys("staging", "5s"))).not.toBe(idOf(keys("production", "9s")));
  });

  test("reads a line that is not known to be Claude's working line to the letter", () => {
    const differ = (one: string, other: string, agent = "claude") =>
      expect(parseFallbackPrompt(agent, underWorkingLine(one)).id).not.toBe(parseFallbackPrompt(agent, underWorkingLine(other)).id);
    // a time in a command, in parentheses of another kind, or on a line with no spinner or no ellipsis
    differ("$ sleep 30s", "$ sleep 60s");
    differ("Waiting… (30s timeout)", "Waiting… (60s timeout)");
    differ("Tests passed (12s · 3 files)", "Tests passed (13s · 3 files)");
    differ("Tempering… (5s · ↓ 1.0k tokens)", "Tempering… (9s · ↓ 1.0k tokens)");
    differ("✢ Tempering (5s · ↓ 1.0k tokens)", "✢ Tempering (9s · ↓ 1.0k tokens)");
    // a duration that is offered, not one that has passed: nothing says tokens were used
    differ("* Restart service… (5s)", "* Restart service… (300s)");
    differ("✢ Restarting… (5s · downtime)", "✢ Restarting… (300s · downtime)");
    differ("✢ Tempering… (5s · esc to interrupt)", "✢ Tempering… (9s · esc to interrupt)");
    differ("• Restart service (5s · downtime)", "• Restart service (300s · downtime)");
    // an amount of tokens that is asked about: no arrow, or not on a working line
    differ("✢ Purchasing… (5s · 10 tokens)", "✢ Purchasing… (5s · 100000 tokens)");
    differ("• Purchase credits (5s · 10 tokens)", "• Purchase credits (5s · 100000 tokens)");
    differ("Budget: 10.0k tokens", "Budget: 90.0k tokens");
    // another program's working line, and Claude's line in a pane that does not run Claude
    differ("• Working (12s • esc to interrupt)", "• Working (47s • esc to interrupt)");
    differ("⠋ Thinking... (3s)", "⠹ Thinking... (9s)");
    differ("✢ Tempering… (5s · ↓ 1.0k tokens)", "✻ Tempering… (9s · ↓ 1.3k tokens)", "gjc");
  });

  test("tells the working line from a line that holds its blanked form as text", () => {
    // a fixture or a note about this very rule, shown on the screen: its text is what is asked about
    const about = (line: string) => ["Remove this exact line from the fixture?", line, "", "1. Yes", "2. No", "", "Enter a number, or Esc to cancel"].join("\n");
    expect(idOf(about("✢ Tempering… (55s · ↓ 10.0k tokens)"))).not.toBe(idOf(about("* Tempering… (<time> · <tokens>)")));
    expect(idOf(about("✢ Tempering… (55s · ↓ 10.0k tokens · esc to interrupt)"))).not.toBe(idOf(about("* Tempering… (<time> · <tokens> · esc to interrupt)")));
    // and from the same line one row further down
    const moved = (before: string[]) => [...before, "✢ Tempering… (55s · ↓ 10.0k tokens)", "", "1. Yes", "2. No", "", "Enter a number, or Esc to cancel"].join("\n");
    expect(idOf(moved(["Run it?"]))).not.toBe(idOf(moved(["Run it?", "Run it?"])));
  });

  test("keeps the marker of the selected row in the id, whatever the rows look like", () => {
    const rows = (selected: number, on: string, off: string, tail: string) =>
      ["Choose operation", ...["Delete all", "Cancel"].map((label, index) => `${index === selected ? on : off} ${label}${tail}`), "Use ↑/↓ then Enter"].join("\n");
    for (const [on, off, tail] of [
      ["•", "◦", " (5s · irreversible)"],
      ["*", "·", "…"],
      // rows that read like working lines: a spinner's frames as markers, an ellipsis and a time
      ["*", "·", "… (5s)"],
      // and with a token count: two lines of that shape are not one working line
      ["*", "·", "… (5s · ↓ 1.0k tokens)"],
    ] as const) {
      expect(idOf(rows(0, on, off, tail))).not.toBe(idOf(rows(1, on, off, tail)));
    }
  });
});

describe("Claude's suggestion on a prompt poll", () => {
  /** a herdr with one Claude pane whose ANSI reads never answer */
  async function stalledAnsiHerdr(status: string, run: (reads: string[]) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-suggestion-"));
    const path = join(root, "herdr.sock");
    const reads: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { format?: string } };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "session.snapshot") {
          return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "claude", agent_status: status }], layouts: [] } });
        }
        if (request.method !== "pane.read") throw new Error(`unexpected fixture RPC: ${request.method}`);
        reads.push(request.params.format ?? "");
        if (request.params.format === "text") answer({ read: { text: "Done.\n\n────────\n❯ \n────────\n" } });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(reads); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function poll(): Promise<{ body: unknown; ms: number }> {
    const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
    const started = Date.now();
    const response = await handlePromptRequest(new Request(url), url);
    return { body: await response!.json(), ms: Date.now() - started };
  }

  test("answers without it once its read is late, rather than waiting on herdr", async () => {
    await stalledAnsiHerdr("idle", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null });
      expect(reads).toEqual(["text", "ansi"]);
      expect(ms).toBeLessThan(2_500);
    });
  }, 4_000);

  test("is not read while Claude works", async () => {
    await stalledAnsiHerdr("working", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null });
      expect(reads).toEqual(["text"]);
      expect(ms).toBeLessThan(1_000);
    });
  }, 4_000);
});

// Captured from pi 0.87.1 driving its own dialogs: the pane's footer stays under the dialog,
// so the hint is near the end of the screen without being it.
describe("pi's dialogs", () => {
  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const piScreen = (body: string) => `────────────────────────────────────────\n\n${body}\n────────────────────────────────────────${FOOTER}`;
  const MENU_HINT = " ↑↓ navigate  enter select  escape/ctrl+c cancel";
  const select = piScreen(" Allow dangerous command?\n\n → Allow once\n   Always allow\n   Block\n" + MENU_HINT);

  test("reads an extension's select as its options, in pi's own order", () => {
    const prompt = parseInteractivePrompt("pi", select)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Allow dangerous command?");
    expect(prompt.options.map((option) => option.label)).toEqual(["Allow once", "Always allow", "Block"]);
    // the cursor sits on the first row, so one option is one key step per row above it
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads a confirm as an approval, and declines it by pressing No", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Clear session?\n All messages will be lost.\n\n → Yes\n   No\n" + MENU_HINT))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.title).toBe("Clear session?");
    expect(prompt.question).toBe("All messages will be lost.");
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    // measured on pi: pressing "No" answers the confirmation false, where Escape would leave
    // it unanswered, so the card's decline presses the row it shows
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("lets the chat type an answer to a dialog that wants text", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Branch name?\n\n>\n enter submit  escape/ctrl+c cancel"))!;
    expect(prompt.question).toBe("Branch name?");
    expect(prompt.custom_option_index).toBe(0);
    // the `>` line already owns the input: an Enter typed before the answer submits the dialog
    // empty, and the answer is left behind to be typed into pi's own prompt
    // the line is emptied first: text typed into it in the terminal would stay around the answer
    expect(answerKeys(prompt, { custom_text: "feat/x" })).toEqual([{ keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "feat/x" }, { keys: ["enter"] }]);
  });

  // The wrap as pi 0.87.1 draws it in a pane 46 columns wide: a row three columns in, its rest one.
  test("reads an option a narrow pane wrapped as one option, so a tap lands on the row it names", () => {
    const narrow = piScreen(" Where should this change go next?\n\n → Keep it on the staging environment for now\n and wait for review\n   Deploy to production\n   Cancel\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n");
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt.options.map((option) => option.label)).toEqual(['Keep it on the staging environment for now and wait for review', "Deploy to production", "Cancel"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    // an option that is not the cursor's wraps the same way
    const second = piScreen(" Pick one\n\n → Cancel\n   Keep it on the staging environment for now\n and wait for review\n   Deploy to production\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n");
    expect(parseInteractivePrompt("pi", second)!.options.map((option) => option.label)).toEqual(["Cancel", "Keep it on the staging environment for now and wait for review", "Deploy to production"]);
  });

  test("reads a confirm's wrapped message whole, under the dialog's own title", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Delete the branch?\n This removes the local branch and its remote\n counterpart for good.\n\n → Yes\n   No\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n"))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.title).toBe("Delete the branch?");
    expect(prompt.question).toBe("This removes the local branch and its remote counterpart for good.");
  });

  test("offers nothing once the dialog is answered, moved through, or never opened", () => {
    expect(parseInteractivePrompt("pi", select.replace("→ Allow once", "  Allow once").replace("   Always allow", " → Always allow"))).toBeNull();
    // an answered dialog leaves its hint on screen while pi carries on under it: the hint is
    // no longer near the end, so the card that was offered is withdrawn rather than reoffered
    expect(parseInteractivePrompt("pi", piScreen(" select -> Always allow\n" + MENU_HINT + "\n\n thinking\n more of the answer\n and yet more\n\n>" ))).toBeNull();
    // pi's own main prompt, and its slash palette: the palette ends in a row count rather than
    // this hint, and its rows are set out in two columns, which are commands, not answers
    expect(parseInteractivePrompt("pi", piScreen(""))).toBeNull();
    const palette = piScreen(" /model\n → settings                        Open settings menu\n   model                           Select model\n   tree                            Navigate session tree\n   (1/51)\n" + MENU_HINT);
    expect(parseInteractivePrompt("pi", palette)).toBeNull();
    // /tree navigates the session's branch, which the chat cannot undo: its hint says "↑/↓ move"
    expect(parseInteractivePrompt("pi", piScreen("   Session Tree\n  ↑/↓ move · ←/→ page · ctrl+←/→ branch · ctrl+x copy\n  Type to search:\n────────────────────────────────────────\n  an entry\n  (0/1)"))).toBeNull();
  });

  test("tells a dialog apart from another of the same shape", () => {
    const other = select.replace("Block", "Block and say why");
    expect(parseInteractivePrompt("pi", select)!.id).not.toBe(parseInteractivePrompt("pi", other)!.id);
    // the id is the card's own content: what the chat polls keeps its answer open while pi
    // redraws around the dialog, and turns stale only when the dialog itself changes
    expect(parseInteractivePrompt("pi", select.replace("0.0%/215k (auto)", "12.3%/215k (auto)"))!.id).toBe(parseInteractivePrompt("pi", select)!.id);
  });
});

// Both screens captured from pi 0.87.1 running /model in a pane of its own, at 140 columns and
// at 46, with the catalogue already settled.
describe("pi's model list", () => {
  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const MODEL_HINT = " Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel";
  const wide = `────────────────────────────────────────

Only showing models from configured providers. Use /login to add providers.
>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default
    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]
Could not refresh llama.cpp; showing cached models.
${MODEL_HINT}
────────────────────────────────────────${FOOTER}`;

  test("reads the catalogue, naming the model answering now", () => {
    const prompt = parseInteractivePrompt("pi", wide)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])");
    expect(prompt.options.map((option) => option.label)).toEqual([
      "vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default",
      "vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
    ]);
    // pi's own notes sit among the rows — the refresh failure at column zero, `Model Name:`
    // indented — and none of them is a model pi can be switched to
    expect(prompt.options.length).toBe(2);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("navigates from where pi drew the cursor, which is the model in use", () => {
    const moved = wide.replace("→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
      "  ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n→ vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]");
    const prompt = parseInteractivePrompt("pi", moved)!;
    expect(prompt.question).toBe("Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])");
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("voids a catalogue whose rows run out mid-name rather than offering the ones before it", () => {
    // a screen redrawn while pi is still writing it ends a row in the middle of its provider
    // bracket. Stopping there is right, but the rows before it were already collected, and
    // offering them is a catalogue pi never drew: the reader would count down into a list whose
    // rest does not exist, and the count the card shows would not be the list pi has. This is the
    // same call the wrapped-name check makes — a row that cannot be read voids the reading
    const cut = `────────────────────────────────────────

Only showing models from configured providers. Use /login to add providers.
>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default
    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]
    another-model [provider-
${MODEL_HINT}
────────────────────────────────────────${FOOTER}`;
    expect(parseInteractivePrompt("pi", cut)).toBeNull();
  });

  // Captured from pi 0.87.1 running /model in a 46-column pane, the width a phone leaves it:
  // the hint splits across two lines, and so does a model's own name, which drops the provider's
  // bracket — the one mark that tells a row from pi's notes — onto a line of its own at column
  // zero, where it looks exactly like a note. Every check here is read off that capture.
  const narrow = `──────────────────────────────

Only showing models from configured providers.
Use /login to add providers.
>

→ ✓ vllm-flash/Qwen3.8-Flash-Next
[lwsa-platform] · default
    vllm/Qwen/Qwen3.8-27B [lwsa-platform]

  Model Name: qwen-3-8-flash

  Refreshing model catalogs…

  Enter to select · Ctrl+S to set as default ·
Escape/Ctrl+C to cancel
──────────────────────────────
/tmp/pn
0.0%/215k (auto)  vllm-flash/Qwen3.8-Flash-Nex
`;

  test("reads the catalogue off a phone's pane, joining the rows pi wrapped", () => {
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt).not.toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual([
      "vllm-flash/Qwen3.8-Flash-Next [lwsa-platform] · default",
      "vllm/Qwen/Qwen3.8-27B [lwsa-platform]",
    ]);
    expect(prompt.question).toBe("Select model (currently vllm-flash/Qwen3.8-Flash-Next [lwsa-platform])");
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("stops the catalogue at pi's notes, which the narrow pane indents like a row", () => {
    // `Model Name:` and `Refreshing model catalogs…` sit two spaces in, the same indentation a
    // wrapped row's tail carries, and neither is a model pi can be switched to
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt.options.some((option) => /Model Name|Refreshing/i.test(option.label))).toBe(false);
  });

  test("goes stale on a phone's pane once the wrapped hint is buried", () => {
    expect(parseInteractivePrompt("pi", narrow)).not.toBeNull();
    expect(parseInteractivePrompt("pi", `${narrow}Some later output\nand more\n`)).toBeNull();
  });

  test("says nothing rather than offer a model that is only half a name", () => {
    // a bracket cut mid-word is not a provider: joining it back would invent `lwsa- platform`
    const cut = `────────────────────────

>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-
    vllm-flash/Qwen3.8-Flash-Next
${MODEL_HINT}
────────────────────────${FOOTER}`;
    expect(parseInteractivePrompt("pi", cut)).toBeNull();
    // filtering the list down to one model leaves nothing to choose between
    const one = wide.replace("    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]\n", "");
    expect(parseInteractivePrompt("pi", one)).toBeNull();
    // and with the cursor on no row at all, an answer would navigate from nowhere
    expect(parseInteractivePrompt("pi", wide.replace("→ ✓ vllm/Qwen", "  ✓ vllm/Qwen"))).toBeNull();
  });

  // Captured from pi 0.87.1 running /login in a 46-column pane. `↑↓ navigate` carries no `·`, so
  // pi keeps its footer under this dialog as it does everywhere else, and the hint's own wrap puts
  // it four lines from the bottom — further than a three-line window reaches. A phone leaves pi
  // exactly this wide, so every dialog it can be asked had no card at that width.
  const login = `──────────────────────────────

 Login

 Choose how to sign in.

 → Sign in with an account
   Sign in with an API key

 ↑↓ navigate  enter select  escape/ctrl+c
 cancel
──────────────────────────────
/tmp/pr
0.0%/215k (auto)  vllm-flash/Qwen3.8-Flash-Nex
`;

  test("reads a dialog whose wrapped hint sits over pi's footer", () => {
    const prompt = parseInteractivePrompt("pi", login)!;
    expect(prompt).not.toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Sign in with an account",
      "Sign in with an API key",
    ]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("goes stale on a phone's pane once a wrapped dialog hint is buried", () => {
    expect(parseInteractivePrompt("pi", login)).not.toBeNull();
    // pi keeps the answered dialog on screen; what comes after buries the hint, and a card still
    // open then would press keys into whatever the pane shows by then
    expect(parseInteractivePrompt("pi", `${login}Some later output\nand more\n`)).toBeNull();
  });

  test("goes stale once the list is answered and buried", () => {
    expect(parseInteractivePrompt("pi", wide)).not.toBeNull();
    // pi keeps the answered list on screen; the next request's output buries the hint under it,
    // and the card must not stay open offering a switch into whatever the pane shows by then
    expect(parseInteractivePrompt("pi", `${wide}\nSome later output\nand more`)).toBeNull();
  });
});

// Claude Code 2.1.290 running /model in a pane of its own, captured at 120 columns, at 46 by 40
// and at 46 by 24. The list held twelve models; the twelfth was never drawn in a capture, so
// the fixtures that draw a window stop at the eleventh and count it.
const CLAUDE_MODELS: [name: string, said: string][] = [
  ["Default (recommended)", "Fable 5.1"], ["Opus 5.5", "For complex work and everyday tasks"], ["Fable 5.1", "For your toughest challenges"],
  ["Sonnet 5.5", "Most efficient for simpler tasks"], ["Haiku 4.5", "Fastest for quick answers"], ["Sonnet 5", "Efficient for routine tasks"],
  ["Opus 5", "Best for everyday, complex tasks"], ["Fable 5", "Most capable for your hardest and longest-running tasks"],
  ["Opus 4.8", "Best for everyday, complex tasks"], ["Opus 4.7", "Best for everyday, complex tasks"], ["Opus 4.6", "Best for everyday, complex tasks"],
];
const CLAUDE_MODEL_HINT = "  Enter to set as default · s to use this session only · Esc to cancel";
/** after Esc in the terminal: Claude says what it kept and has its input box back */
const CLAUDE_MODEL_CLOSED = `❯ /model\n  ⎿  Kept model as Opus 5.5\n\n${"─".repeat(60)}\n❯ \n${"─".repeat(60)}\n  [Opus 5.5] │ app git:(main)\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n`;
/**
 * The list as a wide pane shows it: `shown` rows from row `from`, the cursor on row `at`, `✔` on
 * the second. The cursor's column holds `↑` or `↓` on the window's first and last row when the
 * list goes on beyond it, and the effort line under the rows follows the cursor.
 */
function claudeModelList(at: number, from = 0, shown = 10, hint = CLAUDE_MODEL_HINT): string {
  const window = CLAUDE_MODELS.slice(from, from + shown);
  const below = 12 - from - window.length;
  const rows = window.map(([name, said], index) => {
    const row = from + index;
    const mark = row === at ? "❯" : index === 0 && from > 0 ? "↑" : index === window.length - 1 && below > 0 ? "↓" : " ";
    return `  ${mark} ${`${row + 1}.`.padEnd(3)} ${`${name}${row === 1 ? " ✔" : ""}`.padEnd(21)}  ${said}`;
  });
  return [
    "❯ /model", "", "─".repeat(120), "  Select model",
    "  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,",
    "  specify with --model.", "", ...rows, ...(below > 0 ? [`     … +${below} model${below === 1 ? "" : "s"}`] : []), "",
    at === 4 ? "  ○ Effort not supported for Haiku 4.5" : at === 2 ? "  ● High effort (default) ←/→ to adjust" : "  ◐ Medium effort (default) ←/→ to adjust",
    "", hint, "",
  ].join("\n");
}

describe("Claude Code's model list", () => {
  test("reads the rows it draws, naming the model in use and counting the ones it holds back", () => {
    // the capture itself, so that the drawing above is checked against what Claude drew
    const captured = `❯ /model

${"─".repeat(120)}
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
  specify with --model.

    1.  Default (recommended)  Fable 5.1
  ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks
    3.  Fable 5.1              For your toughest challenges
    4.  Sonnet 5.5             Most efficient for simpler tasks
    5.  Haiku 4.5              Fastest for quick answers
    6.  Sonnet 5               Efficient for routine tasks
    7.  Opus 5                 Best for everyday, complex tasks
    8.  Fable 5                Most capable for your hardest and longest-running tasks
    9.  Opus 4.8               Best for everyday, complex tasks
  ↓ 10. Opus 4.7               Best for everyday, complex tasks
     … +2 models

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this session only · Esc to cancel
`;
    expect(claudeModelList(1)).toBe(captured);
    const prompt = parseInteractivePrompt("claude", captured)!;
    expect(prompt).toMatchObject({ agent: "claude", kind: "question", title: "", body: null, multi_select: false, custom_option_index: null });
    expect(prompt.question).toBe("Select model for this session (currently Opus 5.5). 2 more models are listed in the terminal.");
    expect(prompt.options).toEqual(CLAUDE_MODELS.slice(0, 10).map(([label, description]) => ({ label, description })));
    // herdr reports the pane idle while the list waits: no other agent's reader takes it for its own
    for (const agent of ["codex", "omp", "pi", "omo", ""]) expect(parseInteractivePrompt(agent, captured)).toBeNull();
  });

  test("is one card wherever the cursor stands, whatever effort the row under it would run at", () => {
    const first = parseInteractivePrompt("claude", claudeModelList(1))!;
    for (const at of [0, 2, 4, 9]) expect(parseInteractivePrompt("claude", claudeModelList(at))!.id).toBe(first.id);
  });

  test("reads a window further down the list, and the last row with the cursor on it", () => {
    // nine ↓ from the second row: the window has moved one row down, `↑` on its first
    const scrolled = claudeModelList(10, 1);
    expect(scrolled).toContain("  ↑ 2.  Opus 5.5 ✔             For complex work and everyday tasks\n");
    expect(scrolled).toContain("  ❯ 11. Opus 4.6               Best for everyday, complex tasks\n     … +1 model\n");
    const prompt = parseInteractivePrompt("claude", scrolled)!;
    expect(labels(prompt)).toEqual(CLAUDE_MODELS.slice(1, 11).map(([name]) => name));
    // one above the window, one below it
    expect(prompt.question).toBe("Select model for this session (currently Opus 5.5). 2 more models are listed in the terminal.");
    expect(parseInteractivePrompt("claude", claudeModelList(1, 1))!.id).toBe(prompt.id);
    expect(prompt.id).not.toBe(parseInteractivePrompt("claude", claudeModelList(1))!.id);
    // the model in use above the window: the card does not name one
    expect(parseInteractivePrompt("claude", claudeModelList(4, 2))!.question).toBe("Select model for this session. 3 more models are listed in the terminal.");
  });

  test("reads the list by family that another session drew, with nothing held back", () => {
    // captured from the same Claude Code a few minutes apart: five rows, the name in what a row says
    const families = `   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
   specify with --model.

   ❯ 1. Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks
     2. Opus                     Opus 5.5 · Best for everyday, complex tasks
     3. Fable                    Fable 5.1 · Most capable for your hardest and longest-running tasks
     4. Sonnet                   Sonnet 5.5 · Efficient for routine tasks
     5. Haiku                    Haiku 4.5 · Fastest for quick answers

   ◐ Medium effort (default) ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel
`;
    const prompt = parseInteractivePrompt("claude", families)!;
    expect(prompt.question).toBe("Select model for this session (currently Default)");
    expect(prompt.options).toEqual([
      { label: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
      { label: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks" },
      { label: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks" },
      { label: "Sonnet", description: "Sonnet 5.5 · Efficient for routine tasks" },
      { label: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
    ]);
  });

  // 46 columns by 24 lines, the pane a phone leaves: the title has scrolled off the top, Claude
  // draws five rows of the twelve, and what a row says wraps under itself
  const PHONE = `  becomes the default for new sessions. For
  other/previous model names, specify with
  --model.

    1.  Default (recommended)  Fable 5.1
  ❯ 2.  Opus 5.5 ✔             For complex
                               work and
                               everyday
                               tasks
    3.  Fable 5.1              For your
                               toughest
                               challenges
    4.  Sonnet 5.5             Most
                               efficient for
                               simpler
                               tasks
  ↓ 5.  Haiku 4.5              Fastest for
                               quick answers
     … +7 models

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this
  session only · Esc to cancel
`;

  test("reads the list off a phone's pane, with its title scrolled off and its rows wrapped", () => {
    const prompt = parseInteractivePrompt("claude", PHONE)!;
    expect(prompt.question).toBe("Select model for this session (currently Opus 5.5). 7 more models are listed in the terminal.");
    expect(prompt.options).toEqual(CLAUDE_MODELS.slice(0, 5).map(([label, description]) => ({ label, description })));
    // the same pane 40 lines tall draws ten rows, and cuts the one word longer than its column:
    // it stays cut as the pane shows it, since a line that fills its column says nothing of a space
    const cut = `    7.  Opus 5                 Best for
                               everyday,
                               complex tasks
  ❯ 8.  Fable 5                Most capable
                               for your
                               hardest and
                               longest-runni
                               ng tasks
    9.  Opus 4.8               Best for
                               everyday,
                               complex tasks
  ↓ 10. Opus 4.7               Best for
                               everyday,
                               complex tasks
     … +2 models

  ● High effort (default) ←/→ to adjust

  Enter to set as default · s to use this
  session only · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", cut)!.options).toEqual(CLAUDE_MODELS.slice(6, 10).map(([label, description]) => ({ label, description: description.replace("longest-running", "longest-runni ng") })));
  });

  test("picks with s, the key for this session only, and never with Enter", () => {
    const prompt = parseInteractivePrompt("claude", claudeModelList(1))!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "s" }]);
    expect(answerKeys(prompt, { option_index: 4 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { text: "s" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { text: "s" }]);
    // a window further down: the moves count from the cursor's place in it
    expect(answerKeys(parseInteractivePrompt("claude", claudeModelList(10, 1))!, { option_index: 7 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { text: "s" }]);
    expect(() => answerKeys(prompt, { custom_text: "opus" })).toThrow();
    expect(() => answerKeys(prompt, { option_index: 10 })).toThrow();
  });

  test("offers no card for a list that is not waiting, or that names no key for this session", () => {
    expect(parseInteractivePrompt("claude", CLAUDE_MODEL_CLOSED)).toBeNull();
    // the list's text left above later output takes no key any more
    expect(parseInteractivePrompt("claude", `${claudeModelList(1)}Some later output\nand more\n`)).toBeNull();
    // nor does it hold the screen for a message that waits to be typed, while an open list does, wrapped or not
    expect(modelListWaits("claude", `${claudeModelList(1)}Some later output\nand more\n`)).toBe(false);
    expect(modelListWaits("claude", claudeModelList(1))).toBe(true);
    const wrapped = claudeModelList(1).replace(CLAUDE_MODEL_HINT, "  Enter to set as\n  default · s to use\n  this session\n  only · Esc to\n  cancel");
    expect(modelListWaits("claude", wrapped)).toBe(true);
    // Claude's own footer under the open list, the session's rule and its task list, is no later output: also under a wrapped hint
    expect(modelListWaits("claude", `${claudeModelList(1)}──────────── Session name ─\n`)).toBe(true);
    expect(modelListWaits("claude", `${wrapped}──────────── Session name ─\n`)).toBe(true);
    expect(modelListWaits("claude", `${wrapped}──────────── Session name ─\n  3 tasks (0 done, 1 in progress, 2 open)\n  ◼ 구현\n    Running tests…\n  ◻ 검증\n  ◻ 정리\n`)).toBe(true);
    // the same footer under an answered list's hint and what came after it holds nothing
    expect(modelListWaits("claude", `${wrapped}⏺ Kept the model.\n──────────── Session name ─\n`)).toBe(false);
    // a list that takes Enter alone would save the pick as the default: not this card's to press
    expect(parseInteractivePrompt("claude", claudeModelList(1, 0, 10, "  Enter to set as default · Esc to cancel"))).toBeNull();
    expect(parseInteractivePrompt("claude", claudeModelList(1, 0, 10, "  Enter to confirm · Esc to cancel"))).toBeNull();
  });

  test("offers no card for rows it cannot read as the list drew them", () => {
    const list = claudeModelList(1);
    // no cursor on any row drawn, or on two of them
    expect(parseInteractivePrompt("claude", list.replace("  ❯ 2. ", "    2. "))).toBeNull();
    expect(parseInteractivePrompt("claude", list.replace("    4. ", "  ❯ 4. "))).toBeNull();
    // a name the pane cut in two stands under its row at the name's own column. Half a name is no
    // model: that row is left to the terminal, and the rows under it are offered as they read
    const split = PHONE.replace("    1.  Default (recommended)  Fable 5.1", "    1.  Default\n        (recommended)          Fable 5.1");
    expect(parseInteractivePrompt("claude", split)).not.toBeNull();
    expect(labels(parseInteractivePrompt("claude", split))).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"]);
    expect(parseInteractivePrompt("claude", split)!.question).toBe("Select model for this session (currently Opus 5.5). 8 more models are listed in the terminal.");
    // the last row cut so: nothing under it says where the list ends
    expect(parseInteractivePrompt("claude", PHONE.replace("  ↓ 5.  Haiku 4.5              Fastest for\n                               quick answers", "  ↓ 5.  Haiku\n        4.5                    Fastest"))).toBeNull();
    // one row is no choice
    expect(parseInteractivePrompt("claude", claudeModelList(1, 1, 1))).toBeNull();
    // more under the rows than the effort line: another program's text over the same hint
    expect(parseInteractivePrompt("claude", list.replace("\n\n  ◐ Medium", "\n\n  one\n  two\n  three\n  ◐ Medium"))).toBeNull();
  });

  test("reads a wrapped line by its column, whatever it begins with", () => {
    // what a row says can wrap onto a line that begins like a row of its own
    const numbered = PHONE.replace("                               work and\n                               everyday", "                               work and\n                               3. everyday");
    expect(numbered).not.toBe(PHONE);
    const prompt = parseInteractivePrompt("claude", numbered)!;
    expect(labels(prompt)).toEqual(CLAUDE_MODELS.slice(0, 5).map(([name]) => name));
    expect(prompt.options[1]!.description).toBe("For complex work and 3. everyday tasks");
  });

  test("takes no numbered line above the list for one of its rows", () => {
    // an answer's own list in the transcript, right above the panel
    const answered = `● Here are the steps:\n  1. Read the file\n  2. Run the tests\n\n${claudeModelList(1)}`;
    expect(labels(parseInteractivePrompt("claude", answered))).toEqual(CLAUDE_MODELS.slice(0, 10).map(([name]) => name));
    // even right above the window with its count running on into it: `↑` is the window's first row
    const window = claudeModelList(10, 1);
    const ranOn = `● Options:\n  1. Keep it\n${window.slice(window.indexOf("  ↑ 2. "))}`;
    expect(ranOn).toContain("  1. Keep it\n  ↑ 2.  Opus 5.5 ✔");
    expect(labels(parseInteractivePrompt("claude", ranOn))).toEqual(CLAUDE_MODELS.slice(1, 11).map(([name]) => name));
    // and `↓` is its last: a numbered line right under that row is none of the list's
    const under = claudeModelList(1).replace("     … +2 models\n", "    11. Read the file\n");
    expect(under).toContain("  ↓ 10. Opus 4.7               Best for everyday, complex tasks\n    11. Read the file\n");
    expect(parseInteractivePrompt("claude", under)).toBeNull();
  });
});

// Codex 0.160.1 running /model in a pane of its own, captured at 120 columns and at 46 by 24:
// the list of models, the reasoning levels behind a model's row, and the list behind "More
// reasoning…". The footer is the one Codex draws for the row under the cursor.
const CODEX_OPENS = "  enter select · esc back";
const CODEX_PICKS = "  enter default · s session · esc back";
const CODEX_MODELS: [name: string, said: string][] = [
  ["GPT-6.1-Sol (default)", "Latest workhorse model for coding and everyday work."], ["GPT-6-Astra", "Frontier intelligence for the most demanding work."],
  ["GPT-6-Sol", "Previous generation workhorse model."], ["GPT-6-Luna", "Fast and affordable model for easier tasks."],
  ["GPT-5.6-Sol", "Older generation workhorse model."], ["GPT-5.6-Terra", "Older balanced model for straightforward work."],
  ["GPT-5.6-Luna", "Older fast and efficient model."],
];
const CODEX_LEVELS: [name: string, said: string][] = [
  ["Low", "Fast responses with lighter reasoning"], ["Medium (default)", "Balances speed and reasoning depth for everyday tasks"],
  ["High", "Greater reasoning depth for complex problems"], ["Extra high", "Extra high reasoning depth for complex problems"],
  ["More reasoning…", "Max and Ultra consume usage limits faster"],
];
const CODEX_HEAD = "\n  >_ OpenAI Codex (v0.160.1)\n     ~/app\n  permissions: YOLO mode\n\n  Hello, you. Got an idea?\n\n";
/**
 * One of Codex's lists with its cursor on row `at` and `(current)` on the second: the names in one
 * column, what a row says in the next, and under them the footer of the row the cursor is on.
 */
function codexList(title: string, rows: [string, string][], at: number, footer: (row: number) => string): string {
  const width = Math.max(...rows.map(([name], row) => name.length + (row === 1 ? " (current)".length : 0)));
  return `${CODEX_HEAD}  ${title}\n\n\n${rows.map(([name, said], row) => `${row === at ? "›" : " "} ${row + 1}. ${`${name}${row === 1 ? " (current)" : ""}`.padEnd(width)}  ${said}`).join("\n")}\n\n${footer(at)}\n`;
}
const codexModels = (at: number, footer: (row: number) => string = () => CODEX_OPENS) => codexList("Select Model and Effort", CODEX_MODELS, at, footer);
/** the levels of a model: every level picks, and the last row opens the list of the advanced ones */
const codexLevels = (at: number, model = "GPT-6-Astra") => codexList(`Select Reasoning Level for ${model}`, CODEX_LEVELS, at, (row) => row === 4 ? CODEX_OPENS : CODEX_PICKS);

// Claude Code 2.1.294's `/effort` slider with ▲ over level `at` (low, medium, high, xhigh, max),
// as it draws it under the command that opened it
const CLAUDE_EFFORT_ARROW = [0, 10, 20, 30, 41];
const CLAUDE_EFFORT_HINT = "  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel";
function claudeEffort(at: number, hint = CLAUDE_EFFORT_HINT): string {
  const pad = " ".repeat(29);
  const track = `${"─".repeat(CLAUDE_EFFORT_ARROW[at]!)}▲${"─".repeat(41 - CLAUDE_EFFORT_ARROW[at]!)}`;
  return `❯ /effort\n${"─".repeat(120)}\n  Effort\n\n${pad}Faster${" ".repeat(29)}Smarter\n${pad}${track}      Ultracode  off\n${pad}low     medium     high     xhigh      max      Tab to toggle\n\n\n${hint}\n`;
}
// what the slider leaves once `s` picked a level
const CLAUDE_EFFORT_SET = `❯ /effort\n  ⎿  Set effort level to medium (this session only): Balanced approach with standard implementation and testing\n${"─".repeat(120)}\n❯\n${"─".repeat(120)}\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n`;

describe("Claude Code's effort slider", () => {
  test("reads the levels it draws, whatever level ▲ stands over", () => {
    // the capture itself, so that the drawing above is checked against what Claude drew
    const captured = `❯ /effort
${"─".repeat(120)}
  Effort

                             Faster                             Smarter
                             ──────────▲───────────────────────────────      Ultracode  off
                             low     medium     high     xhigh      max      Tab to toggle


  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
`;
    expect(claudeEffort(1)).toBe(captured);
    const prompt = parseInteractivePrompt("claude", captured)!;
    expect(prompt).toMatchObject({ agent: "claude", kind: "question", title: "", question: "Set effort for this session", body: null, multi_select: false, custom_option_index: null });
    expect(labels(prompt)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // one card wherever ▲ stands
    for (const at of [0, 2, 3, 4]) expect(parseInteractivePrompt("claude", claudeEffort(at))!.id).toBe(prompt.id);
    // herdr reports the pane idle while the slider waits: no other agent's reader takes it for its own
    for (const agent of ["codex", "omp", "pi", "omo", ""]) expect(parseInteractivePrompt(agent, captured)).toBeNull();
  });

  test("moves with ←/→ from the level ▲ is over and picks with s, never with Enter", () => {
    const prompt = parseInteractivePrompt("claude", claudeEffort(2))!;
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ text: "s" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["left"] }, { keys: ["left"] }, { text: "s" }]);
    expect(answerKeys(prompt, { option_index: 4 })).toEqual([{ keys: ["right"] }, { keys: ["right"] }, { text: "s" }]);
    expect(answerKeys(parseInteractivePrompt("claude", claudeEffort(4))!, { option_index: 3 })).toEqual([{ keys: ["left"] }, { text: "s" }]);
    expect(() => answerKeys(prompt, { custom_text: "high" })).toThrow();
    expect(() => answerKeys(prompt, { option_index: 5 })).toThrow();
  });

  test("offers no card for a slider that is not waiting, or that it cannot read", () => {
    expect(parseInteractivePrompt("claude", CLAUDE_EFFORT_SET)).toBeNull();
    // the slider's text left above later output takes no key any more, and holds no message back
    expect(parseInteractivePrompt("claude", `${claudeEffort(2)}Some later output\nand more\n`)).toBeNull();
    expect(modelListWaits("claude", `${claudeEffort(2)}Some later output\nand more\n`)).toBe(false);
    expect(modelListWaits("claude", claudeEffort(2))).toBe(true);
    expect(modelListWaits("claude", CLAUDE_EFFORT_SET)).toBe(false);
    // a slider that takes Enter alone would save the level as the default: not this card's to press
    expect(parseInteractivePrompt("claude", claudeEffort(2, "  ←/→ to adjust · Enter to confirm · Esc to cancel"))).toBeNull();
    // level names a narrow pane wrapped: no card, and the slider still holds the screen
    const wrapped = claudeEffort(2).replace("low     medium     high     xhigh      max      Tab to toggle", "low     medium     high\n  xhigh      max");
    expect(parseInteractivePrompt("claude", wrapped)).toBeNull();
    expect(modelListWaits("claude", wrapped)).toBe(true);
    // ▲ between two levels stands over neither
    const between = claudeEffort(2).replace(`${"─".repeat(20)}▲${"─".repeat(21)}`, `${"─".repeat(15)}▲${"─".repeat(26)}`);
    expect(between).not.toBe(claudeEffort(2));
    expect(parseInteractivePrompt("claude", between)).toBeNull();
  });
});

describe("Codex's model lists", () => {
  test("reads the list of models, whose rows open the next list", () => {
    // the capture itself, so that the drawing above is checked against what Codex drew
    const captured = `  Select Model and Effort


  1. GPT-6.1-Sol (default)  Latest workhorse model for coding and everyday work.
› 2. GPT-6-Astra (current)  Frontier intelligence for the most demanding work.
  3. GPT-6-Sol              Previous generation workhorse model.
  4. GPT-6-Luna             Fast and affordable model for easier tasks.
  5. GPT-5.6-Sol            Older generation workhorse model.
  6. GPT-5.6-Terra          Older balanced model for straightforward work.
  7. GPT-5.6-Luna           Older fast and efficient model.

  enter select · esc back
`;
    expect(codexModels(1)).toBe(`${CODEX_HEAD}${captured}`);
    const prompt = parseInteractivePrompt("codex", codexModels(1))!;
    expect(prompt).toMatchObject({ agent: "codex", kind: "question", title: "", body: null, multi_select: false, custom_option_index: null });
    expect(prompt.question).toBe("Select model for this session (currently GPT-6-Astra)");
    expect(prompt.options).toEqual(CODEX_MODELS.map(([label, description]) => ({ label, description })));
    // the row's key is the screen's to name once the cursor is on it: the card only knows the moves
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { pick: true }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ pick: true }]);
    for (const agent of ["claude", "omp", "pi", "omo", ""]) expect(parseInteractivePrompt(agent, codexModels(1))).toBeNull();
  });

  test("reads a model's reasoning levels without the row that opens the advanced ones", () => {
    const captured = `  Select Reasoning Level for GPT-6-Astra


  1. Low                         Fast responses with lighter reasoning
› 2. Medium (default) (current)  Balances speed and reasoning depth for everyday tasks
  3. High                        Greater reasoning depth for complex problems
  4. Extra high                  Extra high reasoning depth for complex problems
  5. More reasoning…             Max and Ultra consume usage limits faster

  enter default · s session · esc back
`;
    expect(codexLevels(1)).toBe(`${CODEX_HEAD}${captured}`);
    const prompt = parseInteractivePrompt("codex", codexLevels(1))!;
    // "More reasoning…" takes Enter, beside levels whose Enter saves a default: left to the terminal
    expect(prompt.question).toBe("Select reasoning level for GPT-6-Astra for this session (currently Medium). More levels are listed in the terminal.");
    expect(prompt.options).toEqual(CODEX_LEVELS.slice(0, 4).map(([label, description]) => ({ label, description })));
    expect(() => answerKeys(prompt, { option_index: 4 })).toThrow();
    // with the cursor on that row in the terminal, its footer is the one of a row that opens a
    // list: the same card, and the moves to a level count from where the cursor is
    expect(codexLevels(4)).toContain("› 5. More reasoning…             Max and Ultra consume usage limits faster\n\n  enter select · esc back\n");
    const onMore = parseInteractivePrompt("codex", codexLevels(4))!;
    expect(onMore.id).toBe(prompt.id);
    expect(answerKeys(onMore, { option_index: 2 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { pick: true }]);
    // any other row under the cursor whose footer says it only opens a list is not offered either
    const opener = codexList("Select Reasoning Level for GPT-6-Astra", CODEX_LEVELS.slice(0, 4), 2, () => CODEX_OPENS);
    expect(labels(parseInteractivePrompt("codex", opener))).toEqual(["Low", "Medium (default)", "Extra high"]);
    // the levels of another model are another card
    expect(parseInteractivePrompt("codex", codexLevels(1, "GPT-6-Sol"))!.id).not.toBe(prompt.id);
  });

  test("reads the advanced levels with what Codex says over them, wrapped by a phone's pane", () => {
    const wide = `${CODEX_HEAD}  Advanced Reasoning
  ⚠ Consumes usage limits faster


› 1. Max    For difficult problems when quality matters more than speed · higher usage
  2. Ultra  For demanding work using multiple agents · highest usage

  enter default · s session · esc back
`;
    const prompt = parseInteractivePrompt("codex", wide)!;
    expect(prompt.question).toBe("Select advanced reasoning for this session");
    expect(prompt.body).toBe("⚠ Consumes usage limits faster");
    expect(prompt.options).toEqual([
      { label: "Max", description: "For difficult problems when quality matters more than speed · higher usage" },
      { label: "Ultra", description: "For demanding work using multiple agents · highest usage" },
    ]);
    // the capture at 46 columns, with the cursor moved to Ultra, whose Enter applies it at once
    const phone = `  It’s dangerous to code alone. Take a prompt.

  Advanced Reasoning
  ⚠ Consumes usage limits faster


  1. Max    For difficult problems when
            quality matters more than speed ·
            higher usage
› 2. Ultra  For demanding work using multiple
            agents · highest usage

  enter apply · s session · esc back
`;
    expect(parseInteractivePrompt("codex", phone)!.options).toEqual(prompt.options);
    expect(parseInteractivePrompt("codex", phone)!.id).toBe(prompt.id);
  });

  test("reads the names alone where the pane has no room for what a row says", () => {
    // 46 columns: Codex leaves the second column out
    const phone = `  Select Reasoning Level for GPT-6-Astra


  1. Low
› 2. Medium (default) (current)
  3. High
  4. Extra high
  5. More reasoning…

  enter default · s session · esc back
`;
    const prompt = parseInteractivePrompt("codex", phone)!;
    expect(prompt.question).toBe("Select reasoning level for GPT-6-Astra for this session (currently Medium). More levels are listed in the terminal.");
    expect(prompt.options).toEqual(CODEX_LEVELS.slice(0, 4).map(([label]) => ({ label, description: null })));
  });

  test("knows a list by the header right above its rows, wrapped or under the conversation's last line", () => {
    // a pane too narrow for the levels' title: the model's name wraps under it
    const wrapped = `  Select Reasoning Level for
  GPT-5.6-Terra


  1. Low
› 2. Medium (default) (current)
  3. High

  enter default · s session ·
  esc back
`;
    const prompt = parseInteractivePrompt("codex", wrapped)!;
    expect(prompt.question).toBe("Select reasoning level for GPT-5.6-Terra for this session (currently Medium)");
    expect(prompt.body).toBeNull();
    expect(labels(prompt)).toEqual(["Low", "Medium (default)", "High"]);
    // no blank between the conversation's last line and the title: the lines over the title are not the list's
    const under = codexLevels(1).replace("Got an idea?\n\n  Select", "Got an idea?\n  Select");
    expect(under).not.toBe(codexLevels(1));
    expect(parseInteractivePrompt("codex", under)!.id).toBe(parseInteractivePrompt("codex", codexLevels(1))!.id);
    // another list's header between a model list's title and the rows: the rows are that list's
    const other = `  Select Model and Effort\n\n  Select Approval Mode\n\n› 1. Read only\n  2. Full access\n\n${CODEX_OPENS}\n`;
    expect(parseInteractivePrompt("codex", other)).toBeNull();
    expect(parseInteractivePrompt("codex", other.replace("\n\n  Select Approval Mode", "\n  Select Approval Mode\n  Choose what Codex may do\n  without asking"))).toBeNull();
  });

  test("keeps a gap inside one row's name out of what the rows say", () => {
    // names alone, one of them written with two spaces: no column of descriptions to split it at
    const names = `  Select Model and Effort\n\n\n› 1. Custom  Model (current)\n  2. GPT-6-Sol\n  3. GPT-6-Luna\n\n${CODEX_OPENS}\n`;
    const prompt = parseInteractivePrompt("codex", names)!;
    expect(prompt.options).toEqual([{ label: "Custom Model", description: null }, { label: "GPT-6-Sol", description: null }, { label: "GPT-6-Luna", description: null }]);
    expect(prompt.question).toBe("Select model for this session (currently Custom Model)");
    // and beside a column the other rows share
    const beside = codexModels(1).replace("  3. GPT-6-Sol              Previous generation workhorse model.", "  3. GPT  6 Sol");
    expect(parseInteractivePrompt("codex", beside)!.options[2]).toEqual({ label: "GPT 6 Sol", description: null });
    expect(parseInteractivePrompt("codex", beside)!.options[3]).toEqual({ label: "GPT-6-Luna", description: "Fast and affordable model for easier tasks." });
  });

  test("offers no card for another list of Codex's, or for one that is not waiting", () => {
    // the footer is every Codex list's: only the model lists' titles make it this card
    expect(parseInteractivePrompt("codex", codexList("Select Approval Mode", CODEX_LEVELS, 1, () => CODEX_OPENS))).toBeNull();
    // the list of quick presets, which mixes rows that pick with rows that open a list and was
    // never looked at live: left to the terminal
    expect(parseInteractivePrompt("codex", codexList("Select Model", CODEX_MODELS, 1, () => CODEX_PICKS))).toBeNull();
    expect(parseInteractivePrompt("codex", codexList("Select Reasoning Level for GPT-6-Astra", CODEX_LEVELS, 1, () => "  enter confirm · esc back"))).toBeNull();
    // answered, with Codex's own prompt under it
    expect(parseInteractivePrompt("codex", `${codexLevels(1)}• Model changed to gpt-6-astra medium for this session only\n› Ask Codex to do anything\n`)).toBeNull();
    // no cursor on a row, or one row alone
    expect(parseInteractivePrompt("codex", codexLevels(1).replace("› 2. ", "  2. "))).toBeNull();
    expect(parseInteractivePrompt("codex", codexList("Select Model and Effort", CODEX_MODELS.slice(0, 1), 0, () => CODEX_OPENS))).toBeNull();
    // anything between the rows and their footer
    expect(parseInteractivePrompt("codex", codexLevels(1).replace(`\n\n${CODEX_PICKS}`, `\n  Loading…\n${CODEX_PICKS}`))).toBeNull();
  });
});

// The answer route against a herdr that only holds a screen: what the pane shows is the test's to
// change, between two reads or under an answer's own keys, and every key the route sends is kept.
describe("an answer and the menu it was made for", () => {
  interface Pane {
    agent: string; status: string; screen: string; sent: string[]; onSent?: (sent: string) => void;
    /** the pane's folder and its Codex rollout, for a prompt named by the agent's own call */
    cwd?: string; rollout?: string;
    /** how long herdr takes over each screen read from now on */
    readDelay?: number;
    onRead?: () => void;
    /** herdr never answers what it is asked about the pane's agent */
    agentUnanswered?: boolean;
    /** the next screen read alone answers with this, that much later */
    nextRead?: { text: string; delay: number };
    /** herdr presses this key and its reply is lost on the way */
    replyLostOn?: string;
    /** more panes showing the same screen: p_2 … */
    more?: number;
    /** the next snapshot alone takes this long */
    nextSnapshotDelay?: number;
    root: string;
    omo?: { pid: number; path: string; live: boolean };
  }

  async function withPane(agent: string, status: string, screen: string, run: (pane: Pane) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-answer-"));
    const path = join(root, "herdr.sock");
    const pane: Pane = { agent, status, screen, sent: [], root };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        const snapshotDelay = request.method === "session.snapshot" ? pane.nextSnapshotDelay : undefined;
        if (snapshotDelay !== undefined) pane.nextSnapshotDelay = undefined;
        if (request.method === "session.snapshot") return void setTimeout(() => answer({ snapshot: { panes: Array.from({ length: 1 + (pane.more ?? 0) }, (_, index) => ({ pane_id: `p_${index + 1}`, agent: pane.agent, agent_status: pane.status, cwd: pane.cwd, ...(pane.omo ? { agent_session: { agent: "omo", kind: "path", value: pane.omo.path } } : {}) })), layouts: [] } }), snapshotDelay ?? 0);
        if (request.method === "pane.read") {
          pane.onRead?.();
          const once = pane.nextRead;
          pane.nextRead = undefined;
          if (once) return void setTimeout(() => answer({ read: { text: once.text } }), once.delay);
          return void setTimeout(() => answer({ read: { text: pane.screen } }), pane.readDelay ?? 0);
        }
        if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: pane.omo?.live ? [{ pid: pane.omo.pid, argv: ["omo"] }] : [] } });
        if (request.method === "agent.get" && pane.agentUnanswered) return;
        if (request.method === "agent.get") return answer({ agent: pane.rollout ? { agent_session: { kind: "path", value: pane.rollout } } : {} });
        if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
        let lost = false;
        for (const sent of request.params.keys ?? [`text:${request.params.text}`]) {
          pane.sent.push(sent);
          pane.onSent?.(sent);
          lost ||= sent === pane.replyLostOn;
        }
        if (lost) return void socket.destroy();
        answer({});
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(pane); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function card(codexHome?: string, paneId = "p_1"): Promise<InteractivePrompt | null> {
    const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${paneId}`);
    return ((await (await handlePromptRequest(new Request(url), url, { codexHome }))!.json()) as { prompt: InteractivePrompt | null }).prompt;
  }

  async function answer(promptId: string, choice: { option_index?: number; option_indices?: number[]; custom_text?: string }, more: { signal?: AbortSignal; codexHome?: string } = {}): Promise<{ status: number; code?: string }> {
    const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
    const response = (await handlePromptRequest(new Request(url, { method: "POST", signal: more.signal, body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...choice }) }), url, { codexHome: more.codexHome }))!;
    const body = await response.json() as { error?: { code: string } };
    return { status: response.status, code: body.error?.code };
  }

  const omoRule = "─".repeat(100);
  const omoWidget = (box = "❯") => `? Question pending (1 unanswered) · 30m
 QA — Which one?
 [ First ] [ Second ] [ own answer… ]
 enter to answer · /answer · or just type your reply
${omoRule}
${box}
${omoRule}
/tmp/work • main
(😺 OmO Native)
`;
  const omoFormScreen = (at = 0, question = "Which one?", options = ["First", "Second"]) => `${omoRule}
 Ask user · 30m
 → QA    Submit
 ${question}
${options.map((label, i) => ` ${at === i ? "→" : " "} ${i + 1}. ${label}`).join("\n")}
 ${at === options.length ? "→" : " "} Type your own answer...
 Submit (0/1 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
${omoRule}
/tmp/work • main
(😺 OmO Native)
`;
  const omoCall = (id: string, options: { label: string }[] | undefined = [{ label: "First" }, { label: "Second" }]) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "ask_user_question", arguments: { waitForAnswer: false, questions: [{ header: "QA", question: "Which one?", ...(options ? { options } : {}) }] } }] } }) + "\n";

  // These route fixtures use /proc to read an inert child's isolated agent directory.
  async function withOmo(run: (pane: Pane) => Promise<void>, options?: { label: string }[]): Promise<void> {
    await withPane("claude", "working", omoWidget(), async (pane) => {
      const agentDir = join(pane.root, "agent");
      const dir = join(agentDir, "sessions");
      mkdirSync(dir, { recursive: true });
      pane.cwd = pane.root;
      const path = join(dir, "2026-10-06T00-00-00_qa-session-488.jsonl");
      writeFileSync(path, JSON.stringify({ type: "session", id: "qa-session-488", cwd: pane.cwd, timestamp: new Date().toISOString() }) + "\n" + omoCall("q1", options));
      // An inert child supplies a real process environment; all RPCs and session files are fixtures.
      const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: { ...process.env, OMO_CODING_AGENT_DIR: agentDir } });
      pane.omo = { pid: child.pid, path, live: true };
      promptWaitEnded("p_1");
      try { await run(pane); }
      finally { child.kill(); await child.exited; }
    });
  }

  // Claude Code 2.1.294, live: a message it holds back for an invisible character
  const heldRule = "─".repeat(80);
  const heldScreen = (box: string, over = `${" ".repeat(40)}Removed 1 invisible character · review and press Enter to send`) => `
 ▐▛███▜▌   Claude Code v2.1.294
${over}
${heldRule}
${box}
${heldRule}
  [Haiku 4.5] │ project
`;

  test("sends Claude's held message only as the card showed it: a box edited in the terminal refuses the answer", async () => {
    await withPane("claude", "idle", heldScreen("❯ helloworld test"), async (pane) => {
      const shown = (await card())!;
      expect(shown.body).toBe("helloworld test");
      // edited in the terminal after the card was read: the hint stays, the message is another one
      pane.screen = heldScreen("❯ helloworld test and more");
      expect(await answer(shown.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      // sent from the terminal meanwhile: the hint lingers over an empty input
      pane.screen = heldScreen("❯");
      expect(await answer(shown.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(await answer(shown.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      // the card as the screen shows it now is answered with one Enter
      pane.screen = heldScreen("❯ helloworld test");
      const again = (await card())!;
      expect(await answer(again.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("never presses Ctrl+C for a Discard tapped before Claude went to work", async () => {
    await withPane("claude", "idle", heldScreen("❯ helloworld test"), async (pane) => {
      const shown = (await card())!;
      expect(labels(shown)).toEqual(["Send", "Discard"]);
      // a turn began under the card: Ctrl+C would interrupt it and leave the message where it is
      pane.status = "working";
      expect(await answer(shown.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      const working = (await card())!;
      expect(labels(working)).toEqual(["Send"]);
      expect((await answer(working.id, { option_index: 1 })).status).toBe(400);
      expect(pane.sent).toEqual([]);
    });
  });

  test("takes no grey placeholder or suggestion in Claude's empty box for a held message", async () => {
    // Claude Code 2.1.294, live: the empty box's own grey text (SGR 2), as herdr's ANSI read gives it
    const grey = (text: string) => `❯ \u001b[0m\u001b[2m${text}\u001b[0m`;
    await withPane("claude", "idle", heldScreen("❯ helloworld test"), async (pane) => {
      const shown = (await card())!;
      expect(labels(shown)).toEqual(["Send", "Discard"]);
      // sent or cleared in the terminal: the hint lingers a moment over a box that is empty again
      for (const empty of [grey('Try "how does <filepath> work?"'), grey("run the tests")]) {
        pane.screen = heldScreen(empty);
        expect(await card()).toBeNull();
        // Enter there would send Claude's suggestion, Ctrl+C would ask to leave Claude
        expect(await answer(shown.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
        expect(await answer(shown.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      }
      expect(pane.sent).toEqual([]);
      // typed text is not grey: a message of the same words is a held message
      pane.screen = heldScreen("❯ run the tests");
      expect((await card())?.body).toBe("run the tests");
    });
  });

  test.skipIf(process.platform !== "linux")("opens the pending OmO form, navigates to a non-default row and confirms after redraw", async () => {
    for (const box of ["❯", "❯ ", "❯\n ", "❯│"]) await withOmo(async (pane) => {
      pane.screen = omoWidget(box);
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "alt+up") pane.screen = omoFormScreen(at);
        if (sent === "down") pane.screen = omoFormScreen(++at);
        if (sent === "enter") pane.screen = "Working…";
      };
      const prompt = (await card())!;
      expect(prompt).not.toBeNull();
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["alt+up", "down", "enter"]);
    });
  });

  test.skipIf(process.platform !== "linux")("matches the call even when the full form reveals another question already answered", async () => {
    await withOmo(async (pane) => {
      const entry = JSON.parse(omoCall("q1"));
      entry.message.content[0].arguments.questions.push({ header: "Later", question: "Another?", options: [{ label: "Yes" }] });
      appendFileSync(pane.omo!.path, JSON.stringify(entry) + "\n");
      let at = 0;
      const draw = () => omoFormScreen(at).replace("→ QA    Submit", "→ QA    Later ✓    Submit").replace("0/1 answered", "1/2 answered");
      pane.onSent = (sent) => {
        if (sent === "down") at++;
        if (sent === "alt+up" || sent === "down") pane.screen = draw();
        if (sent === "enter") pane.screen = "Working…";
      };
      const prompt = (await card())!;
      expect(prompt.steps).toHaveLength(2);
      expect((await answer(prompt.id, { option_index: 1 })).status).toBe(200);
      expect(pane.sent).toEqual(["alt+up", "down", "enter"]);
    });
  });

  test.skipIf(process.platform !== "linux")("types a digit-prefixed reply only after opening the question's own answer field", async () => {
    await withOmo(async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "alt+up" || sent === "backspace") pane.screen = omoFormScreen(at);
        if (sent === "down") pane.screen = omoFormScreen(++at);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "2 please" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["alt+up", "backspace", "down", "down", "enter", "text:2 please", "enter"]);
    });
  });

  test.skipIf(process.platform !== "linux")("rejects an identical replacement call before sending any key", async () => {
    await withOmo(async (pane) => {
      const first = (await card())!;
      appendFileSync(pane.omo!.path, JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: "q1" } }) + "\n" + omoCall("q2"));
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test.skipIf(process.platform !== "linux")("rechecks the live OmO process before answering a cached-looking widget", async () => {
    await withOmo(async (pane) => {
      const first = (await card())!;
      pane.omo!.live = false;
      // Even an exact copy of the widget, without an obvious shell marker, is no longer owned.
      expect(await answer(first.id, { custom_text: "echo wrong target" })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect(await card()).toBeNull();
    });
  });

  test.skipIf(process.platform !== "linux")("sends no answer if opening the widget reveals another question", async () => {
    await withOmo(async (pane) => {
      const first = (await card())!;
      pane.onSent = () => { pane.screen = omoFormScreen(0, "Delete the workspace?"); };
      expect(await answer(first.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["alt+up"]);
    });
  });

  test.skipIf(process.platform !== "linux")("offers a reply-only card when the call has no predefined options", async () => {
    await withOmo(async (pane) => {
      writeFileSync(pane.omo!.path, JSON.stringify({ type: "session", id: "qa-session-488", cwd: pane.cwd }) + "\n" + omoCall("reply-only", []).replace(',"options":[]', ""));
      pane.screen = omoWidget().replace("[ First ] [ Second ] ", "");
      const prompt = (await card())!;
      expect(prompt.options).toEqual([]);
      expect(prompt.custom_option_index).toBe(0);
      pane.onSent = (sent) => { if (sent === "alt+up" || sent === "backspace") pane.screen = omoFormScreen(0, "Which one?", []); };
      expect((await answer(prompt.id, { custom_text: "my answer" })).status).toBe(200);
      expect(pane.sent).toEqual(["alt+up", "backspace", "enter", "text:my answer", "enter"]);
    });
  });

  /** Codex's continue menu with its cursor on `at` */
  const menu = (rows: string[], at = 0, above = "Conversation interrupted") =>
    `${above}\n\n${rows.map((row, index) => `${index === at ? "›" : " "} ${index + 1}. ${row}`).join("\n")}\n\nPress enter to continue\n`;
  const RESUME = ["Resume the task", "Start over", "Quit"];
  const DELETE = ["Keep the branch", "Delete the branch", "Quit"];
  const gjcSelector = (at = 0, rows = ["OpenAI-compatible", "Anthropic-compatible"]) =>
    `Step 1: Compatibility\n\n${rows.map((row, index) => `${index === at ? "❯" : " "} ${row}`).join("\n")}\n[↑↓ to navigate, Enter to select, Esc to cancel]\n`;

  /** the pane as a menu would run it: ↓ and ↑ move the cursor, and the screen shows it */
  function moving(pane: Pane, rows: string[], draw: (at: number) => string = (at) => menu(rows, at), start = 0): void {
    let at = start;
    pane.onSent = (sent) => {
      if (sent === "down") at = Math.min(rows.length - 1, at + 1);
      if (sent === "up") at = Math.max(0, at - 1);
      // what is typed shows in the menu's own row
      pane.screen = draw(at) + (sent.startsWith("text:") ? `\n${sent.slice(5)}\n` : "");
    };
  }

  test("shows a GJC startup selector even before the pane is reported blocked", async () => {
    await withPane("gjc", "idle", gjcSelector().replace("[↑↓ to navigate, Enter to select, Esc to cancel]", "up/down navigate  enter select  esc cancel"), async () => {
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(["OpenAI-compatible", "Anthropic-compatible", "Esc"]);
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
    });
  });

  test("answers GJC's unnumbered selector after confirming its moved cursor", async () => {
    await withPane("gjc", "blocked", gjcSelector(), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") at = Math.min(1, at + 1);
        if (sent === "up") at = Math.max(0, at - 1);
        pane.screen = gjcSelector(at);
      };
      const prompt = (await card())!;
      expect(prompt.fallback).toBe(true);
      expect(labels(prompt)).toEqual(["OpenAI-compatible", "Anthropic-compatible", "Esc"]);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("does not confirm a changed GJC selector after moving its cursor", async () => {
    await withPane("gjc", "blocked", gjcSelector(), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = (sent) => { if (sent === "down") pane.screen = gjcSelector(1, ["Resume", "Delete"]); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("checks a GJC selector after each move and stops once it is gone", async () => {
    const rows = ["First", "Second", "Third", "Fourth"];
    await withPane("gjc", "blocked", gjcSelector(0, rows), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => { if (sent === "down") pane.screen = gjcSelector(++at, rows); };
      expect(await answer((await card())!.id, { option_index: 3 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "down", "enter"]);
    });
    await withPane("gjc", "blocked", gjcSelector(0, rows), async (pane) => {
      const prompt = (await card())!;
      // the selector dismissed after the first move: the composer takes the keys now
      pane.onSent = (sent) => { if (sent === "down") pane.screen = "Ready\n\n❯ \n"; };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("moves to the row and confirms it while the menu stays the card's", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(RESUME);
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
    });
  });

  /** Claude's question with option previews, its cursor on `at`: the box is redrawn for the option under it */
  const previewQuestion = (at: number): string => {
    const rows = ["Grid", "List"];
    const box = ["┌──────────────────┐", `│ ${rows[at]!.padEnd(16)} │`, "└──────────────────┘"];
    const option = (row: string, index: number) => `${index === at ? "❯" : " "} ${index + 1}. ${row.padEnd(20)}${box[index] ?? ""}`;
    return `${"─".repeat(80)}\n←  ☐ Layout  ✔ Submit  →\n\nWhich layout?\n\n${rows.map(option).join("\n")}\n${" ".repeat(25)}${box[2]}\n\n${" ".repeat(25)}Notes: press n to add notes\n\n${"─".repeat(80)}\n  Chat about this\n\nEnter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel\n`;
  };

  test("moves to a previewed option and confirms it while the box is redrawn for it", async () => {
    await withPane("claude", "blocked", previewQuestion(0), async (pane) => {
      moving(pane, ["Grid", "List"], previewQuestion);
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(["Grid", "List"]);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("waits out a screen caught half drawn after a move", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // the ↓ clears the menu before it draws it again: a read in between finds no menu at all
      pane.onSent = (sent) => {
        if (sent !== "down") return;
        pane.screen = "";
        setTimeout(() => { pane.screen = menu(RESUME, 1); }, 80);
      };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("presses no Enter into a menu that took the place of the card's under its moves", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // answered in the terminal as the answer's ↓ went out, and another menu asks under it:
      // its second row, which the Enter would take, deletes a branch
      pane.onSent = () => { pane.screen = menu(DELETE, 1, "Branch cleanup"); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("presses no Enter on a row an arrow key typed in the terminal moved the cursor to", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = menu(RESUME, 2); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("the cursor's row is no part of what a menu says: the same card wherever it stands", () => {
    const id = (screen: string) => parseInteractivePrompt("codex", screen)!.id;
    expect(id(menu(RESUME, 2))).toBe(id(menu(RESUME, 0)));
  });

  const QUESTION = (rows: string[], at: number) => `
☐ Dataset

Which evaluation dataset should we use?

${rows.map((row, index) => `${index === at ? "❯" : " "} ${index + 1}. ${row}`).join("\n")}
────────────────────────────
  ${rows.length + 1}. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const DATASETS = ["LM-O", "YCB-V", "Type something."];

  test("types a custom answer only into the question it was written for", async () => {
    await withPane("claude", "blocked", QUESTION(DATASETS, 0), async (pane) => {
      moving(pane, DATASETS, (at) => QUESTION(DATASETS, at));
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "the internal set" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "text:the internal set", "enter"]);
    });
    await withPane("claude", "blocked", QUESTION(DATASETS, 0), async (pane) => {
      const prompt = (await card())!;
      // another question by the time the cursor is down: the text would be typed into its row
      pane.onSent = () => { pane.screen = QUESTION(["main", "release", "Type something."], 2); };
      expect(await answer(prompt.id, { custom_text: "the internal set" })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down", "down"]);
    });
  });

  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const dialog = (title: string, rows: string[], at: number) =>
    `────────────────────────────────────────\n\n ${title}\n\n${rows.map((row, index) => `${index === at ? " → " : "   "}${row}`).join("\n")}\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`;
  const ALLOW = ["Allow once", "Always allow", "Block"];

  test("answers pi's dialog once its cursor is on the row, and no other dialog in its place", async () => {
    // pi stays idle while a dialog waits, and a dialog with its cursor off the first row has no card
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      moving(pane, ALLOW, (at) => dialog("Allow dangerous command?", ALLOW, at));
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
    });
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = dialog("Delete the session?", ["Keep it", "Delete it"], 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("presses no Enter once the asking ended under its moves, though the same menu shows again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // herdr reports the agent back at work as the ↓ goes out (answered in the terminal), and the
      // same menu is asked again with its cursor on the very row: the screen alone says nothing
      pane.onSent = () => { promptWaitEnded("p_1"); pane.screen = menu(RESUME, 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { promptWaitEnded("p_1"); pane.screen = dialog("Allow dangerous command?", ALLOW, 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("a read by another device while the answer redraws the menu ends no asking", async () => {
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      let at = 0;
      let polled: Promise<InteractivePrompt | null> | undefined;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        pane.screen = dialog("Allow dangerous command?", ALLOW, at);
        // pi's dialog with its cursor off the first row has no card: this poll reads none
        polled ??= card();
      };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
      expect(await polled).toBeNull();
    });
  });

  test("starts nothing that cannot be undone for a request that was given up", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      const abort = new AbortController();
      const moved = pane.onSent!;
      pane.onSent = (sent) => { moved(sent); abort.abort(); };
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, { method: "POST", signal: abort.signal, body: JSON.stringify({ pane_id: "p_1", prompt_id: prompt.id, option_index: 1 }) }), url))!;
      expect(response.status).toBe(409);
      expect(pane.sent).toEqual(["down"]);
    });
  });

  const OMP = (rows: string[], at: number, question = "Which target?") => `
╭─ Ask ───────────────────╮
│ ${question}
├─────────────────────────┤
${rows.map((row, index) => `│${index === at ? "❯" : " "} ○ ${row}`).join("\n")}
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`;
  const TARGETS = ["Jetson Orin", "RK3588", "Other (type your own)"];

  test("types omp's custom answer into the row its Enter opens", async () => {
    await withPane("omp", "blocked", OMP(TARGETS, 0), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        // the row's Enter opens an editor no reader knows, and what is typed shows in it
        pane.screen = sent === "enter" ? "Other:\n> \n" : sent.startsWith("text:") ? `Other:\n> ${sent.slice(5)}\n` : OMP(TARGETS, at);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "an x86 box" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter", "text:an x86 box", "enter"]);
    });
  });

  const input = (question: string, typed = "") => `────────────────────────────────────────\n\n ${question}\n\n> ${typed}\n enter submit  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`;

  test("answers pi's text dialog", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      pane.onSent = (sent) => { if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5)); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["ctrl+k", "ctrl+u", "text:fix/answers", "enter"]);
    });
  });

  const CHECKS = (rows: string[], at: number, ticked: number[] = [], question = "Which checks should run?") => `
☐ Checks

${question}

${rows.map((row, index) => `${index === at ? "❯" : " "} ${index + 1}. ${index < rows.length - 1 ? `[${ticked.includes(index) ? "✓" : " "}] ` : ""}${row}`).join("\n")}
────────────────────────────
  ${rows.length + 1}. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const KINDS = ["Lint", "Tests", "Type something."];

  test("ticks a multiple choice row by row", async () => {
    await withPane("claude", "blocked", CHECKS(KINDS, 0), async (pane) => {
      let at = 0;
      const ticked: number[] = [];
      pane.onSent = (sent) => { if (sent === "down") at += 1; if (sent === "enter") ticked.push(at); pane.screen = CHECKS(KINDS, at, ticked); };
      const prompt = (await card())!;
      expect(prompt.multi_select).toBe(true);
      expect(await answer(prompt.id, { option_indices: [0, 1] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter", "down", "enter", "right"]);
    });
  });

  // This route looks at the screen before the first key that is not a move, and never after it:
  // from there on an answer's keys are the ones it always sent, whatever the screen shows.
  test("after its first key that is not a move, an answer sends the rest of its keys unseen", async () => {
    const cases: { agent: string; status: string; screen: string; choice: Parameters<typeof answer>[1] }[] = [
      { agent: "claude", status: "blocked", screen: QUESTION(DATASETS, 2), choice: { custom_text: "the internal set" } },
      { agent: "claude", status: "blocked", screen: CHECKS(KINDS, 0), choice: { option_indices: [0, 1] } },
      { agent: "pi", status: "idle", screen: input("Branch name?"), choice: { custom_text: "fix/answers" } },
      { agent: "omp", status: "blocked", screen: OMP(TARGETS, 2), choice: { custom_text: "an x86 box" } },
    ];
    for (const { agent, status, screen, choice } of cases) {
      await withPane(agent, status, screen, async (pane) => {
        // what the answer's keys are, as main sends them
        const keys = answerKeys(parseInteractivePrompt(agent, screen)!, choice).flatMap((step) => step.keys ?? [`text:${step.text}`]);
        expect(keys.length).toBeGreaterThan(1);
        const prompt = (await card())!;
        // the screen is something else from the first key on
        pane.onSent = () => { pane.screen = "Working…\n"; };
        expect(await answer(prompt.id, choice)).toEqual({ status: 200, code: undefined });
        expect(pane.sent).toEqual(keys);
      });
    }
  });

  test("leaves Codex's queue alone while the question just answered is still on the screen", async () => {
    const open = "\n• Queued follow-up inputs\n  Which split?\n  › 1. train\n    2. test\n    3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n";
    await withPane("codex", "working", open, async (pane) => {
      // Codex takes the Enter a moment later: the question is still drawn at the first look,
      // then the main prompt has the input back, with nothing left to close
      pane.onSent = (sent) => { if (sent === "enter") setTimeout(() => { pane.screen = "› Ask Codex to do anything\n"; }, 150); };
      const prompt = (await card())!;
      expect(prompt.queued).toBe("open");
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("Codex back at work says nothing about a question in its queue", async () => {
    const open = "\n• Queued follow-up inputs\n  Which split?\n  › 1. train\n    2. test\n    3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n";
    await withPane("codex", "working", open, async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") { at += 1; pane.screen = open.replace("› 1. train\n    2. test", "  1. train\n  › 2. test"); }
        // Codex asks while it works, and herdr reports it working again under the answer's move
        promptWaitEnded("p_1");
        if (sent === "enter") pane.screen = "› Ask Codex to do anything\n";
      };
      const prompt = (await card())!;
      promptWaitEnded("p_1");
      expect((await card())!.id).toBe(prompt.id);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(at).toBe(1);
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("sends nothing for a request given up before its turn, even to the row the cursor is on", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      const abort = new AbortController();
      abort.abort();
      expect((await answer(prompt.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
    // and a fallback card's single key
    await withPane("gjc", "blocked", "Which environment?\n\n  1. Staging\n  2. Production\n\nEnter a number, or Esc to cancel\n", async (pane) => {
      const prompt = (await card())!;
      expect(prompt.fallback).toBe(true);
      const abort = new AbortController();
      abort.abort();
      expect((await answer(prompt.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
  });

  // An ordinary answer that needs a move, on a screen drawn again the way each agent draws it
  // with the cursor on another row: every reader must still know its own menu there.
  describe("moves to a row that is not the cursor's and answers it", () => {
    const rule = "─".repeat(120);
    const omoFooter = `${rule}\n/private/tmp/omo-ask${" ".repeat(74)}[----------] 42K/1M (4.2%)\n${" ".repeat(86)}claude-opus-5-5 · high · OmO 5.1.7\n`;
    const mark = (at: number, row: number, on = "❯") => at === row ? on : " ";
    const cases: { name: string; agent: string; status?: string; rows: number; start?: number; draw: (at: number, ticked: number[]) => string; choice: Parameters<typeof answer>[1]; sent: string[] }[] = [
      {
        name: "omp's permission: Deny", agent: "omp", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n╭─ Permission ────────────╮\n│ Allow tool: bash        │\n│ curl -I example.com     │\n│${mark(at, 0)} Approve               │\n│${mark(at, 1)} Deny                  │\n╰─────────────────────────╯\n`,
      },
      {
        name: "omp's question", agent: "omp", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => OMP(TARGETS, at),
      },
      {
        name: "omp's multiple choice", agent: "omp", rows: 4, choice: { option_indices: [0, 2] }, sent: ["space", "down", "down", "space", "tab", "enter"],
        draw: (at, ticked) => `\n╭─ Ask ───────────────────╮\n│ Which checks?           │\n├─────────────────────────┤\n${["Lint", "Tests", "Build", "Other (type your own)"].map((row, index) => `│${mark(at, index)} ${ticked.includes(index) ? "☑" : "☐"} ${row}`).join("\n")}\n├─────────────────────────┤\n│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel\n╰─────────────────────────╯\n`,
      },
      {
        name: "Codex's approval", agent: "codex", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nWould you like to run the following command?\necho first\n${mark(at, 0, "›")} 1. Yes, proceed\n${mark(at, 1, "›")} 2. Yes, and don't ask again for this command\n${mark(at, 2, "›")} 3. No, cancel\nPress enter to confirm or esc to cancel\n`,
      },
      {
        name: "Codex's question", agent: "codex", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nWhich backend?\n\n${mark(at, 0, "›")} 1. CUDA\n${mark(at, 1, "›")} 2. CPU\n${mark(at, 2, "›")} 3. None of the above  Add details in notes (tab).\n\ntab to add notes | enter to submit answer | esc to interrupt\n`,
      },
      {
        name: "Claude's approval, to its last row", agent: "claude", rows: 3, choice: { option_index: 2 }, sent: ["down", "down", "enter"],
        draw: (at) => `\nBash command\n\n  curl -I https://example.com\n  Fetch HTTP headers.\n\nThis command requires approval\n\nDo you want to proceed?\n${mark(at, 0)} 1. Yes\n${mark(at, 1)} 2. Yes, and don’t ask again for: curl *\n${mark(at, 2)} 3. No\n\nEsc to cancel · Tab to amend · ctrl+e to explain\n`,
      },
      {
        name: "Claude's plan", agent: "claude", rows: 4, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nReady to code?\n\nHere is Claude's plan:\nAdd a heading to the README file.\n\nClaude has written up a plan and is ready to execute. Would you like to proceed?\n\n${mark(at, 0)} 1. Yes, auto-accept edits\n${mark(at, 1)} 2. Yes, manually approve edits\n${mark(at, 2)} 3. No, refine with Ultraplan on Claude Code on the web\n${mark(at, 3)} 4. Tell Claude what to change\n     shift+tab to approve with this feedback\n`,
      },
      {
        name: "Claude's review of its answers: Cancel", agent: "claude", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n←  ☒ Route  ☒ Author  ✔ Submit  →\nReview your answers\n ● Which way should the PR go?\n   → Log in as owner\n ● Who should author the commits?\n   → Repo owner\nReady to submit your answers?\n${mark(at, 0)} 1. Submit answers\n${mark(at, 1)} 2. Cancel\n`,
      },
      {
        name: "Claude's folder-trust check", agent: "claude", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n Accessing workspace:\n\n /home/user/projects/new-app\n\n Quick safety check: Is this a project you created or one you trust?\n\n ${mark(at, 0)} No, exit\n ${mark(at, 1)} Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`,
      },
      {
        name: "pi's confirmation: No", agent: "pi", status: "idle", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `────────────────────────────────────────\n\n Clear session?\n All messages will be lost.\n\n${[" Yes", " No"].map((row, index) => `${at === index ? " →" : "  "}${row}`).join("\n")}\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`,
      },
      {
        name: "pi's model list", agent: "pi", status: "idle", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `────────────────────────────────────────\n\nOnly showing models from configured providers. Use /login to add providers.\n>\n\n${at === 0 ? "→" : " "} ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n${at === 1 ? "→" : " "}   vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]\n Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel\n────────────────────────────────────────${FOOTER}`,
      },
      {
        // the last row drawn carries the cursor where it carried `↓`, under another effort line
        name: "Claude's model list, to the last row it draws", agent: "claude", status: "idle", rows: 10, start: 1, choice: { option_index: 9 },
        sent: [...Array.from({ length: 8 }, () => "down"), "text:s"],
        draw: (at) => claudeModelList(at),
      },
      {
        name: "Codex's model list: Enter, which there only opens the model's levels", agent: "codex", status: "done", rows: 7, start: 1, choice: { option_index: 4 },
        sent: ["down", "down", "down", "enter"],
        draw: (at) => codexModels(at),
      },
      {
        name: "Codex's reasoning levels: s, for this session", agent: "codex", status: "done", rows: 5, start: 1, choice: { option_index: 3 },
        sent: ["down", "down", "text:s"],
        draw: (at) => codexLevels(at),
      },
      {
        name: "Codex's reasoning levels, from the row that opens the advanced ones up to a level: s", agent: "codex", status: "done", rows: 5, start: 4, choice: { option_index: 0 },
        sent: ["up", "up", "up", "up", "text:s"],
        draw: (at) => codexLevels(at),
      },
      {
        name: "omo's review, from its comment up to an answer", agent: "pi", rows: 3, start: 2, choice: { option_index: 2 }, sent: ["up", "enter"],
        draw: (at) => `\n [표시 위치] [월 한도] wait for answer\n\n${rule}\n\n Ask user · 30m\n   표시 위치 ✓    월 한도 ✓  → Submit\n Review your answers\n ${at === 0 ? "→" : " "} 표시 위치: 설정 > 음성 입력 (추천)\n ${at === 1 ? "→" : " "} 월 한도: 월 $5 한도\n\n Comment (optional; unanswered questions are reported)\n>\n Submit (2/2 answered)\n ${at === 2 ? "enter submit  ↑ review answers  shift+tab back  tab next question  esc back" : "enter edit answer  ↑↓ move  tab next question  esc back"}\n${omoFooter}`,
      },
    ];
    for (const { name, agent, status = "blocked", rows, start = 0, draw, choice, sent } of cases) {
      test(name, async () => {
        await withPane(agent, status, draw(start, []), async (pane) => {
          let at = start;
          const ticked: number[] = [];
          pane.onSent = (key) => {
            if (key === "down") at = Math.min(rows - 1, at + 1);
            if (key === "up") at = Math.max(0, at - 1);
            if (key === "space") ticked.push(at);
            pane.screen = draw(at, ticked);
          };
          const prompt = (await card())!;
          expect(prompt).not.toBeNull();
          expect(await answer(prompt.id, choice)).toEqual({ status: 200, code: undefined });
          expect(pane.sent).toEqual(sent);
        });
      });
    }
  });

  test("picks Claude's model with s only where the list still shows that model under the cursor", async () => {
    // the cursor's own row: the list is looked at again, then the letter alone, and never an Enter
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["text:s"]);
    });
    // a pane made shorter under the moves: Claude draws five rows of the list, another card, and
    // the model under the cursor is still the one that was tapped
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += 1; pane.screen = claudeModelList(at, 0, 5); };
      expect(parseInteractivePrompt("claude", claudeModelList(3, 0, 5))!.id).not.toBe(parseInteractivePrompt("claude", claudeModelList(3))!.id);
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "text:s"]);
    });
  });

  test("sets Claude's effort with ←/→ and s only where the slider still stands over that level", async () => {
    await withPane("claude", "idle", claudeEffort(2), async (pane) => {
      let at = 2;
      pane.onSent = (sent) => {
        if (sent === "right") at = Math.min(4, at + 1);
        if (sent === "left") at = Math.max(0, at - 1);
        pane.screen = claudeEffort(at);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left", "left", "text:s"]);
    });
    // a key typed in the terminal at the same moment: ▲ over another level, so no letter
    await withPane("claude", "idle", claudeEffort(2), async (pane) => {
      pane.onSent = (sent) => { if (sent === "right") pane.screen = claudeEffort(4); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["right"]);
    });
  }, 20_000);

  // each refusal waits out the answer's own 1.5 s for the list to show the row
  test("types no s, and no further arrow, once Claude's model list is not the one that was tapped", async () => {
    // closed in the terminal right after the answer read it, with no move to wait on: the look
    // before the letter is what keeps it out of Claude's own prompt
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      // the card's read, the answer's own read of the card, then its look before the letter:
      // the list is still up for the second and gone for the third
      let reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 3) pane.screen = CLAUDE_MODEL_CLOSED; };
      const prompt = (await card())!;
      expect(reads).toBe(1);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      // the answer got past its own read (a list gone by then is refused at once, with two reads)
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(pane.sent).toEqual([]);
    });
    // closed in the terminal under the first move: no second arrow into Claude's own prompt,
    // where it would walk the prompt's history, and no letter
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = CLAUDE_MODEL_CLOSED; };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // a key typed in the terminal at the same moment, one more row down: another model's row
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += at === 1 ? 2 : 1; pane.screen = claudeModelList(at); };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // another list in its place under the last move, the same number and name on another model
    // (a list by family names the model in what the row says): not the row that was tapped
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      let at = 1;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        pane.screen = at === 3 ? claudeModelList(at).replace("Most efficient for simpler tasks", "Sonnet 5 · Efficient for routine tasks") : claudeModelList(at);
      };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down", "down"]);
    });
  }, 20_000);

  test("takes the key Codex's footer names for the row the cursor is on, and never Enter where it offers s", async () => {
    // a model with a single reasoning level picks from the first list: its row's footer offers s,
    // and Enter there would save it as the default
    const single = (row: number) => row === 3 ? CODEX_PICKS : CODEX_OPENS;
    await withPane("codex", "done", codexModels(1, single), async (pane) => {
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += 1; pane.screen = codexModels(at, single); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "text:s"]);
    });
    // the cursor's own row: looked at again, and the key is the one that look shows
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["text:s"]);
    });
    // Ultra's footer says apply for Enter: s all the same
    const advanced = (at: number) => codexList("Advanced Reasoning", [["Max", "For difficult problems"], ["Ultra", "For demanding work"]], at, (row) => row === 1 ? "  enter apply · s session · esc back" : CODEX_PICKS).replace(" (current)", "          ");
    await withPane("codex", "done", advanced(0), async (pane) => {
      pane.onSent = (sent) => { if (sent === "down") pane.screen = advanced(1); };
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(["Max", "Ultra"]);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
    });
  });

  test("answers a model list only once the pane shows what follows it, so its card does not come up again", async () => {
    // Codex draws a model's levels a moment after the Enter: the read right after the answer is theirs
    await withPane("codex", "done", codexModels(1), async (pane) => {
      pane.onSent = (sent) => { if (sent === "enter") setTimeout(() => { pane.screen = codexLevels(1); }, 200); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect((await card())!.question).toBe("Select reasoning level for GPT-6-Astra for this session (currently Medium). More levels are listed in the terminal.");
    });
    // and Claude closes its list a moment after the s: no card is left to read
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      pane.onSent = (sent) => { if (sent === "text:s") setTimeout(() => { pane.screen = CLAUDE_MODEL_CLOSED; }, 200); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(await card()).toBeNull();
    });
    // also where the pane was made shorter under the moves, and the list was another window by the s
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      let at = 1;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        pane.screen = claudeModelList(at, 0, 5);
        if (sent === "text:s") setTimeout(() => { pane.screen = CLAUDE_MODEL_CLOSED; }, 200);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
      expect(await card()).toBeNull();
    });
  });

  // each refusal waits out the answer's own 1.5 s for the list to show the row
  test("presses nothing in Codex's list once it is not the list, or the row, that was tapped", async () => {
    // the levels of another model in its place under the move: the same rows, another list
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = codexLevels(2, "GPT-6-Sol"); };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // closed in the terminal under the first move: no second arrow into Codex's own prompt
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = `${CODEX_HEAD}› Ask Codex to do anything\n\n  GPT-6-Astra medium · main\n`; };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // a footer this reader does not know under the row: not a key to guess
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = codexLevels(2).replace(CODEX_PICKS, "  enter default · esc back"); };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // a level's row whose footer turns out to say Enter opens a list: no Enter goes into a list
    // of levels, where the rows beside it save a default on that key
    const opening = (at: number) => codexList("Select Reasoning Level for GPT-6-Astra", CODEX_LEVELS, at, (row) => row === 2 || row === 4 ? CODEX_OPENS : CODEX_PICKS);
    await withPane("codex", "done", opening(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = (sent) => { if (sent === "down") pane.screen = opening(2); };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  }, 20_000);

  test("keeps fallback cards when a model title is only transcript text or belongs to another agent", async () => {
    const unknown = "Advanced Reasoning\nThis section explains the tradeoff.\n\nChoose a deployment target:\n  1. Staging\n  2. Production\n\nEnter a number, or Esc to cancel\n";
    for (const agent of ["claude", "pi", "omp", "codex"]) {
      await withPane(agent, "blocked", unknown, async () => {
        expect((await card())?.fallback).toBe(true);
      });
    }
    await withPane("codex", "blocked", `${codexModels(1)}\nContinue deployment?\n${CODEX_OPENS}\n`, async () => {
      expect((await card())?.fallback).toBe(true);
    });
    // Words before the footer are not a long, fictitious key name.
    await withPane("codex", "blocked", codexModels(1).replace(CODEX_OPENS, `Continue deployment\n${CODEX_OPENS}`), async () => {
      expect((await card())?.fallback).toBe(true);
    });
    // Even a Codex-shaped footer belongs to the other agent's unknown prompt here.
    await withPane("pi", "blocked", codexLevels(1), async () => {
      expect((await card())?.fallback).toBe(true);
    });
    // A newer picker title supersedes the older model heading in the visible transcript.
    const other = `Advanced Reasoning\n\nSelect Deployment Target\n\n› 1. Staging\n  2. Production\n\n${CODEX_OPENS}\n`;
    for (const screen of [other, other.replace("Select Deployment Target", "Choose a deployment target:"), other.replace("\n\nSelect Deployment Target", "\nSelect Deployment Target")]) {
      await withPane("codex", "blocked", screen, async () => {
        expect((await card())?.fallback).toBe(true);
      });
    }
  });

  test("offers no fallback card over a Codex list whose Enter would save a default", async () => {
    // rows this reader cannot take (something between them and their footer), under a status of
    // blocked left over from an approval: the fallback card's Enter is not offered here
    const unread = codexLevels(1).replace(`\n\n${CODEX_PICKS}`, `\n  Loading…\n${CODEX_PICKS}`);
    expect(parseInteractivePrompt("codex", unread)).toBeNull();
    expect(parseFallbackPrompt("codex", unread).options.map((option) => option.label)).toContain("Enter");
    await withPane("codex", "blocked", unread, async () => {
      expect(await card()).toBeNull();
    });
    // its footer cut beyond reading by a pane a few columns wide: the list's title still says what it is
    const cut = codexLevels(1).replace(CODEX_PICKS, "  enter\n  defa\n  ult ·\n  s\n  sessi\n  on ·\n  esc\n  back");
    expect(parseInteractivePrompt("codex", cut)).toBeNull();
    await withPane("codex", "blocked", cut, async () => {
      expect(await card()).toBeNull();
    });
    await withPane("codex", "blocked", `Loading\n${CODEX_PICKS}`, async () => {
      expect(await card()).toBeNull();
    });
    // A clipped title does not make a recognizable session/default footer safe to answer with Enter.
    await withPane("codex", "blocked", cut.replace("Select Reasoning Level for GPT-6-Astra", "Older transcript"), async () => {
      expect(await card()).toBeNull();
    });
    // An unreadable or remapped accept hint is still a model menu, not permission to offer Enter.
    for (const footer of ["  enter confirm · esc back", "  tab default · s session · esc back"]) {
      const unknown = codexLevels(1).replace(CODEX_PICKS, footer);
      expect(parseInteractivePrompt("codex", unknown)).toBeNull();
      await withPane("codex", "blocked", unknown, async () => {
        expect(await card()).toBeNull();
      });
    }
    // the list of quick presets has no card of its own, and no fallback one either
    await withPane("codex", "blocked", codexList("Select Model", CODEX_MODELS, 1, () => CODEX_OPENS), async () => {
      expect(await card()).toBeNull();
    });
    // a list the reader does take is its own card under any status
    await withPane("codex", "blocked", codexLevels(1), async (pane) => {
      pane.onSent = (sent) => { if (sent === "down") pane.screen = codexLevels(2); };
      const prompt = (await card())!;
      expect(prompt.fallback).toBeUndefined();
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
    });
  });

  test("offers no fallback card over Claude's model list, whose Enter would save a default", async () => {
    // a name the pane cut in two: no reader takes the list, and herdr reports the pane blocked
    // (a status left over from an approval): the fallback card's Enter is not offered here
    const unread = claudeModelList(1).replace("  ↓ 10. Opus 4.7               Best for everyday, complex tasks", "  ↓ 10. Opus\n        4.7                    Best for everyday, complex tasks");
    expect(parseInteractivePrompt("claude", unread)).toBeNull();
    expect(parseFallbackPrompt("claude", unread).options.map((option) => option.label)).toContain("Enter");
    await withPane("claude", "blocked", unread, async () => {
      expect(await card()).toBeNull();
    });
    // its hint wrapped further than the reader follows it, in a pane narrower than any measured
    const narrow = unread.replace(CLAUDE_MODEL_HINT, "  Enter to set as\n  default · s to use\n  this session\n  only · Esc to\n  cancel");
    await withPane("claude", "blocked", narrow, async () => {
      expect(await card()).toBeNull();
    });
    // a list the reader does take is its own card under any status
    await withPane("claude", "blocked", claudeModelList(1), async (pane) => {
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += 1; pane.screen = claudeModelList(at); };
      const prompt = (await card())!;
      expect(prompt.fallback).toBeUndefined();
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
    });
  });

  test("offers no fallback card, and holds pending input, over an effort slider whose hint the reader cannot take", async () => {
    // a hint cut inside a word, and one without the session-only key: the slider's Enter still
    // saves the level as the default, so neither the fallback card nor a pending message may press it
    const unread = [
      claudeEffort(2, "  ←/→ to adjust · Enter to confirm · s for this ses\n  sion only · Esc to cancel"),
      claudeEffort(2, "  ←/→ to adjust · Enter to confirm · Esc to cancel"),
    ];
    for (const screen of unread) {
      expect(parseInteractivePrompt("claude", screen)).toBeNull();
      expect(parseFallbackPrompt("claude", screen).options.map((option) => option.label)).toContain("Enter");
      expect(modelListWaits("claude", screen)).toBe(true);
      await withPane("claude", "blocked", screen, async () => {
        expect(await card()).toBeNull();
      });
    }
    // the same hint above later output belongs to an answered slider
    expect(modelListWaits("claude", `${unread[1]}Some later output\n`)).toBe(false);
  });

  test("a screen read that comes back after the wait authorises no key", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      const moved = pane.onSent!;
      pane.onSent = (sent) => { moved(sent); pane.readDelay = 1_800; };
      const started = Date.now();
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
      // cut off when the wait is over, not waited out
      expect(Date.now() - started).toBeLessThan(1_790);
    });
  }, 6_000);

  test("a lookup that herdr never answers is cut off with the wait", async () => {
    const collapsed = "\n• WAITING\n• Queued follow-up inputs\n  ? 1 question · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  GPT-6-Sol xhigh · ~/lab · Context 97% left\n";
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      pane.cwd = pane.root;
      const prompt = (await card())!;
      // under the move the screen is Codex's collapsed queue, whose card needs the pane's
      // rollout, and herdr does not say which one it is
      pane.onSent = () => { pane.agentUnanswered = true; pane.screen = collapsed; };
      const started = Date.now();
      expect((await answer(prompt.id, { option_index: 1 })).status).toBe(409);
      expect(pane.sent).toEqual(["down"]);
      expect(Date.now() - started).toBeLessThan(2_500);
    });
  }, 6_000);

  test("answers pi's text dialog on a herdr whose screen reads take 400 ms", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      pane.onSent = (sent) => { if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5)); };
      const prompt = (await card())!;
      pane.readDelay = 400;
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["ctrl+k", "ctrl+u", "text:fix/answers", "enter"]);
    });
  }, 10_000);

  test("goes on ticking a multiple choice whose descriptions a narrowed pane wraps", async () => {
    const described = (at: number, ticked: number[], narrow: boolean) => `
☐ Checks

Which checks should run?

${at === 0 ? "❯" : " "} 1. [${ticked.includes(0) ? "✓" : " "}] Lint
     ${narrow ? "Run the linters over\n     the whole repository" : "Run the linters over the whole repository"}
${at === 1 ? "❯" : " "} 2. [${ticked.includes(1) ? "✓" : " "}] ${narrow ? "Tests, unit and\n     integration" : "Tests, unit and integration"}
     ${narrow ? "Run every suite, which takes\n     about ten minutes" : "Run every suite, which takes about ten minutes"}
${at === 2 ? "❯" : " "} 3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    await withPane("claude", "blocked", described(0, [], false), async (pane) => {
      let at = 0;
      const ticked: number[] = [];
      // the pane is narrowed as the first tick goes out: the same options, wrapped
      pane.onSent = (sent) => { if (sent === "down") at += 1; if (sent === "enter") ticked.push(at); pane.screen = described(at, ticked, true); };
      const prompt = (await card())!;
      expect(prompt.options[0]!.description).toBe("Run the linters over the whole repository");
      expect(await answer(prompt.id, { option_indices: [0, 1] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter", "down", "enter", "right"]);
    });
  });

  test("answers a question of Codex's collapsed queue, and opens no queue for a request given up", async () => {
    const collapsed = "\n• WAITING\n• Queued follow-up inputs\n  ? 2 questions · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  GPT-6-Sol xhigh · ~/lab · Context 97% left\n";
    const open = (at: number) => `\n• Queued follow-up inputs\n  1 of 2\n  Which split?\n  ${at === 0 ? "›" : " "} 1. train\n  ${at === 1 ? "›" : " "} 2. test\n  ${at === 2 ? "›" : " "} 3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n`;
    const item = (payload: unknown) => `${JSON.stringify({ type: "response_item", payload })}\n`;
    const ask = (call: string, count = 1) => item({ type: "function_call", name: "request_user_input_async", call_id: call, arguments: JSON.stringify({ questions: Array.from({ length: count }, () => ({ title: "Which split?", options: ["train", "test"] })) }) });
    await withPane("codex", "working", collapsed, async (pane) => {
      const home = join(pane.root, "codex");
      mkdirSync(join(home, "sessions"), { recursive: true });
      pane.rollout = join(home, "sessions", "rollout.jsonl");
      pane.cwd = pane.root;
      // one call asks the same question twice: the card is the first of the two
      writeFileSync(pane.rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "t", source: "cli" } })}\n${ask("call_1", 2)}`);
      const queued = (await card(home))!;
      expect(queued.queued).toBe("collapsed");
      // another terminal client opens the queue between this answer's first read and its read
      // before alt+↑: the answer is refused, and the queue it did not open is not its to close
      let reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 2) pane.screen = open(0); };
      expect(await answer(queued.id, { option_index: 1 }, { codexHome: home })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      pane.screen = collapsed;
      pane.onRead = undefined;
      // refused with nothing sent, the card is still the one that was read
      expect((await card(home))!.id).toBe(queued.id);
      // a request given up while the screen is read before alt+↑ (the answer's second read,
      // after the one that finds the card) opens no queue
      const abort = new AbortController();
      reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 2) abort.abort(); };
      expect((await answer(queued.id, { option_index: 1 }, { signal: abort.signal, codexHome: home })).status).toBe(409);
      expect(pane.sent).toEqual([]);
      pane.onRead = undefined;
      // given up with nothing sent: the same card still
      expect((await card(home))!.id).toBe(queued.id);
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "alt+up") pane.screen = open(0);
        if (sent === "down") {
          at += 1;
          // the rollout catches up under the answer: another call asking the same thing
          appendFileSync(pane.rollout!, ask("call_2"));
          pane.screen = open(at);
        }
        if (sent === "enter") pane.screen = "› Ask Codex to do anything\n";
      };
      // neither the twin nor the rollout's news under the answer is a reason to refuse: the
      // question on the screen is the card's
      expect(await answer(queued.id, { option_index: 1 }, { codexHome: home })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["alt+up", "down", "enter"]);

      // The queue opens on another question than the card's, and the alt+↓ that closes it
      // again is pressed with its reply lost; another client has the queue open after that.
      // This request closes it no second time
      pane.sent.length = 0;
      pane.screen = collapsed;
      const later = (await card(home))!;
      const other = open(0).replace("Which split?", "Which metric?");
      pane.replyLostOn = "alt+down";
      pane.onSent = (sent) => { pane.screen = sent === "alt+up" || sent === "alt+down" ? other : pane.screen; };
      expect((await answer(later.id, { option_index: 0 }, { codexHome: home })).status).not.toBe(200);
      expect(pane.sent).toEqual(["alt+up", "alt+down"]);
    });
  });

  test("a key herdr may have pressed, its reply lost, has ended the asking", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      pane.replyLostOn = "enter";
      // herdr pressed the Enter and the answer never heard so: the route fails
      expect((await answer(first.id, { option_index: 0 })).status).not.toBe(200);
      expect(pane.sent).toEqual(["enter"]);
      pane.replyLostOn = undefined;
      // the same menu asked again is another asking: the old card's id answers nothing
      expect((await card())!.id).not.toBe(first.id);
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("a key that never reached herdr has ended nothing", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // herdr is gone between the answer's read and its Enter: nothing is pressed
      const socket = process.env["HERDR_SOCKET"]!;
      pane.onRead = () => { process.env["HERDR_SOCKET"] = join(pane.root, "gone.sock"); };
      try {
        expect((await answer(first.id, { option_index: 0 })).status).toBe(502);
      } finally { process.env["HERDR_SOCKET"] = socket; }
      pane.onRead = undefined;
      expect(pane.sent).toEqual([]);
      // the card is still the one to answer, with whatever was picked in it
      expect((await card())!.id).toBe(first.id);
    });
  });

  test("a read held up before its screen read ends the asking its empty screen shows", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // another device's read waits on herdr's snapshot
      pane.nextSnapshotDelay = 300;
      const held = card();
      // meanwhile an answer begins and is given up, with nothing sent
      const abort = new AbortController();
      pane.onRead = () => abort.abort();
      expect((await answer(first.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      pane.onRead = undefined;
      expect(pane.sent).toEqual([]);
      // the menu is answered in the terminal: the held read finds no prompt, and says so
      pane.screen = "Working…\n";
      pane.status = "working";
      expect(await held).toBeNull();
      // asked again as it was, it is another asking
      pane.screen = menu(RESUME);
      pane.status = "blocked";
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("a read that began under an answer and comes back after it changes nothing", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      const prompt = (await card())!;
      let late: Promise<InteractivePrompt | null> | undefined;
      pane.onSent = (sent) => {
        // another device reads the pane as the answer empties the line, catches the screen
        // between two draws, and herdr is slow to say so
        if (sent === "ctrl+k") { pane.nextRead = { text: "", delay: 400 }; late = card(); }
        if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5));
        if (sent === "enter") pane.screen = input("Delete which branch?");
      };
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      // the next dialog has its card before that read is back
      const next = (await card())!;
      expect(next.question).toBe("Delete which branch?");
      expect(await late!).toBeNull();
      // and it is still that card: the late read ended no asking
      expect((await card())!.id).toBe(next.id);
      pane.onSent = undefined;
      expect((await answer(next.id, { custom_text: "old/one" })).status).toBe(200);
    });
  });

  test("an asking is kept however many panes ask", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      pane.more = 257;
      const first = (await card())!;
      for (let index = 2; index <= 258; index += 1) expect(await card(undefined, `p_${index}`)).not.toBeNull();
      expect((await card())!.id).toBe(first.id);
    });
  }, 20_000);

  test("a prompt keeps its id from read to read while it waits", async () => {
    await withPane("codex", "blocked", menu(RESUME), async () => {
      const first = (await card())!;
      expect((await card())!.id).toBe(first.id);
      // and it is not the hash of its text alone
      expect(first.id).not.toBe(parseInteractivePrompt("codex", menu(RESUME))!.id);
    });
  });

  test("refuses an answer to a prompt that went away and was asked again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // answered in the terminal: a read finds no menu, then the same menu asked again
      pane.screen = "Working…\n";
      pane.status = "working";
      expect(await card()).toBeNull();
      pane.screen = menu(RESUME);
      pane.status = "blocked";
      const second = (await card())!;
      expect(labels(second)).toEqual(labels(first));
      expect(second.id).not.toBe(first.id);
      // the first asking's card, still open on another device (or its typed pick's Confirm)
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect(await answer(second.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("refuses a second answer to the id of a prompt already answered, the same one asked again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // the screen never changes: answered, the menu is asked again as it was
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["enter"]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("refuses an answer to a prompt asked again after the agent went back to work unseen", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // answered in the terminal and asked again between two reads: only herdr's status says so
      promptWaitEnded("p_1");
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });
});
