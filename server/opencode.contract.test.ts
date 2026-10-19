import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationPart, ConversationResponse } from "../shared/protocol.ts";

// Real herdr metadata + HTTP + an OpenCode store of the test's own, handed to the server (opencodeDb).
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-opencode-contract-"));
const database = join(root, "opencode.db");
const fakeOpencode = join(root, "bin", "opencode");
const SESSION = "ses_contractTest01";
const PAGING_SESSION = "ses_contractPaging01";
const workspaces: string[] = [];
let paneId: string;
let pagingPaneId: string;
let server: ReturnType<typeof createServer>;
let db: Database;
let seq = 0;
let ids = 0;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const add = (type: string, data: Record<string, unknown>, session = SESSION): string => {
  const id = `msg_contract${(++ids).toString().padStart(4, "0")}`;
  seq += 3;
  db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, session, type, seq, Date.now(), Date.now(), JSON.stringify(data));
  return id;
};
const turn = (prompt: string, answer: string, session = SESSION) => {
  add("user", { time: { created: Date.now() }, text: prompt, files: [], agents: [] }, session);
  add("assistant", {
    time: { created: Date.now(), completed: Date.now() }, agent: "build", model: { id: "contract-model", providerID: "test", variant: "high" },
    content: [{ type: "text", text: answer }], finish: "stop", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: 0 } },
  }, session);
  add("idle", { time: { created: Date.now() }, outcome: "succeeded" }, session);
};

/** The pane's session, as herdr's OpenCode integration reports it (herdr-tui-session.js). */
const reportSession = (session: string, targetPaneId = paneId) =>
  herdrRpc("pane.report_agent_session", { pane_id: targetPaneId, source: "herdr:opencode", agent: "opencode", agent_session_id: session, session_start_source: "select" });

const startOpencode = async (session: string): Promise<string> => {
  const created = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-opencode-${session}` });
  workspaces.push(created.workspace.workspace_id);
  const targetPaneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: targetPaneId, text: `${fakeOpencode}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === targetPaneId);
    if (pane?.agent === "opencode") break;
    if (Date.now() > deadline) throw new Error("test opencode did not start");
    await Bun.sleep(50);
  }
  await reportSession(session, targetPaneId);
  return targetPaneId;
};

beforeAll(async () => {
  db = new Database(database, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
    CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
  `);
  for (const session of [SESSION, PAGING_SESSION]) {
    db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'contract', ?, 'Contract', '2.0.24', 0, 0)").run(session, root);
  }
  turn("Check chat", "Answer one");

  // herdr takes a session report only from an agent holding the pane: a stand-in OpenCode
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(fakeOpencode, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakeOpencode, 0o755);
  // Keep paging on its own pane as well as session: a timeout does not cancel
  // HTTP reads, and the other tests keep writing and switch their pane's session.
  [paneId, pagingPaneId] = await Promise.all([startOpencode(SESSION), startOpencode(PAGING_SESSION)]);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), opencodeDb: database });
});

afterAll(async () => {
  server?.stop();
  for (const workspaceId of workspaces) await workspaceClose(workspaceId);
  db?.close();
  forgetTranscriptState();
  rmSync(root, { recursive: true, force: true });
});

const url = (path: string, params: Record<string, string>, targetPaneId = paneId) =>
  `http://127.0.0.1:${server.port}${path}?${new URLSearchParams({ pane_id: targetPaneId, ...params })}`;

const read = async (params: Record<string, string> = {}, targetPaneId = paneId): Promise<ConversationResponse> => {
  const response = await fetch(url("/api/pane/conversation", params, targetPaneId));
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("serves an OpenCode pane's session over HTTP, and an unchanged one as 304", async () => {
  const first = await fetch(url("/api/pane/conversation", {}));
  expect(first.status).toBe(200);
  const conversation = await first.json() as ConversationResponse;
  expect(conversation.source).toBe("opencode-transcript");
  expect(conversation.history_id).toBe(`opencode-${SESSION}`);
  expect(conversation.cursor).toBeNull();
  expect(conversation.turns.map((entry) => [entry.role, entry.parts])).toEqual([
    ["user", [{ kind: "text", text: "Check chat" }]],
    ["assistant", [{ kind: "text", text: "Answer one", phase: "final_answer" }]],
  ]);
  expect(conversation.metadata).toEqual({ model: "contract-model", reasoning_effort: "high", context: { used: 35, window: null } });
  const etag = first.headers.get("etag")!;
  const again = await fetch(url("/api/pane/conversation", {}), { headers: { "if-none-match": etag } });
  expect(again.status).toBe(304);
  // a step that streams in place is a new answer
  turn("Check again", "Answer two");
  const changed = await fetch(url("/api/pane/conversation", {}), { headers: { "if-none-match": etag } });
  expect(changed.status).toBe(200);
  expect((await changed.json() as ConversationResponse).turns.length).toBe(4);
});

it("pages a long session, and answers 409 for a cursor from another history", async () => {
  // Batch fixture writes to reduce WAL frame volume, not per-commit fsyncs:
  // this store uses WAL + synchronous=NORMAL.
  db.transaction(() => {
    turn("Check chat", "Answer one", PAGING_SESSION);
    turn("Check again", "Answer two", PAGING_SESSION);
    for (let n = 0; n < 60; n++) turn(`p${n}`, `a${n}`, PAGING_SESSION);
  })();
  const newest = await read({}, pagingPaneId);
  expect(typeof newest.cursor).toBe("string");
  const older = await read({ before: newest.cursor! }, pagingPaneId);
  expect(older.history_id).toBe(newest.history_id);
  const prompts = [...older.turns, ...newest.turns].filter((entry) => entry.role === "user").map((entry) => (entry.parts[0] as { text: string }).text);
  expect(prompts).toEqual(["Check chat", "Check again", ...Array.from({ length: 60 }, (_, n) => `p${n}`)]);
  const refused = await fetch(url("/api/pane/conversation", { before: `opencode-ses_elsewhere:${newest.cursor!.split(":")[1]}` }, pagingPaneId));
  expect(refused.status).toBe(409);
  expect((await refused.json() as { error: { code: string } }).error.code).toBe("history_changed");
});

it("serves a cut tool output and a tool's picture by the refs the page gave them", async () => {
  add("user", { time: { created: Date.now() }, text: "open it", files: [] });
  add("assistant", {
    time: { created: Date.now() }, finish: "tool-calls",
    content: [{ type: "tool", id: "call_1", name: "read", state: {
      status: "completed", input: { path: "shot.png" },
      content: [{ type: "text", text: "z".repeat(5000) }, { type: "file", uri: `data:image/png;base64,${PNG.toString("base64")}`, mime: "image/png" }],
    } }],
  });
  const conversation = await read();
  const tool = conversation.turns.flatMap((entry) => entry.parts).filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool").at(-1)!;
  expect(tool.output_size).toBe(5000);
  const output = await fetch(url("/api/pane/conversation/tool-output", { ref: tool.output_ref! }));
  expect(output.status).toBe(200);
  // the ref names a place in a row OpenCode rewrites in place: its output is never pinned
  expect(output.headers.get("cache-control")).toBe("private, no-store");
  expect(await output.text()).toBe("z".repeat(5000));
  expect((await fetch(url("/api/pane/conversation/tool-output", { ref: `${tool.output_ref!.split(":")[0]}:7` }))).status).toBe(404);

  const image = await fetch(url("/api/pane/conversation/image", { ref: tool.images![0]!.ref }));
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
  expect((await fetch(url("/api/pane/conversation/image", { ref: tool.images![0]!.ref.replace(/:0$/, ":3") }))).status).toBe(404);
});

it("does not cache OpenCode image refs while parallel tool results stream in", async () => {
  const earlierImage = Buffer.from([...PNG, 0x01]);
  const laterImage = Buffer.from([...PNG, 0x02]);
  const file = (bytes: Buffer) => ({ type: "file", uri: `data:image/png;base64,${bytes.toString("base64")}`, mime: "image/png" });
  add("user", { time: { created: Date.now() }, text: "read both images", files: [] });
  const messageId = add("assistant", {
    time: { created: Date.now() }, finish: "tool-calls",
    content: [
      { type: "tool", id: "call_early", name: "read", state: { status: "running", input: { path: "earlier.png" }, content: [] } },
      { type: "tool", id: "call_later", name: "read", state: { status: "completed", input: { path: "later.png" }, content: [file(laterImage)] } },
    ],
  });
  const firstConversation = await read();
  const initialTools = firstConversation.turns.at(-1)!.parts.filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool");
  expect(initialTools[1]!.images?.[0]!.ref).toBe(`opencode:${messageId}:0`);

  const ref = initialTools[1]!.images![0]!.ref;
  const firstImage = await fetch(url("/api/pane/conversation/image", { ref }));
  expect(firstImage.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await firstImage.arrayBuffer()).equals(laterImage)).toBe(true);

  db.query("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?").run(JSON.stringify({
    time: { created: Date.now() }, finish: "tool-calls",
    content: [
      { type: "tool", id: "call_early", name: "read", state: { status: "completed", input: { path: "earlier.png" }, content: [file(earlierImage)] } },
      { type: "tool", id: "call_later", name: "read", state: { status: "completed", input: { path: "later.png" }, content: [file(laterImage)] } },
    ],
  }), Date.now() + 1, messageId);

  const updatedConversation = await read();
  const updatedTools = updatedConversation.turns.at(-1)!.parts.filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool");
  expect(updatedTools.map((tool) => tool.images?.[0]?.ref)).toEqual([`opencode:${messageId}:0`, `opencode:${messageId}:1`]);

  const updatedImage = await fetch(url("/api/pane/conversation/image", { ref }));
  expect(updatedImage.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await updatedImage.arrayBuffer()).equals(earlierImage)).toBe(true);
});

it("keeps the terminal for a session the store does not hold", async () => {
  await reportSession("ses_notInTheStore");
  try {
    expect(await read()).toEqual({ source: "scrollback", turns: [] });
  } finally {
    await reportSession(SESSION);
  }
  expect((await read()).source).toBe("opencode-transcript");
});
