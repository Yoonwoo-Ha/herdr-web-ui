/** Real-browser regressions against owned herdr panes. Run after `bun run build`. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import type { WorkspaceCreated } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-browser-"));
const workspaces: string[] = [];
const releases: Array<() => void> = [];
const errors: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(50);
  }
}

try {
  const panes: string[] = [];
  for (const suffix of ["a", "b"]) {
    const cwd = join(root, suffix);
    mkdirSync(cwd);
    const result = await workspaceCreate({ cwd, label: `herdr-web-ui-test-browser-${suffix}` });
    workspaces.push(result.workspace.workspace_id);
    panes.push(result.root_pane.pane_id);
  }
  const [paneA, paneB] = panes as [string, string];
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push") });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome",
    headless: true, args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((ids) => {
    for (const id of ids) localStorage.setItem(`herdr-web-ui:view:${id}`, "chat");
  }, panes);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  const painted = new Set<string>();
  const inputs: Array<{ pane_id: string; text: string }> = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "pty-data") painted.add(message.pane_id);
    });
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input") inputs.push(message);
    });
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
  await page.locator(".conn-live").waitFor();
  await until(() => painted.has(paneA), "owned pane paint");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor();

  await page.keyboard.press("Control+Shift+Comma");
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS settings shortcut and theme");

  const report = (state: string) => herdrRpc("pane.report_agent", {
    pane_id: paneA, source: "manual", agent: "claude", state,
  });
  await report("working");
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await composer.fill("printf 'browser-queue-ok\\n'");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  const inputCount = inputs.length;
  await report("blocked");
  await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await Bun.sleep(300);
  assert.equal(inputs.length, inputCount, "approval state must hold the queue");
  assert.equal(await page.locator(".composer-queue-text").count(), 1);
  await report("idle");
  await Bun.sleep(300);
  assert.equal(inputs.length, inputCount, "a status change must not dispatch held input");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await until(() => inputs.length > inputCount, "explicit queue send");
  assert.equal(inputs.at(-1)?.pane_id, paneA);
  await page.locator(".composer-queue-text").waitFor({ state: "hidden" });
  console.log("PASS queue held through status changes and explicitly sent to its owner");

  const selectPane = async (paneId: string) => {
    await page.locator(`.pane-select[title^="${paneId} —"]`).click();
    await page.getByRole("log", { name: `conversation of ${paneId}`, exact: true }).waitFor();
  };
  await composer.fill("draft for A");
  await selectPane(paneB);
  assert.equal(await composer.inputValue(), "");
  await composer.fill("draft for B");
  await selectPane(paneA);
  assert.equal(await composer.inputValue(), "draft for A");
  console.log("PASS drafts stay with their panes");

  let releaseImage!: () => void;
  const imageGate = new Promise<void>((resolve) => { releaseImage = resolve; });
  releases.push(releaseImage);
  const uploads: string[] = [];
  await page.route("**/api/pane/image", async (route) => {
    uploads.push(route.request().postDataJSON().pane_id);
    await imageGate;
    await route.continue(); // Delay real traffic; no synthetic responses.
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: png },
    { name: "second.png", mimeType: "image/png", buffer: png },
  ]);
  await until(() => uploads.length === 1, "first upload started");
  await selectPane(paneB);
  const imageResponse = page.waitForResponse((response) => response.url().endsWith("/api/pane/image"));
  releaseImage();
  assert.equal((await imageResponse).status(), 200);
  await Bun.sleep(300);
  assert.deepEqual(uploads, [paneA], "leaving a pane cancels remaining uploads");
  assert.equal(await composer.inputValue(), "draft for B");
  console.log("PASS upload batch cannot cross panes");

  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  releases.push(releaseCreate);
  let createRequests = 0;
  await page.route("**/api/workspace/create", async (route) => {
    createRequests += 1;
    await createGate;
    await route.continue();
  });
  await page.getByRole("button", { name: /^New session/ }).click();
  const dialog = page.getByRole("dialog", { name: /^New session/ });
  await dialog.getByLabel(/^Directory/).fill(root);
  await dialog.getByLabel(/^Name/).fill("herdr-web-ui-test-browser-created");
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  await until(() => createRequests === 1, "creation started");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "in-flight creation cannot be dismissed");
  assert.equal(await dialog.getByRole("button", { name: "Close new session dialog" }).isDisabled(), true);
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/workspace/create"));
  releaseCreate();
  const created = await (await createdResponse).json() as WorkspaceCreated;
  workspaces.push(created.workspace_id);
  await dialog.waitFor({ state: "hidden" });
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "created pane selected");
  assert.equal(createRequests, 1);
  console.log("PASS session creation stays pending and opens one owned workspace");

  // herdr 0.9.0 reports Codex's first directory-trust menu as idle. Exercise a
  // live, owned PTY menu so the chat controls cannot depend on a blocked badge.
  await selectPane(paneB);
  await herdrRpc("pane.send_text", {
    pane_id: paneB,
    text: "printf '\\033[2J\\033[HDo you trust the contents of this directory?\\n\\n› 1. Yes, continue\\n  2. No, quit\\n\\n  Press enter to continue\\n'; read -r qa_answer",
  });
  await herdrRpc("pane.send_keys", { pane_id: paneB, keys: ["Enter"] });
  await until(async () => {
    const result = await herdrRpc<{ read: { text: string } }>("pane.read", {
      pane_id: paneB, source: "visible", format: "text",
    });
    return result.read.text.includes("Press enter to continue");
  }, "startup menu painted");
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });
  await page.locator('.composer-status[data-status="idle"]').waitFor();
  const startupPrompt = page.locator(".prompt-card");
  await startupPrompt.getByRole("button", { name: "Yes, continue", exact: true }).waitFor();
  assert.equal(await page.locator('.composer-status[data-status="idle"]').count(), 1);
  assert.equal(await page.locator(".chat-empty").count(), 0);
  await startupPrompt.getByRole("button", { name: "Yes, continue", exact: true }).click();
  await startupPrompt.waitFor({ state: "hidden" });
  console.log("PASS startup prompt appears and accepts an answer while the agent status is idle");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on("pageerror", (error) => errors.push(error.message));
  await mobilePage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await mobilePage.locator(".conn-live").waitFor();
  await mobilePage.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).fill("mobile draft");
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS mobile composer with unavailable storage and no horizontal overflow");
} finally {
  for (const release of releases) release();
  await browser?.close();
  server?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
