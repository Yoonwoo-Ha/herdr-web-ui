import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { usageCounters } from "../lib/usageCounters.ts";
import type { InboxRailProps } from "./InboxRail.tsx";

const rowMenu = await import("./RowMenu.tsx");
function RowMenu(_props: Parameters<typeof rowMenu.RowMenu>[0]) { return null; }
await mock.module("./RowMenu.tsx", () => ({ ...rowMenu, RowMenu }));
const { InboxRail } = await import("./InboxRail.tsx");

describe("InboxRail", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let pressed: string[];
  let frames: FrameRequestCallback[];
  const runFrames = (): Promise<void> => act(async () => { for (const run of frames.splice(0)) run(0); });

  beforeEach(() => {
    pressed = [];
    frames = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const on = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...on, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), requestAnimationFrame: (run: FrameRequestCallback) => frames.push(run), cancelAnimationFrame() {} } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...on, body: { nodeType: 1, children: [] }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const props = (change: Partial<InboxRailProps> = {}): InboxRailProps => ({
    onExit: () => pressed.push("exit"), onInbox: () => pressed.push("inbox"),
    waiting: null, alerts: { on: true, title: "Alerts on in the app. Tap to turn them off", toggle: () => pressed.push("alerts") },
    onSettings: () => pressed.push("settings"), connection: null, saidByThread: false,
    shortcutTitle: (label, id) => id === "settings" ? `${label} (Ctrl+,)` : label,
    ...change,
  });
  const view = (change: Partial<InboxRailProps>) => createElement(SettingsProvider, null, createElement(InboxRail, props(change)));
  const draw = async (change: Partial<InboxRailProps> = {}): Promise<ReactTestInstance> => {
    await act(async () => { renderer = create(view(change)); });
    return renderer!.root;
  };
  const redraw = (change: Partial<InboxRailProps>) => act(async () => { renderer!.update(view(change)); });
  const buttons = (root: ReactTestInstance): ReactTestInstance[] => root.findAll((node) => node.type === "button");
  const kind = (node: ReactTestInstance): string => String(node.props.className).split(" ").find((name) => name.startsWith("inbox-rail-") && name !== "inbox-rail-item") ?? "";
  const button = (root: ReactTestInstance, name: string): ReactTestInstance => buttons(root).find((node) => kind(node) === `inbox-rail-${name}`)!;
  const named = (node: ReactTestInstance): [name: unknown, tooltip: unknown] => [node.props["aria-label"], node.props.title];
  const glyph = (node: ReactTestInstance): string => String(node.findByType("svg").props.className).split(" ").find((name) => name.startsWith("lucide-")) ?? "";
  const press = (node: ReactTestInstance) => act(async () => { node.props.onClick(); });

  it("is a navigation landmark named for the mode, apart from the list's own", async () => {
    const nav = (await draw()).findByType("nav");
    expect(nav.props["aria-label"]).toBe("Inbox mode");
  });

  it("holds the place at its top, then alerts, the main view and Settings, the last, in its lower group, each a plain button, and no magnifier", async () => {
    const root = await draw();
    const groups = root.findAll((node) => node.type === "div" && String(node.props.className).split(" ").includes("inbox-rail-group"));
    expect(root.findAll((node) => node.type === "svg").some((node) => String(node.props.className).split(" ").includes("lucide-search"))).toBe(false);
    expect(groups.map((group) => [String(group.props.className).split(" ").at(-1), buttons(group).map(kind)])).toEqual([
      ["is-top", ["inbox-rail-place"]],
      ["is-lower", ["inbox-rail-alerts", "inbox-rail-main", "inbox-rail-settings"]],
    ]);
    expect(kind(buttons(root).at(-1)!)).toBe("inbox-rail-settings");
    for (const node of buttons(root)) expect([node.props.type, node.props.tabIndex, node.props.disabled === true]).toEqual(["button", undefined, false]);
  });

  it("takes the way back to the main view from the monitor right above Settings, named and titled for it, and opens no menu of PCs", async () => {
    const root = await draw();
    const main = button(root, "main");
    expect([...named(main), glyph(main), main.props["aria-haspopup"], main.props["aria-expanded"]]).toEqual(["Back to main view", "Back to main view", "lucide-monitor", undefined, undefined]);
    expect(buttons(root).findIndex((node) => node === main)).toBe(buttons(root).length - 2);
    expect(root.findAllByType(RowMenu)).toEqual([]);
    await press(main);
    expect(pressed).toEqual(["exit"]);
  });

  it("marks the inbox as the current page, the one place the rail has, and a press asks the list for its top", async () => {
    const root = await draw();
    const place = button(root, "place");
    expect(named(place)).toEqual(["Agent inbox", "Agent inbox"]);
    expect(buttons(root).filter((node) => node.props["aria-current"] !== undefined).map((node) => [kind(node), node.props["aria-current"]])).toEqual([["inbox-rail-place", "page"]]);
    await press(place);
    expect(pressed).toEqual(["inbox"]);
  });

  it("still takes a press when its count fails", async () => {
    const counting = spyOn(usageCounters, "count").mockImplementation(() => { throw new Error("storage full"); });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const root = await draw();
      await press(button(root, "place"));
      await press(button(root, "main"));
    } finally { counting.mockRestore(); logged.mockRestore(); }
    expect(pressed).toEqual(["inbox", "exit"]);
  });

  it("draws the waiting count only while an agent waits, first in the lower group, and a press opens the next one", async () => {
    const root = await draw();
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
    await redraw({ waiting: { count: 12, open: () => pressed.push("next") } });
    const lower = root.findAll((node) => node.type === "div" && String(node.props.className).split(" ").includes("is-lower"))[0]!;
    expect(buttons(lower).map(kind)).toEqual(["inbox-rail-waiting", "inbox-rail-alerts", "inbox-rail-main", "inbox-rail-settings"]);
    const waiting = button(root, "waiting");
    expect(named(waiting)).toEqual(["12 waiting for you", "Open the next session waiting for you"]);
    const pill = waiting.findByProps({ "data-count": 12 });
    expect([pill.props.className, pill.props["aria-hidden"]]).toEqual(["header-more-dot is-waiting", "true"]);
    await press(waiting);
    expect(pressed).toEqual(["next"]);
    await redraw({ waiting: null });
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
  });

  it("switches this device's alerts: pressed and a bell while on, not pressed and a struck bell while off, the bell's own sentence as its tooltip", async () => {
    const root = await draw();
    const alerts = () => button(root, "alerts");
    expect([...named(alerts()), alerts().props["aria-pressed"], glyph(alerts())]).toEqual(["Alerts", "Alerts on in the app. Tap to turn them off", true, "lucide-bell"]);
    await press(alerts());
    expect(pressed).toEqual(["alerts"]);
    await redraw({ alerts: { on: false, title: "Alerts off on this device. Tap to turn them on", toggle: () => pressed.push("alerts") } });
    expect([...named(alerts()), alerts().props["aria-pressed"], glyph(alerts())]).toEqual(["Alerts", "Alerts off on this device. Tap to turn them on", false, "lucide-bell-off"]);
  });

  it("opens Settings, its shortcut in the tooltip where one is set", async () => {
    const root = await draw({ shortcutTitle: (label, id) => id === "settings" ? `${label} (Ctrl+Shift+,)` : label });
    const settings = button(root, "settings");
    expect(named(settings)).toEqual(["Settings", "Settings (Ctrl+Shift+,)"]);
    await press(settings);
    expect(pressed).toEqual(["settings"]);
  });

  describe("the connection", () => {
    const main = (root: ReactTestInstance) => button(root, "main");
    const dot = (root: ReactTestInstance): string | null => {
      const [drawn] = main(root).findAll((node) => node.type === "span" && String(node.props.className).split(" ").includes("inbox-rail-dot"));
      return drawn ? String(drawn.props.className).split(" ").find((name) => name.startsWith("is-")) ?? "" : null;
    };
    const status = (root: ReactTestInstance) => root.findAll((node) => node.props.role === "status").map((node) => [node.props.className, node.children.join("")]);

    it("draws its dot on the main view's monitor only while the connection has something to say, says a lost one in its name, and draws none while the open thread's chip says the same word", async () => {
      const root = await draw();
      expect(dot(root)).toBeNull();
      await redraw({ connection: "reconnecting" });
      expect(dot(root)).toBe("is-reconnecting");
      expect(named(main(root))).toEqual(["Back to main view · Reconnecting…", "Back to main view · Reconnecting…"]);
      await redraw({ connection: "connected" });
      expect(dot(root)).toBe("is-connected");
      expect(named(main(root))).toEqual(["Back to main view", "Back to main view"]);
      expect(main(root).findByProps({ className: "inbox-rail-dot is-connected" }).props["aria-hidden"]).toBe("true");
      await redraw({ connection: "reconnecting", saidByThread: true });
      expect(dot(root)).toBeNull();
      expect(named(main(root))[0]).toBe("Back to main view · Reconnecting…");
      await redraw({ connection: null, saidByThread: false });
      expect(dot(root)).toBeNull();
    });

    it("announces the connection's word from a line that is in the document before it, and nothing the thread's chip says", async () => {
      const root = await draw();
      await runFrames();
      expect(status(root)).toEqual([["visually-hidden", ""]]);
      await redraw({ connection: "reconnecting" });
      expect(status(root)).toEqual([["visually-hidden", "Reconnecting…"]]);
      await redraw({ connection: "connected" });
      expect(status(root)).toEqual([["visually-hidden", "Connected"]]);
      await redraw({ connection: "reconnecting", saidByThread: true });
      expect(status(root)).toEqual([["visually-hidden", ""]]);
    });
  });
});
