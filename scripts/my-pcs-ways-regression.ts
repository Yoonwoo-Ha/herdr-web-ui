/**
 * My PCs in the phone app, a PC saved by several ways: the hosted shell (dist-shell/ from `bun run build:shell`, or the
 * folder given as the first argument, served as Cloudflare Pages serves it), the phone app's shell plugin stood in for
 * (window.Capacitor answering HerdrShell's getState with the PCs it saved and the relay ID each one's page told it),
 * at 390 px with touch and at 1440. No PC, relay or herdr is needed: these rows come from the app's saved list.
 *
 * - A row of one way keeps the whole row, its link as wide as the row, whether or not a row of several is in the list:
 *   the column More ways takes is not taken from it.
 * - More ways is on the row of several alone, closed, a button of its own beside the row's link, and what it controls
 *   is on the page while closed; open, a line per other saved way with its tag and its whole host, never cut, and no
 *   sideways scroll.
 * - A line of a Tailscale way, with Tailscale off on the phone, ends in the Tailscale-off card and opens nothing; the
 *   row's own tap still opens the way it opened before.
 *
 * UI_EVIDENCE_DIR=<dir> keeps a screenshot of each list.
 *
 *   bun run build:shell && bun scripts/my-pcs-ways-regression.ts [shell dir]
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";

const repo = join(import.meta.dir, "..");
const shell = process.argv[2] ? resolve(process.argv[2]) : join(repo, "dist-shell");
if (!existsSync(join(shell, "index.html"))) throw new Error(`${shell} holds no shell: build it first (bun run build:shell)`);
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });

const MAC = "b".repeat(32);
const desk = "https://desk.tail1e211e.ts.net";
const tail = "https://macbookpro.tail1e211e.ts.net:17317";
const lan = "http://192.168.0.5:7317";

interface App { readonly saved: readonly string[]; readonly names?: Readonly<Record<string, string>>; readonly ids: Readonly<Record<string, string>> }

/** A page of the hosted shell in a phone app that saved `app`'s PCs, with Tailscale off on the phone. */
async function open(browser: Browser, origin: string, width: number, app: App): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width === 390;
  // reduced motion: More ways' glyph turns at once, so a picture never catches it half way
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript((saved: App) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    const calls: string[] = [];
    (window as unknown as { nativeCalls: string[] }).nativeCalls = calls;
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true, getPlatform: () => "android",
      PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "forget", "tailscale", "openTailscale"].map((name) => ({ name })) }],
      nativePromise: (plugin: string, method: string, options: Record<string, unknown> = {}) => {
        calls.push(`${plugin}.${method}${typeof options["url"] === "string" ? ` ${options["url"]}` : ""}`);
        if (method === "getState") return Promise.resolve({ saved: saved.saved, names: saved.names ?? {}, ids: saved.ids });
        if (method === "tailscale") return Promise.resolve({ on: false });
        // the open of a PC never answers here: the page says it is opening, which is enough
        if (method === "open") return new Promise(() => {});
        return Promise.resolve({});
      },
    };
  }, app);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  return { page, errors, close: () => context.close() };
}

const list = (page: Page) => page.locator('[data-view="my-pcs"]:not([hidden])');
const row = (page: Page, text: string) => list(page).locator("li.my-pc", { hasText: text });

/** a row's width and its link's, in CSS pixels */
async function widths(page: Page, text: string): Promise<{ row: number; link: number }> {
  return await row(page, text).evaluate((item) => ({ row: Math.round(item.getBoundingClientRect().width), link: Math.round(item.querySelector(".relay-add-saved-pc")!.getBoundingClientRect().width) }));
}

const site = servePagesSite(shell, 0);
const origin = `http://127.0.0.1:${site.port}`;
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [390, 1440]) {
    const tag = `${width}px`;
    // two rows of one way each: nothing beside either link
    const alone = await open(browser, origin, width, { saved: [desk, tail], ids: {} });
    await row(alone.page, "macbookpro").waitFor();
    assert.equal(await list(alone.page).locator('[data-action="more-ways"]').count(), 0, `${tag}: no More ways without a row of several`);
    const before = await widths(alone.page, "desk");
    assert.ok(Math.abs(before.row - before.link) <= 1, `${tag}: a row of one way is its link, whole (${JSON.stringify(before)})`);
    if (evidence) await list(alone.page).screenshot({ path: join(evidence, `my-pcs-one-way-${width}.png`) });
    assert.deepEqual(alone.errors, [], `${tag}: no page errors`);
    await alone.close();

    // the same desk row beside a PC saved by its address and its Tailscale address, which opens by the address (loaded last)
    const several = await open(browser, origin, width, { saved: [desk, lan, tail], names: { [lan]: "macbookpro", [tail]: "macbookpro" }, ids: { [lan]: MAC, [tail]: MAC } });
    const { page } = several;
    const mac = row(page, "Tailscale · Address");
    await mac.waitFor();
    const beside = await widths(page, "desk");
    assert.deepEqual(beside, before, `${tag}: a row of one way keeps its width beside a row of several`);
    const more = list(page).locator('[data-action="more-ways"]');
    assert.equal(await more.count(), 1, `${tag}: More ways on the row of several alone`);
    assert.equal(await mac.locator('[data-action="more-ways"]').count(), 1, `${tag}: More ways is the row of several's`);
    assert.equal(await mac.locator('.relay-add-saved-pc [data-action="more-ways"]').count(), 0, `${tag}: More ways is not inside the row's link`);
    assert.equal(await more.getAttribute("aria-expanded"), "false", `${tag}: closed at first`);
    assert.equal(await more.getAttribute("aria-label"), "More ways to open macbookpro", `${tag}: named for its PC`);
    const controlled = page.locator(`[id="${await more.getAttribute("aria-controls")}"]`);
    assert.equal(await controlled.count(), 1, `${tag}: what More ways controls is on the page while closed`);
    assert.equal(await controlled.isHidden(), true, `${tag}: and hidden`);
    if (evidence) await list(page).screenshot({ path: join(evidence, `my-pcs-ways-closed-${width}.png`) });

    if (width === 390) await more.tap(); else await more.click();
    assert.equal(await more.getAttribute("aria-expanded"), "true", `${tag}: open`);
    const lines = mac.locator('[data-action="open-other-way"]');
    await lines.first().waitFor();
    assert.deepEqual(await lines.evaluateAll((buttons) => buttons.map((button) => [button.getAttribute("aria-label"), (button.textContent ?? "").replace(/\s+/g, " ").trim()])),
      [["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)", "TailscaleOpen macbookpro.tail1e211e.ts.net:17317"]], `${tag}: one line per other way, its tag and whole host`);
    assert.equal(await lines.first().locator(".relay-add-other-way-host").evaluate((host) => host.scrollWidth <= host.clientWidth + 1 && getComputedStyle(host).textOverflow !== "ellipsis"), true, `${tag}: the host is never cut`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);
    assert.deepEqual(await widths(page, "desk"), before, `${tag}: a row of one way keeps its width with More ways open`);
    if (evidence) await list(page).screenshot({ path: join(evidence, `my-pcs-ways-open-${width}.png`) });

    // the Tailscale line meets Tailscale off on the phone: the card, and nothing opened
    if (width === 390) await lines.first().tap(); else await lines.first().click();
    await page.locator("[data-tailscale-off]").first().waitFor();
    const calls = (): Promise<string[]> => page.evaluate(() => (window as unknown as { nativeCalls: string[] }).nativeCalls.filter((call) => call.startsWith("HerdrShell.open ")));
    assert.deepEqual(await calls(), [], `${tag}: the Tailscale line opens nothing while Tailscale is off`);
    // the row's own tap opens the way it opened before: the address, which loaded last
    const link = mac.locator(".relay-add-saved-pc");
    if (width === 390) await link.tap(); else await link.click();
    await page.waitForFunction(() => (window as unknown as { nativeCalls: string[] }).nativeCalls.some((call) => call.startsWith("HerdrShell.open ")));
    assert.deepEqual(await calls(), [`HerdrShell.open ${lan}/`], `${tag}: the row's own tap is unchanged`);
    assert.deepEqual(several.errors, [], `${tag}: no page errors`);
    await several.close();
    console.log(`PASS My PCs at ${tag}: a row of one way keeps the whole row beside a row of several; More ways, closed at first and controlling a list that is on the page, lists the other way with its whole host; its Tailscale line meets Tailscale off with the card; the row's tap is unchanged`);
  }
} finally {
  await browser?.close();
  site.stop(true);
}
