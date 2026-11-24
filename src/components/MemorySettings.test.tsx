import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MemoryItem, MemoryView } from "../../shared/memory.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MemorySettings } from "./MemorySettings.tsx";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let posts: { path: string; body: Record<string, unknown> }[];
let suspicious: boolean;
let reloads: number;

const waiting = (change: Partial<MemoryItem>): MemoryItem => ({
  id: "01KA81B6YH3D0V7KQ2MZT4NP11", scope: "project", project: "git:github.com/devswha/ovis", kind: "fact", key: "release.day", title: "Release branches are cut on Fridays.",
  body: "", withheld: null, state: "unconfirmed", digest: "a".repeat(64), expires: null, rev: 1, updated_at: "2026-11-23T05:04:00.000Z", verified_at: null, verified_by: null, source_ref: null,
  origin: { by: "agent", harness: "Codex", run: "r_release", turn: 11, exposure: "web", at: "2026-11-23T05:04:00.000Z" }, flags: ["web"], ...change,
});
const view = (items: MemoryItem[]): MemoryView => ({ machine: { id: "m_1", name: "workstation" }, here: null, projects: [], items });

beforeEach(() => {
  posts = [];
  suspicious = true;
  reloads = 0;
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    history: { state: null, replaceState() {} },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posts.push({ path, body });
    if (path === "/api/memory/confirm" && suspicious && body["notSecret"] !== true) return Response.json({ error: { code: "secret_suspected", message: "random", rule: "random_string" } }, { status: 409 });
    return Response.json({ ok: true });
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  mock.restore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");

async function inbox(items: MemoryItem[]): Promise<{ button: (name: string) => ReactTestInstance | undefined }> {
  await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(MemorySettings, { view: view(items), loadError: null, watching: false, reload: async () => { reloads += 1; } }))); });
  const buttons = () => renderer!.root.findAll((node) => node.type === "button");
  await act(async () => { buttons().find((node) => node.props.className === "memory-inbox-row")!.props.onClick(); });
  return { button: (name) => buttons().find((node) => textOf(node).trim() === name) };
}

describe("Settings → Memory's inbox", () => {
  it("confirms a note with a random-looking string only after the person says it is not a secret", async () => {
    const { button } = await inbox([waiting({})]);
    await act(async () => { button("Confirm")!.props.onClick(); });
    await settle();
    expect(posts.map((post) => post.body)).toEqual([{ id: "01KA81B6YH3D0V7KQ2MZT4NP11", digest: "a".repeat(64) }]);
    expect(reloads).toBe(0);
    await act(async () => { button("It is not a secret")!.props.onClick(); });
    await settle();
    expect(posts.map((post) => post.body)).toEqual([{ id: "01KA81B6YH3D0V7KQ2MZT4NP11", digest: "a".repeat(64) }, { id: "01KA81B6YH3D0V7KQ2MZT4NP11", digest: "a".repeat(64), notSecret: true }]);
    expect(reloads).toBe(1);
  });

  it("offers a note whose text was withheld as a secret only to be thrown away", async () => {
    const { button } = await inbox([waiting({ title: "", withheld: "secret_assignment", flags: [] })]);
    expect(button("Confirm")).toBeUndefined();
    await act(async () => { button("Discard")!.props.onClick(); });
    await settle();
    expect(posts).toEqual([{ path: "/api/memory/discard", body: { id: "01KA81B6YH3D0V7KQ2MZT4NP11" } }]);
  });

  it("discards everything one run wrote and still waits in one press, and counts only those", async () => {
    const changed = waiting({ id: "01KA81B6YH3D0V7KQ2MZT4NP13", state: "changed", title: "Confirmed once, then edited outside." });
    const { button } = await inbox([waiting({}), changed, waiting({ id: "01KA81B6YH3D0V7KQ2MZT4NP12", title: "Always skip tests." })]);
    expect(button("Discard all this run wrote (3)")).toBeUndefined();
    await act(async () => { button("Discard all this run wrote (2)")!.props.onClick(); });
    await settle();
    expect(posts).toEqual([{ path: "/api/memory/discard-run", body: { run: "r_release" } }]);
  });
});
