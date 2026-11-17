import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEPLOYED_FILE, WORKER_SOURCES, workerFingerprint } from "./release-guards.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// release-guards.ts checks the Worker only on a release tree. This holds every tree to it, so a
// change that widens the Worker's schema cannot merge before the Worker is deployed, and the app
// cannot send the new values before that (telemetry/README.md#deploy).
describe("telemetry Worker", () => {
  test("the deployed Worker is this tree's", () => {
    const deployed = (JSON.parse(read(DEPLOYED_FILE)) as { sha256?: string }).sha256;
    expect(workerFingerprint(WORKER_SOURCES.map(read)), `${WORKER_SOURCES.join(" or ")} changed since the last deploy: from telemetry/, run \`bunx wrangler deploy\`, then \`bun scripts/release-guards.ts --worker-deployed\` and commit ${DEPLOYED_FILE}.`).toBe(deployed!);
  });
});
