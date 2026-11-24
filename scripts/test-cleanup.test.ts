import { describe, expect, it } from "bun:test";
import { cleanUpAll, coreStops } from "./test-cleanup.ts";
import type { StopReport } from "./test-hc.ts";

const CLEAN: StopReport = { pids: [7], killed: [], unproven: [], alive: [], socketGone: true, rootGone: true };

describe("a suite's teardown", () => {
  it("stops the second core when the first did not stop cleanly, and every step after them, then fails once", async () => {
    const done: string[] = [];
    const core = (name: string, report: StopReport) => ({ stop: async () => { done.push(name); return report; } });
    const teardown = cleanUpAll([
      () => { done.push("ptys"); },
      ...coreStops([core("first", { ...CLEAN, alive: [7], socketGone: false }), core("second", CLEAN)]),
      () => { done.push("build"); },
    ]);
    await expect(teardown).rejects.toThrow(/did not stop cleanly: .*"alive":\[7\]/);
    expect(done).toEqual(["ptys", "first", "second", "build"]);
  });

  it("goes on after a step that throws and after one that rejects, and names every failure", async () => {
    const done: string[] = [];
    const failed = await cleanUpAll([
      () => { throw new Error("one"); },
      async () => { throw new Error("two"); },
      () => { done.push("last"); },
    ]).then(() => null, (error: unknown) => error);
    expect(done).toEqual(["last"]);
    expect(failed instanceof AggregateError ? failed.errors.map((error: Error) => error.message) : failed).toEqual(["one", "two"]);
  });

  it("settles without a word when every step did its work", async () => {
    expect(await cleanUpAll([...coreStops([{ stop: async () => CLEAN }]), () => undefined])).toBeUndefined();
  });
});
