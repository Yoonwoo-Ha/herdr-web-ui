import { describe, expect, test } from "bun:test";
import type { InteractivePrompt } from "../shared/protocol.ts";

import { answerKeys, codexQuestionsCollapsed, codexQueuedPrompt, parseInteractivePrompt } from "./prompt.ts";

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
      title: "Question",
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
      none: "› Ask Codex to do anything\n",
    };
    const shown = Object.fromEntries(Object.entries(screens).map(([name, screen]) => [name, [codexQueuedPrompt(screen, asked) !== null, codexQuestionsCollapsed(screen)]]));
    expect(shown).toEqual({ collapsed: [true, true], queuedMessage: [false, false], somethingBelow: [false, false], noHint: [false, false], none: [false, false] });
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
