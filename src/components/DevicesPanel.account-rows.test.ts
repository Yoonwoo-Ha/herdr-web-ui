import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { PairedDevice } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { DEVICES_CHANGED_EVENT } from "../lib/useRelay.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";

describe("a device the PC's account let in, in Devices and PCs", () => {
  const joined: PairedDevice = { id: "00000000000000a1", label: "Phone", role: "drive", created_at: "2026-11-20T09:00:00.000Z",
    last_seen_at: "2026-11-21T00:00:00.000Z", current: false, via_relay: true, through_account: true };
  const paired: PairedDevice = { id: "00000000000000b2", label: "Tablet", role: "drive", created_at: "2026-11-01T09:00:00.000Z", last_seen_at: null, current: false, via_relay: true };
  let reads: Array<(devices: PairedDevice[]) => void> = [];
  let renderer: ReactTestRenderer | null = null;
  let paired_: number;
  const saved = ["window", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");

  beforeEach(() => {
    paired_ = 0;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
      setInterval, clearInterval, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    setTransport({ ...nativeTransport, fetch: async () => Response.json({ devices: await new Promise<PairedDevice[]>((resolve) => reads.push(resolve)) }) });
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    reads = [];
    setTransport(nativeTransport);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    if (languages) Object.defineProperty(navigator, "languages", languages); else Reflect.deleteProperty(navigator, "languages");
  });

  const turns = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
  const mount = async () => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(DevicesPanel, {
        auth: { required: true, authenticated: true, via: "device", role: "drive" }, onDevicePaired: () => { paired_++; } }) }));
    });
  };
  const answer = async (read: number, devices: PairedDevice[]) => { await act(async () => { reads[read]!(devices); await turns(); }); };
  const text = () => JSON.stringify(renderer!.toJSON());
  const labelled = (label: string) => renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);

  it("tags the row, and offers its rename and revoke as on any row", async () => {
    await mount();
    await answer(0, [paired, joined]);
    expect(text()).toContain("Through your account");
    expect(renderer!.root.findAll((node) => node.props.className === "devices-kind" && JSON.stringify(node.props.children) === "\"Through your account\"")).toHaveLength(1);
    expect(labelled("Rename Phone")).toHaveLength(1);
    expect(labelled("Revoke Phone")).toHaveLength(1);
    // the PC keeps the day it was last used, not the time: no row says it was seen some hours ago
    expect(text()).toContain(new Date("2026-11-21T00:00:00.000Z").toLocaleDateString("en", { timeZone: "UTC" }));
    expect(text()).not.toMatch(/\d+ h ago/);
  });

  it("with only rows the account let in, the list shows them with their own Revoke, offers no Revoke all, and never says nothing is paired", async () => {
    await mount();
    await answer(0, [joined]);
    expect(text()).not.toContain("No devices paired yet.");
    expect(text()).toContain("Phone");
    expect(labelled("Revoke Phone")).toHaveLength(1);
    expect(text()).not.toContain("Revoke every device");
    await act(async () => { window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)); });
    await answer(1, [joined, paired]);
    expect(text()).toContain("Revoke every device");
  });

  it("a row the account let in is no pairing: nothing says it was paired, and a dialog waiting for one stays", async () => {
    await mount();
    await answer(0, [paired]);
    await act(async () => { window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)); });
    await answer(1, [paired, joined]);
    expect(text()).toContain("Through your account");
    expect(text()).not.toContain("Paired: Phone.");
    expect(paired_).toBe(0);
    // a device paired by a code still is
    await act(async () => { window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)); });
    await answer(2, [paired, joined, { ...paired, id: "00000000000000c3", label: "Laptop" }]);
    expect(text()).toContain("Paired: Laptop.");
    expect(paired_).toBe(1);
  });
});
