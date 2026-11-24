import { afterEach, beforeEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { AccountService } from "../lib/account/service.ts";
import { memoryAccountStore, memoryLock } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountJoinRequests } from "./AccountJoinRequests.tsx";

const originals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  for (const [name, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("https://app.ovis.sh/"), localStorage: storage, sessionStorage: storage }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: () => ({ getPropertyValue: () => "" }), navigator: { languages: ["en"] }, localStorage: storage, sessionStorage: storage,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  for (const [name, old] of originals) { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); }
  originals.clear();
});

async function setup() {
  const account = "acct_1";
  const fake = new FakeAccountService();
  fake.opensAll = true;
  fake.completions = true;
  const store = memoryAccountStore();
  await store.set("session", { account, service: "https://account.ovis.sh", provider: "github", access_token: fake.issueToken(account, { twoStep: true }), refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
  const service = new AccountService({ store, lock: memoryLock(), fetch: fake.fetch });
  const { publicKey } = generateKeyPair();
  const serverId = deriveServerId(publicKey);
  const list = () => service.putPc(serverId, { label: "Desk", relay: "wss://relay.ovis.sh", public_key: bytesToHex(publicKey) });
  await list();
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(AccountJoinRequests, { service, devices: async () => [] }) })); });
  const cards = () => renderer!.root.findAll((node) => node.props["data-join-request"] === serverId).length;
  expect(cards()).toBe(1);
  const decline = async () => { await act(async () => { renderer!.root.findAllByType("button").find((node) => node.children.includes("Decline"))!.props.onClick(); }); };
  return { service, list, serverId, decline, cards };
}

test("an already open approving page shows an explicit new request after declining the old one", async () => {
  const { list, decline, cards, service } = await setup();
  await decline();
  expect(await service.listPcs()).toHaveLength(0);
  expect(cards()).toBe(0);
  await list();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(await service.listPcs()).toHaveLength(1);
  expect(cards(), "cards for the new request after refocus").toBe(1);
});

test("declining a stale request does not remove a PC another window already admitted", async () => {
  const { decline, cards, service, serverId } = await setup();
  await service.admitPc(serverId);
  expect((await service.listPcs())[0]?.admitted_at).toEqual(expect.any(String));
  expect(cards()).toBe(1);
  await decline();
  expect((await service.listPcs()).length, "admitted PCs left after a stale Decline").toBe(1);
});
