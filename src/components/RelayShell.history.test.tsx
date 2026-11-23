import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import * as sheetHistory from "../lib/sheetHistory.ts";
import type { RelayShellProps } from "./RelayShell.tsx";

// A tablet turned between portrait and landscape: a coarse pointer, so a sheet's Back is the phone's own and every open
// sheet takes an entry in the history (sheetHistory BACK_QUERY), on both sides of the 1024 px line. sheetHistory hears
// Back only where a window stood when it loaded: this file loads its own copy after its window and hands that to the page.
const WIDE = "(min-width: 1024px)";
const HREF = "https://app.ovis.sh/";
const none = () => {};
const ids = { mini: "c".repeat(32) };
const front: RelayShellProps = {
  state: { kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } },
  scoped: false, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none, onSignIn: none,
};

const globals = ["window", "document", "navigator", "localStorage", "sessionStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IntersectionObserver", "IS_REACT_ACT_ENVIRONMENT"];
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const loaded = { ...sheetHistory };
const events = new EventTarget();
const entries: unknown[] = [null];
let index = 0;
let wideNow = false;
const watchers = new Map<(event: { matches: boolean }) => void, string>();
const matching = (query: string): boolean => query === WIDE ? wideNow : query.includes("(pointer: coarse)");
const matchMedia = (query: string) => ({
  get matches() { return matching(query); },
  addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { watchers.set(listener, query); },
  removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { watchers.delete(listener); },
});
const turn = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
};
/** a step down the history, told by popstate on a later turn, as a browser does */
const traverseBack = (): void => {
  if (index === 0) throw new Error("no entry to go back to");
  index -= 1;
  queueMicrotask(() => events.dispatchEvent(Object.assign(new Event("popstate"), { state: entries[index] })));
};
/** the tablet's own Back */
const browserBack = async (): Promise<void> => { traverseBack(); await turn(); };
const rotate = async (wide: boolean): Promise<void> => {
  wideNow = wide;
  await act(async () => { for (const [listener, query] of [...watchers]) listener({ matches: matching(query) }); });
  await turn();
};

let RelayShell: typeof import("./RelayShell.tsx").RelayShell;
let renderer: ReactTestRenderer | undefined;

beforeAll(async () => {
  for (const key of globals) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {}, pauseAnimations() {}, unpauseAnimations() {} });
  const store = (): Storage => { const kept = new Map<string, string>(); return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); }, key: () => null, length: 0, clear: () => kept.clear() }; };
  const storage = store();
  class HTMLElement { isConnected = true; focus(): void {} }
  class IntersectionObserver { observe(): void {} disconnect(): void {} }
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1); entries.push(state); index += 1; },
    replaceState(state: unknown) { entries[index] = state; },
    back() { traverseBack(); },
    forward() {},
    go() {},
  };
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, value });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("HTMLElement", HTMLElement);
  define("IntersectionObserver", IntersectionObserver);
  define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  define("navigator", { languages: ["en"], userAgent: "Mozilla/5.0 (Linux; Android 15)", maxTouchPoints: 5 });
  define("localStorage", storage);
  define("sessionStorage", store());
  define("matchMedia", matchMedia);
  define("window", {
    get location() { return { href: HREF, search: "", hash: "", origin: "https://app.ovis.sh", pathname: "/", assign() {}, replace() {} }; },
    history, localStorage: storage, matchMedia, innerWidth: 800,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  });
  define("document", {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    activeElement: new HTMLElement(),
    body: { nodeType: 1, children: [], createNodeMock: node },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  });
  const historyPath = "../lib/sheetHistory.ts?relay-shell-history", shellPath = "./RelayShell.tsx?relay-shell-history";
  const fresh = await import(historyPath) as typeof sheetHistory;
  mock.module("../lib/sheetHistory.ts", () => fresh);
  ({ RelayShell } = await import(shellPath) as typeof import("./RelayShell.tsx"));
});

afterAll(async () => {
  await act(async () => { renderer?.unmount(); });
  mock.module("../lib/sheetHistory.ts", () => loaded);
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("the hosted front page on a tablet turned across 1024 px", () => {
  const shown = (node: ReactTestInstance): boolean => { for (let at: ReactTestInstance | null = node; at !== null; at = at.parent) if (at.props?.hidden === true) return false; return true; };
  const one = (what: string, found: ReactTestInstance[]): ReactTestInstance => { if (found.length !== 1) throw new Error(`${found.length} ${what} on screen`); return found[0]!; };
  const action = (name: string) => one(`${name} buttons`, renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === name && shown(node)));
  const views = () => renderer!.root.findAll((node) => node.type === "div" && typeof node.props["data-view"] === "string" && shown(node)).map((node) => node.props["data-view"] as string);
  const dialogs = () => renderer!.root.findAll((node) => node.props.role === "dialog").map((node) => node.props["data-pair-dialog"] as string);

  /** the sheet that owns the entry the history stands on, if any */
  const top = (): unknown => (entries[index] as Record<string, unknown> | null)?.["ovis:sheet"] ?? null;
  const nodeMock = () => ({ focus() {}, isConnected: true, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} });

  it("closes the pairing dialog with the tablet's Back after a turn to portrait, then Add a PC with the next, back to the list", async () => {
    const cancelled: string[] = [];
    const draw = (next: RelayShellProps) => act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, next) })); });
    const atFront: RelayShellProps = { ...front, onCancel: () => { cancelled.push("cancel"); } };
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, atFront) }), { createNodeMock: nodeMock }); });
    expect(views()).toEqual(["my-pcs"]);
    await act(async () => { action("add-pc").props.onClick(); });
    await turn();
    expect(views()).toEqual(["add-pc"]);
    expect([index, entries.length]).toEqual([1, 2]);
    const addEntry = top();
    expect(addEntry).not.toBeNull();
    // landscape: Add a PC stands beside the list, no step of its own; its code finds a PC, compared in the dialog
    await rotate(true);
    expect(views()).toEqual(["my-pcs", "add-pc"]);
    expect(index).toBe(0);
    await act(async () => { action("add-code").props.onClick(); });
    const form = renderer!.root.find((node) => node.type === "form" && node.props["data-code-form"] !== undefined);
    await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "ABCDE-12345" }) } } }); });
    await draw({ ...atFront, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: "wss://relay-ap.ovis.sh", code: "ABCDE-12345", name: "Mac mini" } } });
    await turn();
    expect(dialogs()).toEqual(["compare"]);
    expect(index).toBe(1);
    const dialogEntry = top();
    expect(dialogEntry).not.toBe(addEntry);
    // portrait again under the dialog: it stays the top of the history, Add a PC's entry waiting under it
    await rotate(false);
    expect([index, entries.length, top()]).toEqual([1, 2, dialogEntry]);
    // Back closes the dialog first, and the code with it, while the front page the shell reads again is on its way
    await browserBack();
    expect(dialogs()).toEqual([]);
    expect(cancelled).toEqual(["cancel"]);
    await draw(atFront);
    expect(views()).toEqual(["add-pc"]);
    // Add a PC took its entry once the dialog closed: the next Back comes back to the list
    expect(index).toBe(1);
    expect([null, dialogEntry]).not.toContain(top());
    await browserBack();
    expect(views()).toEqual(["my-pcs"]);
    expect(index).toBe(0);
    expect(dialogs()).toEqual([]);
  });
});
