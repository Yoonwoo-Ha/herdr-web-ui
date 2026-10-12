import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, sharedSettings, type Settings } from "./settings.ts";
import { preferencesChange, takePreferences, type Baseline } from "./preferencesSync.ts";

const base = (settings: Settings, pins: readonly string[] | null): Baseline => ({ settings: sharedSettings(settings), pins });
const light: Settings = { ...DEFAULT_SETTINGS, theme: "light" };

describe("preferences sync", () => {
  it("sends only the shared settings that changed, and the pins only when they did", () => {
    const known = base(DEFAULT_SETTINGS, ["local:w1:p1"]);
    expect(preferencesChange(known, { settings: { ...DEFAULT_SETTINGS, terminalFontSize: 20, alertsOn: false, wrapCode: true, markdownWidth: "full" }, pins: ["local:w1:p1"] })).toBeNull();
    expect(preferencesChange(known, { settings: { ...light, terminalFontSize: 20, wrapCode: true, markdownWidth: "full" }, pins: ["local:w1:p1"] })).toEqual({ settings: { theme: "light" } });
    expect(preferencesChange(known, { settings: DEFAULT_SETTINGS, pins: [] })).toEqual({ settings: {}, pins: [] });
    expect(preferencesChange(known, { settings: { ...DEFAULT_SETTINGS, usageOrder: ["claude"] }, pins: ["local:w1:p1"] })).toEqual({ settings: { usageOrder: ["claude"] } });
  });

  it("while the server has held no pins, this browser's ride along with its first change, and alone they wait", () => {
    const unknown = base(DEFAULT_SETTINGS, null);
    expect(preferencesChange(unknown, { settings: DEFAULT_SETTINGS, pins: ["local:w1:p1"] })).toBeNull();
    expect(preferencesChange(unknown, { settings: light, pins: ["local:w1:p1"] })).toEqual({ settings: { theme: "light" }, pins: ["local:w1:p1"] });
  });

  it("takes the shared settings the server holds and leaves the device's own", () => {
    const mine: Settings = { ...light, terminalFontSize: 20, alertsOn: false, wrapCode: true, markdownWidth: "full" };
    const taken = takePreferences(base(mine, null), { settings: mine, pins: [] }, { revision: 3, settings: { theme: "dark", palette: "forest" } }, null);
    expect(taken.patch).toEqual({ theme: "dark", palette: "forest" });
    expect(taken.pins).toBeNull();
    expect(taken.base).toEqual({ settings: { ...sharedSettings(mine), theme: "dark", palette: "forest" }, pins: null });
    // nothing to send once taken
    expect(preferencesChange(taken.base, { settings: { ...mine, ...taken.patch }, pins: [] })).toBeNull();
  });

  it("keeps a change made here and not yet sent, which then goes out over the server's value", () => {
    // the page opened with dark, the user chose light before the document arrived
    const taken = takePreferences(base(DEFAULT_SETTINGS, null), { settings: light, pins: [] }, { revision: 1, settings: { theme: "dark", showThinking: false } }, null);
    expect(taken.patch).toEqual({ showThinking: false });
    expect(taken.base.settings["theme"]).toBe("dark");
    expect(preferencesChange(taken.base, { settings: { ...light, showThinking: false }, pins: [] })).toEqual({ settings: { theme: "light" }, pins: [] });
  });

  it("lets a later write from elsewhere win over a value already sent, and keeps the rest of the document", () => {
    // light is on its way; meanwhile another browser set the palette, and then the theme back to dark
    const inFlight = { settings: { theme: "light" } };
    const concurrent = takePreferences(base(DEFAULT_SETTINGS, []), { settings: light, pins: [] }, { revision: 2, settings: { theme: "light", palette: "forest" }, pins: [] }, inFlight);
    expect(concurrent.patch).toEqual({ theme: "light", palette: "forest" });
    const overtaken = takePreferences(base(DEFAULT_SETTINGS, []), { settings: light, pins: [] }, { revision: 3, settings: { theme: "dark" }, pins: [] }, inFlight);
    expect(overtaken.patch).toEqual({ theme: "dark" });
    expect(preferencesChange(overtaken.base, { settings: { ...light, theme: "dark" }, pins: [] })).toBeNull();
  });

  it("leaves a value this browser cannot read, and does not send its own back", () => {
    const taken = takePreferences(base(DEFAULT_SETTINGS, null), { settings: DEFAULT_SETTINGS, pins: [] }, { revision: 1, settings: { theme: "purple", agentCards: "yes", palette: "forest" } }, null);
    expect(taken.patch).toEqual({ palette: "forest" });
    expect(preferencesChange(taken.base, { settings: { ...DEFAULT_SETTINGS, palette: "forest" }, pins: [] })).toBeNull();
  });

  it("joins this browser's pins to the first the server holds, then follows the last write", () => {
    const first = takePreferences(base(DEFAULT_SETTINGS, null), { settings: DEFAULT_SETTINGS, pins: ["local:w1:p1"] }, { revision: 1, settings: {}, pins: ["pc:w2:p3", "local:w1:p1"] }, null);
    expect(first.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    expect(first.base.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    const joined = takePreferences(base(DEFAULT_SETTINGS, null), { settings: DEFAULT_SETTINGS, pins: ["local:w1:p1"] }, { revision: 1, settings: {}, pins: ["pc:w2:p3"] }, null);
    expect(joined.pins).toEqual(["pc:w2:p3", "local:w1:p1"]);
    // the join is this browser's change: it goes out
    expect(preferencesChange(joined.base, { settings: DEFAULT_SETTINGS, pins: joined.pins! })).toEqual({ settings: {}, pins: ["pc:w2:p3", "local:w1:p1"] });
    const later = takePreferences(base(DEFAULT_SETTINGS, ["pc:w2:p3"]), { settings: DEFAULT_SETTINGS, pins: ["pc:w2:p3"] }, { revision: 2, settings: {}, pins: [] }, null);
    expect(later.pins).toEqual([]);
    // a pin made here and not yet sent stays
    const pinning = takePreferences(base(DEFAULT_SETTINGS, ["pc:w2:p3"]), { settings: DEFAULT_SETTINGS, pins: ["pc:w2:p3", "local:w1:p1"] }, { revision: 2, settings: {}, pins: [] }, null);
    expect(pinning.pins).toBeNull();
    expect(pinning.base.pins).toEqual([]);
  });

  it("a watching device takes everything", () => {
    const taken = takePreferences(base(DEFAULT_SETTINGS, ["a:b"]), { settings: light, pins: ["a:b", "c:d"] }, { revision: 5, settings: { theme: "dark" }, pins: [] }, null, true);
    expect(taken.patch).toEqual({ theme: "dark" });
    expect(taken.pins).toEqual([]);
  });
});
