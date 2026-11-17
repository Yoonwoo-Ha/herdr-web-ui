import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneScrollInfo, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

const state = realpathSync(mkdtempSync(join(tmpdir(), "herdr-application-paging-")));
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await Bun.sleep(25);
  }
}
try {
  const log = join(state, "keys.bin");
  writeFileSync(join(state, "fixture.py"), `import os, sys, tty
tty.setraw(sys.stdin.fileno())
sys.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[Hpaging_fixture_ready")
sys.stdout.flush()
with open("keys.bin", "wb", buffering=0) as log:
    while True:
        data = os.read(sys.stdin.fileno(), 1024)
        if not data: break
        log.write(data)
        if data == b"q": break
sys.stdout.write("\\x1b[?1049l")
sys.stdout.flush()
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-application-paging" });
  workspace = made.workspace.workspace_id;
  const paneId = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", { pane_id: paneId, source: "visible", match: { type: "substring", value: "paging_fixture_ready" }, timeout_ms: 10000 }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: paneId, text: "seq 1 300; python3 fixture.py", keys: ["enter"] });
  await ready;
  assert.equal((await paneScrollInfo(paneId))?.max_offset_from_bottom, 0, "the application owns its history");
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "state"), usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1024, height: 600 }, locale: "en-US" });
  await context.addInitScript(() => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const inputs: string[] = [];
  let outputs = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try { const message = JSON.parse(String(payload)) as { type?: string; text?: string }; if (message.type === "input" && typeof message.text === "string") inputs.push(message.text); } catch {}
    });
    socket.on("framereceived", ({ payload }) => {
      try { if ((JSON.parse(String(payload)) as { type?: string }).type === "pty-data") outputs++; } catch {}
    });
  });
  const nativeMetrics = page.waitForResponse((response) => response.url().includes("/api/pane/scroll") && response.request().method() === "GET");
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
  const metrics = await (await nativeMetrics).json();
  assert.equal(metrics.scroll.max_offset_from_bottom, 0, "the browser has an explicit zero-history result before forwarding");
  await page.locator(".conn-live").waitFor();
  await page.locator(".xterm-helper-textarea").first().waitFor();
  await page.getByText("Waiting for terminal input…", { exact: true }).waitFor({ state: "hidden" });
  await page.locator(".xterm-helper-textarea").first().evaluate((node: HTMLTextAreaElement) => node.focus());
  const read = () => readFileSync(log, "utf8");
  await page.keyboard.press("ControlOrMeta+Shift+PageUp");
  await until(async () => read() === "\x1b[5~", "the app's upward paging chord reaches the application as plain PageUp");
  await page.keyboard.press("ControlOrMeta+Shift+PageDown");
  await until(async () => read() === "\x1b[5~\x1b[6~", "the downward paging chord reaches the application as plain PageDown");
  await page.keyboard.press("PageUp");
  await until(async () => read() === "\x1b[5~\x1b[6~\x1b[5~", "plain PageUp remains application input in the terminal lens");
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Chat");
  const before = read();
  await page.keyboard.press("ControlOrMeta+Shift+PageDown");
  assert.equal(read(), before, "a modal prevents application paging");
  assert.equal((await paneScrollInfo(paneId))?.max_offset_from_bottom, 0);
  await page.keyboard.press("Escape");
  await page.locator(".xterm-helper-textarea").first().evaluate((node: HTMLTextAreaElement) => node.focus());
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Shortcuts");
  await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("u");
  await page.getByRole("combobox", { name: "Scroll pane down", exact: true }).selectOption("d");
  await page.keyboard.press("Escape");
  await page.locator(".xterm-helper-textarea").first().evaluate((node: HTMLTextAreaElement) => node.focus());
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await until(async () => read() === "\x1b[5~\x1b[6~\x1b[5~\x1b[5~\x1b[6~", "remapped paging actions still send plain page sequences to the application");
  // The program quits and hands the screen back to the shell, whose history the browser does not know
  // about until its next metrics read. A page asked for in that window must scroll that history once
  // the read lands, never reach the shell as a key. The read is slowed to widen the window.
  await page.route((url) => url.pathname === "/api/pane/scroll", async (route) => {
    if (route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  const sentBefore = inputs.length;
  const seenBefore = outputs;
  await page.keyboard.press("q");
  await until(async () => read().endsWith("q"), "the program read its quit key");
  await until(async () => ((await paneScrollInfo(paneId))?.max_offset_from_bottom ?? 0) > 0, "the shell's history is back once the program left its screen");
  await until(async () => outputs > seenBefore, "the page received the program's exit and the shell's prompt");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await Bun.sleep(300);
  assert.deepEqual(inputs.slice(sentBefore).filter((text) => text.includes("\x1b[5~")), [], `stale zero-history metrics do not turn the page into a key for the shell (sent: ${JSON.stringify(inputs.slice(sentBefore))})`);
  await until(async () => ((await paneScrollInfo(paneId))?.offset_from_bottom ?? 0) > 0, "the page scrolls the shell's history once the metrics are read again");
  assert.deepEqual(inputs.slice(sentBefore).filter((text) => text.includes("\x1b[5~")), [], "no page key reached the shell afterwards either");
  assert.deepEqual(errors, []);
  console.log("PASS application paging: translated up/down, plain terminal PageUp preserved, modal guard, no native history, no key for the shell after the program quits");
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
