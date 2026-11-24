import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSqliteSnapshot } from "./sqlite-snapshot.ts";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-sqlite-snapshot-test-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const rows = (db: Database) => db.query<{ v: string }, []>("SELECT v FROM t ORDER BY v").all().map((row) => row.v);

test.each(["delete", "wal"] as const)("reads a %s-journal database from a copy, leaving its folder as it was", (mode) => {
  const path = join(root, "state.db");
  const writer = new Database(path);
  writer.exec(`PRAGMA journal_mode = ${mode}; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one'), ('two')`);
  try {
    const before = readdirSync(root).sort();
    const changed = statSync(path).mtimeMs;
    expect(readSqliteSnapshot(path, rows, null, 1024 * 1024, undefined, "always")).toEqual(["one", "two"]);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(statSync(path).mtimeMs).toBe(changed);
  } finally {
    writer.close();
  }
});
