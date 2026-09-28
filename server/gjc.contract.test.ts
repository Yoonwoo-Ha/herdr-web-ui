import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { ConversationUnavailable, gjcTranscriptPath } from "./conversation.ts";

const home = mkdtempSync(join(tmpdir(), "herdr-gjc-binding-"));
const dir = join(home, ".gjc", "agent", "sessions", "v2-shared");
mkdirSync(dir, { recursive: true });
const workspaces: string[] = [];
const script = join(home, "gjc");
// The stand-in keeps actual descriptors open; all files and panes belong to this test.
writeFileSync(script, "for (const path of process.argv.slice(2)) require('node:fs').openSync(path, 'r');\nconsole.log('GJC descriptor ready'); setInterval(() => {}, 1000);\n");
afterAll(async () => {
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(home, { recursive: true, force: true });
});

async function pane(paths: string[]): Promise<string> {
  const created = await workspaceCreate({ cwd: home, label: "herdr-web-ui-test-gjc-binding" });
  workspaces.push(created.workspace.workspace_id);
  const id = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: id, text: `${process.execPath} ${script} ${paths.join(" ")}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
    const process = info.process_info?.foreground_processes?.find((p) => p.argv?.includes(script));
    if (process) {
      const held = readdirSync(`/proc/${process.pid}/fd`).flatMap((fd) => { try { return [readlinkSync(`/proc/${process.pid}/fd/${fd}`)]; } catch { return []; } });
      if (paths.every((path) => held.includes(path))) return id;
    }
    await Bun.sleep(50);
  }
  throw new Error("GJC stand-in did not open its descriptors");
}

it("binds same-cwd panes to their own files regardless of which transcript was modified last", async () => {
  const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl");
  for (const path of [a, b]) writeFileSync(path, JSON.stringify({ type: "session", cwd: home }) + "\n");
  const first = await pane([a]), second = await pane([b]);
  for (const newest of [a, b]) {
    utimesSync(newest, new Date(), new Date(Date.now() + 60_000));
    expect(await gjcTranscriptPath(first, home, home)).toBe(a);
    expect(await gjcTranscriptPath(second, home, home)).toBe(b);
  }
  const directoryOnly = await pane([dir]);
  await expect(gjcTranscriptPath(directoryOnly, home, home)).rejects.toThrow(ConversationUnavailable);
  const ambiguous = await pane([a, b]);
  await expect(gjcTranscriptPath(ambiguous, home, home)).rejects.toThrow(ConversationUnavailable);
  await expect(gjcTranscriptPath(first, "/different-cwd", home)).rejects.toThrow(ConversationUnavailable);
});
