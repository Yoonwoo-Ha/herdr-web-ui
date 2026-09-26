/**
 * A staged, fictional herdr session for the README media (capture.ts): its own named herdr
 * session (never the one you work in), five workspaces under /tmp/herdr-demo, and curated
 * chats served in place of real transcripts. The real hostname never reaches the page.
 */
process.env["HERDR_TEST_SESSION"] = "herdr-web-ui-demo";
await import("../test-herdr.ts");
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createServer } = await import("../../server/index.ts");
const { herdrRpc, workspaceCreate, workspaceClose, sessionSnapshot } = await import("../../server/herdr/client.ts");
const { hostname } = await import("node:os");

const REAL_HOST = hostname();
const HOST = "workstation";
const ROOT = "/tmp/herdr-demo";

export interface DemoPane { key: string; label: string; title: string; agent: string | null; state?: "idle" | "working" | "blocked"; pane: string; workspace: string }

const SPECS: Omit<DemoPane, "pane" | "workspace">[] = [
  { key: "api", label: "checkout-api", title: "Idempotent payments", agent: "claude", state: "working" },
  { key: "web", label: "web-dashboard", title: "Guard the export button", agent: "codex", state: "blocked" },
  { key: "infra", label: "infra", title: "Why did the backup fail?", agent: "gjc", state: "idle" },
  { key: "docs", label: "docs-site", title: "Proofread the guide", agent: "omo", state: "idle" },
  { key: "shell", label: "release", title: "Tag v1.4.0", agent: null },
];

const t = (min: number, sec = 0) => `2026-09-25T09:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
const tool = (name: string, summary: string, input: unknown, output: string) => ({ kind: "tool", name, summary, input: JSON.stringify(input, null, 2), output });

const CHATS: Record<string, { turns: unknown[]; metadata: { model: string; reasoning_effort: string } }> = {
  api: {
    metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user", ts: t(2), parts: [{ kind: "text", text: "Make `POST /payments` idempotent: a client retrying with the same `Idempotency-Key` must get the first response back, never a second charge. Cover it with tests." }] },
      { role: "assistant", ts: t(2, 5), end_ts: t(4, 41), parts: [
        { kind: "text", text: "I'll look at how payments are created and where a key could be stored." },
        tool("Grep", "Idempotency-Key", { pattern: "Idempotency-Key", path: "src" }, "src/routes/payments.ts:14: // TODO: honour Idempotency-Key"),
        tool("Read", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "export async function createPayment(req: Request) { … }"),
        tool("Edit", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "Updated src/routes/payments.ts"),
        tool("Write", "src/lib/idempotency.ts", { file_path: "src/lib/idempotency.ts" }, "Created src/lib/idempotency.ts"),
        tool("Bash", "bun test payments", { command: "bun test payments" }, " 14 pass\n 0 fail\nRan 14 tests across 2 files. [412ms]"),
        { kind: "text", text: "Done. Retries are now safe:\n\n- **`src/lib/idempotency.ts`** stores the first response per key for 24 h, scoped to the API client, so two clients can reuse a key without colliding.\n- **`POST /payments`** replays the stored response for a repeated key, and answers `409` while the first request with that key is still in flight.\n- A repeated key with a **different body** is rejected with `422`, instead of silently returning the old payment.\n\n```ts\nconst cached = await idempotency.lookup(client.id, key, body);\nif (cached) return cached.response;\n```\n\nTests: 14 pass, including concurrent retries and a key reused with a changed amount. See https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ for the header's semantics." },
      ] },
      { role: "user", ts: t(6), parts: [{ kind: "text", text: "Nice. Now add a metric for replayed requests." }] },
      { role: "assistant", ts: t(6, 3), parts: [
        { kind: "text", text: "Adding a `payments_idempotent_replays_total` counter next to the existing request metrics." },
        tool("Read", "src/metrics.ts", { file_path: "src/metrics.ts" }, "export const requests = new Counter({ … })"),
        tool("Edit", "src/metrics.ts", { file_path: "src/metrics.ts" }, "Updated src/metrics.ts"),
      ] },
    ],
  },
  web: {
    metadata: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    turns: [
      { role: "user", ts: t(1), parts: [{ kind: "text", text: "Rate-limit the export button so a double click can't start two exports, then push the branch." }] },
      { role: "assistant", ts: t(1, 4), end_ts: t(3, 20), parts: [
        tool("exec", "rg -n \"startExport\" src", { cmd: "rg -n \"startExport\" src" }, "src/pages/Reports.tsx:88:  onClick={() => startExport(filters)}"),
        tool("apply_patch", "src/pages/Reports.tsx", {}, "Success. Updated the following files:\nM src/pages/Reports.tsx"),
        tool("exec", "pnpm test --filter reports", { cmd: "pnpm test --filter reports" }, "✓ 9 tests passed"),
        { kind: "text", text: "The button is disabled while an export runs, and a second click within the same run is ignored. Tests pass; I need your OK to push `feat/export-guard`." },
      ] },
    ],
  },
  infra: {
    metadata: { model: "glm-5.3", reasoning_effort: "med" },
    turns: [
      { role: "user", ts: t(0), parts: [{ kind: "text", text: "Why did last night's backup job fail?" }] },
      { role: "assistant", ts: t(0, 6), end_ts: t(1, 2), parts: [
        tool("bash", "journalctl -u backup --since yesterday", {}, "backup.sh: disk quota exceeded on /mnt/archive"),
        { kind: "text", text: "The archive volume hit its quota at 02:14. Old snapshots were never pruned because the retention flag was dropped in the last config change. I restored `--keep-daily 14`; tonight's run will prune and succeed." },
      ] },
    ],
  },
  docs: {
    metadata: { model: "claude-sonnet-5", reasoning_effort: "low" },
    turns: [
      { role: "user", ts: t(0), parts: [{ kind: "text", text: "Proofread the getting-started guide." }] },
      { role: "assistant", ts: t(0, 5), parts: [{ kind: "text", text: "Fixed 6 typos and one broken link; the install command now matches the current CLI." }] },
    ],
  },
};

export const PROMPT = {
  id: "demo-approval",
  agent: "codex",
  kind: "approval",
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

/** A small fictional project for the terminal shot: real git history, real tests. */
function releaseRepo(dir: string) {
  const sh = (cmd: string) => { const r = Bun.spawnSync(["bash", "-c", cmd], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.com" } }); if (r.exitCode !== 0) throw new Error(cmd + ": " + r.stderr.toString()); };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  sh("git init -q -b main");
  const money = `export const cents = (amount: string): number => Math.round(Number(amount) * 100);\nexport const format = (cents: number): string => (cents / 100).toFixed(2);\n`;
  Bun.write(join(dir, "src/money.ts"), money); sh("git add -A && git commit -q -m 'feat: money helpers'");
  Bun.write(join(dir, "src/money.test.ts"), `import { expect, test } from "bun:test";\nimport { cents, format } from "./money.ts";\ntest("parses amounts to cents", () => expect(cents("12.34")).toBe(1234));\ntest("rounds half a cent", () => expect(cents("0.005")).toBe(1));\ntest("formats cents", () => expect(format(1234)).toBe("12.34"));\ntest("formats zero", () => expect(format(0)).toBe("0.00"));\n`);
  sh("git add -A && git commit -q -m 'test: cover money helpers'");
  sh("git checkout -q -b feat/idempotency && git commit -q --allow-empty -m 'feat(payments): replay the first response for a repeated key' && git commit -q --allow-empty -m 'test(payments): concurrent retries'");
  sh("git checkout -q main && git merge -q --no-ff feat/idempotency -m 'Merge branch feat/idempotency'");
  sh("git commit -q --allow-empty -m 'chore(release): 1.4.0' && git tag v1.4.0");
}

export async function stage() {
  // start clean: close whatever an earlier run left in the demo session
  for (const ws of (await sessionSnapshot()).workspaces) await workspaceClose(ws.workspace_id).catch(() => {});
  const panes: DemoPane[] = [];
  for (const spec of SPECS) {
    const cwd = join(ROOT, spec.label);
    if (spec.key === "shell") releaseRepo(cwd); else mkdirSync(cwd, { recursive: true });
    const ws = await workspaceCreate({ cwd, label: spec.label });
    const pane = ws.root_pane.pane_id;
    panes.push({ ...spec, pane, workspace: ws.workspace.workspace_id });
    // a plain prompt: no user, host or home path on screen
    await herdrRpc("pane.send_text", { pane_id: pane, text: `exec env -i HOME=${cwd} TERM=xterm-256color PATH=$PATH bash --norc --noprofile\n` });
  }
  await Bun.sleep(800);
  for (const p of panes) {
    await herdrRpc("pane.send_text", { pane_id: p.pane, text: `PS1='\\[\\e[38;5;214m\\]${p.label}\\[\\e[0m\\] \\$ '; clear\n` });
    // the pane's label is its title everywhere, whatever the program in it sets
    await herdrRpc("pane.rename", { pane_id: p.pane, label: p.title });
    if (p.agent) await herdrRpc("pane.report_agent", { pane_id: p.pane, source: "manual", agent: p.agent, state: p.state ?? "idle" });
  }
  // the resident workspace test-herdr keeps must not show
  for (const ws of (await sessionSnapshot()).workspaces) if (!panes.some((p) => p.workspace === ws.workspace_id)) await workspaceClose(ws.workspace_id).catch(() => {});
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-demo-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const base = `http://127.0.0.1:${server.port}`;
  const byPane = new Map(panes.map((p) => [p.pane, p]));
  let promptAnswered = false;

  async function routes(page: any) {
    const scrub = (text: string) => text.split(REAL_HOST).join(HOST);
    // the live event stream cannot be rewritten; the 5 s machines poll carries the same data
    await page.route("**/api/machines/events", (route: any) => route.abort());
    await page.route("**/api/machines", async (route: any) => {
      try {
        const response = await route.fetch();
        await route.fulfill({ response, body: scrub(await response.text()) });
      } catch { /* the page closed mid-request */ }
    });
    await page.route("**/api/pane/conversation?*", async (route: any) => {
      const id = new URL(route.request().url()).searchParams.get("pane_id") ?? "";
      const chat = CHATS[byPane.get(id)?.key ?? ""];
      if (!chat) return route.fallback();
      await route.fulfill({ json: { source: "claude-transcript", turns: chat.turns, metadata: chat.metadata, cursor: null, version: "demo-1" } });
    });
    await page.route("**/api/pane/prompt?*", async (route: any) => {
      const id = new URL(route.request().url()).searchParams.get("pane_id") ?? "";
      await route.fulfill({ json: { prompt: byPane.get(id)?.key === "web" && !promptAnswered ? PROMPT : null } });
    });
    await page.route("**/api/pane/prompt/answer", async (route: any) => {
      promptAnswered = true;
      const web = panes.find((p) => p.key === "web")!;
      await herdrRpc("pane.report_agent", { pane_id: web.pane, source: "manual", agent: "codex", state: "working" });
      await route.fulfill({ json: { ok: true } });
    });
  }

  async function teardown() {
    server.stop();
    for (const p of panes) await workspaceClose(p.workspace).catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
  /** Codex asks again: each capture starts from the same state. */
  async function reset() {
    promptAnswered = false;
    const web = panes.find((p) => p.key === "web")!;
    await herdrRpc("pane.report_agent", { pane_id: web.pane, source: "manual", agent: "codex", state: "blocked" });
  }
  return { base, panes, routes, reset, teardown, pane: (key: string) => panes.find((p) => p.key === key)! };
}
