import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { RemotePairingRequest } from "../../shared/protocol.ts";
import * as Api from "../lib/api.ts";
import * as Join from "../lib/account/join.ts";
import * as Service from "../lib/account/service.ts";
import * as Store from "../lib/account/store.ts";
import * as Vouched from "../lib/account/vouched-pc.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { AccountApprovalPromptProps } from "./AccountApprovalPrompt.tsx";

const SESSION = { account: "acct", service: "https://account.example", provider: "github", sign_in_id: "s", access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };
let shown: AccountApprovalPromptProps | null = null;
let approveFails = 0;
const decided: string[] = [];

await mock.module("./AccountApprovalPrompt.tsx", () => ({ AccountApprovalPrompt: (props: AccountApprovalPromptProps) => { shown = props; return null; } }));
await mock.module("../lib/api.ts", () => ({ ...Api, decideRelayPairing: async (_id: string, answer: string) => { decided.push(answer); } }));
await mock.module("../lib/account/vouched-pc.ts", () => ({ ...Vouched, vouchedPcName: async () => "Desk" }));
await mock.module("../lib/account/join.ts", () => ({ ...Join,
  vouchedAdmission: () => ({ server_id: "p".repeat(32) }),
  approveJoin: async () => { if (approveFails > 0) { approveFails--; throw new Error("503 from the service"); } decided.push("approve"); },
}));
await mock.module("../lib/account/store.ts", () => ({ ...Store, indexedAccountStore: { ...Store.indexedAccountStore, key: async () => ({ public_spki: "my-key" }) } }));
class FakeService {
  async session() { return SESSION; }
  forSignIn() { return this; }
  async recentAdmissions() { return []; }
}
await mock.module("../lib/account/service.ts", () => ({ ...Service, AccountService: FakeService, accountServiceOf: () => SESSION.service }));
const { VouchedPcApproval } = await import("./VouchedPcApproval.tsx");

let renderer: ReactTestRenderer | undefined;
const request = { id: "req-1", key: "device-key", proven_server_id: "p".repeat(32), vouched: true } as unknown as RemotePairingRequest;
const settle = async (): Promise<void> => { for (let round = 0; round < 10; round++) await act(async () => {}); };

const globals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  for (const [name, value] of Object.entries({
    IS_REACT_ACT_ENVIRONMENT: true,
    window: Object.assign(new EventTarget(), { location: new URL("https://pc.example/"), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }),
    navigator: { languages: ["en"] },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globals.clear();
  renderer = undefined;
  shown = null;
  decided.length = 0;
});

it("offers Allow again once the PC is verified anew after an Allow that failed, and still Denies", async () => {
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(VouchedPcApproval, { request, through: "t".repeat(32) }) })); });
  await settle();
  expect(shown?.vouchedName).toBe("Desk");
  approveFails = 1;
  let failed: unknown;
  await act(async () => { await shown!.onDecide("approve").catch((error: unknown) => { failed = error; }); });
  expect(failed).toBeInstanceOf(Error);
  expect(decided).toEqual([]);
  await settle();
  expect(shown?.vouchedName).toBe("Desk");
  await act(async () => { await shown!.onDecide("approve"); });
  expect(decided).toEqual(["approve"]);
});
