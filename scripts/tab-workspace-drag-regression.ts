import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { paneSplit, sessionSnapshot, tabCreate, tabRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}

async function centerOf(locator: Locator, label: string): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} is visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragOnto(page: Page, from: Locator, to: Locator, whileHeld: () => Promise<void>): Promise<void> {
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  const start = await centerOf(from, "dragged tab");
  const end = await centerOf(to, "sidebar workspace row");
  let held = false;
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    held = true;
    await page.mouse.move(start.x, start.y + 16, { steps: 4 });
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await whileHeld();
  } finally {
    if (held) await page.mouse.up().catch(() => {});
  }
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

export async function checkTabWorkspaceDrag(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-ws-drag-")));
  let sourceId: string | null = null;
  let targetId: string | null = null;
  try {
    const source = await workspaceCreate({ cwd: root, label: "ovis-drag-source" });
    sourceId = source.workspace.workspace_id;
    await tabRename(source.tab.tab_id, "stay");
    const mover = await tabCreate({ workspaceId: sourceId, cwd: root, label: "mover" });
    const splitTab = await tabCreate({ workspaceId: sourceId, cwd: root, label: "split-tab" });
    await paneSplit(splitTab.root_pane.pane_id, "right", false);

    const target = await workspaceCreate({ cwd: root, label: "ovis-drag-target" });
    targetId = target.workspace.workspace_id;
    await tabRename(target.tab.tab_id, "target-home");

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false }));
      }
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(`${origin}/?pane=${encodeURIComponent(mover.root_pane.pane_id)}`);
      await page.locator(".conn-live").waitFor();

      const headerTab = (label: string) => page.locator('.header-tabs [role="tab"]', { has: page.locator(".tab-strip-label", { hasText: new RegExp(`^${label}$`) }) });
      const rowHeader = (workspaceId: string) => page.locator(`.workspace-group[data-workspace="${workspaceId}"] > .workspace-header`);
      await headerTab("mover").waitFor();
      await rowHeader(sourceId).waitFor();
      await rowHeader(targetId).waitFor();

      // 1. Dragging a tab onto its own workspace row never marks or moves it
      await dragOnto(page, headerTab("mover"), rowHeader(sourceId), async () => {
        await settleFrames(page);
        assert.equal(await page.locator(".workspace-group.is-tab-drop").count(), 0, "own workspace row is never highlighted");
      });
      await settleFrames(page);
      {
        const snap = await sessionSnapshot();
        assert.ok(snap.tabs.some((tab) => tab.workspace_id === sourceId && tab.label === "mover"), "own-row drop leaves mover in source");
      }

      // 2. Dragging over another workspace highlights the row and hides split drop preview; Escape cancels cleanly
      await dragOnto(page, headerTab("mover"), rowHeader(targetId), async () => {
        const dropGroup = page.locator(`.workspace-group[data-workspace="${targetId}"].is-tab-drop`);
        await dropGroup.waitFor();
        // the header's background eases in (a transition): read it once that transition has finished, not on its first frame
        const style = await dropGroup.locator("> .workspace-header").evaluate(async (node) => {
          await Promise.all(node.getAnimations().map((animation) => animation.finished));
          const computed = getComputedStyle(node);
          return { bg: computed.backgroundColor, shadow: computed.boxShadow };
        });
        assert.notEqual(style.bg, "rgba(0, 0, 0, 0)", "hovered target workspace shows accent tint fill");
        assert.notEqual(style.shadow, "none", "hovered target workspace shows accent outline");
        assert.equal(await page.locator(".split-drop.is-visible").count(), 0, "split drop overlay hides while aimed at a workspace row");

        await page.keyboard.press("Escape");
        await until(async () => (await page.locator(".workspace-group.is-tab-drop").count()) === 0, "Escape clears the workspace drop highlight");
      });
      {
        const snap = await sessionSnapshot();
        assert.equal(snap.tabs.filter((tab) => tab.workspace_id === targetId).length, 1, "Escape cancels without moving the tab");
        assert.ok(snap.tabs.some((tab) => tab.workspace_id === sourceId && tab.label === "mover"), "mover stays in source after Escape");
      }

      // 3. A split tab (2 panes) never highlights or moves onto another workspace
      await headerTab("split-tab").click();
      await dragOnto(page, headerTab("split-tab"), rowHeader(targetId), async () => {
        await settleFrames(page);
        assert.equal(await page.locator(".workspace-group.is-tab-drop").count(), 0, "a split tab never marks a workspace row");
      });
      {
        const snap = await sessionSnapshot();
        assert.equal(snap.tabs.filter((tab) => tab.workspace_id === targetId).length, 1, "dropping a split tab never moves it");
      }

      // 4. Re-select mover and drop onto target workspace row -> moves tab to target workspace
      await headerTab("mover").click();
      await headerTab("mover").locator('[aria-selected="true"]').or(headerTab("mover")).waitFor();
      await until(async () => (await headerTab("mover").getAttribute("aria-selected")) === "true", "mover tab is selected");
      await dragOnto(page, headerTab("mover"), rowHeader(targetId), async () => {
        await page.locator(`.workspace-group[data-workspace="${targetId}"].is-tab-drop`).waitFor();
      });
      await until(async () => {
        const snap = await sessionSnapshot();
        const targetTabs = snap.tabs.filter((tab) => tab.workspace_id === targetId);
        const sourceTabs = snap.tabs.filter((tab) => tab.workspace_id === sourceId);
        return targetTabs.length === 2
          && targetTabs.some((tab) => tab.label === "mover")
          && sourceTabs.length === 2
          && !sourceTabs.some((tab) => tab.label === "mover");
      }, "mover tab moved to the target workspace");
      assert.equal(await page.locator(".workspace-group.is-tab-drop").count(), 0, "drop clears the highlight");
      await page.locator(`.workspace-group[data-workspace="${targetId}"].is-selected`).waitFor();
      await until(async () => (await headerTab("mover").getAttribute("aria-selected")) === "true", "moved tab opens in the target workspace");
      console.log("PASS dragging a one-pane tab onto another sidebar workspace outlines that row and moves it there; own rows, split tabs, and Escape move nothing");
    } finally {
      await context.close();
    }
  } finally {
    if (sourceId) await workspaceClose(sourceId).catch(() => {});
    if (targetId) await workspaceClose(targetId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-tab-ws-drag-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkTabWorkspaceDrag(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
