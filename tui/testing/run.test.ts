import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { place } from "./fixtures/fixture.ts";
import { Run } from "./run.ts";

/** A listener the fake core opened for a run: where, whether it was closed, and its own close for what a test leaves behind. */
interface Watched { path: string; closed: boolean; close: () => Promise<void> }

const opened: Watched[] = [];
afterEach(async () => {
  for (const listener of opened.splice(0)) {
    if (!listener.closed) await listener.close();
    rmSync(dirname(listener.path), { recursive: true, force: true });
  }
});

/** A core with one terminal whose listeners are recorded as they open and close. */
function watchedCore(): { core: FakeHcCore; listeners: Watched[] } {
  const core = new FakeHcCore();
  place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, "pane\r\n");
  const listeners: Watched[] = [];
  const listen = core.listen.bind(core);
  core.listen = async (path) => {
    const listener = await listen(path);
    const watched: Watched = { path, closed: false, close: () => listener.close() };
    listeners.push(watched);
    opened.push(watched);
    return { close: async () => { watched.closed = true; await listener.close(); } };
  };
  return { core, listeners };
}

describe("the test run", () => {
  it("a startup that fails closes its listener, removes its folder and throws the startup error", async () => {
    const { core, listeners } = watchedCore();
    const failing = { build: () => {}, online: () => { throw new Error("the fixture's online hook failed"); } };
    await expect(Run.start({ core, fixture: failing })).rejects.toThrow("the fixture's online hook failed");
    expect(listeners.map((listener) => [listener.closed, existsSync(dirname(listener.path))])).toEqual([[true, false]]);
  });

  it("a close whose settling fails still closes the listener and removes the folder, and throws the settling error", async () => {
    const { core, listeners } = watchedCore();
    const run = await Run.start({ core });
    run.settle = () => Promise.reject(new Error("the run did not settle"));
    await expect(run.close()).rejects.toThrow("the run did not settle");
    expect([listeners.map((listener) => listener.closed), existsSync(run.folder)]).toEqual([[true], false]);
  });

  it("a close whose settling and folder removal both fail throws the settling error, and still closes the listener", async () => {
    const { core, listeners } = watchedCore();
    const run = await Run.start({ core });
    // a file in a folder that cannot be written: the run's folder cannot be removed
    const locked = join(run.folder, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "kept"), "");
    chmodSync(locked, 0o500);
    run.settle = () => Promise.reject(new Error("the run did not settle"));
    try {
      await expect(run.close()).rejects.toThrow("the run did not settle");
      expect([listeners.map((listener) => listener.closed), existsSync(join(locked, "kept"))]).toEqual([[true], true]);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(run.folder, { recursive: true, force: true });
    }
  });
});
