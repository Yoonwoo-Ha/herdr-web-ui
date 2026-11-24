import type { FakeCoreOptions, FakeHcCore } from "../../../server/herdr-core/core.fake.ts";
import { PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../../server/herdr-core/snapshot.ts";

/**
 * A core for tui/testing/run.ts to show: `build` fills a fresh fake core (terminals, their labels and first paints,
 * documents); `online` runs once the screen's line is up, for what only reaches a subscriber (events).
 */
export interface Fixture {
  readonly options?: FakeCoreOptions;
  build(core: FakeHcCore): void;
  online?(core: FakeHcCore): void;
}

/** Text as the fake core sends it: its UTF-8 bytes, one char per byte. */
const wire = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

/** A terminal in workspace `space` and tab `tab` (ids and names), its first paint `paint`; answers its address. */
export function place(core: FakeHcCore, where: { space: string; spaceName: string; tab: string; tabName: string; pane?: string; on?: string; cwd?: string }, paint: string): string {
  const labels: Record<string, string> = { [SPACE_LABEL]: where.space, [WORKSPACE_NAME_LABEL]: where.spaceName, [TAB_LABEL]: where.tab, [TAB_NAME_LABEL]: where.tabName };
  if (where.pane) labels[PANE_NAME_LABEL] = where.pane;
  const terminal = core.spawn({ labels, ...(where.on ? { on: where.on } : {}), ...(where.cwd ? { cwd: where.cwd } : {}) });
  core.setPaint(terminal.address, { body: wire(paint) });
  return terminal.address;
}
