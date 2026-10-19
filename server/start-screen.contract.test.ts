import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Before its first message omp has written no session and a Codex started in a terminal has
// reported none: omp waits for its transcript; Codex can name its model through its live footer.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-start-screen-contract-"));
const fresh = join(root, ".omp", "agent", "sessions", "-start-screen", "2026-10-19T00-00-00-000Z_omp-fresh.jsonl");
const originalHome = process.env["HOME"];
const workspaces: string[] = [];
let ompPane: string;
let codexPane: string;
let server: ReturnType<typeof createServer>;
let seq = Date.now() * 1000;

// A stand-in omp draws another model on `s`, as `/switch` does, without writing a transcript.
const FAKE_OMP = `
const draw = (model) => process.stdout.write("\\x1b[2J\\x1b[H π > " + model + " > 🗑 project ▶─2%─┃─1M─\\r\\n╰─\\r\\n");
draw("◔ GPT 6.1 Sol");
console.log("omp_ready_contract");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (key) => { if (String(key).includes("s")) { draw("◒ Opus 5.5"); console.log("omp_switched_contract"); } });
`;

beforeAll(async () => {
  mkdirSync(join(root, ".omp", "agent", "sessions", "-start-screen"), { recursive: true });
  const fakeOmp = join(root, "omp");
  writeFileSync(fakeOmp, FAKE_OMP);
  const omp = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-start-screen-omp" });
  workspaces.push(omp.workspace.workspace_id);
  ompPane = omp.root_pane.pane_id;
  let started: (() => void) | undefined;
  const subscribed = new Promise<void>((resolve) => { started = resolve; });
  let detected: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const discovered = new Promise<void>((resolve, reject) => { detected = resolve; failed = reject; });
  const subscription = subscribeEvents([{ type: "pane.updated" }, { type: "pane.agent_status_changed", pane_id: ompPane }], {
    onStarted() { started?.(); },
    onError(error) { failed?.(error); },
    onEvent() {
      void sessionSnapshot().then((snapshot) => {
        if (snapshot.panes.some((pane) => pane.pane_id === ompPane && pane.agent === "omp")) detected?.();
      }, (error: Error) => failed?.(error));
    },
  });
  const deadline = setTimeout(() => failed?.(new Error("omp process was not discovered")), 10_000);
  await subscribed;
  const ompReady = herdrRpc("pane.wait_for_output", {
    pane_id: ompPane, source: "visible", match: { type: "substring", value: "omp_ready_contract" }, timeout_ms: 10000,
  }, undefined, 12000);
  try {
    await herdrRpc("pane.send_text", { pane_id: ompPane, text: `HOME=${root} ${process.execPath} ${fakeOmp}\n` });
    await Promise.all([ompReady, discovered]);
  } finally { clearTimeout(deadline); subscription.close(); }
  await herdrRpc("pane.report_agent", { pane_id: ompPane, source: "herdr:omp", agent: "omp", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", { pane_id: ompPane, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: fresh, session_start_source: "startup" });
  const codex = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-start-screen-codex" });
  workspaces.push(codex.workspace.workspace_id);
  codexPane = codex.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: codexPane, source: "manual", agent: "codex", state: "idle" });
  const codexReady = herdrRpc("pane.wait_for_output", {
    pane_id: codexPane, source: "visible", match: { type: "substring", value: "codex_ready_contract" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_text", { pane_id: codexPane, text: `clear; printf '%s\\n' '  >_ OpenAI Codex (v0.163.0)' '' '› Ask Codex to do anything' '' '  GPT-6.1-Sol low · /tmp/project'; printf '? for shortcuts codex_%s\\n' ready_contract; exec cat\n` });
  await codexReady;
  // The stand-in has no session integration; verify the report before reading its conversation.
  const agent = await herdrRpc<{ agent: { agent?: string; agent_session?: { value?: string } } }>("agent.get", { target: ompPane });
  expect(agent.agent.agent).toBe("omp");
  expect(agent.agent.agent_session?.value).toBe(fresh);
  process.env["HOME"] = root;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome: join(root, ".codex") });
}, 15000);

afterAll(async () => {
  server?.stop();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

const read = async (paneId: string): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("leaves omp's screen model unknown, then reads the first transcript's model", async () => {
  expect(await read(ompPane)).toMatchObject({
    source: "omp-transcript", turns: [], metadata: { model: null, reasoning_effort: null },
  });
  const switched = herdrRpc("pane.wait_for_output", {
    pane_id: ompPane, source: "visible", match: { type: "substring", value: "omp_switched_contract" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_text", { pane_id: ompPane, text: "s" });
  await switched;
  const unwritten = await read(ompPane);
  expect(unwritten.metadata).toEqual({ model: null, reasoning_effort: null });
  expect(unwritten.screen).toBeUndefined();
  writeFileSync(fresh, [
    { type: "session", version: 3, id: "omp-fresh", cwd: root },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-19T00:00:00Z", modelId: "claude-opus-5-5" },
    { type: "thinking_level_change", id: "l1", parentId: "m1", timestamp: "2026-10-19T00:00:00Z", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "l1", timestamp: "2026-10-19T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-19T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "First answer" }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const written = await read(ompPane);
  expect(written.source).toBe("omp-transcript");
  expect(written.metadata).toEqual({ model: "claude-opus-5-5", reasoning_effort: "high" });
  expect(written.screen).toBeUndefined();
  expect(written.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
});

it("carries the model a Codex without a session states with the scrollback standing in", async () => {
  expect(await read(codexPane)).toEqual({
    source: "scrollback", turns: [], screen: true, metadata: { model: "gpt-6.1-sol", reasoning_effort: "low" },
  });
});
