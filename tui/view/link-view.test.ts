import { describe, expect, it } from "bun:test";
import type { LinkState } from "../core/link.ts";
import type { PaneState } from "../core/pane.ts";
import { LINK_UNKNOWN, paneLive, shownLink, type ShownLink } from "./link-view.ts";

const ONLINE: LinkState = { kind: "Online", epoch: 1 };
const CONNECTING: LinkState = { kind: "Connecting" };
const offline = (code: "closed" | "silent"): LinkState => ({ kind: "Offline", code, retryAt: 250, reason: "the line ended" });

describe("what the screen shows of the link", () => {
  const table: [name: string, before: ShownLink, state: LinkState, shown: ShownLink][] = [
    ["online", LINK_UNKNOWN, ONLINE, { online: true, code: null }],
    ["a line that ended shows its code", { online: true, code: null }, offline("closed"), { online: false, code: "closed" }],
    ["a reconnect attempt keeps the offline line and its code", { online: false, code: "closed" }, CONNECTING, { online: false, code: "closed" }],
    ["the first attempt shows offline with no code yet", LINK_UNKNOWN, CONNECTING, { online: false, code: null }],
    ["an attempt that failed in a new way shows the new code", { online: false, code: "closed" }, offline("silent"), { online: false, code: "silent" }],
    ["back online clears the code", { online: false, code: "silent" }, ONLINE, { online: true, code: null }],
    ["no core", LINK_UNKNOWN, { kind: "NoCore", code: "no_core", reason: "no socket" }, { online: false, code: "no_core" }],
    ["an incompatible core", LINK_UNKNOWN, { kind: "Incompatible", code: "missing_methods", reason: "old", missing: ["doc.get"] }, { online: false, code: "missing_methods" }],
  ];
  for (const [name, before, state, shown] of table) it(name, () => expect(shownLink(before, state)).toEqual(shown));
});

describe("a pane drawn live", () => {
  const table: [state: PaneState, link: ShownLink, live: boolean][] = [
    [{ kind: "Live" }, { online: true, code: null }, true],
    [{ kind: "Live" }, { online: false, code: "closed" }, false],
    [{ kind: "Painting" }, { online: true, code: null }, false],
    [{ kind: "Waiting", why: "offline" }, { online: true, code: null }, false],
    [{ kind: "Ended", reason: "exited", code: 3 }, { online: true, code: null }, false],
  ];
  for (const [state, link, live] of table) it(`${state.kind} with the link ${link.online ? "online" : "offline"}: ${live}`, () => expect(paneLive({ state }, link)).toBe(live));
  it("no pane view: not live", () => expect(paneLive(undefined, { online: true, code: null })).toBe(false));
});
