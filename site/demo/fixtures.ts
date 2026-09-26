/**
 * The fictional session behind the README media (scripts/readme-media/stage.ts) and the browser
 * demo (site/demo/transport.ts): five panes, their curated chats and one Codex approval. Nothing
 * here comes from a real machine. It imports no server code, so the browser bundle can take it.
 */
import type { ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";

export interface DemoSpec {
  key: string;
  /** the workspace's label and the folder name under the demo root */
  label: string;
  /** the pane's title */
  title: string;
  agent: string | null;
  state?: "idle" | "working" | "blocked";
}

export const SPECS: DemoSpec[] = [
  { key: "api", label: "checkout-api", title: "Idempotent payments", agent: "claude", state: "working" },
  { key: "web", label: "web-dashboard", title: "Guard the export button", agent: "codex", state: "blocked" },
  { key: "infra", label: "infra", title: "Why did the backup fail?", agent: "gjc", state: "idle" },
  { key: "docs", label: "docs-site", title: "Proofread the guide", agent: "omo", state: "idle" },
  { key: "shell", label: "release", title: "Tag v1.4.0", agent: null },
];

export const t = (min: number, sec = 0) => `2026-09-25T09:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
const tool = (name: string, summary: string, input: unknown, output: string): ConversationTurn["parts"][number] => ({ kind: "tool", name, summary, input: JSON.stringify(input, null, 2), output });

export const CHATS: Record<string, { turns: ConversationTurn[]; metadata: { model: string; reasoning_effort: string } }> = {
  api: {
    metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(2), parts: [{ kind: "text" as const, text: "Make `POST /payments` idempotent: a client retrying with the same `Idempotency-Key` must get the first response back, never a second charge. Cover it with tests." }] },
      { role: "assistant" as const, ts: t(2, 5), end_ts: t(4, 41), parts: [
        { kind: "text" as const, text: "I'll look at how payments are created and where a key could be stored." },
        tool("Grep", "Idempotency-Key", { pattern: "Idempotency-Key", path: "src" }, "src/routes/payments.ts:14: // TODO: honour Idempotency-Key"),
        tool("Read", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "export async function createPayment(req: Request) { … }"),
        tool("Edit", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "Updated src/routes/payments.ts"),
        tool("Write", "src/lib/idempotency.ts", { file_path: "src/lib/idempotency.ts" }, "Created src/lib/idempotency.ts"),
        tool("Bash", "bun test payments", { command: "bun test payments" }, " 14 pass\n 0 fail\nRan 14 tests across 2 files. [412ms]"),
        { kind: "text" as const, text: "Done. Retries are now safe:\n\n- **`src/lib/idempotency.ts`** stores the first response per key for 24 h, scoped to the API client, so two clients can reuse a key without colliding.\n- **`POST /payments`** replays the stored response for a repeated key, and answers `409` while the first request with that key is still in flight.\n- A repeated key with a **different body** is rejected with `422`, instead of silently returning the old payment.\n\n```ts\nconst cached = await idempotency.lookup(client.id, key, body);\nif (cached) return cached.response;\n```\n\nTests: 14 pass, including concurrent retries and a key reused with a changed amount. See https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ for the header's semantics." },
      ] },
      { role: "user" as const, ts: t(6), parts: [{ kind: "text" as const, text: "Nice. Now add a metric for replayed requests." }] },
      { role: "assistant" as const, ts: t(6, 3), parts: [
        { kind: "text" as const, text: "Adding a `payments_idempotent_replays_total` counter next to the existing request metrics." },
        tool("Read", "src/metrics.ts", { file_path: "src/metrics.ts" }, "export const requests = new Counter({ … })"),
        tool("Edit", "src/metrics.ts", { file_path: "src/metrics.ts" }, "Updated src/metrics.ts"),
      ] },
    ],
  },
  web: {
    metadata: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    turns: [
      { role: "user" as const, ts: t(1), parts: [{ kind: "text" as const, text: "Rate-limit the export button so a double click can't start two exports, then push the branch." }] },
      { role: "assistant" as const, ts: t(1, 4), end_ts: t(3, 20), parts: [
        tool("exec", "rg -n \"startExport\" src", { cmd: "rg -n \"startExport\" src" }, "src/pages/Reports.tsx:88:  onClick={() => startExport(filters)}"),
        tool("apply_patch", "src/pages/Reports.tsx", {}, "Success. Updated the following files:\nM src/pages/Reports.tsx"),
        tool("exec", "pnpm test --filter reports", { cmd: "pnpm test --filter reports" }, "✓ 9 tests passed"),
        { kind: "text" as const, text: "The button is disabled while an export runs, and a second click within the same run is ignored. Tests pass; I need your OK to push `feat/export-guard`." },
      ] },
    ],
  },
  infra: {
    metadata: { model: "glm-5.3", reasoning_effort: "med" },
    turns: [
      { role: "user" as const, ts: t(0), parts: [{ kind: "text" as const, text: "Why did last night's backup job fail?" }] },
      { role: "assistant" as const, ts: t(0, 6), end_ts: t(1, 2), parts: [
        tool("bash", "journalctl -u backup --since yesterday", {}, "backup.sh: disk quota exceeded on /mnt/archive"),
        { kind: "text" as const, text: "The archive volume hit its quota at 02:14. Old snapshots were never pruned because the retention flag was dropped in the last config change. I restored `--keep-daily 14`; tonight's run will prune and succeed." },
      ] },
    ],
  },
  docs: {
    metadata: { model: "claude-sonnet-5", reasoning_effort: "low" },
    turns: [
      { role: "user" as const, ts: t(0), parts: [{ kind: "text" as const, text: "Proofread the getting-started guide." }] },
      { role: "assistant" as const, ts: t(0, 5), parts: [{ kind: "text" as const, text: "Fixed 6 typos and one broken link; the install command now matches the current CLI." }] },
    ],
  },
};

export const PROMPT: InteractivePrompt = {
  id: "demo-approval",
  agent: "codex",
  kind: "approval" as const,
  title: "Allow command?",
  question: "git push origin feat/export-guard",
  body: null,
  options: [
    { label: "Yes", description: null },
    { label: "Yes, and don't ask again for git push", description: null },
    { label: "No, and tell Codex what to do differently", description: null },
  ],
  multi_select: false,
  custom_option_index: null,
};
