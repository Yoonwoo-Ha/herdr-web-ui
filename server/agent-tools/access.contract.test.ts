import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import * as runtime from "../herdr-core/runtime.ts";
import * as capabilities from "../runtime/capabilities.ts";
import { AcpChildren } from "../acp/children.ts";
import { launchHarnessTool, useAgentToolHub } from "./launch.ts";
import { AgentToolHub } from "./hub.ts";
import { lineCall } from "../line-call.ts";

it("does not install a deferred agent hub when the HTTP bind fails", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-bind-"));
  const fake = new FakeHcCore(), hc = new HcConnection(() => fake.transport());
  const children = new AcpChildren(join(stateDir,"acp"), { hc });
  const registry = spyOn(runtime,"coreAcp").mockReturnValue(children);
  const restore = Promise.withResolvers<void>();
  const restoreCall = spyOn(children,"restore").mockReturnValue(restore.promise);
  const listen = spyOn(AgentToolHub.prototype,"listen").mockImplementation(() => {});
  const bind = spyOn(Bun,"serve").mockImplementationOnce(() => { throw new Error("fixture bind failed"); });
  try {
    expect(() => createServer({ port:0,hostname:"127.0.0.1",stateDir,machines:false,sidecar:false,tailscaleOwner:null })).toThrow("fixture bind failed");
    restore.resolve(); await new Promise(resolve => setImmediate(resolve));
    expect(listen).not.toHaveBeenCalled();
  } finally { useAgentToolHub(null); bind.mockRestore(); listen.mockRestore(); restoreCall.mockRestore(); registry.mockRestore(); children.close(); hc.close(); rmSync(stateDir,{recursive:true,force:true}); }
});

it("a verified agent run token is not an HTTP credential", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-access-"));
  const fake = new FakeHcCore(), hc = new HcConnection(() => fake.transport());
  const registry = spyOn(runtime, "coreAcp").mockReturnValue(new AcpChildren(join(stateDir, "acp"), { hc }));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "not-an-agent-run", machines: false, sidecar: false, tailscaleOwner: null });
  try {
    await app.statusReady;
    const local = spyOn(capabilities, "capabilities").mockReturnValue(capabilities.HERDR_CORE);
    let key;
    try { key = launchHarnessTool("t1", "claude", { platform: "linux", browsers: {} }); }
    finally { local.mockRestore(); }
    if (!key) throw new Error("The app did not issue an agent credential.");
    const token = readFileSync(key.tokenFile, "utf8");
    expect(await lineCall(key.socket, { contract: "ovis-harness/0", id: 1, token, verb: "scope", args: {} }, 2000)).toMatchObject({ kind: "scope" });
    const reply = await fetch(`http://127.0.0.1:${app.port}/api/session`, { headers: { authorization: `Bearer ${token}` } });
    expect(reply.status).toBe(401);
  } finally { app.stop(); registry.mockRestore(); hc.close(); rmSync(stateDir, { recursive: true, force: true }); }
});
