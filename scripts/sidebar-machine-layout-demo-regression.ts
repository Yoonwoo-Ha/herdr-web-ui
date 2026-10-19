/**
 * Purpose: verify sidebar PC control layout at narrow and wide widths and two-step removal in a real browser.
 * Tags: sidebar, machines, responsive, accessibility, browser, regression.
 * Usage: bun scripts/sidebar-machine-layout-demo-regression.ts [--geometry-only]
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { prepareMachineControlsDemo } from "./sidebar-machine-controls-fixture.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-machine-layout-"));
const evidenceDir = process.env.UI_EVIDENCE_DIR;
const geometryOnly = process.argv.includes("--geometry-only") || process.env.SIDEBAR_GEOMETRY_ONLY === "1";
const REMOTE_NAME = "Demo remote PC";
const MANAGED_NAME = "Managed demo PC";
const REMOVE_LABEL: Record<string, string> = { en: "Remove PC", ko: "PC 제거", ja: "PC を削除", zh: "移除 PC" };
const CONFIRM_LABEL: Record<string, string> = { en: "Confirm remove PC", ko: "PC 제거 확인", ja: "PC の削除を確認", zh: "确认移除 PC" };
const REMOVE_EXPLANATION: Record<string, string> = {
  en: "Removes this registration. Remote sessions keep running.",
  ko: "이 등록만 지웁니다. 원격 세션은 계속 돕니다.",
  ja: "この登録のみを削除します。リモートのセッションは実行されたままです。",
  zh: "仅移除此注册。远程会话会继续运行。",
};

interface Scenario {
  name: string;
  language: "en" | "ko" | "ja" | "zh";
  theme: "dark" | "light";
  density: "comfortable" | "compact";
  viewport: { width: number; height: number };
  touch: boolean;
  desktopSidebar: boolean;
  sidebarWidth?: number;
  renameRow?: "shared" | "stacked";
  screenshots?: boolean;
}

const scenarios: Scenario[] = [
  { name: "en-desktop-240-dark", language: "en", theme: "dark", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true, renameRow: "stacked", screenshots: true },
  { name: "en-desktop-240-light", language: "en", theme: "light", density: "compact", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true, screenshots: true },
  { name: "en-desktop-520-light", language: "en", theme: "light", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true, sidebarWidth: 520, renameRow: "shared", screenshots: true },
  { name: "en-phone-320-dark", language: "en", theme: "dark", density: "compact", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false, screenshots: true },
  { name: "en-phone-320-light", language: "en", theme: "light", density: "comfortable", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false, screenshots: true },
  { name: "ko-phone-320-dark", language: "ko", theme: "dark", density: "comfortable", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false },
  { name: "ja-phone-390-light", language: "ja", theme: "light", density: "compact", viewport: { width: 390, height: 844 }, touch: true, desktopSidebar: false },
  { name: "zh-phone-320-dark", language: "zh", theme: "dark", density: "compact", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false },
  { name: "ko-desktop-240-dark", language: "ko", theme: "dark", density: "compact", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true },
  { name: "ja-desktop-240-light", language: "ja", theme: "light", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true },
  { name: "zh-desktop-240-dark", language: "zh", theme: "dark", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true },
  { name: "en-phone-390-light", language: "en", theme: "light", density: "compact", viewport: { width: 390, height: 844 }, touch: true, desktopSidebar: false, renameRow: "stacked" },
  { name: "en-landscape-844x390-dark", language: "en", theme: "dark", density: "comfortable", viewport: { width: 844, height: 390 }, touch: true, desktopSidebar: true },
];

const machineGroup = (page: Page, name: string): Locator => page.locator(".machine-group").filter({ has: page.locator(".machine-name", { hasText: name }) });
const getHook = (page: Page, expression: string) => page.evaluate((key) => {
  const fixture = (window as unknown as { machineControlsFixture: { calls: Record<string, unknown>; roster: unknown[] } }).machineControlsFixture;
  let value: unknown = fixture;
  for (const part of key.split(".")) {
    if (typeof value !== "object" || value === null) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}, expression);

async function fitGeometry(page: Page, name: string, scenario: Scenario): Promise<void> {
  const metrics = await page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, height: box.height };
    };
    const sidebar = document.querySelector(".sidebar");
    const list = document.querySelector<HTMLElement>(".machine-list");
    const controls = document.querySelector(".machine-controls");
    if (!sidebar || !list || !controls) return null;
    const panelRect = controls.getBoundingClientRect();
    const panelStyle = getComputedStyle(controls);
    const input = controls.querySelector("input");
    const inputRect = input ? input.getBoundingClientRect() : null;
    const elements = [...controls.querySelectorAll("form, .machine-control-buttons, input, button, .field-label")];
    const lineCount = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((box) => Math.round(box.top))).size;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
      sidebar: rect(sidebar),
      list: { clientWidth: list.clientWidth, scrollWidth: list.scrollWidth },
      panel: rect(controls),
      input: inputRect ? { left: inputRect.left, right: inputRect.right, top: inputRect.top, bottom: inputRect.bottom, width: inputRect.width, height: inputRect.height } : null,
      controlHeight: Number.parseFloat(panelStyle.getPropertyValue("--control-h")),
      touchTarget: Number.parseFloat(panelStyle.getPropertyValue("--touch-target")),
      elements: elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          name: element.className || element.tagName,
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          lines: element instanceof HTMLButtonElement ? lineCount(element) : 1,
          inRow: element.parentElement?.classList.contains("machine-control-buttons") ?? false,
          clientWidth: element instanceof HTMLElement ? element.clientWidth : 0,
          scrollWidth: element instanceof HTMLElement ? element.scrollWidth : 0,
        };
      }),
      panelEdges: { left: panelRect.left, right: panelRect.right },
    };
  });
  assert.ok(metrics, `${scenario.name} ${name}: controls are present`);
  const sidebarWidth = scenario.sidebarWidth ?? 240;
  if (scenario.desktopSidebar) assert.ok(Math.abs(metrics.sidebar!.width - sidebarWidth) <= 1, `${scenario.name} sidebar is ${sidebarWidth}px: ${JSON.stringify(metrics.sidebar)}`);
  else {
    assert.ok(metrics.sidebar!.left >= -1 && metrics.sidebar!.right <= scenario.viewport.width + 1, `${scenario.name} drawer stays in viewport: ${JSON.stringify(metrics.sidebar)}`);
  }
  assert.ok(metrics.list!.scrollWidth <= metrics.list!.clientWidth + 1, `${scenario.name} machine list has no horizontal overflow: ${JSON.stringify(metrics.list)}`);
  assert.ok(metrics.panel!.left >= metrics.sidebar!.left - 1 && metrics.panel!.right <= metrics.sidebar!.right + 1, `${scenario.name} panel fits its sidebar: ${JSON.stringify({ sidebar: metrics.sidebar, panel: metrics.panel })}`);
  assert.ok(metrics.panel!.right <= scenario.viewport.width + 1, `${scenario.name} panel fits the viewport: ${JSON.stringify(metrics.panel)}`);
  assert.ok(metrics.input && metrics.input.left >= metrics.panelEdges!.left - 1 && metrics.input.right <= metrics.panelEdges!.right + 1, `${scenario.name} 100-character name field outer box fits the panel: ${JSON.stringify({ input: metrics.input, panel: metrics.panel })}`);
  for (const element of metrics.elements!) {
    assert.ok(element.left >= metrics.panelEdges!.left - 1 && element.right <= metrics.panelEdges!.right + 1, `${scenario.name} ${element.name} fits the control panel: ${JSON.stringify(element)}`);
    if (element.name === "field-label") assert.ok(element.scrollWidth <= element.clientWidth + 1, `${scenario.name} field label text fits: ${JSON.stringify(element)}`);
    if (element.name.includes("btn")) assert.ok(element.scrollWidth <= element.clientWidth + 1, `${scenario.name} button label fits: ${JSON.stringify(element)}`);
    if (scenario.touch && element.name.includes("btn")) assert.ok(element.height >= 44 - 1, `${scenario.name} touch button is at least 44px tall: ${JSON.stringify(element)}`);
  }
  const oneLine = scenario.touch ? metrics.touchTarget : metrics.controlHeight;
  const buttons = metrics.elements!.filter((element) => element.name.includes("btn"));
  for (const button of buttons) {
    if (button.lines === 1) assert.ok(Math.abs(button.height - oneLine) <= 1, `${scenario.name} one-line button is the standard control's height (${oneLine}px): ${JSON.stringify(button)}`);
  }
  const rename = buttons.find((button) => !button.inRow);
  assert.ok(rename && metrics.input, `${scenario.name} rename form has its field and button`);
  const renameRow = rename.left >= metrics.input.right - 1 && Math.abs(rename.bottom - metrics.input.bottom) <= 1 ? "shared" : rename.top >= metrics.input.bottom - 1 ? "stacked" : "overlapping";
  assert.notEqual(renameRow, "overlapping", `${scenario.name} Rename shares the name field's row or sits under it: ${JSON.stringify({ rename, input: metrics.input })}`);
  if (scenario.renameRow) assert.equal(renameRow, scenario.renameRow, `${scenario.name} Rename is ${scenario.renameRow === "shared" ? "on the name field's row" : "under the name field"} in a ${sidebarWidth}px sidebar: ${JSON.stringify({ rename, input: metrics.input })}`);
  const rows = new Map<number, typeof buttons>();
  for (const button of buttons.filter((button) => button.inRow)) rows.set(Math.round(button.top), [...(rows.get(Math.round(button.top)) ?? []), button]);
  for (const row of rows.values()) assert.ok(row.every((button) => Math.abs(button.bottom - row[0]!.bottom) <= 1), `${scenario.name} buttons that share a row share its height: ${JSON.stringify(row)}`);
}

async function capture(page: Page, scenario: Scenario, state: "initial" | "armed"): Promise<void> {
  if (!evidenceDir || !scenario.screenshots) return;
  await page.screenshot({ path: join(evidenceDir, `sidebar-machine-layout-${scenario.name}-${state}.png`) });
}

async function withScenario(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string, scenario: Scenario, fullBehavior: boolean): Promise<void> {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    isMobile: scenario.touch,
    hasTouch: scenario.touch,
    locale: "en-US",
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  try {
    await context.addInitScript((setting) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: setting.language, theme: setting.theme, density: setting.density, defaultView: "chat" }));
      if (setting.sidebarWidth !== null) localStorage.setItem("herdr-web-ui:sidebar-width", String(setting.sidebarWidth));
    }, { language: scenario.language, theme: scenario.theme, density: scenario.density, sidebarWidth: scenario.desktopSidebar ? scenario.sidebarWidth ?? 240 : null });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    if (scenario.touch && !scenario.desktopSidebar) {
      await page.locator(".drawer-toggle").tap();
      await page.locator(".sidebar.is-open").waitFor({ state: "visible" });
    }
    const remoteGroup = machineGroup(page, REMOTE_NAME);
    await remoteGroup.waitFor({ state: "attached" });

    if (geometryOnly) {
      if (!scenario.touch) await remoteGroup.locator(".machine-header").hover();
      const manage = remoteGroup.locator(".machine-manage");
      if (scenario.touch) await manage.tap();
      else await manage.click();
      const controls = remoteGroup.locator(".machine-controls");
      await controls.waitFor({ state: "visible" });
      await controls.locator("input").fill("x".repeat(100));
      await fitGeometry(page, "100-character geometry-only", scenario);
      console.log(`PASS ${scenario.name} geometry-only baseline`);
      assert.deepEqual(errors, [], `${scenario.name} has no uncaught browser errors`);
      return;
    }

    const host = machineGroup(page, "workstation");
    await host.waitFor({ state: "attached" });
    assert.equal(await host.locator(".machine-manage").count(), 0, `${scenario.name} local host has no Manage button`);
    assert.ok((await host.locator(".machine-kind").textContent() ?? "").trim().length > 0, `${scenario.name} local host has a localized kind label`);

    const managed = machineGroup(page, MANAGED_NAME);
    if (!scenario.touch) await managed.locator(".machine-header").hover();
    const managedManage = managed.locator(".machine-manage");
    if (scenario.touch) await managedManage.tap();
    else await managedManage.click();
    const managedControls = managed.locator(".machine-controls");
    await managedControls.waitFor();
    assert.ok((await managedControls.locator(".field-hint").textContent() ?? "").trim().length > 0, `${scenario.name} herdr-managed restriction is explained in the active locale`);
    assert.equal(await managedControls.locator("form").count(), 0, `${scenario.name} herdr-managed PC has no rename form`);
    assert.equal(await managedControls.getByRole("button", { name: REMOVE_LABEL[scenario.language], exact: true }).count(), 0, `${scenario.name} herdr-managed PC has no removal control`);
    assert.equal(await managedControls.locator(".machine-control-buttons button").count(), 2, `${scenario.name} herdr-managed PC retains its two setup/update actions`);
    if (scenario.touch) await managedManage.tap();
    else await managedManage.click();
    await managedControls.waitFor({ state: "detached" });

    if (!scenario.touch) await remoteGroup.locator(".machine-header").hover();
    const remoteManage = remoteGroup.locator(".machine-manage");
    if (scenario.touch) await remoteManage.tap();
    else await remoteManage.click();
    const controls = remoteGroup.locator(".machine-controls");
    await controls.waitFor({ state: "visible" });
    await capture(page, scenario, "initial");
    await controls.locator("input").fill("x".repeat(100));
    await fitGeometry(page, "initial", scenario);
    assert.equal(await page.locator(".machine-list").evaluate((list) => (list as HTMLElement).scrollWidth <= (list as HTMLElement).clientWidth + 1), true, `${scenario.name} machine list fits after a 100-character PC name`);
    await controls.locator("input").fill(REMOTE_NAME);

    const remove = remoteGroup.getByRole("button", { name: REMOVE_LABEL[scenario.language], exact: true });
    const beforeDeleteCount = await getHook(page, "calls.deleteCount");
    const beforeDeleteAttempts = await getHook(page, "calls.deleteAttempts");
    await remove.focus();
    await page.evaluate(() => { (window as unknown as { __sidebarRemoveFocus: Element | null }).__sidebarRemoveFocus = document.activeElement; });
    await page.keyboard.press("Enter");
    const confirm = remoteGroup.getByRole("button", { name: CONFIRM_LABEL[scenario.language], exact: true });
    await confirm.waitFor();
    assert.equal(await getHook(page, "calls.deleteCount"), beforeDeleteCount, `${scenario.name} first keyboard removal click sends zero DELETEs`);
    assert.equal(await getHook(page, "calls.deleteAttempts"), beforeDeleteAttempts, `${scenario.name} first keyboard removal click sends no DELETE request`);
    assert.equal(await page.evaluate(() => document.activeElement === (window as unknown as { __sidebarRemoveFocus: Element }).__sidebarRemoveFocus), true, `${scenario.name} first removal click preserves focus on the same button`);
    assert.ok((await controls.textContent() ?? "").includes(REMOVE_EXPLANATION[scenario.language]!), `${scenario.name} confirmation explains that only the registration is removed`);
    await fitGeometry(page, "armed", scenario);
    await capture(page, scenario, "armed");

    if (fullBehavior && !geometryOnly) {
      const observer = await page.evaluate(() => (window as unknown as { machineControlsFixture: { observe(): number } }).machineControlsFixture.observe());
      await page.waitForFunction((index) => {
        const hooks = (window as unknown as { machineControlsFixture: { observerRoster(index: number): Array<{ id: string }> | null } }).machineControlsFixture;
        return hooks.observerRoster(index)?.some((machine) => machine.id === "sidebar-fixture");
      }, observer);

      const remoteManage = remoteGroup.locator(".machine-manage");
      if (scenario.touch) await remoteManage.tap();
      else await remoteManage.click();
      await controls.waitFor({ state: "detached" });
      if (scenario.touch) await remoteManage.tap();
      else await remoteManage.click();
      await controls.waitFor({ state: "visible" });
      assert.equal(await remoteGroup.getByRole("button", { name: CONFIRM_LABEL.en, exact: true }).count(), 0, "closing and reopening Manage resets armed removal confirmation");
      assert.equal(await remoteGroup.locator(".field-hint").filter({ hasText: REMOVE_EXPLANATION.en }).count(), 0, "reopening Manage clears the removal explanation");

      await remoteGroup.getByRole("button", { name: "Disconnect", exact: true }).click();
      await remoteGroup.getByRole("button", { name: "Connect", exact: true }).waitFor();
      await remoteGroup.getByRole("button", { name: REMOVE_LABEL.en, exact: true }).waitFor();
      await page.waitForFunction((index) => {
        const hooks = (window as unknown as { machineControlsFixture: { observerRoster(index: number): Array<{ id: string; enabled: boolean }> | null } }).machineControlsFixture;
        return hooks.observerRoster(index)?.find((machine) => machine.id === "sidebar-fixture")?.enabled === false;
      }, observer);

      const renamed = "Renamed fixture PC";
      await controls.locator("input").fill(renamed);
      await controls.getByRole("button", { name: "Rename", exact: true }).click();
      const renamedGroup = machineGroup(page, renamed);
      await page.waitForFunction((name) => [...document.querySelectorAll(".machine-name")].some((element) => element.textContent === name), renamed);
      await page.waitForFunction(([index, name]) => {
        const hooks = (window as unknown as { machineControlsFixture: { observerRoster(index: number): Array<{ id: string; name: string }> | null } }).machineControlsFixture;
        return hooks.observerRoster(index as number)?.find((machine) => machine.id === "sidebar-fixture")?.name === name;
      }, [observer, renamed] as const);
      await renamedGroup.getByRole("button", { name: "Connect", exact: true }).click();
      await renamedGroup.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
      await page.waitForFunction((index) => {
        const hooks = (window as unknown as { machineControlsFixture: { observerRoster(index: number): Array<{ id: string; enabled: boolean }> | null } }).machineControlsFixture;
        return hooks.observerRoster(index)?.find((machine) => machine.id === "sidebar-fixture")?.enabled === true;
      }, observer);


      await renamedGroup.getByRole("button", { name: REMOVE_LABEL.en, exact: true }).click();
      const destructive = renamedGroup.getByRole("button", { name: CONFIRM_LABEL.en, exact: true });
      await destructive.waitFor();
      await page.evaluate(() => (window as unknown as { machineControlsFixture: { holdNextMutation(): void } }).machineControlsFixture.holdNextMutation());
      await destructive.click();
      await page.waitForFunction(() => (window as unknown as { machineControlsFixture: { calls: { deleteAttempts: number } } }).machineControlsFixture.calls.deleteAttempts === 1);
      assert.equal(await destructive.isDisabled(), true, "the pending DELETE disables confirmation while in flight");
      await destructive.evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      assert.equal(await getHook(page, "calls.deleteAttempts"), 1, "duplicate clicks while busy issue no additional DELETE");
      await page.evaluate(() => (window as unknown as { machineControlsFixture: { releaseMutation(success: boolean): void } }).machineControlsFixture.releaseMutation(false));
      await renamedGroup.getByRole("alert").waitFor();
      assert.match(await renamedGroup.getByRole("alert").textContent() ?? "", /Fixture mutation rejected/);
      assert.equal(await renamedGroup.count(), 1, "failed removal retains the remote PC registration");
      assert.equal(await getHook(page, "calls.deleteCount"), 0, "failed DELETE does not increment the successful deletion count");
      assert.equal(await destructive.isDisabled(), false, "failed removal clears busy state");
      await page.waitForFunction((index) => {
        const hooks = (window as unknown as { machineControlsFixture: { observerRoster(index: number): Array<{ id: string }> | null } }).machineControlsFixture;
        return hooks.observerRoster(index)?.some((machine) => machine.id === "sidebar-fixture");
      }, observer);

      await destructive.click();
      await renamedGroup.waitFor({ state: "detached" });
      assert.equal(await getHook(page, "calls.deleteAttempts"), 2, "one retry sends exactly one additional DELETE");
      assert.equal(await getHook(page, "calls.deleteCount"), 1, "only the successful DELETE counts");
      await page.waitForFunction((index) => {
        const hooks = (window as unknown as { machineControlsFixture: { observerRoster(index: number): Array<{ id: string }> | null } }).machineControlsFixture;
        return hooks.observerRoster(index)?.every((machine) => machine.id !== "sidebar-fixture");
      }, observer);
      assert.equal(await page.evaluate(() => {
        const hooks = (window as unknown as { machineControlsFixture: { calls: { mutations: Array<{ id: string; method: string }> } } }).machineControlsFixture;
        return hooks.calls.mutations.filter((call) => call.id === "sidebar-fixture" && call.method === "DELETE").length;
      }), 2, "first confirmation is inert; failed and successful second confirmations each issue one DELETE");
      console.log("PASS keyboard arm, Manage disclosure reset, coherent rename/toggle events, busy suppression, failure recovery and one successful removal");
    }

    console.log(`PASS ${scenario.name} panel/form/buttons/input/labels fit the sidebar`);
    assert.deepEqual(errors, [], `${scenario.name} has no uncaught browser errors`);
  } finally {
    await context.close();
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  await prepareMachineControlsDemo(app);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const url = `http://127.0.0.1:${server.port}/`;
  for (const scenario of geometryOnly ? [scenarios[0]!] : scenarios) await withScenario(browser, url, scenario, scenario.name === "en-desktop-240-dark");
  console.log(`PASS sidebar machine layout regression${geometryOnly ? " (geometry-only)" : ""}`);
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
