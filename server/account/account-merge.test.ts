import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAccountState } from "./account-merge.ts";
import { REMOVAL_FILE } from "./removal-evidence.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-account-merge-"));
  dirs.push(made);
  return made;
}
const put = (at: string, file: string, value: unknown) => writeFileSync(join(at, file), JSON.stringify(value), { mode: 0o600 });

describe("merging two folders' account state fails closed on what it cannot trust (T28, T48, S19)", () => {
  test("T28, S19: removal evidence of an unsupported form is refused, and neither folder is rewritten", () => {
    const [active, sibling] = [dir(), dir()];
    put(sibling, REMOVAL_FILE, { v: 2, markers: [], revokes: [], unrevokes: [] });
    expect(mergeAccountState(active, sibling)).not.toBeNull();
    expect(existsSync(join(active, REMOVAL_FILE))).toBe(false);
  });

  test("T28, S19: a held list that is not one is refused, never merged into holding nobody", () => {
    const [active, sibling] = [dir(), dir()];
    put(active, "account-held.json", { keys: [], full: false });
    put(sibling, "account-held.json", { keys: "everyone", full: "no" });
    expect(mergeAccountState(active, sibling)).not.toBeNull();
    expect(JSON.parse(readFileSync(join(active, "account-held.json"), "utf8"))).toEqual({ keys: [], full: false });
  });

  test("T41, T48: a waiting signed removal one folder counted is waiting in both after the merge", () => {
    const [active, sibling] = [dir(), dir()];
    const waiting = { v: 1, kind: "remove", id: "a".repeat(32), account: "acct_1", key: "k", signer: "s", issued_at: "2026-10-01T00:00:00.000Z", signature: "" };
    put(active, "account-pending.json", []);
    put(sibling, "account-pending.json", [waiting]);
    expect(mergeAccountState(active, sibling)).toBeNull();
    for (const at of [active, sibling]) expect(JSON.parse(readFileSync(join(at, "account-pending.json"), "utf8"))).toEqual([waiting]);
  });

  test("S19: a waiting list that is not one is refused, never merged as empty", () => {
    const [active, sibling] = [dir(), dir()];
    put(sibling, "account-pending.json", { not: "a list" });
    expect(mergeAccountState(active, sibling)).not.toBeNull();
  });

  test("T28, S19: sibling removal evidence the evidence reader would refuse is refused by the merge too", () => {
    if (process.platform === "win32") return;
    const [active, sibling] = [dir(), dir()];
    put(active, REMOVAL_FILE, { v: 1, markers: [], revokes: [], unrevokes: [] });
    put(sibling, REMOVAL_FILE, { v: 1, markers: [], revokes: [], unrevokes: [] });
    chmodSync(join(sibling, REMOVAL_FILE), 0o666);
    expect(mergeAccountState(active, sibling)).not.toBeNull();
  });

  test("T28, S19: sibling removal evidence missing beside its device journal is refused by the merge", () => {
    const [active, sibling] = [dir(), dir()];
    put(active, REMOVAL_FILE, { v: 1, markers: [], revokes: [], unrevokes: [] });
    put(sibling, "device-journal.json", { v: 1, next_seq: 1, entries: [], seen: {}, open: [], trimmed: 0 });
    expect(mergeAccountState(active, sibling)).not.toBeNull();
    expect(existsSync(join(sibling, REMOVAL_FILE))).toBe(false);
  });
});
