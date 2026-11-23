import { describe, expect, it } from "bun:test";

import { handlers, hub } from "./status.fake.ts";

// the adversarial review of #4480: a Claude's hook requests were held under the pane ID it was started in, which herdr
// moves and reuses (server/approvals/hub.ts forget)
describe("a pane that leaves its ID", () => {
  it.each([
    ["ends", () => handlers.onPaneEnded("w1:p1")],
    ["closes", () => handlers.onPaneClosed("w1:p1")],
    ["moves to another workspace", () => handlers.onPaneMoved("w1:p1", "w2:p1")],
  ] as const)("says so when it %s", (_label, away) => {
    const vacated: string[] = [];
    hub(undefined, undefined, undefined, undefined, undefined, (paneId) => vacated.push(paneId));
    away();
    expect(vacated).toEqual(["w1:p1"]);
  });
});
