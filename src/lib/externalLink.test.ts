import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWebLinkOpener, ExternalLink, isWebLink, openExternal, reserveTab } from "./externalLink.ts";

/** Runs `run` with `window.open` answering `answer`, and gives back each call's arguments. */
function withWindowOpen(answer: (url: string) => unknown, run: () => void): unknown[][] {
  const calls: unknown[][] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { open: (...args: unknown[]) => { calls.push(args); return answer(args[0] as string); } } });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
  return calls;
}

describe("ExternalLink", () => {
  it("opens a tab of its own with no opener or referrer, and passes on everything else", () => {
    expect(renderToStaticMarkup(createElement(ExternalLink, { kind: "link", href: "https://ovis.sh/", className: "settings-link", title: "Site" }, "ovis.sh")))
      .toBe('<a href="https://ovis.sh/" target="_blank" rel="noopener noreferrer" class="settings-link" title="Site">ovis.sh</a>');
    expect(renderToStaticMarkup(createElement(ExternalLink, { kind: "sign-in", href: "https://github.com/login/device" }, "Sign in")))
      .toBe('<a href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">Sign in</a>');
  });

  it("sends the referrer only when asked, to the app's own page", () => {
    expect(renderToStaticMarkup(createElement(ExternalLink, { kind: "ovis", referrer: true, href: "/api/file/view?path=a.html" }, "Open")))
      .toBe('<a href="/api/file/view?path=a.html" target="_blank" rel="noopener">Open</a>');
  });
});

describe("openExternal", () => {
  it("gives an address that is not http(s) a tab of its own, with no opener or referrer", () => {
    const calls = withWindowOpen(() => null, () => openExternal("mailto:team@ovis.sh", "link", true));
    expect(calls).toEqual([["mailto:team@ovis.sh", "_blank", "noopener,noreferrer"]]);
  });
});

describe("reserveTab", () => {
  it("opens a blank tab the page it is sent to has no handle on, or answers null when the browser blocks it", () => {
    const tab = { opener: {} as unknown };
    let reserved: unknown;
    expect(withWindowOpen(() => tab, () => { reserved = reserveTab(); })).toEqual([["about:blank", "_blank"]]);
    expect(reserved).toBe(tab);
    expect(tab.opener).toBeNull();
    withWindowOpen(() => null, () => { reserved = reserveTab(); });
    expect(reserved).toBeNull();
  });
});


describe("openWebLink", () => {
  it("opens a new tab unless asked to reuse, and falls back to one whenever the reused tab is gone or refused", () => {
    const clicked: Record<string, string>[] = [];
    const opened: { closed: boolean; location: { href: string }; focus: () => void; focused: number }[] = [];
    let blocked = false;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => {
      const link = { href: "", target: "", rel: "", click: () => clicked.push({ href: link.href, target: link.target, rel: link.rel }) };
      return link;
    } } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { open: (uri: string) => {
      if (blocked) return null;
      const tab = { closed: false, location: { href: uri }, focused: 0, focus() { this.focused++; } };
      opened.push(tab);
      return tab;
    } } });
    try {
      const open = createWebLinkOpener();
      open("https://one.example", false);
      open("https://two.example", true);
      open("https://three.example", true);
      expect(clicked).toEqual([{ href: "https://one.example", target: "_blank", rel: "noopener noreferrer" }]);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ location: { href: "https://three.example" }, focused: 1 });
      opened[0]!.closed = true;
      open("https://four.example", true);
      expect(opened).toHaveLength(2);
      expect(opened[1]).toMatchObject({ location: { href: "https://four.example" }, focused: 0 });
      blocked = true;
      createWebLinkOpener()("https://blocked.example", true);
      expect(clicked.at(-1)).toEqual({ href: "https://blocked.example", target: "_blank", rel: "noopener noreferrer" });
      // a tab the browser no longer lets this page steer still opens the address, in a new tab
      blocked = false;
      const refusing = createWebLinkOpener();
      refusing("https://five.example", true);
      Object.defineProperty(opened.at(-1)!.location, "href", { set: () => { throw new Error("SecurityError"); } });
      refusing("https://six.example", true);
      expect(clicked.at(-1)).toEqual({ href: "https://six.example", target: "_blank", rel: "noopener noreferrer" });
      const windowOpen = (globalThis as unknown as { window: { open: unknown } }).window.open;
      (globalThis as unknown as { window: { open: unknown } }).window.open = () => { throw new Error("SecurityError"); };
      createWebLinkOpener()("https://seven.example", true);
      expect(clicked.at(-1)).toEqual({ href: "https://seven.example", target: "_blank", rel: "noopener noreferrer" });
      (globalThis as unknown as { window: { open: unknown } }).window.open = windowOpen;
      // an app hands the address to the system browser: it never keeps a window to reuse
      (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
      createWebLinkOpener()("https://app.example", true);
      expect(opened).toHaveLength(3);
      expect(clicked.at(-1)).toEqual({ href: "https://app.example", target: "_blank", rel: "noopener noreferrer" });
    } finally {
      Reflect.deleteProperty(globalThis, "Capacitor");
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("isWebLink", () => {
  it("opens http and https addresses, in any case", () => {
    for (const uri of ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM"]) {
      expect(isWebLink(uri)).toBe(true);
    }
  });

  it("refuses every other scheme a crafted terminal line could carry", () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "file:///etc/passwd", "ws://example.com", "//example.com", "example.com", " https://example.com"]) {
      expect(isWebLink(uri)).toBe(false);
    }
  });
});
