/** Real-browser regressions against owned herdr panes. Run after `bun run build`. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import type { WorkspaceCreated } from "../shared/protocol.ts";
import { checkPushSettings } from "./push-settings-regression.ts";
import { checkWakeLock } from "./wake-lock-regression.ts";
import { checkNeedsInput } from "./needs-input-regression.ts";
import { checkSecretInput } from "./secret-input-regression.ts";
import { checkTerminalCopy } from "./terminal-copy-regression.ts";
import { checkUsageMeters } from "./usage-regression.ts";
import { checkNotificationStartup } from "./notification-startup-regression.ts";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { UsageService } from "../server/usage.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-browser-"));
const workspaces: string[] = [];
const releases: Array<() => void> = [];
const errors: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
/** WebKit's IME commit: an Enter keydown after compositionend, isComposing false, key code 229 */
const IME_ENTER = { key: "Enter", code: "Enter", keyCode: 229, which: 229, bubbles: true, cancelable: true };
/** how long a send that should not happen gets to show up */
const NO_SEND_WAIT_MS = 400;

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
  // no provider is asked with the test machine's own sign-ins
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), usage: new UsageService(undefined, []) });
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
  let holdSubmitResult = false;
  let releaseSubmitResult: (() => void) | null = null;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    upstream.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (holdSubmitResult && message.type === "submit-result") {
        holdSubmitResult = false;
        const release = () => { socket.send(raw); releaseSubmitResult = null; };
        releaseSubmitResult = release;
        releases.push(release);
      } else socket.send(raw);
    });
  });
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
      // composer messages go out as "submit" on servers that list it (#15), keystrokes as "input"
      if (message.type === "input" || message.type === "submit") inputs.push(message);
    });
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
  await page.locator(".conn-live").waitFor();
  await until(() => painted.has(paneA), "owned pane paint");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor();

  // Hold a real machines response, then deliver a newer status through herdr/SSE.
  const badge = page.locator(".pane-item.is-selected .badge");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "blocked" });
  await until(async () => await badge.getAttribute("data-status") === "blocked", "blocked baseline");
  let releasePoll!: () => void;
  const heldPoll = new Promise<void>((resolve) => { releasePoll = resolve; });
  releases.push(releasePoll);
  let pollCaptured = false;
  let pollFinished = false;
  await page.route("**/api/machines", async (route) => {
    const response = await route.fetch();
    if (!pollCaptured) {
      pollCaptured = true;
      await heldPoll;
      await route.fulfill({ response });
      pollFinished = true;
    } else await route.fulfill({ response });
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await until(() => pollCaptured, "held machines snapshot");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "working" });
  await until(async () => await badge.getAttribute("data-status") === "working", "working event before poll");
  releasePoll();
  await until(() => pollFinished, "stale machines response released");
  await page.waitForTimeout(300);
  assert.equal(await badge.getAttribute("data-status"), "working", "stale poll must not revert RUN to INPUT");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "pane-status-poll.png") });
  }
  await page.unroute("**/api/machines");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "idle" });
  console.log("PASS delayed machines poll preserves newer streamed pane status");

  // Use a real browser paste: keydown must not send Ctrl+V (0x16) to the agent,
  // where it can trigger image paste against the server's unrelated clipboard.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  const terminalInput = page.locator(".xterm-helper-textarea");
  for (const [shortcut, text] of [
    ["Control+v", "# terminal paste 한글"],
    ["Control+v", "# first line\n# second line"],
    ["Control+Shift+v", "# plain text paste"],
  ]) {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text!);
    await terminalInput.focus();
    const beforePaste = inputs.length;
    await page.keyboard.press(shortcut!);
    await until(() => inputs.length > beforePaste, `terminal ${shortcut}`);
    const pasted = inputs.slice(beforePaste);
    assert.equal(pasted.length, 1, "paste must send the text exactly once");
    assert.equal(pasted[0]!.pane_id, paneA);
    assert.equal(
      pasted[0]!.text.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, ""),
      text!.replace(/\n/g, "\r"),
      "paste must send clipboard text, never the image-paste control key",
    );
    const beforeCancel = inputs.length;
    await page.keyboard.press("Control+c");
    await until(() => inputs.length > beforeCancel, "terminal Ctrl+C");
    assert.equal(inputs.at(-1)?.text, "\x03", "other terminal control keys must still work");
  }
  await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await composer.waitFor();
  console.log("PASS terminal clipboard paste sends text once and preserves Ctrl+C");

  await page.keyboard.press("Control+Shift+Comma");
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS settings shortcut and theme");

  // the bell turns this device's alerts on, and off again (it stayed disabled once on)
  await context.grantPermissions(["notifications"], { origin });
  const bell = page.locator(".bell-button");
  await bell.click();
  await until(async () => await bell.getAttribute("aria-pressed") === "true", "bell on");
  await bell.click();
  await until(async () => await bell.getAttribute("aria-pressed") === "false", "bell off");
  assert.equal(await bell.getAttribute("aria-label"), "Alerts off");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").alertsOn), false);
  assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null), null, "turning alerts off drops the push subscription");
  await bell.click();
  await until(async () => await bell.getAttribute("aria-pressed") === "true", "bell on again");
  console.log("PASS the bell turns alerts off and on again");

  await checkPushSettings(browser, origin);
  await checkWakeLock(browser, origin, paneA);
  await checkNeedsInput(browser, origin, paneA);
  await checkSecretInput(browser, origin);
  await checkTerminalCopy(browser, origin);
  await checkUsageMeters(browser, origin);
  await checkNotificationStartup(browser, origin, paneA, paneB);
  await checkMobileViewport(browser, origin, paneB);

  const report = (state: string) => herdrRpc("pane.report_agent", {
    pane_id: paneA, source: "manual", agent: "claude", state,
  });
  await report("working");
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await page.locator(".chat-terminal-fallback").waitFor();
  assert.equal(await page.locator(".chat-terminal-fallback").getAttribute("open"), null, "Claude without a native transcript gets an explicit fallback, not pseudo-chat");
  await composer.fill("printf 'browser-queue-ok\\n'");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  for (const text of ["# second queued message", "# third queued message"]) {
    await composer.fill(text);
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
  }
  assert.equal(await page.locator(".composer-queue-text").count(), 3);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "multiple-queue.png") });
  await page.locator(".composer-queue-text").nth(1).fill("# edited second message");
  await page.reload();
  await page.locator(".conn-live").waitFor();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "queue restored");
  assert.equal(await page.locator(".composer-queue-text").nth(1).inputValue(), "# edited second message");
  await page.locator(`.pane-select[title^="${paneB} —"]`).click();
  await until(async () => await page.locator(".composer-queue-text").count() === 0, "other pane has no queue");
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "owner queue restored");
  await page.getByRole("button", { name: "Discard", exact: true }).nth(2).click();
  const inputCount = inputs.length;
  await report("blocked");
  await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await Bun.sleep(300);
  assert.equal(inputs.length, inputCount, "approval state must hold the queue");
  assert.equal(await page.locator(".composer-queue-text").count(), 2);
  await report("idle");
  await Bun.sleep(300);
  assert.equal(inputs.length, inputCount, "a status change must not dispatch held input");
  await page.getByRole("button", { name: "Send now", exact: true }).first().click();
  await until(() => inputs.length > inputCount, "explicit queue send");
  assert.equal(inputs.at(-1)?.pane_id, paneA);
  await until(async () => await page.locator(".composer-queue-text").count() === 1, "only sent item removed");
  assert.equal(await page.locator(".composer-queue-text").inputValue(), "# edited second message");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.locator(".composer-queue-text").waitFor({ state: "hidden" });
  console.log("PASS queue held through status changes and explicitly sent to its owner");

  // a quick reply goes out as typed, and leaves a draft in the box alone; the row shows only when
  // chosen in Settings, and the box has no button for it
  const quickRow = async (show: boolean): Promise<void> => {
    await page.keyboard.press("Control+Shift+Comma");
    const toggle = page.getByRole("switch", { name: "Show above the message box", exact: true });
    if ((await toggle.getAttribute("aria-checked")) !== String(show)) await toggle.click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  assert.equal(await page.locator(".composer-quick").count(), 0);
  assert.equal(await page.locator(".composer-quick-toggle").count(), 0);
  await quickRow(true);
  await composer.fill("draft stays");
  const quickCount = inputs.length;
  await page.getByRole("group", { name: "Quick replies", exact: true }).getByRole("button", { name: "continue", exact: true }).click();
  await until(() => inputs.length > quickCount, "quick reply send");
  assert.equal(inputs.at(-1)?.pane_id, paneA);
  assert.match(inputs.at(-1)!.text, /^continue/);
  assert.equal(await composer.inputValue(), "draft stays");
  // mid-turn it is held like a typed message
  await report("working");
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await page.getByRole("group", { name: "Quick replies", exact: true }).getByRole("button", { name: "retry", exact: true }).click();
  assert.equal(await page.locator(".composer-queue-text").inputValue(), "retry");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await quickRow(false);
  assert.equal(await page.locator(".composer-quick").count(), 0);
  await composer.fill("");
  await report("idle");
  // idle after work reads DONE (server/completion.ts)
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  console.log("PASS quick replies send as typed, queue mid-turn, and leave the draft");

  // the Enter that commits an IME candidate is not a send: WebKit can deliver it after
  // compositionend, with isComposing false and key code 229
  await composer.fill("한글 조합");
  const imeInputs = inputs.length;
  await composer.dispatchEvent("keydown", IME_ENTER);
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(inputs.length, imeInputs);
  assert.equal(await composer.inputValue(), "한글 조합");
  await composer.fill("");
  console.log("PASS the composer keeps an IME's committing Enter");

  // a problem report gathers the pane's pieces, sends nothing on its own, and files a prefilled issue
  await page.getByRole("button", { name: "Report a problem", exact: true }).click();
  const reportDialog = page.getByRole("dialog", { name: "Report a problem" });
  const reportText = reportDialog.getByRole("textbox", { name: "Report", exact: true });
  await until(async () => (await reportText.inputValue()).includes("## Environment"), "report gathered");
  await reportDialog.getByRole("textbox", { name: "What went wrong?" }).fill("list numbers read 1. 1. 1.");
  await reportDialog.getByLabel("Terminal screen").check();
  await until(async () => (await reportText.inputValue()).includes("## Terminal screen"), "screen included");
  assert.match(await reportText.inputValue(), /## What went wrong\n\nlist numbers read 1\. 1\. 1\./);
  const redacted = "한글 보고서 😀\n".repeat(1000);
  await reportText.fill(redacted);
  await reportDialog.getByLabel("Terminal screen").uncheck();
  await report("working");
  await Bun.sleep(300);
  assert.equal(await reportText.inputValue(), redacted, "manual redactions survive live updates and option changes");
  assert.ok((await reportDialog.getByRole("link", { name: "Open a GitHub issue" }).getAttribute("href"))!.length <= 2000);
  const download = page.waitForEvent("download");
  await reportDialog.getByRole("button", { name: "Save as file", exact: true }).click();
  const savedReport = await download;
  assert.match(savedReport.suggestedFilename(), /^herdr-report-.+\.md$/);
  assert.equal(await Bun.file((await savedReport.path())!).text(), redacted, "saved report is complete");
  // the issue page itself is GitHub's: the address asked for is what is checked, and never loaded
  let issueRequested = "";
  await page.context().route(/^https:\/\/github\.com\//, async (route) => {
    issueRequested ||= route.request().url();
    await route.fulfill({ status: 200, contentType: "text/plain", body: "stub" });
  });
  const popup = page.waitForEvent("popup");
  await reportDialog.getByRole("link", { name: "Open a GitHub issue", exact: true }).click();
  const issue = await popup;
  await until(() => issueRequested !== "", "issue address requested");
  const issueAddress = new URL(issueRequested);
  assert.equal(`${issueAddress.origin}${issueAddress.pathname}`, "https://github.com/devswha/herdr-web-ui/issues/new");
  assert.equal(issueAddress.searchParams.get("title"), "[claude] list numbers read 1. 1. 1.");
  assert.ok(issueRequested.length <= 2000);
  assert.match(issueAddress.searchParams.get("body")!, /Please paste the full report/);
  await issue.close();
  await reportDialog.getByRole("button", { name: "Rebuild report" }).click();
  assert.match(await reportText.inputValue(), /## Environment/);
  await report("idle");
  await reportDialog.getByRole("button", { name: "Close", exact: true }).click();
  await reportDialog.waitFor({ state: "hidden" });
  console.log("PASS a problem report gathers the pane, saves a file, and opens a prefilled issue");

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

  // A real successful send waits on its acknowledgement while its composer unmounts.
  for (const returnBeforeAck of [false, true]) {
    await composer.fill("# confirmed draft");
    holdSubmitResult = true;
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(() => releaseSubmitResult !== null, "held submit acknowledgement");
    await selectPane(paneB);
    assert.equal(await composer.inputValue(), "draft for B");
    if (returnBeforeAck) {
      await selectPane(paneA);
      assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
      await composer.fill("# confirmed draft plus unsent text");
    }
    releaseSubmitResult!();
    if (!returnBeforeAck) await selectPane(paneA);
    await until(async () => await composer.inputValue() === (returnBeforeAck ? " plus unsent text" : ""), "only acknowledged text leaves the draft");
  }
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "composer-acknowledged-draft.png") });
  await composer.fill("draft for A");
  console.log("PASS successful sends settle after switching panes and preserve edits made after returning");

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
  await page.getByRole("button", { name: "New session", exact: true }).click();
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
  const paintStartupMenu = async (): Promise<void> => {
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
  };
  await paintStartupMenu();
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });
  await page.locator('.composer-status[data-status="idle"]').waitFor();
  const startupPrompt = page.locator(".prompt-card");
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).waitFor();
  assert.equal(await page.locator('.composer-status[data-status="idle"]').count(), 1);
  assert.equal(await page.locator(".chat-empty").count(), 0);
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).click();
  await startupPrompt.waitFor({ state: "hidden" });
  console.log("PASS startup prompt appears and accepts an answer while the agent status is idle");

  // A pick typed in the composer waits in the card for Confirm. Answered in the terminal
  // instead, it must not come back when the same menu (the same prompt id) is asked again.
  await paintStartupMenu();
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).waitFor();
  await composer.fill("1");
  await composer.press("Enter");
  await startupPrompt.locator(".prompt-card-confirm").waitFor();
  await herdrRpc("pane.send_keys", { pane_id: paneB, keys: ["Enter"] });
  await startupPrompt.waitFor({ state: "hidden" });
  await paintStartupMenu();
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await startupPrompt.locator(".prompt-card-confirm").count(), 0);
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).click();
  await startupPrompt.waitFor({ state: "hidden" });
  console.log("PASS a typed pick answered in the terminal does not wait on the same menu asked again");

  // A dialog no parser reads still gets a card: its rows, its options and the keys it names.
  // A tap, or the option's number typed in the composer, is that key press; the X hides it.
  const paintUnknownDialog = async (): Promise<void> => {
    await herdrRpc("pane.send_text", {
      pane_id: paneB,
      text: "printf '\\033[2J\\033[HPick a deployment target\\n\\n❯ 1. Staging\\n  2. Production\\n\\nEnter to select · Esc to cancel\\n'; bash -c 'read -r -n 1 qa_pick; echo; echo \"picked:$qa_pick\"'",
    });
    await herdrRpc("pane.send_keys", { pane_id: paneB, keys: ["Enter"] });
    await until(async () => {
      const result = await herdrRpc<{ read: { text: string } }>("pane.read", { pane_id: paneB, source: "visible", format: "text" });
      return result.read.text.includes("Enter to select · Esc to cancel") && !result.read.text.includes("picked:");
    }, "unknown dialog painted");
  };
  const screenOfB = async (): Promise<string> => (await herdrRpc<{ read: { text: string } }>("pane.read", { pane_id: paneB, source: "visible", format: "text" })).read.text;
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "blocked" });
  await paintUnknownDialog();
  const unreadableCard = page.locator(".prompt-card.is-unreadable");
  await unreadableCard.waitFor();
  assert.match(await unreadableCard.locator(".prompt-card-body").innerText(), /Pick a deployment target[\s\S]*2\. Production/);
  assert.deepEqual(await unreadableCard.locator(".prompt-card-key").allInnerTexts(), ["Enter", "Esc"]);
  assert.equal(await unreadableCard.getByRole("button", { name: "Hide" }).count(), 1);
  assert.equal(await composer.getAttribute("placeholder"), "Tap an option above, or type its number…");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "unreadable-card.png") });
  await unreadableCard.getByRole("button", { name: "1. Staging" }).click();
  await until(async () => (await screenOfB()).includes("picked:1"), "a tap presses the option's number");
  // answered, an agent is no longer blocked: the menu's rows left on screen are no card
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "working" });
  await unreadableCard.waitFor({ state: "hidden" });
  // the option's number typed in the composer is the same press, not a message
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "blocked" });
  await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await paintUnknownDialog();
  await unreadableCard.waitFor();
  await composer.fill("2");
  await composer.press("Enter");
  await until(async () => (await screenOfB()).includes("picked:2"), "a typed number presses the option");
  await until(async () => await composer.inputValue() === "", "the typed number leaves the box");
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "working" });
  await unreadableCard.waitFor({ state: "hidden" });
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "blocked" });
  // Escape in the empty composer is the dialog's own Esc
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "blocked" });
  await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await paintUnknownDialog();
  await unreadableCard.waitFor();
  await composer.focus();
  await page.keyboard.press("Escape");
  await until(async () => (await screenOfB()).includes("picked:"), "Escape presses the dialog's Esc");
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "working" });
  await unreadableCard.waitFor({ state: "hidden" });
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "blocked" });
  // hidden with its X, the same dialog stays hidden; the composer is a message box again
  await paintUnknownDialog();
  await unreadableCard.waitFor();
  await unreadableCard.getByRole("button", { name: "Hide" }).click();
  await unreadableCard.waitFor({ state: "hidden" });
  await page.waitForTimeout(2500);
  assert.equal(await unreadableCard.count(), 0, "a hidden dialog stays hidden");
  assert.notEqual(await composer.getAttribute("placeholder"), "Tap an option above, or type its number…");
  await herdrRpc("pane.send_keys", { pane_id: paneB, keys: ["1"] });
  await until(async () => (await screenOfB()).includes("picked:1"), "dialog closed");
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "idle" });
  console.log("PASS a dialog no parser reads shows its rows and keys; a tap or its number presses, and the X hides it");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on("pageerror", (error) => errors.push(error.message));
  await mobilePage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await mobilePage.locator(".conn-live").waitFor();
  const tapHighlight = await mobilePage.locator(".view-switch button").first().evaluate((node) => getComputedStyle(node).webkitTapHighlightColor);
  assert.equal(tapHighlight, "rgba(0, 0, 0, 0)", "native tap overlays do not obscure selection");
  await mobilePage.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).fill("mobile draft");
  await mobilePage.locator(".chat-terminal-fallback").waitFor();
  assert.equal(await mobilePage.locator(".chat-terminal-fallback").getAttribute("open"), null, "missing native history is labeled, not presented as broken chat");
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const mobileReportButton = mobilePage.getByRole("button", { name: "Report a problem", exact: true });
  assert.equal(await mobileReportButton.innerText(), "Report a problem");
  const reportButtonBox = await mobileReportButton.boundingBox();
  assert.ok(reportButtonBox && reportButtonBox.height >= 44 && reportButtonBox.width >= 44, "report action has a touch-sized target");
  if (process.env.UI_EVIDENCE_DIR) await mobilePage.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "report-mobile-button.png") });
  await mobileReportButton.click();
  const mobileReport = mobilePage.getByRole("dialog", { name: "Report a problem" });
  await mobileReport.getByRole("link", { name: "Open a GitHub issue" }).waitFor();
  await mobileReport.getByRole("textbox", { name: "Report", exact: true }).fill("한글 보고서 😀".repeat(1000));
  for (const theme of ["light", "dark"]) {
    await mobilePage.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const action = await mobileReport.getByRole("link", { name: "Open a GitHub issue" }).boundingBox();
    assert.ok(action && action.y >= 0 && action.y + action.height <= 844, "mobile issue action fits viewport");
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.UI_EVIDENCE_DIR) await mobilePage.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `report-mobile-${theme}.png`) });
  }
  await mobileReport.getByRole("button", { name: "Close", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log("PASS mobile composer with unavailable storage and no horizontal overflow");

  // the terminal lens on a touch screen: an input line sends whole lines; the grid raises no keyboard
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const touchPage = await touch.newPage();
  touchPage.on("pageerror", (error) => errors.push(error.message));
  const touchSent: Array<Record<string, unknown>> = [];
  touchPage.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const message = JSON.parse(String(payload)) as Record<string, unknown>;
    if (message.type === "input" || message.type === "submit") touchSent.push(message);
  }));
  await touchPage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await touchPage.locator(".conn-live").waitFor();
  await touchPage.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  const line = touchPage.getByRole("textbox", { name: "Terminal input line", exact: true });
  await line.waitFor();
  assert.equal(await touchPage.locator(".xterm-helper-textarea").getAttribute("inputmode"), "none");
  await line.fill("printf 'line-ok\\n'");
  await line.press("Enter");
  await until(() => touchSent.some((message) => message.type === "submit" && message.typed === true), "input line submit");
  const submitted = touchSent.find((message) => message.type === "submit")!;
  assert.equal(submitted.pane_id, paneB);
  assert.equal(submitted.text, "printf 'line-ok\\n'");
  // the line clears once the pane confirmed it
  await until(async () => (await line.inputValue()) === "", "input line cleared after send");
  // an IME's committing Enter (key code 229) stays in the line
  await line.fill("echo 한글");
  const imeSent = touchSent.length;
  await line.dispatchEvent("keydown", IME_ENTER);
  await touchPage.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(touchSent.length, imeSent);
  assert.equal(await line.inputValue(), "echo 한글");
  await line.fill("");
  // an empty line's button is Enter alone
  const enters = touchSent.length;
  await touchPage.getByRole("button", { name: "Press Enter in the terminal", exact: true }).click();
  await until(() => touchSent.length > enters && touchSent.at(-1)?.type === "input" && touchSent.at(-1)?.text === "\r", "enter from the empty line");
  // typing straight into the grid is one tap away, and gives the keyboard back to it
  await touchPage.getByRole("button", { name: "Type straight into the terminal", exact: true }).click();
  assert.equal(await touchPage.locator(".terminal-input").count(), 0);
  assert.equal(await touchPage.locator(".xterm-helper-textarea").getAttribute("inputmode"), null);
  await touchPage.getByRole("button", { name: "Type straight into the terminal", exact: true }).click();
  await line.waitFor();
  assert.equal(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await touch.close();
  console.log("PASS touch terminal input line sends whole lines, Enter alone, and yields to direct typing");

  // A closed pane and an obsolete saved pane both yield to a live pane. Local access
  // is automatic, so it must not offer a sign-out action that cannot lock the app.
  assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
  await page.locator(`.pane-select[title^="${created.pane_id} —"]`).click();
  // closed from the sidebar's X (arm, then confirm); its last pane takes the workspace with it
  await page.locator(".pane-item.is-selected .pane-close").click();
  await page.locator(".pane-item.is-selected .pane-close.is-armed").click();
  workspaces.splice(workspaces.indexOf(created.workspace_id), 1);
  await until(async () => {
    const selected = JSON.parse(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection") ?? "null"));
    return selected?.pane_id && selected.pane_id !== created.pane_id;
  }, "closed pane selection recovered");
  // the pane selected in its place must not take the keyboard: a phone would raise it over
  // the drawer, in the way of closing the next pane. Its lens follows a frame later.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.activeElement?.matches("textarea, input, [contenteditable]") ?? false), false,
    "a pane selected after a close must not focus its input");
  // picking that same pane takes the keyboard, although neither the pane nor its lens changes
  await page.locator(".pane-item.is-selected .pane-select").click();
  await until(async () => await page.evaluate(() => document.activeElement?.matches("textarea, input, [contenteditable]") ?? false),
    "picking the auto-selected pane focuses its input");
  await page.evaluate(() => sessionStorage.setItem("herdr-web-ui:selection", JSON.stringify({ machine_id: "local", pane_id: "obsolete-pane" })));
  await page.reload();
  await until(async () => {
    const selected = JSON.parse(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection") ?? "null"));
    return selected?.pane_id && selected.pane_id !== "obsolete-pane";
  }, "obsolete saved selection recovered");
  console.log("PASS closed and obsolete saved panes recover their selection");
  await page.close();

  const secured = createServer({ port: 0, hostname: "127.0.0.1", token: "browser-test-token", stateDir: join(root, "secured"), tailscaleOwner: null });
  releases.push(() => secured.stop());
  const securedOrigin = `http://127.0.0.1:${secured.port}`;
  const securedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Use a new pane so this bridge never competes with the first server's attachments.
  const securedWorkspace = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-browser-signout" });
  workspaces.push(securedWorkspace.workspace.workspace_id);
  const securedPage = await securedContext.newPage();
  await securedContext.request.post(`${securedOrigin}/api/auth`, { data: { token: "browser-test-token" } });
  await securedPage.goto(`${securedOrigin}/?pane=${encodeURIComponent(securedWorkspace.root_pane.pane_id)}`);
  await securedPage.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await securedPage.keyboard.press("Control+Shift+K");
  await securedPage.getByRole("option", { name: "Sign out", exact: true }).waitFor();
  // Simulate a late terminal focus change: Escape must still dismiss the modal.
  await securedPage.getByRole("button", { name: "Sign out", exact: true }).focus();
  await securedPage.keyboard.press("Escape");
  await securedPage.getByRole("dialog", { name: "Command palette", exact: true }).waitFor({ state: "hidden" });
  await securedPage.getByRole("button", { name: "Sign out", exact: true }).click();
  await securedPage.getByTestId("token-gate").waitFor();
  assert.equal((await securedContext.request.get(`${securedOrigin}/api/session`)).status(), 401);
  const pairing = await securedContext.request.post(`${securedOrigin}/api/devices/pair/start`, { headers: { authorization: "Bearer browser-test-token", "x-herdr-machine": "1" } });
  const { code } = await pairing.json();
  await securedContext.request.post(`${securedOrigin}/api/devices/pair`, { data: { code, label: "Browser test device" } });
  await securedPage.reload();
  await securedPage.getByRole("button", { name: "Sign out", exact: true }).click();
  await securedPage.getByTestId("token-gate").waitFor();
  assert.equal((await securedContext.request.get(`${securedOrigin}/api/session`)).status(), 401);
  await securedContext.close();
  console.log("PASS token and paired-device sign out return to the access gate");
} finally {
  for (const release of releases) release();
  await browser?.close();
  server?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
