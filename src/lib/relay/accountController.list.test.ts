import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AccountList, AccountListView } from "../account/accountList.ts";
import type { DirectoryPc } from "../account/service.ts";
import { memoryAccountStore, newKey, type AccountSession, type AccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";

const SERVICE = "https://account.ovis.sh";
const OFF: AccountListView = { account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] };
const row = (id: string): DirectoryPc => ({ server_id: id, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: null, relay: null, new_until: null, admitted_at: null, admitted_before_you: false });
const session = (account: string): AccountSession => ({ service: SERVICE, account, provider: "github", access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: `sign-in-${account}`, signed_in_at: Date.now() });
const empty: ShellDeviceStore = {
  get: async () => undefined, list: async () => [],
  remove: async () => {}, removeRow: async () => false,
  update: async () => { throw new Error("No pairing is made here"); },
};

/** what a device that follows the list of `account` and is in it shows */
const inList = (account: string): AccountListView => ({ account, reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 0, read_at: 1, trouble: null }, devices: [], pcs: [] });

/** a list that only records what the shell asks of it */
function recordingList(): { list: AccountList; calls: string[]; heard: (() => void)[] } {
  const calls: string[] = [];
  const heard: (() => void)[] = [];
  const list: AccountList = {
    sync: async () => { calls.push("sync"); return OFF; },
    view: () => OFF,
    subscribe: (listener) => { heard.push(() => listener(OFF)); return () => {}; },
    holdsPc: () => false,
    pcOfKey: () => null,
    due: () => null,
    shadow: async (account, directory, opens) => { calls.push(`shadow ${account} ${directory.map((pc) => pc.server_id).join(",")} opens:${[...opens ?? []].join(",")}`); return null; },
    dropNames: async (account) => { calls.push(`dropNames ${account}`); },
    forget: async (account) => { calls.push(`forget ${account}`); },
  };
  return { list, calls, heard };
}

describe("the hosted shell and the account's signed list", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let accountStore: AccountStore;
  let directory: DirectoryPc[];
  let asked: string[];
  beforeEach(() => {
    browser = createShellTestPage();
    accountStore = memoryAccountStore();
    directory = [row("a1".repeat(16))];
    asked = [];
  });
  afterEach(() => browser.dispose());

  const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const controller = (accountList?: AccountList | null, store: ShellDeviceStore = empty) => createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store, accountStore, accountService: SERVICE,
    accountFetch: async (input) => {
      const { pathname } = new URL(new Request(input).url);
      asked.push(pathname);
      return pathname === "/v1/pcs" ? Response.json({ pcs: directory }) : Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
    },
    renderApp: () => ({ render() {}, unmount() {} }),
    ...(accountList === undefined ? {} : { accountList }),
  }, { active: () => true, changed: async () => {}, outdated: () => new Set() });
  const signIn = async (account: string, no: number | null = 1): Promise<void> => {
    const signedIn = session(account);
    await accountStore.set("session", signedIn);
    await accountStore.set("signin_key", { account, sign_in_id: signedIn.sign_in_id!, key: await newKey(), no });
  };

  it("reads the list once per sign-in, after the directory, and holds each directory read against it", async () => {
    await signIn("acct-one");
    const { list, calls, heard } = recordingList();
    let viewed = "acct-one";
    list.view = () => inList(viewed);
    const account = controller(list);
    await account.refresh(true);
    await settle();
    expect(calls).toEqual(["sync", `shadow acct-one ${"a1".repeat(16)} opens:`]);
    // a later read of the directory compares again, and reads the list no second time: that is the list's own clock
    directory = [row("a1".repeat(16)), row("b2".repeat(16))];
    await account.refresh(false, true);
    await settle();
    expect(calls.slice(2)).toEqual([`shadow acct-one ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
    // the list moved: compared again with the directory last read
    for (const tell of heard) tell();
    await settle();
    expect(calls.slice(3)).toEqual([`shadow acct-one ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
    // another sign-in: its list is read at once
    viewed = "acct-two";
    await signIn("acct-two");
    await account.refresh(false, true);
    await settle();
    expect(calls.slice(4)).toEqual(["sync", `shadow acct-two ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
  });

  it("compares nothing for a sign-in that ended while it read this device's pairings", async () => {
    await signIn("acct-one");
    const { list, calls, heard } = recordingList();
    // the read of the pairings that a comparison waits for, held by the test
    const reads: (() => void)[] = [];
    let holding = false;
    list.view = () => inList("acct-one");
    const account = controller(list, { ...empty, list: () => holding ? new Promise((resolve) => { reads.push(() => resolve([])); }) : Promise.resolve([]) });
    await account.refresh(true);
    await settle();
    const unhandled: unknown[] = [];
    const note = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", note);
    try {
      holding = true;
      for (const tell of heard) tell();
      await settle();
      expect(reads.length).toBe(1);
      holding = false;
      account.signOut();
      await settle();
      calls.length = 0;
      for (const release of reads) release();
      await settle();
    } finally { process.off("unhandledRejection", note); }
    expect([unhandled, calls.filter((call) => call.startsWith("shadow"))]).toEqual([[], []]);
  });

  it("reads no pairing and compares nothing where the device is in no list of the account", async () => {
    await signIn("acct-one");
    const { list, calls, heard } = recordingList();
    let read = 0;
    const account = controller(list, { ...empty, list: async () => { read += 1; return []; } });
    await account.refresh(true);
    await settle();
    const before = read;
    for (const tell of heard) tell();
    await settle();
    expect([read - before, calls.filter((call) => call.startsWith("shadow"))]).toEqual([0, []]);
  });

  it("reads the list again after a sign-out, so that nothing of the ended sign-in stays in view, and forgets what opens its names", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    const account = controller(list);
    await account.refresh(true);
    await settle();
    calls.length = 0;
    account.signOut();
    await settle();
    // once, when the sign-in is gone from the store: not while it is still there. What opens the list's names goes
    // as the PCs' names do, and the copy stays: the device is still a member
    expect([...calls].sort()).toEqual(["dropNames acct-one", "sync"]);
    expect(await accountStore.get("session")).toBeUndefined();
  });

  it("changes nothing it draws or sends by the list: the same rows and the same requests with one and with none", async () => {
    await signIn("acct-one");
    const withList = controller(recordingList().list);
    await withList.refresh(true);
    await settle();
    const [drawn, sent] = [withList.state, [...asked]];
    asked = [];
    const without = controller(null);
    await without.refresh(true);
    await settle();
    expect(drawn).toMatchObject({ kind: "signed-in", error: null, pcs: [{ server_id: "a1".repeat(16) }] });
    expect(without.state).toEqual(drawn!);
    expect(without.directory).toEqual(withList.directory);
    expect(asked).toEqual(sent);
  });

  it("says which account is signed in before it read the account's PCs, and writes nothing to the stored sign-in for it", async () => {
    // a sign-in stored by an older build, with no id of its own: reading whose it is must not name it
    const { sign_in_id: _unnamed, ...legacy } = session("acct-one");
    await accountStore.set("session", legacy);
    const account = controller(null);
    expect(account.signedInAs).toBeUndefined();
    expect(await account.storedAccount()).toBe("acct-one");
    expect(await accountStore.get("session")).toEqual(legacy);
    expect(asked).toEqual([]);
  });

  it("follows no list where a test gives its own account store or fetch and no list", async () => {
    await signIn("acct-one");
    const account = controller();
    await account.refresh(true);
    await settle();
    expect(asked.filter((path) => path.startsWith("/v2/"))).toEqual([]);
  });
});
