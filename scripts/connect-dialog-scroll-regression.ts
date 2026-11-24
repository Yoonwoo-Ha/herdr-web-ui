/**
 * Add a connection on a window shorter than its tabs (#24): on every tab the header and the tab bar stay put, the dialog
 * stays inside the window and its body scrolls to the tab's last part. The Tailscale tab, with six PCs of the tailnet,
 * shows the phone's QR code above them. The PC's ssh config and Tailscale status are fixtures, never the runner's own.
 * Imported by ui-regression.ts; runs alone too.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import type { RemoteAccess } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";
import { openPhoneSettings } from "./relay-panel-regression.ts";

const WINDOW_H = 380;
const TAILNET_PCS = ["old-desktop", "home-server", "winvm", "nuc", "macbookair", "home-window"];
const LONG_ALIAS = "old-desktop-through-the-office-network";
const LONG_USER = "someone-with-a-rather-long-login";
const PORTAL = { supported: true, version: "1.0.0", min_version: "1.0.0", usable: true, phase: "idle", relay: null, url: null, blocked: null, error: null };
const SERVED: RemoteAccess = { port: 0, platform: "darwin", tailscale: { state: "running", dns_name: "mac.tail0000.ts.net", serving_url: "https://mac.tail0000.ts.net", serve_command: null, serve_url: null } };

function tailscaleStatus(): string {
  const peers = Object.fromEntries(TAILNET_PCS.map((name, index) => [`node${index}`, { DNSName: `${name}.tail0000.ts.net.`, UserID: "1", Online: true, OS: "linux", TailscaleIPs: [`100.64.0.${index + 10}`] }]));
  return JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail0000.ts.net.", UserID: "1", TailscaleIPs: ["100.64.0.1"] }, Peer: peers, User: { "1": { LoginName: "owner@example.com" } } });
}

export async function checkConnectDialogScroll(browser: Browser): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-connect-scroll-"));
  const sshDir = join(stateDir, "ssh");
  mkdirSync(sshDir);
  // and one long alias with a long user that reaches the first Tailscale PC by its address: its row says both, whole
  writeFileSync(join(sshDir, "config"), [...Array.from({ length: 14 }, (_, index) => `Host box${index}\n  HostName box${index}.example.com\n  User me\n`),
    `Host ${LONG_ALIAS}\n  HostName 100.64.0.10\n  User ${LONG_USER}\n`].join(""));
  const status = tailscaleStatus();
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, usage: new UsageService(undefined, []), registerBridge: false,
    tailnetPcs: { readStatus: async () => status }, sshCandidates: { sshDir, home: stateDir, readStatus: async () => status },
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: WINDOW_H }, locale: "en-US" });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    await context.route("**/api/access", (route) => route.fulfill({ json: SERVED }));
    await context.route("**/api/portal", (route) => route.request().method() === "GET" ? route.fulfill({ json: PORTAL }) : route.fulfill({ status: 403, json: { error: { code: "fixture" } } }));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await openPhoneSettings(page, `http://127.0.0.1:${server.port}`);
    await page.locator('.settings-dialog [data-section="devices"]').getByRole("button", { name: "Add a connection", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
    const tailscaleTab = sheet.locator('[data-tab-panel="tailscale"]');
    for (const name of ["tailscale", "ssh", "relay"] as const) {
      await sheet.locator(`.connect-tabs [data-tab="${name}"]`).click();
      const panel = sheet.locator(`[data-tab-panel="${name}"]`);
      await panel.waitFor();
      if (name === "tailscale") await tailscaleTab.locator(".connect-found-row").nth(TAILNET_PCS.length - 1).waitFor();
      if (name === "ssh") {
        await panel.locator(".connect-picks").getByRole("button", { name: "box13", exact: true }).waitFor();
        await panel.getByTestId("portal-row").waitFor();
      }
      const measure = () => page.evaluate((name) => {
        const dialog = document.querySelector(".connect-phone-dialog")!;
        const body = dialog.querySelector<HTMLElement>(".connect-phone-body")!;
        const parts = [...dialog.querySelector(`[data-tab-panel="${name}"]`)!.children];
        return {
          dialog: dialog.getBoundingClientRect().toJSON() as DOMRect,
          tabs: dialog.querySelector(".connect-tabs")!.getBoundingClientRect().top,
          body: { bottom: body.getBoundingClientRect().bottom, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
          last: parts.at(-1)!.getBoundingClientRect().bottom,
        };
      }, name);
      const top = await measure();
      assert.ok(top.dialog.top >= 0 && top.dialog.bottom <= WINDOW_H, `${name}: the dialog stays inside the window (${top.dialog.top}..${top.dialog.bottom})`);
      // the relay tab of this signed-out fixture is short: it only has to stay inside the window and reach its end
      if (name !== "relay") assert.ok(top.body.scrollHeight > top.body.clientHeight, `${name}: this short window holds less than the tab, so its body scrolls`);
      await sheet.locator(".connect-phone-body").evaluate((body) => { body.scrollTop = body.scrollHeight; });
      const end = await measure();
      assert.equal(end.tabs, top.tabs, `${name}: the tab bar stays put while the body scrolls`);
      assert.ok(end.last <= end.body.bottom + 1, `${name}: scrolled to its end, the tab's last part is in view (${end.last} > ${end.body.bottom})`);
      await sheet.locator(".connect-phone-body").evaluate((body) => { body.scrollTop = 0; });
    }
    await sheet.locator('.connect-tabs [data-tab="tailscale"]').click();
    const qr = await tailscaleTab.locator(".connect-phone-scan [role='img']").boundingBox();
    const firstPc = await tailscaleTab.locator(".connect-found-row").first().boundingBox();
    assert.ok(qr !== null && firstPc !== null && qr.y < firstPc.y, "the Tailscale tab's phone QR code comes before its PCs");
    // what each row opens is whole on its second line, broken after dots, never cut: in the dialog and on a phone
    const cut = () => tailscaleTab.locator(".connect-reach-list .connect-found-detail").evaluateAll((details) => details.flatMap((detail) => {
      const style = getComputedStyle(detail);
      return style.textOverflow === "ellipsis" || detail.scrollWidth > detail.clientWidth + 1 ? [detail.textContent ?? ""] : [];
    }));
    const opens = `${LONG_ALIAS} · ${LONG_USER}@old-desktop.tail0000.ts.net`;
    await tailscaleTab.locator(".connect-found-detail").filter({ hasText: opens }).waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(() => document.querySelector(".connect-phone-dialog")?.getAnimations().length === 0);
      assert.deepEqual(await cut(), [], `at ${width} px every row's second line is whole`);
      const [name, detail] = await Promise.all([".connect-found-name", ".connect-found-detail"].map((part) => tailscaleTab.locator(".connect-found-row").first().locator(part).boundingBox()));
      assert.ok(name && detail && detail.y >= name.y + name.height - 1, `at ${width} px what it opens is the row's second line`);
    }
    console.log("PASS Add a connection on a short window: header and tabs stay, the body scrolls to each tab's end, Tailscale's QR code before its six PCs");
  } finally {
    await context.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const browser = await chromium.launch({ executablePath: chromePath() });
  try { await checkConnectDialogScroll(browser); } finally { await browser.close(); }
}
