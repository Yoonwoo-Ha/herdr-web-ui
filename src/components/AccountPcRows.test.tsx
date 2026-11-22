import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import { SignedOutError, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the confirmation is a portal into document.body: drawn in place here, so the test renderer holds it
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { AccountPcRows, NoAccountPcHint, signInOfAccount } = await import("./AccountPcs.tsx");

const DESK = "a".repeat(32);
const LAPTOP = "b".repeat(32);
const pc = (server_id: string, name: string): MyPc => ({ server_id, name, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false });

const NOW = Date.parse("2026-11-11T00:00:00Z");
const gone = (server_id: string, name: string): MyPc => ({ ...pc(server_id, name), state: "offline", last_seen_at: "2026-11-01T00:00:00Z", added_at: "2026-10-01T00:00:00Z" });

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("the account's PCs in a PC's own Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://pc.example/", search: "", origin: "https://pc.example", pathname: "/" },
      history: { state: null, replaceState() {} },
      localStorage: storage, matchMedia, innerWidth: 1440,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: new HTMLElement(),
      body: { nodeType: 1, children: [] },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    console.warn = warn;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = async (node: ReactNode): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: node }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    if (!renderer) throw new Error("not mounted");
    return renderer.root;
  };

  it("gives the rows no action of their own (an offline one is removed in Manage account), and no sentence or link under them", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [pc(DESK, "Desk"), gone(LAPTOP, "Laptop")], now: NOW, onChanged: () => {} }));
    expect(root.findAll((node) => node.type === "a")).toHaveLength(0);
    const [desk, laptop] = root.findAll((node) => node.type === "li").map(textOf);
    expect(desk).toBe("DeskPCIn your account");
    expect(laptop).toStartWith("LaptopPCOffline · ");
    expect(root.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("draws nothing when the account lists no other PC", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [], now: NOW, onChanged: () => {} }));
    expect(root.findAll((node) => node.type === "a" || node.type === "li")).toHaveLength(0);
  });

  it("says an account with no PC has none, in words that hold for every way of signing in", async () => {
    const root = await mount(createElement(NoAccountPcHint, { provider: "apple" }));
    expect(textOf(root)).toBe("No PC in this account yet. Signed in with Apple: each way of signing in is a separate Ovis account until you link them.");
  });
});

describe("signInOfAccount", () => {
  const session = (account: string): AccountSession => ({ service: "https://account.example", account, provider: "github", access_token: "a", refresh_token: "r", expires_at: 0, sign_in_id: `id-${account}` });
  const serviceWith = (stored: AccountSession | undefined): Pick<AccountService, "session"> => ({ session: async () => stored });

  it("is the sign-in whose list is shown", async () => {
    expect(await signInOfAccount(serviceWith(session("acct-1")), "acct-1")).toEqual(session("acct-1"));
  });

  it("is none once another sign-in, or none, is stored", async () => {
    await expect(signInOfAccount(serviceWith(session("acct-2")), "acct-1")).rejects.toBeInstanceOf(SignedOutError);
    await expect(signInOfAccount(serviceWith(undefined), "acct-1")).rejects.toBeInstanceOf(SignedOutError);
  });
});

describe("Settings → Devices and PCs", () => {
  it("draws the Account group above the device list, outside More settings", () => {
    const source = readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");
    const page = source.slice(source.indexOf("function DevicesPage("), source.indexOf("function UseRelayHere("));
    const account = page.indexOf("<AccountSection ");
    const fold = page.indexOf('<SettingsFold kind="more"');
    expect(account).toBeGreaterThan(-1);
    expect(page.indexOf("<AccountSection ", account + 1)).toBe(-1);
    expect(account).toBeLessThan(page.indexOf('<SettingsGroup section="devices">'));
    expect(account).toBeLessThan(fold);
    expect(page.slice(page.indexOf("const openAccount"), page.indexOf("const accountService"))).not.toContain("details");
  });
});
