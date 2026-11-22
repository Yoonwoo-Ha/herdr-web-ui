import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MyPc } from "../lib/account/myPcs.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { signInLink } from "./ConnectPhoneDialog.tsx";
import { keyIdGroups } from "./KeyId.tsx";
import { leaveAddEntry, RelayShell, type RelayShellProps } from "./RelayShell.tsx";

const EXPECTED = "0123456789abcdef0123456789abcdef";
const RECEIVED = "01234567ffffcdef0123456789abeeee";
const none = () => {};
const props = (state: RelayShellProps["state"]): RelayShellProps => ({ state, scoped: true, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none });
const render = (shown: RelayShellProps): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
describe("the front page's account part", () => {
  // the dashboard is a page opened on purpose, by its address: a front page with none is Add a PC
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
  const pc = (server_id: string, name: string, state: "paired" | "needs-approval" | "offline" | "needs-update", paired = state === "paired") => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired, linked: paired });

  it("offers GitHub alone until the service is set up for Apple", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Apple");
  });

  const saved = (server_id: string, name: string) => ({ server_id, server_public_key: "k", relay: "wss://relay.example", name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
  const signInAlternatives = (html: string) => [...html.matchAll(/<button type="button" class="btn btn-ghost account-link[^"]*"[^>]*>([^<]+)</g)].map(([, label]) => label);

  const tabsOf = (html: string) => [...html.matchAll(/<button type="button" aria-pressed="(true|false)" data-tab="(\w+)">([^<]+)</g)].map(([, pressed, tab, label]) => [tab, label, pressed]);
  const panelOf = (html: string, tab: string): string => /<div class="connect-start-panel" data-tab-panel="(\w+)">/.exec(html)?.[1] === tab ? html.slice(html.indexOf(`data-tab-panel="${tab}"`)) : "";

  it("opens signed out on the three connect tabs, Ovis relay chosen, with the sign-in inside it and no sign-in screen first", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-account-state="signed-out"');
    expect(html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]).toBe("Connect a PC");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(tabsOf(html)).toEqual([["relay", "Ovis relay", "true"], ["tailscale", "Tailscale", "false"], ["ssh", "SSH", "false"]]);
    const relay = panelOf(html, "relay");
    const buttons = [...relay.matchAll(/<button type="button" class="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?(Continue with [^<]+)</g)].map(([, kind, label]) => [kind, label]);
    expect(buttons).toEqual([["btn account-provider", "Continue with GitHub"], ["btn account-provider", "Continue with Apple"]]);
    expect(relay.indexOf("Continue with Apple")).toBeLessThan(relay.indexOf("First time? Your account is made right away."));
    expect(signInAlternatives(relay)).toEqual(["Pair with a code"]);
    expect(html).not.toContain("Your PCs, anywhere.");
    expect(html).not.toContain("Sign in to your Ovis account");
    expect(html).not.toContain("Start without signing in");
    expect(html).not.toContain("relay-shell-pc");
    expect(html).not.toContain("acct_");
  });

  it("lists this device's own pairings under the tabs, signed out, by their pages", () => {
    const two = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(two).toContain("Continue with GitHub");
    expect([...two.matchAll(/<a class="relay-add-saved-pc" href="([^"]+)">/g)].map(([, href]) => href)).toEqual([`/s/${"a".repeat(32)}/`, `/s/${"b".repeat(32)}/`]);
    expect(two).not.toContain("<details");
    expect(render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620")] }), scoped: false })).toContain(`href="/s/${"a".repeat(32)}/"`);
  });

  it("returns to the connect tabs after sign-out, the relay tab's sign-in up", () => {
    const devices = [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")];
    const signedIn = render({ ...props({ kind: "list", devices, account: { kind: "signed-in", provider: "github", error: null, pcs: [pc("a".repeat(32), "p620", "paired")] } }), scoped: false, onSignIn: none });
    expect(panelOf(signedIn, "relay")).not.toContain("Continue with GitHub");
    const after = render({ ...props({ kind: "list", devices, account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(tabsOf(after).map(([tab, , pressed]) => [tab, pressed])).toEqual([["relay", "true"], ["tailscale", "false"], ["ssh", "false"]]);
    expect(panelOf(after, "relay")).toContain("Continue with GitHub");
    expect(after).not.toContain("Sign out");
    expect(after).not.toContain("relay-shell-pc");
  });

  it("opens signed in with no PC on the same three connect tabs, the relay tab saying what to do on the PC", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, plainFront: false });
    expect(html).toContain('data-account-state="signed-in"');
    expect(html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]).toBe("Connect a PC");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(tabsOf(html)).toEqual([["relay", "Ovis relay", "true"], ["tailscale", "Tailscale", "false"], ["ssh", "SSH", "false"]]);
    const relay = panelOf(html, "relay");
    expect(relay).toContain("Turn on Ovis on the PC and sign in with the same account.");
    // a browser has no scanner: the code pairs a PC that is in no account
    expect(signInAlternatives(relay)).toEqual(["Pair with a code"]);
    expect(relay).not.toContain("Continue with");
    expect(html).not.toContain("Add a PC");
    expect(html).not.toContain('data-action="add-qr"');
    expect(html).not.toContain("relay-add-manage");
  });

  it("opens a signed-in front page on the connect tabs, the relay tab listing this device's own PCs and then the account's it can open, each once, whatever the address", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } });
    const devices = [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")];
    const pcStatus = new Map([["b".repeat(32), { kind: "offline", reason: "pc" }]] as const);
    const join = { server_public_key: "k", relay: "wss://relay.example" };
    // a row with no way to join (no key or relay in the directory) is no link: its page would open on nothing
    const account = { kind: "signed-in" as const, provider: "github" as const, error: null, pcs: [pc("a".repeat(32), "p620", "paired"), { ...pc("c".repeat(32), "desk", "needs-approval"), join }, { ...pc("d".repeat(32), "attic", "offline"), join }, pc("e".repeat(32), "keyless", "needs-approval")] };
    const html = render({ ...props({ kind: "list", devices, account }), scoped: false, onSignIn: none, pcStatus });
    expect(html).not.toContain("keyless");
    const failed = render({ ...props({ kind: "list", devices, account: { ...account, error: "The account service did not answer." } }), scoped: false, onSignIn: none, onRefreshAccount: none });
    expect(failed).toMatch(/role="alert">The account service did not answer\. <button[^>]*>Try again<\/button>/);
    expect(html).toContain('data-account-state="signed-in"');
    expect(tabsOf(html).map(([tab, , pressed]) => [tab, pressed])).toEqual([["relay", "true"], ["tailscale", "false"], ["ssh", "false"]]);
    expect(html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]).toBe("Connect a PC");
    const rows = [...html.matchAll(/<a class="relay-add-saved-pc" href="([^"]+)">([\s\S]*?)<\/a>/g)].map(([, href, inner]) => [href, inner!.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").trim().replace(/\s+/g, " ")]);
    expect(rows).toEqual([[`/s/${"a".repeat(32)}/`, "p620 Relay"], [`/s/${"b".repeat(32)}/`, "nuc Relay Off"], [`/s/${"c".repeat(32)}/`, "desk Relay"], [`/s/${"d".repeat(32)}/`, "attic Relay Off"]]);
    expect(html).not.toContain("Needs approval");
    // the old control page's address is the same front page
    (window.location as { hash: string }).hash = "#pcs";
    expect(render({ ...props({ kind: "list", devices, account }), scoped: false, onSignIn: none, pcStatus })).toBe(html);
  });

  it("opens a pairing link straight into pairing, without the sign-in", () => {
    const html = render({ ...props({ kind: "confirm", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", name: "Desk" } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-relay-state="confirm"');
    expect(html).toContain("Pair with Desk?");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("Sign in to your Ovis account");
  });

  it("says how each saved PC answered the latest check, with Check now above the list", () => {
    const device = (server_id: string, name: string) => ({ server_id, server_public_key: "k", relay: "wss://relay.example", name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
    const pcStatus = new Map([
      ["a".repeat(32), { kind: "answered", route: "lan", rttMs: 9 }],
      ["b".repeat(32), { kind: "answered", route: "relay", relay: "wss://relay-ap.ovis.sh", rttMs: 148 }],
      ["c".repeat(32), { kind: "offline", reason: "pc" }],
    ] as const);
    const html = render({ ...props({ kind: "list", devices: [device("a".repeat(32), "home"), device("b".repeat(32), "office"), device("c".repeat(32), "laptop")] }), scoped: false, pcStatus, onCheckPcs: none });
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("homeAnswers · Same Wi-Fi, direct · 9 ms");
    expect(text).toContain("officeAnswers · Seoul relay · 148 ms");
    expect(html).toContain('<span class="connection-slow">148 ms</span>');
    expect(text).toContain("laptopMachine offlineIt is off, has no network, or Ovis is not running on it.");
    expect(html.indexOf("Check now")).toBeLessThan(html.indexOf("home"));
    expect(text).not.toContain("Connected");
  });

  it("asks for the number the new PC shows instead of showing one, and says so when it was wrong", () => {
    const typed = render(props({ kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true }));
    expect(typed).toContain("Type the number desk2 shows");
    expect(typed).not.toContain("123 456");
    expect(typed).toContain('name="digits"');
    const wrong = render(props({ kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true }));
    expect(wrong).toContain("That is not the number desk2 shows");
    expect(wrong).not.toContain('name="digits"');
  });

});

describe("the hosted front page", () => {
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
  const pc = (server_id: string, name: string, state: MyPc["state"], over: Partial<MyPc> = {}): MyPc => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired: state === "paired", linked: true, ...over });
  const device = (server_id: string, name: string, relay: string) => ({ server_id, server_public_key: "k", relay, name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
  const AP = "wss://relay-ap.ovis.sh";
  const GLOBAL = "wss://relay.ovis.sh";
  const ids = { desk: "a".repeat(32), mac: "b".repeat(32), mini: "c".repeat(32), home: "d".repeat(32) };
  const four = (): MyPc[] => [
    pc(ids.desk, "Desk PC", "paired", { last_seen_at: new Date().toISOString() }),
    pc(ids.mac, "MacBook", "paired", { listed: false, linked: false }),
    pc(ids.mini, "Mac mini", "needs-approval", { added_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } }),
    pc(ids.home, "Home server", "offline", { paired: true, last_seen_at: new Date(Date.now() - 20 * 3_600_000).toISOString() }),
  ];
  const devices = () => [device(ids.desk, "Desk PC", AP), device(ids.mac, "MacBook", AP), device(ids.home, "Home server", GLOBAL)];
  const signedIn = (pcs: MyPc[] | null, extra: Partial<RelayShellProps> = {}): RelayShellProps => ({ ...props({ kind: "list", devices: devices(), account: { kind: "signed-in", provider: "github", error: null, pcs } }), scoped: false, onSignIn: none, ...extra });

  describe("in a browser", () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    let renderer: ReactTestRenderer | undefined;
    const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {}, pauseAnimations() {}, unpauseAnimations() {} });

    beforeEach(() => {
      for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IntersectionObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      const events = new EventTarget();
      const store = new Map<string, string>();
      const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
      const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      class HTMLElement { isConnected = true; focus(): void {} }
      class IntersectionObserver { observe(): void {} disconnect(): void {} }
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
      Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: IntersectionObserver });
      Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { href: "https://app.ovis.sh/", search: "", hash: "", origin: "https://app.ovis.sh", pathname: "/" },
        history: { state: null, replaceState() {}, pushState() {}, back() {} },
        localStorage: storage, matchMedia, innerWidth: 1440,
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
        requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [], createNodeMock: node },
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      } });
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

    const mount = async (shown: RelayShellProps) => { await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }), { createNodeMock: node }); }); };
    const dialogs = () => renderer!.root.findAll((instance) => instance.props.role === "dialog");
    const dialog = () => { const found = dialogs(); if (found.length !== 1) throw new Error(`${found.length} dialogs`); return found[0]!; };
    const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
    const buttons = (label: string) => renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === label);
    const button = (label: string) => { const found = buttons(label); if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`); return found[0]!; };

    describe("a pairing's step frame", () => {
      const offer = { v: 1 as const, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", name: "Desk" };
      const backOf = (): ReactTestInstance[] => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "relay-step-back");
      const stepOf = (): unknown => renderer!.root.findAll((node) => node.type === "div" && node.props.className === "relay-step-progress")[0]?.props["data-step"] ?? null;

      it("cancels the pairing from its round Back on the confirm, the comparison and the connection, each named for what it does", async () => {
        const steps: [RelayShellProps["state"], string, number][] = [
          [{ kind: "confirm", offer, account: "unlisted" }, "Back", 1],
          [{ kind: "compare", name: "Desk", digits: "123456", confirmed: false }, "Back", 2],
          [{ kind: "connecting", name: "Desk", pairing: true }, "Cancel", 2],
          [{ kind: "connecting", name: "Desk", approved: true, pairing: true }, "Cancel", 3],
        ];
        for (const [state, label, step] of steps) {
          let cancelled = 0;
          await mount({ ...props(state), onCancel: () => { cancelled++; } });
          const back = backOf();
          expect(back.map((button) => button.props["aria-label"])).toEqual([label]);
          await act(async () => { back[0]!.props.onClick(); });
          expect(cancelled).toBe(1);
          expect(stepOf()).toBe(step);
          await act(async () => { renderer!.unmount(); });
        }
      });

      it("moves the focus to the heading when the press takes the focused button away", async () => {
        const focused: string[] = [];
        const nodes = (element: { type: unknown }) => element.type === "h1" ? { ...node(), focus: () => { focused.push("h1"); } } : node();
        const draw = (confirmed: boolean) => createElement(SettingsProvider, { children: createElement(RelayShell, props({ kind: "compare", name: "Desk", digits: "123456", confirmed })) });
        await act(async () => { renderer = create(draw(false), { createNodeMock: nodes as never }); });
        expect(focused).toEqual([]);
        Object.defineProperty(document, "activeElement", { configurable: true, value: null });
        await act(async () => { renderer!.update(draw(true)); });
        expect(focused).toEqual(["h1"]);
        expect(textOf(renderer!.root.find((n) => n.type === "h1"))).toBe("Approve on the PC if it shows the same number");
      });

      it("drops the round Back once this phone confirmed the digits, leaving the comparison's own Cancel", async () => {
        let cancelled = 0;
        await mount({ ...props({ kind: "compare", name: "Desk", digits: "123456", confirmed: true }), onCancel: () => { cancelled++; } });
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBe(2);
        await act(async () => { button("Cancel").props.onClick(); });
        expect(cancelled).toBe(1);
      });

      it("says the PC approved, on screen and to a screen reader, once the account steps go on", async () => {
        // the live region takes its words from the frame after it mounts (useAnnouncedText)
        (window as unknown as { requestAnimationFrame: (run: () => void) => number }).requestAnimationFrame = (run) => { run(); return 1; };
        await mount(props({ kind: "connecting", name: "Desk", approved: true, pairing: true }));
        const said = "Approved. Desk opens in a moment.";
        expect(renderer!.root.findAll((node) => node.type === "p" && node.props.className === "relay-shell-copy").map(textOf)).toEqual([said]);
        expect(textOf(renderer!.root.find((node) => node.props.role === "status" && node.props.className === "visually-hidden"))).toBe(said);
        const bar = renderer!.root.find((node) => node.props.role === "progressbar");
        expect([bar.props["aria-label"], bar.props["aria-valuetext"]]).toEqual(["Pair", "Step 3 of 3"]);
      });

      it("keeps the ready checkpoint on the card, offers no Back once the pairing failed, and draws the failure without a step", async () => {
        // a saved PC's enrollment retry reaches ready too: it is not drawn as a pairing step
        await mount(props({ kind: "ready", name: "Desk", server_id: EXPECTED, enrollment: "local" }));
        expect(renderer!.root.findAll((node) => node.props.className === "relay-step")).toEqual([]);
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBeNull();
        await act(async () => { renderer!.unmount(); });
        await mount(props({ kind: "failed", failure: "pair-declined", name: "Desk", detail: null, server_id: EXPECTED, pairing: true }));
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBeNull();
      });

      it("keeps a saved PC opening again on the card: no steps, no sheep, its own Cancel", async () => {
        let cancelled = 0;
        await mount({ ...props({ kind: "connecting", name: "Desk" }), onCancel: () => { cancelled++; } });
        expect(renderer!.root.findAll((node) => node.props.className === "relay-step")).toEqual([]);
        expect(renderer!.root.findAll((node) => node.type === "span" && String(node.props.className).startsWith("sheep-"))).toEqual([]);
        await act(async () => { button("Cancel").props.onClick(); });
        expect(cancelled).toBe(1);
        await act(async () => { renderer!.unmount(); });
        await mount(props({ kind: "failed", failure: "pc-offline", name: "Desk", detail: null, server_id: EXPECTED }));
        expect(renderer!.root.findAll((node) => node.props.className === "relay-step")).toEqual([]);
        expect(renderer!.root.findAll((node) => node.type === "span" && String(node.props.className).startsWith("sheep-"))).toEqual([]);
      });
    });

    it("goes on in the sheet over the PC's own page for the join it started: the link's question, the digits, and the sheet's own Step 4 of 4 ready phase; a plain visit keeps the screens", async () => {
      const offer = { v: 1 as const, server_id: ids.mini, server_public_key: "k", relay: AP, name: "Mac mini" };
      let paired = 0;
      await mount({ ...props({ kind: "confirm", offer }), onPair: () => { paired += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("confirm");
      expect(renderer!.root.findAll((instance) => instance.type === "h1")).toHaveLength(0);
      await act(async () => { button("Pair").props.onClick(); });
      expect(paired).toBe(1);
      await act(async () => { renderer!.unmount(); });
      const typed: (string | undefined)[] = [];
      await mount({ ...props({ kind: "compare", name: "Mac mini", digits: "123456", confirmed: false, typed: true }), onMatch: (digits) => { typed.push(digits); }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("compare");
      const form = dialog().findByType("form");
      await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "123 456" }) } } }); });
      expect(typed).toEqual(["123456"]);
      await act(async () => { renderer!.unmount(); });
      let openedPc = 0;
      await mount({ ...props({ kind: "ready", name: "Mac mini", server_id: ids.mini }), onOpenPc: () => { openedPc += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-mode"]).toBe("new");
      expect(dialog().props["data-add-pc-phase"]).toBe("ready");
      expect(dialog().findAll((n) => n.type === "div" && n.props.role === "progressbar").map((n) => n.props["aria-valuenow"])).toEqual([4]);
      expect(dialog().findAll((n) => n.type === "li").map((n) => n.props["data-step"])).toEqual(["done", "done", "done", "done"]);
      await act(async () => { button("Open PC").props.onClick(); });
      expect(openedPc).toBe(1);
      await act(async () => { renderer!.unmount(); });
      await mount({ ...props({ kind: "confirm", offer }), sheetJoin: { mode: "join", server_id: ids.desk } });
      expect(dialogs()).toHaveLength(0);
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Pair with Mac mini?");
    });

    it("shows how the sheet's join failed in the sheet, with Try again, only for that PC, and suppresses raw close-code details in the RelayShell failure path", async () => {
      let retried = 0;
      const offline = { kind: "failed", failure: "pc-offline", name: "Mac mini", detail: "The relay closed the connection (0)" } as const;
      await mount({ ...props({ ...offline, server_id: ids.mini }), onRetry: () => { retried += 1; }, sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("failed");
      expect(textOf(dialog())).toContain("Machine offline");
      expect(textOf(dialog())).not.toContain("The relay closed the connection (0)");
      await act(async () => { button("Try again").props.onClick(); });
      expect(retried).toBe(1);
      await act(async () => { renderer!.unmount(); });
      for (const state of [{ ...offline, server_id: ids.desk }, offline]) {
        await mount({ ...props(state), sheetJoin: { mode: "join", server_id: ids.mini } });
        expect(dialogs()).toHaveLength(0);
        expect(textOf(renderer!.root.findByType("h1"))).toBe("Machine offline");
        expect(textOf(renderer!.root)).not.toContain("The relay closed the connection (0)");
        await act(async () => { renderer!.unmount(); });
      }
      await mount({ ...props({ kind: "failed", failure: "identity-changed", name: "Mac mini", detail: null, server_id: ids.mini }), sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialogs()).toHaveLength(0);
      expect(button("Forget this PC")).toBeDefined();
    });

    const tab = (way: string) => renderer!.root.find((node) => node.type === "button" && node.props["data-tab"] === way);
    const panel = () => renderer!.root.find((node) => node.type === "div" && typeof node.props["data-tab-panel"] === "string").props["data-tab-panel"] as string;

    it("opens on the relay tab again after a sign-out that follows another tab and a sign-in", async () => {
      const signedOut = { ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none };
      await mount(signedOut);
      await act(async () => { tab("ssh").props.onClick(); });
      expect(panel()).toBe("ssh");
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) })); });
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, signedOut) })); });
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Connect a PC");
      expect(panel()).toBe("relay");
      expect(tab("relay").props["aria-pressed"]).toBe(true);
    });

    it("opens a typed address from the Tailscale tab's field, and from the SSH tab's behind Add by address, each with Connect", async () => {
      const opened: string[] = [];
      (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { opened.push(href); };
      await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      for (const [way, typed] of [["tailscale", "my-pc.tailnet.ts.net"], ["ssh", "https://my-pc.example.com"]] as const) {
        await act(async () => { tab(way).props.onClick(); });
        expect(panel()).toBe(way);
        if (way === "ssh") {
          // a browser has no SSH: the tab is Add by address alone, a text link to the field
          expect(renderer!.root.findAll((node) => node.type === "input")).toHaveLength(0);
          await act(async () => { button("Add by address").props.onClick(); });
        }
        const fields = renderer!.root.findAll((node) => node.type === "input");
        expect(fields).toHaveLength(1);
        expect(renderer!.root.findAll((node) => node.type === "button" && node.props.className === "btn account-provider")).toHaveLength(0);
        const form = renderer!.root.find((node) => node.type === "form");
        await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: typed }) } } }); });
      }
      expect(opened).toEqual(["https://my-pc.tailnet.ts.net/", "https://my-pc.example.com/"]);
    });

    it("takes the relay tab's Pair with a code to the code field alone, and Cancel back to the tabs", async () => {
      const shown = { ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none } satisfies RelayShellProps;
      let started = 0;
      await mount({ ...shown, onCodeStart: () => { started += 1; } });
      await act(async () => { button("Pair with a code").props.onClick(); });
      expect(started).toBe(1);
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-entry", failure: null } }) })); });
      expect(renderer!.root.findAllByType("h1").map(textOf)).toEqual(["Pair with a code"]);
      expect(renderer!.root.findAll((node) => node.type === "button" && typeof node.props["data-tab"] === "string")).toHaveLength(0);
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, shown) })); });
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Connect a PC");
    });

    it("reads the account's PCs again when a notice changed them (a PC confirmed or removed), so Your PCs shows it at once", async () => {
      let refreshed = 0;
      await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, plainFront: false, onRefreshAccount: () => { refreshed += 1; } });
      expect(refreshed).toBe(0);
      await act(async () => { window.dispatchEvent(new Event("ovis:account-pcs-changed")); });
      expect(refreshed).toBe(1);
    });

    it("pairs with a code from the relay tab, signed in with no PC, in the pairing dialog", async () => {
      let started = 0;
      const shown = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, plainFront: false, onCodeStart: () => { started += 1; } } satisfies RelayShellProps;
      await mount(shown);
      expect(panel()).toBe("relay");
      await act(async () => { button("Pair with a code").props.onClick(); });
      expect(started).toBe(1);
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-entry", failure: null } }) })); });
      expect(dialog().props["data-pair-dialog"]).toBe("code");
    });

    it("scans a PC's QR from the relay tab in the phone app, and lists the phone's tailnet PCs or Open Tailscale under Tailscale", async () => {
      const assigned: string[] = [];
      const called: string[] = [];
      (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { assigned.push(href); };
      let tailscaleOn = true;
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell" }, { name: "CapacitorBarcodeScanner" }],
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
          if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317", "http://100.101.1.2:7317"], names: { "https://desk.tail1e211e.ts.net": "Desk" } };
          if (method === "tailscale") return { on: tailscaleOn };
          if (method === "scanBarcode") return { ScanResult: `https://app.ovis.sh/s/${ids.mini}/#offer=abc` };
          return {};
        },
      } });
      try {
        const shown = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, plainFront: false } satisfies RelayShellProps;
        await mount(shown);
        expect(buttons("Pair with a code")).toHaveLength(0);
        await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["data-action"] === "scan-qr").props.onClick(); });
        expect(assigned).toEqual([`https://app.ovis.sh/s/${ids.mini}/#offer=abc`]);
        await act(async () => { tab("tailscale").props.onClick(); });
        const tailnet = renderer!.root.findAll((node) => node.type === "li" && node.props["data-tailnet-pc"] !== undefined).map((node) => [node.props["data-tailnet-pc"], textOf(node)]);
        expect(tailnet).toEqual([["https://desk.tail1e211e.ts.net", "DeskTailscaledesk.tail1e211e.ts.netForget"], ["http://100.101.1.2:7317", "100.101.1.2:7317TailscaleForget"]]);
        const deskRow = renderer!.root.find((node) => node.type === "li" && node.props["data-tailnet-pc"] === "https://desk.tail1e211e.ts.net");
        await act(async () => { deskRow.find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc").props.onClick(); });
        expect(called).toContain("HerdrShell.open https://desk.tail1e211e.ts.net/");
        await act(async () => { deskRow.find((node) => node.type === "button" && node.props.className === "btn btn-ghost phone-pc-forget").props.onClick(); });
        expect(called).toContain("HerdrShell.forget https://desk.tail1e211e.ts.net");
        await act(async () => { renderer!.unmount(); });
        tailscaleOn = false;
        await mount(shown);
        await act(async () => { tab("tailscale").props.onClick(); });
        expect(renderer!.root.findAll((node) => node.type === "li" && node.props["data-tailnet-pc"] !== undefined)).toHaveLength(0);
        expect(renderer!.root.findAll((node) => node.type === "input")).toHaveLength(0);
        await act(async () => { button("Open Tailscale").props.onClick(); });
        expect(called).toContain("HerdrShell.openTailscale");
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("opens an account PC's standing QR scanned from the relay tab, and still refuses another app's pairing link", async () => {
      const assigned: string[] = [];
      (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { assigned.push(href); };
      let scanned = "";
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "CapacitorBarcodeScanner" }],
        nativePromise: async (_plugin: string, method: string) => method === "scanBarcode" ? { ScanResult: scanned } : {},
      } });
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, plainFront: false });
        const scan = async (qr: string): Promise<string> => {
          scanned = qr;
          await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["data-action"] === "scan-qr").props.onClick(); });
          return renderer!.root.findAll((node) => node.props.role === "alert").map(textOf).join("");
        };
        expect(await scan(signInLink("https://app.ovis.sh", ids.mini, "github"))).toBe("");
        expect(await scan(signInLink("https://app.ovis.sh", ids.desk, null))).toBe("");
        expect(assigned).toEqual([`https://app.ovis.sh/s/${ids.mini}/#sign-in=github`, `https://app.ovis.sh/s/${ids.desk}/`]);
        expect(await scan(`https://other.example/s/${ids.mini}/#offer=abc`)).toBe("This pairing link is not this app's. Scan the QR code your PC shows.");
        expect(await scan("https://app.ovis.sh/#sign-in=github")).toBe("That is not an http or https address.");
        expect(await scan(`https://app.ovis.sh/s/${ids.mini}/#pcs`)).toBe("That is not an http or https address.");
        // only the PC's own page: none of the files under its scope, no deeper path, no query, no other fragment
        for (const other of [`/s/${ids.mini}/sw.js`, `/s/${ids.mini}/manifest.webmanifest#sign-in=github`, `/s/${ids.mini}/x/`, `/s/${ids.mini}//`, `/s/${ids.mini}/%2F`, `/s/${ids.mini}`,
          `/s/${ids.mini}/?pcs`, `/s/${ids.mini}/?next=1#sign-in=github`, `/s/${ids.mini}/#sign-in=`, `/s/${ids.mini}/#sign-in=unknown`, `/s/${ids.mini}/#sign-in=github&pcs`]) {
          expect(await scan(`https://app.ovis.sh${other}`)).toBe("That is not an http or https address.");
        }
        expect(assigned).toHaveLength(2);
        // what opens is the PC's page built from its scope, not the address as scanned
        expect(await scan(`https://someone@app.ovis.sh/s/${ids.mini}/#sign-in=google`)).toBe("");
        expect(assigned.at(-1)).toBe(`https://app.ovis.sh/s/${ids.mini}/#sign-in=google`);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("hands SSH from the SSH tab's first field to the phone app's own SSH screen, with Add by address under it, and offers no SSH in a browser", async () => {
      const called: string[] = [];
      const shown = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, plainFront: false } satisfies RelayShellProps;
      const sshField = () => renderer!.root.find((node) => node.type === "input" && node.props.name === "address");
      const submitSsh = async (typed: string) => {
        const form = renderer!.root.find((node) => node.type === "form");
        await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: typed }) } } }); });
      };
      await mount(shown);
      await act(async () => { tab("ssh").props.onClick(); });
      expect(renderer!.root.findAll((node) => node.type === "input")).toHaveLength(0);
      expect(button("Add by address").props.className).toBe("connect-address-link");
      await act(async () => { renderer!.unmount(); });
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: [{ name: "open" }, { name: "openSshSetup" }] }, { name: "OvisSsh", methods: [{ name: "add" }] }],
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.target === "string" ? ` ${options.target}` : ""}`);
          return {};
        },
      } });
      try {
        await mount(shown);
        await act(async () => { tab("ssh").props.onClick(); });
        expect(textOf(renderer!.root.find((node) => node.type === "label"))).toBe("SSH");
        expect(sshField().props.placeholder).toBe("user@host");
        await submitSsh("pi@192.168.0.20:2222");
        expect(called.filter((call) => call !== "HerdrShell.getState")).toEqual(["HerdrShell.openSshSetup pi@192.168.0.20:2222"]);
        // the hosted page never adds an SSH PC itself: the app's own page does, after the person confirms there
        expect(called.some((line) => line.startsWith("OvisSsh."))).toBe(false);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("takes Pair with a code from Add a PC opened by its address to the code field alone, signed out", async () => {
      (window.location as { hash?: string }).hash = "#add";
      const shown = { ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, addEntry: true };
      await mount(shown);
      await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["data-action"] === "add-qr").props.onClick(); });
      await act(async () => { button("Pair with a code").props.onClick(); });
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-entry", failure: null } }) })); });
      expect(renderer!.root.findAllByType("h1").map(textOf)).toEqual(["Pair with a code"]);
      expect(renderer!.root.findAll((node) => node.type === "input" && node.props.name === "code")).toHaveLength(1);
    });

    it("takes Pair with a code from Add a PC opened by its address to the code field, signed in too", async () => {
      (window.location as { hash?: string }).hash = "#add";
      const shown = { ...signedIn(four()), addEntry: true };
      await mount(shown);
      await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["data-action"] === "add-qr").props.onClick(); });
      await act(async () => { button("Pair with a code").props.onClick(); });
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-entry", failure: null } }) })); });
      expect(renderer!.root.findAll((node) => node.type === "input" && node.props.name === "code")).toHaveLength(1);
    });

    it("opens on Add a PC when asked by its address, signed in too, and its Back leaves it", async () => {
      (window.location as { hash?: string }).hash = "#add";
      await mount({ ...signedIn(four()), addEntry: true });
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Connect a PC");
      await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Back").props.onClick(); });
      // the front page it leaves for is the connect tabs, with no Back, and never the dashboard
      expect(renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Back")).toHaveLength(0);
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Connect a PC");
    });

  });
});

const groupsOf = (html: string) => [...html.matchAll(/<span class="(key-id-group(?: key-id-differs)?)">([0-9a-f]{4})/g)].map(([, kind, group]) => [group, kind === "key-id-group key-id-differs"]);

describe("a key that is not the PC's", () => {
  it("splits an id into eight groups of four", () => {
    expect(keyIdGroups(EXPECTED)).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
  });

  for (const state of [
    { kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } },
    { kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } },
  ] as const) {
    it(`shows the PC's id and the other key's, marking the groups that differ (${state.kind})`, () => {
      const html = render(props(state));
      expect(html).toContain('data-relay-state="identity-changed"');
      const [pcGroups, receivedGroups] = [groupsOf(html).slice(0, 8), groupsOf(html).slice(8)];
      expect(pcGroups.every(([, differs]) => differs === false)).toBe(true);
      expect(receivedGroups).toEqual([["0123", false], ["4567", false], ["ffff", true], ["cdef", false], ["0123", false], ["4567", false], ["89ab", false], ["eeee", true]]);
      expect(html.match(/visually-hidden">\s*differs</g)).toHaveLength(2);
    });
  }

  it("never calls an id the PC's: each is labelled by where it came from", () => {
    const forged = render(props({ kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } }));
    expect(forged).not.toContain("This PC&#x27;s ID");
    expect(forged).toContain("ID this link names");
    expect(forged).toContain("ID of the key this link carries");
    // a bad saved key under a genuine link is the saved key's, not the link's
    const changed = render(props({ kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } }));
    expect(changed).toContain("ID this phone paired with");
    expect(changed).toContain("ID of the key this phone saved");
    expect(changed).not.toContain("this link carries");
  });

  it("says a key that does not parse is not a valid key, and still shows the PC's id", () => {
    const html = render(props({ kind: "forged", name: null, mismatch: { expected: EXPECTED, received: null, from: "link" } }));
    expect(html).toContain("Not a valid key");
    expect(groupsOf(html)).toHaveLength(8);
  });
});

describe("pairing with a typed code", () => {
  it("shows every group of the ID a code found before anything is paired", () => {
    const html = render(props({ kind: "code-compare", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", code: "123456", name: "Desk" } }));
    for (const group of keyIdGroups(EXPECTED)) expect(html).toContain(`>${group}<`);
    expect(html).toContain("It matches");
    expect(html).toContain('data-relay-state="code-compare"');
  });

  it("keeps the code in its field only, names the current path without legacy parentheticals, and says why the last one gave no PC", () => {
    const html = render(props({ kind: "code-entry", failure: "no-pc" }));
    expect(html).toMatch(/<input[^>]*name="code"/);
    expect(html).not.toMatch(/<input[^>]*name="code"[^>]*value=/);
    expect(html).toContain("Settings → Devices and PCs → Add a connection → Ovis relay");
    expect(html).not.toContain("older Ovis");
    expect(html).toContain("No PC shows this code");
  });
});

describe("a pairing's step frame", () => {
  it("shows a typed comparison's waiting card without digits, which only the PC holds", () => {
    const html = render(props({ kind: "compare", name: "Desk", digits: "", confirmed: true, typed: true }));
    expect(html).toContain("Approve on the PC if it shows the same number");
    expect(html).not.toContain("relay-shell-digits");
    expect(html).toContain("Approve this device on Desk within 90 seconds to finish.");
  });
});

describe("Back from Add a PC opened by its address", () => {
  const history = () => { const calls: string[] = []; return { calls, back: () => { calls.push("back"); }, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { calls.push(`replace ${String(url)}`); } }; };
  it("goes back to the PC page that opened it, and otherwise stays, dropping #add", () => {
    const opened = history();
    leaveAddEntry(`/s/${"a".repeat(32)}/`, opened);
    expect(opened.calls).toEqual(["back"]);
    const linked = history();
    leaveAddEntry(null, linked);
    expect(linked.calls).toEqual(["replace /"]);
  });
});

describe("#16: the one plain screen a phone waits on after its sign-in", () => {
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
  const id = "a".repeat(32);
  const noTabsNoList = (html: string): void => {
    expect(html).not.toContain("data-tab=");
    expect(html).not.toContain("New PC added to your account");
    expect(html).not.toContain("Needs approval");
    expect(html).not.toContain("add-pc-sheet");
  };

  it("names the PC and what to press there while the join a launch asked waits, with the number when it shows one", () => {
    const waiting = render({ ...props({ kind: "connecting", name: "Mac", pairing: true }), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    expect(waiting).toContain('data-approval-wait="pc"');
    expect(waiting).toContain("Press [Allow] on Mac");
    expect(waiting).toContain("Or pair with a code");
    noTabsNoList(waiting);
    const first = render({ ...props({ kind: "compare", name: "Mac", digits: "123456", confirmed: true, alone: true, approveOn: "mac" }), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    expect(first).toContain("Press [Allow] on Mac");
    expect(first).toContain("123 456");
    // a PC that already has a member asks for the number typed on its own window
    const typed = render({ ...props({ kind: "compare", name: "Mac", digits: "123456", confirmed: true, alone: true }), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    expect(typed).toContain("Type this number on Mac");
    expect(typed).toContain("123 456");
  });

  it("says to turn a PC on when none of the account's PCs is on, with Check again and no tabs or list", () => {
    const html = render({ ...props({ kind: "empty", waitPc: true, account: { kind: "signed-in", provider: "github", error: null, pcs: [{ server_id: id, name: "Mac", state: "offline", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false }] } }), scoped: false, onSignIn: none, onWaitAgain: none });
    expect(html).toContain('data-approval-wait="no-pc"');
    expect(html).toContain("Turn on Ovis on the PC");
    expect(html).toContain("Check again");
    noTabsNoList(html);
    expect(html).not.toContain(">Mac<");
  });
});

describe("#16 sweep: a signed-in device never lands on the connect tabs by itself", () => {
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
  const id = "a".repeat(32);
  const mac = { server_id: id, name: "Mac", state: "offline" as const, last_seen_at: null, added_at: null, listed: true, paired: false, linked: false };
  const signedIn = (pcs: MyPc[]) => ({ kind: "signed-in" as const, provider: "github" as const, error: null, pcs });
  const plain = (html: string): string | null => /data-approval-wait="([^"]+)"/.exec(html)?.[1] ?? null;
  const front = (state: RelayShellProps["state"], more: Partial<RelayShellProps> = {}) => render({ ...props(state), scoped: false, onSignIn: none, onWaitAgain: none, onFindPc: none, ...more });

  it("2: none of the account's PCs on names the PC that is off, with Check again", () => {
    const html = front({ kind: "empty", waitPc: true, offPc: "Mac", account: signedIn([mac]) });
    expect(plain(html)).toBe("off");
    expect(html).toContain("Mac is off. Turn on Ovis on it.");
    expect(html).toContain('data-action="check-again"');
    expect(html).toContain('data-action="other-ways"');
    expect(html).not.toContain("data-tab=");
  });

  it("3, 4: the PC this device opened is off (its relay too): one line naming it, not the tabs and the list", () => {
    const desk = { server_id: id, server_public_key: "k", relay: "wss://relay.example", name: "Desk", device_id: "0".repeat(16), label: "Phone" } as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
    const html = front({ kind: "list", devices: [desk], noneOnline: true, account: signedIn([]) });
    expect(plain(html)).toBe("off");
    expect(html).toContain("Desk is off. Turn on Ovis on it.");
    expect(html).not.toContain("data-tab=");
    expect(html).not.toContain("relay-add-saved-pc");
  });

  it("10: an account with no PC yet says to sign in on the PC, in one line", () => {
    const html = front({ kind: "empty", account: signedIn([]) });
    expect(plain(html)).toBe("no-account-pc");
    expect(html).toContain("Sign in with the same account on the PC where Ovis runs");
    expect(html).not.toContain("data-tab=");
  });

  it("13: a front page the person chose (Cancel, Back) is the connect tabs", () => {
    expect(plain(front({ kind: "empty", account: signedIn([]) }, { plainFront: false }))).toBeNull();
    expect(front({ kind: "empty", account: signedIn([]) }, { plainFront: false })).toContain("data-tab=");
  });

  it("5, 9: the join a launch asked ends in one line: declined or removed with Ask again, the PC off with Check again", () => {
    const failed = (failure: string) => render({ ...props({ kind: "failed", failure, name: "Mac", detail: null, server_id: id } as RelayShellProps["state"]), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    const declined = failed("pair-declined");
    expect(plain(declined)).toBe("declined");
    expect(declined).toContain("Not allowed. Ask again, then press [Allow] on Mac.");
    expect(declined).toContain('data-action="ask-again"');
    const unanswered = failed("pair-unanswered");
    expect(plain(unanswered)).toBe("unanswered");
    expect(unanswered).toContain("No answer from Mac");
    expect(unanswered).toContain('data-action="ask-again"');
    expect(unanswered).not.toContain("Not allowed");
    const removed = failed("revoked");
    expect(plain(removed)).toBe("removed");
    expect(removed).toContain("This device was removed from Mac. Ask again to join it.");
    const off = failed("pc-offline");
    expect(plain(off)).toBe("off");
    expect(off).toContain('data-action="check-again"');
  });

  it("9: a signed-in device removed from a PC it had opened says so in one line, with Ask again", () => {
    const html = render({ ...props({ kind: "failed", failure: "revoked", name: "Mac", detail: null, server_id: id }), signedIn: true, onAskAgain: none });
    expect(plain(html)).toBe("removed");
    expect(html).toContain('data-action="ask-again"');
  });
});
