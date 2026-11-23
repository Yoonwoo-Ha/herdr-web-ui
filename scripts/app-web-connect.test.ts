import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

/** The phone app's connect screen (app/web), served as the app serves it. */
const WEB = new URL("../app/web/", import.meta.url);
// skipped, not failed, on a machine with no browser to drive (the browser lane always has one)
const noBrowser = !existsSync(chromePath());

let browser: Browser;
let page: Page;
beforeAll(async () => { if (!noBrowser) browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });

async function chooser(saved: string[], account = true, state: Record<string, unknown> = {}, locale = "en-US") {
  page = await browser.newPage({ locale });
  await page.addInitScript(({ saved, state }) => {
    Object.assign(window, { Capacitor: { getPlatform: () => "ios", nativePromise: async (_plugin: string, method: string, args: { url?: string }) => {
      if (method === "getState") return { saved, names: {}, ...state };
      if (method === "open") console.info(`open:${args.url}`);
      if (method === "goHome" || method === "backToCurrent" || method === "openDemo") console.info(`asked:${method}`);
      return {};
    } } });
  }, { saved, state });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "chooser.test") return route.fulfill({ json: { providers: [], device: [] } });
    const file = Bun.file(new URL(`.${url.pathname}`, WEB));
    if (!(await file.exists())) return route.fulfill({ status: 404 });
    const text = await file.text();
    return route.fulfill({ contentType: file.type, body: !account && url.pathname === "/shell.js" ? text.replace("ACCOUNT_SIGN_IN = true", "ACCOUNT_SIGN_IN = false") : text });
  });
  await page.goto("https://chooser.test/index.html");
}

test.skipIf(noBrowser)("a broken saved address does not prevent opening a later saved public HTTP PC", async () => {
  const pc = "http://desk.example.org:7317";
  await chooser(["not an address", pc]);
  await page.locator("#tab-ssh").click();
  const outcome = new Promise<string>((resolve) => {
    page.once("pageerror", (error) => resolve(error.message));
    page.on("console", (message) => { if (message.text().startsWith("open:")) resolve(message.text()); });
  });
  await page.getByRole("button", { name: "Open desk.example.org:7317", exact: true }).click();
  expect(await outcome).toBe(`open:${pc}/`);
});

/** What the page asks of the app (the stub's `asked:` lines) when `press` is done. */
async function asked(press: () => Promise<void>): Promise<string> {
  const outcome = new Promise<string>((resolve) => {
    page.once("pageerror", (error) => resolve(error.message));
    page.on("console", (message) => { if (message.text().startsWith("asked:")) resolve(message.text()); });
  });
  await press();
  return await outcome;
}

test.skipIf(noBrowser)("standing in for the hosted screen that did not load, it says so in one line, and Try again asks for that screen", async () => {
  await chooser([], true, { fallback: true });
  const line = page.locator("#offline");
  await line.waitFor({ state: "visible", timeout: 5_000 });
  expect(await line.locator("span").textContent()).toBe("Can't connect to the internet");
  // above the screen's title, and nothing else of the page changes: its tabs are all there
  expect(await page.evaluate(() => (document.getElementById("offline")!.compareDocumentPosition(document.querySelector("h1")!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)).toBe(true);
  expect(await page.locator('[role="tab"]:visible').count()).toBe(3);
  expect(await asked(() => page.getByRole("button", { name: "Try again", exact: true }).click())).toBe("asked:goHome");
});

test.skipIf(noBrowser)("the line is in Korean on a Korean phone", async () => {
  await chooser([], true, { fallback: true }, "ko-KR");
  await page.locator("#offline").waitFor({ state: "visible", timeout: 5_000 });
  expect(await page.locator("#offline span").textContent()).toBe("인터넷에 연결할 수 없어요");
  expect(await page.locator("#try-home").textContent()).toBe("다시 시도");
});

test.skipIf(noBrowser)("as the app's first screen, or opened to choose another PC, it has no such line", async () => {
  await chooser(["https://desk.example.ts.net"], true, { current: "https://desk.example.ts.net", choosing: true, back: "current" });
  await page.locator("#back-to-pc").waitFor({ state: "visible", timeout: 5_000 });
  expect(await page.locator("#offline").isVisible()).toBe(false);
  expect(await asked(() => page.locator("#back-to-pc").click())).toBe("asked:backToCurrent");
});

test.skipIf(noBrowser)("opened by the hosted screen for what only it can take, its back control leads to that screen", async () => {
  await chooser([], true, { back: "home" });
  const back = page.locator("#back-to-pc");
  await back.waitFor({ state: "visible", timeout: 5_000 });
  expect(await back.getAttribute("aria-label")).toBe("Back to Connect a PC");
  expect(await page.locator("#offline").isVisible()).toBe(false);
  expect(await asked(() => back.click())).toBe("asked:goHome");
});

test.skipIf(noBrowser)("opened over a PC that stays current, with nobody choosing, its back control leads to that PC", async () => {
  // a pairing link from outside the app that this page refused: the app opens that PC next, so Back says so
  const pc = "https://desk.example.ts.net";
  await chooser([pc], true, { current: pc, choosing: false, back: "current" });
  const back = page.locator("#back-to-pc");
  await back.waitFor({ state: "visible", timeout: 5_000 });
  expect(await back.textContent()).toBe("‹ desk");
  expect(await back.getAttribute("aria-label")).toBe("Back to desk");
  expect(await asked(() => back.click())).toBe("asked:backToCurrent");
});

test.skipIf(noBrowser)("asked for to manage an SSH PC, it opens on SSH", async () => {
  await chooser([], true, { manage: true, back: "home" });
  await page.locator("#panel-ssh").waitFor({ state: "visible", timeout: 5_000 });
  expect(await page.locator("#tab-ssh").getAttribute("aria-selected")).toBe("true");
  expect(await page.locator("#back-to-pc").isVisible()).toBe(true);
});

test.skipIf(noBrowser)("the word demo asks the app for its demo where this page stands in for the hosted screen", async () => {
  await chooser([], true, { fallback: true });
  await page.locator("#tab-ssh").click();
  await page.locator("#by-address").click();
  await page.locator("#web-address").fill("demo");
  expect(await asked(() => page.locator("#web-address").press("Enter"))).toBe("asked:openDemo");
  expect(new URL(page.url()).pathname).toBe("/index.html");
});

test.skipIf(noBrowser)("in a build whose first screen this page is, the word demo goes to the demo itself", async () => {
  page = await browser.newPage({ locale: "en-US" });
  await page.addInitScript(() => {
    Object.assign(window, { Capacitor: { getPlatform: () => "ios", nativePromise: async (_plugin: string, method: string) => method === "getState" ? { saved: [], names: {} } : {} } });
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "chooser.test") return route.fulfill({ json: { providers: [], device: [] } });
    if (url.pathname === "/demo/index.html") return route.fulfill({ contentType: "text/html", body: "<title>demo</title>" });
    const file = Bun.file(new URL(`.${url.pathname}`, WEB));
    if (!(await file.exists())) return route.fulfill({ status: 404 });
    const text = await file.text();
    return route.fulfill({ contentType: file.type, body: url.pathname === "/shell.js" ? text.replace('APP_HOME = "hosted"', 'APP_HOME = "bundled"') : text });
  });
  await page.goto("https://chooser.test/index.html");
  await page.locator("#tab-ssh").click();
  await page.locator("#by-address").click();
  await page.locator("#web-address").fill("demo");
  await page.locator("#web-address").press("Enter");
  await page.waitForURL("https://chooser.test/demo/index.html", { timeout: 5_000 });
});
