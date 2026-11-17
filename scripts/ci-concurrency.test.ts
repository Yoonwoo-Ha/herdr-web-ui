import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Workflow = { on: { push?: { branches?: string[] } }; concurrency: { group: string; "cancel-in-progress": string } };
const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as Workflow;

it("keeps main's running push run and its newest waiting one, and groups a pull request by its branch", () => {
  expect(ci.on.push?.branches).toContain("main");
  expect(ci.concurrency).toEqual({
    group: "validation-${{ github.workflow }}-${{ github.ref }}${{ github.event_name == 'workflow_dispatch' && '-manual' || '' }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
});
