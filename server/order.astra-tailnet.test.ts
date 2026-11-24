import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { mergeTailnetNodes, TailnetNodes } from "./tailnet-nodes.ts";

const dirs: string[] = [];
const phone = { id: "nPhone", hostname: "phone", login: "owner@example.com" };
function dir() { const root = mkdtempSync(join(tmpdir(), "astra-order-")); dirs.push(root); return root; }
afterEach(() => { for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("a removal newer than a sibling Allow wins even when already blocked here", () => {
  const active = dir();
  const other = join(active, "sibling");
  mkdirSync(other, { mode: 0o700 });
  let now = Date.now();
  const nodes = new TailnetNodes(active, null, () => now);
  const rows = new DeviceStore(active);
  rows.attachTailnetNodes(nodes);
  const paired = rows.pair(rows.startPairing().code, "Phone", "drive", Date.now(), [], false)!;
  const row = rows.match(paired.token)!;
  rows.noteTailnetNode(row.id, phone.id);
  nodes.block([phone]);
  expect(mergeTailnetNodes(active, other)).toBeNull();
  now += 1000;
  new TailnetNodes(other, null, () => now).allow(phone.id);
  now += 1000;
  expect(rows.revoke(row.id)).toBe(true);
  expect(mergeTailnetNodes(active, other)).toBeNull();
  expect(new TailnetNodes(active).isBlocked(phone.id)).toBe(true);
});
