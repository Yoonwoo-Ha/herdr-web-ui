import { expect, it } from "bun:test";
import type { MovePane, MovePlan } from "../shared/runtime-move.ts";
import { herdrSource, sameShape } from "./runtime-move-service.ts";

const plan = (panes: MovePane[]): MovePlan => ({ ready: true, revision: "r", workspaces: [{ workspace_id: "w1", name: "ovis", tabs: [{ tab_id: "t1", name: "1", root: { pane: "a" } }] }], panes });
const shown = plan([
  { pane_id: "a", cwd: "/a", name: null, verdict: { kind: "busy", reason: "agent_working", agent: "codex", command: null } },
  { pane_id: "b", cwd: "/b", name: null, verdict: { kind: "shell" } },
]);

it("lets a waiting move go only when what was shown is what moves", () => {
  const done = plan([{ ...shown.panes[0]!, verdict: { kind: "resume", agent: "codex", session_id: "s", argv: ["codex", "resume", "s"], ended: false } }, shown.panes[1]!]);
  expect(sameShape(shown, done)).toBe(true);
  expect(sameShape(shown, plan([{ ...done.panes[0]!, verdict: { kind: "fresh", agent: "claude" } }, shown.panes[1]!]))).toBe(false);
  expect(sameShape(shown, plan([{ ...done.panes[0]!, cwd: "/elsewhere" }, shown.panes[1]!]))).toBe(false);
  expect(sameShape(shown, plan([...done.panes, { pane_id: "c", cwd: "/c", name: null, verdict: { kind: "shell" } }]))).toBe(false);
  const waited = plan([{ pane_id: "a", cwd: "/a", name: null, verdict: { kind: "needs_you", agent: "copilot" } }, shown.panes[1]!]);
  expect(sameShape(waited, plan([{ ...waited.panes[0]!, verdict: { kind: "shell" } }, shown.panes[1]!]))).toBe(true);
  expect(sameShape(waited, plan([{ ...waited.panes[0]!, verdict: { kind: "resume", agent: "copilot" as never, session_id: "s", argv: ["copilot"], ended: true } }, shown.panes[1]!]))).toBe(true);
});

it("sends an exit only in the pane's input lane, after what was typed before it, and not over a message queued meanwhile", async () => {
  let tail: Promise<unknown> = Promise.resolve();
  const lane = <T,>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => undefined).then(task); tail = run; return run; };
  const sent: string[] = [];
  let queued = false;
  const source = herdrSource(() => queued, async () => true, lane, async (pane, text) => { sent.push(`${pane} ${text}`); });
  let typed: (() => void) | null = null;
  void lane("p1", () => new Promise<void>((resolve) => { typed = resolve; }));
  const exit = source.sendExit("p1", "claude", "/exit");
  for (let turn = 0; turn < 10 && typed === null; turn++) await Promise.resolve();
  expect(sent).toEqual([]);
  typed!();
  await exit;
  expect(sent).toEqual(["p1 /exit"]);
  let release: (() => void) | null = null;
  void lane("p1", () => new Promise<void>((resolve) => { release = resolve; }));
  const second = source.sendExit("p1", "claude", "/exit");
  for (let turn = 0; turn < 10 && release === null; turn++) await Promise.resolve();
  queued = true;
  release!();
  expect(await second.then(() => "sent", () => "refused")).toBe("refused");
  expect(sent).toEqual(["p1 /exit"]);
});
