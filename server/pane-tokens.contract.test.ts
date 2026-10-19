import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineEvent } from "../shared/machines.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";

// What a plugin reports on a pane (#1209) reaches the browsers' roster as herdr sends it, and
// changes there when herdr's events say so: a token through pane.updated, the agent's line
// through a status event of the same status. herdr's agent rows come on the same stream.
it("carries a plugin's pane tokens and agent line to the browsers' roster, live, beside herdr's agent rows", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-test-pane-tokens-"));
  const herdrConfigPath = join(stateDir, "config.toml");
  writeFileSync(herdrConfigPath, `[ui.sidebar.agents]\nrows = [["state_icon", "workspace"], ["agent", "$quota"]]\n`);
  const workspace = await workspaceCreate({ cwd: stateDir, label: "herdr-web-ui-test-pane-tokens" });
  const paneId = workspace.root_pane.pane_id;
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null, herdrConfigPath });
  const abort = new AbortController();
  try {
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    const events: MachineEvent[] = [];
    const response = await fetch(`http://127.0.0.1:${server.port}/api/machines/events`, { headers: { authorization: "Bearer test-token" }, signal: abort.signal });
    expect(response.status).toBe(200);
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
        }
      }
    })().catch(() => undefined);
    const waitFor = async (what: string, found: (event: MachineEvent) => boolean): Promise<void> => {
      for (const deadline = Date.now() + 15_000; !events.some(found);) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(25);
      }
    };
    const pane = (event: MachineEvent) => event.type === "machines" ? event.machines[0]?.snapshot?.panes.find((candidate) => candidate.pane_id === paneId) : undefined;

    await waitFor("herdr's agent rows", (event) => event.type === "herdr-sidebar" && JSON.stringify(event.agents) === JSON.stringify({ rows: [{ name: "quota" }], by_agent: {} }));
    await waitFor("the pane in the roster", (event) => pane(event)?.agent === "claude");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: "5h 95% · Wk 67%" } });
    await waitFor("the token", (event) => pane(event)?.tokens?.["quota"] === "5h 95% · Wk 67%");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: "5h 40% · Wk 70%" } });
    await waitFor("the token's new value", (event) => pane(event)?.tokens?.["quota"] === "5h 40% · Wk 70%");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:board", applies_to_source: "manual", display_agent: "needs a login · 8m ago" });
    await waitFor("the agent's line", (event) => pane(event)?.display_agent === "needs a login · 8m ago");
    // its status stayed what it was: only the line changed
    const last = [...events].reverse().find((event) => pane(event)?.display_agent === "needs a login · 8m ago");
    expect(pane(last!)?.agent_status).toBe("idle");

    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: null } });
    await waitFor("the token cleared", (event) => pane(event) !== undefined && pane(event)?.tokens?.["quota"] === undefined && pane(event)?.display_agent === "needs a login · 8m ago" && events.indexOf(event) > events.indexOf(last!));
  } finally {
    abort.abort();
    server.stop();
    await workspaceClose(workspace.workspace.workspace_id).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 60_000);
