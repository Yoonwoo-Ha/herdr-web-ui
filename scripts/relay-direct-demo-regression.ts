import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsFolds, openSettingsPage } from "./settings-page.ts";
import { serveDemo } from "./demo-server.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US" });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en", theme }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?demo_relay=on`);
  await page.locator(".conn-live").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
  await openSettingsFolds(page);
  const group = page.locator('[data-section="devices-more"]');
  const row = group.locator(".settings-row", { has: page.getByRole("switch", { name: "Direct connection" }) });
  const toggle = row.getByRole("switch", { name: "Direct connection" });
  await row.getByText("Direct connection", { exact: true }).waitFor();
  await row.getByText("Relay connections stay on the relay.", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false", `${tag}: off by default`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);
  await row.scrollIntoViewIfNeeded();
  if (EVIDENCE) await group.screenshot({ path: join(EVIDENCE, `relay-direct-${width}-${theme}.png`) });

  await toggle.click();
  await row.getByText("The Ovis app on a phone that reaches this PC on the same Wi-Fi or over Tailscale moves to a direct connection: faster, and this PC listens for it on those addresses.", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true", `${tag}: turned on`);
  await row.getByText("Direct connection", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll, on`);
  if (EVIDENCE) await group.screenshot({ path: join(EVIDENCE, `relay-direct-on-${width}-${theme}.png`) });
  await toggle.click();
  await row.getByText("Relay connections stay on the relay.", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false", `${tag}: turned off again`);
  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS relay direct ${tag}`);
}

async function notices(browser: Browser, origin: string): Promise<void> {
  for (const [fixture, kind] of [["grace", "sign-in-grace"], ["data-limit", "data-limit"]] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en" }));
    const page = await context.newPage();
    await page.goto(`${origin}?demo_relay_pass=${fixture}`);
    await page.locator(`[data-testid="relay-notice"][data-relay-notice="${kind}"]`).waitFor({ timeout: 15_000 });
    await context.close();
    console.log(`PASS relay notice ${fixture}`);
  }
}

const app = mkdtempSync(join(tmpdir(), "ovis-relay-direct-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = serveDemo(app);
  try {
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const origin = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
      for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, origin, width, theme);
      await notices(browser, origin);
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
