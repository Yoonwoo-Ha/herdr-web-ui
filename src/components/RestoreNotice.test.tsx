import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { reloadRestoredAppPage } from "../lib/pageRestore.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RestoreNotice } from "./RestoreNotice.tsx";

const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
const replaced = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("https://app.ovis.sh/s/abc/"), setTimeout, clearTimeout }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  for (const [key, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  replaced.clear();
});

describe("the notice of a restored page whose reload waits for its unsent text", () => {
  it("says to copy the text, and its Reload app reloads once the text is kept or gone", async () => {
    const target = new EventTarget();
    const loads: string[] = [];
    let kept = false;
    reloadRestoredAppPage({ addEventListener: target.addEventListener.bind(target), location: { reload: () => { loads.push("reload"); } } }, () => true, () => kept);
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(RestoreNotice) })); });
    expect(renderer!.toJSON()).toBeNull();
    await act(async () => { target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })); });
    const notice = () => renderer!.root.find((node) => node.props["data-restore-held"] !== undefined);
    expect(textOf(notice())).toContain("Copy what you need, then reload.");
    await act(async () => { notice().findByType("button").props.onClick(); });
    expect(loads).toEqual([]);
    expect(textOf(notice())).toContain("still not kept");
    kept = true;
    await act(async () => { notice().findByType("button").props.onClick(); });
    expect(loads).toEqual(["reload"]);
    expect(renderer!.toJSON()).toBeNull();
  });
});
