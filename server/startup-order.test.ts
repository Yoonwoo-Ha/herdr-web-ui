import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { TailnetIdentitySource } from "./tailscale.ts";

// The order createServer starts things in, where it matters. createCore's own order is told in its
// comment (server/core/server-core.ts); this pins the one between it and the HTTP side that once broke.

it("starts the tailnet identity read only after the Node probe has returned", async () => {
  // The probe (server/pty/sidecar.ts) is a spawnSync that can hold the thread up to 3 s. The identity read
  // times itself from its start, so started first it could be cut short by that wait, and a read cut short
  // leaves the owner unknown for five minutes: with no token and nothing paired, another tailnet user
  // would get in as `open` (#1393).
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-startup-"));
  const namedOwner = process.env["HERDR_WEB_TAILSCALE_OWNER"];
  // a named owner is taken as it is, and nothing is read
  delete process.env["HERDR_WEB_TAILSCALE_OWNER"];
  const steps: string[] = [];
  let identityRead!: () => void;
  const read = new Promise<void>((resolve) => { identityRead = resolve; });
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, machines: false,
    sidecar: () => { steps.push("probe"); return false; },
    tailnet: new TailnetIdentitySource(async () => { steps.push("identity read"); identityRead(); return null; }),
  });
  try {
    await read;
    expect(steps).toEqual(["probe", "identity read"]);
  } finally {
    server.stop();
    if (namedOwner !== undefined) process.env["HERDR_WEB_TAILSCALE_OWNER"] = namedOwner;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
