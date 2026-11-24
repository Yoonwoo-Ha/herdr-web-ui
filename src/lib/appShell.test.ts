import { afterEach, describe, expect, it } from "bun:test";

import { appShell, appShellOf, STORE_PAGES } from "./appShell.ts";

const global = globalThis as { __ovisAppShell?: unknown };
afterEach(() => { delete global.__ovisAppShell; });

describe("appShell", () => {
  it("is absent in a browser, an installed web app and a hosted or preview-shell app build, which inject nothing", () => {
    expect(appShell()).toBeNull();
  });

  it("reads what the app injects at document start", () => {
    global.__ovisAppShell = { bundled: true, platform: "android", appVersion: "1.1.0", build: 15 };
    expect(appShell()).toEqual({ platform: "android", appVersion: "1.1.0", build: 15 });
    global.__ovisAppShell = { bundled: true, platform: "ios", appVersion: "1.1.0", build: 12 };
    expect(appShell()).toEqual({ platform: "ios", appVersion: "1.1.0", build: 12 });
  });

  it("counts only bundled: true as the app's own copy", () => {
    for (const value of [null, undefined, true, "bundled", 1, {}, { bundled: false, platform: "android" }, { bundled: "true", platform: "ios" }, { bundled: 1 }]) {
      expect(appShellOf(value)).toBeNull();
    }
  });

  it("keeps a bundled copy bundled when a field it does not need is off, naming no platform it does not know", () => {
    expect(appShellOf({ bundled: true })).toEqual({ platform: null, appVersion: null, build: null });
    expect(appShellOf({ bundled: true, platform: "windows", appVersion: 7, build: "15" })).toEqual({ platform: null, appVersion: null, build: null });
    expect(appShellOf({ bundled: true, platform: "ios", appVersion: "x".repeat(65), build: -1 })).toEqual({ platform: "ios", appVersion: null, build: null });
    expect(appShellOf({ bundled: true, platform: "android", appVersion: "1.1.0", build: 1.5 })).toEqual({ platform: "android", appVersion: "1.1.0", build: null });
  });

  it("names each store's page for the app", () => {
    expect(STORE_PAGES).toEqual({ ios: "https://apps.apple.com/app/id6824664162", android: "https://play.google.com/store/apps/details?id=sh.ovis.app" });
  });
});
