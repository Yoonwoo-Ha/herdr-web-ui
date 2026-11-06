import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MovePlanResponse } from "../../shared/runtime-move.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RuntimeMove } from "./RuntimeMove.tsx";

// Settings → About on a herdr PC without herdr-core: the move is offered with an install of it.
describe("the move to herdr-core where herdr-core is missing", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: { method: string; path: string }[];
  let installAnswer: () => Response;
  const plan: MovePlanResponse = { available: false, reason: "no_herdr_core", install: { version: "0.1.17" }, status: { state: "idle" } };

  beforeEach(() => {
    requests = [];
    installAnswer = () => Response.json({ error: { code: "install_failed", message: "the herdr-core download does not match its checksum" } }, { status: 502 });
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
      requests.push({ method: init?.method ?? "GET", path });
      if (path === "/api/runtime/move/install") return installAnswer();
      if (path === "/api/runtime/move") return Response.json(plan);
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
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

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async () => {
    await act(async () => { renderer = create(<SettingsProvider><RuntimeMove bootId="boot-1" hidden={false} /></SettingsProvider>); });
  };
  const button = () => renderer!.root.find((node) => node.type === "button");

  it("shows the row with the version it installs, and keeps it with the reason when the install fails", async () => {
    await mount();
    expect(text(renderer!.root)).toContain("Install herdr-core and move everything");
    expect(text(renderer!.root)).toContain("herdr-core 0.1.17");
    expect(text(button()).trim()).toBe("Install and move…");

    await act(async () => { button().props.onClick(); });
    expect(requests.filter((request) => request.method === "POST")).toEqual([{ method: "POST", path: "/api/runtime/move/install" }]);
    expect(renderer!.root.find((node) => node.props.role === "alert").children.map((child) => typeof child === "string" ? child : text(child)).join("")).toContain("does not match its checksum");
    expect(button().props.disabled).toBe(false);
  });
});
