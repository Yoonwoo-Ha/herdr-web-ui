/** Agents' live SQLite databases, read from private copies (Antigravity's conversations, Hermes's state.db). */
import { constants as sqliteConstants, Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export class SnapshotUnavailable extends Error { constructor() { super("The database could not be read from a copy"); } }

// Timestamps tick coarsely, so a same-size rewrite just after a read can keep both of them. Only a
// read this long after the files' last change may be reused (git's "racy" rule).
const SNAPSHOT_SETTLED_MS = 2000;

/** A value read before, kept under the key of the database files it was read from. */
export interface SnapshotCache<T> { get(key: string): T | undefined; set(key: string, value: T): void }

/**
 * `read` on an agent's SQLite database at `dbPath`, which the agent writes as it runs (Antigravity's conversations,
 * Hermes's state.db): never opened so that SQLite could write beside it, a database in WAL mode is read from a private
 * copy of at most `maxBytes`, and anything that changes the files during the read refuses it (SnapshotUnavailable).
 * `cache` answers for files unchanged and settled since. A database not in WAL mode is opened immutable in place,
 * which SQLite never writes, unless `copy` is `always`: then it is read from a copy too (with its WAL, if any).
 */
export function readSqliteSnapshot<T>(dbPath: string, read: (db: Database) => T, cache: SnapshotCache<T> | null, maxBytes: number,
  beforeOpen?: () => void, copy: "wal" | "always" = "wal"): T {
  let db: Database | undefined;
  let fd: number | undefined;
  const sideFds: number[] = [];
  let snapshot: string | undefined;
  let catalogKey: string | undefined;
  let reused: T | undefined;
  const began = Date.now();
  try {
    if (realpathSync(dbPath) !== dbPath) throw new SnapshotUnavailable();
    const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(dbPath, readFlags);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new SnapshotUnavailable();
    const header = Buffer.alloc(20);
    const walBefore = existsSync(`${dbPath}-wal`), shmBefore = existsSync(`${dbPath}-shm`);
    const wal = readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2 && header[19] === 2;
    const files = [{ path: dbPath, fd, stat: before }];
    beforeOpen?.();
    // Every source open is immutable, even if a writer switches journal modes
    // after the header read. Only the private snapshot may create side files.
    // An incomplete WAL pair therefore exposes checkpointed rows only.
    let immutable = true;
    const descriptor = process.platform === "linux" || (process.platform === "darwin" && immutable) ? `/dev/fd/${fd}` : null;
    let name = descriptor ?? dbPath;
    const paired = wal && walBefore && shmBefore;
    if (paired || copy === "always") {
      // A readonly SQLite open can create -wal even with readonly_shm=1. Never open
      // a live source that way: recover its WAL only beside a bounded private copy.
      for (const suffix of paired ? ["-wal", "-shm"] : walBefore ? ["-wal"] : []) {
        const path = `${dbPath}${suffix}`;
        const sideFd = openSync(path, readFlags);
        sideFds.push(sideFd);
        const stat = fstatSync(sideFd, { bigint: true });
        if (!stat.isFile()) throw new SnapshotUnavailable();
        files.push({ path, fd: sideFd, stat });
      }
      const snapshotFiles = files.filter((file) => !file.path.endsWith("-shm"));
      if (snapshotFiles.reduce((bytes, file) => bytes + file.stat.size, 0n) > BigInt(maxBytes)) throw new SnapshotUnavailable();
      const key = snapshotFiles.map(({ stat }) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`).join("|");
      reused = cache?.get(key);
      if (reused !== undefined) catalogKey = key;
      else if (snapshotFiles.every(({ stat }) => began - Number(stat.mtimeNs / 1_000_000n) >= SNAPSHOT_SETTLED_MS
        && began - Number(stat.ctimeNs / 1_000_000n) >= SNAPSHOT_SETTLED_MS)) catalogKey = key;
      // macOS: tmpdir() is under the /var symlink, which SQLITE_OPEN_NOFOLLOW refuses
      if (reused === undefined) {
        snapshot = mkdtempSync(join(tmpdir(), "ovis-sqlite-snapshot-"));
        snapshot = realpathSync(snapshot);
        name = join(snapshot, "snapshot.db");
        for (const [index, file] of snapshotFiles.entries()) {
          const target = openSync(index === 0 ? name : `${name}-wal`, "wx", 0o600);
          try {
            const bytes = Buffer.alloc(64 * 1024);
            const size = Number(file.stat.size);
            let offset = 0;
            while (offset < size) {
              const read = readSync(file.fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
              if (!read) throw new SnapshotUnavailable();
              writeFileSync(target, bytes.subarray(0, read));
              offset += read;
            }
          } finally { closeSync(target); }
        }
      }
      immutable = false;
    }
    let value: T;
    if (reused !== undefined) value = reused;
    else {
      const flags = sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI;
      db = new Database(immutable ? `${pathToFileURL(name).href}?immutable=1` : name,
        descriptor === null || snapshot !== undefined ? flags | sqliteConstants.SQLITE_OPEN_NOFOLLOW : flags);
      const opened = statSync(dbPath, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || realpathSync(dbPath) !== dbPath) throw new SnapshotUnavailable();
      db.exec("PRAGMA busy_timeout = 100");
      value = read(db);
    }
    for (const file of files) {
      const after = statSync(file.path, { bigint: true }), pinned = fstatSync(file.fd, { bigint: true });
      if (after.dev !== file.stat.dev || after.ino !== file.stat.ino || realpathSync(file.path) !== file.path
        || pinned.size !== file.stat.size || pinned.mtimeNs !== file.stat.mtimeNs || pinned.ctimeNs !== file.stat.ctimeNs) throw new SnapshotUnavailable();
    }
    if (existsSync(`${dbPath}-wal`) !== walBefore || existsSync(`${dbPath}-shm`) !== shmBefore
      || (!wal && existsSync(`${dbPath}-journal`))) throw new SnapshotUnavailable();
    if (catalogKey !== undefined) cache?.set(catalogKey, value);
    return value;
  } catch { throw new SnapshotUnavailable(); }
  finally {
    db?.close();
    for (const sideFd of sideFds) closeSync(sideFd);
    if (fd !== undefined) closeSync(fd);
    if (snapshot !== undefined) rmSync(snapshot, { recursive: true, force: true });
  }
}
