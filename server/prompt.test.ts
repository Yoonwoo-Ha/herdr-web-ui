import { describe, expect, test } from "bun:test";
import type { InteractivePrompt } from "../shared/protocol.ts";

import { answerKeys, codexQuestionsCollapsed, parseInteractivePrompt } from "./prompt.ts";

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
    expect(asyncQuestion).toMatchObject({ kind: "question", question: "Which accelerator?", custom_option_index: null });
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
