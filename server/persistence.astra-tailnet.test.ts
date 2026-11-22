import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { TailnetNodes } from "./tailnet-nodes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "astra-association-"));
  dirs.push(dir);
  const nodes = new TailnetNodes(dir);
  const rows = new DeviceStore(dir);
  rows.attachTailnetNodes(nodes);
  const paired = rows.pair(rows.startPairing().code, "Phone", "drive", Date.now(), [], false)!;
  const device = rows.match(paired.token)!;
  return { dir, rows, nodes, device, address: "100.64.0.9", owner: "owner@example.com" };
}

it("removal remembers the first of nine StableNodeIDs seen on the same row", () => {
  const { rows, nodes, device } = fixture();
  for (let index = 0; index < 9; index++) rows.noteTailnetNode(device.id, `nNode${index}`);
  expect(rows.revoke(device.id)).toBe(true);
  expect(nodes.isBlocked("nNode0")).toBe(true);
});
