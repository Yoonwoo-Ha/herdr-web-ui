/**
 * More → Connect a PC on a phone's PC page of the hosted app opens Add a PC (`/#add`) and stays there; Add a PC's own
 * Back and the browser's land on the PC page it was opened from, and Back from that page leaves it in one press, with the
 * sheet closed throughout.
 *
 * The More sheet closes with a step back off its own history entry. An item that starts loading another page before
 * that step has landed loses it to the step: Chromium cancels the load for it, Android's WebView lands it after the new
 * page and brings the PC page back, whenever the new page takes longer to answer than the step takes to land, as `/`
 * does over a phone's network. So the page's network is given a phone's round trip (DevTools latency) as the item is
 * tapped, and the run prints the order of the history steps, popstates and navigations it saw.
 *
 * The hosted shell (dist-shell/ from `bun run build:shell`, or the folder given as the first argument, served as
 * Cloudflare Pages serves it) at 390 px with touch, one real PC (createServer on the isolated herdr test session)
 * paired with the browser through a Bun relay (relay/bun.ts), as offline-typing-relay-regression.ts pairs it.
 * UI_EVIDENCE_DIR=<dir> keeps the screenshots and the order of events.
 *
 *   bun run build:shell && bun scripts/add-pc-more-relay-regression.ts [shell dir]
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { relayBrowserSocket } from "./relay-browser-bridge.ts";

const repo = join(import.meta.dir, "..");
const shell = process.argv[2] ? resolve(process.argv[2]) : join(repo, "dist-shell");
if (!existsSync(join(shell, "index.html"))) throw new Error(`${shell} holds no shell: build it first (bun run build:shell)`);
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });

const RELAY = "wss://relay.test";
/** a phone's round trip to app.ovis.sh: the More sheet's step lands well within it */
const PHONE_LATENCY_MS = 150;
/** Android's WebView brought the PC page back about 30 ms after `/` loaded: a page that holds this long stays */
const STAYS_MS = 2_000;
const LOAD_MS = 20_000;

const root = mkdtempSync(join(tmpdir(), "ovis-add-pc-more-"));
const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
const relayAddress = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`; };
const site = servePagesSite(shell, 0);
const origin = `http://127.0.0.1:${site.port}`;
const stateDir = mkdtempSync(join(root, "state-"));
const dir = mkdtempSync(join(root, "files-"));
const synced = Promise.withResolvers<void>();
const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
  const socket = new WebSocket(relayAddress(url));
  socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
  return socket;
} });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service, pushLoopbackHttp: true, accountOpensAll: false });
const base = `http://127.0.0.1:${app.port}`;
const post = (path: string): Promise<Response> => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
let browser: Browser | undefined;
let workspaceId: string | null = null;

/** The page's address and whether a sheet is up. */
async function place(page: Page): Promise<{ path: string; hash: string; sheet: boolean }> {
  return await page.evaluate(() => ({ path: location.pathname, hash: location.hash, sheet: document.querySelector(".row-sheet") !== null }));
}

/**
 * The tab's history as the browser keeps it, each entry by its own id. Not the Navigation API's: each page sees only
 * a part of it, and two pages of the same tab may see different parts (the PC page here left out the pairing page's
 * entry that Add a PC listed), so its indexes do not compare across pages.
 */
async function tabHistory(cdp: CDPSession): Promise<{ current: number; ids: number[]; text: string }> {
  const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
  const text = entries.map((entry, index) => `${index === currentIndex ? "*" : ""}${entry.id} ${new URL(entry.url).pathname}${new URL(entry.url).hash.replace(/^#(ws|offer)=.*/, "#$1…")}`).join(" | ");
  return { current: currentIndex, ids: entries.map((entry) => entry.id), text };
}

/** Every history step, popstate and navigation of the tab, in the order one DevTools session saw them. */
async function watchOrder(page: Page): Promise<{ cdp: CDPSession; order: string[]; mark: (what: string) => void }> {
  const order: string[] = [];
  let started = Date.now();
  const at = (): string => `${String(Date.now() - started).padStart(5)} ms`;
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Runtime.consoleAPICalled", (event) => {
    const text = event.args.map((arg) => String(arg.value ?? "")).join(" ");
    if (text.startsWith("[order] ")) order.push(`${at()}  page: ${text.slice(8)}`);
  });
  const where = (url: string): string => { const parsed = new URL(url); return parsed.pathname + parsed.hash; };
  cdp.on("Page.frameRequestedNavigation", (event) => order.push(`${at()}  load asked: ${where(event.url)} (${event.reason})`));
  cdp.on("Page.navigatedWithinDocument", (event) => order.push(`${at()}  same-document entry: ${where(event.url)} (${event.navigationType})`));
  cdp.on("Page.frameNavigated", (event) => { if (event.frame.parentId === undefined) order.push(`${at()}  new page committed: ${where(event.frame.url)}${event.frame.urlFragment ?? ""}`); });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  const mark = (what: string): void => { if (order.length === 0) started = Date.now(); order.push(`${at()}  tap: ${what}`); };
  return { cdp, order, mark };
}

try {
  const started = await post("/start");
  assert.equal(started.status, 200, `relay start: ${await started.text()}`);
  await synced.promise;
  const response = await post("/offer");
  const body = await response.text();
  assert.equal(response.status, 200, `offer: ${body}`);
  const offer = decodeOffer((JSON.parse(body) as { url: string }).url);
  assert.ok(offer, "the PC gave no offer");
  const pcPage = `/s/${offer.server_id}/`;
  // a pane of its own, opened by its address: the page writes no entry of its own after it loads (it would move onto a
  // pane it picked by itself), so the PC page's entry is where it stands once the pane's address is on it
  const created = await workspaceCreate({ cwd: dir, label: "add-pc-more" });
  workspaceId = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;

  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light", locale: "en-US" });
  await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => relayBrowserSocket(ws, () => relayAddress(ws.url())));
  await context.addInitScript(() => {
    if (window !== window.top) return;
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    // what the history is asked to do, told before it happens
    for (const name of ["back", "forward", "go"] as const) {
      const own = History.prototype[name] as (...args: unknown[]) => void;
      History.prototype[name] = function (this: History, ...args: unknown[]) { console.debug(`[order] history.${name}(${args.join(", ")})`); return own.apply(this, args); } as never;
    }
    window.addEventListener("popstate", () => console.debug(`[order] popstate on ${location.pathname}${location.hash}`));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(LOAD_MS);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = async (name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `add-pc-more-${name}.png`), animations: "disabled" }); };

  // paired by the PC's offer, then on the PC's page by a pane's address, as a phone opens it again
  await page.goto(encodeOffer({ ...offer, name: "Desk PC" }, origin));
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.locator(".app").waitFor();
  await page.goto(`${origin}${pcPage}?pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".app").waitFor();
  await page.waitForFunction((pane) => new URLSearchParams(location.hash.slice(1)).get("pane") === pane, pane);
  const before = await place(page);
  assert.equal(before.path, pcPage, "the PC page is open by its address");
  assert.equal(before.sheet, false, "no sheet is up on the PC page");
  const tab = await context.newCDPSession(page);
  const opened = await tabHistory(tab);
  /** the PC page's own entry: Add a PC goes one over it, and every Back from Add a PC lands on it */
  const pcEntry = opened.ids[opened.current]!;
  const pcEntryIndex = opened.current;

  const more = page.locator("button.header-more-button").filter({ visible: true }).first();
  const item = page.locator('.row-sheet [data-item="add-pc"]');
  const addScreen = page.locator("main.relay-add-screen .relay-add-back");

  /** More → Connect a PC over a phone's round trip: Add a PC opens one entry over the PC page and stays. */
  async function connectAPc(round: string): Promise<void> {
    const { cdp, order, mark } = await watchOrder(page);
    const report = (): string => `order of events (${round}):\n${order.join("\n")}`;
    const at = await place(page);
    const standing = await tabHistory(tab);
    assert.deepEqual({ entry: standing.ids[standing.current], path: at.path, sheet: at.sheet }, { entry: pcEntry, path: pcPage, sheet: false }, `${round}: the PC page stands on its own entry before More (${standing.text})`);
    mark("More");
    await more.tap();
    await item.waitFor();
    await shot(`${round}-more`);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: PHONE_LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 });
    mark("Connect a PC");
    await item.tap();
    const loaded = await page.waitForURL((url) => url.pathname === "/" && url.hash === "#add", { timeout: LOAD_MS }).then(() => true, () => false);
    if (!loaded) {
      await shot(`${round}-stayed`);
      const now = await place(page).catch(() => null);
      assert.fail(`${round}: More → Connect a PC never opened Add a PC: the tab stayed on ${now === null ? page.url() : now.path + now.hash}${now?.sheet ? " with the sheet up" : ", the sheet closed"}\n${report()}`);
    }
    await addScreen.waitFor();
    // fixed wait: nothing may take the tab back to the PC page in this time (Android's WebView did after about 30 ms)
    await page.waitForTimeout(STAYS_MS);
    const added = await place(page);
    await shot(`${round}-add`);
    assert.equal(added.path + added.hash, "/#add", `${round}: Add a PC stays open for ${STAYS_MS} ms, not taken back to the PC page\n${report()}`);
    assert.equal(await addScreen.count(), 1, `${round}: Add a PC is on screen`);
    // the tab's history ends [..., PC page, Add a PC]: the sheet's entry went with the step back, and nothing is ahead
    const history = await tabHistory(tab);
    assert.deepEqual({ under: history.ids[history.current - 1], at: history.current, ahead: history.ids.length - history.current - 1 }, { under: pcEntry, at: pcEntryIndex + 1, ahead: 0 },
      `${round}: Add a PC is one entry over the PC page it was opened from, with no entry of the closed sheet between them and none ahead (${history.text})\n${report()}`);
    if (evidence) writeFileSync(join(evidence, `add-pc-more-order-${round}.txt`), `${report()}\n`);
    console.log(report());
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.detach();
  }

  /** Back from Add a PC lands on the PC page it was opened from, with the sheet closed. */
  async function backOnPcPage(round: string): Promise<void> {
    await page.waitForURL((url) => url.pathname === pcPage);
    await page.locator(".app").waitFor();
    const back = await place(page);
    const history = await tabHistory(tab);
    await shot(`${round}-back`);
    assert.deepEqual({ entry: history.ids[history.current], path: back.path, sheet: back.sheet }, { entry: pcEntry, path: pcPage, sheet: false }, `${round}: Back from Add a PC lands on the PC page it was opened from, its sheet closed (${history.text})`);
  }

  // Add a PC's own Back, then the browser's (a phone's Back button)
  await connectAPc("own-back");
  await addScreen.tap();
  await backOnPcPage("own-back");
  await connectAPc("browser-back");
  await page.goBack();
  await backOnPcPage("browser-back");

  // Back from the PC page leaves it in one press: no entry of the sheet is left over it
  await page.goBack();
  const left = await place(page);
  const history = await tabHistory(tab);
  assert.equal(history.current, pcEntryIndex - 1, `Back from the PC page leaves it in one press (${history.text}; the PC page was entry ${pcEntry})`);
  assert.equal(left.sheet, false, "Back from the PC page opens no sheet");
  assert.deepEqual(errors, [], "no page errors");
  await context.close();
  console.log(`PASS More → Connect a PC opens Add a PC over a phone's round trip (${PHONE_LATENCY_MS} ms) and it stays; Add a PC's Back and the browser's land on the PC page, whose Back leaves it in one press`);
} finally {
  await browser?.close();
  site.stop(true);
  await service.shutdown();
  app.stop();
  await relay.stop();
  if (workspaceId !== null) await workspaceClose(workspaceId).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
