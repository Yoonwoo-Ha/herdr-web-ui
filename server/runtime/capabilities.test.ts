import { afterEach, describe, expect, it } from "bun:test";
import { capabilities, HERDR, HERDR_CORE, runtimeIdentity, serveRuntime } from "./capabilities.ts";

afterEach(() => serveRuntime(null));

describe("the runtime a process serves", () => {
  it("is herdr's TUI server until a runtime's start names itself, and again once it stops", () => {
    expect(capabilities()).toBe(HERDR);
    serveRuntime(HERDR_CORE);
    expect(capabilities()).toBe(HERDR_CORE);
    serveRuntime(null);
    expect(capabilities()).toBe(HERDR);
  });

  it("tells herdr's TUI server and herdr-core apart by what each can do", () => {
    expect(HERDR).toEqual({ runtime: "herdr", attach: "pty-cli", agents: "detected", foreground: "job", seen: null, pins: false, machines: false, spawner: "server" });
    expect(HERDR_CORE).toEqual({ runtime: "herdr-core", attach: "hc", agents: "reported", foreground: "leader", seen: "label", pins: true, machines: true, spawner: "core" });
  });
});

describe("the runtime a ping names", () => {
  it("says nothing for herdr's TUI server, whose ping names none", () => {
    expect(runtimeIdentity(undefined)).toEqual({});
    expect(runtimeIdentity({ direct_terminal_attach: true })).toEqual({});
    expect(runtimeIdentity({ layout: { rename: true } })).toEqual({});
  });

  it("keeps herdr-core's layout calls exactly as said, each one not said off", () => {
    expect(runtimeIdentity({ runtime: "herdr-core", layout: { rename: true, split: false, move: true, arrange: false, worktrees: true } }))
      .toEqual({ runtime: "herdr-core", layout: { rename: true, split: false, move: true, arrange: false, worktrees: true } });
    expect(runtimeIdentity({ runtime: "herdr-core", layout: { split: true } }))
      .toEqual({ runtime: "herdr-core", layout: { rename: false, split: true, move: false, arrange: false, worktrees: false } });
    expect(runtimeIdentity({ runtime: "herdr-core" }))
      .toEqual({ runtime: "herdr-core", layout: { rename: false, split: false, move: false, arrange: false, worktrees: false } });
  });

  it("takes only a plain yes for a layout call", () => {
    expect(runtimeIdentity({ runtime: "herdr-core", layout: { rename: "true", split: 1, move: null, arrange: {}, worktrees: true } }))
      .toEqual({ runtime: "herdr-core", layout: { rename: false, split: false, move: false, arrange: false, worktrees: true } });
    expect(runtimeIdentity({ runtime: "herdr-core", layout: "all" }).layout)
      .toEqual({ rename: false, split: false, move: false, arrange: false, worktrees: false });
  });
});
