import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real herdr panes running a stand-in `codex` process: which rollout the chat reads
// while nothing Codex said is on screen.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-binding-"));
const codexHome = join(root, "codex");
const threads = { resumed: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc01", matched: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02" };
const answers = {
  resumed: "The resumed thread answers from its own rollout, found by the id on the command line without any screen match.",
  matched: "The matched thread was recognised on screen once, and stays bound while tool output scrolls its answer away.",
};
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;

const rollout = (name: keyof typeof threads) => {
  const path = join(codexHome, "sessions", `rollout-2026-09-24T00-00-00-${threads[name]}.jsonl`);
  writeFileSync(path, [
    { type: "session_meta", payload: { id: threads[name], cwd: root } },
    { type: "response_item", timestamp: "2026-09-24T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question for ${name}` }] } },
    { type: "response_item", timestamp: "2026-09-24T00:00:05Z", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answers[name] }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  return path;
};

/** Waits until the pane's foreground runs the stand-in codex (a shell can be slow to start). */
const codexRunning = async (paneId: string, not?: string): Promise<string> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
    const pids = (info.process_info?.foreground_processes ?? []).filter((process) => process.argv?.some((arg) => arg.endsWith("/codex"))).map((process) => String(process.pid)).join(",");
    if (pids !== "" && pids !== not) return pids;
    await Bun.sleep(100);
  }
  throw new Error(`no codex process in ${paneId}`);
};

const pane = async (label: string, command: string): Promise<string> => {
  const created = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-codex-binding-${label}` });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${command}\n` });
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "working" });
  await codexRunning(paneId);
  return paneId;
};

const read = async (paneId: string): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  return await response.json() as ConversationResponse;
};
const lastAnswer = (conversation: ConversationResponse) =>
  conversation.turns.at(-1)?.parts.map((part) => part.kind === "text" ? part.text : "").join("") ?? null;

beforeAll(() => {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER)");
  for (const name of Object.keys(threads) as (keyof typeof threads)[]) {
    db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1)").run(threads[name], rollout(name), root);
  }
  db.close();
  // a stand-in TUI: its command line names it codex; `--say` prints the matched answer
  // from a file (never from the typed command), then output floods the screen
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "answer.txt"), `${answers.matched}\n`);
  const script = join(root, "bin", "codex");
  writeFileSync(script, `#!/bin/sh\n[ "$1" = --say ] && cat "$(dirname "$0")/answer.txt"\nsleep "\${FLOOD_AFTER:-600}"\nseq 1 600\nsleep 600\n`);
  chmodSync(script, 0o755);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), codexHome });
});

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

it("reads the thread a Codex TUI was resumed on while none of its answers is on screen, until a newer thread begins", async () => {
  const paneId = await pane("resumed", `${join(root, "bin", "codex")} resume ${threads.resumed}`);
  const conversation = await read(paneId);
  expect(conversation.source).toBe("codex-transcript");
  expect(lastAnswer(conversation)).toBe(answers.resumed);
  // /new in that TUI (or any Codex in this cwd) starts a thread after it: the command
  // line no longer tells, and the chat says so rather than show the resumed thread
  const db = new Database(join(codexHome, "state_5.sqlite"));
  const now = Math.ceil(Date.now() / 1000) + 1;
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, ?, ?)").run("01a0c7a1-56d9-7e20-9f08-f7a2d973bc03", join(codexHome, "sessions", "missing.jsonl"), root, now, now);
  db.close();
  expect((await read(paneId)).source).toBe("scrollback");
});

it("keeps a matched rollout while tool output scrolls the answer away, and drops it for another process", async () => {
  const paneId = await pane("matched", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  const first = await codexRunning(paneId);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  // 600 lines of output: the answer is past the 400 the match reads
  await Bun.sleep(3500);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  // another codex process in the pane is not the one that was matched
  await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["ctrl+c"] });
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${join(root, "bin", "codex")}\n` });
  await codexRunning(paneId, first);
  expect((await read(paneId)).source).toBe("scrollback");
}, 20_000);
