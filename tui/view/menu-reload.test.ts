import { expect, it } from "bun:test";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { startLoop } from "../loop.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { HeadlessHost } from "../testing/headless-host.ts";
import { ManualClock } from "../testing/run.ts";

// Outside a hold, Reload must change the map before the tail of either a menu choice or a shortcut.
it.each(["joined", "split", "before first paint", "shortcut joined", "shortcut split"])("Reload precedes its following input outside holds: %s", async (ordering) => {
  const core = new FakeHcCore();
  demo.build(core);
  const host = new HeadlessHost({ cols: 120, rows: 80, answer: "\x1b[?1u\x1b[?2026;2$y\x1b[?62;22c" });
  const clock = new ManualClock();
  let reads = 0;
  const loop = startLoop({
    host, clock, socket: "menu-reload.sock",
    keys: { prefix: "~", focus_pane_right: "prefix+r" },
    readKeys: () => ({ prefix: ++reads === 1 ? "!" : "~", focus_pane_right: "prefix+r" }),
    connect: async () => core.transport(),
  });
  const until = async (ready: () => boolean) => {
    const deadline = clock.current + 5_000;
    while (!ready() && clock.current < deadline) {
      clock.current += 1;
      host.advance(1);
      clock.fireDue();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(ready()).toBe(true);
  };
  try {
    await until(() => loop.panes.views().length === 2 && loop.panes.views().every((view) => view.state.kind === "Live"));
    clock.current += 1;
    host.advance(1);
    const shortcut = ordering.startsWith("shortcut");
    let trigger = "~R";
    if (!shortcut) {
      host.feed("~\r");
      const menu = loop.model().overlays.at(-1);
      if (menu?.kind !== "menu") throw new Error("menu did not open");
      const reload = menu.entries.find((entry) => entry.kind === "action" && entry.action === "reload_config");
      if (!reload?.label) throw new Error("Reload has no menu label");
      trigger = reload.label;
      if (ordering !== "before first paint") await until(() => loop.screen()?.text.join("").includes("+ Menu ") === true);
    }
    const tail = shortcut ? "~q" : "!rz";
    if (ordering.endsWith("split")) {
      host.feed(trigger);
      host.feed(tail);
    } else host.feed(trigger + tail);
    await loop.link.call("machine.list", {});
    expect(loop.report().actions).not.toContain("quit");
    expect({
      actions: loop.report().actions.filter((action) => action === "reload_keys" || action.startsWith("run:")),
      pane: loop.model().focus.panes["t-main"],
      bytes: ["t1", "t2"].map((id) => core.program(id).receivedHex()),
    }).toEqual(shortcut ? { actions: ["reload_keys"], pane: "t1", bytes: ["7e71", ""] }
      : { actions: ["reload_keys"], pane: "t2", bytes: ["", "7a"] });
    expect(loop.report().mode.overlays).toEqual([]);
    expect(reads).toBe(1);
  } finally {
    loop.dispatch({ type: "action", action: "detach", at: clock.current });
    expect(await loop.done).toMatchObject({ kind: "quit" });
    expect(clock.armed()).toBe(0);
  }
}, 60_000);
