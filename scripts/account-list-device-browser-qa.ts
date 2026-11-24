import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { LIST_LEVEL, listView, replayList } from "../shared/account-list.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { askingPc, postPcKeys } from "../src/lib/account/accountList.test-helpers.ts";
import type { AccountSession } from "../src/lib/account/store.ts";
import { chromePath } from "./chrome-path.ts";

// A device keeps its copy of the account's signed list in IndexedDB, signs with a key WebCrypto will not hand
// out, and takes turns between tabs with Web Locks. Bun's tests run the same code over stores in memory; this runs it
// in a real browser, against the account service fake, across a reload. Chromium only: Playwright's WebKit stores no
// CryptoKey in IndexedDB (scripts/account-list-seal-browser-qa.ts), which the account key needed before this.
type Page = typeof import("./account-list-device-page.ts");
const MODULE = "/account-list-device-page.js";
const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./account-list-device-page.ts", import.meta.url))], target: "browser" });
const [module] = build.outputs;
if (!build.success || module === undefined || build.outputs.length !== 1) throw new AggregateError(build.logs, "Could not build the page's module");

const fake = new FakeAccountService();
fake.opensAll = true;
fake.listAccounts = "*";
const wire = { away: false, asked: [] as string[] };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname === MODULE) return new Response(module, { headers: { "content-type": "text/javascript" } });
  if (!pathname.startsWith("/v1/") && !pathname.startsWith("/v2/")) return new Response("<!doctype html><title>List test</title>", { headers: { "content-type": "text/html" } });
  wire.asked.push(`${request.method} ${pathname}`);
  return wire.away ? new Response("away", { status: 503 }) : fake.fetch(request);
} });
const origin = `http://127.0.0.1:${server.port}`;
const signInOf = (account: string): AccountSession => ({
  service: origin, account, provider: "github", access_token: fake.issueToken(account), refresh_token: `refresh-${account}`,
  expires_at: Date.now() + 3_600_000, sign_in_id: `qa-${account}`, signed_in_at: Date.now(),
});

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const ACCOUNT = "acct_browser";
    const context = await browser.newContext();
    const open = async () => { const page = await context.newPage(); await page.goto(origin); return page; };
    const sync = (page: Awaited<ReturnType<typeof open>>) => page.evaluate(async (path) => ((await import(path)) as Page).sync(), MODULE);
    /** A sign-in in that page, whose key the account service registers as it does after a real one (the fake has no route for it). */
    const signIn = async (page: Awaited<ReturnType<typeof open>>, account: string): Promise<AccountSession> => {
      const session = signInOf(account);
      const key = await page.evaluate(async ({ path, session }) => ((await import(path)) as Page).signIn(session), { path: MODULE, session });
      const no = fake.registerSessionKey(session.access_token, key, "QA phone");
      await page.evaluate(async ({ path, no }) => ((await import(path)) as Page).registered(no), { path: MODULE, no });
      return session;
    };
    /** A PC asks to be added (the account lists it, it posts its keys and its card), and the device in that page adds it under a name. */
    const addPc = async (page: Awaited<ReturnType<typeof open>>, session: AccountSession, list: string, label: string): Promise<string> => {
      const pc = await askingPc();
      const card = await postPcKeys(fake.fetch, origin, session.access_token, pc, list);
      const status = await page.evaluate(async ({ path, pc, label }) => ((await import(path)) as Page).addPc(pc, label), { path: MODULE, pc: { endpoint: pc.endpoint, key: pc.key, enc: pc.enc, card }, label });
      assert.equal(status, 200, "the account service takes the device's entry for the PC");
      return pc.endpoint;
    };
    const storedKeys = (page: Awaited<ReturnType<typeof open>>) => page.evaluate(async (path) => ((await import(path)) as Page).storedKeys(), MODULE);

    // A new account's first device starts the list in the browser.
    const first = await open();
    const session = await signIn(first, ACCOUNT);
    const started = await sync(first);
    assert.equal(started.status.at, "following");
    const held = fake.accountList(ACCOUNT);
    assert.ok(held, "the account service holds the list");
    const replayed = await replayList(held.entries, LIST_LEVEL, { saved: null, given: held.id });
    const keys = await storedKeys(first);
    assert.deepEqual(listView(replayed.member!.state).devices.map((row) => [row.key, row.enc]), [[keys.member.key, keys.enc.key]], "entry 0 is the device's own, and holds for a member that replays it");
    assert.deepEqual(started.devices.map((row) => [row.key, row.self, row.name]), [[keys.member.key, true, { label: "QA phone", os: "android" }]]);
    console.log("PASS genesis in Chromium: the device signs entry 0, the account service takes it, and a member's replay holds it");

    // Its keys are CryptoKeys in IndexedDB that WebCrypto will not export; what it keeps of the list is text.
    const cannot = ["InvalidAccessError", "InvalidAccessError", "InvalidAccessError"];
    assert.deepEqual({ ...keys.member, key: null }, { key: null, stored: "CryptoKey", extractable: false, algorithm: "ECDSA", usages: ["sign"], exported: cannot });
    assert.deepEqual({ ...keys.enc, key: null }, { key: null, stored: "CryptoKey", extractable: false, algorithm: "ECDH", usages: ["deriveBits"], exported: cannot });
    const desk = await addPc(first, session, held.id, "Desk in the study");
    const before = await sync(first);
    assert.deepEqual(before.pcs.map((pc) => [pc.endpoint, pc.name]), [[desk, { label: "Desk in the study", os: "linux" }]]);
    const kept = await first.evaluate(async ({ path, account }) => ((await import(path)) as Page).kept(account), { path: MODULE, account: ACCOUNT });
    assert.ok(kept["copy"] !== null && kept["wraps"] !== null, "the copy and the wraps are kept");
    assert.equal(kept["genesis"], null, "the genesis is not kept once the copy holds it");
    for (const text of Object.values(kept)) assert.ok(text === null || !text.includes("Desk in the study"), "no name is kept in the clear");
    console.log("PASS keys in Chromium: the member key and the encryption key are CryptoKeys in IndexedDB that cannot be exported, and what is kept of the list is text with no name in it");

    // After a reload, with the account service away: the same view, from storage alone, with the same keys.
    await first.close();
    wire.away = true;
    const second = await open();
    const restored = await sync(second);
    assert.deepEqual(restored, { ...before, reached: false });
    assert.deepEqual(await storedKeys(second), keys);
    console.log("PASS reload in Chromium: a new page holds the same devices, PCs and names from IndexedDB with the account service away");

    // And the keys still work: the stored encryption key opens the wrap, the stored member key signs the next entry.
    wire.away = false;
    const laptop = await addPc(second, session, held.id, "Laptop");
    const after = await sync(second);
    assert.deepEqual(after.pcs.map((pc) => [pc.endpoint, pc.name?.label]), [[desk, "Desk in the study"], [laptop, "Laptop"]]);
    assert.equal(fake.accountList(ACCOUNT)?.entries.length, 3);
    console.log("PASS keys after a reload in Chromium: the key from IndexedDB opens the epoch key and signs an entry the account service takes");

    // A lying service after the reload: an entry no member signed lets nobody in, and the page says so.
    const stranger = await browser.newContext();
    const theirs = await stranger.newPage();
    await theirs.goto(origin);
    const forged = await theirs.evaluate(async ({ path, at }) => ((await import(path)) as Page).entryAt(at, "cd".repeat(32)), { path: MODULE, at: { list: held.id, seq: 3, prev: fake.accountList(ACCOUNT)!.head.hash } });
    fake.tamperList(held.id, { inject: [forged] });
    const lied = await sync(second);
    assert.deepEqual([lied.devices, lied.pcs], [after.devices, after.pcs]);
    assert.equal(lied.status.at === "following" ? lied.status.trouble : null, "unsigned");
    fake.untamperList(held.id);
    await stranger.close();
    console.log("PASS a lying service in Chromium: an entry no member signed changes nobody, and the device says what it was shown");

    // Two tabs of one new device start at once: the lock between them makes one genesis.
    const race = await browser.newContext();
    const tabs = [await race.newPage(), await race.newPage()];
    for (const tab of tabs) await tab.goto(origin);
    await signIn(tabs[0]!, "acct_race");
    wire.asked.length = 0;
    const views = await Promise.all(tabs.map((tab) => tab.evaluate(async (path) => ((await import(path)) as Page).sync(), MODULE)));
    const raced = fake.accountList("acct_race");
    assert.equal(raced?.entries.length, 1);
    assert.deepEqual(views.map((view) => view.status.at === "following" ? [view.status.list, view.status.standing] : view.status.at), [[raced.id, "in"], [raced.id, "in"]]);
    assert.equal(wire.asked.filter((route) => route === "POST /v2/lists").length, 1, "one tab signs and sends the genesis; the other finds it saved");
    await race.close();
    console.log("PASS two tabs in Chromium: one genesis is signed and sent, and both tabs follow it");

    // A second device of the account, in a browser profile of its own, is let in by the first and follows from the place it is handed.
    const other = await browser.newContext();
    const tablet = await other.newPage();
    await tablet.goto(origin);
    await signIn(tablet, ACCOUNT);
    const waiting = await sync(tablet);
    assert.deepEqual(waiting.status, { at: "not_in", list: held.id, why: "not_mine", claim: "claimed" });
    const tabletKey = await tablet.evaluate(async (path) => ((await import(path)) as Page).memberKey(), MODULE);
    const outcome = await second.evaluate(async ({ path, key }) => ((await import(path)) as Page).allow({ key, label: "QA tablet", os: "android" }), { path: MODULE, key: tabletKey });
    assert.ok(outcome.allowed, `the first device lets the second in: ${outcome.allowed ? "" : outcome.why}`);
    const now = fake.accountList(ACCOUNT)!;
    assert.deepEqual(outcome.offer, { list: held.id, seq: now.head.seq, hash: now.head.hash });
    assert.equal((await sync(tablet)).status.at, "not_in", "the service's word alone lets it follow nothing");
    const joined = await tablet.evaluate(async ({ path, offer }) => ((await import(path)) as Page).adopt(offer), { path: MODULE, offer: outcome.offer });
    assert.equal(joined.status.at === "following" ? joined.status.standing : joined.status.at, "in");
    assert.deepEqual(joined.devices.map((row) => [row.self, row.name?.label]), [[false, "QA phone"], [true, "QA tablet"]]);
    assert.deepEqual(joined.pcs.map((pc) => pc.name?.label), ["Desk in the study", "Laptop"]);
    // and after a reload of the second device, from its own storage
    await tablet.close();
    wire.away = true;
    const tabletAgain = await other.newPage();
    await tabletAgain.goto(origin);
    assert.deepEqual(await sync(tabletAgain), { ...joined, reached: false });
    wire.away = false;
    await other.close();
    console.log("PASS letting a device in, in Chromium: the first device signs the second in with its stored key, and the second follows from the place it is handed, also after a reload");
  } finally {
    await browser.close();
  }
} finally {
  await server.stop(true);
}
