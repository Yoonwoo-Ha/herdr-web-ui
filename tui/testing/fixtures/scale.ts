import { type Fixture, place } from "./fixture.ts";

/** The terminals of the scale fixture, the workspaces they are in, and how many share its largest tab (the one shown first). */
export const SCALE_TERMINALS = 200;
export const SCALE_WORKSPACES = 50;
export const SCALE_LARGEST_TAB = 16;

/** 200 terminals in 50 workspaces: the first workspace's one tab holds 16 panes, the rest are spread two tabs to a workspace. */
export const scale: Fixture = {
  build(core) {
    for (let n = 0; n < SCALE_LARGEST_TAB; n++) place(core, { space: "w00", spaceName: "big", tab: "t00", tabName: "big" }, `pane ${n}\r\n`);
    for (let n = SCALE_LARGEST_TAB; n < SCALE_TERMINALS; n++) {
      const workspace = 1 + (n % (SCALE_WORKSPACES - 1));
      const tab = Math.floor(n / (SCALE_WORKSPACES - 1)) % 2;
      const id = String(workspace).padStart(2, "0");
      place(core, { space: `w${id}`, spaceName: `ws ${id}`, tab: `t${id}-${tab}`, tabName: `tab ${tab}` }, `terminal ${n}\r\n`);
    }
  },
};
