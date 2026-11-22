import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { FakeAccountService, PC_NEW_MS, WEB_REDIRECT } from "../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { isNewAccountPc, type MyPc } from "../lib/account/myPcs.ts";
import { AccountService } from "../lib/account/service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../lib/account/signin.ts";
import { memoryAccountStore, memoryLock, type AccountProvider, type AccountStore } from "../lib/account/store.ts";
import { accountOpenablePcs } from "../lib/relay/pcPick.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { keepShellAccount } from "../lib/account/hostedSignIn.ts";
import { UnconfirmedPcNotices } from "./UnconfirmedPcNotices.tsx";

const ORIGIN = "https://account.ovis.sh";
const ACCOUNT = "acct_owner";
const LABEL = "devswha-ThinkStation-P620";
const key = generateKeyPair().publicKey;
const PC = deriveServerId(key);
const MINUTE = 60_000;

const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let now = Date.now();
let fake: FakeAccountService;
let store: AccountStore;
let service: AccountService;
let signInsAgain: AccountProvider[] = [];

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map((node) => textOf(node).trim());
const press = async (label: string): Promise<void> => {
  const found = renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === label);
  if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`);
  await act(async () => { await found[0]!.props.onClick(); });
  await settle();
};
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const text = (): string => renderer === undefined ? "" : renderer.root.findAll((node) => node.type === "div").map(textOf).join(" ");

async function signIn(provider: AccountProvider = "github"): Promise<void> {
  fake.signInAs(provider, ACCOUNT);
  const start = await beginSignIn(provider, { store, service: ORIGIN, redirectUri: WEB_REDIRECT });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  await finishSignIn(returned, { store, fetch: fake.fetch });
}

/** a PC types its device code into the owner's account and lists itself: unconfirmed (PCL-1) */
async function listedByDeviceCode(): Promise<void> {
  const token = fake.issueToken(ACCOUNT, { device: true });
  const response = await fake.fetch(`${ORIGIN}/v1/pcs/${PC}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: LABEL, public_key: Buffer.from(key).toString("hex"), relay: "wss://relay.ovis.sh" }),
  });
  expect(response.ok).toBe(true);
}

/** another PC the account already has, listed by an own sign-in: the account is no longer never-used */
async function listedByItsOwnSignIn(): Promise<void> {
  const other = generateKeyPair().publicKey;
  const token = fake.issueToken(ACCOUNT);
  const response = await fake.fetch(`${ORIGIN}/v1/pcs/${deriveServerId(other)}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "Desk", public_key: Buffer.from(other).toString("hex"), relay: "wss://relay.ovis.sh" }),
  });
  expect(response.ok).toBe(true);
}

async function mount(): Promise<void> {
  if (renderer !== undefined) await act(async () => { renderer!.unmount(); });
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(UnconfirmedPcNotices, { service, now: () => now, onSignInAgain: (provider: AccountProvider) => { signInsAgain.push(provider); } }) }));
  });
  await settle();
}

beforeEach(async () => {
  const events = new EventTarget();
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } });
  for (const [name, value] of Object.entries({
    window: Object.assign(events, { location: new URL("https://app.ovis.sh/"), localStorage: storage(local), sessionStorage: storage(session) }),
    IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"] },
    localStorage: storage(local),
    sessionStorage: storage(session),
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  now = Date.now();
  fake = new FakeAccountService(() => now);
  fake.opensAll = true;
  fake.signInAs("github", ACCOUNT);
  store = memoryAccountStore();
  service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
  signInsAgain = [];
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globals.clear();
});

describe("a PC the account lists unconfirmed", () => {
  it("is named only by the name it gave itself, quoted, with when and why, and offers Add and No under ten minutes", async () => {
    await signIn();
    await listedByDeviceCode();
    await mount();
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
    expect(text()).toContain("A PC was added to your account with a sign-in code at ");
    expect(text()).toContain("Add it only if you typed that code on that PC's own screen a moment ago.");
    // the label is never said as a fact: only inside its quotes
    expect(text().split(`"${LABEL}"`).join("")).not.toContain(LABEL);
    expect(buttons()).toEqual(["Add", "No"]);
  });

  it("offers only Remove from my account once the listing is older than ten minutes", async () => {
    await listedByDeviceCode();
    now += 11 * MINUTE;
    await signIn();
    await mount();
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
    expect(buttons()).toEqual(["Remove from my account"]);
    await press("Remove from my account");
    expect(fake.requests).toContain(`DELETE /v1/pcs/${PC}`);
    expect(fake.pcs(ACCOUNT)).toEqual([]);
  });

it("PCR-1: a removal from a sign-in older than ten minutes removes nothing, and says to sign in again", async () => {
    await listedByDeviceCode();
    await signIn();
    now += 11 * MINUTE;
    await mount();
    await press("Remove from my account");
    expect(text()).toContain("Sign in again to remove it: your sign-in is more than ten minutes old.");
    expect(fake.pcs(ACCOUNT)).toHaveLength(1);
    // no sign-in in place here (no app, no PC window, no hosted shell): nothing to press but the removal again
    expect(buttons()).toEqual(["Remove from my account"]);
  });

  it("PCR-1: Sign in again signs in fresh in place and removes the same PC", async () => {
    await listedByDeviceCode();
    await signIn();
    now += 11 * MINUTE;
    keepShellAccount({ signOut() {}, signOutEverywhere: async () => null, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null,
      freshSignIn: async () => { await signIn(); return (await store.get("session")) ?? null; } });
    try {
      await mount();
      await press("Remove from my account");
      expect(fake.pcs(ACCOUNT)).toHaveLength(1);
      await press("Sign in again");
      expect(fake.requests.filter((request) => request === `DELETE /v1/pcs/${PC}`)).toHaveLength(2);
      expect(fake.pcs(ACCOUNT)).toEqual([]);
    } finally {
      keepShellAccount(null);
    }
  });

  it("confirms with this own sign-in on Add: listed as the account's, new for 24 hours, told as new, and never opened by itself", async () => {
    await signIn();
    await listedByDeviceCode();
    await mount();
    let changed = 0;
    window.addEventListener("ovis:account-pcs-changed", () => { changed += 1; });
    await press("Add");
    // the account's PCs are read again wherever they are listed (the front page's Your PCs among them)
    expect(changed).toBeGreaterThan(0);
    expect(fake.requests.filter((line) => line === `PUT /v1/pcs/${PC}`)).toHaveLength(2);
    const [listed] = await service.forSignIn((await service.session())!).listPcs();
    expect(listed?.server_id).toBe(PC);
    expect(listed?.unconfirmed).toBeUndefined();
    expect(Date.parse(listed!.new_until!)).toBe(now + PC_NEW_MS);
    expect(isNewAccountPc(listed!, now)).toBe(true);
    const row: MyPc = { server_id: PC, name: LABEL, state: "needs-approval", last_seen_at: new Date(now).toISOString(), added_at: listed!.added_at, new_until: listed!.new_until,
      listed: true, paired: false, linked: false, accountOpen: true, join: { server_public_key: "k", relay: "wss://relay.ovis.sh" } };
    expect(accountOpenablePcs([row], { account: ACCOUNT, devices: [], now })).toEqual([]);
    // the new-PC card with its one-tap removal takes the question's place
    expect(text()).toContain(`New PC added to your account: ${LABEL}`);
    expect(buttons()).toContain("I didn't add this");
    expect(buttons()).not.toContain("Add");
  });

  it("removes the listing from the account on No and hides it, for good after a reload", async () => {
    await signIn();
    await listedByDeviceCode();
    await mount();
    await press("No");
    expect(fake.requests).toContain(`DELETE /v1/pcs/${PC}`);
    expect(fake.pcs(ACCOUNT)).toEqual([]);
    expect(buttons()).toEqual([]);
    await mount();
    expect(buttons()).toEqual([]);
    expect(text()).not.toContain(LABEL);
  });

  it("says why a sign-in too old cannot add it, signs in again on Sign in again, and adds it after", async () => {
    await signIn();
    now += 11 * MINUTE;
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(text()).toContain("Sign in again to add it: your sign-in is more than ten minutes old.");
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
    await press("Sign in again");
    expect(signInsAgain).toEqual(["github"]);
    // the sign-in comes back as a page load: the add it was for goes on by itself, once
    await signIn();
    await mount();
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(false);
    expect(text()).toContain(`New PC added to your account: ${LABEL}`);
  });

  it("tells a sign-in without two-step in a used account to add the PC with the number, and never to sign in again", async () => {
    await signIn();
    await listedByItsOwnSignIn();
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(text()).toContain("This account has no two-step sign-in to add it here. Add it with the number on the PC's screen.");
    expect(buttons()).not.toContain("Sign in again");
    expect(buttons()).toContain("No");
    expect(fake.pcs(ACCOUNT).find((pc) => pc.server_id === PC)?.listed_by_device).toBe(true);
    // with no Add, the warning about a typed code has nothing to warn of: the name and the time stay
    expect(text()).not.toContain("Add it only if you typed that code");
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
    expect(text()).toContain("A PC was added to your account with a sign-in code at ");
  });

  it("says so from the start to a Google sign-in, which never carries two-step, once the account has another PC", async () => {
    await signIn("google");
    await listedByItsOwnSignIn();
    await listedByDeviceCode();
    await mount();
    expect(text()).toContain("This account has no two-step sign-in to add it here. Add it with the number on the PC's screen.");
    expect(buttons()).toEqual(["No"]);
    expect(text()).not.toContain("Add it only if you typed that code");
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
  });

  /** another device said No to the listing this card shows, and the PC listed itself again: a new listing behind the same card */
  async function replacedBehindTheCard(): Promise<string> {
    const shown = fake.pcs(ACCOUNT)[0]!.listing_id!;
    const removed = await fake.fetch(`${ORIGIN}/v1/pcs/${PC}`, { method: "DELETE", headers: { authorization: `Bearer ${fake.issueToken(ACCOUNT)}` } });
    expect(removed.status).toBe(204);
    await listedByDeviceCode();
    expect(fake.pcs(ACCOUNT)[0]!.listing_id).not.toBe(shown);
    return shown;
  }

  /** the account service as this device calls it, each write to /v1/pcs recorded with what it named */
  function recorded(): { method: string; url: URL; body: Record<string, unknown> | null }[] {
    const sent: { method: string; url: URL; body: Record<string, unknown> | null }[] = [];
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== "GET" && url.pathname.startsWith("/v1/pcs/")) {
        const text = await request.clone().text();
        sent.push({ method: request.method, url, body: text === "" ? null : JSON.parse(text) as Record<string, unknown> });
      }
      return fake.fetch(request);
    } });
    return sent;
  }

  it("account#67: Add names the listing its card showed: a replacement is not confirmed, and the card shows it as it is now", async () => {
    fake.completions = true;
    await signIn();
    await listedByDeviceCode();
    const sent = recorded();
    await mount();
    const shown = await replacedBehindTheCard();
    await press("Add");
    expect(sent.filter((each) => each.method === "PUT").map((each) => each.body?.listing_id)).toEqual([shown]);
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
    // the service's 409 listing_changed is no failure to show: the PCs are read again instead
    expect(fake.requests.lastIndexOf("GET /v1/pcs")).toBeGreaterThan(fake.requests.lastIndexOf(`PUT /v1/pcs/${PC}`));
    expect(text()).not.toContain("The PC could not be added.");
    expect(text()).not.toContain("New PC added to your account");
    expect(buttons()).toEqual(["Add", "No"]);
  });

  it("account#67: No names the listing its card showed: a replacement is not removed, and the card shows it as it is now", async () => {
    fake.completions = true;
    await signIn();
    await listedByDeviceCode();
    const sent = recorded();
    await mount();
    const shown = await replacedBehindTheCard();
    await press("No");
    expect(sent.filter((each) => each.method === "DELETE").map((each) => `${each.url.pathname}${each.url.search}`)).toEqual([`/v1/pcs/${PC}?listing_id=${shown}`]);
    expect(fake.pcs(ACCOUNT)).toHaveLength(1);
    expect(fake.pcs(ACCOUNT)[0]!.listing_id).not.toBe(shown);
    expect(fake.requests.lastIndexOf("GET /v1/pcs")).toBeGreaterThan(fake.requests.lastIndexOf(`DELETE /v1/pcs/${PC}`));
    expect(text()).not.toContain("The PC could not be removed.");
    expect(buttons()).toEqual(["Add", "No"]);
  });

  for (const [saved, kept] of [["no listing (an older Ovis saved it)", {}], ["another listing", { listing_id: "0".repeat(32) }]] as const) {
    it(`C1: an Add kept across Sign in again for ${saved} never confirms the listing there now: it waits for a fresh press`, async () => {
      fake.completions = true;
      await signIn();
      await listedByDeviceCode();
      sessionStorage.setItem("ovis:confirm-pc", JSON.stringify({ account: ACCOUNT, server_id: PC, ...kept }));
      await mount();
      expect(fake.requests.filter((line) => line === `PUT /v1/pcs/${PC}`)).toHaveLength(1);
      expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
      expect(buttons()).toEqual(["Add", "No"]);
    });
  }

  it("offers nothing to press to a device code's sign-in", async () => {
    await listedByDeviceCode();
    const token = fake.issueToken(ACCOUNT, { device: true });
    await store.set("session", { account: ACCOUNT, service: ORIGIN, provider: "github", sign_in_id: "device", access_token: token, refresh_token: "r", expires_at: now + 60 * MINUTE });
    await mount();
    expect(buttons()).toEqual([]);
    expect(fake.requests.filter((line) => line.startsWith("PUT ") || line.startsWith("DELETE "))).toHaveLength(1);
  });
});
