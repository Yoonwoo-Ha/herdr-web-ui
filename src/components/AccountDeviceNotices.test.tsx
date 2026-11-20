import { afterEach, expect, it, jest, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import { parseSafetyRecord, type BlockRecord } from "../../shared/account-records.ts";
import { indexedAccountStore, memoryAccountStore, newKey, type AccountSession } from "../lib/account/store.ts";
import { DeviceNoticeWire, deviceNotice } from "../lib/deviceNoticeWire.fixture.ts";
import { MachineSession, MachineSessionRegistry } from "../lib/machineSession.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HerdrSocket } from "../lib/ws.ts";
import { ACCOUNT_SIGN_OUT_EVENT } from "../lib/account/service.ts";
import { useAccountDeviceNotices } from "./AccountDeviceNotices.tsx";

it.each([
  ["T51, T60: retry the exact signed block after a lost response", "lost response"],
  ["T51, T60: retry the exact signed block after a 503 after dismissal", "503 after dismissal"],
  ["T51, T60: retry the exact signed block after a wrong record ID", "wrong record ID"],
  ["T51, T60, T65: show unopened and flag-off roster PCs without posting to them", "roster"],
  ["T51, T60, T65: a flag-off route outranks an unopened route to the same PC listed after it", "roster twin after"],
  ["T51, T60, T65: a flag-off route outranks an unopened route to the same PC listed before it", "roster twin before"],
] as const)("%s", async (_title, failure) => {
  const showRoster = failure.startsWith("roster");
  const dismissWhilePending = failure === "503 after dismissal";
  const notice = deviceNotice({ key: (await newKey()).public_spki });
  const wire = new DeviceNoticeWire("ws://localhost/ws");
  const events = new EventTarget();
  const posted: BlockRecord[] = [];
  const pcPosts: string[] = [];
  const onPc: string[] = [];
  const started = Promise.withResolvers<void>();
  const pendingReply = Promise.withResolvers<Response>();
  const serverId = "a".repeat(32);
  const roster = [
    { id: "study", name: "Study", server_id: "b".repeat(32) },
    { id: "studio", name: "Studio", server_id: "c".repeat(32) },
    { id: "lab", name: "Lab", server_id: "d".repeat(32) },
  ] as const;
  const machines: readonly Machine[] = [
    { id: LOCAL_MACHINE, name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null },
    ...(showRoster ? [
      ...(failure === "roster twin before" ? [{ id: "lab-relay", name: "Lab", server_id: "d".repeat(32) }] : []),
      ...roster,
      ...(failure === "roster twin after" ? [{ id: "lab-relay", name: "Lab", server_id: "d".repeat(32) }] : []),
      { id: "other", name: "Other", server_id: "e".repeat(32) },
    ].map((machine): Machine => ({
      ...machine, kind: "relay", enabled: true, state: "connected", error: null, snapshot: null,
    })) : []),
  ];
  const wires = new Map([
    [wire.url, wire],
    ...(["studio", "lab"] as const).map(id => [`ws://localhost/ws?pc=${id}`, new DeviceNoticeWire(`ws://localhost/ws?pc=${id}`)] as const),
  ]);
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
    WebSocket: class {
      constructor(url: string) {
        const connection = wires.get(url);
        if (connection === undefined) throw new Error(`Unexpected WebSocket: ${url}`);
        return connection;
      }
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const get = spyOn(indexedAccountStore, "get").mockImplementation(store.get);
  const update = spyOn(indexedAccountStore, "update").mockImplementation(store.update);
  const postBlock: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url === `${session.service}/v1/pcs` && init?.method === "GET") {
      return Response.json({ pcs: showRoster ? [...roster, { id: "attic", name: "Attic", server_id: "f".repeat(32) }].map(row => ({
        server_id: row.server_id, label: row.name, added_at: new Date(0).toISOString(), last_seen_at: null,
      })) : [] });
    }
    if (url.startsWith("/api/machines/") && init?.method === "POST") {
      pcPosts.push(url);
      const record = parseSafetyRecord(JSON.parse(String(init.body)).records[0]);
      return Response.json({ receipts: [{ outcome: "applied", id: record.id, n: 2 }] });
    }
    expect(url).toBe(`${session.service}/v1/safety-records`);
    const record = parseSafetyRecord(JSON.parse(String(init?.body)).record);
    if (record.kind !== "block") throw new TypeError("Expected a block");
    posted.push(record);
    if (posted.length === 1) {
      started.resolve();
      switch (failure) {
        case "503 after dismissal": return pendingReply.promise;
        case "wrong record ID": return Response.json({ id: "another-record" });
        case "lost response": throw new TypeError("The account response was lost");
        case "roster": case "roster twin after": case "roster twin before": break;
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
  const machineSessions = new MachineSessionRegistry((id) => new MachineSession(id, {
    socket: id === LOCAL_MACHINE ? socket : new HerdrSocket(`ws://localhost/ws?pc=${id}`),
  }));
  function Probe() {
    return useAccountDeviceNotices({ machines, machineSessions, selectedMachineId: LOCAL_MACHINE, pageServerId: serverId });
  }
  let renderer: ReactTestRenderer | undefined;
  try {
    machineSessions.get(LOCAL_MACHINE);
    if (showRoster) {
      for (const [id, capable] of [["studio", true], ["lab", false]] as const) {
        const remote = machineSessions.get(id).socket;
        remote.connect();
        const connection = wires.get(`ws://localhost/ws?pc=${id}`);
        if (connection === undefined) throw new Error(`Missing wire for ${id}`);
        connection.open();
        if (capable) connection.snapshot(); else connection.snapshot([]);
      }
    }
    await act(async () => { renderer = create(<SettingsProvider><Probe /></SettingsProvider>); });
    socket.connect();
    wire.open();
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice }); });
    const root = renderer?.root;
    if (root === undefined) throw new TypeError("Missing notice view");
    const button = (label: string) => root.findAllByType("button").find((node) => node.children.includes(label));

    const notMe = button("Not me");
    if (notMe === undefined) throw new TypeError("Missing Not me button");
    if (showRoster) {
      await act(async () => { await notMe.props.onClick(); });
      expect(pcPosts).toEqual(["/api/machines/studio/account/records"]);
      const lines = root.findAllByType("li").map(node => node.children.join(""));
      expect(lines).toContain("Study: not reached; it applies the block at its next check");
      expect(lines).toContain("Lab: needs an Ovis update to block");
      expect(lines.filter(line => line.startsWith("Lab:"))).toHaveLength(1);
      // a PC of the account this browser has never listed is still named, and still gets no request
      expect(lines).toContain("Attic: not reached; it applies the block at its next check");
      expect(lines.some(line => line.startsWith("Other:"))).toBe(false);
      return;
    }
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

const itsMeMachines: readonly Machine[] = [
  { id: "local", name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null },
  { id: "lab", name: "Lab", kind: "relay", enabled: true, state: "connected", error: null, snapshot: null },
];

let itsMeRenderer: ReactTestRenderer | undefined;
let sessions: MachineSessionRegistry | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();

afterEach(async () => {
  await act(async () => { itsMeRenderer?.unmount(); });
  itsMeRenderer = undefined;
  sessions?.retainMachines(new Set());
  sessions = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
  for (const [key, old] of globals) {
    if (old) Object.defineProperty(globalThis, key, old);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

const itsMeSession = {
  service: "https://account.ovis.sh", account: "acct", provider: "github",
  access_token: "access", refresh_token: "refresh", sign_in_id: "this-sign-in",
} as const;

async function setupItsMe({
  session = { ...itsMeSession, expires_at: Date.now() + 60_000 },
  admission = deviceNotice({ row: "new-phone" }),
  localOnly = false,
  seed = true,
}: {
  readonly session?: AccountSession;
  readonly admission?: ReturnType<typeof deviceNotice>;
  readonly localOnly?: boolean;
  readonly seed?: boolean;
} = {}) {
  jest.useFakeTimers();
  const desk = new DeviceNoticeWire("ws://localhost/ws?pc=desk");
  const lab = new DeviceNoticeWire("ws://localhost/ws?pc=lab");
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    WebSocket: class { constructor(url: string) { return url === desk.url ? desk : lab; } },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const store = memoryAccountStore();
  await store.set("session", session);
  if (!localOnly && session.sign_in_id !== undefined) {
    await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id, no: 1, key: await newKey() });
  }
  spyOn(indexedAccountStore, "get").mockImplementation(store.get);
  const registry = new MachineSessionRegistry((id) => new MachineSession(id, { socket: new HerdrSocket(id === "local" ? desk.url : lab.url) }));
  sessions = registry;
  const machines = localOnly ? itsMeMachines.filter(({ id }) => id === "local") : itsMeMachines;
  for (const machine of machines) registry.get(machine.id).socket.connect();
  desk.open();
  if (!localOnly) lab.open();
  function Notices({ selected }: { selected: string }) {
    return useAccountDeviceNotices({ machines, machineSessions: registry, selectedMachineId: selected, pageServerId: undefined });
  }
  await act(async () => { itsMeRenderer = create(<SettingsProvider><Notices selected="local" /></SettingsProvider>); });
  const view = itsMeRenderer;
  if (view === undefined) throw new TypeError("Missing notice view");
  const select = (selected: string) => act(async () => { view.update(<SettingsProvider><Notices selected={selected} /></SettingsProvider>); });
  const actions = () => view.root.findAll((node) => node.type === "button" && node.children.includes("It's me"));
  const button = () => view.root.find((node) => node.type === "button" && node.children.includes("It's me"));
  const refusal = () => view.root.findAll((node) => node.type === "p" && node.children.includes("Desk did not accept It's me from this device."));
  const answers = (wire = desk) => wire.sent.filter(({ type }) => type === "notice-answer");
  if (seed) await act(async () => {
    desk.snapshot();
    desk.read({ type: "device-notice", notice: admission });
    if (!localOnly) {
      lab.snapshot();
      lab.read({ type: "device-notice", notice: admission });
    }
  });
  return { desk, lab, session, store, view, admission, select, actions, button, refusal, answers };
}

it("T53, T57: It's me uses only the admission PC's socket and retries only until that PC confirms", async () => {
  const fetched = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(null, { status: 500 }), { preconnect: fetch.preconnect }));
  const { desk, lab, view, admission, select, actions, answers } = await setupItsMe({ seed: false });
  const confirmation = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
  const answer = { type: "notice-answer", id: admission.id, answer: "its_me" };

  await act(async () => {
    desk.snapshot();
    lab.snapshot();
    desk.read({ type: "device-notice", notice: deviceNotice({ ...admission, account: "another-account" }) });
  });
  expect(actions()).toHaveLength(0);
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  expect(actions()).toHaveLength(1);
  const [button] = actions();
  if (button === undefined) throw new TypeError("Missing admission action");
  await act(async () => { button.props.onClick(); });
  expect(button.props.disabled).toBe(true);
  expect(answers(desk)).toEqual([answer]);
  // away to Lab and back while it is out: still one answer out for this PC's notice
  await select("lab");
  await select("local");
  const [again] = actions();
  expect(again?.props.disabled).toBe(true);
  const notMe = view.root.find((node) => node.type === "button" && node.children.includes("Not me"));
  expect(notMe.props.disabled).toBe(true);
  await act(async () => { await Promise.all([again?.props.onClick(), notMe.props.onClick()]); });
  expect(answers(desk)).toEqual([answer]);
  expect(answers(lab)).toEqual([]);
  await act(async () => { lab.read({ type: "device-notice", notice: confirmation }); jest.advanceTimersByTime(5_000); });
  expect(answers(desk)).toEqual([answer, answer]);
  expect(answers(lab)).toEqual([]);
  await act(async () => { desk.read({ type: "device-notice", notice: confirmation }); });
  expect(actions()).toHaveLength(0);
  await act(async () => { jest.advanceTimersByTime(10_000); });
  expect(answers(desk)).toEqual([answer, answer]);
  expect(fetched.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("records"))).toEqual([]);
});

it.each([
  ["a confirm for another admission on the same PC leaves it waiting, and it is sent once more", "other", 2],
  ["a confirm on the first try sends it no second time", "first", 1],
] as const)("T53, P15: %s; no attempt goes to a records route", async (_name, reply, sentTimes) => {
  const fetched = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(null, { status: 500 }), { preconnect: fetch.preconnect }));
  const { desk, view, admission, button: findButton, answers } = await setupItsMe({ localOnly: true });
  const confirm = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false, ...(reply === "other" ? { row: "another-phone" } : {}) });
  const button = findButton();
  await act(async () => { button.props.onClick(); });
  await act(async () => { desk.read({ type: "device-notice", notice: confirm }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(sentTimes);
  // another admission's confirm leaves this card where it was; this one's own closes it
  expect(view.root.findAllByProps({ "data-testid": "device-notice" })).toHaveLength(reply === "other" ? 1 : 0);
  if (reply === "other") expect(button.props.disabled).toBe(false);
  fetched.mockRestore();
});

it("T53: an It's me refusal survives switching PCs and clears on the next press", async () => {
  const { desk, view, admission, select, button, refusal, answers } = await setupItsMe();
  const notMe = () => view.root.find((node) => node.type === "button" && node.children.includes("Not me"));
  await act(async () => { button().props.onClick(); });
  expect(refusal()).toHaveLength(0);
  // one answer at a time per notice: Not me waits while It's me is out
  expect(notMe().props.disabled).toBe(true);
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(2);
  expect(refusal()).toHaveLength(0);
  // away to Lab while Desk still waits: Desk's last wait ends there, and its refusal is not Lab's
  await select("lab");
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(button().props.disabled).toBe(false);
  expect(view.root.findAllByProps({ className: "settings-hint its-me-refused" })).toHaveLength(0);
  await select("local");
  expect(refusal()).toHaveLength(1);
  expect(button().props.disabled).toBe(false);
  expect(notMe().props.disabled).toBe(false);
  await act(async () => { button().props.onClick(); });
  expect(refusal()).toHaveLength(0);
  expect(answers()).toHaveLength(3);
  // decided on that PC another way meanwhile: its silence is no refusal, through both waits
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(refusal()).toHaveLength(0);
  expect(view.root.findAll((node) => node.type === "button" && node.children.includes("It's me"))).toHaveLength(0);
});

it.each([
  ["a sign-out and a sign-in to the same account after the refusal", "after"],
  ["a new sign-in that began while the request still waited", "during"],
] as const)("T53: an It's me refusal belongs to its sign-in: %s shows none", async (_name, when) => {
  const { session, store, button, refusal } = await setupItsMe();
  const signInAgain = async () => {
    await store.set("session", { ...session, refresh_token: "refresh-2", sign_in_id: "a-later-sign-in" });
    window.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
  };
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  if (when === "during") await act(async () => { await signInAgain(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  if (when === "after") {
    expect(refusal()).toHaveLength(1);
    await act(async () => { await signInAgain(); });
  }
  expect(refusal()).toHaveLength(0);
});

it("S2P-6: a refusal goes with its notice even while another PC is shown: the same id opened again shows none", async () => {
  const { desk, admission, select, button, refusal } = await setupItsMe();
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(refusal()).toHaveLength(1);
  await select("lab");
  // decided on Desk while Lab is shown, then the same notice id opened there again
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await select("local");
  expect(refusal()).toHaveLength(0);
});

it("S2P-6: an It's me still out when its notice closes records no refusal, also once the same id opens again", async () => {
  const { desk, admission, select, button, refusal } = await setupItsMe();
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await select("lab");
  // closed on Desk and opened again while the answer was still out, then its last wait ends
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await select("local");
  expect(refusal()).toHaveLength(0);
});

it("S2P-7: reopening offscreen releases the old press without letting it unlock the new press", async () => {
  const { desk, lab, admission, select, button, answers } = await setupItsMe();
  const answer = { type: "notice-answer", id: admission.id, answer: "its_me" };
  await act(async () => { button().props.onClick(); });
  expect(answers()).toEqual([answer]);
  await act(async () => { jest.advanceTimersByTime(1_000); });
  await select("lab");
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await select("local");
  expect(button().props.disabled).toBe(false);
  await act(async () => { button().props.onClick(); });
  expect(answers()).toEqual([answer, answer]);

  // Only the first press's deadline has passed. The second press still owns the lock.
  await act(async () => { jest.advanceTimersByTime(4_000); });
  expect(button().props.disabled).toBe(true);
  expect(answers()).toEqual([answer, answer]);
  expect(answers(lab)).toEqual([]);
  const confirmation = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
  await act(async () => { desk.read({ type: "device-notice", notice: confirmation }); });
});

it("S2P-7: a closed press sends no retry, even after its notice reopens", async () => {
  const { desk, admission, button, answers } = await setupItsMe();
  await act(async () => { button().props.onClick(); });
  expect(answers()).toHaveLength(1);
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(1);
});

it.each([
  ["S2P-8: a close and reopen in one render batch drops the old refusal", "batched", "a".repeat(32)],
  ["S2P-L3: closing a notice with a colon in its ID drops only that notice's refusal", "separate", "admission:phone"],
] as const)("%s", async (_title, delivery, id) => {
  const { desk, lab, admission, select, button, refusal } = await setupItsMe({ admission: deviceNotice({ id, row: "new-phone" }) });
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(refusal()).toHaveLength(1);
  await select("lab");
  expect(button().props.disabled).toBe(false);
  if (delivery === "separate") {
    await act(async () => { button().props.onClick(); });
    expect(button().props.disabled).toBe(true);
  }
  const close = () => desk.read({ type: "device-notice", notice: { ...admission, open: false } });
  const reopen = () => desk.read({ type: "device-notice", notice: admission });
  if (delivery === "batched") {
    await act(async () => { close(); reopen(); });
  } else {
    await act(async () => { close(); });
    await act(async () => { reopen(); });
    expect(button().props.disabled).toBe(true);
    const confirmation = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
    await act(async () => { lab.read({ type: "device-notice", notice: confirmation }); });
  }
  await select("local");
  expect(refusal()).toHaveLength(0);
  expect(button().props.disabled).toBe(false);
});

it.each([
  ["a different sign-in ID with the same refresh token", { ...itsMeSession }, { ...itsMeSession, sign_in_id: "a-later-sign-in" }],
  ["neither a sign-in ID nor a refresh token", {
    service: itsMeSession.service, account: itsMeSession.account, provider: itsMeSession.provider, access_token: "access", refresh_token: "",
  }, undefined],
] as const)("S2P-L2: records no refusal for %s", async (_name, initial, replacement) => {
  const expires_at = Date.now() + 60_000;
  const { session, store, button, refusal, answers } = await setupItsMe({ session: { ...initial, expires_at } });
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(2);
  if (replacement !== undefined) await act(async () => {
    await store.set("session", { ...replacement, expires_at });
    window.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
  });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(button().props.disabled).toBe(false);
  if (replacement !== undefined) await act(async () => {
    await store.set("session", session);
    window.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
  });
  expect(refusal()).toHaveLength(0);
});
