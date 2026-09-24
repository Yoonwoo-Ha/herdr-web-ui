import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneRead, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real herdr panes running a stand-in `codex` process: which rollout the chat reads
// while nothing Codex said is on screen.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-binding-"));
const codexHome = join(root, "codex");
const threads = {
  resumed: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc01",
  matched: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02",
  other: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc03",
};
const answers = {
  resumed: "The resumed thread answers from its own rollout, found by the id on the command line without any screen match.",
  matched: "The matched thread was recognised on screen once, and stays bound while tool output scrolls its answer away.",
  other: "Another pane in the same repository started this thread later, and it is that pane's own conversation entirely.",
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
/** A thread row begun now in the panes' cwd, as /new starts one (or a subagent, or `codex exec`); returns its removal. */
let rows = 10;
const newerThread = (source = "cli", id = `01a0c7a1-56d9-7e20-9f08-f7a2d973bc${rows++}`, path = join(codexHome, "sessions", "missing.jsonl")): (() => void) => {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  const now = Math.ceil(Date.now() / 1000) + 1;
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, ?, ?, ?)").run(id, path, root, now, now, source);
  db.close();
  return () => {
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.query("DELETE FROM threads WHERE id = ?").run(id);
    db.close();
  };
};
/** Waits until the answer shows in the pane. */
const onScreen = async (paneId: string, answer: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const recent = await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true });
    if (recent.text.replace(/\s+/g, " ").includes(answer.slice(0, 48))) return;
    await Bun.sleep(100);
  }
  throw new Error(`the answer never showed in ${paneId}`);
};
/** Waits until the pane's flood has pushed the answer out of the 400 lines the match reads. */
const floodedAway = async (paneId: string, answer: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const recent = await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true });
    if (!recent.text.replace(/\s+/g, " ").includes(answer.slice(0, 48))) return;
    await Bun.sleep(100);
  }
  throw new Error(`the answer is still on screen in ${paneId}`);
};
const lastAnswer = (conversation: ConversationResponse) =>
  conversation.turns.at(-1)?.parts.map((part) => part.kind === "text" ? part.text : "").join("") ?? null;

beforeAll(() => {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT)");
  for (const name of ["resumed", "matched"] as const) {
    db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run(threads[name], rollout(name), root);
  }
  db.close();
  // a stand-in TUI: its command line names it codex; `--say` prints the matched answer
  // from a file (never from the typed command), then output floods the screen
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "matched.txt"), `${answers.matched}\n`);
  writeFileSync(join(root, "bin", "other.txt"), `${answers.other}\n`);
  const script = join(root, "bin", "codex");
  writeFileSync(script, `#!/bin/sh\n[ "$1" = --say ] && cat "$(dirname "$0")/\${2:-matched}.txt"\nsleep "\${FLOOD_AFTER:-600}"\nseq 1 600\nsleep 600\n`);
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
  const remove = newerThread();
  try {
    expect((await read(paneId)).source).toBe("scrollback");
  } finally {
    remove();
  }
});

it("keeps a matched rollout while tool output scrolls the answer away, and drops it for another process", async () => {
  const paneId = await pane("matched", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  const first = await codexRunning(paneId);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  // 600 lines of output: the answer is past the 400 the match reads
  await floodedAway(paneId, answers.matched);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  // another codex process in the pane is not the one that was matched
  await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["ctrl+c"] });
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${join(root, "bin", "codex")}\n` });
  await codexRunning(paneId, first);
  expect((await read(paneId)).source).toBe("scrollback");
}, 20_000);

it("drops a matched rollout once a newer interactive thread begins in its cwd, as /new does, not for a subagent or codex exec", async () => {
  const paneId = await pane("renewed", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  await floodedAway(paneId, answers.matched);
  // the pane's own subagent (agent_role NULL, as many are) and a `codex exec` in the repo
  const spawned = [
    newerThread(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: threads.matched, depth: 1, agent_role: null } } })),
    newerThread("exec"),
  ];
  try {
    expect(lastAnswer(await read(paneId))).toBe(answers.matched);
    // the process now writes a thread begun after the match: the chat cannot tell which
    const remove = newerThread();
    try {
      expect((await read(paneId)).source).toBe("scrollback");
    } finally {
      remove();
    }
  } finally {
    for (const remove of spawned) remove();
  }
}, 30_000);

it("keeps a matched rollout when the newer thread shows in another Codex pane, whether or not its chat was opened", async () => {
  const paneId = await pane("mine", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  await floodedAway(paneId, answers.matched);
  const remove = newerThread("cli", threads.other, rollout("other"));
  try {
    // no other Codex pane here shows that thread: this pane cannot tell it from its own /new
    expect((await read(paneId)).source).toBe("scrollback");
    // a second Codex in the same repo shows its answer, and nobody opens its chat
    const otherPane = await pane("theirs", `${join(root, "bin", "codex")} --say other`);
    await onScreen(otherPane, answers.other);
    expect(lastAnswer(await read(paneId))).toBe(answers.matched);
    // and the other pane was bound to its thread on the way
    expect(lastAnswer(await read(otherPane))).toBe(answers.other);
  } finally {
    remove();
  }
}, 30_000);
