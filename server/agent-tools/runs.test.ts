import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "./runs.ts";

it("a reserved run is nobody; after bind its depth survives restart, and revocation survives re-opening", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  try {
    const store = new RunStore(dir);
    const reservation = store.reserve();
    const token = readFileSync(reservation.tokenFile, "utf8");
    expect(statSync(reservation.tokenFile).mode & 0o777).toBe(0o600);
    expect(store.verify(token)).toBeNull();
    reservation.bind({ self: "t1", harness: "claude", started_by: null, root: reservation.id, depth: 0 });
    const child = store.reserve();
    child.bind({ self: "t2", harness: "gjc", started_by: reservation.id, root: reservation.id, depth: 1 });
    store.rememberForeground(reservation.id, process.pid);
    const childToken = readFileSync(child.tokenFile, "utf8");
    const restored = new RunStore(dir);
    for (let n = 0; n < 257; n++) restored.rememberStart(reservation.id, `key${n}`, child.id);
    expect(new RunStore(dir).previousStart(reservation.id, "key0")).toBe(child.id);
    expect(restored.verify(childToken)).toMatchObject({ self: "t2", depth: 1 });
    expect(readFileSync(join(dir, "runs.json"), "utf8")).not.toContain(childToken);
    restored.reconcile([
      { address: "t1", state: "live", labels: {}, foreground: { pid: process.ppid, argv: ["claude", "--mcp-config", join(dir, "mcp", `${reservation.id}.json`)] } },
      { address: "t2", state: "live", labels: { "ovis.run": child.id, "ovis.acp": "keeper" } },
    ], address => address === "t2" ? "keeper" : undefined);
    expect(restored.verify(token)).toBeNull();
    expect(restored.verify(childToken)).not.toBeNull();
    restored.revokeAll();
    expect(existsSync(child.tokenFile)).toBe(false);
    expect(new RunStore(dir).verify(childToken)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
