/**
 * A device's press on the join sheet of a PC new in its account (added in one press, inside `new_until`), in a real
 * browser at a phone's width (390, touch) and a PC's (1440). The hosted shell is dist-shell/, served as Cloudflare Pages
 * serves it and routed in for https://app.ovis.sh; the PC is a real one (createServer) behind a local Bun relay, which
 * the page's relay sockets are bridged to; the account service is the in-memory fake (shared/account-service-fake.ts),
 * routed in for https://account.ovis.sh. Nothing leaves this machine.
 *
 * - A device whose key the account lists but not as eligible: the PC has no row for it and answers its account sign-in
 *   auth_failed. Its press goes on to the join, on the same page: the PC's own window lists it (GET /api/relay/joins)
 *   and the page shows the number beside the PC's Allow.
 * - A device whose key is eligible: its press opens the PC through the account, and no join reaches the PC.
 * Each from the PC's own address, from its row on My PCs, and from a launch, which puts up the sheet and sends nothing
 * before the press. Nothing opens the PC, and nothing reaches it, before the press.
 *
 *   bun run build:shell && bun run check run --build -- bun scripts/relay-new-pc-press-regression.ts
 *
 * UI_EVIDENCE_DIR=<dir> keeps a screenshot of each screen; without it the checks still run.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { bounded, deferred } from "../server/relay/test-helpers.ts";
import { UsageService } from "../server/usage.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { relayBrowserSocket } from "./relay-browser-bridge.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const APP = "https://app.ovis.sh";
const ACCOUNT_SERVICE = "https://account.ovis.sh";
const RELAY = "wss://relay.test";
const PHONE = { width: 390, height: 844 } as const;
const DESK = { width: 1440, height: 900 } as const;
type Size = typeof PHONE | typeof DESK;
type Way = "address" | "row" | "launch";
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const cleanup: (() => unknown)[] = [];
const fake = new FakeAccountService();
// Step 2 on at the service: its PC list says how new each PC is (new_until)
fake.opensAll = true;

async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `relay-new-pc-press-${name}.png`) });
}

const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
cleanup.push(() => relay.stop());
const relayUrl = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`; };

/**
 * A PC of `account` of its own: its relay on, then added to that account in one press, as `ovis add` and the Mac app's
 * add over SSH end. One a device, so no join or row of another device is in its way (a PC asks the account service about
 * a join at most once in 10 seconds).
 */
async function newPc(account: string) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-new-pc-press-"));
  const synced = deferred<void>();
  const relayService = new RelayService({ stateDir: dir, relay: RELAY, connect: (url) => {
    const socket = new WebSocket(relayUrl(url));
    socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
    return socket;
  } });
  const pc = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
    relay: relayService, accountService: { url: ACCOUNT_SERVICE, fetch: (request) => fake.fetch(request) }, usage: new UsageService(undefined, []),
    tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(dir, "no-ssh"), readStatus: async () => null } });
  let stopped = false;
  const stop = async (): Promise<void> => { if (stopped) return; stopped = true; await relayService.shutdown(); pc.stop(); rmSync(dir, { recursive: true, force: true }); };
  cleanup.push(stop);
  const origin = `http://127.0.0.1:${pc.port}`;
  const own = (path: string, body?: unknown) => fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { origin, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await own("/api/relay/start", {})).status, 200, "the PC's relay starts");
  await bounded(synced.promise, 15_000);
  assert.equal((await own("/api/account/relay-account", { account })).status, 204, "the account is named for the PC");
  const identity = pc.context.services.relay.currentIdentity();
  assert.ok(identity, "the PC has a relay identity");
  // the owner's fresh sign-in lists the PC and admits it, and the PC takes the admission on its own key's proof
  const owner = fake.issueToken(account);
  const call = (path: string, method: string, body: unknown) => fake.fetch(new Request(`${ACCOUNT_SERVICE}${path}`, {
    method, headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const listed = await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "Desk", public_key: Buffer.from(importPublicKey(identity.public_key)).toString("hex"), relay: RELAY });
  assert.ok(listed.ok, `the PC is listed: ${listed.status} ${await listed.text()}`);
  const admitted = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  assert.ok(admitted.ok, `the PC is admitted: ${admitted.status} ${await admitted.text()}`);
  const pressed = await own("/api/account/one-press", { account });
  assert.equal(pressed.status, 200, `the PC takes the one press: ${await pressed.text()}`);
  const entry = fake.pcs(account).find((row) => row.server_id === identity.server_id);
  assert.ok(entry?.new_until != null && Date.parse(entry.new_until) > Date.now(), "the account lists the PC as new");
  const joins = async (): Promise<unknown[]> => {
    const answer = await own("/api/relay/joins");
    assert.equal(answer.status, 200, "the PC's own window lists its joins");
    return (await answer.json() as { joins: unknown[] }).joins;
  };
  return { id: identity.server_id, joins, stop };
}

/**
 * A device that signs in to an account of its own, whose key registers as `eligible` or not, reaching that account's new
 * PC `way` and pressing its sheet once: what the page shows after the press, and what reaches the PC.
 */
async function device(browser: Browser, site: string, size: Size, eligible: boolean, way: Way): Promise<void> {
  const name = `${size.width}-${eligible ? "eligible" : "not-eligible"}-${way}`;
  const account = `acct_${name.replaceAll("-", "_")}`;
  const pc = await newPc(account);
  // the provider's sign-in is that account's
  fake.signInAs("github", account);
  const mobile = size.width < 600;
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: "en-US" });
  cleanup.push(() => closeMarked(context));
  await context.addInitScript(() => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
  await context.route(/^https:\/\/app\.ovis\.sh\//, whileOpen(context, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${site}${url.pathname}${url.search}` }) });
  }));
  const keys: string[] = [];
  await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    // the device-key routes the fake leaves out: the sign-in's key goes in the account's list, eligible or not
    if (path === "/v1/devices/challenge") return route.fulfill({ status: 200, headers: cors, json: { challenge_id: "12".repeat(16), challenge: "register-this-sign-in" } });
    if (path === "/v1/devices" && request.method() === "POST") {
      const { key, label } = JSON.parse(request.postData() ?? "{}") as { key: string; label?: string };
      keys.push(key);
      return route.fulfill({ status: 200, headers: cors, json: { no: fake.registerDevice(account, key, label ?? "Phone", eligible), key } });
    }
    const body = request.postDataBuffer();
    const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
    // the provider's way back to the app is a new navigation, which the app.ovis.sh route serves
    const location = answer.headers.get("location");
    if (answer.status === 302 && location?.startsWith(`${APP}/`)) {
      return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
    }
    return route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
  });
  let sockets = 0;
  await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => { sockets += 1; relayBrowserSocket(ws, () => relayUrl(ws.url())); });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors: string[] = [], said: string[] = [], went: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") said.push(message.text()); });
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) went.push(frame.url()); });
  const where = async (): Promise<string> => `at ${page.url()}, relay state ${await page.locator("main[data-relay-state]").first().getAttribute("data-relay-state").catch(() => "none")}, sheet ${await page.locator("[data-add-pc-phase]").first().getAttribute("data-add-pc-phase").catch(() => "none")}; went ${went.join(" -> ")}; console ${said.join(" | ") || "quiet"}`;

  // a new tab signs in, which registers its key; its sign-in's launch is the launch this runs `way` "launch" by
  const joinsBefore = (await pc.joins()).length;
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".account-provider").first().click();
  await page.locator('main.relay-add-screen[data-account-state="signed-in"], [data-add-pc-phase], [data-approval-wait]').first().waitFor({ timeout: 45_000 });
  assert.equal(keys.length, 1, `${name}: the sign-in registered one key (${await where()})`);

  if (way === "address") await page.goto(`${APP}/s/${pc.id}/`, { waitUntil: "domcontentloaded" });
  else if (way === "row") {
    // My PCs, as a PC's More opens it: a front page with a fragment, which launches nothing
    await page.goto(`${APP}/#add`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('main.relay-add-screen[data-account-state="signed-in"] a.relay-add-saved-pc').filter({ hasText: "Desk" }).click();
  }
  const sheet = page.locator('[role=dialog][data-add-pc-phase="confirm"]');
  await sheet.waitFor({ timeout: 45_000 });
  assert.equal(new URL(page.url()).pathname, `/s/${pc.id}/`, `${name}: the sheet is on the PC's own page (${await where()})`);
  // nothing opens it, and nothing reaches it, before the press: no join, and no relay connection once the sheet is up
  // (a launch's and My PCs' checks of whether the PC is on open theirs before)
  const socketsBefore = sockets;
  // fixed wait: what a sheet that went on by itself would have sent by then
  await page.waitForTimeout(1_500);
  assert.equal(await page.locator('[data-add-pc-phase="confirm"]').count(), 1, `${name}: the sheet waits for its press (${await where()})`);
  assert.deepEqual({ joins: (await pc.joins()).length - joinsBefore, sockets: sockets - socketsBefore }, { joins: 0, sockets: 0 }, `${name}: nothing reached the PC before the press (${await where()})`);
  await shot(page, `${name}-sheet`);

  await sheet.locator("[data-sheet-primary]").click();
  if (eligible) {
    // opened through the account: the app on the PC's page, and no join
    try { await page.locator(".conn-live").waitFor({ state: "attached", timeout: 45_000 }); }
    catch (error) { throw new Error(`${name}: the press did not open the PC (${await where()})`, { cause: error }); }
    assert.equal(new URL(page.url()).pathname, `/s/${pc.id}/`, `${name}: the app is on the PC's page`);
    assert.equal((await pc.joins()).length - joinsBefore, 0, `${name}: no join reached the PC`);
  } else {
    // the account way refused (auth_failed): the same press's join reaches the PC's own window, and the page shows the
    // number beside the PC's Allow, still on the PC's page
    const deadline = Date.now() + 45_000;
    while ((await pc.joins()).length === joinsBefore) {
      if (Date.now() > deadline) throw new Error(`${name}: no join reached the PC after the press (${await where()})`);
      // fixed wait: the PC's list is polled, it tells nobody of a join
      await page.waitForTimeout(200);
    }
    try { await page.locator('[role=dialog][data-add-pc-phase="compare"]').waitFor({ timeout: 20_000 }); }
    catch (error) { throw new Error(`${name}: the page does not show the join's number (${await where()})`, { cause: error }); }
    assert.equal(new URL(page.url()).pathname, `/s/${pc.id}/`, `${name}: the join waits on the PC's page (${await where()})`);
    assert.equal((await pc.joins()).length - joinsBefore, 1, `${name}: one join, once`);
  }
  await shot(page, `${name}-after`);
  assert.deepEqual(errors, [], `${name}: no page error`);
  await closeMarked(context);
  await pc.stop();
  console.log(`ok ${name}`);
}

const shellDir = join(import.meta.dir, "..", "dist-shell");
let code = 0;
try {
  if (!existsSync(join(shellDir, "index.html"))) throw new Error("no dist-shell/: run bun run build:shell first");
  const site = servePagesSite(shellDir, 0, "127.0.0.1");
  cleanup.push(() => site.stop(true));
  const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ["--no-sandbox"] });
  cleanup.push(() => closeMarked(browser));
  const at = `http://127.0.0.1:${site.port}`;
  for (const eligible of [false, true]) {
    for (const [size, way] of [[PHONE, "address"], [DESK, "address"], [PHONE, "row"], [DESK, "row"], [PHONE, "launch"], [DESK, "launch"]] as const) await device(browser, at, size, eligible, way);
  }
  console.log("PASS relay new PC press: at 390 and 1440, from the PC's address, its row on My PCs and a launch, a new PC's sheet waits for its press with nothing sent; a device the PC does not list gets the press's join on the same page, and an eligible one is opened through the account with no join");
} catch (error) {
  code = 1;
  console.error("FAIL relay new PC press:", error);
} finally {
  for (const close of cleanup.reverse()) {
    try { await close(); } catch { /* the run's own result stands */ }
  }
}
process.exit(code);
