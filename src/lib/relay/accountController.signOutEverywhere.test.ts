import { createShellTestPage } from "./shell.test.tsx";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";

import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import type { ShellDeviceStore } from "./device.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { shellAccountActions } from "../account/hostedSignIn.ts";

const SERVICE = "https://account.ovis.sh";
const ACCOUNT = "acct-test";

async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}

describe("signing out every device from the hosted shell", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let rendered: ReactElement[];
  beforeEach(() => { browser = createShellTestPage(); rendered = []; });
  afterEach(() => { browser.dispose(); });

  const noDevices: ShellDeviceStore = {
    async get() { return undefined; }, async list() { return []; }, async remove() {}, async removeRow() { return false; },
    async update(_serverId, change) { return change(undefined); },
  };
  const shellProps = (element: ReactElement): RelayShellProps => {
    let node = element;
    while (node.type !== RelayShell) node = (node.props as { children: ReactElement }).children;
    return node.props as RelayShellProps;
  };
  const accountView = () => { const { state } = shellProps(rendered.at(-1)!); return state.kind === "list" || state.kind === "empty" ? state.account ?? null : null; };
  const signedOutAt = async (fake: FakeAccountService, token: string): Promise<boolean> =>
    (await fake.fetch(new Request(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${token}` } }))).status === 401;

  async function shell(fake: FakeAccountService, accountStore: ReturnType<typeof memoryAccountStore>, extra: Partial<RelayShellMount> = {}): Promise<void> {
    await mountRelayShell({
      container: {} as HTMLElement, entryUrl: "https://app.ovis.sh/", shellVersion: "0.0.0-test", label: "Test phone",
      renderApp: () => { throw new Error("the app is not expected here"); },
      createRoot: () => ({ render(element: ReactElement) { rendered.push(element); }, unmount() {} }),
      open: () => Promise.reject(new Error("no connection is expected here")),
      checkPc: async () => ({ kind: "offline", reason: "relay" }),
      reload: async () => {},
      accountService: SERVICE, accountProviders: ["github", "apple"], accountStore, store: noDevices,
      accountFetch: (input, init) => fake.fetch(input, init),
      ...extra,
    });
  }

  async function signedInShell(clock: () => number = Date.now, provider: "github" | "apple" = "github", extra: Partial<RelayShellMount> = {}) {
    const fake = new FakeAccountService(clock);
    const accountStore = memoryAccountStore();
    const mine = fake.issueToken(ACCOUNT);
    await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider, access_token: mine, refresh_token: "refresh", expires_at: clock() + 3_600_000 });
    // the account's other sign-ins: another browser, and a PC's device code
    const elsewhere = [fake.issueToken(ACCOUNT), fake.issueToken(ACCOUNT, { device: true })];
    const other = fake.issueToken("acct-other");
    await shell(fake, accountStore, extra);
    await until(() => accountView()?.kind === "signed-in", "the signed-in front page");
    return { fake, accountStore, mine, elsewhere, other };
  }

  it("ends every sign-in of the account at the service, this device's too, and says so", async () => {
    const { fake, accountStore, mine, elsewhere, other } = await signedInShell();
    expect(await shellAccountActions()?.signOutEverywhere()).toBeNull();
    for (const token of [mine, ...elsewhere]) expect(await signedOutAt(fake, token)).toBe(true);
    expect(await signedOutAt(fake, other)).toBe(false);
    expect(await accountStore.get("session")).toBeUndefined();
    expect(accountView()).toEqual({ kind: "signed-out", error: null, notice: "Every device was signed out." });
  });

  it("in a browser whose sign-in is over ten minutes old, signs in again first, and its return signs every device out", async () => {
    let now = Date.now();
    const redirected = Promise.withResolvers<string>();
    const { fake, accountStore, elsewhere } = await signedInShell(() => now, "github", { openSignIn: (url) => { redirected.resolve(url); } });
    now += 11 * 60_000;
    expect(await shellAccountActions()?.signOutEverywhere()).toBeNull();
    const signInAt = await redirected.promise;
    expect(await signedOutAt(fake, elsewhere[0]!)).toBe(false);
    fake.signInAs("github", ACCOUNT);
    const back = (await fake.fetch(signInAt)).headers.get("location")!;
    rendered = [];
    await shell(fake, accountStore, { entryUrl: back });
    await until(() => accountView()?.kind === "signed-out", "the signed-out front page");
    for (const token of elsewhere) expect(await signedOutAt(fake, token)).toBe(true);
    expect(fake.requests.filter((line) => line === "POST /v1/signout/all")).toHaveLength(2);
    expect(await accountStore.get("session")).toBeUndefined();
    expect(accountView()).toEqual({ kind: "signed-out", error: null, notice: "Every device was signed out." });
  });

  it("signs nothing out when the browser's fresh sign-in comes back for another account", async () => {
    let now = Date.now();
    const redirected = Promise.withResolvers<string>();
    const { fake, accountStore, elsewhere } = await signedInShell(() => now, "github", { openSignIn: (url) => { redirected.resolve(url); } });
    now += 11 * 60_000;
    await shellAccountActions()?.signOutEverywhere();
    const signInAt = await redirected.promise;
    fake.signInAs("github", "acct-two");
    const back = (await fake.fetch(signInAt)).headers.get("location")!;
    rendered = [];
    await shell(fake, accountStore, { entryUrl: back });
    await until(() => accountView()?.kind === "signed-in", "the signed-in front page");
    expect(fake.requests.filter((line) => line === "POST /v1/signout/all")).toHaveLength(1);
    expect(await signedOutAt(fake, elsewhere[0]!)).toBe(false);
    expect((await accountStore.get("session"))?.account).toBe("acct-two");
  });

  it("says so and keeps this device signed in when the service could not do it", async () => {
    const { fake, accountStore } = await signedInShell(Date.now, "github", {
      accountFetch: async (input, init) => new URL(new Request(input, init).url).pathname === "/v1/signout/all"
        ? Response.json({ error: { code: "unavailable", message: "down" } }, { status: 503 }) : fake.fetch(input, init),
    });
    expect(await shellAccountActions()?.signOutEverywhere()).toBe("Could not sign out every device. Try again.");
    expect((await accountStore.get("session"))?.account).toBe(ACCOUNT);
    expect(accountView()?.kind).toBe("signed-in");
  });

  describe("in the phone app, with a sign-in over ten minutes old", () => {
    const savedFetch = globalThis.fetch;
    afterEach(() => { Reflect.deleteProperty(globalThis, "Capacitor"); globalThis.fetch = savedFetch; });
    const nativeSignInTo = (fake: FakeAccountService, to: string): Promise<void> => {
      const tokened = Promise.withResolvers<void>();
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }], nativePromise: async () => ({ idToken: "apple-id-token" }) } });
      globalThis.fetch = Object.assign(async () => { tokened.resolve(); return Response.json({ access_token: fake.issueToken(to), refresh_token: `refresh-${to}`, expires_in: 3600, account: to, provider: "apple" }); }, { preconnect: savedFetch.preconnect });
      return tokened.promise;
    };

    it("signs in again in place with the same method, then signs every device out", async () => {
      let now = Date.now();
      const { fake, accountStore, elsewhere } = await signedInShell(() => now, "apple");
      now += 11 * 60_000;
      const tokened = nativeSignInTo(fake, ACCOUNT);
      const done = shellAccountActions()?.signOutEverywhere();
      await tokened;
      expect(await done).toBeNull();
      for (const token of elsewhere) expect(await signedOutAt(fake, token)).toBe(true);
      expect(fake.requests.filter((line) => line === "POST /v1/signout/all")).toHaveLength(2);
      expect(await accountStore.get("session")).toBeUndefined();
      expect(accountView()).toEqual({ kind: "signed-out", error: null, notice: "Every device was signed out." });
    });

    it("signs nothing out when the sign-in again lands in another account", async () => {
      let now = Date.now();
      const { fake, accountStore, elsewhere } = await signedInShell(() => now, "apple");
      now += 11 * 60_000;
      void nativeSignInTo(fake, "acct-two");
      expect(await shellAccountActions()?.signOutEverywhere()).toBe("You signed in to another account. No device was signed out.");
      expect(fake.requests.filter((line) => line === "POST /v1/signout/all")).toHaveLength(1);
      expect(await signedOutAt(fake, elsewhere[0]!)).toBe(false);
      expect((await accountStore.get("session"))?.account).toBe(ACCOUNT);
    });
  });
});
