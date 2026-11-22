import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { SETUP_ROW_KEY } from "../lib/firstHints.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SetupActions } from "./SetupProgressRow.tsx";

// the checklist is a portal on document.body, which this renderer has none of
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { SetupProgressRow } = await import("./SetupProgressRow.tsx");

const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let guideOpened = 0;
let called: string[] = [];

const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [], getClientRects: () => [], getBoundingClientRect: () => ({ top: 700, left: 0, right: 240, bottom: 732, width: 240, height: 32 }), closest: () => null, addEventListener() {}, removeEventListener() {} });
const textOf = (instance: ReactTestInstance): string => instance.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const item = (id: string) => renderer!.root.find((instance) => instance.type === "button" && instance.props["data-item"] === id);

beforeEach(() => {
  const events = new EventTarget();
  const local = new Map<string, string>([[SETUP_ROW_KEY, "on"]]);
  const storage = { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => { local.set(key, value); }, removeItem: (key: string) => { local.delete(key); } };
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  for (const [name, value] of Object.entries({
    window: Object.assign(events, { localStorage: storage, matchMedia, innerWidth: 1280, innerHeight: 800, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, location: new URL("http://127.0.0.1:7317/"), history: { state: null, replaceState() {}, pushState() {}, back() {} } }),
    IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), { activeElement: null, body: {}, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 },
    matchMedia,
    localStorage: storage,
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  guideOpened = 0;
  called = [];
  window.addEventListener("ovis:open-setup-guide", () => { guideOpened += 1; });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globals.clear();
});

const actions: SetupActions = { workspace: () => { called.push("workspace"); }, phone: () => { called.push("phone"); }, alerts: () => { called.push("alerts"); } };

async function openChecklist(facts: { workspace: boolean; phone: boolean; alerts: boolean }): Promise<void> {
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(SetupProgressRow, { facts, actions }) }), { createNodeMock: node as never });
  });
  const row = renderer!.root.find((instance) => instance.type === "button" && String(instance.props.className).includes("setup-row-open"));
  expect(textOf(row)).toContain("Setup: 2 left");
  await act(async () => { row.props.onClick(); });
}

describe("the setup row", () => {
  it("opens a checklist of the four parts, never the whole guide, done ones ticked", async () => {
    await openChecklist({ workspace: true, phone: false, alerts: false });
    expect(guideOpened).toBe(0);
    const menu = renderer!.root.find((instance) => instance.props.role === "menu");
    expect(menu.findAll((instance) => instance.type === "button").map((instance) => [instance.props["data-item"], instance.props["aria-checked"] === true])).toEqual([
      ["workspace", true], ["theme", true], ["phone", false], ["alerts", false],
    ]);
  });

  it("runs each remaining item's own action, and the done one does nothing", async () => {
    for (const id of ["phone", "alerts"] as const) {
      await openChecklist({ workspace: true, phone: false, alerts: false });
      await act(async () => { item(id).props.onClick(); });
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    }
    expect(called).toEqual(["phone", "alerts"]);
    await openChecklist({ workspace: true, phone: false, alerts: false });
    expect(item("workspace").props["aria-disabled"]).toBe(true);
    await act(async () => { item("workspace").props.onClick(); });
    expect(called).toEqual(["phone", "alerts"]);
    // the checklist stays: a done row is no way out of it
    expect(renderer!.root.findAll((instance) => instance.props.role === "menu")).toHaveLength(1);
    expect(guideOpened).toBe(0);
  });

  it("opens a workspace from its item when none is open yet", async () => {
    await openChecklist({ workspace: false, phone: true, alerts: false });
    await act(async () => { item("workspace").props.onClick(); });
    expect(called).toEqual(["workspace"]);
    expect(guideOpened).toBe(0);
  });
});
