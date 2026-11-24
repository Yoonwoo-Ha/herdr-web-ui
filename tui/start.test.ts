import { describe, expect, it } from "bun:test";
import { insideOwnCore, parseArgs, SCREEN_FOLDER, screenFolder, stateFolder, targetEnv } from "./start.ts";

describe("the entry's arguments", () => {
  it("answers -h, -V and --session NAME", () => {
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-V"])).toEqual({ kind: "version" });
    expect(parseArgs([])).toEqual({ kind: "run", session: null });
    expect(parseArgs(["--session", "work"])).toEqual({ kind: "run", session: "work" });
    expect(parseArgs(["--session=work.2"])).toEqual({ kind: "run", session: "work.2" });
  });

  it("refuses anything else: an unknown word, --session with no value, an empty one, a path, two of them", () => {
    for (const argv of [["--bogus"], ["-h", "-V"], ["--session"], ["--session", ""], ["--session="], ["--session", "a/b"], ["--session", ".."], ["--session", "a", "--session", "b"], ["x"]]) {
      expect(parseArgs(argv).kind).toBe("bad");
    }
  });
});

describe("which core the screen joins", () => {
  it("is the flag's session, which clears an inherited HC_SOCKET; else the environment as it is", () => {
    expect(targetEnv({ HC_SOCKET: "/a.sock", HC_SESSION: "x" }, "work")).toEqual({ HC_SOCKET: undefined, HC_SESSION: "work" });
    expect(targetEnv({ HC_SOCKET: "/a.sock", HC_SESSION: "x" }, null)).toEqual({ HC_SOCKET: "/a.sock", HC_SESSION: "x" });
  });

  it("is refused from inside a pane of that same core, and joined from another core's pane or outside any", () => {
    const same = (path: string) => path;
    expect(insideOwnCore({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/a.sock" }, "/a.sock", "/x.sock", same)).toBe(true);
    expect(insideOwnCore({ HC_TERMINAL_ID: "t1" }, "/a.sock", "/a.sock", same)).toBe(true);
    expect(insideOwnCore({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/a.sock" }, "/b.sock", "/a.sock", same)).toBe(false);
    expect(insideOwnCore({ HC_TERMINAL_SOCKET: "/a.sock" }, "/a.sock", "/a.sock", same)).toBe(false);
    expect(insideOwnCore({ HC_TERMINAL_ID: "" }, "/a.sock", "/a.sock", same)).toBe(false);
  });
});

describe("the state folder", () => {
  it("is OVIS_TUI_STATE_DIR, else ovis-tui under XDG_STATE_HOME, else under ~/.local/state", () => {
    expect(stateFolder({ OVIS_TUI_STATE_DIR: "/s", XDG_STATE_HOME: "/x" }, "/home/u")).toBe("/s");
    expect(stateFolder({ XDG_STATE_HOME: "/x" }, "/home/u")).toBe("/x/ovis-tui");
    expect(stateFolder({}, "/home/u")).toBe("/home/u/.local/state/ovis-tui");
  });
});

describe("the folder the screen offers a new workspace in", () => {
  it("is the one `ovis tui` was typed in, as the launcher names it, else the screen's own working folder", () => {
    expect(screenFolder({ [SCREEN_FOLDER]: "/home/me/project" }, "/install")).toBe("/home/me/project");
    expect(screenFolder({}, "/home/me/elsewhere")).toBe("/home/me/elsewhere");
    expect(screenFolder({ [SCREEN_FOLDER]: "" }, "/home/me/elsewhere")).toBe("/home/me/elsewhere");
  });
});
