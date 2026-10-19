import { expect, it } from "bun:test";

import { OpenCodePromptState } from "./prompt.ts";

it("removes closed panes from retained OpenCode state", () => {
  const state = new OpenCodePromptState();
  state.begin("pane", "ses_fixture01").draft = { formId: "form", stepIndex: 1, answers: { q0: "buffered" }, updatedAt: 0 };
  state.reconcile([]);
  expect(state.entries.size).toBe(0);
});

it("caps retained OpenCode panes", () => {
  const state = new OpenCodePromptState();
  for (let i = 0; i < 65; i++) state.begin(`pane_${i}`, "ses_fixture01");
  expect(state.entries.size).toBe(64);
  expect(state.entries.has("pane_0")).toBe(false);
});

it("expires OpenCode drafts without browser polling", () => {
  let now = 0;
  const state = new OpenCodePromptState(() => now);
  state.begin("pane", "ses_fixture01");
  now = 30 * 60_000;
  state.prune();
  expect(state.entries.size).toBe(0);
});

it("clears the owning server's retained drafts", () => {
  const state = new OpenCodePromptState();
  state.begin("pane", "ses_fixture01").draft = { formId: "form", stepIndex: 1, answers: { q0: "buffered" }, updatedAt: 0 };
  state.clear();
  expect(state.entries.size).toBe(0);
});
