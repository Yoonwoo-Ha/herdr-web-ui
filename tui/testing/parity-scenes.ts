/**
 * The scenes herdr's TUI and the screen are compared in (docs/tui/visual-parity.md): four worlds of workspaces, tabs
 * and panes, the keys that open each scene from a world's first picture, and the sizes. Shared by the capture script
 * (tui/testing/herdr-capture.ts) and the parity cases (tui/view/parity.test.ts), so both sides get the same scene.
 */
import { join } from "node:path";

export const CAPTURE_FOLDER = join(import.meta.dir, "herdr-captures");
export const PARITY_SIZES = [[120, 40], [80, 24], [64, 20], [45, 30]] as const;

/** One pane of a world: where it stands, and the agent state its program reports, if any. */
export interface PaneSpec {
  readonly workspace: string;
  readonly tab: string;
  readonly name: string;
  readonly agent?: string;
  readonly state?: "working" | "blocked" | "done" | "idle";
  /** the folder under the world's home it starts in (the home itself when absent) */
  readonly folder?: string;
  /** its program asks for the mouse (modes 1000, 1002 and 1006) and prints what it reads as `GOT` and od's characters */
  readonly mouse?: true;
}

/**
 * A git checkout of a world: a folder under its home, on a branch with one commit and no upstream; `linkedTo`: a linked
 * worktree of the checkout in that folder (`git worktree add`) instead of a repository of its own.
 */
export interface Checkout { readonly folder: string; readonly branch: string; readonly linkedTo?: string }

export interface World {
  readonly panes: readonly PaneSpec[];
  /** extra lines for herdr's config (its defaults otherwise) */
  readonly herdrConfig?: string;
  /** git checkouts the world's panes may start in */
  readonly checkouts?: readonly Checkout[];
  /** the sizes it is captured and compared at (all of PARITY_SIZES when absent) */
  readonly sizes?: readonly (readonly [number, number])[];
  /** herdr's server lives for one size and palette only: what a scene leaves (a setting, a program's output) stays there */
  readonly freshServer?: true;
  /** the first picture is complete */
  readonly ready: (text: string) => boolean;
}

export type WorldName = "main" | "agents" | "ended" | "empty" | "git" | "rc" | "mouse";

/** The right-click worlds were measured at the two wide sizes (docs/tui/visual-parity.md R1-R8). */
const WIDE = [[120, 40], [80, 24]] as const;

export const WORLDS: Readonly<Record<WorldName, World>> = {
  /** two workspaces; the first has a tab split in two and a second tab */
  main: {
    panes: [
      { workspace: "work", tab: "one", name: "LEFT" },
      { workspace: "work", tab: "one", name: "RIGHT" },
      { workspace: "work", tab: "two", name: "SOLO" },
      { workspace: "docs", tab: "notes", name: "NOTES" },
    ],
    ready: (text) => text.includes("LEFT-READY"),
  },
  /** a plain shell in front, and one agent in each state in a second workspace */
  agents: {
    panes: [
      { workspace: "home", tab: "sh", name: "SHELL" },
      { workspace: "bots", tab: "run", name: "A-WORK", agent: "claude", state: "working" },
      { workspace: "bots", tab: "run", name: "A-BLOCK", agent: "codex", state: "blocked" },
      { workspace: "bots", tab: "wait", name: "A-DONE", agent: "gemini", state: "done" },
      { workspace: "bots", tab: "wait", name: "A-IDLE", agent: "opencode", state: "idle" },
    ],
    herdrConfig: "[ui.toast]\ndelivery = \"herdr\"\n",
    ready: (text) => text.includes("SHELL-READY"),
  },
  /** a split whose right pane's program ended */
  ended: {
    panes: [
      { workspace: "work", tab: "one", name: "LEFT" },
      { workspace: "work", tab: "one", name: "RIGHT" },
    ],
    ready: (text) => text.includes("LEFT-READY"),
  },
  /** nothing at all */
  empty: { panes: [], ready: () => true },
  /** a plain shell in front, and a second workspace in a git checkout (the sidebar's branch row, S4) */
  git: {
    panes: [
      { workspace: "home", tab: "sh", name: "SHELL" },
      { workspace: "code", tab: "main", name: "CODE", folder: "code" },
    ],
    checkouts: [{ folder: "code", branch: "feature/sidebar" }],
    ready: (text) => text.includes("SHELL-READY"),
  },
  /** the right-click menus' world: a split tab and a second tab, an agent, a git checkout and a linked worktree of it */
  rc: {
    panes: [
      { workspace: "work", tab: "one", name: "LEFT" },
      { workspace: "work", tab: "one", name: "RIGHT" },
      { workspace: "work", tab: "two", name: "SOLO" },
      { workspace: "bots", tab: "run", name: "A-WORK", agent: "claude", state: "working" },
      { workspace: "repo", tab: "main", name: "CODE", folder: "repo" },
      { workspace: "feat", tab: "wt", name: "WT", folder: "repo-wt" },
    ],
    checkouts: [{ folder: "repo", branch: "main" }, { folder: "repo-wt", branch: "feature", linkedTo: "repo" }],
    sizes: WIDE,
    // the group its scenes make stays in herdr's server
    freshServer: true,
    ready: (text) => text.includes("LEFT-READY"),
  },
  /** a plain pane beside a program that asked for the mouse (R8) */
  mouse: {
    panes: [
      { workspace: "work", tab: "one", name: "LEFT" },
      { workspace: "work", tab: "one", name: "MOUSE", mouse: true },
    ],
    sizes: WIDE,
    freshServer: true,
    ready: (text) => text.includes("MOUSE-READY"),
  },
};

/** The sizes a world is captured and compared at. */
export const sizesOf = (world: WorldName): readonly (readonly [number, number])[] => WORLDS[world].sizes ?? PARITY_SIZES;

/** What opens a scene: keys typed, a click on the first label found, a drag over a text, an agent's report, a second viewer. */
export type SceneKeys =
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "click"; readonly labels: readonly string[] }
  | { readonly kind: "drag"; readonly over: string }
  | { readonly kind: "report"; readonly pane: string; readonly state: "working" | "blocked" | "idle" | "done" }
  | { readonly kind: "viewer" }
  /** a right press and release `dx` columns into the first `label` found (on row `row` only, when given) */
  | { readonly kind: "rclick"; readonly label: string; readonly dx?: number; readonly row?: number }
  /** a right press and release at a cell the size decides */
  | { readonly kind: "rclickAt"; readonly at: (cols: number, rows: number) => readonly [number, number] }
  /** each of these in turn */
  | { readonly kind: "steps"; readonly steps: readonly SceneKeys[] };

export interface Scene {
  readonly id: string;
  /** what opens it on herdr and on the screen; absent: the world's first picture */
  readonly herdr?: SceneKeys;
  readonly ovis?: SceneKeys;
  /** what closes it on herdr (Esc when absent) */
  readonly herdrLeave?: SceneKeys;
  /** the keys may change nothing on herdr (it has no such screen) */
  readonly maySame?: boolean;
  /** nothing follows it in herdr's session */
  readonly last?: boolean;
  /** what herdr's picture must show before it is taken (a toast herdr shows a second after its event) */
  readonly expect?: RegExp;
  /** how long herdr's notice may stay before its first picture is back */
  readonly lingerMs?: number;
}

const PREFIX = "\x02";
const type = (text: string): SceneKeys => ({ kind: "type", text });
const both = (keys: SceneKeys) => ({ herdr: keys, ovis: keys });
const rclick = (label: string, dx = 0, row?: number): SceneKeys => ({ kind: "rclick", label, dx, ...(row === undefined ? {} : { row }) });
const click = (label: string): SceneKeys => ({ kind: "click", labels: [label] });
const steps = (...keys: SceneKeys[]): SceneKeys => ({ kind: "steps", steps: keys });
/** the repository's menu, Open worktree..., down to the linked worktree's checkout and Enter: its workspace grouped (R7) */
const GROUP = steps(rclick("repo", 0, 4), click("Open worktree..."), type("\x1b[B"), type("\r"));
/** the group made, and back on the first workspace, where herdr's next client opens */
const GROUPED = steps(GROUP, click("work"));

export const SCENES: Readonly<Record<WorldName, readonly Scene[]>> = {
  main: [
    { id: "main" },
    { id: "prefix", ...both(type(PREFIX)) },
    { id: "help", ...both(type(`${PREFIX}?`)) },
    { id: "help-scroll", ...both(type(`${PREFIX}?\x1b[6~`)) },
    { id: "help-filter", ...both(type(`${PREFIX}?/zoom`)) },
    { id: "menu", herdr: { kind: "click", labels: ["menu", "switch"] }, ovis: type(`${PREFIX}\r`) },
    { id: "picker", ...both(type(`${PREFIX}g`)) },
    { id: "navigate", ...both(type(`${PREFIX}w`)) },
    { id: "confirm", ...both(type(`${PREFIX}D`)) },
    { id: "rename", ...both(type(`${PREFIX}T`)) },
    { id: "newtab", ...both(type(`${PREFIX}c`)) },
    { id: "agentlist", ...both(type(`${PREFIX}a`)), maySame: true },
    { id: "copy", ...both(type(`${PREFIX}[`)) },
    { id: "resize", ...both(type(`${PREFIX}r`)) },
    { id: "zoom", ...both(type(`${PREFIX}z`)), herdrLeave: type(`${PREFIX}z`) },
    { id: "collapsed", ...both(type(`${PREFIX}b`)), herdrLeave: type(`${PREFIX}b`), maySame: true },
    { id: "single", ...both(type(`${PREFIX}n`)), herdrLeave: type(`${PREFIX}p`) },
    { id: "settings", ...both(type(`${PREFIX}s`)), lingerMs: 8000 },
    { id: "toast", ...both({ kind: "drag", over: "line 2 of LEFT" }), expect: /copied/, lingerMs: 9000 },
    { id: "viewers", ...both({ kind: "viewer" }), maySame: true, last: true },
  ],
  agents: [
    { id: "agents" },
    { id: "agents-collapsed", ...both(type(`${PREFIX}b`)), herdrLeave: type(`${PREFIX}b`), maySame: true },
    { id: "agents-picker", ...both(type(`${PREFIX}g`)) },
    { id: "agents-list", ...both(type(`${PREFIX}a`)), maySame: true },
    { id: "agents-menu", herdr: { kind: "click", labels: ["menu", "switch"] }, ovis: type(`${PREFIX}\r`) },
    { id: "toast-agent", ...both({ kind: "report", pane: "A-WORK", state: "blocked" }), expect: /needs attention|claude waiting/, herdrLeave: { kind: "report", pane: "A-WORK", state: "working" }, lingerMs: 12000 },
    { id: "agents-tab", ...both(type(`${PREFIX}w\x1b[B\r`)), last: true },
  ],
  ended: [{ id: "ended" }],
  empty: [{ id: "empty" }, { id: "empty-prefix", ...both(type(PREFIX)), last: true }],
  rc: [
    { id: "rc-base" },
    { id: "rc-pane-focused", ...both(rclick("line 2 of LEFT", 3)) },
    { id: "rc-pane-unfocused", ...both(rclick("line 2 of RIGHT", 3)) },
    { id: "rc-pane-keys", ...both(steps(rclick("line 2 of RIGHT", 3), type("\x1b[B\x1b[B"))) },
    { id: "rc-pane-header", ...both(rclick("RIGHT", 1, 1)) },
    // the left pane's bottom border, near its middle
    { id: "rc-pane-bottom", ...both({ kind: "rclickAt", at: (cols, rows) => [Math.round(cols * 0.42), rows - 1] }) },
    { id: "rc-tab", ...both(rclick("two", 0, 0)) },
    { id: "rc-workspace", ...both(rclick("bots", 0, 3)) },
    { id: "rc-workspace-git", ...both(rclick("repo", 0, 4)) },
    { id: "rc-rename-pane", ...both(steps(rclick("line 2 of RIGHT", 3), click("Rename pane"))) },
    { id: "rc-rename-workspace", ...both(steps(rclick("bots", 0, 3), click("Rename"))) },
    { id: "rc-close-workspace", ...both(steps(rclick("bots", 0, 3), click("Close"))) },
    { id: "rc-open-worktree", ...both(steps(rclick("repo", 0, 4), click("Open worktree..."))) },
    // Enter on the linked worktree's checkout in Open worktree... goes to its workspace and groups it under the repository's
    // (R7): herdr keeps the group from here on, so on herdr each scene below starts where the one before it ended, and on
    // the screen from the world's start
    { id: "rc-group", herdr: GROUP, ovis: GROUP, herdrLeave: type("") },
    { id: "rc-workspace-group", herdr: rclick("repo", 0, 4), ovis: steps(GROUPED, rclick("repo", 0, 4)) },
    { id: "rc-workspace-worktree", herdr: rclick("└─", 5), ovis: steps(GROUPED, rclick("└─", 5)) },
    { id: "rc-collapse", herdr: steps(rclick("repo", 0, 4), click("Collapse")), ovis: steps(GROUPED, rclick("repo", 0, 4), click("Collapse")), herdrLeave: steps(rclick("repo", 0, 4), click("Expand")) },
    { id: "rc-close-group", herdr: steps(rclick("repo", 0, 4), click("Close group")), ovis: steps(GROUPED, rclick("repo", 0, 4), click("Close group")), last: true },
  ],
  mouse: [
    { id: "mouse-base" },
    { id: "rc-mouse-menu", ...both(rclick("MOUSE-READY", 3)) },
    { id: "rc-mouse-program", ...both(steps(rclick("MOUSE-READY", 3), click("Send right-clicks to pane"), rclick("MOUSE-READY", 3))), last: true },
  ],
  git: [{ id: "git" }, { id: "git-focus", ...both(type(`${PREFIX}w\x1b[B\r`)), last: true }],
};
