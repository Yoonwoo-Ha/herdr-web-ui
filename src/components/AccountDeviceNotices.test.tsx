import { expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import { parseSafetyRecord, type BlockRecord } from "../../shared/account-records.ts";
import { indexedAccountStore, memoryAccountStore, newKey } from "../lib/account/store.ts";
import { DeviceNoticeWire, deviceNotice } from "../lib/deviceNoticeWire.fixture.ts";
import { MachineSession, MachineSessionRegistry } from "../lib/machineSession.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HerdrSocket } from "../lib/ws.ts";
import { useAccountDeviceNotices } from "./AccountDeviceNotices.tsx";

it.each(["lost response", "503 after dismissal", "wrong record ID"] as const)("T51, T60: retry the exact signed block after %s", async (failure) => {
  const dismissWhilePending = failure === "503 after dismissal";
  const notice = deviceNotice({ key: (await newKey()).public_spki });
  const wire = new DeviceNoticeWire("ws://localhost/ws");
  const events = new EventTarget();
  const posted: BlockRecord[] = [];
  const onPc: string[] = [];
  const started = Promise.withResolvers<void>();
  const pendingReply = Promise.withResolvers<Response>();
  const serverId = "a".repeat(32);
  const machines: readonly Machine[] = [{ id: LOCAL_MACHINE, name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null }];
  const session = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "test", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600_000 } as const;
  const store = memoryAccountStore();
  await store.set("session", session);
  await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id, no: 1, key: await newKey() });
  const replaced = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: Object.assign(events, { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    WebSocket: class { constructor() { return wire; } },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const get = spyOn(indexedAccountStore, "get").mockImplementation(store.get);
  const update = spyOn(indexedAccountStore, "update").mockImplementation(store.update);
  const postBlock: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).toBe(`${session.service}/v1/safety-records`);
    const record = parseSafetyRecord(JSON.parse(String(init?.body)).record);
    if (record.kind !== "block") throw new TypeError("Expected a block");
    posted.push(record);
    if (posted.length === 1) {
      started.resolve();
      switch (failure) {
        case "503 after dismissal": return pendingReply.promise;
        case "wrong record ID": return Response.json({ id: "another-record" });
        case "lost response": throw new TypeError("The account response was lost");
      }
    }
    return Response.json({ id: record.id });
  }, { preconnect: fetch.preconnect });
  const post = spyOn(globalThis, "fetch").mockImplementation(postBlock);
  const send = spyOn(wire, "send").mockImplementation((message) => {
    DeviceNoticeWire.prototype.send.call(wire, message);
    const outgoing = JSON.parse(message);
    if (outgoing.type !== "notice-answer") return;
    const record = parseSafetyRecord(outgoing.blocks[0]);
    onPc.push(record.id);
    wire.read({ type: "notice-answer-result", id: notice.id, receipts: [{ outcome: "applied", id: record.id, n: 2 }] });
  });
  const socket = new HerdrSocket(wire.url);
  const machineSessions = new MachineSessionRegistry((id) => new MachineSession(id, { socket }));
  function Probe() {
    return useAccountDeviceNotices({ machines, machineSessions, selectedMachineId: LOCAL_MACHINE, pageServerId: serverId });
  }
  let renderer: ReactTestRenderer | undefined;
  try {
    machineSessions.get(LOCAL_MACHINE);
    await act(async () => { renderer = create(<SettingsProvider><Probe /></SettingsProvider>); });
    socket.connect();
    wire.open();
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice }); });
    const root = renderer?.root;
    if (root === undefined) throw new TypeError("Missing notice view");
    const button = (label: string) => root.findAllByType("button").find((node) => node.children.includes(label));

    const notMe = button("Not me");
    if (notMe === undefined) throw new TypeError("Missing Not me button");
    if (dismissWhilePending) {
      let delivery: Promise<void> | undefined;
      await act(async () => { delivery = notMe.props.onClick(); await started.promise; });
      await act(async () => { root.findByProps({ "aria-label": "Dismiss" }).props.onClick(); });
      expect(root.findAllByProps({ "data-testid": "device-notice" })).toHaveLength(0);
      await act(async () => { pendingReply.resolve(new Response(null, { status: 503 })); await delivery; });
      expect(root.findAllByProps({ "data-testid": "device-notice" })).toHaveLength(0);
    } else {
      await act(async () => { await notMe.props.onClick(); });
      expect(root.findAllByProps({ "data-state": "applied" })).toHaveLength(1);
    }
    expect(root.findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(1);

    // The PC already applied the block. Its decision and a disconnected notice feed must not drop the account retry.
    await act(async () => { wire.read({ type: "device-notice", notice: { ...notice, open: false } }); wire.close(); });
    const retry = button("Try again");
    if (retry === undefined) throw new TypeError("Missing account retry");
    await act(async () => { await retry.props.onClick(); });

    const [pcRecordId] = onPc;
    if (pcRecordId === undefined) throw new TypeError("The PC did not receive a block");
    expect(posted.map((record) => record.id)).toEqual([pcRecordId, pcRecordId]);
    expect(posted[0]).toEqual(posted[1]);
    expect(onPc).toHaveLength(1);
    expect(root.findAllByProps({ "data-state": "applied" })).toHaveLength(dismissWhilePending ? 0 : 1);
    expect(root.findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
    expect(button("Try again")).toBeUndefined();
  } finally {
    await act(async () => { renderer?.unmount(); });
    machineSessions.closeAll();
    send.mockRestore();
    post.mockRestore();
    update.mockRestore();
    get.mockRestore();
    for (const [key, descriptor] of replaced) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
