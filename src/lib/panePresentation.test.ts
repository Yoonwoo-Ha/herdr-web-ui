import { expect, it } from "bun:test";
import { ConversationFinishEvidence, conversationFinishPresented, paneCovered, PANE_COVER_SELECTOR } from "./panePresentation.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";

for (const source of ["claude-transcript", "codex-transcript"] as const) {
  it(`${source} requires the newest answer's native final marker, not an earlier complete turn`, () => {
    const done: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] };
    const user: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "Next request" }] };
    const partial: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "Still working", phase: "commentary" }] };
    expect(conversationFinishPresented({ source, turns: [done] })).toBe(true);
    for (const turns of [[], [done, user], [done, user, partial],
      [{ ...partial, parts: [{ kind: "text" as const, text: "Unlabelled prose" }] }],
      [{ ...done, parts: [...done.parts, { kind: "thinking" as const, text: "More work" }] }]]) {
      expect(conversationFinishPresented({ source, turns })).toBe(false);
    }
  });
}

for (const source of ["omp-transcript", "omo-transcript", "gjc-transcript", "pi-transcript", "opencode-transcript", "grok-transcript", "devin-transcript", "hermes-transcript", "agy-transcript"] as const) {
it(`${source} does not accept prose without native completion evidence`, () => {
  const conversation = { source, turns: [
    { role: "assistant", ts: null, parts: [{ kind: "text", text: "Native stop" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  expect(conversationFinishPresented(conversation)).toBe(false);
  expect(new ConversationFinishEvidence().accept(source, 1, conversation)).toBe(false);
});
}

it("looks past only informational and local-command notices, never new user work", () => {
  const answer: ConversationTurn = { role: "assistant", ts: "2026-10-19T00:00:00Z", parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] };
  for (const source of ["informational", "local-command"]) {
    expect(conversationFinishPresented({ source: "claude-transcript", turns: [
      answer, { role: "user", ts: null, parts: [{ kind: "notice", text: "Notice", source }] },
    ] })).toBe(true);
  }
  expect(conversationFinishPresented({ source: "claude-transcript", turns: [
    answer, { role: "user", ts: null, parts: [{ kind: "notice", text: "Work arrived", source: "async-result" }] },
  ] })).toBe(false);
});

it("binds a completed answer to one finish and rejects unchanged new-finish responses", () => {
  const evidence = new ConversationFinishEvidence();
  const first = { source: "pi-transcript" as const, history_id: "session", turns: [
    { role: "assistant" as const, ts: "2026-10-19T00:00:00Z", parts: [{ kind: "text" as const, text: "First", phase: "final_answer" as const }] },
  ] };
  expect(evidence.accept("pc:epoch:pane", 1, first)).toBe(true);
  expect(evidence.accept("pc:epoch:pane", 1, first, first)).toBe(true);
  expect(evidence.accept("pc:epoch:pane", 2, first, first)).toBe(false);
  expect(evidence.accept("pc:epoch:pane", 2, structuredClone(first), first)).toBe(false);
  const older = structuredClone(first);
  older.turns[0]!.ts = "2026-10-18T00:00:00Z";
  older.turns[0]!.parts[0]!.text = "A different but older answer";
  expect(evidence.accept("pc:epoch:pane", 2, older, first)).toBe(false);
  const decorated = structuredClone(first);
  Object.assign(decorated.turns[0]!, { end_ts: first.turns[0]!.ts });
  decorated.turns[0]!.parts[0]!.text = "Rewritten old answer, same completed turn";
  expect(evidence.accept("pc:epoch:pane", 2, decorated, first)).toBe(false);
  const lateMetadata = structuredClone(first);
  Object.assign(lateMetadata.turns[0]!, { end_ts: "2026-10-19T00:02:00Z" });
  expect(evidence.accept("pc:epoch:pane", 2, lateMetadata, first)).toBe(false);
  const next = structuredClone(first);
  next.turns[0]!.ts = "2026-10-19T00:01:00Z";
  next.turns[0]!.parts[0]!.text = "Second";
  expect(evidence.accept("pc:epoch:pane", 2, next, first)).toBe(true);
  expect(evidence.accept("pc:epoch:pane", 1, first)).toBe(false);
  expect(evidence.accept("pc:new-epoch:pane", 1, first)).toBe(true);
  expect(evidence.accept("pending-scope", 2, { ...first, turns: [] })).toBe(false);
  expect(evidence.accept("pending-scope", 1, first)).toBe(false);
  expect(evidence.accept("pending-scope", 2, next)).toBe(true);
  evidence.observe("unread-scope", 2);
  expect(evidence.accept("unread-scope", 1, next)).toBe(false);
  expect(evidence.accept("unread-scope", 2, next)).toBe(true);
  expect(evidence.accept("skipped-scope", 1, first)).toBe(true);
  expect(evidence.accept("skipped-scope", 3, next)).toBe(false);
  const third = structuredClone(next);
  third.turns[0]!.ts = "2026-10-19T00:02:00Z";
  third.turns[0]!.parts[0]!.text = "Third";
  expect(evidence.accept("skipped-scope", 3, third)).toBe(true);
  const local = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "pc:epoch:pane" ? JSON.stringify({ id: 1, at: 1, answer: evidence.answer("pc:new-epoch:pane", 1) }) : null,
  } });
  try {
    const reloaded = new ConversationFinishEvidence();
    expect(reloaded.accept("pc:epoch:pane", 2, structuredClone(first))).toBe(false);
    expect(reloaded.accept("pc:epoch:pane", 2, structuredClone(next))).toBe(true);
  } finally {
    if (local) Object.defineProperty(globalThis, "localStorage", local);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

/** Exercise the production selector with Bun's CSS selector engine, not a string assertion. */
async function covered(html: string): Promise<boolean> {
  let matched = false;
  await new HTMLRewriter().on(PANE_COVER_SELECTOR, { element() { matched = true; } })
    .transform(new Response(html)).text();
  return matched;
}

it("treats a composer's slash or file listbox popup as covering the pane", async () => {
  expect(await covered('<div class="menu composer-menu"><div role="listbox"><button role="option">Option</button></div></div>')).toBe(true);
});

it("treats the failed-suggestions popup as coverage even without a listbox role", async () => {
  expect(await covered('<div class="menu composer-menu"><div class="composer-menu-group"><p class="chat-inline-error">Failed</p></div></div>')).toBe(true);
});

it("leaves a docked file panel and a plain inline listbox uncovered", async () => {
  expect(await covered('<aside class="file-panel"><section class="file-viewer file-viewer-docked"></section></aside><div role="listbox"></div>')).toBe(false);
});

it("ignores retained hidden covers without ignoring another presented dialog", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const nodes = [
    { closest: () => ({}), getClientRects: () => [{}], visibility: "visible" },
    { closest: () => null, getClientRects: () => [], visibility: "visible" },
    { closest: () => null, getClientRects: () => [{}], visibility: "hidden" },
  ];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => nodes } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (node: { visibility: string }) => node });
  try {
    expect(paneCovered()).toBe(false);
    nodes.push({ closest: () => null, getClientRects: () => [{}], visibility: "visible" });
    expect(paneCovered()).toBe(true);
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
    if (beforeStyle) Object.defineProperty(globalThis, "getComputedStyle", beforeStyle);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});
