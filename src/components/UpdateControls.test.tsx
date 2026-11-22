import { describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DESKTOP_APP_UPDATES, type UpdateStatus } from "../../shared/update.ts";
import * as desktopUpdate from "../lib/desktopUpdate.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import * as herdrUpdate from "../lib/herdrUpdate.ts";
import { SettingsBare } from "./SettingsControls.tsx";
import { DesktopUpdateNotice, HerdrUpdateControls, UpdateControls, UpdateNotice } from "./UpdateControls.tsx";

Object.assign(globalThis, { __APP_VERSION__: "0.4.22" });

const blocked: UpdateStatus = {
  managed: true, auto_update: false, phase: "idle", current_revision: "c4418bca", latest_revision: "c4418bca",
  current_version: "0.4.22", latest_version: "0.4.22", available: false, checked_at: null,
  blocked_reason: "Switch the source checkout to main to update.", error: null,
};

const updates = (status: UpdateStatus): UpdatesModel => ({
  status, error: null, busy: false, needsReload: false, reload: null, notes: null, installed: null,
  request: async () => undefined, failure: null, offered: null,
} as unknown as UpdatesModel);

function render(bare: boolean, model = updates(blocked)): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null,
      createElement(SettingsBare.Provider, { value: bare }, createElement(UpdateControls, { updates: model }))));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

const heading = (html: string): string => /<h3 id="settings-updates-title"[^>]*>/.exec(html)?.[0] ?? "";

describe("the Updates section's heading", () => {
  it("is out of sight inside About's joined card", () => {
    expect(heading(render(true))).toContain('class="visually-hidden"');
  });

  it("stays a visible caption on a page with captions", () => {
    const shown = heading(render(false));
    expect(shown).not.toBe("");
    expect(shown).not.toContain("visually-hidden");
  });
});

describe("the update offer line", () => {
  const offer = (revision: string, closed: string | null, model?: Partial<UpdatesModel>): string => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => key === "ovis:update-offer-closed" ? closed : null } } });
    try {
      const status = { ...blocked, blocked_reason: null, available: true, latest_version: "0.4.23", latest_revision: revision };
      return renderToStaticMarkup(createElement(SettingsProvider, null,
        createElement(UpdateNotice, { updates: { ...updates(status), ...model }, onOpen: () => undefined })));
    } finally {
      if (saved) Object.defineProperty(globalThis, "window", saved);
      else Reflect.deleteProperty(globalThis, "window");
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };

  it("can be closed, and stays closed for that release only", () => {
    expect(offer("aaaa111", null)).toContain('aria-label="Dismiss"');
    expect(offer("aaaa111", "aaaa111")).toBe("");
    expect(offer("bbbb222", "aaaa111")).toContain("Ovis v0.4.23 is available.");
  });

  it("keeps a failed install on the line, with no Close", () => {
    const html = offer("aaaa111", "aaaa111", { error: "The release server could not be reached." });
    expect(html).toContain("The update could not be installed.");
    expect(html).not.toContain('aria-label="Dismiss"');
  });
});

describe("update failure announcements", () => {
  it.each(["request", "server", "offer"] as const)("announces a %s failure beside its recovery controls", (source) => {
    const model = updates({ ...blocked, blocked_reason: null });
    if (source === "request") model.error = "The release server could not be reached.";
    if (source === "server") model.status = { ...blocked, error: "The downloaded release could not be verified." };
    if (source === "offer") model.failure = "offer-changed";
    const html = render(true, model);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Check for updates");
  });

  it("keeps an ordinary update check polite", () => {
    const html = render(true, { ...updates({ ...blocked, blocked_reason: null }), busy: true });
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('role="status"');
  });

  it.each(["request", "output"] as const)("announces a runtime update %s failure", (source) => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    const hook = spyOn(herdrUpdate, "useHerdrUpdate").mockReturnValue({
      status: { supported: true, phase: source === "output" ? "error" : "idle", server_version: "1.0", binary_version: "1.0", stale: false, output: source === "output" ? "Download failed" : null, finished_at: null },
      error: source === "request" ? "The update request was refused" : null,
      busy: false, request: async () => undefined,
    });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, null,
        createElement(HerdrUpdateControls, { enabled: true, herdrVersion: "1.0" })));
      expect(html).toContain('role="alert"');
      expect(html).toContain(source === "request" ? "The update request was refused" : "Download failed");
    } finally {
      hook.mockRestore();
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it.each([true, false])("announces a runtime update that failed without output (bare %p)", (bare) => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    const hook = spyOn(herdrUpdate, "useHerdrUpdate").mockReturnValue({
      status: { supported: true, phase: "error", server_version: "1.0", binary_version: "1.0", stale: false, output: null, finished_at: null },
      error: null, busy: false, request: async () => undefined,
    });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, null,
        createElement(SettingsBare.Provider, { value: bare }, createElement(HerdrUpdateControls, { enabled: true, herdrVersion: "1.0" }))));
      expect(html).toContain('role="alert"');
      expect(html).toContain("Update herdr");
    } finally {
      hook.mockRestore();
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });
});

describe("About's row for the desktop app itself", () => {
  const desktopServer = updates({ ...blocked, managed: false, blocked_reason: DESKTOP_APP_UPDATES });
  const idle: desktopUpdate.AppUpdate = { version: "0.5.8", phase: "idle", update: null, percent: null, error: null };
  const row = (state: desktopUpdate.AppUpdate | null, model = desktopServer): string => {
    const hook = spyOn(desktopUpdate, "useDesktopAppUpdate").mockReturnValue(state && { state, installing: false, check: () => undefined, install: () => undefined });
    try { return render(true, model); } finally { hook.mockRestore(); }
  };

  it("puts the app's version and Check for updates where the sentence said updates come with the app", () => {
    const html = row(idle);
    expect(html).toContain("Running v0.5.8");
    expect(html).toMatch(/<button type="button" class="btn">Check for updates<\/button>/);
    expect(html).not.toContain("updates come with the app");
  });

  it("keeps the sentence in a browser, where there is no app to check", () => {
    expect(row(null)).toContain("updates come with the app");
  });

  it("is the server's own row on a server that is not the app's", () => {
    const html = row(idle, updates({ ...blocked, blocked_reason: null }));
    expect(html).toContain("Running v0.4.22");
    expect(html).not.toContain("Running v0.5.8");
  });

  it("holds Check for updates while it checks and downloads, with the download's progress", () => {
    expect(row({ ...idle, phase: "checking" })).toMatch(/Checking for updates…<\/span><button type="button" class="btn" disabled="">Check for updates<\/button>/);
    const downloading = row({ ...idle, phase: "downloading", update: "0.5.9", percent: 42 });
    expect(downloading).toContain("Downloading Ovis 0.5.9… 42%");
    expect(downloading).toContain('disabled="">Check for updates');
    expect(row({ ...idle, phase: "downloading", update: "0.5.9" })).toContain("Downloading Ovis 0.5.9…<");
  });

  it("offers Restart to Update once the app holds the update", () => {
    const html = row({ ...idle, phase: "ready", update: "0.5.9" });
    expect(html).toContain("Ovis 0.5.9 is ready.");
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Restart to Update<\/button>/);
    expect(html).not.toContain(">Check for updates<");
  });

  it("says a failed check in one line, the whole error in its title, and offers the check again", () => {
    const html = row({ ...idle, phase: "failed", error: "net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper" });
    expect(html).toContain('role="alert"');
    expect(html).toContain(">The update did not go through: net::ERR_INTERNET_DISCONNECTED<");
    expect(html).toContain('title="net::ERR_INTERNET_DISCONNECTED');
    expect(html).toContain(">Check for updates<");
  });

  it("offers no check from a build that does not update itself", () => {
    const html = row({ ...idle, phase: "off" });
    expect(html).toContain("This build of the app does not update itself.");
    expect(html).not.toContain("<button");
  });
});

describe("the desktop app's update line", () => {
  const line = (update: Parameters<typeof DesktopUpdateNotice>[0]["update"], language = "en"): string => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: [language] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(DesktopUpdateNotice, { update })));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const ready = { version: "0.5.3", installing: false, install: () => undefined, close: () => undefined };

  it("names the version, with Restart to Update and a Close", () => {
    const html = line(ready);
    expect(html).toContain('class="update-notice is-line"');
    expect(html).toContain("Ovis 0.5.3 is ready.");
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Restart to Update<\/button>/);
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("holds its button while the app installs", () => {
    expect(line({ ...ready, installing: true })).toMatch(/<button type="button" class="btn btn-primary" disabled="">Restart to Update<\/button>/);
  });

  it("is not drawn with no update, a closed line or in a browser", () => {
    expect(line(null)).toBe("");
  });

  it("names Restart to Update as the app's tray does, in every language", async () => {
    const { desktopText } = await import("../../app/electron/src/text.ts");
    for (const language of ["ko", "ja", "zh"] as const) {
      const html = line(ready, language);
      expect(html).toContain(`>${desktopText(language)("Restart to Update")}</button>`);
      expect(html).toContain(`${desktopText(language)("Ovis {version} is ready", { version: "0.5.3" })}`);
    }
  });
});
