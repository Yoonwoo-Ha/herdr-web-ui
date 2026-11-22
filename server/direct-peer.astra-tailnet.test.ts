import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./dispatch.ts";
import { createServer } from "./index.ts";
import { TailnetIdentitySource } from "./tailscale.ts";

it("a paired direct peer on the tailnet is associated with its StableNodeID", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "astra-direct-peer-"));
  try {
    const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "", machines: false, sidecar: false, tailscaleBinary: null,
      tailnet: new TailnetIdentitySource(async () => null, async () => JSON.stringify({ Node: { StableID: "nPhone", ComputedName: "Phone" } })) });
    try {
      const rows = app.context.services.devices;
      const paired = rows.pair(rows.startPairing().code, "Phone", "drive")!;
      const row = rows.match(paired.token)!;
      const request = new Request("http://fixture.test/api/health?scope=bridge", { headers: { cookie: `ovis_device=${paired.token}` } });
      await handleRequest(request, { ...app.context, requestIP: () => ({ address: "100.64.0.9" }), timeout() {} });
      expect(rows.tailnetRowsOf("nPhone")).toContain(row.id);
    } finally { app.stop(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
