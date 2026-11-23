import { describe, expect, it } from "bun:test";
import { lastAttemptArtifacts } from "./ci-browser-timings.ts";
import { CHECK_ARTIFACT, fileSeconds, testQueue } from "./ci-test-timings.ts";

describe("test timings", () => {
  const sizes: Record<string, number> = { "a.test.ts": 900, "b.test.ts": 500, "c.test.ts": 300, "new-small.test.ts": 10, "new-large.test.ts": 2_000 };
  const size = (file: string) => sizes[file]!;

  it("starts the longest file first, a file without an entry before all, and the larger of the same seconds", () => {
    expect(testQueue(Object.keys(sizes), { "a.test.ts": 2, "b.test.ts": 40, "c.test.ts": 2, "gone.test.ts": 99 }, size))
      .toEqual(["new-large.test.ts", "new-small.test.ts", "b.test.ts", "a.test.ts", "c.test.ts"]);
  });

  it("keeps the size order without a table", () => {
    expect(testQueue(Object.keys(sizes), {}, size)).toEqual(["new-large.test.ts", "a.test.ts", "b.test.ts", "c.test.ts", "new-small.test.ts"]);
  });

  it("reads the seconds of each file that passed, from a unit or an integration log", () => {
    expect(fileSeconds([
      "unit: 3 test files",
      "--- src/lib/ws.test.ts (worker-9, 0.2s, exit 0)",
      "(pass) a test [73.60ms]",
      "--- server/broken.test.ts (worker-2, 12.0s, exit 1)",
      "[integration] --- server/relay/service.contract.test.ts (check-8b9513-4, 5.5s, exit 0)",
      "--- src/components/Dialog.test.tsx (worker-6, 21s, exit 0)",
      "unit: 3 pass, 1 fail, 0 skip in 3 files, 12 at a time, 189.7s",
    ].join("\n"))).toEqual({ "src/lib/ws.test.ts": 0.2, "server/relay/service.contract.test.ts": 5.5, "src/components/Dialog.test.tsx": 21 });
  });

  it("reads each check job's logs of a run's last attempt only", () => {
    expect(lastAttemptArtifacts(["check-fast-7-1", "check-fast-7-2", "integration-logs-7-1", "browser-main-7-1", "dist-shell"], CHECK_ARTIFACT))
      .toEqual(["check-fast-7-2", "integration-logs-7-1"]);
  });
});
