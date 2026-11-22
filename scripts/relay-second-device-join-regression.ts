/**
 * A second device of the account, signed in, finds the account's PCs it is not in yet on Add a PC (/#add; the signed-in front page lists only its own, #16),
 * each noted Needs approval, and joins one from that PC's own page: m1-box, which the directory heard from, asks to
 * join (the join sheet); desk2, never seen and new in the account, takes the number its own screen shows (the new
 * sheet). Escape leaves the sheet for the front page. The shell is the real build on https://app.ovis.sh (routed
 * here), the account service the in-memory fake with the directory answered here and no device-key route (404, as one
 * without device keys answers), so a PC's page offers its join sheet instead of opening by the account's key; no relay
 * or PC takes part (every WebSocket is closed at once), so nothing is paired.
 *
 * The shell is SHELL_DIR when set, else dist-shell/, else a build of its own when neither is there.
 *
 *   UI_EVIDENCE_DIR=<dir> bun scripts/relay-second-device-join-regression.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { generateKeyPair } from "../shared/relay-e2ee.ts";
import { translate } from "../src/lib/i18n.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const APP = "https://app.ovis.sh";
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });
const root = join(import.meta.dir, "..");

const machines = [{ label: "m1-box", seenAgo: 30_000 }, { label: "desk2", seenAgo: null }].map((spec) => {
  const { publicKey } = generateKeyPair();
  return { ...spec, server_id: deriveServerId(publicKey), public_key: Buffer.from(publicKey).toString("hex") };
});
const directory = () => machines.map((pc) => ({
  server_id: pc.server_id, label: pc.label, public_key: pc.public_key, relay: "wss://relay.ovis.sh",
  added_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  last_seen_at: pc.seenAgo === null ? null : new Date(Date.now() - pc.seenAgo).toISOString(),
}));

const fail = (what: string): never => { throw new Error(what); };
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));

const laneShell = join(root, "dist-shell");
let shellDir = process.env["SHELL_DIR"] || (existsSync(join(laneShell, "index.html")) ? laneShell : null);
const built = shellDir === null ? mkdtempSync(join(tmpdir(), "ovis-second-device-join-")) : null;
let code = 0;
try {
  if (built !== null) {
    const build = Bun.spawn([process.execPath, "--bun", join(root, "node_modules/.bin/vite"), "build", "--mode", "shell", "--outDir", built, "--emptyOutDir", "--logLevel", "warn"], {
      cwd: root, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    if (await build.exited !== 0) fail("the shell build failed");
    shellDir = built;
  }
  const site = servePagesSite(shellDir!, 0, "127.0.0.1");
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const cases = [
      ...[390, 1440].flatMap((width) => (["light", "dark"] as const).map((theme) => ({ width, theme, language: "en" as const }))),
      ...(["light", "dark"] as const).map((theme) => ({ width: 390, theme, language: "ko" as const })),
    ];
    for (const { width, theme, language } of cases) {
      const name = `${width}-${theme}-${language}`;
      const phone = width < 600;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone,
        deviceScaleFactor: phone ? 2 : 1, locale: language === "ko" ? "ko-KR" : "en-US", serviceWorkers: "block",
      });
      try {
        const fake = new FakeAccountService();
        const errors: string[] = [];
        await context.route(/.*/, async (route) => { errors.push(`unexpected request ${route.request().url()}`); await route.abort(); });
        await context.route(/^https:\/\/app\.ovis\.sh\//, whileOpen(context, async (route) => {
          const url = new URL(route.request().url());
          await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${site.port}${url.pathname}${url.search}` }) });
        }));
        await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
          const request = route.request();
          const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
          if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
          if (new URL(request.url()).pathname === "/v1/devices/challenge") { await route.fulfill({ status: 404, headers: cors }); return; }
          if (request.method() === "GET" && new URL(request.url()).pathname === "/v1/pcs" && request.headers()["authorization"]) {
            await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ pcs: directory() }) });
            return;
          }
          const body = request.postDataBuffer();
          const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
          const location = answer.headers.get("location");
          if (answer.status === 302 && location?.startsWith(APP)) {
            await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
            return;
          }
          await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
        });
        await context.routeWebSocket(/.*/, (ws) => { ws.close(); });
        await context.addInitScript(({ theme, language }) => { localStorage.setItem("ovis:settings", JSON.stringify({ theme, language })); }, { theme, language });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
        const shot = async (what: string): Promise<void> => { await settled(page); if (evidence) await page.screenshot({ path: join(evidence, `${name}-${what}.png`) }); };

        await page.goto(`${APP}/`);
        await page.locator(".account-provider").first().click();
        // a sign-in lands on the connect tabs, or on the join an account PC its launch picked asks by itself (#16)
        await page.locator('main.relay-add-screen[data-account-state="signed-in"] .connect-start-tabs, [data-add-pc-mode], [data-approval-wait]').first().waitFor({ timeout: 45_000 });

        // the tab's launch is past: Add a PC lists both PCs as not in on this device yet
        const front = async (): Promise<void> => {
          await page.goto(`${APP}/#add`);
          // from the front page that is a same-document hash change: the load draws Add a PC
          await page.reload();
          await page.locator('main.relay-add-screen[data-account-state="signed-in"] a.relay-add-saved-pc').filter({ hasText: "desk2" }).waitFor({ timeout: 45_000 });
        };
        const link = (label: string) => page.locator("a.relay-add-saved-pc").filter({ hasText: label });
        await front();
        const notes = { m1: await link("m1-box").locator(".relay-add-saved-note").innerText(), desk2: await link("desk2").locator(".relay-add-saved-note").innerText() };
        await shot("front");
        const needs = translate(language, "Needs approval");
        if (notes.m1 !== needs || notes.desk2 !== needs) fail(`${name}: notes ${JSON.stringify(notes)}, want "${needs}" on both`);

        /** The PC's own page from its row: its join sheet, one press from asking; Escape leaves it for the front page. */
        const joinFrom = async (label: string, mode: "join" | "new"): Promise<void> => {
          await link(label).click();
          const sheet = page.locator(`[role=dialog][data-add-pc-mode="${mode}"][data-add-pc-phase="confirm"]`);
          await sheet.waitFor({ timeout: 45_000 });
          if (!await sheet.evaluate((element) => element.contains(document.activeElement))) fail(`${name}: focus is not in ${label}'s ${mode} sheet`);
          if (await sheet.locator("[data-sheet-primary]").count() !== 1) fail(`${name}: ${label}'s sheet has no one press to ask`);
          await shot(`sheet-${mode}`);
          await page.keyboard.press("Escape");
          await page.locator('main.relay-add-screen[data-account-state="signed-in"] .connect-start-tabs').waitFor();
          if (await page.locator("[data-add-pc-phase]").count() !== 0) fail(`${name}: Escape left ${label}'s sheet up`);
        };
        await joinFrom("m1-box", "join");
        await front();
        await joinFrom("desk2", "new");

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        if (overflow) fail(`${name}: the page scrolls sideways`);
        if (errors.length > 0) fail(`${name}: ${errors.slice(0, 3).join("; ")}`);
        console.log(`PASS ${name}: Add a PC lists m1-box and desk2 as needing approval; m1-box's own page (seen by the directory) offers the join sheet, desk2's (never seen) the new one, and Escape leaves each for the front page`);
      } finally {
        await closeMarked(context);
      }
    }
  } finally {
    await closeMarked(browser);
    await site.stop(true);
  }
} catch (error) {
  code = 1;
  console.error("FAIL second device join:", error instanceof Error ? error.message : error);
} finally {
  if (built !== null) rmSync(built, { recursive: true, force: true });
}
process.exit(code);
