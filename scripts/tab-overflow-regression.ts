import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { tabCreate, tabRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const TAB_LABELS = ["api", "web", "docs", "deploy", "review", "tests", "release-notes", "migrations", "infra", "billing",
  "search", "mobile", "analytics", "onboarding", "payments", "metrics", "support", "staging", "backups", "last-tab"];
const HEADER = ".header-tabs .tab-strip";
const HALF = '.pane-slot[data-side="left"] .tab-strip';
const STRIP = ".pane-slot .tab-strip";
const TAB_MIN = 120;

async function browserRow(page: Page, selector: string): Promise<{ tabs: { name: string; width: number; selected: boolean; closeShown: boolean; shellIcon: boolean }[]; more: string | null; overflow: number }> {
  return page.evaluate((sel) => {
    const row = document.querySelector<HTMLElement>(sel);
    const items = [...(row?.querySelectorAll<HTMLElement>(".tab-strip-item") ?? [])];
    return {
      tabs: items.map((item) => {
        const tab = item.querySelector<HTMLElement>('[role="tab"]');
        const close = item.querySelector<HTMLElement>(".tab-strip-close");
        const shell = item.querySelector<HTMLElement>(".tab-strip-agent.is-shell svg");
        return {
          name: tab?.querySelector(".tab-strip-label")?.textContent ?? "",
          width: item.getBoundingClientRect().width,
          selected: tab?.getAttribute("aria-selected") === "true",
          closeShown: !!close && getComputedStyle(close).display !== "none" && close.getBoundingClientRect().width > 0,
          shellIcon: !!shell && shell.getBoundingClientRect().width > 0,
        };
      }),
      more: row?.querySelector<HTMLElement>(".tab-strip-more")?.textContent ?? null,
      overflow: row ? row.scrollWidth - row.clientWidth : -1,
    };
  }, selector);
}

export async function checkTabOverflow(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-overflow-")));
  let workspaceId: string | null = null;
  let fewId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    let last = first;
    await tabRename(created.tab.tab_id, TAB_LABELS[0]!);
    for (const label of TAB_LABELS.slice(1)) last = (await tabCreate({ workspaceId, cwd: root, label })).root_pane.pane_id;
    const few = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow-few" });
    fewId = few.workspace.workspace_id;

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    try {
      await context.addInitScript(() => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      });
      const page = await context.newPage();

      const rowSettled = async (when: string, open: string, selector = HEADER): Promise<Awaited<ReturnType<typeof browserRow>>> => {
        await page.locator(`${selector} [role="tab"][aria-selected="true"]`, { has: page.locator(".tab-strip-label", { hasText: new RegExp(`^${open}$`) }) }).waitFor({ timeout: 15_000 });
        await page.locator(`${selector} .tab-strip-more`).waitFor({ timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: 20 tabs that do not fit show no More button in the row`); });
        await page.waitForFunction((sel) => {
          const node = document.querySelector(sel);
          return !!node && node.scrollWidth - node.clientWidth <= 1;
        }, selector, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: the row still scrolls past its end`); });
        const row = await browserRow(page, selector);
        const narrow = row.tabs.filter((tab) => tab.width < TAB_MIN - 0.5);
        assert.deepEqual(narrow, [], `${when}: no tab in the row is narrower than ${TAB_MIN}px`);
        assert.ok(row.overflow <= 1, `${when}: the row does not scroll (${row.overflow}px past its end)`);
        assert.ok(row.tabs.length >= 1 && row.tabs.length < TAB_LABELS.length, `${when}: some tabs are in the row and some are not (${row.tabs.length})`);
        assert.equal(row.more?.replace(/\D/g, ""), String(TAB_LABELS.length - row.tabs.length), `${when}: More counts the tabs left out of the row`);
        assert.ok(row.tabs.some((tab) => tab.selected && tab.name === open), `${when}: the open tab ${open} is in the row`);
        assert.ok(row.tabs.every((tab) => tab.shellIcon), `${when}: every shell tab shows its shell glyph`);
        return row;
      };
      // a row's tabs, + and More are parted by the strip's gap: through a whole tab's width of room, step by step,
      // the tabs it keeps and More still fit without scrolling
      const fitsAcross = async (when: string, selector: string, widths: number[]): Promise<void> => {
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForFunction((sel) => {
            const node = document.querySelector(sel);
            return !!node && node.scrollWidth - node.clientWidth <= 1;
          }, selector, { timeout: 3_000 }).catch(async () => {
            const past = await page.locator(selector).evaluate((node) => node.scrollWidth - node.clientWidth);
            throw new Error(`${when} at ${width}px: the row scrolls ${past}px past its end though More holds the tabs that do not fit`);
          });
        }
      };
      const widths = (from: number, span: number): number[] => Array.from({ length: Math.floor(span / 4) + 1 }, (_, step) => from + step * 4);

      await page.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
      const row = await rowSettled("20 tabs, the last open", "last-tab");
      await closeOnlyOnFullTabs(page, HEADER);
      const hidden = TAB_LABELS.filter((label) => !row.tabs.some((tab) => tab.name === label));
      assert.ok(hidden.includes("metrics"), "metrics waits behind More");

      await page.locator(".header-tabs .tab-strip-more").click();
      const listed = await page.getByRole("menu").locator('[role="menuitem"] .menu-item-main').allTextContents();
      assert.deepEqual(listed.map((text) => text.trim()), hidden, "More lists the tabs left out of the row, in their order");
      const letter = [..."abcdefghijklmnopqrstuvwxyz"].find((first) => hidden.filter((name) => name.startsWith(first)).length >= 2);
      assert.ok(letter, `two tabs behind More share a first letter: ${hidden.join(", ")}`);
      await page.waitForFunction(() => document.activeElement?.closest(".row-menu") != null);
      const focusedTab = () => page.evaluate(() => document.activeElement?.querySelector(".menu-item-main")?.textContent?.trim() ?? "");
      let at = hidden.indexOf(await focusedTab());
      const walked: string[] = [], wanted: string[] = [];
      for (let press = 0; press <= hidden.filter((name) => name.startsWith(letter)).length; press += 1) {
        await page.keyboard.press(letter);
        walked.push(await focusedTab());
        at = [...hidden.keys()].map((step) => (at + 1 + step) % hidden.length).find((index) => hidden[index]!.startsWith(letter))!;
        wanted.push(hidden[at]!);
      }
      assert.deepEqual(walked, wanted, `"${letter}" pressed over More walks every tab it starts, in order`);
      await page.getByRole("menu").getByRole("menuitem").filter({ has: page.locator(".menu-item-main", { hasText: /^metrics$/ }) }).click();
      await rowSettled("metrics picked from More", "metrics");

      await page.setViewportSize({ width: 1024, height: 900 });
      await rowSettled("at 1024px", "metrics");
      await fitsAcross("the header's row", HEADER, widths(1024, TAB_MIN + 8));
      await page.setViewportSize({ width: 1280, height: 900 });
      console.log("PASS the header's row keeps every tab at least 120px wide and its close only on a full-size tab; the tabs that do not fit are listed behind More, and one picked there opens in the row");

      await page.evaluate((other) => {
        sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" }));
      }, few.root_pane.pane_id);
      await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, null, { timeout: 15_000 });
      const leftRow = await rowSettled("split left half", "api", HALF);
      if (leftRow.tabs.length > 1) await closeOnlyOnFullTabs(page, HALF);
      const leftHidden = TAB_LABELS.filter((label) => !leftRow.tabs.some((tab) => tab.name === label));
      assert.ok(leftHidden.includes("last-tab"), "last-tab waits behind More in the split half");
      await page.locator(`${HALF} .tab-strip-more`).click();
      await page.getByRole("menu").getByRole("menuitem").filter({ has: page.locator(".menu-item-main", { hasText: /^last-tab$/ }) }).click();
      await rowSettled("last-tab picked from split half More", "last-tab", HALF);
      await fitsAcross("a split half's row", HALF, widths(1280, 2 * (TAB_MIN + 8)));
      await page.setViewportSize({ width: 1280, height: 900 });
      await rowSettled("a split half back at 1280px", "last-tab", HALF);

      const fewStrip = '.pane-slot[data-side="right"] .tab-strip';
      const rightRow = await browserRow(page, fewStrip);
      assert.equal(rightRow.more, null, "the split half with one tab shows no More button");
      assert.ok(rightRow.overflow <= 1, "the one tab fits in the right split half");
      assert.equal(rightRow.tabs.length, 1, "the right split half shows its one tab");
      assert.ok(rightRow.tabs[0]?.closeShown && rightRow.tabs[0]?.shellIcon, "the right split half's open shell tab shows its shell glyph and close button");

      await page.locator('.pane-slot[data-side="right"]').getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length <= 1, null, { timeout: 15_000 });
      await rowSettled("after a split closed", "last-tab");
      console.log("PASS each split half draws the same browser-style tab row with shell glyphs, open-tab close, and More overflow, and a row never scrolls beside More");

      // below 769px the pane keeps its own strip, which scrolls sideways instead of listing tabs behind More
      await page.setViewportSize({ width: 700, height: 900 });
      await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
      const strip = page.locator(STRIP);
      await page.locator(`${STRIP} [role="tab"]`, { has: page.locator(".tab-strip-label", { hasText: /^last-tab$/ }) }).waitFor({ state: "attached", timeout: 15_000 });
      await page.waitForFunction((selector) => {
        const node = document.querySelector(selector);
        return !!node && node.scrollWidth - node.clientWidth > 100;
      }, STRIP, { timeout: 5_000 });
      const spacing = await page.locator(`${STRIP} .tab-strip-item:not(.is-active) .tab-strip-tab`).first().evaluate((tab) => {
        const style = getComputedStyle(tab);
        const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return { padding: [style.paddingLeft, style.paddingRight], gap: style.columnGap, want: { padding: [token("--space-2"), token("--space-2")], gap: token("--space-1") } };
      });
      assert.deepEqual({ padding: spacing.padding, gap: spacing.gap }, spacing.want, "below 769px a resting tab of the pane's own strip keeps its compact spacing");
      const scrollLeft = (): Promise<number> => strip.evaluate((node) => node.scrollLeft);
      await strip.evaluate((node) => { node.scrollLeft = 0; });
      const box = await strip.boundingBox();
      assert.ok(box, "the pane's strip is drawn");
      await page.mouse.move(box.x + 60, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction((selector) => (document.querySelector(selector)?.scrollLeft ?? 0) > 0, STRIP, { timeout: 5_000 })
        .catch(() => { throw new Error("a vertical wheel over the overflowing strip left it unscrolled"); });
      const down = await scrollLeft();
      await page.mouse.wheel(0, -400);
      await page.waitForFunction(([selector, was]) => (document.querySelector(selector as string)?.scrollLeft ?? was) < (was as number), [STRIP, down] as const, { timeout: 5_000 })
        .catch(() => { throw new Error("a wheel turned up did not scroll the strip back"); });
      await page.mouse.wheel(0, 10_000);
      await page.waitForFunction((selector) => {
        const node = document.querySelector(selector);
        const end = [...(node?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((tab) => tab.querySelector(".tab-strip-label")?.textContent === "last-tab");
        const add = node?.querySelector(".tab-strip-add");
        if (!node || !end || !add) return false;
        const view = node.getBoundingClientRect();
        const item = end.getBoundingClientRect();
        return item.left >= view.left && item.right <= add.getBoundingClientRect().left + 1;
      }, STRIP, { timeout: 5_000 })
        .catch(() => { throw new Error("wheeling down to the strip's end left the last tab out of view"); });
      // a wheel that counts in lines (Firefox's) or pages moves the strip as far as one in pixels would
      for (const [mode, delta, least] of [[1, 3, 30], [2, 1, 200]] as const) {
        const moved = await strip.evaluate((node, [deltaMode, deltaY]) => {
          node.scrollLeft = 0;
          node.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true }));
          return { moved: node.scrollLeft, room: node.scrollWidth - node.clientWidth };
        }, [mode, delta] as const);
        assert.ok(moved.moved >= Math.min(least, moved.room - 1), `a wheel in ${mode === 1 ? "lines" : "pages"} scrolls the strip (${moved.moved}px of ${moved.room})`);
      }
      const leftAlone = (init: WheelEventInit): Promise<boolean> => strip.evaluate((node, wheel) =>
        node.dispatchEvent(new WheelEvent("wheel", { ...wheel, bubbles: true, cancelable: true })), init);
      assert.equal(await leftAlone({ deltaX: 120, deltaY: 10 }), true, "a sideways wheel or trackpad swipe is the browser's");
      // mostly down, a little sideways either way: turned into sideways scroll from deltaY alone, the
      // strip would move against the swipe's own sideways part (#2103)
      for (const deltaX of [20, -20]) assert.equal(await leftAlone({ deltaX, deltaY: 40 }), true, `a diagonal trackpad swipe (deltaX ${deltaX}) is the browser's`);
      assert.equal(await leftAlone({ deltaY: 120, ctrlKey: true }), true, "a pinch is the browser's");
      await page.goto(`${origin}/?pane=${encodeURIComponent(few.root_pane.pane_id)}`);
      await page.locator(`${STRIP} [role="tab"][aria-selected="true"]`).waitFor({ timeout: 15_000 });
      assert.equal(await strip.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the one tab fits");
      assert.equal(await leftAlone({ deltaY: 120 }), true, "a strip whose tabs fit leaves the wheel alone");
    } finally { await context.close(); }
    console.log("PASS below 769px the pane's own strip keeps its compact spacing; a vertical mouse wheel scrolls it sideways to its last tab (pixels, lines, pages), and leaves a sideways wheel, a diagonal swipe, a pinch and a strip that fits to the browser");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    if (fewId) await workspaceClose(fewId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

async function closeOnlyOnFullTabs(page: Page, selector: string): Promise<void> {
  await page.locator(`${selector} .tab-strip-item:not(.is-active)`).first().hover();
  const hovered = await browserRow(page, selector);
  for (const tab of hovered.tabs.filter((entry) => entry.closeShown)) assert.ok(tab.width >= TAB_MIN - 0.5, `${tab.name}: a close shows only on a full-size tab (${tab.width}px)`);
  assert.deepEqual(hovered.tabs.filter((tab) => tab.closeShown).map((tab) => tab.name), hovered.tabs.filter((tab) => tab.selected).map((tab) => tab.name), "only the open tab shows a close, whichever tab the pointer is over");
  await page.mouse.move(0, 400);
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-tab-overflow-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkTabOverflow(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
