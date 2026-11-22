import { describe, expect, it } from "bun:test";
import { setCurrentLanguage } from "./i18n.ts";
import { deviceLabel, deviceOs, isLoopbackHost, labelDevice, phonePlan } from "./phone.ts";
import type { RemoteAccess } from "../../shared/protocol.ts";

const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317", secure: true };
const running = (patch: Partial<RemoteAccess["tailscale"]> = {}): RemoteAccess => ({
  port: 7317,
  tailscale: { state: "running", dns_name: "pc.example.ts.net", serving_url: null, serve_command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", serve_url: "https://pc.example.ts.net", ...patch },
});

describe("phonePlan", () => {
  it("points at this page when it is already on an HTTPS address a phone can open", () => {
    const page = { protocol: "https:", hostname: "pc.example.ts.net", origin: "https://pc.example.ts.net", secure: true };
    expect(phonePlan(page, null)).toEqual({ kind: "here", url: "https://pc.example.ts.net" });
    expect(phonePlan(page, running({ state: "missing" }))).toEqual({ kind: "here", url: "https://pc.example.ts.net" });
  });

  it("never offers the hosted relay shell's own address as this PC's, but the PC's Tailscale address when it has one", () => {
    const shell = { protocol: "https:", hostname: "app.ovis.sh", origin: "https://app.ovis.sh", secure: true, shell: true };
    expect(phonePlan(shell, running({ serving_url: "https://pc.example.ts.net", serve_command: null, serve_url: null }))).toEqual({ kind: "served", url: "https://pc.example.ts.net" });
    expect(phonePlan(shell, null)).toEqual({ kind: "unknown" });
  });

  it("treats localhost over HTTPS and any plain-HTTP page as not reachable from a phone", () => {
    expect(phonePlan({ protocol: "https:", hostname: "localhost", origin: "https://localhost:7317", secure: true }, null)).toEqual({ kind: "unknown" });
    expect(phonePlan({ protocol: "http:", hostname: "192.168.0.10", origin: "http://192.168.0.10:7317", secure: false }, running()).kind).toBe("command");
  });

  it("shows the address Tailscale already serves, else the command", () => {
    expect(phonePlan(local, running({ serving_url: "https://pc.example.ts.net:17317", serve_command: null, serve_url: null }))).toEqual({ kind: "served", url: "https://pc.example.ts.net:17317" });
    expect(phonePlan(local, running())).toEqual({ kind: "command", command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", url: "https://pc.example.ts.net" });
    expect(phonePlan(local, running({ dns_name: null, serve_url: null }))).toEqual({ kind: "command", command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", url: null });
  });

  it("reports what is in the way", () => {
    expect(phonePlan(local, running({ state: "stopped", dns_name: null, serve_command: null, serve_url: null }))).toEqual({ kind: "stopped" });
    expect(phonePlan(local, running({ state: "missing", dns_name: null, serve_command: null, serve_url: null }))).toEqual({ kind: "missing" });
    expect(phonePlan(local, null)).toEqual({ kind: "unknown" });
    expect(phonePlan(local, running({ serve_command: null, serve_url: null }))).toEqual({ kind: "unknown" });
  });

  it("knows the loopback names", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["pc.example.ts.net", "192.168.0.10", "localhost.example.com"]) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("deviceOs", () => {
  it("names the system as the account service does, an iPad asking as a Mac included", () => {
    const cases: [string, number, string | null][] = [
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1", 5, "ios"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", 5, "ios"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36", 0, "macos"],
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36", 5, "android"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36", 0, "windows"],
      ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36", 0, "chromeos"],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", 0, "linux"],
      ["curl/8.0", 0, null],
    ];
    for (const [ua, touch, os] of cases) expect<string | null>(deviceOs(ua, touch)).toBe(os);
  });
});

describe("deviceLabel", () => {
  const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36";
  // the Android app's WebView: the same Chrome token, with `wv`
  const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36";
  const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  // the iOS app's WKWebView: no Safari token
  const IPHONE_WEBVIEW = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

  it("names a browser, then the device", () => {
    expect(deviceLabel(ANDROID_CHROME)).toBe("Chrome (Android)");
    expect(deviceLabel(IPHONE_SAFARI, 5)).toBe("Safari (iPhone)");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36")).toBe("Chrome (Mac)");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", 5)).toBe("Safari (iPad)");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0")).toBe("Edge (Windows)");
    expect(deviceLabel("curl/8.0")).toBe("Device");
  });

  it("names the Ovis app as the app, not its WebView's browser", () => {
    expect(deviceLabel(ANDROID_WEBVIEW, 5, true)).toBe("Ovis app (Android)");
    expect(deviceLabel(IPHONE_WEBVIEW, 5, true)).toBe("Ovis app (iPhone)");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/0.5.10 Safari/605.1.15 OvisMac/0.5.10")).toBe("Ovis app (Mac)");
    // a phone browser on the same page is still the browser
    expect(deviceLabel(ANDROID_WEBVIEW)).toBe("Chrome (Android)");
  });

  it("reads the device back out of a name it made, in any language and the older form, and none out of a name typed", () => {
    expect(labelDevice("Chrome (Android)")).toBe("Android");
    expect(labelDevice("Safari (iPad)")).toBe("iPad");
    expect(labelDevice("Ovis app (iPhone)")).toBe("iPhone");
    expect(labelDevice("Ovis 앱 (Android)")).toBe("Android");
    expect(labelDevice("Ovis アプリ (Mac)")).toBe("Mac");
    expect(labelDevice("Ovis 应用 (Android)")).toBe("Android");
    expect(labelDevice("Android · Chrome")).toBe("Android");
    expect(labelDevice("iPhone")).toBe("iPhone");
    expect(labelDevice("Kitchen laptop")).toBeNull();
    expect(labelDevice("Opera (Android)")).toBeNull();
  });

  it.each([["ko", "Ovis 앱 (Android)"], ["ja", "Ovis アプリ (Android)"], ["zh", "Ovis 应用 (Android)"]] as const)("names the app in %s", (language, label) => {
    setCurrentLanguage(language);
    try {
      expect(deviceLabel(ANDROID_WEBVIEW, 5, true)).toBe(label);
      expect(deviceLabel(ANDROID_CHROME)).toBe("Chrome (Android)");
    } finally { setCurrentLanguage("en"); }
  });
});
