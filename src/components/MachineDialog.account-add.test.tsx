/**
 * Add PC's "Add it to my account" once the SSH connection stands (docs/account.md, "Adding a PC over SSH"): it says added
 * only once that PC says its relay is online, and a sign-in too old to admit it is no dead end: Sign in again in place,
 * and the add goes on over the same connection, or a new one to the same PC when that one ended.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { AccountAddTarget, SetupJob, SetupRequest } from "../../shared/machines.ts";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { AccountService, AccountServiceError } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import * as i18n from "../lib/i18n.ts";
import { getTransport, setTransport } from "../lib/transport.ts";
import * as accountSection from "./AccountSection.tsx";
import { MachineDialog } from "./MachineDialog.tsx";

const SESSION: AccountSession = { service: "https://account.test", account: "acct_1", provider: "google", access_token: "old", refresh_token: "old", expires_at: Date.now() + 60_000 };
const FRESH: AccountSession = { ...SESSION, access_token: "fresh", refresh_token: "fresh" };

function target(account: string | null = null): AccountAddTarget {
  const key = generateKeyPair().publicKey;
  return { server_id: deriveServerId(key), public_key: exportPublicKey(key), relay: "wss://relay.example", label: "p23-pcb", account };
}

const undo: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const step of undo.splice(0).reverse()) await step(); });

function define(key: string, value: unknown): void {
  const saved = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  undo.push(() => { if (saved) Object.defineProperty(globalThis, key, saved); else Reflect.deleteProperty(globalThis, key); });
}

/**
 * This PC's own window, signed in to its account, adding "lab" over SSH. `admit`: the account service's answers to the
 * admits in turn; `takes`: this PC's answers to POST /api/account/ssh-add in turn. `account`: the account that PC's inspect
 * says it is in. `later`: the PC a connection made again reaches (another one than the first, say). `freshSignIn`: false
 * for a sign-in again that stores nothing (another account's, or one the person left).
 */
async function dialog(options: { admit: (AccountServiceError | null)[]; takes: Response[]; signInAgain?: boolean; preset?: AddPcPreset; account?: string | null; later?: AccountAddTarget; freshSignIn?: boolean }) {
  define("window", { isSecureContext: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {} });
  define("document", { querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => "https://account.test" } : null });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  let stored = SESSION;
  const signIns: AccountSession[] = [];
  const spies = [
    spyOn(i18n, "useT").mockImplementation(() => (key) => key),
    spyOn(AccountService.prototype, "session").mockImplementation(async () => stored),
    spyOn(AccountService.prototype, "listPcs").mockResolvedValue([]),
    spyOn(AccountService.prototype, "putPc").mockResolvedValue(undefined),
    spyOn(AccountService.prototype, "admitPc").mockImplementation(async () => {
      const refusal = options.admit.shift() ?? null;
      if (refusal !== null) throw refusal;
      return { account: "acct_1", new_until: new Date(Date.now() + 86_400_000).toISOString(), admitted_at: null };
    }),
    // the page's own sign-in again: stored in the old one's place for the same account, as signInAgainWith does
    spyOn(accountSection, "useSignInAgainHere").mockImplementation(() => options.signInAgain === false ? undefined : async (from) => {
      signIns.push(from);
      if (options.freshSignIn === false) return null;
      stored = FRESH;
      return FRESH;
    }),
  ];
  undo.push(() => { for (const spy of spies) spy.mockRestore(); });
  const transport = getTransport();
  undo.push(() => setTransport(transport));
  const fields = target(options.account ?? null);
  const setups: SetupRequest[] = [];
  const takes: unknown[] = [];
  setTransport({ ...transport, fetch: async (input, init) => {
    switch (String(input)) {
      case "/api/health": return Response.json({ auth: { via: "local" }, own_window: true });
      case "/api/account/status": return Response.json({ account: "acct_1", pc_add_from_account: true });
      case "/api/machines/setup": {
        const request = JSON.parse(String(init?.body)) as SetupRequest;
        setups.push(request);
        return Response.json({ id: `job-${setups.length}`, machine_id: "lab-pc", phase: "connected", step: "Connected", action_required: null, error: null, challenge: null, installations: [], ssh_output: null,
          target: { destination: "lab" }, account_add: setups.length > 1 && options.later !== undefined ? options.later : fields } satisfies SetupJob);
      }
      case "/api/account/ssh-add": takes.push(JSON.parse(String(init?.body))); return options.takes.shift() ?? Response.json({ error: { code: "refused", message: "no" } }, { status: 409 });
      default: throw new Error(`Unexpected request: ${input}`);
    }
  } });
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(createElement(MachineDialog, { preset: options.preset ?? { destination: "lab" }, onClose() {}, onConnected() {} })); });
  undo.push(() => act(async () => view?.unmount()));
  const settle = async () => { for (let flush = 0; flush < 8; flush += 1) await act(async () => {}); };
  await settle();
  await act(async () => { view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  await settle();
  const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
  const status = () => view!.root.findAll((node) => node.type === "p" && node.props.role === "status").map(text);
  const button = (name: string) => view!.root.findAll((node) => node.type === "button" && text(node) === name)[0];
  const admits = () => (AccountService.prototype.admitPc as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  return { status, button, settle, setups, takes, signIns, fields, admits };
}

const online = () => Response.json({ account: "acct_1", server_id: "x", relay: { phase: "online", blocked: null } });
const NOT_ONLINE = "It is in your account, but its relay is not online yet, so your devices cannot open it. Run ovis status on that PC to see why.";

test("added only once that PC says its relay is online", async () => {
  const shown = await dialog({ admit: [null], takes: [online()] });
  expect(shown.status()).toContain("Added to your account.");
});

test("in the account with its relay not online yet: said plainly, with what to do, never Added", async () => {
  const shown = await dialog({ admit: [null], takes: [Response.json({ account: "acct_1", server_id: "x", relay: { phase: "connecting", blocked: null } })] });
  expect(shown.status()).toContain(NOT_ONLINE);
  expect(shown.status()).not.toContain("Added to your account.");
});

test("a sign-in too old to admit: Sign in again in place, then the add goes on over the same connection, nothing retyped", async () => {
  const shown = await dialog({ admit: [new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first"), null], takes: [online()] });
  expect(shown.status()).toContain("Sign in again now to add it right away.");
  expect(shown.takes).toEqual([]);
  await act(async () => { shown.button("Sign in again")!.props.onClick(); });
  await shown.settle();
  expect(shown.signIns.map((from) => from.refresh_token)).toEqual(["old"]);
  expect(shown.status()).toContain("Added to your account.");
  // the same job's connection: no second setup, so no host typed again and no SSH connection made again
  expect(shown.setups).toHaveLength(1);
  expect(shown.takes).toEqual([{ job_id: "job-1", server_id: shown.fields.server_id }]);
});

test("a sign-in again whose SSH connection ended meanwhile connects to the same PC again, and that add goes on by itself", async () => {
  const shown = await dialog({ admit: [new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first"), null, null],
    takes: [Response.json({ error: { code: "disconnected", message: "The SSH connection to that PC ended. Connect to it again." } }, { status: 409 }), online()] });
  await act(async () => { shown.button("Sign in again")!.props.onClick(); });
  await shown.settle();
  expect(shown.setups).toEqual([{ destination: "lab", account_add: true }, { destination: "lab", machine_id: "lab-pc", account_add: true }]);
  expect(shown.status()).toContain("Added to your account.");
});

test("where this page has no sign-in of its own to start, the words stay as they were and offer no button", async () => {
  const shown = await dialog({ admit: [new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first")], takes: [], signInAgain: false });
  expect(shown.status()).toContain("Sign in again on this PC, then add it again.");
  expect(shown.button("Sign in again")).toBeUndefined();
});

test("Add again on the relay tab's row of a PC saved here goes to that same saved PC, never a second one", async () => {
  const shown = await dialog({ admit: [null], takes: [online()], preset: { destination: "lab", name: "lab", machine_id: "lab-pc" } });
  expect(shown.setups).toEqual([{ destination: "lab", machine_id: "lab-pc", account_add: true }]);
  expect(shown.status()).toContain("Added to your account.");
});

test("a sign-in again that stores nothing (another account, or left unfinished) brings the offer back and adds nothing", async () => {
  const shown = await dialog({ admit: [new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first")], takes: [online()], freshSignIn: false });
  await act(async () => { shown.button("Sign in again")!.props.onClick(); });
  await shown.settle();
  expect(shown.signIns).toHaveLength(1);
  expect(shown.status()).toContain("Sign in again now to add it right away.");
  expect(shown.button("Sign in again")).toBeDefined();
  expect([shown.admits(), shown.takes]).toEqual([1, []]);
});

test("a PC already in the account whose Ovis does not say how its relay stands: in the account, and how to find out", async () => {
  const shown = await dialog({ admit: [], takes: [Response.json({ account: "acct_1", server_id: "x", relay: null })], account: "acct_1" });
  expect(shown.status()).toContain("It is already in your account. Update Ovis on that PC to check its relay.");
});

test("a PC already in the account whose owner turned its relay off there: said so in one line", async () => {
  const shown = await dialog({ admit: [], takes: [Response.json({ account: "acct_1", server_id: "x", relay: { phase: "off", blocked: null } })], account: "acct_1" });
  expect(shown.status()).toContain("It is already in your account. Its relay is turned off on that PC.");
});

test("a take that got no answer says it may have been added, never that it was not", async () => {
  const shown = await dialog({ admit: [null], takes: [Response.json({ error: { code: "take_unanswered", message: "It may have been added. Connect again to check." } }, { status: 409 })] });
  expect(shown.status()).toContain("It may have been added. Connect again to check.");
});

test("a connection made again after Sign in again that reaches another PC adds nothing and says so", async () => {
  const shown = await dialog({ admit: [new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first"), null, null], later: target(),
    takes: [Response.json({ error: { code: "disconnected", message: "The SSH connection to that PC ended. Connect to it again." } }, { status: 409 }), online()] });
  await act(async () => { shown.button("Sign in again")!.props.onClick(); });
  await shown.settle();
  expect(shown.setups).toHaveLength(2);
  expect(shown.status()).toContain("That address now reaches another PC. Nothing was added.");
  // the first PC's take, and none for the other
  expect(shown.takes).toEqual([{ job_id: "job-1", server_id: shown.fields.server_id }]);
});
