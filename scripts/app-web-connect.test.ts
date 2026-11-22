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

async function chooser(saved: string[], account = true) {
  page = await browser.newPage({ locale: "en-US" });
  await page.addInitScript((saved) => {
    Object.assign(window, { Capacitor: { getPlatform: () => "ios", nativePromise: async (_plugin: string, method: string, args: { url?: string }) => {
      if (method === "getState") return { saved, names: {} };
      if (method === "open") console.info(`open:${args.url}`);
      return {};
    } } });
  }, saved);
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
