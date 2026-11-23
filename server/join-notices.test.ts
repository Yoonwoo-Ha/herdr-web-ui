import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import { handleJoinSeen, JOIN_SEEN_PATH, JoinNotices, shownTo, WAITING_JOIN_LIMIT, type JoinViewer } from "./join-notices.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const OWN: JoinViewer = { ownWindow: true, since: undefined };
const OLDER_DEVICE: JoinViewer = { ownWindow: false, since: "2026-01-01T00:00:00.000Z" };

function notices(listed = new Set<string>(), stands = new Set<string>()) {
  const dir = mkdtempSync(join(tmpdir(), "join-notices-"));
  dirs.push(dir);
  const path = join(dir, "join-notices.json");
  const open = () => new JoinNotices(path, (id) => stands.has(id), (id) => listed.has(id));
  const joins = open();
  const live: DevicePairedEvent[] = [];
  const seen: string[] = [];
  joins.onListed((event) => live.push(event));
  joins.onSeen((id) => seen.push(id));
  return { joins, listed, stands, live, seen, open };
}

const pairing = (id: string, at = new Date().toISOString()): DevicePairedEvent => ({ type: "device-paired", event_id: id.padStart(16, "0"), device_id: id, label: id, enrolled_at: at });

test("the devices one whole read let in are one notice, naming the first and how many more, for this PC's own window alone", () => {
  const { joins, listed, live } = notices(new Set(["a", "b", "c"]));
  joins.addListed([{ id: "a", label: "Pixel 9" }, { id: "b", label: "iPad" }, { id: "c", label: "Laptop" }, { id: "gone", label: "Gone" }], new Date().toISOString());
  expect(live.map((event) => [event.device_id, event.label])).toEqual([["a", "Pixel 9 +2"]]);
  const [waiting] = joins.waiting();
  expect(waiting?.rows?.map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect([shownTo(waiting!, OWN), shownTo(waiting!, OLDER_DEVICE), shownTo(waiting!, { ownWindow: false, since: undefined })]).toEqual([true, false, false]);
  listed.clear();
  joins.addListed([{ id: "x", label: "Nobody" }], new Date().toISOString());
  expect(live).toHaveLength(1);
});

test("a list admission's notice never pushes out a pairing's waiting join", () => {
  const { joins } = notices(new Set(["l1", "l2", "l3", "l4"]), new Set(["p1", "p2", "p3"]));
  for (const id of ["p1", "p2", "p3"]) joins.add(pairing(id), []);
  for (const id of ["l1", "l2", "l3", "l4"]) joins.addListed([{ id, label: id }], new Date().toISOString());
  const kept = joins.waiting();
  expect(kept.filter((join) => join.rows === undefined).map((join) => join.event.device_id)).toEqual(["p1", "p2", "p3"]);
  expect(kept.filter((join) => join.rows !== undefined)).toHaveLength(WAITING_JOIN_LIMIT);
});

test("a notice is taken back when none of its devices is listed any more, and names the ones still listed when some are", () => {
  const { joins, listed, live, seen, open } = notices(new Set(["a", "b"]));
  joins.addListed([{ id: "a", label: "Pixel 9" }, { id: "b", label: "iPad" }], "2026-11-23T10:00:00.000Z", Date.parse("2026-11-23T10:00:00.000Z"));
  const first = live[0]!;
  joins.settleListed();
  expect(seen).toEqual([]);
  listed.delete("a");
  joins.settleListed(Date.parse("2026-11-23T10:00:00.000Z"));
  expect(seen).toEqual([first.event_id]);
  const second = live[1]!;
  expect([second.device_id, second.label, second.enrolled_at]).toEqual(["b", "iPad", first.enrolled_at]);
  // a reopened file holds the notice of the row still listed
  expect(open().waiting(Date.parse("2026-11-23T10:00:00.000Z")).map((join) => join.event.event_id)).toEqual([second.event_id]);
  listed.delete("b");
  expect(joins.waiting(Date.parse("2026-11-23T10:00:00.000Z"))).toEqual([]);
  joins.settleListed(Date.parse("2026-11-23T10:00:00.000Z"));
  expect(live).toHaveLength(2);
});

test("only this PC's own window may mark a list admission's notice seen", async () => {
  const { joins } = notices(new Set(["a"]));
  joins.addListed([{ id: "a", label: "Pixel 9" }], new Date().toISOString());
  const [waiting] = joins.waiting();
  const mark = (viewer: JoinViewer) => handleJoinSeen(new Request(`http://127.0.0.1${JOIN_SEEN_PATH}`, {
    method: "POST", headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ event_id: waiting!.event.event_id }),
  }), joins, { level: "full", via: "relay", role: "drive" }, viewer);
  expect((await mark(OLDER_DEVICE)).status).toBe(404);
  expect(joins.waiting()).toHaveLength(1);
  expect((await mark(OWN)).status).toBe(200);
  expect(joins.waiting()).toEqual([]);
});
