import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { socketAddress } from "./herdr/client.ts";

it("records abnormal browser closes without their reason, coalesces repeats and ignores normal closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-ws-diagnostics-"));
  const path = join(root, "herdr.sock");
  const previousSocket = process.env.HERDR_SOCKET;
  const sockets = new Set<Socket>();
  const browsers = new Set<WebSocket>();
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  const records = () => lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).filter((record) => record.event === "websocket.failed");
  const daemon = createSocketServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const { id, method } = JSON.parse(input.split("\n")[0]!);
      input = "";
      if (method === "events.subscribe") return;
      const result = method === "session.snapshot" ? { snapshot: { panes: [], agents: [], workspaces: [], tabs: [], layouts: [] } } : {};
      socket.end(JSON.stringify({ id, result }) + "\n");
    });
  });
  let app: ReturnType<typeof createServer> | undefined;
  async function close(code: number): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/ws`);
    browsers.add(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture WebSocket did not close")), 2000);
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("fixture WebSocket failed")); }, { once: true });
      ws.addEventListener("message", () => ws.close(code, "private-token/private-path"), { once: true });
      ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  try {
    await new Promise<void>((resolve, reject) => { daemon.once("error", reject); daemon.listen(socketAddress(path), resolve); });
    process.env.HERDR_SOCKET = path;
    app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), machines: false, herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null });
    await close(1000);
    expect(records()).toHaveLength(0);
    await close(4001);
    const deadline = Date.now() + 1000;
    while (records().length === 0) {
      if (Date.now() > deadline) throw new Error("close was not recorded");
      await Bun.sleep(5);
    }
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ operation: "local", code: "closed", close_code: 4001 });
    await close(4002);
    expect(records()).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("private-token");
    expect(lines.join("\n")).not.toContain(root);
  } finally {
    app?.stop();
    for (const browser of browsers) browser.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    warn.mockRestore();
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previousSocket;
    rmSync(root, { recursive: true, force: true });
  }
});
