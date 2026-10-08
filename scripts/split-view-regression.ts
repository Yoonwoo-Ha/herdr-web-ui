import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * The split view's edges (lib/split.ts), on a page of its own: the other half's connection is a
 * second socket, which the main browser run would take for the page's own.
 * - An alert is skipped for the pane in the other half only while that half is drawn: a window
 *   too narrow for the split shows the active half alone, and the other pane alerts again.
 * - A Tab onto a control of the inactive half makes that half active and leaves the focus there:
 *   its terminal and composer do not take the keyboard from it.
 */
export async function checkSplitView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-split-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const suffix of ["open", "other"]) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-split-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [openPane, otherPane] = panes as [string, string];
    const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await report(openPane, "idle");
    await report(otherPane, "idle");
    await context.addInitScript((ids) => {
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
      for (const id of ids) localStorage.setItem(`herdr-web-ui:view:${id}`, "chat");
    }, panes);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
    await page.locator(".conn-live").waitFor();
    const card = page.locator(".droplet-card");
    const seen = (pane: string, status: string) => page.locator(`.pane-item:has(.pane-select[title^="${pane} —"]) [data-status="${status}"]`).first().waitFor({ state: "attached" });
    const block = async (pane: string) => {
      await report(pane, "working");
      await seen(pane, "working");
      await report(pane, "blocked");
      await seen(pane, "blocked");
    };
    const half = (side: string) => page.locator(`.pane-slot[data-side="${side}"]`);

    // the other pane in the right half, the open one active on the left
    const area = page.locator(".pane-split");
    const box = (await area.boundingBox())!;
    await page.locator(`.pane-select[title^="${otherPane} —"]`).dragTo(area, { targetPosition: { x: box.width * 0.8, y: box.height / 2 } });
    await half("right").getByRole("log", { name: `conversation of ${otherPane}`, exact: true }).waitFor();
    await half("left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
    await page.waitForFunction(() => document.querySelector('.pane-slot[data-side="left"]')?.classList.contains("is-active") === true);

    // drawn beside the open one: no alert for it
    await block(otherPane);
    await Bun.sleep(1_200);
    assert.equal(await card.count(), 0, "no in-app alert for the pane drawn in the other half");
    await report(otherPane, "idle");
    await Bun.sleep(800);

    // a window too narrow for the split shows the active half alone: the other pane alerts again
    await page.setViewportSize({ width: 700, height: 800 });
    await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
    await block(otherPane);
    await card.waitFor({ state: "visible" });
    assert.match((await card.getAttribute("aria-label")) ?? "", /Needs input/);
    await report(otherPane, "idle");
    await Bun.sleep(800);
    console.log("PASS the other half's pane is spared alerts only while that half is drawn");

    // a Tab onto the inactive half's control makes the half active and keeps the focus there
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
    await page.waitForTimeout(300);
    assert.equal(await half("right").evaluate((slot) => slot.classList.contains("is-inactive")), true);
    const attach = half("right").getByRole("button", { name: "Attach files", exact: true });
    await attach.focus();
    await page.waitForFunction(() => document.querySelector('.pane-slot[data-side="right"]')?.classList.contains("is-active") === true);
    await page.waitForTimeout(500);
    assert.equal(await attach.evaluate((button) => button === document.activeElement), true, "the focus stays on the control it went to");
    console.log("PASS a Tab into the inactive half makes it active and keeps the focus where it went");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // each half keeps its own connection's role: the active half's socket told to watch (a forged
  // role-ack, as a watch-only answer) leaves the other half's open socket interactive
  const watched = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const [openPane, otherPane] = await (async () => {
      const ids: string[] = [];
      for (const suffix of ["watch-open", "watch-other"]) {
        const cwd = join(root, suffix);
        mkdirSync(cwd);
        const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-split-${suffix}` });
        workspaces.push(created.workspace.workspace_id);
        ids.push(created.root_pane.pane_id);
      }
      return ids as [string, string];
    })();
    for (const pane of [openPane, otherPane]) await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    await watched.addInitScript((ids) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
      for (const id of ids) localStorage.setItem(`herdr-web-ui:view:${id}`, "chat");
    }, [openPane, otherPane]);
    let sockets = 0;
    await watched.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const second = sockets++ === 1;
      const upstream = socket.connectToServer();
      upstream.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        socket.send(second && message.type === "role-ack" ? JSON.stringify({ ...message, mode: "observe" }) : raw);
      });
    });
    const page = await watched.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
    await page.locator(".conn-live").waitFor();
    const area = page.locator(".pane-split");
    const box = (await area.boundingBox())!;
    await page.locator(`.pane-select[title^="${otherPane} —"]`).dragTo(area, { targetPosition: { x: box.width * 0.8, y: box.height / 2 } });
    // the dropped pane's half is active, and its socket (the second) is told to watch
    const right = page.locator('.pane-slot[data-side="right"]');
    const left = page.locator('.pane-slot[data-side="left"]');
    await right.locator(".terminal-banner-observe").waitFor();
    await page.waitForTimeout(800);
    assert.equal(await left.locator(".terminal-banner-observe").count(), 0, "the other half's socket stays interactive");
    await left.locator(".composer textarea").waitFor();
    console.log("PASS each half keeps its own connection's role");
  } finally {
    await watched.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
