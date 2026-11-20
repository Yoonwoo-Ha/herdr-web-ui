import { expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { parseNoticeAnswer, type DeviceNotice } from "../shared/account-devices-api.ts";
import { parseSafetyRecord, verifySafetyRecord, type BlockRecord } from "../shared/account-records.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import type { PendingKey } from "../shared/machines.ts";
import type { DeviceRole } from "../shared/access.ts";
import { App } from "./App.tsx";
import { indexedAccountService } from "./lib/account/service.ts";
import { indexedAccountStore, memoryAccountStore, newKey } from "./lib/account/store.ts";
import { DEVICE_NOTICE_FEATURE, DeviceNoticeWire, deviceNotice, NOTICE_SNAPSHOT } from "./lib/deviceNoticeWire.fixture.ts";
import { translate } from "./lib/i18n.ts";
import { MachineSessionRegistry } from "./lib/machineSession.ts";
import { SettingsProvider } from "./lib/settings.ts";
import { storeSelection } from "./lib/useSplitView.ts";

async function withDeviceNotices(
  options: { readonly no?: number | null; readonly laptopId?: string; readonly remoteNotice?: boolean; readonly deskFeatures?: Parameters<DeviceNoticeWire["snapshot"]>[0]; readonly admission?: Pick<DeviceNotice, "method" | "two_step">; readonly decline?: () => Promise<Response>; readonly role?: () => DeviceRole },
  check: (fixture: { readonly tree: ReactTestRenderer; readonly laptop: DeviceNoticeWire; readonly desk: DeviceNoticeWire;
    readonly delivered: readonly BlockRecord[]; readonly servicePosts: readonly { readonly body: unknown; readonly status: number }[] }) => void | Promise<void>,
) {
  const keys = memoryAccountStore();
  const service = new FakeAccountService();
  service.opensAll = true;
  const accountId = "acct";
  const target = await newKey();
  const key = options.no === undefined ? undefined : await newKey();
  await keys.set("session", { account: accountId, sign_in_id: "test", provider: "github", service: "https://account.example", access_token: service.issueToken(accountId), refresh_token: "test", expires_at: Number.MAX_SAFE_INTEGER });
  if (key !== undefined && options.no !== undefined) await keys.set("signin_key", { account: accountId, sign_in_id: "test", key, no: options.no });
  for (const no of [1, 2, 3, 4]) {
    service.registerDevice(accountId, no === 4 ? target.public_spki : no === options.no && key !== undefined ? key.public_spki : String(no).repeat(43), `Device ${no}`);
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const storage = new Map<string, string>();
  const browserStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  const location = new URL("http://localhost:4880/");
  const matchMedia = () => Object.assign(new EventTarget(), { matches: false });
  const history = { replaceState() {}, pushState() {} };
  const wires = new Map<string, DeviceNoticeWire>();
  const delivered: BlockRecord[] = [];
  const servicePosts: { readonly body: unknown; readonly status: number }[] = [];
  class Wire extends DeviceNoticeWire {
    constructor(url: string) { super(url); wires.set(new URL(url, location).searchParams.get("machine_id") ?? "local", this); }
    override send(message: string) {
      super.send(message);
      const frame: unknown = JSON.parse(message);
      if (typeof frame !== "object" || frame === null || !("type" in frame) || frame.type !== "notice-answer") return;
      const answer = parseNoticeAnswer(frame);
      if (answer.answer !== "not_me") return;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        type: "notice-answer-result", id: answer.id, receipts: answer.blocks.map(({ id }) => ({ outcome: "applied", id, n: 1 })),
      }) }));
    }
  }
  install("window", Object.assign(new EventTarget(), { location, history, matchMedia, localStorage: browserStorage, sessionStorage: browserStorage, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (frame: FrameRequestCallback) => setTimeout(() => frame(performance.now()), 0), cancelAnimationFrame: clearTimeout, innerWidth: 1440, innerHeight: 900,
  }));
  install("document", Object.assign(new EventTarget(), {
    visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} }, hasAttribute: () => false },
    body: { dataset: {}, style: {}, classList: { toggle() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hasFocus: () => true,
  }));
  install("navigator", { language: "en-US", languages: ["en-US"], userAgent: "Test", platform: "Linux", onLine: true });
  install("localStorage", browserStorage);
  install("sessionStorage", browserStorage);
  install("location", location);
  install("history", history);
  install("matchMedia", matchMedia);
  install("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  install("MutationObserver", class { observe() {} disconnect() {} });
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("__HERDR_TEST_HOOKS__", false);
  install("WebSocket", Wire);
  install("EventSource", class extends EventTarget { close() {} });
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input, location);
    const { pathname } = url;
    if (url.origin === "https://account.example" && pathname === "/v1/safety-records" && typeof init?.body === "string") {
      const response = await service.fetch(url, init);
      servicePosts.push({ body: JSON.parse(init.body), status: response.status });
      return response;
    }
    if (url.origin === "https://account.example" && pathname === "/v1/signout") return service.fetch(url, init);
    if (pathname === "/api/devices/pending/decline" && options.decline !== undefined) return options.decline();
    if (pathname === "/api/health") return Response.json({
      auth: { required: false, authenticated: true, role: options.role?.() ?? "drive" },
      web_ui: { boot_id: null, revision: null, server_id: options.laptopId },
    });
    if (pathname === "/api/machines") return Response.json({ machines: [
      { id: "local", name: "Laptop", kind: "local", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
      { id: "desk", server_id: "b".repeat(32), name: "Desk", kind: "address", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
    ] });
    if ((pathname === "/api/machines/desk/account/records" || pathname === "/api/account/records") && init?.method === "POST" && typeof init.body === "string") {
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null || !("records" in body) || !Array.isArray(body.records)) return new Response(null, { status: 400 });
      const receipts = [];
      for (const input of body.records) {
        const record = parseSafetyRecord(input);
        if (record.kind !== "block") return new Response(null, { status: 400 });
        delivered.push(record);
        receipts.push({ outcome: "applied", id: record.id, n: 2 });
      }
      return Response.json({ receipts });
    }
    return new Response(null, { status: 404 });
  });
  let tree: ReactTestRenderer | undefined;
  const sessions = spyOn(MachineSessionRegistry.prototype, "peek").mockImplementation(function (this: MachineSessionRegistry, id) {
    const session = this.get(id);
    session.connect();
    return session;
  });
  const account = spyOn(indexedAccountStore, "get").mockImplementation(keys.get);
  const accountUpdate = spyOn(indexedAccountStore, "update").mockImplementation(keys.update);
  try {
    storeSelection(options.remoteNotice ? "desk" : "local", null);
    await act(async () => { tree = create(<SettingsProvider><App /></SettingsProvider>); });
    const laptop = wires.get("local");
    const desk = wires.get("desk");
    if (!tree || !laptop || !desk) throw new Error(`App sockets not connected: ${[...wires.keys()]}`);
    await act(async () => {
      laptop.open();
      desk.open();
      laptop.snapshot();
      desk.snapshot(options.deskFeatures);
      laptop.read({ type: "device-notice", notice: deviceNotice({ label: "Laptop phone", key: target.public_spki, ...options.admission }) });
      desk.read({ type: "device-notice", notice: deviceNotice({ label: "Desk phone", key: target.public_spki }) });
    });
    await check({ tree, laptop, desk, delivered, servicePosts });
  } finally {
    await act(async () => { tree?.unmount(); });
    sessions.mockRestore();
    account.mockRestore();
    accountUpdate.mockRestore();
    for (const [key, previous] of originals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

it("T57, P15: Laptop's pane never shows Desk's device notice", async () => {
  await withDeviceNotices({}, ({ tree, laptop, desk }) => {
    const cards = tree.root.findAll((node) => node.type === "div" && node.props["data-testid"] === "device-notice");
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain("Laptop phone");
    expect(JSON.stringify(tree.toJSON())).not.toContain("Desk phone");
    expect(laptop.seen()).toEqual([{ type: "notice-seen", seq: 1 }]);
    expect(desk.seen()).toEqual([]);
  });
});

it.each([
  ["older", 3, 1],
  ["same order", 4, 0],
  ["newer", 5, 0],
  ["unregistered", null, 0],
  ["missing", undefined, 0],
] as const)("T51: Not me is gated by a %s sign-in key", async (_label, no, count) => {
  await withDeviceNotices(no === undefined ? {} : { no }, ({ tree }) => {
    expect(tree.root.findAllByType("button").filter((button) => button.children.includes("Not me"))).toHaveLength(count);
  });
});

it.each([
  ["identified", { laptopId: "a".repeat(32) }, "applied", "Laptop: blocked"],
  ["unidentified", {}, "waiting", "Laptop: waiting for its answer"],
  ["identified with a flag-off roster PC", { laptopId: "a".repeat(32), deskFeatures: [] }, "applied", "Laptop: blocked"],
] as const)("G5, T51, T60, T65: %s notice PC takes one signed block and only enabled roster PCs get records POSTs", async (_label, identity, state, line) => {
  await withDeviceNotices({ no: 3, ...identity }, async ({ tree, laptop, desk, delivered, servicePosts }) => {
    const button = tree.root.findAllByType("button").find((node) => node.children.includes("Not me"));
    if (button === undefined) throw new TypeError("Missing Not me");
    await act(async () => { await button.props.onClick(); });

    const answers = laptop.sent.filter((frame) => frame.type === "notice-answer").map(parseNoticeAnswer);
    expect(answers).toHaveLength(1);
    const answer = answers[0];
    expect(answer).toMatchObject({ id: deviceNotice().id, answer: "not_me" });
    if (answer?.answer !== "not_me") return;
    expect(answer.blocks).toHaveLength(1);
    for (const block of answer.blocks) expect(await verifySafetyRecord(block)).toBe(true);
    expect(desk.sent.filter((frame) => frame.type === "notice-answer")).toEqual([]);
    expect(servicePosts).toEqual([{ body: { record: answer.blocks[0] }, status: 200 }]);
    expect(delivered).toEqual("deskFeatures" in identity ? [] : answer.blocks);

    const card = tree.root.findByProps({ "data-testid": "device-notice" });
    expect(card.findAllByType("li").map((row) => [row.props["data-state"], row.children.join("")])).toEqual(
      "deskFeatures" in identity ? [[state, line]] : [[state, line], ["waiting", "Desk: waiting for its answer"]],
    );
  });
});

it("an admission with two-step unknown keeps the one-tap Not me (T51, T60)", async () => {
  await withDeviceNotices({ no: 3, admission: { method: "google", two_step: "unknown" } }, ({ tree }) => {
    const card = tree.root.findByProps({ "data-testid": "device-notice" });
    const buttons = card.findAllByType("button").filter((button) => button.children.includes(translate("en", "Not me")));
    expect(buttons.map((button) => button.props.disabled)).toEqual([false]);
  });
});

it("T60: a remote notice counts the page PC’s own records receipt, not the proxy receipt", async () => {
  await withDeviceNotices({ no: 3, laptopId: "a".repeat(32), remoteNotice: true }, async ({ tree, desk, laptop, delivered }) => {
    const card = tree.root.findByProps({ "data-testid": "device-notice" });
    const button = card.findAllByType("button").find((node) => node.children.includes("Not me"));
    if (!button) throw new TypeError("Missing Not me");
    await act(async () => { await button.props.onClick(); });
    expect(laptop.sent.filter((frame) => frame.type === "notice-answer")).toEqual([]);
    const [answer] = desk.sent.filter((frame) => frame.type === "notice-answer").map(parseNoticeAnswer);
    if (answer?.answer !== "not_me") throw new TypeError("Missing remote notice answer");
    expect(delivered).toEqual(answer.blocks);
    expect(card.findAllByType("li").map((row) => row.children.join("")).sort()).toEqual([
      "Desk: waiting for its answer", "Laptop: blocked",
    ]);
  });
});

it("T51: signing out hides Not me on an open admission without a fresh notice", async () => {
  await withDeviceNotices({ no: 3 }, async ({ tree }) => {
    const card = tree.root.findByProps({ "data-testid": "device-notice" });
    const actions = () => card.findAllByType("button").filter((node) => node.children.includes("Not me"));
    expect(actions()).toHaveLength(1);
    await act(async () => { await indexedAccountService.signOut(); });
    expect(await indexedAccountService.session()).toBeUndefined();
    expect(actions()).toHaveLength(0);
  });
});

it("T53: an open admission offers Not me but does not offer early approval", async () => {
  await withDeviceNotices({ no: 3 }, ({ tree }) => {
    const card = tree.root.findByProps({ "data-testid": "device-notice" });
    const actionLabels = card.findAllByType("button").flatMap((button) => button.children.filter((child) => typeof child === "string"));
    expect(actionLabels).toEqual([translate("en", "Not me")]);
  });
});

it("T71, T72: a delayed decline reply cannot restore a key removed by a newer PC event", async () => {
  const reply = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  await withDeviceNotices({ decline: () => { started.resolve(); return reply.promise; } }, async ({ tree, laptop }) => {
    const first: PendingKey = { id: "first", label: "Phone", fingerprint: "AB12-CD34", via: "relay", redeemed_at: "2026-11-20T04:00:00.000Z", slots: { used: 1, of: 5 } };
    const second: PendingKey = { ...first, id: "second", label: "Tablet" };
    const declines = () => tree.root.findAllByType("button").filter((button) => button.children.includes("Decline"));
    await act(async () => {
      laptop.snapshot([DEVICE_NOTICE_FEATURE, "machine-events"]);
      laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [first, second] } });
    });
    const [decline] = declines();
    expect(declines()).toHaveLength(2);
    if (decline === undefined) throw new TypeError("Missing Decline button");
    await act(async () => { decline.props.onClick(); await started.promise; });

    await act(async () => { laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [] } }); });
    expect(declines()).toHaveLength(0);
    await act(async () => { reply.resolve(Response.json({ pending: [second] })); });
    expect(declines()).toHaveLength(0);
  });
});

it("T71, T72: losing drive clears the waiting keys without needing another PC event", async () => {
  let role: DeviceRole = "drive";
  await withDeviceNotices({ role: () => role }, async ({ tree, laptop }) => {
    const pending: PendingKey = { id: "waiting", label: "Phone", fingerprint: "AB12-CD34", via: "relay", redeemed_at: "2026-11-20T04:00:00.000Z", slots: { used: 1, of: 5 } };
    const declines = () => tree.root.findAllByType("button").filter((button) => button.children.includes("Decline"));
    await act(async () => {
      laptop.snapshot([DEVICE_NOTICE_FEATURE, "machine-events"]);
      laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [pending] } });
    });
    expect(declines()).toHaveLength(1);

    await act(async () => { role = "watch"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(declines()).toHaveLength(0);
    await act(async () => { laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [pending] } }); });
    await act(async () => { role = "drive"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(declines()).toHaveLength(0);
  });
});
