import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("ovis agent send uses the run's private door, not the install's HTTP credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-"));
  const socket = join(dir, "broker.sock"), tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "test-only-token");
  const requests: unknown[] = [];
  const server = createServer(s => s.once("data", b => {
    requests.push(JSON.parse(b.toString()));
    s.end('{"contract":"ovis-harness/0","kind":"accepted","accepted":true}\n');
  }));
  try {
    await new Promise<void>(ready => server.listen(socket, ready));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "plugin.ts"), "agent", "send", "t42", "one task", "--key", "k", "--json"], {
      env: { HOME: dir, PATH: process.env.PATH, OVIS_AGENT_SOCKET: socket, OVIS_AGENT_TOKEN_FILE: tokenFile }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ kind: "accepted" });
    expect(requests).toEqual([{ contract: "ovis-harness/0", id: 1, token: "test-only-token", verb: "send", args: { session: "t42", task: "one task", key: "k" } }]);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
